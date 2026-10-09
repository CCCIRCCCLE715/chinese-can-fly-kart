import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as THREE from 'three';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/kart/TrackBoundary.ts',import.meta.url),'utf8'));
const {enforceTrackBoundary}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const track={probe:()=>({t:.25}),sample:()=>({pos:new THREE.Vector3(),tangent:new THREE.Vector3(0,0,1),halfWidth:10})};
test('both edges block ground and airborne karts and align them with forward track direction',()=>{
 for(const height of [0,3,50])for(const side of [-1,1]){
  const k={position:new THREE.Vector3(side*15,height,0),velocity:new THREE.Vector3(side*40,2,-10),yaw:Math.PI,t:0};
  assert.equal(enforceTrackBoundary(track,k,1),0);assert.ok(Math.abs(k.position.x)<9);assert.equal(k.position.y,height);
  assert.ok(k.velocity.x*side<0);assert.ok(k.velocity.z>0);assert.equal(k.velocity.y,2);
 }
});
test('interior karts are untouched and curved track tangent is used',()=>{
 const k={position:new THREE.Vector3(),velocity:new THREE.Vector3(1,0,5),yaw:1,t:0};
 assert.equal(enforceTrackBoundary(track,k,1),null);assert.equal(k.yaw,1);
 const curved={probe:()=>({t:.7}),sample:()=>({pos:new THREE.Vector3(5,0,5),tangent:new THREE.Vector3(1,0,0),halfWidth:8})};
 k.position.set(5,7,20);assert.equal(enforceTrackBoundary(curved,k,1),Math.PI/2);assert.equal(k.position.y,7);
 assert.ok(k.position.z<12&&k.velocity.x>0);
});
