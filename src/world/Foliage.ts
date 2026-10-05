/**
 * ============================================================================
 *  Foliage — palms, pines, cypress, shrubs and grass.
 * ============================================================================
 *  Hero palms near the road are real lofted geometry with real fronds; the
 *  small stuff is alpha-tested cards. Everything is instanced (ten draw calls
 *  for the whole planting), swayed by a vertex shader with a per-instance phase
 *  and lit with wrap + transmission so the low sun burns through the leaves —
 *  ART_DIRECTION §4 calls that a hero moment and this is where it happens.
 * ============================================================================
 */
import * as THREE from 'three';
import {
  GeoAccum,
  InstSet,
  MatLib,
  RNG,
  Shared,
  bevelBox,
  card,
  clamp,
  lerp,
  loft,
  patchLod,
  patchRoughFromTint,
  patchTint,
  patchTranslucency,
  patchWind,
  plainBox,
  trs,
} from './Props';

const _mat = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();

const clamp01 = (v: number) => clamp(v, 0, 1);

/** Local trunk height of the unit palm; fronds attach here. */
const PALM_H = 7.2;
const PINE_H = 6.4;

export class Foliage {
  readonly meshes: THREE.Object3D[] = [];

  private palmTrunk!: InstSet;
  private palmFrond!: InstSet;
  private pineTrunk!: InstSet;
  private pineCanopy!: InstSet;
  private cypress!: InstSet;
  private cypressTuft!: InstSet;
  private shrub!: InstSet;
  private grass!: InstSet;
  private grassHi!: InstSet;
  private marram!: InstSet;
  private depthMats!: { frond: THREE.Material; pine: THREE.Material; shrub: THREE.Material };

  /** Contact-shadow requests, drained by Scenery once placement is finished. */
  readonly shadows: { p: THREE.Vector3; r: number; t: number }[] = [];

  constructor(private mats: MatLib, private u: Shared, private rng: RNG) {
    this.buildSets();
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * Palm trunk: a real curve (bows away from the prevailing wind), an
   * elliptical cross-section that rotates slightly up the stem, a flared root
   * base and a collar of old frond boots under the crown.
   */
  private palmTrunkGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    const bend = 0.16;
    const trunk = loft(
      (t, o) => {
        const s = Math.pow(t, 1.55);
        o.set(s * PALM_H * bend, t * PALM_H, s * PALM_H * bend * 0.35);
      },
      18,
      // 14 radial segments: at 8 the silhouette of a hero palm two metres from
      // the lens is visibly faceted against a bright sky.
      14,
      (t, a) => {
        // root flare, mid-stem taper, slight swelling under the crown
        const flare = 1 + Math.pow(1 - Math.min(t * 7, 1), 2.4) * 0.85;
        const taper = lerp(0.28, 0.15, Math.pow(t, 0.7)) + Math.pow(t, 5) * 0.03;
        // ellipse that slowly rotates so the silhouette is never a tube
        const ell = 1 + Math.cos(a * 2 + t * 3.1) * 0.055 + Math.cos(a * 3 - t * 1.7) * 0.03;
        return taper * flare * ell;
      },
      // uvRepeat 6 over a 7.2 m stem put the bark's 22 leaf-scar rings at 5 cm
      // spacing — a moiré band, not bark. 2.2 puts them at ~15 cm, which is
      // what a real palm's scar pitch looks like, and kills the stretch.
      2.2,
      false,
      false
    );
    // loft() drives both UV axes off one repeat; a 7.2 m stem with a ~1.2 m
    // girth needs them decoupled or the scar columns are squashed to a smear.
    // 0.5 across puts one texture tile around the whole trunk: eleven scar
    // columns per circumference, which is what a real palm has.
    {
      const tu = trunk.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < tu.count; i++) tu.setX(i, tu.getX(i) * 0.5);
      tu.needsUpdate = true;
    }
    acc.add(trunk, trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
    // root buttress wedges — the tell that it is planted, not stuck in
    const buttress = bevelBox(0.18, 0.5, 0.34, 0.04, 3);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      acc.add(buttress, trs(Math.cos(a) * 0.3, 0.16, Math.sin(a) * 0.3, -a, 1, 1, 1, 0.22), new THREE.Color(0.86, 0.84, 0.8));
    }
    // frond boots: a rough collar of cut stubs at the crown
    const cx = PALM_H * bend;
    const boot = plainBox(0.15, 0.22, 0.24, 4);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const y = PALM_H - 0.35 - (i % 3) * 0.22;
      acc.add(boot, trs(cx + Math.cos(a) * 0.2, y, Math.sin(a) * 0.2, -a, 1, 1, 1, -0.5), new THREE.Color(0.72, 0.66, 0.56));
    }
    // coconut cluster
    const nut = loft((t, o) => o.set(0, t * 0.2, 0), 2, 5, (t) => Math.sin((0.15 + t * 0.7) * Math.PI) * 0.115, 1, true, true);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.7;
      acc.add(nut, trs(cx + Math.cos(a) * 0.24, PALM_H - 0.05, Math.sin(a) * 0.24, 0), new THREE.Color(0.62, 0.56, 0.42));
    }
    return acc.build()!;
  }

  /**
   * One frond: a ribbon that arches, droops under its own weight and folds
   * into a shallow V along the rachis so it catches a rim from the low sun
   * rather than reading as a flat card.
   */
  private frondGeo(): THREE.BufferGeometry {
    const nx = 9,
      nz = 3;
    const L = 3.0,
      W = 0.92;
    // The frond starts INSIDE the trunk. The crown attach point sits on the
    // trunk's axis and the stem is ~0.16 m in radius up there, so a rachis
    // beginning at x = 0 emerges exactly on the silhouette edge and every frond
    // showed a visible plane/cylinder intersection with a hard seam — the
    // critique's "frond planes visibly interpenetrate the trunk cylinder with
    // no blend". Backing the root out by 0.18 m buries the first span in solid
    // geometry, so what you see leaving the trunk is the second span, already
    // clear of the surface.
    const ROOT = -0.18;
    const pos: number[] = [],
      uv: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    for (let j = 0; j <= nz; j++) {
      const vz = j / nz;
      const zn = (vz - 0.5) * 2;
      for (let i = 0; i <= nx; i++) {
        const t = i / nx;
        const x = ROOT + t * (L - ROOT);
        const arch = Math.sin(Math.min(t * 1.35, 1) * Math.PI * 0.62) * 0.52;
        const droop = Math.pow(t, 2.5) * 1.55;
        const fold = -Math.pow(Math.abs(zn), 1.6) * 0.16 * (0.35 + t * 0.9);
        const narrow = 0.42 + Math.sin(Math.pow(t, 0.6) * Math.PI) * 0.72;
        pos.push(x, arch - droop + fold, zn * W * 0.5 * narrow);
        uv.push(t, vz);
        // Junction AO. The inside of a palm crown is the densest shade in the
        // whole tree — a dozen frond bases packed round a stem — and without it
        // the fronds read as separate cards stuck onto a pole. A vertex-colour
        // ramp over the first 22% of the rachis costs nothing and is what makes
        // the crown look like it grew out of the trunk.
        const ao = lerp(0.4, 1.0, clamp01(t / 0.22));
        col.push(ao, ao, ao);
      }
    }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Volumetric canopy shading. A frond's true normal is the ribbon's, which
    // means every frond in a crown shades almost identically and the whole
    // canopy resolves to one flat plate — the "solid silhouette blob" note. Bend
    // each frond's normal outward and upward from the crown centre (the frond
    // runs along +X from the attach point) and the crown shades like a sphere
    // instead: lit on the sun side, transmitting on the far side, with real
    // internal value structure between the two.
    {
      const nAttr = g.getAttribute('normal') as THREE.BufferAttribute;
      const pAttr = g.getAttribute('position') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      const out = new THREE.Vector3();
      for (let i = 0; i < nAttr.count; i++) {
        v.set(pAttr.getX(i), pAttr.getY(i), pAttr.getZ(i));
        // outward along the rachis, lifted: the crown's own surface normal
        out.set(v.x / L, 0.55 + v.y * 0.12, v.z * 1.4).normalize();
        v.set(nAttr.getX(i), nAttr.getY(i), nAttr.getZ(i));
        // 45% toward the crown normal keeps the frond's own form readable
        v.lerp(out, 0.45).normalize();
        nAttr.setXYZ(i, v.x, v.y, v.z);
      }
      nAttr.needsUpdate = true;
    }
    return g;
  }

  /**
   * A clump of grass: crossed alpha cards, each leaning a different way, with
   * the fan splayed so the clump has a silhouette from every azimuth rather
   * than reading as a card edge-on. `n` cards per clump; 3 is the honest
   * minimum for a clump that never disappears as you drive past it.
   */
  private clumpGeo(w: number, h: number, n: number, rng: RNG): THREE.BufferGeometry {
    const acc = new GeoAccum();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI + rng() * 0.5;
      const s = 0.72 + rng() * 0.6;
      // a slight outward lean per card turns a flat cross into a fountain
      const lean = (rng() - 0.5) * 0.34;
      acc.add(
        card(w * s, h * s),
        trs((rng() - 0.5) * w * 0.45, 0, (rng() - 0.5) * w * 0.45, a, 1, 1, 1, lean * Math.cos(a), lean * Math.sin(a)),
        new THREE.Color(1, 1, 1)
      );
    }
    return acc.build()!;
  }

  private pineTrunkGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    const trunk = loft(
      (t, o) => o.set(Math.sin(t * 2.1) * 0.42 * t, t * PINE_H, Math.cos(t * 1.4) * 0.2 * t),
      14,
      8,
      (t) => lerp(0.4, 0.17, Math.pow(t, 0.8)) * (1 + Math.pow(1 - Math.min(t * 6, 1), 2.2) * 0.7),
      5,
      false,
      false
    );
    acc.add(trunk, trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
    // three main limbs branching into the umbrella
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.9;
      const limb = loft(
        (t, o) => o.set(Math.sin(2.1) * 0.42 + Math.cos(a) * t * 1.5, PINE_H - 0.4 + t * 1.25 - t * t * 0.35, Math.cos(1.4) * 0.2 + Math.sin(a) * t * 1.5),
        6,
        6,
        (t) => 0.13 * (1 - t * 0.6),
        3
      );
      acc.add(limb, trs(0, 0, 0, 0), new THREE.Color(0.94, 0.92, 0.9));
    }
    const root = bevelBox(0.2, 0.55, 0.34, 0.045, 3);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.3;
      acc.add(root, trs(Math.cos(a) * 0.35, 0.18, Math.sin(a) * 0.35, -a, 1, 1, 1, 0.24), new THREE.Color(0.9, 0.88, 0.84));
    }
    return acc.build()!;
  }

  /** Slightly domed card for the pine umbrella and shrub masses. */
  private canopyCard(w: number, h: number, bow: number): THREE.BufferGeometry {
    const g = new THREE.PlaneGeometry(w, h, 3, 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w;
      p.setZ(i, -Math.cos(u * Math.PI) * bow + bow);
    }
    g.computeVertexNormals();
    return g;
  }

  private cypressGeo(): THREE.BufferGeometry {
    // Tall spindle with a bumpy, irregular profile — the silhouette IS the tree.
    return loft(
      (t, o) => o.set(Math.sin(t * 3.0) * 0.14, t * 7.0, Math.cos(t * 2.2) * 0.1),
      20,
      10,
      (t, a) => {
        const prof = Math.pow(Math.sin(Math.pow(t, 0.62) * Math.PI * 0.96), 0.72);
        const bump = 1 + Math.sin(a * 5 + t * 19) * 0.09 + Math.sin(a * 3 - t * 31) * 0.06;
        return Math.max(0.02, prof * 0.72 * bump * (t > 0.97 ? 0.3 : 1));
      },
      6,
      true,
      true
    );
  }

  private tuftGeo(w: number, h: number, blades: number, rng: RNG): THREE.BufferGeometry {
    const acc = new GeoAccum();
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI + rng() * 0.4;
      const s = 0.75 + rng() * 0.5;
      acc.add(card(w * s, h * s), trs((rng() - 0.5) * w * 0.3, 0, (rng() - 0.5) * w * 0.3, a, 1, 1, 1, 0, (rng() - 0.5) * 0.22), new THREE.Color(1, 1, 1));
    }
    return acc.build()!;
  }

  // -------------------------------------------------------------------------

  private buildSets() {
    const T = this.mats.tex;
    const rng = this.rng;

    const barkPalmMat = new THREE.MeshStandardMaterial({
      ...(T.bark('palm') as any),
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    barkPalmMat.normalScale.set(1.1, 1.1);
    this.mats.register(barkPalmMat);
    patchWind(barkPalmMat, this.u);
    patchLod(barkPalmMat, this.u);

    const barkPineMat = new THREE.MeshStandardMaterial({
      ...(T.bark('pine') as any),
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    barkPineMat.normalScale.set(1.25, 1.25);
    this.mats.register(barkPineMat);
    patchWind(barkPineMat, this.u);
    patchLod(barkPineMat, this.u);

    // `vcol` carries the frond's junction AO (see `frondGeo`). `alphaToCoverage`
    // is set inside `foliage()` for every cut-out material including this one —
    // checked against finding #6, which asked whether it was on the frond
    // specifically or only on the grass. It is on both, and the renderer's MSAA
    // is what makes it do anything, so the two have to ship together.
    const frondMat = this.mats.foliage(T.palmFrond(), { alphaTest: 0.38, trans: 1.35, vcol: true });
    const pineMat = this.mats.foliage(T.pineCluster(), { alphaTest: 0.42, trans: 0.9, color: 0xdfe8d8 });
    const shrubMat = this.mats.foliage(T.shrubLeaves(), { alphaTest: 0.44, trans: 0.75 });
    const grassMat = this.mats.foliage(T.grassBlades(), { alphaTest: 0.34, trans: 1.0 });
    // Fresh growth is waxy, dry patches are matte — driven by the same clump
    // mask that set the instance's colour, so the two never disagree (§4).
    patchRoughFromTint(grassMat, 0.55, 0.88);
    // The cypress body is solid geometry, so it takes an opaque needle
    // surface rather than a cut-out sheet; cards break its silhouette instead.
    const cypMat = new THREE.MeshStandardMaterial({ ...(T.needleSurface() as any), roughness: 1, metalness: 0 });
    cypMat.normalScale.set(1.3, 1.3);
    this.mats.register(cypMat);
    patchTint(cypMat);
    patchTranslucency(cypMat, this.u, 0.45);
    patchWind(cypMat, this.u);
    patchLod(cypMat, this.u);

    // Alpha-tested shadows: without a matching depth material the cards would
    // cast solid rectangles. The wind patch goes on too so shadows sway.
    const depthFor = (map: THREE.Texture, alphaTest: number) => {
      const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest });
      // Matches the colour pass: without it the shadow silhouette cuts on a
      // different edge from the lit one and leaves a bright rim inside the leaf.
      d.alphaToCoverage = true;
      this.mats.register(d);
      patchWind(d, this.u);
      patchLod(d, this.u);
      return d;
    };

    this.palmTrunk = new InstSet(this.palmTrunkGeo(), barkPalmMat, 'palm-trunk');
    this.palmFrond = new InstSet(this.frondGeo(), frondMat, 'palm-fronds');
    this.pineTrunk = new InstSet(this.pineTrunkGeo(), barkPineMat, 'pine-trunk');
    this.pineCanopy = new InstSet(this.canopyCard(3.4, 1.7, 0.34), pineMat, 'pine-canopy');
    this.cypress = new InstSet(this.cypressGeo(), cypMat, 'cypress');
    this.cypressTuft = new InstSet(this.canopyCard(1.5, 2.4, 0.2), pineMat, 'cypress-tuft');
    this.shrub = new InstSet(this.tuftGeo(1.5, 1.1, 3, rng), shrubMat, 'shrub');
    this.grass = new InstSet(this.tuftGeo(0.62, 0.5, 3, rng), grassMat, 'grass');
    // The hero grass band. Round 1's verge had only the small `grass` tuft on
    // it (0.5 m tall, LOD 48) so nothing ever broke the kerb line or the
    // skyline, and the terrain sheet underneath was doing all the work — which
    // is why it read as painted moss. These are 4x the volume, sit in the 12 m
    // band either side of the road, and are one InstancedMesh for the lot.
    this.grassHi = new InstSet(this.clumpGeo(0.95, 1.05, 4, rng), grassMat, 'grass-clump');
    this.marram = new InstSet(this.tuftGeo(0.5, 0.95, 3, rng), grassMat, 'marram');

    this.depthMats = {
      frond: depthFor(T.palmFrond(), 0.38),
      pine: depthFor(T.pineCluster(), 0.42),
      shrub: depthFor(T.shrubLeaves(), 0.44),
    };
  }

  // -------------------------------------------------------------------------
  // Placement API — Scenery drives these off ctx.track.sample()
  // -------------------------------------------------------------------------

  /**
   * Hero palm. `scale` ~0.8–1.35 gives 5.8–9.7 m trees.
   * `lean` (radians) and `leanDir` (world yaw the crown falls toward) let the
   * near-frame pass hang a crown out over the road, which is the cheapest
   * foreground occluder in the game.
   */
  palm(p: THREE.Vector3, scale: number, yaw: number, t: number, lean = 0, leanDir = 0) {
    const rng = this.rng;
    const phase = rng() * 100;
    const tilt = lean > 0 ? lean : (rng() - 0.5) * 0.13;
    // The YXZ tilt pair leans the crown toward world azimuth (tiltDir+yaw+PI),
    // so invert that to aim it at `leanDir`.
    const tiltDir = lean > 0 ? leanDir - yaw + Math.PI : rng() * Math.PI * 2;
    _euler.set(Math.cos(tiltDir) * tilt, yaw, Math.sin(tiltDir) * tilt, 'YXZ');
    _quat.setFromEuler(_euler);
    _mat.compose(p, _quat, _scl.setScalar(scale));
    const trunkM = _mat.clone();
    this.palmTrunk.add(trunkM, { wind: new THREE.Vector4(phase, 1.5, 0, 0), lod: 0 });

    // Crown frame, in the trunk's own space, then pushed through the same
    // transform so the fronds ride any tilt the trunk has.
    const bend = 0.16;
    const crownLocal = new THREE.Vector3(PALM_H * bend, PALM_H - 0.15, PALM_H * bend * 0.35);
    const crownWorldH = PALM_H * scale;
    // Two rings. The outer ring is the mature crown — long fronds, heavy droop,
    // spread nearly flat. The inner ring is the spear growth, short and near
    // vertical. Round 1 had one ring, which from below or side-on presented the
    // whole crown edge-on as a single band; the inner ring is what stops the
    // canopy reading as a plate at any angle and gives the backlit transmission
    // two depths of leaf to burn through.
    const n = 11 + ((rng() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.3;
      // Younger fronds stand up, old ones hang almost vertically.
      const age = i / n;
      const pitch = lerp(-0.62, 0.55, Math.pow(rng(), 0.7)) - age * 0.12;
      const roll = (rng() - 0.5) * 0.5;
      const fs = 0.82 + rng() * 0.4;
      const local = new THREE.Matrix4()
        .compose(crownLocal, new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, -a, roll, 'YXZ')), new THREE.Vector3(fs, fs, fs));
      this.palmFrond.add(_mat.multiplyMatrices(trunkM, local).clone(), {
        wind: new THREE.Vector4(phase, 1.5, crownWorldH, 1.0),
        lod: 0,
        color: _col.setHSL(0.23 + rng() * 0.04, 0.16 + rng() * 0.14, 0.66 + rng() * 0.2).clone(),
      });
    }
    const inner = 4 + ((rng() * 2) | 0);
    for (let i = 0; i < inner; i++) {
      const a = (i / inner) * Math.PI * 2 + rng() * 0.8;
      const fs = 0.42 + rng() * 0.22;
      const local = new THREE.Matrix4().compose(
        crownLocal,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.95 - rng() * 0.45, -a, (rng() - 0.5) * 0.4, 'YXZ')),
        new THREE.Vector3(fs, fs, fs)
      );
      this.palmFrond.add(_mat.multiplyMatrices(trunkM, local).clone(), {
        wind: new THREE.Vector4(phase, 1.5, crownWorldH, 0.7),
        lod: 0,
        // spear growth is the palest thing on the tree and it is what catches
        // the rim when the sun sits behind the crown
        color: _col.setHSL(0.24 + rng() * 0.03, 0.2 + rng() * 0.12, 0.78 + rng() * 0.16).clone(),
      });
    }
    this.shadows.push({ p: p.clone(), r: 2.3 * scale, t });
  }

  /** Mediterranean umbrella pine. */
  pine(p: THREE.Vector3, scale: number, yaw: number, t: number) {
    const rng = this.rng;
    const phase = rng() * 100;
    _euler.set((rng() - 0.5) * 0.08, yaw, (rng() - 0.5) * 0.08, 'YXZ');
    _quat.setFromEuler(_euler);
    const trunkM = _mat.compose(p, _quat, _scl.setScalar(scale)).clone();
    this.pineTrunk.add(trunkM, { wind: new THREE.Vector4(phase, 1.6, 0, 0), lod: 0 });
    const crownWorldH = PINE_H * scale;
    const layers = 3;
    for (let l = 0; l < layers; l++) {
      const rr = 1.9 - l * 0.5;
      const n = 6 - l;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + l * 0.7 + rng() * 0.3;
        const local = new THREE.Matrix4().compose(
          new THREE.Vector3(Math.sin(2.1) * 0.42 + Math.cos(a) * rr, PINE_H + 0.35 + l * 0.52, Math.cos(1.4) * 0.2 + Math.sin(a) * rr),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.28 - l * 0.12, -a + Math.PI / 2, (rng() - 0.5) * 0.3, 'YXZ')),
          new THREE.Vector3(1, 1, 1).multiplyScalar(0.85 + rng() * 0.4)
        );
        this.pineCanopy.add(_mat.multiplyMatrices(trunkM, local).clone(), {
          wind: new THREE.Vector4(phase, 1.6, crownWorldH, 0.5),
          lod: 0,
          color: _col.setHSL(0.25 + rng() * 0.04, 0.14 + rng() * 0.14, 0.58 + rng() * 0.22).clone(),
        });
      }
    }
    this.shadows.push({ p: p.clone(), r: 2.6 * scale, t });
  }

  /** Cypress spire — the vertical accent through the village. */
  cyp(p: THREE.Vector3, scale: number, yaw: number, t: number) {
    const rng = this.rng;
    const phase = rng() * 100;
    const m = _mat.compose(p, _quat.setFromEuler(_euler.set((rng() - 0.5) * 0.05, yaw, (rng() - 0.5) * 0.05, 'YXZ')), _scl.set(scale * (0.8 + rng() * 0.3), scale, scale * (0.8 + rng() * 0.3))).clone();
    this.cypress.add(m, {
      wind: new THREE.Vector4(phase, 1.95, 0, 0.2),
      lod: 130,
      color: _col.setHSL(0.26 + rng() * 0.03, 0.12 + rng() * 0.12, 0.52 + rng() * 0.16).clone(),
    });
    // a few cards break the smooth spindle silhouette
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng();
      const y = 1.6 + rng() * 4.2;
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * 0.42, y, Math.sin(a) * 0.42),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, 0.1, 'YXZ')),
        new THREE.Vector3(0.6, 0.6, 0.6)
      );
      this.cypressTuft.add(_mat.multiplyMatrices(m, local).clone(), {
        wind: new THREE.Vector4(phase, 1.95, 7 * scale * (y / 7), 0.4),
        lod: 110,
        color: _col.setHSL(0.26, 0.12, 0.5 + rng() * 0.14).clone(),
      });
    }
    this.shadows.push({ p: p.clone(), r: 1.1 * scale, t });
  }

  bush(p: THREE.Vector3, scale: number, yaw: number, t: number, dry = false) {
    const rng = this.rng;
    this.shrub.add(_mat.compose(p, _quat.setFromEuler(_euler.set(0, yaw, 0, 'YXZ')), _scl.set(scale * (0.85 + rng() * 0.4), scale * (0.8 + rng() * 0.5), scale)).clone(), {
      wind: new THREE.Vector4(rng() * 100, 1.35, 0, 0.55),
      lod: 90,
      color: dry
        ? _col.setHSL(0.13 + rng() * 0.05, 0.22 + rng() * 0.14, 0.66 + rng() * 0.16).clone()
        : _col.setHSL(0.23 + rng() * 0.05, 0.14 + rng() * 0.16, 0.62 + rng() * 0.22).clone(),
    });
    if (scale > 0.9) this.shadows.push({ p: p.clone(), r: 0.9 * scale, t });
  }

  // -------------------------------------------------------------------------
  // The 40–150 m band
  // -------------------------------------------------------------------------
  //
  // Everything above is authored for the near field and LODs out between 45 and
  // 130 m, which is correct for what it is and is also exactly why the 40–150 m
  // band was the emptiest part of every frame: the near planting had already
  // collapsed and the backdrop had not started. These three fill it.
  //
  // All of them ride the EXISTING instance sets — the same shrub mesh, the same
  // cypress mesh, the same draw call — with a far LOD cut and a distance-
  // appropriate tint. A terraced grove at 90 m therefore costs zero additional
  // draw calls, which is the only reason it can exist inside a 250-call budget
  // that was already at ~200.

  /**
   * An olive: a low silver-green dome. No trunk, deliberately — at 60 m a 1.5 m
   * olive trunk under a 4 m canopy is two pixels of aliasing, and the thing that
   * makes a grove read at that distance is the canopy VALUE (olives are the
   * palest green in a Mediterranean landscape and they catch a low sun as a
   * distinct silver band) and the row spacing, not the anatomy.
   */
  olive(p: THREE.Vector3, scale: number, yaw: number) {
    const rng = this.rng;
    this.shrub.add(
      _mat.compose(p, _quat.setFromEuler(_euler.set(0, yaw, 0, 'YXZ')), _scl.set(scale * (1.0 + rng() * 0.35), scale * (0.78 + rng() * 0.3), scale * (1.0 + rng() * 0.35))).clone(),
      {
        wind: new THREE.Vector4(rng() * 100, 1.25, 0, 0.4),
        lod: 340,
        color: _col.setHSL(0.19 + rng() * 0.03, 0.13 + rng() * 0.07, 0.70 + rng() * 0.12).clone(),
      }
    );
  }

  /** A vine row segment: wide, low and flat, so a run of them reads as combing. */
  vine(p: THREE.Vector3, scale: number, yaw: number) {
    const rng = this.rng;
    this.shrub.add(_mat.compose(p, _quat.setFromEuler(_euler.set(0, yaw, 0, 'YXZ')), _scl.set(scale * 1.9, scale * 0.55, scale * 0.62)).clone(), {
      wind: new THREE.Vector4(rng() * 100, 1.2, 0, 0.35),
      lod: 240,
      color: _col.setHSL(0.24 + rng() * 0.03, 0.19 + rng() * 0.09, 0.50 + rng() * 0.12).clone(),
    });
  }

  /** A cypress that survives to the backdrop — the midground's vertical accent. */
  cypFar(p: THREE.Vector3, scale: number, yaw: number) {
    const rng = this.rng;
    this.cypress.add(
      _mat.compose(p, _quat.setFromEuler(_euler.set(0, yaw, 0, 'YXZ')), _scl.set(scale * (0.8 + rng() * 0.25), scale, scale * (0.8 + rng() * 0.25))).clone(),
      {
        wind: new THREE.Vector4(rng() * 100, 1.95, 0, 0.2),
        lod: 360,
        color: _col.setHSL(0.26 + rng() * 0.03, 0.13 + rng() * 0.10, 0.44 + rng() * 0.14).clone(),
      }
    );
  }

  /**
   * A hero grass clump for the 12 m band either side of the road.
   *
   * `dry` in 0..1 is the clump mask Scenery samples off a 6 m world-space
   * field: 0 is fresh growth at #6f9b47, 1 is a sun-bleached patch at #9aa858.
   * It drives hue AND value together, because a verge whose only variation is
   * hue still reads as one flat carpet — the thing that kills astroturf is
   * light and dark clumps next to each other, not green and yellow ones.
   */
  clump(p: THREE.Vector3, scale: number, yaw: number, dry: number, lean = 0) {
    const rng = this.rng;
    const d = clamp01(dry);
    // #6f9b47 -> #9aa858 in HSL: hue drifts warm, saturation drops, value lifts
    const h = lerp(0.245, 0.155, d) + (rng() - 0.5) * 0.022;
    const s = lerp(0.24, 0.16, d) + (rng() - 0.5) * 0.09;
    // the value spread is deliberately wide — that is the clumping read
    const l = lerp(0.52, 0.80, d) + (rng() - 0.5) * 0.17;
    this.grassHi.add(
      _mat
        .compose(
          p,
          _quat.setFromEuler(_euler.set(lean * Math.cos(yaw), yaw, lean * Math.sin(yaw), 'YXZ')),
          _scl.set(scale * (0.8 + rng() * 0.5), scale * (0.72 + rng() * 0.7), scale * (0.8 + rng() * 0.5))
        )
        .clone(),
      {
        wind: new THREE.Vector4(rng() * 100, 1.05, 0, 1.15),
        lod: 45,
        color: _col.setHSL(h, clamp01(s), clamp01(l)).clone(),
      }
    );
  }

  tuft(p: THREE.Vector3, scale: number, yaw: number, beach = false) {
    const rng = this.rng;
    const set = beach ? this.marram : this.grass;
    set.add(_mat.compose(p, _quat.setFromEuler(_euler.set(0, yaw, 0, 'YXZ')), _scl.set(scale * (0.8 + rng() * 0.5), scale * (0.7 + rng() * 0.7), scale)).clone(), {
      wind: new THREE.Vector4(rng() * 100, 1.15, 0, beach ? 1.3 : 0.9),
      lod: beach ? 56 : 48,
      color: beach
        ? _col.setHSL(0.14 + rng() * 0.05, 0.22 + rng() * 0.14, 0.72 + rng() * 0.16).clone()
        : _col.setHSL(0.22 + rng() * 0.06, 0.14 + rng() * 0.18, 0.64 + rng() * 0.24).clone(),
    });
  }

  // -------------------------------------------------------------------------

  build(): THREE.Object3D[] {
    const d = this.depthMats;
    const emit = (s: InstSet, cast: boolean, depth?: THREE.Material) => {
      const m = s.build(cast, true);
      if (!m) return;
      if (depth) m.customDepthMaterial = depth as any;
      this.meshes.push(m);
    };
    emit(this.palmTrunk, true);
    emit(this.palmFrond, true, d.frond);
    emit(this.pineTrunk, true);
    emit(this.pineCanopy, true, d.pine);
    emit(this.cypress, true);
    emit(this.cypressTuft, false, d.pine);
    emit(this.shrub, true, d.shrub);
    // Grass casting shadows is pure cost for no read at this scale.
    emit(this.grass, false);
    emit(this.grassHi, false);
    emit(this.marram, false);
    return this.meshes;
  }
}
