import * as THREE from 'three';
import {sakuraDepthMaterial} from './SakuraMaterials';
const VIEWS=8,TILE=128;
export interface SakuraImpostor {geometry:THREE.BufferGeometry;material:THREE.MeshBasicMaterial;target:THREE.WebGLRenderTarget;width:number;height:number;center:THREE.Vector3;mesh?:THREE.InstancedMesh}
/** Bake the original model once, with sun, sky fill and self-shadowing. */
export function bakeSakuraImpostor(renderer:THREE.WebGLRenderer,parts:{geometry:THREE.BufferGeometry;material:THREE.MeshStandardMaterial}[],bounds:THREE.Box3,env:THREE.Texture|null):SakuraImpostor {
 const size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
 const width=Math.max(size.x,size.z)*1.12,height=size.y*1.08;
 const scene=new THREE.Scene();scene.environment=env;
 const sun=new THREE.DirectionalLight(0xfff3df,5.2);sun.position.set(-12,20,10);sun.castShadow=true;
 sun.shadow.mapSize.set(256,256);sun.shadow.camera.left=-10;sun.shadow.camera.right=10;sun.shadow.camera.top=14;sun.shadow.camera.bottom=-10;sun.shadow.camera.near=.1;sun.shadow.camera.far=65;sun.shadow.bias=-.001;sun.target.position.copy(center);
 scene.add(sun,sun.target,new THREE.HemisphereLight(0xd0e4f1,0x6a7058,1.05));
 const depth:THREE.Material[]=[];
 for(const part of parts){const mesh=new THREE.Mesh(part.geometry,part.material);mesh.castShadow=true;mesh.receiveShadow=true;if(part.material.name==='sakura-blossoms'){mesh.customDepthMaterial=sakuraDepthMaterial();depth.push(mesh.customDepthMaterial);}scene.add(mesh);}
 const target=new THREE.WebGLRenderTarget(TILE*VIEWS,TILE,{generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,depthBuffer:true,samples:4});target.texture.colorSpace=THREE.LinearSRGBColorSpace;
 const previous={target:renderer.getRenderTarget(),clear:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),test:renderer.getScissorTest(),tone:renderer.toneMapping,autoClear:renderer.autoClear};
 const camera=new THREE.OrthographicCamera(-width/2,width/2,height/2,-height/2,.1,90);
 try{
  renderer.toneMapping=THREE.NoToneMapping;renderer.autoClear=false;renderer.setRenderTarget(target);renderer.setClearColor(0x000000,0);renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);
  for(let i=0;i<VIEWS;i++){
   const angle=i*Math.PI*2/VIEWS;camera.position.copy(center).add(new THREE.Vector3(Math.sin(angle)*35,0,Math.cos(angle)*35));camera.lookAt(center);camera.updateMatrixWorld(true);
   target.viewport.set(i*TILE,0,TILE,TILE);target.scissor.set(i*TILE,0,TILE,TILE);target.scissorTest=true;
   renderer.setViewport(i*TILE,0,TILE,TILE);renderer.setScissor(i*TILE,0,TILE,TILE);renderer.render(scene,camera);
  }
 }finally{
  renderer.setRenderTarget(previous.target);renderer.setClearColor(previous.clear,previous.alpha);renderer.setViewport(previous.viewport);renderer.setScissor(previous.scissor);renderer.setScissorTest(previous.test);renderer.toneMapping=previous.tone;renderer.autoClear=previous.autoClear;
  sun.shadow.map?.dispose();depth.forEach(m=>m.dispose());
 }
 const material=new THREE.MeshBasicMaterial({map:target.texture,alphaTest:.3,transparent:false,side:THREE.DoubleSide,toneMapped:true});material.name='sakura-lit-impostor';material.userData.impostorTarget=target;
 material.onBeforeCompile=shader=>{
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float aSakuraView;varying float vSakuraView;').replace('#include <begin_vertex>','#include <begin_vertex>\nvSakuraView=aSakuraView;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying float vSakuraView;').replace('#include <map_fragment>','diffuseColor*=texture2D(map,vec2((vMapUv.x+vSakuraView)/8.0,vMapUv.y));');
 };
 material.customProgramCacheKey=()=> 'sakura-lit-eight-view-impostor-v1';
 return {geometry:new THREE.PlaneGeometry(1,1),material,target,width,height,center};
}
export function sakuraView(angle:number){return Math.round(((angle/(Math.PI*2)%1)+1)%1*VIEWS)%VIEWS;}
