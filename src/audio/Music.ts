/** The original score, baked into seamless loops ahead of gameplay.
 * Buffer sources run on the audio thread: drawing a slow frame or throttling
 * timers cannot starve the music, and music never takes an effects voice slot.
 * Regenerate the three assets with audio-bake.html and tools/audio-score.ts.
 */
import type {Synth} from './Synth';
type Arrangement = 'menu' | 'race' | 'finale';
const arrangements: Arrangement[] = ['menu', 'race', 'finale'];
const encoded = new Map<Arrangement, Promise<ArrayBuffer>>();
function bytes(mode: Arrangement) {
  let pending = encoded.get(mode);
  if (!pending) {
    pending = fetch(`./audio/${mode}.wav`).then(response => {
      if (!response.ok) throw new Error(`Music asset ${mode}: ${response.status}`);
      return response.arrayBuffer();
    }).catch(error => { encoded.delete(mode); throw error; });
    encoded.set(mode, pending);
  }
  return pending;
}
export class Music {
  /** Fetch while the title screen boots; this does not create or unlock audio. */
  static preload() { return Promise.all(arrangements.map(mode => bytes(mode))); }
  private running = false;
  private full = false;
  private finale = false;
  private ducked = false;
  private loading = false;
  private retryAt = 0;
  private generation = 0;
  private active: Arrangement | null = null;
  private voices = new Map<Arrangement, {source: AudioBufferSourceNode; gain: GainNode}>();
  constructor(private readonly s: Synth) {}
  start() {
    if (this.running) return;
    this.running = true;
    this.update();
  }
  stop() {
    this.running = false;
    this.generation++;
    this.loading = false;
    for (const {source, gain} of this.voices.values()) {
      try { source.stop(); } catch {}
      source.disconnect(); gain.disconnect();
    }
    this.voices.clear(); this.active = null;
  }
  setFull(on: boolean) { if (this.full !== on) { this.full = on; this.select(); } }
  setFinalLap(on: boolean) { if (this.finale !== on) { this.finale = on; this.select(); } }
  setDuck(on: boolean) { if (this.ducked !== on) { this.ducked = on; this.select(true); } }
  update() {
    if (this.running && !this.loading && !this.voices.size && performance.now() >= this.retryAt) void this.load();
  }
  private select(force = false) {
    const mode: Arrangement = this.full ? (this.finale ? 'finale' : 'race') : 'menu';
    if (!this.running || !this.voices.size || (!force && mode === this.active)) return;
    this.active = mode;
    const now = this.s.now;
    for (const [name, {gain}] of this.voices) {
      // Preserve the current envelope across quick pause/resume transitions.
      gain.gain.cancelAndHoldAtTime(now);
      gain.gain.setTargetAtTime(name === mode ? (this.ducked ? 0.22 : 1) : 0, now, 0.12);
    }
  }
  private async load() {
    this.loading = true;
    const generation = ++this.generation;
    const created: {source: AudioBufferSourceNode; gain: GainNode}[] = [];
    try {
      const buffers = await Promise.all(arrangements.map(async mode => {
        const data = await bytes(mode);
        return this.s.ctx.decodeAudioData(data.slice(0));
      }));
      if (!this.running || generation !== this.generation || this.s.ctx.state === 'closed') return;
      const startAt = this.s.now + 0.03;
      for (let i = 0; i < arrangements.length; i++) {
        const source = this.s.ctx.createBufferSource();
        const gain = this.s.ctx.createGain();
        created.push({source,gain});
        source.buffer = buffers[i]; source.loop = true;
        gain.gain.value = 0;
        source.connect(gain); gain.connect(this.s.music);
        source.start(startAt);
        this.voices.set(arrangements[i], {source,gain});
      }
      this.select(true);
    } catch (error) {
      for (const {source,gain} of created) { try { source.stop(); } catch {} source.disconnect();gain.disconnect(); }
      if (generation !== this.generation) return;
      this.voices.clear(); this.active = null;
      this.retryAt = performance.now() + 5000;
      console.warn('[music] retrying local score', error);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}
