/**
 * ============================================================================
 *  SUNSET BAY CIRCUIT — geometry
 * ============================================================================
 *  Everything here is swept from the same cross-section functions the physics
 *  probe uses (`Track.crossPoint` / `Track.crossOffset`), so the road you see
 *  and the road you drive on are the same surface to the millimetre. Nothing
 *  is hand-placed relative to anything else: move the layout and every mesh
 *  moves with it.
 *
 *  Materials come from the shared library via `getMaterials()`, and every UV
 *  here is authored in metres divided by that material's `worldScale`, so
 *  chippings, setts, kerb stripes and ashlar all come out at their authored
 *  physical size. Two materials are track-owned because the shared library
 *  enables vertex colours nowhere and they need them: the four-way terrain
 *  blend and the start-line checker. If the library is unavailable or hands
 *  back an untextured placeholder, procedural PBR sets baked here take over so
 *  the circuit never renders as flat grey plastic.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';
import { Surface } from '../types';
import type { Track } from './Track';
import {
  BOOST_PADS, BRIDGE_T0, BRIDGE_T1, FASCIA_OFF, GRID_BOX_HL, GRID_BOX_HW,
  GRID_LAT, KERB_HS, KERB_QS, KERB_W, PARAPET_OFF, SEA_Y,
  SKIRT_W, TUNNEL_CLEAR, TUNNEL_H, TUNNEL_T0, TUNNEL_T1, WALL_GUARDRAIL,
  WALL_PARAPET, WALL_ROCK,
  Z_BEACH, Z_TUNNEL, gridSlot, smoothstep as ss, type Corner,
} from './TrackLayout';
import { createNoise2D } from 'simplex-noise';
import { getMaterials } from '../render/Materials';
import { registerPrewarm } from '../core/Prewarm';

// ---------------------------------------------------------------------------
//  Palette (art bible §3). THREE.Color is linear working space here.
// ---------------------------------------------------------------------------
const C_TARMAC = new THREE.Color('#4a4a52');
const C_RACE = new THREE.Color('#3e3e48');
const C_KERB_R = new THREE.Color('#e0453f');
const C_KERB_W = new THREE.Color('#f2ece0');
const C_SAND = new THREE.Color('#e3c893');
const C_GRASS = new THREE.Color('#6f9b47');
const C_GRASS_T = new THREE.Color('#87b356');
const C_DIRT = new THREE.Color('#9c7a52');
const C_STONE = new THREE.Color('#a8927a');
const C_GRIME = new THREE.Color('#6a6154');
const C_PAINT = new THREE.Color('#f2ece0');

/**
 * Vertex-colour multiplier that carries tarmac `#4a4a52` to the racing-line
 * `#3e3e48` of the palette table. Kept as a ratio rather than a colour because
 * it rides on top of whichever tarmac map the shared library handed us, and a
 * ratio survives that where an absolute colour would fight it.
 */
/*
 * NB the ratio is taken in **linear** space, which is the space this multiplier
 * is applied in. Round 1 used the sRGB *byte* ratio (0x3e/0x4a = 0.83) as if it
 * were linear, which under-darkens the line by nearly half — 17% instead of the
 * 29% the palette table actually specifies — and is why the racing line was
 * invisible in every round-1 frame. Tempered slightly from the true 0.635
 * because the polished core also gets the darker `tarmac-racing-line` map on top
 * of this, and the two must not stack into a black stripe.
 */
const C_RACE_MUL = new THREE.Color(0.75, 0.75, 0.90);
/** warm dusting where the beach blows sand across the outer lane */
const C_SAND_MUL = new THREE.Color(1.30, 1.16, 0.92);
/** pale silt and grit washed into the gutter, in patches, everywhere */
const C_DUST_MUL = new THREE.Color(1.24, 1.14, 0.97);
/**
 * Sun-bleached outer lane. Warm and slightly *up* in value: an outer lane that
 * no wheel polishes keeps its lighter, oxidised binder, and it is the second
 * albedo the road needs to stop reading as one tone. Kept under 1.3 so the
 * product with the map cannot clip — `#4a4a52` is only 0.075 linear, so there is
 * plenty of headroom, but the gutter dust can land on the same vertex.
 */
const C_BLEACH_MUL = new THREE.Color(1.34, 1.29, 1.18);
/** the dark kiss of rubber and dirt packed into the kerb/tarmac joint */
const C_JOINT_MUL = new THREE.Color(0.42, 0.40, 0.42);

/** the neutral ground detail map averages this, so hues are pre-divided by it */
const GROUND_GAIN = 1.5;

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);

// ===========================================================================
//  Procedural material fallbacks
// ===========================================================================

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const trnd = mulberry32(20260726);
const tn1 = createNoise2D(trnd);
const tn2 = createNoise2D(trnd);

function fbm(x: number, y: number, oct: number, lac = 2.03, gain = 0.5): number {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * tn1(x * f, y * f);
    norm += a; a *= gain; f *= lac;
  }
  return s / norm;
}

interface TexSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture; }

/**
 * One pass over a tiling height field, from which albedo, roughness and a
 * derived normal map all fall out. Cheaper than three separate loops, and it
 * guarantees the three maps describe the same physical surface.
 */
function bakeTexSet(
  size: number,
  height: (u: number, v: number) => number,
  shade: (u: number, v: number, h: number, out: THREE.Color) => void,
  rough: (u: number, v: number, h: number) => number,
  normalScale: number,
): TexSet {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) H[y * size + x] = height(x / size, y / size);
  }
  const albedo = new Uint8Array(size * size * 4);
  const nrm = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  const col = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const h = H[k];
      const u = x / size, v = y / size;
      shade(u, v, h, col);
      // palette colours live in linear space; the albedo texture is sRGB
      col.convertLinearToSRGB();
      const o = k * 4;
      albedo[o] = Math.max(0, Math.min(255, col.r * 255));
      albedo[o + 1] = Math.max(0, Math.min(255, col.g * 255));
      albedo[o + 2] = Math.max(0, Math.min(255, col.b * 255));
      albedo[o + 3] = 255;
      const hl = H[y * size + ((x - 1 + size) % size)];
      const hr = H[y * size + ((x + 1) % size)];
      const hd = H[((y - 1 + size) % size) * size + x];
      const hu = H[((y + 1) % size) * size + x];
      const nx = (hl - hr) * normalScale, ny = (hd - hu) * normalScale;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nrm[o] = (nx * inv * 0.5 + 0.5) * 255;
      nrm[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nrm[o + 2] = (inv * 0.5 + 0.5) * 255;
      nrm[o + 3] = 255;
      // three samples roughness from the green channel
      rgh[o + 1] = Math.max(0, Math.min(1, rough(u, v, h))) * 255;
      rgh[o + 3] = 255;
    }
  }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(albedo, true), normalMap: mk(nrm, false), roughnessMap: mk(rgh, false) };
}

/** Rounded-rect brick lattice, used for cobbles and ashlar masonry. */
function brickField(u: number, v: number, cols: number, rows: number, stagger: number) {
  const gy = v * rows;
  const row = Math.floor(gy);
  const gx = u * cols + (row & 1 ? stagger : 0);
  const cx = gx - Math.floor(gx) - 0.5;
  const cy = gy - row - 0.5;
  const id = tn2(Math.floor(gx) * 3.3 + 0.5, row * 7.7 + 0.5) * 0.5 + 0.5;
  const d = Math.max(Math.abs(cx) / (0.5 - 0.045), Math.abs(cy) / (0.5 - 0.07));
  return { d, id };
}

class MatLib {
  private src: any;
  private cache = new Map<string, THREE.Material>();
  private aniso = 8;
  /** clones made by `vc()`; Track keeps their env map in step with the sky */
  readonly clones: THREE.MeshStandardMaterial[] = [];

  constructor(ctx: Ctx) {
    // Materials has no slot on Ctx, so it publishes a module-level accessor.
    try { this.src = getMaterials(); } catch { this.src = null; }
    const cap = ctx.renderer?.capabilities;
    if (cap) this.aniso = Math.min(8, cap.getMaxAnisotropy());
  }

  /** Ask the shared library first; fall back to our own procedural set. */
  get(name: string, make: () => THREE.Material): THREE.Material {
    let shared: any = null;
    try { shared = this.src?.get?.(name); } catch (e) {
      // One material failing to bake must not take the whole circuit with it.
      console.warn('[track] shared material "' + name + '" unavailable, using fallback', e);
    }
    // A standard material with no albedo map is the boot placeholder;
    // rendering flat grey would fail the art bible outright, so prefer ours.
    if (shared && shared.map) return shared;
    return this.own(name, make);
  }

  /**
   * A material the track owns outright. Used only where the shared library
   * cannot help: anything that needs vertex colours (it enables them nowhere)
   * — the four-way terrain blend, and the black/white start-line checker.
   */
  own(name: string, make: () => THREE.Material): THREE.Material {
    let m = this.cache.get(name);
    if (!m) { m = make(); m.name = 'track-' + name; this.cache.set(name, m); }
    return m;
  }

  /**
   * As `get()`, but guaranteed to consume the mesh's vertex colours.
   *
   * The shared library enables `vertexColors` nowhere, which is fine for a wall
   * or a roof but fatal for a road: the racing line, the shoulder grime, the
   * beach sand drift and the kerb's joint dirt are all *masks the track owns*
   * and they have nowhere else to live. A per-metre mask cannot be baked into a
   * 3.5 m tiling texture by definition. So we take a clone — textures are
   * shared, so this costs one extra program, not one extra texture set — and
   * flip the flag on the copy rather than mutating a material somebody else may
   * hold a reference to.
   *
   * `Material.copy()` walks a fixed property list that `onBeforeCompile` is not
   * on, so the library's tiling-breakup and distance-settle injections have to
   * be carried across by hand or the clone renders with a visible 3.5 m repeat.
   * Three folds `vertexColors` into the program cache key itself, so the bound
   * `customProgramCacheKey` cannot collide the two variants onto one program.
   */
  vc(name: string, make: () => THREE.Material, extra?: (m: THREE.Material) => void): THREE.Material {
    const key = name + (extra ? '|vc+x' : '|vc');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const base = this.get(name, make) as THREE.MeshStandardMaterial;
    if (base.vertexColors && !extra) return base; // our own fallbacks already do
    const c = base.clone();
    const before = (base as any).onBeforeCompile;
    if (before && before !== THREE.Material.prototype.onBeforeCompile) {
      c.onBeforeCompile = before.bind(base);
      c.customProgramCacheKey = base.customProgramCacheKey.bind(base);
    }
    c.vertexColors = true;
    c.name = (base.name || name) + '-vc';
    // Track-owned shader work rides on the *clone*, never on the shared original:
    // the library hands the same material to walls, props and the minimap, and a
    // road-specific distance fade has no business on any of them.
    if (extra) extra(c);
    c.needsUpdate = true;
    this.cache.set(key, c);
    this.clones.push(c);
    return c;
  }

  /** Metres of world one texture tile of `name` covers. Drives every UV here. */
  scale(name: string, fallback: number): number {
    const s = this.src?.worldScale?.(name);
    return s && s > 0 ? s : fallback;
  }

  tune(s: TexSet, repeat: number) {
    for (const t of [s.map, s.normalMap, s.roughnessMap]) {
      t.repeat.set(repeat, repeat);
      t.anisotropy = this.aniso;
    }
    return s;
  }
}

/**
 * Fade a high-contrast repeating pattern toward its own tile average with view
 * distance, on a material clone the track owns.
 *
 * The kerb is the noisiest thing in every frame of round 1, and the cause is not
 * anisotropy — the shared library sets `anisotropy = min(8, maxAnisotropy)` on
 * every map it bakes, and it mips them all. The cause is that 500 mm red/white
 * bands are a *full-contrast* signal that stays full-contrast forever: the
 * library gives the tarmac a `settle` ramp (34→95 m, fading the fine octave into
 * a high mip) and gives the kerb none, so past ~40 m the stripe is being sampled
 * well under Nyquist with nothing damping it. Anisotropic filtering actively
 * makes that worse, because it holds a *low* mip at exactly the grazing angles a
 * chase camera lives at.
 *
 * So: lerp albedo toward the tile mean — a flat pink-grey — over the same
 * distance band. Near kerbs keep every stripe; far kerbs go smooth instead of
 * fizzing. Costs one varying and one mix.
 */
function injectDistanceFlatten(mat: THREE.Material, near: number, far: number, mean: THREE.Color) {
  const uFade = { value: new THREE.Vector2(near, far) };
  const uMean = { value: mean.clone() };
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(mat, shader, renderer);
    shader.uniforms.uFlatFade = uFade;
    shader.uniforms.uFlatMean = uMean;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFlatD;')
      // mvPosition is in scope straight after project_vertex, instancing included
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFlatD = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vFlatD;\nuniform vec2 uFlatFade;\nuniform vec3 uFlatMean;',
      )
      // after color_fragment diffuseColor is albedo × vertex colour and nothing
      // else has happened to it yet, which is exactly where a mip-style fade goes
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' +
          'diffuseColor.rgb = mix( diffuseColor.rgb, uFlatMean,\n' +
          '  smoothstep( uFlatFade.x, uFlatFade.y, vFlatD ) );',
      );
  };
  const tag = `|flat${near}_${far}`;
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + tag;
}

/**
 * Per-vertex roughness offset, from an `aRough` float attribute.
 *
 * Bible §4 makes spatially varying roughness mandatory and §9.3 counts distinct
 * surface responses per frame; a vertex colour reaches albedo and nothing else,
 * so without this the road's only gloss break in 1.6 km is the single material
 * seam at the edge of the racing-line group. One attribute, one varying, one
 * add — no texture, no draw call, no extra state.
 *
 * The insertion point is `lights_physical_fragment` rather than the more obvious
 * `roughnessmap_fragment`, because the shared library's own tarmac injection
 * already rewrites that chunk (it clamps a roughness floor and settles roughness
 * with distance) and a `replace` against a chunk somebody else has consumed is a
 * silent no-op. `lights_physical_fragment` is the chunk that actually *reads*
 * `roughnessFactor`, so landing immediately before it composes correctly with
 * whatever the library did upstream, and is the last point at which it can.
 */
function injectVertexRoughness(mat: THREE.Material): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aRough;\nvarying float vRoughAdj;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvRoughAdj = aRough;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRoughAdj;')
      .replace('#include <lights_physical_fragment>',
        'roughnessFactor = clamp( roughnessFactor + vRoughAdj, 0.06, 1.0 );\n'
        + '#include <lights_physical_fragment>');
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|vrough';
}

/**
 * Everything the *road* wants on top of a shared tarmac material, on the clone
 * the track owns.
 *
 * The normal-scale lift is a partial answer to the review's "the 36 mm chipping
 * dissolves by 8 m and leaves a visible transition band". The band itself is the
 * shared library's distance-settle ramp fading the fine octave into a high mip,
 * and its schedule lives in Materials — see the report. What the track can do
 * from here is start the ramp from more relief than it did, which pushes the
 * distance at which the aggregate stops resolving out by roughly the same
 * factor. Only the road gets it: 1.2× on a wall or a bridge soffit would just be
 * a noisier wall.
 */
function roadSurfaceExtra(mat: THREE.Material): void {
  const m = mat as THREE.MeshStandardMaterial;
  if (m.normalScale) m.normalScale.multiplyScalar(1.2);
  injectVertexRoughness(mat);
}

/**
 * Matte-out mask for the road-decal layer, from an `aMatte` float attribute.
 *
 * ROUND-1 BUG, and the cause of the "two crisp reddish-brown lines crossing the
 * banked corner in a long X" that the review read as a mesh seam. They are not a
 * seam: they are the two longitudinal paving cold joints, drawn at ±half the
 * road width, which is exactly the pair of converging lines the frame shows.
 * They are authored *dark* — `C_TAR` is 0.033 linear — so the mystery was why
 * they came out bright and chunky.
 *
 * They come out bright because the whole decal layer shares `road-paint`, which
 * carries an aggregate normal map and roughness 0.44. On a 110 mm wide ribbon
 * the UV derivative across the strip is two orders of magnitude smaller than it
 * is along it, so the sampler holds the sharpest mip of a full-amplitude normal
 * map on a two-pixel-wide line — and a 14° key raking across that is a string of
 * specular glints, at full brightness, added on top of whatever the alpha blend
 * left of the road. The tint is dark; the *highlight* is not, and on a banked
 * surface pointed near the sun the highlight is all you see.
 *
 * A cold joint is a groove full of old bitumen. It has no relief the camera can
 * resolve and it is the matte-est thing on the road. So: where `aMatte` is 1,
 * drop the normal-map perturbation back to the interpolated surface normal and
 * push roughness to 0.94. Costs one attribute and two mixes, keeps the layer at
 * one draw call, and it applies to every `C_TAR` family at once — the cold
 * joints, the transverse construction joints and the patch beads all had it.
 */
function injectDecalMatte(mat: THREE.Material): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aMatte;\nvarying float vMatte;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMatte = aMatte;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMatte;')
      // `normal` at this point is the interpolated (and side-corrected) surface
      // normal; normal_fragment_maps is what perturbs it by the map
      .replace('#include <normal_fragment_maps>',
        'vec3 mtN = normal;\n#include <normal_fragment_maps>\n'
        + 'normal = normalize( mix( normal, mtN, vMatte ) );')
      .replace('#include <lights_physical_fragment>',
        'roughnessFactor = mix( roughnessFactor, 0.94, vMatte );\n'
        + '#include <lights_physical_fragment>');
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|matte';
}

/** DoubleSide variant that never mutates a material somebody else may own. */
function twoSided(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.side = THREE.DoubleSide;
  // Material.clone() drops shader injection, and the shared library leans on
  // it for triplanar projection and tile breakup — carry both across.
  (c as any).onBeforeCompile = (m as any).onBeforeCompile;
  (c as any).customProgramCacheKey = (m as any).customProgramCacheKey;
  return c;
}

// --- individual fallback material factories --------------------------------

/**
 * Fallback tarmac. `racingLine` bakes the *worn* variant: base roughness 0.55
 * against 0.72, flatter relief, and rubber smeared along the direction of
 * travel. That gloss step is the whole point — the mesh's vertex colours can
 * darken the line's albedo but they cannot touch its roughness, so if the two
 * materials were identical (as they were in round 1) the line would come out as
 * paint rather than as polish.
 */
function tarmacMaterial(lib: MatLib, racingLine = false): THREE.Material {
  const base = racingLine ? 0.55 : 0.72;
  const s = bakeTexSet(1024,
    (u, v) => (fbm(u * 46, v * 46, 4) * 0.55 + tn2(u * 128, v * 128) * 0.22
      + fbm(u * 4.3, v * 4.3, 3) * 0.4) * (racingLine ? 0.62 : 1),
    (u, v, h, out) => {
      const patch = fbm(u * 3.1 + 11, v * 3.1 + 11, 3);
      out.copy(racingLine ? C_RACE : C_TARMAC).multiplyScalar(1 + h * 0.34 + patch * 0.14);
      // bitumen sheen streaks at a non-integer scale break the tile repeat
      out.lerp(_c2.copy(C_TARMAC).multiplyScalar(1.5), Math.max(0, tn2(u * 2.1, v * 0.31)) * 0.18);
      // rubber laid down along V, i.e. along the direction of travel
      if (racingLine) out.lerp(_c2.setRGB(0.14, 0.135, 0.15), Math.max(0, fbm(u * 14, v * 3, 3)) * 0.3);
    },
    (u, v, h) => base - h * 0.14 + fbm(u * 7.7 + 3, v * 7.7 + 3, 2) * 0.09
      - (racingLine ? Math.max(0, fbm(u * 14, v * 3, 3)) * 0.1 : 0),
    racingLine ? 16 : 26,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0,
    vertexColors: true,
    normalScale: new THREE.Vector2(racingLine ? 0.55 : 0.9, racingLine ? 0.55 : 0.9),
  });
}

function cobbleMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(1024,
    (u, v) => {
      const b = brickField(u, v, 16, 22, 0.5);
      return Math.max(0, 1 - b.d * b.d) * (0.85 + b.id * 0.15) + fbm(u * 60, v * 60, 3) * 0.12;
    },
    (u, v, h, out) => {
      const b = brickField(u, v, 16, 22, 0.5);
      out.setHex(0x9a8f7e).lerp(_c2.setHex(0x7d7466), b.id);
      out.multiplyScalar(0.82 + h * 0.4);
      out.lerp(_c2.setHex(0x615b52), ss(0.78, 0.99, b.d));
    },
    (u, v, h) => {
      const b = brickField(u, v, 16, 22, 0.5);
      // stone tops polish under traffic; the mortar joints stay matte
      return 0.86 - (1 - ss(0.7, 1.0, b.d)) * 0.28 + h * 0.05;
    },
    34,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0,
    vertexColors: true, normalScale: new THREE.Vector2(1.15, 1.15),
  });
}

/**
 * Metres of world one cobble tile covers.
 *
 * The library declares 2.4 m — twelve setts across, so 200 mm, which is what a
 * sett physically is and is the right number for a walking camera. It is the
 * wrong number for a chase camera at 90 km/h: at 25 m a 200 mm sett is four
 * pixels of a 1080p frame and the *joint* between two of them is one, so the
 * whole village street resolves into a field of one-pixel highlights that
 * crawls with every frame of camera motion. That is exactly what the drift and
 * wide frames show.
 *
 * 2.85 m is 238 mm setts — still a real sett, a third of an octave further from
 * the point where the joint goes sub-pixel, and chunkier, which is the arcade
 * read anyway. It is deliberately not a round multiple of anything: the
 * library's world-space macro breakup runs at 13.9 m and 4.4 m, and a tile size
 * that divided either of those would put the two patterns back in phase.
 */
function cobbleUvScale(lib: MatLib): number {
  return lib.scale('cobblestone', 2.4) * 1.19;
}

/**
 * The cobble as the *track* uses it: vertex colours, plus the two things the
 * shared material does not carry and cannot be asked to, because it is also on
 * the village squares and the quay where neither applies.
 *
 * **1. Geometric specular anti-aliasing.** The library's own `std()` takes a
 * `specAA` flag and the tarmac sets it; `buildCobble` does not. A sett map is
 * ~180 dome edges per tile at full normal strength, which is a far harsher
 * normal-curvature signal than 36 mm chippings, so the surface that most needs
 * the term is the one shipping without it. This is a Toksvig-style widening:
 * measure how fast the shaded normal is changing across the pixel footprint and
 * fold that variance into roughness, so a normal that swings a long way inside
 * one pixel is shaded as a rougher surface rather than as a mirror pointed in
 * an arbitrary direction. It is the only thing that actually kills edge crawl —
 * mip filtering cannot, because the aliasing is in the *lighting response*, not
 * in the texture fetch.
 *
 * **2. A second detail octave at 1/2.37.** Straight off the note. The library's
 * breakup layer works in world space at 13.9 m and 4.4 m, which is macro tone;
 * what is missing is a decade between that and the 238 mm sett, and without it
 * every sett in a 2.85 m tile has an identical twin 2.85 m away in both axes.
 * Re-reading the albedo and roughness maps at 1/2.37 of the rate — irrational
 * against the tile, so it never comes back into phase — lands a *different*
 * sett's tone and gloss on top of each one. Two extra fetches, on the one
 * material group that needs them.
 *
 * Both ride on the clone. Nothing here touches the shared material, which is
 * still exactly what the village walls and squares asked the library for.
 */
function injectCobbleDetail(mat: THREE.Material) {
  // x: second-octave UV rate, y: its albedo weight, z: its roughness weight
  const uD = { value: new THREE.Vector3(1 / 2.37, 0.34, 0.30) };
  // x: variance gain, y: the most roughness² the AA term may add
  const uAA = { value: new THREE.Vector2(0.62, 0.16) };
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(mat, shader, renderer);
    shader.uniforms.uCobDetail = uD;
    shader.uniforms.uCobAA = uAA;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCobDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCobDist = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uCobDetail;\nuniform vec2 uCobAA;\n' +
          'varying float vCobDist;\nfloat gCobD = 0.0;\n',
      )
      // `color_fragment` survives the library's own injection (which consumes
      // map_fragment, roughnessmap_fragment and normal_fragment_maps), and at
      // this point diffuseColor is albedo × vertex colour with nothing else
      // applied — the right place for a detail octave.
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        #ifdef USE_MAP
        {
          // rotated as well as rescaled: an axis-aligned second octave still
          // shares the first one's row and column directions, and two lattices
          // in the same orientation read as one moiré rather than as breakup
          vec2 ruv = mat2( 0.857, -0.515, 0.515, 0.857 ) * vMapUv * uCobDetail.x + 0.317;
          const vec3 kLum = vec3( 0.299, 0.587, 0.114 );
          float dtl = dot( texture2D( map, ruv ).rgb, kLum );
          // Referenced against the map's *own* mean — a high mip of the same
          // fetch — rather than against a hand-typed constant, so the octave is
          // a true ±0 modulation whatever albedo the shared library hands over
          // and cannot quietly turn into a global tint when that map changes.
          float ref = dot( textureLod( map, ruv, 7.0 ).rgb, kLum ) + 1e-4;
          gCobD = clamp( dtl / ref - 1.0, -0.85, 0.85 );
          // ...and faded out with distance, because past the point where the
          // second octave is itself sub-pixel it is no longer breaking up a
          // pattern, it is just adding noise to a mip that had settled
          gCobD *= 1.0 - smoothstep( 45.0, 120.0, vCobDist );
          diffuseColor.rgb *= 1.0 + gCobD * uCobDetail.y;
        }
        #endif`,
      )
      // roughnessFactor is declared by the roughness block and is still live
      // here; metalnessmap_fragment is untouched by every injection upstream
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n' +
          'roughnessFactor = clamp( roughnessFactor * ( 1.0 + gCobD * uCobDetail.z ), 0.06, 1.0 );',
      )
      // last stop before the BRDF, where `normal` is final and roughnessFactor
      // has not yet been copied into `material`
      .replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `{
          vec3 dnx = dFdx( normal );
          vec3 dny = dFdy( normal );
          float variance = uCobAA.x * ( dot( dnx, dnx ) + dot( dny, dny ) );
          float kernel = min( variance, uCobAA.y );
          roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor + kernel ) );
        }
        #include <lights_physical_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|cobdtl';
}

/**
 * Sett-course domain warp, in metres of lateral / arc length.
 *
 * Setts are laid in courses that arc and wander; a rectilinear UV grid lays them
 * in dead-straight ranks parallel to the kerb and square to the direction of
 * travel, which is precisely the "identical stones marching to the horizon"
 * read the critique names. Two decorrelated ~50 m octaves push the
 * parameterisation around by up to ±0.6 m, so the tile lattice never lands on a
 * screen-space grid and the courses bend the way a paviour would have laid them.
 * Smooth and C1 at the 1 m and 1.5 m ring spacings the two callers use, so it
 * deforms the courses without shearing a single sett.
 *
 * Lives here because the road ribbon and the flush apron both emit cobble and
 * they weld to each other: a warp on one and not the other is a 0.6 m step in
 * the sett courses down the whole village kerb line.
 */
const _warp = { u: 0, v: 0 };
function cobbleWarp(dist: number, lat: number) {
  _warp.u = lat + tn2(dist * 0.021 + 3.1, lat * 0.021) * 0.60;
  _warp.v = dist + tn2(dist * 0.017 + 41, lat * 0.026 + 7) * 0.55;
  return _warp;
}

/** The road/apron cobble material: shared map, track-owned detail and spec AA. */
function cobbleVc(lib: MatLib): THREE.Material {
  return lib.vc('cobblestone', () => cobbleMaterial(lib), (m) => {
    // The relief that survives to 40 m is macro form, not 4 mm of dome. Trimming
    // it here is the cheap half of the crawl fix and it costs no instructions;
    // the spec-AA term is the half that handles what is left.
    const sm = m as THREE.MeshStandardMaterial;
    if (sm.normalScale) sm.normalScale.multiplyScalar(0.78);
    injectCobbleDetail(m);
  });
}

/**
 * Fallback kerb. The red/white banding is baked into the map along V at four
 * bands per tile, matching the shared library's pitch — the mesh's vertex
 * colours now carry joint dirt and rubber wear instead of the stripe, so if the
 * stripe were not in the texture there would be no stripe at all.
 *
 * The band boundary is deliberately softened over ~2 texels. A hard step
 * between `#e0453f` and `#f2ece0` is a full-contrast edge with nothing for the
 * mip chain to average, and at the grazing angles a racing camera lives at that
 * is precisely what crawls.
 */
function kerbMaterial(lib: MatLib): THREE.Material {
  const size = 512;
  const bands = 4;
  const soft = 2.5 / (size / bands);   // ≈2 texels of transition
  /** 0 in the middle of a red band, 1 in a white one, blended at the seams */
  const bandAt = (v: number) => {
    const f = v * bands;
    const i = Math.floor(f), frac = f - i;
    const t = ss(0, soft, Math.min(frac, 1 - frac));
    return ((i & 1) ? 1 : 0) * t + 0.5 * (1 - t);
  };
  const s = bakeTexSet(size,
    (u, v) => {
      const chip = Math.max(0, fbm(u * 26 + 5, v * 26 + 5, 3));
      return fbm(u * 30, v * 30, 3) * 0.42 + tn2(u * 110, v * 110) * 0.16 - chip * 0.3;
    },
    (u, v, h, out) => {
      const w = bandAt(v);
      out.copy(C_KERB_R).lerp(C_KERB_W, w);
      // worn patches where the aggregate under the paint shows through
      const chip = ss(0.35, 0.72, fbm(u * 26 + 5, v * 26 + 5, 3) + 0.5);
      out.lerp(_c2.setRGB(0.36, 0.34, 0.31), chip * 0.55);
      out.multiplyScalar(0.88 + h * 0.24);
      // rubber scuffs where karts have clipped the kerb
      out.lerp(_c2.setRGB(0.15, 0.145, 0.16), Math.max(0, tn2(u * 5.5, v * 1.7)) * 0.34);
    },
    (u, v, h) => {
      // fresh paint is smooth; where it has chipped off, bare concrete is not
      const chip = ss(0.35, 0.72, fbm(u * 26 + 5, v * 26 + 5, 3) + 0.5);
      return 0.42 + chip * 0.44 + h * 0.16 + Math.max(0, tn2(u * 6, v * 2)) * 0.12;
    },
    26,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
    normalScale: new THREE.Vector2(1.1, 1.1),
  });
}

/**
 * World-space macro breakup for the track-owned terrain surfaces.
 *
 * These two materials are baked as ONE tile and then repeated across a terrain
 * mesh 1.2 km on a side. Every tile is identical, so at any distance where more
 * than a few tiles are on screen the whole hillside collapses to a single flat
 * tone — which is exactly how the terrain behind the circuit reads. The tile
 * cannot fix this: a feature authored into a 30 m tile IS 30 m, and repeats
 * every 30 m.
 *
 * So the low frequencies are added here instead, in world space, where they are
 * genuinely 30-120 m across and do not repeat with the tile. Two decorrelated
 * octaves drive albedo and roughness separately — correlating them just makes
 * one pattern twice as obvious.
 *
 * Cost: no geometry, no texture, no draw call, ~20 ALU in the fragment shader.
 */
function injectTerrainMacro(mat: THREE.Material, amount = 1): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMacroWP;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMacroWP = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vMacroWP;
float mcHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float mcNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mcHash(i), mcHash(i + vec2(1.0, 0.0)), u.x),
             mix(mcHash(i + vec2(0.0, 1.0)), mcHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float mcFbm(vec2 p) {
  return mcNoise(p) * 0.62 + mcNoise(p * 2.17 + 19.3) * 0.38;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  // ~95 m and ~34 m: the scale of a whole slope face and of a bench on it.
  float mA = mcFbm(vMacroWP.xz * 0.0105);
  float mB = mcNoise(vMacroWP.xz * 0.0295 + 41.7);
  float tint = (mA - 0.5) * 0.34 + (mB - 0.5) * 0.16;
  diffuseColor.rgb *= 1.0 + tint * ${amount.toFixed(3)};
  // Warm the risen ground and cool the hollows a touch, so the drift is a
  // change of light on the land rather than a change of exposure.
  diffuseColor.r *= 1.0 + tint * 0.22 * ${amount.toFixed(3)};
  diffuseColor.b *= 1.0 - tint * 0.20 * ${amount.toFixed(3)};
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
{
  // Decorrelated from the albedo field on purpose — same period, different
  // phase, so the sheen does not simply trace the colour.
  float mR = mcFbm(vMacroWP.xz * 0.0138 + 7.3);
  roughnessFactor = clamp(roughnessFactor * (1.0 + (mR - 0.5) * 0.42 * ${amount.toFixed(3)}), 0.05, 1.0);
}`,
      );
  };
  mat.customProgramCacheKey = () => `terrain-macro-${amount}`;
  mat.needsUpdate = true;
}

function groundMaterial(lib: MatLib): THREE.Material {
  // Neutral detail: hue arrives on vertex colours, so grass, sand, dirt and
  // rock all share one draw call while still reading as different surfaces.
  const s = bakeTexSet(512,
    (u, v) => fbm(u * 22, v * 22, 5) * 0.6 + fbm(u * 96, v * 96, 2) * 0.25,
    (u, v, h, out) => {
      const t = (1 / GROUND_GAIN) * (1 + h * 0.62);
      out.setRGB(t, t * 1.02, t * 0.95);
      out.multiplyScalar(1 + fbm(u * 6.1 + 40, v * 6.1 + 40, 3) * 0.18);
    },
    (u, v, h) => 0.88 - h * 0.16 + fbm(u * 12 + 9, v * 12 + 9, 2) * 0.08,
    30,
  );
  lib.tune(s, 1);
  const mat = new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
  });
  injectTerrainMacro(mat, 1);
  return mat;
}

function rockMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(512,
    (u, v) => {
      const r = 1 - Math.abs(tn1(u * 9, v * 9));
      const strata = Math.sin(v * Math.PI * 14 + fbm(u * 3, v * 3, 3) * 3) * 0.12;
      return r * r * 0.7 + fbm(u * 34, v * 34, 4) * 0.35 + strata;
    },
    (u, v, h, out) => {
      out.copy(C_STONE).multiplyScalar(0.78 + h * 0.5);
      out.lerp(_c2.setHex(0x7d6f5d), ss(0.1, 0.7, fbm(u * 5 + 21, v * 5 + 21, 3) + 0.5) * 0.35);
    },
    (u, v, h) => 0.80 - h * 0.18 + fbm(u * 16 + 5, v * 16 + 5, 2) * 0.1,
    42,
  );
  lib.tune(s, 1);
  const mat = new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0,
    vertexColors: true, normalScale: new THREE.Vector2(1.3, 1.3),
  });
  // The bore is the same material and is a 6 m tunnel, not a 1 km hillside, so
  // it gets a lighter dose — enough to break the repeat, not enough to read as
  // weather inside a cave.
  injectTerrainMacro(mat, 0.6);
  return mat;
}

function stoneMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(512,
    (u, v) => {
      const b = brickField(u, v, 8, 14, 0.5);
      return (1 - ss(0.86, 1.0, b.d)) * (0.6 + b.id * 0.25) + fbm(u * 48, v * 48, 4) * 0.3;
    },
    (u, v, h, out) => {
      const b = brickField(u, v, 8, 14, 0.5);
      out.copy(C_STONE).multiplyScalar(0.84 + b.id * 0.18 + h * 0.28);
      out.lerp(_c2.setHex(0x87796a), ss(0.86, 1.0, b.d) * 0.7);
    },
    (u, v, h) => 0.74 + h * 0.12 + fbm(u * 20 + 7, v * 20 + 7, 2) * 0.1,
    36,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0,
    vertexColors: true, normalScale: new THREE.Vector2(1.2, 1.2),
  });
}

function metalMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(256,
    (u, v) => fbm(u * 4, v * 90, 3) * 0.5 + tn2(u * 40, v * 40) * 0.15,
    (u, v, h, out) => {
      out.setRGB(0.60, 0.62, 0.65).multiplyScalar(0.85 + h * 0.3);
      out.lerp(_c2.setHex(0x8a5a3a), Math.max(0, fbm(u * 7 + 60, v * 7 + 60, 3)) * 0.4);
    },
    (u, v, h) => 0.32 + Math.max(0, fbm(u * 7 + 60, v * 7 + 60, 3)) * 0.42 + h * 0.08,
    18,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0.8, vertexColors: true,
  });
}

/**
 * Road paint — edge lines, the start/finish checker, grid boxes and the worn
 * asphalt decals, all one draw call driven by vertex colour and vertex alpha.
 *
 * Three things the round-1 checker was missing, in order of how loudly they
 * read:
 *
 *  • It is `#f2ece0`, never `#ffffff`. The bible forbids the latter outright
 *    and a tone-mapped `1.0` albedo under a 4.2 key clips to a flat white slab
 *    with no shading information left in it at all.
 *  • Alpha. Real line paint is 200 µm of thermoplastic over a 36 mm chipping,
 *    so the aggregate reads *through* it. Vertex alpha lets each quad choose
 *    how thick its paint is, which is what makes wheel-track wear possible.
 *  • Roughness 0.44 against the tarmac's 0.72. Under a 14° key that gloss step
 *    is what separates the paint from the road at a glance, and it is one of
 *    the five distinct surface responses the frame has to show.
 */
function paintMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(256,
    (u, v) => fbm(u * 40, v * 40, 3) * 0.4 + fbm(u * 150, v * 150, 2) * 0.2,
    (u, v, h, out) => {
      out.copy(C_PAINT).multiplyScalar(0.9 + h * 0.18);
      // aggregate showing through thin paint: the same chipping scale the
      // tarmac uses, so the two surfaces agree about the stone underneath
      const agg = Math.max(0, tn2(u * 96, v * 96));
      out.lerp(_c2.copy(C_TARMAC).multiplyScalar(1.35), agg * 0.22);
      // scuff and road film, so no two squares of the checker are the same
      out.multiplyScalar(1 - Math.max(0, fbm(u * 9 + 23, v * 9 + 23, 3)) * 0.14);
    },
    (u, v, h) => 0.44 + h * 0.20 + Math.max(0, fbm(u * 11 + 4, v * 11 + 4, 2)) * 0.14,
    18,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
    transparent: true, depthWrite: true,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
}

function boostMaterial(): THREE.Material {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const f = (v * 3) % 1;                       // three chevrons per tile
      const chev = 1 - ss(0.0, 0.15, Math.abs(Math.abs(u - 0.5) * 1.5 - f + 0.32));
      const edge = 1 - ss(0.40, 0.5, Math.abs(u - 0.5));
      const a = chev * edge;
      const o = (y * size + x) * 4;
      data[o] = 255; data[o + 1] = 168 + a * 78; data[o + 2] = 70 + a * 90;
      data[o + 3] = Math.min(255, a * 235 + 30);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return new THREE.MeshStandardMaterial({
    map: t, emissiveMap: t, emissive: 0xffa03c, emissiveIntensity: 2.4,
    transparent: true, roughness: 0.4, metalness: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
}

function seaMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(256,
    (u, v) => fbm(u * 8, v * 8, 4) * 0.5 + fbm(u * 26, v * 26, 3) * 0.3,
    (u, v, h, out) => { out.setHex(0x0d5a7a).lerp(_c2.setHex(0x2f9fae), ss(-0.2, 0.35, h)); },
    () => 0.05,
    9,
  );
  lib.tune(s, 200);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0.2,
    normalScale: new THREE.Vector2(0.32, 0.32),
  });
}

function lightMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: 0x2a2016, emissive: 0xffb35a, emissiveIntensity: 7, roughness: 0.5, metalness: 0,
  });
}

// ===========================================================================
//  Buffer helpers
// ===========================================================================

interface Buf {
  pos: number[]; nor: number[]; uv: number[]; col: number[]; idx: number[];
  tan?: number[];
  /** when present the colour attribute goes out as RGBA and drives paint opacity */
  alpha?: number[];
  /** when present, goes out as `aMatte` — see `injectDecalMatte` */
  matte?: number[];
}
function newBuf(withTangents = false, withAlpha = false, withMatte = false): Buf {
  return {
    pos: [], nor: [], uv: [], col: [], idx: [],
    tan: withTangents ? [] : undefined,
    alpha: withAlpha ? [] : undefined,
    matte: withMatte ? [] : undefined,
  };
}
function finish(b: Buf): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = b.pos.length / 3;
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  if (b.alpha) {
    // three switches the vColor varying to vec4 when the colour attribute has
    // four components, which is how the paint gets a per-vertex opacity without
    // a second attribute or a custom shader.
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = b.col[i * 3];
      rgba[i * 4 + 1] = b.col[i * 3 + 1];
      rgba[i * 4 + 2] = b.col[i * 3 + 2];
      rgba[i * 4 + 3] = b.alpha[i];
    }
    g.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  } else {
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  }
  if (b.tan && b.tan.length) g.setAttribute('tangent', new THREE.Float32BufferAttribute(b.tan, 4));
  if (b.matte) g.setAttribute('aMatte', new THREE.Float32BufferAttribute(b.matte, 1));
  g.setIndex(n > 65000 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
  g.computeBoundingSphere();
  return g;
}
function pushV(b: Buf, x: number, y: number, z: number, nx: number, ny: number, nz: number,
  u: number, v: number, c: THREE.Color, a = 1, matte = 0) {
  b.pos.push(x, y, z); b.nor.push(nx, ny, nz); b.uv.push(u, v); b.col.push(c.r, c.g, c.b);
  if (b.alpha) b.alpha.push(a);
  if (b.matte) b.matte.push(matte);
}
/** counter-clockwise quad v0→v1→v2→v3 */
function quad(b: Buf, v0: number, v1: number, v2: number, v3: number) {
  b.idx.push(v0, v1, v2, v0, v2, v3);
}

// ===========================================================================
//  Entry point
// ===========================================================================

export function buildTrackGeometry(track: Track, ctx: Ctx) {
  const lib = new MatLib(ctx);
  const g = track.group;
  g.name = 'circuit';
  buildRoad(track, lib, g);
  buildKerbs(track, lib, g);
  buildMarkings(track, lib, g);
  buildBoostPads(track, lib, g);
  buildCornerBoards(track, lib, g);
  buildSkirt(track, lib, g);
  buildTerrain(track, lib, g);
  buildSea(track, lib, g);
  buildBarriers(track, lib, g);
  buildTunnel(track, lib, g);
  buildBridge(track, lib, g);
  // anything we cloned out of the shared library is invisible to its own
  // update(), so Track has to hand those copies the env map itself
  track.registerEnvClones(lib.clones);
}

// ---------------------------------------------------------------------------
//  Road ribbon
// ---------------------------------------------------------------------------

/**
 * Lateral sample plan for a road ring.
 *
 * Nine of the seventeen samples are pinned to fixed offsets from the idealised
 * racing line, so the worn strip is a real feature of the mesh that follows the
 * spline rather than a staircase across fixed lateral bands. Two things ride on
 * that block of columns:
 *
 *  • Columns `RACE_A..RACE_B` (±1.15 m, so 2.3 m wide) are their own material
 *    group and get `tarmac-racing-line` — roughness 0.55 against the tarmac's
 *    0.72. That is a genuine *gloss* break, and it is the only part of this that
 *    can be one: a vertex colour multiplies albedo and nothing else.
 *  • The mask in `LINE_MASK` feathers out to zero by ±2.6 m and rides on the
 *    vertex colour, pulling albedo from `#4a4a52` down to `#3e3e48`.
 *
 * Deliberately the albedo footprint (5.2 m) is wider than the gloss core
 * (2.3 m). A racing line has no edge to its staining but a fairly defined edge
 * to its polish, and building it that way round means the hard material seam
 * lands where the two albedos already agree — so it shows up as a hotter,
 * narrower highlight inside a soft dark band, and not as a seam.
 */
/*
 * ROUND-2 WIDTHS. The core was ±1.15 m (2.3 m of polish) against a road that is
 * now 10.8–17.6 m wide, i.e. 13–21% of the surface, and at that width the gloss
 * step simply did not survive to the camera in any of the ten round-1 frames —
 * the review's "that second surface response is not visible in a single frame".
 * A real racing line on a kart circuit is two karts wide, and the bible asks for
 * roughly 40% of the road. So: polish core ±2.7 m (5.4 m, 31–50% of width) and
 * the albedo stain feathering out to ±3.6 m (7.2 m), keeping the round-1 rule
 * that the stain is wider than the polish so the material seam lands inside the
 * dark band and reads as a hotter core rather than as an edge.
 */
const ROAD_NL = 19;
const LINE_K0 = 5;   // first column pinned to the racing line
const RACE_A = 6;    // first vertex of the polished core
const RACE_B = 12;   // last vertex of the polished core
/** offsets from the ideal line for columns LINE_K0 … LINE_K0+8 */
const LINE_OFFS = [-3.6, -2.7, -1.9, -1.0, 0, 1.0, 1.9, 2.7, 3.6];
const LINE_SPAN = 3.6;
/** where the albedo stain starts feathering out; the polish core ends at 2.7 */
const LINE_PLATEAU = 2.35;

/**
 * Lateral width of the contact band pinned against the kerb junction.
 *
 * Two extra columns (one per side) exist purely so the road can carry an
 * ambient-occlusion and dirt gradient in the last third of a metre before the
 * kerb. Without them the outermost quad row is 0.9–1.4 m wide and the narrowest
 * gradient the mesh can express at the junction is that same 1.4 m, which is a
 * soft wash and not a contact — so the setts butted into the kerb on a razor
 * with nothing bedding one into the other. The kerb has had a 60 mm contact-AO
 * gradient at its own foot since round 1 (`kerbWear`); this is the other half of
 * that joint, and a joint with AO on one side only reads worse than one with
 * none, because the step in value lands exactly on the seam.
 */
const EDGE_AO_W = 0.34;

const roadLats = new Float64Array(ROAD_NL);
const roadMask = new Float64Array(ROAD_NL);

function planRoadLats(hw: number, race: number) {
  // Keep the whole line block clear of the kerbs even where the cliff narrows.
  //
  // Soft-clamped, not `min`/`max`. On the old 26 m road the limit was 6–9 m and
  // `race` (which is `half * 0.52` at most) essentially never reached it, so a
  // hard clamp cost nothing. On a 5.4–8.8 m half-width it engages through most
  // of the corners, and a hard clamp is C0: the polished core of the racing line
  // is its own material group whose edges follow these columns, so a slope break
  // in the clamp is a visible kink in the gloss strip. `tanh` saturates at the
  // same limit without ever having a corner in it, and the 1.35 gain keeps the
  // unclamped case within 2% of the line the physics-side `race` channel says.
  const lim = Math.max(0, hw - LINE_SPAN - 1.4);
  const r = lim <= 1e-4 ? 0 : lim * Math.tanh((1.35 * race) / lim);
  for (let k = 0; k < LINE_OFFS.length; k++) {
    roadLats[LINE_K0 + k] = r + LINE_OFFS[k];
    roadMask[LINE_K0 + k] = 1 - ss(LINE_PLATEAU, LINE_SPAN, Math.abs(LINE_OFFS[k]));
  }
  const lo = roadLats[LINE_K0], hi = roadLats[LINE_K0 + LINE_OFFS.length - 1];
  const kHi = LINE_K0 + LINE_OFFS.length - 1;
  // The contact column can never cross the line block on the 5.4 m cliff ledge,
  // so it is pulled in from the edge but never past whatever room is left.
  const ao = Math.min(EDGE_AO_W, Math.max(0.05, (hw + lo) * 0.5), Math.max(0.05, (hw - hi) * 0.5));
  roadLats[0] = -hw;
  roadLats[1] = -hw + ao;
  for (let k = 2; k < LINE_K0; k++) {
    roadLats[k] = roadLats[1] + (lo - roadLats[1]) * ((k - 1) / (LINE_K0 - 1));
  }
  for (let k = 0; k < LINE_K0; k++) roadMask[k] = 0;
  roadLats[ROAD_NL - 1] = hw;
  roadLats[ROAD_NL - 2] = hw - ao;
  for (let k = kHi + 1; k < ROAD_NL - 2; k++) {
    roadLats[k] = hi + (roadLats[ROAD_NL - 2] - hi) * ((k - kHi) / (ROAD_NL - 2 - kHi));
  }
  for (let k = kHi + 1; k < ROAD_NL; k++) roadMask[k] = 0;
}

/** In-place circular box blur over a per-station signal. */
function blurStations(src: Float32Array, halfCells: number, passes: number) {
  const n = src.length;
  const tmp = new Float32Array(n);
  const w = 2 * halfCells + 1;
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let k = -halfCells; k <= halfCells; k++) sum += src[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / w;
      sum += src[(i + halfCells + 1) % n] - src[((i - halfCells) % n + n) % n];
    }
    src.set(tmp);
  }
}

/**
 * How hard the racing line is worn in at each station.
 *
 * Curvature, blurred over ~60 m of arc. The blur is what makes this read as a
 * racing line rather than as a stripe painted on the corners: it ramps the
 * staining up through the braking zone before the geometry starts turning and
 * lets it bleed out down the exit, which is where the rubber actually goes. The
 * 0.40 floor keeps a faint line down the straights — traffic does not stop
 * using one lane just because the road is straight.
 */
function raceWear(cl: Track['cl']): Float32Array {
  const w = new Float32Array(cl.count);
  for (let i = 0; i < cl.count; i++) w[i] = Math.min(1, Math.abs(cl.curv[i]) * 115);
  blurStations(w, Math.max(1, Math.round(30 / cl.ds)), 2);
  for (let i = 0; i < cl.count; i++) w[i] = 0.40 + 0.60 * Math.min(1, w[i] * 1.35);
  return w;
}

function buildRoad(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const rings = Math.round(cl.count / 3); // ~1.5 m rings
  const b = newBuf(true);
  const idxT: number[] = [];   // tarmac
  const idxR: number[] = [];   // worn racing line
  const idxC: number[] = [];   // cobblestone
  const rgh: number[] = [];    // per-vertex roughness offset (see below)
  const dP = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3();

  const sTar = lib.scale('tarmac', 3.5);
  const sCob = cobbleUvScale(lib);
  const wear = raceWear(cl);

  const emitRing = (si: number, dist: number, uvScale: number, cobble = false) => {
    const hw = cl.half[si];
    planRoadLats(hw, cl.race[si]);
    const base = b.pos.length / 3;
    // sand blows across the seaward lane through the beach descent only
    const sand = cl.zone[si] === Z_BEACH ? 1 : 0;
    for (let k = 0; k < ROAD_NL; k++) {
      const L = roadLats[k];
      track.crossPoint(si, L, _p);
      /*
       * MACRO OCTAVE (round 2). The tarmac map tiles at 3.5 m and the only
       * world-space terms the road carried were a 48 m and a 150 m wobble at ±7%
       * and ±5% — under a 14° key that is inside the aggregate's own noise floor,
       * which is why ten frames came back reading as "one flat value with one
       * constant roughness". These are the missing 18–30 m band, and crucially
       * one of them is *soft-stepped* rather than sinusoidal, so the road carries
       * resurfacing slabs with edges rather than a smooth wash that averages back
       * out to the same grey at any distance.
       *
       * `slab` is also what drives the roughness split below: a lane relaid last
       * season is both darker and smoother than the one beside it, and driving
       * both from one field is what keeps them describing the same surface.
       */
      const m22 = tn2(_p.x * 0.045 + 71, _p.z * 0.045 + 71);          // ~22 m
      const m31 = tn2(_p.x * 0.032 + 17, _p.z * 0.032 + 17);          // ~31 m
      const slab = ss(-0.16, 0.16, tn2(_p.x * 0.0155 + 43, _p.z * 0.0155 + 43)
        + tn2(_p.x * 0.061 + 5, _p.z * 0.061 + 5) * 0.22) * 2 - 1;    // ~64 m, edged
      // analytic normal: lateral surface direction crossed with the tangent
      const slope = track.roadSlope(si, L);
      dP.set(cl.bx[si], cl.by[si] + slope, cl.bz[si]).normalize();
      T.set(cl.tx[si], cl.ty[si], cl.tz[si]);
      N.crossVectors(dP, T).normalize();

      _c.copy(_white);
      // --- worn racing line: darker toward the palette's #3e3e48 -----------
      const line = roadMask[k] * wear[si];
      _c.lerp(C_RACE_MUL, line);
      // --- grime gradient off the shoulders --------------------------------
      const edge = ss(0.70, 1.0, Math.abs(L) / hw);
      _c.lerp(C_GRIME, edge * 0.30);
      // --- bleached outer lane ---------------------------------------------
      // Sun, salt and no traffic. This is the third albedo the review asked for
      // and it is the one the road most obviously lacked: a *lighter*, coarser
      // band outboard of the stained line, so the cross-section reads
      // pale-shoulder / dark-line / pale-shoulder instead of one tone edge to
      // edge. Deliberately not symmetric with `edge` above — that one is dirt
      // and sits right at the gutter, this is bleach and starts at 55% of the
      // half-width, so the two do not stack into one wash.
      const bleach = ss(0.55, 0.94, Math.abs(L) / hw) * (1 - line * 0.75);
      _c.lerp(C_BLEACH_MUL, bleach * (0.42 + m22 * 0.22));
      // --- pale silt washed into the gutter, in patches ---------------------
      // The bible asks for dust accumulation near the kerbs, and it earns its
      // place beyond that: a *lighter* term at the edge against the darker
      // racing line in the middle is what stops the whole 26 m of road reading
      // as one value with one noise on it.
      const gutter = ss(0.84, 1.02, Math.abs(L) / hw);
      _c.lerp(C_DUST_MUL, gutter * Math.max(0, tn2(_p.x * 0.031 + 5, _p.z * 0.031 + 5)) * 0.55);
      // --- sand drift on the seaward edge of the beach section -------------
      if (sand) {
        const drift = ss(0.34, 0.98, L / hw) * (0.55 + tn2(_p.x * 0.05, _p.z * 0.05) * 0.45);
        _c.lerp(C_SAND_MUL, Math.max(0, drift) * 0.75);
      }
      // metre-scale patch variation, at a scale the tiling breakup cannot reach
      _c.multiplyScalar(1 + tn2(_p.x * 0.021, _p.z * 0.021) * 0.07
        + tn2(_p.x * 0.0067 + 31, _p.z * 0.0067 + 31) * 0.05
        // the 18–30 m band, at an amplitude that survives tone mapping
        + m22 * 0.065 + m31 * 0.048 + slab * 0.070);
      // --- contact AO + dirt in the last 340 mm before the kerb junction -----
      // A hard, narrow term, deliberately much tighter than the `edge` wash
      // above: the wash says "this end of the road is dirtier", this says "the
      // road and the kerb are the same object where they touch". Value drop is
      // 0.30, which is the same order as the kerb's own foot AO on the other
      // side of the seam, so the two meet at roughly one value instead of
      // stepping across it.
      const contact = 1 - ss(0, EDGE_AO_W, hw - Math.abs(L));
      _c.lerp(C_JOINT_MUL, contact * 0.42);
      _c.multiplyScalar(1 - contact * 0.16);
      let u = L, v = dist;
      if (cobble) {
        const w = cobbleWarp(dist, L);
        u = w.u; v = w.v;
      }
      pushV(b, _p.x, _p.y, _p.z, N.x, N.y, N.z, u / uvScale, v / uvScale, _c);
      b.tan!.push(dP.x, dP.y, dP.z, 1);
      /*
       * ROUGHNESS, DRIVEN OFF THE SAME MACRO. Bible §4: "roughness must vary
       * spatially… a constant roughness is the #1 tell of an amateur real-time
       * scene", and §9.3 wants five distinct surface responses. A vertex colour
       * multiplies albedo and nothing else, so until now the *only* roughness
       * break anywhere on 1.6 km of road was the one material seam at the edge
       * of the polish core. This carries the rest of it: the same masks that
       * shape the albedo also shape the gloss, which is what makes them read as
       * one surface with a history rather than as a tint painted over a plane.
       *
       * Targets from the bible's material table, relative to the map's own base
       * (0.72 field, 0.55 inside the racing-line group):
       *   polished line   0.50   → −0.05 on top of the 0.55 map
       *   field           0.72   →  0
       *   coarse shoulder 0.80   → +0.08
       * plus ±0.035 of slab so no two lanes of the same nominal surface answer
       * the key light identically.
       */
      rgh.push(
        -line * 0.05
        + bleach * 0.085
        + edge * 0.03
        - contact * 0.06        // packed grime at the kerb joint is smoother
        + slab * 0.035 + m31 * 0.025,
      );
    }
    return base;
  };
  const stitch = (a0: number, a1: number, k0: number, k1: number, into: number[]) => {
    for (let k = k0; k < k1; k++) into.push(a0 + k, a0 + k + 1, a1 + k + 1, a0 + k, a1 + k + 1, a1 + k);
  };

  // --- tarmac pass: every ring, but only the non-cobble quad rows ---
  let prev = -1;
  for (let r = 0; r <= rings; r++) {
    const raw = Math.round((r * cl.count) / rings);
    const si = raw % cl.count;
    const ring = emitRing(si, raw * cl.ds, sTar);
    if (prev >= 0) {
      const prevSi = Math.round(((r - 1) * cl.count) / rings) % cl.count;
      if (cl.cobble[prevSi] < 0.5) {
        stitch(prev, ring, 0, RACE_A, idxT);
        stitch(prev, ring, RACE_A, RACE_B, idxR);
        stitch(prev, ring, RACE_B, ROAD_NL - 1, idxT);
      }
    }
    prev = ring;
  }
  // --- cobble pass: its own vertices so the setts get their own texel scale ---
  prev = -1;
  for (let r = 0; r <= rings; r++) {
    const raw = Math.round((r * cl.count) / rings);
    const si = raw % cl.count;
    const prevSi = r > 0 ? Math.round(((r - 1) * cl.count) / rings) % cl.count : si;
    const needs = cl.cobble[si] >= 0.5 || (r > 0 && cl.cobble[prevSi] >= 0.5);
    if (!needs) { prev = -1; continue; }
    const ring = emitRing(si, raw * cl.ds, sCob, true);
    if (prev >= 0 && cl.cobble[prevSi] >= 0.5) stitch(prev, ring, 0, ROAD_NL - 1, idxC);
    prev = ring;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  geo.setAttribute('tangent', new THREE.Float32BufferAttribute(b.tan!, 4));
  geo.setAttribute('aRough', new THREE.Float32BufferAttribute(rgh, 1));
  geo.setIndex(new THREE.Uint32BufferAttribute(idxT.concat(idxR, idxC), 1));
  geo.addGroup(0, idxT.length, 0);
  geo.addGroup(idxT.length, idxR.length, 1);
  geo.addGroup(idxT.length + idxR.length, idxC.length, 2);
  geo.computeBoundingSphere();

  // The `extra` argument gives these their own cache key, so the road's two
  // tarmac groups get the `aRough` program and the kerb apron — which shares the
  // *name* 'tarmac' but not the attribute — keeps the plain clone. Separate
  // meshes already, so this costs a program, not a draw call.
  const mesh = new THREE.Mesh(geo, [
    lib.vc('tarmac', () => tarmacMaterial(lib), roadSurfaceExtra),
    lib.vc('tarmac-racing-line', () => tarmacMaterial(lib, true), roadSurfaceExtra),
    cobbleVc(lib),
  ]);
  mesh.name = 'road';
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ---------------------------------------------------------------------------
//  Kerbs — a real 3D profile with chamfers, not a painted stripe
// ---------------------------------------------------------------------------

/**
 * Kerb wear at a point on the profile, as an albedo multiplier.
 *
 * Everything here is a *mask*, never a stripe: the red/white banding lives in
 * the kerb texture along V, and a second banding on the vertex colour would
 * beat against it. What the mesh contributes is the part a 2 m tiling texture
 * structurally cannot — where on the cross-section the dirt sits, and how the
 * rubber varies along a 1600 m run.
 */
function kerbWear(q: number, dist: number, hot: number, out: THREE.Color) {
  out.copy(_white);
  // Dirt and rubber packed into the joint, plus a hard 60 mm contact-AO gradient
  // right at the foot. Without the second term the kerb is a striped object
  // *resting on* the road rather than bedded into it, which is the "floating"
  // note — and AO in every contact point is not optional (bible §2).
  out.lerp(C_JOINT_MUL, (1 - ss(0.0, 0.14, q)) * 0.72);
  out.multiplyScalar(1 - (1 - ss(0.0, 0.06, q)) * 0.34);
  // Grime gradient up the outer face — the bottom 15% is where it collects, and
  // the gutter silts up worse on a straight than on a corner nobody misses.
  //
  // The `(1 - hot)` weight was 0.26, and `hot` is *inside*-of-corner curvature,
  // so the term was dirtying the outside kerb hardest — i.e. it was dimming
  // precisely the ribbon that draws the shape of the corner for a driver on the
  // entry. Still true to life, still there, but at 0.10 it grades the kerb
  // without taking the read-ahead cue out with it.
  out.lerp(C_GRIME, ss(1.40, KERB_W, q) * (0.44 + (1 - hot) * 0.10));
  // the bevel and the crown edge get scuffed pale by wheels riding over
  const polish = ss(0.20, 0.30, q) * (1 - ss(0.34, 0.44, q));
  out.multiplyScalar(1 + polish * 0.10 * (0.4 + hot));
  // Black rubber on the crown. `hot` is blurred inside-of-corner curvature, so
  // an apex kerb karts hammer goes black and a kerb on a straight stays clean —
  // which is the whole difference the round-1 kerb did not have.
  const smear = Math.max(0, tn2(dist * 0.031, q * 0.4)) * (0.35 + 0.65 * Math.max(0, tn2(dist * 0.0083 + 17, 5.5)));
  out.multiplyScalar(1 - smear * (0.16 + hot * 0.62) * ss(0.16, 0.30, q) * (1 - ss(1.30, 1.50, q)));
  // Paint bleached in slow patches so no two runs of kerb read the same value.
  // Two octaves at 33 m and 78 m — one alone is a beat you can count.
  out.multiplyScalar(0.97 + tn2(dist * 0.0302 + 61, 2.2) * 0.075 + tn2(dist * 0.0128 + 7, 5.1) * 0.10);
  // …and a slow *hue* drift on top of the value drift, ±5%, decorrelated from
  // both of them at 45 m. Paint fades warm on the sun side and goes green-grey
  // in the shade of the terraces, so a 1600 m run of kerb that is one red and
  // one white all the way round is the giveaway even once the value varies.
  // Two channels only: shifting all three is just the value octave again.
  const hue = tn2(dist * 0.0222 + 131, 8.7);
  out.r *= 1 + hue * 0.05;
  out.b *= 1 - hue * 0.045;
  // Ceiling. `#f2ece0` is already 0.89 linear and the map's own grime octave can
  // put it at 0.96; if the bleach and the bevel polish happen to peak on the same
  // vertex the product goes over 1.0, and an albedo over 1.0 under a 4.2 key
  // clips to the flat `#ffffff` the palette table forbids outright.
  clampMul(out, 0.16, 1.10);
}

/** Clamp a vertex-colour multiplier so it can neither crush nor clip its map. */
function clampMul(c: THREE.Color, lo: number, hi: number) {
  c.r = c.r < lo ? lo : c.r > hi ? hi : c.r;
  c.g = c.g < lo ? lo : c.g > hi ? hi : c.g;
  c.b = c.b < lo ? lo : c.b > hi ? hi : c.b;
}

/**
 * Stripe phase along the whole kerb run, in texture tiles, one entry per station
 * plus a closing entry for the wrap.
 *
 * ROUND-1 FAILURE, and the loudest amateur tell in the set: V was `dist / uvS`,
 * a straight ruled parameterisation, so a 2.6 m tile put *the same* float-face
 * grain, the same air voids and the same spall chips at the same place on every
 * fourth stripe for 1600 m. The eye locks onto a repeat at that pitch in about
 * a third of a second, and the kerb is the highest-contrast object in the near
 * field, so it locks onto this one first. Bible §4/§9.6: no visible tiling
 * repeat within a single camera frame.
 *
 * The kerb cannot be re-UV'd across its width the way the road can — its red and
 * white bands live along V and any V trick moves them. So the answer is to make
 * the pitch itself a function of arc length instead of a constant:
 *
 *  • A slow ±13% octave at ~80 m. That alone destroys the 1:1 correspondence:
 *    two runs of kerb 2.6 m apart no longer sit at the same fractional tile, so
 *    they no longer show the same grain.
 *  • +26% through the corners, which is a *gameplay* term as much as a graphics
 *    one — the review's separate note asks for a wider stripe pitch on corner
 *    entry so the turn direction reads at distance, and the blurred curvature
 *    this rides on leads the geometry by ~30 m, i.e. it opens up during the
 *    braking zone exactly as asked.
 *
 * The running total is then normalised to a whole number of tiles so the lap
 * closes on a band boundary; without that the run would show one hard red/red
 * seam at the start line.
 *
 * Stripes land between 560 and 830 mm. The bottom of that is still comfortably
 * above the pitch at which a stripe approaches Nyquist at the distance the
 * distance-flatten ramp takes over.
 */
function kerbVTable(cl: Track['cl'], uvS: number): Float32Array {
  const n = cl.count;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.min(1, Math.abs(cl.curv[i]) * 115);
  blurStations(curve, Math.max(1, Math.round(30 / cl.ds)), 2);
  const v = new Float32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    v[i] = acc;
    const d = i * cl.ds;
    const pitch = uvS * (1
      + 0.26 * Math.min(1, curve[i] * 1.35)
      + 0.13 * tn2(d * 0.0125, 3.3));
    acc += cl.ds / pitch;
  }
  v[n] = acc;
  // close the loop on a whole tile, i.e. on a band boundary
  const k = Math.max(1, Math.round(acc)) / acc;
  for (let i = 0; i <= n; i++) v[i] *= k;
  return v;
}

/**
 * How hard karts use the kerb at each station, per side, 0..1.
 *
 * Signed curvature says which side is the inside of the turn; blurring it over
 * ~34 m of arc spreads the wear through the entry and out down the exit, the
 * same reason `raceWear` blurs. The floor keeps a trace of rubber everywhere,
 * because a kart bouncing off a straight-line kerb still leaves some.
 */
function kerbHot(cl: Track['cl'], side: number): Float32Array {
  const w = new Float32Array(cl.count);
  for (let i = 0; i < cl.count; i++) {
    // curv < 0 turns left, so the inside kerb is the left (side = -1) one
    const inside = side < 0 ? -cl.curv[i] : cl.curv[i];
    w[i] = Math.min(1, Math.max(0, inside) * 150);
  }
  blurStations(w, Math.max(1, Math.round(17 / cl.ds)), 2);
  for (let i = 0; i < cl.count; i++) w[i] = 0.10 + 0.90 * Math.min(1, w[i] * 1.4);
  return w;
}

/**
 * Wear for the flush *apron* — the same 1.6 m corridor, at the stations where
 * `cl.kerb` is zero and there is therefore no kerb at all (the bridge deck runs
 * flush between its parapets). No stripe wear and no bevel polish, because the
 * profile there is flat: all that is left to say is that the edge of a deck
 * collects more dirt than the middle of the road.
 */
function apronWear(q: number, dist: number, _hot: number, out: THREE.Color) {
  out.copy(_white);
  out.lerp(C_JOINT_MUL, (1 - ss(0.0, 0.20, q)) * 0.40);
  out.lerp(C_GRIME, ss(0.45, KERB_W, q) * 0.44);
  out.multiplyScalar(1 + tn2(dist * 0.019 + 13, 4.4) * 0.06);
}

/**
 * `cl.kerb` at or above this draws the corridor as a kerb; below it, as a flush
 * apron in the deck's own surface. It is a *material* threshold, not a geometric
 * one — the profile itself is scaled continuously by `cl.kerb` either way, so the
 * ribbon keeps following the physics surface straight through the crossover.
 */
const KERB_MIN = 0.5;

/**
 * The kerb corridor, from the road edge out to `hw + KERB_W`.
 *
 * `crossOffset` defines a surface over that whole corridor at *every* station —
 * it just scales the profile by `cl.kerb`, which the bridge zone sets to zero so
 * its deck can run flush between the parapets. Round 1 dropped the ring whenever
 * that scale fell below a half and nothing else picked the corridor up (the
 * shoulder skirt starts at `hw + KERB_W` by construction), so ~69 m of bridge
 * had a 1.6 m see-through slot down each side, of which the 1.28 m inboard of
 * the parapet was in plain view. The physics probe was quite happy to drive on
 * it, which is exactly the class of hole that survives a screenshot review.
 *
 * So the corridor is now always meshed, and what changes with `cl.kerb` is which
 * material it is drawn with: the striped kerb where there is a kerb, and the
 * deck's own tarmac or setts where there is not. Three passes over one buffer,
 * partitioned so every quad row is owned by exactly one of them — the row
 * between stations r-1 and r belongs to whichever pass owns r-1, and each pass
 * emits a ring wherever it owns either end. Same rule `buildRoad` uses for the
 * cobble transition, and it is what keeps the seams welded instead of leaving a
 * 1.5 m gap ring wherever the material changes.
 *
 * The apron takes its U from `side * (hw + q) / worldScale`, continuing the
 * road's own lateral parameterisation, so the setts run straight off the deck
 * and into the corridor with no seam. The kerb keeps U relative to `q`, because
 * its stripes are pitched against the profile and not against the road.
 */
function buildKerbs(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  // 1 m rings. Was 1.5 m, which put barely two samples on the crown ripple's
  // period — right at Nyquist, so the rumble read as a travelling beat rather
  // than as a rumble. The kerb is now 1.6 m of a 13–17 m road instead of 1.6 m
  // of a 26 m one, i.e. roughly double the screen area, and it no longer gets
  // away with it. Together with the 4.2 m wavelength this is 4.2 samples per
  // period. Costs vertices, not draw calls: the whole ribbon is still one mesh.
  const rings = Math.round(cl.count / 2);
  const nk = KERB_QS.length;
  const b = newBuf();
  const T = new THREE.Vector3(), D = new THREE.Vector3(), N = new THREE.Vector3();

  // Facet normal for band k, from the two breakpoints that bound it. The old
  // code took a ±30 mm finite difference of `crossOffset`, which straddles
  // every crease on a 60–160 mm profile and rounds all of them off — that is
  // why round 1 had a kerb with no top edge on it anywhere. Vertices are
  // duplicated per band so the creases survive into the shading.
  const facetN = (si: number, side: number, k: number, out: THREE.Vector3) => {
    const slope = (KERB_HS[k + 1] - KERB_HS[k]) / (KERB_QS[k + 1] - KERB_QS[k]);
    // `crossPoint` adds the profile in world Y, and q grows outward, i.e. along
    // `side * binormal`. The old code dropped that `side` and tilted the left
    // kerb's facets the wrong way — the second reason it had no readable edge.
    D.set(cl.bx[si] * side, cl.by[si] * side + slope, cl.bz[si] * side).normalize();
    T.set(cl.tx[si], cl.ty[si], cl.tz[si]);
    out.crossVectors(D, T).normalize();
    if (out.y < 0) out.negate();
    return out;
  };

  /**
   * One material's worth of the corridor. `uvS` is the tile size in metres, and
   * both U and V divide by it so the two can never be wired up inconsistently.
   * `edgeU` continues the road's lateral parameterisation (apron); otherwise U is
   * relative to `q` so the kerb's stripes stay pitched against the profile.
   */
  interface Pass {
    owns: (si: number) => boolean;
    uvS: number;
    edgeU: boolean;
    /** setts: carry the road ribbon's course warp across the junction */
    warp?: boolean;
    /** kerb only: variable stripe pitch + world-space U drift (see `kerbUv`) */
    jitter?: boolean;
    wear: (q: number, dist: number, hot: number, out: THREE.Color) => void;
    idx: number[];
  }

  const hotL = kerbHot(cl, -1), hotR = kerbHot(cl, 1);
  const kerbUvS = lib.scale('kerb', 2.0) * 1.3;
  const vTab = kerbVTable(cl, kerbUvS);
  const vTotal = vTab[cl.count];

  const emitRing = (si: number, side: number, dist: number, p: Pass) => {
    const hw = cl.half[si];
    const ring = b.pos.length / 3;
    const hot = side < 0 ? hotL[si] : hotR[si];
    // Stripe phase. `vTab` is in tiles already, so the pitch it encodes is what
    // lands; the lap count has to be carried explicitly because the ring loop
    // runs one station past the end and `si` has wrapped to 0 by then.
    let vK = 0, uK = 0;
    if (p.jitter) {
      const raw = Math.round(dist / cl.ds);
      vK = vTab[raw % cl.count] + Math.floor(raw / cl.count) * vTotal;
    }
    // two vertices per breakpoint per band: the crease is the point
    for (let k = 0; k < nk - 1; k++) {
      facetN(si, side, k, N);
      for (let e = 0; e < 2; e++) {
        const q = KERB_QS[k + e];
        track.crossPoint(si, side * (hw + q), _p);
        if (p.jitter && k === 0 && e === 0) {
          // one sample per ring, off the world position of its foot, so the
          // drift is continuous everywhere including across the start/finish
          uK = tn2(_p.x * 0.021 + 9, _p.z * 0.021 + 9) * 0.62
            + tn2(_p.x * 0.0074 + 41, _p.z * 0.0074 + 41) * 0.38;
        }
        p.wear(q, dist, hot, _c);
        const lat = p.edgeU ? side * (hw + q) : q;
        const w = p.warp ? cobbleWarp(dist, lat) : null;
        pushV(b, _p.x, _p.y, _p.z, N.x, N.y, N.z,
          (w ? w.u : lat) / p.uvS + uK, p.jitter ? vK : (w ? w.v : dist) / p.uvS, _c);
      }
    }
    return ring;
  };

  const stitch = (prev: number, ring: number, side: number, into: number[]) => {
    for (let k = 0; k < nk - 1; k++) {
      const a = prev + k * 2, c = ring + k * 2;
      if (side < 0) into.push(a, c, c + 1, a, c + 1, a + 1);
      else into.push(a, a + 1, c + 1, a, c + 1, c);
    }
  };

  const run = (p: Pass) => {
    for (let side = -1; side <= 1; side += 2) {
      let prev = -1, prevSi = -1;
      for (let r = 0; r <= rings; r++) {
        const raw = Math.round((r * cl.count) / rings);
        const si = raw % cl.count;
        // emit wherever this pass owns either end of the row, so the ring the
        // neighbouring pass needs to weld against is always there
        if (!(p.owns(si) || (prevSi >= 0 && p.owns(prevSi)))) { prev = -1; prevSi = si; continue; }
        const ring = emitRing(si, side, raw * cl.ds, p);
        if (prev >= 0 && p.owns(prevSi)) stitch(prev, ring, side, p.idx);
        prev = ring; prevSi = si;
      }
    }
  };

  const hasKerb = (si: number) => cl.kerb[si] >= KERB_MIN;
  const passes: { p: Pass; mat: () => THREE.Material }[] = [
    {
      // the shared kerb map bands red/white along V at 4 stripes per tile, so V
      // must be real arc length over the tile size or the stripes stretch
      // 2.0 m of tile is four bands, i.e. 500 mm stripes. Stretched to 2.6 m the
      // stripe is 650 mm: chunkier (which is the Nintendo read anyway) and a
      // third of an octave further from Nyquist at the distances that alias.
      p: {
        owns: hasKerb, uvS: kerbUvS, edgeU: false,
        jitter: true, wear: kerbWear, idx: [],
      },
      mat: () => lib.vc('kerb', () => kerbMaterial(lib), (m) => {
        // Tile mean: half red, half white, knocked back by the grime and chip the
        // map averages in — the value a distant kerb resolves to.
        //
        // The band was 26 → 105 m at 0.72 of the mean, which killed the stripe
        // crawl and then kept going: the kerb is the *only* full-contrast line
        // in the frame that draws the shape of the corner, and starting to erase
        // it 26 m ahead of the kart is a direct cause of "no kerb curvature
        // telegraphed through the haze". 34 → 125 m keeps a legible saw-tooth
        // right through the mid-ground where the corner is actually read, and
        // 0.86 leaves the far kerb a bright band against dark tarmac rather than
        // a grey smear that the aerial perspective then finishes off. 34 m is
        // still comfortably before a 650 mm stripe approaches Nyquist.
        _c2.copy(C_KERB_R).lerp(C_KERB_W, 0.5).multiplyScalar(0.86);
        injectDistanceFlatten(m, 34, 125, _c2);
      }),
    },
    {
      p: {
        owns: (si) => !hasKerb(si) && cl.cobble[si] < 0.5,
        uvS: lib.scale('tarmac', 3.5), edgeU: true, wear: apronWear, idx: [],
      },
      mat: () => lib.vc('tarmac', () => tarmacMaterial(lib)),
    },
    {
      p: {
        owns: (si) => !hasKerb(si) && cl.cobble[si] >= 0.5,
        uvS: cobbleUvScale(lib), edgeU: true, warp: true, wear: apronWear, idx: [],
      },
      mat: () => cobbleVc(lib),
    },
  ];
  for (const { p } of passes) run(p);

  // one geometry, one buffer, a group per material — and no empty groups, which
  // would cost a draw call apiece for nothing on a layout that never uses them
  b.idx = [];
  for (const { p } of passes) for (const i of p.idx) b.idx.push(i);
  const geo = finish(b);
  const mats: THREE.Material[] = [];
  let off = 0;
  for (const { p, mat } of passes) {
    if (!p.idx.length) continue;
    geo.addGroup(off, p.idx.length, mats.length);
    off += p.idx.length;
    mats.push(mat());
  }

  const mesh = new THREE.Mesh(geo, mats.length === 1 ? mats[0] : mats);
  mesh.name = 'kerbs';
  // No shadow. A kerb stands about 50 mm proud of the apron, and although the
  // key light is low enough (14 degrees) to stretch that into a ~200 mm smear,
  // the smear lands on tarmac already inside the kerb's own form shading and
  // baked AO — an A/B of the hero and corner frames with this flag both ways is
  // indistinguishable in the kerb region. It is not free, either: this is a
  // multi-material mesh, so it costs one shadow draw PER GROUP, three every
  // near cascade and three more every far one, for 3.9 draw calls a frame out
  // of a budget of 250. The profile's own shading is what reads here, and it
  // stays.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ---------------------------------------------------------------------------
//  Painted markings and road decals
// ---------------------------------------------------------------------------
//  Edge lines, the start/finish checker, grid boxes, tar seams, patch repairs
//  and corner arrows all share one buffer and one material, so the whole layer
//  is a single draw call. What separates them is vertex colour (how dark) and
//  vertex alpha (how thick the paint is), plus a per-family lift so coplanar
//  families resolve in a fixed order instead of z-fighting.
// ---------------------------------------------------------------------------

/**
 * Distance from a corner's mark point back to its first (3-bar) marker.
 *
 * Shared by the painted braking ladder and the upright count boards, because
 * the whole point of the two families is that they agree: a driver reads "three
 * bars" once and gets it from the road and from the roadside at the same
 * station. Two copies of `c.d - 100` is exactly how they would stop agreeing.
 *
 * Adaptive rather than fixed at 100 m, because the corners on this circuit are
 * 77–249 m apart — a fixed ladder would have the three village esses writing
 * their braking boards over each other's exits.
 */
function cornerLadder(corners: readonly Corner[], ci: number, len: number): number {
  return Math.max(26, Math.min(112, cornerGap(corners, ci, len) - 30));
}

/** Clean run of road behind corner `ci`, i.e. distance back to the previous one. */
function cornerGap(corners: readonly Corner[], ci: number, len: number): number {
  const raw = corners[ci].d - corners[(ci - 1 + corners.length) % corners.length].d;
  return raw > 0 ? raw : raw + len;
}

/** paint-thickness ordering, metres above the road; larger wins */
const LIFT_PATCH = 0.008;
const LIFT_SEAM = 0.011;
const LIFT_PAINT = 0.014;
const LIFT_ARROW = 0.017;
const LIFT_SPONSOR = 0.020;
const LIFT_DRAIN = 0.023;

/**
 * Average linear albedo the paint map actually samples to.
 *
 * `paintMaterial` bakes warm thermoplastic cream (`#f2ece0`), then bleeds
 * aggregate through it and knocks it back with road film, landing around here.
 * Vertex colour on this material *multiplies* that, so a decal's vertex colour
 * is never the colour you want — it is the colour you want divided by this.
 * Getting it wrong is exactly how round 1 shipped patch repairs five times too
 * bright; `paintTint` does the division so nobody has to do it by eye again.
 */
const PAINT_ALBEDO = new THREE.Color(0.71, 0.67, 0.60);

/**
 * Decal multipliers over that paint map — so the number written here is not the
 * colour of the decal, it is the colour of the decal *divided* by the map.
 * Round 1 read them as absolute colours and shipped a patch repair at roughly
 * five times the linear albedo of the road it was supposed to be repairing.
 *
 *   tar   → ≈`#2a2a32`, well under half the road: hot bitumen, near-black
 *   patch → ≈`#3e3e48`, the bible's worn-line value: fresh binder, a shade
 *           darker than the road and — via the paint material's 0.44 base
 *           roughness against the tarmac's 0.72 — visibly smoother, which is
 *           the half of "reads as a repair" that albedo cannot do
 */
const C_TAR = new THREE.Color(0.033, 0.035, 0.054);
const C_PATCH = new THREE.Color(0.068, 0.070, 0.111);

/** Vertex multiplier that carries the paint map to an absolute palette colour. */
function paintTint(hex: number, out: THREE.Color): THREE.Color {
  out.setHex(hex);   // three converts sRGB → the linear working space for us
  out.setRGB(out.r / PAINT_ALBEDO.r, out.g / PAINT_ALBEDO.g, out.b / PAINT_ALBEDO.b);
  // a multiplier over ~1.7 is asking the map for light it does not have and
  // just clips flat; under 0.02 crushes to black, which the palette forbids
  clampMul(out, 0.02, 1.7);
  return out;
}

function buildMarkings(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const b = newBuf(false, true, true);
  const T = new THREE.Vector3(), D = new THREE.Vector3(), N = new THREE.Vector3();
  let lift = LIFT_PAINT;
  /**
   * 1 while emitting a family that must not carry the paint map's relief or its
   * gloss — every `C_TAR` bituminous family. See `injectDecalMatte`.
   */
  let matte = 0;

  const put = (si: number, L: number, u: number, v: number, col: THREE.Color, a = 1, sOff = 0) => {
    track.crossPoint(si, L, _p);
    const slope = track.roadSlope(si, L);
    D.set(cl.bx[si], cl.by[si] + slope, cl.bz[si]).normalize();
    T.set(cl.tx[si], cl.ty[si], cl.tz[si]);
    N.crossVectors(D, T).normalize();
    const i = b.pos.length / 3;
    pushV(b,
      _p.x + N.x * lift + T.x * sOff,
      _p.y + N.y * lift + T.y * sOff,
      _p.z + N.z * lift + T.z * sOff,
      N.x, N.y, N.z, u, v, col, a, matte);
    return i;
  };
  /**
   * Place a vertex at an arbitrary *arc length*, not at a station.
   *
   * The station table is 0.5 m coarse, so the old `Math.round(d / ds)` collapsed
   * anything thinner than half a metre onto a single station — which silently
   * ate the 0.15 m transverse sides of all eight grid boxes, and quantised the
   * 0.85 m checker rows to alternating 0.5 m and 1.0 m. Carrying the remainder
   * along the tangent costs one vector add and makes every decal here exactly
   * the size it is written as.
   */
  const putD = (d: number, L: number, u: number, v: number, col: THREE.Color, a = 1) => {
    const raw = d / cl.ds;
    const fl = Math.floor(raw);
    const si = ((fl % cl.count) + cl.count) % cl.count;
    return put(si, L, u, v, col, a, (raw - fl) * cl.ds);
  };
  /**
   * Axis-aligned patch in (arc length, lateral), subdivided to follow the crown.
   *
   * `uvS`, when given, parameterises UV in *metres of world per tile* instead of
   * stretching one tile over the whole quad. Painted furniture (a checker square,
   * a grid-box side) is happy either way because it is one flat colour; anything
   * that is supposed to look like *road* is not, because the paint map carries
   * aggregate at a physical size and a 0..1 stretch across 8 m blows a 36 mm
   * chipping up to 300 mm. That is why the round-1 patches were visibly grainier
   * than the tarmac they sat on.
   */
  const strip = (s0: number, s1: number, l0: number, l1: number,
    col: THREE.Color, a: number, segs = 4, uvS = 0) => {
    const uu = (x: number) => (uvS > 0 ? x / uvS : x);
    for (let k = 0; k < segs; k++) {
      const t0 = l0 + (l1 - l0) * (k / segs), t1 = l0 + (l1 - l0) * ((k + 1) / segs);
      const u0 = uvS > 0 ? uu(t0) : 0, u1 = uvS > 0 ? uu(t1) : 1;
      const v0 = uvS > 0 ? uu(s0) : 0, v1 = uvS > 0 ? uu(s1) : 1;
      const v = putD(s0, t0, u0, v0, col, a);
      putD(s0, t1, u1, v0, col, a);
      putD(s1, t1, u1, v1, col, a);
      putD(s1, t0, u0, v1, col, a);
      quad(b, v, v + 1, v + 2, v + 3);
    }
  };

  /**
   * A road repair, as opposed to a rectangle of paint.
   *
   * Round 1 drew these with `strip()`: one quad, four exact 90° corners, constant
   * vertex alpha and a stretched UV, in a colour six times the linear albedo of
   * the tarmac. It read as a broken decal, and it was the loudest thing in the
   * frame. Four things fix it, and all four are needed:
   *
   *  • **Value.** A fresh binder patch is *darker* than the road it replaces, not
   *    lighter. The vertex colour here multiplies the near-white thermoplastic of
   *    the paint map, so the number that lands at `#3e3e48` is around 0.07, not
   *    the 0.46 that shipped.
   *  • **Edge.** The perimeter ring carries alpha 0 and sits `FEA` metres outside
   *    the cut, so the patch dissolves into the tarmac over a third of a metre
   *    instead of terminating on a razor.
   *  • **Shape.** The cut line wanders ±0.24 m on a smooth noise. A saw cut in a
   *    road is never square, and four exact right angles is the tell.
   *  • **Scale.** World UVs, so the aggregate inside the patch is the same
   *    physical size as the aggregate outside it.
   */
  const softPatch = (d: number, lenP: number, lat: number, wP: number,
    col: THREE.Color, a: number, seed: number) => {
    const NC = 5, NR = 7;      // interior divisions across and along
    const FEA = 0.34;          // metres of alpha rolloff past the cut
    const UVS = 1.15;          // metres per paint tile
    const cols = NC + 3, rows = NR + 3;
    const l0 = lat - wP * 0.5;
    const base = b.pos.length / 3;
    // a cut wanders, it does not zigzag: one smooth octave per edge
    const wob = (t: number, k: number) => tn2(t * 2.4 + k * 37.1 + seed * 0.013, k * 5.3 + 0.5) * 0.24;
    for (let j = 0; j < rows; j++) {
      const fv = j === 0 ? 0 : j === rows - 1 ? 1 : (j - 1) / NR;
      for (let i = 0; i < cols; i++) {
        const fu = i === 0 ? 0 : i === cols - 1 ? 1 : (i - 1) / NC;
        let L = l0 + wP * fu;
        let s = d + lenP * fv;
        if (i <= 1) L += wob(fv, 0) - (i === 0 ? FEA : 0);
        else if (i >= cols - 2) L += wob(fv, 1) + (i === cols - 1 ? FEA : 0);
        if (j <= 1) s += wob(fu, 2) - (j === 0 ? FEA : 0);
        else if (j >= rows - 2) s += wob(fu, 3) + (j === rows - 1 ? FEA : 0);
        const rim = i === 0 || i === cols - 1 || j === 0 || j === rows - 1;
        // the inside of a repair is blotchy, not uniformly lit
        const n = tn2(s * 0.62 + seed * 0.07, L * 0.62);
        _c2.copy(col).multiplyScalar(0.86 + n * 0.26);
        putD(s, L, L / UVS, s / UVS, _c2, rim ? 0 : a * (0.80 + n * 0.20));
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const v0 = base + j * cols + i;
        quad(b, v0, v0 + 1, v0 + cols + 1, v0 + cols);
      }
    }
  };

  // --- continuous edge lines just inside the kerb ---
  const rings = Math.round(cl.count / 4);
  for (let side = -1; side <= 1; side += 2) {
    let prev = -1;
    for (let r = 0; r <= rings; r++) {
      const raw = Math.round((r * cl.count) / rings);
      const si = raw % cl.count;
      if (cl.kerb[si] < 0.5) { prev = -1; continue; }
      const hw = cl.half[si];
      const dist = raw * cl.ds;
      const v = dist / 3;
      // the line is scrubbed thin where karts run wide onto the kerb
      const wear = 0.62 + Math.max(0, tn2(dist * 0.021, side * 3.7)) * 0.32;
      // emit in ascending lateral order on both sides, so a single winding
      // keeps every painted quad facing up
      const lo = Math.min(side * hw - side * 0.62, side * hw - side * 0.28);
      const a = put(si, lo, 0, v, _white, wear);
      put(si, lo + 0.34, 1, v, _white, wear);
      if (prev >= 0) quad(b, prev, prev + 1, a + 1, a);
      prev = a;
    }
  }

  // --- longitudinal paving-lane joints -------------------------------------
  //  A paver lays asphalt in ~4 m lanes and every lane boundary is a cold joint
  //  that stays visible for the life of the surface. Two of them, symmetric
  //  about the centreline at half the road width.
  //
  //  This is the cheapest available answer to "long featureless straights", and
  //  it is a *perspective* answer rather than a decorative one: a pair of lines
  //  running away down the road converge on the vanishing point, which gives a
  //  straight a readable depth cue and gives the eye a rail to travel along. The
  //  transverse seams below cannot do that — they only measure speed.
  //
  //  Marched here rather than in the decal pass, welded ring to ring exactly the
  //  way the edge lines are. Emitting it as a run of independent `strip()`
  //  rectangles is the obvious shortcut and it does not work: `strip` takes one
  //  lateral pair for both ends of the quad, so every segment boundary would
  //  step sideways by however much `hw` and the wander had moved — 5 to 20 cm,
  //  every 6 m, for 1.6 km.
  lift = LIFT_SEAM;
  matte = 1;
  for (let side = -1; side <= 1; side += 2) {
    let prev = -1;
    for (let r = 0; r <= rings; r++) {
      const raw = Math.round((r * cl.count) / rings);
      const si = raw % cl.count;
      // no cold joint on setts, and none across the start-line furniture
      const dd = raw * cl.ds;
      if (cl.cobble[si] >= 0.5 || dd < 34 || dd > cl.length - 34) { prev = -1; continue; }
      const hw = cl.half[si];
      // half the road width, wandering a few centimetres like a real joint
      const lat = side * (hw * 0.5 + tn2(dd * 0.012, side * 4.1) * 0.22);
      const th = 0.055 + Math.max(0, tn2(dd * 0.05 + 3, side)) * 0.035;
      // the seal has failed in patches, so the joint opens and closes along its
      // length; a constant alpha over 1.6 km reads as a drawn line, not a joint
      const a = 0.30 + Math.max(0, tn2(dd * 0.026 + 21, side * 2.2)) * 0.34;
      // world UVs at the same 1.15 m/tile the transverse seams use, so the
      // aggregate reading through the joint is the same physical size as the
      // aggregate either side of it rather than a 0..1 stretch across 110 mm
      const v = dd / 1.15;
      const q = put(si, lat - th, (lat - th) / 1.15, v, C_TAR, a);
      put(si, lat + th, (lat + th) / 1.15, v, C_TAR, a);
      if (prev >= 0) quad(b, prev, prev + 1, q + 1, q);
      prev = q;
    }
  }
  matte = 0;
  lift = LIFT_PAINT;

  // --- start / finish checker, three rows across the full road width ---
  //  Whites are `#f2ece0` per the palette table and the dark squares are dark
  //  *asphalt*, not black — a real checker is paint on a road, and both colours
  //  sit thin enough that the aggregate reads through. The wheel tracks the
  //  grid launches from get thinner paint again, which is the only part of this
  //  that is not symmetric and therefore the part that sells it as worn.
  const sq = 0.85;
  const hw0 = cl.half[0];
  const cols = Math.floor((hw0 * 2) / sq);
  const dark = new THREE.Color(0x30303a);
  for (let rr = 0; rr < 3; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      const white = ((rr + cc) & 1) === 0;
      const col = white ? C_PAINT : dark;
      const l0 = -hw0 + cc * sq, l1 = l0 + sq;
      const lc = (l0 + l1) * 0.5;
      // two launch corridors, on the grid slots — GRID_LAT, not a hand-typed
      // copy of it that stops agreeing the moment the grid or the road moves
      const track1 = 1 - ss(0.0, 1.5, Math.abs(Math.abs(lc) - GRID_LAT));
      const scrub = track1 * 0.42 + Math.max(0, tn2(lc * 0.5, rr * 2.3 + 9)) * 0.22;
      const a = (white ? 0.88 : 0.70) * (1 - scrub);
      _c.copy(col).multiplyScalar(1 - scrub * 0.18);
      strip(-1.4 + rr * sq, -1.4 + (rr + 1) * sq, l0, l1, _c, a, 1);
    }
  }

  // --- grid slot outlines, so the standing start reads before lights out ---
  //  Straight off `gridSlot()`, the same function `Track.buildStartGrid` places
  //  the karts with. Round 3 wrote the slot maths out twice and disagreed with
  //  itself about the lateral offset (5.0 painted, `min(5.4, half*0.46)` driven),
  //  which the width cut would have turned from a near-miss into karts standing
  //  a metre and a half off their own boxes.
  for (let k = 0; k < 8; k++) {
    const slot = gridSlot(k);
    const dC = -slot.back;
    const lat = slot.lat;
    const hl = GRID_BOX_HL, hw = GRID_BOX_HW, th = 0.15;
    // [sMin, sMax, latMin, latMax] for the four sides of the box
    const edges = [
      [dC - hl, dC + hl, lat - hw, lat - hw + th],
      [dC - hl, dC + hl, lat + hw - th, lat + hw],
      [dC - hl, dC - hl + th, lat - hw, lat + hw],
      [dC + hl - th, dC + hl, lat - hw, lat + hw],
    ];
    for (const [s0, s1, t0, t1] of edges) strip(s0, s1, t0, t1, C_PAINT, 0.82, 1);
    // slot number, as a bar count ahead of the box — cheap, reads at a glance,
    // and it gives the standing grid something to look at other than outlines
    for (let n = 0; n <= (k >> 1); n++) {
      const ls = lat - 0.62 + n * 0.34;
      strip(dC - hl - 0.95, dC - hl - 0.35, ls, ls + 0.16, C_PAINT, 0.72, 1);
    }
  }

  buildRoadDecals(track, strip, softPatch, (v) => { lift = v; }, (v) => { matte = v; });
  lift = LIFT_PAINT;
  matte = 0;

  const mesh = new THREE.Mesh(finish(b), lib.own('road-paint', () => {
    const m = paintMaterial(lib);
    injectDecalMatte(m);
    return m;
  }));
  mesh.name = 'markings';
  mesh.receiveShadow = true;
  root.add(mesh);
}

type StripFn = (s0: number, s1: number, l0: number, l1: number,
  col: THREE.Color, a: number, segs?: number, uvS?: number) => void;
type PatchFn = (d: number, lenP: number, lat: number, wP: number,
  col: THREE.Color, a: number, seed: number) => void;

/**
 * The decal layer: tar seams, patch repairs and faded corner arrows.
 *
 * Round 1's road was 50–60% of frame with nothing on it but a kerb, which is
 * both a composition failure and a readability one — a corner you cannot see
 * the shape of until you are in it. These are the cheapest possible answer:
 * they cost no draw call (same buffer, same material), they are man-made hard
 * shapes against an organic aggregate so the eye catches them immediately, and
 * the transverse seams double as a speed reference at 160 km/h.
 *
 * All of it stays inside the edge lines and clear of the start/finish, so no
 * two families of decal ever fight for the same square metre of z-buffer.
 */
function buildRoadDecals(track: Track, strip: StripFn, softPatch: PatchFn,
  setLift: (v: number) => void, setMatte: (v: number) => void) {
  const cl = track.cl;
  const len = cl.length;
  const rnd = mulberry32(70726);
  /** cast iron, wet-looking: a gully cover is the darkest thing on the road */
  const C_IRON = new THREE.Color(0.052, 0.052, 0.058);
  const C_IRON_LIP = new THREE.Color(0.115, 0.112, 0.118);
  // sponsor livery, straight off the palette table so the road agrees with the
  // kerbs and the mini-turbo tiers rather than inventing a third colour scheme
  const C_SPON_A = paintTint(0xe0453f, new THREE.Color());  // kerb red
  const C_SPON_B = paintTint(0x4fc3ff, new THREE.Color());  // boost blue
  const C_RUMBLE_R = paintTint(0xe0453f, new THREE.Color());
  const C_RUMBLE_W = paintTint(0xf2ece0, new THREE.Color());

  const clear = (d: number) => {
    // keep off the start/finish furniture and out of the cobbled village
    const dd = ((d % len) + len) % len;
    if (dd < 34 || dd > len - 34) return false;
    const si = Math.floor(dd / cl.ds) % cl.count;
    return cl.cobble[si] < 0.5 && cl.kerb[si] > 0.5;
  };
  /**
   * As `clear`, but setts are allowed.
   *
   * `clear` refuses cobble because a tar seam or a saw-cut binder patch in a
   * village street is nonsense. A corner marking is not: a painted chevron on
   * setts is a thing that exists, and three of this circuit's nine corners are
   * the village esses, which is where a driver most needs telling — the terraces
   * press in on both sides and there is no sightline at all. Refusing cobble for
   * the telegraph was silently removing a third of it.
   */
  const clearMark = (d: number) => {
    const dd = ((d % len) + len) % len;
    if (dd < 34 || dd > len - 34) return false;
    const si = Math.floor(dd / cl.ds) % cl.count;
    return cl.kerb[si] > 0.5;
  };
  const halfAt = (d: number) => cl.half[Math.floor((((d % len) + len) % len) / cl.ds) % cl.count];

  // --- transverse construction joints, one every ~31 m ---------------------
  //  Thin, dark and world-UV'd. The joint itself carries the aggregate at its
  //  authored size, so the seam reads as a groove in the road rather than as a
  //  ribbon of something else laid on top of it.
  setLift(LIFT_SEAM);
  setMatte(1);
  for (let d = 40; d < len - 40; d += 31 + rnd() * 9) {
    if (!clear(d)) continue;
    const hw = halfAt(d) - 1.1;
    // a joint is never dead square to the road, and never dead straight
    const skew = (rnd() - 0.5) * 1.6;
    // 90–160 mm rather than 60–110. Vertex alpha cannot be mip-filtered, so a
    // decal thinner than this goes sub-pixel by 60 m and shimmers — the same
    // failure mode as the kerb stripe, one family down.
    const th = 0.09 + rnd() * 0.07;
    const segs = 9;
    for (let k = 0; k < segs; k++) {
      const l0 = -hw + (2 * hw) * (k / segs), l1 = -hw + (2 * hw) * ((k + 1) / segs);
      const lc = (l0 + l1) * 0.5;
      const s = d + skew * lc / hw + tn2(d * 0.05, lc * 0.5) * 0.09;
      // fades out toward the road edges, where a seam is under kerb silt anyway
      const fade = 1 - ss(0.62, 1.0, Math.abs(lc) / hw) * 0.55;
      strip(s, s + th, l0, l1, C_TAR, (0.52 + rnd() * 0.22) * fade, 1, 1.15);
    }
  }
  setMatte(0);

  // --- gully gratings in the gutter ----------------------------------------
  //  Cast-iron covers on the low side of the crown, where the drainage actually
  //  goes. Man-made, hard-edged, and the darkest value on the road, so they
  //  read instantly at any distance and give the gutter — which is otherwise
  //  the emptiest band of the whole surface — a rhythm.
  setLift(LIFT_DRAIN);
  for (let d = 60, n = 0; d < len - 60; d += 46 + rnd() * 34, n++) {
    if (!clear(d)) continue;
    const side = (n & 1) ? 1 : -1;
    const hw = halfAt(d);
    // inboard of the edge line (which runs hw−0.62 … hw−0.28), in the gutter
    const lat = side * (hw - 1.42);
    const hl = 0.44, hwid = 0.28;
    // frame first, then the slots sunk into it
    strip(d - hl, d + hl, lat - hwid, lat + hwid, C_IRON_LIP, 0.9, 1, 0.9);
    for (let k = 0; k < 5; k++) {
      const s0 = d - hl + 0.11 + k * 0.155;
      strip(s0, s0 + 0.085, lat - hwid + 0.06, lat + hwid - 0.06, C_IRON, 0.96, 1, 0.9);
    }
    // the silt fan that always sits upstream of a working gully
    _c.copy(C_TAR).multiplyScalar(3.4);
    setMatte(1);
    strip(d - hl - 1.5, d - hl, lat - hwid - 0.34, lat + hwid + 0.34, _c, 0.20, 2, 1.15);
    setMatte(0);
  }

  // --- patch repairs: darker, smoother, soft-edged cuts of fresh binder -----
  setLift(LIFT_PATCH);
  for (let n = 0; n < 16; n++) {
    const d = 40 + rnd() * (len - 90);
    const seed = 1 + n * 977;
    if (!clear(d)) continue;
    const hw = halfAt(d) - 1.6;
    // Smaller than round 1 (which reached 8.1 × 4.2 m — a patch that size is a
    // resurfaced lane, and at 8 m across it was reading as a whole extra road
    // surface). A trench cut over a service run is 2–6 m by 1–2.5 m.
    const lenP = 1.9 + rnd() * 4.2;
    const wP = 1.0 + rnd() * 1.6;
    const lat = (rnd() * 2 - 1) * Math.max(0, hw - wP * 0.5);
    _c.copy(C_PATCH).multiplyScalar(0.86 + rnd() * 0.26);
    softPatch(d, lenP, lat, wP, _c, 0.74 + rnd() * 0.18, seed);
    // The bead of hot tar poured along the ends of the cut. Inset, so it lands
    // on the patch's own full-alpha interior rather than floating out past the
    // feathered edge — and therefore lifted to the seam plane, because two
    // coplanar alpha-blended quads in the same buffer z-fight.
    setLift(LIFT_SEAM);
    setMatte(1);
    strip(d + 0.06, d + 0.16, lat - wP * 0.44, lat + wP * 0.44, C_TAR, 0.62, 2, 1.15);
    strip(d + lenP - 0.16, d + lenP - 0.06, lat - wP * 0.44, lat + wP * 0.44, C_TAR, 0.62, 2, 1.15);
    setMatte(0);
    setLift(LIFT_PATCH);
  }

  // -------------------------------------------------------------------------
  //  Corner telegraph
  // -------------------------------------------------------------------------
  //  The road crests and vanishes into sky with no cue which way it goes. The
  //  full answer is vertical scenery on the outside of the turn (see the report
  //  — that is Scenery's to place), but the *track* owns the part that lives on
  //  the tarmac, and it costs no draw call: a tiered set of braking boards
  //  painted across the outer third of the road, counting down into the corner,
  //  followed by a direction chevron aimed at the exit.
  //
  //  Painted markers work here for the same reason they work in real life: they
  //  are man-made hard shapes on an organic surface, they read at a grazing
  //  angle where an upright board is edge-on, and they are the last thing still
  //  visible when the road is cresting away from you.
  //
  //  ROUND-1 NOTE. None of this shipped. The detector was
  //  `Math.abs(cl.curv[i]) > 0.0125`, and on this layout that gate is above
  //  every corner on the circuit except the banked coastal 180 — see the block
  //  comment on `findCorners` in TrackLayout for the measured numbers. Eight of
  //  nine corners got no boards, no rumbles, no chevron, which is the whole of
  //  the "the player cannot anticipate" finding. `track.corners` is now a real
  //  segmentation of the curvature schedule and gives nine marks a lap.
  setLift(LIFT_ARROW);
  const corners = track.corners;
  for (let ci = 0; ci < corners.length; ci++) {
    const c = corners[ci];
    if (!clearMark(c.d - 40)) continue;
    // Outside of the turn: `curv < 0` is a left-hander, whose outside is the
    // right-hand side, which is also where a kart on the ideal line is pointed.
    const outSign = -c.sign;
    const gap = cornerGap(corners, ci, len);
    const b0 = cornerLadder(corners, ci, len);

    // --- tiered braking boards: 3 / 2 / 1 bars -----------------------------
    const marks: [number, number][] = [[b0, 3], [b0 * 0.66, 2], [b0 * 0.36, 1]];
    for (const [back, bars] of marks) {
      const dm = c.d - back;
      if (!clearMark(dm)) continue;
      const hwm = halfAt(dm);
      // hugs the outside kerb, clear of the edge line
      const inner = hwm - 1.15;
      for (let bi = 0; bi < bars; bi++) {
        const s0 = dm + bi * 1.35;
        const l0 = outSign > 0 ? inner - 3.0 : -inner;
        const l1 = outSign > 0 ? inner : -inner + 3.0;
        strip(s0, s0 + 0.62, l0, l1, C_PAINT, 0.58, 3, 1.15);
      }
    }

    // --- sponsor paint at the corner entry ----------------------------------
    //  A block of livery across the outer third of the road, upstream of the
    //  braking boards. Real circuits paint these because a sponsor pays for
    //  them; they earn their place here because they are the only *saturated*
    //  thing on 1.6 km of grey-violet asphalt, and a narrow road means the
    //  camera is now close enough for that to land. Two bars, palette colours,
    //  laid at a slight skew so they read as painted on rather than composited.
    //  Laid at −142 … −131 m so it clears the rumble strips at −121 … −114 and
    //  the first braking board at −100. Gated on `gap` rather than on a global
    //  150 m corner spacing, because corners are now detected properly and the
    //  village esses are 77–89 m apart: on those the ladder is boards + chevron
    //  only, and the long approaches keep the full run-up.
    setLift(LIFT_SPONSOR);
    if (gap >= 172) {
      const ds = c.d - 142;
      if (clear(ds) && clear(ds + 15)) {
        const hws = halfAt(ds);
        const inner = hws - 1.15;
        const bars: [number, number, THREE.Color][] = [
          [0.0, 5.4, C_SPON_A],
          [6.6, 4.0, C_SPON_B],
        ];
        for (const [off, lenB, col] of bars) {
          const segs = 5;
          for (let k = 0; k < segs; k++) {
            const f0 = k / segs, f1 = (k + 1) / segs;
            // outer edge hugs the kerb, inner edge tapers in along the length
            const w0 = 2.7 - f0 * 0.5, w1 = 2.7 - f1 * 0.5;
            const s0 = ds + off + lenB * f0, s1 = ds + off + lenB * f1;
            const lo0 = outSign > 0 ? inner - w0 : -inner;
            const hi0 = outSign > 0 ? inner : -inner + w0;
            const lo1 = outSign > 0 ? inner - w1 : -inner;
            const hi1 = outSign > 0 ? inner : -inner + w1;
            // paint wears from the middle out where the wheels cross it
            const wear = 1 - (1 - Math.abs(f0 * 2 - 1)) * 0.28;
            _c.copy(col).multiplyScalar(0.90 + tn2(s0 * 0.09, off) * 0.14);
            strip(s0, s1, Math.min(lo0, lo1), Math.max(hi0, hi1), _c, 0.78 * wear, 3, 1.15);
          }
        }
      }
    }

    // --- rumble strips ahead of the braking zone ----------------------------
    //  Transverse ribs across the outer half of the road, in kerb red and white,
    //  tightening in pitch as they approach the corner. Two jobs: they tell the
    //  driver a braking zone is coming before the boards do, and they put a hard
    //  high-frequency beat on a stretch of road that is otherwise the flattest
    //  thing in the frame. Pitched at 1.1 m falling to 0.7 — under a metre is
    //  where a rib stops resolving at speed and starts shimmering.
    setLift(LIFT_ARROW);
    if (gap >= 148) {
      const NR = 9;
      let sr = c.d - 122;
      for (let k = 0; k < NR; k++) {
        const f = k / (NR - 1);
        const pitch = 1.1 - f * 0.4;
        sr += pitch;
        if (!clear(sr)) continue;
        const hwr = halfAt(sr);
        const inner = hwr - 1.15;
        const w = 2.4 + f * 0.9;      // ribs widen toward the corner
        const l0 = outSign > 0 ? inner - w : -inner;
        const l1 = outSign > 0 ? inner : -inner + w;
        const col = (k & 1) ? C_RUMBLE_W : C_RUMBLE_R;
        _c.copy(col).multiplyScalar(0.92 + tn2(sr * 0.12, k) * 0.12);
        strip(sr, sr + 0.34 + f * 0.12, l0, l1, _c, 0.66 + f * 0.16, 3, 1.15);
      }
    }

    // --- direction chevron at the braking board -----------------------------
    setLift(LIFT_ARROW);
    const d = c.d - Math.min(46, b0 * 0.42);
    if (!clearMark(d) || !clearMark(d + 6)) continue;
    const lat = outSign * (halfAt(d) - 3.6);
    // brighter and bigger than round 1's 0.30 — at 0.30 over a dark road under a
    // 14° key it was inside the tarmac's own noise floor and simply did not read
    const a = 0.62;
    const gain = 1 + Math.min(1, c.k * 90) * 0.35;   // tighter corner, bolder mark
    strip(d, d + 3.6 * gain, lat - 0.36, lat + 0.36, C_PAINT, a, 1, 1.15);
    for (let k = 0; k < 6; k++) {
      const u = k / 6, u1 = (k + 1) / 6;
      const w = 1.5 * gain * (1 - u1);
      strip(d + 3.6 * gain + u * 1.9, d + 3.6 * gain + u1 * 1.9, lat - w, lat + w, C_PAINT, a, 1, 1.15);
    }
  }
}

// ---------------------------------------------------------------------------
//  Boost strips
// ---------------------------------------------------------------------------

function buildBoostPads(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const b = newBuf();
  const T = new THREE.Vector3(), D = new THREE.Vector3(), N = new THREE.Vector3();
  const uvS = lib.scale('boost-pad', 6);
  for (const pad of BOOST_PADS) {
    const i0 = Math.floor(pad.t0 * cl.count), i1 = Math.floor(pad.t1 * cl.count);
    const segs = Math.max(4, Math.round((i1 - i0) / 4));
    const lenM = (i1 - i0) * cl.ds;
    let prev = -1;
    for (let s = 0; s <= segs; s++) {
      const si = (i0 + Math.round(((i1 - i0) * s) / segs)) % cl.count;
      const v = (s / segs) * (lenM / uvS);
      const ring = b.pos.length / 3;
      for (let k = 0; k < 2; k++) {
        const L = pad.lat + (k ? pad.hw : -pad.hw);
        track.crossPoint(si, L, _p);
        const slope = track.roadSlope(si, L);
        D.set(cl.bx[si], cl.by[si] + slope, cl.bz[si]).normalize();
        T.set(cl.tx[si], cl.ty[si], cl.tz[si]);
        N.crossVectors(D, T).normalize();
        pushV(b, _p.x + N.x * 0.02, _p.y + N.y * 0.02, _p.z + N.z * 0.02, N.x, N.y, N.z, k, v, _white);
      }
      if (prev >= 0) quad(b, prev, prev + 1, ring + 1, ring);
      prev = ring;
    }
  }
  const mesh = new THREE.Mesh(finish(b), lib.get('boost-pad', () => boostMaterial()));
  mesh.name = 'boost-pads';
  mesh.renderOrder = 2;
  root.add(mesh);
}

// ---------------------------------------------------------------------------
//  Corner marker boards — the vertical half of the read-ahead answer
// ---------------------------------------------------------------------------
//
//  Every round-1 chase frame runs the road to a vanishing point and loses it:
//  no vertical landmark on the sightline, no banking in profile, nothing above
//  the horizon that says which way the next corner goes. The painted telegraph
//  above is the half of the answer that lives on the tarmac, and it has a hard
//  limit — paint is *in the road plane*, so the moment the road crests away
//  from you (the beach descent, the cliff, the run to the bridge) it is gone
//  exactly when you need it most.
//
//  These are the other half, and they are the part a driver actually reads at
//  120 m: upright boards on posts on the outside shoulder. Two families:
//
//   • **Count boards** on the approach — three bars, then two, then one, at the
//     same stations as the painted braking ladder so the two agree. A driver
//     learns the rhythm in one lap and then knows how far the corner is without
//     looking at anything else.
//   • **Chevron boards** through the corner itself, spaced along the *outside*
//     shoulder from the mark point to the exit. Because they follow the
//     shoulder, the line they draw in the air IS the shape of the corner — that
//     is the read-ahead cue, not the individual board. They are also what
//     remains visible when the road surface has crested out of view.
//
//  Sized off the sightline, not off taste: a 1.35 m board whose top sits 3.4 m
//  above the road subtends about 0.6° at 120 m, i.e. 12 px of a 1080p 60° frame,
//  and sits clear above the horizon for a chase camera at ~2.6 m. Cream face
//  against the palette's kerb red, which is the highest-contrast pair the bible
//  allows and survives the aerial perspective on the way in.
//
//  Cost: one merged mesh, one material, ~2.5 k triangles for the whole circuit.
//  The shadow they throw across the road under a 14° key is a bonus — it lands
//  ahead of the driver and telegraphs the corner a second time.
// ---------------------------------------------------------------------------

/** cream sign face; never `#ffffff` (bible §3) */
const C_BOARD_FACE = new THREE.Color('#f2ece0');
const C_BOARD_BAR = new THREE.Color('#e0453f');
/** galvanised post, well off black so it keeps form shading in the shadows */
const C_BOARD_POST = new THREE.Color('#8d8f93');
/** board top above the shoulder, and the face's own height */
const BOARD_TOP = 3.4;
const BOARD_H = 1.35;

/**
 * Enamelled sign plate. Its own bake rather than `metal-painted`, because a
 * sign is a flat baked-enamel panel with a fine orange-peel and a chalked, dusty
 * lower half, and the library's painted metal is a rolled, scuffed guardrail
 * skin at a 1.5 m tile — on a 2.4 m board that reads as corrugated iron.
 *
 * Roughness lands around 0.38 against the tarmac's 0.72 and the kerb's grime, so
 * the boards are a genuinely distinct surface response in frame (bible §9.3) and
 * catch a hard rim off the low key rather than sitting flat.
 */
function boardMaterial(lib: MatLib): THREE.Material {
  const s = bakeTexSet(256,
    (u, v) => fbm(u * 26, v * 26, 3) * 0.28 + tn2(u * 150, v * 150) * 0.1,
    (u, v, h, out) => {
      out.setRGB(1, 1, 1).multiplyScalar(0.94 + h * 0.12);
      // road film and chalking, heaviest along the bottom edge of a panel
      out.multiplyScalar(1 - Math.max(0, fbm(u * 5 + 12, v * 5 + 12, 3)) * 0.16
        - (1 - ss(0.0, 0.34, v)) * 0.13);
    },
    (u, v, h) => 0.38 + h * 0.16 + Math.max(0, fbm(u * 8 + 5, v * 8 + 5, 2)) * 0.14,
    12,
  );
  lib.tune(s, 1);
  return new THREE.MeshStandardMaterial({
    ...s, color: 0xffffff, roughness: 1, metalness: 0.15,
    vertexColors: true, side: THREE.DoubleSide,
    normalScale: new THREE.Vector2(0.45, 0.45),
  });
}

function buildCornerBoards(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const b = newBuf();
  const R = new THREE.Vector3();   // board "right", along the plate
  const F = new THREE.Vector3();   // board normal, facing oncoming traffic
  const base = new THREE.Vector3();

  const stationAt = (d: number) =>
    Math.floor((((d % cl.length) + cl.length) % cl.length) / cl.ds) % cl.count;

  /**
   * Footing for a board `off` metres outside the kerb at arc length `d`.
   *
   * Returns false where there is nothing to stand on, and there are three ways
   * for that to be true:
   *
   *  • the tunnel bore, where the shoulder is rock;
   *  • a rock wall or a bridge parapet, which owns that ground already — a
   *    marker board bolted to a cliff face is not a thing;
   *  • ground that has fallen more than 1.6 m below the shoulder, i.e. the
   *    seaward side of the cliff ledge and the beach drop. A post standing in
   *    mid-air over the bay is the "nothing floats" note (§2) at its purest, and
   *    it is exactly the mistake a naïve `hw + constant` placement makes.
   *
   * Behind an Armco it steps out past the rail rather than through it.
   * `groundAt` is the function the terrain mesh itself is built from, so if it
   * says the ground is there, the rendered ground is there.
   */
  const footing = (d: number, side: number, off: number): boolean => {
    const dd = ((d % cl.length) + cl.length) % cl.length;
    // the start straight is the banner arch's and the grandstand's; a corner
    // board in among that furniture is clutter, not navigation
    if (dd < 26 || dd > cl.length - 26) return false;
    const si = stationAt(d);
    if (cl.zone[si] === Z_TUNNEL) return false;
    const wall = side < 0 ? cl.wallL[si] : cl.wallR[si];
    if (wall === WALL_ROCK || wall === WALL_PARAPET) return false;
    let q = KERB_W + off;
    if (wall === WALL_GUARDRAIL) {
      const wo = side < 0 ? cl.wallOffL[si] : cl.wallOffR[si];
      q = Math.max(q, wo + 0.85);
    }
    // Reference height is the *kerb edge*, not the board's own footing.
    // `crossPoint` already carries the shoulder profile down the cliff, so
    // testing a shoulder point against itself is a tautology that never fires
    // and would have planted posts thirty metres out over the bay.
    track.crossPoint(si, side * (cl.half[si] + KERB_W), _p2);
    track.crossPoint(si, side * (cl.half[si] + q), _p);
    const gy = track.groundAt(_p.x, _p.z);
    if (gy < _p2.y - 1.6) return false;
    base.set(_p.x, Math.min(_p.y, gy) - 0.08, _p.z);
    // face back down the road, canted 12° toward the centreline so an
    // approaching driver sees the plate rather than its edge
    const ca = Math.cos(0.21) * -1, sa = Math.sin(0.21) * -side;
    F.set(cl.tx[si] * ca + cl.hx[si] * sa, 0, cl.tz[si] * ca + cl.hz[si] * sa).normalize();
    // `up × F`, so the CCW winding below has its geometric normal along F and a
    // double-sided plate is not lit from behind, and so that increasing `fx` is
    // the *approaching driver's* right — which is what the chevron's asymmetry
    // is defined against.
    R.set(F.z, 0, -F.x);
    return true;
  };

  /** First offset in `offs` that has ground under it; false if none does. */
  const footingAny = (d: number, side: number, offs: number[]): boolean => {
    for (const o of offs) if (footing(d, side, o)) return true;
    return false;
  };

  /** One board plate of `cols` cells, `paint(i)` choosing each cell's colour. */
  const plate = (w: number, h: number, top: number, cols: number,
    paint: (i: number) => THREE.Color) => {
    const y0 = base.y + top - h, y1 = base.y + top;
    // stood off the post's front face rather than run through its axis
    const fx0 = F.x * 0.085, fz0 = F.z * 0.085;
    for (let i = 0; i < cols; i++) {
      const f0 = -w * 0.5 + (w * i) / cols, f1 = -w * 0.5 + (w * (i + 1)) / cols;
      const col = paint(i);
      const v = b.pos.length / 3;
      for (const [fx, y] of [[f0, y0], [f1, y0], [f1, y1], [f0, y1]] as const) {
        pushV(b, base.x + R.x * fx + fx0, y, base.z + R.z * fx + fz0, F.x, F.y, F.z,
          (fx + w * 0.5) / 0.9, (y - y0) / 0.9, col);
      }
      quad(b, v, v + 1, v + 2, v + 3);
    }
  };

  /** Hexagonal post; six facets, so no 90° edge goes black under the low key. */
  const post = (top: number, rad: number) => {
    const ring0 = b.pos.length / 3;
    for (let s = 0; s < 2; s++) {
      const y = base.y + (s ? top : 0);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.26;
        const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
        const nx = R.x * cx + F.x * cz, nz = R.z * cx + F.z * cz;
        _c.copy(C_BOARD_POST).multiplyScalar(0.82 + 0.24 * (s ? 1 : 0.72));
        pushV(b, base.x + nx, y, base.z + nz, nx / rad, 0, nz / rad, k / 6, y * 0.6, _c);
      }
    }
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      quad(b, ring0 + k, ring0 + k2, ring0 + 6 + k2, ring0 + 6 + k);
    }
  };

  const boards: { d: number; side: number; kind: number; bars: number }[] = [];
  const corners = track.corners;
  for (let ci = 0; ci < corners.length; ci++) {
    const c: Corner = corners[ci];
    const side = -c.sign;   // outside of the turn
    const b0 = cornerLadder(corners, ci, cl.length);
    // count boards, on the same ladder as the painted braking marks
    boards.push({ d: c.d - b0, side, kind: 0, bars: 3 });
    boards.push({ d: c.d - b0 * 0.66, side, kind: 0, bars: 2 });
    boards.push({ d: c.d - b0 * 0.36, side, kind: 0, bars: 1 });
    /*
     * Chevrons through the bend, from the mark point out to the exit.
     *
     * ROUND-1: a fixed five, whatever the corner. On the banked coastal 180 —
     * 192 m of arc — that is one board every 48 m, which is why the review saw
     * "six matchstick-thin posts" strung along the top of the banking and read
     * the frame as two shapes, black and pink. One board per ~15 m instead, so
     * a long bend gets a continuous run that traces the arc and a short village
     * ess still gets five. This is also the only mid-ground silhouette the
     * *track* can put on the outside of that corner: the banking crest is the
     * horizon there, so a run of 3 m boards standing on it is what separates
     * road from sky.
     */
    const runEnd = c.d1 > c.d ? c.d1 : c.d1 + cl.length;
    const span = Math.max(24, Math.min(160, runEnd - c.d + 30));
    const nch = Math.max(5, Math.min(13, Math.round(span / 15)));
    for (let k = 0; k < nch; k++) {
      boards.push({ d: c.d + (span * k) / (nch - 1), side, kind: 1, bars: 0 });
    }
    /*
     * One tall direction pylon on the exit bearing, at the corner's own mark
     * point. The review asks for "a distinct authored landmark on the exit
     * bearing of every corner, visible from the braking point"; a lighthouse or
     * a windmill is Scenery's to place and only fits a few of the nine, but a
     * 4.2 m striped pylon is track furniture, fits all nine, and is the piece
     * that survives when the road crests away and the chevrons go below the
     * skyline. Deliberately much taller than everything else on the shoulder so
     * it reads as a landmark rather than as one more board.
     */
    boards.push({ d: c.d + Math.min(span * 0.5, 34), side, kind: 2, bars: 0 });
  }

  for (const bd of boards) {
    // Chevrons sit tighter to the kerb than the count boards: through the corner
    // the outside shoulder is the one piece of ground most likely to be there,
    // and a close board reads its own arc more strongly. The tight fallbacks are
    // for the cliff ledge, where the shoulder is 1.5 m wide and everything past
    // it is a 30 m drop to the sea — the bible asks for "kerb + posts" there and
    // this is the one placement that fits. Both fallbacks are half the plate's
    // own width plus 0.2 m, so even the tightest board still hangs clear of the
    // kerb's outer lip instead of over the corridor.
    const offs = bd.kind === 0 ? [2.6, 1.45] : bd.kind === 2 ? [3.2, 2.0, 1.2] : [1.95, 1.12];
    if (!footingAny(bd.d, bd.side, offs)) continue;
    /*
     * Extra mast on the banking.
     *
     * On a 20° banked corner the outer shoulder *is* the horizon from the racing
     * line — the review's corner frame is a black wedge, an empty sky, and six
     * boards on the crest reading as matchsticks. A board tall enough to stand
     * clear of that crest is the one mid-ground silhouette the track itself can
     * supply there, so the chevrons and the pylon both grow with the local bank.
     * Nothing changes on the flat sections, where they would just be tall for no
     * reason.
     */
    const bankAt = Math.abs(cl.bank[stationAt(bd.d)]);
    const tall = ss(0.14, 0.30, bankAt) * 0.95;
    if (bd.kind === 2) {
      // slender tapered mast with a striped head — four bands, so it reads as a
      // marker and not as a lamp post, and it is the same two palette colours
      // the kerbs and the count boards use rather than a third scheme
      post(4.2 + tall, 0.075);
      plate(0.9, 1.5, 4.15 + tall, 4, (i) => ((i & 1) ? C_BOARD_FACE : C_BOARD_BAR));
    } else if (bd.kind === 0) {
      post(BOARD_TOP - BOARD_H * 0.5, 0.075);
      // 3 / 2 / 1 red bars on cream, centred — the same count the painted
      // braking boards on the road show at this station
      const cols = 7;
      const bars = bd.bars;
      const lit = bars === 3 ? [1, 3, 5] : bars === 2 ? [2, 4] : [3];
      plate(2.4, BOARD_H, BOARD_TOP, cols, (i) => (lit.indexOf(i) >= 0 ? C_BOARD_BAR : C_BOARD_FACE));
    } else {
      post(2.98 + tall - 0.52, 0.062);
      // A hard asymmetric silhouette: the plate is split into six cells and the
      // red runs from one end and stops short, so the board is visibly "heavier"
      // on the side the corner turns toward. Direction reads at a distance where
      // an arrow glyph has already collapsed into one pixel of nothing.
      const dirRight = bd.side < 0;   // outside is left ⇒ the corner turns right
      plate(1.72, 0.94, 2.98 + tall, 6, (i) => {
        const k = dirRight ? 5 - i : i;
        return k < 4 ? C_BOARD_BAR : C_BOARD_FACE;
      });
    }
  }

  if (!b.idx.length) return;
  const mesh = new THREE.Mesh(finish(b), lib.own('corner-board', () => boardMaterial(lib)));
  mesh.name = 'corner-boards';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ---------------------------------------------------------------------------
//  Shoulder skirt — blends the road into the landscape, vertex coloured
// ---------------------------------------------------------------------------

const SKIRT_QS = [0, 0.45, 1.1, 2.0, 3.2, 4.8, 6.8, 9.2, 12, 15.4, 19.2, 22.6, SKIRT_W];

function surfaceColor(surf: Surface, rock: number, y: number, x: number, z: number, out: THREE.Color) {
  if (surf === Surface.Sand) out.copy(C_SAND);
  else if (surf === Surface.Dirt) out.copy(C_DIRT);
  else out.copy(C_GRASS).lerp(C_GRASS_T, 0.35 + tn2(x * 0.09, z * 0.09) * 0.3);
  out.lerp(C_STONE, Math.min(0.92, rock));
  // shorelines bleach out to sand whatever the zone says
  out.lerp(C_SAND, (1 - ss(0.6, 3.4, y)) * 0.75);
  out.multiplyScalar((1 + tn2(x * 0.013, z * 0.013) * 0.13) * GROUND_GAIN);
}

function buildSkirt(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const rings = Math.round(cl.count / 6); // 3 m
  const nq = SKIRT_QS.length;
  const b = newBuf();

  for (let side = -1; side <= 1; side += 2) {
    const first = b.pos.length / 3;
    // no duplicate closing ring: the loop is welded, so normals are seamless
    for (let r = 0; r < rings; r++) {
      const si = Math.round((r * cl.count) / rings) % cl.count;
      const edge = cl.half[si] + KERB_W;
      const rock = side < 0 ? cl.rockL[si] : cl.rockR[si];
      const surf = (side < 0 ? cl.surfL[si] : cl.surfR[si]) as Surface;
      for (let k = 0; k < nq; k++) {
        const q = SKIRT_QS[k];
        const L = side * (edge + q);
        track.crossPoint(si, L, _p);
        _p.y += track.detailAt(si, L, _p.x, _p.z);
        surfaceColor(surf, rock, _p.y, _p.x, _p.z, _c);
        // contact darkening where the shoulder meets the kerb: cheap AO that
        // stops the road looking pasted on top of the terrain
        _c.multiplyScalar(1 - (1 - ss(0, 3.5, q)) * 0.30);
        pushV(b, _p.x, _p.y, _p.z, 0, 1, 0, _p.x / 9, _p.z / 9, _c);
      }
    }
    for (let r = 0; r < rings; r++) {
      const a0 = first + r * nq;
      const a1 = first + ((r + 1) % rings) * nq;
      for (let k = 0; k < nq - 1; k++) {
        if (side < 0) quad(b, a0 + k, a1 + k, a1 + k + 1, a0 + k + 1);
        else quad(b, a0 + k, a0 + k + 1, a1 + k + 1, a1 + k);
      }
    }
  }

  const geo = finish(b);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, lib.own('ground-blend', () => groundMaterial(lib)));
  mesh.name = 'shoulders';
  mesh.receiveShadow = true;
  root.add(mesh);
}

// ---------------------------------------------------------------------------
//  Terrain: cliffs, headland, beach and the sea basin
// ---------------------------------------------------------------------------

function buildTerrain(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const cell = 8;
  const x0 = track.hmX0, z0 = track.hmZ0;
  const spanX = (track.hmW - 1) * track.hmCell, spanZ = (track.hmH - 1) * track.hmCell;
  const w = Math.ceil(spanX / cell) + 1, h = Math.ceil(spanZ / cell) + 1;

  const ys = new Float32Array(w * h);
  const pxs = new Float32Array(w * h);
  const pzs = new Float32Array(w * h);
  const snapped = new Uint8Array(w * h);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const x = x0 + i * cell, z = z0 + j * cell;
      const si = track.nearestStation(x, z);
      const L = (x - cl.px[si]) * cl.hx[si] + (z - cl.pz[si]) * cl.hz[si];
      const corridor = cl.half[si] + KERB_W + SKIRT_W;
      if (Math.abs(L) < corridor) {
        // Snap onto the skirt's outer edge, biased inward and down so the
        // grid tucks *under* the ribbon: no gaps, no z-fighting.
        const target = (L < 0 ? -1 : 1) * (corridor - 1.4);
        track.crossPoint(si, target, _p);
        _p.y += track.detailAt(si, target, _p.x, _p.z) - 0.3;
        pxs[k] = _p.x; pzs[k] = _p.z; ys[k] = _p.y; snapped[k] = 1;
      } else {
        pxs[k] = x; pzs[k] = z; ys[k] = track.groundAt(x, z);
      }
    }
  }

  const b = newBuf();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const x = pxs[k], z = pzs[k], y = ys[k];
      const kl = j * w + Math.max(0, i - 1), kr = j * w + Math.min(w - 1, i + 1);
      const kd = Math.max(0, j - 1) * w + i, ku = Math.min(h - 1, j + 1) * w + i;
      const grad = Math.hypot((ys[kl] - ys[kr]) / (2 * cell), (ys[kd] - ys[ku]) / (2 * cell));
      const rock = Math.max(track.rockAt(x, z) * 0.55, ss(0.34, 0.85, grad));
      surfaceColor(y < 2.6 ? Surface.Sand : Surface.Grass, rock, y, x, z, _c);
      pushV(b, x, y, z, 0, 1, 0, x / 14, z / 14, _c);
    }
  }
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, c = a + 1, d = a + w + 1, e = a + w;
      // drop quads wholly under the sea, and those wholly hidden by the skirt
      if (ys[a] < -5 && ys[c] < -5 && ys[d] < -5 && ys[e] < -5) continue;
      if (snapped[a] && snapped[c] && snapped[d] && snapped[e]) continue;
      quad(b, a, e, d, c);
    }
  }

  const geo = finish(b);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, lib.own('ground-blend', () => groundMaterial(lib)));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  root.add(mesh);
}

function buildSea(track: Track, lib: MatLib, root: THREE.Group) {
  const c = track.bounds.getCenter(new THREE.Vector3());
  const geo = new THREE.PlaneGeometry(6000, 6000, 72, 72);
  geo.rotateX(-Math.PI / 2);
  const uvS = lib.scale('water-surface', 16);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6000 / uvS, uv.getY(i) * 6000 / uvS);
  const mesh = new THREE.Mesh(geo, lib.get('water-surface', () => seaMaterial(lib)));
  mesh.position.set(c.x, SEA_Y, c.z);
  // deliberately not called 'sea': the dedupe in Track.update looks for one
  mesh.name = 'track-sea-fallback';
  mesh.renderOrder = -1;
  root.add(mesh);
  track.registerSea(mesh);
}

// ---------------------------------------------------------------------------
//  Guardrails: closed-profile Armco beam plus instanced posts
// ---------------------------------------------------------------------------

/** closed cross-section, [outward, up]; outward points away from the track */
const ARMCO: [number, number][] = [
  [-0.02, 0.00], [-0.09, 0.075], [-0.01, 0.15], [-0.09, 0.225], [-0.02, 0.30],
  [0.06, 0.30], [0.06, 0.00],
];

function buildBarriers(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const rings = Math.round(cl.count / 4); // 2 m
  const rail = newBuf();
  const posts: THREE.Matrix4[] = [];
  const np = ARMCO.length;
  const uvS = lib.scale('metal-painted', 1.5);

  for (let side = -1; side <= 1; side += 2) {
    let prev = -1;
    let sinceLastPost = 1e9;
    for (let r = 0; r <= rings; r++) {
      const raw = Math.round((r * cl.count) / rings);
      const si = raw % cl.count;
      const type = side < 0 ? cl.wallL[si] : cl.wallR[si];
      if (type !== WALL_GUARDRAIL) { prev = -1; continue; }
      const off = side < 0 ? cl.wallOffL[si] : cl.wallOffR[si];
      track.crossPoint(si, side * (cl.half[si] + off), _p);
      const outX = side * cl.hx[si], outZ = side * cl.hz[si];
      const ring = rail.pos.length / 3;
      const dist = raw * cl.ds;
      for (let k = 0; k < np; k++) {
        const [dOut, dy] = ARMCO[k];
        pushV(rail, _p.x + outX * dOut, _p.y + 0.5 + dy, _p.z + outZ * dOut,
          0, 1, 0, dy / uvS, dist / uvS, _white);
      }
      if (prev >= 0) {
        for (let k = 0; k < np; k++) {
          const k2 = (k + 1) % np;
          if (side < 0) quad(rail, prev + k, ring + k, ring + k2, prev + k2);
          else quad(rail, prev + k, prev + k2, ring + k2, ring + k);
        }
      }
      prev = ring;

      sinceLastPost += cl.length / rings;
      if (sinceLastPost >= 4.5) {
        sinceLastPost = 0;
        _q.setFromAxisAngle(_yAxis, Math.atan2(cl.tx[si], cl.tz[si]));
        _p2.set(_p.x + outX * 0.03, _p.y + 0.34, _p.z + outZ * 0.03);
        posts.push(new THREE.Matrix4().compose(_p2, _q, _sc));
      }
    }
  }

  const metal = lib.get('metal-painted', () => metalMaterial(lib));
  if (rail.idx.length) {
    const geo = finish(rail);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, metal);
    m.name = 'guardrail';
    m.castShadow = true; m.receiveShadow = true;
    root.add(m);
  }
  if (posts.length) {
    // an eight-sided post has no hard 90° edge to go black under the low sun
    const pg = new THREE.CylinderGeometry(0.085, 0.105, 0.98, 8, 1);
    const inst = new THREE.InstancedMesh(pg, metal, posts.length);
    for (let i = 0; i < posts.length; i++) inst.setMatrixAt(i, posts[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    inst.name = 'guardrail-posts';
    inst.frustumCulled = false;
    root.add(inst);
  }
}

// ---------------------------------------------------------------------------
//  Tunnel bore
// ---------------------------------------------------------------------------

function tunnelProfile(p: number, W: number, H: number): [number, number] {
  if (p < 0.18) return [-W, -1.4 + 4.0 * (p / 0.18)];
  if (p > 0.82) return [W, 2.6 - 4.0 * ((p - 0.82) / 0.18)];
  const a = ((p - 0.18) / 0.64) * Math.PI;
  return [-W * Math.cos(a), 2.6 + (H - 2.6) * Math.sin(a)];
}

/** metres between lamp fixtures; the lit/dark rhythm keys off this everywhere */
const LIGHT_PITCH = 21;
/** warm sodium tint, as an albedo multiplier under the pools */
const C_SODIUM_MUL = new THREE.Color(1.24, 0.98, 0.72);
/** cold damp rock at the springline, where nothing dries out */
const C_DAMP_MUL = new THREE.Color(0.62, 0.66, 0.74);

/**
 * The bore.
 *
 * Round 1 drew this with `cliff-rock`, and that is the whole reason it read as
 * brown carpet. The shared library ships a purpose-built `tunnel-bore` set —
 * fresher, darker, with the arcs a boring head leaves, a damp floor line against
 * a dry crown, and a triplanar projection at `sharpness: 8` rather than the
 * cliff's 7 (the library's own comment says a low sharpness cross-fades two
 * copies of a directional noise past each other, "the fur in the tunnel bore").
 * Asking for the right material is a one-word change and it fixes the streaking,
 * the stretch at the curvature change and the missing relief in one go.
 *
 * The second half is the lighting rhythm. Six warm point lights on a 21 m pitch
 * give real quadratic pools, but six lights cannot carry a 140 m tube on their
 * own without either blowing the light budget or washing flat. So the *same*
 * 21 m rhythm is also baked into the bore's vertex colours — hot under each
 * fixture, falling away between, dropping down the walls, and going cold and
 * damp at the springline. Albedo modulation is not lighting, but at 21 m
 * intervals in a tube it is indistinguishable from it and it costs nothing.
 */
function buildTunnel(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const i0 = Math.floor((TUNNEL_T0 - 0.005) * cl.count);
  const i1 = Math.floor((TUNNEL_T1 + 0.005) * cl.count);
  const step = 3;
  const NP = 26;
  const b = newBuf();
  const uvS = lib.scale('tunnel-bore', 3.2);
  const lights: THREE.Matrix4[] = [];
  let prev = -1;

  const d0 = i0 * cl.ds, d1 = i1 * cl.ds;
  // first and last fixture kept a clear span in from each mouth
  const dLight0 = d0 + 12;
  const nLight = Math.max(2, Math.floor((d1 - 12 - dLight0) / LIGHT_PITCH) + 1);
  const lightAt = (n: number) => dLight0 + n * LIGHT_PITCH;

  for (let i = i0; i <= i1; i += step) {
    const si = ((i % cl.count) + cl.count) % cl.count;
    // Springs from the road edge plus the kerb corridor plus a reveal, and its
    // crown comes down from 8.6 m to 7.6. Both track the width cut: a bore that
    // stayed 3.2 m clear of a road half as wide would have read as a cavern with
    // a footpath through it, and 8.6 m of headroom over an 11 m road is a
    // proportion no tunnel has. At TUNNEL_CLEAR the wall stands 0.8 m outboard
    // of the kerb, which is where the collision offset in ZONES is derived from.
    const W = cl.half[si] + TUNNEL_CLEAR, H = TUNNEL_H;
    const dist = i * cl.ds;
    const ring = b.pos.length / 3;
    track.crossPoint(si, 0, _p2);
    const cx = _p2.x, cy = _p2.y, cz = _p2.z;

    // where this ring sits in the lamp rhythm: 1 directly under a fixture,
    // 0 exactly between two
    const phase = (dist - dLight0) / LIGHT_PITCH;
    const pool = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
    // the mouths take a big cool wash of sky, which is what stops the exit
    // reading as a flat rectangle punched in a black wall
    const mouth = Math.max(1 - ss(0, 26, dist - d0), 1 - ss(0, 26, d1 - dist));

    let arc = 0;
    for (let k = 0; k < NP; k++) {
      const p = k / (NP - 1);
      const [lat, up] = tunnelProfile(p, W, H);
      if (k > 0) {
        const [pl, pu] = tunnelProfile((k - 1) / (NP - 1), W, H);
        arc += Math.hypot(lat - pl, up - pu);
      }
      const x = cx + cl.bx[si] * lat + cl.nx[si] * up;
      const y = cy + cl.by[si] * lat + cl.ny[si] * up;
      const z = cz + cl.bz[si] * lat + cl.nz[si] * up;
      // normal points back toward the bore axis
      const ax = -(cl.bx[si] * lat + cl.nx[si] * (up - H * 0.42));
      const ay = -(cl.by[si] * lat + cl.ny[si] * (up - H * 0.42));
      const az = -(cl.bz[si] * lat + cl.nz[si] * (up - H * 0.42));
      const inv = 1 / Math.hypot(ax, ay, az);

      // 0 at the springline, 1 at the crown — the lamps are at the crown, so
      // this is both the light falloff and the dry/damp split
      const hf = Math.min(1, Math.max(0, (up + 1.4) / (H + 1.4)));
      _c.copy(_white);
      // damp, sooty, unlit lower walls
      _c.lerp(C_DAMP_MUL, (1 - ss(0.06, 0.52, hf)) * 0.72);
      // the pool of sodium: strongest at the crown, gone by the floor line
      _c.lerp(C_SODIUM_MUL, pool * (0.22 + 0.78 * hf) * 0.85);
      // and the value rhythm that goes with it
      _c.multiplyScalar(0.54 + 0.62 * pool * (0.24 + 0.76 * hf) + 0.14 * hf);
      // mouth bounce, cool against the sodium
      _c.lerp(_c2.setRGB(1.15, 1.18, 1.24), mouth * (0.30 + 0.34 * hf));
      // per-metre breakup so the rhythm never reads as a clean sine
      _c.multiplyScalar(1 + tn2(dist * 0.09, arc * 0.11) * 0.10);
      // 4:1 between a lit crown and an unlit springline is a strong rhythm; past
      // that it stops reading as light and starts reading as paint
      clampMul(_c, 0.34, 1.42);

      pushV(b, x, y, z, ax * inv, ay * inv, az * inv, arc / uvS, dist / uvS, _c);
    }
    // wound so the front face is the one you see from inside the bore
    if (prev >= 0) {
      for (let k = 0; k < NP - 1; k++) quad(b, prev + k, ring + k, ring + k + 1, prev + k + 1);
    }
    prev = ring;
  }

  // place the fixtures on the same rhythm the shading was baked from
  for (let n = 0; n < nLight; n++) {
    const d = lightAt(n);
    const si = Math.round(d / cl.ds) % cl.count;
    const H = TUNNEL_H;
    track.crossPoint(si, 0, _p2);
    _p2.set(_p2.x + cl.nx[si] * (H - 0.55), _p2.y + cl.ny[si] * (H - 0.55), _p2.z + cl.nz[si] * (H - 0.55));
    _q.setFromAxisAngle(_yAxis, Math.atan2(cl.tx[si], cl.tz[si]));
    lights.push(new THREE.Matrix4().compose(_p2, _q, _sc));
  }

  // wound to face inward, so plain front-face culling is exactly right here
  const boreMat = lib.vc('tunnel-bore', () => rockMaterial(lib));
  const bore = new THREE.Mesh(finish(b), boreMat);
  bore.name = 'tunnel-bore';
  bore.castShadow = true;
  bore.receiveShadow = true;
  root.add(bore);

  // The bore is the single worst shader hitch in the game and it is purely
  // geographic: one mesh, frustum-culled for the 52% of a lap before the tunnel
  // mouth, so its program was compiled the frame the player first saw daylight
  // stop. (`Prewarm` now compiles against the composer's render target, which
  // is the actual reason the boot pass was missing it — see that file.) Stating
  // the requirement here as well means a future change that moves the bore out
  // of the scene graph, or builds it lazily on approach, cannot quietly bring
  // the 56 ms frame back.
  registerPrewarm(boreMat, { label: 'tunnel-bore-vc' });

  if (lights.length) {
    // housing + diffuser rather than one bare emissive slab: the housing gives
    // the fixture a silhouette and an unlit underside, which is what makes the
    // diffuser look like a lit object instead of a floating white quad
    const housing = new THREE.BoxGeometry(0.60, 0.22, 5.0);
    const housingMat = lib.get('metal-painted', () => metalMaterial(lib));
    const hInst = new THREE.InstancedMesh(housing, housingMat, lights.length);
    const diffuser = new THREE.BoxGeometry(0.44, 0.10, 4.6);
    const stripMat = lib.get('tunnel-light', () => lightMaterial());
    const dInst = new THREE.InstancedMesh(diffuser, stripMat, lights.length);
    // Both are drawn ONLY through an InstancedMesh, and `instancing` is part of
    // the program cache key — a warm-up that hosted them on a plain mesh would
    // compile a variant the renderer never asks for and leave the real one to
    // compile at the tunnel mouth. The strip material in particular exists
    // nowhere else on the circuit.
    registerPrewarm(stripMat, { instanced: true, label: 'tunnel-light' });
    registerPrewarm(housingMat, { instanced: true, label: 'metal-painted (instanced)' });
    const m = new THREE.Matrix4();
    const drop = new THREE.Matrix4().makeTranslation(0, -0.15, 0);
    for (let i = 0; i < lights.length; i++) {
      hInst.setMatrixAt(i, lights[i]);
      dInst.setMatrixAt(i, m.multiplyMatrices(lights[i], drop));
    }
    hInst.instanceMatrix.needsUpdate = true;
    dInst.instanceMatrix.needsUpdate = true;
    hInst.name = 'tunnel-light-housings';
    dInst.name = 'tunnel-lights';
    hInst.frustumCulled = false;
    dInst.frustumCulled = false;
    root.add(hInst);
    root.add(dInst);

    // One real light per fixture, ranged so it dies well before the next one:
    // the interval going dark is what sells a tunnel, and a light that reaches
    // its neighbour produces the flat ambient wash round 1 shipped. Range is
    // 1.15 × pitch, not 2 × as before, and the count is the fixture count — the
    // rhythm is only legible if every visible fixture actually lights something.
    for (let i = 0; i < lights.length; i++) {
      const l = new THREE.PointLight(0xffb35a, 210, LIGHT_PITCH * 1.15, 2);
      l.position.setFromMatrixPosition(lights[i]);
      l.position.y -= 1.6;
      l.name = 'tunnel-light';
      root.add(l);
    }
  }
}

// ---------------------------------------------------------------------------
//  Arched stone bridge over the inlet
// ---------------------------------------------------------------------------

/** closed parapet section, [outward, up]; the coping chamfers back inward */
const PARAPET: [number, number][] = [
  [0.0, 0.0], [0.0, 0.92], [-0.14, 1.04], [-0.34, 1.14], [-0.56, 1.04], [-0.62, 0.92], [-0.62, 0.0],
];

function buildBridge(track: Track, lib: MatLib, root: THREE.Group) {
  const cl = track.cl;
  const i0 = Math.floor(BRIDGE_T0 * cl.count), i1 = Math.floor(BRIDGE_T1 * cl.count);
  const K = 56;
  const spanM = (i1 - i0) * cl.ds;
  const b = newBuf();
  const uvS = lib.scale('stone-wall', 3);
  const SPRING = 2.0;         // height the arch springs from
  const FLOOR = -9.0;         // abutments run down into the gorge
  const U0 = 0.11, U1 = 0.89; // springing points along the span

  const stations: number[] = [];
  const deckBottom: number[] = [];
  for (let k = 0; k <= K; k++) {
    const si = (i0 + Math.round(((i1 - i0) * k) / K)) % cl.count;
    stations.push(si);
    track.crossPoint(si, cl.half[si] + FASCIA_OFF, _p);
    deckBottom.push(_p.y - 1.6);
  }
  let crown = Infinity;
  for (let k = 0; k <= K; k++) crown = Math.min(crown, deckBottom[k]);
  const rise = crown - 0.9 - SPRING;
  const soffit = (u: number) => {
    if (u <= U0 || u >= U1) return FLOOR;
    return SPRING + rise * Math.sin(Math.PI * (u - U0) / (U1 - U0));
  };

  // --- spandrel walls: deck fascia down to the arch extrados ---
  for (let side = -1; side <= 1; side += 2) {
    let prev = -1;
    for (let k = 0; k <= K; k++) {
      const si = stations[k];
      const u = k / K;
      track.crossPoint(si, side * (cl.half[si] + FASCIA_OFF), _p);
      const outX = side * cl.hx[si], outZ = side * cl.hz[si];
      const top = _p.y + 0.15, bot = soffit(u);
      const ring = b.pos.length / 3;
      const v = u * spanM / uvS;
      pushV(b, _p.x, top, _p.z, outX, 0, outZ, v, 0, _white);
      pushV(b, _p.x, bot, _p.z, outX, 0, outZ, v, (top - bot) / uvS, _white);
      // vertex 0 is up, vertex 1 is down; +T is prev→ring
      if (prev >= 0) {
        if (side < 0) quad(b, prev, prev + 1, ring + 1, ring);
        else quad(b, prev, ring, ring + 1, prev + 1);
      }
      prev = ring;
    }
  }

  // --- arch barrel (curved underside between the spandrels) ---
  {
    let prev = -1;
    for (let k = 0; k <= K; k++) {
      const si = stations[k];
      const u = k / K;
      const y = soffit(u);
      const ring = b.pos.length / 3;
      const v = u * spanM / uvS;
      for (let s = -1; s <= 1; s += 2) {
        track.crossPoint(si, s * (cl.half[si] + FASCIA_OFF), _p);
        pushV(b, _p.x, y, _p.z, 0, -1, 0, v, (s + 1) / 2, _white);
      }
      // seen from below, so wind the opposite way to a road surface
      if (prev >= 0) quad(b, prev, ring, ring + 1, prev + 1);
      prev = ring;
    }
  }

  // --- parapets ---
  const npar = PARAPET.length;
  for (let side = -1; side <= 1; side += 2) {
    let prev = -1;
    for (let k = 0; k <= K; k++) {
      const si = stations[k];
      track.crossPoint(si, side * (cl.half[si] + PARAPET_OFF), _p);
      const outX = side * cl.hx[si], outZ = side * cl.hz[si];
      const ring = b.pos.length / 3;
      const dist = (k / K) * spanM;
      for (let s = 0; s < npar; s++) {
        const [dOut, dy] = PARAPET[s];
        pushV(b, _p.x + outX * dOut, _p.y + dy, _p.z + outZ * dOut,
          0, 1, 0, dy / uvS, dist / uvS, _white);
      }
      if (prev >= 0) {
        for (let s = 0; s < npar; s++) {
          const s2 = (s + 1) % npar;
          if (side < 0) quad(b, prev + s, ring + s, ring + s2, prev + s2);
          else quad(b, prev + s, prev + s2, ring + s2, ring + s);
        }
      }
      prev = ring;
    }
  }

  const geo = finish(b);
  geo.computeVertexNormals();
  // The DoubleSide clone is its own program (`doubleSided` is a cache-key
  // boolean) and it is unnamed, because the shared library does not name what
  // it bakes. It is also the only place that clone is used, on one mesh that is
  // frustum-culled for the 86% of a lap before the inlet — so it was compiling
  // on approach to the bridge. Declared up front instead.
  const bridgeMat = twoSided(lib.get('stone-wall', () => stoneMaterial(lib)));
  bridgeMat.name = bridgeMat.name || 'bridge-stone-2s';
  registerPrewarm(bridgeMat, { label: 'bridge-stone-2s' });
  const mesh = new THREE.Mesh(geo, bridgeMat);
  mesh.name = 'bridge';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
}
