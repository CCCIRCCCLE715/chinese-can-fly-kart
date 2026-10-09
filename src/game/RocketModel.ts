import * as THREE from 'three';
import { assetUrl } from '../core/AssetUrl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { IKart } from '../types';

export async function loadRocketModel() {
  const { scene } = await new GLTFLoader().loadAsync(assetUrl('/assets/items/rocket.glb'));
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), centre = box.getCenter(new THREE.Vector3());
  const scale = 1.4 / (box.max.x - box.min.x);
  const template = new THREE.Group();
  template.name = 'rocket-prop';
  scene.traverse(node => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.translate(-centre.x, -centre.y, -centre.z).scale(scale, scale, scale);
    const part = new THREE.Mesh(geometry, mesh.material);
    template.add(part);
  });
  return template;
}

export function rocketPickups(template: THREE.Group, count: number, parent: THREE.Group) {
  return template.children.map(child => {
    const part = child as THREE.Mesh;
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, count);
    mesh.name = 'floating-rocket-pickups';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  });
}

export function rocketMount(template: THREE.Group, kart: IKart) {
  const mount = template.clone(true);
  mount.name = 'active-rocket-thruster';
  mount.position.set(0, 1.18, -.72);
  mount.rotation.x = -.18;
  const flameMat = new THREE.MeshBasicMaterial({color:0x58d9ff,transparent:true,opacity:.8,depthWrite:false});
  const flames: THREE.Mesh[] = [];
  for (const x of [-.19,.19]) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(.105,.5,6),flameMat);
    flame.rotation.z = Math.PI;
    flame.position.set(x,-.48,0);
    mount.add(flame); flames.push(flame);
  }
  const visual = kart.object.children[0] ?? kart.object;
  visual.add(mount);
  mount.visible = false;
  return (now: number) => {
    mount.visible = kart.isPlayer && kart.rocketTime > 0;
    if (!mount.visible) return;
    for (let i=0;i<flames.length;i++) flames[i].scale.y = .92 + .12*Math.sin(now*27+i);
  };
}
