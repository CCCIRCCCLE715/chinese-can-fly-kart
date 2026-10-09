import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../src/world/TownPlan.ts',import.meta.url),'utf8');
const {makeTownPlan,TOWN_PARKS}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const catalog=JSON.parse(readFileSync(new URL('../public/assets/japanese-town/catalog.json',import.meta.url)));
const blueprints=catalog.assets.filter(a=>a.role==='building').map(a=>({key:a.key,width:a.size[0],height:a.size[1],depth:a.size[2]}));
const plan=makeTownPlan(1600,[[.035,.505],[.612,.845],[.957,.998]],blueprints);
test('town mixes imported building silhouettes, setbacks, heights and real street gaps',()=>{
 assert.ok(plan.buildings.length>100&&plan.buildings.length<320);
 assert.ok(new Set(plan.buildings.map(p=>p.key)).size>=20);
 assert.ok(Math.max(...plan.buildings.map(p=>p.height))-Math.min(...plan.buildings.map(p=>p.height))>4);
 assert.ok(Math.max(...plan.buildings.map(p=>p.width))-Math.min(...plan.buildings.map(p=>p.width))>5);
 assert.ok(Math.max(...plan.buildings.map(p=>p.setback))-Math.min(...plan.buildings.map(p=>p.setback))>10);
 assert.ok(plan.lanes.length>=20);
 assert.ok(plan.lanes.some(l=>l.width>=7));
 for(const side of [-1,1]) for(const tier of [0,1]) {
  const buildings=plan.buildings.filter(p=>p.side===side&&p.tier===tier).sort((a,b)=>a.distance-b.distance);
  for(let i=1;i<buildings.length;i++) assert.ok(buildings[i].distance-buildings[i-1].distance>(buildings[i].width+buildings[i-1].width)/2+1.5);
 }
});
test('two furnished park sites reserve ground and do not create a second racing route',()=>{
 assert.equal(TOWN_PARKS.length,2);
 for(const park of TOWN_PARKS) for(const p of plan.buildings.filter(p=>p.side===park.side)) assert.ok(Math.abs(p.distance-park.t*1600)>park.width/2+p.width/2+3);
 assert.ok(plan.lanes.every(l=>l.depth<=38&&l.side!==0));
 assert.deepEqual(plan,makeTownPlan(1600,[[.035,.505],[.612,.845],[.957,.998]],blueprints));
});
