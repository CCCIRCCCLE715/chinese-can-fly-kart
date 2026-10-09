import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const path=new URL('../node_modules/three/build/three.module.js',import.meta.url).href;
const source=readFileSync(new URL('../src/world/SpatialGeometry.ts',import.meta.url),'utf8').replace("from 'three'",`from '${path}'`);
const {splitStaticGeometry}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
test('distant buildings can be culled independently without losing faces or vertex colors',()=>{
 const g=new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.Float32BufferAttribute([-100,0,0,-99,0,0,-100,1,0,100,0,0,101,0,0,100,1,0],3));
 g.setAttribute('color',new THREE.Float32BufferAttribute([1,0,0,1,0,0,1,0,0,0,0,1,0,0,1,0,0,1],3));
 g.setIndex([0,1,2,3,4,5]);
 const chunks=splitStaticGeometry(g,70);
 assert.equal(chunks.length,2);
 assert.equal(chunks.reduce((n,c)=>n+c.index.count,0),g.index.count);
 const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().makeOrthographic(-110,-90,10,-10,-10,10));
 assert.equal(chunks.filter(c=>frustum.intersectsBox(c.boundingBox)).length,1);
 for(const c of chunks){assert.ok(c.boundingSphere.radius<2);assert.equal(c.getAttribute('color').count,c.getAttribute('position').count);for(let i=0;i<c.index.count;i++)assert.ok(c.index.getX(i)<c.getAttribute('position').count);}
});
