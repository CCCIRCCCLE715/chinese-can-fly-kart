/**
 * ============================================================================
 *  Shader pre-warm.
 * ============================================================================
 *  three compiles a GPU program the first time a material is actually rendered.
 *  That compile is synchronous on the GL thread, and a big one blows the frame
 *  budget several times over — measured here at up to 56ms, against a 16.7ms
 *  budget. The browser then misses its compositing deadline and presents a
 *  partially-updated surface, which the player sees as part of the screen
 *  flashing black.
 *
 *  It shows up exactly where a new material first appears: picking up an item,
 *  firing a shell, the first explosion, or turning into a stretch of circuit
 *  whose props have not been on screen before. Nine programs were still
 *  compiling during the first half-minute of racing.
 *
 *  So every program is compiled up front instead, before the first frame is
 *  presented. Three things make this less trivial than calling `compileAsync`:
 *
 *  1. Pooled and deferred objects — items, projectiles, particle bursts — sit
 *     in the scene with `visible = false`. `compile()` walks materials with a
 *     plain `traverse` so visibility does not actually matter for them, but it
 *     gathers LIGHTS with `traverseVisible`, and the light counts are part of
 *     the program cache key. So everything is made visible for the duration of
 *     the warm-up and restored after, or a hidden light silently changes the
 *     key of every lit material in the scene.
 *  2. A material's program depends on the LIGHTS it is rendered with and on
 *     which shadow cascades exist, so the warm-up has to run against the real
 *     scene and the real camera, after lighting is built — not against a
 *     throwaway scene.
 *  3. **The program cache key depends on the framebuffer being rendered into.**
 *     This is what round 7 was still leaking three programs through, and it is
 *     worth spelling out because it is invisible from the call site.
 *
 *     `WebGLPrograms.getParameters()` reads `renderer.getRenderTarget()` twice:
 *
 *       outputColorSpace: currentRenderTarget === null
 *         ? renderer.outputColorSpace          // 'srgb'
 *         : ColorManagement.workingColorSpace  // 'srgb-linear'
 *       toneMapping: material.toneMapped && currentRenderTarget === null
 *         ? renderer.toneMapping : NoToneMapping
 *
 *     Both go straight into `getProgramCacheKey`. `renderer.compile()` does not
 *     bind anything, so a pre-warm run at boot compiles every material for the
 *     DEFAULT FRAMEBUFFER — sRGB output, ACES tone map baked into the shader.
 *     The game never renders there: `RenderPipeline` hands the scene to the
 *     post-processing composer, whose RenderPass binds an HDR render target, so
 *     every material's real program is the linear / NoToneMapping variant.
 *
 *     Every program compiled by the old pre-warm was therefore the wrong one,
 *     and the right one was still built lazily on first render. Most materials
 *     hid that because their meshes are on screen during the first few frames,
 *     behind the boot curtain and before the measurement window opens. The ones
 *     that do not — the tunnel bore, the tunnel light strip, the arched bridge —
 *     are frustum-culled until the player physically arrives at them, so their
 *     compile landed mid-race. That is the 56ms frame.
 *
 *     The fix is to bind a render target for the duration of the compile so the
 *     two key inputs match the real scene pass. Any non-XR target will do: only
 *     `=== null` is tested, never the target's size or format, so a 1x1 scratch
 *     buffer produces exactly the programs the composer will ask for.
 *
 *  Subsystems that own a material which is NOT reachable from the scene graph
 *  at boot — an art set for a projectile kind that has never spawned, say —
 *  push it through `registerPrewarm()`. Anything registered that the scene walk
 *  does not already account for gets a throwaway host object for the duration
 *  of the pass. Nothing is ever drawn through it: `compileAsync` builds programs
 *  and never issues a draw call, so a host with none of the material's custom
 *  attributes is perfectly safe.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';

export interface PrewarmResult {
  programsBefore: number;
  programsAfter: number;
  objectsRevealed: number;
  /** labels of materials nothing in the scene referenced, so we hosted them */
  materialsCaged: string[];
  /** which framebuffer(s) the compile ran against */
  surfaces: string[];
  /** programs added by the forced shadow-depth pass (see `warmShadowDepth`) */
  depthPrograms: number;
  /** geometries whose vertex buffers were uploaded (see `warmGeometryUpload`) */
  geometriesWarmed: number;
  ms: number;
}

// ---------------------------------------------------------------------------
//  Registry
// ---------------------------------------------------------------------------

interface Request {
  material: THREE.Material;
  /** true if the material is ever drawn through an InstancedMesh */
  instanced: boolean;
  label: string;
}

const REQUESTS: Request[] = [];

/**
 * Declare a material that MUST have a compiled program before the first frame.
 *
 * Call this for anything built at init but not attached to an object in the
 * scene — a pooled art set, or a variant only one code path ever reaches.
 * Materials already on a mesh in the scene may be registered too; the pass sees
 * they are covered and skips them, so registering is always safe and is the
 * cheapest way to make the guarantee explicit rather than incidental.
 *
 * @param instanced pass true when the material's only real host is an
 *   `InstancedMesh` — `instancing` is part of the program cache key, and a
 *   plain host would compile the wrong variant.
 */
export function registerPrewarm(
  material: THREE.Material | null | undefined,
  opts: { instanced?: boolean; label?: string } = {},
): void {
  if (!material) return;
  const instanced = opts.instanced === true;
  for (const r of REQUESTS) if (r.material === material && r.instanced === instanced) return;
  REQUESTS.push({
    material,
    instanced,
    label: opts.label ?? (material.name || material.type),
  });
}

/** Drop every registration. Only a full teardown/rebuild should need this. */
export function clearPrewarmRegistry(): void {
  REQUESTS.length = 0;
}

/**
 * One degenerate triangle carrying the three attributes every stock three
 * shader expects. Custom attributes an injected shader declares (`aTint`,
 * `aUv`, the particle interleaved block) may be absent: an undeclared vertex
 * attribute reads as zero in GL and compiles fine, and this geometry is never
 * drawn through.
 */
function hostGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  g.setIndex([0, 1, 2]);
  return g;
}

/**
 * Does the scene pass render into a target, or straight to the canvas?
 *
 * `RenderPipeline` publishes itself on `globalThis.__render` (the same contract
 * the perf and capture harnesses use) and exposes `composer`, which is non-null
 * exactly when the scene is rasterised into the composer's HDR buffer. Reading
 * it here rather than importing the pipeline keeps this module free of a
 * dependency on the renderer's internals — and if it is not there we simply
 * warm both surfaces rather than guess.
 */
function scenePassSurface(): 'target' | 'canvas' | 'unknown' {
  try {
    const pipe = (globalThis as { __render?: { composer?: unknown } }).__render;
    if (pipe && typeof pipe === 'object' && 'composer' in pipe) {
      return pipe.composer ? 'target' : 'canvas';
    }
  } catch {
    /* fall through to the both-surfaces path */
  }
  return 'unknown';
}

/**
 * Compile the SHADOW-DEPTH programs, which `compile()` does not touch.
 *
 * Every shadow caster is drawn a SECOND time, into the shadow map, through a
 * different material — three's internal `MeshDepthMaterial`, or the object's
 * `customDepthMaterial` — and that second material has its own program with its
 * own cache key. `WebGLRenderer.compile()` only ever walks `object.material`, so
 * not one of those depth programs exists when the pre-warm reports success.
 *
 * That stays hidden while every caster is inside the shadow camera on frame
 * one, which is behind the boot curtain. What is left is whatever enters the
 * shadow frustum later: measured here, `banner-cloth` compiled its depth
 * program at **t=9.6s of racing**, a 20ms frame in the middle of a lap, and
 * exactly the class of stall this module exists to remove.
 *
 * There is no API for "compile the depth variant", so the pass is provoked
 * rather than requested. Three things are needed, and the third is the one that
 * is easy to miss:
 *
 * 1. **Drive the shadow pass directly.** `WebGLShadowMap.render(lights, scene,
 *    camera)` draws through `renderer.renderBufferDirect(shadowCamera, null, …)`
 *    — the identical call the real pass makes, so the cache keys match. It must
 *    run straight after `compileAsync`, which leaves `currentRenderState`
 *    populated; called cold, `setProgram` dereferences a null render state.
 *
 *    Not a whole `renderer.render()`. A full frame also works, but its colour
 *    pass draws the pre-warm cage — real materials on a degenerate triangle
 *    with none of their textures bound — and that spat 35+ `GL_INVALID_OPERATION:
 *    Mismatch between texture format and sampler type` warnings per boot.
 *    Measured on this path: zero, same as before the change.
 *
 * 2. **Switch off frustum culling scene-wide** for the duration. The shadow
 *    pass tests `!object.frustumCulled || frustum.intersectsObject(object)`, so
 *    with culling off every caster in the world is drawn once, including the
 *    half of the circuit the camera has not reached yet.
 *
 * 3. **Force the program to be re-derived per caster.** three mutates ONE
 *    shared `_depthMaterial` as it walks the casters — `result.map =
 *    material.map`, `result.alphaTest = …`, `result.side = …` — and never
 *    touches `material.version`. `setProgram`'s change detection lists
 *    instancing, skinning, morphs, fog, envMap, tone mapping and light state,
 *    but *not* the material's textures, so every caster after the first is
 *    drawn with whatever program the first one produced. The banner's map sits
 *    on UV channel 1 (`vertexUv1s` → `#define USE_UV1`, a genuinely different
 *    shader), so its variant was never built here — it was built mid-race, the
 *    first time something else bumped the shared material's version while the
 *    banner's map happened to be the one installed. Setting `needsUpdate` per
 *    draw makes three ask the question once per caster instead.
 *
 *    That in turn means programs are ACQUIRED and RELEASED in a chain: three
 *    releases a material's previous program when it acquires a new one, and a
 *    release that takes `usedTimes` to zero deletes the program outright. Each
 *    variant we warm would therefore be freed by the next one. So the depth
 *    programs are pinned with one extra `usedTimes` on the way out — a
 *    pre-warmed program that the next draw can garbage-collect is not
 *    pre-warmed.
 *
 * 4. **Make every mesh a caster** for the duration. A mesh that does not cast
 *    today may still own the only copy of a depth variant — and it costs one
 *    depth draw per mesh into a shadow map that is invalidated on the way out.
 *
 * Shadow-casting is off entirely at `Quality.Low`, which is the tier a phone
 * gets, so none of this runs there. The geometry upload that used to be folded
 * into this pass therefore lives in `warmGeometryUpload`, which does not depend
 * on shadows at all.
 */
function warmShadowDepth(ctx: Ctx): void {
  const renderer = ctx.renderer;
  const shadowMap = renderer.shadowMap as THREE.WebGLShadowMap & {
    render?: (lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera) => void;
  };
  if (!shadowMap.enabled || typeof shadowMap.render !== 'function') return;

  // The lights a real frame would hand it: `WebGLRenderer.projectObject` pushes
  // a light into the shadows array when it casts one and passes the camera's
  // layer test. Everything is visible at this point in the pre-warm, which is
  // what we want — a caster only the second light sees still needs its program.
  const lights: THREE.Light[] = [];
  ctx.scene.traverse((o) => {
    const l = o as THREE.Light;
    if (l.isLight === true && l.castShadow === true && l.layers.test(ctx.camera.layers)) {
      lights.push(l);
    }
  });
  if (lights.length === 0) return;

  const culled: THREE.Object3D[] = [];
  const notCasting: THREE.Object3D[] = [];
  ctx.scene.traverse((o) => {
    if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
    // Every mesh casts for the duration, not just the ones that really do. See
    // the note on vertex-buffer upload above: this is how a geometry that only
    // ever appears in the colour pass still gets its VBOs created here.
    if ((o as THREE.Mesh).isMesh === true && o.castShadow === false) {
      notCasting.push(o);
      o.castShadow = true;
    }
  });

  type BufferDraw = (
    camera: THREE.Camera, scene: THREE.Scene | null, geometry: THREE.BufferGeometry,
    material: THREE.Material, object: THREE.Object3D, group: unknown,
  ) => void;
  const host = renderer as unknown as { renderBufferDirect: BufferDraw };
  const passThrough = host.renderBufferDirect;
  const prevAutoUpdate = shadowMap.autoUpdate;
  const warmed = new Set<THREE.Material>();
  // Which programs already existed. Only the ones this pass ADDS need pinning —
  // see the note below on why pinning all of them is a leak rather than
  // belt-and-braces.
  const preExisting = new Set<unknown>(renderer.info.programs ?? []);

  host.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    // See (3) above: without this, one program serves every caster.
    if (material !== undefined && material !== null) {
      material.needsUpdate = true;
      warmed.add(material);
    }
    return passThrough.call(this, camera, scene, geometry, material, object, group);
  };

  try {
    shadowMap.autoUpdate = true;
    shadowMap.needsUpdate = true;
    shadowMap.render(lights, ctx.scene, ctx.camera);
  } finally {
    host.renderBufferDirect = passThrough;
    shadowMap.autoUpdate = prevAutoUpdate;
    for (const o of culled) o.frustumCulled = true;
    for (const o of notCasting) o.castShadow = false;
    // Hold on to every variant just built. `releaseProgram` deletes at zero, and
    // a shared depth material only ever points at its most recent one.
    //
    // ONLY THE ONES THIS PASS BUILT. This used to walk the whole cache and
    // increment everything, which pins the ~120 COLOUR programs too — and those
    // are not orphans in need of a reference, they are already held by the
    // materials that own them. The extra count is never released by anything,
    // so a program whose material is later disposed (a quality change, an
    // effect-chain rebuild, a scenery set torn down) can never reach zero and
    // its GL object stays resident for the life of the context. Depth programs
    // are the only ones with no owner to hold them, because three mutates one
    // shared `_depthMaterial` across every caster; those still get their pin.
    //
    // Measured at Ultra: 99 programs pinned -> 20, which is exactly the 20 the
    // pass reports as `depth=+20`. At Quality.Low it is 0 either way — shadows
    // are off there and this whole function returns before it starts.
    for (const p of renderer.info.programs ?? []) {
      if (preExisting.has(p)) continue;
      const prog = p as unknown as { usedTimes: number };
      if (typeof prog.usedTimes === 'number') prog.usedTimes++;
    }
    warmed.clear();
    // The maps now hold a pass drawn with culling off. Ask for them again so
    // the first real frame shadows the view the player is actually given.
    shadowMap.needsUpdate = true;
  }
}

/**
 * Upload every geometry's vertex buffers, by drawing the world once through a
 * depth override.
 *
 * A `BufferGeometry` is a JS object until something renders it.
 * `WebGLGeometries.get()` runs on the first draw — that is when the VBOs are
 * created, and when `renderer.info.memory.geometries` increments. So a lap that
 * reveals new parts of the circuit walks that counter up: measured on the
 * mobile soak, **114 at t=0 and 182 at t=60s**. Nothing is built at runtime
 * (the scene holds the same 182 geometries throughout); those are 68 first-draw
 * buffer uploads landing on the frames where the player turns a corner, and
 * they also trip the soak's growth gate. After this pass the counter is flat.
 *
 * Two details make it safe:
 *
 * - **`scene.overrideMaterial`**, so every object is drawn through one
 *   `MeshDepthMaterial`. Drawing the scene through its own lit materials also
 *   uploads the buffers, and that is what this tried first — it emitted 35+
 *   `GL_INVALID_OPERATION: Mismatch between texture format and sampler type
 *   (…/shadow)` warnings per boot, from lit materials sampling shadow maps in a
 *   state the frame loop never puts them in. A depth material samples no shadow
 *   map. Measured on this path: zero GL warnings, same as before any of this.
 *   `WebGLObjects.update()` uploads EVERY attribute the geometry owns, not just
 *   the ones the bound shader reads, so a depth draw is still a full upload.
 *
 * - **A 1x1 target**, so the vertices are transformed and essentially nothing
 *   is rasterised. The shadow pass is held off for the duration; `warmShadowDepth`
 *   has already done that work where it applies.
 */
function warmGeometryUpload(ctx: Ctx, target: THREE.WebGLRenderTarget, cage: THREE.Object3D): void {
  const renderer = ctx.renderer;
  const culled: THREE.Object3D[] = [];
  ctx.scene.traverse((o) => {
    if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
  });

  const cageWasVisible = cage.visible;
  const prevOverride = ctx.scene.overrideMaterial;
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  const prevShadowNeeds = renderer.shadowMap.needsUpdate;
  const override = new THREE.MeshDepthMaterial();

  try {
    cage.visible = false;
    ctx.scene.overrideMaterial = override;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(target);
    renderer.render(ctx.scene, ctx.camera);
  } finally {
    ctx.scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    cage.visible = cageWasVisible;
    for (const o of culled) o.frustumCulled = true;
    override.dispose();
  }
}

// ---------------------------------------------------------------------------

export async function prewarm(ctx: Ctx): Promise<PrewarmResult> {
  const t0 = performance.now();
  const renderer = ctx.renderer;
  const programsBefore = renderer.info.programs?.length ?? 0;

  // Reveal everything hidden, remembering what to put back. Pooled effects and
  // unspawned items are invisible by default; more importantly, `compile()`
  // collects lights with `traverseVisible`, and the light counts are in the
  // cache key of every lit material.
  const hidden: THREE.Object3D[] = [];
  ctx.scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });

  // Which materials the scene walk will already cover.
  const present = new Set<THREE.Material>();
  ctx.scene.traverse((o) => {
    const m = (o as Partial<THREE.Mesh>).material;
    if (Array.isArray(m)) for (const x of m) present.add(x);
    else if (m) present.add(m);
  });

  // Host anything registered that nothing in the scene refers to.
  const cage = new THREE.Group();
  cage.name = 'prewarm-hosts';
  const materialsCaged: string[] = [];
  let geo: THREE.BufferGeometry | null = null;
  for (const r of REQUESTS) {
    if (present.has(r.material)) continue;
    if (geo === null) geo = hostGeometry();
    const host = r.instanced
      ? new THREE.InstancedMesh(geo, r.material, 1)
      : new THREE.Mesh(geo, r.material);
    host.frustumCulled = false;
    host.castShadow = true;
    host.receiveShadow = true;
    cage.add(host);
    present.add(r.material);
    materialsCaged.push(r.label);
  }
  if (cage.children.length > 0) ctx.scene.add(cage);

  // Frustum culling is not applied by the compiler, but layers are: an object
  // the camera cannot see on its layer mask is skipped. Widen for the pass.
  const cameraLayers = ctx.camera.layers.mask;
  ctx.camera.layers.enableAll();

  // Bind the framebuffer the scene is really rasterised into, so the compiled
  // programs carry the same `outputColorSpace` and `toneMapping` the first real
  // render will ask for. See the header — this is the whole ballgame.
  const prevTarget = renderer.getRenderTarget();
  const prevCubeFace = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  let scratch: THREE.WebGLRenderTarget | null = null;
  const surfaces: string[] = [];
  let programsBeforeDepth = 0;
  let depthPrograms = 0;
  let geometriesBefore = 0;
  let geometriesWarmed = 0;

  try {
    const surface = scenePassSurface();
    // Only `=== null` is ever tested, so the scratch target's size and format
    // are irrelevant; 1x1 costs four bytes and one framebuffer object.
    // If we cannot tell, warm both and finish on the target variant: whichever
    // one three primed LAST is the one `materialProperties.currentProgram`
    // points at, and the composer path is the one every WebGL2 device takes.
    // Landing on the wrong one still costs only a cache lookup on frame 1, not
    // a compile — both programs exist by then.
    const order: ('target' | 'canvas')[] =
      surface === 'unknown' ? ['canvas', 'target'] : [surface];
    for (const s of order) {
      if (s === 'target') {
        if (scratch === null) scratch = new THREE.WebGLRenderTarget(1, 1);
        renderer.setRenderTarget(scratch);
      } else {
        renderer.setRenderTarget(null);
      }
      surfaces.push(s);
      // compileAsync uses KHR_parallel_shader_compile where available, so the
      // compiles overlap instead of serialising — worth the async plumbing.
      await renderer.compileAsync(ctx.scene, ctx.camera);
    }
    // Now the depth variants, which the loop above provably does not build.
    programsBeforeDepth = renderer.info.programs?.length ?? 0;
    geometriesBefore = renderer.info.memory.geometries;
    warmShadowDepth(ctx);
    depthPrograms = (renderer.info.programs?.length ?? 0) - programsBeforeDepth;

    // And the vertex buffers, which nothing above uploads at every tier.
    if (scratch === null) scratch = new THREE.WebGLRenderTarget(1, 1);
    warmGeometryUpload(ctx, scratch, cage);
    geometriesWarmed = renderer.info.memory.geometries - geometriesBefore;
  } catch (err) {
    // A failed pre-warm must never stop the game booting; the worst case is
    // simply the hitching we had before.
    console.warn('[prewarm] compile failed, continuing without it', err);
  } finally {
    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMip);
    scratch?.dispose();
  }

  ctx.camera.layers.mask = cameraLayers;
  if (cage.parent !== null) cage.removeFromParent();
  cage.clear();
  geo?.dispose();
  for (const o of hidden) o.visible = false;

  // The surface is the part worth seeing in a log: 'canvas' where the composer
  // is live means the pre-warm is compiling programs the game will never use.
  console.info(
    `[prewarm] surface=${surfaces.join('+') || 'none'} depth=+${depthPrograms} ` +
    `geo=${geometriesBefore}+${geometriesWarmed}` +
    (materialsCaged.length ? ` hosted=[${materialsCaged.join(', ')}]` : ''),
  );

  return {
    programsBefore,
    programsAfter: renderer.info.programs?.length ?? 0,
    objectsRevealed: hidden.length,
    materialsCaged,
    surfaces,
    depthPrograms,
    geometriesWarmed,
    ms: Math.round(performance.now() - t0),
  };
}
