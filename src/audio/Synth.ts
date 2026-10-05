/**
 * ============================================================================
 *  Synth.ts — the entire audio asset pipeline.
 * ============================================================================
 *  Effects and the source composition are built here out of
 *  oscillators, noise buffers, biquads, a tanh waveshaper and a convolver fed
 *  with a procedurally generated impulse response.
 *
 *  Signal flow:
 *
 *      music  ─→ musicDuck  ─┐
 *      sfx  ─────────────────┼→ mix ─→ glue ─→ limiter ─→ trim ─→ safety ─→ master ─→ out
 *      engine ─→ engineDuck ─┤   ↑
 *      lead   ─→ presence ───┘   │
 *                                │
 *      reverbIn ─→ HP ─→ convolver ─→ reverbReturn ─┤
 *      delayIn  ─→ ping-pong delay ─→ delayReturn  ─┘
 *
 *  The two duck gains exist so a boost can pull the engine and the music down
 *  for 150 ms without fighting the levels the engine voices and the sequencer
 *  are writing every frame — the duck owns one param, they own another.
 *
 *  `lead` is the mini-turbo charge's own path. It carries a presence bell at
 *  2.4 kHz and it is never ducked, because the whole point of the tier tone is
 *  that it stays legible on top of a full-throttle engine and a full band.
 *
 *  Nothing writes to `master` except the volume trim, so honouring
 *  Settings.masterVolume is a single param write.
 * ============================================================================
 */

export type NoiseKind = 'white' | 'pink' | 'crackle';

/** exponentialRamp can never reach 0; this is our practical silence. */
export const EPS = 1e-4;

export interface AdsrSpec {
  a: number;
  d: number;
  /** sustain level as a fraction of peak */
  s: number;
  r: number;
}

/** Deterministic PRNG so the generated noise/IR are byte-identical every boot. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** MIDI note number → Hz, A4 = 69 = 440 Hz. */
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Synth {
  readonly ctx: AudioContext;

  /** final trim — tracks Settings.masterVolume, nothing else touches it */
  readonly master: GainNode;
  readonly mix: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly engine: GainNode;
  /** the mini-turbo charge's own path — presence-lifted and never ducked */
  readonly lead: GainNode;
  /** event ducks — scheduled envelopes, written only by Audio.boost() */
  readonly engineDuck: GainNode;
  readonly musicDuck: GainNode;
  /** continuous sidechain — smoothed per frame, written only by Audio.update() */
  readonly engineSide: GainNode;
  readonly musicSide: GainNode;

  /** send inputs — connect a source here through its own gain to feed an fx */
  readonly reverbIn: GainNode;
  readonly delayIn: GainNode;
  /** return level — Audio drives this up inside the tunnel */
  readonly reverbReturn: GainNode;

  private readonly noiseBuf: Record<NoiseKind, AudioBuffer>;
  private readonly curves = new Map<number, Float32Array<ArrayBuffer>>();
  private voices = 0;
  private readonly voiceCap: number;

  /**
   * @param external an already-constructed context to build into. The game
   *   never passes one. It exists so a harness can render this exact graph into
   *   an OfflineAudioContext and measure it — every level, duck depth and tier
   *   frequency quoted in the comments here and in Audio.ts came from such a
   *   render, not from listening. An offline context implements every factory
   *   used below.
   */
  constructor(volume: number, external?: BaseAudioContext) {
    // An offline score schedules its whole duration before rendering. Future
    // notes must not consume a realtime one-shot limit and truncate the track.
    this.voiceCap = external && 'startRendering' in external ? Infinity : 64;
    const AC: typeof AudioContext =
      (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    this.ctx = (external ?? new AC({ latencyHint: 0.1 })) as AudioContext;
    const ac = this.ctx;

    this.master = ac.createGain();
    this.master.gain.value = clamp(volume, 0, 1);
    this.master.connect(ac.destination);

    // Three-stage output. DynamicsCompressor is a compressor, not a brickwall:
    // measured against a real render it holds RMS but lets ~10 dB of crest
    // through, so the chain is (glue → limiter → trim → safety clipper). The
    // trim moves the whole mix into headroom and the clipper is a curve that is
    // exactly unity below 0.86 and asymptotes to 1 above it — inaudible in
    // normal play, mathematically incapable of clipping the DAC.
    const safety = ac.createWaveShaper();
    safety.curve = this.safetyCurve(0.86);
    // Oversampling dozens of simultaneous realtime engine/effect shapers
    // can miss the device deadline when the GPU/browser is under load.
    safety.oversample = 'startRendering' in ac ? '4x' : 'none';
    safety.connect(this.master);

    // `mix` came down 1.9 dB and this went up 1.0, so the compressors see 1.9 dB
    // less and the output only loses 0.9. The old staging drove the race mix
    // hard into the limiter, and a signal added on top of a pinned limiter does
    // not get louder — it just pushes everything already there down, which is
    // the opposite of what a tier tone needs to do. Measured at the new staging
    // the full pile-up peaks at 0.86 with zero samples over full scale.
    const trim = ac.createGain();
    trim.gain.value = 0.62;
    trim.connect(safety);

    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -1.2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.09;
    limiter.connect(trim);

    // Deliberately gentle and set high. An earlier, harder setting pinned the
    // whole mix to one level: adding a tyre squeal on top of the engine moved
    // the output by 2 dB and ducked everything else by 3, which is exactly the
    // pumping that makes a racing mix feel dead. This only catches real peaks.
    //
    // Softened again this round. A bus compressor does not only squash things
    // that get louder, it *fills in* things that get quieter: it releases into
    // any hole a duck makes, which works directly against the boost duck and
    // the charge sidechain. Measured, this setting is worth about 0.5 dB of duck
    // depth on its own — the large offender was the reverb send (see Audio.ts),
    // not this — but a racing mix wants the transients anyway.
    const glue = ac.createDynamicsCompressor();
    glue.threshold.value = -4;
    glue.knee.value = 6;
    glue.ratio.value = 1.8;
    glue.attack.value = 0.012;
    glue.release.value = 0.16;
    glue.connect(limiter);

    this.mix = ac.createGain();
    this.mix.gain.value = 0.74;
    this.mix.connect(glue);

    // Two gains in series per bus, not one. The event duck is a fully scheduled
    // envelope that calls cancelScheduledValues, and the sidechain is rewritten
    // every frame with setTargetAtTime — put them on the same AudioParam and
    // each frame's write erases the boost duck that is mid-flight.
    this.musicSide = ac.createGain();
    this.musicSide.gain.value = 1;
    this.musicSide.connect(this.mix);

    this.musicDuck = ac.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.musicSide);

    this.music = ac.createGain();
    this.music.gain.value = 0.38;
    this.music.connect(this.musicDuck);

    this.sfx = ac.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.mix);

    this.engineSide = ac.createGain();
    this.engineSide.gain.value = 1;
    this.engineSide.connect(this.mix);

    this.engineDuck = ac.createGain();
    this.engineDuck.gain.value = 1;
    this.engineDuck.connect(this.engineSide);

    this.engine = ac.createGain();
    this.engine.gain.value = 0.62;
    this.engine.connect(this.engineDuck);

    // The charge tone's own path. The presence bell is not decoration: the
    // engine's energy is almost all below 1.5 kHz and the music's lead sits at
    // 700–1600, so a few dB at 2.4 k is where a tier tone can be heard without
    // being loud. Measured against a full-throttle engine, this bought ~4 dB of
    // separation for +1.5 dB of level.
    const presence = ac.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2400;
    presence.Q.value = 0.7;
    presence.gain.value = 6;
    presence.connect(this.mix);
    this.lead = ac.createGain();
    this.lead.gain.value = 1;
    this.lead.connect(presence);

    // --- reverb -----------------------------------------------------------
    const conv = ac.createConvolver();
    conv.normalize = false;
    // Music already contains its full baked ambience. A shorter room is
    // sufficient for realtime effects and avoids a long convolution here.
    conv.buffer = this.makeImpulseResponse('startRendering' in ac ? 2.35 : 0.65, 2.6, 0.62);
    // High-passing the send keeps engine rumble out of the tail; without this
    // the reverb turns to mud the moment the player is at full throttle.
    const sendHP = ac.createBiquadFilter();
    sendHP.type = 'highpass';
    sendHP.frequency.value = 260;
    this.reverbIn = ac.createGain();
    this.reverbIn.gain.value = 1;
    this.reverbIn.connect(sendHP);
    sendHP.connect(conv);
    this.reverbReturn = ac.createGain();
    this.reverbReturn.gain.value = 0.5;
    conv.connect(this.reverbReturn);
    this.reverbReturn.connect(this.mix);

    // --- ping-pong delay --------------------------------------------------
    this.delayIn = ac.createGain();
    this.delayIn.gain.value = 1;
    const dL = ac.createDelay(1.2);
    const dR = ac.createDelay(1.2);
    dL.delayTime.value = 0.3;
    dR.delayTime.value = 0.45;
    const fbL = ac.createGain();
    const fbR = ac.createGain();
    fbL.gain.value = 0.34;
    fbR.gain.value = 0.34;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;
    const panL = ac.createStereoPanner();
    const panR = ac.createStereoPanner();
    panL.pan.value = -0.75;
    panR.pan.value = 0.75;
    const delayReturn = ac.createGain();
    delayReturn.gain.value = 0.5;
    this.delayIn.connect(dL);
    dL.connect(panL);
    dR.connect(panR);
    panL.connect(delayReturn);
    panR.connect(delayReturn);
    dL.connect(damp);
    damp.connect(fbR);
    fbR.connect(dR);
    dR.connect(fbL);
    fbL.connect(dL);
    delayReturn.connect(this.mix);

    this.noiseBuf = {
      white: this.makeNoise('white', 2.0, 0x1a2b3c),
      pink: this.makeNoise('pink', 2.7, 0x5eed01),
      crackle: this.makeNoise('crackle', 3.1, 0xc0ffee),
    };
  }

  get now() {
    return this.ctx.currentTime;
  }

  setMasterVolume(v: number) {
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(clamp(v, 0, 1), t, 0.04);
  }

  // -------------------------------------------------------------------------
  // Buffer generation
  // -------------------------------------------------------------------------

  /**
   * Stereo noise. The two channels are decorrelated, which is what makes wind
   * and tyre hiss sit *around* the listener instead of as a point in the middle.
   * 'crackle' is a sparse pop train — it is the whole basis of the overrun
   * burble and of gravel scatter.
   */
  private makeNoise(kind: NoiseKind, seconds: number, seed: number): AudioBuffer {
    const ac = this.ctx;
    const sr = ac.sampleRate;
    const n = Math.floor(sr * seconds);
    // The loop join is made seamless by generating `fade` extra samples and
    // crossfading the head against them: the last output sample and the first
    // are then adjacent samples of one continuous process, so there is no step
    // at the join. 90 ms is long enough that pink noise's low-frequency content
    // fades rather than thumps.
    const fade = Math.floor(sr * 0.09);
    const len = n - fade;
    const buf = ac.createBuffer(2, len, sr);
    const raw = new Float32Array(n);
    for (let c = 0; c < 2; c++) {
      const d = raw;
      const rnd = mulberry32(seed + c * 7919);
      if (kind === 'white') {
        for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
      } else if (kind === 'pink') {
        // Paul Kellet's refined pink filter — cheap and flat enough to 20 kHz.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < n; i++) {
          const w = rnd() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
          b6 = w * 0.115926;
        }
      } else {
        // Sparse decaying impulses over a very low noise floor.
        d.fill(0);
        let i = 0;
        while (i < n) {
          i += Math.floor(rnd() * sr * 0.05) + 24;
          if (i >= n) break;
          const amp = 0.35 + rnd() * 0.65;
          const len = 40 + Math.floor(rnd() * 260);
          const sign = rnd() < 0.5 ? -1 : 1;
          const f = 400 + rnd() * 2600;
          for (let j = 0; j < len && i + j < n; j++) {
            const t = j / len;
            d[i + j] += sign * amp * Math.exp(-t * 7) * Math.sin((2 * Math.PI * f * j) / sr);
          }
        }
        for (let j = 0; j < n; j++) d[j] += (rnd() * 2 - 1) * 0.02;
      }
      // The pink filter leaves a DC offset and can overshoot full scale. DC
      // through the engine's waveshaper biases the whole tanh curve, so strip
      // it and normalise before anything downstream sees it.
      let mean = 0;
      for (let i = 0; i < n; i++) mean += d[i];
      mean /= n;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        d[i] -= mean;
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
      if (peak > 0) {
        const norm = 0.92 / peak;
        for (let i = 0; i < n; i++) d[i] *= norm;
      }

      const out = buf.getChannelData(c);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        out[i] = d[i] * k + d[len + i] * (1 - k);
      }
      for (let i = fade; i < len; i++) out[i] = d[i];
    }
    return buf;
  }

  /**
   * A plate-ish impulse response: a handful of early reflections in front of an
   * exponentially decaying, progressively darkening diffuse tail.
   */
  makeImpulseResponse(seconds: number, decay: number, brightness: number): AudioBuffer {
    const ac = this.ctx;
    const sr = ac.sampleRate;
    const n = Math.max(1, Math.floor(sr * seconds));
    const buf = ac.createBuffer(2, n, sr);
    const early = [0.011, 0.019, 0.026, 0.037, 0.049, 0.063, 0.081];
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rnd = mulberry32(0xbeef + c * 104729);
      const pre = Math.floor(sr * 0.008);
      let lp = 0;
      let peak = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / (n - pre);
        const amp = Math.pow(1 - t, decay) * (1 - Math.exp(-t * 90));
        const raw = (rnd() * 2 - 1) * amp;
        // one-pole whose cutoff falls with time → the tail darkens naturally
        const k = brightness * (1 - t * 0.85) + 0.03;
        lp += (raw - lp) * k;
        d[i] = lp;
        const a = Math.abs(lp);
        if (a > peak) peak = a;
      }
      for (let e = 0; e < early.length; e++) {
        const idx = Math.floor((early[e] + (c ? 0.0031 : 0)) * sr);
        if (idx < n) d[idx] += (e % 2 ? -1 : 1) * (0.55 - e * 0.06) * (0.8 + rnd() * 0.4);
      }
      const norm = peak > 0 ? 0.62 / peak : 1;
      for (let i = 0; i < n; i++) d[i] *= norm;
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // Node factories
  // -------------------------------------------------------------------------

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  osc(type: OscillatorType, freq: number, detuneCents = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detuneCents) o.detune.value = detuneCents;
    return o;
  }

  biquad(type: BiquadFilterType, freq: number, q = 1, gainDb = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  /** Looping noise source. `rate` detunes the buffer, which shifts its colour. */
  noise(kind: NoiseKind, loop = true, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf[kind];
    s.loop = loop;
    if (rate !== 1) s.playbackRate.value = rate;
    return s;
  }

  /** tanh soft-clip. Drive it by changing the gain *into* it, not the curve. */
  shaper(k: number): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = this.curve(k);
    w.oversample = 'startRendering' in this.ctx ? '2x' : 'none';
    return w;
  }

  /** Unity below `th`, soft-saturating to exactly ±1 above it. */
  private safetyCurve(th: number): Float32Array<ArrayBuffer> {
    const n = 4096;
    const c = new Float32Array(n);
    const head = 1 - th;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      const a = Math.abs(x);
      const y = a <= th ? a : th + head * Math.tanh((a - th) / head);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }

  private curve(k: number): Float32Array<ArrayBuffer> {
    const key = Math.round(k * 4);
    let c = this.curves.get(key);
    if (!c) {
      const n = 2048;
      c = new Float32Array(n);
      const kk = Math.max(0.5, key / 4);
      const norm = Math.tanh(kk);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        c[i] = Math.tanh(kk * x) / norm;
      }
      this.curves.set(key, c);
    }
    return c;
  }

  panner(model: PanningModelType = 'HRTF'): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = model;
    p.distanceModel = 'inverse';
    p.refDistance = 7;
    p.maxDistance = 320;
    p.rolloffFactor = 1.15;
    return p;
  }

  /** Feed `src` into a send bus at `amount`; returns the send gain. */
  send(src: AudioNode, bus: AudioNode, amount: number): GainNode {
    const g = this.gain(amount);
    src.connect(g);
    g.connect(bus);
    return g;
  }

  // -------------------------------------------------------------------------
  // Param helpers
  // -------------------------------------------------------------------------

  /** Percussive envelope: near-instant attack, exponential fall to silence. */
  perc(p: AudioParam, t0: number, peak: number, attack: number, decay: number) {
    const v = Math.max(peak, EPS * 2);
    p.cancelScheduledValues(t0);
    p.setValueAtTime(EPS, t0);
    p.exponentialRampToValueAtTime(v, t0 + Math.max(attack, 0.0005));
    p.exponentialRampToValueAtTime(EPS, t0 + attack + decay);
  }

  /** Full ADSR held for `dur` seconds from `t0`. Returns the end time. */
  adsr(p: AudioParam, t0: number, peak: number, dur: number, e: AdsrSpec): number {
    const v = Math.max(peak, EPS * 2);
    p.cancelScheduledValues(t0);
    p.setValueAtTime(EPS, t0);
    p.exponentialRampToValueAtTime(v, t0 + e.a);
    p.exponentialRampToValueAtTime(Math.max(v * e.s, EPS * 2), t0 + e.a + e.d);
    const rel = t0 + Math.max(dur, e.a + e.d);
    p.setValueAtTime(Math.max(v * e.s, EPS * 2), rel);
    p.exponentialRampToValueAtTime(EPS, rel + e.r);
    return rel + e.r;
  }

  /** Linear glide toward a value — the workhorse for continuous voices. */
  glide(p: AudioParam, v: number, tau = 0.04, t = this.ctx.currentTime) {
    p.setTargetAtTime(v, t, tau);
  }

  /**
   * A duck-and-return envelope, fully scheduled up front so it cannot be
   * disturbed by whatever the per-frame code writes to *other* params.
   *
   *   1 → `depth` in `fall` → hold → `over` (overshoot) → 1
   *
   * The overshoot is the important part. A duck that returns to unity sounds
   * like a mistake being corrected; a duck that comes back *past* unity and
   * settles reads as the thing that was ducked surging back under load, which
   * is exactly what an engine does when a boost lets go.
   */
  duck(
    p: AudioParam,
    t0: number,
    depth: number,
    hold: number,
    over: number,
    recover: number,
    fall = 0.018,
  ) {
    const d = Math.max(depth, EPS);
    p.cancelScheduledValues(t0);
    p.setValueAtTime(Math.max(p.value, EPS), t0);
    p.exponentialRampToValueAtTime(d, t0 + fall);
    p.setValueAtTime(d, t0 + fall + hold);
    p.exponentialRampToValueAtTime(Math.max(over, EPS), t0 + fall + hold + recover * 0.45);
    p.exponentialRampToValueAtTime(1, t0 + fall + hold + recover);
  }

  // -------------------------------------------------------------------------
  // Voice lifecycle
  // -------------------------------------------------------------------------

  /** True when we are at the polyphony cap and a new one-shot should be dropped. */
  get busy() {
    return this.voices >= this.voiceCap;
  }

  /**
   * Tear the chain down when `src` ends. One-shots are event-driven (never
   * per-frame) so the closure allocation here is not in any hot path.
   */
  retire(src: AudioScheduledSourceNode, ...nodes: AudioNode[]) {
    this.voices++;
    src.onended = () => {
      this.voices--;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch {
          /* already gone */
        }
      }
    };
  }

  dispose() {
    try {
      void this.ctx.close().catch(() => {});
    } catch {
      /* nothing to do */
    }
  }
}
