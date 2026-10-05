/**
 * ============================================================================
 *  RenderPipeline — owns the WebGLRenderer and the post-processing composer.
 * ============================================================================
 *  This is the only object in the game permitted to call `renderer.render()`
 *  or `composer.render()`. Everything else draws by putting objects in the
 *  scene graph.
 *
 *  The chain itself lives in PostFX; this file is responsible for the device,
 *  the buffers, the resolution policy, and for degrading all of it gracefully
 *  when the hardware — or a software rasteriser under a screenshot harness —
 *  cannot take the full stack.
 * ============================================================================
 */
import * as THREE from 'three';
import { EffectComposer } from 'postprocessing';
import { Quality, type Ctx, type Settings, type System } from '../types';
import { PostFX } from './PostFX';
import { glCapabilities, forcedFailure, drainErrors, type GLCapabilities } from '../core/Settings';
import { logPipeline, recordShaderError, type FrameSample } from '../core/Diagnostics';

interface DeviceProfile {
  webgl2: boolean;
  /** RGBA16F was BUILT as a colour attachment and reported complete */
  halfFloat: boolean;
  /** SwiftShader / llvmpipe / ANGLE-on-CPU, i.e. a headless capture or CI */
  software: boolean;
  name: string;
}

/**
 * The device profile, taken from the one shared capability probe.
 *
 * This used to open a second throwaway context of its own and decide
 * `halfFloat` from the extension string. Both were wrong: browsers cap live
 * contexts (we were spending two before the game started), and the extension
 * string is a promise about a FORMAT, not about an ATTACHMENT — a driver can
 * advertise it and still refuse the framebuffer, at which point every draw into
 * the composer's buffer is discarded and the canvas is uniformly black. That
 * exact condition, forced on real hardware, produced 222 draw calls into a
 * canvas that was never painted. `glCapabilities()` builds the attachment and
 * asks; see the long note there.
 */
function probeDevice(): DeviceProfile {
  const caps = glCapabilities();
  return {
    webgl2: caps.webgl2,
    halfFloat: caps.halfFloatRenderable,
    software: caps.software,
    name: caps.renderer,
  };
}

// ---------------------------------------------------------------------------
//  THE FALLBACK LADDER
// ---------------------------------------------------------------------------
/**
 * Every rung is a real, playable frame except the last, and each one removes
 * the thing the rung above it depends on. A driver that cannot do the top rung
 * gets the next one down, not a black screen.
 *
 *   Hdr     composer with a half-float HDR buffer — the shipping look
 *   Ldr     composer with an 8-bit buffer: the grade clips earlier, everything
 *           else is intact. This is what a GPU with no renderable float
 *           attachment gets, and it is chosen at BOOT from the probe rather
 *           than discovered by going black first.
 *   Direct  no composer at all: `renderer.render()` straight to the canvas.
 *           No grade, no bloom, no AO, no SMAA — three's own ACES tone map
 *           carries the exposure. A worse-looking game, and a game.
 *   Safe    Direct, plus every material in the scene replaced with a simple lit
 *           one and shadows off. This is the rung for a driver that rejects the
 *           PBR shader family: the geometry is all still there, it just stops
 *           being invisible.
 *   Flat    Direct, plus the simplest shader three has that still shows form.
 *           No lights, no textures, no environment — if this draws nothing,
 *           nothing will.
 *   Dead    the banner. Reached only after every rung above it drew nothing.
 */
const enum Rung { Hdr = 0, Ldr = 1, Direct = 2, Safe = 3, Flat = 4, Dead = 5 }

const RUNG_NAMES = ['hdr-composer', 'ldr-composer', 'direct', 'safe-materials', 'flat-materials', 'dead'];

/**
 * Fullscreen quads the post chain submits regardless of what the scene drew.
 * Only used to keep the health signal honest, so a rough figure is fine.
 */
const POST_QUADS = 20;

/**
 * Works out which material a failing program belonged to, and whether it is one
 * of the ones the WORLD is made of.
 *
 * `debug.onShaderError` is handed the GL objects and nothing else, so the
 * identity has to be recovered from the source — three stamps
 * `#define SHADER_NAME <name>` into every prefix it generates.
 *
 * BOTH shaders are read, and that is the fix for a bug this very check had on
 * its first outing. The name lives in both prefixes but the LIGHTING MODEL only
 * appears in the fragment shader, and reading only the vertex shader therefore
 * returned 'tarmac-vc' with no idea what kind of material that was. Every world
 * material in this game is a MeshStandardMaterial under a descriptive name —
 * 'tarmac-vc', 'kerb-vc', 'bridge-stone-2s' — so a family test that looks for
 * three's type name in the LABEL matches none of them, and a driver that
 * rejected the entire textured PBR family was recorded as one anonymous
 * failure. Sniffing the fragment source for the lighting chunks catches all of
 * them, whatever they are called.
 *
 * `#define SHADER_NAME` is also EMPTY when a material has no name, which is why
 * the label falls back to the family.
 */
function describeProgram(
  gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader,
): { label: string; world: boolean } {
  let name = '';
  let world = false;
  for (const shader of [vs, fs]) {
    let src = '';
    try { src = gl.getShaderSource(shader) || ''; } catch { src = ''; }
    if (src === '') continue;
    if (name === '') {
      const m = src.match(/#define SHADER_NAME (\S+)/);
      if (m !== null) name = m[1];
    }
    // The lit families three ships. Any of them being rejected takes visible
    // geometry with it; a postprocessing EffectMaterial being rejected does not.
    if (/RE_Direct_Physical|RE_Direct_BlinnPhong|RE_Direct_Lambert|RE_Direct_Toon/.test(src)) {
      world = true;
    }
  }
  return { label: name !== '' ? name : (world ? 'an unnamed lit material' : 'unknown'), world };
}

/** Packs the settings the pipeline actually reacts to into one comparable int. */
function pipelineSignature(s: Settings): number {
  return (s.quality & 3) |
    (s.shadows ? 1 << 2 : 0) |
    (s.ssao ? 1 << 3 : 0) |
    (s.bloom ? 1 << 4 : 0) |
    (s.motionBlur ? 1 << 5 : 0) |
    (s.dof ? 1 << 6 : 0) |
    (Math.round(THREE.MathUtils.clamp(s.renderScale, 0.25, 2) * 64) << 7) |
    (Math.round(THREE.MathUtils.clamp(s.maxPixelRatio, 0.5, 4) * 8) << 16);
}

export class RenderPipeline implements System {
  renderer!: THREE.WebGLRenderer;
  /** Public so debug tooling and a quality menu can reach into the chain. */
  composer: EffectComposer | null = null;
  readonly fx = new PostFX();

  /**
   * False from the moment the GPU takes the context away until the rebuild
   * after `webglcontextrestored` has finished. NOTHING may draw while it is
   * false — every GL call in that window is a silent no-op, so a loop that
   * keeps calling `render()` is just burning CPU and queueing work that will
   * never be presented.
   */
  contextLost = false;

  /**
   * Raised as soon as the context is lost, before anything else. The frame loop
   * subscribes so it can stop simulating on the same tick.
   */
  onContextLost: (() => void) | null = null;
  /**
   * Raised after the composer, its render targets and the effect chain have
   * been rebuilt against the new context. Everything that owns GPU state three
   * cannot re-derive on its own — the PMREM environment probe above all, whose
   * texture comes back allocated but EMPTY — has to re-bake here. May be async;
   * the notice stays up until it settles.
   */
  onContextRestored: (() => void | Promise<void>) | null = null;

  private ctx!: Ctx;
  private device: DeviceProfile = { webgl2: false, halfFloat: false, software: false, name: '' };
  private usePost = false;
  /** Current position on the fallback ladder. Only ever moves downward. */
  private rung: Rung = Rung.Hdr;
  /** The material every object is drawn with at Rung.Safe / Rung.Flat. */
  private overrideMat: THREE.Material | null = null;
  /** Scratch for `sampleFrame`, allocated at most once per width. */
  private samplePixels: Uint8Array | null = null;
  /** True only while `trialDraw` is running, so its own failures are not counted. */
  private inTrial = false;
  private width = 1;
  private height = 1;
  private signature = -1;
  /** Last values `applyResolution` actually pushed at the GL side. */
  private appliedRatio = -1;
  private appliedW = -1;
  private appliedH = -1;
  private appliedSamples = -1;
  private notice: HTMLElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  constructor(private readonly canvasParent: HTMLElement) {}

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.device = probeDevice();
    this.usePost = this.device.webgl2;

    // THE FIRST RUNG IS CHOSEN FROM THE PROBE, NOT DISCOVERED BY GOING BLACK.
    // A GPU that cannot complete an RGBA16F attachment starts on the 8-bit
    // composer; one that cannot complete an RGBA8 attachment either has no
    // off-screen rendering at all and starts on the direct path.
    const caps = glCapabilities();
    if (!caps.webgl2) {
      // three r185 creates WebGL2 contexts and nothing else, so there is no
      // renderer to build and no frame to degrade to. Say so in a way a player
      // can act on, and make it survive main.ts's boot-failure handler — which
      // replaces the whole of <body> — by hanging it off <html> instead.
      this.showFatal(
        '当前浏览器无法启动游戏画面',
        '当前浏览器或显卡驱动不支持游戏需要的画面功能。' +
        '请更新显卡驱动，或在浏览器设置中开启硬件加速。',
      );
      logPipeline('fatal', 'no WebGL2 context — nothing can be rendered');
      throw new Error('WebGL 2 is unavailable, so the renderer cannot be created.');
    }
    if (!caps.halfFloatRenderable) this.rung = Rung.Ldr;
    if (!caps.byteRenderable) this.rung = Rung.Direct;
    if (this.rung !== Rung.Hdr) {
      logPipeline('start', `pipeline starts on ${RUNG_NAMES[this.rung]} (boot probe)`);
    }
    // Settled BEFORE the renderer is built, because it decides a context
    // attribute (`antialias`) and those cannot be changed afterwards without
    // replacing the canvas. A device that starts on the direct path needs the
    // driver's own MSAA — there is no composer to carry the edges for it.
    this.usePost = caps.webgl2 && this.rung <= Rung.Ldr;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = this.createRenderer(ctx);
    } catch (err) {
      this.showFatal(
        '画面启动失败',
        '浏览器无法为游戏启动画面。请更新显卡驱动，' +
        '或在浏览器设置中开启硬件加速。',
      );
      logPipeline('fatal', 'WebGLRenderer could not be constructed: ' + String(err));
      throw err;
    }
    this.finishInit(ctx, renderer);
  }

  private createRenderer(ctx: Ctx): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
      // With the composer running, MSAA lives on the composer's render target
      // and the default framebuffer only ever receives one fullscreen triangle.
      // Without a composer, the driver's MSAA is the only edge treatment left.
      antialias: !this.usePost,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      // False in normal play: keeping the drawing buffer costs a copy every
      // frame. But `?debug=frames` exists to read that buffer back, and with
      // this false the read returns DISCARDED contents — measured as all zeros
      // on a frame that presented perfectly — so the watchdog reports 100%
      // black on a healthy frame. An instrument that lies is worse than none.
      preserveDrawingBuffer:
        new URLSearchParams(location.search).get('debug') === 'frames',
      failIfMajorPerformanceCaveat: false,
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The grade shader inside the composer does the actual tone map — three
    // skips its own whenever it renders into a render target. Setting it here
    // anyway keeps the no-composer fallback looking identical rather than
    // blowing out to white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    renderer.shadowMap.enabled = ctx.settings.shadows;
    // PCF over VSM: the cascade rig is authored elsewhere, and VSM light bleed
    // through thin kerb, railing and fence geometry costs more than the softer
    // penumbra buys with the sun this low.
    //
    // Explicitly PCFShadowMap, not PCFSoftShadowMap: three r185 deprecated the
    // latter and silently substitutes this one anyway, while logging a warning
    // on every boot — which the capture harness records as a frame warning.
    // Asking for what we actually get also stops `DirectionalLightShadow.radius`
    // reading as if it did something (PCF ignores it), so the softness has to
    // come from map resolution and cascade extent, where it really lives.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;

    renderer.domElement.setAttribute('aria-hidden', 'true');
    this.canvasParent.appendChild(renderer.domElement);

    // ---- context loss ------------------------------------------------------
    // A mobile GPU under memory pressure takes the context away rather than
    // killing the tab, and until this round nothing in the game listened for
    // it: the canvas simply went black and stayed black, because there is no
    // automatic recovery for a scene's GPU resources.
    //
    // `preventDefault()` on the loss event is the whole ballgame. Without it
    // the browser never fires 'webglcontextrestored' at all, so recovery is not
    // merely unhandled, it is impossible. (three's own listener also calls it,
    // but relying on that is relying on an implementation detail of a library
    // we pin by caret; calling it here is one line and cannot be wrong.)
    //
    // Ours are registered AFTER three's, which is deliberate: on restore three
    // re-runs `initGLContext()` and throws away its WebGLProperties cache, so
    // by the time we are called the device is live again and every texture,
    // geometry and program will re-upload on next use. What does NOT come back
    // on its own is anything whose *contents* were baked once — see
    // `onContextRestored`.
    renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    renderer.domElement.addEventListener('webglcontextcreationerror', ((e: WebGLContextEvent) => {
      console.error('[render] context creation error:', e.statusMessage);
    }) as EventListener, false);

    return renderer;
  }

  private finishInit(ctx: Ctx, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    try { this.gl = renderer.getContext(); } catch { this.gl = null; }
    ctx.renderer = renderer;
    // Same contract as `window.__drawBudget`: the capture and perf harnesses
    // need to read the device profile and reach into the effect chain (which
    // is deliberately not on Ctx) to A/B a single pass.
    (globalThis as unknown as { __render?: RenderPipeline }).__render = this;

    // A LINK FAILURE IS THE LEADING THEORY AND THIS IS WHERE IT SURFACES.
    //
    // three logs a shader error and then carries on using the program, so a
    // material family the driver rejects does not throw, does not stop the
    // frame, and does not reduce the draw-call count — it just stops appearing.
    // Installing this hook suppresses three's own console.error, so it has to
    // both record and re-emit, and the info log it hands over is the exact text
    // the bug report we never received would have contained.
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const who = describeProgram(gl, vs, fs);
      const text =
        `program link failed for "${who.label}"${who.world ? ' (a lit world material)' : ''}\n` +
        `  program: ${gl.getProgramInfoLog(program) || '(no log)'}\n` +
        `  vertex : ${gl.getShaderInfoLog(vs) || '(ok)'}\n` +
        `  frag   : ${gl.getShaderInfoLog(fs) || '(ok)'}`;
      // The boot trial's own material is excluded from the "how many world
      // materials failed" count on purpose: it is OUR probe, it already has a
      // dedicated line in the log, and letting it into the count made the
      // report say "one material failed, not enough to be systemic, the
      // pipeline is left alone" on a boot where the pipeline had in fact
      // already dropped to the safe rung because of that very failure.
      recordShaderError(text, who.label, who.world && !this.inTrial);
      console.error('[render] ' + text);
    };

    this.width = Math.max(1, ctx.width);
    this.height = Math.max(1, ctx.height);
    this.signature = pipelineSignature(ctx.settings);
    this.applyResolution();

    // DOES A REPRESENTATIVE MATERIAL ACTUALLY DRAW? Asked before the world is
    // built, so the answer is available before any of it can go missing.
    const trial = this.trialDraw();
    if (!trial.ok) {
      logPipeline('trial', 'a representative PBR material drew nothing: ' + trial.detail);
      if (this.rung < Rung.Safe) this.rung = Rung.Safe;
    }

    this.rebuild();
  }

  /**
   * Tears the effect chain down and reassembles it against the current
   * settings and the current rung. Safe to call at any time — quality may
   * change mid-race, and so may the rung.
   *
   * Each attempt that fails moves one rung DOWN and is retried, so a device
   * that cannot build the composer ends this call on the direct path with a
   * frame in hand rather than with an exception and a black canvas. The loop
   * is bounded by the number of rungs; it cannot spin.
   */
  rebuild(): void {
    if (this.contextLost) return;
    for (let attempt = 0; attempt <= Rung.Dead; attempt++) {
      if (this.tryBuild()) return;
    }
  }

  /** One attempt at the current rung. False means "moved down, try again". */
  private tryBuild(): boolean {
    this.applyMaterialOverride();
    // Shadow maps are the other thing a rejected shader family takes with it,
    // and at the safe rungs there are no PBR materials left to receive them.
    this.renderer.shadowMap.enabled = this.ctx.settings.shadows && this.rung < Rung.Safe;
    this.usePost = this.rung <= Rung.Ldr;

    if (!this.usePost) {
      this.fx.dispose();
      if (this.composer !== null) {
        try { this.composer.removeAllPasses(); this.composer.dispose(); } catch { /* going away */ }
        this.composer = null;
      }
      // Nothing owns the default framebuffer's clear any more. See render().
      this.renderer.autoClear = true;
      this.invalidateResolutionCache();
      this.applyResolution();
      return true;
    }

    if (this.composer === null) {
      try {
        if (forcedFailure('composer')) throw new Error('forced by ?glfail=composer');
        this.composer = new EffectComposer(this.renderer, {
          depthBuffer: true,
          stencilBuffer: false,
          multisampling: 0,
          // Half float is what makes a high bloom threshold and our own tone
          // map meaningful; without it the scene clips to white before there
          // is anything left to grade. `Rung.Ldr` is that trade taken
          // deliberately, on a device that proved it cannot do the other one.
          frameBufferType: this.rung === Rung.Hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
        });
        // A brand-new composer starts at multisampling 0 and at whatever size
        // its constructor picked, so the `applyResolution` guard has no history
        // to compare against and must not skip the first push.
        this.invalidateResolutionCache();
      } catch (err) {
        this.dropComposer();
        this.fall(`composer could not be constructed: ${String(err)}`);
        return false;
      }
    } else {
      this.fx.dispose();
      this.composer.removeAllPasses();
    }

    // The composer's input buffer is the only place the scene is rasterised,
    // so it is the only place multisampling can do anything.
    //
    // Assigned through the guard rather than directly: postprocessing's
    // `multisampling` setter DISPOSES the input buffer even when the value it
    // is handed is the one already in force, so a stream of no-op resizes —
    // which is exactly what iOS Safari produces while the URL bar animates —
    // reallocates a half-float MSAA HDR attachment tens of times a second.
    // See `applyResolution`.
    //
    // This used to read `ssao ? 0 : msaa`, on the belief that N8AOPostPass
    // re-renders the scene into a private target and discards the composer's
    // colour buffer. That is true of `N8AOPass`; `N8AOPostPass` reads the
    // composer's `inputBuffer` as its scene colour and composites onto it. So
    // zeroing this dropped MSAA on exactly the tier that asks for it — and the
    // line in PostFX that was supposed to take over threw on a missing field
    // and killed the whole effect chain with it (see PostFX.build).
    this.setMultisampling(this.msaaSamples());

    try {
      this.fx.build(this.ctx, this.composer, {
        software: this.device.software,
        // The chain has to know it is writing into 8 bits: with an LDR buffer
        // the scene is clamped at 1.0 before bloom ever sees it, so a threshold
        // authored against scene-linear HDR selects nothing at all.
        ldr: this.rung >= Rung.Ldr,
      });
    } catch (err) {
      this.dropComposer();
      // §6 of the brief: degrade, do not die. The direct path is a real frame —
      // no grade, no bloom, but a legible game.
      this.fall(`effect chain failed to build: ${String(err)}`);
      return false;
    }

    this.applyResolution();

    // THE TARGETS THE COMPOSER ACTUALLY GOT, NOT THE ONES IT ASKED FOR.
    //
    // `new WebGLRenderTarget(...)` never fails: three defers the allocation to
    // the first bind, and a driver that refuses the format then leaves an
    // INCOMPLETE framebuffer behind, into which every draw is silently
    // discarded. That is a uniformly black canvas with a full draw-call count —
    // reproduced on real hardware by refusing RGBA16F attachments, 222 draws
    // into a canvas that was never painted. Binding it and asking is the whole
    // difference between shipping that and catching it.
    const status = this.targetStatus(this.composer.inputBuffer);
    if (!status.ok) {
      this.dropComposer();
      this.fall(`the composer's ${this.rung === Rung.Hdr ? 'half-float' : '8-bit'} buffer is not ` +
        `renderable at ${this.appliedW}x${this.appliedH} (framebuffer status 0x${status.status.toString(16)})`);
      return false;
    }
    return true;
  }

  /** Releases the effect chain and the composer, tolerating a dead context. */
  private dropComposer(): void {
    this.fx.dispose();
    try {
      this.composer?.removeAllPasses();
      this.composer?.dispose();
    } catch { /* the composer is being abandoned either way */ }
    this.composer = null;
    this.usePost = false;
    // The EffectComposer constructor turns `autoClear` off on its way in and
    // nothing else would ever turn it back on. Without this the default
    // framebuffer is never cleared and whatever the previous frame left in the
    // pixels the scene does not cover stays on screen: a permanent
    // partial-render.
    this.renderer.autoClear = true;
    this.invalidateResolutionCache();
  }

  /** Steps one rung down from inside a build attempt, and says why. */
  private fall(reason: string): void {
    const from = RUNG_NAMES[this.rung];
    this.rung = Math.min(this.rung + 1, Rung.Dead) as Rung;
    logPipeline('degrade', `${from} -> ${RUNG_NAMES[this.rung]}: ${reason}`);
  }

  /**
   * Is this render target's framebuffer complete and error-free?
   *
   * `setRenderTarget` is what makes three allocate and bind it, so this is also
   * the moment the allocation either happens or does not.
   */
  private targetStatus(rt: THREE.WebGLRenderTarget): { ok: boolean; status: number } {
    const gl = this.gl as WebGL2RenderingContext | null;
    if (gl === null) return { ok: true, status: 0 };
    const prev = this.renderer.getRenderTarget();
    let status = 0;
    let err = 0;
    try {
      drainErrors(gl);
      this.renderer.setRenderTarget(rt);
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      err = gl.getError();
    } catch {
      return { ok: false, status: 0 };
    } finally {
      this.renderer.setRenderTarget(prev);
    }
    return { ok: status === gl.FRAMEBUFFER_COMPLETE && err === gl.NO_ERROR, status };
  }

  /**
   * Draw calls the SCENE pass submitted on the last frame.
   *
   * Sampled before the composer's fullscreen passes run, because three resets
   * `info.render` at the top of every `render()` and the last pass in the frame
   * is a single quad — read afterwards, an empty world and a healthy one both
   * report about the same number. The diagnostics watchdog uses this to tell
   * "the world is not being drawn" apart from "the world is fine".
   */
  lastSceneCalls = 0;

  render(ctx: Ctx) {
    // Nothing may draw between 'webglcontextlost' and the rebuild that follows
    // 'webglcontextrestored'. Every GL call in that window is a silent no-op,
    // so continuing to render is pure waste — and on the device that just ran
    // out of memory, waste is the last thing to add.
    if (this.contextLost || this.renderer === undefined) return;

    // Quality can change at runtime; react without anyone having to tell us.
    const sig = pipelineSignature(ctx.settings);
    if (sig !== this.signature) {
      this.signature = sig;
      // `tryBuild` owns the shadow flag now, because at the safe rungs it is
      // not simply the setting — a driver that rejected the lit material family
      // is in no position to be handed a shadow pass either.
      this.rebuild();
      this.applyResolution();
    }

    if (this.composer !== null) {
      this.fx.sync(ctx, ctx.dt);
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
      this.composer.render(ctx.dt);
      // The scene pass is the first thing the composer runs, and every pass
      // after it is one quad. Subtracting the fixed post-chain cost is less
      // reliable across quality tiers than simply noting that a healthy frame
      // is in the hundreds and a dead one is in single digits.
      this.lastSceneCalls = Math.max(0, this.renderer.info.render.calls - POST_QUADS);
      this.renderer.info.autoReset = true;
    } else {
      this.renderer.setRenderTarget(null);
      // Explicit, not left to `autoClear`: this path is reached both from a
      // device that never had a composer (autoClear untouched, true) and from a
      // composer that failed to build (autoClear turned off by postprocessing's
      // constructor before it threw). One of those two clears the canvas and
      // the other does not, and the one that does not shows the previous frame
      // wherever the scene has no geometry — sky included, since the sky dome
      // is drawn but the HUD-side letterbox is not.
      this.renderer.clear(true, true, false);
      this.renderer.render(ctx.scene, ctx.camera);
      this.lastSceneCalls = this.renderer.info.render.calls;
    }

    // ------------------------------------------------------------------------
    // THE PARTIAL-FRAME ARTEFACT — what it actually is, measured.
    // ------------------------------------------------------------------------
    // tools/shot.mjs documents "roughly one capture in five comes back as a
    // vertical split, with the left band holding the previous frame and
    // everything right of the seam holding a scene buffer that was never drawn
    // into", and writes it off as a SwiftShader quirk. The player sees the same
    // thing on a real phone, so it was worth measuring properly rather than
    // retrying past. Three arms, one session, 50 captures each at 1920x1080,
    // scored with the harness's own dark-fraction test:
    //
    //     arm                       torn / 50     worst frame
    //     stock pipeline               12          50.1% dark
    //     + gl.finish() per frame       3          24.8% dark
    //     no post-processing at all     3          11.7% dark
    //
    // Read those together and the artefact is not a logic bug in the chain:
    //
    //  - `finish()` — which blocks until the GPU is idle — cuts it four-fold.
    //    So most torn frames are frames the compositor sampled while the
    //    rasteriser was still working through them. The dark region is not a
    //    buffer "that was never drawn into", it is one that had not been drawn
    //    into YET, with the grade pass's grain and vignette already composited
    //    over the part of it that was still black. Its boundary is a tile
    //    corner — a column seam AND a row seam in the same frame — not a
    //    scanline, which is what partial tile coverage looks like.
    //  - Removing the composer cuts the RATE by the same four-fold and the
    //    SEVERITY by more than four-fold. Post-processing does not introduce
    //    the race; it makes the window wider, because it multiplies the GPU
    //    work behind a single present.
    //  - Neither arm reaches zero, so a residue lives in the capture path
    //    itself and is genuinely not ours.
    //
    // Which means there is no line to add here. The lever is per-frame GPU
    // cost, and that is what the rest of this round is: the watchdog in
    // main.ts refuses to queue a second frame on top of an overrunning one, the
    // resize guard below stops the whole target set being reallocated mid
    // gesture, and the handheld tier ships without the passes it cannot afford.
    //
    // `gl.flush()` was the obvious cheap candidate and it is deliberately NOT
    // here: A/B'd on its own, 70 captures each, it measured 4 torn frames
    // without and 8 with. It does not help.
  }

  resize(w: number, h: number) {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    this.applyResolution();
  }

  dispose() {
    const el = this.renderer?.domElement;
    if (el !== undefined) {
      el.removeEventListener('webglcontextlost', this.handleContextLost, false);
      el.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    }
    this.fx.dispose();
    if (this.composer !== null) {
      this.composer.dispose();
      this.composer = null;
    }
    if (this.overrideMat !== null) {
      if (this.ctx?.scene?.overrideMaterial === this.overrideMat) this.ctx.scene.overrideMaterial = null;
      this.overrideMat.dispose();
      this.overrideMat = null;
    }
    this.samplePixels = null;
    this.notice?.remove();
    this.notice = null;
    this.renderer?.dispose();
    if (el !== undefined && el.parentNode !== null) el.parentNode.removeChild(el);
  }

  /**
   * Give up on post-processing and run the direct path from here on.
   *
   * The chain already degrades when it cannot be *built*; this is the same
   * retreat for a chain that built fine and then started throwing at render
   * time, which is what a driver in trouble looks like from up here. A game
   * without a grade is a worse-looking game; a game that throws once per frame
   * is a black rectangle.
   */
  disablePostProcessing(reason: string): void {
    if (this.rung >= Rung.Direct) return;
    logPipeline('degrade', `${RUNG_NAMES[this.rung]} -> ${RUNG_NAMES[Rung.Direct]}: ${reason}`);
    this.rung = Rung.Direct;
    this.dropComposer();
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  //  The fallback ladder, driven from Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Step one rung down and rebuild. Returns false when there is nothing left
   * below — which is the only condition under which the banner is allowed.
   *
   * Called by the watchdogs in Diagnostics, which is deliberate: the pipeline
   * knows how to degrade and the diagnostics know when to. Neither of them
   * should be deciding both.
   */
  degrade(reason: string): boolean {
    if (this.rung >= Rung.Flat) {
      logPipeline('degrade', `already on ${RUNG_NAMES[this.rung]}; nothing simpler to try (${reason})`);
      return false;
    }
    this.fall(reason);
    this.rebuild();
    return true;
  }

  /**
   * Jump straight to the simple-material rung.
   *
   * Used when the cause is KNOWN to be a material family the driver rejected.
   * Walking down through the composer rungs first would waste several seconds
   * of the player's time on changes that cannot possibly help: the shader is
   * broken wherever it is composited to.
   */
  degradeToSafeMaterials(reason: string): boolean {
    // Already there. Say so and change nothing: the remedy for this cause has
    // been applied, and the image detector is the thing entitled to decide
    // whether it worked. Escalating here as well is how a driver that rejects
    // ONE shader family ended up on flat normal-shading when the untextured lit
    // variant one rung up was drawing the world perfectly well.
    if (this.rung >= Rung.Safe) {
      logPipeline('degrade', `already on ${RUNG_NAMES[this.rung]}, which covers this (${reason})`);
      return true;
    }
    logPipeline('degrade', `${RUNG_NAMES[this.rung]} -> ${RUNG_NAMES[Rung.Safe]}: ${reason}`);
    this.rung = Rung.Safe;
    this.rebuild();
    return true;
  }

  rungName(): string { return RUNG_NAMES[this.rung]; }

  capabilities(): GLCapabilities { return glCapabilities(); }

  /**
   * Read two strips of the finished frame back and score them.
   *
   * THE ONLY HONEST ORACLE IN THE FILE. Draw calls, framebuffer status and
   * shader logs are all proxies; this is the picture. It works without
   * `preserveDrawingBuffer` because it runs inside the same task that drew the
   * frame — the drawing buffer is only discarded when the compositor takes the
   * surface, which cannot happen until this task yields.
   *
   * `readPixels` is a synchronous pipeline stall, so this is called a handful
   * of times in the life of the page and never in a steady state; see
   * FIRST_LOOK in Diagnostics. The strips are 4 rows each at 45% and 75% of
   * frame height, which crosses sky, horizon, trackside and road — a band that
   * is featureless in every one of the failure modes and never featureless in a
   * working frame.
   */
  sampleFrame(): FrameSample | null {
    const gl = this.gl as WebGL2RenderingContext | null;
    if (gl === null || this.contextLost) return null;
    const w = gl.drawingBufferWidth | 0;
    const h = gl.drawingBufferHeight | 0;
    if (w < 8 || h < 8) return null;

    const rows = 4;
    const need = w * rows * 4;
    if (this.samplePixels === null || this.samplePixels.length < need) {
      this.samplePixels = new Uint8Array(need);
    }
    const buf = this.samplePixels;

    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let lit = 0;
    const prev = this.renderer.getRenderTarget();
    try {
      // The default framebuffer is what the player sees; anything still bound
      // from the last pass is not.
      this.renderer.setRenderTarget(null);
      drainErrors(gl);
      for (const frac of [0.45, 0.75]) {
        const y = Math.min(h - rows, Math.max(0, Math.round(h * frac)));
        gl.readPixels(0, y, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        if (gl.getError() !== gl.NO_ERROR) return { lit: 0, mean: 0, sd: 0, ok: false };
        for (let i = 0; i < need; i += 4) {
          const luma = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
          n++;
          sum += luma;
          sum2 += luma * luma;
          if (luma > 12) lit++;
        }
      }
    } catch {
      return { lit: 0, mean: 0, sd: 0, ok: false };
    } finally {
      this.renderer.setRenderTarget(prev);
    }
    if (n === 0) return { lit: 0, mean: 0, sd: 0, ok: false };
    const mean = sum / n;
    return { lit: lit / n, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), ok: true };
  }

  /**
   * Draws a representative material into a small off-screen target and reads
   * the result back. Runs once, at boot, before any of the world exists.
   *
   * A clearcoated MeshPhysicalMaterial under a directional light is the game's
   * headline material (art bible §4) and shares its entire shader family with
   * the road, the kerbs, the buildings and the karts. If this comes back the
   * colour of the clear, that family does not draw on this GPU — which is the
   * leading theory for the empty-world reports, and the whole point of asking
   * before the player has anything to lose.
   */
  private trialDraw(): { ok: boolean; detail: string } {
    if (forcedFailure('trial')) return { ok: false, detail: 'forced by ?glfail=trial' };
    const size = 8;
    let rt: THREE.WebGLRenderTarget | null = null;
    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(4, 4);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xe0453f, metalness: 0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06,
    });
    // Named so `#define SHADER_NAME` carries it: three uses the material's name
    // for that define and leaves it EMPTY when there is none, which is exactly
    // the case where a report would say "unknown" about the one program whose
    // identity matters most.
    mat.name = 'boot-trial-physical';
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    const prevAlpha = this.renderer.getClearAlpha();
    this.inTrial = true;
    try {
      // 8-bit on purpose: this probe asks about the MATERIAL, and pairing it
      // with a float target would confuse a shader failure with a format one.
      rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: true });
      const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
      cam.position.set(0, 0, 2.4);
      const key = new THREE.DirectionalLight(0xffd9a8, 4.2);
      key.position.set(0.5, 0.9, 1.4);
      scene.add(key, new THREE.AmbientLight(0xa8c8ff, 0.8), new THREE.Mesh(geo, mat));

      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear(true, true, false);
      this.renderer.render(scene, cam);

      const px = new Uint8Array(size * size * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
      let brightest = 0;
      for (let i = 0; i < px.length; i += 4) {
        brightest = Math.max(brightest, px[i], px[i + 1], px[i + 2]);
      }
      // The quad fills the frame and is lit from the front, so a working driver
      // returns something in the hundreds. Anything under 8 counts is the clear
      // colour with rounding on top.
      return brightest >= 8
        ? { ok: true, detail: '' }
        : { ok: false, detail: `brightest channel was ${brightest}/255 on a fully-lit quad` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    } finally {
      this.inTrial = false;
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(prevClear, prevAlpha);
      scene.clear();
      geo.dispose();
      mat.dispose();
      rt?.dispose();
    }
  }

  /**
   * Installs, updates or removes the whole-scene material override.
   *
   * `Scene.overrideMaterial` is a blunt instrument and that is exactly what is
   * wanted here: at this point the driver has told us it will not draw the
   * materials the world is made of, and the choice is between one simple
   * material for everything and nothing at all. The geometry, the layout, the
   * karts and the track are all still there — they stop being invisible.
   */
  private applyMaterialOverride(): void {
    const scene = this.ctx?.scene;
    if (scene === undefined || scene === null) return;
    const want: 'safe' | 'flat' | null =
      this.rung >= Rung.Flat ? 'flat' : this.rung >= Rung.Safe ? 'safe' : null;
    const have = this.overrideMat === null ? null
      : (this.overrideMat as THREE.Material).userData.kartFallback as 'safe' | 'flat';
    if (want === have) return;

    if (this.overrideMat !== null) {
      if (scene.overrideMaterial === this.overrideMat) scene.overrideMaterial = null;
      this.overrideMat.dispose();
      this.overrideMat = null;
    }
    if (want === null) return;

    // 'safe' keeps the lights and the fog, so the frame still reads as
    // golden-hour Sunset Bay with its textures missing. 'flat' has no lights,
    // no textures and no environment at all — the simplest shader three has
    // that still shows the shape of a thing.
    const mat: THREE.Material = want === 'safe'
      ? new THREE.MeshLambertMaterial({ color: 0xb9b2a6, fog: true })
      : new THREE.MeshNormalMaterial();
    mat.userData.kartFallback = want;
    this.overrideMat = mat;
    scene.overrideMaterial = mat;
    logPipeline('materials', `every material replaced with the ${want} variant`);
  }

  /**
   * A full-page explanation for the failures that leave nothing to render at
   * all, attached to <html> rather than <body>.
   *
   * That is not a stylistic choice. When the pipeline cannot be constructed,
   * `init` throws, and main.ts's boot handler replaces the entire contents of
   * <body> with a stack trace — which would take a panel inside it with it. A
   * node parented to the document element survives, so the player gets a
   * sentence they can act on instead of a red monospace dump.
   */
  private showFatal(title: string, detail: string): void {
    if (document.getElementById('gl-fatal') !== null) return;
    const el = document.createElement('div');
    el.id = 'gl-fatal';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999', 'display:flex',
      'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:.6em', 'padding:8vmin', 'text-align:center',
      'font-family:system-ui,-apple-system,sans-serif', 'color:#f6efe4',
      'background:radial-gradient(120% 100% at 50% 30%,#1d2436 0%,#0b0f18 70%)',
    ].join(';');
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:800;font-size:clamp(18px,3.2vmin,26px);letter-spacing:.02em';
    h.textContent = title;
    const p = document.createElement('div');
    p.style.cssText = 'max-width:34em;opacity:.8;font-size:clamp(13px,2vmin,16px);line-height:1.6';
    p.textContent = detail;
    el.append(h, p);
    document.documentElement.appendChild(el);
  }

  /**
   * Put a line of text over the canvas, or take it away again with `null`.
   * The frame loop uses this for the one failure the pipeline cannot see from
   * in here: a renderer that keeps throwing without ever losing its context.
   */
  announce(title: string | null, detail = ''): void {
    if (title === null) this.hideNotice();
    else this.showNotice(title, detail);
  }

  /**
   * Test hook: drop the context on purpose, and optionally hand it back.
   *
   * Recovery code that has never been run is decoration, and the only way to
   * run this one is to ask the driver to take the context away. Exposed through
   * `__render` alongside the rest of the harness surface.
   */
  debugLoseContext(restoreAfterMs = 900): void {
    const ext = this.renderer.getContext().getExtension('WEBGL_lose_context');
    if (ext === null) {
      console.warn('[render] WEBGL_lose_context unavailable; cannot simulate a loss');
      return;
    }
    ext.loseContext();
    if (restoreAfterMs >= 0) setTimeout(() => ext.restoreContext(), restoreAfterMs);
  }

  // -------------------------------------------------------------------------
  //  Context loss / restore
  // -------------------------------------------------------------------------

  private handleContextLost = (event: Event) => {
    // THE ONE LINE. Without `preventDefault()` the browser will never fire
    // 'webglcontextrestored', so there is no recovery to write.
    event.preventDefault();
    if (this.contextLost) return;
    this.contextLost = true;
    console.warn('[render] WebGL context lost — pausing until it is restored');

    // Drop our references to the effect chain. Every GPU object behind them is
    // already gone; the dispose calls are only there to release the JS side,
    // and they are wrapped because postprocessing will happily issue GL calls
    // against a dead context on the way out.
    try { this.fx.dispose(); } catch { /* already gone with the context */ }
    try { this.composer?.dispose(); } catch { /* likewise */ }
    this.composer = null;

    this.showNotice('画面已暂停', '正在恢复游戏画面…');
    try { this.onContextLost?.(); } catch (err) { console.error('[render] onContextLost threw', err); }
  };

  private handleContextRestored = () => {
    console.info('[render] WebGL context restored — rebuilding the pipeline');
    // three's own listener runs first (it is registered in the WebGLRenderer
    // constructor, ours in init) and has already re-run `initGLContext()`, so
    // the device is live and every texture, geometry and program will re-upload
    // the next time it is used. What is left to us is everything that wraps a
    // GL resource of our own.
    //
    // The RUNG is deliberately not reset. Whatever the driver refused before
    // the context went away, it will refuse again, and climbing back up to a
    // pipeline this device has already failed would spend the recovery on a
    // second black screen.
    this.usePost = this.device.webgl2 && this.rung <= Rung.Ldr;
    this.composer = null;
    this.invalidateResolutionCache();
    this.signature = pipelineSignature(this.ctx.settings);

    try { this.gl = this.renderer.getContext(); } catch { this.gl = null; }
    this.renderer.shadowMap.enabled = this.ctx.settings.shadows;
    // Shadow maps come back as empty attachments; autoUpdate re-renders them on
    // the next frame, but only if nothing has latched `needsUpdate` off.
    this.renderer.shadowMap.needsUpdate = true;

    this.contextLost = false;
    this.applyResolution();
    this.rebuild();

    const done = () => {
      // A second loss can land while the first restore's pre-warm is still
      // running. If it has, the notice on screen belongs to that one and must
      // not be pulled down by a callback from the restore before it.
      if (this.contextLost) return;
      this.hideNotice();
      console.info('[render] pipeline restored');
    };
    try {
      const p = this.onContextRestored?.();
      if (p !== undefined && p !== null && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).then(done, (err) => {
          console.error('[render] onContextRestored failed', err);
          done();
        });
      } else {
        done();
      }
    } catch (err) {
      console.error('[render] onContextRestored threw', err);
      done();
    }
  };

  /**
   * A calm line of text over the frozen canvas. A black rectangle with no
   * explanation is the worst version of this; the frame underneath is stale but
   * it is still a picture of the game, so the notice sits on top of it rather
   * than replacing it.
   */
  private showNotice(title: string, detail: string): void {
    if (this.notice === null) {
      const el = document.createElement('div');
      el.id = 'gl-notice';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'inset:auto 0 0 0', 'z-index:120', 'display:flex',
        'flex-direction:column', 'align-items:center', 'gap:.35em',
        'padding:1.4em 1.2em calc(1.4em + env(safe-area-inset-bottom))',
        'font-family:system-ui,-apple-system,sans-serif', 'text-align:center',
        'color:#f3f6fb', 'pointer-events:none',
        'background:linear-gradient(180deg,rgba(8,11,22,0) 0%,rgba(8,11,22,.82) 46%,rgba(8,11,22,.94) 100%)',
        'opacity:0', 'transition:opacity .35s ease',
      ].join(';');
      el.innerHTML =
        '<b style="font-size:clamp(15px,2.4vmin,20px);font-weight:800;letter-spacing:.06em"></b>' +
        '<span style="font-size:clamp(12px,1.8vmin,15px);letter-spacing:.04em;color:rgba(233,240,250,.66)"></span>';
      document.body.appendChild(el);
      this.notice = el;
    }
    const [b, s] = [this.notice.querySelector('b'), this.notice.querySelector('span')];
    if (b !== null) b.textContent = title;
    if (s !== null) s.textContent = detail;
    // One frame of layout before the transition, or it snaps in.
    requestAnimationFrame(() => { if (this.notice !== null) this.notice.style.opacity = '1'; });
  }

  private hideNotice(): void {
    const el = this.notice;
    if (el === null) return;
    el.style.opacity = '0';
    setTimeout(() => { if (this.notice === el) { el.remove(); this.notice = null; } }, 420);
  }

  // -------------------------------------------------------------------------

  /**
   * The pixel ratio the internal buffers are actually allocated at, which is
   * what every per-sample cost in the chain scales with. Not the same thing as
   * `devicePixelRatio`: `maxPixelRatio` caps it, `renderScale` scales it, and a
   * software rasteriser is pinned to 1.
   */
  /**
   * Dynamic resolution, 0.5..1. Deliberately NOT part of `Settings`, because
   * `pipelineSignature` covers `renderScale` and any change there tears down and
   * rebuilds the entire effect chain. Adaptive scaling has to be able to move
   * every second or two; rebuilding the chain that often would cost far more
   * than it saves.
   */
  dynamicScale = 1;

  /**
   * Adjust internal render resolution without rebuilding the chain.
   *
   * This is the correct response to a GPU that cannot keep up, and it is what
   * replaced halving the PRESENT rate. For a racing game a smooth 25 fps at 80%
   * resolution beats a juddering 12 fps at full resolution every time: present
   * cadence is what the eye reads as motion, and the sim was already running at
   * full rate underneath, so halving the present only added judder and changed
   * nothing about latency.
   */
  setDynamicScale(scale: number): void {
    const next = THREE.MathUtils.clamp(scale, 0.5, 1);
    if (Math.abs(next - this.dynamicScale) < 0.01) return;
    this.dynamicScale = next;
    this.applyResolution();
  }

  private effectivePixelRatio(): number {
    const s = this.ctx.settings;
    const cap = this.device.software ? 1 : Math.max(0.5, s.maxPixelRatio);
    const scale = THREE.MathUtils.clamp(s.renderScale, 0.25, 2) * this.dynamicScale;
    const dpr = THREE.MathUtils.clamp(globalThis.devicePixelRatio || 1, 0.5, 4);
    const ratio = Math.min(dpr, cap) * scale;

    // Never ask for a buffer the driver cannot make.
    //
    // Every colour attachment in the chain is allocated at the drawing-buffer
    // size, and a render target whose edge exceeds `MAX_TEXTURE_SIZE` or
    // `MAX_RENDERBUFFER_SIZE` does not fail loudly — it comes back incomplete
    // and everything drawn into it is black, which is the most literal possible
    // version of the player's report. It is not hypothetical on a handheld: a
    // 2532 CSS-px landscape panel at devicePixelRatio 3 is 7596 drawing-buffer
    // pixels wide, and the WebGL2 floor for both limits is 2048. Clamping the
    // ratio costs sharpness on a device that had no chance of affording those
    // pixels anyway, and it costs nothing at all on the desktop tiers, where
    // the limit is 16384.
    const limit = Math.min(
      this.renderer?.capabilities?.maxTextureSize ?? 4096,
      this.maxRenderbufferSize(),
    );
    //
    // BOTH CLAMPS BELOW MULTIPLY `scale` BACK IN, and that is not cosmetic.
    // `ratio` already contains `scale` (renderScale * dynamicScale); returning a
    // bare `limit / longest` or `sqrt(budget / pixels)` throws it away, so above
    // either ceiling the adaptive ladder has NO AUTHORITY OVER BUFFER SIZE AT
    // ALL — `setDynamicScale` moves `dynamicScale`, `applyResolution` runs, and
    // the drawing buffer comes back byte-identical. Proven with the harness:
    // `--scale 1.5` and `--scale 2.0` both produced exactly 2666x1500 = 4.00
    // Mpx. A retina 1512x982 window at devicePixelRatio 2 is 5.94 Mpx, i.e.
    // over the backstop before the ladder has taken a single rung, so on the
    // machine this game is developed on the ladder's first step was silently
    // swallowed. Multiplying through keeps the ceiling a CEILING and leaves the
    // ladder free to go below it, which is the only arrangement in which both
    // mechanisms mean what their names say.
    const longest = Math.max(this.width, this.height);
    if (longest * ratio > limit) return Math.max(0.25, (limit / longest) * scale);

    // A CEILING ON TOTAL PIXELS, NOT ONLY ON THE RATIO.
    //
    // `maxPixelRatio` caps a MULTIPLIER, and a multiplier does not know how big
    // the window is. Every cost in this frame that matters scales with the
    // product: the audit for this round fits the whole build at ~7.0 ms of fill
    // per megapixel plus ~7.5 ms of resolution-independent per-frame cost, and
    // the post chain alone is 5.3 ms/Mpx of that. So the same `maxPixelRatio:
    // 2` that is harmless on a 1280x800 laptop panel (4.1 Mpx) asks a retina
    // 1920x1200 desktop for 9.2 Mpx and 65+ ms frames — which is why the
    // machine this game is developed on renders 3840x2160 and gets ~15 fps
    // while the 1080p bench profile it is tuned against sits at 2.07 Mpx and
    // never sees the problem.
    //
    // 4.0 Mpx is deliberately a BACKSTOP rather than the policy. It is above
    // every native-resolution desktop the game is likely to meet — 2560x1440 is
    // 3.69 Mpx and passes through untouched, and so does 1080p at any ratio up
    // to 1.39 — so it never blurs a monitor that is simply large. What it
    // catches is devicePixelRatio-2 SUPERSAMPLING, where the CSS pixels are
    // already small and the extra samples are the least visible pixels in the
    // frame. On the 1920x1200 retina case it takes the ratio from 2.0 to ~1.29,
    // which is still 1.7 geometric samples per CSS pixel in each axis with SMAA
    // running last on top. That IS a resolution reduction and it should be read
    // as one; it is the difference between a playable frame and a slideshow on
    // a machine that was getting neither the pixels nor the frame rate.
    //
    // The tier's `maxPixelRatio` remains the primary knob and is applied above;
    // this only ever takes the lower of the two.
    const budget = 4.0e6;
    const pixels = this.width * this.height * ratio * ratio;
    if (pixels > budget) {
      return Math.max(0.25, Math.sqrt(budget / (this.width * this.height)) * scale);
    }
    return ratio;
  }

  private maxRenderbufferSize(): number {
    const gl = this.gl;
    if (gl === null) return 4096;
    try {
      return (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096;
    } catch {
      return 4096;
    }
  }

  private msaaSamples(): number {
    if (!this.device.webgl2) return 0;
    const q = this.ctx.settings.quality;

    // ---------------------------------------------------------------------
    // MSAA IS INCOMPATIBLE WITH THE AO PASS, AND THAT IS THE BLACK-FRAME BUG.
    //
    // `N8AOPostPass` samples the composer's `inputBuffer` as a TEXTURE to get
    // its scene colour. When that buffer is multisampled it has to be resolved
    // first, and that resolve does not reliably happen before the read — so the
    // pass composites over undefined contents and the frame comes back with a
    // large black region bounded by a stepped, tile-aligned edge.
    //
    // Measured, at the reporter's own window size, over 420 frames each:
    //     composer.multisampling = 2  ->  32 black frames  (7.6%)
    //     composer.multisampling = 0  ->   1 black frame   (0.2%)
    //
    // An earlier round found this expression reading `ssao ? 0 : msaa` and
    // removed the guard, because the stated justification for it was wrong:
    // the comment claimed N8AOPostPass renders the scene privately and discards
    // the composer's colour, which is true of `N8AOPass` but not of the `Post`
    // variant. The justification was wrong and the guard was right. It is
    // restored here with the reason it actually has, and with the numbers.
    //
    // Nothing is lost visually: SMAA is the last pass in the chain and resolves
    // edges on top of whatever it is given, which is exactly how Quality.Low
    // has always run.
    if (this.ctx.settings.ssao) return 0;
    // ---------------------------------------------------------------------

    // A software rasteriser pays for every sample of every fragment, so SMAA
    // carries the edges there. Quality.Low relies on SMAA alone by design.
    if (this.device.software) return q >= Quality.High ? 2 : 0;
    if (q < Quality.Medium) return 0;
    if (q === Quality.Medium) return 2;

    // MSAA SAMPLES AND RENDER RESOLUTION BUY THE SAME THING, AND WE WERE PAYING
    // FOR BOTH AT FULL PRICE. §8's budget is 60 fps at 1080p, but `High` and
    // `Ultra` both ship `maxPixelRatio: 2`, so on the retina Mac the budget is
    // written against the composer's input buffer is 3840x2160 — and it is
    // RGBA16F, because the whole grade depends on a half-float HDR buffer. At
    // 4x MSAA that single attachment is 3840 * 2160 * 8 bytes * 4 samples =
    // 265 MB, and every fragment of every opaque draw is resolved out of it.
    // Dropping to 2x halves that bandwidth for the entire scene pass, which is
    // the largest single line item in the frame, and it is very close to free
    // visually: at an effective ratio of 1.5 or more each CSS pixel already
    // receives at least 2.25 geometric samples before MSAA is applied at all,
    // and SMAA still runs last on top of the resolve.
    //
    // Below 1.5 there is no supersampling to lean on and the 4 samples are
    // doing real work on the kerb stripes, the railings and the fence posts —
    // §9.6's "aliasing crawl on thin geometry" — so they stay.
    return this.effectivePixelRatio() >= 1.5 ? 2 : 4;
  }

  /**
   * Resolution policy. `renderScale` folds into the device pixel ratio, so the
   * canvas keeps its full CSS size and the compositor does the upscale on
   * present — while the internal buffers, the AO targets, the bloom mip chain
   * and the bokeh targets all shrink together.
   */
  private applyResolution(): void {
    if (this.renderer === undefined || this.contextLost) return;

    const ratio = this.effectivePixelRatio();

    // NO-OP RESIZES ARE NOT FREE, AND ON A PHONE THERE ARE HUNDREDS OF THEM.
    //
    // `composer.setSize` reallocates the input and output buffers and calls
    // `setSize` on every registered pass, which reallocates the AO targets, the
    // whole bloom mip chain, the bokeh targets and the SMAA buffers. At a
    // handheld's drawing-buffer size that is on the order of 25-30 MB of GPU
    // allocation, and the driver frees the old attachments lazily, so the peak
    // is a multiple of the steady state.
    //
    // iOS Safari fires `resize` continuously while the URL bar collapses or
    // expands, on every rotation, and whenever the on-screen keyboard moves —
    // dozens of events for one gesture, most of which report a size we are
    // already at. Rebuilding every render target in the pipeline dozens of
    // times inside one animation is a memory spike on a device that is already
    // being killed for its footprint, and a stall long enough for the
    // compositor to present a half-drawn surface. Both of the player's reports
    // meet here.
    //
    // The guard compares what we would actually push at the GL side — the
    // drawing-buffer dimensions, not the CSS ones — so a ratio change with the
    // same CSS size still gets through, and a CSS change too small to move the
    // buffer does not.
    const bufW = Math.floor(this.width * ratio);
    const bufH = Math.floor(this.height * ratio);
    if (bufW === this.appliedW && bufH === this.appliedH && ratio === this.appliedRatio) {
      // The sample count can still move on its own (see below), so it is
      // checked even when the size has not.
      if (this.composer !== null) this.setMultisampling(this.msaaSamples());
      return;
    }
    this.appliedW = bufW;
    this.appliedH = bufH;
    this.appliedRatio = ratio;

    this.renderer.setPixelRatio(ratio);
    if (this.composer !== null) {
      // Re-evaluated here, not only in `rebuild`, because the sample count is a
      // function of the effective pixel ratio and `devicePixelRatio` can change
      // under us — dragging the window to a non-retina display fires a resize
      // and nothing else.
      this.setMultisampling(this.msaaSamples());
      // The composer resizes its own buffers and every registered pass from
      // the drawing buffer size, which already folds in the pixel ratio.
      this.composer.setSize(this.width, this.height, true);
    } else {
      this.renderer.setSize(this.width, this.height, true);
    }
  }

  /**
   * Assigns the composer's sample count only when it genuinely changes.
   *
   * The comment this replaces claimed "the setter is a no-op when the value is
   * unchanged". It is not: postprocessing's setter reads
   *
   *     if (multisampling > 0 && value > 0) { buffer.samples = value; buffer.dispose(); }
   *
   * — an unconditional `dispose()` of the input buffer whenever both the old
   * and the new value are non-zero, which is every assignment on every tier
   * above Low. `dispose()` releases the GPU-side attachment and marks the
   * target for reallocation on next use, so handing the setter the value it
   * already holds throws away a half-float MSAA HDR buffer and builds an
   * identical one. Once per quality change is nothing; once per resize event,
   * on a platform that fires resize events in bursts, is the difference between
   * a steady footprint and a sawtooth.
   */
  /** Forgets what was last pushed, so the next `applyResolution` pushes it all. */
  private invalidateResolutionCache(): void {
    this.appliedRatio = -1;
    this.appliedW = -1;
    this.appliedH = -1;
    this.appliedSamples = -1;
  }

  private setMultisampling(samples: number): void {
    if (this.composer === null || samples === this.appliedSamples) return;
    this.appliedSamples = samples;
    this.composer.multisampling = samples;
  }
}
