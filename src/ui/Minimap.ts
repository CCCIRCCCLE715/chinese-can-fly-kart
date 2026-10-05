/**
 * Minimap — the real centreline from ITrack.minimapPath(), normalised by
 * ITrack.bounds.
 *
 * ROUND 8. The round-1 review's words: "the minimap does not read instantly …
 * at 247 px it reads as a shoelace or a zipper rather than a circuit", and
 * "'ring = you' means nothing". Four faults, four fixes:
 *
 *  1. IT HAD TWO VALUES, NOT THREE. Round 7's ribbon was a light body with a
 *     near-black casing on a near-black plate: the casing and the ground were
 *     the same value, so the road had no edge and read as a soft noodle with a
 *     dashed line through it — a shoelace, in the review's words. The well now
 *     carries a deep TEAL ground, the casing is the dark, the core is the
 *     light, and the dashed centreline (which is what made it read as a zipper
 *     at 247 px) is gone. Each §1 section shifts the core's value, so the loop
 *     has landmarks instead of being a generic kidney.
 *
 *  2. IT WAS ARBITRARILY ORIENTED. The path went straight from world XZ to
 *     canvas XY, so the circuit sat at whatever angle the level designer
 *     happened to lay it out at and wasted most of the panel. The path is now
 *     fitted by its own principal axis (a 2x2 covariance eigenvector — closed
 *     form, computed once) so the long axis of the circuit lies along the long
 *     axis of the panel, and then flipped so the racing direction across the
 *     start line runs left-to-right. Fixed orientation, north-up-equivalent,
 *     baked once.
 *
 *  3. "RING = YOU" MEANT NOTHING. Round 7 ringed the player AND both rivals
 *     adjacent in the order, so three of nine markers were ringed and the one
 *     affordance for finding yourself was destroyed. There is exactly one ring
 *     in this system and it is the player's. The player is 1.8x the rival
 *     diameter (§7's "larger dot"), filled with their own livery colour, with
 *     a heading chevron struck into it in ink; rivals are told apart by livery
 *     colour alone.
 *
 *  4. IT WAS ON THE KART. It lived bottom-centre; the chase camera parks the
 *     player's kart and the road's vanishing point in exactly that column.
 *     ART_DIRECTION §7 permits "bottom-centre or top-centre" — it is top-centre
 *     now, over a band that is sky in every one of the ten review frames.
 *
 * The ribbon is baked once into an offscreen canvas and blitted each frame;
 * only the racer markers are re-rasterised per frame.
 */
import type { Ctx, IKart } from '../types';
import { el, clamp, cssColor } from './uiUtil';

/** Dense enough that the village esses and the banked 180 survive. */
const SAMPLES = 720;
/** fraction of the panel reserved as margin, after rotation */
const PAD = 0.085;

/**
 * Ribbon and marker weights, in CSS px at the reference panel height, scaled
 * by `this.u` so a 720p and a 1440p frame get the same PROPORTIONS rather than
 * the same pixels.
 */
const REF_H = 132;
const TRACK_W = 3.4;      // the bright core
const TRACK_CASE = 5.2;   // the dark casing the core sits inside
const TRACK_COL = '#f6f0e2';           // §3 kerb white, lifted — never #ffffff
/** ROUND 10: the casing ink is WARM (hue 22°), like every other ink in the
 *  HUD now — a 220° near-black hairline was the last cool edge on the panel. */
const CASE_COL = '#0e0803';
/**
 * The well's own ground. It is the one place in the HUD that is allowed to
 * stay cool, and it is cool because it is WATER: §3's sea-deep `#0d5a7a`
 * taken two stops down, inside a warm plate. Read as the bay from above, not
 * as a product-UI panel — which is exactly the distinction the review drew.
 */
const WELL_A = '#0f4257';
const WELL_B = '#06202e';

/**
 * SECTION TINT — ART_DIRECTION §1's lap table, as value.
 *
 * The round-1 map was a generic kidney with no landmark identity, so you could
 * not tell where on the course you were. Each named section now shifts the
 * ribbon's core value a little: the tunnel goes dark, the bridge and the
 * banked coastal curve go bright, the harbour straight is the base. It is a
 * dozen pixels of contrast and it turns the loop into a place.
 */
const SECTIONS: { t0: number; t1: number; col: string }[] = [
  { t0: 0.00, t1: 0.10, col: '#fffaf0' },  // start straight / harbour front
  { t0: 0.10, t1: 0.52, col: TRACK_COL },  // harbour sweep -> cliff traverse
  { t0: 0.52, t1: 0.60, col: '#7e8ba0' },  // tunnel — the one dark run
  { t0: 0.60, t1: 0.74, col: '#f0dfbd' },  // beach descent, sand-lined
  { t0: 0.74, t1: 0.86, col: '#fffaf0' },  // banked coastal curve, the money shot
  { t0: 0.86, t1: 1.00, col: '#dfe9ee' },  // bridge & return, cool stone
];

/** Marker radii. §7 asks for the player as a larger dot; this is 1.8x. */
const RIVAL_R = 4.4;
const PLAYER_R = 7.9;
/** minimum centre-to-centre separation as a multiple of the summed radii */
const SEPARATION = 1.35;

export class Minimap {
  readonly root: HTMLDivElement;
  private well: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private baseG: CanvasRenderingContext2D;

  private path: { x: number; z: number }[] = [];
  private built = false;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** device px per reference CSS px — dpr folded together with panel scale */
  private u = 1;

  // world -> canvas mapping. `rc`/`rs` are the cos/sin of the fitted rotation.
  private sx = 1;
  private cx = 0;
  private cz = 0;
  private ox = 0;
  private oy = 0;
  private rc = 1;
  private rs = 0;
  /** rotated-space extents of the path, world units */
  private spanU = 1;
  private spanV = 1;

  /** cached livery colours, so we never build a string in the draw loop */
  private colors: string[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'kr-map kr-plate', parent);
    // The same WELL idiom the item box uses — one recessed graphic surface in
    // the system, not two.
    this.well = el('div', 'kr-well', this.root);
    this.canvas = el('canvas', undefined, this.well);
    this.g = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.baseG = this.base.getContext('2d')!;
  }

  /**
   * Principal-axis fit. The 2x2 covariance of the centreline has a closed-form
   * dominant eigenvector, so this is a dozen flops and runs exactly once. The
   * result is the angle that lays the circuit's long axis flat.
   */
  private fitRotation() {
    const p = this.path;
    const n = p.length;
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += p[i].x; mz += p[i].z; }
    mx /= n; mz /= n;
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < n; i++) {
      const dx = p[i].x - mx, dz = p[i].z - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    // angle of the dominant eigenvector of [[sxx,sxz],[sxz,szz]]
    let a = 0.5 * Math.atan2(2 * sxz, sxx - szz);

    // Direction: the racing line crossing the start/finish must run to the
    // RIGHT on screen. Without this the same circuit can bake mirrored between
    // runs, and a map you have to read backwards is worse than no map.
    const q = p[Math.min(6, n - 1)];
    const tx = q.x - p[0].x, tz = q.z - p[0].z;
    if (Math.cos(a) * tx + Math.sin(a) * tz < 0) a += Math.PI;

    // Rotating by -a puts the dominant axis on +u.
    this.rc = Math.cos(-a);
    this.rs = Math.sin(-a);
    this.cx = mx;
    this.cz = mz;

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = p[i].x - mx, dz = p[i].z - mz;
      const u = dx * this.rc - dz * this.rs;
      const v = dx * this.rs + dz * this.rc;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    // Recentre on the fitted box, not on the centroid: a circuit with a long
    // spur is not centred on its mean.
    const uc = (uMin + uMax) * 0.5;
    const vc = (vMin + vMax) * 0.5;
    this.cx = mx + (uc * this.rc + vc * this.rs);
    this.cz = mz + (-uc * this.rs + vc * this.rc);
    this.spanU = Math.max(1, uMax - uMin);
    this.spanV = Math.max(1, vMax - vMin);
  }

  private tryBuild(ctx: Ctx) {
    const b = ctx.track.bounds;
    if (!(b.max.x - b.min.x > 1) || !(b.max.z - b.min.z > 1)) return false;
    this.path = ctx.track.minimapPath(SAMPLES);
    if (this.path.length < 8) return false;
    this.fitRotation();
    this.built = true;
    this.colors = ctx.race.karts.map((k) => cssColor(k.stats.color));
    return true;
  }

  /**
   * The panel is a FIXED box in ui.css (--map-w x --map-h) and the canvas
   * fills its well exactly. Round 6 derived the panel's width from the track's
   * aspect at runtime, so the top rail's geometry depended on level data and
   * changed shape one frame after boot.
   */
  resize() {
    const r = this.well.getBoundingClientRect();
    const cssW = r.width;
    const cssH = r.height;
    if (cssW < 32 || cssH < 24) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.w = Math.round(cssW * this.dpr);
    this.h = Math.round(cssH * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.u = this.dpr * clamp(cssH / REF_H, 0.62, 2.0);
    this.base.width = this.w;
    this.base.height = this.h;
    if (this.built) this.bake();
  }

  private project(x: number, z: number, out: { x: number; y: number }) {
    const dx = x - this.cx, dz = z - this.cz;
    out.x = this.ox + (dx * this.rc - dz * this.rs) * this.sx;
    out.y = this.oy + (dx * this.rs + dz * this.rc) * this.sx;
  }

  /** Bake the static ground + ribbon + start line. Called on build and resize. */
  private bake() {
    const g = this.baseG;
    const W = this.w, H = this.h;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.built || W < 4) return;

    const usableW = W * (1 - PAD * 2);
    const usableH = H * (1 - PAD * 2);
    this.sx = Math.min(usableW / this.spanU, usableH / this.spanV);
    this.ox = W * 0.5;
    this.oy = H * 0.5;

    const p = this.path;
    const n = p.length;
    const s = this.scratch;
    const d = this.u;

    // --- THE GROUND --------------------------------------------------------
    // Round 1's ribbon had "no edge contrast against the near-black plate",
    // and that is a value problem, not a weight problem: the casing and the
    // plate were the same near-black, so the road had no defined edge and
    // dissolved into a soft noodle. Three values are needed and there were
    // two. The well now carries a deep TEAL ground (§3's sea family, lit from
    // the top like everything else), the casing is the dark, and the core is
    // the light — so the ribbon has a real edge on both sides.
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, WELL_A);
    bg.addColorStop(1, WELL_B);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    const trace = (from: number, to: number, close: boolean) => {
      g.beginPath();
      this.project(p[from].x, p[from].z, s);
      g.moveTo(s.x, s.y);
      for (let i = from + 1; i <= to; i++) {
        this.project(p[i % n].x, p[i % n].z, s);
        g.lineTo(s.x, s.y);
      }
      if (close) g.closePath();
    };

    g.lineJoin = 'round';
    g.lineCap = 'round';

    // --- casing, one closed pass -------------------------------------------
    trace(0, n, true);
    g.strokeStyle = CASE_COL;
    g.lineWidth = (TRACK_W + TRACK_CASE) * d;
    g.stroke();

    // --- core, one pass PER SECTION ----------------------------------------
    // The dashed centreline is gone. At this panel size it was the thing that
    // made the circuit read as a zipper; the ribbon's own casing is what makes
    // it read as a carriageway. Section runs overlap by a sample so the joins
    // are invisible.
    for (let k = 0; k < SECTIONS.length; k++) {
      const sec = SECTIONS[k];
      const i0 = Math.floor(sec.t0 * n);
      const i1 = Math.min(n, Math.ceil(sec.t1 * n) + 1);
      if (i1 - i0 < 2) continue;
      trace(i0, i1, false);
      g.strokeStyle = sec.col;
      g.lineWidth = TRACK_W * d;
      g.stroke();
    }

    // --- START / FINISH ----------------------------------------------------
    // A 4 px gold tick was invisible at real size. It is now a chequered bar
    // laid across the full width of the ribbon with a warm glow behind it —
    // the one landmark on the map that must be findable in a glance.
    this.project(p[0].x, p[0].z, s);
    const ax = s.x, ay = s.y;
    this.project(p[3 % n].x, p[3 % n].z, s);
    let tx = s.x - ax, ty = s.y - ay;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const half = (TRACK_W + TRACK_CASE) * 0.95 * d;
    const nx = -ty * half, ny = tx * half;

    g.save();
    g.shadowColor = 'rgba(255, 190, 88, 0.95)';
    g.shadowBlur = 8 * d;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(ax - nx, ay - ny);
    g.lineTo(ax + nx, ay + ny);
    g.lineWidth = 8.5 * d;
    g.strokeStyle = 'rgba(255, 200, 108, 0.9)';
    g.stroke();
    g.restore();

    // four chequers across the bar, drawn along the ribbon normal
    g.lineCap = 'butt';
    const CH = 4;
    for (let i = 0; i < CH; i++) {
      const a0 = -1 + (2 * i) / CH;
      const a1 = -1 + (2 * (i + 1)) / CH;
      g.beginPath();
      g.moveTo(ax + nx * a0, ay + ny * a0);
      g.lineTo(ax + nx * a1, ay + ny * a1);
      g.lineWidth = 6.4 * d;
      g.strokeStyle = i % 2 ? '#140c05' : '#fff6e4';
      g.stroke();
    }
    g.lineCap = 'round';
  }

  private scratch = { x: 0, y: 0 };

  /** Per-kart plot state, allocated once and reused every frame. */
  private px: number[] = [];
  private py: number[] = [];
  /** unit perpendicular to each kart's heading, in canvas space */
  private nx: number[] = [];
  private ny: number[] = [];
  /** how far each dot has been nudged off its true position, canvas px */
  private off: number[] = [];
  /** draw order, back of the field first. Allocated once. */
  private order: number[] = [];

  update(ctx: Ctx) {
    if (!this.built) {
      if (!this.tryBuild(ctx)) return;
      this.resize();
    }
    const g = this.g;
    const W = this.w, H = this.h;
    if (W < 4) return;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(this.base, 0, 0);

    const d = this.u;
    const karts = ctx.race.karts;
    const player = ctx.race.player;
    const s = this.scratch;
    const n = karts.length;

    const rivalR = RIVAL_R * d;
    const playerR = PLAYER_R * d;

    // --- project, then de-overlap ------------------------------------------
    // Dots that land on top of each other are pushed apart along the local
    // track normal, which is the direction real karts are separated in — so a
    // bunched pack fans out across the road instead of collapsing into a knot.
    const px = this.px, py = this.py, nx = this.nx, ny = this.ny, off = this.off;
    for (let i = 0; i < n; i++) {
      const k = karts[i];
      this.project(k.position.x, k.position.z, s);
      px[i] = s.x; py[i] = s.y;
      // heading, rotated into canvas space by the same fitted rotation
      const f = k.forward;
      const hx = f.x * this.rc - f.z * this.rs;
      const hy = f.x * this.rs + f.z * this.rc;
      const l = Math.hypot(hx, hy) || 1;
      // perpendicular of the heading
      nx[i] = -hy / l; ny[i] = hx / l;
      off[i] = 0;
    }

    const maxOff = rivalR * 4.0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const ri = karts[i] === player ? playerR : rivalR;
        for (let j = i + 1; j < n; j++) {
          const rj = karts[j] === player ? playerR : rivalR;
          const minD = (ri + rj) * SEPARATION;
          const dx = px[j] - px[i], dy = py[j] - py[i];
          const dist = Math.hypot(dx, dy);
          if (dist >= minD) continue;
          const push = (minD - dist) * 0.5;
          const sgn = (dx * nx[i] + dy * ny[i]) >= 0 ? 1 : -1;
          const oi = clamp(off[i] - push * sgn, -maxOff, maxOff);
          const oj = clamp(off[j] + push * sgn, -maxOff, maxOff);
          px[i] += (oi - off[i]) * nx[i]; py[i] += (oi - off[i]) * ny[i];
          px[j] += (oj - off[j]) * nx[j]; py[j] += (oj - off[j]) * ny[j];
          off[i] = oi; off[j] = oj;
        }
      }
    }

    // --- depth sort by race position ---------------------------------------
    // Back of the field first, leader last, player last of all. Insertion sort
    // in place: n is eight, and a comparator closure would be a per-frame
    // allocation in the hot path (§8).
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = 1; i < n; i++) {
      const v = order[i];
      const pv = karts[v].place | 0;
      let j = i - 1;
      while (j >= 0 && (karts[order[j]].place | 0) < pv) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }

    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      const k = karts[i];
      if (k === player) continue;
      this.dot(g, px[i], py[i], rivalR, this.colors[i] || '#f2ece0', k.starTime > 0, d);
    }

    if (player) {
      const i = karts.indexOf(player);
      this.playerMark(g, px[i], py[i], playerR, player, this.colors[i] || '#ff3b5c', d);
    }
  }

  /**
   * Rivals: a flat livery disc with a dark casing, and NOTHING ELSE.
   *
   * Round 1 also drew a gold ring around whichever rivals were adjacent in the
   * order. Three of nine markers in wide.png therefore carried a ring while
   * the player carried one too, so "ring = you" meant nothing and the one
   * affordance the map has for finding yourself was destroyed. Rivals are told
   * apart by livery colour, which is what livery colours are for. The ring
   * belongs to the player and to no one else.
   */
  private dot(
    g: CanvasRenderingContext2D, x: number, y: number, r: number,
    color: string, glow: boolean, d: number,
  ) {
    if (glow) {
      g.beginPath();
      g.arc(x, y, r * 1.9, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,207,107,0.5)';
      g.fill();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 1.6 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
  }

  /**
   * The player: §7's "larger dot", at 1.8x the rival diameter, filled with the
   * player's own livery colour, carrying the ONE ring in the system — and with
   * a heading chevron struck into it in ink, because a marker that carries
   * heading is worth more than one that does not and it costs one path.
   */
  private playerMark(
    g: CanvasRenderingContext2D, x: number, y: number, r: number, k: IKart,
    col: string, d: number,
  ) {
    const f = k.forward;
    // heading, rotated by the same fit the ribbon was baked with
    const hx = f.x * this.rc - f.z * this.rs;
    const hy = f.x * this.rs + f.z * this.rc;
    const a = Math.atan2(hy, hx);

    // a soft halo so the marker survives on the bright core of the ribbon,
    // which is exactly where the player always is
    g.beginPath();
    g.arc(x, y, r * 1.62, 0, Math.PI * 2);
    g.fillStyle = 'rgba(18, 10, 4, 0.55)';
    g.fill();

    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
    // THE ring. Cream, heavier than the rivals' casing, and unique.
    g.lineWidth = 2.4 * d;
    g.strokeStyle = '#fff4e2';
    g.stroke();
    g.lineWidth = 1.2 * d;
    g.strokeStyle = CASE_COL;
    g.beginPath();
    g.arc(x, y, r + 1.8 * d, 0, Math.PI * 2);
    g.stroke();

    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(r * 0.72, 0);
    g.lineTo(-r * 0.34, -r * 0.5);
    g.lineTo(-r * 0.10, 0);
    g.lineTo(-r * 0.34, r * 0.5);
    g.closePath();
    g.lineJoin = 'round';
    g.fillStyle = 'rgba(22, 12, 5, 0.86)';
    g.fill();
    g.restore();
  }
}
