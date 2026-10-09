import * as THREE from 'three';
import { assetUrl } from '../core/AssetUrl';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {visibleTownCopies,type TownPlacement} from './TownVisibility';
import {bakeSakuraImpostor,sakuraView,type SakuraImpostor} from './SakuraImpostor';
import {configureSakuraMaterial,sakuraDepthMaterial} from './SakuraMaterials';
import {TOWN_RESIDENCES} from './TownResidences';
import type {TownBlueprint} from './TownPlan';
import {SAKURA_FORMS,assignSakuraForms,sakuraNeighborhoods} from './SakuraVariation';
interface AssetInfo {key:string;path:string;size:number[];category:string;source:string;role:string}
interface TownPrototype {info:AssetInfo;parts:{geometry:THREE.BufferGeometry;material:THREE.MeshStandardMaterial;paint:boolean;mesh?:THREE.InstancedMesh;lodMeshes?:THREE.InstancedMesh[]}[];bounds:THREE.Box3;placements:TownPlacement[];building:boolean;impostor?:SakuraImpostor}
/** Actual downloaded CC0 meshes, kept offline and instanced by source asset. */
export class ImportedTown {
 readonly group=new THREE.Group();
 readonly blueprints:TownBlueprint[]=[];
 private prototypes=new Map<string,TownPrototype>();
 private view=new THREE.Frustum();
 private projection=new THREE.Matrix4();
 private materials=new Map<string,THREE.MeshStandardMaterial>();
 readonly visibleCounts:Record<string,number>={};
 async load(env:THREE.Texture|null,renderer:THREE.WebGLRenderer) {
  this.group.name='imported-japanese-town';
  const response=await fetch(assetUrl('/assets/japanese-town/catalog.json'));
  if(!response.ok)throw new Error('Japanese town catalog failed to load');
  const catalog=await response.json();
  this.group.userData.source=catalog.source;
  const loader=new GLTFLoader();
  await Promise.all(catalog.assets.map(async(info:AssetInfo)=>{
   const gltf=await loader.loadAsync(assetUrl(info.path));
   gltf.scene.updateMatrixWorld(true);
   const parts:TownPrototype['parts']=[];
   const bounds=new THREE.Box3();
   gltf.scene.traverse(o=>{
    if(!(o instanceof THREE.Mesh))return;
    const source=o.material as THREE.MeshStandardMaterial;
    const key=source.name+':'+source.color.getHexString()+(source.map?':'+info.key+':'+source.uuid:'');
    let material=this.materials.get(key);
    if(!material){material=source.clone();if(source.name==='blossom')material.color.setHex(0xf39cbd);if(source.name==='bloomWhite')material.color.setHex(0xf6b6ce);material.envMap=env;material.envMapIntensity=.35;material.roughness=Math.max(.78,material.roughness);configureSakuraMaterial(material);this.materials.set(key,material);}
    // GLB positions are quantized. Decode before baking node transforms, so a
    // metre coordinate never gets clamped back into a normalized integer buffer.
    const geometry=new THREE.BufferGeometry();
    const original=o.geometry as THREE.BufferGeometry;
    for(const [name,attribute] of Object.entries(original.attributes)){
     const data=new Float32Array(attribute.count*attribute.itemSize);
     for(let i=0;i<attribute.count;i++)for(let k=0;k<attribute.itemSize;k++)data[i*attribute.itemSize+k]=attribute.getComponent(i,k);
     geometry.setAttribute(name,new THREE.BufferAttribute(data,attribute.itemSize));
    }
    if(o.geometry.index)geometry.setIndex(o.geometry.index.clone());
    geometry.applyMatrix4(o.matrixWorld);geometry.computeBoundingBox();geometry.computeBoundingSphere();
    bounds.union(geometry.boundingBox!);
    parts.push({geometry,material,paint:source.name==='plaster'});
    o.geometry.dispose();source.dispose();
   });
   const building=info.role==='building';
   // Collapse repeated nodes using the same material within each imported model.
   const batches=new Map<string,TownPrototype['parts']>();
   for(const part of parts){
    const schema=Object.entries(part.geometry.attributes).map(([name,a])=>name+':'+a.itemSize).sort().join(',');
    const key=part.material.uuid+':'+schema;
    const batch=batches.get(key)??[];batch.push(part);batches.set(key,batch);
   }
   const mergedParts:TownPrototype['parts']=[];
   for(const batch of batches.values()){
    if(batch.length===1){mergedParts.push(batch[0]);continue;}
    const merged=mergeGeometries(batch.map(p=>p.geometry),false);
    if(!merged){mergedParts.push(...batch);continue;}
    batch.forEach(p=>p.geometry.dispose());
    merged.computeBoundingBox();merged.computeBoundingSphere();
    mergedParts.push({...batch[0],geometry:merged});
   }
   this.prototypes.set(info.key,{info,parts:mergedParts,bounds,placements:[],building});
   if(building)this.blueprints.push({key:info.key,width:info.size[0],height:info.size[1],depth:info.size[2]});
  }));
  for(const prototype of this.prototypes.values())if(prototype.info.key.startsWith('sakura-natural-')){
   prototype.impostor=bakeSakuraImpostor(renderer,prototype.parts,prototype.bounds,env);
   // Yield between forms so first-load input and the loading screen stay responsive.
   await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  this.composeResidences();
  this.blueprints.sort((a,b)=>a.key.localeCompare(b.key));
 }
 private composeResidences() {
  for(const house of TOWN_RESIDENCES){
   const parts:TownPrototype['parts']=[];
   const bounds=new THREE.Box3();
   const bays=house.width>6?2:1;
   const panel=(key:string,x:number,y:number,z:number,yaw:number,sx:number,sz=1,roll=0)=>{
    const source=this.prototypes.get(key)!;
    const origin=source.bounds.getCenter(new THREE.Vector3());origin.y=source.bounds.min.y;
    const xf=new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromEuler(new THREE.Euler(0,yaw,roll)),new THREE.Vector3(sx,1,sz));
    xf.multiply(new THREE.Matrix4().makeTranslation(-origin.x,-origin.y,-origin.z));
    for(const part of source.parts){
     const geometry=part.geometry.clone().applyMatrix4(xf);geometry.computeBoundingBox();geometry.computeBoundingSphere();
     bounds.union(geometry.boundingBox!);parts.push({...part,geometry,paint:part.material.name.includes('render')||part.material.name.includes('plaster')||part.material.name==='concrete',mesh:undefined});
    }
   };
   for(let floor=0;floor<house.floors;floor++){
    const y=floor===0?0:3.2+(floor-1)*2.8;
    for(let bay=0;bay<bays;bay++){
     const x=(bay+.5)*house.width/bays-house.width/2;
     panel(floor===0?(bay===0?house.entry:'home-wall'):(bay<house.balconies?'home-upper-balcony':'home-upper-window'),x,y,house.depth/2,0,house.width/bays/4);
     panel(floor===0?'home-wall':'home-upper-window',-x,y,-house.depth/2,Math.PI,house.width/bays/4);
    }
    for(const side of [-1,1])for(let bay=0;bay<2;bay++){
     const z=(bay+.5)*house.depth/2-house.depth/2;
     panel(floor===0?'home-wall':'home-upper-window',side*house.width/2,y,z,side*Math.PI/2,house.depth/8);
    }
   }
   const top=3.2+(house.floors-1)*2.8,angle=.32;
   // Two downloaded tiled roof decks make a pitched roof with a real ridge.
   for(const side of [-1,1])panel('home-tiled-roof',side*house.width/4,top+house.width/4*Math.tan(angle),0,0,(house.width/2+.42)/4.56,(house.depth+.65)/4.58,-side*angle);
   const gableMat=this.prototypes.get('home-wall')!.parts.find(p=>p.material.name==='concrete')?.material??this.prototypes.get('home-wall')!.parts[0].material;
   for(const side of [-1,1]){
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-house.width/2,top,side*house.depth/2,0,top+house.width/2*Math.tan(angle),side*house.depth/2,house.width/2,top,side*house.depth/2],3));
    g.setIndex(side===1?[0,2,1]:[0,1,2]);g.computeVertexNormals();g.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,.5,1,1,0],2));g.computeBoundingBox();g.computeBoundingSphere();bounds.union(g.boundingBox!);parts.push({geometry:g,material:gableMat,paint:true});
   }
   const info:AssetInfo={key:house.key,path:'',size:[house.width,top+house.width/2*Math.tan(angle)+.3,house.depth],category:'buildings',source:'CC0 Japanese alley facade modules and Japanese school tiled roof',role:'building'};
   // Group parts by material and schema so a whole home takes one draw per material.
   const batches=new Map<string,TownPrototype['parts']>();
   for(const p of parts){const schema=Object.entries(p.geometry.attributes).map(([n,a])=>n+':'+a.itemSize).sort().join(',');const k=p.material.uuid+schema+p.paint;const b=batches.get(k)??[];b.push(p);batches.set(k,b);}
   const merged:TownPrototype['parts']=[];
   for(const b of batches.values()){
    const geometry=mergeGeometries(b.map(p=>p.geometry),false);
    if(geometry){b.forEach(p=>p.geometry.dispose());geometry.computeBoundingBox();geometry.computeBoundingSphere();merged.push({...b[0],geometry});}else merged.push(...b);
   }
   this.prototypes.set(house.key,{info,parts:merged,bounds,placements:[],building:true});
   this.blueprints.push({key:house.key,width:info.size[0],height:info.size[1],depth:house.depth,floors:house.floors});
  }
 }
 add(key:string,matrix:THREE.Matrix4,color=new THREE.Color(0xffffff)) {
  const prototype=this.prototypes.get(key);
  if(!prototype)throw new Error(`Unknown imported Japanese asset: ${key}`);
  const bounds=prototype.bounds.clone().applyMatrix4(matrix).getBoundingSphere(new THREE.Sphere());
  prototype.placements.push({matrix:matrix.clone(),color:color.clone(),bounds});
 }
 finish() {
  this.varySakuraNeighborhoods();
  for(const prototype of this.prototypes.values()){
   const capacity=prototype.building?5:prototype.placements.length;
   if(!capacity)continue;
   for(const part of prototype.parts){
    const natural=prototype.info.key.startsWith('sakura-natural-');
    const levels=natural?2:1;
    part.lodMeshes=[];
    for(let level=0;level<levels;level++){
     let geometry=part.geometry;
     if(natural&&level&&part.material.name==='sakura-blossoms'){
      geometry=geometry.clone();const totalCards=geometry.index!.count/6,count=Math.min(4500,Math.ceil(totalCards*.48));
      geometry.setDrawRange(0,Math.min(geometry.index!.count,count*6));
      const positions=geometry.getAttribute('position'),boost=1.35;
      for(let i=0;i<Math.min(positions.count,count*4);i+=4){
       const center=new THREE.Vector3();for(let k=0;k<4;k++)center.add(new THREE.Vector3().fromBufferAttribute(positions,i+k));center.multiplyScalar(.25);
       for(let k=0;k<4;k++){const p=new THREE.Vector3().fromBufferAttribute(positions,i+k).sub(center).multiplyScalar(boost).add(center);positions.setXYZ(i+k,p.x,p.y,p.z);}
      }
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
     }
     const mesh=new THREE.InstancedMesh(geometry,part.material,capacity);
     if(part.paint)mesh.setColorAt(0,new THREE.Color(0xffffff));
     mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
     mesh.name=`town-asset-${prototype.info.key}${natural?'-lod'+level:''}`;
     mesh.userData.sourceAsset=prototype.info.key;
     // Thin overlapping flower cards should not get creases from screen-space AO.
     if(part.material.name==='sakura-blossoms')mesh.userData.cannotReceiveAO=true;
     mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;
     if(part.material.name==='sakura-blossoms')mesh.customDepthMaterial=sakuraDepthMaterial();
     mesh.count=0;mesh.visible=false;this.group.add(mesh);part.lodMeshes.push(mesh);
     if(level===0)part.mesh=mesh;
    }
   }
  }
  for(const prototype of this.prototypes.values())if(prototype.impostor&&prototype.placements.length){
   const imp=prototype.impostor,capacity=prototype.placements.length;
   imp.geometry.setAttribute('aSakuraView',new THREE.InstancedBufferAttribute(new Float32Array(capacity),1));
   const mesh=new THREE.InstancedMesh(imp.geometry,imp.material,capacity);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=false;mesh.count=0;mesh.visible=false;mesh.name='town-sakura-far-impostor-'+prototype.info.key;mesh.userData.views=8;mesh.userData.trianglesPerTree=2;mesh.userData.cannotReceiveAO=true;this.group.add(mesh);imp.mesh=mesh;
  }
  this.group.userData.buildingTypes=this.blueprints.length;
  this.group.userData.maxCopiesPerSource=5;
 }
 private varySakuraNeighborhoods() {
  const placements=[...this.prototypes.values()].filter(p=>p.info.key.startsWith('sakura-natural-')).flatMap(p=>p.placements);
  const points=placements.map(p=>({x:p.matrix.elements[12],z:p.matrix.elements[14]})),forms=assignSakuraForms(points);
  for(const p of this.prototypes.values())if(p.info.key.startsWith('sakura-natural-'))p.placements=[];
  const trees=placements.map((p,i)=>{
   const form=SAKURA_FORMS[forms[i]],prototype=this.prototypes.get(form.key)!;
   const position=new THREE.Vector3(),rotation=new THREE.Quaternion(),oldScale=new THREE.Vector3();p.matrix.decompose(position,rotation,oldScale);
   const hash=(salt:number)=>{const n=Math.sin((i+1)*127.1+salt*311.7)*43758.5453;return n-Math.floor(n);};
   const height=form.height*(.98+hash(2)*.04),width=.83+hash(4)*.13,depth=.83+hash(7)*.13;
   const matrix=new THREE.Matrix4().compose(position,rotation,new THREE.Vector3(width,height/9.2,depth));
   prototype.placements.push({matrix,color:p.color,bounds:prototype.bounds.clone().applyMatrix4(matrix).getBoundingSphere(new THREE.Sphere())});
   return {key:form.key,x:position.x,y:position.y,z:position.z,height,width:prototype.info.size[0]*width,depth:prototype.info.size[2]*depth,bloom:form.bloom,trunk:form.trunk,yaw:new THREE.Euler().setFromQuaternion(rotation,'YXZ').y};
  });
  this.group.userData.sakuraTrees=trees;
  this.group.userData.sakuraNeighborhoods=sakuraNeighborhoods(points);
 }
 update(camera:THREE.Camera) {
  camera.updateMatrixWorld();
  this.projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  this.view.setFromProjectionMatrix(this.projection);
  const eye=new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  for(const prototype of this.prototypes.values()){
   const selected=visibleTownCopies(prototype.placements,this.view,eye,prototype.building?5:prototype.placements.length);
   if(prototype.building)this.visibleCounts[prototype.info.key]=selected.length;
   const natural=prototype.info.key.startsWith('sakura-natural-');
   const buckets:TownPlacement[][]=natural?[[],[],[]]:[selected];
   if(natural)for(const p of selected){const d=p.bounds.center.distanceTo(eye);if(d>300)continue;buckets[d<40?0:d<90?1:2].push(p);}
   for(const part of prototype.parts){
    (part.lodMeshes??[]).forEach((mesh,level)=>{
     const placements=buckets[level];mesh.count=placements.length;mesh.visible=mesh.count>0;
     placements.forEach((p,i)=>{mesh.setMatrixAt(i,p.matrix);if(part.paint)mesh.setColorAt(i,p.color);});
     mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
    });
   }
   const imp=prototype.impostor;
   if(imp?.mesh){
    const mesh=imp.mesh,views=imp.geometry.getAttribute('aSakuraView') as THREE.InstancedBufferAttribute;
    const pos=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3(),billboard=new THREE.Quaternion(),matrix=new THREE.Matrix4();
    const distant=buckets[2];mesh.count=distant.length;mesh.visible=mesh.count>0;
    distant.forEach((placement,i)=>{
     placement.matrix.decompose(pos,rotation,scale);const center=imp.center.clone().applyMatrix4(placement.matrix);
     const yaw=Math.atan2(eye.x-center.x,eye.z-center.z),sourceYaw=new THREE.Euler().setFromQuaternion(rotation,'YXZ').y;
     billboard.setFromAxisAngle(new THREE.Vector3(0,1,0),yaw);matrix.compose(center,billboard,new THREE.Vector3(imp.width*Math.hypot(Math.cos(yaw-sourceYaw)*scale.x,Math.sin(yaw-sourceYaw)*scale.z),imp.height*scale.y,1));mesh.setMatrixAt(i,matrix);views.setX(i,sakuraView(Math.atan2(Math.sin(yaw-sourceYaw)/scale.x,Math.cos(yaw-sourceYaw)/scale.z)));
    });
    mesh.instanceMatrix.needsUpdate=true;views.needsUpdate=true;
   }
  }
  this.group.userData.visibleCounts=this.visibleCounts;
 }
 dispose(){for(const p of this.prototypes.values())for(const part of p.parts){for(const mesh of part.lodMeshes??[]){if(mesh.geometry!==part.geometry)mesh.geometry.dispose();mesh.customDepthMaterial?.dispose();}part.geometry.dispose();}for(const p of this.prototypes.values())if(p.impostor){p.impostor.geometry.dispose();p.impostor.material.dispose();p.impostor.target.dispose();}for(const material of this.materials.values())material.dispose();}
}
