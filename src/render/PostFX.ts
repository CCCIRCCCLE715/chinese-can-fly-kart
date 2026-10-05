/**
 * ============================================================================
 *  PostFX — the effect chain that sits on top of the raw scene render.
 * ============================================================================
 *  Ownership split with Renderer.ts: Renderer owns the WebGLRenderer, the
 *  EffectComposer and its buffers; PostFX owns everything that goes *into*
 *  the composer (passes + effects) and the per-frame uniform sync.
 *
 *  Chain, in order:
 *    RenderPass            scene -> HDR (half-float) buffer
 *    N8AOPostPass          ground-truth-ish AO, multiplied into the lit colour.
 *                          NB: this pass renders the scene AGAIN into its own
 *                          buffer and composites onto that, so when AO is on it
 *                          — not the composer — owns the multisampling. See
 *                          build().
 *    EffectPass[DoF,Bloom] shallow bokeh focused on the player kart, then a
 *                          high-threshold mipmap bloom, wide + soft. ONE pass:
 *                          see `mergeable()` for why these two and no others.
 *    EffectPass[Grade]     ONE shader: reprojection motion blur + chromatic
 *                          aberration + highlight shoulder + ACES + S-curve +
 *                          split tone (teal lift / warm gain) + sat rolloff +
 *                          speed lines + vignette + grain
 *    EffectPass[SMAA]      final edge resolve on top of MSAA, dithered on the
 *                          way to the screen
 *
 *  Everything downstream of the RenderPass works in scene-linear HDR until the
 *  grade shader tone maps; postprocessing re-linearises between passes and
 *  encodes to sRGB exactly once, on the final write to the default framebuffer.
 * ============================================================================
 */
import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  DepthOfFieldEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  EdgeDetectionMode,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  type Pass,
} from 'postprocessing';
// @ts-ignore — n8ao ships no type declarations, and we may not add a .d.ts here.
import { N8AOPostPass } from 'n8ao';
import { Quality, type Ctx } from '../types';

/**
 * The fraction of the drawing buffer the depth-of-field effect runs its own
 * targets at. See {@link ScaledDepthOfFieldEffect}.
 */
const DOF_INTERNAL_SCALE = 0.5;

/**
 * DepthOfFieldEffect with ALL of its internal targets scaled, not just some.
 *
 * `resolutionScale: 0.5` reads like it halves the effect. It does not. Read
 * postprocessing 6.39's `DepthOfFieldEffect.setSize`: `renderTargetFar`,
 * `renderTargetCoC` and `renderTargetMasked` are sized at the FULL base
 * resolution, and only `renderTarget`, `renderTargetNear` and
 * `renderTargetCoCBlurred` get the scale. Probed on this build at 1920x1080,
 * which is how the split was found rather than assumed:
 *
 *   renderTargetMasked  1920x1080 HalfFloat      renderTarget         960x540
 *   renderTargetFar     1920x1080 HalfFloat      renderTargetNear     960x540
 *   renderTargetCoC     1920x1080 RGBA8          renderTargetCoCBlurred 960x540
 *
 * `update()` runs seven full-screen passes over those, four of them full-res,
 * plus a four-iteration Kawase blur — 9.85 Mpx of full-screen writes per frame
 * against a 2.07 Mpx screen. That is 4.75 screens of fill, and it is the single
 * largest item in the post chain after the AO pass, for an effect the comment
 * at its call site correctly describes as "garnish only".
 *
 * Halving the BASE and letting the library's own scale apply on top puts the
 * first tier at 960x540 and the second at 480x270:
 *
 *   full-screen writes per frame   9.85 Mpx -> 2.46 Mpx   (-75%)
 *   render target memory           51.9 MB  -> 12.9 MB
 *   full-res (2.07 Mpx) targets in the whole chain  9 -> 6
 *
 * THE BOKEH RADIUS IS HELD, and that took a second edit rather than one.
 * `BokehMaterial` steps its kernel by `texelSize * scale`, and `texelSize` is
 * `1 / whatever width the material was told about` — so halving the base
 * DOUBLES the screen-space blur, which is a visible change to an authored art
 * parameter smuggled in under a performance change. It showed: on shots/grid
 * the lighthouse and the far grandstand came back distinctly softer.
 *
 * The obvious fix — halve `bokehScale` — is wrong, because that setter also
 * drives the composite's `scale` uniform (`min(coc * scale, 1.0)`) and the
 * mask pass's `strength`. It would remove blur AMOUNT as well as blur WIDTH,
 * i.e. trade one unrequested art change for another. So only the four bokeh
 * materials are compensated, leaving the blend and the mask exactly as
 * authored. 0.625 texels of a 960-wide buffer is the same UV offset as 1.25 of
 * a 1920-wide one, so the kernel is identical, not merely similar.
 *
 * WHAT IS LEFT AS A REAL TRADE, and it is small: the far colour buffer is now
 * bilinearly upsampled from 960x540, which adds roughly a pixel of softening on
 * top of the authored ~1.25 px; and the circle of confusion is computed at half
 * resolution, which only matters at an in-focus/out-of-focus boundary. With
 * focusDistance 9 and focusRange 60 the only such boundary in this game is the
 * headland against the sky.
 *
 * The reentry guard is load-bearing. `Resolution` fires a `change` event from
 * inside `setBaseSize`, and its listener calls `this.setSize(baseWidth,
 * baseHeight)` — dynamic dispatch, so it lands back HERE with an already-halved
 * base and would halve it again, and again, until the buffer rounds to nothing.
 * `super.setSize` finishes sizing every target after `setBaseSize` returns, so
 * swallowing the reentrant call loses nothing.
 */
class ScaledDepthOfFieldEffect extends DepthOfFieldEffect {
  private sizing = false;

  constructor(camera: THREE.Camera, opts: {
    focusDistance: number; focusRange: number; bokehScale: number; resolutionScale: number;
  }) {
    super(camera, opts);
    // The four bokeh passes are public fields on the effect but are not in
    // postprocessing's shipped .d.ts, hence the cast. Guarded rather than
    // assumed: if a future version renames them the compensation is skipped and
    // the blur widens, which is a look change — not a crash — and the assert
    // below is what a reviewer would want to see fire.
    const dof = this as unknown as Record<string, { fullscreenMaterial?: { scale?: number } }>;
    const names = ['bokehNearBasePass', 'bokehNearFillPass',
      'bokehFarBasePass', 'bokehFarFillPass'];
    for (const n of names) {
      const mat = dof[n]?.fullscreenMaterial;
      if (mat === undefined || typeof mat.scale !== 'number') {
        console.warn(`[postfx] ${n} has no bokeh material; DoF kernel not compensated ` +
          `for the ${DOF_INTERNAL_SCALE}x internal buffer and will be wider than authored`);
        continue;
      }
      mat.scale = opts.bokehScale * DOF_INTERNAL_SCALE;
    }
  }

  override setSize(width: number, height: number): void {
    if (this.sizing) return;
    this.sizing = true;
    try {
      super.setSize(
        Math.max(1, Math.round(width * DOF_INTERNAL_SCALE)),
        Math.max(1, Math.round(height * DOF_INTERNAL_SCALE)),
      );
    } finally {
      this.sizing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// The merged grade / lens shader.
// ---------------------------------------------------------------------------
// Five separate passes (blur, CA, tone map, grade, vignette+grain) would cost
// five full-screen bandwidth round trips and quantise the image four extra
// times. Merged, it is one pass and the whole grade happens in float.
const GRADE_FRAGMENT = /* glsl */ `
uniform mat4 prevViewProj;
uniform mat4 invViewProj;
uniform vec4 grade;   // x exposure, y S-curve amount, z saturation, w vignette (authored base)
uniform vec4 lens;    // x aberration, y grain, z speed-line gain, w shutter
uniform vec3 rush;    // x radial blur amount, y gated speed intensity, z boost kick (0..1)
uniform vec2 vig;     // x vignette amount (speed-driven), y inner edge (closes in with speed)
uniform vec3 subject; // world-space centre of the player's kart
uniform vec2 hold;    // hold-out radii about the subject: x fully sharp, y fully blurred (metres)
uniform vec3 coolTint;
uniform vec3 warmTint;
uniform vec3 shadowLift;
uniform vec4 rolloff; // x knee (scene-linear), y exponent, z highlight desat, w desat span

const vec3 KR_LUMA = vec3(0.2126, 0.7152, 0.0722);

float krHash12(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float krValueNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(krHash12(vec2(i, 17.3)), krHash12(vec2(i + 1.0, 17.3)), f);
}

// Scene-linear highlight shoulder, applied BEFORE the display transform.
//
// ACES on its own maps everything past roughly 3x mid-grey into the last few
// hundredths of display range, so a roof at 4x and a roof at 20x land on the
// same #ffffff and the highlight reads as a flat paper cut-out with no gradient
// inside it. Compressing the top end first is what gives those two values room
// to separate again.
//
// The curve is a power law above the knee, not a saturating exponential. An
// asymptote would buy separation at the cost of never reaching white, and the
// art bible is explicit that chrome and water must clip to white and bloom.
//
// THE EXPONENT IS THE CLAMP THE REVIEW FOUND, and the old comment here was
// wrong about it. "x^0.30 keeps climbing forever, so a specular two orders of
// magnitude up still gets there" is true only in the limit and false in every
// frame we actually ship. Work it through: the ACES RRT/ODT rational fit reaches
// 1.0 at v = 25.67, and v = mc * (exposure / 0.6) = mc * 1.75, so the shoulder
// has to hand ACES mc = 14.67. With knee 0.75 and p = 0.30 that needs
//
//     m = knee * (mc / knee)^(1/p) = 0.75 * (19.56)^3.333 ~= 15100 scene-linear
//
// i.e. NOTHING in this game reaches display white — the brightest thing in
// r1/boost.png measures ~32 scene-linear, which the old curve delivered at 232.
// Every shot ceilinged in the 232-250 band, 0.00% of pixels above 252, no sun
// disc, and the bloom that WAS firing (threshold 2.0 linear sits around display
// 202 on the old curve, so plenty cleared it) got squashed back into the same
// five percent of range as the thing it was blooming off. That is the "milky
// diffuse smear with no disc" and the "identical ~249 ceiling" in one bug: 249.6
// is simply where this curve puts 1000 scene-linear.
//
// Fixed by making the shoulder reach white at a level the scene can produce.
// Knee 0.90, p = 0.72 puts display white at m ~= 43 scene-linear:
//
//     m     0.7    0.9    1.0    2.0    4.0    8.0   20.0   43+
//     old   174    183    185    205    218    228    237    <=249  (asymptote)
//     new   174    191    196    220    236    245    252    255    (clips)
//
// Below the knee nothing moves at all, so the shadows, the tarmac and the key's
// own falloff are untouched and the golden-hour mood is unchanged; the exposure
// stays at the bible's 1.05. What changes is that the top two stops stop being
// a single value: sun-on-chrome, water sparkle, the sun disc and boost flame now
// clip and bloom, and a roof at 4x still separates cleanly from one at 20x.
//
// It is gated on the brightest channel rather than on luminance: a saturated red
// at 1.2 linear has a luminance of only 0.49, so a luminance gate would let it
// past and the red channel would clip on its own — which is exactly how a warm
// highlight breaks to a flat primary. max(rgb) compresses the channel that is
// actually about to clip.
//
// rolloff.z is the highlight desaturation. At 0.55 over a span of 12x the knee,
// EVERY bright coloured thing in the game arrived at white well before it
// arrived at 255: a tier-3 drift plume at scene-linear (12, 4, 20) came out
// rgb(243, 225, 238) — chroma 0.07, i.e. grey. It sits at 0.16 over a span of
// 30x now: highlights that roll off INTO colour, as the bible asks, while the
// sun disc and sun-on-chrome still bleach to white on the way out. The span came
// down from 40x with the knee moving up, so the desat still lands in the same
// place in absolute scene-linear terms (0.9 * 30 = 27, was 0.75 * 40 = 30).
vec3 krHighlightRolloff(vec3 c) {
  float m = max(max(c.r, c.g), c.b);
  float knee = rolloff.x;
  if (m <= knee) return c;
  float mc = knee * pow(m / knee, rolloff.y);
  vec3 scaled = c * (mc / max(m, 1e-5));
  float desat = smoothstep(knee, knee * rolloff.w, m) * rolloff.z;
  return mix(scaled, vec3(dot(scaled, KR_LUMA)), desat);
}

vec3 krRRTODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

// Bit-for-bit the same operator three uses for ACESFilmicToneMapping, so a
// no-post preview and the composed frame agree on exposure and hue shift.
vec3 krToneMap(vec3 c) {
  c *= grade.x / 0.6;
  c = mat3(0.59719, 0.07600, 0.02840,
           0.35458, 0.90834, 0.13383,
           0.04823, 0.01566, 0.83777) * c;
  c = krRRTODTFit(c);
  c = mat3( 1.60475, -0.10208, -0.00327,
           -0.53108,  1.10813, -0.07276,
           -0.07367, -0.00605,  1.07602) * c;
  return clamp(c, 0.0, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec2 fromCentre = uv - 0.5;

  // Normalised so 1.0 is the frame corner at any aspect ratio — otherwise the
  // vignette, the aberration ramp and the streak band all drift as the window
  // is resized. Needed up here now because the aberration is gated on it.
  vec2 aspectVec = vec2(aspect, 1.0);
  float rad = length(fromCentre * aspectVec) / (0.5 * length(aspectVec));

  // --- screen-space velocity -----------------------------------------------
  // Unproject this pixel to world space with the current inverse view-proj,
  // then reproject it through last frame's view-proj. Camera-only (no skinned
  // or rigid per-object velocity buffer exists in this project) but it is the
  // camera that swings on a drift exit, which is where blur reads as speed.
  vec4 world = invViewProj * vec4(fromCentre * 2.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;
  vec4 prevClip = prevViewProj * world;
  vec2 prevUv = prevClip.xy / max(prevClip.w, 1e-4) * 0.5 + 0.5;
  vec2 velocity = (uv - prevUv) * lens.w;

#if MB_SAMPLES < 2
  // ONE reprojection tap cannot integrate a streak: the loop below jitters its
  // single tap along the velocity vector, which is not a blur but a per-pixel
  // random displacement of up to half the streak length (~15 px at 1080p at
  // speed). That is what dissolved the tunnel rock, the village roofs and the
  // kerb stripes into directional mush in every headless capture. So the
  // CAMERA term is dropped on a one-tap build.
  //
  // The radial rush below is NOT dropped with it, and that is the fix this
  // round is really about. The capture path builds with one tap by design, so
  // the old blanket zeroing of velocity meant the reviewed boost frame had no
  // smear of any kind — the loudest complaint in the set. The rush term gets
  // its own guaranteed tap budget (SMEAR_SAMPLES, never below six) and is
  // gated on speed, so it costs nothing except on the frames that are supposed
  // to be violent.
  velocity = vec2(0.0);
#endif

  // The camera term keeps its own old ceiling. Only the radial rush is allowed
  // past it, because only the radial rush is zero in the middle of the frame:
  // a long camera streak is mush, a long radial streak is speed.
  float camTravel = length(velocity);
  velocity *= min(camTravel, 0.016) / max(camTravel, 1e-5);

  // --- arcade zoom-blur -----------------------------------------------------
  // The world streak, and the only motion cue the capture path has (the camera
  // reprojection term above is dropped on a one-tap build, and the hero kart is
  // masked out of everything below).
  //
  // WEIGHTED TOWARD THE FRAME EDGE, on top of the |fromCentre| the term already
  // carries. A plain radial blur is linear in radius, so at rad 0.5 it is
  // already half as long as at the corner — which puts real smear on the road
  // surface and the vanishing point while the corners, where trackside geometry
  // rushes past, are still not moving enough to read. The extra (0.30 + 0.70*r)
  // makes the profile quadratic: 15% of the corner length at mid-radius, full
  // length only in the outer quarter. That is what lets the magnitude go up by
  // 2x without any of it landing where the reviewers said it was mush.
  velocity += fromCentre * (rush.x * (0.30 + 0.70 * rad));

  // --- hero hold-out --------------------------------------------------------
  // The player's kart is rigidly bolted to the camera, so a camera-only
  // reprojection sees its pixels as *static world geometry rushing backwards*
  // and smears the hero subject harder than anything else in frame — at speed
  // the model, its livery and the driver dissolve completely. There is no
  // per-object velocity buffer to solve it properly, so the subject is masked
  // out of the velocity here instead.
  //
  // The mask is a sphere in WORLD space, centred on the kart, and that is the
  // whole point. The previous attempt was a *depth band* driven off the
  // camera-to-kart distance (hold out everything nearer than 1.3x the arm), and
  // it fails for a reason that is easy to miss on a straight and impossible to
  // miss under boost: the chase rig's surge pulls the eye in to about 4.5 m on a
  // boost, so 1.3x the arm is only 1.4 m of clearance — while the kart is 2.1 m
  // long and the camera is looking *down* the length of it. The band therefore
  // cut straight through the model, and because screen-vertical maps to depth
  // under a rig that looks down, it cut horizontally: the helmet, the roll bar
  // and the spoiler (nearest the eye) stayed sharp and the fenders, the nose and
  // the number plate (furthest) took the full streak. That is precisely the
  // half-sharp, half-dissolved kart in shots/r4/boost.png and scenery.png, and
  // no amount of widening fixes it, because the failure is that a scalar depth
  // band cannot describe a 2 m object viewed end-on from 4 m away.
  //
  // Measuring distance from the kart's own centre has none of that geometry in
  // it. The world position is already reconstructed for the reprojection above,
  // so the test costs one subtract and one length. It holds at any arm length, any
  // pitch and any camera mode, and — unlike a depth band — it holds ONLY the
  // kart: a rival two metres to the side sits outside the sphere and keeps its
  // streak, where the depth band was wrongly freezing every kart in the same
  // slice of the frame.
  //
  // The radii are sized off the model. The worst corner of the bodywork is about
  // 1.7 m from the chassis centre of mass (0.87 lateral, 1.05 longitudinal, 1.05
  // to the top of the helmet), so hold.x adds a third of a metre on top of that:
  // a gather needs its *neighbours* masked too, or the road pixels just outside
  // the silhouette pick the kart up along their own streak and drag it outward —
  // the translucent wings hanging off both fenders in the r4 frames. hold.y then
  // releases over another 1.3 m so the tarmac eases back into the streak instead
  // of stepping into it.
  velocity *= smoothstep(hold.x, hold.y, distance(world.xyz, subject));

  float travel = length(velocity);
  // Capped so the fixed tap budget always covers the streak — an unbounded
  // travel with SMEAR_SAMPLES taps turns the dither jitter into visible noise
  // rather than into a smooth blur. The ceiling opens up under boost because
  // the rush term is RADIAL: it is exactly zero in the middle of the frame and
  // only reaches full length out at the corners, so a long streak there costs
  // the subject and the racing line nothing.
  float travelCap = 0.0125 + 0.0105 * rush.z;
  velocity *= min(travel, travelCap) / max(travel, 1e-5);
  travel = min(travel, travelCap);

  // --- lateral chromatic aberration ----------------------------------------
  // Two things were wrong here and both of them printed as per-pixel magenta /
  // green speckle over the tarmac, which four reviewers independently read as a
  // compression fault or as coloured grain.
  //
  // 1. It was never actually zero in the middle of frame. 0.35 + r^2 * 3.4
  //    still fringes dead centre at 35% of full strength, and the art bible
  //    (§2) asks for aberration "at the frame edge only". It is a genuine
  //    smoothstep from a third of the way out now, so the middle third — where
  //    the kart and the vanishing point live — is bit-exact clean, and that
  //    branch also drops the pass from three fetches per tap to one there.
  //
  // 2. The magnitude was allowed past a texel. Cross-correlating the R and B
  //    high-frequency content of r1/grid.png over the foreground gravel:
  //    corr(R,B) is 0.16 at zero lag and 0.61 once R is shifted back by one
  //    pixel — i.e. the aberration was displacing R and B across each other by
  //    ~1-2 px over a surface whose per-pixel luma sigma is 20-34, so it turned
  //    that surface's own specular aliasing into decorrelated chroma. Below
  //    about a texel the bilinear fetch IS the low-pass: R lands as a lerp of
  //    the same two texels G sampled, the channels stay correlated, and the
  //    fringe reads as a fringe instead of as confetti. So the offset is capped
  //    in PIXELS, which also makes it safe at any render scale.
  //
  // Strength tracks the eased speed signal on the CPU side (lens.x), NOT the
  // length of the motion smear. The old 1 - 0.75 * smoothstep(0, 0.010,
  // length(velocity)) rolloff was dead code on the capture path — that path
  // builds with one tap and zeroes the velocity above, so the rolloff measured
  // zero and never engaged, leaving full boost-strength fringing on exactly the
  // frames the reviewers were sent. Gating on speed is what was meant.
  float caShape = smoothstep(0.34, 1.0, rad);
  vec2 fringe = fromCentre * (lens.x * caShape * caShape);
  float fringePx = length(fringe / texelSize);
  // Under a twentieth of a texel there is no fringe, only two redundant texture
  // fetches per tap. Snap it off so the whole middle of the frame takes the
  // cheap branch below.
  if (fringePx < 0.05) {
    fringe = vec2(0.0);
    fringePx = 0.0;
  } else {
    fringe *= min(fringePx, CA_MAX_TEXELS) / fringePx;
  }

  vec2 lo = texelSize;
  vec2 hi = vec2(1.0) - texelSize;
  // Jitter breaks the tap pattern into noise instead of ghost steps. Safe to
  // run unconditionally now: the smear loop is never entered with fewer than
  // SMEAR_SAMPLES taps, and SMEAR_SAMPLES is never below six.
  float jitter = krHash12(uv * resolution + fract(time) * 311.0) - 0.5;

  vec3 c;
  // Under ~0.4 px of travel there is nothing to integrate, so the whole frame
  // takes a single tap — which is every frame that is not fast or boosting,
  // including all of the still, low-speed captures.
  if (travel > 0.0002) {
    // The tap budget follows the length of the streak rather than being fixed.
    //
    // This matters now that the radial rush is driven by sustained speed and
    // not only by a boost: the smear loop is entered on every frame above ~70%
    // of top speed, which is most of a lap, where it used to be entered for two
    // seconds at a time. A full budget is only needed once the streak is long
    // enough for the gaps between taps to show — under ~8 px at 1080p, half the
    // taps plus the per-pixel jitter already resolve into a smooth gradient, and
    // half the taps is half the bandwidth over ~90% of the frame. Boost streaks
    // (17-24 px at the corner) still get everything.
    int taps = travel > 0.0040 ? SMEAR_SAMPLES : (SMEAR_SAMPLES / 2);
    float fTaps = float(taps);
    c = vec3(0.0);
    if (fringePx > 0.0) {
      for (int i = 0; i < SMEAR_SAMPLES; ++i) {
        if (i >= taps) break;
        float k = (float(i) + 0.5 + jitter) / fTaps - 0.5;
        vec2 p = uv + velocity * k;
        c.r += texture2D(inputBuffer, clamp(p + fringe, lo, hi)).r;
        c.g += texture2D(inputBuffer, clamp(p, lo, hi)).g;
        c.b += texture2D(inputBuffer, clamp(p - fringe, lo, hi)).b;
      }
    } else {
      for (int i = 0; i < SMEAR_SAMPLES; ++i) {
        if (i >= taps) break;
        float k = (float(i) + 0.5 + jitter) / fTaps - 0.5;
        c += texture2D(inputBuffer, clamp(uv + velocity * k, lo, hi)).rgb;
      }
    }
    c /= fTaps;
  } else if (fringePx > 0.0) {
    c.r = texture2D(inputBuffer, clamp(uv + fringe, lo, hi)).r;
    c.g = texture2D(inputBuffer, clamp(uv, lo, hi)).g;
    c.b = texture2D(inputBuffer, clamp(uv - fringe, lo, hi)).b;
  } else {
    c = texture2D(inputBuffer, uv).rgb;
  }

  // --- display transform ---------------------------------------------------
  // Shoulder first, while there is still headroom to shape: once ACES has run
  // the information is already gone.
  c = krHighlightRolloff(c);
  c = krToneMap(c);

  // Filmic S. smoothstep-toward keeps 0 and 1 pinned, so it adds midtone snap
  // without crushing the shadow detail the AO pass just paid for.
  c = mix(c, c * c * (3.0 - 2.0 * c), grade.y);

  // --- split tone ----------------------------------------------------------
  // Gain alone cannot separate a shadow from the lit surface next to it: a
  // multiply scales toward zero, so the darkest pixels stay exactly the hue
  // they already were and every shadow ends up a darker copy of the key. The
  // lift is what actually moves them — an additive teal offset weighted to the
  // bottom of the curve, which is the ASC-CDL 'offset' term and the reason a
  // graded frame has a cool side at all. Kept small so the blacks tint rather
  // than milk.
  float lum = dot(c, KR_LUMA);
  float shadowW = 1.0 - smoothstep(0.0, 0.55, lum);
  float highW = smoothstep(0.40, 1.0, lum);
  c += shadowLift * shadowW;
  c *= mix(vec3(1.0), coolTint, shadowW * 0.70);
  c *= mix(vec3(1.0), warmTint, highW * 0.55);
  c = max(c, 0.0);

  lum = dot(c, KR_LUMA);
  // Saturation lift, rolled off in the highlights so bloomed chrome and the
  // sun on water go white rather than neon.
  c = max(mix(vec3(lum), c, grade.z * (1.0 - 0.40 * smoothstep(0.70, 1.0, lum))), 0.0);

  // --- radial speed lines --------------------------------------------------
  // lens.z is the gain and it is DRIVEN now. It used to be initialised to 0.15
  // and never written, and rush.y — the gate — only opened above a speed
  // signal that the game itself capped below the gate's own knee. Worked
  // through on the reviewed boost frame: speedIntensity topped out at 0.22,
  // rush.y = smoothstep(0.22, 0.42, 1.0) = 0.0, so the term was multiplied by
  // exactly zero. "A 120 km/h boost frame with no speed lines" was literal.
  //
  // Two populations now, and the second is the whole point of the effect:
  //   - a sparse warm set that rides the plain speed ramp and only frames;
  //   - a denser, whiter, faster set that fades in with the boost kick
  //     (rush.z), reaches further toward the centre and streaks harder.
  float streakGain = lens.z * rush.y;
  if (streakGain > 0.001) {
    float ang = atan(fromCentre.y, fromCentre.x);
    float kick = rush.z;
    float n = krValueNoise(ang * 26.0 + time * 1.6) * 0.62
            + krValueNoise(ang * 63.0 - time * 2.4) * 0.38;
    // Threshold widened from (0.60, 0.97). 'n' is the sum of two value-noise
    // octaves, so it is roughly normal about 0.5 with sd ~0.18: a 0.97 upper
    // edge means the comb only ever reached full strength on ~0.5% of angles
    // and sat under a third of it on almost all of the rest. Whatever gain was
    // dialled in on top of that, the frame got a handful of faint hairs. At
    // (0.55, 0.93) about a third of the angular domain carries a ray and the
    // brightest decile actually reaches the authored gain — which is the
    // difference between "there are speed lines if you look for them" and a
    // comb you read at a glance.
    float streak = smoothstep(0.55, 0.93, n);
    // Banded so they live in the outer third: they frame, they don't obscure.
    // Under boost the band reaches a little further in and the outer rolloff
    // moves out, so the lines read as converging on the kart rather than as a
    // ring around it.
    //
    // The inner edge used to sit at 0.42 (0.30 under boost), which is not the
    // outer third — at rad 0.30 the band is already inside the middle of the
    // frame, and a full-length ray then runs from there to the corner. Over the
    // tunnel that drew a starburst across the entire image and the shot came
    // back unreadable. 0.55 / 0.44 is the outer third the comment always
    // claimed.
    float band = smoothstep(mix(0.55, 0.44, kick), 0.98, rad)
               * (1.0 - smoothstep(1.05, 1.50, rad));
    float lines = streak * band * streakGain;

    // The boost set: higher angular frequency, moving several times faster,
    // and near-white. Additive on top of the first set, so at rest it does not
    // exist at all and on a boost the frame gains a second, tighter comb.
    if (kick > 0.004) {
      float n2 = krValueNoise(ang * 47.0 - time * 7.5) * 0.58
               + krValueNoise(ang * 111.0 + time * 11.0) * 0.42;
      float streak2 = smoothstep(0.66, 0.99, n2);
      float band2 = smoothstep(0.42, 0.90, rad) * (1.0 - smoothstep(1.10, 1.55, rad));
      lines += streak2 * band2 * kick * lens.z * 0.42;
    }

    // Speed lines STREAK THE LIGHT THAT IS THERE; they are not a light source
    // of their own. Without this they are a constant additive wash, so the
    // darker the scene the more completely they take it over — which is exactly
    // how a lit tunnel at 89 km/h came back as white rays on black. Floored at
    // 0.42 so a boost still reads in the dark, where it has to.
    float sceneLit = 0.42 + 0.58 * smoothstep(0.04, 0.42, lum);
    lines *= sceneLit;

    // Shoulder on the SUM, so the rare pixel where both combs peak at once over
    // an already-bright sky compresses instead of punching a hole of pure white
    // in the corner of the frame. Art bible §6: three stacked effects must not
    // white the frame out.
    //
    // Plus a HEADROOM term, which is what makes the gain safe to double. The
    // shoulder alone is scene-independent: it caps what the comb ADDS, not what
    // the sum arrives at, so the same ray that reads as a bright hair over the
    // road at display 0.45 lands at 1.0+ over the golden-hour sky at 0.85 and
    // punches a white notch out of the corner. Rolling the comb off through the
    // top third of the range costs nothing where there is room (the tunnel, the
    // tarmac, the cliff face) and keeps the brightest content — which is where
    // a clipped ray is most obvious and least useful — under the ceiling.
    float head = 1.0 - 0.50 * smoothstep(0.60, 1.00, lum);
    c += (lines / (1.0 + lines * 1.2)) * head * vec3(1.0, 0.972, 0.918);
  }

  // Vignette AFTER the display transform, deliberately. Applied in linear it
  // would be a light-loss term that the shoulder then has to re-expand, which
  // is a second way to lose the top end; here it is what it is supposed to be,
  // a print-down of the finished image.
  //
  // It CLOSES IN with speed now ('vig', driven on the CPU side): the amount
  // rises from the authored 0.22 to 0.36 and the inner edge walks from rad 0.30
  // to rad 0.16, so flat out the frame is being squeezed from a third of the
  // way out instead of only at the corners. This is the cheapest of all the
  // speed cues and the one that survives at thumbnail size.
  c *= 1.0 - vig.x * smoothstep(vig.y, 1.02, rad);

  // Grain last, and monochrome — the same scalar is added to all three
  // channels, so it can only ever be luma noise. (The coloured speckle in the
  // review frames is not this; it is surface specular aliasing fringed by the
  // aberration above, plus the tarmac/sand normal maps aliasing on their own.)
  //
  // Weighted toward the midtones, but now rolled OFF again below ~0.14 display
  // luma. Full-amplitude grain in the bottom eighth of the range is where 8-bit
  // dither, the teal shadow lift and the AO all live, and adding +/-2 counts of
  // white noise on top of them is what makes a shadow read as sensor noise
  // rather than as shadow.
  float g = krHash12(uv * resolution * 1.37 + fract(time * 0.37) * 977.0) - 0.5;
  c += g * lens.y * (1.15 - 0.75 * lum) * smoothstep(0.015, 0.14, lum);

  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

/** Tuning knobs for {@link GradeEffect}. All in final display-referred terms. */
export interface GradeOptions {
  /** motion-blur taps; 1 disables the blur and leaves plain aberration */
  samples: number;
  exposure: number;
  contrast: number;
  saturation: number;
  vignette: number;
  grain: number;
}

export class GradeEffect extends Effect {
  constructor(opts: GradeOptions) {
    super('KartGrade', GRADE_FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      defines: new Map([
        ['MB_SAMPLES', String(Math.max(1, Math.round(opts.samples)))],
        // Hard ceiling on the aberration offset, in pixels. See the aberration
        // block in GRADE_FRAGMENT: past about a texel the fringe stops being a
        // fringe and starts decorrelating the channels of whatever specular
        // aliasing is already on screen.
        // Raised from 1.25. The reasoning below (under about a texel the
        // bilinear fetch is its own low-pass, so the channels stay correlated
        // and the fringe reads as a fringe) is what sets the FLOOR, not the
        // ceiling — and at 1.25 the cap was biting at 78% of top speed, so the
        // aberration was pinned from three-quarter pace all the way to a boost
        // and carried none of the ramp §2 asks for. 2.0 texels is where the
        // authored corner offset (CA_BOOST at |fromCentre| = 0.707, i.e.
        // 0.00134 uv, against the bible's 0.0012) actually lands at 1080p, so
        // the cap is now a safety net for small render scales rather than the
        // thing that decides the look.
        ['CA_MAX_TEXELS', '2.0'],
        // Tap budget for the SMEAR loop, which is entered only when there is
        // more than ~0.4 px of travel. Never below six, whatever the
        // reprojection budget is: the radial boost rush has to integrate
        // properly even on the one-tap software/capture build, and that build
        // is what every reviewed frame is rendered with.
        // Nine, up from six, because the streak it has to integrate got longer:
        // the boost corner now travels ~0.0175 uv (27 px at 1080p) against
        // ~0.011 (17 px) before. Six taps over that is 4.5 px between samples,
        // which the per-pixel jitter turns into visible noise rather than into a
        // gradient; nine keeps the spacing at 3.4 px, i.e. the same sample
        // density the old boost frame had. It is only ever paid on frames with
        // more than ~0.4 px of travel, and the half-budget branch below still
        // covers most of the screen area because the rush is edge-weighted.
        // Eleven, up from nine, because the ignition pulse lengthened the
        // streak again: `travelCap` is 0.0125 + 0.0105 * rush.z and rush.z now
        // reaches 1.25 during a release, so the corner travels ~0.026 uv (50 px
        // at 1080p). Nine taps over that is 5.5 px between samples, which the
        // per-pixel jitter renders as noise rather than as a gradient; eleven
        // holds it at 4.5 px. Paid only on frames with more than ~0.4 px of
        // travel, and the half-budget branch still covers most of the screen
        // because the rush is edge-weighted.
        ['SMEAR_SAMPLES', String(Math.max(11, Math.round(opts.samples)))],
      ]),
      uniforms: new Map<string, THREE.Uniform>([
        ['prevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['invViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['grade', new THREE.Uniform(
          new THREE.Vector4(opts.exposure, opts.contrast, opts.saturation, opts.vignette))],
        ['lens', new THREE.Uniform(new THREE.Vector4(CA_REST, opts.grain, STREAK_REST, 0.0))],
        ['rush', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        // Seeded with the authored vignette so a frame rendered before the
        // first `sync` looks exactly like the old constant-vignette build.
        ['vig', new THREE.Uniform(new THREE.Vector2(opts.vignette, VIGNETTE_INNER_REST))],
        ['subject', new THREE.Uniform(new THREE.Vector3())],
        // Released until `sync` finds a player kart: with a negative outer
        // radius the smoothstep returns 1 everywhere and nothing is held.
        ['hold', new THREE.Uniform(new THREE.Vector2(-2, -1))],
        // Teal-leaning shadows / warm highlights, both near-luminance-neutral.
        // The cool side leans on green as well as blue: a purely blue shadow
        // against a #ffd9a8 key reads as violet, which is the exact hue the
        // frame already has too much of. Teal is what separates it.
        //
        // Pulled to 45% of the authored chroma (was 0.815/0.985/1.155), and
        // this is where the "the tarmac reads wet, not dry" note actually
        // lives. It was chased through the tarmac material for a round on the
        // theory that the road was a blue hemispherical mirror; it is not.
        // Measured on the real frame: zeroing `envMapIntensity` on all three
        // road materials moves the road band from 46% saturation to 51% — i.e.
        // the IBL is not the source and removing it makes it marginally worse.
        // Neutralising THIS pair takes the same band to 22%. The split-tone is
        // what was painting every dark surface teal-blue, the road is simply
        // the largest dark surface in frame, and the saturation lift below then
        // multiplies the chroma the split-tone just created.
        //
        // Swept 1.0 / 0.75 / 0.6 / 0.5 / 0.4 / 0.3 / 0 against three regions of
        // the same frame: the road falls 0.448 -> 0.221 across the sweep, the
        // SKY does not move at all (0.483 -> 0.500 — this term only ever
        // touched the shadows), and the warm midtones *gain* chroma as it comes
        // off, because the teal was desaturating them. 0.45 lands the road near
        // 0.32 and still delivers the §2 sky-fill in the shadows.
        //
        // ROTATED TOWARD TEAL THIS ROUND, at constant chroma. Measured off the
        // banked tarmac in r1/corner.png (600x300 px, 180 000 samples): the
        // shaded road comes out mean rgb(24.0, 26.6, 37.7), i.e. B/G = 1.42 and
        // an HSV saturation of 0.48 — that is a blue-violet shadow, not the
        // teal §2 asks for, and 0.48 is also well over the 0.32 the last round
        // set out to land. This pair was the last multiplicative thing in the
        // chain still leaning on blue alone: 0.917/0.993/1.070 lifts B without
        // lifting G at all, which is a *blue* axis by definition however small
        // it is. 0.900/1.010/1.045 moves G above unity with B, which is what
        // makes the axis teal, and it does it with slightly LESS total chroma
        // (spread 0.145 against 0.153) and slightly less luminance loss
        // (0.9892 against 0.9825) — so the road desaturates a little rather
        // than gaining more colour, and §9.6's "no pure-black shadows" gains a
        // hair of headroom at the same time.
        ['coolTint', new THREE.Uniform(new THREE.Vector3(0.900, 1.010, 1.045))],
        ['warmTint', new THREE.Uniform(new THREE.Vector3(1.115, 1.005, 0.878))],
        // Additive teal lift on the bottom of the curve — art bible §2 asks for
        // a #a8c8ff sky fill in the shadows, and nothing multiplicative can
        // produce it. Sized to sit just above the noise floor of an 8-bit write.
        // Scaled with `coolTint` to 45% of the authored value (was
        // -0.0015/0.0035/0.0092) — see the note there; the two are one effect
        // and retuning either alone just moves the blue between them.
        // Rotated with `coolTint` — the two are one effect. B/G was 2.62, which
        // is a violet offset with a token amount of green in it; it is 1.20
        // now, which is teal. Total chroma comes DOWN (0.0039 against 0.0048)
        // and the luminance lift goes UP (0.0018 against 0.0013), which is the
        // right direction on both counts: the measured shaded road is
        // oversaturated at 0.48 and 1-2% of every frame sits below display 8.
        //
        // It is deliberately still small. Raising this far enough to put the
        // shaded tarmac at the 0.04-0.06 floor §9.6 wants would need ~+0.018,
        // which is 4.6 counts of flat teal poured over every dark pixel in the
        // frame — that milks the blacks instead of tinting them, and it is the
        // regression the last round spent itself undoing. The floor has to come
        // from the sky-fill ambient in Sky.ts, not from the grade.
        ['shadowLift', new THREE.Uniform(new THREE.Vector3(-0.00090, 0.00250, 0.00300))],
        // Highlight shoulder: knee just above sunlit diffuse white, then
        // x^0.72 above it, with only a light pull toward luminance so a hot
        // colour stays a colour until it is genuinely an order of magnitude
        // over. The exponent is sized so display white lands at ~43x
        // scene-linear — reachable by the sun disc, sun-on-chrome, water
        // sparkle and boost flame, and by nothing else. See krHighlightRolloff.
        ['rolloff', new THREE.Uniform(new THREE.Vector4(0.90, 0.72, 0.16, 30.0))],
      ]),
    });
  }

  get grade(): THREE.Vector4 { return this.uniforms.get('grade')!.value; }
  get lens(): THREE.Vector4 { return this.uniforms.get('lens')!.value; }
  get rush(): THREE.Vector3 { return this.uniforms.get('rush')!.value; }
  get vig(): THREE.Vector2 { return this.uniforms.get('vig')!.value; }
  get subject(): THREE.Vector3 { return this.uniforms.get('subject')!.value; }
  get hold(): THREE.Vector2 { return this.uniforms.get('hold')!.value; }
  get prevViewProj(): THREE.Matrix4 { return this.uniforms.get('prevViewProj')!.value; }
  get invViewProj(): THREE.Matrix4 { return this.uniforms.get('invViewProj')!.value; }
}

// ---------------------------------------------------------------------------
// Scratch — nothing below allocates once the chain is built.
// ---------------------------------------------------------------------------
const _viewProj = new THREE.Matrix4();
const _dofTarget = new THREE.Vector3();

/**
 * How aggressively speedIntensity is allowed to move the lens, per tier.
 *
 * These are the per-channel offset at |fromCentre| = 1, so the actual offset at
 * the frame CORNER (|fromCentre| = 0.707, radial shape = 1) is 0.707x them:
 * 0.00032 uv at rest and 0.00113 uv flat out, against the art bible's 0.0012 at
 * the frame edge scaling with speed. In pixels at 1080p that is 0.5 px and
 * 1.8 px, and the shader caps the offset at CA_MAX_TEXELS on top of that.
 *
 * They were 0.0007 / 0.0032, which put the corner at 0.0046 uv — nearly 4x what
 * §2 asks for, ~9 px of separation, and the direct cause of the coloured
 * speckle over the boost road.
 */
const CA_REST = 0.00045;
const CA_BOOST = 0.0019;

/**
 * Vignette, at rest and flat out, plus where the print-down starts.
 *
 * The bible authors 0.22 (§2) and that is what a still frame gets. The extra
 * 0.14 and the inner edge walking from 0.30 to 0.16 is the speed term: at
 * 101 km/h the frame is being closed in on from a third of the way out, which
 * is a cue that survives being looked at for a tenth of a second.
 */
const VIGNETTE_SPEED = 0.14;
const VIGNETTE_INNER_REST = 0.30;
const VIGNETTE_INNER_FAST = 0.16;

/**
 * Speed-line gain, at rest and flat out on a boost. This is `lens.z`, and the
 * value it is multiplied into is display-referred (the streak term is added
 * after the tone map), so 0.42 is roughly +107 counts on the brightest tenth of
 * the angular comb, before the vignette prints it back down to ~+84 at the
 * corner. Below about 0.2 the effect is not visible at all on a golden-hour
 * sky, which is where it has been sitting.
 */
// 0.20 / 0.44 was measured against a bright golden-hour sky and nothing else.
// On the tunnel frame — the darkest place on the circuit, and one the AI takes
// on a mini-turbo, so the boost set is lit too — the same numbers put ~0.46 of
// display white over a scene sitting at ~0.08, and the capture came back as a
// starburst with no track in it. Halved, and the comb is now scaled by what is
// actually under it (see `sceneLit`).
//
// STREAK_BOOST is now the ceiling for *either* driver — a flat-out lap reaches
// it too. What still separates a boost is the second, whiter, faster comb the
// shader adds on top of it (gated on `rush.z`), not the gain of the first one.
//
// STREAK_REST IS ZERO NOW, and that is a correctness fix, not a taste call.
// §6 says speed lines exist "only above ~70% top speed"; a non-zero rest gain
// meant the term was always armed and the *gate* had to do all the work, so the
// two were multiplying each other down (0.095 of gain behind a part-open gate is
// nothing, however the gate is tuned) and the ramp between "calm" and "flat out"
// was a factor of 2.6 instead of a switch. With the rest at zero the gain IS the
// ramp: exactly zero below the bible's gate, and everything above it.
//
// The ceiling is up from 0.25 to 0.38, which is where 0.20/0.44 was aiming
// before the tunnel starburst forced it down. Three things make it safe now that
// were not all present then: the band lives in the outer third (0.55, 0.44 under
// boost), the comb is scaled by what is actually under it (`sceneLit`), and the
// sum is rolled off against the remaining display headroom (`head`). Worked
// through on the two ends — a boost under the tunnel exit (scene ~0.08 display)
// peaks at +43 counts, a boost against the golden sky (~0.85) at +51, and
// neither reaches the ceiling.
//
// 0.46, up from 0.38, and the extra is bought with measured headroom rather
// than borrowed against it. The r13 probe set captured the two ends this
// constant has to survive: a boost against the golden sky (mean display luma
// 119, 99.9th percentile 246, 0.000% of pixels with all three channels at 250+)
// and the tunnel stack (mean 74, 99.9th 245, again 0.000%). Neither end was
// anywhere near the ceiling the last round backed away from, because the two
// terms that made it safe — `sceneLit` and `head` — do their work regardless of
// the gain, and the second of them is explicitly a function of how much room is
// left. There is no configuration in which raising this constant clips a pixel
// that `head` was not already rolling off.
const STREAK_REST = 0.0;
const STREAK_BOOST = 0.46;

/**
 * IGNITION ONSET — a leading-edge detector on the boost kick.
 *
 * PostFX is handed two scalars and no boost flag, and until this round it could
 * only tell "boosting" from "fast" — not "a boost STARTED". Everything the lens
 * does under boost was therefore a step: it rose over the kick's own 0.05 s
 * attack and then held a constant value for two seconds. A step is a state. The
 * eye reads the onset of a cue and then stops attending to it, which is exactly
 * why five separate lens effects can all be present in a 131 km/h frame and the
 * frame can still be reported as feeling identical to a cruise.
 *
 * `punch` is the kick as it already was (0.05 s attack); `punchSlow` follows it
 * with a much longer constant. Their difference is a pulse that exists only
 * while the kick is RISING — one subtract and one lerp, no new contract with
 * the game, and it cannot fire on a sustained boost, on a flat-out lap or on a
 * drift, because none of those move the kick.
 */
const IGNITE_TAU = 0.42;
const IGNITE_GAIN = 2.1;

/**
 * The value `ctx.speedIntensity` takes at 100% of top speed with no boost.
 *
 * THIS IS THE NUMBER THE "no screen-space speed cue" BLOCKER TURNS ON, so it is
 * worth writing down what the signal actually is. `speedIntensity` is NOT a
 * fraction of top speed: Effects.updateSignals already applies the art bible's
 * "only above ~70% top speed" gate — `want = clamp((ratio - 0.70) / 0.42)` —
 * and then publishes `want * 0.42 + boost * 0.52`. So the number arriving here
 * is zero at 70% of top speed, 0.30 flat out, and 0.42 only with a slipstream
 * or a star on top; a boost adds a floor of 0.52 on top of all of that.
 *
 * Everything downstream was reading it as if it were a 0..1 speed fraction, and
 * that is the whole bug. Worked through on the reviewed frames: hud.png at
 * 101 km/h is ratio 0.935, so `want` = 0.56 and speedIntensity = 0.235. The
 * streak gain was `STREAK_REST + (STREAK_BOOST - STREAK_REST) * kick` with kick
 * = 0 (no boost), i.e. 0.095, times a gate of smoothstep(0.235, 0.08, 0.50) =
 * 0.31 — a final gain of 0.029, which is under three counts of display white on
 * the brightest tenth of the comb. The radial rush was 0.0065 * 0.235^2 =
 * 0.00036, which is 0.4 px of travel at the frame corner at 1080p. Both are
 * "nothing", exactly as reviewed, and closeup.png at 55 km/h (ratio 0.51, below
 * the 70% gate) is a true zero — so the two frames are identical by
 * construction.
 *
 * The review's suggested fix, `smoothstep(0.70, 1.0, speed)`, would have made
 * that permanent: `speed` cannot exceed 0.42, so that expression is identically
 * zero at every speed the game can produce. The 70% gate is upstream. What the
 * lens needs is that gated ramp renormalised, which is what this constant is
 * for: `fast = min(speed / SPEED_FLATOUT, 1)` is 0 at ~70% of top speed, 0.44
 * at 90 km/h, 0.78 at 101 km/h and 1.0 flat out.
 */
const SPEED_FLATOUT = 0.30;

/**
 * The boost kick, 0..1, recovered from `ctx.fovPunch`.
 *
 * PostFX gets two numbers from the game and no direct knowledge of boost state,
 * and this is the one that carries it: Effects publishes ~8.5 deg of punch for
 * a boost against at most 3.3 for a tier-3 drift and 3.2 for a flat-out lap, so
 * a threshold between them separates "boosting" from "merely fast" cleanly and
 * arrives already eased.
 */
// Moved up with the sustained-speed FOV term in Effects.updateSignals, which
// went from 3.2 to 4.2 degrees flat out so the lens itself carries some of the
// speed read. The separation contract is unchanged: the most a NON-boost frame
// can publish is 4.2 (flat out, or flat out on a tier-3 drift — the drift branch
// takes a max, not a sum), and a boost publishes 8.5 before any speed term is
// added on top, so KICK_LO sits in the 0.7-degree gap and a boost taken from a
// standstill still reaches a full kick of 1.0 at KICK_HI.
const KICK_LO = 4.9;
const KICK_HI = 8.5;

/**
 * Radius around the player kart's centre of mass, in metres, inside which the
 * reprojection blur is switched off completely, and the radius at which it is
 * fully back. See the hero hold-out block in GRADE_FRAGMENT for the sizing.
 *
 * These are world units, so they do not care how long the chase arm is, which
 * is the entire reason this replaced a depth band.
 */
const SUBJECT_HOLD = 2.05;
const SUBJECT_FADE = 3.40;

export interface PostFXOptions {
  /** true when we detected a software rasteriser (headless capture / CI) */
  software: boolean;
  /**
   * True when the composer's buffer is 8-bit rather than half-float, because
   * this GPU could not complete an RGBA16F attachment.
   *
   * It changes exactly one thing, and it has to. Every threshold in this file
   * is authored against SCENE-LINEAR HDR — the bloom gate sits at 1.55, i.e.
   * above sunlit diffuse white, on the assumption that there are values above 1
   * to select. An 8-bit buffer clamps at 1.0 before the bloom pass ever runs,
   * so a threshold of 1.55 selects the empty set and the tier loses its bloom
   * entirely and silently. Below, the gate moves into the range the buffer can
   * actually represent.
   */
  ldr?: boolean;
}

/**
 * Builds and drives the effect chain. One instance lives for the lifetime of
 * the pipeline; `build()` may be called repeatedly as quality settings change.
 */
export class PostFX {
  grade: GradeEffect | null = null;
  bloom: BloomEffect | null = null;
  dof: DepthOfFieldEffect | null = null;
  smaa: SMAAEffect | null = null;
  /** N8AOPostPass — untyped, the package has no declarations. */
  ao: any = null;

  private passes: Pass[] = [];
  private gradePass: EffectPass | null = null;
  private speed = 0;
  /** eased boost kick, 0..1, derived from ctx.fovPunch */
  private punch = 0;
  /** slow follower of `punch`; the difference is the ignition onset pulse */
  private punchSlow = 0;
  private primed = false;
  /** last frame's view-projection, kept out of the uniform so we can rotate it */
  private readonly lastViewProj = new THREE.Matrix4();

  build(ctx: Ctx, composer: EffectComposer, opts: PostFXOptions): void {
    this.dispose();

    const s = ctx.settings;
    const q = s.quality;
    const high = q >= Quality.High;

    const renderPass = new RenderPass(ctx.scene, ctx.camera);
    this.add(composer, renderPass);

    // --- ambient occlusion -------------------------------------------------
    if (s.ssao) {
      const ao = new N8AOPostPass(ctx.scene, ctx.camera, ctx.width, ctx.height);
      const cfg = ao.configuration;

      // MSAA lives on the COMPOSER's input buffer, and this pass is the reason
      // it has to.
      //
      // The note that used to sit here said N8AOPostPass re-renders the scene
      // into a `beautyRenderTarget` and composites onto that, so the samples
      // had to be moved off the composer and onto that target. Both halves of
      // that are wrong, and the second half threw:
      //
      //   - `beautyRenderTarget` is a field of `N8AOPass`, the raw three.js
      //     pass. `N8AOPostPass` — the postprocessing-compatible one we build
      //     here — has no such field. It takes the composer's `inputBuffer` as
      //     `sceneDiffuse` and composites the occlusion onto that, which is
      //     exactly what a well-behaved post pass should do.
      //   - So `ao.beautyRenderTarget.samples = ...` was a TypeError on
      //     undefined. `PostFX.build` is called inside a try/catch in
      //     RenderPipeline.rebuild, which caught it, tore the composer down and
      //     set `usePost = false`.
      //
      // `msaaSamples()` returns non-zero at Quality.High and Ultra on every
      // device (4 on hardware, 2 on a software rasteriser), and `ssao` is on at
      // both. So this line threw on every High/Ultra boot and the game ran with
      // NO post chain at all: no AO, no DoF, no bloom, no grade, no tone map
      // beyond the renderer's own fallback, no SMAA. The whole of §2's colour
      // grade and §6's bloom were dead on the tier the art direction targets.
      //
      // Nothing needs to be assigned here. RenderPipeline keeps the samples on
      // the composer, where the surviving scene render actually happens.

      // A short world-space radius keeps the darkening where contact actually
      // happens (tyre/tarmac, kerb/road, planter/pavement). Large radii are
      // what produce the flat grey haze that gives cheap AO away.
      //
      // 1.5 m was still a room-scale radius on a vehicle-scale subject: a kart
      // sits 0.25 m off the deck and its contact patches are ~0.2 m across, so
      // with a 1.5 m hemisphere the tyre subtends a small enough solid angle at
      // the road beside it that the occlusion term never gets dark — which is
      // exactly the review note that "the road under the sill samples the same
      // value as road five metres away". 0.9 m still reaches the kerb/tarmac
      // joint and the wall bases, and it puts most of the sample budget inside
      // the contact band where §9.4 needs it.
      //
      // BACK UP TO 1.2 m. The move from 1.5 to 0.9 last round was reasoned from
      // the tyre contact patch and it overshot in the other direction, because
      // the AO buffer is HALF RESOLUTION (on every tier now — see `halfRes`
      // below, which used to make Ultra the exception) and the review is
      // judging objects at chase distance, not at 1 m. Work it out at the
      // distance the frames are actually shot from: with a 62 deg vertical FOV
      // at 1920x1080, a 0.9 m world radius around a kart 25 m away subtends
      // ~58 px full-res, i.e. 29 px on the half-res buffer — but the occluded
      // BAND, the part that is actually dark, is only as wide as the gap under
      // the chassis projects, a handful of half-res pixels, and the poisson
      // denoise then averages across 4 of them. Measured on r1/grid.png, where
      // eight karts sit on flat tarmac with the sun head-on: the road
      // immediately in front of the lead kart reads mean luma 25.3 against 29.8
      // and 37.6 for the same tarmac 3 m to either side — a 23% delta that is
      // inside the frame's own left-to-right falloff. There is effectively no
      // footprint under any of the eight karts, which is the §9.4 blocker.
      //
      // 1.2 m is what the review asked for and it is the right number for two
      // separate reasons: it widens the contact band past the denoise kernel so
      // it survives to the screen, and it is the smallest radius that reaches
      // across anything at ENVIRONMENT scale — the kerb-to-tarmac step, the
      // wall bases, the concavities in the cliff face — which is the other half
      // of the note ("large surfaces receive a single constant multiplier").
      // distanceFalloff is unchanged at 1.0, so the depth rejection band scales
      // with it to 0.24 m and still sits under the kart's 0.25 m ride height.
      cfg.aoRadius = 1.2;
      // Left at 1.0 deliberately while the radius came down. N8AO folds the two
      // together — the depth rejection band is radius * distanceFalloff * 0.2,
      // so this is already tightening from 0.30 m to 0.18 m on its own. Pulling
      // the falloff down as well would take the band under the kart's 0.25 m
      // ride height and throw away the chassis-footprint darkening, which is
      // half of what §9.4 is asking for.
      cfg.distanceFalloff = 1.0;
      // N8AO's `intensity` is the exponent on the visibility term, so it is the
      // only knob that changes how *dark* contact gets. Measured against this
      // stack on a kart-sized box on tarmac: at 3.0 the road under the chassis
      // came out 29% below open road and the tyre contact strip 8% below, which
      // is inside the noise of a frame this bright — the art directors read it
      // as "no AO at all" and they were right to. 5.0 doubles both (44% / 19%),
      // which is the shipped-kart-racer look, and it costs nothing: the sample
      // count is unchanged.
      cfg.intensity = q >= Quality.Ultra ? 5.4 : 5.0;
      cfg.aoSamples = high ? 16 : 8;
      cfg.denoiseSamples = 8;
      // A 6-texel poisson denoise at half res is a 12-pixel blur, which is
      // wider than the contact band it is supposed to be cleaning up and turns
      // a tyre patch into a smudge. Tighter still now that the radius came
      // down — a 0.9 m radius produces a contact band only a few pixels wide at
      // chase distance, and a 3-texel half-res denoise is 6 px, i.e. wider than
      // the signal. One iteration at High; the second buys smoothness the tyre
      // contact does not want.
      cfg.denoiseRadius = 2;
      // ONE ITERATION EVERYWHERE, INCLUDING ULTRA.
      //
      // The paragraph above already argues that the second pass "buys
      // smoothness the tyre contact does not want", and it only ever ran on
      // Ultra, which was also the only tier running AO at full resolution. Now
      // that Ultra is on the half-res buffer with everything else (see below),
      // a second 2-texel poisson pass on a half-res buffer is a 8 px blur on
      // the contact band this radius was widened to protect — it would undo
      // §9.4 rather than polish it. It is also the cheaper half of a pair of
      // changes: the AO pass is the most expensive thing in the chain.
      cfg.denoiseIterations = 1;
      // Occlusion tinted toward the sky fill instead of black — the art bible
      // forbids pure-black shadow, and cool crevices sit right next to the
      // warm key light.
      cfg.color = new THREE.Color(0x101c2a);
      cfg.colorMultiply = true;
      cfg.screenSpaceRadius = false;
      cfg.depthAwareUpsampling = true;
      // HALF RESOLUTION ON EVERY TIER. This used to read `q < Quality.Ultra`,
      // which made Ultra the only tier in the game running ambient occlusion at
      // full drawing-buffer resolution — and Ultra is handed out to every Apple
      // M, RTX, Radeon RX and Arc machine, i.e. to exactly the desktops the
      // 60 fps target is written for.
      //
      // It was the single most expensive thing in the frame. Measured with a
      // paired A/B inside one session (a fresh baseline block before every arm,
      // the simulation held still with `window.__freeze` so both arms render
      // the same frame, the adaptive scaler pinned), flipping Ultra to half res
      // took 5.1, 5.3 and 8.7 ms out of a 1080p-equivalent frame across three
      // runs on a box that was carrying other agents' harnesses at the time.
      // The pre-round audit, measured on a quiet box, puts the same change at
      // 2.24 -> 0.84 ms/Mpx, i.e. ~2.9 ms at 1080p. Either way it is the
      // largest single saving available in this chain.
      //
      // And it costs nothing that was ever signed off: half res is what
      // Quality.High has always shipped, it is the buffer the whole radius /
      // falloff / denoise argument above was reasoned and measured against, and
      // `depthAwareUpsampling` (on, just above) is what keeps the occlusion
      // pinned to the depth discontinuities on the way back up. Ultra still
      // differs from High where it can be seen — 16 aoSamples against 8, and a
      // stronger `intensity` — it just stops paying four times the fill rate
      // for a buffer nobody was judging at full resolution.
      cfg.halfRes = true;
      cfg.accumulate = false;
      cfg.neuralDenoise = false;
      // The auto-detect walks the entire scene graph every single frame.
      ao.autoDetectTransparency = false;
      cfg.transparencyAware = false;
      this.ao = ao;
      this.add(composer, ao);
    }

    // --- depth of field ----------------------------------------------------
    // Built here, ADDED BELOW. DoF and bloom go into one EffectPass together;
    // see the note on `merged` after the bloom block.
    let dofEffect: DepthOfFieldEffect | null = null;
    if (s.dof) {
      // Garnish only: a long focus range means the road, the kerbs and the
      // next two corners stay razor sharp and only the bay and the headland
      // soften. bokehScale stays small for the same reason.
      const dof = new ScaledDepthOfFieldEffect(ctx.camera, {
        focusDistance: 9,
        focusRange: 60,
        bokehScale: 1.25,
        // Applied ON TOP of the halved base in ScaledDepthOfFieldEffect, so the
        // blur tier lands at a quarter of the drawing buffer. The near-field
        // half of that tier is very nearly a no-op in this game anyway: with
        // focusDistance 9 and focusRange 60, a subject 1 m from the lens has a
        // near CoC of smoothstep(0, 60, 8) = 0.05.
        resolutionScale: 0.5,
      });
      dof.target = _dofTarget.set(0, 0, 0);
      this.dof = dof;
      dofEffect = dof;
    }

    // --- bloom -------------------------------------------------------------
    if (s.bloom) {
      // Threshold sits above diffuse white on purpose: only the sun on chrome,
      // the water sparkle, drift sparks and boost flame clear it. A low
      // threshold is what turns a frame milky.
      //
      // It is measured on the SCENE-LINEAR buffer, not on display values, and
      // that is where 0.9 went wrong: with exposure 1.05 through ACES a linear
      // 0.9 lands around 0.6 on screen, i.e. below every lit road surface, wall
      // and kerb in the game. The whole frame was above threshold, so bloom
      // welded the sun-facing tarmac into the sky and ate the vanishing point,
      // the roof ridges and the boost chevrons.
      //
      // 2.0 was NOT the reason r1 has no visible bloom — 2.0 linear displayed
      // at about 202 on the old tone curve, so the sun disc, the road sheen and
      // the sky around the sun all cleared it comfortably; the shoulder then
      // crushed the bloom and its source into the same 232-250 band, which is
      // what made it read as a milky smear instead of a glow. Dropping the
      // threshold to the 1.15-1.3 the review suggested would have re-created
      // the milky-frame regression above without touching the actual cause.
      //
      // With the shoulder fixed the threshold has to move a little anyway: the
      // new curve puts linear 2.0 at display ~220, so holding the number would
      // quietly RAISE the gate. 1.55 lands back at ~205, i.e. the same "just
      // above sunlit diffuse white" population as before, now on a curve that
      // lets the result read.
      const bloom = new BloomEffect({
        // ADD, not SCREEN: the buffer is scene-linear HDR, and screen blending
        // values above 1 actually *darkens* them. Bloom is light being added.
        blendFunction: BlendFunction.ADD,
        // 0.78 on an 8-bit buffer, and that number is not a taste call. The
        // buffer clamps at 1.0, so a gate of 1.55 selects nothing whatsoever
        // and the fallback tier ships with the bloom silently missing — the
        // exact class of invisible degradation this round exists to remove.
        // 0.78 keeps the same population it was aiming at (just above sunlit
        // diffuse white) inside the range the buffer can represent.
        luminanceThreshold: opts.ldr === true ? 0.78 : 1.55,
        luminanceSmoothing: 0.32,
        mipmapBlur: true,
        // Slightly hotter to pay back the pixels the higher threshold removed:
        // fewer sources, each allowed to glow harder.
        intensity: 0.88,
        // Wide and soft — a big mip chain with a high radius reads as a lens,
        // a small one reads as a glow filter.
        //
        // ONE MORE LEVEL OFF, and this is the "the entire midground dissolves
        // into a formless white haze" note. Measured on r1/boost.png: nothing
        // in that frame clips — 0.000% of pixels are above display luma 250 and
        // the whole shot ceilings at 245 — so it is NOT overexposure and
        // clamping the additive term (the review's suggestion) would have
        // treated a symptom that is not present. What the numbers show is a
        // VEIL: the horizon band at y300-400 runs 158 -> 218 -> 164 across the
        // frame with a local sd of 52, i.e. plenty of energy and no structure.
        // A seven-level chain at 1080p blurs the top mip over ~128 px, so the
        // sun sitting on the horizon smears a halo a fifth of the frame wide
        // over the road, the trackside props and the vanishing point — which is
        // exactly the region the reviewers say they cannot read. Six levels
        // halves that reach to ~64 px, keeps the disc glow §2 asks for, and
        // costs one fewer up/down mip pair per frame.
        radius: 0.72,
        levels: 6,
      });
      this.bloom = bloom;
    }

    // --- one pass for both -------------------------------------------------
    // TWO EFFECTS, ONE FULL-SCREEN ROUND TRIP. Each EffectPass is a read of the
    // composer's 1920x1080 half-float buffer and a write back to the other one
    // — 15.8 MB each way, 31.6 MB per pass per frame, 1.9 GB/s at 60 Hz — so a
    // pass that exists only because two effects were constructed separately is
    // pure bandwidth. Merged, the chain goes from 6 full-screen passes to 5 and
    // from 122 programs to 121.
    //
    // ONLY these two, and the rule is mechanical rather than a matter of taste:
    //
    //   - postprocessing refuses to merge two effects that both declare
    //     `EffectAttribute.CONVOLUTION` ("Convolution effects cannot be
    //     merged"). GradeEffect declares it (reprojection motion blur samples
    //     along a velocity vector) and so does SMAAEffect, so those two can
    //     never share a pass with each other.
    //   - GradeEffect cannot join THIS pass either, and the reason is the sort
    //     rather than the rule: `EffectPass` orders its effects by
    //     `b.attributes - a.attributes`, and CONVOLUTION|DEPTH is 3 against
    //     DoF's DEPTH 1 and Bloom's NONE 0. The grade would be reordered to
    //     FIRST, which would run the display transform before bloom added
    //     scene-linear HDR energy on top of an already display-referred image.
    //   - SMAA has to stay last on its own regardless: it is the final resolve,
    //     and it is deliberately placed after the grain and the aberration.
    //
    // DoF (1) then Bloom (0) is the order that same sort produces, which is the
    // order they were already in. One semantic change and it is small: bloom's
    // `update()` now prefilters the composer's input buffer instead of the
    // DoF's output, so it sources from the unblurred image. The bloom sources
    // in this game are the sun disc, chrome, water sparkle and boost flame, and
    // the far-field CoC that DoF applies to them is ~2.5 px going into a
    // six-level mip chain.
    const merged: Effect[] = [];
    if (dofEffect !== null) merged.push(dofEffect);
    if (this.bloom !== null) merged.push(this.bloom);
    if (merged.length > 0) {
      this.add(composer, new EffectPass(ctx.camera, ...merged));
    }

    // --- merged grade / lens ----------------------------------------------
    // Software rasterisers pay for every tap, and a headless capture is a
    // still frame anyway — one tap keeps the aberration and drops the blur.
    // (The shader honours that literally now: below two taps it zeroes the
    // velocity instead of stochastically displacing the single tap.)
    const samples = !s.motionBlur || opts.software ? 1 : (high ? 6 : 4);
    const grade = new GradeEffect({
      samples,
      exposure: 1.05,
      contrast: 0.18,
      saturation: 1.12,
      vignette: 0.22,
      // Trimmed with the shadow rolloff added in the shader — the grain was
      // never the coloured speckle the review saw, but at 0.012 flat it was
      // still +/-1.8 counts of white noise sitting on top of the darkest eighth
      // of the frame, which is where it is most visible and least wanted.
      grain: 0.009,
    });
    this.grade = grade;
    this.gradePass = new EffectPass(ctx.camera, grade);
    this.add(composer, this.gradePass);

    // --- resolve -----------------------------------------------------------
    const smaa = new SMAAEffect({
      // Low tier runs without MSAA, so SMAA has to carry the whole edge budget.
      preset: high ? SMAAPreset.ULTRA : SMAAPreset.HIGH,
      // LUMA, not COLOR. COLOR edge detection compares all three channels, so
      // on a frame that carries any chroma noise at all it fires on the noise
      // and spends its edge budget smearing speckle instead of finding the kerb
      // stripe underneath — and it runs last, after grain and aberration, so it
      // sees the worst version of the image. LUMA is also the cheaper of the
      // two and is what SMAA was designed around; with real MSAA restored
      // underneath it there is nothing left for COLOR to buy.
      edgeDetectionMode: EdgeDetectionMode.LUMA,
    });
    this.smaa = smaa;
    const smaaPass = new EffectPass(ctx.camera, smaa);
    // Ordered dither on the final 8-bit write; without it the sky gradient
    // bands, which section 9 of the art bible calls out by name.
    smaaPass.dithering = true;
    this.add(composer, smaaPass);

    this.primed = false;
  }

  /**
   * Per-frame uniform sync. Called immediately before `composer.render()`, so
   * the camera has already been placed by ChaseCamera.lateUpdate.
   */
  sync(ctx: Ctx, dt: number): void {
    const grade = this.grade;
    if (grade === null) return;

    const camera = ctx.camera;

    // The renderer will do this again in a moment, but we need this frame's
    // view matrix *now* — otherwise the velocity we compute lags the depth
    // buffer we compute it against by a frame.
    camera.updateMatrixWorld();

    // Reprojection matrices. On the first frame after a (re)build there is no
    // history, so seed it with the current transform and blur nothing.
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.primed) {
      this.lastViewProj.copy(_viewProj);
      this.primed = true;
    }
    grade.invViewProj.copy(_viewProj).invert();
    grade.prevViewProj.copy(this.lastViewProj);
    this.lastViewProj.copy(_viewProj);

    // Ease the speed signal so a boost pad does not snap the lens.
    const target = THREE.MathUtils.clamp(ctx.speedIntensity, 0, 1);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / 0.11));
    const speed = this.speed;

    // Boost kick. Punches in fast (0.05 s) and releases slowly (0.28 s), which
    // is the same asymmetry the FOV itself uses — the lens should not snap back
    // the instant the boost expires.
    const kickTarget = THREE.MathUtils.clamp(
      (ctx.fovPunch - KICK_LO) / (KICK_HI - KICK_LO), 0, 1);
    this.punch += (kickTarget - this.punch) *
      (1 - Math.exp(-dt / (kickTarget > this.punch ? 0.05 : 0.28)));
    const kick = this.punch;

    // Leading-edge detector on the kick. See IGNITE_TAU. Clamped at both ends:
    // it is only ever positive while the kick is rising, and it is capped at 1
    // so a pathological frame delta cannot hand the lens a number none of the
    // terms below were tuned against.
    this.punchSlow += (kick - this.punchSlow) * (1 - Math.exp(-dt / IGNITE_TAU));
    const ignite = THREE.MathUtils.clamp((kick - this.punchSlow) * IGNITE_GAIN, 0, 1);

    // The sustained-speed driver. See SPEED_FLATOUT: zero at ~70% of top speed,
    // 0.44 at 90 km/h, 0.78 at 101 km/h, 1.0 flat out — and it does not need a
    // boost to get there, which is the entire point of this round's fix.
    const fast = Math.min(speed / SPEED_FLATOUT, 1);
    // Whichever of "genuinely fast" and "boosting" is stronger drives the lens.
    // A boost taken at half pace still fringes and still streaks; a flat-out lap
    // with no boost now does too.
    const drive = Math.max(fast, kick);

    // Shutter is normalised against a 60 Hz frame so the blur length is a
    // function of how fast the world moves, not of how fast we happen to run —
    // and it now also lengthens with speed, so a 101 km/h pass integrates a
    // longer camera streak than a 55 km/h cruise at the same frame rate. The
    // subject is masked out of the velocity in the shader, so this only ever
    // smears the world around the kart, never the kart.
    const shutter = ctx.settings.motionBlur
      ? (0.50 + 0.34 * fast) * THREE.MathUtils.clamp(1 / 60 / Math.max(dt, 1e-4), 0.2, 2)
      : 0;

    const lens = grade.lens;
    // The ignition pulse rides on top of `drive` in every lens term, and it is
    // deliberately allowed to push each of them past its own sustained ceiling
    // for a fraction of a second — that overshoot IS the event. The aberration
    // is still capped in TEXELS inside the shader (CA_MAX_TEXELS), so the
    // fringe cannot decorrelate the channels however hard this pushes.
    lens.x = CA_REST + (CA_BOOST - CA_REST) * Math.min(1.35, drive + ignite * 0.55);
    lens.z = STREAK_REST + (STREAK_BOOST - STREAK_REST) * Math.min(1.30, drive + ignite * 0.45);
    lens.w = shutter;

    // Vignette closes in with the same signal. Nothing here moves at all below
    // the bible's 70%-of-top gate, so a cruising frame prints down exactly as
    // the authored 0.22 / 0.30 it always did.
    const vig = grade.vig;
    // The ignition squeeze: the frame closes in hard for a fraction of a second
    // and opens back out. It is the cheapest cue in the whole stack, it costs
    // one multiply, and it is the one that still reads at thumbnail size.
    vig.x = grade.grade.w + VIGNETTE_SPEED * drive + 0.07 * ignite;
    vig.y = VIGNETTE_INNER_REST
      + (VIGNETTE_INNER_FAST - VIGNETTE_INNER_REST) * Math.min(1, drive + ignite * 0.6);

    const rush = grade.rush;
    // Radial zoom-blur, and the second half of the "no speed cue at speed" fix.
    //
    // The old expression was `0.0065 * speed^2 + 0.0105 * kick * speed`, i.e.
    // quadratic in a signal that never exceeds 0.42 and linear in a term that is
    // zero unless a boost is running. At 101 km/h that is 0.4 px of travel at
    // the frame corner. The sustained term below is quadratic in `fast`, which
    // is the same ramp renormalised, so it is still off during ordinary driving
    // (0 at 70% of top speed, 2.1 px at 90 km/h) and reaches 6.7 px at 101 km/h
    // and 11 px flat out — a readable edge smear that leaves the middle of the
    // frame, the racing line and the vanishing point untouched, because the term
    // is radial and therefore exactly zero at frame centre.
    //
    // It is combined with `max`, not `+`: the boost path keeps the value it was
    // tuned to (0.0145, ~17 px at the corner) rather than gaining the sustained
    // term on top of it. The reviewers are already unhappy about how much of
    // boost.png is smeared; this must not make that worse.
    //
    // RETUNED, and the numbers are the point. The old sustained term was
    // 0.0095 * fast^2 with a flat radial profile: at the 101 km/h frame the
    // reviewers were shown (fast = 0.80) that is 0.0061, i.e. 6.7 px of travel
    // at the extreme corner and 3.4 px halfway out — measurable and invisible.
    // Measured on the shipped frames, the radial-to-tangential gradient ratio in
    // the outer annulus is 0.952 at 55 km/h and 0.915 at 101: a four percent
    // difference, which is exactly the "visually indistinguishable" note.
    //
    // 0.0165 * fast^1.5 with the edge weighting in the shader puts the same
    // frame at 13 px at the corner and still under 2 px at mid-radius, and a
    // boost at 27 px. The exponent came down from 2 to 1.5 because the whole
    // range that matters is fast 0.5..1 (85% of top speed and up) and a square
    // spends most of that range doing nothing.
    rush.x = shutter > 0
      ? Math.max(0.0165 * Math.pow(fast, 1.5), 0.0125 * speed * speed + 0.0150 * kick * speed)
        + 0.0085 * ignite
      : 0;
    // The gate on the speed-line comb, now driven by the renormalised ramp: it
    // cracks open just above the art bible's ~70% of top speed and is fully open
    // by ~88%. A boost still pins it open on its own, because a boost IS the
    // event the lines exist to announce.
    // Gated on the SAME renormalised ramp the gain uses. Gating on the raw
    // signal while the gain used the ramp was how the two ended up multiplying
    // each other down to nothing: 0.216 of gain behind a gate of 0.31 is 0.067,
    // which is invisible however the gain is tuned.
    // Ramp tightened to (0, 0.42): `fast` is already zero at the bible's ~70% of
    // top speed, so this opens from nothing at 70% to fully open by ~82% and the
    // transition is a decision rather than a fade. `kick` pins it wide open on
    // its own — a boost IS the event the lines exist to announce.
    rush.y = Math.max(THREE.MathUtils.smoothstep(fast, 0.0, 0.42), kick, ignite);
    // The boost comb — the tighter, whiter, faster second population — is gated
    // on this. Letting the ignition pulse drive it above the sustained kick is
    // what makes the first few frames of a release visibly denser than the rest
    // of the boost, which is the difference between a lens that announces an
    // event and one that reports a state.
    rush.z = Math.min(1.25, kick + ignite * 0.55);

    // Keep `time` in a range where fract() still has bits left for the grain.
    const pass = this.gradePass as any;
    if (pass !== null && pass.fullscreenMaterial.time > 600) pass.fullscreenMaterial.time = 0;

    if (this.bloom !== null) {
      // A touch more glow under boost; the flame and the sparks are the payload.
      //
      // Trimmed from 0.16/0.26. The reviewed boost frame runs kick ~1 and
      // speed 0.89, so the old expression put the bloom at 1.29 — a 47% lift
      // over the base — on the one frame in the set whose midground is already
      // gone. The flame and the sparks are the payload and they clear the
      // threshold on their own; the extra gain was mostly being spent on the
      // sun sitting in the middle of that midground. 1.08 at full boost keeps
      // the punch and stops the veil growing with it.
      // The ignition term is TRANSIENT and the sustained terms are untouched,
      // deliberately: the "midground dissolves into a formless white haze" note
      // is about a veil that is present for the whole of a boost, and a 0.18
      // lift that exists for a third of a second cannot build one. It buys the
      // release frame a halo on the flame and the shockwave and then gets out
      // of the way.
      this.bloom.intensity = 0.88 + 0.06 * fast + 0.14 * kick + 0.18 * ignite;
    }

    const player = ctx.race?.player;

    // Park the hold-out sphere on the hero kart. Nothing here is derived from
    // the camera: the arm length, the rig's pitch and the camera mode all move
    // the kart around the frame and around the depth range, and none of them
    // move it relative to itself.
    const hold = grade.hold;
    if (player !== undefined && player !== null) {
      grade.subject.copy(player.position);
      hold.set(SUBJECT_HOLD, SUBJECT_FADE);
    } else {
      // No subject to protect — release the mask and let the whole frame blur.
      hold.set(-2, -1);
    }

    if (this.dof !== null) {
      if (player !== undefined && player !== null) {
        _dofTarget.copy(player.position);
        this.dof.target = _dofTarget;
      } else {
        this.dof.target = null;
      }
    }
  }

  dispose(): void {
    // Fault-tolerant per pass, and that matters in exactly one place: this is
    // called from the 'webglcontextlost' handler, against a context that is
    // already dead. A pass whose `dispose` reaches for a GL object that no
    // longer exists must not be allowed to abort the loop and leave the rest of
    // the chain — and the notice the player is waiting to see — half done.
    for (const pass of this.passes) {
      try { pass.dispose(); } catch (err) { console.warn('[postfx] pass dispose failed', err); }
    }
    this.passes.length = 0;
    this.grade = null;
    this.bloom = null;
    this.dof = null;
    this.smaa = null;
    this.ao = null;
    this.gradePass = null;
    // The eased lens state is history, and after a teardown there is none. Left
    // alone, a chain rebuilt while the player happened to be mid-boost came
    // back with a full-strength streak and aberration over a frame whose
    // reprojection history had just been reseeded to "no motion" — a lens that
    // says 120 km/h over an image that says parked.
    this.speed = 0;
    this.punch = 0;
    this.punchSlow = 0;
    this.primed = false;
  }

  /** Registers a pass with the composer and tracks it for disposal. */
  private add(composer: EffectComposer, pass: Pass): void {
    composer.addPass(pass);
    this.passes.push(pass);
  }
}
