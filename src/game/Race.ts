/**
 * ============================================================================
 *  RACE DIRECTOR
 * ============================================================================
 *  Owns the state machine, the grid, the countdown, lap and checkpoint
 *  validation, placement, respawns and the hand-off to the AI.
 *
 *  Two decisions are worth calling out because everything else hangs off them:
 *
 *  1. **Progress is validated, not measured.** A kart advances only by crossing
 *     checkpoints in order (`ITrack.checkpointAt`), and its `raceDistance` is
 *     built from `lap × length + checkpoint anchor + clamped distance into the
 *     current checkpoint`. Cutting the banked 180 across the sand therefore
 *     wins you nothing: the anchor does not move until the checkpoint you
 *     skipped is crossed. Raw distance-to-centreline would also mis-order karts
 *     wherever the circuit runs close to itself, which it does at the harbour.
 *
 *  2. **`lap` counts crossings of the line, and the grid starts behind it.**
 *     Internally laps run from -1 (formed up, not yet started) so that the
 *     first crossing begins lap 1 rather than completing it. `IKart.lap` is
 *     published as `max(0, lapIndex)`, which is what the HUD reads.
 * ============================================================================
 */
import * as THREE from 'three';
import { loadFirstKart, installFirstKart } from '../kart/ImportedKart';
import {
  BASE_TOP_SPEED,
  LAP_COUNT,
  RACER_COUNT,
  RaceState,
  Surface,
  type Ctx,
  type IKart,
  type IRace,
  type KartStats,
} from '../types';
import { Kart } from '../kart/Kart';
import { AIField, type DriveCmd } from './AI';
import { Items } from './Items';

const ROSTER: KartStats[] = [
  { name: '薇拉',   color: new THREE.Color(0xff3b5c), accelMul: 1.00, topSpeedMul: 1.00, weightMul: 1.0,  handlingMul: 1.00 },
  { name: '科亚',    color: new THREE.Color(0x2ea8ff), accelMul: 0.92, topSpeedMul: 1.08, weightMul: 1.2,  handlingMul: 0.92 },
  { name: '皮普',    color: new THREE.Color(0xffd23f), accelMul: 1.12, topSpeedMul: 0.93, weightMul: 0.82, handlingMul: 1.12 },
  { name: '荆棘',color: new THREE.Color(0x4ade5a), accelMul: 1.02, topSpeedMul: 0.99, weightMul: 0.95, handlingMul: 1.05 },
  { name: '黑曜',   color: new THREE.Color(0x8b5cf6), accelMul: 0.95, topSpeedMul: 1.05, weightMul: 1.1,  handlingMul: 0.96 },
  { name: '马洛', color: new THREE.Color(0xff8a3d), accelMul: 1.05, topSpeedMul: 0.97, weightMul: 0.9,  handlingMul: 1.08 },
  { name: '霜影',  color: new THREE.Color(0x7ee8fa), accelMul: 0.98, topSpeedMul: 1.02, weightMul: 1.0,  handlingMul: 1.00 },
  { name: '余烬', color: new THREE.Color(0xe8456b), accelMul: 1.08, topSpeedMul: 0.95, weightMul: 0.88, handlingMul: 1.10 },
];

// --- director tuning ---------------------------------------------------------
/**
 * Total time on the lights, seconds.
 *
 * The beats fire when `ceil(countdownT)` changes, so the ".4" is a lead-in: the
 * field is formed up and the camera has settled for 0.4 s before "3" lands, and
 * "3", "2", "1" then arrive on whole seconds with GO at 4.4. Without the
 * lead-in the first numeral is emitted on the very frame the grid pops into
 * existence and reads as a glitch rather than a start.
 */
const COUNTDOWN = 4.4;
/** seconds off-track before the marshals fish you out */
const OOB_LIMIT = 1.5;
/** seconds motionless before we assume you are wedged in something */
const STUCK_LIMIT = 4.5;
/** height the respawn crane drops you from */
const DROP_HEIGHT = 2.8;
/** throttle held for less than this at GO earns a rocket start */
const ROCKET_WINDOW = 0.62;
/** ...and holding it longer than this bogs the engine down */
const BURNOUT_WINDOW = 1.75;
/** seconds after the player finishes before the results settle */
const RESULTS_DELAY = 6;
/**
 * Clear tarmac left outside the widest grid column, metres.
 *
 * The grid is the one formation the camera studies at rest, so a slot that
 * hangs a wheel over the kerb is obvious in a way the same error is not at
 * 30 m/s. `ITrack.startGrid` derives its columns from the layout's nominal
 * width, which is not the same number as the drivable half-width at the slot's
 * own station — the start straight tapers into turn one — so the far column
 * can end up on the kerb or past it. Rather than trust the offsets, we re-solve
 * each slot against the width actually there and keep this much road outside
 * the outermost kart.
 */
const GRID_MARGIN = 2.6;
/** how far above the road surface a grid slot is placed, along the surface normal */
const GRID_LIFT = 0.7;

interface Progress {
  /** -1 = formed up behind the line, 0 = on lap 1 */
  lapIndex: number;
  /** last checkpoint crossed in order */
  cp: number;
  lapStart: number;
  best: number;
  finishOrder: number;
  finishTime: number;
  wrongT: number;
  badT: number;
  stuckT: number;
  /** no-throttle hold after a drop */
  respawnT: number;
  /** how long the throttle has been held during the countdown */
  hold: number;
  /** throttle/brake applied this frame, so "stuck" means stuck while trying */
  effort: number;
}

const _v = new THREE.Vector3();
const _drop = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Race implements IRace {
  /**
   * The state is an accessor, not a field, because entering `Countdown` is an
   * *event*, not a label: the grid has to form, the clock has to go back to
   * zero and the lights have to be lit. Anything that assigns the state
   * directly — the menus, a restart, a debug tool, the capture harness — used
   * to get the label without any of that, which produced a "countdown" with the
   * field scattered mid-lap, no numerals on screen and the race clock still
   * running from the previous session. Trapping the write is what makes the
   * state mean the same thing however it was reached.
   */
  private _state: RaceState = RaceState.Menu;

  get state(): RaceState {
    return this._state;
  }

  set state(v: RaceState) {
    if (v === this._state) return;
    const leaving = this._state;
    this._state = v;
    // Abandoning a countdown expires its clock. Without this, jumping straight
    // to `Racing` part-way through one leaves the timer stranded at, say, 2.1 s
    // remaining, and the *next* entry into `Countdown` sees a clock that is
    // still running and declines to arm — one skipped start silently disables
    // every start after it. Pausing is the one exit that keeps its place.
    if (leaving === RaceState.Countdown && v !== RaceState.Paused) this.countdownT = 0;
    // Conversely, `countdownT > 0` here means the clock is genuinely mid-count,
    // which is how the pause menu hands the countdown back — resuming must not
    // restart it.
    if (v === RaceState.Countdown && this.countdownT <= 0) this.armCountdown();
  }

  karts: Kart[] = [];
  player!: Kart;
  totalLaps = LAP_COUNT;
  raceTime = 0;
  countdown = 3;
  lapTimes: number[] = [];
  standings: IKart[] = [];

  /** player's best lap this race, seconds — Infinity until one is set */
  bestLap = Infinity;
  /** true while the player is pointing the wrong way at speed */
  wrongWay = false;

  /**
   * Debug / capture hook: hand the player's kart to the AI. The screenshot
   * harness has no keyboard, so without this the player is a statue while the
   * field drives away and every shot frames a stationary kart being lapped.
   * Everything else about the kart (`isPlayer`, camera target, HUD, audio
   * mix, player-only VFX) is unchanged.
   */
  autoDrive = false;

  /**
   * Debug / capture hook: rewrite the player's drive command after the AI (or
   * the human) has produced it, every frame.
   *
   * The screenshot harness needs this for anything the kart *holds* rather than
   * *has*. Drifting is the case that forced it: writing `kart.driftDir` from
   * outside looks like it works for one frame and then silently undoes itself,
   * because `updateDriftState` releases any slide whose drift button is no
   * longer held — and releasing a charged slide fires the mini-turbo, so the
   * frame ends up showing a boost flame and no slide at all. Holding the button
   * through the command is the only way to hold a real drift.
   *
   * Null in normal play; nothing calls it unless a tool sets it.
   */
  driveOverride: ((cmd: DriveCmd) => void) | null = null;

  /** scratch command handed to `driveOverride`, so the hook allocates nothing */
  private readonly overrideCmd: DriveCmd = {
    steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, itemBackwards: false,
  };

  private ctx!: Ctx;
  private ai = new AIField();
  private items: Items | null = null;
  private prog: Progress[] = [];
  /** Starts expired so the first entry into `Countdown` always arms it. */
  private countdownT = 0;
  private finishedCount = 0;
  private resultsT = 0;
  private pauseEdge = false;
  /** the state to return to when the pause menu is dismissed */
  private prePause: RaceState = RaceState.Racing;
  private pauseThrottleClear = false;
  /** index into `karts` the human drives; see `selectKart` */
  private selected = 0;
  private firstKartAppearance?: (active: boolean) => void;

  // ---------------------------------------------------------------- lifecycle

  async init(ctx: Ctx) {
    this.ctx = ctx;
    const firstModel = await loadFirstKart();
    const n = Math.min(RACER_COUNT, ROSTER.length);
    for (let i = 0; i < n; i++) {
      const k = new Kart(i, i === 0, ROSTER[i]);
      ctx.scene.add(k.object);
      this.karts.push(k);
      this.prog.push({
        lapIndex: -1, cp: 0, lapStart: 0, best: Infinity, finishOrder: 0, finishTime: 0,
        wrongT: 0, badT: 0, stuckT: 0, respawnT: 0, hold: 0, effort: 0,
      });
      this.standings.push(k);
    }
    this.player = this.karts[0];
    this.selected = 0;
    this.firstKartAppearance = installFirstKart(this.player, firstModel);
    this.firstKartAppearance(true);

    // The line is solved once, here, and shared: the drivers steer along it and
    // red shells chase along it, so a shell tracks exactly where its victim is
    // trying to go.
    this.ai.init(ctx, this.karts);
    if (ctx.items instanceof Items) {
      this.items = ctx.items;
      this.items.setRacingLine(this.ai.line);
      this.ai.setHazards(this.items.hazards);
    }

    this.formGrid();
  }

  start() {
    // Bypass the setter and arm unconditionally: `start()` is an explicit
    // "line them up again", even from inside a countdown that is already
    // running.
    this._state = RaceState.Countdown;
    this.armCountdown();
  }

  /**
   * Put the field on the grid, park the race clock at zero and light the first
   * beat. Every route into `RaceState.Countdown` lands here, which is what
   * makes the start line look the same whether it was reached from the menu, a
   * restart or a tool poking the state from outside.
   */
  private armCountdown() {
    this.countdownT = COUNTDOWN;
    this.countdown = 3;
    this.raceTime = 0;
    this.resultsT = 0;
    this.wrongWay = false;
    this.finishedCount = 0;
    this.lapTimes.length = 0;
    this.bestLap = Infinity;
    // `init` arms us before the first frame, so there may be no context yet.
    if (this.ctx) {
      this.ai.reset();
      // Live shells and dropped bananas belong to the race that just ended;
      // leaving them on the road would arm the new one with the old one's
      // litter sitting on the start line.
      this.items?.reset();
      this.formGrid();
      this.ctx.speedIntensity = 0;
      this.ctx.fovPunch = 0;
    }
  }

  /** Restart from the grid. Identical to a fresh `start` — see `armCountdown`. */
  reset() {
    this.start();
  }

  get selectedKart(): number {
    return this.selected;
  }

  /**
   * Move the player onto a different kart. See `IRace.selectKart`.
   *
   * Karts are constructed once in `init` — `buildKart(stats)` bakes the model,
   * livery and driver — so this cannot swap `stats` and cannot rebuild without
   * leaking the old GPU buffers. It moves the `isPlayer` flag instead, and
   * pairs it with a grid-slot swap so the chosen racer still lines up on pole
   * rather than starting from wherever its roster index happens to sit.
   *
   * Nothing is reordered: `karts`, `prog` and `standings` stay index-aligned,
   * and every `id` keeps its value so the AI's maps and in-flight projectiles
   * survive a change made on the select screen between races.
   */
  selectKart(index: number) {
    const n = this.karts.length;
    if (n === 0) return;
    const want = Math.min(Math.max(Math.floor(index), 0), n - 1);
    if (want === this.selected) return;
    this.karts[this.selected].isPlayer = false;
    this.karts[want].isPlayer = true;
    this.selected = want;
    this.player = this.karts[want];
    this.firstKartAppearance?.(want === 0);
  }

  /**
   * Grid slot for kart `i`. Identity except that the player's kart and whoever
   * owns pole trade places, so the human always starts at the front.
   */
  private slotFor(i: number): number {
    if (this.selected === 0) return i;
    if (i === this.selected) return 0;
    if (i === 0) return this.selected;
    return i;
  }

  /** Stagger everyone back onto the grid and wipe their race record. */
  private formGrid() {
    const track = this.ctx.track;
    const N = track.checkpointCount;
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const gi = this.slotFor(i);
      const slot = track.startGrid[gi] ?? track.startGrid[track.startGrid.length - 1];

      // Take the *station* and the *side* from the slot and re-solve the rest
      // here. Both returns are pooled, so the two numbers we need are read out
      // before anything else can be asked of the track.
      const probe = track.probe(slot.pos, -1);
      const t = probe.t;
      const lateral = probe.lateral;

      // Rebuilt on the banked plane at this station rather than in world Y, so
      // the formation stays square to the road wherever the line happens to sit
      // and the outer column cannot be pushed off the tarmac by a taper. Yaw
      // comes from the tangent too: a kart that is a couple of degrees out reads
      // as abandoned rather than staged, and it was.
      const s = track.sample(t);
      const maxLat = Math.max(1.5, s.halfWidth - GRID_MARGIN);
      const lat = clamp(lateral, -maxLat, maxLat);
      _v.copy(s.pos)
        .addScaledVector(s.binormal, lat)
        .addScaledVector(s.normal, GRID_LIFT);

      k.placeAt(_v, Math.atan2(s.tangent.x, s.tangent.z), t);
      k.lap = 0;
      k.finished = false;
      k.place = i + 1;
      k.raceDistance = 0;

      const p = this.prog[i];
      p.lapIndex = -1;
      // The grid sits behind the line, so everyone starts owning the LAST
      // checkpoint — crossing the line then validates checkpoint 0 in order.
      p.cp = track.checkpointAt(t);
      if (p.cp === 0) p.cp = N - 1;
      p.lapStart = 0;
      p.best = Infinity;
      p.finishOrder = 0;
      p.finishTime = 0;
      p.wrongT = p.badT = p.stuckT = p.respawnT = p.hold = p.effort = 0;
      this.standings[i] = k;
    }
    this.updateProgress();
  }

  /**
   * Pause / resume on behalf of the UI.
   *
   * `RaceState.Paused` lives here, but the pause *screen* lives in `Menus`, and
   * its Resume button used to do nothing but clear the UI's own local copy of
   * the flag. With the director actually modelling the pause — which it does on
   * every real race — the state stayed `Paused` and the only ways out were the
   * Escape key or the throttle escape hatch below. Clicking Resume, or
   * confirming it on a gamepad or a phone (where there is no Escape key at
   * all), left the race suspended for good.
   */
  setPaused(paused: boolean) {
    if (paused) {
      if (this.state === RaceState.Racing || this.state === RaceState.Countdown) {
        this.prePause = this.state;
        this.state = RaceState.Paused;
        this.ctx?.bus.emit({ type: 'ui', name: 'pause' });
      }
    } else if (this.state === RaceState.Paused) {
      // Same handover the key path uses: `prePause` restores a mid-count
      // countdown without rearming it (see the `state` setter).
      this.state = this.prePause;
      // The throttle hatch re-arms from scratch, so resuming with a finger
      // already on the accelerator cannot instantly re-trigger anything.
      this.pauseThrottleClear = false;
      this.ctx?.bus.emit({ type: 'ui', name: 'resume' });
    }
  }

  // -------------------------------------------------------------------- frame

  update(ctx: Ctx, dt: number) {
    this.ctx = ctx;
    const input = ctx.input.state;

    // --- pause --------------------------------------------------------------
    // The pause menu is owned by the UI, which toggles its own copy off the
    // same button edge; both sides therefore agree on every press.
    const pausePressed = input.pausePressed && !this.pauseEdge;
    this.pauseEdge = input.pausePressed;
    if (pausePressed) {
      if (this.state === RaceState.Racing || this.state === RaceState.Countdown) {
        this.prePause = this.state;
        this.state = RaceState.Paused;
        ctx.bus.emit({ type: 'ui', name: 'pause' });
      } else if (this.state === RaceState.Paused) {
        this.state = this.prePause;
        ctx.bus.emit({ type: 'ui', name: 'resume' });
      }
    }
    if (this.state === RaceState.Paused) {
      // Secondary escape hatch, kept alongside `setPaused` for the case where
      // the player reaches for the throttle rather than the menu. Only once it
      // has been released, or pausing mid-corner would un-pause on the very
      // next frame.
      if (input.accel < 0.2) this.pauseThrottleClear = true;
      else if (this.pauseThrottleClear) {
        this.state = this.prePause;
        ctx.bus.emit({ type: 'ui', name: 'resume' });
      }
      return;
    }
    this.pauseThrottleClear = false;

    // --- clocks -------------------------------------------------------------
    if (this.state === RaceState.Countdown) {
      this.tickCountdown(ctx, dt);
    } else if (this.state === RaceState.Racing || this.state === RaceState.Finished) {
      this.raceTime += dt;
    } else if (this.state === RaceState.Results && this.finishedCount < this.karts.length) {
      // The clock belongs to the RACE, not to the screen in front of it. The
      // results board appears `RESULTS_DELAY` after the *player* crosses, and
      // the field behind them is usually still running — on a three-lap race,
      // for up to half a minute. Parking the clock at that transition stamped
      // every one of those stragglers with the identical finishing time, three
      // and four abreast, because the only thing anybody reads a finish time
      // off is `raceTime` at the moment the `finish` event fires. It also gave
      // them ~0.00 s lap splits. So it keeps running until the last kart is
      // home, and then stops for good.
      this.raceTime += dt;
    }
    if (this.state === RaceState.Finished) {
      this.resultsT += dt;
      if (this.resultsT > RESULTS_DELAY || this.finishedCount >= this.karts.length) {
        this.state = RaceState.Results;
      }
    }

    const live = this.state === RaceState.Racing;
    const rolling = live || this.state === RaceState.Finished || this.state === RaceState.Results;

    // --- drive --------------------------------------------------------------
    this.ai.beginFrame(this.karts, this.player, live ? dt : 0);

    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const p = this.prog[i];
      let steer = 0, throttle = 0, brake = 0, drift = false;

      if (p.respawnT > 0) {
        // dropped in: hands off until the suspension has taken the landing
        p.respawnT -= dt;
      } else if (rolling) {
        // The player is handed back to the AI once their race is run, so the
        // results screen has a moving circuit behind it rather than a statue.
        if (k.isPlayer && !this.autoDrive && !k.finished && this.state !== RaceState.Results) {
          steer = input.steer;
          throttle = input.accel;
          brake = input.brake;
          drift = input.drift;
          if (input.itemPressed) {
            ctx.items.use(k, input.brake > 0.5 || input.lookBack);
          }
        } else {
          const cmd = this.ai.drive(ctx, k, dt, this.karts, true);
          // The AI solves in the chassis' yaw frame (positive = rising yaw =
          // a turn to the left), while `Kart.step` takes the same input
          // contract the player uses (positive = screen-right). Convert here,
          // at the one point an AI command becomes a drive input, so the
          // driver model can keep reasoning in the space its geometry is in.
          steer = -cmd.steer;
          throttle = cmd.throttle;
          brake = cmd.brake;
          drift = cmd.drift;
          if (cmd.useItem) ctx.items.use(k, cmd.itemBackwards);
        }
      } else if (this.state === RaceState.Countdown) {
        // hold station, but watch the throttle for a rocket start
        if (k.isPlayer) {
          // `accelAuto` is the whole point of this condition. The rocket start
          // reads a held throttle as a DECISION — hold briefly and you launch,
          // hold too long and `armCountdown` burns you out with a spinOut. On
          // touch, auto-accelerate is on by default and holds the throttle from
          // the first frame of the countdown, so `hold` reached the full ~3 s,
          // sailed past BURNOUT_WINDOW (1.75 s), and EVERY race on a phone
          // opened with a guaranteed spin. With no steering input the spin
          // direction is constant, so the kart came out of it pointing backwards
          // and auto-accelerate obligingly drove it up the circuit the wrong
          // way — which is exactly what it looked like from the sofa.
          if (input.accel > 0.5 && !input.accelAuto) p.hold += dt;
          else p.hold = 0;
        }
        this.ai.drive(ctx, k, dt, this.karts, false);
        this.holdOnGrid(k);
      }

      if (k.isPlayer && this.driveOverride) {
        const o = this.overrideCmd;
        o.steer = steer; o.throttle = throttle; o.brake = brake; o.drift = drift;
        o.useItem = false; o.itemBackwards = false;
        this.driveOverride(o);
        steer = o.steer; throttle = o.throttle; brake = o.brake; drift = o.drift;
        if (o.useItem) ctx.items.use(k, o.itemBackwards);
      }

      p.effort = Math.max(throttle, brake);

      // Rubber band, applied as a slipstream-scale acceleration rather than as
      // a boost — it must never light up the exhausts or read as a cheat.
      if (live && !k.isPlayer && !k.finished && k.stunTime <= 0 && !k.airborne) {
        const a = this.ai.assistFor(k);
        if (a !== 0 && k.forwardSpeed > 4) {
          _v.copy(k.forward).multiplyScalar(a * dt);
          k.launch(_v);
        }
      }

      k.step(ctx, dt, steer, throttle, brake, drift);
    }

    // --- bookkeeping --------------------------------------------------------
    this.updateProgress();
    if (rolling) this.watchdogs(ctx, dt);
    this.updateWrongWay(ctx, dt, live);
    this.updateCamera(ctx, dt);
  }

  // ---------------------------------------------------------------- countdown

  private tickCountdown(ctx: Ctx, dt: number) {
    const prev = Math.ceil(this.countdownT);
    this.countdownT -= dt;
    const now = Math.ceil(this.countdownT);
    // The lead-in beat is not published: the HUD ignores anything above 3, but
    // the audio mix would play a fourth blip of a three-blip metronome, with no
    // numeral on screen to explain it.
    if (now !== prev && now >= 0 && now <= 3) {
      ctx.bus.emit({ type: 'countdown', n: now });
      // The field blips its throttle on every light, not just the last one.
      //
      // `hop` is the ground-puff channel the effects layer already owns, and a
      // puff at each kart's contact patch is the one bit of pre-start energy
      // this system can raise without reaching into anyone else's. Firing it
      // only on "1" meant the grid sat dead through "3" and "2" — three quarters
      // of the countdown, and the exact window the establishing shot is taken
      // in. Three staggered rev blips read as eight running engines waiting for
      // the lights; one puff at the end reads as a car park.
      if (now >= 1) this.revBlip(ctx);
    }
    // Published clamped: the lead-in beat is an implementation detail, and a
    // readout of "5" on the lights would be nonsense.
    this.countdown = clamp(now, 0, 3);
    if (this.countdownT > 0) return;

    this.countdownT = 0;
    this.state = RaceState.Racing;
    this.raceTime = 0;
    // Every kart breaks traction leaving the line, whatever it did with the
    // throttle, so the whole field launches inside a wall of its own dust
    // rather than pulling away off clean tarmac. Twice, a frame apart in
    // intent: the GO burst is the loudest thing the grid does.
    this.revBlip(ctx);
    this.revBlip(ctx);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const p = this.prog[i];
      p.lapStart = 0;
      const hold = k.isPlayer ? p.hold : this.aiRocketHold(k);
      if (hold > 0.02 && hold < ROCKET_WINDOW) {
        // perfect launch
        k.applyBoost(1.35, 1.26);
        ctx.bus.emit({ type: 'boost', kart: k, tier: 2 });
      } else if (hold > BURNOUT_WINDOW) {
        // over-revved on the line and bogged down
        k.spinOut(0.75);
        ctx.bus.emit({ type: 'ui', name: 'burnout' });
      }
      p.hold = 0;
    }
  }

  /**
   * A puff at every visible kart's contact patch — a throttle blip on the grid.
   *
   * Gated to the karts near the player so a grid of eight does not fire eight
   * of everything at a camera that can see three of them, and the player is
   * always included because the chase camera is always looking at them.
   */
  private revBlip(ctx: Ctx) {
    const p = this.player.position;
    for (const k of this.karts) {
      if (k !== this.player && k.position.distanceToSquared(p) > 42 * 42) continue;
      ctx.bus.emit({ type: 'hop', kart: k });
    }
  }

  /**
   * Footbrake on the grid.
   *
   * `formGrid` puts the field into a staggered two-column formation and then
   * nothing holds it there for the four and a half seconds of the lights. The
   * countdown branch passes throttle 0 / brake 0 because the brake pedal cannot
   * help here — at rest with no throttle it is the reverse gear, so pressing it
   * would walk the whole grid backwards off its slots. Meanwhile the road under
   * the start line is not a plane (the bible forbids 120 m of flat anywhere), so
   * gravity gives every kart a slow creep down the camber.
   *
   * Left alone that creep is small per frame and enormous over a countdown: the
   * stagger smears, karts converge on each other's slots, and one of them can
   * roll over the line and burn its start crossing before GO. So the horizontal
   * velocity is zeroed every frame, which is what a driver with a foot on the
   * brake and one on the clutch actually achieves. The vertical component is
   * left alone — the karts are placed slightly above the road on purpose and
   * must still drop onto their springs.
   */
  private holdOnGrid(k: Kart) {
    const vx = k.velocity.x;
    const vz = k.velocity.z;
    if (vx * vx + vz * vz < 1e-6) return;
    _v.set(-vx, 0, -vz);
    k.launch(_v);
  }

  /** How long an AI "held" the throttle before GO — skill decides the timing. */
  private aiRocketHold(k: IKart): number {
    const skill = this.ai.driver(k).skill;
    const r = Math.random();
    if (r < 0.18 + skill * 0.5) return 0.05 + Math.random() * 0.4;   // nailed it
    if (r > 0.94) return BURNOUT_WINDOW + 0.4;                       // fluffed it
    return 0;
  }

  // ----------------------------------------------------------------- progress

  /**
   * Checkpoint validation, lap counting and the placement sort. Runs for every
   * kart every frame; the whole thing is integer arithmetic on a 32-entry ring.
   */
  private updateProgress() {
    const track = this.ctx.track;
    const L = track.length;
    const N = track.checkpointCount;
    const cpLen = L / N;

    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const p = this.prog[i];
      const c = track.checkpointAt(k.t);
      const fwd = (c - p.cp + N) % N;

      if (fwd === 1) {
        p.cp = c;
        if (c === 0) this.crossLine(k, p);
      } else if (fwd === N - 1) {
        // Reversing back over a boundary un-validates it, so a kart that spins
        // and rolls backwards over the line does not gain a phantom lap when it
        // comes round again.
        p.cp = c;
        if (c === N - 1) p.lapIndex = Math.max(-1, p.lapIndex - 1);
      }
      // any other jump is a cut: the anchor simply refuses to move

      const anchor = p.cp * cpLen;
      let rel = k.t * L - anchor;
      rel -= Math.floor(rel / L + 0.5) * L;
      // Never credit more than a checkpoint and a half of unvalidated running,
      // which is what makes a shortcut worthless without a hard-coded penalty.
      rel = clamp(rel, 0, cpLen * 1.6);
      k.raceDistance = p.lapIndex * L + anchor + rel;
      // Clamped at the top as well as the bottom. `lapIndex` keeps counting
      // after the flag — the field circulates behind the results screen and
      // `raceDistance` has to stay monotonic for the gap readout — but the
      // published lap is what the HUD, the minimap and the rival board print,
      // and "4/3" is nonsense on any of them.
      k.lap = clamp(p.lapIndex, 0, this.totalLaps);
    }

    // --- placement ----------------------------------------------------------
    const prog = this.prog;
    this.standings.sort((a, b) => {
      const pa = prog[a.id];
      const pb = prog[b.id];
      if (pa.finishOrder || pb.finishOrder) {
        if (!pb.finishOrder) return -1;
        if (!pa.finishOrder) return 1;
        return pa.finishOrder - pb.finishOrder;
      }
      return b.raceDistance - a.raceDistance;
    });
    for (let i = 0; i < this.standings.length; i++) this.standings[i].place = i + 1;
  }

  private crossLine(k: Kart, p: Progress) {
    const ctx = this.ctx;
    p.lapIndex++;
    if (p.lapIndex <= 0) return;    // that was the start, not a completed lap

    // A kart whose race is run keeps circulating — the results screen wants a
    // moving circuit behind it, not a car park — but those tours are laps of
    // honour, not laps of the race. Counting them pushed a fourth entry into
    // `lapTimes`, and since the clock is parked once the state reaches
    // `Results` the entry was ~0.00 s, which the HUD immediately promoted to
    // "best lap" while a "Lap 4" split flashed over the standings.
    if (k.finished) return;

    const t = this.raceTime - p.lapStart;
    p.lapStart = this.raceTime;
    if (t < p.best) p.best = t;
    if (k.isPlayer) {
      this.lapTimes.push(t);
      if (t < this.bestLap) this.bestLap = t;
    }
    ctx.bus.emit({ type: 'lap', kart: k, lap: p.lapIndex });

    if (p.lapIndex >= this.totalLaps && !k.finished) {
      k.finished = true;
      p.finishOrder = ++this.finishedCount;
      p.finishTime = this.raceTime;
      // The order karts cross the line IS the result; publish it before the
      // event so anything listening reads the final placing, not last frame's.
      k.place = p.finishOrder;
      ctx.bus.emit({ type: 'finish', kart: k, place: p.finishOrder });
      if (k.isPlayer && this.state === RaceState.Racing) {
        this.state = RaceState.Finished;
        this.resultsT = 0;
      }
    }
  }

  // ---------------------------------------------------------------- watchdogs

  private watchdogs(ctx: Ctx, dt: number) {
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const p = this.prog[i];
      if (p.respawnT > 0) continue;

      const bad = k.surface === Surface.Water || k.surface === Surface.OffTrack;
      p.badT = bad ? p.badT + dt : 0;

      // "Stuck" means *trying* to move and failing — wedged in a barrier or
      // beached on a kerb. Someone sitting still with their hands off the
      // controls is not stuck, and craning them back onto the road every few
      // seconds because they stopped to look at the view is obnoxious.
      const crawling = p.effort > 0.15 && Math.abs(k.forwardSpeed) < 0.7 && k.stunTime <= 0;
      p.stuckT = crawling ? p.stuckT + dt : 0;

      if (p.badT > OOB_LIMIT || p.stuckT > STUCK_LIMIT) this.respawn(ctx, k, p);
    }
  }

  /**
   * Lift and drop. The kart is craned back to the racing line at the furthest
   * point it has legitimately reached, faced down the road, and released — the
   * fall is real, so it lands on its springs with a thump and a puff of dust
   * rather than teleporting into place.
   */
  private respawn(ctx: Ctx, k: Kart, p: Progress) {
    const track = ctx.track;
    const line = this.ai.line;
    const L = track.length;
    const cpLen = L / track.checkpointCount;
    const anchor = p.cp * cpLen;
    let rel = k.t * L - anchor;
    rel -= Math.floor(rel / L + 0.5) * L;
    const d = anchor + clamp(rel, 0, cpLen);

    line.point(d, _drop);
    const probe = track.probe(_drop, d / L);
    _drop.y = probe.y + DROP_HEIGHT;

    const yaw = line.yaw[line.index(d)];
    k.placeAt(_drop, yaw, ((d / L) % 1 + 1) % 1);
    k.invulnTime = 1.9;
    p.badT = 0;
    p.stuckT = 0;
    p.respawnT = 0.55;
    ctx.bus.emit({ type: 'ui', name: k.isPlayer ? 'respawn' : 'respawn-rival' });
  }

  // --------------------------------------------------------------- wrong way

  private updateWrongWay(ctx: Ctx, dt: number, live: boolean) {
    const p = this.prog[this.player.id];
    const line = this.ai.line;
    const yaw = line.yaw[line.index(this.player.t * line.length)];
    _v.set(Math.sin(yaw), 0, Math.cos(yaw));
    const along = _v.dot(this.player.forward);

    const backwards = live && along < -0.28 && Math.abs(this.player.forwardSpeed) > 3.5;
    p.wrongT = backwards ? p.wrongT + dt : Math.max(0, p.wrongT - dt * 2.5);

    const now = p.wrongT > 0.55;
    if (now !== this.wrongWay) {
      this.wrongWay = now;
      ctx.bus.emit({ type: 'ui', name: now ? 'wrong-way' : 'wrong-way-clear' });
    }
  }

  // ------------------------------------------------------------- camera feeds

  private updateCamera(ctx: Ctx, dt: number) {
    const k = this.player;
    const top = BASE_TOP_SPEED * (k.stats.topSpeedMul || 1);
    // Speed intensity is deliberately not linear in speed: nothing should be
    // happening at half pace, and everything should be happening on a boost.
    const raw = clamp(Math.abs(k.forwardSpeed) / top, 0, 1.2);
    let want = Math.pow(clamp((raw - 0.34) / 0.72, 0, 1), 1.35);
    if (k.boostTime > 0) want = Math.min(1.4, want + 0.35);
    if (k.starTime > 0) want = Math.min(1.4, want + 0.12);
    if (this.state === RaceState.Countdown) want = 0;
    ctx.speedIntensity += (want - ctx.speedIntensity) * Math.min(1, dt * 5);

    let fov = 0;
    if (k.boostTime > 0) fov = 9;
    else if (k.driftTier > 0) fov = 1.2 * k.driftTier;
    if (k.stunTime > 0) fov = -3;
    // punch in fast, ease out slowly — the asymmetry is what sells the kick
    const rate = fov > ctx.fovPunch ? 11 : 4.5;
    ctx.fovPunch += (fov - ctx.fovPunch) * Math.min(1, dt * rate);
  }

  dispose() {
    for (const k of this.karts) k.object.parent?.remove(k.object);
  }
}
