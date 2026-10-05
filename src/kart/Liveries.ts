/**
 * ============================================================================
 *  Liveries — and the shared procedural kit the kart + driver are built from.
 * ============================================================================
 *  Three concerns live here, in this order:
 *
 *   1. CANVAS / TEXTURE KIT — every pixel in the kart is generated here.
 *   2. GEOMETRY KIT — `Mesher`, a single accumulating buffer with a chamfered
 *      loft primitive. Everything the kart and the driver are made of goes
 *      through it, which is how a whole kart collapses to a dozen draw calls.
 *   3. LIVERIES — eight schemes derived from `KartStats.color`.
 *
 *  It lives in one module because KartModel and Driver both need it and a
 *  cycle between those two would be worse than one fat shared kit.
 *
 *  SHARING STRATEGY (buildKart is called 8x at boot and must be cheap):
 *  geometry is built exactly once. Per-livery variation is carried purely in
 *  the vertex-colour attribute — a livery geometry re-uses the *same*
 *  position/uv/index BufferAttribute objects and only swaps `color`. So all
 *  eight karts share one paint material, one wheel material, one chrome
 *  material; only the decal map genuinely differs per racer.
 * ============================================================================
 */
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import type { KartStats } from '../types';
import { injectEnvResponse } from '../render/Materials';

// ---------------------------------------------------------------------------
// 0. Palette constants shared by every kart (the non-livery colours)
// ---------------------------------------------------------------------------

/** Vertex-colour roles. Baked per-vertex as an index, resolved per livery. */
export const enum Role {
  Base = 0,      // primary coat — KartStats.color
  Trim = 1,      // secondary coat
  Accent = 2,    // stripe / decal ink
  Cream = 3,     // #f2ece0 — never pure white
  Plastic = 4,   // matte dark structural plastic
  Steel = 5,     // dull steel
  Rubber = 6,    // tyre / grip
  Skin = 7,
  Suit = 8,
  Glove = 9,
  Hub = 10,
  Disc = 11,
  Shadowed = 12, // base coat, darkened — used inside recesses to fake AO
  Rim = 13,      // anodised wheel metal: the trim hue, dropped to a metal value
}
const ROLE_COUNT = 14;

const C_CREAM = new THREE.Color(0xf2ece0);
const C_PLASTIC = new THREE.Color(0x2b2d34);
const C_STEEL = new THREE.Color(0xdce3ea);   // chrome albedo must be near-white or the reflection goes muddy
const C_RUBBER = new THREE.Color(0xffffff); // albedo comes from the wheel atlas
const C_HUB = new THREE.Color(0xd7dce2);
const C_DISC = new THREE.Color(0x9aa1ab);
const C_RIM = new THREE.Color(0x7d848f);   // liveryless fallback: plain alloy

// ---------------------------------------------------------------------------
// 1. Canvas / texture kit
// ---------------------------------------------------------------------------

/** Deterministic PRNG so every boot produces byte-identical textures. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvas(size: number, h = size): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  return c.getContext('2d', { willReadFrequently: true })!;
}

function tex(ctx: CanvasRenderingContext2D, srgb: boolean, repeat = 1, flipY = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.flipY = flipY;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8; // clamped to the device max by three
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a greyscale height canvas into raw tangent-space SLOPES (dh/du, dh/dv).
 * Kept separate from the packed normal map because the *same* slope field also
 * drives the Toksvig roughness bake below — the two must agree exactly or the
 * anti-aliasing compensates for a surface that isn't there.
 */
function heightSlope(src: CanvasRenderingContext2D, strength: number): Float32Array {
  const w = src.canvas.width;
  const h = src.canvas.height;
  const s = src.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h * 2);
  const at = (x: number, y: number) => s[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const i = (y * w + x) * 2;
      out[i] = -dx * strength;
      out[i + 1] = -dy * strength;
    }
  }
  return out;
}

/** Pack a slope field into an RGB tangent-space normal map. */
function slopeToNormal(slope: Float32Array, w: number, h: number): CanvasRenderingContext2D {
  const dst = canvas(w, h);
  const out = dst.createImageData(w, h);
  const d = out.data;
  for (let i = 0; i < w * h; i++) {
    const nx = slope[i * 2];
    const ny = slope[i * 2 + 1];
    const inv = 1 / Math.hypot(nx, ny, 1);
    d[i * 4] = (nx * inv * 0.5 + 0.5) * 255;
    d[i * 4 + 1] = (ny * inv * 0.5 + 0.5) * 255;
    d[i * 4 + 2] = inv * 255;
    d[i * 4 + 3] = 255;
  }
  dst.putImageData(out, 0, 0);
  return dst;
}

/** Convenience wrapper for callers that only want the packed normal map. */
function heightToNormal(src: CanvasRenderingContext2D, strength: number): CanvasRenderingContext2D {
  return slopeToNormal(heightSlope(src, strength), src.canvas.width, src.canvas.height);
}

/**
 * Roughness texture with a HAND-BUILT MIP CHAIN (Toksvig / LEAN).
 *
 * A normal map that is busy relative to its mip chain is a specular aliaser:
 * as the GPU averages the normals away, the highlight they used to break up
 * collapses into per-pixel sparkle. That is exactly what crawls over a dark,
 * low-roughness surface at speed. The fix is not to soften the normal until
 * the sparkle goes — it is to convert the detail the mip chain *loses* into
 * roughness. So at every level we track the mean and mean-square of the slope
 * field, and fold its variance into the roughness stored at that level:
 *
 *     alpha' = sqrt(alpha^2 + 2 * var(slope))        (GGX alpha = roughness^2)
 *
 * Level 0 is untouched apart from the floor, so nothing is over-roughened up
 * close; by the time the normal has flattened out, roughness has taken over.
 * `chan` is the channel the material actually samples (three reads .g for both
 * roughnessMap and metalnessMap-adjacent packing) — every other channel is
 * plain box-filtered so an ORM pack survives the trip intact.
 */
function toksvigTexture(
  src: CanvasRenderingContext2D,
  slope: Float32Array,
  normalScale: number,
  repeat: number,
  flipY: boolean,
  roughFloor: number,
): THREE.CanvasTexture {
  let w = src.canvas.width;
  let h = src.canvas.height;
  // float copies so ten successive box filters do not quantise into banding
  let rgba = Float32Array.from(src.getImageData(0, 0, w, h).data);
  let m1 = new Float32Array(w * h * 2);
  let m2 = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h * 2; i++) {
    const s = slope[i] * normalScale;
    m1[i] = s;
    m2[i] = s * s;
  }

  const mips: HTMLCanvasElement[] = [];
  for (;;) {
    const c = canvas(w, h);
    const img = c.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      const mx = m1[i * 2];
      const my = m1[i * 2 + 1];
      const v = Math.max(0, m2[i * 2] - mx * mx) + Math.max(0, m2[i * 2 + 1] - my * my);
      const r = Math.max(roughFloor, rgba[i * 4 + 1] / 255);
      const a = r * r;
      const lifted = Math.min(1, Math.pow(a * a + 2 * v, 0.25));
      d[i * 4] = Math.round(rgba[i * 4]);
      d[i * 4 + 1] = Math.round(Math.max(lifted, roughFloor) * 255);
      d[i * 4 + 2] = Math.round(rgba[i * 4 + 2]);
      d[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    mips.push(c.canvas);
    if (w === 1 && h === 1) break;

    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const nrgba = new Float32Array(nw * nh * 4);
    const nm1 = new Float32Array(nw * nh * 2);
    const nm2 = new Float32Array(nw * nh * 2);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(h - 1, y * 2);
      const y1 = Math.min(h - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2);
        const x1 = Math.min(w - 1, x * 2 + 1);
        const a = (y0 * w + x0), b = (y0 * w + x1), cc = (y1 * w + x0), dd = (y1 * w + x1);
        const o = y * nw + x;
        for (let k = 0; k < 4; k++) {
          nrgba[o * 4 + k] = (rgba[a * 4 + k] + rgba[b * 4 + k] + rgba[cc * 4 + k] + rgba[dd * 4 + k]) * 0.25;
        }
        for (let k = 0; k < 2; k++) {
          nm1[o * 2 + k] = (m1[a * 2 + k] + m1[b * 2 + k] + m1[cc * 2 + k] + m1[dd * 2 + k]) * 0.25;
          nm2[o * 2 + k] = (m2[a * 2 + k] + m2[b * 2 + k] + m2[cc * 2 + k] + m2[dd * 2 + k]) * 0.25;
        }
      }
    }
    rgba = nrgba; m1 = nm1; m2 = nm2; w = nw; h = nh;
  }

  const t = new THREE.CanvasTexture(mips[0]);
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.flipY = flipY;
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Fill a rect with fBm value noise mapped through `map` -> css colour. */
function fbmFill(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, w: number, h: number,
  scale: number, octaves: number, seed: number,
  map: (n: number) => [number, number, number],
) {
  const noise = createNoise2D(lcg(seed));
  const img = c.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let amp = 0.5;
      let f = scale;
      for (let o = 0; o < octaves; o++) {
        n += noise(x * f, y * f) * amp;
        f *= 2.03; // non-integer so the octaves never line up into a visible grid
        amp *= 0.5;
      }
      const [r, g, b] = map(n * 0.5 + 0.5);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  c.putImageData(img, x0, y0);
}

/**
 * Add fine grain to a horizontal band of a HEIGHT canvas, seamless in U.
 *
 * The wheel atlas's U axis is the tyre's circumference, so any field generated
 * straight from a noise function carries a discontinuity down the whole height
 * of the tyre at u=0 — one hard vertical crease on the closest object to the
 * camera all race. Crossfading the field with a copy of itself shifted exactly
 * one period in U closes it: at u=1 the shifted copy is sampling what the
 * original samples at u=0, so the two ends meet. The price is a ~30% amplitude
 * dip mid-tile, which on a grain is invisible.
 *
 * Generated at half resolution and box-upscaled by the browser. That is not a
 * compromise: the atlas is 2.3 mm per texel at the tread radius, so a grain
 * authored per-texel is sub-pixel noise that mips straight into aliasing. Two
 * to three texels — 5 to 7 mm — is real moulded-rubber grain.
 */
function addGrain(
  dst: CanvasRenderingContext2D, y0: number, h: number,
  cell: number, amp: number, seed: number,
) {
  const w = dst.canvas.width;
  const gw = Math.max(1, w >> 1);
  const gh = Math.max(1, h >> 1);
  const noise = createNoise2D(lcg(seed));
  const tmp = canvas(gw, gh);
  const img = tmp.createImageData(gw, gh);
  const d = img.data;
  const f = 1 / cell;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const t = x / gw;
      const n = noise(x * f, y * f) * (1 - t) + noise((x - gw) * f, y * f) * t;
      const i = (y * gw + x) * 4;
      const v = 128 + n * 127;
      d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i + 3] = 255;
    }
  }
  tmp.putImageData(img, 0, 0);
  const up = canvas(w, h);
  up.drawImage(tmp.canvas, 0, 0, w, h);
  const g = up.getImageData(0, 0, w, h).data;
  const band = dst.getImageData(0, y0, w, h);
  const b = band.data;
  for (let i = 0; i < w * h; i++) {
    const v = b[i * 4] + ((g[i * 4] - 128) / 127) * amp;
    b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  dst.putImageData(band, 0, y0);
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// --- shared surface detail ---------------------------------------------------
//
// Three material families are authored in one pass because they have to agree
// with each other:
//
//   LACQUER  a fine orange-peel base coat under a COARSER clearcoat. The two
//            layers deliberately share no frequency and no UV repeat: it is
//            the disagreement between the base lobe and the coat lobe that
//            the eye reads as "lacquer" instead of "paint". Round 1 shipped a
//            single ~12 mm normal at ~16 deg of tangent tilt, which at hero
//            distance is a fabric weave — hence the flocked-velvet note.
//   PLASTIC  a pebbled mould grain with a hard roughness FLOOR. Round 1 gave
//            the dark trim a 0.14 minimum roughness (0.72 base x a 0.20 map)
//            under a strong normal, which is the white per-pixel sparkle.
//   CHROME   no grain at all, just a long-wave polish haze — a mirror needs
//            curvature to reflect, not noise.
//
// Every roughness map here is Toksvig-baked against its own normal map.

/** Tangent tilt of the base coat: ~2 deg, i.e. a grazing-angle-only effect. */
const PAINT_NORMAL_SCALE = 0.10;
/**
 * ORANGE PEEL, and it now lives on the clearcoat where the physics puts it.
 *
 * Round 6 ran the coat normal at 0.055 over a 588 mm tile: a long-wave spray
 * flow and nothing else. A flow that slow does not modulate a highlight, it
 * only very slightly bends one — so the coat reflected the sky as a single
 * unbroken wash and the panel read as terracotta. Meanwhile the BASE coat
 * carried a 2 mm dimple field, which at the closeup framing is one screen pixel
 * per dimple: not orange peel, velvet. That inversion is the whole "suede, not
 * lacquer" note.
 *
 * The two frequencies have swapped ends. The base peel is now a 6 mm dimple
 * (three-plus pixels at 2 m, so it reads as a surface rather than as noise) and
 * the coat carries a genuine ~7 mm peel octave ON TOP of the long flow at a
 * tilt you can actually see in a reflection. 0.12 is about 7 deg of tangent
 * tilt on the peel octave, which is what breaks a mirrored horizon into the
 * dimpled band real lacquer shows.
 */
const COAT_NORMAL_SCALE = 0.12;
/**
 * Chrome bakes its Toksvig against the same flow field but at its OWN normal
 * scale (the material binds coatNormal at 0.045). It used to be handed
 * COAT_NORMAL_SCALE, which was harmless while the two numbers were 0.055 and
 * 0.045 and is a 2.7x over-compensation now that the coat has peel in it.
 */
const CHROME_NORMAL_SCALE = 0.045;
const PLASTIC_NORMAL_SCALE = 0.30;
/** Nomex is a fine woven cloth: the weave has to be felt, never seen. */
const CLOTH_NORMAL_SCALE = 0.42;
/** UVs are authored in metres, so repeat = tiles per metre. */
const PAINT_REPEAT = 6;    // 167 mm tile -> the fBm cell below is ~6 mm
const COAT_REPEAT = 1.7;   // 588 mm tile, shares no factor with the base coat
const PLASTIC_REPEAT = 4;
/** 128 mm tile over a 256 px map: one weave cell lands at ~2.5 mm. */
const CLOTH_REPEAT = 7.8;

interface SurfaceDetail {
  paintNormal: THREE.Texture;
  paintRough: THREE.Texture;
  coatNormal: THREE.Texture;
  coatRough: THREE.Texture;
  plasticNormal: THREE.Texture;
  plasticRough: THREE.Texture;
  chromeRough: THREE.Texture;
  clothNormal: THREE.Texture;
  clothRough: THREE.Texture;
}
let _detail: SurfaceDetail | null = null;

function surfaceDetail(): SurfaceDetail {
  if (_detail) return _detail;
  const S = 512;

  // ---- lacquer base coat -------------------------------------------------
  // fBm cell ~18 px against a 512 px / 167 mm tile = a 6 mm dimple. It was 6 px
  // / 2 mm, which at the closeup framing (a 0.6 m panel across ~450 px) is
  // slightly under ONE SCREEN PIXEL per dimple: the mip chain cannot resolve it,
  // the Toksvig bake converts it to roughness at every level below mip 0, and
  // what is left at mip 0 is a per-pixel shimmer that reads as flocking. 6 mm is
  // three to four pixels at the same framing, so it reads as a surface.
  const peel = canvas(S);
  fbmFill(peel, 0, 0, S, S, 0.055, 3, 7717, (n) => {
    const v = 128 + (n - 0.5) * 46;
    return [v, v, v];
  });
  // polish swirls — deliberately fainter than the peel so they only show when
  // the sun rakes across a panel. Widened off sub-pixel for the same reason as
  // the peel: a 0.6 px stroke is not a swirl, it is aliasing with a direction.
  peel.globalAlpha = 0.13;
  peel.strokeStyle = '#fff';
  const rnd = lcg(4242);
  for (let i = 0; i < 46; i++) {
    peel.lineWidth = 1.8 + rnd() * 1.6;
    peel.beginPath();
    const x = rnd() * S;
    const y = rnd() * S;
    const a = rnd() * Math.PI;
    const l = 20 + rnd() * 110;
    peel.moveTo(x, y);
    peel.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    peel.stroke();
  }
  peel.globalAlpha = 1;
  const peelSlope = heightSlope(peel, 0.40);
  const paintNormal = tex(slopeToNormal(peelSlope, S, S), false, PAINT_REPEAT);

  // Base roughness 0.24..0.31, in PANEL-SIZED sweeps rather than 54 mm blotches.
  //
  // The old field was scale 0.006 x 4 octaves on a 512 map: a fundamental at
  // ~166 px (54 mm on the tile) with three octaves under it reaching 7 mm, over
  // a 0.12 range. That is a dirt map. It does not read as "the roughness varies
  // spatially" (§4), it reads as mottling in the ALBEDO, because a 0.12 swing in
  // roughness on a diffuse-dominated red panel changes the broad sky term by
  // more than it changes the lobe. Three octaves from a 290 mm fundamental keeps
  // the §4 requirement — a bonnet is still not one value anywhere — while the
  // smallest feature is 70 mm, which is a sweep across a panel and not a stain.
  const prough = canvas(S);
  fbmFill(prough, 0, 0, S, S, 0.0034, 3, 991, (n) => {
    const v = Math.round((0.24 + n * 0.07) * 255);
    return [v, v, v];
  });
  const paintRough = toksvigTexture(prough, peelSlope, PAINT_NORMAL_SCALE, PAINT_REPEAT, true, 0.23);

  // ---- clearcoat ---------------------------------------------------------
  // Long-wave spray-gun flow, one seventh the frequency of the peel and on an
  // incommensurate repeat. This is the second, tighter highlight lobe.
  const C = 256;
  const flow = canvas(C);
  fbmFill(flow, 0, 0, C, C, 0.028, 2, 3311, (n) => {
    const v = 128 + (n - 0.5) * 46;
    return [v, v, v];
  });
  // ...PLUS THE PEEL ITSELF. This is the term the closeup note was actually
  // missing, and it is worth being precise about how much was missing. The flow
  // alone is a 36-texel wave of 0.09 amplitude; Sobel it at strength 0.42 and
  // multiply by the old COAT_NORMAL_SCALE of 0.055 and the coat's peak tangent
  // tilt was 0.08 DEGREES. The clearcoat normal map was, numerically, off.
  //
  // 256 px over a 588 mm tile is 2.3 mm per texel, so an 8-texel cell is a
  // ~19 mm dimple — orange peel at Nintendo scale, coarse enough that a
  // reflected horizon visibly ripples instead of dissolving. It is composited
  // ON the flow rather than replacing it, and it goes into the HEIGHT before
  // the Sobel so both frequencies share one slope field and therefore one
  // Toksvig bake: whatever mips away becomes coat roughness instead of sparkle.
  // With the scale below the peak tilt is ~1.7 deg, i.e. twenty times what the
  // coat had. (The long flow now contributes little to the NORMAL; it still
  // carries the coat's roughness hazes and the chrome's polish bake, which is
  // where it was always doing the work.)
  {
    const dimple = canvas(C);
    fbmFill(dimple, 0, 0, C, C, 0.12, 2, 5507, (n) => {
      const v = 128 + (n - 0.5) * 110;
      return [v, v, v];
    });
    flow.globalAlpha = 0.45;
    flow.drawImage(dimple.canvas, 0, 0);
    flow.globalAlpha = 1;
  }
  const flowSlope = heightSlope(flow, 0.42);
  const coatNormal = tex(slopeToNormal(flowSlope, C, C), false, COAT_REPEAT);
  // Coat roughness 0.026..0.086 in soft panel-sized hazes — the crown of a
  // bonnet stays near-mirror, the flanks haze off. Tightened about 25% off
  // round 6: a clearcoat at 0.11 spreads the sun's 1.1 deg disc over ~12 deg of
  // panel, which is a sheen, not a highlight. §4 asks for clearcoatRoughness
  // 0.06; this brackets it instead of sitting above it.
  const crough = canvas(C);
  fbmFill(crough, 0, 0, C, C, 0.010, 3, 8123, (n) => {
    const v = Math.round((0.026 + n * 0.060) * 255);
    return [v, v, v];
  });
  const coatRough = toksvigTexture(crough, flowSlope, COAT_NORMAL_SCALE, COAT_REPEAT, true, 0.026);

  // ---- moulded plastic ---------------------------------------------------
  const grain = canvas(S);
  fbmFill(grain, 0, 0, S, S, 0.085, 3, 5150, (n) => {
    const v = 128 + (n - 0.5) * 96;
    return [v, v, v];
  });
  const grainSlope = heightSlope(grain, 0.55);
  const plasticNormal = tex(slopeToNormal(grainSlope, S, S), false, PLASTIC_REPEAT);
  // Floor of 0.48. Dark structural trim must never go glossier than this or it
  // strobes, and nothing on a kart floorpan is polished anyway.
  const prg = canvas(S);
  fbmFill(prg, 0, 0, S, S, 0.014, 3, 2277, (n) => {
    const v = Math.round((0.52 + n * 0.34) * 255);
    return [v, v, v];
  });
  const plasticRough = toksvigTexture(prg, grainSlope, PLASTIC_NORMAL_SCALE, PLASTIC_REPEAT, true, 0.48);

  // ---- chrome ------------------------------------------------------------
  // 0.08..0.24 around the bible's 0.15, riding the same long-wave flow as the
  // clearcoat so a bumper and the bodywork next to it feel hand-polished by
  // the same person.
  //
  // The frequency is the change from round 3. At scale 0.012 on a 256 map one
  // roughness feature is ~83 texels, and against COAT_REPEAT's 588 mm tile that
  // is a 190 mm cell: the front rub strip is a metre long and got five of them,
  // which is not a break, it is a slow drift. 0.045 puts a cell every ~50 mm,
  // so the highlight running along a bumper is interrupted several times per
  // its own width. Chrome does not look polished because it is uniformly
  // smooth; it looks polished because it is ALMOST uniformly smooth.
  //
  // ROUND 7: the range moves off 0.08..0.24 to 0.13..0.32, and that is the
  // bumper note, not a taste change. The front rub strip is a 1 m metalness-1
  // bar aimed at a golden-hour horizon whose radiance is above 1.0 linear
  // BEFORE the key and the bloom get to it. At roughness 0.08 it returns that
  // horizon nearly mirror-sharp over its whole length, clips, blooms, and
  // arrives as the unbroken white-and-blue tube the review called a lightsaber.
  // §4's "chrome 0.15" is a centre, not a floor: 0.13..0.32 still brackets it,
  // and the extra spread is what turns one clipped bar into a rolled highlight
  // with tarnish either side of it. Paired with a 0.72x cut in `ENV_TARGET`.
  const chr = canvas(C);
  fbmFill(chr, 0, 0, C, C, 0.045, 3, 6611, (n) => {
    const v = Math.round((0.13 + n * 0.19) * 255);
    return [v, v, v];
  });
  const chromeRough = toksvigTexture(chr, flowSlope, CHROME_NORMAL_SCALE, COAT_REPEAT, true, 0.12);

  // ---- race-suit cloth ---------------------------------------------------
  // The driver shared the moulded-plastic family in round 1, so the suit, the
  // gloves and the lacquered helmet all answered the sun with one roughness —
  // and a figure whose cloth is as tight as the car's paint reads as a plastic
  // toy inside a plastic toy. Nomex is a twill: two interlaced thread runs at
  // 90 degrees, a *high* roughness (0.80-0.94) and a normal fine enough that at
  // hero distance it only shows as a soft sheen break across a shoulder.
  const W = 256;
  const weave = canvas(W);
  {
    const img = weave.createImageData(W, W);
    const d = img.data;
    const CELL = 8; // px per thread pair -> ~2.5 mm on the body
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        // two sine runs in quadrature; the twill offset makes the over/under
        // alternate diagonally instead of forming a visible checker
        const twill = ((Math.floor(x / CELL) + Math.floor(y / CELL)) & 1) ? 1 : -1;
        const warp = Math.sin((x / CELL) * Math.PI * 2) * 0.5 + 0.5;
        const weft = Math.sin((y / CELL) * Math.PI * 2) * 0.5 + 0.5;
        const h = 128 + (warp - weft) * twill * 44 + (warp + weft - 1) * 10;
        const i = (y * W + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = h;
        d[i + 3] = 255;
      }
    }
    weave.putImageData(img, 0, 0);
  }
  const weaveSlope = heightSlope(weave, 0.30);
  const clothNormal = tex(slopeToNormal(weaveSlope, W, W), false, CLOTH_REPEAT);
  const crg = canvas(W);
  fbmFill(crg, 0, 0, W, W, 0.02, 3, 6421, (n) => {
    const v = Math.round((0.80 + n * 0.14) * 255);
    return [v, v, v];
  });
  const clothRough = toksvigTexture(crg, weaveSlope, CLOTH_NORMAL_SCALE, CLOTH_REPEAT, true, 0.78);

  _detail = {
    paintNormal, paintRough, coatNormal, coatRough, plasticNormal, plasticRough, chromeRough,
    clothNormal, clothRough,
  };
  return _detail;
}

export function paintTextures() {
  const d = surfaceDetail();
  return { normal: d.paintNormal, rough: d.paintRough };
}

// --- environment response ----------------------------------------------------
//
// `envMapIntensity` is multiplied by `scene.environmentIntensity`, and the sky
// subsystem currently ships a global of 0.40. In round 1 that silently crushed
// every kart material: the paint's authored 1.15 arrived as 0.46, the wheel's
// 1.0 as 0.40, and a metalness-1 rim with a 0.4x environment has nothing left
// to be metal WITH — which is why the roster read as matte clay.
//
// Rather than bake 1/0.40 into eight literals that rot the moment the sky is
// retuned, these are ABSOLUTE targets (the value each material would want at a
// global of 1) and `syncKartEnv` rescales them from the live scene value. One
// float compare per frame, called from the kart's own onBeforeRender.
const ENV_TARGET = {
  // 1.25 was authored against a 0.40 global that no longer exists, and with the
  // global back at 1.0 it means the lacquer was reflecting the sky at 125% —
  // more light than the environment contains. A clear coat cannot do that. What
  // it produced is the r7 note: on the closeup the red kart's saturated pixels
  // ran hue 300–345 with an 8% clump at 240–260, against `#ff3b5c`'s own 350,
  // i.e. the panel's hue was a running average of "roster red" and "sunset sky"
  // that swung with view angle — which is precisely what reads as iridescence.
  // 0.95 is the honest ceiling; `PAINT_ENV_RESPONSE` below does the rest, and
  // it does it in chroma rather than in energy so the highlight is untouched.
  paint: 0.95,
  // 1.55 -> 1.12. A metalness-1 surface at 1.55 is returning 155% of the
  // radiance in the probe, and the probe's horizon band at 14 deg elevation is
  // already superwhite. The front rub strip is the worst case in the game for
  // that (a metre of near-cylinder pointed straight at the low sun) and it is
  // the shot the review called a lightsaber. 1.12 keeps chrome the brightest
  // material on the kart — §2 explicitly wants chrome highlights to clip and
  // bloom — while leaving the CORE of the highlight to clip rather than the
  // whole bar. The roll bar and the exhaust stacks were never the problem and
  // they still read as mirrors; they curve, so they only ever show the horizon
  // along a line.
  chrome: 1.12,
  plastic: 0.55,
  // 0.95 -> 0.72. See the wheel atlas: the tyre reading tan is an ALBEDO fault
  // and it is fixed there, not here. But 0.95 was still wrong on its own terms —
  // rubber is a dielectric with an F0 near 0.05, and at a roughness of 0.62-0.92
  // its specular is supposed to be a broad, dim sheen rather than a mirror of a
  // sunset. 0.72 is where the flank sheen band survives without the tyre picking
  // up a hue from the sky it is standing under.
  wheel: 0.72,
  glass: 2.2,
  character: 0.70,
  // The distant kart is one merged surface standing in for six, so its env
  // response is the area-weighted middle of the set it replaces: mostly paint,
  // with the tyres and the suit pulling it down. Follows the paint down: it is
  // a stand-in for the paint and the roster colour has to survive the LOD swap.
  impostor: 0.85,
} as const;

/**
 * What the lacquer is allowed to take from the environment probe.
 *
 * The reflection keeps its LUMINANCE (so the coat's highlight is the same
 * brightness and the same shape it was — the lobe is what makes a kart read as
 * a toy with real lacquer and nothing here touches it) and gives up most of its
 * CHROMA, so a bright pink-to-violet procedural sunset can no longer out-vote
 * the pigment underneath it. Slightly harder at grazing than head-on, because
 * grazing is where clearcoat Fresnel goes to 1 and where a panel edge was
 * turning violet outright.
 *
 * This matters beyond one kart looking right: the HUD, the position board and
 * the minimap all identify racers by roster colour, and `#ff3b5c` (Vela) drifted
 * far enough toward magenta to start colliding with `#8b5cf6` (Onyx) and
 * `#e8456b` (Cinder) — three of the eight, unreadable at minimap dot size.
 *
 * ROUND 7 — THE ENERGY RAMP IS INVERTED, AND THAT IS THE LACQUER NOTE.
 *
 * The docblock above says the fix "does it in chroma rather than in energy so
 * the highlight is untouched". The numbers did not: faceScale 1.0 / grazeScale
 * 0.72 is a ramp that DIMS the reflection as the surface turns away, which is
 * the exact opposite of Fresnel. Every dielectric coat on earth goes from ~4%
 * reflectance head-on to 100% at grazing, and that ramp is the single strongest
 * cue the eye uses to tell lacquer from unglazed clay. Suppressing it is why
 * the closeup shows a flat pale veil across the rear fender crown (a head-on
 * panel taking the sky at full strength) and no bright coat edge anywhere on a
 * silhouette (a grazing panel taking it at 72%). Terracotta, precisely.
 *
 * So: 0.82 head-on, 1.30 at grazing. Total energy over a curved panel is
 * roughly unchanged — it is redistributed from the middle, where it was
 * washing the pigment out, to the edges, where a coat belongs. The chroma
 * clamp that actually fixed the iridescence is untouched (and pulled a little
 * harder at grazing, which is now the brighter end).
 */
const PAINT_ENV_RESPONSE = {
  faceScale: 0.82,
  grazeScale: 1.30,
  faceChroma: 0.45,
  grazeChroma: 0.26,
  power: 3.0,
} as const;

/** Last observed `scene.environmentIntensity`; 0.40 until the sky reports in. */
let _envGlobal = 0.40;

function envFor(k: keyof typeof ENV_TARGET) {
  return ENV_TARGET[k] / Math.max(0.02, _envGlobal);
}

/**
 * Re-key every kart material to the scene's current environment intensity.
 * Cheap and idempotent — call it from a render hook and forget about it.
 */
export function syncKartEnv(sceneEnvIntensity: number) {
  const g = Math.max(0.02, sceneEnvIntensity);
  if (Math.abs(g - _envGlobal) < 1e-4) return;
  _envGlobal = g;
  if (_mats) {
    _mats.paint.envMapIntensity = envFor('paint');
    _mats.chrome.envMapIntensity = envFor('chrome');
    _mats.plastic.envMapIntensity = envFor('plastic');
    _mats.wheel.envMapIntensity = envFor('wheel');
    _mats.glass.envMapIntensity = envFor('glass');
    _mats.character.envMapIntensity = envFor('character');
  }
  if (_heroPaint) _heroPaint.envMapIntensity = envFor('paint');
  if (_impostor) _impostor.envMapIntensity = envFor('impostor');
  for (const m of _gripArms) m.envMapIntensity = envFor('character');
  for (const l of _liveries.values()) l.decalMat.envMapIntensity = envFor('paint');
}

// --- driver arm grip skin ----------------------------------------------------
//
// THE HANDS MUST BE ON THE RIM AT EVERY STEERING ANGLE, AND THEY WERE NOT.
//
// Driver.ts derives the whole glove from RIM_R — palm outboard of the rim,
// finger roll inboard, thumb along the tangent — so at REST the grip is exact
// and built by construction. Then the rig turned the wheel by -steer * 0.85 and
// the arms (one rigid mesh) by -steer * 0.22, both about the column axis. At
// full lock that is 0.63 rad of relative rotation on a 155 mm rim: the hands
// slide 98 mm around the wheel and end up beside it. Every review shot with any
// steering in it therefore shows two pale blocks floating next to a rim, which
// is exactly what the closeup note reports — and no amount of modelling the
// hand better can fix a rig that moves it off the thing it is holding.
//
// The arm cannot simply ride the wheel node instead: the shoulder is 0.35 m off
// the column axis, so 0.85 rad there would tear the deltoid out of the torso.
// What is wanted is a two-bone limb — shoulder fixed, wrist on the rim, elbow
// solved between them — and the cheapest honest version of that on a mesh this
// small is a one-bone linear blend skin. Each vertex carries `aGrip` (0 at the
// deltoid, 1 at the glove, ramped across the forearm) and the vertex shader
// rotates it about the column axis by `uGrip * aGrip`. `uGrip` is set to the
// wheel node's own rotation, so aGrip == 1 IS the rim's frame: the grip is
// attached by construction again, and stays attached through full lock.
//
// Cost: one extra mat2 and a sin/cos on ~900 vertices per kart. No extra draw
// call — the arms were always their own mesh — but the uniform has to be per
// driver, so each rig gets a clone of the shared character material. Clones
// share one program (same cache key), so this is eight uniform blocks, not
// eight shader compiles.
const _gripArms: THREE.MeshStandardMaterial[] = [];

export interface GripArmMaterial {
  material: THREE.MeshStandardMaterial;
  /** Set to the steering wheel node's `rotation.y` every frame. */
  angle: { value: number };
}

export function gripArmMaterial(): GripArmMaterial {
  const m = kartMaterials().character.clone();
  const angle = { value: 0 };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGrip = angle;
    shader.vertexShader = `uniform float uGrip;\nattribute float aGrip;\n${shader.vertexShader}`
      // The rotation is about the mesh's local +Y, which is the steering column
      // axis: Driver.ts bakes the arms into the column frame for exactly this.
      // mat2(c,s,-s,c) is column-major, so this is the same (x,z) map three
      // applies for Object3D.rotation.y — the two cannot drift apart.
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float gA = uGrip * aGrip;
        float gC = cos( gA ), gS = sin( gA );
        mat2 gRot = mat2( gC, - gS, gS, gC );
        objectNormal.xz = gRot * objectNormal.xz;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.xz = gRot * transformed.xz;`,
      );
  };
  // Without this every clone would hash to the stock MeshStandardMaterial key
  // and three would hand them a program compiled from the UNPATCHED source.
  m.customProgramCacheKey = () => 'kartGripArm';
  m.envMapIntensity = envFor('character');
  _gripArms.push(m);
  return { material: m, angle };
}

// --- wheel atlas -------------------------------------------------------------
//
// One 1024² atlas drives all four wheels of all eight karts. Rows in V:
//   [0.00,0.26]  rim zone   — u<0.5 spoke/face metal, u>0.5 drilled brake disc
//   [0.26,0.29]  hub nut    — polished, roughness 0.10: the one sharp glint
//   [0.29,0.59]  sidewall   — moulded lettering, knurl band, bead AO, dust
//   [0.60,1.00]  tread      — chamfered blocks, grooves, polished crown band
// Roughness AND metalness come from one packed map (three reads G and B), so a
// tyre and an anodised rim can live in the same draw call.
//
// Round 1 read as "one uniform matte charcoal": the tread and the sidewall had
// the same roughness (0.92 / 0.78 flat), the albedo bottomed out near #0d0e12
// which the bible forbids, the moulded lettering overflowed its 256 px repeat
// and smeared into itself, and there was no polished contact band at all. All
// of that is authored below; the reason none of it *showed* is that the whole
// wheel was lit with envMapIntensity 1.0 x a 0.40 global (see ENV_TARGET).
//
// ---------------------------------------------------------------------------
// ROUND 7: "TAN / CARDBOARD BROWN". The tyre is not picking up the sky — the
// sky's DIFFUSE contribution is globally scaled to 0.115 by the sky system, so
// on a 0.2-albedo surface it is worth about a percent. The khaki was authored
// here, in three coats of dust that were individually defensible and together
// added up to a rendered albedo around #4a443c:
//
//   sidewall dust gradient   #c9a97e at 16% (bead) rising to 22% (shoulder)
//   tread groove grime       up to rgb(80,78,74) at 25%
//   tread valley dust        #c9a97e at up to 28%
//
// Composite those over a #26282e carcass and the flank comes out at roughly
// (74,68,64) — a warm mid-grey — and a warm #ffd9a8 key at intensity 4.2 then
// takes the lit face to about (130,115,95). That is cardboard, and it is what
// the review measured. The dust is not deleted (a racing tyre is not clean and
// §6 asks for surface-keyed dirt): it is cut to roughly a third, moved off the
// block crowns that a revolution wipes clean, and cooled from a sand tan
// (#c9a97e) toward a grey road film (#9d968a), which is what actually collects
// on rubber. The carcass itself drops to the bible's carbon black.
// ---------------------------------------------------------------------------

/** Carcass rubber. §3 forbids pure #000; this is as dark as rubber may go. */
const RUBBER_BASE = '#1a1b1f';
/** Moulded block face — slightly lifted off the carcass so blocks read. */
const RUBBER_BLOCK = '#232429';
/** Groove floor: in shadow under the blocks, so darker still, never black. */
const RUBBER_GROOVE = '#141519';
/** Road film. Grey, not sand: this is brake dust and tarmac, not beach. */
const DUST_R = 157, DUST_G = 150, DUST_B = 138;

export const WHEEL_UV = {
  rimFace: [0.02, 0.02, 0.46, 0.235] as const,  // x,y,w,h in UV space
  disc: [0.52, 0.02, 0.46, 0.235] as const,
  nut: [0.0, 0.262, 1.0, 0.024] as const,
  sidewall: [0.0, 0.29, 1.0, 0.30] as const,
  tread: [0.0, 0.60, 1.0, 0.40] as const,
};

let _wheelMaps: { map: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture } | null = null;

function wheelMaps() {
  if (_wheelMaps) return _wheelMaps;
  const S = 1024;
  const alb = canvas(S);
  const hgt = canvas(S);
  const orm = canvas(S);
  const px = (u: number) => u * S;

  // Base fill FIRST, over the whole atlas, before any zone is painted.
  // The zone rects below do not tile the canvas edge to edge — there is a 10 px
  // gutter between the sidewall band (v <= 0.590) and the tread band
  // (v >= 0.600), and a 4 px one under the hub-nut band. A canvas starts out
  // transparent black, so those gutters were albedo #000 (which the bible
  // forbids outright) and, far worse, height 0 — a cliff from 0x6a to 0x00 and
  // back that the Sobel turns into a hard bright/dark ring. The tyre's own
  // profile interpolates v from 0.575 to 0.620 across the shoulder quad, so it
  // walks straight through that gutter: a garbage highlight ring exactly where
  // the sidewall meets the tread, on the closest object to the camera all race.
  alb.fillStyle = RUBBER_BASE;
  alb.fillRect(0, 0, S, S);
  hgt.fillStyle = '#6a6a6a';
  hgt.fillRect(0, 0, S, S);

  /**
   * A block whose height ramps in over a rolled shoulder instead of stepping.
   *
   * Round 3's version was a five-step staircase from 0x46 to 0xdc, and it laid
   * that staircase on a groove floor of 0x30. Two things came out of that, both
   * of them in the closeup note. The outermost tread of the staircase is a
   * FLAT 22-level jump off the groove floor with no ramp under it at all — a
   * one-texel wall, i.e. the §5 hard-90-degree tell in texture space, which
   * Sobels into the thin blown-white wire running round every block. And five
   * steps over a 6 px bevel is a 1.2 px tread each, so even the ramp that is
   * there arrives as four more little walls rather than a curve.
   *
   * `lo` is now taken to be the groove floor the block is sitting on, so the
   * shoulder leaves it with no discontinuity, and the profile is a quarter
   * cosine over 16 rings across a 9 px (≈21 mm of tread circumference) bevel.
   * The Sobel of that is a smooth gradient that peaks in the middle of the
   * shoulder — a rolled highlight, which is what the note asked for.
   */
  const chamferedBlock = (
    c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    r: number, lo: number, hi: number, steps = 16,
  ) => {
    const bevel = Math.min(9, Math.min(w, h) * 0.22);
    for (let k = 0; k < steps; k++) {
      const s = k / (steps - 1);
      const inset = (1 - s) * bevel;
      // quarter cosine: tangential to the groove floor at s=0 and to the block
      // face at s=1, so neither end of the shoulder carries an edge
      const v = Math.round(lo + (hi - lo) * (1 - Math.cos(s * Math.PI * 0.5)));
      c.fillStyle = `rgb(${v},${v},${v})`;
      rr(c, x + inset, y + inset, w - inset * 2, h - inset * 2, Math.max(1, r - inset));
      c.fill();
    }
  };

  // ---- tread -------------------------------------------------------------
  const t = WHEEL_UV.tread;
  const tx0 = px(t[1]);
  const th = px(t[3]);
  alb.fillStyle = RUBBER_GROOVE;       // groove floor — dark, never #000
  alb.fillRect(px(t[0]), tx0, px(t[2]), th);
  hgt.fillStyle = '#303030';
  hgt.fillRect(px(t[0]), tx0, px(t[2]), th);
  const BLOCKS = 10;
  const bw = S / BLOCKS;
  for (let i = 0; i < BLOCKS; i++) {
    for (let row = 0; row < 3; row++) {
      const skew = row === 1 ? bw * 0.28 : 0;
      const x = i * bw + skew;
      const y = tx0 + th * (0.06 + row * 0.31);
      const h = th * 0.26;
      const w = bw * (row === 1 ? 0.74 : 0.66);
      // The centre row is the contact band. Rubber that has been scrubbed on
      // tarmac is DARKER and glossier than moulded rubber, not lighter — round 6
      // had the crown row as the lightest thing on the tyre, which is backwards
      // and is half of why the tread read as one flat tan extrusion.
      const top = row === 1 ? '#1c1d22' : RUBBER_BLOCK;
      // lo == the groove floor painted above, so the shoulder starts flush
      chamferedBlock(hgt, x, y, w, h, 10, 0x30, 0xdc);
      alb.fillStyle = top;
      rr(alb, x + 2, y + 2, w - 4, h - 4, 9);
      alb.fill();
      // wrap the block that runs off the right edge back onto the left
      if (x + w > S) {
        chamferedBlock(hgt, x - S, y, w, h, 10, 0x30, 0xdc);
        alb.fillStyle = top;
        rr(alb, x - S + 2, y + 2, w - 4, h - 4, 9); alb.fill();
      }
    }
  }
  // grime in the grooves so the tread is not uniformly clean. 0.14, not 0.25,
  // and a source that tops out at 52 rather than 80: this pass alone was
  // lifting the whole tread band by ~15 levels of warm grey.
  alb.globalAlpha = 0.14;
  fbmFillInto(alb, 0, tx0, S, th, 0.02, 3, 313, (n) => {
    const v = Math.round(16 + n * 36);
    return [v, v - 1, v - 4];
  });
  alb.globalAlpha = 1;
  // (the tread's dust is applied after the height field is complete — see the
  // valley pass below the sidewall, which needs to know where the valleys are)

  // ---- sidewall ----------------------------------------------------------
  const sw = WHEEL_UV.sidewall;
  const sy = px(sw[1]);
  const sh = px(sw[3]);
  alb.fillStyle = RUBBER_BASE;
  alb.fillRect(0, sy, S, sh);
  hgt.fillStyle = '#6a6a6a';
  hgt.fillRect(0, sy, S, sh);
  // RADIAL RIBS — the fine vertical relief that runs up a real tyre's lower
  // flank from the bead. The review asked for them by name and they are the
  // cheapest sidewall cue there is: 88 ribs over the circumference at this
  // radius is a ~23 mm pitch (≈11 texels), which survives every mip the wheel
  // will ever be seen at, unlike the 9 mm knurl further out. Height only — a
  // rib is relief, not a stripe, and painting it into the albedo as well is how
  // a moulded feature starts reading as a printed one.
  for (let i = 0; i < 88; i++) {
    const x = (i / 88) * S;
    const g = hgt.createLinearGradient(0, sy + sh * 0.06, 0, sy + sh * 0.40);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.30)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    hgt.fillStyle = g;
    hgt.fillRect(x, sy + sh * 0.06, S / 88 * 0.42, sh * 0.34);
  }
  // Knurl band, moved OUT to the shoulder end of the flank (v 0.72-0.94). It
  // used to sit at 0.60-0.90, straight through the space the moulded lettering
  // needs once that lettering is clear of the bead AO — see below.
  // U is the circumference; the
  // band sits at ~0.32 m radius, so 2.0 m of arc across 1024 px, and 220
  // serrations is a ~9 mm pitch — about 4.6 texels. The note asked for 2 mm,
  // which at this texel density is 1/5 of a texel: pure mip fodder that would
  // arrive as nothing but aliasing however it were authored. 9 mm is the finest
  // pitch this atlas can actually carry, and the Toksvig bake below converts
  // what does mip away into sheen rather than losing it.
  for (let i = 0; i < 220; i++) {
    const x = (i / 220) * S;
    const v = i % 2 ? 0x86 : 0x50;
    hgt.fillStyle = `rgb(${v},${v},${v})`;
    hgt.fillRect(x, sy + sh * 0.72, S / 220 - 0.6, sh * 0.22);
  }
  // Moulded lettering, four legends around the circumference, drawn mirrored:
  // the revolve winds U the other way on the flank you actually see, so this is
  // what makes it read forwards on the outboard sidewall. Each legend is
  // measured and scaled to fit its 256 px slot — round 1 let 'GT 360 / R'
  // overflow by 30% and the four repeats overprinted into mush.
  const fitText = (c: CanvasRenderingContext2D, str: string, size: number, maxW: number) => {
    c.font = `900 ${Math.round(size)}px "Arial Black", Impact, system-ui, sans-serif`;
    const w = c.measureText(str).width;
    return w > maxW ? Math.round(size * (maxW / w)) : Math.round(size);
  };
  // Baseline at 0.46 of the flank, not 0.28. The bead AO below paints up to 78%
  // black over v 0.00-0.20 and its feather reaches ~0.26; a 52 px legend with
  // its baseline at 0.28 has its whole cap height inside that, which is why
  // round 2 reported "no sidewall lettering" on a tyre that has had lettering
  // all along. 0.46 also puts it on the widest part of the carcass, which is
  // the band actually facing the camera when the wheel is alongside.
  const slot = S / 4;
  for (let i = 0; i < 4; i++) {
    const cx = (i + 0.5) * slot;
    for (const c of [hgt, alb]) {
      c.save();
      c.translate(cx, sy + sh * 0.46);
      c.scale(-1, 1);
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      const big = fitText(c, '落日湾', 52, slot * 0.86);
      c.font = `900 ${big}px "Arial Black", Impact, system-ui, sans-serif`;
      // raised letters: a dark drop under a bright face reads as a moulded
      // edge once the Sobel gets hold of it
      // Contrast raised against the new (much darker) carcass. On a #26282e
      // flank a #54565f letter face was 12 levels of separation, which is gone
      // by the second mip; on #1a1b1f at #6d707b it is 83, and the legend
      // survives to the distance the pack shot is taken from.
      c.fillStyle = c === hgt ? '#3d3d3d' : '#101116';
      c.fillText('落日湾', 0, 3);
      c.fillStyle = c === hgt ? '#f6f6f6' : '#6d707b';
      c.fillText('落日湾', 0, 0);
      const small = fitText(c, '径向轮胎 · 360 型', 26, slot * 0.80);
      c.font = `700 ${small}px "Arial Black", Impact, system-ui, sans-serif`;
      c.fillStyle = c === hgt ? '#c8c8c8' : '#4e515b';
      c.fillText('径向轮胎 · 360 型', 0, 32);
      c.restore();
    }
  }
  // Bead AO where the sidewall dives under the rim flange. WHICH END OF THE
  // BAND THAT IS matters and was wrong: the revolve profile pairs v with
  // radius, and it walks 0.300 -> 0.575 as the radius grows 0.200 -> 0.350, so
  // LOW v is the bead at the rim and HIGH v is the shoulder under the tread.
  // Painted at the high-v end this 78%-black gradient landed as a hard dark
  // ring around the tyre's outer shoulder — and left the one contact the bible
  // calls mandatory, tyre-to-rim, with no occlusion term at all.
  const bead = alb.createLinearGradient(0, sy + sh * 0.20, 0, sy);
  bead.addColorStop(0, 'rgba(0,0,0,0)');
  bead.addColorStop(0.7, 'rgba(0,0,0,0.55)');
  bead.addColorStop(1, 'rgba(0,0,0,0.78)');
  alb.fillStyle = bead;
  alb.fillRect(0, sy, S, sh * 0.20);
  // Road film on the flank. A THIRD of what it was, and grey instead of sand:
  // 22% of #c9a97e over the mid-flank is not a dusty tyre, it is a beige tyre,
  // and it is most of the "tan / cardboard brown" the review measured. What is
  // left is a hint in the bead trough and a scuff at the kerb-struck shoulder,
  // which is where a kart tyre actually carries dirt.
  const film = `${DUST_R},${DUST_G},${DUST_B}`;
  const swDust = alb.createLinearGradient(0, sy, 0, sy + sh);
  swDust.addColorStop(0.00, `rgba(${film},0.07)`); // bead, dust collects in it
  swDust.addColorStop(0.55, `rgba(${film},0.01)`);
  swDust.addColorStop(1.00, `rgba(${film},0.09)`); // shoulder, kerb-scuffed
  alb.fillStyle = swDust;
  alb.fillRect(0, sy, S, sh);

  // ---- rubber grain ------------------------------------------------------
  // The closeup note: "no rubber micro-normal ... sidewall and tread have the
  // same response". The roughness plateaus were already different; what was
  // missing is any relief at all between the moulded features, so both bands
  // answered the sun as a perfectly smooth surface at two different gloss
  // levels — which is a painted plastic doughnut, not rubber. One moulded grain
  // across both bands (rows 297..1024 of the atlas are sidewall + tread and
  // nothing else) gives the whole tyre a break-up finer than any of its
  // features, and the Toksvig bake below converts whatever mips away into
  // roughness rather than losing it to sparkle.
  const grainY = Math.round(sy);
  addGrain(hgt, grainY, S - grainY, 1.6, 7.0, 61207);

  // ---- dust in the tread valleys -----------------------------------------
  // §6 asks for surface-keyed dirt and the review asked for build-up in the
  // tread despite the beach and off-track sections. Round 3 answered it with a
  // vertical gradient, which dusts the crown of a block and the floor of the
  // groove beside it by exactly the same amount — i.e. it reads as a tint, not
  // as dirt. Dirt is where dirt can stay: the groove floors and the moulded
  // shoulders keep it, a block face is wiped clean once a revolution. The
  // height field is the only thing that knows which is which, so this runs
  // after it is finished (grain included).
  {
    const ty = Math.round(tx0);
    const tH = Math.min(S - ty, Math.round(th));
    const band = alb.getImageData(0, ty, S, tH);
    const hb = hgt.getImageData(0, ty, S, tH).data;
    const ab = band.data;
    const DR = DUST_R, DG = DUST_G, DB = DUST_B; // grey road film, not beach sand
    for (let y = 0; y < tH; y++) {
      // across the tread: 0 at the crown, 1 at either shoulder
      const across = Math.abs((y / tH) * 2 - 1);
      // 0.02 on the crown, 0.13 at the shoulder — a third of round 6, and the
      // exponent on `depth` is now cubic rather than square so a block FACE
      // (depth 0) keeps essentially none of it. The crown of a kart tyre is
      // scrubbed clean by the road every revolution; the review's "cardboard"
      // was a 5% flat film sitting on exactly the band that should be blackest.
      const rim = 0.02 + 0.11 * across * across;
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        // 1 on the groove floor, 0 on a block face
        let depth = (hb[i] - 0x38) / (0xd0 - 0x38);
        depth = 1 - (depth < 0 ? 0 : depth > 1 ? 1 : depth);
        const a = rim * (0.12 + 0.88 * depth * depth * depth);
        ab[i] += (DR - ab[i]) * a;
        ab[i + 1] += (DG - ab[i + 1]) * a;
        ab[i + 2] += (DB - ab[i + 2]) * a;
      }
    }
    // POLISHED CONTACT BAND, in the albedo as well as the roughness. Scrubbed
    // rubber goes dark and slightly blue-black; this is what makes the crown of
    // the tyre read as "worn on tarmac" rather than as a lighter stripe. It runs
    // last so it survives the dust pass above rather than being dusted over.
    const crown = alb.createLinearGradient(0, ty + tH * 0.30, 0, ty + tH * 0.50);
    crown.addColorStop(0.0, 'rgba(9,10,13,0.0)');
    crown.addColorStop(1.0, 'rgba(9,10,13,0.34)');
    alb.putImageData(band, 0, ty);
    alb.fillStyle = crown;
    alb.fillRect(0, ty + tH * 0.30, S, tH * 0.20);
    const crown2 = alb.createLinearGradient(0, ty + tH * 0.70, 0, ty + tH * 0.50);
    crown2.addColorStop(0.0, 'rgba(9,10,13,0.0)');
    crown2.addColorStop(1.0, 'rgba(9,10,13,0.34)');
    alb.fillStyle = crown2;
    alb.fillRect(0, ty + tH * 0.50, S, tH * 0.20);
  }

  // ---- rim face ----------------------------------------------------------
  const rf = WHEEL_UV.rimFace;
  const rx = px(rf[0]) - 8, ry = px(rf[1]) - 8, rw = px(rf[2]) + 16, rh = px(rf[3]) + 16;
  // An anodised metal's albedo IS its reflection tint. #eef1f5 x a pastel
  // livery trim gave a near-white metal with nothing to darken it, which is
  // what made the rim read as flat pastel paint rather than as metal.
  alb.fillStyle = '#c2c9d2';
  alb.fillRect(rx, ry, rw, rh);
  hgt.fillStyle = '#808080';
  hgt.fillRect(rx, ry, rw, rh);
  // brushed streaks + a wiped highlight
  const rnd = lcg(88);
  for (let i = 0; i < 900; i++) {
    const y = ry + rnd() * rh;
    const x = rx + rnd() * rw;
    const l = 6 + rnd() * 40;
    alb.strokeStyle = `rgba(${rnd() > 0.5 ? 255 : 190},${255},${255},0.05)`;
    alb.lineWidth = 1;
    alb.beginPath(); alb.moveTo(x, y); alb.lineTo(x + l, y); alb.stroke();
    hgt.strokeStyle = 'rgba(255,255,255,0.06)';
    hgt.beginPath(); hgt.moveTo(x, y); hgt.lineTo(x + l, y); hgt.stroke();
  }
  // Baked AO down the V axis. The geometry addresses this zone so that low V is
  // the outboard lip and the spoke blades, high V is the barrel wall and the
  // closed back plate you see BETWEEN the spokes — so a ramp in V is exactly
  // the occlusion term the spoke recesses were missing.
  const rimAO = alb.createLinearGradient(0, ry, 0, ry + rh);
  rimAO.addColorStop(0.00, 'rgba(8,10,16,0.00)');
  rimAO.addColorStop(0.38, 'rgba(8,10,16,0.16)');
  rimAO.addColorStop(0.70, 'rgba(8,10,16,0.46)');
  rimAO.addColorStop(1.00, 'rgba(8,10,16,0.62)');
  alb.fillStyle = rimAO;
  alb.fillRect(rx, ry, rw, rh);

  // ---- hub nut band ------------------------------------------------------
  // One small polished zone. A single metalness-1 / roughness-0.10 element is
  // what puts a hard glint in the middle of the wheel and sells the rest of it
  // as metal by association.
  const nb = WHEEL_UV.nut;
  alb.fillStyle = '#e9edf2';
  alb.fillRect(0, px(nb[1]), S, px(nb[3]));
  hgt.fillStyle = '#9a9a9a';
  hgt.fillRect(0, px(nb[1]), S, px(nb[3]));

  // ---- brake disc --------------------------------------------------------
  const dc = WHEEL_UV.disc;
  const dx = px(dc[0]) - 8, dy = px(dc[1]) - 8, dw = px(dc[2]) + 16, dh = px(dc[3]) + 16;
  alb.fillStyle = '#6b7079';
  alb.fillRect(dx, dy, dw, dh);
  hgt.fillStyle = '#909090';
  hgt.fillRect(dx, dy, dw, dh);
  // drilled holes — u is the disc's radial axis here, so a plain grid reads as
  // the classic drilled pattern once it is wrapped round the disc
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const cx = px(dc[0]) + (gx + 0.5) * (px(dc[2]) / 16);
      const cy = px(dc[1]) + (gy + 0.5) * (px(dc[3]) / 4);
      alb.fillStyle = '#16181b';
      alb.beginPath(); alb.arc(cx, cy, 7, 0, Math.PI * 2); alb.fill();
      hgt.fillStyle = '#101010';
      hgt.beginPath(); hgt.arc(cx, cy, 7, 0, Math.PI * 2); hgt.fill();
    }
  }
  // heat discolouration
  alb.globalAlpha = 0.3;
  fbmFillInto(alb, px(dc[0]), px(dc[1]), px(dc[2]), px(dc[3]), 0.02, 3, 55, (n) => [
    Math.round(110 + n * 80), Math.round(95 + n * 62), Math.round(90 + n * 54),
  ]);
  alb.globalAlpha = 1;

  // ---- packed roughness (G) / metalness (B) ------------------------------
  const zone = (x: number, y: number, w: number, h: number, rough: number, metal: number) => {
    orm.fillStyle = `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
    orm.fillRect(x, y, w, h);
  };
  /** Vertical roughness ramp that leaves the metalness channel untouched. */
  const roughRamp = (
    x: number, y: number, w: number, h: number, metal: number,
    stops: [number, number][],
  ) => {
    const b = Math.round(metal * 255);
    const g = orm.createLinearGradient(0, y, 0, y + h);
    for (const [at, r] of stops) g.addColorStop(at, `rgb(255,${Math.round(r * 255)},${b})`);
    orm.fillStyle = g;
    orm.fillRect(x, y, w, h);
  };

  zone(0, 0, S, S, 0.9, 0);
  // THE POLARITY IS NOW THE PHYSICAL ONE: polished tread crown, matte flank.
  //
  // Round 6 ran the crown at 0.78 and the mid-flank at 0.62 — a tyre glossier
  // on the moulded sidewall than on the band that has been ground against
  // tarmac for three laps — and argued for it on the grounds that the flank
  // sheen is what says "torus". It does say that, but it also says "vinyl", and
  // combined with a tan albedo it is a large part of why the review read the
  // tyres as cardboard rather than as rubber: the one band with a specular
  // story was the one facing the camera with the wrong story.
  //
  // Crown 0.64, shoulders 0.93, flank 0.80-0.90. The "torus" read does not
  // depend on the flank out-glossing the tread — the flank is a large smooth
  // curve and it still carries a broad low-intensity sheen, which is exactly
  // what §4 and the review both describe rubber as wanting. What it no longer
  // does is out-shine the contact patch.
  roughRamp(0, tx0, S, th, 0, [
    [0.00, 0.94], [0.16, 0.92], [0.34, 0.74], [0.50, 0.64], [0.66, 0.74], [0.84, 0.92], [1.00, 0.94],
  ]);
  // Sidewall: matte moulded rubber. Slightly waxy at the mid-flank (0.80) where
  // it is unscuffed, dulling to 0.86 in the bead trough and 0.93 at the
  // kerb-rashed shoulder. Same v orientation as the bead AO above — low v is
  // the rim end.
  roughRamp(0, sy, S, sh, 0, [
    [0.00, 0.86], [0.22, 0.83], [0.46, 0.80], [0.72, 0.86], [1.00, 0.93],
  ]);
  zone(rx, ry, rw, rh, 0.30, 1);
  zone(0, px(nb[1]), S, px(nb[3]), 0.10, 1);
  zone(dx, dy, dw, dh, 0.42, 0.9);
  // Scuff the rubber so it is not a flat value either.
  //
  // The note is that the scuff "range is too narrow to see", and it is right:
  // one pass at alpha 0.35 over a 190..250 source is +-0.04 of roughness
  // against a 0.78..0.94 plateau. Nothing at that amplitude survives a tone
  // map. Two passes now, at different scales for the same reason the lacquer
  // runs two lobes — a broad worn/unworn patchiness round the circumference
  // (kart tyres do not wear evenly) under a finer kerb-and-gravel scuff — and
  // together they swing roughness by about 0.20. §9.3 asks for spatially
  // varying roughness; this is the tyre's share of it.
  //
  // The two TREAD alphas came down from 0.55/0.40 to 0.28/0.22 when the ramp
  // above was re-polarised. `fbmFillInto` composites toward an ABSOLUTE source,
  // so a 0.55-alpha pass whose source averages 0.79 drags a 0.64 crown to 0.72
  // and simply erases the polished contact band the ramp exists to author. At
  // 0.28 the crown lands near 0.67 and the shoulder near 0.87 — the same ±0.09
  // of local variation, applied as a modulation of the ramp rather than as a
  // replacement for it.
  orm.globalAlpha = 0.28;
  fbmFillInto(orm, 0, tx0, S, th, 0.012, 2, 4021, (n) => [255, Math.round(128 + n * 105), 0]);
  orm.globalAlpha = 0.22;
  fbmFillInto(orm, 0, tx0, S, th, 0.05, 3, 1207, (n) => [255, Math.round(140 + n * 90), 0]);
  orm.globalAlpha = 0.34;
  fbmFillInto(orm, 0, sy, S, sh, 0.025, 3, 4409, (n) => [255, Math.round(178 + n * 72), 0]);
  orm.globalAlpha = 0.4;
  fbmFillInto(orm, rx, ry, rw, rh, 0.02, 3, 71, (n) => [255, Math.round(52 + n * 78), 255]);
  orm.globalAlpha = 1;

  // flipY off so the pixel rows above ARE the V rows the geometry addresses —
  // otherwise every zone of the atlas lands on the wrong part of the wheel.
  const wheelSlope = heightSlope(hgt, 1.25);
  _wheelMaps = {
    map: tex(alb, true, 1, false),
    normal: tex(slopeToNormal(wheelSlope, S, S), false, 1, false),
    // 0.70 matches the material's normalScale; the knurl and the block edges
    // are both a few texels wide and would otherwise crawl on the shoulder.
    orm: toksvigTexture(orm, wheelSlope, 0.70, 1, false, 0.10),
  };
  return _wheelMaps;
}

/**
 * fbm into an existing context honouring globalAlpha (compositing overlay).
 * `res` caps the generated resolution — the noise is then upscaled, which is
 * the difference between a 60 ms boot and a 900 ms one.
 */
function fbmFillInto(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, w: number, h: number,
  scale: number, octaves: number, seed: number,
  map: (n: number) => [number, number, number],
  res = 320,
) {
  const k = Math.min(1, res / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const tmp = canvas(tw, th);
  fbmFill(tmp, 0, 0, tw, th, scale / k, octaves, seed, map);
  c.drawImage(tmp.canvas, x0, y0, w, h);
}

// ---------------------------------------------------------------------------
// 2. Geometry kit
// ---------------------------------------------------------------------------

/** One cross-section of a loft, in the local XY plane at `z`. */
export interface Section {
  z: number;
  /** half width / half height of the rounded rectangle */
  hw: number;
  hh: number;
  /** corner radius — this is the chamfer, never leave it at 0 */
  r?: number;
  /** centre offset of the section */
  x?: number;
  y?: number;
  /** >0 widens the top of the section, <0 the classic tub tumblehome */
  taper?: number;
}

export interface LoftOpts {
  /** samples per rounded corner; 2 gives a crisp chamfer, 3 a soft bevel */
  corner?: number;
  /**
   * End chamfer depth in metres; 0 leaves a flat unbevelled cap (avoid).
   * The chamfer is grown *outward*, so the finished part is this much longer
   * than the section list at each end.
   */
  capStart?: number;
  capEnd?: number;
  /** rings in the end chamfer: 1 = a flat 45 deg bevel, 2 = a rounded one */
  capSeg?: number;
  /** false leaves the loft open (used when a part butts into another) */
  closeStart?: boolean;
  closeEnd?: boolean;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export interface Built {
  geo: THREE.BufferGeometry;
  /** per-vertex colour role, resolved to RGB per livery */
  roles: Uint8Array;
  triangles: number;
}

/**
 * Accumulating triangle soup with a chamfered-loft primitive.
 * Every part of the kart is appended into one of a handful of Meshers, so a
 * complete kart is 12 draw calls instead of 60.
 */
export class Mesher {
  private pos: number[] = [];
  private uv: number[] = [];
  private role: number[] = [];
  private idx: number[] = [];

  private vcount() { return this.pos.length / 3; }

  private push(x: number, y: number, z: number, u: number, v: number, role: number, m?: THREE.Matrix4) {
    _v.set(x, y, z);
    if (m) _v.applyMatrix4(m);
    this.pos.push(_v.x, _v.y, _v.z);
    this.uv.push(u, v);
    this.role.push(role);
  }

  /**
   * Rounded-rectangle ring; returns [x,y,arcLen] triplets with the first point
   * repeated at the end so the U seam does not mirror a whole column of texels.
   */
  private ring(s: Section, corner: number): number[] {
    const hw = Math.max(1e-4, s.hw);
    const hh = Math.max(1e-4, s.hh);
    const r = Math.min(s.r ?? 0.05, hw * 0.98, hh * 0.98);
    const taper = s.taper ?? 0;
    const out: number[] = [];
    let arc = 0;
    let px = 0, py = 0;
    const quad = [
      [hw - r, -(hh - r), -Math.PI / 2],
      [hw - r, hh - r, 0],
      [-(hw - r), hh - r, Math.PI / 2],
      [-(hw - r), -(hh - r), Math.PI],
    ];
    for (let q = 0; q < 4; q++) {
      const [cx, cy, a0] = quad[q];
      for (let k = 0; k <= corner; k++) {
        const a = a0 + (k / corner) * (Math.PI / 2);
        let x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        x *= 1 + taper * (y / Math.max(1e-4, hh)); // tumblehome
        if (out.length) arc += Math.hypot(x - px, y - py);
        px = x; py = y;
        out.push(x + (s.x ?? 0), y + (s.y ?? 0), arc);
      }
    }
    arc += Math.hypot(out[0] - (s.x ?? 0) - px, out[1] - (s.y ?? 0) - py);
    out.push(out[0], out[1], arc);
    return out;
  }

  /**
   * Loft a chamfered tube through `sections` (ordered by increasing z) and cap
   * both ends with a rounded chamfer. UVs are in metres so every part of the
   * kart shares one texel density.
   */
  addLoft(sections: Section[], role: number, m?: THREE.Matrix4, o: LoftOpts = {}) {
    const corner = o.corner ?? 2;
    const capS = o.capStart ?? 0.035;
    const capE = o.capEnd ?? 0.035;
    const closeS = o.closeStart !== false;
    const closeE = o.closeEnd !== false;
    const CAP_SEG = o.capSeg ?? 2;

    // Expand into the full ring list: [start chamfer] + body + [end chamfer].
    // The chamfer profile is a quarter circle so the cap reads as a rounded
    // bevel and picks up a highlight from any direction.
    const rings: Section[] = [];
    const first = sections[0];
    const last = sections[sections.length - 1];
    if (closeS && capS > 0) {
      for (let k = CAP_SEG; k >= 1; k--) {
        const a = (k / CAP_SEG) * (Math.PI / 2);
        const inset = capS * (1 - Math.cos(a));
        rings.push({ ...first, z: first.z - capS * Math.sin(a), hw: first.hw - inset, hh: first.hh - inset });
      }
    }
    for (const s of sections) rings.push(s);
    if (closeE && capE > 0) {
      for (let k = 1; k <= CAP_SEG; k++) {
        const a = (k / CAP_SEG) * (Math.PI / 2);
        const inset = capE * (1 - Math.cos(a));
        rings.push({ ...last, z: last.z + capE * Math.sin(a), hw: last.hw - inset, hh: last.hh - inset });
      }
    }

    const base = this.vcount();
    const ringVerts: number[][] = [];
    let vAccum = 0;
    let prevZ = rings[0].z;
    for (const s of rings) {
      vAccum += Math.abs(s.z - prevZ);
      prevZ = s.z;
      const rg = this.ring(s, corner);
      ringVerts.push(rg);
      for (let i = 0; i < rg.length; i += 3) {
        this.push(rg[i], rg[i + 1], s.z, rg[i + 2], vAccum, role, m);
      }
    }
    const N = ringVerts[0].length / 3; // includes the duplicated seam vertex
    for (let r = 0; r < rings.length - 1; r++) {
      for (let j = 0; j < N - 1; j++) {
        const j2 = j + 1;
        const a = base + r * N + j;
        const b = base + r * N + j2;
        const c = base + (r + 1) * N + j2;
        const d = base + (r + 1) * N + j;
        this.idx.push(a, b, c, a, c, d);
      }
    }
    // flat centre caps (only when the chamfer left a hole to close)
    const capRing = (ri: number, front: boolean) => {
      const rg = ringVerts[ri];
      const z = rings[ri].z;
      let cx = 0, cy = 0;
      for (let i = 0; i < rg.length - 3; i += 3) { cx += rg[i]; cy += rg[i + 1]; }
      cx /= N - 1; cy /= N - 1;
      const c0 = this.vcount();
      this.push(cx, cy, z, 0.5, 0.5, role, m);
      const start = this.vcount();
      for (let i = 0; i < rg.length; i += 3) this.push(rg[i], rg[i + 1], z, rg[i + 2], 0, role, m);
      for (let j = 0; j < N - 1; j++) {
        const j2 = j + 1;
        if (front) this.idx.push(c0, start + j, start + j2);
        else this.idx.push(c0, start + j2, start + j);
      }
    };
    if (closeS) capRing(0, false);
    if (closeE) capRing(rings.length - 1, true);
  }

  /**
   * Revolve a profile around the local X axis — the wheel axle. `profile` is
   * flat triplets of (x, radius, v) so each ring can address its own row of
   * the wheel atlas: sidewall rows walk into the lettering band and back out.
   * `modR` perturbs the radius per ring/angle, which is how the tread blocks
   * nibble the silhouette without costing a single extra triangle.
   */
  addRevolve(
    profile: number[], radial: number, role: number, m?: THREE.Matrix4,
    uSpan = 1, uOff = 0, modR?: (i: number, a: number) => number,
  ) {
    const rings = profile.length / 3;
    const base = this.vcount();
    const cols = radial + 1; // duplicate the seam column so U does not mirror
    for (let i = 0; i < rings; i++) {
      const x = profile[i * 3];
      const r0 = profile[i * 3 + 1];
      const v = profile[i * 3 + 2];
      for (let j = 0; j < cols; j++) {
        const a = (j / radial) * Math.PI * 2;
        const r = r0 + (modR ? modR(i, a) : 0);
        this.push(x, Math.cos(a) * r, Math.sin(a) * r, uOff + (j / radial) * uSpan, v, role, m);
      }
    }
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = base + i * cols + j;
        const b = a + 1;
        const c = base + (i + 1) * cols + j + 1;
        const d = base + (i + 1) * cols + j;
        this.idx.push(a, b, c, a, c, d);
      }
    }
  }

  /**
   * Append any BufferGeometry (three primitives), transformed.
   *
   * The source index is CARRIED OVER rather than expanded away. Round 1 called
   * `toNonIndexed()` here, which gave every triangle its own three vertices —
   * and `finish()` runs `computeVertexNormals()`, so every sphere and torus on
   * the kart and the driver came out FLAT SHADED. That is most of why the
   * helmet read as a faceted low-poly ball, and it cost 3x the vertices to do
   * it. Welding the index back costs nothing and smooths the lot.
   */
  addGeometry(geo: THREE.BufferGeometry, role: number, m?: THREE.Matrix4, uvScale = 1) {
    const p = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const base = this.vcount();
    for (let i = 0; i < p.count; i++) {
      this.push(
        p.getX(i), p.getY(i), p.getZ(i),
        uv ? uv.getX(i) * uvScale : 0, uv ? uv.getY(i) * uvScale : 0,
        role, m,
      );
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  /**
   * Swept tube through a polyline with parallel-transport frames — roll bar,
   * exhaust pipes, nerf bars. Ends are domed so no pipe shows a raw ring.
   */
  addTube(path: THREE.Vector3[], radius: number | ((t: number) => number), radial: number, role: number, m?: THREE.Matrix4) {
    const R = typeof radius === 'function' ? radius : () => radius as number;
    const n = path.length;
    const base = this.vcount();
    // seed an arbitrary normal perpendicular to the first tangent
    const tan = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const bin = new THREE.Vector3();
    tan.copy(path[1]).sub(path[0]).normalize();
    nrm.set(0, 1, 0);
    if (Math.abs(nrm.dot(tan)) > 0.9) nrm.set(1, 0, 0);
    nrm.crossVectors(tan, nrm).normalize();
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const prev = tan.clone();
        if (i < n - 1) tan.copy(path[i + 1]).sub(path[i - 1]).normalize();
        else tan.copy(path[i]).sub(path[i - 1]).normalize();
        // rotate the frame by the same rotation that took prev -> tan
        const q = new THREE.Quaternion().setFromUnitVectors(prev, tan);
        nrm.applyQuaternion(q).normalize();
        len += path[i].distanceTo(path[i - 1]);
      }
      bin.crossVectors(tan, nrm).normalize();
      const r = R(i / (n - 1));
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        _n.copy(nrm).multiplyScalar(c * r).addScaledVector(bin, s * r).add(path[i]);
        this.push(_n.x, _n.y, _n.z, (a / (Math.PI * 2)) * r * 6.28, len, role, m);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const j2 = (j + 1) % radial;
        const a = base + i * radial + j;
        const b = base + i * radial + j2;
        const c = base + (i + 1) * radial + j2;
        const d = base + (i + 1) * radial + j;
        this.idx.push(a, b, c, a, c, d);
      }
    }
    // dome the two ends
    for (const end of [0, 1]) {
      const ri = end ? n - 1 : 0;
      tan.copy(path[ri]).sub(path[ri + (end ? -1 : 1)]).normalize();
      const c0 = this.vcount();
      _n.copy(path[ri]).addScaledVector(tan, R(end) * 0.85);
      this.push(_n.x, _n.y, _n.z, 0.5, len, role, m);
      for (let j = 0; j < radial; j++) {
        const j2 = (j + 1) % radial;
        const a = base + ri * radial + j;
        const b = base + ri * radial + j2;
        if (end) this.idx.push(c0, a, b);
        else this.idx.push(c0, b, a);
      }
    }
  }

  /**
   * Slightly domed painted panel whose border sinks back to zero — it lies on
   * the bodywork like a decal without a hard lip or any z-fighting, and its
   * UVs address one rect of the livery atlas.
   */
  addPanel(w: number, h: number, bulge: number, uvRect: readonly [number, number, number, number], m: THREE.Matrix4, role = Role.Base, seg = 8) {
    const base = this.vcount();
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const u = i / seg;
        const v = j / seg;
        // falloff = 1 in the middle, 0 at the border
        const fx = Math.sin(Math.PI * u);
        const fy = Math.sin(Math.PI * v);
        const z = bulge * Math.pow(fx * fy, 0.45);
        this.push((u - 0.5) * w, (v - 0.5) * h, z, uvRect[0] + u * uvRect[2], uvRect[1] + v * uvRect[3], role, m);
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 2;
        const d = a + seg + 1;
        this.idx.push(a, b, c, a, c, d);
      }
    }
  }

  /** Vertex index to hand to `remapUV` after adding a part. */
  mark() { return this.vcount(); }

  /**
   * Squeeze the UVs of everything added since `from` into one rect of the
   * atlas. Parts built from metre-space lofts have no idea which zone of a
   * packed texture they belong in; this puts them there without a second
   * material.
   */
  remapUV(from: number, rect: readonly [number, number, number, number]) {
    const n = this.vcount();
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = from; i < n; i++) {
      const u = this.uv[i * 2];
      const v = this.uv[i * 2 + 1];
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const du = u1 - u0 || 1;
    const dv = v1 - v0 || 1;
    for (let i = from; i < n; i++) {
      this.uv[i * 2] = rect[0] + ((this.uv[i * 2] - u0) / du) * rect[2];
      this.uv[i * 2 + 1] = rect[1] + ((this.uv[i * 2 + 1] - v0) / dv) * rect[3];
    }
  }

  get triangles() { return this.idx.length / 3; }

  finish(): Built {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return { geo, roles: Uint8Array.from(this.role), triangles: this.idx.length / 3 };
  }
}

/** Convenience: a matrix from position / euler / uniform-or-vector scale. */
export function mat(
  px = 0, py = 0, pz = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

// ---------------------------------------------------------------------------
// 3. Liveries
// ---------------------------------------------------------------------------

export interface Livery {
  index: number;
  name: string;
  number: number;
  sponsor: string;
  base: THREE.Color;
  trim: THREE.Color;
  accent: THREE.Color;
  suit: THREE.Color;
  skin: THREE.Color;
  shadowed: THREE.Color;
  rim: THREE.Color;
  /** the only per-racer texture in the whole kart */
  decal: THREE.Texture;
  decalMat: THREE.MeshPhysicalMaterial;
}

const NUMBERS = [5, 11, 27, 3, 44, 8, 17, 62];
const SPONSORS = ['蔚蓝', '科摩托', '日光', '海港九号', '飞驰', '派罗', '三角翼', '轨道'];
const SKINS = [0xf0c39a, 0x8d5a3b, 0xe7b183, 0xc98b5e, 0xf3d0b0, 0x6f4429, 0xd79c72, 0xa86f47];

const _hsl = { h: 0, s: 0, l: 0 };

function derive(index: number, base: THREE.Color) {
  base.getHSL(_hsl);
  // Trim rotates the hue by a scheme-specific amount and lands lighter or
  // darker than the coat so the two never merge at distance.
  const rot = [0.5, 0.08, -0.1, 0.5, 0.13, -0.45, 0.28, 0.55][index % 8];
  const trim = new THREE.Color().setHSL(
    (_hsl.h + rot + 1) % 1,
    THREE.MathUtils.clamp(_hsl.s * 0.85 + 0.1, 0.25, 0.95),
    THREE.MathUtils.clamp(index % 2 ? _hsl.l * 0.55 + 0.06 : _hsl.l * 0.5 + 0.42, 0.1, 0.86),
  );
  const accent = new THREE.Color().setHSL(
    (_hsl.h + 0.5 + rot * 0.25 + 1) % 1,
    0.12,
    _hsl.l > 0.55 ? 0.16 : 0.9,
  );
  const suit = new THREE.Color().setHSL(_hsl.h, _hsl.s * 0.65, THREE.MathUtils.clamp(_hsl.l * 0.42, 0.08, 0.34));
  const shadowed = new THREE.Color().setHSL(_hsl.h, _hsl.s * 0.9, _hsl.l * 0.45);
  // Rim: the trim HUE, but pulled down to a metal VALUE. This is the note about
  // "flat pastel teal with literally zero specular event" and it is only half a
  // material problem. The rim zone of the wheel atlas is metalness 1, so albedo
  // is not a diffuse colour at all — it is the reflection tint, and a pastel
  // trim at L 0.70 over a #c2c9d2 plate tints toward white, which reflects a
  // bright golden sky as a flat bright nothing. A metal reads as metal because
  // of the DARK part of its range; drop the value to ~0.4 and the same env now
  // has somewhere to go, so the anodised barrel gets a gradient and the hub nut
  // reads as a glint against it. Hue is preserved so the eight karts still have
  // eight distinguishable wheels.
  //
  // Value is set by LUMINANCE, not by HSL lightness. These are linear HSL
  // (getHSL/setHSL both default to the working colour space, which is what the
  // rest of this function already assumes) and at a fixed HSL L a saturated
  // cyan carries three times the luminance of a saturated blue — so clamping L
  // would have left the teal kart with a near-white rim and the violet one with
  // a near-black one. Normalising to a target reflectance instead makes every
  // livery's wheel the same *metal*, anodised eight different colours, and
  // lands the final albedo (x the atlas's #c2c9d2 plate, linear luminance 0.58)
  // at ~0.20 linear — a believable alloy with room above it for the reflection
  // to read as a highlight. The second term of the min() is what stops a very
  // saturated hue from clipping a channel on the way to the target.
  const rimHsl = { h: 0, s: 0, l: 0 };
  trim.getHSL(rimHsl);
  const rim = new THREE.Color().setHSL(
    rimHsl.h, rimHsl.s * 0.62, THREE.MathUtils.clamp(rimHsl.l, 0.12, 0.62),
  );
  const rimLum = 0.2126 * rim.r + 0.7152 * rim.g + 0.0722 * rim.b;
  rim.multiplyScalar(Math.min(
    0.345 / Math.max(1e-3, rimLum),
    1 / Math.max(1e-3, rim.r, rim.g, rim.b),
  ));
  return { trim, accent, suit, shadowed, rim };
}

/**
 * Panel atlas dimensions.
 *
 * This was a 1024² square and 44% of it was blank base colour — the four
 * panels occupied two horizontal bands with dead rows above, below and between
 * them. Eight racers each carry their own copy, so that dead space was 2.05 MB
 * per livery and 16.4 MB of the scene's 364 MB of texture, measured with
 * tools/tex-probe.mjs. The canvas is now only as tall as the bands need.
 *
 * The panels themselves are NOT smaller: every rect below keeps the exact pixel
 * dimensions it had on the square atlas (pods 512x205, nose 512x370, tail
 * 512x284), so texel density per metre of bodywork is unchanged and no camera
 * in the game sees a softer decal. This is a packing change, not a resolution
 * change — which is the whole reason to prefer it to simply halving the atlas.
 *
 * 600 rather than the 575 the bands strictly need, because of the eight-pixel
 * GUTTERS. The panel quads are UV'd flush to the edge of their rect, so a
 * linear tap at a panel's border samples half a texel outside it. On the square
 * atlas that neighbour was always the base paint colour, i.e. exactly what
 * surrounds the panel on the real bodywork, and the bleed was invisible by
 * accident. Packed tight, the pod's top edge would instead bleed the nose
 * plate's chevrons. The gutters put the base colour back.
 */
const PANEL_W = 1024;
const PANEL_H = 600;

/**
 * Panel atlas layout. Each rect is a *sub*-rect of the PANEL_W x PANEL_H canvas
 * chosen so that its pixel aspect matches the physical panel it is painted on —
 * draw a circle in the band and you get a circle on the kart, not an ellipse.
 * KartModel imports these and sizes its panels from PANEL_SIZE, so the two can
 * never drift apart. Check both when touching either: pod 512x205 px against
 * 0.60x0.24 m is 2.498 vs 2.500, nose 512x370 against 0.36x0.26 is 1.384 vs
 * 1.385, tail 512x284 against 0.36x0.20 is 1.803 vs 1.800.
 */
export const PANEL_UV = {
  podL: [0.0, 8 / 600, 0.5, 205 / 600] as const,
  podR: [0.5, 8 / 600, 0.5, 205 / 600] as const,
  nose: [0.0, 221 / 600, 0.5, 370 / 600] as const,
  tail: [0.5, 221 / 600, 0.5, 284 / 600] as const,
};
/** Physical size of each panel in metres, matched to the rects above. */
export const PANEL_SIZE = {
  pod: [0.60, 0.24] as const,
  nose: [0.36, 0.26] as const,
  tail: [0.36, 0.20] as const,
};

/**
 * Draw the four decal panels for one racer: coat, stripes, number, sponsor and
 * a baked speckle, so a panel needs no second texture set of its own.
 */
function decalCanvas(l: Omit<Livery, 'decal' | 'decalMat'>): HTMLCanvasElement {
  const W = PANEL_W;
  const H = PANEL_H;
  const c = canvas(W, H);
  const base = `#${l.base.getHexString()}`;
  const trim = `#${l.trim.getHexString()}`;
  const accent = `#${l.accent.getHexString()}`;
  const dark = `#${l.shadowed.getHexString()}`;

  c.fillStyle = base;
  c.fillRect(0, 0, W, H);

  /** UV rect -> canvas pixel band (canvas y grows downward, v grows upward). */
  const band = (r: readonly [number, number, number, number]) => ({
    x: r[0] * W, y: (1 - r[1] - r[3]) * H, w: r[2] * W, h: r[3] * H,
  });

  /** Run `draw` in a clipped, origin-shifted context for one band. */
  const inBand = (r: readonly [number, number, number, number], draw: (w: number, h: number) => void) => {
    const b = band(r);
    c.save();
    c.beginPath(); c.rect(b.x, b.y, b.w, b.h); c.clip();
    c.translate(b.x, b.y);
    draw(b.w, b.h);
    c.restore();
  };

  const text = (cx: number, cy: number, size: number, str: string, col: string) => {
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `900 ${Math.round(size)}px "Arial Black", Impact, system-ui, sans-serif`;
    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.fillText(str, cx + size * 0.05, cy + size * 0.06);
    c.fillStyle = col;
    c.fillText(str, cx, cy);
  };

  const roundel = (cx: number, cy: number, r: number) => {
    c.fillStyle = accent;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = trim;
    c.lineWidth = r * 0.14;
    c.beginPath(); c.arc(cx, cy, r * 0.9, 0, Math.PI * 2); c.stroke();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `900 ${Math.round(r * 1.2)}px "Arial Black", Impact, system-ui, sans-serif`;
    c.fillStyle = base;
    c.fillText(String(l.number), cx, cy + r * 0.06);
  };

  /**
   * Eight schemes. Each is drawn into the band's own space (w x h), so they
   * read the same whatever aspect the panel happens to be.
   */
  const scheme = (kind: number, w: number, h: number) => {
    switch (kind) {
      case 0: // twin longitudinal stripes
        c.fillStyle = trim; c.fillRect(0, h * 0.30, w, h * 0.30);
        c.fillStyle = accent; c.fillRect(0, h * 0.64, w, h * 0.09);
        break;
      case 1: // forward chevrons
        c.fillStyle = trim;
        for (let i = -1; i < 7; i++) {
          const s = w * 0.145;
          c.beginPath();
          c.moveTo(i * s, h); c.lineTo(i * s + h * 0.55, 0);
          c.lineTo(i * s + h * 0.55 + s * 0.42, 0); c.lineTo(i * s + s * 0.42, h);
          c.closePath(); c.fill();
        }
        break;
      case 2: // diagonal split with a hairline
        c.fillStyle = trim;
        c.beginPath(); c.moveTo(0, h); c.lineTo(w, h * 0.18); c.lineTo(w, h); c.closePath(); c.fill();
        c.fillStyle = accent;
        c.beginPath(); c.moveTo(0, h); c.lineTo(w, h * 0.18); c.lineTo(w, h * 0.08); c.lineTo(0, h * 0.88); c.closePath(); c.fill();
        break;
      case 3: { // chequer band
        c.fillStyle = trim; c.fillRect(0, h * 0.32, w, h * 0.36);
        c.fillStyle = accent;
        const n = 10;
        for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++)
          if ((i + j) % 2) c.fillRect((i * w) / n, h * 0.32 + j * h * 0.18, w / n, h * 0.18);
        break;
      }
      case 4: // rally arrow flash
        c.fillStyle = trim;
        c.beginPath();
        c.moveTo(0, h * 0.56); c.lineTo(w * 0.55, h * 0.56); c.lineTo(w * 0.78, h * 0.30);
        c.lineTo(w, h * 0.30); c.lineTo(w, h * 0.76); c.lineTo(0, h * 0.76);
        c.closePath(); c.fill();
        c.fillStyle = accent; c.fillRect(0, h * 0.79, w, h * 0.05);
        break;
      case 5: // low block under a triple pinstripe
        c.fillStyle = trim; c.fillRect(0, h * 0.58, w, h * 0.42);
        c.fillStyle = accent;
        for (let i = 0; i < 3; i++) c.fillRect(0, h * (0.46 + i * 0.045), w, h * 0.022);
        break;
      case 6: // quarter wedge off the trailing edge
        c.fillStyle = trim;
        c.beginPath(); c.moveTo(w, 0); c.lineTo(w, h); c.lineTo(w * 0.35, h); c.closePath(); c.fill();
        c.fillStyle = accent;
        c.beginPath(); c.moveTo(w, 0); c.lineTo(w * 0.35, h); c.lineTo(w * 0.23, h); c.lineTo(w * 0.9, 0); c.closePath(); c.fill();
        break;
      default: { // speed fade with a comb
        const g = c.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, trim); g.addColorStop(0.5, trim); g.addColorStop(1, base);
        c.fillStyle = g; c.fillRect(0, h * 0.48, w, h * 0.52);
        c.fillStyle = accent;
        for (let i = 0; i < 6; i++) c.fillRect(w * (0.55 + i * 0.068), h * 0.38, w * 0.026, h * 0.62);
        break;
      }
    }
  };

  const kind = l.index % 8;

  // --- pod flanks ---------------------------------------------------------
  // Both flanks are drawn identically: on either side of the kart the viewer's
  // right is the direction the panel's own U axis grows, so no mirroring.
  for (const r of [PANEL_UV.podL, PANEL_UV.podR]) {
    inBand(r, (w, h) => {
      scheme(kind, w, h);
      roundel(w * 0.135, h * 0.5, h * 0.34);
      text(w * 0.52, h * 0.42, h * 0.26, l.sponsor, accent);
      text(w * 0.52, h * 0.70, h * 0.12, `${l.name}车队`, trim);
    });
  }

  // --- nose plate ---------------------------------------------------------
  inBand(PANEL_UV.nose, (w, h) => {
    c.fillStyle = base; c.fillRect(0, 0, w, h);
    c.fillStyle = trim;
    c.beginPath();
    c.moveTo(w * 0.27, 0); c.lineTo(w * 0.73, 0); c.lineTo(w * 0.64, h); c.lineTo(w * 0.36, h);
    c.closePath(); c.fill();
    c.fillStyle = accent; c.fillRect(w * 0.485, 0, w * 0.03, h);
    roundel(w * 0.5, h * 0.56, h * 0.30);
    text(w * 0.5, h * 0.14, h * 0.11, l.sponsor, accent);
  });

  // --- tail plate: the panel the player stares at all race -----------------
  inBand(PANEL_UV.tail, (w, h) => {
    c.fillStyle = dark; c.fillRect(0, 0, w, h);
    c.fillStyle = trim; c.fillRect(0, h * 0.06, w, h * 0.60);
    c.fillStyle = accent;
    for (let i = 0; i < 9; i++) c.fillRect(w * (0.02 + i * 0.11), h * 0.72, w * 0.07, h * 0.22);
    text(w * 0.30, h * 0.36, h * 0.52, String(l.number), base);
    text(w * 0.70, h * 0.30, h * 0.18, l.sponsor, base);
    text(w * 0.70, h * 0.52, h * 0.10, l.name.toUpperCase(), accent);
  });

  // --- baked speckle + panel AO so the flat fills are never truly flat -----
  // generated small and upscaled: it is a soft metallic shimmer, and eight of
  // these at full res would dominate the boot cost
  c.globalAlpha = 0.09;
  fbmFillInto(c, 0, 0, W, H, 0.02, 3, 100 + l.index, (n) => {
    const v = Math.round(60 + n * 190);
    return [v, v, v];
  }, 224);
  c.globalAlpha = 1;
  // vignette each panel band slightly — reads as the panel curving away
  for (const r of [PANEL_UV.podL, PANEL_UV.podR, PANEL_UV.nose, PANEL_UV.tail]) {
    const b = band(r);
    const g = c.createRadialGradient(
      b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.25,
      b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) * 0.62,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.24)');
    c.fillStyle = g;
    c.fillRect(b.x, b.y, b.w, b.h);
  }
  return c.canvas;
}

const _liveries = new Map<string, Livery>();
let _nextIndex = 0;

/** Stable per-racer livery. Index is assigned in construction order. */
export function getLivery(stats: KartStats): Livery {
  const key = stats.name || `#${stats.color.getHexString()}`;
  const hit = _liveries.get(key);
  if (hit) return hit;

  const index = _nextIndex++ % 8;
  const base = stats.color.clone();
  const d = derive(index, base);
  const partial = {
    index,
    name: stats.name || '车手',
    number: NUMBERS[index],
    sponsor: SPONSORS[index],
    base,
    trim: d.trim,
    accent: d.accent,
    suit: d.suit,
    skin: new THREE.Color(SKINS[index]),
    shadowed: d.shadowed,
    rim: d.rim,
  };
  const sd = surfaceDetail();
  const t = new THREE.CanvasTexture(decalCanvas(partial));
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;

  const l: Livery = {
    ...partial,
    decal: t,
    // Same lacquer stack as the bodywork it lies on, or the decal panel reads
    // as a sticker with a different finish to the paint around it.
    decalMat: new THREE.MeshPhysicalMaterial({
      map: t,
      roughness: 1,
      roughnessMap: sd.paintRough,
      normalMap: sd.paintNormal,
      normalScale: new THREE.Vector2(PAINT_NORMAL_SCALE, PAINT_NORMAL_SCALE),
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 1,
      clearcoatRoughnessMap: sd.coatRough,
      clearcoatNormalMap: sd.coatNormal,
      clearcoatNormalScale: new THREE.Vector2(COAT_NORMAL_SCALE, COAT_NORMAL_SCALE),
      envMapIntensity: envFor('paint'),
    }),
  };
  // The decal panel lies flush against the bodywork, so it has to answer the
  // environment identically or the number roundel sits in a patch of differently
  // tinted lacquer — a sticker, which is the exact note this material exists to
  // avoid.
  injectEnvResponse(l.decalMat, PAINT_ENV_RESPONSE);
  _liveries.set(key, l);
  return l;
}

// ---------------------------------------------------------------------------
// 4. Materials — one instance each, shared by all eight karts
// ---------------------------------------------------------------------------

let _mats: {
  paint: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  wheel: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  character: THREE.MeshStandardMaterial;
} | null = null;

export function kartMaterials() {
  if (_mats) return _mats;
  const d = surfaceDetail();
  const w = wheelMaps();
  _mats = {
    // LACQUER. Two lobes that disagree: a fine ~2 deg orange peel on the base
    // coat at a 167 mm tile, and a coarse long-wave flow on the clearcoat at a
    // 588 mm tile. The base carries the broad diffuse red, the coat carries
    // the tight reflected sun on top of it, and because the coat has its own
    // normal the two highlights never sit exactly on each other. That
    // separation is the whole trick; a single soft blob is what read as clay.
    paint: new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 1, // the map IS the value (0.22..0.34, Toksvig-lifted)
      roughnessMap: d.paintRough,
      normalMap: d.paintNormal,
      normalScale: new THREE.Vector2(PAINT_NORMAL_SCALE, PAINT_NORMAL_SCALE),
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 1, // likewise: 0.035..0.11 from the map
      clearcoatRoughnessMap: d.coatRough,
      clearcoatNormalMap: d.coatNormal,
      clearcoatNormalScale: new THREE.Vector2(COAT_NORMAL_SCALE, COAT_NORMAL_SCALE),
      envMapIntensity: envFor('paint'),
    }),
    chrome: new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0xffffff,
      metalness: 1,
      roughness: 1,
      roughnessMap: d.chromeRough, // 0.10..0.23 around the bible's 0.15
      normalMap: d.coatNormal,     // the same polish haze as the lacquer
      normalScale: new THREE.Vector2(0.045, 0.045),
      envMapIntensity: envFor('chrome'),
    }),
    // Structural trim, floor pan, splitter. Roughness floor 0.48: this is the
    // family that was strobing, and a dark surface at 0.14 roughness under a
    // 0.6-scale normal map is a specular aliaser however you filter it.
    plastic: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      roughnessMap: d.plasticRough,
      normalMap: d.plasticNormal,
      normalScale: new THREE.Vector2(PLASTIC_NORMAL_SCALE, PLASTIC_NORMAL_SCALE),
      metalness: 0.02,
      envMapIntensity: envFor('plastic'),
    }),
    wheel: new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: w.map,
      normalMap: w.normal,
      normalScale: new THREE.Vector2(0.7, -0.7), // green flipped: the atlas is flipY off
      roughnessMap: w.orm, // G
      metalnessMap: w.orm, // B
      roughness: 1,
      metalness: 1,
      envMapIntensity: envFor('wheel'),
    }),
    // VISOR. Round 2 note: "a flat dark quad". It was `metalness: 1`, and a
    // metal has no diffuse term at all — every photon it shows comes from the
    // environment. The visor faces forward and slightly DOWN, so at golden hour
    // it was sampling tarmac and the underside of the sky, and it rendered as a
    // hole cut in the helmet.
    //
    // A visor is a dielectric. As one it keeps a dark tinted body (which is the
    // point of a tinted shield) but gains three things a metal cannot have: a
    // Fresnel edge that goes bright silver against the sky wherever the surface
    // turns away, a real specular glint off the SUN rather than off the env map
    // alone, and a clearcoat lobe on top of the tint. `reflectivity` is pushed
    // to glass's F0 (~0.078) rather than the 0.5 default's 0.04.
    //
    // What it does NOT get is `iridescence`. A thin-film term at 0.4 / IOR 1.5
    // over a near-black body is a hue that walks the spectrum with view angle,
    // and it sat 30 cm from bodywork the r7 review had already called
    // iridescent — two rainbow surfaces on one kart is how a note about the
    // paint becomes a note about the whole model. The three effects listed
    // above are what the visor was rebuilt for; the film was never one of them.
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x141d2e,
      metalness: 0.0,
      roughness: 0.075,
      reflectivity: 0.62,
      specularIntensity: 1,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: envFor('glass'),
    }),
    // RACE SUIT. Its own cloth family, not the moulded-plastic one it borrowed
    // in round 1: roughness 0.80-0.94 against the lacquer's 0.22 and the
    // plastic's 0.52, over a 2.5 mm twill weave. Three visibly different
    // surface responses on the driver alone (lacquered helmet, glass visor,
    // matte cloth) is most of what stops the figure reading as one moulding.
    character: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      roughnessMap: d.clothRough,
      normalMap: d.clothNormal,
      normalScale: new THREE.Vector2(CLOTH_NORMAL_SCALE, CLOTH_NORMAL_SCALE),
      metalness: 0,
      envMapIntensity: envFor('character'),
    }),
  };
  // Order matters: `addSunRim` REPLACES `onBeforeCompile` rather than chaining
  // it, so anything that chains has to be installed after it.
  addSunRim(_mats.paint, 0.30);
  injectEnvResponse(_mats.paint, PAINT_ENV_RESPONSE);
  // The two surfaces on the kart whose highlights the review found aliased.
  addSpecularAA(_mats.wheel, 0.85);
  addSpecularAA(_mats.chrome, 0.60);
  return _mats;
}

// --- specular antialiasing ---------------------------------------------------
//
// "Those rim lines are aliased." They are, and the tyre is the worst case on
// the kart for it: a normal map with a rolled shoulder every few texels, on a
// surface that is spinning, under a 14 degree key and a bipolar golden-hour
// environment (warm sun one side, blue zenith the other). Every shoulder is a
// small mirror pointed somewhere slightly different, and once the wheel is more
// than a few metres away those mirrors land under a pixel each — so which one a
// pixel happens to catch changes every frame. That is the crawl.
//
// The offline Toksvig bake already handles the part of this that MIPPING
// causes. It cannot handle the part that CURVATURE causes: a tyre's own
// silhouette turns through 90 degrees over a handful of pixels, and no amount
// of texture filtering knows that. This is the runtime half — Kaplanyan's
// normal-variance-to-roughness, measured from the screen-space derivative of
// the shaded normal, which is the same idea the road material's `specAA` uses.
//
// Injected after `<normal_fragment_maps>`: `roughnessFactor` is assigned four
// chunks earlier and not consumed until `<lights_physical_fragment>` several
// chunks later, so the mapped normal and the roughness are both live here and
// it costs no extra texture fetch.
//
// Cost: two derivatives and about eight ALU, on the wheel and chrome materials
// only. Two draw calls per kart.
function addSpecularAA(m: THREE.MeshStandardMaterial, strength: number) {
  const uSpecAA = { value: strength };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    shader.uniforms.uSpecAA = uSpecAA;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uSpecAA;\nvoid main() {')
      .replace(
        '#include <normal_fragment_maps>',
        [
          '#include <normal_fragment_maps>',
          '{',
          '  vec3 dnx = dFdx( normal );',
          '  vec3 dny = dFdy( normal );',
          '  float variance = uSpecAA * ( dot( dnx, dnx ) + dot( dny, dny ) );',
          // GGX alpha = roughness^2; alpha'^2 = alpha^2 + 2 * variance
          '  float alpha = roughnessFactor * roughnessFactor;',
          '  float aP = sqrt( alpha * alpha + min( 2.0 * variance, 0.5 ) );',
          '  roughnessFactor = clamp( sqrt( aP ), roughnessFactor, 1.0 );',
          '}',
        ].join('\n'),
      );
  };
  m.customProgramCacheKey = () => `specaa${strength.toFixed(3)}`;
  m.needsUpdate = true;
}

// --- hero rim light ----------------------------------------------------------
//
// Note 4: "the player kart has no rim separation from the tarmac ... at
// thumbnail size you lose the subject". A mid-value red object on a mid-value
// grey plane has no edge, and the fix is the one a lighting cameraman would
// reach for: a warm kicker on the sun side that traces the silhouette.
//
// Doing that properly needs the sun's direction in view space, which would mean
// a per-frame uniform push from a system that owns the scene. It does not need
// to: `outgoingLight` is already the surface's answer to the key light, so
// gating a Fresnel term on its own luminance puts the rim exactly where the sun
// is and NOWHERE in shadow — self-contained, and it can never light the dark
// side of the kart, which is the failure mode of a naive fresnel emissive.
//
// Cost: ~8 ALU in the fragment shader of two meshes per kart. No extra pass, no
// extra draw call, no uniform traffic.
const RIM_TINT = new THREE.Color(0xffd9a8);

function addSunRim(m: THREE.MeshPhysicalMaterial, strength: number) {
  const uRimStrength = { value: strength };
  const uRimColor = { value: RIM_TINT };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimStrength = uRimStrength;
    shader.uniforms.uRimColor = uRimColor;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uRimStrength;\nuniform vec3 uRimColor;\nvoid main() {',
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '{',
          // vViewPosition points fragment -> eye, so this is N.V
          '  float ndv = abs(dot(normalize(vViewPosition), normal));',
          '  float fres = pow(1.0 - clamp(ndv, 0.0, 1.0), 4.0);',
          // gate on what the surface is ALREADY returning: bright = sun side
          '  float lit = clamp(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)) * 2.4, 0.0, 1.0);',
          '  outgoingLight += uRimColor * (fres * lit * lit * uRimStrength);',
          '}',
          '#include <opaque_fragment>',
        ].join('\n'),
      );
  };
  // two rim strengths share one shader source, so they must not share a program
  m.customProgramCacheKey = () => `sunrim${strength.toFixed(3)}`;
  m.needsUpdate = true;
}

let _impostor: THREE.MeshStandardMaterial | null = null;
let _shadowOnly: THREE.MeshBasicMaterial | null = null;

/**
 * The distant kart's single surface.
 *
 * A kart is fifteen meshes because it is six materials plus four wheels plus a
 * driver who moves independently of all of them, and every one of those is a
 * draw call in the colour pass and another one-and-a-third in the cascades.
 * Eight of them is 220 draw calls against a 250 budget for the entire frame,
 * which is the whole reason this file gained a second material.
 *
 * Past ~26 m a kart is under a hundred pixels tall and the thing that reads is
 * its silhouette and its livery, not the disagreement between a lacquer's two
 * specular lobes. So the far LOD is the same geometry, merged, wearing one
 * vertex-coloured surface: the livery survives verbatim (it lives in the colour
 * attribute), the shape survives verbatim, and what is lost is the clearcoat,
 * the chrome's mirror and the visor's Fresnel — none of which resolve at that
 * size. No maps at all: a 167 mm orange-peel tile at 26 m is sub-texel noise,
 * and sampling it is how a distant kart starts to sparkle.
 */
export function impostorMaterial(): THREE.MeshStandardMaterial {
  if (_impostor) return _impostor;
  _impostor = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Between the lacquer's 0.28 and the tyre's 0.85, biased toward the
    // bodywork because that is most of the silhouette.
    roughness: 0.42,
    metalness: 0.04,
    envMapIntensity: envFor('impostor'),
  });
  // The same chroma limit as the near paint. One material, one program, no draw
  // call — and without it the LOD swap at 26 m is a visible hue pop, because the
  // near kart would be answering the sunset in its roster colour and the far one
  // in the sunset's.
  injectEnvResponse(_impostor, PAINT_ENV_RESPONSE);
  return _impostor;
}

/**
 * The same merged mesh, wearing nothing.
 *
 * three decides what goes in a shadow map from `castShadow` on the object and
 * `visible` on the object and its material — there is no "cast but do not
 * draw" flag, and both the colour pass and the shadow pass read the same two
 * booleans. So a near kart, which must keep all fifteen detail meshes in the
 * colour pass, gets its shadow from this: the merged mesh stays in the scene
 * with `castShadow` on and a material that writes no colour and no depth. It
 * costs one rasterised-but-discarded draw and saves nineteen shadow draws.
 *
 * `renderOrder` puts it after the opaque queue so the depth buffer it is tested
 * against is already full and almost every fragment dies at early-Z.
 */
export function shadowOnlyMaterial(): THREE.MeshBasicMaterial {
  if (_shadowOnly) return _shadowOnly;
  _shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  return _shadowOnly;
}

let _heroPaint: THREE.MeshPhysicalMaterial | null = null;

/**
 * The player's bodywork. Identical lacquer to the roster's, with the sun-side
 * rim run 2.4x hotter so the hero kart holds its silhouette against the tarmac
 * at the 6%-of-frame size the chase camera gives it. Cached, so a second player
 * kart (split screen, replays) costs nothing.
 */
export function heroPaint(): THREE.MeshPhysicalMaterial {
  if (_heroPaint) return _heroPaint;
  const src = kartMaterials().paint;
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 1,
    roughnessMap: src.roughnessMap,
    normalMap: src.normalMap,
    normalScale: src.normalScale.clone(),
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 1,
    clearcoatRoughnessMap: src.clearcoatRoughnessMap,
    clearcoatNormalMap: src.clearcoatNormalMap,
    clearcoatNormalScale: src.clearcoatNormalScale.clone(),
    envMapIntensity: src.envMapIntensity,
  });
  addSunRim(m, 0.72);
  injectEnvResponse(m, PAINT_ENV_RESPONSE);
  _heroPaint = m;
  return m;
}

// ---------------------------------------------------------------------------
// 5. Per-livery geometry (attribute sharing)
// ---------------------------------------------------------------------------

const _tmpColor = new THREE.Color();

function resolveRole(role: number, l: Livery | null, out: THREE.Color) {
  switch (role) {
    case Role.Base: return out.copy(l ? l.base : C_CREAM);
    case Role.Trim: return out.copy(l ? l.trim : C_STEEL);
    case Role.Accent: return out.copy(l ? l.accent : C_CREAM);
    case Role.Cream: return out.copy(C_CREAM);
    case Role.Plastic: return out.copy(C_PLASTIC);
    case Role.Steel: return out.copy(C_STEEL);
    case Role.Rubber: return out.copy(C_RUBBER);
    case Role.Skin: return out.copy(l ? l.skin : C_CREAM);
    case Role.Suit: return out.copy(l ? l.suit : C_PLASTIC);
    case Role.Glove: return out.copy(C_CREAM);
    case Role.Hub: return out.copy(C_HUB);
    case Role.Disc: return out.copy(C_DISC);
    case Role.Shadowed: return out.copy(l ? l.shadowed : C_PLASTIC);
    case Role.Rim: return out.copy(l ? l.rim : C_RIM);
    default: return out.setRGB(1, 1, 1);
  }
}

/**
 * A geometry for one livery that re-uses the source position/uv/index buffers
 * verbatim and only owns a fresh colour attribute. Eight karts therefore cost
 * one vertex buffer plus eight small colour buffers.
 */
export function liveryGeometry(built: Built, l: Livery | null): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', built.geo.getAttribute('position'));
  g.setAttribute('normal', built.geo.getAttribute('normal'));
  g.setAttribute('uv', built.geo.getAttribute('uv'));
  g.setIndex(built.geo.getIndex());
  const n = built.roles.length;
  const col = new Float32Array(n * 3);
  // resolve once per role, then scatter — 13 colour conversions, not 20 000
  const lut = new Float32Array(ROLE_COUNT * 3);
  for (let r = 0; r < ROLE_COUNT; r++) {
    // THREE.Color already holds linear working-space values (ColorManagement
    // converts on assignment) and vertex colours are consumed as-is, so a
    // second sRGB->linear pass here would darken every painted panel.
    resolveRole(r, l, _tmpColor);
    lut[r * 3] = _tmpColor.r;
    lut[r * 3 + 1] = _tmpColor.g;
    lut[r * 3 + 2] = _tmpColor.b;
  }
  for (let i = 0; i < n; i++) {
    const r = built.roles[i] * 3;
    col[i * 3] = lut[r];
    col[i * 3 + 1] = lut[r + 1];
    col[i * 3 + 2] = lut[r + 2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.boundingSphere = built.geo.boundingSphere;
  return g;
}

/** Half track / front axle Z / rear axle Z, so the lobes land on the tyres. */
export interface BlobLayout { trackX: number; frontZ: number; rearZ: number; }

/**
 * ---------------------------------------------------------------------------
 * Contact shadow — §9.4 "every object has contact shadow and AO. Nothing floats"
 * ---------------------------------------------------------------------------
 * Round 3 failed this outright: in the hero crop the tarmac under and behind
 * both karts is the same value as open road, and the tyres meet it at a hard
 * line. A patch WAS being built and it was authored dark enough to be obvious
 * (a 0.38 multiplier at the contact patches), so the interesting question is
 * why none of it reached a pixel. Three separate reasons, all fixed here:
 *
 * 1. IT WAS BURIED. The old quad was 2.8 x 2.6 m, dead flat, floating 12 mm
 *    above the kart's contact plane. The bible's course is "never flat for more
 *    than 120 m", with 20 deg of banking; a crest of only 60 m radius drops the
 *    far edge of a 2.8 m quad 16 mm below the road, and the wheel lobes — the
 *    part that matters — sit 0.72 m out where the sag is already at the 12 mm
 *    clearance. So on anything but a flat plane the strongest part of the patch
 *    was depth-rejected. The quad is now smaller (2.24 x 2.16 m, so the field
 *    reaches zero sooner) and rides 30 mm proud instead of 12. The kart's own
 *    quaternion already lays it on the local surface tangent, so it is only
 *    CURVATURE that has to be cleared, never slope: 30 mm covers a 20 m-radius
 *    crest out at the wheels and a 60 m one out to the rim, which is more than
 *    anything the course has. Against that, a soft blob sitting 30 mm proud is
 *    displaced 10 cm along the ground at the chase camera's angle, which on a
 *    shadow with no hard edge in it is not a thing you can see.
 *
 *    (A shallow SAUCER was tried here first — rim pulled below the centre so
 *    that the dead margin is what gets clipped on a crest. It is a worse idea
 *    than it sounds and the render proved it: the wheel lobes sit at 0.69 of
 *    the half-extent, most of the way to the rim, so any drop steep enough to
 *    be worth having buries the lobes on FLAT ground. Kart floated exactly as
 *    it does in the round-3 shots. Flat quad, shorter reach, more clearance.)
 * 2. IT WAS STATIC. The note asks for it to be driven from suspension
 *    compression per wheel, and it should be: a loaded tyre has a small hard
 *    contact patch and a drooping one has none. `setWheel` does that.
 * 3. IT WAS ONE FROZEN TEXTURE. A 128 px map of the whole footprint spends
 *    almost all of its texels on the dead margin and cannot move a lobe. This
 *    is now evaluated in the fragment shader — no texture, no upload, two
 *    triangles, one draw call per kart, unchanged.
 *
 * On the blend: the note asks for multiply. This alpha-blends toward a
 * near-black cool tint instead, which is the SAME operation — with a tint at
 * ~0.005 linear, `mix(dst, tint, occ)` and `dst * (1 - occ)` differ by half a
 * percent of a stop — but it reaches it through `NormalBlending`, which is
 * always wired. `MultiplyBlending` only gets a blend func out of three when
 * `premultipliedAlpha` is true; on the other path three logs an error and sets
 * no func at all, so the quad silently inherits whatever the previous draw
 * bound. This material has already shipped that exact bug once. The tint also
 * buys something multiply cannot: §2 asks for teal-leaning shadows, and a
 * multiply can only ever desaturate toward the surface's own hue.
 */
/**
 * Plane extent, metres. Sized off the FIELD, not off the kart: the outermost
 * thing drawn is a wheel lobe centred 0.74 m out with a radius that reaches
 * 0.73 m when that corner is fully drooped, so the field runs to ~1.47 m and
 * the half-extent has to be at least that or the guard band below eats the
 * lobes. (Round 4's first attempt shrank this to 2.24 x 2.16 to help with the
 * burial problem in note 1, which put the wheels at 0.64 of the half-extent —
 * inside a guard that starts at 0.56 — and quietly cut a third off the darkest
 * part of the patch. Rendered, measured, reverted.)
 */
const SHADOW_W = 3.00;
const SHADOW_D = 3.00;
/** Clearance above the kart's contact plane, metres. See note 1 above. */
const SHADOW_LIFT = 0.030;
/**
 * Contact lobe radius at rest, metres — 1.4x the old 0.40 m, so the falloff is
 * comfortably wider than the axle footprint and the four lobes read as one
 * connected shadow under the kart rather than four coins.
 */
const SHADOW_LOBE_R = 0.56;
/** Droop past which a corner has no contact patch left at all, metres. */
const SHADOW_DROOP = 0.10;
/** Compression past rest at which the patch is at its tightest, metres. */
const SHADOW_LOAD = 0.09;
/** Peak occlusion at a fully loaded contact patch. */
const SHADOW_LOBE_MAX = 0.66;
/** Occlusion under the chassis, away from any wheel. */
const SHADOW_BODY = 0.38;
/** Never pure black (§3), and cool, so the contact reads as sky occlusion. */
const SHADOW_TINT = new THREE.Color(0x0c161c);

export interface ContactShadow {
  mesh: THREE.Mesh;
  /**
   * @param i       wheel index, FL FR RL RR — the order `buildKart` returns
   * @param offset  visual offset of the wheel from its rest height, metres.
   *                Positive = compressed (chassis has dropped onto it).
   */
  setWheel(i: number, offset: number): void;
}

let _shadowGeo: THREE.BufferGeometry | null = null;

function shadowGeometry(): THREE.BufferGeometry {
  if (_shadowGeo) return _shadowGeo;
  const g = new THREE.PlaneGeometry(SHADOW_W, SHADOW_D);
  g.rotateX(-Math.PI / 2);
  g.translate(0, SHADOW_LIFT, 0);
  g.computeBoundingSphere();
  _shadowGeo = g;
  return g;
}

const SHADOW_VERT = /* glsl */`
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

function shadowFragment(layout: BlobLayout): string {
  const w = (x: number, z: number) => `vec2(${x.toFixed(4)}, ${z.toFixed(4)})`;
  return /* glsl */`
uniform vec4 uK;      // per-wheel strength, FL FR RL RR
uniform vec4 uR;      // per-wheel lobe radius, metres
uniform vec3 uTint;
uniform vec2 uHalf;
varying vec2 vP;

float lobe( vec2 c, float r, float k ) {
  float d = length( vP - c );
  float t = clamp( d / max( r, 1e-3 ), 0.0, 1.0 );
  float skirt = 1.0 - t * t * ( 3.0 - 2.0 * t );
  // Two radii, not one. The skirt is the ambient occlusion of a wheel-sized
  // object on the ground and it is what joins the four corners into one
  // shadow; the core is the contact patch itself, and it is the part the
  // review actually found missing — "the tyres meet the tarmac at a hard line
  // with zero darkening at the contact patch". A single falloff wide enough to
  // do the first job is far too soft to do the second.
  float u = clamp( d / max( r * 0.40, 1e-3 ), 0.0, 1.0 );
  float core = 1.0 - u * u * ( 3.0 - 2.0 * u );
  return k * clamp( 0.45 * skirt + 0.55 * core, 0.0, 1.0 );
}

void main() {
  // body: a soft ellipse over the chassis footprint
  float body = 1.0 - smoothstep( 0.0, 1.0, length( vP / vec2( 0.76, 0.96 ) ) );
  body *= ${SHADOW_BODY.toFixed(3)};

  float l = lobe( ${w(-layout.trackX, layout.frontZ)}, uR.x, uK.x );
  l = max( l, lobe( ${w(layout.trackX, layout.frontZ)}, uR.y, uK.y ) );
  l = max( l, lobe( ${w(-layout.trackX, layout.rearZ)}, uR.z, uK.z ) );
  l = max( l, lobe( ${w(layout.trackX, layout.rearZ)}, uR.w, uK.w ) );

  // screen combine, so the chassis AO and a contact lobe can overlap without
  // ever stacking into a black bar
  float occ = body + l - body * l;

  // Hard guarantee: zero within the outer margin, so the four straight edges of
  // the mesh sit in dead field and can never draw a line on the road.
  vec2 e = abs( vP ) / uHalf;
  occ *= ( 1.0 - smoothstep( 0.74, 0.98, e.x ) ) * ( 1.0 - smoothstep( 0.74, 0.98, e.y ) );

  // The one blended surface in the game that was missing the alpha cutoff every
  // other one has (Particles, Trails, Decals, Motes, Shimmer all carry it).
  // This quad is 3 x 3 m of ground per kart and the four lobes are circles of
  // radius ~0.73 m centred on the axle corners, so the corners of the square —
  // and the whole outer margin the smoothstep above has just zeroed — resolve
  // to alpha 0 and were still being read-modify-written into the framebuffer,
  // eight times a frame. Blending alpha 0 is arithmetically identical to not
  // blending at all, so this changes no pixel; it only stops paying for the
  // ones it cannot change. Costs nothing in early-Z, which this material has
  // already given up: it is transparent with depthWrite off.
  if ( occ < 0.004 ) discard;

  gl_FragColor = vec4( uTint, clamp( occ, 0.0, 1.0 ) );
}
`;
}

/**
 * One kart's contact shadow. The geometry and the shader source are shared; the
 * material is per kart because the four lobe uniforms are per kart. All eight
 * therefore compile one program between them.
 */
export function contactShadow(
  layout: BlobLayout = { trackX: 0.72, frontZ: 0.72, rearZ: -0.74 },
): ContactShadow {
  const uK = { value: new THREE.Vector4(1, 1, 1, 1) };
  const uR = { value: new THREE.Vector4(SHADOW_LOBE_R, SHADOW_LOBE_R, SHADOW_LOBE_R, SHADOW_LOBE_R) };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uK,
      uR,
      uTint: { value: SHADOW_TINT },
      uHalf: { value: new THREE.Vector2(SHADOW_W * 0.5, SHADOW_D * 0.5) },
    },
    vertexShader: SHADOW_VERT,
    fragmentShader: shadowFragment(layout),
    transparent: true,        // queues it after the opaque road
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -16,
    // A ShaderMaterial gets no tone-mapping chunk, which is what is wanted: the
    // composer grades the buffer this has already been blended into.
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(shadowGeometry(), mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // matches the previous mesh's behaviour: first in the transparent queue, so
  // skid marks and dust decals composite on top of it rather than under it
  mesh.renderOrder = -1;

  const kv = uK.value;
  const rv = uR.value;
  const setWheel = (i: number, offset: number) => {
    // Two independent terms, because a tyre's contact patch has two independent
    // behaviours and rest has to sit at full strength in both. `planted` fades
    // the lobe out as the corner droops away from the ground — that is what
    // stops a kart's shadow staying nailed on under a wheel that has left the
    // road. `load` tightens it as the chassis presses down: a loaded tyre has a
    // small hard patch, an unloaded one a wide soft one, and the same total
    // darkness concentrated into a smaller lobe is what reads as weight.
    const planted = Math.min(1, Math.max(0, (offset + SHADOW_DROOP) / SHADOW_DROOP));
    const load = Math.min(1, Math.max(0, offset / SHADOW_LOAD));
    const k = SHADOW_LOBE_MAX * planted;
    const r = SHADOW_LOBE_R * (1 + 0.30 * (1 - planted) - 0.22 * load);
    switch (i) {
      case 0: kv.x = k; rv.x = r; break;
      case 1: kv.y = k; rv.y = r; break;
      case 2: kv.z = k; rv.z = r; break;
      default: kv.w = k; rv.w = r; break;
    }
  };
  for (let i = 0; i < 4; i++) setWheel(i, 0);

  return { mesh, setWheel };
}
