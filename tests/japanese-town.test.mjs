import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../src/world/TownLayout.ts',import.meta.url),'utf8');
const {TOWN_SECTIONS,isTown,townWeight}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
test('town scenery covers more than half the lap and begins before the former village',()=>{
 const coverage=TOWN_SECTIONS.reduce((sum,[a,b])=>sum+b-a,0);
 assert.ok(coverage>.5,`Town coverage ${coverage*100}% must exceed 50%`);
 assert.ok(TOWN_SECTIONS[0][0]<.1,'Buildings should appear in the opening straight');
});
test('town leaves the tunnel and bridge clear, and its edge fades stay finite',()=>{
 for(let t=.522;t<.599;t+=.001)assert.equal(isTown(t),false,'Tunnel clearance');
 for(let t=.894;t<.95;t+=.001)assert.equal(isTown(t),false,'Bridge clearance');
 for(let i=0;i<10000;i++)assert.ok(townWeight(i/10000)>=0&&townWeight(i/10000)<=1);
 for(const [a,b] of TOWN_SECTIONS){assert.equal(townWeight(a),0);assert.equal(townWeight(b),0);assert.equal(townWeight((a+b)/2),1);}
 assert.equal(isTown(-.25),isTown(.75));
});
