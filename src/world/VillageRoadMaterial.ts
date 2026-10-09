import * as THREE from 'three';
import { assetUrl } from '../core/AssetUrl';
interface SurfaceMaps {map:THREE.Texture;normalMap:THREE.Texture;roughnessMap:THREE.Texture}
let scans:SurfaceMaps[]|null=null;
export async function loadVillageRoadTextures(renderer:THREE.WebGLRenderer) {
 const loader=new THREE.TextureLoader(),aniso=Math.min(8,renderer.capabilities.getMaxAnisotropy());
 scans=await Promise.all(['gravel_stones','gravel_ground_01','brown_mud_dry'].map(async slug=>{
  const textures=await Promise.all(['albedo','normal','roughness'].map(kind=>loader.loadAsync(assetUrl(`/assets/road-surfaces/${slug}-${kind}.jpg`))));
  textures.forEach((t,i)=>{t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=aniso;t.colorSpace=i===0?THREE.SRGBColorSpace:THREE.NoColorSpace;});
  return {map:textures[0],normalMap:textures[1],roughnessMap:textures[2]};
 }));
}
export function disposeVillageRoadTextures(){scans?.forEach(s=>Object.values(s).forEach(t=>t.dispose()));scans=null;}
const ROAD_GLSL=/*glsl*/`
 varying float vPaving;varying vec2 vRoadWorld;
 uniform sampler2D uFineMap,uFineNormal,uFineRough,uEarthMap,uEarthNormal,uEarthRough;
 uniform sampler2D uStoneMap,uStoneNormal,uStoneRough;uniform float uStoneRate;
 float roadBlend,roadFine,roadSoil,roadTone;vec2 stoneUv,roadMetres;
 vec2 roadHash(vec2 p){return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);}
 float roadNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(roadHash(i).x,roadHash(i+vec2(1,0)).x,f.x),mix(roadHash(i+vec2(0,1)).x,roadHash(i+1.0).x,f.x),f.y);}
 float roadFbm(vec2 p){return (roadNoise(p)+.5*roadNoise(p*2.03+11.7)+.25*roadNoise(p*4.11-9.2))/1.75;}
 // Overlapping shifted quarter-turn tiles. Gradients and tangent normals use
 // the same rotation, preventing seams, wrong relief or blurred cell borders.
 vec4 roadSample(sampler2D tex,vec2 uv,float normalMap){
  vec2 cell=floor(uv),f=fract(uv),a=pow(f,vec2(4.0)),b=pow(1.0-f,vec2(4.0));
  vec2 w=a/(a+b),dx=dFdx(uv),dy=dFdy(uv);vec4 result=vec4(0);
  for(int x=0;x<2;x++)for(int y=0;y<2;y++){
   vec2 offset=vec2(float(x),float(y)),h=roadHash(cell+offset);
   float a=floor(h.x*4.0)*1.57079632679;mat2 turn=mat2(cos(a),sin(a),-sin(a),cos(a));
   vec4 value=textureGrad(tex,turn*(uv-cell-offset)+h*17.3,turn*dx,turn*dy);
   if(normalMap>.5){vec2 n=value.xy*2.0-1.0;value.xy=transpose(turn)*n*.5+.5;}
   float weight=(x==0?1.0-w.x:w.x)*(y==0?1.0-w.y:w.y);result+=value*weight;
  }return result;
 }
`;
/** Scanned PBR layers with metre-scale bare soil, grit and dense aggregate. */
export function createVillageRoadMaterial(fallback:SurfaceMaps,stone:THREE.MeshStandardMaterial,stoneRate:number):THREE.MeshStandardMaterial {
 const [dense,fine,earth]=scans??[fallback,fallback,fallback];
 const material=new THREE.MeshStandardMaterial({...dense,vertexColors:true,roughness:1,metalness:0,normalScale:new THREE.Vector2(.45,.45),envMapIntensity:.35});
 material.name='gravel-to-stone-road';
 material.userData.roadSources=['gravel_stones','gravel_ground_01','brown_mud_dry'];material.userData.scanned=!!scans;
 material.onBeforeCompile=shader=>{
  Object.assign(shader.uniforms,{uFineMap:{value:fine.map},uFineNormal:{value:fine.normalMap},uFineRough:{value:fine.roughnessMap},uEarthMap:{value:earth.map},uEarthNormal:{value:earth.normalMap},uEarthRough:{value:earth.roughnessMap},uStoneMap:{value:stone.map},uStoneNormal:{value:stone.normalMap},uStoneRough:{value:stone.roughnessMap},uStoneRate:{value:stoneRate}});
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float aPaving;varying float vPaving;varying vec2 vRoadWorld;').replace('#include <begin_vertex>','#include <begin_vertex>\nvPaving=aPaving;vRoadWorld=(modelMatrix*vec4(position,1.0)).xz;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+ROAD_GLSL)
   .replace('#include <map_fragment>',/*glsl*/`
    roadMetres=vMapUv*3.5;stoneUv=vMapUv*uStoneRate;
    float broad=roadFbm(vRoadWorld*.085+31.6),roadPatch=roadFbm(vRoadWorld*.36-12.4);
    roadFine=smoothstep(.27,.72,roadFbm(vRoadWorld*.18+75.3));
    roadSoil=smoothstep(.54,.68,broad*.72+roadPatch*.28);
    roadTone=.84+.22*roadFbm(vRoadWorld*.042-63.1);
    roadBlend=clamp(vPaving+(roadPatch-.5)*.35*4.0*vPaving*(1.0-vPaving),0.0,1.0);
    vec3 coarse=roadSample(map,roadMetres/2.0,0.0).rgb;
    vec3 fine=roadSample(uFineMap,roadMetres/3.0,0.0).rgb;
    vec3 earth=roadSample(uEarthMap,roadMetres/1.3,0.0).rgb;
    vec3 grit=mix(mix(coarse,fine,roadFine),earth,roadSoil)*roadTone;
    // Slab bonds keep their orientation, while each slab's wear and tone vary.
    vec2 slabGrid=stoneUv*vec2(4.0,8.0);float slabRow=floor(slabGrid.y);
    vec2 slabId=vec2(floor(slabGrid.x+mod(slabRow,2.0)*.5),slabRow);
    float slabTone=.86+.24*roadHash(slabId).x;
    vec3 slabs=texture2D(uStoneMap,stoneUv).rgb*slabTone*(.90+.16*broad);
    slabs=mix(slabs,earth,.07*roadSoil);
    diffuseColor.rgb*=mix(grit,slabs,roadBlend);`)
   .replace('#include <roughnessmap_fragment>',/*glsl*/`
    float gritR=mix(mix(roadSample(roughnessMap,roadMetres/2.0,0.0).g,roadSample(uFineRough,roadMetres/3.0,0.0).g,roadFine),roadSample(uEarthRough,roadMetres/1.3,0.0).g,roadSoil);
    float roughnessFactor=roughness*clamp(mix(gritR,texture2D(uStoneRough,stoneUv).g,roadBlend),.72,1.0);`)
   .replace('#include <normal_fragment_maps>',/*glsl*/`
    vec3 gritN=roadSample(normalMap,roadMetres/2.0,1.0).xyz*2.0-1.0;
    vec3 fineN=roadSample(uFineNormal,roadMetres/3.0,1.0).xyz*2.0-1.0;
    vec3 earthN=roadSample(uEarthNormal,roadMetres/1.3,1.0).xyz*2.0-1.0;
    gritN.xy*=.55;fineN.xy*=.42;earthN.xy*=.25;
    gritN=normalize(mix(mix(gritN,fineN,roadFine),earthN,roadSoil));
    vec3 stoneN=texture2D(uStoneNormal,stoneUv).xyz*2.0-1.0;stoneN.xy*=.45;
    normal=normalize(tbn*normalize(mix(gritN,stoneN,roadBlend)));`)
   .replace('#include <lights_physical_fragment>',/*glsl*/`
    vec3 dnx=dFdx(normal),dny=dFdy(normal);
    roughnessFactor=min(1.0,sqrt(roughnessFactor*roughnessFactor+min(.18,.65*(dot(dnx,dnx)+dot(dny,dny)))));
    #include <lights_physical_fragment>`);
 };
 material.customProgramCacheKey=()=> 'village-scanned-gravel-soil-stone-v3';
 return material;
}
