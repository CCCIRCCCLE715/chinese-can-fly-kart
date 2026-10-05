/**
 * ============================================================================
 *  PROJECTILES — shells, bananas, bob-ombs, and the toolkit that draws them
 * ============================================================================
 *  Everything here is procedural: the shells are solids of revolution with a
 *  painted albedo/roughness/normal set, the bananas are a tapered swept tube,
 *  and the blasts are pooled additive shells. No file is loaded and nothing is
 *  allocated once `init` has run.
 *
 *  Projectiles are simulated against the same track the karts drive on: they
 *  ride the surface returned by `probe` (so they follow elevation AND banking),
 *  they bounce off `collideWalls`, and they hit karts through the sanctioned
 *  `spinOut` / `launch` commands plus a `hit` event so VFX and audio answer.
 *
 *  The texture kit and the lathe/tube builders are exported because Items.ts
 *  draws its boxes and its carried items from exactly the same well — one
 *  visual language for every object the item system puts on screen.
 * ============================================================================
 */
import * as THREE from 'three';
import { ItemKind, Quality, Surface, type Ctx, type IKart } from '../types';
import { registerPrewarm } from '../core/Prewarm';
import type { HazardLike, RacingLine } from './AI';

// =============================================================================
//  Procedural texture kit
// =============================================================================

export interface Pad {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  size: number;
}

export function pad(size: number): Pad {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  return { c, g, size };
}

export function padTexture(p: Pad, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(p.c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a height field into a tangent-space normal map. Wraps in u (these are
 * all bodies of revolution) and clamps in v, matching the geometry's UVs.
 */
export function normalFromHeight(h: Float32Array, size: number, strength: number): THREE.DataTexture {
  const px = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => {
    const xx = ((x % size) + size) % size;
    const yy = y < 0 ? 0 : y >= size ? size - 1 : y;
    return h[yy * size + xx];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv; ny *= inv;
      const i = (y * size + x) * 4;
      px[i] = Math.round((nx * 0.5 + 0.5) * 255);
      px[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      px[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      px[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  // DataTexture defaults to NearestFilter with no mips. On a body of revolution
  // spinning past the camera that is a normal map that crawls and sparkles at
  // every distance — the aliasing tell art bible §9.6 rules out — and it is a
  // one-line fix that costs a third of a small texture.
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Radial falloff sprite, used for glows and the ground blobs. */
export function radialSprite(size: number, inner: number, gamma: number): THREE.CanvasTexture {
  const p = pad(size);
  const img = p.g.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.hypot(dx, dy);
      let a = 1 - Math.max(0, (r - inner) / Math.max(1e-3, 1 - inner));
      a = Math.pow(Math.max(0, Math.min(1, a)), gamma);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  p.g.putImageData(img, 0, 0);
  const t = padTexture(p, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// =============================================================================
//  Geometry builders
// =============================================================================

/**
 * Solid of revolution from a profile in (radius, height). Every profile below
 * carries a deliberate chamfer at its silhouette edges — a hard 90° lip catches
 * no specular and is the fastest way to make a procedural prop look untouched.
 */
export function lathe(profile: number[][], segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (const [r, y] of profile) pts.push(new THREE.Vector2(Math.max(1e-4, r), y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return g;
}

/**
 * A crescent tube: a banana. Swept along a circular arc with a radius that
 * tapers to a point at both tips, so the ends read as stem and nub rather than
 * as two cut-off cylinders.
 */
export function crescent(arc: number, sweepR: number, tubeR: number, nj: number, ni: number) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const nx = new THREE.Vector3();
  const bn = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  for (let j = 0; j <= nj; j++) {
    const u = j / nj;
    const a = -arc * 0.5 + arc * u;
    c.set(Math.sin(a) * sweepR, Math.cos(a) * sweepR - sweepR * 0.86, 0);
    tan.set(Math.cos(a), -Math.sin(a), 0).normalize();
    nx.crossVectors(tan, up).normalize();
    bn.crossVectors(nx, tan).normalize();
    // fat in the middle, pinched at both tips, with a slight belly droop
    const taper = Math.pow(Math.sin(Math.PI * u), 0.45);
    const r = tubeR * (0.30 + 0.70 * taper);
    for (let i = 0; i <= ni; i++) {
      const v = i / ni;
      const th = v * Math.PI * 2;
      const cx = Math.cos(th), sy = Math.sin(th);
      // slightly elliptical section: a banana is not a hose
      const px = nx.x * cx * r * 1.0 + bn.x * sy * r * 0.82;
      const py = nx.y * cx * r * 1.0 + bn.y * sy * r * 0.82;
      const pz = nx.z * cx * r * 1.0 + bn.z * sy * r * 0.82;
      pos.push(c.x + px, c.y + py, c.z + pz);
      const l = Math.hypot(px, py, pz) || 1;
      nrm.push(px / l, py / l, pz / l);
      uv.push(v, u);
    }
  }
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      const a = j * (ni + 1) + i;
      const b = a + ni + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Box with rounded edges. A subdivided cube pushed onto the offset surface of
 * its own inner core — cheap, exact, and it gives every edge a highlight.
 */
export function roundedBox(size: number, radius: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  const p = g.attributes.position as THREE.BufferAttribute;
  const h = size * 0.5;
  const core = h - radius;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = Math.max(-core, Math.min(core, v.x));
    const cy = Math.max(-core, Math.min(core, v.y));
    const cz = Math.max(-core, Math.min(core, v.z));
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) {
      const s = radius / l;
      p.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s);
    }
  }
  g.computeVertexNormals();
  return g;
}

// =============================================================================
//  Ground blobs — nothing in this game floats without one
// =============================================================================

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pos = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Tuning for one blob layer. The defaults are the contact shadow every dropped
 * item gets; passing an additive colour instead turns the same machinery into a
 * pool of bounced light, which is what an emissive pickup should be spilling
 * onto the tarmac under it.
 */
export interface BlobOptions {
  color?: number;
  opacity?: number;
  /** falloff exponent of the radial sprite — higher = tighter core */
  gamma?: number;
  /** flat centre fraction before the falloff starts */
  inner?: number;
  additive?: boolean;
  /** metres of lift off the ground, to clear z-fighting with the road */
  lift?: number;
  renderOrder?: number;
  name?: string;
  /** defaults off, matching the contact shadow this class was written for */
  toneMapped?: boolean;
}

export class BlobShadows {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly lift: number;

  constructor(private readonly max: number, opt: BlobOptions = {}) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: opt.color ?? 0x2a2230,   // warm-shadow tint; never pure black
      map: radialSprite(64, opt.inner ?? 0.05, opt.gamma ?? 1.55),
      transparent: true,
      opacity: opt.opacity ?? 0.44,
      depthWrite: false,
      blending: opt.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: opt.toneMapped ?? false,
    });
    this.lift = opt.lift ?? 0.045;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opt.renderOrder ?? 2;
    this.mesh.count = 0;
    this.mesh.name = opt.name ?? 'item-blob-shadows';
  }

  begin() { this.n = 0; }

  /** `width` is the full span of the blob in metres, not its radius. */
  add(x: number, y: number, z: number, normal: THREE.Vector3, width: number) {
    if (this.n >= this.max) return;
    _q.setFromUnitVectors(UP, normal);
    _pos.set(x, y + this.lift, z);
    _s.set(width, 1, width);
    _m.compose(_pos, _q, _s);
    this.mesh.setMatrixAt(this.n++, _m);
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// =============================================================================
//  Shared item art
// =============================================================================

const SHELL_PROFILE: number[][] = [
  [0.00, 0.300], [0.075, 0.294], [0.150, 0.276], [0.222, 0.243],
  [0.286, 0.196], [0.334, 0.136], [0.362, 0.076], [0.374, 0.030],
  [0.376, 0.004], [0.368, -0.022], [0.344, -0.052], [0.300, -0.078],
  [0.230, -0.098], [0.140, -0.109], [0.060, -0.113], [0.00, -0.114],
];

const BOMB_PROFILE: number[][] = [
  [0.000, 0.335], [0.062, 0.330], [0.108, 0.318], [0.128, 0.300],
  [0.112, 0.286], [0.150, 0.262], [0.216, 0.216], [0.268, 0.150],
  [0.296, 0.070], [0.300, 0.000], [0.288, -0.078], [0.246, -0.150],
  [0.180, -0.204], [0.100, -0.234], [0.040, -0.244], [0.000, -0.246],
];

const MUSH_PROFILE: number[][] = [
  [0.000, 0.300], [0.086, 0.294], [0.166, 0.272], [0.234, 0.232],
  [0.278, 0.174], [0.296, 0.116], [0.298, 0.082], [0.286, 0.062],
  [0.240, 0.052], [0.170, 0.048], [0.150, 0.036], [0.140, -0.010],
  [0.152, -0.060], [0.170, -0.090], [0.120, -0.104], [0.000, -0.106],
];

interface MatSet {
  geo: THREE.BufferGeometry;
  mat: THREE.MeshPhysicalMaterial;
}

/** Painted shell: banded albedo, a spotted height field, spatially varying roughness. */
function shellArt(base: string, rim: string, spot: string, glow: number, S = 256): MatSet {
  const alb = pad(S);
  const rgh = pad(S);
  const g = alb.g;
  // v runs along the lathe profile: dome, then rim band, then belly
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0.00, base);
  grd.addColorStop(0.42, base);
  grd.addColorStop(0.52, rim);
  grd.addColorStop(0.62, '#f6ead2');
  grd.addColorStop(1.00, '#e4d3b6');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  // hex plates on the dome, wrapped in u
  const height = new Float32Array(S * S);
  const cells: [number, number, number][] = [];
  for (let row = 0; row < 4; row++) {
    const cols = 6;
    for (let col = 0; col < cols; col++) {
      const u = ((col + (row & 1 ? 0.5 : 0)) / cols) * S;
      const v = (0.06 + row * 0.105) * S;
      cells.push([u, v, S * (0.052 - row * 0.006)]);
    }
  }
  g.globalAlpha = 0.85;
  g.fillStyle = spot;
  for (const [u, v, r] of cells) {
    for (const off of [-S, 0, S]) {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.26;
        const x = u + off + Math.cos(a) * r;
        const y = v + Math.sin(a) * r * 0.82;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.fill();
    }
  }
  g.globalAlpha = 1;

  // a bright specular sheen band near the crown, so the lacquer reads
  const sh = g.createLinearGradient(0, 0, 0, S * 0.4);
  sh.addColorStop(0, 'rgba(255,255,255,0.30)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sh;
  g.fillRect(0, 0, S, S * 0.4);

  // height field: plates proud of the shell, rim groove recessed
  for (const [u, v, r] of cells) {
    for (const off of [-S, 0, S]) {
      const cx = u + off, cy = v;
      const r2 = r * r;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(S, cy + r); y++) {
        for (let x = Math.floor(cx - r); x < cx + r; x++) {
          const xx = ((x % S) + S) % S;
          const dx = x - cx, dy = (y - cy) / 0.82;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          height[y * S + xx] = Math.max(height[y * S + xx], 1 - Math.sqrt(d2 / r2));
        }
      }
    }
  }
  for (let y = Math.floor(S * 0.5); y < S * 0.56; y++) {
    for (let x = 0; x < S; x++) height[y * S + x] -= 0.6;
  }

  // roughness: polished dome, matte belly, a scuffed band where it lands
  const rg = rgh.g.createLinearGradient(0, 0, 0, S);
  rg.addColorStop(0.00, '#3a3a3a');
  rg.addColorStop(0.45, '#2e2e2e');
  rg.addColorStop(0.58, '#7a7a7a');
  rg.addColorStop(1.00, '#a8a8a8');
  rgh.g.fillStyle = rg;
  rgh.g.fillRect(0, 0, S, S);
  rgh.g.globalAlpha = 0.35;
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 1 + Math.random() * 5;
    rgh.g.fillStyle = Math.random() > 0.5 ? '#c8c8c8' : '#141414';
    rgh.g.beginPath();
    rgh.g.arc(x, y, r, 0, Math.PI * 2);
    rgh.g.fill();
  }
  rgh.g.globalAlpha = 1;

  const mat = new THREE.MeshPhysicalMaterial({
    map: padTexture(alb, true),
    roughnessMap: padTexture(rgh, false),
    normalMap: normalFromHeight(height, S, 2.4),
    normalScale: new THREE.Vector2(0.7, 0.7),
    metalness: 0.0,
    roughness: 1.0,
    clearcoat: 1,
    clearcoatRoughness: 0.07,
    emissive: new THREE.Color(base),
    emissiveIntensity: glow,
  });
  return { geo: lathe(SHELL_PROFILE, 30), mat };
}

function bananaArt(S = 128): MatSet {
  const alb = pad(S);
  const g = alb.g;
  // v runs along the sweep: brown stem, yellow body, brown nub
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0.00, '#6b4a24');
  grd.addColorStop(0.10, '#c99a34');
  grd.addColorStop(0.24, '#ffd447');
  grd.addColorStop(0.55, '#ffe173');
  grd.addColorStop(0.80, '#f3c53c');
  grd.addColorStop(0.94, '#a8752c');
  grd.addColorStop(1.00, '#5c3d1e');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // the two longitudinal ridges every banana has, plus a few freckles
  const height = new Float32Array(S * S);
  g.globalAlpha = 0.20;
  for (const u of [0.16, 0.5, 0.84]) {
    g.fillStyle = '#8a6522';
    g.fillRect(u * S - 1.5, 0, 3, S);
  }
  g.globalAlpha = 0.30;
  for (let i = 0; i < 40; i++) {
    g.fillStyle = '#7a5520';
    g.beginPath();
    g.arc(Math.random() * S, S * (0.2 + Math.random() * 0.6), 1 + Math.random() * 2, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      height[y * S + x] =
        Math.cos((u - 0.16) * Math.PI * 2) * 0.12 + Math.cos((u - 0.5) * Math.PI * 6) * 0.05;
    }
  }
  const rgh = pad(S);
  const rg = rgh.g.createLinearGradient(0, 0, 0, S);
  rg.addColorStop(0, '#8c8c8c');
  rg.addColorStop(0.5, '#4a4a4a');
  rg.addColorStop(1, '#8c8c8c');
  rgh.g.fillStyle = rg;
  rgh.g.fillRect(0, 0, S, S);

  const mat = new THREE.MeshPhysicalMaterial({
    map: padTexture(alb, true),
    roughnessMap: padTexture(rgh, false),
    normalMap: normalFromHeight(height, S, 1.6),
    normalScale: new THREE.Vector2(0.55, 0.55),
    metalness: 0,
    roughness: 1,
    clearcoat: 0.85,
    clearcoatRoughness: 0.16,
  });
  return { geo: crescent(2.3, 0.46, 0.145, 22, 12), mat };
}

function bombArt(S = 128): MatSet {
  const alb = pad(S);
  const g = alb.g;
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0.00, '#6a6f86');   // fuse cap, lighter so it reads
  grd.addColorStop(0.12, '#3a4360');
  grd.addColorStop(0.40, '#2b3350');
  grd.addColorStop(1.00, '#1d2440');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // cast-iron pitting
  const height = new Float32Array(S * S);
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * S;
    const y = S * (0.18 + Math.random() * 0.8);
    const r = 1 + Math.random() * 3;
    g.globalAlpha = 0.16;
    g.fillStyle = Math.random() > 0.5 ? '#0d1226' : '#57608a';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const px = ((Math.round(x + dx) % S) + S) % S;
        const py = Math.round(y + dy);
        if (py < 0 || py >= S) continue;
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        height[py * S + px] -= (1 - d) * 0.5;
      }
    }
  }
  g.globalAlpha = 1;
  const rgh = pad(S);
  rgh.g.fillStyle = '#5e5e5e';
  rgh.g.fillRect(0, 0, S, S);
  rgh.g.fillStyle = '#2a2a2a';
  rgh.g.fillRect(0, 0, S, S * 0.14);
  const mat = new THREE.MeshPhysicalMaterial({
    map: padTexture(alb, true),
    roughnessMap: padTexture(rgh, false),
    normalMap: normalFromHeight(height, S, 2.0),
    normalScale: new THREE.Vector2(0.8, 0.8),
    metalness: 0.55,
    roughness: 1,
    clearcoat: 0.4,
    clearcoatRoughness: 0.35,
  });
  return { geo: lathe(BOMB_PROFILE, 26), mat };
}

export function mushroomArt(cap: string, spot: string, S = 128): MatSet {
  const alb = pad(S);
  const g = alb.g;
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0.00, cap);
  grd.addColorStop(0.44, cap);
  grd.addColorStop(0.50, '#c8563f');
  grd.addColorStop(0.56, '#f6e6c8');
  grd.addColorStop(1.00, '#e8d3ac');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const height = new Float32Array(S * S);
  const spots: [number, number, number][] = [
    [0.12, 0.10, 0.075], [0.42, 0.07, 0.055], [0.68, 0.13, 0.07],
    [0.90, 0.09, 0.05], [0.26, 0.28, 0.085], [0.58, 0.30, 0.075], [0.84, 0.31, 0.06],
  ];
  g.fillStyle = spot;
  for (const [u, v, r] of spots) {
    for (const off of [-1, 0, 1]) {
      g.beginPath();
      g.ellipse((u + off) * S, v * S, r * S, r * S * 0.8, 0, 0, Math.PI * 2);
      g.fill();
      const cx = (u + off) * S, cy = v * S, rr = r * S;
      for (let y = Math.max(0, Math.floor(cy - rr)); y < Math.min(S, cy + rr); y++) {
        for (let x = Math.floor(cx - rr); x < cx + rr; x++) {
          const xx = ((x % S) + S) % S;
          const d = Math.hypot(x - cx, (y - cy) / 0.8) / rr;
          if (d > 1) continue;
          height[y * S + xx] = Math.max(height[y * S + xx], (1 - d) * 0.7);
        }
      }
    }
  }
  const rgh = pad(S);
  const rg = rgh.g.createLinearGradient(0, 0, 0, S);
  rg.addColorStop(0, '#3c3c3c');
  rg.addColorStop(0.5, '#585858');
  rg.addColorStop(1, '#9a9a9a');
  rgh.g.fillStyle = rg;
  rgh.g.fillRect(0, 0, S, S);
  const mat = new THREE.MeshPhysicalMaterial({
    map: padTexture(alb, true),
    roughnessMap: padTexture(rgh, false),
    normalMap: normalFromHeight(height, S, 1.8),
    normalScale: new THREE.Vector2(0.6, 0.6),
    metalness: 0,
    roughness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
  });
  return { geo: lathe(MUSH_PROFILE, 26), mat };
}

// =============================================================================
//  Projectile simulation
// =============================================================================

const SHELL_R = 0.42;
const GREEN_SPEED = 33;
const RED_SPEED = 37;
const BOMB_GRAVITY = 21;
const MAX_BOUNCES = 4;
const BLAST_RADIUS = 8.2;
const POOL = 16;

const enum PState { Free = 0, Carried = 1, Live = 2 }

interface Proj {
  /** its own slot in `pool`, so `spawn` never has to scan for it */
  index: number;
  kind: ItemKind;
  state: PState;
  owner: number;
  /** owner immunity — a dropped item must not immediately hit the dropper */
  ownerLock: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  up: THREE.Vector3;
  life: number;
  bounces: number;
  hintT: number;
  spin: number;
  scale: number;
  targetId: number;
  homing: boolean;
  mesh: THREE.Mesh;
}

interface Blast {
  t: number;
  life: number;
  scale: number;
  core: THREE.Mesh;
  ring: THREE.Mesh;
}

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Projectiles {
  readonly group = new THREE.Group();
  /** live obstacle list the AI steers around; rebuilt in place every frame */
  readonly hazards: HazardLike[] = [];

  private pool: Proj[] = [];
  private blasts: Blast[] = [];
  private shadows!: BlobShadows;
  private art = new Map<number, MatSet>();
  private line: RacingLine | null = null;
  private hazardPool: HazardLike[] = [];
  private mobile = false;

  init(ctx: Ctx) {
    this.group.name = 'projectiles';
    // Half-resolution art on the mobile tiers. A shell is 0.75 m across and is
    // almost never nearer than a couple of metres, so 128 is still well over the
    // texel density anything here resolves at; what it buys is 1.9 MB of the
    // texture budget back, four times less canvas work at boot (the plate and
    // pitting passes are O(S^2)) and the same again off the retained JS heap,
    // which on iOS is charged against the same ceiling as the GPU copy.
    this.mobile = ctx.settings.quality <= Quality.Medium;
    const big = this.mobile ? 128 : 256;
    const small = this.mobile ? 64 : 128;

    this.art.set(ItemKind.GreenShell, shellArt('#3fbf52', '#f2ece0', '#2b8f3d', 0.10, big));
    this.art.set(ItemKind.RedShell, shellArt('#e8433f', '#f2ece0', '#a92a2c', 0.16, big));
    this.art.set(ItemKind.Banana, bananaArt(small));
    this.art.set(ItemKind.Bomb, bombArt(small));

    for (const a of this.art.values()) {
      if (ctx.envMap) a.mat.envMap = ctx.envMap;
      a.mat.envMapIntensity = 0.9;
    }
    // Remember what we adopted, so `setEnv` can tell a real change from the
    // echo `Items` sends on its first frame.
    this.env = ctx.envMap ?? null;

    // Every art set must be reachable from the scene graph before the pre-warm
    // pass runs, or its program is compiled the first time that item type is
    // ever fired — i.e. mid-race, in the frame the player pressed the button.
    //
    // The pool used to be dressed entirely in the green shell, so the red
    // shell, the banana and the bomb existed as materials but hosted nothing
    // and `compileAsync` never saw them. Dealing the four sets round-robin
    // across the pool costs nothing (`dress()` rebinds geometry and material on
    // every spawn anyway, and all of these start hidden) and puts each one on a
    // real mesh with its own geometry — which matters, because the geometry is
    // what decides the vertex-tangent and vertex-colour half of the cache key.
    //
    // Registered as well as hosted: the guarantee should be stated, not left to
    // depend on the pool happening to be at least four deep.
    const KINDS = [ItemKind.GreenShell, ItemKind.RedShell, ItemKind.Banana, ItemKind.Bomb];
    for (const k of KINDS) registerPrewarm(this.art.get(k)!.mat, { label: 'item-' + k });

    for (let i = 0; i < POOL; i++) {
      const art = this.art.get(KINDS[i % KINDS.length])!;
      const mesh = new THREE.Mesh(art.geo, art.mat);
      // Set per-frame by distance in `update` — a shell twenty metres away lays
      // a shadow a few texels across under an object a few pixels across, and
      // pays a full extra draw call per cascade for it.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = false;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.pool.push({
        index: i,
        kind: ItemKind.None, state: PState.Free, owner: -1, ownerLock: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        life: 0, bounces: 0, hintT: 0, spin: 0, scale: 1,
        targetId: -1, homing: false, mesh,
      });
    }

    this.shadows = new BlobShadows(48);
    this.group.add(this.shadows.mesh);

    // --- blast pool -------------------------------------------------------
    const coreGeo = new THREE.SphereGeometry(1, 18, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a8, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb060, map: radialSprite(96, 0.72, 1.2), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    for (let i = 0; i < 4; i++) {
      const core = new THREE.Mesh(coreGeo, coreMat.clone());
      const ring = new THREE.Mesh(ringGeo, ringMat.clone());
      core.visible = ring.visible = false;
      core.frustumCulled = false;
      ring.frustumCulled = false;
      core.renderOrder = 3;
      ring.renderOrder = 3;
      this.group.add(core, ring);
      this.blasts.push({ t: 0, life: 0, scale: 1, core, ring });
    }

    for (let i = 0; i < POOL + 8; i++) {
      this.hazardPool.push({ x: 0, y: 0, z: 0, r: 1, owner: -1 });
    }
    ctx.scene.add(this.group);
  }

  setRacingLine(l: RacingLine) { this.line = l; }

  /**
   * The sky's environment map may arrive after our materials were built.
   *
   * Idempotent, and that matters: `Items` calls this the first time it notices
   * `ctx.envMap`, which — because our own `init` already picked the same map up
   * — is a re-assignment of the value the materials are holding. Bumping
   * `needsUpdate` for it costs a full program-parameter rebuild per material on
   * the frame after the pre-warm, and if the map identity ever DID change it
   * would be a genuine recompile. Compare first.
   */
  setEnv(env: THREE.Texture | null) {
    if (env === this.env) return;
    this.env = env;
    for (const a of this.art.values()) {
      a.mat.envMap = env;
      a.mat.needsUpdate = true;
    }
  }

  private env: THREE.Texture | null | undefined = undefined;

  /** Drop every live projectile — called on a race reset. */
  clear() {
    for (const p of this.pool) {
      p.state = PState.Free;
      p.mesh.visible = false;
    }
    for (const b of this.blasts) {
      b.life = 0;
      b.core.visible = b.ring.visible = false;
    }
    this.hazards.length = 0;
  }

  // ---------------------------------------------------------------------------
  //  Spawning
  // ---------------------------------------------------------------------------

  private acquire(): Proj | null {
    for (const p of this.pool) if (p.state === PState.Free) return p;
    // Pool exhausted: recycle the oldest LIVE banana rather than dropping the
    // player's input on the floor.
    //
    // Both qualifiers are load-bearing and both were wrong. Bananas count their
    // life DOWN from 55 s, so `life > oldest.life` selected the one with the
    // most life left — the banana that was just dropped, usually by the same
    // kart that is asking for this slot, which read as the item never appearing
    // at all. And a `Carried` banana is a shield somebody is actively towing;
    // stealing that silently emptied their item slot mid-lap.
    let oldest: Proj | null = null;
    for (const p of this.pool) {
      if (p.kind !== ItemKind.Banana || p.state !== PState.Live) continue;
      if (!oldest || p.life < oldest.life) oldest = p;
    }
    if (oldest) oldest.mesh.visible = false;
    return oldest;
  }

  private dress(p: Proj, kind: ItemKind) {
    const a = this.art.get(kind) ?? this.art.get(ItemKind.GreenShell)!;
    p.mesh.geometry = a.geo;
    p.mesh.material = a.mat;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(1);
  }

  /**
   * @param carried true = held behind the kart as a shield until released
   */
  spawn(
    kind: ItemKind,
    owner: IKart,
    backwards: boolean,
    carried: boolean,
    targetId = -1,
  ): number {
    const p = this.acquire();
    if (!p) return -1;
    p.kind = kind;
    p.owner = owner.id;
    p.state = carried ? PState.Carried : PState.Live;
    p.bounces = 0;
    p.hintT = owner.t;
    p.spin = 0;
    p.scale = 0.001;              // pops up to full size, never appears from nothing
    p.targetId = targetId;
    // Guidance is on for every red shell, target or no target — see
    // `steerHoming`. A red shell that is not steering is a shell that drives
    // straight into the first barrier the circuit puts in front of it.
    p.homing = kind === ItemKind.RedShell;
    // Owner immunity, per kind, because the three throws have nothing in
    // common but the button.
    //
    //  - Deploying behind needs long enough for the kart to drive out from over
    //    the drop.
    //  - A shell thrown ahead outruns the thrower immediately: a beat is plenty.
    //  - A bob-omb thrown ahead needs its whole ballistic flight. It flies a
    //    straight line while the kart follows the corner, so the two are still
    //    ~8 m apart — inside BLAST_RADIUS — when it lands. Measured on the
    //    harbour sweep: every forward-thrown bomb took out its own thrower.
    //  - A banana thrown ahead is a *stationary* hazard that lands on the road
    //    the thrower is about to drive down, roughly a second in front of them.
    //    The lock covers the flight and the pass over the top of it; after that
    //    the banana is behind the thrower and, next lap, fair game again.
    p.ownerLock = carried ? 0
      : backwards ? 0.55
        : kind === ItemKind.Bomb ? 1.15
          : kind === ItemKind.Banana ? 1.7
            : 0.25;
    p.up.set(0, 1, 0);
    this.dress(p, kind);

    const sign = backwards ? -1 : 1;
    _dir.copy(owner.forward);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    _dir.normalize();

    p.pos.copy(owner.position).addScaledVector(_dir, sign * 1.35);
    p.pos.y += 0.35;

    switch (kind) {
      case ItemKind.Banana:
        p.life = 55;
        p.vel.set(0, backwards ? 0.5 : 5.5, 0);
        if (!backwards) {
          // Lobbed AHEAD — which has to mean ahead of where the thrower will
          // BE when it lands, not ahead of where they are now. A flat 12 m/s
          // against a kart doing 20-30 leaves the banana behind almost as soon
          // as it is out of the owner's grace window, so the thrower drove
          // straight into it: measured, every forward-thrown banana spun its
          // own thrower out inside 0.2 s. The thrower's planar velocity is
          // therefore inherited in full and the 12 is the throw on top of it.
          _v.copy(owner.velocity);
          _v.y = 0;
          p.vel.add(_v).addScaledVector(_dir, 12);
        } else {
          p.vel.addScaledVector(owner.velocity, 0.15);
        }
        break;
      case ItemKind.Bomb:
        p.life = 2.7;
        p.vel.copy(_dir).multiplyScalar(sign * 19).add(_v.set(0, 9.5, 0));
        p.vel.addScaledVector(owner.velocity, 0.55);
        break;
      case ItemKind.RedShell:
        p.life = 12;
        p.vel.copy(_dir).multiplyScalar(sign * RED_SPEED);
        break;
      default:
        p.life = 9;
        p.vel.copy(_dir).multiplyScalar(sign * GREEN_SPEED);
        // Inherit a slice of the thrower's speed so a shell fired at 30 m/s
        // does not appear to hang in the air next to them.
        p.vel.addScaledVector(owner.velocity, sign > 0 ? 0.35 : 0.0);
        break;
    }
    if (carried) p.vel.set(0, 0, 0);
    return p.index;
  }

  /** Release a carried item. Returns false if the handle is stale. */
  release(handle: number, owner: IKart, backwards: boolean, targetId = -1): boolean {
    const p = this.pool[handle];
    if (!p || p.state !== PState.Carried || p.owner !== owner.id) return false;
    const kind = p.kind;
    p.state = PState.Free;
    p.mesh.visible = false;
    return this.spawn(kind, owner, backwards, false, targetId) >= 0;
  }

  isCarried(handle: number, ownerId: number): boolean {
    const p = this.pool[handle];
    return !!p && p.state === PState.Carried && p.owner === ownerId;
  }

  /**
   * What this handle is towing for `ownerId`, or `None` if the handle is stale.
   * A towed item is still the owner's item — the HUD has to draw it and the AI
   * has to decide when to let go of it — and neither can read the pool.
   */
  carriedKind(handle: number, ownerId: number): ItemKind {
    const p = this.pool[handle];
    if (!p || p.state !== PState.Carried || p.owner !== ownerId) return ItemKind.None;
    return p.kind;
  }

  drop(handle: number) {
    const p = this.pool[handle];
    if (!p) return;
    p.state = PState.Free;
    p.mesh.visible = false;
  }

  // ---------------------------------------------------------------------------
  //  Frame
  // ---------------------------------------------------------------------------

  update(ctx: Ctx, dt: number, karts: readonly IKart[]) {
    this.shadows.begin();
    this.hazards.length = 0;
    let hz = 0;
    // Shadow-casting distance for a 0.75 m prop. Every caster is an extra draw
    // per shadow cascade, and each of these already carries a blob shadow that
    // grounds it, so the real shadow only has to survive as far as it is
    // legible. Tighter on mobile, and off entirely when shadows are.
    const shadowMax = ctx.settings.shadows ? (this.mobile ? 18 : 34) : -1;
    const cam = ctx.camera.position;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (p.state === PState.Free) continue;

      // Race guarantees kart id === index; the scan is a cheap belt and braces
      // in case a future field is ever built out of order.
      let owner = karts[p.owner];
      if (owner && owner.id !== p.owner) {
        owner = undefined as unknown as IKart;
        for (let j = 0; j < karts.length; j++) if (karts[j].id === p.owner) owner = karts[j];
      }
      if (p.ownerLock > 0) p.ownerLock -= dt;
      p.scale += (1 - p.scale) * Math.min(1, dt * 12);

      if (p.state === PState.Carried) {
        if (!owner || owner.finished) { this.kill(p); continue; }
        this.stepCarried(ctx, p, owner, dt);
        // a shield is a live hazard for everyone except the kart towing it
        if (!this.testKarts(ctx, p, karts)) continue;
      } else {
        p.life -= dt;
        if (p.life <= 0) {
          if (p.kind === ItemKind.Bomb) this.explode(ctx, p, karts);
          this.kill(p);
          continue;
        }
        if (!this.stepLive(ctx, p, dt, karts)) continue;
      }

      // --- present ---------------------------------------------------------
      p.mesh.position.copy(p.pos);
      p.mesh.scale.setScalar(p.scale);
      this.orient(p, dt);
      const wantCast = shadowMax > 0 && p.pos.distanceToSquared(cam) < shadowMax * shadowMax;
      if (p.mesh.castShadow !== wantCast) p.mesh.castShadow = wantCast;
      const r = p.kind === ItemKind.Banana ? 0.62 : 0.72;
      this.shadows.add(p.pos.x, p.pos.y - this.groundGap(p), p.pos.z, p.up, r * 2.2);

      // --- publish as an obstacle -----------------------------------------
      if (hz < this.hazardPool.length) {
        const h = this.hazardPool[hz++];
        h.x = p.pos.x; h.y = p.pos.y; h.z = p.pos.z;
        h.r = p.kind === ItemKind.Banana ? 1.1 : 1.4;
        h.owner = p.state === PState.Carried ? p.owner : (p.ownerLock > 0 ? p.owner : -1);
        this.hazards.push(h);
      }
    }

    this.shadows.end();
    this.updateBlasts(dt);
  }

  private groundGap(p: Proj) {
    return p.kind === ItemKind.Banana ? 0.14 : SHELL_R * 0.75;
  }

  private kill(p: Proj) {
    p.state = PState.Free;
    p.mesh.visible = false;
  }

  /** Held behind the kart as a shield: it still hurts anyone who runs into it. */
  private stepCarried(ctx: Ctx, p: Proj, owner: IKart, dt: number) {
    _dir.copy(owner.forward);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    _dir.normalize();
    _v.copy(owner.position).addScaledVector(_dir, -1.85);
    _v.y += 0.42 + Math.sin(ctx.time * 4.4) * 0.05;
    // trails rather than snaps, so it swings out through corners
    p.pos.lerp(_v, Math.min(1, dt * 11));
    p.spin += dt * 2.4;
    p.up.set(0, 1, 0);
  }

  /** @returns false if the projectile died this frame */
  private stepLive(ctx: Ctx, p: Proj, dt: number, karts: readonly IKart[]): boolean {
    const track = ctx.track;

    if (p.kind === ItemKind.Bomb) {
      p.vel.y -= BOMB_GRAVITY * dt;
    } else if (p.homing) {
      this.steerHoming(p, karts, dt);
    }

    p.pos.addScaledVector(p.vel, dt);

    // --- surface ------------------------------------------------------------
    const probe = track.probe(p.pos, p.hintT);
    p.hintT = probe.t;
    const gap = this.groundGap(p);
    const floor = probe.y + gap;
    p.up.copy(probe.normal);

    if (p.kind === ItemKind.Banana) {
      // settles onto the road and stays there, banked with the surface
      if (p.pos.y > floor) {
        p.vel.y -= BOMB_GRAVITY * dt;
        // A lob follows the road, not the tangent it left on. Thrown forward at
        // the thrower's own speed plus the throw, a banana covers 30-40 m in
        // the air; held to a straight line that puts it in the scenery on the
        // outside of any corner, where it is neither a hazard nor visible.
        // Bending it toward the racing line is also simply where a banana
        // belongs.
        this.curveWithRoad(p, dt);
      }
      if (p.pos.y <= floor) {
        p.pos.y = floor;
        p.vel.set(0, 0, 0);
      }
      if (probe.surface === Surface.Water) return this.sink(p);
    } else if (p.kind === ItemKind.Bomb) {
      if (p.pos.y <= floor) {
        this.explode(ctx, p, karts);
        this.kill(p);
        return false;
      }
    } else {
      // Shells hug the track: they follow elevation and banking exactly, which
      // is what keeps them plausible through the tunnel and the 20° curve.
      p.pos.y += (floor - p.pos.y) * Math.min(1, dt * 14);
      p.vel.y = 0;
      if (probe.surface === Surface.Water) return this.sink(p);
      // a shell that has wandered far off the circuit is not coming back
      if (probe.edgeRatio > 3.2) return this.sink(p);
    }

    // --- walls --------------------------------------------------------------
    if (p.kind !== ItemKind.Banana) {
      const hit = track.collideWalls(p.pos, SHELL_R + 0.15, p.hintT);
      if (hit) {
        p.pos.add(hit.push);
        const vn = p.vel.dot(hit.normal);
        if (vn < 0) {
          p.vel.addScaledVector(hit.normal, -2 * vn);
          p.vel.multiplyScalar(0.94);
          p.bounces++;
          // Nudge the reflection back toward the track direction; a shell that
          // bounces perfectly square just ping-pongs across the road forever.
          if (this.line) {
            const d = p.hintT * this.line.length;
            const yaw = this.line.yaw[this.line.index(d)];
            _v.set(Math.sin(yaw), 0, Math.cos(yaw));
            const sp = p.vel.length();
            p.vel.addScaledVector(_v, sp * 0.18 * Math.sign(p.vel.dot(_v) || 1));
            p.vel.setLength(sp);
          }
          if (p.kind === ItemKind.RedShell || p.bounces > MAX_BOUNCES) {
            this.explode(ctx, p, karts, 0.5);
            this.kill(p);
            return false;
          }
        }
      }
    }

    // --- karts --------------------------------------------------------------
    return this.testKarts(ctx, p, karts);
  }

  private sink(p: Proj): boolean {
    this.kill(p);
    return false;
  }

  /**
   * Bend a projectile's horizontal velocity toward the racing line ahead of it,
   * preserving speed. Bounded and gentle: over the half-second a lobbed banana
   * is in the air this is worth a few metres of curve, which is exactly the
   * difference between landing on the road and landing on the shoulder.
   */
  private curveWithRoad(p: Proj, dt: number) {
    const line = this.line;
    if (!line) return;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (speed < 1e-3) return;
    line.point(p.hintT * line.length + Math.max(8, speed * 0.5), _aim);
    _dir.set(_aim.x - p.pos.x, 0, _aim.z - p.pos.z);
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();
    const turn = Math.min(1, dt * 3.2);
    p.vel.x += (_dir.x * speed - p.vel.x) * turn;
    p.vel.z += (_dir.z * speed - p.vel.z) * turn;
    const flat = Math.hypot(p.vel.x, p.vel.z) || 1;
    p.vel.x = (p.vel.x / flat) * speed;
    p.vel.z = (p.vel.z / flat) * speed;
  }

  /**
   * Red-shell guidance.
   *
   * The important thing this does is **drive the road**, with or without a
   * victim. Losing the target used to switch guidance off entirely, and a red
   * shell with no guidance is a rock thrown along the tangent of whatever
   * corner it was fired on: measured on the harbour sweep it left the tarmac
   * inside 0.3 s, found the barrier, and — because a red shell detonates on its
   * FIRST wall contact — was gone about a fifth of a second after the button
   * was pressed.
   *
   * That was not an edge case. `Items.targetAhead` returns -1 for the race
   * leader, by definition, so *every* red shell the leader threw forward died
   * that way, plus every shell whose victim went out of range. So the target is
   * now optional: with one, the shell converges on its lane and then takes it
   * head-on; without one, it simply races down the racing line and hits
   * whatever it catches.
   */
  private steerHoming(p: Proj, karts: readonly IKart[], dt: number) {
    const line = this.line;
    if (!line) {
      p.homing = false;
      return;
    }

    let target: IKart | null = karts[p.targetId] ?? null;
    if (target && (target.id !== p.targetId || target.finished)) target = null;
    let dist = Infinity;
    if (target) {
      _v.subVectors(target.position, p.pos);
      dist = _v.length();
      // Lost it: the shell stops chasing but keeps driving. One that sails past
      // is a near miss; one that stops steering is a dud.
      if (dist > 115) target = null;
    }
    if (!target) p.targetId = -1;

    const myD = p.hintT * line.length;
    if (target && dist < 16 && _v.dot(p.vel) > 0) {
      _aim.copy(target.position);
      _aim.y += 0.3;
    } else {
      // Follow the racing line, converging laterally onto the target's lane —
      // this is what carries the shell around blind corners instead of into a
      // wall the moment the target leaves line of sight. With no target the
      // lane it converges on is the racing line itself.
      const look = 9 + Math.min(14, (target ? dist : 45) * 0.2);
      line.point(myD + look, _aim);
      const li = line.index(myD + look);
      const myLat = line.lateralOf(p.pos.x, p.pos.y, p.pos.z, p.hintT);
      const tLat = target
        ? line.lateralOf(target.position.x, target.position.y, target.position.z, target.t)
        : line.off[li];
      const want = myLat + (tLat - myLat) * 0.6 - line.off[li];
      const lim = Math.max(0.5, line.half[li] - 0.8);
      const bias = Math.max(-lim, Math.min(lim, line.off[li] + want)) - line.off[li];
      _aim.x += line.bx[li] * bias;
      _aim.y += line.by[li] * bias;
      _aim.z += line.bz[li] * bias;
    }

    _dir.subVectors(_aim, p.pos).normalize();
    const speed = RED_SPEED;
    // bounded turn rate, so it arcs onto the target instead of snapping to it
    const turn = Math.min(1, dt * 5.5);
    p.vel.x += (_dir.x * speed - p.vel.x) * turn;
    p.vel.z += (_dir.z * speed - p.vel.z) * turn;
    p.vel.y = 0;
    const flat = Math.hypot(p.vel.x, p.vel.z) || 1;
    p.vel.x = (p.vel.x / flat) * speed;
    p.vel.z = (p.vel.z / flat) * speed;
  }

  /** @returns false if the projectile died on contact */
  private testKarts(ctx: Ctx, p: Proj, karts: readonly IKart[]): boolean {
    const reach = (p.kind === ItemKind.Banana ? 0.55 : SHELL_R) + 1.0;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k.id === p.owner && (p.state === PState.Carried || p.ownerLock > 0)) continue;
      _v.subVectors(k.position, p.pos);
      if (Math.abs(_v.y) > 1.8) continue;
      _v.y = 0;
      if (_v.lengthSq() > reach * reach) continue;

      if (k.starTime > 0 || k.stunTime > 0.9) {
        // A starred kart smashes straight through; a kart already spinning is
        // not punished twice for the same mistake.
        if (k.starTime > 0) { this.kill(p); return false; }
        continue;
      }
      if (p.kind === ItemKind.Bomb) {
        this.explode(ctx, p, karts);
        this.kill(p);
        return false;
      }
      this.strike(ctx, k, p.kind, p.kind === ItemKind.Banana ? 1.15 : 1.5);
      this.kill(p);
      return false;
    }
    return true;
  }

  private strike(ctx: Ctx, k: IKart, kind: ItemKind, seconds: number) {
    const before = k.stunTime;
    k.spinOut(seconds);
    // spinOut is a no-op while invulnerable; only announce a hit that landed
    if (k.stunTime > before) ctx.bus.emit({ type: 'hit', kart: k, kind });
  }

  private explode(ctx: Ctx, p: Proj, karts: readonly IKart[], scale = 1) {
    const r = BLAST_RADIUS * scale;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      // The blast honours owner immunity exactly as the contact test does. It
      // did not, which is why a bob-omb thrown forward reliably killed the kart
      // that threw it — `testKarts` politely declined to hit the owner and then
      // the explosion did it anyway.
      if (k.id === p.owner && p.ownerLock > 0) continue;
      _v.subVectors(k.position, p.pos);
      const d = _v.length();
      if (d > r || Math.abs(_v.y) > 5) continue;
      if (k.starTime > 0) continue;
      const falloff = 1 - d / r;
      const before = k.stunTime;
      k.spinOut(1.1 + 0.7 * falloff);
      if (k.stunTime > before) {
        _v.y = 0;
        if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
        _v.normalize().multiplyScalar(6 * falloff);
        _v.y = 5.5 * falloff + 1.5;
        k.launch(_v);
        ctx.bus.emit({ type: 'hit', kart: k, kind: ItemKind.Bomb });
      }
    }
    this.spawnBlast(p.pos, r * 0.5);
    if (ctx.race?.player) {
      const d = ctx.race.player.position.distanceTo(p.pos);
      if (d < 40) ctx.shake(Math.max(0, 0.7 * (1 - d / 40)) * scale, 0.4);
    }
  }

  private spawnBlast(at: THREE.Vector3, radius: number) {
    let slot = this.blasts[0];
    for (const b of this.blasts) if (b.life <= 0) { slot = b; break; }
    slot.life = 0.55;
    slot.t = 0;
    slot.scale = radius;
    slot.core.position.copy(at);
    slot.ring.position.copy(at);
    slot.ring.position.y += 0.12;
    slot.core.visible = slot.ring.visible = true;
  }

  private updateBlasts(dt: number) {
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.t += dt;
      const u = Math.min(1, b.t / b.life);
      if (u >= 1) {
        b.life = 0;
        b.core.visible = b.ring.visible = false;
        continue;
      }
      // fast out, slow fade — the shape of every good explosion
      const e = 1 - Math.pow(1 - u, 3);
      const s = b.scale * (0.25 + e * 1.15);
      b.core.scale.setScalar(s * 0.72);
      b.ring.scale.set(s * 3.1, 1, s * 3.1);
      (b.core.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - u, 2.2);
      (b.ring.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - u, 1.6) * 0.8;
    }
  }

  /** Spin and lean. Shells roll along their travel; bananas just lie there. */
  private orient(p: Proj, dt: number) {
    if (p.kind === ItemKind.Banana) {
      _q.setFromUnitVectors(UP, p.up);
      p.mesh.quaternion.copy(_q);
      p.mesh.rotateY(p.spin);
      if (p.state === PState.Carried) p.spin += dt * 1.4;
      return;
    }
    const speed = Math.hypot(p.vel.x, p.vel.z);
    p.spin += dt * (p.state === PState.Carried ? 2.2 : 3.4 + speed * 0.12);
    // stand on the surface normal, spin about it, then lean into the travel
    // direction so a shell reads as a body being thrown, not a spinning prop
    _q.setFromUnitVectors(UP, p.up);
    p.mesh.quaternion.copy(_q);
    p.mesh.rotateY(p.spin);
    const lean = Math.min(0.22, speed * 0.006);
    p.mesh.rotateZ(Math.sin(p.spin * 0.7) * 0.05 - lean);
  }

  dispose() {
    for (const a of this.art.values()) {
      a.geo.dispose();
      a.mat.map?.dispose();
      a.mat.roughnessMap?.dispose();
      a.mat.normalMap?.dispose();
      a.mat.dispose();
    }
    this.shadows.dispose();
    for (const b of this.blasts) {
      (b.core.material as THREE.Material).dispose();
      (b.ring.material as THREE.Material).dispose();
    }
  }
}
