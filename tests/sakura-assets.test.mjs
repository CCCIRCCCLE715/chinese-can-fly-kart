import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../public/assets/japanese-town/catalog.json',import.meta.url)));
test('natural sakura assets preserve a broad crown and fit the requested geometry budget',()=>{
 const trees=catalog.assets.filter(a=>a.key.startsWith('sakura-natural-'));
 assert.equal(trees.length,9);
 for(const asset of trees){
  assert.ok(asset.size[0]>asset.size[1]*.9);
  const bytes=readFileSync(new URL('../public'+asset.path,import.meta.url));
  assert.equal(bytes.toString('ascii',0,4),'glTF');
  assert.equal(bytes.readUInt32LE(8),bytes.length);
  const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  const primitives=gltf.meshes.flatMap(m=>m.primitives);
  const wood=primitives.find(p=>gltf.materials[p.material].name==='sakura-bark'),flowers=primitives.find(p=>gltf.materials[p.material].name==='sakura-blossoms');
  assert.ok(gltf.accessors[wood.indices].count/3<8500);
  assert.ok(gltf.accessors[flowers.indices].count/3<=24000);
  assert.equal(gltf.materials[flowers.material].alphaMode,'MASK');
  assert.equal(asset.license.slug,'MIT');
 }
 assert.match(readFileSync(new URL('../public/assets/japanese-town/licenses/sakura-realm-MIT.txt',import.meta.url),'utf8'),/Copyright \(c\) 2026 Leonxlnx/);
});

test('blossom patch geometry has size variation without random palette speckles',()=>{
 for(const asset of catalog.assets.filter(a=>a.key.startsWith('sakura-natural-'))){
  const bytes=readFileSync(new URL('../public'+asset.path,import.meta.url));
  const metaLength=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.toString('utf8',20,20+metaLength)),binary=28+metaLength;
  const meshIndex=gltf.meshes.findIndex(m=>gltf.materials[m.primitives[0].material].name==='sakura-blossoms');
  const primitive=gltf.meshes[meshIndex].primitives[0],node=gltf.nodes.find(n=>n.mesh===meshIndex),position=gltf.accessors[primitive.attributes.POSITION];
  const positionOffset=binary+gltf.bufferViews[position.bufferView].byteOffset+(position.byteOffset??0);
  const point=i=>[0,1,2].map(k=>bytes.readInt16LE(positionOffset+(i*3+k)*2)/32767*node.scale[k]);
  const widths=[];
  for(let i=0;i<position.count;i+=4){const a=point(i),b=point(i+1);widths.push(Math.hypot(...a.map((v,k)=>v-b[k])));}
  assert.ok(Math.max(...widths)/Math.min(...widths)>2.5,'flower patches must have several scales');
  const color=gltf.accessors[primitive.attributes.COLOR_0],offset=binary+gltf.bufferViews[color.bufferView].byteOffset;
  let min=255,max=0;for(let i=0;i<color.count;i++){const value=bytes[offset+i*4];min=Math.min(min,value);max=Math.max(max,value);}
  assert.ok(max-min<=9,'intrinsic flower colors should vary only slightly; lighting supplies the shadows');
 }
});
