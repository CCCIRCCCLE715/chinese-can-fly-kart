/**
 * ============================================================================
 *  Texture plumbing — canvases in, GPU-ready THREE textures out.
 * ============================================================================
 *  The house rules, applied here once so no generator can get them wrong:
 *    • albedo  → SRGBColorSpace          (it is colour)
 *    • normal  → NoColorSpace            (it is a vector)
 *    • ORM     → NoColorSpace            (it is three scalars)
 *    • mipmaps always, trilinear min filter, anisotropy on anything at a
 *      grazing angle (which, in a racing game, is the entire ground plane).
 *
 *  Occlusion / roughness / metalness are packed into ONE RGB texture and bound
 *  to all three slots — three reads .r for AO, .g for roughness and .b for
 *  metalness, so this is one upload instead of three.
 *
 *  MEMORY. Every texture in the process — including the ones built by systems
 *  that never import this file — passes through `setTextureBudget()`'s cap
 *  before its first upload. See the long note above it; that cap is what keeps
 *  a phone under the 80 MB of texture memory an iOS tab can survive.
 *
 *  Normals are derived by a wrapping Sobel over the generator's height field.
 *  Nothing here fakes a normal map out of albedo luminance.
 * ============================================================================
 */
import * as THREE from 'three';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';

export interface Canvas2D {
  canvas: AnyCanvas;
  ctx: CanvasRenderingContext2D;
  size: number;
}

function rawCanvas(w: number, h: number): AnyCanvas {
  if (HAS_OFFSCREEN) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function createCanvas(size: number): Canvas2D {
  const canvas = rawCanvas(size, size);
  // These canvases exist purely as a CPU staging buffer for putImageData /
  // getImageData; letting the browser back them with a GPU surface turns every
  // readback into a pipeline stall.
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
  return { canvas, ctx, size };
}

// ---------------------------------------------------------------------------
// The global texture budget
// ---------------------------------------------------------------------------
/*
 * WHY THIS EXISTS, and why it is a global rather than a parameter.
 *
 * Measured on an emulated iPhone at Quality.Medium: 220 MB of texture memory
 * across 138 textures, against a mobile budget of 80 MB. iOS Safari jetsams a
 * tab on *total* process footprint and GPU textures are charged against it, so
 * that number is the crash the player reported, not a tidiness complaint.
 *
 * Only a minority of those bytes are generated in this file. The rest are built
 * by a dozen systems that each `new THREE.CanvasTexture(...)` directly — kart
 * liveries, tyres, banners, awnings, sign panels, the crowd, the particle and
 * decal atlases. A per-generator size argument would have to be plumbed through
 * every one of them and would be silently forgotten by the next one written.
 *
 * So the cap is enforced once, at the only choke point every texture in the
 * process actually passes through: the `needsUpdate` setter that hands a
 * texture to the renderer for upload. Anything larger than the cap is
 * downsampled BEFORE its first upload, so the peak footprint never happens —
 * this is not a trim after the fact.
 *
 * Three properties make this safe rather than clever:
 *
 *  1. It runs at most once per texture source. Nothing in this game re-uploads
 *    a texture (every `Texture.needsUpdate = true` in the codebase is a
 *    build-time one-shot; the per-frame ones are BufferAttribute, a different
 *    class), and the claim flag on `Texture.source` guarantees it regardless.
 *  2. It defers to a microtask rather than acting inline. `CanvasTexture`'s
 *    constructor sets `needsUpdate` before the caller has had a chance to
 *    assign `mipmaps`, so acting inline would resample a base level whose
 *    hand-built mip chain had not been attached yet. Every generator in this
 *    codebase finishes configuring its texture inside one synchronous block,
 *    and uploads happen inside a rAF callback, so a microtask sits exactly in
 *    between: after the texture is complete, before the GPU ever sees it.
 *  3. A hand-built mip chain is *sliced*, not resampled. Level k of a full
 *    chain already is the base downsampled by 2^k, so dropping the first k
 *    levels is exact and free — and it preserves the two chains in this game
 *    that carry meaning beyond a box filter: the coverage-preserving alpha
 *    mips on foliage cutouts, and the variance-to-roughness chain on kart
 *    lacquer. Resampling either of those would have thinned fronds at range
 *    and flattened the specular lobe on every kart.
 *
 * Render targets, depth textures, cube/3D/array textures, compressed textures
 * and anything that is not 8-bit RGBA are left alone. `userData.noTextureBudget`
 * is the explicit opt-out for a generator that knows better.
 */

let budgetMax = Infinity;
let budgetHooked = false;
let budgetQueued = false;
const budgetPending: THREE.Texture[] = [];

/**
 * Install (or update) the process-wide maximum texture edge length, in texels.
 * Call this before any system builds a texture — `createSettings()` does, which
 * is the first thing `main.ts` evaluates. Pass `Infinity` for no cap.
 */
export function setTextureBudget(maxSize: number): void {
  budgetMax = maxSize > 0 ? maxSize : Infinity;
  if (!Number.isFinite(budgetMax) || budgetHooked) return;
  const proto = THREE.Texture.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'needsUpdate');
  const base = desc?.set;
  // If three ever stops backing this with an accessor we do nothing rather than
  // break every upload in the game.
  if (!base) return;
  budgetHooked = true;
  Object.defineProperty(proto, 'needsUpdate', {
    configurable: true,
    enumerable: false,
    set(this: THREE.Texture, value: boolean) {
      base.call(this, value);
      if (value === true) enqueueForBudget(this);
    },
  });
}

/** The current cap. Generators that can pick their own size should honour it. */
export function textureBudget(): number {
  return budgetMax;
}

interface ClaimableSource {
  __budgetClaimed?: boolean;
}

function enqueueForBudget(t: THREE.Texture): void {
  const src = t.source as unknown as ClaimableSource | undefined;
  if (!src || src.__budgetClaimed) return;
  src.__budgetClaimed = true;
  budgetPending.push(t);
  if (budgetQueued) return;
  budgetQueued = true;
  queueMicrotask(flushTextureBudget);
}

function flushTextureBudget(): void {
  budgetQueued = false;
  for (let i = 0; i < budgetPending.length; i++) clampTexture(budgetPending[i]);
  budgetPending.length = 0;
}

interface ImageLike {
  width?: number;
  height?: number;
  data?: ArrayBufferView;
}

function clampTexture(t: THREE.Texture): void {
  const max = budgetMax;
  if (!Number.isFinite(max)) return;
  const flags = t as unknown as Record<string, boolean>;
  if (
    flags.isRenderTargetTexture || flags.isDepthTexture || flags.isCompressedTexture ||
    flags.isCubeTexture || flags.isData3DTexture || flags.isDataArrayTexture ||
    flags.isVideoTexture || flags.isFramebufferTexture
  ) return;
  if (t.userData && (t.userData as { noTextureBudget?: boolean }).noTextureBudget) return;

  const img = t.image as ImageLike | null | undefined;
  if (!img) return;
  const w = img.width! | 0;
  const h = img.height! | 0;
  if (w <= 0 || h <= 0) return;
  const big = Math.max(w, h);
  if (big <= max) return;

  // How many halvings to get the long edge inside the cap.
  let k = 1;
  while (big >> k > max) k++;

  // 1. A hand-built chain: slice it. Exact, allocation-free, and it keeps
  //    whatever the chain was authored to preserve.
  const mips = t.mipmaps as unknown as ImageLike[] | undefined;
  if (mips && mips.length > k) {
    t.mipmaps = mips.slice(k) as unknown as THREE.Texture['mipmaps'];
    t.image = mips[k];
    return;
  }

  // 2. A canvas (or bitmap): successive 2× box reductions. A single drawImage
  //    straight to the target size is a bilinear tap on the full-resolution
  //    image, which drops three quarters of the texels on the floor at 4× and
  //    aliases everything it kept; halving repeatedly is a real box filter.
  if (isDrawable(img)) {
    t.image = halveDrawable(img as CanvasImageSource, w, h, k);
    dropStaleMips(t, mips);
    return;
  }

  // 3. Raw 8-bit RGBA (DataTexture).
  const data = img.data;
  if (
    (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
    t.format === THREE.RGBAFormat && t.type === THREE.UnsignedByteType
  ) {
    t.image = halveBytes(data, w, h, k) as unknown as THREE.Texture['image'];
    dropStaleMips(t, mips);
    return;
  }
  // Anything else (half-float LUTs, odd formats) is left exactly as authored.
}

/**
 * Resampling replaced level 0, so any hand-built chain that came with it is now
 * the wrong size and must go. Dropping it is not enough on its own: a texture
 * with a mipmap min-filter, no chain and `generateMipmaps === false` is
 * mip-INCOMPLETE, and an incomplete texture samples as black. Every generator
 * that ships its own chain also turns generation off, so turning it back on is
 * the other half of the same edit.
 *
 * (In practice this never fires — every chain in the game runs down to 1×1, so
 * the slice path above always wins. It exists so that a future generator with a
 * partial chain degrades to "slightly softer" instead of "black".)
 */
function dropStaleMips(t: THREE.Texture, mips: ImageLike[] | undefined): void {
  if (!mips || !mips.length) return;
  t.mipmaps = [];
  t.generateMipmaps = true;
}

function isDrawable(img: unknown): boolean {
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) return true;
  if (HAS_OFFSCREEN && img instanceof OffscreenCanvas) return true;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return true;
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) return true;
  return false;
}

function halveDrawable(img: CanvasImageSource, w: number, h: number, times: number): AnyCanvas {
  let src: CanvasImageSource = img;
  let cw = w;
  let ch = h;
  let out: AnyCanvas | null = null;
  for (let i = 0; i < times; i++) {
    const nw = Math.max(1, cw >> 1);
    const nh = Math.max(1, ch >> 1);
    const c = rawCanvas(nw, nh);
    const g = c.getContext('2d') as unknown as CanvasRenderingContext2D;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh);
    src = c as unknown as CanvasImageSource;
    out = c;
    cw = nw;
    ch = nh;
  }
  return out!;
}

function halveBytes(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  times: number,
): { data: Uint8Array; width: number; height: number } {
  let cur: Uint8Array | Uint8ClampedArray = data;
  let cw = w;
  let ch = h;
  let out = new Uint8Array(0);
  for (let i = 0; i < times; i++) {
    const nw = Math.max(1, cw >> 1);
    const nh = Math.max(1, ch >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(ch - 1, y * 2);
      const y1 = Math.min(ch - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cw - 1, x * 2);
        const x1 = Math.min(cw - 1, x * 2 + 1);
        const a = (y0 * cw + x0) * 4;
        const b = (y0 * cw + x1) * 4;
        const c = (y1 * cw + x0) * 4;
        const d = (y1 * cw + x1) * 4;
        const o = (y * nw + x) * 4;
        next[o] = (cur[a] + cur[b] + cur[c] + cur[d] + 2) >> 2;
        next[o + 1] = (cur[a + 1] + cur[b + 1] + cur[c + 1] + cur[d + 1] + 2) >> 2;
        next[o + 2] = (cur[a + 2] + cur[b + 2] + cur[c + 2] + cur[d + 2] + 2) >> 2;
        next[o + 3] = (cur[a + 3] + cur[b + 3] + cur[c + 3] + cur[d + 3] + 2) >> 2;
      }
    }
    cur = next;
    out = next;
    cw = nw;
    ch = nh;
  }
  return { data: out, width: cw, height: ch };
}

// ---------------------------------------------------------------------------
// Colour helpers (all in 0..255 display space — these are canvas bytes)
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function rgb(hex: number): RGB {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

export function mixRGB(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Fields — the intermediate buffers every generator fills
// ---------------------------------------------------------------------------

/**
 * One material's worth of raw channels. Generators write per-texel via `set`
 * and `surf`; nothing allocates after construction.
 */
export class Fields {
  readonly size: number;
  readonly albedo: Uint8ClampedArray;
  readonly orm: Uint8ClampedArray;
  readonly height: Float32Array;

  constructor(size: number) {
    this.size = size;
    this.albedo = new Uint8ClampedArray(size * size * 4);
    this.orm = new Uint8ClampedArray(size * size * 4);
    this.height = new Float32Array(size * size);
    this.albedo.fill(255);
    this.orm.fill(255);
    // ORM alpha is pinned at a mid grey and read by nothing. It used to carry
    // the macro layer; see the note below the class for why that was a mistake
    // and where the macro layer lives now. Left at 128 rather than 255 so the
    // canvas' premultiply round trip stays in its well-conditioned range.
    for (let k = 3; k < this.orm.length; k += 4) this.orm[k] = 128;
  }

  /** colour + coverage at texel index `i`; channels are 0..255, alpha 0..1 */
  set(i: number, r: number, g: number, b: number, a = 1): void {
    const k = i * 4;
    this.albedo[k] = r;
    this.albedo[k + 1] = g;
    this.albedo[k + 2] = b;
    this.albedo[k + 3] = a * 255;
  }

  setRGB(i: number, c: RGB, a = 1): void {
    const k = i * 4;
    this.albedo[k] = c.r;
    this.albedo[k + 1] = c.g;
    this.albedo[k + 2] = c.b;
    this.albedo[k + 3] = a * 255;
  }

  /** height (arbitrary units, Sobel normalises), ambient occlusion, roughness, metalness — all 0..1 */
  surf(i: number, height: number, ao: number, roughness: number, metalness = 0): void {
    this.height[i] = height;
    const k = i * 4;
    this.orm[k] = ao * 255;
    this.orm[k + 1] = roughness * 255;
    this.orm[k + 2] = metalness * 255;
  }

}

/*
 * Historical note, because it is the kind of bug that gets reintroduced.
 *
 * The macro layer used to travel in this texture's ALPHA channel, written by a
 * `Fields.macro(i, v)` that no longer exists. Two reasons it moved out, and the
 * second is a correctness bug rather than a taste call.
 *
 * 1. A macro signal smuggled into ORM.a has to be sampled from a 1024² map
 *    magnified over 30 m of world, which is 37 texels per metre of a field whose
 *    entire content is four lattice cells. It cost a full-resolution channel on
 *    the largest surfaces in the frame to store information that fits in 128².
 * 2. A 2D canvas backing store is alpha-premultiplied. Uploading one to WebGL
 *    with `UNPACK_PREMULTIPLY_ALPHA_WEBGL` false makes the browser undo that
 *    multiply, and un-premultiplying at low alpha amplifies the 8-bit
 *    quantisation of the RGB it is dividing. At alpha 128 the error is under
 *    half a percent and nobody notices; at alpha 8 a stored 200 comes back as
 *    255. The old macro fields never went near zero — an un-normalised fbm lives
 *    inside 0.35..0.65 — so this never fired. A *properly contrast-stretched*
 *    macro field does reach zero by construction, which would have turned every
 *    dark patch of the macro layer into a hole punched through the roughness map
 *    underneath it.
 *
 * So ORM alpha stays pinned at the constructor's 128 and the macro layer gets
 * its own small opaque texture — see `macroTexture` below.
 */

/**
 * The macro layer's own texture: three independent low-frequency fields packed
 * RGB, at a resolution matched to what a low-frequency field actually contains.
 *
 * Alpha is a hard 255, which is the whole point — nothing here goes through the
 * premultiply round trip that made the alpha-channel version unsafe.
 *
 *   R — the primary variation: colour drift, patches, weathering zones
 *   G — an independent second field: pooling, damp, wear
 *   B — an anisotropic source, sampled in the tile's own UV frame
 */
export function macroTexture(
  res: number,
  r: Float32Array,
  g?: Float32Array | null,
  b?: Float32Array | null,
): THREE.Texture {
  const bytes = new Uint8ClampedArray(res * res * 4);
  for (let i = 0, k = 0; i < res * res; i++, k += 4) {
    bytes[k] = r[i] * 255;
    bytes[k + 1] = (g ? g[i] : 0.5) * 255;
    bytes[k + 2] = (b ? b[i] : 0.5) * 255;
    bytes[k + 3] = 255;
  }
  // Anisotropy 1 on purpose: this map is magnified almost everywhere it is read
  // (128 texels spread over 30 m), so anisotropic taps would buy nothing and
  // cost bandwidth on the largest surfaces in the frame.
  return bytesTexture(res, bytes, { srgb: false, wrap: THREE.RepeatWrapping, anisotropy: 1 });
}

// ---------------------------------------------------------------------------
// Sobel normal
// ---------------------------------------------------------------------------

/**
 * Wrapping 3×3 Sobel over `height`, encoded OpenGL-style (+Y up in tangent
 * space). The image Y axis runs down while UV V runs up once three flips the
 * canvas, hence the sign on the green channel.
 */
export function sobelNormalBytes(height: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const m = size - 1;
  for (let y = 0; y < size; y++) {
    const yp = y === 0 ? m : y - 1;
    const yn = y === m ? 0 : y + 1;
    const r0 = yp * size;
    const r1 = y * size;
    const r2 = yn * size;
    for (let x = 0; x < size; x++) {
      const xp = x === 0 ? m : x - 1;
      const xn = x === m ? 0 : x + 1;
      const h00 = height[r0 + xp];
      const h01 = height[r0 + x];
      const h02 = height[r0 + xn];
      const h10 = height[r1 + xp];
      const h12 = height[r1 + xn];
      const h20 = height[r2 + xp];
      const h21 = height[r2 + x];
      const h22 = height[r2 + xn];
      const gx = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);
      const gy = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
      let nx = -gx * strength;
      let ny = gy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const k = (r1 + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      // All three channels are signed data in a UNORM texture, so all three get
      // the same `v * 0.5 + 0.5` encode — because every consumer, three's own
      // <normal_fragment_maps> included, decodes with `texture * 2.0 - 1.0`.
      //
      // This channel used to be written as a bare `inv * 255`. Z is a cosine and
      // never negative, so storing it unmapped looks harmless and round-trips
      // fine at shallow angles — but the decode still runs, so the shader was
      // reconstructing `2 * cos(theta) - 1` where it wanted `cos(theta)`:
      //
      //     true tilt   10°    20°    30°    40°    50°    60°    70°
      //     shader saw  10°    21°    34°    50°    70°    90°   109°
      //
      // Below about 20° the error is invisible, which is why this survived. Past
      // 60° the reconstructed normal lies flat against the surface and then
      // tips BELOW it, so those texels shade as if they faced away from the
      // geometry they are on. On tarmac that was 2.8% of texels — a few
      // scattered per chipping — each one a facet pointed somewhere arbitrary,
      // which under a low sun and a warm-sun / blue-zenith sky is a pinpoint
      // that lands orange or cyan depending on where it happened to point.
      // That was the rainbow speckle on the road.
      out[k + 2] = (inv * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadOpts {
  srgb: boolean;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
}

/**
 * `ImageData`'s constructor is typed against a non-shared ArrayBuffer while our
 * buffers are declared with the plain alias; routing through `ImageData['data']`
 * keeps the cast honest and in exactly one place.
 */
export function toImageData(bytes: Uint8ClampedArray, size: number): ImageData {
  return new ImageData(bytes as unknown as ImageData['data'], size, size);
}

function putBytes(size: number, bytes: Uint8ClampedArray): Canvas2D {
  const c = createCanvas(size);
  c.ctx.putImageData(toImageData(bytes, size), 0, 0);
  return c;
}

export function canvasTexture(canvas: AnyCanvas, o: UploadOpts): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = o.wrap ?? THREE.RepeatWrapping;
  t.anisotropy = o.anisotropy ?? 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function bytesTexture(size: number, bytes: Uint8ClampedArray, o: UploadOpts): THREE.Texture {
  return canvasTexture(putBytes(size, bytes).canvas, o);
}

export interface MapSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** R = AO, G = roughness, B = metalness. Bind to aoMap + roughnessMap + metalnessMap. */
  ormMap: THREE.Texture;
  all: THREE.Texture[];
}

export interface BuildOpts {
  normalStrength?: number;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
  /** pre-drawn albedo canvas to use instead of the Fields buffer (for path-drawn materials) */
  albedoCanvas?: AnyCanvas;
}

export function buildMaps(f: Fields, o: BuildOpts = {}): MapSet {
  const size = f.size;
  const aniso = o.anisotropy ?? 8;
  const wrap = o.wrap ?? THREE.RepeatWrapping;
  const map = o.albedoCanvas
    ? canvasTexture(o.albedoCanvas, { srgb: true, wrap, anisotropy: aniso })
    : bytesTexture(size, f.albedo, { srgb: true, wrap, anisotropy: aniso });
  const normalMap = bytesTexture(size, sobelNormalBytes(f.height, size, (o.normalStrength ?? 1) * size * 0.012), {
    srgb: false,
    wrap,
    anisotropy: aniso,
  });
  const ormMap = bytesTexture(size, f.orm, { srgb: false, wrap, anisotropy: aniso });
  // AO defaults to the second UV set; our meshes only have one.
  ormMap.channel = 0;
  return { map, normalMap, ormMap, all: [map, normalMap, ormMap] };
}

/** Blur an alpha/height buffer in place-ish (separable box, 2 passes) — cheap rounding for cutout cards. */
export function blurField(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const r = Math.max(1, radius | 0);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + ((i + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc * norm;
      acc -= src[row + ((x - r + size) % size)];
      acc += src[row + ((x + r + 1) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[((i + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc * norm;
      acc -= tmp[(((y - r + size) % size) * size) + x];
      acc += tmp[(((y + r + 1) % size) * size) + x];
    }
  }
  return out;
}

/** Single readback of a drawn canvas — call this once and derive everything from it. */
export function readPixels(c: Canvas2D): Uint8ClampedArray {
  return c.ctx.getImageData(0, 0, c.size, c.size).data;
}

/** Alpha channel of a readback as a 0..1 field. */
export function alphaFrom(px: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(px.length >> 2);
  for (let i = 0, k = 3; i < out.length; i++, k += 4) out[i] = px[k] / 255;
  return out;
}
