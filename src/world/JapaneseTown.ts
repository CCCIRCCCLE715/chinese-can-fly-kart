import * as THREE from 'three';
import {GeoAccum, plainBox, bevelBox, trs, wallWithOpenings, type HouseParts, type RNG} from './Props';

const WOOD=new THREE.Color(0x745044);
const CREAM=new THREE.Color(0xffe4bd);
const GLASS=new THREE.Color(0x527b8b);
const TILE_COLORS=[0x5f91cc,0xeb8a9c,0xe4a169,0x657bb0,0x80b6a4];

/** A closed, pitched end wall; +Z is the street-facing facade. */
function gable(w: number,rise: number,depth: number): THREE.BufferGeometry {
 const shape=new THREE.Shape();
 shape.moveTo(-w/2,0);shape.lineTo(w/2,0);shape.lineTo(0,rise);shape.closePath();
 const geo=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,steps:1});
 geo.translate(0,0,-depth/2);return geo;
}

/** Original procedural kit, matching the selected colorful Japanese town reference.
 * All geometry feeds the existing spatial merge/instance pipeline. */
export function buildJapaneseHouse(out: HouseParts,rng: RNG,xf: THREE.Matrix4,w: number,d: number,floors: number,tint: THREE.Color) {
 floors=Math.min(3,floors);
 const storey=2.8,h=floors*storey,front=d/2;
 const roofColor=new THREE.Color(TILE_COLORS[Math.floor(rng()*TILE_COLORS.length)]);
 const box=plainBox(1,1,1);
 const add=(acc: GeoAccum,x: number,y: number,z: number,sx: number,sy: number,sz: number,col: THREE.Color,ry=0,rx=0)=>{
  acc.add(box,xf.clone().multiply(trs(x,y,z,ry,sx,sy,sz,rx)),col);
 };
 const beam=(x: number,y: number,z: number,sx: number,sy: number,sz: number)=>add(out.trim,x,y,z,sx,sy,sz,WOOD);
 // Matte colored walls, with openings on the road side rather than painted windows.
 const cols=Math.max(2,Math.floor(w/2.1)),winW=1.2,winH=1.05;
 const openings: {x: number;y: number;w: number;h: number}[]=[];
 for(let f=0;f<floors;f++)for(let c=0;c<cols;c++) {
  const x=(c+.5)*w/cols-w/2;
  openings.push({x:x+w/2-winW/2,y:f*storey+1.05,w:winW,h:winH});
 }
 const facade=wallWithOpenings(w,h,openings,.2,.42);facade.translate(-w/2,0,front);
 out.walls.add(facade,xf,tint);
 add(out.walls,0,h/2,-front+.12,w,h,.24,tint);
 for(const side of [-1,1])add(out.walls,side*(w/2-.12),h/2,0,.24,h,d,tint);
 // Foundation, timber corner posts, horizontal floor bands and gutter.
 add(out.trim,0,.13,0,w+.16,.26,d+.16,CREAM);
 for(const side of [-1,1])beam(side*(w/2-.08),h/2,front+.08,.16,h,.18);
 for(let f=1;f<=floors;f++)beam(0,f*storey,front+.1,w,.14,.2);
 // Street windows: wooden surrounds, four-pane crossbars, sills and recessed glass.
 for(let f=0;f<floors;f++)for(let c=0;c<cols;c++){
  const x=(c+.5)*w/cols-w/2,y=f*storey+1.05+winH/2,z=front+.13;
  out.glass.push(xf.clone().multiply(trs(x,y,front-.03,0,winW,winH,1)));
  for(const side of [-1,1])beam(x+side*(winW/2+.04),y,z,.09,winH+.15,.13);
  for(const sy of [-1,1])beam(x,y+sy*(winH/2+.04),z,winW+.15,.09,.13);
  beam(x,y,z,.055,winH,.1);beam(x,y,z,winW,.055,.1);
  beam(x,y-winH/2-.12,z+.06,winW+.25,.1,.3);
 }
 // Side elevations carry windows, drainpipes and air-conditioning units.
 for(const side of [-1,1]){
  for(let f=0;f<floors;f++)for(let k=0;k<2;k++){
   const z=(k-.5)*d*.46,y=f*storey+1.6;
   add(out.trim,side*(w/2+.03),y,z,.12,1.18,1.45,WOOD);
   add(out.trim,side*(w/2+.1),y,z,.05,.96,1.23,GLASS);
   beam(side*(w/2+.14),y,z,.04,.97,.055);
  }
  beam(side*(w/2+.13),h/2,-front+.3,.12,h,.12);
  if(rng()<.8){
   const z=-d*.12,y=2.5;
   add(out.trim,side*(w/2+.35),y,z,.48,.65,1.0,new THREE.Color(0xc8d9dc));
   for(let k=0;k<5;k++)add(out.trim,side*(w/2+.61),y-.22+k*.1,z,.025,.035,.74,new THREE.Color(0x5f7884));
   beam(side*(w/2+.34),y-.4,z,.5,.07,1.08);
  }
 }
 // Broad gabled roofs, shallow upturned eaves, ridge caps and visible tile ends.
 const half=w/2+.55,rise=half*.42,angle=Math.atan2(rise,half);
 const slope=Math.hypot(half,rise);
 out.walls.add(gable(w,rise,d),xf.clone().multiply(trs(0,h,0,0)),tint);
 for(const side of [-1,1]){
  const rz=-side*angle;
  out.roof.add(plainBox(slope,.17,d+1.05),xf.clone().multiply(trs(side*half/2,h+rise/2,0,0,1,1,1,0,rz)),roofColor);
  add(out.roof,side*half,h+.08,0,.35,.19,d+1.2,roofColor);
  for(let k=0;k<=Math.floor((d+1.1)/.38);k++){
   const z=-(d+1.1)/2+k*.38;
   out.roof.add(new THREE.CylinderGeometry(.11,.11,.36,6,1,false),xf.clone().multiply(trs(side*(half-.02),h+.17,z,0,1,1,1,Math.PI/2)),roofColor);
  }
  beam(side*(half-.15),h-.07,0,.15,.16,d+1.0);
 }
 add(out.roof,0,h+rise+.12,0,.28,.24,d+1.3,roofColor);
 // Ground-floor wooden shopfront, recessed sliding door and generous entrance roof.
 const entryX=-w*.18;
 add(out.trim,entryX,1.03,front+.23,1.65,2.05,.12,WOOD);
 add(out.trim,entryX,1.24,front+.31,1.35,1.4,.06,GLASS);
 for(let k=0;k<5;k++)beam(entryX-.64+k*.32,1.22,front+.36,.05,1.45,.08);
 beam(entryX,.33,front+.37,1.45,.12,.1);
 add(out.roof,0,2.48,front+.64,w+.45,.14,1.32,roofColor);
 beam(0,2.37,front+1.24,w+.5,.12,.13);
 // Upper-floor timber balcony with rail posts, plants and an open pergola.
 if(floors>1){
  const by=storey+.03,bw=w*.7;
  beam(0,by,front+.6,bw,.18,1.2);
  beam(0,by+1.0,front+1.12,bw,.09,.1);
  beam(0,by+.32,front+1.12,bw,.06,.1);
  for(let x=-bw/2;x<=bw/2+.01;x+=.52)beam(x,by+.57,front+1.12,.07,1.1,.07);
  for(const side of [-1,1])beam(side*bw/2,by+.57,front+.6,.07,1.1,1.14);
  out.flowerbox.push({m:xf.clone().multiply(trs(bw*.25,by+.2,front+.8,0,.85)),color:new THREE.Color(0xc9856d)});
  out.flowerbox.push({m:xf.clone().multiply(trs(-bw*.28,by+.2,front+.8,0,.7)),color:new THREE.Color(0x9d644c)});
  if(rng()<.45){for(const side of [-1,1])beam(side*bw/2,by+1.25,front+1.1,.1,2.5,.1);for(let x=-bw/2;x<=bw/2;x+=.65)beam(x,by+2.55,front+.55,.12,.12,1.4);}
 }
 // Utility antenna silhouette, meter cabinet, an attached vertical shop-sign frame.
 beam(w*.3,h+rise+.9,-d*.15,.05,1.65,.05);
 beam(w*.3,h+rise+1.65,-d*.15,1.3,.045,.05);
 for(let k=0;k<3;k++)beam(w*.3+(k-1)*.38,h+rise+1.65,-d*.15,.045,.045,.5);
 add(out.trim,w*.39,.85,front+.3,.42,.64,.3,new THREE.Color(0xc5d3d1));
 const signX=w/2-.5;
 add(out.trim,signX,3.2,front+.32,.75,1.8,.18,CREAM);
 for(const dx of [-.4,.4])beam(signX+dx,3.2,front+.44,.06,1.92,.06);
 // Red paper lanterns, textured signboards and utility wires are placed by Scenery.
 out.lineAnchors.push(new THREE.Vector3(0,h-.2,front+.5).applyMatrix4(xf));
 box.dispose();
}
