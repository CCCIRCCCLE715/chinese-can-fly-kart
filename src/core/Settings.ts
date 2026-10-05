import { Quality, type Settings } from '../types';
import { setTextureBudget } from '../render/Textures';
import { logPipeline } from './Diagnostics';

/**
 * ===========================================================================
 *  Device classification
 * ===========================================================================
 *  This used to be `/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)`.
 *  That test is wrong in the one way that matters most: iPadOS Safari defaults
 *  to "Request Desktop Website" and reports a *Macintosh* user agent with no
 *  iPad token anywhere in it. The same mistake has already bitten the touch
 *  controls in this project once. An iPad falling through to the desktop GPU
 *  sniff below reports an Apple GPU string and is handed Ultra, which on a
 *  device with a shared memory pool is an instant jetsam kill.
 *
 *  So the UA is used only as corroboration, never as the deciding signal. The
 *  signals that actually describe the hardware are:
 *
 *    pointer: coarse / hover: none  — the browser telling us the primary input
 *                                     is a finger. True on every phone and
 *                                     tablet including desktop-mode iPadOS.
 *    navigator.maxTouchPoints       — non-zero on iPadOS in desktop mode; zero
 *                                     on a Mac, trackpad and Touch Bar alike.
 *    screen.width/height            — CSS pixels of the panel, which separates
 *                                     a phone from a tablet far more reliably
 *                                     than any device name.
 *    deviceMemory / hardwareConcurrency — where the browser offers them, a
 *                                     direct read on the memory ceiling we are
 *                                     actually budgeting against.
 *
 *  A touch laptop (Surface, some Chromebooks) reports coarse pointer *and* a
 *  large screen *and* plenty of cores, so it lands on the desktop path, which
 *  is the intent.
 * ===========================================================================
 */

function mql(q: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(q).matches;
}

interface NavExtras {
  maxTouchPoints?: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  userAgentData?: { mobile?: boolean };
}

export interface DeviceProfile {
  /** primary input is a finger — phone or tablet, including desktop-mode iPadOS */
  touchPrimary: boolean;
  /** touch device whose panel is phone-sized; the tightest memory ceiling we ship to */
  handheld: boolean;
  /** GB of RAM if the browser will say, else 0 */
  memoryGB: number;
  cores: number;
  /** shortest edge of the panel in CSS pixels */
  minEdge: number;
  dpr: number;
}

export function profileDevice(): DeviceProfile {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & NavExtras;
  const touchPoints = nav.maxTouchPoints ?? 0;
  const coarse = mql('(pointer: coarse)') || mql('(any-pointer: coarse)');
  const noHover = mql('(hover: none)');
  const uaMobile = nav.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile Safari|Silk/i.test(nav.userAgent || '');

  // Two independent signals must agree, so a desktop browser that happens to
  // report a coarse pointer (a plugged-in tablet, a remote session) does not
  // get demoted, and an iPad in desktop mode — coarse + 5 touch points — does.
  const touchPrimary = ((coarse || noHover) && touchPoints > 0) ||
    (uaMobile && (coarse || noHover || touchPoints > 0));

  const sw = typeof screen !== 'undefined' ? screen.width || 0 : 0;
  const sh = typeof screen !== 'undefined' ? screen.height || 0 : 0;
  const minEdge = Math.min(sw || 9999, sh || 9999);
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const memoryGB = nav.deviceMemory ?? 0;
  const cores = nav.hardwareConcurrency ?? 0;

  // 500 CSS px of short edge is comfortably above every phone in landscape
  // (iPhone 15 Pro Max is 430) and comfortably below every tablet (iPad mini is
  // 744). A "large" phone and a "small" tablet do not overlap here.
  const handheld = touchPrimary && (minEdge <= 500 || (memoryGB > 0 && memoryGB <= 4));

  return { touchPrimary, handheld, memoryGB, cores, minEdge, dpr };
}

/**
 * ===========================================================================
 *  GPU capability probe — what the driver DOES, not what it SAYS.
 * ===========================================================================
 *  Several players on Brave / Edge / Chrome get a live HUD over an empty
 *  world while the identical build runs fine elsewhere. Nobody has ever sent a
 *  dump, so the fix has to be written blind, and writing it blind means never
 *  taking a capability on trust again.
 *
 *  Every check below is an EXPERIMENT, because every one of them has a cheaper
 *  version that lies:
 *
 *    - `getExtension('EXT_color_buffer_half_float') !== null` is what the
 *      pipeline used to decide the composer's buffer format on. The extension
 *      string is a promise about a format, not about an ATTACHMENT: a driver
 *      can advertise it and still refuse the framebuffer, and when it does the
 *      refusal is silent — every draw into that target is discarded and the
 *      canvas is exactly, uniformly black. Simulated (attachment silently
 *      refused after the extension said yes) the game today submits 222 draw
 *      calls into a canvas that is never painted, with no error anywhere. So
 *      the probe builds the attachment and asks `checkFramebufferStatus`.
 *
 *    - "the GPU runs WebGL2, so it runs our shaders" is the leading theory's
 *      exact mistake. A trial program with the shape of a real material —
 *      GLSL ES 3.00, a struct-array light loop, derivatives, textureLod, a
 *      full varying set — is compiled AND linked here, and `getShaderInfoLog`
 *      is kept whether or not it failed, because that log is the bug report
 *      that has never arrived.
 *
 *  One context, probed once, memoised: `RenderPipeline` reads the same record
 *  rather than opening a second throwaway context (browsers cap live contexts
 *  at around sixteen, and we were spending two of them before the game began).
 * ===========================================================================
 */
export interface GLCapabilities {
  /** a WebGL2 context could be created at all — false means the game cannot run */
  webgl2: boolean;
  /** the extension string claims a renderable float colour buffer */
  halfFloatExtension: boolean;
  /** an RGBA16F colour attachment was built, reported COMPLETE and cleared */
  halfFloatRenderable: boolean;
  /** the same, for the 8-bit fallback the composer drops to */
  byteRenderable: boolean;
  /** float textures can be sampled with linear filtering (PMREM, AO) */
  floatLinear: boolean;
  /** a representative GLSL ES 3.00 program compiled and linked */
  trialProgram: boolean;
  /** whatever the driver said about it — empty on success */
  trialLog: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxSamples: number;
  vendor: string;
  renderer: string;
  /** SwiftShader / llvmpipe / ANGLE-on-CPU, i.e. a headless capture or CI */
  software: boolean;
}

/**
 * Forced failures, for the fallback tests. `?glfail=halffloat,composer,...`
 *
 * Only two of the five conditions this round has to survive can be forced from
 * outside the app (`getContext` and `getExtension` are patchable from the
 * page); the rest are internal, and a fallback that has never been executed is
 * decoration. Parsed once, empty in normal play, and every consumer of it is a
 * single `has()` on a Set that is empty on every real device.
 */
const FORCED_FAILURES: ReadonlySet<string> = new Set(
  (typeof location !== 'undefined'
    ? (new URLSearchParams(location.search).get('glfail') || '')
    : '').split(',').map((s) => s.trim()).filter(Boolean),
);

export function forcedFailure(name: string): boolean {
  return FORCED_FAILURES.has(name);
}

/**
 * Empties the GL error queue so the next check reads its OWN result.
 *
 * BOUNDED, and that bound is load-bearing rather than defensive: `getError`
 * normally clears the flag it returns, so the obvious `while` terminates — but
 * a context in the LOST state returns `CONTEXT_LOST_WEBGL` on every call
 * forever, and a lost context is exactly the situation this code exists to
 * survive. An unbounded drain there hangs the tab, which is a worse failure
 * than the one being diagnosed.
 */
export function drainErrors(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  for (let i = 0; i < 16; i++) {
    if (gl.getError() === gl.NO_ERROR) return;
  }
}

/**
 * Builds a colour attachment of the given format and asks the driver whether
 * it would actually render into it. Returns false on anything short of
 * FRAMEBUFFER_COMPLETE with a clean error queue after a real clear.
 */
function attachmentWorks(
  gl: WebGL2RenderingContext, internalFormat: number, format: number, type: number,
): boolean {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let ok = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 8, 8, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    ok = status === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      // Completeness is necessary and not sufficient — clear it and make sure
      // the driver did not raise on the way.
      drainErrors(gl);
      gl.viewport(0, 0, 8, 8);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      ok = gl.getError() === gl.NO_ERROR;
    }
  } catch {
    ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return ok;
}

/**
 * A trial program shaped like the materials this game actually ships: a
 * struct-array light loop, derivatives, textureLod, a tangent frame and a full
 * varying set. If a driver is going to reject the PBR family — the leading
 * theory for the empty-world reports — it rejects this too, and it says why.
 */
const TRIAL_VERT = `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vNormal;
out vec3 vView;
out vec2 vUv;
out vec4 vShadowCoord;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vShadowCoord = mv;
  gl_Position = projectionMatrix * mv;
}`;

const TRIAL_FRAG = `#version 300 es
precision highp float;
precision highp int;
struct TrialLight { vec3 direction; vec3 color; };
uniform TrialLight trialLights[4];
uniform sampler2D trialMap;
uniform sampler2D trialNormalMap;
uniform float trialRoughness;
in vec3 vNormal;
in vec3 vView;
in vec2 vUv;
in vec4 vShadowCoord;
out vec4 fragColor;
vec3 trialTangentNormal(vec3 n) {
  vec3 q0 = dFdx(vView), q1 = dFdy(vView);
  vec2 st0 = dFdx(vUv), st1 = dFdy(vUv);
  vec3 t = normalize(q0 * st1.t - q1 * st0.t);
  vec3 b = normalize(cross(n, t));
  vec3 m = texture(trialNormalMap, vUv).xyz * 2.0 - 1.0;
  return normalize(mat3(t, b, n) * m);
}
void main() {
  vec3 n = trialTangentNormal(normalize(vNormal));
  vec3 v = normalize(vView);
  vec3 base = textureLod(trialMap, vUv, 1.0).rgb;
  float rough = clamp(trialRoughness + fwidth(vUv.x), 0.04, 1.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; ++i) {
    vec3 l = normalize(trialLights[i].direction);
    vec3 h = normalize(l + v);
    float a = rough * rough;
    float d = max(dot(n, h), 0.0);
    float ggx = a * a / max(3.14159 * pow(d * d * (a * a - 1.0) + 1.0, 2.0), 1e-4);
    sum += trialLights[i].color * (max(dot(n, l), 0.0) * base + ggx);
  }
  sum += base * 0.02 * vShadowCoord.w;
  fragColor = vec4(sum, 1.0);
}`;

function trialCompile(gl: WebGL2RenderingContext): { ok: boolean; log: string } {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  const logs: string[] = [];
  let ok = false;
  try {
    if (vs === null || fs === null || prog === null) return { ok: false, log: 'could not create shader objects' };
    gl.shaderSource(vs, TRIAL_VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) logs.push('vertex: ' + (gl.getShaderInfoLog(vs) || 'failed'));
    gl.shaderSource(fs, TRIAL_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) logs.push('fragment: ' + (gl.getShaderInfoLog(fs) || 'failed'));
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    ok = gl.getProgramParameter(prog, gl.LINK_STATUS) === true && logs.length === 0;
    if (!ok) logs.push('link: ' + (gl.getProgramInfoLog(prog) || 'failed'));
  } catch (err) {
    logs.push('threw: ' + String(err));
    ok = false;
  }
  if (vs !== null) gl.deleteShader(vs);
  if (fs !== null) gl.deleteShader(fs);
  if (prog !== null) gl.deleteProgram(prog);
  return { ok, log: ok ? '' : logs.join('\n').slice(0, 900) };
}

const NO_GL: GLCapabilities = {
  webgl2: false, halfFloatExtension: false, halfFloatRenderable: false, byteRenderable: false,
  floatLinear: false, trialProgram: false, trialLog: 'no WebGL2 context',
  maxTextureSize: 0, maxRenderbufferSize: 0, maxSamples: 0,
  vendor: 'unknown', renderer: 'unknown', software: false,
};

let caps: GLCapabilities | null = null;

/** The one capability record. Probed on first call, then memoised. */
export function glCapabilities(): GLCapabilities {
  if (caps !== null) return caps;
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    gl = forcedFailure('webgl2')
      ? null
      : canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl === null) {
    caps = { ...NO_GL };
    logPipeline('probe', 'no WebGL2 context — the game cannot render');
    return caps;
  }

  // The extension has to be REQUESTED before RGBA16F is colour-renderable, so
  // this call is part of the experiment and not merely a question.
  const halfExt = forcedFailure('halffloat')
    ? false
    : gl.getExtension('EXT_color_buffer_half_float') !== null ||
      gl.getExtension('EXT_color_buffer_float') !== null;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const vendor = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : '';

  const halfRenderable = halfExt &&
    !forcedFailure('halffloat') &&
    attachmentWorks(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  const byteRenderable = attachmentWorks(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const trial = forcedFailure('material')
    ? { ok: false, log: 'forced by ?glfail=material' }
    : trialCompile(gl);

  caps = {
    webgl2: true,
    halfFloatExtension: halfExt,
    halfFloatRenderable: halfRenderable,
    byteRenderable,
    floatLinear: gl.getExtension('OES_texture_float_linear') !== null,
    trialProgram: trial.ok,
    trialLog: trial.log,
    maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 0,
    maxRenderbufferSize: (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 0,
    maxSamples: (gl.getParameter(gl.MAX_SAMPLES) as number) || 0,
    vendor,
    renderer,
    software: /SwiftShader|llvmpipe|Software|Microsoft Basic|Mesa OffScreen|ANGLE \(Software/i.test(renderer),
  };

  // Everything that is not the happy path is written down, because the next
  // person to see it will be reading a console paste from a stranger.
  if (halfExt && !halfRenderable) {
    logPipeline('probe', 'EXT_color_buffer_half_float is advertised but an RGBA16F ' +
      'attachment is NOT complete — falling back to an 8-bit composer buffer');
  } else if (!halfExt) {
    logPipeline('probe', 'no renderable float colour buffer — 8-bit composer buffer');
  }
  if (!byteRenderable) logPipeline('probe', 'even an RGBA8 attachment is incomplete — off-screen targets are unusable');
  if (!trial.ok) logPipeline('probe', 'a representative material FAILED to compile/link: ' + trial.log);

  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return caps;
}

function detectQuality(dev: DeviceProfile): Quality {
  const gl = glCapabilities();
  if (!gl.webgl2) return Quality.Low;

  // A phone gets Low, and that is a deliberate change from the Medium this used
  // to hand out. Medium leaves shadows, motion blur and full-resolution render
  // targets on, and measured at 220 MB of texture memory against a budget of
  // 80 — the reported "crashes after ten seconds" on a real device. A 390 CSS-px
  // panel does not need any of it.
  if (dev.handheld) return Quality.Low;
  if (dev.touchPrimary) {
    // Tablet. More thermal and memory headroom than a phone, nowhere near a
    // discrete GPU. Weak ones (<= 4 cores, <= 4 GB) drop to Low with the phones.
    const weak = (dev.cores > 0 && dev.cores <= 4) || (dev.memoryGB > 0 && dev.memoryGB <= 4);
    return weak ? Quality.Low : Quality.Medium;
  }

  const name = gl.renderer;
  // Software rasterisers (SwiftShader / llvmpipe / ANGLE-on-CPU) show up in CI
  // and headless captures; they cannot take the full pipeline at speed but we
  // still want the full *look*, so they get High rather than Low.
  if (gl.software) return Quality.High;
  if (/Apple M[0-9]|RTX|Radeon RX|Arc A/i.test(name)) return Quality.Ultra;
  return Quality.High;
}

/**
 * Maximum texture edge length per tier, in texels.
 *
 * High and Ultra are set at or above the largest texture the game authors
 * (2048, the sign atlas), so the desktop look is bit-for-bit what it was. The
 * cap only ever bites on the two tiers a touch device can reach.
 *
 * The art bible's "minimum 1024² for anything the camera gets within 5 m of"
 * is a desktop standard and is met on the desktop tiers. THE MOBILE CLAUSE:
 * on a handheld, 1024² over a 3.5 m tile is 290 texels per metre against a
 * panel that is 390 CSS px tall — the texel density is an order of magnitude
 * past the pixel density, so every one of those texels is resolved by a mip
 * the hardware builds and then never samples the top of. 256² is the honest
 * number there, and it is the difference between a game and a crash.
 *
 * RE-DERIVED FOR THE SHARPER HANDHELD BUFFER. The Low tier now renders at
 * 1.51x CSS instead of 0.70x, so the pixel density it has to keep up with went
 * up 2.2x in each axis and the argument above has to be re-run rather than
 * assumed. It survives: 256² over a 3.5 m tile is 73 texels/m, and a 589-px-
 * wide buffer looking down a road ~8 m wide resolves ~74 px/m at the kart and
 * far fewer beyond it, so the top mip is now roughly AT the sampling rate
 * instead of ten times past it. That is the right place to be, and there is no
 * room to go further anyway. Measured with `?texcap=` on the 390x844 profile:
 *
 *     256 -> 36.0 MB     384 -> 37.6 MB     512 -> 83.5 MB
 *
 * against the mobile soak's 80 MB budget, so 512 is out. 384 looks nearly free
 * and is a trap: `setTextureBudget` SLICES a hand-built mip chain rather than
 * resampling it (see Textures.ts, which is why the foliage alpha coverage and
 * the kart lacquer roughness chain survive the cap at all), and a slice can
 * only ever halve. A non-power-of-two cap is therefore honoured by the
 * resampling path and rounded down to 256 by the slicing path — which is why
 * it buys 1.6 MB instead of the ~2.25x it looks like it should. Half a cap is
 * worse than either whole one.
 */
const TEXTURE_CAP: Record<Quality, number> = {
  [Quality.Low]: 256,
  [Quality.Medium]: 512,
  [Quality.High]: 2048,
  [Quality.Ultra]: Infinity,
};

const PRESETS: Record<Quality, Omit<Settings, 'quality' | 'masterVolume'>> = {
  [Quality.Low]: {
    // ---------------------------------------------------------------------
    //  THE PHONE TIER USED TO CUT RESOLUTION TWICE, AND THE SECOND CUT WENT
    //  BELOW THE PANEL'S OWN RESOLUTION.
    // ---------------------------------------------------------------------
    //  This shipped `maxPixelRatio: 1, renderScale: 0.7`. Those are two
    //  independent knobs on the same quantity and they MULTIPLY: measured on a
    //  390x844 panel at devicePixelRatio 3 the drawing buffer came out
    //  273x590 — 0.16 Mpx, which is 0.70x the page's own CSS resolution in
    //  each axis. Below 1.0 the compositor is UPSCALING on present, so every
    //  edge in the frame is resampled and every glyph in the HUD is soft. That
    //  is the "visibly soft on a real phone" this round exists to remove, and
    //  it was never a measured trade — it was two guesses stacked.
    //
    //  Worse, a third ceiling was already sitting underneath both of them and
    //  never firing: PIXEL_BUDGET_MPX[Low] is 1.2 Mpx, and a phone at ratio 1
    //  draws 0.33. The tier had three resolution policies, two of them binding
    //  and the honest one inert. That is the "one global constant applied
    //  uniformly to things that are not uniform" trap in CLAUDE.md, twice.
    //
    //  So resolution on this tier is now ONE policy: the pixel budget, which
    //  is expressed in the unit the cost actually scales with. `renderScale`
    //  goes back to 1 and is reserved for `?scale=` (a harness knob that
    //  rebuilds the whole effect chain, which is right for a pinned sweep and
    //  wrong for a shipping tier), and `maxPixelRatio` goes to 2 so the budget
    //  — not an arbitrary cap — is what decides.
    //
    //  Measured on the 390x844/dpr-3 profile: 273x590 = 0.16 Mpx at 0.70x CSS
    //  becomes 589x1275 = 0.75 Mpx at 1.51x CSS. 4.6x the pixels, and the
    //  buffer is now ABOVE the panel's own resolution instead of below it, so
    //  nothing is upscaled at all. The ladder in main.ts may still walk it
    //  down under load, but its floor on a handheld is 1.0x CSS — the softness
    //  is now the bottom of a measured range instead of the starting point.
    //
    //  Everything else here is unchanged. Shadows in particular stay OFF: the
    //  cascade sizes live in Sky.ts and are 2048+2048 = 8.4 Mpx below
    //  Quality.High, which against a 0.75 Mpx screen is eleven times the
    //  frame's own pixel count. A phone tier with shadows needs the cascades
    //  sized to the tier first; that is a render-side change, not a settings
    //  one, and it is the largest remaining quality gap on this tier.
    maxPixelRatio: 2, shadows: false, ssao: false, bloom: true, motionBlur: false,
    dof: false, renderScale: 1, volumetrics: false, reflections: false,
    particleDensity: 0.35, foliageDensity: 0.3,
  },
  [Quality.Medium]: {
    maxPixelRatio: 1.5, shadows: true, ssao: false, bloom: true, motionBlur: true,
    dof: false, renderScale: 1, volumetrics: false, reflections: false,
    particleDensity: 0.6, foliageDensity: 0.6,
  },
  [Quality.High]: {
    maxPixelRatio: 2, shadows: true, ssao: true, bloom: true, motionBlur: true,
    dof: true, renderScale: 1, volumetrics: true, reflections: true,
    particleDensity: 1, foliageDensity: 1,
  },
  [Quality.Ultra]: {
    maxPixelRatio: 2, shadows: true, ssao: true, bloom: true, motionBlur: true,
    dof: true, renderScale: 1, volumetrics: true, reflections: true,
    particleDensity: 1.4, foliageDensity: 1.35,
  },
};

/**
 * ===========================================================================
 *  A PIXEL RATIO IS NOT A BUDGET. A PIXEL COUNT IS.
 * ===========================================================================
 *  `maxPixelRatio: 2` says "up to two drawing-buffer pixels per CSS pixel per
 *  axis" and says nothing whatsoever about how many pixels that is. The two
 *  desktop tiers ship it, and every per-sample cost in the frame — the whole
 *  post chain, which measures at roughly half of it — scales with the product,
 *  not the ratio. So the same setting means:
 *
 *      1920x1080 monitor, dpr 1   ->  2.07 Mpx   (measured 45.6 fps)
 *      1512x982 retina Mac, dpr 2 ->  5.94 Mpx   (measured ~15 fps at 8.29)
 *
 *  Four times the work for the same nominal quality setting, on the machine
 *  this game is developed on. That is not a tuning miss, it is the unit being
 *  wrong.
 *
 *  The adaptive ladder in main.ts cannot rescue it either: `setDynamicScale`
 *  clamps at 0.5, which is a quarter of the pixels, so from 5.94 Mpx the
 *  bottom rung is 1.49 Mpx and 60 fps is simply not reachable from that start.
 *  The ceiling is what puts the ladder within reach of its own target.
 *
 *  Expressed as drawing-buffer megapixels and FLOORED AT RATIO 1, which is the
 *  important half of the rule:
 *
 *   - On a dpr-1 display it is inert. A 1080p monitor and a 4K monitor both
 *     keep ratio 1 and every pixel of the panel, exactly as before; a 4K
 *     monitor that cannot afford 8.29 Mpx is the LADDER's problem, because that
 *     is a reversible, measured decision and this one is a guess made at boot.
 *   - On a dpr-2 panel it trades supersampling, and only supersampling. At the
 *     Ultra ceiling a 1512x982 retina window renders at ratio 1.42 — still
 *     above the panel's CSS resolution, so nothing is being upscaled — instead
 *     of 2.0. Half the fill cost for a difference that needs a loupe, against
 *     an alternative of 15 fps.
 *
 *  THIS IS THE ONLY RESOLUTION POLICY IN THE PROGRAM, AND THAT IS DELIBERATE.
 *  There are two other pixel ceilings in the tree and both must stay inert:
 *
 *    - `Renderer.effectivePixelRatio()` carries a 4.0 Mpx BACKSTOP. Every
 *      budget below is far under it, so on any path this function controls the
 *      backstop can never bind — it exists for a `?scale=` sweep or a settings
 *      object that never came through here. Two live ceilings on one quantity
 *      is the CLAUDE.md trap; one live ceiling and one documented backstop is
 *      not. `assertBackstopClearance()` below fails loudly if that ordering is
 *      ever broken by a future edit to either file.
 *    - A tier's `renderScale`. It is now 1 on every tier and reserved for
 *      `?scale=`, because it is part of `pipelineSignature` (changing it tears
 *      down and rebuilds the whole effect chain) and because multiplying it by
 *      the ladder's rungs compounds two independent budgets — which is exactly
 *      what produced the phone's 0.70x-CSS buffer.
 *
 *  The numbers were "deliberately generous rather than fitted" and that was the
 *  right call while nothing had been measured on a quiet machine. It has been
 *  now, twice and independently, and both fits agree:
 *
 *      frame_ms = 6.25 + 5.30 * Mpx      (7 points, fps-bench)
 *      frame_ms = 9.51 + 3.91 * Mpx      (4 points, fill-probe)
 *
 *  Both put 16.7 ms at 1.8-2.0 Mpx on this build at Ultra, and both validate
 *  against the 1080p point held out of the fit (2.07 Mpx, measured 16.67-17.20
 *  ms). A 3.0 Mpx Ultra budget was therefore asking a retina window for ~50%
 *  more pixels than the frame has ever been able to afford, which is not
 *  generosity, it is a guaranteed miss.
 *
 *  The budgets below sit ABOVE the fitted number rather than on it — the post
 *  chain and the shadow cascades are being worked on in parallel and a budget
 *  fitted to today's cost would over-cut the moment they get cheaper — but no
 *  longer 50% above it. Every one is a strict reduction except Low, which goes
 *  the other way on purpose. See the Low preset.
 *
 *  Measured deltas at the four profiles the tier probe covers:
 *
 *    1920x1080 dpr 1  Ultra   1920x1080 2.07 Mpx  ->  unchanged (inert at dpr 1)
 *    1512x982  dpr 2  Ultra   2149x1395 3.00 Mpx  ->  1922x1248 2.40 Mpx
 *    1024x1366 dpr 2  Medium  1224x1633 2.00 Mpx  ->  1060x1414 1.50 Mpx
 *    390x844   dpr 3  Low      273x590  0.16 Mpx  ->   589x1275 0.75 Mpx
 *
 *  The two desktop/tablet rows are a QUALITY TRADE and should be read as one:
 *  the retina window goes from 1.42x to 1.27x CSS resolution and the tablet
 *  from 1.20x to 1.04x. Both are still above 1.0, so nothing is upscaled and
 *  no detail is lost — what is given up is supersampling, which is the least
 *  visible pixel in the frame and the only kind of pixel a battery-powered
 *  panel should ever be asked to give up first.
 * ===========================================================================
 */
const PIXEL_BUDGET_MPX: Record<Quality, number> = {
  // A handheld is the one tier where the budget goes UP. 0.75 Mpx is 1.51x CSS
  // on a 390x844 panel and 1.14x on a 600x960 one, so the tier is sharp on
  // every handheld this classifier can reach rather than soft on all of them.
  [Quality.Low]: 0.75,
  // Tablet. 1.5 Mpx puts a 1024x1366 iPad at 1.04x its own CSS resolution —
  // sharp, not supersampled. It used to be handed 2.00 Mpx, which is within 4%
  // of the pixel count of the 1080p DESKTOP frame that this build measures at
  // 58 fps on an M5, on a fanless device with shadows on.
  [Quality.Medium]: 1.5,
  [Quality.High]: 2.2,
  [Quality.Ultra]: 2.4,
};

/**
 * The invariant that keeps `Renderer`'s 4.0 Mpx backstop from becoming a second
 * live ceiling. Cheap, runs once at boot, and says which file to look in.
 *
 * It is a log rather than a throw on purpose: a mis-ordered ceiling makes the
 * game render at the wrong resolution, which is a bug worth shouting about and
 * not worth refusing to boot over.
 */
const RENDERER_BACKSTOP_MPX = 4.0;

function assertBackstopClearance(): void {
  for (const [q, mpx] of Object.entries(PIXEL_BUDGET_MPX)) {
    if (mpx >= RENDERER_BACKSTOP_MPX) {
      logPipeline('settings',
        `PIXEL_BUDGET_MPX[${q}] = ${mpx} is at or above Renderer's ${RENDERER_BACKSTOP_MPX} Mpx ` +
        `backstop — there are now TWO live pixel ceilings and they disagree. ` +
        `Lower the budget here or make the backstop the policy there, not both.`);
    }
  }
}

/**
 * Lowest ratio the ceiling may impose. Below 1 the buffer is smaller than the
 * page's own CSS layout and the compositor is upscaling — a real, visible loss
 * that must be measured and reversible, i.e. the adaptive ladder's job, not a
 * boot-time guess made before a single frame has been timed.
 */
const MIN_CEILING_RATIO = 1;

let deviceProfile: DeviceProfile | null = null;

/** The classification `createSettings()` used. Systems may read it; none may write it. */
export function device(): DeviceProfile {
  return (deviceProfile ??= profileDevice());
}

export function createSettings(): Settings {
  const dev = (deviceProfile = profileDevice());
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const q: Quality = forced
    ? ({ low: Quality.Low, medium: Quality.Medium, high: Quality.High, ultra: Quality.Ultra }[forced] ??
       Quality.High)
    : detectQuality(dev);
  const s: Settings = { quality: q, masterVolume: 0.8, ...PRESETS[q] };
  // ?scale=0.75 etc. lets the screenshot harness trade resolution for time
  const scale = parseFloat(params.get('scale') || '');
  if (Number.isFinite(scale) && scale > 0) s.renderScale = scale;

  // ---- pixel-count ceiling ------------------------------------------------
  // See PIXEL_BUDGET_MPX. Applied against the ratio the renderer will actually
  // allocate at, which is `min(dpr, maxPixelRatio) * renderScale` — so the
  // budget has to be divided through by renderScale here or a tier that already
  // renders small would be charged twice for it.
  //
  // `innerWidth`/`innerHeight` rather than `screen`: the canvas fills `#app`,
  // which is the window, not the panel. On a phone the visual viewport wobbles
  // with the URL bar, which does not matter — the floor makes this inert at
  // dpr 1 and a handheld is nowhere near the Low budget in any case.
  assertBackstopClearance();
  const cssPx = (globalThis.innerWidth || 0) * (globalThis.innerHeight || 0);
  const budgetMpx = parseFloat(params.get('mpx') || '');
  const budget = (Number.isFinite(budgetMpx) && budgetMpx > 0 ? budgetMpx : PIXEL_BUDGET_MPX[q]) * 1e6;
  if (cssPx > 0) {
    const ceiling = Math.sqrt(budget / (cssPx * s.renderScale * s.renderScale));
    const capped = Math.max(MIN_CEILING_RATIO, Math.min(s.maxPixelRatio, ceiling));
    if (capped < s.maxPixelRatio - 1e-3) {
      logPipeline('settings',
        `pixel ceiling: maxPixelRatio ${s.maxPixelRatio} -> ${capped.toFixed(2)} to keep the ` +
        `drawing buffer near ${(budget / 1e6).toFixed(1)} Mpx ` +
        `(${globalThis.innerWidth}x${globalThis.innerHeight} CSS at dpr ${dev.dpr})`);
      s.maxPixelRatio = capped;
    }
  }

  // ---- capability-driven degrade, before the first frame ------------------
  // Nothing below fires on hardware that passes the probe, so the desktop path
  // is untouched; every branch is a driver that has already told us it cannot
  // do the thing, and the alternative to acting on that is a black screen.
  const gl = glCapabilities();
  if (gl.webgl2 && !gl.halfFloatRenderable) {
    // N8AO allocates half-float depth/normal/AO targets of its own, and the
    // pipeline cannot see inside them. On a device that cannot render to a
    // float attachment those targets are incomplete, the pass composites over
    // undefined contents, and the result is the dark frame this whole round is
    // about. Measured with the float extensions withheld: the composed frame
    // came back 91% below display luma 12, against 9% on the same machine with
    // them present. Dropping the pass costs contact shadowing; keeping it costs
    // the picture.
    if (s.ssao) {
      s.ssao = false;
      logPipeline('settings', 'ambient occlusion off: this GPU cannot render to a float buffer');
    }
    // The bloom mip chain is 8-bit here too, so a high threshold has less to
    // work with; that is a look change, not a failure, and it stays.
  }
  // A rasteriser that cannot even complete an RGBA8 attachment has no
  // off-screen rendering at all: no composer, no AO, no shadow maps.
  if (gl.webgl2 && !gl.byteRenderable) {
    s.ssao = false;
    s.bloom = false;
    s.dof = false;
    s.motionBlur = false;
    s.shadows = false;
    logPipeline('settings', 'no usable off-screen targets: post-processing and shadows disabled');
  }
  if (gl.webgl2 && !gl.trialProgram) {
    // The representative material did not compile. Everything the world is made
    // of is that family, so the safest thing we can still do at THIS layer is
    // stop asking for the most shader-heavy tier; RenderPipeline takes it from
    // here with a simpler material variant.
    s.shadows = false;
    s.ssao = false;
    logPipeline('settings', 'trial material did not compile: shadows and AO disabled');
  }

  // Install the process-wide texture cap before any system exists, let alone
  // builds a texture. `createSettings()` is evaluated at module scope in
  // main.ts, which is the earliest point in the program that knows the tier.
  //
  // The belt-and-braces `handheld` clamp is deliberate: a phone that somehow
  // reaches Medium — a forced `?quality=medium`, a future tweak to the tier
  // rules, a device this classifier has not met — still gets the 256 cap.
  // Guessing high on a phone is the failure that kills the tab, so the cap is
  // pinned to the hardware and not only to the preset.
  let cap = TEXTURE_CAP[q];
  if (dev.handheld) cap = Math.min(cap, TEXTURE_CAP[Quality.Low]);
  else if (dev.touchPrimary) cap = Math.min(cap, TEXTURE_CAP[Quality.Medium]);
  // `?texcap=512`, or `?texcap=0` for uncapped. A diagnostic only — it is how
  // the before/after of this budget is measured on one tree — and it sits
  // alongside `?quality=` and `?scale=` as harness-only overrides.
  const forcedCap = parseFloat(params.get('texcap') || '');
  if (Number.isFinite(forcedCap)) cap = forcedCap > 0 ? forcedCap : Infinity;
  setTextureBudget(cap);

  return s;
}
