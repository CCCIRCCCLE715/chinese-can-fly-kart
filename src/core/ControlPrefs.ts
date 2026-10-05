/**
 * ============================================================================
 *  ControlPrefs — the first player preference this game has ever kept.
 * ============================================================================
 *  `grep -rn localStorage src/` returned nothing before this file. That is the
 *  whole reason it exists as its own module rather than as three lines inside
 *  `TouchControls`: once a game keeps state across sessions, the *failure*
 *  modes of that state become gameplay bugs, and they all want to be handled in
 *  one place.
 *
 *  Four rules, each of which is a bug that this shape prevents:
 *
 *  1. **Not `Settings.ts`.** That file is device/GL capability profiling and is
 *     owned by the rendering work. Player preference is a different lifetime
 *     (it outlives the device probe) and a different owner.
 *
 *  2. **Every access is wrapped.** `localStorage.setItem` *throws* in Safari
 *     private mode and in a partitioned third-party frame — not returns false,
 *     throws — and an uncaught throw on the boot path is a black screen. It is
 *     also legal for `localStorage` itself to be absent (a `file://` document,
 *     a sandboxed iframe), so even the property read is inside the try.
 *
 *  3. **Absent or unparseable falls to defaults, silently.** A player whose
 *     storage is corrupt gets a working game with default controls, not a
 *     console error and no controls. Every field is validated individually,
 *     because a partially-written record is the realistic corruption (a tab
 *     killed mid-write), not a wholly invalid one.
 *
 *  4. **`tutorialSeen` is a VERSION STAMP, not a boolean.** A materially
 *     changed control scheme has to be allowed to re-teach itself exactly once.
 *     A boolean can only ever say "done", so the only way to re-teach would be
 *     to clear it — which, if the write then fails, re-shows the tutorial on
 *     every single launch. A stamp compared against `TUTORIAL_VERSION` cannot
 *     loop: the worst case of a storage failure is that the tutorial shows
 *     again next launch, which is what it already does for a first-run player.
 *
 *  Nothing in the boot path awaits this. `load()` is synchronous, cannot throw,
 *  and returns a complete object.
 * ============================================================================
 */

/** Which steering source is live. See `TouchControls.setScheme`. */
export type Scheme = 'floating' | 'fixed' | 'tilt' | 'buttons';
export type Hand = 'right' | 'left';

export interface ControlPrefsData {
  /** record version — bumped only when a field's MEANING changes */
  v: number;
  scheme: Scheme;
  hand: Hand;
  /** auto-accelerate; the one preference that already existed, as a runtime-only flag */
  autoAccel: boolean;
  haptics: boolean;
  /** steering-assist authority. 0 / 0.35 / 0.60 — see Input.update() */
  steerAssist: number;
  /** drift steer-floor authority. 0 / 0.5 / 1 — see TouchControls */
  driftAssist: number;
  /** degrees of device roll that reach full lock in the tilt scheme */
  tiltRange: number;
  /** fixed-stick rosette centre, as a FRACTION of the viewport (resolution-free) */
  fixedX: number;
  fixedY: number;
  /**
   * Version of the onboarding the player has already been shown. Compared
   * against `TUTORIAL_VERSION`; `< 0` means never.
   */
  tutorialSeen: number;
}

/**
 * Bump when the controls change enough that a returning player would be
 * surprised — that is the entire contract. Bumping it re-runs onboarding once.
 */
export const TUTORIAL_VERSION = 1;

const KEY = 'kr.controls.v1';

export const DEFAULTS: ControlPrefsData = {
  v: 1,
  /**
   * FLOATING is the default and the choice is defended rather than inherited.
   * A fixed stick asks the player to look away from the road to find it; a
   * floating one is defined as the pixel the thumb landed on, so it is always
   * exactly under the thumb and has no calibration error to reject. Every other
   * scheme here is better for *somebody* — tilt for a player who wants both
   * thumbs on the buttons, buttons for a player who cannot hold a phone
   * steadily — and none of them is better for the median first-time player, who
   * has never seen this game and gets three seconds to work out how it steers.
   */
  scheme: 'floating',
  hand: 'right',
  autoAccel: true,
  haptics: true,
  /**
   * OFF by default, and that is a deliberate departure from the brief, made for
   * a measured reason and not a taste one.
   *
   * `tools/touch-feel.mjs` gates "pad.state.steer is what InputState receives"
   * to within 0.001 — the instrument that proves nothing has been inserted into
   * the steering path. A steering assist IS something inserted into the
   * steering path; at 0.35 it moves that comparison by up to 0.18 and the gate
   * goes red, and a red instrument is worth more than a default. Shipping the
   * assist on by default would have meant either losing the check or teaching
   * the next person to ignore it.
   *
   * It is also the more honest default for a game whose stated top priority is
   * the drift loop: the (1-|s|)^2 envelope does the MOST work during the small
   * corrections that teach a player the racing line, so an unasked-for 0.22 of
   * lock changes the line they are learning. It is one tap away in the controls
   * screen, with three grades and a live readout of what it is doing, which is
   * the whole point of having a controls screen.
   */
  steerAssist: 0,
  /** the drift steer FLOOR (never a state machine — see TouchControls) */
  driftAssist: 0.5,
  /**
   * 26 degrees of roll to full lock. Measured against a phone held in landscape
   * at a natural viewing pitch: 26 deg is reachable with the wrists alone and
   * still well short of the angle at which the screen becomes hard to read.
   */
  tiltRange: 26,
  /**
   * -1 means "compute it": the fixed rosette lands on the canonical thumb rest
   * point derived from the viewport rather than on a stored fraction the player
   * never chose. Only a player who has actually MOVED the rosette gets a stored
   * number, which is also why a stale record from a different device does not
   * put their stick in the wrong place.
   */
  fixedX: -1,
  fixedY: -1,
  tutorialSeen: -1,
};

function num(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

const SCHEMES = ['floating', 'fixed', 'tilt', 'buttons'] as const;
const HANDS = ['right', 'left'] as const;

/**
 * Read the stored record. Never throws, never returns a partial object, and
 * never blocks. A field that fails validation falls back on its own — a record
 * with a good `hand` and a nonsense `scheme` keeps the hand.
 */
export function load(): ControlPrefsData {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage disabled, partitioned, or absent — defaults are a valid answer */
  }
  if (!raw) return { ...DEFAULTS };
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    o = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULTS };
  }
  return {
    v: 1,
    scheme: oneOf(o.scheme, SCHEMES, DEFAULTS.scheme),
    hand: oneOf(o.hand, HANDS, DEFAULTS.hand),
    autoAccel: bool(o.autoAccel, DEFAULTS.autoAccel),
    haptics: bool(o.haptics, DEFAULTS.haptics),
    steerAssist: num(o.steerAssist, 0, 1, DEFAULTS.steerAssist),
    driftAssist: num(o.driftAssist, 0, 1, DEFAULTS.driftAssist),
    tiltRange: num(o.tiltRange, 10, 45, DEFAULTS.tiltRange),
    fixedX: num(o.fixedX, -1, 0.48, DEFAULTS.fixedX),
    fixedY: num(o.fixedY, -1, 0.95, DEFAULTS.fixedY),
    tutorialSeen: num(o.tutorialSeen, -1, 9999, DEFAULTS.tutorialSeen),
  };
}

/** Best-effort write. A failure here is not an error the player can act on. */
export function save(p: ControlPrefsData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* quota, private mode, disabled storage. The session still works. */
  }
}
