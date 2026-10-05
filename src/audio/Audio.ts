/**
 * ============================================================================
 *  Audio.ts — the game's ears.
 * ============================================================================
 *  Effects are synthesized; the original score is pre-rendered into loops
 *  so racing cannot starve its note scheduling. The hierarchy is:
 *
 *    Audio       — System entry point, unlock handling, event routing, mixing
 *    KartVoice   — one continuous engine + tyre voice per kart, 3D positioned
 *    DriftCharge — the mini-turbo tension tone, player only
 *    Ambience    — player-only rolling surface, wind and speed layers
 *    Music       — continuous pre-rendered original score (Music.ts)
 *
 *  The drift → mini-turbo → boost loop is the game, so it is also the spine of
 *  this file. Three continuous signals carry it and they are deliberately in
 *  three different registers so they never mask one another:
 *
 *    tyre squeal   400–2400 Hz, broadband — how hard the tyres are working
 *    charge tone   175–1110 Hz, tonal, on its own presence-lifted bus — which
 *                  tier you are on, legible with your eyes on the road
 *    engine        30–900 Hz fundamental — speed, load and boost
 *
 *  Browsers refuse to start an AudioContext without a gesture, and the
 *  screenshot harness never gives one. So: no context is created until the
 *  first pointer/key event, `update()` is a single early-out until then, and
 *  every construction path is wrapped — if audio can never start, the game runs
 *  silently and nothing throws.
 * ============================================================================
 */
import * as THREE from 'three';
import {
  BASE_TOP_SPEED,
  ItemKind,
  RaceState,
  Surface,
  type Ctx,
  type GameEvent,
  type IKart,
  type System,
} from '../types';
import { EPS, mtof, Synth } from './Synth';
import { Music } from './Music';
import { AudioRecovery } from './AudioRecovery';
import { SoundCheck } from './SoundCheck';

// --- module scope scratch: nothing in update() allocates ---------------------
const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _vel = new THREE.Vector3();

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Six-speed box. Engine frequency is firing rate, so this is the whole feel. */
const GEARS = 6;
const GEAR_SPAN = 1 / GEARS;
/** firing frequency in Hz at idle and the span up to the limiter */
const F_IDLE = 28;
const F_SPAN = 282;
/** beyond this many metres a rival's one-shots are not worth a voice slot */
const SFX_CULL_DIST = 150;

// --- the mini-turbo charge ---------------------------------------------------

/**
 * Fundamental in Hz at the bottom and the top of each tier's charge ramp,
 * indexed by tier 0..3. The bands deliberately do not overlap — the top of one
 * tier is still a whole tone below the bottom of the next — so a charge that
 * runs all the way to purple reads as one continuous climb with three audible
 * landings on the way, and a tone sampled at any instant identifies its tier
 * without reference to anything before it.
 *
 *   tier 0  F3–C4     "the slide is loading"    (quiet, almost subliminal)
 *   tier 1  G4–C5     blue
 *   tier 2  D5–G5     orange
 *   tier 3  A5–C#6    purple, and it stops rising because it is maxed
 */
const CHARGE_LO = [174.6, 392.0, 587.3, 880.0];
const CHARGE_HI = [261.6, 523.3, 784.0, 1108.7];
/**
 * Bus level per tier — the second, independent cue that the tier went up.
 *
 * These are not a smooth curve because the voice does not have a constant gain
 * structure: tier 2 brings in the fifth and the sizzle band and tier 3 the
 * octave, so equal bus gains measured as +10 dB and +9 dB steps. These are set
 * from the *rendered* result instead, and land at -30.6 / -20.8 / -17.3 /
 * -14.6 dBFS — tier 1 loud enough to be heard over a full-throttle engine,
 * which the first pass was not, and 2.7–3.5 dB per step above that.
 */
const CHARGE_LEVEL = [0.12, 0.61, 0.56, 0.6];
/**
 * How far the engine and the music step back while a tier is held, as a linear
 * gain reduction. Music gets 1.25x this. See the sidechain block in update().
 */
const CHARGE_SIDECHAIN = [0.06, 0.26, 0.32, 0.4];
/** how much of the fifth and the octave each tier adds — the third cue, timbre */
const CHARGE_FIFTH = [0, 0.06, 0.34, 0.5];
const CHARGE_OCTAVE = [0, 0, 0.1, 0.42];
/** tremolo depth — only purple shudders, which is what makes it read as "full" */
const CHARGE_TREM = [0, 0, 0.08, 0.4];

/**
 * Tyre character per surface: [tonal weight, formant centre multiplier,
 * broadband weight]. Tarmac squeals; sand hisses an octave and a half up with
 * no tone in it at all; grass and dirt scrub low and broad. Getting this from
 * the surface rather than from one binary grip term is what makes running wide
 * onto the sand audible before it is visible on the speedo.
 */
const SQUEAL_SURFACE: Record<Surface, readonly [number, number, number]> = {
  [Surface.Road]: [1.0, 1.0, 0.8],
  [Surface.Boost]: [1.0, 1.05, 0.8],
  [Surface.Dirt]: [0.1, 0.62, 1.15],
  [Surface.Grass]: [0.05, 0.5, 1.1],
  [Surface.Sand]: [0.02, 1.9, 0.95],
  [Surface.OffTrack]: [0.08, 0.7, 1.15],
  [Surface.Water]: [0.03, 1.45, 1.0],
};

// ---------------------------------------------------------------------------
// KartVoice — the single most important sound in the game
// ---------------------------------------------------------------------------

/**
 * A continuous engine: detuned saws over a square sub, pushed through a tanh
 * stage whose drive tracks throttle, then a lowpass that tracks revs. Around it
 * sit filtered induction noise (breathes with load) and a crackle bed gated by
 * an overrun term, which is what gives the off-throttle burble.
 *
 * The player's voice is `rich` (six oscillators, full noise rig, dry and
 * centred). Rivals get a leaner three-oscillator version through an HRTF
 * panner, so a kart closing from behind is audible before it is visible.
 */
class KartVoice {
  /** where one-shots belonging to this kart should be sent */
  readonly sfxIn: AudioNode;

  private readonly enginePanner: PannerNode | null;
  private readonly sfxPanner: PannerNode | null;

  rpm = 0.12;
  gear = 0;
  load = 0;
  prevSpeed = 0;

  private shiftCut = 0;
  private out: GainNode;
  private drive: GainNode;
  private lp: BiquadFilterNode;
  private oscs: OscillatorNode[] = [];
  private mults: number[] = [];
  private harm: GainNode[] = [];
  private intakeF: BiquadFilterNode;
  private intakeG: GainNode;
  private burbleG: GainNode;
  private popG: GainNode;
  private turboF: BiquadFilterNode | null;
  private turboG: GainNode | null;
  private squealG: GainNode;
  private squealF1: BiquadFilterNode;
  private squealF2: BiquadFilterNode | null;
  private squealTone: OscillatorNode | null;
  private squealToneG: GainNode | null;
  private sources: AudioScheduledSourceNode[] = [];
  private readonly s: Synth;
  private readonly rich: boolean;
  private live = true;
  private muted = false;
  private beta = 0;
  private boostS = 0;

  constructor(s: Synth, rich: boolean, seed: number) {
    this.s = s;
    this.rich = rich;
    const now = s.now;

    if (rich) {
      this.enginePanner = null;
      this.sfxPanner = null;
      this.sfxIn = s.sfx;
    } else {
      // Stereo positioning for rival engines and their one-shots.
      // Keep stereo position without a convolution per competing engine.
      this.enginePanner = s.panner('equalpower');
      this.sfxPanner = s.panner('equalpower');
      this.enginePanner.connect(s.engine);
      this.sfxPanner.connect(s.sfx);
      this.sfxIn = this.sfxPanner;
    }
    const engineDest: AudioNode = this.enginePanner ?? s.engine;

    this.out = s.gain(EPS);
    this.out.connect(engineDest);

    // Exhaust body: fixed formants that stop the saw stack sounding like a
    // synth patch and start it sounding like a pipe.
    const megaphone = s.biquad('peaking', 1150, 1.1, 5);
    const rumble = s.biquad('peaking', 190, 1.3, 4);
    const dc = s.biquad('highpass', 42, 0.7);
    this.lp = s.biquad('lowpass', 1400, 1.1);
    const shape = s.shaper(3.2);
    this.drive = s.gain(0.3);
    this.drive.connect(shape);
    shape.connect(this.lp);
    this.lp.connect(rumble);
    rumble.connect(megaphone);
    megaphone.connect(dc);
    dc.connect(this.out);

    const add = (type: OscillatorType, mult: number, detune: number, gain: number) => {
      const o = s.osc(type, F_IDLE * mult, detune);
      const g = s.gain(gain);
      o.connect(g);
      g.connect(this.drive);
      o.start(now + seed * 0.0007); // tiny stagger so the fleet never phase-locks
      this.oscs.push(o);
      this.mults.push(mult);
      this.sources.push(o);
      return g;
    };

    add('square', 0.5, 0, 0.42);
    add('sawtooth', 1, 0, 0.9);
    add('sawtooth', 1, rich ? 9 : 11, 0.6);
    if (rich) {
      add('sawtooth', 1, -13, 0.55);
      this.harm.push(add('sawtooth', 2, 4, 0.2));
      this.harm.push(add('square', 3, -6, 0.06));
    }

    // induction / intake roar
    const intake = s.noise('pink');
    this.intakeF = s.biquad('bandpass', 400, 1.1);
    this.intakeG = s.gain(EPS);
    intake.connect(this.intakeF);
    this.intakeF.connect(this.intakeG);
    this.intakeG.connect(this.drive);
    intake.start(now);
    this.sources.push(intake);

    // overrun burble — a sparse pop train gated by the closed-throttle term
    const crackle = s.noise('crackle', true, rich ? 1 : 1.17);
    const cf = s.biquad('bandpass', 820, 0.9);
    this.burbleG = s.gain(EPS);
    crackle.connect(cf);
    cf.connect(this.burbleG);
    this.burbleG.connect(this.drive);
    // The upshift pop is a scheduled envelope, and the burble gain is rewritten
    // by setTargetAtTime every frame; sharing one param means a frame landing
    // mid-pop truncates it. It gets its own tap off the same source instead.
    this.popG = s.gain(EPS);
    cf.connect(this.popG);
    this.popG.connect(this.drive);
    crackle.start(now + seed * 0.31);
    this.sources.push(crackle);

    // Turbo: a narrow resonant band riding the intake noise, silent until a
    // boost is live. This is the "hear the boost in the engine" term — without
    // it a boost is a whoosh played *over* an engine that never noticed, and
    // the whole payoff sits outside the thing the player is driving.
    if (rich) {
      this.turboF = s.biquad('bandpass', 3800, 7);
      this.turboG = s.gain(EPS);
      intake.connect(this.turboF);
      this.turboF.connect(this.turboG);
      this.turboG.connect(this.out);
    } else {
      this.turboF = null;
      this.turboG = null;
    }

    // --- tyres -------------------------------------------------------------
    const tyre = s.noise('white', true, 0.9 + seed * 0.03);
    // Q stays low: a narrow bandpass throws away nearly all of the noise power,
    // and two narrow ones in series at different centres cancel outright. The
    // "eee" comes from the peaking formant behind it, not from a tight Q.
    this.squealF1 = s.biquad('bandpass', 900, rich ? 2.2 : 1.8);
    this.squealG = s.gain(EPS);
    tyre.connect(this.squealF1);
    if (rich) {
      this.squealF2 = s.biquad('peaking', 1400, 5, 12);
      this.squealF1.connect(this.squealF2);
      this.squealF2.connect(this.squealG);
      // A thin tonal component riding inside the same formant is what sells
      // "rubber" rather than "hiss" — its 2nd harmonic sits in the passband.
      this.squealTone = s.osc('sawtooth', 620);
      this.squealToneG = s.gain(EPS);
      this.squealTone.connect(this.squealToneG);
      this.squealToneG.connect(this.squealF1);
      this.squealTone.start(now);
      this.sources.push(this.squealTone);
    } else {
      this.squealF2 = null;
      this.squealTone = null;
      this.squealToneG = null;
      this.squealF1.connect(this.squealG);
    }
    this.squealG.connect(rich ? s.sfx : (this.sfxPanner as AudioNode));
    tyre.start(now + seed * 0.13);
    this.sources.push(tyre);
  }

  /**
   * @param speedNorm |forward speed| / this kart's top speed
   * @param tau       param smoothing constant — larger for rivals, which we
   *                  only refresh every third frame
   */
  update(
    dt: number,
    now: number,
    speedNorm: number,
    throttle: number,
    brake: number,
    airborne: boolean,
    boost: number,
    stunned: boolean,
    level: number,
    dopplerMul: number,
    tau: number,
  ) {
    if (!this.live) return;
    this.muted = false;
    const u = clamp(speedNorm, 0, 1.35);

    // The boost swells into the engine over ~180 ms and leaves in ~70. That
    // asymmetry is not a detail, it is the whole shape of the payoff: the
    // release ducks the engine hard for the first 100 ms so the pop and the air
    // blast have a hole to go through, and if the engine's own boost gain rose
    // on the same frame it would fill that hole in and cancel the duck. It was
    // measured doing exactly that — a 7 dB duck came out as 1.2 dB. Slow in,
    // fast out, and the engine arrives just as the duck lets go.
    const bTarget = clamp01(boost);
    this.boostS += (bTarget - this.boostS) * Math.min(1, dt * (bTarget > this.boostS ? 5.5 : 14));
    const bo = this.boostS;

    // --- gearbox -----------------------------------------------------------
    let gear = Math.min(GEARS - 1, (u / GEAR_SPAN) | 0);
    let within = u / GEAR_SPAN - gear;
    if (u >= 1) {
      gear = GEARS - 1;
      within = 1 + (u - 1) * 0.6; // boost pulls past the limiter
    }
    let target = 0.34 + 0.64 * clamp(within, 0, 1.25);
    if (u < 0.03) target = 0.11 + throttle * 0.38; // idle, with a blip on the line
    if (airborne) target = Math.max(target, 0.52 + throttle * 0.45); // unloaded flare
    if (stunned) target = Math.min(target, 0.3);
    if (gear !== this.gear) {
      if (gear > this.gear) {
        this.shiftCut = 0.075; // ignition cut on the upshift
        // ...and the pop that comes out of the pipe when the fuel that was
        // already in there lights on the other side of the cut. Scheduled, not
        // smoothed: a shift is an event, and setTargetAtTime would round the
        // edge off the only part of it anyone actually hears.
        if (this.load > 0.5) this.s.perc(this.popG.gain, now + 0.05, 0.8 * this.load, 0.005, 0.085);
      }
      this.gear = gear;
    }
    if (this.shiftCut > 0) this.shiftCut -= dt;

    // Revs climb hard under power and fall lazily on the overrun.
    const rate = target > this.rpm ? 7.5 : 3.0;
    this.rpm += (target - this.rpm) * Math.min(1, dt * rate);

    const loadTarget = stunned ? 0.1 : clamp01(throttle * (1 - brake * 0.85));
    this.load += (loadTarget - this.load) * Math.min(1, dt * 9);

    const f = (F_IDLE + this.rpm * F_SPAN) * dopplerMul;
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(f * this.mults[i], now, tau);
    }

    // Timbre: on throttle the tanh stage is driven hard and the filter opens;
    // off throttle it collapses to a soft dark hum. That contrast is the
    // difference between "engine" and "buzzer", and it is why the load term
    // outweighs the rev term in the cutoff — the same 8000 rpm has to sound
    // like two different things depending on which pedal is down.
    this.drive.gain.setTargetAtTime(0.18 + this.load * 1.5 + bo * 0.7, now, tau);
    const cut = clamp(240 + this.rpm * 3200 + this.load * 4200 + bo * 1900, 200, 9500);
    this.lp.frequency.setTargetAtTime(cut, now, tau);
    if (this.rich) {
      this.harm[0].gain.setTargetAtTime(0.07 + this.load * 0.5 + bo * 0.2, now, tau);
      this.harm[1].gain.setTargetAtTime(0.015 + this.load * 0.3 + bo * 0.16, now, tau);
    }

    this.intakeF.frequency.setTargetAtTime(280 + this.rpm * 1900, now, tau);
    this.intakeG.gain.setTargetAtTime(
      Math.max(EPS, this.load * (0.05 + this.rpm * 0.26) * (this.rich ? 1 : 0.6) * (1 + bo * 0.7)),
      now,
      tau,
    );

    // Turbo whine: rises with revs, only present under boost, and it comes in
    // and goes out fast enough (35 ms) to bracket the boost rather than smear
    // across it.
    if (this.turboF && this.turboG) {
      this.turboF.frequency.setTargetAtTime(2600 + this.rpm * 3400, now, 0.05);
      this.turboG.gain.setTargetAtTime(Math.max(EPS, bo * (0.14 + this.rpm * 0.4)), now, 0.035);
    }

    // Burble: revs up, throttle shut. Squared so it arrives suddenly.
    const overrun = clamp01((0.5 - this.load) * 2.2) * clamp01(this.rpm * 1.7 - 0.45);
    this.burbleG.gain.setTargetAtTime(Math.max(EPS, overrun * overrun * 0.62), now, tau);

    // Kept well under unity on purpose: the tanh stage already runs at full
    // scale and the two exhaust peaks add up to ~+7 dB on top of it, so this is
    // the make-up that decides whether the limiter is working or resting.
    let g = level * (0.16 + this.rpm * 0.3) * (0.82 + this.load * 0.36 + bo * 0.16);
    if (this.shiftCut > 0) g *= 0.32;
    if (stunned) g *= 0.6;
    this.out.gain.setTargetAtTime(Math.max(EPS, g), now, tau);
  }

  /**
   * Tyres, driven by the real slip angle rather than by a drift flag.
   *
   * The tonal "eee" and the broadband roar are two separate curves against
   * `beta`, and that is the whole design. Broadband rises monotonically — more
   * angle, more noise. The tone is a *bell* centred just past the grip limit,
   * so it peaks when the tyre is right on the edge and falls away again once
   * the kart is simply sideways and scrubbing. A player who holds the slip in
   * the pocket gets a clean singing note; one who overdrives it gets a duller,
   * louder roar. That is finesse being paid in a currency you can hear.
   *
   * @param beta      lateral slip angle in radians, unsigned
   * @param tone      surface tonal weight (1 tarmac, ~0 sand)
   * @param centreMul surface formant multiplier
   * @param rough     surface broadband weight
   */
  setSqueal(
    now: number,
    beta: number,
    speedNorm: number,
    tone: number,
    centreMul: number,
    rough: number,
    dt: number,
    tau: number,
  ) {
    if (!this.live) return;
    // How fast the angle itself is moving — a tyre being worked reads as a
    // wavering note, a tyre parked at an angle reads as a flat one.
    const rate = dt > 1e-4 ? Math.abs(beta - this.beta) / dt : 0;
    this.beta = beta;
    const work = clamp01(rate * 1.6);

    const off = (beta - 0.34) / 0.26;
    const tonal = tone * Math.exp(-off * off) * clamp01(beta * 8);
    const broad = rough * clamp01((beta - 0.04) / 0.32);
    const speedGate = clamp01(speedNorm * 3);

    const f = (520 + beta * 1600 + speedNorm * 280 + work * 380) * centreMul;
    this.squealF1.frequency.setTargetAtTime(f, now, tau);
    if (this.squealF2) this.squealF2.frequency.setTargetAtTime(f * 1.47, now, tau);
    if (this.squealTone && this.squealToneG) {
      this.squealTone.frequency.setTargetAtTime(f * 0.52, now, tau);
      this.squealToneG.gain.setTargetAtTime(
        Math.max(EPS, tonal * (0.2 + work * 0.14) * speedGate),
        now,
        tau,
      );
    }
    const amount = tonal * 0.72 + broad * 1.15;
    this.squealG.gain.setTargetAtTime(
      Math.max(EPS, amount * (this.rich ? 1.5 : 0.95) * speedGate),
      now,
      tau,
    );
  }

  setPosition(x: number, y: number, z: number, now: number) {
    const p = this.enginePanner;
    if (!p) return;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, now, 0.03);
      p.positionY.setTargetAtTime(y, now, 0.03);
      p.positionZ.setTargetAtTime(z, now, 0.03);
    } else {
      (p as any).setPosition(x, y, z);
    }
    const q = this.sfxPanner;
    if (!q) return;
    if (q.positionX) {
      q.positionX.value = x;
      q.positionY.value = y;
      q.positionZ.value = z;
    } else {
      (q as any).setPosition(x, y, z);
    }
  }

  /** Idempotent: calling this every frame for an out-of-earshot rival is free. */
  mute(now: number) {
    if (this.muted) return;
    this.muted = true;
    this.out.gain.setTargetAtTime(EPS, now, 0.08);
    this.squealG.gain.setTargetAtTime(EPS, now, 0.08);
  }

  dispose() {
    this.live = false;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      try {
        s.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------
// DriftCharge — the sound of the drift becoming worth something
// ---------------------------------------------------------------------------

/**
 * The single highest-value sound in the game, and until this round it did not
 * exist: the charge was three one-shot pings at the tier boundaries and silence
 * in between, so between pings the player had nothing to go on but the HUD.
 *
 * This is continuous and player-only. Four things move together as the charge
 * builds, and they are redundant on purpose — any one of them read alone would
 * be ambiguous under a full-throttle engine, but a listener only has to catch
 * one of the four to know which tier they are on:
 *
 *   pitch    a clear step up per tier (CHARGE_LO/HI), plus a glide across the
 *            tier so the approach to the next one is audible before it lands.
 *            Measured: 218 / 458 / 687 / 994 Hz at half charge
 *   level    a 10 dB step from the pre-tier hum into blue, then 2.7–3.5 dB per
 *            tier after it
 *   timbre   t1 a plain detuned pair; t2 adds a fifth and a sizzle band and
 *            opens the filter; t3 adds an octave on top of both
 *   motion   only t3 has tremolo, so purple *shudders* — the cue that there is
 *            nothing left to charge and it is time to let go
 *
 * It lives on `s.lead`, which is presence-lifted and is never ducked, because
 * the one thing that must survive a boost, a collision and a full band is the
 * tone telling the player what they are holding. The engine, the music and the
 * rolling bed sidechain out of its way besides — see the sidechain block in
 * Audio.update(), and note that making room mattered far more than level did.
 *
 * Cost: 4 oscillators plus a tremolo LFO, one noise source and two filters.
 * Built once at unlock and never rebuilt; idle, it runs into a gain of 1e-4.
 */
class DriftCharge {
  private readonly s: Synth;
  private readonly out: GainNode;
  private readonly bp: BiquadFilterNode;
  private readonly trem: GainNode;
  private readonly lfoDepth: GainNode;
  private readonly root: OscillatorNode;
  private readonly detune: OscillatorNode;
  private readonly fifth: OscillatorNode;
  private readonly octave: OscillatorNode;
  private readonly fifthG: GainNode;
  private readonly octaveG: GainNode;
  private readonly airF: BiquadFilterNode;
  private readonly airG: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private live = true;
  private active = false;

  constructor(s: Synth) {
    this.s = s;
    const now = s.now;

    this.out = s.gain(EPS);
    this.out.connect(s.lead);

    // Tremolo sits after everything, so it modulates the whole voice and not
    // just one partial. Base 1, LFO adds ±depth.
    this.trem = s.gain(1);
    this.trem.connect(this.out);
    const lfo = s.osc('sine', 17);
    this.lfoDepth = s.gain(EPS);
    lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.trem.gain);
    lfo.start(now);
    this.sources.push(lfo);

    // A gentle bandpass tracking the fundamental keeps the saws from getting
    // harsh at tier 3 while still letting the fifth and the octave through.
    this.bp = s.biquad('bandpass', 600, 0.7);
    this.bp.connect(this.trem);

    const mk = (type: OscillatorType, f: number, cents: number, g: number) => {
      const o = s.osc(type, f, cents);
      const og = s.gain(g);
      o.connect(og);
      og.connect(this.bp);
      o.start(now);
      this.sources.push(o);
      return { o, og };
    };

    const r = mk('sawtooth', CHARGE_LO[0], 0, 0.5);
    this.root = r.o;
    // +9 cents, not unison: the beat it produces is slow enough to read as
    // "energy" rather than as an out-of-tune synth.
    const d = mk('sawtooth', CHARGE_LO[0], 9, 0.34);
    this.detune = d.o;
    const f5 = mk('square', CHARGE_LO[0] * 1.5, -4, EPS);
    this.fifth = f5.o;
    this.fifthG = f5.og;
    const o8 = mk('sawtooth', CHARGE_LO[0] * 2, 6, EPS);
    this.octave = o8.o;
    this.octaveG = o8.og;

    // Sizzle: a narrow noise band two octaves up, arriving with tier 2. It is
    // what stops the top tiers sounding like a bigger version of tier 1.
    const air = s.noise('white', true, 1.0);
    this.airF = s.biquad('bandpass', 2400, 3.5);
    this.airG = s.gain(EPS);
    air.connect(this.airF);
    this.airF.connect(this.airG);
    this.airG.connect(this.trem);
    air.start(now + 0.07);
    this.sources.push(air);
  }

  /**
   * @param tier   0..3
   * @param charge 0..1 progress through the current tier
   */
  set(now: number, drifting: boolean, tier: number, charge: number, tau: number) {
    if (!this.live) return;
    if (!drifting) {
      if (!this.active) return;
      this.active = false;
      this.out.gain.setTargetAtTime(EPS, now, 0.05);
      this.airG.gain.setTargetAtTime(EPS, now, 0.05);
      this.lfoDepth.gain.setTargetAtTime(EPS, now, 0.05);
      return;
    }
    const ti = clamp(tier | 0, 0, 3);
    const c = clamp01(charge);
    const f = CHARGE_LO[ti] + (CHARGE_HI[ti] - CHARGE_LO[ti]) * c;

    if (!this.active) {
      // Coming back from silence — and possibly from a flourish, whose ramp to
      // silence is scheduled up to 170 ms ahead. Chaining a drift straight out
      // of a boost is exactly what a good player does, so those pending events
      // have to go or the new charge tone gets cut off a sixth of a second in.
      this.active = true;
      const t0 = now;
      this.out.gain.cancelScheduledValues(t0);
      this.out.gain.setValueAtTime(EPS, t0);
      for (let i = 0; i < 4; i++) {
        const o = i === 0 ? this.root : i === 1 ? this.detune : i === 2 ? this.fifth : this.octave;
        const m = i === 2 ? 1.5 : i === 3 ? 2 : 1;
        o.frequency.cancelScheduledValues(t0);
        o.frequency.setValueAtTime(f * m, t0);
      }
    }

    this.root.frequency.setTargetAtTime(f, now, tau);
    this.detune.frequency.setTargetAtTime(f, now, tau);
    this.fifth.frequency.setTargetAtTime(f * 1.5, now, tau);
    this.octave.frequency.setTargetAtTime(f * 2, now, tau);
    this.fifthG.gain.setTargetAtTime(Math.max(EPS, CHARGE_FIFTH[ti]), now, tau);
    this.octaveG.gain.setTargetAtTime(Math.max(EPS, CHARGE_OCTAVE[ti]), now, tau);
    // The band sits ABOVE the fundamental on purpose, so the voice's energy
    // lands on its 2nd–4th harmonics rather than its root. The engine puts
    // almost everything it has below 1.5 kHz; a charge tone whose loudest
    // component is a 457 Hz root is competing directly with it and measured as
    // literally 0 dB of separation over a full mix. Emphasising the harmonics
    // moves the tone to 0.9–4 kHz, where the engine is 14 dB down and the
    // presence bell on the lead bus is waiting for it.
    // Opening the band further with the tier also makes the step up read as
    // brighter and not merely higher.
    this.bp.frequency.setTargetAtTime(f * (2.0 + ti * 0.3), now, tau);
    this.bp.Q.setTargetAtTime(0.55 + ti * 0.15, now, tau);
    this.airF.frequency.setTargetAtTime(f * 2.6 + 900, now, tau);
    this.airG.gain.setTargetAtTime(Math.max(EPS, ti >= 2 ? 0.05 + ti * 0.035 : EPS), now, tau);
    this.lfoDepth.gain.setTargetAtTime(Math.max(EPS, CHARGE_TREM[ti]), now, tau);
    this.out.gain.setTargetAtTime(Math.max(EPS, CHARGE_LEVEL[ti]), now, 0.02);
  }

  /**
   * Release. The tone does not simply stop — it slings upward and out under the
   * boost, which is what ties the payoff to the thing that earned it. Without
   * this the whoosh is just a sound that happened at the same time.
   */
  flourish(now: number, tier: number) {
    if (!this.live || tier <= 0) return;
    const ti = clamp(tier | 0, 1, 3);
    const f = CHARGE_HI[ti];
    this.active = false;
    for (let i = 0; i < 4; i++) {
      const o = i === 0 ? this.root : i === 1 ? this.detune : i === 2 ? this.fifth : this.octave;
      const m = i === 2 ? 1.5 : i === 3 ? 2 : 1;
      const p = o.frequency;
      p.cancelScheduledValues(now);
      p.setValueAtTime(Math.max(p.value, 1), now);
      p.exponentialRampToValueAtTime(f * m * 1.65, now + 0.11);
    }
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, EPS), now);
    g.exponentialRampToValueAtTime(CHARGE_LEVEL[ti] * 1.5, now + 0.03);
    g.exponentialRampToValueAtTime(EPS, now + 0.17);
    this.airG.gain.setTargetAtTime(EPS, now, 0.06);
    this.lfoDepth.gain.setTargetAtTime(EPS, now, 0.06);
  }

  mute(now: number) {
    if (!this.live) return;
    this.active = false;
    this.out.gain.setTargetAtTime(EPS, now, 0.08);
  }

  dispose() {
    this.live = false;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      try {
        s.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Ambience — the player's contact with the world
// ---------------------------------------------------------------------------

/**
 * Three rolling beds (tarmac hum, gravel crunch, sand hiss) crossfaded by
 * surface, plus a wind layer that only really arrives at speed. All of it is
 * driven from one shared trio of noise sources; only the filter chains differ.
 */
class Ambience {
  private tarmac: GainNode;
  private gravel: GainNode;
  private sand: GainNode;
  private hum: OscillatorNode;
  private humG: GainNode;
  private tarmacLp: BiquadFilterNode;
  private gravelBp: BiquadFilterNode;
  private windBp: BiquadFilterNode;
  private windPk: BiquadFilterNode;
  private windG: GainNode;
  private master: GainNode;
  private sources: AudioScheduledSourceNode[] = [];

  constructor(s: Synth) {
    const now = s.now;
    this.master = s.gain(1);
    this.master.connect(s.sfx);

    const pink = s.noise('pink');
    const white = s.noise('white', true, 1.1);
    const crackle = s.noise('crackle', true, 1.6);
    pink.start(now);
    white.start(now + 0.017);
    crackle.start(now + 0.041);
    this.sources.push(pink, white, crackle);

    // tarmac: low broadband roar with a resonant road hum under it
    this.tarmacLp = s.biquad('lowpass', 520, 0.9);
    const tarmacPk = s.biquad('peaking', 150, 1.2, 7);
    this.tarmac = s.gain(EPS);
    pink.connect(this.tarmacLp);
    this.tarmacLp.connect(tarmacPk);
    tarmacPk.connect(this.tarmac);
    this.tarmac.connect(this.master);

    this.hum = s.osc('triangle', 60);
    this.humG = s.gain(EPS);
    const humLp = s.biquad('lowpass', 300, 1.4);
    this.hum.connect(humLp);
    humLp.connect(this.humG);
    this.humG.connect(this.master);
    this.hum.start(now);
    this.sources.push(this.hum);

    // gravel: mid band plus a scatter of discrete stone hits
    this.gravelBp = s.biquad('bandpass', 1300, 0.6);
    this.gravel = s.gain(EPS);
    white.connect(this.gravelBp);
    this.gravelBp.connect(this.gravel);
    const stones = s.biquad('bandpass', 1900, 1.4);
    crackle.connect(stones);
    stones.connect(this.gravel);
    this.gravel.connect(this.master);

    // sand: high hiss with no body at all
    const sandHp = s.biquad('highpass', 2600, 0.6);
    const sandPk = s.biquad('peaking', 5200, 1.0, 4);
    this.sand = s.gain(EPS);
    white.connect(sandHp);
    sandHp.connect(sandPk);
    sandPk.connect(this.sand);
    this.sand.connect(this.master);

    // wind: broad and resonant, arriving late so speed still feels earned
    this.windBp = s.biquad('bandpass', 520, 0.5);
    this.windPk = s.biquad('peaking', 1800, 1.6, 5);
    this.windG = s.gain(EPS);
    pink.connect(this.windBp);
    this.windBp.connect(this.windPk);
    this.windPk.connect(this.windG);
    this.windG.connect(this.master);
  }

  update(now: number, speedNorm: number, surface: Surface, airborne: boolean, tau: number) {
    const sp = clamp01(speedNorm);
    const contact = airborne ? 0 : 1;
    let t = 0;
    let g = 0;
    let sa = 0;
    switch (surface) {
      case Surface.Road:
      case Surface.Boost:
        t = 1;
        break;
      case Surface.Dirt:
        t = 0.25;
        g = 1;
        break;
      case Surface.Grass:
        t = 0.15;
        g = 0.45;
        sa = 0.55;
        break;
      case Surface.Sand:
        g = 0.2;
        sa = 1;
        break;
      case Surface.Water:
        t = 0.3;
        sa = 0.9;
        break;
      default:
        t = 0.35;
        g = 0.75;
        sa = 0.3;
        break;
    }
    const roll = contact * (0.12 + sp * 0.95);
    // 0.14 s crossfade: quick enough to feel like a kerb strike, slow enough
    // not to chatter when the probe flickers across a surface boundary.
    this.tarmac.gain.setTargetAtTime(Math.max(EPS, t * roll * 0.5), now, 0.14);
    this.gravel.gain.setTargetAtTime(Math.max(EPS, g * roll * 0.4), now, 0.14);
    this.sand.gain.setTargetAtTime(Math.max(EPS, sa * roll * 0.3), now, 0.14);
    this.humG.gain.setTargetAtTime(Math.max(EPS, t * contact * sp * 0.22), now, tau);
    this.hum.frequency.setTargetAtTime(48 + sp * 78, now, tau);
    this.tarmacLp.frequency.setTargetAtTime(380 + sp * 900, now, tau);
    this.gravelBp.frequency.setTargetAtTime(950 + sp * 1400, now, tau);

    const wind = sp * sp;
    this.windG.gain.setTargetAtTime(Math.max(EPS, wind * 0.42), now, tau);
    this.windBp.frequency.setTargetAtTime(420 + sp * 900, now, tau);
    this.windPk.frequency.setTargetAtTime(1400 + sp * 1600, now, tau);
  }

  /**
   * Step the whole bed back while a mini-turbo tier is held. Rolling noise and
   * wind are the widest-band things in the mix and they sit right on top of the
   * charge tone's harmonics — measured, they and not the engine were most of
   * what was masking it. Unlike the tyres, none of it is information the player
   * needs during a drift, so it is the right thing to move out of the way.
   */
  setSide(now: number, duck: number) {
    this.master.gain.setTargetAtTime(Math.max(EPS, 1 - duck), now, 0.09);
  }

  mute(now: number) {
    this.tarmac.gain.setTargetAtTime(EPS, now, 0.1);
    this.gravel.gain.setTargetAtTime(EPS, now, 0.1);
    this.sand.gain.setTargetAtTime(EPS, now, 0.1);
    this.windG.gain.setTargetAtTime(EPS, now, 0.1);
    this.humG.gain.setTargetAtTime(EPS, now, 0.1);
  }

  dispose() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Audio system
// ---------------------------------------------------------------------------

export class Audio implements System {
  private ctx: Ctx | null = null;
  private synth: Synth | null = null;
  private music: Music | null = null;
  private ambience: Ambience | null = null;
  private charge: DriftCharge | null = null;
  private voices: KartVoice[] = [];
  private voiceKarts: IKart[] = [];
  private failed = false;
  private unsub: (() => void) | null = null;
  private lastVolume = -1;
  private tunnel = -1;
  private sidechain = -1;
  private lastAt = new Map<string, number>();
  private engineSend: GainNode | null = null;
  private muted = false;
  private unsupported = false;
  private activated = false;
  private audioTimer: number | null = null;
  private nextRebuildAt = 0;
  private audioAt = -Infinity;
  private audioDt = 0;
  private button: HTMLButtonElement | null = null;
  private soundCheck: SoundCheck | null = null;
  private recovery = new AudioRecovery(() => this.synth?.ctx ?? null, () => document.hidden);
  private onGesture = (event: Event) => {
    if ((event.target as Element | null)?.closest?.('.kart-audio-toggle')) return;
    if (!document.hidden && !this.muted) { this.activated = true; this.unlock(); }
  };
  private onFocus = () => { this.recovery.visibilityChanged(); this.pumpAudio(); };
  private onAudioState = () => this.paintButton();
  private onVisibility = () => this.syncSuspend();

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.unsub = ctx.bus.on((e) => this.onEvent(e));
    this.buildButton();
    void Music.preload().catch(error => console.warn('[music] preload will retry on play', error));
    if (new URLSearchParams(location.search).has('soundcheck')) this.soundCheck = new SoundCheck();
    // Recovery and diagnostics are independent of drawing. Music loops run
    // on the audio thread; this timer never grants autoplay access.
    this.audioTimer = window.setInterval(() => this.pumpAudio(), 50);
    // Audio may only start from a gesture. Until then this system is inert —
    // which is exactly what the headless capture harness needs.
    try {
      addEventListener('pointerdown', this.onGesture, { passive: true, capture: true });
      addEventListener('touchstart', this.onGesture, { passive: true, capture: true });
      addEventListener('keydown', this.onGesture, true);
      addEventListener('click', this.onGesture, true);
      addEventListener('focus', this.onFocus);
      addEventListener('pageshow', this.onFocus);
      document.addEventListener('visibilitychange', this.onVisibility);
    } catch {
      this.failed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Unlock / lifecycle
  // -------------------------------------------------------------------------

  private unlock() {
    if (this.unsupported || this.muted || document.hidden) return;
    // A running context with a delayed clock is not a closed context. Recovery
    // may be cycling it; closing it here races that recovery and cuts every
    // voice off, forcing another fetch/decode/start gap.
    if (this.synth?.ctx.state === 'closed') this.dropGraph();
    if (this.synth) { this.recovery.resume(); this.paintButton(); return; }
    const ctx = this.ctx;
    if (!ctx) return;
    const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    if (!AC) {
      this.unsupported = true;
      this.paintButton();
      return;
    }
    const vol = ctx.settings?.masterVolume ?? 0.8;
    this.failed = false;
    if (this.build(null, vol)) this.recovery.resume();
    this.paintButton();
  }

  /**
   * Diagnostic hook: bring the whole graph up against a caller-supplied context
   * — an OfflineAudioContext in the audio probe — with no gesture and no window
   * listeners, so the mix can be rendered and measured rather than guessed at.
   * The game never calls this; `unlock()` is the only production path in.
   *
   * Note for anyone writing such a harness: `update()` early-outs unless the
   * context reports 'running', and an OfflineAudioContext reports 'suspended'
   * inside a suspend callback. Drive the voices directly, or override `state`.
   */
  bootWith(ac: BaseAudioContext, volume = 1): Synth | null {
    if (this.synth) return this.synth;
    this.build(ac, volume);
    return this.synth;
  }

  /** Shared graph construction. Returns false if audio is unavailable. */
  private build(ac: BaseAudioContext | null, vol: number): boolean {
    let audioContext: BaseAudioContext | null = ac;
    try {
      if (!audioContext) {
        const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        audioContext = new AC({ latencyHint: 0.1 });
      }
      const s = new Synth(vol, audioContext!);
      this.lastVolume = vol;
      // Bus-level sends: a touch of room on everything, opened up in the tunnel.
      //
      // The engine send was 0.1 and it was far too wet. A continuous engine
      // feeding a 2.35 s plate integrates: measured, the reverb return sat only
      // 0.8 dB below the dry engine, so the wet signal was effectively a second
      // engine with no transients and a two-second release. That is why every
      // dynamic move in this file was arriving flattened — a 11.7 dB duck on the
      // engine bus came out of the render as 1.1 dB, because ducking the dry
      // path did nothing to the tail already inside the convolver. With the send
      // at 0.025 the same duck measures 9.8 dB.
      //
      // Taken post-duck (off engineSide) as well, so the room ducks with the
      // engine instead of hanging over the hole.
      this.engineSend = s.send(s.engineSide, s.reverbIn, 0.025);
      s.send(s.sfx, s.reverbIn, 0.12);
      // The charge tone gets a whisper of room too — completely dry it sounds
      // pasted on top of a world the kart is not in.
      s.send(s.lead, s.reverbIn, 0.07);
      this.synth = s;
      this.ambience = new Ambience(s);
      this.charge = new DriftCharge(s);
      this.music = new Music(s);
      this.music.start();
      if (!ac) s.ctx.addEventListener('statechange', this.onAudioState);
      this.recovery.reset();
      this.soundCheck?.attach(s);
      return true;
    } catch (err) {
      // A refused or exhausted AudioContext must never take the frame loop with
      // it — the game stays fully playable in silence.
      console.warn('[audio] unavailable', err);
      this.failed = true;
      this.dropGraph();
      if (!ac && audioContext && 'close' in audioContext) void (audioContext as AudioContext).close().catch(() => {});
      this.synth = null;
      this.music = null;
      this.ambience = null;
      this.charge = null;
      return false;
    }
  }

  private syncSuspend() { this.recovery.visibilityChanged(); this.paintButton(); }

  private pumpAudio() {
    const now = performance.now();
    this.recovery.tick(now);
    if (this.activated && !this.muted && !document.hidden && now >= this.nextRebuildAt
      && (!this.synth || this.synth.ctx.state === 'closed')) {
      this.nextRebuildAt = now + 5000;
      this.unlock();
    }
    if (this.synth?.ctx.state === 'running') this.music?.update();
    this.soundCheck?.update(now);
    this.paintButton();
  }

  private buildButton() {
    const button = document.createElement('button');
    button.className = 'kart-audio-toggle';
    button.style.cssText = 'position:fixed;left:20px;top:100px;z-index:10010;padding:10px 14px;border:1px solid #8a7651;border-radius:12px;background:#172233ed;color:#ffe1a0;font:600 14px system-ui;cursor:pointer';
    button.onclick = () => {
      const playing = this.synth?.ctx.state === 'running' && !this.recovery.stalled && !this.muted;
      if (playing) this.muted = true;
      else {
        this.muted = false;
        this.activated = true;
        if (this.ctx && this.ctx.settings.masterVolume <= 0) this.ctx.settings.masterVolume = 0.8;
        this.unlock();
      }
      if (this.synth && this.ctx) this.synth.setMasterVolume(this.muted ? 0 : this.ctx.settings.masterVolume);
      this.paintButton();
    };
    document.body.append(button); this.button = button; this.paintButton();
  }
  private paintButton() {
    if (!this.button) return;
    const state = this.unsupported ? 'unavailable' : this.muted ? 'muted' : this.failed ? 'failed'
      : this.synth?.ctx.state === 'running' && !this.recovery.stalled ? 'running' : this.synth ? 'blocked' : 'locked';
    const labels = {unavailable:'当前浏览器不支持声音',muted:'声音已关闭',failed:'重试声音',running:'声音已开启',blocked:'恢复声音',locked:'开启声音'};
    if (this.button.dataset.state !== state) {
      this.button.dataset.state = state; this.button.textContent = labels[state];
      this.button.title = state === 'running' ? '点击关闭音乐与音效' : '请在电脑点一下，开启音乐与音效';
      this.button.disabled = this.unsupported;
    }
  }
  private dropGraph() {
    this.soundCheck?.attach(null);
    this.music?.stop();
    for (const voice of this.voices) voice.dispose();
    this.voices = []; this.voiceKarts = [];
    this.ambience?.dispose(); this.charge?.dispose();
    this.synth?.ctx.removeEventListener('statechange', this.onAudioState);
    this.synth?.dispose();
    this.synth = null; this.music = null; this.ambience = null; this.charge = null;
    this.lastAt.clear(); this.tunnel = -1; this.sidechain = -1; this.engineSend = null; this.lastVolume = -1;
    this.audioAt = -Infinity; this.audioDt = 0;
    this.recovery.reset();
  }

  /** Build one voice per kart, once the race has actually populated its grid. */
  private ensureVoices(ctx: Ctx) {
    const karts = ctx.race?.karts;
    if (!karts || karts.length === 0) return;
    if (this.voices.length === karts.length && this.voiceKarts[0] === karts[0]) return;
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    this.voiceKarts.length = 0;
    const s = this.synth!;
    for (let i = 0; i < karts.length; i++) {
      this.voices.push(new KartVoice(s, karts[i].isPlayer, i));
      this.voiceKarts.push(karts[i]);
    }
  }

  private voiceOf(kart: IKart | null | undefined): KartVoice | null {
    if (!kart) return null;
    for (let i = 0; i < this.voiceKarts.length; i++) {
      if (this.voiceKarts[i] === kart) return this.voices[i];
    }
    return null;
  }

  /** Destination bus for a one-shot belonging to `kart` (null = drop it). */
  private dest(kart: IKart | null | undefined): AudioNode | null {
    const s = this.synth;
    if (!s) return null;
    if (!kart || kart.isPlayer) return s.sfx;
    // Rivals far away do not deserve a voice slot.
    if (kart.position.distanceToSquared(_camPos) > SFX_CULL_DIST * SFX_CULL_DIST) return null;
    const v = this.voiceOf(kart);
    return v ? v.sfxIn : s.sfx;
  }

  /** Per-key rate limit so a pile-up cannot machine-gun a single sound. */
  private gate(key: string, minGap: number): boolean {
    const s = this.synth;
    if (!s || s.busy) return false;
    const now = s.now;
    const last = this.lastAt.get(key) ?? -1e9;
    if (now - last < minGap) return false;
    this.lastAt.set(key, now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(ctx: Ctx, dt: number) {
    const s = this.synth;
    if (!s) return;
    const ac = s.ctx;
    if (ac.state !== 'running') return;
    const now = ac.currentTime;
    // Rendering may run faster than the audio clock during an overload. Do
    // not repeatedly rewrite hundreds of params at the same timestamp. 30 Hz
    // with the existing smoothing is sufficient for continuous engine tones;
    // event effects and phone/game inputs keep their original timing.
    this.audioDt += dt;
    if (now - this.audioAt < 1 / 30) return;
    this.audioAt = now; dt = Math.min(this.audioDt, 0.15); this.audioDt = 0;

    const vol = this.muted ? 0 : (ctx.settings?.masterVolume ?? 0.8);
    if (vol !== this.lastVolume) {
      this.lastVolume = vol;
      s.setMasterVolume(vol);
    }

    this.syncListener(ctx, now);
    this.ensureVoices(ctx);

    const race = ctx.race;
    const state = race?.state ?? RaceState.Racing;
    const paused = state === RaceState.Paused;
    const player = race?.player ?? null;

    // Tunnel: the art bible puts it at t 0.52–0.60. Swelling the reverb return
    // and the engine send through it costs nothing and reads instantly.
    const inTunnel = player && player.t > 0.505 && player.t < 0.625 ? 1 : 0;
    if (inTunnel !== this.tunnel) {
      this.tunnel = inTunnel;
      s.glide(s.reverbReturn.gain, inTunnel ? 1.35 : 0.5, 0.25, now);
      if (this.engineSend) s.glide(this.engineSend.gain, inTunnel ? 0.16 : 0.025, 0.25, now);
    }

    const input = ctx.input?.state;
    const frame = ctx.frame;

    for (let i = 0; i < this.voices.length; i++) {
      const k = this.voiceKarts[i];
      const v = this.voices[i];
      const isPlayer = k.isPlayer;
      // Rivals refresh at 20 Hz with a longer smoothing constant: inaudible,
      // and it keeps param-event traffic to roughly a third.
      if (!isPlayer && (frame + i) % 3 !== 0) continue;
      const step = isPlayer ? dt : dt * 3;
      const tau = isPlayer ? 0.028 : 0.07;

      const top = BASE_TOP_SPEED * (k.stats?.topSpeedMul ?? 1);
      const speed = Math.abs(k.forwardSpeed);
      const speedNorm = speed / top;

      let throttle: number;
      let brake = 0;
      if (isPlayer && input) {
        throttle = input.accel;
        brake = input.brake;
      } else {
        // AI throttle is not exposed on IKart, so infer it from acceleration.
        // Close enough that the timbre shift on corner exit still reads.
        const acc = step > 0 ? (speed - v.prevSpeed) / step : 0;
        throttle = clamp01(0.45 + acc * 0.14);
      }
      v.prevSpeed = speed;
      if (k.boostTime > 0) throttle = 1;
      if (k.stunTime > 0) throttle = 0.08;
      if (state === RaceState.Menu || state === RaceState.Results) throttle *= 0.3;

      let level = paused ? 0 : isPlayer ? 1 : 0.72;
      if (state === RaceState.Menu) level *= 0.5;

      let doppler = 1;
      if (!isPlayer) {
        // Manual Doppler: the spec dropped it from PannerNode, but a rival that
        // closes on you without pitching sounds like a recording.
        _rel.copy(k.position).sub(_camPos);
        const d = _rel.length();
        // Past this the panner has it 28 dB down; skip the whole voice rather
        // than push a dozen param events per frame for something inaudible.
        if (d > 200) {
          v.mute(now);
          continue;
        }
        if (d > 1e-3 && player) {
          _rel.multiplyScalar(1 / d);
          _vel.copy(k.velocity).sub(player.velocity);
          doppler = 1 - clamp(_vel.dot(_rel) / 343, -0.05, 0.05);
        }
        v.setPosition(k.position.x, k.position.y + 0.4, k.position.z, now);
      }

      // Boost as a continuous amount, not a flag: the tail of a mini-turbo
      // should fade out of the engine rather than switch off.
      const boostAmt = k.boostTime > 0 ? clamp01(k.boostTime * 3) : 0;

      v.update(
        step,
        now,
        speedNorm,
        throttle,
        brake,
        k.airborne,
        boostAmt,
        k.stunTime > 0,
        level,
        doppler,
        tau,
      );

      // --- tyre slip -------------------------------------------------------
      // The real slip angle, in radians: atan2(lateral, forward). The old code
      // used a normalised |lateral velocity|, which conflated "sideways at
      // 20 m/s" with "sideways at 5 m/s in a much tighter slide" — the second
      // is the one that should sing.
      let beta = 0;
      if (!k.airborne && speed > 3) {
        _fwd.copy(k.forward);
        _right.set(_fwd.z, 0, -_fwd.x); // world-up cross forward
        const rl = _right.length();
        if (rl > 1e-4) {
          _right.multiplyScalar(1 / rl);
          const lat = Math.abs(k.velocity.dot(_right));
          const lon = Math.max(Math.abs(k.velocity.dot(_fwd)), 1.5);
          beta = Math.atan2(lat, lon);
        }
        // A held drift is a committed angle even when the physics has the kart
        // tracking neatly; floor it so the slide never goes quiet mid-corner.
        if (k.driftDir !== 0) beta = Math.max(beta, 0.2 + 0.2 * clamp01(k.driftCharge));
      }
      const sq = SQUEAL_SURFACE[k.surface] ?? SQUEAL_SURFACE[Surface.Road];
      v.setSqueal(now, paused ? 0 : beta, speedNorm, sq[0], sq[1], sq[2], step, tau);
    }

    // --- the mini-turbo charge ---------------------------------------------
    if (this.charge) {
      const drifting = !!player && player.driftDir !== 0 && player.stunTime <= 0 && !paused;
      const tier = drifting ? clamp(player!.driftTier | 0, 0, 3) : 0;
      if (paused || !player) this.charge.mute(now);
      else this.charge.set(now, drifting, tier, player.driftCharge, 0.03);

      // Sidechain: the engine, the music and the rolling/wind bed all step back
      // for as long as a tier is held, so the tone has somewhere to sit rather
      // than having to win a level war. 90 ms constant — quick enough to arrive
      // with the tier, slow enough that it reads as the mix leaning out of the
      // way rather than as pumping.
      //
      // The tyres are deliberately NOT in it. They are the other half of what
      // the player is listening to during a drift; ducking them to make room
      // for the tone would be trading one cue for another.
      const side = drifting ? CHARGE_SIDECHAIN[tier] : 0;
      if (side !== this.sidechain) {
        this.sidechain = side;
        s.glide(s.engineSide.gain, 1 - side, 0.09, now);
        s.glide(s.musicSide.gain, 1 - side * 1.25, 0.09, now);
        this.ambience?.setSide(now, side * 0.9);
      }
    }

    if (player && this.ambience) {
      const top = BASE_TOP_SPEED * (player.stats?.topSpeedMul ?? 1);
      const sp = Math.abs(player.forwardSpeed) / top;
      if (paused) this.ambience.mute(now);
      else this.ambience.update(now, sp, player.surface, player.airborne, 0.05);
    }

    const music = this.music;
    if (music) {
      music.setFull(state === RaceState.Racing);
      music.setDuck(false);
      const laps = race?.totalLaps ?? 3;
      music.setFinalLap(
        !!player && !player.finished && player.lap >= laps - 1 && state === RaceState.Racing,
      );
      music.update();
    }
  }

  private syncListener(ctx: Ctx, now: number) {
    const cam = ctx.camera;
    if (!cam) return;
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);
    _fwd.set(0, 0, -1).applyQuaternion(_camQuat);
    _up.set(0, 1, 0).applyQuaternion(_camQuat);
    const l = this.synth!.ctx.listener;
    if (l.positionX) {
      l.positionX.setTargetAtTime(_camPos.x, now, 0.02);
      l.positionY.setTargetAtTime(_camPos.y, now, 0.02);
      l.positionZ.setTargetAtTime(_camPos.z, now, 0.02);
      l.forwardX.setTargetAtTime(_fwd.x, now, 0.02);
      l.forwardY.setTargetAtTime(_fwd.y, now, 0.02);
      l.forwardZ.setTargetAtTime(_fwd.z, now, 0.02);
      l.upX.setTargetAtTime(_up.x, now, 0.02);
      l.upY.setTargetAtTime(_up.y, now, 0.02);
      l.upZ.setTargetAtTime(_up.z, now, 0.02);
    } else {
      (l as any).setPosition(_camPos.x, _camPos.y, _camPos.z);
      (l as any).setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  // -------------------------------------------------------------------------
  // Event routing — every GameEvent variant has a voice
  // -------------------------------------------------------------------------

  private onEvent(e: GameEvent) {
    const s = this.synth;
    if (!s || s.ctx.state !== 'running') return;
    switch (e.type) {
      case 'drift-spark': {
        const d = this.dest(e.kart);
        if (!d) return;
        if (e.tier <= 0) {
          if (this.gate('scrub' + e.kart.id, 0.4)) this.scrub(d);
        } else if (this.gate('tier' + e.kart.id, 0.12)) {
          this.chargeTier(d, e.tier, e.kart.isPlayer);
        }
        break;
      }
      case 'boost': {
        // The charge tone slings out under the boost even if the one-shot is
        // rate-gated away — it is a continuous voice that is currently making a
        // noise, and leaving it to be cut by the next `set()` would strand it.
        if (e.kart.isPlayer) this.charge?.flourish(s.now, e.tier);
        const d = this.dest(e.kart);
        if (d && this.gate('boost' + e.kart.id, 0.16)) this.boost(d, e.tier, e.kart.isPlayer);
        break;
      }
      case 'hop': {
        const d = this.dest(e.kart);
        if (d && this.gate('hop' + e.kart.id, 0.12)) this.hop(d);
        break;
      }
      case 'land': {
        const d = this.dest(e.kart);
        if (d && this.gate('land' + e.kart.id, 0.1)) this.land(d, clamp01(e.impact));
        break;
      }
      case 'collide': {
        const d = this.dest(e.kart);
        if (d && this.gate('bump' + e.kart.id, 0.09)) {
          this.impact(d, clamp01(Math.abs(e.impulse) * 0.12), e.other !== null);
        }
        break;
      }
      case 'item-pickup': {
        const d = this.dest(e.kart);
        if (!d) return;
        if (e.kart.isPlayer) this.roulette(d);
        else if (this.gate('pick' + e.kart.id, 0.3)) this.blip(d, 880, 0.1, 0.12);
        break;
      }
      case 'item-use':
        this.itemUse(e.kart, e.kind);
        break;
      case 'hit':
        this.itemHit(e.kart, e.kind);
        break;
      case 'lap': {
        if (!e.kart.isPlayer) return;
        const laps = this.ctx?.race?.totalLaps ?? 3;
        this.lapChime(s.sfx, e.lap >= laps - 1);
        break;
      }
      case 'finish': {
        if (!e.kart.isPlayer) return;
        this.fanfare(s.sfx, e.place <= 3);
        break;
      }
      case 'countdown':
        this.countdown(s.sfx, e.n);
        break;
      case 'coin': {
        const d = this.dest(e.kart);
        if (d && this.gate('coin', 0.05)) this.coin(d);
        break;
      }
      case 'ui':
        this.ui(s.sfx, e.name);
        break;
    }
  }

  private itemUse(kart: IKart, kind: ItemKind) {
    const d = this.dest(kart);
    if (!d || !this.gate('use' + kart.id, 0.06)) return;
    switch (kind) {
      case ItemKind.GreenShell:
      case ItemKind.RedShell:
        this.shellFire(d, kind === ItemKind.RedShell);
        break;
      case ItemKind.Banana:
        this.plop(d);
        break;
      case ItemKind.Bomb:
        this.whoosh(d, 0.34, 0.32, true);
        break;
      case ItemKind.Star:
        this.starJingle(d);
        break;
      case ItemKind.Bolt:
        this.zap(d, true);
        break;
      case ItemKind.Mushroom:
      case ItemKind.TripleMushroom:
        this.blip(d, 660, 0.07, 0.16, 'triangle');
        break;
      default:
        this.blip(d, 520, 0.06, 0.1);
        break;
    }
  }

  private itemHit(kart: IKart, kind: ItemKind) {
    const d = this.dest(kart);
    if (!d || !this.gate('hit' + kart.id, 0.08)) return;
    switch (kind) {
      case ItemKind.Bomb:
        this.explosion(d, 1);
        break;
      case ItemKind.GreenShell:
      case ItemKind.RedShell:
        this.explosion(d, 0.62);
        break;
      case ItemKind.Banana:
        this.slip(d);
        break;
      case ItemKind.Bolt:
        this.zap(d, false);
        break;
      case ItemKind.Star:
        this.impact(d, 0.8, false);
        break;
      default:
        this.impact(d, 0.6, false);
        break;
    }
    if (kart.isPlayer && kind !== ItemKind.Star) this.dizzy(this.synth!.sfx);
  }

  // -------------------------------------------------------------------------
  // One-shot voices
  // -------------------------------------------------------------------------

  /** Generic short tone — the backbone of every UI-ish sound in the game. */
  private blip(
    dest: AudioNode,
    freq: number,
    dur: number,
    vol: number,
    type: OscillatorType = 'square',
    slideTo = 0,
    delay = 0,
  ) {
    const s = this.synth!;
    const t = s.now + delay;
    const g = s.gain(EPS);
    const lp = s.biquad('lowpass', freq * 6 + 800, 1);
    lp.connect(g);
    g.connect(dest);
    const o = s.osc(type, freq);
    if (slideTo > 0) {
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    }
    o.connect(lp);
    s.perc(g.gain, t, vol, 0.004, dur);
    o.start(t);
    o.stop(t + dur + 0.06);
    s.retire(o, lp, g);
  }

  /** Filtered noise sweep — boosts, throws, whooshes. */
  private whoosh(dest: AudioNode, dur: number, vol: number, up: boolean, delay = 0) {
    const s = this.synth!;
    const t = s.now + delay;
    const n = s.noise('white', false, 1);
    const bp = s.biquad('bandpass', 500, 1.3);
    const g = s.gain(EPS);
    n.connect(bp);
    bp.connect(g);
    g.connect(dest);
    bp.frequency.setValueAtTime(up ? 400 : 3200, t);
    bp.frequency.exponentialRampToValueAtTime(up ? 3400 : 320, t + dur);
    bp.Q.setValueAtTime(1.2, t);
    bp.Q.linearRampToValueAtTime(3.5, t + dur);
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    n.start(t, Math.random() * 1.2);
    n.stop(t + dur + 0.05);
    s.retire(n, bp, g);
  }

  /** Drift entry: a short broadband tyre scuff. */
  private scrub(dest: AudioNode) {
    const s = this.synth!;
    const t = s.now;
    const n = s.noise('white', false, 1.2);
    const bp = s.biquad('bandpass', 1500, 2.5);
    const g = s.gain(EPS);
    n.connect(bp);
    bp.connect(g);
    g.connect(dest);
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(2000, t + 0.16);
    s.perc(g.gain, t, 0.22, 0.01, 0.2);
    n.start(t, Math.random());
    n.stop(t + 0.3);
    s.retire(n, bp, g);
  }

  /**
   * A tier landing. This is a *flash*, not the charge itself — the continuous
   * DriftCharge voice carries the tier; this marks the instant it changed, in
   * the same key as the tone that is about to take over, so the two read as one
   * event rather than as a ping over a drone.
   */
  private chargeTier(dest: AudioNode, tier: number, prominent: boolean) {
    const s = this.synth!;
    const t = s.now;
    const ti = clamp(tier, 1, 3);
    const base = CHARGE_LO[ti];
    const g = s.gain(EPS);
    const bp = s.biquad('bandpass', base * 1.6, 1.5);
    bp.connect(g);
    // The player's flash goes to the lead bus, so it survives the same full-
    // throttle engine the tone does. A rival's stays on their positioned voice,
    // where it belongs — three karts charging behind you should not all arrive
    // dead centre and undimmed.
    g.connect(prominent ? s.lead : dest);
    const o = s.osc('sawtooth', base * 0.62);
    o.frequency.setValueAtTime(base * 0.62, t);
    o.frequency.exponentialRampToValueAtTime(base * 1.02, t + 0.11);
    const o2 = s.osc('sine', base * 1.5);
    o2.frequency.setValueAtTime(base * 1.5, t);
    o2.frequency.exponentialRampToValueAtTime(base * 2.02, t + 0.13);
    const og = s.gain(0.42 + ti * 0.06);
    o.connect(bp);
    o2.connect(og);
    og.connect(g);
    s.perc(g.gain, t, (0.1 + ti * 0.055) * (prominent ? 1 : 0.45), 0.008, 0.2);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.3);
    o2.stop(t + 0.3);
    s.retire(o, bp, g, og);
    s.retire(o2);
  }

  /**
   * The payoff. Four things happen at once and the order matters:
   *
   *   1. the engine and the music duck hard and fast (18 ms), opening a hole;
   *   2. a crackle pop and a tier-scaled air blast go through the hole;
   *   3. a sub thump lands under it so it is felt as well as heard;
   *   4. the engine comes back *past* unity and settles — it surges under load.
   *
   * Everything scales with tier, including the duck: a purple release takes
   * 8 dB out of the engine for 140 ms and a blue one takes 3.5 dB for 90, so
   * the three tiers are as distinct on release as they are on the charge.
   */
  private boost(dest: AudioNode, tier: number, prominent: boolean) {
    const s = this.synth!;
    const t = s.now;
    const ti = clamp(tier, 1, 3);
    const vol = prominent ? 1 : 0.5;
    const scale = 0.7 + ti * 0.16;

    if (prominent) {
      // Duck depth and overshoot both climb with tier. The overshoot is what
      // sells "surging back under load" — see Synth.duck().
      s.duck(s.engineDuck.gain, t, 0.56 - ti * 0.1, 0.05 + ti * 0.03, 1.1 + ti * 0.05, 0.42);
      s.duck(s.musicDuck.gain, t, 0.66 - ti * 0.09, 0.04 + ti * 0.02, 1, 0.5);
    }

    const n = s.noise('crackle', false, 1.3 + ti * 0.12);
    const drive = s.shaper(6);
    const lp = s.biquad('lowpass', 900, 1.6);
    const g = s.gain(EPS);
    n.connect(drive);
    drive.connect(lp);
    lp.connect(g);
    g.connect(dest);
    lp.frequency.setValueAtTime(700 + ti * 500, t);
    lp.frequency.exponentialRampToValueAtTime(400, t + 0.16);
    s.perc(g.gain, t, 0.46 * vol * scale, 0.002, 0.12 + ti * 0.02);
    n.start(t, Math.random() * 2);
    n.stop(t + 0.24);
    s.retire(n, drive, lp, g);

    this.whoosh(dest, 0.34 + ti * 0.09, 0.34 * vol * scale, true);

    const o = s.osc('sine', 62);
    const og = s.gain(EPS);
    o.connect(og);
    og.connect(dest);
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(150 + ti * 42, t + 0.28);
    s.perc(og.gain, t, 0.38 * vol * scale, 0.016, 0.3 + ti * 0.05);
    o.start(t);
    o.stop(t + 0.45);
    s.retire(o, og);
  }

  private hop(dest: AudioNode) {
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('triangle', 240);
    const g = s.gain(EPS);
    const bp = s.biquad('bandpass', 700, 2);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(520, t + 0.09);
    s.perc(g.gain, t, 0.16, 0.003, 0.1);
    o.start(t);
    o.stop(t + 0.16);
    s.retire(o, bp, g);
  }

  private land(dest: AudioNode, impact: number) {
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('sine', 150);
    const og = s.gain(EPS);
    o.connect(og);
    og.connect(dest);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(54, t + 0.12);
    s.perc(og.gain, t, 0.15 + impact * 0.5, 0.003, 0.18);
    o.start(t);
    o.stop(t + 0.24);
    s.retire(o, og);

    const n = s.noise('white', false, 0.8);
    const lp = s.biquad('lowpass', 1600 + impact * 2200, 1.1);
    const g = s.gain(EPS);
    n.connect(lp);
    lp.connect(g);
    g.connect(dest);
    s.perc(g.gain, t, 0.1 + impact * 0.3, 0.002, 0.09);
    n.start(t, Math.random());
    n.stop(t + 0.16);
    s.retire(n, lp, g);
  }

  /** Metal-on-metal (walls) or a softer body check (kart on kart). */
  private impact(dest: AudioNode, strength: number, soft: boolean) {
    const s = this.synth!;
    const t = s.now;
    const v = 0.14 + strength * 0.6;
    const g = s.gain(EPS);
    const lp = s.biquad('lowpass', soft ? 1400 : 4200, 1);
    lp.connect(g);
    g.connect(dest);
    s.perc(g.gain, t, v, 0.002, soft ? 0.14 : 0.26);
    // Inharmonic partials read as "panel"; harmonic ones would read as "bell".
    const ratios = soft ? [1, 1.61] : [1, 1.71, 2.43, 3.11];
    const base = (soft ? 160 : 290) * (0.85 + strength * 0.4);
    for (let i = 0; i < ratios.length; i++) {
      const o = s.osc(i === 0 ? 'triangle' : 'square', base * ratios[i]);
      const og = s.gain(0.5 / (i + 1));
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + 0.3);
      s.retire(o, og);
    }
    const n = s.noise('white', false, 1.3);
    const bp = s.biquad('bandpass', soft ? 700 : 2600, 0.9);
    const ng = s.gain(EPS);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(g);
    s.perc(ng.gain, t, 0.7, 0.001, soft ? 0.05 : 0.09);
    n.start(t, Math.random());
    n.stop(t + 0.16);
    s.retire(n, bp, ng, lp, g);
  }

  private explosion(dest: AudioNode, size: number) {
    const s = this.synth!;
    const t = s.now;
    const dur = 0.55 + size * 0.5;
    const n = s.noise('white', false, 0.8);
    const drive = s.shaper(5);
    const lp = s.biquad('lowpass', 4000, 0.9);
    const g = s.gain(EPS);
    n.connect(drive);
    drive.connect(lp);
    lp.connect(g);
    g.connect(dest);
    const send = s.send(g, s.reverbIn, 0.5);
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + dur);
    s.perc(g.gain, t, 0.55 * size + 0.2, 0.004, dur);
    n.start(t, Math.random() * 1.5);
    n.stop(t + dur + 0.1);
    s.retire(n, drive, lp, g, send);

    const o = s.osc('sine', 110);
    const og = s.gain(EPS);
    o.connect(og);
    og.connect(dest);
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(32, t + dur * 0.7);
    s.perc(og.gain, t, 0.5 * size, 0.006, dur * 0.8);
    o.start(t);
    o.stop(t + dur);
    s.retire(o, og);
  }

  private shellFire(dest: AudioNode, homing: boolean) {
    const s = this.synth!;
    const t = s.now;
    this.whoosh(dest, 0.26, 0.3, true);
    // spinning shell: a fast vibrato on a bright tone
    const o = s.osc('square', homing ? 520 : 430);
    const g = s.gain(EPS);
    const bp = s.biquad('bandpass', 1600, 2.4);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    const lfo = s.osc('sine', 22);
    const lfoG = s.gain(homing ? 90 : 55);
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);
    o.frequency.setValueAtTime(homing ? 520 : 430, t);
    o.frequency.exponentialRampToValueAtTime(homing ? 900 : 620, t + 0.3);
    s.perc(g.gain, t, 0.24, 0.008, 0.34);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.45);
    lfo.stop(t + 0.45);
    s.retire(o, bp, g, lfoG);
    s.retire(lfo);
  }

  private plop(dest: AudioNode) {
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('sine', 520);
    const g = s.gain(EPS);
    o.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.11);
    s.perc(g.gain, t, 0.24, 0.004, 0.12);
    o.start(t);
    o.stop(t + 0.2);
    s.retire(o, g);
  }

  /** Banana: the comedy descending slide, with a rubber scuff underneath. */
  private slip(dest: AudioNode) {
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('triangle', 1100);
    const g = s.gain(EPS);
    const bp = s.biquad('bandpass', 1600, 3);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(1100, t);
    o.frequency.exponentialRampToValueAtTime(220, t + 0.45);
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.45);
    const vib = s.osc('sine', 12);
    const vibG = s.gain(45);
    vib.connect(vibG);
    vibG.connect(o.frequency);
    s.perc(g.gain, t, 0.3, 0.01, 0.5);
    o.start(t);
    vib.start(t);
    o.stop(t + 0.6);
    vib.stop(t + 0.6);
    s.retire(o, bp, g, vibG);
    s.retire(vib);
    this.scrub(dest);
  }

  private zap(dest: AudioNode, fire: boolean) {
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('sawtooth', fire ? 1400 : 900);
    const drive = s.shaper(8);
    const bp = s.biquad('bandpass', 2200, 1.6);
    const g = s.gain(EPS);
    o.connect(drive);
    drive.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(fire ? 1400 : 900, t);
    o.frequency.exponentialRampToValueAtTime(fire ? 180 : 2600, t + 0.36);
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(fire ? 500 : 3800, t + 0.36);
    s.perc(g.gain, t, 0.3, 0.004, 0.4);
    o.start(t);
    o.stop(t + 0.5);
    s.retire(o, drive, bp, g);
  }

  /** Post-hit disorientation: a slow warble that fades out on its own. */
  private dizzy(dest: AudioNode) {
    if (!this.gate('dizzy', 0.8)) return;
    const s = this.synth!;
    const t = s.now;
    const o = s.osc('sine', 620);
    const g = s.gain(EPS);
    o.connect(g);
    g.connect(dest);
    const lfo = s.osc('sine', 6.5);
    const lfoG = s.gain(180);
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
    g.gain.exponentialRampToValueAtTime(EPS, t + 1.1);
    o.start(t);
    lfo.start(t);
    o.stop(t + 1.2);
    lfo.stop(t + 1.2);
    s.retire(o, g, lfoG);
    s.retire(lfo);
  }

  /** Item box: a decelerating tick train that settles into a confirmation. */
  private roulette(dest: AudioNode) {
    if (!this.gate('roulette', 0.5)) return;
    this.whoosh(dest, 0.2, 0.18, true);
    let t = 0.04;
    let gap = 0.045;
    for (let i = 0; i < 14; i++) {
      this.tick(dest, t, 0.1);
      t += gap;
      gap *= 1.14; // the reel slowing down
    }
    this.blip(dest, 784, 0.09, 0.16, 'triangle', 0, t + 0.02);
    this.blip(dest, 1175, 0.16, 0.18, 'triangle', 0, t + 0.09);
  }

  private tick(dest: AudioNode, delay: number, vol: number) {
    const s = this.synth!;
    const t = s.now + delay;
    const n = s.noise('white', false, 1.5);
    const bp = s.biquad('bandpass', 3200, 5);
    const g = s.gain(EPS);
    n.connect(bp);
    bp.connect(g);
    g.connect(dest);
    s.perc(g.gain, t, vol, 0.001, 0.02);
    n.start(t, Math.random());
    n.stop(t + 0.05);
    s.retire(n, bp, g);
  }

  private coin(dest: AudioNode) {
    this.blip(dest, 1319, 0.05, 0.14, 'square');
    this.blip(dest, 1976, 0.16, 0.14, 'square', 0, 0.05);
  }

  private starJingle(dest: AudioNode) {
    const notes = [72, 76, 79, 84, 88];
    for (let i = 0; i < notes.length; i++) {
      this.blip(dest, mtof(notes[i]), 0.14, 0.16, 'triangle', 0, i * 0.055);
    }
  }

  private lapChime(dest: AudioNode, final: boolean) {
    const notes = final ? [76, 81, 88] : [69, 76, 81];
    for (let i = 0; i < notes.length; i++) {
      this.bell(dest, mtof(notes[i]), 0.55, 0.16, i * 0.08);
    }
  }

  private fanfare(dest: AudioNode, good: boolean) {
    const notes = good ? [69, 73, 76, 81, 85] : [69, 72, 74, 77];
    for (let i = 0; i < notes.length; i++) {
      const last = i === notes.length - 1;
      this.bell(dest, mtof(notes[i]), last ? 1.4 : 0.4, 0.2, i * 0.11);
      this.blip(dest, mtof(notes[i] - 12), last ? 0.5 : 0.16, 0.12, 'triangle', 0, i * 0.11);
    }
  }

  /** FM bell — the tonal one-shot behind anything celebratory. */
  private bell(dest: AudioNode, freq: number, dur: number, vol: number, delay: number) {
    const s = this.synth!;
    const t = s.now + delay;
    const g = s.gain(EPS);
    g.connect(dest);
    const car = s.osc('sine', freq);
    const mod = s.osc('sine', freq * 2.76);
    const idx = s.gain(freq * 2.4);
    mod.connect(idx);
    idx.connect(car.frequency);
    idx.gain.setValueAtTime(freq * 2.4, t);
    idx.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.4);
    car.connect(g);
    s.perc(g.gain, t, vol, 0.005, dur);
    const send = s.send(g, s.reverbIn, 0.35);
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.1);
    mod.stop(t + dur + 0.1);
    s.retire(car, g, idx, send);
    s.retire(mod);
  }

  private countdown(dest: AudioNode, n: number) {
    if (n > 0) {
      // three low, deliberately dry — they are a metronome, not a melody
      this.blip(dest, 440, 0.22, 0.3, 'square');
      this.blip(dest, 220, 0.26, 0.16, 'triangle');
    } else {
      this.blip(dest, 880, 0.5, 0.34, 'square');
      this.blip(dest, 1320, 0.5, 0.16, 'triangle');
      this.whoosh(dest, 0.6, 0.3, true);
    }
  }

  private ui(dest: AudioNode, name: string) {
    if (!this.gate('ui', 0.04)) return;
    switch (name) {
      case 'confirm':
      case 'start':
        this.blip(dest, 660, 0.08, 0.16, 'square');
        this.blip(dest, 990, 0.14, 0.14, 'square', 0, 0.06);
        break;
      case 'back':
      case 'cancel':
        this.blip(dest, 440, 0.12, 0.14, 'square', 220);
        break;
      case 'pause':
        this.blip(dest, 520, 0.18, 0.16, 'triangle', 260);
        break;
      case 'resume':
        this.blip(dest, 320, 0.18, 0.16, 'triangle', 640);
        break;
      case 'move':
      case 'hover':
        this.blip(dest, 740, 0.05, 0.09, 'triangle');
        break;
      // --- names raised by the race director ---
      case 'burnout':
        // wheelspin on the grid: rubber chirp over a rev flare
        this.scrub(dest);
        this.blip(dest, 90, 0.26, 0.22, 'sawtooth', 220);
        break;
      case 'respawn':
        this.whoosh(dest, 0.3, 0.22, false);
        this.bell(dest, mtof(76), 0.3, 0.14, 0.18);
        this.bell(dest, mtof(83), 0.45, 0.14, 0.26);
        break;
      case 'respawn-rival':
        this.blip(dest, 520, 0.12, 0.07, 'triangle', 780);
        break;
      case 'wrong-way':
        // two-tone alarm, deliberately abrasive
        for (let i = 0; i < 3; i++) {
          this.blip(dest, i % 2 ? 660 : 880, 0.11, 0.17, 'square', 0, i * 0.16);
        }
        break;
      case 'wrong-way-clear':
        this.blip(dest, 880, 0.14, 0.1, 'triangle', 590);
        break;
      default:
        this.blip(dest, 600, 0.06, 0.11, 'square');
        break;
    }
  }

  // -------------------------------------------------------------------------

  dispose() {
    if (this.audioTimer !== null) window.clearInterval(this.audioTimer);
    this.audioTimer = null;
    try {
      removeEventListener('pointerdown', this.onGesture, true);
      removeEventListener('touchstart', this.onGesture, true);
      removeEventListener('keydown', this.onGesture, true);
      removeEventListener('click', this.onGesture, true);
      removeEventListener('focus', this.onFocus);
      removeEventListener('pageshow', this.onFocus);
      document.removeEventListener('visibilitychange', this.onVisibility);
    } catch {
      /* nothing to do */
    }
    this.unsub?.();
    this.unsub = null;
    this.dropGraph();
    this.button?.remove(); this.button = null;
    this.soundCheck?.dispose(); this.soundCheck = null;
  }
}
