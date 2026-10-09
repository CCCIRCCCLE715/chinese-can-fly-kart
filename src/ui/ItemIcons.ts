/**
 * Procedural item art — Sunset Bay's own set.
 *
 * ROUND 2 REBUILD, for two reasons.
 *
 * 1. The round-1 icons were near-traces of another publisher's item roster —
 *    a spotted mushroom with eyes, a footed bomb with a lit fuse, green and
 *    red carapaces. That is not a look this game can ship, whatever it looks
 *    like in a screenshot. The set is now drawn from this circuit's own world:
 *    an espresso, netted glass fishing floats, an Amalfi lemon, the golden
 *    hour itself, a squall, a harbour mooring buoy. Same gameplay slots, same
 *    silhouette weights, original forms.
 *
 * 2. Two construction styles shared one 166 px slot — a soft-shaded 3D render
 *    with a specular highlight and a glow that bled past the plate corner, and
 *    a flat vector with a hard keyline and no glow at all.
 *
 * ROUND 8 — THE SET WAS FLAT AND IT WAS NOT ONE SET.
 *
 * The round-1 review counted three construction languages in one slot: a flat
 * vector coffee cup and saucer that "could have come out of a Material icon
 * set", an unidentifiable cream-and-red buoy with a grey ring that "reads as
 * nothing at a glance", and shaded 3D-ish latitude spheres. On top of that the
 * empty state was a thin gold diamond outline that read as a broken-image
 * placeholder — in the SAME gold as the "1st" position accent, so one colour
 * meant both "you are winning" and "you have nothing".
 *
 * Three changes, all structural rather than per-icon:
 *
 *  1. ONE LIGHTING KEY, in `lit()`, which every filled shape in the file goes
 *     through. Warm key from the upper left, cool bounce from the lower right,
 *     an inner rim on the lit edge, then the ink keyline — §4's clearcoat toy
 *     language rather than flat vector. No icon lights itself.
 *  2. ONE OPTICAL SIZE, in `OPT_S`, so a can, a sphere and a sun with rays all
 *     land on the same visual bounding box instead of filling 70% / 60% / 45%
 *     of the slot.
 *  3. THE EMPTY STATE IS AN ITEM, not the absence of one: a dimensional
 *     three-quarter item-box cube with a "?" on it, drawn from this atlas on
 *     this grid, in a NEUTRAL value. Gold is now reserved strictly for the
 *     position accent. The HUD ghosts it further so "empty" and "holding" are
 *     never the same weight on screen.
 *
 * Two icons that did not read were redrawn from scratch: the espresso is a
 * turbo can (a boost pickup should look like a boost pickup at 64 px), and the
 * mooring buoy is a harbour mine (a bomb should look like a bomb).
 *
 * ONE construction, applied to every icon without exception:
 *   - a single ink keyline at ONE weight (LW). No icon is more line-arty.
 *   - one two-stop ramp per shape, light at the top, through `lit()`.
 *   - one contact shadow, identical parameters everywhere.
 *   - one optical-size box: every icon is authored inside a unit square and
 *     then fitted to an 80% inset scaled by OPT_S, vertically centred on its
 *     OPTICAL centroid (OPT_Y) rather than on its bounding box.
 */
import { ItemKind } from '../types';

const INK = '#241a2e';
/** the one keyline weight, in unit-box coordinates */
const LW = 0.055;

export const ITEM_NAMES: Record<number, string> = {
  [ItemKind.Rocket]: '中国人能飞',
  [ItemKind.Gas]: '放屁',
  [ItemKind.None]: '',
  [ItemKind.Mushroom]: '加速罐',
  [ItemKind.TripleMushroom]: '三连加速',
  [ItemKind.GreenShell]: '玻璃浮球',
  [ItemKind.RedShell]: '追踪浮球',
  [ItemKind.Banana]: '香蕉',
  [ItemKind.Star]: '黄金时刻',
  [ItemKind.Bolt]: '风暴',
  [ItemKind.Bomb]: '港湾水雷',
};

/** Accent colour used for the item-box glow and the hit toast rule. */
export const ITEM_TINT: Record<number, string> = {
  // Neutral, and deliberately NOT gold: the empty slot must not borrow the
  // colour that means "you are in first".
  [ItemKind.Rocket]: '#ff4848',
  [ItemKind.Gas]: '#edce58',
  [ItemKind.None]: '#8fa0bb',
  [ItemKind.Mushroom]: '#ff8a3d',
  [ItemKind.TripleMushroom]: '#ff9d4a',
  [ItemKind.GreenShell]: '#5fd463',
  [ItemKind.RedShell]: '#ff4d4d',
  [ItemKind.Banana]: '#ffd447',
  [ItemKind.Star]: '#ffd76b',
  [ItemKind.Bolt]: '#ffe066',
  [ItemKind.Bomb]: '#e0453f',
};

/** Cycling order for the roulette — mixes hues so the spin looks lively. */
export const ROULETTE_ORDER: ItemKind[] = [ItemKind.Banana, ItemKind.Gas, ItemKind.Rocket];

/**
 * Optical-centroid correction per icon, in unit-box coordinates. Positive
 * moves the icon down. A sun with rays reads high; a cup on a saucer reads
 * low. Bounding-box centring alone is what left the round-1 mushroom with
 * more headroom than footroom next to a bomb that filled the plate.
 */
const OPT_Y: Record<number, number> = {
  [ItemKind.None]: 0,
  [ItemKind.Mushroom]: -0.005,
  [ItemKind.TripleMushroom]: -0.01,
  [ItemKind.GreenShell]: -0.02,
  [ItemKind.RedShell]: -0.02,
  [ItemKind.Banana]: 0,
  [ItemKind.Star]: 0.005,
  [ItemKind.Bolt]: 0,
  [ItemKind.Bomb]: -0.01,
};

/**
 * Optical-SIZE correction per icon. The shared 80% box equalises the authoring
 * square, not the perceived mass: a sun with sixteen thin rays reads far
 * larger than a sphere of the same bounding box, and a tall narrow can reads
 * smaller. The review measured icons filling 70%, 60% and 45% of the same
 * slot. These are the multipliers that put them all on one optical grid.
 */
const OPT_S: Record<number, number> = {
  [ItemKind.None]: 1.00,
  [ItemKind.Mushroom]: 1.06,
  [ItemKind.TripleMushroom]: 1.00,
  [ItemKind.GreenShell]: 1.06,
  [ItemKind.RedShell]: 1.06,
  [ItemKind.Banana]: 0.96,
  [ItemKind.Star]: 0.90,
  [ItemKind.Bolt]: 1.00,
  [ItemKind.Bomb]: 1.02,
};

type G = CanvasRenderingContext2D;

// --------------------------------------------------------------------------
// primitives — the only ones any icon is allowed to use
// --------------------------------------------------------------------------

/** THE two-stop ramp. Light at the top, saturated at the bottom, always. */
function ramp(g: G, top: string, bottom: string, y0 = -0.44, y1 = 0.44) {
  const grd = g.createLinearGradient(0, y0, 0, y1);
  grd.addColorStop(0, top);
  grd.addColorStop(1, bottom);
  return grd;
}

/** THE keyline. */
function key(g: G, p: Path2D, w = LW) {
  g.strokeStyle = INK;
  g.lineWidth = w;
  g.stroke(p);
}

/** THE contact shadow — identical on every icon so nothing floats and nothing
 *  is lit differently from its neighbour in the roulette. */
function contact(g: G) {
  g.save();
  g.translate(0, 0.445);
  g.scale(1, 0.24);
  g.beginPath();
  g.arc(0, 0, 0.30, 0, Math.PI * 2);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 0.30);
  grd.addColorStop(0, 'rgba(20,14,30,0.42)');
  grd.addColorStop(1, 'rgba(20,14,30,0)');
  g.fillStyle = grd;
  g.fill();
  g.restore();
}

/**
 * THE LIGHTING KEY. Every filled shape in this file goes through here, so the
 * whole set is lit by one three-quarter setup and reads as one toy family
 * (§4's clearcoat language) rather than as flat vector art with a keyline.
 *
 * Four passes, in order, on every shape without exception:
 *   1. the two-stop body ramp
 *   2. a warm key from the upper left  (§2's 14° sun)
 *   3. a cool bounce from the lower right (§2's sky fill)
 *   4. an inner rim on the lit edge — the "6 px rim" that makes a shape read
 *      as moulded rather than as a filled path
 * then the one ink keyline over the top.
 */
function lit(g: G, p: Path2D, top: string, bottom: string, y0?: number, y1?: number, kw = LW) {
  g.fillStyle = ramp(g, top, bottom, y0, y1);
  g.fill(p);

  g.save();
  g.clip(p);
  const key1 = g.createRadialGradient(-0.17, -0.24, 0.01, -0.17, -0.24, 0.50);
  key1.addColorStop(0, 'rgba(255, 247, 226, 0.40)');
  key1.addColorStop(1, 'rgba(255, 247, 226, 0)');
  g.fillStyle = key1;
  g.fillRect(-0.6, -0.6, 1.2, 1.2);

  const bounce = g.createRadialGradient(0.24, 0.32, 0.01, 0.24, 0.32, 0.44);
  bounce.addColorStop(0, 'rgba(150, 198, 255, 0.26)');
  bounce.addColorStop(1, 'rgba(150, 198, 255, 0)');
  g.fillStyle = bounce;
  g.fillRect(-0.6, -0.6, 1.2, 1.2);

  // inner rim: the silhouette stroked once, nudged down-right inside the clip,
  // so only the upper-left edge of the shape catches it
  g.save();
  g.translate(kw * 0.42, kw * 0.52);
  g.strokeStyle = 'rgba(255, 250, 236, 0.55)';
  g.lineWidth = kw * 1.15;
  g.stroke(p);
  g.restore();
  g.restore();

  key(g, p, kw);
}

/** Kept as the call name every icon already uses; it IS the lighting key. */
function fillKey(g: G, p: Path2D, top: string, bottom: string, y0?: number, y1?: number, kw = LW) {
  lit(g, p, top, bottom, y0, y1, kw);
}

function ellipsePath(x: number, y: number, rx: number, ry: number, rot = 0) {
  const p = new Path2D();
  p.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  return p;
}

// --------------------------------------------------------------------------
// icons
// --------------------------------------------------------------------------

/**
 * Turbo can — the boost item.
 *
 * This slot used to be a steaming espresso cup on a saucer. It was drawn
 * correctly and it was still wrong: a cup and saucer is a menu icon, and at
 * 64 px in the corner of a racing game nothing about it says "this makes you
 * go faster". A stubby pressurised can with a chrome collar and a double
 * chevron says it in one glance, in every language, and it is nobody else's
 * item design.
 *
 * `s` scales the whole can about the local origin; every stroke weight is
 * divided by it so the keyline lands at exactly LW whatever the size — a small
 * can in the triple must not be more delicately drawn than a large one, or the
 * set stops reading as one hand.
 */
function turboCan(g: G, s: number) {
  g.save();
  g.scale(s, s);
  const w = LW / s;

  // collar / valve, behind the body
  const collar = new Path2D();
  collar.moveTo(-0.135, -0.235);
  collar.lineTo(0.135, -0.235);
  collar.lineTo(0.115, -0.405);
  collar.bezierCurveTo(0.115, -0.475, -0.115, -0.475, -0.115, -0.405);
  collar.closePath();
  fillKey(g, collar, '#f4f8ff', '#6d7a90', -0.48, -0.20, w);

  // body: a chunky capsule, warm — the boost family colour (§3 mini-turbo
  // orange, saturated up for a 64 px read)
  const body = new Path2D();
  const L = -0.285, R = 0.285, T = -0.245, B = 0.375, C = 0.135;
  body.moveTo(L, T + C);
  body.bezierCurveTo(L, T, L + C, T, L + C, T);
  body.lineTo(R - C, T);
  body.bezierCurveTo(R, T, R, T, R, T + C);
  body.lineTo(R, B - C);
  body.bezierCurveTo(R, B, R - C, B, R - C, B);
  body.lineTo(L + C, B);
  body.bezierCurveTo(L, B, L, B, L, B - C);
  body.closePath();
  fillKey(g, body, '#ffc06b', '#c9420e', -0.30, 0.42, w);

  // the double chevron. Two strokes, the shared keyline weight, clipped to the
  // body so the decal is ON the can rather than floating over it.
  g.save();
  g.clip(body);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < 2; i++) {
    const x = -0.115 + i * 0.185;
    g.beginPath();
    g.moveTo(x - 0.075, -0.055);
    g.lineTo(x + 0.055, 0.075);
    g.lineTo(x - 0.075, 0.205);
    g.strokeStyle = 'rgba(48, 20, 6, 0.55)';
    g.lineWidth = w * 2.5;
    g.stroke();
    g.strokeStyle = '#fff6e0';
    g.lineWidth = w * 1.5;
    g.stroke();
  }
  g.restore();
  g.restore();
}

function drawTurboCan(g: G) {
  contact(g);
  turboCan(g, 1);
}

function drawTripleTurbo(g: G) {
  contact(g);
  // Three cans in a triangle. No crate: at 64 px a crate plus three cans is one
  // orange lump, and the count chip on the plate already says how many.
  g.save(); g.translate(-0.265, 0.185); turboCan(g, 0.54); g.restore();
  g.save(); g.translate(0.265, 0.185); turboCan(g, 0.54); g.restore();
  g.save(); g.translate(0, -0.175); turboCan(g, 0.60); g.restore();
}

/**
 * Netted glass fishing float — the bouncing projectile. Every harbour on this
 * coast has a wall of them.
 */
function glassFloat(g: G, top: string, bottom: string, homing: boolean) {
  contact(g);
  const R = 0.345;
  const body = new Path2D();
  body.arc(0, 0.035, R, 0, Math.PI * 2);
  fillKey(g, body, top, bottom, -0.34, 0.40);

  // rope net: three arcs, clipped to the glass
  g.save();
  g.clip(body);
  g.strokeStyle = '#efe2c4';
  g.lineWidth = LW * 0.68;
  for (const rx of [0.115, 0.245]) {
    g.beginPath();
    g.ellipse(0, 0.035, rx, R, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.ellipse(0, 0.035, R, 0.125, 0, 0, Math.PI * 2);
  g.stroke();
  g.restore();

  // knot / hanging loop at the crown
  const loop = new Path2D();
  loop.ellipse(0, -0.375, 0.085, 0.075, 0, 0, Math.PI * 2);
  g.fillStyle = '#efe2c4';
  g.fill(loop);
  key(g, loop, LW * 0.9);

  if (homing) {
    // a brass tracking band — this one comes looking for you. One thin ring,
    // no needle: a band plus a lozenge inside a sphere read as an eye at 64 px.
    const band = new Path2D();
    band.ellipse(0, 0.035, R * 1.0, 0.095, 0, 0, Math.PI * 2);
    g.strokeStyle = INK;
    g.lineWidth = LW * 1.7;
    g.stroke(band);
    g.strokeStyle = '#e0a93a';
    g.lineWidth = LW * 0.8;
    g.stroke(band);
  }
}

function drawGreenFloat(g: G) { glassFloat(g, '#b8f0a8', '#1e7a35', false); }
function drawRedFloat(g: G) { glassFloat(g, '#ffb9a4', '#b3202a', true); }

/** Amalfi lemon — the dropped hazard. */
function drawLemon(g: G) {
  contact(g);
  const body = new Path2D();
  // a lemon: an ellipse with a nipple at each end, tilted
  body.moveTo(-0.415, -0.135);
  body.bezierCurveTo(-0.335, -0.335, 0.055, -0.385, 0.275, -0.235);
  body.bezierCurveTo(0.455, -0.115, 0.475, 0.115, 0.315, 0.265);
  body.bezierCurveTo(0.135, 0.425, -0.215, 0.375, -0.355, 0.185);
  body.bezierCurveTo(-0.445, 0.065, -0.455, -0.045, -0.415, -0.135);
  body.closePath();
  fillKey(g, body, '#fff6b0', '#e8a30c', -0.40, 0.42);

  // the one interior line the set allows: the pith seam
  g.save();
  g.clip(body);
  g.strokeStyle = 'rgba(255,252,206,0.62)';
  g.lineWidth = LW * 1.3;
  g.beginPath();
  g.moveTo(-0.305, -0.135);
  g.bezierCurveTo(-0.185, -0.265, 0.065, -0.285, 0.205, -0.185);
  g.stroke();
  g.restore();

  // leaf
  const leaf = new Path2D();
  leaf.moveTo(0.135, -0.305);
  leaf.bezierCurveTo(0.265, -0.475, 0.435, -0.475, 0.475, -0.395);
  leaf.bezierCurveTo(0.425, -0.245, 0.245, -0.215, 0.135, -0.305);
  leaf.closePath();
  fillKey(g, leaf, '#9ecf6a', '#41702c', -0.48, -0.20);
}

/** Golden Hour — the invulnerability item. The circuit's own light, weaponised. */
function drawGoldenHour(g: G) {
  contact(g);
  // rays and disc in ONE path, so the keyline runs round one silhouette
  const p = new Path2D();
  const R0 = 0.285, R1 = 0.485;
  for (let i = 0; i < 16; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 8;
    const half = Math.PI / 16 * 0.78;
    if (i % 2 === 0) {
      // ray: a tapered spike
      const x0 = Math.cos(a - half) * R0, y0 = Math.sin(a - half) * R0;
      const xt = Math.cos(a) * R1, yt = Math.sin(a) * R1;
      const x1 = Math.cos(a + half) * R0, y1 = Math.sin(a + half) * R0;
      if (i === 0) p.moveTo(x0, y0); else p.lineTo(x0, y0);
      p.lineTo(xt, yt);
      p.lineTo(x1, y1);
    } else {
      p.arc(0, 0, R0, a - Math.PI / 16, a + Math.PI / 16);
    }
  }
  p.closePath();
  fillKey(g, p, '#fff4c6', '#ef8f12', -0.48, 0.48);

  // inner disc — the second of the two stops, as a shape rather than a blur
  const disc = new Path2D();
  disc.arc(0, -0.02, 0.20, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,250,222,0.55)';
  g.fill(disc);
}

/** Squall — the field-wide storm. A bolt out of a cloud, not a bare glyph. */
function drawSquall(g: G) {
  contact(g);
  const cloud = new Path2D();
  cloud.moveTo(-0.415, -0.055);
  cloud.bezierCurveTo(-0.485, -0.225, -0.315, -0.365, -0.145, -0.315);
  cloud.bezierCurveTo(-0.085, -0.465, 0.165, -0.485, 0.245, -0.335);
  cloud.bezierCurveTo(0.435, -0.365, 0.505, -0.145, 0.365, -0.055);
  cloud.closePath();
  fillKey(g, cloud, '#8fa2c6', '#2f3a5c', -0.48, -0.02);

  const bolt = new Path2D();
  bolt.moveTo(0.055, -0.085);
  bolt.lineTo(0.285, -0.045);
  bolt.lineTo(0.095, 0.185);
  bolt.lineTo(0.255, 0.225);
  bolt.lineTo(-0.115, 0.475);
  bolt.lineTo(-0.015, 0.185);
  bolt.lineTo(-0.235, 0.145);
  bolt.lineTo(-0.075, -0.085);
  bolt.closePath();
  fillKey(g, bolt, '#fff6c2', '#f0a412', -0.10, 0.48);
}

/**
 * Harbour mine — the thrown/dropped explosive.
 *
 * The round-1 buoy read, in the review's words, "as nothing at a glance": a
 * cream-and-red hull with a grey mooring ring, which at 64 px is a lozenge
 * with a smudge under it. A moored contact mine keeps the harbour theme
 * exactly and reads as a bomb instantly, because horns on a dark sphere is
 * the one silhouette that can only mean one thing.
 */
function drawMine(g: G) {
  contact(g);
  const R = 0.285;
  const CY = 0.075;

  // Horns first, so the shell overlaps their roots. Five, fat and long: three
  // thin spikes read as sun rays, which is what the first pass of this icon
  // did and it is why it was unreadable.
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.92 + (i * Math.PI * 0.84) / 4;
    const cx = Math.cos(a), sy = Math.sin(a);
    const horn = new Path2D();
    const bx = cx * (R - 0.03), by = CY + sy * (R - 0.03);
    const tx = cx * (R + 0.185), ty = CY + sy * (R + 0.185);
    const px = -sy * 0.088, py = cx * 0.088;
    horn.moveTo(bx + px, by + py);
    horn.lineTo(tx + px * 0.46, ty + py * 0.46);
    horn.lineTo(tx - px * 0.46, ty - py * 0.46);
    horn.lineTo(bx - px, by - py);
    horn.closePath();
    fillKey(g, horn, '#d2dcec', '#4d5b73', -0.50, 0.20, LW * 0.9);
  }

  // shell — one silhouette, dark, so the horns read against the ground and the
  // one red band reads against the shell
  const shell = new Path2D();
  shell.arc(0, CY, R, 0, Math.PI * 2);
  fillKey(g, shell, '#4d5e77', '#0b1220', -0.28, 0.40);

  g.save();
  g.clip(shell);
  const band = new Path2D();
  band.rect(-0.5, CY - 0.10, 1, 0.135);
  g.fillStyle = ramp(g, '#ff8478', '#b8241c', CY - 0.11, CY + 0.05);
  g.fill(band);
  g.restore();
  key(g, shell);
}

/**
 * THE EMPTY SLOT — a real item-box cube in three-quarter view with a "?" on
 * it, at a neutral value.
 *
 * Round 1 drew this as a thin gold diamond outline, which read as a
 * broken-image placeholder, and it used the SAME gold as the "1st" position
 * accent, so one colour in the HUD meant both "you are winning" and "you have
 * nothing". Gold is now the position accent and nothing else. The HUD ghosts
 * this further (see `.kr-item.empty` in ui.css) so a full-weight, saturated,
 * glowing slot can only ever mean "you are holding something".
 */
function drawEmptyBox(g: G) {
  contact(g);
  // isometric hexagon: T, R1, R2, B, L2, L1, with M at the centre
  const HX = 0.345, HY = 0.205, VY = 0.415;
  const top = new Path2D();
  top.moveTo(0, -VY); top.lineTo(HX, -HY); top.lineTo(0, 0); top.lineTo(-HX, -HY);
  top.closePath();
  const left = new Path2D();
  left.moveTo(-HX, -HY); left.lineTo(0, 0); left.lineTo(0, VY); left.lineTo(-HX, HY);
  left.closePath();
  const right = new Path2D();
  right.moveTo(HX, -HY); right.lineTo(HX, HY); right.lineTo(0, VY); right.lineTo(0, 0);
  right.closePath();

  // three faces, one value each, lit by the shared key — the left face takes
  // the warm key, the right face falls into the cool bounce, the top reads
  // brightest, which is the whole reason this is a cube and not a diamond.
  fillKey(g, left, '#4a5f7e', '#22314a', -0.20, VY);
  fillKey(g, right, '#3f5470', '#16223a', -0.20, VY);
  fillKey(g, top, '#94aac6', '#556b8a', -VY, 0.02);

  // the "?" — a path, not text, so it scales exactly with the box
  const q = new Path2D();
  q.moveTo(-0.105, -0.095);
  q.bezierCurveTo(-0.105, -0.235, 0.125, -0.235, 0.125, -0.115);
  q.bezierCurveTo(0.125, -0.005, 0.010, 0.010, 0.010, 0.105);
  g.lineCap = 'round';
  g.strokeStyle = INK;
  g.lineWidth = LW * 2.2;
  g.stroke(q);
  g.strokeStyle = '#cfe0f2';
  g.lineWidth = LW * 1.25;
  g.stroke(q);

  const dot = new Path2D();
  dot.arc(0.010, 0.195, LW * 0.85, 0, Math.PI * 2);
  g.fillStyle = INK;
  g.lineWidth = LW * 1.1;
  g.strokeStyle = INK;
  g.stroke(dot);
  g.fillStyle = '#cfe0f2';
  g.fill(dot);
}

function drawRocket(g: G) {
  for (const side of [-1, 1]) {
    const wing = new Path2D(); wing.moveTo(side*.13,-.2); wing.lineTo(side*.4,-.33);
    wing.lineTo(side*.48,-.06); wing.lineTo(side*.15,.12); wing.closePath();
    lit(g,wing,'#ff6262','#b91625');
    g.fillStyle='#f4f5f6'; g.fillRect(side<0?-.34:.27,-.2,.065,.19);
    const flame=new Path2D(); flame.moveTo(side*.11-.06,.2); flame.lineTo(side*.11+.06,.2);
    flame.lineTo(side*.11,.45); flame.closePath(); g.fillStyle='#62dfff';g.fill(flame);
  }
  const shell=new Path2D();shell.roundRect(-.16,-.31,.32,.55,.055);
  lit(g,shell,'#ffffff','#a9b3c0');
  g.fillStyle='#d82c36'; g.fillRect(-.05,-.12,.1,.1);
}

function drawGas(g: G) {
  g.save();
  const shade=g.createLinearGradient(0,-.35,0,.3);
  shade.addColorStop(0,'#fff0a4');shade.addColorStop(1,'#c69829');
  g.fillStyle=shade;g.strokeStyle=INK;g.lineWidth=LW;
  g.beginPath();g.moveTo(-.32,.23);
  g.bezierCurveTo(-.55,.19,-.48,-.14,-.27,-.12);
  g.bezierCurveTo(-.31,-.44,.08,-.46,.14,-.22);
  g.bezierCurveTo(.41,-.35,.55,-.02,.34,.10);
  g.bezierCurveTo(.49,.32,.02,.38,-.06,.24);
  g.bezierCurveTo(-.14,.34,-.25,.31,-.32,.23);
  g.closePath();g.fill();g.stroke();g.restore();
}

const TABLE: Record<number, (g: G) => void> = {
  [ItemKind.Rocket]: drawRocket,
  [ItemKind.Gas]: drawGas,
  [ItemKind.None]: drawEmptyBox,
  [ItemKind.Mushroom]: drawTurboCan,
  [ItemKind.TripleMushroom]: drawTripleTurbo,
  [ItemKind.GreenShell]: drawGreenFloat,
  [ItemKind.RedShell]: drawRedFloat,
  [ItemKind.Banana]: drawLemon,
  [ItemKind.Star]: drawGoldenHour,
  [ItemKind.Bolt]: drawSquall,
  [ItemKind.Bomb]: drawMine,
};

/**
 * Paint `kind` centred in a `size` px box on `g`, fitted to the shared
 * optical-size box. The caller owns the canvas clear; we leave the context
 * state exactly as we found it.
 */
export function drawItem(g: G, kind: ItemKind, size: number) {
  g.save();
  g.translate(size * 0.5, size * 0.5);
  // 80% inset square scaled onto the shared optical grid, vertically centred
  // on the optical centroid.
  const s = size * 0.80 * (OPT_S[kind] ?? 1);
  g.scale(s, s);
  g.translate(0, OPT_Y[kind] || 0);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.miterLimit = 2;
  (TABLE[kind] || drawEmptyBox)(g);
  g.restore();
}

/** Off-screen cache so the roulette can blit instead of re-rasterising paths. */
export class ItemIconAtlas {
  private cache = new Map<number, HTMLCanvasElement>();
  private size = 0;

  /** Rebuilds only when the required pixel size actually moves. */
  ensure(px: number) {
    const s = Math.max(96, Math.min(512, Math.round(px / 32) * 32));
    if (s === this.size) return;
    this.size = s;
    this.cache.clear();
  }

  get(kind: ItemKind): HTMLCanvasElement {
    let c = this.cache.get(kind);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = this.size || 256;
      const g = c.getContext('2d')!;
      drawItem(g, kind, c.width);
      this.cache.set(kind, c);
    }
    return c;
  }
}
