/**
 * ============================================================================
 *  SHARED CONTRACTS — read this before touching any module.
 * ============================================================================
 *  Every subsystem in this game implements `System`. Systems receive the same
 *  mutable `Ctx` object. Nothing imports another subsystem's concrete class:
 *  everything talks through the interfaces declared here, reached via `ctx`.
 *
 *  DO NOT change a signature in this file without saying so loudly — several
 *  modules are authored in parallel against it.
 * ============================================================================
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export const enum Surface {
  Road = 0,
  Dirt = 1,
  Grass = 2,
  Sand = 3,
  Boost = 4,
  OffTrack = 5, // out of bounds — respawn territory
  Water = 6,
}

/** Per-surface handling constants. Physics reads these; nothing else writes. */
export interface SurfaceProps {
  gripMul: number;
  dragMul: number;
  maxSpeedMul: number;
  /** vertical amplitude of the rumble applied to the chassis, in metres */
  rumble: number;
  /** particle/dust colour emitted from wheels on this surface */
  dustColor: THREE.Color;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

/** A frame of reference on the track centreline. */
export interface TrackSample {
  /** centreline position, world space */
  pos: THREE.Vector3;
  /** unit forward along the racing direction */
  tangent: THREE.Vector3;
  /** unit up, already rotated by the banking angle */
  normal: THREE.Vector3;
  /** unit right = tangent x normal */
  binormal: THREE.Vector3;
  /** half-width of the drivable road at this point, metres */
  halfWidth: number;
  /** banking angle in radians (positive = right side raised) */
  bank: number;
  /** arc-length distance from the start line, metres */
  distance: number;
  /** normalised progress [0,1) */
  t: number;
}

/** Result of probing the world under a point. */
export interface SurfaceProbe {
  /** ground height at the query point */
  y: number;
  /** ground normal, unit */
  normal: THREE.Vector3;
  surface: Surface;
  /** signed lateral offset from centreline; negative = left, metres */
  lateral: number;
  /** normalised track progress of the projection */
  t: number;
  /** |lateral| / halfWidth — <=1 means on the road proper */
  edgeRatio: number;
}

export interface ITrack extends System {
  /** total centreline arc length, metres */
  readonly length: number;
  /** scene graph root holding the road, kerbs, walls and terrain */
  readonly group: THREE.Group;
  /** grid slots, index 0 = pole position */
  readonly startGrid: { pos: THREE.Vector3; yaw: number }[];
  /** number of checkpoints that must be crossed in order per lap */
  readonly checkpointCount: number;

  /** evaluate the centreline frame at normalised progress t (wraps) */
  sample(t: number): TrackSample;
  /** evaluate at arc length in metres (wraps) */
  sampleByDistance(d: number): TrackSample;

  /**
   * Probe the surface under `p`.
   * `hintT` is the last known progress of the querying entity; supplying it
   * keeps the search local, which is what makes overlapping/looping track
   * sections resolve correctly. Pass -1 if unknown (does a global search).
   */
  probe(p: THREE.Vector3, hintT: number): SurfaceProbe;

  /** Which checkpoint index a given normalised progress belongs to. */
  checkpointAt(t: number): number;

  /** Push a point back inside the walls. Returns null if no collision. */
  collideWalls(p: THREE.Vector3, radius: number, hintT: number): { push: THREE.Vector3; normal: THREE.Vector3 } | null;

  /** Sampled centreline polyline for the minimap, in XZ. */
  minimapPath(samples: number): { x: number; z: number }[];
  /** World-space AABB of the whole track, for minimap normalisation. */
  readonly bounds: THREE.Box3;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputState {
  /** -1 (full left) .. 1 (full right), already smoothed & dead-zoned */
  steer: number;
  /** 0..1 */
  accel: number;
  /**
   * True when `accel` is being supplied by the auto-accelerate assist rather
   * than by the player asking for it.
   *
   * Anything that reads a held throttle as a DECISION has to know the
   * difference. The rocket start does: holding through the countdown either
   * boosts you off the line or, held too long, burns you out with a
   * `spinOut`. Auto-accelerate is on by default on touch, so it held the
   * throttle for the whole ~3 s countdown — past the 1.75 s burnout window —
   * and every single race on a phone began with a guaranteed spin.
   */
  accelAuto: boolean;
  /** 0..1 */
  brake: number;
  /** held this frame */
  drift: boolean;
  /** rising edge of drift this frame */
  driftPressed: boolean;
  /** rising edge of item use this frame */
  itemPressed: boolean;
  /** rising edge — look behind */
  lookBack: boolean;
  /** rising edge — pause / confirm */
  pausePressed: boolean;
  anyPressed: boolean;
}

export interface IInput extends System {
  readonly state: InputState;
  /** true if the player is on a touch device and the virtual pad is shown */
  readonly touch: boolean;
}

// ---------------------------------------------------------------------------
// Karts
// ---------------------------------------------------------------------------

export interface KartStats {
  name: string;
  /** display colour of the racer, used by HUD, minimap and paint */
  color: THREE.Color;
  accelMul: number;
  topSpeedMul: number;
  weightMul: number;
  handlingMul: number;
}

/** Everything another system may read from a kart. Physics owns the writes. */
export interface IKart {
  readonly id: number;
  readonly isPlayer: boolean;
  readonly stats: KartStats;

  /** root object — position is the chassis centre of mass */
  readonly object: THREE.Object3D;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** world-space linear velocity, m/s */
  readonly velocity: THREE.Vector3;
  /** metres per second along the kart's own forward axis */
  readonly forwardSpeed: number;
  /** unit forward in world space */
  readonly forward: THREE.Vector3;

  /** normalised lap progress [0,1) */
  t: number;
  lap: number;
  /** 1-based finishing order position */
  place: number;
  finished: boolean;
  /** total race distance travelled — the sort key for placement */
  raceDistance: number;

  // --- drift / boost state, read by VFX + HUD ---
  /** 0 = not drifting, otherwise -1 (left) or 1 (right) */
  driftDir: number;
  /** 0..1 charge toward the next mini-turbo tier */
  driftCharge: number;
  /** 0 = none, 1 = blue, 2 = orange, 3 = purple */
  driftTier: number;
  /** seconds of boost remaining */
  boostTime: number;
  airborne: boolean;
  /** seconds remaining of a spin-out / squash / stun */
  stunTime: number;
  /** star power invulnerability, seconds */
  starTime: number;

  readonly surface: Surface;
  readonly wheels: THREE.Object3D[];

  // --- commands other systems may issue ---
  applyBoost(seconds: number, strength?: number): void;
  spinOut(seconds: number): void;
  squash(seconds: number): void;
  launch(impulse: THREE.Vector3): void;
  respawn(): void;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const enum ItemKind {
  None = 0,
  Mushroom = 1,
  TripleMushroom = 2,
  GreenShell = 3,
  RedShell = 4,
  Banana = 5,
  Star = 6,
  Bolt = 7,
  Bomb = 8,
}

export interface IItems extends System {
  /** roll an item appropriate to `place` (1 = leading) */
  roll(place: number, racers: number): ItemKind;
  /** the item a kart is currently holding */
  held(kart: IKart): { kind: ItemKind; count: number };
  give(kart: IKart, kind: ItemKind, count?: number): void;
  /** fire/drop whatever the kart holds; returns false if it holds nothing */
  use(kart: IKart, backwards: boolean): boolean;
  /** open the roulette on the HUD for this kart */
  pickup(kart: IKart): void;
}

// ---------------------------------------------------------------------------
// Race director
// ---------------------------------------------------------------------------

export const enum RaceState {
  Menu = 0,
  Countdown = 1,
  Racing = 2,
  Finished = 3,
  Results = 4,
  Paused = 5,
}

export interface IRace extends System {
  readonly state: RaceState;
  readonly karts: IKart[];
  readonly player: IKart;
  readonly totalLaps: number;
  /** seconds since the lights went out */
  readonly raceTime: number;
  /** 3,2,1,GO — the integer shown during the countdown; 0 during GO */
  readonly countdown: number;
  /** completed lap times for the player, seconds */
  readonly lapTimes: number[];
  readonly standings: IKart[];
  /** Index into `karts` of the machine the human is driving. */
  readonly selectedKart: number;
  /**
   * Hand the player a different kart from the roster. The select screen had no
   * way to say this, so it moved a highlight and nothing else — every race was
   * driven in kart 0 whatever the player clicked.
   *
   * Takes effect on the next `reset()`/`start()`. Karts are built once at
   * `init` (the model, livery and driver are baked from `stats`), so this moves
   * which existing kart is the player's rather than rebuilding anything, and
   * the grid slot moves with it so picking the last racer does not start you
   * last.
   */
  selectKart(index: number): void;
  start(): void;
  reset(): void;
  /**
   * Pause / resume from the UI. The director owns `RaceState.Paused`, so the
   * pause screen's own buttons cannot get out of it by clearing a local flag —
   * they have to say so here.
   */
  setPaused(paused: boolean): void;
}

// ---------------------------------------------------------------------------
// Effects / audio hooks — fire-and-forget events any system may raise
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'drift-spark'; kart: IKart; tier: number }
  | { type: 'boost'; kart: IKart; tier: number }
  | { type: 'hop'; kart: IKart }
  | { type: 'land'; kart: IKart; impact: number }
  | { type: 'collide'; kart: IKart; other: IKart | null; impulse: number }
  | { type: 'item-pickup'; kart: IKart }
  | { type: 'item-use'; kart: IKart; kind: ItemKind }
  | { type: 'hit'; kart: IKart; kind: ItemKind }
  | { type: 'lap'; kart: IKart; lap: number }
  | { type: 'finish'; kart: IKart; place: number }
  | { type: 'countdown'; n: number }
  | { type: 'coin'; kart: IKart }
  | { type: 'ui'; name: string };

export type EventHandler = (e: GameEvent) => void;

export interface IBus {
  emit(e: GameEvent): void;
  on(h: EventHandler): () => void;
}

// ---------------------------------------------------------------------------
// Quality tiers — every visual system must honour these
// ---------------------------------------------------------------------------

export const enum Quality {
  Low = 0,
  Medium = 1,
  High = 2,
  Ultra = 3,
}

export interface Settings {
  quality: Quality;
  /** device pixel ratio cap */
  maxPixelRatio: number;
  shadows: boolean;
  ssao: boolean;
  bloom: boolean;
  motionBlur: boolean;
  dof: boolean;
  /** render at a fraction of native res and upscale */
  renderScale: number;
  volumetrics: boolean;
  reflections: boolean;
  particleDensity: number;
  foliageDensity: number;
  masterVolume: number;
}

// ---------------------------------------------------------------------------
// System lifecycle + the shared context
// ---------------------------------------------------------------------------

export interface System {
  /** called once, in dependency order, before the first frame */
  init?(ctx: Ctx): void | Promise<void>;
  /** called every frame with a clamped delta */
  update?(ctx: Ctx, dt: number): void;
  /** called after all updates, before render — camera/UI sync lives here */
  lateUpdate?(ctx: Ctx, dt: number): void;
  resize?(w: number, h: number): void;
  dispose?(): void;
}

export interface Ctx {
  // --- engine ---
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** seconds since boot */
  time: number;
  /** clamped frame delta, seconds */
  dt: number;
  frame: number;
  width: number;
  height: number;
  settings: Settings;
  bus: IBus;

  // --- subsystems, populated during boot ---
  input: IInput;
  track: ITrack;
  race: IRace;
  items: IItems;

  /** environment map produced by the sky system, for PBR */
  envMap: THREE.Texture | null;
  /** the key light, so systems can align shadow cascades / flares */
  sun: THREE.DirectionalLight | null;
  /** normalised direction TOWARD the sun */
  sunDirection: THREE.Vector3;

  // --- effect requests, honoured by render/camera ---
  /** additive screen shake, decays automatically */
  shake(amount: number, seconds?: number): void;
  /** 0..1, drives speed lines, FOV punch and radial blur */
  speedIntensity: number;
  /** extra FOV in degrees added by boost, smoothed by the camera */
  fovPunch: number;
}

// ---------------------------------------------------------------------------
// Handy shared constants
// ---------------------------------------------------------------------------

export const SURFACE_PROPS: Record<Surface, SurfaceProps> = {
  [Surface.Road]:     { gripMul: 1.0,  dragMul: 1.0, maxSpeedMul: 1.0,  rumble: 0.0,   dustColor: new THREE.Color(0x9aa0a6) },
  [Surface.Dirt]:     { gripMul: 0.78, dragMul: 1.5, maxSpeedMul: 0.82, rumble: 0.035, dustColor: new THREE.Color(0xa87d4e) },
  [Surface.Grass]:    { gripMul: 0.70, dragMul: 2.1, maxSpeedMul: 0.68, rumble: 0.028, dustColor: new THREE.Color(0x7fa855) },
  [Surface.Sand]:     { gripMul: 0.62, dragMul: 2.6, maxSpeedMul: 0.60, rumble: 0.045, dustColor: new THREE.Color(0xe0cfa0) },
  [Surface.Boost]:    { gripMul: 1.0,  dragMul: 0.6, maxSpeedMul: 1.35, rumble: 0.0,   dustColor: new THREE.Color(0xffd36b) },
  [Surface.OffTrack]: { gripMul: 0.55, dragMul: 3.2, maxSpeedMul: 0.5,  rumble: 0.05,  dustColor: new THREE.Color(0x8b8b8b) },
  [Surface.Water]:    { gripMul: 0.45, dragMul: 4.0, maxSpeedMul: 0.35, rumble: 0.02,  dustColor: new THREE.Color(0xbfe6ff) },
};

/** metres per second at 100% throttle on road, before stat multipliers */
export const BASE_TOP_SPEED = 30;
export const LAP_COUNT = 3;
export const RACER_COUNT = 8;
