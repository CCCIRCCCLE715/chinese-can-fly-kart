import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ColorMapGLTFLoader } from './js/Loader.js';
import { buildTrack, TRACK_CELLS, CELL_RAW, GRID_SCALE, computeTrackBounds } from './js/Track.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dae7ef');
scene.add(new THREE.HemisphereLight(0xdceeff, 0xa3b379, 2.4));
const sun = new THREE.DirectionalLight(0xfff3da, 3);
sun.position.set(-30, 100, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -115, right: 115, top: 115, bottom: -115, near: 1, far: 240 });
sun.shadow.bias = -0.0003;
scene.add(sun);

const camera = new THREE.OrthographicCamera(-60, 60, 40, -40, 0.1, 600);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minZoom = 0.4;
controls.maxZoom = 6;
let target = new THREE.Vector3();
let span = 110;

function resize() {
  const aspect = innerWidth / innerHeight;
  camera.left = -span * aspect / 2;
  camera.right = span * aspect / 2;
  camera.top = span / 2;
  camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  render();
}
function render() { renderer.render(scene, camera); }
function setView(top = false) {
  const bounds = computeTrackBounds(TRACK_CELLS);
  target.set(bounds.centerX, 0, bounds.centerZ);
  controls.target.copy(target);
  camera.zoom = 1;
  camera.up.set(0, 1, 0);
  camera.position.copy(target).add(top ? new THREE.Vector3(0, 140, 0.01) : new THREE.Vector3(60, 100, 100));
  camera.lookAt(target);
  span = top ? 72 : 76;
  // Leave room for the surrounding props on narrow screens as well.
  span = Math.max(span, 76 / (innerWidth / innerHeight));
  controls.update();
  document.querySelector('#overview').setAttribute('aria-pressed', String(!top));
  document.querySelector('#top').setAttribute('aria-pressed', String(top));
  resize();
}
controls.addEventListener('change', render);
window.addEventListener('resize', resize);
document.querySelector('#overview').addEventListener('click', () => setView(false));
document.querySelector('#top').addEventListener('click', () => setView(true));

async function init() {
  const loader = new ColorMapGLTFLoader();
  const names = ['track-straight', 'track-corner', 'track-bump', 'track-finish', 'decoration-empty', 'decoration-forest', 'decoration-tents', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red'];
  const models = {};
  await Promise.all(names.map(async name => {
    const gltf = await loader.loadAsync(`models/${name}.glb`);
    const meshes = [];
    gltf.scene.traverse(child => { if (child.isMesh) { child.material.side = THREE.FrontSide; meshes.push(child); } });
    // Keep exactly the source project's transform handling.
    if (name.startsWith('vehicle-')) gltf.scene.scale.setScalar(0.5);
    if (meshes.length === 1) { meshes[0].removeFromParent(); models[name] = meshes[0]; }
    else models[name] = gltf.scene;
  }));
  buildTrack(scene, models);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(230, 230), new THREE.MeshStandardMaterial({ color: '#82b867', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-20, -0.14, -15);
  ground.receiveShadow = true;
  scene.add(ground);
  setView(new URLSearchParams(location.search).get('view') === 'top');
  document.querySelector('#status').textContent = '拖动旋转 · 滚轮缩放 · 16 个赛道模块';
  window.kenneyPreview = { scene, camera, renderer, setView, cells: TRACK_CELLS, moduleSize: CELL_RAW * GRID_SCALE, ready: true };
}
init().catch(error => {
  console.error(error);
  document.querySelector('#status').textContent = '地图加载失败，请刷新重试';
});
