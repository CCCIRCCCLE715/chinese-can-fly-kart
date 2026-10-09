import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as THREE from 'three';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/game/GasClouds.ts',import.meta.url),'utf8')).replace("from 'three'",`from '${import.meta.resolve('three')}'`);
const {GasClouds}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const ctx={track:{probe:()=>({y:0}),sample:()=>({halfWidth:10})}};
const kart=id=>({id,t:0,position:new THREE.Vector3(),forward:new THREE.Vector3(0,0,1),velocity:new THREE.Vector3(0,0,20),stunTime:0,starTime:0,finished:false,spinOut(s){if(!this.protected)this.stunTime=s}});
test('moving emitter leaves a wide continuous trail; all sections expire together at 1.5s',()=>{
 const gas=new GasClouds(),owner=kart(0),enemy=kart(1);
 gas.release(ctx,owner);const first=gas.clouds[0];
 assert.ok(first.radius>=7);enemy.position.set(6,1,0);
 gas.update(ctx,.1,[owner,enemy]);assert.equal(enemy.stunTime,1.15);assert.equal(owner.stunTime,0);
 for(let n=0;n<12;n++){owner.position.z+=3;gas.update(ctx,.1,[owner]);}
 assert.ok(gas.clouds.includes(first),'first section remains');
 assert.ok(gas.clouds.at(-1).position.z-first.position.z>30,'long trail');
 for(let n=1;n<gas.clouds.length;n++)assert.ok(gas.clouds[n].position.distanceTo(gas.clouds[n-1].position)<2.1,'no gaps');
 const age=first.age;gas.update(ctx,0,[owner]);assert.equal(first.age,age);
 gas.update(ctx,.21,[owner]);assert.equal(gas.clouds.length,0);assert.equal(gas.mesh.count,0);gas.dispose();
});
test('one cast hits each opponent once across its entire trail; resets cleanly',()=>{
 const gas=new GasClouds(),owner=kart(0),enemy=kart(1);
 gas.release(ctx,owner);enemy.position.copy(gas.clouds[0].position);gas.update(ctx,.1,[owner,enemy]);assert.equal(enemy.stunTime,1.15);
 enemy.stunTime=0;owner.position.z=10;gas.update(ctx,.1,[owner]);enemy.position.copy(gas.clouds.at(-1).position);gas.update(ctx,.1,[owner,enemy]);assert.equal(enemy.stunTime,0);
 gas.clear();gas.update(ctx,.1,[owner]);assert.equal(gas.clouds.length,0);gas.dispose();
});

test('two positions to either side and two positions behind are inside the gas',()=>{
 for(const [x,z] of [[6,0],[-6,0],[0,-9]]){
  const gas=new GasClouds(),owner=kart(0),enemy=kart(1);gas.release(ctx,owner);enemy.position.set(x,1,z);gas.update(ctx,.01,[owner,enemy]);assert.equal(enemy.stunTime,1.15);gas.dispose();
 }
});

test('visible gas stays below one metre and inside the wider hit area',()=>{
 const gas=new GasClouds(),owner=kart(0);gas.release(ctx,owner);gas.update(ctx,.2,[owner]);
 const matrix=new THREE.Matrix4(),position=new THREE.Vector3(),scale=new THREE.Vector3(),rotation=new THREE.Quaternion();
 for(let n=0;n<gas.mesh.count;n++){
  gas.mesh.getMatrixAt(n,matrix);matrix.decompose(position,rotation,scale);
  assert.ok(position.y+scale.y<1.1,'puff obscures driving view');
  const center=gas.clouds[0].position;
  assert.ok(Math.hypot(position.x-center.x,position.z-center.z)+scale.x<gas.clouds[0].radius,'visual must be smaller than hit radius');
 }
 assert.ok(gas.mesh.geometry.getAttribute('puffOpacity').getX(0)<=.12);
 assert.equal(gas.clouds[0].radius,7);gas.dispose();
});
