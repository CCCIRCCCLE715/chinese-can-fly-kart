/**
 * ============================================================================
 *  AI — racing line solver + driver model
 * ============================================================================
 *  Two pieces, deliberately separated:
 *
 *  1. `RacingLine` is solved ONCE at boot. It is a minimum-curvature line
 *     through the corridor (the classic out–in–out falls straight out of
 *     Laplacian relaxation of the lateral offset), biased to a late apex,
 *     then given a speed profile: cornering limit from the local radius and
 *     the banking, followed by a backward pass so every braking zone is
 *     already baked in. The drivers therefore *lift before* the corner rather
 *     than discovering it mid-entry, which is the single biggest difference
 *     between an AI that looks like it can drive and one that does not.
 *
 *  2. `AIDriver` is one racer. It steers at a speed-scaled lookahead point
 *     with a PD controller plus a cross-track term, brakes off the profile,
 *     drifts through anything tight enough to be worth a mini-turbo, biases
 *     its lane around rivals and hazards, decides when to spend its item, and
 *     — importantly — is imperfect: every driver carries a steering-noise
 *     signature, a personal speed ceiling and an occasional genuine mistake.
 *
 *  Nothing here allocates after `init`. Every lookup is a typed-array read.
 * ============================================================================
 */
import * as THREE from 'three';
import { BASE_TOP_SPEED, ItemKind, Surface, type Ctx, type IKart, type ITrack } from '../types';

// --- solver tuning -----------------------------------------------------------
/** node spacing of the baked line, metres */
const NODE_DS = 4;
/** how far inside the kerb the line is allowed to run */
const EDGE_MARGIN = 2.0;
/** relaxation passes for the minimum-curvature solve */
const RELAX_PASSES = 320;
const RELAX_RATE = 0.32;
/** metres the apex is pushed later than the geometric optimum */
const LATE_APEX_SHIFT = 13;
/** arcade gravity — must match Kart.ts, the banking term depends on it */
const GRAVITY = 20;
/** lateral acceleration a kart can hold on clean tarmac, m/s^2 */
const A_LAT = 12.6;
/** braking capability used to build the approach ramps, m/s^2 */
const A_BRAKE = 11.5;
/**
 * ============================================================================
 *  WHY NO RIVAL EVER DRIFTED — the round-1 "every AI kart is on rails" finding
 * ============================================================================
 * The review's read was right and its stated cause was wrong: the AI *was*
 * entering the drift state, several times a lap. It just never survived long
 * enough to bank a tier, so `driftTier` stayed 0 for the whole field, and the
 * entire rival-side effects layer — sparks, tyre smoke, the mini-turbo flame —
 * keys off `driftTier > 0`. Eight karts hopping at every corner entry and
 * sliding for a fifth of a second is indistinguishable, in a screenshot, from
 * eight karts on rails.
 *
 * Three faults, compounding, all of them here:
 *
 *  1. **Entry and release disagreed about how far ahead to look.** Entry tested
 *     the peak curvature over `speed * 0.45` metres (up to 22 m at racing
 *     pace); the hold test re-read it over a fixed 16 m. On a layout whose
 *     curvature schedule is box-blurred over 30 m to make clothoids, a corner
 *     that is over the gate at 22 m is routinely under it at 16 — so the entry
 *     fired and the hold cancelled it on the very next frame. `Kart` takes the
 *     drift button on a rising edge for the hop and needs it *held* to engage
 *     the slide, so what that produced was a hop, no slide, a 0.4 s cooldown,
 *     and then the same thing again 0.4 s later, all the way into the corner.
 *     Both tests now read the same window (`driftSpan`), with the release gate
 *     genuinely below the entry gate so the pair is hysteretic instead of
 *     contradictory.
 *
 *  2. **The gate was set above what the racing line contains.** The centreline
 *     peaks at 0.0153 (the banked 180) and sits in the 0.009-0.012 band through
 *     the harbour sweep, the esses and the cliff; but the drivers steer at the
 *     *minimum-curvature* line, which exists precisely to flatten those. Baked
 *     and measured, the line clears 0.0098 over 264 m of the 1606 m lap and
 *     clears 0.0072 over 475 m. The old gate handed the field about four
 *     seconds of drift per lap each, spread over three corners, in slivers too
 *     short to charge. At 0.0072 the same three corners are long enough to bank
 *     a real tier, which is what puts sparks on screen.
 *
 *  3. **The drift had nowhere to slide to.** A slide costs lateral room — a
 *     median 3.5 m and up to 4.4 m of wash — and the driver was turning in from
 *     the racing line, which at corner *entry* is hard against the OUTSIDE edge
 *     (that is what out-in-out means). So the wash ran straight off the road,
 *     `wide` fired, and the drift was abandoned before tier 1 at 0.9 s. Real
 *     drivers pay for a slide by sacrificing entry radius: the driver now
 *     applies an inside lane bias for as long as it is committed, so the wash
 *     carries it back onto the apex instead of into the barrier. With somewhere
 *     to go, `DRIFT_EDGE_KEEP` can be *raised* to a sane margin rather than
 *     shaved to nothing to buy room the line was never going to give.
 * ============================================================================
 */

/**
 * Curvature at which a corner is worth drifting, measured on the *racing line*.
 * See fault 2 above for why this is 0.0072 and not the centreline number it
 * looks like it should be.
 */
const DRIFT_MIN_CURV = 0.0072;
/**
 * Curvature at which a committed drift is released. Strictly below
 * `DRIFT_MIN_CURV` and read over the same window, so the pair is hysteretic:
 * entering can never immediately satisfy the exit test.
 */
const DRIFT_EXIT_CURV = 0.0048;
/**
 * How much road the driver insists on keeping under the outside wheels before
 * it abandons a drift, metres inside the road edge.
 *
 * 1.0, not 0.6. The old number was shaved down trying to buy wash room out of
 * the safety margin, which is the wrong pocket — the room comes from turning in
 * further inside (`DRIFT_INSIDE_BIAS`), and with that in place a whole metre of
 * kerb margin is affordable and stops the field kissing the barrier every
 * corner.
 */
const DRIFT_EDGE_KEEP = 1.0;
/**
 * Metres of inside lane bias held for the duration of a drift, as a fraction of
 * the road half-width, clamped. This is the road the slide spends: turn in
 * tighter than the line, let the wash carry you out to it.
 */
const DRIFT_INSIDE_FRAC = 0.34;
const DRIFT_INSIDE_MIN = 1.7;
const DRIFT_INSIDE_MAX = 3.6;
/**
 * Longest a drift may be held, seconds. Purely a backstop — the exit gate ends
 * every normal drift — but without it a driver that loses its slide inside a
 * long constant-radius corner can sit on the button indefinitely.
 */
const DRIFT_MAX_HOLD = 4.5;
/**
 * Speed multiplier applied while a drift is committed.
 *
 * `Kart.ts` drops the rears to DRIFT_REAR_GRIP_IN (0.58) in a drift, which puts
 * the achievable lateral acceleration at roughly 0.78 of the four-wheel figure
 * the speed profile is solved with; speed scales as its square root.
 */
const DRIFT_SPEED_FACTOR = 0.88;
/**
 * Steer added on turn-in to load the rack before the drift hop lands.
 *
 * This is not cosmetic: `Kart.updateDriftState` only engages the slide if
 * `|steerInput| > 0.2` while the hop is in the air, so the flick is what turns
 * a hop into a drift at all.
 */
const DRIFT_FLICK = 0.45;
/** metres of road on the apex side at which the flick is worth its full value */
const DRIFT_FLICK_ROOM = 6.0;
/**
 * Edge repulsion. Beyond `half - EDGE_PUSH_KEEP` the driver actively steers
 * back toward the middle, on top of whatever the racing line asked for.
 *
 * The racing line is clamped to `half - EDGE_MARGIN` and the lane bias to
 * `half - 1.4`, so this dead band sits outside both and never fights either.
 * It exists because line-following alone has no opinion about the road: a
 * drift, a rival's shove or a kerb bounce all displace the kart faster than
 * the cross-track term can pull it back, and the barrier is only ~2 m further.
 */
const EDGE_PUSH_KEEP = 1.2;
/**
 * Half-width the rival-avoidance shove was authored against. Below this the
 * push is scaled down in proportion — there is simply less road to give.
 */
const LANE_REF_HALF = 9.5;
/** steer per metre of excursion past the keep-out, before clamping */
const EDGE_PUSH_GAIN = 0.55;
/** ceiling on the edge term so it can never fully override the racing line */
const EDGE_PUSH_MAX = 0.85;

// --- module scratch ----------------------------------------------------------
const _p0 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** wrap to (-PI, PI] */
function wrapPi(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
/** deterministic per-driver randomness — a race must replay the same way */
function hash01(n: number) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A world obstacle the drivers should not run into (bananas, live shells). */
export interface HazardLike {
  x: number;
  y: number;
  z: number;
  r: number;
  /** kart id that owns it, or -1 — an owner ignores its own hazard */
  owner: number;
}

// =============================================================================
//  Racing line
// =============================================================================

export class RacingLine {
  count = 0;
  ds = 0;
  length = 0;

  /** line point */
  px!: Float32Array; py!: Float32Array; pz!: Float32Array;
  /** centreline point */
  cx!: Float32Array; cy!: Float32Array; cz!: Float32Array;
  /** banked binormal ("right") at the station */
  bx!: Float32Array; by!: Float32Array; bz!: Float32Array;
  /** unit tangent of the LINE (not the centreline), XZ-heading in `yaw` */
  yaw!: Float32Array;
  /** lateral offset of the line from the centreline, metres */
  off!: Float32Array;
  half!: Float32Array;
  bank!: Float32Array;
  /** signed curvature of the line, 1/m (sign matches TrackLayout: -ve = left) */
  curv!: Float32Array;
  /** target speed, m/s */
  speed!: Float32Array;

  build(track: ITrack) {
    const L = track.length;
    const n = Math.max(64, Math.round(L / NODE_DS));
    this.count = n;
    this.length = L;
    this.ds = L / n;

    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.cx = f(); this.cy = f(); this.cz = f();
    this.bx = f(); this.by = f(); this.bz = f();
    this.yaw = f(); this.off = f(); this.half = f();
    this.bank = f(); this.curv = f(); this.speed = f();

    // --- bake the corridor ------------------------------------------------
    for (let i = 0; i < n; i++) {
      const s = track.sample(i / n);
      this.cx[i] = s.pos.x; this.cy[i] = s.pos.y; this.cz[i] = s.pos.z;
      this.bx[i] = s.binormal.x; this.by[i] = s.binormal.y; this.bz[i] = s.binormal.z;
      this.half[i] = s.halfWidth;
      this.bank[i] = s.bank;
    }

    // --- centreline curvature, for the corner-hugging blend below ----------
    const ck = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const v1x = this.cx[i] - this.cx[a], v1z = this.cz[i] - this.cz[a];
      const v2x = this.cx[b] - this.cx[i], v2z = this.cz[b] - this.cz[i];
      const l1 = Math.hypot(v1x, v1z) || 1e-4;
      const l2 = Math.hypot(v2x, v2z) || 1e-4;
      const t1x = v1x / l1, t1z = v1z / l1;
      const t2x = v2x / l2, t2z = v2z / l2;
      ck[i] = (2 * Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z)) / (l1 + l2);
    }

    // --- minimum-curvature relaxation -------------------------------------
    // Moving every node toward the midpoint of its neighbours, but only along
    // the lateral axis, is gradient descent on total curvature. Constrained by
    // the corridor it converges on the geometric racing line: wide on entry,
    // clipping the apex, wide again on exit.
    const off = this.off;
    const lim = new Float32Array(n);
    for (let i = 0; i < n; i++) lim[i] = Math.max(0.5, this.half[i] - EDGE_MARGIN);

    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        const b = (i + 1) % n;
        this.nodePoint(a, off[a], _p0);
        this.nodePoint(b, off[b], _p2);
        // midpoint of the neighbours, expressed in this node's lateral frame
        const mx = (_p0.x + _p2.x) * 0.5 - this.cx[i];
        const my = (_p0.y + _p2.y) * 0.5 - this.cy[i];
        const mz = (_p0.z + _p2.z) * 0.5 - this.cz[i];
        const want = mx * this.bx[i] + my * this.by[i] + mz * this.bz[i];
        off[i] = clamp(off[i] + (want - off[i]) * RELAX_RATE, -lim[i], lim[i]);
      }
    }

    // --- corner-hugging blend ----------------------------------------------
    // A pure minimum-curvature line straight-lines a 26 m wide chicane into
    // nothing: technically fastest, but it drives like a solver and it never
    // loads the kart hard enough to be worth a drift. Blending a little of the
    // classic hug-the-inside line back in restores the shape of the circuit —
    // the corners stay corners, the mini-turbos are worth taking, and the cost
    // in lap time is a couple of tenths.
    {
      const w = 0.24;
      for (let i = 0; i < n; i++) {
        const inside = Math.sign(ck[i]) * Math.min(1, Math.abs(ck[i]) * 150) * this.half[i] * 0.5;
        off[i] = clamp(off[i] + (inside - off[i]) * w, -lim[i], lim[i]);
      }
    }

    // --- late apex ---------------------------------------------------------
    // Re-reading the converged offset from slightly *earlier* along the track
    // delays the whole pattern, which is exactly what a late apex is: give up
    // entry radius to straighten the exit. Only applied where it is a corner —
    // shifting the line on a straight would just make it wander.
    {
      const shift = Math.max(1, Math.round(LATE_APEX_SHIFT / this.ds));
      const src = Float32Array.from(off);
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        const b = (i + 1) % n;
        // second difference of the offset ~ how hard this node is working
        const bend = Math.abs(src[a] - 2 * src[i] + src[b]) / this.ds;
        const w = Math.min(1, bend * 26) * 0.55;
        const j = (i - shift + n) % n;
        off[i] = clamp(src[i] + (src[j] - src[i]) * w, -lim[i], lim[i]);
      }
      // a couple of relaxation passes to take the kinks back out
      for (let pass = 0; pass < 12; pass++) {
        for (let i = 0; i < n; i++) {
          const a = (i - 1 + n) % n;
          const b = (i + 1) % n;
          off[i] = clamp(off[i] * 0.6 + (off[a] + off[b]) * 0.2, -lim[i], lim[i]);
        }
      }
    }

    // --- resolve points, headings, curvature -------------------------------
    for (let i = 0; i < n; i++) {
      this.nodePoint(i, off[i], _p0);
      this.px[i] = _p0.x; this.py[i] = _p0.y; this.pz[i] = _p0.z;
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const v1x = this.px[i] - this.px[a], v1z = this.pz[i] - this.pz[a];
      const v2x = this.px[b] - this.px[i], v2z = this.pz[b] - this.pz[i];
      const l1 = Math.hypot(v1x, v1z) || 1e-4;
      const l2 = Math.hypot(v2x, v2z) || 1e-4;
      const t1x = v1x / l1, t1z = v1z / l1;
      const t2x = v2x / l2, t2z = v2z / l2;
      // same sign convention as TrackLayout's curvature schedule
      const d = Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z);
      // the two segment directions are (l1+l2)/2 apart along the path, not
      // l1+l2 — getting this wrong halves every curvature and the whole field
      // arrives at the hairpin believing it is a kink
      this.curv[i] = (2 * d) / (l1 + l2);
      this.yaw[i] = Math.atan2(v2x + v1x, v2z + v1z);
    }
    // curvature straight off three samples is noisy at 4 m spacing; a short
    // circular blur turns it into something a speed profile can trust
    this.smoothCurv(2);

    // --- speed profile ------------------------------------------------------
    const sp = this.speed;
    const vCap = BASE_TOP_SPEED * 1.14;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.curv[i]);
      // banking helps when the road leans into the corner; TrackLayout's
      // convention is +bank = right side raised, which supports a LEFT turn
      // (negative curvature), so the two signs must oppose to be a benefit.
      const help = -Math.sign(this.curv[i]) * this.bank[i];
      const aLat = Math.max(4, A_LAT + GRAVITY * Math.sin(clamp(help, -0.45, 0.45)) * 0.85);
      sp[i] = k > 1e-5 ? Math.min(vCap, Math.sqrt(aLat / k)) : vCap;
    }
    // backward pass, twice around so the loop seam is consistent: no node may
    // be faster than it can brake from into the node after it
    for (let pass = 0; pass < 2; pass++) {
      for (let s = n - 1; s >= 0; s--) {
        const i = s;
        const j = (i + 1) % n;
        const cap = Math.sqrt(sp[j] * sp[j] + 2 * A_BRAKE * this.ds);
        if (sp[i] > cap) sp[i] = cap;
      }
    }
  }

  private smoothCurv(radius: number) {
    const n = this.count;
    const src = Float32Array.from(this.curv);
    const w = radius * 2 + 1;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[(i + k + n) % n];
      this.curv[i] = acc / w;
    }
  }

  private nodePoint(i: number, off: number, out: THREE.Vector3) {
    out.set(
      this.cx[i] + this.bx[i] * off,
      this.cy[i] + this.by[i] * off,
      this.cz[i] + this.bz[i] * off,
    );
  }

  // --- runtime lookups (all wrap, all allocation-free) --------------------

  /** node index for an arc distance */
  index(d: number): number {
    const n = this.count;
    let i = Math.floor((d / this.length) * n) % n;
    if (i < 0) i += n;
    return i;
  }

  /** interpolated line point at arc distance `d` */
  point(d: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.count;
    let f = (d / this.length) * n;
    f -= Math.floor(f / n) * n;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const u = f - Math.floor(f);
    out.set(
      this.px[i] + (this.px[j] - this.px[i]) * u,
      this.py[i] + (this.py[j] - this.py[i]) * u,
      this.pz[i] + (this.pz[j] - this.pz[i]) * u,
    );
    return out;
  }

  offsetAt(d: number): number {
    const n = this.count;
    let f = (d / this.length) * n;
    f -= Math.floor(f / n) * n;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const u = f - Math.floor(f);
    return this.off[i] + (this.off[j] - this.off[i]) * u;
  }

  speedAt(d: number): number {
    return this.speed[this.index(d)];
  }

  curvAt(d: number): number {
    return this.curv[this.index(d)];
  }

  /** lowest target speed over the next `span` metres */
  minSpeed(d: number, span: number): number {
    const steps = Math.max(1, Math.round(span / this.ds));
    const i0 = this.index(d);
    let m = Infinity;
    for (let s = 0; s <= steps; s++) {
      const v = this.speed[(i0 + s) % this.count];
      if (v < m) m = v;
    }
    return m;
  }

  /** strongest |curvature| over the next `span` metres, keeping its sign */
  peakCurv(d: number, span: number): number {
    const steps = Math.max(1, Math.round(span / this.ds));
    const i0 = this.index(d);
    let best = 0;
    for (let s = 0; s <= steps; s++) {
      const c = this.curv[(i0 + s) % this.count];
      if (Math.abs(c) > Math.abs(best)) best = c;
    }
    return best;
  }

  /** signed lateral offset of a world point from the centreline at progress t */
  lateralOf(x: number, y: number, z: number, t: number): number {
    const i = this.index(t * this.length);
    return (x - this.cx[i]) * this.bx[i] + (y - this.cy[i]) * this.by[i] + (z - this.cz[i]) * this.bz[i];
  }
}

// =============================================================================
//  Driver
// =============================================================================

export interface DriveCmd {
  steer: number;
  throttle: number;
  brake: number;
  drift: boolean;
  /** set for exactly one frame when the driver wants to spend its item */
  useItem: boolean;
  /** true = deploy behind (shield / drop), false = fire ahead */
  itemBackwards: boolean;
}

/** The bit of the item system that knows about tow ropes. See `drive`. */
interface Towable {
  towing(kart: IKart): ItemKind;
}

const enum Mistake {
  None = 0,
  Wobble = 1,
  LateBrake = 2,
  NoDrift = 3,
}

export class AIDriver {
  readonly cmd: DriveCmd = {
    steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, itemBackwards: false,
  };

  /** 0..1 — how close to the limit this driver runs */
  readonly skill: number;
  /** 0..1 — willingness to lean on rivals and spend items early */
  readonly aggression: number;

  private prevErr = 0;
  private iErr = 0;
  private steerSmooth = 0;
  private lane = 0;
  private laneTarget = 0;
  private driftHold = false;
  private driftCool = 0;
  private driftSide = 0;
  /** seconds left of the deliberate over-steer that engages the slide */
  private driftEntry = 0;
  /** seconds the current drift has been committed, for the hold backstop */
  private driftT = 0;
  /** seconds a spendable item has sat in the slot unspent */
  private holdT = 0;
  private noisePhase: number;
  private noiseRate: number;
  private mistake = Mistake.None;
  private mistakeT = 0;
  private nextMistake: number;
  private itemDelay = 0;
  private lastKind: ItemKind = ItemKind.None;
  /** seconds the current shield has been on the tow rope */
  private carryT = 0;
  private stuckT = 0;
  /** counts down the forward "drive away" phase after a reverse, seconds */
  private escapeT = 0;

  constructor(readonly kart: IKart, private line: RacingLine, seed: number) {
    const h0 = hash01(seed * 7 + 11);
    const h1 = hash01(seed * 13 + 5);
    const st = kart.stats;
    // Skill leans on handling (a nimble character is driven by a nimble AI) and
    // is spread by a stable per-racer hash so the field is not homogeneous.
    this.skill = clamp(0.70 + (st.handlingMul - 1) * 1.5 + (h0 - 0.5) * 0.20, 0.5, 1);
    this.aggression = clamp(0.45 + (st.accelMul - 1) * 1.8 + (h1 - 0.5) * 0.5, 0.1, 1);
    this.noisePhase = h0 * Math.PI * 2;
    this.noiseRate = 0.55 + h1 * 0.5;
    this.nextMistake = 9 + h1 * 18;
  }

  reset() {
    this.prevErr = 0;
    this.iErr = 0;
    this.steerSmooth = 0;
    this.lane = this.laneTarget = 0;
    this.driftHold = false;
    this.driftCool = 0;
    this.driftSide = 0;
    this.driftEntry = 0;
    this.driftT = 0;
    this.holdT = 0;
    this.mistake = Mistake.None;
    this.mistakeT = 0;
    this.itemDelay = 0;
    this.carryT = 0;
    this.stuckT = 0;
    this.escapeT = 0;
    this.cmd.steer = this.cmd.throttle = this.cmd.brake = 0;
    this.cmd.drift = false;
    this.cmd.useItem = false;
  }

  /**
   * @param band  rubber-band multiplier on the target speed (1 = neutral)
   * @param held  the item this driver is holding, for the spend decision
   * @param towed the item already deployed behind it as a shield, if any —
   *              spent by releasing rather than by throwing
   */
  update(
    ctx: Ctx,
    dt: number,
    karts: readonly IKart[],
    hazards: readonly HazardLike[],
    band: number,
    held: ItemKind,
    heldCount: number,
    racing: boolean,
    towed: ItemKind = ItemKind.None,
  ) {
    const k = this.kart;
    const cmd = this.cmd;
    cmd.useItem = false;

    const line = this.line;
    const L = line.length;
    const d = k.t * L;
    const speed = k.forwardSpeed;
    const time = ctx.time;

    // ---- personality timers ------------------------------------------------
    if (this.driftCool > 0) this.driftCool -= dt;
    if (this.mistakeT > 0) {
      this.mistakeT -= dt;
      if (this.mistakeT <= 0) this.mistake = Mistake.None;
    } else {
      this.nextMistake -= dt;
      if (this.nextMistake <= 0) this.rollMistake();
    }

    if (!racing) {
      // Held on the grid: no steering, no throttle. The countdown "rocket
      // start" is the director's business, not the driver's.
      cmd.steer = 0; cmd.throttle = 0; cmd.brake = 0; cmd.drift = false;
      return;
    }

    // ---- lane bias: rivals, hazards, and the odd defensive weave -----------
    this.updateLane(k, karts, hazards, d, dt);

    // ---- steering ----------------------------------------------------------
    // Lookahead grows with speed so fast sections are read early and hairpins
    // are not cut. Lower skill looks less far ahead — that alone produces a
    // recognisably clumsier line.
    const look = clamp(5.5 + Math.abs(speed) * (0.42 + this.skill * 0.18), 6, 30);
    line.point(d + look, _tgt);
    // apply the lane bias in the corridor frame at the lookahead station
    const li = line.index(d + look);
    const limit = Math.max(0.6, line.half[li] - 1.4);
    const lineOff = line.off[li];
    const bias = clamp(lineOff + this.lane, -limit, limit) - lineOff;
    _tgt.x += line.bx[li] * bias;
    _tgt.y += line.by[li] * bias;
    _tgt.z += line.bz[li] * bias;

    const desired = Math.atan2(_tgt.x - k.position.x, _tgt.z - k.position.z);
    const heading = Math.atan2(k.forward.x, k.forward.z);
    let err = wrapPi(desired - heading);

    const lat = line.lateralOf(k.position.x, k.position.y, k.position.z, k.t);
    const cross = lat - (line.offsetAt(d) + bias);

    const dErr = clamp((err - this.prevErr) / Math.max(dt, 1e-3), -8, 8);
    this.prevErr = err;
    this.iErr = clamp(this.iErr + err * dt, -0.4, 0.4);

    // Cross-track: being at a *greater* lateral than the line means being
    // displaced toward +binormal, and closing that gap means increasing yaw,
    // which is a positive steer. Pure pursuit alone leaves a standing offset
    // through long constant-radius corners; this is what removes it.
    let steer = err * 2.35 + dErr * 0.10 + this.iErr * 0.30 + cross * 0.045;

    // Edge repulsion. `half` here is the road under the kart *now*, not at the
    // lookahead: this is a reaction to where the kart actually is, which is the
    // whole point — the lookahead is already accounted for by the line.
    // Sign follows the cross-track term: a kart displaced toward +binormal is
    // brought back by a positive steer, so the push is sign(lat) * excess.
    const bi = line.index(d);
    const halfNow = line.half[bi];
    const outSign = lat >= 0 ? 1 : -1;
    // Positional only, deliberately. A rate term on `lat` was tried and is
    // wrong: the racing line itself moves across the corridor through a corner,
    // so a kart tracking it perfectly still carries outward lateral velocity,
    // and damping that fights the line instead of the excursion (measured: it
    // put wall contacts back up from 25 to 31 per run).
    const excess = Math.abs(lat) - (halfNow - EDGE_PUSH_KEEP);
    if (excess > 0) steer += outSign * Math.min(excess * EDGE_PUSH_GAIN, EDGE_PUSH_MAX);

    // reversing out of a wall: invert so the correction is not fighting itself
    if (speed < -0.5) steer = -steer;

    // ---- imperfection ------------------------------------------------------
    // Two incommensurate sines: a slow drift off-line and a faster twitch.
    // Never enough to unsettle the kart, always enough that no two frames of
    // a replay look mechanically identical.
    const n1 = Math.sin(time * this.noiseRate + this.noisePhase);
    const n2 = Math.sin(time * this.noiseRate * 2.73 + this.noisePhase * 1.7);
    const noiseAmp = 0.075 * (1.25 - this.skill);
    steer += (n1 * 0.7 + n2 * 0.3) * noiseAmp;
    if (this.mistake === Mistake.Wobble) {
      steer += Math.sin(time * 9.5 + this.noisePhase) * 0.30;
    }

    steer = clamp(steer, -1, 1);
    // A rack is not instantaneous and neither is a human. Smoothing here is
    // what stops the AI looking like it is being driven by a solver.
    this.steerSmooth += (steer - this.steerSmooth) * Math.min(1, dt * 16);
    cmd.steer = clamp(this.steerSmooth, -1, 1);

    // ---- drift -------------------------------------------------------------
    cmd.drift = this.updateDrift(k, d, speed, lat, halfNow, dt);
    if (this.driftEntry > 0 && k.driftDir === 0) {
      // Flick it in: the chassis needs a loaded rack when the hop lands.
      //
      // Scaled by the road left on the INSIDE of the corner, because that is
      // what the flick spends. A fixed 0.45 was tuned against a corridor with
      // ~6 m inside the racing line; this one leaves ~2.3 m, and the same flick
      // over-rotates the kart straight across the inside kerb into the barrier
      // (measured: every AI wall contact on the circuit was the inside line of
      // a left-hander, not a run-wide). Room is measured toward the apex side,
      // which is the side the flick rotates toward.
      const insideSign = -this.driftSide;
      const room = halfNow - insideSign * lat;
      const scale = clamp(room / DRIFT_FLICK_ROOM, 0.3, 1);
      cmd.steer = clamp(cmd.steer + this.driftSide * DRIFT_FLICK * scale, -1, 1);
    }

    // ---- speed -------------------------------------------------------------
    // The profile already contains the braking ramps, so the target is simply
    // the profile a short way ahead — plus a floor from what is under us now.
    const reactSpan = clamp(Math.abs(speed) * 0.35, 4, 22);
    let target = Math.min(line.speedAt(d), line.minSpeed(d, reactSpan));
    target *= band;
    // personal ceiling: even a perfect line is driven a little short of it
    target *= 0.90 + this.skill * 0.11;
    // A committed drift is a slide, and the profile above was solved for a kart
    // that is NOT sliding: it uses A_LAT, full grip on all four corners. Once
    // the driver has decided to drift, the rears are down to DRIFT_REAR_GRIP_IN
    // and the same entry speed simply cannot be turned in the same radius. The
    // profile and the driver were disagreeing about which kart they were
    // driving; this reconciles them, and because it feeds the ordinary braking
    // logic the backward pass turns it into a real lift *before* turn-in.
    //
    // Applied on APPROACH as well as during the slide. The drift decision is
    // taken 10-24 m out, which at 33 m/s is a third of a second — far too late
    // to shed anything, so the kart used to arrive at the flick carrying the
    // full-grip entry speed and wash straight off the outside. Reading the same
    // gate over a longer horizon means the lift lands before turn-in, which is
    // where a lift belongs; it costs almost nothing because on this circuit the
    // profile is pinned at `vCap` nearly everywhere and 0.88 of it is still
    // above the karts' actual top speed.
    const committed = this.driftHold || k.driftDir !== 0;
    const approaching = !committed
      && Math.abs(line.peakCurv(d, clamp(Math.abs(speed) * 0.95, 16, 40))) > DRIFT_MIN_CURV;
    if (committed || approaching) target *= DRIFT_SPEED_FACTOR;
    if (this.mistake === Mistake.LateBrake) target *= 1.16;
    if (k.stunTime > 0) target = 0;

    const over = speed - target;
    if (over > 2.2) {
      cmd.brake = clamp((over - 2.2) * 0.22, 0, 1);
      cmd.throttle = 0;
    } else if (over > 0.4) {
      cmd.brake = 0;
      // coast rather than stamping off the throttle — keeps the kart settled
      cmd.throttle = clamp(1 - over * 0.5, 0.25, 1);
    } else {
      cmd.brake = 0;
      cmd.throttle = 1;
    }
    // Never coast out of a corner: the exit is where lap time is made.
    if (k.driftDir !== 0 || k.boostTime > 0) { cmd.throttle = 1; cmd.brake = 0; }

    // ---- unstick -----------------------------------------------------------
    // Beached on a kerb, nose-in to a wall, or wedged against a rival: reverse
    // out rather than sitting there with the throttle pinned looking broken.
    //
    // Two things here are load-bearing. First, the reverse steers off the
    // *heading error*, not off an inverted copy of whatever the line controller
    // last wanted: backing up with the same lock that wedged the kart simply
    // re-presents it to the same wall. Reversing pivots about the rear, so the
    // sign is opposite to the forward case — this is what actually rotates the
    // nose back down the road. Second, there is an explicit forward escape
    // phase afterwards. The previous code reset the timer to zero the moment
    // the reverse ended, so a kart that was still against the obstacle went
    // straight back to full throttle and re-wedged 1.4 s later, forever: two
    // karts were measured trading the same 40 m of road for 20 s that way.
    if (this.escapeT > 0) {
      this.escapeT -= dt;
      this.stuckT = 0;
      cmd.drift = false;
      cmd.throttle = 1;
      cmd.brake = 0;
    } else {
      if (Math.abs(speed) < 1.6 && k.stunTime <= 0) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt * 2);
      if (this.stuckT > 1.4) {
        cmd.throttle = 0;
        cmd.brake = 1;
        cmd.drift = false;
        cmd.steer = clamp(-err * 1.4, -1, 1);
        if (this.stuckT > 3.0) {
          this.stuckT = 0;
          this.escapeT = 1.2;
        }
      }
    }

    // ---- items -------------------------------------------------------------
    this.decideItem(k, karts, d, dt, held, heldCount, towed);
  }

  // --------------------------------------------------------------------------

  private rollMistake() {
    const r = hash01((this.kart.id + 1) * 977 + Math.floor(this.nextMistake * 1000) + 7);
    // A better driver makes rarer and shorter mistakes, never none at all.
    const gap = 10 + this.skill * 26;
    this.nextMistake = gap * (0.55 + r);
    if (r > 0.72 - this.skill * 0.25) return; // most rolls are a non-event
    if (r < 0.28) { this.mistake = Mistake.Wobble; this.mistakeT = 0.5 + r; }
    else if (r < 0.52) { this.mistake = Mistake.LateBrake; this.mistakeT = 1.1; }
    else { this.mistake = Mistake.NoDrift; this.mistakeT = 1.8; }
  }

  /**
   * Lane bias in metres, positive = shift right. Rivals push you sideways,
   * hazards push you harder, and the corridor limit is respected by the caller.
   */
  private updateLane(
    k: IKart,
    karts: readonly IKart[],
    hazards: readonly HazardLike[],
    d: number,
    dt: number,
  ) {
    let want = 0;
    const line = this.line;
    // How much road there is decides how much of it avoidance may spend. These
    // were absolute metres chosen against a 13 m half-width, where a 3.8 m
    // sidestep was a quarter of the corridor; here it is most of it, and a
    // saturated bias parks the whole field against the barrier where the next
    // touch tips someone into it. Scale the reach and the shove with the road.
    const half = line.half[line.index(d)];
    const roadScale = clamp(half / LANE_REF_HALF, 0.55, 1);
    const sideWindow = clamp(half * 0.62, 3.0, 5.5);
    // `fwd x up`, NOT `up x fwd`: this must point the same way as the track's
    // binormal (SurfaceProbe's +lateral) or every avoidance push is inverted
    // and the field steers into each other instead of around.
    _right.crossVectors(k.forward, UP);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();

    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k) continue;
      _rel.subVectors(o.position, k.position);
      if (Math.abs(_rel.y) > 3) continue;      // different level of the circuit
      const ahead = _rel.dot(k.forward);
      if (ahead < -2 || ahead > 26) continue;
      const side = _rel.dot(_right);
      if (Math.abs(side) > sideWindow) continue;
      // closer and more square-on = stronger push
      const prox = 1 - clamp(ahead / 26, 0, 1);
      const push = (2.6 + this.aggression * 1.2) * roadScale * prox * (side > 0 ? -1 : 1);
      // An aggressive driver commits to one side instead of splitting the
      // difference between two rivals, which is what causes the classic
      // "AI wobbles between two karts and hits both" look.
      want += push * (1 - Math.abs(side) / sideWindow);
    }

    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      if (h.owner === k.id) continue;
      _rel.set(h.x - k.position.x, h.y - k.position.y, h.z - k.position.z);
      if (Math.abs(_rel.y) > 3) continue;
      const ahead = _rel.dot(k.forward);
      if (ahead < 0 || ahead > 34) continue;
      const side = _rel.dot(_right);
      const clear = h.r + 1.5;
      if (Math.abs(side) > clear + 2.5) continue;
      const prox = 1 - clamp(ahead / 34, 0, 1);
      want += (side > 0 ? -1 : 1) * (clear + 1.2 - Math.abs(side)) * prox * 2.2;
    }

    // Blocking: when leading, sit on the inside line so a rival has to go the
    // long way round. The inside of a corner is on the sign(curvature) side.
    if (k.place === 1 && this.aggression > 0.5) {
      want += Math.sign(line.curvAt(d) || 1) * 0.6 * this.aggression;
    }

    // ---- the drift's lane budget -------------------------------------------
    // A slide washes the kart a median 3.5 m wide, and the racing line at
    // corner ENTRY is hard against the outside edge — out-in-out puts it there
    // on purpose. Turning in from that point means the wash has to come out of
    // the safety margin, and it does not fit: that is why every AI drift used
    // to be abandoned within a fifth of a second (fault 3 in the header).
    //
    // So the driver buys the room the way a human does, by giving up entry
    // radius: while committed to a drift it aims a couple of metres inside the
    // line and lets the slide carry it back out to the apex. `driftSide` is the
    // steer that turns INTO the corner and `lane` is measured along +binormal,
    // which are opposite senses — hence the negation.
    const drifting = this.driftHold || k.driftDir !== 0;
    if (drifting) {
      const room = clamp(half * DRIFT_INSIDE_FRAC, DRIFT_INSIDE_MIN, DRIFT_INSIDE_MAX);
      want += -this.driftSide * room;
    }

    // The corridor, not a fixed 6 m, is the ceiling: the aim point is clamped
    // to `half - 1.4` anyway, so anything past that is bias the driver can
    // never spend and only serves to pin it against the clamp.
    const laneMax = Math.max(0.8, half - 1.4);
    this.laneTarget = clamp(want, -laneMax, laneMax);
    // Bias moves at a believable rate — a kart cannot teleport across the road.
    // Faster while drifting: the entry decision is taken 10-24 m out, which at
    // racing pace is a third of a second, and a 2.6/s slew delivers barely half
    // the inside bias inside that window. A turn-in is a deliberate, quick
    // movement anyway; it is the *cruising* lane changes that must look lazy.
    const rate = Math.min(1, dt * (drifting ? 6.5 : 2.6));
    this.lane += (this.laneTarget - this.lane) * rate;
    // and it decays back to the racing line when nothing is in the way
    if (Math.abs(this.laneTarget) < 0.05) this.lane *= 1 - Math.min(1, dt * 1.6);
  }

  /**
   * Drift is worth it when the corner is long and tight enough to bank at
   * least a tier-1 mini-turbo. Entering one straightens the kart's line, so
   * the decision is made on the corner *ahead*, not the one under the wheels.
   */
  private updateDrift(
    k: IKart,
    d: number,
    speed: number,
    lat: number,
    half: number,
    dt: number,
  ): boolean {
    if (this.mistake === Mistake.NoDrift || k.stunTime > 0 || speed < 9) {
      this.endDrift(0.25);
      return false;
    }

    const line = this.line;
    // ONE window, used by both the entry test and the release test. See fault 1
    // in the header: this is the whole reason the field hopped its way round
    // the circuit instead of drifting it.
    const span = this.driftSpan(speed);

    if (this.driftHold) {
      this.driftT += dt;
      const engaged = k.driftDir !== 0;
      if (engaged) this.driftEntry = 0;
      else this.driftEntry -= dt;

      // The slide never took — the hop landed with the rack unloaded, or the
      // kart was bumped. Give up cleanly and wait a beat rather than mashing
      // the button, which is what produced the hop-spam.
      if (!engaged && this.driftEntry <= 0) {
        this.endDrift(0.6);
        return false;
      }

      // Running wide is the signal a human reads to straighten up and stop
      // trying to be a hero; without it a missed apex compounds into the grass.
      // Measured against the road edge, not as an absolute distance off the
      // line — the road is the thing that ran out, so the road is what the test
      // reads. With the inside bias below paying for the wash, this now fires
      // when the driver genuinely overcooked it rather than on every entry.
      if (Math.abs(lat) > half - DRIFT_EDGE_KEEP) {
        this.endDrift(0.45);
        return false;
      }

      if (this.driftT > DRIFT_MAX_HOLD) {
        this.endDrift(0.5);
        return false;
      }

      // Hold until the corner genuinely opens up, then release to cash the
      // mini-turbo onto the exit — bailing early throws the whole charge away.
      // The one exception is the classic player's beat: if a tier is within
      // half a charge, hang on through the exit for it. A drift released at
      // tier 0 is a slide that cost lateral grip and paid nothing, and it is
      // also, on screen, a rival that slid without ever lighting up.
      const opened = Math.abs(line.peakCurv(d, span)) < DRIFT_EXIT_CURV;
      const nearlyThere = k.driftTier === 0 && k.driftCharge > 0.5;
      if (opened && !nearlyThere) {
        this.endDrift(0.3);
        return false;
      }
      return true;
    }

    const peak = line.peakCurv(d, span);
    if (
      this.driftCool <= 0
      && Math.abs(peak) > DRIFT_MIN_CURV
      && speed > 12
      && !k.airborne
      // Chain out of a mini-turbo instead of being locked out by it. At `<= 0`
      // a driver that had just cashed a tier-3 was barred from the next corner
      // for 2.1 s, which on this circuit is most of the gap between the esses.
      && k.boostTime <= 0.3
    ) {
      this.driftHold = true;
      this.driftT = 0;
      // steer sign that turns into this corner: +curvature turns toward -yaw
      this.driftSide = -Math.sign(peak);
      // The chassis only bites if the rack is loaded when the hop lands, so
      // the entry deliberately over-steers for a moment. This is exactly what
      // a player does — you flick it in, you do not ease it in. 0.6 s against
      // `Kart`'s 0.45 s hop window, so the flick is guaranteed to outlast the
      // window rather than expiring inside it.
      this.driftEntry = 0.6;
      return true;
    }
    return false;
  }

  /** Lookahead the drift decision reads, metres. */
  private driftSpan(speed: number) {
    return clamp(Math.abs(speed) * 0.45, 10, 24);
  }

  private endDrift(cool: number) {
    this.driftHold = false;
    this.driftEntry = 0;
    this.driftT = 0;
    if (cool > this.driftCool) this.driftCool = cool;
  }

  /**
   * Item policy. Deliberately not optimal: an AI that never wastes a shell is
   * miserable to race against. Reaction delay, range checks and a coin-flip on
   * marginal shots keep it human.
   */
  private decideItem(
    k: IKart,
    karts: readonly IKart[],
    d: number,
    dt: number,
    held: ItemKind,
    count: number,
    towed: ItemKind,
  ) {
    const cmd = this.cmd;
    if (held === ItemKind.None && towed === ItemKind.None) {
      this.lastKind = ItemKind.None;
      this.carryT = 0;
      this.holdT = 0;
      return;
    }
    if (towed !== ItemKind.None) {
      this.carryT += dt;
    } else {
      this.carryT = 0;
      this.holdT += dt;
      if (held !== this.lastKind) {
        this.lastKind = held;
        this.holdT = 0;
        // Reaction time — sharper drivers think faster. Halved from a ceiling
        // of 2.05 s to 1.4 s: at eight racers, a two-second think before every
        // decision (which then usually declines to fire) is most of the reason
        // the whole field's item game was invisible.
        this.itemDelay = 0.25 + (1 - this.skill) * 0.7 + hash01(k.id * 31 + held) * 0.45;
      }
      if (this.itemDelay > 0) { this.itemDelay -= dt; return; }
    }

    // --- who is where -------------------------------------------------------
    let aheadKart: IKart | null = null;
    let aheadDist = Infinity;
    let aheadAngle = Math.PI;
    let behindDist = Infinity;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k || o.finished) continue;
      _rel.subVectors(o.position, k.position);
      const dist = _rel.length();
      if (dist < 1e-3 || Math.abs(_rel.y) > 6) continue;
      const along = _rel.dot(k.forward) / dist;
      if (along > 0.25 && dist < aheadDist) {
        aheadDist = dist;
        aheadKart = o;
        aheadAngle = Math.acos(clamp(along, -1, 1));
      } else if (along < -0.2 && dist < behindDist) {
        behindDist = dist;
      }
    }

    // "Is there road to spend this on." 55 m at a 0.009 gate was answering NO
    // for most of the lap: the baked line clears 0.009 somewhere inside any 55 m
    // window over roughly half the circuit, so a high-skill driver holding a
    // mushroom essentially never found a stretch it approved of and carried it
    // to the flag. 40 m at 0.011 is the same idea asked honestly.
    const straight = Math.abs(this.line.peakCurv(d, 40)) < 0.011;
    const leading = k.place === 1;
    let fire = false;
    let back = false;

    // --- towing a shield ----------------------------------------------------
    // Not a fire decision: the same button *releases* what is already deployed,
    // and until this existed nobody ever pressed it. A driver that dropped a
    // banana behind itself towed it to the flag, and because a tow occupies the
    // item slot it also never collected another box for the rest of the race.
    if (towed !== ItemKind.None) {
      // A tow is worth something — it blocks a shell coming up the road — so it
      // is spent on a reason, not on a timer. The timer is only the backstop
      // that stops a driver hoarding one all lap while boxes go past.
      const hunted = behindDist < 17;
      const bored = this.carryT > 9 + (1 - this.aggression) * 8;
      switch (towed) {
        case ItemKind.RedShell:
          // Homing: turn it round the moment there is anything to home on.
          if (aheadKart && aheadDist < 85) { fire = true; back = false; }
          else if (hunted || bored) { fire = true; back = true; }
          break;
        case ItemKind.GreenShell:
          if (aheadKart && aheadDist < 34 && aheadAngle < 0.20) { fire = true; back = false; }
          else if (hunted || bored) { fire = true; back = true; }
          break;
        default:
          // Banana, bomb: dropping it is the whole point. On the apex if we can
          // manage it — a banana on the racing line through a corner is worth
          // several thrown down a straight.
          if (hunted || (bored && !straight) || this.carryT > 16) { fire = true; back = true; }
          break;
      }
      if (fire) {
        cmd.useItem = true;
        cmd.itemBackwards = back;
        this.lastKind = ItemKind.None;
        this.carryT = 0;
        this.itemDelay = 0.4;
      }
      return;
    }

    switch (held) {
      case ItemKind.Mushroom:
      case ItemKind.TripleMushroom:
        // Spend a boost where it converts: a straight, on the ground, not
        // already boosting. A weaker driver is happy to waste one.
        fire = k.boostTime <= 0 && !k.airborne &&
          (straight || this.skill < 0.65) && Math.abs(k.forwardSpeed) > 8;
        // a spare shroom is the cheapest way out of the rough
        if (count > 1) fire = fire || k.surface === Surface.OffTrack || k.surface === Surface.Sand;
        break;

      case ItemKind.GreenShell:
        // Widened from 34 m / 0.20 rad. A green shell is a straight-line weapon
        // and the old cone was tight enough that the shot was only ever taken
        // from directly behind at close range, which on a circuit this fast is
        // a window of about half a second per overtake.
        if (aheadKart && aheadDist < 44 && aheadAngle < 0.30) fire = true;
        else if (behindDist < 26 || (leading && this.skill > 0.6)) { fire = true; back = true; }
        break;

      case ItemKind.RedShell:
        // Homing, so the angle matters far less than the range.
        if (aheadKart && aheadDist < 85) fire = true;
        else if (leading && behindDist < 22) { fire = true; back = true; }
        break;

      case ItemKind.Banana:
        // Bananas are worth more behind you than thrown; only a straggler with
        // nobody near bothers to lob one forward.
        //
        // "Worth more behind you" used to be a comment above `fire = true`,
        // which threw it away instantly regardless. Deploying it *is* still the
        // right move — behind you it becomes a tow, and a tow is a live shield
        // — but there is no hurry, and a driver that hangs on to it for a beat
        // reads as one that knows what it is for.
        fire = behindDist < 60 || leading || !straight || this.aggression > 0.55;
        back = behindDist < 45 || leading || this.skill > 0.5;
        break;

      case ItemKind.Star:
        fire = !leading || behindDist < 30 || straight;
        break;

      case ItemKind.Bolt:
        fire = !leading;
        break;

      case ItemKind.Bomb:
        if (aheadKart && aheadDist < 42 && aheadAngle < 0.30) fire = true;
        else if (behindDist < 20) { fire = true; back = true; }
        break;
    }

    // --- boredom backstop ---------------------------------------------------
    // Every branch above can decline forever, and several of them routinely do:
    // the leader with a star and nobody within 30 m, a mid-pack driver with a
    // red shell and a 90 m gap, anyone at all holding a mushroom through a
    // twisty third of the lap. What that produced across a whole race was a
    // field that collected items and then quietly kept them — and a lap in which
    // nothing was ever thrown, which is most of the round-1 "nothing is
    // happening" note.
    //
    // A held slot also blocks the next box, so hoarding is not even neutral:
    // it takes the driver out of the item game entirely. So an unspent item goes
    // off on a timer — impatient drivers sooner — and droppables go out behind
    // where they at least become a shield rather than being wasted forward.
    if (!fire && this.holdT > 5.5 + (1 - this.aggression) * 4.5) {
      fire = true;
      back = held === ItemKind.Banana || held === ItemKind.GreenShell
        || held === ItemKind.RedShell;
    }

    if (fire) {
      cmd.useItem = true;
      cmd.itemBackwards = back;
      this.lastKind = ItemKind.None;
      this.holdT = 0;
      this.itemDelay = 0.4;
    }
  }
}

// =============================================================================
//  Field — owns the line, the drivers and the rubber band
// =============================================================================

/** peak catch-up / leash acceleration, m/s^2 — see `beginFrame` */
const ASSIST_CATCHUP = 0.85;
const ASSIST_LEASH = 0.6;

export class AIField {
  readonly line = new RacingLine();
  private drivers = new Map<number, AIDriver>();
  private bands = new Map<number, number>();
  private assists = new Map<number, number>();
  private hazards: readonly HazardLike[] = [];

  init(ctx: Ctx, karts: readonly IKart[]) {
    this.line.build(ctx.track);
    for (const k of karts) {
      this.drivers.set(k.id, new AIDriver(k, this.line, k.id + 1));
      this.bands.set(k.id, 1);
      this.assists.set(k.id, 0);
    }
  }

  setHazards(h: readonly HazardLike[]) {
    this.hazards = h;
  }

  driver(k: IKart): AIDriver {
    return this.drivers.get(k.id)!;
  }

  reset() {
    for (const d of this.drivers.values()) d.reset();
    for (const key of this.bands.keys()) {
      this.bands.set(key, 1);
      this.assists.set(key, 0);
    }
  }

  /**
   * Rubber band, recomputed once a frame for the whole field.
   *
   * Two levers, both restrained, and neither applied to the player:
   *
   *  - `band` scales the target speed, which only bites in the corners. On a
   *    circuit this fast that is a handful of seconds a lap, so on its own it
   *    does very little — which is exactly why the second lever exists.
   *  - `assist` is a small longitudinal acceleration, well under half of the
   *    aerodynamic drag at speed, applied through the sanctioned `launch`
   *    command. Read it as a slipstream for the chasers and dirty air for the
   *    leader: it shifts the equilibrium top speed by a few percent, it does
   *    NOT touch `boostTime`, so nothing lights up, and a kart being helped
   *    still has to actually drive the corner.
   *
   * Neither can rescue a driver who is off the road, and neither is enough to
   * overturn a genuinely quick lap. It only stops the field being strung out
   * over half a lap by the final tour.
   */
  beginFrame(karts: readonly IKart[], player: IKart, dt: number) {
    // Karts that have taken the flag are excluded from the reference. They keep
    // circulating for the results-screen backdrop and their `raceDistance` keeps
    // climbing, so leaving them in meant that the moment the winner crossed the
    // line every kart still racing was measured against a car that was already
    // most of a lap "ahead": the catch-up term pinned itself to maximum for the
    // rest of the race and the leash never engaged again, because no live kart
    // could ever be the leader.
    let leadDist = -Infinity;
    for (const k of karts) if (!k.finished && k.raceDistance > leadDist) leadDist = k.raceDistance;
    if (leadDist === -Infinity) for (const k of karts) if (k.raceDistance > leadDist) leadDist = k.raceDistance;

    for (const k of karts) {
      if (k.isPlayer) continue;
      const gapToLead = leadDist - k.raceDistance;
      const gapToPlayer = player ? k.raceDistance - player.raceDistance : 0;
      const leading = gapToLead < 1;

      let band = 1;
      let assist = 0;

      // catch-up: nothing inside 30 m, saturating at 110 m adrift
      const behind = clamp((gapToLead - 30) / 80, 0, 1);
      band += behind * 0.05;
      assist += behind * ASSIST_CATCHUP;

      // leash: only the actual leader, and only once genuinely clear ahead
      if (leading) {
        const clear = clamp((gapToPlayer - 40) / 110, 0, 1);
        band -= clear * 0.04;
        assist -= clear * ASSIST_LEASH;
      }

      const prev = this.bands.get(k.id) ?? 1;
      // slew-limited so a lap-counter flip cannot snap everyone's pace at once
      this.bands.set(k.id, prev + clamp(band - prev, -dt * 0.3, dt * 0.3));
      const pa = this.assists.get(k.id) ?? 0;
      this.assists.set(k.id, pa + clamp(assist - pa, -dt * 1.2, dt * 1.2));
    }
  }

  /** Longitudinal assist for this kart, m/s^2. Race applies it as an impulse. */
  assistFor(k: IKart): number {
    return this.assists.get(k.id) ?? 0;
  }

  drive(ctx: Ctx, k: IKart, dt: number, karts: readonly IKart[], racing: boolean): DriveCmd {
    const drv = this.drivers.get(k.id)!;
    const held = ctx.items.held(k);
    // `towing` is a detail of the concrete item system rather than part of the
    // published `IItems` surface, so it is asked for structurally: a driver
    // that cannot see its own tow rope simply never decides to let go, which is
    // the old behaviour and safe.
    const towed = (ctx.items as Partial<Towable>).towing?.(k) ?? ItemKind.None;
    drv.update(
      ctx, dt, karts, this.hazards,
      this.bands.get(k.id) ?? 1,
      held.kind, held.count, racing, towed,
    );
    return drv.cmd;
  }
}
