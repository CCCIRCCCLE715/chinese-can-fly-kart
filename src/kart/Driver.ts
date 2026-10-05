/**
 * ============================================================================
 *  Driver — the figure in the seat, and the rig other systems pose.
 * ============================================================================
 *  Built once and shared: five meshes (torso+legs, arms, helmet, visor,
 *  steering wheel) whose geometry is identical for every racer. Only the
 *  vertex-colour attribute differs per livery.
 *
 *  Local space: origin at the hip point, +Y up, +Z forward (the kart's own
 *  axes). In this game's convention +X is the kart's RIGHT — `Kart.step`
 *  increases yaw for a right turn and a positive yaw sends local +Z toward
 *  world +X, so a right turn banks the driver toward +X.
 *
 *  POSING (physics / VFX drive these; everything is -1..1 and smoothed):
 *      rig.steer  +1 = full right lock   -> wheel + arm counter-steer
 *      rig.lean   +1 = cornering right   -> body and head fall into the turn
 *      rig.pitch  +1 = accelerating, -1 = braking
 *      rig.duck    1 = tucked under boost
 *      rig.apex   +1 = look right toward the apex
 *      rig.jolt(a)     one-shot impact shove
 *      rig.update(dt)  once a frame; it damps toward the targets
 * ============================================================================
 */
import * as THREE from 'three';
import {
  Mesher, Role, gripArmMaterial, kartMaterials, liveryGeometry, mat,
  type Built, type GripArmMaterial, type Livery, type Section,
} from './Liveries';

// --- rig constants -----------------------------------------------------------

/** Steering column pivot, in driver-local space, and its rake. */
const COL_POS = new THREE.Vector3(0, 0.46, 0.40);
const COL_RAKE = -0.95; // radians about X: axis ends up 35 deg off vertical
const HEAD_POS = new THREE.Vector3(0, 0.60, -0.01);
const SHOULDER = 0.252;
/** Steering wheel rim radius. The hands are derived FROM this, never beside it. */
const RIM_R = 0.155;
/**
 * Rim tube radius. The glove straddles this: the palm mass sits 26 mm outboard
 * of the rim's centreline and the finger roll 34 mm inboard of it, so the tube
 * runs between them and the wheel visibly enters and leaves the hand.
 */
const RIM_TUBE = 0.030;

/** A point on the steering-wheel rim, in hips space. phi = 0 is 12 o'clock. */
function rimPoint(phi: number, col: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(phi) * RIM_R, 0, Math.cos(phi) * RIM_R).applyMatrix4(col);
}

/**
 * Arc-length parameter (0 at the shoulder, 1 at the wrist) of the point on
 * `path` nearest `p`, together with that distance. This is what turns a bag of
 * tubes into a skin: every vertex of the arm — limb, sleeve, cuff, glove, thumb,
 * knuckle strap, deltoid — gets its blend weight from where it sits ALONG the
 * limb, so parts that were authored independently cannot disagree about how far
 * down the arm they are.
 */
function limbParam(
  path: readonly THREE.Vector3[], lens: Float64Array, total: number,
  p: THREE.Vector3, seg: THREE.Vector3, rel: THREE.Vector3,
): { t: number; d2: number } {
  let bestD2 = Infinity;
  let bestS = 0;
  for (let i = 0; i < path.length - 1; i++) {
    seg.subVectors(path[i + 1], path[i]);
    const len2 = seg.lengthSq();
    rel.subVectors(p, path[i]);
    let u = len2 > 1e-12 ? rel.dot(seg) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = rel.x - seg.x * u;
    const dy = rel.y - seg.y * u;
    const dz = rel.z - seg.z * u;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = lens[i] + Math.sqrt(len2) * u;
    }
  }
  return { t: bestS / total, d2: bestD2 };
}

/**
 * Where along the limb the wheel's rotation takes over from the shoulder's.
 * Below GRIP_T0 the arm is bolted to the torso; at GRIP_T1 (the wrist, which
 * IS a point on the rim) it is bolted to the wheel.
 *
 * 0.15, not 0.28, and the reason is the ring spacing. `addTube` lays one ring
 * per control point, so the limb only has seven weights to work with: at
 * arc-length parameters 0, 0.20, 0.39 (elbow), 0.59, 0.82, 0.94, 1. A ramp
 * starting at 0.28 leaves the first two rings at zero and crams the whole
 * deformation into three segments, which at full lock is a 0.46 step between
 * adjacent rings — a visible kink rather than a bend. From 0.15 the weights run
 * 0 / 0.01 / 0.20 / 0.46 / 0.88 / 0.99 / 1: the same total travel spread over
 * five segments. The elbow moves about 60 mm at full lock, which is what an
 * elbow does when a driver turns a wheel a third of a turn, and the deltoid at
 * t≈0 still does not move at all.
 */
const GRIP_T0 = 0.15;
const GRIP_T1 = 1.0;

/** Superellipse outline; p ~3.4 traces a softly rounded rectangle. */
function squircle(t: number, p: number, out: [number, number]): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  out[0] = Math.sign(c) * Math.pow(Math.abs(c), 2 / p);
  out[1] = Math.sign(s) * Math.pow(Math.abs(s), 2 / p);
  return out;
}

/**
 * A patch of a sphere whose OUTLINE is a rounded rectangle rather than a
 * lat/long rectangle.
 *
 * This is the whole reason the round-1 visor read as a sticker: a
 * SphereGeometry cut with phiStart/thetaStart has four hard 90-degree corners,
 * and hard corners sitting on a curved surface look printed on however good
 * the material is. `profile` is a list of [outline scale, sphere radius] rings,
 * so one generator makes both the glass (scale 0 -> 1 at a constant radius, a
 * proper cap) and the bezel around it (scale 1 -> 1.2 with the radius rising
 * over a crest and sinking back under the shell, a chamfered rim that catches
 * a specular line off the low sun).
 */
function spherePatch(
  yawHalf: number, pitchMid: number, pitchHalf: number,
  profile: readonly (readonly [number, number])[], cols: number, sharp = 3.4,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const sc: [number, number] = [0, 0];
  for (let r = 0; r < profile.length; r++) {
    const s = profile[r][0];
    const R = profile[r][1];
    for (let j = 0; j <= cols; j++) {
      squircle((j / cols) * Math.PI * 2, sharp, sc);
      const u = sc[0] * yawHalf * s;
      const v = pitchMid + sc[1] * pitchHalf * s;
      const cv = Math.cos(v);
      pos.push(Math.sin(u) * cv * R, Math.sin(v) * R, Math.cos(u) * cv * R);
      uv.push(0.5 + sc[0] * s * 0.5, 0.5 + sc[1] * s * 0.5);
    }
  }
  for (let r = 0; r < profile.length - 1; r++) {
    for (let j = 0; j < cols; j++) {
      const a = r * (cols + 1) + j;
      // j walks clockwise as seen from outside the shell (u>0 lands on the
      // viewer's left), so the outward-facing winding is the reversed one.
      idx.push(a, a + cols + 2, a + 1, a, a + cols + 1, a + cols + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

interface DriverGeo {
  torso: Built;
  arms: Built;
  helmet: Built;
  visor: Built;
  wheel: Built;
}

let _geo: DriverGeo | null = null;
const _perLivery = new Map<number, { torso: THREE.BufferGeometry; arms: THREE.BufferGeometry; helmet: THREE.BufferGeometry; wheel: THREE.BufferGeometry }>();

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function torsoAndLegs(): Built {
  const m = new Mesher();

  // --- torso: a chamfered tub, leaned forward, wider at the shoulders ------
  const body: Section[] = [
    { z: 0.00, hw: 0.20, hh: 0.145, r: 0.08 },
    { z: 0.14, hw: 0.225, hh: 0.155, r: 0.085 },
    { z: 0.30, hw: 0.248, hh: 0.165, r: 0.09 },
    { z: 0.41, hw: 0.262, hh: 0.158, r: 0.095 },
    { z: 0.47, hw: 0.215, hh: 0.135, r: 0.09 },
  ];
  m.addLoft(body, Role.Suit, mat(0, 0.02, -0.02, -Math.PI / 2 + 0.17), { corner: 3, capStart: 0.06, capEnd: 0.05, capSeg: 1 });

  // chest panel in the team colour — reads as a race suit, not a blob
  m.addLoft(
    [{ z: 0.05, hw: 0.13, hh: 0.03, r: 0.02 }, { z: 0.30, hw: 0.16, hh: 0.03, r: 0.02 }],
    Role.Base,
    mat(0, 0.02, 0.115, -Math.PI / 2 + 0.17),
    { corner: 2, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
  );
  // --- neck + collar ------------------------------------------------------
  // Round 1 left a 6 cm gap between the top of the tub and the bottom of the
  // helmet: at hero distance you could see sky through the driver's throat,
  // which is the single biggest reason the head read as a floating ball. The
  // neck runs from inside the torso up to inside the helmet, so no pose of the
  // head rig can open the join back up.
  m.addLoft(
    [
      { z: 0.430, hw: 0.108, hh: 0.100, r: 0.048 },
      { z: 0.515, hw: 0.096, hh: 0.090, r: 0.044 },
      { z: 0.605, hw: 0.088, hh: 0.082, r: 0.040 },
    ],
    // Role.Shadowed, not Role.Plastic: round 2 called this "a bare black
    // cylinder", and half of that was the colour. #2b2d34 on a figure whose
    // every other surface carries the livery reads as a hole between the head
    // and the body; the darkened base coat reads as a balaclava under a collar.
    Role.Shadowed,
    mat(0, 0, 0.005, -Math.PI / 2),
    { corner: 2, closeStart: false, capEnd: 0.02, capSeg: 1 },
  );
  // COLLAR / HANS. Round 1 put this at y 0.395-0.455 — entirely inside the
  // torso tub, whose own top ring is at y ~0.48, so it was invisible and the
  // throat was left bare from 0.50 up to the helmet's lower edge at 0.570.
  // It now starts on the shoulder line and climbs to 0.572, where the shell
  // takes over, with the top ring narrow enough (0.106) to stay inside the
  // shell's cross-section once the head leans (max lateral shell travel at full
  // lean is 42 mm, and the shell is 107 mm wide at y = 0.60).
  m.addLoft(
    [
      { z: 0.452, hw: 0.152, hh: 0.142, r: 0.062 },
      { z: 0.510, hw: 0.130, hh: 0.122, r: 0.056 },
      { z: 0.572, hw: 0.106, hh: 0.100, r: 0.046 },
    ],
    Role.Trim,
    mat(0, 0, 0.005, -Math.PI / 2),
    { corner: 2, closeStart: false, capEnd: 0.022, capSeg: 1 },
  );

  // (shoulder balls now live in `arms()` — see the note there: they have to
  // travel with the counter-steer or the arm tears out of the socket)

  // --- legs: thigh forward, shin down to a boot ---------------------------
  for (const s of [-1, 1]) {
    m.addTube(
      [
        new THREE.Vector3(s * 0.135, 0.03, 0.03),
        new THREE.Vector3(s * 0.155, 0.075, 0.24),
        new THREE.Vector3(s * 0.162, 0.055, 0.44),
      ],
      (t) => 0.105 - t * 0.022,
      // 6 radial, not 8. The thigh runs from the seat pan into the nose
      // bodywork and the only part of it that ever reaches a pixel is the
      // 40 mm strip between the tub rail and the knee pad. This, the shin and
      // the pad below pay for the wheel-rim and roll-bar segment counts the
      // closeup note asks for — the triangles move from geometry the camera
      // cannot reach to geometry it is 1 m from.
      6,
      Role.Suit,
    );
    m.addTube(
      [
        new THREE.Vector3(s * 0.162, 0.055, 0.44),
        new THREE.Vector3(s * 0.166, -0.03, 0.55),
        new THREE.Vector3(s * 0.17, -0.10, 0.60),
      ],
      (t) => 0.085 - t * 0.012,
      6,
      Role.Suit,
    );
    // knee pad — a bright chip that catches the sun above the bodywork
    m.addGeometry(new THREE.SphereGeometry(0.085, 5, 4), Role.Base, mat(s * 0.158, 0.085, 0.42, 0, 0, 0, 1, 0.85, 1.15), 1.2);
    // Boot. Fully enclosed by the nose bodywork, so two sections is all it
    // earns — and the heel is left open: it starts 50 mm from the shin tube's
    // end cap, well inside that cap's 62 mm dome, so the 24 triangles the
    // chamfer there was costing could never reach a pixel. They pay for the
    // roll-hoop bracing instead.
    m.addLoft(
      [
        { z: 0.00, hw: 0.075, hh: 0.055, r: 0.03 },
        { z: 0.17, hw: 0.075, hh: 0.040, r: 0.026 },
      ],
      Role.Plastic,
      mat(s * 0.17, -0.14, 0.57, -0.25),
      { corner: 1, closeStart: false, capEnd: 0.03, capSeg: 1 },
    );
  }

  return m.finish();
}

/**
 * Arm and glove — per side, in hips space, then baked into the steering
 * column's frame.
 *
 * ROUND 2: "the arms are separate capsules with an unblended break at shoulder
 * and elbow" and "the hands are featureless pale pills with no fingers,
 * floating with a visible gap between glove and sleeve".
 *
 * Both are true and both come from the same decision: the limb was FOUR tubes
 * (upper arm / forearm / cuff / fist) butted end to end, each with its own
 * domed cap. Two domes meeting at an angle leave a crease you cannot shade
 * away, and the round-1 fix for the colour break — putting the forearm in a
 * different role from the upper arm — forced the split to exist.
 *
 * The limb is now ONE continuous swept tube from shoulder to wrist with a
 * monotonically tapering radius: parallel-transport frames mean it has no seam
 * at the elbow at all, because there is no join. The value break the round-1
 * note asked for is still there, but it is now a SLEEVE — a short concentric
 * tube 8 mm fatter, laid over the forearm section of the arm that continues
 * underneath it. A larger tube over a smaller one changes the colour without
 * touching the silhouette, and its own domed end reads as the edge of a sleeve
 * rather than as a cut.
 *
 * The hand is a mitten, not a pill:
 *   - the palm mass sits OUTBOARD of the rim,
 *   - a separate finger roll sits INBOARD of it,
 *   - so the rim physically passes between the two and the hand reads as
 *     wrapped rather than adjacent, from any angle,
 *   - a thumb runs up the rim tangent from the palm, which is the single
 *     silhouette cue that says "hand" at 130 px,
 *   - and the cuff overlaps BOTH the sleeve end and the palm, so there is no
 *     gap to see through however the arm is posed.
 * Every one of those points is derived from RIM_R / RIM_TUBE, so retuning the
 * wheel moves the whole grip with it.
 */
function arms(): Built {
  const m = new Mesher();
  const limbPaths: THREE.Vector3[][] = [];
  const col = columnMatrix();
  const hub = new THREE.Vector3(0, 0, 0).applyMatrix4(col);
  // the rim's own plane normal, in hips space: the axis fingers curl about
  const axis = new THREE.Vector3(0, 1, 0).transformDirection(col).normalize();
  const wrist = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const a0 = new THREE.Vector3();
  const a1 = new THREE.Vector3();
  const a2 = new THREE.Vector3();

  for (const s of [-1, 1]) {
    const phi = s * 1.05; // ten-to-two, 60 deg either side of the rim's crown
    rimPoint(phi, col, wrist);
    rimPoint(phi + 0.14, col, pa);
    rimPoint(phi - 0.14, col, pb);
    // phi = 0 is 12 o'clock, so increasing phi runs AWAY from the crown on the
    // right hand and toward it on the left. Negating by `s` makes +tan mean
    // "toward the crown" on both sides — which is what the thumb has to follow:
    // a hand at ten-to-two hooks its thumb over the top of the rim, and getting
    // this sign wrong points both thumbs at the floor.
    tan.subVectors(pa, pb).normalize().multiplyScalar(-s);
    radial.subVectors(wrist, hub).normalize();

    const shoulder = new THREE.Vector3(s * SHOULDER, 0.420, 0.030);
    const elbow = new THREE.Vector3(s * 0.318, 0.370, 0.226);
    // the arm stops just short of the rim; the palm covers the last 30 mm
    const wristIn = new THREE.Vector3(
      THREE.MathUtils.lerp(wrist.x, elbow.x, 0.13),
      THREE.MathUtils.lerp(wrist.y, elbow.y, 0.09),
      THREE.MathUtils.lerp(wrist.z, elbow.z, 0.09),
    );

    // deltoid: squashed ball wide enough to swallow the tube's start dome
    m.addGeometry(
      new THREE.SphereGeometry(0.108, 8, 6),
      Role.Trim,
      mat(shoulder.x, shoulder.y, shoulder.z, 0, 0, 0, 1, 0.92, 1.06),
      1.2,
    );
    // ONE limb, shoulder -> elbow -> wrist. Six control points, so the sweep
    // has enough samples to round the elbow without mitring it.
    const limb = [
      shoulder,
      new THREE.Vector3(s * 0.300, 0.394, 0.126),
      elbow,
      new THREE.Vector3(s * 0.288, 0.424, 0.318),
      new THREE.Vector3(s * 0.214, 0.482, 0.398),
      wristIn,
      // The GRIP point itself closes the chain. It is not swept — the glove
      // covers it — but the skin has to know that the limb ends on the rim,
      // not 30 mm short of it, or the palm's weight comes out below 1 and the
      // hand lags the wheel by a few degrees at full lock.
      wrist.clone(),
    ];
    limbPaths.push(limb);
    m.addTube(limb.slice(0, 6), (t) => 0.086 - 0.036 * Math.pow(t, 0.85), 9, Role.Suit);
    // Sleeve of the livery coat from the elbow down — the value break that
    // separates the limb from the dark tub it crosses. It is a CONCENTRIC tube
    // ~9 mm fatter than the limb running underneath it, so the colour changes
    // without the silhouette changing: no join, nothing to crease.
    m.addTube(limb.slice(2, 6), (t) => 0.078 - t * 0.022, 8, Role.Base);
    // cuff: overlaps the sleeve's end dome AND the palm, so no pose can open a
    // gap between glove and sleeve
    a0.lerpVectors(wristIn, limb[4], 0.34);
    a1.lerpVectors(wristIn, wrist, 0.55);
    m.addTube([a0, a1], 0.058, 9, Role.Trim);

    // --- glove ------------------------------------------------------------
    // palm / back of hand: outboard of the rim, swept along it
    a0.copy(wrist).addScaledVector(radial, 0.022).addScaledVector(tan, -0.058);
    a1.copy(wrist).addScaledVector(radial, 0.026);
    a2.copy(wrist).addScaledVector(radial, 0.022).addScaledVector(tan, 0.052);
    m.addTube(
      [a0, a1, a2],
      (t) => 0.052 - Math.abs(t - 0.45) * 0.040,
      9, Role.Glove,
    );
    // finger roll: inboard of the rim, so the rim runs THROUGH the hand
    a0.copy(wrist).addScaledVector(radial, -0.030).addScaledVector(tan, -0.046)
      .addScaledVector(axis, 0.012);
    a1.copy(wrist).addScaledVector(radial, -0.034).addScaledVector(axis, 0.014);
    a2.copy(wrist).addScaledVector(radial, -0.030).addScaledVector(tan, 0.040)
      .addScaledVector(axis, 0.012);
    m.addTube([a0, a1, a2], (t) => 0.024 - Math.abs(t - 0.5) * 0.012, 7, Role.Glove);
    // thumb: off the top of the palm, laid along the rim toward the crown
    a0.copy(wrist).addScaledVector(radial, 0.020).addScaledVector(tan, 0.030)
      .addScaledVector(axis, 0.016);
    a1.copy(wrist).addScaledVector(radial, 0.006).addScaledVector(tan, 0.070)
      .addScaledVector(axis, 0.020);
    a2.copy(wrist).addScaledVector(radial, -0.012).addScaledVector(tan, 0.098)
      .addScaledVector(axis, 0.014);
    m.addTube([a0, a1, a2], (t) => 0.020 - t * 0.006, 6, Role.Glove);
    // knuckle strap: a dark band across the back of the hand. One thin tube,
    // and it is what stops the glove reading as a featureless pale pill.
    a0.copy(wrist).addScaledVector(radial, 0.040).addScaledVector(tan, -0.030)
      .addScaledVector(axis, -0.030);
    a1.copy(wrist).addScaledVector(radial, 0.046).addScaledVector(tan, -0.026);
    a2.copy(wrist).addScaledVector(radial, 0.040).addScaledVector(tan, -0.030)
      .addScaledVector(axis, 0.030);
    m.addTube([a0, a1, a2], 0.011, 5, Role.Plastic);
  }
  const b = m.finish();

  // --- skin weights -------------------------------------------------------
  // One float per vertex: 0 = rides the torso, 1 = rides the steering wheel.
  // Computed in HIPS space, before the column bake below, because that is the
  // space the limb polylines are authored in. See `gripArmMaterial` in
  // Liveries for what the shader does with it.
  {
    const pos = b.geo.getAttribute('position');
    const grip = new Float32Array(pos.count);
    const lens = limbPaths.map((path) => {
      const l = new Float64Array(path.length);
      for (let i = 1; i < path.length; i++) l[i] = l[i - 1] + path[i].distanceTo(path[i - 1]);
      return l;
    });
    const p = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const rel = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      let best = Infinity;
      let t = 0;
      for (let k = 0; k < limbPaths.length; k++) {
        const total = lens[k][lens[k].length - 1];
        const r = limbParam(limbPaths[k], lens[k], total, p, seg, rel);
        if (r.d2 < best) { best = r.d2; t = r.t; }
      }
      const x = THREE.MathUtils.clamp((t - GRIP_T0) / (GRIP_T1 - GRIP_T0), 0, 1);
      grip[i] = x * x * (3 - 2 * x); // smoothstep: C1 at both ends, no crease
    }
    b.geo.setAttribute('aGrip', new THREE.BufferAttribute(grip, 1));
  }

  // Bake into the steering-column frame. The skin's rotation is about local +Y,
  // so this is what makes local +Y the column axis — and therefore what makes
  // "weight 1" mean "in the steering wheel's own frame" exactly.
  b.geo.applyMatrix4(columnMatrix().invert());
  return b;
}

function columnMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    COL_POS,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(COL_RAKE, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Steering wheel, authored directly in column-local space (axis = +Y). */
function steeringWheel(): Built {
  const m = new Mesher();
  const R = RIM_R;
  // 18 segments, not 12: at hero distance a 12-gon rim silhouettes as a
  // dodecagon and the hands sit right on top of it.
  // 4 radial, not 5: the rim's tube is 30 mm across and the hands now cover a
  // third of it, so the extra ring bought nothing the glove does not hide.
  const rim = new THREE.TorusGeometry(R, RIM_TUBE, 4, 16);
  rim.rotateX(-Math.PI / 2); // torus axis +Z -> +Y
  m.addGeometry(rim, Role.Plastic, undefined, 1.6);
  // three spokes in the trim colour; the loft runs along +Z so a plain yaw
  // fans them out inside the wheel plane. The inboard end is left open — it is
  // buried inside the boss below and can never be seen.
  for (let i = 0; i < 3; i++) {
    m.addLoft(
      [
        { z: 0.02, hw: 0.028, hh: 0.016, r: 0.008 },
        { z: R - 0.012, hw: 0.020, hh: 0.013, r: 0.006 },
      ],
      Role.Trim,
      mat(0, 0, 0, 0, Math.PI + (i * Math.PI * 2) / 3, 0),
      { corner: 1, closeStart: false, capEnd: 0.01, capSeg: 1 },
    );
  }
  // boss with the team badge colour
  m.addLoft(
    [
      { z: -0.022, hw: 0.055, hh: 0.055, r: 0.05 },
      { z: 0.018, hw: 0.052, hh: 0.052, r: 0.048 },
    ],
    Role.Base,
    mat(0, 0, 0, Math.PI / 2),
    { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
  );
  return m.finish();
}

// Eye port: 128 deg of yaw, straddling the helmet equator so the chin bar
// closes under it. Bezel and glass share these so they can never disagree.
// The pitch half came down from 0.30 to 0.255 in round 2: a port that tall on a
// 205 mm shell is most of the front of the head, which is why the visor read as
// "a hole" rather than as a shield set into a helmet.
const VISOR_YAW = 1.12;
const VISOR_PITCH = 0.145;
const VISOR_HALF = 0.255;
const VISOR_COLS = 22;
/** Shell radius; every face element is authored against it. */
const SHELL_R = 0.205;

/** Full-face helmet, authored in head-local space (origin = neck pivot). */
function helmet(): { helmet: Built; visor: Built } {
  const m = new Mesher();
  const cy = 0.175;
  const shell = mat(0, cy, 0.005, 0, 0, 0, 1.0, 0.98, 1.04);
  // Shell: 24 x 15 rather than 16 x 11. The helmet is roughly 130 px across in
  // the hero framing, so 16 segments puts a visible 8 px chord on the
  // silhouette — and with the Mesher no longer de-indexing primitives it is
  // smooth-shaded now, so the extra rings actually buy curvature rather than
  // just more flat facets.
  m.addGeometry(new THREE.SphereGeometry(SHELL_R, 22, 14), Role.Base, shell, 1.5);
  // crown stripe
  m.addGeometry(
    // 3 width segments across a 0.38 rad band: the stripe's WIDTH is 22 deg, so
    // more than three chords along it is triangles spent on a straight line.
    new THREE.SphereGeometry(0.207, 3, 14, Math.PI / 2 - 0.19, 0.38, 0, Math.PI),
    Role.Trim,
    mat(0, cy, 0.005, 0, 0, 0, 1.0, 0.985, 1.045),
    1.5,
  );
  // CHIN BAR. Round 2: "the visor is a flat dark quad ... with a strange white
  // X-shaped seam crossing the face". Two separate faults, and this primitive
  // owned both halves of the second one.
  //
  //  - It was Role.Trim. On a livery whose trim is a pale mint that is a BRIGHT
  //    bar laid across the lower half of the face, and with the brow peak doing
  //    the same above it the eye port was squeezed into a dark slot between two
  //    pale bars. It is now Role.Shadowed: the chin reads as a form on the
  //    helmet, and the mint is left to the crown stripe alone, where it is a
  //    stripe rather than a stripe-plus-two-bars.
  //  - `addLoft` ALWAYS closes an end with a flat centroid fan, chamfer or no.
  //    With hh 0.055 and capEnd 0.03 the fan left a 170 x 60 mm FLAT DISC on
  //    the front of the chin, pointed straight down the camera in the hero
  //    shot, and a centroid fan over a rounded rect seen face-on is precisely
  //    an X-shaped star of shading. capEnd is now 0.052 against hh 0.055, so
  //    the residual disc is 6 mm across: the end is a dome, not a plate.
  //
  // It also sits 25 mm lower and 20 mm further back so it closes UNDER the eye
  // port instead of crowding into it.
  m.addLoft(
    [
      { z: -0.05, hw: 0.100, hh: 0.062, r: 0.034 },
      { z: 0.055, hw: 0.112, hh: 0.068, r: 0.038 },
      { z: 0.140, hw: 0.092, hh: 0.058, r: 0.032 },
    ],
    Role.Shadowed,
    mat(0, cy - 0.140, 0.040, -0.20),
    { corner: 2, capStart: 0.05, capEnd: 0.056, capSeg: 2 },
  );
  // Visor bezel: a rounded-rectangle ring that rises 7 mm proud of the glass
  // and sinks back under the shell on its outer edge. The glass therefore sits
  // in a genuine recess with a chamfered lip around it — and that lip is the
  // element that catches a hard specular line off the low sun, which is what
  // makes the whole assembly read as a shield rather than a decal.
  m.addGeometry(
    spherePatch(VISOR_YAW, VISOR_PITCH, VISOR_HALF, [
      [0.930, 0.2035],   // inner lip, tucked BEHIND the glass edge
      [0.985, 0.2110],
      [1.045, 0.2158],
      [1.105, 0.2146],
      [1.200, 0.2030],
    ], VISOR_COLS),
    Role.Plastic, shell, 1.5,
  );
  // rear aero fin
  m.addLoft(
    [
      { z: 0.0, hw: 0.018, hh: 0.05, r: 0.012 },
      { z: 0.09, hw: 0.014, hh: 0.035, r: 0.01 },
    ],
    Role.Accent,
    mat(0, cy + 0.10, -0.15, 0.55),
    { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
  );
  // Brow peak: 25 mm higher and 25 mm further back than round 1, and slimmer.
  // It used to cross the top third of the eye port in the hero framing, which
  // is what made the port read as a slot with a pale bar through it.
  m.addLoft(
    [
      { z: 0.0, hw: 0.118, hh: 0.019, r: 0.011 },
      { z: 0.048, hw: 0.100, hh: 0.014, r: 0.009 },
    ],
    Role.Trim,
    mat(0, cy + 0.112, 0.125, -0.62),
    { corner: 1, capStart: 0.013, capEnd: 0.013, capSeg: 2 },
  );

  // THE GLASS. A true spherical cap at a constant radius, so it is optically a
  // piece of a sphere and the reflected sun sweeps across it cleanly as the
  // head turns.
  //
  // Round 1 ended it at scale 1.000 / R 0.2085 — the same ring, to seven
  // figures, as the bezel's inner edge. Two surfaces sharing an edge exactly
  // is a z-fight along the whole aperture, and a z-fight on a 22-segment ring
  // is exactly the "jagged aliased boundary" round 2 reported. The glass now
  // stops at 0.965 / 0.2072, 2 mm proud of the bezel's inner lip (0.930 /
  // 0.2035) and 6 mm under its crest, so the lip visibly overlaps the glass:
  // a real recess, and nothing coplanar anywhere near it.
  const v = new Mesher();
  v.addGeometry(
    // Four rings, not five. The glass is a CONSTANT-radius cap — every ring
    // lies on the same sphere — so the interior rings buy no curvature at all;
    // they only subdivide a surface that is already exactly spherical. All the
    // shape is in the outline, and the outline is `VISOR_COLS`, which is
    // untouched. 44 triangles toward the wheel rim.
    spherePatch(VISOR_YAW, VISOR_PITCH, VISOR_HALF, [
      [0.000, 0.2072],
      [0.500, 0.2072],
      [0.800, 0.2072],
      [0.965, 0.2072],
    ], VISOR_COLS),
    Role.Plastic, shell, 1,
  );
  return { helmet: m.finish(), visor: v.finish() };
}

function driverGeo(): DriverGeo {
  if (_geo) return _geo;
  const h = helmet();
  _geo = { torso: torsoAndLegs(), arms: arms(), helmet: h.helmet, visor: h.visor, wheel: steeringWheel() };
  return _geo;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

function damp(cur: number, target: number, lambda: number, dt: number) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export class DriverRig {
  readonly root = new THREE.Group();

  // --- pose targets, -1..1 ------------------------------------------------
  steer = 0;
  lean = 0;
  pitch = 0;
  duck = 0;
  apex = 0;

  private hips = new THREE.Group();
  private head = new THREE.Group();
  private column = new THREE.Group();
  private armRig = new THREE.Group();
  private wheelNode = new THREE.Group();
  private armGrip: GripArmMaterial;

  private sSteer = 0;
  private sLean = 0;
  private sPitch = 0;
  private sDuck = 0;
  private sApex = 0;
  private joltAmt = 0;
  private clock = Math.random() * 10; // desync the idle across the grid
  /** set once someone calls update() — kills the self-driving fallback */
  private driven = false;
  private lastTick = 0;

  constructor(livery: Livery) {
    const g = driverGeo();
    const mats = kartMaterials();
    let per = _perLivery.get(livery.index);
    if (!per) {
      per = {
        torso: liveryGeometry(g.torso, livery),
        arms: liveryGeometry(g.arms, livery),
        helmet: liveryGeometry(g.helmet, livery),
        wheel: liveryGeometry(g.wheel, livery),
      };
      // `liveryGeometry` re-uses the source buffers and only owns a fresh colour
      // attribute, so the skin weights have to be carried across by hand. They
      // are livery-independent, so all eight share the one buffer.
      per.arms.setAttribute('aGrip', g.arms.geo.getAttribute('aGrip'));
      _perLivery.set(livery.index, per);
    }
    this.armGrip = gripArmMaterial();

    const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, name: string) => {
      const o = new THREE.Mesh(geo, material);
      o.castShadow = true;
      o.name = name;
      return o;
    };

    this.hips.add(mesh(per.torso, mats.character, 'driverTorso'));
    this.head.position.copy(HEAD_POS);
    this.head.add(mesh(per.helmet, mats.paint, 'driverHelmet'));
    this.head.add(mesh(g.visor.geo, mats.glass, 'driverVisor'));
    this.hips.add(this.head);

    this.column.position.copy(COL_POS);
    this.column.rotation.x = COL_RAKE;
    this.armRig.position.copy(COL_POS);
    this.armRig.rotation.x = COL_RAKE;
    this.column.add(this.wheelNode);
    this.wheelNode.add(mesh(per.wheel, mats.plastic, 'steeringWheel'));
    this.armRig.add(mesh(per.arms, this.armGrip.material, 'driverArms'));

    this.hips.add(this.column);
    this.hips.add(this.armRig);
    this.root.add(this.hips);
    this.root.name = 'driver';
    this.root.userData.rig = this;

    // Fallback: if nobody drives the rig, breathe and settle on our own clock
    // so the figure is never a statue. Disables itself the moment a real
    // system calls update(). The shadow pass gets a ~0 delta and is a no-op.
    const torso = this.hips.children[0] as THREE.Mesh;
    torso.onBeforeRender = () => {
      if (this.driven) return;
      const now = performance.now() / 1000;
      const dt = this.lastTick ? Math.min(0.05, now - this.lastTick) : 0;
      this.lastTick = now;
      if (dt > 0) this.apply(dt);
    };
  }

  /** Convenience for callers that would rather push a whole pose at once. */
  setPose(steer: number, lean: number, pitch: number, duck: number, apex: number) {
    this.steer = steer;
    this.lean = lean;
    this.pitch = pitch;
    this.duck = duck;
    this.apex = apex;
  }

  /** One-shot shove — collisions, landings, item hits. */
  jolt(strength: number) {
    this.joltAmt = Math.min(1.5, this.joltAmt + strength);
  }

  update(dt: number) {
    this.driven = true;
    this.apply(dt);
  }

  private apply(dt: number) {
    this.clock += dt;
    this.sSteer = damp(this.sSteer, THREE.MathUtils.clamp(this.steer, -1, 1), 13, dt);
    this.sLean = damp(this.sLean, THREE.MathUtils.clamp(this.lean, -1, 1), 7, dt);
    this.sPitch = damp(this.sPitch, THREE.MathUtils.clamp(this.pitch, -1, 1), 6, dt);
    this.sDuck = damp(this.sDuck, THREE.MathUtils.clamp(this.duck, 0, 1), 9, dt);
    this.sApex = damp(this.sApex, THREE.MathUtils.clamp(this.apex, -1, 1), 5, dt);
    this.joltAmt *= Math.exp(-9 * dt);

    // idle: a slow breath plus a faster tremor that scales with the shove
    const breath = Math.sin(this.clock * 1.7) * 0.012;
    const shudder = Math.sin(this.clock * 46) * this.joltAmt * 0.05;

    // +lean is a right-hand corner, and +X is the kart's right, so the torso
    // rolls toward -Z-rotation to fall into the turn.
    this.hips.rotation.z = -this.sLean * 0.17 + shudder;
    this.hips.rotation.x = -this.sPitch * 0.09 + this.sDuck * 0.34 + breath;
    this.hips.position.y = -this.sDuck * 0.07 - Math.abs(this.sLean) * 0.012 + breath * 0.4;
    this.hips.position.z = this.sDuck * 0.035;

    this.head.rotation.y = this.sApex * 0.62;
    this.head.rotation.z = -this.sLean * 0.24 - shudder * 1.6;
    this.head.rotation.x = -this.sDuck * 0.22 - this.sPitch * 0.05 - breath * 1.6;

    // 0.62 rad (35 deg) of rim throw, down from 0.85 (49 deg).
    //
    // This is a consequence of the grip skin below, and it is the honest number
    // rather than the convenient one. Once the hands actually track the rim, the
    // rim's throw IS the arm's throw, and 49 deg swings the forearm far enough
    // about the column axis to drive it through the wheel and the driver's own
    // chest at full lock — rendered and confirmed. It was only ever survivable
    // because the arms were ignoring the wheel. 35 deg is also the truer number:
    // a kart has direct, unassisted steering and a real one turns about a third
    // of a turn lock to lock, not two thirds.
    this.wheelNode.rotation.y = -this.sSteer * 0.62;
    // THE GRIP. The arm node itself no longer turns: it used to swing at 0.22
    // against the rim's 0.85, which is 0.63 rad of slip at full lock and 98 mm
    // of daylight between the glove and the wheel it is supposed to be holding.
    // The skin now carries the whole difference — weight 0 at the deltoid,
    // weight 1 at the wrist, which is the rim's own frame — so the hands are on
    // the wheel at every steering angle by construction and the shoulder never
    // leaves the torso. One float, set from the wheel's own rotation, so the two
    // physically cannot disagree.
    this.armGrip.angle.value = this.wheelNode.rotation.y;
  }
}

/** Build a driver for one livery. Geometry is shared; only colours differ. */
export function buildDriver(livery: Livery): DriverRig {
  return new DriverRig(livery);
}

/** Triangle count of one driver, for the kart's budget report. */
export function driverTriangles(): number {
  const g = driverGeo();
  return g.torso.triangles + g.arms.triangles + g.helmet.triangles + g.visor.triangles + g.wheel.triangles;
}
