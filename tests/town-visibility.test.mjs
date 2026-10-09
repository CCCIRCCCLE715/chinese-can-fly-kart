import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/world/TownVisibility.ts',import.meta.url),'utf8')).replace("from 'three'",`from '${new URL('../node_modules/three/build/three.module.js',import.meta.url).href}'`);
const {visibleTownCopies}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('same source building is capped at five even in wide and overhead views',()=>{
 const placements=Array.from({length:14},(_,i)=>({matrix:new THREE.Matrix4(),color:new THREE.Color(i%2?0xffbbbb:0xbbffbb),bounds:new THREE.Sphere(new THREE.Vector3(i-7,0,0),1)}));
 for(const camera of [new THREE.OrthographicCamera(-20,20,20,-20,.1,100),new THREE.PerspectiveCamera(110,2,.1,100)]){
  camera.position.set(0,20,15);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const chosen=visibleTownCopies(placements,frustum,camera.position);
  assert.equal(chosen.length,5);
  assert.ok(chosen.every(p=>frustum.intersectsSphere(p.bounds)));
  assert.ok(chosen[0].bounds.center.distanceTo(camera.position)<=chosen.at(-1).bounds.center.distanceTo(camera.position));
 }
});
