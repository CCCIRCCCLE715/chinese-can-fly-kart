import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {generateSkeleton,buildBranchGeometry,collectTwigSites,LOD_TIERS} from './vendor/sakura-realm/tree/branches.mjs';
import {makeRNG} from './vendor/sakura-realm/core/math.mjs';
import {stripTypeScriptTypes} from 'node:module';
const {SAKURA_FORMS}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(fs.readFileSync(new URL('../src/world/SakuraVariation.ts',import.meta.url),'utf8'))).toString('base64'));
const destination=path.resolve('public/assets/japanese-town');
// Quantized static GLBs retain real branches and fine alpha-cut flower clusters.
function encode(wood,flowers,key){
 const json={asset:{version:'2.0',generator:'kart-royale-cn / MIT sakura-realm adaptation'},extensionsUsed:['KHR_mesh_quantization'],extensionsRequired:['KHR_mesh_quantization'],scene:0,scenes:[{nodes:[0,1]}],nodes:[],meshes:[],materials:[{name:'sakura-bark',pbrMetallicRoughness:{baseColorFactor:[.19,.125,.105,1],metallicFactor:0,roughnessFactor:.94}},{name:'sakura-blossoms',doubleSided:true,alphaMode:'MASK',alphaCutoff:.35,pbrMetallicRoughness:{baseColorFactor:[1,.86,.92,1],metallicFactor:0,roughnessFactor:.94}}],accessors:[],bufferViews:[],buffers:[]};
 const chunks=[];let length=0;
 function buffer(data,target){const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}const b=Buffer.from(data.buffer,data.byteOffset,data.byteLength);const index=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:length,byteLength:b.length,target});chunks.push(b);length+=b.length;return index;}
 function attr(data,type,componentType,normalized,min,max){const index=json.accessors.length;json.accessors.push({bufferView:buffer(data,34962),componentType,count:data.length/({VEC3:3,VEC2:2,VEC4:4}[type]??1),type,...(normalized?{normalized:true}:{}),...(min?{min,max}:{})});return index;}
 for(const [g,material] of [[wood,0],[flowers,1]]){
  g.computeBoundingBox();const center=g.boundingBox.getCenter(new THREE.Vector3()),extent=g.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(.5);extent.x=Math.max(.01,extent.x);extent.y=Math.max(.01,extent.y);extent.z=Math.max(.01,extent.z);
  const p=g.getAttribute('position'),n=g.getAttribute('normal'),uv=g.getAttribute('uv'),c=g.getAttribute('color'),positions=new Int16Array(p.count*3),normals=new Int8Array(p.count*3),coords=new Float32Array(p.count*2),colors=new Uint8Array(p.count*4);
  for(let i=0;i<p.count;i++){
   const encodedNormal=new THREE.Vector3(n.getX(i)*extent.x,n.getY(i)*extent.y,n.getZ(i)*extent.z).normalize();
   for(let k=0;k<3;k++){positions[i*3+k]=Math.round((p.getComponent(i,k)-center.getComponent(k))/extent.getComponent(k)*32767);normals[i*3+k]=Math.round(encodedNormal.getComponent(k)*127);colors[i*4+k]=Math.round(Math.min(1,c?c.getComponent(i,k):1)*255);}
   colors[i*4+3]=255;coords[i*2]=uv.getX(i);coords[i*2+1]=uv.getY(i);
  }
  const attributes={POSITION:attr(positions,'VEC3',5122,true,[-1,-1,-1],[1,1,1]),NORMAL:attr(normals,'VEC3',5120,true),TEXCOORD_0:attr(coords,'VEC2',5126,false),COLOR_0:attr(colors,'VEC4',5121,true)};
  const indices=p.count>65535?new Uint32Array(g.index.array):new Uint16Array(g.index.array),index=json.accessors.length;
  json.accessors.push({bufferView:buffer(indices,34963),componentType:p.count>65535?5125:5123,count:indices.length,type:'SCALAR'});
  json.meshes.push({primitives:[{attributes,indices:index,material}]});json.nodes.push({mesh:material,translation:center.toArray(),scale:extent.toArray()});
 }
 const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}json.buffers=[{byteLength:length}];
 let meta=Buffer.from(JSON.stringify(json));if(meta.length%4)meta=Buffer.concat([meta,Buffer.alloc(4-meta.length%4,32)]);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+meta.length+length,8);header.writeUInt32LE(meta.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(length);binHeader.writeUInt32LE(0x004e4942,4);
 const output=Buffer.concat([header,meta,binHeader,...chunks]);fs.writeFileSync(path.join(destination,'models',key+'.glb'),output);
 return {bytes:output.length,bounds:new THREE.Box3().union(wood.boundingBox).union(flowers.boundingBox).getSize(new THREE.Vector3()).toArray()};
}
const entries=[];
for(const form of SAKURA_FORMS){
 const {key,seed}=form;let branchBudget=850;
 const skeleton=generateSkeleton({seed});LOD_TIERS.low.maxBranches=branchBudget;LOD_TIERS.low.radial=[5,4,3,3,3,3];LOD_TIERS.low.stride=[4,6,8,12,14,16];
 let wood=buildBranchGeometry(skeleton,'low');
 while(wood.index.count/3>=8500){wood.dispose();branchBudget-=25;LOD_TIERS.low.maxBranches=branchBudget;wood=buildBranchGeometry(skeleton,'low');}
 // Strip upstream wind data: these are reusable static assets, not its renderer.
 for(const name of Object.keys(wood.attributes))if(!['position','normal','uv','color'].includes(name))wood.deleteAttribute(name);
 const sites=collectTwigSites(skeleton,{minDepth:3,spacing:.18,maxRadius:.04});
 const crown=new THREE.Box3();for(const site of sites)crown.expandByPoint(new THREE.Vector3(site.x,site.y,site.z));
 const center=crown.getCenter(new THREE.Vector3()),span=crown.getSize(new THREE.Vector3()),base=2.3;
 // A gentle arch preserves the original branching angles and irregular crown.
 // Smoothly bend long upright leaders toward an oblate crown. The continuous
 // mapping keeps forks connected and leaves an irregular, rounded upper edge.
 const crownY=(x,y,z)=>{
  const r2=Math.min(1,((x-center.x)/(span.x*.5))**2+((z-center.z)/(span.z*.5))**2);
  const dy=Math.max(0,y-skeleton.envelope.y0),rise=form.rise*Math.sqrt(Math.max(.25,1-r2*.5));
  return y-dy+rise*Math.tanh(dy/rise)+.45*(1-r2)*Math.max(0,Math.min(1,(y-base)/3));
 };
 const bend=p=>{
  const originalY=p.y,stem=1+(form.trunk-1)*Math.max(0,Math.min(1,(3.8-originalY)/1.7));
  p.x=p.x*form.width*stem+form.lean*Math.max(0,originalY-1.2);
  p.z*=form.depth*stem;p.y=crownY(p.x/form.width,originalY,p.z/form.depth);return p;
 };
 const woodPositions=wood.getAttribute('position');
 for(let i=0;i<woodPositions.count;i++){const p=bend(new THREE.Vector3().fromBufferAttribute(woodPositions,i));woodPositions.setXYZ(i,p.x,p.y,p.z);}
 wood.computeVertexNormals();
 // Match the connected, thickness-ordered subtree actually present in the GLB.
 // Flower sprays follow the grown branches, rather than equal-radius volume centroids.
 const selected=new Set();
 for(const index of skeleton.order){
  if(selected.size>=branchBudget)break;
  const b=skeleton.branches[index];
  if(b.depth>LOD_TIERS.low.maxDepth||b.indexOfParent>=0&&!selected.has(b.indexOfParent))continue;
  selected.add(index);
 }
 const rng=makeRNG(seed^0x5a11a9),sprigs=[];
 // Sample fine flowering shoots across the complete growth skeleton. Their
 // finest twig wood is inside the flower proxy; only structural wood needs
 // tubes. This preserves the small branches shaping the upper crown at low LOD.
 const laterals=skeleton.branches.map((b,index)=>({b,index})).filter(({b,index})=>!selected.has(index)&&b.depth>=3&&b.depth<=5&&b.len>=.35&&b.len<=1.6&&b.baseRadius<.013);
 for(let i=laterals.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[laterals[i],laterals[j]]=[laterals[j],laterals[i]];}
 const parentCounts=new Map(),flowerBranches=[...selected];
 for(const {b,index} of laterals){
  const n=parentCounts.get(b.indexOfParent)??0;if(n>=2)continue;
  flowerBranches.push(index);parentCounts.set(b.indexOfParent,n+1);
  if(flowerBranches.length>=selected.size+600)break;
 }
 const atBranch=(b,distance)=>{
  let i=0;while(i<b.n-2&&b.s[i+1]<distance)i++;
  const f=Math.max(0,Math.min(1,(distance-b.s[i])/Math.max(.001,b.s[i+1]-b.s[i])));
  const p=new THREE.Vector3(b.x[i]+(b.x[i+1]-b.x[i])*f,b.y[i]+(b.y[i+1]-b.y[i])*f,b.z[i]+(b.z[i+1]-b.z[i])*f);
  const next=bend(new THREE.Vector3(b.x[i+1],b.y[i+1],b.z[i+1]));
  const previous=bend(new THREE.Vector3(b.x[i],b.y[i],b.z[i]));
  bend(p);
  return {p,tangent:next.sub(previous).normalize(),r:b.r[i]+(b.r[i+1]-b.r[i])*f,ao:b.ao[i]+(b.ao[i+1]-b.ao[i])*f};
 };
 for(const index of flowerBranches){
  const b=skeleton.branches[index];if(b.depth<1||b.n<2||b.len<.28)continue;
  const middle=atBranch(b,b.len*.65),radial=Math.hypot(middle.p.x,middle.p.z)/Math.max(1,skeleton.envelope.r);
  // Light-accessible fine shoots flower more; the shaded interior stays open.
  if(middle.p.y<2.7||rng()>(.38+middle.ao*.42+Math.min(1,radial)*.24)*form.bloom)continue;
  const start=b.len*(.16+rng()*.22),end=b.len*(.88+rng()*.10),length=end-start;
  const size=(.12+.105*Math.sqrt(Math.min(1,b.baseRadius/.035)))*(.65+rng()*.65);
  const count=Math.max(3,Math.min(26,Math.ceil(length*form.bloom/(.17+rng()*.12)))),cards=[];
  const tint=.97+rng()*.03;
  for(let k=0;k<count;k++){
   const u=(k+.5)/count,site=atBranch(b,start+u*length);if(site.r>.041)continue;
   // Small paired umbels wrap around a shoot. A lateral spread and two
   // gently differing normals prevent the flower spray becoming a flat strip.
   const outward=site.p.clone().sub(new THREE.Vector3(0,skeleton.envelope.y0,0));outward.y+=1.4;outward.normalize();
   const across=new THREE.Vector3().crossVectors(site.tangent,outward).normalize();
   if(across.lengthSq()<.1)across.set(1,0,0);
   const taper=.68+.32*Math.sin(Math.PI*u),halfSize=size*taper*(.90+rng()*.20);
   for(let petalGroup=0;petalGroup<2;petalGroup++){
    const side=petalGroup===0?-1:1;
    const normal=outward.clone().addScaledVector(across,side*.45).add(new THREE.Vector3(0,.35,0)).normalize();
    const right=new THREE.Vector3().crossVectors(Math.abs(normal.y)>.95?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0),normal).normalize();
    const up=new THREE.Vector3().crossVectors(normal,right).normalize();
    const spin=(rng()-.5)*.8;right.applyAxisAngle(normal,spin);up.applyAxisAngle(normal,spin);
    const anchor=site.p.clone().addScaledVector(outward,site.r+halfSize*.3).addScaledVector(across,side*halfSize*.42).addScaledVector(site.tangent,(rng()-.5)*halfSize*.4);anchor.y-=halfSize*.10;
    cards.push({anchor,normal,right,up,halfSize:halfSize*(petalGroup===0?1:.75+rng()*.2),tint});
   }
  }
  if(cards.length<3)continue;
  // Mid-distance prefixes cover the complete shoot, instead of cutting it off.
  const ordered=[],remaining=cards.map((_,i)=>i);
  let phase=.5;while(remaining.length){const desired=phase*cards.length;let best=0;for(let i=1;i<remaining.length;i++)if(Math.abs(remaining[i]-desired)<Math.abs(remaining[best]-desired))best=i;ordered.push(cards[remaining.splice(best,1)[0]]);phase=(phase+.38196601125)%1;}
  sprigs.push({branch:index,length,size,cards:ordered});
 }
 const positions=[],normals=[],uv=[],colors=[],indices=[];
 const maxLayers=Math.max(...sprigs.map(s=>s.cards.length));
 for(let layer=0;layer<maxLayers;layer++)for(const sprig of sprigs){
  const card=sprig.cards[layer];if(!card)continue;
  const {anchor,normal,right,up,halfSize,tint}=card,base=positions.length/3;
  for(const [x,y] of [[-1,-1],[1,-1],[1,1],[-1,1]]){
   const p=anchor.clone().addScaledVector(right,x*halfSize).addScaledVector(up,y*halfSize);
   positions.push(p.x,p.y,p.z);normals.push(normal.x,normal.y,normal.z);uv.push((x+1)/2,(y+1)/2);colors.push(tint,tint,tint);
  }
  indices.push(base,base+1,base+2,base,base+2,base+3);
 }
 const cardCount=positions.length/12;
 const growth={sprays:sprigs.length,visibleBranches:selected.size,patchHalfSize:[Math.min(...sprigs.flatMap(s=>s.cards.map(c=>c.halfSize))),Math.max(...sprigs.flatMap(s=>s.cards.map(c=>c.halfSize)))],sprayLength:[Math.min(...sprigs.map(s=>s.length)),Math.max(...sprigs.map(s=>s.length))]};
 const flowers=new THREE.BufferGeometry();flowers.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));flowers.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));flowers.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));flowers.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));flowers.setIndex(indices);
 // Author both silhouettes at a known height; scene instances are ~8–9 m.
 wood.computeBoundingBox();flowers.computeBoundingBox();
 const fullBounds=wood.boundingBox.clone().union(flowers.boundingBox),heightScale=9.2/(fullBounds.max.y-fullBounds.min.y);
 for(const geometry of [wood,flowers])geometry.applyMatrix4(new THREE.Matrix4().makeScale(1,heightScale,1).multiply(new THREE.Matrix4().makeTranslation(0,-fullBounds.min.y,0)));
 const result=encode(wood,flowers,key);
 entries.push({id:key,key,title:'Natural Japanese sakura — '+key.split('-').at(-1),path:'/assets/japanese-town/models/'+key+'.glb',source:'https://github.com/Leonxlnx/sakura-realm',sourceCommit:'4dd670e9ccbf7dba6a72462288fd8111021b3006',size:result.bounds,license:{slug:'MIT',name:'MIT',url:'https://github.com/Leonxlnx/sakura-realm/blob/main/LICENSE',attributionRequired:true},aiGenerated:null,category:'nature',role:'prop',integration:'Static adaptation of the open-source procedural tree. Variable-length flowering sprays following the grown branch skeleton; visible crown gaps, real light and self-shadow.',woodTriangles:wood.index.count/3,flowerCards:cardCount,form:{height:form.height,trunk:form.trunk,bloom:form.bloom},growth});
 console.log(key,result,'woodTriangles',wood.index.count/3,'flowerCards',cardCount,'growth',growth);
}
const file=path.join(destination,'catalog.json'),catalog=JSON.parse(fs.readFileSync(file));const keys=new Set(entries.map(a=>a.key));catalog.assets=catalog.assets.filter(a=>!keys.has(a.key)).concat(entries);fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');
