import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const {SAKURA_FORMS,assignSakuraForms,sakuraNeighborhoods}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../src/world/SakuraVariation.ts',import.meta.url),'utf8'))).toString('base64'));
test('five nearest cherries stay distinct across roadsides and dense park clusters',()=>{
 const points=[];
 for(let i=0;i<42;i++)for(const side of [-1,1])points.push({x:side*14+Math.sin(i*1.7)*2,z:i*15});
 for(let i=0;i<12;i++)points.push({x:45+i%4*7,z:95+Math.floor(i/4)*9});
 const colors=assignSakuraForms(points);
 assert.deepEqual(colors,assignSakuraForms(points));
 for(const group of sakuraNeighborhoods(points))assert.equal(new Set(group.map(i=>colors[i])).size,group.length);
 const used=new Set(colors.map(i=>SAKURA_FORMS[i]));
 assert.ok(Math.max(...[...used].map(f=>f.height))-Math.min(...[...used].map(f=>f.height))>2.5);
 assert.ok([...used].every(f=>f.bloom>=.95));
 assert.ok(new Set([...used].map(f=>f.seed)).size>=7);
});
