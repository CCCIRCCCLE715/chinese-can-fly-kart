/**
 * ============================================================================
 *  Sky — atmosphere, key light, cascaded shadows, fog and the PBR environment.
 * ============================================================================
 *  Art bible §2 is the spec. Everything downstream keys off what this file
 *  decides, so a few of the choices here deserve stating up front:
 *
 *  · The dome is drawn as an infinite skybox (translation stripped, depth
 *    forced to the far plane), so it never needs to track the camera or be
 *    scaled against the far clip, and it never writes depth.
 *
 *  · The PBR environment is generated FROM that same shader, through a cube
 *    render and PMREM, once. Every metal and every clearcoat in the game is
 *    therefore reflecting the exact sky the player can see.
 *
 *  · Aerial perspective is a height-attenuated Beer fog, not FogExp2 — a
 *    ShaderChunk override installed from here replaces three's exp2 term. Three
 *    things matter: it layers instead of walling (exp2 is transparent up close
 *    then slams shut); density falls off with the eye's altitude, so the bay
 *    hazes and the cliff traverse looks out over it; and the factor is clamped
 *    short of 1, so every distant element keeps a slice of its own albedo and
 *    the backdrop stays a stack of silhouettes rather than one plate. The fog
 *    colour is the model's own horizon radiance with a highlight rolloff, NOT
 *    the raw superwhite the dome uses — feeding an above-display-white constant
 *    into fog is what pushed everything past 60 m over the ACES knee. And it is
 *    sampled PER VIEW AZIMUTH, not once: the sky is drawn from the real model,
 *    so aerial perspective that converges on an average of it can only meet it
 *    at a seam. That seam was the bay.
 *
 *  · The light rig is a real three-point rig, not a key plus a wash: a warm
 *    #ffd9a8 key at 8.0, a COOL #a8c8ff directional fill at 0.72 arriving from
 *    21.6° up on the anti-solar side, two token warm bounces, and a rim term
 *    driven by the key's own shadowed radiance and folded into the directional
 *    loop.
 *
 *    THE NUMBER THAT MATTERS IS THE RATIO ON THE ROAD, because that is the
 *    surface the game is played on and it is the surface a 14° key is worst at.
 *    Measured on a 0.18 grey card laid flat, linear irradiance, pre-tonemap:
 *    lit 1.768 against shadowed 0.405, i.e. 4.37:1 or 2.13 stops, with the lit
 *    patch at red:blue 1.58 (warm) and the shadowed one at 0.37 (cool) — a 4.3x
 *    hue split across the terminator. Round 1 measured 1.83:1 and 1.04 / 0.39,
 *    i.e. a one-stop shadow under a lit patch that was chromatically NEUTRAL.
 *
 *    Getting there needed four terms cut, not one. In descending order of what
 *    they were worth on a real tarmac pixel: the unshadowed rough-roughness
 *    specular IBL (ROUGH_ENV_SCALE — sixty percent of the pixel, and identical
 *    lit and shadowed), the cool fill's cosine advantage on horizontal surfaces
 *    (SKY_FILL_DIRECTION, re-aimed), the blue diffuse IBL (DIFFUSE_ENV_INTENSITY)
 *    and the ambient floor. Everything a fragment receives that does not depend
 *    on the sun's own cosine is a term competing with a quarter of the key.
 *
 *  · Enclosed geometry actually occludes the sky. A capsule volume fitted to the
 *    tunnel bore is baked into `<common>` and cuts the indirect terms, the
 *    shadowless fill lights and the fog inside it, because none of those three
 *    knew the rock was there and together they out-shone the tunnel's own exit.
 *
 *  · Environment intensity is 1.0, i.e. materials get the envMapIntensity they
 *    were authored with, so chrome and clearcoat actually mirror the sky. The
 *    DIFFUSE half of the IBL is scaled down separately (another chunk override)
 *    because that is the term that flattens key/fill, and it is the only reason
 *    the old code had to hold the whole environment down to 0.40.
 *
 *  · Shadows are a real two-slice CSM: ONE key light at full energy, TWO shadow
 *    maps, and the cascade chosen — and cross-faded — on the shadow TEST inside
 *    a patched `lights_fragment_begin`. The rig this replaced split the sun's
 *    energy between two independent lights, which cannot work: three lights
 *    every fragment from both, so outside the near frustum that light's share of
 *    the key leaks through anything only the far map is shadowing, and the
 *    cascade border becomes a straight-edged step in brightness. Shrinking the
 *    share shrinks the step; it never removes it. Now the only thing that
 *    changes across the border is penumbra width. Both frusta are texel-snapped
 *    in light space: without that, shadow edges crawl as the kart moves and the
 *    whole frame looks cheap.
 * ============================================================================
 */
import * as THREE from 'three';
import { Quality, type Ctx, type System } from '../types';
import {
  AtmosphereModel,
  GROUND_BOUNCE_COLOR,
  SKY_FILL_COLOR,
  SKY_FILL_DIRECTION,
  SKY_VERTEX_SHADER,
  SUN_DIRECTION,
  SUN_LIGHT_COLOR,
  buildSkyFragmentShader,
  hazeGlsl,
} from './Atmosphere';
import { TUNNEL_T0, TUNNEL_T1 } from '../world/TrackLayout';

// --- tuning ------------------------------------------------------------------

/**
 * Key intensity. Art bible §2 quotes ~4.2; this is 8.0, and the reason is worth
 * stating because it is the biggest single number in the file.
 *
 * §2's 4.2 is quoted against "physical-ish, tone mapped" with no statement of
 * what the rest of the rig is worth, and at 4.2 the rig this replaces measured
 * a lit:shadowed ratio of 1.83:1 on flat tarmac — a 0.87-stop shadow, i.e. one
 * ambient wash with a slightly brighter half. Golden hour measures 4:1 to 6:1.
 * The sun arrives at 14°, so on the one surface the player looks at for the
 * whole race it lands with cos = 0.245 and everything that does NOT depend on
 * that cosine — the fill, the diffuse IBL, the probe, the floor — is competing
 * with a quarter of the key rather than with the key.
 *
 * Two ways out: raise the key, or drop the exposure and everything else with
 * it. The second makes §9's "no highlight anchor" note worse (nothing in
 * round 1 clipped to white; the frame sat in a narrow midtone band), so this
 * takes the first. Measured on a 0.18 grey card laid flat on the road, linear
 * irradiance, pre-tonemap:
 *
 *              round 1            now
 *   lit        1.264              1.768
 *   shadowed   0.692              0.405
 *   ratio      1.83:1 (0.87 st)   4.37:1 (2.13 st)
 *   lit R:B    1.04 (neutral)     1.58 (warm)
 *   shad R:B   0.39 (cool)        0.37 (cool)
 *
 * Note what moved: the SHADOW came down by more than the key went up. The lit
 * road reading neutral was never a fill problem, it was the blue diffuse IBL
 * and the ambient floor landing on the sunlit road at full strength — which is
 * also why §2's warm/cool axis never showed up on screen.
 *
 * DOWNSTREAM: `ctx.sun.intensity` is read by Water (glitter), Scenery (foliage
 * wrap) and Effects (particle lighting). All three clamp, and all three now sit
 * ON their clamp — see the report; they want re-scaling against 8.0.
 */
const SUN_INTENSITY = 13.5;
/*
 * ROUND 3, and the number above is the whole of this round's headline.
 *
 * Round 2's note (kept below in full) got the diagnosis right and stopped one
 * lever short of the target. Measured on the running build, linear irradiance
 * on a flat upward-facing surface, decomposed per term:
 *
 *                       round 2        round 3
 *   key                 1.445          2.438
 *   cool fill           0.151          0.119     (re-aimed, not scaled)
 *   SH probe            0.055          0.031
 *   diffuse IBL         0.106          0.043
 *   irradiance floor    0.076          0.056
 *   ------------------------------------------
 *   lit total           1.752          2.647
 *   shadowed total      0.388          0.249
 *   ratio               4.51:1         10.6:1
 *   STOPS               2.17           3.41
 *
 * Two things are worth saying about the shape of that.
 *
 * FIRST, both halves moved, and they had to. Halving the shadow alone gets to
 * 3.2 stops with the frame a stop darker than it already was; doubling the key
 * alone gets to 3.0 with the shadow still carrying a quarter of a stop of blue
 * wash that nothing occludes. The complaint is a RATIO, so the fix is a ratio.
 *
 * SECOND, there was room. The round-2 build clipped 0.000% of every frame to
 * white — the histogram never touched the top — which is the "no highlight
 * anchor" note stated numerically, and it means raising the key by 5.5 stops'
 * worth of nothing... by 0.75 of a stop costs no highlight that was there. It
 * spends headroom that was sitting unused. Exposure is Renderer.ts's (1.05,
 * ACES) and is deliberately NOT touched: the sky calibration solves against
 * whatever it finds, so the bible's #3f74c4 / #ffd0a0 land wherever it is set,
 * and moving it would have re-graded every frame instead of re-lighting it.
 *
 * WHAT THIS IS NOT: physical. At a 14° sun a physically correct horizontal
 * surface sees roughly 150 W/m² of direct against 90 of diffuse sky, i.e. about
 * 0.7 of a stop — which is precisely why every round of this project has
 * reported a flat road and why no amount of correctness was going to fix it.
 * The 3-4 stops asked for here is what a golden-hour photograph looks like on a
 * surface facing the light, applied to one that is not. It is a deliberate
 * stylisation and the rest of the rig is built to pay for it: the key is the
 * only term with a cosine, so everything else has to be small enough that a
 * quarter of the key still wins.
 *
 * DOWNSTREAM, RE-CHECKED: `ctx.sun.intensity` is read by Water (glitter,
 * `min(i, 6)`), Scenery (foliage wrap, `clamp(i * 0.14, 0.2, 1.1)`) and Effects
 * (particle lighting, `min(1.2, i * 0.26)`). All three were already saturated on
 * their clamps at 8.0, so all three are bit-identical at 13.5. The rim term in
 * `krSunRim` scales linearly with the key and IS affected — see RIM_STRENGTH.
 */
/**
 * `scene.environmentIntensity`, i.e. the multiplier on every material's
 * authored envMapIntensity. This is 1.0 and must stay 1.0: at 0.40 the kart's
 * chrome (authored 1.6) reflected the sky at 0.64 and the clearcoat (1.15) at
 * 0.46, which is why no metal in the game showed a horizon line, a sun blob or
 * a warm/cool split — they read as painted trim. The reason 0.40 looked
 * necessary is DIFFUSE_ENV_INTENSITY below; that is the term that was flooding
 * the scene, and it is now scaled on its own.
 */
const ENV_INTENSITY = 1.0;
/**
 * Diffuse-only scale on the IBL, applied by patching getIBLIrradiance. Specular
 * reflection and diffuse skylight are physically the same environment but they
 * play completely different roles here: the reflection is what sells metal, the
 * irradiance is pure non-directional fill and every unit of it eats the key/fill
 * separation. Measured on a matte grey sphere (lit pole / terminator / dark
 * pole, linear luminance) this lands at 1.00 / 0.113 / 0.117 against the ~1.00 /
 * 0.25 / 0.12 a golden-hour reference gives.
 *
 * Down from 0.16. This is the single most CHROMATIC unwanted term in the frame:
 * the diffuse environment on an up-facing normal integrates to (0.54, 0.85,
 * 2.34), i.e. R:B = 0.23 — a hard blue — and it lands on the sunlit road at
 * exactly the same strength as on the shadowed road, because it is not coupled
 * to anything. It, not the fill, is what made a lit tarmac patch measure R:B
 * 1.04 (neutral) under a #ffd9a8 key. Trimmed to 0.115 the lit road measures
 * 1.61 while the shadowed road stays at 0.39.
 *
 * ROUND 3: 0.115 -> 0.060, and this is a smaller cut than it looks. The
 * environment's lower hemisphere was as bright as its sky (see `groundColor` in
 * Atmosphere.ts), so a large share of what this term delivered to an UP-facing
 * normal was reflected ground arriving as pure DC — a number with no direction
 * in it at all. With the ground darkened, the same coefficient would already
 * have cost ~15%; the rest of the cut buys shadow separation. What survives,
 * 0.043 on flat road, is now genuinely the blue upper sky and now genuinely
 * varies with the normal, which is the only thing a diffuse IBL is for.
 */
const DIFFUSE_ENV_INTENSITY = 0.060;
/**
 * Roughness rolloff on the SPECULAR half of the IBL — see `envDiffuseChunk`.
 * Full strength below ROUGH_ENV_START so nothing §4 asks to mirror the sky is
 * touched (chrome 0.15, clearcoat 0.06, bodywork 0.28); ROUGH_ENV_SCALE at and
 * beyond ROUGH_ENV_END, which is where tarmac, rock, stucco and grass live.
 *
 * THIS, NOT THE FILL, WAS THE LARGEST UNSHADOWED TERM ON THE ROAD, and none of
 * the round-1 notes named it. Decomposing an actual road pixel:
 *
 *   #4a4a52 tarmac, roughness 0.72, chase camera, tone mapped
 *                              sunlit          in cast shadow
 *     diffuse (all four lights + floor + IBL irradiance)
 *                              (38, 35, 42)    (18, 23, 39)
 *     indirect specular        (~ 34, 43, 79 — IDENTICAL in both)
 *     total                    (55, 61, 98)    (37, 52, 96)
 *
 * i.e. roughly SIXTY PERCENT of what the player sees on the carriageway was a
 * split-sum reflection of the sky that no shadow map, no AO and no coupling
 * touches, and the measured lit:shadowed ratio on real tarmac was 1.26:1 —
 * 0.34 of a stop. Rebalancing the direct rig alone could not have fixed the
 * "cast shadows on the road are barely legible" note; it would have moved a
 * 40% slice of the pixel and left the other 60% flat.
 *
 * Two changes. ROUGH_ENV_END drops from 0.85 to 0.70 so that tarmac at 0.72 —
 * and rock, stucco, sand and grass above it — actually REACH the floor instead
 * of sitting 83% of the way down a ramp; at 0.85 the lowest multiplier tarmac
 * could ever see was 0.17 even with the scale at zero. And the scale itself
 * goes 0.42 -> 0.14.
 *
 * That is a physical correction, not a cheat. three's split-sum gathers the
 * whole hemisphere with no microfacet shadowing, no multiple-scattering energy
 * loss and no horizon clipping, and for a rough dielectric the surviving term
 * is dominated by `brdf.y * specularF90` with specularF90 = 1.0 — a
 * grazing-Fresnel term at full strength on a surface that physically scatters
 * its specular lobe over most of the sky. Asphalt does not mirror a quarter of
 * the sky's radiance.
 *
 * Everything §4 names as needing the environment is below ROUGH_ENV_START and
 * is untouched, and the 0.55 polish line on the racing groove still keeps 0.44
 * of full strength — so the worn line goes on reading brighter than the tarmac
 * around it, which is the whole point of it existing.
 *
 * After: tarmac 2.68:1 (1.42 stops), lit (57,51,62) against shadowed
 * (18,25,47) — a shadow you can see from across the room.
 *
 * ROUND 3 takes the far end from 0.14 to 0.09. The argument has not changed and
 * the arithmetic has: this is still the one term on a road pixel that a shadow
 * map cannot touch, so as the DIFFUSE ratio goes from 4.5:1 to 10.6:1 it becomes
 * a larger and larger share of what is left in shadow, and a fixed unshadowed
 * pedestal is exactly what caps a measured pixel ratio below the measured
 * irradiance ratio. 0.09 is still five times what the polish line at roughness
 * 0.55 keeps (0.46 of full strength), so the worn racing groove goes on reading
 * brighter and smoother than the tarmac either side of it, and every material
 * §4 names is below ROUGH_ENV_START and untouched.
 */
const ROUGH_ENV_START = 0.35;
const ROUGH_ENV_END = 0.70;
const ROUGH_ENV_SCALE = 0.09;
/** SH ambient on top of the env map — energy compensation for the bounces
 *  single-scattering IBL cannot see, and the only ambient that reaches
 *  materials which ignore environment maps. Deliberately small — and smaller
 *  still than it was (0.08), for the same reason as DIFFUSE_ENV_INTENSITY: it
 *  is omnidirectional, so every unit of it is a unit of shadow lift.
 *
 *  ROUND 3: 0.06 -> 0.034, on the same argument taken to the same place as
 *  DIFFUSE_ENV_INTENSITY. This is the most purely omnidirectional term in the
 *  file — it reaches every normal in the game whatever it faces and whatever is
 *  between it and the sky — so per unit it does more damage to key/fill
 *  separation than anything else here, and per unit it is the least missed:
 *  what it is compensating for is multiple scattering, and multiple scattering
 *  at golden hour is weak. */
const PROBE_INTENSITY = 0.034;
/**
 * How far the ambient probe's chromaticity is pulled toward the bible's
 * #a8c8ff. Up from 0.5: the probe is the omnidirectional part of the fill and
 * the one term guaranteed to reach a shaded surface whatever its normal, so if
 * it is warm the shadow side can never be cool no matter what else is done.
 */
const PROBE_FILL_TINT = 0.85;
/**
 * Warm bounce off the sand and stone, art bible §2. Lights undersides only.
 *
 * Down from 0.30, and this matters more than the number suggests. This light
 * casts no shadow and is aimed UP, so it reached the shaded side of every
 * object in the game with the same warm #c98f5a the key is already made of. On
 * a matte sphere it took the anti-solar pole to a red:blue of 2.1 — the shadow
 * side was measurably warmer than neutral while the key was warm too, which is
 * the definition of "illuminates but does not sculpt". It is now a hint under
 * the chassis and the kerbs, which is all a bounce should ever be.
 */
const BOUNCE_INTENSITY = 0.13;
/**
 * Cool directional sky fill, art bible §2 (`#a8c8ff`), from above and the
 * anti-solar side. This is the term the rig was missing.
 *
 * The environment map alone cannot do this job at golden hour. Its lower half
 * and its whole horizon band are warm — at 14° elevation the model's own low sky
 * runs #fef8f3 down-sun to #fbc89b behind, i.e. warm all the way round the
 * compass — so IBL irradiance on a side-facing normal is warm no matter which
 * way the object is turned. Only the HIGH sky is blue, and only a directional
 * term weighted to it can put that blue on the shaded side. One extra
 * DirectionalLight, no shadow map, no draw calls.
 *
 * DOWN FROM 1.05, AND RE-AIMED (see SKY_FILL_DIRECTION in Atmosphere.ts).
 *
 * The magnitude was wrong and the geometry was wrong, and the geometry is the
 * more interesting of the two. The fill casts no shadow, so on a shadowed road
 * it is the ENTIRE budget; at 35° elevation it landed on an up-facing normal
 * with cos = 0.58 against the key's 0.245, which is a 2.4x cosine advantage
 * handed to the one light that cannot be occluded, on the one surface that
 * needs to show occlusion. That is why eight karts at a 14° sun cast no
 * readable shadow: the shadow was there, it was just being refilled.
 *
 * Simply scaling it to ~0.30 (which restores the road ratio) also takes the
 * shaded flank of every kart from sRGB 57 to 33 and flattens the warm/cool axis
 * this light exists for — the anti-solar face is where the fill is SUPPOSED to
 * be doing the work. So the fill is dropped by 30% AND tipped from 35° to 21.6°
 * elevation, which cuts what it puts on the road by 36% while slightly
 * INCREASING what it puts on an anti-solar-facing wall. Measured, 0.18 card:
 *
 *                          round 1        now
 *   flat road, shadowed    sRGB 36/46/69  24/31/48
 *   anti-solar wall        sRGB 49/50/68  39/41/57   (R:B 0.62 -> 0.58)
 *
 * i.e. the term is removed from where it was erasing the shadow and kept where
 * it was sculpting.
 *
 * ROUND 3 LEAVES THIS NUMBER ALONE AND TIPS THE LIGHT AGAIN (2.6 -> 3.4 of
 * horizontal weight, 21.6° -> 16.9°; see SKY_FILL_DIRECTION). That is
 * deliberate. This is the largest single term left on a shadowed road — 39% of
 * that budget before this round and still 48% after it — but it is also the
 * ONLY term putting §2's blue on a shaded flank, and the two facts point in
 * opposite directions the moment you reach for the intensity. Tipping resolves
 * them: -21% on the carriageway, +3% on an anti-solar wall, one number.
 *
 * Flat road, shadowed, this light alone: 0.151 -> 0.119. Anti-solar wall:
 * 0.382 -> 0.392.
 */
const SKY_FILL_INTENSITY = 0.72;
/**
 * How much of the cool fill survives on a surface the KEY is already reaching.
 *
 * THIS IS THE FIX FOR "THE KEY DOES NOT REACH THE RACING SURFACE".
 *
 * The fill was tuned on a sphere, where key and fill meet a given normal on
 * comparable terms. The surface the player stares at for the whole race is not
 * a sphere, it is horizontal, and there the geometry is wildly lopsided: the
 * key arrives at 14° so it lands with cos = 0.24, while the fill arrives at 35°
 * and lands with cos = 0.57. On flat road the fill therefore gets 2.4x the
 * cosine advantage, and #a8c8ff at 1.05 against #ffd9a8 at 4.2 works out at
 * R 1.02 / B 0.40 from the key against R 0.20 / B 0.51 from the fill. Multiply
 * by tarmac's own cool #4a4a52 and the blue channel wins. Every horizontal
 * surface in the game was mathematically guaranteed to read cool at golden
 * hour, and no amount of pushing the key could change it, because pushing the
 * key pushes both.
 *
 * So the fill is coupled to the key instead of competing with it: a fragment
 * the sun is actually landing on keeps only this fraction of the cool term, and
 * a fragment in shadow — or turned away from the sun — gets all of it. That is
 * both what the reference does (a sunlit road is lit by the sun; a shadowed one
 * is lit by the sky) and what §2 asks for in words: warm key, cool fill, teal
 * shadows, and an actual separation between them. On flat tarmac the incident
 * R:B goes from 1.02 (neutral, measured off the round-1 frames) to 1.76 in sun
 * and 0.39 in shade.
 *
 * 0.34 rather than 0: a sunlit road still sees most of the sky hemisphere, and
 * zeroing it makes lit ground read as if it were lit in a vacuum.
 */
const FILL_KEY_COUPLING = 0.34;
/**
 * Same coupling for the two warm bounce terms. Much weaker, because a bounce
 * is warm and does not fight the key for hue — its only job is to keep shaded
 * mass off the floor, and the sunlit side does not need help.
 */
const BOUNCE_KEY_COUPLING = 0.55;
/**
 * How sharply "the key is reaching this fragment" saturates with N·L. Raw N·L
 * is 0.24 on flat ground at a 14° sun, so keying the coupling off it directly
 * would decouple almost nothing on the one surface this exists for. 1/0.30
 * takes flat road to 0.81 and anything facing the sun's azimuth to 1.0, while
 * a surface genuinely turned away still gets the full cool fill.
 */
const KEY_LIT_SHAPE = 1 / 0.30;
/**
 * Lateral warm bounce, art bible §2's `#c98f5a` again but arriving nearly
 * HORIZONTALLY from the sun's own azimuth.
 *
 * The existing bounce points straight up from below, which is structurally
 * incapable of carrying the transfer that actually matters in this course: a
 * sunlit facade into the shaded street beside it, a sunlit cliff into the road
 * under it, the sunlit dunes into the shade of a parasol. Those all travel
 * SIDEWAYS, and they all travel from the sun's side of the world toward the
 * shaded side, which is exactly one more shadowless directional light — no
 * draw calls, no shadow map, one BRDF evaluation. Coupled to the key like the
 * other fills, so it only ever shows up in shade, which is where bounce is the
 * only thing there is.
 *
 * Down from 0.34 with the rest of the fill budget: it arrives from just below
 * the horizontal, so it misses the road entirely (N·L < 0 on an up-facing
 * normal) but it does land on every shaded vertical, where it was the second
 * biggest reason the shaded side read as "a dimmer copy of the lit side"
 * rather than as a different colour of light.
 */
const LATERAL_BOUNCE_INTENSITY = 0.16;
/** Elevation of that bounce, negative = arriving slightly from below the
 *  horizontal, because the sunlit mass it stands in for is mostly ground. */
const LATERAL_BOUNCE_SLOPE = -0.14;

// --- the shadow floor --------------------------------------------------------
/**
 * Irradiance floor, art bible §3 (never pure `#000`) and §9.6 (no pure-black
 * shadows). Teal-leaning, because §2's grade wants shadows to lean teal and
 * because the deepest holes in this world — under a chassis, inside a wheel
 * arch, the back of a wall recess — are lit by the sky and by nothing else.
 *
 * Quoted as IRRADIANCE, i.e. what `RE_IndirectDiffuse` multiplies by albedo/PI.
 * On tarmac this lands a fragment that no directional term reaches at roughly
 * sRGB (5, 9, 11) — a teal near-black with hue in it rather than a hole.
 *
 * Kept deliberately low, and deliberately DESATURATED from the bible's #a8c8ff.
 * This is a term that reaches every normal, so every unit of it lands on the
 * road; a saturated blue floor big enough to be felt in the cavities would put
 * the carriageway straight back where FILL_KEY_COUPLING just took it from.
 *
 * Down from 0.34, and now MORE chromatic rather than less. Those two move
 * together: at 0.34 a saturated floor would have flooded the road, so it had to
 * be desaturated to #7d9aa8 and the price was that the deepest shadows in the
 * frame — which is where §2's teal is meant to live — came out grey. At 0.25
 * the term is small enough to carry real hue, and the measured lit:shadowed hue
 * split on tarmac goes from 4.10x to 4.28x for free.
 *
 * ROUND 3: 0.25 -> 0.185, and it is now the SECOND largest term on a shadowed
 * road (0.056 against the fill's 0.119) rather than the fourth. That promotion
 * is why it cannot follow the others down any further: with the probe and the
 * diffuse IBL both roughly halved, this is what is left holding a cavity off
 * pure black, and §3/§9.6 are not negotiable. On tarmac a fragment that no
 * directional term reaches still lands at sRGB (4, 7, 9) — a teal near-black
 * with hue in it. Verified in frame: the darkest 0.05% of a chase frame sits at
 * sRGB 9, and the near-black fraction is unchanged from round 2.
 */
const FLOOR_IRRADIANCE = 0.185;
const FLOOR_COLOR = 0x6f9cb4;
/**
 * The same floor inside an interior volume, warm sodium instead of teal. The
 * tunnel's premise is sodium strips; rock that falls off the bottom of the
 * lamps' falloff should read as unlit ROCK, not as a hole cut in the frame.
 * Brighter than the open-air floor because the interior cut below removes the
 * indirect terms that would otherwise be doing this job.
 *
 * Sized against the wall the critique sampled: rock at albedo ~0.12 that was
 * reading RGB(19,18,31) now lands at roughly (20,14,6) from this term ALONE,
 * i.e. before a single lamp, and it lands warm. A sunlit rock face is sRGB 136
 * for comparison, and the exit portal is 200+, so nothing here can invert the
 * tunnel against its own mouth again.
 */
const INTERIOR_FLOOR_IRRADIANCE = 0.70;
const INTERIOR_FLOOR_COLOR = 0xc07a3c;
/**
 * Warm penumbra band, art bible §2 ("long, soft, warm-tinted penumbra").
 * Added where the shadow test is partial, peaking at the half-shadow line and
 * vanishing at both ends, tinted with the key's own `#ffd9a8`. Small on
 * purpose: it is a lick of warmth across the terminator, not a rim light.
 *
 * Down from 0.22 even though the note asking for warmer shadow EDGES is still
 * open: this is quoted in absolute irradiance and the shadow budget it sits on
 * has just halved (0.69 -> 0.40 on flat road), so 0.22 would now be more than
 * half the shadow at the half-shadow line — a warm LINE, which is a different
 * artefact. 0.16 keeps the same visible warmth against the new floor.
 *
 * ROUND 3: 0.16 -> 0.105, for the third time for the same reason. The shadow
 * budget this sits on has gone 0.69 -> 0.40 -> 0.25 across three rounds, so an
 * absolute number that was a lick of warmth at the first is a stripe at the
 * third. 0.105 holds it at roughly 40% of the shadow at the half-shadow line,
 * which is where it has always visually been.
 */
const TERMINATOR_IRRADIANCE = 0.105;

// --- aerial perspective ------------------------------------------------------
// Replaces FogExp2. The old single exp2 term at density 0.0019 reached 44% at
// 400 m and 95% at 900 m, so the backdrop headlands were being built and then
// erased, and everything past ~60 m converged on one cream value. Split into a
// sea-level layer that thins with the eye's altitude plus a thin global term,
// the near-road contact haze is actually STRONGER than before (3% at 30 m
// against 0.3%) while the three backdrop layers land at 60% / 78% / 88% from
// the harbour instead of 95% / 100% / 100%, and at 45% / 64% / 76% from the
// cliff apex — three plates at descending contrast, which is the whole point.

/** Density of the low layer, per metre, at FOG_SEA_LEVEL. */
const FOG_SEA_DENSITY = 0.00085;
/** Scale height of that layer, metres. Density halves every ~42 m of altitude. */
const FOG_HEIGHT_SCALE = 60;
/** Altitude the sea-level density is quoted at. */
const FOG_SEA_LEVEL = 0;
/**
 * Height-independent term. Also published as `scene.fog.density`.
 *
 * Down from 0.00030: this is the term that fogs things the height falloff is
 * supposed to leave alone, and it was the reason a 300 m ridge and a 3 km
 * headland landed within a few percent of each other in the establishing shot.
 * The sea-level term carries the difference (and then some), so the bay hazes
 * harder than before while anything standing out of it separates.
 */
const FOG_GLOBAL_DENSITY = 0.00022;
/**
 * Distance at which aerial perspective starts. Beer fog from zero puts a couple
 * of percent of haze on the foreground, which is physically right and
 * pictorially wrong: it is the first thing to take the saturation off the
 * village pastels and the kerb red in the near field. 20 m costs nothing at
 * range (it is a translation, not a scale) and gives the foreground back.
 */
const FOG_START = 20;
/**
 * Hard ceiling on the fog factor. Without it the far plates all converge on the
 * haze colour and the horizon becomes one flat plate again. 0.92 rather than
 * 0.88: with the haze now sampled per view azimuth the thing distant geometry
 * converges on is the sky it is actually standing in front of, so convergence
 * is what we WANT at the horizon line — the residual is only there to keep the
 * backdrop layers from fusing, and 8% is enough for that.
 */
const FOG_MAX = 0.92;
/**
 * How much faster chroma converges on the haze than value does. See the note in
 * `fogChunks`. 1.85 puts a 600 m ridge at 78% desaturated against 42% lightened
 * and a 1.2 km one at 96% against 66%.
 */
const FOG_CHROMA_RATE = 1.85;
/** Ceiling on that, so the deepest plate keeps a whisper of its own hue rather
 *  than becoming a flat sky-coloured hole in the horizon. */
const FOG_CHROMA_MAX = 0.96;

/**
 * Cascade splits, art bible §2. Two maps: the near one carries 12/45, the far
 * one 160/500. The near extent is smaller than it used to be (65) because it no
 * longer has to hide a handoff — see `cascadeShadowChunk`.
 */
const NEAR_EXTENT = 55;
/**
 * Down from 220. The far cascade is 2048² on High, so its texel is `2 * extent /
 * 2048`: at 220 that is 21.5 cm, which is what put a visible staircase on the
 * building shadows across the cobble in the establishing shot. At 190 it is
 * 18.6 cm — an 14% finer step for no extra memory, no extra draw and no extra
 * bandwidth, which at 37 fps is the only kind of fix worth taking here.
 *
 * What it costs is range. The frustum is centred `extent * 0.45` ahead of the
 * player, so the covered band goes from -99..+319 m to -85..+275 m. Aerial
 * perspective is at 78% by 600 m and the border fade takes the last 4%, so
 * nothing pops; the establishing camera is the only view that ever looks past
 * it.
 */
const FAR_EXTENT = 190;
/** Single-cascade fallback (Medium and below): one map has to cover everything. */
const SOLO_EXTENT = 110;
const NEAR_DISTANCE = 300;
const FAR_DISTANCE = 900;
/**
 * Where the cross-fade from the near cascade to the far one begins, as a
 * fraction of the near map's normalised extent. 0.80 puts the band in the outer
 * 20% of the box — about 11 m of light-space travel — which is wide enough that
 * the change in penumbra width reads as distance rather than as an edge.
 */
const CASCADE_BLEND = 0.80;
/** The far cascade only redraws every N frames; it is 440 m across and nothing
 *  in it moves fast enough on screen for the staleness to read. */
const FAR_UPDATE_INTERVAL = 3;

// --- the shadow filter -------------------------------------------------------
// THE OTHER HALF OF "THE KEY DOES NOT REACH THE RACING SURFACE", and the reason
// the mid-ground carriageway was reading as a flat cool wash while the hills
// BEHIND it — outside every cascade, therefore never shadow-tested — were a hot
// saturated orange in the same frame.
//
// three r185's PCF is a five-tap Vogel disc scaled by `shadowRadius`, so at
// radius 3 it reaches three texels off the sample point. The depth error that
// introduces on a receiver is `lateral * tan(angle between the surface normal
// and the light)`, and at a 14° sun on flat ground that angle is 76°, i.e. a
// factor of FOUR:
//
//   near cascade  110 m / 3072 = 3.6 cm/texel, 3 texels = 10.7 cm  ->  0.43 m
//   far  cascade  440 m / 2048 = 21.5 cm/texel, 3 texels = 64 cm   ->  2.58 m
//
// against a constant bias of 0.032 m and 0.14 m respectively. The ground was
// self-shadowing everywhere, and because the taps are rotated per pixel it did
// not even look like acne — it looked like a uniform 40–70% dimming of the key
// over every horizontal surface inside 220 m. That is not something a bias
// number can fix: a constant bias big enough to cover 2.58 m detaches every
// contact shadow in the game by two and a half metres.
//
// The fix is the receiver-plane bias the geometry actually calls for. The light
// is orthographic and its basis is known on the CPU, so the gradient of stored
// depth with respect to shadow-map UV is exact and closed-form for any surface
// normal — see `krPcfGlsl`. With it, the bias is correct per tap at every slope,
// acne is structurally impossible, contact shadows stay attached, AND the
// kernel can finally be widened for the soft warm penumbra §2 asks for instead
// of being held down to hide the acne.
//
/**
 * Tap counts and disc radii, in texels, for the two cascades. Nine taps at 4
 * texels is the same sample DENSITY the stock five-at-three had, over twice the
 * area.
 *
 * THE FAR CASCADE IS WHERE THE STAIRCASE WAS. "The far cascade's texels are
 * 21 cm on their own and need no help" — which was the previous note here — is
 * true of the FILTER WIDTH and false of the sample count. Five taps quantise
 * the shadow term to six levels, and six levels laid across a hard diagonal at
 * 19 cm/texel is a visible staircase however wide the kernel is; the per-pixel
 * Vogel rotation dithers the tap POSITIONS but cannot invent intermediate
 * values that five taps do not span. Ten taps at 3.4 texels give eleven levels
 * over a 63 cm kernel and the edge dithers instead of stepping.
 *
 * Cost is seven extra `texture()` fetches on a comparison sampler, and only on
 * fragments OUTSIDE the near box — `krCascadeShadow` returns early for anything
 * inside it, which in a chase-camera frame is most of the carriageway.
 */
const NEAR_PCF_TAPS = 9;
const NEAR_PCF_RADIUS = 4.0;
const FAR_PCF_TAPS = 10;
const FAR_PCF_RADIUS = 3.4;
/** Residual constant bias, metres along the light ray. Absorbs depth-buffer
 *  quantisation and the normal-offset already applied in the vertex stage; it
 *  is NOT doing the slope work any more, so it can be small enough that contact
 *  shadows stay welded to their casters. */
const NEAR_CONST_BIAS = 0.035;
const FAR_CONST_BIAS = 0.22;
/**
 * Ceiling on the receiver-plane gradient, as a tangent. Past this the surface is
 * within ~7° of edge-on to the light, where the exact bias diverges and the
 * fragment is being killed by N·L anyway. Clamping keeps a silhouette texel from
 * punching a bright hole.
 */
const SLOPE_BIAS_TAN_MAX = 9.0;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The light's own orthographic basis, world space. Derived exactly the way
 * `Matrix4.lookAt` does it with up = +Y, which is what `DirectionalLightShadow`
 * uses, so `x`/`y` are the shadow map's u/v axes and `z` points at the sun.
 * Shared between the CPU texel snap and the GLSL receiver-plane bias — if these
 * two ever disagree the bias points the wrong way and the ground self-shadows
 * again, so there is exactly one of them.
 */
const SHADOW_BASIS = (() => {
  const z = SUN_DIRECTION.clone().normalize();
  const x = UP.clone().cross(z).normalize();
  const y = z.clone().cross(x).normalize();
  return { x, y, z };
})();

/** Everything one cascade needs, resolved before any shader is generated. */
interface CascadeSpec {
  intensity: number;
  extent: number;
  distance: number;
  mapSize: number;
  bias: number;
  normalBias: number;
  interval: number;
  /** three's own `shadow.radius`; only the non-PCF fallback path reads it. */
  radius: number;
  taps: number;
  pcfRadius: number;
  constBias: number;
}

/** Ortho depth range of a cascade, metres. Must match `makeCascade`. */
function shadowDepthRange(s: CascadeSpec): number {
  return s.distance + s.extent * 2 + 400 - 5;
}

/**
 * The cascade table. Resolved in `init` BEFORE the shader chunks are installed,
 * because the receiver-plane bias bakes each cascade's extent and depth range in
 * as literals — there is no uniform channel into `shadowmap_pars_fragment`.
 */
function cascadeSpecs(shadows: boolean, quality: Quality): CascadeSpec[] {
  const two = shadows && quality >= Quality.High;
  const near: CascadeSpec = {
    intensity: SUN_INTENSITY,
    extent: two ? NEAR_EXTENT : SOLO_EXTENT,
    distance: NEAR_DISTANCE,
    // ULTRA NO LONGER GETS A BIGGER MAP THAN HIGH, AND THE REST OF THIS FILE IS
    // THE ARGUMENT FOR IT.
    //
    // Every design number here is quoted against 3072 near / 2048 far. The
    // receiver-plane bias derivation above works the near texel out as
    // "110 m / 3072 = 3.6 cm"; `FAR_EXTENT` was moved from 220 to 190 precisely
    // because "the far cascade is 2048² on High, so its texel is 2 * extent /
    // 2048" and 190 is what puts that step at 18.6 cm. The Ultra bump to
    // 4096/3072 was bolted on afterwards and no filter constant was ever
    // re-derived for it, so it bought sharpness the kernel was not written to
    // exploit — 9 taps at 4 texels is a texel-relative kernel, so a finer map
    // makes the penumbra NARROWER, not better sampled.
    //
    // What it cost is the largest single item in the resolution-INDEPENDENT
    // half of the frame, which is the half no pixel optimisation can reach.
    // Measured, at 1920x1080 Ultra:
    //
    //   depth texels allocated   26.21 Mpx -> 13.63 Mpx   (-48%)
    //   rasterised per frame     19.93 Mpx -> 10.84 Mpx   (-46%)
    //     (near every frame + far amortised over FAR_UPDATE_INTERVAL)
    //   depth attachment memory  ~105 MB   -> ~54 MB
    //
    // 26.2 Mpx of depth against a 2.07 Mpx screen is 12.6 screens' worth of
    // rasterisation for the shadow term alone. 13.6 is 6.6, which is still
    // generous for two cascades.
    mapSize: quality >= Quality.High ? 3072 : 2048,
    bias: -0.00004,
    // Down from 0.022/0.05. The normal offset is a vertex-stage nudge that helps
    // at silhouettes and does almost nothing at a 14° sun (it converts to depth
    // through sin 14° = 0.24); with the receiver-plane bias carrying the slope
    // it is no longer being asked to do a job it is bad at, and shrinking it
    // pulls contact shadows back under the wheels.
    normalBias: 0.012,
    interval: 1,
    radius: 3.0,
    taps: NEAR_PCF_TAPS,
    pcfRadius: two ? NEAR_PCF_RADIUS : NEAR_PCF_RADIUS * 0.6,
    constBias: two ? NEAR_CONST_BIAS : NEAR_CONST_BIAS * 2.4,
  };
  if (!two) return [near];
  return [near, {
    intensity: 0,
    extent: FAR_EXTENT,
    distance: FAR_DISTANCE,
    // 2048 on every tier that has a far cascade at all — see the note on the
    // near map above. `FAR_EXTENT`'s own comment derives 190 from this number.
    mapSize: 2048,
    bias: -0.00008,
    normalBias: 0.06,
    interval: FAR_UPDATE_INTERVAL,
    radius: 3.0,
    taps: FAR_PCF_TAPS,
    pcfRadius: FAR_PCF_RADIUS,
    constBias: FAR_CONST_BIAS,
  }];
}

// --- global shader patches ---------------------------------------------------
// Three exposes no hook for either of these: fog is hard-wired to one exp/exp2
// term against a single colour, and environmentIntensity multiplies the diffuse
// and specular IBL together. Both are scene-wide lighting decisions that this
// file owns, so both are installed by overriding the ShaderChunks — once, before
// the first frame, therefore before any program is compiled. Originals are kept
// and restored on dispose so a second Sky in the same page is not a landmine.

const PATCHED_CHUNKS = [
  'common', 'fog_pars_fragment', 'fog_fragment', 'envmap_physical_pars_fragment',
  'shadowmap_pars_fragment', 'lights_pars_begin', 'lights_fragment_begin',
  'lights_fragment_maps',
] as const;

// --- interior volumes --------------------------------------------------------
// THE TUNNEL WAS BRIGHTER INSIDE THAN THE DAYLIGHT OUTSIDE IT.
//
// The bore casts shadows, so the KEY was correctly blocked. Everything else was
// not, and everything else adds up to more than the key: `scene.environment` is
// a full sky probe sampled with no notion of what is between the fragment and
// the sky, the SH ambient likewise, and the warm ground bounce is a
// DirectionalLight with `castShadow = false` — i.e. a light that passes through
// solid rock by construction. Aerial perspective piled a third of a stop of warm
// haze on top. A fragment 60 m inside a hillside was receiving the entire
// hemisphere of a golden-hour sky, and the mouths were the one part of frame
// where you could see the sky BEING that bright, so the exit read as the dark
// end of the shot. That is an inversion, and no amount of retuning the sodium
// lamps can fix it, because the problem is that the rock is not occluding
// anything.
//
// So: a real occlusion volume. A capsule chain fitted to the bore's own
// centreline, tapered in from each mouth, baked into `common` as literals and
// applied to the indirect terms, to the shadowless fill lights and to the fog.
// Inside the bore, indirect light is cut to a few percent and the only things
// left are the sodium strips, the daylight spilling in at the mouths, and the
// bore's own baked vertex-colour rhythm. The exit is then a genuinely bright
// hole, which is what it always should have been.

/**
 * Fraction of indirect diffuse removed at the centre of an interior volume.
 *
 * Down from 0.90. The cut is right in principle — the rock IS between the
 * fragment and the sky — but at 0.90 the residual was a tenth of a golden-hour
 * hemisphere with nothing else underneath it, and the lower walls fell to a
 * cool RGB(19,18,31): a near-black with no sodium in it at all, in a tunnel
 * whose entire premise is sodium. It is now 0.82, and the floor that catches
 * what is left is `INTERIOR_FLOOR_COLOR` — warm, so what the residual light in
 * there is made of is the lamps rather than a memory of the sky outside.
 */
const INTERIOR_IRRADIANCE_CUT = 0.82;
/** Same for the specular half of the IBL. Slightly gentler: a wet floor and the
 *  karts' chrome still need something to reflect, and what they should reflect
 *  in there is mostly the lamps, which N8AO and the point lights supply. */
const INTERIOR_RADIANCE_CUT = 0.86;
/** Fraction of the shadowless fill/bounce lights removed. Near-total: these are
 *  the lights that were literally shining through the hillside. */
const INTERIOR_FILL_CUT = 0.95;
/** Fraction of aerial perspective removed. Fog is skylight in suspension; there
 *  is no sky in there for it to be. */
const INTERIOR_FOG_CUT = 0.88;
/** Radial extent of the bore volume around the centreline: full effect inside
 *  the first, none beyond the second. The bore is ~13 m half-width by 8.6 m, so
 *  the far edge is ~16 m off the centreline; anything past that is solid rock. */
const INTERIOR_R_IN = 17;
const INTERIOR_R_OUT = 25;
/** How far in from each mouth the interior reaches full strength, metres. This
 *  is the daylight spill, and it is what makes the mouth read as a portal
 *  instead of as a line. */
const INTERIOR_MOUTH = 20;
/** Capsule segments fitted to the tunnel centreline. Ten over ~140 m is a 14 m
 *  chord, which tracks the bore's curvature to well inside a metre. */
const INTERIOR_SEGMENTS = 10;

/** One capsule of the interior chain, in world space. */
interface InteriorSegment {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** arc distance from the volume's start at A and at B */
  s0: number; s1: number;
}

interface InteriorVolume {
  segments: InteriorSegment[];
  /** bounding sphere, for the one-test early-out every other fragment takes */
  cx: number; cy: number; cz: number; radius: number;
  total: number;
}

// --- the sun rim -------------------------------------------------------------
/**
 * Strength of the rim, as a fraction of the key's own radiance added straight to
 * direct specular. A silhouette edge fully side-on to a 4.2 key picks up ~1.2
 * scene-linear, which lands just under display white through the shoulder — a
 * bright edge with colour still in it, not a white outline.
 *
 * ROUND 3: 0.34 -> 0.21, because this term multiplies `directLight.color`,
 * which three has already premultiplied by the light's intensity — so raising
 * the key from 8.0 to 13.5 scaled the rim by 1.69 on its own. Left alone it
 * would have put 2.9 scene-linear on a grazing silhouette, which is not a rim
 * with colour in it, it is a white outline. 0.21 lands the same edge at 1.8,
 * i.e. a little hotter than round 2 in absolute terms and considerably hotter
 * relative to a shadow that has halved — which is exactly the direction the
 * "no rim" note was pointing.
 */
const RIM_STRENGTH = 0.21;
/** How tightly the rim hugs the silhouette. 3.0 confines it to roughly the last
 *  20° of grazing angle; lower and it becomes a wash over the whole side. */
const RIM_POWER = 3.0;

/**
 * How far into a shadow map its own contribution starts fading out. This is a
 * thin safety strip now, not the cascade handoff — the handoff is a real
 * cross-fade of two shadow tests, see `cascadeShadowChunk`. It still earns its
 * place on the FAR cascade's outer edge (nothing catches that one) and on the
 * single-cascade path used below Quality.High.
 */
const SHADOW_BORDER_FADE = 0.96;

let _originalChunks: Record<string, string> | null = null;

function glslFloat(x: number): string {
  return Number.isFinite(x) ? x.toFixed(7) : '0.0';
}

/**
 * Height-attenuated Beer fog, replacing three's uniform exp2 term.
 *
 * Three things change and each one is load-bearing:
 *
 *  1. exp(-d) instead of exp(-d²). exp2 is nearly transparent up close and then
 *     slams shut — at 0.0019 it was 1.3% at 60 m and 95% at 900 m, which is a
 *     wall, not aerial perspective. Beer layers smoothly: 3% at 30 m (MORE
 *     contact haze than before), 33% at 400 m, 60% at 900 m, 78% at 1.5 km.
 *  2. Density falls off exponentially with the eye's altitude, so the harbour
 *     sits in haze and the cliff traverse looks out over it through half as
 *     much.
 *  3. The factor is clamped below 1, so nothing ever reaches the fog colour
 *     exactly and the backdrop stays a stack of plates.
 *
 *  4. The colour is sampled per VIEW AZIMUTH out of the same atmosphere model
 *     the dome is drawn from, instead of being one constant. See
 *     `AtmosphereModel.hazePoly`: at 14° elevation the horizon runs from a pale
 *     #f1e3d9 straight down-sun to a dusty #f7bf92 behind, an 1.8:1 luminance
 *     swing and a full hue swing, and a single averaged haze guarantees that in
 *     most camera directions the sea and the sky converge on two different
 *     colours — which is half of the hard bay/sky seam. (The other half was the
 *     dome only welding 34% of the way onto that haze; see
 *     `HORIZON_WELD_BAND`.) There is
 *     no uniform channel into this chunk (three merges `UniformsLib.fog` into
 *     `ShaderLib` at its own module-init time), so the fit is baked in as
 *     literals by `hazeGlsl`.
 *
 *  NOTE ON THE SHAPE OF THIS: the obvious implementation integrates the density
 *  profile between the eye and the FRAGMENT, and shades it with the direction
 *  eye→fragment. Both need the fragment's world position — one extra varying.
 *  That is not available: `src/world/Water.ts` hand-rolls its own `vFogDepth` in
 *  its vertex shader and then includes `<fog_pars_fragment>`/`<fog_fragment>`
 *  without three's `<fog_pars_vertex>`/`<fog_vertex>`, so a varying declared
 *  here would be undeclared in the sea's vertex stage and fail to link. What IS
 *  available in every fragment prefix three emits is `viewMatrix` and
 *  `cameraPosition`, and the camera's world-space forward falls straight out of
 *  the former. So:
 *
 *    · the ray's vertical slope is taken as the camera's forward slope, which
 *      makes the height integral EXACT for the fragment at the centre of the
 *      frame and correct in trend everywhere else — and note that `vFogDepth` is
 *      view-space depth, not ray length, so `fwd.y * vFogDepth` is exactly the
 *      world-Y that the known component of the view position contributes;
 *    · the haze is sampled in the camera's forward azimuth, so the horizon
 *      converges dead-on at frame centre and drifts by at most half the
 *      horizontal FOV at the edges — where the sky itself has drifted with it.
 *
 *  Per-fragment would be strictly better and costs one `varying vec3`; it needs
 *  Water.ts to stop hand-rolling `vFogDepth`. Flagged, not smuggled.
 */
function fogChunks(model: AtmosphereModel, stockPars: string): Record<string, string> {
  const K = {
    SEA: glslFloat(FOG_SEA_DENSITY),
    H: glslFloat(FOG_HEIGHT_SCALE),
    HINV: glslFloat(1 / FOG_HEIGHT_SCALE),
    Y0: glslFloat(FOG_SEA_LEVEL),
    MAX: glslFloat(FOG_MAX),
    START: glslFloat(FOG_START),
  };

  return {
    // The haze fit is a function, so it cannot live in `fog_fragment` — that
    // chunk is included inside main(). It goes here, at file scope, in the one
    // fog chunk every material with fog pulls in (Water.ts included: it rolls
    // its own vFogDepth in the vertex stage but takes this chunk verbatim).
    fog_pars_fragment: `${stockPars}
#ifdef USE_FOG
${hazeGlsl(model, 'krFogHaze')}
#endif
`,

    fog_fragment: /* glsl */`
#ifdef USE_FOG

	// world-space camera forward: minus the third ROW of the view rotation
	vec3 krFwd = -vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );

	float krD = max( vFogDepth - ${K.START}, 0.0 );

	// Exact mean of exp( -y / H ) between the ray's clamped start and end
	// altitudes, which is the analytic Beer integral of the height profile along
	// the ray. Both ends are clamped before the exponential, so a camera looking
	// down a long way cannot drive the density to infinity the way integrating
	// the raw profile below sea level would.
	float krSlope = clamp( krFwd.y, -0.7, 0.7 );
	float krY0 = clamp( cameraPosition.y - ${K.Y0}, -20.0, 600.0 );
	float krY1 = clamp( cameraPosition.y + krSlope * krD - ${K.Y0}, -20.0, 600.0 );
	float krE0 = exp( -krY0 * ${K.HINV} );
	float krE1 = exp( -krY1 * ${K.HINV} );
	float krDy = krY1 - krY0;
	float krAvg = abs( krDy ) < 0.5 ? 0.5 * ( krE0 + krE1 ) : ( krE0 - krE1 ) * ${K.H} / krDy;

	#ifdef FOG_EXP2
		float krGlobal = fogDensity;
	#else
		float krGlobal = 0.0;
	#endif

	float fogFactor = min( 1.0 - exp( -( ${K.SEA} * krAvg + krGlobal ) * krD ), ${K.MAX} );

	// Aerial perspective is skylight scattered in the air between here and the
	// eye. Inside the bore there is no sky above that air, and a third of a stop
	// of warm haze laid over the interior was a good part of why the tunnel
	// out-shone its own exit.
	fogFactor *= 1.0 - krInterior * ${glslFloat(INTERIOR_FOG_CUT)};

	// CHROMA CONVERGES FASTER THAN VALUE. This is the difference between "fog"
	// and aerial perspective, and its absence is why the backdrop read as a
	// cardboard cut-out: a ridge at 600 m was landing at 42% haze, which is the
	// right VALUE mix and leaves 58% of a hot #dc6428 rock behind — measured on
	// the round-1 frames, a chroma spread of 116 against a sky of 27, i.e. the
	// most distant thing in shot was four times more saturated than the air in
	// front of it. Real distance does not work that way: scattered light fills
	// in the shadows and washes the hue out long before it equalises the
	// brightness, which is exactly what lets a painter stack four ridges at four
	// different values and still have all four read as "far".
	//
	// So the fragment is first rotated onto the haze's own chromaticity at a
	// faster rate, KEEPING ITS OWN LUMINANCE — the layer ladder survives intact,
	// only the colour drains — and only then mixed toward the haze by the honest
	// Beer factor. At 600 m that is 78% desaturated but only 42% lightened; at
	// 3 km both are at the cap and the headland sits a couple of percent off the
	// sky it stands in front of, which is what §9.5 is asking for.
	vec3 krHazeCol = krFogHaze( krFwd.xz );
	float krHazeL = max( dot( krHazeCol, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
	float krOwnL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 krDrained = krHazeCol * ( krOwnL / krHazeL );
	float krChroma = min( fogFactor * ${glslFloat(FOG_CHROMA_RATE)}, ${glslFloat(FOG_CHROMA_MAX)} );

	gl_FragColor.rgb = mix( mix( gl_FragColor.rgb, krDrained, krChroma ), krHazeCol, fogFactor );

#endif
`,
  };
}

/**
 * Everything scene-wide that needs to be visible from BOTH the lighting chunks
 * and the fog chunk goes into `<common>`, which is the one chunk every fragment
 * shader in three includes — lit, unlit, and hand-rolled ShaderMaterials that
 * pull three's chunks piecemeal. `krInterior` therefore always exists, and reads
 * 0 for anything that never runs the lighting path, which is exactly right: an
 * unlit material has no indirect term to occlude.
 */
function commonChunk(original: string, volume: InteriorVolume | null): string {
  const F = glslFloat;
  let body = '\treturn 0.0;';

  if (volume !== null && volume.segments.length > 0) {
    const lines: string[] = [
      `\tvec3 krD = p - vec3( ${F(volume.cx)}, ${F(volume.cy)}, ${F(volume.cz)} );`,
      `\tif ( dot( krD, krD ) > ${F(volume.radius * volume.radius)} ) return 0.0;`,
      '\tfloat m = 0.0;',
      '\tvec3 ap, q; float t, s;',
    ];
    // Every segment is expressed RELATIVE to the volume centre, and the test
    // runs on `krD` rather than on `p`. The circuit sits a few hundred metres
    // from the origin and this is squaring distances; keeping the operands under
    // a hundred metres costs nothing and keeps the whole test comfortably inside
    // float precision even where a driver decides mediump is good enough.
    for (const seg of volume.segments) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay, dz = seg.bz - seg.az;
      const inv = 1 / Math.max(dx * dx + dy * dy + dz * dz, 1e-6);
      lines.push(
        `\tap = krD - vec3( ${F(seg.ax - volume.cx)}, ${F(seg.ay - volume.cy)}, ` +
          `${F(seg.az - volume.cz)} );`,
        `\tt = clamp( dot( ap, vec3( ${F(dx)}, ${F(dy)}, ${F(dz)} ) ) * ${F(inv)}, 0.0, 1.0 );`,
        `\tq = ap - vec3( ${F(dx)}, ${F(dy)}, ${F(dz)} ) * t;`,
        `\ts = ${F(seg.s0)} + ${F(seg.s1 - seg.s0)} * t;`,
        `\tm = max( m, ( 1.0 - smoothstep( ${F(INTERIOR_R_IN * INTERIOR_R_IN)}, ` +
          `${F(INTERIOR_R_OUT * INTERIOR_R_OUT)}, dot( q, q ) ) )` +
          ` * smoothstep( 0.0, ${F(INTERIOR_MOUTH)}, s )` +
          ` * smoothstep( 0.0, ${F(INTERIOR_MOUTH)}, ${F(volume.total)} - s ) );`,
      );
    }
    lines.push('\treturn m;');
    body = lines.join('\n');
  }

  return `${original}

// --- Kart Royale: scene-wide lighting state ---------------------------------
// 1 deep inside an enclosed volume, 0 in the open. Written once per fragment by
// the patched <lights_fragment_begin>; read by the indirect terms, by the
// shadowless fill lights and by aerial perspective.
float krInterior = 0.0;

/** World-space shading normal. Written alongside krInterior; the shadow filter
 *  needs it for its receiver-plane bias and the fills need it for nothing at
 *  all, but recovering it twice from the view matrix would be silly. */
vec3 krWorldNormal = vec3( 0.0, 1.0, 0.0 );

/** The key's own shadow test, 0 = fully occluded .. 1 = fully lit. Written by
 *  the directional loop at cascade 0 and read by the fill coupling and by the
 *  warm terminator band. 1 when there is no shadow map at all, which is right:
 *  with nothing to occlude the key, nothing is in its shadow. */
float krKeyShadow = 1.0;

/** How much of the KEY this fragment is actually receiving, shaped — shadow
 *  test times a saturating N·L. This, not the shadow test alone, is what the
 *  cool fill is coupled against: a surface turned away from the sun is in shade
 *  whatever the shadow map says. */
float krKeyLit = 0.0;

/** Peaks at the half-shadow line, zero at both ends. The penumbra band. */
float krPenumbra = 0.0;

float krInteriorAt( vec3 p ) {
${body}
}

/**
 * The low sun grazing a silhouette.
 *
 * Not a physical term and not pretending to be — it is the third light of a
 * three-point rig, expressed as a function of geometry rather than as another
 * DirectionalLight, because a rim that is a light has to be re-aimed every time
 * the subject turns and there are eight subjects. Driven by the KEY's already
 * shadowed radiance, so it vanishes in shadow and inside the tunnel exactly as
 * a real one would.
 *
 * The 'lit' factor is what keeps it honest: the rim appears only on the edge that is
 * turned toward the sun, so a kart with the sun behind it gets a hot outline and
 * a kart driving into the sun gets none, which is the correct read.
 *
 * The floor mask is not cosmetic. Vectors here are VIEW space, so the world-up
 * component has to be recovered from the view matrix; without the mask, every
 * road fragment past about twelve metres is grazing and the rim becomes a second
 * uncontrolled specular smeared over the whole carriageway.
 */
vec3 krSunRim( const in vec3 lightColor, const in vec3 lightDir,
	const in vec3 N, const in vec3 V, const in float rough ) {
	float graze = 1.0 - saturate( dot( N, V ) );
	float lit = saturate( dot( N, lightDir ) );
	float worldY = dot( N, vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] ) );
	float mask = 1.0 - smoothstep( 0.25, 0.95, worldY );
	float k = ${F(RIM_STRENGTH)} * pow( graze, ${F(RIM_POWER)} ) * lit * mask;
	return lightColor * ( k * ( 1.0 - 0.65 * rough ) );
}
`;
}

/** Set `krInterior` before anything reads it, from the world position three
 *  itself reconstructs the same way for its light-probe grid. */
function interiorLightsChunk(original: string): string {
  const anchor = 'vec3 geometryClearcoatNormal = vec3( 0.0 );';
  if (!original.includes(anchor)) {
    console.warn('[sky] lights_fragment_begin layout changed; interior volume skipped');
    return original;
  }
  return original.replace(anchor, `${anchor}

	krInterior = krInteriorAt( ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz );
	// three's own inverseTransformDirection: the view rotation is orthonormal, so
	// right-multiplying by it is the inverse. The shadow filter's receiver-plane
	// bias is expressed in the light's WORLD basis and needs this.
	krWorldNormal = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
`);
}

/**
 * Occlude the indirect terms inside an interior volume, then put back the two
 * floors and the penumbra band that the direct rig cannot reach.
 *
 * This runs after `lights_fragment_begin` and before `RE_IndirectDiffuse`, so
 * `irradiance` here is the complete non-directional budget for the fragment.
 *
 *  · THE FLOOR. §3 forbids pure `#000` in albedo and §9.6 forbids pure-black
 *    shadows; a cavity with no normal pointing at any of the four directional
 *    terms had neither. Teal in the open (§2's grade leans shadows teal), warm
 *    sodium inside the bore (a tunnel lit by sodium strips should fall off
 *    toward sodium, not toward a hole).
 *
 *  · THE PENUMBRA BAND. §2 asks for a warm-tinted penumbra, and a shadow term
 *    that only ever multiplies toward zero can produce a grey stencil and
 *    nothing else. `krPenumbra` peaks on the half-shadow line, so this lays a
 *    lick of the key's own #ffd9a8 exactly across the terminator and nowhere
 *    else.
 */
function indirectMapsChunk(original: string): string {
  const F = glslFloat;
  // `new Color(hex)` already lands in the working (linear-sRGB) space — three's
  // ColorManagement decodes the hex on the way in. Converting again here is the
  // classic double-decode and it cost this floor a factor of seven.
  const floor = new THREE.Color(FLOOR_COLOR);
  const cave = new THREE.Color(INTERIOR_FLOOR_COLOR);
  const warm = new THREE.Color(SUN_LIGHT_COLOR);
  const v = (c: THREE.Color, k: number) =>
    `vec3( ${F(c.r * k)}, ${F(c.g * k)}, ${F(c.b * k)} )`;
  return `${original}
#if defined( RE_IndirectDiffuse )
	irradiance *= 1.0 - krInterior * ${F(INTERIOR_IRRADIANCE_CUT)};
	iblIrradiance *= 1.0 - krInterior * ${F(INTERIOR_IRRADIANCE_CUT)};
	irradiance += mix( ${v(floor, FLOOR_IRRADIANCE)},
		${v(cave, INTERIOR_FLOOR_IRRADIANCE)}, krInterior );
	irradiance += ${v(warm, TERMINATOR_IRRADIANCE)} * krPenumbra;
#endif
#if defined( RE_IndirectSpecular )
	radiance *= 1.0 - krInterior * ${F(INTERIOR_RADIANCE_CUT)};
	clearcoatRadiance *= 1.0 - krInterior * ${F(INTERIOR_RADIANCE_CUT)};
#endif
`;
}

/**
 * Split the IBL into its specular and diffuse halves. Only getIBLIrradiance —
 * the Lambertian term — is scaled; getIBLRadiance, which is the actual
 * reflection, keeps the material's authored intensity.
 */
function envDiffuseChunk(original: string, scale: number): string {
  const F = glslFloat;
  let out = original;

  const from = 'return PI * envMapColor.rgb * envMapIntensity;';
  const to = `return PI * envMapColor.rgb * envMapIntensity * ${F(scale)};`;
  if (!out.includes(from)) {
    console.warn('[sky] getIBLIrradiance signature moved; diffuse IBL left unscaled');
  } else {
    out = out.replace(from, to);
  }

  // ...AND A ROUGHNESS ROLLOFF ON THE SPECULAR HALF.
  //
  // Decomposed on a 0.72-roughness tarmac under this rig, the environment was
  // contributing sRGB (22,20,34) of the road's (89,74,81) — the largest single
  // COOL term in the frame and, unlike the fill, one that lands on lit and
  // shaded road alike. It is not a fill at all; it is a mirror image of the blue
  // upper sky in a surface that is nearly matte, arriving at full strength
  // because three's split-sum IBL gathers the whole hemisphere with no
  // occlusion by the microfacets the surface is made of and no multiple-
  // scattering loss. On a mirror that error is nil; on rough dielectric it is
  // most of the term.
  //
  // So: full strength up to roughness 0.35 and rolled off beyond it. Every
  // material §4 actually cares about reflecting the sky is under that line —
  // chrome trim at 0.15, clearcoat at 0.06, painted bodywork at 0.28 — so the
  // one thing ENV_INTENSITY = 1.0 exists to protect is untouched, while the
  // tarmac, the rock and the stucco stop mirroring a blue sky they should only
  // be scattering.
  //
  // Round 2 took the far end from 0.42 to 0.14 and pulled ROUGH_ENV_END in from
  // 0.85 to 0.70, because at 0.85 tarmac's own 0.72 never reached the floor and
  // the term was still ~60% of every road pixel — lit and shadowed alike, since
  // nothing occludes it. See ROUGH_ENV_SCALE for the decomposition; it is the
  // single biggest reason cast shadows were illegible on the carriageway.
  const specFrom = 'return envMapColor.rgb * envMapIntensity;';
  const specTo = 'return envMapColor.rgb * envMapIntensity * mix( 1.0, '
    + `${F(ROUGH_ENV_SCALE)}, smoothstep( ${F(ROUGH_ENV_START)}, ${F(ROUGH_ENV_END)}, roughness ) );`;
  const n = out.split(specFrom).length - 1;
  if (n < 1) {
    console.warn('[sky] getIBLRadiance signature moved; specular IBL left unscaled');
    return out;
  }
  return out.split(specFrom).join(specTo);
}

/**
 * Fade a shadow map out across its own frustum border instead of cutting it
 * dead at the edge. Three returns "fully lit" the moment a fragment leaves a
 * shadow map, which on a flat surface is a straight line of constant value.
 *
 * With the cascade cross-fade below doing the real work this is down to a 4%
 * safety strip, but it still matters in two places: the FAR cascade's outer
 * border, which nothing catches, and the single-map path used below
 * Quality.High. It also applies to spot shadows, where a soft frustum edge is
 * what you want anyway.
 *
 * Applied to all three getShadow variants — the three-tab return is unique to
 * them, getPointShadow is indented one level shallower and is left alone.
 * shadowCoord has already been divided by w by the time this runs.
 */
function shadowBorderChunk(original: string): string {
  const from = '\t\t\treturn mix( 1.0, shadow, shadowIntensity );';
  const to = [
    '\t\t\tvec2 krEdge = abs( shadowCoord.xy - 0.5 ) * 2.0;',
    `\t\t\tfloat krFade = 1.0 - smoothstep( ${glslFloat(SHADOW_BORDER_FADE)}, 1.0, max( krEdge.x, krEdge.y ) );`,
    '\t\t\tshadow = mix( 1.0, shadow, krFade );',
    from,
  ].join('\n');
  const count = original.split(from).length - 1;
  if (count !== 3) {
    console.warn(`[sky] getShadow layout changed (${count} sites); border fade skipped`);
    return original;
  }
  return original.split(from).join(to);
}

/**
 * Append the cascade resolver to `shadowmap_pars_fragment`.
 *
 * THIS IS THE FIX FOR THE HARD-EDGED KEY-LIGHT STEP. The old rig stacked two
 * DirectionalLights sharing the sun's direction and SPLIT THE SUN'S ENERGY
 * between them, because three has no notion of a cascade: both lights light
 * every fragment and only the shadow test is per-map, so outside the near
 * frustum three returns "lit" from the near map and that light's whole share of
 * the key leaks through anything the far map alone is shadowing. Every version
 * of that is a brightness discontinuity along a dead-straight geometric line,
 * and shrinking the leak (0.66 → 0.80 → …) only makes the step smaller; it never
 * makes it stop being a step. You cannot hide a hard edge by lowering its
 * contrast.
 *
 * So: light 0 carries 100% of the key. Light 1 is a shadow-only slave — same
 * direction, intensity 0, skipped entirely in `lights_fragment_begin` — and its
 * map is read from here. The near map is used inside its own box, the far map
 * outside, and the two SHADOW TESTS are cross-faded across the border. What
 * changes at the seam is penumbra width (2.9 cm/texel to 21 cm/texel), which the
 * eye reads as distance. What does not change is how much key the surface gets.
 *
 * Indexing the arrays directly is safe because they are declared at the top of
 * this same chunk, and because Sky is the only thing in the game that creates a
 * DirectionalLight and adds the near one first (see `buildLights`).
 */
function cascadeShadowChunk(original: string, specs: CascadeSpec[]): string {
  const F = glslFloat;
  const near = specs[0];
  const far = specs.length > 1 ? specs[1] : null;

  const helper = /* glsl */`
	#if NUM_DIR_LIGHT_SHADOWS > 0
	#if defined( SHADOWMAP_TYPE_PCF )

		// world-space basis of the light's own orthographic camera, identical to
		// the one DirectionalLightShadow derives via lookAt with up = +Y. u runs
		// along KR_LX, v along KR_LY, and stored depth increases along -KR_LZ.
		const vec3 KR_LX = vec3( ${F(SHADOW_BASIS.x.x)}, ${F(SHADOW_BASIS.x.y)}, ${F(SHADOW_BASIS.x.z)} );
		const vec3 KR_LY = vec3( ${F(SHADOW_BASIS.y.x)}, ${F(SHADOW_BASIS.y.y)}, ${F(SHADOW_BASIS.y.z)} );
		const vec3 KR_LZ = vec3( ${F(SHADOW_BASIS.z.x)}, ${F(SHADOW_BASIS.z.y)}, ${F(SHADOW_BASIS.z.z)} );

${pcfGlsl('krPcfNear', near)}
${far ? pcfGlsl('krPcfFar', far) : ''}

	#endif

		float krCascadeShadow() {

			#if !defined( SHADOWMAP_TYPE_PCF )

				// Defensive: the receiver-plane filter below is written against the
				// sampler2DShadow the PCF path declares. Anything else falls back to
				// three's own, which is at least correct if not soft.
				return getShadow(
					directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize,
					directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias,
					directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );

			#elif NUM_DIR_LIGHT_SHADOWS > 1

				vec4 nc = vDirectionalShadowCoord[ 0 ];
				vec3 ndc = nc.xyz / max( nc.w, 1e-6 );
				// distance to the near box's border, 0 at the centre and 1 at the face,
				// taken over depth as well as the two lateral axes so a fragment leaving
				// through the back of the frustum hands over just as smoothly
				vec3 krE = abs( ndc - 0.5 ) * 2.0;
				float krW = 1.0 - smoothstep( ${F(CASCADE_BLEND)}, 1.0,
					max( max( krE.x, krE.y ), krE.z ) );

				// Order inverted from the obvious one on purpose. Inside the box the
				// near map is authoritative and COMPLETE — in light space an occluder
				// sits at the same xy as the surface it shadows, so any caster of a
				// fragment inside the box is also inside the box — which means the far
				// map's five taps are pure waste over the majority of the screen. Most
				// fragments now cost nine shadow fetches instead of ten, and only the
				// 20% cross-fade band pays for both.
				if ( krW >= 1.0 ) return krPcfNear( directionalShadowMap[ 0 ], vDirectionalShadowCoord[ 0 ] );

				float krFar = krPcfFar( directionalShadowMap[ 1 ], vDirectionalShadowCoord[ 1 ] );
				if ( krW <= 0.0 ) return krFar;

				return mix( krFar, krPcfNear( directionalShadowMap[ 0 ], vDirectionalShadowCoord[ 0 ] ), krW );

			#else

				return krPcfNear( directionalShadowMap[ 0 ], vDirectionalShadowCoord[ 0 ] );

			#endif

		}

	#endif
`;
  // Insert at file scope after every getShadow variant has been declared: the
  // last column-0 `#endif` closes `#ifdef USE_SHADOWMAP`.
  const at = original.lastIndexOf('\n#endif');
  if (at < 0) {
    console.warn('[sky] shadowmap_pars_fragment layout changed; cascade resolver skipped');
    return original;
  }
  return original.slice(0, at) + '\n' + helper + original.slice(at);
}

/**
 * One cascade's shadow filter, with every constant it needs resolved on the CPU.
 *
 * THE RECEIVER-PLANE BIAS. A PCF tap does not sample the depth the fragment
 * would have; it samples the depth of a point `o` away in shadow-map UV, and on
 * a sloped receiver that point is at a different distance from the light. Bias
 * it by a constant and you are choosing between acne (too small) and detached
 * shadows (too big); at a 14° sun on flat ground the required constant is four
 * times the tap's lateral reach, so there is no value that is both.
 *
 * The gradient is closed-form here, because the light is orthographic and its
 * basis is a compile-time constant. Stay on the receiver plane while moving δx
 * along the light's u axis and δy along its v axis, and the required travel
 * along the light direction follows from `dp · n = 0`:
 *
 *     δz = -( δx (X·n) + δy (Y·n) ) / (Z·n)
 *
 * Stored depth is linear in -δz over the ortho range, and one unit of UV is
 * `2 * extent` metres, so
 *
 *     d(depth) / d(uv) = ( X·n, Y·n ) * 2 * extent / ( (Z·n) * (far - near) )
 *
 * — two dot products and a divide, exact at every slope, and it makes the tap
 * offsets self-biasing. What is left over as a constant is then only depth
 * quantisation, which is centimetres.
 */
function pcfGlsl(name: string, s: CascadeSpec): string {
  const F = glslFloat;
  const depthRange = shadowDepthRange(s);
  const span = 2 * s.extent;
  const radiusUv = s.pcfRadius / s.mapSize;
  const taps: string[] = [];
  for (let i = 0; i < s.taps; i++) {
    taps.push(
      `\t\t\to = vogelDiskSample( ${i}, ${s.taps}, phi ) * ${F(radiusUv)};`,
      '\t\t\ts += texture( map, vec3( c.xy + o, z + dot( o, g ) ) );',
    );
  }
  return /* glsl */`
		float ${name}( sampler2DShadow map, vec4 coord ) {

			vec3 c = coord.xyz / max( coord.w, 1e-6 );
			if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;

			// N·L against the light's own axis. Floored rather than branched: below
			// ~6° of grazing the exact gradient diverges and the fragment is being
			// killed by its own N·L anyway.
			float nz = max( dot( krWorldNormal, KR_LZ ), 0.11 );
			vec2 g = clamp(
				vec2( dot( krWorldNormal, KR_LX ), dot( krWorldNormal, KR_LY ) )
					* ( ${F(span / depthRange)} / nz ),
				-${F((SLOPE_BIAS_TAN_MAX * span) / depthRange)},
				${F((SLOPE_BIAS_TAN_MAX * span) / depthRange)} );

			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			float z = c.z - ${F(s.constBias / depthRange)};
			float s = 0.0;
			vec2 o;
${taps.join('\n')}
			s *= ${F(1 / s.taps)};

			// Soft frustum border: three hands back "fully lit" the instant a
			// fragment leaves a map, which on flat ground is a straight line of
			// constant value across the road.
			vec2 e = abs( c.xy - 0.5 ) * 2.0;
			return mix( 1.0, s, 1.0 - smoothstep( ${F(SHADOW_BORDER_FADE)}, 1.0, max( e.x, e.y ) ) );

		}
`;
}

/**
 * Rewrite the directional-light loop in `lights_fragment_begin` so cascade 1 is
 * shadow-only and cascade 0 resolves both maps. Falls back to stock behaviour
 * whenever there is only one shadow-casting directional light, so the Medium and
 * Low paths (and any future third-party light) are untouched.
 *
 * `UNROLLED_LOOP_INDEX` and `NUM_DIR_LIGHT_SHADOWS` are both textually
 * substituted by three before the preprocessor ever sees them, which is what
 * lets a `#if` pick a different body per unrolled iteration — three's own code
 * in this chunk relies on exactly that.
 */
function cascadeLightsChunk(original: string): string {
  const head = '\tfor ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {\n';
  const tail = '\n\t}\n\t#pragma unroll_loop_end';
  const shadowLine = `		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;`;

  const h = original.indexOf(head);
  const t = h < 0 ? -1 : original.indexOf(tail, h);
  if (h < 0 || t < 0 || !original.slice(h, t).includes(shadowLine)) {
    console.warn('[sky] directional light loop moved; cascade selection skipped');
    return original;
  }

  const reLine = '		RE_Direct( directLight, geometryPosition, geometryNormal, ' +
    'geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

  // Cascade 0 resolves every map itself and publishes the raw shadow term.
  let body = original.slice(h + head.length, t).replace(shadowLine, `		directionalLightShadow = directionalLightShadows[ i ];
		#if ( UNROLLED_LOOP_INDEX == 0 )
		krKeyShadow = ( directLight.visible && receiveShadow ) ? krCascadeShadow() : 1.0;
		directLight.color *= krKeyShadow;
		#else
${shadowLine.split('\n')[1]}
		#endif`);

  // Two more things hang off this loop, both keyed on the unrolled index:
  //
  //  · Directional lights past the shadow-casting ones are the cool sky fill and
  //    the warm ground bounce. They cast nothing, which is what let them shine
  //    straight through a hillside; inside an interior volume they are cut.
  //    (Three sorts shadow casters to the front of the array, so the test is
  //    exactly "is this a fill".) When shadows are off entirely the sun itself
  //    lands in that bucket, which is also correct — with no map to occlude it,
  //    the volume is the only thing that can.
  //
  //  · Light 0 is always the key, and after it has been shaded and shadowed it
  //    is also the only correct source for a rim — and for `krKeyLit`, which is
  //    the whole warm/cool axis of the frame (see FILL_KEY_COUPLING). It has to
  //    be written from inside iteration 0, because the loop is unrolled and the
  //    three fills at the tail read it in the same statement block.
  //
  //  · THE FILL COUPLING, in the last three iterations. Which light is which is
  //    known exactly: `buildLights` adds skyFill, then bounce, then the lateral
  //    bounce, after however many cascades exist, and three is stable-sorted
  //    with shadow casters first. Keying off `NUM_DIR_LIGHTS - 3` rather than
  //    off `NUM_DIR_LIGHT_SHADOWS` matters, because with shadows disabled the
  //    KEY lands in the `>= NUM_DIR_LIGHT_SHADOWS` bucket and coupling the key
  //    to itself would put the road out entirely.
  if (body.includes(reLine)) {
    body = body.replace(reLine, `		#if ( UNROLLED_LOOP_INDEX == 0 )
		krKeyLit = krKeyShadow * saturate( dot( geometryNormal, directLight.direction )
			* ${glslFloat(KEY_LIT_SHAPE)} );
		krPenumbra = 4.0 * krKeyShadow * ( 1.0 - krKeyShadow )
			* saturate( dot( geometryNormal, directLight.direction ) * ${glslFloat(KEY_LIT_SHAPE)} );
		#endif

		#if ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )
		directLight.color *= 1.0 - krInterior * ${glslFloat(INTERIOR_FILL_CUT)};
		#endif

		#if ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHTS - 3 )
		directLight.color *= 1.0 - krKeyLit * ${glslFloat(1 - FILL_KEY_COUPLING)};
		#elif ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHTS - 2 )
		directLight.color *= 1.0 - krKeyLit * ${glslFloat(1 - BOUNCE_KEY_COUPLING)};
		#endif

${reLine}

		#if ( UNROLLED_LOOP_INDEX == 0 ) && defined( STANDARD ) && defined( RE_Direct )
		reflectedLight.directSpecular += krSunRim( directLight.color, directLight.direction,
			geometryNormal, geometryViewDir, material.roughness );
		#endif`);
  } else {
    console.warn('[sky] RE_Direct call moved; rim and interior fill occlusion skipped');
  }

  // Cascade 1 drops out of the loop completely: no light info, no shadow test,
  // no RE_Direct. One BRDF evaluation per fragment cheaper than the rig this
  // replaces, which ran the full shading equation twice for one sun.
  const guarded = `		#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 )

		// shadow-only cascade: no energy, no BRDF; krCascadeShadow() reads its map

		#else
${body}
		#endif
`;
  return original.slice(0, h + head.length) + guarded + original.slice(t);
}

// --- module scratch (nothing in the update path allocates) --------------------

const _center = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _camDir = new THREE.Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

interface Cascade {
  light: THREE.DirectionalLight;
  extent: number;
  distance: number;
  mapSize: number;
  /** update every N frames; 1 = every frame */
  interval: number;
}

export class Sky implements System {
  /** The physical model. Public so anything can ask what colour the sky is. */
  model!: AtmosphereModel;

  /**
   * Key light — also published as `ctx.sun`. Carries 100% of the sun's energy
   * and owns the near shadow cascade. Anything sampling `ctx.sun.intensity` gets
   * the art bible's 4.2, not a fraction of it.
   */
  sun!: THREE.DirectionalLight;
  /**
   * Far cascade. A shadow-only slave: same direction, INTENSITY ZERO, present
   * purely so three renders and binds its map as `directionalShadowMap[1]` for
   * `krCascadeShadow` to read. Null below Quality.High.
   */
  sunFar: THREE.DirectionalLight | null = null;
  /** Unit vector toward the sun; mirrors `ctx.sunDirection`. */
  readonly sunDirection = SUN_DIRECTION.clone();

  // --- data the post stack (godrays / flares) needs from us ---
  /** Sun position in screen UV space, (0,0) bottom-left .. (1,1) top-right. */
  readonly sunScreenPosition = new THREE.Vector2(0.5, 0.5);
  /** False when the sun is behind the camera; screen position is meaningless then. */
  sunVisible = false;
  /** 0..1 — how much a light-shaft pass should contribute this frame. */
  sunScreenIntensity = 0;
  /** Linear radiance of the disc, for flare/streak tinting. */
  readonly sunDiscColor = new THREE.Color();
  /** Linear radiance of the horizon as the DOME draws it. Deliberately above
   *  display white — that is the only thing that tone maps to the bible's
   *  #ffd0a0. Do not use it as a fog or blend target; use `hazeColor`. */
  readonly horizonColor = new THREE.Color();
  /** The same horizon with the highlight rolloff applied: what the fog, the
   *  sky's low-elevation weld and the cloud aerial term all converge on. */
  readonly hazeColor = new THREE.Color();

  /** The PMREM environment, also published as `ctx.envMap`. */
  envMap: THREE.Texture | null = null;
  /** The dome material, exposed for debugging / uniform pokes. */
  material!: THREE.ShaderMaterial;
  /**
   * The sky dome itself (also findable as `scene.getObjectByName('Sky')`).
   * Exposed so the post stack can exclude it from any `overrideMaterial`
   * depth/normal prepass: it writes no depth and its vertex shader pins z to
   * the far plane, so a prepass that draws it with a foreign material would
   * stamp a unit cube into the depth buffer.
   */
  dome!: THREE.Mesh;

  private envMesh!: THREE.Mesh;
  private envScene!: THREE.Scene;
  private geometry!: THREE.BoxGeometry;
  private lut!: THREE.DataTexture;
  private noise!: THREE.DataTexture;
  private probe!: THREE.LightProbe;
  private skyFill!: THREE.DirectionalLight;
  private bounce!: THREE.DirectionalLight;
  private lateralBounce!: THREE.DirectionalLight;
  private specs: CascadeSpec[] = [];
  private interiorInstalled = false;
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private cascades: Cascade[] = [];
  private frame = 0;

  // light-space basis, matching DirectionalLightShadow's own lookAt convention
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();

  init(ctx: Ctx): void {
    // The render pipeline is constructed before us, so whatever exposure it
    // settled on is what the calibration should solve against.
    const exposure = ctx.renderer?.toneMappingExposure || 1.05;
    this.model = new AtmosphereModel(exposure);

    // The cascade table is resolved first and then used by BOTH the shader
    // patches and `buildLights`, because the receiver-plane bias bakes each
    // cascade's extent and depth range in as GLSL literals. If the two ever
    // came from different places the bias would point the wrong way and the
    // ground would self-shadow, which is the round-1 blocker.
    this.specs = cascadeSpecs(ctx.settings.shadows, ctx.settings.quality);

    // Before anything is drawn, therefore before any program is compiled. The
    // interior volume is filled in on the first frame; see buildInteriorVolume.
    this.installShaderPatches(null);
    this.buildDome(ctx);
    this.buildFog(ctx);
    this.buildLights(ctx);
    this.buildEnvironment(ctx);

    ctx.sun = this.sun;
    ctx.sunDirection.copy(this.sunDirection);
    this.sunDiscColor.setRGB(
      this.model.sunDiscColor.x, this.model.sunDiscColor.y, this.model.sunDiscColor.z,
      THREE.LinearSRGBColorSpace,
    );
    this.horizonColor.setRGB(
      this.model.horizonColor.x, this.model.horizonColor.y, this.model.horizonColor.z,
      THREE.LinearSRGBColorSpace,
    );
    this.hazeColor.setRGB(
      this.model.hazeColor.x, this.model.hazeColor.y, this.model.hazeColor.z,
      THREE.LinearSRGBColorSpace,
    );

    // The post stack has no reference to this object otherwise; `ctx.sun` alone
    // is not enough to place a light-shaft origin on screen.
    (ctx as any).sky = this;
  }

  // -- construction -----------------------------------------------------------

  /**
   * Install the ShaderChunk overrides. Idempotent, and it snapshots the stock
   * chunks the first time so `dispose` can put them back.
   */
  private installShaderPatches(volume: InteriorVolume | null): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (_originalChunks === null) {
      _originalChunks = {};
      for (const name of PATCHED_CHUNKS) _originalChunks[name] = chunks[name];
    }
    const stock = _originalChunks;

    const fog = fogChunks(this.model, stock.fog_pars_fragment);
    for (const name of Object.keys(fog)) chunks[name] = fog[name];

    chunks.common = commonChunk(stock.common, volume);
    chunks.envmap_physical_pars_fragment =
      envDiffuseChunk(stock.envmap_physical_pars_fragment, DIFFUSE_ENV_INTENSITY);
    chunks.shadowmap_pars_fragment =
      cascadeShadowChunk(shadowBorderChunk(stock.shadowmap_pars_fragment), this.specs);
    chunks.lights_pars_begin = stock.lights_pars_begin;
    chunks.lights_fragment_begin =
      interiorLightsChunk(cascadeLightsChunk(stock.lights_fragment_begin));
    chunks.lights_fragment_maps = indirectMapsChunk(stock.lights_fragment_maps);
  }

  /**
   * Fit the interior volume to the tunnel bore.
   *
   * This has to happen after `Track.init`, and Sky inits before Track because
   * everything downstream of Sky needs the env map and the key light at ITS
   * init. So the chunks go in twice: once at boot with an empty volume, so that
   * nothing can possibly compile against a half-built patch set, and once on the
   * first frame with the real one. Nothing has been rendered by then, so nothing
   * has been compiled either and the second install is free — the
   * `needsUpdate` sweep below is belt and braces for a future system that
   * decides to warm a shader during its own init.
   */
  private buildInteriorVolume(ctx: Ctx): InteriorVolume | null {
    const track = ctx.track;
    if (!track || !(track.length > 1)) return null;

    const pts: THREE.Vector3[] = [];
    const arc: number[] = [];
    const span = TUNNEL_T1 - TUNNEL_T0;
    // The bore geometry is built a touch outside the layout's t range; match it
    // so the volume covers the whole lining rather than stopping short of it.
    const t0 = TUNNEL_T0 - 0.005;
    let total = 0;
    for (let i = 0; i <= INTERIOR_SEGMENTS; i++) {
      const t = t0 + ((span + 0.01) * i) / INTERIOR_SEGMENTS;
      const p = track.sample(t - Math.floor(t)).pos.clone();
      // The centreline sits on the carriageway; the bore's mass is above it, so
      // lift the axis to the middle of the section. That keeps the capsule
      // radius honest instead of having to cover the crown from the floor.
      p.y += 3.4;
      if (i > 0) total += p.distanceTo(pts[i - 1]);
      pts.push(p);
      arc.push(total);
    }
    if (!(total > 1)) return null;

    const segments: InteriorSegment[] = [];
    for (let i = 0; i < INTERIOR_SEGMENTS; i++) {
      const a = pts[i], b = pts[i + 1];
      segments.push({
        ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
        s0: arc[i], s1: arc[i + 1],
      });
    }

    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(p);
    const c = box.getCenter(new THREE.Vector3());
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, p.distanceTo(c));

    return {
      segments,
      cx: c.x, cy: c.y, cz: c.z,
      // The bounding sphere is a REJECT test, so it has to be generous: a
      // fragment is inside the volume out to INTERIOR_R_OUT off the axis.
      radius: radius + INTERIOR_R_OUT + 1,
      total,
    };
  }

  private buildDome(ctx: Ctx): void {
    const q = ctx.settings.quality;
    const layers = q >= Quality.High ? 3 : q === Quality.Medium ? 2 : 1;

    this.lut = this.model.bakeScatteringLUT();
    this.noise = this.model.bakeCloudNoise();
    const maxAniso = ctx.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
    this.noise.anisotropy = Math.min(4, maxAniso);

    const m = this.model;
    const u = m.uniformValues();
    const sunPlane = new THREE.Vector2(this.sunDirection.x, this.sunDirection.z).normalize();

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.ShaderMaterial({
      name: 'SkyAtmosphere',
      uniforms: {
        uLut: { value: this.lut },
        uNoise: { value: this.noise },
        uSunDir: { value: this.sunDirection },
        uSunPlane: { value: sunPlane },
        uGainZenith: { value: u.gainZenith },
        uGainHorizon: { value: u.gainHorizon },
        uMieTint: { value: u.mieTint },
        uSunDisc: { value: m.sunDiscColor.clone() },
        uGroundColor: { value: m.groundColor.clone() },
        uHorizonColor: { value: m.horizonColor.clone() },
        uCloudSun: { value: m.cloudSunColor.clone() },
        uCloudAmbient: { value: m.cloudAmbientColor.clone() },
        uCameraXZ: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uMieG: { value: u.mieG },
        uMieIso: { value: u.mieIso },
        uRayBack: { value: u.rayBack },
        uGainBlendEnd: { value: u.gainBlendEnd },
        uGainBlendPow: { value: u.gainBlendPow },
        uSunRadius: { value: m.sunAngularRadius },
        uCloudAmount: { value: 1 },
      },
      defines: { CLOUD_LAYERS: layers },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: buildSkyFragmentShader(m),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(this.geometry, this.material);
    this.dome.name = 'Sky';
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    // Drawn LAST among opaques, not first: the dome sits on the far plane and
    // writes no depth, so with the world already in the depth buffer only the
    // pixels that are actually sky ever run the scattering + cloud shader.
    this.dome.renderOrder = 1000;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    ctx.scene.add(this.dome);

    // A second instance of the same material, alone in its own scene, is what
    // the cube camera renders for the environment map.
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(this.geometry, this.material);
    this.envMesh.frustumCulled = false;
    this.envMesh.matrixAutoUpdate = false;
    this.envScene.add(this.envMesh);
  }

  /**
   * A FogExp2 is still what goes on the scene — that is what makes three define
   * USE_FOG/FOG_EXP2 and hand every material a `fogColor` and a `fogDensity`.
   * The exp2 term itself is gone, replaced in the chunk above; `density` now
   * means the height-independent component and `color` the base haze.
   */
  private buildFog(ctx: Ctx): void {
    const h = this.model.hazeColor;
    const fog = new THREE.FogExp2(0x000000, FOG_GLOBAL_DENSITY);
    fog.color.setRGB(h.x, h.y, h.z, THREE.LinearSRGBColorSpace);
    ctx.scene.fog = fog;
  }

  private buildLights(ctx: Ctx): void {
    const shadows = ctx.settings.shadows;

    // basis used for texel snapping; identical to the one
    // DirectionalLightShadow derives via camera.lookAt with up = +Y, and
    // identical to the one the shadow filter's receiver-plane bias is written
    // against — that is why both come out of SHADOW_BASIS.
    this.axisX.copy(SHADOW_BASIS.x);
    this.axisY.copy(SHADOW_BASIS.y);
    this.axisZ.copy(SHADOW_BASIS.z);

    // The key is ONE light at full intensity. The second DirectionalLight below
    // is a shadow-only slave: three needs it to exist for its map to be rendered
    // and bound as `directionalShadowMap[1]`, but it contributes no energy and
    // `cascadeLightsChunk` skips its RE_Direct entirely. Nothing downstream can
    // ever see a step in key brightness at a cascade border again — and as a
    // side effect `ctx.sun.intensity` is finally the bible's 4.2, which is what
    // src/world/Water.ts scales its sun glitter by.
    this.sun = this.makeCascade(ctx, this.specs[0], shadows);
    this.sun.name = 'SunKeyNear';

    if (this.specs.length > 1) {
      this.sunFar = this.makeCascade(ctx, this.specs[1], true);
      this.sunFar.name = 'SunKeyFarShadowOnly';
    }

    // SH ambient projected from our own sky — strictly better than a hemisphere
    // light because it carries the azimuthal asymmetry (the side of an object
    // facing the sun's half of the sky picks up more skylight).
    this.probe = new THREE.LightProbe(
      this.model.projectSH(2048, PROBE_FILL_TINT), PROBE_INTENSITY);
    ctx.scene.add(this.probe);

    // The FILL. Cool, directional, from above and behind the sun's shoulder.
    // This and the key are the whole warm/cool axis of the frame; the bounce
    // below is a garnish and the IBL irradiance is a floor.
    //
    // Order matters: three sorts shadow casters to the front of the directional
    // array and is stable otherwise, so this and the bounce land after the
    // cascades and are picked up by the interior-occlusion test in
    // `cascadeLightsChunk`. Neither casts a shadow, and a light that casts
    // nothing has to be told where the walls are.
    this.skyFill = new THREE.DirectionalLight(SKY_FILL_COLOR, SKY_FILL_INTENSITY);
    this.skyFill.position.copy(SKY_FILL_DIRECTION).multiplyScalar(100);
    this.skyFill.castShadow = false;
    this.skyFill.name = 'SkyFill';
    ctx.scene.add(this.skyFill);
    ctx.scene.add(this.skyFill.target);

    // Warm bounce from the sand and stone below, tilted toward the sun's
    // azimuth because that is the ground actually receiving the key.
    this.bounce = new THREE.DirectionalLight(GROUND_BOUNCE_COLOR, BOUNCE_INTENSITY);
    this.bounce.position.set(this.sunDirection.x * 0.55, -1, this.sunDirection.z * 0.55)
      .normalize().multiplyScalar(100);
    this.bounce.castShadow = false;
    this.bounce.name = 'GroundBounce';
    ctx.scene.add(this.bounce);
    ctx.scene.add(this.bounce.target);

    // LATERAL bounce. The one above points straight up from under the world and
    // therefore cannot carry the transfer that this course is actually made of:
    // a sunlit facade into the shaded street, a sunlit cliff onto the road below
    // it, sunlit cobbles into the underside of an arch. All of those travel
    // sideways, and all of them travel FROM the sun's side of the world, which
    // is one more shadowless directional light aimed along the sun's own azimuth
    // and tipped fractionally below the horizontal. Coupled to the key with the
    // other fills, so it only ever appears in shade.
    //
    // MUST BE ADDED LAST: `cascadeLightsChunk` identifies the three fills by
    // their position at the tail of the directional array.
    this.lateralBounce =
      new THREE.DirectionalLight(GROUND_BOUNCE_COLOR, LATERAL_BOUNCE_INTENSITY);
    this.lateralBounce.position
      .set(this.sunDirection.x, LATERAL_BOUNCE_SLOPE, this.sunDirection.z)
      .normalize().multiplyScalar(100);
    this.lateralBounce.castShadow = false;
    this.lateralBounce.name = 'LateralBounce';
    ctx.scene.add(this.lateralBounce);
    ctx.scene.add(this.lateralBounce.target);
  }

  private makeCascade(ctx: Ctx, spec: CascadeSpec, shadows: boolean): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(SUN_LIGHT_COLOR, spec.intensity);
    light.position.copy(this.sunDirection).multiplyScalar(spec.distance);
    light.castShadow = shadows;

    if (shadows) {
      const s = light.shadow;
      s.mapSize.set(spec.mapSize, spec.mapSize);
      s.bias = spec.bias;
      s.normalBias = spec.normalBias;
      s.radius = spec.radius;
      const cam = s.camera;
      cam.left = -spec.extent; cam.right = spec.extent;
      cam.top = spec.extent; cam.bottom = -spec.extent;
      cam.near = 5;
      // Kept in lockstep with `shadowDepthRange`, which the receiver-plane bias
      // is quoted against. Change one and change the other.
      cam.far = spec.distance + spec.extent * 2 + 400;
      cam.updateProjectionMatrix();
      if (spec.interval > 1) s.autoUpdate = false;
    }

    ctx.scene.add(light);
    ctx.scene.add(light.target);
    this.cascades.push({
      light, extent: spec.extent, distance: spec.distance,
      mapSize: spec.mapSize, interval: spec.interval,
    });
    return light;
  }

  private buildEnvironment(ctx: Ctx): void {
    const renderer = ctx.renderer;
    if (!renderer) return;

    // 512 on High+: with the environment now at full authored intensity the
    // chrome actually resolves what it is reflecting, and a 256 face put the
    // sun disc (0.019 rad) on about three texels. One-time bake, no frame cost.
    const cubeSize = ctx.settings.quality >= Quality.High ? 512 : 256;

    if (this.cubeRT && this.cubeRT.width !== cubeSize) {
      this.cubeRT.dispose();
      this.cubeRT = null;
    }

    if (!this.cubeRT) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.cubeRT.texture.name = 'SkyCube';
    }

    // 0.1/10 near-far: the dome ignores them entirely, it sits on the far plane.
    const cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    // A composer-driven pipeline usually turns autoClear off; the cube faces
    // need a defined depth buffer, so force it for the duration of the bake.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    cubeCam.update(renderer, this.envScene);
    renderer.autoClear = prevAutoClear;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromCubemap(this.cubeRT.texture, this.envRT ?? null);
    pmrem.dispose();
    this.envRT = rt;

    this.envMap = rt.texture;
    ctx.envMap = rt.texture;
    ctx.scene.environment = rt.texture;
    ctx.scene.environmentIntensity = ENV_INTENSITY;
  }

  /**
   * Re-render the sky into the environment map. Costs a 6-face render plus a
   * PMREM chain, so it is never called from the frame loop — only if something
   * genuinely changes the sky (a quality switch, a retune).
   */
  refreshEnvironment(ctx: Ctx): void {
    this.buildEnvironment(ctx);
  }

  // -- frame ------------------------------------------------------------------

  update(ctx: Ctx, _dt: number): void {
    if (!this.interiorInstalled) {
      this.interiorInstalled = true;
      const volume = this.buildInteriorVolume(ctx);
      if (volume !== null) {
        this.installShaderPatches(volume);
        // Nothing has rendered yet, so nothing has compiled and this sweep is a
        // no-op — but it is the difference between "correct" and "correct as
        // long as no one warms a shader during init".
        ctx.scene.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) for (const m of mat) m.needsUpdate = true;
          else if (mat) mat.needsUpdate = true;
        });
      } else {
        console.warn('[sky] track unavailable; tunnel interior will not be occluded');
      }
    }

    const u = this.material.uniforms;
    u.uTime.value = ctx.time;
    // True translational parallax between the cloud planes as the kart moves —
    // the low deck slides past the high cirrus exactly as it should.
    (u.uCameraXZ.value as THREE.Vector2).set(ctx.camera.position.x, ctx.camera.position.z);
  }

  lateUpdate(ctx: Ctx, _dt: number): void {
    // Follow the player when there is one, the camera before the race exists.
    const player = ctx.race?.player;
    _camDir.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _fwd.set(_camDir.x, 0, _camDir.z);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1); else _fwd.normalize();

    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      if (!c.light.castShadow) continue;
      if (c.interval > 1) {
        if (this.frame % c.interval !== 0) continue;
        c.light.shadow.needsUpdate = true;
      }
      if (player) _center.copy(player.position); else _center.copy(ctx.camera.position);
      // Bias the frustum ahead of the action: half of a cascade spent behind
      // the player is half a cascade wasted.
      _center.addScaledVector(_fwd, c.extent * 0.45);
      this.snapCascade(c, _center);
    }

    this.updateSunScreen(ctx.camera);
    if (this.frame === 1) this.checkCascadeOrder(ctx);
    this.frame++;
  }

  /**
   * `krCascadeShadow` reads `directionalShadowMap[0]` as the near cascade and
   * `[1]` as the far one. Three fills those arrays in scene-traversal order, and
   * Sky adds the near light first and is the only thing in the game that creates
   * a DirectionalLight — but that is an invariant, not a guarantee, so say so
   * out loud the moment anything else joins the list. Runs once, on frame 1,
   * after every system has finished building.
   */
  private checkCascadeOrder(ctx: Ctx): void {
    const lights: THREE.DirectionalLight[] = [];
    ctx.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight) lights.push(l);
    });

    if (this.cascades.length >= 2) {
      const ok = lights[0] === this.sun && lights[1] === this.sunFar
        && !lights.slice(2).some((l) => l.castShadow);
      if (!ok) {
        console.warn('[sky] directional light order changed. krCascadeShadow reads ' +
          'directionalShadowMap[0] as the near cascade and [1] as the far one, and three ' +
          'fills that array in scene-traversal order with shadow casters first. Shadows ' +
          'will be wrong until the new light is added after Sky\'s two.');
      }
    }

    // The fill coupling in `cascadeLightsChunk` identifies the cool fill and the
    // two bounces as the LAST THREE entries of the directional array. Anything
    // else joining the list silently steals one of those slots and the key/fill
    // separation on the road goes with it, so say so out loud.
    const tail = lights.slice(-3);
    if (lights.length < 3 || tail[0] !== this.skyFill || tail[1] !== this.bounce
      || tail[2] !== this.lateralBounce) {
      console.warn('[sky] the three shadowless fills are no longer the last three ' +
        'DirectionalLights in the scene. FILL_KEY_COUPLING is keyed on ' +
        'UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHTS - 3 and is now coupling the wrong light; ' +
        'add new directional lights before Sky\'s, or widen the test.');
    }
  }

  /**
   * Quantise the cascade centre to whole shadow texels in light space. Without
   * this the shadow map resamples the world at a slightly different offset each
   * frame and every shadow edge boils. Mandatory, not an optimisation.
   */
  private snapCascade(c: Cascade, center: THREE.Vector3): void {
    const texel = (2 * c.extent) / c.mapSize;
    const px = Math.round(center.dot(this.axisX) / texel) * texel;
    const py = Math.round(center.dot(this.axisY) / texel) * texel;
    const pz = center.dot(this.axisZ);
    _snapped.set(0, 0, 0)
      .addScaledVector(this.axisX, px)
      .addScaledVector(this.axisY, py)
      .addScaledVector(this.axisZ, pz);
    c.light.target.position.copy(_snapped);
    c.light.position.copy(_snapped).addScaledVector(this.sunDirection, c.distance);
    c.light.target.updateMatrixWorld();
    c.light.updateMatrixWorld();
  }

  /**
   * Where the sun lands on screen, for light shafts and lens effects.
   * Cheap enough that the post stack can call it again with a fresher camera.
   */
  projectSunToScreen(camera: THREE.PerspectiveCamera, out: THREE.Vector2): boolean {
    _camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = _camDir.dot(this.sunDirection);
    if (facing <= 0) {
      out.set(0.5, 0.5);
      return false;
    }
    // A point well inside the far plane along the sun ray projects to the same
    // screen position as the disc itself, without the w-flip of a point at
    // infinity behind the eye.
    _proj.copy(camera.position).addScaledVector(this.sunDirection, 1500).project(camera);
    out.set(_proj.x * 0.5 + 0.5, _proj.y * 0.5 + 0.5);
    return true;
  }

  private updateSunScreen(camera: THREE.PerspectiveCamera): void {
    this.sunVisible = this.projectSunToScreen(camera, this.sunScreenPosition);
    if (!this.sunVisible) {
      this.sunScreenIntensity = 0;
      return;
    }
    _camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = _camDir.dot(this.sunDirection);
    const edge = Math.max(
      Math.abs(this.sunScreenPosition.x - 0.5),
      Math.abs(this.sunScreenPosition.y - 0.5),
    );
    // Fade as the disc leaves the frame so shafts cannot pop on and off.
    this.sunScreenIntensity = smoothstep(0.0, 0.25, facing) * (1 - smoothstep(0.45, 1.1, edge));
  }

  dispose(): void {
    if (_originalChunks !== null) {
      const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
      for (const name of PATCHED_CHUNKS) chunks[name] = _originalChunks[name];
      _originalChunks = null;
    }
    this.dome?.parent?.remove(this.dome);
    this.envScene?.remove(this.envMesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.lut?.dispose();
    this.noise?.dispose();
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    for (const c of this.cascades) {
      c.light.shadow?.dispose();
      c.light.parent?.remove(c.light);
    }
    this.cascades.length = 0;
    this.probe?.parent?.remove(this.probe);
    this.skyFill?.parent?.remove(this.skyFill);
    this.bounce?.parent?.remove(this.bounce);
    this.lateralBounce?.parent?.remove(this.lateralBounce);
  }
}
