import * as THREE from 'three';

/**
 * ============================================================================
 *  Trails — pooled camera-facing ribbons, one draw call for the lot.
 * ============================================================================
 *  Every trail in the game (boost plumes, shell wakes, star sparkle streaks)
 *  lives in a single interleaved vertex buffer with a pre-built index buffer.
 *  The CPU only ever writes the *spine*: position and tangent per sample. The
 *  ribbon is widened in the vertex shader along `cross(tangent, toCamera)`,
 *  which means the ribbon re-faces the camera correctly every frame — including
 *  when the camera orbits a stationary kart — without touching the buffer.
 *
 *  A trail is a fixed-length ring of spine samples. Releasing one does not
 *  free it immediately: it stops being fed and fades out over `fade` seconds,
 *  so a boost ending never snaps the ribbon off mid-air.
 * ============================================================================
 */

/** spine samples per trail — 26 gives a smooth arc at 30 m/s with 0.35 m steps */
const SEG = 26;
/** floats per vertex: pos3 + tangent3 + side1 + u1 + width1 + rgba4 */
const VSTRIDE = 13;

const _t = new THREE.Vector3();

const VERT = /* glsl */ `
uniform vec2 uNearFade;  // x: fully faded at this camera distance, y: fully opaque

attribute vec3 aTangent;
attribute vec3 aParam;   // x: side (-1..1), y: u along trail (0 head..1 tail), z: half-width
attribute vec4 aColor;

varying vec4 vColor;
varying float vU;
varying float vSide;
varying float vNear;

void main() {
  vec3 P = position;
  vec3 T = aTangent;
  float tl = length(T);
  T = tl > 1e-5 ? T / tl : vec3(0.0, 0.0, 1.0);
  vec3 toCam = cameraPosition - P;
  // A boost ribbon is laid down BEHIND the kart and the chase camera sits
  // behind the kart too, so the tail of the ribbon sweeps through the lens
  // every single frame. Perspective then blows a 0.6 m wide strip into a
  // frame-height slab of flat colour. Fade it out before it gets there — a
  // ribbon inside ~1.5 m of the eye carries no information anyway.
  vNear = smoothstep(uNearFade.x, uNearFade.y, length(toCam));

  vec3 S = cross(T, toCam);
  float sl = length(S);
  // Degenerate when the ribbon points straight at the camera; fall back to the
  // camera's right vector so it never collapses to an invisible sliver.
  S = sl > 1e-4 ? S / sl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  P += S * (aParam.x * aParam.z);

  vColor = aColor;
  vU = aParam.y;
  vSide = aParam.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uGain;
/**
 * Per-fragment additive shoulder, matching the one in Particles. A ribbon is
 * a long thin quad and a kart doubling back on its own boost trail — or two
 * karts side by side in the tunnel — puts several of them through the same
 * pixel. rgb / (1 + rgb * uClip) is monotonic, asymptotes at 1/uClip and never
 * dims a single ribbon enough to notice, so the stack cannot run away.
 */
uniform float uClip;
varying vec4 vColor;
varying float vU;
varying float vSide;
varying float vNear;

void main() {
  float edge = 1.0 - abs(vSide);
  if (edge <= 0.0) discard;
  // Soft feathered edges plus a length taper: the ribbon must never show a
  // hard rectangular border, that is the classic bad-trail tell. The taper is
  // steep so the ribbon is essentially gone by two thirds of its length, which
  // also keeps its world-space read short.
  float a = vColor.a * pow(edge, 0.65) * pow(1.0 - vU, 2.4) * vNear;
  if (a < 0.004) discard;
  vec3 rgb = vColor.rgb * uGain;
  // Compress the MAX CHANNEL and scale all three by the same factor. Per-channel
  // Reinhard squeezes the strongest channel hardest, so a saturated ribbon
  // desaturates as it brightens and two crossing ribbons meet in white — which
  // is the one thing an additive shoulder exists to prevent. Same curve, same
  // 1/uClip asymptote, hue untouched.
  float mxc = max(max(rgb.r, rgb.g), rgb.b);
  rgb *= mxc > 1e-4 ? 1.0 / (1.0 + mxc * uClip) : 1.0;
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Slot {
  active: boolean;
  /** still fading after release */
  dying: boolean;
  fadeT: number;
  fade: number;
  count: number;
  /** SEG * 3 spine positions, newest at index 0 */
  spine: Float32Array;
  width: number;
  r: number; g: number; b: number; a: number;
  minStep: number;
  /** hard world-space length cap, metres */
  maxLen: number;
  dirty: boolean;
}

export class Trails {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly buffer: THREE.InterleavedBuffer;
  private readonly data: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private readonly slots: Slot[] = [];
  private lo = Infinity;
  private hi = -Infinity;

  constructor(readonly capacity: number, additive: boolean) {
    const verts = capacity * SEG * 2;
    this.data = new Float32Array(verts * VSTRIDE);
    this.buffer = new THREE.InterleavedBuffer(this.data, VSTRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    this.geo.setAttribute('aTangent', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    this.geo.setAttribute('aParam', new THREE.InterleavedBufferAttribute(this.buffer, 3, 6));
    this.geo.setAttribute('aColor', new THREE.InterleavedBufferAttribute(this.buffer, 4, 9));

    const idx = new Uint16Array(capacity * (SEG - 1) * 6);
    let k = 0;
    for (let t = 0; t < capacity; t++) {
      const base = t * SEG * 2;
      for (let i = 0; i < SEG - 1; i++) {
        const a = base + i * 2;
        idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + 2;
        idx[k++] = a + 1; idx[k++] = a + 3; idx[k++] = a + 2;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uGain: { value: 1 },
        // 1.1 -> 3.2 m, in from 1.5 -> 4.5.
        //
        // The 4.5 m outer edge was sized against a boost ribbon that ran five
        // metres behind the kart and swept the lens. That ribbon is gone: it is
        // capped at 3.4 m of world length now and its head is welded to the
        // exhaust stacks, so the FAR end of it sits about 4-6 m from a chase
        // camera that itself surges in to ~4.5 m under boost — which is to say
        // the entire ribbon lived inside the old fade window and the payoff's
        // heat spine was being multiplied by roughly a third for the whole of
        // every boost. The near edge is what protects the lens, and 1.1 m is
        // still well outside anything the rig can reach.
        uNearFade: { value: new THREE.Vector2(1.1, 3.2) },
        // Only the additive pool needs a shoulder; an alpha-blended ribbon
        // cannot sum past its own colour.
        uClip: { value: additive ? 0.13 : 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'fx-trails';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 11;
    // Nothing is live at construction, and `update` owns this from here on.
    // See the live-window note there: an idle pool must issue no draw at all.
    this.mesh.visible = false;
    this.geo.setDrawRange(0, 0);

    for (let i = 0; i < capacity; i++) {
      this.slots.push({
        active: false, dying: false, fadeT: 0, fade: 0.25, count: 0,
        spine: new Float32Array(SEG * 3), width: 0.2,
        r: 1, g: 1, b: 1, a: 1, minStep: 0.3, maxLen: 8, dirty: false,
      });
      this.clearSlot(i);
    }
  }

  set gain(v: number) { this.material.uniforms.uGain.value = v; }

  /**
   * Grab a trail. Returns -1 when the pool is exhausted (never throws).
   *
   * `maxLen` is a hard world-space length cap and it is NOT implied by
   * `minStep`: minStep is a floor on how far the head must move to consume a
   * segment, so at 25 m/s a 26-sample ribbon spans ~11 m however small minStep
   * is. That is far enough behind a chase camera for the tail to sweep through
   * the lens, which is what turned the boost ribbon into a screen-filling slab.
   */
  acquire(width: number, color: THREE.Color, intensity: number, alpha: number,
          minStep = 0.32, fade = 0.28, maxLen = 8): number {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active || s.dying) continue;
      s.active = true; s.dying = false; s.fadeT = 0; s.fade = fade;
      s.count = 0; s.width = width; s.minStep = minStep; s.maxLen = Math.max(0.5, maxLen);
      s.r = color.r * intensity; s.g = color.g * intensity; s.b = color.b * intensity; s.a = alpha;
      return i;
    }
    return -1;
  }

  /** Stop feeding a trail; it fades out and returns itself to the pool. */
  release(h: number) {
    if (h < 0 || h >= this.slots.length) return;
    const s = this.slots[h];
    if (!s.active) return;
    s.active = false;
    s.dying = true;
    s.fadeT = 0;
  }

  isLive(h: number) { return h >= 0 && h < this.slots.length && (this.slots[h].active || this.slots[h].dying); }

  /**
   * Feed the trail head. Samples closer together than `minStep` slide the
   * existing head instead of consuming a segment, so a stopped emitter does
   * not eat the whole ribbon.
   */
  push(h: number, x: number, y: number, z: number) {
    if (h < 0 || h >= this.slots.length) return;
    const s = this.slots[h];
    if (!s.active) return;
    const sp = s.spine;
    if (s.count === 0) {
      for (let i = 0; i < SEG; i++) { sp[i * 3] = x; sp[i * 3 + 1] = y; sp[i * 3 + 2] = z; }
      s.count = 1;
    } else {
      const dx = x - sp[0], dy = y - sp[1], dz = z - sp[2];
      if (dx * dx + dy * dy + dz * dz < s.minStep * s.minStep) {
        sp[0] = x; sp[1] = y; sp[2] = z;
      } else {
        sp.copyWithin(3, 0, (SEG - 1) * 3);
        sp[0] = x; sp[1] = y; sp[2] = z;
        if (s.count < SEG) s.count++;
      }
    }
    s.dirty = true;
  }

  private clearSlot(h: number) {
    const base = h * SEG * 2 * VSTRIDE;
    const d = this.data;
    for (let i = 0; i < SEG * 2; i++) {
      const o = base + i * VSTRIDE;
      d[o] = d[o + 1] = d[o + 2] = 0;
      d[o + 3] = 0; d[o + 4] = 0; d[o + 5] = 1;
      d[o + 6] = 0; d[o + 7] = 1; d[o + 8] = 0; // zero width => degenerate
      d[o + 9] = d[o + 10] = d[o + 11] = 0; d[o + 12] = 0;
    }
    this.mark(h);
  }

  private mark(h: number) {
    if (h < this.lo) this.lo = h;
    if (h > this.hi) this.hi = h;
  }

  private rebuild(h: number) {
    const s = this.slots[h];
    const sp = s.spine;
    const d = this.data;
    const base = h * SEG * 2 * VSTRIDE;
    const alpha = s.a * (s.dying ? Math.max(0, 1 - s.fadeT / s.fade) : 1);
    const n = s.count;

    let arc = 0;
    let ax = sp[0], ay = sp[1], az = sp[2];

    for (let i = 0; i < SEG; i++) {
      // Samples beyond the live count clamp onto the tail so the ribbon grows
      // out of a point instead of springing into existence at full length.
      const si = Math.min(i, Math.max(0, n - 1)) * 3;
      const px = sp[si], py = sp[si + 1], pz = sp[si + 2];

      const pi = Math.max(0, Math.min(i - 1, n - 1)) * 3;
      const ni = Math.max(0, Math.min(i + 1, n - 1)) * 3;
      _t.set(sp[pi] - sp[ni], sp[pi + 1] - sp[ni + 1], sp[pi + 2] - sp[ni + 2]);
      if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1);

      const dx = px - ax, dy = py - ay, dz = pz - az;
      arc += Math.sqrt(dx * dx + dy * dy + dz * dz);
      ax = px; ay = py; az = pz;

      // Taper by whichever runs out first: the sample count, or the world-space
      // length budget. The second term is what makes the ribbon a fixed length
      // in metres instead of a fixed length in frames.
      const u = Math.max(i / (SEG - 1), Math.min(1, arc / s.maxLen));
      // Width tapers to a point; a slight bulge just behind the head reads as
      // pressure rather than a flat strip.
      const halfW = s.width * 0.5 * (1 - u) * (0.62 + 0.38 * Math.sin(Math.min(1, u * 3.2) * Math.PI * 0.5));
      const live = i < n ? 1 : 0;

      for (let k = 0; k < 2; k++) {
        const o = base + (i * 2 + k) * VSTRIDE;
        d[o] = px; d[o + 1] = py; d[o + 2] = pz;
        d[o + 3] = _t.x; d[o + 4] = _t.y; d[o + 5] = _t.z;
        d[o + 6] = k === 0 ? -1 : 1;
        d[o + 7] = u;
        d[o + 8] = halfW * live;
        d[o + 9] = s.r; d[o + 10] = s.g; d[o + 11] = s.b; d[o + 12] = alpha;
      }
    }
    this.mark(h);
  }

  update(dt: number) {
    // Live window over the slot ring, in the same spirit as the ones Rings,
    // Plumes, Particles and Decals already keep — this pool was the only one
    // without it, and it is the only one whose geometry is NOT instanced, so
    // there was no `instanceCount = 0` to fall back on. The mesh is
    // `frustumCulled = false` with a 1e6 bounding sphere, so a pool with
    // nothing in it still issued a real drawElements of every slot: 832
    // vertices and 800 degenerate triangles through an additive, double-sided,
    // depth-write-off state, on every frame of the race.
    //
    // Trails are boost plumes and shell wakes. They are absent for most of a
    // lap and, when present, occupy the first slot or two — `acquire` scans
    // from zero — so a span rather than a flag is worth the two comparisons:
    // the live boost ribbon draws 50 triangles instead of 800.
    let live = -1;
    let first = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.dying) {
        s.fadeT += dt;
        if (s.fadeT >= s.fade) { s.dying = false; s.count = 0; this.clearSlot(i); continue; }
        this.rebuild(i);
      } else if (s.active && s.dirty) {
        this.rebuild(i);
        s.dirty = false;
      }
      if (s.active || s.dying) { if (first < 0) first = i; live = i; }
    }

    // A slot that has just finished dying was cleared to degenerate vertices
    // above, so shrinking the window past it cannot leave stale geometry on
    // screen — the clear and the range collapse in the same frame.
    const perSlot = (SEG - 1) * 6;
    if (first < 0) {
      this.mesh.visible = false;
      this.geo.setDrawRange(0, 0);
    } else {
      this.mesh.visible = true;
      this.geo.setDrawRange(first * perSlot, (live - first + 1) * perSlot);
    }

    if (this.hi >= this.lo) {
      const per = SEG * 2 * VSTRIDE;
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.lo * per, (this.hi - this.lo + 1) * per);
      this.buffer.needsUpdate = true;
      this.lo = Infinity; this.hi = -Infinity;
    }
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}
