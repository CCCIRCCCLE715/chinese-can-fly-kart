/**
 * ============================================================================
 *  SUNSET BAY CIRCUIT — ITrack implementation
 * ============================================================================
 *  The centreline is a uniform arc-length station table baked by TrackLayout,
 *  so `t` is arc length over total length by construction and needs no
 *  reparameterisation LUT bolted on afterwards.
 *
 *  Lateral offsets are measured along the *banked* binormal, so `edgeRatio`
 *  means the same thing on the 20° coastal curve as on the flat start
 *  straight. Terrain beyond the kerb unbanks back to horizontal, which is what
 *  stops the shoulder flying off into the sky on the banked section.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx, ITrack, SurfaceProbe, TrackSample } from '../types';
import { Surface } from '../types';
import {
  buildCenterline, findCorners, terrainDetail, smoothstep as ss, gridSlot, BOOST_PADS, CHECKPOINTS,
  CROWN, GRID_LAT, KERB_CROWN0, KERB_CROWN1, KERB_END, KERB_HS, KERB_QS,
  KERB_RIPPLE_A, KERB_RIPPLE_K, KERB_W, SEA_Y,
  SKIRT_W, WALL_HEIGHT, WALL_NONE, ZONES,
  type Centerline, type Corner,
} from './TrackLayout';
import { buildTrackGeometry } from './TrackGeometry';

// --- module-scope scratch; nothing in the hot path allocates ---------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** fraction of half-width over which the banked outer apron eases off */
const APRON_T0 = 0.60;
/** fraction of the outer lip's rise the apron gives back */
const APRON_FRAC = 0.20;

function makeSample(): TrackSample {
  return {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    normal: new THREE.Vector3(), binormal: new THREE.Vector3(),
    halfWidth: 0, bank: 0, distance: 0, t: 0,
  };
}
function makeProbe(): SurfaceProbe {
  return { y: 0, normal: new THREE.Vector3(), surface: Surface.Road, lateral: 0, t: 0, edgeRatio: 0 };
}

export class Track implements ITrack {
  readonly group = new THREE.Group();
  readonly startGrid: { pos: THREE.Vector3; yaw: number }[] = [];
  readonly checkpointCount = CHECKPOINTS;
  readonly bounds = new THREE.Box3();
  length = 0;

  /** baked station table — TrackGeometry reads this directly */
  readonly cl: Centerline;

  /**
   * Every corner on the lap, apex-first, with its turn direction and strength.
   *
   * Published rather than kept private because it is the answer to the round-1
   * read-ahead note and *only the track can compute it*. Scenery is asked to put
   * a tall landmark on the outside of every blind corner exit; it currently has
   * three of them (banner arch, windmill, lighthouse) pinned to hand-typed `t`
   * values that do not coincide with any corner. `landmarkAnchor()` below turns
   * an entry here into the world point where that landmark belongs.
   */
  readonly corners: readonly Corner[];

  // --- macro heightfield of the surrounding land -------------------------
  hmX0 = 0; hmZ0 = 0; hmCell = 6; hmW = 0; hmH = 0;
  hm: Float32Array = null!;
  /** distance-beyond-shoulder per heightfield cell, drives the far-field blur */
  private hmQ: Float32Array = null!;

  // --- station lookup acceleration ---------------------------------------
  private gCell = 22;
  private gX0 = 0; private gZ0 = 0; private gW = 0; private gH = 0;
  private buckets: Int32Array[] = [];

  // --- pooled returns ----------------------------------------------------
  private probePool: SurfaceProbe[] = [];
  private probeAt = 0;
  private wallPool: { push: THREE.Vector3; normal: THREE.Vector3 }[] = [];
  private wallAt = 0;
  private seaMesh: THREE.Mesh | null = null;
  private seaChecked = false;

  // --- materials the geometry pass cloned out of the shared library --------
  // Those clones are invisible to `Materials.update()`, which is what hands
  // every road surface its environment map once the sky has been rendered.
  // Without this the tarmac would silently lose its env term the moment we
  // started cloning to enable vertex colours.
  private envClones: THREE.MeshStandardMaterial[] = [];
  private lastEnv: THREE.Texture | null | undefined;

  constructor() {
    this.cl = buildCenterline();
    this.corners = findCorners(this.cl);
    this.length = this.cl.length;
    for (let i = 0; i < 16; i++) this.probePool.push(makeProbe());
    for (let i = 0; i < 8; i++) {
      this.wallPool.push({ push: new THREE.Vector3(), normal: new THREE.Vector3() });
    }
    this.buildAccel();
    this.buildHeightfield();
    this.buildStartGrid();
    this.computeBounds();
  }

  init(ctx: Ctx) {
    buildTrackGeometry(this, ctx);
    ctx.scene.add(this.group);
  }

  update(ctx: Ctx) {
    if (ctx.envMap !== this.lastEnv && this.envClones.length) {
      this.lastEnv = ctx.envMap;
      for (const m of this.envClones) { m.envMap = ctx.envMap; m.needsUpdate = true; }
    }
    if (this.seaChecked || !this.seaMesh) return;
    this.seaChecked = true;
    // The circuit needs a sea to sit in whether or not the scenery pass
    // shipped one. If somebody else added an ocean, stand down rather than
    // fight them for the z-buffer at y = 0.
    let foreign = false;
    ctx.scene.traverse((o) => {
      if (o !== this.seaMesh && /sea|ocean|water/i.test(o.name)) foreign = true;
    });
    if (foreign) {
      this.seaMesh.parent?.remove(this.seaMesh);
      this.seaMesh = null;
    }
  }

  dispose() {
    this.group.traverse((o: any) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x: any) => x.dispose?.());
      else m?.dispose?.();
    });
  }

  // =======================================================================
  //  Sampling
  // =======================================================================

  /** `out` is a non-interface convenience: pass a scratch to avoid garbage. */
  sample(t: number, out?: TrackSample): TrackSample {
    const cl = this.cl, n = cl.count;
    t = t - Math.floor(t);
    const f = t * n;
    let i = Math.floor(f);
    if (i >= n) i = n - 1;
    const u = f - i;
    const j = (i + 1) % n;
    const s = out || makeSample();
    s.pos.set(
      cl.px[i] + (cl.px[j] - cl.px[i]) * u,
      cl.py[i] + (cl.py[j] - cl.py[i]) * u,
      cl.pz[i] + (cl.pz[j] - cl.pz[i]) * u,
    );
    s.tangent.set(
      cl.tx[i] + (cl.tx[j] - cl.tx[i]) * u,
      cl.ty[i] + (cl.ty[j] - cl.ty[i]) * u,
      cl.tz[i] + (cl.tz[j] - cl.tz[i]) * u,
    ).normalize();
    s.normal.set(
      cl.nx[i] + (cl.nx[j] - cl.nx[i]) * u,
      cl.ny[i] + (cl.ny[j] - cl.ny[i]) * u,
      cl.nz[i] + (cl.nz[j] - cl.nz[i]) * u,
    ).normalize();
    // re-orthogonalise rather than lerping a third vector, so the frame stays
    // exactly right-handed after interpolation
    s.binormal.crossVectors(s.tangent, s.normal).normalize();
    s.normal.crossVectors(s.binormal, s.tangent).normalize();
    s.halfWidth = cl.half[i] + (cl.half[j] - cl.half[i]) * u;
    s.bank = cl.bank[i] + (cl.bank[j] - cl.bank[i]) * u;
    s.distance = t * cl.length;
    s.t = t;
    return s;
  }

  sampleByDistance(d: number, out?: TrackSample): TrackSample {
    return this.sample(d / this.cl.length, out);
  }

  checkpointAt(t: number): number {
    t = t - Math.floor(t);
    const c = Math.floor(t * CHECKPOINTS);
    return c >= CHECKPOINTS ? CHECKPOINTS - 1 : c;
  }

  minimapPath(samples: number): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const cl = this.cl;
    for (let k = 0; k < samples; k++) {
      const f = (k / samples) * cl.count;
      const i = Math.floor(f) % cl.count;
      const j = (i + 1) % cl.count;
      const u = f - Math.floor(f);
      out.push({
        x: cl.px[i] + (cl.px[j] - cl.px[i]) * u,
        z: cl.pz[i] + (cl.pz[j] - cl.pz[i]) * u,
      });
    }
    return out;
  }

  // =======================================================================
  //  Cross-section — the single source of truth for road/kerb/shoulder shape.
  //  TrackGeometry builds meshes from exactly these numbers, which is why the
  //  road, the kerbs, the skirt and the physics surface cannot disagree.
  // =======================================================================

  /**
   * Flattened outer apron on the steeply banked corners, in metres of drop.
   *
   * A 20° banked 180 with an 8.8 m half-width puts its outer lip 3.0 m above the
   * centreline, and a chase camera on the inside line sits *below* that lip — so
   * everything outboard of the corner (the bay, the coast band, the sky under the
   * horizon) is occluded by the road's own outer edge. That is a property of
   * banking and not a bug; no amount of shoulder-lowering will let a camera at
   * 2.2 m see over a lip 4.3 m above the inside line.
   *
   * What a real banked oval does have, and this one did not, is a *flattened
   * apron*: the outer fifth of the roadway eases off the full cross-slope. It
   * buys about 0.6 m of lip height back, it makes the outer lane a genuinely
   * different surface from the racing line rather than more of the same plane,
   * and it gives the outside of the corner somewhere to run wide onto.
   *
   * Gated at 12° so it fires on the banked coastal 180 (t 0.735–0.848) and on
   * nothing else on this layout — the next-steepest section is 9.5°. Both ends
   * of the ramp are `smoothstep`, so the surface stays C1: there is no crease for
   * the physics to catch on and no slope break for the gloss strip to kink over.
   *
   * `t` clamps at 1, so the kerb and the shoulder inherit the full lip drop and
   * ride down with the road edge instead of leaving a 0.6 m step at the joint.
   */
  private apronDrop(i: number, L: number): number {
    const cl = this.cl;
    const bank = cl.bank[i];
    const amt = ss(0.209, 0.314, Math.abs(bank));      // 12° … 18°
    if (amt <= 0) return 0;
    const hw = cl.half[i];
    // the raised side is the one the bank sign points at
    const t = Math.min(1, (bank >= 0 ? L : -L) / hw);
    if (t <= APRON_T0) return 0;
    const f = ss(APRON_T0, 1, t);
    return amt * f * f * hw * Math.abs(Math.sin(bank)) * APRON_FRAC;
  }

  /**
   * d(crossOffset)/dL on the roadway, i.e. the extra lateral slope the surface
   * carries on top of the banked plane.
   *
   * TrackGeometry used to compute this analytically as the derivative of the
   * crown parabola, which was exact while the crown was the only thing in
   * `crossOffset` inside the edges. It no longer is: the banked apron adds up to
   * 14° of its own over the outer fifth of the coastal 180, and a mesh that
   * *bends* while its shading normal does not is a flat-looking dent. Taking it
   * off the same function the vertices come from is the only way the two cannot
   * drift apart again.
   *
   * Clamped to the roadway at both ends so the difference never straddles the
   * kerb junction and reports the kerb's 31° face as road slope.
   */
  roadSlope(i: number, L: number): number {
    const hw = this.cl.half[i];
    const h = 0.2;
    const a = Math.max(-hw, Math.min(hw, L - h));
    const b = Math.max(-hw, Math.min(hw, L + h));
    if (b - a < 1e-6) return 0;
    return (this.crossOffset(i, b) - this.crossOffset(i, a)) / (b - a);
  }

  /** Vertical offset of the ground from the banked road plane, at lateral L. */
  crossOffset(i: number, L: number): number {
    const cl = this.cl;
    const a = Math.abs(L);
    const hw = cl.half[i];
    const apron = this.apronDrop(i, L);
    if (a <= hw) {
      const r = a / hw;
      return -CROWN * r * r - apron;
    }
    const kerbAmt = cl.kerb[i];
    const q0 = a - hw;
    if (q0 <= KERB_W) return -CROWN - apron + this.kerbProfile(q0, i) * kerbAmt;
    return -CROWN - apron + KERB_END * kerbAmt + this.shoulderOffset(i, L < 0, q0 - KERB_W);
  }

  /**
   * Raised kerb, evaluated straight off the shared `KERB_QS`/`KERB_HS` table:
   * a flush joint strip, a steep inner face, a shallow bevel, a flat crown with
   * the rumble ripple, then the outer chamfers down to the shoulder.
   *
   * Piecewise-linear on purpose — see the table's note. It also means the flat
   * facet normals `TrackGeometry` derives from consecutive breakpoints are
   * exact rather than a finite-difference approximation smeared across creases.
   */
  kerbProfile(q0: number, i: number): number {
    const q = q0 < 0 ? 0 : q0 > KERB_W ? KERB_W : q0;
    let k = 1;
    while (k < KERB_QS.length - 1 && q > KERB_QS[k]) k++;
    const a = KERB_QS[k - 1], bq = KERB_QS[k];
    const h = KERB_HS[k - 1] + (KERB_HS[k] - KERB_HS[k - 1]) * ((q - a) / (bq - a));
    // Confined to the crown so it never disturbs the face or the bevel angle —
    // those two facets are the whole point of the profile. Bounded by the named
    // crown constants, not by positions in the breakpoint table: the table gains
    // and loses chamfers, and the ripple must not move when it does.
    //
    // Amplitude and wavelength both live in TrackLayout now, because the mesh
    // has to sample this at better than half the wavelength and the two numbers
    // cannot be allowed to drift apart. See KERB_RIPPLE_A.
    const crown = ss(KERB_CROWN0 - 0.10, KERB_CROWN0, q) * (1 - ss(KERB_CROWN1, KERB_CROWN1 + 0.14, q));
    return h + KERB_RIPPLE_A * Math.sin(i * this.cl.ds * KERB_RIPPLE_K) * crown;
  }

  /** Ground height beyond the kerb, relative to the shoulder edge. */
  private shoulderOffset(i: number, left: boolean, q: number): number {
    const cl = this.cl;
    const n0 = left ? cl.nearL0[i] : cl.nearR0[i];
    const n1 = left ? cl.nearL1[i] : cl.nearR1[i];
    const n2 = left ? cl.nearL2[i] : cl.nearR2[i];
    let near: number;
    if (q < 1.5) near = n0 * ss(0, 1.5, q);
    else if (q < 4) near = n0 + (n1 - n0) * ss(1.5, 4, q);
    else near = n1 + (n2 - n1) * ss(4, 12, q);
    const farY = left ? cl.farL[i] : cl.farR[i];
    const farD = left ? cl.farDL[i] : cl.farDR[i];
    const fb = ss(12, farD, q);
    if (fb <= 0) return near;
    // shoulder-edge height in world space, so the far target can be absolute
    const edge = cl.half[i] + KERB_W;
    const edgeY = cl.py[i] + (left ? -edge : edge) * cl.by[i] - CROWN + KERB_END * cl.kerb[i];
    return near + (farY - edgeY - near) * fb;
  }

  /**
   * Ground height at station `i`, lateral `L`, `sOff` metres further along.
   * The banking contribution is clamped at the kerb edge: past the corridor
   * the land is horizontal, so extrapolating a 20° plane out to the headland
   * (which would put the cliff top 40 m in the air) is exactly wrong.
   */
  private surfaceY(i: number, L: number, sOff: number): number {
    const cl = this.cl;
    const edge = cl.half[i] + KERB_W;
    const Lc = Math.max(-edge, Math.min(edge, L));
    return cl.py[i] + cl.ty[i] * sOff + cl.by[i] * Lc + this.crossOffset(i, L);
  }

  /** World point of the drivable/terrain surface at station i, lateral L. */
  crossPoint(i: number, L: number, out: THREE.Vector3): THREE.Vector3 {
    const cl = this.cl;
    const edge = cl.half[i] + KERB_W;
    const Lc = Math.max(-edge, Math.min(edge, L));
    const ex = L - Lc;
    out.set(
      cl.px[i] + cl.bx[i] * Lc + cl.hx[i] * ex,
      cl.py[i] + cl.by[i] * Lc + cl.hy[i] * ex,
      cl.pz[i] + cl.bz[i] * Lc + cl.hz[i] * ex,
    );
    out.y += this.crossOffset(i, L);
    return out;
  }

  /** Rock/soil detail displacement at a surface point, shared with probe(). */
  detailAt(i: number, L: number, x: number, z: number): number {
    const cl = this.cl;
    const q = Math.abs(L) - cl.half[i] - KERB_W;
    if (q <= 3) return 0;
    const rock = L < 0 ? cl.rockL[i] : cl.rockR[i];
    return terrainDetail(x, z, q, rock);
  }

  // =======================================================================
  //  Station lookup
  // =======================================================================

  private buildAccel() {
    const cl = this.cl;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < cl.count; i++) {
      if (cl.px[i] < minx) minx = cl.px[i];
      if (cl.px[i] > maxx) maxx = cl.px[i];
      if (cl.pz[i] < minz) minz = cl.pz[i];
      if (cl.pz[i] > maxz) maxz = cl.pz[i];
    }
    this.gX0 = minx - this.gCell;
    this.gZ0 = minz - this.gCell;
    this.gW = Math.ceil((maxx - minx) / this.gCell) + 3;
    this.gH = Math.ceil((maxz - minz) / this.gCell) + 3;
    const tmp: number[][] = new Array(this.gW * this.gH);
    // one candidate per metre is ample: the bucket only nominates a seed,
    // the refine pass does the rest
    const step = Math.max(1, Math.round(1 / cl.ds));
    for (let i = 0; i < cl.count; i += step) {
      const cx = Math.floor((cl.px[i] - this.gX0) / this.gCell);
      const cz = Math.floor((cl.pz[i] - this.gZ0) / this.gCell);
      const k = cz * this.gW + cx;
      (tmp[k] || (tmp[k] = [])).push(i);
    }
    this.buckets = new Array(this.gW * this.gH);
    for (let k = 0; k < tmp.length; k++) if (tmp[k]) this.buckets[k] = Int32Array.from(tmp[k]);
  }

  /** Nearest station to (x,z) — global, grid accelerated. */
  nearestStation(x: number, z: number): number {
    const cl = this.cl;
    let best = -1, bestD = Infinity;
    const cx = Math.floor((x - this.gX0) / this.gCell);
    const cz = Math.floor((z - this.gZ0) / this.gCell);
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const zz = cz + dz;
        if (zz < 0 || zz >= this.gH) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= this.gW) continue;
          const b = this.buckets[zz * this.gW + xx];
          if (!b) continue;
          for (let n = 0; n < b.length; n++) {
            const i = b[n];
            const ex = cl.px[i] - x, ez = cl.pz[i] - z;
            const d = ex * ex + ez * ez;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    if (best < 0) {
      // far outside the circuit (open sea, distant headland): strided sweep
      for (let i = 0; i < cl.count; i += 8) {
        const ex = cl.px[i] - x, ez = cl.pz[i] - z;
        const d = ex * ex + ez * ez;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return this.refineStation(x, z, best, 12);
  }

  private refineStation(x: number, z: number, seed: number, span: number): number {
    const cl = this.cl, n = cl.count;
    let best = seed, bestD = Infinity;
    for (let k = -span; k <= span; k++) {
      const i = (seed + k + n) % n;
      const ex = cl.px[i] - x, ez = cl.pz[i] - z;
      const d = ex * ex + ez * ez;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Hot path. With a hint we sweep a ±45 m window of *progress*, coarse then
   * fine; without one we fall back to the grid. A hint that has gone stale
   * (respawn, or a shell launching somebody into the bay) is caught by the
   * distance sanity check and retried globally.
   */
  private findStation(x: number, z: number, hintT: number): number {
    const cl = this.cl, n = cl.count;
    if (hintT >= 0) {
      const centre = Math.floor((hintT - Math.floor(hintT)) * n) % n;
      const half = Math.min(n >> 1, Math.round(45 / cl.ds));
      let best = centre, bestD = Infinity;
      const stride = 8;
      for (let k = -half; k <= half; k += stride) {
        const i = (centre + k + n) % n;
        const ex = cl.px[i] - x, ez = cl.pz[i] - z;
        const d = ex * ex + ez * ez;
        if (d < bestD) { bestD = d; best = i; }
      }
      best = this.refineStation(x, z, best, stride);
      const ex = cl.px[best] - x, ez = cl.pz[best] - z;
      if (ex * ex + ez * ez < 160 * 160) return best;
    }
    return this.nearestStation(x, z);
  }

  // =======================================================================
  //  probe — called for every wheel of every kart, every frame
  // =======================================================================

  probe(p: THREE.Vector3, hintT: number): SurfaceProbe {
    const cl = this.cl;
    let i = this.findStation(p.x, p.z, hintT);
    this.probeAt = (this.probeAt + 1) & 15;
    const out = this.probePool[this.probeAt];

    let dx = p.x - cl.px[i], dy = p.y - cl.py[i], dz = p.z - cl.pz[i];
    // The arc projection has to be the full 3D dot: on a 20° banked corner the
    // road edge sits 4 m below the centreline, and dropping the vertical term
    // mis-places the point by most of a metre along the track.
    let sOff = dx * cl.tx[i] + dy * cl.ty[i] + dz * cl.tz[i];
    // findStation minimises horizontal distance, which is not quite the foot
    // of the perpendicular; one integer re-centring makes it exact.
    const shift = Math.round(sOff / cl.ds);
    if (shift !== 0) {
      i = (i + shift + cl.count) % cl.count;
      dx = p.x - cl.px[i]; dy = p.y - cl.py[i]; dz = p.z - cl.pz[i];
      sOff = dx * cl.tx[i] + dy * cl.ty[i] + dz * cl.tz[i];
    }
    const hw = cl.half[i];
    const edge = hw + KERB_W;

    // lateral runs along the banked binormal inside the corridor and along the
    // horizontal right outside it, matching how the surface is actually built
    let L = dx * cl.bx[i] + dy * cl.by[i] + dz * cl.bz[i];
    if (Math.abs(L) > edge) {
      const lh = dx * cl.hx[i] + dy * cl.hy[i] + dz * cl.hz[i];
      if (Math.abs(lh) > edge) L = lh;
    }

    let t = (i * cl.ds + sOff) / cl.length;
    t -= Math.floor(t);
    out.t = t;
    out.lateral = L;
    out.edgeRatio = Math.abs(L) / hw;

    const a = Math.abs(L);
    // Blend the two straddling stations. Without this, the frame is quantised
    // to half a station, which on the 20° banked entry is a 15 cm step at the
    // road edge — visible as wheels sinking into the apex kerb.
    const fi = i + sOff / cl.ds;
    const i0 = Math.floor(fi), fr = fi - i0;
    const s0 = ((i0 % cl.count) + cl.count) % cl.count;
    const s1 = (s0 + 1) % cl.count;
    const yA = this.surfaceY(s0, L, fr * cl.ds);
    let y = yA + (this.surfaceY(s1, L, (fr - 1) * cl.ds) - yA) * fr;

    let surf: Surface;
    if (a <= hw) {
      surf = Surface.Road;
      for (let b = 0; b < BOOST_PADS.length; b++) {
        const pad = BOOST_PADS[b];
        if (t >= pad.t0 && t <= pad.t1 && Math.abs(L - pad.lat) <= pad.hw) { surf = Surface.Boost; break; }
      }
      out.normal.set(cl.nx[i], cl.ny[i], cl.nz[i]);
    } else if (a <= edge) {
      surf = Surface.Road; // kerb: grippy, but the raised profile rattles you
      const sgn = L < 0 ? -1 : 1;
      const slope = (this.crossOffset(i, L + 0.12 * sgn) - this.crossOffset(i, L)) / (0.12 * sgn);
      this.slopeNormal(i, slope, out.normal);
    } else {
      const q = a - edge;
      const left = L < 0;
      const shoulder = left ? cl.shoulderL[i] : cl.shoulderR[i];
      surf = q <= shoulder ? (left ? cl.surfL[i] : cl.surfR[i]) as Surface : Surface.OffTrack;
      // far field: hand over to the smoothed macro heightfield so the ridge
      // where two opposite sides of the circuit meet reads as landscape
      // rather than as a seam between two cross-sections
      const blend = ss(26, 34, q);
      if (blend > 0) y += (this.sampleHeightfield(p.x, p.z) - y) * blend;
      y += this.detailAt(i, L, p.x, p.z);
      const sgn = left ? -1 : 1;
      const s2 = (this.crossOffset(i, L + 0.9 * sgn) - this.crossOffset(i, L)) / (0.9 * sgn);
      this.slopeNormal(i, s2, out.normal);
    }

    if (y < SEA_Y) {
      y = SEA_Y;
      surf = Surface.Water;
      out.normal.set(0, 1, 0);
    }
    out.y = y;
    out.surface = surf;
    return out;
  }

  /** Ground normal for a surface tilted by `slope` (dy/dLateral) at station i. */
  private slopeNormal(i: number, slope: number, out: THREE.Vector3) {
    const cl = this.cl;
    _v.set(cl.hx[i], cl.hy[i] + slope, cl.hz[i]).normalize();
    _v2.set(cl.tx[i], cl.ty[i], cl.tz[i]);
    out.crossVectors(_v, _v2).normalize();
    if (out.y < 0) out.negate();
  }

  // =======================================================================
  //  Walls
  // =======================================================================

  collideWalls(p: THREE.Vector3, radius: number, hintT: number) {
    const cl = this.cl;
    const i = this.findStation(p.x, p.z, hintT);
    const dx = p.x - cl.px[i], dy = p.y - cl.py[i], dz = p.z - cl.pz[i];
    const L = dx * cl.hx[i] + dy * cl.hy[i] + dz * cl.hz[i];
    const hw = cl.half[i];

    for (let s = 0; s < 2; s++) {
      const left = s === 0;
      const type = left ? cl.wallL[i] : cl.wallR[i];
      if (type === WALL_NONE) continue;
      const off = left ? cl.wallOffL[i] : cl.wallOffR[i];
      const wallL = hw + off;
      const side = left ? -1 : 1;
      const pen = radius - (wallL - side * L);
      if (pen <= 0) continue;
      // a kart that has cleared the top of the barrier is not colliding.
      // Take the foot height through crossPoint so banked sections, where the
      // surface has already unbanked past the kerb, agree with the geometry.
      const footY = this.crossPoint(i, side * wallL, _v).y;
      if (p.y > footY + WALL_HEIGHT[type]) continue;
      this.wallAt = (this.wallAt + 1) & 7;
      const r = this.wallPool[this.wallAt];
      r.normal.set(cl.hx[i], 0, cl.hz[i]).normalize().multiplyScalar(-side);
      r.push.copy(r.normal).multiplyScalar(pen);
      return r;
    }
    return null;
  }

  // =======================================================================
  //  Macro heightfield
  // =======================================================================

  private buildHeightfield() {
    const cl = this.cl;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < cl.count; i++) {
      if (cl.px[i] < minx) minx = cl.px[i];
      if (cl.px[i] > maxx) maxx = cl.px[i];
      if (cl.pz[i] < minz) minz = cl.pz[i];
      if (cl.pz[i] > maxz) maxz = cl.pz[i];
    }
    const pad = 330;
    this.hmX0 = minx - pad; this.hmZ0 = minz - pad;
    this.hmW = Math.ceil((maxx - minx + pad * 2) / this.hmCell) + 1;
    this.hmH = Math.ceil((maxz - minz + pad * 2) / this.hmCell) + 1;
    const w = this.hmW, h = this.hmH;
    const hm = this.hm = new Float32Array(w * h);
    const q = this.hmQ = new Float32Array(w * h);

    for (let jz = 0; jz < h; jz++) {
      const z = this.hmZ0 + jz * this.hmCell;
      for (let ix = 0; ix < w; ix++) {
        const x = this.hmX0 + ix * this.hmCell;
        const i = this.nearestStation(x, z);
        const dx = x - cl.px[i], dz = z - cl.pz[i];
        const L = dx * cl.hx[i] + dz * cl.hz[i];
        const k = jz * w + ix;
        q[k] = Math.max(0, Math.abs(L) - cl.half[i] - KERB_W);
        hm[k] = this.surfaceY(i, L, dx * cl.tx[i] + dz * cl.tz[i]);
      }
    }

    // Blur the far field only. Near the road the authored profile is law; far
    // out, the crease where two opposite sides of the circuit meet has to
    // relax into a hillside instead of a knife edge.
    const tmp = new Float32Array(w * h);
    for (let pass = 0; pass < 4; pass++) {
      for (let jz = 0; jz < h; jz++) {
        for (let ix = 0; ix < w; ix++) {
          const k = jz * w + ix;
          let acc = 0, n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = jz + dz; if (zz < 0 || zz >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = ix + dx; if (xx < 0 || xx >= w) continue;
              acc += hm[zz * w + xx]; n++;
            }
          }
          tmp[k] = hm[k] + (acc / n - hm[k]) * ss(30, 70, q[k]);
        }
      }
      hm.set(tmp);
    }
  }

  /** Bilinear macro height (no detail noise) at a world XZ. */
  sampleHeightfield(x: number, z: number): number {
    const w = this.hmW, h = this.hmH;
    const fx = (x - this.hmX0) / this.hmCell;
    const fz = (z - this.hmZ0) / this.hmCell;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0) ix = 0; else if (ix > w - 2) ix = w - 2;
    if (iz < 0) iz = 0; else if (iz > h - 2) iz = h - 2;
    const u = Math.min(1, Math.max(0, fx - ix)), v = Math.min(1, Math.max(0, fz - iz));
    const hm = this.hm;
    const top = hm[iz * w + ix] + (hm[iz * w + ix + 1] - hm[iz * w + ix]) * u;
    const bot = hm[(iz + 1) * w + ix] + (hm[(iz + 1) * w + ix + 1] - hm[(iz + 1) * w + ix]) * u;
    return top + (bot - top) * v;
  }

  /**
   * Full ground height at an arbitrary world XZ, used by the terrain mesh.
   * Identical maths to probe()'s off-road branch — the two are not allowed to
   * disagree, or terrain pokes through the road.
   */
  groundAt(x: number, z: number): number {
    const cl = this.cl;
    const i = this.nearestStation(x, z);
    const dx = x - cl.px[i], dz = z - cl.pz[i];
    const L = dx * cl.hx[i] + dz * cl.hz[i];
    let y = this.surfaceY(i, L, dx * cl.tx[i] + dz * cl.tz[i]);
    const q = Math.abs(L) - cl.half[i] - KERB_W;
    const blend = ss(26, 34, q);
    if (blend > 0) y += (this.sampleHeightfield(x, z) - y) * blend;
    return y + this.detailAt(i, L, x, z);
  }

  /** Signed lateral offset (horizontal) of a world XZ from the centreline. */
  lateralAt(x: number, z: number): number {
    const cl = this.cl;
    const i = this.nearestStation(x, z);
    return (x - cl.px[i]) * cl.hx[i] + (z - cl.pz[i]) * cl.hz[i];
  }

  /** Rockiness 0..1 at a world XZ, for terrain vertex colouring. */
  rockAt(x: number, z: number): number {
    const cl = this.cl;
    const i = this.nearestStation(x, z);
    const L = (x - cl.px[i]) * cl.hx[i] + (z - cl.pz[i]) * cl.hz[i];
    return L < 0 ? cl.rockL[i] : cl.rockR[i];
  }

  // =======================================================================
  //  Start grid + bounds
  // =======================================================================

  /**
   * Two abreast with the outside car of each row set back — the classic
   * staggered arcade grid. Pole sits on the inside of turn one (a left).
   *
   * The slot geometry comes from `gridSlot()` rather than being written out
   * here, because `buildMarkings` paints the boxes these karts stand in and the
   * start-line checker scrubs its paint thin in the corridors they launch down.
   * Three copies of `11 + row * 8.5 + col * 4.2` is how round 3 ended up with
   * karts standing beside their boxes rather than on them.
   *
   * The lateral offset is now a fixed 3.2 m instead of `min(5.4, half * 0.46)`.
   * Scaling it with the road width was the wrong instinct twice over: it made
   * the grid as wide as whatever the road happened to be — 5.4 m apart on the
   * old 26 m road, which is why the field never read as a pack — and it meant
   * the painted boxes (which used a hard-coded 5.0) and the karts drifted apart
   * the moment the width schedule moved. A grid slot is a fixed physical thing.
   * All we owe the road is a check that it fits.
   */
  private buildStartGrid() {
    const cl = this.cl;
    const tmp = makeSample();
    for (let k = 0; k < 8; k++) {
      const { back, lat: rawLat } = gridSlot(k);
      const d = ((-back % cl.length) + cl.length) % cl.length;
      const s = this.sampleByDistance(d, tmp);
      const i = Math.round((d / cl.length) * cl.count) % cl.count;
      // 1.6 m of kart half-width plus a metre of margin has to fit inside the
      // road proper; the start straight carries 8.8 m so this never bites, but
      // it is the guard that stops a future width edit clipping karts into kerbs
      const room = Math.max(1.2, cl.half[i] - 2.6);
      const lat = Math.sign(rawLat) * Math.min(GRID_LAT, room);
      const pos = new THREE.Vector3();
      this.crossPoint(i, lat, pos);
      pos.y += 0.45;
      this.startGrid.push({ pos, yaw: Math.atan2(s.tangent.x, s.tangent.z) });
    }
  }

  private computeBounds() {
    const cl = this.cl;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (let i = 0; i < cl.count; i += 4) {
      for (let s = -1; s <= 1; s += 2) {
        this.crossPoint(i, s * (cl.half[i] + KERB_W + SKIRT_W), p);
        min.min(p); max.max(p);
      }
    }
    min.y = Math.min(min.y, SEA_Y - 2);
    max.y += 60; // the headland and cliff mass sit well above the road
    this.bounds.set(min, max);
  }

  /**
   * Where a read-ahead landmark for corner `c` belongs, in world space.
   *
   * `out` lands on the ground `off` metres outside the kerb, `ahead` metres past
   * the mark point — i.e. on the *exit* of the corner, on the *outside*, which
   * is the sightline a driver on the entry is already looking down. That is the
   * position a Nintendo course puts its arch, its windmill or its lighthouse,
   * and the reason those read as navigation rather than as decoration.
   *
   * Returns the outward horizontal direction as well, so a caller can face the
   * landmark back at the road without recomputing the frame.
   */
  landmarkAnchor(c: Corner, out: THREE.Vector3, outward?: THREE.Vector3,
    ahead = 55, off = 9): THREE.Vector3 {
    const cl = this.cl;
    const d = ((c.d + ahead) % cl.length + cl.length) % cl.length;
    const i = Math.floor(d / cl.ds) % cl.count;
    const side = -c.sign;   // the outside of the turn
    const lat = side * (cl.half[i] + KERB_W + off);
    this.crossPoint(i, lat, out);
    out.y = this.groundAt(out.x, out.z);
    if (outward) outward.set(cl.hx[i] * side, 0, cl.hz[i] * side).normalize();
    return out;
  }

  /** Zone id at a normalised progress — used by the geometry builder. */
  zoneAt(t: number): number {
    const i = Math.floor((t - Math.floor(t)) * this.cl.count) % this.cl.count;
    return this.cl.zone[i];
  }

  /** Called by TrackGeometry so update() can stand down if scenery has a sea. */
  registerSea(m: THREE.Mesh) { this.seaMesh = m; }

  /** Materials TrackGeometry cloned; we keep their env map in step. */
  registerEnvClones(mats: THREE.MeshStandardMaterial[]) {
    this.envClones = mats;
    this.lastEnv = undefined;
  }
}

export { ZONES };
