/**
 * ============================================================================
 *  Self-diagnosis, and the thing that ACTS on it, for "the HUD works but the
 *  world is missing".
 * ============================================================================
 *  Reported by several players on Chromium browsers while the same build runs
 *  fine elsewhere. The screenshot shows a live HUD — timer counting, minimap
 *  drawing, standings updating — over a flat dark page background. So the game
 *  loop is running and only the 3D scene is absent, which is a rendering
 *  failure, not a crash.
 *
 *  WHAT THE OLD WATCHDOG COULD NOT SEE, MEASURED.
 *  ---------------------------------------------------------------------------
 *  This file used to watch one number: draw calls submitted by the scene pass.
 *  Four of the five failure modes were reproduced on real hardware by forcing
 *  the driver to misbehave, and the draw-call count survived ALL of them:
 *
 *     forced failure                     scene draws   frame on screen
 *     none (control)                        234        lit 0.91, luma sd 63.6
 *     draw calls silently dropped           179        canvas never painted
 *     RGBA16F attachment refused            222        canvas never painted
 *     PBR shader family rejected            234        white void, sd 11.1
 *     float extensions withheld             197        91% of pixels below 12
 *
 *  Every one of those is the player's screenshot, and in every one of them the
 *  old watchdog stayed silent, because three counts a draw call whether or not
 *  the GPU rasterises anything. Draw calls are a proxy for the thing we care
 *  about and they are a bad one. So there are now three detectors, and each of
 *  them ACTS rather than merely announcing:
 *
 *  1. **The presented image itself.** Two strips of the finished frame are read
 *     back — inside the same task that drew it, before the compositor takes the
 *     surface, which is the only moment the default framebuffer can be read
 *     without `preserveDrawingBuffer` — and scored for luma spread. A frame
 *     with no structure in it is not a frame. This is the only detector that
 *     cannot be fooled, because it looks at what the player looks at.
 *  2. **Shader link failures.** three logs one and then carries on with a
 *     material that never draws; if the family that failed is the one the world
 *     is made of, the world silently disappears. Caught here and escalated.
 *  3. **The draw-call watchdog**, kept, because it is the one that catches a
 *     scene graph that genuinely stopped submitting.
 *
 *  Acting means calling into `RenderPipeline` to force it down a rung —
 *  half-float composer, 8-bit composer, direct render, simple materials, flat
 *  materials — and re-checking. The banner is the LAST resort, shown only when
 *  even the simplest path draws nothing.
 *
 *  `?debug=gl` and `__gl()` still print one copy-pasteable block, now including
 *  the capability probe and the full degrade log, so a report that does arrive
 *  says exactly which rung the pipeline ended on and why.
 * ============================================================================
 */
import type { Ctx } from '../types';

export interface GLReport {
  vendor: string;
  renderer: string;
  version: string;
  glsl: string;
  contextAttributes: WebGLContextAttributes | null;
  /** the ones this pipeline actually needs, and whether they are present */
  extensions: Record<string, boolean>;
  limits: Record<string, number>;
  quality: number;
  pixelRatio: number;
  drawCalls: number;
  programs: number;
  shaderErrors: string[];
  composer: boolean;
  /** which rung of the fallback ladder the pipeline is running on */
  rung: string;
  /** every capability decision and every degrade, in order */
  pipelineLog: string[];
  /** the boot capability probe, verbatim */
  capabilities: unknown;
  /** luma statistics of the last frame actually sampled off the canvas */
  frameSample: FrameSample | null;
  userAgent: string;
}

/** Extensions the render pipeline genuinely leans on, and why. */
const NEEDED = [
  'EXT_color_buffer_half_float', // HDR composer buffer; without it the grade clips
  'EXT_color_buffer_float',
  'OES_texture_float_linear',    // smooth sampling of float targets (PMREM, AO)
  'EXT_texture_filter_anisotropic',
  'WEBGL_debug_renderer_info',
  'KHR_parallel_shader_compile', // only affects pre-warm speed
];

// ---------------------------------------------------------------------------
//  The pipeline log — a module-level record every layer can write to.
// ---------------------------------------------------------------------------
/**
 * Module scope on purpose. The capability probe runs at `createSettings()`
 * time, which is module scope in main.ts and long before any instance of
 * anything exists, and its findings are the most valuable lines in the whole
 * report. A static array is the only place they can go.
 */
const pipelineLog: string[] = [];

/**
 * Record one capability decision or one degrade step.
 *
 * Everything that changes what the pipeline does must come through here.
 * Nobody is going to send a dump — the whole point of this round — so the log
 * has to be complete enough that a screenshot of the console is a bug report.
 */
export function logPipeline(step: string, detail = ''): void {
  const line = detail === '' ? `[gl:${step}]` : `[gl:${step}] ${detail}`;
  if (pipelineLog.length < 60) pipelineLog.push(line);
  console.info('%c' + line, 'color:#8ab4ff');
}

export function readPipelineLog(): readonly string[] {
  return pipelineLog;
}

// ---------------------------------------------------------------------------
//  Shader failures
// ---------------------------------------------------------------------------
const shaderErrors: string[] = [];
/** Names of the material families that failed, deduplicated. */
const failedMaterials = new Set<string>();

/**
 * three's own type names, for the one path that only ever sees text: the
 * `console.error` interception below, which catches shader failures raised
 * before the renderer's hook exists (postprocessing's own materials, and
 * anything compiled during a context restore).
 *
 * It is deliberately NOT how the main path classifies a failure. Every world
 * material in this game carries a custom name, so a test for three's type names
 * matches none of them; the renderer sniffs the fragment source for the
 * lighting chunks instead and tells us the answer. See `describeProgram`.
 */
const WORLD_MATERIAL = /Mesh(Standard|Physical|Lambert|Phong|Toon)Material/;

/**
 * Called by the renderer's own `debug.onShaderError` hook, which fires with the
 * driver's real info log. Setting that hook SUPPRESSES three's default
 * `console.error`, so this is now the only place the text exists — it must
 * record and re-emit both.
 *
 * `isWorldMaterial` is the renderer's verdict on whether the failing program
 * was one of the lit families the visible world is built from. A rejected
 * post-processing effect costs a look; a rejected lit material costs the world.
 */
export function recordShaderError(text: string, label: string, isWorldMaterial: boolean): void {
  if (shaderErrors.length < 40) shaderErrors.push(text.slice(0, 900));
  if (isWorldMaterial) failedMaterials.add(label);
}

export function worldMaterialsFailed(): number {
  return failedMaterials.size;
}

// ---------------------------------------------------------------------------
//  What the pipeline has to offer us
// ---------------------------------------------------------------------------
export interface FrameSample {
  /** fraction of sampled pixels above display luma 12 */
  lit: number;
  mean: number;
  /** luma standard deviation — structure, not brightness */
  sd: number;
  /** false when the read could not be performed at all */
  ok: boolean;
}

interface DegradablePipeline {
  degrade(reason: string): boolean;
  degradeToSafeMaterials(reason: string): boolean;
  rungName(): string;
  sampleFrame(): FrameSample | null;
  capabilities(): unknown;
}

function pipeline(): DegradablePipeline | null {
  const p = (globalThis as unknown as { __render?: Partial<DegradablePipeline> }).__render;
  return p !== undefined && typeof p.degrade === 'function' ? (p as DegradablePipeline) : null;
}

// ---------------------------------------------------------------------------

const QUIET_FRAMES = 90;
/** Below this many scene draws we assume nothing meaningful was submitted. */
const DEAD_CALLS = 4;

/**
 * Frames to wait before the first look at the presented image, and between
 * looks after that.
 *
 * `readPixels` on the default framebuffer is a synchronous stall — it is the
 * one thing in this file with a real cost — so it happens a handful of times
 * in the life of the page and never in a steady state. Two clean samples and
 * the detector retires for good: on hardware that works this costs two stalls
 * during the title screen and nothing ever again.
 */
const FIRST_LOOK = 150;
const LOOK_INTERVAL = 75;
/** Consecutive blank samples before we believe it. A transition can be black. */
const BLANK_STREAK = 2;
/** Clean samples before the detector retires. */
const CLEAN_STREAK = 2;

/**
 * A frame with less luma spread than this has no picture in it.
 *
 * The margin is enormous and that is deliberate: measured on this game, a
 * healthy frame reads sd 63.6 and the two "canvas never painted" failures read
 * 0.0. Nothing legitimate lands near 4 — not the countdown flash (which is
 * bright but still has the world under it), not the tunnel (mean 74, sd well
 * above 20). A detector that fires on a healthy frame would ship a downgrade to
 * every player, so it is tuned to be certain rather than sensitive; the shader
 * and draw-call detectors cover the subtler failures.
 */
const BLANK_SD = 4;
const BLANK_LIT = 0.02;

export class Diagnostics {
  private quiet = 0;
  private announced = false;
  /** set once the image detector is satisfied; it never runs again */
  private frameProven = false;
  private nextLook = FIRST_LOOK;
  private blankStreak = 0;
  private cleanStreak = 0;
  private lastSample: FrameSample | null = null;
  private materialsEscalated = false;
  private singleShaderNoted = false;
  /** frame number before which a fresh degrade is given time to take effect */
  private settleUntil = 0;

  init(ctx: Ctx) {
    (window as any).__gl = () => this.report(ctx);

    // Capture shader diagnostics that do NOT come through the renderer hook —
    // postprocessing compiles its own materials, and anything three logs before
    // `debug.onShaderError` is installed lands here.
    const realError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
      if (/shader|glsl|program|compile|link/i.test(text) && shaderErrors.length < 40) {
        shaderErrors.push(text.slice(0, 900));
        const m = text.match(/Material Type:\s*(\S+)/);
        if (m !== null && WORLD_MATERIAL.test(m[1])) failedMaterials.add(m[1]);
      }
      realError(...args);
    };

    if (new URLSearchParams(location.search).get('debug') === 'gl') {
      // Give the scene a few frames to build before reporting.
      setTimeout(() => this.print(ctx), 3000);
    }
    console.info(
      '%c[kart] if the world is missing but the HUD is visible, run __gl() and send the output.',
      'color:#8ab4ff',
    );
  }

  /**
   * Called immediately after the present, inside the same frame, with the
   * draw-call count of the scene pass.
   *
   * The order below is the order of confidence. A shader family that failed to
   * link is a KNOWN cause with a known remedy, so it is acted on first and
   * without waiting for the picture to prove it; the image check is the
   * backstop for everything we did not anticipate.
   */
  afterPresent(ctx: Ctx, sceneCalls: number) {
    if (this.announced) return;
    // Only meaningful once the game believes it is showing a world.
    if (ctx.frame < 120) return;

    if (this.checkShaders(ctx)) return;
    if (this.checkImage(ctx)) return;
    this.checkDrawCalls(ctx, sceneCalls);
  }

  // -- detector 1: a material family the world is made of failed to link -----
  private checkShaders(ctx: Ctx): boolean {
    if (this.materialsEscalated) return false;
    const n = failedMaterials.size;
    if (n === 0) return false;
    if (n === 1) {
      // ONE failure is not evidence of a systemic one, and the remedy — every
      // material in the game replaced with an untextured variant — is far too
      // expensive to spend on a single prop's shader. Say so once, in the
      // report, and leave the picture alone. The boot trial is what catches the
      // systemic case, and it catches it before the world is even built.
      if (!this.singleShaderNoted) {
        this.singleShaderNoted = true;
        logPipeline('shader-error', `one material failed to compile (${Array.from(failedMaterials)[0]}); ` +
          'not enough to be systemic, so the pipeline is left alone — expect that object to be missing');
      }
      return false;
    }
    this.materialsEscalated = true;
    const names = Array.from(failedMaterials).join(', ');
    const why = `${n} world material families failed to compile on this GPU (${names})`;
    logPipeline('shader-error', why);
    const p = pipeline();
    if (p !== null && p.degradeToSafeMaterials(why)) {
      this.settleUntil = ctx.frame + LOOK_INTERVAL;
      this.blankStreak = 0;
      // Not proven yet — the image detector below now has to confirm the
      // simpler material actually draws.
      this.frameProven = false;
      this.nextLook = ctx.frame + LOOK_INTERVAL;
      return true;
    }
    return false;
  }

  // -- detector 2: the presented image has no picture in it ------------------
  private checkImage(ctx: Ctx): boolean {
    if (this.frameProven) return false;
    if (ctx.frame < this.nextLook || ctx.frame < this.settleUntil) return false;
    this.nextLook = ctx.frame + LOOK_INTERVAL;

    const p = pipeline();
    const sample = p?.sampleFrame() ?? null;
    this.lastSample = sample;
    if (sample === null || !sample.ok) {
      // The read itself failed. That is not evidence of a blank frame, and
      // guessing from it would risk downgrading a machine that is fine — but it
      // does mean the best detector in the file is unavailable here, which a
      // report needs to say out loud.
      logPipeline('image', 'the frame could not be read back; falling back to the draw-call watchdog');
      this.frameProven = true;
      return false;
    }
    if (this.cleanStreak === 0 && this.blankStreak === 0) {
      logPipeline('image', `first look: luma mean ${sample.mean.toFixed(1)}, ` +
        `spread ${sample.sd.toFixed(1)}, ${(sample.lit * 100).toFixed(0)}% lit`);
    }

    const blank = sample.sd < BLANK_SD && sample.lit < BLANK_LIT;
    // A uniformly BRIGHT frame is just as empty as a uniformly dark one — that
    // is what the rejected-shader-family case looks like once bloom has had the
    // bare sky to itself — but brightness alone is not proof, so it needs the
    // same absence of structure.
    const flat = sample.sd < BLANK_SD && sample.mean > 235;
    if (!blank && !flat) {
      this.blankStreak = 0;
      if (++this.cleanStreak >= CLEAN_STREAK) this.frameProven = true;
      return false;
    }

    this.cleanStreak = 0;
    if (++this.blankStreak < BLANK_STREAK) return true;
    this.blankStreak = 0;

    const why = `nothing is reaching the screen (luma mean ${sample.mean.toFixed(1)}, ` +
      `spread ${sample.sd.toFixed(1)}, ${(sample.lit * 100).toFixed(0)}% lit)`;
    if (p !== null && p.degrade(why)) {
      this.settleUntil = ctx.frame + LOOK_INTERVAL;
      return true;
    }
    this.fail('显卡没有输出游戏画面。', ctx);
    return true;
  }

  // -- detector 3: the scene stopped submitting anything ---------------------
  private checkDrawCalls(ctx: Ctx, sceneCalls: number) {
    this.quiet = sceneCalls <= DEAD_CALLS ? this.quiet + 1 : 0;
    if (this.quiet < QUIET_FRAMES) return;
    this.quiet = 0;

    const why = `the scene submitted ${sceneCalls} draw calls for ${QUIET_FRAMES} frames`;
    const p = pipeline();
    if (p !== null && p.degrade(why)) {
      this.settleUntil = ctx.frame + LOOK_INTERVAL;
      this.frameProven = false;
      this.nextLook = ctx.frame + LOOK_INTERVAL;
      return;
    }
    this.fail('游戏场景没有正常显示。', ctx);
  }

  /** Last resort: every rung has been tried and nothing draws. */
  private fail(what: string, ctx: Ctx) {
    if (this.announced) return;
    this.announced = true;
    const r = this.report(ctx);
    const why = r.shaderErrors.length > 0
      ? '当前显卡无法显示部分画面效果。'
      : !r.extensions['EXT_color_buffer_half_float'] && !r.extensions['EXT_color_buffer_float']
        ? '当前显卡不支持游戏需要的画面效果。'
        : what;
    logPipeline('give-up', why);
    console.error('[kart] THE WORLD IS NOT BEING DRAWN.', why, r);
    this.banner(why);
  }

  private banner(why: string) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); z-index:200;
      max-width:min(560px,86vw); padding:22px 26px; border-radius:16px; text-align:center;
      background:rgba(14,10,8,.93); border:1.5px solid rgba(255,190,120,.45); color:#f6efe4;
      font:500 15px/1.55 system-ui,-apple-system,sans-serif; box-shadow:0 18px 50px rgba(0,0,0,.6);
    `;
    el.innerHTML =
      `<div style="font-weight:800;font-size:18px;letter-spacing:.02em;margin-bottom:8px">
         画面启动失败
       </div>
       <div style="opacity:.85">${why}</div>
       <div style="opacity:.6;margin-top:12px;font-size:13px">
         简化画面后仍无法启动。请打开控制台输入
         <code style="background:rgba(255,255,255,.1);padding:2px 6px;border-radius:5px">__gl()</code>,
         然后提供输出结果。
       </div>`;
    document.body.appendChild(el);
  }

  report(ctx: Ctx): GLReport {
    const renderer = ctx.renderer;
    const gl = renderer?.getContext() as WebGL2RenderingContext | undefined;
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const ext: Record<string, boolean> = {};
    for (const name of NEEDED) ext[name] = !!gl?.getExtension(name);

    const limits: Record<string, number> = {};
    if (gl) {
      limits.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      limits.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
      limits.maxVertexUniforms = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
      limits.maxFragmentUniforms = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
      limits.maxVaryings = gl.getParameter(gl.MAX_VARYING_VECTORS);
      limits.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
      limits.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    }

    const p = pipeline();
    return {
      vendor: dbg && gl ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : 'unknown',
      renderer: dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      version: gl ? String(gl.getParameter(gl.VERSION)) : 'no context',
      glsl: gl ? String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)) : '-',
      contextAttributes: gl?.getContextAttributes() ?? null,
      extensions: ext,
      limits,
      quality: ctx.settings?.quality ?? -1,
      pixelRatio: renderer?.getPixelRatio?.() ?? 0,
      drawCalls: renderer?.info.render.calls ?? 0,
      programs: renderer?.info.programs?.length ?? 0,
      shaderErrors,
      composer: !!(globalThis as any).__render?.composer,
      rung: p?.rungName() ?? 'unknown',
      pipelineLog: pipelineLog.slice(),
      capabilities: p?.capabilities() ?? null,
      frameSample: this.lastSample,
      userAgent: navigator.userAgent,
    };
  }

  private print(ctx: Ctx) {
    const r = this.report(ctx);
    console.info('%c[kart] GL report — copy everything below', 'color:#ffb020;font-weight:bold');
    console.info(JSON.stringify(r, null, 2));
  }
}
