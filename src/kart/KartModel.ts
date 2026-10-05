/**
 * ============================================================================
 *  KartModel — the object the player stares at for the whole race.
 * ============================================================================
 *  Chunky Nintendo proportions: 0.36 m wheels against a 2.0 m body, an open
 *  tub with visible side rails, fat rear fenders and a driver sitting proud of
 *  the bodywork. Nothing here is a box: every part is lofted through chamfered
 *  cross-sections so each edge carries a highlight.
 *
 *  Local frame (matches Kart.step): +Z forward, +Y up, +X is the kart's RIGHT.
 *  y = 0 is the ground contact plane, so the root can be dropped straight onto
 *  a surface probe.
 *
 *  --- what other systems can reach ------------------------------------------
 *  root.userData.body          Group  — physics animates roll / pitch / squash
 *  root.userData.driver        DriverRig — see Driver.ts for the pose API
 *  root.userData.exhausts      Object3D[2] — boost flame anchors, +Z points out
 *  root.userData.sparks        Object3D[2] — rear contact patches, drift sparks
 *  root.userData.wheelContacts Object3D[4] — FL, FR, RL, RR at ground level
 *  root.userData.livery        Livery — colours for HUD / minimap / particles
 *  root.userData.shadowBlob    Mesh — fake contact shadow, hide it if you own
 *                                     a better one
 *  root.userData.triangles     number
 *  Named children: 'body', 'driver', 'exhaustL/R', 'sparkL/R', 'wheelFL' ...
 *
 *  Wheels are returned FL, FR, RL, RR (front = +Z, and index 0/2 are the -X
 *  side, matching the ordering the physics placeholder shipped with). Each is
 *  a pivot with `rotation.order = 'YXZ'`, so physics can set `rotation.y` for
 *  steer and `rotation.x` for roll on the same object and get the right result.
 * ============================================================================
 */
import * as THREE from 'three';
import type { KartStats } from '../types';
import {
  Mesher, PANEL_SIZE, PANEL_UV, Role, WHEEL_UV, contactShadow, getLivery, heroPaint,
  impostorMaterial, kartMaterials, liveryGeometry, mat, shadowOnlyMaterial, syncKartEnv,
  type Built, type Livery, type Section,
} from './Liveries';
import { buildDriver, driverTriangles, DriverRig } from './Driver';

// --- hard dimensions ---------------------------------------------------------
const WHEEL_R = 0.36;
const WHEEL_HW = 0.15;
const TRACK_X = 0.72;     // half track width
const FRONT_Z = 0.72;
const REAR_Z = -0.74;
/** Outermost radius the tyre reaches, tread scallop included. */
const TYRE_OUTER_R = 0.376;

/**
 * Resample a control polyline through a Catmull-Rom so `addTube` sweeps a
 * continuous curve instead of mitring at every control point. A chrome tube
 * with faceted bends catches broken specular — the highlight jumps from facet
 * to facet instead of running along the bend — and chrome at roughness 0.15
 * needs *curvature* to have anything to reflect in the first place.
 *
 * Samples are placed at equal increments of (arc length + BEND_W x turning
 * angle), NOT at equal arc length. Equal spacing is the obvious thing and it is
 * the wrong thing: it spends the same number of samples on the roll hoop's
 * dead-straight uprights as on its shoulders, so the residual facet all piles
 * up in the two bends that are actually on the silhouette. Weighting by
 * curvature moves samples from where they buy nothing to where they buy
 * everything — on the hoop it takes the worst joint from 17.6 to 13.4 degrees
 * for exactly zero extra triangles, which is the same result as raising the
 * sample count from 22 to 30.
 */
const BEND_W = 0.5;
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

function smoothPath(pts: THREE.Vector3[], n: number): THREE.Vector3[] {
  const fineN = Math.max(64, (n - 1) * 8);
  const fine = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5).getSpacedPoints(fineN);
  // w[i] = cost of reaching fine[i]; strictly increasing, so it inverts cleanly
  const w = new Float64Array(fineN + 1);
  for (let i = 1; i <= fineN; i++) {
    let turn = 0;
    if (i < fineN) {
      _sa.subVectors(fine[i], fine[i - 1]).normalize();
      _sb.subVectors(fine[i + 1], fine[i]).normalize();
      turn = Math.acos(THREE.MathUtils.clamp(_sa.dot(_sb), -1, 1));
    }
    w[i] = w[i - 1] + fine[i].distanceTo(fine[i - 1]) + BEND_W * turn;
  }
  const out: THREE.Vector3[] = [fine[0].clone()];
  let k = 1;
  for (let s = 1; s < n - 1; s++) {
    const t = (s / (n - 1)) * w[fineN];
    while (k < fineN && w[k] < t) k++;
    const f = (t - w[k - 1]) / Math.max(1e-9, w[k] - w[k - 1]);
    out.push(new THREE.Vector3().lerpVectors(fine[k - 1], fine[k], f));
  }
  out.push(fine[fineN].clone());
  return out;
}

// ---------------------------------------------------------------------------
// Chassis — four merged buckets, one draw call each
// ---------------------------------------------------------------------------

interface ChassisGeo {
  paint: Built;
  decal: Built;
  chrome: Built;
  plastic: Built;
  fender: Built;
}
let _chassis: ChassisGeo | null = null;

/**
 * Ceiling on how far the fender node tracks the wheels — past this it would
 * visibly detach from the bodywork it is bolted to. Suspension's `visualOffset`
 * clamps at 0.18 m, so the tyre can out-run the fender by at most
 * 0.18 - FEND_MAX_LIFT m. Measured against the built geometry, the closest
 * fender vertex that overlaps the tyre's tread band sits 81 mm off the tread at
 * rest (the section's outward flare puts its lowest points either side of the
 * tyre, not over it) and 36 mm at the very bottom of the travel, so the tread
 * cannot reach the arch anywhere in the range. The ceiling is kept this low deliberately: the arch's forward end is
 * buried in the side pod (see the angular span below) and that is what makes it
 * read as mounted rather than floating, so it must not lift far enough to pull
 * its own root out into the open.
 */
const FEND_MAX_LIFT = 0.10;
/** Crown clearance at the section centreline. See the measurement above. */
const FEND_GAP = 0.030;

function buildChassis(): ChassisGeo {
  if (_chassis) return _chassis;

  const P = new Mesher(); // painted bodywork
  const D = new Mesher(); // livery decal panels
  const C = new Mesher(); // chrome
  const M = new Mesher(); // matte plastic
  const F = new Mesher(); // painted rear fenders — own node, tracks the wheels

  // --- floor pan ----------------------------------------------------------
  // Deliberately on the MATTE mesher, not the painted one. It is the darkest
  // large surface on the kart and it sits nearly edge-on to the camera, which
  // is the worst possible case for a clearcoat: round 1 put it on the lacquer
  // and the whole skirt crawled with white per-pixel sparkle. Nothing under a
  // kart is polished anyway.
  M.addLoft(
    [
      { z: -0.86, hw: 0.44, hh: 0.045, y: 0.195, r: 0.03 },
      { z: -0.40, hw: 0.47, hh: 0.05, y: 0.195, r: 0.035 },
      { z: 0.20, hw: 0.46, hh: 0.05, y: 0.20, r: 0.035 },
      { z: 0.62, hw: 0.42, hh: 0.048, y: 0.205, r: 0.03 },
      { z: 0.96, hw: 0.30, hh: 0.042, y: 0.215, r: 0.028 },
    ],
    Role.Shadowed,
    undefined,
    { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
  );

  // --- side rails: the wrapped cockpit tub --------------------------------
  for (const s of [-1, 1]) {
    P.addLoft(
      [
        { z: -0.78, hw: 0.072, hh: 0.115, y: 0.35, r: 0.05 },
        { z: -0.52, hw: 0.078, hh: 0.185, y: 0.42, r: 0.055 },
        { z: -0.12, hw: 0.080, hh: 0.190, y: 0.435, r: 0.058 },
        { z: 0.24, hw: 0.076, hh: 0.170, y: 0.425, r: 0.055 },
        { z: 0.56, hw: 0.070, hh: 0.135, y: 0.40, r: 0.05 },
      ],
      Role.Base,
      mat(s * 0.437, 0, 0),
      { corner: 2, capStart: 0.05, capEnd: 0.05 },
    );
    // rail cap stripe — a trim-coloured bead along the top edge of the tub
    P.addLoft(
      [
        { z: -0.70, hw: 0.055, hh: 0.016, y: 0.60, r: 0.012 },
        { z: -0.12, hw: 0.060, hh: 0.018, y: 0.628, r: 0.014 },
        { z: 0.50, hw: 0.052, hh: 0.016, y: 0.538, r: 0.012 },
      ],
      Role.Trim,
      mat(s * 0.437, 0, 0),
      { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
    );
  }

  // --- nose: swept, tapering, sitting on the floor pan --------------------
  P.addLoft(
    [
      { z: 0.46, hw: 0.44, hh: 0.145, y: 0.385, r: 0.09, taper: -0.14 },
      { z: 0.66, hw: 0.43, hh: 0.150, y: 0.385, r: 0.09, taper: -0.16 },
      { z: 0.86, hw: 0.38, hh: 0.140, y: 0.375, r: 0.085, taper: -0.20 },
      { z: 1.00, hw: 0.30, hh: 0.115, y: 0.360, r: 0.07, taper: -0.24 },
    ],
    Role.Base,
    undefined,
    { corner: 2, capStart: 0.05, capEnd: 0.06 },
  );

  // --- side pods ----------------------------------------------------------
  for (const s of [-1, 1]) {
    // The flat run of the flank (between the corner radii) is exactly the
    // height of the livery panel that sits on it, and the tumblehome matches
    // the panel's tilt, so the decal lies flush instead of hovering.
    P.addLoft(
      [
        { z: -0.34, hw: 0.128, hh: 0.150, y: 0.350, r: 0.05, taper: -0.10 },
        { z: -0.10, hw: 0.145, hh: 0.170, y: 0.350, r: 0.05, taper: -0.10 },
        { z: 0.14, hw: 0.142, hh: 0.168, y: 0.350, r: 0.05, taper: -0.10 },
        { z: 0.32, hw: 0.118, hh: 0.140, y: 0.348, r: 0.05, taper: -0.12 },
      ],
      Role.Base,
      mat(s * 0.635, 0, 0),
      { corner: 2, capStart: 0.05, capEnd: 0.05 },
    );
    // pod intake mouth, recessed and dark so the pod reads as hollow
    M.addLoft(
      [
        { z: 0.0, hw: 0.055, hh: 0.075, y: 0.35, r: 0.03 },
        { z: 0.05, hw: 0.045, hh: 0.065, y: 0.35, r: 0.025 },
      ],
      Role.Plastic,
      mat(s * 0.635, 0, 0.30),
      { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
    );
  }

  // --- rear engine block --------------------------------------------------
  P.addLoft(
    [
      { z: -0.94, hw: 0.30, hh: 0.215, y: 0.49, r: 0.075, taper: -0.1 },
      { z: -0.80, hw: 0.335, hh: 0.245, y: 0.50, r: 0.085, taper: -0.1 },
      { z: -0.62, hw: 0.325, hh: 0.235, y: 0.495, r: 0.08, taper: -0.12 },
    ],
    Role.Base,
    undefined,
    // shallow rear chamfer so the number plate has a flat face to sit on
    { corner: 2, capStart: 0.03, capEnd: 0.05 },
  );
  // cooling fins on top of the block
  for (let i = 0; i < 3; i++) {
    M.addLoft(
      [
        { z: -0.90, hw: 0.019, hh: 0.035, y: 0.755, r: 0.008 },
        { z: -0.66, hw: 0.019, hh: 0.042, y: 0.765, r: 0.008 },
      ],
      Role.Plastic,
      mat((i - 1) * 0.105, 0, 0),
      { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
    );
  }
  // airbox scoop
  C.addLoft(
    [
      { z: -0.70, hw: 0.10, hh: 0.055, y: 0.80, r: 0.03 },
      { z: -0.56, hw: 0.115, hh: 0.062, y: 0.815, r: 0.035 },
    ],
    Role.Steel,
    undefined,
    { corner: 2, capStart: 0.03, capEnd: 0.035 },
  );

  // --- rear fenders: a fat arc over each rear wheel ------------------------
  // Sized off TYRE_OUTER_R rather than by eye, and on their OWN mesher.
  //
  // Round 1 put the inner face at 0.375 against a 0.376 tyre, so the tread came
  // through the fender at rest. A static gap fixes the static shot and nothing
  // else: the fenders hang off `body`, which only rolls and pitches, while the
  // wheels live on `root` and are driven by Suspension.visualOffset — up to
  // 0.18 m of vertical travel relative to the bodywork, clamped. Under the
  // lateral load of a drift the outside rear compresses ~0.12 m past rest, so
  // ANY plausible static clearance is punched straight through in exactly the
  // cornering and drift frames the review shoots. Matching 0.18 m statically
  // would mean a mudguard floating 20 cm off the tyre, which is a worse defect
  // than the one it fixes.
  //
  // So the pair goes on a node that rides with the rear axle (see buildKart),
  // and the gap only has to cover the residual the node's own clamp leaves.
  const FEND_HH = 0.048;
  const FEND_R = TYRE_OUTER_R + FEND_GAP + FEND_HH;
  for (const s of [-1, 1]) {
    const arc: Section[] = [];
    const N = 6;
    for (let i = 0; i <= N; i++) {
      // 150 deg -> 2.5 deg. The forward end used to stop at 30 deg, which put it
      // 19 mm above the side pod with nothing between the two: a mudguard
      // anchored to thin air, and a slot you can see daylight through in the
      // hero crop. Carried down to the axle line it plunges INTO the pod
      // instead, so the arch grows out of the bodywork — and it stays buried
      // through the whole FEND_MAX_LIFT range, which is what lets the arch move
      // with the wheel without its root ever coming into view. Two painted
      // surfaces of the same coat interpenetrating is invisible; a painted
      // surface interpenetrating a black tyre is the note we are answering.
      const a = THREE.MathUtils.lerp(2.62, 0.044, i / N);
      arc.push({
        z: REAR_Z + Math.cos(a) * FEND_R,
        y: WHEEL_R + Math.sin(a) * FEND_R,
        hw: 0.168,
        hh: FEND_HH,
        r: 0.038,
        taper: -0.45, // curls the outer face over instead of ending in a shelf
      });
    }
    F.addLoft(arc, Role.Base, mat(s * TRACK_X, 0, 0), { corner: 2, capStart: 0.03, capEnd: 0.03, capSeg: 1 });
  }

  // --- front bumper: a bowed bar, painted, with a chrome rub strip ---------
  const bumper = (hw: number, hh: number, y: number, role: number, mesher: Mesher, zOff: number, corner: number) => {
    const secs: Section[] = [];
    for (let i = 0; i <= 4; i++) {
      const u = (i / 4) * 2 - 1;
      secs.push({ z: u * 0.50, hw, hh, x: u * u * 0.075 + zOff, y, r: Math.min(hw, hh) * 0.8 });
    }
    // loft runs along local +Z; a quarter turn about Y sends it across the kart
    mesher.addLoft(secs, role, mat(0, 0, 1.03, 0, Math.PI / 2, 0), { corner, capStart: 0.05, capEnd: 0.05 });
  };
  bumper(0.085, 0.075, 0.30, Role.Base, P, 0, 3);
  // Rub strip, corner 3 and not 1, and 72 x 44 mm rather than 60 x 60.
  //
  // At corner 1 the ring is an octagon, and an octagon swept along a gentle bow
  // gives ONE flat facet aimed at the sky for the strip's whole 1 m length. A
  // flat facet on a metalness-1 / roughness-0.15 surface returns one env sample
  // over its entire area, so it clips to a single uniform white-blue bar with
  // no break in it anywhere — which is the closeup note verbatim, and it is a
  // geometry defect, not a roughness one. No roughness map can put a highlight
  // gradient on a surface whose normal never changes. corner 3 makes it a
  // 16-gon: the normal now turns continuously across the top, the reflection
  // sweeps through the env instead of sampling one point of it, and the bar
  // becomes a rolled highlight with a dark shoulder either side. 96 triangles.
  //
  // ROUND 7 — IT IS STILL A LIGHTSABER, AND THE REMAINING HALF IS THE SECTION.
  // corner 3 made the ring a 16-gon, but the ring was SQUARE (hw = hh = 0.030
  // with r = 0.8 x min = 0.024), which is a circle to within 6 mm. A circular
  // section swept along a bow has no preferred direction: every one of those 16
  // normals finds some part of the bright horizon band, so the "gradient" is a
  // gradient between two clipped values and the bar is uniform white over its
  // whole 1 m. 0.036 x 0.022 with r = 0.0176 is a flattened section: a narrow
  // crown that takes the sun, and shoulders that fall away fast enough to sit a
  // stop and a half darker. That is what makes a highlight read as a highlight —
  // it needs somewhere to stop. Same triangle count, and it is paired with the
  // chrome roughness and `ENV_TARGET.chrome` changes in Liveries; all three are
  // needed, none of them is sufficient.
  bumper(0.036, 0.022, 0.298, Role.Steel, C, -0.083, 3);
  // splitter under the bumper
  M.addLoft(
    [
      { z: -0.44, hw: 0.05, hh: 0.02, y: 0.185, r: 0.012 },
      { z: 0.44, hw: 0.05, hh: 0.02, y: 0.185, r: 0.012 },
    ],
    Role.Plastic,
    mat(0, 0, 0.98, 0, Math.PI / 2, 0),
    { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
  );

  // --- roll bar + rear wing ------------------------------------------------
  // Swept along a smoothed curve: the nine control points below are a polyline
  // with real corners in it, and a mitred chrome hoop is the §5 hard-edge tell
  // in tube form. 22 path samples keep the bends continuous all the way round,
  // which is what lets the highlight run along the hoop.
  //
  // 13 radial, not 10 — the closeup note's "coarsely tessellated torus". At
  // 36 mm radius the hoop is ~45 px across at the 1 m closeup framing, so 10
  // radial puts a 36-degree facet on it: a 14 px flat, which on a mirror is a
  // visible band of constant reflection with a hard edge either side. 13 takes
  // that to 27.7 degrees / 10 px and the facet stops being readable as one.
  // (Odd on purpose: with an even count the top and bottom facets are parallel
  // and the hoop shows one continuous flat along its whole crown, which is the
  // same defect the rub strip above has.)
  C.addTube(
    smoothPath([
      new THREE.Vector3(-0.40, 0.55, -0.42),
      new THREE.Vector3(-0.425, 0.86, -0.47),
      new THREE.Vector3(-0.375, 1.12, -0.45),
      new THREE.Vector3(-0.23, 1.265, -0.41),
      new THREE.Vector3(0, 1.31, -0.395),
      new THREE.Vector3(0.23, 1.265, -0.41),
      new THREE.Vector3(0.375, 1.12, -0.45),
      new THREE.Vector3(0.425, 0.86, -0.47),
      new THREE.Vector3(0.40, 0.55, -0.42),
    ], 22),
    0.036, 13, Role.Steel,
  );
  // Hoop cross brace and the wing stays. 8 radial, not 6: a hexagonal chrome
  // tube shows three facets across a 20 px silhouette and every one of them is
  // a hard edge, which is the §5 tell in miniature. 8 costs 24 triangles total
  // across the three tubes and closes the worst of it.
  C.addTube(
    [new THREE.Vector3(-0.40, 0.92, -0.465), new THREE.Vector3(0.40, 0.92, -0.465)],
    0.024, 8, Role.Steel,
  );
  for (const s of [-1, 1]) {
    // 6 radial: a 22 mm strut 190 mm long, behind the engine block, never more
    // than a dozen pixels wide. Part of the roll hoop's bill.
    C.addTube(
      [new THREE.Vector3(s * 0.30, 0.80, -0.90), new THREE.Vector3(s * 0.30, 0.99, -1.00)],
      0.022, 6, Role.Steel,
    );
  }
  P.addLoft(
    [
      { z: -0.44, hw: 0.115, hh: 0.020, y: 1.015, r: 0.014 },
      { z: 0, hw: 0.125, hh: 0.022, y: 1.03, r: 0.016 },
      { z: 0.44, hw: 0.115, hh: 0.020, y: 1.015, r: 0.014 },
    ],
    Role.Trim,
    mat(0, 0, -1.02, 0, Math.PI / 2, 0),
    { corner: 2, capStart: 0.025, capEnd: 0.025, capSeg: 1 },
  );

  // --- exhaust stacks ------------------------------------------------------
  for (const s of [-1, 1]) {
    C.addTube(
      smoothPath([
        new THREE.Vector3(s * 0.17, 0.58, -0.82),
        new THREE.Vector3(s * 0.21, 0.70, -0.99),
        new THREE.Vector3(s * 0.235, 0.845, -1.09),
      ], 6),
      (t) => 0.046 + t * t * 0.018,
      // Held at 9. It was raised to 11 alongside the roll hoop and put the kart
      // 70 triangles over §5's 12 k ceiling; measured against the shots, the
      // stacks are 15-25 px across in every framing that shows them and the
      // review did not flag them. The hoop is 45 px at the closeup and WAS
      // flagged. When there is no budget left, the note wins and the guess does
      // not.
      9, Role.Steel,
    );
  }

  // --- seat, dash, column --------------------------------------------------
  M.addLoft(
    [
      { z: -0.40, hw: 0.215, hh: 0.045, y: 0.375, r: 0.03 },
      { z: -0.10, hw: 0.225, hh: 0.05, y: 0.365, r: 0.032 },
      { z: 0.06, hw: 0.205, hh: 0.045, y: 0.365, r: 0.03 },
    ],
    Role.Plastic,
    undefined,
    { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
  );
  // backrest, raked back, with bolsters
  M.addLoft(
    [
      { z: 0.0, hw: 0.225, hh: 0.055, r: 0.04 },
      { z: 0.32, hw: 0.235, hh: 0.055, r: 0.04 },
      { z: 0.56, hw: 0.20, hh: 0.05, r: 0.04 },
    ],
    Role.Plastic,
    mat(0, 0.36, -0.40, -Math.PI / 2 + 0.30),
    { corner: 1, capStart: 0.045, capEnd: 0.05, capSeg: 1 },
  );
  for (const s of [-1, 1]) {
    M.addLoft(
      [
        { z: 0.06, hw: 0.045, hh: 0.075, r: 0.03 },
        { z: 0.42, hw: 0.05, hh: 0.08, r: 0.032 },
      ],
      Role.Plastic,
      mat(s * 0.225, 0.36, -0.40, -Math.PI / 2 + 0.30),
      { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
    );
  }
  // headrest pad in the livery trim
  P.addLoft(
    [
      { z: 0.0, hw: 0.135, hh: 0.055, r: 0.04 },
      { z: 0.14, hw: 0.125, hh: 0.05, r: 0.038 },
    ],
    Role.Trim,
    mat(0, 0.90, -0.545, -Math.PI / 2 + 0.30),
    { corner: 2, capStart: 0.035, capEnd: 0.035 },
  );
  // dash + column shroud + pedals
  M.addLoft(
    [
      { z: -0.24, hw: 0.06, hh: 0.085, y: 0.50, r: 0.035 },
      { z: 0.24, hw: 0.06, hh: 0.085, y: 0.50, r: 0.035 },
    ],
    Role.Plastic,
    mat(0, 0, 0.47, 0, Math.PI / 2, 0),
    { corner: 1, capStart: 0.04, capEnd: 0.04, capSeg: 1 },
  );
  C.addTube(
    [new THREE.Vector3(0, 0.53, 0.46), new THREE.Vector3(0, 0.84, 0.29)],
    0.028, 8, Role.Steel,
  );
  // Ignition ring on the dash. (4, 9) -> (3, 7): a 45 mm torus behind the
  // steering wheel, below the driver's forearms, at the one place on the kart
  // the chase camera never sees past the wheel boss. 30 triangles toward the
  // roll hoop.
  C.addGeometry(new THREE.TorusGeometry(0.045, 0.012, 3, 7), Role.Steel, mat(0.13, 0.565, 0.455, 0.35), 1.5);
  // (the pedal box that used to live here is fully enclosed by the nose and the
  // dash shroud — it never reached a pixel in any of the ten review shots, so
  // its 128 triangles now pay for the roll bar's continuous bends instead)

  // --- mirrors + fuel filler ----------------------------------------------
  for (const s of [-1, 1]) {
    C.addTube(
      [new THREE.Vector3(s * 0.42, 0.63, 0.30), new THREE.Vector3(s * 0.52, 0.76, 0.28)],
      0.014, 5, Role.Steel,
    );
    P.addLoft(
      [
        { z: 0.0, hw: 0.058, hh: 0.038, r: 0.022 },
        { z: 0.03, hw: 0.055, hh: 0.036, r: 0.02 },
      ],
      Role.Trim,
      mat(s * 0.545, 0.79, 0.275, 0, s * 0.35, 0),
      { corner: 2, capStart: 0.018, capEnd: 0.018, capSeg: 1 },
    );
  }
  C.addLoft(
    [
      { z: 0.0, hw: 0.052, hh: 0.052, y: 0.665, r: 0.05 },
      { z: 0.022, hw: 0.048, hh: 0.048, y: 0.665, r: 0.046 },
    ],
    Role.Steel,
    mat(-0.24, 0, -0.60, Math.PI / 2),
    { corner: 2, capStart: 0.014, capEnd: 0.014, capSeg: 1 },
  );

  // --- decal panels --------------------------------------------------------
  // pods: local +X must run toward the kart's nose on the left side so the
  // sponsor mark reads correctly from outside; the right-hand quadrant of the
  // atlas is drawn mirrored to compensate.
  // The extra rotation is applied on the RIGHT of the yaw so it happens in the
  // panel's own frame: it rakes the top edge inboard to follow the tumblehome.
  const [pw, ph] = PANEL_SIZE.pod;
  D.addPanel(pw, ph, 0.010, PANEL_UV.podL,
    mat(-0.784, 0.350, -0.01, 0, -Math.PI / 2, 0).multiply(mat(0, 0, 0, -0.10, 0, 0)), Role.Base, 5);
  D.addPanel(pw, ph, 0.010, PANEL_UV.podR,
    mat(0.784, 0.350, -0.01, 0, Math.PI / 2, 0).multiply(mat(0, 0, 0, -0.10, 0, 0)), Role.Base, 5);
  // nose deck: lies flat on the bonnet, raked with it, read by the chase camera
  const [nw, nh] = PANEL_SIZE.nose;
  D.addPanel(
    nw, nh, 0.012, PANEL_UV.nose,
    mat(0, 0.532, 0.76, 0.12, 0, 0).multiply(mat(0, 0, 0, 0, Math.PI, 0)).multiply(mat(0, 0, 0, -Math.PI / 2, 0, 0)),
    Role.Base, 6,
  );
  // tail number plate — the panel the player stares at all race
  const [tw, th] = PANEL_SIZE.tail;
  D.addPanel(tw, th, 0.010, PANEL_UV.tail, mat(0, 0.50, -0.972, 0, Math.PI, 0), Role.Base, 5);

  _chassis = {
    paint: P.finish(), decal: D.finish(), chrome: C.finish(), plastic: M.finish(), fender: F.finish(),
  };
  return _chassis;
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

let _wheel: Built | null = null;

/**
 * Radial segments on the tyre. MUST stay an integer multiple of TREAD_BLOCKS.
 *
 * Round 3 shipped 26 against a 10-lobe shoulder scallop, and the comment beside
 * it claimed the two divided. They do not: gcd(26, 10) = 2, so the sine was
 * sampled at a different phase on every segment and the pattern only closed
 * every half revolution. What that produces is not a 26-gon — it is thirteen
 * unequal facets of alternating depth, which is exactly the "about twelve
 * segments on the front tyre" the hero-shot review counted. The beat, not the
 * segment count, was doing the damage.
 *
 * 30 is three samples per block, so every lobe is identical and closes on
 * itself: ten equal scallops instead of thirteen unequal facets. It also takes
 * the polygonal sagitta at the tread radius from 2.74 mm to 2.06 mm, about one
 * pixel at the closeup framing. Both changes are paid for by the rim and
 * inboard-flank reductions below — geometry the camera cannot reach — so the
 * kart's triangle total is unchanged and §5's 6-12 k still holds.
 *
 * If this is ever raised, raise it to 40 or 50, never to 32 or 36.
 */
const TREAD_BLOCKS = 10;
const TYRE_RAD = 30;

function buildWheel(): Built {
  if (_wheel) return _wheel;
  const W = new Mesher();
  const RAD = TYRE_RAD; // this is the closest object to the camera all race
  const RF = WHEEL_UV.rimFace; // metal zone of the atlas
  const DC = WHEEL_UV.disc;

  // Tyre: a real sidewall profile — bead, bulge, shoulder, crowned tread. The
  // v coordinate walks into the sidewall band of the atlas and back out, so
  // the moulded lettering lands on both flanks automatically.
  //
  // ASYMMETRIC on purpose. +x is outboard (see the rim revolve's V ramp and the
  // hub's `rotation.y` flip), and the outboard flank is the one the camera is
  // ever alongside; the inboard flank looks into the floor pan. So the outboard
  // side keeps its full bead/bulge/shoulder break and the inboard side collapses
  // to a single taper. That is 2 x RAD triangles a wheel bought back from a
  // surface that is in shadow behind the tyre it belongs to, and it is most of
  // what pays for the radial density above.
  const hw = WHEEL_HW;
  const profile = [
    // The inboard flank really is one taper now. The comment above has claimed
    // that since round 3 while the profile still carried a bead, a bulge AND a
    // shoulder on a face that looks into the floor pan and is in the kart's own
    // shadow at every camera the game has. Dropping the inboard bulge ring is
    // 60 triangles a wheel, 240 a kart, and it is what pays for the rim
    // revolve below going from 12 radial to 20 — the note's "visible flat
    // faceting around the circle", on a surface that IS on the silhouette.
    -hw * 0.86, 0.210, 0.310,
    -hw * 0.80, 0.366, 0.620,
    0.000, 0.374, 0.800,
    hw * 0.78, 0.366, 0.980,
    hw * 0.92, 0.350, 0.575,
    hw * 0.99, 0.292, 0.470,
    hw * 0.80, 0.200, 0.300,
  ];
  // Scallop the shoulders: rings 1 and 3 are the tread edges, ring 2 the crown.
  // (These indices moved when the inboard bulge ring came out above. They are
  // the reason that edit is not a one-line deletion: a scallop applied to the
  // wrong ring puts a 4 mm ten-lobe ripple on the tyre's BEAD, which reads as a
  // buckled wheel and would be a new note rather than a fixed one.)
  W.addRevolve(profile, RAD, Role.Rubber, undefined, 1, 0, (i, a) =>
    i === 1 || i === 3 ? Math.sin(a * TREAD_BLOCKS) * 0.004
      : i === 2 ? Math.sin(a * TREAD_BLOCKS) * 0.0018 : 0,
  );

  // Rim: a closed back plate (so you never see through the spokes into the
  // world), barrel, and a lip that curls back under itself. The V values walk
  // DOWN the atlas's baked AO ramp as the surface goes deeper into the wheel:
  // 0.06 on the outboard lip, 0.16-0.19 on the barrel wall, 0.24 on the back
  // plate you see between the spokes. That is the occlusion term the spoke
  // recesses were missing.
  //
  // 20 RADIAL, NOT 12, and the round-3 justification below is simply wrong. The
  // BARREL never reaches a silhouette. The LIP does: it sits at r = 0.203
  // against a 0.200 bead, it is the outermost ring of metal on the wheel, and
  // it is what you look straight down at when the camera is alongside — which
  // is the closeup framing. A 12-gon there is a 30-degree chord, and that is
  // exactly the review's "low-poly star with visible flat faceting around the
  // circle": the star is the five spokes, which is the design; the faceting is
  // this ring. 20 takes the chord to 18 degrees, under two pixels of sagitta at
  // 1 m. Paid for by the tyre's inboard flank above, one for one.
  //
  // (Superseded, kept because it explains what the V ramp is for:) 12 radial,
  // not 40 — the whole revolve lives inside
  // the tyre bead, so it never reaches a silhouette; all it ever has to do is
  // be a continuous surface behind five spoke gaps. (Round 2 spent its budget
  // on the driver's hands, which are on the hero silhouette. This is where it
  // came from, and the difference is not visible at any camera the game has.)
  W.addRevolve(
    [
      -hw * 0.78, 0.000, 0.245,
      -hw * 0.78, 0.196, 0.190,
      hw * 0.60, 0.197, 0.165,
      hw * 0.78, 0.203, 0.150,
      hw * 0.68, 0.174, 0.060,
    ],
    20, Role.Rim, undefined, RF[2], RF[0],
  );
  // Spokes: five chunky blades from the hub out to the lip. corner 2 rounds the
  // blade's long edges and a 2-segment cap chamfers the outboard END, which was
  // flat and unchamfered in round 1 and therefore caught no specular line at
  // all. The inboard end is left open (closeStart false) because it is buried
  // under the hub dome — that pays for the chamfer at the end you can see.
  const spokeMark = W.mark();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 10;
    W.addLoft(
      [
        { z: 0.05, hw: 0.026, hh: 0.055, r: 0.014 },
        { z: 0.172, hw: 0.024, hh: 0.034, r: 0.013 },
      ],
      Role.Rim,
      // spin the blade about the axle so the loft runs radially, not axially
      mat(hw * 0.60, 0, 0, a, 0, 0),
      { corner: 1, closeStart: false, capEnd: 0.017, capSeg: 2 },
    );
  }
  // Lofts carry metre-space UVs, so pin the spokes into the rim's metal zone —
  // and into a NARROW V slice near the top of it, so the blades stay in the
  // bright, un-occluded end of the AO ramp while the barrel behind them sinks.
  W.remapUV(spokeMark, [RF[0] + 0.04, RF[1] + 0.035, RF[2] * 0.7, 0.035]);

  // Hub nut: a shallow chamfered dome pinned to the atlas's polished band
  // (metalness 1, roughness 0.10). One small mirror in the middle of a wheel
  // is what makes the whole rim read as metal; without it the anodised barrel
  // has no hard glint anywhere to anchor it.
  W.addRevolve(
    [
      hw * 0.585, 0.000, 0.266,
      hw * 0.575, 0.024, 0.270,
      hw * 0.540, 0.046, 0.274,
      hw * 0.455, 0.062, 0.279,
      hw * 0.320, 0.072, 0.284,
    ],
    8, Role.Hub, undefined, WHEEL_UV.nut[2] * 0.25, 0.1,
  );

  // Brake disc, drilled, sitting behind the spokes where you can actually see
  // it through them.
  W.addRevolve(
    [
      -0.012, 0.082, 0.02,
      -0.012, 0.152, 0.24,
      0.012, 0.152, 0.24,
      0.012, 0.082, 0.02,
    ],
    6, Role.Disc, mat(-hw * 0.22, 0, 0), DC[2], DC[0],
  );

  _wheel = W.finish();
  return _wheel;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const _perLivery = new Map<number, {
  paint: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  plastic: THREE.BufferGeometry;
  fender: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  tris: number;
}>();

function liveryGeos(l: Livery) {
  let hit = _perLivery.get(l.index);
  if (hit) return hit;
  const ch = buildChassis();
  const wh = buildWheel();
  hit = {
    paint: liveryGeometry(ch.paint, l),
    chrome: liveryGeometry(ch.chrome, l),
    plastic: liveryGeometry(ch.plastic, l),
    fender: liveryGeometry(ch.fender, l),
    wheel: liveryGeometry(wh, l),
    tris: ch.paint.triangles + ch.decal.triangles + ch.chrome.triangles + ch.plastic.triangles
      + ch.fender.triangles + wh.triangles * 4 + driverTriangles(),
  };
  _perLivery.set(l.index, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// Far LOD / shadow proxy
// ---------------------------------------------------------------------------

/** Parts the merged mesh must not swallow. */
const IMPOSTOR_SKIP = new Set(['shadowBlob']);

const _im = new THREE.Matrix3();
const _iv = new THREE.Vector3();
const _ic = new THREE.Color();
/** World matrix of the part (or instance) currently being baked. */
const _iw = new THREE.Matrix4();
/** Scratch for the per-frame tyre instance matrices. */
const _tw = new THREE.Matrix4();

/**
 * Downsampled, linear-space copy of a base-colour map, for baking into the
 * merged mesh's colour attribute.
 *
 * The wheel is the reason this exists. `C_RUBBER` is deliberately pure white —
 * "albedo comes from the wheel atlas" — so a merge that only reads the colour
 * attribute produces a kart on four cream doughnuts. The impostor carries no
 * maps (see `impostorMaterial`), so whatever the map was contributing has to
 * end up in the vertices instead.
 *
 * 64 px, not 1024: the browser's own downscale box-filters the whole atlas for
 * free, which is exactly what is wanted. Sampling the full-resolution tread at
 * a vertex is a coin toss between a groove and a block, and the merged mesh
 * would inherit that noise as per-vertex mottling. What it should inherit is
 * the average, because the average is all that survives at 20 m.
 */
const SAMPLE_RES = 64;
const _mapCache = new WeakMap<THREE.Texture, Float32Array | null>();

function mapSamples(t: THREE.Texture): Float32Array | null {
  const hit = _mapCache.get(t);
  if (hit !== undefined) return hit;
  let out: Float32Array | null = null;
  try {
    const src = t.image as CanvasImageSource & { width?: number; height?: number };
    if (src && (src.width || 0) > 0) {
      const c = document.createElement('canvas');
      c.width = c.height = SAMPLE_RES;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(src, 0, 0, SAMPLE_RES, SAMPLE_RES);
      const d = g.getImageData(0, 0, SAMPLE_RES, SAMPLE_RES).data;
      const srgb = t.colorSpace === THREE.SRGBColorSpace;
      out = new Float32Array(SAMPLE_RES * SAMPLE_RES * 3);
      for (let i = 0, n = SAMPLE_RES * SAMPLE_RES; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const v = d[i * 4 + k] / 255;
          // Vertex colours are consumed in linear working space, so an sRGB
          // map has to be decoded here or the tyres come out two stops light.
          out[i * 3 + k] = srgb
            ? (v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
            : v;
        }
      }
    }
  } catch {
    // A cross-origin or not-yet-decoded image is not worth failing a build for;
    // the part just keeps its authored vertex colour.
    out = null;
  }
  _mapCache.set(t, out);
  return out;
}

/** Multiplies `out` by the map's colour at (u, v), honouring flipY/repeat. */
function sampleMap(s: Float32Array, t: THREE.Texture, u: number, v: number, out: THREE.Color) {
  let x = u * t.repeat.x + t.offset.x;
  let y = v * t.repeat.y + t.offset.y;
  // The upload flips the image when flipY is on, so an unflipped read has to
  // undo it. The wheel atlas is authored flipY off; the surface details are not.
  if (t.flipY) y = 1 - y;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const ix = Math.min(SAMPLE_RES - 1, (x * SAMPLE_RES) | 0);
  const iy = Math.min(SAMPLE_RES - 1, (y * SAMPLE_RES) | 0);
  const i = (iy * SAMPLE_RES + ix) * 3;
  out.r *= s[i];
  out.g *= s[i + 1];
  out.b *= s[i + 2];
}

/**
 * Bakes every mesh hanging off a freshly built kart into one buffer, in the
 * root's frame and at rest pose.
 *
 * Rest pose is the whole approximation: the wheels are unsteered and unspun,
 * the body is unrolled and the driver is sitting up straight. That is exactly
 * as wrong as it sounds and exactly as invisible as it needs to be — this mesh
 * is only ever seen from 26 m (where a 4 degree body roll is a pixel) or as a
 * shadow caster under a sun 63 degrees up (where the kart's own shadow is a
 * short blob mostly hidden by the kart standing on it).
 *
 * The source geometries are shared per livery, so nothing here is mutated; the
 * merge reads them and writes a new buffer.
 */
function mergeToImpostor(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let base = 0;

  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m as unknown as { isMesh?: boolean }).isMesh) return;
    if (IMPOSTOR_SKIP.has(m.name)) return;
    const g = m.geometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!p) return;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const u = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const c = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    // The part's own base colour and base-colour map, folded into the vertices.
    // Both matter: the visor's whole albedo is `material.color` (it has no
    // colour attribute at all), and the tyre's is `material.map` (`C_RUBBER` is
    // pure white on purpose, because the atlas is supposed to supply it).
    const src = m.material as THREE.MeshStandardMaterial;
    const baseCol = src?.color;
    const baseMap = src?.map ?? null;
    const samples = baseMap ? mapSamples(baseMap) : null;

    // An InstancedMesh contributes once PER INSTANCE, each at its own matrix.
    // The four tyres are one instanced draw (see the wheel loop in `buildKart`),
    // and baking only the base geometry would put a single wheel at the kart's
    // origin — a far kart on one centre wheel, and a shadow to match, because
    // this bake is also the kart's only shadow caster.
    const inst = m as unknown as { isInstancedMesh?: boolean; count?: number;
      instanceMatrix?: THREE.InstancedBufferAttribute };
    const reps = inst.isInstancedMesh === true ? inst.count ?? 0 : 1;

    for (let r = 0; r < reps; r++) {
      if (inst.isInstancedMesh === true && inst.instanceMatrix) {
        _iw.fromArray(inst.instanceMatrix.array as ArrayLike<number>, r * 16);
        _iw.premultiply(m.matrixWorld);
      } else {
        _iw.copy(m.matrixWorld);
      }
      _im.getNormalMatrix(_iw);
      for (let i = 0; i < p.count; i++) {
        _iv.fromBufferAttribute(p, i).applyMatrix4(_iw);
        pos.push(_iv.x, _iv.y, _iv.z);
        if (n) {
          _iv.fromBufferAttribute(n, i).applyMatrix3(_im).normalize();
          nrm.push(_iv.x, _iv.y, _iv.z);
        } else nrm.push(0, 1, 0);
        const tu = u ? u.getX(i) : 0;
        const tv = u ? u.getY(i) : 0;
        uv.push(tu, tv);

        if (c) _ic.setRGB(c.getX(i), c.getY(i), c.getZ(i));
        else _ic.setRGB(1, 1, 1);
        if (baseCol) _ic.multiply(baseCol);
        if (samples && baseMap) sampleMap(samples, baseMap, tu, tv, _ic);
        col.push(_ic.r, _ic.g, _ic.b);
      }
      const index = g.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      else for (let i = 0; i < p.count; i++) idx.push(base + i);
      base += p.count;
    }
  });

  if (!base) return null;
  return clusterDecimate(pos, nrm, uv, col, idx);
}

/**
 * Cell edge for the impostor's vertex clustering, metres.
 *
 * THE BAKE WAS NOT A REDUCTION. Measured with tools/perf.mjs and
 * `__kartShadow.report()`, the merged mesh came out at 11 962 triangles against
 * 11 900 for the fifteen detail meshes it replaces — it collapsed fifteen draw
 * calls into one and left every triangle exactly where it was. So a kart at
 * 60 m, drawn as a single "far LOD", was rasterising a full-detail wheel tread
 * and a full-detail driver's hand, and so was the shadow pass, twice, for all
 * eight karts.
 *
 * Two things bound how coarse the cells may be, and 3 cm clears both:
 *
 *   - The near cascade is 4096 px across ~110 m, i.e. 2.69 cm per texel, so a
 *     3 cm cell moves a shadow silhouette by about one texel — inside the PCF
 *     kernel that is already blurring it.
 *   - `DrawBudget.LOD_SWAP` hands the camera this mesh at 20 m. A 62-degree
 *     lens sees 24.0 m of height there, so a 1.1 m kart is ~50 px at 1080p and
 *     one centimetre is 0.45 px: a 3 cm cell is 1.4 px of silhouette.
 *
 * Clustering merges by MEAN position rather than to the cell centre, which
 * matters for exactly that second bound — snapping to centres would put the
 * error at a full cell instead of half of one, and it quantises a smooth
 * revolve into visible steps.
 *
 * DO NOT RAISE THIS TO BUY TRIANGLES. The curve was swept in-page
 * (tools/tex-probe.mjs --label sweep), re-clustering the built impostor at six
 * cell sizes, and it is shallow because the kart is not over-tessellated for
 * these two uses in the first place — its mean triangle edge is already about
 * three centimetres:
 *
 *     cell    tris    vs the un-clustered 11 962
 *     3 cm    9 209        77%      <- here
 *     4 cm    7 811        65%
 *     5 cm    6 821        57%
 *     6 cm    6 326        53%
 *     8 cm    4 821        40%
 *    10 cm    3 637        30%
 *
 * Every rung past 3 cm is bought from the silhouette, and the silhouette is the
 * entire justification `DrawBudget` gives for swapping to this mesh at all. The
 * whole kart field is ~200k of a 3.2M-triangle frame, so the most an aggressive
 * setting could win is around 2% of the frame's triangles in exchange for
 * chunking the one thing the far LOD exists to preserve. Not a good trade.
 */
const IMPOSTOR_CELL = 0.030;

/**
 * Grid vertex clustering — the merge's actual reduction step.
 *
 * Vertices sharing a cell collapse to one, and any triangle left with two
 * corners in the same cluster is dropped. That is the whole algorithm; it is
 * chosen over anything smarter because it is O(n), allocation-light, runs once
 * at build time, and cannot fail in a way that produces a hole — collapsing a
 * cluster too eagerly loses a triangle, never opens one.
 *
 * The cluster key carries a coarse COLOUR bucket as well as the cell. The
 * impostor has no maps, so its whole albedo lives in the colour attribute, and
 * a purely spatial cell three centimetres across happily spans the tyre and the
 * rim, or the driver's glove and their sleeve. Averaging those gives a merged
 * mesh that is right in shape and muddy in colour — the one thing the far LOD
 * is supposed to preserve verbatim, because the livery is how a player tells
 * the field apart. Four levels per channel on a square-root ramp (these are
 * linear-space values, and a linear ramp puts almost every painted surface in
 * the bottom bucket) keeps those pairs apart and costs very little reduction.
 */
function clusterDecimate(
  pos: number[], nrm: number[], uv: number[], col: number[], idx: number[],
): THREE.BufferGeometry {
  const n = pos.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const inv = 1 / IMPOSTOR_CELL;
  // +1 so a vertex exactly on the max face gets its own cell rather than
  // indexing one past the end of the grid.
  const nx = Math.max(1, Math.floor((maxX - minX) * inv) + 1);
  const ny = Math.max(1, Math.floor((maxY - minY) * inv) + 1);

  /** 0..3 per channel on a sqrt ramp; see the colour note above. */
  const bucket = (c: number) => {
    const q = Math.sqrt(c < 0 ? 0 : c > 1 ? 1 : c) * 3.999;
    return q < 0 ? 0 : q > 3 ? 3 : q | 0;
  };

  // Cluster id per source vertex, and per-cluster running sums.
  const map = new Int32Array(n).fill(-1);
  const keys = new Map<number, number>();
  const cPos: number[] = [], cNrm: number[] = [], cUv: number[] = [], cCol: number[] = [];
  const cCount: number[] = [];
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((pos[i * 3] - minX) * inv);
    const cy = Math.floor((pos[i * 3 + 1] - minY) * inv);
    const cz = Math.floor((pos[i * 3 + 2] - minZ) * inv);
    const cell = (cz * ny + cy) * nx + cx;
    const tint = (bucket(col[i * 3]) << 4) | (bucket(col[i * 3 + 1]) << 2) | bucket(col[i * 3 + 2]);
    const key = cell * 64 + tint;
    let c = keys.get(key);
    if (c === undefined) {
      c = cCount.length;
      keys.set(key, c);
      cPos.push(0, 0, 0); cNrm.push(0, 0, 0); cUv.push(0, 0); cCol.push(0, 0, 0);
      cCount.push(0);
    }
    map[i] = c;
    cCount[c]++;
    cPos[c * 3] += pos[i * 3]; cPos[c * 3 + 1] += pos[i * 3 + 1]; cPos[c * 3 + 2] += pos[i * 3 + 2];
    cNrm[c * 3] += nrm[i * 3]; cNrm[c * 3 + 1] += nrm[i * 3 + 1]; cNrm[c * 3 + 2] += nrm[i * 3 + 2];
    cUv[c * 2] += uv[i * 2]; cUv[c * 2 + 1] += uv[i * 2 + 1];
    cCol[c * 3] += col[i * 3]; cCol[c * 3 + 1] += col[i * 3 + 1]; cCol[c * 3 + 2] += col[i * 3 + 2];
  }

  const m = cCount.length;
  const oPos = new Float32Array(m * 3);
  const oNrm = new Float32Array(m * 3);
  const oUv = new Float32Array(m * 2);
  const oCol = new Float32Array(m * 3);
  for (let c = 0; c < m; c++) {
    const k = 1 / cCount[c];
    oPos[c * 3] = cPos[c * 3] * k;
    oPos[c * 3 + 1] = cPos[c * 3 + 1] * k;
    oPos[c * 3 + 2] = cPos[c * 3 + 2] * k;
    // A cluster that straddles both faces of a thin panel — a wing, the visor —
    // sums to nothing. Renormalising that gives NaN, and a single NaN normal is
    // enough for the whole draw to come out black on some drivers, so fall back
    // to straight up rather than trusting the average.
    let nxv = cNrm[c * 3], nyv = cNrm[c * 3 + 1], nzv = cNrm[c * 3 + 2];
    const len = Math.hypot(nxv, nyv, nzv);
    if (len > 1e-4) { nxv /= len; nyv /= len; nzv /= len; } else { nxv = 0; nyv = 1; nzv = 0; }
    oNrm[c * 3] = nxv; oNrm[c * 3 + 1] = nyv; oNrm[c * 3 + 2] = nzv;
    oUv[c * 2] = cUv[c * 2] * k; oUv[c * 2 + 1] = cUv[c * 2 + 1] * k;
    oCol[c * 3] = cCol[c * 3] * k;
    oCol[c * 3 + 1] = cCol[c * 3 + 1] * k;
    oCol[c * 3 + 2] = cCol[c * 3 + 2] * k;
  }

  const oIdx: number[] = [];
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = map[idx[i]], b = map[idx[i + 1]], d = map[idx[i + 2]];
    if (a === b || b === d || a === d) continue;
    oIdx.push(a, b, d);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(oNrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(oUv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(oCol, 3));
  out.setIndex(m > 65535 ? new THREE.Uint32BufferAttribute(oIdx, 1) : new THREE.Uint16BufferAttribute(oIdx, 1));
  out.computeBoundingSphere();
  // What the reduction actually was, so `__kartShadow.report()` can state it
  // rather than a harness having to rebuild the un-clustered mesh to find out.
  out.userData.mergedVerts = n;
  out.userData.mergedTris = idx.length / 3;
  return out;
}

// ---------------------------------------------------------------------------
// Shadow debugging
// ---------------------------------------------------------------------------

/**
 * Every kart built this session, so the capture harness can interrogate the
 * shadow path without reaching through Race into Kart into `visual`.
 *
 * Why this exists: a kart's ENTIRE contribution to both cascades is one mesh
 * (`kartImpostor`) — `buildKart` force-clears `castShadow` on all fifteen
 * detail meshes the moment the bake succeeds, and `DrawBudget` then owns that
 * mesh's `visible` and `castShadow` flags from `lateUpdate`. So there are four
 * independent ways for a kart to end up casting nothing at all, and from a
 * screenshot they are indistinguishable from each other and from "the cascade
 * never saw it". `__kartShadow.report()` separates them in one call, and
 * `detailShadows(true)` is the A/B: if the kart's shadow appears with the
 * detail meshes casting, the bake or its flags are at fault; if it still does
 * not, the caster was never the problem and the cascade is.
 */
const _built: THREE.Group[] = [];

export interface KartShadowDebug {
  /** Per kart: is it in the scene, is its impostor visible, is it casting. */
  report(): Array<Record<string, unknown>>;
  /** Hide the contact shadows, to judge the cascade's own shadow alone. */
  contact(on: boolean): void;
  /**
   * Put every detail mesh back in the shadow map. Costs ~15 extra shadow draws
   * per kart, so it is a diagnostic and never a shipping state.
   */
  detailShadows(on: boolean): void;
}

function kartShadowDebug(): KartShadowDebug {
  const live = () => _built.filter((r) => r.parent !== null);
  return {
    report: () => live().map((r) => {
      const imp = r.userData.impostor as THREE.Mesh | null;
      const blob = r.userData.shadowBlob as THREE.Mesh | undefined;
      const geo = imp?.geometry;
      if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
      let casters = 0;
      r.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.castShadow) casters++; });
      return {
        kart: r.name,
        worldY: r.getWorldPosition(_iv).y.toFixed(3),
        impostor: imp ? 'built' : 'MISSING',
        impostorVisible: imp?.visible ?? false,
        impostorCastShadow: imp?.castShadow ?? false,
        impostorRadius: geo?.boundingSphere?.radius.toFixed(3) ?? '-',
        impostorTris: geo?.getIndex() ? geo.getIndex()!.count / 3 : 0,
        // Before clustering, so the far LOD's reduction is readable in one call.
        // See IMPOSTOR_CELL: the bake used to be a draw-call reduction only.
        mergedTris: geo?.userData?.mergedTris ?? 0,
        impostorVerts: geo?.getAttribute('position')?.count ?? 0,
        mergedVerts: geo?.userData?.mergedVerts ?? 0,
        meshesCastingShadow: casters,
        contactShadowVisible: blob?.visible ?? false,
      };
    }),
    contact: (on: boolean) => {
      for (const r of live()) {
        const b = r.userData.shadowBlob as THREE.Mesh | undefined;
        if (b) b.visible = on;
      }
    },
    detailShadows: (on: boolean) => {
      for (const r of live()) {
        const imp = r.userData.impostor as THREE.Mesh | null;
        r.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m !== imp && m.name !== 'shadowBlob') m.castShadow = on;
        });
      }
    },
  };
}

/** Anchor whose +Z points along `dir` — VFX emits along an anchor's forward. */
function anchor(name: string, x: number, y: number, z: number, dir?: THREE.Vector3): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  if (dir) o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  return o;
}

/**
 * @param hero  build the player's kart. Identical geometry; the bodywork gets
 *              the hot sun-side rim (see `heroPaint`) so the subject holds its
 *              silhouette against the tarmac at chase-camera size. Optional and
 *              defaulting to false, so existing callers are unaffected — Kart.ts
 *              should pass `isPlayer` here when it next changes.
 */
export function buildKart(
  stats: KartStats, hero = false,
): { root: THREE.Group; wheels: THREE.Object3D[] } {
  const livery = getLivery(stats);
  const mats = kartMaterials();
  const paint = hero ? heroPaint() : mats.paint;
  const geos = liveryGeos(livery);
  const chassis = buildChassis();

  const root = new THREE.Group();
  root.name = `kart_${livery.name}`;

  // Everything that rolls and pitches with the springs hangs off `body`; the
  // wheels stay on the root so physics can drive them per-corner.
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const add = (geo: THREE.BufferGeometry, material: THREE.Material, name: string) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    body.add(m);
    return m;
  };
  // The kart's whole material set is authored against an absolute environment
  // response and then divided by whatever `scene.environmentIntensity` happens
  // to be (see ENV_TARGET in Liveries). Reading it here rather than hard-coding
  // the reciprocal means the karts stay correct if the sky is ever retuned —
  // and in round 1 the sky's 0.40 global is precisely what turned eight
  // clearcoated karts into eight matte clay toys. One float compare per frame.
  add(geos.paint, paint, 'bodyPaint').onBeforeRender = (_r, scene) => {
    syncKartEnv(scene.environmentIntensity);
  };
  add(chassis.decal.geo, livery.decalMat, 'bodyLivery');
  add(geos.chrome, mats.chrome, 'bodyChrome');
  add(geos.plastic, mats.plastic, 'bodyPlastic');
  const fenders = add(geos.fender, paint, 'bodyFenders');

  // --- driver -------------------------------------------------------------
  const driver: DriverRig = buildDriver(livery);
  driver.root.position.set(0, 0.42, -0.14);
  body.add(driver.root);

  // --- wheels: FL, FR, RL, RR (index 0/2 are the -X side) -----------------
  const wheels: THREE.Object3D[] = [];
  const wheelContacts: THREE.Object3D[] = [];
  /** Hub node per corner, holding the outboard flip. Posed into `tyres` below. */
  const hubs: THREE.Object3D[] = [];
  const layout: [number, number, string][] = [
    [-TRACK_X, FRONT_Z, 'FL'],
    [TRACK_X, FRONT_Z, 'FR'],
    [-TRACK_X, REAR_Z, 'RL'],
    [TRACK_X, REAR_Z, 'RR'],
  ];
  for (const [x, z, label] of layout) {
    const pivot = new THREE.Group();
    pivot.name = `wheel${label}`;
    // steer (Y) must be applied before spin (X) or the axle tilts
    pivot.rotation.order = 'YXZ';
    pivot.position.set(x, WHEEL_R, z);
    pivot.userData.side = Math.sign(x);
    pivot.userData.front = z > 0;
    pivot.userData.radius = WHEEL_R;
    pivot.userData.restY = WHEEL_R;

    const hub = new THREE.Group();
    hub.rotation.y = x > 0 ? 0 : Math.PI; // rim face always points outboard
    pivot.add(hub);
    root.add(pivot);
    wheels.push(pivot);
    hubs.push(hub);

    const contact = anchor(`contact${label}`, x, 0.01, z);
    root.add(contact);
    wheelContacts.push(contact);
  }

  // --- the four tyres, as one instanced draw -------------------------------
  // Same geometry, same material, four different matrices: the textbook case
  // for instancing, and it was costing four draw calls per near kart — 20 of
  // them in a mid-pack frame, out of a 250 budget.
  //
  // The corner nodes stay exactly as they were. `wheelFL`..`wheelRR` are what
  // the suspension steers, spins and lifts, and what the VFX hang off; all this
  // does is stop each of them carrying its own mesh and read their poses into
  // one instance buffer instead. Instance i is corner i, so `wheels[i]` and
  // instance i never disagree about which tyre is which.
  const tyres = new THREE.InstancedMesh(geos.wheel, mats.wheel, 4);
  tyres.name = 'tyres';
  tyres.castShadow = true;
  tyres.receiveShadow = true;
  tyres.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const poseTyres = () => {
    for (let i = 0; i < 4; i++) {
      const pivot = wheels[i];
      const hub = hubs[i];
      // Both are driven by physics every frame; three has already refreshed
      // them by render time, but updating here costs two compositions and
      // removes any dependence on that ordering.
      pivot.updateMatrix();
      hub.updateMatrix();
      _tw.multiplyMatrices(pivot.matrix, hub.matrix);
      tyres.setMatrixAt(i, _tw);
    }
    tyres.instanceMatrix.needsUpdate = true;
  };
  poseTyres();
  // Culled as one object. The bounds are computed from the rest pose and then
  // padded by the suspension's travel, because three caches an InstancedMesh's
  // bounding sphere and will not see the wheels move afterwards.
  tyres.computeBoundingSphere();
  if (tyres.boundingSphere) tyres.boundingSphere.radius += 0.35;
  // onBeforeRender is the same hook the fenders and the contact shadow use, and
  // for the same reason: it is the only one that runs after physics has posed
  // the corners for the frame being drawn.
  tyres.onBeforeRender = poseTyres;
  root.add(tyres);

  // --- rear fenders ride with the rear axle --------------------------------
  // A guard bolted to the bodywork, over a wheel with up to 0.18 m of visual
  // suspension travel relative to that bodywork, either intersects the tyre or
  // floats above it. The way out of the trade is to stop pretending it is
  // rigid. It follows the MORE compressed of the two rear corners rather than
  // their mean: the max guarantees neither tyre can reach the arc, and the
  // price is that the unloaded side shows a slightly wider gap mid-drift, which
  // is nothing next to a tread block coming through the paint.
  //
  // onBeforeRender is the only hook that runs after physics has posed the
  // wheels. three calls it BEFORE it derives modelViewMatrix from matrixWorld,
  // so refreshing the matrix by hand here lands in the frame being drawn rather
  // than one frame late. (The shadow pass has no such hook and runs first, so
  // the fender's shadow trails its geometry by a frame — 100 mm at the very
  // worst, on a soft penumbra, for one frame of a landing.) One max, one clamp,
  // no allocation, and it early-outs whenever the lift has not changed.
  const wRL = wheels[2];
  const wRR = wheels[3];
  fenders.onBeforeRender = () => {
    const lift = Math.min(
      FEND_MAX_LIFT,
      Math.max(0, wRL.position.y - WHEEL_R, wRR.position.y - WHEEL_R),
    );
    if (lift !== fenders.position.y) {
      fenders.position.y = lift;
      fenders.updateMatrix();
      fenders.matrixWorld.multiplyMatrices(body.matrixWorld, fenders.matrix);
    }
  };

  // --- effect anchors ------------------------------------------------------
  const exDir = new THREE.Vector3(0, 0.55, -0.84);
  const exhausts = [
    anchor('exhaustL', -0.235, 0.855, -1.12, exDir),
    anchor('exhaustR', 0.235, 0.855, -1.12, exDir),
  ];
  for (const e of exhausts) body.add(e);
  // Sparks come off the rear contact patches, just inboard of the tyre wall,
  // and live on the root so they stay pinned to the ground while the body
  // rolls. Separate objects from the contacts so physics and VFX can move
  // theirs independently.
  const sparks = [
    anchor('sparkL', -(TRACK_X - WHEEL_HW * 0.5), 0.05, REAR_Z),
    anchor('sparkR', TRACK_X - WHEEL_HW * 0.5, 0.05, REAR_Z),
  ];
  for (const s of sparks) root.add(s);

  // --- contact shadow ------------------------------------------------------
  // Shaped from the axle layout, so its four dark lobes land on the four
  // contact patches rather than smearing one oval over the whole footprint —
  // that is the contact AO §9.4 calls mandatory, and it is what stops the kart
  // reading as a sprite composited onto the road.
  //
  // The lobes are driven from the wheels every frame, which is what makes the
  // shadow move with the suspension rather than sit under the kart like a mat:
  // the loaded corner of a kart in a drift gets a small hard patch and the
  // unloaded one goes wide and faint. `onBeforeRender` is used for the same
  // reason the fenders use it — it is the only hook that runs after physics has
  // posed the wheels for the frame being drawn.
  const contact = contactShadow({ trackX: TRACK_X, frontZ: FRONT_Z, rearZ: REAR_Z });
  const shadowBlob = contact.mesh;
  shadowBlob.name = 'shadowBlob';
  root.add(shadowBlob);
  shadowBlob.onBeforeRender = () => {
    for (let i = 0; i < 4; i++) contact.setWheel(i, wheels[i].position.y - WHEEL_R);
  };

  // --- far LOD / shadow proxy ----------------------------------------------
  // Built last, after every part is in place and posed, because it is just a
  // bake of the assembled model. See `mergeToImpostor`. The detail meshes stop
  // casting shadows at the same time: from here on this one mesh is the kart's
  // entire contribution to both cascades, near or far, and DrawBudget decides
  // per frame whether it is also what the camera sees.
  const impostorGeo = mergeToImpostor(root);
  let impostor: THREE.Mesh | null = null;
  if (impostorGeo) {
    impostor = new THREE.Mesh(impostorGeo, shadowOnlyMaterial());
    impostor.name = 'kartImpostor';
    impostor.castShadow = true;
    impostor.receiveShadow = true;
    // after the opaque queue, so the shadow-only pose is killed at early-Z
    impostor.renderOrder = 4;
    root.add(impostor);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as unknown as { isMesh?: boolean }).isMesh && m !== impostor) m.castShadow = false;
    });
  }

  root.userData.impostor = impostor;
  root.userData.impostorMat = impostorMaterial();
  root.userData.shadowOnlyMat = shadowOnlyMaterial();
  /** everything DrawBudget hides when the kart collapses to its impostor */
  root.userData.detailNodes = [body, ...wheels, tyres];
  root.userData.body = body;
  root.userData.driver = driver;
  root.userData.exhausts = exhausts;
  root.userData.exhaustTips = exhausts;
  root.userData.sparks = sparks;
  root.userData.wheelContacts = wheelContacts;
  root.userData.wheels = wheels;
  root.userData.livery = livery;
  root.userData.shadowBlob = shadowBlob;
  root.userData.triangles = geos.tris;

  _built.push(root);
  (globalThis as unknown as { __kartShadow?: KartShadowDebug }).__kartShadow ??= kartShadowDebug();

  return { root, wheels };
}
