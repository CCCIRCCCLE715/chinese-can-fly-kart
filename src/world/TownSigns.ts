import * as THREE from 'three';
export const TOWN_SIGN_COUNT=12;
/** Distinct shop signs share an atlas; imported facades keep their original geometry. */
export function makeTownSigns(): THREE.CanvasTexture {
 const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=512;
 const g=canvas.getContext('2d')!;
 const labels=['茶屋','本屋','花店','甘味','温泉','旅館','食堂','陶器','青果','工房','米店','酒店'];
 const colors=['#f5e4bd','#bce0db','#f3c4cd','#f0d996','#c8dcec','#efc7a6'];
 const width=canvas.width/TOWN_SIGN_COUNT;
 for(let i=0;i<TOWN_SIGN_COUNT;i++){
  const x=i*width;g.fillStyle=colors[i%colors.length];g.fillRect(x,0,width+1,512);
  g.strokeStyle='#755246';g.lineWidth=7;g.strokeRect(x+10,15,width-20,482);
  g.fillStyle='#61443b';g.font='bold 83px serif';g.textAlign='center';g.textBaseline='middle';
  g.fillText(labels[i][0],x+width/2,178);g.fillText(labels[i][1],x+width/2,326);
  g.font='22px serif';g.fillText('さくら町',x+width/2,442);
 }
 const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
 map.wrapS=map.wrapT=THREE.ClampToEdgeWrapping;map.anisotropy=4;return map;
}
