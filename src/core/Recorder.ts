/**
 * ============================================================================
 *  One-key gameplay recorder.
 * ============================================================================
 *  Press R to start, R again to stop; the clip downloads itself.
 *
 *  It records the COMPOSITED TAB via getDisplayMedia, not the WebGL canvas.
 *  That distinction is the whole point: the HUD — lap, position, timer,
 *  speedometer, minimap, item box — is DOM sitting on top of the canvas, so
 *  `canvas.captureStream()` would produce clean footage of a game with no
 *  interface on it. Screen capture is the only route that gets both layers.
 *
 *  getDisplayMedia needs a user gesture, which is exactly what the keypress
 *  provides. It also needs a permission prompt every time — unavoidable, and
 *  the reason this is offered alongside the OS recorder rather than instead
 *  of it.
 * ============================================================================
 */

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private pill: HTMLElement | null = null;
  private startedAt = 0;
  private timer = 0;

  install() {
    addEventListener('keydown', this.onKey);
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    this.stop();
  }

  get recording() {
    return this.rec !== null;
  }

  private onKey = (e: KeyboardEvent) => {
    // Ignore the shortcut while the player is typing somewhere, and never
    // hijack a browser accelerator (Cmd/Ctrl+R is reload).
    if (e.code !== 'KeyR' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    if (this.rec) this.stop();
    else void this.start();
  };

  private async start() {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      this.toast('录屏需要使用电脑上的谷歌或微软浏览器', true);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // `preferCurrentTab` is a Chrome affordance that puts this tab at the
        // top of the picker. Harmless where it is not supported.
        preferCurrentTab: true,
        video: { frameRate: { ideal: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        // Tab audio, so the procedural engine note and music come along.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      } as DisplayMediaStreamOptions);
    } catch {
      // The player dismissed the picker. Not an error worth shouting about.
      return;
    }

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      stream.getTracks().forEach((t) => t.stop());
      this.toast('当前浏览器不支持录屏', true);
      return;
    }

    this.chunks = [];
    this.stream = stream;
    this.rec = new MediaRecorder(stream, {
      mimeType: mime,
      // ~12 Mbit gives clean gradients on the sky and sea, which are the first
      // things to band at the default rate.
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 128_000,
    });

    this.rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.rec.onstop = () => this.save(mime);
    // Stopping the share from Chrome's own "Stop sharing" bar must end the take.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop());

    this.rec.start(1000);
    this.startedAt = performance.now();
    this.showPill();
  }

  private stop() {
    if (!this.rec) return;
    const r = this.rec;
    this.rec = null;
    if (r.state !== 'inactive') r.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    clearInterval(this.timer);
    this.pill?.remove();
    this.pill = null;
  }

  private save(mime: string) {
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `卡丁王者-${stamp()}.webm`;
    a.click();
    // Revoking immediately cancels the download in some builds.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.toast('已保存到下载文件夹');
  }

  private showPill() {
    const el = document.createElement('div');
    el.style.cssText = PILL_CSS;
    el.innerHTML = '<i></i><span>录制中</span><b>0:00</b>';
    (el.querySelector('i') as HTMLElement).style.cssText = DOT_CSS;
    document.body.appendChild(el);
    this.pill = el;

    const b = el.querySelector('b')!;
    this.timer = setInterval(() => {
      const s = Math.floor((performance.now() - this.startedAt) / 1000);
      b.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250) as unknown as number;

    if (!document.getElementById('rec-kf')) {
      const st = document.createElement('style');
      st.id = 'rec-kf';
      st.textContent = '@keyframes recpulse{0%,100%{opacity:1}50%{opacity:.25}}';
      document.head.appendChild(st);
    }
  }

  private toast(msg: string, warn = false) {
    const el = document.createElement('div');
    el.style.cssText = PILL_CSS + (warn ? 'border-color:rgba(255,140,140,.6);' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const PILL_CSS = `
position:fixed; top:calc(env(safe-area-inset-top,0px) + 14px); left:50%;
transform:translateX(-50%); z-index:50; display:flex; align-items:center; gap:9px;
padding:8px 15px; border-radius:999px; pointer-events:none;
background:rgba(10,14,24,.72); border:1.5px solid rgba(255,255,255,.22);
color:#f2f5fa; font:700 13px/1 system-ui,-apple-system,sans-serif; letter-spacing:.09em;
backdrop-filter:blur(8px); box-shadow:0 6px 22px rgba(0,0,0,.45);
`;

const DOT_CSS = `
width:9px; height:9px; border-radius:50%; background:#ff4b4b;
box-shadow:0 0 10px rgba(255,75,75,.9); animation:recpulse 1.1s ease-in-out infinite;
`;
