import * as THREE from 'three';
/** Small branch-grown flower umbels, lit by the actual scene and shadow maps. */
const PETAL_MASK=/*glsl*/`
 float sakuraFlower(vec2 p){
  float a=atan(p.y,p.x),r=length(p);
  float edge=.36+.052*cos(a*5.0)-.018*cos(a*10.0);
  return 1.0-smoothstep(edge-.015,edge+.010,r);
 }
 float sakuraMask(vec2 uv){
  vec2 p=uv*2.0-1.0;
  // A small umbel of four flowers, with openings between neighbouring umbels.
  return max(max(sakuraFlower(p-vec2(-.31,-.20)),sakuraFlower(p-vec2(.31,-.18))),max(sakuraFlower(p-vec2(-.18,.36)),sakuraFlower(p-vec2(.32,.37))));
 }
`;
function uvShader(material:THREE.Material,petals:boolean){
 material.onBeforeCompile=shader=>{
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vSakuraUv;').replace('#include <begin_vertex>','#include <begin_vertex>\nvSakuraUv=uv;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vSakuraUv;\n'+(petals?PETAL_MASK:''));
  if(petals){
   shader.fragmentShader=shader.fragmentShader.replace('#include <alphatest_fragment>',`diffuseColor.a*=sakuraMask(vSakuraUv);\n#include <alphatest_fragment>`);
   if(material instanceof THREE.MeshStandardMaterial){
    const aoMask=material.userData.sakuraAoMask??={value:0};shader.uniforms.uSakuraAoMask=aoMask;
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform float uSakuraAoMask;');
    // Keep the scene's direct light, shadow maps and environment response. A
    // modest sky-fill gain softens thin petals without replacing their BRDF.
    shader.fragmentShader=shader.fragmentShader.replace('vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;', 'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse * 1.55;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`#include <opaque_fragment>
     // The native AO mask removes only 45% of contact darkening on flower cards.
     gl_FragColor.a=mix(gl_FragColor.a,.45,uSakuraAoMask);`);
   }
  }else{
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
    float ridges=sin(vSakuraUv.x*75.0+sin(vSakuraUv.y*11.0)*1.8);
    float grain=sin(vSakuraUv.y*55.0+sin(vSakuraUv.x*37.0));
    float weather=sin(vSakuraUv.x*9.0+vSakuraUv.y*13.0)*sin(vSakuraUv.y*7.0);
    diffuseColor.rgb*=.85+ridges*.12+grain*.07;
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.19,.18,.15),smoothstep(.72,.94,weather)*.38);`);
  }
 };
 material.customProgramCacheKey=()=>petals?'sakura-botanical-sprays-v6':'sakura-gnarled-bark-v1';
}
export function configureSakuraMaterial(material:THREE.MeshStandardMaterial){
 if(material.name==='sakura-blossoms'){
  material.side=THREE.DoubleSide;material.alphaTest=.35;material.transparent=false;material.roughness=.94;
  material.color.setHex(0xd8adbb);material.emissive.setHex(0x000000);material.emissiveIntensity=0;material.envMapIntensity=.65;material.userData.sakuraAoMask={value:0};
  uvShader(material,true);
 }else if(material.name==='sakura-bark')uvShader(material,false);
}
export function sakuraDepthMaterial(){
 const material=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,alphaTest:.35,side:THREE.DoubleSide});uvShader(material,true);return material;
}
