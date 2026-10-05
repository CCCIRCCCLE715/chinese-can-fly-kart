/**
 * ============================================================================
 *  Music.ts — the race track (the other kind).
 * ============================================================================
 *  An 8-bar loop in A major at 132 BPM: bass, pad, 16th arpeggio, mallet lead
 *  and a four-on-the-floor kit. Everything is sequenced against the
 *  AudioContext clock with a 150 ms lookahead window pumped from the render
 *  loop — timers are far too jittery to hold a groove.
 *
 *  Two arrangements: a thin one for the countdown / results (pad + arp + shaker)
 *  and the full band for the race. Transitions land on a bar line so they never
 *  sound like a switch being flipped. The final lap lifts the tempo ~7% and
 *  opens the hats.
 * ============================================================================
 */
import { Synth, mtof, EPS } from '../src/audio/Synth';

const STEPS_PER_BAR = 16;
const BARS = 8;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;
const LOOKAHEAD = 0.15;
const BASE_BPM = 132;

/**
 * I – V – vi – IV – I – V – IV – V in A major, voiced close so the pad glides
 * between chords instead of leaping.
 */
const PAD_VOICINGS: readonly number[][] = [
  [57, 61, 64, 69], // A
  [56, 59, 64, 68], // E
  [57, 61, 66, 69], // F#m
  [57, 62, 66, 69], // D
  [57, 61, 64, 69], // A
  [56, 59, 64, 68], // E
  [57, 62, 66, 69], // D
  [56, 59, 64, 68], // E
];
/** Bass roots, two octaves below the pad. */
const ROOTS = [45, 40, 42, 38, 45, 40, 38, 40];
/** Arp source tones per bar — chord tones from the root up. */
const ARP_TONES: readonly number[][] = [
  [69, 73, 76, 81],
  [64, 68, 71, 76],
  [66, 69, 73, 78],
  [62, 66, 69, 74],
  [69, 73, 76, 81],
  [64, 68, 71, 76],
  [62, 66, 69, 74],
  [64, 68, 71, 76],
];
/** up-down-up contour over four chord tones */
const ARP_ORDER = [0, 1, 2, 3, 2, 3, 1, 2];

/** [step, offset-from-root, velocity] */
const BASS_PATTERN: readonly [number, number, number][] = [
  [0, 0, 1.0],
  [3, 0, 0.7],
  [6, 12, 0.75],
  [8, 0, 0.95],
  [11, 7, 0.7],
  [14, 12, 0.8],
];

/** [step, midi, 16th-note duration] — a singable top line, one entry per bar. */
const LEAD: readonly (readonly [number, number, number][])[] = [
  [[0, 81, 3], [4, 78, 2], [6, 76, 2], [8, 73, 4], [12, 76, 3]],
  [[0, 78, 3], [4, 80, 2], [6, 78, 2], [8, 76, 6]],
  [[0, 73, 4], [4, 76, 3], [8, 78, 6], [14, 76, 2]],
  [[0, 74, 3], [4, 78, 3], [8, 81, 5], [13, 78, 2]],
  [[0, 76, 2], [2, 78, 2], [4, 81, 4], [10, 78, 2], [12, 76, 3]],
  [[0, 80, 3], [4, 83, 3], [8, 80, 4], [12, 76, 3]],
  [[0, 81, 3], [4, 78, 2], [6, 76, 2], [8, 74, 6]],
  [[0, 76, 2], [2, 78, 2], [4, 80, 2], [6, 83, 2], [8, 83, 6]],
];

const KICK = [0, 4, 8, 12];
const SNARE = [4, 12];
const HAT_ACCENT = [0, 4, 8, 12];

export class MusicScore {
  private readonly s: Synth;

  private readonly out: GainNode;
  private readonly padG: GainNode;
  private readonly arpG: GainNode;
  private readonly bassG: GainNode;
  private readonly drumG: GainNode;
  private readonly leadG: GainNode;

  private step = 0;
  private nextTime = 0;
  private bpm = BASE_BPM;
  private bpmTarget = BASE_BPM;
  private running = false;

  /** applied on the next bar line so arrangement changes stay musical */
  private wantFull = false;
  private isFull = false;
  private finalLap = false;
  private ducked = false;

  constructor(s: Synth) {
    this.s = s;
    this.out = s.gain(1);
    this.out.connect(s.music);

    this.padG = s.gain(0.5);
    this.arpG = s.gain(0.34);
    this.bassG = s.gain(0.0);
    this.drumG = s.gain(0.0);
    this.leadG = s.gain(0.0);
    for (const g of [this.padG, this.arpG, this.bassG, this.drumG, this.leadG]) g.connect(this.out);

    // Pad and arp live in the reverb; the rhythm section stays dry and forward.
    s.send(this.padG, s.reverbIn, 0.55);
    s.send(this.arpG, s.delayIn, 0.3);
    s.send(this.arpG, s.reverbIn, 0.16);
    s.send(this.leadG, s.delayIn, 0.22);
    s.send(this.leadG, s.reverbIn, 0.2);
    s.send(this.drumG, s.reverbIn, 0.06);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.step = 0;
    this.nextTime = this.s.now + 0.12;
    // stop() faded the bus out; restarting has to undo that.
    this.s.glide(this.out.gain, this.ducked ? 0.22 : 1, 0.2);
  }

  stop() {
    this.running = false;
    this.s.glide(this.out.gain, EPS, 0.3);
  }

  /** Full band during the race, thin arrangement everywhere else. */
  setFull(full: boolean) {
    this.wantFull = full;
  }

  setFinalLap(on: boolean) {
    if (this.finalLap === on) return;
    this.finalLap = on;
    this.bpmTarget = BASE_BPM * (on ? 1.075 : 1);
  }

  /** Pull the whole loop back under a pause menu without stopping the clock. */
  setDuck(on: boolean) {
    if (this.ducked === on) return;
    this.ducked = on;
    this.s.glide(this.out.gain, on ? 0.22 : 1, 0.12);
  }

  private get stepDur() {
    return 60 / this.bpm / 4;
  }

  /** Pumped once per frame. Schedules every step that falls inside the window. */
  update() {
    if (!this.running) return;
    const now = this.s.now;
    // A tab stall or a breakpoint leaves nextTime far in the past; jump the
    // sequencer forward rather than dumping a hundred notes at once.
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.02;
    let guard = 48;
    while (this.nextTime < now + LOOKAHEAD && guard-- > 0) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % TOTAL_STEPS;
    }
  }

  /** Offline baking prepares only one bar at a time to bound graph size. */
  prepare(full: boolean, finale: boolean) {
    this.bpm = this.bpmTarget = BASE_BPM * (finale ? 1.075 : 1);
    this.wantFull = full;
    this.isFull = !full;
    this.finalLap = finale;
    return this.stepDur * TOTAL_STEPS;
  }
  renderSteps(from: number, until: number) {
    for (let n = from; n < until; n++) this.scheduleStep(n % TOTAL_STEPS, n * this.stepDur);
  }

  private scheduleStep(step: number, t: number) {
    const bar = (step / STEPS_PER_BAR) | 0;
    const s16 = step % STEPS_PER_BAR;

    if (s16 === 0) {
      // Bar line: settle tempo and commit any arrangement change.
      this.bpm += (this.bpmTarget - this.bpm) * 0.35;
      if (this.wantFull !== this.isFull) {
        this.isFull = this.wantFull;
        const tau = 0.35;
        this.s.glide(this.bassG.gain, this.isFull ? 0.34 : 0.0, tau, t);
        this.s.glide(this.drumG.gain, this.isFull ? 0.4 : 0.0, tau, t);
        this.s.glide(this.leadG.gain, this.isFull ? 0.26 : 0.0, tau, t);
        this.s.glide(this.padG.gain, this.isFull ? 0.34 : 0.5, tau, t);
        this.s.glide(this.arpG.gain, this.isFull ? 0.34 : 0.2, tau, t);
      }
      this.pad(t, PAD_VOICINGS[bar], this.stepDur * STEPS_PER_BAR);
      if (this.isFull && bar === 0) this.cymbal(t);
    }

    const full = this.isFull;

    // --- arpeggio: dense 16ths when racing, a sparse pulse when not ---------
    const tones = ARP_TONES[bar];
    if (full || s16 % 4 === 0) {
      const idx = ARP_ORDER[s16 % ARP_ORDER.length];
      const oct = s16 >= 8 ? 12 : 0;
      this.arp(t, tones[idx] + oct, full ? 0.11 : 0.2);
    }

    if (!full) {
      if (s16 % 2 === 1) this.shaker(t, 0.06);
      return;
    }

    // --- rhythm section ----------------------------------------------------
    for (let i = 0; i < BASS_PATTERN.length; i++) {
      const [bs, off, vel] = BASS_PATTERN[i];
      if (bs === s16) this.bass(t, ROOTS[bar] + off, vel, this.stepDur * 2.2);
    }
    // Diatonic walk-up out of the V chord: E – F# – G# – (A at the loop point).
    if (bar === 7 && (s16 === 12 || s16 === 14)) {
      this.bass(t, ROOTS[bar] + (s16 === 12 ? 2 : 4), 0.7, this.stepDur * 1.4);
    }

    const leadBar = LEAD[bar];
    for (let i = 0; i < leadBar.length; i++) {
      const [ls, note, dur] = leadBar[i];
      // Final lap takes the melody up an octave; back the level off so the
      // brighter register does not become shrill.
      if (ls === s16) {
        this.lead(t, note + (this.finalLap ? 12 : 0), dur * this.stepDur, this.finalLap ? 0.34 : 0.5);
      }
    }

    if (KICK.indexOf(s16) >= 0) this.kick(t, 1);
    else if (s16 === 14) this.kick(t, 0.45);
    if (SNARE.indexOf(s16) >= 0) this.snare(t, 0.9);
    if (s16 % 2 === 0) this.hat(t, HAT_ACCENT.indexOf(s16) >= 0 ? 0.34 : 0.2, false);
    else if (this.finalLap) this.hat(t, 0.12, false);
    if (s16 === 14 || (this.finalLap && s16 === 6)) this.hat(t, 0.26, true);
    if (s16 % 2 === 1) this.shaker(t, 0.08);
  }

  // -------------------------------------------------------------------------
  // Instruments
  // -------------------------------------------------------------------------

  private pad(t: number, notes: readonly number[], dur: number) {
    const s = this.s;
    if (s.busy) return;
    for (let i = 0; i < notes.length; i++) {
      const f = mtof(notes[i]);
      const g = s.gain(EPS);
      const lp = s.biquad('lowpass', 700, 0.9);
      lp.connect(g);
      g.connect(this.padG);
      // Slow filter swell across the bar gives the pad movement without an LFO.
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.55);
      lp.frequency.linearRampToValueAtTime(900, t + dur);
      const end = s.adsr(g.gain, t, 0.24 / notes.length + 0.06, dur * 0.92, {
        a: 0.32,
        d: 0.5,
        s: 0.75,
        r: 0.85,
      });
      const a = s.osc('sawtooth', f, -7);
      const b = s.osc('sawtooth', f, 8);
      const c = s.osc('triangle', f * 2, 0);
      const cg = s.gain(0.3);
      a.connect(lp);
      b.connect(lp);
      c.connect(cg);
      cg.connect(lp);
      a.start(t);
      b.start(t);
      c.start(t);
      a.stop(end);
      b.stop(end);
      c.stop(end);
      s.retire(a, lp, g, cg);
      s.retire(b);
      s.retire(c);
    }
  }

  private arp(t: number, note: number, decay: number) {
    const s = this.s;
    if (s.busy) return;
    const f = mtof(note);
    const g = s.gain(EPS);
    const lp = s.biquad('lowpass', 3200, 3);
    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + decay + 0.05);
    lp.connect(g);
    g.connect(this.arpG);
    s.perc(g.gain, t, 0.5, 0.004, decay);
    const a = s.osc('triangle', f);
    const b = s.osc('square', f, 6);
    const bg = s.gain(0.22);
    a.connect(lp);
    b.connect(bg);
    bg.connect(lp);
    const end = t + decay + 0.09;
    a.start(t);
    b.start(t);
    a.stop(end);
    b.stop(end);
    s.retire(a, lp, g, bg);
    s.retire(b);
  }

  private bass(t: number, note: number, vel: number, dur: number) {
    const s = this.s;
    if (s.busy) return;
    const f = mtof(note);
    const g = s.gain(EPS);
    const drive = s.shaper(2.2);
    const lp = s.biquad('lowpass', 220, 6);
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + dur * 0.8);
    drive.connect(lp);
    lp.connect(g);
    g.connect(this.bassG);
    const end = s.adsr(g.gain, t, vel * 0.9, dur, { a: 0.006, d: 0.1, s: 0.55, r: 0.07 });
    const a = s.osc('sawtooth', f);
    const b = s.osc('square', f, -9);
    const bg = s.gain(0.5);
    const sub = s.osc('sine', f * 0.5);
    const sg = s.gain(0.7);
    a.connect(drive);
    b.connect(bg);
    bg.connect(drive);
    sub.connect(sg);
    sg.connect(g);
    a.start(t);
    b.start(t);
    sub.start(t);
    a.stop(end);
    b.stop(end);
    sub.stop(end);
    s.retire(a, drive, lp, g, bg, sg);
    s.retire(b);
    s.retire(sub);
  }

  /** Two-operator FM mallet — bright attack, quick settle into a sine. */
  private lead(t: number, note: number, dur: number, vel: number) {
    const s = this.s;
    if (s.busy) return;
    const f = mtof(note);
    const g = s.gain(EPS);
    g.connect(this.leadG);
    const car = s.osc('sine', f);
    const mod = s.osc('sine', f * 2.01);
    const idx = s.gain(f * 3.2);
    mod.connect(idx);
    idx.connect(car.frequency);
    idx.gain.setValueAtTime(f * 3.2, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.12, t + 0.22);
    const body = s.osc('triangle', f);
    const bg = s.gain(0.3);
    body.connect(bg);
    bg.connect(g);
    car.connect(g);
    const end = s.adsr(g.gain, t, vel, dur, { a: 0.008, d: 0.22, s: 0.5, r: 0.2 });
    car.start(t);
    mod.start(t);
    body.start(t);
    car.stop(end);
    mod.stop(end);
    body.stop(end);
    s.retire(car, g, idx, bg);
    s.retire(mod);
    s.retire(body);
  }

  private kick(t: number, vel: number) {
    const s = this.s;
    const g = s.gain(EPS);
    g.connect(this.drumG);
    const o = s.osc('sine', 132);
    o.frequency.setValueAtTime(138, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.085);
    o.connect(g);
    s.perc(g.gain, t, vel, 0.003, 0.24);
    o.start(t);
    o.stop(t + 0.3);
    s.retire(o, g);
    // beater click
    const n = s.noise('white', false);
    const hp = s.biquad('highpass', 2200, 0.7);
    const ng = s.gain(EPS);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(this.drumG);
    s.perc(ng.gain, t, vel * 0.18, 0.001, 0.016);
    n.start(t, 0.3);
    n.stop(t + 0.03);
    s.retire(n, hp, ng);
  }

  private snare(t: number, vel: number) {
    const s = this.s;
    const n = s.noise('white', false);
    const bp = s.biquad('bandpass', 1900, 0.85);
    const hp = s.biquad('highpass', 380, 0.7);
    const g = s.gain(EPS);
    n.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(this.drumG);
    s.perc(g.gain, t, vel * 0.55, 0.002, 0.15);
    n.start(t, 0.7);
    n.stop(t + 0.22);
    s.retire(n, bp, hp, g);
    // two detuned bodies give it the shell ring rather than a pure hiss
    for (let i = 0; i < 2; i++) {
      const o = s.osc('triangle', i ? 254 : 186);
      const og = s.gain(EPS);
      o.connect(og);
      og.connect(this.drumG);
      s.perc(og.gain, t, vel * 0.22, 0.002, 0.07);
      o.start(t);
      o.stop(t + 0.12);
      s.retire(o, og);
    }
  }

  private hat(t: number, vel: number, open: boolean) {
    const s = this.s;
    const n = s.noise('white', false, 1.6);
    const hp = s.biquad('highpass', 6000, 0.8);
    const bp = s.biquad('bandpass', 9000, 1.1);
    const g = s.gain(EPS);
    n.connect(hp);
    hp.connect(bp);
    bp.connect(g);
    g.connect(this.drumG);
    const d = open ? 0.24 : 0.042;
    s.perc(g.gain, t, vel, 0.001, d);
    n.start(t, 0.15);
    n.stop(t + d + 0.06);
    s.retire(n, hp, bp, g);
  }

  private shaker(t: number, vel: number) {
    const s = this.s;
    const n = s.noise('pink', false, 1.9);
    const hp = s.biquad('highpass', 5200, 0.7);
    const g = s.gain(EPS);
    n.connect(hp);
    hp.connect(g);
    g.connect(this.arpG);
    s.perc(g.gain, t, vel, 0.006, 0.055);
    n.start(t, 1.1);
    n.stop(t + 0.1);
    s.retire(n, hp, g);
  }

  private cymbal(t: number) {
    const s = this.s;
    const n = s.noise('white', false, 1.2);
    const hp = s.biquad('highpass', 5200, 0.6);
    const pk = s.biquad('peaking', 8200, 1.2, 6);
    const g = s.gain(EPS);
    n.connect(hp);
    hp.connect(pk);
    pk.connect(g);
    g.connect(this.drumG);
    const send = s.send(g, s.reverbIn, 0.3);
    s.perc(g.gain, t, 0.3, 0.004, 0.9);
    n.start(t, 0.4);
    n.stop(t + 1.0);
    s.retire(n, hp, pk, g, send);
  }
}
