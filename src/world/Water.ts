/**
 * ============================================================================
 *  Water — the bay.
 * ============================================================================
 *  A camera-centred radial grid (dense underfoot, coarse at the horizon) with
 *  world-space analytic displacement, so the surface never swims when the
 *  camera moves and there is no texture tiling to catch.
 *
 *  Shading:
 *    - five scrolling wave octaves in the vertex shader for silhouette, two
 *      more evaluated per-pixel for near-field normal detail, and a THREE-TERM
 *      LONG SWELL evaluated per-pixel at full amplitude at every distance —
 *      that last one is what gives the outer bay any form at all (see below);
 *    - Fresnel-weighted reflection of the sky (analytic Rayleigh/Mie-ish dome
 *      matching ART_DIRECTION §2, blended with ctx.envMap when the sky system
 *      hands us one in a mapping we can sample directly);
 *    - depth ramp #3fc9c4 -> #0d5a7a driven by a baked distance-to-shore field;
 *    - a sun specular lobe that deliberately clips far above 1.0 so the
 *      glitter path across the bay blows out through bloom;
 *    - foam where the sea meets the shore and the cliff feet, crest foam, and
 *      swell-crest whitecaps that survive out to the horizon.
 *
 * ---------------------------------------------------------------------------
 *  ROUND 8: WHY TEN FRAMES OF A COASTAL CIRCUIT CONTAINED NO VISIBLE SEA
 * ---------------------------------------------------------------------------
 *  It was never a visibility problem. Probing the shipped track from each of
 *  the ten review camera marks, open water starts 30–250 m dead ahead in every
 *  single one of them, with nothing standing above the eye line to occlude it —
 *  83% of the world square is below sea level. The bay was on screen the whole
 *  time, filling a third of `pack.png` and a wide band of `hero.png`.
 *
 *  It just did not look like water. Four faults, all in this file, all fixed
 *  here:
 *
 *  1. FRESNEL ATE THE ENTIRE DEPTH RAMP. From a kart 3 m off the deck almost
 *     all visible water is at grazing incidence, where `0.02 + 0.86*(1-ndv)^5`
 *     is ~0.88. Eighty-eight percent of the bay was a sky reflection and the
 *     #3fc9c4 -> #0d5a7a ramp §4 asks for contributed twelve percent of it.
 *     Now capped at 0.60, and pulled down further in the shallows, where a real
 *     sea is body-dominant and where the turquoise has to live.
 *
 *  2. THE SKY IT WAS REFLECTING WAS A DEAD VIOLET-GREY. `HZ_ANTI`, the
 *     anti-solar horizon, was linear (0.100, 0.118, 0.205) — a tenth of the
 *     luminance of the down-sun horizon. A golden-hour sky behind you is a
 *     third of the sun-ward one, not a tenth, and it is BLUE rather than grey.
 *     Reflecting the old value at 88% is precisely the "flat lavender plate"
 *     the composition critic measured off the frames.
 *
 *  3. EVERYTHING PAST ~150 m WAS A MIRROR-FLAT PLATE. `detailFade` killed the
 *     per-pixel wavelets by 420 m and `flatten01` flattened the normal from
 *     90 m, both for good anti-aliasing reasons — but nothing replaced them, so
 *     the middle distance, which is ALL of the sea a chase camera can see past
 *     the roadside berm, had zero form. `swellSlope()` now runs per-pixel at
 *     every distance on the three longest components only (118 / 46 / 21 m).
 *     Those subtend tens of pixels at a kilometre, so they cannot alias, and
 *     they are what makes the outer bay read as a moving surface.
 *
 *  4. AERIAL PERSPECTIVE DRAINED THE COLOUR BEFORE THE SEA COULD USE IT. The
 *     scene fog (see `Sky.ts fogChunks`) converges CHROMA at 1.85x the rate it
 *     converges value: at 600 m a fragment has 78% of its saturation taken off
 *     it. That is exactly right for a headland and exactly wrong for the bay,
 *     because hue is the only thing telling the eye that band is water. The
 *     water now pre-saturates against precisely that curve.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';
import type { Shared } from './Props';

export interface SeaField {
  /** world-space min corner (x,z) of the baked field */
  origin: THREE.Vector2;
  /** world-space extent of the field, metres (square) */
  size: number;
  /** resolution per axis */
  res: number;
  /** RGBA8: R = depth 0..1, G = shore foam, B = cliff-foot foam, A = 255 */
  data: Uint8Array;
}

const _v2 = new THREE.Vector3();

export class Water {
  readonly group = new THREE.Group();
  private mesh!: THREE.Mesh;
  private mat!: THREE.ShaderMaterial;
  private fieldTex!: THREE.DataTexture;
  private level = 0;
  private envTried = false;

  constructor(private u: Shared) {
    this.group.name = 'sea';
  }

  build(ctx: Ctx, level: number, field: SeaField, radius = 2600) {
    this.level = level;
    this.u.uSeaLevel.value = level;

    this.fieldTex = new THREE.DataTexture(field.data, field.res, field.res, THREE.RGBAFormat);
    this.fieldTex.wrapS = this.fieldTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fieldTex.minFilter = this.fieldTex.magFilter = THREE.LinearFilter;
    this.fieldTex.needsUpdate = true;

    const geo = this.discGeometry(radius, ctx.settings.quality >= 2 ? 168 : 112, ctx.settings.quality >= 2 ? 104 : 68);

    const uniforms: any = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    uniforms.uTime = this.u.uTime;
    uniforms.uCam = this.u.uCam;
    uniforms.uSunDir = { value: new THREE.Vector3(-0.62, 0.245, -0.745).normalize() };
    uniforms.uSunCol = { value: new THREE.Color(0xffd9a8).multiplyScalar(1.6) };
    uniforms.uLevel = { value: level };
    uniforms.uField = { value: this.fieldTex };
    uniforms.uFieldOrigin = { value: field.origin.clone() };
    uniforms.uFieldSize = { value: field.size };
    uniforms.uEnv = { value: null };
    uniforms.uEnvIntensity = { value: 0 };
    uniforms.uChop = { value: ctx.settings.quality >= 1 ? 1 : 0.6 };

    this.mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      side: THREE.FrontSide,
      defines: { ENV_NONE: '' },
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'sea-surface';
    // The grid is re-centred on the camera every frame; culling it is wrong.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.matrixAutoUpdate = true;
    this.group.add(this.mesh);
  }

  /**
   * Radial grid: ring radii follow a cubic so the first rings are ~0.3 m apart
   * (crisp displacement at the shoreline you are driving past) while the last
   * reach the horizon. 168 x 104 ≈ 35 k triangles for the entire ocean.
   */
  private discGeometry(radius: number, segs: number, rings: number): THREE.BufferGeometry {
    const pos = new Float32Array((rings + 1) * (segs + 1) * 3);
    const idx: number[] = [];
    let p = 0;
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const r = radius * t * t * t;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pos[p++] = Math.cos(a) * r;
        pos[p++] = 0;
        pos[p++] = Math.sin(a) * r;
      }
    }
    const stride = segs + 1;
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < segs; i++) {
        // Wound counter-clockwise seen from ABOVE — the sea is single-sided and
        // the camera is always above it.
        const a = j * stride + i;
        idx.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.2);
    return g;
  }

  update(ctx: Ctx) {
    // Keep the dense centre of the grid under the camera. Waves are a function
    // of absolute world position, so nothing shifts as this moves.
    this.mesh.position.set(ctx.camera.position.x, this.level, ctx.camera.position.z);
    const su = this.mat.uniforms.uSunDir.value as THREE.Vector3;
    su.copy(ctx.sunDirection);
    if (ctx.sun) {
      _v2.set(ctx.sun.color.r, ctx.sun.color.g, ctx.sun.color.b);
      (this.mat.uniforms.uSunCol.value as THREE.Color).setRGB(_v2.x, _v2.y, _v2.z).multiplyScalar(1.35 + Math.min(ctx.sun.intensity, 6) * 0.12);
    }
    if (!this.envTried && ctx.envMap) this.adoptEnv(ctx.envMap);
  }

  /**
   * The sky system may hand us a PMREM (CubeUV) map, which a raw ShaderMaterial
   * cannot sample without dragging in three's whole cube-uv chunk set. Cube and
   * equirect maps we take; anything else falls back to the analytic dome, which
   * is authored to the same palette so the two agree.
   */
  private adoptEnv(env: THREE.Texture) {
    this.envTried = true;
    const m = env.mapping;
    if (m === THREE.CubeReflectionMapping || m === THREE.CubeRefractionMapping) {
      this.mat.defines = { ENV_CUBE: '' };
    } else if (m === THREE.EquirectangularReflectionMapping || m === THREE.EquirectangularRefractionMapping) {
      this.mat.defines = { ENV_EQUI: '' };
    } else return;
    this.mat.uniforms.uEnv.value = env;
    this.mat.uniforms.uEnvIntensity.value = 1;
    this.mat.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.fieldTex.dispose();
  }
}

// ---------------------------------------------------------------------------

const WAVES = /* glsl */ `
// Five directional octaves. Returns height in .x and d/dx, d/dz in .yz so the
// normal is analytic — no normal map, therefore no tiling to spot.
//
// W0 is the SWELL: 118 m and 0.62 m of it. A Mediterranean bay at golden hour
// has a long, low ground swell running through it, and it is the reason the
// far water has any form at all; without it the sea past 200 m is a plate.
vec3 waveSet(vec2 p, float t, float atten, float chop) {
  vec3 acc = vec3(0.0);
  // (dirx, dirz, wavelength, amplitude)
  const vec4 W0 = vec4( 0.66,  0.75, 118.0, 0.62);
  const vec4 W1 = vec4( 0.86,  0.51,  46.0, 0.40);
  const vec4 W2 = vec4(-0.42,  0.91,  21.0, 0.21);
  const vec4 W3 = vec4( 0.97, -0.24,   9.4, 0.098);
  const vec4 W4 = vec4( 0.24,  0.97,   4.3, 0.040);
  vec4 ws[5];
  ws[0] = W0; ws[1] = W1; ws[2] = W2; ws[3] = W3; ws[4] = W4;
  for (int i = 0; i < 5; i++) {
    vec4 w = ws[i];
    float k = 6.28318 / w.z;
    float sp = sqrt(9.81 / k);            // deep-water dispersion: long swell moves fast
    float ph = dot(w.xy, p) * k + t * sp * 0.55;
    float a = w.w * atten * (i > 2 ? chop : 1.0);
    // sharpened crests / flattened troughs, Gerstner-ish without the xz shear
    float s = sin(ph);
    float sh = s * (0.78 + 0.22 * s);
    float dsh = cos(ph) * (0.78 + 0.44 * s);
    acc.x += a * sh;
    acc.yz += a * k * dsh * w.xy;
  }
  return acc;
}

// ---------------------------------------------------------------------------
//  THE LONG SWELL, evaluated per pixel, at full amplitude, at every distance.
// ---------------------------------------------------------------------------
//  The vertex stage has to fade its displacement out toward the horizon or the
//  radial grid — whose outer rings are 30–60 m apart — samples a 21 m wave at
//  well under Nyquist and the silhouette of the sea tears. That fade is
//  correct and it is kept. What it must NOT do is take the SHADING with it,
//  because the middle distance (150 m to 1.5 km) is the whole of the bay a
//  chase camera can see over the roadside berm, and a mirror-flat plate there
//  is why ten frames of a coastal circuit read as haze.
//
//  So the three longest components are re-evaluated here, per pixel, with no
//  attenuation of any kind. Sampling is per-fragment, so there is no grid to
//  alias against; and 118 / 46 / 21 m still subtend tens of screen pixels at a
//  kilometre, so there is nothing to alias in screen space either. Returns
//  (height, d/dx, d/dz) exactly like waveSet(), at a quarter of the cost.
vec3 swellSet(vec2 p, float t) {
  vec3 acc = vec3(0.0);
  const vec4 S0 = vec4( 0.66,  0.75, 118.0, 0.62);
  const vec4 S1 = vec4( 0.86,  0.51,  46.0, 0.40);
  const vec4 S2 = vec4(-0.42,  0.91,  21.0, 0.21);
  vec4 ss[3];
  ss[0] = S0; ss[1] = S1; ss[2] = S2;
  for (int i = 0; i < 3; i++) {
    vec4 w = ss[i];
    float k = 6.28318 / w.z;
    float ph = dot(w.xy, p) * k + t * sqrt(9.81 / k) * 0.55;
    float s = sin(ph);
    acc.x += w.w * s * (0.78 + 0.22 * s);
    acc.yz += w.w * k * cos(ph) * (0.78 + 0.44 * s) * w.xy;
  }
  return acc;
}
`;

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform float uLevel;
uniform float uChop;
uniform sampler2D uField;
uniform vec2 uFieldOrigin;
uniform float uFieldSize;
varying vec3 vWorld;
varying vec3 vWaveD;      // (height, ddx, ddz) of the coarse set
varying vec3 vShore;      // (depth01, shoreFoam, cliffFoam)
#ifdef USE_FOG
  varying float vFogDepth;
#endif
${WAVES}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 fuv = (wp.xz - uFieldOrigin) / uFieldSize;
  vec3 shore = texture2D(uField, clamp(fuv, 0.002, 0.998)).rgb;
  // Waves flatten as the bottom comes up — shoaling, and it keeps the shoreline
  // from tearing through the beach geometry.
  float atten = mix(0.32, 1.0, shore.r);
  // Fade displacement out toward the horizon so the far rings stay flat and
  // the silhouette of the sea meets the sky cleanly.
  float dist = length(wp.xz - uCam.xz);
  // The swell has to survive a lot further out than the chop does, or the bay
  // becomes a flat plate exactly where the establishing shots look at it.
  atten *= 1.0 - smoothstep(700.0, 2000.0, dist);
  vec3 w = waveSet(wp.xz, uTime, atten, uChop);
  // Displacement fades toward the horizon so the far rings meet the sky
  // cleanly. The SHADING no longer depends on this at all — swellSet() in the
  // fragment stage carries the far water — so the fade can be as conservative
  // as the grid's own sampling rate demands without flattening the bay.
  float horizonFade = 1.0 - smoothstep(900.0, 2300.0, dist);
  wp.y = uLevel + w.x * horizonFade;
  vWorld = wp.xyz;
  vWaveD = vec3(w.x * horizonFade, w.yz);
  vShore = shore;
  vec4 mvPosition = viewMatrix * wp;
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uChop;
uniform float uEnvIntensity;
#ifdef ENV_CUBE
  uniform samplerCube uEnv;
#endif
#ifdef ENV_EQUI
  uniform sampler2D uEnv;
#endif
varying vec3 vWorld;
varying vec3 vWaveD;
varying vec3 vShore;
#include <common>
#include <fog_pars_fragment>
${WAVES}

// ART_DIRECTION §2/§3, in linear space.
const vec3 ZENITH  = vec3(0.0508, 0.1746, 0.5457);   // #3f74c4
const vec3 HORIZON = vec3(1.0000, 0.6308, 0.3515);   // #ffd0a0
const vec3 SHALLOW = vec3(0.0508, 0.5841, 0.5457);   // #3fc9c4
const vec3 DEEP    = vec3(0.0040, 0.1022, 0.1946);   // #0d5a7a
const vec3 FOAM    = vec3(0.8549, 0.9559, 1.0000);   // #eefaff

// The horizon is NOT one colour. At 14° of sun elevation it runs from a hot
// #ffd0a0 down-sun to a dusky blue counter-glow behind you, and that spread is
// most of what makes a golden-hour sea look like a sea.
//
// This value was (0.100, 0.118, 0.205) — a TENTH of the down-sun luminance, and
// grey with it. With grazing Fresnel at 0.88 the bay was 88% of that number in
// every frame where the camera was not pointed at the sun, which is the flat
// lavender plate the review measured. A real anti-solar horizon at 14° sits at
// roughly a third of the sun-ward one and it is unmistakably BLUE; at a third
// of the luminance and twice the saturation it stops being concrete and starts
// being the deep end of a bay.
const vec3 HZ_ANTI = vec3(0.1350, 0.1690, 0.2980);   // counter-glow, dusk blue

/** Peak Fresnel. See the file header, fault (1). */
const float FRES_MAX = 0.60;

vec3 skyDome(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  float az = dot(normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 1e-5)),
                 normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5, 0.0, 1e-5)));
  vec3 hz = mix(HZ_ANTI, HORIZON, smoothstep(-0.75, 0.92, az));
  vec3 c = mix(hz, ZENITH, pow(up, 0.42));
  // below the horizon the reflection ray sees haze over distant water
  c = mix(vec3(0.072, 0.092, 0.118), c, smoothstep(-0.10, 0.015, d.y));
  float mu = max(dot(d, uSunDir), 0.0);
  c += uSunCol * pow(mu, 8.0) * 0.35;        // Mie forward lobe
  c += uSunCol * pow(mu, 90.0) * 1.8;        // tight halo
  c += uSunCol * pow(mu, 1600.0) * 13.0;     // the disc: this is the glitter
  return c;
}

vec3 envSample(vec3 d) {
  #ifdef ENV_CUBE
    return mix(skyDome(d), textureCube(uEnv, d).rgb, uEnvIntensity * 0.75) ;
  #elif defined(ENV_EQUI)
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    return mix(skyDome(d), texture2D(uEnv, uv).rgb, uEnvIntensity * 0.75);
  #else
    return skyDome(d);
  #endif
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 V = normalize(uCam - vWorld);
  float viewDist = distance(uCam, vWorld);

  // --- normal -------------------------------------------------------------
  // Coarse slope from the vertex-stage derivatives, plus two finer sets
  // evaluated per pixel. Those two are branched out entirely past 420 m: they
  // are multiplied by detailFade anyway, so beyond that they were ten wave
  // evaluations resolving to zero on every water pixel in the frame, and the
  // far water is most of the water.
  float detailFade = 1.0 - smoothstep(60.0, 420.0, viewDist);
  vec2 slope = vWaveD.yz;
  float lace = 0.5;
  if (detailFade > 0.002) {
    vec3 fine = waveSet(vWorld.xz * 3.7 + vec2(11.3, -4.1), uTime * 1.9, 0.085 * detailFade * mix(0.35, 1.0, vShore.r), uChop);
    vec3 micro = waveSet(vWorld.xz * 11.0 + vec2(-30.0, 7.0), uTime * 3.1, 0.018 * detailFade, uChop);
    slope += fine.yz + micro.yz;
    lace = clamp(fine.x * 26.0 + micro.x * 40.0, -1.0, 1.0) * 0.5 + 0.5;
  }
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Flatten toward the horizon — per-pixel wavelets alias badly at grazing
  // angles. flatten01 is how much slope variance was thrown away doing that;
  // the specular lobe below widens by exactly that amount, so the energy comes
  // back as a broad glitter path instead of vanishing.
  float flatten01 = smoothstep(90.0, 1100.0, viewDist);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), flatten01));

  // THE LONG SWELL, at full amplitude, at every distance. See swellSet().
  // Folded in AFTER the flatten so the outer bay keeps a real, moving corduroy
  // across it instead of the mirror it used to be. The amplitude is deliberately
  // held back near the camera, where the geometry is already carrying it.
  vec3 sw = swellSet(vWorld.xz, uTime);
  float swellW = mix(0.30, 1.0, flatten01) * mix(0.45, 1.0, vShore.r);
  N = normalize(vec3(N.x - sw.y * 0.42 * swellW, N.y, N.z - sw.z * 0.42 * swellW));

  float ndv = max(dot(N, V), 0.0);
  // Capped Fresnel. Physically the grazing limit is 1.0 and the sea becomes a
  // pure mirror; pictorially that throws away the entire #3fc9c4 -> #0d5a7a
  // depth ramp the bible asks for, because from a kart 3 m off the deck almost
  // all of the visible water IS at grazing. See the file header, fault (1).
  float fres = 0.02 + FRES_MAX * pow(1.0 - ndv, 5.0);
  // Shallow water is body-dominant — that is *why* a lagoon is turquoise — so
  // the shelf gives up a third of its reflectivity to keep its colour.
  fres *= mix(0.62, 1.0, vShore.r);

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.008);                       // never sample under the sea
  vec3 refl = envSample(R);

  // --- body colour: depth ramp plus a warm upwelling on the sun-facing faces
  // The baked field is a true distance-to-shore transform (see
  // Scenery.bakeSeaField), so vShore.r is a real bathymetric ramp: a wide
  // turquoise shelf off the beach, a short one under the cliffs, deep water in
  // the middle of the bay. A pair of very long-wavelength terms stands in for
  // banks and channels out where the transform has saturated.
  float bath = sin(vWorld.x * 0.0031 + 1.7) * sin(vWorld.z * 0.0027 - 0.6)
             + 0.45 * sin(vWorld.x * 0.0089 - 2.2) * sin(vWorld.z * 0.0071 + 0.9);
  float depth01 = clamp(vShore.r + bath * 0.13, 0.0, 1.0);
  vec3 body = mix(SHALLOW, DEEP, depth01 * depth01);
  float upwell = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float crest = clamp(vWaveD.x * 1.6 + sw.x * 0.9 + 0.35, 0.0, 1.0);
  body *= 0.55 + 0.85 * upwell;
  body += SHALLOW * uSunCol * (1.0 - depth01) * 0.30 * crest;   // sun through the shallows
  // Swell shading. The long components darken their own troughs and lift their
  // crests; at 118 m and 46 m this is a broad, slow corduroy that reads as a
  // moving surface at any range and cannot alias at any of them.
  body *= 1.0 + clamp(sw.x, -1.0, 1.0) * 0.26;

  // --- specular: a tight lobe scaled to a KNOWN peak. A physical GGX D term
  // peaks in the hundreds of thousands at water roughness and would detonate
  // the bloom pass; the sun is not a delta light, so it is clamped by hand.
  vec3 H = normalize(V + uSunDir);
  float ndh = max(dot(N, H), 0.0);
  float ndl = max(dot(N, uSunDir), 0.0);
  // Two lobes. Near water keeps the tight, sharp highlight riding real geometry.
  // Far water gets a wide lobe standing in for the millions of wavelets whose
  // normals were flattened away — that wide lobe IS the sun path across the bay,
  // and without it a golden-hour coastal shot has a dead sea in it.
  float tight = pow(ndh, 1500.0) * ndl * 7.0 * (1.0 - flatten01);
  float broad = pow(ndh, mix(400.0, 30.0, flatten01)) * ndl * mix(1.0, 4.2, flatten01);
  // THE SUN PATH. The glitter is stretched toward the viewer along the sun's
  // own azimuth — a bright road running across the bay to your feet, which at
  // golden hour is the single most beautiful thing available in the frame.
  //
  // The cone WIDENS as it approaches you, because that is what a real sun path
  // does: the far end is a narrow column and the near end fans out over the
  // whole foreground. A fixed exponent of 14 gave a 25° wedge at every range,
  // which read as a searchlight rather than as a path. And the off-axis floor
  // goes 0.08 -> 0.15: away from the sun a golden-hour sea is dark, but it is
  // not black, and 8% left the anti-solar half of the bay with no highlight to
  // sit its whitecaps on.
  float track = pow(max(dot(normalize(R.xz + vec2(1e-5)), normalize(uSunDir.xz + vec2(1e-5))), 0.0),
                    mix(3.5, 15.0, flatten01));
  // Cats-paws: slow wind streaks running down the bay, so the path has texture
  // across it instead of being a smooth airbrushed cone.
  float streak = 0.72 + 0.28 * sin(dot(vWorld.xz, vec2(0.86, 0.51)) * 0.013 + uTime * 0.09)
                            * sin(dot(vWorld.xz, vec2(-0.51, 0.86)) * 0.021 - uTime * 0.05);
  broad *= (0.15 + 0.85 * track) * streak;
  // sparkle: sparse sub-pixel facets riding the lobe, so the glitter path
  // reads as individual points of light rather than a smooth smear
  float sp = hash21(floor(vWorld.xz * 6.0 + vec2(uTime * 0.6, -uTime * 0.4)));
  float sparkle = pow(ndh, 220.0) * step(0.86, sp) * 8.0 * detailFade * (0.25 + 0.75 * track);
  // a coarser, slower facet field that survives out to the horizon
  float spF = hash21(floor(vWorld.xz * 0.55 + vec2(uTime * 0.11, -uTime * 0.07)));
  float glint = pow(ndh, mix(240.0, 70.0, flatten01)) * step(0.82, spF) * 3.6 * flatten01 * (0.12 + 0.88 * track);
  vec3 sun = uSunCol * (tight + broad + sparkle + glint);

  // --- foam
  float shoreFoam = vShore.g;
  float cliffFoam = vShore.b;
  // the shoreline band surges with the swell instead of sitting still
  float surge = sin(vWorld.x * 0.22 + vWorld.z * 0.19 - uTime * 1.35) * 0.5 + 0.5;
  float foam = shoreFoam * smoothstep(0.12, 0.82, surge * 0.55 + lace * 0.65);
  foam += cliffFoam * (0.45 + 0.55 * abs(sin(vWorld.x * 0.35 + uTime * 1.9))) * lace;
  // whitecaps on the steepest crests of the near field
  float steep = length(vWaveD.yz);
  foam += smoothstep(0.16, 0.42, steep) * 0.7 * detailFade;
  // ...and on the swell crests everywhere else. Broken up by a slow noise so
  // the far bay gets a scatter of white specks rather than banded stripes —
  // that scatter is one of the two or three cues that says "sea" at a
  // kilometre, and the old shader had nothing at all out there.
  float capNoise = hash21(floor(vWorld.xz * 0.22 + vec2(uTime * 0.07, uTime * 0.04)));
  float caps = smoothstep(0.62, 0.99, sw.x / 0.95) * step(0.42, capNoise) * streak;
  // ...but not inshore. §1 asks for GLASS-CALM water at the marina, and the
  // shore field already knows where the sheltered shelf is, so the open bay
  // gets its whitecaps and the harbour keeps its mirror.
  foam += caps * 0.78 * smoothstep(0.05, 0.45, flatten01) * mix(0.15, 1.0, vShore.r);
  foam = clamp(foam, 0.0, 1.0);

  vec3 col = mix(body, refl, fres) + sun;
  col = mix(col, FOAM * (0.70 + 0.55 * upwell), foam * 0.88);
  // foam kills the mirror, and the wet edge stays slightly brighter
  col += FOAM * foam * uSunCol * 0.10;

  // --- pre-saturate against the scene's own chroma drain.
  // Sky.ts fogChunks converges CHROMA at 1.85x the rate it converges value,
  // which at 600 m has taken 78% of the saturation off this fragment before it
  // reaches the frame. For a headland that is aerial perspective and it is
  // correct. For the bay it is fatal: hue is the ONLY thing telling the eye
  // that band of the frame is water rather than more sky, and the frames prove
  // it — the review's "flat lavender plate" is this sea at 300-600 m with its
  // colour taken off it. So the water pushes back over exactly the band the
  // drain bites in, and lets go past 1.6 km where converging on the sky is
  // what we actually want.
  float band = smoothstep(60.0, 480.0, viewDist) * (1.0 - smoothstep(900.0, 1900.0, viewDist));
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // clamped: a saturation push past 1.0 can drive the weakest channel of an
  // already-saturated fragment negative, and a negative radiance survives the
  // fog mix and detonates in the bloom pass
  col = max(mix(vec3(lum), col, 1.0 + 1.35 * band), vec3(0.0));

  // --- the horizon must DISSOLVE, not terminate.
  // The scene fog stops at 92% by design (it is what keeps the four backdrop
  // layers from fusing), and 8% of a bright sea against the sky is still a hard
  // bright line — and it was the visible seam across the top of the bay in
  // hero.png. So the water is walked all the way onto the sky it is standing in
  // front of, sampled in its OWN azimuth from the same dome the reflection
  // uses, before the fog is ever applied. Reaching 1.0 rather than 0.9 leaves
  // no step for the fog to preserve; the ramp is held off until 800 m so the
  // middle of the bay — which is most of what a chase camera sees — keeps its
  // own colour, its glitter and its whitecaps.
  vec3 skyline = skyDome(normalize(vec3(-V.x, 0.010, -V.z)));
  col = mix(col, skyline, smoothstep(800.0, 2500.0, viewDist));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
