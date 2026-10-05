/**
 * ============================================================================
 *  Frame-integrity watchdog.  Enable with ?debug=frames
 * ============================================================================
 *  The player reports intermittent "black partial renders" on desktop Chrome
 *  that no headless capture reproduces — 50 back-to-back screenshots came back
 *  clean, and every layer agreed on its size. An artifact that only exists on
 *  the live present path cannot be debugged from the outside, so this measures
 *  it from the inside, against the real drawing buffer, on the machine that
 *  actually shows it.
 *
 *  It is off unless asked for. `readPixels` forces a GPU sync, which is exactly
 *  the stall we spend the rest of the codebase avoiding, so this reads ONE row
 *  — a single call per sampled frame — and only every Nth frame.
 *
 *  A tear shows up as a long run of near-black along that row. The row is at
 *  55% height, which crosses road, karts and scenery in every camera pose, so a
 *  legitimately dark frame is unlikely and a large black band is unmissable.
 *
 *  On a hit it records the canvas and composer dimensions alongside, because
 *  the leading theory is a size disagreement, and prints a compact report to the
 *  console. `window.__frameWatch` holds the record for copy-paste.
 * ============================================================================
 */
import type { Ctx } from '../types';

export interface TearRecord {
  frame: number;
  t: number;
  /** longest unbroken run of near-black pixels along the sampled row */
  runPx: number;
  runFrac: number;
  startX: number;
  bufW: number;
  bufH: number;
  cssW: number;
  cssH: number;
  composer: string;
  pixelRatio: number;
}

const SAMPLE_EVERY = 3;
const DARK = 6;
/** a run longer than this fraction of the row is a tear, not scene content */
const TEAR_FRAC = 0.12;

export class FrameWatch {
  enabled = false;
  readonly tears: TearRecord[] = [];
  private row: Uint8Array | null = null;
  private rowW = 0;
  private frames = 0;
  private reported = 0;

  init(_ctx: Ctx) {
    // ALWAYS publish the handle, even when sampling is off. Gating the global on
    // the flag means a player who forgets ?debug=frames gets
    // "__frameWatch is not defined" — an error about the debugging tool rather
    // than any information about the bug.
    (window as any).__frameWatch = this;
    if (new URLSearchParams(location.search).get('debug') === 'frames') this.start();
    else {
      console.info(
        '%c[frame-watch] available but idle. Run __frameWatch.start() to begin sampling ' +
        '(no reload needed), then __frameWatch.report() after you see a black flash.',
        'color:#8ab4ff',
      );
    }
  }

  /**
   * Begin sampling.
   *
   * Refuses unless the context was created with `preserveDrawingBuffer`, which
   * only `?debug=frames` does. Without it `readPixels` on the default
   * framebuffer returns discarded contents — measured as a solid run of zeros
   * on a frame that presented perfectly — and every reading is a false
   * positive. This tool existed for one round in that state and produced a
   * console full of confident nonsense.
   */
  start(ctx?: Ctx) {
    const c = ctx ?? (window as any).__ctx as Ctx | undefined;
    const attrs = c?.renderer?.getContext?.()?.getContextAttributes?.();
    if (attrs && attrs.preserveDrawingBuffer !== true) {
      console.error(
        '[frame-watch] cannot sample: the WebGL context was created without ' +
        'preserveDrawingBuffer, so reads of the presented frame are garbage. ' +
        'Reload with ?debug=frames',
      );
      return 'unavailable — reload with ?debug=frames';
    }
    this.enabled = true;
    this.tears.length = 0;
    this.reported = 0;
    console.info(
      '%c[frame-watch] ON — sampling the drawing buffer for partial-black presents.\n' +
      'Play until you see a black flash, then run: __frameWatch.report()',
      'color:#ffb020;font-weight:bold',
    );
    return 'sampling';
  }

  stop() {
    this.enabled = false;
    return 'stopped';
  }

  /**
   * Prints a summary and returns the raw records. Copy the JSON with
   * `copy(__frameWatch.report())` — the return value is the string, so `copy`
   * puts something useful on the clipboard rather than "[object Object]".
   */
  report(): string {
    if (!this.enabled && this.tears.length === 0) {
      console.warn('[frame-watch] never started — run __frameWatch.start() first.');
      return '[]';
    }
    console.info(
      `[frame-watch] ${this.tears.length} partial-black frame(s) out of ${this.frames} sampled ` +
      `(every ${SAMPLE_EVERY}th frame).`,
    );
    if (this.tears.length) console.table(this.tears.slice(-25));
    return JSON.stringify(this.tears);
  }

  /** Called immediately after the present, once the frame is on the buffer. */
  afterPresent(ctx: Ctx) {
    if (!this.enabled) return;
    if (++this.frames % SAMPLE_EVERY !== 0) return;

    const canvas = ctx.renderer.domElement;
    const w = canvas.width, h = canvas.height;
    if (w < 8 || h < 8) {
      // A degenerate buffer IS the bug; record it without trying to read it.
      this.record(ctx, { runPx: w, runFrac: 1, startX: 0 });
      return;
    }

    const gl = ctx.renderer.getContext();
    if (gl.isContextLost()) return;
    if (!this.row || this.rowW !== w) {
      this.row = new Uint8Array(w * 4);
      this.rowW = w;
    }
    const row = this.row;
    // Bind the default framebuffer explicitly: whatever the last pass left bound
    // is not necessarily what the user is looking at.
    ctx.renderer.setRenderTarget(null);
    gl.readPixels(0, Math.floor(h * 0.55), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);

    let run = 0, best = 0, start = -1, bestStart = -1;
    for (let x = 0; x < w; x++) {
      const l = (row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2]) / 3;
      if (l <= DARK) {
        if (run === 0) start = x;
        run++;
        if (run > best) { best = run; bestStart = start; }
      } else run = 0;
    }
    if (best > w * TEAR_FRAC) {
      this.record(ctx, { runPx: best, runFrac: best / w, startX: bestStart });
    }
  }

  private record(ctx: Ctx, hit: { runPx: number; runFrac: number; startX: number }) {
    const canvas = ctx.renderer.domElement;
    const pipe = (globalThis as any).__render;
    const rt = pipe?.composer?.inputBuffer;
    const rec: TearRecord = {
      frame: ctx.frame,
      t: +ctx.time.toFixed(2),
      runPx: hit.runPx,
      runFrac: +hit.runFrac.toFixed(3),
      startX: hit.startX,
      bufW: canvas.width,
      bufH: canvas.height,
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      composer: rt ? `${rt.width}x${rt.height}` : '(none)',
      pixelRatio: ctx.renderer.getPixelRatio(),
    };
    this.tears.push(rec);
    // Cap, so a permanently black frame does not fill memory with evidence of
    // itself.
    if (this.tears.length > 200) this.tears.shift();
    if (this.reported++ < 20) {
      console.warn(
        `[frame-watch] partial-black frame ${rec.frame} @${rec.t}s — ` +
        `${(rec.runFrac * 100).toFixed(0)}% of the row from x=${rec.startX}; ` +
        `buffer ${rec.bufW}x${rec.bufH}, css ${rec.cssW}x${rec.cssH}, ` +
        `composer ${rec.composer}, dpr ${rec.pixelRatio}`,
      );
    }
  }
}
