import * as THREE from 'three';
import {
  ItemKind,
  Quality,
  RACER_COUNT,
  RaceState,
  SURFACE_PROPS,
  Surface,
  type Ctx,
  type GameEvent,
  type IKart,
  type System,
} from '../types';
import { PMode, PTile, Particles } from './Particles';
import { Trails } from './Trails';
import { DecalTile, Decals } from './Decals';

/**
 * ============================================================================
 *  Effects — the readability layer.
 * ============================================================================
 *  Everything the player learns about their own car without reading the HUD
 *  comes from here: how hard they are drifting, how close the mini-turbo is,
 *  whether the surface under them is costing them speed, whether that hit
 *  landed. It subscribes to the bus and reads kart state; it never drives
 *  gameplay.
 *
 *  Budget: 2 particle draws, 1 trail draw, 1 decal draw, plus five small
 *  world/entity systems (rings, plumes, motes, gulls, shimmer) that each cost
 *  exactly one instanced draw and skip themselves entirely when idle.
 *
 *  NOTHING IN HERE MAY HAVE A HARD SILHOUETTE NEAR THE KART. Three rounds of
 *  review were lost to rigid additive geometry sitting in the middle of the
 *  frame — a torus around the drifting kart, then the same torus rotated
 *  ninety degrees, then a fresnel ellipsoid husk for star power — every one of
 *  which was necessarily *inside* the chassis it was meant to decorate. The
 *  only shapes allowed within a couple of metres of a kart are particles,
 *  ground-aligned quads with no edge, and the boost ribbon, which is welded to
 *  the exhaust and points away from the bodywork. Shockwaves are punched clear
 *  of the car, thin, fast, and seen edge-on.
 *
 *  Energy: every additive surface in this file is multiplied by a single
 *  shared `gain` that falls as more bright effects crowd the frame (see
 *  `updateGain`), AND every additive fragment passes through a per-pixel
 *  Reinhard shoulder so overlapping sprites asymptote instead of summing. The
 *  worst case the art direction calls out — purple drift + boost + a boost pad
 *  under the tunnel exit bloom — lands at gain 0.45.
 * ============================================================================
 */

// --- palette (art bible §3) -------------------------------------------------
const C_TIER = [
  new THREE.Color(0xffffff),
  new THREE.Color(0x4fc3ff),
  new THREE.Color(0xff9d2e),
  new THREE.Color(0xc05cff),
];
/**
 * Authoring colour for anything emitted on a live tier CHANNEL. The particle
 * stores only its intensity; `Particles.setChannelColor` supplies the hue every
 * frame from the kart's current drift tier, so a promotion recolours the shower
 * already in the air. See EmitParams.channel.
 */
const C_CHANNEL = new THREE.Color(1, 1, 1);

/**
 * ===========================================================================
 *  TIER CHARACTER — the escalation table.
 * ===========================================================================
 *
 *  For four rounds the three mini-turbo tiers differed by HUE AND ALMOST
 *  NOTHING ELSE. Emission went 90 / 120 / 150 units, the spark core went 0.21 /
 *  0.26 / 0.31 m, and every other layer — the ground pool, the halo, the
 *  scorch, the smoke — was the same object with a different colour poured into
 *  it. Measured off the round-13 probe frames, a tier-1 and a tier-3 slide are
 *  within 0.2 of a display luma of each other and within 4% on the fraction of
 *  frame carrying a saturated hue. The player cannot feel a charge building
 *  because nothing about the shower is building; it is only changing channel.
 *
 *  So the tiers are authored as three DIFFERENT EFFECTS that happen to share a
 *  palette entry:
 *
 *    tier 1  blue    a crisp, sparse, fast shower. Sparks and a thin pool.
 *    tier 2  orange  half again the density, visibly bigger grains, plus a
 *                    RISING EMBER JET off each contact patch — the first thing
 *                    in the escalation that leaves the ground plane, so the
 *                    slide grows vertically as well as brighter.
 *    tier 3  purple  dense, largest grains, full jets, a ground glow nearly
 *                    twice the area of tier 1's, and — the signature — a PULSE:
 *                    a thin violet ring beating out of the contact patches
 *                    several times a second. Nothing else in the game beats,
 *                    so a charged purple reads across a room even when the
 *                    kart is fifteen pixels tall.
 *
 *  `rate` is emission units/s per wheel; `core`/`halo` are metres; `poolS` and
 *  `poolI` scale the ground glow's size and radiance; `jet` and `pulse` are the
 *  two new layers, 0 = absent.
 */
interface TierFx {
  rate: number; core: number; halo: number;
  poolS: number; poolI: number; jet: number; pulse: number;
  /** additive intensity of the spark cores — a purple spark is a hotter spark */
  spark: number;
  /** seconds the promotion flash runs for */
  flash: number;
}
const TIER_FX: TierFx[] = [
  { rate: 0,   core: 0,    halo: 0,    poolS: 0,    poolI: 0,    jet: 0,   pulse: 0,  spark: 0,    flash: 0 },
  { rate: 64,  core: 0.20, halo: 0.70, poolS: 1.00, poolI: 0.88, jet: 0,   pulse: 0,  spark: 2.25, flash: 0.20 },
  { rate: 100, core: 0.28, halo: 0.96, poolS: 1.45, poolI: 1.34, jet: 0.7, pulse: 0,  spark: 2.55, flash: 0.26 },
  { rate: 140, core: 0.36, halo: 1.22, poolS: 2.00, poolI: 1.92, jet: 1.0, pulse: 1,  spark: 2.85, flash: 0.34 },
];
/** beats per second of the tier-3 ground pulse */
const TIER3_PULSE_HZ = 6.5;
const C_HOT = new THREE.Color(0xfff2d4);
const C_FLAME_MID = new THREE.Color(0xff9a2e);
const C_FLAME_COOL = new THREE.Color(0xc4331a);
/** blue-white root of a boost flame — hotter and cooler-hued than C_HOT */
const C_FLAME_ROOT = new THREE.Color(0xdcefff);
const C_SMOKE = new THREE.Color(0xb9b4ac);
/**
 * Smoke torn off a tyre on TARMAC. Vaporised rubber and road binder is a cool
 * light grey; `C_SMOKE` is a warm grey authored for dust, and warming it a
 * further 42% toward the key put the drift cloud on exactly the hue of dry dirt
 * — the review reads it as "driving through a dust cloud, not tyres tearing at
 * tarmac". The sun side is warmed by the wrap-lighting term in Particles, which
 * is where that warmth belongs: in the LIGHT, not in the albedo.
 */
const C_SMOKE_TARMAC = new THREE.Color(0xc4c6cf);
// Old, cooled smoke. Nudged off the warm grey it used to be: a puff that has
// stopped being lit by the exhaust is lit by the sky, and §2 puts the shadow
// end of the grade on the cool side. It is the far end of the birth→death ramp,
// so this is what gives a drift column a warm head and a cool tail.
const C_SMOKE_DARK = new THREE.Color(0x64656e);
const C_WATER = new THREE.Color(0xbfe6ff);
const C_FOAM = new THREE.Color(0xeefaff);
const C_GOLD = new THREE.Color(0xffd36b);
const C_SUNMOTE = new THREE.Color(0xffe2b4);
const C_SPARK_WHITE = new THREE.Color(0xfff4e0);
const C_DEBRIS = new THREE.Color(0x3a3530);
const CONFETTI = [
  new THREE.Color(0xe0453f), new THREE.Color(0x4fc3ff), new THREE.Color(0xffd36b),
  new THREE.Color(0x87b356), new THREE.Color(0xdcb8d8), new THREE.Color(0xf2ece0),
];

// --- module-scope scratch: the hot path allocates nothing --------------------
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _bounds = new THREE.Sphere();

const damp = (dt: number, rate: number) => 1 - Math.pow(rate, dt);

/**
 * ORPHANED SMOKE — the lifetime rule.
 *
 * Particles are integrated in the WORLD frame, and every smoke emitter drags to
 * a stop within a few tenths of a second. That is physically right and visually
 * catastrophic above about 15 m/s: the puff parks in the air while the kart
 * keeps going, so a 1.25 s tyre-smoke puff behind a kart at 25 m/s ends its
 * life a little over THIRTY METRES back down the road, still at chase-visible
 * opacity, with nothing underneath it. That is exactly the review note — three
 * detached cotton-wool blobs clear of the pack in the pack frame, and one lone
 * puff on an empty village street in the wide.
 *
 * Velocity inheritance alone cannot fix it (the drag term still eats the
 * inherited component), so the lifetime is budgeted in METRES instead of in
 * seconds: a puff is allowed to fall `metres` behind whatever made it and no
 * further, whatever the speed. Standing still, it gets the full `hi` and hangs
 * as it should.
 */
function trailLife(speed: number, metres: number, lo: number, hi: number) {
  return THREE.MathUtils.clamp(metres / Math.max(speed, 4), lo, hi);
}

// ===========================================================================
//  Shockwave rings — instanced, simulated entirely in the vertex shader.
// ===========================================================================

const RING_VERT = /* glsl */ `
uniform float uTime;
attribute vec4 aCen;   // xyz centre, w birth
attribute vec4 aRad;   // x r0, y r1, z life, w thickness (0..1 of radius)
attribute vec4 aQuat;  // orientation, maps +Y to the surface normal
attribute vec4 aCol;   // rgb, a peak intensity
attribute vec4 aDrift; // xyz centre velocity, w drag (1/s)
varying vec3 vCol;
varying float vA;
varying float vR;
varying float vViewZ;

vec3 rotq(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main() {
  float age = uTime - aCen.w;
  float u = age / max(aRad.z, 1e-4);
  if (age < 0.0 || u >= 1.0) {
    vCol = vec3(0.0); vA = 0.0; vR = 0.0; vViewZ = 1.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Ease-out expansion: a shockwave is fastest the instant it is born.
  float e = 1.0 - pow(1.0 - u, 2.8);
  float R = mix(aRad.x, aRad.y, e);
  float rr = mix(R * (1.0 - aRad.w), R, uv.x);
  // The centre may travel. A ring fired off a kart at 25 m/s that stays pinned
  // to the world is 7 m adrift by the time it fades, which is exactly why the
  // drift ring reads as a hoop lying on empty tarmac instead of as feedback
  // attached to the car.
  float k = max(aDrift.w, 1e-3);
  vec3 centre = aCen.xyz + aDrift.xyz * (1.0 - exp(-k * age)) / k;
  vec3 wp = centre + rotq(aQuat, vec3(position.x * rr, 0.0, position.z * rr));
  vCol = aCol.rgb;
  vA = aCol.a * (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.10, u);
  vR = uv.x;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uGain;
#ifdef SOFT_DEPTH
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uCamPlanes;
uniform float uSoft;
#endif
varying vec3 vCol;
varying float vA;
varying float vR;
varying float vViewZ;
void main() {
  // Two-lobe radial profile across the annulus: a narrow bright band riding a
  // wide soft body, reaching exactly zero at BOTH rims. The old sin^2 was
  // effectively a fat plateau — with an additive colour authored above 1.0 it
  // saturated across most of its width, and a saturated band with a fast
  // shoulder is indistinguishable from an opaque matte torus. This keeps a
  // legible core while spending most of the annulus in visible falloff.
  float e = sin(vR * 3.14159265);
  float a = vA * (0.34 * pow(e, 1.7) + 0.66 * pow(e, 5.5));
#ifdef SOFT_DEPTH
  // Depth fade. A shockwave punched out of a kart necessarily intersects the
  // kart; without this it terminates on a hard curve exactly where it enters
  // the bodywork, which is the "welded plastic prop" read.
  float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
  float nz = uCamPlanes.x, fz = uCamPlanes.y;
  float sceneZ = (2.0 * nz * fz) / (fz + nz - (d * 2.0 - 1.0) * (fz - nz));
  a *= clamp((sceneZ - vViewZ) / uSoft, 0.0, 1.0);
#endif
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Rings {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly data: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private used = 0;
  private liveUntil = -1;

  static readonly STRIDE = 20;

  constructor(readonly capacity: number, segments = 64) {
    const pos = new Float32Array((segments + 1) * 2 * 3);
    const uv = new Float32Array((segments + 1) * 2 * 2);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = cx; pos[o + 1] = 0; pos[o + 2] = cz;
        uv[(i * 2 + k) * 2] = k;          // 0 = inner rim, 1 = outer rim
        uv[(i * 2 + k) * 2 + 1] = i / segments;
      }
    }
    const idx = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx[i * 6] = a; idx[i * 6 + 1] = a + 1; idx[i * 6 + 2] = a + 2;
      idx[i * 6 + 3] = a + 1; idx[i * 6 + 4] = a + 3; idx[i * 6 + 5] = a + 2;
    }

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.data = new Float32Array(capacity * Rings.STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, Rings.STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const names = ['aCen', 'aRad', 'aQuat', 'aCol', 'aDrift'];
    for (let i = 0; i < names.length; i++) {
      this.geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    }
    this.geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGain: { value: 1 },
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uCamPlanes: { value: new THREE.Vector2(0.2, 3000) },
        // ~0.7 m of intersection distance: long enough to swallow a wheel or a
        // roll bar, short enough that a ring against the road still reads.
        uSoft: { value: 0.7 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'fx-rings';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;
  }

  set gain(v: number) { this.material.uniforms.uGain.value = v; }

  resize(w: number, h: number) { this.material.uniforms.uInvRes.value.set(1 / w, 1 / h); }

  setDepthTexture(tex: THREE.Texture | null, near: number, far: number) {
    const m = this.material;
    const had = m.defines.SOFT_DEPTH !== undefined;
    const want = !!tex;
    m.uniforms.uDepth.value = tex;
    m.uniforms.uCamPlanes.value.set(near, far);
    if (want !== had) {
      if (want) m.defines.SOFT_DEPTH = ''; else delete m.defines.SOFT_DEPTH;
      m.needsUpdate = true;
    }
  }

  /**
   * `drift` (optional) is the velocity the ring's centre inherits, decayed by
   * `driftDrag`. Pass the emitting kart's velocity and the ring stays with the
   * car instead of being left behind on the road.
   */
  spawn(p: THREE.Vector3, normal: THREE.Vector3, r0: number, r1: number, life: number,
        thickness: number, color: THREE.Color, intensity: number, now: number,
        drift: THREE.Vector3 | null = null, driftDrag = 0.9) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    const o = i * Rings.STRIDE;
    const d = this.data;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = now;
    d[o + 4] = r0; d[o + 5] = r1; d[o + 6] = life; d[o + 7] = thickness;
    _quat.setFromUnitVectors(UP, _n.copy(normal).normalize());
    d[o + 8] = _quat.x; d[o + 9] = _quat.y; d[o + 10] = _quat.z; d[o + 11] = _quat.w;
    d[o + 12] = color.r * intensity; d[o + 13] = color.g * intensity; d[o + 14] = color.b * intensity;
    d[o + 15] = 1;
    d[o + 16] = drift ? drift.x : 0;
    d[o + 17] = drift ? drift.y : 0;
    d[o + 18] = drift ? drift.z : 0;
    d[o + 19] = driftDrag;
    this.buf.needsUpdate = true;
    if (now + life > this.liveUntil) this.liveUntil = now + life;
  }

  update(now: number) {
    this.material.uniforms.uTime.value = now;
    this.geo.instanceCount = now > this.liveUntil ? 0 : this.used;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Dust motes — the low sun catching airborne particulate near the camera.
//  Entirely GPU-resident: positions are hashed, wrapped around the camera and
//  drifted in the vertex shader, so this is one draw and zero CPU forever.
// ===========================================================================

const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform float uBox;
uniform float uFar;
attribute vec4 aSeed;
varying float vA;
varying vec2 vQ;

void main() {
  vec3 base = aSeed.xyz * (2.0 * uBox);
  float t = uTime * (0.10 + aSeed.w * 0.14);
  base += vec3(sin(t * 1.7 + aSeed.x * 41.0),
               sin(t * 1.1 + aSeed.y * 27.0) * 0.55,
               cos(t * 1.4 + aSeed.z * 33.0)) * 0.7;
  // wrap into the box centred on the camera
  vec3 p = uCam + mod(base - uCam + uBox, 2.0 * uBox) - uBox;

  vec3 d = p - uCam;
  float dist = length(d);
  vec3 vdir = d / max(dist, 1e-4);
  // Motes only really exist when they are between you and the sun.
  float fs = pow(max(dot(vdir, uSunDir), 0.0), 3.5);
  // kept low: motes should read as haze in the light shafts, never a starfield
  vA = (0.07 + 0.85 * fs)
     * smoothstep(uFar, uFar * 0.45, dist)
     * smoothstep(0.7, 2.6, dist);
  if (vA < 0.002) { vQ = vec2(0.0); gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float sz = (0.022 + aSeed.w * 0.045) * (1.0 + dist * 0.06);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 vert = p + camRight * (position.x * sz) + camUp * (position.y * sz);
  vQ = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(vert, 1.0);
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
varying float vA;
varying vec2 vQ;
void main() {
  float d = length(vQ);
  float a = vA * pow(max(0.0, 1.0 - d), 2.2);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Motes {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(count: number, box: number, far: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = count;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uBox: { value: box }, uFar: { value: far },
        uColor: { value: C_SUNMOTE.clone().multiplyScalar(1.6) },
        uGain: { value: 1 },
      },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'fx-motes';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 13;
  }

  update(time: number, cam: THREE.Vector3, sunDir: THREE.Vector3, gain: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCam.value.copy(cam);
    u.uSunDir.value.copy(sunDir);
    u.uGain.value = gain;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Gulls — instanced, flapped and flown in the vertex shader.
// ===========================================================================

const GULL_VERT = /* glsl */ `
uniform float uTime;
/** xyz = the point the flock was last startled from, w = 0..1 strength */
uniform vec4 uScare;
attribute vec4 aOrbit;  // xyz centre, w radius
attribute vec4 aPhase;  // x phase, y angular speed, z flap rate, w scale
varying float vTip;
varying float vShade;

void main() {
  float ang = uTime * aPhase.y + aPhase.x;
  vec3 c = aOrbit.xyz + vec3(cos(ang), 0.0, sin(ang)) * aOrbit.w;
  c.y += sin(ang * 2.0 + aPhase.x) * 1.8;

  // Startle response. A kart arriving at the harbour front latches a point on
  // the CPU and the strength decays over a couple of seconds; the birds inside
  // the radius break away from it, climb, and settle back as it fades. Art
  // bible §9.7 — the frame has to look like something is happening, and a
  // flock that ignores a kart passing three metres under it is scenery.
  vec3 away = c - uScare.xyz;
  float d2 = dot(away.xz, away.xz);
  float startle = uScare.w * exp(-d2 / 900.0);
  vec2 flee = d2 > 1e-3 ? normalize(away.xz) : vec2(1.0, 0.0);
  c.xz += flee * (startle * 11.0);
  c.y += startle * 9.0;

  vec3 fwd = vec3(-sin(ang), 0.0, cos(ang));
  vec3 right = vec3(cos(ang), 0.0, sin(ang));
  vec3 up = vec3(0.0, 1.0, 0.0);

  // Panicked birds beat their wings roughly twice as fast.
  float flap = sin(uTime * aPhase.z * (1.0 + startle * 1.4) + aPhase.x * 3.0) * (0.85 + 0.25 * startle);
  // position doubles as the bird-local frame: x span, y up, z along the body
  float span = abs(position.x);
  vec3 L = position;
  L.y += sin(flap) * span * 1.15;
  L.x *= cos(flap * 0.55);
  // bank into the turn
  float bank = 0.25;
  vec3 r2 = right * cos(bank) + up * sin(bank);
  vec3 u2 = up * cos(bank) - right * sin(bank);

  vec3 wp = c + (r2 * L.x + u2 * L.y + fwd * L.z) * aPhase.w;
  vTip = span;
  vShade = 0.55 + 0.45 * clamp(cos(flap), 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const GULL_FRAG = /* glsl */ `
uniform vec3 uLight;
varying float vTip;
varying float vShade;
void main() {
  // white body, charcoal wingtips — reads at any distance
  vec3 albedo = mix(vec3(0.95, 0.94, 0.90), vec3(0.16, 0.16, 0.18), smoothstep(0.62, 0.95, vTip));
  gl_FragColor = vec4(albedo * uLight * vShade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Gulls {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(count: number, centre: THREE.Vector3) {
    // Six triangles: two per wing, two for the body sliver.
    const L: number[] = [];
    const push = (a: number[], b: number[], c: number[]) => { L.push(...a, ...b, ...c); };
    for (const s of [-1, 1]) {
      push([0, 0, 0.1], [s * 0.5, 0.02, 0.22], [s * 1.0, 0.0, -0.02]);
      push([0, 0, 0.1], [s * 1.0, 0.0, -0.02], [s * 0.42, -0.01, -0.24]);
    }
    push([0, 0.03, 0.42], [-0.075, 0, -0.02], [0.075, 0, -0.02]);
    push([0, 0.0, -0.46], [0.075, 0, -0.02], [-0.075, 0, -0.02]);

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L), 3));

    const orbit = new Float32Array(count * 4);
    const phase = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // A third of the flock loafs low over the harbour wall on a tight orbit,
      // which is the only part of it a chase camera at road level ever sees —
      // and the only part a passing kart can plausibly startle. The rest ride
      // the high thermals as before, for the wide and cliff compositions.
      const low = i % 3 === 0;
      orbit[i * 4] = centre.x + (Math.random() - 0.5) * (low ? 34 : 70);
      orbit[i * 4 + 1] = centre.y + (low ? 3.5 + Math.random() * 5 : 14 + Math.random() * 26);
      orbit[i * 4 + 2] = centre.z + (Math.random() - 0.5) * (low ? 34 : 70);
      orbit[i * 4 + 3] = low ? 7 + Math.random() * 12 : 16 + Math.random() * 46;
      phase[i * 4] = Math.random() * Math.PI * 2;
      phase[i * 4 + 1] = (0.055 + Math.random() * 0.06) * (Math.random() < 0.5 ? -1 : 1);
      phase[i * 4 + 2] = 3.4 + Math.random() * 2.2;
      phase[i * 4 + 3] = 0.9 + Math.random() * 0.55;
    }
    this.geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    this.geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 4));
    this.geo.instanceCount = count;
    this.geo.boundingSphere = new THREE.Sphere(centre.clone(), 400);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uScare: { value: new THREE.Vector4(0, -1e4, 0, 0) },
      },
      vertexShader: GULL_VERT,
      fragmentShader: GULL_FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'fx-gulls';
    this.mesh.matrixAutoUpdate = false;
    // A startled bird flies up to ~20 m clear of its orbit; the bounding sphere
    // above is 400 m around the colony, so the flush stays inside it and the
    // flock cannot cull itself mid-scatter.
    this.centre.copy(centre);
  }

  readonly centre = new THREE.Vector3();
  private scareT = 0;

  /** Latch a startle point. Ignored while a stronger one is still decaying. */
  startle(p: THREE.Vector3) {
    if (this.scareT > 0.55) return;
    this.scareT = 1;
    const s = this.material.uniforms.uScare.value as THREE.Vector4;
    s.set(p.x, p.y, p.z, 0);
  }

  update(time: number, light: THREE.Color, dt: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uLight.value.copy(light);
    // Fast break, slow settle — the shape of an actual flush.
    this.scareT = Math.max(0, this.scareT - dt * 0.42);
    const s = this.material.uniforms.uScare.value as THREE.Vector4;
    const want = this.scareT * this.scareT * (3 - 2 * this.scareT);
    s.w += (want - s.w) * Math.min(1, dt * (want > s.w ? 9 : 2.2));
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Heat shimmer — a warm haze band that hangs over hot tarmac in the middle
//  distance. Without access to the post chain we cannot refract, so this
//  deliberately stays a low-amplitude scattering veil rather than pretending.
// ===========================================================================

const SHIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHIM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAmount;
uniform vec3 uColor;
uniform float uGain;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  if (uAmount <= 0.001) discard;
  // vertical wobble of the sample point is what sells "rising air"
  float wob = vnoise(vec2(vUv.x * 9.0, uTime * 0.9)) - 0.5;
  vec2 q = vec2(vUv.x * 14.0 - uTime * 0.35, vUv.y * 4.0 + wob * 0.7 - uTime * 1.25);
  float n = vnoise(q) * 0.65 + vnoise(q * 2.3 + 5.0) * 0.35;
  float band = smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
  float edge = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
  float a = uAmount * band * edge * smoothstep(0.42, 0.85, n);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Shimmer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const g = new THREE.PlaneGeometry(70, 4.5, 1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0xffd2a0) }, uGain: { value: 1 },
      },
      vertexShader: SHIM_VERT, fragmentShader: SHIM_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-shimmer';
    this.mesh.renderOrder = 13;
    this.mesh.frustumCulled = false;
  }

  place(pos: THREE.Vector3, faceDir: THREE.Vector3, amount: number, time: number, gain: number) {
    this.mesh.position.copy(pos);
    _p.copy(pos).sub(faceDir);
    this.mesh.lookAt(_p);
    this.material.uniforms.uAmount.value = amount;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uGain.value = gain;
    this.mesh.visible = amount > 0.002;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Boost plumes — the flame itself, as geometry.
// ===========================================================================
//
//  WHY THIS IS NOT PARTICLES.
//
//  Three rounds of this effect were a burst of additive billboards fired out of
//  the exhaust stacks, and three rounds of review said the boost frame has no
//  flame in it. It never could have. A flame is a *coherent, oriented, attached*
//  shape and a billboard cloud is none of those things:
//
//    - The tapered flame tile is directional, but a billboard's roll comes from
//      its per-particle random seed, so every tongue pointed a different way and
//      the plume had no axis at all.
//    - The chase camera sits directly behind the stacks, so the emission
//      velocity projects to nothing on screen, PMode.Stretch correctly refuses
//      to orient, and what is left is a handful of round blobs.
//    - At 32 m/s with motion blur on, a scatter of sub-frame-lifetime sprites
//      smears into grey wisps — which is exactly what the boost shot shows.
//
//  So the plume is a mesh: a ribbon that pivots about the exhaust axis to face
//  the camera, with an animated width profile and a baked temperature ramp. It
//  is welded to the kart, it reads at any speed because it is not made of
//  motion, and it degrades gracefully to a hot disc when you look straight down
//  its axis — which is the head-on afterburner read.
//
//  One instanced draw for the whole field. Sixteen instances, eleven segments
//  each; `instanceCount` is zero on any frame nobody is boosting.

const PLUME_SEGS = 11;

const PLUME_VERT = /* glsl */ `
uniform float uTime;

attribute vec4 aOrigin;  // xyz stack mouth, w seed
attribute vec4 aAxis;    // xyz unit axis (direction the flame grows), w length
attribute vec4 aShape;   // x radius, y intensity, z flicker rate, w taper power
attribute vec4 aTint;    // rgb tier tint, a master alpha

varying float vU;
varying float vSide;
varying float vAlign;
varying vec3 vTint;
varying vec2 vPower;     // x intensity, y master alpha

void main() {
  float u = clamp(position.y, 0.0, 1.0);
  float side = position.x;
  float fin = position.z;          // 0 = camera-facing ribbon, 1 = cross fin
  float seed = aOrigin.w;

  vec3 A = normalize(aAxis.xyz);
  vec3 O = aOrigin.xyz;

  vec3 toEye = cameraPosition - O;
  float el = length(toEye);
  vec3 V = el > 1e-4 ? toEye / el : vec3(0.0, 0.0, 1.0);
  float align = abs(dot(A, V));
  vAlign = align;

  // A chase camera sits almost exactly on the exhaust axis, so align is near
  // 1 for the shot that matters most and the plume's LENGTH projects to almost
  // nothing. Two things stop that reading as a stub: the tongue shortens and
  // widens as it turns to face us, and a second ribbon crossed at ninety
  // degrees fades in to give the head-on view a flare instead of a bar. The
  // fin is invisible side-on (it is edge-on there) so it costs nothing.
  float L = aAxis.w * (1.0 - 0.26 * align);
  float W = aShape.x * (1.0 + 0.70 * align);

  vec3 S0 = cross(A, V);
  float sl = length(S0);
  S0 = sl > 1e-3 ? S0 / sl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 S = mix(S0, normalize(cross(A, S0)), fin);

  // Tongue profile: pinched at the stack mouth, widest a quarter of the way
  // out, dissolving to a point. Never a cone, never a cylinder.
  float prof = pow(max(0.0, 1.0 - u), aShape.w) * (0.34 + 0.66 * smoothstep(0.0, 0.26, u));
  // Combustion flicker and a lateral lick, both scaled by u so the root stays
  // welded to the exhaust and only the free end moves.
  float t = uTime * aShape.z + seed * 31.4;
  prof *= 1.0 + 0.26 * sin(u * 9.3 + t * 2.1 + fin * 2.0) * u;
  float lick = 0.16 * W * u * u * (sin(u * 6.1 + t * 1.7) + 0.6 * sin(u * 13.7 - t * 2.6));

  vec3 P = O + A * (L * u) + S * (side * W * prof + lick);

  vU = u;
  vSide = side;
  vTint = aTint.rgb;
  vPower = vec2(aShape.y, aTint.a * mix(1.0, align * align, fin));
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

const PLUME_FRAG = /* glsl */ `
uniform float uGain;
uniform float uClip;

varying float vU;
varying float vSide;
varying float vAlign;
varying vec3 vTint;
varying vec2 vPower;

void main() {
  float edge = 1.0 - abs(vSide);
  if (edge <= 0.0) discard;

  // Two lobes across the ribbon: a narrow blown spine and a wide soft body.
  // The spine is where the gas is optically thickest, so it is both the
  // brightest and the hottest part of the ramp.
  float spine = exp(-vSide * vSide * 4.0);
  float body = pow(edge, 0.62);

  // Along the plume: a soft shoulder off the stack mouth, then a long dissolve.
  float axial = pow(max(0.0, 1.0 - vU), 1.15) * smoothstep(0.0, 0.09, vU);

  // TEMPERATURE — and this is where four rounds of "there is no flame in the
  // boost frame" were actually decided.
  //
  // The old ramp topped out at vec3(1.00, 0.94, 0.74): a colour that is already
  // 94% neutral before it is multiplied by an intensity of up to fourteen. Any
  // ramp whose hot end is near-white produces a near-white core, and once that
  // core has been through bloom the whole plume is a cream smear with no fire
  // in it. The fix is not to dim the flame, it is to make the hot end a colour.
  //
  // Three authored stops, straight off the palette in art bible section 3:
  //   C_FLAME_COOL #c4331a  deep ember, the dissolving tail
  //   C_FLAME_MID  #ff9d2e  the body — this is what the flame *is*
  //   C_FLAME_ROOT #dcefff  blue-white, and confined to a short kiss on the
  //                         spine at the stack mouth, which is the only place
  //                         combustion is genuinely that hot
  vec3 ember = vec3(0.769, 0.200, 0.102);
  vec3 mid   = vec3(1.000, 0.616, 0.180);
  vec3 root  = vec3(0.863, 0.937, 1.000);
  float temp = clamp((1.0 - vU * 1.15) * (0.28 + 0.72 * spine), 0.0, 1.0);
  vec3 rgb = mix(ember, mid, smoothstep(0.0, 0.55, temp));
  // The blue-white root. A hard, short window: gone by a tenth of the tongue.
  //
  // 0.55 over a 0.075 window, down from 0.80 over 0.11. From a chase camera the
  // plume is seen almost down its own axis, so the tongue foreshortens and the
  // ROOT is most of what reaches the screen — which means a root authored at
  // 80% blue-white makes the whole visible flame blue-white however the rest of
  // the ramp is tuned. Measured on the r13-after boost frame: the plume's mean
  // chroma came out 0.09 against a #c05cff tier the player had just earned. A
  // white-hot core is real combustion and it stays, but it has to be a CORE —
  // a pinpoint inside a coloured flame, not the flame.
  float kiss = spine * (1.0 - smoothstep(0.0, 0.075, vU));
  rgb = mix(rgb, root, kiss * 0.55);

  // The mini-turbo tier owns the sheath and the tail — everything that is not
  // the combusting spine. A mushroom boost and a tier-3 mini-turbo have to be
  // distinguishable at a glance and 0.30 of a tint on the outermost fringe was
  // not doing it.
  //
  // Nor was 0.52/0.30 capped at 0.72. Measured off the reviewed boost frame,
  // the plume's mean chroma is 0.14 — it is a cream shape with a hint of warmth
  // in it, and the mini-turbo colour that the player spent two seconds of risk
  // earning does not appear on the payoff at all. Two thirds of the sheath is
  // tier now, rising to a fully tier-coloured tail: the spine stays white-hot
  // (that is combustion and it is not negotiable), everything around it is the
  // colour of the charge that bought it.
  //
  // The 0.26 FLOOR is the part that matters. Every previous form of this line
  // was a function of (1 - spine), i.e. the tier could only appear where the
  // flame was NOT bright — so from the one camera angle the game is actually
  // played at, where the bright spine covers most of the projected tongue, the
  // mini-turbo colour was mathematically absent from the payoff. A floor puts
  // the tier into the whole flame and lets the spine and the tail deepen it.
  rgb = mix(rgb, vTint, clamp(0.26 + (1.0 - spine) * 0.50 + vU * 0.36, 0.0, 0.88));

  float a = axial * (0.42 * body + 0.74 * spine);
  // Head-on two ribbons overlap, so back the alpha off a little or the crossing
  // point reads as a solid plate rather than as gas.
  a *= mix(1.0, 0.80, vAlign);
  a *= vPower.y;
  if (a < 0.004) discard;

  vec3 outRgb = rgb * vPower.x * uGain;
  // SOFT KNEE ON THE MAX CHANNEL, NOT PER CHANNEL. Per-channel Reinhard
  // compresses the strongest channel hardest, so as the plume gets brighter its
  // channels converge and #ff9d2e arrives at the tone mapper as grey. That is
  // the mechanism behind "clips to flat pure white"; compressing the max and
  // scaling all three by the same factor is the same curve with the same
  // asymptote and leaves the hue exactly where it was authored.
  //
  // The knee is also driven by the plume's own coverage: where two ribbons and
  // their fins overlap the alpha is high, and that is precisely where the sum
  // runs away — so the shoulder tightens there and the crossing point saturates
  // to orange instead of to paper.
  float knee = uClip * (1.0 + 1.6 * a);
  float mxc = max(max(outRgb.r, outRgb.g), outRgb.b);
  outRgb *= mxc > 1e-4 ? 1.0 / (1.0 + mxc * knee) : 1.0;
  gl_FragColor = vec4(outRgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Plumes {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly data: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private count = 0;

  static readonly STRIDE = 16;

  constructor(readonly capacity: number) {
    // Two ribbons: the camera-facing tongue, and a fin crossed at ninety
    // degrees that only becomes visible when you look down the axis.
    const n = PLUME_SEGS;
    const pos = new Float32Array(2 * n * 2 * 3);
    const idx = new Uint16Array(2 * (n - 1) * 6);
    for (let r = 0; r < 2; r++) {
      const vb = r * n * 2;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const o0 = (vb + i * 2) * 3, o1 = (vb + i * 2 + 1) * 3;
        pos[o0] = -1; pos[o0 + 1] = u; pos[o0 + 2] = r;
        pos[o1] = 1; pos[o1 + 1] = u; pos[o1 + 2] = r;
      }
      const ib = r * (n - 1) * 6;
      for (let i = 0; i < n - 1; i++) {
        const a = vb + i * 2;
        idx[ib + i * 6] = a; idx[ib + i * 6 + 1] = a + 1; idx[ib + i * 6 + 2] = a + 2;
        idx[ib + i * 6 + 3] = a + 1; idx[ib + i * 6 + 4] = a + 3; idx[ib + i * 6 + 5] = a + 2;
      }
    }

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.data = new Float32Array(capacity * Plumes.STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, Plumes.STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const names = ['aOrigin', 'aAxis', 'aShape', 'aTint'];
    for (let i = 0; i < names.length; i++) {
      this.geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    }
    this.geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      // 0.13 to match the particle layer. At 0.19 the shoulder was pulling the
      // white-hot spine of the flame down to ~2.5 linear, which sits below
      // PostFX's bloom gate once the ACES shoulder has had it — a boost flame
      // that does not bloom is a painted shape, and "no flame in the boost
      // frame" has now been a review note for four rounds running.
      uniforms: { uTime: { value: 0 }, uGain: { value: 1 }, uClip: { value: 0.13 } },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'fx-plumes';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;
  }

  begin() { this.count = 0; }

  /**
   * `axis` points the way the flame grows (i.e. backwards out of the stack) and
   * need not be normalised. `seed` should be stable per stack so the flicker of
   * a given exhaust is continuous rather than re-randomised every frame.
   */
  add(origin: THREE.Vector3, axis: THREE.Vector3, length: number, radius: number,
      tint: THREE.Color, intensity: number, alpha: number, seed: number) {
    const i = this.count;
    if (i >= this.capacity) return;
    this.count = i + 1;
    const o = i * Plumes.STRIDE;
    const d = this.data;
    d[o] = origin.x; d[o + 1] = origin.y; d[o + 2] = origin.z;
    d[o + 3] = (seed * 0.6180339887) % 1;
    const il = 1 / (Math.hypot(axis.x, axis.y, axis.z) || 1);
    d[o + 4] = axis.x * il; d[o + 5] = axis.y * il; d[o + 6] = axis.z * il;
    d[o + 7] = length;
    // Decorrelate the flicker rate per stack without letting it run away: the
    // seed is an integer stack id, so fold it through the golden ratio first.
    const jitter = (seed * 0.6180339887) % 1;
    d[o + 8] = radius; d[o + 9] = intensity; d[o + 10] = 20 + 8 * jitter; d[o + 11] = 0.62;
    d[o + 12] = tint.r; d[o + 13] = tint.g; d[o + 14] = tint.b; d[o + 15] = alpha;
  }

  end(time: number, gain: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uGain.value = gain;
    this.geo.instanceCount = this.count;
    if (this.count > 0) this.buf.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Effect lights — a tiny fixed pool of point lights that bright effects can
//  claim for a frame.
// ===========================================================================
//
//  Every additive effect in this file used to be pure emission: sparks, flame
//  and boost pads glowed but lit nothing, so they floated in front of the world
//  instead of being part of it. Coloured light pooling under the tier is what
//  sells the drift read at a glance in a shipped arcade racer.
//
//  The pool is allocated ONCE and the lights stay in the scene for the lifetime
//  of the process with intensity 0 when idle. That matters: three.js keys shader
//  permutations on the light counts, so adding, removing or hiding a light
//  forces every material in the scene to recompile. A fixed count costs a few
//  ALU per lit fragment and never hitches.
//
//  Claims are re-issued every frame and ranked by importance, so the player's
//  drift always outranks a rival's and the pool degrades by dropping the least
//  important claimant rather than by flickering between them.
class EffectLights {
  private readonly lights: THREE.PointLight[] = [];
  /** importance of whatever currently owns each slot, this frame */
  private readonly score: number[] = [];
  private readonly owner: number[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.castShadow = false;
      // Never culled out of the light list: see the note above on recompiles.
      l.matrixAutoUpdate = false;
      this.lights.push(l);
      this.score.push(-1);
      this.owner.push(-1);
    }
  }

  get meshes(): THREE.PointLight[] { return this.lights; }

  begin() {
    for (let i = 0; i < this.score.length; i++) this.score[i] = -1;
  }

  /**
   * Ask for a light. `key` identifies the claimant so the same emitter keeps
   * the same slot frame to frame (a light that hops between karts strobes).
   */
  request(key: number, importance: number, p: THREE.Vector3, colour: THREE.Color,
          intensity: number, distance: number) {
    if (this.lights.length === 0 || intensity <= 0) return;
    let slot = -1;
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === key) { slot = i; break; }
    }
    if (slot < 0) {
      let worst = 0;
      for (let i = 1; i < this.score.length; i++) if (this.score[i] < this.score[worst]) worst = i;
      if (this.score[worst] >= importance) return;
      slot = worst;
    } else if (this.score[slot] >= importance) {
      return; // this claimant already placed something more important
    }
    this.owner[slot] = key;
    this.score[slot] = importance;
    const l = this.lights[slot];
    l.position.copy(p);
    l.updateMatrix();
    l.color.copy(colour);
    l.intensity = intensity;
    l.distance = distance;
  }

  /** Anything not claimed this frame goes dark (but stays in the light list). */
  end(dt: number) {
    const k = Math.min(1, dt * 18);
    for (let i = 0; i < this.lights.length; i++) {
      if (this.score[i] < 0) {
        const l = this.lights[i];
        if (l.intensity > 0.001) l.intensity -= l.intensity * k;
        else { l.intensity = 0; this.owner[i] = -1; }
      }
    }
  }

  dispose() { for (const l of this.lights) l.removeFromParent(); }
}

// ===========================================================================
//  Per-kart effect state
// ===========================================================================

class KartFx {
  sparkAcc = 0;
  smokeAcc = 0;
  dustAcc = 0;
  flameAcc = 0;
  sparkleAcc = 0;
  exhaustAcc = 0;
  scorchAcc = 0;
  poolAcc = 0;
  /** tier-2+ rising ember jet */
  jetAcc = 0;
  /** grit torn off the contact patch while sliding */
  gritAcc = 0;
  /** tier-3 ground pulse; counts beats, not particles */
  beatAcc = 0;
  rollAcc = 0;
  padAcc = 0;
  starAcc = 0;
  trail = -1;
  lastTier = 0;
  /** seconds left of the ignition flash, drives the boost light's overshoot */
  igniteT = 0;
  /** seconds left of the drift-tier promotion flash */
  tierFlash = 0;
  /** what `tierFlash` was set to, so the flash can be normalised per tier */
  tierFlashLen = 0.22;
  /**
   * The mini-turbo tier the CURRENT boost was cashed from, latched on the
   * `boost` event and held until it expires.
   *
   * `Kart.releaseDrift` applies the boost and then zeroes `driftTier` in the
   * same call, so every consumer that read `k.driftTier` during a boost — the
   * plume tint, the ribbon colour, the boost lamp — saw 0, fell back to
   * `|| 1`, and painted the flame BLUE. A tier-3 mini-turbo, the hardest thing
   * in the game to earn, cashed out looking exactly like a mushroom. That is
   * the payoff half of the loop being invisible, and it was a one-line bug.
   */
  boostTier = 1;
  wasBoosting = false;
  stunPhase = 0;
  /** squash-and-stretch: signed impulse plus its velocity, a critically-ish
   *  damped spring so the chassis rebounds instead of snapping back */
  squash = 0;
  squashV = 0;
  squashOwned = false;
  resolved = false;
  /** exhaust-tip anchors from the kart model, resolved once by name */
  stacksResolved = false;
  readonly stackNode: (THREE.Object3D | null)[] = [null, null];
  /** seconds of boost rush streaks still owed, so the effect outlives one frame */
  rushAcc = 0;
  readonly offL = new THREE.Vector3(-0.62, 0, -0.80);
  readonly offR = new THREE.Vector3(0.62, 0, -0.80);
  readonly skidL = new THREE.Vector3();
  readonly skidR = new THREE.Vector3();
  skidding = false;
  skidStrength = 0;
  groundY = 0;
  readonly groundN = new THREE.Vector3(0, 1, 0);
  surface: Surface = Surface.Road;
}

// ===========================================================================
//  Effects
// ===========================================================================

export class Effects implements System {
  private ctx!: Ctx;
  private group = new THREE.Group();
  private particles!: Particles;
  private trails!: Trails;
  private decals!: Decals;
  private rings!: Rings;
  private motes: Motes | null = null;
  private gulls: Gulls | null = null;
  private shimmer: Shimmer | null = null;
  private plumes!: Plumes;
  private lights!: EffectLights;
  private unsubscribe: (() => void) | null = null;

  private fx: KartFx[] = [];
  private gain = 1;
  /** particle density asked for by the quality tier, before the governor */
  private baseDensity = 1;
  /**
   * ADAPTIVE LOAD, 0.3..1. Multiplies both `particles.density` and every
   * continuous emission rate in this file.
   *
   * A quality tier is a guess made at boot from a renderer string. A phone
   * thermally throttling in lap two, or a pack fight arriving in the tunnel,
   * is not something a boot-time guess can know about, and the particle layer
   * is the right thing to give up first: it is the largest variable cost in the
   * frame and the least missed, because a shower with two thirds of its grains
   * still reads as a shower while a frame that arrives 40 ms late reads as a
   * black flash. Falls fast (half a second to the floor) and recovers slowly
   * (eight seconds back to full) so it cannot oscillate on a corner.
   */
  private loadScale = 1;
  private smoothDt = 1 / 60;
  private blastLoad = 0;
  private shimmerAmount = 0;
  private shimmerTimer = 0;
  private readonly shimmerPos = new THREE.Vector3();
  private readonly sprays: THREE.Vector3[] = [];
  private sprayAcc = 0;
  private lastState: RaceState = RaceState.Menu;

  private readonly sunColor = new THREE.Color(0xffd9a8);
  private readonly skyColor = new THREE.Color(0xa8c8ff);
  private readonly bounceColor = new THREE.Color(0xc98f5a);

  init(ctx: Ctx) {
    this.ctx = ctx;
    const q = ctx.settings.quality;
    const mobile = q <= Quality.Medium;
    // DENSITY IS A TIER, NOT A TRIM — but the tier is not bought here alone.
    //
    // The presets ask for 0.35 / 0.6 / 1.0 / 1.4. Raising the sub-1 end to the
    // power 1.5 takes Medium to 0.46 and Low to 0.21 while leaving High and
    // Ultra exactly where the art direction put them. That is deliberately not
    // the whole of "far fewer on a phone": the rest — and most of it — comes
    // from the distance curve in `lodOf`, which thins the SEVEN RIVALS hard and
    // leaves the player's own kart at full rate. Cutting the field is nearly
    // free because a rival at 40 m on a 390-pixel-tall screen is two dozen
    // pixels; cutting the player's own drift shower by the same factor would be
    // fixing mobile by making the game worse, which is the one thing the
    // readability layer must not do.
    const p = ctx.settings.particleDensity;
    const dens = q >= Quality.High ? p : p * Math.sqrt(p);
    this.baseDensity = dens;
    this.emitScale = dens;
    this.mobileLod = mobile;

    const addCap = Math.round(THREE.MathUtils.clamp(3400 * dens, 1200, 4200));
    const alphaCap = Math.round(THREE.MathUtils.clamp(2400 * dens, 850, 3000));
    // 128-pixel tiles on mobile: a quarter of the atlas memory, a quarter of the
    // boot cost to synthesise it, and no visible difference on sprites that are
    // soft by construction and never drawn much above 100 px.
    this.particles = new Particles(addCap, alphaCap, mobile ? 128 : 256);
    this.particles.density = dens;
    this.particles.setLighting(ctx.sunDirection, this.sunColor, this.skyColor, this.bounceColor);
    this.particles.resize(ctx.width, ctx.height);

    this.trails = new Trails(16, true);
    // Quality-scaled, and it matters more than it looks: every quad in this ring
    // is a blended, texture-fetching fragment lying flat on the road, so the
    // capacity is a direct multiplier on mobile fill rate in the worst case
    // (the frame on which the live window straddles the ring's wrap).
    this.decals = new Decals(
      q <= Quality.Low ? 600 : q <= Quality.Medium ? 1200 : q <= Quality.High ? 2400 : 3200,
      mobile ? 128 : 256);
    // 96 segments: the shockwave is now a 5%-thick annulus out at 7 m, and at
    // 64 segments a band that thin is visibly a chain of straight quads.
    // 40, up from 28. The tier-3 drift pulse spawns a ring 6.5 times a second
    // per kart holding purple, and three staggered fronts go up on every boost
    // ignition; at 28 a pack fight could evict a boost shockwave before it had
    // finished expanding. A dead instance costs one early-out vertex shader
    // invocation and no fill, and the whole pool is still a single draw.
    this.rings = new Rings(40, 96);
    // Two stacks per kart across the whole field.
    this.plumes = new Plumes(RACER_COUNT * 2);

    this.rings.resize(ctx.width, ctx.height);

    // 3 / 2 / 0 by quality. Three is enough for the player's drift or boost
    // plus the two nearest rivals, which is every case the pack shot has.
    this.lights = new EffectLights(q >= Quality.High ? 3 : q >= Quality.Medium ? 2 : 0);

    this.group.add(
      this.particles.group, this.trails.mesh, this.decals.mesh,
      this.rings.mesh, this.plumes.mesh, ...this.lights.meshes,
    );

    if (q >= Quality.Medium) {
      // Motes are pure additive overdraw spread across the near field, which is
      // the one thing a mobile GPU is worst at. The floor drops to 90 so the
      // squared Medium density actually reaches it — the haze in the light
      // shafts survives, at a quarter of the fill.
      this.motes = new Motes(Math.round(THREE.MathUtils.clamp(760 * dens, 90, 1200)), 26, 24);
      this.group.add(this.motes.mesh);
      this.shimmer = new Shimmer();
      this.group.add(this.shimmer.mesh);
    }
    if (q >= Quality.Medium && ctx.track) {
      const s = ctx.track.sample(0.16);
      this.gulls = new Gulls(q >= Quality.High ? 18 : 10, s.pos);
      this.group.add(this.gulls.mesh);
      this.findSpraySites(ctx);
    }

    this.group.matrixAutoUpdate = false;
    // Named so tools/perf.mjs can attribute this subtree. It was anonymous, and
    // `perf-report.mjs` classifies on the name, so six of the eight FX meshes
    // (rings, plumes, motes, gulls, shimmer, trails) were being filed under
    // `other:Group` and the FX row read 3 draws when it was really 9.
    this.group.name = 'fx';
    ctx.scene.add(this.group);

    this.unsubscribe = ctx.bus.on(this.onEvent);
    this.hookContextLoss(ctx);

    // Debug handle, in the same family as `__camRig`, `__drawBudget` and
    // `__frameWatch`. Read-only in practice; the one field a harness writes is
    // `pinDensity` (see `updateLoad`).
    if (typeof window !== 'undefined') (window as { __fx?: Effects }).__fx = this;
  }

  /**
   * WEBGL CONTEXT LOSS.
   *
   * A phone that is running out of memory does not always kill the tab: often
   * enough it takes the GL context away first, and a page with no
   * `webglcontextlost` handler answers that by rendering nothing at all — a
   * black frame that never comes back. That is a plausible reading of "still
   * black partial renders at times", and until this round there was not a
   * single listener in the codebase.
   *
   * Owning the renderer's recovery is not this file's job (see Renderer.ts) but
   * owning OUR OWN is. Both particle rings, the decal ring and the two
   * procedural atlases keep their CPU copies for the life of the process, so a
   * restored context needs nothing rebuilt — only telling that everything it
   * holds is stale. Calling `preventDefault` on the loss event is what allows
   * the browser to fire `webglcontextrestored` at all; without it the context
   * is gone for good, which is the difference between a stutter and a dead tab.
   */
  private hookContextLoss(ctx: Ctx) {
    const canvas = ctx.renderer?.domElement;
    if (!canvas) return;
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  private canvas: HTMLCanvasElement | null = null;

  private onContextLost = (e: Event) => {
    // Without this the browser never attempts a restore.
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = () => {
    this.contextLost = false;
    this.particles?.invalidateGL();
    this.decals?.invalidate();
    // Whatever was in flight belonged to a context that no longer exists.
    this.decals?.clear();
    for (const f of this.fx) {
      if (!f) continue;
      if (f.trail >= 0) this.trails?.release(f.trail);
      f.trail = -1;
      f.skidding = false;
    }
  };

  private contextLost = false;

  /**
   * Sea spray only makes sense where the road is actually above the water, so
   * the sites are derived from the track's own elevation rather than guessed.
   */
  private findSpraySites(ctx: Ctx) {
    for (let t = 0.30; t < 0.60 && this.sprays.length < 8; t += 0.012) {
      const s = ctx.track.sample(t);
      if (s.pos.y < 9) continue;
      const v = new THREE.Vector3()
        .copy(s.pos)
        .addScaledVector(s.binormal, s.halfWidth + 14 + Math.random() * 10);
      v.y = 0.4;
      this.sprays.push(v);
      t += 0.02;
    }
  }

  resize(w: number, h: number) {
    this.particles?.resize(w, h);
    this.rings?.resize(w, h);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onEvent = (e: GameEvent) => {
    const ctx = this.ctx;
    if (!ctx) return;
    // Same rule as `update`: nothing emitted while the context is gone can ever
    // reach a screen. `update` and `lateUpdate` already bail, which means
    // `flush` is not running either — so without this the bus kept walking the
    // ring write heads and inflating `frameWrote` for the whole outage, and the
    // first frame back paid for every spawn made during it on top of the full
    // re-upload the restore already owes.
    if (this.contextLost) return;
    const now = ctx.time;
    // Events are raised during the gameplay update, which runs before ours;
    // re-stamp so a burst is born now rather than at last frame's flush.
    this.particles.setTime(now);

    switch (e.type) {
      case 'drift-spark': {
        // Tier promotion: the single most important read in the whole game.
        const fx = this.state(e.kart);
        const tier = Math.min(3, Math.max(1, e.tier));
        const col = C_TIER[tier];
        this.rearPoints(e.kart, fx);

        // THE PROMOTION RECOLOURS THE SHOWER IN FLIGHT. No purge.
        //
        // What used to be here was `retireRecent(true, 700, 0.06)` — kill the
        // newest 700 additive slots so the outgoing tier could not be on screen
        // beside the incoming one. It never worked and it could not have: a
        // tier-1 drift spawns roughly 1400 additive particles a second, the
        // long-lived ricochets outlive any window worth calling "recent", and
        // the shot harness fires its shutter on the *frame* the tier flips —
        // which is why the reviewed tier-2 frame is a screen full of tier-1
        // blue with an orange HUD arc over it. Killing more of them harder only
        // trades a wrong colour for a hole in the shower.
        //
        // Drift particles now carry a colour CHANNEL rather than a colour (see
        // EmitParams.channel). Pointing this kart's channel at the new tier
        // repaints every grain already in the air, this frame, for the cost of
        // three floats.
        this.particles.setChannelColor(e.kart.id + 1, col);

        const prof = TIER_FX[tier];
        fx.tierFlashLen = prof.flash;
        fx.tierFlash = prof.flash;
        // 48/96/168 rather than 72/92/112. A promotion has to be an EVENT, and
        // three events that differ by 20 grains are three of the same event.
        // The count triples across the escalation, and so does the shake, the
        // ring, the scorch and the lamp punch below — every channel moves
        // together, which is what the eye reads as "something bigger just
        // happened" rather than "something happened again".
        const n = Math.round(24 * tier * tier);
        const boost = 1.35 + tier * 0.22;
        this.burstSparks(this.skidLRef, n, boost, e.kart.id + 1, fx, e.kart);
        this.burstSparks(this.skidRRef, n, boost, e.kart.id + 1, fx, e.kart);

        // THE PROMOTION SHOCKWAVE.
        //
        // The ban this file keeps is on rigid additive geometry *near the
        // chassis*, and it is a ban on shapes the camera sees face-on. A ring
        // lying in the road plane, seen from a rig two metres up, is an ellipse
        // with no enclosed area that races past the lens in a quarter of a
        // second — the same object boost ignition already uses, and the reason
        // that ignition reads as an event while the drift promotion did not.
        // Tier 1 gets a small one, tier 3 gets one twice the radius and nearly
        // twice as bright, so the escalation is legible from the ring alone.
        _q.copy(e.kart.position); _q.y = fx.groundY + 0.26;
        this.rings.spawn(_q, fx.groundN, 0.6, 2.6 + 2.0 * tier, 0.22 + 0.04 * tier,
          0.06, col, 0.75 + 0.42 * tier, now, e.kart.velocity, 1.6);

        // NO ANNULUS. A 1.7 m-radius vertical torus spawned inside the chassis
        // is geometrically *inside* the kart for its whole life: it cuts through
        // the rear wheels, exits the far side of the bodywork and reads as a
        // plastic hoop welded to the car. The comment this replaces warned that
        // a ground-plane ring reads as a dropped hula hoop and then shipped the
        // same object rotated ninety degrees. Per the art bible §6 the drift
        // signature is *emitted sparks plus a soft ground glow* — no ring at
        // all. Rings are kept for boost ignition and impacts, where they are
        // punched clear of the body along the direction of travel.
        //
        // The flash is a ground-projected radial pool instead: it has area, no
        // silhouette of its own, cannot intersect anything, and it puts the tier
        // colour on the tarmac where the sparks are actually landing.
        _q.copy(e.kart.position); _q.y = fx.groundY + 0.05;
        const p = this.particles.reset();
        p.tile = PTile.Glow; p.mode = PMode.Ground;
        p.life = 0.34; p.lifeJitter = 0.1;
        // 3.4 m, not 6.2. At six metres the flash was wider than the road and
        // it landed as a flat coloured stain over the kerb rather than as light
        // thrown by the sparks.
        p.size0 = 1.4; p.size1 = 2.6 + 0.9 * tier; p.sizeJitter = 0.1;
        // Carries the kart's velocity, otherwise a 0.4 s flash on a kart doing
        // 25 m/s is stranded eight metres back down the road by the time it
        // fades.
        // ROUND 14. `fadeIn` was 0.05 s — three frames at 60 Hz to reach full
        // value. The HUD punch was separately measured arriving two to five
        // frames after the same trigger, and a promotion whose three channels
        // peak on three different frames is the "mush rather than an event"
        // failure however loud each channel is on its own. Every cue on this
        // event now peaks on the frame it is raised; a single frame of fade is
        // still enough to keep a 3.4 m ground disc from popping in hard.
        p.fadeIn = 0.016; p.drag = 0.6; p.count = 1; p.camBias = 0.08;
        this.particles.at(_q.x, _q.y, _q.z);
        this.particles.vel(e.kart.velocity.x, 0, e.kart.velocity.z);
        this.particles.colorA(col, 1.05 + 0.42 * tier, 0.78);
        this.particles.colorB(col, 0.28, 0);
        this.particles.emit(true);

        // A tight hot kiss under each rear wheel on top of the wide pool, so
        // the promotion has a point of origin rather than a vague wash.
        p.life = 0.24; p.size0 = 0.5; p.size1 = 1.5; p.count = 1;
        for (let s = 0; s < 2; s++) {
          const at = s === 0 ? this.skidLRef : this.skidRRef;
          this.particles.at(at.x, fx.groundY + 0.06, at.z);
          this.particles.colorA(C_HOT, 1.5, 0.85);
          this.particles.colorB(col, 0.45, 0);
          this.particles.emit(true);
        }

        // A billboard flare on the tier colour, at rear-axle height and just
        // clear of the bodywork on each side. The pool puts the promotion on
        // the ROAD; this puts it in the AIR, where the chase camera is actually
        // looking, and it is the layer that makes a tier-2 change readable in a
        // thumbnail. Still a particle, still no silhouette — the file's ban on
        // rigid additive geometry near the chassis stands.
        _fwd.copy(e.kart.forward);
        _side.crossVectors(UP, _fwd).normalize();
        p.mode = PMode.Billboard; p.tile = PTile.Glow;
        p.life = 0.26 + 0.05 * tier; p.lifeJitter = 0.2;
        p.size0 = 0.45 + 0.30 * tier; p.size1 = 1.7 + 0.95 * tier; p.sizeJitter = 0.2;
        // Same-frame attack as the pool and the sparks above. See there.
        p.drag = 4.5; p.gravity = 1.2; p.count = 1; p.fadeIn = 0.012;
        // Two metres of camera-facing disc 42 cm off the deck: it needs a real
        // soft fade and a real bias, or the road slices it in half.
        this.particles.ground(fx.groundY, fx.groundN, 0.55, 0.45);
        for (let s = 0; s < 2; s++) {
          _r.copy(e.kart.position)
            .addScaledVector(_fwd, -0.95)
            .addScaledVector(_side, s === 0 ? -0.72 : 0.72);
          _r.y = fx.groundY + 0.42;
          this.particles.at(_r.x, _r.y, _r.z);
          this.particles.vel(e.kart.velocity.x * 0.9, 1.4, e.kart.velocity.z * 0.9);
          this.particles.colorA(col, 1.30 + 0.30 * tier, 0.60);
          this.particles.colorB(col, 0.30, 0);
          this.particles.emit(true);
        }

        // Scorch under the burst, so the tier change leaves a mark on the road.
        // A real eroded Scorch disc rather than the small Smudge kiss, and
        // keyed to the tier colour — a promotion is the loudest moment of the
        // drift and it should be the one that burns the tarmac.
        this.decals.scorch(_q, fx.groundN, 0.85 + 0.28 * tier, col, now, 8, 0.45 + 0.10 * tier);
        if (e.kart.isPlayer) ctx.shake(0.05 + 0.045 * tier * tier * 0.5, 0.14);
        break;
      }

      case 'boost':
        this.boostFlash(e.kart, e.tier, now);
        break;

      case 'hop': {
        const fx = this.state(e.kart);
        this.groundPuff(e.kart, fx, 6, 0.5);
        break;
      }

      case 'land': {
        const fx = this.state(e.kart);
        const k = THREE.MathUtils.clamp(e.impact, 0, 1);
        if (k < 0.06) break;
        this.groundPuff(e.kart, fx, 6 + 22 * k, 0.6 + 1.1 * k);
        _p.copy(e.kart.position); _p.y = fx.groundY + 0.08;
        this.rings.spawn(_p, fx.groundN, 0.3, 2.0 + 3.4 * k, 0.34, 0.08, C_SMOKE, 0.30 + 0.3 * k, now);
        this.addSquash(e.kart, -0.30 * k - 0.08);
        if (e.kart.isPlayer) ctx.shake(0.10 + 0.5 * k, 0.2);
        break;
      }

      case 'collide': {
        const k = THREE.MathUtils.clamp(e.impulse / 14, 0, 1);
        if (k < 0.08) break;
        const cfx = this.state(e.kart);
        _p.copy(e.kart.position); _p.y += 0.4;
        const p = this.particles.reset();
        p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 2.4;
        p.life = 0.26; p.lifeJitter = 0.4;
        p.size0 = 0.075 + 0.05 * k; p.size1 = 0.012;
        p.gravity = -12; p.drag = 1.6; p.velJitter = 4 + 7 * k;
        p.count = Math.round(14 + 34 * k);
        this.particles.ground(cfx.groundY, cfx.groundN, 0.28, 0.10);
        this.particles.at(_p.x, _p.y, _p.z);
        this.particles.vel(0, 1.5, 0);
        this.particles.colorA(C_SPARK_WHITE, 2.4, 1);
        this.particles.colorB(C_FLAME_MID, 0.7, 0);
        this.particles.emit(true);
        this.addSquash(e.kart, -0.22 * k - 0.06);
        if (e.kart.isPlayer) ctx.shake(0.18 + 0.55 * k, 0.24);
        break;
      }

      case 'item-pickup':
        this.sparkleBurst(e.kart.position, e.kart.stats.color, 18);
        break;

      case 'coin':
        this.sparkleBurst(e.kart.position, C_GOLD, 12);
        break;

      case 'item-use':
        if (e.kind === ItemKind.Star) {
          _p.copy(e.kart.position); _p.y = this.state(e.kart).groundY + 0.35;
          this.rings.spawn(_p, UP, 0.6, 6.0, 0.34, 0.06, C_GOLD, 1.3, now,
            e.kart.velocity, 1.6);
          this.sparkleBurst(e.kart.position, C_GOLD, 30);
        } else if (e.kind === ItemKind.Mushroom || e.kind === ItemKind.TripleMushroom) {
          this.boostFlash(e.kart, 1, now);
        }
        break;

      case 'hit': {
        const fx = this.state(e.kart);
        this.addSquash(e.kart, e.kind === ItemKind.Bolt ? -0.55 : -0.35);
        if (e.kind === ItemKind.Bomb) {
          _p.copy(e.kart.position); _p.y += 0.5;
          this.explode(_p, fx.groundN, fx.groundY, 1, now);
        } else {
          _p.copy(e.kart.position); _p.y += 0.55;
          this.impactBurst(_p, fx.groundN, now, e.kind === ItemKind.Banana ? 0.55 : 1);
          if (e.kart.isPlayer) this.ctx.shake(0.45, 0.32);
        }
        break;
      }

      case 'lap':
        if (e.kart.isPlayer) {
          _p.copy(e.kart.position); _p.y = this.state(e.kart).groundY + 0.35;
          this.rings.spawn(_p, UP, 0.8, 7.5, 0.40, 0.06, C_GOLD, 1.0, now,
            e.kart.velocity, 1.6);
          this.sparkleBurst(e.kart.position, C_GOLD, 22);
        }
        break;

      case 'finish':
        if (e.kart.isPlayer) this.confetti(e.kart.position);
        break;

      default:
        break;
    }
  };

  /** Boost ignition: a shockwave, an exhaust bloom and a tyre chirp. */
  private boostFlash(k: IKart, tier: number, now: number) {
    const fx = this.state(k);
    const bt = Math.min(3, Math.max(1, tier));
    // Latch the tier for the WHOLE boost. Kart.releaseDrift zeroes driftTier in
    // the same call that applies the boost, so anything reading it downstream
    // sees 0 and falls back to blue. See KartFx.boostTier.
    fx.boostTier = Math.max(fx.boostTier, bt);
    // ONE IGNITION PER IGNITION. A mushroom raises both `item-use` and `boost`
    // on the same frame, so this used to run twice and lay two of everything on
    // exactly the same pixels — which was survivable when the ignition was two
    // dim rings and is not now that it is three fronts, a debris spray and a
    // lens spike. The window is a fifth of the ignition's own life, so a genuine
    // second boost (a pad taken during a mini-turbo) still reads as one.
    if (fx.igniteT > 0.24) return;
    const col = C_TIER[bt];
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();

    // THE SHOCKWAVE.
    //
    // It used to be two annuli whose normal was the direction of travel. From a
    // chase camera that is *face on*: you see the full circle, and a circle
    // 4 metres across sitting in the middle of the frame with a saturated
    // primary in it is a dinner plate, whatever its alpha profile says. The
    // shape was never the problem — the viewing angle was.
    //
    // A ring in the plane of the road, seen from a rig 2 m up and 6 m back, is
    // foreshortened to a hard ellipse: nearly edge-on, no enclosed area, and it
    // races outward past the lens in a third of a second. Thin (5% of radius),
    // dim, fast, gone. Two of them, staggered, so it reads as a wave front
    // rather than a hoop.
    // Held 30-50 cm off the tarmac, not laid on it: a 7 m disc pinned to the
    // local tangent plane sinks through a crest or a 20-degree bank and the
    // depth test then chops it into hard arcs.
    //
    // THREE staggered fronts now, not two, and the third is the one that makes
    // the release read as an EVENT rather than as a state change: a wide, fast,
    // very thin ring that overtakes the camera. The player's eye is inside it
    // for two frames. That is the entire trick behind a boost that "hits" in a
    // shipped arcade racer, and it costs one instanced draw the pool already
    // pays for.
    _q.copy(k.position); _q.y = fx.groundY + 0.30;
    this.rings.spawn(_q, fx.groundN, 0.9, 7.5 + 2.2 * bt, 0.34, 0.055,
      col, 1.55 + 0.45 * bt, now, k.velocity, 1.6);
    _q.y = fx.groundY + 0.52;
    this.rings.spawn(_q, fx.groundN, 0.5, 4.8, 0.24, 0.075, C_HOT, 1.25, now, k.velocity, 1.6);
    // The overtaking front: 14 m in a fifth of a second, 3.5% thick, on the
    // tier colour, held high enough to sweep the lens rather than the tarmac.
    // This is the ring the player's eye ends up INSIDE, so it is the one that
    // most has to differ between a blue and a purple cash-out: 15.5 m against
    // 11.5 m, and half again the intensity.
    _q.y = fx.groundY + 1.05;
    this.rings.spawn(_q, fx.groundN, 2.2, 9.5 + 2.0 * bt, 0.20, 0.035,
      col, 0.95 + 0.42 * bt, now, k.velocity, 1.2);

    // Ignition bloom at the stacks: a short violent scatter of hot gas that
    // seeds the ribbon before it has grown to length.
    for (let s = 0; s < 2; s++) {
      this.stackMouth(k, s, _p);
      const p = this.particles.reset();
      p.tile = PTile.Glow; p.mode = PMode.Billboard;
      p.life = 0.20; p.lifeJitter = 0.35;
      p.size0 = 0.34; p.size1 = 0.10; p.sizeJitter = 0.35;
      p.drag = 6; p.gravity = 2.2; p.velJitter = 2.2; p.posJitter = 0.08;
      // 5 at 1.9x, down from 7 at 2.6x. This lands on the same pixels as the
      // plume, the ribbon, the root kiss and the boost lamp, all within the
      // 0.3 s the ignition overshoot is also multiplying everything else.
      //
      // ROUND 14 — THE RELEASE HAS TO ESCALATE, BECAUSE THE PROMOTION DOES.
      // Counted off the authored constants, a tier-3 PROMOTION spawns nine
      // times the sparks of a tier-1 promotion, throws a ring twice the radius
      // and shakes the camera five times as hard. The RELEASE — the thing the
      // whole ladder exists to buy — scaled by 1.1 per tier on a couple of
      // radii and by nothing at all on every particle count: a purple mini
      // turbo cashed out about 25% louder than a blue one. That is the wrong
      // way round. The counts below now grow with the tier so that cashing a
      // tier 3 is visibly the biggest thing that happens in a lap.
      p.fadeIn = 0.04; p.count = 5 + 3 * bt;
      this.particles.ground(fx.groundY, fx.groundN, 0.5, 0.2);
      this.particles.at(_p.x, _p.y, _p.z);
      // Carries most of the kart's velocity so the burst stays with the car
      // instead of being stranded on the tarmac (see boostPlume for why).
      this.particles.vel(
        k.velocity.x * 0.88 - _fwd.x * 3.0 + _side.x * (s === 0 ? -1.6 : 1.6),
        k.velocity.y * 0.88 + 2.2,
        k.velocity.z * 0.88 - _fwd.z * 3.0 + _side.z * (s === 0 ? -1.6 : 1.6));
      this.particles.colorA(C_FLAME_ROOT, 2.2, 0.85);
      this.particles.colorB(C_FLAME_MID, 0.6, 0);
      this.particles.emit(true);

      // A hard spray of hot debris thrown backwards out of each stack. Cores,
      // stretched, short-lived: this is the layer that reads as the exhaust
      // spitting on ignition, and it survives motion blur because it is
      // travelling with the streak rather than across it.
      p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 5.0;
      p.life = 0.26; p.lifeJitter = 0.5;
      p.size0 = 0.10; p.size1 = 0.014; p.sizeJitter = 0.55;
      p.gravity = -7; p.drag = 1.2; p.velJitter = 3.4; p.posJitter = 0.06;
      p.count = 5 + 5 * bt;
      this.particles.ground(fx.groundY, fx.groundN, 0, 0.14);
      this.particles.vel(
        k.velocity.x * 0.70 - _fwd.x * 9.0 + _side.x * (s === 0 ? -2.4 : 2.4),
        k.velocity.y * 0.70 + 2.6,
        k.velocity.z * 0.70 - _fwd.z * 9.0 + _side.z * (s === 0 ? -2.4 : 2.4));
      this.particles.colorA(C_HOT, 2.5, 1);
      this.particles.colorB(col, 0.85, 0);
      this.particles.emit(true);
    }

    // Ground flash under the ignition — the thing that makes the boost read as
    // an event that happened *on the road* rather than a sprite over it.
    // Halved in radius and brightness from round 3: at 6.5 m and 1.6x a
    // saturated primary this alone was a coloured stain wider than the road.
    const g = this.particles.reset();
    g.tile = PTile.Glow; g.mode = PMode.Ground;
    g.life = 0.28; g.size0 = 1.4; g.size1 = 3.6 + 0.5 * bt; g.sizeJitter = 0.1;
    // Same-frame attack: the ignition is one event and every channel of it has
    // to be at value on the frame the boost is applied. See the drift-spark
    // case for the measurement.
    g.drag = 0.7; g.count = 1; g.camBias = 0.08; g.fadeIn = 0.018;
    this.particles.at(k.position.x, fx.groundY + 0.05, k.position.z);
    this.particles.vel(k.velocity.x, 0, k.velocity.z);
    this.particles.colorA(col, 0.9 + 0.16 * bt, 0.6);
    this.particles.colorB(col, 0.2, 0);
    this.particles.emit(true);

    fx.igniteT = 0.30;
    // THE IGNITION IMPULSE — the half of "the release must be an EVENT" that
    // lives in the LENS rather than in the world.
    //
    // Everything above is a particle or a ring, and every one of them is
    // behind or beside the kart. The screen-space half of the payoff (radial
    // smear, speed lines, chromatic ramp, FOV) was driven purely off
    // `boostTime > 0`, which is a STEP: it goes from nothing to a sustained
    // value and holds it. A step is a state, not an event, and the eye reads
    // the onset of a cue, not its plateau — which is most of why the boost is
    // reported as "barely visible" despite every term being present in the
    // frame. This is a spike on top of the plateau, decaying over ~0.35 s, and
    // it is what makes the first three frames of a boost different from the
    // twentieth. See `updateSignals`.
    // 0.70 / 0.95 / 1.20 rather than 0.70 / 0.85 / 1.00. This is the term that
    // owns the FOV punch and the radial smear, i.e. the half of the payoff that
    // is felt rather than seen, and it is the cheapest place to make a purple
    // release outrank a blue one. `speedIntensity` is clamped downstream; the
    // FOV punch is not, and 1.20 buys about 4.1 degrees against 2.4.
    if (k.isPlayer) this.igniteImpulse = Math.max(this.igniteImpulse, 0.45 + 0.25 * bt);
    // 6 puffs at 1.15, down from 8 at 1.4. Mini-turbo ignition is corner exit —
    // the moment the chase camera is closest to the rear axle and pointing
    // along it — and sixteen 2.1 m puffs arriving at once two metres from the
    // lens is the other half of "the boost effect deletes the subject".
    // NOT escalated by tier, deliberately. Everything else on this event is
    // behind or beside the kart; this is the one layer that lands between the
    // chase lens and the subject, and the note above records that it was cut
    // from 8 at 1.4x to 6 at 1.15x precisely because it was deleting the car it
    // was supposed to be celebrating. A louder tier 3 must not buy that back.
    this.tyreSmokePuff(k, fx, 6, 1.15);
    // 0.20 + 0.07 was a 1.35x spread across the whole ladder. The promotion's
    // own shake spreads 5x across the same three tiers, so the release used to
    // feel SMALLER than the promotion that preceded it by a second.
    if (k.isPlayer) this.ctx.shake(0.16 + 0.13 * bt, 0.24);
    this.blastLoad = Math.max(this.blastLoad, 0.5);
  }

  /**
   * Boost-ignition spike, 0..1, decaying. Owned here because the release is a
   * single moment shared by every screen-space cue; see `boostFlash`.
   * Player-only in effect: `updateSignals` is the only reader and it only ever
   * looks at the player.
   */
  private igniteImpulse = 0;

  // -------------------------------------------------------------------------
  // Public API for other systems (projectiles have no transform in the shared
  // contract, so items/AI can drive these directly if they want trails/blasts)
  // -------------------------------------------------------------------------

  /** Attach a ribbon trail. Returns a handle, or -1 if the pool is full. */
  attachTrail(color: THREE.Color, intensity = 1.4, width = 0.5, maxLen = 7): number {
    return this.trails.acquire(width, color, intensity, 0.85, 0.28, 0.3, maxLen);
  }
  moveTrail(h: number, p: THREE.Vector3) { this.trails.push(h, p.x, p.y, p.z); }
  detachTrail(h: number) { this.trails.release(h); }

  /**
   * Soft contact shadow under a dropped pickup, so items read as sitting on the
   * road rather than pasted over it. Cheap: one decal quad. Items own their
   * own transforms, so they must call this — re-lay it when the item moves, or
   * once with a long `life` for something that has settled.
   */
  blobShadow(p: THREE.Vector3, normal: THREE.Vector3, radius = 0.42, life = 1e6) {
    this.decals.blot(p, normal, radius, DecalTile.Smudge, this.ctx.time, life, 0.55,
      0.05, 0.045, 0.05);
  }

  /** Full explosion at a world point: fireball, smoke, debris, scorch, shake. */
  explodeAt(p: THREE.Vector3, normal: THREE.Vector3, groundY: number, scale = 1) {
    this.explode(p, normal, groundY, scale, this.ctx.time);
  }

  /**
   * Hand the smoke layer a scene depth texture to enable true soft particles.
   * Optional: without one we fall back to the analytic ground-plane fade, which
   * already removes the hard intersection line against the road. Pass null to
   * turn the depth comparison back off (e.g. when the target is recreated).
   *
   * The pipeline can also simply publish `depthTexture` on the shared context
   * and we will pick it up automatically each frame.
   */
  setDepthTexture(tex: THREE.Texture | null, near: number, far: number) {
    this.lastDepth = tex;
    this.particles.setDepthTexture(tex, near, far);
    this.rings.setDepthTexture(tex, near, far);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: Ctx, dt: number) {
    // Nothing this file produces can reach a screen while the context is gone,
    // and emitting into a ring whose GPU mirror does not exist only guarantees
    // that the restore frame has a full buffer's worth of upload to do.
    if (this.contextLost) return;
    const race = ctx.race;
    const karts = race?.karts;
    const now = ctx.time;
    // Everything emitted this frame is born now, not at last frame's flush.
    this.particles.setTime(now);

    if (race && race.state !== this.lastState) {
      // A fresh countdown means a fresh track surface.
      if (race.state === RaceState.Countdown) this.decals.clear();
      this.lastState = race.state;
    }

    this.updateLoad(dt);
    this.updateGain(ctx, dt);
    // Smoke and dust must live in whatever light the sky system is actually
    // producing — including going flat and cool inside the tunnel — so track
    // the key light rather than baking the golden-hour values in.
    if (ctx.sun) {
      this.sunColor.copy(ctx.sun.color).multiplyScalar(Math.min(1.2, ctx.sun.intensity * 0.26));
    }
    this.particles.setLighting(ctx.sunDirection, this.sunColor, this.skyColor, this.bounceColor);

    // Off-screen rivals are thinned on the mobile tiers; see `offScreenScale`.
    // Built once per frame from the camera the chase rig posed last frame,
    // which is a frame stale and irrelevant at the twelve metres of padding the
    // test carries.
    if (this.mobileLod) {
      ctx.camera.updateMatrixWorld();
      _viewProj.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_viewProj);
    }

    this.lights.begin();
    if (karts) {
      // THE PLAYER SPENDS THE FRAME'S PARTICLE BUDGET FIRST.
      //
      // Both particle layers enforce a hard per-frame spawn ceiling, and it is
      // reached: measured on an emulated phone with the whole field pinned at
      // drift tier 3 and items firing — the case art bible §6 names — the
      // additive layer peaks at 75 spawns against a ceiling of 75 and averages
      // 46. Once the ceiling is spent the layer refuses the rest of the frame,
      // and it was being spent in `karts` order, which is grid order. So under
      // exactly the load where readability matters most, whether the player's
      // own drift shower survived depended on where they happened to be
      // starting from. Emitting the player before the field costs one compare
      // per kart and makes the capped case degrade in the only acceptable
      // direction: the seven rivals thin out, the car you are driving does not.
      const player = race?.player;
      if (player) this.updateKart(ctx, player, dt, now);
      for (let i = 0; i < karts.length; i++) {
        if (karts[i] !== player) this.updateKart(ctx, karts[i], dt, now);
      }
    }
    this.lights.end(dt);

    this.updateAmbient(ctx, dt, now);
    this.updateSignals(ctx, dt);
  }

  lateUpdate(ctx: Ctx, dt: number) {
    if (this.contextLost) return;
    const karts = ctx.race?.karts;
    const now = ctx.time;

    // Plumes and the squash pulse are applied after physics has finished
    // writing the chassis for the frame, so the flame is welded to where the
    // exhaust actually ended up rather than to where it was last frame.
    this.plumes.begin();
    if (karts) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const fx = this.state(k);
        if (k.boostTime > 0) this.placePlumes(ctx, k, fx);
        this.applySquash(k, fx, dt);
      }
    }
    this.plumes.end(now, this.gain);

    this.trails.update(dt);
    this.decals.update(now);
    this.rings.update(now);
    this.rings.gain = this.gain;
    this.trails.gain = this.gain;
    this.particles.additiveGain = this.gain;
    this.particles.update(now);

    // Opportunistic true soft particles: if whoever owns the render pipeline
    // publishes a scene depth texture on the context we pick it up for free.
    //
    // Normalise to null BEFORE the compare. Nobody publishes `depthTexture`
    // today, so this read is `undefined` while `lastDepth` is `null` — and
    // `undefined !== null`, so the old form re-entered the branch on every
    // single frame for the whole race, walking both particle layers and the
    // ring material to write uniforms that had not changed. It never recompiled
    // (the SOFT_DEPTH define only flips when the texture's truthiness changes)
    // but it is per-frame work in the hot path for a thing that is switched off.
    const depth = ((ctx as { depthTexture?: THREE.Texture | null }).depthTexture) ?? null;
    if (depth !== this.lastDepth) {
      this.lastDepth = depth;
      this.rings.setDepthTexture(this.lastDepth, ctx.camera.near, ctx.camera.far);
      this.particles.setDepthTexture(this.lastDepth, ctx.camera.near, ctx.camera.far);
    }
  }

  private lastDepth: THREE.Texture | null = null;

  // -------------------------------------------------------------------------

  private state(k: IKart): KartFx {
    let s = this.fx[k.id];
    if (!s) {
      s = new KartFx();
      // Seed the ground plane so an event fired before this kart's first
      // update() still puts its sparks somewhere sane.
      s.groundY = k.position.y;
      this.fx[k.id] = s;
    }
    return s;
  }

  /**
   * Additive budget. Each bright effect on screen contributes load weighted by
   * how close it is to the camera; the shared gain then falls hyperbolically.
   * One boosting kart is free; a purple drift plus a boost plus a star costs
   * about half the additive brightness, which is precisely the case the art
   * direction says must not white out.
   */
  /**
   * The frame-time governor. See `loadScale`.
   *
   * `dt` is already clamped to 1/20 upstream, which is exactly the behaviour a
   * governor wants: it must chase a sustained deficit, not a single stall, and
   * the clamp stops one hitch from slamming the whole particle layer shut.
   */
  /**
   * HARNESS HOOK — pin the emission density and hold the governor open.
   *
   * Set via `window.__fx.pinDensity = 1` (see `init`), mirroring the existing
   * `__camRig` / `__drawBudget` / `__frameWatch` debug handles. Null in normal
   * play and nothing reads it unless a tool writes it.
   *
   * It exists because appearance harnesses are otherwise measuring the machine
   * rather than the effect. On a software rasteriser under load the game
   * produces a frame every second or two, `updateLoad` correctly slams
   * `loadScale` to its 0.30 floor, and a Low-tier density of 0.21 then lands
   * the whole drift shower at six percent of its authored count — so a probe
   * comparing two builds is comparing how busy the host happened to be. Three
   * consecutive runs of the same commit produced showers of 40, 4 and 25
   * particles for exactly that reason.
   */
  pinDensity: number | null = null;

  private updateLoad(dt: number) {
    if (dt <= 0) return;
    if (this.pinDensity !== null) {
      this.loadScale = 1;
      this.emitScale = this.pinDensity;
      this.particles.density = this.emitScale;
      return;
    }
    this.smoothDt += (dt - this.smoothDt) * Math.min(1, dt * 2.5);
    // 18.2 ms: comfortably inside a 60 Hz budget, so a machine holding frame
    // never touches this. 14.7 ms: enough headroom that giving load back cannot
    // immediately cost the frame it was given back for.
    const HOT = 1 / 55, COOL = 1 / 68;
    if (this.smoothDt > HOT) this.loadScale = Math.max(0.30, this.loadScale - dt * 1.4);
    else if (this.smoothDt < COOL) this.loadScale = Math.min(1, this.loadScale + dt * 0.09);
    this.emitScale = this.baseDensity * this.loadScale;
    this.particles.density = this.emitScale;
  }

  /**
   * The live density. Emitters that hand `emit()` a count let it apply this;
   * emitters that loop over `count = 1` must apply it to their RATE and then
   * call `emitExact`, because one times any density still rounds back to one.
   */
  private emitScale = 1;

  private updateGain(ctx: Ctx, dt: number) {
    let load = 0;
    const karts = ctx.race?.karts;
    if (karts) {
      const cam = ctx.camera.position;
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const d = cam.distanceTo(k.position);
        if (d > 70) continue;
        // Squared falloff, not linear: additive load is a screen-AREA problem
        // and a kart at 10 m covers roughly nine times the pixels of one at
        // 30 m. Weighting them 0.86 to 0.57 (the old linear curve) let a
        // fistful of distant effects hold the gain down while the one filling
        // the middle of the frame was undercounted.
        const w = (1 - d / 70) * (1 - d / 70);
        if (k.boostTime > 0) load += 1.15 * w;
        if (k.driftTier > 0) load += (0.3 + 0.35 * k.driftTier) * w;
        if (k.starTime > 0) load += 0.9 * w;
        // A kart standing on a boost pad is sitting on the brightest surface in
        // the game with its own blue wash on top. This is the third term of the
        // exact worst case §6 names: boost + drift + tunnel-exit bloom.
        if (this.fx[k.id]?.surface === Surface.Boost) load += 0.8 * w;
      }
    }
    this.blastLoad = Math.max(0, this.blastLoad - dt * 1.4);
    load += this.blastLoad;
    // Knee at 0.75 rather than 1.0, and a steeper slope. Worked example, the
    // case art bible §6 names explicitly — the player boosting on a purple
    // drift, standing on a tunnel boost pad, at 7 m from the chase camera:
    //   w        = (1 - 7/70)^2                      = 0.81
    //   load     = (1.15 + 1.35 + 0.80) * 0.81 + 0.5 = 3.17   (0.5 = ignition)
    //   gain     = 1 / (1 + 0.5 * (3.17 - 0.75))     = 0.45
    // Every additive surface in this file — particles, rings, trails, plumes,
    // motes, shimmer, and the effect lights — is multiplied by that number, so
    // the whole stack lands at a bit under half strength and the tone mapper
    // still has headroom above it. One boosting kart alone gives load 1.15,
    // gain 0.83: the common case is barely attenuated at all.
    //
    // RE-TUNED AGAINST MEASUREMENT rather than against fear. The knee moves
    // from 0.75 to 1.05, the slope from 0.50 to 0.38 and the floor from 0.35 to
    // 0.45, which takes the worked example above from gain 0.45 to 0.55 and
    // leaves a single boosting kart completely unattenuated (load 0.93, under
    // the knee, gain 1.0) where it used to lose 17%.
    //
    // The justification is the r13 probe set, which measured the exact frame
    // this governor exists to protect: tier-3 drift + boost + the tunnel boost
    // pad, captured at 132 km/h. Mean display luma 74, 99th percentile 212,
    // 99.9th 245, and the fraction of pixels with all three channels at 250 or
    // above is 0.000%. The frame the art bible says must not white out was
    // nowhere near white — it was DARKER than the calm 55 km/h cruise (mean 91)
    // because the governor was spending a third of the additive budget defending
    // against a failure that does not occur. A conservative gain is not free:
    // it is paid for by the one frame in the game that is supposed to be
    // overwhelming. The floor still exists, the curve is still hyperbolic and
    // still monotonic, and the per-fragment Reinhard shoulders in Particles,
    // Trails and Plumes are unchanged — this only stops the governor throwing
    // away headroom the tone mapper had all along.
    const target = THREE.MathUtils.clamp(1 / (1 + 0.38 * Math.max(0, load - 1.05)), 0.45, 1);
    this.gain += (target - this.gain) * damp(dt, 0.0015);
  }

  /**
   * Drives the render/camera effect requests declared on Ctx.
   *
   * SINGLE OWNER. Both this and Race.updateCamera used to read-modify-write
   * ctx.speedIntensity and ctx.fovPunch every frame with different curves and
   * different time constants. Because each of them accumulated ONTO the shared
   * field rather than onto its own state, whichever ran last did not just win —
   * it destroyed the other's smoothing, so the eased curve degenerated into
   * whatever the last writer's instantaneous value was.
   *
   * The fix is to keep the state here and *assign* the result, so the published
   * value is a well-formed curve no matter what order the systems run in.
   * Race.updateCamera's copy still needs deleting; see the round-2 report.
   */
  private signalSpeed = 0;
  private signalFov = 0;

  private updateSignals(ctx: Ctx, dt: number) {
    // Decays whether or not there is a player, so it cannot survive a reset.
    // ~0.35 s to nothing: long enough to be a beat, short enough that the
    // sustained boost is what carries the rest of the run.
    this.igniteImpulse = Math.max(0, this.igniteImpulse - dt * 2.9);
    const k = ctx.race?.player;
    if (!k) {
      this.signalSpeed = 0; this.signalFov = 0;
      this.igniteImpulse = 0;
      ctx.speedIntensity = 0; ctx.fovPunch = 0;
      return;
    }
    const racing = ctx.race?.state !== RaceState.Countdown;
    const top = 30 * (k.stats?.topSpeedMul ?? 1);
    const ratio = THREE.MathUtils.clamp(Math.abs(k.forwardSpeed) / top, 0, 1.4);
    // Speed lines only above ~70% of top speed, and they ramp, never pop.
    const want = racing ? THREE.MathUtils.clamp((ratio - 0.70) / 0.42, 0, 1) : 0;
    const boost = racing && k.boostTime > 0 ? 1 : 0;

    // CAPPED, but no longer capped BELOW the post chain's own gates.
    //
    // `speedIntensity` is the single number the post chain multiplies its
    // radial blur, its chromatic aberration and its speed lines by. Round 5
    // ceilinged it at 0.66 to stop a boost pad pinning the radial blur at 1.0
    // and smearing the hero kart into mush. That fixed the mush and created a
    // worse problem: PostFX gated its speed lines at smoothstep(speed, 0.42, 1)
    // and its zoom blur on speed^2, so a ceiling of 0.66 left the streaks at a
    // third strength and the blur at a twentieth — and on the frame that was
    // actually photographed (a boost taken at 18.8 m/s, below the 70%-of-top
    // ramp entirely) the whole term evaluated to zero. That is the review note
    // verbatim: no speed lines, no smear, no difference from a 56 km/h cruise.
    //
    // Two things changed. The mush was never caused by the magnitude, it was
    // caused by the blur being applied to the SUBJECT — which PostFX now holds
    // out with a world-space sphere around the kart — so the ceiling can come
    // up. And boost is no longer a small addend on top of the speed ramp: it
    // is a floor of its own, because a boost has to read as a boost at any
    // speed it is taken at. Flat out on a boost lands at 0.89; flat out
    // without one, at 0.37; a boost from a standstill still clears 0.52.
    const speedTarget = THREE.MathUtils.clamp(want * 0.42 + boost * 0.52, 0, 0.95);
    this.signalSpeed += (speedTarget - this.signalSpeed) * damp(dt, 0.02);
    // THE IGNITION SPIKE, added AFTER the smoothing rather than into it.
    //
    // Routing it through the same easing would defeat the point: the easing has
    // a ~0.1 s time constant precisely so a boost pad cannot snap the lens, and
    // a spike that is eased is a plateau that arrives late. The impulse carries
    // its own decay (see boostFlash), so adding it here gives the published
    // signal the shape the payoff needs — a hard leading edge on the frame the
    // player let go of the button, falling back onto the sustained value within
    // a third of a second. Ceiling is unchanged at 0.95, so nothing downstream
    // sees a value it was not already tuned for.
    ctx.speedIntensity = Math.min(0.95, this.signalSpeed + this.igniteImpulse * 0.30);

    // Punch in fast, ease out slowly — the asymmetry is the whole kick. Held
    // here rather than left to the camera so the ramp survives an ordering
    // change, and so a stun visibly pulls the frame back in.
    // 8.5 on a boost, and the gap to everything else is deliberate: PostFX has
    // no boost flag of its own and recovers one from this number (see KICK_LO /
    // KICK_HI there), so the boost band has to sit clear of the most a drift
    // or a flat-out lap can produce — 3.3 and 3.2 respectively.
    // The sustained term is up from 3.2 to 4.2 degrees. A widening lens is one
    // of the five cues that has to separate a 101 km/h frame from a 55 km/h one
    // and it was contributing 1.8 degrees at 101 — under three percent of the
    // 62-degree base, which is below the threshold of noticing. At 4.2 flat out
    // the chase rig opens by 3.3 (it takes 0.78 of this) and pulls the arm in to
    // match, so the kart holds its size while the world stretches past it.
    //
    // The ceiling on a NON-boost frame is still a single number, deliberately:
    // PostFX has no boost flag of its own and recovers one from this signal (see
    // KICK_LO / KICK_HI there). The drift branch below takes a max rather than
    // adding, so nothing without a boost can publish more than 4.2, against 8.5
    // for a boost taken from a standstill.
    let fovTarget = boost * 8.5 + want * 4.2;
    if (k.driftTier > 0 && !boost) fovTarget = Math.max(fovTarget, 1.1 * k.driftTier);
    if (k.stunTime > 0) fovTarget = -3;
    const rate = fovTarget > this.signalFov ? 12 : 4.5;
    this.signalFov += (fovTarget - this.signalFov) * Math.min(1, dt * rate);
    // Same spike, same reasoning as the speed signal. 3.4 degrees on top of the
    // 8.5 a boost already publishes: the chase rig takes 0.78 of it, so the lens
    // opens by an extra 2.7 degrees on the release frame and settles back. That
    // is a punch you feel; a step from 62 to 65 degrees held for two seconds is
    // a focal length, and the review has correctly been calling it one.
    //
    // It stays clear of PostFX's KICK_LO/KICK_HI contract by construction: this
    // only ever ADDS, and only when a boost has just been cashed, so nothing
    // without a boost can be pushed across the threshold that separates the two.
    ctx.fovPunch = this.signalFov + this.igniteImpulse * 3.4;
  }

  // -------------------------------------------------------------------------
  // Per-kart continuous effects
  // -------------------------------------------------------------------------

  private readonly skidLRef = new THREE.Vector3();
  private readonly skidRRef = new THREE.Vector3();

  /** Resolve rear-wheel offsets once, from whatever model the kart shipped. */
  private resolveOffsets(k: IKart, fx: KartFx) {
    if (fx.resolved) return;
    fx.resolved = true;
    const w = k.wheels;
    if (!w || w.length < 4) return;
    let i0 = -1, i1 = -1, z0 = Infinity, z1 = Infinity;
    for (let i = 0; i < w.length; i++) {
      const z = w[i].position.z;
      if (z < z0) { z1 = z0; i1 = i0; z0 = z; i0 = i; }
      else if (z < z1) { z1 = z; i1 = i; }
    }
    if (i0 < 0 || i1 < 0) return;
    // Guard the pair actually straddles the centreline. A model that lists its
    // wheels in an unexpected order, or with a rear axle at the same z, can
    // otherwise hand back two wheels on the SAME side — both spark streams then
    // land on top of each other and the drift looks one-sided. Defaults are
    // already a sane rear axle, so falling back to them is safe.
    const xa = w[i0].position.x, xb = w[i1].position.x;
    if (xa * xb >= 0 || Math.abs(xa - xb) < 0.2) return;
    const l = xa < xb ? i0 : i1;
    const r = xa < xb ? i1 : i0;
    fx.offL.set(w[l].position.x, 0, w[l].position.z);
    fx.offR.set(w[r].position.x, 0, w[r].position.z);
  }

  /** World-space rear contact patches, projected onto the local ground plane. */
  private rearPoints(k: IKart, fx: KartFx) {
    this.resolveOffsets(k, fx);
    for (let s = 0; s < 2; s++) {
      const off = s === 0 ? fx.offL : fx.offR;
      const out = s === 0 ? this.skidLRef : this.skidRRef;
      out.copy(off).applyQuaternion(k.quaternion).add(k.position);
      const n = fx.groundN;
      // plane through (kart.xz, groundY) with normal n
      out.y = fx.groundY - (n.x * (out.x - k.position.x) + n.z * (out.z - k.position.z)) / (n.y || 1);
      out.y += 0.04;
    }
  }

  /** near/mid/far emission multiplier by distance; steeper on mobile tiers. */
  private lodOf(dist: number): number {
    if (this.mobileLod) return dist < 16 ? 1 : dist < 42 ? 0.30 : 0.09;
    return dist < 30 ? 1 : dist < 70 ? 0.45 : 0.18;
  }

  private mobileLod = false;

  /**
   * Extra thinning for a kart that is not on screen. **Mobile tiers only** —
   * `mobileLod` gates the frustum build as well as this call, so High and Ultra
   * do not pay for the test and do not lose a grain.
   *
   * The measured worst case is fill-rate bound, not CPU bound (55% idle, 10% in
   * the GL driver), and the layer that can produce unbounded blended fill is
   * this one. A phone is 390 px tall with a 62-degree lens: on the harbour
   * sweep most of a bunched field is behind or beside the camera, and every
   * grain those karts emit is spawned, uploaded, integrated in the vertex
   * shader and clipped, having spent a slot in a ring the karts you CAN see are
   * competing for.
   *
   * A quarter rather than zero, and padded by twelve metres. Both matter: the
   * emitters are stateful accumulators, so switching one off and on again makes
   * a shower restart rather than fade, and a rival's smoke legitimately drifts
   * into frame after the kart that made it has left it. Twelve metres is about
   * a third of a second of travel at racing speed, which is more than the
   * longest smoke life this file authors.
   */
  private offScreenScale(k: IKart): number {
    _bounds.center.copy(k.position);
    _bounds.radius = 12;
    return _frustum.intersectsSphere(_bounds) ? 1 : 0.25;
  }

  private updateKart(ctx: Ctx, k: IKart, dt: number, now: number) {
    const fx = this.state(k);
    const cam = ctx.camera.position;
    const dist = cam.distanceTo(k.position);
    // Everything below is readability for a kart you can see. Beyond 120 m the
    // kart is a few pixels wide and its dust would be noise. 80 m on the mobile
    // tiers, where the same kart is a third of the pixels and `lodOf` has
    // already taken it down to nine percent of its emission.
    if (dist > (this.mobileLod ? 80 : 120)) {
      if (fx.trail >= 0) { this.trails.release(fx.trail); fx.trail = -1; }
      fx.skidding = false;
      // Timers still have to run out here. Nothing this kart emits is drawn at
      // this range, but `igniteT` is now a *gate* as well as a ramp — the
      // ignition dedupe in `boostFlash` refuses a second flash while it is
      // fresh — so freezing it at 0.30 on a kart that boosted and then drove
      // out of range would silently swallow that kart's next ignition when it
      // came back. A one-line decay costs nothing and keeps the state honest.
      fx.igniteT = Math.max(0, fx.igniteT - dt);
      fx.tierFlash = Math.max(0, fx.tierFlash - dt);
      if (k.boostTime <= 0) fx.boostTier = 1;
      return;
    }

    const probe = ctx.track.probe(k.position, k.t);
    fx.groundY = probe.y;
    fx.groundN.copy(probe.normal);
    fx.surface = probe.surface;
    this.rearPoints(k, fx);

    const speed = Math.abs(k.forwardSpeed);
    const grounded = !k.airborne;
    const props = SURFACE_PROPS[fx.surface] ?? SURFACE_PROPS[Surface.Road];
    // Near effects get full rate; distant ones thin out so the far pack does
    // not quietly eat the particle budget.
    //
    // The mobile curve is far steeper, and this is where "far fewer particles
    // on a phone" is actually bought without touching what the player sees of
    // their OWN car. The chase camera sits ~7 m back, so the player is always
    // in the near band at full rate; the seven rivals are typically 20-60 m out,
    // where a kart on a 390-pixel-tall screen is a couple of dozen pixels and
    // its shower is three. Thinning them 0.45 -> 0.16 removes most of the field's
    // emission and none of the readability, which is a much better trade than
    // taking a third of the grains off the drift the player is actually doing.
    const lod = this.lodOf(dist) * (this.mobileLod && !k.isPlayer ? this.offScreenScale(k) : 1);
    fx.tierFlash = Math.max(0, fx.tierFlash - dt);

    // --- drift: sparks, smoke, skid marks ---------------------------------
    const drifting = k.driftDir !== 0 && grounded && speed > 4;
    // SPARKS DO NOT STOP WHEN THE TYRES LEAVE THE ROAD FOR A FRAME.
    //
    // The drift signature used to be gated on `grounded`, which sounds right
    // and is the reason the reviewed tier-2 frame contains no sparks at all:
    // the shot was taken with the kart skipping a kerb, `airborne` was true for
    // that frame, and every emitter that says "tier 2" switched off together.
    // A drift is a two-second state and the read has to survive the hops in the
    // middle of it. Contact-derived effects (smoke, rubber, scorch) stay gated;
    // the sparks and the colour do not, they just thin out.
    const sparking = k.driftDir !== 0 && speed > 4;
    const airFade = grounded ? 1 : 0.5;
    if (sparking && k.driftTier > 0) {
      const tier = Math.min(3, k.driftTier);
      const col = C_TIER[tier];
      // Publish the live tier hue on this kart's colour channel. Every drift
      // particle it has in the air reads it this frame, so the shower can never
      // be one tier behind the HUD again — which was the blocker in the drift
      // review frame (orange arc, blue sparks, same image).
      this.particles.setChannelColor(k.id + 1, col);
      // 60 + 30/tier, up from 30 + 12. The review is blunt — a tier-2 shower
      // read as "dust motes" — and the shower has to be dense enough that the
      // eye integrates it into a continuous jet rather than resolving the
      // individual grains. At tier 2 this is ~120 emission units/s per wheel,
      // each spawning three cores and three halos.
      const prof = TIER_FX[tier];
      fx.sparkAcc += dt * prof.rate * lod * airFade;
      const n = Math.floor(fx.sparkAcc);
      if (n > 0) {
        fx.sparkAcc -= n;
        this.emitSparks(this.skidLRef, k, n, tier, -1);
        this.emitSparks(this.skidRRef, k, n, tier, 1);
      }

      // --- the rising ember jet, tier 2 and up ------------------------------
      // The first thing in the escalation that leaves the ground plane. A
      // drift's whole read up to tier 1 is horizontal — a shower thrown
      // backwards and a glow on the tarmac — so it grows only in brightness,
      // and brightness alone is what the eye is worst at ranking. A column of
      // embers climbing out of each contact patch changes the SHAPE of the
      // effect, and a shape change is what "a genuine escalation the player
      // feels building" means. Long-lived, low-drag, ballistic: they rise a
      // metre and a half and fall back through the shower.
      if (prof.jet > 0) {
        fx.jetAcc += dt * 30 * prof.jet * lod * airFade * this.emitScale;
        const nj = Math.floor(fx.jetAcc);
        if (nj > 0) { fx.jetAcc -= nj; this.driftJet(k, fx, nj, tier); }
      } else {
        fx.jetAcc = 0;
      }

      // --- the tier-3 pulse -------------------------------------------------
      // Nothing else in this game beats. A thin violet front leaving the
      // contact patches six and a half times a second is legible at fifteen
      // pixels tall, through motion blur, and across a room — which is the bar
      // this round was set. Restricted to the near field: it is a ring draw per
      // beat out of a 28-slot pool, and a whole field at tier 3 forty metres
      // away would churn it for nothing anyone can see.
      if (prof.pulse > 0 && dist < 42) {
        fx.beatAcc += dt * TIER3_PULSE_HZ;
        if (fx.beatAcc >= 1) {
          fx.beatAcc -= Math.floor(fx.beatAcc);
          _q.copy(k.position); _q.y = fx.groundY + 0.20;
          // No `this.gain` here: the whole ring pool is multiplied by it once
          // per frame in `lateUpdate` (`this.rings.gain = this.gain`), so
          // folding it in at spawn would apply it twice and the pulse would
          // vanish in exactly the crowded frame it exists to be legible in.
          this.rings.spawn(_q, fx.groundN, 0.35, 3.1, 0.30, 0.05, col,
            0.95, now, k.velocity, 1.8);
        }
      } else {
        fx.beatAcc = 0;
      }

      // Coloured light pool on the road under the sparks. Sparks that light
      // nothing float in front of the world; this is the single change that
      // makes the tier read at a glance in a moving frame. Two cheap ground
      // quads carry it on every kart...
      // Rate carries the density (see `emitScale`): `groundPool` loops two
      // count-1 emits, and a count of one is immune to a density multiplier.
      fx.poolAcc += dt * 26 * lod * airFade * this.emitScale;
      const np = Math.floor(fx.poolAcc);
      if (np > 0) {
        fx.poolAcc -= np;
        this.groundPool(k, fx, tier);
      }
      // ...and the nearest few karts additionally get a real point light, so
      // the tarmac, the kerb and the kart's own underbody all pick the tier up.
      if (dist < 45) {
        _p.copy(k.position).addScaledVector(k.forward, -0.7);
        _p.y = fx.groundY + 0.55;
        // Candela: three is physically-correct, so this is divided by r^2 at the
        // shading point. The pool sits ~0.55 m off the tarmac, so 0.6 lands
        // around 2 lx under a tier-1 drift against a 4.2 key — a clear coloured
        // wash, not a blowout.
        //
        // `tierFlash` doubles it for a fifth of a second on promotion: the tier
        // change has to be an event on the BODYWORK and the road, not only in
        // the particle layer, and a lamp that punches and settles is what the
        // eye reads as "something just happened" from across the room.
        const flash = 1 + 2.1 * (fx.tierFlash / Math.max(0.05, fx.tierFlashLen));
        // Nonlinear in the tier, like everything else in the escalation: 0.72 /
        // 1.30 / 2.10 candela rather than a flat 0.42 per step. The lamp is the
        // only part of the drift signature that lands on the BODYWORK and the
        // kerb, so it is what makes the tier visible on a still of the car
        // rather than only on a still of the shower.
        this.lights.request(
          k.id, (k.isPlayer ? 100 : 10) + tier - dist * 0.05, _p, col,
          (0.36 + 0.30 * tier + 0.12 * tier * tier) * flash * (1 - dist / 45) * this.gain,
          5.6 + 0.7 * tier);
      }

      // Ground scorch under the tyres, TINTED TO THE TIER (art bible §6). It
      // was previously a neutral grey smudge, which on a grey road is a mark
      // you have to be told is there — the review counted it as missing. The
      // decal layer multiplies, so the tier colour becomes the *hue of the
      // darkening* rather than a coloured stain: see Decals.scorch. Laid twice
      // as often and a shade stronger, because this is the only part of the
      // drift that persists after the sparks have gone and it is what gives the
      // corner a history.
      // Twice the radius, twice the strength, on BOTH contact patches, and on
      // the eroded Scorch disc rather than the small Smudge kiss. The review
      // counted this as producing nothing visible on the road at tier 2, and it
      // was right: a 0.46 m Smudge at 0.58 strength is a 40 cm mark that the
      // drift smoke sits directly on top of. A drift has to leave a history on
      // the tarmac or the corner has no memory of what happened in it.
      fx.scorchAcc += grounded ? dt * (7 + 3 * tier) : 0;
      if (fx.scorchAcc >= 1) {
        fx.scorchAcc -= 1;
        for (let s = 0; s < 2; s++) {
          this.decals.scorch(s === 0 ? this.skidLRef : this.skidRRef, fx.groundN,
            0.62 + 0.14 * tier, col, now, 9.0, 0.50 + 0.16 * tier, DecalTile.Scorch);
        }
      }
    } else {
      fx.sparkAcc = 0;
      fx.poolAcc = 0;
      fx.jetAcc = 0;
      fx.beatAcc = 0;
    }

    // Lateral slip, 0..1, from the actual velocity rather than the drift flag.
    // The drift button is not the only way to end up sideways, and more to the
    // point a kart that has just released a drift is still sliding — gating the
    // rubber on `driftDir` is why the hero corner had a kart mid-slide over
    // perfectly clean tarmac with no trace of the line it took.
    let slip = 0;
    if (grounded && speed > 3) {
      _side.crossVectors(UP, k.forward).normalize();
      const lat = Math.abs(k.velocity.dot(_side));
      slip = THREE.MathUtils.clamp((lat / Math.max(speed, 1) - 0.10) / 0.30, 0, 1);
    }

    if (drifting) {
      // Smoke is the only thing that gives a drift mass. It has to scale with
      // the charge, or a tier-3 drift looks exactly like a tier-0 one.
      //
      // AND WITH THE SLIP, which is the half that was missing. A tyre smokes
      // because it is being dragged sideways; keying the volume off the tier
      // alone means a kart that has snapped into a deep slide and one that is
      // barely sideways make identical clouds, so the smoke says nothing about
      // how hard the player is actually committing. The tier sets the floor
      // (the charge is real and should be visible even in a tidy drift) and the
      // slip is what makes a greedy angle look expensive.
      const tier = Math.min(3, k.driftTier);
      fx.smokeAcc += dt * (20 + 12 * tier) * (0.55 + 0.95 * slip) * lod;
      const n = Math.floor(fx.smokeAcc);
      if (n > 0) {
        fx.smokeAcc -= n;
        this.tyreSmoke(k, fx, this.skidLRef, n, props.dustColor, tier);
        this.tyreSmoke(k, fx, this.skidRRef, n, props.dustColor, tier);
      }

      // GRIT OFF THE CONTACT PATCH. Art bible §6 names dust *and* grit; the
      // grit only ever existed in `rollDust`, which is explicitly gated on NOT
      // drifting — so the one moment in the game where a tyre is genuinely
      // tearing at the road was the one moment nothing hard came off it. The
      // smoke is low-frequency and reads as air; this is the high-frequency
      // layer that reads as the surface itself being removed, and it is what
      // gives the slide texture at the resolution the chase camera sees.
      fx.gritAcc += dt * (14 + 22 * slip) * lod * this.emitScale;
      const ng = Math.floor(fx.gritAcc);
      if (ng > 0) { fx.gritAcc -= ng; this.driftGrit(k, fx, ng, props.dustColor, slip); }
    } else {
      fx.smokeAcc = 0;
      fx.gritAcc = 0;
    }

    // Rubber. Laid for anything actually sliding, drifting or not, and out to
    // 95 m so the pack in front of you leaves a readable line too. Clean tarmac
    // behind a drifting kart costs the frame its whole sense of history; the
    // decal ring is 3200 quads and a segment is 0.55 m, so a kart can lay ~40 m
    // of continuous mark before it starts recycling its own oldest slot.
    const marking = grounded && speed > 5 && dist < 95 &&
      (drifting || slip > 0.25) &&
      fx.surface !== Surface.Water;
    if (marking) {
      // The floor rises with the charge, so the line a tier-3 slide leaves on
      // the tarmac is visibly heavier than a tier-1 one — art bible §6 wants
      // the drift to leave a history, and the history should record how hard
      // the corner was taken, not merely that it was.
      const dTier = drifting ? Math.min(3, k.driftTier) : 0;
      this.layStrip(fx, now, THREE.MathUtils.clamp(
        Math.max(slip, drifting ? 0.52 + 0.10 * dTier : 0) * Math.min(1, speed / 14), 0.25, 1),
        1 + 0.10 * dTier);
    } else if (fx.skidding) {
      fx.skidding = false; fx.skidStrength = 0;
    }

    // --- surface reaction: dust, spray, sand ------------------------------
    if (grounded && speed > 5) {
      const s = fx.surface;
      if (s === Surface.Water) {
        fx.dustAcc += dt * 30 * lod * (speed / 20);
        const n = Math.floor(fx.dustAcc);
        if (n > 0) { fx.dustAcc -= n; this.waterSpray(k, fx, n); }
      } else if (s !== Surface.Road && s !== Surface.Boost) {
        const heavy = s === Surface.Sand;
        fx.dustAcc += dt * (heavy ? 26 : 18) * lod * (speed / 20);
        const n = Math.floor(fx.dustAcc);
        if (n > 0) { fx.dustAcc -= n; this.surfaceDust(k, fx, n, props.dustColor, heavy); }
      } else {
        fx.dustAcc = 0;
      }
    }

    // --- boost: plume, trail, glow ----------------------------------------
    const boosting = k.boostTime > 0;
    fx.igniteT = Math.max(0, fx.igniteT - dt);
    if (boosting) {
      // The tier the boost was CASHED FROM, latched on the event — not
      // `k.driftTier`, which Kart.releaseDrift has already zeroed by the time
      // any of this runs. See KartFx.boostTier.
      const btier = fx.boostTier;
      // Down from 105: the flame BODY is the ribbon now (see Plumes), so this
      // only has to supply the root kiss, the tier sheath and the tail embers.
      fx.flameAcc += dt * 46 * lod;
      const n = Math.floor(fx.flameAcc);
      if (n > 0) { fx.flameAcc -= n; this.boostPlume(k, n); }
      if (fx.trail < 0 && dist < 90) {
        // Boost palette, NOT the livery. Deriving the ribbon colour from the
        // kart's paint is why the hero boost frame trailed a rust-brown streak
        // that read as a mud smear: a red kart lerped toward cream lands on
        // exactly the hue of dried dirt. §3 fixes boost at #4fc3ff / #ff9d2e /
        // #c05cff and the ribbon has to be one of the three, whatever colour
        // the car is painted.
        _col.copy(C_TIER[btier]).lerp(C_FLAME_ROOT, 0.18);
        // Narrow and short. This is a heat ribbon threading the plume together,
        // not the effect itself.
        //
        // Cut hard from 0.54 m / 2.1x / 5.0 m. In the reviewed boost frame this
        // ribbon is the flat cyan band lying across the road behind the kart —
        // a half-metre-wide strip of saturated additive colour seen almost
        // edge-on, which perspective smears into a painted stripe, and which
        // sums into exactly the same pixels as the plume it is supposed to be
        // threading. The plume is now a properly structured flame and does not
        // need a second ribbon to carry it; this is reduced to a heat spine
        // behind the stacks that you notice only when it is missing.
        //
        // Given some of it back, and scaled with the tier. 0.24 m was tuned
        // against a plume that was itself clamped down to a wisp; with the
        // plume budget reopened (see placePlumes) the spine has to keep pace or
        // the flame has no thread through it. A tier-3 boost gets a 0.40 m
        // ribbon at 1.6x, a mushroom keeps essentially what it had.
        fx.trail = this.trails.acquire(
          0.20 + 0.068 * btier, _col, 0.95 + 0.22 * btier, 0.48, 0.16, 0.20, 3.4);
      }
      if (fx.trail >= 0) {
        // Between the two stacks, at stack height — not at the chassis centre
        // 35 cm below them, which is why the boost review frame shows the
        // ribbon as "a two-pixel blue sliver under the rear axle" instead of as
        // the spine of the flame it is supposed to thread.
        _fwd.copy(k.forward);
        _side.crossVectors(UP, _fwd).normalize();
        this.stackMouth(k, 0, _p);
        this.stackMouth(k, 1, _q);
        _p.addVectors(_p, _q).multiplyScalar(0.5);
        this.trails.push(fx.trail, _p.x, _p.y, _p.z);
      }
      // The flame has to light the rear bodywork or it floats on top of it.
      // Ignition overshoots hard for a third of a second, then settles.
      if (dist < 55) {
        _p.copy(k.position).addScaledVector(k.forward, -1.0); _p.y += 0.55;
        _col.copy(C_TIER[btier]).lerp(C_FLAME_MID, 0.45);
        // 0.42, down from 0.70 (so 1.09 rather than 1.82 at full ignition
        // overshoot). This lamp is inside the same volume as the plume, the
        // ribbon and the root kiss, and every one of them was authored as if it
        // were the only thing there. The flame reads at the right brightness
        // when the SUM does, not when each layer does.
        const kick = 1 + 1.6 * (fx.igniteT / 0.30);
        // 0.48 + 0.09/tier. The tier has to be legible on the BODYWORK during a
        // boost, not only in the flame: a purple mini-turbo throws violet light
        // up the rear deck and the driver's back, which is the read that
        // survives the flame being foreshortened to a disc by the chase camera.
        this.lights.request(
          k.id, (k.isPlayer ? 200 : 60) - dist * 0.05, _p, _col,
          (0.48 + 0.09 * btier) * kick * (1 - dist / 55) * this.gain, 7.4);
      }
    } else {
      // The latch is per-boost, not per-race: without this a kart that once
      // cashed a purple mini-turbo would light a mushroom violet for the rest
      // of the lap, because `boostFlash` only ever takes the max (so that a
      // pad taken DURING a mini-turbo cannot demote the flame mid-burn).
      fx.boostTier = 1;
      if (fx.trail >= 0) {
        this.trails.release(fx.trail);
        fx.trail = -1;
      }
    }
    fx.wasBoosting = boosting;

    // --- slipstream rush ---------------------------------------------------
    // The boost review frame is the worst failure in the set: at 33.6 m/s with
    // the HUD reading 120 it is visually identical to a 56 km/h cruise. Cover
    // the number and nothing in the image says "fast".
    //
    // The post stack's radial speed lines are dead in every build (its `lens.z`
    // gain uniform is initialised and never written — see the report; that file
    // is not ours to fix). Even once it is fixed, a screen-space wipe is a
    // filter over the frame; this is speed happening *in the world*, with real
    // perspective, real occlusion behind the kart and real parallax against the
    // road. Both belong in a shipped arcade racer and they do not fight.
    //
    // §6: "Speed lines only above ~70% top speed, and subtle — they frame, they
    // don't obscure." Gated on exactly the ramp that drives ctx.speedIntensity,
    // seeded ahead of the kart near the axis so they are small and central at
    // birth, and flaring out past the lens as perspective takes them — which is
    // what makes them frame rather than cover.
    // Not gated on `grounded`: a jump at speed is the last moment you want the
    // sense of speed to blink out, and the ramp already fades it in and out.
    if (k.isPlayer && this.signalSpeed > 0.045) {
      // RENORMALISED. `signalSpeed` is not a fraction of top speed — the 70%
      // gate is already applied above, so the whole no-boost range of this
      // signal is 0..0.42 and a boost floors it at 0.52. Dividing by 0.55 was
      // reading it as if it were 0..1: the 101 km/h frame the reviewers were
      // shown sat at signalSpeed 0.24, i.e. ramp 0.345, so it got a third of the
      // authored density at a third of the authored size — which is why there is
      // not one streak in that image. Against 0.255 the same frame lands at 0.77
      // and flat out is 1.0, which is what the curve was always tuned for.
      const ramp = THREE.MathUtils.clamp((this.signalSpeed - 0.045) / 0.255, 0, 1);
      // Density is applied to the RATE, not left to Particles.emit(): that
      // clamps a single-particle emit up to one so the readability cue survives
      // a low setting, which is right for a drift spark and wrong for a
      // decorative rush line the player is meant to get fewer of.
      // The ignition term triples the rate for the third of a second after a
      // release, so the boost arrives as a WALL of air passing the lens and
      // then settles to the sustained rush. Same reasoning as the lens spike in
      // `updateSignals`: the eye reads onsets, not plateaus.
      fx.rushAcc += dt * (18 + 130 * ramp) * (boosting ? 2.1 : 1)
        * (1 + 2.4 * this.igniteImpulse) * this.emitScale;
      const n = Math.floor(fx.rushAcc);
      if (n > 0) { fx.rushAcc -= n; this.slipstream(k, n, ramp, boosting); }
    } else {
      fx.rushAcc = 0;
    }

    // --- boost pad contact -------------------------------------------------
    // The pad is the brightest surface on the circuit and it lit nothing at
    // all: a kart crossing it was graded exactly as it was a metre earlier.
    // The pad's own material belongs to the track, but the response of a kart
    // standing on it is ours, and it is most of what sells the pad.
    if (grounded && fx.surface === Surface.Boost && speed > 6) {
      const padCol = C_TIER[1];
      if (dist < 50) {
        _p.copy(k.position); _p.y = fx.groundY + 0.7;
        this.lights.request(
          // Keys must stay clear of the pool's "unowned" sentinel (-1) and of
          // the drift/boost keys, which are raw kart ids.
          1000 + k.id, (k.isPlayer ? 150 : 40) - dist * 0.05, _p, padCol,
          0.55 * (1 - dist / 50) * this.gain, 6.5);
      }
      fx.padAcc += dt * 24 * lod * this.emitScale;
      const np = Math.floor(fx.padAcc);
      if (np > 0) {
        fx.padAcc -= np;
        // Rising heat off the strip plus a wash of pad-blue under the kart.
        //
        // Cut hard from round 3. The pad's own material is already the
        // brightest surface on the circuit and it sits in the tunnel where the
        // exit bloom is at its strongest; laying a 4 m additive disc at 0.55
        // alpha on top of it is how the tunnel frame ended up with a boost pad
        // clipped to featureless white. The kart's response should read as the
        // kart picking the pad up, not as more pad.
        const p = this.particles.reset();
        p.tile = PTile.Glow; p.mode = PMode.Ground;
        p.life = 0.35; p.lifeJitter = 0.3;
        p.size0 = 1.1; p.size1 = 2.6; p.sizeJitter = 0.3;
        p.drag = 1.2; p.count = 1; p.camBias = 0.07; p.fadeIn = 0.15;
        this.particles.at(k.position.x, fx.groundY + 0.04, k.position.z);
        this.particles.vel(k.velocity.x * 0.5, 0, k.velocity.z * 0.5);
        this.particles.colorA(padCol, 0.34, 0.30);
        this.particles.colorB(padCol, 0.09, 0);
        this.particles.emitExact(true);

        p.mode = PMode.Billboard; p.tile = PTile.Core;
        p.life = 0.3; p.size0 = 0.055; p.size1 = 0.012; p.sizeJitter = 0.5;
        p.gravity = 1.6; p.drag = 2.0; p.velJitter = 1.4; p.posJitter = 0.5;
        p.count = Math.max(1, np); p.fadeIn = 0.05;
        this.particles.ground(fx.groundY, fx.groundN, 0.25, 0.08);
        this.particles.at(k.position.x, fx.groundY + 0.12, k.position.z);
        this.particles.vel(k.velocity.x * 0.3, 2.6, k.velocity.z * 0.3);
        this.particles.colorA(padCol, 1.8, 1);
        this.particles.colorB(padCol, 0.5, 0);
        this.particles.emitExact(true);
      }
    } else {
      fx.padAcc = 0;
    }

    // --- idle exhaust ------------------------------------------------------
    // A pack shot has to look like eight running engines. Every other emitter
    // in this file is conditional on drifting, boosting, being stunned or
    // leaving the road, so a rival holding a clean line at 25 m/s emits
    // literally nothing and reads as a static prop. This is the baseline: a
    // thin, warm, sun-lit wisp off the stacks, cheap enough to run on the whole
    // field (~9 puffs/s/kart before LOD).
    if (!boosting && grounded && speed > 6 && dist < 70) {
      // 5/s, down from 9. See idleExhaust for the arithmetic on why eighteen
      // puffs a second behind a cruising kart is an opaque column.
      fx.exhaustAcc += dt * 5 * lod * Math.min(1, speed / 14);
      const n = Math.floor(fx.exhaustAcc);
      if (n > 0) { fx.exhaustAcc -= n; this.idleExhaust(k, fx, n); }
    } else {
      fx.exhaustAcc = 0;
    }

    // --- tyre contact at speed --------------------------------------------
    // Separate from the exhaust and from the off-road dust: this is the thin
    // veil a hot tyre throws off tarmac. Without it the hero kart at 92 km/h
    // emitted *nothing at all* and was indistinguishable from a parked one
    // while the rival two car-lengths away threw sparks and smoke. Speed-scaled
    // so it disappears at a crawl and never fights the drift smoke.
    if (grounded && !drifting && dist < 75) {
      // Knee moved from 9 m/s to 13. The closeup frame is a 15.4 m/s cruise and
      // at the old knee that already evaluated to 0.4 — nearly half strength for
      // a kart that is not doing anything. This is a wake for a car that is
      // genuinely travelling, not a permanent haze; it now only really arrives
      // above about 60 km/h.
      const sr = THREE.MathUtils.clamp((speed - 13) / 16, 0, 1);
      if (sr > 0) {
        // 12/s, down from 21. This and idleExhaust are the two emitters that run
        // on a clean lap, and together they were the grey column standing behind
        // the kart in the closeup — on a shot that exists to show the bodywork.
        fx.rollAcc += dt * 12 * sr * lod;
        const n = Math.floor(fx.rollAcc);
        if (n > 0) { fx.rollAcc -= n; this.rollDust(k, fx, n, props.dustColor, sr); }
      } else {
        fx.rollAcc = 0;
      }
    } else {
      fx.rollAcc = 0;
    }

    // --- star power --------------------------------------------------------
    // No husk. A rainbow fresnel ellipsoid scaled to enclose the chassis is
    // geometrically INSIDE the kart for its whole life: it passes over the
    // helmet, through the roll bar and out in front of the wheels, and a
    // fresnel term draws its silhouette as a hard bright ring. That is the
    // "opaque plastic hula-hoop clipping through the chassis" the review
    // called a blocker, and no amount of tuning fixes an object whose shape is
    // wrong. Invincibility is now carried entirely by light: a shimmering
    // orbit of sparks with no rigid boundary, a hue-cycling pool on the road,
    // and a coloured lamp that puts the cycle onto the kart's own bodywork.
    if (k.starTime > 0) {
      fx.starAcc += dt * 58 * lod * this.emitScale;
      const n = Math.floor(fx.starAcc);
      if (n > 0) { fx.starAcc -= n; this.starSparkle(k, fx, n, now); }
      _col.setHSL((now * 0.55 + k.id * 0.13) % 1, 0.85, 0.60);
      if (dist < 50) {
        _p.copy(k.position); _p.y = fx.groundY + 0.75;
        this.lights.request(
          2000 + k.id, (k.isPlayer ? 170 : 50) - dist * 0.05, _p, _col,
          0.85 * (1 - dist / 50) * this.gain, 7.0);
      }
    } else {
      fx.starAcc = 0;
    }

    // --- spin-out stars ----------------------------------------------------
    if (k.stunTime > 0) {
      fx.stunPhase += dt * 5.4;
      fx.sparkleAcc += dt * 26 * lod * this.emitScale;
      const n = Math.floor(fx.sparkleAcc);
      if (n > 0) { fx.sparkleAcc -= n; this.stunStars(k, fx, n); }
    } else {
      fx.sparkleAcc = 0;
    }

    // tier bookkeeping for the burst on promotion is handled by the bus event
    fx.lastTier = k.driftTier;
  }

  // --- emitters ------------------------------------------------------------

  /**
   * `side` is -1 for the left contact patch and +1 for the right. The two
   * streams must not be identical: a single shared velocity makes both wheels
   * throw the same cone and the pair collapses into one clump under the middle
   * of the kart, which is exactly what the tier-2 shot showed.
   */
  private emitSparks(at: THREE.Vector3, k: IKart, n: number, tier: number, side: number) {
    // Colour comes from the kart's live tier channel, not from a value captured
    // at spawn — see EmitParams.channel and the drift-spark event.
    const col = C_CHANNEL;
    const channel = k.id + 1;
    // sparks fly backwards and away from the direction of the turn
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).multiplyScalar(-k.driftDir);
    const sp = 3.4 + tier * 1.1;
    // The outside wheel is the one loaded up, so it throws harder and wider.
    const outside = side === -k.driftDir ? 1.25 : 0.75;
    const splay = side * 1.6;

    const fx = this.state(k);
    // Sparks are struck off the road by the contact patch, so they belong to
    // the ROAD frame, not the kart's — but only mostly. A spark with zero
    // velocity inheritance is instantly stranded (a kart at 18 m/s outruns its
    // own sparks by five metres inside one 0.28 s life, which is why the tier-2
    // frame showed a lump of purple sitting on empty kerb with nothing near
    // it). A third of the kart's velocity, bled off by drag, puts the shower
    // where the eye expects it: streaming a metre or two off the tyre.
    //
    // 0.48, up from 0.34. At 0.34 a 0.30 s spark ends five and a half metres
    // behind the wheel that struck it, which is why the drift frame shows two
    // detached clusters sitting on bare kerb rather than a shower coming off
    // the car. Half the kart's velocity keeps the whole shower inside two
    // metres of the contact patch without making it look welded on.
    // 0.68, up from 0.48. The review is precise about the failure: "the sparks
    // are not attached to anything — they emit from a diffuse pool spread over
    // ~4 m of tarmac behind the kart". At 0.48 a spark keeps barely half the
    // car's speed, so it falls back 8 m/s relative to the wheel that struck it
    // and, over a 0.62 s tail, ends up four metres adrift. Two thirds keeps the
    // shower inside a metre and a half of the contact patch — close enough that
    // the eye reads a jet coming off a tyre rather than a stain on the road —
    // while still leaving a visible slip between the shower and the car.
    const keep = 0.68;

    // The tangential component: real sparks leave along the SLIP vector, not
    // along a fixed body axis. `slipx/slipz` is the part of the kart's velocity
    // that is sideways, which is the direction the rubber is actually being
    // dragged, so the cone off each tyre swings with the angle of the drift
    // instead of staying welded to the chassis.
    _r.crossVectors(UP, _fwd).normalize();
    const lat = k.velocity.x * _r.x + k.velocity.z * _r.z;
    const slipx = _r.x * lat * 0.32, slipz = _r.z * lat * 0.32;

    const p = this.particles.reset();
    p.channel = channel;
    p.tile = PTile.Core;
    p.mode = PMode.Stretch;
    // Sparks must streak along their own velocity or they read as evenly
    // scattered decorative confetti composited over the scene.
    p.stretch = 5.2;
    // 0.40, up from 0.30. Life is what buys the ARC: at 0.30 s under -14 m/s²
    // a spark falls 63 cm, which from a chase camera is barely a bend. At
    // 0.40 s it falls 1.1 m and the shower is visibly ballistic — thrown up
    // and out of the contact patch and curving back down into the road, which
    // is the shape the eye recognises as a spark and not as a floating mote.
    p.life = 0.40; p.lifeJitter = 0.55;
    // 0.055 m was grit — physically right and completely illegible. At the
    // chase rig's ~7 m a 0.055 m sprite is four pixels, so the review read the
    // whole tier-2 shower as "two dozen dust motes" and could not name the
    // tier. 0.16 + 0.05/tier puts a tier-2 core at ~0.26 m, which is ~35 px
    // wide before the 5.2x velocity stretch — a grain you can see across a
    // room, which is the bar this round was set.
    // TIER_FX.core: 0.20 / 0.28 / 0.36 m, a 1.8x span rather than the 1.5x the
    // old `0.16 + 0.05 * tier` gave. A grain that is nearly twice the area is
    // the cheapest legible difference between two showers that are otherwise
    // the same object, and it costs nothing — the sprite is already drawn.
    p.size0 = TIER_FX[tier].core; p.size1 = 0.018;
    // 0.4..1.6x. Uniformly-sized sparks are the other half of the confetti
    // read; real ones come off a tyre in a wide spread of masses.
    p.sizeJitter = 0.6;
    p.gravity = -14; p.drag = 1.5;
    // Tightened from 3.2 / 0.55. A 3.2 m/s isotropic jitter on a 4.5 m/s cone
    // is most of what turned two jets into one diffuse pool: the scatter was
    // comparable to the signal, so the shower had no direction left in it.
    p.posJitter = 0.08; p.velJitter = 1.9; p.velScatter = 0.38;
    p.fadeIn = 0.02;
    // Bias the count to the loaded outside wheel, not just its speed.
    p.count = Math.max(1, Math.round(n * 3 * (outside > 1 ? 1.35 : 0.7)));
    // SOFTNESS ZERO, and this is most of why the tier-2 shower was invisible.
    //
    // Every other emitter here wants the ground-plane fade — a smoke puff that
    // terminates on the intersection line with the tarmac is the loudest
    // amateur tell there is. A spark is not a volume. It is a point of light,
    // it has no silhouette to reveal, and it is BORN 4 cm off the road, which
    // with the old 0.28 m fade depth put it at smoothstep(-0.084, 0.238, 0.04)
    // = 0.28 of its authored alpha at birth. Sparks spent the first third of
    // their life at under a third strength, at exactly the moment they are
    // closest to the wheel and brightest — so the shower faded IN as it left
    // the car instead of being hottest at the contact patch. Zero disables both
    // soft tests; the camera-facing bias is kept, and raised, because that is
    // what stops a core being depth-rejected by the tyre it came off.
    this.particles.ground(fx.groundY, fx.groundN, 0, 0.16);
    this.particles.at(at.x, at.y, at.z);
    // A real 3D cone: backwards, outwards along the wheel's own side, and up.
    _r.crossVectors(UP, _fwd);
    this.particles.vel(
      k.velocity.x * keep - _fwd.x * sp * 0.75 + (_side.x * sp + _r.x * splay) * outside - slipx,
      k.velocity.y * keep + 2.5 + tier * 0.5,
      k.velocity.z * keep - _fwd.z * sp * 0.75 + (_side.z * sp + _r.z * splay) * outside - slipz);
    // 2.35, up from 1.30 — and the reasoning that produced 1.30 was half
    // right, so it is worth writing down which half.
    //
    // It is true that 2.2x a saturated primary tone maps toward white; that is
    // exactly what an incandescent particle should do at its CORE, and the
    // fragment shader already confines the whitening to a cubed sprite mask so
    // only the genuine pinpoint bleaches while the streak body keeps #ff9d2e.
    // What 1.30 actually bought was a spark that never reached the bloom gate.
    // Worked through for #ff9d2e at 1.30, through the additive shoulder in
    // Particles (rgb / (1 + rgb * uClip)) and onto a shadowed tarmac at ~0.3
    // scene-linear, the composited pixel has a luminance of 0.92 — and
    // PostFX's bloom threshold is 1.55. So NOTHING in a drift ever bloomed.
    // A spark that does not bloom is a coloured dot; the glow around it is the
    // entire difference between a spark and a dust mote, and the review used
    // that exact word.
    //
    // At 2.35 the same spark composites to ~1.6 luminance and clears the gate
    // by a nose, so the bloom is a halo on the hot cores only rather than a
    // wash over the whole shower. uClip in Particles came down from 0.19 to
    // 0.13 to give it the headroom (see the note there).
    // TIER_FX.spark: 2.25 / 2.55 / 2.85. A purple spark is a HOTTER spark, not
    // just a differently-coloured one — the ramp is what makes a tier-3 shower
    // bloom harder than a tier-1 one through PostFX's 1.55 gate, and bloom is
    // the difference between a coloured dot and a light.
    this.particles.colorA(col, TIER_FX[tier].spark, 1);
    this.particles.colorB(col, 0.70, 0);
    this.particles.emit(true);

    // Soft halo behind the cores — the "soft glow" half of art bible §6, and
    // the layer that carries the silhouette. A halo is a low-frequency wash of
    // pure tier colour, so it survives bloom, minification and motion blur
    // intact where a pinpoint core does not, and it is what makes the drift
    // read at a glance from the chase camera rather than only in a still at
    // 200%. Three per emission unit now, half again as large, and it keeps its
    // colour: the halo is deliberately held under the whitening point so the
    // shower is a coloured cloud with white sparks inside it.
    p.tile = PTile.Glow;
    p.mode = PMode.Billboard;
    p.stretch = 0;
    p.life = 0.30;
    p.size0 = TIER_FX[tier].halo; p.size1 = 0.10;
    p.count = n * 3;
    p.velJitter = 1.5; p.drag = 2.4;
    // The halo IS a volume — a metre-wide camera-facing disc born a few
    // centimetres off the tarmac — so unlike the cores it keeps a soft fade and
    // takes a generous camera bias, or the depth test slices its lower half off
    // against the road and leaves a hard horizontal cut. Spawned 12 cm higher
    // than the cores for the same reason.
    //
    // 0.55 m of fade depth, not 0.16. At 0.16 the fade window is 18 cm wide on a
    // disc that is a metre across, which is not a soft particle, it is a hard
    // edge with a bevel: the review reads exactly that as "the blue spark cloud
    // terminates in a hard straight cut line where the billboard quad intersects
    // the road plane". The fade has to be comparable to the sprite, not to the
    // spawn height.
    this.particles.ground(fx.groundY, fx.groundN, 0.55, 0.34);
    this.particles.at(at.x, at.y + 0.12, at.z);
    this.particles.colorA(col, 1.80, 0.62);
    this.particles.colorB(col, 0.38, 0);
    this.particles.emit(true);

    // A steady lamp at the contact patch itself: the tier colour has to be
    // legible even in the frames between spark spawns. This is the one part of
    // the drift that is guaranteed present in EVERY frame of a slide, so it is
    // what a still capture is most likely to catch, and it was the dimmest
    // thing here.
    p.tile = PTile.Glow;
    p.life = 0.12; p.lifeJitter = 0.1;
    p.size0 = 0.78 + 0.28 * tier; p.size1 = 0.52;
    p.gravity = 0; p.drag = 6; p.velJitter = 0; p.posJitter = 0.04;
    p.count = 1; p.fadeIn = 0.2;
    // Same reasoning as the halo above: a 1.2 m disc needs a fade of the same
    // order as its own size or it terminates on the road in a straight line.
    this.particles.ground(fx.groundY, fx.groundN, 0.70, 0.38);
    this.particles.at(at.x, at.y + 0.14, at.z);
    this.particles.vel(k.velocity.x * 0.9, 0.4, k.velocity.z * 0.9);
    this.particles.colorA(col, 1.45, 0.70);
    this.particles.colorB(col, 0.42, 0);
    // DENSITY, SPENT EXACTLY ONCE — and this lamp was the one emitter in the
    // file spending it zero times.
    //
    // Every other layer here hands `emit` a count above one, so the density
    // multiplier lands on the count. This one is deliberately a single sprite,
    // and `emit` floors a single-particle spawn back up to one so a low setting
    // still gets the readability cue. Correct for a one-shot; wrong for
    // something emitted once per wheel per frame for the whole of every drift.
    // The result was two additive particles per drifting kart per frame at ANY
    // quality — sixteen a frame across the field, a fifth of the Low tier's
    // entire 75-spawn ceiling, held at full rate while the shower they sit
    // inside was thinned to 21%.
    //
    // A stochastic gate spends the density on the RATE instead, which is the
    // rule Particles states. It keeps the cue: at Low the lamp lands on about a
    // fifth of frames and lives 0.12 s, so there is still one on the road
    // essentially all the time — it is simply no longer the most expensive
    // thing in a tier-3 drift.
    if (Math.random() < this.emitScale) this.particles.emitExact(true);

    // Ricochets: a handful of grains per emission that survive longer, drag
    // almost nothing and arc out clear of the kart. Real sparks are not a
    // uniform population — the shower has a bright dense root and a scatter of
    // stragglers arcing away from it.
    //
    // 0.44 s and drag 0.9, down from 0.95 s (up to 1.43 with jitter) and drag
    // 0.45. THIS emitter was the diffuse four-metre pool in the review frame,
    // not the shower: a near-dragless grain living a second and a half at
    // 10 m/s relative to a car that is also moving ends up wherever it likes,
    // and there were enough of them to read as the main event. They still reach
    // furthest from the car; they just no longer outlive the drift itself.
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 4.0;
    p.life = 0.44; p.lifeJitter = 0.45;
    p.size0 = 0.075 + 0.02 * tier; p.size1 = 0.012; p.sizeJitter = 0.5;
    p.gravity = -16; p.drag = 0.9;
    p.velJitter = 3.0; p.velScatter = 0.55; p.posJitter = 0.10;
    p.count = Math.max(1, n >> 1);
    // Pinpoints again: back to no soft fade, small bias.
    this.particles.ground(fx.groundY, fx.groundN, 0, 0.14);
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(
      k.velocity.x * keep - _fwd.x * sp * 0.6 + (_side.x * sp * 1.5 + _r.x * splay) * outside - slipx,
      k.velocity.y * keep + 4.4 + tier * 0.7,
      k.velocity.z * keep - _fwd.z * sp * 0.6 + (_side.z * sp * 1.5 + _r.z * splay) * outside - slipz);
    this.particles.colorA(col, 2.10, 1);
    this.particles.colorB(col, 0.45, 0);
    this.particles.emit(true);
  }

  /**
   * The coloured pool the sparks throw onto the road. Ground-aligned additive
   * quads under each rear contact patch: no silhouette, cannot intersect the
   * kart, and it works identically whether or not the light budget could take a
   * real PointLight. Art bible §6 calls for a ground-scorch decal under drift
   * sparks; the decal layer is multiplicative so it can only darken, which is
   * why the *bright* half of that note has to be a particle.
   */
  private groundPool(k: IKart, fx: KartFx, tier: number) {
    const col = C_CHANNEL;
    const prof = TIER_FX[tier];
    const p = this.particles.reset();
    p.channel = k.id + 1;
    p.tile = PTile.Glow; p.mode = PMode.Ground;
    p.life = 0.30; p.lifeJitter = 0.25;
    // 1.0 / 1.45 / 2.0 on the size and 0.88 / 1.34 / 1.92 on the radiance. A
    // tier-3 pool covers four times the tarmac of a tier-1 one at twice the
    // brightness, which is the "ground glow under the sparks at higher tiers"
    // §6 asks for and what the escalation reads as at thumbnail size — it is
    // the only part of the drift that is a large low-frequency shape, so it is
    // the part that survives minification, bloom and motion blur intact.
    p.size0 = 0.80 * prof.poolS; p.size1 = 1.65 * prof.poolS; p.sizeJitter = 0.25;
    p.drag = 1.4; p.gravity = 0; p.spin = 0.9;
    p.posJitter = 0.12; p.count = 1; p.camBias = 0.07; p.fadeIn = 0.12;
    // Inherits the kart's velocity so the pool tracks the car instead of being
    // left behind as a stationary blob of light on empty tarmac.
    this.particles.vel(k.velocity.x * 0.75, 0, k.velocity.z * 0.75);
    // Roughly 1.6x the round-5 values. This is the part of the drift that lands
    // ON the road rather than in the air, so it is what puts tier colour into
    // the tarmac's own specular and what survives at thumbnail size — art bible
    // §9.1. It is a ground-aligned quad with no edge, so it cannot intersect
    // anything and cannot acquire a silhouette however bright it gets.
    this.particles.colorA(col, 0.62 * prof.poolI, 0.52);
    this.particles.colorB(col, 0.16, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, fx.groundY + 0.04, at.z);
      this.particles.emitExact(true);
    }
  }

  /**
   * The rising ember jet — the tier-2/3 half of the escalation, and the only
   * part of a drift that grows UPWARD.
   *
   * Physically these are the grains that come off the contact patch steeply
   * enough to escape the wake. They are given almost no drag and a real gravity
   * so they describe a visible parabola about a metre and a half tall, and they
   * live long enough (0.7 s) to be at the top of it while the next batch is
   * still leaving the tyre — so the jet is a standing column rather than a
   * sequence of puffs, which is what makes it read as a state the player is
   * holding rather than an event that keeps happening.
   *
   * On the live tier channel, so a promotion to 3 re-hues a jet already in the
   * air; on Streak so it elongates along its own velocity and stays legible
   * through motion blur.
   */
  private driftJet(k: IKart, fx: KartFx, n: number, tier: number) {
    const col = C_CHANNEL;
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    const prof = TIER_FX[tier];
    const p = this.particles.reset();
    p.channel = k.id + 1;
    p.tile = PTile.Streak; p.mode = PMode.Stretch; p.stretch = 3.4;
    p.life = 0.70; p.lifeJitter = 0.35;
    p.size0 = 0.075 + 0.030 * tier; p.size1 = 0.014; p.sizeJitter = 0.5;
    p.gravity = -11; p.drag = 0.55;
    p.posJitter = 0.10; p.velJitter = 1.5; p.velScatter = 0.30; p.fadeIn = 0.05;
    p.count = Math.max(1, n);
    // Pinpoints: no ground fade (they are light, not volume), small bias so the
    // tyre that threw them cannot depth-reject them.
    this.particles.ground(fx.groundY, fx.groundN, 0, 0.16);
    this.particles.colorA(col, 2.0 + 0.30 * tier, 1);
    this.particles.colorB(col, 0.55, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.05, at.z);
      // Two thirds of the car's speed so the column stays with the kart, plus a
      // hard vertical component and a slight outward splay off each wheel.
      this.particles.vel(
        k.velocity.x * 0.66 + _side.x * (s === 0 ? -1.5 : 1.5) - _fwd.x * 1.2,
        k.velocity.y * 0.66 + 6.2 + 0.9 * prof.jet,
        k.velocity.z * 0.66 + _side.z * (s === 0 ? -1.5 : 1.5) - _fwd.z * 1.2);
      this.particles.emitExact(true);
    }
  }

  /**
   * Thin tyre-contact veil under a kart that is simply travelling fast. Every
   * other emitter in this file needs the kart to be drifting, boosting, stunned
   * or off-road, so a clean fast lap emitted nothing and the frame had no sense
   * of speed outside the HUD number.
   */
  private rollDust(k: IKart, fx: KartFx, n: number, dust: THREE.Color, sr: number) {
    const road = fx.surface === Surface.Road || fx.surface === Surface.Boost;
    // Cool on tarmac, the surface's own colour off it, and only lightly warmed
    // in albedo — the key light does the warming now (see tyreSmoke).
    _col.copy(road ? C_SMOKE_TARMAC : dust).lerp(this.sunColor, 0.16);
    _fwd.copy(k.forward);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    // 8 m of veil, not 0.55 s of it. This emitter runs on every kart on every
    // clean lap, so it is the single biggest producer of stranded puffs: at
    // 25 m/s a 0.55 s world-frame puff ends eleven metres back, which is the
    // chain of detached blobs strung out behind the pack in the pack frame.
    p.life = trailLife(Math.abs(k.forwardSpeed), 7, 0.22, 0.5); p.lifeJitter = 0.35;
    p.size0 = 0.14; p.size1 = 0.62 + 0.42 * sr; p.sizeJitter = 0.45;
    p.gravity = 0.7; p.drag = 2.6; p.spin = 1.3;
    p.posJitter = 0.16; p.velJitter = 0.9; p.fadeIn = 0.14;
    p.count = n;
    this.particles.ground(fx.groundY, fx.groundN, 0.9, 0.30);
    // Still a veil that says "moving" rather than a smoke screen — but a
    // legible one. The pack shot came back with eight karts running over
    // perfectly clean air; at 0.11 base alpha through the grade this layer was
    // below the dither floor. Art bible §6 asks for dust and grit kicked up by
    // the pack and this emitter is the whole of it on tarmac.
    //
    // 0.17/0.21 overshot the other way: on the hero and pack frames it printed
    // as detached grey smudges lying on the tarmac behind the field rather than
    // as air being disturbed. Split the difference — still comfortably above
    // the 0.11 that was invisible.
    // 0.08 + 0.10, down from 0.13 + 0.17. This runs on every kart on every clean
    // lap; the alpha that makes one puff legible makes twenty of them a wall.
    this.particles.colorA(_col, 1.0, 0.08 + 0.10 * sr);
    this.particles.colorB(_col, 0.8, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.10, at.z);
      this.particles.vel(
        k.velocity.x * 0.62 - _fwd.x * 1.6, 0.7, k.velocity.z * 0.62 - _fwd.z * 1.6);
      this.particles.emit(false);
    }

    // GRIT. The veil above is low-frequency and reads as air; a road also
    // throws hard little pieces of itself, and they are what give the wake
    // texture at the resolution the camera actually sees. Ballistic, short,
    // opaque, sun-lit, and few — a couple per emission on the loaded wheel
    // only. Art bible §6 names dust *and* grit; only the dust existed.
    if (sr > 0.35) {
      p.tile = PTile.Splash; p.mode = PMode.Billboard;
      p.life = 0.34; p.lifeJitter = 0.4;
      p.size0 = 0.05; p.size1 = 0.10; p.sizeJitter = 0.6;
      p.gravity = -9; p.drag = 0.9; p.spin = 4;
      p.posJitter = 0.16; p.velJitter = 2.4; p.fadeIn = 0.02;
      p.count = Math.max(1, n >> 1);
      this.particles.ground(fx.groundY, fx.groundN, 0.18, 0.10);
      _col2.copy(road ? C_DEBRIS : dust).lerp(this.sunColor, 0.30);
      this.particles.colorA(_col2, 1.0, 0.85 * sr);
      this.particles.colorB(_col2, 0.85, 0);
      const at = Math.random() < 0.5 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.06, at.z);
      this.particles.vel(
        k.velocity.x * 0.55 - _fwd.x * 2.2, 2.6, k.velocity.z * 0.55 - _fwd.z * 2.2);
      this.particles.emit(false);
    }
  }

  /**
   * World-space rush lines. Thin additive streaks seeded in an annulus around
   * the kart's own axis, a dozen metres ahead of it, travelling backwards fast
   * enough that PMode.Stretch elongates them along their screen-space velocity —
   * which, for anything running down the road toward a chase camera, is a ray
   * out of the vanishing point. That is a radial speed line, drawn in the scene.
   *
   * They are deliberately NOT given the kart's velocity: the length of a
   * stretched sprite is a function of its own world speed, and a streak that
   * inherited 33 m/s forward and then subtracted it would be nearly stationary
   * in world terms and would not stretch at all. 26 m/s backwards is what buys
   * both the elongation and the pass.
   *
   * Cost: ~9 live sprites per 0.1 s at full ramp, player only, off entirely
   * below 70% of top speed. Nothing here allocates.
   */
  private slipstream(k: IKart, n: number, ramp: number, boosting: boolean) {
    const fx = this.state(k);
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    _r.crossVectors(_fwd, _side).normalize();
    // A SPEED STREAK IS A VALUE CUE, NOT AN OBJECT.
    //
    // This used to be C_TIER[1] under boost — #4fc3ff, a fully saturated cyan,
    // and on golden-hour tarmac the single hue in the palette that cannot be
    // mistaken for anything atmospheric. Sitting at road height it read as
    // paint. Air moving past the lens is near-white with the faintest warm cast
    // from the key; the *speed* has to come from length and motion, not from
    // colour. Art bible section 6: "they frame, they don't obscure."
    _col.copy(C_SPARK_WHITE).lerp(C_SUNMOTE, boosting ? 0.25 : 0.55);

    const p = this.particles.reset();
    p.tile = PTile.Streak; p.mode = PMode.Stretch;
    // Under boost the streak is both longer per unit of speed and physically
    // bigger. This is the world-space half of "radial speed lines" and it is
    // the half that has real perspective and real occlusion behind the kart,
    // so it is what makes the screen-space comb in PostFX read as air moving
    // rather than as a filter laid over the picture.
    p.stretch = boosting ? 5.6 : 4.2;
    // Shorter, and seeded further out (see `ahead` below), so a streak dies of
    // old age at roughly the distance the chase camera sits rather than sailing
    // through the lens as a frame-wide bar.
    p.life = 0.30; p.lifeJitter = 0.28;
    // SCALES HARD WITH THE RAMP, and almost nothing sits under it. The old
    // 0.062 + 0.024 * ramp was a 40% span: at three-quarter pace a streak was
    // 0.07 m across, which at the 12-27 m it is seeded at is four pixels before
    // the stretch and vanishes into the tarmac's own aliasing. The span is 0.055
    // to 0.130 now, so the difference between "fast" and "flat out" is a factor
    // of two and a bit in every dimension of the cue at once — length, width,
    // count and opacity — which is what makes it read as the world moving
    // rather than as a particle setting.
    p.size0 = (0.055 + 0.075 * ramp) * (boosting ? 1.7 : 1); p.size1 = 0.02; p.sizeJitter = 0.5;
    p.gravity = 0; p.drag = 0.05; p.spin = 0;
    p.fadeIn = 0.16; p.count = 1;
    // Still low in absolute terms and still scaled by the shared additive gain:
    // three of these overlapping must not add up to a wipe across the road. What
    // changed is the SPAN — at ramp 0 they are fainter than before, at ramp 1
    // they are about 1.6x, so the cue has a bottom as well as a top.
    const rushI = (0.75 + 0.85 * ramp) * (boosting ? 1.65 : 1);
    this.particles.colorA(_col, rushI, (0.06 + 0.42 * ramp) * (boosting ? 1.55 : 1));
    this.particles.colorB(_col, 0.20, 0);
    // A generous camera-ward bias and a real soft fade against the road plane.
    // Without them a streak that grazes the tarmac is depth-tested against it
    // and terminates on the intersection line, which is most of why these read
    // as track markings rather than as air.
    this.particles.ground(fx.groundY, fx.groundN, 0.9, 0.30);

    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      // Annulus, not a disc: nothing spawns on the axis, so the middle of the
      // frame — where the kart and the racing line are — stays clear. Boost
      // tightens the annulus toward the axis: converging lines read as speed,
      // a wide ring reads as weather.
      const rad = (boosting ? 1.7 : 2.3) + Math.random() * 3.0;
      const ahead = 12 + Math.random() * 15;
      _p.copy(k.position)
        .addScaledVector(_fwd, ahead)
        .addScaledVector(_side, Math.cos(a) * rad)
        // Vertical component biased ENTIRELY POSITIVE. The annulus used to be
        // centred on the kart's own axis, so half of every ring was spawned
        // below it — which on a kart sitting 40 cm off the deck means half the
        // streaks were born at or under road height. Depth-tested against the
        // tarmac and lying in its plane, those are the two flat cyan stripes
        // painted across the road in the boost frame. Speed lines belong in the
        // air between 0.5 m and 3 m above the surface and nowhere else.
        .addScaledVector(_r, 0.55 + (0.5 + 0.5 * Math.sin(a)) * rad * 0.62);
      // Belt and braces: whatever the track is doing underneath, never below
      // half a metre off it.
      _p.y = Math.max(_p.y, fx.groundY + 0.55);
      this.particles.at(_p.x, _p.y, _p.z);
      const rv = boosting ? 36 : 26;
      this.particles.vel(-_fwd.x * rv, -_fwd.y * rv, -_fwd.z * rv);
      // The rate above already spent the density; `emit` would spend it twice
      // and Medium would get 0.13 of the authored streaks instead of 0.36.
      this.particles.emitExact(true);
    }
  }

  private burstSparks(at: THREE.Vector3, n: number, intensity: number, channel: number,
                      fx?: KartFx, k?: IKart) {
    const col = C_CHANNEL;
    const p = this.particles.reset();
    p.channel = channel;
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 4.0;
    p.life = 0.62; p.lifeJitter = 0.45;
    p.size0 = 0.17; p.size1 = 0.018; p.sizeJitter = 0.55;
    p.gravity = -13; p.drag = 1.1;
    p.posJitter = 0.12; p.velJitter = 9.0; p.fadeIn = 0.02; p.count = n;
    // Softness 0 for the same reason as the steady shower: a spark is a point
    // of light with no volume to fade, and the ground plane was eating three
    // quarters of the burst's alpha in the frames right after the promotion.
    if (fx) this.particles.ground(fx.groundY, fx.groundN, 0, 0.16);
    this.particles.at(at.x, at.y, at.z);
    const keep = k ? 0.34 : 0;
    this.particles.vel(
      k ? k.velocity.x * keep : 0, (k ? k.velocity.y * keep : 0) + 3.4, k ? k.velocity.z * keep : 0);
    // Same ceiling as the steady shower — see emitSparks for the arithmetic on
    // why the previous 1.45 left the burst below PostFX's bloom gate.
    this.particles.colorA(col, 1.95 * intensity, 1);
    this.particles.colorB(col, 0.70, 0);
    this.particles.emit(true);

    // Coloured shell around the burst. Without it a promotion is a puff of
    // white grit; with it the flash itself is blue / orange / purple, which is
    // the read art bible §6 asks a tier change to deliver.
    p.tile = PTile.Glow; p.mode = PMode.Billboard; p.stretch = 0;
    p.life = 0.34; p.lifeJitter = 0.4;
    p.size0 = 0.52; p.size1 = 0.12; p.sizeJitter = 0.5;
    p.gravity = -3; p.drag = 2.6; p.velJitter = 4.6;
    p.count = Math.max(2, n >> 1);
    this.particles.colorA(col, 1.75 * intensity, 0.66);
    this.particles.colorB(col, 0.38, 0);
    this.particles.emit(true);
  }

  private tyreSmoke(k: IKart, fx: KartFx, at: THREE.Vector3, n: number, dust: THREE.Color,
                    tier: number) {
    // SURFACE-KEYED, AND ONLY LIGHTLY WARMED.
    //
    // Tarmac gets the cool rubber grey; everything else gets the surface's own
    // dust colour from SURFACE_PROPS. The old 0.42 lerp toward the key light was
    // trying to do the lighting's job in the albedo and landed the whole cloud
    // on #d5c4a8 — dry dirt — whatever it was actually driving on. 0.14 is a
    // hint of ambient warmth; the sun side is now carried by the wrap/backscatter
    // term in the particle shader, which varies across the puff the way real
    // light does.
    const onRoad = fx.surface === Surface.Road || fx.surface === Surface.Boost;
    _col.copy(onRoad ? C_SMOKE_TARMAC : dust).lerp(this.sunColor, 0.14);
    // 18% toward the live tier, so a tier-3 drift smokes faintly violet and the
    // charge is legible even in the smoke — art bible §6 wants the tier readable
    // at a glance, and the smoke is the largest thing a drift puts on screen.
    if (tier > 0) _col.lerp(C_TIER[Math.min(3, tier)], 0.18);
    _col2.copy(_col).lerp(C_SMOKE_DARK, 0.5);
    const speed = Math.abs(k.forwardSpeed);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    // Budgeted at 17 m behind the tyre — see trailLife. At a 25 m/s drift that
    // is 0.68 s rather than the 1.25 s (up to 1.8 s with jitter) that stranded
    // puffs forty metres back with no kart under them.
    p.life = trailLife(speed, 17, 0.42, 1.25); p.lifeJitter = 0.32;
    // Wide per-particle scale and rotation spread: a cloud of identically sized
    // puffs turning at the same rate has no internal structure and reads as one
    // flat decal, which is exactly how the drift smoke was landing. Grows
    // faster to compensate for the shorter life, so the cloud has the same
    // volume packed into a tighter, kart-attached column.
    p.size0 = 0.55; p.size1 = 2.9; p.sizeJitter = 0.65;
    p.gravity = 1.1; p.drag = 1.7; p.spin = 1.5;
    p.posJitter = 0.30; p.velJitter = 1.5; p.velScatter = 0.35; p.fadeIn = 0.10;
    // Deeper soft fade so the puff dissolves into the tarmac over a metre
    // instead of terminating on the intersection line, plus a generous
    // camera-ward bias — a 2.9 m puff has a lot of quad to get caught on.
    this.particles.ground(fx.groundY, fx.groundN, 1.15, 0.40);
    p.count = n;
    _fwd.copy(k.forward);
    // STRICTLY BEHIND THE CONTACT PATCH. The review has the drift smoke sitting
    // beside and slightly *ahead* of the kart, which is what an emitter seeded
    // on the patch itself does once the puff's own outward jitter is added: half
    // of the cloud is born forward of where the rubber is. Backing the seed off
    // 45 cm along -forward puts every puff in the wake at birth.
    this.particles.at(
      at.x - _fwd.x * 0.45, at.y + 0.26, at.z - _fwd.z * 0.45);
    // The kart's velocity MINUS the slip vector: the smoke leaves with the car
    // but not with the part of the car's motion that is sideways, which is the
    // component the tyre is fighting. That difference is what makes a cloud read
    // as being torn off rubber rather than as being carried along by it.
    _side.crossVectors(UP, _fwd).normalize();
    const latv = k.velocity.x * _side.x + k.velocity.z * _side.z;
    this.particles.vel(
      k.velocity.x * 0.50 - _side.x * latv * 0.30 - _fwd.x * 2.0,
      1.5,
      k.velocity.z * 0.50 - _side.z * latv * 0.30 - _fwd.z * 2.0);
    // 0.55, not 0.85. Individually opaque puffs read as popcorn; the cloud has
    // to be built out of many translucent ones or the lighting model in
    // Particles has nothing to shade through — and the two-lobe warm/cool split
    // §6 asks for only exists in the overlap of translucent layers.
    this.particles.colorA(_col, 1.0, 0.55);
    this.particles.colorB(_col2, 0.85, 0);
    this.particles.emit(false);
  }

  /**
   * Grit torn out of the contact patch by a slide. Alpha-blended and lit (so it
   * takes the low sun like everything else made of matter), ballistic, short,
   * and thrown forward-of-sideways along the slip vector rather than straight
   * back — a sliding tyre flings the surface out of the corner, not down the
   * road behind it.
   */
  private driftGrit(k: IKart, fx: KartFx, n: number, dust: THREE.Color, slip: number) {
    const road = fx.surface === Surface.Road || fx.surface === Surface.Boost;
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    const lat = k.velocity.x * _side.x + k.velocity.z * _side.z;
    _col.copy(road ? C_DEBRIS : dust).lerp(this.sunColor, 0.28);
    const p = this.particles.reset();
    p.tile = PTile.Splash; p.mode = PMode.Billboard;
    p.life = 0.40; p.lifeJitter = 0.4;
    p.size0 = 0.055; p.size1 = 0.11; p.sizeJitter = 0.6;
    p.gravity = -10; p.drag = 0.8; p.spin = 5;
    p.posJitter = 0.14; p.velJitter = 2.8; p.fadeIn = 0.02;
    p.count = Math.max(1, n);
    this.particles.ground(fx.groundY, fx.groundN, 0.18, 0.10);
    this.particles.colorA(_col, 1.0, 0.55 + 0.35 * slip);
    this.particles.colorB(_col, 0.85, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.05, at.z);
      this.particles.vel(
        k.velocity.x * 0.5 - _side.x * lat * 0.8 - _fwd.x * 1.4,
        3.0,
        k.velocity.z * 0.5 - _side.z * lat * 0.8 - _fwd.z * 1.4);
      this.particles.emitExact(false);
    }
  }

  private tyreSmokePuff(k: IKart, fx: KartFx, n: number, size: number) {
    this.rearPoints(k, fx);
    this.particles.reset();
    const speed = Math.abs(k.forwardSpeed);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      const p = this.particles.p;
      // Fired on boost ignition, i.e. at the highest speed the kart ever sees.
      // A 0.95 s world-static puff at 33 m/s is thirty metres of orphan.
      p.tile = PTile.Smoke; p.life = trailLife(speed, 14, 0.34, 0.95); p.lifeJitter = 0.3;
      // TERMINAL SIZE IS CAPPED BY WHAT THE CHASE CAMERA CAN TAKE, not by how
      // much smoke a boost "should" make.
      //
      // This fires on mini-turbo ignition — corner exit, which is precisely
      // where the chase camera is closest to the rear axle and pointing along
      // it. At 2.2 * 1.4 with a 0.5 jitter a single puff reached 4.6 m across,
      // and sixteen of them arrived at once, two metres from the lens. The
      // tunnel corner came back with the exit arch, both rivals and half the
      // frame behind a wall of cotton wool; it is the same puff that was
      // washing the kart out on boost.
      //
      // 1.5 with a 0.4 jitter tops out at ~2.9 m — still wider than the kart is
      // long, so the ignition still reads as a bloom of smoke — and the alpha
      // comes down to the 0.55 the drift smoke already uses for the reason
      // documented there: the two-lobe lighting in Particles only exists in the
      // overlap of translucent layers, so opaque puffs both hide the frame and
      // defeat their own shading.
      p.size0 = 0.5 * size; p.size1 = 1.5 * size; p.sizeJitter = 0.4;
      p.gravity = 0.8; p.drag = 2.2; p.spin = 1.6;
      p.posJitter = 0.24; p.velJitter = 1.8; p.fadeIn = 0.1;
      p.count = n;
      this.particles.ground(fx.groundY, fx.groundN, 1.1, 0.38);
      _col.copy(C_SMOKE).lerp(this.sunColor, 0.30);
      this.particles.at(at.x, at.y + 0.28, at.z);
      this.particles.vel(k.velocity.x * 0.55, 1.7, k.velocity.z * 0.55);
      this.particles.colorA(_col, 1.0, 0.55);
      this.particles.colorB(C_SMOKE_DARK, 0.9, 0);
      this.particles.emit(false);
    }
  }

  private groundPuff(k: IKart, fx: KartFx, n: number, size: number) {
    const props = SURFACE_PROPS[fx.surface] ?? SURFACE_PROPS[Surface.Road];
    _col.copy(fx.surface === Surface.Road ? C_SMOKE : props.dustColor);
    const speed = Math.abs(k.forwardSpeed);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = trailLife(speed, 13, 0.34, 0.9); p.lifeJitter = 0.32;
    p.size0 = 0.4 * size; p.size1 = 2.0 * size; p.sizeJitter = 0.35;
    p.gravity = 0.4; p.drag = 2.6; p.spin = 1.1;
    p.posJitter = 0.5; p.velJitter = 2.2; p.velScatter = 0.5; p.fadeIn = 0.08;
    p.count = n;
    this.particles.ground(fx.groundY, fx.groundN, 1.10, 0.30);
    this.particles.at(k.position.x, fx.groundY + 0.12, k.position.z);
    // A landing throws its dust forward with the kart. Emitted world-static, a
    // hop puff is dropped on the road behind and reads as belonging to nothing.
    this.particles.vel(k.velocity.x * 0.5, 1.0, k.velocity.z * 0.5);
    this.particles.colorA(_col, 0.95, 0.45);
    this.particles.colorB(_col, 0.7, 0);
    this.particles.emit(false);

    // A pair of discs pinned flat to the ground: they read as dust spreading
    // out along the tarmac rather than a ball of it hanging in the air.
    p.mode = PMode.Ground;
    p.life = 0.7; p.size0 = 0.9 * size; p.size1 = 3.4 * size;
    p.gravity = 0; p.drag = 3.4; p.velJitter = 0; p.spin = 0.6;
    p.posJitter = 0.25; p.softness = 0; p.camBias = 0.07;
    p.count = Math.max(1, n >> 2);
    this.particles.at(k.position.x, fx.groundY + 0.05, k.position.z);
    this.particles.vel(0, 0, 0);
    this.particles.colorA(_col, 0.95, 0.32);
    this.particles.colorB(_col, 0.7, 0);
    this.particles.emit(false);
  }

  private surfaceDust(k: IKart, fx: KartFx, n: number, dust: THREE.Color, heavy: boolean) {
    _fwd.copy(k.forward);
    const speed = Math.abs(k.forwardSpeed);
    const p = this.particles.reset();
    p.tile = heavy ? PTile.Splash : PTile.Smoke;
    // Off-track dust legitimately hangs — but only within sight of whatever
    // kicked it up. 20 m for the light cloud, 11 m for the heavy grains.
    p.life = heavy ? trailLife(speed, 11, 0.30, 0.75) : trailLife(speed, 20, 0.45, 1.3);
    p.lifeJitter = 0.3;
    p.size0 = heavy ? 0.22 : 0.4; p.size1 = heavy ? 0.5 : 2.6; p.sizeJitter = 0.4;
    p.gravity = heavy ? -6.5 : 0.5; p.drag = heavy ? 1.4 : 1.7; p.spin = 1.0;
    p.posJitter = 0.22; p.velJitter = heavy ? 2.6 : 1.2; p.fadeIn = 0.1;
    p.count = n;
    this.particles.ground(fx.groundY, fx.groundN, heavy ? 0.35 : 1.10, heavy ? 0.14 : 0.34);
    this.particles.colorA(dust, heavy ? 1.0 : 0.95, heavy ? 0.85 : 0.5);
    this.particles.colorB(dust, 0.75, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.06, at.z);
      // Grains are thrown by the tyre and keep most of its speed; the light
      // cloud is torn off the surface and keeps rather less.
      const keep = heavy ? 0.72 : 0.45;
      this.particles.vel(
        k.velocity.x * keep - _fwd.x * 2.6, heavy ? 3.2 : 1.1, k.velocity.z * keep - _fwd.z * 2.6);
      this.particles.emit(false);
    }
  }

  private waterSpray(k: IKart, fx: KartFx, n: number) {
    _fwd.copy(k.forward);
    const p = this.particles.reset();
    p.tile = PTile.Splash;
    p.life = 0.65; p.lifeJitter = 0.35;
    p.size0 = 0.2; p.size1 = 0.62; p.sizeJitter = 0.4;
    p.gravity = -11; p.drag = 1.0; p.spin = 1.4;
    p.posJitter = 0.22; p.velJitter = 2.6; p.fadeIn = 0.06;
    p.count = n;
    this.particles.ground(fx.groundY, fx.groundN, 0.35, 0.12);
    this.particles.colorA(C_FOAM, 1.05, 0.9);
    this.particles.colorB(C_WATER, 0.9, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, fx.groundY + 0.06, at.z);
      // Water thrown off a tyre leaves at the rim speed, not at rest.
      this.particles.vel(
        k.velocity.x * 0.65 - _fwd.x * 3.2, 4.2, k.velocity.z * 0.65 - _fwd.z * 3.2);
      this.particles.emit(false);
    }
    // a few additive highlights so the spray catches the low sun
    p.tile = PTile.Glow;
    p.life = 0.4; p.size0 = 0.14; p.size1 = 0.03;
    p.count = Math.max(1, n >> 1);
    this.particles.colorA(C_FOAM, 1.8, 0.8);
    this.particles.colorB(C_WATER, 0.6, 0);
    this.particles.at(this.skidLRef.x, fx.groundY + 0.1, this.skidLRef.z);
    this.particles.emit(true);
  }

  /**
   * Resolve the kart model's own exhaust anchors once. KartModel publishes
   * `root.userData.exhausts` — two Object3Ds at the stack tips whose +Z points
   * the way the gas leaves — and using them is the difference between a flame
   * welded to the pipe and a flame born inside the bodywork.
   *
   * The hardcoded fallback this replaces put the plume root at
   * `-0.85 forward, ±0.34 lateral, +0.58 up`, against a real stack tip at
   * `(±0.235, 0.855, -1.12)`: 27 cm too far forward and 28 cm too LOW, i.e.
   * inside the rear bodywork. The ribbon grows backwards toward a chase camera,
   * so its first metre — the bright root, the only part that is not
   * foreshortened into a stub — was being depth-rejected by the rear bumper.
   * That is why the boost review frame has no flame in it at all.
   */
  private resolveStacks(k: IKart, fx: KartFx) {
    if (fx.stacksResolved) return;
    fx.stacksResolved = true;
    const root = k.object;
    if (!root) return;
    // Only the names are contract; `object` is the physics group, and the model
    // root (which carries `userData.exhausts`) is two levels down inside it.
    fx.stackNode[0] = root.getObjectByName('exhaustL') ?? null;
    fx.stackNode[1] = root.getObjectByName('exhaustR') ?? null;
  }

  /**
   * World-space mouth of exhaust stack `s` (0 = left, 1 = right), written into
   * `out`, with the anchor's own forward — the direction the gas leaves —
   * written into `outAxis` when one is supplied.
   *
   * Falls back to the chassis basis for any model that does not publish the
   * anchors. `_fwd` and `_side` must already hold that basis.
   */
  private stackMouth(k: IKart, s: number, out: THREE.Vector3, outAxis?: THREE.Vector3) {
    const fx = this.state(k);
    this.resolveStacks(k, fx);
    const node = fx.stackNode[s];
    if (node) {
      // Resolved through the live world matrix rather than from a cached local
      // offset: the stacks are children of the *body*, which rolls into corners
      // and pitches under power, and a flame that ignores that detaches from
      // the pipe in exactly the frames the kart is most animated.
      node.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(node.matrixWorld);
      if (outAxis) {
        // The anchor's +Z is authored along the exhaust exit vector (up and
        // rearward), so it splays the tongue clear of the bodywork for free.
        outAxis.set(
          node.matrixWorld.elements[8], node.matrixWorld.elements[9], node.matrixWorld.elements[10],
        ).normalize();
      }
      return out;
    }
    // Matches KartModel's own stack tips: (±0.235, 0.855, −1.12), −Z rearward.
    out.copy(k.position)
      .addScaledVector(_fwd, -1.12)
      .addScaledVector(_side, s === 0 ? -0.235 : 0.235);
    out.y += 0.855;
    if (outAxis) {
      outAxis.copy(_fwd).multiplyScalar(-0.836).addScaledVector(UP, 0.548).normalize();
    }
    return out;
  }

  /**
   * The flame. Two ribbons pivoting about the exhaust axis, submitted fresh
   * every frame a kart is boosting — see the Plumes class for why this is
   * geometry and not particles.
   *
   * Length, radius and radiance all key off how much boost is left, so the
   * plume flares on ignition and shortens as it runs out instead of switching
   * off; and the axis is splayed up and outward from the direction of travel so
   * both tongues clear the bodywork and stay legible from the chase camera.
   */
  private placePlumes(ctx: Ctx, k: IKart, fx: KartFx) {
    const dist = ctx.camera.position.distanceTo(k.position);
    if (dist > 110) return;
    // Latched at ignition; `k.driftTier` is already 0 here. See KartFx.boostTier.
    const tier = fx.boostTier;
    const burn = THREE.MathUtils.clamp(k.boostTime / 0.9, 0.32, 1);
    const ignite = fx.igniteT / 0.30;

    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    _col.copy(C_TIER[tier]);

    // HARD CAP AT ~1.1x KART LENGTH, and this is a silhouette rule, not a taste
    // call. At 2.60 + 1.40 with a 1.40 ignition multiplier the tongue reached
    // 5.6 m — two and a half times the length of the car it was attached to —
    // and because the model's exhaust anchor points up as well as back, a plume
    // that long sweeps through the kart's own screen silhouette from any camera
    // above the axis. The boost frame is the result: the driver, the roll bar,
    // the front bumper and the front-left wheel all gone behind it. Nothing
    // this file emits is allowed to be bigger than the subject.
    //
    // At 5.6 m the tongue also reached PAST the chase camera, which sits about
    // six metres behind the kart — so the "plume" the boost frame photographed
    // is largely its own tail sweeping through the lens at point-blank range.
    // 2.15 m keeps the whole flame nearly three metres in front of the eye at
    // every rig distance. The readable dimension from directly behind is width,
    // and the shader already widens the tongue as it turns to face us
    // (`W *= 1 + 0.70 * align`), so a shorter plume is not a smaller one on
    // screen — it is a plume that is behind the car instead of over it.
    // Then partly given back, because 1.05 + 0.62 overshot the cure. The r1
    // frame lost the kart behind the flame; the r1-verify frame lost the FLAME
    // — a 33 m/s boost shot with speed lines, FOV punch and a pale wisp near
    // the rear axle, which fails the frame's brief as squarely as the white-out
    // did, just quietly. The two failures are not symmetric in how they read,
    // and that is what made this one easy to ship.
    //
    // What makes the length safe now is not the length: it is the 25-degree
    // cone clamp and the 12 cm rearward root below, neither of which existed
    // when 2.60 was dangerous. Those hold the plume BEHIND the car regardless
    // of how long it is, so length can go back to doing its job. 2.32 m peak is
    // ~1.2x kart length and still three and a half metres clear of the chase
    // eye, so nothing sweeps the lens.
    // ...and then given a further 15% and a tier term, because the measured
    // r13 boost frame proves the cure had gone one round too far. Off
    // scratch/before/boost.png (a 131 km/h sustained boost, chase camera dead
    // behind the stacks): the whole frame ceilings at display 243, 0.000% of
    // pixels are anywhere near clipping, the plume occupies about 1.4% of the
    // frame, and what is there is a pair of pale cream cones you have to be
    // told to look for. Nothing in that image is over-bright or over-large; the
    // flame is simply absent, exactly as the critic wrote. A tier-3 mini-turbo
    // — the hardest thing to earn in the game — now runs 18% longer and 15%
    // fatter than a mushroom, so the payoff scales with what was risked.
    let len = (1.62 + 0.80 * burn) * (1 + 0.30 * ignite) * (0.94 + 0.06 * tier);
    let rad = (0.33 + 0.14 * burn + 0.06 * ignite) * (0.92 + 0.08 * tier);

    // --- SCREEN-SPACE CLAMP ---------------------------------------------------
    //
    // Everything above is authored in metres, and metres are the wrong unit for
    // a silhouette rule. The chase rig surges IN under boost — to about 4.5 m —
    // and the shader deliberately widens the tongue as it turns to face the eye
    // (`W *= 1 + 0.70 * align`), so the two effects that make the flame readable
    // from behind are also the two that make it enormous exactly when it is
    // brightest. Measured against r1/boost.png with a 62-degree vertical field
    // at 4.5 m: the tongue subtends 0.29 of frame height across and 0.43 along,
    // i.e. a 313 x 464 px cream mass on a 1080p frame, which is the flame the
    // review says blows out and eats the kart. It is not over-bright — nothing
    // in that shot exceeds display 249 — it is over-LARGE, and 40 000 pixels of
    // near-white with no structure in them reads as blown whatever the peak is.
    //
    // So the flame is budgeted as a fraction of the frame instead. `ppm` is the
    // fraction of frame height one metre at the kart subtends; the plume is
    // scaled down (never up) until it fits inside 18% of frame height across and
    // 40% along. At the reviewed distance that is a 0.61 scale — a 194 x 421 px
    // flame against a kart that fills about 400 px of the same frame, so the
    // flame is smaller than its subject, which §6's "nothing this file emits may
    // be bigger than the kart" has been asking for since round three. Beyond
    // ~8 m the clamp is inactive and the metre-authored size is what ships.
    const fovRad = THREE.MathUtils.degToRad(ctx.camera.fov);
    const ppm = 1 / (2 * Math.tan(fovRad * 0.5) * Math.max(dist, 1.2));
    // 1.7 is the shader's own worst-case widening, so the budget is measured
    // against the widest the tongue can get rather than its authored radius.
    const wantW = rad * 2 * 1.7 * ppm;
    const wantL = len * ppm;
    // 0.26 / 0.52 of frame height, up from 0.18 / 0.40 — and this is the single
    // biggest reason the boost frame had no flame in it.
    //
    // Worked through at the distance the reviewed frame was shot from (4.5 m,
    // 62-degree vertical field, so ppm = 0.185): the authored radius asked for
    // 0.29 of frame height across, the budget allowed 0.18, and the clamp
    // therefore scaled the WHOLE plume — length included — by 0.62. A 1.36 m
    // tongue behind a 2.1 m kart, at a distance where the camera is looking
    // straight down the exhaust axis, is a smudge. The budget that produced
    // that number was set to cure the opposite failure (r1, where the plume
    // swallowed the driver and the front wheels) and it was calibrated against
    // a plume that had neither the 18-degree cone clamp nor the 20 cm rearward
    // root — both of which now hold the flame BEHIND the car geometrically,
    // whatever size it is. With those in place the screen budget is insurance
    // against a pathological camera distance, not the thing that decides the
    // look, so it can sit where a flame is actually visible: 0.26 of frame
    // height across is a 280 px tongue on a 1080p frame against a kart that
    // fills about 400 px of the same frame. Still smaller than its subject.
    const fit = Math.min(1, 0.26 / Math.max(wantW, 1e-4), 0.52 / Math.max(wantL, 1e-4));
    if (fit < 1) { len *= fit; rad *= fit; }
    // Down from 5.2 + 2.4 with a 1.9x ignition kick, i.e. from a peak of 14.4.
    // Fourteen units of additive radiance through a Reinhard shoulder is still
    // five units on the framebuffer, which after ACES is white whatever colour
    // went in. At 3.1 (4.7 on ignition) the spine composites to roughly 2.3
    // linear — comfortably over PostFX's 1.55 bloom gate, so it still throws a
    // halo, but low enough that the tone curve returns an incandescent orange
    // rather than paper. The intensity the effect *reads* at now comes from
    // bloom carrying it, which is what the review asked for.
    // Nudged up from 2.00 + 1.10. The reasoning above is right and the target it
    // names — "incandescent orange rather than paper" — is the right one; 2.00
    // simply landed under it. At peak burn the spine now composites to roughly
    // 3.4 linear against the same 1.55 bloom gate: still less than a quarter of
    // the old 14.4, still nowhere near the white-out, but far enough over the
    // gate that bloom actually carries it instead of merely clearing it.
    //
    // Up again to 3.05 + 1.60, and the headroom to do it is measured rather
    // than hoped for: on the r13 probe set NOTHING clips anywhere — the boost
    // frame's 99.9th percentile is display 246 and the fraction of pixels with
    // all three channels at 250+ is 0.000% on every frame including the
    // tier-3 + boost + tunnel stack. The energy budget was not being spent, it
    // was being hoarded, and the frame the player actually sees paid for it.
    const intensity = (3.05 + 1.60 * burn) * (1 + 0.55 * ignite);
    // Fade out with distance rather than popping off at the LOD boundary.
    const alpha = 0.88 * THREE.MathUtils.clamp(1.25 - dist / 90, 0.15, 1);

    // 18 degrees, tightened from 25. The cone is what decides whether the plume
    // is BEHIND the car or across it: at 25 degrees a 2.3 m tongue ends up a
    // metre outboard of the axis, which from the three-quarter chase angle the
    // boost shot is taken at projects straight over the rear bodywork, the
    // spoiler and the roll bar. 18 degrees keeps the tip within 0.7 m of the
    // centreline, so the kart's own silhouette occludes the root (the plume is
    // depth-tested) and the tongue trails out of the back of it. cos/sin
    // precomputed.
    const COS_MAX = 0.9511, SIN_MAX = 0.3090;

    for (let s = 0; s < 2; s++) {
      // Origin comes from the model's own exhaust anchor so the flame is welded
      // to the pipe through body roll and pitch, then biased 12 cm further back
      // so its root starts behind the bodywork rather than inside it.
      this.stackMouth(k, s, _p, _q);
      // 20 cm back, up from 12. The root is the brightest part of the flame and
      // it is the part that has to be hidden by the bodywork rather than laid
      // over it; a tenth of a metre is inside the rear bumper's own thickness.
      _p.addScaledVector(_fwd, -0.20);

      // CONSTRAIN THE CONE ABOUT -forward.
      //
      // KartModel authors the anchor's +Z up-and-rearward at about 33 degrees,
      // which is right for the pipe and wrong for the flame: a chase camera
      // sits above the axis, so a tongue leaning that far up projects across the
      // bodywork instead of trailing behind it. Splay outboard, allow a little
      // buoyancy, then clamp the whole thing into a 25-degree half-angle about
      // straight-back — exactly the constraint the review specified.
      _q.multiplyScalar(0.30)
        .addScaledVector(_fwd, -0.70)
        .addScaledVector(UP, 0.07)
        .addScaledVector(_side, s === 0 ? -0.07 : 0.07)
        .normalize();
      _n.copy(_fwd).multiplyScalar(-1);
      const c = _q.dot(_n);
      if (c < COS_MAX) {
        // q = c*n + s*perp; rebuild it at exactly the maximum half-angle.
        _q.addScaledVector(_n, -c);
        const sl = _q.length();
        if (sl > 1e-5) _q.multiplyScalar(SIN_MAX / sl);
        _q.addScaledVector(_n, COS_MAX).normalize();
      }
      this.plumes.add(_p, _q, len, rad, _col, intensity, alpha, k.id * 2 + s);
    }
  }

  /**
   * What is left of the old particle plume: the parts a rigid ribbon cannot do.
   * Cooling embers shed off the tip, a small hot kiss at each stack mouth to
   * weld the ribbon's root to the bodywork, and a dim tier-coloured sheath.
   *
   * Everything here inherits most of the kart's velocity. Particles are
   * simulated in world space, so a plume emitted with a purely local velocity is
   * in world terms *stationary*: at 33 m/s each ember is stranded where it was
   * born and the "plume" smears eight metres down the road.
   */
  private boostPlume(k: IKart, n: number) {
    const fx = this.state(k);
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    const tier = fx.boostTier;
    _col.copy(C_TIER[tier]);
    const burn = THREE.MathUtils.clamp(k.boostTime / 0.9, 0.35, 1);

    const vx = k.velocity.x, vy = k.velocity.y, vz = k.velocity.z;

    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? -0.34 : 0.34;
      this.stackMouth(k, s, _p);

      // Hot kiss at the stack mouth: the thing that welds the ribbon's root to
      // the bodywork. Deliberately NOT the brightest layer — the offline energy
      // model (scratch/energy.mjs) showed two of these stacking to 2.3 linear
      // on their own, more than the flame itself, which drove the core of the
      // plume to flat achromatic white in the exact frame the art bible says
      // must not white out. One per emission, 2.2x, 0.85 alpha.
      const p = this.particles.reset();
      p.tile = PTile.Glow; p.mode = PMode.Billboard;
      p.life = 0.10; p.lifeJitter = 0.3;
      // 1.35, down from 2.2. Two of these plus the ribbon's own root kiss plus
      // the trail spine all land on the same handful of pixels; the sum is what
      // the frame sees, and the sum was three times over white.
      p.size0 = 0.11 + 0.06 * burn; p.size1 = 0.04; p.sizeJitter = 0.25;
      p.drag = 5; p.velJitter = 0.35; p.posJitter = 0.04; p.fadeIn = 0.05;
      p.count = Math.max(1, n >> 2);
      this.particles.ground(fx.groundY, fx.groundN, 0.5, 0.18);
      this.particles.at(_p.x, _p.y, _p.z);
      this.particles.vel(vx, vy + 0.6, vz);
      this.particles.colorA(C_FLAME_ROOT, 1.35, 0.75);
      this.particles.colorB(C_FLAME_MID, 0.6, 0);
      this.particles.emit(true);

      // Tier sheath. BORN SMALL AND GROWS — this is the note, verbatim: a puff
      // that is born at its terminal size has no expansion in it and reads as
      // fog rather than as gas leaving a pipe under pressure. It also has to
      // start small because it starts AT the stack mouth, where anything wide
      // is already overlapping the bodywork.
      p.tile = PTile.Glow; p.life = 0.26;
      // Back to n>>2 and a tamer terminal size. At n>>1 and 0.91 m these
      // overlapped hard enough that the sum of a dozen tier-coloured discs and
      // the plume's own spine landed on white — the sheath is meant to be the
      // low-frequency CARRIER of the tier hue, and a carrier that saturates is
      // just another white cloud.
      p.size0 = 0.10; p.size1 = (0.46 * burn + 0.22) * (0.94 + 0.06 * tier); p.sizeJitter = 0.3;
      p.count = Math.max(1, n >> 2); p.drag = 4; p.fadeIn = 0.12;
      this.particles.vel(vx * 0.92 - _fwd.x * 2.4, vy * 0.92 + 0.8, vz * 0.92 - _fwd.z * 2.4);
      // 0.95, not 0.62, and scaling with the tier. The sheath is the widest
      // low-frequency shape in the boost and therefore the one that survives
      // bloom and motion blur — it is what carries the tier hue at chase
      // distance when the tongue itself is foreshortened to a bright disc.
      this.particles.colorA(_col, 0.70 + 0.12 * tier, 0.42);
      this.particles.colorB(_col, 0.15, 0);
      this.particles.emit(true);

      // Cooling embers shed off the tip, so the plume dissipates into the
      // slipstream instead of ending on the ribbon's clean edge. Thrown further
      // back and given the ember hue at both ends of the ramp: these are the
      // sparse C_FLAME_COOL tail the review asked for, and they are the only
      // part of the effect allowed past the tongue's own length.
      p.tile = PTile.Streak; p.mode = PMode.Stretch; p.stretch = 3.0;
      p.life = 0.24; p.lifeJitter = 0.5;
      p.size0 = 0.035; p.size1 = 0.010; p.sizeJitter = 0.5;
      p.gravity = -3.0; p.drag = 1.6; p.velJitter = 1.6; p.velScatter = 0.4;
      p.fadeIn = 0.03;
      p.count = Math.max(1, n >> 2);
      this.particles.vel(
        vx * 0.70 - _fwd.x * 4.2 + _side.x * sx * 1.4,
        vy * 0.70 + 0.8,
        vz * 0.70 - _fwd.z * 4.2 + _side.z * sx * 1.4);
      this.particles.colorA(C_FLAME_MID, 1.55, 1);
      this.particles.colorB(C_FLAME_COOL, 0.55, 0);
      this.particles.emit(true);
    }
  }

  /**
   * Baseline running-engine wisp off the exhaust stacks.
   *
   * A WISP. The closeup frame — a cruise at 55 km/h, no drift, no boost, a shot
   * whose stated subject is the kart's own materials — came back with an unlit
   * grey-brown column rising out of the back of the car to the top of the
   * frame, the second largest element in the image. That column is this emitter
   * plus `rollDust`, both of them running at drift-scale volume on a clean lap:
   * eighteen puffs a second at 0.85 m terminal size and 0.30 alpha, living most
   * of a second each, is fifteen overlapping sprites behind the kart at all
   * times, and fifteen translucent puffs stacked is an opaque one.
   *
   * Roughly a third of the volume, half the size, half the alpha and a life
   * budgeted in metres rather than seconds. It still says "eight running
   * engines" in the pack shot — which is why it exists — without saying "the
   * kart is on fire" in every other shot.
   */
  private idleExhaust(k: IKart, fx: KartFx, n: number) {
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    _col.copy(C_SMOKE_DARK).lerp(this.sunColor, 0.35);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = trailLife(Math.abs(k.forwardSpeed), 5.5, 0.22, 0.5); p.lifeJitter = 0.35;
    p.size0 = 0.10; p.size1 = 0.42; p.sizeJitter = 0.35;
    p.gravity = 1.4; p.drag = 3.2; p.spin = 1.6;
    p.posJitter = 0.08; p.velJitter = 0.6; p.fadeIn = 0.12;
    this.particles.ground(fx.groundY, fx.groundN, 0.5, 0.22);
    p.count = n;
    this.particles.colorA(_col, 1.0, 0.15);
    this.particles.colorB(_col, 0.85, 0);
    for (let s = 0; s < 2; s++) {
      // Off the model's real stack tips, like the plume — a wisp that leaves
      // 28 cm below the pipe is a wisp coming out of the bodywork.
      this.stackMouth(k, s, _p);
      this.particles.at(_p.x, _p.y, _p.z);
      // Partial velocity inheritance: exhaust should trail, but a world-static
      // wisp on a kart at 25 m/s strings itself over fifteen metres of road and
      // stops reading as coming out of the stacks at all.
      this.particles.vel(
        k.velocity.x * 0.72 - _fwd.x * 1.6, k.velocity.y * 0.72 + 1.1, k.velocity.z * 0.72 - _fwd.z * 1.6);
      this.particles.emit(false);
    }
  }

  /**
   * The star husk, made of light instead of geometry: sparks struck around the
   * chassis on a rising helix, plus a hue-cycling pool on the road. Nothing
   * here has a silhouette, so nothing can intersect the kart.
   */
  private starSparkle(k: IKart, fx: KartFx, n: number, now: number) {
    const h = (now * 0.55 + k.id * 0.13) % 1;
    _col.setHSL(h, 0.85, 0.62);
    _col2.setHSL((h + 0.12) % 1, 0.9, 0.7);

    const p = this.particles.reset();
    p.tile = PTile.Star; p.mode = PMode.Billboard;
    p.life = 0.55; p.lifeJitter = 0.4;
    p.size0 = 0.22; p.size1 = 0.03; p.sizeJitter = 0.45;
    p.gravity = -1.2; p.drag = 2.6; p.spin = 2.4;
    p.velJitter = 1.1; p.fadeIn = 0.05; p.count = 1;
    this.particles.ground(fx.groundY, fx.groundN, 0.3, 0.14);
    this.particles.colorA(_col, 1.9, 1);
    this.particles.colorB(C_HOT, 0.7, 0);
    // Emission points ride a helix around the chassis. The particles barely
    // move; the *source* orbits, which is what reads as a shimmering husk.
    for (let i = 0; i < n; i++) {
      const a = now * 6.5 + (i / Math.max(1, n)) * Math.PI * 2 + k.id;
      const rise = ((now * 1.3 + i * 0.37) % 1);
      const r = 0.62 + 0.16 * Math.sin(a * 2.0);
      this.particles.at(
        k.position.x + Math.cos(a) * r,
        k.position.y - 0.12 + rise * 1.05,
        k.position.z + Math.sin(a) * r);
      this.particles.vel(k.velocity.x * 0.6, k.velocity.y * 0.6 + 0.5, k.velocity.z * 0.6);
      this.particles.emitExact(true);
    }

    // The pool on the road. Ground-aligned, so it has area and no edge.
    p.tile = PTile.Glow; p.mode = PMode.Ground; p.spin = 1.2;
    p.life = 0.26; p.size0 = 1.0; p.size1 = 2.1; p.sizeJitter = 0.2;
    p.gravity = 0; p.drag = 1.1; p.velJitter = 0; p.count = 1;
    p.camBias = 0.07; p.softness = 0; p.fadeIn = 0.12;
    this.particles.at(k.position.x, fx.groundY + 0.05, k.position.z);
    this.particles.vel(k.velocity.x * 0.8, 0, k.velocity.z * 0.8);
    this.particles.colorA(_col2, 0.55, 0.45);
    this.particles.colorB(_col, 0.14, 0);
    this.particles.emitExact(true);
  }

  private stunStars(k: IKart, fx: KartFx, n: number) {
    // Re-emitted on a rotating ring above the helmet: the particles themselves
    // barely move, the emission point orbits, which reads as classic orbiting
    // stars without needing per-frame simulation.
    const p = this.particles.reset();
    p.tile = PTile.Star;
    p.life = 0.34; p.lifeJitter = 0.15;
    p.size0 = 0.30; p.size1 = 0.24; p.sizeJitter = 0.15;
    p.gravity = 0; p.drag = 5; p.spin = 2.2; p.fadeIn = 0.25; p.count = 1;
    this.particles.ground(fx.groundY, fx.groundN, 0.3, 0.14);
    this.particles.colorA(C_GOLD, 2.0, 1);
    this.particles.colorB(C_GOLD, 1.0, 0);
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 4; s++) {
        const a = fx.stunPhase + (s / 4) * Math.PI * 2;
        this.particles.at(
          k.position.x + Math.cos(a) * 0.72,
          k.position.y + 1.05 + Math.sin(a * 2) * 0.06,
          k.position.z + Math.sin(a) * 0.72);
        this.particles.emitExact(true);
      }
    }
  }

  private sparkleBurst(at: THREE.Vector3, col: THREE.Color, n: number) {
    const p = this.particles.reset();
    p.tile = PTile.Star; p.mode = PMode.Billboard;
    p.life = 0.7; p.lifeJitter = 0.3;
    p.size0 = 0.34; p.size1 = 0.04; p.sizeJitter = 0.4;
    p.gravity = -2.5; p.drag = 2.4; p.spin = 3.5;
    p.posJitter = 0.3; p.velJitter = 3.4; p.fadeIn = 0.04; p.count = n;
    p.camBias = 0.16;
    this.particles.at(at.x, at.y + 0.6, at.z);
    this.particles.vel(0, 2.2, 0);
    this.particles.colorA(col, 2.0, 1);
    this.particles.colorB(C_HOT, 0.8, 0);
    this.particles.emit(true);
  }

  private confetti(at: THREE.Vector3) {
    for (let i = 0; i < CONFETTI.length; i++) {
      const p = this.particles.reset();
      p.tile = PTile.Streak; p.mode = PMode.Billboard;
      p.life = 2.6; p.lifeJitter = 0.35;
      p.size0 = 0.16; p.size1 = 0.16; p.sizeJitter = 0.4;
      p.gravity = -4.2; p.drag = 1.5; p.spin = 6;
      p.posJitter = 0.9; p.velJitter = 5.5; p.fadeIn = 0.03; p.count = 14;
      p.softness = 0;
      this.particles.at(at.x, at.y + 2.4, at.z);
      this.particles.vel(0, 5.5, 0);
      this.particles.colorA(CONFETTI[i], 1.0, 1);
      this.particles.colorB(CONFETTI[i], 0.9, 0.9);
      this.particles.emit(false);
    }
  }

  private impactBurst(at: THREE.Vector3, n: THREE.Vector3, now: number, scale: number) {
    const p = this.particles.reset();
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 3.0;
    p.life = 0.4; p.lifeJitter = 0.4;
    p.size0 = 0.08 * scale; p.size1 = 0.012;
    p.gravity = -12; p.drag = 1.3; p.velJitter = 8 * scale;
    p.posJitter = 0.2; p.fadeIn = 0.02; p.count = Math.round(52 * scale);
    this.particles.ground(at.y - 1.2, n, 0.3, 0.10);
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(0, 3, 0);
    this.particles.colorA(C_SPARK_WHITE, 2.6, 1);
    this.particles.colorB(C_FLAME_MID, 0.8, 0);
    this.particles.emit(true);

    p.tile = PTile.Smoke; p.mode = PMode.Billboard; p.stretch = 0;
    p.life = 0.8; p.size0 = 0.4 * scale; p.size1 = 1.8 * scale;
    p.gravity = 1.2; p.drag = 3.2; p.spin = 1.4; p.velJitter = 2.2;
    p.count = Math.round(10 * scale);
    this.particles.ground(at.y - 1.2, n, 0.6, 0.32);
    this.particles.colorA(C_SMOKE, 0.9, 0.5);
    this.particles.colorB(C_SMOKE_DARK, 0.8, 0);
    this.particles.emit(false);

    // Thin and fast. A 30%-thick annulus at 1.8x white is a plate; this is a
    // wave front that has come and gone before the eye can resolve its shape.
    this.rings.spawn(at, n, 0.25, 3.0 * scale, 0.26, 0.07, C_HOT, 1.2 * scale, now);
    this.blastLoad = Math.max(this.blastLoad, 0.7 * scale);
  }

  private explode(at: THREE.Vector3, n: THREE.Vector3, groundY: number, scale: number, now: number) {
    // fireball
    let p = this.particles.reset();
    p.tile = PTile.Flame; p.mode = PMode.Billboard;
    p.life = 0.42; p.lifeJitter = 0.35;
    p.size0 = 1.1 * scale; p.size1 = 3.0 * scale; p.sizeJitter = 0.35;
    p.gravity = 5.5; p.drag = 4.0; p.spin = 1.8;
    p.posJitter = 0.55 * scale; p.velJitter = 6.5 * scale; p.fadeIn = 0.04;
    p.count = Math.round(20 * scale);
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(0, 3.5, 0);
    this.particles.colorA(C_HOT, 2.6, 1);
    this.particles.colorB(C_FLAME_COOL, 0.7, 0);
    this.particles.emit(true);

    // sparks
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 3.4;
    p.life = 0.8; p.lifeJitter = 0.5;
    p.size0 = 0.085; p.size1 = 0.012;
    p.gravity = -13; p.drag = 0.9; p.velJitter = 14 * scale; p.posJitter = 0.2;
    p.count = Math.round(72 * scale);
    this.particles.vel(0, 5, 0);
    this.particles.colorA(C_SPARK_WHITE, 2.8, 1);
    this.particles.colorB(C_FLAME_MID, 0.9, 0);
    this.particles.emit(true);

    // smoke column
    p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 2.1; p.lifeJitter = 0.35;
    p.size0 = 0.9 * scale; p.size1 = 5.0 * scale; p.sizeJitter = 0.35;
    p.gravity = 1.6; p.drag = 1.5; p.spin = 0.7;
    p.posJitter = 0.7 * scale; p.velJitter = 3.2; p.fadeIn = 0.08;
    this.particles.ground(groundY, n, 0.9, 0.36);
    p.count = Math.round(22 * scale);
    this.particles.at(at.x, at.y + 0.2, at.z);
    this.particles.vel(0, 2.6, 0);
    this.particles.colorA(C_SMOKE_DARK, 0.9, 0.72);
    this.particles.colorB(C_SMOKE, 0.75, 0);
    this.particles.emit(false);

    // debris
    p.tile = PTile.Streak; p.mode = PMode.Stretch; p.stretch = 1.1;
    p.life = 1.5; p.lifeJitter = 0.4;
    p.size0 = 0.2 * scale; p.size1 = 0.14 * scale; p.sizeJitter = 0.5;
    p.gravity = -16; p.drag = 0.55; p.spin = 8;
    p.velJitter = 9 * scale; p.posJitter = 0.3; p.softness = 0;
    p.count = Math.round(16 * scale);
    this.particles.vel(0, 7, 0);
    this.particles.colorA(C_DEBRIS, 1.0, 1);
    this.particles.colorB(C_DEBRIS, 0.8, 0.6);
    this.particles.emit(false);

    this.rings.spawn(at, n, 0.4, 8.0 * scale, 0.42, 0.06, C_HOT, 1.5, now);
    this.rings.spawn(at, n, 0.25, 4.4 * scale, 0.28, 0.09, C_FLAME_MID, 1.1, now);

    // `at` may alias the shared _p scratch, so land the decal via a different one
    _r.set(at.x, groundY, at.z);
    this.decals.blot(_r, n, 2.6 * scale, DecalTile.Scorch, now, 18, 0.85);

    this.ctx.shake(0.9 * scale, 0.55);
    this.blastLoad = Math.max(this.blastLoad, 1.6 * scale);
  }

  /** Lay one skid segment per rear wheel, with run-in/run-out fading. */
  private layStrip(fx: KartFx, now: number, strength: number, widthMul = 1) {
    if (!fx.skidding) {
      fx.skidding = true;
      fx.skidStrength = 0;
      fx.skidL.copy(this.skidLRef);
      fx.skidR.copy(this.skidRRef);
      return;
    }
    const prevS = fx.skidStrength;
    fx.skidStrength = Math.min(1, fx.skidStrength + 0.34);
    // 0.55 m segments. The chord error against a drift radius of 15 m is under
    // 3 mm, and it halves how fast a pack fight can churn through the ring.
    if (fx.skidL.distanceToSquared(this.skidLRef) < 0.3) return;
    const life = 13;
    // Wider and considerably darker than they were. At 0.30 m and a 0.30 grey
    // multiplier the mark was a faint smudge that vanished into a tarmac
    // already at #4a4a52 — reviewers looking at a mid-drift hero frame read the
    // road as perfectly clean. Hot rubber on tarmac is nearly black.
    const w = 0.36 * widthMul;
    const a0 = prevS * strength, a1 = fx.skidStrength * strength;
    this.decals.skid(fx.skidL, this.skidLRef, fx.groundN, w, a0, a1, now, life,
      0.17, 0.16, 0.19);
    this.decals.skid(fx.skidR, this.skidRRef, fx.groundN, w, a0, a1, now, life,
      0.17, 0.16, 0.19);
    fx.skidL.copy(this.skidLRef);
    fx.skidR.copy(this.skidRRef);
  }

  // --- squash & stretch ----------------------------------------------------

  private addSquash(k: IKart, impulse: number) {
    const fx = this.state(k);
    fx.squashV += impulse * 26;
  }

  /**
   * Damped spring on a single scalar: negative squashes (flat and wide),
   * positive stretches. We only ever touch `object.scale`, we restore it to
   * exactly identity when the pulse dies, and we never take it over unless we
   * put it there — so a kart-model animator writing scale wins by default.
   */
  private applySquash(k: IKart, fx: KartFx, dt: number) {
    if (Math.abs(fx.squash) < 1e-4 && Math.abs(fx.squashV) < 1e-3) {
      if (fx.squashOwned) {
        k.object.scale.set(1, 1, 1);
        fx.squashOwned = false;
        fx.squash = 0; fx.squashV = 0;
      }
      return;
    }
    const s = k.object.scale;
    if (!fx.squashOwned) {
      if (Math.abs(s.x - 1) > 0.02 || Math.abs(s.y - 1) > 0.02) { fx.squashV = 0; return; }
      fx.squashOwned = true;
    }
    // stiffness/damping tuned for ~3 visible bounces over ~0.45 s
    fx.squashV += (-fx.squash * 420 - fx.squashV * 17) * dt;
    fx.squash += fx.squashV * dt;
    fx.squash = THREE.MathUtils.clamp(fx.squash, -0.45, 0.45);
    const q = fx.squash;
    s.set(1 - q * 0.55, 1 + q, 1 - q * 0.55);
  }

  // --- ambient -------------------------------------------------------------

  private updateAmbient(ctx: Ctx, dt: number, now: number) {
    const cam = ctx.camera.position;

    if (this.motes) this.motes.update(now, cam, ctx.sunDirection, this.gain);
    if (this.gulls) {
      _col.copy(this.sunColor).multiplyScalar(0.85).add(_col2.copy(this.skyColor).multiplyScalar(0.35));
      // Flush the low birds when the pack arrives. Tested against the flock
      // centre in XZ so it fires once per lap as the field sweeps the harbour,
      // rather than every frame the player is loosely nearby.
      const lead = ctx.race?.standings?.[0] ?? ctx.race?.player;
      if (lead && Math.abs(lead.forwardSpeed) > 8) {
        const g = this.gulls.centre;
        const dx = lead.position.x - g.x, dz = lead.position.z - g.z;
        if (dx * dx + dz * dz < 46 * 46) this.gulls.startle(lead.position);
      }
      this.gulls.update(now, _col, dt);
    }

    // sea spray at the cliff base
    if (this.sprays.length) {
      this.sprayAcc += dt;
      if (this.sprayAcc > 0.22) {
        this.sprayAcc = 0;
        const site = this.sprays[(Math.random() * this.sprays.length) | 0];
        if (cam.distanceToSquared(site) < 200 * 200) {
          const p = this.particles.reset();
          p.tile = PTile.Splash; p.mode = PMode.Billboard;
          p.life = 2.0; p.lifeJitter = 0.3;
          p.size0 = 1.4; p.size1 = 5.5; p.sizeJitter = 0.35;
          p.gravity = -1.6; p.drag = 1.1; p.spin = 0.5;
          p.posJitter = 3.5; p.velJitter = 2.5; p.fadeIn = 0.14;
          p.groundY = 0; p.softness = 1.2; p.camBias = 0.5; p.count = 5;
          this.particles.at(site.x, site.y, site.z);
          this.particles.vel(0, 6.5, 0);
          this.particles.colorA(C_FOAM, 1.0, 0.55);
          this.particles.colorB(C_WATER, 0.85, 0);
          this.particles.emit(false);
        }
      }
    }

    // heat shimmer over the tarmac ahead
    if (this.shimmer) {
      ctx.camera.getWorldDirection(_q);
      this.shimmerTimer -= dt;
      const player = ctx.race?.player;
      if (this.shimmerTimer <= 0 && player) {
        // The ground probe is the only per-frame cost here, so it runs at 5 Hz
        // and the band eases between placements.
        this.shimmerTimer = 0.2;
        _fwd.copy(_q);
        _fwd.y = 0;
        if (_fwd.lengthSq() > 1e-4) {
          _fwd.normalize();
          _p.copy(cam).addScaledVector(_fwd, 46);
          const probe = ctx.track.probe(_p, player.t);
          const onTarmac = probe.surface === Surface.Road || probe.surface === Surface.Boost;
          this.shimmerPos.set(_p.x, probe.y + 1.6, _p.z);
          // 0.17, doubled. At 0.085 through the additive gain and then the
          // grade's own shoulder the band measured under two counts against the
          // sky behind it — present in the buffer, absent from the picture, and
          // the critics counted heat shimmer as a missing feature. This is
          // still a low-amplitude scattering veil, not a refraction: it reads
          // as hot air over the tarmac in the middle distance and nothing else
          // in frame moves like it.
          this.shimmerAmount += ((onTarmac ? 0.17 : 0) - this.shimmerAmount) * 0.35;
        }
      }
      this.shimmer.place(this.shimmerPos, _q, this.shimmerAmount, now, this.gain);
    }
  }

  dispose() {
    this.unsubscribe?.();
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
      this.canvas = null;
    }
    this.particles?.dispose();
    this.trails?.dispose();
    this.decals?.dispose();
    this.rings?.dispose();
    this.motes?.dispose();
    this.gulls?.dispose();
    this.shimmer?.dispose();
    this.plumes?.dispose();
    this.lights?.dispose();
    this.group.removeFromParent();
  }
}
