/**
 * ============================================================================
 *  Procedural material library — every surface in Sunset Bay lives here.
 * ============================================================================
 *  Usage from any other system:
 *
 *      import { getMaterials } from '../render/Materials';
 *      const mat = getMaterials().get('cobblestone');
 *
 *  or, if you already hold the instance, `materials.tarmac`.
 *
 *  Contract:
 *   • Materials are built LAZILY on first `get()` and cached forever. Asking
 *     twice returns the *same* object — never mutate a material you did not
 *     build. If you need a recoloured copy, use `variant()` / `livery()`,
 *     which clone the material but share the textures.
 *   • Every material ships albedo + normal + packed ORM (R=AO, G=roughness,
 *     B=metalness), all procedurally generated, all with spatially varying
 *     roughness. Normals are Sobel-derived from a real height field.
 *   • **Every surface is built at three scales, not one.** A texture generator
 *     that produces only fine grain makes every material the same material
 *     wearing a different tint, however good the grain is, because grain is the
 *     one frequency that averages to a constant the moment the camera is a metre
 *     away. So each material is:
 *       - a TILE (1024²/512², a few metres across) carrying millimetres to
 *         decimetres, and
 *       - a MACRO MAP (128², built by `macroMaps()`, sampled in WORLD space at a
 *         period of 4-32 m) carrying everything above about a metre: patch
 *         repairs, colour drift, pooling, weathering zones, worn-through ground.
 *     The macro layer modulates **albedo AND roughness**, from two decorrelated
 *     fields — a metre-scale blotch that moves colour alone still lights like a
 *     flat sheet, because the specular response a 14° key rakes across never
 *     changed. Rock and the bore add a third scale on top: world-horizontal
 *     strata, which no isotropic noise field at any frequency can produce.
 *   • **Nothing is isotropic.** Every surface with a natural direction gets one:
 *     road aggregate smeared down the direction of travel, rain run down a wall,
 *     grain along a plank, rock spalling along its bedding. Inside the tile that
 *     is `stretchY` and `directionalBlur`; above a metre it is `streak`, a band
 *     read in the tile's own UV frame at a heavily stretched scale, which follows
 *     the track through every corner for one texture fetch.
 *   • The world-space sampling matters as much as the content: a variation
 *     welded to each mesh's UV layout repeats once per instance and once per
 *     tile. Architecture additionally takes a per-instance UV phase offset and
 *     value jitter, keyed off the instance origin — a hundred houses sharing one
 *     texture set must not share one texture *phase*.
 *   • Low-frequency fbm fields that carry form are `normalize`d. An n-octave sum
 *     piles up around 0.5 by the central limit theorem, so a field consumed as
 *     `(v - 0.5) * k` delivers a fraction of the swing its coefficient claims.
 *     Read `FbmOpts.normalize` before authoring another one.
 *   • Ground materials carry a distance settle: past ~35 m the fine octave
 *     fades into its own local mean and the normal flattens with it, because a
 *     detail layer that holds full contrast to the horizon is a shimmering
 *     carpet the moment the camera moves.
 *   • `worldScale(name)` reports how many metres one tile of the texture is
 *     meant to cover. Build your UVs as `worldPos / worldScale` and every
 *     surface in the game will agree on texel density.
 * ============================================================================
 */
import * as THREE from 'three';
import { Quality, type Ctx, type System } from '../types';
import {
  brickField,
  clamp,
  clamp01,
  directionalBlur,
  fbmField,
  grainField,
  hash2,
  lerp,
  macroField,
  microDetail,
  microRough,
  microSurface,
  microValue,
  mulberry32,
  patchField,
  smoothstep,
  strataField,
  voronoiField,
  type MicroFamily,
  type MicroField,
} from './Noise';
import {
  Fields,
  alphaFrom,
  blurField,
  buildMaps,
  createCanvas,
  macroTexture,
  mixRGB,
  readPixels,
  rgb,
  textureBudget,
  toImageData,
  type Canvas2D,
  type MapSet,
  type RGB,
} from './Textures';

/**
 * Resolution of every macro map. See `Materials.macroMaps` for why this is not
 * a compromise — a low-frequency field has no information above this, and
 * carrying it at 1024² was costing a full-resolution channel to store four
 * lattice cells.
 */
const MACRO_RES = 128;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type MaterialName =
  | 'tarmac'
  | 'tarmac-racing-line'
  | 'tarmac-wet'
  | 'cobblestone'
  | 'kerb'
  | 'sand'
  | 'grass'
  | 'dirt'
  | 'cliff-rock'
  | 'tunnel-bore'
  | 'stone-wall'
  | 'stucco'
  | 'roof-tile'
  | 'wood-plank'
  | 'wood-weathered'
  | 'metal-painted'
  | 'chrome'
  | 'rubber'
  | 'glass'
  | 'canvas-awning'
  | 'water-surface'
  | 'concrete'
  | 'marble'
  | 'boost-pad'
  | 'banner-fabric'
  | 'palm-bark'
  | 'foliage-leaf'
  | 'palm-frond'
  | 'crowd'
  | 'tunnel-light'
  | 'neon';

/**
 * Base texture resolution before the quality scale is applied — i.e. the size
 * a desktop tier gets. `Materials.res()` applies the tier scale and the global
 * texture cap on top; see the note there.
 *
 * THE MOBILE CLAUSE to the art bible's "minimum 1024² within 5 m, 512² beyond".
 * That rule is a desktop standard and is met verbatim at High and Ultra. It is
 * NOT met on a handheld and must not be: 1024² over a 3.5 m tarmac tile is 290
 * texels per metre of world, against a 390 CSS-pixel panel that resolves maybe
 * 60. The whole top of the mip chain is built, uploaded, charged against a
 * memory ceiling an iOS tab is killed for crossing, and never sampled. The
 * measured bill for honouring the desktop rule on a phone was 220 MB of
 * texture memory against an 80 MB budget, which is the crash. So: base ×1 on
 * High/Ultra, ×0.5 on Medium, ×0.25 on Low, capped by `textureBudget()`.
 */
const BASE_SIZE: Record<string, number> = {
  tarmac: 1024,
  'tarmac-racing-line': 1024,
  'tarmac-wet': 1024,
  cobblestone: 1024,
  kerb: 1024,
  sand: 1024,
  grass: 1024,
  dirt: 512,
  'cliff-rock': 1024,
  'tunnel-bore': 1024,
  'stone-wall': 1024,
  // 512² over a 3 m tile is 5.9 texels/cm, and the aerial establishing shot puts
  // every wall in the village past the point where that is a flat mip. One
  // texture set is shared by all eight pastels, so this is 16 MB total for the
  // most-repeated surface in the game.
  stucco: 1024,
  'roof-tile': 512,
  'wood-plank': 512,
  'wood-weathered': 512,
  'metal-painted': 512,
  chrome: 256,
  rubber: 512,
  glass: 256,
  'canvas-awning': 512,
  'water-surface': 512,
  concrete: 512,
  marble: 512,
  'boost-pad': 512,
  'banner-fabric': 512,
  'palm-bark': 512,
  'foliage-leaf': 512,
  // A frond is a long thin cutout whose entire read is its silhouette, and the
  // beach section puts one across the camera at 3 m. 512² over a card that
  // covers 3 m of screen is 6 texels/cm of *alpha*, which is where the jagged
  // edge comes from: the alpha test has no gradient to resolve against.
  'palm-frond': 1024,
  crowd: 512,
  'tunnel-light': 256,
  neon: 256,
};

/** Metres of world covered by one texture tile. Build UVs as worldPos / this. */
const WORLD_SCALE: Record<string, number> = {
  tarmac: 3.5, // 96 aggregate cells over 3.5 m ≈ 36 mm chippings
  'tarmac-racing-line': 3.5,
  'tarmac-wet': 3.5,
  cobblestone: 2.4, // 12 setts across ≈ 200 mm, which is what a sett is
  kerb: 2.0, // 4 bands per tile = 500 mm stripes
  sand: 4,
  grass: 3.2,
  dirt: 3,
  'cliff-rock': 4.0, // 1024 over 4 m ≈ 4 mm/texel; ×2.9 and ×8.5 bands carry the 12 m and 34 m form
  'tunnel-bore': 3.2,
  'stone-wall': 3, // 5 × 8 → 600 × 375 mm ashlar blocks
  stucco: 3,
  'roof-tile': 1.1, // 5 pans across ≈ 220 mm barrel tiles
  'wood-plank': 1.2, // 5 boards ≈ 240 mm
  'wood-weathered': 1.2,
  'metal-painted': 1.5,
  chrome: 1,
  rubber: 0.35,
  glass: 1,
  'canvas-awning': 1.8,
  'water-surface': 16,
  concrete: 3,
  marble: 2.5,
  'boost-pad': 6, // one tile = 4 chevrons, sized to the pad itself
  'banner-fabric': 4,
  'palm-bark': 1.0, // 6 × 13 leaf scars ≈ 170 × 77 mm
  'foliage-leaf': 1,
  'palm-frond': 1,
  crowd: 1,
  'tunnel-light': 1,
  neon: 1,
};

const ALIASES: Record<string, MaterialName> = {
  road: 'tarmac',
  asphalt: 'tarmac',
  'racing-line': 'tarmac-racing-line',
  'road-wet': 'tarmac-wet',
  'tunnel-road': 'tarmac-wet',
  cobble: 'cobblestone',
  'kart-paint': 'metal-painted',
  paint: 'metal-painted',
  metal: 'chrome',
  tyre: 'rubber',
  tire: 'rubber',
  water: 'water-surface',
  rock: 'cliff-rock',
  bore: 'tunnel-bore',
  tunnel: 'tunnel-bore',
  leaf: 'foliage-leaf',
  plaster: 'stucco',
};

/** The village pastels from the art bible, in roof-to-wall order. */
export const STUCCO_TINTS = [0xf2c9a0, 0xe8a5a0, 0xf5e2b0, 0xa9c8d4, 0xdcb8d8, 0xefd9c0, 0xd8c6a8, 0xc9d8cf];

interface Entry {
  mat: THREE.Material;
  textures: THREE.Texture[];
}

// module-scope scratch — generators run once but the loops are hot enough to care
const _a: RGB = { r: 0, g: 0, b: 0 };
const _b: RGB = { r: 0, g: 0, b: 0 };
const _c: RGB = { r: 0, g: 0, b: 0 };

// ---------------------------------------------------------------------------
// Shader injections
// ---------------------------------------------------------------------------

/**
 * World-space varyings shared by every injection below.
 *
 * `vWorldP` is the fragment's world position **including the instance matrix**
 * — three applies `instanceMatrix` inside `<project_vertex>`, so a naive
 * `modelMatrix * transformed` at `<begin_vertex>` reports the same position for
 * every instance and any world-space effect collapses to a per-instance repeat.
 * `vInstOrigin` is the instance's own origin, which is the only stable
 * per-instance identity available without a custom attribute.
 */
const WORLD_PARS = /* glsl */ `
varying vec3 vWorldP;
varying float vViewDist;
`;

const WORLD_VERTEX = /* glsl */ `
  vec4 kWP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    kWP = instanceMatrix * kWP;
  #endif
  vWorldP = ( modelMatrix * kWP ).xyz;
  vViewDist = length( ( viewMatrix * vec4( vWorldP, 1.0 ) ).xyz );
`;

/** Per-instance identity, paid for only where a surface actually jitters. */
const INST_PARS = 'varying vec3 vInstOrigin;\n';

const INST_VERTEX = /* glsl */ `
  vec4 kOrg = vec4( 0.0, 0.0, 0.0, 1.0 );
  #ifdef USE_INSTANCING
    kOrg = instanceMatrix * kOrg;
  #endif
  vInstOrigin = ( modelMatrix * kOrg ).xyz;
`;

const WORLD_HASH = /* glsl */ `
vec3 kHash3( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
// One 2D slice of world space that never smears on a vertical surface: folding
// Y into both axes means a wall, a roof pitch and the ground all see the
// variation move as you travel across them.
vec2 kWorldPlane( vec3 p, float period ) {
  return ( p.xz + p.y * 0.71 ) / period;
}
`;

const TRI_COMMON = /* glsl */ `
uniform float uTriScale;
uniform float uTriSharp;
varying vec3 vTriN;
vec3 triWeights() {
  vec3 w = pow( abs( normalize( vTriN ) ), vec3( uTriSharp ) );
  return w / max( 1e-4, w.x + w.y + w.z );
}
`;

/**
 * A hex read as a per-channel **multiplier**, not as a colour.
 *
 * Deliberately not routed through `THREE.Color`: colour management would apply
 * an sRGB→linear transfer, and a transfer curve on a *ratio* is meaningless —
 * 0xb3b3b3 is supposed to mean "70% of whatever is already there", and after a
 * 2.2 gamma it means 45% instead, which is how every tint constant in a library
 * like this ends up hand-tuned to a number nobody can explain.
 *
 * `hueOnly` rescales so the largest channel is 1, giving a pure warm/cool shift
 * with no net gain or loss of energy — right for a colour drift, wrong for a
 * stain, which is supposed to be darker than what it sits on.
 */
function tintMul(hex: number, hueOnly = false): THREE.Vector3 {
  let r = ((hex >> 16) & 255) / 255;
  let g = ((hex >> 8) & 255) / 255;
  let b = (hex & 255) / 255;
  if (hueOnly) {
    const m = Math.max(r, g, b) || 1;
    r /= m;
    g /= m;
    b /= m;
  }
  return new THREE.Vector3(r, g, b);
}

export interface BreakupOpts {
  /** metres of world per cycle of the low-frequency variation */
  period: number;
  /** how hard that variation pushes albedo and roughness */
  strength: number;
  /** second world band, in metres. Defaults to `period * 0.319`. */
  periodB?: number;
  /** ...and its strength. Defaults to `strength * 0.62`. */
  strengthB?: number;

  // --- the macro layer: everything above about a metre -------------------
  /**
   * Albedo multiplier the surface drifts toward on the macro layer's BRIGHT
   * side, and on its dark side. Colour drift across metres, not just value
   * drift: a road that only gets lighter and darker is still one colour of road,
   * and the eye reads one colour of anything as painted.
   */
  macroWarm?: number;
  macroCool?: number;
  /** how far that drift goes, 0..1 */
  macroTint?: number;
  /** roughness swing driven by the same signal as albedo (correlated) */
  macroRough?: number;
  /**
   * The material bakes `Fields.macroB` into its albedo alpha, giving the macro
   * layer a SECOND, independent field. Required by `macroRoughB` and `stain`.
   */
  macroB?: boolean;
  /** metres per cycle of macro B. Defaults to `period * 0.54`. */
  periodMacroB?: number;
  /** roughness swing driven by macro B alone — decorrelated from albedo */
  macroRoughB?: number;
  /**
   * Pooling: oil on tarmac, mud in turf, damp in the shade. Fires on macro B's
   * upper tail only, so it reads as a *thing on* the surface rather than as more
   * variation of it. `[amount, glossGain]` — most stains are glossier than what
   * they sit on, which is what makes them read as wet.
   */
  stain?: [number, number];
  /** albedo multiplier inside the stain */
  stainTint?: number;
  /** the macro-B ramp the stain occupies; tighten it for a harder edge */
  stainRange?: [number, number];
  /**
   * Anisotropic band in the TILE's own UV frame:
   * `[uScale, vScale, albedoAmount, roughAmount]`.
   *
   * The isotropy breaker. World space cannot supply this — the direction a road
   * is worn along is the direction of the road, which is not a world axis and
   * changes every corner. The tile's V axis, however, is laid down the track by
   * `TrackGeometry` (V = distance / worldScale), so a band sampled at a heavily
   * stretched UV scale runs *along the racing line* everywhere on the course,
   * through every corner, for free. On rock, set U and V the other way up and it
   * runs along the bedding instead.
   */
  streak?: [number, number, number, number];

  /**
   * The macro layer's own texture (R = drift, G = pooling, B = anisotropic
   * source). Build it with `this.macroMaps()`.
   */
  macroTex: THREE.Texture;

  /**
   * A vertical gradient measured from the instance's own origin:
   * `[metres, albedoAmount, roughAmount]` plus `heightTintColor`.
   *
   * The splash zone. Every wall in the world is dirtier for the first metre off
   * the ground, every palm trunk is greener and more lichened at its base, and
   * neither fact can live in a tiling texture — the tile does not know which way
   * is up, let alone where the ground is. Nor can it be a world-Y ramp: the
   * village climbs 40 m, so an absolute height would put the splash zone through
   * the middle of the upper terraces. Measured from `vInstOrigin` it is correct
   * on every instance at every elevation, and being baked into albedo it
   * survives every LOD the aerial shot can throw at it.
   *
   * Requires `instUv > 0` (that is what compiles `vInstOrigin` in).
   */
  heightTint?: [number, number, number];
  /** albedo multiplier at the bottom of the `heightTint` ramp */
  heightTintColor?: number;
  /** per-instance UV phase offset, in tiles (0 = off) */
  instUv?: number;
  /** per-instance value/hue jitter, 0..1 (0 = off) */
  instTint?: number;
  /** [near, far] metres over which fine detail settles toward the local mean */
  settle?: [number, number];
  /** roughness the surface converges on past `settle[1]` */
  settleRough?: number;
  /**
   * Second surface variant. The world-space variation cross-fades albedo toward
   * this colour, which is the cheap stand-in for the vertex-colour blend between
   * two grass or two sand variants the bible asks for — and unlike vertex
   * colours it works on geometry somebody else authored.
   */
  variantTint?: number;
  variantAmount?: number;
  /**
   * How hard a *darkening* in the mesh's vertex colours also polishes the
   * surface. The track owns the racing line, the wheel tracks and the shoulder
   * grime as vertex-colour masks, and it can only multiply albedo with them — so
   * a racing line laid down that way is a tint and nothing else. At exposure
   * 1.05 an 8% tint through a corner apex is invisible; the same mask taken to
   * roughness under a 14° key is a sheen you cannot miss. 0 leaves it off, which
   * is right for grass and sand, where a dark vertex colour means wet or shaded,
   * not polished.
   */
  wearGloss?: number;

  /**
   * Hard lower bound on the final roughness, after every multiplier above has
   * had its say.
   *
   * Defaults to 0.025, which is a mirror, and that default is only safe because
   * most materials never stack enough gloss terms to reach it. A road does: the
   * map floor, the two world bands, macro B, the streak, the stain and
   * `wearGloss` are six independent multipliers and they are all capable of
   * pulling the same way at once. Worst case on tarmac was
   * `0.24 · 0.65 · 0.74 · 0.83 · 0.83 · 0.45 ≈ 0.036` — a polished mirror
   * wearing an asphalt albedo, which under a 14° key and a warm-sun /
   * blue-zenith environment is a field of coloured pinpoints. Give every
   * surface a floor that matches what it is made of.
   */
  roughFloor?: number;

  /**
   * Specular antialiasing strength, 0..1 (0 = off, compiled out).
   *
   * Couples the normal map's own slope into roughness (Toksvig-style), eases the
   * relief off toward grazing, and adds a screen-space normal-variance term so a
   * surface the pixel cannot resolve goes rough instead of going to a pinpoint
   * mirror. See the shader block for why a surface with chip-scale relief needs
   * all three.
   */
  specAA?: number;

  /**
   * How hard the macro band also drives the normal map's amplitude.
   *
   * §4 asks for spatially varying roughness; the other half of that ask, and the
   * one nothing in this library was doing, is spatially varying *relief*. A road
   * whose aggregate stands exactly as proud on the polished racing line as it
   * does on the untouched shoulder is one surface with a tint on it, and the eye
   * reads constant relief the same way it reads constant roughness. Positive
   * values make the macro layer's bright side (the unworn, coarse-graded side)
   * the one with deeper relief.
   */
  macroNormal?: number;
}

/**
 * Tiling breakup, per-instance de-duplication and distance settle, in one
 * injection because they all need the same world-space varyings.
 *
 * The variation channel (ORM.a) is sampled in **world space**, not UV space.
 * Sampling it in UV space welds the modulation to each mesh's own UV layout,
 * so a hundred instanced houses get the identical blotch in the identical
 * place — which is precisely the visible-tiling fail the art bible calls out.
 * In world space the modulation is continuous across the whole village and
 * cannot repeat per instance no matter how the UVs were laid out.
 *
 * `settle` fades the fine octave toward a high mip of the same map with
 * distance. Without it the aggregate on a road survives to the horizon at
 * constant on-screen density, which on a moving frame is a shimmering carpet;
 * anisotropic filtering makes this *worse*, because it holds a low mip at
 * exactly the grazing angles a racing camera lives at.
 */
function injectBreakup(mat: THREE.Material, o: BreakupOpts): void {
  const uBreak = {
    value: new THREE.Vector4(
      o.period,
      o.strength,
      o.periodB ?? o.period * 0.319,
      o.strengthB ?? o.strength * 0.62,
    ),
  };
  const warm = tintMul(o.macroWarm ?? 0xffffff, true);
  const cool = tintMul(o.macroCool ?? 0xffffff, true);
  const uMacroA = { value: new THREE.Vector4(warm.x, warm.y, warm.z, o.macroTint ?? 0) };
  const uMacroC = { value: new THREE.Vector4(cool.x, cool.y, cool.z, o.macroRough ?? 0.3) };
  const stainRange = o.stainRange ?? [0.58, 0.94];
  const uMacroB = {
    value: new THREE.Vector4(
      o.periodMacroB ?? o.period * 0.54,
      o.macroRoughB ?? 0,
      stainRange[0],
      stainRange[1],
    ),
  };
  // Not hue-only: a stain carries its own darkening, because that is most of
  // what makes an oil slick or a damp patch read as something *on* the surface.
  const stainT = tintMul(o.stainTint ?? 0x8a8a8a);
  const uStain = { value: new THREE.Vector4(stainT.x, stainT.y, stainT.z, o.stain ? o.stain[0] : 0) };
  const uStainRough = { value: o.stain ? o.stain[1] : 0 };
  const streak = o.streak ?? [0, 0, 0, 0];
  const uStreak = { value: new THREE.Vector4(streak[0], streak[1], streak[2], streak[3]) };
  const uInst = { value: new THREE.Vector2(o.instUv ?? 0, o.instTint ?? 0) };
  const settle = o.settle ?? [1e6, 1e6 + 1];
  const uSettle = { value: new THREE.Vector3(settle[0], settle[1], o.settleRough ?? 0.8) };
  const uVariant = {
    value: new THREE.Vector4(0, 0, 0, 0),
  };
  if (o.variantTint !== undefined) {
    const c = new THREE.Color(o.variantTint).convertSRGBToLinear();
    uVariant.value.set(c.r, c.g, c.b, o.variantAmount ?? 0.5);
  }
  const uWear = { value: o.wearGloss ?? 0 };
  const uRoughFloor = { value: o.roughFloor ?? 0.025 };
  const uSpecAA = { value: o.specAA ?? 0 };
  const uMacroNorm = { value: o.macroNormal ?? 0 };
  const ht = o.heightTint ?? [0, 0, 0];
  const htc = tintMul(o.heightTintColor ?? 0x808080);
  const uHeight = { value: new THREE.Vector4(Math.max(1e-3, ht[0]), ht[1], ht[2], 0) };
  const uHeightC = { value: new THREE.Vector3(htc.x, htc.y, htc.z) };
  const jitters = (o.instUv ?? 0) > 0;
  const heights = (ht[1] !== 0 || ht[2] !== 0) && jitters;
  const settles = !!o.settle;
  const specAA = (o.specAA ?? 0) > 0;
  const wears = (o.wearGloss ?? 0) > 0;
  const uMacroTex = { value: o.macroTex };
  const hasMacroB = !!o.macroB;
  const stains = hasMacroB && !!o.stain && o.stain[0] > 0;
  const streaks = streak[2] !== 0 || streak[3] !== 0;
  const tints = (o.macroTint ?? 0) > 0;

  // Every one of these blocks is a texture fetch or a handful of ALU on the
  // largest surfaces in the frame, so each is compiled in only where its
  // material asked for it. The flags also go in the program cache key.
  const MACRO_B_FETCH = hasMacroB
    ? /* glsl */ `
          // Macro B is its own field on its own world period, so gloss and
          // colour stop being two views of one blob.
          gMacroB = texture2D( uMacroTex, kWorldPlane( vWorldP, uMacroB.x ) + 0.21 ).g;`
    : '';
  const MACRO_TINT = tints
    ? /* glsl */ `
            // Colour drift across metres. Multiplicative and normalised, so it
            // shifts the surface warm or cool without ever adding energy.
            sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uMacroA.rgb, clamp(  kMacro, 0.0, 1.0 ) * uMacroA.a );
            sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uMacroC.rgb, clamp( -kMacro, 0.0, 1.0 ) * uMacroA.a );`
    : '';
  const STAIN_ALBEDO = stains
    ? /* glsl */ `
            gStain = smoothstep( uMacroB.z, uMacroB.w, gMacroB ) * uStain.a;
            sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uStain.rgb, gStain );`
    : '';
  const STAIN_ROUGH = stains
    ? /* glsl */ `
          roughnessFactor *= 1.0 - gStain * uStainRough;`
    : '';
  const STREAK_FETCH = streaks
    ? /* glsl */ `
          // Anisotropic band in the tile's own frame — V runs down the track,
          // so this is the smear of the racing line and it follows every corner.
          gStreak = ( texture2D( uMacroTex, vMapUv * uStreak.xy + vec2( 0.19, 0.57 ) ).b - 0.5 ) * 2.0;`
    : '';
  const STREAK_ALBEDO = streaks
    ? '\n            sampledDiffuseColor.rgb *= 1.0 + gStreak * uStreak.z;'
    : '';
  const STREAK_ROUGH = streaks ? '\n          roughnessFactor *= 1.0 + gStreak * uStreak.w;' : '';
  const MACRO_B_ROUGH = hasMacroB
    ? '\n          roughnessFactor *= 1.0 + ( gMacroB - 0.5 ) * 2.0 * uMacroB.y;'
    : '';
  // Squared, so the last few centimetres against the ground take the brunt of it
  // and the ramp does not read as a painted dado rail a metre up the wall.
  const HEIGHT_SETUP = heights
    ? /* glsl */ `
          gSplash = 1.0 - smoothstep( 0.0, uHeightTint.x, vWorldP.y - vInstOrigin.y );
          gSplash *= gSplash;`
    : '';
  const HEIGHT_ALBEDO = heights
    ? /* glsl */ `
            sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uHeightTintC, gSplash * uHeightTint.y );`
    : '';
  const HEIGHT_ROUGH = heights
    ? '\n          roughnessFactor *= 1.0 + gSplash * uHeightTint.z;'
    : '';

  /**
   * Specular antialiasing, applied where the mapped normal and `roughnessFactor`
   * are both in scope — `<roughnessmap_fragment>` runs at line 15 of the
   * physical main() and `<normal_fragment_maps>` at line 18, with
   * `<lights_physical_fragment>` not consuming either until line 24, so this
   * costs no extra texture fetch.
   *
   * The failure it exists to stop: a 1024² normal map carrying 36 mm chippings
   * puts a near-vertical facet every few texels. Under a 14° key and a *bipolar*
   * golden-hour environment — warm sun and horizon on one side, blue zenith on
   * the other — each of those facets is a pinpoint mirror pointed somewhere
   * random. One catches the sun and lands orange, the one beside it catches the
   * zenith and lands cyan, and the pair average to magenta. That reads as
   * rainbow glitter scattered over the tarmac, and its hue histogram is the
   * giveaway: two clumps, one at 0–30° and one at 210–360°, with the greens and
   * yellows in between completely empty. Independent per-channel albedo noise
   * would have filled every hue evenly. It is aliased specular, not colour.
   *
   * Two terms:
   *
   *  1. Toksvig-ish variance→roughness. The tangent-space normal's own slope is
   *     a direct measure of the sub-texel normal variance the specular lobe is
   *     standing on, so steep texels get their lobe widened instead of being
   *     left as mirrors the sampler has no hope of resolving. Flat texels
   *     measure zero slope and keep exactly the roughness they were authored
   *     with, which is why the polish ribbons and the racing line survive this
   *     untouched.
   *  2. Relief eased off toward grazing. Near head-on, a facet has to tip a long
   *     way to swing the reflection vector off the road; at 15° it has to tip
   *     barely at all, so the same map that reads as aggregate on the bonnet-
   *     level midground reads as sparkle in the near field. Facing geometry
   *     keeps its full chip relief; only the grazing end is calmed.
   *  3. Screen-space normal variance (`SPEC_AA_GEO`, below). 1 and 2 both work
   *     off the normal the sampler *handed back*, so neither of them can see how
   *     much surface a pixel actually covers. That is the term that was missing,
   *     and it is the one the guardrail needed: an Armco rail at 60 m packs
   *     several centimetres of rolled profile and three mip levels of scratch
   *     normal into one pixel, and a 0.3-roughness lobe standing on that is a
   *     sub-pixel mirror. Three already does this for the *geometric* normal
   *     (`geometryRoughness` in `lights_physical_fragment`), which is why a bare
   *     cylinder does not strobe and a normal-mapped one does — the perturbed
   *     normal is excluded from that measurement. This applies the same
   *     Kaplanyan filtering to the perturbed normal, so it composes with three's
   *     own term rather than fighting it.
   */
  const SPEC_AA = specAA
    ? /* glsl */ `
            float kSlope = clamp( 1.0 - mapN.z * inversesqrt( max( dot( mapN, mapN ), 1e-6 ) ), 0.0, 1.0 );
            float kGraze = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
            mapN.xy *= mix( 1.0 - uSpecAA * 0.55, 1.0, sqrt( kGraze ) );
            roughnessFactor = clamp(
              roughnessFactor + kSlope * uSpecAA * ( 0.55 - 0.30 * kGraze ), 0.0, 1.0 );`
    : '';

  // Runs OUTSIDE the tangent-space block, on the final shading normal, so it
  // fires on geometry with no normal map at all — a thin painted rail read
  // across two pixels aliases on its own curvature. Capped: past ~0.4 of added
  // roughness the surface has stopped being the material it was authored as.
  const SPEC_AA_GEO = specAA
    ? /* glsl */ `
          {
            vec3 kNDxy = max( abs( dFdx( normal ) ), abs( dFdy( normal ) ) );
            gSpecVar = min( max( max( kNDxy.x, kNDxy.y ), kNDxy.z ) * uSpecAA * 1.6, 0.42 );
            roughnessFactor = min( roughnessFactor + gSpecVar, 1.0 );
          }`
    : '';

  const WEAR_GLOSS = wears
    ? /* glsl */ `
          #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
            // luminance the mesh has taken *out* of the surface = how polished it
            // is. Racing line and wheel tracks come down the same channel.
            float kPolish = clamp( 1.0 - dot( vColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );
            // ...breathed along its own length by the two world bands, because a
            // wear mask laid down at a constant lateral coordinate is a straight
            // line, and a straight line of constant gloss is a UV seam, not wear.
            float kPolishAmt = uWearGloss * ( 0.72 + ( gBreak + gBreak2 ) * 0.34 );
            roughnessFactor *= 1.0 - clamp( kPolish * kPolishAmt, 0.0, 0.55 );
          #endif`
    : '';
  // Compiled in only where it is asked for: a second variant costs a texture
  // fetch and most surfaces do not need one.
  const VARIANT_BLEND =
    o.variantTint === undefined
      ? ''
      : /* glsl */ `
            {
              // second variant, keyed off a world signal on a different period
              // from the tile — the repeat can still be measured but never seen
              float kV = texture2D( uMacroTex, kWorldPlane( vWorldP, uBreak.x * 1.63 ) + 0.37 ).r;
              float kL = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
              sampledDiffuseColor.rgb = mix(
                sampledDiffuseColor.rgb,
                uVariant.xyz * ( 0.55 + kL * 1.1 ),
                smoothstep( 0.42, 0.80, kV ) * uVariant.w );
            }`;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;

  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uBreak = uBreak;
    shader.uniforms.uInstJit = uInst;
    shader.uniforms.uSettle = uSettle;
    shader.uniforms.uVariant = uVariant;
    shader.uniforms.uWearGloss = uWear;
    shader.uniforms.uRoughFloor = uRoughFloor;
    shader.uniforms.uSpecAA = uSpecAA;
    shader.uniforms.uMacroNorm = uMacroNorm;
    shader.uniforms.uMacroA = uMacroA;
    shader.uniforms.uMacroC = uMacroC;
    shader.uniforms.uMacroB = uMacroB;
    shader.uniforms.uStain = uStain;
    shader.uniforms.uStainRough = uStainRough;
    shader.uniforms.uStreak = uStreak;
    shader.uniforms.uMacroTex = uMacroTex;
    shader.uniforms.uHeightTint = uHeight;
    shader.uniforms.uHeightTintC = uHeightC;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS + (jitters ? INST_PARS : ''))
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + WORLD_VERTEX + (jitters ? INST_VERTEX : ''),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
          WORLD_PARS +
          (jitters ? INST_PARS : '') +
          WORLD_HASH +
          'uniform vec4 uBreak;\nuniform vec2 uInstJit;\nuniform vec3 uSettle;\nuniform vec4 uVariant;\n' +
          'uniform float uWearGloss;\nuniform float uRoughFloor;\nuniform float uSpecAA;\n' +
          'uniform float uMacroNorm;\nfloat gSpecVar = 0.0;\n' +
          'uniform vec4 uMacroA;\nuniform vec4 uMacroC;\nuniform vec4 uMacroB;\n' +
          'uniform vec4 uStain;\nuniform float uStainRough;\nuniform vec4 uStreak;\n' +
          'uniform sampler2D uMacroTex;\nuniform vec4 uHeightTint;\nuniform vec3 uHeightTintC;\n' +
          'float gBreak = 0.0;\nfloat gBreak2 = 0.0;\nfloat gSettle = 0.0;\nvec2 gUvJit = vec2( 0.0 );\n' +
          'float gMacroB = 0.5;\nfloat gStain = 0.0;\nfloat gStreak = 0.0;\nfloat gSplash = 0.0;\n',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          ${jitters ? 'vec3 kIH = kHash3( floor( vInstOrigin * 3.7 ) + 0.5 );' : 'vec3 kIH = vec3( 0.5 );'}
          gUvJit = ( kIH.xy - 0.5 ) * uInstJit.x;
          gSettle = smoothstep( uSettle.x, uSettle.y, vViewDist );
          // The macro layer, read in WORLD space off its own small map. World
          // space and not UV space because a variation welded to each mesh's UV
          // layout repeats once per instance and once per tile, which is the
          // visible-tiling fail the bible calls out; in world space it is
          // continuous across the whole course and cannot repeat at all.
          gBreak = ( texture2D( uMacroTex, kWorldPlane( vWorldP, uBreak.x ) ).r - 0.5 ) * 2.0 * uBreak.y;
          // Second band at a deliberately non-integer fraction of the first, so
          // the two never come back into phase. One band at ~30 m leaves
          // consecutive 3.5 m tiles in the near field identical to each other;
          // this is the ~9 m decade that stops that, and it is the one the
          // camera is actually close enough to read.
          gBreak2 = ( texture2D( uMacroTex, kWorldPlane( vWorldP, uBreak.z ) + 0.63 ).r - 0.5 )
                    * 2.0 * uBreak.w;${MACRO_B_FETCH}${HEIGHT_SETUP}
          #ifdef USE_MAP
            ${STREAK_FETCH}
            vec4 sampledDiffuseColor = texture2D( map, vMapUv + gUvJit );
            // settle: past the ramp the fine octave is replaced by its own local
            // mean, so the far field resolves to a clean value instead of crawling
            sampledDiffuseColor = mix( sampledDiffuseColor, textureLod( map, vMapUv + gUvJit, 5.5 ), gSettle );
            sampledDiffuseColor.a = 1.0;
            float kMacro = gBreak + gBreak2;
            sampledDiffuseColor.rgb *= 1.0 + kMacro * 0.30;${MACRO_TINT}${STAIN_ALBEDO}${STREAK_ALBEDO}${HEIGHT_ALBEDO}
            sampledDiffuseColor.rgb *= vec3( 1.0 ) + ( kIH.zxy - 0.5 ) * vec3( 1.0, 0.55, 0.8 ) * uInstJit.y;
${VARIANT_BLEND}
            diffuseColor *= sampledDiffuseColor;
          #endif
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv + gUvJit ).g;
          roughnessFactor = mix( roughnessFactor, uSettle.z, gSettle );
          // The world bands are applied AFTER the settle, not before it. Before
          // it, the far field converged on one constant roughness — which on the
          // largest surface in frame, lit by a 14° key, is exactly the uniform
          // plastic sheet the bible names as the #1 amateur tell, and it killed
          // the long grazing sun sheen down the road in every frame.
          //
          // Roughness has to carry the macro layer as hard as albedo does, and
          // partly from a DIFFERENT field. A metre-scale blotch that modulates
          // colour alone still lights like a flat sheet, because the specular
          // response — the only thing a 14° key can rake across — never changed.
          roughnessFactor *= 1.0 + ( gBreak + gBreak2 ) * uMacroC.w;${MACRO_B_ROUGH}${STREAK_ROUGH}${STAIN_ROUGH}${HEIGHT_ROUGH}
          // The floor is per material now. 0.025 is a mirror, and six
          // independent gloss multipliers stacked above can and do reach it.
          roughnessFactor = clamp( roughnessFactor, uRoughFloor, 1.0 );
        #endif${WEAR_GLOSS}
        // ...and again after the wear gloss, which is applied outside the
        // roughness-map block and is itself worth a 0.45x multiplier. Flooring
        // only inside the block left the polished racing line — the one place
        // every gloss term pulls the same way — as the single glossiest thing
        // in the frame, which is exactly backwards.
        roughnessFactor = clamp( roughnessFactor, uRoughFloor, 1.0 );`,
      );

    if (jitters || settles || specAA || (o.macroNormal ?? 0) > 0) {
      shader.fragmentShader = shader.fragmentShader
        // `onBeforeCompile` runs BEFORE three resolves `#include`, so a replace
        // aimed at text that lives inside a chunk never matches and fails
        // silently. This one was aimed at `texture2D( aoMap, vAoMapUv )`, which
        // is inside `<aomap_fragment>` — so the per-instance UV jitter has never
        // reached the AO channel on any instanced surface in the game, and the
        // AO has been sampling an un-jittered phase while albedo, roughness and
        // normal sampled a jittered one. Splice the library's own chunk text in
        // instead: version-proof, and it cannot go quiet again.
        .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('vAoMapUv', 'vAoMapUv + gUvJit'))
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 mapN = texture2D( normalMap, vNormalMapUv + gUvJit ).xyz * 2.0 - 1.0;
            // relief has to go with the detail it belongs to, or the far road
            // keeps a normal map it has no albedo left to justify
            // ...and it also has to go with the macro layer. Constant relief
            // across a surface is the same tell as constant roughness: the
            // aggregate stands equally proud on the polished line and on the
            // untouched shoulder, which is the one thing worn asphalt never does.
            mapN.xy *= normalScale * ( 1.0 - gSettle * 0.85 )
                     * clamp( 1.0 + ( gBreak + gBreak2 ) * uMacroNorm, 0.25, 1.9 );${SPEC_AA}
            normal = normalize( tbn * mapN );
          #endif${SPEC_AA_GEO}`,
        );
    }
    if (specAA) {
      // Clearcoat carries its own, much tighter lobe, and a tight lobe is
      // exactly the one that aliases first. Three floors it at 0.0525 and adds
      // `geometryRoughness` — but that is measured on the *unperturbed* normal,
      // so a coat riding a normal map is invisible to it. Add the perturbed
      // variance to the same sum.
      //
      // Appended AFTER the include rather than edited inside it, for the same
      // reason as the aoMap patch above: this hook sees `#include` directives,
      // not chunk bodies, so anything aimed at the chunk's text silently does
      // nothing. `lights_physical_fragment` runs after `normal_fragment_maps`,
      // so `gSpecVar` is already set by the time this reads it.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `
        #include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoatRoughness = min( material.clearcoatRoughness + gSpecVar, 1.0 );
        #endif`,
      );
    }
  };

  const key =
    `brk3${o.period}_${o.strength}_${o.instUv ?? 0}_${o.instTint ?? 0}` +
    `_${settles ? settle.join(',') : 'x'}_${o.variantTint ?? 'x'}_${o.wearGloss ?? 0}` +
    `_${heights ? ht.join(',') : 'x'}` +
    `_${hasMacroB ? 1 : 0}${stains ? 1 : 0}${streaks ? 1 : 0}${tints ? 1 : 0}${specAA ? 1 : 0}` +
    `_${o.macroNormal ?? 0}`;
  // Chained, not assigned. Three keys its program cache on the material's
  // parameters plus this string, and it has no way to see an `onBeforeCompile`;
  // so two materials that differ ONLY in which injections they carry — dry
  // tarmac and the tunnel's wet tarmac are exactly that pair, identical
  // breakup options and different env handling — would hash to one key and the
  // second would be handed the first one's compiled program.
  mat.customProgramCacheKey =
    prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey
      ? () => prevKey.call(mat) + key
      : () => key;
}

export interface TriplanarOpts {
  /** metres of world covered by one tile of the detail octave */
  worldScale: number;
  /**
   * Projection blend exponent. Too low and the X and Z projections cross-fade
   * over most of a curved surface, which is not a blend — it is two copies of a
   * directional noise sliding past each other, and it reads as fur. A tunnel
   * bore or a boulder needs one dominant projection almost everywhere.
   */
  sharpness: number;
  /** metres per cycle of the low-frequency variation */
  period: number;
  /**
   * How many times larger the macro form octave is than the detail octave.
   * Deliberately non-integer so the two never come back into phase.
   */
  macro: number;
  /** how hard the macro octave tips the surface normal */
  macroRelief: number;
  /**
   * Middle band multiple. A 40 m cliff built from a 4 m tile and a 34 m macro
   * has a hole in its frequency ladder exactly where a boulder, a bedding step
   * or a shadowed recess would live — and a surface with nothing between 60 cm
   * and 30 m reads as sandpaper on a ramp no matter how good either end is.
   * Omit to skip the band entirely (three taps).
   */
  mid?: number;
  midRelief?: number;
  /**
   * Amplitude of the detail octave relative to the form bands, 0..1.
   *
   * This is the ratio that decides whether a rock face reads as rock or as
   * sandpaper, and it is not "how much detail" — it is "how much detail
   * *against* the form". A 4 mm octave at full strength on a 40 m face wins the
   * eye outright no matter how much metre-scale relief sits under it, because
   * its per-pixel contrast is an order higher. Under 1 the form bands lead and
   * the detail becomes what it should be: the last decade of scale.
   */
  detailRelief?: number;
  /**
   * Crown/haunch/springline separation for a bore, driven by the *geometric*
   * normal's world Y — a tunnel ceiling faces down, its floor faces up, and no
   * noise field knows that. x = albedo swing, y = roughness swing.
   */
  boreGradient?: [number, number];
  /** [near, far] metres over which the ALBEDO tile settles toward its local mean */
  settle?: [number, number];
  /**
   * [near, far] for the DETAIL NORMAL octave alone. Defaults to `settle`.
   *
   * These two ramps want to be an octave apart and used not to be, which is why
   * the cliff failed in both directions at once. The 4 mm chip relief is the only
   * band small enough to alias, and on a 40 m face viewed from a chase camera it
   * is sub-texel by about 25 m — held at full amplitude to 70 m it is the crawl
   * the review called dither. The *albedo* is the opposite case: fading it early
   * is what turns a headland into a flat orange silhouette at 150 m, because the
   * macro colour bands are the only thing left saying "rock" out there. So the
   * detail normal now dies by ~45 m and the albedo tile holds to ~250 m.
   */
  settleDetail?: [number, number];
  /**
   * Macro ALBEDO bands: `[macroAmount, breakAmount]`.
   *
   * The single thing that separates a rock face from a bump map on a ramp. The
   * form bands have always been pushed into the NORMAL only, so the whole 40 m
   * face came out as one bleached tone with all of its structure in relief —
   * which means the moment a bed turns away from a 14° key it stops existing.
   * Rock reads as rock because different beds are *different colours*.
   *
   * `macroAmount` re-reads the albedo map at the macro band's own scale (34 m on
   * the cliff) and applies it as a colour ratio, so a 34 m zone of the tile's own
   * palette lands on the face at 34 m. It is a ratio and not a sample, so it
   * cannot double the saturation or drift off-palette.
   *
   * `breakAmount` cross-fades toward a *second* read of the same map at a
   * non-integer tile multiple (`albedoBreakScale`, default 1.37×), masked by the
   * low-frequency world band. Two incommensurate tilings blended by a third
   * frequency have no common period, which is what kills the near-field repeat
   * §9.6 calls an automatic fail.
   */
  albedoBands?: [number, number];
  /** non-integer tile multiple for the albedo phase break. Default 1.37. */
  albedoBreakScale?: number;
  /**
   * Warm bounce fill, `[hex, intensity]`.
   *
   * §9.6 forbids pure-black shadows and §2 specifies the bounce that stops them:
   * warm sand/stone from below at `#c98f5a`. Inside a tunnel bore there is no
   * sky to fill with, so the unlit half of the bore was measuring a 5th
   * percentile of 5/255 — genuine black with the albedo entirely gone. This is a
   * flat, albedo-multiplied lift, so it returns the rock's own colour to the
   * shade rather than washing grey over it.
   */
  bounce?: [number, number];
  /**
   * World-space sedimentary bedding.
   *
   * This is the piece that no amount of resampling a tile at bigger scales can
   * ever supply, and its absence is why a 40 m sea cliff built out of three
   * bands of the same isotropic noise still reads as a lumpy ramp rather than as
   * rock. Strata are *world horizontal*: they run level across the whole face
   * regardless of how it folds, they are the same height above sea level on the
   * headland as they are in the tunnel cut, and every one of them is a different
   * hardness, so each weathers back a different distance and takes the light
   * differently. A noise field cannot know any of that. Two dozen ALU can.
   *
   * `thickness` is the bed height in metres; `tone` and `rough` are the
   * per-bed swings; `relief` tips the surface normal into a ledge at each
   * bedding plane; `dip` tilts the beds so they are not a spirit level; `warp`
   * lets them wander by that many metres so they are not a ruler either.
   */
  strata?: {
    thickness: number;
    tone: number;
    rough: number;
    relief: number;
    warp?: number;
    dip?: [number, number];
    /** albedo multiplier of the pale/ochre beds */
    tint?: number;
    tintAmount?: number;
  };
  /** macro-scale colour drift: albedo multipliers on the bright and dark side */
  macroWarm?: number;
  macroCool?: number;
  macroTint?: number;
  /** the macro layer's own map (R = drift). Build it with `this.macroMaps()`. */
  macroTex: THREE.Texture;
}

/**
 * World-space triplanar projection with whiteout normal blending, at two
 * scales. Used on cliff rock and the tunnel bore, where the geometry has no
 * sane UV layout and any planar mapping smears down a 40 m rock face.
 *
 * Three bands, not one. A 1024² tile at 4 m carries 4 mm to ~60 cm and nothing
 * else; a 40 m sea cliff wearing only that is sandpaper on a low-poly ramp, and
 * because the only spatial frequency present sits above the mip cutoff it also
 * dissolves into flat tinted mush by 25 m. Resampling the *same* normal map at
 * `mid`× (~10 m) and `macro`× (~34 m) the scale costs six taps and supplies the
 * two missing decades — the boulder and the bedding step — so the same material
 * has structure at 4 mm, 30 cm, 10 m and 34 m and the 14° key has something to
 * rake across at every one of them.
 */
function injectTriplanar(mat: THREE.Material, o: TriplanarOpts): void {
  const uScale = { value: 1 / o.worldScale };
  const uSharp = { value: o.sharpness };
  const uMacro = { value: new THREE.Vector3(1 / (o.worldScale * o.macro), o.macroRelief, o.period) };
  const uMid = {
    value: new THREE.Vector3(1 / (o.worldScale * (o.mid ?? 1)), o.midRelief ?? 0, o.detailRelief ?? 1),
  };
  const bore = o.boreGradient ?? [0, 0];
  const uBore = { value: new THREE.Vector2(bore[0], bore[1]) };
  const settle = o.settle ?? [1e6, 1e6 + 1];
  const uSettle = { value: new THREE.Vector2(settle[0], settle[1]) };
  const settleD = o.settleDetail ?? settle;
  const bands = o.albedoBands ?? [0, 0];
  const uAlbBands = {
    value: new THREE.Vector4(bands[0], bands[1], 1 / (o.albedoBreakScale ?? 1.37), settleD[0]),
  };
  const uSettleD = { value: new THREE.Vector2(settleD[0], settleD[1]) };
  const bounceC = new THREE.Color(o.bounce ? o.bounce[0] : 0xffffff).convertSRGBToLinear();
  const uBounce = {
    value: new THREE.Vector4(bounceC.r, bounceC.g, bounceC.b, o.bounce ? o.bounce[1] : 0),
  };
  const hasMid = o.mid !== undefined && (o.midRelief ?? 0) > 0;
  const hasBore = bore[0] !== 0 || bore[1] !== 0;
  const hasBands = bands[0] > 0 || bands[1] > 0;
  const hasBounce = !!o.bounce && o.bounce[1] > 0;

  const st = o.strata;
  const uStrata = { value: new THREE.Vector4(st?.thickness ?? 1, st?.tone ?? 0, st?.rough ?? 0, st?.relief ?? 0) };
  const dip = st?.dip ?? [0.06, -0.041];
  const uStrataDip = { value: new THREE.Vector3(dip[0], dip[1], st?.warp ?? 0) };
  const bedTint = tintMul(st?.tint ?? 0xffffff, true);
  const uStrataTint = { value: new THREE.Vector4(bedTint.x, bedTint.y, bedTint.z, st?.tintAmount ?? 0) };
  const triWarm = tintMul(o.macroWarm ?? 0xffffff, true);
  const triCool = tintMul(o.macroCool ?? 0xffffff, true);
  const uTriWarm = { value: new THREE.Vector4(triWarm.x, triWarm.y, triWarm.z, o.macroTint ?? 0) };
  const uTriCool = { value: new THREE.Vector3(triCool.x, triCool.y, triCool.z) };
  const hasStrata = !!st && (st.tone > 0 || st.rough > 0 || st.relief > 0);
  const hasTriTint = (o.macroTint ?? 0) > 0;
  const uMacroTex = { value: o.macroTex };

  // Beds are found from the world Y of the fragment, tilted by `dip` and pushed
  // around by the macro band so a bedding plane is a wandering line and not a
  // contour. `floor` gives a stable per-bed id to hash, which is what lets one
  // bed be a hard pale limestone and the next a soft dark marl.
  const STRATA_SETUP = hasStrata
    ? /* glsl */ `
        {
          float kSY = vWorldP.y + vWorldP.x * uStrataDip.x + vWorldP.z * uStrataDip.y
                    + gBreak * uStrataDip.z;
          float kS = kSY / uStrata.x;
          gBedF = fract( kS );
          vec3 kBH = kHash3( vec3( floor( kS ) * 1.37 + 4.2, 5.1, 2.3 ) );
          gBedTone = ( kBH.x - 0.5 ) * 2.0;
          gBedRough = ( kBH.y - 0.5 ) * 2.0;
          gBedHard = kBH.z;
          // thin recessive bedding planes: the shadow line between two beds is
          // most of what reads as layering from 40 m away
          gBedPlane = max( smoothstep( 0.12, 0.0, gBedF ), smoothstep( 0.88, 1.0, gBedF ) );
        }`
    : '';
  const STRATA_ALBEDO = hasStrata
    ? /* glsl */ `
          sampledDiffuseColor.rgb *= 1.0 + gBedTone * uStrata.y - gBedPlane * uStrata.y * 1.15;
          sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uStrataTint.rgb,
                                          clamp( gBedTone, 0.0, 1.0 ) * uStrataTint.a );`
    : '';
  const STRATA_ROUGH = hasStrata
    ? /* glsl */ `
          roughnessFactor *= 1.0 + gBedRough * uStrata.z + gBedPlane * uStrata.z * 0.8;`
    : '';
  // The ledge itself. A bed weathers back to a shallow overhang, so the normal
  // has to lean over the top of each bed and tuck under its base — a value break
  // alone paints a stripe on a smooth ramp and the eye is not fooled for a frame.
  const STRATA_NORMAL = hasStrata
    ? /* glsl */ `
          {
            vec3 kUpT = vec3( 0.0, 1.0, 0.0 ) - triWorldN * triWorldN.y;
            float kUL = length( kUpT );
            if ( kUL > 1e-3 ) {
              float kLedge = cos( gBedF * 6.2831853 ) * ( 0.45 + gBedHard * 1.05 );
              triWorldN = normalize( triWorldN - ( kUpT / kUL ) * kLedge * uStrata.w );
            }
          }`
    : '';
  const TRI_TINT = hasTriTint
    ? /* glsl */ `
          sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uTriWarm.rgb, clamp(  gBreak, 0.0, 1.0 ) * uTriWarm.a );
          sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), uTriCool.rgb, clamp( -gBreak, 0.0, 1.0 ) * uTriWarm.a );`
    : '';

  // The middle band is three taps, so it is compiled in only where it is asked
  // for. Both extra bands deliberately skip the distance settle: settling the
  // form octave is what left the far cliff as flat tinted mush, because the only
  // thing surviving to 60 m was the band that carries no shape.
  const MID_BAND = hasMid
    ? /* glsl */ `
          tnX.xy += ( texture2D( normalMap, gTriX * dScale ).xy * 2.0 - 1.0 ) * uTriMid.y;
          tnY.xy += ( texture2D( normalMap, gTriY * dScale ).xy * 2.0 - 1.0 ) * uTriMid.y;
          tnZ.xy += ( texture2D( normalMap, gTriZ * dScale ).xy * 2.0 - 1.0 ) * uTriMid.y;`
    : '';

  const BORE_ALBEDO = hasBore
    ? /* glsl */ `
          sampledDiffuseColor.rgb *= 1.0 + ( gCrown * 0.17 - gFloorLine * 0.30 ) * uBore.x;`
    : '';

  /**
   * The macro albedo bands. See `albedoBands` for why the form had to stop being
   * a normal-map-only story.
   *
   * The reference is `textureLod( map, vec2( 0.5 ), 12.0 )` — the 1×1 mip, i.e.
   * the tile's own mean colour. Dividing the macro read by it turns a colour
   * *sample* into a colour *ratio* centred on 1.0, which is what lets the band be
   * applied multiplicatively without ever pushing the surface off its palette or
   * doubling its saturation. A straight `mix` toward the sample would do both.
   */
  const ALBEDO_BANDS = hasBands
    ? /* glsl */ `
          {
            vec3 kTileMean = textureLod( map, vec2( 0.5 ), 12.0 ).rgb + 1e-4;
            if ( uAlbBands.y > 0.0 ) {
              // second tiling at a non-integer multiple, cross-faded by the
              // low-frequency world band: no common period, so no visible repeat
              vec2 kBS = vec2( uAlbBands.z );
              vec3 kAlt = texture2D( map, gTriX * kBS ).rgb * gTriW.x
                        + texture2D( map, gTriY * kBS ).rgb * gTriW.y
                        + texture2D( map, gTriZ * kBS ).rgb * gTriW.z;
              sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, kAlt,
                smoothstep( -0.30, 0.42, gBreak2 ) * uAlbBands.y );
            }
            if ( uAlbBands.x > 0.0 ) {
              vec2 kMS = vec2( uTriMacro.x / uTriScale );
              vec3 kMac = texture2D( map, gTriX * kMS ).rgb * gTriW.x
                        + texture2D( map, gTriY * kMS ).rgb * gTriW.y
                        + texture2D( map, gTriZ * kMS ).rgb * gTriW.z;
              sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), kMac / kTileMean, uAlbBands.x );
            }
          }`
    : '';

  // Shadow floor. Flat and albedo-multiplied on purpose: the rock keeps its own
  // hue in shade instead of being washed toward the fill colour, and nothing in
  // the frame can reach zero.
  const BOUNCE = hasBounce
    ? /* glsl */ `
        #include <lights_fragment_end>
        reflectedLight.indirectDiffuse += uBounce.rgb * uBounce.a * material.diffuseColor;`
    : '';
  const BORE_ROUGH = hasBore
    ? /* glsl */ `
          roughnessFactor *= 1.0 + ( gCrown * 0.13 - gFloorLine * 0.36 ) * uBore.y;`
    : '';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = uScale;
    shader.uniforms.uTriSharp = uSharp;
    shader.uniforms.uTriMacro = uMacro;
    shader.uniforms.uTriMid = uMid;
    shader.uniforms.uBore = uBore;
    shader.uniforms.uSettle = uSettle;
    shader.uniforms.uSettleD = uSettleD;
    shader.uniforms.uAlbBands = uAlbBands;
    shader.uniforms.uBounce = uBounce;
    shader.uniforms.uStrata = uStrata;
    shader.uniforms.uStrataDip = uStrataDip;
    shader.uniforms.uStrataTint = uStrataTint;
    shader.uniforms.uTriWarm = uTriWarm;
    shader.uniforms.uTriCool = uTriCool;
    shader.uniforms.uMacroTex = uMacroTex;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS + '\nvarying vec3 vTriN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' +
          WORLD_VERTEX +
          /* glsl */ `
        vec3 kON = objectNormal;
        #ifdef USE_INSTANCING
          kON = mat3( instanceMatrix ) * kON;
        #endif
        vTriN = normalize( mat3( modelMatrix ) * kON );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
          WORLD_PARS +
          WORLD_HASH +
          TRI_COMMON +
          '\nuniform vec3 uTriMacro;\nuniform vec3 uTriMid;\nuniform vec2 uBore;\nuniform vec2 uSettle;\n' +
          'uniform vec2 uSettleD;\nuniform vec4 uAlbBands;\nuniform vec4 uBounce;\n' +
          'uniform vec4 uStrata;\nuniform vec3 uStrataDip;\nuniform vec4 uStrataTint;\n' +
          'uniform vec4 uTriWarm;\nuniform vec3 uTriCool;\nuniform sampler2D uMacroTex;\n' +
          'float gBreak = 0.0;\nfloat gBreak2 = 0.0;\nfloat gSettle = 0.0;\nfloat gSettleD = 0.0;\nfloat gCavity = 1.0;\n' +
          'float gFace = 1.0;\nfloat gCrown = 0.0;\nfloat gFloorLine = 0.0;\n' +
          'float gBedF = 0.0;\nfloat gBedTone = 0.0;\nfloat gBedRough = 0.0;\n' +
          'float gBedPlane = 0.0;\nfloat gBedHard = 0.5;\n' +
          'vec3 gTriW = vec3( 0.0, 1.0, 0.0 );\n' +
          'vec2 gTriX = vec2( 0.0 );\nvec2 gTriY = vec2( 0.0 );\nvec2 gTriZ = vec2( 0.0 );\n',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        gTriW = triWeights();
        gTriX = vWorldP.zy * uTriScale;
        gTriY = vWorldP.xz * uTriScale;
        gTriZ = vWorldP.xy * uTriScale;
        gSettle = smoothstep( uSettle.x, uSettle.y, vViewDist );
        // The detail octave gets its own, much earlier ramp — see settleDetail.
        gSettleD = smoothstep( uSettleD.x, uSettleD.y, vViewDist );
        // 1 head-on, 0 edge-on. A detail octave held at full amplitude where the
        // surface runs away from the camera is the crawl on the tunnel wall: the
        // texel footprint is a long thin sliver the mip chain cannot represent.
        vec3 kTriN = normalize( vTriN );
        gFace = abs( dot( kTriN, normalize( cameraPosition - vWorldP ) ) );
        // Crown faces down, floor faces up. This is geometry, not noise, and it
        // is the only thing that can tell a bore's ceiling from its floor line.
        gCrown = smoothstep( 0.0, 0.7, -kTriN.y );
        gFloorLine = smoothstep( 0.0, 0.7, kTriN.y );
        gBreak = ( texture2D( uMacroTex, kWorldPlane( vWorldP, uTriMacro.z ) ).r - 0.5 ) * 2.0;
        // second world band at a deliberately non-integer fraction of the
        // first: this is the ~7-9 m decade, the one that makes a rock cut read
        // as having zones rather than as one tone with texture on it
        gBreak2 = ( texture2D( uMacroTex, kWorldPlane( vWorldP, uTriMacro.z * 0.29 ) + 0.41 ).r - 0.5 ) * 2.0;${STRATA_SETUP}
        #ifdef USE_MAP
          vec4 sampledDiffuseColor =
            texture2D( map, gTriX ) * gTriW.x + texture2D( map, gTriY ) * gTriW.y + texture2D( map, gTriZ ) * gTriW.z;
          sampledDiffuseColor = mix( sampledDiffuseColor, textureLod( map, gTriY, 5.5 ), gSettle * 0.65 );
          sampledDiffuseColor.a = 1.0;${ALBEDO_BANDS}
          sampledDiffuseColor.rgb *= 1.0 + gBreak * 0.34 + gBreak2 * 0.22;${TRI_TINT}${STRATA_ALBEDO}${BORE_ALBEDO}
          diffuseColor *= sampledDiffuseColor;
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          vec4 triR = texture2D( roughnessMap, gTriX ) * gTriW.x + texture2D( roughnessMap, gTriY ) * gTriW.y +
                      texture2D( roughnessMap, gTriZ ) * gTriW.z;
          gCavity = triR.r;
          roughnessFactor *= triR.g * ( 1.0 + gBreak * 0.24 + gBreak2 * 0.16 );
          // damp collects low and in the shade: the floor line of a rock cut is
          // always darker and glossier than its crown, and that split is most of
          // what tells you the surface is stone and not carpet
          roughnessFactor *= 1.0 - ( 1.0 - gCavity ) * 0.30;${STRATA_ROUGH}${BORE_ROUGH}
          roughnessFactor = clamp( roughnessFactor, 0.04, 1.0 );
        #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec2 mScale = vec2( uTriMacro.x / uTriScale );
          vec2 dScale = vec2( uTriMid.x / uTriScale );
          // Detail octave. This is the ONLY band allowed to fade — with distance
          // and with grazing angle — because it is the only one small enough to
          // alias. Fading the form bands with it is what collapsed everything
          // past 25 m into flat tinted mush.
          // 0.72 left a quarter of the chip relief alive at any distance, which on
          // a face that runs to 200 m is a permanent carpet of sub-texel facets.
          // It goes to 0.92 on its own early ramp; the mid and macro bands below
          // are untouched and are what carries the face past the fade.
          float kDet = uTriMid.z * ( 1.0 - gSettleD * 0.92 ) * mix( 0.40, 1.0, smoothstep( 0.10, 0.46, gFace ) );
          vec3 tnX = texture2D( normalMap, gTriX ).xyz * 2.0 - 1.0;
          vec3 tnY = texture2D( normalMap, gTriY ).xyz * 2.0 - 1.0;
          vec3 tnZ = texture2D( normalMap, gTriZ ).xyz * 2.0 - 1.0;
          tnX.xy *= kDet; tnY.xy *= kDet; tnZ.xy *= kDet;${MID_BAND}
          // macro octave: the same map at a non-integer multiple of the scale,
          // supplying the metre-scale form the detail tile is too small to hold
          tnX.xy += ( texture2D( normalMap, gTriX * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          tnY.xy += ( texture2D( normalMap, gTriY * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          tnZ.xy += ( texture2D( normalMap, gTriZ * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          vec2 nsc = normalScale;
          tnX.xy *= nsc; tnY.xy *= nsc; tnZ.xy *= nsc;
          vec3 gN = normalize( vTriN );
          // whiteout blend: add the geometric normal in, keep z positive, reswizzle per axis
          tnX = vec3( tnX.xy + gN.zy, abs( tnX.z ) * gN.x );
          tnY = vec3( tnY.xy + gN.xz, abs( tnY.z ) * gN.y );
          tnZ = vec3( tnZ.xy + gN.xy, abs( tnZ.z ) * gN.z );
          vec3 triWorldN = normalize( tnX.zyx * gTriW.x + tnY.xzy * gTriW.y + tnZ.xyz * gTriW.z );${STRATA_NORMAL}
          normal = normalize( ( viewMatrix * vec4( triWorldN, 0.0 ) ).xyz );
        #endif
        {
          // Specular antialiasing on the assembled normal. Three's own
          // geometryRoughness only measures the *unperturbed* normal, so a
          // triplanar surface — where four normal-map bands and a strata term
          // are summed per pixel — is invisible to it. Nine taps of relief on a
          // rock face 200 m away is nine taps of sub-pixel facet; measuring the
          // per-pixel spread of the result and widening the lobe by it is the
          // difference between a distant headland and a crawling dither.
          vec3 kTriDxy = max( abs( dFdx( normal ) ), abs( dFdy( normal ) ) );
          roughnessFactor = min(
            roughnessFactor + min( max( max( kTriDxy.x, kTriDxy.y ), kTriDxy.z ) * 1.6, 0.40 ), 1.0 );
        }`,
      );

    if (hasBounce) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', BOUNCE);
    }
  };
  mat.customProgramCacheKey = () =>
    `tri3${o.worldScale}_${o.sharpness}_${o.macro}_${o.macroRelief}_${o.period}` +
    `_${o.mid ?? 'x'}_${o.midRelief ?? 0}_${o.detailRelief ?? 1}_${bore.join(',')}` +
    `_${o.settle ? o.settle.join(',') : 'x'}_${settleD.join(',')}_${bands.join(',')}` +
    `_${hasBounce ? o.bounce!.join(',') : 'x'}` +
    `_${hasStrata ? st!.thickness : 'x'}_${hasTriTint ? 1 : 0}_saa1`;
}

export interface EnvGroundOpts {
  /** reflected colour straight down */
  ground: number;
  /** reflected colour just below the horizon line */
  horizon: number;
  /** how completely the ground replaces the probe's lower hemisphere, 0..1 */
  amount: number;
  /** terminator half-width in reflection-vector Y, before the roughness widening */
  soft?: number;
}

/**
 * A ground half and a horizon terminator for the environment probe.
 *
 * The probe is baked from the sky dome alone, so its lower hemisphere is more
 * sky. A mirror with nothing but a smooth gradient to reflect looks matte no
 * matter what its roughness says — that is why a `metalness 1.0, roughness 0.15`
 * roll bar comes out of the frame as a flat pink tube and a `clearcoat 1`
 * bonnet shows one broad diffuse falloff and no horizon line. The material is
 * not the problem; there is nothing in the world for it to reflect.
 *
 * The honest fix is to bake the cube from the real scene, which belongs to the
 * sky system. This is the part that can be done from here: intercept the IBL
 * radiance fetch and mix the lower hemisphere toward a ground value with a
 * *sharp* edge at y = 0. A sharp edge is the whole point — the terminator is
 * the feature. It widens with roughness, so a polished bonnet gets a hard
 * horizon and a satin panel gets a soft one, which is what separates the two
 * materials from each other.
 */
export function injectEnvGround(mat: THREE.Material, o: EnvGroundOpts): void {
  const g = new THREE.Color(o.ground).convertSRGBToLinear();
  const h = new THREE.Color(o.horizon).convertSRGBToLinear();
  patchEnvRadiance(mat, {
    key: `envg${o.ground}_${o.horizon}_${o.amount}_${o.soft ?? 0.035}`,
    decl: 'uniform vec4 uEnvGround;\nuniform vec4 uEnvHorizon;',
    uniforms: {
      uEnvGround: { value: new THREE.Vector4(g.r, g.g, g.b, o.amount) },
      uEnvHorizon: { value: new THREE.Vector4(h.r, h.g, h.b, o.soft ?? 0.035) },
    },
    glsl: /* glsl */ `
			float kBelow = -reflectVec.y;
			float kSoft = uEnvHorizon.w + roughness * 0.65;
			vec3 kGround = mix( uEnvHorizon.rgb, uEnvGround.rgb, smoothstep( 0.0, 0.5, kBelow ) );
			envMapColor.rgb = mix( envMapColor.rgb, kGround,
				smoothstep( -kSoft, kSoft, kBelow ) * uEnvGround.w );`,
  });
}

/**
 * How a specific surface answers the environment probe, as a function of
 * incidence — magnitude AND chroma.
 *
 * Two failures this exists to fix, and they are the same failure seen from
 * opposite ends:
 *
 *  • DRY ASPHALT THAT READS WET. three's split-sum IBL hands a rough dielectric
 *    the whole upper hemisphere, Fresnel-boosted at grazing, with no
 *    microfacet shadowing and no multiple-scattering loss. A racing camera sees
 *    the road at 60–87° of incidence in every pixel of the frame, so that
 *    boosted term is not an edge case, it is the entire road — and because the
 *    fetch at high roughness lands near the top of the mip chain it is not even
 *    an image of the sky, it is the sky's *average*, which is blue. A dark
 *    surface with weak diffuse (a 14° key on a horizontal plane gives
 *    N·L ≈ 0.24) plus a blue hemispherical mirror is exactly the look of a road
 *    after rain. Measured on r7/hero.png the tarmac ran 55–76% saturation at
 *    hue 217–229 — the bible's `#4a4a52` is 10% saturation. Dry asphalt does
 *    keep a sheen at genuinely shallow incidence and the lighting note asks for
 *    it, so the term is *shaped*, not deleted: near-neutral and heavily damped
 *    where the surface faces the camera, released back to a real reflection in
 *    the last few degrees before grazing.
 *
 *  • LACQUER THAT REPAINTS THE CAR. The same fetch on a `clearcoat 1` panel is
 *    correct in shape and wrong in chroma: reflecting a procedurally saturated
 *    sunset at full chroma over a saturated pigment gives a panel whose hue is
 *    a running average of "roster colour" and "sky", and one that swings with
 *    view angle. That is what reads as iridescence. Keeping the reflection's
 *    LUMINANCE and taking most of its chroma out leaves the lacquer highlight
 *    exactly where it was, the same brightness and the same shape, and lets the
 *    pigment win the hue — which is what a shiny red toy car looks like.
 *
 * Cost: one dot, one pow and two mixes inside `getIBLRadiance`, on the
 * materials that ask for it. No extra texture fetch, no extra pass.
 */
export interface EnvResponseOpts {
  /** radiance multiplier at normal incidence */
  faceScale: number;
  /** radiance multiplier at full grazing */
  grazeScale: number;
  /** chroma kept at normal incidence — 0 = a neutral sheen, 1 = the sky verbatim */
  faceChroma: number;
  /** chroma kept at full grazing */
  grazeChroma: number;
  /** shaping exponent on (1 - N·V); higher = the release happens later */
  power?: number;
}

export function injectEnvResponse(mat: THREE.Material, o: EnvResponseOpts): void {
  const p = o.power ?? 3;
  patchEnvRadiance(mat, {
    key: `envr${o.faceScale}_${o.grazeScale}_${o.faceChroma}_${o.grazeChroma}_${p}`,
    decl: 'uniform vec4 uEnvResp;\nuniform vec2 uEnvRespC;',
    uniforms: {
      uEnvResp: { value: new THREE.Vector4(o.faceScale, o.grazeScale, p, 0) },
      uEnvRespC: { value: new THREE.Vector2(o.faceChroma, o.grazeChroma) },
    },
    glsl: /* glsl */ `
			float kNdV = clamp( dot( normal, viewDir ), 0.0, 1.0 );
			float kGraze = pow( 1.0 - kNdV, uEnvResp.z );
			envMapColor.rgb *= mix( uEnvResp.x, uEnvResp.y, kGraze );
			envMapColor.rgb = mix(
				vec3( dot( envMapColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ),
				envMapColor.rgb,
				mix( uEnvRespC.x, uEnvRespC.y, kGraze ) );`,
  });
}

interface EnvPatch {
  key: string;
  decl: string;
  glsl: string;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * Shared plumbing for every patch that wants to sit inside `getIBLRadiance`.
 *
 * Two things it exists to get right, both of which the first version of
 * `injectEnvGround` got wrong and neither of which announces itself:
 *
 * 1. THE RETURN STATEMENT IS NOT STABLE TEXT. The sky system rewrites this same
 *    chunk during its own init to hang a roughness rolloff off the specular
 *    half, so by the time anything here compiles the line reads
 *    `return envMapColor.rgb * envMapIntensity * mix( 1.0, 0.42, ... );`. An
 *    exact-string match against the stock `... * envMapIntensity;` therefore
 *    never fires, the guard takes the early return, and the injection is a
 *    no-op that logs one warning and is never thought about again — the same
 *    class of silent disable that turned the whole post chain off for four
 *    rounds. Match the head of the statement and INSERT ahead of it instead, so
 *    whatever multipliers anyone else has hung off the tail survive untouched.
 * 2. TWO PATCHES ON ONE MATERIAL MUST NOT FIGHT. Each patch inlines the chunk
 *    in place of `#include <envmap_physical_pars_fragment>`; the second one to
 *    run would find the include already gone and silently do nothing. So the
 *    snippets are accumulated per material and inlined exactly once, in call
 *    order. (The list is captured by closure, not looked up inside the hook, so
 *    a `variant()` clone that inherits the bound hook shares it correctly.)
 */
const _envPatches = new WeakMap<THREE.Material, EnvPatch[]>();
const ENV_INCLUDE = '#include <envmap_physical_pars_fragment>';
/** Head of getIBLRadiance's return, without the tail anyone may have added. */
const ENV_RADIANCE_RETURN = /([ \t]*)return envMapColor\.rgb \* envMapIntensity/;

function patchEnvRadiance(mat: THREE.Material, patch: EnvPatch): void {
  const existing = _envPatches.get(mat);
  if (existing) { existing.push(patch); return; }
  const list: EnvPatch[] = [patch];
  _envPatches.set(mat, list);

  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;

  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    for (const p of list) {
      for (const name of Object.keys(p.uniforms)) shader.uniforms[name] = p.uniforms[name];
    }
    // `#include` directives are still unresolved at this point, so the chunk has
    // to be pulled in and inlined by hand. Read it *now*, not at module load:
    // the sky system installs its own override of this same chunk during init,
    // and inlining a stale snapshot would quietly undo their diffuse-IBL scale.
    const chunk = (THREE.ShaderChunk as unknown as Record<string, string>)
      .envmap_physical_pars_fragment;
    // Both guards LOUD. A shader injection that quietly does nothing is the
    // most expensive kind of bug this project has: it costs a review round to
    // notice and another to diagnose, and by then the numbers around it have
    // been retuned to compensate for an effect that was never running.
    if (!chunk || !ENV_RADIANCE_RETURN.test(chunk)) {
      console.warn('[materials] getIBLRadiance signature moved; env response skipped');
      return;
    }
    if (!shader.fragmentShader.includes(ENV_INCLUDE)) {
      console.warn('[materials] envmap chunk already inlined; env response skipped');
      return;
    }
    const body = list.map((p) => p.glsl).join('\n');
    const inlined = chunk.replace(
      ENV_RADIANCE_RETURN,
      (_m, indent: string) => `${indent}{${body}\n${indent}}\n${indent}return envMapColor.rgb * envMapIntensity`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + list.map((p) => p.decl).join('\n'))
      .replace(ENV_INCLUDE, inlined);
  };

  const key = () => list.map((p) => p.key).join('|');
  mat.customProgramCacheKey =
    prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey
      ? () => prevKey.call(mat) + key()
      : key;
}

/**
 * The bay and the warm stone under it, as a metal or a lacquer sees them.
 *
 * Exported with `injectEnvGround` because the karts' own paint and chrome are
 * built in `kart/Liveries.ts`, not here, and they need this more than anything
 * in this file does — a roll bar is nothing but its reflection, and a probe
 * baked from the sky dome alone gives it a smooth gradient to reflect and no
 * horizon. Correctly authored PBR is not enough on its own: `Liveries` already
 * ships `MeshPhysicalMaterial` with `clearcoat 1`, a clearcoat roughness map at
 * 0.035–0.11, a clearcoat normal map, and chrome at metalness 1 / roughness
 * 0.10–0.23 against a rescaled `envMapIntensity`. All of that is right, and the
 * chrome still comes out of the frame as a pale pink tube, because there is
 * nothing in the environment for it to be a mirror OF. Two lines fix it:
 *
 *     import { injectEnvGround, ENV_GROUND } from '../render/Materials';
 *     injectEnvGround(mats.chrome, { ...ENV_GROUND, amount: 0.94, soft: 0.012 });
 *     injectEnvGround(mats.paint, ENV_GROUND);
 *
 * Inject AFTER any other `onBeforeCompile` on the material: this one chains the
 * previous hook and its cache key rather than replacing them.
 */
export const ENV_GROUND = { ground: 0x6d5b4a, horizon: 0xb08a63, amount: 0.88 } as const;

/**
 * Emissive clamp and LOD bias for the boost pad.
 *
 * A racing camera meets a boost pad at about ten degrees off the surface, which
 * is the worst case a mip chain has: the texel footprint is a long thin sliver
 * and hardware anisotropy holds a *low* mip to serve it. On a hard-edged stripe
 * pattern that is a crawling white smear, and because the stripes are also the
 * brightest thing in frame, the crawl is what the eye goes to first. Forcing a
 * higher mip with range is the only thing that resolves it — the chevrons are
 * meant to read as a flowing band at distance, not as individually sampled
 * edges.
 *
 * The clamp is the other half. The intensity of a boost pad belongs in bloom,
 * not in the base pixel: past ~2.2× white the tone map has nothing left to
 * work with and the emissive stops being a colour at all.
 */
function injectBoostPad(mat: THREE.Material): void {
  const uBias = { value: new THREE.Vector3(0.35, 1.6, 2.2) };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uPadBias = uBias;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WORLD_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS + 'uniform vec3 uPadBias;\n')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #ifdef USE_EMISSIVEMAP
          float kPadBias = uPadBias.x + smoothstep( 5.0, 45.0, vViewDist ) * uPadBias.y;
          vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv, kPadBias );
          totalEmissiveRadiance *= emissiveColor.rgb;
          totalEmissiveRadiance = min( totalEmissiveRadiance, vec3( uPadBias.z ) );
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'boostpad2';
}

/**
 * Wrap/transmission lighting for leaf cards. At 14° sun elevation the palms and
 * hedges are almost all backlit; without this they read as black cutouts, which
 * throws away the single best lighting moment on the course.
 */
function injectFoliageSSS(mat: THREE.Material, color: THREE.Color, strength: number): void {
  const uCol = { value: color };
  const uStr = { value: strength };
  // Chained, not assigned. This used to overwrite `onBeforeCompile` outright,
  // so a leaf card that also wanted tiling breakup or a wind patch silently
  // lost whichever injection ran first — the same class of bug the note above
  // `injectBreakup`'s cache key describes, and it is worth fixing even while
  // this library's own leaf cards are the only consumers.
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uSSSColor = uCol;
    shader.uniforms.uSSSStrength = uStr;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSSSColor;\nuniform float uSSSStrength;')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
          vec3 sssV = normalize( vViewPosition );
          vec3 sssL = directionalLights[ 0 ].direction;
          // pow 3 was a pinhole: it only fired when the camera was looking almost
          // exactly down the sun vector, so in practice the fronds were never
          // caught doing it and read as opaque cardboard. 1.6 turns it into a
          // broad lobe covering most of the beach section's viewing angles.
          float sssBack = pow( max( 0.0, dot( sssV, -sssL ) ), 1.6 );
          // Wrap diffuse: NdotL remapped to (NdotL + w)/(1 + w). A leaf is one
          // cell thick and the light does not stop at its terminator.
          float sssND = dot( normal, sssL );
          float sssWrap = max( 0.0, ( sssND + 0.5 ) / 1.5 );
          // Transmission is a back-face event — the light has come through the
          // blade, so it is strongest where the surface faces away from the sun.
          float sssThru = sssBack * max( 0.0, 0.25 - sssND * 0.75 ) * 2.4;
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * uSSSColor * diffuseColor.rgb *
            ( sssThru + sssBack * 0.55 + sssWrap * 0.30 ) * uSSSStrength;
          // Leaf-edge glow. The transmitted term above lights the BODY of the
          // blade; what separates a backlit canopy from a dark blob against a
          // bright sky is the rim — the millimetre of blade at the silhouette
          // where the path length through the leaf goes to nothing and the sun
          // comes through almost unattenuated. On a card that edge is exactly
          // where the geometric normal turns perpendicular to the eye, so a
          // Fresnel-shaped term keyed on the same back-lobe puts light precisely
          // there and nowhere else. Without it the palm is a flat opaque
          // dark-green shape against a bright sky, which is the round-1 note.
          float sssRim = pow( 1.0 - max( 0.0, dot( normal, sssV ) ), 3.0 );
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * uSSSColor *
            sssRim * sssBack * 1.1 * uSSSStrength;
        #endif`,
      );
  };
  const key = `foliagesss3_${strength}`;
  mat.customProgramCacheKey =
    prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey
      ? () => prevKey.call(mat) + key
      : () => key;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

let active: Materials | null = null;

export class Materials implements System {
  private cache = new Map<string, Entry>();
  private variants = new Map<string, THREE.Material>();
  private aniso = 8;
  private quality: Quality = Quality.High;

  // animated bits, held so update() allocates nothing
  private boostEmissive: THREE.Texture | null = null;
  private boostMat: THREE.MeshStandardMaterial | null = null;
  private waterTime: { value: number } | null = null;
  private neonMat: THREE.MeshStandardMaterial | null = null;
  private envConsumers: THREE.MeshStandardMaterial[] = [];
  private lastEnv: THREE.Texture | null = null;
  private clock = 0;

  constructor() {
    active = this;
  }

  init(ctx: Ctx): void {
    this.quality = ctx.settings.quality;
    const caps = ctx.renderer?.capabilities;
    this.aniso = caps ? Math.min(8, caps.getMaxAnisotropy()) : 8;
  }

  // -- public API ----------------------------------------------------------

  /** Fetch (building on first call) a shared material by name. Never mutate the result. */
  get(name: string): THREE.Material {
    const key = ALIASES[name] ?? name;
    const hit = this.cache.get(key);
    if (hit) return hit.mat;
    const entry = this.build(key);
    this.cache.set(key, entry);
    return entry.mat;
  }

  standard(name: string): THREE.MeshStandardMaterial {
    return this.get(name) as THREE.MeshStandardMaterial;
  }

  physical(name: string): THREE.MeshPhysicalMaterial {
    return this.get(name) as THREE.MeshPhysicalMaterial;
  }

  /** Metres of world one texture tile is authored to cover. */
  worldScale(name: string): number {
    return WORLD_SCALE[ALIASES[name] ?? name] ?? 1;
  }

  /**
   * A recoloured (or otherwise tweaked) copy of a base material that SHARES its
   * textures — this is how eight kart liveries and a dozen stucco pastels cost
   * one texture set between them. Cached, so repeated calls are free.
   */
  variant(
    base: string,
    o: {
      color?: THREE.ColorRepresentation;
      roughness?: number;
      metalness?: number;
      emissive?: THREE.ColorRepresentation;
      emissiveIntensity?: number;
      clearcoat?: number;
      opacity?: number;
      key?: string;
    },
  ): THREE.Material {
    const key = `${base}|${o.key ?? JSON.stringify(o)}`;
    const hit = this.variants.get(key);
    if (hit) return hit;
    const src = this.get(base) as THREE.MeshPhysicalMaterial;
    const m = src.clone() as THREE.MeshPhysicalMaterial;
    // `Material.copy()` walks a fixed property list and `onBeforeCompile` is not
    // on it, so a plain clone silently drops every shader injection this library
    // installs. That is how a hundred instanced houses ended up sharing one
    // un-broken-up texture phase: the tiling breakup was never running on the
    // variant at all. Carry both across, and keep the cache key with them or
    // three will hand the clone the base material's compiled program.
    const before = (src as { onBeforeCompile?: THREE.Material['onBeforeCompile'] }).onBeforeCompile;
    if (before && before !== THREE.Material.prototype.onBeforeCompile) {
      m.onBeforeCompile = before.bind(src);
      m.customProgramCacheKey = src.customProgramCacheKey.bind(src);
    }
    if (o.color !== undefined) m.color.set(o.color);
    if (o.roughness !== undefined) m.roughness = o.roughness;
    if (o.metalness !== undefined) m.metalness = o.metalness;
    if (o.emissive !== undefined && m.emissive) m.emissive.set(o.emissive);
    if (o.emissiveIntensity !== undefined) m.emissiveIntensity = o.emissiveIntensity;
    if (o.clearcoat !== undefined && 'clearcoat' in m) m.clearcoat = o.clearcoat;
    if (o.opacity !== undefined) {
      m.opacity = o.opacity;
      m.transparent = o.opacity < 1;
    }
    // Clones are not in `envConsumers`, so without this they never receive
    // `ctx.envMap` and fall back to whatever `scene.environment` happens to be —
    // which is how eight liveries' clearcoat and every chrome variant ended up
    // with nothing sharp to reflect.
    this.envConsumers.push(m as unknown as THREE.MeshStandardMaterial);
    if (this.lastEnv) { m.envMap = this.lastEnv; m.needsUpdate = true; }
    this.variants.set(key, m);
    return m;
  }

  /**
   * Lacquered bodywork in a roster colour, sharing the painted-metal texture set.
   *
   * The kart subsystem builds its own two-lobe lacquer in `Liveries.ts` and does
   * not come through here; this is the fallback for anything else that wants a
   * painted panel (boat hulls, stalls). Since `metal-painted` is now authored as
   * galvanised guardrail steel, this has to put the dielectric paint back: kill
   * the metalness the ORM's B channel carries, and re-enable the coat.
   */
  livery(color: THREE.ColorRepresentation, key?: string): THREE.MeshPhysicalMaterial {
    const c = new THREE.Color(color);
    const m = this.variant('metal-painted', {
      color: c,
      metalness: 0,
      clearcoat: 1,
      key: key ?? `livery${c.getHexString()}`,
    }) as THREE.MeshPhysicalMaterial;
    m.clearcoatRoughness = 0.14;
    return m;
  }

  /** One of the village pastels (index wraps). */
  stuccoTint(i: number): THREE.MeshStandardMaterial {
    const hex = STUCCO_TINTS[((i % STUCCO_TINTS.length) + STUCCO_TINTS.length) % STUCCO_TINTS.length];
    return this.variant('stucco', { color: hex, key: `pastel${i}` }) as THREE.MeshStandardMaterial;
  }

  // -- convenience getters (typed, so call sites keep autocomplete) ---------

  get tarmac() { return this.standard('tarmac'); }
  get racingLine() { return this.standard('tarmac-racing-line'); }
  /** Tarmac inside the tunnel: same aggregate, standing damp, half the roughness. */
  get tarmacWet() { return this.standard('tarmac-wet'); }
  get cobblestone() { return this.standard('cobblestone'); }
  get kerb() { return this.standard('kerb'); }
  get sand() { return this.standard('sand'); }
  get grass() { return this.standard('grass'); }
  get dirt() { return this.standard('dirt'); }
  get cliffRock() { return this.standard('cliff-rock'); }
  get tunnelBore() { return this.standard('tunnel-bore'); }
  get stoneWall() { return this.standard('stone-wall'); }
  get stucco() { return this.standard('stucco'); }
  get roofTile() { return this.standard('roof-tile'); }
  get woodPlank() { return this.standard('wood-plank'); }
  get woodWeathered() { return this.standard('wood-weathered'); }
  get metalPainted() { return this.physical('metal-painted'); }
  get chrome() { return this.standard('chrome'); }
  get rubber() { return this.standard('rubber'); }
  get glass() { return this.physical('glass'); }
  get canvasAwning() { return this.standard('canvas-awning'); }
  get water() { return this.physical('water-surface'); }
  get concrete() { return this.standard('concrete'); }
  get marble() { return this.physical('marble'); }
  get boostPad() { return this.standard('boost-pad'); }
  get bannerFabric() { return this.standard('banner-fabric'); }
  get palmBark() { return this.standard('palm-bark'); }
  get foliageLeaf() { return this.standard('foliage-leaf'); }
  get palmFrond() { return this.standard('palm-frond'); }
  get crowd() { return this.standard('crowd'); }
  get tunnelLight() { return this.standard('tunnel-light'); }
  get neon() { return this.standard('neon'); }

  /** Layout of the crowd atlas: 4 columns × 2 rows of spectator cutouts. */
  readonly crowdAtlas = { cols: 4, rows: 2, count: 8 };

  // -- lifecycle -----------------------------------------------------------

  update(ctx: Ctx, dt: number): void {
    this.clock += dt;
    if (this.boostEmissive) {
      // chevrons flow in +V, i.e. the direction of travel across the pad
      this.boostEmissive.offset.y = (this.boostEmissive.offset.y - dt * 0.85) % 1;
      // The pulse rides *under* the shader clamp, so the chevrons breathe in
      // bloom instead of pumping the whole quad in and out of pure white.
      this.boostMat!.emissiveIntensity = 1.6 + Math.sin(this.clock * 7.5) * 0.25;
    }
    if (this.waterTime) this.waterTime.value = this.clock;
    if (this.neonMat) this.neonMat.emissiveIntensity = 2.1 + Math.sin(this.clock * 3.1) * 0.12;

    if (ctx.envMap !== this.lastEnv) {
      this.lastEnv = ctx.envMap;
      for (const m of this.envConsumers) {
        m.envMap = ctx.envMap;
        m.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const e of this.cache.values()) {
      for (const t of e.textures) t.dispose();
      e.mat.dispose();
    }
    for (const m of this.variants.values()) m.dispose();
    this.cache.clear();
    this.variants.clear();
    this.envConsumers.length = 0;
    this.boostEmissive = null;
    this.boostMat = null;
    this.waterTime = null;
    this.neonMat = null;
    if (active === this) active = null;
  }

  // -- internals -----------------------------------------------------------

  /**
   * The authored size for a material, after the quality tier and the global
   * texture cap have both had their say.
   *
   * Generating small is strictly better than generating big and letting
   * `setTextureBudget` downsample: it costs a quarter of the fill to build, a
   * quarter of the transient heap in `Fields`, and it never allocates the large
   * canvas at all. The cap is still consulted so this can never *exceed* the
   * process budget — one number decides, in one place, and this is the fast
   * path to the same answer.
   *
   * Tier scales, and why 0.25 on Low is not vandalism: at Low the panel is a
   * phone's, and `WORLD_SCALE` for tarmac is 3.5 m. 256² over 3.5 m is 73
   * texels/m; the road fills perhaps 200 of the 390 device pixels the panel
   * has, at a metre or two of depth. The texel density still exceeds the pixel
   * density. Halving again would start to show. This does not.
   */
  private res(name: string): number {
    const base = BASE_SIZE[name] ?? 512;
    const scale = this.quality <= Quality.Low ? 0.25 : this.quality <= Quality.Medium ? 0.5 : 1;
    const cap = textureBudget();
    let size = Math.max(64, Math.round(base * scale));
    if (Number.isFinite(cap)) size = Math.min(size, cap);
    return size;
  }

  private maps(f: Fields, o: Parameters<typeof buildMaps>[1] = {}): MapSet {
    return buildMaps(f, { anisotropy: this.aniso, ...o });
  }

  /**
   * This material's own micro-surface basis — see `MICRO` in `Noise.ts`.
   *
   * Every generator in this file used to build its sub-millimetre detail from
   * the same `fbmField(freq: size / 10, octaves: 2)` and consume it as
   * `base + (fine - 0.5) * 0.14`. Measured over the shipped roughness maps that
   * gave seventeen of twenty-four materials a standard deviation below 0.05 —
   * a constant to within the channel's own quantisation — and it made `dirt`,
   * `concrete`, `palm-bark` and the crowd's cloth statistically the same
   * surface. Going through here means the frequency is stated in millimetres of
   * world rather than in texels, and the octave count, the lacunarity, the
   * direction and the roughness *response curve* all come from the family
   * rather than from whichever builder was copied last.
   */
  private micro(name: MaterialName, size: number, family: MicroFamily, seed: number): MicroField {
    return microSurface(size, WORLD_SCALE[name] ?? 1, family, seed);
  }

  /**
   * Build one material's macro layer.
   *
   * Everything above roughly a metre lives here and NOWHERE ELSE. That
   * separation is the point of the whole exercise: a repair patch, a weathering
   * zone or a damp swathe baked into the tile is a feature the size of the tile,
   * so a 30 m patch of road becomes a 3.5 m blob repeating every 3.5 m — which
   * is not "macro variation", it is a second grade of speckle, and it is
   * precisely what the library was doing. Baked here it is sampled in world
   * space at its own period and is genuinely 30 m across.
   *
   * 128² is not a compromise. A field with three octaves off a 2-cell lattice
   * has no information above 16 cycles; magnified over 30 m that is a feature
   * every 1.9 m, resolved by 8 texels each. The whole layer costs 87 KB.
   */
  private macroMaps(o: {
    /** primary variation — colour drift, patches, weathering zones */
    r: Float32Array;
    /** independent second field — pooling, damp, wear */
    g?: Float32Array | null;
    /** anisotropic source, read in the tile's own UV frame */
    b?: Float32Array | null;
  }): THREE.Texture {
    return macroTexture(MACRO_RES, o.r, o.g, o.b);
  }

  /** Wire a standard material to a generated map set with sane defaults. */
  private std(m: MapSet, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: m.map,
      normalMap: m.normalMap,
      roughnessMap: m.ormMap,
      metalnessMap: m.ormMap,
      aoMap: m.ormMap,
      roughness: 1,
      metalness: 1,
      ...o,
    });
    return mat;
  }

  private phys(m: MapSet, o: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      map: m.map,
      normalMap: m.normalMap,
      roughnessMap: m.ormMap,
      metalnessMap: m.ormMap,
      aoMap: m.ormMap,
      roughness: 1,
      metalness: 1,
      ...o,
    });
  }

  private build(name: string): Entry {
    const size = this.res(name);
    switch (name) {
      case 'tarmac': return this.buildTarmac(size, false);
      case 'tarmac-racing-line': return this.buildTarmac(size, true);
      case 'tarmac-wet': return this.buildTarmac(size, false, true);
      case 'cobblestone': return this.buildCobble(size);
      case 'kerb': return this.buildKerb(size);
      case 'sand': return this.buildSand(size);
      case 'grass': return this.buildGrass(size);
      case 'dirt': return this.buildDirt(size);
      case 'cliff-rock': return this.buildCliffRock(size);
      case 'tunnel-bore': return this.buildTunnelBore(size);
      case 'stone-wall': return this.buildStoneWall(size);
      case 'stucco': return this.buildStucco(size);
      case 'roof-tile': return this.buildRoofTile(size);
      case 'wood-plank': return this.buildWood(size, false);
      case 'wood-weathered': return this.buildWood(size, true);
      case 'metal-painted': return this.buildPaintedMetal(size);
      case 'chrome': return this.buildChrome(size);
      case 'rubber': return this.buildRubber(size);
      case 'glass': return this.buildGlass(size);
      case 'canvas-awning': return this.buildAwning(size);
      case 'water-surface': return this.buildWater(size);
      case 'concrete': return this.buildConcrete(size);
      case 'marble': return this.buildMarble(size);
      case 'boost-pad': return this.buildBoostPad(size);
      case 'banner-fabric': return this.buildBanner(size);
      case 'palm-bark': return this.buildPalmBark(size);
      case 'foliage-leaf': return this.buildLeafCard(size, false);
      case 'palm-frond': return this.buildLeafCard(size, true);
      case 'crowd': return this.buildCrowd(size);
      case 'tunnel-light': return this.buildLightStrip(size, 0xffb264, 2.4);
      case 'neon': return this.buildLightStrip(size, 0x4fc3ff, 2.1);
      default:
        // Unknown name: a loud magenta so it is caught in review, not shipped.
        return { mat: new THREE.MeshStandardMaterial({ color: 0xff00aa, roughness: 0.6 }), textures: [] };
    }
  }

  // =========================================================================
  // Ground
  // =========================================================================

  /**
   * Asphalt. Binder + exposed aggregate, with the aggregate showing through
   * only where the surface has worn — that correlation is what stops it
   * reading as noise sprinkled on grey.
   */
  private buildTarmac(size: number, racingLine: boolean, wet = false): Entry {
    const f = new Fields(size);
    const agg = voronoiField(size, 96, 96, 1.0, racingLine ? 71 : 11);
    // A SECOND aggregate grading, at a non-integer ratio (96/41 = 2.34).
    //
    // The round-1 note is right and it is a different complaint from the macro
    // one: the road had metre-scale colour and roughness variation, but the
    // *aggregate itself* was one cell size at one amplitude from the kart's nose
    // to the horizon. A real road is not laid in one pass — the surface course
    // over a trench reinstatement is a coarser mix than the one beside it, and
    // that grading change is legible from a car because the chip size changes.
    // One cell size everywhere is what reads as sandpaper (fine) or lizard skin
    // (coarse); having two, in irregular zones, is what reads as tarmac.
    // resDiv 2: 41 cells over a half-res tile is still 12 texels per cell, which
    // is well inside the "features are wide" case the parameter documents, and
    // it keeps the whole change inside a third of one existing voronoi's build
    // cost across all three tarmac variants.
    const aggC = voronoiField(size, 41, 41, 1.0, racingLine ? 74 : 14, 2);
    // ...and the ~1.2 m zones that decide which grading is on show where. Its
    // own field, decorrelated from `wear` and `patch`, so a coarse zone is not
    // automatically also a worn one.
    const grade = fbmField(size, { freq: 3, octaves: 3, seed: 26, warp: 0.08, normalize: 0.03 });
    const crack = voronoiField(size, 4, 4, 0.85, 21, 4);
    const grit = fbmField(size, { freq: Math.round(size / 5), octaves: 2, seed: 12 });
    // 50 cm wear zones. Un-normalised this ran 0.24–0.81 at sd 0.099, so the
    // `tone += wear * 0.2` it feeds was a ±3% wobble and the crack gate at 0.62
    // fired almost nowhere. Normalised it is a real half-metre value break, which
    // is the decade between the aggregate and the world bands.
    const wear = fbmField(size, { freq: 7, octaves: 4, seed: 13, warp: 0.03, normalize: 0.03 });
    const tar = fbmField(size, { freq: 4, octaves: 3, seed: 17, warp: 0.06 });
    const grain = grainField(size, 16);

    // --- the isotropy break -------------------------------------------------
    // V runs down the track (TrackGeometry parameterises V as distance / 3.5 m),
    // so a field squashed along V is smeared along the direction of travel.
    // Everything a tyre does to a road it does in this direction: the binder is
    // dragged, the aggregate is polished on its leading face, the rubber lies
    // down in ribbons. The old material had exactly one such field and used it
    // only to tint the racing line, so the surface was isotropic everywhere else
    // — and an isotropic surface is one the eye reads as noise rather than wear.
    const patch = fbmField(size, { freq: 15, octaves: 3, seed: 15, mode: 'turbulence', stretchY: 0.45 });
    const smear = fbmField(size, { freq: 14, octaves: 3, seed: 31, stretchY: 0.22, normalize: 0.03 });
    // 2.6 m long / 45 cm wide polish ribbons: the trace of a tyre, at the scale a
    // tyre actually leaves one.
    const ribbon = fbmField(size, { freq: 8, octaves: 3, seed: 33, stretchY: 0.11, normalize: 0.03 });
    // ...and the aggregate itself dragged along the same axis. A Voronoi cannot
    // be stretched at generation time, so it is smeared afterwards.
    const drag = directionalBlur(agg.f1, size, 0, 1, Math.max(2, size >> 7));

    // --- the macro layer, at MACRO_RES and read in world space --------------
    // Repairs: a handful of irregular regions per ~30 m of road, darker (newer
    // binder) and smoother (not yet polished open). These carry a definite edge,
    // which is the thing a blurred fbm cannot give and the thing that makes a
    // road look maintained rather than procedurally generated. They live ONLY
    // here — baked into the 3.5 m tile a "30 m repair" would be a 3.5 m blob
    // repeating every 3.5 m, which is another grade of speckle, not macro form.
    const repair = patchField(MACRO_RES, {
      cells: 5, coverage: 0.30, softness: 0.11, warp: 0.5, warpFreq: 4, seed: racingLine ? 918 : 917,
    });
    const drift = macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.15, warpFreq: 2, seed: 14, clip: 0.04 });
    // Macro B: pooling. Tight-tailed and on its own period, so it decorrelates
    // from the colour drift instead of being the same blob wearing a second hat.
    const pool = macroField(MACRO_RES, { freq: 3, octaves: 3, warp: 0.20, warpFreq: 3, seed: 19, clip: 0.06 });
    // Macro C: the anisotropic source, read in the tile's own UV frame at a
    // heavily stretched scale, so it becomes 10 m × 125 m polish ribbons running
    // down the track. Isotropy is broken twice over — here at the tens of metres
    // and by `ribbon`/`drag` below at the centimetre — because a surface that is
    // directional at one scale only still reads as noise with a filter on it.
    const lane = macroField(MACRO_RES, { freq: 3, octaves: 3, warp: 0.10, seed: 23, clip: 0.05 });
    const macroTex = this.macroMaps({
      // patches occupy the low tail of macro A, so the shader's albedo and
      // roughness swings both land on them
      r: drift.map((v, i) => clamp01(lerp(v, 0.08, repair.mask[i] * 0.88))),
      g: pool,
      b: lane,
    });

    // Wet asphalt is not grey asphalt with a gloss on it: the water film fills
    // the voids between the chippings, so the binder goes much darker while the
    // stone crowns standing proud of the film stay close to dry. That contrast
    // *inversion* is what makes a wet road read as wet rather than as painted.
    const binder = rgb(wet ? 0x33333c : racingLine ? 0x43434d : 0x4a4a52);
    // Chippings are a VALUE break in the binder, not a hue break. A warm grey
    // this far from the binder's cool violet survives the golden-hour key and
    // the 1.12 saturation lift as orange confetti sprinkled on lavender, which
    // is the one thing asphalt never looks like.
    //
    // What that reasoning got wrong was the *amount*. With the chip mix at 0.45
    // the whole aggregate spanned luminance 82–89 against a 74 binder — an 8%
    // per-stone spread, which is not "a value break", it is a flat wash, and
    // 100% of what made a chipping visible was therefore the normal map. That is
    // the "hammered leather / bubble wrap" note exactly: relief compensating for
    // colour that was never there. Each cell now draws its own value from a
    // ±0.18 range, which is what a crushed-stone aggregate actually looks like,
    // and the hue jitter stays at the ±0.04 the original note was right about.
    const aggWarm = rgb(0x757067);
    const aggCool = rgb(0x5e5e69);
    const rubberCol = rgb(0x2c2b31);

    // §4's spread, made explicit: 0.72 dry, 0.55 on the polished line, 0.35 in
    // the tunnel. Three genuinely different specular responses off one texture
    // set — and the tunnel one exists so the bore's sodium strips have something
    // to lie down in, which is the best free material moment on the course.
    const baseRough = wet ? 0.35 : racingLine ? 0.55 : 0.72;

    for (let i = 0; i < size * size; i++) {
      // Which grading is on show here. Deliberately a soft ramp rather than a
      // hard switch: real reinstatement joints are hard-edged, but a hard edge
      // inside a 3.5 m tile is a feature that repeats every 3.5 m, which is the
      // thing this library keeps in the macro layer and out of the tile.
      const coarse = smoothstep(0.44, 0.82, grade[i]);
      const cellId = coarse > 0.5 ? aggC.id[i] : agg.id[i];
      const cv = hash2(cellId, 7, 3);
      // Aggregate crown: close to the site AND in a worn patch. The patch gate
      // has to stay tight — widen it and the 36 mm chippings clot into 20 cm
      // blotches, which is what reads as confetti rather than as exposed stone.
      // The distance term is the *smeared* one, so each chipping's exposed face
      // is drawn out down the track instead of being a circle.
      const aggD = lerp(agg.f1[i] * 0.55 + drag[i] * 0.45, aggC.f1[i], coarse);
      const stone = smoothstep(0.42, 0.14, aggD) * smoothstep(0.46, 0.68, patch[i]);
      // cracks are rare and shallow: a full crack net over every square metre
      // is a texture-artist tell, not a road
      // Gates re-tightened after `wear` and `smear` were normalised: the same
      // threshold against a field that now actually spans 0–1 selects an order
      // more area, and "cracks everywhere" is as much a procedural tell as
      // "cracks nowhere".
      const edge = smoothstep(0.028, 0.0, crack.f2[i] - crack.f1[i]) * smoothstep(0.80, 0.97, wear[i]);
      const tarBleed = smoothstep(0.62, 0.82, tar[i]);
      const rub = racingLine ? smoothstep(0.50, 0.92, smear[i]) : 0;
      // Polish ribbons. These reach ROUGHNESS above all — a 45 cm strip of
      // slightly glossier tarmac is invisible in albedo and unmissable under a
      // 14° key, which is the whole reason the grazing sun had nothing to do.
      const polish = smoothstep(0.44, 0.92, ribbon[i]);

      // Per-cell value. This is the term that turns emboss into aggregate: one
      // stone is pale flint, the one beside it is a dark basalt chip, and the
      // binder they are set in is darker and rougher than either.
      const cellV = 1 + (hash2(cellId, 19, 5) - 0.5) * 0.36;
      mixRGB(aggCool, aggWarm, cv, _a);
      _a.r *= cellV;
      _a.g *= cellV;
      _a.b *= cellV;
      mixRGB(binder, _a, stone * 0.62, _b);
      mixRGB(_b, rubberCol, rub * 0.26 + tarBleed * 0.12, _c);

      // tone: sub-metre only — everything above a metre is the macro layer's
      // `1 - stone` is the binder between the chippings, and bitumen with no
      // stone showing through it is the darkest thing on a road surface.
      const tone =
        0.9 + wear[i] * 0.2 + (grain[i] - 0.5) * 0.05 - edge * 0.2 - polish * 0.04 -
        (1 - stone) * 0.07;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      // NB: no white-noise term in the height field. Per-texel noise produces
      // normals that cannot be mip-filtered and shows up as specular crawl on
      // a road surface at speed — grain belongs in albedo and roughness only.
      // The chip crown carries most of the relief: with the albedo contrast
      // pulled down to a value break, the normal is now what has to make a
      // 36 mm chipping legible at 1 m under a 14° key.
      // A 14 mm chipping stands proud of its binder by more than a 6 mm one
      // does, so the coarse grading gets its relief AND its roughness scaled
      // with it. This is the sub-metre half of "vary the aggregate scale"; the
      // metre-and-up half is `macroNormal` in the breakup options below.
      const h = grit[i] * 0.09 + stone * (0.5 + coarse * 0.40) +
        (1 - clamp01(aggD * 1.6)) * 0.04 - edge * 0.4;
      // Every term here lives below half a metre, which is exactly right now
      // that it is no longer the only layer: it averages out the moment the road
      // is a few metres away, and what carries the surface from there to the
      // horizon is the macro layer sampled in world space. `polish` is the one
      // that matters most at close range — a 45 cm gloss ribbon is what gives
      // the 14° key something to rake along instead of one flat band.
      // 0.24 was a floor for wet glass, not for asphalt, and it was the first
      // of six multipliers that all pull the same way — by the time the world
      // bands, macro B, the streak, the stain and the wear gloss had each taken
      // their cut the surface was reaching 0.036, which is a mirror. The
      // shader-side `roughFloor` is the real backstop; this just stops the map
      // handing it an unreasonable starting point.
      // Roughness dilation: the binder between the stones is rougher than the
      // stones themselves, so the contact areas are rougher than the crowns.
      // §4's "roughness must vary spatially" is asking for the *correlation*,
      // not just the variance — polish belongs on what traffic can reach.
      const rough = clamp(
        baseRough + (grit[i] - 0.5) * 0.2 + (wear[i] - 0.5) * 0.22 - stone * 0.20 - tarBleed * 0.24 -
          rub * 0.14 + (patch[i] - 0.5) * 0.12 - polish * 0.20 + (1 - stone) * 0.09 +
          coarse * 0.07,
        0.34,
        0.97,
      );
      const ao = 1 - edge * 0.3 - (1 - stone) * 0.05 - clamp01(1 - grit[i]) * 0.04;
      f.surf(i, h, ao, rough);
    }

    // 0.46 was too shallow for the key to find: at 1 m the surface read as fine
    // purple felt with no chippings resolving at all. The racing line stays
    // flatter on purpose — that is what "worn smooth" means.
    //
    // 0.95 then overshot the other way, though most of what made it overshoot
    // was the Z-encode bug in `sobelNormalBytes` rather than the number itself.
    // Measured against the real height field, what the shader was actually
    // reconstructing at 0.95 was a mean facet tilt of 44.8°, with 46.8% of
    // texels past 45°, 24% past 60° and 2.9% at or beyond 90° — normals lying
    // flat against the road or tipped under it. That is not aggregate, it is
    // noise, and it is what was sparkling.
    //
    // With the encode fixed, 0.72 reconstructs a 28.8° mean with 8.4% past 45°
    // and nothing inverted: chippings that still catch a 14° key (comfortably
    // above the 0.46 that read as felt) without a mirror facet every few texels.
    // ...and now that the albedo is finally carrying the chippings, the relief no
    // longer has to. 0.72 was the figure that made the surface read as hammered
    // leather, and it was that high precisely because it was the only channel
    // saying "aggregate" at all. Down ~20% — enough that the chip crowns still
    // catch a 14° key, not so much that every texel is its own facet.
    const m = this.maps(f, { normalStrength: wet ? 0.30 : racingLine ? 0.40 : 0.58 });
    // 0.7 was the single largest term in the dry road's final colour and almost
    // none of it belonged there. Decomposed on r7/hero.png the tarmac came back
    // at 55–76% saturation around hue 222 — a blue surface, not the bible's 10%
    // saturated `#4a4a52` — because at the incidence a chase camera sees the
    // road at, the split-sum IBL is worth an order more than the 14° key's
    // diffuse. The tunnel's standing damp keeps its 1.25: that road IS wet.
    const mat = this.std(m, { envMapIntensity: wet ? 1.25 : 0.60 });
    // ...and the rest of it is shaped rather than scaled, so the one reflection
    // dry asphalt genuinely has — the grazing sheen the lighting note asked for
    // — survives while the broad wet gloss over the whole surface does not. See
    // `injectEnvResponse`. The polished racing line is the same asphalt worn
    // flat, so it gets the same treatment with a little more left at the face.
    // Most of the correction is taken in CHROMA rather than in energy, because
    // chroma is what says "wet": a road that answers the sky with the sky's own
    // colour is a mirror with water in it, and the same road answering with a
    // neutral sheen at the same brightness is dry asphalt catching a low sun.
    // Taking it all out of energy instead would have cost the road a stop and a
    // half and buried the macro variation, the patch repairs and the wear that
    // this material is otherwise carrying well.
    if (!wet) {
      injectEnvResponse(mat, {
        faceScale: racingLine ? 0.56 : 0.45,
        grazeScale: 1.0,
        faceChroma: 0.14,
        grazeChroma: 0.70,
        // 3.0 puts the release inside the last ~25° before the tangent plane:
        // N·V 0.5 (road ~4 m ahead of a 2.5 m camera) keeps 12% of the swing,
        // N·V 0.24 (~10 m) 44%, N·V 0.06 (~40 m, the long sheen band) 83%.
        // So the near field goes neutral and near-matte, the far field keeps a
        // warm reflection of the horizon, and the transition between them is
        // the grazing sheen the lighting note asked for.
        power: 3.0,
      });
    }
    injectBreakup(mat, {
      macroTex,
      period: 29.7,
      // 0.85 against an un-normalised fbm was delivering about ±0.22; against a
      // histogram-stretched macro map the same number would be a lava lamp, so
      // this is the *smaller* figure that finally produces the larger effect.
      strength: 0.62,
      periodB: 9.4,
      strengthB: 0.40,
      // Colour drift across metres. Asphalt weathers warm-grey where the sun has
      // bleached the binder out of it and cool-violet where it has not, and that
      // split is the difference between a road and a grey ribbon.
      macroWarm: 0xfff0dc,
      macroCool: 0xdce6ff,
      macroTint: 0.55,
      macroRough: 0.34,
      macroB: true,
      periodMacroB: 15.1,
      // decorrelated gloss — this is the term that makes the grazing key rake
      // across the tarmac in bands instead of laying one flat sheen on it
      macroRoughB: 0.26,
      // Oil and standing damp: dark, and much glossier than what it lies on.
      stain: [0.5, 0.34],
      stainTint: 0x6f6f78,
      stainRange: [0.66, 0.95],
      // The anisotropic band. uScale 0.34 / vScale 0.028 = ribbons ~10 m wide
      // and ~125 m long in world units, i.e. the line the traffic takes.
      streak: [0.34, 0.028, 0.05, -0.17],
      // Aggregate that keeps full contrast to the horizon crawls on a moving
      // frame; past ~34 m the road resolves to its own local mean instead.
      settle: [34, 95],
      // The mean the far road converges on is now glossier. 0.78 was above the
      // bible's 0.72 base, so the one part of the road at the grazing angle that
      // produces a sun sheen was also the least reflective part of it.
      settleRough: wet ? 0.36 : racingLine ? 0.56 : 0.70,
      // The racing line is a vertex-colour mask on the track's own mesh; this is
      // what turns it from an invisible 8% tint into a specular event.
      wearGloss: 1.55,
      // Asphalt is bitumen-bound crushed stone. Dry it sits around 0.72, and
      // even a racing line polished by a season of traffic does not go below the
      // high thirties — the aggregate is still exposed, it has just been worn
      // flat. Anything under that is a *wet* road, and a wet road under a 14°
      // key and a blue zenith is a field of coloured pinpoints. This is the
      // backstop the six stacked gloss multipliers above never had.
      //
      // Up from 0.44/0.38. Two reasons, and the second is the one that bites.
      // A 0.44 floor is a GGX alpha of 0.19 — that is a satin lacquer, not
      // crushed stone with bitumen between it. And the sky's own specular
      // rolloff starts at roughness 0.35 and does not reach full strength until
      // 0.85, so every texel the six gloss multipliers pushed down to the floor
      // was also the one exempting itself from the rolloff that exists to stop
      // rough ground mirroring a blue sky. The spread that landed well is kept:
      // 0.58 floor against a 0.72 base and a 0.97 ceiling is still the whole
      // macro band, the patch repairs and the polish ribbons, just no longer
      // bottoming out into gloss.
      roughFloor: wet ? 0.22 : racingLine ? 0.46 : 0.54,
      // ...and the term that stops the chip-scale normal map from aliasing into
      // that same sparkle at the grazing angles a chase camera lives at.
      specAA: 1.0,
      // The other half of the round-1 "one uniform crackle at constant
      // roughness" note, and the half nothing was addressing. Roughness varied
      // with the macro band already; RELIEF did not, so the aggregate stood
      // exactly as proud on the polished line as on the untouched shoulder and
      // the surface read as one embossed sheet with a tint drifting over it.
      // Tied to the same band as the roughness and the albedo, so the coarse,
      // matte, dark zones are also the deep ones — which is the correlation
      // that makes a road look worn rather than noisy.
      macroNormal: wet ? 0.30 : racingLine ? 0.34 : 0.55,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Blue-grey, flat rectangular stone slabs in a staggered paving bond. */
  private buildCobble(size: number): Entry {
    const f = new Fields(size);
    const paving = brickField(size, 4, 8, 0.5, 0.035, 0.016, 41);
    const micro = fbmField(size, { freq: 48, octaves: 2, seed: 43 });
    const grain = grainField(size, 47);
    const palette = [rgb(0x889fa8), rgb(0x9aacb2), rgb(0x7f98a3), rgb(0xa7b8bd), rgb(0x94aaa9)];
    const mortar = rgb(0x667c82);
    for (let i = 0; i < size * size; i++) {
      const edge = paving.edge[i];
      const face = smoothstep(0, 0.10, edge);
      const bevel = smoothstep(0, 0.24, edge);
      const id = paving.id[i];
      const stone = palette[id % palette.length];
      mixRGB(mortar, stone, face, _a);
      const tone = 0.94 + hash2(id, 3, 9) * 0.1 + (micro[i] - 0.5) * 0.06 + (grain[i] - 0.5) * 0.025;
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);
      f.surf(i, bevel * 0.18 + micro[i] * face * 0.014, 0.72 + face * 0.28, 0.76 + (1 - face) * 0.14);
    }
    const maps = this.maps(f, { normalStrength: 0.45 });
    const mat = this.std(maps, { envMapIntensity: 0.35 });
    this.envConsumers.push(mat);
    return { mat, textures: maps.all };
  }

  /**
   * Kerb. Bands run across V so the mesh's V axis should follow the kerb's
   * length. Paint is chipped preferentially at the band boundaries, where a
   * real kerb takes wheel strikes.
   */
  private buildKerb(size: number): Entry {
    const f = new Fields(size);
    // --- what this used to be, and why it was wrong -------------------------
    // A `turbulence` fbm at freq 26 with four octaves, on a 2 m tile, put a
    // sharp crease every centimetre across the whole kerb and then drove BOTH
    // the albedo chipping and the height field off it. Turbulence is |noise|:
    // its defining feature is a hard V-shaped valley at every zero crossing, so
    // what it produces is faceted, and a field of centimetre facets at
    // normalStrength 0.65 on a 50 cm painted band is crushed glass — which is
    // exactly what the review saw and exactly what a cast kerb is not.
    //
    // A precast kerb has a *floated* face: cement paste screeded over the
    // aggregate, so the surface is smooth-ish with a fine sand grain, punctured
    // by a scatter of air voids, and broken only where a wheel has spalled a
    // corner off it. Four fields instead of one, each doing its own job:
    //
    //   float — the trowelled paste, gentle and low-frequency
    //   voids — entrained air bubbles, small, round, and RARE
    //   agg   — the aggregate under the skin, visible only in the spalls
    //   spall — the ~10 cm impact chips, the only real relief on the surface
    const floatT = fbmField(size, { freq: 22, octaves: 3, seed: 51, warp: 0.05 });
    const voidV = voronoiField(size, 44, 44, 0.95, 52);
    // Half-res: this one is only ever read inside a spall, which is about 2% of
    // the surface, so paying full resolution for it buys nothing.
    const agg = voronoiField(size, 26, 26, 1.0, 59, 2);
    const spall = voronoiField(size, 7, 7, 0.9, 60, 2);
    const scuff = fbmField(size, { freq: 12, octaves: 3, seed: 53, stretchY: 0.3 });
    const dirtN = fbmField(size, { freq: 5, octaves: 3, seed: 54, warp: 0.04 });
    const grain = grainField(size, 56);
    // A kerb runs for tens of metres and no two of them look alike: bleached
    // where the sun has been on it all day, green-grey where the terrace shades
    // it, black where the traffic scrubs it. None of that fits inside a 2 m tile.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.14, warpFreq: 2, seed: 55, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.22, warpFreq: 3, seed: 57, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 58, clip: 0.05 }),
    });

    const red = rgb(0xe0453f);
    const white = rgb(0xf2ece0);
    const concreteC = rgb(0x9d9589);
    const rubberC = rgb(0x3a3a40);
    const bands = 4; // two red + two white per tile

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const bandF = v * bands;
      const band = Math.floor(bandF);
      const inBand = bandF - band;
      // distance to the nearest band boundary, in texels
      const dEdge = Math.min(inBand, 1 - inBand) * (size / bands);
      const bevel = smoothstep(0, 3.5, dEdge);
      const isRed = (band & 1) === 0;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const paint = isRed ? red : white;
        // Spall: a wheel has knocked the corner off the block. Gated per-cell so
        // only about one cell in seven is one — a chip on every 30 cm of a kerb
        // run is a texture-artist tell, not a kerb — and biased toward the band
        // boundaries, because that is where the arris is.
        const spallCell = hash2(spall.id[i], 31, 17);
        const spallD = smoothstep(0.42, 0.06, spall.f1[i]);
        const chipMask = spallCell > 0.74
          ? spallD * (0.55 + (1 - bevel) * 0.45) * smoothstep(0.2, 0.5, dirtN[i] + 0.25)
          : 0;
        // Entrained air voids in the float: round, 4–5 mm, and sparse. These are
        // the only high-frequency feature left in the height field and their
        // amplitude is a tenth of what the old crease field carried.
        const airV = hash2(voidV.id[i], 5, 41) > 0.86 ? smoothstep(0.30, 0.05, voidV.f1[i]) : 0;
        const sc = smoothstep(0.5, 0.82, scuff[i]) * (isRed ? 0.45 : 0.75);

        // Exposed aggregate shows ONLY inside a spall — a floated face has paste
        // over the stone everywhere else, and that is the difference between
        // cast concrete and a granite worktop.
        const aggV = 0.86 + hash2(agg.id[i], 11, 23) * 0.34;
        mixRGB(paint, concreteC, chipMask, _a);
        if (chipMask > 0) {
          _a.r *= lerp(1, aggV, chipMask);
          _a.g *= lerp(1, aggV, chipMask);
          _a.b *= lerp(1, aggV, chipMask);
        }
        mixRGB(_a, rubberC, sc * 0.5, _b);
        const grime = 0.9 + dirtN[i] * 0.18 + (grain[i] - 0.5) * 0.05;
        const tone = grime * (0.94 + bevel * 0.06) * (1 - airV * 0.10);
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        // The float mark is the dominant term and it is a *smooth* one; the
        // spalls carry the only real depth; the voids are pinpricks. Sum runs
        // about a fifth of the old field's slope, which is the ~4x drop the
        // review asked for, taken out of the crease frequency rather than out
        // of the paint bevel — the bevel is the one edge on a kerb that should
        // catch a 14° key.
        const h = bevel * 0.5 + floatT[i] * 0.13 - chipMask * 0.42 - airV * 0.10;
        // Road-marking paint on a kerb is not lacquer on a car. It is a thick
        // chlorinated-rubber or thermoplastic film laid outdoors, walked on and
        // rained on: it sits in the mid-forties, not the low thirties, and the
        // white is only slightly glossier than the red because it is repainted
        // more often. The old 0.30/0.40 pair put a 50 cm painted band at a GGX
        // alpha of 0.09 — a satin sheet, and a satin sheet with a crease field
        // under it is a strobe. Bare spalled concrete stays where it was.
        const paintRough = isRed ? 0.52 : 0.46;
        // Wet-look sheen, on the painted crown of the stripe only. Kerb paint is
        // laid thick and it ponds slightly in the middle of a band.
        const sheen = bevel * (1 - smoothstep(0.15, 0.5, chipMask)) * (isRed ? 0.04 : 0.07);
        const rough = clamp(
          lerp(paintRough, 0.91, chipMask) + (floatT[i] - 0.5) * 0.08 + sc * 0.14 +
            dirtN[i] * 0.10 - bevel * 0.02 - sheen + airV * 0.12,
          0.36,
          0.97,
        );
        const ao = 1 - (1 - bevel) * 0.2 - chipMask * 0.30 - airV * 0.22;
        f.surf(i, h, ao, rough);
      }
    }

    // 0.65 → 0.17. The review's "drop it by roughly 4x" was the right call and
    // this is that number; what makes it safe is that the field it is scaling is
    // no longer a crease network, so 0.17 still delivers a legible float texture
    // and a spall that reads as a hole rather than as a facet.
    const m = this.maps(f, { normalStrength: 0.17 });
    const mat = this.std(m, { envMapIntensity: 0.9 });
    injectBreakup(mat, {
      macroTex,
      period: 9.1,
      strength: 0.32,
      periodB: 3.1,
      strengthB: 0.22,
      // painted concrete bleaches warm in the sun and greens in the shade
      macroWarm: 0xfff4e4,
      macroCool: 0xdfe8e4,
      macroTint: 0.30,
      macroRough: 0.22,
      macroB: true,
      periodMacroB: 5.3,
      macroRoughB: 0.18,
      // rubber laid down where the wheels clip the kerb: darker, and polished
      stain: [0.4, 0.30],
      stainTint: 0x6d6a6e,
      stainRange: [0.66, 0.96],
      // A kerb's V axis runs along its length, so this is the scrub of the
      // traffic down it — the one direction everything that ever touched this
      // surface was moving.
      streak: [0.42, 0.05, -0.05, 0.13],
      settle: [45, 130],
      // The far kerb converges on painted-concrete gloss, not on matte. This is
      // the one long, continuous, mid-gloss ribbon in the frame and it is what
      // gives a 14° key a highlight to run down.
      settleRough: 0.56,
      // 0.20 was a mirror floor on the one surface in the frame that runs from
      // 2 m to the horizon at a grazing angle. Painted concrete never gets
      // there, and a kerb that does is a dotted line of white pinpoints.
      roughFloor: 0.38,
      // Weathered zones keep the float texture; the freshly repainted ones are
      // flatter, because the paint film fills it.
      macroNormal: 0.45,
      specAA: 1.0,
    });
    // A polished stripe with nothing to reflect is a matte stripe. Same reason
    // the chrome needs it: the probe is baked from the sky dome, so its lower
    // hemisphere is more sky, and a 0.30-roughness surface angled at the ground
    // returns sky. The terminator is the feature.
    injectEnvGround(mat, { ...ENV_GROUND, amount: 0.82 });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Beach sand: wind ripples, a shell scatter, damp patches near the tide line. */
  private buildSand(size: number): Entry {
    const f = new Fields(size);
    // the 1.3 m dune form — the only band on a beach above the ripples, and the
    // one that has to reach its extremes or the sand is a flat sheet with a
    // corrugation printed on it
    const dune = fbmField(size, { freq: 3, octaves: 4, seed: 61, warp: 0.07, normalize: 0.03 });
    const rippleWarp = fbmField(size, { freq: 5, octaves: 3, seed: 62 });
    const micro = fbmField(size, { freq: Math.round(size / 6), octaves: 2, seed: 63 });
    const shells = voronoiField(size, 34, 34, 1.0, 64, 2);
    const damp = fbmField(size, { freq: 4, octaves: 3, seed: 65, warp: 0.09 });
    const grain = grainField(size, 67);
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.16, warpFreq: 2, seed: 66, clip: 0.04 }),
      // Macro B is the tide: a broad, soft, one-sided field, so the beach is damp
      // in swathes near the water and bone dry up the back of it.
      g: macroField(MACRO_RES, { freq: 2, octaves: 2, warp: 0.24, warpFreq: 2, seed: 68, clip: 0.06 }),
      // ...and the wind. Dune fronts run across the prevailing wind for tens of
      // metres; that is the one direction a beach has, and it is far too long to
      // live in a 4 m tile.
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 69, clip: 0.05 }),
    });

    const dry = rgb(0xe3c893);
    const wet = rgb(0xa98f63);
    const shellC = rgb(0xf4ece0);
    const dark = rgb(0xc7a97a);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // ripples: an integer-frequency sine whose phase is pushed around by a
        // tiling warp field, so the crests meander instead of striping.
        const phase = (u * 9 + v * 3) + (rippleWarp[i] - 0.5) * 1.6;
        const ripple = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
        const rippleAmt = smoothstep(0.35, 0.7, dune[i]);
        const wetness = smoothstep(0.52, 0.78, damp[i]);
        const shell = smoothstep(0.16, 0.05, shells.f1[i]) * (hash2(shells.id[i], 5, 2) > 0.82 ? 1 : 0);

        mixRGB(dry, wet, wetness * 0.8, _a);
        mixRGB(_a, dark, (1 - ripple) * rippleAmt * 0.16, _b);
        mixRGB(_b, shellC, shell * 0.85, _c);
        const tone = 0.93 + dune[i] * 0.14 + (micro[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.07;
        f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

        // dune 0.35 -> 0.16 alongside its normalisation, same reasoning as the
        // cliff's bench: keep the relief, bank the gain in albedo and roughness
        const h =
          dune[i] * 0.16 + ripple * rippleAmt * 0.3 + micro[i] * 0.08 + shell * 0.22;
        const rough = clamp(
          0.93 - wetness * 0.34 - shell * 0.3 + (micro[i] - 0.5) * 0.1 - ripple * rippleAmt * 0.03,
          0.4,
          0.99,
        );
        const ao = 1 - (1 - ripple) * rippleAmt * 0.14 - (1 - dune[i]) * 0.06;
        f.surf(i, h, ao, rough);
      }
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { envMapIntensity: 0.8 });
    injectBreakup(mat, {
      macroTex,
      period: 24.1,
      strength: 0.55,
      periodB: 7.9,
      strengthB: 0.34,
      // dry sand goes pale and pink in this light; the shadowed hollows and the
      // shell-rich streaks go cool
      macroWarm: 0xfff2de,
      macroCool: 0xdde6f0,
      macroTint: 0.42,
      macroRough: 0.16,
      macroB: true,
      periodMacroB: 12.7,
      macroRoughB: 0.14,
      // the tide line: darker, and much smoother — wet sand is the one place on
      // a beach with a specular response, and at 14° it is a mirror band
      stain: [0.55, 0.40],
      stainTint: 0x9c8666,
      stainRange: [0.60, 0.92],
      // wind ripples run across the prevailing wind, so the drift bands do too
      streak: [0.06, 0.30, 0.045, -0.10],
      settle: [45, 130],
      settleRough: 0.9,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Turf seen from a kart: clumps, dry patches, blade direction, soil showing through. */
  private buildGrass(size: number): Entry {
    const f = new Fields(size);
    const clump = fbmField(size, { freq: 9, octaves: 4, seed: 71, warp: 0.03 });
    const blade = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 72, stretchY: 0.22 });
    const blade2 = fbmField(size, { freq: Math.round(size / 16), octaves: 2, seed: 73, stretchY: 4 });
    const dryN = fbmField(size, { freq: 6, octaves: 3, seed: 74, warp: 0.06 });
    const bare = fbmField(size, { freq: 4, octaves: 4, seed: 75, warp: 0.05 });
    const grain = grainField(size, 77);
    // Macro A: the lie of the meadow at ~18 m — where it is lush, where it is
    // burnt off, where it has been mown. Macro B: worn ground on its own period,
    // so the bald spots are not obliged to sit in the dry patches.
    const drift = macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.16, warpFreq: 2, seed: 76, clip: 0.04 });
    const scuffed = macroField(MACRO_RES, { freq: 3, octaves: 3, warp: 0.22, warpFreq: 3, seed: 79, clip: 0.05 });
    // Worn-through turf with a real edge: paths, kart tracks, the ground under a
    // tree. A thresholded blur gives a stain; this gives a bald patch. It belongs
    // in the macro layer and nowhere else — a "worn path" baked into a 3.2 m tile
    // is a 3.2 m blob that reappears every 3.2 m, which is a pattern, not a path.
    const bald = patchField(MACRO_RES, {
      cells: 5, coverage: 0.26, softness: 0.14, warp: 0.6, warpFreq: 4, seed: 803, res: MACRO_RES,
    });
    const macroTex = this.macroMaps({
      r: drift,
      // the bald patches ride the top of macro B, which is the tail the shader's
      // `stain` fires on, so the soil shows through exactly where the turf is gone
      g: scuffed.map((v, i) => clamp01(Math.max(v * 0.72, bald.mask[i] * 0.92 + 0.06))),
      // the lie of the meadow: which way the wind has laid the grass down, over
      // tens of metres
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.12, seed: 80, clip: 0.05 }),
    });
    // Tussocks: 1.6 m mounds at 3.2 m per tile. A turf field whose only relief is
    // a 35 cm clump octave is isotropic bobble at one frequency — cottage cheese
    // — and it stays cottage cheese at 3 m and at 30 m because there is nothing
    // else in it. This is the band that gives a hillside its lie.
    // measured sd 0.128 un-normalised, 0.249 with — and this is the only band in
    // the turf above 35 cm, so half of it was being thrown away
    const tussock = fbmField(size, { freq: 2, octaves: 2, seed: 78, warp: 0.09, normalize: 0.03 });

    const dark = rgb(0x4e7434);
    const mid = rgb(0x6f9b47);
    const tip = rgb(0x87b356);
    const dryC = rgb(0xb5a35c);
    const soil = rgb(0x6b5238);

    for (let i = 0; i < size * size; i++) {
      const b = blade[i] * 0.65 + blade2[i] * 0.35;
      const height = clamp01(clump[i] * 0.7 + b * 0.5);
      // Bald patches gate the soil hard, so the earth shows through in *places*
      // rather than as a permanent brown haze under everything.
      const soilMask = clamp01(smoothstep(0.33, 0.16, bare[i]) * 0.55);
      const dryMask = smoothstep(0.58, 0.82, dryN[i]);

      mixRGB(dark, mid, clamp01(height * 1.4), _a);
      mixRGB(_a, tip, smoothstep(0.55, 0.95, b), _b);
      mixRGB(_b, dryC, dryMask * 0.7, _c);
      mixRGB(_c, soil, soilMask * 0.7, _a);
      const tone = 0.88 + clump[i] * 0.14 + (tussock[i] - 0.5) * 0.26 + (grain[i] - 0.5) * 0.09;
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

      // The 3 cm blade octave stays OUT of the height field. At 3.2 m per tile
      // it is near per-texel, and per-texel normals cannot be mip-filtered —
      // that is the crawl on the left bank, not the tile repeat. Only the clump
      // and the coarse stretched octave carry relief; the fine blades live in
      // albedo and roughness, where mipping resolves them to a clean value.
      // tussock rescaled 2.2 -> 1.4 with its normalisation, so the delivered
      // relief rises ~25% instead of doubling — see buildCliffRock's note
      const h = clump[i] * 0.40 + blade2[i] * 0.26 + tussock[i] * 1.4 - soilMask * 0.3;
      const rough = clamp(
        0.86 - smoothstep(0.6, 1.0, b) * 0.16 + soilMask * 0.08 - dryMask * 0.04 +
          (tussock[i] - 0.5) * 0.16,
        0.55,
        0.99,
      );
      const ao = 1 - (1 - height) * 0.26 - soilMask * 0.1 - (1 - tussock[i]) * 0.16;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 0.85 });
    const mat = this.std(m, { envMapIntensity: 0.7 });
    injectBreakup(mat, {
      macroTex,
      period: 18.7,
      strength: 0.60,
      periodB: 6.3,
      strengthB: 0.38,
      // Sun-scorched gold where the macro layer is high, cool shaded green where
      // it is low. Turf is never one green; a hillside that is one green is the
      // single loudest "procedural" tell in an outdoor frame.
      macroWarm: 0xfff2c8,
      macroCool: 0xd2ecdc,
      macroTint: 0.62,
      macroRough: 0.20,
      macroB: true,
      periodMacroB: 9.9,
      macroRoughB: 0.16,
      // dirt showing through where the turf is worn — brown, and rougher, not
      // glossier, which is why the gloss term here is negative
      stain: [0.62, -0.16],
      stainTint: 0x9a7f5e,
      stainRange: [0.55, 0.90],
      // grass lies down in the prevailing wind; the band is broad and soft
      streak: [0.22, 0.055, 0.05, -0.08],
      // a drier, yellower meadow variant swapping in on its own period
      variantTint: 0x9fae5e,
      variantAmount: 0.5,
      settle: [30, 100],
      settleRough: 0.9,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Compacted earth: embedded pebbles, dried cracks, tyre-churned tone. */
  private buildDirt(size: number): Entry {
    const f = new Fields(size);
    const peb = voronoiField(size, 26, 26, 1.0, 81);
    const crack = voronoiField(size, 9, 9, 0.9, 82, 2);
    const lumps = fbmField(size, { freq: 12, octaves: 4, seed: 83, warp: 0.04 });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 84 });
    const grain = grainField(size, 86);
    const drift = macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.18, warpFreq: 2, seed: 85, clip: 0.04 });
    const wetN = macroField(MACRO_RES, { freq: 3, octaves: 3, warp: 0.22, warpFreq: 3, seed: 87, clip: 0.06 });
    // Churned ruts: 5-7 m regions of darker, damper, finer earth with a definite
    // edge. In the tile they would repeat every 3 m; in world space they are the
    // size a vehicle actually makes them.
    const rut = patchField(MACRO_RES, {
      cells: 4, coverage: 0.32, softness: 0.13, warp: 0.55, warpFreq: 4, seed: 881, res: MACRO_RES,
    });
    const macroTex = this.macroMaps({
      r: drift.map((v, i) => clamp01(lerp(v, 0.12, rut.mask[i] * 0.85))),
      g: wetN,
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 88, clip: 0.05 }),
    });

    const earth = rgb(0x77604a);
    const pale = rgb(0x9c8a70);
    const rich = rgb(0x584434);
    const pebC = rgb(0x8f8577);

    for (let i = 0; i < size * size; i++) {
      const pebMask = smoothstep(0.24, 0.1, peb.f1[i]) * (hash2(peb.id[i], 2, 4) > 0.55 ? 1 : 0);
      const crackMask = smoothstep(0.05, 0.0, crack.f2[i] - crack.f1[i]);
      mixRGB(earth, pale, lumps[i] * 0.7, _a);
      mixRGB(_a, rich, crackMask * 0.5 + (1 - lumps[i]) * 0.2, _b);
      mixRGB(_b, pebC, pebMask * 0.75, _c);
      const tone = 0.9 + fine[i] * 0.18 + (grain[i] - 0.5) * 0.08;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      const h = lumps[i] * 0.35 + pebMask * 0.45 + fine[i] * 0.12 - crackMask * 0.5;
      const rough = clamp(0.92 - pebMask * 0.22 + (fine[i] - 0.5) * 0.12 - lumps[i] * 0.06, 0.55, 0.99);
      const ao = 1 - crackMask * 0.55 - (1 - lumps[i]) * 0.14;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { envMapIntensity: 0.75 });
    injectBreakup(mat, {
      macroTex,
      period: 20.9,
      strength: 0.58,
      periodB: 6.7,
      strengthB: 0.36,
      macroWarm: 0xffe7c4,
      macroCool: 0xd8dce6,
      macroTint: 0.50,
      macroRough: 0.22,
      macroB: true,
      periodMacroB: 11.3,
      macroRoughB: 0.18,
      stain: [0.55, 0.30],
      stainTint: 0x7d6650,
      stainRange: [0.62, 0.94],
      // ruts and drag marks run the way the traffic went, which is V
      streak: [0.30, 0.045, 0.04, -0.10],
      settle: [40, 110],
      settleRough: 0.92,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  // =========================================================================
  // Architecture and terrain
  // =========================================================================

  /** Sea cliff: bedded strata, fracture planes, lichen. Triplanar — no stretching. */
  private buildCliffRock(size: number): Entry {
    const f = new Fields(size);
    // `normalize` on every one of the low-frequency terms below, and it is not a
    // taste call — it is the same central-limit arithmetic `FbmOpts.normalize`
    // documents, one level down. Measured over a 512² tile the un-normalised
    // fields came out at: strata sd 0.084 (range 0.19–0.81), bench sd 0.117,
    // mass sd 0.165. Those are the three terms carrying ALL of the metre-scale
    // form in the material, and a term consumed as `(v - 0.5) * k` with sd 0.084
    // delivers a sixth of the swing its coefficient claims. Normalised they run
    // sd 0.24–0.26 across the full 0–1, which is where the coefficients were
    // written to be read. This is why the cliff had grain and no geology: the
    // grain octaves are ridged and one-sided so they already reached 1.0, and the
    // form octaves — the only ones that were not — never left the middle.
    const strata = fbmField(size, { freq: 4, octaves: 3, seed: 91, stretchY: 5, warp: 0.03, normalize: 0.02 });
    const ridge = fbmField(size, { freq: 6, octaves: 5, seed: 92, mode: 'ridged', warp: 0.05 });
    const frac = voronoiField(size, 11, 11, 0.95, 93, 2);
    const flake = voronoiField(size, 29, 29, 0.95, 94, 2);
    const lichen = fbmField(size, { freq: 8, octaves: 4, seed: 95, warp: 0.08 });
    const fine = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 96 });
    const grain = grainField(size, 98);
    // The macro layer, 128² and read in WORLD space by the triplanar injection.
    // A weathering zone on a sea cliff has an edge to it — a spall scar, a gully
    // mouth, the lip of a bench. A plain fbm blob has none, so the 32 m band was
    // delivering value drift and no shape; folding a ridged field into it puts
    // creases in the zones, and creases are what the 14° key can actually catch.
    const zone = macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.18, warpFreq: 2, seed: 97, clip: 0.04 });
    const scar = macroField(MACRO_RES, {
      freq: 3, octaves: 3, mode: 'ridged', warp: 0.24, warpFreq: 2, seed: 102, clip: 0.05,
    });
    for (let i = 0; i < zone.length; i++) zone[i] = clamp01(zone[i] * 0.60 + scar[i] * 0.40);
    const macroTex = this.macroMaps({ r: zone });
    // Tile-scale bedding. The shader lays world-horizontal strata over the whole
    // face at ~2.4 m; this is the finer layering *inside* each of those beds —
    // 9 laminae across a 4 m tile ≈ 45 cm, which is the scale a bedded limestone
    // actually parts at. Two scales of layering is what stops the strata reading
    // as a decal stripe pattern printed on a smooth ramp.
    const beds = strataField(size, { bands: 9, thicknessJitter: 0.55, warp: 0.7, seed: 961, res: 256 });
    // Tile-scale form: a 1.3 m craggy mass and a 2 m bedding step. These are the
    // two features that were missing outright, and their absence is why the face
    // had nothing bigger than a hand to throw a silhouette break or a shadowed
    // recess. Resampled by the mid and macro bands they become the 4 m and 11 m
    // masses and the 17 m benching a 40 m sea cliff is actually made of.
    //
    // Ridged fbm, deliberately NOT a Voronoi: a cell field is a recognisable
    // motif, and repeating one recognisable motif at three scales reads as
    // cauliflower rather than as rock.
    const mass = fbmField(size, {
      freq: 3, octaves: 2, seed: 99, mode: 'ridged', warp: 0.10, warpFreq: 2, normalize: 0.02,
    });
    const bench = fbmField(size, { freq: 2, octaves: 2, seed: 100, stretchY: 3.6, warp: 0.05, normalize: 0.03 });

    const stone = rgb(0x92a2a3);
    const shade = rgb(0x5d7274);
    // The bleach was the source of the orange: pushed by the golden-hour key and
    // the saturation lift, #c9b79c goes tangerine. Cooled and pulled back so the
    // face reads as the bible's #a8927a limestone at any exposure.
    //
    // Pulled back again, and this time it is a palette call rather than a hue
    // one: measured on the round-1 cliff the sunlit face sat at a 95th-percentile
    // luminance of 190 against a median of 110, i.e. a near-white top end, and
    // §3's stone is #a8927a. The pale beds are still pale — they are just pale
    // *limestone* now, and the range they used to spend going toward white is
    // spent going toward the shade colour instead, which is where the reading is.
    const bleach = rgb(0xaab9b7);
    const lichenC = rgb(0x85946a);

    for (let i = 0; i < size * size; i++) {
      const band = strata[i];
      const fracture = smoothstep(0.03, 0.0, frac.f2[i] - frac.f1[i]) * smoothstep(0.3, 0.65, ridge[i]);
      const flakeEdge = smoothstep(0.035, 0.0, flake.f2[i] - flake.f1[i]);
      const face = smoothstep(0.3, 0.85, ridge[i]);
      const lich = smoothstep(0.62, 0.85, lichen[i]) * (1 - fracture) * smoothstep(0.35, 0.7, band);
      const crag = mass[i];
      const gully = smoothstep(0.30, 0.04, crag);
      // Laminae: each has its own hardness, which sets how pale it has weathered
      // and how far it stands proud. This is the term that turns "rock-coloured
      // noise" into something with a grain running through it.
      const bedId = beds.id[i];
      const hard = hash2(bedId, 13, 47);
      const bedPlane = beds.plane[i];

      mixRGB(shade, stone, clamp01(band * 1.3), _a);
      mixRGB(_a, bleach, face * 0.33 + hard * 0.22, _b);
      mixRGB(_b, lichenC, lich * 0.6, _c);
      // Most of the form has to come from the normal and not from baked value,
      // or the rock is a painting of a cliff that ignores where the sun is. The
      // boulder/bench terms are the exception: a 1 m mass needs a value break as
      // well as a normal break or it vanishes the moment it faces away from the
      // key, which is what left the face reading as one hue at one frequency.
      // The tile's own value range is what the macro albedo band re-reads at
      // 34 m (see `albedoBands`), so this range IS the macro range: whatever
      // spread the beds have here is the spread the 34 m zones get on the face.
      // At the old coefficients it summed to about a 0.30 peak-to-peak ratio,
      // which after the macro band's 0.55 mix is a 16% luminance swing across a
      // 40 m cliff — invisible, which is exactly what the review measured. The
      // bed terms are the ones widened, because a bed is the feature the band is
      // supposed to be *of*.
      const bedding = 0.78 + Math.pow(band, 0.8) * 0.30;
      const tone =
        bedding + (fine[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05 - fracture * 0.1 +
        (crag - 0.5) * 0.13 + (bench[i] - 0.5) * 0.20 - gully * 0.14 +
        (hard - 0.5) * 0.30 - bedPlane * 0.20;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      // Height, not albedo, is where the strata and the fracture planes belong.
      // Deepened across the board: a rock cut has to throw micro-shadow under a
      // raking key or it is wallpaper. `fine` is pulled back hard — it was the
      // per-texel term that made the whole 40 m face one grade of oatmeal.
      const h =
        ridge[i] * 0.72 + band * 0.22 + fine[i] * 0.07 - fracture * 0.55 - flakeEdge * 0.14 +
        // These two are deliberately huge next to the detail terms. A Sobel is a
        // 3x3 finite difference, so a 1.3 m dome spread over 340 texels needs an
        // amplitude an order above a 4 mm chip to tip the normal by the same few
        // degrees — an amplitude that "looks wrong" in the height field is what a
        // metre-scale feature costs.
        //
        // Rescaled when `mass`, `bench` and `strata` were normalised. Those three
        // gained 1.6-2.8x in standard deviation, and these coefficients were tuned
        // against the un-normalised fields — carrying them over unchanged would
        // have roughly doubled the Sobel's input on terms whose gradient already
        // tips the stored normal past 60 degrees, which does not buy more form, it
        // just clips. Each is divided back down to leave the delivered relief ~25%
        // above where it was, and the normalisation is banked where it is
        // unambiguously free: albedo, roughness, and the gully/lichen gates.
        crag * 0.95 + bench[i] * 1.6 - gully * 0.6 +
        // hard laminae stand proud, soft ones weather back into a shadow line
        (hard - 0.35) * 0.55 - bedPlane * 0.45;
      // Genuinely bimodal: dry exposed faces near 0.62, damp shaded crevices
      // near 0.95. A constant roughness is the #1 amateur tell and 0.89 ± 0.08
      // was effectively constant.
      // Dry limestone is matte everywhere. The old floor of 0.55 let the exposed
      // faces go glossy enough that the normal-mapped microfacets threw a sun
      // sparkle across the whole cliff — a 40 m sea cliff that glitters reads as
      // wet plastic. 0.72-0.99 is still a 27% spread, which is the spatial
      // variation the bible asks for; it just no longer includes "polished".
      const rough = clamp(
        0.93 - face * 0.14 - band * 0.06 + fracture * 0.05 + lich * 0.06 + (fine[i] - 0.5) * 0.14 -
          crag * 0.08 + gully * 0.05 - (hard - 0.5) * 0.16 + bedPlane * 0.05,
        0.70,
        0.99,
      );
      const ao = 1 - fracture * 0.42 - flakeEdge * 0.12 - (1 - ridge[i]) * 0.22 - gully * 0.26 -
        (1 - crag) * 0.10 - bedPlane * 0.20;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 1.0 });
    const mat = this.std(m, { envMapIntensity: 0.62 });
    // Three bands sum before normalScale, so the gain that was right for one
    // band is three times too much for three: over-tipped normals on a 40 m face
    // under a 14° key are salt-and-pepper sparkle, not form.
    mat.normalScale.set(0.95, 0.95);
    injectTriplanar(mat, {
      macroTex,
      worldScale: WORLD_SCALE['cliff-rock'],
      // 5 was low enough that X and Z cross-faded across most of a curved face,
      // sliding two copies of the same directional noise past each other — the
      // "fur" in the tunnel bore. At 9 one projection dominates almost anywhere.
      sharpness: 9,
      period: 31.7,
      // 3.3× of a 4 m tile is a 13 m macro, far too tight for a 40 m sea cliff:
      // it put the largest feature in the material at about a metre and a half.
      // 8.5× = 34 m, which is the height of the face itself.
      macro: 8.5,
      macroRelief: 0.95,
      mid: 2.9,
      midRelief: 0.55,
      detailRelief: 0.45,
      // Albedo tile holds a long way — the far headland must not collapse to a
      // flat silhouette (measured sd 44 on a region that should read as bedded
      // rock, and visually one orange blob at 150 m).
      settle: [90, 260],
      // ...while the 4 mm chip relief, the only band that can alias, is gone by
      // 45 m. It used to survive to 220 m at a quarter amplitude, which is the
      // "chip size is pixel-identical at 6 m and at the crest" note verbatim.
      settleDetail: [14, 45],
      // The ×2.9 and ×8.5 form bands, finally in ALBEDO and not only in relief,
      // plus a second tiling at ×1.37 to kill the near-field repeat.
      albedoBands: [0.48, 0.30],
      albedoBreakScale: 1.37,
      // The tile's value range is much wider than it was, and the bands, the
      // strata tone and the world drift can all pull down at once. A cliff face
      // is outdoors and has sky fill, so this is small — it exists so the one
      // texel in a thousand where every term aligns still has a colour.
      bounce: [0xc98f5a, 0.03],
      // The geology. 2.4 m beds on a 40 m face gives about sixteen courses from
      // the tide line to the cliff top — enough to read as layering at a
      // thumbnail and coarse enough that each bed still has room to carry the
      // 4 mm / 30 cm / 10 m ladder inside it. These do not settle with distance
      // and they must not: they are the only band in the material that is still
      // saying something at 150 m, which is where every wide shot puts the cliff.
      strata: {
        // 3.4 m rather than 2.4: §9.6's ask is a 3–6 m world-locked band, and at
        // 2.4 m on a 40 m face the courses were fine enough to sit in the same
        // frequency decade as the mid form band and get lost in it.
        thickness: 3.4,
        // The bed tone is world-horizontal and geometry-independent, so it is the
        // one variation that cannot be defeated by the face folding away from the
        // key. It has to be legible: 0.16 was a 16% swing shared with everything
        // else in the material.
        tone: 0.27,
        rough: 0.20,
        relief: 0.30,
        warp: 1.6,
        dip: [0.075, -0.052],
        // hard beds have weathered pale and warm, soft beds sit grey in shadow
        tint: 0xffe6c2,
        tintAmount: 0.46,
      },
      // Sun-facing zones bleach warm, sheltered zones go cool and green-grey.
      macroWarm: 0xfff0d8,
      macroCool: 0xd2dfe6,
      macroTint: 0.55,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /**
   * The tunnel bore. A cut rock face is not a cliff face: it is fresher, darker,
   * carries the arcs the boring head left, and its floor line stays damp while
   * its crown dries. Sharing one material with the cliff is why the bore had no
   * form — crown, haunch and springline were all the same value.
   */
  private buildTunnelBore(size: number): Entry {
    const f = new Fields(size);
    // Chisel/bore arcs: the tool signature. At freq 15 with a 0.3 stretch this
    // was a hairbrush — 21 cm ridges elongated 3:1 and repeated identically from
    // crown to floor is the definition of corduroy, and no amount of macro band
    // rescues it. Dropped to 4 (80 cm) and de-stretched to 0.62 the same field
    // reads as the broad sweeps a boring head actually leaves.
    const arcs = fbmField(size, { freq: 4, octaves: 2, seed: 301, stretchY: 0.62, mode: 'ridged' });
    const blast = fbmField(size, { freq: 7, octaves: 4, seed: 302, mode: 'ridged', warp: 0.06 });
    const frac = voronoiField(size, 9, 9, 0.95, 303, 2);
    const spall = voronoiField(size, 22, 22, 0.9, 304, 2);
    const damp = fbmField(size, { freq: 5, octaves: 3, seed: 305, warp: 0.07 });
    const soot = fbmField(size, { freq: 3, octaves: 4, seed: 306, warp: 0.05 });
    const fine = fbmField(size, { freq: Math.round(size / 12), octaves: 2, seed: 307 });
    const grain = grainField(size, 309);
    // Same construction as the cliff: a warped blob field with a ridged field
    // creased into it, so the 23 m band carries zones with edges — the shadow
    // under a bench, the mouth of a spall — instead of a smooth tonal drift.
    const zone = macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.18, warpFreq: 2, seed: 308, clip: 0.04 });
    const scar = macroField(MACRO_RES, {
      freq: 3, octaves: 3, mode: 'ridged', warp: 0.22, warpFreq: 2, seed: 311, clip: 0.05,
    });
    for (let i = 0; i < zone.length; i++) zone[i] = clamp01(zone[i] * 0.62 + scar[i] * 0.38);
    const macroTex = this.macroMaps({ r: zone });
    // A tunnel is cut *through* the same bedded rock as the cliff, so it has to
    // show the same beds — 7 laminae over a 3.2 m tile ≈ 46 cm, matching the
    // cliff's lamina scale. Getting these two materials to agree about the
    // geology is most of what makes the tunnel read as being in the headland
    // rather than as a separate object with a rock texture on it.
    const beds = strataField(size, { bands: 7, thicknessJitter: 0.5, warp: 0.6, seed: 3101, res: 256 });
    // Tile-scale mass: ~1 m benching left by the cut, so the bore has something
    // for the sodium strip to throw a shadow terminator across. Ridged fbm, not a
    // cell field — see buildCliffRock.
    // normalised for the same reason as the cliff's: measured sd 0.140 before,
    // ~0.26 after, and this is the only term in the bore above half a metre.
    const bench = fbmField(size, {
      freq: 3, octaves: 2, seed: 310, mode: 'ridged', warp: 0.09, warpFreq: 2, normalize: 0.02,
    });

    // Measured on the round-1 corner shot, the bore's left haunch ran a 5th
    // percentile of 5/255 and the crown 14/255 — genuine black, with the rock's
    // albedo gone entirely, which §9.6 forbids outright. Half of that was the
    // material: a ridged `blast` field driving a full deep→cut colour swing on
    // top of a ×0.15 tone swing on top of a 55% mix toward `wet` is a 3:1 albedo
    // range inside one surface, and the tunnel then lights it with nothing but a
    // sodium strip. The palette is lifted at the dark end and the swings that
    // feed it are compressed; the missing contrast comes back as *form* from the
    // macro albedo bands below, which is where it belongs.
    const cut = rgb(0x9c8974);
    const deep = rgb(0x7b6b5a);
    const wet = rgb(0x625648);
    const dust = rgb(0xb3a794);

    for (let i = 0; i < size * size; i++) {
      const arc = smoothstep(0.42, 0.9, arcs[i]);
      const face = smoothstep(0.28, 0.82, blast[i]);
      const fracture = smoothstep(0.035, 0.0, frac.f2[i] - frac.f1[i]);
      const spalled = smoothstep(0.05, 0.0, spall.f2[i] - spall.f1[i]) * smoothstep(0.4, 0.75, blast[i]);
      const wetM = smoothstep(0.52, 0.86, damp[i]);
      const sooty = smoothstep(0.45, 0.8, soot[i]);
      const mass = bench[i];
      const recess = smoothstep(0.28, 0.03, mass);
      const hard = hash2(beds.id[i], 13, 47);
      const bedPlane = beds.plane[i];

      mixRGB(deep, cut, clamp01(face * 1.25), _a);
      // The bore arcs are a tool signature, not a paint scheme. At 0.24 in albedo
      // and 0.34 in height they were the loudest thing on the surface, and being
      // a Y-stretched field read through a world-axis triplanar they smear along
      // whichever projection wins — which is the "directional stretching" the
      // review saw across the whole upper bore. Halved in colour, and most of
      // what is left moved into relief where a stretched feature is legitimate.
      mixRGB(_a, dust, arc * 0.12 * (1 - wetM) + hard * 0.18, _b);
      mixRGB(_b, wet, wetM * 0.38 + sooty * 0.12 + bedPlane * 0.10, _c);
      const tone =
        0.90 + face * 0.09 + (fine[i] - 0.5) * 0.08 + (grain[i] - 0.5) * 0.04 - fracture * 0.09 +
        (mass - 0.5) * 0.13 - recess * 0.08 + (hard - 0.5) * 0.15 - bedPlane * 0.10;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      const h =
        blast[i] * 0.8 + arc * 0.40 + fine[i] * 0.06 - fracture * 0.6 - spalled * 0.24 +
        // 1.8 was tuned against an un-normalised `bench` at sd 0.140; at sd ~0.26
        // the same coefficient doubles the Sobel's input on the one term already
        // steep enough to clip. See the matching note in buildCliffRock.
        mass * 1.2 - recess * 0.6 + (hard - 0.35) * 0.45 - bedPlane * 0.40;
      // Dry blasted crown near 0.60, damp shaded floor line near 0.85 — carried
      // on the wet mask so the split follows the surface rather than a hard band.
      // Blasted rock, floored higher for the same reason as the cliff. The damp
      // floor line still gets its gloss, but from the bore gradient in the
      // shader, where it follows the geometry rather than a noise field.
      const rough = clamp(
        0.66 + wetM * 0.18 + (1 - face) * 0.20 + fracture * 0.08 + (fine[i] - 0.5) * 0.12 - mass * 0.08 -
          (hard - 0.5) * 0.15 + bedPlane * 0.06,
        0.55,
        0.97,
      );
      const ao = 1 - fracture * 0.46 - spalled * 0.2 - (1 - blast[i]) * 0.22 - wetM * 0.12 -
        recess * 0.24 - (1 - mass) * 0.10 - bedPlane * 0.18;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 1.1 });
    const mat = this.std(m, { envMapIntensity: 0.42 });
    mat.normalScale.set(1.0, 1.0);
    injectTriplanar(mat, {
      macroTex,
      worldScale: WORLD_SCALE['tunnel-bore'],
      // On a curved bore 8 is soft enough that the X and Z projections cross-fade
      // right across the haunch, which is two copies of the same field sliding
      // past each other — the smear. 12 keeps one projection dominant.
      sharpness: 12,
      period: 23.3,
      // The bore is ~8 m tall; a 3.7× macro of a 3.2 m tile topped out around a
      // metre, so there was nothing at bore scale at all. 8× = 26 m, which puts
      // the blast field's own features at ~3.5 m and the benching at ~8 m.
      macro: 8.0,
      macroRelief: 0.95,
      mid: 2.6,
      midRelief: 0.55,
      detailRelief: 0.45,
      // Crown dry and pale, springline mid, floor line damp, dark and glossier.
      // The albedo half is pulled back with the rest of the darkening budget —
      // it was taking another 30% out of the floor line on top of everything
      // above it. The roughness half stays: that is the free reflection of the
      // sodium strips and it costs no value range.
      boreGradient: [0.55, 1.15],
      settle: [70, 230],
      // Same split as the cliff: the aliasing band goes early, the colour stays.
      settleDetail: [12, 40],
      albedoBands: [0.50, 0.30],
      albedoBreakScale: 1.37,
      // §2's warm sand/stone bounce, as the fill a tunnel has no sky to provide.
      // This is what stops the unlit haunch reaching zero and it returns the
      // rock's own hue to the shade rather than washing it grey.
      bounce: [0xc98f5a, 0.075],
      // The same beds as the cliff, at the same world height and the same dip,
      // because it is the same headland. Slightly thinner and much less relief:
      // a bore is a *fresh* cut, so the beds show as tone and damp banding
      // rather than as weathered-back ledges.
      strata: {
        thickness: 2.1,
        tone: 0.14,
        rough: 0.15,
        relief: 0.16,
        warp: 1.1,
        dip: [0.075, -0.052],
        tint: 0xffe8c6,
        tintAmount: 0.30,
      },
      macroWarm: 0xffe9cc,
      macroCool: 0xd6dde6,
      macroTint: 0.38,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Ashlar sea wall / bridge stone: irregular courses, chamfered blocks, weeping joints. */
  private buildStoneWall(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 5, 8, 0.37, 0.24, 0.014, 101);
    const face = fbmField(size, { freq: 24, octaves: 4, seed: 102, warp: 0.03 });
    // Turbulent 6 mm pitting — all crests, no troughs, which is what a pitched
    // ashlar face is. Four octaves at lacunarity 2.1 rather than the shared
    // two-at-2.0, so the pitting has a size distribution instead of one grade.
    const mic = this.micro('stone-wall', size, 'stone-rough', 103);
    // the vertical weathering run — normalised so it reaches the gate below
    const streak = fbmField(size, { freq: 14, octaves: 3, seed: 104, stretchY: 0.16, normalize: 0.03 });
    const grain = grainField(size, 106);
    // A sea wall is not one stone. It was built in campaigns, it has been
    // repointed in places, and the salt reaches ~2 m up it and no further. All
    // of that is a 13 m story and none of it fits in a 3 m tile.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.16, warpFreq: 2, seed: 105, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.22, warpFreq: 3, seed: 107, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 108, clip: 0.05 }),
    });

    const pal = [rgb(0xb8a68c), rgb(0xa6947c), rgb(0xc4b49a), rgb(0x9d8d76), rgb(0xb0a48e)];
    const mortar = rgb(0x9a9084);

    for (let i = 0; i < size * size; i++) {
      const e = bf.edge[i];
      const joint = smoothstep(0, 0.55, e);
      const chamfer = smoothstep(0.05, 0.45, e);
      const id = bf.id[i];
      const blockC = pal[id % pal.length];
      const bias = hash2(id, 13, 6);
      const dirty = smoothstep(0.66, 0.96, streak[i]) * (1 - joint * 0.4);

      mixRGB(mortar, blockC, joint, _a);
      const tone =
        (0.9 + bias * 0.16 + (face[i] - 0.5) * 0.18 + (grain[i] - 0.5) * 0.05) * (1 - dirty * 0.14) * (0.9 + chamfer * 0.1);
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

      const h = chamfer * 0.65 + face[i] * 0.14 * joint + microValue(mic, i) * 0.06 - (1 - joint) * 0.25;
      // Per-BLOCK roughness, not just per-block tone. A wall is a set of stones
      // that were quarried, dressed and weathered separately; the old ±0.03
      // from `bias` was a tenth of what that is worth, and it is the cheapest
      // material variety in the file — one hash already being computed.
      const rough = clamp(
        microRough(mic, i, 0.84) + (1 - joint) * 0.12 + dirty * 0.06 + (bias - 0.5) * 0.26,
        0.5,
        0.99,
      );
      const ao = 1 - (1 - joint) * 0.5 - (1 - chamfer) * 0.16 - dirty * 0.08;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 1.05 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, {
      macroTex,
      period: 13.1,
      strength: 0.42,
      periodB: 4.3,
      strengthB: 0.27,
      macroWarm: 0xfff0d6,
      macroCool: 0xdae0e8,
      macroTint: 0.40,
      macroRough: 0.26,
      // Rain runs DOWN a wall. The tile's V is vertical on every wall in the
      // game, so a band stretched along V is a weathering streak — and a wall
      // with no vertical weathering on it is the flattest thing in any frame.
      streak: [0.55, 0.045, 0.05, 0.13],
      // Algae and lichen on the sheltered faces: definite regions of darker,
      // greener, rougher stone rather than an even wash of grime over the whole
      // wall. A stain can only ever darken (its tint is a multiplier), which is
      // right — this is a growth on the stone, not a bloom out of it.
      macroB: true,
      periodMacroB: 6.9,
      macroRoughB: 0.20,
      stain: [0.42, -0.22],
      stainTint: 0x9aa08c,
      stainRange: [0.64, 0.96],
      instUv: 0.8,
      instTint: 0.07,
      // Props raises this material's normalScale to 2.6 on its own clones, so
      // the 2.6 cm pitting in the height field arrives on a balcony or a bridge
      // parapet at nearly three times the amplitude authored here. That is the
      // glittery high-frequency sparkle the review measured; without a floor and
      // a variance term the ×2.6 clone is a field of sub-pixel mirrors.
      roughFloor: 0.52,
      specAA: 0.9,
      macroNormal: 0.30,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /**
   * Lime plaster, deliberately near-white so `stuccoTint()` can pull a dozen
   * pastel houses out of one texture set.
   */
  private buildStucco(size: number): Entry {
    const f = new Fields(size);
    const trowel = fbmField(size, { freq: 7, octaves: 4, seed: 111, warp: 0.09, warpFreq: 4 });
    // Lime render's own micro basis: 3 mm sand grains inside 38 cm float
    // sweeps, turbulent (a rendered wall's texture is all crests and no
    // troughs), and stretched ACROSS the wall because that is the direction a
    // trowel is drawn. Replaces the shared `fbmField(size / 12, 2 octaves)`
    // that made stucco's roughness map indistinguishable from concrete's.
    const mic = this.micro('stucco', size, 'stucco', 112);
    const cracks = voronoiField(size, 8, 8, 0.95, 113, 2);
    const stain = fbmField(size, { freq: 4, octaves: 4, seed: 114, warp: 0.07 });
    const grain = grainField(size, 116);
    // Lime plaster is patched, re-rendered and re-limewashed in sections, and
    // the damp reaches a definite height up a wall. Those are 4-14 m facts.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.16, warpFreq: 2, seed: 115, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.24, warpFreq: 3, seed: 117, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 118, clip: 0.05 }),
    });

    // Patch mottling: whole 2-4 m panels of render laid in different campaigns
    // and limewashed at different times. This is the octave that has to survive
    // mipping — everything above lives at 15-40 cm and is a flat grey by the
    // time an establishing shot looks down on the village. Baked into the tile
    // rather than into the macro layer on purpose: at a 3 m worldScale a 0.7-cycle
    // field IS a 4 m feature, and being in the albedo it survives to mip 5.
    const patchM = fbmField(size, { freq: 2, octaves: 3, seed: 119, warp: 0.12, warpFreq: 2, normalize: 0.03 });

    const base = rgb(0xf0e9df);
    const dirty = rgb(0xcfc4b2);
    const crackC = rgb(0xb3a897);

    for (let i = 0; i < size * size; i++) {
      const crack =
        smoothstep(0.03, 0.0, cracks.f2[i] - cracks.f1[i]) * smoothstep(0.4, 0.72, stain[i]);
      const grime = smoothstep(0.5, 0.85, stain[i]) * 0.55;
      mixRGB(base, dirty, grime, _a);
      mixRGB(_a, crackC, crack * 0.45, _b);
      const md = microDetail(mic, i);
      // ±0.12 luminance of panel-scale mottle, the range the review asked for.
      const tone =
        0.94 + trowel[i] * 0.12 + md * 0.06 + (grain[i] - 0.5) * 0.04 +
        (patchM[i] - 0.5) * 0.24;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = trowel[i] * 0.3 + (md + 0.5) * 0.18 - crack * 0.28;
      // gamma 0.85: limewash is matte nearly everywhere, and where it is NOT is
      // where the float has burnished it — a few percent of the wall, not half.
      const rough = clamp(microRough(mic, i, 0.90) + (trowel[i] - 0.5) * 0.1 + crack * 0.06, 0.62, 0.99);
      const ao = 1 - crack * 0.22 - (1 - trowel[i]) * 0.08;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 0.45 });
    const mat = this.std(m, { color: 0xffffff, envMapIntensity: 0.9 });
    injectBreakup(mat, {
      macroTex,
      period: 14.3,
      strength: 0.40,
      periodB: 4.6,
      strengthB: 0.26,
      macroWarm: 0xfff2e0,
      macroCool: 0xdde4ee,
      macroTint: 0.34,
      macroRough: 0.24,
      // rain streaks and salt bloom running down the render
      streak: [0.62, 0.05, 0.055, 0.15],
      // rising damp: darker and rougher, in swathes with an edge to them
      macroB: true,
      periodMacroB: 7.1,
      macroRoughB: 0.18,
      stain: [0.36, -0.20],
      stainTint: 0xa79c8c,
      stainRange: [0.66, 0.97],
      // The splash zone: 1.2 m of rain-kick, salt and scuff up the foot of every
      // wall, keyed to the building's own base so it is correct at any elevation
      // on a village that climbs 40 m. Baked into albedo, so it survives to the
      // aerial LOD where the trowel texture has long since mipped away — which
      // is the shot the review is complaining about.
      heightTint: [1.2, 0.55, 0.16],
      heightTintColor: 0x9d9184,
      instUv: 0.9,
      instTint: 0.10,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Mission barrel tiles: half-round pans running down the slope in overlapping courses. */
  private buildRoofTile(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 5, 2, 0.0, 0.05, 0.008, 121);
    // Fired clay under a glaze, gamma 1.70: the glaze IS the surface, so the
    // tile is smooth over most of its area and what varies is the minority that
    // has crazed or chalked back. Same nominal roughness centre as before, an
    // entirely different distribution around it.
    const mic = this.micro('roof-tile', size, 'ceramic', 122);
    const moss = fbmField(size, { freq: 7, octaves: 4, seed: 123, warp: 0.07 });
    const chalk = fbmField(size, { freq: 12, octaves: 3, seed: 124 });
    const grain = grainField(size, 126);
    // A pantile roof is a patchwork: courses replaced in different decades fire
    // to different reds, and the moss holds where the roof is shaded. Both are
    // several metres across on a 1.1 m tile.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.15, warpFreq: 2, seed: 125, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.24, warpFreq: 3, seed: 127, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 128, clip: 0.05 }),
    });

    const pal = [rgb(0xe3e8eb), rgb(0xd7dfe4), rgb(0xeff1f2), rgb(0xdce3e9), rgb(0xe1e7eb)];
    const mossC = rgb(0x7f8a58);
    const chalkC = rgb(0xd6c3ae);

    for (let i = 0; i < size * size; i++) {
      const lu = bf.lu[i];
      const lv = bf.lv[i];
      // barrel profile across the tile, flattening at the overlap seams
      const barrel = Math.pow(Math.sin(clamp01(lu) * Math.PI), 0.55);
      // courses overlap: the butt of each pan sits proud of the one below it
      const overlap = smoothstep(0.0, 0.06, lv) * (1 - smoothstep(0.9, 1.0, lv) * 0.55);
      const lip = smoothstep(0.12, 0.02, lv);
      const seam = 1 - smoothstep(0.05, 0.0, Math.min(lu, 1 - lu));
      const id = bf.id[i];
      const tileC = pal[id % pal.length];
      const bias = hash2(id, 17, 8);
      const mossM = smoothstep(0.62, 0.86, moss[i]) * (1 - barrel * 0.55);
      const chalkM = smoothstep(0.68, 0.92, chalk[i]) * barrel;

      const mv = microValue(mic, i);
      mixRGB(tileC, chalkC, chalkM * 0.25, _a);
      mixRGB(_a, mossC, mossM * 0.12, _b);
      const tone = 0.86 + bias * 0.2 + barrel * 0.14 + (mv - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = barrel * 0.72 + overlap * 0.16 + lip * 0.2 + mv * 0.07 - seam * 0.22;
      // ...plus a per-PAN firing identity. Pantiles come out of the kiln in
      // batches and no two courses took the glaze the same; ±0.09 per tile is
      // what makes a roof read as a patchwork rather than as corduroy.
      const rough = clamp(
        microRough(mic, i, 0.78) - chalkM * 0.06 + mossM * 0.14 - barrel * 0.1 + (bias - 0.5) * 0.18,
        0.42,
        0.98,
      );
      const ao = 1 - (1 - barrel) * 0.42 - (1 - overlap) * 0.35 - mossM * 0.1;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 1.2 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, {
      macroTex,
      period: 11.7,
      strength: 0.15,
      periodB: 3.8,
      strengthB: 0.10,
      macroWarm: 0xffe6c8,
      macroCool: 0xdfe2e0,
      macroTint: 0.08,
      macroRough: 0.24,
      // moss and rain run down the pitch, i.e. along V, from the ridge
      streak: [0.5, 0.06, 0.05, 0.14],
      // moss banks: darker, greener, much rougher, in patches with an edge
      macroB: true,
      periodMacroB: 6.1,
      macroRoughB: 0.20,
      stain: [0.46, -0.26],
      stainTint: 0x8d9464,
      stainRange: [0.66, 0.97],
      instUv: 0.85,
      instTint: 0.13,
      // A hundred instanced roofs at 300 m, each a corduroy of 22 cm barrel pans
      // at normalStrength 1.2 (and ×1.9 on Props' own clone) is the single
      // densest normal-map crawl in the establishing shot.
      roughFloor: 0.44,
      specAA: 1.0,
      settle: [70, 200],
      settleRough: 0.72,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Boat decking, jetty planks, market stalls. `weathered` greys it out and splits the grain. */
  private buildWood(size: number, weathered: boolean): Entry {
    const f = new Fields(size);
    const seed = weathered ? 200 : 130;
    const bf = brickField(size, 5, 1, 0, 0.14, 0.008, seed, false);
    // grain runs along V: low Y frequency, high X frequency
    // The grain is the whole material and it was running at sd 0.10. Normalised
    // it reaches its extremes, which is what makes a board read as sawn timber
    // with a figure in it rather than as a brown rectangle with a filter on it.
    const grainN = fbmField(size, {
      freq: 40, octaves: 4, seed: seed + 1, stretchY: 0.12, warp: 0.02, normalize: 0.03,
    });
    const rings = fbmField(size, { freq: 18, octaves: 3, seed: seed + 2, stretchY: 0.2, mode: 'ridged' });
    const split = fbmField(size, { freq: 30, octaves: 3, seed: seed + 3, stretchY: 0.08, mode: 'ridged' });
    // Timber's own basis: 2 mm rings, RIDGED (a growth ring is a ridge), at a
    // 3.0 lacunarity so the figure steps coarse-to-fine instead of blurring,
    // and stretchY 0.09 so the roughness runs the length of the board. The
    // material's albedo was already directional; its roughness map measured
    // aniso 1.74/2.62 only because the grain leaked in through albedo, and the
    // roughness the light actually answers was the same isotropic field the
    // concrete used.
    const mic = this.micro(weathered ? 'wood-weathered' : 'wood-plank', size, 'wood', seed + 4);
    const grain = grainField(size, seed + 6);
    // Decking silvers where the sun reaches it and stays dark and damp under the
    // rail; boards get replaced one at a time. Both are metres, not millimetres.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.13, warpFreq: 2, seed: seed + 5, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.22, warpFreq: 3, seed: seed + 7, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: seed + 8, clip: 0.05 }),
    });

    const light = rgb(weathered ? 0xa9a094 : 0xb08c5c);
    const dark = rgb(weathered ? 0x6f6a63 : 0x7a5a34);
    const knotC = rgb(weathered ? 0x574f47 : 0x4d3720);

    // a handful of knots per tile, placed deterministically
    const rnd = mulberry32(seed * 31 + 5);
    const knotN = weathered ? 4 : 3;
    const kx = new Float32Array(knotN);
    const ky = new Float32Array(knotN);
    const kr = new Float32Array(knotN);
    for (let k = 0; k < knotN; k++) {
      kx[k] = rnd();
      ky[k] = rnd();
      kr[k] = 0.02 + rnd() * 0.03;
    }

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const joint = smoothstep(0, 0.5, bf.edge[i]);
        const id = bf.id[i];
        const bias = hash2(id, 19, 11);

        let knot = 0;
        let knotRing = 0;
        for (let k = 0; k < knotN; k++) {
          let dx = u - kx[k];
          let dy = v - ky[k];
          dx -= Math.round(dx);
          dy -= Math.round(dy);
          const d = Math.sqrt(dx * dx + dy * dy);
          knot = Math.max(knot, smoothstep(kr[k] * 2.2, kr[k] * 0.5, d));
          knotRing = Math.max(knotRing, smoothstep(kr[k] * 4.5, kr[k], d) * (Math.sin(d * 260) * 0.5 + 0.5));
        }

        const g = grainN[i] * 0.6 + rings[i] * 0.4;
        const splitM = weathered ? smoothstep(0.72, 0.94, split[i]) : 0;
        mixRGB(dark, light, clamp01(g * 1.25 + bias * 0.25), _a);
        mixRGB(_a, knotC, clamp01(knot * 0.85 + knotRing * 0.25), _b);
        // the gap between planks goes almost black — that dark line is most of
        // what makes decking read as boards rather than a printed pattern
        const gapShade = 0.32 + joint * 0.68;
        const mv = microValue(mic, i);
        const tone = (0.9 + bias * 0.16 + (mv - 0.5) * 0.08 + (grain[i] - 0.5) * 0.05) * (1 - splitM * 0.2) * gapShade;
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        const h = joint * 0.5 + g * 0.2 + knot * 0.12 - splitM * 0.35 - (1 - joint) * 0.3;
        // The grain drives roughness twice: once through `g`, which is the
        // earlywood/latewood value, and once through the family basis, which is
        // the ring RELIEF. Latewood is denser and takes a shine; earlywood is
        // open and drinks it. That is the whole reason a plank looks like wood
        // and not like a brown rectangle when the sun rakes along it.
        const rough = clamp(
          microRough(mic, i, weathered ? 0.88 : 0.66) + (g - 0.5) * 0.16 + splitM * 0.1 - knot * 0.12,
          0.35,
          0.98,
        );
        const ao = 1 - (1 - joint) * 0.55 - splitM * 0.15 - knot * 0.08;
        f.surf(i, h, ao, rough);
      }
    }

    const m = this.maps(f, { normalStrength: 0.9 });
    const mat = this.std(m, { envMapIntensity: 0.8 });
    injectBreakup(mat, {
      macroTex,
      period: 7.3,
      strength: weathered ? 0.48 : 0.34,
      periodB: 2.4,
      strengthB: weathered ? 0.30 : 0.22,
      // sun-silvered on the exposed boards, warm and oily in the sheltered ones
      macroWarm: weathered ? 0xfff0e0 : 0xffe2bc,
      macroCool: 0xd9dee6,
      macroTint: weathered ? 0.36 : 0.44,
      macroRough: 0.26,
      // Grain runs the length of the board, which is V — the boards are laid
      // with `crossJoints` off precisely so they do. Wood whose only structure
      // is isotropic is the tell that a plank is a painted rectangle.
      streak: [0.72, 0.035, 0.06, 0.12],
      // damp/algae under the rail and in the lee: darker and rougher
      macroB: true,
      periodMacroB: 3.9,
      macroRoughB: 0.20,
      stain: [weathered ? 0.40 : 0.30, -0.18],
      stainTint: 0x7c7566,
      stainRange: [0.68, 0.97],
      instUv: 0.9,
      instTint: 0.09,
      // Weathered timber is the third of §4's five surface responses that the
      // scenery was spending on `stone-wall` instead — fence posts and marshal
      // posts are sawn softwood, not ashlar. Silvered timber is matte and it
      // must stay matte at every distance; the ×2.2 normalScale Props puts on
      // its own clone is what needs the variance term.
      roughFloor: weathered ? 0.62 : 0.44,
      specAA: 0.9,
      macroNormal: 0.35,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  // =========================================================================
  // Manufactured
  // =========================================================================

  /**
   * Galvanised, part-painted steel — the Armco guardrail and its posts, marker
   * posts, lamp columns, the tunnel's light housings.
   *
   * This used to be authored as lacquered kart bodywork, on the theory that
   * `livery()` would tint it into eight liveries. It never did: the kart
   * subsystem builds its own two-lobe lacquer in `Liveries.ts`, and every actual
   * consumer of this material is roadside steel. Authoring a guardrail as car
   * paint cost it twice —
   *
   *  • a `clearcoat 1 / clearcoatRoughness 0.155` lobe riding on a
   *    `clearcoatNormalMap`, i.e. a near-mirror second specular lobe standing on
   *    a normal map with 2.5 cm ridged creases in it. On a rail two pixels tall
   *    at 60 m that is a sub-pixel mirror per pixel, which is the "sparkling line
   *    of white speckle" down the rail's top edge in hud.png, verbatim; and
   *  • a `ridged` scratch field at freq 60 — a crease every 2.5 cm on a 1.5 m
   *    tile — which is where the "speckled granite" read came from. A rail is
   *    rolled, not crushed: its structure runs one way, along its length, and it
   *    is shallow.
   *
   * So: no clearcoat, a rolled longitudinal grain instead of a crease field, a
   * real metalness split between bare galv and the paint film over it, and a
   * roughness floor that keeps the whole thing out of mirror territory.
   * `livery()` re-enables the coat for anyone still asking for lacquer.
   */
  private buildPaintedMetal(size: number): Entry {
    const f = new Fields(size);
    const peel = fbmField(size, { freq: Math.round(size / 14), octaves: 3, seed: 141 });
    // Rolled longitudinal grain. V runs down the rail (TrackGeometry lays the
    // guardrail's V along its arc length), so `stretchY 0.16` draws this out
    // along the rail — the direction a section of Armco was actually formed in.
    // freq 8 rather than 60: 19 cm of waviness, not a 2.5 cm crease, and plain
    // fbm rather than ridged so it has no hard valleys to facet on.
    const roll = fbmField(size, { freq: 8, octaves: 3, seed: 142, stretchY: 0.16, normalize: 0.03 });
    // Rolled steel's own basis: 1.5 mm structure drawn out 10:1 along the
    // direction of rolling, gamma 1.5 so the sheet is mostly at its smoother
    // end with the chalked and abraded runs as the exception. This is the
    // family that must NOT share a response with `concrete` — a galvanised rail
    // and a cast parapet stand next to each other in half the frames.
    const mic = this.micro('metal-painted', size, 'metal-rolled', 150);
    // Longitudinal scuffs from whatever last slid along it. Fine, but shallow
    // and directional, and they reach ROUGHNESS far more than they reach height.
    const scuffL = fbmField(size, { freq: 26, octaves: 2, seed: 152, stretchY: 0.07 });
    // The galvanising spangle — the crystal pattern zinc freezes in. It is a
    // real feature of the surface but it is an ALBEDO/roughness feature at 2 cm,
    // not a relief one, which is the distinction the old material missed.
    const spangle = voronoiField(size, 34, 34, 1.0, 143);
    // Impact dents: a guardrail's job is to be hit. 25 cm dishes, rare.
    const dent = voronoiField(size, 6, 6, 0.9, 153, 2);
    const dust = fbmField(size, { freq: 5, octaves: 3, seed: 144, warp: 0.05 });
    const grain = grainField(size, 146);
    // Which runs of rail were repainted last season and which have chalked back
    // to bare zinc. On a 1.5 m tile that is a whole section of barrier.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 3, octaves: 3, warp: 0.12, warpFreq: 2, seed: 145, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.18, warpFreq: 3, seed: 148, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 149, clip: 0.05 }),
    });

    // Near-white so `variant()` can tint it to anything — a white guardrail, a
    // grey lamp column, a red marker post — off one texture set.
    const paint = rgb(0xeceded);
    // Bare hot-dip zinc: a cool, slightly blue-grey metal, well off white.
    const zinc = rgb(0xa9b0b4);
    const rust = rgb(0x8a5a3c);

    for (let i = 0; i < size * size; i++) {
      const scr = smoothstep(0.62, 0.95, scuffL[i]);
      // An Armco barrier is galvanised FIRST and painted second, and after a
      // season on a coastal road it is mostly the former: bare zinc over most of
      // the section with the paint film surviving in the rolled recesses and on
      // the sheltered face. So this runs 0.31–1.0 with a mean near 0.6, and the
      // dielectric paint is the minority phase rather than the other way round.
      // That split is what makes it answer the low sun as steel instead of as a
      // white-painted board, and it is the §4 "metals must sample the
      // environment" line finally being spent on the roadside metal.
      const bare = clamp01(0.45 + scr * 0.45 + (peel[i] - 0.5) * 0.9);
      // Spangle only reads on the bare zinc; under paint it is buried.
      const spg = (hash2(spangle.id[i], 17, 29) - 0.5) * bare;
      const dnt = hash2(dent.id[i], 7, 51) > 0.84 ? smoothstep(0.5, 0.1, dent.f1[i]) : 0;
      const rst = smoothstep(0.90, 0.99, dust[i]) * bare * 0.7;

      mixRGB(paint, zinc, bare, _a);
      mixRGB(_a, rust, rst, _b);
      const tone = 0.97 + (peel[i] - 0.5) * 0.05 + spg * 0.10 - dust[i] * 0.04 +
        (grain[i] - 0.5) * 0.02 - dnt * 0.06;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      // Total relief is a third of what it was and all of it is long-wave. The
      // roll carries the form, the dent carries the story, and the scuff is
      // barely in the height field at all — it lives in roughness, where a
      // scratch on steel actually lives.
      const h = roll[i] * 0.42 + peel[i] * 0.08 + scr * 0.02 - dnt * 0.34;
      // Genuinely bimodal and genuinely metal, centred around 0.44.
      //
      // The review asked for 0.32 on the galvanised rail. That is the number for
      // clean rolled sheet, and taking it would have put the one long thin
      // grazing-angle object in the frame back at a GGX alpha of 0.10 — i.e.
      // straight back into the sparkle this rebuild exists to remove. Hot-dip
      // galvanising is not polished steel: it freezes with a crystalline spangle
      // and oxidises to a matte grey within a season, which is a genuinely
      // rougher surface. 0.38–0.60 across the zinc still reads unmistakably as
      // metal under a 14° key — it gives a broad warm sheen running the length
      // of the barrier rather than a dotted line of pinpoints — and it is the
      // sheen, not the pinpoints, that the note was actually asking for.
      const rough = clamp(
        microRough(mic, i, 0.34) + bare * 0.22 + scr * 0.18 + rst * 0.30 + dust[i] * 0.14 +
          (peel[i] - 0.5) * 0.14 - spg * 0.10,
        0.34,
        0.92,
      );
      // The metalness split §4 asks for and the material never had: paint is a
      // dielectric, zinc is not, and the boundary between them is most of what
      // makes part-worn galvanising recognisable. Rust is a dielectric again.
      const metal = clamp(bare * 0.88 - rst * 0.7, 0, 0.9);
      const ao = 1 - dnt * 0.22 - rst * 0.10;
      f.surf(i, h, ao, rough, metal);
    }

    const m = this.maps(f, { normalStrength: 0.22 });
    const mat = this.phys(m, {
      // The ORM's B channel now carries a real 0 → 0.9 metalness split, so the
      // factor has to be 1 for the map to mean anything. It was 0 — which is
      // how a material whose whole subject is galvanised steel rendered as a
      // dielectric everywhere.
      metalness: 1,
      // NO CLEARCOAT. There is no lacquer on an Armco barrier, and a
      // 0.155-roughness second lobe with the base normal map bound to it is the
      // single biggest specular aliaser in the frame — see the class comment.
      // `livery()` turns it back on for the one caller that wants car paint.
      clearcoat: 0,
      // Steel answers the sky far harder than paint does, but the probe is a
      // baked sky dome and 1.6 on a metal at a grazing angle is where the rail
      // starts clipping to white along its entire length. 0.95 keeps the warm
      // horizon line running down the top flange without blowing it out.
      envMapIntensity: 0.95,
    });
    // Which sections were repainted and which have chalked back to zinc — and
    // mostly in roughness, because that is the difference the eye reads at
    // 40 m. A barrier that is one roughness for a hundred metres is a decal.
    injectBreakup(mat, {
      macroTex,
      period: 4.7,
      strength: 0.30,
      periodB: 1.5,
      strengthB: 0.20,
      macroWarm: 0xfff4e8,
      macroCool: 0xe4ecff,
      macroTint: 0.16,
      macroRough: 0.30,
      macroB: true,
      periodMacroB: 2.3,
      macroRoughB: 0.22,
      // The rail runs from 3 m to the horizon and spends most of that at a
      // grazing angle across two or three pixels. Both of these exist for that:
      // the floor stops the six gloss multipliers reaching mirror, and specAA
      // widens the lobe wherever a pixel cannot resolve the surface under it.
      roughFloor: 0.34,
      specAA: 1.0,
      // ...and the rolled grain fades out with the same signal, so a distant
      // barrier settles to plain steel rather than keeping full relief.
      settle: [40, 110],
      settleRough: 0.52,
      macroNormal: 0.35,
    });
    // A part-metal surface with no lower hemisphere in its probe returns sky
    // from every downward-facing facet, which on the underside of a rail is a
    // band of blue where there should be warm bounce off the tarmac.
    injectEnvGround(mat, ENV_GROUND);
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Roll bars, exhausts, railings. Spatially varying roughness — polished chrome is never uniform. */
  private buildChrome(size: number): Entry {
    const f = new Fields(size);
    const smudge = fbmField(size, { freq: 6, octaves: 4, seed: 151, warp: 0.08 });
    // Brushed metal runs ONE way. 0.1 was already a strong stretch; what was
    // missing is that the anisotropy never reached roughness hard enough to
    // stretch the highlight, so the "brush" was a texture on an isotropic
    // mirror rather than a direction the mirror smears light along.
    const brush = fbmField(size, { freq: 70, octaves: 2, seed: 152, stretchY: 0.07, normalize: 0.02 });
    const dent = fbmField(size, { freq: 10, octaves: 3, seed: 153, warp: 0.05 });
    const grain = grainField(size, 154);

    const base = rgb(0xf3f5f8);
    const tarnish = rgb(0xcfd3d8);

    for (let i = 0; i < size * size; i++) {
      const sm = smoothstep(0.45, 0.85, smudge[i]);
      mixRGB(base, tarnish, sm * 0.5, _a);
      f.setRGB(i, _a);
      const h = dent[i] * 0.2 + brush[i] * 0.05;
      // Chrome tops out at 0.24, not 0.5. Above about a quarter the GGX lobe is
      // wide enough that the reflection stops being an image of anything and
      // becomes a tinted glow — and a metal with no image in it is exactly the
      // "no reflection in the chrome" note. The spread is still 6× floor to
      // ceiling, so the roughness varies spatially as the bible demands; it just
      // no longer includes "not actually a mirror".
      const rough = clamp(0.055 + sm * 0.12 + (brush[i] - 0.5) * 0.10 + (dent[i] - 0.5) * 0.04, 0.035, 0.24);
      f.surf(i, h, 1, rough, 1);
    }

    const m = this.maps(f, { normalStrength: 0.25 });
    // A roughness-0.12 metal is nothing but its reflection. At a scene
    // environmentIntensity of 0.40 an envMapIntensity of 1.6 leaves the roll bar
    // reading as pale blue-grey paint rather than a mirror carrying the horizon.
    const mat = this.std(m, { envMapIntensity: 2.6 });
    // A roll bar is nothing but what it reflects, and the probe's lower half is
    // more sky — so the bar came out as a smooth pink gradient with no structure
    // and no horizon. The ground half is what turns it back into metal: the
    // terminator sweeping around a tube is the single feature that reads as
    // "mirror" rather than "painted plastic pipe".
    // ...and the terminator has to be HARD. `soft` widens with roughness inside
    // the injection, so on a 0.055 bar 0.012 is a knife edge and on a smudged
    // 0.24 stretch it opens up on its own — which is the difference between the
    // two showing on the same part.
    injectEnvGround(mat, { ...ENV_GROUND, amount: 0.94, soft: 0.012 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Tyres. Knurled sidewall, moulding flash, and a polished band where it meets the road. */
  private buildRubber(size: number): Entry {
    const f = new Fields(size);
    const scuff = fbmField(size, { freq: 8, octaves: 4, seed: 161, warp: 0.05 });
    const fine = fbmField(size, { freq: Math.round(size / 6), octaves: 2, seed: 162 });
    const grain = grainField(size, 163);

    const base = rgb(0x1e1e22);
    const dusty = rgb(0x3a3a3f);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      // knurl: a fine diamond lattice, the classic moulded sidewall texture
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const ka = Math.abs(((u * 48 + v * 48) % 1) - 0.5) * 2;
        const kb = Math.abs(((u * 48 - v * 48 + 100) % 1) - 0.5) * 2;
        const knurl = smoothstep(0.55, 0.95, Math.min(ka, kb));
        const flash = smoothstep(0.02, 0.0, Math.abs(((v * 2) % 1) - 0.5));
        const dust = smoothstep(0.5, 0.85, scuff[i]);

        mixRGB(base, dusty, dust * 0.4 + fine[i] * 0.08, _a);
        const tone = 0.96 + knurl * 0.045 + (grain[i] - 0.5) * 0.04;
        f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

        const h = knurl * 0.06 + flash * 0.12 + fine[i] * 0.06;
        const rough = clamp(0.92 - knurl * 0.14 - dust * 0.1 + (fine[i] - 0.5) * 0.12, 0.55, 0.99);
        const ao = 1 - (1 - knurl) * 0.16;
        f.surf(i, h, ao, rough);
      }
    }

    const m = this.maps(f, { normalStrength: 0.6 });
    const mat = this.std(m, { envMapIntensity: 0.5 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Windscreens, shop windows, lamp glass. Cheap alpha blend, not transmission — this is a racer. */
  private buildGlass(size: number): Entry {
    const f = new Fields(size);
    const smear = fbmField(size, { freq: 5, octaves: 4, seed: 171, warp: 0.1 });
    const dust = fbmField(size, { freq: 14, octaves: 3, seed: 172 });
    const grain = grainField(size, 173);

    for (let i = 0; i < size * size; i++) {
      const sm = smoothstep(0.55, 0.9, smear[i]);
      const d = 250 - sm * 14 - dust[i] * 8;
      f.set(i, d, d + 3, d + 6);
      const h = smear[i] * 0.08;
      const rough = clamp(0.04 + sm * 0.13 + dust[i] * 0.05 + (grain[i] - 0.5) * 0.01, 0.02, 0.3);
      f.surf(i, h, 1, rough, 0);
    }

    const m = this.maps(f, { normalStrength: 0.12 });
    const mat = this.phys(m, {
      metalness: 0,
      color: 0xd9ecf5,
      transparent: true,
      opacity: 0.34,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 2.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    injectEnvGround(mat, { ...ENV_GROUND, amount: 0.8 });
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  /** Striped awning canvas over the harbour shops. Woven, sun-faded, tintable. */
  private buildAwning(size: number): Entry {
    const f = new Fields(size);
    const sag = fbmField(size, { freq: 6, octaves: 3, seed: 181, stretchY: 0.3 });
    const fade = fbmField(size, { freq: 4, octaves: 3, seed: 182, warp: 0.05 });
    const grain = grainField(size, 183);

    const light = rgb(0xf2ece0);
    const tintable = rgb(0xb2b2b2); // multiplied by variant colour
    const threads = 96;

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const stripe = Math.floor(v * 6) % 2 === 0;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // plain weave: which thread is on top alternates on both axes
        const tu = u * threads;
        const tv = v * threads;
        const over = (Math.floor(tu) + Math.floor(tv)) % 2 === 0;
        const wu = Math.abs((tu % 1) - 0.5) * 2;
        const wv = Math.abs((tv % 1) - 0.5) * 2;
        const thread = over ? 1 - wu : 1 - wv;

        const c = stripe ? light : tintable;
        const faded = 0.9 + fade[i] * 0.18 + sag[i] * 0.06 + (grain[i] - 0.5) * 0.05;
        const shade = 0.88 + thread * 0.16;
        f.set(i, c.r * faded * shade, c.g * faded * shade, c.b * faded * shade);

        const h = thread * 0.4 + sag[i] * 0.25;
        const rough = clamp(0.88 - thread * 0.08 + (fade[i] - 0.5) * 0.12, 0.6, 0.99);
        const ao = 1 - (1 - thread) * 0.3;
        f.surf(i, h, ao, rough);
      }
    }

    const m = this.maps(f, { normalStrength: 0.9 });
    const mat = this.std(m, { side: THREE.DoubleSide, envMapIntensity: 0.7 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Poured concrete: harbour walls, tunnel lining, jetty. */
  private buildConcrete(size: number): Entry {
    const f = new Fields(size);
    const agg = voronoiField(size, 30, 30, 1.0, 191);
    const bubble = voronoiField(size, 60, 60, 1.0, 192);
    const stain = fbmField(size, { freq: 5, octaves: 4, seed: 193, warp: 0.07 });
    const streak = fbmField(size, { freq: 10, octaves: 3, seed: 194, stretchY: 0.14 });
    // Cast concrete's own basis. The critical column is `stretchY: 3.2` — a
    // shuttered pour carries the horizontal grain of the form boards it was
    // cast against, and that is the one structure that distinguishes concrete
    // from every stone in the game at a glance. With the old shared
    // `fbmField(size / 8, 2 octaves)` this material measured aniso 1.00 and its
    // roughness spectrum was within 0.19 of `dirt`'s.
    const mic = this.micro('concrete', size, 'concrete', 195);
    const grain = grainField(size, 197);
    // Concrete is poured in bays, and each bay cures its own colour. The join
    // between two pours is a 3-6 m event, so it can only live out here.
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.17, warpFreq: 2, seed: 196, clip: 0.04 }),
      g: macroField(MACRO_RES, { freq: 4, octaves: 3, warp: 0.22, warpFreq: 3, seed: 198, clip: 0.06 }),
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 199, clip: 0.05 }),
    });

    const base = rgb(0x9d9a94);
    const pale = rgb(0xb6b2aa);
    const dirty = rgb(0x736f68);

    for (let i = 0; i < size * size; i++) {
      const speck = smoothstep(0.2, 0.08, agg.f1[i]) * (hash2(agg.id[i], 29, 14) > 0.7 ? 1 : 0);
      const pit = smoothstep(0.1, 0.03, bubble.f1[i]) * (hash2(bubble.id[i], 31, 15) > 0.78 ? 1 : 0);
      const grime = smoothstep(0.55, 0.9, stain[i]) * 0.34 + smoothstep(0.7, 0.95, streak[i]) * 0.16;

      const mv = microValue(mic, i);
      mixRGB(base, pale, speck * 0.5 + mv * 0.2, _a);
      mixRGB(_a, dirty, clamp01(grime), _b);
      const tone = 0.93 + (mv - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05 - pit * 0.35;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = mv * 0.15 + speck * 0.1 - pit * 0.6;
      // gamma 0.65: raw concrete is rough almost everywhere. The exceptions are
      // the trowelled/formed faces that took a skin, and they are a minority.
      const rough = clamp(microRough(mic, i, 0.82) + pit * 0.12 + grime * 0.06 - speck * 0.06, 0.5, 0.98);
      const ao = 1 - pit * 0.55 - grime * 0.1;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 0.7 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, {
      macroTex,
      period: 17.1,
      strength: 0.46,
      periodB: 5.5,
      strengthB: 0.30,
      macroWarm: 0xfff0dc,
      macroCool: 0xdae0ea,
      macroTint: 0.32,
      macroRough: 0.28,
      // rundown staining below every joint and coping
      streak: [0.58, 0.05, 0.05, 0.14],
      // splash zone: the metre or so of harbour wall that never dries out
      macroB: true,
      periodMacroB: 8.2,
      macroRoughB: 0.18,
      stain: [0.44, 0.22],
      stainTint: 0x6f6d68,
      stainRange: [0.66, 0.96],
      instUv: 0.6,
      instTint: 0.05,
      // Cast concrete is the one of §4's five surface responses this library
      // was never actually spending — the fence rails, sign frames and barrier
      // trim all came through as ashlar `stone-wall` instead, so four objects
      // presented as one material. This is the repoint target for all of them;
      // it stays matte, warm-grey and floored well clear of gloss so it can
      // never be confused with the galvanised rail beside it.
      roughFloor: 0.55,
      specAA: 0.8,
      macroNormal: 0.30,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /** Polished marble for the plaza, fountain and bridge caps. Veins by domain-warped ridges. */
  private buildMarble(size: number): Entry {
    const f = new Fields(size);
    const vein = fbmField(size, { freq: 3, octaves: 5, seed: 201, mode: 'ridged', warp: 0.16, warpFreq: 2 });
    const vein2 = fbmField(size, { freq: 6, octaves: 4, seed: 202, mode: 'ridged', warp: 0.12, warpFreq: 3 });
    const cloud = fbmField(size, { freq: 4, octaves: 4, seed: 203, warp: 0.08 });
    // gamma 1.9: a polished stone is polished nearly everywhere. What the eye
    // reads is the small minority that ISN'T — buffing arcs, a scuff, a patch
    // the mop never reaches — so the response has to be one-sided or the floor
    // reads as satin plastic. This is the opposite response curve from
    // `stone-rough` on the same nominal material class, which is the point.
    const mic = this.micro('marble', size, 'stone-polished', 204);
    const grain = grainField(size, 205);
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.14, warpFreq: 2, seed: 206, clip: 0.04 }),
    });

    const base = rgb(0xf1eee8);
    const grey = rgb(0x8a8d94);
    const gold = rgb(0xb99a63);
    const veinCore = rgb(0x5a5f68);

    for (let i = 0; i < size * size; i++) {
      const v1 = smoothstep(0.70, 0.94, vein[i]);
      const v2 = smoothstep(0.78, 0.98, vein2[i]);
      const core = smoothstep(0.88, 0.99, vein[i]);
      mixRGB(base, grey, v1 * 0.9, _a);
      mixRGB(_a, gold, v2 * 0.55, _b);
      mixRGB(_b, veinCore, core * 0.6, _b);
      const tone = 0.95 + cloud[i] * 0.09 + (grain[i] - 0.5) * 0.02;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      // veins are slightly softer stone, so they polish differently — that
      // roughness break is what sells marble over "grey noise"
      const h = v1 * 0.1 + v2 * 0.06 + cloud[i] * 0.04;
      const rough = clamp(microRough(mic, i, 0.16) + v1 * 0.14 + v2 * 0.1, 0.06, 0.55);
      f.surf(i, h, 1 - v1 * 0.08, rough);
    }

    const m = this.maps(f, { normalStrength: 0.3 });
    const mat = this.phys(m, {
      metalness: 0,
      clearcoat: 0.65,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.1,
    });
    injectBreakup(mat, {
      macroTex,
      period: 11.3,
      strength: 0.45,
      // A polished floor is never one gloss: it is walked in tracks and buffed in
      // arcs, and on a stone this smooth the roughness swing is the only thing
      // the eye has to read the surface by.
      macroRough: 0.30,
      instUv: 0.7,
      instTint: 0.06,
      // Polished stone at a 0.1 clearcoat roughness is the second-tightest lobe
      // in the library after chrome, and the marina railing is a thin horizontal
      // run at a grazing angle — the same geometry that made the guardrail
      // strobe. specAA reaches the coat as well as the base here.
      specAA: 0.7,
      roughFloor: 0.12,
    });
    // The marina railing and the bridge copings are the only polished stone in
    // the game and they were reflecting a bare sky gradient, which on a 0.16
    // roughness surface is indistinguishable from a flat pale paint. With a
    // ground half and a terminator the top of a rail goes sky and its underside
    // goes warm stone, which is the whole reason to make a thing out of marble.
    injectEnvGround(mat, { ...ENV_GROUND, amount: 0.86, soft: 0.02 });
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: [...m.all, macroTex] };
  }

  // =========================================================================
  // Emissive
  // =========================================================================

  /**
   * Boost strip: a glossy poured-resin panel under animated cyan chevrons that
   * flow forward in +V.
   *
   * It is the brightest object in the frame, so it has to be the best resolved.
   * Two things were fighting that. The substrate carried a 12 cm noise octave in
   * albedo *and* height, which at a grazing angle is aggregate crawling straight
   * through the emissive — you could not tell whether the pad was paint, plastic
   * or a light panel. And the chevrons were a hard-edged high-contrast stripe
   * pattern minified to nothing with no LOD bias, which is the crawl. So: a
   * smooth resin substrate that still reads as a surface where it is not lit,
   * and the stripe pattern deliberately biased into a higher mip at range.
   */
  private buildBoostPad(size: number): Entry {
    const f = new Fields(size);
    const emissive = new Uint8ClampedArray(size * size * 4);
    // 6 cells over a 6 m tile ≈ 1 m swirl in the resin, not 12 cm gravel
    const tread = fbmField(size, { freq: 6, octaves: 3, seed: 211, warp: 0.06 });
    const wear = fbmField(size, { freq: 4, octaves: 3, seed: 212, warp: 0.05 });
    const rivet = voronoiField(size, 8, 8, 0.2, 213);
    const grain = grainField(size, 214);

    const plate = rgb(0x27303f);
    const plateWorn = rgb(0x39445a);
    const glow = rgb(0x4fc3ff);
    const glowHot = rgb(0xdcf4ff);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // four chevrons per tile, apex leading
        const chev = ((v * 4 - Math.abs(u - 0.5) * 1.15) % 1 + 1) % 1;
        const band = smoothstep(0.06, 0.16, chev) * (1 - smoothstep(0.5, 0.62, chev));
        const core = smoothstep(0.12, 0.24, chev) * (1 - smoothstep(0.4, 0.52, chev));
        const margin = smoothstep(0.06, 0.02, Math.min(u, 1 - u));
        const chevron = clamp01(band * (1 - margin));
        const riv = smoothstep(0.16, 0.08, rivet.f1[i]) * margin;

        mixRGB(plate, plateWorn, wear[i] * 0.7, _a);
        // The albedo only tints toward the glow — it must not try to *be* the
        // glow, or the lit pixels clip before the emissive has said anything.
        mixRGB(_a, glow, chevron * 0.3, _b);
        const tone = 0.94 + tread[i] * 0.08 + (grain[i] - 0.5) * 0.03 + riv * 0.16;
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        mixRGB(glow, glowHot, core * 0.55, _c);
        const k = i * 4;
        // A flat-topped band at full value is a solid white bar the moment bloom
        // touches it, and a solid white bar has no material. Shaped into a dim
        // cyan flank and a hot narrow core, the same chevron keeps its hue and
        // its edge under the same bloom.
        const e = chevron * (0.34 + core * 0.82);
        emissive[k] = _c.r * e;
        emissive[k + 1] = _c.g * e;
        emissive[k + 2] = _c.b * e;
        emissive[k + 3] = 255;

        // Relief stays in the rivets and the chevron lip only. Resin is poured,
        // it is not gravel, and a height field full of 12 cm noise is what put
        // the tarmac's own aggregate response on top of a light panel.
        const h = tread[i] * 0.05 + riv * 0.5 - chevron * 0.1;
        const rough = clamp(0.18 + (tread[i] - 0.5) * 0.14 + (1 - chevron) * 0.06 - wear[i] * 0.05, 0.08, 0.4);
        f.surf(i, h, 1 - riv * 0.15, rough, 0.05 + riv * 0.45);
      }
    }

    const m = this.maps(f, { normalStrength: 0.45 });
    const emissiveMap = new THREE.CanvasTexture(this.bytesCanvas(size, emissive));
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
    emissiveMap.anisotropy = this.aniso;
    emissiveMap.generateMipmaps = true;
    emissiveMap.minFilter = THREE.LinearMipmapLinearFilter;
    emissiveMap.magFilter = THREE.LinearFilter;
    emissiveMap.needsUpdate = true;

    const mat = this.phys(m, {
      // a glossy resin substrate, so the unlit half of the pad is still a
      // material and not an absence. metalness comes off the ORM blue channel:
      // dielectric resin with metal rivets down the margins.
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      emissive: 0xffffff,
      emissiveMap,
      // 1.6 clipped the chevrons to flat white. The tunnel volume darkens the
      // road around the pad by ~90% but emissive is not darkened with it, so
      // the pad was the brightest surface in the scene by a wide margin and lost
      // its internal gradient exactly where it is most on show.
      emissiveIntensity: 1.15,
      envMapIntensity: 1.2,
    });
    injectBoostPad(mat);
    injectEnvGround(mat, ENV_GROUND);
    this.boostEmissive = emissiveMap;
    this.boostMat = mat;
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: [...m.all, emissiveMap] };
  }

  /** Tunnel sodium strips and shop neon: a frosted tube with a hot core. */
  private buildLightStrip(size: number, hex: number, intensity: number): Entry {
    const f = new Fields(size);
    const emissive = new Uint8ClampedArray(size * size * 4);
    const frost = fbmField(size, { freq: 18, octaves: 3, seed: 221 });
    const dust = fbmField(size, { freq: 6, octaves: 3, seed: 222, warp: 0.05 });

    const c = rgb(hex);
    const hot = rgb(0xfff6e8);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      // tube cross-section runs across V: hot in the middle, falling off to the ends
      const prof = Math.pow(Math.sin(clamp01(v) * Math.PI), 0.5);
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const grime = 1 - dust[i] * 0.25;
        mixRGB(c, hot, prof * 0.55, _a);
        const e = prof * grime * (0.85 + frost[i] * 0.3);
        f.set(i, lerp(60, _a.r, e * 0.7), lerp(60, _a.g, e * 0.7), lerp(62, _a.b, e * 0.7));
        const k = i * 4;
        emissive[k] = _a.r * e;
        emissive[k + 1] = _a.g * e;
        emissive[k + 2] = _a.b * e;
        emissive[k + 3] = 255;
        f.surf(i, frost[i] * 0.15, 1, clamp(0.28 + frost[i] * 0.3 + dust[i] * 0.1, 0.1, 0.8), 0);
      }
    }

    const m = this.maps(f, { normalStrength: 0.3 });
    const emissiveMap = new THREE.CanvasTexture(this.bytesCanvas(size, emissive));
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
    emissiveMap.needsUpdate = true;

    const mat = this.std(m, {
      emissive: 0xffffff,
      emissiveMap,
      emissiveIntensity: intensity,
      envMapIntensity: 0.4,
    });
    if (hex === 0x4fc3ff) this.neonMat = mat;
    return { mat, textures: [...m.all, emissiveMap] };
  }

  // =========================================================================
  // Water
  // =========================================================================

  /**
   * The bay. Two scrolling octaves of the same wave normal, a view-dependent
   * shallow→deep colour ramp and a hard clearcoat so the sun clips to white and
   * blooms — which the bible calls out as *the* look.
   */
  private buildWater(size: number): Entry {
    const f = new Fields(size);
    const w1 = fbmField(size, { freq: 6, octaves: 4, seed: 231, warp: 0.05 });
    const w2 = fbmField(size, { freq: 14, octaves: 3, seed: 232, stretchY: 0.6 });
    const wind = fbmField(size, { freq: 3, octaves: 3, seed: 233, warp: 0.08 });

    // The albedo stays near-white: the shallow→deep colour is supplied by the
    // shader ramp below, so the same texture works at any water depth.
    for (let i = 0; i < size * size; i++) {
      const h = w1[i] * 0.7 + w2[i] * 0.3;
      const t = 226 + h * 26;
      f.set(i, t, t + 4, t + 6);
      // wind streaks ruffle the surface: the roughness variation is what makes
      // the specular sheet break up into a plausible glitter path
      const rough = clamp(0.045 + wind[i] * 0.1 + (w2[i] - 0.5) * 0.04, 0.02, 0.2);
      f.surf(i, h, 1, rough, 0);
    }

    // A near-flat mirror at a 14° grazing angle reflects the sky at ~100% Fresnel
    // everywhere, which is why the bay came out sitting in the same value band as
    // the sky above it with no horizon at all. Chop is what breaks that: facets
    // have to tip far enough for the troughs to show the water body and the crests
    // to catch the sun. 0.95 was nowhere near enough tilt to do it.
    const m = this.maps(f, { normalStrength: 2.4 });
    const uTime = { value: 0 };
    const uShallow = { value: new THREE.Color(0x3fc9c4) };
    const uDeep = { value: new THREE.Color(0x0d5a7a) };
    const mat = this.phys(m, {
      color: 0xffffff,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.8,
      normalScale: new THREE.Vector2(0.85, 0.85),
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.uniforms.uShallow = uShallow;
      shader.uniforms.uDeep = uDeep;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WORLD_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WORLD_VERTEX);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n' +
            WORLD_PARS +
            'uniform float uTime;\nuniform vec3 uShallow;\nuniform vec3 uDeep;\n',
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          #include <map_fragment>
          // Depth ramp. Grazing angles look through more water, so they show the
          // deep body; looking down into it shows the shallow colour. Driven by
          // the *flat* plane normal so the ramp reads as depth and not as chop.
          #ifndef FLAT_SHADED
            float wCos = clamp( dot( normalize( vViewPosition ), normalize( vNormal ) ), 0.0, 1.0 );
            float wFacing = pow( wCos, 0.55 );
            // near water is measurably darker than the horizon band: without this
            // the bay sits in the sky's value range and there is no horizon line
            float wNear = 1.0 - smoothstep( 12.0, 260.0, vViewDist );
            diffuseColor.rgb *= mix( uDeep, uShallow, wFacing ) * ( 1.0 - wNear * 0.45 );
            // Schlick, F0 = 0.02. Without it the body colour is added at full
            // strength right out to the horizon and the sea is a matte slab that
            // happens to be blue; with it the bay goes teal underfoot and
            // near-mirror at a grazing angle, which at golden hour is the most
            // valuable specular event on the course.
            float wFres = 0.02 + 0.98 * pow( 1.0 - wCos, 5.0 );
            diffuseColor.rgb *= 1.0 - wFres * 0.88;
          #endif`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            // Two octaves at non-matching scales AND non-matching speeds, so the
            // interference pattern never settles into a visible tile.
            vec2 wUv1 = vNormalMapUv + vec2( uTime * 0.0125, uTime * 0.0205 );
            vec2 wUv2 = vNormalMapUv * 2.37 - vec2( uTime * 0.0185, uTime * 0.0095 );
            vec3 wN1 = texture2D( normalMap, wUv1 ).xyz * 2.0 - 1.0;
            vec3 wN2 = texture2D( normalMap, wUv2 ).xyz * 2.0 - 1.0;
            vec3 mapN = normalize( vec3( wN1.xy + wN2.xy, wN1.z * wN2.z ) );
            // Chop has to fall off toward the horizon or the far bay aliases into
            // a crawling band; near water keeps its full tilt so the troughs read.
            // But it must fade toward a *statistical* roughness, not toward flat:
            // wavelets do not stop existing at 200 m, they stop being resolvable,
            // and a mirror-flat far bay is a sheet of paper with a seam on it.
            mapN.xy *= normalScale * ( 1.0 - smoothstep( 90.0, 700.0, vViewDist ) * 0.55 );
            normal = normalize( tbn * mapN );
          #endif`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
          #include <roughnessmap_fragment>
          // the chop the normal map gave up at range comes back as roughness, so
          // the far bay stays a rough mirror rather than becoming a flat one
          roughnessFactor = clamp( roughnessFactor + smoothstep( 90.0, 700.0, vViewDist ) * 0.09, 0.02, 0.35 );`,
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          #if ( NUM_DIR_LIGHTS > 0 )
            // The sun path. At 14° elevation the specular lobe from the key must
            // lay a broad shimmering track across the bay toward camera, clipping
            // well above 1.0 so bloom picks it up — §2 of the bible calls that
            // clip the look, and it is the single highest-value pixel in the shot.
            vec3 wV = normalize( vViewPosition );
            vec3 wH = normalize( wV + directionalLights[ 0 ].direction );
            float wNH = max( 0.0, dot( normal, wH ) );
            // Three lobes, not one. An exponent of 900 is a point of light, not a
            // glitter path — the track has to be broad enough to survive the far
            // field where the wave normals have already settled, or the single
            // best specular event at golden hour is one blown pixel.
            float wSpec = pow( wNH, 620.0 ) * 18.0
                        + pow( wNH, 120.0 ) * 3.2
                        + pow( wNH, 22.0 ) * 0.85;
            reflectedLight.directSpecular += directionalLights[ 0 ].color * wSpec;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'water3';
    this.waterTime = uTime;
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  // =========================================================================
  // Drawn cards (canvas path work, then modulated per texel)
  // =========================================================================

  /** Palm trunk: overlapping diamond leaf-scars and vertical fibre. */
  private buildPalmBark(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 6, 13, 0.5, 0.1, 0.02, 241);
    const fibre = fbmField(size, { freq: 46, octaves: 3, seed: 242, stretchY: 0.1 });
    const rot = fbmField(size, { freq: 6, octaves: 3, seed: 243, warp: 0.06 });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 244 });
    const grain = grainField(size, 245);
    const macroTex = this.macroMaps({
      r: macroField(MACRO_RES, { freq: 2, octaves: 3, warp: 0.16, warpFreq: 2, seed: 246, clip: 0.04 }),
      g: null,
      b: macroField(MACRO_RES, { freq: 3, octaves: 2, warp: 0.10, seed: 247, clip: 0.05 }),
    });

    const bark = rgb(0x8a7359);
    const darkC = rgb(0x5d4c3b);
    const paleC = rgb(0xa8927a);

    for (let i = 0; i < size * size; i++) {
      const lu = bf.lu[i];
      const lv = bf.lv[i];
      // diamond scar: a chamfered lozenge inside each lattice cell
      const d = Math.abs(lu - 0.5) + Math.abs(lv - 0.5);
      const scar = smoothstep(0.5, 0.24, d);
      const rim = smoothstep(0.5, 0.42, d) * (1 - smoothstep(0.42, 0.3, d));
      const id = bf.id[i];
      const bias = hash2(id, 37, 21);
      const decay = smoothstep(0.55, 0.85, rot[i]);

      mixRGB(darkC, bark, clamp01(scar * 0.8 + fibre[i] * 0.5), _a);
      mixRGB(_a, paleC, rim * 0.5 + bias * 0.2, _b);
      const tone = 0.88 + bias * 0.16 + (fine[i] - 0.5) * 0.12 + (grain[i] - 0.5) * 0.05 - decay * 0.12;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = scar * 0.55 + rim * 0.25 + fibre[i] * 0.16 - (1 - scar) * 0.2;
      const rough = clamp(0.9 + (fine[i] - 0.5) * 0.14 - rim * 0.1 + decay * 0.05, 0.6, 0.99);
      const ao = 1 - (1 - scar) * 0.4 - decay * 0.1;
      f.surf(i, h, ao, rough);
    }

    const m = this.maps(f, { normalStrength: 1.15 });
    const mat = this.std(m, { envMapIntensity: 0.7 });
    injectBreakup(mat, {
      macroTex,
      period: 3.7,
      strength: 0.5,
      macroWarm: 0xffeed0,
      macroCool: 0xdae0dc,
      macroTint: 0.30,
      macroRough: 0.22,
      // fibre runs UP the trunk, which is V on a cylinder wrap
      streak: [0.7, 0.06, 0.05, 0.10],
      // No palm has the same bark at its base as at its crown: the scars compress
      // and the trunk goes darker, greener and lichened for the first 2.5 m. The
      // per-instance UV phase below already breaks the *pattern* repeat, but a
      // pattern repeating at identical brightness twelve times up a trunk still
      // reads as a clone — a low-frequency gradient along the trunk is what stops
      // the eye counting the courses, and it is baked from the instance base so
      // every trunk is shaded from its own foot.
      heightTint: [2.5, 0.5, 0.10],
      heightTintColor: 0x7d8a63,
      instUv: 0.95,
      instTint: 0.11,
    });
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, macroTex] };
  }

  /**
   * Alpha-tested foliage card. `frond` swaps the bushy leaf cluster for a long
   * pinnate palm leaf. Both get wrap lighting so the low sun blows through them.
   */
  private buildLeafCard(size: number, frond: boolean): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.clearRect(0, 0, size, size);
    const rnd = mulberry32(frond ? 313 : 271);

    const drawLeaf = (
      cx: number,
      cy: number,
      len: number,
      wid: number,
      ang: number,
      fill: string,
      vein: string,
    ) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(wid, len * 0.45, 0, len);
      g.quadraticCurveTo(-wid, len * 0.45, 0, 0);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = vein;
      g.lineWidth = Math.max(1, size / 340);
      g.beginPath();
      g.moveTo(0, len * 0.02);
      g.lineTo(0, len * 0.97);
      g.stroke();
      for (let k = 1; k < 7; k++) {
        const t = k / 7;
        const w = wid * 0.85 * Math.sin(t * Math.PI);
        g.beginPath();
        g.moveTo(0, len * t);
        g.lineTo(w, len * (t + 0.11));
        g.moveTo(0, len * t);
        g.lineTo(-w, len * (t + 0.11));
        g.stroke();
      }
      g.restore();
    };

    if (frond) {
      // one long pinnate frond filling the card, leaflets down a curved rachis
      const baseX = size * 0.5;
      g.save();
      g.strokeStyle = '#6d7f3a';
      g.lineWidth = size / 90;
      g.beginPath();
      g.moveTo(baseX, size * 0.99);
      g.quadraticCurveTo(baseX + size * 0.12, size * 0.45, baseX + size * 0.06, size * 0.03);
      g.stroke();
      g.restore();
      for (let k = 0; k < 34; k++) {
        const t = 0.04 + (k / 34) * 0.92;
        const x = baseX + size * 0.12 * (t * t) * 1.1;
        const y = size * (1 - t);
        const len = size * 0.34 * Math.sin(t * Math.PI) ** 0.6;
        const shade = 0.72 + rnd() * 0.35;
        const col = `rgb(${(96 * shade) | 0},${(148 * shade) | 0},${(58 * shade) | 0})`;
        drawLeaf(x, y, len, len * 0.1, Math.PI * 0.5 + 0.55 + rnd() * 0.12, col, 'rgba(40,70,26,0.5)');
        drawLeaf(x, y, len, len * 0.1, Math.PI * 0.5 - 0.55 - rnd() * 0.12 + Math.PI, col, 'rgba(40,70,26,0.5)');
      }
    } else {
      // a bushy cluster that reads as a hedge/olive canopy at any distance
      for (let k = 0; k < 130; k++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.pow(rnd(), 0.62) * size * 0.44;
        const x = size * 0.5 + Math.cos(a) * r;
        const y = size * 0.52 + Math.sin(a) * r * 0.92;
        const len = size * (0.14 + rnd() * 0.15);
        const shade = 0.6 + rnd() * 0.55 + (1 - r / (size * 0.5)) * 0.12;
        const warm = rnd() > 0.82;
        const col = warm
          ? `rgb(${(150 * shade) | 0},${(160 * shade) | 0},${(66 * shade) | 0})`
          : `rgb(${(88 * shade) | 0},${(140 * shade) | 0},${(56 * shade) | 0})`;
        drawLeaf(x, y, len, len * 0.3, rnd() * Math.PI * 2, col, 'rgba(38,66,26,0.45)');
      }
    }

    const f = new Fields(size);
    const px = readPixels(c);
    f.albedo.set(px);
    const alpha = alphaFrom(px);
    // a blurred alpha makes a believable rounded leaf body for the normal map
    const puff = blurField(alpha, size, Math.max(2, size >> 7));
    const micro = fbmField(size, { freq: Math.round(size / 12), octaves: 3, seed: 251 });
    const dry = fbmField(size, { freq: 5, octaves: 3, seed: 252, warp: 0.06 });

    for (let i = 0; i < size * size; i++) {
      const k = i * 4;
      const a = alpha[i];
      const tone = 0.9 + micro[i] * 0.2 + dry[i] * 0.1;
      f.albedo[k] = f.albedo[k] * tone;
      f.albedo[k + 1] = f.albedo[k + 1] * tone;
      f.albedo[k + 2] = f.albedo[k + 2] * tone * (1 - dry[i] * 0.1);
      const rough = clamp(0.66 + (micro[i] - 0.5) * 0.2 + dry[i] * 0.1, 0.4, 0.95);
      f.surf(i, puff[i] * 0.7 + micro[i] * 0.08 * a, 1 - (1 - puff[i]) * 0.25, rough);
    }

    const m = this.maps(f, { normalStrength: 1.0, wrap: THREE.ClampToEdgeWrapping });
    const mat = this.std(m, {
      transparent: false,
      // 0.42 cuts inside the antialiased shoulder the canvas rasteriser drew, so
      // roughly half the edge gradient is thrown away before the GPU ever sees
      // it — a hard binary silhouette on a curve is the jaggies. 0.34 keeps the
      // shoulder, and at 1024² the shoulder is now wide enough to be worth
      // keeping. (Not alpha-to-coverage: that needs MSAA, and MSAA only exists
      // on this project when the composer is running.)
      alphaTest: frond ? 0.34 : 0.42,
      side: THREE.DoubleSide,
      envMapIntensity: 0.6,
      // leaf cards are thin: shadow acne here would look like dirt on the leaf
      shadowSide: THREE.DoubleSide,
    });
    // #b8d97a in linear — the colour a golden-hour sun is after it has been
    // through one leaf. The bible calls backlit palms a hero moment; a frond
    // between the camera and the sun now goes to it.
    //
    // Pushed harder on the frond, and the reason is hue rather than brightness:
    // at 1.35 a backlit blade separated from a front-lit one only in value, and
    // the eye reads a value-only difference on a green card as shading, not as
    // translucency. It has to go *yellow*.
    injectFoliageSSS(mat, new THREE.Color(0xc2dd6a).convertSRGBToLinear(), frond ? 1.85 : 1.1);
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** 4×2 atlas of stylised spectators for instanced grandstand billboards. */
  private buildCrowd(size: number): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.clearRect(0, 0, size, size);
    const cols = this.crowdAtlas.cols;
    const rows = this.crowdAtlas.rows;
    const cw = size / cols;
    const ch = size / rows;
    const rnd = mulberry32(4711);

    const shirts = [0xe0453f, 0x4fc3ff, 0xf5e2b0, 0x6f9b47, 0xdcb8d8, 0xff9d2e, 0xf2ece0, 0xa9c8d4];
    const skins = [0xf0c9a2, 0xd6a074, 0xa9744c, 0x7a4f30, 0xf7dcc0];

    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col;
        const ox = col * cw;
        const oy = r * ch;
        const shirt = shirts[i % shirts.length];
        const skin = skins[(i * 3 + 1) % skins.length];
        const arms = i % 3 === 0; // a third of the crowd has their arms up
        const hex = (v: number) => `#${v.toString(16).padStart(6, '0')}`;

        const bx = ox + cw * 0.5;
        const bw = cw * 0.34;
        const headR = cw * 0.115;
        const shoulderY = oy + ch * 0.42;

        g.save();
        // hard clip: a waving flag must not spill into the neighbouring cell
        g.beginPath();
        g.rect(ox, oy, cw, ch);
        g.clip();
        // torso
        g.fillStyle = hex(shirt);
        g.beginPath();
        g.moveTo(bx - bw * 0.5, oy + ch * 0.98);
        g.lineTo(bx - bw * 0.56, shoulderY + ch * 0.04);
        g.quadraticCurveTo(bx, shoulderY - ch * 0.06, bx + bw * 0.56, shoulderY + ch * 0.04);
        g.lineTo(bx + bw * 0.5, oy + ch * 0.98);
        g.closePath();
        g.fill();
        // arms
        g.strokeStyle = hex(skin);
        g.lineCap = 'round';
        g.lineWidth = cw * 0.085;
        g.beginPath();
        if (arms) {
          g.moveTo(bx - bw * 0.5, shoulderY + ch * 0.06);
          g.lineTo(bx - bw * 0.85, oy + ch * 0.16);
          g.moveTo(bx + bw * 0.5, shoulderY + ch * 0.06);
          g.lineTo(bx + bw * 0.85, oy + ch * 0.16);
        } else {
          g.moveTo(bx - bw * 0.52, shoulderY + ch * 0.08);
          g.lineTo(bx - bw * 0.72, oy + ch * 0.8);
          g.moveTo(bx + bw * 0.52, shoulderY + ch * 0.08);
          g.lineTo(bx + bw * 0.72, oy + ch * 0.8);
        }
        g.stroke();
        // head + hair/cap
        g.fillStyle = hex(skin);
        g.beginPath();
        g.arc(bx, shoulderY - headR * 1.05, headR, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = i % 2 ? hex(shirts[(i + 3) % shirts.length]) : '#3a2f28';
        g.beginPath();
        g.arc(bx, shoulderY - headR * 1.2, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95);
        g.fill();
        // a few waving flags for silhouette interest
        if (i % 4 === 1) {
          g.fillStyle = hex(shirts[(i + 5) % shirts.length]);
          g.beginPath();
          g.moveTo(bx + bw * 0.85, oy + ch * 0.16);
          g.lineTo(bx + bw * 1.5, oy + ch * 0.06);
          g.lineTo(bx + bw * 1.45, oy + ch * 0.3);
          g.closePath();
          g.fill();
        }
        g.restore();
        rnd();
      }
    }

    const f = new Fields(size);
    const px = readPixels(c);
    f.albedo.set(px);
    const alpha = alphaFrom(px);
    const puff = blurField(alpha, size, Math.max(2, size >> 6));
    const cloth = fbmField(size, { freq: Math.round(size / 14), octaves: 3, seed: 261 });

    for (let i = 0; i < size * size; i++) {
      const k = i * 4;
      const tone = 0.9 + cloth[i] * 0.2;
      f.albedo[k] *= tone;
      f.albedo[k + 1] *= tone;
      f.albedo[k + 2] *= tone;
      f.surf(i, puff[i] * 0.8, 1 - (1 - puff[i]) * 0.3, clamp(0.82 + (cloth[i] - 0.5) * 0.16, 0.6, 0.96));
    }

    const m = this.maps(f, { normalStrength: 0.8, wrap: THREE.ClampToEdgeWrapping });
    const mat = this.std(m, {
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      envMapIntensity: 0.55,
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Start/finish arch and sponsor banners: printed cloth with a real weave. */
  private buildBanner(size: number): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.fillStyle = '#f2ece0';
    g.fillRect(0, 0, size, size);

    // horizontal colour bands
    const bands = ['#e0453f', '#f5e2b0', '#4fc3ff', '#f2ece0'];
    for (let i = 0; i < 4; i++) {
      g.fillStyle = bands[i];
      g.fillRect(0, (size * i) / 4, size, size / 4);
    }
    // chevron ribbon through the middle
    // chevron ribbons sit above and below the wordmark, never across it
    g.save();
    g.fillStyle = '#1d2a33';
    for (const [top, bot] of [[0.30, 0.355], [0.645, 0.70]] as const) {
      g.beginPath();
      for (let k = 0; k <= 10; k++) g.lineTo((size * k) / 10, size * (k % 2 ? top : top + 0.028));
      for (let k = 10; k >= 0; k--) g.lineTo((size * k) / 10, size * (k % 2 ? bot : bot + 0.028));
      g.closePath();
      g.fill();
    }
    g.restore();
    // printed wordmark — a system font stack, no webfont to load
    g.save();
    g.fillStyle = '#1d2a33';
    g.font = `800 ${Math.round(size * 0.105)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.translate(size * 0.5, size * 0.5);
    g.fillText('樱花町', 0, 0);
    g.restore();
    g.save();
    g.fillStyle = '#1d2a33';
    g.font = `700 ${Math.round(size * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('大奖赛', size * 0.5, size * 0.155);
    g.fillText('一号赛道', size * 0.5, size * 0.845);
    g.restore();

    const f = new Fields(size);
    f.albedo.set(readPixels(c));
    const fold = fbmField(size, { freq: 5, octaves: 3, seed: 271, stretchY: 0.25 });
    const fade = fbmField(size, { freq: 3, octaves: 3, seed: 272, warp: 0.05 });
    const threads = 110;

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const tu = u * threads;
        const tv = v * threads;
        const over = (Math.floor(tu) + Math.floor(tv)) % 2 === 0;
        const thread = over ? 1 - Math.abs((tu % 1) - 0.5) * 2 : 1 - Math.abs((tv % 1) - 0.5) * 2;
        const shade = (0.86 + thread * 0.18) * (0.92 + fold[i] * 0.16) * (0.94 + fade[i] * 0.1);
        const k = i * 4;
        f.albedo[k] *= shade;
        f.albedo[k + 1] *= shade;
        f.albedo[k + 2] *= shade;
        f.albedo[k + 3] = 255;
        const rough = clamp(0.86 - thread * 0.08 + (fade[i] - 0.5) * 0.12, 0.6, 0.98);
        f.surf(i, thread * 0.35 + fold[i] * 0.4, 1 - (1 - thread) * 0.22, rough);
      }
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { side: THREE.DoubleSide, envMapIntensity: 0.65 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  // -- small helpers -------------------------------------------------------

  private bytesCanvas(size: number, bytes: Uint8ClampedArray): HTMLCanvasElement {
    const c: Canvas2D = createCanvas(size);
    c.ctx.putImageData(toImageData(bytes, size), 0, 0);
    return c.canvas as HTMLCanvasElement;
  }
}

/**
 * The shared instance. `main.ts` constructs `Materials` itself and the context
 * has no slot for it, so this is how the other visual systems reach the same
 * cache instead of each building their own copy of every texture.
 */
export function getMaterials(): Materials {
  return active ?? new Materials();
}
