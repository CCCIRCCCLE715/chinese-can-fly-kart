/**
 * ============================================================================
 *  Props — the scenery toolbox.
 * ============================================================================
 *  Everything the world-dressing layer is built from lives here: procedural
 *  texture generation, chamfered/beveled geometry primitives, a merge
 *  accumulator, an instancing accumulator, the shader-patch system that gives
 *  us wind / bob / crowd / flag motion for free on the GPU, the shared
 *  material library, and the individual prop generators.
 *
 *  Two rules govern this file:
 *    1. Nothing here allocates during `update()`. All of it runs at init.
 *    2. Nothing here ships a flat material. Every surface gets albedo +
 *       normal + roughness, generated into a canvas.
 * ============================================================================
 */
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { getMaterials } from '../render/Materials';

// ---------------------------------------------------------------------------
// Palette (ART_DIRECTION.md §3) and small math helpers
// ---------------------------------------------------------------------------

export const PAL = {
  sand: 0xe3c893,
  grass: 0x6f9b47,
  grassTip: 0x87b356,
  seaDeep: 0x0d5a7a,
  seaShallow: 0x3fc9c4,
  foam: 0xeefaff,
  stone: 0xa8927a,
  roofTile: 0xb5643f,
  skyWarm: 0xd7edf5,
  kerbRed: 0xe0453f,
  kerbWhite: 0xf2ece0,
  pastels: [0xefab87, 0xef8da6, 0xf3d58e, 0x70aed7, 0xb69ad0, 0xf0d9bf, 0x8fcbb3],
  shutters: [0x3f6b74, 0x2f5d43, 0x8a4433, 0x5a5f8a, 0x77502f],
  boatHulls: [0xf2ece0, 0xe0453f, 0x2f6ba0, 0x2f5d43, 0xf5e2b0, 0x3f3f4a],
  clothes: [0xf2ece0, 0xa9c8d4, 0xe8a5a0, 0xf5e2b0, 0xdcb8d8, 0x9fc0a8],
  crowd: [0xe0453f, 0x4fc3ff, 0xff9d2e, 0xc05cff, 0xf2ece0, 0x6f9b47, 0xf5e2b0, 0xe8a5a0, 0x2f6ba0, 0xdcb8d8],
  skin: [0xf0c8a0, 0xd9a578, 0xa9713f, 0x6f4426, 0xf7d9bd],
};

export type RNG = () => number;

/** Deterministic 32-bit PRNG — the whole world must rebuild identically. */
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** pick with an RNG */
export const pick = <T>(rng: RNG, arr: T[]): T => arr[(rng() * arr.length) | 0];

// ---------------------------------------------------------------------------
// Canvas texture generation
// ---------------------------------------------------------------------------

function cv(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  return [c, g];
}

function finish(c: HTMLCanvasElement, srgb: boolean, aniso: number, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Alpha cut-out pipeline
// ---------------------------------------------------------------------------
//  Round 1's leaf edges had a black fringe halo and crawled badly. Both are the
//  same bug and neither is fixed by a bigger texture:
//
//  1. A 2D canvas stores premultiplied alpha, so every fully transparent texel
//     reads back as (0,0,0,0). Bilinear filtering and mip generation then
//     average that BLACK into the leaf edge, which is the dark fringe. The fix
//     is to flood the leaf's own colour outward into the transparent region
//     before upload — the alpha still cuts the shape, but whatever the filter
//     drags in from outside is now leaf-coloured. Because putImageData would
//     re-premultiply and throw the dilated colour away again, the result has to
//     be uploaded as a DataTexture, not a CanvasTexture.
//
//  2. Box-filtering alpha halves the number of texels above alphaTest at every
//     mip level, so fronds thin out and dissolve into shimmer with distance.
//     Castano's fix is to rescale each level's alpha so the fraction of texels
//     that survive the SAME alphaTest matches level 0.
// ---------------------------------------------------------------------------

export interface MipLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Flood the RGB of an alpha cut-out outward into its transparent region. */
function dilateRGB(px: Uint8Array, size: number, passes = 8) {
  const known = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) known[i] = px[i * 4 + 3] > 6 ? 1 : 0;
  const next = new Uint8Array(known);
  for (let p = 0; p < passes; p++) {
    let grew = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (known[i]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
          const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (!known[j]) continue;
          r += px[j * 4];
          g += px[j * 4 + 1];
          b += px[j * 4 + 2];
          n++;
        }
        if (!n) continue;
        px[i * 4] = (r / n) | 0;
        px[i * 4 + 1] = (g / n) | 0;
        px[i * 4 + 2] = (b / n) | 0;
        next[i] = 1;
        grew = true;
      }
    }
    known.set(next);
    if (!grew) break;
  }
  // Anything the flood never reached — the far corners of a sparse sheet — gets
  // the mean colour rather than staying black. Those texels only surface in the
  // bottom mips, where a whole quadrant is averaged into one texel, and that is
  // precisely where a leftover black would darken the leaf.
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < size * size; i++) {
    if (!known[i]) continue;
    r += px[i * 4];
    g += px[i * 4 + 1];
    b += px[i * 4 + 2];
    n++;
  }
  if (!n) return;
  r = (r / n) | 0;
  g = (g / n) | 0;
  b = (b / n) | 0;
  for (let i = 0; i < size * size; i++) {
    if (known[i]) continue;
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
  }
}

/**
 * Coverage-preserving mip chain. Colour is averaged weighted by alpha so the
 * dilated skirt never washes out the leaf; alpha is averaged flat and then
 * rescaled so `alphaTest` keeps the same silhouette area at every level.
 */
function coverageMips(base: Uint8Array, size: number, ref: number): MipLevel[] {
  const out: MipLevel[] = [{ data: base, width: size, height: size }];
  const refB = ref * 255;
  let target = 0;
  for (let i = 0; i < size * size; i++) if (base[i * 4 + 3] >= refB) target++;
  target /= size * size;
  let prev = base;
  let pw = size;
  while (pw > 1) {
    const w = pw >> 1;
    const dst = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          wsum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const s = ((y * 2 + dy) * pw + (x * 2 + dx)) * 4;
            const av = prev[s + 3];
            const wgt = av + 1;
            r += prev[s] * wgt;
            g += prev[s + 1] * wgt;
            b += prev[s + 2] * wgt;
            a += av;
            wsum += wgt;
          }
        }
        const o = (y * w + x) * 4;
        dst[o] = (r / wsum) | 0;
        dst[o + 1] = (g / wsum) | 0;
        dst[o + 2] = (b / wsum) | 0;
        dst[o + 3] = (a / 4) | 0;
      }
    }
    // Castano alpha-test rescale. The bracket has to reach well below 1: a 2x2
    // box over a thin frond leaflet RAISES the fraction of texels above the
    // test as often as it lowers it, so the correction runs both ways.
    if (target > 0 && w >= 1) {
      let lo = 0.02,
        hi = 40;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) * 0.5;
        let cov = 0;
        for (let i = 0; i < w * w; i++) if (Math.min(255, dst[i * 4 + 3] * mid) >= refB) cov++;
        if (cov / (w * w) < target) lo = mid;
        else hi = mid;
      }
      const sc = (lo + hi) * 0.5;
      let peak = 0;
      for (let i = 0; i < w * w; i++) {
        const a = Math.min(255, (dst[i * 4 + 3] * sc) | 0);
        dst[i * 4 + 3] = a;
        if (a > peak) peak = a;
      }
      // At 4² and below the coverage quantum is 6%, so the search can round a
      // real silhouette down to nothing and the card pops out of existence on
      // the last mip. Guarantee the strongest texel always survives the test.
      if (peak < refB) {
        const lift = refB / Math.max(1, peak);
        for (let i = 0; i < w * w; i++) dst[i * 4 + 3] = Math.min(255, Math.ceil(dst[i * 4 + 3] * lift));
      }
    }
    out.push({ data: dst, width: w, height: w });
    prev = dst;
    pw = w;
  }
  return out;
}

/**
 * Integer-lattice value noise with an explicit period per axis, so every
 * texture wraps exactly and can have anisotropic grain (wood stretches along
 * the plank, plaster streaks with the trowel). Simplex would look marginally
 * better here but cost roughly five times as much, and at 1024² across eight
 * material sets that is seconds of boot time for detail nobody can resolve.
 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px,
    y = v * py;
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px,
    x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py,
    y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed),
    b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed),
    d = hash2(x1, y1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/**
 * fbm in [-1,1]; periods double each octave so the wrap survives.
 *
 * ---------------------------------------------------------------------------
 *  ROUND 2: THE NYQUIST GUARD, AND WHY IT IS THE FIX FOR "NOISE-MOTTLED"
 * ---------------------------------------------------------------------------
 *  `ridgeGeo` already refuses to ask for a feature its column spacing cannot
 *  carry, and says so at length. The texture generator never got the same rule,
 *  and it is asked for sub-pixel detail constantly: the sponsor board's vinyl
 *  ran `fbm(..., 192, 192, 3)` into a 512² map, so its three octaves land at
 *  2.7, 1.3 and 0.7 PIXELS per cycle. Only the first is drawable. The other two
 *  are per-texel white noise, and because this feeds `normalFromHeight` they
 *  arrive as a field of random normals — which under a 14° key is a scintillating
 *  dither up close and, once the mip chain has averaged it, a grey mush at range.
 *  That is exactly the critique's "noise-mottled panel... reads as texture
 *  compression artefacts rather than as weathered paint", and it is why the
 *  lettering appeared to dissolve INTO the board: the board was fizzing.
 *
 *  So: stop at the last octave the map can actually resolve. Four texels per
 *  cycle is the floor — below that a value-noise lattice is aliasing by
 *  construction. Callers working at 512² pass `res` so the cap follows them.
 *  Nothing that was drawable is lost; everything that was never drawable goes.
 */
function fbm(seed: number, u: number, v: number, px: number, py: number, oct: number, gain = 0.5, res = 1024): number {
  let amp = 1,
    sum = 0,
    norm = 0,
    a = px,
    b = py;
  const lim = res / 4;
  for (let o = 0; o < oct; o++) {
    if (o > 0 && (a > lim || b > lim)) break;
    sum += amp * vnoise(u, v, a | 0, b | 0, seed + o * 131);
    norm += amp;
    amp *= gain;
    a *= 2;
    b *= 2;
  }
  return (sum / norm) * 2 - 1;
}

/** Central-difference normal map out of a height field. */
function normalFromHeight(h: Float32Array, size: number, strength: number, aniso: number): THREE.CanvasTexture {
  const [c, g] = cv(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  const w = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (w(x + 1, y) - w(x - 1, y)) * strength;
      const dy = (w(x, y + 1) - w(x, y - 1)) * strength;
      // normalize(-dx, -dy, 1)
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      d[i] = (-dx * l * 0.5 + 0.5) * 255;
      d[i + 1] = (-dy * l * 0.5 + 0.5) * 255;
      d[i + 2] = (l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, false, aniso);
}

/** Grey texture from a float field — used for roughness (three reads .g). */
function greyFromField(f: Float32Array, size: number, aniso: number): THREE.CanvasTexture {
  const [c, g] = cv(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = clamp(f[i], 0, 1) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, false, aniso);
}

export interface MatMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * The procedural texture library. Every generator returns albedo + normal +
 * roughness; the roughness field always *varies spatially* (§4 of the bible —
 * constant roughness is the #1 amateur tell).
 */
export class TexLib {
  private cache = new Map<string, MatMaps>();
  readonly aniso: number;

  constructor(renderer: THREE.WebGLRenderer) {
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  private memo(key: string, gen: () => MatMaps): MatMaps {
    let m = this.cache.get(key);
    if (!m) {
      m = gen();
      this.cache.set(key, m);
    }
    return m;
  }

  // -- stucco / lime plaster: the village walls -----------------------------
  plaster(size = 1024): MatMaps {
    return this.memo('plaster', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const grain = fbm(11, u, v, 192, 192, 4);
          const trowel = fbm(23, u, v, 8, 26, 3) * 0.9;
          const blotch = fbm(37, u, v, 4, 4, 2);
          const i = y * size + x;
          h[i] = grain * 0.55 + trowel * 0.45;
          // Base is a warm off-white; per-house pastel arrives as vertex colour.
          const t = 0.5 + h[i] * 0.5;
          const damp = smoothstep(0.12, 0.34, blotch) * 0.14;
          const rr = lerp(0.90, 1.0, t) - damp * 0.9;
          const gg = lerp(0.875, 0.985, t) - damp * 0.75;
          const bb = lerp(0.83, 0.95, t) - damp * 0.5;
          const o = i * 4;
          d[o] = rr * 255;
          d[o + 1] = gg * 255;
          d[o + 2] = bb * 255;
          d[o + 3] = 255;
          r[i] = 0.62 + trowel * 0.16 + grain * 0.1 + damp * 1.2;
        }
      }
      g.putImageData(img, 0, 0);
      // hairline cracks: a few random walks, darkened + carved into the height
      const rng = mulberry32(7717);
      g.lineCap = 'round';
      for (let k = 0; k < 26; k++) {
        let x = rng() * size,
          y = rng() * size,
          a = rng() * Math.PI * 2;
        g.strokeStyle = `rgba(120,105,92,${0.18 + rng() * 0.22})`;
        g.lineWidth = 0.7 + rng() * 1.3;
        g.beginPath();
        g.moveTo(x, y);
        const steps = 12 + ((rng() * 26) | 0);
        for (let s = 0; s < steps; s++) {
          a += (rng() - 0.5) * 0.9;
          x += Math.cos(a) * 6;
          y += Math.sin(a) * 6;
          g.lineTo(x, y);
          const ix = ((x | 0) + size) % size,
            iy = ((y | 0) + size) % size;
          h[iy * size + ix] -= 0.5;
        }
        g.stroke();
      }
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 26, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- terracotta barrel roof tiles ----------------------------------------
  roofTile(size = 1024): MatMaps {
    return this.memo('roof', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const cols = 8; // tiles across
      const rows = 10; // courses down
      const rng = mulberry32(4242);
      const jitter = new Float32Array(cols * rows * 3);
      for (let i = 0; i < jitter.length; i++) jitter[i] = rng();
      for (let y = 0; y < size; y++) {
        const fv = y / size;
        const rowF = fv * rows;
        const row = Math.floor(rowF);
        const rowT = rowF - row; // 0 at the top of a course (lapped by the one above)
        for (let x = 0; x < size; x++) {
          const fu = x / size;
          // Alternate courses offset half a tile.
          const off = row & 1 ? 0.5 : 0;
          const colF = fu * cols + off;
          const col = Math.floor(colF) % cols;
          const ct = colF - Math.floor(colF);
          // Barrel profile: half-round ridge, so height peaks mid-tile.
          const ji = (row % rows) * cols * 3 + col * 3;
          const j0 = jitter[ji],
            j1 = jitter[ji + 1],
            j2 = jitter[ji + 2];
          // ------------------------------------------------------------------
          // "CORRUGATED CARDBOARD": WHAT A REAL BARREL ROOF HAS THAT THIS DIDN'T
          // ------------------------------------------------------------------
          // The profile and the per-tile hue drift were already here, and they
          // are not what was missing. What was missing is that every pan ran the
          // full height of the map as one unbroken stripe: the lap shadow was
          // only the top 10% of a course, the tile ENDS all landed on the same
          // ten lines, and no individual tile ever sat proud, slipped or broken.
          // A ribbed prism is exactly what that describes.
          //
          //  · `slip` drops a course's leading edge by up to a quarter of its
          //    own lap, per tile, so the courses stop being ruled lines;
          //  · the lap shadow is three times deeper and follows the slip;
          //  · `broken` takes one tile in ~forty down to the underlay;
          //  · `proud` lifts a scattered few so they catch the low sun on their
          //    upslope edge, which is the tell that a roof is made of objects.
          const slip = (j1 - 0.5) * 0.16;
          const rowS = clamp(rowT - slip, 0, 1);
          const barrel = Math.sin(ct * Math.PI);
          const lap = smoothstep(0.0, 0.30, rowS); // shadowed lap line at the top
          const proud = j2 > 0.86 ? 0.16 : 0;
          const broken = j0 > 0.975 ? 1 : 0;
          const gap = Math.pow(barrel, 0.6) * (1 - broken * 0.72);
          const i = y * size + x;
          h[i] = gap * 0.9 + lap * 0.35 - (1 - lap) * 0.5 + proud + fbm(41, fu, fv, 96, 96, 2, 0.5, size) * 0.09;
          const shade = (0.55 + 0.45 * gap) * (0.62 + 0.38 * lap) * (1 - broken * 0.28);
          // Per-pan hue AND value drift. §3's roof key is #b5643f; ±0.03 of hue
          // and ±0.15 of value around it is what stops eight pans reading as one
          // extruded ribbon, and it is free because it rides the jitter table
          // that was already indexed per tile.
          const hueT = j0 * 0.5 + j1 * 0.2;
          const val = 1 + (j2 - 0.5) * 0.30;
          let rr = lerp(0.62, 0.80, hueT) * shade * val;
          let gg = lerp(0.30, 0.42, hueT + (j1 - 0.5) * 0.12) * shade * val;
          let bb = lerp(0.21, 0.28, hueT * 0.8) * shade * val;
          // Moss lives in the valleys AND in the lap shadow, which is where the
          // water actually sits.
          const moss =
            clamp((1 - barrel) * 1.4 - 0.55 + (1 - lap) * 0.35, 0, 1) * (0.25 + j2 * 0.5) * smoothstep(0.15, 0.6, fbm(53, fu, fv, 8, 8, 2, 0.5, size) + 0.5);
          rr = lerp(rr, 0.34, moss * 0.55);
          gg = lerp(gg, 0.38, moss * 0.55);
          bb = lerp(bb, 0.24, moss * 0.55);
          const o = i * 4;
          d[o] = clamp(rr, 0, 1) * 255;
          d[o + 1] = clamp(gg, 0, 1) * 255;
          d[o + 2] = clamp(bb, 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.55 + (1 - barrel) * 0.3 + j1 * 0.12 + moss * 0.15;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 34, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- painted timber: shutters, doors, jetties, hulls, crates --------------
  wood(size = 1024): MatMaps {
    return this.memo('wood', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const planks = 6;
      const rng = mulberry32(9091);
      const pj = new Float32Array(planks * 2);
      for (let i = 0; i < pj.length; i++) pj[i] = rng();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const pf = u * planks;
          const p = Math.floor(pf) % planks;
          const pt = pf - Math.floor(pf);
          const edge = smoothstep(0.0, 0.035, pt) * smoothstep(1.0, 0.965, pt);
          // grain: fbm heavily stretched along the plank
          const grain = fbm(61 + p * 7, u, v, 96, 6, 4);
          const fine = fbm(71 + p * 5, u, v, 256, 24, 2);
          const i2 = y * size + x;
          const gr = grain * 0.7 + fine * 0.3;
          h[i2] = gr * 0.5 + (edge - 1) * 1.1;
          const base = 0.86 + gr * 0.14;
          // per-plank value jitter, widened: every plank on a start arch being
          // identical in both albedo and gloss is a dead giveaway
          const bright = base * lerp(0.76, 1.08, pj[p * 2]) * lerp(0.55, 1.0, edge);
          const o = i2 * 4;
          d[o] = clamp(bright, 0, 1) * 255;
          d[o + 1] = clamp(bright * (0.97 - gr * 0.05), 0, 1) * 255;
          d[o + 2] = clamp(bright * (0.93 - gr * 0.09), 0, 1) * 255;
          d[o + 3] = 255;
          // weathered grey 0.9 vs resin-sealed 0.6, decided per plank
          const sealed = pj[p * 2 + 1] < 0.42 ? 0.58 : 0.9;
          r[i2] = sealed + Math.abs(gr) * 0.22 + (1 - edge) * 0.18 - 0.12;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 22, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- weathered ashlar: quay walls, lighthouse base, plinths ---------------
  stone(size = 1024): MatMaps {
    return this.memo('stone', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const rows = 7;
      const rng = mulberry32(3313);
      const rowOff: number[] = [];
      const blockJ: number[][] = [];
      for (let y = 0; y < rows; y++) {
        rowOff.push(rng());
        const cols = 4 + ((rng() * 3) | 0);
        const js: number[] = [];
        for (let i = 0; i < cols * 3; i++) js.push(rng());
        js.push(cols);
        blockJ.push(js);
      }
      for (let y = 0; y < size; y++) {
        const v = y / size;
        const rf = v * rows;
        const row = Math.floor(rf) % rows;
        const rt = rf - Math.floor(rf);
        const js = blockJ[row];
        const cols = js[js.length - 1];
        for (let x = 0; x < size; x++) {
          const u = x / size;
          const cf = u * cols + rowOff[row];
          const col = Math.floor(cf) % cols;
          const ct = cf - Math.floor(cf);
          const m = 0.028; // mortar width
          const inBlock = smoothstep(0, m, ct) * smoothstep(1, 1 - m, ct) * smoothstep(0, m * rows / cols, rt) * smoothstep(1, 1 - (m * rows) / cols, rt);
          const j0 = js[col * 3] ?? 0.5,
            j1 = js[col * 3 + 1] ?? 0.5,
            j2 = js[col * 3 + 2] ?? 0.5;
          const rough = fbm(83 + col * 13 + row * 29, u, v, 128, 128, 4);
          const wide = fbm(97, u, v, 6, 6, 3);
          const i = y * size + x;
          // Deeper joints: at a 14° key the coursing has to self-shadow, and a
          // shallow height step gives no raking micro-shadow at all.
          h[i] = inBlock * 1.85 - 0.6 + rough * 0.35 * inBlock;
          const tone = lerp(0.72, 1.0, j0) * (0.9 + rough * 0.2) * lerp(0.72, 1.0, inBlock);
          // #a8927a base, greened where damp
          let rr = 0.66 * tone,
            gg = 0.575 * tone,
            bb = 0.48 * tone;
          const damp = clamp(wide * 1.6 + 0.25 - v * 0.7, 0, 1) * 0.35 * j1;
          rr = lerp(rr, 0.32, damp);
          gg = lerp(gg, 0.38, damp);
          bb = lerp(bb, 0.28, damp);
          const o = i * 4;
          d[o] = clamp(rr, 0, 1) * 255;
          d[o + 1] = clamp(gg, 0, 1) * 255;
          d[o + 2] = clamp(bb, 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.7 + rough * 0.2 + (1 - inBlock) * 0.2 - j2 * 0.12 + damp * 0.2;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 40, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- painted / lacquered metal: bollards, rails, lamp posts, tyres --------
  paintedMetal(size = 512): MatMaps {
    return this.memo('metal', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const orange = fbm(101, u, v, 96, 96, 4); // orange-peel in the paint
          const chip = clamp(fbm(103, u, v, 24, 24, 3) * 2.4 - 0.85, 0, 1);
          const i = y * size + x;
          h[i] = orange * 0.5 - chip * 1.6;
          const base = 0.94 + orange * 0.06;
          const rust = chip * 0.8;
          const o = i * 4;
          d[o] = clamp(lerp(base, 0.45, rust), 0, 1) * 255;
          d[o + 1] = clamp(lerp(base, 0.26, rust), 0, 1) * 255;
          d[o + 2] = clamp(lerp(base, 0.18, rust), 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.3 + orange * 0.14 + rust * 0.55;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 16, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /**
   * 4x4 atlas of striped awning / parasol / sail canvas. Per-instance UV
   * transform picks a cell, so all fabric in the world is one draw call and
   * still shows six different stripe schemes.
   */
  fabricAtlas(size = 1024): MatMaps {
    return this.memo('fabric', () => {
      const [c, g] = cv(size);
      const cell = size / 4;
      const rng = mulberry32(5150);
      const schemes: [string, string][] = [
        ['#f2ece0', '#e0453f'],
        ['#f2ece0', '#3f6b74'],
        ['#f5e2b0', '#b5643f'],
        ['#f2ece0', '#2f6ba0'],
        ['#eaf0ea', '#2f5d43'],
        ['#f2ece0', '#ff9d2e'],
        ['#f0e4f0', '#dcb8d8'],
        ['#f2ece0', '#f2ece0'],
      ];
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const idx = cy * 4 + cx;
          const [a, b] = schemes[idx % schemes.length];
          const x0 = cx * cell,
            y0 = cy * cell;
          g.fillStyle = a;
          g.fillRect(x0, y0, cell, cell);
          const bands = 4 + (idx % 4);
          g.fillStyle = b;
          for (let i = 0; i < bands; i++) {
            const w = cell / (bands * 2);
            g.fillRect(x0 + (i * cell) / bands + w * 0.5, y0, w, cell);
          }
          // dirt at the bottom hem + a soft sag gradient so it isn't flat
          const grad = g.createLinearGradient(x0, y0, x0, y0 + cell);
          grad.addColorStop(0, 'rgba(255,240,215,0.22)');
          grad.addColorStop(0.65, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(60,45,35,0.20)');
          g.fillStyle = grad;
          g.fillRect(x0, y0, cell, cell);
          for (let k = 0; k < 40; k++) {
            g.fillStyle = `rgba(90,72,55,${rng() * 0.05})`;
            g.beginPath();
            g.arc(x0 + rng() * cell, y0 + cell * (0.6 + rng() * 0.4), rng() * 9, 0, 7);
            g.fill();
          }
        }
      }
      // weave normal + roughness
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const weave = Math.sin(x * 1.9) * Math.sin(y * 1.9) * 0.4 + fbm(107, x / size, y / size, 256, 256, 2) * 0.6;
          h[i] = weave;
          r[i] = 0.78 + weave * 0.12;
        }
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 8, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** 2 x 4 atlas of trackside sponsor boards. */
  /**
   * The start-line banner: course name, chequer flashes and a sponsor rule.
   * §1 asks for a banner arch over the start line and a bare timber gantry is
   * not one. 4:1 so the lettering is legible across the road.
   */
  bannerCloth(size = 1024): MatMaps {
    return this.memo('bannercloth', () => {
      const [c, g] = cv(size);
      const hh = size / 4;
      g.fillStyle = '#e0453f';
      g.fillRect(0, 0, size, hh);
      // chequer flashes at both ends
      const q = hh / 4;
      for (let bx = 0; bx < 3; bx++)
        for (let by = 0; by < 4; by++) {
          if ((bx + by) % 2) continue;
          for (const side of [0, 1]) {
            g.fillStyle = '#f2ece0';
            g.fillRect(side ? size - (bx + 1) * q : bx * q, by * q, q, q);
          }
        }
      // sponsor rule along the bottom
      g.fillStyle = '#2f3340';
      g.fillRect(0, hh * 0.8, size, hh * 0.2);
      g.fillStyle = '#f5e2b0';
      g.font = `700 ${hh * 0.13}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.letterSpacing = '6px';
      g.fillText('氮气动力 · 阿马菲机油 · 加速工坊 · 海港', size / 2, hh * 0.9);
      // course name
      g.fillStyle = '#f2ece0';
      g.font = `900 ${hh * 0.42}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.letterSpacing = '10px';
      g.strokeStyle = 'rgba(60,20,16,0.55)';
      g.lineWidth = 7;
      g.strokeText('樱花町', size / 2, hh * 0.4);
      g.fillText('樱花町', size / 2, hh * 0.4);
      // the rest of the sheet is plain cloth for the fold-over
      g.fillStyle = '#c8382f';
      g.fillRect(0, hh, size, size - hh);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const weave = Math.sin(x * 2.1) * Math.sin(y * 2.1) * 0.35 + fbm(211, x / size, y / size, 220, 220, 2) * 0.65;
          // slack ripples running down the drop
          h[i] = weave * 0.5 + Math.sin(x * 0.055 + fbm(213, x / size, y / size, 6, 6, 2) * 4) * 0.5;
          r[i] = 0.74 + weave * 0.12;
        }
      return {
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(h, size, 12, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /**
   * ==========================================================================
   *  crowdCloth — the spectators' clothing atlas.
   * ==========================================================================
   *  BLOCKER FROM ROUND 1. The crowd material was
   *      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 })
   *  — no map, no normal, no roughness map. §4 names a flat untextured
   *  MeshStandardMaterial as an automatic fail, and in hud.png a band of these
   *  sits fifteen metres from the lens, so it is the one place in the game where
   *  that fail is unmissable.
   *
   *  A 3x3 grid of 256² garment cards. Each card is a whole figure's worth of
   *  clothing read bottom-to-top — trousers / skirt, then the shirt, then a
   *  collar — because the body UV runs 0..1 up the figure, so a card that only
   *  painted a shirt would leave the legs untextured. Nine designs across
   *  stripes, hoops, block, plain and a sash, and the existing per-instance
   *  `vertexColors` tint still multiplies over the top, so nine cards times ten
   *  roster colours is ninety distinct spectators before the pose variants.
   *
   *  Patterns are authored to be SEAMLESS IN U, because u is the angle around
   *  the body: vertical stripes come in whole counts across the cell and hoops
   *  are horizontal, so nothing shows a seam down the spectator's back.
   *
   *  Roughness runs 0.62 on the synthetics (the blocks and the sash, which read
   *  as a sports shirt) to 0.90 on the cottons — two visibly different surface
   *  responses inside one crowd, which is what stops several hundred figures
   *  from sharing one plastic sheen.
   */
  crowdCloth(size = 768): MatMaps {
    return this.memo('crowdcloth', () => {
      const [c, g] = cv(size);
      const cell = size / 3;
      // [trouser, shirt base, shirt accent, pattern kind, synthetic-ness]
      const cards: [string, string, string, number, number][] = [
        ['#3c4356', '#f2ece0', '#2f6ba0', 0, 0.15], // plain cotton tee
        ['#4a4034', '#e8e2d2', '#e0453f', 1, 0.55], // vertical stripes
        ['#2f3340', '#4fc3ff', '#f5f9ff', 2, 0.95], // hoops, synthetic
        ['#5a4a38', '#f5e2b0', '#8f5a2f', 3, 0.20], // check
        ['#37404e', '#e0453f', '#f9f4ea', 4, 0.85], // block + sash
        ['#4d4238', '#9fc0a8', '#40614c', 1, 0.30], // fine stripe, linen
        ['#2e3542', '#dcb8d8', '#7a4f76', 5, 0.25], // speckled weave
        ['#514436', '#ff9d2e', '#2b2b34', 4, 0.90], // hi-vis block
        ['#39404c', '#a9c8d4', '#f2ece0', 2, 0.45], // wide hoop
      ];
      const rough = new Float32Array(size * size);
      for (let k = 0; k < 9; k++) {
        const cx = (k % 3) * cell;
        const cy = ((k / 3) | 0) * cell;
        const [trouser, base, accent, kind, synth] = cards[k];
        // bottom 44% trousers, top 56% shirt, with a collar band at the very top
        g.fillStyle = trouser;
        g.fillRect(cx, cy + cell * 0.56, cell, cell * 0.44);
        g.fillStyle = base;
        g.fillRect(cx, cy, cell, cell * 0.56);
        g.save();
        g.beginPath();
        g.rect(cx, cy, cell, cell * 0.56);
        g.clip();
        g.fillStyle = accent;
        if (kind === 1) {
          // vertical stripes — 8 across the cell, so they close round the body
          for (let i = 0; i < 8; i += 2) g.fillRect(cx + (i / 8) * cell, cy, cell / 16, cell);
        } else if (kind === 2) {
          for (let i = 0; i < 5; i++) g.fillRect(cx, cy + cell * (0.05 + i * 0.11), cell, cell * 0.052);
        } else if (kind === 3) {
          g.globalAlpha = 0.55;
          for (let i = 0; i < 6; i += 2) g.fillRect(cx + (i / 6) * cell, cy, cell / 12, cell);
          for (let i = 0; i < 5; i += 2) g.fillRect(cx, cy + (i / 9) * cell, cell, cell / 18);
          g.globalAlpha = 1;
        } else if (kind === 4) {
          // block panel plus a diagonal sash
          g.fillRect(cx, cy + cell * 0.34, cell, cell * 0.22);
          g.beginPath();
          g.moveTo(cx, cy + cell * 0.10);
          g.lineTo(cx + cell, cy + cell * 0.30);
          g.lineTo(cx + cell, cy + cell * 0.38);
          g.lineTo(cx, cy + cell * 0.18);
          g.closePath();
          g.fill();
        } else if (kind === 5) {
          g.globalAlpha = 0.5;
          for (let i = 0; i < 320; i++) {
            const rx = cx + ((i * 61) % cell);
            const ry = cy + ((i * 137) % (cell * 0.56));
            g.fillRect(rx, ry, 3, 3);
          }
          g.globalAlpha = 1;
        }
        g.restore();
        // collar band: a value break at the neck so the head separates
        g.fillStyle = 'rgba(20,16,20,0.30)';
        g.fillRect(cx, cy, cell, cell * 0.035);
        // roughness for this card, with a spatial wobble so it is never constant
        const r0 = lerp(0.90, 0.62, synth);
        for (let y = 0; y < cell; y++)
          for (let x = 0; x < cell; x++) {
            const gx = (cx + x) | 0;
            const gy = (cy + y) | 0;
            rough[gy * size + gx] = r0;
          }
      }
      // ---- woven-cloth normal + the roughness wobble, one pass over the sheet
      const h = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          // weave at ~7 px so it survives the mip chain instead of dithering,
          // plus a slack-fold octave at cloth scale
          const weave = (Math.sin(x * 0.9) * Math.sin(y * 0.9)) * 0.4;
          const fold = fbm(317, x / size, y / size, 9, 9, 2, 0.5, size);
          h[i] = weave * 0.45 + fold * 0.55;
          rough[i] = clamp(rough[i] + fold * 0.14 + weave * 0.05, 0.30, 0.99);
        }
      return {
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(h, size, 5.0, this.aniso),
        roughnessMap: greyFromField(rough, size, this.aniso),
      };
    });
  }

  sponsorAtlas(size = 2048): MatMaps {
    return this.memo('sponsor', () => {
      const [c, g] = cv(size);
      const w = size / 2,
        h0 = size / 4;
      // SHORT WORDS. This is the largest single lever on sign legibility and it
      // is not a rendering setting: a 4 m board at 40 m is ~40 screen pixels
      // wide, so 'KART ROYALE' gets 3.6 px per character and there is no font,
      // resolution or filter that recovers a letterform from that. Six glyphs
      // maximum, so each one gets 6-7 px and the WORD SHAPE survives even after
      // the letterforms have gone. Every pair is also picked for luminance
      // contrast, not just hue contrast — hue is the first thing a mip average
      // throws away.
      const boards: [string, string, string][] = [
        ['#e0453f', '#f9f4ea', '落日'],
        ['#2f6ba0', '#f5e2b0', '涡轮'],
        ['#f5e2b0', '#8f3f22', '阿马菲'],
        ['#2f5d43', '#f2ece0', '海港'],
        ['#ff9d2e', '#2b2b34', '氮气'],
        ['#2b2f3a', '#4fc3ff', '王者'],
        ['#c78ec2', '#2b2430', '黄金'],
        ['#4fc3ff', '#20303c', '加速'],
      ];
      for (let i = 0; i < 8; i++) {
        const cx = (i % 2) * w,
          cy = ((i / 2) | 0) * h0;
        const [bg, fg, text] = boards[i];
        g.fillStyle = bg;
        g.fillRect(cx, cy, w, h0);
        // chevron furniture so a board still reads when the text is small
        g.save();
        g.beginPath();
        g.rect(cx, cy, w, h0);
        g.clip();
        g.globalAlpha = 0.16;
        g.fillStyle = fg;
        for (let k = -2; k < 10; k++) {
          g.beginPath();
          g.moveTo(cx + k * 60, cy + h0);
          g.lineTo(cx + k * 60 + 34, cy + h0);
          g.lineTo(cx + k * 60 + 34 + h0 * 0.5, cy);
          g.lineTo(cx + k * 60 + h0 * 0.5, cy);
          g.closePath();
          g.fill();
        }
        g.globalAlpha = 1;
        // Legibility at gameplay distance is a MIP problem, not a font problem:
        // once the board is 40 px wide the letterform and its background have
        // averaged together and the word turns into a coloured smear. Two things
        // buy it back — texel density (this atlas is 2048², so each board is
        // 1024 x 512 for a 4 m x 1 m panel ≈ 4 mm/texel), and a hard contrast
        // ring around every glyph so what the mip chain averages toward is still
        // a light-on-dark edge rather than mud.
        g.font = `900 ${h0 * 0.52}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        // Generous tracking. Tight letterforms merge into one blob at the first
        // mip drop; a gap between glyphs is what survives, because the gap is
        // what the average has to fill in before the word closes up.
        g.letterSpacing = `${Math.round(h0 * 0.035)}px`;
        g.lineJoin = 'round';
        // Drop shadow first, offset DOWN-RIGHT so it reads as depth rather than
        // as a fat outline, then the keyline, then the fill. Three layers means
        // the glyph edge is still a hard light-dark transition two mip levels
        // down, which is the level a 40 m board is actually sampled at.
        g.fillStyle = 'rgba(18,12,10,0.34)';
        g.fillText(text, cx + w / 2 + h0 * 0.018, cy + h0 / 2 + h0 * 0.022, w * 0.9);
        g.strokeStyle = 'rgba(20,16,14,0.62)';
        g.lineWidth = h0 * 0.07;
        g.strokeText(text, cx + w / 2, cy + h0 / 2, w * 0.9);
        g.fillStyle = fg;
        g.fillText(text, cx + w / 2, cy + h0 / 2, w * 0.9);
        // frame: a dark keyline plus a light inner line, so the board's own
        // outline survives to the distance the lettering does not
        g.strokeStyle = 'rgba(0,0,0,0.4)';
        g.lineWidth = h0 * 0.035;
        g.strokeRect(cx + h0 * 0.018, cy + h0 * 0.018, w - h0 * 0.036, h0 - h0 * 0.036);
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.lineWidth = h0 * 0.016;
        g.strokeRect(cx + h0 * 0.055, cy + h0 * 0.055, w - h0 * 0.11, h0 - h0 * 0.11);
        g.restore();
      }
      // ------------------------------------------------------------------
      // THE BOARD WEATHERS, THE PAINT CHIPS — AND THEY ARE NOT THE SAME NOISE
      // ------------------------------------------------------------------
      // Round 1's surface noise ran at 192 cycles into a 512² map, three
      // octaves deep: 2.7, 1.3 and 0.7 pixels per cycle. See the note on `fbm`.
      // In a normal map that is not weathering, it is a dither, and it is what
      // made every sign in the game read as compression mush with the type
      // dissolving into it.
      //
      // Weathering is LOW frequency: a board fades in patches the size of a
      // hand, streaks where the rain runs off it, and lifts at the corners. All
      // three are here, all at wavelengths the map can carry, and the amplitude
      // is a third of what it was so the glyph edges — which are the thing the
      // player is actually meant to read — stay the highest-contrast feature on
      // the panel rather than competing with the substrate.
      // ------------------------------------------------------------------
      // ROUND 2: THE TYPE HAS TO EXIST IN THE NORMAL AND ROUGHNESS MAPS TOO
      // ------------------------------------------------------------------
      // corner.png's barrier is a metre from the lens and its lettering reads as
      // a brown smear on a brown board. The albedo is not the problem — it is
      // 1024 x 512 per panel, which is 4 mm/texel. The problem is that it is the
      // ONLY channel the type exists in: the normal map carried weathering noise
      // and nothing else, and the roughness map ran one continuous weathering
      // field across ink and field alike. So a screen-printed sign, at one metre,
      // under a 14° key, produced exactly one surface response and no relief at
      // any glyph edge — and with no specular break at the letterform there is
      // nothing for the eye to lock onto but a flat colour difference that the
      // haze then halves.
      //
      // A silkscreened board genuinely has two surfaces: the ink sits a few
      // tenths of a millimetre proud and dries MATTE (0.72), the varnished field
      // around it stays glossy (0.35). That single split is worth more at close
      // range than another doubling of the albedo, because it puts a moving
      // highlight along every letter edge as the kart goes past.
      //
      // The fields are also raised 512 -> 1024 so the glyph mask can be sampled
      // without turning the type into mush before it ever reaches the map.
      const ns = 1024;
      const [mc, mg] = cv(ns);
      const mw = ns / 2,
        mh = ns / 4;
      mg.fillStyle = '#000';
      mg.fillRect(0, 0, ns, ns);
      for (let i = 0; i < 8; i++) {
        const cx = (i % 2) * mw,
          cy = ((i / 2) | 0) * mh;
        mg.save();
        mg.beginPath();
        mg.rect(cx, cy, mw, mh);
        mg.clip();
        // the ink itself — same metrics as the albedo pass above
        mg.font = `900 ${mh * 0.52}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        mg.textAlign = 'center';
        mg.textBaseline = 'middle';
        mg.letterSpacing = `${Math.round(mh * 0.035)}px`;
        mg.fillStyle = '#fff';
        mg.fillText(boards[i][2], cx + mw / 2, cy + mh / 2, mw * 0.9);
        // printed keyline frame, also proud
        mg.strokeStyle = '#c8c8c8';
        mg.lineWidth = mh * 0.035;
        mg.strokeRect(cx + mh * 0.018, cy + mh * 0.018, mw - mh * 0.036, mh - mh * 0.036);
        mg.restore();
        // an 8 mm bevel round the board edge: dark ramp in, so the normal turns
        // over at the rim and the low sun catches a line along the whole panel
        const bev = mh * 0.045;
        const grd = mg.createLinearGradient(cx, cy, cx, cy + bev);
        grd.addColorStop(0, '#4a4a4a');
        grd.addColorStop(1, '#000');
        mg.fillStyle = grd;
        mg.fillRect(cx, cy, mw, bev);
        mg.fillStyle = '#2a2a2a';
        mg.fillRect(cx, cy + mh - bev, mw, bev);
        mg.fillRect(cx, cy, bev, mh);
        mg.fillRect(cx + mw - bev, cy, bev, mh);
        // panel screws, one at each corner and two on the centre line
        mg.fillStyle = '#e8e8e8';
        for (const sx of [0.045, 0.5, 0.955])
          for (const sy of [0.11, 0.89]) {
            mg.beginPath();
            mg.arc(cx + mw * sx, cy + mh * sy, mh * 0.022, 0, Math.PI * 2);
            mg.fill();
          }
      }
      const mpx = mg.getImageData(0, 0, ns, ns).data;
      const hf = new Float32Array(ns * ns);
      const rf = new Float32Array(ns * ns);
      for (let y = 0; y < ns; y++)
        for (let x = 0; x < ns; x++) {
          const i = y * ns + x;
          const u = x / ns,
            v = y / ns;
          // patchy fade (hand-sized), plus vertical rain streaking
          const patch = fbm(109, u, v, 14, 14, 2, 0.5, ns);
          const streak = fbm(113, u, v, 26, 3, 2, 0.5, ns);
          // the vinyl's own weave, right at the resolution limit and no finer
          const weave = fbm(127, u, v, 96, 96, 1, 0.5, ns);
          const ink = mpx[i * 4] / 255;
          // Relief: the weathering substrate, plus the ink standing proud of it.
          hf[i] = patch * 0.34 + streak * 0.18 + weave * 0.09 + ink * 0.62;
          // MATTE INK ON A VARNISHED FIELD. This is the whole point: two
          // surface responses per sign, which §4 asks for and one roughness
          // value can never give.
          const base = lerp(0.35, 0.72, ink);
          // Ink chips off at the edges of a weathered board, so where the fade
          // patch is worst the ink's own roughness creeps back toward the field.
          rf[i] = clamp(base + patch * 0.16 + streak * 0.10 + weave * 0.04, 0.1, 0.95);
        }
      void mc;
      return {
        map: finish(c, true, this.aniso, false),
        // 2.2 -> 3.4. The substrate is still flat printed vinyl, but the ink and
        // the bevel are real relief now and they are low frequency, so raising
        // this sharpens the letterform without reintroducing the high-frequency
        // shimmer the old value was pulled down to avoid.
        normalMap: normalFromHeight(hf, ns, 3.4, this.aniso),
        roughnessMap: greyFromField(rf, ns, this.aniso),
      };
    });
  }

  /** Palm / pine bark: stacked leaf-scar rings for palms, plated for pines. */
  bark(kind: 'palm' | 'pine' = 'palm', size = 512): MatMaps {
    return this.memo('bark' + kind, () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const palm = kind === 'palm';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          let hh: number, tone: number;
          if (palm) {
            // ------------------------------------------------------------
            // THE BARCODE. Round 1's trunk read as a high-contrast black/tan
            // stripe pattern that moiréd down its own length, and there were
            // two separate causes:
            //
            //  · `fibre` ran at 192 cycles across a 512 map — 2.7 px per cycle,
            //    three octaves deep. See the note on `fbm`. In a normal map at
            //    strength 30 that is a per-texel scintillation, and it is what
            //    turned a scar pattern into a barcode.
            //  · the ring family was a single INTEGER-period sawtooth, so every
            //    scar course lined up perfectly with every other one. §4 asks
            //    for a second octave at a non-integer scale precisely to stop
            //    that; the ring here now carries a 7.3-per-tile drift and a
            //    per-course phase wobble, so no two courses register.
            //
            // Contrast is also down (scar 0.9 -> 0.55 in height, 0.3 -> 0.18 in
            // tone): a palm's leaf scars are a soft relief, not an engraving,
            // and the old amplitude is what made the pattern shout at range.
            const drift = Math.sin(v * 6.283 * 7.3 + 1.1) * 0.09 + Math.sin(u * 6.283 * 3.0) * 0.14;
            const ring = Math.abs(((v * 22 + drift) % 1) - 0.5) * 2;
            const stagger = Math.abs(((u * 11 + Math.floor(v * 22) * 0.5 + Math.sin(v * 17.0) * 0.16) % 1) - 0.5) * 2;
            const scar = smoothstep(0.75, 0.26, ring) * smoothstep(0.85, 0.32, stagger);
            const fibre = fbm(113, u, v, 34, 96, 2, 0.5, size);
            hh = scar * 0.55 - 0.24 + fibre * 0.24;
            tone = 0.56 + scar * 0.18 + fibre * 0.14;
          } else {
            // pine: irregular plates with deep fissures
            const plate = fbm(127, u, v, 14, 20, 3);
            const fissure = smoothstep(0.06, -0.02, Math.abs(plate));
            const grain = fbm(131, u, v, 192, 40, 3);
            hh = (1 - fissure) * 0.8 - 0.4 + grain * 0.35;
            tone = 0.44 + (1 - fissure) * 0.34 + grain * 0.2;
          }
          const moss = clamp(fbm(137, u, v, 10, 10, 2) * 2.0 - 0.5, 0, 1) * 0.4;
          h[i] = hh;
          const o = i * 4;
          d[o] = clamp(lerp(tone * (palm ? 0.72 : 0.58), 0.28, moss), 0, 1) * 255;
          d[o + 1] = clamp(lerp(tone * (palm ? 0.62 : 0.45), 0.34, moss), 0, 1) * 255;
          d[o + 2] = clamp(lerp(tone * (palm ? 0.46 : 0.36), 0.22, moss), 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.74 + Math.abs(hh) * 0.16 + moss * 0.1;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        // Palm 30 -> 18: the scar relief is now half the amplitude it was, and
        // a normal strength tuned against the old height field turned what is
        // left into contrast the geometry does not have.
        normalMap: normalFromHeight(h, size, palm ? 18 : 38, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** Radial soft blob for prop contact shadows. */
  contactShadow(size = 256): THREE.Texture {
    const key = '__cs';
    const cached = (this as any)[key];
    if (cached) return cached;
    const [c, g] = cv(size);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.82)');
    grad.addColorStop(0.78, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // break the perfect circle so it doesn't read as a decal stamp
    g.globalCompositeOperation = 'destination-out';
    const rng = mulberry32(31337);
    for (let i = 0; i < 26; i++) {
      const a = rng() * 7,
        r = size * (0.32 + rng() * 0.2);
      g.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.25})`;
      g.beginPath();
      g.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, size * (0.06 + rng() * 0.1), 0, 7);
      g.fill();
    }
    const t = finish(c, false, 1, false);
    (this as any)[key] = t;
    return t;
  }

  /**
   * Verge transition strip: the scuffed dirt/gravel band where a kerb meets
   * grass. Grass butting straight against tarmac on a razor line is one of the
   * loudest "generated" tells in a road scene, and the fix is not a shader —
   * it is the metre of trodden dirt that exists at the edge of every real
   * road. U runs ACROSS the strip (0 = kerb side, 1 = grass side); V runs
   * along the road, and carries the ragged edge so the band never reads as a
   * ruled offset of the kerb.
   */
  vergeScuff(size = 512): MatMaps {
    return this.memo('vergescuff', () => {
      const [c, g] = cv(size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          // Ragged inner/outer edges: two independent 1-D fields along the road.
          const edge = fbm(41, v, 0.5, 24, 1, 3) * 0.5 + 0.5;
          const grit = fbm(59, u, v, 96, 96, 4) * 0.5 + 0.5;
          const patch = fbm(73, u, v, 6, 14, 2) * 0.5 + 0.5;
          // Solid for the first ~20 cm-equivalent, gone by the outer lip, with
          // the falloff position wandering along the road.
          const reach = 0.34 + edge * 0.5;
          let a = 1 - smoothstep(reach * 0.35, reach, u);
          // gravel spatter beyond the solid band, so the outer edge dissolves
          a = Math.max(a, smoothstep(0.62, 0.86, grit) * (1 - smoothstep(reach, 1.0, u)) * 0.85);
          a *= 0.55 + patch * 0.65;
          // Warm road grit near the kerb, drier pale dust further out.
          const tone = 0.62 + grit * 0.3 + patch * 0.12;
          const dry = smoothstep(0.1, 0.8, u);
          const o = i * 4;
          d[o] = clamp(tone * lerp(0.80, 1.0, dry), 0, 1) * 255;
          d[o + 1] = clamp(tone * lerp(0.70, 0.93, dry), 0, 1) * 255;
          d[o + 2] = clamp(tone * lerp(0.58, 0.80, dry), 0, 1) * 255;
          d[o + 3] = clamp(a, 0, 1) * 255;
          h[i] = grit * 0.7 + patch * 0.3;
          r[i] = 0.82 + grit * 0.14;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        // Clamped, not repeated: the quad's UVs are exactly 0..1, and with
        // RepeatWrapping the coarse mips bleed the opaque kerb-side column into
        // the transparent outer edge, which puts a hard band along the band.
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(h, size, 3.2, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- foliage alpha sheets -------------------------------------------------

  /** A single pinnate palm frond, rachis running along +U. */
  palmFrond(size = 512): THREE.Texture {
    return this.alpha('frond', size, (g, s) => {
      const rng = mulberry32(606);
      const midY = s * 0.5;
      // leaflets
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 46; i++) {
          const t = i / 46;
          const x = s * (0.06 + t * 0.9);
          const len = s * 0.44 * Math.sin(Math.pow(t, 0.55) * Math.PI) * (0.82 + rng() * 0.36);
          const droop = Math.pow(t, 1.6) * s * 0.06;
          const ang = side * (0.42 + t * 0.5) + (rng() - 0.5) * 0.18;
          const g0 = 0.22 + t * 0.16 + rng() * 0.08;
          g.strokeStyle = `rgb(${(70 + g0 * 120) | 0},${(120 + g0 * 190) | 0},${(46 + g0 * 70) | 0})`;
          g.lineWidth = s * 0.017 * (0.7 + rng() * 0.6);
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(x, midY + droop);
          g.quadraticCurveTo(x + Math.cos(ang) * len * 0.5 + len * 0.25, midY + droop + Math.sin(ang) * len * 0.45, x + Math.cos(ang) * len * 0.4 + len * 0.5, midY + droop + Math.sin(ang) * len);
          g.stroke();
        }
      }
      // rachis
      const grad = g.createLinearGradient(0, 0, s, 0);
      grad.addColorStop(0, '#7a6a3a');
      grad.addColorStop(0.5, '#8fa348');
      grad.addColorStop(1, '#c8cf72');
      g.strokeStyle = grad;
      g.lineWidth = s * 0.022;
      g.beginPath();
      g.moveTo(s * 0.02, midY);
      g.quadraticCurveTo(s * 0.5, midY + s * 0.02, s * 0.99, midY + s * 0.06);
      g.stroke();
      void rng;
    }, 0.38);
  }

  /** Umbrella-pine needle cluster. */
  pineCluster(size = 512): THREE.Texture {
    return this.alpha('pine', size, (g, s) => {
      const rng = mulberry32(808);
      for (let i = 0; i < 260; i++) {
        const cx = s * (0.08 + rng() * 0.84);
        const cy = s * (0.12 + rng() * 0.76);
        const spread = s * (0.05 + rng() * 0.1);
        const base = 0.3 + rng() * 0.6;
        g.strokeStyle = `rgb(${(38 + base * 60) | 0},${(78 + base * 105) | 0},${(40 + base * 46) | 0})`;
        g.lineWidth = s * 0.006;
        for (let k = 0; k < 9; k++) {
          const a = rng() * Math.PI * 2;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(cx + Math.cos(a) * spread, cy + Math.sin(a) * spread);
          g.stroke();
        }
      }
    }, 0.42);
  }

  /** Broadleaf shrub / hedge mass. */
  shrubLeaves(size = 512): THREE.Texture {
    return this.alpha('shrub', size, (g, s) => {
      const rng = mulberry32(1212);
      for (let i = 0; i < 340; i++) {
        const cx = s * (0.06 + rng() * 0.88);
        const cy = s * (0.08 + rng() * 0.88);
        const rr = s * (0.018 + rng() * 0.034);
        const edge = 1 - Math.max(Math.abs(cx / s - 0.5), Math.abs(cy / s - 0.5)) * 2;
        if (rng() > edge * 1.5 + 0.25) continue;
        const base = 0.25 + rng() * 0.75;
        g.fillStyle = `rgb(${(46 + base * 78) | 0},${(84 + base * 106) | 0},${(38 + base * 52) | 0})`;
        g.save();
        g.translate(cx, cy);
        g.rotate(rng() * 7);
        g.beginPath();
        g.ellipse(0, 0, rr * 1.5, rr, 0, 0, 7);
        g.fill();
        g.restore();
      }
    }, 0.44);
  }

  /**
   * Tuft of grass blades, rooted at the bottom edge.
   *
   * Drawn per blade in three passes — root, mid, tip — so a blade darkens at
   * the base (#4e7534, where a clump self-shadows) and bleaches toward the tip
   * (#87b356 fresh / #9aa858 dry). One flat green stroke per blade is what made
   * the round-1 verge read as astroturf: real grass has its whole value range
   * inside a single blade, not just between clumps.
   */
  grassBlades(size = 512): THREE.Texture {
    return this.alpha('grass', size, (g, s) => {
      const rng = mulberry32(2424);
      g.lineCap = 'round';
      const blades = 44;
      for (let i = 0; i < blades; i++) {
        const x = s * (0.05 + rng() * 0.9);
        const hgt = s * (0.42 + rng() * 0.56);
        const bend = (rng() - 0.5) * s * 0.46;
        const dry = rng() < 0.28;
        const lw = s * (0.011 + rng() * 0.011);
        // three tapering segments, each a shade lighter than the last
        const segs = 3;
        for (let k = 0; k < segs; k++) {
          const t0 = k / segs;
          const t1 = (k + 1) / segs;
          const p = (u: number): [number, number] => [x + bend * u * u, s - hgt * u];
          const [x0, y0] = p(t0);
          const [x1, y1] = p(t1);
          const sh = t0 * 0.85 + rng() * 0.15;
          const r = dry ? 118 + sh * 46 : 66 + sh * 66;
          const gr = dry ? 130 + sh * 46 : 108 + sh * 71;
          const bl = dry ? 62 + sh * 34 : 44 + sh * 42;
          g.strokeStyle = `rgb(${r | 0},${gr | 0},${bl | 0})`;
          g.lineWidth = lw * (1.25 - t0 * 0.75);
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
          g.stroke();
        }
      }
    }, 0.34);
  }

  /** Geranium / bougainvillea blossom cluster for window boxes. */
  flowers(size = 256): THREE.Texture {
    return this.alpha('flowers', size, (g, s) => {
      const rng = mulberry32(3636);
      const cols = ['#e0453f', '#ff6f8a', '#dcb8d8', '#f5e2b0', '#f2ece0', '#ff9d2e'];
      for (let i = 0; i < 90; i++) {
        const cx = s * (0.1 + rng() * 0.8);
        const cy = s * (0.12 + rng() * 0.76);
        const rr = s * (0.02 + rng() * 0.03);
        g.fillStyle = rng() < 0.42 ? `rgb(${(52 + rng() * 40) | 0},${(104 + rng() * 50) | 0},${(44 + rng() * 26) | 0})` : cols[(rng() * cols.length) | 0];
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2 + rng();
          g.beginPath();
          g.arc(cx + Math.cos(a) * rr * 0.8, cy + Math.sin(a) * rr * 0.8, rr * 0.72, 0, 7);
          g.fill();
        }
      }
    }, 0.40);
  }

  /**
   * Opaque needle surface for the cypress spindle. It has to be opaque: the
   * cypress is a solid form, and wrapping it in a cut-out leaf sheet would
   * either punch holes into a hollow interior or (with alphaTest off) paint it
   * with the transparent canvas's black.
   */
  needleSurface(size = 512): MatMaps {
    return this.memo('needle', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          // Sprays: fine vertical streaks broken by clumps. `res` is passed so
          // the Nyquist guard measures against THIS map's 512, not the 1024
          // default — grid.png's cypresses sparkled, and a needle texture whose
          // top octave runs at two texels per cycle is what sparkling is.
          const spray = fbm(211, u, v, 96, 22, 4, 0.5, size);
          const clump = fbm(223, u, v, 14, 10, 3, 0.5, size);
          const shade = 0.5 + spray * 0.32 + clump * 0.28;
          h[i] = spray * 0.75 + clump * 0.4;
          const dark = clamp(shade, 0, 1);
          const o = i * 4;
          d[o] = (0.10 + dark * 0.20) * 255;
          d[o + 1] = (0.17 + dark * 0.34) * 255;
          d[o + 2] = (0.08 + dark * 0.16) * 255;
          d[o + 3] = 255;
          r[i] = 0.72 + Math.abs(spray) * 0.2 + clump * 0.08;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        // 26 -> 15: a cypress is a mass of needles, not a rock face, and a
        // normal this strong on a spindle whose whole job is silhouette is a
        // specular crawl generator at any distance past 20 m.
        normalMap: normalFromHeight(h, size, 15, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** Knotted fishing net — a diamond weave with slack, frayed strands. */
  netWeave(size = 256): THREE.Texture {
    return this.alpha('net', size, (g, s) => {
      const rng = mulberry32(1717);
      g.strokeStyle = '#cbb894';
      g.lineCap = 'round';
      for (let k = 0; k < 2; k++) {
        const dir = k ? 1 : -1;
        for (let i = -8; i < 16; i++) {
          g.lineWidth = s * (0.008 + rng() * 0.006);
          g.beginPath();
          const x0 = (i / 8) * s;
          g.moveTo(x0, 0);
          for (let y = 0; y <= 8; y++) {
            const t = y / 8;
            g.lineTo(x0 + dir * t * s + Math.sin(t * 9 + i) * s * 0.012, t * s);
          }
          g.stroke();
        }
      }
      // knots
      g.fillStyle = '#b8a480';
      for (let i = 0; i < 130; i++) {
        const x = ((rng() * 8) | 0) * (s / 8) + (rng() - 0.5) * 3;
        const y = ((rng() * 8) | 0) * (s / 8) + (rng() - 0.5) * 3;
        g.beginPath();
        g.arc(x, y, s * 0.012, 0, 7);
        g.fill();
      }
    }, 0.35);
  }

  /** Laundry: shirts and sheets on a line, as an alpha strip of 4 cells. */
  laundry(size = 512): THREE.Texture {
    return this.alpha('laundry', size, (g, s) => {
      const cell = s / 4;
      const cols = ['#f2ece0', '#a9c8d4', '#e8a5a0', '#f5e2b0'];
      for (let i = 0; i < 4; i++) {
        const x0 = i * cell;
        g.fillStyle = cols[i];
        g.save();
        g.translate(x0 + cell * 0.5, 0);
        if (i === 0 || i === 2) {
          // shirt
          g.beginPath();
          g.moveTo(-cell * 0.3, cell * 0.06);
          g.lineTo(-cell * 0.42, cell * 0.3);
          g.lineTo(-cell * 0.28, cell * 0.36);
          g.lineTo(-cell * 0.26, s * 0.88);
          g.lineTo(cell * 0.26, s * 0.88);
          g.lineTo(cell * 0.28, cell * 0.36);
          g.lineTo(cell * 0.42, cell * 0.3);
          g.lineTo(cell * 0.3, cell * 0.06);
          g.closePath();
          g.fill();
        } else {
          // sheet / towel with a soft wavy hem
          g.beginPath();
          g.moveTo(-cell * 0.4, cell * 0.04);
          g.lineTo(cell * 0.4, cell * 0.04);
          g.lineTo(cell * 0.36, s * 0.9);
          for (let k = 1; k >= 0; k -= 0.1) g.lineTo(-cell * 0.4 + k * cell * 0.76, s * (0.9 + Math.sin(k * 9) * 0.02));
          g.closePath();
          g.fill();
        }
        g.restore();
        // shading so it isn't a flat silhouette
        const grad = g.createLinearGradient(x0, 0, x0 + cell, 0);
        grad.addColorStop(0, 'rgba(40,30,25,0.30)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.12)');
        grad.addColorStop(1, 'rgba(40,30,25,0.24)');
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = grad;
        g.fillRect(x0, 0, cell, s);
        g.globalCompositeOperation = 'source-over';
      }
    }, 0.45);
  }

  private alphaCache = new Map<string, THREE.Texture>();
  /**
   * `ref` is the alphaTest the material will use; the mip chain is built to
   * preserve coverage at exactly that threshold. Pass the real value or fronds
   * will still thin out at range.
   */
  private alpha(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, ref = 0.4): THREE.Texture {
    let t = this.alphaCache.get(key);
    if (t) return t;
    const [c, g] = cv(size);
    g.clearRect(0, 0, size, size);
    draw(g, size);
    const src = g.getImageData(0, 0, size, size).data;
    // A DataTexture uploads with flipY = false, so the rows are flipped here to
    // keep the canvas's top-left origin pointing the same way it always did.
    const px = new Uint8Array(size * size * 4);
    const row = size * 4;
    for (let y = 0; y < size; y++) px.set(src.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    dilateRGB(px, size);
    const mips = coverageMips(px, size, ref);
    const tex = new THREE.DataTexture(mips[0].data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.mipmaps = mips as unknown as THREE.Texture['mipmaps'];
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.aniso;
    tex.flipY = false;
    tex.needsUpdate = true;
    this.alphaCache.set(key, tex);
    return tex;
  }
}

// ---------------------------------------------------------------------------
// Geometry construction
// ---------------------------------------------------------------------------

/**
 * Box with flat chamfers on every edge and corner. Hard 90° edges catch no
 * specular and are the second-biggest amateur tell (§5) — this is what the
 * entire built world is made from.
 * UVs are planar per dominant axis so a single tiling texture never stretches.
 */
export function bevelBox(w: number, h: number, d: number, c = 0.035, uvScale = 1): THREE.BufferGeometry {
  const hx = w / 2,
    hy = h / 2,
    hz = d / 2;
  c = Math.min(c, hx * 0.45, hy * 0.45, hz * 0.45);
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const corner = (sx: number, sy: number, sz: number, axis: number) => {
    const x = sx * (axis === 0 ? hx : hx - c);
    const y = sy * (axis === 1 ? hy : hy - c);
    const z = sz * (axis === 2 ? hz : hz - c);
    return [x, y, z] as [number, number, number];
  };
  const tri = (a: number[], b: number[], cc: number[]) => {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = cc[0] - a[0],
      vy = cc[1] - a[1],
      vz = cc[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    // The box is convex and centred on the origin, so "outward" is simply the
    // face centroid direction. Self-orienting here beats hand-deriving the
    // winding for twelve edge quads and eight corner triangles.
    if (nx * (a[0] + b[0] + cc[0]) + ny * (a[1] + b[1] + cc[1]) + nz * (a[2] + b[2] + cc[2]) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      const t = b;
      b = cc;
      cc = t;
    }
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    for (const p of [a, b, cc]) {
      P.push(p[0], p[1], p[2]);
      N.push(nx, ny, nz);
      if (ax >= ay && ax >= az) U.push(p[2] * uvScale, p[1] * uvScale);
      else if (ay >= az) U.push(p[0] * uvScale, p[2] * uvScale);
      else U.push(p[0] * uvScale, p[1] * uvScale);
    }
  };
  const quad = (a: number[], b: number[], cc: number[], dd: number[]) => {
    tri(a, b, cc);
    tri(a, cc, dd);
  };
  // 6 faces
  for (let axis = 0; axis < 3; axis++) {
    for (let s = -1; s <= 1; s += 2) {
      const pts: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const a = i === 0 || i === 3 ? -1 : 1;
        const b = i < 2 ? -1 : 1;
        pts.push(axis === 0 ? corner(s, a * s, b, 0) : axis === 1 ? corner(a, s, b * s, 1) : corner(a * s, b, s, 2));
      }
      quad(pts[0], pts[1], pts[2], pts[3]);
    }
  }
  // 12 edge quads + 8 corner triangles
  for (const [a1, a2] of [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as [number, number][]) {
    const a3 = 3 - a1 - a2;
    for (let s1 = -1; s1 <= 1; s1 += 2)
      for (let s2 = -1; s2 <= 1; s2 += 2) {
        const mk = (s3: number, axis: number) => {
          const s = [0, 0, 0];
          s[a1] = s1;
          s[a2] = s2;
          s[a3] = s3;
          return corner(s[0], s[1], s[2], axis);
        };
        const p0 = mk(-1, a1),
          p1 = mk(-1, a2),
          p2 = mk(1, a2),
          p3 = mk(1, a1);
        // winding depends on the sign product so normals always face out
        if (s1 * s2 * (a1 === 0 && a2 === 1 ? 1 : a1 === 1 && a2 === 2 ? 1 : -1) > 0) quad(p0, p1, p2, p3);
        else quad(p3, p2, p1, p0);
      }
  }
  for (let sx = -1; sx <= 1; sx += 2)
    for (let sy = -1; sy <= 1; sy += 2)
      for (let sz = -1; sz <= 1; sz += 2) {
        const px = corner(sx, sy, sz, 0),
          py = corner(sx, sy, sz, 1),
          pz = corner(sx, sy, sz, 2);
        if (sx * sy * sz > 0) tri(px, py, pz);
        else tri(px, pz, py);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return g;
}

/**
 * Unchamfered 12-triangle box with the same planar UV convention as
 * `bevelBox`. Reserved for parts small enough that a chamfer cannot be
 * resolved on screen — shutter louvres, balusters, tyre tread — where paying
 * 52 triangles times a thousand instances buys nothing.
 */
export function plainBox(w: number, h: number, d: number, uvScale = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)),
      ny = Math.abs(nor.getY(i));
    const px = pos.getX(i),
      py = pos.getY(i),
      pz = pos.getZ(i);
    if (nx > 0.5) uv.setXY(i, pz * uvScale, py * uvScale);
    else if (ny > 0.5) uv.setXY(i, px * uvScale, pz * uvScale);
    else uv.setXY(i, px * uvScale, py * uvScale);
  }
  uv.needsUpdate = true;
  return g;
}

export interface Opening {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A facade panel in local XY (outward face at z=0, wall thickness toward -z)
 * with real cut openings and real reveals — windows in this game are recessed
 * geometry, not painted rectangles.
 */
export function wallWithOpenings(w: number, h: number, openings: Opening[], depth = 0.20, uvScale = 0.5): THREE.BufferGeometry {
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const C: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c = 1) => {
    P.push(x, y, z);
    N.push(nx, ny, nz);
    U.push(u, v);
    C.push(c, c, c);
  };
  const quad = (pts: number[][], n: number[], uvs: number[][], cols?: number[]) => {
    for (const i of [0, 1, 2, 0, 2, 3]) push(pts[i][0], pts[i][1], pts[i][2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], cols ? cols[i] : 1);
  };
  // Occlusion baked into the reveal: a 22 cm recess only reads at 40 m if the
  // returns are visibly darker than the face. Head darkest, then the jambs,
  // with the sill catching the low sun.
  const AO_FACE = 1.0;
  const AO_JAMB_LIP = 0.78;
  const AO_JAMB_BACK = 0.34;
  const AO_HEAD_LIP = 0.55;
  const AO_HEAD_BACK = 0.20;
  const AO_SILL_LIP = 0.98;
  const AO_SILL_BACK = 0.62;
  // Grid lines from every opening edge, so the front face tessellates into
  // cells that are either fully solid or fully hole.
  const xs = new Set<number>([0, w]);
  const ys = new Set<number>([0, h]);
  for (const o of openings) {
    xs.add(clamp(o.x, 0, w));
    xs.add(clamp(o.x + o.w, 0, w));
    ys.add(clamp(o.y, 0, h));
    ys.add(clamp(o.y + o.h, 0, h));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  for (let i = 0; i < X.length - 1; i++) {
    for (let j = 0; j < Y.length - 1; j++) {
      const x0 = X[i],
        x1 = X[i + 1],
        y0 = Y[j],
        y1 = Y[j + 1];
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      if (openings.some((o) => cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h)) continue;
      if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) continue;
      quad(
        [
          [x0, y0, 0],
          [x1, y0, 0],
          [x1, y1, 0],
          [x0, y1, 0],
        ],
        [0, 0, 1],
        [
          [x0 * uvScale, y0 * uvScale],
          [x1 * uvScale, y0 * uvScale],
          [x1 * uvScale, y1 * uvScale],
          [x0 * uvScale, y1 * uvScale],
        ]
      );
    }
  }
  // Reveals: four inward-facing strips per opening.
  for (const o of openings) {
    const x0 = o.x,
      x1 = o.x + o.w,
      y0 = o.y,
      y1 = o.y + o.h,
      z = -depth;
    // left (+x normal), right (-x), bottom/sill (+y), head (-y)
    quad(
      [
        [x0, y0, 0],
        [x0, y0, z],
        [x0, y1, z],
        [x0, y1, 0],
      ],
      [1, 0, 0],
      [
        [y0 * uvScale, 0],
        [y0 * uvScale, depth * uvScale],
        [y1 * uvScale, depth * uvScale],
        [y1 * uvScale, 0],
      ],
      [AO_JAMB_LIP, AO_JAMB_BACK, AO_JAMB_BACK * 0.75, AO_JAMB_LIP * 0.8]
    );
    quad(
      [
        [x1, y1, 0],
        [x1, y1, z],
        [x1, y0, z],
        [x1, y0, 0],
      ],
      [-1, 0, 0],
      [
        [y1 * uvScale, 0],
        [y1 * uvScale, depth * uvScale],
        [y0 * uvScale, depth * uvScale],
        [y0 * uvScale, 0],
      ],
      [AO_JAMB_LIP * 0.8, AO_JAMB_BACK * 0.75, AO_JAMB_BACK, AO_JAMB_LIP]
    );
    quad(
      [
        [x1, y0, 0],
        [x1, y0, z],
        [x0, y0, z],
        [x0, y0, 0],
      ],
      [0, 1, 0],
      [
        [x1 * uvScale, 0],
        [x1 * uvScale, depth * uvScale],
        [x0 * uvScale, depth * uvScale],
        [x0 * uvScale, 0],
      ],
      [AO_SILL_LIP, AO_SILL_BACK, AO_SILL_BACK, AO_SILL_LIP]
    );
    quad(
      [
        [x0, y1, 0],
        [x0, y1, z],
        [x1, y1, z],
        [x1, y1, 0],
      ],
      [0, -1, 0],
      [
        [x0 * uvScale, 0],
        [x0 * uvScale, depth * uvScale],
        [x1 * uvScale, depth * uvScale],
        [x1 * uvScale, 0],
      ],
      [AO_HEAD_LIP, AO_HEAD_BACK, AO_HEAD_BACK, AO_HEAD_LIP]
    );
  }
  void AO_FACE;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}

/**
 * Lofts a closed cross-section along a path. Used for palm trunks, boat hulls,
 * mooring ropes and the lighthouse. `radius(t, i)` lets a cross-section breathe
 * along the run so nothing is a plain cylinder.
 */
export function loft(
  path: (t: number, out: THREE.Vector3) => void,
  rings: number,
  sides: number,
  radius: (t: number, ang: number) => number,
  uvRepeat = 1,
  capStart = false,
  capEnd = false
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3(),
    pPrev = new THREE.Vector3(),
    tan = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const nrmA = new THREE.Vector3(),
    nrmB = new THREE.Vector3();
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    path(t, p);
    path(Math.min(1, t + 1e-3), pPrev);
    tan.subVectors(pPrev, p);
    if (tan.lengthSq() < 1e-9) {
      path(Math.max(0, t - 1e-3), pPrev);
      tan.subVectors(p, pPrev);
    }
    tan.normalize();
    nrmA.copy(Math.abs(tan.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).cross(tan).normalize();
    nrmB.crossVectors(tan, nrmA).normalize();
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const rr = radius(t, a);
      pos.push(p.x + (nrmA.x * Math.cos(a) + nrmB.x * Math.sin(a)) * rr, p.y + (nrmA.y * Math.cos(a) + nrmB.y * Math.sin(a)) * rr, p.z + (nrmA.z * Math.cos(a) + nrmB.z * Math.sin(a)) * rr);
      uv.push((s / sides) * uvRepeat, t * uvRepeat);
    }
  }
  const stride = sides + 1;
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sides; s++) {
      // Wound so the surface normal points away from the path — otherwise
      // every trunk, hull and tower in the game renders inside-out.
      const a = r * stride + s,
        b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const capOf = (ring: number, flip: boolean) => {
    const base = pos.length / 3;
    path(ring === 0 ? 0 : 1, p);
    pos.push(p.x, p.y, p.z);
    uv.push(0.5, 0.5);
    const off = ring * stride;
    for (let s = 0; s < sides; s++) {
      const a = off + s,
        b = off + s + 1;
      if (flip) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  };
  if (capStart) capOf(0, true);
  if (capEnd) capOf(rings, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Landforms — the distant terrain
// ---------------------------------------------------------------------------
//
// `landmassGeo` (further down, kept for the small offshore rock stacks) makes a
// dome: one radius wobble, one height power curve. At 20 m it is a boulder and
// it reads. At 600 m, scaled up to a headland, it is a cardboard cut-out with
// visible facets and no silhouette information at all — which is exactly what
// three rounds of critique kept calling "flat, untextured, faceted cardboard".
//
// A real ridgeline is not a dome. It is a CREST LINE with summits and saddles
// along it, flanks that fall away at different angles on each side, spurs
// running down toward the viewer, and ends that dive into whatever is next to
// it — the sea, or the next ridge back. So these two generators build the crest
// line first and hang the surface off it.
//
// Both bake their own vertex colours (`GeoAccum` multiplies them by the tint the
// caller passes) carrying three things the material cannot know:
//   · macro strata — horizontal banding whose spacing scales with the landform,
//     because that is the read that says "rock" at a kilometre;
//   · a foot-to-crest gradient, because haze pools in valleys and summits catch
//     the light: this is aerial perspective WITHIN one landform, and it is the
//     difference between a ridge and a paper cut-out;
//   · toe darkening where one flank meets the water or the layer behind it.

export interface RidgeOpts {
  /** run of the crest line along local X, metres */
  length: number;
  /** depth across local Z, metres */
  depth: number;
  /** crest height above local y = 0, metres */
  height: number;
  seed: number;
  /** samples along the crest */
  segs?: number;
  /** samples across the flanks */
  rings?: number;
  /** 0.4 = rolling downs, 1.6 = alpine */
  jag?: number;
  /** 0 = both ends dive to the base (a headland into the sea), 1 = ends stay up */
  shoulder?: number;
  /** metres the toe ring is pushed below y = 0 so no waterline rim can show */
  skirt?: number;
  /** metres of world one uv tile covers */
  uvScale?: number;
  /** strata band spacing in metres; 0 disables */
  strata?: number;
  /** vertex tint at the crest and at the toe (the aerial gradient) */
  crestTint?: THREE.Color;
  footTint?: THREE.Color;
  /**
   * Yaw the sun sits at, in the ridge's LOCAL frame (0 = local +Z, the front
   * flank). Columns whose local slope faces it get a warm rim along the crest —
   * "a rim of warm sun-catch along the sun-facing ridge". Omit to disable.
   */
  sunLocal?: number;
  /**
   * Vegetation/scrub key, mixed into the flank at 40–120 m feature size. This
   * is the cheap answer to "an untextured orange silhouette with no vegetation
   * stippling and no rock": low-frequency albedo patchwork only, no normal, and
   * it costs nothing because it rides the vertex colour that is already there.
   */
  scrubTint?: THREE.Color;
  /**
   * Filled with the crest line as local x,y,z triples, one per column. Anything
   * standing ON the ridge — a cypress line, a hill town, a switchback road —
   * has to know where the crest actually is, or it floats above a saddle and
   * sinks into a summit. This is that contract.
   */
  crestOut?: number[];
  /**
   * Filled with the ridge's whole surface, so anything that has to LIE ON a
   * flank — a terrace ledge, a switchback road — can read real vertices.
   * See `RidgeFlank` and `ridgeContour`.
   */
  flankOut?: RidgeFlank;
}

/**
 * The ridge's surface as a grid, in the ridge's own local space.
 *
 * This replaces a bisection of the ANALYTIC cross-section, which is the shape
 * BEFORE the per-column `lean` (±0.22 of the depth, so the crest is not a ruled
 * line), before the spur displacement in Z and before the gullies. Placing
 * anything by that inverse missed the real surface by 24–35 m, measured as
 * point-to-triangle distance over twenty seeds — a terrace ledge hanging in
 * mid-air in front of the hillside, or buried inside it. Both are worse than no
 * terrace at all, because a straight horizontal line is exactly what the eye
 * picks out at that distance.
 *
 * So the generator hands its vertices back and consumers interpolate them.
 */
export interface RidgeFlank {
  /** columns along the crest = segs + 1 */
  cols: number;
  /** rows across the flanks = rings + 1 */
  rings: number;
  /** (ring * cols + col) * 3 -> x, y, z */
  p: Float32Array;
}

const _lc = new THREE.Color();

/**
 * 1-D fBm along a ridge axis, returned signed in about -1..1.
 *
 * `t` is in WAVELENGTHS, not metres, so the caller states the feature size it
 * wants and the octave stack cannot secretly run off the end of the sampling
 * rate. That distinction is the whole reason this exists: see `ridgeGeo`.
 */
function fbm1(n: (x: number, y: number) => number, t: number, y: number, oct: number): number {
  let acc = 0,
    amp = 1,
    tot = 0,
    f = 1;
  for (let k = 0; k < oct; k++) {
    acc += n(t * f + k * 19.73, y + k * 7.31) * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return acc / tot;
}

/** 1-D ridged noise in 0..1 with the same wavelength contract as `fbm1`. */
function ridged1(n: (x: number, y: number) => number, t: number, y: number, oct: number): number {
  let acc = 0,
    amp = 1,
    tot = 0,
    f = 1;
  for (let k = 0; k < oct; k++) {
    const s = 1 - Math.abs(n(t * f + k * 11.29, y + k * 5.17));
    acc += s * s * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return acc / tot;
}

/**
 * A ridge: a crest line running along local X, flanks falling away in ±Z.
 *
 * Placed tangentially on a ring around the circuit, a handful of these at each
 * of four distances is the whole background. Two facts make that cheap: the
 * crest profile is 1-D so summits and saddles cost one noise lookup per column,
 * and every ridge lands in the same merged mesh, so the entire horizon — four
 * layers, ~70 k triangles — is one draw call.
 */
export function ridgeGeo(o: RidgeOpts): THREE.BufferGeometry {
  const segs = Math.max(8, o.segs ?? 56);
  const rings = Math.max(4, o.rings ?? 10);
  const jag = o.jag ?? 1;
  const shoulder = clamp(o.shoulder ?? 0.25, 0, 1);
  const skirt = o.skirt ?? o.height * 0.3 + 26;
  const uvS = o.uvScale ?? Math.max(10, o.height * 0.2);
  const strata = o.strata ?? Math.max(5, o.height * 0.07);
  const rng = mulberry32(o.seed);
  const n = createNoise2D(rng);
  const crestC = o.crestTint ?? _lc.setRGB(1.06, 1.02, 0.94).clone();
  const footC = o.footTint ?? _lc.setRGB(0.7, 0.74, 0.82).clone();

  // --- 0. this landform's character ----------------------------------------
  // Drawn ONCE per ridge, before anything is built, so two ridges out of the
  // same band are two different landforms rather than two samples of one shape.
  // The band table can only vary height, length and depth; everything that
  // makes a hill look like a particular hill — which way its dip slope runs,
  // how steep its face is, whether it is one massif or three, how craggy its
  // crest is, where the crest sits across the section — is decided here.
  // Without this a ring of ridges reads as one motif repeated, which is half of
  // what "a row of party hats" means: not just the shape, the REPETITION.
  const chDir = rng() < 0.5 ? 1 : -1; // which way the long dip slope runs
  const chMassif = 0.5 + rng() * 0.95; // prominences across the whole run
  const chWarp = 0.22 + rng() * 0.5; // domain warp, in massif wavelengths
  const chBroad = rng(); // plateau-ish (0) vs picked-out summits (1)
  const chTanDip = 0.26 + rng() * 0.20; // dip slope, ~15-25°
  const chTanFace = 0.85 + rng() * 0.95; // steep face, ~40-61°
  const chCrag = 0.22 + rng() * 0.28; // depth of the cols cut into the crest
  const chVC = 0.27 + rng() * 0.18; // crest position across the section
  const chFaceP = 0.68 + rng() * 0.34; // front flank curvature
  const chBackP = 1.12 + rng() * 0.55; // dip slope curvature
  const chSpurF = 5.0 + rng() * 6.0; // spur spacing down the flanks

  // --- 1. the crest line ---------------------------------------------------
  //
  // ROUND 4 ROOT FIX — THE SILHOUETTE.
  //
  // What was here was `pow(ridged(x, f, 4 octaves), 0.85 + jag * 0.75)`, and it
  // is the reason the horizon was a row of paper party hats. Three separate
  // faults, all of them silhouette faults:
  //
  //   · `ridged()` peaks are CUSPS. `1 - |noise|` has a corner at every zero
  //     crossing; squaring it does not remove the corner, it sharpens the
  //     shoulders around it. Every summit was a point by construction.
  //   · the octave stack ran to `f0 * 2.07³`, i.e. a wavelength of ~50 m, while
  //     the far band samples its crest every 37 m. The top two octaves were
  //     below Nyquist: they could not be drawn, only ALIASED, and aliased noise
  //     is a sequence of unrelated one-column spikes. That is literally where
  //     the pickets came from.
  //   · `pow(·, 1.9)` then crushed everything below the summits toward zero, so
  //     each cusp stood alone on a flat base with nothing joining it to its
  //     neighbour. Peak-to-base width ratio of roughly 1 : 1.2 — a traffic cone.
  //
  // The replacement states feature sizes in WAVELENGTHS and refuses to ask for
  // any that the column spacing cannot carry, then builds the profile the way
  // land is actually built: a broad massif envelope, secondary summits riding
  // on it, and an EROSION pass that gives each prominence a steep face on one
  // side and a long shallow dip slope on the other. A mountain seen from 2 km
  // is mostly shoulder; the summit is the last 15% of it.
  const dx = o.length / segs;
  // Wavelength floor: six columns. Nothing shorter is drawable at this
  // tessellation, so nothing shorter is asked for.
  const lamMin = Math.max(dx * 6, o.length * 0.055);
  const lamMassif = o.length / chMassif;
  const lamSub = Math.max(lamMin * 1.6, lamMassif * 0.34);
  const lamCrag = Math.max(lamMin * 1.5, o.length * 0.19);
  const sy = o.seed * 0.017;
  const prof = new Float32Array(segs + 1);
  const lean = new Float32Array(segs + 1); // crest drifts in Z: no ruled lines
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const x = u * o.length;
    // Domain warp along the axis. Massifs stop being evenly spaced and their
    // two flanks stop being mirror images — the cheapest asymmetry there is.
    const xw = x + fbm1(n, x / (lamMassif * 1.7), sy + 3.7, 2) * lamMassif * chWarp;
    // Massif envelope. `smoothstep` rather than a power: a power narrows the
    // peak and widens the foot, which is the cone again; a smoothstep with a
    // low knee widens the HIGH ground and leaves broad basins between.
    let m = 0.5 + 0.5 * fbm1(n, xw / lamMassif, sy + 11.3, 2);
    m = smoothstep(0.20 + chBroad * 0.16, 0.94, m);
    // Secondary summits riding on the massif, never below it.
    const sub = 0.5 + 0.5 * fbm1(n, xw / lamSub, sy + 47.1, 2);
    prof[i] = m * (0.60 + 0.40 * sub);
    lean[i] = fbm1(n, x / (lamMassif * 0.9) + 21.3, sy + 9.9, 2) * 0.26;
  }

  // --- 1b. erosion: asymmetric shoulders -----------------------------------
  // A grayscale dilation by a cone whose two sides have different gradients.
  // Physically this is the talus/scree envelope: no hillside anywhere stands
  // steeper than its own material allows, so every summit drags a shoulder out
  // behind it. Running it at ~20° one way and ~50° the other is what turns a
  // symmetric bump into a landform with a face and a back, and it is also what
  // widens the base — a 600 m summit on a 20° dip slope reaches the plain
  // 1.6 km away, which is the peak-to-base ratio that reads as a MOUNTAIN.
  const dDip = (chTanDip * dx) / Math.max(1, o.height);
  const dFace = (chTanFace * dx) / Math.max(1, o.height);
  const dFwd = chDir > 0 ? dDip : dFace;
  const dBwd = chDir > 0 ? dFace : dDip;
  const dil = new Float32Array(segs + 1);
  let e = prof[0];
  for (let i = 0; i <= segs; i++) {
    e = Math.max(prof[i], e - dFwd);
    dil[i] = e;
  }
  e = prof[segs];
  for (let i = segs; i >= 0; i--) {
    e = Math.max(prof[i], e - dBwd);
    if (e > dil[i]) dil[i] = e;
  }
  // Not all the way to the envelope: the last 22% keeps the saddles honest, so
  // the range is a range and not a mesa.
  for (let i = 0; i <= segs; i++) prof[i] = lerp(prof[i], dil[i], 0.78);

  // --- 1c. cols: erosion cuts DOWN into the crest --------------------------
  // Strictly subtractive, and that is the point. Adding noise to a ridgeline
  // adds summits, and a summit added on top of an envelope is a spike standing
  // on a hill — which is how the first attempt at this turned a row of cones
  // into a row of shark's teeth. Erosion removes material: it opens cols and
  // notches between summits, leaving the survivors as prominences rather than
  // making new ones. Scaled by the local height so the shoulders stay clean.
  for (let i = 0; i <= segs; i++) {
    const x = (i / segs) * o.length;
    const notch = Math.max(0, -fbm1(n, x / lamCrag, sy + 63.4, 2));
    const deep = ridged1(n, x / (lamCrag * 2.3), sy + 88.2, 1);
    prof[i] *= Math.max(0.05, 1 - chCrag * jag * notch * prof[i] * (0.55 + 0.75 * deep));
  }

  // --- 1d. round the summits ------------------------------------------------
  // The dilation in 1b is a cone, so left to itself every local maximum comes
  // out as a perfect triangle: two dead-straight sides meeting at a point. That
  // is a party hat with better proportions, and it was still unmistakable in
  // the frame. A few [1 2 1] passes cost nothing, take the corner off every
  // apex and leave the shoulders — which are long, so smoothing barely touches
  // them — exactly where the erosion pass put them. The pass count is quoted
  // against the column spacing, so a 40 m coastal knoll and a 600 m summit get
  // the same amount of rounding AS A FRACTION OF THEIR OWN SIZE.
  const sm = new Float32Array(segs + 1);
  const smPasses = clamp(Math.round(lamCrag / dx / 2.6), 2, 6);
  for (let pass = 0; pass < smPasses; pass++) {
    for (let i = 0; i <= segs; i++) {
      const a = prof[Math.max(0, i - 1)];
      const b = prof[i];
      const c = prof[Math.min(segs, i + 1)];
      sm[i] = (a + 2 * b + c) * 0.25;
    }
    prof.set(sm);
  }

  // --- 1e. the break: a low-frequency, ASYMMETRIC step in the skyline --------
  //
  // ROUND 2 NOTE. Everything above — the dilation envelope, the subtractive
  // cols, then two to six [1 2 1] passes — is a chain of SMOOTHING operators,
  // and it showed: the horizon came out as a run of smooth, near-symmetric
  // domes. "The current profiles are too smooth and too symmetric" is a fair
  // description of an erosion model with no tectonics in it.
  //
  // Real ranges are not smooth at the top; they have benches, scarps and
  // hanging shoulders where one block stands proud of the next. This is that,
  // done as cheaply as it can be: a two-octave signal at a quarter and an
  // eighth of the run — well inside the wavelength floor, so it cannot alias —
  // rectified so it only ever CUTS a bench in on one side of a summit, then
  // weighted by the local height so it never touches the toe. The result is a
  // skyline with a long side and a stepped side instead of two matching curves,
  // which is the single strongest cue that a shape is a landform and not a
  // triangle someone drew.
  {
    const lamStep = Math.max(lamMin * 2.2, o.length * 0.24);
    for (let i = 0; i <= segs; i++) {
      const x = (i / segs) * o.length;
      const a = fbm1(n, x / lamStep, sy + 131.7, 2);
      const b = fbm1(n, x / (lamStep * 0.46) + 5.1, sy + 177.3, 1);
      // rectify against the landform's own dip direction: the bench forms on
      // the face side, never on the dip slope
      const bench = Math.max(0, chDir > 0 ? a : -a) * (0.55 + 0.45 * Math.max(0, b));
      prof[i] *= 1 - 0.30 * jag * bench * clamp(prof[i] * 1.4, 0, 1);
    }
    // one gentle pass so the bench edge is a scarp, not a sawtooth
    for (let i = 0; i <= segs; i++) sm[i] = (prof[Math.max(0, i - 1)] + 2 * prof[i] + prof[Math.min(segs, i + 1)]) * 0.25;
    prof.set(sm);
  }

  // Ends fall away. `shoulder` decides whether this is a headland running into
  // the water or a slab of a range continuing behind its neighbour.
  //
  // The second term is the END FACE. With a high shoulder the crest was still
  // at 60% of full height on its last column and the mesh simply stopped there,
  // leaving a guillotine cut — a vertical wall the width of the depth. Hidden
  // behind a neighbour most of the time; a freestanding tower whenever it was
  // not. Dropping the outermost 6% of the run to 45% turns that into a steep
  // but honest end face, which is what a headland actually presents.
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    prof[i] *=
      lerp(Math.pow(Math.sin(Math.PI * u), 0.8), 1, shoulder) *
      lerp(0.45, 1, smoothstep(0, 0.06, Math.min(u, 1 - u)));
  }

  // ---------------------------------------------------------------------------
  // NORMALISE THE CREST TO THE HEIGHT THE CALLER ASKED FOR.
  // ---------------------------------------------------------------------------
  // ROUND 4 ROOT FIX, and it is the reason the horizon still sat low after the
  // backdrop was rebuilt. It survives the silhouette rebuild above unchanged
  // and still earns its place: the erosion envelope has a mean well above the
  // old profile's, so without normalisation the whole band ladder would now
  // drift the other way. Measured over 400 seeds the tallest column lands at
  // 0.92–1.07 of `o.height`, median 1.006. The original diagnosis, kept because
  // it is the argument for the line: the old `ridged()` returned a mean of
  // ~0.42; raising that to
  // the 1.6–1.9 power the jag term asks for, then multiplying by an envelope
  // whose mean is 0.71, lands the tallest column of a typical ridge at 0.43 of
  // `o.height` — measured over twelve seeds per band: median 0.43, spread
  // 0.28–0.70. So a band authored as "430–740 m of relief at 2 km", which is
  // where the 12–21° figure in the band table comes from, was building 190–320 m
  // and subtending 7°. Every layer of the horizon was less than half the height
  // it was designed at, which is precisely "the world stops and the horizon has
  // nothing in it" — the ranges were there, they were just too short to see.
  //
  // Two further things were broken downstream by the same fact, and both are
  // fixed by this one line:
  //   · the vertex-colour aerial gradient keys off `y / o.height`, so with peaks
  //     at 0.43 it never got past 60% of the way to `crestTint`. Every ridge was
  //     shaded almost entirely in its FOOT colour — which is the "single tan
  //     tone" note, straight out of the geometry rather than the material;
  //   · the ±60% random spread scrambled the band ladder outright: an unlucky
  //     far-band roll came out shorter than a lucky near-band one, so the
  //     layering the whole table exists to create was luck rather than design.
  //
  // Normalising post-taper (not pre-) means `shoulder` stays a statement about
  // SILHOUETTE — whether the ends dive into the sea — instead of quietly also
  // being a height multiplier. Variety now comes from the band's authored height
  // range, where it can be reasoned about, not from noise luck.
  let profMax = 1e-6;
  for (let i = 0; i <= segs; i++) profMax = Math.max(profMax, prof[i]);
  const profNorm = 1 / profMax;
  for (let i = 0; i <= segs; i++) prof[i] = clamp(prof[i] * profNorm, 0.015, 1);

  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const bestY = new Float32Array(segs + 1).fill(-1e9);
  const bestXYZ = new Float32Array((segs + 1) * 3);
  // ---------------------------------------------------------------------------
  // CROSS-SECTION. Two separate decisions that were previously one, badly.
  // ---------------------------------------------------------------------------
  // The old section was `pow(sin(PI * pow(v, 0.78)), 0.62)` over a uniform v.
  // That curve climbs from 0 to 0.68 of the crest height between v = 0 and
  // v = 0.11 — so with 9 rings, ring 1 was ALREADY at 68% and the entire front
  // flank, the one the camera looks at, was three rings: the toe, 0.68, 0.90.
  // The visible face of every hill in the game was one enormous triangle band.
  //
  // That is the "flat, faceted cardboard" note, and no amount of material work
  // could have fixed it: there was no geometry there to shade. The strata and
  // the foot-to-crest gradient were being interpolated linearly across a 40 m
  // span, the per-vertex spur and gully noise had two samples to work with down
  // the whole flank, and the facets the critique kept naming were the edges of
  // that one band catching the low sun.
  //
  // So: (a) an honest hillside profile — a concave face that steepens downhill,
  // and a long gentle dip slope behind, still asymmetric, still bedded rock;
  // and (b) the rings distributed by HEIGHT rather than by parameter, weighted
  // to the front. Same ring count, same triangle count, same one draw call; the
  // front flank goes from 3 rings to 6 and from one slope to five.
  // The crest position and the two curvatures are now per-landform (`chVC`,
  // `chFaceP`, `chBackP`) rather than three constants. Two ridges side by side
  // no longer share a cross-section, which matters most exactly where they
  // overlap: identical sections stack into one silhouette, different ones read
  // as one hill in front of another.
  const VC = chVC; // parameter position of the crest: front is [0, VC]
  // Flank noise frequencies are quoted in CYCLES ALONG THE RIDGE, so they have
  // to be capped against the column count or they alias exactly the way the old
  // crest profile did. Six columns per cycle at the top octave is the floor
  // everything in this generator is held to.
  const spurF = Math.min(chSpurF, segs / 14);
  const gulF = Math.min(15.4, segs / 8);
  for (let j = 0; j <= rings; j++) {
    const jf = Math.max(3, Math.round(rings * 0.55));
    // Front rings bunch toward the toe (exponent > 1), which is where the slope
    // changes fastest and where the haze pools; the dip slope is uniform.
    const v = j <= jf ? VC * Math.pow(j / jf, 1.4) : VC + (1 - VC) * ((j - jf) / (rings - jf));
    const shape =
      v <= VC
        ? Math.pow(Math.sin(Math.PI * 0.5 * (v / VC)), chFaceP)
        : Math.pow(Math.sin(Math.PI * 0.5 * ((1 - v) / (1 - VC))), chBackP);
    const toe = j === 0 || j === rings;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const x = (u - 0.5) * o.length;
      let z = (v - 0.42 + lean[i]) * o.depth;
      const c = prof[i];
      // Spurs: buttresses running down the flanks. They are what break a
      // smooth conical flank into readable ribs, and — because the low sun is
      // nearly side-on — they are also the only thing that gives a distant
      // hillside a lit face and a shadowed face. Two octaves at a per-landform
      // spacing, displaced in Z as well as Y so the ribs stand PROUD of the
      // slope rather than just being a brightness pattern on it.
      const spur = n(u * spurF + 40.2, v * 2.6) * 0.5 + n(u * spurF * 2.33 + 3.4, v * 5.1) * 0.26;
      // Ribs belong on the FLANK, not on the skyline. Weighted to mid-slope and
      // held to a quarter strength at the crest, because at 2 km the crest is
      // the silhouette and this noise runs at a few columns per cycle: left at
      // full strength up there it aliases into a comb of 70 m needles standing
      // on the summits, which is the second way this generator grew spikes.
      const rib = 0.25 + 3.0 * shape * (1 - shape);
      let y = o.height * c * shape * (1 + spur * (0.20 + 0.26 * jag) * rib);
      // Gullies bite into the flank, but never below the toe. They cut deepest
      // low down, where water actually collects, so the flank reads as drained.
      const gul = Math.max(0, -n(u * gulF + 77.0, v * 4.2));
      y -= o.height * 0.075 * jag * gul * shape * (1.35 - 0.65 * shape) * rib;
      // 0.15 -> 0.24 in Z. `patchBackdropForm` now runs a per-pixel terminator
      // off the real world normal, which is strictly better modelling than any
      // baked gradient — but it can only separate a lit face from a shaded one
      // if the flank HAS faces. A rib that displaces only in Y is a brightness
      // pattern; one that swings in Z as well turns the normal, which is what
      // gives the new term something to bite on and what finally puts a lit
      // side and a shadowed side on a distant hill.
      z += o.depth * (0.24 * spur + 0.06 * gul * chDir) * (1 - Math.abs(2 * v - 1));
      if (toe) y = -skirt;
      if (y > bestY[i]) {
        bestY[i] = y;
        bestXYZ[i * 3] = x;
        bestXYZ[i * 3 + 1] = y;
        bestXYZ[i * 3 + 2] = z;
      }
      pos.push(x, y, z);
      uv.push((u * o.length) / uvS, (v * o.depth + y * 0.6) / uvS);

      // --- vertex colour: strata + aerial gradient + toe darkening
      const hRel = clamp(y / Math.max(1, o.height), 0, 1);
      _lc.copy(footC).lerp(crestC, Math.pow(hRel, 0.62));
      // SCRUB / ROCK PATCHWORK. Two octaves at 40–120 m of feature size, which
      // is the size a Mediterranean hillside's maquis actually patches at, so
      // one landform carries three or four distinct values across its face
      // instead of a single ramp from foot to crest. Low frequency only and no
      // normal: at 950 m and 1.75 km high-frequency detail is aliasing, and the
      // whole point of finding #3 is that the crest EDGE is what resolves.
      if (o.scrubTint) {
        const s0 = n(x * 0.0125 + 91.4, z * 0.0125 - 12.6) * 0.62 + n(x * 0.031 - 4.2, z * 0.031 + 55.9) * 0.38;
        // scrub grows on the shoulders and in the gullies, not on the bare
        // steeps or the crest — hence the shape and height weighting
        const veg = clamp(s0 * 0.9 + 0.42, 0, 1) * lerp(1.0, 0.35, Math.pow(hRel, 1.5)) * lerp(0.45, 1.0, clamp(shape * 1.4, 0, 1));
        _lc.lerp(o.scrubTint, veg * 0.55);
      }
      let m = 1;
      // SUN-CATCH RIM. A ridge lit by a 14° key has a burning edge along the
      // crest columns whose slope turns toward the sun and nothing along the
      // ones that turn away. Baked per vertex because the backdrop's normals
      // are far too coarse to give the real light anything to work with at this
      // triangle density, and because a rim that is only on the SUN-FACING
      // ridges is what separates two overlapping layers from each other.
      if (o.sunLocal !== undefined) {
        // local surface bearing: front flank faces +Z, dip slope faces -Z
        const face = v <= VC ? 1 : -1;
        const facing = Math.cos(o.sunLocal) * face;
        m *= 1 + clamp(facing, 0, 1) * Math.pow(hRel, 3.2) * 0.30;
      }
      if (strata > 0) {
        // Bands wander with the rock rather than ruling straight lines round
        // the landform: a second, non-integer octave plus a lateral warp.
        const warp = n(x * 0.004 + 12.7, z * 0.004) * strata * 0.9;
        const b = (y + warp) / strata;
        m *= 1 + 0.115 * Math.sin(b * Math.PI * 2) + 0.055 * Math.sin(b * Math.PI * 5.17 + 1.3);
      }
      // Slope shading baked in — steep faces are bare rock and read darker.
      // Softened from 0.82: this is a light-independent term, and the more of
      // the modelling it does the less the real key light does. The form should
      // come from the normals, not from a painted gradient.
      m *= lerp(0.90, 1.04, clamp(shape, 0, 1));
      // toe AO: the last 8% of the height sits in its own shadow and in the
      // thickest haze, so it goes dark and cool
      m *= lerp(0.58, 1, smoothstep(0, o.height * 0.13, y));
      col.push(_lc.r * m, _lc.g * m, _lc.b * m);
    }
  }
  const stride = segs + 1;
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * stride + i;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  if (o.crestOut) for (let i = 0; i < bestXYZ.length; i++) o.crestOut.push(bestXYZ[i]);
  if (o.flankOut) {
    o.flankOut.cols = stride;
    o.flankOut.rings = rings + 1;
    o.flankOut.p = Float32Array.from(pos);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Trace a CONTOUR across the ridge's front flank — the one facing the circuit —
 * at `f` of each column's own crest height, over columns `[i0, i0 + span]`.
 * Returns local x,y,z triples, one per column, always `span + 1` of them.
 *
 * Per-COLUMN normalisation is the point. A contour at a fixed world height would
 * run off the end of a saddle and hang in the air; a contour at a fixed fraction
 * of the local crest rises and falls with the hill, which is what a terrace or a
 * hill road actually does and what makes it read as following the land.
 */
export function ridgeContour(fl: RidgeFlank, f: number, i0: number, span: number): number[] {
  const out: number[] = [];
  const { cols, rings, p } = fl;
  if (cols < 2 || rings < 3) return out;
  const frac = clamp(f, 0.02, 0.98);
  for (let k = 0; k <= span; k++) {
    const ci = clamp(i0 + k, 0, cols - 1) | 0;
    // this column's crest ring
    let jc = 1;
    let cy = -1e9;
    for (let j = 1; j < rings - 1; j++) {
      const y = p[(j * cols + ci) * 3 + 1];
      if (y > cy) {
        cy = y;
        jc = j;
      }
    }
    const want = Math.max(0, cy) * frac;
    // Rings below the crest ring are the FRONT flank (local -Z). Walk out from
    // the crest until the surface drops below the target height, then lerp.
    let j1 = jc;
    for (let j = jc; j >= 1; j--) {
      j1 = j;
      if (p[(j * cols + ci) * 3 + 1] <= want) break;
    }
    const j0 = Math.min(jc, j1 + 1);
    const k0 = (j1 * cols + ci) * 3;
    const k1 = (j0 * cols + ci) * 3;
    const y0 = p[k0 + 1];
    const y1 = p[k1 + 1];
    const a = Math.abs(y1 - y0) < 1e-4 ? 0 : clamp((want - y0) / (y1 - y0), 0, 1);
    out.push(lerp(p[k0], p[k1], a), lerp(y0, y1, a), lerp(p[k0 + 2], p[k1 + 2], a));
  }
  return out;
}

/**
 * A quad ribbon between two polylines — two triangles per segment, wound so the
 * face looks out of the hill (toward local -Z / +Y).
 *
 * This is how everything that lies on a distant slope is built: a terrace's
 * retaining face is a ribbon between one contour and the same contour dropped by
 * the wall height; the grove above it is a ribbon between two adjacent contours,
 * so it is guaranteed to lie ON the surface instead of near it. Four triangles
 * per column against the ~100 an extruded box costs, and it bends with the land.
 */
export function ribbonStrip(a: number[], b: number[], uvScale = 12): THREE.BufferGeometry | null {
  const n = Math.min(a.length, b.length) / 3;
  if (n < 2) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i) s += Math.hypot(a[i * 3] - a[i * 3 - 3], a[i * 3 + 1] - a[i * 3 - 2], a[i * 3 + 2] - a[i * 3 - 1]);
    pos.push(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], b[i * 3], b[i * 3 + 1], b[i * 3 + 2]);
    const u = s / uvScale;
    uv.push(u, 0, u, 1);
  }
  for (let i = 0; i + 1 < n; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface IslandOpts {
  radius: number;
  height: number;
  seed: number;
  segs?: number;
  rings?: number;
  jag?: number;
  /** flattens the mass across local Z; < 1 makes a spit rather than a dome */
  squash?: number;
  skirt?: number;
  uvScale?: number;
  strata?: number;
  crestTint?: THREE.Color;
  footTint?: THREE.Color;
}

/**
 * An island or a free-standing headland: the same crest-line idea closed into a
 * loop, so it has two or three summits, a saddle between them and a shoreline
 * that is a wandering line rather than a circle.
 */
export function islandGeo(o: IslandOpts): THREE.BufferGeometry {
  const segs = Math.max(12, o.segs ?? 40);
  const rings = Math.max(4, o.rings ?? 10);
  const jag = o.jag ?? 1;
  const squash = o.squash ?? 1;
  const skirt = o.skirt ?? o.height * 0.35 + 34;
  const uvS = o.uvScale ?? Math.max(8, o.height * 0.2);
  const strata = o.strata ?? Math.max(4, o.height * 0.07);
  const rng = mulberry32(o.seed);
  const n = createNoise2D(rng);
  const crestC = o.crestTint ?? _lc.setRGB(1.06, 1.02, 0.94).clone();
  const footC = o.footTint ?? _lc.setRGB(0.7, 0.74, 0.82).clone();

  // Angular profile of the shoreline and of the summit ridge. Both are periodic
  // in the angle, sampled off a circle in the noise field so they wrap exactly.
  const shore = new Float32Array(segs + 1);
  const crown = new Float32Array(segs + 1);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const cx = Math.cos(a),
      cz = Math.sin(a);
    shore[i] = 1 + n(cx * 1.6, cz * 1.6) * 0.32 * jag + n(cx * 4.3 + 11, cz * 4.3) * 0.15 * jag;
    // Two or three distinct summits with saddles between, NOT a dome — and not
    // a cone either. `pow(ridgedNoise, 1 + jag * 0.6)` was the latter: ridged
    // noise peaks at a cusp and the power then starved everything around it, so
    // an offshore mass at 2 km came out as a needle. A smoothstep on ordinary
    // noise keeps the two-summit read and gives it shoulders to stand on.
    const r0 = 0.5 + 0.5 * n(cx * 2.1 + 30, cz * 2.1);
    const r1 = 0.5 + 0.5 * n(cx * 4.6 + 71, cz * 4.6);
    crown[i] = 0.40 + 0.60 * smoothstep(0.14, 0.92, r0) * (0.72 + 0.28 * r1);
  }

  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const toe = j === 0;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      // PROFILE. The old pair — radius by `sqrt(1 - 0.94 v²)`, height by
      // `v^0.7` — put the mass at HALF the shore radius already at 93% of full
      // height. Every offshore landform was therefore a plug: near-vertical
      // sides, a point on top, and at 2 km indistinguishable from the row of
      // cones the ridges used to be. This pair keeps a broad apron at the
      // waterline and reaches the summit over the inner third, which is a cape
      // or a rock stack rather than a volcano.
      const rr = o.radius * shore[i] * (1 - Math.pow(v, 1.55) * 0.9);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr * squash;
      const flank = Math.pow(v, 0.95);
      const spur = n(Math.cos(a) * 5.4 + 60, Math.sin(a) * 5.4) * 0.4 + n(a * 9.1, v * 3.3) * 0.18;
      let y = o.height * crown[i] * flank * (1 + spur * 0.26 * jag * flank);
      y -= o.height * 0.05 * jag * Math.max(0, -n(a * 13.0 + 91, v * 4.0)) * flank;
      if (toe) y = -skirt;
      pos.push(x, y, z);
      uv.push((a * o.radius) / uvS, (v * o.height + y * 0.5) / uvS);

      const hRel = clamp(y / Math.max(1, o.height), 0, 1);
      _lc.copy(footC).lerp(crestC, Math.pow(hRel, 0.62));
      let m = 1;
      if (strata > 0) {
        const warp = n(x * 0.006 + 4.2, z * 0.006) * strata * 0.9;
        const b = (y + warp) / strata;
        m *= 1 + 0.115 * Math.sin(b * Math.PI * 2) + 0.055 * Math.sin(b * Math.PI * 5.17 + 1.3);
      }
      m *= lerp(0.84, 1.05, flank);
      m *= lerp(0.6, 1, smoothstep(0, o.height * 0.14, y));
      col.push(_lc.r * m, _lc.g * m, _lc.b * m);
    }
  }
  const stride = segs + 1;
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * stride + i;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A single quad in XY, pivot at the bottom centre, for alpha cards. */
export function card(w: number, h: number, uOff = 0, uScale = 1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 1, 3);
  g.translate(0, h / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uOff + uv.getX(i) * uScale);
  uv.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// Merge + instance accumulators — the entire draw-call budget lives here
// ---------------------------------------------------------------------------

const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** Collects transformed geometries into one buffer. Vertex colours carry tint + baked AO. */
export class GeoAccum {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private vcount = 0;
  count = 0;

  /** `aoFn(localY)` bakes contact darkening at the foot of every wall. */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color?: THREE.Color, aoFn?: (x: number, y: number, z: number) => number, uvOff?: THREE.Vector2) {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const u = geo.getAttribute('uv') as THREE.BufferAttribute;
    // Sub-assemblies are built in their own accumulator and folded into a
    // bigger one; their baked tint has to survive that.
    const c0 = geo.getAttribute('color') as THREE.BufferAttribute;
    const index = geo.getIndex();
    _nm.getNormalMatrix(m);
    const base = this.vcount;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      const lx = _v.x,
        ly = _v.y,
        lz = _v.z;
      _v.applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      if (n) {
        _v.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
        this.nrm.push(_v.x, _v.y, _v.z);
      } else this.nrm.push(0, 1, 0);
      if (u) this.uv.push(u.getX(i) + (uvOff ? uvOff.x : 0), u.getY(i) + (uvOff ? uvOff.y : 0));
      else this.uv.push(0, 0);
      const ao = aoFn ? aoFn(lx, ly, lz) : 1;
      const br = c0 ? c0.getX(i) : 1;
      const bg = c0 ? c0.getY(i) : 1;
      const bb = c0 ? c0.getZ(i) : 1;
      if (color) this.col.push(color.r * br * ao, color.g * bg * ao, color.b * bb * ao);
      else this.col.push(br * ao, bg * ao, bb * ao);
    }
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    this.vcount += p.count;
    this.count++;
  }

  build(): THREE.BufferGeometry | null {
    if (!this.vcount) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    // free the JS-side scratch; these arrays are megabytes for the village
    this.pos = this.nrm = this.uv = this.col = this.idx = [];
    return g;
  }
}

export interface InstOpts {
  color?: THREE.Color;
  /** uv scale.xy / offset.xy for atlases and per-instance tiling */
  uv?: THREE.Vector4;
  /** wind: phase, stiffness exponent, reference height, flutter amplitude */
  wind?: THREE.Vector4;
  /** distance in metres past which this instance collapses; 0 = never */
  lod?: number;
  /** bob: amplitude, phase, roll amplitude, unused */
  bob?: THREE.Vector4;
}

/** Accumulates instance transforms; emits one InstancedMesh. */
export class InstSet {
  private mats: THREE.Matrix4[] = [];
  private cols: number[] = [];
  private uvs: number[] = [];
  private winds: number[] = [];
  private lods: number[] = [];
  private bobs: number[] = [];
  private useCol = false;
  private useUv = false;
  private useWind = false;
  private useLod = false;
  private useBob = false;

  constructor(readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material, readonly name: string) {}

  get count() {
    return this.mats.length;
  }

  /**
   * True when nothing about this set moves after build: no wind sway, no bob.
   * Those two are the only patches that read the instance transform at runtime
   * (`patchWind` needs the instance scale, `patchBob` rotates about the
   * instance origin), so they are the only two that stop a set from being
   * baked flat by `mergeStaticSets`.
   */
  get isStatic(): boolean {
    return !this.useWind && !this.useBob;
  }

  /** Raw per-instance data, for `mergeStaticSets`. */
  snapshot() {
    return {
      geo: this.geo, mat: this.mat, name: this.name,
      mats: this.mats, cols: this.cols, uvs: this.uvs, lods: this.lods,
      useCol: this.useCol, useUv: this.useUv, useLod: this.useLod,
    };
  }

  add(m: THREE.Matrix4, o?: InstOpts) {
    this.mats.push(m.clone());
    if (o?.color) {
      this.useCol = true;
      this.cols.push(o.color.r, o.color.g, o.color.b);
    } else this.cols.push(1, 1, 1);
    if (o?.uv) {
      this.useUv = true;
      this.uvs.push(o.uv.x, o.uv.y, o.uv.z, o.uv.w);
    } else this.uvs.push(1, 1, 0, 0);
    if (o?.wind) {
      this.useWind = true;
      this.winds.push(o.wind.x, o.wind.y, o.wind.z, o.wind.w);
    } else this.winds.push(0, 0, 0, 0);
    if (o?.lod) {
      this.useLod = true;
      this.lods.push(o.lod);
    } else this.lods.push(0);
    if (o?.bob) {
      this.useBob = true;
      this.bobs.push(o.bob.x, o.bob.y, o.bob.z, o.bob.w);
    } else this.bobs.push(0, 0, 0, 0);
  }

  build(castShadow = true, receiveShadow = true): THREE.InstancedMesh | null {
    const n = this.mats.length;
    if (!n) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    mesh.name = this.name;
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, this.mats[i]);
    mesh.instanceMatrix.needsUpdate = true;
    const attr = (arr: number[], size: number, name: string) => mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(arr), size));
    if (this.useCol) attr(this.cols, 3, 'aTint');
    if (this.useUv) attr(this.uvs, 4, 'aUv');
    if (this.useWind) attr(this.winds, 4, 'aWind');
    if (this.useLod) attr(this.lods, 1, 'aLod');
    if (this.useBob) attr(this.bobs, 4, 'aBob');
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    // NOTE: do NOT hang a `depthMaterialFor(this.mat)` here. It looks obviously
    // right — a caster whose vertices are displaced in the colour material
    // wants a depth material that displaces them identically — and it DELETES
    // EVERY SCENERY SHADOW IN THE GAME. `patchLod` collapses an instance to a
    // point beyond its LOD distance, and it measures that distance from the
    // camera being rendered from. In the shadow pass that camera is the light's
    // orthographic shadow camera, which sits far outside the circuit, so every
    // instance reads as maximally distant, every one collapses, and the depth
    // buffer comes back empty. Measured: mean luma of the start-line foreground
    // went 43.3 -> 80.5 as the grandstand shadow over the bottom-left ~55% of
    // the frame simply disappeared. If this is ever attempted again, the LOD
    // uniform has to be fed the MAIN camera position explicitly rather than
    // inheriting the shadow camera's.
    mesh.computeBoundingSphere();
    this.mats = [];
    this.cols = this.uvs = this.winds = this.lods = this.bobs = [];
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// Static batching
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  mergeStaticSets — collapses many static InstancedMeshes into few meshes.
 * ============================================================================
 *  An InstancedMesh is one draw call however many instances it holds, so the
 *  scenery's draw cost is not the instance count — it is the number of *sets*.
 *  Measured at the `scenery` vantage point (tools/perf.mjs), the near shadow
 *  cascade alone was submitting 52 sets every single frame, and about 25 of
 *  those were small static props: crates, barrels, deckchairs, market stalls,
 *  A-frames, sign panels.
 *
 *  Worse, almost none of them could ever be culled. An InstancedMesh's bounding
 *  sphere has to enclose every instance, and these sets scatter their instances
 *  around all 1600 m of circuit — so `scenery/crate` has a track-sized bounding
 *  sphere and is submitted in full, all 42 crates and 9.2 k triangles, into a
 *  55 m shadow box that usually contains no crates at all. One draw call and a
 *  full geometry upload for a guaranteed-empty result.
 *
 *  This fixes both at once. Sets that never move are baked flat — instance
 *  transform folded into the vertices — and re-bucketed by (material, world
 *  grid cell). So twelve painted-timber sets spanning the whole circuit become
 *  a handful of per-cell meshes with tight bounding spheres: far fewer draws,
 *  and the ones that remain are cullable for the first time.
 *
 *  Nothing is removed. Every instance of every set survives, at the same
 *  transform, with the same material and the same per-instance tint — the tint,
 *  the atlas cell and the LOD distance simply become per-VERTEX attributes
 *  carrying a constant across each baked instance, which is exactly what the
 *  vertex shader read out of the per-instance attribute before.
 *
 *  Two patches are deliberately not supported, and `InstSet.isStatic` refuses
 *  any set that uses them: `patchWind` reads the instance scale out of
 *  `instanceMatrix`, and `patchBob` rotates about the instance origin. Neither
 *  survives being baked flat, so foliage, cloth, crowd and boats stay instanced.
 *  `patchLod` is guarded by `#ifdef USE_INSTANCING` and simply stops applying,
 *  which is the intended trade: these props are now cullable by cell instead.
 * ============================================================================
 */

const _mm = new THREE.Matrix3();
const _mv = new THREE.Vector3();

/**
 * Edge of the world-space bucketing grid, metres.
 *
 * This is a straight trade between draw calls and culling. One cell for the
 * whole circuit is the fewest possible draws but nothing can ever be rejected;
 * 40 m cells cull beautifully and hand back all the draw calls that were just
 * saved. 150 m is a little over the length of circuit the chase camera can see
 * at once, so a typical frame touches two or three cells per material while the
 * 55 m shadow box usually touches one.
 *
 * ---------------------------------------------------------------------------
 *  DO NOT EXTEND THIS GRID TO THE REST OF THE WORLD. IT HAS BEEN TRIED AND
 *  MEASURED AND IT LOSES.
 * ---------------------------------------------------------------------------
 *  The obvious next step from here is to partition everything else the same
 *  way, and it is very persuasive on paper: `village-walls` is 110 244
 *  triangles inside a 363 m bounding sphere, `crowd0` is 116 250 inside a
 *  356 m one, and the near shadow cascade is 110 m across, so neither can ever
 *  be rejected by a frustum.
 *
 *  It was implemented — `GeoAccum` and `InstSet` both got a `buildCells`, every
 *  circuit-spanning merge and every instance set above 60 instances was split
 *  onto a 260 m grid — and measured with tools/perf.mjs at 1280x720. Draw calls
 *  per frame, `typical` (non-cascade-refresh) column, before -> after:
 *
 *      hero   164 -> 226     grid  176 -> 272     boost  164 -> 301
 *
 *  against frame triangles of 3187k -> 3157k, 3284k -> 2922k, 3126k -> 2197k.
 *
 *  Sixty to a hundred and forty extra draw calls to save, at the hero vantage
 *  point, THIRTY THOUSAND triangles. The reason is `patchLod`: distant
 *  instances are already collapsed to a point in the vertex shader, in the
 *  colour pass and in the depth pass alike, so the triangles a spatial split
 *  would have culled were mostly costing nothing already. Culling also barely
 *  fires — the aerial perspective reaches 600 m, so on this circuit the camera
 *  frustum contains most of the cells most of the time and only rejects what is
 *  behind you.
 *
 *  The batching above is worth it because it goes the OTHER way — it turns many
 *  meshes into few. Splitting few into many is the same dial turned the wrong
 *  direction.
 *
 *  Two notes on the instrument, since the numbers above were taken with it and
 *  the next person will want to reproduce them:
 *
 *  - tools/perf.mjs draw counts are NOT exactly repeatable. The vantage point
 *    is reached by simulation, not teleport, so the camera lands in a slightly
 *    different place each run. Two consecutive runs of IDENTICAL code differed
 *    by 10 draws at `pack` (157 vs 167) and 2-3 elsewhere. Deltas smaller than
 *    about ten draws at a single vantage point are noise; the 60-140 above are
 *    not.
 *  - its `tris=` banner column is `last.triangles`, a single frame, not the
 *    30-frame statistic the draw counts get. One run printed `tris=0k` for a
 *    shot that plainly rendered. Read it as an order of magnitude.
 */
const STATIC_CELL = 400;

interface StaticBucket {
  mat: THREE.Material;
  cast: boolean;
  vc: boolean;
  pos: number[]; nrm: number[]; uv: number[]; col: number[];
  tint: number[]; iuv: number[]; lod: number[]; org: number[];
  idx: number[]; base: number;
  names: Set<string>;
}

/**
 * Bakes every static set in `sets` into merged meshes, one per material per
 * grid cell. Sets that fail `isStatic` are returned in `kept` for the caller to
 * build as InstancedMeshes exactly as before.
 *
 * `castOf` decides shadow casting per set; sets that disagree are bucketed
 * apart, because `castShadow` is a property of the mesh and cannot be mixed.
 */
export function mergeStaticSets(
  sets: InstSet[],
  castOf: (name: string) => boolean,
  cell = STATIC_CELL,
): { merged: THREE.Mesh[]; kept: InstSet[] } {
  const merged: THREE.Mesh[] = [];
  const kept: InstSet[] = [];
  const buckets = new Map<string, StaticBucket>();
  const matKey = new Map<THREE.Material, number>();

  for (const set of sets) {
    if (!set.isStatic || set.count === 0) { kept.push(set); continue; }
    const s = set.snapshot();
    const g = s.geo;
    const p = g.attributes.position;
    if (!p) { kept.push(set); continue; }

    const n = g.attributes.normal;
    const u = g.attributes.uv;
    const c0 = g.attributes.color;
    const index = g.index;
    const vc = (s.mat as { vertexColors?: boolean }).vertexColors === true;
    const cast = castOf(s.name);
    if (!matKey.has(s.mat)) matKey.set(s.mat, matKey.size);
    const mk = matKey.get(s.mat)!;

    for (let inst = 0; inst < s.mats.length; inst++) {
      const m = s.mats[inst];
      // Bucket on the instance origin. Props are small next to the cell, so the
      // origin is a good enough proxy for where the geometry lands.
      const cx = Math.floor(m.elements[12] / cell);
      const cz = Math.floor(m.elements[14] / cell);
      const key = mk + '|' + (cast ? 1 : 0) + '|' + cx + '|' + cz;
      let b = buckets.get(key);
      if (!b) {
        b = {
          mat: s.mat, cast, vc,
          pos: [], nrm: [], uv: [], col: [], tint: [], iuv: [], lod: [], org: [],
          idx: [], base: 0, names: new Set(),
        };
        buckets.set(key, b);
      }
      b.names.add(s.name);
      _mm.getNormalMatrix(m);

      const tr = s.useCol ? s.cols[inst * 3] : 1;
      const tg = s.useCol ? s.cols[inst * 3 + 1] : 1;
      const tb = s.useCol ? s.cols[inst * 3 + 2] : 1;
      const ux = s.useUv ? s.uvs[inst * 4] : 1;
      const uy = s.useUv ? s.uvs[inst * 4 + 1] : 1;
      const uz = s.useUv ? s.uvs[inst * 4 + 2] : 0;
      const uw = s.useUv ? s.uvs[inst * 4 + 3] : 0;
      const lod = s.useLod ? s.lods[inst] : 0;
      // The instance origin, in the merged geometry's (object) space, so the
      // baked-flat LOD collapse in `patchLod` has something to scale about.
      const ox = m.elements[12], oy = m.elements[13], oz = m.elements[14];

      for (let i = 0; i < p.count; i++) {
        _mv.fromBufferAttribute(p, i).applyMatrix4(m);
        b.pos.push(_mv.x, _mv.y, _mv.z);
        if (n) {
          _mv.fromBufferAttribute(n, i).applyMatrix3(_mm).normalize();
          b.nrm.push(_mv.x, _mv.y, _mv.z);
        } else b.nrm.push(0, 1, 0);
        if (u) b.uv.push(u.getX(i), u.getY(i));
        else b.uv.push(0, 0);
        if (vc) {
          if (c0) b.col.push(c0.getX(i), c0.getY(i), c0.getZ(i));
          else b.col.push(1, 1, 1);
        }
        // The three per-instance channels, flattened to per-vertex constants.
        // `aUv` in particular must always be written: it is a multiply-add on
        // the map UVs, and an absent attribute reads (0,0,0,1) in GL, which
        // would collapse every texture in the batch onto one texel.
        b.tint.push(tr, tg, tb);
        b.iuv.push(ux, uy, uz, uw);
        b.lod.push(lod);
        b.org.push(ox, oy, oz);
      }
      if (index) for (let i = 0; i < index.count; i++) b.idx.push(b.base + index.getX(i));
      else for (let i = 0; i < p.count; i++) b.idx.push(b.base + i);
      b.base += p.count;
    }
  }

  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    if (b.vc) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(b.tint, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(b.iuv, 4));
    g.setAttribute('aLod', new THREE.Float32BufferAttribute(b.lod, 1));
    g.setAttribute('aOrigin', new THREE.Float32BufferAttribute(b.org, 3));
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, b.mat);
    mesh.name = 'static-' + [...b.names].sort().join('+');
    mesh.castShadow = b.cast;
    mesh.receiveShadow = true;
    // Same trap as `InstSet.build` above, and worse here: a baked cell is one
    // mesh holding hundreds of props across a whole range of `aLod` distances,
    // so a depth material carrying `patchLod` collapses the entire cell in the
    // shadow pass. No `customDepthMaterial` here either.
    mesh.matrixAutoUpdate = false;
    merged.push(mesh);
  }
  return { merged, kept };
}

// ---------------------------------------------------------------------------
// Shared uniforms + shader patch system
// ---------------------------------------------------------------------------

export interface Shared {
  uTime: { value: number };
  uCam: { value: THREE.Vector3 };
  uWindDir: { value: THREE.Vector2 };
  uWindAmp: { value: number };
  uSunView: { value: THREE.Vector3 };
  /** Same direction in WORLD space — the aerial-perspective haze needs it to
   *  know whether a given bearing is looking into the sun or away from it. */
  uSunWorld: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  uCheer: { value: number };
  uSeaLevel: { value: number };
}

export function makeShared(): Shared {
  return {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
    uWindAmp: { value: 1 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunWorld: { value: new THREE.Vector3(-0.62, 0.245, -0.745).normalize() },
    uSunCol: { value: new THREE.Color(0xffd9a8) },
    uCheer: { value: 0 },
    uSeaLevel: { value: 0 },
  };
}

type PatchFn = (sh: any, renderer?: any) => void;
interface PatchEntry {
  keys: string[];
  fns: PatchFn[];
}
const PATCHES = new WeakMap<THREE.Material, PatchEntry>();

/**
 * Composable onBeforeCompile. Keys feed customProgramCacheKey.
 *
 * Materials handed to us by the shared library already carry their own
 * onBeforeCompile — that is where its tiling-breakup injection lives. Simply
 * assigning ours would silently drop it and reintroduce a visible one-tile
 * repeat, so the incumbent handler is captured and run first.
 */
export function patch(mat: THREE.Material, key: string, fn: PatchFn) {
  let e = PATCHES.get(mat);
  if (!e) {
    const prior = mat.onBeforeCompile;
    const priorCacheKey = mat.customProgramCacheKey;
    const hasPrior = typeof prior === 'function' && prior !== THREE.Material.prototype.onBeforeCompile;
    let baseKey = '';
    if (hasPrior && typeof priorCacheKey === 'function') {
      try {
        baseKey = 'base:' + priorCacheKey.call(mat);
      } catch {
        baseKey = 'base';
      }
    }
    e = { keys: hasPrior ? [baseKey || 'base'] : [], fns: hasPrior ? [(sh: any, r: any) => (prior as any).call(mat, sh, r)] : [] };
    PATCHES.set(mat, e);
    const entry = e;
    mat.onBeforeCompile = (sh, renderer) => {
      for (const f of entry.fns) f(sh, renderer);
    };
    mat.customProgramCacheKey = () => entry.keys.join('|');
  }
  if (e.keys.indexOf(key) >= 0) return;
  e.keys.push(key);
  e.fns.push(fn);
  mat.needsUpdate = true;
}

/**
 * The patches that MOVE VERTICES, as opposed to colouring them.
 *
 * Everything in this list changes where the geometry physically is — the LOD
 * collapse, the wind sway, the boat bob, the crowd's cheer, cloth flap, a
 * gull's orbit. Everything NOT in it (tint, instanced UV, translucency, aerial
 * haze, roughness variation) only changes what the surface looks like, which a
 * depth pass does not care about.
 *
 * Keys are matched by prefix because three of them are parameterised:
 * `patchWind` keys as `wind0`/`wind1`, `patchCloth` as `cloth0.30`.
 */
const DEPTH_PATCH_KEY = /^(lod|wind\d|bob|crowd|cloth|bird)/;

/**
 * A depth material that agrees with `mat` about where its vertices are.
 *
 * THE BUG THIS FIXES. Every vertex displacement in this file lives in the
 * colour material's `onBeforeCompile`. The shadow pass does not use the colour
 * material: `WebGLShadowMap.getDepthMaterial` reaches for `customDepthMaterial`
 * and falls back to one shared `MeshDepthMaterial` that knows nothing about any
 * of it. So an object could be collapsed to a point by `patchLod` — invisible,
 * deliberately, because it is 300 m away — and still lay a full-size shadow on
 * the ground with nothing above it to cast it. Under this game's 14-degree key
 * light that shadow is four times the prop's own height, so it is not a subtle
 * artefact; it is a long dark streak attached to nothing.
 *
 * Measured with a per-instance distance probe over the four capture vantage
 * points, 58-93% of all LOD-carrying world geometry is collapsed in the colour
 * pass, and 493k-884k triangles of it were still being rasterised into the
 * shadow map every frame — every spectator, every crate, every cypress on the
 * far side of the circuit, at full detail, drawing shadows nobody can see.
 *
 * Foliage already solved this for its three cut-out sheets by hand (see
 * `Foliage.buildSets`, which builds a matching `MeshDepthMaterial` and runs
 * `patchWind` + `patchLod` over it). This generalises that to every set: the
 * SAME patch closures are re-run against the depth material, so the two shaders
 * cannot drift apart the way a hand-copied pair can.
 *
 * Returns null when `mat` moves no vertices — then three's shared depth
 * material is already correct and a per-material clone would only cost a
 * program.
 *
 * `map` / `alphaTest` / `side` are copied so the FIRST compile has the right
 * defines. Three overwrites all three on every shadow draw regardless (it does
 * this to custom depth materials too), so this changes no behaviour — it only
 * stops the first shadow frame compiling a variant it immediately discards.
 */
export function depthMaterialFor(mat: THREE.Material): THREE.Material | null {
  const e = PATCHES.get(mat);
  if (!e) return null;
  const wanted: number[] = [];
  for (let i = 0; i < e.keys.length; i++) if (DEPTH_PATCH_KEY.test(e.keys[i])) wanted.push(i);
  if (!wanted.length) return null;

  const src = mat as THREE.MeshStandardMaterial;
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (src.map && src.alphaTest > 0) {
    d.map = src.map;
    d.alphaTest = src.alphaTest;
  }
  if (src.alphaToCoverage) d.alphaToCoverage = true;
  d.side = src.side;
  for (const i of wanted) patch(d, e.keys[i], e.fns[i]);
  return d;
}

const insertBefore = (src: string, token: string, code: string) => src.replace(token, code + '\n' + token);

/** Per-instance UV transform (atlas cells + per-instance tiling density). */
export function patchInstUv(mat: THREE.Material) {
  patch(mat, 'iuv', (sh) => {
    sh.vertexShader = 'attribute vec4 aUv;\n' + sh.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = vMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_NORMALMAP
        vNormalMapUv = vNormalMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_ROUGHNESSMAP
        vRoughnessMapUv = vRoughnessMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_ALPHAMAP
        vAlphaMapUv = vAlphaMapUv * aUv.xy + aUv.zw;
      #endif`
    );
  });
}

/**
 * Per-instance tint, multiplied over albedo (independent of three's
 * instanceColor so it can be masked). With `maskFromUvX`, only vertices whose
 * uv.x is 1 take the tint — that is how one spectator mesh gets a coloured
 * shirt without repainting the skin.
 */
export function patchTint(mat: THREE.Material, maskFromUvX = false) {
  patch(mat, 'tint' + (maskFromUvX ? 'M' : ''), (sh) => {
    sh.vertexShader =
      'attribute vec3 aTint;\nvarying vec3 vTintI;\n' +
      (maskFromUvX ? 'varying float vTintMask;\n' : '') +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTintI = aTint;' + (maskFromUvX ? '\n  vTintMask = clamp(uv.x, 0.0, 1.0);' : ''));
    sh.fragmentShader =
      'varying vec3 vTintI;\n' +
      (maskFromUvX ? 'varying float vTintMask;\n' : '') +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        maskFromUvX
          ? `#include <color_fragment>
           diffuseColor.rgb *= mix(vec3(1.0), vTintI, vTintMask);`
          : `#include <color_fragment>
           diffuseColor.rgb *= vTintI;`
      );
  });
}

/** Per-instance opacity, for the contact-shadow decals. */
export function patchInstAlpha(mat: THREE.Material) {
  patch(mat, 'ialpha', (sh) => {
    sh.vertexShader = 'attribute vec3 aTint;\nvarying float vIAlpha;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vIAlpha = aTint.r;');
    sh.fragmentShader = 'varying float vIAlpha;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vIAlpha;');
  });
}

/** LOD collapse: instances past `aLod` metres from the camera become degenerate. */
export function patchLod(mat: THREE.Material, u: Shared) {
  patch(mat, 'lod', (sh) => {
    sh.uniforms.uCam = u.uCam;
    sh.vertexShader = 'attribute float aLod;\nattribute vec3 aOrigin;\nuniform vec3 uCam;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         if (aLod > 0.0) {
           vec3 iOrigin = (modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
           float dCam = distance(iOrigin, uCam);
           // fade the last 15% of the range by shrinking, then collapse
           transformed *= 1.0 - smoothstep(aLod * 0.86, aLod, dCam);
         }
       #else
         // Same collapse for a set that mergeStaticSets has baked flat. There
         // is no instanceMatrix to read the origin out of any more, so the
         // merger writes each baked instance's own origin into aOrigin and the
         // scale happens about that instead of about the merged geometry's
         // origin -- which is somewhere out in the middle of a 400 m cell, and
         // would send every prop in the batch sliding towards it.
         if (aLod > 0.0) {
           float dCam = distance((modelMatrix * vec4(aOrigin, 1.0)).xyz, uCam);
           transformed = aOrigin +
             (transformed - aOrigin) * (1.0 - smoothstep(aLod * 0.86, aLod, dCam));
         }
       #endif`
    );
  });
}

/**
 * Wind sway. aWind = (phase, stiffness exponent, reference height, flutter).
 * Trunks and their fronds evaluate the identical curve so a palm crown and the
 * fronds attached to it never separate.
 */
export function patchWind(mat: THREE.Material, u: Shared, flutterAxis = 0) {
  patch(mat, 'wind' + flutterAxis, (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uWindDir = u.uWindDir;
    sh.uniforms.uWindAmp = u.uWindAmp;
    sh.vertexShader =
      `attribute vec4 aWind;
       uniform float uTime; uniform vec2 uWindDir; uniform float uWindAmp;
       float kartSway(float phase, float h, float stiff){
         float t = uTime * 1.15 + phase;
         float a = sin(t) * 0.62 + sin(t * 1.73 + 1.3) * 0.27 + sin(t * 3.31 + 2.1) * 0.11;
         return a * pow(max(h, 0.0), stiff) * uWindAmp;
       }\n` +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float instS = 1.0;
           #ifdef USE_INSTANCING
             instS = length(instanceMatrix[1].xyz);
           #endif
           // A positive reference height lets a detached part (a frond) inherit
           // the sway its parent (the trunk) has at the attachment point. Both
           // work in WORLD metres, and the offset is divided back out through
           // the instance scale, so a crown and its fronds never separate.
           float hRef = aWind.z > 0.0 ? aWind.z : transformed.y * instS;
           float s = kartSway(aWind.x, hRef, max(aWind.y, 0.001)) * 0.09;
           transformed.xz += uWindDir * s / max(instS, 0.001);
           // flutter: high-frequency ripple along the leaf's own length
           float fl = aWind.w * 0.055 * sin(uTime * 5.4 + aWind.x * 3.0 + transformed.${flutterAxis === 0 ? 'x' : 'z'} * 2.6);
           transformed.y += fl;
           transformed.${flutterAxis === 0 ? 'z' : 'x'} += fl * 0.6;
         }`
      );
  });
}

/**
 * Backlit leaf translucency — the low sun through palm fronds (§4: "palms
 * backlit at golden hour is a hero moment, do not waste it").
 *
 * Three terms, and all three matter:
 *   • wrap diffuse `(NdotL + w)/(1 + w)` with w = 0.5, so the terminator wraps
 *     around a one-sided blade instead of clipping at NdotL = 0. This is what
 *     stops a canopy reading as one flat value.
 *   • a back-scatter lobe on `dot(-viewDir, lightDir)^4` — light that has
 *     travelled THROUGH the blade toward the eye.
 *   • a thickness term from the card's own UV: the rachis is opaque, the tips
 *     and the leaflet edges are one cell thick and light up first.
 * Transmitted light is tinted hard toward #b8d84a: chlorophyll absorbs far
 * less in the yellow-green, so a backlit leaf is never just a brighter version
 * of its own albedo.
 */
const SAP = new THREE.Color(0x9ad46a).convertSRGBToLinear();

export function patchTranslucency(mat: THREE.Material, u: Shared, strength = 1.0) {
  patch(mat, 'trans', (sh) => {
    sh.uniforms.uSunView = u.uSunView;
    sh.uniforms.uSunCol = u.uSunCol;
    sh.uniforms.uTransStrength = { value: strength };
    // §4's warm yellow-green. Round 1 hard-coded the sRGB triple straight into
    // the shader, where everything is linear — so the sap read a full stop too
    // bright and washed toward white instead of glowing green.
    sh.uniforms.uSap = { value: SAP };
    sh.vertexShader = 'varying vec2 vLeafUv;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vLeafUv = uv;');
    sh.fragmentShader =
      'uniform vec3 uSunView; uniform vec3 uSunCol; uniform float uTransStrength; uniform vec3 uSap;\nvarying vec2 vLeafUv;\n' +
      sh.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           // vViewPosition points from the fragment TOWARD the eye, so -V is the
           // view direction and dot(-V, L) fires only when the leaf sits between
           // the camera and the sun — which is exactly the backlit-palm case.
           vec3 V = normalize(vViewPosition);
           // Wrap widened 0.55 -> 0.60 of a hemisphere. This is the term that
           // decides whether a canopy has any light in it at all when the sun is
           // not directly behind it, and the umbrella pine in scenery.png — lit
           // from three-quarter rear, silhouetted against a pale sky — came back
           // as a flat dark cut-out. Wrap lighting is what a leaf actually does:
           // light entering the far side scatters through and leaves the near
           // side, so the terminator on a leaf sits well past 90°.
           float wrap = clamp((dot(normal, uSunView) + 0.60) / 1.60, 0.0, 1.0);
           float back = pow(clamp(dot(-V, uSunView), 0.0, 1.0), 3.0);
           // clamped so solid-geometry foliage (uv tiles past 1) stays neutral
           float lu = clamp(vLeafUv.x, 0.0, 1.0);
           float lv = clamp(vLeafUv.y, 0.0, 1.0);
           // thin toward the frond tip and toward the leaflet edges: that is the
           // part of a palm that actually goes translucent
           float thin = mix(0.42, 1.0, lu) * mix(0.5, 1.0, abs(lv - 0.5) * 2.0);
           vec3 sap = mix(diffuseColor.rgb, uSap, 0.62);
           reflectedLight.directDiffuse += uSunCol * sap * back * 3.8 * thin * uTransStrength;
           // 0.42 -> 0.80. §4 calls a backlit palm at golden hour "a hero
           // moment — do not waste it", and at 0.42 the wrap was contributing
           // roughly a tenth of a stop against a 4.2-intensity key: arithmetically
           // present, visually absent. This is the whole difference between a
           // canopy that glows and a green sticker.
           reflectedLight.directDiffuse += uSunCol * mix(diffuseColor.rgb, uSap, 0.34) * wrap * 0.80 * uTransStrength;
         }`
      );
  });
}

/**
 * Roughness driven off the per-instance tint's value.
 *
 * The clump mask that decides whether a patch of verge is fresh growth or
 * sun-bleached already rides in on `aTint`; this reads it back out so the dry
 * patches are also the matte ones (0.88) and the fresh growth keeps a waxy
 * sheen (0.55). §4 wants roughness to vary spatially and this gets it for the
 * cost of one dot product, with the variation locked to the albedo variation
 * rather than floating free of it.
 *
 * Requires `patchTint` on the same material — it reads that patch's `vTintI`
 * varying rather than redeclaring the attribute, which would be a duplicate
 * declaration and fail to compile.
 */
export function patchRoughFromTint(mat: THREE.Material, lo = 0.55, hi = 0.88) {
  patch(mat, 'roughtint', (sh) => {
    sh.uniforms.uRtRange = { value: new THREE.Vector2(lo, hi) };
    sh.fragmentShader =
      'uniform vec2 uRtRange;\n' +
      sh.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           float v = dot(vTintI, vec3(0.2126, 0.7152, 0.0722));
           roughnessFactor = mix(uRtRange.x, uRtRange.y, clamp((v - 0.28) / 0.55, 0.0, 1.0));
         }`
      );
  });
}

/**
 * Spatially varying roughness (§4: "a constant roughness value reads as plastic
 * and is the #1 tell of an amateur real-time scene"). A texture's roughness map
 * repeats with its own tile; this modulates it with a low-frequency world-space
 * field so one wall is sun-baked and polished and the next is chalky, and the
 * patches do not line up with the texture repeat.
 */
export function patchRoughVary(mat: THREE.Material, lo = 0.72, hi = 1.22, scale = 7.0) {
  patch(mat, 'roughvary' + lo.toFixed(2) + hi.toFixed(2), (sh) => {
    sh.uniforms.uRvScale = { value: 1 / scale };
    sh.uniforms.uRvRange = { value: new THREE.Vector2(lo, hi) };
    sh.vertexShader =
      'varying vec3 vRvPos;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 rvW = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             rvW = instanceMatrix * rvW;
           #endif
           vRvPos = (modelMatrix * rvW).xyz;
         }`
      );
    sh.fragmentShader =
      `varying vec3 vRvPos; uniform float uRvScale; uniform vec2 uRvRange;
       float rvHash(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.7); return fract(p.x * p.y); }
       float rvNoise(vec2 p){
         vec2 i = floor(p), f = fract(p);
         f = f * f * (3.0 - 2.0 * f);
         return mix(mix(rvHash(i), rvHash(i + vec2(1.0, 0.0)), f.x),
                    mix(rvHash(i + vec2(0.0, 1.0)), rvHash(i + vec2(1.0, 1.0)), f.x), f.y);
       }\n` +
      // Anchored on metalnessmap_fragment, not roughnessmap_fragment: the
      // shared library REPLACES the latter outright for its tiling breakup, so
      // that token no longer exists by the time we run. roughnessFactor is in
      // scope either way, and metalness is the next include along.
      sh.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        `{
           vec2 rp = vRvPos.xz * uRvScale + vRvPos.y * uRvScale * 0.31;
           float rn = rvNoise(rp) * 0.62 + rvNoise(rp * 2.37 + 11.3) * 0.38;
           roughnessFactor = clamp(roughnessFactor * mix(uRvRange.x, uRvRange.y, rn), 0.05, 1.0);
         }
         #include <metalnessmap_fragment>`
      );
  });
}

/**
 * Low-frequency albedo break-up in world space.
 *
 * §4 forbids a visible tiling repeat inside one camera frame, and wide.png has
 * two: the roof tiles run a regular corduroy stripe that moirés along every
 * ridge, and the same tile pattern is plainly identical from one roof to the
 * next. `patchRoughVary` already breaks the ROUGHNESS with a world-space field
 * and it is what stops the walls reading as one plastic sheet — but roughness
 * cannot hide a repeat that is visible in albedo, and a tiled clay roof is
 * mostly an albedo pattern.
 *
 * Two octaves at a non-integer ratio, sampled in world space so they cannot
 * line up with the texture repeat by construction, and applied as a multiply so
 * nothing shifts hue. Costs two hashes per fragment.
 */
export function patchMacroBreak(mat: THREE.Material, scale = 9.0, amount = 0.16) {
  patch(mat, 'macrobrk' + scale.toFixed(1) + amount.toFixed(2), (sh) => {
    sh.uniforms.uMbScale = { value: 1 / scale };
    sh.uniforms.uMbAmt = { value: amount };
    sh.vertexShader =
      'varying vec3 vMbPos;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 mbW = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             mbW = instanceMatrix * mbW;
           #endif
           vMbPos = (modelMatrix * mbW).xyz;
         }`
      );
    sh.fragmentShader =
      `varying vec3 vMbPos; uniform float uMbScale; uniform float uMbAmt;
       float mbH(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 29.1); return fract(p.x * p.y); }
       float mbN(vec2 p){
         vec2 i = floor(p), f = fract(p);
         f = f * f * (3.0 - 2.0 * f);
         return mix(mix(mbH(i), mbH(i + vec2(1.0, 0.0)), f.x),
                    mix(mbH(i + vec2(0.0, 1.0)), mbH(i + vec2(1.0, 1.0)), f.x), f.y);
       }\n` +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           vec2 mp = vMbPos.xz * uMbScale + vMbPos.y * uMbScale * 0.53;
           // 1 : 2.71 — deliberately irrational-ish, so the two octaves never
           // beat against each other or against the map's own tile
           float mn = mbN(mp) * 0.63 + mbN(mp * 2.71 + 7.9) * 0.37;
           diffuseColor.rgb *= 1.0 + (mn - 0.5) * 2.0 * uMbAmt;
         }`
      );
  });
}

/** Boats: vertical bob + roll about the instance origin, on the GPU. */
export function patchBob(mat: THREE.Material, u: Shared) {
  patch(mat, 'bob', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = 'attribute vec4 aBob;\nuniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float t = uTime * 0.9 + aBob.y;
         float heave = (sin(t) * 0.7 + sin(t * 1.62 + 1.1) * 0.3) * aBob.x;
         float roll  = sin(t * 0.83 + 0.6) * aBob.z;
         float pitch = sin(t * 1.21 + 2.4) * aBob.z * 0.55;
         float cr = cos(roll), sr = sin(roll);
         float cp = cos(pitch), sp = sin(pitch);
         vec3 q = transformed;
         q = vec3(q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z);
         q = vec3(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
         transformed = q + vec3(0.0, heave, 0.0);
       }`
    );
  });
}

/** Crowd idle + cheer. aWind.x is the per-spectator phase. */
export function patchCrowd(mat: THREE.Material, u: Shared) {
  patch(mat, 'crowd', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uCheer = u.uCheer;
    sh.vertexShader = 'attribute vec4 aWind;\nuniform float uTime; uniform float uCheer;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float ph = aWind.x;
         float idle = sin(uTime * 1.7 + ph) * 0.018 + sin(uTime * 2.9 + ph * 1.7) * 0.008;
         // cheer: a sharp hop, staggered so the stand ripples instead of pulsing
         float ct = fract(uTime * 0.7 + ph * 0.11);
         float hop = max(0.0, sin(ct * 3.14159)) * uCheer * (0.25 + aWind.w * 0.35);
         float sway = sin(uTime * 1.1 + ph * 0.7) * 0.035 * (0.4 + uCheer);
         transformed.y += idle + hop;
         transformed.x += sway * smoothstep(0.4, 1.6, transformed.y);
         // arms up when cheering: the arm verts are flagged via uv.y > 0.92
         transformed.y += step(0.92, uv.y) * uCheer * 0.34;
       }`
    );
  });
}

/** Cloth wave for flags, banners and laundry. */
export function patchCloth(mat: THREE.Material, u: Shared, amp = 1) {
  patch(mat, 'cloth' + amp.toFixed(2), (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uWindAmp = u.uWindAmp;
    sh.uniforms.uClothAmp = { value: amp };
    sh.vertexShader = 'attribute vec4 aWind;\nuniform float uTime; uniform float uWindAmp; uniform float uClothAmp;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float u0 = uv.x;                     // 0 at the mast / line, 1 at the free edge
         float ph = aWind.x;
         float w = sin(u0 * 7.0 - uTime * 4.2 + ph) * 0.5 + sin(u0 * 12.0 - uTime * 6.7 + ph * 1.7) * 0.22;
         float g = u0 * u0;                   // rooted edge stays put
         transformed.z += w * g * 0.30 * uClothAmp * uWindAmp;
         transformed.y += sin(u0 * 5.0 - uTime * 3.1 + ph) * g * 0.07 * uClothAmp * uWindAmp;
         transformed.x -= g * 0.035 * uClothAmp * abs(w);
       }`
    );
  });
}

/** Gulls: each instance flies its own circle, wings flap. Zero CPU. */
export function patchBird(mat: THREE.Material, u: Shared) {
  patch(mat, 'bird', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = 'attribute vec4 aBob;\nuniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         // aBob = (orbit radius, angular speed, phase, flap rate)
         float a = uTime * aBob.y + aBob.z;
         float flap = sin(uTime * aBob.w + aBob.z * 3.0);
         // wing dihedral from |uv.x - 0.5|, the span coordinate
         float span = abs(uv.x - 0.5) * 2.0;
         transformed.y += flap * span * span * 0.42;
         transformed.z -= flap * span * 0.06;
         float ca = cos(a), sa = sin(a);
         vec3 q = vec3(transformed.x * ca - transformed.z * sa, transformed.y, transformed.x * sa + transformed.z * ca);
         transformed = q + vec3(sa * aBob.x, sin(a * 2.0 + aBob.z) * 1.6, -ca * aBob.x);
       }`
    );
  });
}

/**
 * Aerial perspective for the distant backdrop.
 *
 * ROUND 4 ROOT FIX. The previous version injected at `<dithering_fragment>`,
 * which is AFTER `<fog_fragment>` — so it ran last and overwrote the scene fog
 * with a single constant warm cream at up to 78% strength. The sky system's fog
 * is a height-attenuated Beer integral whose colour is sampled per view azimuth
 * out of the actual atmosphere model; it already lands the backdrop layers at
 * roughly 21% / 45% / 78% / 92% haze at 250 m / 600 m / 1.5 km / 4 km. That
 * ladder IS the depth cue, and stamping one cream value on top of it is exactly
 * why every distant hill came out the same tan and read as cardboard.
 *
 * So this now injects BEFORE `<fog_fragment>` and does only the half of aerial
 * perspective a fog lerp cannot do on its own:
 *   · saturation collapses faster than value — the first thing distance takes
 *     off a landform is its colour, not its brightness;
 *   · the residual tint is warm looking into the sun and cool-violet looking
 *     away from it, matching what the sky's own haze does at 14° elevation, so
 *     the two agree at the horizon instead of meeting at a seam;
 *   · the haze layer thins with altitude, so a summit stays crisper than the
 *     valley under it and one landform separates from itself.
 * The scene fog then runs on top and carries the convergence.
 */
export function patchAerial(mat: THREE.Material, u: Shared, near = 220, far = 4400) {
  patch(mat, 'aerial', (sh) => {
    sh.uniforms.uCam = u.uCam;
    sh.uniforms.uSunW = u.uSunWorld;
    sh.uniforms.uAerial = { value: new THREE.Vector2(near, far) };
    sh.uniforms.uHazeWarm = { value: new THREE.Color(PAL.skyWarm) };
    // The cool end of the horizon at golden hour: a violet-grey, never blue.
    sh.uniforms.uHazeCool = { value: new THREE.Color(0xa9b0c8) };
    sh.vertexShader = 'varying vec3 vWorldA;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWorldA = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader =
      'varying vec3 vWorldA; uniform vec3 uCam; uniform vec2 uAerial; uniform vec3 uSunW; uniform vec3 uHazeWarm; uniform vec3 uHazeCool;\n' +
      sh.fragmentShader.replace(
        '#include <fog_fragment>',
        `{
           float d = distance(vWorldA, uCam);
           float h = smoothstep(uAerial.x, uAerial.y, d);
           // the haze is a LAYER: thin it with altitude so summits stay crisper
           h *= mix(1.0, 0.40, clamp((vWorldA.y - uCam.y) / 400.0, 0.0, 1.0));
           vec3 fwd = vWorldA - uCam; fwd.y = 0.0;
           vec3 sunXZ = vec3(uSunW.x, 0.0, uSunW.z);
           float az = dot(normalize(fwd + vec3(1e-4, 0.0, 1e-4)), normalize(sunXZ + vec3(1e-4, 0.0, 1e-4)));
           // ROUND 2. The azimuth ramp used to open at az = -0.45, i.e. 117
           // degrees off the sun, so five sixths of the horizon was being
           // painted with the WARM haze key. Combined with the desaturation
           // below that is a machine for turning any authored colour into the
           // same orange, and it is the direct cause of "four separate ranges
           // at four different distances all render as the same solid orange".
           // Golden hour genuinely is warm looking INTO the sun and violet-blue
           // looking away from it, and that contrast across the sky is most of
           // what makes the hour look like the hour. Narrowed to the near-sun
           // sector so the ladder gets both ends of it.
           vec3 haze = mix(uHazeCool, uHazeWarm, smoothstep(0.15, 0.92, az));
           float l = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           // 0.82 -> 0.42. Aerial perspective does desaturate, but 82% at the
           // far band destroyed the band keys BEFORE the haze tint ran, so the
           // ladder's hue separation never survived to be seen — every layer
           // arrived as neutral grey and left painted with the same haze. The
           // band table's own pre-fade (see BACKDROP_BANDS) now carries the
           // convergence, and it can do it per band, which this cannot.
           gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(l), h * 0.42);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, h * 0.34);
         }
         #include <fog_fragment>`
      );
  });
}

/**
 * ============================================================================
 *  patchBackdropForm — ROUND 2 ROOT FIX FOR "EVERY LANDFORM IS A FLAT ORANGE
 *  FILL AND ALL FOUR BANDS COLLAPSE INTO ONE PLANE".
 * ============================================================================
 *  The band table was authored as a HUE ladder — warm stone, neutral, blue-grey,
 *  violet-blue — on the assumption that hue is the one thing distance cannot
 *  take away. That assumption is false in this renderer, and measurably so.
 *  `src/render/Sky.ts` fog rotates every fragment onto the haze's own
 *  chromaticity at 1.85x the Beer rate, capped at 0.96:
 *
 *      krDrained = krHazeCol * ( krOwnL / krHazeL )
 *
 *  i.e. it KEEPS THE FRAGMENT'S LUMINANCE AND THROWS ITS HUE AWAY. At the near
 *  band (~580 m) that is already 79% of the way there; from the range band out
 *  it is saturated. So by the time a ridge reaches the frame, the only channel
 *  that has survived is VALUE — and the four bands were authored at luminances
 *  of 0.66 / 0.61 / 0.62 / 0.68. Four ranges at four distances, all the same
 *  brightness, all painted the same orange by the haze. Cut paper, exactly as
 *  reported, and no amount of hue authoring could ever have fixed it.
 *
 *  Two things follow, and both live here:
 *
 *  (1) THE LADDER HAS TO BE A VALUE LADDER. Aerial perspective in paint is a
 *      value ramp: the nearest headland is the darkest thing on the horizon and
 *      each successive ridge steps up toward the sky. This applies that ramp to
 *      the SHADED result, per pixel, keyed off camera distance — so it is one
 *      continuous ramp rather than four steps, and two ridges of the same band
 *      at different depths still separate from each other.
 *
 *  (2) THE BACKDROP WAS ALSO SIMPLY TOO BRIGHT. Lit by a 4.2-intensity key on a
 *      pale albedo, every ridge was landing in the top of the ACES shoulder,
 *      where the grade's own highlight-desaturation rolloff (§2) crushes both
 *      contrast AND chroma. All of `ridgeGeo`'s strata, scrub patches, spur
 *      ribs, toe AO and sun-catch rim were being computed and then flattened by
 *      the tone curve. Pulling the near end of the ladder down to ~0.42 moves
 *      the whole horizon back onto the straight part of the curve, and every one
 *      of those terms becomes visible again for free.
 *
 *  On top of that it adds what a single 12–160 m-per-tile rock map cannot: three
 *  macro octaves at 70 / 22 / 6 m, a vertical strata gradient, and an explicit
 *  sunlit-face vs shaded-face albedo split. The split is deliberately an ALBEDO
 *  term, not a light term: at this triangle density the real key has almost no
 *  normal variation to model with, which is the literal reason the faces read as
 *  one value. Per-pixel form colour is what fills that in.
 */
export function patchBackdropForm(mat: THREE.Material, u: Shared, nearD = 260, farD = 2400, nearV = 0.42, farV = 0.78) {
  patch(mat, 'bdform', (sh) => {
    sh.uniforms.uCamF = u.uCam;
    sh.uniforms.uSunF = u.uSunWorld;
    sh.uniforms.uBdVal = { value: new THREE.Vector4(nearD, farD, nearV, farV) };
    // Deliberately plain multipliers rather than THREE.Colors: these are a
    // RATIO applied to whatever albedo the band already has, and a hex colour
    // would drag every band toward one hue and undo the ladder. -25% toward the
    // shadow teal on the away-flanks, +16% warm on the sun-facing ones, which is
    // the terminator contrast the note asks for and is balanced about 1.0 so it
    // does not change the band's overall exposure.
    sh.uniforms.uBdShade = { value: new THREE.Vector3(0.70, 0.76, 0.90) };
    sh.uniforms.uBdSun = { value: new THREE.Vector3(1.18, 1.12, 0.99) };
    sh.vertexShader =
      'varying vec3 vBdW; varying vec3 vBdN;\n' +
      sh.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vBdN = normalize(mat3(modelMatrix) * objectNormal);')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBdW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader =
      `varying vec3 vBdW; varying vec3 vBdN;
       uniform vec3 uCamF; uniform vec3 uSunF; uniform vec4 uBdVal;
       uniform vec3 uBdShade; uniform vec3 uBdSun;
       float bdH(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 41.3); return fract(p.x * p.y); }
       float bdN2(vec2 p){
         vec2 i = floor(p), f = fract(p);
         f = f * f * (3.0 - 2.0 * f);
         return mix(mix(bdH(i), bdH(i + vec2(1.0, 0.0)), f.x),
                    mix(bdH(i + vec2(0.0, 1.0)), bdH(i + vec2(1.0, 1.0)), f.x), f.y);
       }\n` +
      sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             // Three macro octaves. Sampled on the world XZ plane plus altitude,
             // so a flank reads as bedded rock rather than as a projected
             // wallpaper, and none of them is finer than 6 m — anything smaller
             // than that is below a pixel at 600 m and can only alias.
             vec2 q = vBdW.xz + vBdW.y * 0.42;
             float o1 = bdN2(q / 70.0);
             float o2 = bdN2(q / 22.0 + 13.7);
             float o3 = bdN2(q / 6.0 - 41.1);
             float macro = o1 * 0.54 + o2 * 0.31 + o3 * 0.15;
             // Strata: horizontal bedding, warped by the coarse octave so the
             // bands wander with the rock instead of ruling round the landform.
             float bed = sin((vBdW.y + o1 * 26.0) * 0.19) * 0.5 + 0.5;
             diffuseColor.rgb *= 0.78 + macro * 0.44 + bed * 0.10;
             // SUNLIT FACE vs SHADED FACE. An albedo-space terminator, because
             // the real key has almost no normal variation to work with out here.
             float sf = dot(normalize(vBdN), uSunF);
             float lit = smoothstep(-0.30, 0.55, sf);
             diffuseColor.rgb *= mix(uBdShade, uBdSun, lit);
             // and a warm rim on the faces that actually turn into the sun
             diffuseColor.rgb *= 1.0 + vec3(0.16, 0.11, 0.03) * smoothstep(0.58, 0.95, sf);
           }`
        )
        .replace(
          '#include <fog_fragment>',
          `{
             // THE VALUE LADDER. Applied to the shaded result and before any fog,
             // so the haze's luminance-preserving chroma drain carries it intact.
             float bdD = distance(vBdW, uCamF);
             float bdT = smoothstep(uBdVal.x, uBdVal.y, bdD);
             gl_FragColor.rgb *= mix(uBdVal.z, uBdVal.w, bdT);
           }
           #include <fog_fragment>`
        );
  });
}

/**
 * Strip the hue out of a material's albedo map, keeping its luminance detail.
 *
 * The backdrop is one merged mesh sharing one rock texture, and every layer of
 * the horizon has to be a different colour — the near headlands olive and warm,
 * the far range cool and pale. Multiplying a tan rock albedo by a vertex tint
 * cannot get there: it drags everything back toward the tan, which is how
 * sixteen background masses at four distances all ended up the same colour.
 *
 * Desaturating the map to its own luminance (brightness-preserving, so nothing
 * darkens) hands hue authority entirely to the vertex colour, while the map
 * keeps doing the job it is actually good for at this distance: strata, grain
 * and the break-up that stops a kilometre of hillside being one flat value.
 */
export function patchDesatMap(mat: THREE.Material, amount = 0.86) {
  const a = clamp(amount, 0, 1).toFixed(3);
  patch(mat, 'desatmap' + a, (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       #ifdef USE_MAP
         { float kL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(kL), ${a}); }
       #endif`
    );
  });
}

// ---------------------------------------------------------------------------
// Material library
// ---------------------------------------------------------------------------

export class MatLib {
  readonly tex: TexLib;
  private env: THREE.Texture | null = null;
  private all: THREE.Material[] = [];

  wall!: THREE.MeshStandardMaterial;
  roof!: THREE.MeshStandardMaterial;
  trim!: THREE.MeshStandardMaterial;
  wood!: THREE.MeshStandardMaterial;
  woodInst!: THREE.MeshStandardMaterial;
  stone!: THREE.MeshStandardMaterial;
  stoneInst!: THREE.MeshStandardMaterial;
  metal!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshPhysicalMaterial;
  fabric!: THREE.MeshStandardMaterial;
  sponsor!: THREE.MeshStandardMaterial;
  rubber!: THREE.MeshStandardMaterial;
  crowd!: THREE.MeshStandardMaterial;
  cloth!: THREE.MeshStandardMaterial;
  banner!: THREE.MeshStandardMaterial;
  bunting!: THREE.MeshStandardMaterial;
  laundry!: THREE.MeshStandardMaterial;
  rope!: THREE.MeshStandardMaterial;
  backdrop!: THREE.MeshStandardMaterial;
  shadowDecal!: THREE.MeshBasicMaterial;
  vergeDecal!: THREE.MeshStandardMaterial;
  lamp!: THREE.MeshStandardMaterial;
  bird!: THREE.MeshStandardMaterial;
  flowerMat!: THREE.MeshStandardMaterial;
  netMat!: THREE.MeshStandardMaterial;

  constructor(renderer: THREE.WebGLRenderer, readonly u: Shared) {
    this.tex = new TexLib(renderer);
    this.build();
  }

  /**
   * Pull a surface from the material specialist's shared cache. `Ctx` has no
   * slot for that system, so it publishes a module singleton; `variant()` hands
   * back a private clone that shares the texture set, which is the only safe
   * thing to patch. Falls back to our own generator if the call fails — the
   * scenery must not refuse to boot because another module moved underneath it.
   */
  private sharedDown = false;
  private shared(name: string, key: string, tweak?: (m: any) => void): THREE.MeshStandardMaterial | null {
    if (this.sharedDown) return null;
    try {
      const m = getMaterials().variant(name, { key }) as THREE.MeshStandardMaterial;
      if (!m || !(m as any).isMaterial) return null;
      tweak?.(m);
      this.all.push(m);
      return m;
    } catch (e) {
      // One failure means the shared cache cannot build here at all; retrying
      // for every surface would repeat its texture work a dozen times over.
      this.sharedDown = true;
      console.warn('[scenery] shared materials unavailable, using local set', e);
      return null;
    }
  }

  private std(maps: MatMaps, o: Partial<THREE.MeshStandardMaterialParameters> = {}, normalScale = 1): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1.0,
      ...o,
    });
    m.normalScale.set(normalScale, normalScale);
    this.all.push(m);
    return m;
  }

  private build() {
    const T = this.tex;

    // A 14° key on rough plaster, coursed stone or sawn timber should throw a
    // strong micro-shadow. The shared library is tuned for a higher sun; these
    // are OUR clones of it, so raising the normal scale here is safe and is the
    // difference between a painted box and a raked surface.
    const vcN = (n: number) => (m: any) => {
      m.vertexColors = true;
      if (m.normalScale) m.normalScale.set(n, n);
    };
    const nOnly = (n: number) => (m: any) => {
      if (m.normalScale) m.normalScale.set(n, n);
    };
    this.wall = this.shared('stucco', 'scenery-wall', vcN(0.85)) ?? this.std(T.plaster(), { vertexColors: true }, 0.85);
    this.roof = this.shared('roof-tile', 'scenery-roof', vcN(0.8)) ?? this.std(T.roofTile(), { vertexColors: true }, 0.8);
    this.trim = this.shared('marble', 'scenery-trim', vcN(1.5)) ?? this.std(T.stone(), { vertexColors: true }, 1.5);
    // The village had ONE surface response across every wall, roof and tower,
    // which is why wide.png reads as a single extruded mass: at a 14° sun a
    // fired terracotta tile and a lime-plaster wall are two completely different
    // materials, and that difference is most of what separates roof from wall
    // at silhouette distance. Split them properly (§4):
    //   plaster — matte, effectively no environment contribution
    //   tile    — noticeably glossier, and it samples the env so the low sun
    //             runs a sheen down every pan
    patchRoughVary(this.wall, 0.78, 1.3, 8.5);
    patchRoughVary(this.roof, 0.5, 0.86, 6.0);
    // Albedo break-up too, not just roughness. The roof is the worse offender by
    // far — a terracotta pan tile is a strong regular stripe, so a whole village
    // of them at one scale and one tint moirés along every ridge and repeats
    // visibly within a single frame (wide.png). 5 m puts the variation at
    // roughly one roof plane, which is the "per-building vertex-colour tint"
    // read for the cost of two hashes and without a per-building attribute.
    patchMacroBreak(this.roof, 5.0, 0.19);
    patchMacroBreak(this.wall, 7.5, 0.11);
    this.wall.envMapIntensity = 0.25;
    this.roof.envMapIntensity = 0.9;

    this.wood = this.shared('wood-plank', 'scenery-wood', vcN(2.2)) ?? this.std(T.wood(), { vertexColors: true }, 2.2);
    patchRoughVary(this.wood, 0.66, 1.3, 3.2);
    this.woodInst = this.woodVariant();

    this.stone = this.shared('stone-wall', 'scenery-stone', vcN(2.6)) ?? this.std(T.stone(), { vertexColors: true }, 2.6);
    this.stoneInst = this.shared('stone-wall', 'scenery-stone-inst', nOnly(2.6)) ?? this.std(T.stone(), {}, 2.6);
    patchRoughVary(this.stone, 0.7, 1.25, 5.0);
    patchInstUv(this.stoneInst);
    patchTint(this.stoneInst);
    patchLod(this.stoneInst, this.u);

    this.metal = this.shared('metal-painted', 'scenery-metal') ?? this.std(T.paintedMetal(), {}, 0.6);
    patchInstUv(this.metal);
    patchTint(this.metal);
    patchLod(this.metal, this.u);

    // Recessed panes: dark, smooth, and they must catch the env — never a
    // painted rectangle. Slight metalness keeps the reflection crisp.
    this.glass =
      (this.shared('glass', 'scenery-glass', (m: any) => {
        // Recessed panes read as near-black mirrors under a low sun. 0.08 ->
        // 0.05 with a clearcoat on top: at 0.08 the specular lobe is narrow
        // enough that a pane has to be aimed almost exactly at the sun to
        // return anything, which is why the whole village rendered at one matte
        // roughness with the glass indistinguishable from the stucco. A
        // clearcoat gives it a second, wider sky term that fires at every angle.
        m.color.set(0x1b2b33);
        m.roughness = 0.05;
        m.envMapIntensity = 2.6;
        if ('clearcoat' in m) {
          m.clearcoat = 1;
          m.clearcoatRoughness = 0.05;
        }
      }) as unknown as THREE.MeshPhysicalMaterial) ??
      new THREE.MeshPhysicalMaterial({
        color: 0x1b2b33,
        roughness: 0.05,
        metalness: 0.25,
        envMapIntensity: 2.6,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      });
    if (this.all.indexOf(this.glass) < 0) this.all.push(this.glass);
    patchLod(this.glass, this.u);

    this.fabric = this.std(T.fabricAtlas(), { side: THREE.DoubleSide }, 0.5);
    patchInstUv(this.fabric);
    patchLod(this.fabric, this.u);

    // 0.4 -> 1.05. The atlas normal now carries proud letterforms, panel screws
    // and an 8 mm board bevel rather than weathering dither, so there is real
    // relief to show and holding it at 0.4 was throwing it away. envMapIntensity
    // lifted so the varnished field (roughness 0.35) actually returns a sky
    // sheen against the matte ink at 0.72 — two responses per board, which is
    // what the close range in corner.png is asking for.
    this.sponsor = this.std(T.sponsorAtlas(), { side: THREE.FrontSide, vertexColors: true, envMapIntensity: 1.15 }, 1.05);
    patchInstUv(this.sponsor);
    patchLod(this.sponsor, this.u);

    this.rubber = this.shared('rubber', 'scenery-rubber') ?? this.std(T.paintedMetal(), { color: 0x2b2b30 }, 1.4);
    // THE BLACK HOLE IN scenery.png. It was reported as "a pure-black void in
    // the terrain, probably a missing tunnel-bore cap". It is not: zoomed, it is
    // a tyre stack, sunlit and reading as brown on its lower half and clamped
    // flat to #000000 on the half that is in its own shadow. Rubber albedo is
    // genuinely dark, the shared map is darker still, and the per-instance tint
    // multiplies it down again — so once the key is off it, there is nothing
    // left. §3 forbids pure #000 in albedo and §9.6 forbids pure-black shadows,
    // and a black hole in the middle of a golden-hour frame is the most
    // conspicuous possible way to break both.
    //
    // Two lifts, both physical rather than a paint-over: rubber does return a
    // little sky (it is a dielectric, not a light sink), and the emissive is a
    // warm ambient floor a stop and a half below anything else in the scene, so
    // the shaded side bottoms out around #17120f instead of at zero.
    this.rubber.envMapIntensity = 0.55;
    this.rubber.emissive = new THREE.Color(0x17120f);
    this.rubber.emissiveIntensity = 1;
    patchInstUv(this.rubber);
    patchTint(this.rubber);
    patchLod(this.rubber, this.u);

    // ---- crowd ------------------------------------------------------------
    // The round-1 material was `{ vertexColors: true, roughness: 0.78 }` and
    // nothing else — the flat-untextured-standard case §4 calls an automatic
    // fail, on the asset that appears in more frames than any other.
    //
    // The maps ride on UV CHANNEL 1, not 0. Channel 0 on a spectator is not a
    // texture coordinate at all: `patchTint(mask)` reads uv.x as "is this vertex
    // clothing or skin" and `patchCrowd` reads uv.y > 0.92 as "is this vertex an
    // arm", both of which are constant per sub-mesh. Overwriting it to texture
    // the figure would repaint the skin and freeze the cheer. `spectatorGeo` now
    // also emits a real cylindrical `uv1`, and `aUv` from `patchInstUv` then
    // picks which of the nine garment cards this particular spectator wears —
    // so neighbours in a rank do not sample the same cell.
    const cm = T.crowdCloth();
    for (const t of [cm.map, cm.normalMap, cm.roughnessMap]) if (t) t.channel = 1;
    this.crowd = new THREE.MeshStandardMaterial({
      map: cm.map,
      normalMap: cm.normalMap,
      roughnessMap: cm.roughnessMap,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.35,
    });
    this.crowd.normalScale.set(0.7, 0.7);
    this.all.push(this.crowd);
    patchInstUv(this.crowd);
    patchTint(this.crowd, true);
    patchCrowd(this.crowd, this.u);
    patchLod(this.crowd, this.u);

    this.cloth = this.std(T.fabricAtlas(), { side: THREE.DoubleSide }, 0.5);
    patchInstUv(this.cloth);
    patchCloth(this.cloth, this.u, 1);
    patchLod(this.cloth, this.u);

    // Start-line banner: its own printed sheet, not a stripe from the atlas.
    // Channel 1, because channel 0 on a hanging banner is the cloth patch's
    // root->free coordinate and not a texture coordinate at all — see
    // `bannerUvs` for why the print was arriving rotated ninety degrees.
    const bm = T.bannerCloth();
    for (const t of [bm.map, bm.normalMap, bm.roughnessMap]) if (t) t.channel = 1;
    this.banner = this.std(bm, { side: THREE.DoubleSide }, 1.1);
    patchCloth(this.banner, this.u, 1.15);

    // Bunting: one triangle per flag, tinted per instance, strung on a rope.
    this.bunting = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0, side: THREE.DoubleSide });
    this.all.push(this.bunting);
    patchTint(this.bunting);
    patchCloth(this.bunting, this.u, 0.85);
    patchLod(this.bunting, this.u);

    const lt = T.laundry();
    this.laundry = new THREE.MeshStandardMaterial({ map: lt, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
    this.laundry.alphaToCoverage = true;
    this.all.push(this.laundry);
    patchInstUv(this.laundry);
    patchCloth(this.laundry, this.u, 0.5);
    patchLod(this.laundry, this.u);

    this.rope = new THREE.MeshStandardMaterial({ color: 0xc7b088, roughness: 0.95, metalness: 0 });
    this.all.push(this.rope);

    // The backdrop wants the CLIFF ROCK, not the ashlar stone wall: it is the
    // one surface in the shared library authored with macro strata (its own
    // notes put bands at 12 m and 34 m on top of the 4 mm grain), which is
    // precisely the scale that survives out to a kilometre and the only reason
    // a distant ridge reads as rock rather than as a painted flat. Its hue is
    // then stripped so the four horizon layers can each be their own colour —
    // see `patchDesatMap`.
    this.backdrop =
      this.shared('cliff-rock', 'scenery-backdrop', (m: any) => {
        m.vertexColors = true;
        m.roughness = 1;
        m.metalness = 0;
        // The backdrop's uv scale is 12–160 m per tile, so the map's 4 mm grain
        // arrives on a mountain as roughly half-metre relief, which is real
        // detail rather than aliasing. 0.45 was set when the concern was crawl;
        // what it actually did was flatten the one surface in the game lit by a
        // 14° key, where a hillside should show an unmistakable lit face and
        // shadowed face. 0.95 lets the sun model the form.
        if (m.normalScale) m.normalScale.set(0.95, 0.95);
        m.envMapIntensity = 0.4;
      }) ?? this.std(T.stone(), { vertexColors: true, roughness: 1 }, 0.4);
    // 0.86 handed hue authority to the vertex colour but also flattened the
    // map's own value variation toward one luminance. 0.70 keeps the band
    // ladder (the vertex tints still dominate) and gives the rock back enough
    // of its own colour break-up to stop a kilometre of hillside reading as a
    // single painted tone.
    patchDesatMap(this.backdrop, 0.7);
    // Macro form + the value ladder. MUST be registered before `patchAerial`:
    // both hang off `#include <fog_fragment>` and the ladder has to run on the
    // shaded colour first, with the aerial tint and then the scene fog on top.
    // See the note on `patchBackdropForm` for why value, and only value, is the
    // channel that survives out here.
    patchBackdropForm(this.backdrop, this.u, 260, 2400, 0.42, 0.80);
    // The ramp is quoted against the frustum the backdrop actually lives in, not
    // against a nominal 4.4 km. `Camera` sets far = 3000 and the outermost band
    // sits at 1.95–2.6 km, so a 4400 m ramp spent only its first 60% on the whole
    // ladder and the deepest layer came out barely more desaturated than the one
    // in front of it. 200–2900 puts the four bands at roughly 2% / 14% / 39% /
    // 75% of the ramp, which is the ordering the band table is built around.
    // 200 -> 620. With `patchBackdropForm` now carrying the depth separation as
    // a value ramp, this pass only has to supply the residual azimuth tint, and
    // opening at 200 m had it at a third strength on the coast band — which is
    // where the last of the ridge's own modelling still has to survive. Pushed
    // out so the near two bands keep their N·L, and the mixes below were already
    // capped at 0.42 / 0.34 so no band can ever reach a full haze wash.
    patchAerial(this.backdrop, this.u, 620, 2900);

    this.shadowDecal = new THREE.MeshBasicMaterial({
      map: T.contactShadow(),
      transparent: true,
      opacity: 0.44,
      color: 0x33241c,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      fog: true,
      toneMapped: false,
    });
    this.all.push(this.shadowDecal);
    patchInstUv(this.shadowDecal);
    patchInstAlpha(this.shadowDecal);
    patchLod(this.shadowDecal, this.u);

    // Verge transition band. Lit, not unlit: a dirt strip that ignores the key
    // would sit at one value through shadow and sun and read as a painted
    // decal. depthWrite off + polygon offset so it lies on the terrain without
    // fighting it, and it never casts.
    this.vergeDecal = this.std(T.vergeScuff(), { transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -5 }, 1.8);
    patchLod(this.vergeDecal, this.u);

    this.flowerMat = this.foliage(T.flowers(), { alphaTest: 0.4, trans: 0.9, wind: true });
    this.netMat = new THREE.MeshStandardMaterial({ map: T.netWeave(), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
    this.netMat.alphaToCoverage = true;
    this.all.push(this.netMat);
    patchTint(this.netMat);
    patchLod(this.netMat, this.u);

    this.lamp = new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: 0xffc46b, emissiveIntensity: 3.2, roughness: 0.4, metalness: 0 });
    this.all.push(this.lamp);
    patchLod(this.lamp, this.u);

    this.bird = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
    this.all.push(this.bird);
    patchBird(this.bird, this.u);
    patchTint(this.bird);
  }

  /**
   * A fresh instanced-timber material. Callers that need extra vertex work
   * (the moored boats bob on the GPU) must not patch the shared one.
   */
  woodVariant(key = 'scenery-wood-inst-' + this.variantSeq++): THREE.MeshStandardMaterial {
    const m =
      this.shared('wood-plank', key, (mm: any) => {
        if (mm.normalScale) mm.normalScale.set(2.2, 2.2);
      }) ?? this.std(this.tex.wood(), {}, 2.2);
    patchInstUv(m);
    patchTint(m);
    // resin-sealed vs weathered-grey: a plank-scale roughness split so the
    // start arch is not one uniform gloss (§4)
    patchRoughVary(m, 0.62, 1.34, 2.4);
    patchLod(m, this.u);
    return m;
  }

  private variantSeq = 0;

  /** Foliage materials are built on demand because Foliage owns their textures. */
  foliage(map: THREE.Texture, opts: { alphaTest?: number; trans?: number; wind?: boolean; lod?: boolean; color?: number; vcol?: boolean } = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map,
      color: opts.color ?? 0xffffff,
      // `vcol` is opt-in: only geometry that actually carries a `color`
      // attribute may ask for it, and only the palm frond does (its junction
      // AO). Turning it on globally would render every other foliage set black.
      vertexColors: opts.vcol === true,
      alphaTest: opts.alphaTest ?? 0.42,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0,
      // Leaves are thin: flipping the normal on backfaces keeps them lit from
      // whichever side the sun is actually on.
      shadowSide: THREE.DoubleSide,
    });
    // MSAA is on (Renderer.msaaSamples) but a plain alphaTest discards whole
    // fragments and never touches the coverage mask, so every leaf edge came
    // out of round 1 as a 1-bit stair-step that crawled. alphaToCoverage hands
    // the cut to the sample mask instead, which is what makes MSAA antialias a
    // cut-out at all. It is free — no sorting, no transparency pass.
    m.alphaToCoverage = true;
    this.all.push(m);
    patchTint(m);
    patchTranslucency(m, this.u, opts.trans ?? 1);
    if (opts.wind !== false) patchWind(m, this.u);
    if (opts.lod !== false) patchLod(m, this.u);
    return m;
  }

  register(m: THREE.Material) {
    this.all.push(m);
  }

  /** Sky agent produces the env map after us on some quality paths; adopt it late. */
  setEnv(env: THREE.Texture | null) {
    if (env === this.env) return;
    this.env = env;
    for (const m of this.all) {
      const a = m as any;
      if ('envMap' in a) {
        a.envMap = env;
        a.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const m of this.all) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Prop generators
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export function trs(px: number, py: number, pz: number, ry: number, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): THREE.Matrix4 {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  return _m.compose(_v.set(px, py, pz), _q, _s.set(sx, sy, sz)).clone();
}

// --- village house ---------------------------------------------------------

export interface HouseParts {
  walls: GeoAccum;
  roof: GeoAccum;
  trim: GeoAccum;
  shutters: { m: THREE.Matrix4; color: THREE.Color; uv: THREE.Vector4 }[];
  glass: THREE.Matrix4[];
  balcony: THREE.Matrix4[];
  flowerbox: { m: THREE.Matrix4; color: THREE.Color }[];
  awning: { m: THREE.Matrix4; uv: THREE.Vector4 }[];
  door: { m: THREE.Matrix4; color: THREE.Color }[];
  lamp: THREE.Matrix4[];
  /** world anchors for laundry lines: (position, height) */
  lineAnchors: THREE.Vector3[];
}

/** Pass the shared accumulators so a whole street merges into three meshes. */
export function newHouseParts(walls?: GeoAccum, roof?: GeoAccum, trim?: GeoAccum): HouseParts {
  return {
    walls: walls ?? new GeoAccum(),
    roof: roof ?? new GeoAccum(),
    trim: trim ?? new GeoAccum(),
    shutters: [],
    glass: [],
    balcony: [],
    flowerbox: [],
    awning: [],
    door: [],
    lamp: [],
    lineAnchors: [],
  };
}

/**
 * Wall AO for a building of known height: contact darkening at the base AND an
 * eave shadow under the roof overhang. Without the second term the roofline is
 * a hard line and the roof reads as pasted onto the wall (§9.4).
 */
const wallAOFor = (h: number) => (_x: number, y: number, _z: number) =>
  lerp(0.42, 1, smoothstep(0, 1.6, y)) * lerp(0.5, 1, smoothstep(h, h - 1.0, y));

/**
 * Gable end: the triangle between the wall head and the underside of the two
 * roof slopes, extruded `thick` along X. Without this the roof is two floating
 * slabs with an open triangular void at each end, which is precisely what
 * makes a hipped-box village read as flat planes hovering over the walls.
 */
function gableWedge(halfZ: number, rise: number, thick: number): THREE.BufferGeometry {
  const hx = thick / 2;
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const idx: number[] = [];
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    const base = P.length / 3;
    for (const v of [a, b, c]) {
      P.push(v[0], v[1], v[2]);
      N.push(n[0], n[1], n[2]);
      // planar UV off the ZY plane so the plaster does not stretch
      U.push(v[2] * 0.42, v[1] * 0.42);
    }
    idx.push(base, base + 1, base + 2);
  };
  for (const s of [-1, 1]) {
    const x = s * hx;
    const a = [x, 0, -halfZ];
    const b = [x, 0, halfZ];
    const c = [x, rise, 0];
    if (s > 0) tri(a, b, c, [1, 0, 0]);
    else tri(b, a, c, [-1, 0, 0]);
  }
  // two sloping faces closing the wedge sides, and the flat bottom
  const q = (a: number[], b: number[], c: number[], dd: number[], n: number[]) => {
    tri(a, b, c, n);
    tri(a, c, dd, n);
  };
  const sl = Math.hypot(halfZ, rise);
  q([-hx, 0, halfZ], [hx, 0, halfZ], [hx, rise, 0], [-hx, rise, 0], [0, halfZ / sl, rise / sl]);
  q([hx, 0, -halfZ], [-hx, 0, -halfZ], [-hx, rise, 0], [hx, rise, 0], [0, halfZ / sl, -rise / sl]);
  q([-hx, 0, -halfZ], [hx, 0, -halfZ], [hx, 0, halfZ], [-hx, 0, halfZ], [0, -1, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  return g;
}

/** Warm terracotta multipliers for the roof map — never the wall pastel. */
/**
 * Roof tint multipliers over the barrel-tile map.
 *
 * These used to spread lightness 0.66–0.94 per house, which sounds like variety
 * and is actually the opposite: it put roofs across the same value range as the
 * pastel walls, so wall and roof stopped separating and the whole hillside
 * collapsed into one brown mass. A Mediterranean hill town is legible because
 * the roofs are ONE constant band — §3's #b5643f — and the walls carry all the
 * variety underneath it. So the spread here is now ±7% of a single terracotta,
 * which is weathering, not colour.
 */
const ROOF_MULT: [number, number, number][] = [
  [0.038, 0.20, 0.70],
  [0.034, 0.22, 0.66],
  [0.042, 0.18, 0.73],
  [0.036, 0.24, 0.68],
  [0.040, 0.20, 0.71],
];

/**
 * Terraced Mediterranean house. Emits merged wall/roof/trim geometry into the
 * shared accumulators and pushes its fittings into shared instance lists, so a
 * street of thirty houses is still a dozen draw calls.
 *
 * `xform` places the house: +Z is the street-facing facade.
 */
export function buildHouse(out: HouseParts, rng: RNG, xform: THREE.Matrix4, w: number, d: number, floors: number, tint: THREE.Color) {
  const floorH = 3.05 + rng() * 0.35;
  const h = floorH * floors + 0.45;
  const wAO = wallAOFor(h);
  const openings: Opening[] = [];
  const winW = 0.95 + rng() * 0.25;
  const winH = 1.55 + rng() * 0.3;
  const cols = Math.max(2, Math.round((w - 1.0) / 2.3));
  const doorCol = (rng() * cols) | 0;
  const winPos: { x: number; y: number; f: number; c: number }[] = [];
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5) / cols) * w - w / 2;
      if (f === 0 && c === doorCol) {
        // a door instead of a window
        openings.push({ x: x - 0.55, y: 0.02, w: 1.1, h: 2.3 });
        continue;
      }
      const y = f * floorH + 1.05;
      openings.push({ x: x - winW / 2, y, w: winW, h: winH });
      winPos.push({ x, y, f, c });
    }
  }
  // Facade with real reveals + three plain sides.
  const facade = wallWithOpenings(w, h, openings.map((o) => ({ x: o.x + w / 2, y: o.y, w: o.w, h: o.h })), 0.22, 0.42);
  facade.translate(-w / 2, 0, d / 2);
  const rearAndSides = new GeoAccum();
  const back = bevelBox(w, h, 0.3, 0.05, 0.42);
  rearAndSides.add(back, trs(0, h / 2, -d / 2 + 0.15, 0), undefined, wAO);
  // Side elevations get real openings too.
  //
  // Round 1 punched only the street facade and left the other three faces as
  // plain boxes, which is fine looking down a street and catastrophic looking
  // ALONG one — drift.png's foreground building is a side wall, and it read as
  // a 500x400 px slab of flat red because there was genuinely nothing on it. A
  // Mediterranean gable end is sparser than the facade, never blank: one or two
  // small windows a floor, no balconies, no shutters.
  const side = bevelBox(0.3, h, d - 0.3, 0.05, 0.42);
  const sideCols = Math.max(1, Math.round((d - 1.4) / 3.1));
  for (const sx of [-1, 1]) {
    const ops: Opening[] = [];
    const glassAt: { z: number; y: number; w: number; h: number }[] = [];
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < sideCols; c++) {
        if (rng() < 0.4) continue;
        const zc = ((c + 0.5) / sideCols) * d;
        const ow = 0.72 + rng() * 0.22;
        const oh = 1.1 + rng() * 0.3;
        const oy = f * floorH + 1.15;
        ops.push({ x: zc - ow / 2, y: oy, w: ow, h: oh });
        // yaw sx*PI/2 maps the wall's local x onto world z = sx * (d/2 - x)
        glassAt.push({ z: sx * (d / 2 - zc), y: oy, w: ow, h: oh });
      }
    }
    if (!ops.length) {
      rearAndSides.add(side, trs(sx * (w / 2 - 0.15), h / 2, 0, 0), undefined, wAO);
      continue;
    }
    // The punched wall is authored facing +Z spanning x in [0, d]; a ±90° yaw
    // turns it into the ±X elevation with its local x running along the depth.
    const sw = wallWithOpenings(d, h, ops, 0.19, 0.42);
    const rot = new THREE.Matrix4().makeRotationY((sx * Math.PI) / 2);
    const mv = new THREE.Matrix4().makeTranslation(sx * (w / 2), 0, (sx * d) / 2);
    rearAndSides.add(sw, mv.multiply(rot), undefined, wAO);
    // a thin backing pier so the punched face still has a wall behind it
    rearAndSides.add(bevelBox(0.16, h, d - 0.3, 0.04, 0.42), trs(sx * (w / 2 - 0.27), h / 2, 0, 0), undefined, wAO);
    for (const gq of glassAt) {
      out.glass.push(
        _m
          .multiplyMatrices(
            xform,
            new THREE.Matrix4().compose(
              new THREE.Vector3(sx * (w / 2 - 0.18), gq.y + gq.h / 2, gq.z),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (sx * Math.PI) / 2, 0)),
              new THREE.Vector3(gq.w * 0.94, gq.h * 0.94, 1)
            )
          )
          .clone()
      );
    }
  }
  // interior floor slab so you never see through an opening into nothing
  rearAndSides.add(bevelBox(w - 0.4, 0.2, d - 0.4, 0.02, 0.42), trs(0, h - 0.4, 0, 0), undefined, () => 0.32);

  // Corner arrises. `wallWithOpenings` produces flat faces meeting at a hard
  // 90°, and §9.6 calls an unchamfered edge the second-biggest amateur tell for
  // a reason: at a 14° sun a true 90° corner catches no specular at all, so two
  // adjacent walls at different angles to the key meet on a hairline instead of
  // on a lit edge. A 6 cm post turned 45° gives every corner a 4 cm facet that
  // takes a highlight and separates the two elevations.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      rearAndSides.add(bevelBox(0.06, h, 0.06, 0.014, 0.42), trs(sx * (w / 2 - 0.02), h / 2, sz * (d / 2 - 0.02), Math.PI / 4), undefined, wAO);

  out.walls.add(facade, xform, tint, wAO);
  const rs = rearAndSides.build();
  if (rs) out.walls.add(rs, xform, tint, undefined);

  // --- roof: two real slabs with thickness, closed gables and capped eaves.
  // The eave overhang runs front/back only; the gable overhang is deliberately
  // tiny so a terrace of houses at 0.5 m centres never has one roof punching
  // through its neighbour's wall.
  const pitch = 0.38 + rng() * 0.14;
  const overZ = 0.46;
  const overX = 0.13;
  const halfZ = d / 2 + overZ;
  const rise = halfZ * pitch;
  const slopeLen = Math.hypot(halfZ, rise);
  const thick = 0.3;
  const rm = ROOF_MULT[(rng() * ROOF_MULT.length) | 0];
  const roofCol = new THREE.Color().setHSL(rm[0], rm[1] * (0.9 + rng() * 0.2), rm[2] * (0.95 + rng() * 0.1));
  // Gable ends first: they close the triangular void the two slopes leave.
  const gab = gableWedge(halfZ - 0.04, rise, 0.26);
  for (const s of [-1, 1]) out.walls.add(gab, _m.multiplyMatrices(xform, trs((s * w) / 2, h, 0, 0)).clone(), tint, () => 0.62);
  // Slopes. Sitting the slab so its UNDERSIDE meets the wall head means the
  // fascia thickness reads at the eave instead of a zero-thickness edge.
  //
  // SIGN MATTERS. Rx(+t) sends local +Z to (0, -sin t, cos t), so the slab on
  // the +Z side needs Rx(+ang) to fall AWAY from the ridge. With the sign
  // inverted the pair slopes up toward the eaves instead of down: a butterfly
  // roof, with the ridge cap and the gable wedge both two metres out of place —
  // which is exactly the "flat planes hovering over the wall tops" read.
  const slab = bevelBox(w + overX * 2, thick, slopeLen, 0.04, 0.9);
  const ang = Math.atan2(rise, halfZ);
  for (const s of [-1, 1]) {
    const mm = new THREE.Matrix4().compose(
      new THREE.Vector3(0, h + rise / 2 + (thick / 2) * Math.cos(ang), (s * halfZ) / 2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(s * ang, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    );
    // darken toward the eave: the underside of the overhang is in shadow and
    // the ridge catches the low sun
    out.roof.add(slab, _m.multiplyMatrices(xform, mm).clone(), roofCol, (_x, y) => lerp(0.68, 1.0, smoothstep(-thick * 0.5, thick * 0.5, y)));
  }
  // Ridge cap, straddling the seam where the two slab TOP faces meet. A slab of
  // perpendicular thickness `thick` laid at `ang` puts its top surface
  // thick/cos(ang) above the underside plane at the ridge, so a cap parked at
  // rise + thick/2 is buried inside the roof and the seam shows through.
  const halfWr = w / 2 + overX;
  const ridgeY = h + rise + thick / Math.cos(ang) + 0.03;
  const ridge = loft((t, o) => o.set(-halfWr + t * halfWr * 2, 0, 0), 3, 8, () => 0.17, 1.4, true, true);
  out.roof.add(ridge, _m.multiplyMatrices(xform, trs(0, ridgeY, 0, 0)).clone(), roofCol.clone().multiplyScalar(1.08));
  // Stone eave band at the wall head. It is narrower than the roof and warm,
  // not white — a white slab wider than the roof is what read as a floating
  // plate in round 1.
  const corn = bevelBox(w + 0.18, 0.15, d + 0.18, 0.035, 0.7);
  out.trim.add(corn, _m.multiplyMatrices(xform, trs(0, h - 0.075, 0, 0)).clone(), new THREE.Color(0xd7c9b0), (_x, y) => lerp(0.55, 1.0, smoothstep(-0.075, 0.02, y)));

  // --- chimney, standing on the ridge so it reads against the sky
  if (rng() < 0.75) {
    const cw = 0.5 + rng() * 0.22;
    const cx = (rng() - 0.5) * (w - 1.6);
    const ch = 1.1 + rng() * 1.0;
    const cy = h + rise * 0.86;
    out.walls.add(bevelBox(cw, ch, cw, 0.04, 0.9), _m.multiplyMatrices(xform, trs(cx, cy + ch / 2 - 0.25, 0.12, 0)).clone(), tint, () => 0.85);
    out.trim.add(bevelBox(cw + 0.2, 0.14, cw + 0.2, 0.03, 1.2), _m.multiplyMatrices(xform, trs(cx, cy + ch - 0.28, 0.12, 0)).clone(), new THREE.Color(0xd9c9b2));
  }

  // --- window fittings
  const shutterCol = new THREE.Color(pick(rng, PAL.shutters));
  // Stains and cast shadows keep the wall's own hue — a neutral grey smear on
  // a pink wall reads as a decal, not as weathering.
  const DRIP = tint.clone().multiplyScalar(0.8).lerp(new THREE.Color(0x9a8b76), 0.42);
  const HEADSHADE = tint.clone().multiplyScalar(0.55).lerp(new THREE.Color(0x5f6070), 0.34);
  for (const wp of winPos) {
    const z = d / 2 + 0.01;
    // Head shadow: a 22 cm strip immediately under the lintel. A 22 cm reveal
    // cannot self-shadow at 60 m, so the shadow it WOULD cast is painted.
    const hs = new THREE.PlaneGeometry(winW + 0.08, 0.24, 1, 1);
    out.walls.add(hs, _m.multiplyMatrices(xform, trs(wp.x, wp.y + winH + 0.12, z + 0.004, 0)).clone(), HEADSHADE, (_x, y) => lerp(1.0, 0.42, smoothstep(-0.12, 0.12, y)));
    // Sill drip stain: runoff tracks off the two sill ends, never a rectangle.
    for (const s of [-1, 1]) {
      const dg = new THREE.PlaneGeometry(0.2, 1.05, 1, 1);
      out.walls.add(dg, _m.multiplyMatrices(xform, trs(wp.x + s * (winW / 2 + 0.11), wp.y - 0.62, z + 0.004, 0)).clone(), DRIP, (_x, y) => lerp(0.66, 1.0, smoothstep(-0.52, 0.5, -y)) * 0.96);
    }
    // stone sill, with a 8 cm drip lip the low sun catches
    out.trim.add(bevelBox(winW + 0.34, 0.1, 0.3, 0.02, 1.4), _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.06, z + 0.06, 0)).clone(), new THREE.Color(0xe8dfce));
    out.trim.add(bevelBox(winW + 0.4, 0.06, 0.08, 0.015, 2.2), _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.13, z + 0.19, 0)).clone(), new THREE.Color(0xdccfba));
    // Recessed glass, sitting at the back of the reveal — with a 1–3° tilt.
    //
    // The material is already a proper physical glass (roughness 0.08,
    // envMapIntensity 2.2), and yet not one pane in wide.png reflects anything.
    // The reason is that every pane in the village was exactly coplanar with its
    // wall, so a whole terrace shares one reflection vector: either they ALL
    // catch the sun disc or, as here, none of them does, and a specular lobe
    // that narrow will almost never be the lucky one. Real glazing is never
    // that true — old timber sashes sit a degree or two out and no two the
    // same. A couple of degrees of scatter is all it takes for a handful of
    // panes on any given hillside to line up on the sun and flare, and that
    // scatter of bright hits is most of what sells a Mediterranean village at
    // golden hour. The pitch is biased UP so a miss samples sky rather than
    // ground.
    out.glass.push(
      _m
        .multiplyMatrices(
          xform,
          trs(wp.x, wp.y + winH / 2, z - 0.20, (rng() - 0.5) * 0.055, winW * 0.94, winH * 0.94, 1, -0.012 - rng() * 0.045, (rng() - 0.5) * 0.03)
        )
        .clone()
    );
    // shutters, one per side, occasionally swung open
    const openA = rng() < 0.4 ? 0.6 + rng() * 0.7 : 0.02;
    for (const s of [-1, 1]) {
      const hingeX = wp.x + s * (winW / 2 + 0.02);
      const mm = new THREE.Matrix4()
        .compose(new THREE.Vector3(hingeX, wp.y + winH / 2, z + 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s * openA, 0)), new THREE.Vector3(1, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation((-s * winW) / 4, 0, 0))
        .multiply(new THREE.Matrix4().makeScale(winW / 2, winH, 1));
      out.shutters.push({ m: _m.multiplyMatrices(xform, mm).clone(), color: shutterCol, uv: new THREE.Vector4(0.5, 1, 0, 0) });
    }
    // flower box on the ground and first floors
    if (wp.f < 2 && rng() < 0.62) {
      out.flowerbox.push({ m: _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.02, z + 0.16, 0, winW / 1.0, 1, 1)).clone(), color: new THREE.Color(pick(rng, [0x8a5a3a, 0x6d6f57, 0xa8927a])) });
    }
    // balcony on upper floors
    if (wp.f >= 1 && rng() < 0.45) {
      out.balcony.push(_m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.06, z + 0.05, 0, Math.max(1, winW + 0.6), 1, 1)).clone());
      if (rng() < 0.6) out.lineAnchors.push(new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(xform, trs(wp.x, wp.y + winH, z + 0.6, 0)).clone()));
    }
  }
  // doors + awning + lamp
  const dx = ((doorCol + 0.5) / cols) * w - w / 2;
  out.door.push({ m: _m.multiplyMatrices(xform, trs(dx, 0.02, d / 2 - 0.06, 0, 1.06, 2.24, 1)).clone(), color: new THREE.Color(pick(rng, PAL.shutters)) });
  out.trim.add(bevelBox(1.5, 0.16, 0.34, 0.03, 1.3), _m.multiplyMatrices(xform, trs(dx, 2.36, d / 2 + 0.1, 0)).clone(), new THREE.Color(0xe8dfce));
  if (rng() < 0.45) {
    const cell = (rng() * 4) | 0;
    out.awning.push({ m: _m.multiplyMatrices(xform, trs(dx, 2.6, d / 2 + 0.02, 0, 1.9 + rng() * 0.8, 1, 1)).clone(), uv: new THREE.Vector4(0.25, 0.25, cell * 0.25, ((rng() * 4) | 0) * 0.25) });
  }
  if (rng() < 0.5) out.lamp.push(_m.multiplyMatrices(xform, trs(dx + 0.95, 2.9, d / 2 + 0.06, 0)).clone());
  // front steps where the door sits above grade
  out.trim.add(bevelBox(1.7, 0.16, 0.4, 0.02, 1.1), _m.multiplyMatrices(xform, trs(dx, -0.06, d / 2 + 0.2, 0)).clone(), new THREE.Color(0xd6cbb6));
  out.trim.add(bevelBox(2.0, 0.16, 0.6, 0.02, 1.1), _m.multiplyMatrices(xform, trs(dx, -0.2, d / 2 + 0.42, 0)).clone(), new THREE.Color(0xd6cbb6));

  if (rng() < 0.5) out.lineAnchors.push(new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(xform, trs((rng() - 0.5) * w * 0.7, h - 1.2, d / 2 + 0.25, 0)).clone()));
}

// --- reusable prop geometries ---------------------------------------------

/** Louvred shutter, unit sized (1 x 1) so instances can scale it to any window. */
export function shutterGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  // The panel is the only part big enough for a chamfer to read; the louvres
  // are 7 cm deep and there are nearly a thousand of these in the village.
  acc.add(bevelBox(1, 1, 0.06, 0.012, 1.6), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  const slat = plainBox(0.88, 0.08, 0.05, 3);
  for (let i = 0; i < 5; i++) {
    const y = -0.4 + (i / 4) * 0.8;
    acc.add(slat, trs(0, y, 0.045, 0, 1, 1, 1, -0.34), new THREE.Color(0.88, 0.88, 0.88));
  }
  const rail = plainBox(0.94, 0.07, 0.075, 3);
  acc.add(rail, trs(0, 0.46, 0.02, 0), new THREE.Color(1, 1, 1));
  acc.add(rail, trs(0, -0.46, 0.02, 0), new THREE.Color(1, 1, 1));
  return acc.build()!;
}

export function doorGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(bevelBox(1, 1, 0.08, 0.014, 1.4).translate(0, 0.5, 0), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  for (const y of [0.28, 0.68]) {
    acc.add(bevelBox(0.66, 0.28, 0.045, 0.012, 3), trs(0, y, 0.05, 0), new THREE.Color(0.82, 0.82, 0.82));
  }
  return acc.build()!;
}

export function balconyGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(1, 0.09, 0.72, 0.02, 1.6), trs(0, 0, 0.3, 0), white); // slab
  acc.add(bevelBox(1, 0.055, 0.055, 0.014, 4), trs(0, 0.92, 0.64, 0), white); // handrail
  const lowRail = plainBox(1, 0.04, 0.04, 4);
  acc.add(lowRail, trs(0, 0.3, 0.64, 0), white);
  const post = plainBox(0.045, 0.94, 0.045, 4);
  const baluster = plainBox(0.03, 0.9, 0.03, 6);
  for (const s of [-1, 1]) {
    acc.add(post, trs(s * 0.47, 0.47, 0.64, 0), white);
    acc.add(post, trs(s * 0.47, 0.46, 0.02, 0), white);
    acc.add(plainBox(0.045, 0.05, 0.66, 4), trs(s * 0.47, 0.92, 0.32, 0), white);
    acc.add(plainBox(0.1, 0.22, 0.3, 3), trs(s * 0.4, -0.14, 0.14, 0), white); // corbel
  }
  for (let i = 0; i < 7; i++) acc.add(baluster, trs(-0.42 + (i / 6) * 0.84, 0.46, 0.64, 0), white);
  return acc.build()!;
}

export function flowerBoxGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(bevelBox(1, 0.26, 0.28, 0.02, 2.4), trs(0, 0.13, 0, 0), new THREE.Color(1, 1, 1));
  return acc.build()!;
}

export function awningGeo(): THREE.BufferGeometry {
  // Slightly scalloped, sagging canvas — never a flat plane.
  const segs = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const rows = 4;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const scallop = j === rows ? Math.sin(u * Math.PI * 5) * 0.05 : 0;
      const sag = Math.sin(u * Math.PI) * 0.06 * v;
      pos.push((u - 0.5) * 1.0, -v * 0.62 - sag + scallop * 0.3, v * 0.95);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + segs + 1, a + 1, a + 1, a + segs + 1, a + segs + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function lampGeo(): { arm: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(0.06, 0.06, 0.5, 0.015, 6), trs(0, 0, 0.24, 0), w);
  acc.add(bevelBox(0.05, 0.3, 0.05, 0.012, 6), trs(0, -0.16, 0.46, 0), w);
  acc.add(bevelBox(0.26, 0.06, 0.26, 0.015, 5), trs(0, -0.02, 0.46, 0), w);
  return { arm: acc.build()!, glow: bevelBox(0.17, 0.24, 0.17, 0.05, 4).translate(0, -0.44, 0.46) };
}

// --- harbour ---------------------------------------------------------------

/** Lofted boat hull: real cross-sections, rounded chine, sheer line. */
export function hullGeo(len: number, beam: number, depth: number, kind: number): THREE.BufferGeometry {
  const rings = 22,
    sides = 14;
  return loft(
    (t, o) => {
      const z = (t - 0.5) * len;
      // sheer: the deck line rises toward bow and stern
      const sheer = Math.pow(Math.abs(t - 0.5) * 2, 2.2) * depth * 0.28;
      o.set(0, sheer, z);
    },
    rings,
    sides,
    (t, a) => {
      // waterline plan: fine bow, full midships, transom aft
      const bow = smoothstep(1.0, 0.72, t);
      const stern = kind === 0 ? smoothstep(0.0, 0.16, t) : smoothstep(0.0, 0.30, t);
      const plan = Math.pow(Math.sin(clamp(t, 0, 1) * Math.PI), 0.42) * bow * stern;
      // cross-section: rounded V, deeper amidships
      const s = Math.sin(a),
        c = Math.cos(a);
      const vShape = 1 - Math.pow(clamp(-s, 0, 1), 1.7) * 0.35;
      const r = plan * (0.5 + 0.5 * Math.abs(c)) * beam * 0.5 * vShape;
      const rv = plan * depth * 0.5 * (s < 0 ? 1.0 : 0.72);
      return Math.hypot(r * c, rv * s) * 0.5 + (r * 0.5 + Math.abs(rv) * 0.5) * 0.5;
    },
    2,
    true,
    true
  );
}

export function boatGeo(rng: RNG, kind: number): { hull: THREE.BufferGeometry; rig: THREE.BufferGeometry } {
  const len = kind === 0 ? 6.4 + rng() * 2.6 : 9.5 + rng() * 4.0;
  const beam = len * (0.3 + rng() * 0.06);
  const depth = len * 0.19;
  const hullAcc = new GeoAccum();
  const h = hullGeo(len, beam, depth, kind);
  hullAcc.add(h, trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  // gunwale rubbing strake
  const strake = loft(
    (t, o) => {
      const z = (t - 0.5) * len * 0.98;
      o.set(0, Math.pow(Math.abs(t - 0.5) * 2, 2.2) * depth * 0.28 + depth * 0.34, z);
    },
    18,
    6,
    (t) => 0.06 * Math.pow(Math.sin(clamp(t, 0, 1) * Math.PI), 0.3),
    2
  );
  void strake;
  const rigAcc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  // deck
  hullAcc.add(bevelBox(beam * 0.82, 0.08, len * 0.72, 0.02, 1.6), trs(0, depth * 0.36, 0, 0), new THREE.Color(0.82, 0.78, 0.7));
  if (kind === 0) {
    // open launch: thwarts, small cuddy, outboard
    for (let i = 0; i < 3; i++) rigAcc.add(bevelBox(beam * 0.7, 0.07, 0.28, 0.015, 3), trs(0, depth * 0.42, (i - 1) * len * 0.2, 0), w);
    rigAcc.add(bevelBox(beam * 0.62, 0.62, len * 0.2, 0.04, 1.2), trs(0, depth * 0.36 + 0.31, len * 0.24, 0), w);
    rigAcc.add(bevelBox(0.22, 0.5, 0.34, 0.05, 3), trs(0, depth * 0.3, -len * 0.46, 0), new THREE.Color(0.35, 0.35, 0.38));
  } else {
    // cabin cruiser / fishing boat: wheelhouse, mast, boom, davits
    rigAcc.add(bevelBox(beam * 0.66, 1.15, len * 0.26, 0.05, 1.1), trs(0, depth * 0.36 + 0.58, len * 0.06, 0), w);
    rigAcc.add(bevelBox(beam * 0.5, 0.1, len * 0.22, 0.02, 1.6), trs(0, depth * 0.36 + 1.2, len * 0.06, 0), new THREE.Color(0.88, 0.86, 0.8));
    const mast = loft((t, o) => o.set(0, t * (len * 0.62), 0), 4, 7, (t) => 0.075 * (1 - t * 0.45), 2, true, true);
    rigAcc.add(mast, trs(0, depth * 0.42, -len * 0.06, 0), w);
    rigAcc.add(bevelBox(0.09, 0.09, len * 0.34, 0.02, 4), trs(0, depth * 0.42 + len * 0.2, -len * 0.2, 0), w);
  }
  return { hull: hullAcc.build()!, rig: rigAcc.build()! };
}

export function bollardGeo(): THREE.BufferGeometry {
  // Cast-iron mooring bollard: chamfered, mushroom head, base flange.
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const body = loft((t, o) => o.set(0, t * 0.62, 0), 6, 12, (t) => 0.16 - t * 0.035 + Math.pow(t, 6) * 0.02, 1.4, true, false);
  acc.add(body, trs(0, 0, 0, 0), w);
  const head = loft((t, o) => o.set(0, 0.6 + t * 0.16, 0), 5, 12, (t) => 0.145 + Math.sin(t * Math.PI) * 0.075, 1.2, false, true);
  acc.add(head, trs(0, 0, 0, 0), w);
  acc.add(loft((t, o) => o.set(0, t * 0.07, 0), 2, 12, () => 0.24, 1, true, true), trs(0, 0, 0, 0), new THREE.Color(0.85, 0.85, 0.85));
  return acc.build()!;
}

export function crateGeo(rng: RNG): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const w = 0.6 + rng() * 0.35,
    h = 0.42 + rng() * 0.3,
    d = 0.5 + rng() * 0.3;
  acc.add(bevelBox(w, h, d, 0.02, 1.8), trs(0, h / 2, 0, 0), new THREE.Color(1, 1, 1));
  // batten frame
  const c2 = new THREE.Color(0.86, 0.82, 0.74);
  for (const s of [-1, 1]) {
    acc.add(bevelBox(w + 0.03, 0.07, 0.06, 0.012, 4), trs(0, h * (0.5 + s * 0.34), d / 2, 0), c2);
    acc.add(bevelBox(0.06, h, 0.06, 0.012, 4), trs(s * (w / 2 - 0.04), h / 2, d / 2, 0), c2);
  }
  return acc.build()!;
}

export function barrelGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(loft((t, o) => o.set(0, t * 0.82, 0), 8, 14, (t) => 0.26 + Math.sin(t * Math.PI) * 0.055, 2, true, true), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  for (const y of [0.16, 0.41, 0.66]) acc.add(loft((t, o) => o.set(0, y + t * 0.05, 0), 1, 14, () => 0.29, 1.5), trs(0, 0, 0, 0), new THREE.Color(0.5, 0.44, 0.36));
  return acc.build()!;
}

/** Draped fishing net: a sagging quad grid with a wide alpha weave. */
export function netGeo(w: number, h: number): THREE.BufferGeometry {
  const nx = 8,
    ny = 6;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const u = i / nx,
        v = j / ny;
      const sag = Math.sin(u * Math.PI) * 0.25 * v;
      pos.push((u - 0.5) * w, -v * h - sag, Math.sin(u * Math.PI * 2) * 0.12 * v);
      uv.push(u * 3, v * 3);
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Catenary rope between two points, as a real tube. */
export function ropeGeo(a: THREE.Vector3, b: THREE.Vector3, sag: number, radius = 0.035): THREE.BufferGeometry {
  return loft(
    (t, o) => {
      o.lerpVectors(a, b, t);
      o.y -= Math.sin(t * Math.PI) * sag;
    },
    10,
    5,
    () => radius,
    1
  );
}

export function tyreGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const tor = new THREE.TorusGeometry(0.34, 0.13, 6, 14);
  tor.rotateX(Math.PI / 2);
  acc.add(tor, trs(0, 0.13, 0, 0), new THREE.Color(1, 1, 1));
  // tread band so it isn't a smooth donut
  const block = plainBox(0.06, 0.055, 0.16, 6);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    acc.add(block, trs(Math.cos(a) * 0.46, 0.13, Math.sin(a) * 0.46, -a), new THREE.Color(0.8, 0.8, 0.8));
  }
  return acc.build()!;
}

export function parasolGeo(): { pole: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const pole = loft((t, o) => o.set(0, t * 2.3, 0), 3, 7, (t) => 0.045 - t * 0.012, 1, true, true);
  // scalloped cone with visible rib creases
  const segs = 16,
    rows = 3;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = u * Math.PI * 2;
      const rib = Math.abs(((u * 8) % 1) - 0.5) * 2;
      const r = v * 1.35 * (1 + (1 - rib) * 0.035 * v);
      pos.push(Math.cos(a) * r, 2.3 - v * v * 0.44 - (1 - rib) * 0.05 * v, Math.sin(a) * r);
      uv.push(u * 2, v);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + 1, a + segs + 1, a + 1, a + segs + 2, a + segs + 1);
    }
  const canopy = new THREE.BufferGeometry();
  canopy.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  canopy.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  canopy.setIndex(idx);
  canopy.computeVertexNormals();
  return { pole, canopy };
}

export function deckchairGeo(): { frame: THREE.BufferGeometry; cloth: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  for (const s of [-1, 1]) {
    acc.add(bevelBox(0.05, 1.06, 0.05, 0.012, 6), trs(s * 0.28, 0.44, -0.16, 0, 1, 1, 1, -0.5), w);
    acc.add(bevelBox(0.05, 0.92, 0.05, 0.012, 6), trs(s * 0.28, 0.3, 0.22, 0, 1, 1, 1, 0.66), w);
  }
  acc.add(bevelBox(0.62, 0.05, 0.05, 0.012, 6), trs(0, 0.02, -0.42, 0), w);
  acc.add(bevelBox(0.62, 0.05, 0.05, 0.012, 6), trs(0, 0.02, 0.42, 0), w);
  const clothG = new THREE.PlaneGeometry(0.56, 1.25, 1, 5);
  const p = clothG.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i) / 1.25 + 0.5;
    p.setXYZ(i, p.getX(i), 0.16 + v * 0.62 - Math.sin(v * Math.PI) * 0.06, -0.42 + v * 0.72);
  }
  clothG.computeVertexNormals();
  return { frame: acc.build()!, cloth: clothG };
}

/** Marshal post: a booth, a pole and a flag socket. */
export function marshalGeo(): { post: THREE.BufferGeometry; flag: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(0.9, 1.1, 0.7, 0.04, 1.2), trs(0, 0.55, 0, 0), w);
  acc.add(bevelBox(1.06, 0.09, 0.86, 0.02, 1.6), trs(0, 1.14, 0, 0), new THREE.Color(0.85, 0.85, 0.85));
  acc.add(loft((t, o) => o.set(0, t * 2.5, 0), 3, 7, () => 0.045, 1, true, true), trs(0.5, 1.1, 0.28, 0), w);
  const flag = new THREE.PlaneGeometry(1.0, 0.62, 8, 3);
  flag.translate(0.5, 0, 0);
  flag.rotateY(Math.PI / 2);
  flag.translate(0.5, 3.3, 0.28);
  return { post: acc.build()!, flag };
}

/** Banner arch spanning the road. `span` is the clear width. */
export function bannerArchGeo(span: number, height: number): { struct: THREE.BufferGeometry; banner: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  for (const s of [-1, 1]) {
    const x = (s * span) / 2;
    acc.add(bevelBox(0.75, height, 0.75, 0.05, 1.0), trs(x, height / 2, 0, 0), w);
    acc.add(bevelBox(1.15, 0.24, 1.15, 0.04, 1.2), trs(x, 0.12, 0, 0), new THREE.Color(0.86, 0.86, 0.86));
    acc.add(bevelBox(1.0, 0.2, 1.0, 0.04, 1.2), trs(x, height + 0.1, 0, 0), new THREE.Color(0.9, 0.9, 0.9));
    // diagonal brace
    acc.add(bevelBox(0.16, 2.2, 0.16, 0.03, 3), trs(x - s * 0.7, height - 1.0, 0, 0, 1, 1, 1, 0, s * 0.5), w);
  }
  // ------------------------------------------------------------------------
  //  THE BEAM IS A TRUSS, AND THE BANNER IS A BANNER.
  // ------------------------------------------------------------------------
  //  Round 1's beam was a single 0.42 m box with a 1.05 m ribbon of cloth under
  //  it. Over a 28 m span that ribbon is 27:1, which is why wide.png's arch
  //  reads as a bare telegraph crossbar ruling a hard horizontal line through
  //  the middle of the frame rather than as start-line dressing, and why the
  //  start straight has no readable banner at all.
  //
  //  A real gantry has depth: a top and a bottom chord with diagonal webbing
  //  between them. That breaks the silhouette into a lattice instead of one
  //  solid bar, gives the low sun several edges to catch, and is what stops it
  //  reading as an untextured box (§9.6, hard unchamfered edges — every member
  //  here is a bevelBox). And the banner itself goes to 2.8 m, which at 28 m of
  //  span is a 10:1 sheet: a printed banner, not a tape.
  const chord = 0.34;
  for (const y of [height + 0.28, height + 1.42]) acc.add(bevelBox(span + 1.6, chord, 0.5, 0.05, 0.35), trs(0, y, 0, 0), w);
  const webN = Math.max(6, Math.round(span / 2.2));
  for (let i = 0; i <= webN; i++) {
    const x = -((span + 1.0) / 2) + (i / webN) * (span + 1.0);
    acc.add(bevelBox(0.14, 1.34, 0.34, 0.03, 2.4), trs(x, height + 0.85, 0, 0, 1, 1, 1, 0, (i % 2 ? 1 : -1) * 0.62), new THREE.Color(0.92, 0.92, 0.92));
  }
  acc.add(bevelBox(span + 1.2, 0.2, 0.4, 0.03, 2), trs(0, height + 2.2, 0, 0), new THREE.Color(0.9, 0.9, 0.9));
  const banner = new THREE.PlaneGeometry(span + 1.2, 2.8, 14, 3);
  banner.translate(0, height + 0.78, 0.34);
  bannerUvs(banner);
  return { struct: acc.build()!, banner };
}

/**
 * Wire a hanging-banner plane's two UV channels.
 *
 * THE BANNER PRINT WAS ROTATED 90° AND NOBODY COULD SEE IT. `patchCloth` needs
 * uv.x to run 0 at the rooted edge to 1 at the free edge, and for a sheet hung
 * from a top rail that edge is VERTICAL — so the original code swapped the
 * plane's u and v wholesale and then sampled the albedo through the same
 * swapped coordinate. Canvas X therefore mapped to the banner's height and
 * canvas Y to its width: "樱花町" was being drawn sideways, crushed into a
 * strip a tenth of the banner wide, on a ribbon 1.05 m tall over a 28 m span.
 * Which is why there is no readable banner anywhere in the round-1 set, and why
 * the arch reads as a bare telegraph crossbar.
 *
 * Two channels fixes it without touching either the texture or the cloth patch:
 *   uv  — the cloth coordinate, vertical, as `patchCloth` requires
 *   uv1 — the real texture coordinate, upright, and mapped onto the printed top
 *         quarter of `bannerCloth` so the print fills the whole sheet
 */
export function bannerUvs(g: THREE.BufferGeometry) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = uv.count;
  const uv1 = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv1[i * 2] = u;
    // the printed band is the top quarter of the sheet (canvas rows 0..size/4),
    // which after flipY is v = 0.75..1
    uv1[i * 2 + 1] = 0.752 + v * 0.246;
    uv.setXY(i, 1 - v, u);
  }
  uv.needsUpdate = true;
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
}

/** Tiered grandstand with a canopy; returns structure + the crowd row anchors. */
export function grandstandGeo(len: number, rows: number): { struct: THREE.BufferGeometry; seats: { x: number; y: number; z: number }[] } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const seats: { x: number; y: number; z: number }[] = [];
  const rowH = 0.52,
    rowD = 0.82;
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const z = -r * rowD;
    acc.add(bevelBox(len, rowH, rowD, 0.03, 0.35), trs(0, y + rowH / 2, z, 0), r % 2 ? new THREE.Color(0.92, 0.9, 0.86) : new THREE.Color(0.84, 0.82, 0.78));
    acc.add(bevelBox(len, 0.34, 0.09, 0.02, 0.9), trs(0, y + rowH + 0.17, z - rowD * 0.44, 0), new THREE.Color(0.78, 0.8, 0.84));
    seats.push({ x: 0, y: y + rowH, z });
  }
  const totalD = rows * rowD;
  // back wall + roof canopy on columns
  acc.add(bevelBox(len + 0.6, rows * rowH + 1.4, 0.35, 0.05, 0.4), trs(0, (rows * rowH + 1.4) / 2, -totalD - 0.1, 0), w);
  const capH = rows * rowH + 3.4;
  for (let i = 0; i <= 6; i++) {
    const x = -len / 2 + (i / 6) * len;
    acc.add(bevelBox(0.22, capH, 0.22, 0.03, 3), trs(x, capH / 2, 0.5, 0), w);
  }
  acc.add(bevelBox(len + 1.2, 0.22, totalD + 1.6, 0.04, 0.45), trs(0, capH + 0.6, -totalD / 2 + 0.4, 0, 1, 1, 1, 0.08), new THREE.Color(0.9, 0.88, 0.84));
  acc.add(bevelBox(len + 1.2, 0.34, 0.24, 0.03, 2), trs(0, capH + 0.42, 0.9, 0), new THREE.Color(0.86, 0.4, 0.36));
  // side walls
  for (const s of [-1, 1]) acc.add(bevelBox(0.3, rows * rowH + 0.6, totalD, 0.04, 0.45), trs((s * len) / 2, (rows * rowH) / 2, -totalD / 2, 0), w);
  return { struct: acc.build()!, seats };
}

/**
 * Campanile / bell tower — the landmark that gives the village a silhouette
 * apex. Returns the three material streams the terrace builder already merges.
 */
export function bellTowerGeo(rng: RNG, base: number, h: number): { wall: THREE.BufferGeometry; trim: THREE.BufferGeometry; roof: THREE.BufferGeometry; height: number } {
  const wall = new GeoAccum();
  const trim = new GeoAccum();
  const roof = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const shaftH = h * 0.74;
  // shaft, very slightly battered so it does not read as an extrusion
  wall.add(bevelBox(base, shaftH, base, 0.07, 0.42), trs(0, shaftH / 2, 0, 0), white, (_x, y) => lerp(0.4, 1, smoothstep(0, 2.2, y)));
  // string courses breaking the shaft into stages
  for (let i = 1; i <= 3; i++) {
    const y = (shaftH * i) / 4;
    trim.add(bevelBox(base + 0.22, 0.16, base + 0.22, 0.035, 0.9), trs(0, y, 0, 0), new THREE.Color(0xdfd3bc));
  }
  // narrow slit windows up the shaft
  for (let i = 0; i < 3; i++) {
    const y = shaftH * (0.24 + i * 0.22);
    for (const s of [-1, 1]) {
      wall.add(new THREE.PlaneGeometry(0.28, 1.0, 1, 1), trs((s * base) / 2 + s * 0.006, y, 0, s > 0 ? Math.PI / 2 : -Math.PI / 2), new THREE.Color(0x2a2a30));
      wall.add(new THREE.PlaneGeometry(0.28, 1.0, 1, 1), trs(0, y, (s * base) / 2 + s * 0.006, s > 0 ? 0 : Math.PI), new THREE.Color(0x2a2a30));
    }
  }
  // belfry: open arched stage, deliberately wider than the shaft
  const belH = h * 0.16;
  const belW = base + 0.5;
  const py = shaftH;
  trim.add(bevelBox(belW + 0.3, 0.2, belW + 0.3, 0.04, 0.9), trs(0, py + 0.1, 0, 0), new THREE.Color(0xe4d9c2));
  // four corner piers leave the openings
  const pier = 0.42;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      wall.add(bevelBox(pier, belH, pier, 0.04, 0.9), trs((sx * (belW - pier)) / 2, py + belH / 2 + 0.2, (sz * (belW - pier)) / 2, 0), white, () => 0.9);
    }
  // dark void behind the arches so the belfry reads as open, not solid
  for (const s of [-1, 1]) {
    wall.add(new THREE.PlaneGeometry(belW - pier * 1.4, belH * 0.82, 1, 1), trs(0, py + belH * 0.55, (s * (belW - pier)) / 2 - s * 0.02, s > 0 ? 0 : Math.PI), new THREE.Color(0x241f22));
    wall.add(new THREE.PlaneGeometry(belW - pier * 1.4, belH * 0.82, 1, 1), trs((s * (belW - pier)) / 2 - s * 0.02, py + belH * 0.55, 0, (s * Math.PI) / 2), new THREE.Color(0x241f22));
  }
  // bell
  wall.add(loft((t, o) => o.set(0, -t * 0.5, 0), 4, 8, (t) => 0.1 + Math.pow(t, 1.6) * 0.2, 1, false, true), trs(0, py + belH * 0.82, 0, 0), new THREE.Color(0x6d5a34));
  // pyramid cap in roof tile
  const capH = h * 0.1;
  trim.add(bevelBox(belW + 0.44, 0.18, belW + 0.44, 0.04, 0.9), trs(0, py + belH + 0.29, 0, 0), new THREE.Color(0xe4d9c2));
  const cap = loft((t, o) => o.set(0, t * capH, 0), 2, 4, (t) => (1 - t) * (belW + 0.5) * 0.72, 1.6, false, false);
  cap.rotateY(Math.PI / 4);
  roof.add(cap, trs(0, py + belH + 0.38, 0, 0), new THREE.Color().setHSL(0.04, 0.2, 0.74));
  // finial
  trim.add(loft((t, o) => o.set(0, t * 1.1, 0), 2, 5, (t) => 0.06 * (1 - t * 0.6), 1, true, true), trs(0, py + belH + capH + 0.38, 0, 0), new THREE.Color(0xcfc0a4));
  void rng;
  return { wall: wall.build()!, trim: trim.build()!, roof: roof.build()!, height: py + belH + capH + 1.5 };
}

/** Market stall: four posts, a counter, and a striped canopy (fabric stream). */
export function stallGeo(rng: RNG): { frame: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = 2.6 + rng() * 1.1;
  const d = 1.7 + rng() * 0.5;
  const hh = 2.15 + rng() * 0.25;
  const white = new THREE.Color(1, 1, 1);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) acc.add(bevelBox(0.1, hh, 0.1, 0.02, 3), trs((sx * (w - 0.2)) / 2, hh / 2, (sz * (d - 0.2)) / 2, 0), white);
  // counter + a crate or two of produce
  acc.add(bevelBox(w, 0.12, d, 0.025, 1.1), trs(0, 0.95, 0, 0), new THREE.Color(0.88, 0.84, 0.76));
  acc.add(bevelBox(w - 0.2, 0.85, 0.1, 0.02, 1.1), trs(0, 0.5, (d - 0.1) / 2, 0), new THREE.Color(0.8, 0.76, 0.68));
  for (let i = 0; i < 3; i++) {
    const s = 0.3 + rng() * 0.14;
    acc.add(bevelBox(s, s * 0.7, s * 0.8, 0.02, 2), trs(-w / 2 + 0.4 + i * (w / 3.4), 1.06 + (s * 0.7) / 2, (rng() - 0.5) * 0.4, rng() * 3), new THREE.Color(0.9, 0.78, 0.6));
  }
  acc.add(bevelBox(w + 0.16, 0.08, 0.1, 0.02, 2), trs(0, hh, (d - 0.2) / 2, 0), white);
  // canopy: a shallow gable in the fabric atlas
  const can = new GeoAccum();
  const sl = Math.hypot(d / 2 + 0.28, 0.34);
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(w + 0.5, sl, 1, 1);
    g.rotateX(-Math.PI / 2);
    can.add(g, trs(0, hh + 0.16 - 0.17, (s * (d / 2 + 0.28)) / 2, 0, 1, 1, 1, (-s * 0.62) / 1.0), white);
  }
  const canopy = can.build()!;
  return { frame: acc.build()!, canopy };
}

/** Ridge tent for the support paddock bands. */
export function tentGeo(rng: RNG): { body: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = 2.8 + rng() * 1.4;
  const d = 3.4 + rng() * 1.6;
  const hh = 1.5 + rng() * 0.5;
  const wall = 0.6 + rng() * 0.35;
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(w, wall, d, 0.04, 0.55), trs(0, wall / 2, 0, 0), white, (_x, y) => lerp(0.5, 1, smoothstep(0, 0.8, y)));
  const sl = Math.hypot(w / 2 + 0.2, hh);
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(sl, d + 0.4, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.rotateZ(s * Math.atan2(hh, w / 2 + 0.2));
    g.translate((-s * (w / 2 + 0.2)) / 2, wall + hh / 2, 0);
    acc.add(g, trs(0, 0, 0, 0), new THREE.Color(0.94, 0.92, 0.88));
  }
  // gable triangles so the tent is closed
  for (const s of [-1, 1]) {
    const t = new THREE.BufferGeometry();
    const x = w / 2 + 0.2;
    t.setAttribute('position', new THREE.Float32BufferAttribute(s > 0 ? [-x, wall, 0, x, wall, 0, 0, wall + hh, 0] : [x, wall, 0, -x, wall, 0, 0, wall + hh, 0], 3));
    t.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, s, 0, 0, s, 0, 0, s], 3));
    t.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    acc.add(t, trs(0, 0, (s * (d + 0.4)) / 2, 0), new THREE.Color(0.8, 0.78, 0.75));
  }
  return { body: acc.build()! };
}

/** Channel buoy: a float, a cage and a topmark. */
export function buoyGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(loft((t, o) => o.set(0, -0.4 + t * 1.3, 0), 5, 8, (t) => Math.sin((0.12 + t * 0.78) * Math.PI) * 0.42, 1.4, true, true), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  acc.add(bevelBox(0.06, 1.5, 0.06, 0.015, 3), trs(0, 1.4, 0, 0), new THREE.Color(0.8, 0.8, 0.84));
  acc.add(loft((t, o) => o.set(0, t * 0.34, 0), 2, 4, (tt) => (1 - tt) * 0.2, 1, false, false), trs(0, 1.95, 0, 0), new THREE.Color(0.2, 0.2, 0.24));
  return acc.build()!;
}

/** Start-light gantry: five housings under the arch beam plus their lenses. */
export function startLightsGeo(span: number): { frame: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const lens = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const n = 5;
  const wBox = Math.min(0.78, (span * 0.5) / n);
  acc.add(bevelBox(wBox * n * 1.35, 0.16, 0.34, 0.03, 1.4), trs(0, 0.42, 0, 0), new THREE.Color(0.28, 0.28, 0.32));
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * wBox * 1.3;
    acc.add(bevelBox(wBox, wBox * 1.05, 0.3, 0.035, 1.6), trs(x, 0, 0, 0), new THREE.Color(0.22, 0.22, 0.26));
    acc.add(bevelBox(wBox * 1.1, 0.1, 0.42, 0.02, 2), trs(x, wBox * 0.56, 0.06, 0, 1, 1, 1, 0.25), new THREE.Color(0.18, 0.18, 0.21));
    const g = new THREE.CircleGeometry(wBox * 0.34, 12);
    lens.add(g, trs(x, 0, 0.17, 0), white);
  }
  return { frame: acc.build()!, lens: lens.build()! };
}

/** A-frame roadside board: two hinged panels on a folding frame. */
export function aFrameSignGeo(): { frame: THREE.BufferGeometry; panel: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const pan = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const hh = 1.25;
  const wdt = 1.9;
  for (const s of [-1, 1]) {
    for (const sx of [-1, 1]) acc.add(bevelBox(0.08, hh, 0.08, 0.02, 3), trs((sx * wdt) / 2, hh / 2, s * 0.3, 0, 1, 1, 1, (-s * 0.42) / 1.0), white);
    acc.add(bevelBox(wdt + 0.1, 0.07, 0.07, 0.015, 2), trs(0, 0.14, s * 0.55, 0), new THREE.Color(0.85, 0.85, 0.85));
    const g = new THREE.PlaneGeometry(wdt * 0.94, hh * 0.72, 1, 1);
    g.rotateX(s > 0 ? 0.42 : -0.42);
    g.translate(0, hh * 0.56, s * 0.24);
    if (s < 0) g.rotateY(Math.PI);
    pan.add(g, trs(0, 0, 0, 0), s > 0 ? white : new THREE.Color(0.9, 0.9, 0.9));
  }
  return { frame: acc.build()!, panel: pan.build()! };
}

/** Wall-mounted hoarding: a flat board on two short brackets. */
export function wallSignGeo(): { frame: THREE.BufferGeometry; panel: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const pan = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(3.2, 0.1, 0.12, 0.02, 2), trs(0, 1.62, 0, 0), white);
  acc.add(bevelBox(3.2, 0.1, 0.12, 0.02, 2), trs(0, 0.72, 0, 0), white);
  for (const s of [-1, 1]) acc.add(bevelBox(0.1, 1.15, 0.24, 0.02, 2), trs(s * 1.5, 1.17, -0.1, 0), new THREE.Color(0.86, 0.86, 0.86));
  const g = new THREE.PlaneGeometry(3.1, 0.82, 1, 1);
  g.translate(0, 1.17, 0.07);
  pan.add(g, trs(0, 0, 0, 0), white);
  return { frame: acc.build()!, panel: pan.build()! };
}

/** One bunting pennant, pivoting from its top edge. */
export function buntingFlagGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const w = 0.26,
    hh = 0.36;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, -hh, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  // uv.x is the cloth patch's root->free coordinate: 0 on the line, 1 at the tip
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0.5], 2));
  return g;
}

/**
 * A spectator. uv.x flags tintable clothing, uv.y > 0.92 flags raised arms.
 * Four silhouettes: a row of identical capsules is the classic placeholder
 * tell, and the fix that costs nothing is a different OUTLINE, not more polys.
 *   0 standing  1 arms up  2 child (short, no cap)  3 adult with a sun hat
 */
export function spectatorGeo(variant = 0): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const skin = new THREE.Color(1, 1, 1);
  const dark = new THREE.Color(0.42, 0.4, 0.44);
  const white = new THREE.Color(1, 1, 1);
  const child = variant === 2;
  const sc = child ? 0.72 : 1;
  const build = 1 + (variant === 3 ? 0.14 : 0) - (child ? 0.06 : 0);
  // Deliberately cheap: there are several hundred of these and they are never
  // closer than a couple of metres behind a barrier. Colour variety, outline
  // variety and the cheer animation carry the read, not the mesh.
  //
  // What DID have to change after round 1: the arms were the same tint as the
  // torso and hung at 0.16 rad against a 0.19 m body, so they welded into the
  // silhouette and every spectator read as a coloured pill. Now the torso necks
  // in at the shoulders, the arms swing out clear of it, and the forearm is
  // untinted skin — the value break is what separates limb from body at 40 m,
  // not the extra 40 triangles.
  const torso = loft(
    (t, o) => o.set(0, (0.62 + t * 0.56) * sc, 0),
    4,
    6,
    // shoulder taper: widest at the chest, necked in at the collar
    (t) => (0.185 + Math.sin(Math.min(t * 1.35, 1) * Math.PI) * 0.045 - Math.pow(t, 3) * 0.07) * build * sc,
    1,
    true,
    true
  );
  setUv(torso, 1, 0.5);
  acc.add(torso, trs(0, 0, 0, 0), white);
  // legs, set wider apart with a visible gap between them
  const legG = loft((t, o) => o.set(0, t * 0.66 * sc, 0), 2, 5, (t) => (0.078 - t * 0.014) * sc, 1, true, true);
  setUv(legG, 0, 0.4);
  const stance = variant === 3 ? 0.125 : 0.105;
  for (const s of [-1, 1]) acc.add(legG, trs(s * stance * sc, 0, 0, 0, 1, 1, 1, 0, s * 0.05), dark);
  const shoulderX = 0.235 * sc * build;
  if (variant === 1) {
    // arms straight up — this is the silhouette that reads "crowd" at 60 m
    const sleeve = loft((t, o) => o.set(0, (1.06 + t * 0.3) * sc, 0), 1, 4, () => 0.054 * sc, 1, true, true);
    setUv(sleeve, 1, 0.96);
    const fore = loft((t, o) => o.set(0, (1.34 + t * 0.4) * sc, 0), 1, 4, (t) => (0.048 - t * 0.008) * sc, 1, true, true);
    setUv(fore, 0, 0.96);
    for (const s of [-1, 1]) {
      acc.add(sleeve, trs(s * shoulderX, 0, 0, 0, 1, 1, 1, 0, s * 0.24), white);
      acc.add(fore, trs(s * (shoulderX + 0.09 * sc), 0, 0, 0, 1, 1, 1, 0, s * 0.12), skin);
    }
  } else {
    // Arms hang OUT from the body: upper arm swung clear, forearm bare.
    const swing = variant === 3 ? 0.34 : 0.26;
    const sleeve = loft((t, o) => o.set(0, (1.12 - t * 0.26) * sc, 0), 1, 4, () => 0.057 * sc, 1, true, true);
    setUv(sleeve, 1, 0.96);
    const fore = loft((t, o) => o.set(0, (0.9 - t * 0.24) * sc, 0), 1, 4, (t) => (0.046 - t * 0.006) * sc, 1, true, true);
    setUv(fore, 0, 0.96);
    for (const s of [-1, 1]) {
      acc.add(sleeve, trs(s * shoulderX, 0, 0, 0, 1, 1, 1, 0, s * swing), white);
      acc.add(fore, trs(s * (shoulderX + 0.075 * sc), 0, 0.02 * sc, 0, 1, 1, 1, -0.22, s * (swing * 0.55)), skin);
    }
  }
  const head = loft((t, o) => o.set(0, (1.2 + t * 0.2) * sc, 0), 2, 6, (t) => Math.sin((0.18 + t * 0.72) * Math.PI) * 0.115 * sc, 1, true, true);
  setUv(head, 0, 0.5);
  acc.add(head, trs(0, 0, 0, 0), skin);
  if (variant === 3) {
    // wide-brimmed sun hat: a completely different head silhouette
    const brim = loft((t, o) => o.set(0, (1.34 + t * 0.05) * sc, 0), 1, 8, (t) => lerp(0.26, 0.2, t) * sc, 1, true, true);
    setUv(brim, 1, 0.5);
    acc.add(brim, trs(0, 0, 0, 0), white);
    const crown = loft((t, o) => o.set(0, (1.37 + t * 0.14) * sc, 0), 2, 6, (t) => 0.108 * (1 - t * 0.35) * sc, 1, false, true);
    setUv(crown, 1, 0.5);
    acc.add(crown, trs(0, 0, 0, 0), white);
  } else if (!child) {
    const cap = loft((t, o) => o.set(0, (1.33 + t * 0.09) * sc, 0), 2, 6, (t) => 0.115 * Math.cos(t * 1.2) * sc, 1, false, true);
    setUv(cap, 1, 0.5);
    acc.add(cap, trs(0, 0, 0, 0), white);
  }
  const g = acc.build()!;
  // ---- uv1: the real texture coordinate ----------------------------------
  // Channel 0 is a flag channel here (see `MatLib.crowd`), so the garment atlas
  // needs its own. Cylindrical: u is the bearing around the figure, v runs 0 at
  // the feet to 1 just above the head, which is the layout `crowdCloth` cards
  // are painted for — trousers low, shirt high. Derived from the built
  // positions rather than threaded through `GeoAccum`, which would mean an
  // extra stream on every prop in the game for the benefit of one of them.
  const pa = g.getAttribute('position') as THREE.BufferAttribute;
  const uv1 = new Float32Array(pa.count * 2);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i),
      y = pa.getY(i),
      z = pa.getZ(i);
    // MIRRORED bearing, not a raw wrap. A raw atan2 jumps from 1 back to 0 down
    // the figure's back, and that one column of triangles would smear the whole
    // atlas cell across itself. |2a-1| is continuous at the wrap (both ends land
    // on 1), and since every card's pattern is stripes, hoops or blocks, the
    // mirror is invisible.
    const a = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uv1[i * 2] = Math.abs(a * 2 - 1);
    // v = 0 at the feet. The canvas is uploaded flipY, so v = 0 is the BOTTOM of
    // the card, which is where `crowdCloth` paints the trousers.
    uv1[i * 2 + 1] = clamp(y / 1.62, 0, 1);
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return g;
}

function setUv(g: THREE.BufferGeometry, x: number, y: number) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, x, y);
  uv.needsUpdate = true;
}

/** Gull: body spindle plus two wing quads, animated entirely in the shader. */
export function gullGeo(): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
  };
  // wings: a single strip spanning u = 0..1 so |u-0.5| is the span coordinate
  const span = 0.62;
  const pts: [number, number][] = [
    [-1, 0.0],
    [-0.55, 0.06],
    [0, 0.02],
    [0.55, 0.06],
    [1, 0.0],
  ];
  for (let i = 0; i < pts.length; i++) {
    const [sx, sz] = pts[i];
    push(sx * span, 0, sz * 0.1 - 0.03, (sx + 1) / 2, 0);
    push(sx * span, 0, sz * 0.1 + 0.14 - Math.abs(sx) * 0.1, (sx + 1) / 2, 1);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // body
  const base = pos.length / 3;
  const bl = 0.3;
  push(0, 0, -bl, 0.5, 0.5);
  push(-0.045, 0.02, 0, 0.5, 0.5);
  push(0.045, 0.02, 0, 0.5, 0.5);
  push(0, -0.02, 0.06, 0.5, 0.5);
  push(0, 0.01, bl * 0.7, 0.5, 0.5);
  idx.push(base, base + 1, base + 2, base + 1, base + 4, base + 2, base + 1, base + 3, base + 4, base + 2, base + 4, base + 3, base, base + 3, base + 1, base, base + 2, base + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Lighthouse on its own rock plinth — the plinth guarantees it never floats. */
export function lighthouseGeo(baseY: number, seaY: number): { stone: THREE.BufferGeometry; trim: THREE.BufferGeometry; glass: THREE.BufferGeometry; lampY: number } {
  const stoneA = new GeoAccum();
  const trimA = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const plinthH = Math.max(2.5, baseY - seaY + 3.0);
  const plinth = loft((t, o) => o.set(0, -plinthH + t * plinthH, 0), 5, 10, (t, a) => (7.5 - t * 3.4) * (1 + Math.sin(a * 3 + t * 2) * 0.09), 3, false, true);
  stoneA.add(plinth, trs(0, 0, 0, 0), new THREE.Color(0.86, 0.82, 0.74));
  const towerH = 15.5;
  const tower = loft((t, o) => o.set(0, t * towerH, 0), 12, 16, (t) => 2.35 - Math.pow(t, 0.85) * 1.15, 4, true, false);
  stoneA.add(tower, trs(0, 0, 0, 0), w);
  // gallery ring + corbel
  trimA.add(loft((t, o) => o.set(0, towerH + t * 0.42, 0), 3, 16, (t) => 1.75 - t * 0.25, 3, false, true), trs(0, 0, 0, 0), new THREE.Color(0.94, 0.9, 0.84));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    trimA.add(bevelBox(0.07, 0.9, 0.07, 0.015, 5), trs(Math.cos(a) * 1.6, towerH + 0.86, Math.sin(a) * 1.6, -a), new THREE.Color(0.8, 0.3, 0.28));
  }
  trimA.add(loft((t, o) => o.set(0, towerH + 1.3 + t * 0.12, 0), 1, 16, () => 1.66, 3, false, false), trs(0, 0, 0, 0), new THREE.Color(0.8, 0.3, 0.28));
  // lantern room + cap
  const lampY = towerH + 1.4;
  const glass = loft((t, o) => o.set(0, lampY + t * 2.0, 0), 2, 12, () => 1.15, 2, false, false);
  trimA.add(loft((t, o) => o.set(0, lampY + 2.0 + t * 1.05, 0), 4, 12, (t) => 1.3 * (1 - t * t), 2, false, true), trs(0, 0, 0, 0), new THREE.Color(0.8, 0.3, 0.28));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    trimA.add(bevelBox(0.09, 2.0, 0.09, 0.02, 4), trs(Math.cos(a) * 1.14, lampY + 1.0, Math.sin(a) * 1.14, -a), new THREE.Color(0.35, 0.34, 0.36));
  }
  return { stone: stoneA.build()!, trim: trimA.build()!, glass, lampY: lampY + 1.0 };
}

/** Windmill: tower + cap (static) and a 4-sail rotor (spun on the CPU, 1 object). */
export function windmillGeo(): { tower: THREE.BufferGeometry; trim: THREE.BufferGeometry; rotor: THREE.BufferGeometry; sail: THREE.BufferGeometry; hubY: number; hubZ: number } {
  const towerA = new GeoAccum();
  const trimA = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const H = 9.5;
  towerA.add(loft((t, o) => o.set(0, t * H, 0), 10, 14, (t) => 3.1 - t * 1.25, 3, true, false), trs(0, 0, 0, 0), w);
  // little windows so the tower isn't a bare cone
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1;
    trimA.add(bevelBox(0.6, 0.85, 0.35, 0.03, 2), trs(Math.cos(a) * 2.35, 2.6 + i * 1.9, Math.sin(a) * 2.35, -a), new THREE.Color(0.4, 0.36, 0.34));
  }
  // conical cap
  trimA.add(loft((t, o) => o.set(0, H + t * 2.4, 0), 6, 14, (t) => 2.05 * Math.pow(1 - t, 0.72), 3, false, true), trs(0, 0, 0, 0), new THREE.Color(0.78, 0.42, 0.3));
  trimA.add(loft((t, o) => o.set(0, H - 0.1 + t * 0.22, 0), 1, 14, () => 2.2, 3, false, false), trs(0, 0, 0, 0), new THREE.Color(0.92, 0.88, 0.8));
  const hubY = H + 1.35,
    hubZ = 2.3;
  // rotor: hub + four lattice arms, built around the origin in XY
  const rotorA = new GeoAccum();
  rotorA.add(loft((t, o) => o.set(0, 0, -0.1 + t * 0.6), 3, 10, (t) => 0.34 - t * 0.1, 1.5, true, true), trs(0, 0, 0, 0), w);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const L = 5.6;
    // spar
    rotorA.add(bevelBox(0.16, L, 0.16, 0.03, 3), trs((ca * L) / 2, (sa * L) / 2, 0, 0, 1, 1, 1, 0, a - Math.PI / 2), w);
    // lattice ribs
    for (let k = 1; k <= 7; k++) {
      const r = (k / 8) * L;
      rotorA.add(bevelBox(0.9, 0.07, 0.07, 0.015, 4), trs(ca * r, sa * r, 0.05, 0, 1, 1, 1, 0, a - Math.PI / 2), new THREE.Color(0.9, 0.9, 0.9));
    }
  }
  // one sail cloth per arm, instanced
  const sail = new THREE.PlaneGeometry(0.95, 4.6, 3, 8);
  sail.translate(0.55, 2.6, 0.14);
  const suv = sail.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < suv.count; i++) suv.setXY(i, suv.getX(i) * 0.5, suv.getY(i) * 0.5);
  return { tower: towerA.build()!, trim: trimA.build()!, rotor: rotorA.build()!, sail, hubY, hubZ };
}

/**
 * A landmass silhouette: a noise-displaced dome. Used for the offshore islands
 * and the receding headlands that keep the horizon from ever being empty.
 */
export function landmassGeo(radius: number, height: number, seed: number, seaY: number, jag = 1, segs = 40, rings = 12): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const n1 = createNoise2D(rng);
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const skirt = height * 0.6 + 40;
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = u * Math.PI * 2;
      const wob = 1 + n1(Math.cos(a) * 1.5, Math.sin(a) * 1.5) * 0.34 * jag + n1(Math.cos(a) * 4.1 + 9, Math.sin(a) * 4.1) * 0.14 * jag;
      const r = radius * wob * Math.sqrt(Math.max(0, 1 - v * v));
      const ridge = n1(Math.cos(a) * 2.2 + 30, Math.sin(a) * 2.2) * 0.3 + n1(u * 7 + 51, v * 3) * 0.16;
      const y = seaY + height * Math.pow(v, 0.72) * (1 + ridge * jag);
      // The base ring is dropped well below the waterline so an island never
      // shows a floating rim however the swell moves.
      pos.push(Math.cos(a) * r, j === 0 ? seaY - skirt : y, Math.sin(a) * r);
      uv.push(u * 8, v * 5);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + segs + 1, a + 1, a + 1, a + segs + 1, a + segs + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Small tide-line debris: driftwood, shells, weed clumps, pebbles. */
export function debrisGeo(rng: RNG): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const k = (rng() * 3) | 0;
  if (k === 0) {
    const L = 0.5 + rng() * 1.1;
    acc.add(loft((t, o) => o.set(0, 0, (t - 0.5) * L), 5, 6, (t) => 0.05 + Math.sin(t * Math.PI) * 0.035, 2, true, true), trs(0, 0.06, 0, rng() * 6), new THREE.Color(0.78, 0.72, 0.62));
  } else if (k === 1) {
    for (let i = 0; i < 4; i++) acc.add(bevelBox(0.12 + rng() * 0.14, 0.07 + rng() * 0.06, 0.12 + rng() * 0.12, 0.02, 4), trs((rng() - 0.5) * 0.4, 0.04, (rng() - 0.5) * 0.4, rng() * 6), new THREE.Color(0.9, 0.87, 0.8));
  } else {
    for (let i = 0; i < 5; i++) acc.add(bevelBox(0.22 + rng() * 0.2, 0.05, 0.1 + rng() * 0.1, 0.02, 4), trs((rng() - 0.5) * 0.5, 0.03, (rng() - 0.5) * 0.5, rng() * 6, 1, 1, 1, 0, rng() * 0.4), new THREE.Color(0.34, 0.36, 0.26));
  }
  return acc.build()!;
}
