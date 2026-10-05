/**
 * ============================================================================
 *  Noise toolkit — the raw signal generators the whole texture library is
 *  built out of.
 * ============================================================================
 *  Everything here is CPU-side and produces *seamlessly tiling* scalar fields
 *  into flat `Float32Array`s of `size * size`, row-major, top-left origin.
 *
 *  Why not just call simplex per texel? Because a 1024² field with six octaves
 *  is 6.3 M noise evaluations, and we have ~26 materials to build in under two
 *  seconds. Instead each octave is rasterised into its *own* small buffer whose
 *  resolution is matched to that octave's frequency (an octave with 32 lattice
 *  cells carries no detail above 128²) and then bilinearly accumulated into the
 *  destination. That is a ~15× saving with no visible difference, because the
 *  information simply isn't there in the discarded samples.
 *
 *  Tiling comes from *periodic* gradient noise: the lattice hash wraps at the
 *  octave frequency, so every octave repeats exactly once over the texture and
 *  the result is seamless by construction. simplex-noise is used where a
 *  non-tiling organic signal is wanted (scatter placement, per-cell jitter).
 * ============================================================================
 */
import { createNoise2D, createNoise3D } from 'simplex-noise';

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic 32-bit PRNG. Same seed, same world, every boot. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap stable 2D hash in [0,1) — used for per-texel grain and per-cell ids. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// simplex passthroughs (non-tiling, for scatter and 3D use)
// ---------------------------------------------------------------------------

export const simplex2 = (seed: number) => createNoise2D(mulberry32(seed));
export const simplex3 = (seed: number) => createNoise3D(mulberry32(seed));

// ---------------------------------------------------------------------------
// Periodic gradient noise
// ---------------------------------------------------------------------------

const permCache = new Map<number, Uint8Array>();

function permTable(seed: number): Uint8Array {
  let p = permCache.get(seed);
  if (p) return p;
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  const rnd = mulberry32(seed * 2654435761 + 17);
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  permCache.set(seed, p);
  return p;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(h: number, x: number, y: number): number {
  // 8 gradient directions; cheaper than a lookup and just as isotropic here.
  const g = h & 7;
  const u = g < 4 ? x : y;
  const v = g < 4 ? y : x;
  return (g & 1 ? -u : u) + (g & 2 ? -2 * v : 2 * v);
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

export type FbmMode = 'fbm' | 'ridged' | 'turbulence';

export interface FbmOpts {
  /** lattice cells across the whole texture for octave 0. Rounded to an int so the field tiles. */
  freq?: number;
  octaves?: number;
  gain?: number;
  lacunarity?: number;
  seed?: number;
  mode?: FbmMode;
  /** domain warp amplitude in UV units (0.05 is a strong, obvious warp) */
  warp?: number;
  warpFreq?: number;
  /** anisotropic stretch: >1 squashes the field along Y (wood grain, water) */
  stretchY?: number;
  /**
   * Histogram-stretch the finished field back out to [0,1], clipping this
   * fraction off each tail first (0.02 is a good default; 0 uses the exact
   * extremes).
   *
   * **Read this before authoring another low-frequency field.** An n-octave fbm
   * is a sum of n independent-ish signals, so by the central limit theorem its
   * output piles up around 0.5: a 3-octave field normalised by the sum of its
   * amplitudes spends almost all of its area inside 0.35..0.65 and essentially
   * never reaches 0 or 1. Every "macro variation" map in this library was built
   * that way and then consumed as `(v - 0.5) * 2`, which meant a modulation the
   * call site *thought* was ±100% was actually delivering about ±25%. That is
   * the arithmetic reason the metre-scale layer was invisible in shipped frames
   * and every surface read as one grade of fine speckle. Anything whose whole
   * job is to vary at a large scale must be normalised.
   */
  normalize?: number;
}

function sampleWrap(buf: Float32Array, res: number, u: number, v: number): number {
  // u,v are in [0,1) domain space; wrap so the bilinear filter tiles too.
  let fx = u * res;
  let fy = v * res;
  fx -= Math.floor(fx / res) * res;
  fy -= Math.floor(fy / res) * res;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = x0 + 1 === res ? 0 : x0 + 1;
  const y1 = y0 + 1 === res ? 0 : y0 + 1;
  const r0 = y0 * res;
  const r1 = y1 * res;
  const a = buf[r0 + x0] + (buf[r0 + x1] - buf[r0 + x0]) * tx;
  const b = buf[r1 + x0] + (buf[r1 + x1] - buf[r1 + x0]) * tx;
  return a + (b - a) * ty;
}

function octaveBuffer(res: number, freq: number, p: Uint8Array, mode: FbmMode, stretchY: number): Float32Array {
  const b = new Float32Array(res * res);
  const s = freq / res;
  const fy = freq * stretchY;
  const sy = fy / res;
  const py = Math.max(1, Math.round(fy));
  for (let y = 0; y < res; y++) {
    const yy = y * sy;
    const row = y * res;
    for (let x = 0; x < res; x++) {
      let n = perlinPeriodicXY(x * s, yy, freq, py, p);
      if (mode === 'ridged') {
        n = 1 - Math.abs(n);
        n *= n;
      } else if (mode === 'turbulence') {
        n = Math.abs(n);
      } else {
        n = n * 0.5 + 0.5;
      }
      b[row + x] = n;
    }
  }
  return b;
}

/** Perlin gradient noise in ~[-1,1] whose lattice wraps at `period` on both axes. */
export function perlinPeriodic(x: number, y: number, period: number, p: Uint8Array): number {
  return perlinPeriodicXY(x, y, period, period, p);
}

/** Perlin with independent X and Y periods (needed for anisotropic stretching). */
function perlinPeriodicXY(x: number, y: number, px: number, py: number, p: Uint8Array): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const X0 = (((xi % px) + px) % px) & 255;
  const Y0 = (((yi % py) + py) % py) & 255;
  const X1 = ((((xi + 1) % px) + px) % px) & 255;
  const Y1 = ((((yi + 1) % py) + py) % py) & 255;
  const u = fade(fx);
  const v = fade(fy);
  const pX0 = p[X0];
  const pX1 = p[X1];
  const n00 = grad2(p[pX0 + Y0], fx, fy);
  const n10 = grad2(p[pX1 + Y0], fx - 1, fy);
  const n01 = grad2(p[pX0 + Y1], fx, fy - 1);
  const n11 = grad2(p[pX1 + Y1], fx - 1, fy - 1);
  const a = n00 + u * (n10 - n00);
  const b2 = n01 + u * (n11 - n01);
  return (a + v * (b2 - a)) * 0.7;
}

/** Wrapping bilinear magnification with the X weights hoisted out of the inner loop. */
function upsampleWrap(src: Float32Array, sres: number, out: Float32Array, size: number): void {
  const x0 = new Int32Array(size);
  const x1 = new Int32Array(size);
  const tx = new Float32Array(size);
  const k = sres / size;
  for (let x = 0; x < size; x++) {
    const fx = x * k;
    const i = fx | 0;
    tx[x] = fx - i;
    x0[x] = i % sres;
    x1[x] = (i + 1) % sres;
  }
  for (let y = 0; y < size; y++) {
    const fy = y * k;
    const j = fy | 0;
    const ty = fy - j;
    const r0 = (j % sres) * sres;
    const r1 = ((j + 1) % sres) * sres;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = src[r0 + x0[x]];
      const b = src[r0 + x1[x]];
      const c = src[r1 + x0[x]];
      const d = src[r1 + x1[x]];
      const t = tx[x];
      const top = a + (b - a) * t;
      const bot = c + (d - c) * t;
      out[row + x] = top + (bot - top) * ty;
    }
  }
}

/**
 * Seamlessly tiling multi-octave noise, normalised to [0,1].
 *
 * Two economies, both invisible in the output:
 *  1. The field is accumulated at a *working* resolution set by its highest
 *     octave. A field whose finest detail is 32 cells across carries nothing
 *     above 128², so building it at 1024² would be 64× wasted work; it is built
 *     small and magnified once at the end.
 *  2. Domain warp offsets are evaluated once per texel, not once per octave.
 */
export function fbmField(size: number, o: FbmOpts = {}): Float32Array {
  const octaves = o.octaves ?? 4;
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  const mode = o.mode ?? 'fbm';
  const stretchY = o.stretchY ?? 1;
  const warp = o.warp ?? 0;
  const p = permTable(o.seed ?? 1);

  // frequency ladder up front, so we know how much resolution the field needs
  const freqs: number[] = [];
  let freq = Math.max(1, Math.round(o.freq ?? 4));
  for (let oi = 0; oi < octaves; oi++) {
    freqs.push(freq);
    freq = Math.min(240, Math.max(freq + 1, Math.round(freq * lac)));
  }
  const topFreq = freqs[freqs.length - 1] * Math.max(1, stretchY);
  const workRes = Math.min(size, Math.max(64, 1 << Math.ceil(Math.log2(topFreq * 4))));
  const work = new Float32Array(workRes * workRes);

  // Domain warp source: two low-resolution fields are plenty — the warp only
  // needs to move things around at a large scale to kill the Perlin cross grid.
  let su: Float32Array | null = null;
  let sv: Float32Array | null = null;
  if (warp > 0) {
    const wres = 96;
    const wf = Math.max(1, Math.round(o.warpFreq ?? 3));
    const wx = octaveBuffer(wres, wf, permTable((o.seed ?? 1) + 977), 'fbm', 1);
    const wy = octaveBuffer(wres, wf, permTable((o.seed ?? 1) + 1381), 'fbm', 1);
    su = new Float32Array(workRes * workRes);
    sv = new Float32Array(workRes * workRes);
    const inv = 1 / workRes;
    for (let y = 0; y < workRes; y++) {
      const v0 = y * inv;
      const row = y * workRes;
      for (let x = 0; x < workRes; x++) {
        const u0 = x * inv;
        su[row + x] = u0 + warp * (sampleWrap(wx, wres, u0, v0) - 0.5) * 2;
        sv[row + x] = v0 + warp * (sampleWrap(wy, wres, u0, v0) - 0.5) * 2;
      }
    }
  }

  let amp = 1;
  let norm = 0;
  const n = workRes * workRes;
  for (let oi = 0; oi < octaves; oi++) {
    const f = freqs[oi];
    const res = Math.min(workRes, Math.max(8, 1 << Math.ceil(Math.log2(f * 4))));
    const buf = octaveBuffer(res, f, p, mode, stretchY);
    if (su) {
      for (let i = 0; i < n; i++) work[i] += sampleWrap(buf, res, su[i], sv![i]) * amp;
    } else if (res === workRes) {
      // exact match — no resampling needed, which is the common case for the
      // finest octave and the one that would otherwise cost the most
      for (let i = 0; i < n; i++) work[i] += buf[i] * amp;
    } else {
      const inv = 1 / workRes;
      for (let y = 0; y < workRes; y++) {
        const v0 = y * inv;
        const row = y * workRes;
        for (let x = 0; x < workRes; x++) work[row + x] += sampleWrap(buf, res, x * inv, v0) * amp;
      }
    }
    norm += amp;
    amp *= gain;
  }

  const inv = 1 / norm;
  for (let i = 0; i < n; i++) work[i] *= inv;
  if (o.normalize !== undefined) normalizeField(work, o.normalize);
  if (workRes === size) return work;
  const out = new Float32Array(size * size);
  upsampleWrap(work, workRes, out, size);
  return out;
}

/**
 * Histogram-stretch a field in place so it actually spans [0,1].
 *
 * `clip` is the fraction of texels sacrificed off each tail before the stretch,
 * found with a 512-bin histogram. Clipping is what turns a smooth blob field
 * into a field with *regions*: the tails flatten into solid plateaux and the
 * transitions between them steepen, which is the difference between "the tarmac
 * is very slightly lighter over there" and "that is a different patch of tarmac".
 */
export function normalizeField(buf: Float32Array, clip = 0.02): Float32Array {
  const n = buf.length;
  if (n === 0) return buf;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return buf;
  if (clip > 0) {
    const BINS = 512;
    const hist = new Int32Array(BINS);
    const k = (BINS - 1) / (hi - lo);
    for (let i = 0; i < n; i++) hist[((buf[i] - lo) * k) | 0]++;
    const want = Math.max(1, Math.round(n * clip));
    let acc = 0;
    let b0 = 0;
    while (b0 < BINS - 1 && acc + hist[b0] < want) acc += hist[b0++];
    acc = 0;
    let b1 = BINS - 1;
    while (b1 > b0 && acc + hist[b1] < want) acc += hist[b1--];
    const nlo = lo + b0 / k;
    const nhi = lo + b1 / k;
    if (nhi - nlo > 1e-6) {
      lo = nlo;
      hi = nhi;
    }
  }
  const s = 1 / (hi - lo);
  for (let i = 0; i < n; i++) buf[i] = clamp01((buf[i] - lo) * s);
  return buf;
}

/** Push a 0..1 field away from (k>0) or toward (k<0) its midpoint. */
export function contrastField(buf: Float32Array, k: number): Float32Array {
  if (k === 0) return buf;
  const e = k > 0 ? 1 / (1 + k) : 1 - k;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    buf[i] = v < 0.5 ? 0.5 * Math.pow(clamp01(v * 2), e) : 1 - 0.5 * Math.pow(clamp01((1 - v) * 2), e);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The micro layer — one surface response per material FAMILY
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 *  Why this exists, with the measurement that produced it.
 * ===========================================================================
 *  Every generator in the library used to reach for the same two lines for its
 *  sub-millimetre detail:
 *
 *      const fine = fbmField(size, { freq: size / 10, octaves: 2, seed });
 *      ...
 *      rough = base + (fine[i] - 0.5) * 0.14;
 *
 *  Those two lines are the entire "single-octave noise doing duty on every
 *  surface" complaint, and they are worse than they look, for three reasons
 *  that only show up once you measure the shipped maps rather than read the
 *  source:
 *
 *   1. `freq: size / N` makes the frequency a property of the TEXTURE, not of
 *      the material. A 512² tile over 3 m and a 1024² tile over 1.2 m came out
 *      with detail at 47 mm and at 9 mm from *identical* parameters, and two
 *      surfaces that are supposed to be the same stuff came out different while
 *      two that are supposed to differ came out the same. Feature size belongs
 *      in MILLIMETRES OF WORLD, which is what `MicroSpec.mm` is.
 *   2. Two octaves at the default lacunarity 2 and gain 0.5 is one shape. Every
 *      material got that shape. Measured as a radial energy profile over the
 *      shipped roughness maps, `dirt`, `concrete`, `palm-bark` and the crowd's
 *      cloth were within 0.26 of each other on a scale where 0 is "identical
 *      surface response" — i.e. four materials the eye has no way to tell apart
 *      by how they answer a light, whatever their albedo says.
 *   3. `(fine - 0.5) * 0.14` against an un-normalised 2-octave fbm delivers a
 *      standard deviation around 0.02. Seventeen of the twenty-four materials
 *      shipped a roughness map with sd < 0.05, which is a constant to within
 *      the 8-bit quantisation of the channel it travels in.
 *
 *  So a family here fixes FOUR independent things at once, and it has to be all
 *  four or it does not read:
 *
 *   • characteristic frequency, in mm of world (`mm`, `mm2`);
 *   • octave structure — how many, how fast they fall off, and at what ratio
 *     (`octaves`, `gain`, `lacunarity`) — plus which `mode`, because ridged,
 *     turbulent and plain fbm have visibly different *histograms* and the
 *     histogram is what a low sun reads;
 *   • direction (`stretchY`, and `cross` for anything woven), because an
 *     isotropic surface is one the eye files under "noise";
 *   • and the RESPONSE — `gamma`, which decides whether a surface sits mostly
 *     at its rough end with rare polished spots (crushed stone) or mostly at
 *     its smooth end with rare rough ones (a paint film, a glaze). Two
 *     materials with the same roughness mean and the same swing but opposite
 *     gammas look nothing like each other under a 14° key, and no amount of
 *     albedo work substitutes for it.
 * ===========================================================================
 */
export type MicroFamily =
  | 'asphalt'
  | 'granular'
  | 'soil'
  | 'stone-rough'
  | 'stone-cut'
  | 'stone-bored'
  | 'stone-polished'
  | 'stucco'
  | 'concrete'
  | 'ceramic'
  | 'wood'
  | 'metal-rolled'
  | 'metal-polished'
  | 'paint'
  | 'fabric'
  | 'rubber'
  | 'glass'
  | 'bark';

export interface MicroSpec {
  /** characteristic feature size, in MILLIMETRES of world */
  mm: number;
  /** the family's second decade, also in mm — its "macro of the micro" */
  mm2: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /**
   * Anisotropy. `stretchY` is passed straight to `fbmField`, where it scales
   * the Y lattice frequency: **< 1 elongates the features along V**, > 1
   * elongates them along U. V is down the track on the road, up the wall on
   * architecture, along the board on a plank and around the arc on a rail, so
   * one number covers every case the library has.
   */
  stretchY: number;
  mode: FbmMode;
  warp: number;
  /** share of the roughness swing taken from `mm2` rather than from `mm` */
  coarse: number;
  /** peak-to-peak roughness swing the family carries inside its tile */
  swing: number;
  /**
   * Response shape, applied as `v ** gamma` before the swing.
   *
   *  · **< 1** — the surface spends most of its area at its ROUGH end, with
   *    rare polished excursions. Crushed stone, raw concrete, bark: the worn
   *    crowns are the exception.
   *  · **> 1** — most of the area sits at the SMOOTH end with rare rough
   *    excursions. A paint film with a few chalked patches, a fired glaze with
   *    a few blisters, polished marble with a scuff.
   *  · **1** — symmetric.
   */
  gamma: number;
  /** histogram clip: small = plateaux you can point at, large = a soft gradient */
  clip: number;
  /**
   * Woven. The second field is built at the SAME frequency as the first with a
   * reciprocal stretch, giving warp and weft, and the two are combined as a
   * weave rather than blended. One fbm cannot be anisotropic in two orthogonal
   * directions at once, and a fabric that is anisotropic in only one is a
   * brushed metal.
   */
  cross?: boolean;
}

/**
 * The table. Every row is a different answer to "what does a light do when it
 * lands on this?", and the columns are deliberately uncorrelated — a family
 * that differed only in `mm` would still share a histogram, and one that
 * differed only in `gamma` would still share a frequency.
 */
export const MICRO: Record<MicroFamily, MicroSpec> = {
  // Bitumen-bound crushed stone. Chip-scale, dragged down the direction of
  // travel, mostly rough with the traffic-polished crowns as the exception.
  asphalt: { mm: 9, mm2: 420, octaves: 3, lacunarity: 2.0, gain: 0.55, stretchY: 0.45, mode: 'fbm', warp: 0.03, coarse: 0.42, swing: 0.30, gamma: 0.75, clip: 0.03 },
  // Dry sand: grains far below a texel, so what actually varies is the ripple
  // field the wind and the tide leave, which runs along the shore.
  granular: { mm: 2.2, mm2: 260, octaves: 2, lacunarity: 2.9, gain: 0.42, stretchY: 0.30, mode: 'fbm', warp: 0.05, coarse: 0.62, swing: 0.18, gamma: 1.25, clip: 0.05 },
  soil: { mm: 7, mm2: 340, octaves: 4, lacunarity: 1.85, gain: 0.60, stretchY: 1.0, mode: 'fbm', warp: 0.07, coarse: 0.44, swing: 0.24, gamma: 0.90, clip: 0.03 },
  // Ashlar and sea wall: pitted, isotropic within a block, turbulent histogram
  // (all the energy on one side of zero) which is what pitting looks like.
  'stone-rough': { mm: 6, mm2: 260, octaves: 4, lacunarity: 2.1, gain: 0.52, stretchY: 1.0, mode: 'turbulence', warp: 0.05, coarse: 0.45, swing: 0.26, gamma: 0.70, clip: 0.02 },
  // A bedded limestone face: spalls ALONG its bedding, so the detail is drawn
  // out horizontally, and ridged because rock parts along planes.
  'stone-cut': { mm: 14, mm2: 900, octaves: 4, lacunarity: 2.35, gain: 0.48, stretchY: 4.0, mode: 'ridged', warp: 0.06, coarse: 0.50, swing: 0.28, gamma: 0.80, clip: 0.02 },
  // A bored tunnel is a fresh mechanical cut: finer, arced around the bore
  // rather than bedded, and much less weathered — so a tighter swing.
  'stone-bored': { mm: 5, mm2: 480, octaves: 3, lacunarity: 2.7, gain: 0.45, stretchY: 0.30, mode: 'ridged', warp: 0.03, coarse: 0.38, swing: 0.22, gamma: 0.95, clip: 0.04 },
  'stone-polished': { mm: 40, mm2: 1400, octaves: 2, lacunarity: 2.0, gain: 0.40, stretchY: 0.55, mode: 'fbm', warp: 0.10, coarse: 0.60, swing: 0.17, gamma: 1.9, clip: 0.06 },
  // Lime render: sand grains at 3 mm inside float sweeps at 40 cm, and the
  // sweeps run across the wall because that is how a trowel is held.
  stucco: { mm: 3, mm2: 380, octaves: 3, lacunarity: 1.75, gain: 0.62, stretchY: 1.45, mode: 'turbulence', warp: 0.11, coarse: 0.38, swing: 0.23, gamma: 0.85, clip: 0.03 },
  // Cast concrete: fine sand-cement skin over the shutter marks the form boards
  // left, and form boards are laid horizontally — hence a strong stretch the
  // other way from every stone in the table.
  concrete: { mm: 5, mm2: 300, octaves: 4, lacunarity: 1.9, gain: 0.58, stretchY: 3.2, mode: 'turbulence', warp: 0.04, coarse: 0.48, swing: 0.29, gamma: 0.65, clip: 0.02 },
  // Fired clay under a glaze: the glaze is the surface, so it is mostly smooth
  // with the chalked and crazed patches as rare excursions.
  ceramic: { mm: 22, mm2: 520, octaves: 2, lacunarity: 2.6, gain: 0.42, stretchY: 0.75, mode: 'fbm', warp: 0.04, coarse: 0.55, swing: 0.25, gamma: 1.70, clip: 0.05 },
  // Sawn timber. Ridged, because growth rings are ridges, at a 3× lacunarity so
  // the figure is coarse-to-fine rather than a smooth blur, and stretched hard
  // along V because the grain runs the length of the board.
  wood: { mm: 2, mm2: 240, octaves: 3, lacunarity: 3.0, gain: 0.50, stretchY: 0.09, mode: 'ridged', warp: 0.02, coarse: 0.35, swing: 0.33, gamma: 1.0, clip: 0.03 },
  'metal-rolled': { mm: 1.5, mm2: 190, octaves: 2, lacunarity: 2.8, gain: 0.45, stretchY: 0.10, mode: 'fbm', warp: 0.02, coarse: 0.50, swing: 0.23, gamma: 1.5, clip: 0.05 },
  'metal-polished': { mm: 0.6, mm2: 90, octaves: 2, lacunarity: 3.4, gain: 0.38, stretchY: 0.035, mode: 'fbm', warp: 0.01, coarse: 0.45, swing: 0.15, gamma: 2.2, clip: 0.06 },
  // A sprayed film. Almost featureless, which is the point — what varies is
  // orange peel at half a millimetre and where the film has chalked.
  paint: { mm: 1.2, mm2: 320, octaves: 2, lacunarity: 2.2, gain: 0.40, stretchY: 1.0, mode: 'fbm', warp: 0.06, coarse: 0.62, swing: 0.16, gamma: 2.4, clip: 0.07 },
  fabric: { mm: 1.1, mm2: 55, octaves: 2, lacunarity: 4.0, gain: 0.55, stretchY: 0.16, mode: 'turbulence', warp: 0.01, coarse: 0.45, swing: 0.28, gamma: 1.0, clip: 0.04, cross: true },
  rubber: { mm: 0.8, mm2: 45, octaves: 3, lacunarity: 2.2, gain: 0.60, stretchY: 1.0, mode: 'turbulence', warp: 0.02, coarse: 0.30, swing: 0.21, gamma: 0.75, clip: 0.03 },
  glass: { mm: 60, mm2: 900, octaves: 2, lacunarity: 2.0, gain: 0.35, stretchY: 0.80, mode: 'fbm', warp: 0.08, coarse: 0.70, swing: 0.08, gamma: 3.0, clip: 0.08 },
  bark: { mm: 4, mm2: 170, octaves: 4, lacunarity: 2.15, gain: 0.55, stretchY: 0.26, mode: 'turbulence', warp: 0.03, coarse: 0.40, swing: 0.25, gamma: 0.70, clip: 0.03 },
};

export interface MicroField {
  /** the family's characteristic field, normalised to [0,1] */
  a: Float32Array;
  /** its second decade — or the weft, on a woven family */
  b: Float32Array;
  spec: MicroSpec;
  /** `0.5 ** gamma`, hoisted so the per-texel path has no `pow` on a constant */
  centre: number;
}

/**
 * Build one material family's micro surface at a given world scale.
 *
 * `worldScaleM` is the metres of world one tile covers — the same number the
 * material publishes in `WORLD_SCALE` — and it is what turns the family's
 * feature size in millimetres into a lattice frequency. Frequencies are clamped
 * to `size / 4`: a feature four texels across is the finest thing a mip chain
 * can carry without turning into specular crawl, and asking for 0.6 mm chrome
 * brush lines on a 1 m tile would otherwise request 1666 cycles.
 */
export function microSurface(
  size: number,
  worldScaleM: number,
  family: MicroFamily,
  seed: number,
): MicroField {
  const s = MICRO[family];
  const mmPerTile = Math.max(1, worldScaleM) * 1000;
  const top = Math.max(4, size >> 2);
  const fA = clamp(Math.round(mmPerTile / s.mm), 2, top);
  const a = fbmField(size, {
    freq: fA,
    octaves: s.octaves,
    gain: s.gain,
    lacunarity: s.lacunarity,
    stretchY: s.stretchY,
    mode: s.mode,
    warp: s.warp,
    seed,
    normalize: s.clip,
  });
  const b = s.cross
    ? // the weft: same thread pitch, laid across the warp
      fbmField(size, {
        freq: fA,
        octaves: s.octaves,
        gain: s.gain,
        lacunarity: s.lacunarity,
        stretchY: 1 / s.stretchY,
        mode: s.mode,
        warp: s.warp,
        seed: seed + 1013,
        normalize: s.clip,
      })
    : fbmField(size, {
        freq: clamp(Math.round(mmPerTile / s.mm2), 1, Math.max(2, fA - 1)),
        octaves: Math.max(2, s.octaves - 1),
        gain: s.gain,
        lacunarity: s.lacunarity,
        // the coarse decade keeps the family's direction but only half as hard —
        // a surface whose every scale is stretched identically reads as a smear
        stretchY: s.stretchY > 1 ? 1 + (s.stretchY - 1) * 0.5 : 1 - (1 - s.stretchY) * 0.5,
        mode: 'fbm',
        warp: s.warp * 1.6,
        seed: seed + 1013,
        normalize: Math.min(0.12, s.clip * 1.8),
      });
  return { a, b, spec: s, centre: Math.pow(0.5, s.gamma) };
}

/** The family's combined field at texel `i`, in [0,1] before the response curve. */
export function microValue(m: MicroField, i: number): number {
  const s = m.spec;
  if (s.cross) {
    // A weave is not a blend. A tow crown is where one thread passes OVER the
    // other, i.e. where one field is high and the other is low, and the fabric
    // dips into the interstice where both are low — so `max` gives the crowns
    // and the product gives the interstices, and the difference between them is
    // the cross-hatch that makes cloth read as cloth at a centimetre.
    const hi = m.a[i] > m.b[i] ? m.a[i] : m.b[i];
    return hi * 0.72 + m.a[i] * m.b[i] * 0.28;
  }
  return m.a[i] * (1 - s.coarse) + m.b[i] * s.coarse;
}

/**
 * Roughness at texel `i`, as this family responds.
 *
 * `base` is the family's centre value — the number the material already knew —
 * and everything this adds is the *variation*, shaped by `gamma`, so retro-
 * fitting a builder never moves its mean.
 */
export function microRough(m: MicroField, i: number, base: number): number {
  const v = microValue(m, i);
  return base + (Math.pow(v, m.spec.gamma) - m.centre) * m.spec.swing;
}

/**
 * The same field as a signed detail term for height and albedo, in ±0.5.
 *
 * Relief has to come from the same generator as roughness or the two disagree
 * about where the surface is: a chip crown that is smooth in the roughness map
 * and flat in the height map is two materials pretending to be one.
 */
export function microDetail(m: MicroField, i: number): number {
  return microValue(m, i) - 0.5;
}

// ---------------------------------------------------------------------------
// The macro layer
// ---------------------------------------------------------------------------

export interface MacroOpts extends FbmOpts {
  /**
   * Working resolution. A macro map is low frequency *by definition* — its whole
   * content is a handful of lattice cells — so building it at the material's
   * texture size is pure waste. 128² stretched over 30 m of world is a sample
   * every 23 cm, which is finer than anything this layer is allowed to contain.
   */
  res?: number;
  /** clip fraction for the histogram stretch (see `normalizeField`) */
  clip?: number;
}

/**
 * A **metre-scale** variation field: low frequency, heavily domain-warped and
 * contrast-normalised, built small and magnified.
 *
 * This is the layer the whole library was missing. `fbmField` produces a good
 * detail octave, but a detail octave is all it produces: at any frequency high
 * enough to look like grain it also averages to a constant over a metre, and a
 * surface whose only spatial frequency is grain reads as flat noise no matter
 * how good the grain is. Use this for everything above ~1 m, and consume it for
 * BOTH albedo and roughness — a large-scale albedo blotch with constant
 * roughness under it still lights like a flat sheet.
 */
export function macroField(size: number, o: MacroOpts = {}): Float32Array {
  const res = Math.min(size, o.res ?? 128);
  const buf = fbmField(res, {
    freq: 2,
    octaves: 3,
    warp: 0.12,
    warpFreq: 2,
    ...o,
    normalize: undefined,
  });
  normalizeField(buf, o.clip ?? 0.02);
  if (res === size) return buf;
  const out = new Float32Array(size * size);
  upsampleWrap(buf, res, out, size);
  return out;
}

export interface PatchOpts {
  /** patch cells across the tile — 3..6 for road repairs at a ~30 m macro period */
  cells?: number;
  jitter?: number;
  /** domain-warp amplitude in cell units; this is what makes the boundary ragged */
  warp?: number;
  warpFreq?: number;
  /** fraction of cells that are actually a patch, 0..1 */
  coverage?: number;
  /** boundary feather, in cell units. Small = a cut edge, large = a smear. */
  softness?: number;
  seed?: number;
  res?: number;
}

export interface PatchFieldResult {
  /** 1 inside a patch, 0 outside, feathered across `softness` */
  mask: Float32Array;
  /** owning cell id, so each patch can take its own tone/roughness */
  id: Int32Array;
}

/**
 * Irregular regions with **soft but definite** boundaries: asphalt repairs,
 * resurfaced sections, worn-through turf, damp ground.
 *
 * A thresholded fbm gives regions with mushy edges that read as a stain; a raw
 * Voronoi gives regions with straight edges that read as a mosaic. This is a
 * Voronoi *sampled through a domain warp*, which is the one construction that
 * gives a region a definite edge you can point at and an outline nothing
 * recognises as a cell. Built at `res` and magnified — a patch boundary is a
 * metre-scale feature and does not need texel-accurate placement.
 */
export function patchField(size: number, o: PatchOpts = {}): PatchFieldResult {
  const res = Math.min(size, o.res ?? 192);
  const cells = Math.max(2, Math.round(o.cells ?? 4));
  const seed = o.seed ?? 1;
  const softness = o.softness ?? 0.16;
  const coverage = o.coverage ?? 0.34;
  const warp = o.warp ?? 0.35;
  const v = voronoiField(res, cells, cells, o.jitter ?? 0.95, seed, 1);
  const wx = fbmField(res, { freq: Math.max(2, o.warpFreq ?? 3), octaves: 3, seed: seed + 611 });
  const wy = fbmField(res, { freq: Math.max(2, o.warpFreq ?? 3), octaves: 3, seed: seed + 907 });

  const mask = new Float32Array(res * res);
  const id = new Int32Array(res * res);
  // Warping the *lookup* rather than the sites keeps the field cheap: one extra
  // bilinear fetch per texel instead of a re-solve of the cell neighbourhood.
  for (let y = 0; y < res; y++) {
    const v0 = y / res;
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const u0 = x / res;
      const du = (wx[row + x] - 0.5) * 2 * warp / cells;
      const dv = (wy[row + x] - 0.5) * 2 * warp / cells;
      const f1 = sampleWrap(v.f1, res, u0 + du, v0 + dv);
      const f2 = sampleWrap(v.f2, res, u0 + du, v0 + dv);
      let sx = Math.floor((u0 + du - Math.floor(u0 + du)) * res);
      let sy = Math.floor((v0 + dv - Math.floor(v0 + dv)) * res);
      if (sx >= res) sx = res - 1;
      if (sy >= res) sy = res - 1;
      const cid = v.id[sy * res + sx];
      id[row + x] = cid;
      const keep = hash2(cid, 71, seed) < coverage ? 1 : 0;
      mask[row + x] = keep * smoothstep(0, softness, f2 - f1);
    }
  }
  if (res === size) return { mask, id };
  const outMask = new Float32Array(size * size);
  upsampleWrap(mask, res, outMask, size);
  const outId = new Int32Array(size * size);
  const k = res / size;
  for (let y = 0; y < size; y++) {
    const r = (((y * k) | 0) % res) * res;
    const row = y * size;
    for (let x = 0; x < size; x++) outId[row + x] = id[r + (((x * k) | 0) % res)];
  }
  return { mask: outMask, id: outId };
}

export interface StrataOpts {
  /** beds across the tile height */
  bands?: number;
  /** per-bed thickness variation, 0..1 */
  thicknessJitter?: number;
  /** how far the bedding planes wander, in band heights */
  warp?: number;
  warpFreq?: number;
  seed?: number;
  res?: number;
}

export interface StrataFieldResult {
  /** position inside the bed, 0 at its base, 1 at its top */
  t: Float32Array;
  /** bed index — hash it for per-bed tone, roughness and hardness */
  id: Int32Array;
  /** 1 on a bedding plane, falling to 0 in the middle of a bed */
  plane: Float32Array;
}

/**
 * Sedimentary bedding: horizontal bands of varying thickness whose boundaries
 * wander, with a stable per-bed identity.
 *
 * Rock is not pebble noise. What makes a cliff read as *geology* from 40 m is
 * layering — bands that differ in tone, in hardness and therefore in how far
 * they weather back — and no isotropic noise field, at any frequency, produces
 * it. Beds stack along V (the field varies with y), so on a triplanar
 * surface the caller should let the shader do the world-space banding and use
 * this for the tile-scale layering underneath it.
 */
export function strataField(size: number, o: StrataOpts = {}): StrataFieldResult {
  const res = Math.min(size, o.res ?? 256);
  const bands = Math.max(2, Math.round(o.bands ?? 7));
  const seed = o.seed ?? 1;
  const jit = o.thicknessJitter ?? 0.45;
  const warpAmt = o.warp ?? 0.55;

  // Bed boundaries in 0..1, closing exactly on 1 so the field tiles vertically.
  const edges = new Float32Array(bands + 1);
  const rnd = mulberry32(seed * 7919 + 13);
  const w = new Float32Array(bands);
  let total = 0;
  for (let b = 0; b < bands; b++) {
    w[b] = 1 + (rnd() - 0.5) * 2 * jit;
    total += w[b];
  }
  let acc = 0;
  for (let b = 0; b < bands; b++) {
    edges[b] = acc;
    acc += w[b] / total;
  }
  edges[bands] = 1;

  const warp = fbmField(res, { freq: 3, octaves: 3, seed: seed + 331, stretchY: 0.35 });
  const t = new Float32Array(res * res);
  const id = new Int32Array(res * res);
  const plane = new Float32Array(res * res);

  for (let y = 0; y < res; y++) {
    const row = y * res;
    const v0 = (y + 0.5) / res;
    for (let x = 0; x < res; x++) {
      // the bedding plane wanders, but slowly and mostly horizontally — that
      // slight non-flatness is the whole difference between strata and stripes
      let v = v0 + (warp[row + x] - 0.5) * 2 * (warpAmt / bands);
      v -= Math.floor(v);
      let b = 0;
      while (b < bands - 1 && v >= edges[b + 1]) b++;
      const lo = edges[b];
      const hi = edges[b + 1];
      const h = Math.max(1e-4, hi - lo);
      const f = (v - lo) / h;
      t[row + x] = f;
      id[row + x] = b;
      // thin beds have proportionally thicker bedding planes, same as real rock
      plane[row + x] = Math.max(smoothstep(0.13, 0.0, f), smoothstep(0.87, 1.0, f));
    }
  }
  if (res === size) return { t, id, plane };
  const upT = new Float32Array(size * size);
  const upP = new Float32Array(size * size);
  upsampleWrap(t, res, upT, size);
  upsampleWrap(plane, res, upP, size);
  const outId = new Int32Array(size * size);
  const k = res / size;
  for (let y = 0; y < size; y++) {
    const r = (((y * k) | 0) % res) * res;
    const row = y * size;
    for (let x = 0; x < size; x++) outId[row + x] = id[r + (((x * k) | 0) % res)];
  }
  return { t: upT, id: outId, plane: upP };
}

/**
 * Smear a field along a direction — the isotropy breaker for fields that are
 * not fbm and so cannot be stretched at generation time (Voronoi aggregate,
 * a patch mask, a scatter).
 *
 * Road aggregate is dragged along the direction of travel by every tyre that
 * ever crossed it; rock spalls along its bedding; brushed metal runs one way.
 * A field with no direction in it is the second half of "uniform isotropic
 * speckle" and no amount of extra octaves fixes it.
 */
export function directionalBlur(
  src: Float32Array,
  size: number,
  dx: number,
  dy: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(size * size);
  const r = Math.max(1, Math.round(radius));
  const inv = 1 / Math.hypot(dx, dy || 1e-6);
  const sx = dx * inv;
  const sy = dy * inv;
  const n = r * 2 + 1;
  const norm = 1 / n;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        let px = Math.round(x + sx * k);
        let py = Math.round(y + sy * k);
        px = ((px % size) + size) % size;
        py = ((py % size) + size) % size;
        acc += src[py * size + px];
      }
      out[row + x] = acc * norm;
    }
  }
  return out;
}

/** Per-texel white noise — free grain, tiles trivially because it is per-pixel. */
export function grainField(size: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) out[row + x] = hash2(x, y, seed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voronoi / worley
// ---------------------------------------------------------------------------

export interface VoronoiField {
  /** distance to the nearest site, in cell units (0 at the site, ~0.7 at a corner) */
  f1: Float32Array;
  /** distance to the second nearest site, in cell units */
  f2: Float32Array;
  /** id of the owning cell — hash it for per-cell colour/height variation */
  id: Int32Array;
  /** offset from the texel to its site, in cell units — gives each cell a local frame */
  dx: Float32Array;
  dy: Float32Array;
  cellsX: number;
  cellsY: number;
}

/**
 * Periodic Voronoi. Returns f1, f2, the owning cell id and the local offset, so
 * a caller can build cobbles (dome from f1), cracked rock (ridge from f2-f1),
 * shingles (per-id colour) or aggregate (per-id albedo jitter) from one pass.
 */
export function voronoiField(
  size: number,
  cellsX: number,
  cellsY: number,
  jitter: number,
  seed: number,
  /** build at size/resDiv and magnify — only safe when the features are wide (crack networks) */
  resDiv = 1,
): VoronoiField {
  if (resDiv > 1) {
    const small = Math.max(64, Math.round(size / resDiv));
    const v = voronoiField(small, cellsX, cellsY, jitter, seed, 1);
    const up = (src: Float32Array) => {
      const out = new Float32Array(size * size);
      upsampleWrap(src, small, out, size);
      return out;
    };
    // ids are categorical, so they magnify by nearest neighbour
    const id = new Int32Array(size * size);
    const k = small / size;
    for (let y = 0; y < size; y++) {
      const r = ((y * k) | 0) * small;
      const row = y * size;
      for (let x = 0; x < size; x++) id[row + x] = v.id[r + ((x * k) | 0)];
    }
    return { f1: up(v.f1), f2: up(v.f2), id, dx: up(v.dx), dy: up(v.dy), cellsX, cellsY };
  }
  const n = cellsX * cellsY;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const rnd = mulberry32(seed * 6151 + 3);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const i = cy * cellsX + cx;
      sx[i] = cx + 0.5 + (rnd() - 0.5) * jitter;
      sy[i] = cy + 0.5 + (rnd() - 0.5) * jitter;
    }
  }

  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const id = new Int32Array(size * size);
  const ox = new Float32Array(size * size);
  const oy = new Float32Array(size * size);
  const kx = cellsX / size;
  const ky = cellsY / size;

  for (let y = 0; y < size; y++) {
    const py = (y + 0.5) * ky;
    const cy = Math.floor(py);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * kx;
      const cx = Math.floor(px);
      let b1 = 1e9;
      let b2 = 1e9;
      let bid = 0;
      let bdx = 0;
      let bdy = 0;
      for (let j = -1; j <= 1; j++) {
        let gy = cy + j;
        let wy = 0;
        if (gy < 0) {
          gy += cellsY;
          wy = -cellsY;
        } else if (gy >= cellsY) {
          gy -= cellsY;
          wy = cellsY;
        }
        for (let i = -1; i <= 1; i++) {
          let gx = cx + i;
          let wx = 0;
          if (gx < 0) {
            gx += cellsX;
            wx = -cellsX;
          } else if (gx >= cellsX) {
            gx -= cellsX;
            wx = cellsX;
          }
          const s = gy * cellsX + gx;
          const ddx = sx[s] + wx - px;
          const ddy = sy[s] + wy - py;
          const d = ddx * ddx + ddy * ddy;
          if (d < b1) {
            b2 = b1;
            b1 = d;
            bid = s;
            bdx = ddx;
            bdy = ddy;
          } else if (d < b2) {
            b2 = d;
          }
        }
      }
      const k = row + x;
      f1[k] = Math.sqrt(b1);
      f2[k] = Math.sqrt(b2);
      id[k] = bid;
      ox[k] = bdx;
      oy[k] = bdy;
    }
  }
  return { f1, f2, id, dx: ox, dy: oy, cellsX, cellsY };
}

// ---------------------------------------------------------------------------
// Brick / plank lattice
// ---------------------------------------------------------------------------

export interface BrickField {
  /** unique index of the brick under each texel */
  id: Int32Array;
  /** position inside the brick, 0..1 on each axis */
  lu: Float32Array;
  lv: Float32Array;
  /** normalised distance to the nearest brick edge: 0 on the joint, 1 at the core */
  edge: Float32Array;
  rows: number;
}

/**
 * Running-bond lattice with jittered course heights and per-course block widths.
 * Feeds ashlar walls, timber planks (rows = 1 column, many rows) and roof
 * courses. `mortar` is the joint half-width as a fraction of a brick.
 */
export function brickField(
  size: number,
  cols: number,
  rows: number,
  stagger: number,
  widthJitter: number,
  mortar: number,
  seed: number,
  /** false for decking/cladding: boards run unbroken along V with no butt joints */
  crossJoints = true,
): BrickField {
  const rnd = mulberry32(seed * 8191 + 7);
  // Per-course column boundaries in 0..1, always closing exactly on 1 so it tiles.
  const bounds: Float32Array[] = [];
  const idBase: number[] = [];
  let idCounter = 0;
  for (let r = 0; r < rows; r++) {
    const w = new Float32Array(cols + 1);
    let total = 0;
    const widths = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      widths[c] = 1 + (rnd() - 0.5) * 2 * widthJitter;
      total += widths[c];
    }
    let acc = (r * stagger) % 1;
    w[0] = acc;
    for (let c = 0; c < cols; c++) {
      acc += widths[c] / total;
      w[c + 1] = acc;
    }
    bounds.push(w);
    idBase.push(idCounter);
    idCounter += cols;
  }

  const id = new Int32Array(size * size);
  const lu = new Float32Array(size * size);
  const lv = new Float32Array(size * size);
  const edge = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const rf = v * rows;
    const r = Math.min(rows - 1, Math.floor(rf));
    const vv = rf - r;
    const w = bounds[r];
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      // shift into the course's own space, wrapped
      let uu = u - w[0];
      uu -= Math.floor(uu);
      let c = 0;
      while (c < cols && uu > w[c + 1] - w[0]) c++;
      if (c >= cols) c = cols - 1;
      const a = w[c] - w[0];
      const b = w[c + 1] - w[0];
      const width = Math.max(1e-4, b - a);
      const fu = (uu - a) / width;
      const k = row + x;
      id[k] = idBase[r] + c;
      lu[k] = fu;
      lv[k] = vv;
      // distance to the joint, measured in texture units so joints look even
      const du = Math.min(fu, 1 - fu) * width;
      const dv = crossJoints ? Math.min(vv, 1 - vv) / rows : 1e9;
      edge[k] = clamp01(Math.min(du, dv) / Math.max(1e-4, mortar));
    }
  }
  return { id, lu, lv, edge, rows };
}
