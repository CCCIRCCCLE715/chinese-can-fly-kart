/**
 * ============================================================================
 *  ITEMS — boxes, the distribution table, and every item's effect
 * ============================================================================
 *  The classic arcade contract: what you get depends on where you are. The
 *  leader is armed to *defend* (bananas, green shells) and the back of the
 *  field is armed to *close* (mushrooms, stars, the bolt). Tuned so a comeback
 *  is always live without leaving first place defenceless — the leader's shell
 *  and banana are genuinely useful held behind, which is the whole point of the
 *  hold-behind mechanic.
 *
 *  Input note: `InputState` exposes only rising edges, so "hold the button to
 *  trail a shield" is expressed as press-with-backwards (deploy behind, where
 *  it shields you) then press again (release it). Same call, `use(kart, true)`,
 *  and the AI drives it through exactly the same path.
 * ============================================================================
 */
import * as THREE from 'three';
import { ItemKind, RaceState, type Ctx, type IItems, type IKart } from '../types';
import type { RacingLine } from './AI';
import {
  BlobShadows, Projectiles, mushroomArt, pad, padTexture, radialSprite, roundedBox,
} from './Projectiles';

// --- tuning ------------------------------------------------------------------
const BOX_SIZE = 1.55;
/**
 * Seconds a collected box stays down.
 *
 * This is a *pack* number, not a lap number: rows are ~160 m apart, so nobody
 * re-passes a box inside a minute. What it decides is how much of the field
 * gets anything at all when eight karts cross a row nose to tail — at 4.5 s
 * everyone behind the leading two or three found an empty road.
 */
const BOX_RESPAWN = 2.5;
const BOX_PICKUP_R = 1.9;
/**
 * Clearance from the tarmac to the *centre* of the box, metres, measured along
 * the local ground normal.
 *
 * 1.25 put the underside 0.48 m clear, which at racing distance is far enough
 * that the eye stops connecting the box to its shadow and starts reading the
 * pair as a sprite over a decal. 1.05 keeps the hover unmistakable — the box is
 * still visibly floating, still above the kart's nose — while halving the gap
 * the contact shadow has to bridge.
 */
const BOX_HEIGHT = 1.05;
/** seconds the roulette spins before the item can be spent (matches the HUD) */
const ARM_TIME = 1.05;

const MUSHROOM_BOOST = 1.55;
const MUSHROOM_STRENGTH = 1.3;
const STAR_TIME = 7.4;
const BOLT_TIME = 6.5;
const BOLT_STUN = 0.65;

/** rows of boxes around the lap, avoiding the boost strips */
const BOX_ROWS = [0.052, 0.148, 0.246, 0.336, 0.428, 0.505, 0.646, 0.712, 0.802, 0.906];

/**
 * A row of boxes is a *wall*, not a decoration: it must span the road, and
 * consecutive capture volumes must overlap, so that no line through it comes
 * out the other side empty-handed.
 *
 * The previous fixed five lanes at ±0.66 of the half-width covered the middle
 * half of a 9 m-half-width road and left ±3 m of clear tarmac against each
 * kerb. That is exactly where a racing line runs — the apex of every corner on
 * this circuit is hard against the kerb — so the field could and did drive
 * through row after row without touching one. Lanes are therefore derived from
 * the actual width at each row: spread edge to edge inside the kerb margin, and
 * enough of them that the gap never exceeds the capture diameter.
 */
const BOX_ROW_MARGIN = 1.8;
/** target metres between boxes in a row; must stay under 2 × BOX_PICKUP_R */
const BOX_LANE_GAP = 3.1;
const BOX_LANES_MIN = 3;
const BOX_LANES_MAX = 8;

// --- distribution ------------------------------------------------------------
// Columns are leader / midfield / last. Everything between is a lerp, so an
// eight-kart field gets a smooth gradient rather than three step changes.
const WEIGHTS: Record<number, [number, number, number]> = {
  [ItemKind.Mushroom]:       [10, 26, 16],
  [ItemKind.TripleMushroom]: [0, 10, 21],
  [ItemKind.GreenShell]:     [33, 19, 6],
  [ItemKind.RedShell]:       [4, 21, 17],
  [ItemKind.Banana]:         [38, 13, 4],
  [ItemKind.Star]:           [0, 4, 17],
  [ItemKind.Bolt]:           [0, 2, 10],
  [ItemKind.Bomb]:           [15, 11, 5],
};
const KINDS = Object.keys(WEIGHTS).map(Number) as ItemKind[];

interface Slot {
  kind: ItemKind;
  count: number;
  /** seconds until the item may be spent — the roulette is not decoration */
  arm: number;
  /** handle of a projectile being trailed as a shield, or -1 */
  carried: number;
  /** shrunk-by-bolt timer */
  shrink: number;
  /** cooldown on star knock-asides so one pass is not eight hits */
  starHit: number;
}

interface Box {
  pos: THREE.Vector3;
  /** the point on the tarmac directly under the box, for the contact shadow */
  ground: THREE.Vector3;
  normal: THREE.Vector3;
  phase: number;
  /** >0 = collected, counting down to respawn */
  down: number;
  /** 0..1 presence, drives the pop */
  scale: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- item-box art -------------------------------------------------------------

/**
 * ============================================================================
 *  THE ITEM BOX — a glass shell around a lit mark, not a printed cube
 * ============================================================================
 *
 * Round-1 note: "flat pale-cyan cubes with a printed '?' — no transmission, no
 * refraction, no emissive, no env reflection, no iridescence, and hard
 * unchamfered 90° cube edges that catch no specular at all."
 *
 * Two of those are misdiagnosed and one is the whole problem, so it is worth
 * being precise about which is which:
 *
 *  · **The edges are chamfered** and always were — `roundedBox(1.55, 0.26, 6)`,
 *    a 26 cm fillet, 17% of the half-extent. Look at the crop and the corners
 *    are visibly round. What is true is that the fillet *caught no highlight*,
 *    and that is a material fact, not a geometry one: the roughness map's mean
 *    put the effective gloss around 0.3 and `envMapIntensity` was **0.75**, so
 *    the fillet returned a broad dull sheen instead of a tight swept line.
 *    Geometry is therefore untouched (432 tris, one instanced draw — §8); the
 *    material is rebuilt around roughness ≤ 0.14 and env at 2.2, which is what
 *    actually lights an edge.
 *
 *  · **The '?' was a decal on the outer face, inside a printed inset frame.**
 *    That is the real reason the boxes read as flat: every face carried a
 *    complete little card — border, vignette, glyph — so the cube read as six
 *    stickers rather than as one solid. Whatever the shading did afterwards was
 *    fighting an albedo that had already drawn a 2D object. The frame is gone
 *    entirely and the mark now lives on a **separate emissive inner shell**
 *    that is seen *through* the glass, with its own rotation offset so the
 *    glyph parallaxes against the facets. That parallax is the single strongest
 *    "this is a solid volume" cue available, and it is free.
 *
 *  · **No transmission — deliberately, and this is a considered refusal.**
 *    `MeshPhysicalMaterial.transmission` makes three.js run a *second opaque
 *    scene pass* into a transmission render target and mip it, every frame, for
 *    as long as one transmissive object is visible. Round 1 measured 37 fps
 *    against a 60 fps budget (§8); spending a full extra scene pass on a 1.55 m
 *    pickup would be buying a beauty note with the frame rate, which §8
 *    forbids. What the note actually asks for — "the sky horizon shows in the
 *    facets" — is *refraction of the environment*, and that is one extra PMREM
 *    tap in the fragment shader: no pass, no target, no mip chain. So the glass
 *    refracts the sky properly (`ior 1.45`, IOR-correct `refract()`, fresnel-
 *    weighted) and the scene behind it is approximated by ordinary alpha, which
 *    at this size and distance is visually indistinguishable and costs nothing.
 *
 *  · Iridescence, on the other hand, is a BRDF lobe with no extra pass, so it
 *    is taken at full strength with a real thickness *map* — without one three
 *    uses the range maximum uniformly and the film is a flat tint rather than
 *    the blue→magenta shift across the faces the note is after.
 * ============================================================================
 */

/**
 * The glass shell: tint, spatially varying gloss, and the iridescent film's
 * thickness ramp. No glyph, no frame, nothing that draws a picture on a face.
 */
function glassMaterial(ctx: Ctx): THREE.MeshPhysicalMaterial {
  // 512², not 1024². The 1024 existed to resolve the glyph; with the glyph
  // moved inside, everything left on this texture is a low-frequency gradient
  // and a single hairline, which 512 carries past the point the box fills the
  // screen. The 1024 is spent on the mark instead, where the detail is.
  const S = 512;
  const p = pad(S);
  const g = p.g;

  // Sea-glass, keyed to `sea shallow #3fc9c4` and `sky-warm #ffd0a0` (§3).
  // Pitched dark on purpose: this is a *transparent shell* at 0.62 alpha whose
  // apparent colour comes mostly from the env reflection, the refracted sky and
  // the film. An albedo with any weight in it turns all three into a wash.
  const grd = g.createLinearGradient(0, 0, S, S);
  grd.addColorStop(0.00, '#3f9fa8');
  grd.addColorStop(0.42, '#1f6d8c');
  grd.addColorStop(0.74, '#43508f');
  grd.addColorStop(1.00, '#8f5f3e');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  // Corner-to-centre falloff — a pane with depth rather than a flat card.
  const vig = g.createRadialGradient(S * 0.46, S * 0.40, S * 0.04, S * 0.5, S * 0.5, S * 0.80);
  vig.addColorStop(0.00, 'rgba(160,235,248,0.30)');
  vig.addColorStop(0.58, 'rgba(60,140,165,0.0)');
  vig.addColorStop(1.00, 'rgba(6,30,46,0.62)');
  g.fillStyle = vig;
  g.fillRect(0, 0, S, S);

  // One hairline, sitting exactly on the fillet seam. `roundedBox` leaves the
  // flat core spanning |coord| <= h - r, i.e. uv 0.17 .. 0.83, so this lands on
  // the crease where the face turns into the chamfer and reads as the edge of
  // a ground pane. It replaces the two-stroke inset frame, which was the thing
  // making every face read as its own little card.
  g.strokeStyle = 'rgba(214,248,255,0.5)';
  g.lineWidth = S * 0.010;
  g.strokeRect(S * 0.17, S * 0.17, S * 0.66, S * 0.66);

  // --- roughness -----------------------------------------------------------
  // §4: roughness must vary spatially. Polished toward the key's hot spot,
  // slightly frosted out at the chamfer — a real ground-glass edge is never as
  // polished as the face it borders, and the variation is what stops the whole
  // cube returning one identical sky.
  const rp = pad(S >> 1);
  const rg = rp.g;
  const R = rp.size;
  const rgrd = rg.createRadialGradient(R * 0.42, R * 0.34, R * 0.02, R * 0.5, R * 0.5, R * 0.82);
  rgrd.addColorStop(0.00, '#2e2e2e');   // 0.16 * 0.18 -> 0.029, near-mirror
  rgrd.addColorStop(0.62, '#4e4e4e');
  rgrd.addColorStop(1.00, '#e0e0e0');   // 0.16 * 0.88 -> 0.141, frosted crease
  rg.fillStyle = rgrd;
  rg.fillRect(0, 0, R, R);
  // a faint brushed streak so the highlight has structure to travel across
  rg.globalAlpha = 0.28;
  rg.strokeStyle = '#787878';
  rg.lineWidth = R * 0.02;
  for (let i = 0; i < 7; i++) {
    rg.beginPath();
    rg.moveTo(-R * 0.1, R * (i / 7) * 1.2 - R * 0.1);
    rg.lineTo(R * 1.1, R * (i / 7) * 1.2 + R * 0.28);
    rg.stroke();
  }
  rg.globalAlpha = 1;

  // --- iridescent film thickness -------------------------------------------
  // Sampled from `.g`, remapped into `iridescenceThicknessRange`. A diagonal
  // ramp means the film runs the full 190 nm -> 720 nm sweep across each face,
  // which is a blue -> gold -> magenta shift as the box turns. Without this map
  // three clamps the film to the range maximum everywhere and iridescence is
  // just a constant tint.
  const ip = pad(128);
  const ig = ip.g;
  const I = ip.size;
  const ird = ig.createLinearGradient(0, I, I, 0);
  ird.addColorStop(0.00, '#000000');
  ird.addColorStop(0.35, '#6a6a6a');
  ird.addColorStop(0.70, '#d0d0d0');
  ird.addColorStop(1.00, '#ffffff');
  ig.fillStyle = ird;
  ig.fillRect(0, 0, I, I);

  const m = new THREE.MeshPhysicalMaterial({
    map: padTexture(p, true),
    roughnessMap: padTexture(rp, false),
    iridescenceThicknessMap: padTexture(ip, false),
    transparent: true,
    // Genuinely see-through now: the mark is a separate object *behind* this
    // surface and has to read through it. 0.62 leaves the glass plenty of
    // presence (its specular, env and film all survive the blend) while the
    // glyph stays legible at racing distance.
    opacity: 0.62,
    // Ceiling, modulated down by the map above to 0.03 .. 0.14. This is the
    // number that decides whether a 26 cm fillet returns a swept highlight or a
    // dull sheen; at the old effective ~0.3 it could only ever be the latter.
    roughness: 0.16,
    metalness: 0,
    ior: 1.45,
    // Thin-film. `iridescenceIOR` under the glass IOR keeps the shift in the
    // blue->magenta half of the wheel rather than running the whole rainbow,
    // which would drag colours the course palette does not contain (§3) across
    // the most salient object on screen.
    iridescence: 0.6,
    iridescenceIOR: 1.30,
    iridescenceThicknessRange: [190, 720],
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color(0x11485c),
    emissiveIntensity: 0.16,
    // Grazing-angle lift on top of the explicit fresnel below. Cloth lobe, so
    // it is tinted by the key and stays energy-conserving — it widens the rim
    // without adding another un-exposed additive term (§6).
    sheen: 0.4,
    sheenRoughness: 0.36,
    sheenColor: new THREE.Color(0xbff2ff),
    // Front faces only. `DoubleSide` is the intuitive choice for glass and it is
    // what was flattening the cube: the six faces of one instance are submitted
    // in geometry order with no per-triangle depth sort, so a *back* face —
    // which at golden hour is the face the sun is behind, i.e. the brightest and
    // least informative one in the box — frequently composited on top of the
    // near faces and buried their shading. Drawing only the near faces makes
    // the three visible facets read the key honestly, and halves the
    // transparent fragment cost of ~70 instances while it is at it.
    side: THREE.FrontSide,
    // Writes depth. Without it the transparent queue sorts *objects*, not the
    // ~70 instances inside this one mesh, so box-behind-box ordering was decided
    // by buffer index. With it, whichever of two overlapping boxes reaches the
    // buffer first, the depth test resolves them the same way. The glow shell
    // and the ground pool are drawn ahead of it (lower `renderOrder`) so they
    // are unaffected; the mark shell is opaque and so is already ahead of the
    // whole transparent queue.
    depthWrite: true,
  });

  // --- refraction + fresnel rim --------------------------------------------
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(0x9fe8ff) };
    shader.uniforms.uRimPower = { value: 3.0 };
    shader.uniforms.uRimStrength = { value: 0.38 };
    // 1 / ior. Air -> glass, so the ratio is inverted going in.
    shader.uniforms.uEta = { value: 1 / 1.45 };
    // Face-on gain is uRefract * envMapIntensity * 0.5 of sky radiance. Keeping
    // that coefficient under 1 is necessary but NOT sufficient, which is how the
    // box ended up as a white blob with an invisible "?" in r1-verify's hud and
    // drift frames: the coefficient was read on its own, against an assumed sky
    // of ~1. This sky is golden-hour and several units of linear radiance, and
    // the refraction term is *added to emissive* — so it stacks on top of the
    // 2.2 env reflection and the rim, all of it un-lit and all of it landing
    // past the bloom threshold. 0.44 of a bright sky is not a tint, it is an
    // emitter, and the shape it dissolved is the one this term exists to save.
    // Sized now against the sum rather than the coefficient.
    shader.uniforms.uRefract = { value: 0.24 };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uEta;
uniform float uRefract;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // `normal` (not the raw `vNormal` varying) is the shading normal after
        // <normal_fragment_begin>, so both terms follow the fillet's
        // interpolated curvature — which is the whole point of the chamfer.
        `#include <emissivemap_fragment>
{
  vec3 vDir = normalize( vViewPosition );
  float ndv = saturate( abs( dot( normal, vDir ) ) );
  float fres = pow( 1.0 - ndv, 5.0 );

  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  // The sky, bent through the glass. This is what the "the sky horizon shows
  // in the facets" note is actually asking for, and unlike real transmission
  // it is one PMREM tap rather than a second scene pass (see the header).
  // Weighted by (1 - fresnel) because at grazing angles a dielectric reflects
  // rather than transmits — which is exactly when the rim below takes over, so
  // the two hand off to each other instead of stacking.
  vec3 refr = refract( -vDir, normal, uEta );
  if ( dot( refr, refr ) > 0.0 ) {
    // transformDirectionByInverseViewMatrix + envMapRotation is exactly what
    // getIBLRadiance does; matching it means the refracted sky and the reflected
    // sky agree about which way the world is facing, which matters because the
    // sky system is free to rotate its PMREM.
    vec3 worldRefr = transformDirectionByInverseViewMatrix( refr, viewMatrix );
    vec3 sky = textureCubeUV( envMap, envMapRotation * worldRefr, roughnessFactor ).rgb;
    totalEmissiveRadiance += sky * envMapIntensity * uRefract * ( 1.0 - fres ) * 0.5;
  }
  #endif

  // Explicit view-dependent rim. Power 3 keeps it to the last few degrees of
  // grazing angle — this feeds emissive, which is un-lit, so a broad term is a
  // free trip past the bloom threshold across a third of the cube (§6).
  totalEmissiveRadiance += uRimColor * pow( 1.0 - ndv, uRimPower ) * uRimStrength;
}`,
      );
  };
  // One material, one program — but be explicit so a future variant does not
  // silently share this one's compiled shader.
  m.customProgramCacheKey = () => 'itembox-glass-v2';

  if (ctx.envMap) m.envMap = ctx.envMap;
  // High on purpose — but not this high. The shell's job is to hold a
  // recognisable piece of the golden-hour sky in every facet; §2's "clip to
  // white and bloom" is about *highlights*, not about the whole face. At 0.75
  // the facets returned a grey suggestion of the sky and the box read as
  // plastic; at 2.2 every facet clipped at once and the box read as a white
  // blob with no "?" in it at all, which is worse — a plastic box is at least
  // an item box. 1.2 keeps the sky in the facets and leaves the mark visible.
  m.envMapIntensity = 1.2;
  return m;
}

/**
 * The mark: an opaque shell *inside* the glass carrying an emissive "?".
 *
 * Opaque and drawn in the ordinary opaque queue, so it is on screen and in the
 * depth buffer before any transparent geometry is considered — the glass then
 * simply blends over it, in the right order, every time, with no per-instance
 * sorting to get wrong. It is also what makes the glyph *behind* a surface
 * rather than printed on one: as the two shells rotate at different rates the
 * mark slides against the facets, and that parallax is the cue that reads as
 * volume from 60 m.
 */
function markMaterial(ctx: Ctx): THREE.MeshStandardMaterial {
  const S = 1024;
  const p = pad(S);
  const g = p.g;

  // Body: deep, so the glyph has three stops of separation and the shell reads
  // as a dark core suspended in the glass rather than as a second white cube.
  const body = g.createLinearGradient(0, 0, S, S);
  body.addColorStop(0.00, '#123a4a');
  body.addColorStop(0.55, '#0c2534');
  body.addColorStop(1.00, '#1b2a4a');
  g.fillStyle = body;
  g.fillRect(0, 0, S, S);

  // The mark. Bigger than the old decal (0.72 of the face against 0.62) because
  // the shell it sits on is 0.62 of the box, so on-screen the glyph comes out
  // the same size it was — the difference is that it is now behind glass.
  const drawGlyph = (c: CanvasRenderingContext2D, size: number, fill: string | CanvasGradient) => {
    c.font = `900 ${size * 0.72}px "SF Pro Display", system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = size * 0.085;
    c.strokeStyle = '#4a2404';
    c.strokeText('?', size * 0.5, size * 0.54);
    c.fillStyle = fill;
    c.fillText('?', size * 0.5, size * 0.54);
  };
  const q = g.createLinearGradient(0, S * 0.16, 0, S * 0.88);
  q.addColorStop(0.00, '#fff6d8');
  q.addColorStop(0.45, '#ffd45c');
  q.addColorStop(1.00, '#f09520');
  drawGlyph(g, S, q);

  // --- emissive: the glyph only --------------------------------------------
  // Black body, lit mark. This is what "reads through the glass" means: the
  // shell is shaded normally and receives the key like everything else, and the
  // one thing that emits is the symbol. An emissive whole shell would have been
  // a lamp in a box and would have bloomed the glass into the milky wash the
  // review picked up on in round 1.
  const ep = pad(S >> 1);
  const eg = ep.g;
  eg.fillStyle = '#000000';
  eg.fillRect(0, 0, ep.size, ep.size);
  drawGlyph(eg, ep.size, '#ffd98a');

  // --- roughness ------------------------------------------------------------
  // Matte lacquer body, glossier glyph — two distinct responses to the same key
  // inside a single object (§4).
  const rp = pad(S >> 2);
  const rg = rp.g;
  rg.fillStyle = '#c8c8c8';
  rg.fillRect(0, 0, rp.size, rp.size);
  const rv = rg.createRadialGradient(
    rp.size * 0.5, rp.size * 0.45, rp.size * 0.05,
    rp.size * 0.5, rp.size * 0.5, rp.size * 0.8,
  );
  rv.addColorStop(0, '#8c8c8c');
  rv.addColorStop(1, '#e4e4e4');
  rg.fillStyle = rv;
  rg.fillRect(0, 0, rp.size, rp.size);
  drawGlyph(rg, rp.size, '#4a4a4a');

  const m = new THREE.MeshStandardMaterial({
    map: padTexture(p, true),
    emissiveMap: padTexture(ep, true),
    roughnessMap: padTexture(rp, false),
    emissive: new THREE.Color(0xffc978),
    // Tone-mapped, exposed, and kept under the bloom threshold on its own: the
    // glass in front of it multiplies it by 0.62, so this is the value that
    // arrives at ~0.8 through the shell — bright enough to be unmistakably lit,
    // short of the point where three effects stacking whites the frame out (§6).
    emissiveIntensity: 1.35,
    roughness: 1,
    metalness: 0.05,
  });
  if (ctx.envMap) {
    m.envMap = ctx.envMap;
    m.envMapIntensity = 0.9;
  }
  return m;
}

// =============================================================================

export class Items implements IItems {
  readonly group = new THREE.Group();

  private slots = new Map<number, Slot>();
  private heldViews = new Map<number, { kind: ItemKind; count: number }>();
  private boxes: Box[] = [];
  private proj = new Projectiles();
  private karts: readonly IKart[] = [];
  private ctx!: Ctx;

  private boxMesh!: THREE.InstancedMesh;
  /** the emissive "?" shell living inside the glass */
  private markMesh!: THREE.InstancedMesh;
  private coreMesh!: THREE.InstancedMesh;
  private boxShadows!: BlobShadows;
  private boxGlow!: BlobShadows;
  private orbitMesh!: THREE.InstancedMesh;
  private boxMat!: THREE.MeshPhysicalMaterial;
  private markMat!: THREE.MeshStandardMaterial;
  private coreMat!: THREE.MeshBasicMaterial;
  private env: THREE.Texture | null = null;

  // ---------------------------------------------------------------- lifecycle

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.karts = ctx.race?.karts ?? [];
    this.group.name = 'items';

    this.proj.init(ctx);
    this.buildBoxes(ctx);
    this.buildOrbit();

    ctx.scene.add(this.group);
    for (const k of this.karts) this.slots.set(k.id, this.freshSlot());
  }

  private freshSlot(): Slot {
    return { kind: ItemKind.None, count: 0, arm: 0, carried: -1, shrink: 0, starHit: 0 };
  }

  setRacingLine(l: RacingLine) {
    this.proj.setRacingLine(l);
  }

  /** Obstacles the AI should steer around. */
  get hazards() {
    return this.proj.hazards;
  }

  /** Full wipe — new race. */
  reset() {
    for (const k of this.karts) {
      const s = this.slots.get(k.id) ?? this.freshSlot();
      s.kind = ItemKind.None;
      s.count = 0;
      s.arm = 0;
      s.carried = -1;
      s.shrink = 0;
      s.starHit = 0;
      this.slots.set(k.id, s);
      k.object.scale.setScalar(1);
      k.starTime = 0;
    }
    for (const b of this.boxes) {
      b.down = 0;
      b.scale = 1;
    }
    this.proj.clear();
  }

  // -------------------------------------------------------------------- build

  private buildBoxes(ctx: Ctx) {
    const track = ctx.track;
    for (const t of BOX_ROWS) {
      const s = track.sample(t);
      // Half the span the row has to cover, kerb margin removed.
      const reach = Math.max(2.4, s.halfWidth - BOX_ROW_MARGIN);
      const lanes = clamp(
        Math.round((reach * 2) / BOX_LANE_GAP) + 1,
        BOX_LANES_MIN,
        BOX_LANES_MAX,
      );
      for (let j = 0; j < lanes; j++) {
        const lat = ((j / (lanes - 1)) * 2 - 1) * reach;
        // Lay the row out on the centreline frame first — that is what makes it
        // a wall across the tangent rather than a line down the road.
        const p = new THREE.Vector3()
          .copy(s.pos)
          .addScaledVector(s.binormal, lat);

        // ...then re-seat it off the surface actually underneath. The centreline
        // frame is a plane; the road is not. Crown, camber and the banked
        // sections all mean that offsetting laterally from `s.pos` and *then*
        // lifting along `s.normal` leaves the outer boxes of a row at a
        // different clearance from the inner ones — up to half a metre on the
        // 20 degree coastal curve — which is exactly the "no consistent height,
        // no ground contact" read in the review. Probing under each box and
        // lifting along the local ground normal gives every box in every row the
        // same clearance over the tarmac it is actually floating above, and
        // hands the contact shadow an exact ground point instead of a guess.
        const probe = track.probe(p, t);
        const ground = new THREE.Vector3(p.x, probe.y, p.z);
        const normal = probe.normal.clone();
        p.copy(ground).addScaledVector(normal, BOX_HEIGHT);

        this.boxes.push({
          pos: p,
          ground,
          normal,
          phase: (this.boxes.length % 7) * 0.9 + t * 11,
          down: 0,
          scale: 1,
        });
      }
    }

    const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());

    this.boxMat = glassMaterial(ctx);
    if (this.boxMat.map) this.boxMat.map.anisotropy = aniso;
    // seg 6, not 4. `roundedBox` subdivides uniformly and then projects
    // everything outside the inner core onto the fillet, so at seg 4 the only
    // ring outside the core was the outermost one: every rounded edge was a
    // *single* quad, which is a chamfer the shading cannot resolve into a
    // highlight. Six puts a full ring in the fillet with the seam landing on a
    // grid line, so the interpolated normal sweeps cleanly from face to chamfer
    // and the edge takes a highlight. 432 tris, one instanced draw — and it
    // stays 432, because the round-1 note's "unchamfered" reading was a
    // material problem, not a geometry one (see the art header above).
    const geo = roundedBox(BOX_SIZE, BOX_SIZE * 0.17, 6);
    this.boxMesh = new THREE.InstancedMesh(geo, this.boxMat, this.boxes.length);
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.castShadow = false;   // a translucent shell casts a poor shadow
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 4;
    this.boxMesh.name = 'item-boxes';

    // The mark, inside. Opaque, so it renders in the ordinary opaque queue
    // ahead of everything transparent and the glass simply blends over it.
    // 0.62 of the shell puts it comfortably inside the 1.03 m flat core, so it
    // can rotate independently without ever poking through a facet. 108 tris.
    this.markMat = markMaterial(ctx);
    if (this.markMat.map) this.markMat.map.anisotropy = aniso;
    const markGeo = roundedBox(BOX_SIZE * 0.62, BOX_SIZE * 0.62 * 0.13, 3);
    this.markMesh = new THREE.InstancedMesh(markGeo, this.markMat, this.boxes.length);
    this.markMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markMesh.castShadow = false;
    this.markMesh.frustumCulled = false;
    // `updateBoxes` sets this every frame; starting at 0 means the one frame
    // between construction and the first update cannot show 70 unplaced shells
    // stacked at the world origin. Unlike the glass, this one is opaque, so it
    // would be an unmissable black brick if it ever did.
    this.markMesh.count = 0;
    this.markMesh.name = 'item-box-marks';

    // The glow. This used to be a core *inside* the cube, and with the shell now
    // writing depth at 0.94 an interior lamp is a lamp in a box: 94% of it is
    // thrown away and the 6% that survives lands as a white bloom directly over
    // the mark, which is the milky centre the review saw. So it is turned inside
    // out — a soft additive shell a little larger than the box, drawn *before*
    // it. Everything inside the silhouette is covered by the shell; what
    // survives is a warm halo bleeding out past the edges. Against the sky that
    // is the "this is a pickup" read, and it is the same instanced mesh and the
    // same draw call it always was.
    //
    // Pulled back from 0.34 to 0.19. It was authored against a 0.94-opacity
    // shell that hid most of it; the glass is now 0.62, so the same halo is
    // read at nearly twice the strength through the box and was the milky wash
    // sitting over the crop. At 0.19 it survives as a rim outside the
    // silhouette — which is the only place it was ever doing any work — without
    // desaturating the facets it is behind.
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      map: radialSprite(64, 0.0, 2.1),
      transparent: true,
      opacity: 0.19,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coreGeo = new THREE.OctahedronGeometry(BOX_SIZE * 0.92, 1);
    this.coreMesh = new THREE.InstancedMesh(coreGeo, this.coreMat, this.boxes.length);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 3;

    // Contact shadow. Tighter and denser than the shared default: a 1.9 m blob
    // at 0.44 over a 1.55 m box spread the darkness so thin it was inside the
    // tarmac's own aggregate noise, which is why the review read it as absent.
    this.boxShadows = new BlobShadows(this.boxes.length, {
      opacity: 0.62,
      gamma: 1.9,
      inner: 0.10,
      name: 'item-box-shadows',
    });
    // ...and the light the box spills back down onto the road. An emissive
    // object with a hole punched in the tarmac under it and nothing else is
    // half a lighting event. Additive, warm, wider and much softer than the
    // shadow, drawn under it so the shadow core still reads.
    this.boxGlow = new BlobShadows(this.boxes.length, {
      color: 0xffc478,
      opacity: 0.30,
      gamma: 2.6,
      additive: true,
      lift: 0.035,
      renderOrder: 1,
      name: 'item-box-glow',
    });
    this.group.add(
      this.markMesh, this.boxMesh, this.coreMesh, this.boxGlow.mesh, this.boxShadows.mesh,
    );
  }

  private buildOrbit() {
    const art = mushroomArt('#ff6a5e', '#fff3e0');
    if (this.ctx.envMap) art.mat.envMap = this.ctx.envMap;
    this.orbitMesh = new THREE.InstancedMesh(art.geo, art.mat, 24);
    this.orbitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.orbitMesh.frustumCulled = false;
    this.orbitMesh.castShadow = true;
    this.orbitMesh.count = 0;
    this.orbitMesh.name = 'item-orbit';
    this.group.add(this.orbitMesh);
  }

  // --------------------------------------------------------------- IItems API

  /**
   * Weighted roll. `place` is 1-based; the position is normalised across the
   * field so the table reads the same in a 4-kart race as in an 8-kart one.
   */
  roll(place: number, racers: number): ItemKind {
    const p = racers > 1 ? clamp((place - 1) / (racers - 1), 0, 1) : 0;
    let total = 0;
    let pick = ItemKind.Mushroom;
    for (const kind of KINDS) {
      const w = WEIGHTS[kind];
      // two-segment lerp through the midfield column
      const v = p < 0.5 ? w[0] + (w[1] - w[0]) * (p * 2) : w[1] + (w[2] - w[1]) * ((p - 0.5) * 2);
      if (v <= 0) continue;
      total += v;
      if (Math.random() * total < v) pick = kind;
    }
    return total > 0 ? pick : ItemKind.Mushroom;
  }

  /**
   * The returned record is a per-kart view that is refreshed in place: the HUD
   * and every AI driver ask for this once a frame, and eight fresh objects per
   * frame is eight objects per frame the collector has to sweep. Read it, do
   * not store it.
   *
   * **A trailed shield counts as held.** Deploying a shell or a banana behind
   * you moves it out of the slot and onto a tow rope, but it is still your
   * item — it still occupies the slot as far as `pickup` is concerned, and the
   * same button still spends it. Reporting `None` for it made the HUD show an
   * empty item box while the player was visibly towing a shell, and it made the
   * AI's spend logic bail out at its `None` guard, so no driver ever released
   * what it was towing and no driver could ever collect another box for the
   * rest of the race. One kart's first banana ended its item game.
   */
  held(kart: IKart) {
    const s = this.slots.get(kart.id);
    let out = this.heldViews.get(kart.id);
    if (!out) {
      out = { kind: ItemKind.None, count: 0 };
      this.heldViews.set(kart.id, out);
    }
    if (s && s.kind === ItemKind.None && s.carried >= 0) {
      out.kind = this.proj.carriedKind(s.carried, kart.id);
      out.count = out.kind === ItemKind.None ? 0 : 1;
    } else {
      out.kind = s ? s.kind : ItemKind.None;
      out.count = s ? s.count : 0;
    }
    return out;
  }

  /**
   * What this kart is towing behind it, or `None`. Distinct from `held`: a
   * towed item is spent by *releasing* it, which is a different decision from
   * choosing when to throw, and the AI needs to tell the two apart.
   */
  towing(kart: IKart): ItemKind {
    const s = this.slots.get(kart.id);
    if (!s || s.carried < 0) return ItemKind.None;
    return this.proj.carriedKind(s.carried, kart.id);
  }

  give(kart: IKart, kind: ItemKind, count = 1) {
    const s = this.slot(kart);
    s.kind = kind;
    s.count = kind === ItemKind.TripleMushroom ? Math.max(count, 3) : count;
    s.arm = ARM_TIME;
  }

  pickup(kart: IKart) {
    const s = this.slot(kart);
    if (s.kind !== ItemKind.None || s.carried >= 0) return;
    const racers = this.karts.length || 8;
    this.give(kart, this.roll(kart.place || racers, racers));
    this.ctx.bus.emit({ type: 'item-pickup', kart });
  }

  use(kart: IKart, backwards: boolean): boolean {
    const s = this.slot(kart);
    const ctx = this.ctx;

    // A trailing shield is released by the same button that deployed it.
    if (s.carried >= 0) {
      if (this.proj.isCarried(s.carried, kart.id)) {
        const target = backwards ? -1 : this.targetAhead(kart);
        this.proj.release(s.carried, kart, backwards, target);
        s.carried = -1;
        return true;
      }
      s.carried = -1;
    }

    if (s.kind === ItemKind.None || s.count <= 0) return false;
    if (s.arm > 0) return false;
    if (kart.stunTime > 0) return false;

    const kind = s.kind;
    let consumed = true;

    switch (kind) {
      case ItemKind.Mushroom:
      case ItemKind.TripleMushroom:
        kart.applyBoost(MUSHROOM_BOOST, MUSHROOM_STRENGTH);
        break;

      case ItemKind.Star:
        kart.starTime = Math.max(kart.starTime, STAR_TIME);
        kart.applyBoost(0.8, 1.2);
        break;

      case ItemKind.Bolt:
        this.fireBolt(kart);
        break;

      case ItemKind.GreenShell:
      case ItemKind.RedShell:
      case ItemKind.Banana:
      case ItemKind.Bomb: {
        const carry = backwards && kind !== ItemKind.Bomb;
        const target = kind === ItemKind.RedShell && !carry ? this.targetAhead(kart) : -1;
        const h = this.proj.spawn(kind, kart, backwards, carry, target);
        if (h < 0) return false;
        if (carry) s.carried = h;
        break;
      }

      default:
        consumed = false;
        break;
    }

    if (!consumed) return false;
    ctx.bus.emit({ type: 'item-use', kart, kind });

    s.count--;
    if (s.count <= 0) {
      s.kind = ItemKind.None;
      s.count = 0;
    } else {
      // a triple is spent one at a time, and each one arms briefly
      s.arm = 0.22;
    }
    return true;
  }

  // ------------------------------------------------------------------ helpers

  private slot(kart: IKart): Slot {
    let s = this.slots.get(kart.id);
    if (!s) {
      s = this.freshSlot();
      this.slots.set(kart.id, s);
    }
    return s;
  }

  /** The kart one place ahead — the red shell's rightful victim. */
  private targetAhead(kart: IKart): number {
    const standings = this.ctx.race?.standings;
    if (!standings || !standings.length) return -1;
    const idx = standings.indexOf(kart);
    for (let i = idx - 1; i >= 0; i--) {
      const o = standings[i];
      if (o && !o.finished) return o.id;
    }
    return -1;
  }

  private fireBolt(user: IKart) {
    for (const k of this.karts) {
      if (k === user || k.finished) continue;
      if (k.starTime > 0) continue;
      const before = k.stunTime;
      k.squash(BOLT_STUN);
      if (k.stunTime <= before) continue;   // invulnerable, nothing landed
      const s = this.slot(k);
      s.shrink = BOLT_TIME;
      // dropping whatever they were towing is half the point of the bolt
      if (s.carried >= 0) {
        this.proj.drop(s.carried);
        s.carried = -1;
      }
      this.ctx.bus.emit({ type: 'hit', kart: k, kind: ItemKind.Bolt });
    }
  }

  // -------------------------------------------------------------------- frame

  update(ctx: Ctx, dt: number) {
    this.ctx = ctx;
    const karts = ctx.race?.karts ?? this.karts;
    this.karts = karts;
    const now = ctx.time;

    // The sky may only publish its environment map after our materials were
    // built; pick it up the frame it appears rather than shipping matte plastic.
    if (ctx.envMap !== this.env) {
      this.env = ctx.envMap;
      this.boxMat.envMap = this.env;
      this.boxMat.needsUpdate = true;
      // The glass refracts the env in a hand-written chunk guarded on
      // `USE_ENVMAP`, so gaining one has to recompile — `needsUpdate` above does
      // that. The mark only reflects it.
      this.markMat.envMap = this.env;
      this.markMat.needsUpdate = true;
      const om = this.orbitMesh.material as THREE.MeshPhysicalMaterial;
      om.envMap = this.env;
      om.needsUpdate = true;
      this.proj.setEnv(this.env);
    }

    // The pause menu stops `Race`, and `Race` is the only thing that knows the
    // game is paused — every other system, this one included, keeps getting
    // ticked so the frame still renders. Left to itself that turns the pause
    // screen into a cheat: a kart's physics is frozen by `Race`, so its star and
    // its stun sit exactly where they were, while every timer *this* module owns
    // runs on. Wait behind the menu and you come back with the bolt's shrink
    // gone, the roulette armed and the boxes you drove through already back up.
    // Visuals (the bob, the spin, the halo) are deliberately left running: the
    // world behind the menu should still look alive.
    const paused = ctx.race?.state === RaceState.Paused;
    const step = paused ? 0 : dt;

    this.updateBoxes(step, karts, now);

    // --- per-kart item state ------------------------------------------------
    for (const k of karts) {
      const s = this.slot(k);
      if (s.arm > 0) s.arm = Math.max(0, s.arm - step);
      if (s.starHit > 0) s.starHit -= step;
      if (s.carried >= 0 && !this.proj.isCarried(s.carried, k.id)) s.carried = -1;

      // bolt: shrunk, slowed, and visibly smaller until it wears off
      if (s.shrink > 0) {
        s.shrink = Math.max(0, s.shrink - step);
        const u = clamp(s.shrink / BOLT_TIME, 0, 1);
        // quick squash down, slow grow back — recovery should be felt
        const shrunk = 0.52 + 0.48 * Math.pow(1 - u, 2.2);
        k.object.scale.setScalar(shrunk);
        // a real speed penalty applied as drag, through the sanctioned command
        _v.copy(k.velocity).multiplyScalar(-clamp(1.35 * dt, 0, 0.5) * u);
        _v.y = 0;
        k.launch(_v);
        if (s.shrink <= 0) k.object.scale.setScalar(1);
      }

      // star: barge anyone you touch out of the way
      if (!paused && k.starTime > 0 && s.starHit <= 0) this.starSweep(ctx, k, s);
    }

    this.proj.update(ctx, step, karts);
    this.updateOrbit(karts, now);
  }

  private starSweep(ctx: Ctx, star: IKart, s: Slot) {
    for (const o of this.karts) {
      if (o === star || o.starTime > 0) continue;
      _v.subVectors(o.position, star.position);
      if (Math.abs(_v.y) > 2) continue;
      _v.y = 0;
      if (_v.lengthSq() > 3.2 * 3.2) continue;
      const before = o.stunTime;
      o.spinOut(1.25);
      if (o.stunTime <= before) continue;
      if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
      _v.normalize().multiplyScalar(11);
      _v.y = 5.5;
      o.launch(_v);
      ctx.bus.emit({ type: 'hit', kart: o, kind: ItemKind.Star });
      s.starHit = 0.4;
    }
  }

  // ---------------------------------------------------------------- item boxes

  private updateBoxes(dt: number, karts: readonly IKart[], now: number) {
    this.boxShadows.begin();
    this.boxGlow.begin();
    let live = 0;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];

      if (b.down > 0) {
        b.down -= dt;
        if (b.down <= 0) b.scale = 0.001;
      } else {
        // elastic pop-in; a box that fades back is invisible at racing speed
        if (b.scale < 1) {
          b.scale = Math.min(1, b.scale + dt * 3.4);
        }
        for (let j = 0; j < karts.length; j++) {
          const k = karts[j];
          if (k.finished) continue;
          _v.subVectors(k.position, b.pos);
          if (Math.abs(_v.y) > 2.2) continue;
          _v.y = 0;
          if (_v.lengthSq() > BOX_PICKUP_R * BOX_PICKUP_R) continue;
          const s = this.slot(k);
          if (s.kind !== ItemKind.None || s.carried >= 0) continue;
          this.pickup(k);
          b.down = BOX_RESPAWN;
          b.scale = 0;
          break;
        }
      }

      if (b.scale <= 0.005) continue;

      // overshoot on the way in, so it lands with a bit of weight
      const pop = b.scale < 1
        ? 1 - Math.pow(1 - b.scale, 3) + Math.sin(b.scale * Math.PI) * 0.22
        : 1;
      // Bob along the *local ground normal*, not world Y, so on the banked
      // sections the box rises off the road rather than leaning away from it.
      const bob = Math.sin(now * 1.7 + b.phase) * 0.16;
      _e.set(
        Math.sin(now * 0.7 + b.phase) * 0.22,
        now * 1.15 + b.phase,
        Math.cos(now * 0.53 + b.phase * 1.3) * 0.18,
      );
      _q.setFromEuler(_e);
      _v2.copy(b.pos).addScaledVector(b.normal, bob);
      _s.setScalar(pop);
      _m.compose(_v2, _q, _s);
      this.boxMesh.setMatrixAt(live, _m);

      // The mark, inside the glass, on its own clock.
      //
      // Same centre, near-enough the same attitude — a fixed 0.26 rad of yaw
      // offset plus a slow relative wobble — so a "?" is always facing roughly
      // where a facet is facing (it has to stay readable), but the two never
      // line up. That mismatch is the whole point: as the box turns, the glyph
      // slides against the facet in front of it, and *seeing a thing move
      // behind a surface* is the cue that reads as a solid volume. A decal
      // printed on the outer face can never produce it, which is why round 1's
      // boxes read as six cards however they were shaded.
      _e.set(
        Math.sin(now * 0.7 + b.phase) * 0.22 + Math.sin(now * 0.41 + b.phase) * 0.13,
        now * 1.15 + b.phase + 0.26,
        Math.cos(now * 0.53 + b.phase * 1.3) * 0.18 - Math.sin(now * 0.37 + b.phase) * 0.11,
      );
      _q.setFromEuler(_e);
      _s.setScalar(pop);
      _m.compose(_v2, _q, _s);
      this.markMesh.setMatrixAt(live, _m);

      // the halo counter-rotates and breathes — two motions, never in sync
      const pulse = 0.94 + Math.sin(now * 4.1 + b.phase * 2.1) * 0.10;
      _e.set(now * -0.9, now * 1.9 + b.phase, 0);
      _q.setFromEuler(_e);
      _s.setScalar(pop * pulse);
      _m.compose(_v2, _q, _s);
      this.coreMesh.setMatrixAt(live, _m);

      // Ground contact. `b.ground` is the probed point on the tarmac directly
      // under the box, so both layers land on the surface rather than on a
      // plane through the centreline. The shadow shrinks and softens as the box
      // rises on its bob; the light pool does the opposite and spreads, which is
      // what a lamp moving away from a surface actually does.
      // Both spans are full widths, not radii: 1.85 m of shadow under a 1.55 m
      // box, and a light pool a little over twice that.
      const lift = clamp((BOX_HEIGHT + bob) / 3, 0, 1);
      const g = b.ground;
      this.boxShadows.add(g.x, g.y, g.z, b.normal, (1.85 - lift * 0.42) * pop);
      this.boxGlow.add(g.x, g.y, g.z, b.normal, (3.4 + lift * 0.9) * pop);
      live++;
    }

    this.boxMesh.count = live;
    this.markMesh.count = live;
    this.coreMesh.count = live;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.markMesh.instanceMatrix.needsUpdate = true;
    this.coreMesh.instanceMatrix.needsUpdate = true;
    this.boxShadows.end();
    this.boxGlow.end();

    // The halo breathes rather than cycling the full hue wheel. Two reasons:
    // the old sweep spent a third of its cycle in greens and magentas the
    // course palette does not contain, and the halo now sits *outside* the
    // silhouette against a sky that is already near the bloom threshold, where
    // §6's "three effects must not white the frame out" bites hardest. So it
    // stays in the sky-warm band (`#ffd0a0` is hue ~0.08) and pulses value
    // instead — complementary to the sea-glass shell, so the two separate.
    const h = 0.085 + Math.sin(now * 0.6) * 0.025;
    this.coreMat.color.setHSL(h, 0.72, 0.50 + Math.sin(now * 2.3) * 0.06);
  }

  // ------------------------------------------------------------- carried items

  /** Triple mushrooms orbit the kart that owns them. */
  private updateOrbit(karts: readonly IKart[], now: number) {
    let n = 0;
    for (const k of karts) {
      const s = this.slots.get(k.id);
      if (!s || s.kind !== ItemKind.TripleMushroom || s.count <= 0) continue;
      const scale = k.object.scale.x || 1;
      for (let i = 0; i < s.count && n < 24; i++) {
        const a = now * 2.1 + (i / Math.max(1, s.count)) * Math.PI * 2;
        const r = 1.55 * scale;
        _v2.set(
          k.position.x + Math.sin(a) * r,
          k.position.y + 0.42 * scale + Math.sin(now * 3.2 + i) * 0.06,
          k.position.z + Math.cos(a) * r,
        );
        _q.setFromAxisAngle(UP, -a);
        _s.setScalar(0.95 * scale);
        _m.compose(_v2, _q, _s);
        this.orbitMesh.setMatrixAt(n++, _m);
      }
    }
    this.orbitMesh.count = n;
    this.orbitMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.proj.dispose();
    this.boxMesh.geometry.dispose();
    this.markMesh.geometry.dispose();
    this.coreMesh.geometry.dispose();
    this.orbitMesh.geometry.dispose();
    (this.orbitMesh.material as THREE.Material).dispose();
    this.boxMat.map?.dispose();
    this.boxMat.roughnessMap?.dispose();
    this.boxMat.iridescenceThicknessMap?.dispose();
    this.boxMat.dispose();
    this.markMat.map?.dispose();
    this.markMat.emissiveMap?.dispose();
    this.markMat.roughnessMap?.dispose();
    this.markMat.dispose();
    this.coreMat.dispose();
    this.boxShadows.dispose();
    this.boxGlow.dispose();
  }
}
