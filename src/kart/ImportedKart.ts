import * as THREE from 'three';
import { assetUrl } from '../core/AssetUrl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Kart } from './Kart';

/** Keep the authored asset intact; the existing kart continues to own physics. */
export async function loadFirstKart() {
  return (await new GLTFLoader().loadAsync(assetUrl('/assets/karts/su7-108.glb'))).scene;
}

export function installFirstKart(kart: Kart, imported: THREE.Group) {
  const original = kart.visual.children[0];
  const oldBody = original.userData.body as THREE.Object3D;
  const oldBodyY = oldBody.position.y;
  const body = imported.getObjectByName('body')!;
  const bodyY = body.position.y;
  const corners = ['FL', 'FR', 'RL', 'RR'];
  const pairs = corners.map(corner => {
    const wheel = imported.getObjectByName(`wheel${corner}`)!;
    const source = kart.wheels.find(w => w.name === `wheel${corner}`)!;
    return { wheel, source, restY: wheel.position.y, sourceY: source.position.y,
      spin: imported.getObjectByName(`wheelSpin${corner}`)! };
  });
  // Uniform wheelbase fit preserves the source silhouette and tyre proportions.
  const sourceSpan = Math.abs(pairs[0].wheel.position.z - pairs[2].wheel.position.z);
  const targetSpan = Math.abs(pairs[0].source.position.z - pairs[2].source.position.z);
  const scale = targetSpan / sourceSpan;
  imported.scale.setScalar(scale);
  imported.position.z = (pairs[0].source.position.z + pairs[2].source.position.z) / 2
    - scale * (pairs[0].wheel.position.z + pairs[2].wheel.position.z) / 2;
  imported.name = 'player_SU7_108';
  imported.userData.sourceFile = '108.blend';
  const links: {node: THREE.Object3D; start: THREE.Object3D; end: THREE.Object3D;
    axis: THREE.Vector3; base: THREE.Vector3; length: number}[] = [];
  imported.traverse(node => {
    if ((node as THREE.Mesh).isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
    const data = node.userData;
    if (!data.linkStart || !data.linkEnd) return;
    const start = imported.getObjectByName(data.linkStart);
    const end = imported.getObjectByName(data.linkEnd);
    if (start && end) links.push({node, start, end,
      axis: new THREE.Vector3(...(data.linkAxis_glTF ?? [0, 0, -1]) as [number, number, number]),
      base: node.scale.clone(), length: data.linkLengthAtUnitScale ?? 1});
  });
  kart.visual.add(imported);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), direction = new THREE.Vector3();
  function update() {
    if (!imported.visible) return;
    body.position.y = bodyY + (oldBody.position.y - oldBodyY) / scale;
    body.quaternion.copy(oldBody.quaternion);
    body.scale.copy(oldBody.scale);
    for (const pair of pairs) {
      pair.wheel.position.y = pair.restY + (pair.source.position.y - pair.sourceY) / scale;
      pair.wheel.rotation.set(0, pair.source.rotation.y, 0);
      pair.spin.rotation.x = pair.source.rotation.x;
    }
    imported.updateWorldMatrix(true, true);
    for (const link of links) {
      link.start.getWorldPosition(a); link.end.getWorldPosition(b);
      link.node.parent!.worldToLocal(a); link.node.parent!.worldToLocal(b);
      direction.subVectors(b, a);
      const length = direction.length();
      if (length < 1e-6) continue;
      link.node.position.copy(a);
      link.node.quaternion.setFromUnitVectors(link.axis, direction.divideScalar(length));
      link.node.scale.copy(link.base);
      link.node.scale.z = length / link.length;
      link.node.updateMatrixWorld(true);
    }
  }
  kart.appearanceUpdate = update;
  return (active: boolean) => {
    original.visible = !active;
    imported.visible = active;
    update();
  };
}
