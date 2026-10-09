import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../src/world/'+name+'.ts',import.meta.url),'utf8'))).toString('base64'));
const {pavingWeight,PAVED_DISTRICTS}=await load('TownLayout');
const {TOWN_RESIDENCES}=await load('TownResidences');
const {makeTownPlan}=await load('TownPlan');
const catalog=JSON.parse(readFileSync(new URL('../public/assets/japanese-town/catalog.json',import.meta.url)));
const models=catalog.assets.filter(a=>a.role==='building').map(a=>({key:a.key,width:a.size[0],height:a.size[1],depth:a.size[2]}));
models.push(...TOWN_RESIDENCES.map(a=>({...a,height:3.2+(a.floors-1)*2.8+1.4})));
test('residential streets include genuine two and three storey silhouettes in useful numbers',()=>{
 const plan=makeTownPlan(1600,[[.035,.505],[.612,.845],[.957,.998]],models);
 assert.ok(plan.buildings.length>=260&&plan.buildings.length<=360);
 const multi=plan.buildings.filter(a=>a.key.startsWith('residence-'));
 assert.ok(multi.length/plan.buildings.length>.25);
 assert.ok(multi.some(a=>a.height>9));
 assert.equal(new Set(multi.map(a=>a.key)).size,6);
 assert.ok(plan.lanes.every(a=>a.depth>=29));
});
test('gravel and paving have a continuous transition wider than one road ring',()=>{
 let intermediate=0;
 for(let i=0;i<16000;i++){
  const t=i/16000,w=pavingWeight(t);
  assert.ok(w>=0&&w<=1);
  assert.ok(Math.abs(w-pavingWeight(t+1/16000))<.01);
  if(w>.1&&w<.9)intermediate++;
 }
 assert.ok(intermediate>1000);
 assert.equal(pavingWeight(.055),0);
 assert.equal(pavingWeight(.27),1);
 assert.equal(pavingWeight(.56),0);
 for(const [a] of PAVED_DISTRICTS)assert.ok(pavingWeight(a)>.3&&pavingWeight(a)<.7);
});
test('all added architecture and tree sources are downloaded CC0 assets',()=>{
 for(const a of catalog.assets.filter(a=>a.key.startsWith('home-')||a.key.startsWith('cherry-blossom-'))){
  assert.equal(a.license.slug,'cc0-1.0');
  const data=readFileSync(new URL('../public'+a.path,import.meta.url));
  assert.equal(data.toString('ascii',0,4),'glTF');
 }
});
