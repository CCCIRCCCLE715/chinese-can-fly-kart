import * as THREE from 'three';
import {
  BASE_TOP_SPEED,
  SURFACE_PROPS,
  Surface,
  type Ctx,
  type IKart,
  type ITrack,
  type KartStats,
} from '../types';
import { buildKart } from './KartModel';
import { DEFAULT_SUSPENSION, Suspension } from './Suspension';
import { FRONT_TYRE, REAR_TYRE, makeTyreResult, solveTyre, type TyreResult } from './Tyre';

/**
 * ============================================================================
 *  Arcade kart physics.
 * ============================================================================
 *  A four-corner raycast-suspension chassis with a slip-angle tyre model,
 *  hop-and-slide drifting with three mini-turbo tiers, air control and tricks.
 *
 *  Degrees of freedom actually integrated:
 *    - world position (3) and linear velocity (3)
 *    - heading yaw (1) and yaw rate (1)
 *    - suspension roll and pitch (2), see Suspension.ts
 *  Chassis roll/pitch are deliberately NOT folded into `quaternion`: that stays
 *  the terrain-aligned heading frame so the chase camera and the AI get a
 *  stable reference. The lean, the dive and the squash go on the model's own
 *  `body` group so the wheels stay planted while the bodywork moves, and only
 *  a trick rotates the whole kart. Everything the player reads as "weight"
 *  lives in those two nodes.
 *
 *  The integrator runs at a fixed 120 Hz internally, substepped against the
 *  variable frame delta, and every force is clamped. Nothing in `step` or
 *  anything it calls allocates.
 * ============================================================================
 */

// --- global tuning -----------------------------------------------------------
/** Arcade gravity. Real g makes hops floaty and landings mushy. */
const GRAVITY = 20;
const BASE_MASS = 200;
const SUBSTEP = 1 / 120;
/**
 * Accumulator clamp. `step` clamps dt to 1/20 s first, so `ceil(dt / SUBSTEP)`
 * can never exceed 6 on its own — this is the belt to that braces, and it is
 * what stops a tab that has been backgrounded for ten seconds from trying to
 * catch up in one frame and stalling the main thread for a second. When it
 * bites, time dilates (the kart advances less than the wall clock says); it
 * never spirals.
 */
const MAX_SUBSTEPS = 6;

const KART_RADIUS = 0.86;
const WHEELBASE = DEFAULT_SUSPENSION.halfBase * 2;

/** peak steering angle at a standstill, radians */
const MAX_STEER = 0.55;
/**
 * How fast the virtual steering rack follows the stick, in units of input per
 * second. Loading the rack up is deliberately speed-scaled — full lock arriving
 * instantly at 28 m/s is twitch, not response — but UNLOADING it is not.
 *
 * That asymmetry is the whole of "the kart changes direction the instant I ask".
 * A symmetric 4.2/s rack has to travel the full 2.0 units of input to get from
 * hard left to hard right, which is 480 ms of the player holding a stick against
 * a kart that is still turning the other way; measured, the yaw rate took 367 ms
 * to reach 90% of its new value and essentially all of that was the rack. Making
 * only the unwind and the cross-over fast leaves the anti-twitch behaviour
 * exactly where it was — you still cannot slam into a corner — while a
 * direction change costs about a tenth of a second.
 */
const STEER_RATE_LOW = 10.5;
const STEER_RATE_HIGH = 5.6;
/** rate used when the rack is unwinding toward centre or crossing over */
const STEER_RATE_FREE = 15;

const MAX_DRIVE = 3000; // newtons at full throttle, before stat multipliers
const BRAKE_FORCE = 4200;
const REVERSE_FORCE = 1500;
const MAX_REVERSE = 8;
const ROLL_DRAG = 0.95; // m/s^2 of rolling resistance on clean road
const AERO_DRAG = 0.46; // newtons per (m/s)^2

const HOP_SPEED = 3.05;

/**
 * ============================================================================
 *  Which way the stick bends the slide
 * ============================================================================
 *  This pair of numbers was inverted, and it was the single biggest thing wrong
 *  with the game from the driver's seat.
 *
 *  The path a drifting kart takes is set by lateral force, not by slip angle:
 *  curvature is `F_lat / (m v^2)`. Both rear tyres are already well past their
 *  0.16 rad peak during a slide, so on the falling side of the curve MORE slip
 *  angle means LESS force means a WIDER line. The old constants gave the stick
 *  held into the corner the lowest rear grip (0.58) and the deepest slip target
 *  (0.44 rad) — so the one input a player reaches for to tighten up made the
 *  kart run wider, and holding it made it run wider still.
 *
 *  Measured over the six real corners of this circuit, entered at racing speed
 *  and driven by a line-following controller: the kart washed a median 10.75 m
 *  off the centreline, left the road in 6 of 6 corners, dropped from 22 m/s to
 *  as little as 3.6 m/s, and the slide then broke on its own after about a
 *  second — up on one wheel in the grass. Nobody could hold a tier-3 mini-turbo
 *  through that, and nothing about it is a tuning subtlety; the control was
 *  wired backwards.
 *
 *  So: stick INTO the corner now bites (0.90 of normal rear grip) and runs a
 *  shallower, tighter slide; stick OUT lets go (0.55) and lets the kart run
 *  wide. That is the Mario Kart contract, and it is the one players already
 *  have in their hands.
 * ============================================================================
 */
/**
 * Rear grip while sliding, from full outward lock to full inward.
 *
 * 0.98/0.60, not 0.9/0.55, and the reason is a measurement rather than a taste.
 * Total lateral capability is `(2*frontPeak + 2*rearPeak*mul) / 4`, so a drift
 * held with the stick centred used to corner at 0.85 of the four-wheel figure —
 * a 92 m corner became a 108 m one, and this circuit's corners are 65-110 m to
 * start with. Handed to the game's own AI, that extra width is fatal: it keeps
 * a metre of road under the outside wheels (`DRIFT_EDGE_KEEP` in AI.ts) and
 * abandons any slide that eats it. Traced over three laps, 47 drifts began and
 * 25 of them ended with no tier at all, nearly half of those inside 0.05 s —
 * engaged, washed toward the edge, dropped. Drift laps spent 7-11% of their
 * frames off the road against 0.0-0.4% for a clean lap.
 *
 * At 0.98 the stick held INTO the corner buys back essentially the whole
 * four-wheel figure, so a well-driven slide takes a line no wider than a clean
 * one — and with DRIFT_TURN_ASSIST on top of it, a tighter one. At 0.60 the
 * stick held out really does let go. That spread IS the skill in the mechanic:
 * the same corner is worth a tier-3 charge or a trip through the grass
 * depending on what the player does with their thumb.
 */
const DRIFT_REAR_GRIP_IN = 0.98;
const DRIFT_REAR_GRIP_OUT = 0.6;
/**
 * ============================================================================
 *  Seconds of held drift for blue / orange / purple
 * ============================================================================
 *  [0.55, 0.95, 1.9], from [0.6, 1.45, 2.5], and before that [0.9, 2.0, 3.2].
 *  The numbers are placed against a measured distribution rather than picked.
 *
 *  Traced over three laps with a button driven off a real steering trace, the
 *  charge banked by a slide before something ends it falls out like this:
 *
 *      < 0.3 : 3     < 0.9 : 4     < 1.5 : 1     < 2.5 : 0
 *      < 0.6 : 1     < 1.2 : 14    < 2.0 : 0     >= 3.5 : 4      (n = 28)
 *
 *  That fat cluster between 0.9 and 1.2 s is not a coincidence and it is worth
 *  understanding, because it is what sets the middle of the ladder. A slide
 *  reaches tier 1, the grace above stops applying the moment anything is
 *  banked, and the next dip of the button therefore cashes out — and the dips
 *  arrive about every half second. So 0.55 s of charge plus one gap is where an
 *  ordinary slide ends, and any tier-2 threshold above ~1.2 s is a rung nobody
 *  stands on.
 *
 *  0.95 s puts tier 2 just under that cluster, so the ordinary case banks
 *  orange instead of blue. 1.9 s is above everything the cluster reaches, so
 *  purple still costs an unbroken hold — the four attempts past 3.5 s are all
 *  slides held most of the way round the harbour sweep or the banked 180, which
 *  is exactly where purple is meant to live.
 *
 *  The circuit's four drift corners, driven at ~22 m/s and held throughout, are
 *  worth roughly: bridge & return 3.5 s, village esses 5.5 s, harbour sweep
 *  10 s, banked 180 11 s. So every corner can pay orange and the two long ones
 *  can pay purple — if you can keep it on the road for that long, which is the
 *  part that is actually hard. Held right through, a slide spends 11.6% of its
 *  frames with a wheel off the tarmac against 2.6% for a released one, and the
 *  clock stops out there.
 * ============================================================================
 */
const DRIFT_TIERS = [0.55, 0.95, 1.9];

/**
 * ============================================================================
 *  Seconds of grace on a charge that banked NOTHING
 * ============================================================================
 *  The thresholds above are only reachable if the slide that is charging them
 *  survives, and measured on a real lap it mostly did not. Three laps with the
 *  button held through every corner: 83 slides, and 73 of them — 88% — ended
 *  with the charge clock still short of tier 1, at a median of 0.45 s against
 *  the 0.6 s tier 1 asks for. Tier 3 was never reached at all. So the ladder
 *  that is supposed to carry the whole loop had one working rung, and the lap
 *  time it was winning came almost entirely from the slide cornering faster
 *  rather than from any mini-turbo.
 *
 *  The reason is that a slide used to be all-or-nothing across a blink of the
 *  button. `bail` fires the instant `wantDrift` goes false, and both a human
 *  thumb and the racing line let go constantly: a corner that needs a moment of
 *  straightening in the middle, a chicane that switches hands, a bump taken
 *  off the throttle. Every one of those threw away the whole charge and started
 *  from zero, so what the player was actually being asked for was not "hold an
 *  angle through the corner" but "never once release, from entry to exit".
 *
 *  So a charge that paid out nothing is kept for this long, and a slide
 *  re-engaged inside the window resumes it instead of restarting. Note the
 *  three things this deliberately does NOT do:
 *
 *    - It never applies once a tier is banked. `releaseDrift` has already fired
 *      the boost by then, and carrying the clock as well would pay twice.
 *      Tier 2 and tier 3 still demand one unbroken hold, which is what keeps
 *      the top of the ladder an actual test.
 *    - It never survives `forfeitDrift`. Putting the whole kart off the road
 *      still evaporates everything, so the greedy line keeps its downside.
 *    - It never survives a respawn, a spin-out or a squash.
 *
 *  0.8 s, not 0.4, and the number comes from measuring the gaps rather than
 *  guessing at them. Instrumented over three laps with the button driven off a
 *  real steering trace, a slide ends and the button comes back down after a
 *  median of 0.28 s, and the distribution is:
 *
 *      < 0.15 s : 26      < 0.5 s :  5      < 1.5 s :  0
 *      < 0.30 s : 10      < 0.8 s : 23      >= 1.5 s : 8   (n = 72)
 *
 *  The eight long ones are the genuine corner exits; everything below 0.8 s is
 *  a dip inside a corner. At 0.4 s the window covered a little over half of
 *  them and the other half started the corner again from zero.
 *
 *  It still cannot bridge two corners. Sunset Bay's corner regions, taken as
 *  the runs of centreline curvature above 0.005 1/m, are separated by 82 m,
 *  166 m and 349 m of straight — 3.3 s, 6 s and 13 s at racing speed. The one
 *  6 m gap in the list is the middle of the village-climb esses, which is one
 *  corner complex and is exactly what the window exists to hold together.
 *
 *  Re-measured over the same three laps (`node tools/drift-bench.mjs`), three
 *  runs each side, quoted as ranges because the rig has its own spread — its
 *  null control, two byte-identical arms, sits at 0.25%:
 *
 *                          before          after
 *      released at tier 0    83-88%          64-66%
 *      released at tier 1     8-13 of ~80    21-24 of ~68
 *      released at tier 2     1-2             3-5
 *      lap advantage          2.6-4.0%        4.4-4.7%
 *
 *  The histogram is the honest number here, not the lap time: the lap time
 *  moved partly because the slide itself corners faster, and that was already
 *  true before this window existed. What this window changed is that a majority
 *  of slides used to pay NOTHING and now most of them pay something.
 *
 *  The advantage also stops being one corner. The banked curve was carrying
 *  56% of the entire gain; the village climb — a corner that needs a moment of
 *  straight in the middle, and so used to bank nothing at all — goes from
 *  -0.15 s to -0.92/-1.25 s and now roughly matches it.
 *
 *  Tier 3 is still not reached on a lap. That is not this window failing to
 *  fire — it is the circuit: purple wants 2.85 s of unbroken slide (measured by
 *  the bench's ladder test, which does reach it), and no single corner on
 *  Sunset Bay is that long. Purple stays a stretch goal rather than a rung of
 *  the normal ladder, and widening the window until two corners chain into one
 *  would be the wrong fix — it would pay for letting go, not for holding on.
 * ============================================================================
 */
const DRIFT_CARRY_TIME = 0.8;

/**
 * ============================================================================
 *  A release that would pay NOTHING is not a release yet
 * ============================================================================
 *  `DRIFT_CARRY_TIME` above preserves the CLOCK across a dip. It does not
 *  preserve the SLIDE: `driftDir` still drops to zero, so getting the charge
 *  back costs a fresh hop, a fresh steering threshold and a fresh spark, and
 *  the chassis spends the gap gripping rather than sliding. Measured, that is
 *  most of why the window under-delivered — of 45 slides that ended with
 *  nothing banked, only 17 managed to resume at all, even though 36 of the gaps
 *  were inside the old window.
 *
 *  So the button is debounced at the one point where debouncing is free. While
 *  the charge clock is still short of tier 1 there is, by definition, nothing
 *  to pay out, so letting go and pressing again inside this window is
 *  indistinguishable from never having let go — the slide simply continues.
 *
 *  Three things this deliberately does NOT do:
 *
 *    - It never delays a payout. The instant `driftTier` is 1 or more, letting
 *      go fires the mini-turbo on that frame, with no grace at all. The whole
 *      value of the release is that it is immediate, and a debounce on the one
 *      input the player is timing would be a far worse bug than the one being
 *      fixed.
 *    - It never overrides an explicit escape. Swinging the stick past 0.6 of a
 *      lock AWAY from the drift is the player asking to straighten out, and it
 *      ends the slide on the frame it arrives.
 *    - It never overrides the other bail conditions. Stalling, a spin-out, a
 *      long flight or putting the whole kart off the road all still end the
 *      slide immediately, and `forfeitDrift` still takes everything with it.
 *
 *  0.3 s: long enough to cover the sub-0.3 s dips that are half the measured
 *  distribution, short enough that a kart whose driver has genuinely let go
 *  and centred the stick is gripping again within a third of a second.
 * ============================================================================
 */
const DRIFT_RELEASE_GRACE = 0.3;

/**
 * ============================================================================
 *  "Am I in a corner?" — and why it cannot be answered from the kart
 * ============================================================================
 *  Two of the rules below need to know whether the kart is going round
 *  something or down a straight, and the obvious tests all fail, because a
 *  drift SUSTAINS ITS OWN YAW. The slip controller's set-point is a slip angle,
 *  not a path: with the stick centred it commands whatever yaw rate builds
 *  0.13 rad of slip, the rear tyres then bend the path to match, and the result
 *  is a stable circle that satisfies every internal test for "still cornering"
 *  in the middle of the longest straight on the circuit. Measured with a yaw
 *  test in place, a button that chattered every couple of tenths held ONE slide
 *  for 35 s through the tunnel.
 *
 *  Steering input is no better: a deep drift is held on opposite lock, so
 *  "stick pointing into the corner" ends exactly the slides that are working.
 *
 *  So the answer comes from the road. The centreline's own curvature is
 *  sampled once per track into a 512-bin table — 3.1 m per bin — max-filtered
 *  over +-4 bins so that turn-in and track-out both read as part of the corner.
 *  Building it costs 512 `sample` calls at boot and the per-frame cost is one
 *  array index; nothing here allocates after the table exists. It is shared by
 *  every kart, keyed on the track object, so a rebuilt circuit rebuilds it.
 *
 *  Dumped over Sunset Bay, the profile separates cleanly into three bands and
 *  the window is placed in the gap between the second and the third:
 *
 *      harbour sweep     0.0091 - 0.0110      banked 180    0.0068 - 0.0155
 *      village esses     0.0093 - 0.0115      bridge/return 0.0044 - 0.0077
 *      ---- window ------------------------------------------------------
 *      cliff traverse    0.0026 - 0.0058      tunnel        0.0028 - 0.0031
 *      start straight    0.0012 - 0.0021      beach descent 0.0004 - 0.0034
 *
 *  Which is to say: four drift corners, and everything else is connective
 *  tissue. An earlier window at 0.0025-0.0045 put the tunnel and most of the
 *  cliff traverse INSIDE the corner set, and since this circuit is "never flat
 *  for more than 120 m" that was enough to keep a slide alive over half a lap.
 * ============================================================================
 */
const CORNER_BINS = 512;
/** below this, 222 m radius, nothing is a corner */
const CORNER_CURV_MIN = 0.0045;
/** at this, 143 m radius, it is a corner by any measure */
const CORNER_CURV_FULL = 0.007;
/** how long a held slide survives once it has left the corner, seconds */
const DRIFT_STRAIGHT_BAIL = 1.0;

let cornerTable: Float32Array | null = null;
let cornerTableFor: ITrack | null = null;

function buildCornerTable(track: ITrack) {
  const n = CORNER_BINS;
  const tan = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = track.sample(i / n);
    tan[i * 3] = s.tangent.x;
    tan[i * 3 + 1] = s.tangent.y;
    tan[i * 3 + 2] = s.tangent.z;
  }
  const ds = Math.max(1e-3, track.length / n);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = ((i + 1) % n) * 3;
    const i3 = i * 3;
    // |a x b| is sin(angle) between two unit tangents, which for the angles a
    // road turns through in three metres is the angle. acos(a.b) would be the
    // same number computed where acos is at its least accurate.
    const cx = tan[i3 + 1] * tan[j + 2] - tan[i3 + 2] * tan[j + 1];
    const cy = tan[i3 + 2] * tan[j] - tan[i3] * tan[j + 2];
    const cz = tan[i3] * tan[j + 1] - tan[i3 + 1] * tan[j];
    raw[i] = Math.sqrt(cx * cx + cy * cy + cz * cz) / ds;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = -4; k <= 4; k++) {
      const v = raw[(i + k + n) % n];
      if (v > m) m = v;
    }
    out[i] = m;
  }
  cornerTable = out;
  cornerTableFor = track;
}

/** 0 on a straight, 1 in a corner, ramped across the window between. */
function cornerFactor(track: ITrack, t: number): number {
  if (cornerTableFor !== track || !cornerTable) buildCornerTable(track);
  const tbl = cornerTable!;
  const n = tbl.length;
  let i = Math.floor((t - Math.floor(t)) * n);
  if (i < 0) i = 0; else if (i >= n) i = n - 1;
  return clamp((tbl[i] - CORNER_CURV_MIN) / (CORNER_CURV_FULL - CORNER_CURV_MIN), 0, 1);
}

/** Tier banked by `t` seconds on the charge clock. */
function tierFor(t: number) {
  return t >= DRIFT_TIERS[2] ? 3 : t >= DRIFT_TIERS[1] ? 2 : t >= DRIFT_TIERS[0] ? 1 : 0;
}

/** 0..1 progress from the tier `t` has banked toward the next one. */
function chargeFor(t: number) {
  const tier = tierFor(t);
  if (tier >= 3) return 1;
  const lo = tier === 0 ? 0 : DRIFT_TIERS[tier - 1];
  const hi = DRIFT_TIERS[tier];
  return clamp((t - lo) / Math.max(0.01, hi - lo), 0, 1);
}

/**
 * ============================================================================
 *  What a mini-turbo is WORTH
 * ============================================================================
 *  Measured, not guessed. Place the kart on the straightest 180 m of the
 *  circuit at its drag-limited cruise (30.3 m/s), fire one boost of each tier
 *  through `applyBoost` — the same call `releaseDrift` makes — and time 160 m
 *  against a run that fires none. The old table paid:
 *
 *      tier 1  +0.10 s      tier 2  +0.26 s      tier 3  +0.76 s
 *
 *  and a bare drift hop, taken on the same straight with the wheel centred,
 *  costs 0.02 s. So the hop was never the problem: the PAYOUT was. A tier-1
 *  mini-turbo asks for about a second of sliding and returned a tenth of a
 *  second, which is less than a second of sliding costs by any measure. On the
 *  headline test — the game's own AI driving a lap with the drift button forced
 *  off, against the same driver with it left alone — the drifting lap was 2.6 s
 *  SLOWER, and not one drift in three laps ever reached tier 2.
 *
 *  Re-scaled. Re-measured on the same 160 m with the same baseline (5.24 s
 *  against the old table's 5.22 s, i.e. the same piece of road), the table now
 *  pays:
 *
 *      tier 1  +0.21 s      tier 2  +0.49 s      tier 3  +0.91 s
 *      peak     35.5 m/s     peak     38.4 m/s    peak     41.1 m/s
 *              (128 km/h)            (138 km/h)           (148 km/h)
 *
 *  The gradient stays steep on purpose — tier 3 is worth four and a half tier
 *  1s — so holding on is always the greedy play and always the risky one. Most
 *  of the increase is duration rather than strength, because duration is what
 *  the player reads as "this is still going" halfway down the next straight,
 *  and because a ceiling much past 40 m/s starts to outrun the corner the boost
 *  is being fired into.
 *
 *  Re-spread again once the ladder was made reachable, [1.25, 1.85, 2.6] ->
 *  [0.95, 1.8, 3.0], with strengths [1.15, 1.25, 1.34] -> [1.12, 1.25, 1.36].
 *  The reason is that a button that lets go and grabs again FARMS blues: with a
 *  reachable tier 1 the same three laps banked 19 of them, and 19 blues at the
 *  old table are worth more than the four purples they were collected instead
 *  of. Trimming the bottom rung and stretching the top takes tier 3 from 2.1x
 *  tier 1's duration to 3.2x, so a player choosing between "release now for a
 *  safe blue" and "hold another second" is choosing correctly when they hold.
 *  The strength column barely moves, deliberately: it sets the speed ceiling,
 *  and past ~41 m/s the boost simply arrives at the next corner too fast to use.
 * ============================================================================
 */
const DRIFT_BOOST_TIME = [0, 0.95, 1.8, 3.0];
const DRIFT_BOOST_STRENGTH = [1, 1.12, 1.25, 1.36];
/**
 * Stick deflection needed, during the hop, to turn it into a slide.
 *
 * 0.13, not 0.2. This circuit's corners are 65-110 m radius, which at 28 m/s
 * asks for about 0.06 of steering input in steady state — so a player who
 * steers only as much as the corner needs cannot start a drift at all, and has
 * to know to over-turn on entry. Swept across speed: at 0.15 of stick the old
 * threshold engaged 0 times out of 6, at 0.3 and above it engaged 18 out of 18.
 * The gap between "asking for the corner" and "asking for a drift" was the
 * whole of that range.
 *
 * It stays comfortably clear of zero, which is what keeps the entry from being
 * twitchy: with the wheel centred the button is a hop and a trick, never a
 * slide (0 accidental engagements out of 6 before and after).
 */
const DRIFT_ENGAGE_STEER = 0.13;
/**
 * How long a hop stays armed as a drift, seconds.
 *
 * 0.8, not 0.45. The hop is over in about 0.3 s and the old window closed
 * barely a tenth of a second after the kart landed, which means the player had
 * to be already turning when they pressed — press half a second before the
 * turn-in and you got a hop, a trick, and no slide. On the two short corners of
 * this circuit (44 m and 64 m of arc) that is exactly what happened: held down
 * from twelve metres before the corner, the button engaged nothing at all,
 * because the kart had not begun to turn while the window was open.
 *
 * Widening it does not make the entry vaguer — the direction test is unchanged
 * and still needs either a real deflection or a kart already visibly cornering
 * — it just stops the mechanic from being a timing puzzle laid on top of the
 * one it is meant to be.
 */
const DRIFT_ARM_TIME = 0.8;

/**
 * Slip angle the slide controller aims for, at full outward (counter-steer) and
 * full inward lock. Ordered so that counter-steering STRAIGHTENS the kart out:
 * the old pair ran the other way, and asking the controller for a deeper slide
 * at the exact moment the player is trying to escape one is how a drift becomes
 * a spin. Traced on the harbour sweep, the kart held 2.4 rad/s of yaw — a nine
 * metre corner radius at 23 m/s — for most of a second with the stick pinned at
 * full opposite lock, and put itself into the barrier.
 *
 * Roughly halved from [0.15, 0.34], and the reason is that the pose already
 * pays for the silhouette. `updateDriftPose` renders `beta - betaWanted`, the
 * SHORTFALL against an authored 19-30 degrees, so every radian the physics
 * produces is a radian the pose stops adding — the kart looks exactly as
 * sideways either way. What the physical slip does buy, on its own, is scrub:
 * the longitudinal component of the lateral tyre force is `a_lat * sin(beta)`,
 * which at 0.245 rad and 8 m/s^2 of cornering load is 2.0 m/s^2 of pure drag,
 * and it puts both rear tyres a long way down the falling side of their curve
 * where they return less force for it. Halving the angle halves the drag and
 * hands the rears back about 6% of their peak, for no change at all in what the
 * player sees. The angle the STICK controls — 0.06 against 0.20, better than
 * three to one — is what makes the slide feel steerable rather than merely
 * survivable.
 */
const DRIFT_SLIP_OUT = 0.06;
const DRIFT_SLIP_IN = 0.2;
/** how hard the controller closes the slip-angle error, 1/s */
const DRIFT_SLIP_GAIN = 2.6;
/**
 * Ceiling on the yaw rate a drift may command, as `k / speed` — i.e. a minimum
 * corner radius, since yaw rate times radius is speed. 26 puts it at 2.6 g,
 * a shade above the ~2.4 g the non-drifting Ackermann assist allows (that
 * margin is the crab), and it is the backstop that makes the slip controller
 * unable to spin the kart no matter what the slip-angle error does. A
 * proportional controller on a quantity whose own set-point moves with the
 * kart's cornering load needs one; without it the fixed point can sit anywhere.
 */
const DRIFT_MAX_YAW = 26;
/**
 * The stick's authority over the *line*, in m/s^2 of extra cornering pull
 * toward the inside at full inward lock (and of relief, pushing the kart wide,
 * at full outward lock).
 *
 * Grip alone is not a precise enough lever: it acts through two sliding tyres
 * on the falling side of their curve, so how much line it buys depends on the
 * slip angle it is simultaneously changing. This is the direct term, and it is
 * what makes the slide steerable rather than merely survivable. At 22 m/s,
 * 6 m/s^2 is the difference between a 60 m radius and a 40 m one — roughly the
 * width of this circuit's road, which is exactly the amount of adjustment a
 * player needs to make a corner tighten under them. Scaled by surface grip, so
 * a drift across grass does not get free cornering the tyres never earned.
 */
const DRIFT_TURN_ASSIST = 6.0;
const DRIFT_TURN_RELIEF = 2.2;

/**
 * ============================================================================
 *  The authored drift pose
 * ============================================================================
 *  Nintendo does not *simulate* the drift silhouette, it poses it. A shipped
 *  Mario Kart drift is 25-35 degrees of crab, eight to ten degrees of roll onto
 *  the outside springs and daylight under the inside wheels — held at that value
 *  for the whole slide, independent of what the tyres happen to be doing that
 *  frame. Round 1 proved why that separation matters: the drift state machine
 *  was charging all the way to tier 2 while the chassis tracked its velocity to
 *  within 0.7 degrees, so the shot had sparks, a boost and a HUD, and a kart
 *  driving in a straight line. Every readable thing about a drift lived on one
 *  number that the physics was free to lose.
 *
 *  So the pose is authored here and the physics slip angle is *credited against
 *  it* rather than being what produces it: the rendered yaw offset is
 *  `beta - betaWanted`, which collapses to zero exactly when the tyres deliver
 *  the whole angle on their own and grows to cover the shortfall when they do
 *  not. Physics stays the thing that decides where the kart goes; the pose only
 *  decides which way it is pointing while it goes there.
 *
 *  All of it lives on `visual` and `bodyNode`. `position`, `quaternion`,
 *  `forward` and `right` — everything the camera, the AI and the collision
 *  system read — are untouched, so a 30 degree crab cannot destabilise a chase
 *  camera or make an AI think it is aimed at the scenery.
 * ============================================================================
 */
/** rendered slip at drift entry, rad (19 deg) */
const DRIFT_POSE_BASE = 0.33;
/** added by mini-turbo charge, up to tier 3 (+11 deg => 30 deg) */
const DRIFT_POSE_TIER = 0.19;
/** added/removed by the stick, so tightening the line reads (+-3 deg) */
const DRIFT_POSE_LOCK = 0.05;
/** hard cap on the rendered yaw offset, rad (35 deg) */
const DRIFT_POSE_MAX = 0.62;
/** bodywork lean onto the outside springs, rad (8.6 deg) */
const DRIFT_BODY_ROLL = 0.15;
/** roll of the WHOLE kart, rad (3.4 deg) — this is what tilts the wheelbase */
const DRIFT_CHASSIS_ROLL = 0.06;
/** extra visual lock on the front wheels while sliding, rad (8 deg) */
const DRIFT_POSE_STEER = 0.14;
/**
 * Share of the inside corners' travel left uncompensated under the chassis roll.
 * The outside pair is held exactly on the road; the inside pair is deliberately
 * left short of it, which is where the inside-wheel daylight comes from.
 */
const POSE_WHEEL_LIFT = 0.45;
/** ground speed, m/s, at which the pose is fully engaged */
const POSE_SPEED_FULL = 9;

/**
 * Forward assist while sliding, m/s^2. A drift scrubs speed through lateral
 * tyre work, and over a long corner that costs essentially all of it.
 * Recovering most (not all) of the scrub leaves drifting a small, honest cost
 * that the mini-turbo repays — which is the whole risk/reward loop of the
 * mechanic.
 *
 * 3.0 rather than 3.6 because DRIFT_SLIP_* halved and the scrub halved with it;
 * left where it was, the assist would have over-repaid and made a slide FASTER
 * in a straight line than not sliding, which is how a kart racer turns into a
 * drift-spam simulator. The slide must still cost something. The mini-turbo is
 * where the player gets paid, not here.
 */
const DRIFT_THRUST = 3.0;

const AIR_STEER = 1.5; // rad/s of yaw authority with no wheels down
const TRICK_MIN_AIR = 0.3;

const WALL_RESTITUTION = 0.28;
const KART_RESTITUTION = 0.42;

/**
 * How far the bodywork may sink below its resting low point while leaning, in
 * metres, before the lean itself gets scaled back. Whatever is left inside this
 * budget is taken out by floating the shell, which at three centimetres reads
 * as suspension travel rather than as a kart on stilts. See `buildLeanHull`.
 */
const BODY_SINK_MAX = 0.03;
/** vertices above this height can never be the lowest point — skip them in the scan */
const LEAN_SCAN_Y = 0.45;
/**
 * Bodywork closer than this to the road at rest is interior detail, not shell.
 * KartModel's chrome group dips 36 mm *below* the contact plane on the left side
 * alone (a floor tray, inboard of the sills and hidden by the kart in every
 * frame). Letting a part that already lives inside the road set the lean limit
 * costs about three quarters of the lean and, because it is asymmetric, does it
 * only in left-hand drifts — a far worse artefact than the one being fixed.
 */
const LEAN_IGNORE_Y = 0.05;
const LEAN_SCAN_ROLL = 0.42;
const LEAN_SCAN_PITCH = 0.28;
const EMPTY_HULL = new Float32Array(0);

// --- module scratch — zero allocation in the hot path -------------------------
const _fwdFlat = new THREE.Vector3();
const _basisR = new THREE.Vector3();
const _basisF = new THREE.Vector3();
const _targetUp = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _wheelF = new THREE.Vector3();
const _wheelR = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _contactVel = new THREE.Vector3();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _planar = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _euler = new THREE.Euler();
const _lead = new THREE.Vector3();
const _leadPos = new THREE.Vector3();

/** Every live kart, so kart-vs-kart contacts resolve without a broadphase system. */
const ACTIVE: Kart[] = [];

/**
 * The slice of KartModel's DriverRig this module drives. Matched structurally
 * rather than imported so the character rig can be rebuilt without breaking
 * physics; a model that does not supply one simply gets the fallback path.
 * All pose channels are -1..1 (duck is 0..1), and the rig must be `update`d
 * every frame or it runs its own idle animation instead.
 */
interface DriverPoseRig {
  setPose(steer: number, lean: number, pitch: number, duck: number, apex: number): void;
  jolt(strength: number): void;
  update(dt: number): void;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function approach(cur: number, target: number, maxDelta: number) {
  const d = target - cur;
  return d > maxDelta ? cur + maxDelta : d < -maxDelta ? cur - maxDelta : target;
}
/** frame-rate independent exponential smoothing factor */
function smooth(rate: number, dt: number) {
  return 1 - Math.exp(-rate * dt);
}

export class Kart implements IKart {
  readonly object = new THREE.Group();
  /** child of `object`; carries the trick rotation only */
  readonly visual = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  /** unit right in world space — handy for VFX and the camera */
  readonly right = new THREE.Vector3(1, 0, 0);
  /** chassis up, slerped toward the ground normal */
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly wheels: THREE.Object3D[];

  forwardSpeed = 0;
  t = 0;
  lap = 0;
  place = 1;
  finished = false;
  raceDistance = 0;
  driftDir = 0;
  driftCharge = 0;
  driftTier = 0;
  boostTime = 0;
  airborne = false;
  stunTime = 0;
  starTime = 0;
  surface: Surface = Surface.Road;

  /** post-respawn / post-hit grace, seconds. Items may read this. */
  invulnTime = 0;
  /** 0..1 how hard the tyres are working — VFX reads it for smoke */
  tyreSlip = 0;
  /** lateral acceleration in body space, m/s^2 (+ = pushed right) */
  lateralAccel = 0;
  /**
   * 0..1 share of the kart's weight currently carried on something other than
   * tarmac. VFX should scale off-track dust with this rather than treating the
   * kart as wholly on or wholly off the road: two wheels on a verge is the
   * common case and it is worth half a dust plume, not none. See
   * `Suspension.worstSurface` for why the boolean version lies.
   */
  offRoadLoad = 0;

  readonly suspension = new Suspension(DEFAULT_SUSPENSION);

  private readonly tyre: TyreResult[] = [
    makeTyreResult(), makeTyreResult(), makeTyreResult(), makeTyreResult(),
  ];
  /** suspension corner index -> index into `wheels` */
  private readonly wheelMap = [0, 1, 2, 3];
  private readonly wheelRestY = [0.36, 0.36, 0.36, 0.36];

  private mass = BASE_MASS;
  /**
   * Yaw inertia, kg.m^2, as a coefficient on mass. A uniform box of this kart's
   * footprint (1.6 m x 1.32 m) works out at m * 0.36; the old 0.51 was 1.4x
   * that, i.e. the kart was being asked to rotate as though it were half again
   * as long as it looks. Every tyre's yaw torque divides by this, so it shows up
   * as lag on exactly the input the player is most sensitive to. 0.42 keeps a
   * little above the uniform-box figure — the driver and engine mass really do
   * sit at the ends — without paying for it in response.
   */
  private yawInertia = BASE_MASS * 0.42;
  private yaw = 0;
  private yawRate = 0;
  private steerInput = 0;
  private steerAngle = 0;
  private boostStrength = 1;
  private topSpeed = BASE_TOP_SPEED;

  // drift / hop / trick
  private wantDriftPrev = false;
  private hopTimer = 0;
  private driftTime = 0;
  /**
   * Charge stashed from a slide that ended with NOTHING banked, and the grace
   * left on it. See `DRIFT_CARRY_TIME`.
   */
  private driftCarry = 0;
  private driftCarryTime = 0;
  /**
   * Seconds left before a button that has come up actually ends the slide.
   * Only ever non-zero while nothing is banked. See `DRIFT_RELEASE_GRACE`.
   */
  private driftGrace = 0;
  /** seconds this slide has spent outside every corner. See `DRIFT_STRAIGHT_BAIL`. */
  private driftStraight = 0;
  private driftBeta = 0;
  private airTime = 0;
  private groundTime = 1;
  /** peak descent rate recorded while airborne, for the landing impact */
  private airDescent = 0;
  private trickArmed = false;
  private trickPhase = 0;
  private trickAxis = 0;

  // smoothed body accelerations, drive the roll/pitch springs and the driver
  private aLat = 0;
  private aLong = 0;
  /**
   * Lateral *specific force*, i.e. `aLat` without the centripetal term.
   *
   * `aLat` is the number a passenger feels pressed sideways by, and it is
   * deliberately the frozen-frame velocity change PLUS `yawRate * v` so that the
   * roll spring and the driver's lean read a corner as hard as it looks. That is
   * fine for feel and wrong for kinematics: the slip-angle identity the drift
   * controller is built on, `beta' = a/v - yawRate`, wants the plain specific
   * force, and feeding it the doubled one turns a proportional controller into
   * an integrator on the wrong variable. The fixed point stops being
   * `beta = target` and becomes `courseRate = gain * (target - beta)`, so beta
   * settles wherever the corner's own curvature puts it — which on a medium
   * radius is a fraction of a degree. That is round 1's drift shot: tier 2
   * charged, sparks lit, chassis dead straight. Keep the two apart.
   */
  private aLatPure = 0;

  // squash & stretch
  private squashTime = 0;
  private squashLen = 0.3;
  private spinDir = 1;

  // authored drift pose — see the DRIFT_POSE_* block above
  /** 0..1 how far the pose is ramped in; survives the release so it can decay */
  private posePhase = 0;
  /** drift direction latched for the decay, since driftDir clears on release */
  private poseDir = 0;
  // NOTE (public, deliberately not on IKart): the rendered yaw offset about the
  // chassis up axis, radians, + = nose swung toward `right`. `quaternion` is the
  // physics heading and does NOT contain this — that separation is the whole
  // point, it is what keeps the chase camera and the AI stable while the kart
  // crabs. Anything that places world-space geometry relative to a part of the
  // MODEL (drift sparks and their scorch decal at the rear contact patches, tyre
  // smoke, exhaust plumes) must rotate its body-space offset by this angle about
  // `up` before applying `quaternion`, or it will sit where the kart would have
  // been if it were not drifting — up to 0.4 m adrift of the wheel it is meant
  // to be coming off.
  driftPoseYaw = 0;
  /** whole-kart roll actually applied this frame, after the clearance contraction */
  private poseChassisRoll = 0;
  /** extra visual lock carried by the front wheel nodes, rad */
  private poseSteer = 0;

  // respawn bookkeeping
  private track: ITrack | null = null;
  private respawnPending = false;
  private lastGoodT = 0;
  private badSurfaceTime = 0;
  private collideCooldown = 0;
  private groundY = 0;

  /**
   * The part of the model that leans. KartModel keeps the wheels on the root
   * and the bodywork under a child called `body` precisely so the chassis can
   * roll without dragging the wheels off the road — rolling the whole model
   * would lift the inside pair into the air.
   */
  private bodyNode: THREE.Object3D;
  /** DriverRig from the model, duck-typed so Driver.ts can churn freely. */
  private driverRig: DriverPoseRig | null = null;

  // --- bodywork ground clearance ---------------------------------------------
  /**
   * The bodywork leans about the chassis origin, and that origin sits exactly on
   * the contact plane: the hardpoint is `restLength + wheelRadius -
   * restCompression` up the body axis and the spring holds it `restLength +
   * wheelRadius` above the ground, so at rest `position.y` IS the ground. Which
   * means every radian of body lean drives the outboard sill straight down into
   * the road. Measured against this model: 0.30 rad of roll costs 11 mm, but the
   * 0.36 rad of a drift plus the 0.22 rad of a dive costs 176 mm — most of a
   * wheel radius of bodywork buried in the surface. Round 1's drift shot is that
   * exactly, the rear valance sliced off flat by the verge.
   *
   * Rather than pick a smaller magic number and hope, the lean is bounded by the
   * model's own ground clearance. `leanHull` holds the handful of vertices that
   * can ever be the lowest point of the shell anywhere in the usable roll/pitch
   * envelope — in practice the floor pan, the two sill corners and the bumper
   * corners — so the per-frame test is a dozen multiplies rather than a scan of
   * five thousand vertices. Give the model more clearance and the lean widens on
   * its own; take clearance away and it tightens. Nothing to re-tune.
   */
  private leanHull = EMPTY_HULL;
  /** the contact plane expressed in the bodywork node's own frame */
  private leanFloor = 0;
  private bodyRestY = 0;
  /** true when the model gave us no separate bodywork group to float */
  private bodyIsRoot = false;

  // fallback rig, for a model that exposes plain named nodes instead
  private driver: THREE.Object3D | null = null;
  private driverHead: THREE.Object3D | null = null;
  private steeringWheel: THREE.Object3D | null = null;
  private driverRestZ = 0;
  private driverRestX = 0;
  private headRestY = 0;
  private wheelRestZ = 0;

  constructor(
    readonly id: number,
    /**
     * Not `readonly`: `Race.selectKart` moves this flag between two existing
     * karts when the player picks from the roster. `id` stays fixed because the
     * AI keys its driver/band/assist maps off it and projectiles record it as
     * an owner — reassigning ids would orphan all of that.
     */
    public isPlayer: boolean,
    readonly stats: KartStats,
  ) {
    const built = buildKart(stats);
    this.visual.add(built.root);
    this.object.add(this.visual);
    // Falls back to the whole model when it does not separate its bodywork.
    this.bodyNode = (built.root.userData?.body as THREE.Object3D) ??
      built.root.getObjectByName('body') ?? built.root;

    const src = built.wheels ?? [];
    const list: THREE.Object3D[] = [];
    for (let i = 0; i < 4; i++) list.push(src[i] ?? new THREE.Object3D());
    this.wheels = list;
    this.mapWheels(list);

    for (let i = 0; i < 4; i++) {
      const node = list[this.wheelMap[i]];
      // Steer must be applied before spin, otherwise the spin axis is the
      // chassis X rather than the steered hub axis and the front wheels wobble.
      node.rotation.order = 'YXZ';
      this.wheelRestY[i] = node.position.y || DEFAULT_SUSPENSION.wheelRadius;
      this.suspension.wheels[i].restY = this.wheelRestY[i];
    }

    this.findDriverRig(built.root);
    this.bodyIsRoot = this.bodyNode === built.root || this.bodyNode === this.visual;
    this.bodyRestY = this.bodyNode.position.y;
    this.buildLeanHull();

    this.mass = BASE_MASS * (stats.weightMul || 1);
    this.yawInertia = this.mass * 0.42;
    this.suspension.setMass(this.mass, GRAVITY);
    this.suspension.reset();

    ACTIVE.push(this);
  }

  // ---------------------------------------------------------------------------
  // construction helpers
  // ---------------------------------------------------------------------------

  /**
   * Match the model's wheel nodes to suspension corners by their rest position
   * rather than trusting declaration order, so a rebuilt kart model cannot
   * silently swap the steered axle to the back.
   */
  private mapWheels(list: THREE.Object3D[]) {
    const want = [
      [-1, 1], [1, 1], [-1, -1], [1, -1], // FL, FR, RL, RR as (sign x, sign z)
    ];
    const used = [false, false, false, false];
    let ok = true;
    for (let c = 0; c < 4; c++) {
      let found = -1;
      for (let i = 0; i < 4; i++) {
        if (used[i]) continue;
        const p = list[i].position;
        if (Math.sign(p.x || want[c][0]) === want[c][0] && Math.sign(p.z || want[c][1]) === want[c][1]) {
          found = i;
          break;
        }
      }
      if (found < 0) { ok = false; break; }
      used[found] = true;
      this.wheelMap[c] = found;
    }
    if (!ok) for (let i = 0; i < 4; i++) this.wheelMap[i] = i;
  }

  /**
   * The driver rig is optional and named by convention. Anything the kart model
   * exposes as `driver` / `head` / `steering` gets animated; if it exposes
   * none of them the kart simply drives without a leaning pilot.
   */
  private findDriverRig(root: THREE.Object3D) {
    const ud = root.userData || {};
    const rig = ud.driver;
    if (rig && typeof rig.setPose === 'function' && typeof rig.update === 'function') {
      this.driverRig = rig as DriverPoseRig;
      return;
    }
    const pick = (...names: string[]) => {
      for (const n of names) {
        const o = root.getObjectByName(n);
        if (o) return o;
      }
      return null;
    };
    this.driver = pick('driver', 'Driver', 'driverRig', 'pilot');
    this.driverHead = pick('head', 'Head', 'driverHead', 'helmet');
    this.steeringWheel = pick('steering', 'steeringWheel', 'wheel', 'Steering');
    if (this.driver) {
      this.driverRestZ = this.driver.rotation.z;
      this.driverRestX = this.driver.rotation.x;
    }
    if (this.driverHead) this.headRestY = this.driverHead.rotation.y;
    if (this.steeringWheel) this.wheelRestZ = this.steeringWheel.rotation.z;
  }

  /**
   * Reduce the bodywork to the few vertices that can ever be its lowest point
   * under lean. Runs once per kart at build time; allocation here is fine, the
   * per-frame path it feeds allocates nothing.
   *
   * The reduction is a support-function argument: for a fixed roll and pitch the
   * height of a vertex is a linear function of it, so the lowest vertex is a
   * corner of the convex hull and the set of winners over a bounded envelope of
   * angles is tiny. Sampling the envelope on a grid and keeping every winner
   * captures that set without having to build a hull.
   */
  private buildLeanHull() {
    const node = this.bodyNode;
    // The shell rotates about its own origin, which sits `bodyRestY` above the
    // chassis origin — and the chassis origin is the contact plane by
    // construction (see the field comment). So in this node's frame the road is
    // at -bodyRestY, and that, not the shell's resting low point, is what the
    // bodywork must not go under.
    this.leanFloor = -this.bodyRestY;
    node.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
    const local = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const pts: number[] = [];

    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
      const attr = mesh.geometry?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
      if (!attr) return;
      local.multiplyMatrices(inv, mesh.matrixWorld);
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(local);
        if (v.y > LEAN_SCAN_Y) continue; // above the hubs: never the low point
        if (v.y < this.leanFloor + LEAN_IGNORE_Y) continue; // interior, see above
        pts.push(v.x, v.y, v.z);
      }
    });

    if (pts.length === 0) {
      this.leanHull = EMPTY_HULL;
      return;
    }

    const keep = new Set<number>();
    const N = 9;
    for (let a = 0; a < N; a++) {
      const roll = LEAN_SCAN_ROLL * (-1 + (2 * a) / (N - 1));
      const sr = Math.sin(roll), cr = Math.cos(roll);
      for (let b = 0; b < N; b++) {
        const pitch = LEAN_SCAN_PITCH * (-1 + (2 * b) / (N - 1));
        const sp = Math.sin(pitch), cp = Math.cos(pitch);
        let lo = Infinity;
        let at = 0;
        for (let i = 0; i < pts.length; i += 3) {
          const y = -pts[i] * sr + (pts[i + 1] * cp - pts[i + 2] * sp) * cr;
          if (y < lo) { lo = y; at = i; }
        }
        keep.add(at);
      }
    }

    const hull = new Float32Array(keep.size * 3);
    let j = 0;
    for (const i of keep) {
      hull[j++] = pts[i];
      hull[j++] = pts[i + 1];
      hull[j++] = pts[i + 2];
    }
    this.leanHull = hull;
  }

  /**
   * Height of the lowest point of the bodywork for a given lean, in chassis
   * space — where y = 0 is the contact plane.
   *
   * `updateVisuals` poses the shell as (pitch, yaw, -roll) — order ZYX on the
   * bodywork and YZX on the outer group, which differ only in where the yaw
   * sits. Either way the yaw is a rotation about the up axis and cannot change
   * a height, so the row below (the no-yaw second row, shared by both orders) is
   * exact for both. Kept in sync with those calls by hand; there is no cheaper
   * way to ask three.js for one row.
   */
  private lowestBody(roll: number, pitch: number): number {
    const h = this.leanHull;
    if (h.length === 0) return 0;
    const sr = Math.sin(roll), cr = Math.cos(roll);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    let lo = Infinity;
    for (let i = 0; i < h.length; i += 3) {
      const y = -h[i] * sr + (h[i + 1] * cp - h[i + 2] * sp) * cr;
      if (y < lo) lo = y;
    }
    return lo;
  }

  /** Drop the authored drift pose without a transition. Teleports only. */
  private clearPose() {
    this.posePhase = 0;
    this.poseDir = 0;
    this.driftPoseYaw = 0;
    this.poseSteer = 0;
    this.poseChassisRoll = 0;
  }

  // ---------------------------------------------------------------------------
  // placement
  // ---------------------------------------------------------------------------

  placeAt(pos: THREE.Vector3, yaw: number, t: number) {
    this.position.copy(pos);
    this.yaw = yaw;
    this.yawRate = 0;
    this.velocity.set(0, 0, 0);
    this.up.set(0, 1, 0);
    this.t = t;
    this.lastGoodT = t;
    this.forwardSpeed = 0;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.aLat = this.aLong = this.aLatPure = 0;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.driftTier = 0;
    this.driftTime = 0;
    this.clearPose();
    this.boostTime = 0;
    this.boostStrength = 1;
    this.stunTime = 0;
    this.starTime = 0;
    this.invulnTime = 0;
    this.airborne = false;
    this.airTime = 0;
    this.groundTime = 1;
    this.hopTimer = 0;
    this.squashTime = 0;
    this.trickPhase = 0;
    this.trickArmed = false;
    this.offRoadLoad = 0;
    this.badSurfaceTime = 0;
    // Being *placed* satisfies any respawn that was still queued. Without this
    // a kart that had tripped `sanitize` and then been gridded by `formGrid`
    // spent the first frame of the countdown teleporting itself off its slot
    // and onto the centreline, because `doRespawn` was still pending and its
    // idea of "where you were" is the track sample, not the grid.
    this.respawnPending = false;
    this.suspension.reset();
    this.updateBasis(1);
    this.object.position.copy(this.position);
    this.object.quaternion.copy(this.quaternion);
    this.visual.rotation.set(0, 0, 0);
    this.visual.scale.set(1, 1, 1);
    this.applyWheelVisuals(0);
  }

  // ---------------------------------------------------------------------------
  // the frame step
  // ---------------------------------------------------------------------------

  /** steer -1..1, throttle 0..1, brake 0..1 */
  step(ctx: Ctx, dt: number, steer: number, throttle: number, brake: number, wantDrift: boolean) {
    this.track = ctx.track;
    // Eagerly, so the 512 samples land on the first frame of the countdown
    // rather than inside the first corner the player drifts. One reference
    // comparison per frame; see `buildCornerTable`.
    if (cornerTableFor !== ctx.track) buildCornerTable(ctx.track);
    if (this.respawnPending) this.doRespawn(ctx);
    if (!Number.isFinite(dt)) return;
    dt = clamp(dt, 1 / 480, 1 / 20);

    steer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
    throttle = Number.isFinite(throttle) ? clamp(throttle, 0, 1) : 0;
    brake = Number.isFinite(brake) ? clamp(brake, 0, 1) : 0;

    // --- timers -------------------------------------------------------------
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      if (this.boostTime <= 0) { this.boostTime = 0; this.boostStrength = 1; }
    }
    if (this.starTime > 0) this.starTime = Math.max(0, this.starTime - dt);
    if (this.invulnTime > 0) this.invulnTime = Math.max(0, this.invulnTime - dt);
    if (this.collideCooldown > 0) this.collideCooldown -= dt;
    if (this.squashTime > 0) this.squashTime = Math.max(0, this.squashTime - dt);
    if (this.hopTimer > 0) this.hopTimer -= dt;

    const stunned = this.stunTime > 0;
    if (stunned) {
      this.stunTime -= dt;
      steer = 0;
      throttle = 0;
      brake = 0;
      wantDrift = false;
    }

    // --- ground under the chassis centre ------------------------------------
    const probe = ctx.track.probe(this.position, this.t);
    if (Number.isFinite(probe.t)) this.t = probe.t;
    this.groundY = Number.isFinite(probe.y) ? probe.y : this.groundY;
    const centreSurface = probe.surface;

    // --- suspension probe ---------------------------------------------------
    // Once per frame, but aimed at where the chassis will be HALFWAY through it
    // rather than at where it starts. The ground plane each wheel gets is then
    // centred on the frame instead of trailing it, and the systematic error
    // vanishes to second order — which matters because that error scales with
    // dt and is therefore one of the few genuinely frame-rate dependent things
    // left in the model. At 30 fps and 28 m/s the old plane was most of a metre
    // stale by the last substep. The lead is capped so that driving at a cliff
    // edge cannot fit the plane to thin air.
    _lead.copy(this.velocity).multiplyScalar(dt * 0.5);
    const leadLen = _lead.length();
    if (leadLen > 0.8) _lead.multiplyScalar(0.8 / leadLen);
    _leadPos.copy(this.position).add(_lead);
    this.suspension.probeGround(ctx.track, _leadPos, this.quaternion, this.t);

    // --- fixed timestep integration -----------------------------------------
    // The steering rack and the drift state machine live INSIDE this loop, not
    // outside it. They are both integrators over player input — the rack ramps,
    // the mini-turbo clock counts, the hop window closes — and running them once
    // per frame while the chassis runs at 120 Hz is precisely what made a 30 fps
    // session and a 120 fps session take different corners. They cost no probes,
    // so the only price is a few multiplies per substep.
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = dt / n;
    // Contacts and the air/ground bookkeeping are inside the loop too. A wall
    // resolved once per frame is a wall the kart is allowed to be 1.4 m inside
    // of at 28 m/s on a 20 fps frame before anything pushes back, and the push
    // it then gets is a step change in velocity — which is why the open-loop
    // 30-vs-120 comparison used to agree to 0.75 m right up until the first
    // barrier and then never again. Resolving per substep bounds the penetration
    // by the substep, and makes the impulse land at the same point on the track
    // at every frame rate.
    for (let i = 0; i < n; i++) {
      this.updateSteerInput(h, steer);
      this.updateDriftState(ctx, h, wantDrift);
      this.substep(h, throttle, brake, stunned);
      this.collideWalls(ctx);
      this.collideKarts(ctx, h);
      this.updateAirborne(ctx, h);
    }
    const grounded = this.suspension.contacts > 0;

    // --- surface / progress / respawn watchdogs ------------------------------
    // Two different questions, and round 1 answered both with one number.
    //
    // `holding` is what is bearing the kart's weight: the right input for the
    // out-of-bounds watchdog, which must not fire because one wheel dangled over
    // a line. `surface` is what the kart is visibly interacting with, which is
    // what VFX, audio and the AI actually want — and the two diverge precisely
    // when the kart drops a pair of wheels off the kerb, because it then rolls
    // onto the pair still on tarmac and the heaviest-loaded wheel reports Road
    // while half the kart ploughs grass. That silence is the missing off-track
    // dust in the drift shot.
    const holding = grounded ? this.suspension.dominantSurface : centreSurface;
    this.surface = grounded ? this.suspension.worstSurface : centreSurface;
    this.offRoadLoad = grounded ? this.suspension.offRoadLoad : 0;
    // One wheel on the strip is a hit. The pad is 1-2 m wide and asking the
    // player to centre the most heavily loaded corner on it is not a skill test.
    if (grounded && this.suspension.boostContact) this.applyBoostPad(ctx);

    if (grounded && probe.edgeRatio < 1.25 && holding !== Surface.Water && holding !== Surface.OffTrack) {
      this.lastGoodT = this.t;
      this.badSurfaceTime = 0;
    } else if (holding === Surface.Water || holding === Surface.OffTrack) {
      this.badSurfaceTime += dt;
    }
    this.watchdog(ctx);

    // --- visuals ------------------------------------------------------------
    this.updateVisuals(dt);
  }

  // ---------------------------------------------------------------------------
  // integration
  // ---------------------------------------------------------------------------

  /**
   * Advance the virtual steering rack toward the stick.
   *
   * The input contract is `steer > 0 = the player wants to go RIGHT`, where
   * right means screen-right: `forward x up`, the same convention types.ts
   * declares for TrackSample.binormal.
   *
   * This chassis, though, is built on the opposite handedness. Heading is
   * `forward = (sin yaw, 0, cos yaw)`, so a rising yaw swings forward toward
   * +X — and with forward along +Z, `forward x up` is -X. Rising yaw is
   * therefore a turn to the LEFT, and every internal quantity derived from it
   * (steerAngle, yawRate, the tyre lateral axis, driftDir) inherits that.
   *
   * So the sign is inverted once, here at the boundary, and everything
   * downstream stays in the chassis' own left-positive frame. Flipping the
   * basis instead would be the tidier fix, but it would invert the lateral
   * term of the tyre solve and every yaw consumer along with it.
   */
  private updateSteerInput(h: number, steer: number) {
    const want = -steer;
    const cur = this.steerInput;
    // Loading up = pushing the rack further from centre on the side it is
    // already on. That is the only case the speed taper applies to; unwinding
    // and crossing over run at the free rate, so releasing the stick or
    // flicking the other way is immediate at any speed.
    const loading = want * cur >= 0 && Math.abs(want) > Math.abs(cur);
    const rate = loading
      ? THREE.MathUtils.lerp(
          STEER_RATE_LOW,
          STEER_RATE_HIGH,
          clamp(Math.abs(this.forwardSpeed) / Math.max(6, this.topSpeed), 0, 1),
        )
      : STEER_RATE_FREE;
    this.steerInput = approach(cur, want, rate * h);
  }

  /** Air/ground edge detection and the landing event. Runs per substep. */
  private updateAirborne(ctx: Ctx, h: number) {
    if (this.suspension.contacts > 0) {
      this.groundTime += h;
      if (this.airborne) this.onLanding(ctx);
      else this.airTime = 0;
    } else {
      this.airTime += h;
      this.groundTime = 0;
      // Debounced so a single wheel skipping over a kerb is not a jump.
      if (this.airTime > 0.06) this.airborne = true;
    }
  }

  private substep(h: number, throttle: number, brake: number, stunned: boolean) {
    const sus = this.suspension;
    this.updateBasis(h);

    const latBefore = this.velocity.dot(this.right);
    const fwdBefore = this.velocity.dot(this.forward);

    // --- suspension ---------------------------------------------------------
    if (sus.contacts === 0) {
      const descent = -this.velocity.dot(this.up);
      if (descent > this.airDescent) this.airDescent = descent;
    }
    const springF = sus.solve(h, this.position, this.quaternion, this.up, this.aLat, this.aLong, sus.contacts === 0);
    const grounded = sus.contacts > 0;
    this.velocity.addScaledVector(this.up, (springF / this.mass) * h);
    this.velocity.y -= GRAVITY * h;

    // Bump stop as a velocity constraint. A spring stiff enough to arrest a
    // 10 m/s landing inside 60 mm would need ~150 kN/m, which an explicit
    // integrator at 120 Hz cannot carry. Cancelling the approach velocity with
    // a little restitution is unconditionally stable and reads as the same
    // thing: a hard thunk followed by a rebound.
    if (sus.bottomDepth > 0) {
      const vUp = this.velocity.dot(this.up);
      if (vUp < 0) {
        const absorb = clamp(sus.bottomDepth / 0.05, 0, 1);
        this.velocity.addScaledVector(this.up, -vUp * 1.22 * absorb);
      }
    }

    // --- speed envelope -----------------------------------------------------
    const surfMax = grounded ? sus.maxSpeedMul : 1;
    const boosting = this.boostTime > 0;
    this.topSpeed =
      BASE_TOP_SPEED * this.stats.topSpeedMul * surfMax * (boosting ? this.boostStrength : 1) *
      (this.starTime > 0 ? 1.06 : 1);

    const vf = fwdBefore;
    this.forwardSpeed = vf;

    // --- engine / brakes ----------------------------------------------------
    let drive = 0;
    if (!stunned) {
      if (throttle > 0) {
        // Power fades toward the ceiling so top speed is an asymptote rather
        // than a wall, and boost raises the asymptote itself.
        // Tuned so that drive == drag exactly at the ceiling: the kart reaches
        // its rated top speed rather than asymptoting somewhere below it.
        const r = clamp(vf / Math.max(4, this.topSpeed), 0, 1);
        const curve = 1 - 0.8 * r * r * r;
        drive += MAX_DRIVE * this.stats.accelMul * throttle * curve * (boosting ? 1.7 : 1);
      }
      // A retarding force may never be large enough to reverse the direction of
      // travel within one step — that is how a brake turns into a catapult.
      const stopCap = (this.mass * Math.max(0, vf)) / h;
      if (brake > 0) {
        if (vf > 0.4) drive -= Math.min(BRAKE_FORCE * brake, stopCap);
        else if (throttle <= 0 && vf > -MAX_REVERSE) drive -= REVERSE_FORCE * brake;
      } else if (throttle <= 0 && !boosting && vf > 0.5) {
        // engine braking, so lifting off has a readable effect
        drive -= Math.min(400, stopCap);
      }
    }
    drive = clamp(drive, -MAX_DRIVE * 3, MAX_DRIVE * 3);

    // --- tyres --------------------------------------------------------------
    const drifting = this.driftDir !== 0 && grounded;
    const inward = drifting ? clamp(this.steerInput * this.driftDir, -1, 1) : 0;
    const rearGripMul = drifting
      ? THREE.MathUtils.lerp(DRIFT_REAR_GRIP_OUT, DRIFT_REAR_GRIP_IN, (inward + 1) * 0.5)
      : 1;

    // Front wheels carry a standing bias into the corner while drifting, and
    // the stick swings a full lock's worth around it. The old 0.55/0.50 split
    // could not reach zero, let alone the far side: at full opposite lock the
    // rack still sat at 0.05 INTO the drift, so the front tyres — crabbing at
    // fourteen degrees of slip and gripping perfectly well — went on hauling the
    // kart toward the apex no matter what the player did with the stick. That is
    // what a counter-steer is FOR, and it was the last piece of the drift the
    // player had no authority over. 0.45/0.95 keeps roughly the same neutral
    // bias, still saturates inward, and reaches half a lock of genuine opposite
    // lock at the other end.
    //
    // Full lock at 30 m/s would demand a corner radius no tyre could hold, so
    // the rack physically winds off with speed the way a real kart's does.
    const steerFalloff = 0.32 + 0.68 / (1 + Math.abs(vf) * 0.075);
    const rackTarget = MAX_STEER * this.stats.handlingMul * steerFalloff *
      (drifting ? clamp(this.driftDir * 0.45 + this.steerInput * 0.95, -1, 1) : this.steerInput);
    this.steerAngle += (rackTarget - this.steerAngle) * smooth(26, h);

    const cornerMass = this.mass * 0.3;
    const driveRear = drive > 0 ? drive * 0.5 : drive * 0.2;  // RWD accel, 4-wheel braking
    const driveFront = drive > 0 ? 0 : drive * 0.3;
    let slipMax = 0;

    for (let i = 0; i < 4; i++) {
      const w = sus.wheels[i];
      const res = this.tyre[i];
      if (!w.contact || w.load <= 0) {
        res.long = res.lat = 0;
        res.saturation = 0;
        res.sliding = false;
        w.slip = 0;
        // free-spin decay in the air, so wheels do not freeze mid-jump
        w.spinRate += (vf / DEFAULT_SUSPENSION.wheelRadius - w.spinRate) * smooth(2.5, h);
        continue;
      }

      // wheel axes, projected into the contact plane
      _wheelF.copy(this.forward);
      if (w.front && Math.abs(this.steerAngle) > 1e-4) _wheelF.applyAxisAngle(this.up, this.steerAngle);
      _wheelF.addScaledVector(w.groundNormal, -_wheelF.dot(w.groundNormal));
      if (_wheelF.lengthSq() < 1e-8) _wheelF.copy(this.forward);
      _wheelF.normalize();
      _wheelR.crossVectors(w.groundNormal, _wheelF);
      if (_wheelR.lengthSq() < 1e-8) _wheelR.copy(this.right);
      _wheelR.normalize();

      // velocity of the contact patch = chassis velocity + omega x r
      _arm.subVectors(w.contactPoint, this.position);
      _omega.copy(this.up).multiplyScalar(this.yawRate);
      _contactVel.crossVectors(_omega, _arm).add(this.velocity);

      const vLong = _contactVel.dot(_wheelF);
      const vLat = _contactVel.dot(_wheelR);

      let grip = SURFACE_PROPS[w.surface].gripMul;
      if (!w.front) grip *= rearGripMul;
      if (stunned) grip *= 0.45;
      if (this.starTime > 0) grip *= 1.05;

      const res2 = solveTyre(
        res,
        w.front ? FRONT_TYRE : REAR_TYRE,
        vLong,
        vLat,
        w.load,
        grip,
        w.front ? driveFront : driveRear,
        cornerMass,
        h,
      );

      _force.copy(_wheelF).multiplyScalar(res2.long).addScaledVector(_wheelR, res2.lat);
      const fmax = this.mass * 400;
      if (_force.lengthSq() > fmax * fmax) _force.setLength(fmax);

      this.velocity.addScaledVector(_force, h / this.mass);
      _torque.crossVectors(_arm, _force);
      this.yawRate += (this.up.dot(_torque) / this.yawInertia) * h;

      w.slip = res2.saturation;
      if (res2.saturation > slipMax) slipMax = res2.saturation;

      // Visual spin: rolling rate plus the slip that the tyre could not resist,
      // so a locked wheel drags and a spinning wheel over-rotates.
      const rolling = vLong / DEFAULT_SUSPENSION.wheelRadius;
      const slipSpin = (res2.long / Math.max(1, w.load)) * 4.5;
      w.spinRate += (rolling + slipSpin - w.spinRate) * smooth(18, h);
    }
    this.tyreSlip = slipMax;

    // --- boost thrust -------------------------------------------------------
    // The tyres alone cannot deliver a boost that feels violent, so a slice of
    // it is applied straight to the chassis while under the raised ceiling.
    if (boosting && grounded && vf < this.topSpeed) {
      const thrust = 10 * clamp((this.boostStrength - 1) / 0.3, 0, 1.3);
      this.velocity.addScaledVector(this.forward, thrust * h);
    }
    if (drifting && throttle > 0 && vf < this.topSpeed * 0.96) {
      this.velocity.addScaledVector(this.forward, DRIFT_THRUST * throttle * h);
    }

    // --- assists ------------------------------------------------------------
    if (grounded && !stunned) {
      const gripBlend = clamp(sus.gripMul, 0.3, 1.2);
      if (drifting) {
        // --- the stick's authority over the LINE ----------------------------
        // See DRIFT_TURN_ASSIST. `driftDir * right` is the inside of the
        // corner: driftDir is the sign of `steerInput`, which is left-positive
        // in this chassis' frame, and so is `right` — so a right-hand drift
        // (driftDir = -1) has its inside along `-right`, which is screen-right.
        // Both signs are wrong together or right together, which is the only
        // way to get this correct without a special case.
        const assist = inward >= 0 ? DRIFT_TURN_ASSIST * inward : DRIFT_TURN_RELIEF * inward;
        this.velocity.addScaledVector(this.right, this.driftDir * assist * gripBlend * h);

        // Slip-angle controller. The tyres still generate every force; this
        // only shapes how far the rear steps out.
        //
        // Signs matter enormously here. In a right-hand drift (driftDir = +1)
        // the nose leads the velocity, so the velocity lies to the kart's LEFT
        // and beta is NEGATIVE — hence the target carries the opposite sign to
        // driftDir. And since beta' = aLat/v - yawRate, raising the yaw rate
        // *deepens* the slide: steering the yaw rate proportionally to the
        // error rather than against it is positive feedback and spins the kart.
        // `aLatPure`, not `aLat`: the identity is only true for the plain
        // specific force, and the doubled one silently cancels the slide. See
        // the field comment — that single term is why round 1 drifted at 0.7
        // degrees while the tier counter ran to 2.
        const v = Math.max(6, Math.hypot(latBefore, fwdBefore));
        const beta = Math.atan2(latBefore, Math.max(2, Math.abs(fwdBefore)));
        const target = -this.driftDir *
          THREE.MathUtils.lerp(DRIFT_SLIP_OUT, DRIFT_SLIP_IN, (inward + 1) * 0.5);
        // Yaw rate that would hold beta steady, biased to close the error, and
        // then capped at a corner radius the kart could plausibly hold. The cap
        // is not cosmetic: the first term is the kart's own cornering load
        // divided by its speed, so the set-point rises with the very yaw rate it
        // is setting. Left open it walks itself up — measured at 2.4 rad/s while
        // the player held full opposite lock. See DRIFT_MAX_YAW.
        const yawCap = (DRIFT_MAX_YAW * gripBlend) / v;
        const slipYaw = clamp(
          this.aLatPure / v - clamp(target - beta, -0.45, 0.45) * DRIFT_SLIP_GAIN,
          -yawCap,
          yawCap,
        );

        // --- handing the yaw back as the player counter-steers ---------------
        // The slip controller regulates ONE thing: the angle between the nose
        // and the direction of travel. It is perfectly happy to hold a small,
        // tidy slip angle all the way round a fourteen metre radius, because its
        // first term is the kart's own cornering load and a crabbed kart makes
        // plenty of that. Traced on the cliff traverse — the narrowest section
        // of the circuit, six metres of half-width — the player held full
        // opposite lock for four tenths of a second and the kart went on turning
        // in at 1.6 rad/s and put itself over the edge.
        //
        // So as the stick swings out of the drift, the command is blended toward
        // what the steering rack alone would be asking for. The rack really is
        // counter-steered at that point, so its Ackermann rate is a genuine
        // unwind, and at full opposite lock the slide simply straightens out.
        // Squared, so the first half of the stick's travel is still all drift
        // and only the last of it is the escape hatch.
        const escape = clamp(-inward, 0, 1);
        const maxYaw = (24 * gripBlend) / Math.max(5, Math.abs(fwdBefore));
        const rackYaw = clamp((fwdBefore / WHEELBASE) * Math.tan(this.steerAngle), -maxYaw, maxYaw);
        const desired = THREE.MathUtils.lerp(slipYaw, rackYaw, escape * escape);

        this.yawRate += clamp(desired - this.yawRate, -2.5, 2.5) * 6 * h;
        // The four tyres apply their own yaw torque, and in a slide that torque
        // is the thing that would otherwise carry the kart past whatever the
        // stick asked for — the assist above only nudges. Clamp the overshoot,
        // but only in the direction of the drift: the tyres must stay free to
        // pull the kart straight, which is the recovery the player wants.
        const over = this.driftDir * (this.yawRate - desired);
        if (over > 0.35) this.yawRate = desired + this.driftDir * 0.35;
        this.driftBeta = beta;
      } else {
        // Understeer killer: bleed a little of the chassis' lateral velocity.
        // Small, but it is the difference between a kart and a barge.
        const bleed = clamp(2.4 * gripBlend * h, 0, 0.4);
        this.velocity.addScaledVector(this.right, -latBefore * bleed);
        // Steer toward the Ackermann yaw rate, but never past what the tyres
        // could actually hold — otherwise full lock at speed commands a corner
        // radius no amount of grip could produce and the kart pirouettes.
        const maxYaw = (24 * gripBlend) / Math.max(5, Math.abs(fwdBefore));
        const target = clamp((fwdBefore / WHEELBASE) * Math.tan(this.steerAngle), -maxYaw, maxYaw);
        // Gain 3.4, not 2.0. This term is what carries the nose through the
        // first tenth of a second of a turn, before the tyres have built a slip
        // angle to work with; at 2.0 its time constant was half a second, which
        // is longer than the whole corner entry the player is judging.
        this.yawRate += clamp(target - this.yawRate, -3, 3) * 3.4 * gripBlend * h;
      }
    } else if (!grounded && !stunned) {
      this.yawRate += (this.steerInput * AIR_STEER - this.yawRate) * smooth(3.2, h);
    }

    // Hard spin guard. An arcade kart may slide, but it must never pirouette
    // off a bad landing or a shove — recovery from a spin is not fun.
    if (!stunned) {
      const planarSpeed = Math.hypot(latBefore, fwdBefore);
      if (planarSpeed > 5) {
        const beta = Math.atan2(latBefore, Math.abs(fwdBefore));
        const limit = this.driftDir !== 0 ? 0.62 : 0.45;
        const excess = Math.abs(beta) - limit;
        // beta' = aLat/v - yawRate, so cutting the yaw rate closes the slide.
        if (excess > 0) this.yawRate += Math.sign(beta) * Math.min(excess, 0.8) * 45 * h;
      }
    } else {
      this.yawRate += (this.spinDir * 9 - this.yawRate) * smooth(9, h);
    }
    this.yawRate = clamp(this.yawRate, -7, 7);
    this.yawRate -= this.yawRate * clamp(1.1 * h, 0, 0.5);

    // --- drag ---------------------------------------------------------------
    _planar.copy(this.velocity);
    if (grounded) _planar.addScaledVector(this.up, -_planar.dot(this.up));
    const sp = _planar.length();
    if (sp > 1e-4) {
      const dragMul = grounded ? sus.dragMul : 1;
      const rolling = grounded ? ROLL_DRAG * this.mass * dragMul : 0;
      const aero = AERO_DRAG * sp * sp * (boosting ? 0.55 : 1);
      const dv = Math.min(sp, ((rolling + aero) / this.mass) * h);
      this.velocity.addScaledVector(_planar, -dv / sp);
    }

    // --- ceiling ------------------------------------------------------------
    const vfNow = this.velocity.dot(this.forward);
    if (vfNow > this.topSpeed) {
      this.velocity.addScaledVector(this.forward, (this.topSpeed - vfNow) * Math.min(1, 4 * h));
    } else if (vfNow < -MAX_REVERSE) {
      this.velocity.addScaledVector(this.forward, (-MAX_REVERSE - vfNow) * Math.min(1, 6 * h));
    }

    // --- integrate ----------------------------------------------------------
    this.yaw += this.yawRate * h;
    this.position.addScaledVector(this.velocity, h);

    // --- body accelerations, for roll/pitch and the driver rig ---------------
    const latNow = this.velocity.dot(this.right);
    const fwdNow = this.velocity.dot(this.forward);
    // `this.right` is still the basis this substep started with — updateBasis
    // does not run again until the next one — so this difference is already the
    // lateral specific force. `aLat` adds the centripetal term on top of it on
    // purpose (see the field comment); `aLatPure` is the one the kinematics use.
    const aLatSpecific = (latNow - latBefore) / h;
    const aLatRaw = aLatSpecific + this.yawRate * fwdNow;
    const aLongRaw = (fwdNow - fwdBefore) / h - this.yawRate * latNow;
    // Clamped well beyond any achievable cornering load but far short of what
    // a momentary spin would produce, so the roll spring can never saturate.
    const k = smooth(24, h);
    this.aLatPure += (clamp(aLatSpecific, -45, 45) - this.aLatPure) * k;
    this.aLat += (clamp(aLatRaw, -45, 45) - this.aLat) * k;
    this.aLong += (clamp(aLongRaw, -45, 45) - this.aLong) * k;
    this.lateralAccel = this.aLat;
    this.forwardSpeed = fwdNow;

    this.sanitize();
  }

  /** Rebuild the terrain-aligned heading frame. */
  private updateBasis(h: number) {
    const sus = this.suspension;
    if (sus.contacts > 0) {
      _targetUp.copy(sus.groundNormal);
    } else {
      _targetUp.set(0, 1, 0);
    }
    const rate = sus.contacts > 0 ? 15 : 3.2;
    this.up.lerp(_targetUp, smooth(rate, h));
    // Written as negated ">" tests rather than "<" tests so that a NaN takes
    // the reset branch. `sanitize` guards position, velocity and yaw but not
    // this vector, and every comparison against NaN is false — so the old
    // `up.y < 0.15` form waved a NaN straight through into `makeBasis`, and
    // from there into `quaternion`, where it is permanent: the kart's transform
    // is non-finite for the rest of the race and nothing downstream can tell.
    if (!(this.up.lengthSq() > 1e-6) || !(this.up.y > 0.15)) this.up.set(0, 1, 0);
    this.up.normalize();

    _fwdFlat.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _basisR.crossVectors(this.up, _fwdFlat);
    if (_basisR.lengthSq() < 1e-8) _basisR.set(1, 0, 0);
    _basisR.normalize();
    _basisF.crossVectors(_basisR, this.up).normalize();
    this.right.copy(_basisR);
    this.forward.copy(_basisF);
    _mat.makeBasis(_basisR, this.up, _basisF);
    this.quaternion.setFromRotationMatrix(_mat);
  }

  /** Last line of defence: a single NaN would take the whole scene with it. */
  private sanitize() {
    if (
      Number.isFinite(this.position.x) && Number.isFinite(this.position.y) && Number.isFinite(this.position.z) &&
      Number.isFinite(this.velocity.x) && Number.isFinite(this.velocity.y) && Number.isFinite(this.velocity.z) &&
      Number.isFinite(this.yaw) && Number.isFinite(this.yawRate)
    ) return;
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    if (!Number.isFinite(this.yaw)) this.yaw = 0;
    this.respawnPending = true;
  }

  // ---------------------------------------------------------------------------
  // drift, hop and tricks
  // ---------------------------------------------------------------------------

  private updateDriftState(ctx: Ctx, dt: number, wantDrift: boolean) {
    const pressed = wantDrift && !this.wantDriftPrev;
    this.wantDriftPrev = wantDrift;
    const grounded = this.suspension.contacts > 0;
    // Ground speed, not forward speed: deep in a slide the forward projection
    // collapses, and a drift must not cancel itself just because it is working.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (pressed) {
      if (grounded && this.stunTime <= 0 && speed > 4 && this.driftDir === 0) {
        // A real impulse — the chassis genuinely leaves the ground, the springs
        // extend, contact is lost for ~0.2 s and it lands with a thump. The
        // airborne flag is deliberately left to the contact test to raise.
        this.velocity.addScaledVector(this.up, HOP_SPEED);
        this.hopTimer = DRIFT_ARM_TIME;
        this.airDescent = 0;
        ctx.bus.emit({ type: 'hop', kart: this });
      }
    }

    // Tricks arm on the button being HELD, not on its rising edge: players
    // stab the button as they hit the ramp, and demanding a fresh press once
    // already airborne would silently eat most attempts.
    if (wantDrift && !grounded && this.airTime > 0.12 && !this.trickArmed && this.driftDir === 0) {
      this.trickArmed = true;
      this.trickPhase = 0.0001;
      this.trickAxis = Math.abs(this.steerInput) > 0.35 ? 1 : 0;
    }

    // Engage the slide any time during the hop or shortly after landing.
    //
    // Which way it goes is the stick's decision — unless the stick is barely
    // deflected, in which case it is the corner's. On an 87-92 m radius at
    // 26 m/s the racing line asks for about 0.06 of steering input, so a driver
    // who steers only as much as the corner needs never crosses ANY sane
    // threshold: held down through all five corners of this circuit with a
    // clean line underneath it, the button engaged a slide exactly once, on the
    // 65 m banked hairpin, and did nothing at all on the other four. That is
    // the mechanic refusing to start in the situation it exists for.
    //
    // So a small deflection still counts, provided the kart is visibly already
    // turning that way — `yawRate` past 0.18 rad/s is a corner tighter than
    // 155 m at racing speed, and requiring the two signs to agree is what keeps
    // this from being a way to start a drift by accident. With the wheel
    // genuinely centred `Math.sign(0)` is 0, no branch matches, and the button
    // is a hop and a trick exactly as before (measured: 0 engagements out of 6
    // with the wheel straight, before and after).
    const cornering = Math.abs(this.yawRate) > 0.18 && speed > 8;
    const engageDir =
      Math.abs(this.steerInput) > DRIFT_ENGAGE_STEER ? Math.sign(this.steerInput)
      : cornering && Math.abs(this.steerInput) > 0.02 &&
        Math.sign(this.steerInput) === Math.sign(this.yawRate) ? Math.sign(this.yawRate)
      : 0;
    // The grace on a carried charge runs on real time, not on the charge clock,
    // and it runs whether or not a slide is open — a slide that re-engages
    // immediately has already consumed it.
    if (this.driftCarryTime > 0) {
      this.driftCarryTime -= dt;
      if (this.driftCarryTime <= 0) {
        this.driftCarryTime = 0;
        this.driftCarry = 0;
      }
    }

    if (this.driftDir === 0 && wantDrift && this.hopTimer > 0 && engageDir !== 0 && speed > 4) {
      this.driftDir = engageDir;
      // Resume a charge the player did not get paid for rather than restarting
      // it. See DRIFT_CARRY_TIME.
      this.driftTime = this.driftCarryTime > 0 ? this.driftCarry : 0;
      this.driftCarry = 0;
      this.driftCarryTime = 0;
      this.driftGrace = DRIFT_RELEASE_GRACE;
      this.driftStraight = 0;
      this.driftTier = tierFor(this.driftTime);
      this.driftCharge = chargeFor(this.driftTime);
      // The spark carries the tier it is resuming at, so the sparks, the rail
      // and the audio all pick up where they left off instead of flashing back
      // to white for a frame.
      ctx.bus.emit({ type: 'drift-spark', kart: this, tier: this.driftTier });
    }

    if (this.driftDir !== 0) {
      // --- the button, debounced while there is nothing to pay -------------
      // See DRIFT_RELEASE_GRACE. The grace re-arms on every frame the button
      // is held, so it is a window on the GAP rather than on the slide, and it
      // collapses to nothing the moment a tier is banked or the player asks to
      // straighten out.
      const escaping = this.steerInput * this.driftDir < -0.6;
      // ...and only inside a corner. See the corner table above for why this
      // cannot be asked of the kart itself; measured with a yaw test instead,
      // a button that chattered every couple of tenths held ONE slide for 35 s
      // through the tunnel and spent 84% of the lap sideways.
      const corner = cornerFactor(ctx.track, this.t);
      let letGo = !wantDrift;
      if (!letGo) {
        this.driftGrace = DRIFT_RELEASE_GRACE;
      } else if (this.driftTier === 0 && !escaping && corner > 0.5 && this.driftGrace > 0) {
        this.driftGrace -= dt;
        letGo = this.driftGrace <= 0;
      } else {
        this.driftGrace = 0;
      }
      // --- a drift is a cornering technique --------------------------------
      // Holding the button down a straight used to slide for ever, and with the
      // charge clock running it was a way to reach purple without going near a
      // corner: the ladder became a test of patience on the longest straight
      // rather than of commitment through the fastest curve. So a slide that
      // has been out of every corner for a second ends itself — and, because
      // that goes through `releaseDrift`, it PAYS. Leaving the corner with the
      // button still down fires the mini-turbo you earned in it, which is where
      // a player wants it anyway.
      if (corner > 0.5) this.driftStraight = 0;
      else this.driftStraight += dt;
      // 0.8 s of air, not 0.55: this circuit has a village climb, a beach
      // descent and a bridge, and a kart that gets light over a crest halfway
      // through a corner should not silently lose the mini-turbo it has already
      // earned. The slide is still cancelled by an actual jump.
      const bail = letGo || speed < 3.5 || this.stunTime > 0 || this.airTime > 0.8 ||
        this.driftStraight > DRIFT_STRAIGHT_BAIL;
      // --- overcooking it -----------------------------------------------
      // A drift that has put the WHOLE kart off the road is a blown drift, and
      // it forfeits the charge instead of cashing it. `worstSurface` only
      // reports OffTrack or Water once every loaded wheel is on one — hanging a
      // pair over the line is still a drift, being out there entirely is not —
      // so this cannot fire on a kerb or a verge, only on a corner the player
      // genuinely threw away. Without it the greedy line had no downside at
      // all: you could plough the scenery for a second and still collect the
      // purple you had banked on the way in.
      const sur = this.suspension.worstSurface;
      const blown = this.suspension.contacts > 0 &&
        (sur === Surface.OffTrack || sur === Surface.Water);
      if (blown) {
        this.forfeitDrift();
      } else if (bail) {
        this.releaseDrift(ctx);
      } else if (this.suspension.contacts > 0) {
        // Charge rewards actually holding an angle, not just holding a button —
        // but the bonus is a bonus, not the whole clock. The old window wanted
        // 0.39 rad of measured slip for full rate, which no kart that is staying
        // on the road ever reaches now that the front wheels can counter-steer;
        // a player driving the corner properly was charging at the floor rate
        // for it. What the eye reads as a 30 degree drift is mostly the authored
        // pose (see DRIFT_POSE_*), and the pose credits the physical slip against
        // itself, so the physical number belongs down here where it lands.
        //
        // Re-centred on the angle this chassis actually produces. Traced over
        // three laps the mean |beta| while sliding is 0.044 rad and a long held
        // slide averages 0.089; against a 0.03-0.13 window that is q = 0.14,
        // so the clock ran at 0.906x real time for every competent drift on the
        // circuit and the "bonus" was a flat 10% tax with a bonus painted on it.
        // 0.02-0.08 puts an ordinary slide at 1.01x and a deep one at 1.25x,
        // which is what the comment above always claimed it did.
        const q = clamp((Math.abs(this.driftBeta) - 0.02) / 0.06, 0, 1);
        // The mini-turbo clock only runs on tarmac. Washing a wheel or two onto
        // the verge does not end the drift — that would be brutal on a circuit
        // with a cliff ledge and a sand-lined beach straight — but it does stop
        // the charge banking, so a slide that runs wide arrives at the exit a
        // tier down. That, plus the speed the loose surface already takes, is
        // what makes the greedy line a gamble rather than a free option.
        // `offRoadLoad` is the share of the kart's weight on something other
        // than tarmac; two wheels fully committed to the verge charge at about
        // 40% rate, and the clock only stops dead once the kart is essentially
        // all the way out there. A steeper curve than this was tried and it is
        // too much — held through a corner that brushed the shoulder, the clock
        // stalled for most of the slide and a seven second drift banked nothing
        // at all, which reads as the mechanic being broken rather than as a
        // penalty for a wide line.
        const onRoad = clamp(1 - this.suspension.offRoadLoad * 1.2, 0, 1);
        // ...and only in a corner, for the same reason the slide itself ends on
        // a straight. `corner` ramps rather than switching, so the clock fades
        // out over the last dozen metres of a corner exit instead of stopping
        // dead under the player.
        this.driftTime += dt * (0.85 + 0.4 * q) * onRoad * corner;
        const tier = tierFor(this.driftTime);
        if (tier !== this.driftTier) {
          this.driftTier = tier;
          ctx.bus.emit({ type: 'drift-spark', kart: this, tier });
        }
        this.driftCharge = chargeFor(this.driftTime);
      }
    }

    if (this.trickPhase > 0) {
      this.trickPhase = Math.min(1, this.trickPhase + dt * 2.6);
    }
  }

  /**
   * End the slide with nothing to show for it. Everything `releaseDrift` does
   * except the payout — used when the kart has left the road entirely, which is
   * the one case where the player should watch a charged mini-turbo evaporate.
   */
  private forfeitDrift() {
    this.driftDir = 0;
    this.driftTier = 0;
    this.driftCharge = 0;
    this.driftTime = 0;
    // A blown drift keeps nothing, including anything carried into it.
    this.driftCarry = 0;
    this.driftCarryTime = 0;
    this.driftBeta = 0;
  }

  private releaseDrift(ctx: Ctx) {
    const tier = this.driftTier;
    if (tier > 0) {
      this.applyBoost(DRIFT_BOOST_TIME[tier], DRIFT_BOOST_STRENGTH[tier]);
      ctx.bus.emit({ type: 'boost', kart: this, tier });
      // Paid. There is nothing left to carry, and carrying it would pay twice.
      this.driftCarry = 0;
      this.driftCarryTime = 0;
    } else if (this.driftTime > 0.02) {
      // Nothing banked, so keep the clock briefly rather than making the player
      // start the corner again. See DRIFT_CARRY_TIME.
      this.driftCarry = this.driftTime;
      this.driftCarryTime = DRIFT_CARRY_TIME;
    }
    // NB: no carry reset here — the branches above have already decided what
    // this slide leaves behind, and clearing it a second time would throw away
    // the stash that is the whole point of the tier-0 branch.
    this.driftDir = 0;
    this.driftTier = 0;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftBeta = 0;
  }

  private onLanding(ctx: Ctx) {
    this.airborne = false;
    const air = this.airTime;
    const impact = this.airDescent;
    this.airTime = 0;
    this.airDescent = 0;
    if (impact > 1.5) {
      ctx.bus.emit({ type: 'land', kart: this, impact });
      this.squashTime = Math.min(0.32, 0.1 + impact * 0.012);
      this.squashLen = 0.32;
      this.driverRig?.jolt(clamp(impact * 0.06, 0, 1.2));
      if (this.isPlayer) ctx.shake(clamp(impact * 0.012, 0, 0.35), 0.25);
    }
    if (this.trickArmed) {
      this.trickArmed = false;
      if (air > TRICK_MIN_AIR) {
        this.applyBoost(0.7, 1.12);
        ctx.bus.emit({ type: 'boost', kart: this, tier: 1 });
      }
      this.trickPhase = 0;
    }
  }

  private applyBoostPad(ctx: Ctx) {
    if (this.boostTime < 0.9) {
      const fresh = this.boostTime <= 0;
      this.applyBoost(1.1, 1.28);
      if (fresh) ctx.bus.emit({ type: 'boost', kart: this, tier: 2 });
    }
  }

  // ---------------------------------------------------------------------------
  // contacts
  // ---------------------------------------------------------------------------

  private collideWalls(ctx: Ctx) {
    const hit = ctx.track.collideWalls(this.position, KART_RADIUS, this.t);
    if (!hit) return;
    const n = hit.normal;
    if (!Number.isFinite(n.x) || n.lengthSq() < 1e-8) return;
    this.position.add(hit.push);

    const vn = this.velocity.dot(n);
    if (vn >= 0) return;

    const speed = Math.max(1, this.velocity.length());
    const squareness = clamp(-vn / speed, 0, 1);

    // Bounce out, then scrub along the barrier proportionally to how square the
    // hit was: a glancing scrape barely costs anything, a head-on stops you.
    this.velocity.addScaledVector(n, -vn * (1 + WALL_RESTITUTION));
    this.velocity.multiplyScalar(1 - 0.5 * squareness * squareness);
    // A deliberate nudge back toward the racing surface so nobody grinds along
    // the wall with the throttle pinned.
    this.velocity.addScaledVector(n, 1.2 + 3.2 * squareness);

    // Turn the nose away from the barrier rather than leaving it buried in it.
    const desired = Math.atan2(n.x, n.z);
    let delta = desired - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.yaw += delta * 0.3 * squareness;
    this.yawRate *= 0.55;
    if (this.driftDir !== 0 && squareness > 0.35) this.releaseDrift(ctx);

    const impulse = -vn * (1 + WALL_RESTITUTION);
    if (this.collideCooldown <= 0 && impulse > 1.5) {
      this.collideCooldown = 0.12;
      ctx.bus.emit({ type: 'collide', kart: this, other: null, impulse });
      this.driverRig?.jolt(clamp(impulse * 0.07, 0, 1.4));
      if (this.isPlayer) ctx.shake(clamp(impulse * 0.02, 0, 0.5), 0.28);
    }
  }

  /**
   * Each kart applies only its own half of every pair impulse, using the
   * other's current velocity. Both halves land in the same frame, so the result
   * is symmetric without needing a central broadphase pass.
   */
  private collideKarts(ctx: Ctx, h: number) {
    const minDist = KART_RADIUS * 2;
    for (let i = 0; i < ACTIVE.length; i++) {
      const other = ACTIVE[i];
      if (other === this) continue;
      _sep.subVectors(this.position, other.position);
      // Karts bump, they never stack — and on a track that crosses over itself
      // the kart on the bridge must not shove the one underneath it.
      if (Math.abs(_sep.y) > 1.5) continue;
      _sep.y = 0;
      const d2 = _sep.lengthSq();
      if (d2 > minDist * minDist || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      _sep.multiplyScalar(1 / d);

      const total = this.mass + other.mass;
      const share = other.mass / total;
      this.position.addScaledVector(_sep, (minDist - d) * share * 0.9);

      const rel = this.velocity.dot(_sep) - other.velocity.dot(_sep);
      if (rel < 0) {
        const j = -(1 + KART_RESTITUTION) * rel * share;
        this.velocity.addScaledVector(_sep, j);
        // A shove also rotates you — this is what makes a side-swipe read.
        this.yawRate += clamp(_sep.dot(this.right) * rel * 0.06, -1.6, 1.6);
        if (this.collideCooldown <= 0 && -rel > 2) {
          this.collideCooldown = 0.14;
          ctx.bus.emit({ type: 'collide', kart: this, other, impulse: -rel });
          this.driverRig?.jolt(clamp(-rel * 0.05, 0, 1));
          if (this.isPlayer) ctx.shake(clamp(-rel * 0.014, 0, 0.3), 0.22);
        }
      } else {
        // Resting overlap: push apart briskly. Too soft here and a kart shoving
        // a slower one takes seconds to squeeze past, which reads as the two
        // being welded together.
        //
        // Written as an ACCELERATION (hence the `* 60 * h`), not as a velocity
        // step. It used to be a flat velocity add applied once per frame, which
        // meant a kart wedged against another was shoved exactly as hard on a
        // 20 fps frame as on a 120 fps one despite the frame covering six times
        // as much time — the separation rate was a function of the player's
        // hardware. The scale is chosen so the behaviour at 60 fps is unchanged.
        this.velocity.addScaledVector(_sep, Math.min(4, (minDist - d) * 9) * share * 60 * h);
      }
    }
  }

  /** Fell off the world, or sat in the water / out of bounds long enough. */
  private watchdog(ctx: Ctx) {
    if (this.position.y < this.groundY - 30 || this.badSurfaceTime > 2.2) this.doRespawn(ctx);
  }

  // ---------------------------------------------------------------------------
  // visuals
  // ---------------------------------------------------------------------------

  /**
   * Ramp the authored drift pose and work out the rendered yaw offset.
   *
   * The offset is the *shortfall*: whatever slip angle the tyres are already
   * carrying counts toward the target, so this goes to zero on a kart that is
   * genuinely sideways and opens up on one that is not. That is what stops the
   * two systems fighting — the silhouette is the same either way, and the pose
   * never adds a crab on top of a real one.
   */
  private updateDriftPose(dt: number) {
    const live = this.driftDir !== 0 && this.stunTime <= 0;
    if (live) this.poseDir = this.driftDir;

    // Below walking pace a crabbed kart reads as broken rather than committed,
    // and the drift itself bails at 3.5 m/s anyway.
    const groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const want = live ? clamp((groundSpeed - 3) / (POSE_SPEED_FULL - 3), 0, 1) : 0;
    // Snaps in with the hop, relaxes out over the mini-turbo — asymmetric on
    // purpose: the entry is an event, the exit is a recovery.
    this.posePhase += (want - this.posePhase) * smooth(want > this.posePhase ? 9 : 5.5, dt);

    let yawWant = 0;
    let steerWant = 0;
    if (this.posePhase > 1e-3 && this.poseDir !== 0) {
      const e = this.posePhase;
      const tierMix = clamp((this.driftTier + this.driftCharge) / 3, 0, 1);
      const lock = clamp(this.steerInput * this.poseDir, -1, 1);
      const pose = DRIFT_POSE_BASE + DRIFT_POSE_TIER * tierMix + DRIFT_POSE_LOCK * lock;
      // Signed like the physical slip target in `substep`: nose leads the
      // velocity, so beta carries the opposite sign to the drift direction.
      const betaWant = -this.poseDir * pose;
      const beta = Math.atan2(
        this.velocity.dot(this.right),
        Math.max(2.5, Math.abs(this.velocity.dot(this.forward))),
      );
      yawWant = clamp((beta - betaWant) * e, -DRIFT_POSE_MAX, DRIFT_POSE_MAX);
      steerWant = this.poseDir * DRIFT_POSE_STEER * e;
    } else {
      this.posePhase = 0;
      this.poseDir = 0;
    }

    this.driftPoseYaw += (yawWant - this.driftPoseYaw) * smooth(11, dt);
    this.poseSteer += (steerWant - this.poseSteer) * smooth(13, dt);
  }

  private updateVisuals(dt: number) {
    this.object.position.copy(this.position);
    this.object.quaternion.copy(this.quaternion);
    this.updateDriftPose(dt);

    const sus = this.suspension;
    // The physical roll is honest but subtle; a Nintendo kart wants to lean.
    // Exaggerate, then clamp — an unclamped 2.3x on a fully rolled chassis
    // would put a wheel through the bodywork.
    let roll = clamp(sus.roll * 2.3, -0.3, 0.3);
    let pitch = clamp(sus.pitch * 1.7, -0.22, 0.22);
    // The authored lean. Split across two nodes rather than piled onto one:
    // the bodywork carries most of it (that is the lean you read), while a
    // smaller roll of the whole kart tilts the wheelbase itself — which is what
    // gives the outside pair its compression and the inside pair its daylight.
    // Rolling the bodywork alone can never do that, because the wheels do not
    // hang off it. Both are reinforcing the physical roll, never fighting it.
    let chassisRoll = 0;
    if (this.posePhase > 0 && this.poseDir !== 0) {
      const e = this.posePhase;
      roll = clamp(roll - this.poseDir * DRIFT_BODY_ROLL * e, -0.38, 0.38);
      chassisRoll = -this.poseDir * DRIFT_CHASSIS_ROLL * e;
    }

    // --- keep the shell out of the road -------------------------------------
    // Measured on this model, the lean asked for above costs 145 mm of the
    // 145 mm of clearance the shell has: at full drift roll it eats 92 mm, and
    // combined with a full dive it is 176 mm — the rear valance and the front
    // bumper corner both end up under the surface. Both channels are contracted
    // by the same factor rather than clamped apart, so a kart braking hard
    // mid-drift keeps the *shape* of its pose and only loses the excess.
    //
    // The chassis roll counts toward the same budget. It pivots about the
    // contact plane rather than the shell's own origin, but the two differ only
    // by `bodyRestY * (1 - cos)` — tens of microns at these angles, and in the
    // safe direction — so the pair can be tested as one angle and contracted
    // together. Yaw is exempt: a rotation about the up axis cannot change the
    // height of anything, which is precisely why the crab is free.
    let sink = this.leanFloor - this.lowestBody(roll + chassisRoll, pitch);
    if (sink > BODY_SINK_MAX) {
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 5; it++) {
        const k = (lo + hi) * 0.5;
        if (this.leanFloor - this.lowestBody((roll + chassisRoll) * k, pitch * k) <= BODY_SINK_MAX) lo = k;
        else hi = k;
      }
      roll *= lo;
      pitch *= lo;
      chassisRoll *= lo;
      sink = this.leanFloor - this.lowestBody(roll + chassisRoll, pitch);
    }
    this.poseChassisRoll = chassisRoll;

    // Trick: a full rotation over the airtime, eased so it lands flat.
    let trickRoll = 0;
    let trickPitch = 0;
    if (this.trickPhase > 0) {
      const p = this.trickPhase;
      const e = p * p * (3 - 2 * p);
      if (this.trickAxis === 1) trickRoll = e * Math.PI * 2 * Math.sign(this.steerInput || 1);
      else trickPitch = e * Math.PI * 2;
    }

    // A trick rotates the WHOLE kart — wheels and all — so it lives on the
    // outer group, and so do the two channels of the drift pose that have to
    // take the wheels with them: the crab and the chassis roll. Lean and dive
    // rotate only the bodywork, so the wheels stay planted in their wells.
    //
    // Order YZX, not ZYX: it puts the yaw outermost, so the roll happens about
    // the kart's own longitudinal axis instead of about the direction of
    // travel. At thirty degrees of crab that is the difference between a kart
    // leaning into its slide and a kart leaning sideways across it. With no yaw
    // the two orders are identical, so nothing that predates the pose moves.
    const sameNode = this.bodyNode === this.visual;
    _euler.set(trickPitch, this.driftPoseYaw, trickRoll - chassisRoll, 'YZX');
    if (!sameNode) this.visual.rotation.copy(_euler);

    _euler.set(
      pitch + (sameNode ? trickPitch : 0),
      sameNode ? this.driftPoseYaw : 0,
      -roll + (sameNode ? trickRoll - chassisRoll : 0),
      sameNode ? 'YZX' : 'ZYX',
    );
    this.bodyNode.rotation.copy(_euler);
    // Float off whatever penetration survived the contraction. Skipped when the
    // model never separated its bodywork, because there the "body" carries the
    // wheels too and lifting it would take them off the road to fix a shell that
    // is on it.
    if (!this.bodyIsRoot) this.bodyNode.position.y = this.bodyRestY + (sink > 0 ? sink : 0);

    // Squash & stretch: flatten on a hard landing, stretch under boost.
    const sq = this.squashTime > 0 ? this.squashTime / Math.max(0.01, this.squashLen) : 0;
    const stretch = this.boostTime > 0 ? 0.05 : 0;
    this.bodyNode.scale.set(
      1 + sq * 0.18 - stretch * 0.4,
      1 - sq * 0.3,
      1 + sq * 0.18 + stretch,
    );

    this.applyWheelVisuals(dt);
    this.applyDriverRig(dt);
  }

  private applyWheelVisuals(dt: number) {
    const sus = this.suspension;
    // Undo the chassis roll at each corner so the wheels stay where the physics
    // has them. Rolling the kart by `rho` about the contact plane drops the
    // hardpoint at local x by `x * sin(rho)`, so adding that back to the node's
    // own height puts the tyre exactly on the road again — for the loaded pair.
    // The unloaded pair gets only part of it back, and the remainder is the
    // inside-wheel lift: about 20 mm of daylight at full pose, enough to read in
    // a close shot without looking like a kart on two wheels in a wide one.
    const roll = this.poseChassisRoll;
    const sr = roll !== 0 ? Math.sin(roll) : 0;
    for (let i = 0; i < 4; i++) {
      const w = sus.wheels[i];
      const node = this.wheels[this.wheelMap[i]];
      if (!node) continue;
      let y = this.wheelRestY[i] + sus.visualOffset(w);
      if (sr !== 0) {
        const drop = node.position.x * sr;
        y += drop > 0 ? drop : drop * (1 - POSE_WHEEL_LIFT);
      }
      node.position.y = y;
      // The front wheels carry extra lock while sliding. The physical rack is
      // already biased toward the drift, but it is a compromise between the
      // slide and the stick and it can wind itself flat when the two disagree —
      // which is exactly what round 1 photographed. The pose is not a
      // compromise.
      if (w.front) node.rotation.y = this.steerAngle + this.poseSteer;
      // +X rotation carries the top of the wheel forward, i.e. rolling forward
      w.spinAngle += w.spinRate * dt;
      if (!Number.isFinite(w.spinAngle)) w.spinAngle = 0;
      if (w.spinAngle > Math.PI * 2 || w.spinAngle < -Math.PI * 2) w.spinAngle %= Math.PI * 2;
      node.rotation.x = w.spinAngle;
    }
  }

  private applyDriverRig(dt: number) {
    const g = clamp(this.aLat / GRAVITY, -1.2, 1.2);

    if (this.driverRig) {
      // The driver leans off the same authored pose as the chassis, not off the
      // measured load. A pilot sitting bolt upright inside a kart that is thirty
      // degrees sideways is the tell that the pose is painted on. `poseDir`
      // carries the same sign as the g the corner would have produced, so the
      // two only ever add.
      const lean = clamp(g / 1.1 + this.poseDir * 0.5 * this.posePhase, -1, 1);
      // KartModel's rig channels are all -1..1 (duck 0..1) and it must be
      // updated every frame — left undriven it runs its own idle loop.
      this.driverRig.setPose(
        clamp(this.steerAngle / MAX_STEER, -1, 1),
        lean,                                                     // + = right-hand corner
        clamp(-this.aLong / GRAVITY, -1, 1),                      // + = braking, tuck forward
        this.boostTime > 0 ? 1 : clamp(Math.abs(this.forwardSpeed) / 34, 0, 0.55),
        clamp(this.steerInput * 0.7 + this.poseDir * 0.55 * this.posePhase, -1, 1),
      );
      this.driverRig.update(dt);
      return;
    }

    if (this.driver) {
      // Lean into the corner, and brace forward under braking.
      const targetZ = this.driverRestZ - g * 0.24 - this.driftDir * 0.08;
      const targetX = this.driverRestX + clamp(-this.aLong / GRAVITY, -1, 1) * 0.12;
      const k = smooth(9, dt);
      this.driver.rotation.z += (targetZ - this.driver.rotation.z) * k;
      this.driver.rotation.x += (targetX - this.driver.rotation.x) * k;
    }
    if (this.driverHead) {
      // Look toward the apex: the steering input plus a bias from the slide.
      const target = this.headRestY + clamp(this.steerInput * 0.55 + this.driftDir * 0.3, -0.9, 0.9);
      this.driverHead.rotation.y += (target - this.driverHead.rotation.y) * smooth(7, dt);
    }
    if (this.steeringWheel) {
      const target = this.wheelRestZ - (this.steerAngle / MAX_STEER) * 1.15;
      this.steeringWheel.rotation.z += (target - this.steeringWheel.rotation.z) * smooth(16, dt);
    }
  }

  // ---------------------------------------------------------------------------
  // commands from other systems
  // ---------------------------------------------------------------------------

  applyBoost(seconds: number, strength = 1.18) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.boostTime = Math.max(this.boostTime, seconds);
    this.boostStrength = Math.max(this.boostStrength, clamp(strength, 1, 1.6));
  }

  spinOut(seconds: number) {
    if (this.starTime > 0 || this.invulnTime > 0) return;
    this.stunTime = Math.max(this.stunTime, seconds);
    this.driverRig?.jolt(1.2);
    this.spinDir = this.driftDir !== 0 ? -this.driftDir : Math.sign(this.steerInput || 1);
    this.driftDir = 0;
    this.driftTier = 0;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftCarry = 0;
    this.driftCarryTime = 0;
    this.boostTime = 0;
    this.boostStrength = 1;
    this.velocity.multiplyScalar(0.45);
  }

  squash(seconds: number) {
    if (this.starTime > 0 || this.invulnTime > 0) return;
    this.stunTime = Math.max(this.stunTime, seconds);
    this.squashTime = seconds;
    this.squashLen = Math.max(0.05, seconds);
    this.velocity.multiplyScalar(0.25);
    this.boostTime = 0;
    this.boostStrength = 1;
    this.driftDir = 0;
    this.driftTier = 0;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftCarry = 0;
    this.driftCarryTime = 0;
  }

  launch(impulse: THREE.Vector3) {
    if (!Number.isFinite(impulse.x) || !Number.isFinite(impulse.y) || !Number.isFinite(impulse.z)) return;
    this.velocity.add(impulse);
    if (impulse.dot(this.up) > 1) this.airDescent = 0;
  }

  respawn() {
    this.respawnPending = true;
  }

  private doRespawn(ctx: Ctx) {
    this.respawnPending = false;
    const track = this.track ?? ctx.track;
    if (!track) return;
    const s = track.sample(this.lastGoodT);
    // Just enough drop to settle onto the springs with a visible thump.
    this.position.copy(s.pos).addScaledVector(s.normal, 0.7);
    this.yaw = Math.atan2(s.tangent.x, s.tangent.z);
    this.yawRate = 0;
    this.velocity.set(0, 0, 0);
    this.up.copy(s.normal).normalize();
    if (this.up.y < 0.2) this.up.set(0, 1, 0);
    this.t = this.lastGoodT;
    this.forwardSpeed = 0;
    this.aLat = this.aLong = this.aLatPure = 0;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.driftDir = 0;
    this.driftTier = 0;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftCarry = 0;
    this.driftCarryTime = 0;
    this.clearPose();
    this.boostTime = 0;
    this.boostStrength = 1;
    this.stunTime = 0;
    this.squashTime = 0;
    this.trickPhase = 0;
    this.trickArmed = false;
    this.badSurfaceTime = 0;
    this.airborne = false;
    this.airTime = 0;
    this.groundTime = 1;
    // Brief grace so you are not immediately re-hit at the drop point.
    this.invulnTime = 1.8;
    this.offRoadLoad = 0;
    this.surface = Surface.Road;
    this.suspension.reset();
    this.updateBasis(1);
  }
}
