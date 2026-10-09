import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('scanned road maps retain the downloaded CC0 source bytes',()=>{
 const sources=JSON.parse(readFileSync(new URL('../public/assets/road-surfaces/sources.json',import.meta.url),'utf8'));
 assert.equal(sources.active.length,3);
 for(const id of sources.active)assert.ok(sources.assets.some(a=>a.id===id));
 for(const asset of sources.assets){
  assert.equal(asset.license,'CC0-1.0');
  assert.ok(asset.physicalWidthMetres>0);
  for(const kind of ['albedo','normal','roughness']){
   const map=asset.maps[kind];
   const bytes=readFileSync(new URL('../public'+map.path,import.meta.url));
   assert.equal(bytes.length,map.bytes);
   assert.equal(createHash('md5').update(bytes).digest('hex'),map.md5);
  }
 }
});
