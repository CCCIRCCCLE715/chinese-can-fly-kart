/**
 * ============================================================================
 *  On-screen controls for touch devices.
 * ============================================================================
 *  FOUR steering schemes, one action cluster, one set of geometry. The player
 *  picks; the default is defended rather than assumed (see `ControlPrefs`).
 *
 *    floating  a stick whose origin is the pixel the thumb landed on (default)
 *    fixed     the same stick with a frozen rosette and a larger dead zone
 *    tilt      device roll, projected into SCREEN space so rotation is safe
 *    buttons   two large steering pads, routed through Input's ONE digital ramp
 *
 *  `Input` merges `state` into the same InputState every other system already
 *  reads, so nothing downstream knows or cares that the player is on a phone.
 *
 *  ---------------------------------------------------------------------------
 *  THE INVARIANTS THIS FILE MUST NOT BREAK
 *
 *  I1 — THE STEERING NEGATION HAPPENS EXACTLY ONCE, IN `Kart.ts`. This chassis
 *  uses `forward = (sin yaw, 0, cos yaw)`, so a rising yaw turns LEFT while the
 *  input contract says `steer > 0` means the player wants to go RIGHT. `Kart.ts`
 *  negates at the boundary; `Race.ts` negates the AI's command at its call site.
 *  Everything in this file emits the CONTRACT: a rightward thumb, a rightward
 *  roll and the RIGHT pad all produce `steer > 0`. The left-handed mirror
 *  mirrors GEOMETRY ONLY — it moves rectangles, it never touches a sign. If you
 *  find yourself adding a `-` here to make the mirror "work", you have found the
 *  bug rather than the fix, and `tools/steer-test.mjs` will say so.
 *
 *  I2 — NO SMOOTHING ON AN ANALOGUE SOURCE. A thumb on glass and a tilted phone
 *  are already absolute positions: they ARE the rack command. `Kart`'s own
 *  steering rack (8.5 units/s falling to 4.2 with speed, then `smooth(26)`) is
 *  the single rate limit, and a second limiter in series is the documented
 *  "mushy" failure that cost round 11. The ONE ramp in this file is the release
 *  ramp (§ RELEASE_RATE), which runs only after the thumb has gone, and the
 *  `buttons` scheme deliberately emits a DIGITAL request so that Input's
 *  existing 15/s key ramp handles it — one invented axis, one ramp, not two.
 *
 *  ---------------------------------------------------------------------------
 *  DEFECTS FIXED HERE, EACH REPRODUCED BEFORE IT WAS FIXED
 *
 *  D1  A rolled thumb killed steering until you lifted. `onDown` claimed the
 *      stick only when `stickPointer < 0`, and `onMove` promoted a free pointer
 *      to a BUTTON but never to the stick — so finger A at lock, finger B down,
 *      A lifts, B drags 80 px, steer stays 0. Fixed by `transplantOrigin()` plus
 *      an heir adoption with a palm-safety decay.
 *  D2  The drawn button was not the button that fired. `hitButton` returned the
 *      FIRST padded circle in declaration order with a flat +16 px pad on radii
 *      of 21-43 px, so 3.9% of visible cluster pixels fired a neighbour — and
 *      because `hitButton` skips CLAIMED buttons, the misfire happened only when
 *      DRIFT was NOT held, i.e. on a straight: reaching for a shell put you into
 *      a drift. Fixed by "the visible disc wins unconditionally", then nearest
 *      normalised distance, with the pad derived from the drawn gap.
 *  D3  LOOK was 42.9 px and PAUSE was 30x20 px. Every control now carries an
 *      explicit three-term clamp and a 46 px floor.
 *  D4  The charge rails were behind the notch and under the drifting thumb.
 *      Fixed in `ui.css` (the `env()` term) and answered here by the halo.
 *  D6  Onboarding was one 9 px line at 44% opacity naming controls without
 *      showing them, while the stick was invisible at rest.
 *  D7  `.tc-root` (z 20) sat over `#ui` (z 10) and was never hidden, so ~29% of
 *      the bottom-right quadrant of every blocking screen silently swallowed
 *      "TAP TO START". Hidden three ways at the foot of this file.
 *
 *  ---------------------------------------------------------------------------
 *  THINGS THAT LOOK LIKE OVERSIGHTS AND ARE NOT
 *
 *  - There is no "hard-over shelf" (a hysteretic latch at ~0.94 of travel). It
 *    was specified, it was implemented, and `tools/touch-feel.mjs` gates
 *    "pulling back off full lock responds immediately (trailing base)" on a
 *    ONE-PIXEL pull-back producing < 1.0. Any shelf fails that gate by
 *    construction, and the gate is right: the trailing base already pins the
 *    output at exactly 1.0 for as long as the thumb is past the ring, so the
 *    shelf buys nothing and costs the one property the floating base exists for.
 *  - The hit pad is ONE number for the whole cluster, not per-control. The
 *    layout below places every button at the same drawn `gap` from its nearest
 *    neighbour, so `min(16, gap/2 + 2)` is the same number for all of them
 *    anyway — and `touch-feel` models the pad as a constant and aborts if the
 *    four buttons disagree by more than 2 px. A per-control pad would be a
 *    silent instrument break for no behavioural gain.
 *  - The 24 px edge guard applies to SPAWNING A STICK and to nothing else.
 *    DRIFT lives in the corner and its hit circle necessarily overlaps the OS
 *    gesture band; refusing touches there would put a dead band on the most
 *    important button in the game. The guard exists so a back-swipe cannot
 *    spawn a steering stick, which is its whole documented purpose.
 * ============================================================================
 */
import { RaceState, type Ctx } from '../types';
import { DEFAULTS, TUTORIAL_VERSION, load, save, type ControlPrefsData, type Hand, type Scheme } from './ControlPrefs';

export interface TouchState {
  /** the input contract: -1 full LEFT .. +1 full RIGHT. Unfiltered. */
  steer: number;
  /**
   * -1 / 0 / +1 from the `buttons` scheme only. Input feeds this into its own
   * digital ramp instead of `steer`, so an invented axis is invented ONCE.
   */
  digital: number;
  accel: number;
  brake: number;
  drift: boolean;
  item: boolean;
  look: boolean;
  pause: boolean;
  /** true while the steering source is authoritative (including the release ramp) */
  steering: boolean;
  /** true while the player is actually touching something */
  active: boolean;
  /** `accel` is the auto-accelerate assist's doing, not the player's */
  autoAccel: boolean;
  /** 0..1 authority for the drift steer FLOOR — read by Input, applied there */
  driftAssist: number;
  /** 0..1 authority for the steering assist — read by Input, applied there */
  steerAssist: number;
  /** the player's haptics preference */
  haptics: boolean;
}

// ---------------------------------------------------------------------------
//  Geometry constants. Every one carries what it was measured against.
// ---------------------------------------------------------------------------

/**
 * Travel, in CSS px, that reaches full lock.
 *
 * The old 0.16-of-short-edge gave 62 px on a landscape phone, and the number
 * that matters is not how many distinct values the DIGITIZER can report — it is
 * how far the THUMB has to move to separate two decisions. At 62 px the travel
 * between steady-state cornering (steer 0.06) and `DRIFT_ENGAGE_STEER` (0.13)
 * was 5.20 px = 0.86 mm, BELOW a thumb's 1-2 mm repeatability: the drift /
 * no-drift decision, on the mechanic this repo calls its top priority, was a
 * coin flip made by skin. At 0.24 of the short edge that band is 7.86-10.22 px
 * (1.23-1.62 mm) across the device table.
 *
 * The floor of 84 protects the SE; the ceiling of 116 stops a tablet demanding
 * a whole hand's travel. Changing this without re-deriving CURVE breaks the
 * half-travel proof below.
 */
const STICK_RADIUS_MIN = 84;
const STICK_RADIUS_FRAC = 0.24;
const STICK_RADIUS_MAX = 116;
/** No grab may be tighter than this, or full lock stops being reachable. */
const R_GRAB_MIN = 56;

/**
 * Dead zone in ABSOLUTE PIXELS, not as a fraction of the radius.
 *
 * Thumb settle is a physical quantity: it does not scale with screen size. As a
 * fraction it was 3.3 px on a phone and 4.8 px on an iPad — 45% more "nothing"
 * on the device with the STEADIER grip, which is exactly backwards.
 */
const DEADZONE_PX = 3.5;
/** A fixed stick has landing error to reject as well as settle, so it gets more. */
const DEADZONE_PX_FIXED = 6.0;

/**
 * Expo past the dead zone.
 *
 * 1.26 is not a taste. It is the value at which enlarging the radius buys the
 * corner->drift band WITHOUT selling the mid-range: half-travel output moves
 * from 0.3990 (today's 62 px / 0.055 / 1.22) to 0.3972 at the new geometry, a
 * change of 0.0018. CURVE = 1.35 was tried in an earlier round and rightly
 * rejected — it put half a thumb sweep at a third of lock, so an ordinary
 * corner needed nearly all the travel and there was nothing left for a
 * correction. If you change STICK_RADIUS or DEADZONE_PX, re-run
 * `tools/touch-feel.mjs` and check half-travel is still within 0.005 of 0.3990;
 * those three constants are one measurement, not three.
 */
const CURVE = 1.26;

/**
 * The DRAWN ring is much smaller than the hit radius.
 *
 * 2 x rGrab would be a 187 px ring on a 390 px-tall frame — a dinner plate over
 * the road. The ring is an indicator, not the hit area: it is drawn at 0.62 of
 * the grab radius and the knob tracks 1:1 until it reaches the rim, after which
 * the remaining travel is encoded as rim alpha. The drawn stick is therefore
 * SMALLER than the 125 px it used to be, which independently helps the
 * occlusion problem the item plate and the charge rails both had.
 */
const RING_FRAC = 0.62;
const KNOB_FRAC = 0.42;

/**
 * Thumb-arc alignment. A thumb pivots at the base and sweeps an ARC, so a drag
 * the player experiences as "straight right" arrives with 7-13% of its length
 * in Y. Once cumulative travel passes ARC_LATCH_PX the drag axis is latched for
 * the life of the grab and dx is measured along it. Clamped to +/-32 deg so a
 * genuinely vertical stab cannot rotate the axis into nonsense; cos/sin cached
 * at the latch, so this is two trig calls per GRAB, not per move.
 */
const ARC_LATCH_PX = 10;
const ARC_MAX_RAD = (32 * Math.PI) / 180;

/**
 * Release ramp, units/s, linear in dt.
 *
 * Today's 66.7 ms lock-to-centre is an ACCIDENT: `steering` went false, `Input`
 * fell into its digital branch and `STEER_RETURN = 16` decayed the command. The
 * number is good and nothing stated it; it was one "tidy the fallthrough"
 * commit away from being an instant snap. Owning it here at the same 16 units/s
 * is deliberately behaviour-neutral (full lock -> 0 in 62.5 ms) and makes the
 * digital branch stop being load-bearing for touch. Linear in dt, so 30/60/120
 * fps produce the same wall-clock trajectory.
 */
const RELEASE_RATE = 16;

/**
 * Palm safety on a handover. If the adopted heir never moves, the steering it
 * inherited decays: it holds for SETTLE, then ramps to 0 over DECAY. A resting
 * palm therefore holds a phantom lock for at most 200 ms (~6 m at 30 m/s) and a
 * genuinely rolled thumb — which moves — for 0 ms.
 */
const HANDOVER_SETTLE = 0.1;
const HANDOVER_DECAY = 0.1;

/**
 * The OS edge-gesture band. `touch-action: none` suppresses it in a standalone
 * web app and NOT in a browser tab, so a stick spawned here is a stick the
 * system may steal mid-corner. Spawn only; see the header note.
 */
const EDGE_GUARD = 24;
/**
 * Contact width above which a stick spawn is treated as a palm. Feature
 * detected: Safari reports `width === 1` for every touch, so a browser that has
 * never reported anything else is one whose contact size means nothing and the
 * rejection is skipped entirely. Scoped to the STICK — a large contact landing
 * on DRIFT must still claim DRIFT, because rejection must never make the action
 * cluster harder to hit.
 */
const PALM_PX = 45;

/** Minimum inset from any screen edge, over and above env(). */
const SAFE_MIN = 24;

/** Every interactive control is at least this many CSS px on its short side. */
const TARGET_FLOOR = 46;

/** Degrees of tilt inside which the tilt scheme reports zero. */
const TILT_DEADZONE_DEG = 1.6;

type BtnId = 'drift' | 'item' | 'brake' | 'look' | 'gas' | 'left' | 'right';

type Btn = {
  id: BtnId;
  el: HTMLElement;
  pointer: number;
  /** set on press, cleared by `update()` — a sub-frame stab must still land */
  tapped: boolean;
  cx: number;
  cy: number;
  /** DRAWN radius. Stage 1 of hit resolution: inside this, this button wins. */
  visR: number;
  /** padded radius, = visR + the cluster's one derived pad */
  padR: number;
  /** kept for tools/touch-feel.mjs, which reads sqrt(r2) as the hit radius */
  r2: number;
};

export class TouchControls {
  readonly state: TouchState = {
    steer: 0, digital: 0, accel: 0, brake: 0, drift: false, item: false,
    look: false, pause: false, steering: false, active: false, autoAccel: false,
    driftAssist: DEFAULTS.driftAssist, steerAssist: DEFAULTS.steerAssist,
    haptics: DEFAULTS.haptics,
  };

  /** persisted player preferences — the source of truth for everything below */
  prefs: ControlPrefsData = load();

  /** auto-accelerate — the AUTO chip and the controls screen both toggle it */
  auto = true;
  private root: HTMLElement | null = null;
  private stickWrap!: HTMLElement;
  private stickBase!: HTMLElement;
  private stickKnob!: HTMLElement;
  private ghost!: HTMLElement;
  private cluster!: HTMLElement;
  private padsWrap!: HTMLElement;
  private gasBtn!: HTMLElement;
  private autoChip!: HTMLElement;
  private pauseChip!: HTMLElement;
  private coachEl!: HTMLElement;
  /** public for tools/touch-feel.mjs, which reads the cached hit radii back */
  buttons: Btn[] = [];
  private bDrift!: Btn;
  private bItem!: Btn;
  private bBrake!: Btn;
  private bLook!: Btn;
  private bGas!: Btn;
  private bLeft!: Btn;
  private bRight!: Btn;

  /** -1 when no thumb is steering */
  private stickPointer = -1;
  private originX = 0;
  private originY = 0;
  /** travel to full lock for THIS grab — see rGrab in `claimStick` */
  radius = STICK_RADIUS_MIN;
  /** the un-clamped ideal, recomputed on layout */
  private stickRadius = STICK_RADIUS_MIN;
  private deadzonePx = DEADZONE_PX;
  private mounted = false;
  /** public: touch-feel forces a re-measure through this */
  dirty = true;
  /** pointers that went down without claiming anything — may still slide on */
  private free = new Set<number>();
  /** last known position of each free pointer, for heir adoption */
  private freeXY = new Map<number, { x: number; y: number }>();

  // --- arc latch, per grab ---
  private arcLatched = false;
  private arcCos = 1;
  private arcSin = 0;
  private grabTravel = 0;

  // --- release ramp / handover ---
  private releasing = false;
  private handoverT = -1;

  // --- tilt ---
  private tiltOn = false;
  private tiltZero = 0;
  private tiltRaw = 0;
  private tiltSeen = false;

  // --- layout cache ---
  private safe = { l: SAFE_MIN, r: SAFE_MIN, t: SAFE_MIN, b: SAFE_MIN };
  private vw = 0;
  private vh = 0;

  // --- onboarding ---
  private coachStep = 0;
  private coachT = 0;
  private coachDone = false;
  private touchedEver = false;
  private lastRaceState: RaceState = RaceState.Menu;

  /** set by Input so control-level feedback can use the one haptics gate */
  pulse: ((pattern: number[]) => void) | null = null;
  /** watches the two attributes that decide whether the cluster has a size */
  private menuObserver: MutationObserver | null = null;

  // -------------------------------------------------------------------- life

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    const style = document.createElement('style');
    style.id = 'tc-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    // Lets the HUD (and the rules at the foot of this file) reflow for thumbs.
    document.documentElement.setAttribute('data-touch', '');
    document.documentElement.setAttribute('data-touch-hand', this.prefs.hand);
    document.documentElement.setAttribute('data-touch-scheme', this.prefs.scheme);

    const root = document.createElement('div');
    root.className = 'tc-root';
    root.innerHTML = MARKUP;
    document.body.appendChild(root);
    this.root = root;

    this.stickWrap = root.querySelector('.tc-stick-zone')!;
    this.stickBase = root.querySelector('.tc-stick-base')!;
    this.stickKnob = root.querySelector('.tc-stick-knob')!;
    this.ghost = root.querySelector('.tc-ghost')!;
    this.cluster = root.querySelector('.tc-cluster')!;
    this.padsWrap = root.querySelector('.tc-pads')!;
    this.autoChip = root.querySelector('.tc-auto')!;
    this.pauseChip = root.querySelector('.tc-pause')!;
    this.coachEl = root.querySelector('.tc-coach')!;
    this.gasBtn = root.querySelector('[data-btn="gas"]')!;

    for (const id of ['drift', 'item', 'brake', 'look', 'gas', 'left', 'right'] as const) {
      const el = root.querySelector<HTMLElement>(`[data-btn="${id}"]`)!;
      this.buttons.push({ id, el, pointer: -1, tapped: false, cx: 0, cy: 0, visR: 0, padR: 0, r2: 0 });
    }
    const byId = (id: BtnId) => this.buttons.find((b) => b.id === id)!;
    this.bDrift = byId('drift');
    this.bItem = byId('item');
    this.bBrake = byId('brake');
    this.bLook = byId('look');
    this.bGas = byId('gas');
    this.bLeft = byId('left');
    this.bRight = byId('right');

    this.autoChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setAuto(!this.auto);
      this.pulse?.([12]);
    });
    this.pauseChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.state.pause = true; // consumed as an edge by Input on the next frame
    });

    this.auto = this.prefs.autoAccel;
    this.state.driftAssist = this.prefs.driftAssist;
    this.state.steerAssist = this.prefs.steerAssist;
    this.state.haptics = this.prefs.haptics;
    this.setAuto(this.auto);
    this.layout();
    this.applyScheme(this.prefs.scheme);

    // Listeners go on the window so a thumb that slides off a button still
    // releases it — a button that latches because the release landed on the
    // canvas is the second most common on-screen-control bug.
    addEventListener('pointerdown', this.onDown, { passive: false });
    addEventListener('pointermove', this.onMove, { passive: false });
    addEventListener('pointerup', this.onUp, { passive: false });
    addEventListener('pointercancel', this.onUp, { passive: false });
    addEventListener('contextmenu', this.onContext);
    addEventListener('resize', this.onViewportChange);
    addEventListener('orientationchange', this.onOrientation);
    // `visualViewport` is the only thing that reports the URL bar collapsing or
    // a software keyboard opening. `resize` alone misses both, and a stale hit
    // cache after either is a cluster that no longer matches what is drawn.
    visualViewport?.addEventListener('resize', this.onViewportChange);
    visualViewport?.addEventListener('scroll', this.onViewportChange);

    /**
     * A SHIPPED GAME BUG, fixed here at its source.
     *
     * The hit circles are cached and refreshed only when `dirty` is set — on
     * mount, on resize, on an AUTO toggle. The FIRST `pointerdown` after mount
     * is what triggers the first `measure()`, and at boot that touch lands
     * while `html[data-menu]` has `.tc-cluster` at `display: none`. Every rect
     * is then 0x0, every button gets `visR = 0`, `dirty` goes false, and
     * NOTHING set it again when the menu closed — so DRIFT, ITEM, BRAKE, LOOK
     * and GAS were dead for the rest of the session. A player taps through the
     * title screen, so a player hits this every single time.
     *
     * It was invisible to review for the same reason it is deterministic: the
     * buttons are drawn, they animate on press (the `.down` class is CSS, not
     * state), and only the input does nothing. A screenshot cannot find it.
     *
     * `data-menu` and `data-touch-preview` are the two attributes that change
     * whether these boxes have a size, so observing exactly those two is
     * sufficient and costs one callback per menu transition.
     */
    this.menuObserver = new MutationObserver(() => { this.dirty = true; });
    this.menuObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-menu', 'data-touch-preview'],
    });
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    removeEventListener('contextmenu', this.onContext);
    removeEventListener('resize', this.onViewportChange);
    removeEventListener('orientationchange', this.onOrientation);
    visualViewport?.removeEventListener('resize', this.onViewportChange);
    visualViewport?.removeEventListener('scroll', this.onViewportChange);
    this.menuObserver?.disconnect();
    this.menuObserver = null;
    this.stopTilt();
    const de = document.documentElement;
    de.removeAttribute('data-touch');
    de.removeAttribute('data-touch-hand');
    de.removeAttribute('data-touch-scheme');
    de.removeAttribute('data-touch-preview');
    document.getElementById('tc-style')?.remove();
    this.root?.remove();
    this.root = null;
    this.buttons.length = 0;
    this.releaseEverything();
  }

  // ---------------------------------------------------------------- prefs API

  /** Persist and apply. Every setter funnels here so nothing can drift apart. */
  private commit(patch: Partial<ControlPrefsData>) {
    Object.assign(this.prefs, patch);
    save(this.prefs);
  }

  setAuto(on: boolean) {
    this.auto = on;
    this.autoChip.classList.toggle('on', on);
    this.autoChip.textContent = on ? '自动' : '手动';
    // With auto off the player needs a throttle; with it on that space is dead
    // weight under the thumb, so the pedal is removed rather than just dimmed.
    this.gasBtn.style.display = on ? 'none' : '';
    if (on && this.bGas) {
      this.bGas.pointer = -1;
      this.bGas.tapped = false;
      this.bGas.el.classList.remove('down');
    }
    this.dirty = true;
    this.layout();
    if (this.prefs.autoAccel !== on) this.commit({ autoAccel: on });
  }

  setHand(hand: Hand) {
    document.documentElement.setAttribute('data-touch-hand', hand);
    this.commit({ hand });
    this.releaseEverything();
    this.dirty = true;
    this.layout();
  }

  setHaptics(on: boolean) {
    this.state.haptics = on;
    this.commit({ haptics: on });
  }

  setSteerAssist(a: number) {
    this.state.steerAssist = a;
    this.commit({ steerAssist: a });
  }

  setDriftAssist(a: number) {
    this.state.driftAssist = a;
    this.commit({ driftAssist: a });
  }

  setTiltRange(deg: number) {
    this.commit({ tiltRange: deg });
  }

  /** Zero the tilt scheme at the posture the device is in right now. */
  recentreTilt() {
    this.tiltZero = this.tiltRaw;
  }

  /**
   * Swap the steering source without unmounting the cluster.
   *
   * Safe mid-race, and that is a requirement rather than a nicety: every live
   * pointer is released, `steer` is zeroed and `steering` cleared, and NOTHING
   * here touches `IRace`. Switching schemes must never end or reset a race —
   * that is the same class of bug as the pause menu that permanently ended one.
   */
  setScheme(scheme: Scheme) {
    if (scheme === this.prefs.scheme) return;
    this.commit({ scheme });
    this.applyScheme(scheme);
  }

  private applyScheme(scheme: Scheme) {
    this.releaseEverything();
    document.documentElement.setAttribute('data-touch-scheme', scheme);
    if (scheme === 'tilt') this.startTilt();
    else this.stopTilt();
    this.deadzonePx = scheme === 'fixed' ? DEADZONE_PX_FIXED : DEADZONE_PX;
    this.dirty = true;
    this.layout();
    if (scheme === 'fixed') this.showFixedRosette();
    else this.stickWrap.classList.remove('rosette');
  }

  /** Release every live pointer and zero every output. Cannot leave a latch. */
  private releaseEverything() {
    this.stickPointer = -1;
    this.releasing = false;
    this.handoverT = -1;
    this.arcLatched = false;
    this.free.clear();
    this.freeXY.clear();
    this.state.steer = 0;
    this.state.digital = 0;
    this.state.steering = false;
    this.state.active = false;
    this.stickWrap?.classList.remove('live');
    for (const b of this.buttons) {
      b.pointer = -1;
      b.tapped = false;
      b.el.classList.remove('down');
    }
    this.state.drift = false;
    this.state.item = false;
    this.state.look = false;
    this.state.brake = 0;
  }

  /**
   * The live-preview hook used by the controls screen.
   *
   * A blocking menu hides every `.tc-*` element (defect D7), which is correct
   * and is also exactly wrong for a screen whose whole job is "try this scheme
   * and watch it respond". `data-touch-preview` re-reveals the STEERING SOURCE
   * ONLY — never the action cluster, so a preview cannot fire an item, open the
   * pause menu or toggle AUTO by mis-tap.
   */
  setPreview(on: boolean) {
    const de = document.documentElement;
    if (on) de.setAttribute('data-touch-preview', '');
    else de.removeAttribute('data-touch-preview');
    this.releaseEverything();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ layout

  private onContext = (e: Event) => e.preventDefault();

  private onViewportChange = () => {
    this.dirty = true;
    this.layout();
  };

  /**
   * iOS fires `orientationchange` BEFORE layout has settled, so a single
   * re-measure reads the old frame. Two rAFs is the documented-by-experiment
   * minimum. Entering portrait force-releases everything: the rotate card
   * covers the controls, and a pointer that keeps driving an invisible stick is
   * a kart that keeps turning behind a "rotate your device" message.
   */
  private onOrientation = () => {
    this.onViewportChange();
    requestAnimationFrame(() => {
      this.onViewportChange();
      requestAnimationFrame(this.onViewportChange);
    });
  };

  /**
   * Read the safe-area insets once per layout.
   *
   * `env()` cannot be read from JS, so a hidden probe element carries the four
   * insets as padding and `getComputedStyle` reports them resolved. Chrome
   * reports 0 however the viewport is emulated — which is why the CSS carries
   * `env()` terms of its own and the harness checks for the TERM rather than
   * for a number. The floor of SAFE_MIN is the part that is always real: it is
   * the OS gesture band, and Chrome on Android reports 0 for it with gesture
   * navigation active.
   */
  private readSafeArea() {
    const probe = this.root?.querySelector<HTMLElement>('.tc-safeprobe');
    let l = 0, r = 0, t = 0, b = 0;
    if (probe) {
      const cs = getComputedStyle(probe);
      l = parseFloat(cs.paddingLeft) || 0;
      r = parseFloat(cs.paddingRight) || 0;
      t = parseFloat(cs.paddingTop) || 0;
      b = parseFloat(cs.paddingBottom) || 0;
    }
    this.safe = {
      l: Math.max(l, SAFE_MIN), r: Math.max(r, SAFE_MIN),
      t: Math.max(t, SAFE_MIN), b: Math.max(b, SAFE_MIN),
    };
  }

  /**
   * Size and place every control.
   *
   * Positions are computed here rather than written as absolute vmin offsets in
   * CSS, because with three-term clamps on the SIZES a fixed vmin offset no
   * longer tracks them — the cluster would open gaps on a small phone and
   * overlap on a large one. Every button sits at exactly `gap` from its nearest
   * neighbour by construction, which is also what makes a single derived hit
   * pad honest (see the header).
   *
   * The CONTAINER is still positioned in CSS, and must stay that way: its
   * `env(safe-area-inset-*)` terms are what `touch-feel.mjs` reads out of the
   * CSSOM, and the failure it is looking for is an ABSENT term, not a wrong
   * number.
   */
  private layout = () => {
    if (!this.mounted || !this.root) return;
    const vw = innerWidth, vh = innerHeight;
    this.vw = vw; this.vh = vh;
    this.readSafeArea();
    const vmin = Math.min(vw, vh) / 100;
    const cl = (lo: number, mid: number, hi: number) => Math.max(lo, Math.min(hi, mid));

    this.stickRadius = cl(STICK_RADIUS_MIN, Math.min(vw, vh) * STICK_RADIUS_FRAC, STICK_RADIUS_MAX);
    if (this.stickPointer < 0) this.radius = this.stickRadius;

    // --- diameters. Floor 46 px (7.2 mm at the tightest density in the device
    // table), ceiling ~18 mm so a tablet does not get a saucer.
    const dD = cl(64, 21 * vmin, 104);
    const dI = cl(56, 16 * vmin, 88);
    const dB = cl(48, 14 * vmin, 76);
    const dG = dB;
    const dL = cl(TARGET_FLOOR, 11 * vmin, 62);
    const gap = cl(10, 2.4 * vmin, 20);
    const rD = dD / 2, rI = dI / 2, rB = dB / 2, rG = dG / 2, rL = dL / 2;

    // --- polar packing around the DRIFT centre. x runs toward the frame
    // centre, y runs up. Angles are the thumb's natural sweep: ITEM level with
    // DRIFT, BRAKE above it, GAS between, LOOK furthest out.
    const pol = (deg: number, d: number) => {
      const a = (deg * Math.PI) / 180;
      return { x: Math.cos(a) * d, y: Math.sin(a) * d };
    };
    const pItem = pol(0, rD + rI + gap);
    const pBrake = pol(90, rD + rB + gap);
    // 1.30 puts GAS clear of BOTH neighbours at every profile in the table; at
    // 1.0 it would sit on top of them, since it is between two buttons that are
    // themselves only `gap` from DRIFT.
    const pGas = pol(45, ((rD + rG + gap) + (rD + rG + gap)) / 2 * 1.30);
    const pLook = pol(22, rD + rI + gap + rI + rL + gap);

    const maxX = Math.max(rD, pItem.x + rI, pGas.x + rG, pLook.x + rL);
    const maxY = Math.max(rD, pBrake.y + rB, pGas.y + rG, pLook.y + rL);
    const boxW = rD + maxX;
    const boxH = rD + maxY;
    this.cluster.style.width = `${boxW}px`;
    this.cluster.style.height = `${boxH}px`;

    // Buttons are placed from the cluster's bottom-right corner, mirrored for a
    // left-handed layout by the CSS that flips the container. GEOMETRY ONLY.
    const place = (b: Btn, d: number, off: { x: number; y: number }) => {
      b.el.style.width = b.el.style.height = `${d}px`;
      b.el.style.right = `${rD + off.x - d / 2}px`;
      b.el.style.bottom = `${rD + off.y - d / 2}px`;
    };
    place(this.bDrift, dD, { x: 0, y: 0 });
    place(this.bItem, dI, pItem);
    place(this.bBrake, dB, pBrake);
    place(this.bGas, dG, pGas);
    place(this.bLook, dL, pLook);

    // --- the `buttons` scheme's two steering pads. Sized off the same floor,
    // stacked left/right at the thumb, and deliberately large: a player who
    // picks this scheme has told you they cannot hold a stick steadily.
    const dP = cl(72, 22 * vmin, 116);
    for (const b of [this.bLeft, this.bRight]) {
      b.el.style.width = b.el.style.height = `${dP}px`;
    }
    this.padsWrap.style.setProperty('--pad-d', `${dP}px`);
    this.padsWrap.style.setProperty('--pad-gap', `${gap}px`);

    // --- chips. TARGET_FLOOR on the short side, always: PAUSE used to be
    // 30 x 20 CSS px (4.7 x 3.1 mm), under even WCAG 2.5.8's 24 x 24.
    for (const c of [this.autoChip, this.pauseChip]) {
      c.style.height = `${TARGET_FLOOR}px`;
      c.style.minWidth = `${TARGET_FLOOR}px`;
    }

    // --- the stick's drawn size. Decoupled from the hit radius; see RING_FRAC.
    const ring = this.radius * RING_FRAC;
    this.stickBase.style.width = this.stickBase.style.height = `${ring * 2}px`;
    this.stickKnob.style.width = this.stickKnob.style.height = `${ring * 2 * KNOB_FRAC}px`;
    this.ghost.style.setProperty('--ghost-d', `${ring * 2}px`);

    // --- the halo lives outside the DRIFT button: r+8 to r+18. A thumb pad is
    // 10-14 mm, WIDER than the button, so an on-button ring would be under the
    // very thumb it is trying to escape.
    this.cluster.style.setProperty('--halo-d', `${(rD + 18) * 2}px`);
    this.cluster.style.setProperty('--halo-w', '10px');

    if (this.prefs.scheme === 'fixed') this.showFixedRosette();
    this.placeGhost();
    this.dirty = true;

    // Portrait covers the controls with the rotate card; a pointer still
    // driving an invisible stick behind it is a kart that keeps turning.
    if (vh > vw) this.releaseEverything();
  };

  /** The canonical left-thumb rest point, in px rather than in mm. */
  private restPoint() {
    const vw = this.vw || innerWidth, vh = this.vh || innerHeight;
    // 25 mm at 35 deg from the pivot, expressed as a fraction of the short edge
    // because mm are not derivable at runtime (CSS px per mm is 5.9-6.4 across
    // the device table and is never reported to the page).
    const d = Math.max(120, Math.min(190, Math.min(vw, vh) * 0.42));
    const a = (35 * Math.PI) / 180;
    const x = -8 + Math.cos(a) * d;
    const y = vh + 10 - Math.sin(a) * d;
    return this.prefs.hand === 'left'
      ? { x: vw - x, y }
      : { x, y };
  }

  private showFixedRosette() {
    const vw = this.vw || innerWidth, vh = this.vh || innerHeight;
    const rest = this.restPoint();
    const x = this.prefs.fixedX >= 0 ? this.prefs.fixedX * vw : rest.x;
    const y = this.prefs.fixedY >= 0 ? this.prefs.fixedY * vh : rest.y;
    this.originX = x;
    this.originY = y;
    this.stickWrap.classList.add('rosette');
    this.placeStick(0, 0);
  }

  private placeGhost() {
    const p = this.restPoint();
    this.ghost.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    const first = this.prefs.tutorialSeen < TUTORIAL_VERSION;
    // A ghost STICK only makes sense for a scheme that has one. Tilt and the
    // button pads teach themselves differently (the coach beat, and a pad you
    // can see at rest), and a phantom stick beside them would be a lie.
    const hasStick = this.prefs.scheme === 'floating' || this.prefs.scheme === 'fixed';
    this.ghost.classList.toggle('on', first && !this.touchedEver && hasStick);
  }

  // -------------------------------------------------------------- hit testing

  /**
   * Refresh the cached hit circles. Layout is read here and nowhere else —
   * `getBoundingClientRect()` inside a pointer handler forces synchronous
   * layout, five times, on the exact event whose latency the player feels.
   *
   * The pad is DERIVED from the drawn gap rather than being a flat +16 px on
   * radii of 21-43 px, which is what made every padded pair overlap. One number
   * for the cluster: the layout above puts every button at the same `gap` from
   * its nearest neighbour, so a per-control pad would be the same number
   * anyway, and `touch-feel.mjs` models the pad as a constant.
   */
  private measure() {
    this.dirty = false;
    for (const b of this.buttons) {
      const r = b.el.getBoundingClientRect();
      b.cx = r.left + r.width / 2;
      b.cy = r.top + r.height / 2;
      b.visR = r.width === 0 ? 0 : r.width / 2;
    }
    const live = this.buttons.filter((b) => b.visR > 0 && this.enabled(b));
    let minGap = Infinity;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], c = live[j];
        const g = Math.hypot(a.cx - c.cx, a.cy - c.cy) - a.visR - c.visR;
        if (g < minGap) minGap = g;
      }
    }
    const pad = live.length < 2 ? 16 : Math.min(16, Math.max(4, minGap / 2 + 2));
    for (const b of this.buttons) {
      b.padR = b.visR === 0 ? 0 : b.visR + pad;
      b.r2 = b.padR * b.padR;
    }
  }

  /** Is this button part of the current scheme / AUTO state at all? */
  private enabled(b: Btn) {
    if (b.id === 'gas') return !this.auto;
    if (b.id === 'left' || b.id === 'right') return this.prefs.scheme === 'buttons';
    return true;
  }

  /**
   * Two stages, and the order is the whole fix for D2.
   *
   * 1. If the point is inside a button's DRAWN disc, that button wins
   *    unconditionally. What you see is what you press. The old code returned
   *    the first PADDED circle in declaration order, so 198 px of the visible
   *    ITEM face fired DRIFT and 175 px of BRAKE did too — on the drift-facing
   *    edge, exactly where a right thumb travelling from DRIFT arrives.
   * 2. Otherwise take the smallest NORMALISED distance `(dist - visR) / visR`,
   *    ties to the smaller `visR` (the more specific target).
   *
   * Buttons already holding a pointer are skipped, deliberately: a thumb
   * holding DRIFT through a corner, brushed by a second finger, must not have
   * its drift dropped when the BRUSH lifts.
   */
  private hitButton(x: number, y: number): Btn | null {
    if (this.dirty) this.measure();
    let best: Btn | null = null;
    let bestD = Infinity;
    for (const b of this.buttons) {
      if (!this.enabled(b) || b.visR === 0 || b.pointer >= 0) continue;
      const d = Math.hypot(x - b.cx, y - b.cy);
      if (d <= b.visR && d < bestD) { best = b; bestD = d; }
    }
    if (best) return best;

    let bestN = Infinity;
    for (const b of this.buttons) {
      if (!this.enabled(b) || b.visR === 0 || b.pointer >= 0) continue;
      const d = Math.hypot(x - b.cx, y - b.cy);
      if (d > b.padR) continue;
      const n = (d - b.visR) / b.visR;
      if (n < bestN - 1e-6 || (Math.abs(n - bestN) <= 1e-6 && best && b.visR < best.visR)) {
        bestN = n;
        best = b;
      }
    }
    return best;
  }

  private claim(b: Btn, id: number) {
    b.pointer = id;
    b.tapped = true;
    b.el.classList.add('down');
  }

  // ------------------------------------------------------------ steer maths

  /** dead-zoned, rescaled, expo'd. The one place the curve is written. */
  private curve(dx: number): number {
    const r = this.radius;
    const dz = this.deadzonePx / r;
    const u = Math.abs(dx) / r;
    if (u <= dz) return 0;
    const n = Math.min(1, (u - dz) / (1 - dz));
    return Math.sign(dx) * Math.pow(n, CURVE);
  }

  /**
   * The exact inverse of `curve`, and the shared primitive behind three
   * different problems: the D1 thumb-roll handover, re-grabbing during the
   * release ramp, and a resize mid-drag. All three are the same operation —
   * "the output must not jump" — so all three call this, and the round-trip is
   * tested rather than assumed.
   */
  private transplantOrigin(clientX: number, steer: number) {
    const r = this.radius;
    const dz = this.deadzonePx / r;
    const s = Math.max(-1, Math.min(1, steer));
    const n = Math.pow(Math.abs(s), 1 / CURVE);
    const u = n * (1 - dz) + dz;
    const dx = Math.sign(s) * u * r * (Math.abs(s) < 1e-9 ? 0 : 1);
    this.originX = clientX - dx;
    this.clampOrigin();
  }

  /** The base may trail, but it may not migrate out of its own half over a lap. */
  private clampOrigin() {
    const lo = this.safe.l + 8;
    const hi = this.vw * 0.5 - 8;
    if (this.prefs.hand === 'left') {
      this.originX = Math.max(this.vw * 0.5 + 8, Math.min(this.vw - this.safe.r - 8, this.originX));
    } else {
      this.originX = Math.max(lo, Math.min(hi, this.originX));
    }
  }

  /**
   * Is this point a legal place to START a stick?
   *
   * x from `safeLeft + 60` (NOT from the edge: at x = 24 the trailing base
   * never engages, so full lock LEFT would be unreachable — the room clamp and
   * the spawn rectangle are one decision, not two) out to 0.46 W. The upper 22%
   * is excluded so a thumb reaching for PAUSE and missing cannot spawn a
   * steering stick at head height.
   */
  private inSpawn(x: number, y: number) {
    const vw = this.vw || innerWidth, vh = this.vh || innerHeight;
    if (y < vh * 0.22 || y > vh - 24) return false;
    if (this.prefs.hand === 'left') {
      return x >= vw * 0.54 && x <= vw - this.safe.r - 60;
    }
    return x >= this.safe.l + 60 && x <= vw * 0.46;
  }

  /**
   * Room clamp. Full lock must be reachable from every legal spawn, so the grab
   * radius is capped by how much room there is between the origin and the safe
   * edge — never below R_GRAB_MIN, because a 20 px stick is not a stick. At the
   * leftmost legal spawn this gives exactly 56 and full lock lands 4 px inside
   * the safe edge.
   */
  private grabRadius(x: number) {
    const room = this.prefs.hand === 'left'
      ? (this.vw - this.safe.r) - x - 4
      : x - this.safe.l - 4;
    return Math.max(R_GRAB_MIN, Math.min(this.stickRadius, room));
  }

  private claimStick(id: number, x: number, y: number) {
    const wasSteer = this.releasing ? this.state.steer : 0;
    this.stickPointer = id;
    this.radius = this.prefs.scheme === 'fixed' ? this.stickRadius : this.grabRadius(x);
    this.arcLatched = false;
    this.arcCos = 1;
    this.arcSin = 0;
    this.grabTravel = 0;
    this.handoverT = -1;
    if (this.prefs.scheme === 'fixed') {
      // Frozen rosette: the origin does not move, so the first touch already
      // carries a deflection. That is what a fixed stick IS.
      this.state.steer = this.curve(x - this.originX);
    } else if (this.releasing && Math.abs(wasSteer) > 1e-4) {
      // Re-grab inside the release ramp: continue from where the ramp got to,
      // rather than snapping to zero under a thumb that never left the glass.
      // The window is self-limiting — exactly as long as the ramp, <= 62.5 ms.
      this.transplantOrigin(x, wasSteer);
      this.originY = y;
      this.state.steer = wasSteer;
    } else {
      this.originX = x;
      this.originY = y;
      this.clampOrigin();
      this.state.steer = 0;
    }
    this.releasing = false;
    this.state.steering = true;
    this.stickWrap.classList.add('live');
    this.placeStick(this.stickOffset(), 0);
  }

  private stickOffset() {
    // Recover the drawn offset from the current output, so the knob and the
    // number can never disagree.
    const r = this.radius;
    const dz = this.deadzonePx / r;
    const s = Math.abs(this.state.steer);
    if (s < 1e-9) return 0;
    return Math.sign(this.state.steer) * (Math.pow(s, 1 / CURVE) * (1 - dz) + dz) * r;
  }

  // ----------------------------------------------------------------- pointers

  private onDown = (e: PointerEvent) => {
    if (!this.mounted) return;
    const t = e.target as HTMLElement;
    if (t?.closest?.('.tc-chip')) return; // handled by their own listeners
    this.touchedEver = true;
    this.ghost.classList.remove('on');

    const btn = this.hitButton(e.clientX, e.clientY);
    if (btn) {
      e.preventDefault();
      this.claim(btn, e.pointerId);
      return;
    }

    if (this.canSpawnStick(e)) {
      e.preventDefault();
      this.claimStick(e.pointerId, e.clientX, e.clientY);
      return;
    }

    // Landed on nothing. Keep watching it: a thumb that missed the button it
    // was aiming at can still slide on, and a thumb that lands while another is
    // steering is the HEIR if that other one lifts.
    this.free.add(e.pointerId);
    this.freeXY.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  private canSpawnStick(e: PointerEvent) {
    const sch = this.prefs.scheme;
    if (sch === 'tilt' || sch === 'buttons') return false;
    if (this.stickPointer >= 0) return false;
    const x = e.clientX, y = e.clientY;
    // Edge guard, on pointerdown only. A drag that LEAVES through the band is
    // fine; it is the touch that STARTS there that the OS steals.
    if (x < EDGE_GUARD || x > this.vw - EDGE_GUARD || y < EDGE_GUARD || y > this.vh - EDGE_GUARD) return false;
    // Palm rejection, feature-detected. Safari reports width === 1 for every
    // touch, so a browser that has never reported anything else is one whose
    // contact size carries no information at all and the test is skipped.
    if (contactKnown(e) && Math.max(e.width, e.height) > PALM_PX) return false;
    if (sch === 'fixed') {
      // A fixed stick is grabbed by touching near its rosette, not by touching
      // the whole half — otherwise a touch at the far edge is instant full lock.
      return Math.hypot(x - this.originX, y - this.originY) <= this.stickRadius * 1.35;
    }
    return this.inSpawn(x, y);
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) {
      const known = this.free.has(e.pointerId);
      if (known) this.freeXY.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!known) return;
      // A thumb that missed the button it was aiming at can still slide on.
      const b = this.hitButton(e.clientX, e.clientY);
      if (b) {
        e.preventDefault();
        this.free.delete(e.pointerId);
        this.freeXY.delete(e.pointerId);
        this.claim(b, e.pointerId);
        return;
      }
      // D1's second half: a free pointer that MOVES while nothing is steering
      // takes the stick. Without this, a thumb that landed a moment too early
      // can never steer, however far it drags.
      if (this.stickPointer < 0 && this.canSpawnStickAt(e.clientX, e.clientY)) {
        e.preventDefault();
        this.free.delete(e.pointerId);
        this.freeXY.delete(e.pointerId);
        this.claimStick(e.pointerId, e.clientX, e.clientY);
      }
      return;
    }
    e.preventDefault();
    // Any movement from the heir cancels the palm-safety decay.
    this.handoverT = -1;

    let dx = e.clientX - this.originX;
    let dy = e.clientY - this.originY;
    const r = this.radius;

    // Thumb-arc alignment: latch the drag axis once the grab has actually
    // travelled, then measure along it.
    if (!this.arcLatched) {
      this.grabTravel = Math.hypot(dx, dy);
      if (this.grabTravel >= ARC_LATCH_PX) {
        let th = Math.atan2(dy, dx);
        // Fold into (-90, 90]: a leftward drag and a rightward drag share an
        // axis. Then clamp, so a vertical stab cannot rotate it into nonsense.
        if (th > Math.PI / 2) th -= Math.PI;
        else if (th <= -Math.PI / 2) th += Math.PI;
        th = Math.max(-ARC_MAX_RAD, Math.min(ARC_MAX_RAD, th));
        this.arcCos = Math.cos(th);
        this.arcSin = Math.sin(th);
        this.arcLatched = true;
      }
    }
    const project = () => (this.arcLatched ? dx * this.arcCos + dy * this.arcSin : dx);
    let dxEff = project();

    if (this.prefs.scheme !== 'fixed' && Math.abs(dxEff) > r) {
      /**
       * Let the base trail the thumb once it leaves the ring, so the stick never
       * saturates and a pull back toward centre responds immediately.
       *
       * LOCK RADIUS AND TRAIL RADIUS MUST BE THE SAME NUMBER. If they differ
       * there is a band at the rim where pushing further does nothing and
       * pulling back does nothing either, which is the exact "saturates and
       * then feels dead" failure the floating base exists to avoid.
       *
       * The origin slides ALONG the latched axis, not along screen X, or an
       * arced thumb would walk the base off its own diagonal over a long pull.
       */
      const over = dxEff - Math.sign(dxEff) * r;
      this.originX += over * this.arcCos;
      this.originY += over * this.arcSin;
      this.clampOrigin();
      dx = e.clientX - this.originX;
      dy = e.clientY - this.originY;
      dxEff = project();
    }
    dxEff = Math.max(-r, Math.min(r, dxEff));

    this.state.steer = this.curve(dxEff);
    this.placeStick(dx, dy);
  };

  private canSpawnStickAt(x: number, y: number) {
    const sch = this.prefs.scheme;
    if (sch === 'tilt' || sch === 'buttons') return false;
    if (sch === 'fixed') return Math.hypot(x - this.originX, y - this.originY) <= this.stickRadius * 1.35;
    return this.inSpawn(x, y);
  }

  private onUp = (e: PointerEvent) => {
    this.free.delete(e.pointerId);
    this.freeXY.delete(e.pointerId);
    if (e.pointerId === this.stickPointer) {
      this.stickPointer = -1;
      /**
       * D1. Before handing the steering back to zero, look for an heir: a free
       * pointer already on the glass inside the spawn region. Adopt the MOST
       * RECENTLY added one — a rolled thumb's new contact is the newest thing
       * down — and transplant the origin so the output is reproduced EXACTLY.
       * Steering is continuous across the roll: no snap, no jump, no lost lap.
       */
      const heir = this.pickHeir();
      if (heir >= 0) {
        const p = this.freeXY.get(heir)!;
        const carry = this.state.steer;
        this.free.delete(heir);
        this.freeXY.delete(heir);
        this.stickPointer = heir;
        this.radius = this.prefs.scheme === 'fixed' ? this.stickRadius : this.grabRadius(p.x);
        this.transplantOrigin(p.x, carry);
        this.originY = p.y;
        this.arcLatched = false;
        this.state.steer = carry;
        this.state.steering = true;
        this.releasing = false;
        // Palm safety: if the heir never moves, this decays. See HANDOVER_*.
        this.handoverT = 0;
        this.placeStick(this.stickOffset(), 0);
      } else {
        // Owned release ramp. `steering` stays TRUE while steer != 0 so Input
        // keeps taking the analogue path and its digital return branch stops
        // being load-bearing for touch.
        this.releasing = Math.abs(this.state.steer) > 1e-6;
        if (!this.releasing) {
          this.state.steer = 0;
          this.state.steering = false;
          this.stickWrap.classList.remove('live');
        }
      }
    }
    for (const b of this.buttons) {
      if (b.pointer === e.pointerId) {
        b.pointer = -1;
        b.el.classList.remove('down');
      }
    }
  };

  private pickHeir(): number {
    let best = -1;
    for (const id of this.free) {
      const p = this.freeXY.get(id);
      if (!p || !this.canSpawnStickAt(p.x, p.y)) continue;
      best = id; // Sets iterate in insertion order, so the last match is newest
    }
    return best;
  }

  private placeStick(dx: number, dy: number) {
    const ring = this.radius * RING_FRAC;
    const k = Math.hypot(dx, dy);
    // The knob tracks 1:1 until the rim; past it the remaining travel is rim
    // alpha, so the outer 38% of the sweep stays legible without the ring
    // having to be as big as the hit area.
    const scale = k > ring ? ring / k : 1;
    this.stickBase.style.transform =
      `translate(${this.originX}px, ${this.originY}px) translate(-50%, -50%)`;
    this.stickKnob.style.transform =
      `translate(${this.originX + dx * scale}px, ${this.originY + dy * scale}px) translate(-50%, -50%)`;
    this.stickBase.style.setProperty('--rim', (0.35 + 0.65 * Math.abs(this.state.steer)).toFixed(3));
  }

  // --------------------------------------------------------------------- tilt

  private startTilt() {
    if (this.tiltOn) return;
    this.tiltOn = true;
    this.tiltSeen = false;
    addEventListener('deviceorientation', this.onTilt);
  }

  private stopTilt() {
    if (!this.tiltOn) return;
    this.tiltOn = false;
    removeEventListener('deviceorientation', this.onTilt);
    this.tiltRaw = 0;
  }

  /**
   * iOS 13+ gates DeviceOrientation behind a permission prompt that may only be
   * requested from a user gesture. Called from the controls screen's own tap.
   */
  async requestTilt(): Promise<boolean> {
    const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof D?.requestPermission === 'function') {
      try {
        const r = await D.requestPermission();
        if (r !== 'granted') return false;
      } catch { return false; }
    }
    return true;
  }

  /** True once a real orientation sample has arrived — the menu shows this. */
  get tiltAvailable() { return this.tiltSeen; }

  /**
   * Project gravity into SCREEN space.
   *
   * This is the pre-registered trap: the naive implementation reads `gamma` and
   * inverts on a landscape phone, because `screen.orientation.angle` flips
   * between 90 and 270 depending on which way the device was rotated, and a
   * scheme that steers backwards in one of the two landscapes is a scheme that
   * looks fine in every test somebody thought to run.
   *
   * Derivation, so the signs can be checked rather than trusted. With the
   * ZXY intrinsic convention the DOM uses, the world-up vector expressed in
   * device coordinates is `u = (-sinY*cosB, sinB, cosY*cosB)`, so gravity is
   * `-u`. The screen's RIGHT axis in device coordinates is
   * `(cos a, -sin a, 0)` for `a = screen.orientation.angle` — check it at
   * a = 0 (portrait: screen right = device +x) and at a = 90 (device top points
   * to screen left, so screen right = device -y).
   *
   * Therefore `tilt = g . screenRight = sinY*cosB*cos a + sinB*sin a`, which is
   * `sin(roll about the screen's vertical axis)`: dip the screen's RIGHT edge
   * and it goes positive. Positive = the player wants to go right = the input
   * contract. There is no negation here and there must never be one.
   */
  private onTilt = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const B = (e.beta * Math.PI) / 180;
    const Y = (e.gamma * Math.PI) / 180;
    const a = ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) * Math.PI) / 180;
    const g = Math.sin(Y) * Math.cos(B) * Math.cos(a) + Math.sin(B) * Math.sin(a);
    // Report the ANGLE, in degrees, so the range preference is in a unit the
    // player can be shown ("26 degrees to full lock") rather than a unit-free
    // sensitivity slider that means nothing.
    this.tiltRaw = (Math.asin(Math.max(-1, Math.min(1, g))) * 180) / Math.PI;
    if (!this.tiltSeen) {
      this.tiltSeen = true;
      // The first sample is the player's actual holding posture, so it is zero.
      this.tiltZero = this.tiltRaw;
    }
  };

  /** Degrees off the calibrated neutral — shown live on the controls screen. */
  get tiltDegrees() { return this.tiltRaw - this.tiltZero; }

  // -------------------------------------------------------------------- frame

  /**
   * Called once per frame by Input, before it reads `state`.
   *
   * `held || tapped` is the whole point of the latch: a press that has already
   * been released is still reported for the one frame that first sees it, so a
   * sub-frame stab at DRIFT or ITEM lands instead of vanishing. A tap shorter
   * than a frame is a 33 ms window on a phone at 30 fps and a perfectly
   * ordinary stab at the item button.
   */
  update(ctx: Ctx | null, dt: number) {
    const s = this.state;
    const sch = this.prefs.scheme;

    // --- steering source ------------------------------------------------
    s.digital = 0;
    if (sch === 'tilt') {
      const range = Math.max(6, this.prefs.tiltRange);
      const deg = this.tiltDegrees;
      const m = Math.abs(deg);
      const out = m <= TILT_DEADZONE_DEG
        ? 0
        : Math.sign(deg) * Math.min(1, Math.pow((m - TILT_DEADZONE_DEG) / (range - TILT_DEADZONE_DEG), CURVE));
      s.steer = out;
      // `steering` true only once a real sample has landed, so a device that
      // never fires the event falls back to the keyboard path rather than
      // pinning the command at a confident zero.
      s.steering = this.tiltSeen;
    } else if (sch === 'buttons') {
      const l = this.bLeft.pointer >= 0 || this.bLeft.tapped;
      const r = this.bRight.pointer >= 0 || this.bRight.tapped;
      // A DIGITAL request. Input owns the ramp — see I2 in the header.
      s.digital = (r ? 1 : 0) - (l ? 1 : 0);
      s.steer = 0;
      s.steering = false;
    } else if (this.releasing) {
      const d = RELEASE_RATE * dt;
      s.steer = Math.abs(s.steer) <= d ? 0 : s.steer - Math.sign(s.steer) * d;
      if (s.steer === 0) {
        this.releasing = false;
        s.steering = false;
        this.stickWrap.classList.remove('live');
      }
    } else if (this.handoverT >= 0) {
      // Palm safety on an adopted heir that has not moved.
      this.handoverT += dt;
      if (this.handoverT > HANDOVER_SETTLE) {
        const k = Math.min(1, (this.handoverT - HANDOVER_SETTLE) / HANDOVER_DECAY);
        s.steer = s.steer * (1 - k) + 0 * k;
        if (k >= 1) {
          s.steer = 0;
          this.handoverT = -1;
        }
      }
    }

    // --- buttons ----------------------------------------------------------
    s.drift = this.bDrift.pointer >= 0 || this.bDrift.tapped;
    s.item = this.bItem.pointer >= 0 || this.bItem.tapped;
    s.look = this.bLook.pointer >= 0 || this.bLook.tapped;
    s.brake = this.bBrake.pointer >= 0 || this.bBrake.tapped ? 1 : 0;
    const gas = !this.auto && (this.bGas.pointer >= 0 || this.bGas.tapped);
    s.accel = this.auto ? (s.brake > 0 ? 0 : 1) : gas ? 1 : 0;
    // Only the assist's throttle is flagged. With AUTO off the player is
    // pressing GAS themselves, and the rocket start should count that.
    s.autoAccel = this.auto && s.accel > 0;
    s.active = this.stickPointer >= 0 || s.digital !== 0 ||
      this.bDrift.pointer >= 0 || this.bItem.pointer >= 0 || this.bBrake.pointer >= 0 ||
      this.bLook.pointer >= 0 || this.bGas.pointer >= 0 ||
      s.drift || s.item || s.brake > 0 || gas;
    for (let i = 0; i < this.buttons.length; i++) this.buttons[i].tapped = false;

    if (ctx) this.coach(ctx, dt);
  }

  // -------------------------------------------------------------- onboarding

  /**
   * Three beats, each printed ON the control it refers to, each gated on the
   * player actually doing the thing, each with a hard timeout so it can never
   * block a race. No overlay, no dimming, nothing to dismiss, at most two words
   * on screen at any instant.
   *
   * The old onboarding was one line of `clamp(9px, 1.4vmin, 18px)` type at 44%
   * opacity — 1.5 mm of glyph — naming controls without showing where they are,
   * while the floating stick was invisible at rest. A first-run player had no
   * visual evidence a steering control existed.
   */
  private coach(ctx: Ctx, dt: number) {
    if (this.coachDone || this.prefs.tutorialSeen >= TUTORIAL_VERSION) return;
    const race = ctx.race;
    if (!race) return;
    const st = race.state;
    if (st === RaceState.Menu || st === RaceState.Results) {
      this.lastRaceState = st;
      return;
    }
    // A new race resets the sequence exactly once; nothing here runs twice.
    if (this.lastRaceState === RaceState.Menu && st === RaceState.Countdown) {
      this.coachStep = 1;
      this.coachT = 0;
    }
    this.lastRaceState = st;
    if (this.coachStep === 0) return;
    this.coachT += dt;

    const player = race.player;
    const say = (word: string, where: 'stick' | 'drift') => {
      if (this.coachEl.textContent !== word) this.coachEl.textContent = word;
      this.coachEl.setAttribute('data-at', where);
      this.coachEl.classList.add('on');
      if (where === 'stick') {
        const p = this.stickPointer >= 0 || this.prefs.scheme === 'fixed'
          ? { x: this.originX, y: this.originY }
          : this.restPoint();
        this.coachEl.style.transform = `translate(${p.x}px, ${p.y - this.radius * RING_FRAC - 26}px) translate(-50%, -50%)`;
      } else {
        const b = this.bDrift;
        this.coachEl.style.transform = `translate(${b.cx}px, ${b.cy - b.visR - 26}px) translate(-50%, -50%)`;
      }
    };
    const hide = () => this.coachEl.classList.remove('on');

    switch (this.coachStep) {
      case 1: // STEER — during the countdown's ~3.5 s of dead time
        say(this.prefs.scheme === 'tilt' ? '体感' : '转向', 'stick');
        if (Math.abs(this.state.steer) > 0.35 || this.state.digital !== 0 || this.coachT > 2.5) {
          this.coachStep = 2;
          this.coachT = 0;
          hide();
        }
        break;
      case 2: // DRIFT — armed once the race is actually running
        if (st !== RaceState.Racing) break;
        say('漂移', 'drift');
        if (player && player.driftDir !== 0) { this.coachStep = 3; this.coachT = 0; hide(); }
        else if (this.coachT > 6) { this.coachStep = 3; this.coachT = 0; hide(); }
        break;
      case 3: // RELEASE — the first time a tier is banked
        if (player && player.driftTier >= 1 && player.driftDir !== 0) {
          say('松开', 'drift');
          this.bDrift.el.classList.add('letgo');
        } else if (this.coachT > 12) {
          this.finishCoach();
        } else if (this.bDrift.el.classList.contains('letgo')) {
          // They released with a tier banked, or lost it. Either way, done.
          this.finishCoach();
        }
        break;
    }
  }

  private finishCoach() {
    this.coachDone = true;
    this.coachEl.classList.remove('on');
    this.bDrift.el.classList.remove('letgo');
    this.commit({ tutorialSeen: TUTORIAL_VERSION });
  }

  /** Input clears this after converting it to a one-frame edge. */
  consumePause() {
    const p = this.state.pause;
    this.state.pause = false;
    return p;
  }
}

/**
 * Safari reports `width === 1 && height === 1` for every touch, so a 1x1 report
 * is "this browser does not measure contact size", not "this is a stylus".
 */
function contactKnown(e: PointerEvent) {
  return e.pointerType === 'touch' && !(e.width === 1 && e.height === 1) && e.width > 0;
}

const MARKUP = `
<div class="tc-safeprobe"></div>

<div class="tc-stick-zone">
  <div class="tc-stick-base"></div>
  <div class="tc-stick-knob"></div>
  <div class="tc-ghost"><i></i><b></b></div>
</div>

<div class="tc-pads">
  <div class="tc-btn tc-pad tc-pad-l" data-btn="left"><span>&#9664;</span></div>
  <div class="tc-btn tc-pad tc-pad-r" data-btn="right"><span>&#9654;</span></div>
</div>

<div class="tc-top">
  <div class="tc-chip tc-pause" data-btn="pause">II</div>
  <div class="tc-chip tc-auto on">自动</div>
</div>

<div class="tc-cluster">
  <div class="tc-btn tc-look"  data-btn="look"><span>&#9664;&#9654;</span></div>
  <div class="tc-btn tc-brake" data-btn="brake"><span>刹车</span></div>
  <div class="tc-btn tc-gas"   data-btn="gas"><span>油门</span></div>
  <div class="tc-btn tc-item"  data-btn="item">
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="6" y="6" width="28" height="28" rx="7" fill="none" stroke="currentColor" stroke-width="3"/>
      <path d="M20 13v14M13 20h14" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="tc-btn tc-drift" data-btn="drift">
    <div class="tc-halo"></div>
    <div class="tc-halo-rungs"></div>
    <span>漂移</span>
  </div>
</div>

<div class="tc-coach"></div>

<div class="tc-rotate"><div><b>请横向握持</b><br/>卡丁王者需要横屏游玩。</div></div>
`;

const CSS = `
.tc-root {
  position: fixed; inset: 0; z-index: 20;
  pointer-events: none; touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  font: 700 3.1vmin/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.06em;
}

/* env() cannot be read from JS. This carries the four insets as padding so
   getComputedStyle reports them resolved; it is 0x0 and never painted. */
.tc-safeprobe {
  position: absolute; left: 0; top: 0; width: 0; height: 0; visibility: hidden;
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
}

/* The stick zone is a hit area only; the visuals are positioned absolutely
   from JS at the thumb, so this stays empty until a touch lands. */
.tc-stick-zone {
  position: absolute;
  top: env(safe-area-inset-top, 0px);
  bottom: env(safe-area-inset-bottom, 0px);
  left: env(safe-area-inset-left, 0px);
  right: 50%;
}
html[data-touch-hand="left"] .tc-stick-zone {
  left: 50%;
  right: env(safe-area-inset-right, 0px);
}
.tc-stick-base, .tc-stick-knob {
  position: fixed; top: 0; left: 0; border-radius: 50%;
  opacity: 0; transition: opacity 120ms ease;
  will-change: transform, opacity;
}
.tc-stick-base {
  --rim: .42;
  background: radial-gradient(circle at 50% 45%, rgba(255,255,255,.10), rgba(8,14,26,.30) 70%);
  border: 2px solid rgba(255,255,255,var(--rim));
  box-shadow: 0 4px 22px rgba(0,0,0,.45), inset 0 0 20px rgba(255,255,255,.07);
}
.tc-stick-knob {
  background: radial-gradient(circle at 40% 35%, #fff, #ffd98a 55%, #f0a93c 100%);
  border: 2px solid rgba(255,255,255,.85);
  box-shadow: 0 6px 18px rgba(0,0,0,.5), 0 0 22px rgba(255,190,90,.55);
}
.tc-stick-zone.live .tc-stick-base { opacity: .78; }
.tc-stick-zone.live .tc-stick-knob { opacity: 1; }
/* The fixed scheme draws its rosette at rest, which is the entire difference a
   player can see between it and the floating one. */
.tc-stick-zone.rosette .tc-stick-base { opacity: .34; }
.tc-stick-zone.rosette .tc-stick-knob { opacity: .55; }
.tc-stick-zone.rosette.live .tc-stick-base { opacity: .78; }
.tc-stick-zone.rosette.live .tc-stick-knob { opacity: 1; }

/* FIRST RUN ONLY. A breathing ghost at the canonical thumb rest point, so a
   player who has never seen this game has visual evidence a steering control
   exists before they have touched anything. No words. Vanishes permanently on
   the first touch anywhere. */
.tc-ghost {
  position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;
  width: var(--ghost-d, 110px); height: var(--ghost-d, 110px);
  transition: opacity .35s ease;
}
.tc-ghost.on { opacity: 1; animation: tc-breathe 2.4s ease-in-out infinite; }
.tc-ghost i, .tc-ghost b {
  position: absolute; border-radius: 50%; left: 50%; top: 50%;
}
.tc-ghost i {
  width: 100%; height: 100%; transform: translate(-50%, -50%);
  border: 2px dashed rgba(255,255,255,.42);
}
.tc-ghost b {
  width: 42%; height: 42%;
  background: radial-gradient(circle at 40% 35%, rgba(255,255,255,.9), rgba(240,169,60,.75));
  animation: tc-sweep 2.4s ease-in-out infinite;
}
@keyframes tc-breathe { 0%,100% { opacity: .40; } 50% { opacity: .85; } }
@keyframes tc-sweep {
  0%,100% { transform: translate(-140%, -50%); }
  50%     { transform: translate(40%, -50%); }
}

/* Two words, maximum, printed on the control they refer to. */
.tc-coach {
  position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;
  padding: .55em .9em; border-radius: 999px; white-space: nowrap;
  font-size: clamp(13px, 2.6vmin, 20px); letter-spacing: .16em;
  color: #10202f; background: linear-gradient(180deg, #ffe6a8, #f2b445);
  box-shadow: 0 4px 16px rgba(0,0,0,.5);
  transition: opacity .2s ease;
}
.tc-coach.on { opacity: .96; animation: tc-breathe 1.6s ease-in-out infinite; }

/* The two steering pads of the button scheme.
   ANCHORING LIVES IN THE BASE RULE and only display is toggled. When the
   position was inside the scheme rule instead, the live-preview rule at the
   foot of this file — two attribute selectors, so higher specificity — revealed
   an UNPOSITIONED pads box at 0,0 across the top-left of the controls screen
   for every other scheme. Found by looking at a screenshot, which is the one
   class of defect a screenshot is good for. */
.tc-pads {
  display: none; position: absolute; align-items: flex-end;
  left: calc(env(safe-area-inset-left, 0px) + 24px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
}
html[data-touch-hand="left"] .tc-pads {
  left: auto; right: calc(env(safe-area-inset-right, 0px) + 24px);
}
html[data-touch-scheme="buttons"] .tc-pads { display: flex; }
/* Specificity, deliberately: the generic .tc-btn rule below sets
   position: absolute and comes later in this sheet, which stacked both pads at
   the same auto position — two buttons, one visible, and the left one dead. */
.tc-pads .tc-pad { position: relative; display: grid; }
.tc-pads .tc-pad span { font-size: clamp(20px, 3.6vmin, 34px); }
.tc-pad-r { margin-left: var(--pad-gap, 12px); }


.tc-top {
  position: absolute; display: flex; gap: 10px; align-items: center;
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  left: calc(env(safe-area-inset-left, 0px) + 26vmin);
}
/* The top rail deliberately does NOT mirror. See the matching note in ui.css:
   the HUD keeps its race timer top-right in both modes, so a mirrored chip rail
   lands on top of it. Mirror what the thumbs touch, not what they read. */
.tc-chip {
  pointer-events: auto; padding: 0 14px;
  display: grid; place-items: center;
  border-radius: 999px; color: #cfd8e6;
  background: rgba(10,16,28,.55); border: 1.5px solid rgba(255,255,255,.20);
  backdrop-filter: blur(6px); font-size: clamp(12px, 2.2vmin, 17px);
  text-shadow: 0 1px 2px rgba(0,0,0,.6);
}
.tc-chip.on {
  color: #10202f; text-shadow: none;
  background: linear-gradient(180deg, #ffe6a8, #f2b445);
  border-color: rgba(255,255,255,.6);
}
.tc-pause { letter-spacing: .14em; }

.tc-cluster {
  position: absolute;
  right: calc(env(safe-area-inset-right, 0px) + 24px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
}
html[data-touch-hand="left"] .tc-cluster {
  right: auto;
  left: calc(env(safe-area-inset-left, 0px) + 24px);
  transform: scaleX(-1);
}
/* Mirroring the BOX flips the glyphs with it, so the labels are un-flipped
   again. This is the whole left-handed implementation: one transform on one
   container, and not one sign anywhere. */
html[data-touch-hand="left"] .tc-btn > span,
html[data-touch-hand="left"] .tc-btn > svg { transform: scaleX(-1); }

.tc-btn {
  position: absolute; pointer-events: auto;
  display: grid; place-items: center; border-radius: 50%;
  color: #f4f7fb; text-align: center;
  background: radial-gradient(circle at 50% 38%, rgba(255,255,255,.16), rgba(9,15,27,.52) 72%);
  border: 2px solid rgba(255,255,255,.34);
  box-shadow: 0 5px 18px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.22);
  backdrop-filter: blur(5px);
  text-shadow: 0 1px 3px rgba(0,0,0,.75);
  /* 90ms was long enough that a fast tap released before the press state had
     finished animating in, so a stab at DRIFT looked like it had missed even
     when it had not. Feedback on a control must not lag the control. */
  transition: transform 55ms ease, box-shadow 55ms ease, background 55ms ease;
}
.tc-btn span { font-size: clamp(10px, 2.2vmin, 17px); }
.tc-btn svg { width: 52%; height: 52%; }
.tc-btn.down { transform: scale(.92); }
html[data-touch-hand="left"] .tc-btn.down { transform: scale(.92); }

.tc-drift {
  background: radial-gradient(circle at 50% 36%, rgba(120,220,255,.42), rgba(12,52,84,.62) 72%);
  border-color: rgba(150,230,255,.72);
  box-shadow: 0 6px 22px rgba(0,0,0,.45), 0 0 26px rgba(79,195,255,.32), inset 0 1px 0 rgba(255,255,255,.3);
}
.tc-drift.down { box-shadow: 0 0 40px rgba(79,195,255,.85), inset 0 1px 0 rgba(255,255,255,.4); }
.tc-drift.letgo span { font-size: 0; }
.tc-drift.letgo span::after { content: '松开'; font-size: clamp(10px, 2.2vmin, 17px); }
.tc-item.down { box-shadow: 0 0 34px rgba(255,214,110,.8); }
.tc-look { opacity: .82; }

/* ---- THE CHARGE HALO ------------------------------------------------------
   The mini-turbo ladder, drawn OUTSIDE the DRIFT button (r+8 to r+18) and
   sweeping the UPPER SEMICIRCLE ONLY, 9 o'clock through 12 to 3.

   Outside, because a thumb pad is 10-14 mm across — WIDER than the button — so
   a ring drawn ON the button would be under the exact thumb it is escaping.
   Upper semicircle, because the lower half is where the palm sits.

   It costs nothing: HUD.ts already computes --fill, --cc and --cn every frame
   for the screen-edge rails and now writes them to documentElement as well, so
   this is one extra custom-property write a frame and one conic-gradient. No
   layout, no allocation, no cross-module API and no types.ts change. */
.tc-halo, .tc-halo-rungs {
  position: absolute; left: 50%; top: 50%;
  width: var(--halo-d, 120px); height: var(--halo-d, 120px);
  transform: translate(-50%, -50%);
  border-radius: 50%; pointer-events: none;
  opacity: 0; transition: opacity .16s linear;
  -webkit-mask-image: radial-gradient(circle closest-side, transparent calc(100% - var(--halo-w, 10px)), #000 calc(100% - var(--halo-w, 10px)));
          mask-image: radial-gradient(circle closest-side, transparent calc(100% - var(--halo-w, 10px)), #000 calc(100% - var(--halo-w, 10px)));
}
.tc-halo {
  background: conic-gradient(from 270deg,
    var(--cc, #a8b6cc) 0deg,
    var(--cc, #a8b6cc) calc(var(--fill, 0) * 180deg),
    rgba(255,255,255,.13) calc(var(--fill, 0) * 180deg),
    rgba(255,255,255,.13) 180deg,
    transparent 180deg);
}
/* RUNGS, NOT HUE. Two ticks at a third and two thirds of the sweep: the tier is
   a COUNT of marks the arc has passed. Cream between two ink edges, the same
   recipe the screen-edge rails use, so it survives a blown-out sky and a
   red-green deficiency alike. */
.tc-halo-rungs {
  background: conic-gradient(from 270deg,
    transparent 0deg, transparent 57deg,
    rgba(30,16,7,.9) 57deg, rgba(255,246,230,.96) 59deg, rgba(30,16,7,.9) 61deg,
    transparent 61deg, transparent 117deg,
    rgba(30,16,7,.9) 117deg, rgba(255,246,230,.96) 119deg, rgba(30,16,7,.9) 121deg,
    transparent 121deg);
}
html[data-drift-tier] .tc-halo,
html[data-drift-tier] .tc-halo-rungs { opacity: 1; }
/* The flare starts AT PEAK on frame zero — round 11's lesson that a cue must
   land on the trigger frame, not two frames later.

   ONE KEYFRAME NAME PER TIER, AND THAT IS THE WHOLE POINT. This block used to
   be three selectors sharing 'animation: tc-flare', with a comment claiming
   "re-matching the attribute selector restarts the animation". It does not.
   Changing data-drift-tier from "1" to "2" changes which SELECTOR matches, but
   the computed animation-name is identical, so the browser treats it as the
   same still-running (or already-finished) animation and never restarts it —
   'getAnimations()' comes back empty at tiers 2 and 3. The flare fired exactly
   once per drift, on the null -> 1 edge, and tier 3 — the one worth the most
   speed and the one you most need to feel without looking — was silent.
   Nothing caught it because the rung COUNT still moves, so the ladder stayed
   readable and only the punctuation was missing.

   Distinct names restart it, because animation-name actually changed. Having
   paid for three keyframes, they escalate rather than repeat: tier 3 is the
   payout, so it flares brightest and widest. */
html[data-drift-tier="1"] .tc-halo { animation: tc-flare1 .44s ease-out; }
html[data-drift-tier="2"] .tc-halo { animation: tc-flare2 .44s ease-out; }
html[data-drift-tier="3"] .tc-halo { animation: tc-flare3 .52s ease-out; }
@keyframes tc-flare1 {
  0%   { filter: brightness(2.4); transform: translate(-50%, -50%) scale(1.06); }
  100% { filter: brightness(1);   transform: translate(-50%, -50%) scale(1); }
}
@keyframes tc-flare2 {
  0%   { filter: brightness(2.8); transform: translate(-50%, -50%) scale(1.09); }
  100% { filter: brightness(1);   transform: translate(-50%, -50%) scale(1); }
}
@keyframes tc-flare3 {
  0%   { filter: brightness(3.4); transform: translate(-50%, -50%) scale(1.13); }
  100% { filter: brightness(1);   transform: translate(-50%, -50%) scale(1); }
}

/* ---- HUD reflow for thumbs ----------------------------------------------- */
html[data-touch] .kr-speed {
  right: 47vmin;
  transform: scale(.82);   /* transform-origin is already 100% 100% */
}

/* ---- LEFT IS READOUTS, RIGHT IS CONTROLS -----------------------------------
   The rule above anchors the speedometer to the action cluster rather than to
   an edge, and on a phone that is not a corner: 47vmin of a 390px-tall
   landscape screen is 183px, which on an 844px-wide panel puts the dial at
   about 70% across — floating in open space between the cluster and the middle
   of the frame, directly in the sightline down the road. Reported from play as
   "the speedometer is basically in the middle of the screen", and it is.

   Rather than nudge it, the bottom rail gets a rule: every glanceable readout
   lives on the LEFT, every control on the RIGHT. So the dial goes next to the
   item box on the left rail, the right half belongs entirely to the thumb, and
   the centre of the screen — the part you actually drive by looking at — is
   left empty.

   Only on a genuinely short viewport. A tablet in landscape has the height for
   the original layout and the corners are much further apart. */
@media (max-height: 520px) {
  /* RECONCILED with the controls round, which landed after this block.
     Two things about it are not cosmetic:

     1. Set the TOKEN, not 'transform'. ui.css now carries
        'html[data-touch] .kr .kr-speed { transform: scale(var(--speed-s)) }',
        which is (0,3,1); this rule was (0,2,1), so its 'scale(.74)' was dead
        on arrival and the dial silently stayed at .82. Writing --speed-s is
        also the only version that survives the mini-turbo tier pop, which
        animates 'transform' and beats any author rule — see the token's
        comment in ui.css.
     2. Write the corner per HAND. ui.css's left-handed rule is (0,4,1) and
        would win 'right' while this one kept 'left', leaving both set on an
        element that has a width — which resolves to 'left' in LTR and parks
        the dial under the mirrored cluster.

     The corner itself changed too: the item plate used to live bottom-left and
     this rule sat the dial flush beside it. The controls round moved that
     plate into the TOP rail (measured 100% occluded by the thumb once
     auto-drift holds DRIFT for the whole lap), so the bottom-left corner is
     free and the dial simply takes it. */
  html[data-touch] .kr .kr-speed {
    --speed-s: .74;
    left: 0;
    right: auto;
    transform-origin: 0 100%;
  }
  /* Left-handed mirrors the rail rule, not just the widget: the cluster is on
     the left, so the readouts go right. */
  html[data-touch][data-touch-hand="left"] .kr .kr-speed {
    left: auto;
    right: 0;
    transform-origin: 100% 100%;
  }
  /* The rail is clamp(84px, 14.5vmin, 208px), and at 390px of height 14.5vmin
     is 56px — so it pins to its 84px FLOOR and eats 22% of the screen height
     for two readouts. Same clamp-floor problem as the menus.
     (No backticks anywhere in this stylesheet: it is a template literal.) */
  html[data-touch] .kr { --rail: 68px; --rail-top: 46px; }

  /* The position plate is the largest single object left, and it sits at
     left-centre — across the road, at eye height. Its width is
     clamp(176px, 24vmin, 348px), and 24vmin here is 94px, so it pins to the
     176px floor: a fifth of the screen width for a placing and one rival's
     gap. Scaled rather than re-laid-out, because the plate is deliberately a
     FIXED width (see ui.css) so the delta changing between "+1.08" and
     "+12.48" cannot make it resize sixty times a second, and re-deriving that
     width per breakpoint would just be the same decision made twice.
     The existing translateY(-50%) has to survive: it is what centres it. */
  html[data-touch] .kr-pos {
    transform: translateY(-50%) scale(.68);
    transform-origin: 0 50%;
  }
  /* The plate itself moves to the right edge in left-handed mode (ui.css), so
     the origin it shrinks toward has to move with it or it scales away from
     its own anchored edge and leaves a growing gap. */
  html[data-touch][data-touch-hand="left"] .kr .kr-pos {
    transform-origin: 100% 50%;
  }
}
/* DEAD RULE REMOVED (round 10). This block repositioned '.kr-board', the
   eight-row standings tower that used to sit right-centre. Round 8 deleted
   that element, so this selector had matched nothing since. */

/* Portrait is unplayable at this HUD density; say so rather than shipping a
   squashed frame the player has to guess at. */
.tc-rotate { display: none; }
@media (orientation: portrait) {
  .tc-rotate {
    display: grid; place-items: center; position: absolute; inset: 0;
    background: rgba(5,8,16,.92); color: #f0f4fa; pointer-events: auto;
    text-align: center; font-size: 4.2vmin; line-height: 1.55; padding: 8vmin;
  }
  .tc-rotate b { font-size: 5.4vmin; letter-spacing: .04em; }
  .tc-stick-zone, .tc-cluster, .tc-top, .tc-pads, .tc-coach { display: none; }
}

/* ---- DEFECT D7: the pad must not shadow a menu ---------------------------
   .tc-root is z-index 20 over #ui's 10, and NOTHING used to hide it. Menus'
   tap-anywhere-confirm listener is on .kr — a subtree the event never enters,
   because .tc-root is a SIBLING on document.body — so roughly 29% of the
   bottom-right quadrant of every blocking screen silently swallowed "TAP TO
   START", and the rightmost roster card on the select screen sat under DRIFT.
   This is the same class as the pause menu that permanently ended your race.

   Hidden three ways deliberately. display:none is what tools/touch-test.mjs
   asserts and is what actually removes the boxes from hit testing;
   visibility and pointer-events on the root cover anything added to this
   layer later that forgets to join the list.
   (No backticks in this comment: the whole stylesheet is a template literal.) */
html[data-menu] .tc-root { visibility: hidden; pointer-events: none; }
html[data-menu] .tc-stick-zone,
html[data-menu] .tc-cluster,
html[data-menu] .tc-pads,
html[data-menu] .tc-coach,
html[data-menu] .tc-top { display: none; }

/* ...except while the controls screen is asking the player to TRY a scheme.
   The steering source only — never the action cluster, so a live preview
   cannot fire an item or open the pause menu by mis-tap. Two attribute
   selectors, so this wins over the single-attribute rules above. */
html[data-menu][data-touch-preview] .tc-root { visibility: visible; }
html[data-menu][data-touch-preview][data-touch-scheme="floating"] .tc-stick-zone,
html[data-menu][data-touch-preview][data-touch-scheme="fixed"] .tc-stick-zone { display: block; }
html[data-menu][data-touch-preview][data-touch-scheme="buttons"] .tc-pads { display: flex; }
`;
