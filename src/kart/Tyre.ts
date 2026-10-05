/**
 * ============================================================================
 *  Tyre model — the scalar half of the kart's handling.
 * ============================================================================
 *  One instance of `solveTyre` per wheel per substep. Everything here works in
 *  the wheel's own contact-plane frame: `vLong` is the slip velocity along the
 *  steered rolling direction, `vLat` is perpendicular to it. The caller owns
 *  all vector maths, which keeps this file testable and allocation-free.
 *
 *  The lateral curve is a cheap stand-in for Pacejka: a quarter-sine rise to a
 *  peak at `peakSlip`, then a smoothstep decay to a lower sliding plateau. The
 *  falling tail past the peak is the whole point — it is what lets the rear
 *  break away and stay broken away during a drift instead of snapping back.
 * ============================================================================
 */

const EPS = 1e-6;

export interface TyreConfig {
  /** slip angle (rad) at which lateral grip peaks */
  peakSlip: number;
  /** slip angle (rad) by which grip has fully decayed to `slideMu` */
  slideSlip: number;
  /** friction coefficient at the peak */
  peakMu: number;
  /** friction coefficient once fully sliding */
  slideMu: number;
  /** friction coefficient available for drive/brake */
  longMu: number;
  /**
   * How fast mu falls off as vertical load rises. 0 = load-independent.
   * This is the mechanism that makes weight transfer matter: the heavily
   * loaded outside tyre returns less grip per newton, so a kart that is
   * rolled over onto two wheels corners worse than one that is flat.
   */
  loadSensitivity: number;
  /** load in newtons at which mu is exactly `peakMu` */
  nominalLoad: number;
}

/** Output of a tyre solve. Reused — never allocate one per frame. */
export interface TyreResult {
  /** force along the wheel's rolling direction, newtons (+ = forward) */
  long: number;
  /** force perpendicular to it, newtons (+ = toward the wheel's right) */
  lat: number;
  /** signed slip angle, radians */
  slipAngle: number;
  /** 0..1 how much of the friction circle is spent — drives smoke and sparks */
  saturation: number;
  /** true once the tyre is past its peak and genuinely sliding */
  sliding: boolean;
}

export function makeTyreResult(): TyreResult {
  return { long: 0, lat: 0, slipAngle: 0, saturation: 0, sliding: false };
}

/**
 * The front/rear balance is the single most important pair of numbers in the
 * whole handling model.
 *
 * The rear deliberately carries MORE peak grip than the front. With equal
 * weight distribution and an equal wheelbase split, yaw equilibrium needs equal
 * axle forces, so whichever axle has the lower peak must run the larger slip
 * angle — and that axle is the one that lets go first. Give the front the lower
 * peak and the kart pushes wide at the limit, which is recoverable and reads as
 * "I asked for too much". Give the rear the lower peak and it snaps into a spin
 * on every fast corner. Drift is then produced by explicitly scaling the rear
 * grip down (see DRIFT_REAR_GRIP_* in Kart.ts), not by a fragile default bias.
 */
export const FRONT_TYRE: TyreConfig = {
  peakSlip: 0.14,
  slideSlip: 0.6,
  peakMu: 1.68,
  slideMu: 1.15,
  longMu: 1.5,
  loadSensitivity: 0.22,
  nominalLoad: 1000,
};

export const REAR_TYRE: TyreConfig = {
  peakSlip: 0.16,
  slideSlip: 0.78,
  peakMu: 1.95,
  slideMu: 1.38,
  longMu: 1.8,
  loadSensitivity: 0.2,
  nominalLoad: 1000,
};

/**
 * Slip angle with a floor on the longitudinal term. Without the floor the
 * angle jumps to 90 degrees the instant the kart is nudged sideways at rest,
 * which reads as a phantom sliding tyre on the grid.
 */
export function slipAngleOf(vLong: number, vLat: number): number {
  return Math.atan2(vLat, Math.max(1.4, Math.abs(vLong)));
}

export function lateralMu(slip: number, cfg: TyreConfig): number {
  const s = Math.abs(slip);
  if (s <= cfg.peakSlip) {
    // Quarter sine: finite cornering stiffness at zero, flat-topped at the peak
    // so grip does not fall off a cliff exactly at the limit.
    return cfg.peakMu * Math.sin(Math.PI * 0.5 * (s / Math.max(EPS, cfg.peakSlip)));
  }
  const k = Math.min(1, (s - cfg.peakSlip) / Math.max(EPS, cfg.slideSlip - cfg.peakSlip));
  const e = k * k * (3 - 2 * k);
  return cfg.peakMu + (cfg.slideMu - cfg.peakMu) * e;
}

/** mu multiplier from vertical load — see TyreConfig.loadSensitivity. */
export function loadFactor(load: number, cfg: TyreConfig): number {
  const r = load / Math.max(EPS, cfg.nominalLoad);
  const f = 1 - cfg.loadSensitivity * (r - 1);
  return f < 0.55 ? 0.55 : f > 1.4 ? 1.4 : f;
}

/**
 * Solve one wheel.
 *
 * @param out          reused result object
 * @param cfg          front or rear tyre curve
 * @param vLong        slip velocity along the rolling direction, m/s
 * @param vLat         slip velocity across the tyre, m/s
 * @param load         vertical load from the suspension, newtons
 * @param gripMul      surface grip multiplier (SURFACE_PROPS) x drift scaling
 * @param driveDemand  requested longitudinal force, newtons (+ accel, - brake)
 * @param cornerMass   share of the chassis mass this corner carries, kg
 * @param dt           substep length, seconds
 */
export function solveTyre(
  out: TyreResult,
  cfg: TyreConfig,
  vLong: number,
  vLat: number,
  load: number,
  gripMul: number,
  driveDemand: number,
  cornerMass: number,
  dt: number,
): TyreResult {
  // Every input is guarded, not just the three that used to be. This function
  // is the only place in the model where a non-finite number becomes a FORCE,
  // and a force becomes a velocity, and a velocity is permanent — `Kart.sanitize`
  // can only notice afterwards and respawn, which is a visible failure rather
  // than a survived one. `gripMul` in particular is a product of a surface
  // lookup and a drift scaling, `dt` comes from the frame clock, and neither is
  // this file's to trust. Written as a single conjunction of positive tests so
  // that a NaN in any of them falls through to the safe branch.
  if (
    !(load > 0) ||
    !Number.isFinite(vLat) || !Number.isFinite(vLong) ||
    !Number.isFinite(gripMul) || !Number.isFinite(driveDemand) ||
    !(cornerMass > 0) || !(dt > 0)
  ) {
    out.long = 0;
    out.lat = 0;
    out.slipAngle = 0;
    out.saturation = 0;
    out.sliding = false;
    return out;
  }

  const sa = slipAngleOf(vLong, vLat);
  const capacity = load * gripMul * loadFactor(load, cfg);
  const budget = capacity * cfg.peakMu; // radius of the friction circle
  const latMax = lateralMu(sa, cfg) * capacity;

  // Never ask for more lateral force than would exactly cancel the slip in one
  // step. This clamp is what stops an explicit integrator from ringing when a
  // tyre is well inside its grip limit, and it costs nothing when it is not.
  const latNeeded = (cornerMass * Math.abs(vLat)) / Math.max(dt, EPS);
  let lat = -Math.sign(vLat) * Math.min(latMax, latNeeded);

  // Keep a sliver of the circle for drive even at maximum cornering, otherwise
  // the kart coasts to a stop in long corners and feels dead.
  const latCap = budget * 0.95;
  if (lat > latCap) lat = latCap;
  else if (lat < -latCap) lat = -latCap;

  const longRoom = Math.sqrt(Math.max(0, budget * budget - lat * lat));
  const longMax = Math.min(longRoom, cfg.longMu * capacity);
  let long = driveDemand;
  if (long > longMax) long = longMax;
  else if (long < -longMax) long = -longMax;

  out.long = long;
  out.lat = lat;
  out.slipAngle = sa;
  out.saturation = Math.min(1, Math.hypot(lat, long) / Math.max(EPS, budget));
  out.sliding = Math.abs(sa) > cfg.peakSlip * 1.15 && latNeeded > latMax;
  return out;
}
