import * as THREE from 'three';
import { RaceState, type Ctx, type System } from './types';
import { Bus } from './core/Bus';
import { createSettings, device } from './core/Settings';
import { Input } from './core/Input';
import { Recorder } from './core/Recorder';
import { prewarm } from './core/Prewarm';
import { FrameWatch } from './core/FrameWatch';
import { Diagnostics } from './core/Diagnostics';
import { installFeel } from './core/Feel';
import { RenderPipeline } from './render/Renderer';
import { DrawBudget } from './render/DrawBudget';
import { Sky } from './render/Sky';
import { Materials } from './render/Materials';
import { Track } from './world/Track';
import { Scenery } from './world/Scenery';
import { Effects } from './fx/Effects';
import { Items } from './game/Items';
import { Race } from './game/Race';
import { ChaseCamera } from './game/Camera';
import { HUD } from './ui/HUD';
import { Audio } from './audio/Audio';

const parent = document.getElementById('app')!;

/**
 * The size the canvas will actually be displayed at, in CSS pixels.
 *
 * Measured off `#app` (which is `position: fixed; inset: 0`) rather than read
 * from `innerWidth`/`innerHeight`, and that is a mobile correctness fix, not a
 * tidy-up. On iOS Safari `innerHeight` tracks the VISUAL viewport — it shrinks
 * and grows as the URL bar collapses, mid-gesture, by ~60 px — while a
 * `position: fixed` element is laid out against the LAYOUT viewport and does
 * not move. `renderer.setSize(w, h, true)` writes inline `style.width/height`
 * in pixels, which beats the stylesheet's `width: 100%`, so sizing from
 * `innerHeight` pinned the canvas to the smaller of the two and left an
 * unpainted strip along the bottom of the screen: a black band across part of
 * the frame, appearing and disappearing as the player scrolled their thumb.
 * That is one of the "black partial renders", and it is invisible on desktop
 * because there the two viewports are the same thing.
 *
 * Measuring the element we are about to fill has no such ambiguity, and on
 * desktop it returns exactly what `innerWidth`/`innerHeight` did.
 *
 * It does, however, introduce a failure the window never had: an ELEMENT can
 * measure zero. A `display:none` ancestor, a collapsed pane, a tab in the
 * background, or simply being read mid-layout all return 0, and the old
 * `Math.max(1, ...)` dutifully turned that into a 1x1 canvas — resizing the
 * drawing buffer AND every composer render target down to a single pixel.
 * Observed live: `canvas 2x2, css 1x1`. Coming back from that costs at least
 * one presented frame sourced from a one-pixel buffer, which is a black or
 * part-black flash. A `ResizeObserver` on the element fires on every one of
 * those transitions, so it happens often.
 *
 * So a degenerate measurement is not a size — it is the absence of one. Return
 * null and let the caller keep what it had.
 */
const MIN_SURFACE = 16;

function viewportSize(): { w: number; h: number } | null {
  let w = Math.round(parent.clientWidth || 0);
  let h = Math.round(parent.clientHeight || 0);
  // The element measuring zero does not mean the window has; fall back before
  // giving up, which covers being read mid-layout.
  if (w < MIN_SURFACE || h < MIN_SURFACE) {
    w = Math.round(innerWidth || 0);
    h = Math.round(innerHeight || 0);
  }
  if (w < MIN_SURFACE || h < MIN_SURFACE) return null;
  return { w, h };
}

const pipeline = new RenderPipeline(parent);
const input = new Input();
const sky = new Sky();
const materials = new Materials();
const track = new Track();
const scenery = new Scenery();
const effects = new Effects();
const items = new Items();
const race = new Race();
const camera = new ChaseCamera();
const hud = new HUD();
const audio = new Audio();
const drawBudget = new DrawBudget();
const frameWatch = new FrameWatch();
const diagnostics = new Diagnostics();

// At module scope the element may not be laid out yet, and viewportSize()
// correctly refuses to invent a size. A real one arrives from `resize(true)`
// during boot; this only has to be non-degenerate so the camera can be built.
const view0 = viewportSize() ?? { w: Math.max(MIN_SURFACE, innerWidth || 1280), h: Math.max(MIN_SURFACE, innerHeight || 720) };

const ctx: Ctx = {
  renderer: null as any,
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(62, view0.w / view0.h, 0.2, 3000),
  time: 0,
  dt: 0,
  frame: 0,
  width: view0.w,
  height: view0.h,
  settings: createSettings(),
  bus: new Bus(),
  input,
  track,
  race,
  items,
  envMap: null,
  sun: null,
  sunDirection: new THREE.Vector3(0.4, 0.8, 0.3).normalize(),
  shake: (a, s = 0.3) => camera.addShake(a, s),
  speedIntensity: 0,
  fovPunch: 0,
};

// `Ctx` has no slot for the shared material library, so every visual system
// reaches it through the `getMaterials()` module singleton that `Materials`
// registers in its constructor. That works, but it is invisible from the
// contract, so the instance is also published here — one place to look, and a
// safe target for a future `materials` field on `Ctx`.
(ctx as any).materials = materials;

// Init order matters and is load-bearing:
//   pipeline  — sets ctx.renderer; everything that compiles a shader or reads
//               GPU capabilities needs it first.
//   sky       — bakes the PMREM env map into ctx.envMap and sets ctx.sun /
//               ctx.sunDirection, all of which materials, scenery, water and
//               the particle lighting read at their own init.
//   materials — the shared texture/material cache; track and scenery pull from
//               it, so it has to exist (and have seen the env map) first.
//   track     — the world the rest of the game is placed on.
//   scenery   — surveys the finished track to dress it.
//   race      — builds the karts and the racing line; must be after the track.
//   items     — reads ctx.race.karts to allocate an item slot per kart, so it
//               must be after race (Race in turn only takes live references
//               off Items — the hazard array and the racing line — which are
//               valid before Items.init runs).
//   effects / camera / hud / audio — all consume the karts.
//   drawBudget — LOD and shadow culling, measured from the posed camera, so it
//               must be last: its lateUpdate has to run after the chase rig's.
const systems: System[] = [
  pipeline, input, sky, materials, track, scenery, race, items, effects, camera, hud, audio,
  drawBudget,
];

/** Human-readable names for the boot progress readout, indexed with `systems`. */
const SYSTEM_LABELS = [
  '启动画面', '准备操控', '照亮天空', '准备材质',
  '铺设赛道', '布置日式小镇', '准备赛车', '放置道具箱',
  '准备特效', '准备镜头', '准备界面', '准备声音',
  '优化画面',
];

function bootProgress(frac: number, label: string) {
  const bar = document.querySelector<HTMLElement>('.boot-bar i');
  const step = document.querySelector<HTMLElement>('.boot-step');
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  if (step) step.textContent = label;
}

async function boot() {
  for (let i = 0; i < systems.length; i++) {
    bootProgress(i / (systems.length + 1), SYSTEM_LABELS[i] ?? '加载中');
    // Yield to the compositor so the bar actually repaints between steps —
    // without this the whole loop runs inside one frame and the player sees a
    // frozen bar, which looks worse than no bar at all.
    await new Promise((r) => requestAnimationFrame(r));
    await systems[i].init?.(ctx);
  }
  frameWatch.init(ctx);
  diagnostics.init(ctx);
  installFeel();
  installResizeListeners();
  installContextRecovery();
  resize(true);

  // Compile every shader before the first frame is presented. Doing it here
  // costs a moment of boot; not doing it costs a dropped frame mid-race every
  // time a new material first appears, which reads as the screen flashing black.
  bootProgress(systems.length / (systems.length + 1), '准备画面');
  await new Promise((r) => requestAnimationFrame(r));
  const warm = await prewarm(ctx);
  console.info(
    `[prewarm] ${warm.programsBefore} -> ${warm.programsAfter} programs ` +
    `(${warm.objectsRevealed} hidden objects included) in ${warm.ms}ms`,
  );

  // Deliberately NOT race.start(): the director already sits in RaceState.Menu,
  // which is what puts the title screen and character select on screen. Booting
  // straight into a countdown skipped the entire front end — it dated from the
  // original scaffold, written before there was a front end to skip.
  bootProgress(1, '准备就绪');

  // Press R to record. Deliberately not a System: it owns no scene state and
  // must keep working while the game is paused or on a menu.
  new Recorder().install();
  // See `?scaler=`. Applied here rather than in the loop so that the very first
  // presented frame is already at the pinned resolution — a pinned run must not
  // contain a rung change of its own, which is the whole point of pinning.
  if (SCALER_PINNED) {
    scaleRung = 0;
    pipeline.setDynamicScale(SCALER_PIN_VALUE);
    console.info(`[frame] adaptive scaler PINNED at dynamic scale ${SCALER_PIN_VALUE} (?scaler=)`);
  }
  requestAnimationFrame(frame);
  (window as any).__gameReady = false;
}

/** Fades the boot curtain once a real frame is actually on screen. */
function dismissBootScreen() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 700);
}

// ---------------------------------------------------------------------------
//  Render-loop watchdog
// ---------------------------------------------------------------------------
/**
 * WebGL is not synchronous. `composer.render()` returns as soon as the frame's
 * commands are queued, not when the GPU has drawn them, so a loop that keeps
 * calling it regardless of how long the last frame actually took does not
 * "run slowly" — it runs *ahead*, piling driver-side command buffers on a
 * device that is already behind. That is how a stall turns into a crash: the
 * queue is memory, and on a phone the memory is what the browser kills the tab
 * over. It is also how a frame ends up on screen half-drawn, because the
 * compositor will present whatever surface is available when its deadline
 * arrives whether or not the rasteriser has finished with it.
 *
 * So the loop is allowed to skip a present. Skipping is cheap and it is
 * self-correcting: one skipped frame hands the GPU an entire frame's worth of
 * time with no new work, which is exactly what a backlog needs.
 */
/** A single frame this long has already missed a dozen vsyncs. Let it drain. */
const STALL_MS = 220;
/**
 * Sustained CPU cost above this (~22 fps) means the frame cannot be afforded at
 * the current resolution. The answer is FEWER PIXELS, not fewer presents.
 *
 * This used to halve the present rate, and that was the wrong trade for a
 * racing game. Presenting every other frame does not reduce the work per frame
 * at all — it just shows half of it, so a 45ms frame becomes a 90ms *picture*
 * while the simulation carries on underneath. The player reported exactly what
 * that produces: "the frame rate or something seems slower... it doesn't feel
 * as fast as the odometer". Present cadence is what the eye reads as motion.
 * Dropping internal resolution instead makes the frame genuinely cheaper and
 * keeps every frame on screen.
 *
 * It survives as the CPU-BOUND trigger only. See `FRAME_SLOW_MS` below for why
 * it cannot be the only one.
 */
const SLOW_MS = 45;
/** Resolution rungs. Each is ~30% fewer pixels than the one above. */
const SCALE_RUNGS = [1, 0.85, 0.72, 0.6, 0.5];

/**
 * ===========================================================================
 *  THE LADDER USED TO BE BLIND TO THE ONLY FRAME IT EXISTS FOR.
 * ===========================================================================
 *  `renderCostEma` is measured around `pipeline.render()`, and that call
 *  returns when the frame's GL commands are QUEUED, not when the GPU has drawn
 *  them. So on a GPU-bound frame it reports the SUBMISSION cost and nothing
 *  else. Measured on this build at 1920x1080: a 21.94 ms frame, of which 1.90
 *  ms was JS, gave `renderCostEma = 1.78`. Against `SLOW_MS = 45` that is not a
 *  near miss — it is two orders of magnitude away, and no amount of GPU
 *  overload can ever close it, because the queue drains on the other side of
 *  the measurement.
 *
 *  The whole ladder was therefore decoration on exactly the machine it was
 *  written for. Profiling found the same thing independently: 26.3% of frames
 *  dropped, render scale "1 -> 1 held for the whole window".
 *
 *  The honest signal is the one the player and the harness both read: the
 *  interval between presented frames. It is vsync-quantised — a 60 Hz display
 *  hands back 16.7 or 33.4 ms and nothing in between — so a single sample says
 *  little, but its mean is 1000/fps by construction and cannot be fooled the
 *  way the submit cost can. `fps-bench.mjs` gates on precisely this statistic.
 *
 *  Both triggers are kept and ORed: `SLOW_MS` on the submit cost still catches
 *  the CPU-bound case a frame or two sooner, and it is the one that survives if
 *  a browser ever paces rAF independently of our work.
 * ===========================================================================
 */
/**
 * Frame-interval EMA above which we are missing vsyncs often enough to be worth
 * a rung. 16.7 ms is a clean 60; 18.0 is ~56 fps, which on a 60 Hz panel means
 * roughly 8% of frames took two vsyncs — already past `fps-bench`'s 5% budget.
 *
 * Deliberately NOT a "chase the refresh rate" threshold. On a 120 Hz display a
 * healthy loop reports 8.3 ms and never trips this, which is correct: the job
 * is to protect 60, not to spend quality buying 120.
 */
const FRAME_SLOW_MS = 18.0;
/**
 * A frame at or under this counts as clean. The gap to `FRAME_SLOW_MS` is the
 * dead band — between 17.6 and 18.0 the ladder holds still rather than chatter.
 */
const FRAME_CLEAN_MS = 17.6;
/**
 * EMA weight for the frame interval. Low, because the samples are quantised to
 * whole vsyncs: at a true 55 fps the raw stream is a random mix of 16.7 and
 * 33.4, and a fast EMA would swing ±5 ms across the threshold on noise alone.
 * At 0.06 the EMA's own spread is under 1 ms and it converges ~97% within the
 * 60-frame cooldown below.
 */
const FRAME_EMA_ALPHA = 0.06;
/**
 * Resolution is not a lever on a CPU-BOUND frame, and spending it there is a
 * pure quality loss for nothing.
 *
 * `renderCostEma` is update + lateUpdate + GL submission, all of which is
 * serial with the present, so the frame can never be shorter than it. When it
 * is already most of the budget, fewer pixels cannot bring the frame under
 * 16.7 ms — it is physically impossible, not merely unlikely — so the ladder
 * holds its rung and lets the frame rate miss honestly rather than shipping a
 * soft picture that misses anyway.
 *
 * Observed live: on a machine loaded to a 20-minute load average of 81 by other
 * work, JS went from 2.3 ms to 9.1 ms with no change to the game, and the
 * ladder walked all the way to the bottom rung buying nothing. That is a
 * contended CI box, but it is also exactly the shape of a thermally-throttled
 * phone, which is the case this round has to survive.
 *
 * The threshold is deliberately below 16.7: at 13 ms of CPU there is under
 * 4 ms of headroom for every pixel in the frame, and no rung is worth that.
 */
const CPU_BOUND_MS = 13.0;
/**
 * ===========================================================================
 *  THE LADDER MAY ONLY SPEND RESOLUTION ON A FRAME THAT IS ACTUALLY THE GAME.
 * ===========================================================================
 *  Caught by the mobile A/B, and it is the more damaging of the two bugs a
 *  working ladder introduced. The menu, the character select and the countdown
 *  are not the race: `fps-bench` measures the countdown at ~53 fps against ~42
 *  for real racing precisely because it is a stationary kart under an intro
 *  camera, and boot is slower still. On a machine that is briefly busy for any
 *  reason — a cold shader cache, a contended box, a phone still unpacking the
 *  page — the ladder was walking three rungs down before the lights went out
 *  and starting the race at a resolution the race never asked for.
 *
 *  Measured on the mobile profile: the buffer reached 136x295 for a 390x844
 *  panel, which is 12% of the CSS pixel count, on a frame whose own bottleneck
 *  was JS. Every one of those rungs was spent during boot and the menu.
 *
 *  So the ladder is armed only while `RaceState.Racing`, and only after the
 *  race has run long enough for the first-lap uploads to be behind it.
 * ===========================================================================
 */
const RACING_SETTLE_FRAMES = 30;
/**
 * ===========================================================================
 *  THE LADDER'S FLOOR WAS NOT MEASURING WHAT ITS COMMENT SAID IT WAS.
 * ===========================================================================
 *  It read `settings.renderScale * SCALE_RUNGS[rung] >= 0.5` and claimed that
 *  meant "never render below half linear CSS resolution". It does not, because
 *  `renderScale` is only one of THREE factors in the buffer size the renderer
 *  actually allocates:
 *
 *      ratio = min(devicePixelRatio, maxPixelRatio) * renderScale * dynamicScale
 *
 *  So the same constant meant three different things on three machines:
 *
 *      1920x1080 dpr 1  ->  base ratio 1.00, floor 0.50x CSS
 *      1512x982  dpr 2  ->  base ratio 1.42, floor 0.71x CSS
 *      390x844   dpr 3  ->  base ratio 0.70, floor 0.35x CSS  (pre-change)
 *
 *  The phone — the device with the least resolution to give away — had the
 *  loosest floor of the three, which is exactly backwards and is half of how
 *  the mobile A/B reached a 136x295 buffer.
 *
 *  The floor is now stated in the unit it always claimed: the drawing buffer's
 *  linear size as a fraction of the page's own CSS size, read back from the GL
 *  context rather than re-derived from the settings (see `baseCssRatio` — an
 *  observation cannot drift out of sync with the renderer's formula, and it
 *  picks up the MAX_TEXTURE_SIZE clamp and the 4 Mpx backstop for free).
 *
 *  Two values, and the asymmetry is the point:
 *
 *   - A HANDHELD never renders below its own CSS resolution. On a 390 px panel
 *     the compositor's upscale is the single most visible defect in the frame —
 *     it is what "0.7x CSS, visibly soft" means — and this tier has already
 *     given up shadows, AO, DoF, motion blur, volumetrics and reflections, so
 *     resolution is the last thing left that is worth protecting rather than
 *     the first thing to spend.
 *   - Everything else keeps 0.6, which drops exactly ONE rung off the old
 *     range: 0.5. That rung is not a guess — it is the one the calibrated
 *     baseline caught red-handed. Across six unpinned 20 s runs the three that
 *     walked down to 0.5 measured 25.36 and 18.71 ms against 16.71 ms for the
 *     run that held 0.85. A quarter of the pixels, running slower. A rung with
 *     no demonstrated benefit anywhere does not belong in the range.
 * ===========================================================================
 */
const CSS_FLOOR_HANDHELD = 1.0;
const CSS_FLOOR_DEFAULT = 0.6;
/**
 * The ladder must keep at least this many rungs of authority whatever the
 * floors above work out to, or a device with a large panel relative to its tier
 * budget ends up with a ladder that cannot move at all — which is worse than a
 * slightly soft frame, because the alternative to a rung is a dropped frame.
 * Two rungs is 0.72x linear, i.e. roughly half the pixels: enough range to
 * matter, short of the region the baseline condemned.
 */
const MIN_LADDER_RUNGS = 2;
/**
 * How much a rung has to actually buy, in milliseconds of frame interval, to be
 * allowed to keep it.
 *
 * The ladder's whole justification is that fewer pixels means a shorter frame,
 * and the calibrated baseline says that is NOT reliably true on this build: the
 * descent to rung 0.5 was anti-correlated with frame time. A controller that
 * spends quality on an assumption has to check the assumption, so every descent
 * is now provisional — the frame EMA is recorded at the moment of the step, and
 * when the cooldown expires the step is kept only if the EMA actually came
 * down. If it did not, the rung is handed straight back and marked, so the
 * ladder stops paying for it.
 *
 * 0.6 ms is above the pinned run-to-run noise floor per frame (2.04 ms of
 * spread over a 20 s window is ~0.1 ms on an EMA this slow) and well below one
 * vsync, so a real saving registers and a wobble does not.
 */
const DESCENT_PAYOFF_MS = 0.6;
/**
 * A rung proved useless stays out of reach for this long. Long enough that the
 * ladder is not retrying it every few seconds; short enough that a phone which
 * genuinely thermally throttles into a different regime gets to try again.
 */
const NO_PAYOFF_LOCKOUT = 3600;
/**
 * Most rungs a single step may cross. `descendTarget()` estimates the rung it
 * needs and that estimate is only as good as the fill/fixed split it assumes —
 * the calibrated baseline puts that split at anywhere from 8.11 to 10.99 ms of
 * fill in a ~17 ms frame, so the estimate can be out by a factor of well over
 * two and it was allowed to jump straight to the floor on the strength of it.
 * Capping the leap at two rungs keeps the fast response for a genuinely
 * catastrophic frame while making an overshoot cost one cooldown instead of the
 * entire range.
 */
const MAX_JUMP_RUNGS = 2;
/**
 * Above this the ladder stops crawling and jumps straight to the rung it
 * estimates it needs.
 *
 * One rung per cooldown is right for a small miss and badly wrong for a large
 * one. Measured: on a machine running the race at 41 ms/frame the ladder needed
 * four steps to reach the bottom rung and, at 60 frames of cooldown each, spent
 * TEN SECONDS of a twenty-second race descending — so most of the race was
 * played at a resolution already known to be unaffordable, and every rung
 * change reallocates the composer's buffers on the way. The A/B that caught it
 * scored the crawling build WORSE than no ladder at all.
 *
 * 25 ms is `fps-bench`'s own dropped-frame threshold and is chosen for a
 * second reason: above it the frame is genuinely full, so `frameEma -
 * renderCostEma` is real GPU cost rather than mostly vsync idle, and the
 * estimate below is trustworthy. Below it the ladder crawls, which is the safe
 * behaviour near the target.
 */
const FRAME_JUMP_MS = 25.0;

/**
 * Frames between resolution changes. Every change reallocates the composer's
 * buffers, so reacting instantly to a transient would cost more than the
 * transient did. It must also be longer than the EMA takes to reflect the new
 * resolution, or the ladder reads its own stale average and overshoots.
 */
const SCALE_COOLDOWN = 60;
/** Longer after a step UP: an over-eager probe is what the player sees pumping. */
const RECOVER_COOLDOWN = 120;
/**
 * ===========================================================================
 *  WHY RECOVERY IS A PROBE AND NOT A THRESHOLD.
 * ===========================================================================
 *  The frame interval is capped by vsync, so it can tell us we are too slow but
 *  never how much headroom we have: a machine with 2 ms to spare and one with
 *  10 ms both report exactly 16.7. A symmetric "recover below X ms" rule is
 *  therefore unimplementable on this signal — the old `RECOVER_MS = 26` only
 *  looked implementable because it read the submit cost, which is not capped
 *  and also not the frame.
 *
 *  So going back up is a guess that has to be TESTED: hold the rung until a
 *  long run of clean frames says the machine is comfortable, step up one, and
 *  see. If that step is followed by a drop soon after, the guess was wrong and
 *  the next probe waits twice as long. That backoff is what keeps a machine
 *  sitting exactly on the boundary — the thermally-throttled phone this round
 *  cares about most — from oscillating: after three failures it is probing once
 *  a minute, which is invisible, instead of every six seconds, which is not.
 * ===========================================================================
 */
const PROBE_FRAMES_MIN = 360;
const PROBE_FRAMES_MAX = 3600;
/** A drop this soon after a step up means the step up caused it. */
const PROBE_FAIL_WINDOW = 900;
/**
 * Clean frames are counted with a leak rather than reset outright, so one hitch
 * does not throw away a good streak while a steady trickle of dropped frames
 * still never accumulates: at a 10% drop rate the counter loses ground every
 * ten frames and can never reach the probe threshold.
 */
const CLEAN_LEAK = 30;
/** The watchdog stays out of the way until the scene has settled. */
const WATCHDOG_FROM_FRAME = 30;

/** EMA of the CPU cost of frames we actually presented, milliseconds. */
let renderCostEma = 16.7;
/** EMA of the interval between presented frames — what the player actually sees. */
let frameEma = 16.7;
/** Leaky count of consecutive on-time frames; feeds the recovery probe. */
let cleanFrames = 0;
/** Clean frames required before the next step up. Doubles on a failed probe. */
let probeFrames = PROBE_FRAMES_MIN;
/** Frame number of the last step up, so a drop can be blamed on it. */
let lastProbeFrame = -PROBE_FAIL_WINDOW;
/** Consecutive presented frames spent in RaceState.Racing. Arms the ladder. */
let racingFrames = 0;
/** Did the previous rAF tick present? An interval across a skip is not a frame. */
let lastTickPresented = false;
/** Frames still to skip presenting. */
let skipRender = 0;
/** Index into SCALE_RUNGS; 0 is full resolution. */
let scaleRung = 0;
let scaleCooldown = 0;
/**
 * The rung the last descent came FROM, or -1 when no descent is under
 * assessment. See DESCENT_PAYOFF_MS: a descent is provisional until its
 * cooldown expires and the frame EMA is compared against what it was.
 */
let descendFromRung = -1;
/** `frameEma` at the instant of that descent — the number the rung has to beat. */
let descendFromEma = 0;
/** Shallowest rung proved to buy nothing, or -1. See NO_PAYOFF_LOCKOUT. */
let noPayoffRung = -1;
/** Frame the lockout above started on. */
let noPayoffFrame = 0;
/** Descents kept / handed back, for the harnesses. Counts, not times. */
let descentsKept = 0;
let descentsReverted = 0;
/**
 * ===========================================================================
 *  `?scaler=` — PIN THE ADAPTIVE LADDER, SO A MEASUREMENT CAN BE ATTRIBUTED.
 * ===========================================================================
 *  The ladder exists to protect frame rate by spending resolution, and that is
 *  the right behaviour for a player. It is ruinous for a MEASUREMENT: the
 *  headline "59 fps desktop" this build reports is bought by rendering
 *  1632x918 instead of 1920x1080, and the number moves because the ladder
 *  moved, not because the frame got cheaper. Two runs of the same build landed
 *  on rungs 0.85 and 0.5 and reported 59.9 and 39.4 fps.
 *
 *  Worse, it makes the two halves of an A/B incomparable: an optimisation that
 *  genuinely saves 2 ms lets the ladder hold a HIGHER rung, so it draws more
 *  pixels and reports the same frame rate. The saving is real and completely
 *  invisible. Every A/B in this repo has to pin this or it is measuring the
 *  controller, not the change.
 *
 *      ?scaler=off     ladder never moves; stays at SCALE_RUNGS[0] = 1.0
 *      ?scaler=0.72    ladder never moves; pinned at that dynamic scale
 *
 *  `off` is the one to use for a full-quality baseline. The numeric form
 *  exists so the resolution/frame-time curve can be swept by hand, which is
 *  the only honest way to answer "is this frame fill-bound", because the
 *  ladder answering it for you is what hid the answer in the first place.
 *
 *  Deliberately NOT `?debug=`: that parameter selects one diagnostic mode and
 *  `?debug=frames` already means something else (it turns on
 *  `preserveDrawingBuffer`, which costs frame time and would poison exactly
 *  the measurement this flag is for).
 * ===========================================================================
 */
const SCALER_PARAM = new URLSearchParams(location.search).get('scaler');
/** True when the ladder must never call `setDynamicScale` again. */
const SCALER_PINNED = SCALER_PARAM !== null && SCALER_PARAM !== '';
/**
 * The scale to hold when pinned. `off` means full resolution; a number pins
 * that value. Anything unparseable pins 1.0 rather than silently resuming
 * adaptation, because a typo must not turn a pinned run back into a moving
 * one without saying so.
 *
 * Clamped to the SAME 0.5..1 range `setDynamicScale` enforces, so the value
 * reported by `__loopHealth` is the value that was applied. To sweep below
 * 0.5 use `?scale=` (the tier's own `renderScale`, 0.25..2) together with
 * `?scaler=off` — that rebuilds the effect chain once at boot, which is
 * exactly right for a pinned run and wrong for an adaptive one.
 */
const SCALER_PIN_VALUE = (() => {
  if (!SCALER_PINNED) return 1;
  const v = parseFloat(SCALER_PARAM as string);
  return Number.isFinite(v) && v > 0 ? THREE.MathUtils.clamp(v, 0.5, 1) : 1;
})();
let stallCount = 0;
let renderFailures = 0;
/** Set between context loss and a completed restore; nothing runs meanwhile. */
let suspended = false;

/**
 * Draw calls attributable to the SCENE, not the post chain.
 *
 * `renderer.info.render.calls` is reset by three at the top of every
 * `render()`, and the composer's final fullscreen pass is the last one in the
 * frame — so sampling after `composer.render()` reports the quad and nothing
 * else. The pipeline records the scene-pass count for us; fall back to the raw
 * counter when there is no composer.
 */
function sceneDrawCalls(): number {
  const recorded = (pipeline as unknown as { lastSceneCalls?: number }).lastSceneCalls;
  if (typeof recorded === 'number') return recorded;
  return ctx.renderer?.info.render.calls ?? 0;
}

/**
 * The drawing buffer's linear size as a multiple of the page's own CSS size, at
 * rung 0 — i.e. what this device renders at with the ladder out of the way.
 *
 * READ BACK, NOT RE-DERIVED. `Renderer.effectivePixelRatio()` folds together
 * devicePixelRatio, `maxPixelRatio`, `renderScale`, `dynamicScale`, a
 * MAX_TEXTURE_SIZE clamp and a 4 Mpx backstop, and a copy of that expression
 * living over here would be one edit away from disagreeing with it silently —
 * which is the failure mode this whole round is cleaning up. Dividing the
 * buffer the driver actually allocated by the rung currently applied cannot
 * drift, because it is the same number the compositor is upscaling from.
 *
 * Falls back to 1 (the "no supersampling, no upscaling" assumption) if the
 * context is gone or the surface is degenerate, which keeps the floors below
 * conservative rather than accidentally unlocking the bottom of the range.
 */
function baseCssRatio(): number {
  const gl = ctx.renderer?.getContext?.();
  const bufW = gl?.drawingBufferWidth ?? 0;
  const ds = pipeline.dynamicScale || 1;
  if (bufW <= 0 || ctx.width <= 0) return 1;
  return bufW / ctx.width / ds;
}

/**
 * Lowest rung index the ladder may descend to on this device. See
 * CSS_FLOOR_HANDHELD / CSS_FLOOR_DEFAULT for the floors, MIN_LADDER_RUNGS for
 * why the floor cannot be allowed to lock the ladder solid, and
 * `noPayoffRung` for the rung a failed descent has taken off the table.
 */
function lowestRung(): number {
  const base = baseCssRatio();
  const floor = device().handheld ? CSS_FLOOR_HANDHELD : CSS_FLOOR_DEFAULT;
  let i = SCALE_RUNGS.length - 1;
  while (i > 0 && base * SCALE_RUNGS[i] < floor - 1e-6) i--;
  // Never fewer than MIN_LADDER_RUNGS of range, and never past the array.
  i = Math.min(SCALE_RUNGS.length - 1, Math.max(i, MIN_LADDER_RUNGS));
  // A rung that was tried and bought nothing is out of reach until the lockout
  // expires; everything below it is too, because it is on the far side of it.
  if (noPayoffRung > 0 && ctx.frame - noPayoffFrame < NO_PAYOFF_LOCKOUT) {
    i = Math.min(i, noPayoffRung - 1);
  }
  return Math.max(0, i);
}

/**
 * The rung to drop to. See FRAME_JUMP_MS for why this is not always `+1`.
 *
 * The estimate assumes per-frame cost splits into a part that scales with the
 * pixel count and a part that does not (`renderCostEma`, which is CPU and
 * serial with everything). Fill cost goes as the SQUARE of the linear scale, so
 * the scale that would fit the remaining budget is
 * `current * sqrt(budget / pixelCost)`. It is only ever used to pick from the
 * fixed rung list, and the recovery probe walks back up if it overshoots.
 */
function descendTarget(): number {
  const floor = lowestRung();
  if (scaleRung + 1 > floor) return scaleRung;
  if (frameEma <= FRAME_JUMP_MS) return scaleRung + 1;
  const pixelCost = Math.max(1, frameEma - renderCostEma);
  const budget = Math.max(2, FRAME_CLEAN_MS - renderCostEma);
  const want = SCALE_RUNGS[scaleRung] * Math.sqrt(budget / pixelCost);
  let target = scaleRung + 1;
  while (target < floor && SCALE_RUNGS[target] > want) target++;
  // See MAX_JUMP_RUNGS. The estimate above is worth a fast response, not the
  // whole range on one reading.
  return Math.min(target, scaleRung + MAX_JUMP_RUNGS, floor);
}

/**
 * Settle the provisional descent recorded by the last step down.
 *
 * Called once, the frame the cooldown reaches zero — by which point the EMA has
 * had SCALE_COOLDOWN frames at alpha FRAME_EMA_ALPHA to converge ~97% onto the
 * new resolution, which is what that cooldown is sized for. If the rung bought
 * less than DESCENT_PAYOFF_MS it is handed straight back and locked out.
 *
 * Returns true if it changed the rung, so the caller knows to skip its own
 * decision this frame.
 */
function settleDescent(): boolean {
  if (descendFromRung < 0) return false;
  const from = descendFromRung;
  const before = descendFromEma;
  descendFromRung = -1;
  if (frameEma <= before - DESCENT_PAYOFF_MS) {
    descentsKept++;
    return false;
  }
  // It bought nothing. Give the pixels back and stop asking for a while.
  descentsReverted++;
  noPayoffRung = scaleRung;
  noPayoffFrame = ctx.frame;
  scaleRung = from;
  scaleCooldown = RECOVER_COOLDOWN;
  cleanFrames = 0;
  pipeline.setDynamicScale(SCALE_RUNGS[scaleRung]);
  console.warn(
    `[frame] render scale ${SCALE_RUNGS[noPayoffRung]} bought ` +
    `${(before - frameEma).toFixed(2)}ms of ${DESCENT_PAYOFF_MS}ms needed ` +
    `(${before.toFixed(1)} -> ${frameEma.toFixed(1)}ms); reverting to ` +
    `${SCALE_RUNGS[scaleRung]} and locking that rung out`,
  );
  return true;
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);

  const raw = (now - last) / 1000;
  last = now;

  // Context gone, or the tab is not being composited. Do not simulate, do not
  // draw, do not allocate — just keep the rAF alive so we notice when the world
  // comes back. (A hidden tab on iOS is the single most likely moment for the
  // GPU to reclaim our context, and continuing to queue frames into a surface
  // nobody is presenting is the worst possible way to spend that window.)
  if (suspended || document.hidden || pipeline.contextLost) {
    // The next tick's rAF delta spans however long we were away, which is not a
    // frame interval. Say so, or the ladder reads a backgrounded tab as a stall.
    lastTickPresented = false;
    return;
  }

  // Clamp so a stalled tab or a breakpoint never teleports anything.
  // `__freeze` holds the simulation still while the screenshot harness retries a
  // torn capture: rendering continues, so the compositor can produce a clean
  // frame, but nothing advances — otherwise a retry lands seconds down the road
  // and the shot no longer shows what it was aimed at.
  const frozen = (window as any).__freeze === true;
  const dt = frozen ? 0 : Math.min(raw, 1 / 20);
  ctx.dt = dt;
  ctx.time += dt;
  ctx.frame++;

  const t0 = performance.now();

  for (const s of systems) s.update?.(ctx, dt);
  for (const s of systems) s.lateUpdate?.(ctx, dt);

  // The harness is entitled to a present on every frozen frame — retrying a
  // torn capture is the whole reason `__freeze` exists — and so are the first
  // few frames, which is where `__gameReady` and the boot curtain are decided.
  const maySkip = !frozen && ctx.frame > WATCHDOG_FROM_FRAME;
  let presented = false;
  // Nothing usable can be presented onto a surface that is hidden or collapsed,
  // and attempting it is how a one-pixel buffer reaches the compositor. The
  // simulation keeps running; only the present is withheld.
  if (!surfaceValid && maySkip) {
    // no present this frame
  } else if (skipRender > 0 && maySkip) {
    skipRender--;
  } else {
    presented = true;
    try {
      pipeline.render(ctx);
      renderFailures = 0;
      frameWatch.afterPresent(ctx);
      // Scene draws only — the post chain's fullscreen quads always run, so
      // counting everything would mask exactly the failure we are watching for.
      diagnostics.afterPresent(ctx, sceneDrawCalls());
    } catch (err) {
      renderFailures++;
      console.error(`[frame] render threw (${renderFailures} in a row)`, err);
      // A chain that throws once per frame is a black rectangle with a busy
      // CPU. Retreat to the direct render — which is a real, legible frame —
      // rather than keep failing in a more sophisticated way.
      if (renderFailures === 4) pipeline.disablePostProcessing('render threw four frames running');
      if (renderFailures >= 24) {
        console.error('[frame] renderer is not recoverable; suspending the loop');
        // The last frame that did draw stays on screen underneath. A stale
        // picture of the game with an explanation over it is a far better
        // failure than a black rectangle and a pegged CPU.
        pipeline.announce('画面已停止', '请刷新页面重新开始。');
        suspended = true;
      }
    }
  }

  if (presented) {
    const cost = performance.now() - t0;
    renderCostEma += (cost - renderCostEma) * 0.12;

    // Only a racing frame is a frame the ladder may reason about. Outside the
    // race the averages are HELD rather than fed, so the menu's cost never
    // reaches them and a second race starts from what the first one learned.
    const racing = ctx.race.state === RaceState.Racing;
    racingFrames = racing ? racingFrames + 1 : 0;

    // The interval only describes a frame the player saw if the tick before it
    // also presented, the clock was running, and it is not a tab-switch hole.
    const intervalMs = raw * 1000;
    const usable = racing && lastTickPresented && !frozen &&
      intervalMs > 1 && intervalMs < 100;
    if (usable) {
      frameEma += (intervalMs - frameEma) * FRAME_EMA_ALPHA;
      cleanFrames = intervalMs <= FRAME_CLEAN_MS && frameEma <= FRAME_CLEAN_MS
        ? cleanFrames + 1
        : Math.max(0, cleanFrames - CLEAN_LEAK);
    }

    if (cost > STALL_MS) {
      stallCount++;
      // Log the first few and then go quiet — a stall storm must not turn into
      // a console-write storm, which is itself a stall.
      if (stallCount <= 5) {
        console.warn(`[frame] ${Math.round(cost)}ms frame; skipping the next present to drain`);
      }
      skipRender = 1;
    } else if (ctx.frame <= WATCHDOG_FROM_FRAME) {
      // Boot frames are enormous — shader pre-warm, first-use uploads, the
      // PMREM bake — and they poison the average. Measured: the scaler dropped
      // a rung at frame 9 off a 56ms EMA that was entirely startup cost, on a
      // machine that then ran at 8ms. Hold both averages at the target until the
      // scene has actually settled.
      renderCostEma = 16.7;
      frameEma = 16.7;
      cleanFrames = 0;
    } else if (SCALER_PINNED) {
      // See `?scaler=`. The averages above are still maintained, so a pinned run
      // reports the frame cost it is ACTUALLY paying via `__loopHealth`; it just
      // never spends resolution to change it.
    } else if (racingFrames < RACING_SETTLE_FRAMES) {
      // Not racing, or not racing for long enough yet. See RACING_SETTLE_FRAMES.
    } else if (scaleCooldown > 0) {
      // The cooldown after a step down is also its ASSESSMENT window. When it
      // expires, the rung has to justify itself or it is handed back.
      if (--scaleCooldown === 0) settleDescent();
    } else if ((frameEma > FRAME_SLOW_MS || renderCostEma > SLOW_MS) &&
               // See CPU_BOUND_MS. `SLOW_MS` is exempt because at 45ms of
               // submission the loop is running away and the rung is the least
               // of it — dropping is still the right reflex there.
               (renderCostEma < CPU_BOUND_MS || renderCostEma > SLOW_MS) &&
               // See CSS_FLOOR_*. The next rung down may not exist on this
               // device even though the array has one — and it may have been
               // locked out by a descent that bought nothing.
               scaleRung < lowestRung()) {
      // If we only just stepped up, the step up is the reason we are here. Make
      // the next probe wait twice as long before guessing again.
      if (ctx.frame - lastProbeFrame < PROBE_FAIL_WINDOW) {
        probeFrames = Math.min(PROBE_FRAMES_MAX, probeFrames * 2);
      }
      // Provisional. See DESCENT_PAYOFF_MS — `settleDescent()` reads both of
      // these back when the cooldown expires and reverses the step if the
      // pixels bought nothing.
      descendFromRung = scaleRung;
      descendFromEma = frameEma;
      scaleRung = descendTarget();
      scaleCooldown = SCALE_COOLDOWN;
      cleanFrames = 0;
      pipeline.setDynamicScale(SCALE_RUNGS[scaleRung]);
      console.warn(
        `[frame] ${frameEma.toFixed(1)}ms between presented frames ` +
        `(submit ${renderCostEma.toFixed(1)}ms); render scale -> ${SCALE_RUNGS[scaleRung]} ` +
        `(every frame still presented)`,
      );
    } else if (scaleRung > 0 && cleanFrames >= probeFrames) {
      scaleRung--;
      scaleCooldown = RECOVER_COOLDOWN;
      cleanFrames = 0;
      lastProbeFrame = ctx.frame;
      pipeline.setDynamicScale(SCALE_RUNGS[scaleRung]);
      console.info(
        `[frame] ${Math.round(probeFrames / 60)}s of clean frames at ${frameEma.toFixed(1)}ms; ` +
        `probing render scale -> ${SCALE_RUNGS[scaleRung]}`,
      );
    }
  }
  lastTickPresented = presented;

  if (ctx.frame === 8) {
    (window as any).__gameReady = true;
    dismissBootScreen();
  }
}

// ---------------------------------------------------------------------------
//  Resize
// ---------------------------------------------------------------------------
/**
 * Resize events are coalesced to one per animation frame and dropped entirely
 * when the size has not moved.
 *
 * iOS Safari fires `resize` continuously — dozens of events — while the URL bar
 * animates, on rotation, and whenever the on-screen keyboard appears. Each one
 * used to reach `composer.setSize`, which reallocates the HDR input and output
 * buffers, the AO targets, the entire bloom mip chain, the bokeh targets and
 * the SMAA buffers. Tens of megabytes of GPU allocation, tens of times, inside
 * one thumb gesture, on the device the player says crashes after ten seconds.
 *
 * `visualViewport` is listened to as well as `window`, because on iOS it is the
 * one that reports the URL-bar movement — and a `ResizeObserver` on `#app`
 * catches anything neither of them announces.
 */
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
}

function installResizeListeners() {
  addEventListener('resize', queueResize);
  addEventListener('orientationchange', queueResize);
  visualViewport?.addEventListener('resize', queueResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(queueResize).observe(parent);
}

/**
 * @param force push the size through even when it has not changed. Boot needs
 *   this: `ctx.width`/`ctx.height` are seeded from the same measurement, so an
 *   unconditional early-out would mean no system ever received its first
 *   `resize()` and every layout that is only computed there — the HUD's safe
 *   area, the minimap box — would keep whatever it guessed at construction.
 */
/**
 * True while the display surface is unusable (hidden pane, background tab,
 * mid-layout). The frame loop skips presenting rather than pushing a frame
 * built from stale or degenerate buffers.
 */
let surfaceValid = true;

function resize(force = false) {
  const size = viewportSize();
  if (size === null) {
    // Hidden or collapsed. Deliberately do NOT resize: tearing the buffers down
    // to 1x1 is what produced the black flash. Keep everything as it is and
    // wait to be shown again.
    surfaceValid = false;
    return;
  }
  const { w, h } = size;
  const wasInvalid = !surfaceValid;
  surfaceValid = true;
  if (!force && !wasInvalid && w === ctx.width && h === ctx.height) return;
  ctx.width = w;
  ctx.height = h;
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  for (const s of systems) s.resize?.(w, h);
}

// ---------------------------------------------------------------------------
//  WebGL context loss
// ---------------------------------------------------------------------------
/**
 * `RenderPipeline` handles the GL side — `preventDefault()` on the loss event
 * (without which the browser never offers a restore at all), tearing down the
 * composer, and rebuilding it against the new context. What is left here is
 * everything above the pipeline:
 *
 *   - the frame loop, which must stop on the same tick the context goes;
 *   - the PMREM environment probe, which is the one GPU resource in the game
 *     three cannot re-derive. Its texture is reallocated automatically but
 *     comes back EMPTY, because its contents were rendered once at boot: every
 *     metal, every clearcoat and every water surface in the game would have
 *     come back reflecting black;
 *   - the shader pre-warm, because the program cache died with the context and
 *     without it the first thirty seconds after a restore hitch exactly the way
 *     the first thirty seconds after a cold boot used to.
 */
function installContextRecovery() {
  pipeline.onContextLost = () => {
    suspended = true;
  };
  pipeline.onContextRestored = async () => {
    // Re-bake the sky into the environment probe. Costs a six-face render plus
    // a PMREM chain — the same price it pays at boot, and for the same reason.
    //
    // The `envRT` clear is a workaround for a latent bug in Sky.ts, which this
    // round is the first thing ever to call `refreshEnvironment()` on and which
    // therefore threw the first time it was asked to:
    //
    //   `PMREMGenerator._fromTexture` reads
    //     `const cubeUVRenderTarget = renderTarget || this._allocateTargets();`
    //   and `_allocateTargets()` is what creates `_lodMeshes`, `_blurMaterial`,
    //   `_ggxMaterial` and the ping-pong target. `Sky.buildEnvironment` builds a
    //   FRESH `PMREMGenerator` on every call and hands it the target from last
    //   time, so on the second call the allocation is skipped and
    //   `_textureToCubeUV` runs `this._lodMeshes[0].material = material` against
    //   an empty array — "Cannot set properties of undefined (setting
    //   'material')", which is exactly what the restore path logged.
    //
    // Dropping the cached target makes the generator allocate, which is the
    // right thing on this path anyway: the old target's GPU allocation died
    // with the context. The proper fix is in Sky.ts (reuse the generator, or
    // stop reusing the target) and belongs to whoever owns that file.
    try {
      (sky as unknown as { envRT: THREE.WebGLRenderTarget | null }).envRT = null;
      sky.refreshEnvironment(ctx);
    } catch (err) {
      console.error('[restore] environment re-bake failed', err);
    }

    try {
      const warm = await prewarm(ctx);
      console.info(`[restore] re-warmed ${warm.programsBefore} -> ${warm.programsAfter} programs in ${warm.ms}ms`);
    } catch (err) {
      console.error('[restore] pre-warm failed; expect compile hitches', err);
    }

    // Hand the simulation a fresh clock. Without this the first frame back sees
    // however many seconds the restore took as its delta — the clamp in the
    // loop stops it teleporting anything, but the watchdog would read that one
    // frame as a catastrophic stall and start skipping presents on a pipeline
    // that is in fact perfectly healthy.
    last = performance.now();
    renderCostEma = 16.7;
    frameEma = 16.7;
    cleanFrames = 0;
    probeFrames = PROBE_FRAMES_MIN;
    lastProbeFrame = -PROBE_FAIL_WINDOW;
    lastTickPresented = false;
    racingFrames = 0;
    skipRender = 0;
    scaleRung = 0;
    scaleCooldown = 0;
    // The provisional-descent bookkeeping describes a GPU that no longer
    // exists. Carrying a lockout across a context restore would leave the new
    // context permanently barred from a rung it has never tried.
    descendFromRung = -1;
    descendFromEma = 0;
    noPayoffRung = -1;
    noPayoffFrame = 0;
    // A restore must come back to the resolution the run was PINNED at, not to
    // 1.0 — otherwise `context-loss-test.mjs` and a pinned bench disagree about
    // what was being measured either side of the loss.
    pipeline.setDynamicScale(SCALER_PINNED ? SCALER_PIN_VALUE : 1);
    renderFailures = 0;
    suspended = false;
  };
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  document.body.innerHTML =
    `<pre style="color:#f66;padding:24px;font:13px ui-monospace">启动失败，请重新打开游戏。</pre>`;
});

// Expose for the screenshot harness / debugging.
(window as any).__ctx = ctx;
// tools/perf.mjs turns this off to measure the un-LODed field for a before/after.
(window as any).__drawBudget = drawBudget;
(window as any).__camRig = camera; // TEMP-PROBE
// Watchdog state, for the perf and soak harnesses: how many frames overran, and
// what resolution rung the adaptive scaler has settled on.
(window as any).__loopHealth = () => ({
  frame: ctx.frame,
  renderCostEma: +renderCostEma.toFixed(2),
  // The signal the ladder actually acts on. `renderCostEma` is submission cost
  // and is ~1.8ms on a GPU-bound 22ms frame; this one is the frame.
  frameEma: +frameEma.toFixed(2),
  cleanFrames,
  probeFrames,
  racingFrames,
  renderScale: SCALE_RUNGS[scaleRung],
  scaleRung,
  // Deterministic ladder counters — counts, not milliseconds, so they are
  // readable under load. `lowestRung` is what the CSS floor works out to on
  // this device; `baseCssRatio` is the buffer/CSS ratio at rung 0, which is the
  // number "is the phone sharp?" actually asks about.
  lowestRung: lowestRung(),
  baseCssRatio: +baseCssRatio().toFixed(3),
  descentsKept,
  descentsReverted,
  noPayoffRung,
  // Reported so a harness can VERIFY the pin took rather than assume it. This
  // repo has shipped a frame-rate knob wired to nothing at all; a flag whose
  // effect cannot be read back is the same bug waiting to happen.
  scalerPinned: SCALER_PINNED,
  dynamicScale: pipeline?.dynamicScale ?? 1,
  stalls: stallCount,
  renderFailures,
  suspended,
  contextLost: pipeline.contextLost,
});
