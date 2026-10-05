/**
 * ============================================================================
 *  CHASE CAMERA
 * ============================================================================
 *
 *  The whole rig is four ideas. Everything else in this file is either a
 *  cinematic pose (countdown, finish, results) or a hard constraint (ground,
 *  tunnel roof, walls, props).
 *
 *   1. A BEARING. One scalar — `armYaw` — is the compass direction the lens
 *      sits behind. It springs toward the kart's direction of TRAVEL (not its
 *      facing, which is what makes a drift read as a drift), and it is bounded
 *      two ways: it may never fall more than MAX_LAG behind the chassis, and it
 *      may never move faster than MAX_ARM_RATE. Those two bounds are the whole
 *      of the comfort story, and because both are stated per SECOND the rig
 *      behaves identically at 30, 60 and 144 Hz.
 *
 *   2. A POSE built from that bearing. eye = kart - armDir * dist + up * height,
 *      with dist/height responding to speed, boost, braking, drift and air.
 *      There is no positional spring: a spring chasing a moving kart settles
 *      with a standing error of |v| * T, which silently rewrites the rig
 *      geometry at speed. All the smoothing lives in the bearing and in the
 *      scalars, where it can be reasoned about.
 *
 *   3. THE ORIENTATION IS SOLVED, NOT SPRUNG. Given the final eye position —
 *      after every constraint has had its say — there is exactly one view axis
 *      that puts the kart at a chosen point on screen, and it is one rotation
 *      of the eye->kart vector by atan(ndc * tan(halfFov)). So the composition
 *      is not hoped for, it is constructed, and the subject cannot leave the
 *      frame: `frameX` IS the kart's screen position. No aim spring, no
 *      screen-space feedback loop, no guard pass to catch what the loop missed.
 *
 *   4. A HANDFUL OF STATE RESPONSES. Boost drops and closes the arm on an
 *      underdamped oscillator (a dolly zoom: the lens opens by the same
 *      proportion the arm closes, so the world stretches and the kart does
 *      not shrink). Drift slides the subject across frame and leans the
 *      horizon. Landing dips. Collisions kick and shake. Banking rolls the up
 *      vector, partially, with a rate ceiling.
 *
 *  Frame-rate independence is structural rather than audited: every filter here
 *  is `damp1`/`damp3` (the analytic critically-damped spring) or `Osc` (the
 *  analytic damped harmonic oscillator), and every limit is a rate multiplied
 *  by dt. There is not one per-frame gain in the file.
 *
 *  Zero allocation in lateUpdate: all vectors, quaternions and matrices are
 *  module scope or owned by the instance.
 * ============================================================================
 */
import * as THREE from 'three';
import { feel } from '../core/Feel';
import { BASE_TOP_SPEED, RaceState, type Ctx, type IKart, type System, type TrackSample } from '../types';

// ===========================================================================
//  Tuning — every constant, with the reason it is that number
// ===========================================================================

// --- lens ------------------------------------------------------------------

/** Vertical FOV at cruise, degrees. 50 vertical is 79 horizontal at 16:9 —
 *  a generous arcade field (shipped kart racers sit at 75-80) that still holds
 *  a 1.5 m kart at ~22% of frame height on a 6 m arm. */
const FOV_BASE = 50;
const REF_ASPECT = 16 / 9;
/** Solve the lens horizontally and clamp both axes, so a phone in portrait
 *  does not end up with a 40 degree horizontal field (blind into a corner) and
 *  one in landscape does not end up with a 100 degree fisheye. */
const FOV_H_MAX = 100;
const FOV_H_MIN = 62;
const FOV_V_MAX = 78;
const FOV_V_MIN = 30;
/** degrees the field opens between a standstill and top speed */
const FOV_SPEED = 5.0;
/** weight on ctx.fovPunch, which peaks near 10.5 degrees on a boost. The arm
 *  closes by BOOST_DIST at the same time; the pair is a dolly zoom. */
const FOV_BOOST = 0.8;
/** degrees the field opens at |corner| = 1, so more of the exit is in shot */
const FOV_CORNER = 3.0;
/** ...and closes under braking, which reads as the world slowing down */
const FOV_BRAKE = 2.2;

// --- arm geometry ----------------------------------------------------------

/** The arm hangs off a point above the chassis COM, not off the COM itself. */
const PIVOT_UP = 0.62;
/** Metres behind the pivot at rest, and the extra length at top speed. Small:
 *  the lens opening with speed is what should make the frame breathe, and an
 *  arm that grows to match holds the subject at a constant size in every shot. */
const ARM_DIST = 5.6;
const ARM_DIST_SPEED = 0.55;
/** Metres above the pivot, i.e. ~1.8 m over the road. A chase camera that
 *  looks down is a map; this one runs level so the horizon sits near the
 *  middle of the frame and the road compresses toward it. */
const ARM_HEIGHT = 1.15;
const ARM_HEIGHT_SPEED = -0.22;
/** Boost: the arm comes in and drops. Paired with FOV_BOOST — the field opens
 *  by the matching proportion, so the kart holds its size while the world
 *  stretches past the frame edge. */
const BOOST_DIST = 1.25;
const BOOST_HEIGHT = 0.34;
/** ...and the transient on top of it, on an underdamped oscillator, so the
 *  entry snaps in and the settle overshoots back out. This is the "small
 *  overshoot" the boost is supposed to have. */
const BOOST_SURGE_DIST = 3.0;
const BOOST_SURGE_HEIGHT = 0.50;
const BOOST_SURGE_OMEGA = 13;
const BOOST_SURGE_ZETA = 0.5;   // ~16% overshoot, one visible rebound
/** Braking pulls the rig in and down a little: the frame tightens. */
const BRAKE_DIST = 0.80;
const BRAKE_HEIGHT = 0.28;
/** A slide wants a slightly lower, slightly longer arm — more of the chassis
 *  side-on against the road. */
const DRIFT_HEIGHT = -0.18;
const DRIFT_DIST = 0.35;
/** Airborne: lift, so the rig does not end up looking at the underside of a
 *  kart that has just left a crest. Filtered (see `airAmt`), never a step. */
const AIR_HEIGHT = 0.35;
/** Climb the banking. A lens 1.8 m over the road on the LOW side of a 20 degree
 *  bank is looking into the banking, and the frame is a wall of tarmac with the
 *  exit hidden behind it. */
const BANK_HEIGHT = 1.00;
/** Metres the lens is held away from the chassis whatever else happens. Below
 *  this the kart is through the near plane and no amount of aiming brings it
 *  back. */
const MIN_RANGE = 2.6;

// --- heading ---------------------------------------------------------------

/**
 * How much of the slide the arm follows.
 *
 * The arm chases the direction of TRAVEL, not the direction the chassis points,
 * and it is allowed to over-drive: at 1.0 the rig sits exactly behind the
 * velocity vector, and the chassis is visibly yawed across the frame by the
 * full slip angle. Under drift the gain goes past 1, so a slide reads as
 * further sideways than it physically is — which is the entire point of a kart
 * camera and the single detail that separates it from a car camera.
 */
const TRAVEL_GAIN = 0.60;
const TRAVEL_GAIN_DRIFT = 0.55;   // added on top while drifting -> 1.15
/** ...but never more than this much yaw off the chassis, so a spin, a shell or
 *  a wall does not swing the rig through 180 degrees. 24 degrees is more slide
 *  than the physics produces on this circuit. */
const MAX_SLIP = 0.42;

/**
 * Bearing spring time constant, seconds.
 *
 * A critically-damped spring tracking a target that yaws at w settles at a
 * standing error of w * T. The kart's median yaw rate under full lock on this
 * circuit is ~52 deg/s and its p95 is ~159, so 0.17 s buys 9-27 degrees of
 * trailing lag — enough that the rig visibly swings into a corner rather than
 * being welded to the kart, and well inside MAX_LAG.
 */
const HEAD_TAU = 0.17;
/** ...and it trails further through a slide and through a hard corner, which
 *  is what makes the two look different from the inside. */
const HEAD_TAU_DRIFT = 0.09;
const HEAD_TAU_CORNER = 0.05;
/** ...and much further when nothing is moving: see HEAD_ROAD. */
const HEAD_TAU_CALM = 0.20;

/**
 * The hard bound on how far the bearing may fall behind the CHASSIS, radians.
 *
 * This is the number that decides whether the player can see where they are
 * going, and it is stated against the chassis rather than against the travel
 * heading on purpose: the travel heading is already up to MAX_SLIP away, and
 * two allowances in series is how a rig ends up 157 degrees behind a kart that
 * turned 90. 26 degrees leaves the whole drift composition intact (the slide
 * is 15-24 degrees of it) and still guarantees the kart's own heading is never
 * more than a quarter-frame off the view axis.
 */
const MAX_LAG = 0.455;

/**
 * Ceiling on how fast the bearing may swing, rad/s.
 *
 * 2.7 rad/s is 155 deg/s. The kart's own yaw rate exceeds that only in a
 * spin-out, which is exactly the case this exists for: a chassis being shoved
 * around by a collision yaws at two to four hundred degrees a second and there
 * is no reason for the frame to reproduce that. In ordinary driving it never
 * binds, so it is a backstop and not a mechanism.
 */
const MAX_ARM_RATE = 2.0;
/** ...lifted while the bearing is outside MAX_LAG, because a player who cannot
 *  see their kart does not care how smooth the recovery was. */
const MAX_ARM_RATE_LOST = 3.2;

/**
 * Below CALM_LO m/s the arm follows the ROAD rather than the chassis, fading
 * out by CALM_HI.
 *
 * Under about 9 m/s there is no velocity heading worth trusting, so the target
 * would be the chassis — and a chassis that has been shunted or spun yaws
 * several times faster than a kart driving. Those frames are where a chase
 * camera does all its worst work. Pointing the arm down the centreline instead
 * is also the answer to what the player needs at that moment: to see where the
 * track goes. The chassis keeps a share of the vote so the frame still reads as
 * attached to the kart.
 */
const CALM_LO = 3.0;
const CALM_HI = 12.0;
const HEAD_ROAD = 0.70;

// --- corner measurement ----------------------------------------------------

/** Lagged copy of the heading, used to differentiate it. Differencing frame to
 *  frame hands a 120 Hz machine twice the jitter a 60 Hz one gets out of
 *  identical physics; differencing against a fixed-time-constant lag does not. */
const HEAD_RATE_TAU = 0.10;
/** m/s^2 of lateral acceleration that counts as a full corner. */
const CORNER_G_FULL = 9.0;
/** weight of the measured lateral g, and of the bend of the road ahead. The
 *  second is what makes the frame start recomposing on the APPROACH; a camera
 *  that only reacts is always a beat late. */
const CORNER_MEASURED = 0.72;
const CORNER_ANTICIPATED = 0.50;
/** metres ahead the bend is sampled, at rest and at top speed */
const CORNER_LOOK = 26;
const CORNER_LOOK_SPEED = 34;
const CORNER_TAU = 0.15;
/**
 * Ceiling on the heading rate the corner estimate will believe, rad/s.
 *
 * Cornering yaw rate is a/v: at 9 m/s^2 that is 0.3 rad/s at racing pace and
 * about 1.0 at walking pace, so 1.8 is generous for anything a driver does. A
 * COLLISION is not cornering, and one measured here snaps the chassis 31
 * degrees in a single frame — 1900 deg/s. Left unbounded that reads as a full
 * corner in the opposite direction and swings the composition (and with it the
 * lens, the lean and the frame offset) hard across the frame in the quarter
 * second after an impact, which is the last moment the picture should be busy.
 */
const CORNER_RATE_MAX = 1.8;
/**
 * ...and a ceiling on how fast the composition itself may change, per second.
 *
 * `corner` drives the horizon lean, the corner lens and the arm's bank climb.
 * All three are cheap to change slowly and expensive to change fast, and
 * entering a real corner takes about a third of a second, so this never binds
 * on a driving frame — it only stops a discontinuity in the estimate (an
 * impact, a shell) becoming a lurch in three terms at once.
 */
const CORNER_MAX_RATE = 3.0;

// --- composition -----------------------------------------------------------

/**
 * Where the kart sits on screen — derived, not decorated.
 *
 * The rule is one sentence: THE LENS POINTS WHERE THE KART IS POINTING, AND THE
 * KART GOES WHEREVER THAT LEAVES IT. The eye trails the direction of travel by
 * whatever the bearing spring gives it, and the lens then rotates most of that
 * trailing angle back off, so the view axis runs down the chassis heading and
 * the corner exit is in shot. The subject slides to the OUTSIDE of the arc as a
 * consequence, which is the composition a kart racer wants, and it comes out of
 * the geometry instead of out of a second hand-tuned curve that has to be kept
 * in agreement with the first.
 *
 * Three consequences worth stating:
 *
 *  - The measured lag between the kart's heading and the view axis is
 *    (1 - FRAME_LAG_CANCEL) of the bearing lag, at every cornering rate. A
 *    composition keyed to a separate "how hard are we cornering" scalar
 *    cancels the lag at one speed and one radius and nowhere else.
 *  - A drift composes itself. The bearing follows travel and the chassis is
 *    yawed off it by the slip angle, so the same term swings the lens across
 *    the slide and throws the kart to the outside of frame, harder with more
 *    slip.
 *  - It cannot lose the subject: the angle is converted to NDC against the live
 *    lens and clamped there.
 */
/** Fraction of the bearing's trailing angle the lens rotates back off. At 1.0
 *  the view axis is welded to the chassis heading and the trailing eye reads as
 *  a fixed off-centre framing; at 0 the camera looks straight down the arm and
 *  a corner is composed exactly like a straight. 0.72 leaves a few degrees of
 *  genuine lag — enough to feel the rig swing behind you — and puts the rest
 *  into the picture. */
const FRAME_LAG_CANCEL = 0.72;
/** Radians of extra lead into the bend of the road ahead, at |bend| = 1. This
 *  is the only anticipatory term left: it starts the recompose on the approach,
 *  before there is any bearing lag to cancel. */
const FRAME_BEND = 0.10;
/** ...and a little more angle again per unit of mini-turbo charge, so a purple
 *  slide is framed harder than a blue one. */
const FRAME_DRIFT = 0.07;
/** Ceiling on how fast the composition angle may change, rad/s. 1.2 swings the
 *  full composition in about half a second — quick enough that a drift catching
 *  reads as an event — while making it impossible for a discontinuity in the
 *  chassis heading (a wall, a shell) to become a whip. Sized against MAX_SLEW:
 *  the composition and the bearing rotate the frame together, so this is the
 *  share of the comfort budget the picture is allowed to spend. */
const FRAME_ANG_RATE = 0.85;
/** Hard cap on the lateral composition, NDC. Past about a third of a half-frame
 *  the subject stops reading as the subject. */
const FRAME_X_MAX = 0.30;
/**
 * Below centre, so the road ahead owns the upper half of the frame and the
 * kart's roll bar and driver break the skyline instead of being drawn on
 * tarmac of near-identical value.
 *
 * Not FURTHER below than this, though, and that is the harder half of the
 * choice: every degree the axis pitches down buys foreground asphalt at the
 * price of sightline. At -0.26 the bottom third of the shot was bare road and
 * the horizon sat above the top quarter; -0.19 keeps the subject clearly in the
 * lower half, where a chase camera belongs, while putting the corner the player
 * is about to take back inside the frame.
 */
const FRAME_Y = -0.19;
const FRAME_Y_SPEED = -0.05;
const FRAME_Y_DRIFT = -0.04;
const FRAME_Y_MIN = -0.32;
const FRAME_Y_MAX = -0.08;
/** The point on the kart the composition is measured against — chassis COM is
 *  under the driver's seat, and framing on it sits the visible mass low. */
const SUBJ_UP = 0.55;

// --- roll ------------------------------------------------------------------

/** Fraction of the road's tilt the horizon adopts. Deliberately partial: a rig
 *  glued 1:1 to the road plane renders a banked corner as a LEVEL frame with
 *  level trackside furniture, which is the one thing a banked corner must
 *  never look like. At 0.55 the 20 degree coastal bank tilts the horizon 11
 *  degrees and the palms lean the other way. */
const BANK_GAIN = 0.55;
/** Dutch lean into a corner and into a slide, radians at full. Small — this is
 *  seasoning, and the bank above is the main course. */
const CORNER_ROLL = 0.085;
const DRIFT_ROLL = 0.055;
/** Total roll ceiling and the rate ceiling on getting there. 54 deg/s of
 *  horizon roll is already brisk; anything faster is a barrel roll. */
const MAX_ROLL = 0.45;
const MAX_ROLL_RATE = 0.95;

// --- comfort backstops -----------------------------------------------------

/**
 * Ceiling on the camera's own angular speed, rad/s. 3.1 is 178 deg/s.
 *
 * With the bearing already rate-limited and the composition a smooth function
 * of smoothed scalars, nothing in normal driving comes near this — it exists so
 * that no future term in this file can whip the frame, and so that a cut or a
 * constraint pop cannot become a rotation.
 */
const MAX_SLEW = 2.0;
/**
 * Ceiling on how fast the lens may move RELATIVE TO THE KART, m/s. Following a
 * kart down a straight costs nothing against this budget; only the rig's own
 * motion is charged. It is what turns a wall push or an arm collapse into a
 * move over two or three frames instead of a step in one.
 */
const MAX_EYE_SLIP = 14;

// --- hard constraints ------------------------------------------------------

const CAM_RADIUS = 0.55;      // collision probe radius for walls and props
const GROUND_CLEAR = 0.68;    // metres the lens is kept above the terrain
const BORE_STATIONS = 640;    // tunnel-roof lookup table resolution
const BORE_CLEAR = 0.8;       // metres kept under the bore roof
/** Arm-sweep resolution. Five stations between the pivot and the eye is enough
 *  to catch rising ground and barriers; the props get an exact segment test. */
const SWEEP_STATIONS = 5;
/** The arm eases back out more slowly than it pulls in: clipping is a hard
 *  failure, and the recovery is the part the viewer reads. */
const ARM_FRAC_IN = 0.06;
const ARM_FRAC_OUT = 0.22;

// --- trackside furniture ---------------------------------------------------

const PROP_MAX_SPAN = 13;     // wider than this is architecture, not furniture
const PROP_MAX_HEIGHT = 15;
const PROP_MAX_COUNT = 2400;
const PROP_MAX_INSTANCES = 384;
const PROP_BUILD_FRAMES = [0, 12, 40, 110, 300];
/** Shortest the furniture sweep alone may leave the arm. Terrain and walls are
 *  not floored — an eye inside a hill has no acceptable framing — but a sign is
 *  0.2 m thick and beside the road, and collapsing a 6 m arm to 1.8 m every
 *  time one goes past reads as a cut to a bumper cam. */
const PROP_ARM_MIN_FRAC = 0.85;
/** Furthest the last-resort push moves the lens in one frame. Deeper than this
 *  and the lens is inside something large, where a 4 m pop is a worse artefact
 *  than the clipped corner it fixes. */
const PROP_ESCAPE_MAX = 3.2;
const PROP_SKIP = new RegExp([
  'sky|cloud|sea|water|ocean|backdrop|horizon|fog|terrain|ground',
  'road|tarmac|asphalt|kerb|curb|grass|sand',
  'shadow|decal|spark|smoke|dust|particle|trail|godray|flare|glow',
  'foliage|leaf|leaves|frond|palm|tree|bush|shrub|hedge|plant|flower',
  'crowd|spectator',
  'item|pickup|coin|shell|banana|bomb|star|projectile|boostpad|pad',
  'minimap|helper|gizmo',
].join('|'), 'i');

// --- cinematics ------------------------------------------------------------

const INTRO_DUR = 3.55;       // countdown fly-in length, seconds
const FINISH_HOLD = 2.3;      // seconds the finish cut holds trackside
const WIDE_RANGE = 42;        // establishing plate: range and lens, solved
const WIDE_FOV = 31;          //   backwards from "the kart must be findable"
const WIDE_FRAME_X = 0.31;
const WIDE_FRAME_Y = -0.26;
const CLOSE_FOV = 34;

/** Which pose built the frame — see `poseKind`. */
const POSE_CHASE = 0, POSE_WIDE = 1, POSE_CLOSE = 2, POSE_ORBIT = 3, POSE_FINISH = 4, POSE_INTRO = 5;

/**
 * A teleport is a CUT, not a move. Stated as a speed and integrated against dt,
 * so the same respawn is the same event at any frame rate; a flat metres-per-
 * frame test is four times as sensitive at 30 Hz as at 120.
 */
const CUT_SPEED = 120;
const CUT_MIN = 2.2;
/**
 * ...and how far wrong the bearing has to be, after the teleport, before the
 * SHOT is cut as well as the position.
 *
 * A respawn usually drops the kart back on the racing line pointing roughly the
 * way it was already going, and there the right answer is to rebuild the pose
 * behind the kart on the bearing the lens already had — the view axis is then
 * continuous through the teleport, nothing rotates at all on the cut frame, and
 * the bearing converges under the ordinary rate ceiling. Reseeding the bearing
 * on every teleport instead rotates the frame by the whole heading change in
 * one frame, measured at 1800 deg/s on a routine off-track recovery.
 *
 * Past this, though, the lens is pointing somewhere with no relationship to the
 * new pose, and panning 90 degrees at the comfort ceiling would take most of a
 * second with the kart off frame for all of it. That is a different shot, and a
 * cut is the honest way to get to it.
 */
const CUT_TURN = 0.8;

// ===========================================================================
//  Scratch — module scope, so lateUpdate allocates nothing
// ===========================================================================

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _chaseEye = new THREE.Vector3();
const _chaseAim = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _face = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _box = new THREE.Box3();
const _euler = new THREE.Euler();

type CamMode = 'chase' | 'wide' | 'close';
/** Track.sample() takes a scratch target; the ITrack interface hides it. */
type SampleFn = (t: number, out?: TrackSample) => TrackSample;

// ===========================================================================
//  Maths
// ===========================================================================

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }

function smootherstep(x: number) {
  x = clamp(x, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Shortest signed representation of an angle, radians. */
function wrapAngle(a: number) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/**
 * Analytic critically-damped spring. Unconditionally stable for any dt, no
 * overshoot, and the response is a function of `smoothTime` alone rather than
 * of the frame rate. Every scalar filter in this file is this one.
 */
function damp1(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + om * change) * dt;
  vel.v = (vel.v - om * temp) * e;
  return target + (change + temp) * e;
}

/** Vector form; writes through `cur` and `vel`. */
function damp3(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x, cy = cur.y - target.y, cz = cur.z - target.z;
  const tx = (vel.x + om * cx) * dt, ty = (vel.y + om * cy) * dt, tz = (vel.z + om * cz) * dt;
  vel.set((vel.x - om * tx) * e, (vel.y - om * ty) * e, (vel.z - om * tz) * e);
  cur.set(target.x + (cx + tx) * e, target.y + (cy + ty) * e, target.z + (cz + tz) * e);
}

/**
 * Harmonic oscillator with a free damping ratio — the one filter here that is
 * allowed to overshoot, which is what gives the boost its rebound and the
 * landing its bounce. Solved in closed form for all three damping regimes, so
 * it is exact at any dt rather than an O(h) substepped integration.
 */
class Osc {
  v = 0;
  vel = 0;
  step(target: number, omega: number, zeta: number, dt: number) {
    if (dt <= 0) return this.v;
    const x0 = this.v - target;
    const v0 = this.vel;
    if (zeta < 1 - 1e-4) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-zeta * omega * dt);
      const c = Math.cos(wd * dt), s = Math.sin(wd * dt);
      const A = x0;
      const B = (v0 + zeta * omega * x0) / wd;
      this.v = target + e * (A * c + B * s);
      this.vel = e * ((B * wd - zeta * omega * A) * c - (A * wd + zeta * omega * B) * s);
    } else if (zeta <= 1 + 1e-4) {
      const e = Math.exp(-omega * dt);
      const A = x0;
      const B = v0 + omega * x0;
      this.v = target + e * (A + B * dt);
      this.vel = e * (B - omega * (A + B * dt));
    } else {
      const r = omega * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * omega + r, r2 = -zeta * omega - r;
      const c2 = (v0 - r1 * x0) / (r2 - r1);
      const c1 = x0 - c2;
      const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
      this.v = target + c1 * e1 + c2 * e2;
      this.vel = c1 * r1 * e1 + c2 * r2 * e2;
    }
    return this.v;
  }
  kick(a: number) { this.vel += a; }
  reset() { this.v = 0; this.vel = 0; }
}

/** Two detuned sines: dense enough to read as shake, smooth enough not to alias. */
function shakeNoise(t: number, seed: number) {
  return Math.sin(t * 27.3 + seed * 4.7) * 0.62 + Math.sin(t * 44.1 + seed * 11.3) * 0.38;
}

// ===========================================================================

export class ChaseCamera implements System {
  // --- the bearing, and everything hanging off it ------------------------
  private armYaw = 0;                          // world yaw the lens sits behind
  private armVel = { v: 0 };
  private arm = new THREE.Vector3(0, 0, 1);    // unit vector form of armYaw
  private lagYaw = 0;                          // lagged copy, for differentiation
  private lagVel = { v: 0 };
  private up = new THREE.Vector3(0, 1, 0);     // camera up, rolled with the road
  private ready = false;

  // --- smoothed state ----------------------------------------------------
  private driftSigned = 0;   // -1..1
  private driftAmt = 0;
  private driftVel = { v: 0 };
  private tierAmt = 0;
  private tierVel = { v: 0 };
  private boostAmt = 0;
  private boostVel = { v: 0 };
  private brakeAmt = 0;
  private brakeVel = { v: 0 };
  private airAmt = 0;
  private airVel = { v: 0 };
  private calm = 0;          // 0 = parked/spun, 1 = driving
  private calmVel = { v: 0 };
  private corner = 0;        // -1..1, + = turning right
  private cornerVel = { v: 0 };
  private bend = 0;
  private bendVel = { v: 0 };
  private bankAmt = 0;       // |road tilt|, 0..1
  private bankVel = { v: 0 };
  private lookAmt = 0;
  private lookVel = { v: 0 };
  private lookHold = 0;
  private armFrac = 1;
  private armFracVel = { v: 0 };
  private faceYaw = 0;       // chassis heading, flattened
  private compAng = 0;       // composition, as a camera yaw offset in radians

  // --- transients --------------------------------------------------------
  private fovOsc = new Osc();
  private dip = new Osc();     // landing bob
  private kick = new Osc();    // impact punch along the view axis
  private surge = new Osc();   // boost arm pull
  private trauma = 0;
  private traumaDecay = 3.3;

  // --- cinematics --------------------------------------------------------
  private introT = INTRO_DUR;
  private introAng = 0.5;
  private finishT = 0;
  private orbit = 0;
  private prevState: RaceState = RaceState.Menu;
  /** Which pose built the last frame. A change of pose SOURCE is a change of
   *  shot, and a shot change is a cut in both position and orientation — the
   *  results orbit and the chase rig have nothing to say to each other, and
   *  easing between them at the comfort ceiling spends a second and a quarter
   *  with the subject off frame. The intro is the one exception: it lerps onto
   *  the chase pose deliberately, so its handover is already seamless. */
  private poseKind = 0;
  private prevMode: CamMode | null = null;
  private cutPos = new THREE.Vector3();
  private cutTangent = new THREE.Vector3();

  // --- bookkeeping -------------------------------------------------------
  private aspect = REF_ASPECT;
  private camT = -1;                            // camera's own track station
  private groundY = 0;
  private groundInit = false;
  private prevKart = new THREE.Vector3();
  private prevEye = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  /** Position continuity: false means the lens teleported and the eye-speed
   *  limiter must not try to smooth the jump. */
  private hasPrevEye = false;
  /** Orientation continuity: false means the FRAME is cut — a different shot,
   *  not a camera move — and the slew ceiling does not apply. Deliberately a
   *  separate flag from the one above: a respawn moves the lens but must not
   *  spin it, and treating the two as one event is what turns an ordinary
   *  off-track recovery into a 1800 deg/s whip. */
  private hasPrevQuat = false;
  private sampleFn: SampleFn | null = null;
  private smp: TrackSample | null = null;
  private smpB: TrackSample | null = null;
  private unsub: (() => void) | null = null;

  // --- tunnel roof lookup ------------------------------------------------
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private bore: THREE.Mesh[] = [];
  private boreBox = new THREE.Box3();
  private boreY: Float32Array | null = null;

  // --- trackside furniture ------------------------------------------------
  private props: Float32Array | null = null;
  private propCount = 0;
  private propStage = 0;
  private wideBlockers: THREE.Object3D[] | null = null;

  // =======================================================================
  //  Lifecycle
  // =======================================================================

  init(ctx: Ctx) {
    ctx.camera.near = 0.2;
    ctx.camera.far = 3000;
    this.fovOsc.v = FOV_BASE;
    ctx.camera.fov = FOV_BASE;
    ctx.camera.updateProjectionMatrix();
    this.resize(ctx.width, ctx.height);

    // Bound once. The cast reaches Track's scratch-target overload, which
    // ITrack omits; an implementation without it still returns a correct
    // sample, it just costs one allocation.
    this.sampleFn = (ctx.track.sample as SampleFn).bind(ctx.track);
    this.smp = ctx.track.sample(0);
    this.smpB = ctx.track.sample(0);

    // The tunnel bore is the one occluder that needs a real ray, and it only
    // needs it once: the roof height at every station goes into a table at
    // init, and the frame path does an array lookup.
    ctx.track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || (m as any).isInstancedMesh) return;
      if (!/tunnel|bore/i.test(m.name)) return;
      m.updateWorldMatrix(true, false);
      this.bore.push(m);
      this.boreBox.union(new THREE.Box3().setFromObject(m));
    });
    if (this.bore.length) {
      this.boreBox.expandByScalar(16);
      this.buildBoreCeiling();
    }

    // Screen shake arrives through ctx.shake() -> addShake(); these handlers
    // add only the rig displacements nothing else can produce.
    this.unsub = ctx.bus.on((e) => {
      if (!('kart' in e) || !e.kart?.isPlayer) return;
      switch (e.type) {
        // `impact` is a descent rate in m/s: a drop off the bridge thumps, a
        // kerb hop barely registers.
        case 'land': this.dip.kick(-clamp(e.impact * 0.055, 0, 1.15)); break;
        case 'collide': this.kick.kick(clamp(e.impulse * 0.035, 0, 1.4)); break;
        case 'boost': this.surge.kick(-4.6 - e.tier * 0.9); break;
        case 'hit': this.kick.kick(0.9); break;
      }
    });
  }

  dispose() { this.unsub?.(); this.unsub = null; }

  resize(w: number, h: number) {
    this.aspect = h > 0 && w > 0 ? w / h : REF_ASPECT;
  }

  addShake(a: number, s = 0.3) {
    this.trauma = Math.min(1, this.trauma + a);
    // A longer requested duration means a slower bleed-off, not a timer, so
    // overlapping requests compose instead of the last one winning.
    this.traumaDecay = Math.min(this.traumaDecay, clamp(1 / Math.max(0.08, s), 0.6, 6));
  }

  // =======================================================================
  //  Frame
  // =======================================================================

  lateUpdate(ctx: Ctx, dt: number) {
    const k = ctx.race?.player;
    if (!k || !this.sampleFn) return;
    dt = clamp(dt, 1 / 480, 0.1);

    const mode: CamMode = ((window as any).__camMode as CamMode) || 'chase';
    const state = ctx.race.state;
    this.buildProps(ctx);

    // A harness mode change is a cut, and the lens must be at its new focal
    // length on the very first frame: the composition is solved against the
    // live FOV, and a wide plate composed against a stale 50 degrees puts the
    // subject a third of a frame off where it was asked for.
    if (mode !== this.prevMode) {
      this.fovOsc.v = this.fitFov(mode === 'wide' ? WIDE_FOV : mode === 'close' ? CLOSE_FOV : FOV_BASE);
      this.fovOsc.vel = 0;
      this.prevMode = mode;
      // ...and the rig jumps to the new pose rather than being rate-limited
      // across the forty metres between the plate and the chase. A harness
      // plate is a different shot, so this one really is a cut in both senses.
      this.hasPrevEye = false;
      this.hasPrevQuat = false;
    }

    // --- 1. state scalars -------------------------------------------------
    const speed = Math.abs(k.forwardSpeed);
    const sp = clamp(speed / BASE_TOP_SPEED, 0, 1.25);

    const drifting = k.driftDir !== 0 && !k.airborne;
    // Snap in, ooze out: the composition should change the instant the slide
    // catches and unwind slowly enough that the release reads as a release.
    this.driftSigned = damp1(this.driftSigned, drifting ? k.driftDir : 0, this.driftVel, drifting ? 0.15 : 0.40, dt);
    this.driftAmt = Math.abs(this.driftSigned);
    this.tierAmt = damp1(this.tierAmt, drifting ? clamp(k.driftTier / 3, 0, 1) : 0, this.tierVel, 0.22, dt);

    const boosting = k.boostTime > 0 ? 1 : 0;
    this.boostAmt = damp1(this.boostAmt, boosting, this.boostVel, boosting ? 0.11 : 0.30, dt);
    const braking = ctx.input.state.brake > 0.4 && k.forwardSpeed > 5 ? 1 : 0;
    this.brakeAmt = damp1(this.brakeAmt, braking, this.brakeVel, 0.20, dt);
    // Airborne as a filtered quantity, never a boolean edge: `airborne` flips
    // on the frame a wheel finds the road and a step in the arm on that frame
    // is a jolt at the one moment the player is already being thrown about.
    this.airAmt = damp1(this.airAmt, k.airborne ? 1 : 0, this.airVel, k.airborne ? 0.10 : 0.26, dt);
    // Signed speed, not |speed|: a kart reversing out of a crash is recovering,
    // not driving, and it earns exactly as much composition as a parked one.
    this.calm = damp1(this.calm, smootherstep((Math.max(0, k.forwardSpeed) - CALM_LO) / (CALM_HI - CALM_LO)),
      this.calmVel, 0.28, dt);

    // lookBack is specified as a rising edge but plays as a held button; a
    // short hold window makes both spellings behave sensibly.
    if (ctx.input.state.lookBack) this.lookHold = 0.3; else this.lookHold -= dt;
    const wantLook = this.lookHold > 0 && state === RaceState.Racing && mode === 'chase' ? 1 : 0;
    this.lookAmt = damp1(this.lookAmt, wantLook, this.lookVel, 0.19, dt);

    // --- 2. has the subject been teleported? ------------------------------
    _tmp.copy(k.position).sub(this.prevKart);
    const cut = this.ready
      && _tmp.length() > Math.max(CUT_MIN, (CUT_SPEED + k.velocity.length() * 2.5) * dt);
    this.prevKart.copy(k.position);
    if (!this.ready) this.seed(k);
    else if (cut) {
      this.reseed();
      _face.copy(k.forward); _face.y = 0;
      if (_face.lengthSq() > 1e-6) {
        const y = Math.atan2(_face.x, _face.z);
        if (Math.abs(wrapAngle(this.armYaw - y)) > CUT_TURN) {
          this.armYaw = y;
          this.lagYaw = y;
          this.compAng = 0;
          this.arm.set(_face.x, 0, _face.z).normalize();
          this.hasPrevQuat = false;
        }
      }
    }

    // --- 3. ground frame, bearing, corner ---------------------------------
    const s = this.sampleFn(k.t, this.smp!);
    this.updateUp(s, dt);
    this.updateHeading(ctx, k, s, sp, speed, dt);

    // --- 4. the lens, solved before the composition that reads it ---------
    this.applyFov(ctx, mode, sp, state, dt);

    // --- 5. the pose ------------------------------------------------------
    this.poseChase(ctx, k, sp, dt);
    _chaseEye.copy(_eye);
    // The live chase framing, kept so a cinematic can hand back to gameplay
    // without a seam. Cheap: two dot products and two quaternion applies.
    const _fx = this.frameX(ctx, dt);
    this.frameSubject(ctx, _chaseEye, k, _fx, this.frameY(sp));
    _chaseAim.copy(_aim);

    const cinematic = this.poseCinematic(ctx, k, mode, state, dt);

    if (!cinematic) {
      // Chase: constrain the eye, THEN solve the orientation. Everything that
      // moves the lens gets to move it first, and the composition is built on
      // the pose that is actually rendered from rather than on the one the rig
      // intended — which is the only way the subject's screen position can be
      // a guarantee instead of a hope.
      this.constrainEye(ctx, k, dt);
      this.frameSubject(ctx, _eye, k, _fx, this.frameY(sp));
    }

    this.prevEye.copy(_eye);
    ctx.camera.position.copy(_eye);

    // --- 6. orientation ---------------------------------------------------
    _m.lookAt(_eye, _aim, this.up);
    _qt.setFromRotationMatrix(_m);

    // Screen shake is folded in BEFORE the rate limit, not after, so the ceiling
    // is a promise about the frame the player sees rather than about the rig's
    // intention. A limiter that runs first and a shake that runs second is a
    // limiter that does not limit.
    const shakeAmt = this.stepTrauma(dt);
    if (shakeAmt > 0) {
      const t = ctx.time;
      // Weighted toward ROLL, which is free: rolling about the view axis does
      // not move the axis, so it reads as an impact without spending any of the
      // rotation budget. Yaw and pitch are the expensive ones.
      _euler.set(shakeNoise(t, 1) * shakeAmt * 0.020,
        shakeNoise(t, 2) * shakeAmt * 0.022,
        shakeNoise(t, 3) * shakeAmt * 0.052);
      _q.setFromEuler(_euler);
      _qt.multiply(_q);
    }

    // The comfort ceiling. Note the slerp writes into the camera's quaternion
    // and not back into `_qt`: `_qt.copy(prev).slerp(_qt, t)` slerps toward
    // itself, which silently freezes the orientation forever the first time the
    // limiter fires.
    const ang = this.hasPrevQuat ? this.prevQuat.angleTo(_qt) : 0;
    const maxAng = MAX_SLEW * dt;
    if (ang > maxAng && ang > 1e-6) ctx.camera.quaternion.copy(this.prevQuat).slerp(_qt, maxAng / ang);
    else ctx.camera.quaternion.copy(_qt);
    this.prevQuat.copy(ctx.camera.quaternion);
    this.hasPrevQuat = true;

    if (shakeAmt > 0) {
      const t = ctx.time;
      _tmp.set(shakeNoise(t, 4) * shakeAmt * 0.16, shakeNoise(t, 5) * shakeAmt * 0.14, 0)
        .applyQuaternion(ctx.camera.quaternion);
      ctx.camera.position.add(_tmp);
    }
  }

  /** First frame only: there is no previous shot, so everything starts on the
   *  kart's own pose. */
  private seed(k: IKart) {
    _face.copy(k.forward);
    _face.y = 0;
    if (_face.lengthSq() > 1e-6) {
      _face.normalize();
      this.armYaw = Math.atan2(_face.x, _face.z);
    }
    this.arm.set(Math.sin(this.armYaw), 0, Math.cos(this.armYaw));
    this.lagYaw = this.armYaw;
    this.up.copy(WORLD_UP);
    this.hasPrevQuat = false;
    this.reseed();
    this.ready = true;
  }

  /**
   * A teleport — respawn, re-station, a shell that puts the kart somewhere its
   * own velocity never took it.
   *
   * What jumps is the POSITION. What does NOT jump is the BEARING, and that is
   * the whole point: the eye is rebuilt behind the kart on the bearing it
   * already had, so the view axis is continuous through the teleport and there
   * is no rotation at all on the cut frame. The bearing then converges on the
   * new heading through the ordinary spring and its rate ceiling. Reseeding the
   * bearing instead means the camera rotates by whatever the respawn changed
   * the kart's heading by, in a single frame — measured at 1800 deg/s on an
   * ordinary off-track recovery, which is nausea, not a cut.
   */
  private reseed() {
    this.armVel.v = 0; this.lagVel.v = 0;
    this.armFrac = 1; this.armFracVel.v = 0;
    this.groundInit = false;
    this.camT = -1;
    this.hasPrevEye = false;
    this.dip.reset(); this.kick.reset(); this.surge.reset();
    this.trauma = 0;
    // A respawn drops the kart stationary on the racing line, so the calm fade
    // starts there too rather than inheriting the composition of the crash.
    this.calm = 0; this.calmVel.v = 0;
  }

  // =======================================================================
  //  The bearing
  // =======================================================================

  private updateHeading(ctx: Ctx, k: IKart, s: TrackSample, sp: number, speed: number, dt: number) {
    // Chassis heading, flattened. Yaw is a compass direction; slope has no
    // business leaking into it.
    _face.copy(k.forward); _face.y = 0;
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();
    const faceYaw = Math.atan2(_face.x, _face.z);
    this.faceYaw = faceYaw;

    // --- direction of TRAVEL ----------------------------------------------
    //
    // Measured as an ANGLE and applied as a rotation of the chassis heading,
    // not as a lerp between two unit vectors. A chord lerp realises strictly
    // less than `gain * slip` degrees and saturates at the velocity vector, so
    // there is no way to express "read the slide as further sideways than it
    // physically is" — which is precisely what a kart camera is for.
    let slip = 0;
    _vel.copy(k.velocity); _vel.y = 0;
    const vlen = _vel.length();
    if (vlen > 2) {
      _vel.multiplyScalar(1 / vlen);
      // Reversing, spun out or shelled: the velocity heading would swing the
      // rig through 180 degrees, so it is trusted only while it broadly agrees
      // with where the chassis points.
      const agree = _vel.dot(_face);
      if (agree > 0.2) {
        const gain = clamp((vlen - 2) / 5, 0, 1)
          * (TRAVEL_GAIN + TRAVEL_GAIN_DRIFT * this.driftAmt)
          * clamp((agree - 0.2) / 0.35, 0, 1);
        slip = clamp(wrapAngle(Math.atan2(_vel.x, _vel.z) - faceYaw) * gain, -MAX_SLIP, MAX_SLIP);
      }
    }
    let targetYaw = wrapAngle(faceYaw + slip);

    // --- below walking pace, follow the ROAD ------------------------------
    //
    // Under CALM_HI there is no velocity heading to trust, so the target would
    // be the chassis — and a chassis that has been shunted or spun yaws at two
    // to four hundred degrees a second. Lag does not help: a critically-damped
    // filter chasing a constant-rate target tracks at the SAME rate and merely
    // shifts the phase. Pointing at the centreline does help, and it is also
    // what the player needs at that moment: to see where the track goes.
    const road = (1 - this.calm) * HEAD_ROAD;
    if (road > 1e-3) {
      _tmp.copy(s.tangent); _tmp.y = 0;
      if (_tmp.lengthSq() > 1e-6) {
        _tmp.normalize();
        // Antipodal is ambiguous — there is no short way round — so leave a
        // kart pointing backwards to the physics rather than picking a side.
        if (_tmp.dot(_face) > -0.94) {
          targetYaw = wrapAngle(targetYaw + wrapAngle(Math.atan2(_tmp.x, _tmp.z) - targetYaw) * road);
        }
      }
    }

    // --- the spring, and the two bounds -----------------------------------
    //
    // The spring is run on the ERROR rather than on the absolute angle, which
    // is what makes it wrap correctly through +-pi. Tracking a target that
    // yaws at w it settles at a standing error of w * tau — that standing
    // error IS the trailing lag, and it is the whole feel of the rig.
    const tau = HEAD_TAU
      + HEAD_TAU_DRIFT * this.driftAmt
      + HEAD_TAU_CORNER * Math.abs(this.corner)
      + HEAD_TAU_CALM * (1 - this.calm);
    const err = damp1(wrapAngle(this.armYaw - targetYaw), 0, this.armVel, tau, dt);

    // Bound 1: never more than MAX_LAG off the CHASSIS. Stated against the
    // chassis and not against the travel heading on purpose — the travel
    // heading is already up to MAX_SLIP away, and two allowances in series is
    // how a rig ends up most of a turn behind a kart that turned a quarter of
    // one. This is the guarantee that the player can see where they are going.
    let want = wrapAngle(targetYaw + err);
    const chassisErr = wrapAngle(want - faceYaw);
    if (Math.abs(chassisErr) > MAX_LAG) {
      want = wrapAngle(faceYaw + (chassisErr > 0 ? MAX_LAG : -MAX_LAG));
      // The spring stored the velocity that produced the excess; leaving it
      // intact means it pushes straight back out next frame.
      this.armVel.v *= 0.2;
    }

    // Bound 2: a rate ceiling, lifted while the bearing is genuinely behind.
    let step = wrapAngle(want - this.armYaw);
    const lost = Math.abs(wrapAngle(this.armYaw - faceYaw)) > MAX_LAG;
    const maxStep = (lost ? MAX_ARM_RATE_LOST : MAX_ARM_RATE) * dt;
    if (step > maxStep) step = maxStep; else if (step < -maxStep) step = -maxStep;
    this.armYaw = wrapAngle(this.armYaw + step);
    this.arm.set(Math.sin(this.armYaw), 0, Math.cos(this.armYaw));

    // --- how hard are we cornering, really --------------------------------
    //
    // The yaw rate of the travel heading times road speed is lateral
    // acceleration in m/s^2: the number the driver's inner ear reports, and
    // therefore the number the frame should be composed around. Differentiated
    // against a fixed-time-constant lag rather than against last frame, so the
    // noise floor is the same at 30 Hz and at 120.
    this.lagYaw = wrapAngle(targetYaw + damp1(wrapAngle(this.lagYaw - targetYaw), 0, this.lagVel, HEAD_RATE_TAU, dt));
    // + = turning right. yaw = atan2(x, z) increases to the LEFT, hence the
    // sign flip; `right` below is cross(forward, up), which is the convention
    // three.js builds its camera basis with.
    const yawRate = clamp(-wrapAngle(targetYaw - this.lagYaw) / HEAD_RATE_TAU, -CORNER_RATE_MAX, CORNER_RATE_MAX);

    // Blended with the bend of the road ahead so the frame starts recomposing
    // on the approach instead of at the apex.
    _right.crossVectors(this.arm, WORLD_UP);
    if (_right.lengthSq() > 1e-6) _right.normalize(); else _right.set(1, 0, 0);
    const ahead = (CORNER_LOOK + CORNER_LOOK_SPEED * sp) / Math.max(1, ctx.track.length);
    const sA = this.sampleFn!(k.t + ahead, this.smpB!);
    _tmp.copy(sA.tangent); _tmp.y = 0;
    const bendRaw = _tmp.lengthSq() > 1e-6 ? clamp(_tmp.normalize().dot(_right), -1, 1) : 0;
    this.bend = damp1(this.bend, bendRaw, this.bendVel, 0.26, dt);

    // The anticipation is faded with road speed: `bend` is a fact about the
    // road, not about the kart, so on its own it composes a full corner for a
    // kart sitting still on the entry to one.
    const target = clamp(
      (yawRate * speed / CORNER_G_FULL) * CORNER_MEASURED + this.bend * CORNER_ANTICIPATED * this.calm,
      -1, 1,
    );
    const nextCorner = damp1(this.corner, target, this.cornerVel, CORNER_TAU, dt);
    this.corner += clamp(nextCorner - this.corner, -CORNER_MAX_RATE * dt, CORNER_MAX_RATE * dt);

    // Road tilt, for the arm's bank climb. Faded out in the air, where the
    // road under the kart is not the plane it is travelling in.
    this.bankAmt = damp1(this.bankAmt, Math.min(1, Math.abs(s.bank) / 0.30) * (1 - this.airAmt),
      this.bankVel, 0.30, dt);
  }

  // =======================================================================
  //  Up vector — the road's roll, partially, with a rate ceiling
  // =======================================================================

  private updateUp(s: TrackSample, dt: number) {
    // Partial by design. A rig glued 1:1 to the road plane renders a banked
    // corner as a level frame with level palms and level fence posts, which is
    // the one thing a banked corner must never look like. In the air the road
    // under the kart says nothing about the frame, so it fades out.
    _up.copy(WORLD_UP).lerp(s.normal, BANK_GAIN * (1 - this.airAmt));
    if (_up.lengthSq() < 1e-6 || _up.y < 0.2) _up.copy(WORLD_UP); else _up.normalize();

    // Dutch: lean into the corner and into the slide. A positive rotation about
    // the arm tilts the up vector to the rig's right, which is the direction a
    // motorbike leans in a right-hander.
    const lean = clamp(this.corner * CORNER_ROLL + this.driftSigned * DRIFT_ROLL * (0.6 + 0.4 * this.tierAmt),
      -MAX_ROLL, MAX_ROLL);
    if (Math.abs(lean) > 1e-4) {
      _q.setFromAxisAngle(this.arm, lean);
      _up.applyQuaternion(_q);
    }

    // Rate-limited chase. This is the only filter on the horizon, and it is a
    // ceiling rather than a spring so that a step in the road normal — a kerb,
    // a re-station, a landing — cannot become a barrel roll.
    _axis.crossVectors(this.up, _up);
    const sn = _axis.length();
    const cs = clamp(this.up.dot(_up), -1, 1);
    const ang = Math.atan2(sn, cs);
    if (ang > 1e-5 && sn > 1e-6) {
      const step = Math.min(ang, MAX_ROLL_RATE * dt);
      _axis.multiplyScalar(1 / sn);
      _q.setFromAxisAngle(_axis, step);
      this.up.applyQuaternion(_q).normalize();
    }
  }

  // =======================================================================
  //  The chase pose
  // =======================================================================

  private poseChase(ctx: Ctx, k: IKart, sp: number, dt: number) {
    const surge = this.surge.step(0, BOOST_SURGE_OMEGA, BOOST_SURGE_ZETA, dt);
    const boost = this.boostAmt * (1 - this.lookAmt);

    _pivot.copy(k.position).addScaledVector(this.up, PIVOT_UP);

    // Look-back swings the whole rig around the pivot rather than flipping the
    // aim, so coming back is a real move instead of a cut. Applied here, after
    // the bearing's bounds, because a deliberate 180 is not lag.
    _dir.copy(this.arm);
    if (this.lookAmt > 1e-3) {
      _q.setFromAxisAngle(this.up, Math.PI * this.lookAmt);
      _dir.applyQuaternion(_q);
    }

    let dist = ARM_DIST + feel.armDistSpeed * sp
      + surge * BOOST_SURGE_DIST
      - boost * BOOST_DIST
      - this.brakeAmt * BRAKE_DIST
      + this.driftAmt * DRIFT_DIST
      - this.lookAmt * 1.4;
    let height = ARM_HEIGHT + feel.armHeightSpeed * sp
      + surge * BOOST_SURGE_HEIGHT
      - boost * BOOST_HEIGHT
      - this.brakeAmt * BRAKE_HEIGHT
      + this.driftAmt * DRIFT_HEIGHT
      + this.airAmt * AIR_HEIGHT
      + this.bankAmt * BANK_HEIGHT * (1 - this.lookAmt)
      + this.lookAmt * 0.25;
    dist = Math.max(2.2, dist);
    height = Math.max(0.35, height);

    // Sweep the arm against ground, barriers, the tunnel roof and furniture,
    // and shorten it to the usable fraction. Filtered so it cannot pump, and
    // asymmetrically: pulling in fast is a safety response, easing back out
    // slowly is what reads as a spring arm.
    const want = this.sweepArm(ctx, k, _pivot, _dir, dist, height);
    this.armFrac = damp1(this.armFrac, want, this.armFracVel,
      want < this.armFrac ? ARM_FRAC_IN : ARM_FRAC_OUT, dt);
    const f = clamp(this.armFrac, 0.18, 1);

    _eye.copy(_pivot).addScaledVector(_dir, -dist * f).addScaledVector(this.up, height * f);

    // The landing dip and the impact kick sit outside everything else, because
    // they are supposed to read as hits rather than as camera moves.
    const dip = this.dip.step(0, 15, 0.42, dt);
    const kickV = this.kick.step(0, 21, 0.36, dt);
    _eye.addScaledVector(this.up, dip * 6.0).addScaledVector(_dir, kickV * 8.0);
  }

  /**
   * Lateral composition, NDC. See FRAME_LAG_CANCEL.
   *
   * Solved as an ANGLE and converted against the live lens, so the shot is the
   * same on every aspect ratio and at every focal length: the same three
   * degrees of lead is the same three degrees whether the field is 62 or 100
   * degrees wide. Then clamped in NDC, because the one thing the angle cannot
   * be allowed to do is walk the subject off the frame.
   */
  private frameX(ctx: Ctx, dt: number) {
    // + = the bearing is trailing to the left of the chassis, i.e. a right-hand
    // corner. Rotating the lens by -FRAME_LAG_CANCEL of that points it back
    // down the chassis heading.
    let want = -FRAME_LAG_CANCEL * wrapAngle(this.armYaw - this.faceYaw)
      - FRAME_BEND * this.bend * this.calm
      - FRAME_DRIFT * this.driftSigned * this.tierAmt;
    if (this.lookAmt > 0.5) want = 0;
    this.compAng += clamp(want - this.compAng, -FRAME_ANG_RATE * dt, FRAME_ANG_RATE * dt);

    const tanV = Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) * 0.5);
    const tanH = tanV * (ctx.height > 0 ? ctx.width / ctx.height : REF_ASPECT);
    return clamp(Math.tan(this.compAng) / tanH, -FRAME_X_MAX, FRAME_X_MAX);
  }

  /** Vertical composition, NDC. */
  private frameY(sp: number) {
    return clamp(FRAME_Y + FRAME_Y_SPEED * sp + FRAME_Y_DRIFT * this.driftAmt, FRAME_Y_MIN, FRAME_Y_MAX);
  }

  // =======================================================================
  //  Hard constraints on the pose that is actually rendered from
  // =======================================================================

  private constrainEye(ctx: Ctx, k: IKart, dt: number) {
    // Order matters. The rate limit applies to the FREE motion — the pose, the
    // dip, the kick — and the constraints are applied to the result. A
    // constraint is not a move: it is the statement that the lens cannot be
    // here, and it has to win outright or it does nothing at all. Run the other
    // way round, the one thing whose job is to get the lens out of solid matter
    // is immediately undone by a clamp pulling it back toward where it came
    // from.
    if (this.hasPrevEye) {
      // Measured RELATIVE TO THE KART, so following it down a straight at
      // 30 m/s costs nothing against the budget and only the rig's own motion
      // is charged.
      _tmp.copy(_eye).sub(this.prevEye).addScaledVector(k.velocity, -dt);
      const len = _tmp.length();
      const maxStep = MAX_EYE_SLIP * dt;
      if (len > maxStep) _eye.sub(_tmp.multiplyScalar(1 - maxStep / len));
    }
    this.hasPrevEye = true;

    // Range. During a spin the bearing rotates around the kart and a straight
    // path between two poses cuts the chord; without this the lens can pass
    // within a metre of the chassis and the kart goes through the near plane.
    _tmp.copy(_eye).sub(k.position);
    const r = _tmp.length();
    if (r < MIN_RANGE) {
      if (r > 1e-3) _eye.copy(k.position).addScaledVector(_tmp, MIN_RANGE / r);
      else _eye.copy(k.position).addScaledVector(this.arm, -MIN_RANGE);
    }

    // Ground. Probed with the CAMERA's own station: hinting with the kart's is
    // how a search re-stations across a loop and reports a cliff face where
    // there is road.
    const under = ctx.track.probe(_eye, this.camT >= 0 ? this.camT : k.t);
    const gap = Math.abs(((((under.t - k.t + 0.5) % 1) + 1) % 1) - 0.5);
    this.camT = gap < 0.05 ? under.t : k.t;
    // Rate-limited: a hinted search that re-stations reports a terrain height
    // metres from the last one, and feeding that straight into a floor is a
    // teleport, not a floor.
    if (!this.groundInit) { this.groundY = under.y; this.groundInit = true; }
    else {
      const stepY = 26 * dt;
      this.groundY = clamp(under.y, this.groundY - stepY, this.groundY + stepY);
    }
    const floorY = this.groundY + GROUND_CLEAR;
    if (_eye.y < floorY) _eye.y = floorY;

    // Tunnel roof, from the table built at init.
    const ceilY = this.ceilingAt(this.camT >= 0 ? this.camT : k.t);
    if (_eye.y > ceilY && ceilY > floorY) _eye.y = ceilY;

    // Barriers, then furniture.
    const wall = ctx.track.collideWalls(_eye, CAM_RADIUS, this.camT >= 0 ? this.camT : k.t);
    if (wall) _eye.add(wall.push);
    this.propPush(_eye, k.position, CAM_RADIUS, k.velocity);
  }

  /**
   * Usable fraction of the arm the pose asked for.
   *
   * Terrain, barriers and the tunnel roof are walked as stations; furniture is
   * one exact segment test, because a sign is 0.2 m thick and station sampling
   * steps straight through it four times out of five.
   */
  private sweepArm(ctx: Ctx, k: IKart, pivot: THREE.Vector3, dir: THREE.Vector3, dist: number, height: number) {
    let frac = 1;
    const hint = this.camT >= 0 ? this.camT : k.t;

    for (let i = 1; i <= SWEEP_STATIONS; i++) {
      const u = i / SWEEP_STATIONS;
      _tmp.copy(pivot).addScaledVector(dir, -dist * u).addScaledVector(this.up, height * u);
      const pr = ctx.track.probe(_tmp, hint);
      // Clearance is relaxed near the pivot: the arm is under two metres tall,
      // so a station a metre behind the kart legitimately sits low, and a flat
      // clearance there means every crest slams the arm in and the rig pumps.
      const clear = GROUND_CLEAR * (0.45 + 0.55 * u);
      if (_tmp.y < pr.y + clear || ctx.track.collideWalls(_tmp, CAM_RADIUS, hint)) { frac = (i - 1) / SWEEP_STATIONS; break; }
      if (_tmp.y > this.ceilingAt(pr.t)) { frac = (i - 1) / SWEEP_STATIONS; break; }
    }

    if (this.props) {
      _tmp.copy(pivot).addScaledVector(dir, -dist).addScaledVector(this.up, height);
      const tp = this.propSegment(pivot, _tmp, CAM_RADIUS);
      // Floored, which terrain and walls deliberately are not. Those two answer
      // for ground and barriers, and an eye inside a hill has no acceptable
      // framing at all; furniture is thin, beside the road, and there is a
      // whole line of it down every interesting straight. Unfloored, this
      // amputates the signature shot every time a sign goes past.
      if (tp < 1) frac = Math.min(frac, Math.max(PROP_ARM_MIN_FRAC, tp - 0.07));
    }
    return frac;
  }

  // =======================================================================
  //  Composition — solved, not sprung
  // =======================================================================

  /**
   * Build the view axis that puts `k` at exactly (fx, fy) in NDC, given a final
   * eye position.
   *
   * There is no search and no feedback here. A point at NDC (fx, fy) sits along
   * the direction `forward + fx*tanH*right + fy*tanV*up` in camera space, so
   * the inverse is two rotations of the eye->subject vector: yaw by
   * atan(fx * tanH) about the camera up, then pitch by -atan(fy * tanV) about
   * the camera right. Do those and the subject lands where it was asked for, on
   * the first frame, at any aspect ratio and any focal length.
   *
   * The consequence worth stating: the subject's screen position is no longer
   * an emergent property of eleven filters that have never heard of it. It is
   * an INPUT. `frameX` cannot be exceeded, so "the kart left the screen" is not
   * a failure mode this rig has.
   */
  private frameSubject(ctx: Ctx, eye: THREE.Vector3, k: IKart, fx: number, fy: number) {
    _pt.copy(k.position).addScaledVector(this.up, SUBJ_UP);
    _dir.copy(_pt).sub(eye);
    const r = _dir.length();
    if (r < 1e-3) { _aim.copy(_pt); return; }
    _dir.multiplyScalar(1 / r);

    const tanV = Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) * 0.5);
    const tanH = tanV * (ctx.height > 0 ? ctx.width / ctx.height : REF_ASPECT);

    // Basis about the eye->subject ray, in the rolled frame the player sees.
    _right.crossVectors(_dir, this.up);
    if (_right.lengthSq() < 1e-6) { _aim.copy(eye).addScaledVector(_dir, r); return; }
    _right.normalize();
    _up.crossVectors(_right, _dir).normalize();

    // Yaw first, then pitch about the yawed right vector. The two rotations do
    // not commute, but at these angles the coupling error is under a fifth of a
    // degree, which is a hundred times smaller than anything the eye reads.
    _q.setFromAxisAngle(_up, Math.atan(fx * tanH));
    _dir.applyQuaternion(_q);
    _right.crossVectors(_dir, this.up);
    if (_right.lengthSq() > 1e-6) {
      _right.normalize();
      _q.setFromAxisAngle(_right, -Math.atan(fy * tanV));
      _dir.applyQuaternion(_q);
    }

    _aim.copy(eye).addScaledVector(_dir, r);
  }

  // =======================================================================
  //  Cinematics — countdown, finish, results, and the two harness plates
  // =======================================================================

  /** Returns true if a cinematic owns the frame (i.e. `_eye`/`_aim` are set). */
  private poseCinematic(ctx: Ctx, k: IKart, mode: CamMode, state: RaceState, dt: number): boolean {
    const kind = this.pickPose(ctx, k, mode, state, dt);
    if (kind !== this.poseKind) {
      // POSE_INTRO -> POSE_CHASE is the one seamless handover in the file.
      if (!(this.poseKind === POSE_INTRO && kind === POSE_CHASE)) {
        this.hasPrevEye = false;
        this.hasPrevQuat = false;
      }
      this.poseKind = kind;
    }
    return kind !== POSE_CHASE;
  }

  private pickPose(ctx: Ctx, k: IKart, mode: CamMode, state: RaceState, dt: number): number {
    // Harness modes win outright: they are portfolio frames, not gameplay, and
    // must not be hijacked by a race-state cinematic.
    if (mode === 'wide') { this.poseWide(ctx, k); return POSE_WIDE; }
    if (mode === 'close') { this.poseClose(ctx, k); return POSE_CLOSE; }

    if (state === RaceState.Countdown && this.prevState !== RaceState.Countdown) {
      this.introT = 0;
      this.chooseIntroBearing(ctx);
    }
    if (state === RaceState.Finished && this.prevState !== RaceState.Finished) {
      this.finishT = 0;
      this.captureFinishCut(ctx, k);
    }
    if (state === RaceState.Results && this.prevState !== RaceState.Results) this.orbit = 0;
    this.prevState = state;

    if (state === RaceState.Results || state === RaceState.Menu) { this.poseOrbit(ctx, k, state === RaceState.Menu, dt); return POSE_ORBIT; }
    if (state === RaceState.Finished) { this.finishT += dt; this.poseFinish(k); return POSE_FINISH; }

    // The countdown pose holds through the GO frame and releases the instant
    // the player is actually driving, so the intro can never eat the race.
    const live = state === RaceState.Countdown
      || (this.introT < INTRO_DUR && state === RaceState.Racing && Math.abs(k.forwardSpeed) < 2.5);
    if (this.introT < INTRO_DUR) {
      // A player already at racing speed has been driving for a while; whatever
      // the countdown was doing, the fly-in is over. Without this the intro can
      // still own the frame a second and a half into a race that has plainly
      // started — which is exactly what a mid-countdown reset produces.
      if (state === RaceState.Racing && Math.abs(k.forwardSpeed) > 8) this.introT = INTRO_DUR;
      else this.introT += live ? dt : dt * 2.6;   // released early: hurry the settle
      const p = clamp(this.introT / INTRO_DUR, 0, 1);
      if (p < 1) { this.poseIntro(ctx, k, p); return POSE_INTRO; }
    }
    return POSE_CHASE;
  }

  /**
   * Bearing for the countdown hold, chosen once when the intro arms.
   *
   * The sun is fixed by the art bible (low, roughly west), so the grid shot is
   * composed AGAINST it rather than in ignorance of it: score a fan of
   * candidate bearings on how far the lens points away from the sun and how
   * close to head-on it stays, and take the best. On a start straight running
   * away from the sun this picks a near-head-on 20-30 degrees; on one running
   * into it, it swings out until the sun rakes the grid from the side and
   * rim-lights the field instead of burning through it.
   */
  private chooseIntroBearing(ctx: Ctx) {
    _tmp.copy(ctx.sunDirection); _tmp.y = 0;
    if (_tmp.lengthSq() < 1e-6) { this.introAng = 0.5; return; }
    _tmp.normalize();
    _right.crossVectors(this.arm, WORLD_UP);
    if (_right.lengthSq() < 1e-6) { this.introAng = 0.5; return; }
    _right.normalize();
    const sunFwd = _tmp.dot(this.arm);
    const sunRight = _tmp.dot(_right);

    let best = 0.5;
    let bestScore = -1e9;
    for (let i = 0; i < 12; i++) {
      const a = (i < 6 ? 1 : -1) * (0.34 + (i % 6) * 0.142);   // 20 to 60 degrees off head-on
      const look = -Math.cos(a) * sunFwd + Math.sin(a) * sunRight;
      const score = -Math.max(0, look - 0.30) * 7 - Math.abs(a) * 0.5;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    this.introAng = best;
  }

  private poseIntro(ctx: Ctx, k: IKart, p: number) {
    // Two beats: a held front three-quarter of the grid — the shot that sells
    // the field — then a sweep round the flank landing exactly on the chase
    // pose as the lights go out. Low and near head-on, because the player is
    // always pole: a lens in front of the player is a lens in front of the
    // whole field, and the eight karts stack into rows instead of trailing off
    // to a vanishing point.
    const front = smootherstep(clamp(p / 0.62, 0, 1));
    const settle = smootherstep(clamp((p - 0.58) / 0.42, 0, 1));

    const side = this.introAng >= 0 ? 1 : -1;
    const hold = this.introAng * (0.86 + front * 0.14);
    const ang = hold + (side * 2.95 - hold) * settle;
    const dist = 16.6 - front * 4.1 - settle * 4.4;
    const height = 2.05 - front * 0.35 - settle * 0.16;

    _q.setFromAxisAngle(WORLD_UP, ang);
    _dir.copy(this.arm).applyQuaternion(_q);
    _eye.copy(k.position).addScaledVector(_dir, dist).addScaledVector(WORLD_UP, height);
    _aim.copy(k.position).addScaledVector(WORLD_UP, 1.05 + settle * 0.5).addScaledVector(this.arm, -5.0);

    // A kerb-height lens swung well off the racing axis can end up behind a
    // barrier; there is no arm sweep out here to catch it, so one analytic
    // wall query puts it back on the tarmac.
    const wall = ctx.track.collideWalls(_eye, CAM_RADIUS, k.t);
    if (wall) _eye.add(wall.push);

    // Ease home so the handover to gameplay has no seam.
    _eye.lerp(_chaseEye, settle);
    _aim.lerp(_chaseAim, settle);
  }

  private captureFinishCut(ctx: Ctx, k: IKart) {
    const s = this.sampleFn!(k.t + 0.004, this.smpB!);
    const pr = ctx.track.probe(k.position, k.t);
    const side = pr.lateral >= 0 ? 1 : -1;   // stand on the outside of the kart
    this.cutPos.copy(s.pos)
      .addScaledVector(s.binormal, side * (s.halfWidth + 8.5))
      .addScaledVector(s.normal, 3.4);
    this.cutTangent.copy(s.tangent);
    // The finish is a real cut to a trackside camera: both position and
    // orientation change outright, because it is a different shot.
    this.hasPrevEye = false;
    this.hasPrevQuat = false;
  }

  private poseFinish(k: IKart) {
    if (this.finishT < FINISH_HOLD) {
      // Trackside, dollying gently with the kart so it does not simply leave.
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, this.finishT * 3.2);
      _aim.copy(k.position).addScaledVector(WORLD_UP, 0.9);
    } else {
      // Then rise into a wide victory-lap chase.
      const w = smootherstep((this.finishT - FINISH_HOLD) / 1.6);
      _tmp.copy(k.position).addScaledVector(this.arm, -11.5).addScaledVector(WORLD_UP, 5.6);
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, FINISH_HOLD * 3.2).lerp(_tmp, w);
      _aim.copy(k.position).addScaledVector(WORLD_UP, 0.9).addScaledVector(this.arm, 4.0 * w);
    }
  }

  private poseOrbit(ctx: Ctx, player: IKart, wide: boolean, dt: number) {
    const winner = (ctx.race.standings && ctx.race.standings[0]) || player;
    this.orbit += dt * (wide ? 0.13 : 0.2);
    _q.setFromAxisAngle(WORLD_UP, this.orbit);
    _dir.set(0, 0, 1).applyQuaternion(_q);
    _eye.copy(winner.position)
      .addScaledVector(_dir, wide ? 13.5 : 8.4)
      .addScaledVector(WORLD_UP, (wide ? 4.6 : 2.9) + Math.sin(this.orbit * 1.7) * 0.35);
    _aim.copy(winner.position).addScaledVector(WORLD_UP, wide ? 1.4 : 0.95);
  }

  /**
   * The establishing plate. A long lens from a short range rather than a wide
   * lens from a long one: at 200 m a kart is four pixels, so the shot picks a
   * subject. 42 m at 31 degrees sees a 23 m ground footprint, which puts the
   * kart at 9-10% of frame height.
   *
   * The elevation is VERIFIED clear rather than assumed. The village terrace on
   * the seaward side is 15-20 m tall, and a plate composed at a fixed 20 degree
   * depression is a picture of a roofline with the two saturated objects in the
   * scene behind it.
   */
  private poseWide(ctx: Ctx, k: IKart) {
    this.ensureWideBlockers(ctx);
    // Aim at the ribbon a little ahead of the player, lerped toward the sampled
    // centreline rather than offset from the kart, so the racing line runs
    // through the frame even when the player is out wide.
    //
    // Held in `_aim` and not in `_pt`, deliberately: subjectOccluded writes
    // `_pt`, and the escalation loop below re-reads the anchor on every
    // iteration.
    const s = this.sampleFn!(k.t + 13 / Math.max(1, ctx.track.length), this.smpB!);
    _aim.copy(k.position).lerp(s.pos, 0.8).addScaledVector(WORLD_UP, 2.2);

    _q.setFromAxisAngle(WORLD_UP, 0.78);
    _dir.copy(this.arm).applyQuaternion(_q);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1); else _dir.normalize();

    let elev = 0.55;                              // ~31 degrees
    for (let i = 0; i < 7; i++) {
      _eye.copy(_aim)
        .addScaledVector(_dir, -WIDE_RANGE * Math.cos(elev))
        .addScaledVector(WORLD_UP, WIDE_RANGE * Math.sin(elev));
      const pr = ctx.track.probe(_eye, k.t);
      if (_eye.y < pr.y + 8) _eye.y = pr.y + 8;
      if (!this.subjectOccluded(k)) break;
      elev += 0.115;
      if (elev > 1.25) break;                     // 72 degrees is already a map
    }

    // Put the kart on the side of frame it is driving AWAY from, so the racing
    // line occupies the two thirds it is heading into.
    _right.crossVectors(_dir, WORLD_UP);
    if (_right.lengthSq() > 1e-6) _right.normalize(); else _right.set(1, 0, 0);
    const side = s.tangent.dot(_right) >= 0 ? -1 : 1;
    this.up.copy(WORLD_UP);
    this.frameSubject(ctx, _eye, k, side * WIDE_FRAME_X, WIDE_FRAME_Y);
  }

  /**
   * The hero close-up: a front three-quarter locked to the chassis rather than
   * to the travel heading, so the model always presents the same face. The lens
   * gets UNDER the roll bar and tilts up, which swings the horizon up behind
   * the kart and makes the background sky and sea rather than receding tarmac.
   */
  private poseClose(ctx: Ctx, k: IKart) {
    _face.copy(k.forward); _face.y = 0;
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();
    _q.setFromAxisAngle(WORLD_UP, 0.66);
    _dir.copy(_face).applyQuaternion(_q);
    _eye.copy(k.position).addScaledVector(_dir, 3.6).addScaledVector(WORLD_UP, 0.62);
    _aim.copy(k.position).addScaledVector(WORLD_UP, 0.86).addScaledVector(_face, 0.2);
    this.up.copy(WORLD_UP);
  }

  // =======================================================================
  //  Shake and lens
  // =======================================================================

  /** Decays the trauma and returns the shake amplitude, 0 when there is none.
   *  Squared falloff: small knocks stay subtle, big ones hit hard. */
  private stepTrauma(dt: number) {
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return 0; }
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return 0; }
    return this.trauma * this.trauma;
  }

  /**
   * Turn a requested vertical field into one this aspect can carry: solve
   * horizontal from the request, clamp it, solve back, clamp the vertical. The
   * two failure modes are different in kind — too much horizontal is a fisheye
   * that shrinks the subject, too little is a telephoto that hides the corner —
   * so both bounds are needed and at 16:9 neither binds.
   */
  private fitFov(v: number): number {
    const a = this.aspect;
    let vv = clamp(v, FOV_V_MIN, FOV_V_MAX);
    const hDeg = (2 * Math.atan(Math.tan((vv * Math.PI) / 360) * a) * 180) / Math.PI;
    const hClamped = clamp(hDeg, FOV_H_MIN, FOV_H_MAX);
    if (hClamped !== hDeg) vv = (2 * Math.atan(Math.tan((hClamped * Math.PI) / 360) / a) * 180) / Math.PI;
    return clamp(vv, FOV_V_MIN, FOV_V_MAX);
  }

  private applyFov(ctx: Ctx, mode: CamMode, sp: number, state: RaceState, dt: number) {
    let target: number;
    let omega = 11;
    let zeta = 0.62;   // underdamped on purpose: the lens rubber-bands back
                       // after a boost, and that overshoot is what sells it

    if (mode === 'wide') { target = WIDE_FOV; omega = 8; zeta = 1; }
    else if (mode === 'close') { target = CLOSE_FOV; omega = 8; zeta = 1; }
    else if (state === RaceState.Results || state === RaceState.Menu) { target = 40; omega = 7; zeta = 1; }
    else if (this.introT < INTRO_DUR) {
      // A long lens on the hold beat, opening only as the rig settles: the grid
      // shot lives or dies on compression. At 40 degrees eight karts stack into
      // rows; at 50 they fan out and stop reading as a pack.
      target = 40 + (FOV_BASE - 40) * smootherstep(clamp((this.introT / INTRO_DUR - 0.58) / 0.42, 0, 1));
      omega = 7; zeta = 1;
    } else {
      target = clamp(
        FOV_BASE
        + sp * feel.fovSpeed
        + ctx.fovPunch * FOV_BOOST
        + this.lookAmt * 3.0
        + Math.abs(this.corner) * FOV_CORNER
        - this.brakeAmt * FOV_BRAKE,
        36, 70,
      );
    }
    const fov = this.fovOsc.step(this.fitFov(target), omega, zeta, dt);
    if (Math.abs(fov - ctx.camera.fov) > 0.015) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
  }

  // =======================================================================
  //  Tunnel roof table
  // =======================================================================

  /** One ray straight up from the road at every station, once, at init. */
  private buildBoreCeiling() {
    const n = BORE_STATIONS;
    const out = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      out[i] = Infinity;
      const s = this.sampleFn!(i / n, this.smp!);
      _tmp.copy(s.pos).addScaledVector(s.normal, 0.3);
      if (!this.boreBox.containsPoint(_tmp)) continue;
      _tmp2.copy(s.normal);
      if (_tmp2.y < 0.2) _tmp2.copy(WORLD_UP);
      this.ray.set(_tmp, _tmp2);
      this.ray.near = 0.2;
      this.ray.far = 40;
      this.hits.length = 0;
      this.ray.intersectObjects(this.bore, false, this.hits);
      if (this.hits.length) { out[i] = this.hits[0].point.y - BORE_CLEAR; any = true; }
    }
    this.boreY = any ? out : null;
  }

  /** Roof height above `t`, +Infinity where there is no roof. Interpolated, so
   *  the ceiling does not step as the kart drives under it. */
  private ceilingAt(t: number): number {
    const B = this.boreY;
    if (!B) return Infinity;
    const n = B.length;
    let f = (t - Math.floor(t)) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const a = B[i0], b = B[i1];
    if (!isFinite(a) || !isFinite(b)) return Math.min(a, b);
    f -= Math.floor(f);
    return a + (b - a) * f;
  }

  // =======================================================================
  //  Trackside furniture — a flat array of AABBs, built a handful of times
  // =======================================================================

  /**
   * Flatten every solid, ground-planted, camera-sized piece of scenery into a
   * flat Float32Array of world AABBs. Scenery is not all present on frame one
   * and some of it is parented into groups that already exist, so the build is
   * repeated at a few milestones and then never again.
   *
   * Karts are excluded by identity, not by name: they move, so a cached box
   * would be a phantom blocker parked on the grid. Foliage is excluded because
   * a palm's AABB is nine parts air. Anything wider than PROP_MAX_SPAN is
   * architecture, and terrain and walls already answer for that.
   */
  private buildProps(ctx: Ctx) {
    if (this.propStage >= PROP_BUILD_FRAMES.length || ctx.frame < PROP_BUILD_FRAMES[this.propStage]) return;
    this.propStage++;

    const skip = new Set<THREE.Object3D>();
    const karts = ctx.race?.karts;
    if (karts) for (let i = 0; i < karts.length; i++) skip.add(karts[i].object);

    const out: number[] = [];
    const push = (b: THREE.Box3) => {
      if (out.length >= PROP_MAX_COUNT * 6) return;
      const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
      if (!(sx > 0.05 && sy > 0.35 && sz > 0.05)) return;              // decals, mats
      if (sx > PROP_MAX_SPAN || sz > PROP_MAX_SPAN || sy > PROP_MAX_HEIGHT) return;
      out.push(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    };

    ctx.scene.traverse((o) => {
      // traverse() has no skip-subtree, so mark descendants as they are met.
      if (skip.has(o)) return;
      if (o.parent && skip.has(o.parent)) { skip.add(o); return; }
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || !m.visible || !m.geometry) return;
      if (PROP_SKIP.test(m.name)) return;
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) return;
      m.updateWorldMatrix(true, false);

      const inst = m as unknown as THREE.InstancedMesh;
      if ((inst as any).isInstancedMesh) {
        if (inst.count > PROP_MAX_INSTANCES) return;   // kerbs, foliage, crowd
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, _m2);
          _m.multiplyMatrices(m.matrixWorld, _m2);
          push(_box.copy(bb).applyMatrix4(_m));
        }
        return;
      }
      push(_box.copy(bb).applyMatrix4(m.matrixWorld));
    });

    if (out.length) { this.props = new Float32Array(out); this.propCount = out.length / 6; }
  }

  /**
   * Parametric distance along p0 -> p1 at which the segment first enters any
   * box, inflated by `pad`; 1 when clear. A slab test behind a six-compare AABB
   * reject over a flat array: no allocation, no raycaster, no BVH to keep warm.
   */
  private propSegment(p0: THREE.Vector3, p1: THREE.Vector3, pad: number): number {
    const P = this.props;
    if (!P) return 1;
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    // A finite stand-in for 1/0: an exact zero makes the product NaN when the
    // origin sits exactly on a slab plane.
    const ix = dx !== 0 ? 1 / dx : 1e30;
    const iy = dy !== 0 ? 1 / dy : 1e30;
    const iz = dz !== 0 ? 1 / dz : 1e30;
    const qx0 = Math.min(p0.x, p1.x) - pad, qx1 = Math.max(p0.x, p1.x) + pad;
    const qy0 = Math.min(p0.y, p1.y) - pad, qy1 = Math.max(p0.y, p1.y) + pad;
    const qz0 = Math.min(p0.z, p1.z) - pad, qz1 = Math.max(p0.z, p1.z) + pad;

    let best = 1;
    for (let i = 0, o = 0; i < this.propCount; i++, o += 6) {
      const bx0 = P[o], by0 = P[o + 1], bz0 = P[o + 2];
      const bx1 = P[o + 3], by1 = P[o + 4], bz1 = P[o + 5];
      if (bx1 < qx0 || bx0 > qx1 || by1 < qy0 || by0 > qy1 || bz1 < qz0 || bz0 > qz1) continue;

      let t0 = 0, t1 = best;
      let a = (bx0 - pad - p0.x) * ix, b = (bx1 + pad - p0.x) * ix;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;
      a = (by0 - pad - p0.y) * iy; b = (by1 + pad - p0.y) * iy;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;
      a = (bz0 - pad - p0.z) * iz; b = (bz1 + pad - p0.z) * iz;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;

      best = t0;
      if (best <= 0) break;
    }
    return best;
  }

  /**
   * Last resort: resolve the lens out of any box it has ended up inside.
   *
   * The escape is chosen along the direction of TRAVEL. Taking the axis of
   * least penetration instead picks, for a rig moving lengthwise through a
   * roadside box at 30 m/s, the face it just came in through — so the push
   * becomes a wall and pins the lens to a fixed world point while the kart
   * drives away from it. Up is always an exit (furniture is ground-planted) and
   * is the one exit that cannot become a wall.
   */
  private propPush(p: THREE.Vector3, kart: THREE.Vector3, pad: number, travel: THREE.Vector3) {
    const P = this.props;
    if (!P) return;
    const tx = travel.x, tz = travel.z;
    const moving = Math.hypot(tx, tz) > 0.5;
    for (let i = 0, o = 0; i < this.propCount; i++, o += 6) {
      const bx0 = P[o] - pad, by0 = P[o + 1] - pad, bz0 = P[o + 2] - pad;
      const bx1 = P[o + 3] + pad, by1 = P[o + 4] + pad, bz1 = P[o + 5] + pad;
      if (p.x < bx0 || p.x > bx1 || p.y < by0 || p.y > by1 || p.z < bz0 || p.z > bz1) continue;
      // If the KART is in the same box the box is wrong, not the camera.
      if (kart.x >= bx0 && kart.x <= bx1 && kart.z >= bz0 && kart.z <= bz1) continue;

      const py = by1 - p.y;
      const sx = moving ? (tx >= 0 ? 1 : -1) : (p.x - bx0 < bx1 - p.x ? -1 : 1);
      const sz = moving ? (tz >= 0 ? 1 : -1) : (p.z - bz0 < bz1 - p.z ? -1 : 1);
      const px = sx > 0 ? bx1 - p.x : p.x - bx0;
      const pz = sz > 0 ? bz1 - p.z : p.z - bz0;

      if (py <= px * 1.15 && py <= pz * 1.15) { if (py <= PROP_ESCAPE_MAX) p.y = by1; continue; }
      if (px <= pz) {
        if (px <= PROP_ESCAPE_MAX) p.x = sx > 0 ? bx1 : bx0;
        else if (py <= PROP_ESCAPE_MAX) p.y = by1;
        continue;
      }
      if (pz <= PROP_ESCAPE_MAX) p.z = sz > 0 ? bz1 : bz0;
      else if (py <= PROP_ESCAPE_MAX) p.y = by1;
    }
  }

  // --- wide-mode sightline check (harness only, never on a gameplay frame) --

  private ensureWideBlockers(ctx: Ctx) {
    if (this.wideBlockers) return;
    const list: THREE.Object3D[] = [];
    ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || !m.visible || !m.geometry) return;
      if (/sky|cloud|sea|water|ocean|backdrop|horizon|fog|terrain|ground/i.test(m.name)) return;
      const inst = m as unknown as THREE.InstancedMesh;
      if ((inst as any).isInstancedMesh && inst.count > 1500) return;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const r = m.geometry.boundingSphere?.radius ?? 0;
      m.updateWorldMatrix(true, false);
      if (r * _tmp2.setFromMatrixScale(m.matrixWorld).length() * 0.5774 > 500) return;
      list.push(m);
    });
    this.wideBlockers = list;
  }

  /** Three rays spanning the kart's box, cast outward from it so the near clip
   *  skips its own geometry and the far clip stops short of the lens. */
  private subjectOccluded(k: IKart): boolean {
    const list = this.wideBlockers;
    if (!list || list.length === 0) return false;
    for (let i = 0; i < 3; i++) {
      _pt.copy(k.position).addScaledVector(WORLD_UP, i === 1 ? 1.1 : 0.45);
      if (i === 2) _pt.addScaledVector(k.forward, 0.95);
      _tmp.copy(_eye).sub(_pt);
      const len = _tmp.length();
      if (len < 8) return false;
      _tmp.multiplyScalar(1 / len);
      this.ray.set(_pt, _tmp);
      this.ray.near = 3;
      this.ray.far = len - 2;
      this.hits.length = 0;
      this.ray.intersectObjects(list, false, this.hits);
      if (this.hits.length) return true;
    }
    return false;
  }
}
