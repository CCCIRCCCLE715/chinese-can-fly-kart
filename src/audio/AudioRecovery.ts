/** Recover an existing browser audio context without creating one outside a gesture. */
export type RecoverableAudio = {
  readonly state: string;
  readonly currentTime: number;
  resume(): Promise<void>;
  suspend(): Promise<void>;
};
export class AudioRecovery {
  stalled = false;
  private observed: RecoverableAudio | null = null;
  private clock = -1;
  private advancedAt = 0;
  private attemptAt = -Infinity;
  private cycling: RecoverableAudio | null = null;
  constructor(private getContext: () => RecoverableAudio | null, private hidden: () => boolean) {}
  reset() { this.observed = null; this.clock = -1; this.stalled = false; this.attemptAt = -Infinity; this.cycling = null; }
  visibilityChanged() {
    this.reset();
    const ac = this.getContext();
    if (!ac || ac.state === 'closed') return;
    // Changing tabs must not shut down music or the effects bus. The browser
    // may interrupt audio itself; resume that existing context on return.
    if (!this.hidden()) this.resume();
  }
  resume() {
    const ac = this.getContext();
    if (!ac || this.hidden() || ac.state === 'closed') return;
    // Must be called synchronously by the gesture handler, even if a previous
    // browser resume promise has not settled yet.
    try { void ac.resume().catch(() => {}); } catch {}
  }
  tick(now: number) {
    const ac = this.getContext();
    if (!ac || this.hidden() || ac.state === 'closed') return;
    if (ac !== this.observed) { this.observed = ac; this.clock = ac.currentTime; this.advancedAt = now; this.stalled = false; }
    if (ac.currentTime > this.clock + 0.001) { this.clock = ac.currentTime; this.advancedAt = now; this.stalled = false; }
    // Heavy drawing/OS scheduling can delay currentTime observations briefly.
    // Do not interrupt healthy buffered music after a single short stall.
    this.stalled = ac.state === 'running' && now - this.advancedAt > 5000;
    if (now - this.attemptAt < 1000) return;
    if (ac.state !== 'running') { this.attemptAt = now; this.resume(); }
    else if (this.stalled && !this.cycling) {
      this.attemptAt = now; this.cycling = ac;
      try {
        void ac.suspend().then(() => {
          if (this.getContext() === ac && !this.hidden()) this.resume();
        }).catch(() => {}).finally(() => { if (this.cycling === ac) this.cycling = null; });
      } catch { this.cycling = null; }
    }
  }
}
