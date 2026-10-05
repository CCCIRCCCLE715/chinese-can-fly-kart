import type { Synth } from './Synth';
/** An opt-in, visible test panel; absent from the normal game. */
export class SoundCheck {
  private panel: HTMLDivElement;
  private output: HTMLDivElement;
  private synth: Synth | null = null;
  private meters: AnalyserNode[] = [];
  private samples = new Float32Array(1024);
  private at = 0;
  private contexts = 0;
  private samplesCount = 0;
  private quietSince = 0;
  private longestQuiet = 0;
  private startedAt = 0;
  private startedClock = 0;
  constructor() {
    this.panel = document.createElement('div');
    this.panel.setAttribute('aria-label', '声音检查');
    this.panel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:10011;background:#101827ee;color:#fff;padding:15px;border-radius:12px;font:14px system-ui;max-width:90vw';
    this.panel.innerHTML = '<b>声音检查</b><div class="sound-readout">等待开启声音</div><button>模拟声音中断</button><button>模拟声音停止</button>';
    this.output = this.panel.querySelector('.sound-readout')!;
    const buttons = this.panel.querySelectorAll('button');
    buttons[0].onclick = () => { void this.synth?.ctx.suspend().catch(() => {}); };
    buttons[1].onclick = () => { void this.synth?.ctx.close().catch(() => {}); };
    document.body.append(this.panel);
  }
  attach(synth: Synth | null) {
    for (const m of this.meters) m.disconnect();
    this.meters = []; this.synth = synth;
    if (!synth) return;
    this.contexts++; this.samplesCount = 0; this.quietSince = 0; this.longestQuiet = 0;
    this.startedAt = performance.now(); this.startedClock = synth.ctx.currentTime;
    for (const bus of [synth.master, synth.music, synth.sfx, synth.engine]) {
      const meter = synth.ctx.createAnalyser(); meter.fftSize = 1024; bus.connect(meter); this.meters.push(meter);
    }
  }
  update(now: number) {
    if (now - this.at < 250) return;
    this.at = now;
    if (!this.synth) { this.output.textContent = '等待开启声音'; return; }
    const levels = this.meters.map(m => {
      m.getFloatTimeDomainData(this.samples);
      let sum = 0; for (const x of this.samples) sum += x * x;
      return Math.sqrt(sum / this.samples.length);
    });
    this.samplesCount++;
    if (levels[1] < 0.0001) {
      if (!this.quietSince) this.quietSince = now;
      this.longestQuiet = Math.max(this.longestQuiet, now - this.quietSince);
    } else this.quietSince = 0;
    const states: Record<string,string> = {running:'播放中',suspended:'已中断',interrupted:'被系统中断',closed:'已停止'};
    const delay = Math.max(0, (now - this.startedAt) / 1000 - (this.synth.ctx.currentTime - this.startedClock));
    this.output.textContent = `${states[this.synth.ctx.state] ?? '等待恢复'} · 声音时钟 ${this.synth.ctx.currentTime.toFixed(2)} 秒 · 输出 ${levels[0].toFixed(5)} · 音乐 ${levels[1].toFixed(5)} · 音效 ${levels[2].toFixed(5)} · 引擎 ${levels[3].toFixed(5)} · 检查 ${this.samplesCount} 次 · 最长无音乐 ${(this.longestQuiet / 1000).toFixed(2)} 秒 · 时钟落后 ${delay.toFixed(2)} 秒 · 声音启动 ${this.contexts} 次`;
  }
  dispose() { this.attach(null); this.panel.remove(); }
}
