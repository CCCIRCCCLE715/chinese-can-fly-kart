import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewport({width:1280,height:800});
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;
  const c=window.__ctx,r=c.race,k=r.karts[0],old=k.visual.children[0],model=k.visual.getObjectByName('player_SU7_108');
  const check=(ok,msg)=>{if(!ok)throw Error(msg)};
  check(model?.visible&&!old.visible,'first player must use 108');
  check(r.karts.slice(1).every(x=>!x.visual.getObjectByName('player_SU7_108')),'opponents unchanged');
  const rivalIds=r.karts.slice(1).map(x=>x.visual.children[0].uuid);
  for(let i=1;i<r.karts.length;i++){
   r.selectKart(i);check(old.visible&&!model.visible,'first kart opponent must restore old appearance');
   check(r.karts[i].visual.children[0].uuid===rivalIds[i-1],'other choices retain original models');
   r.selectKart(0);check(model.visible&&!old.visible,'return to first choice must restore 108');
  }
  const wheel=k.wheels.find(w=>w.name==='wheelFL'), imported=model.getObjectByName('wheelFL'),spin=model.getObjectByName('wheelSpinFL');
  const y=wheel.position.y,iy=imported.position.y;
  wheel.rotation.y=.3;wheel.rotation.x=1.2;wheel.position.y+=.04;k.appearanceUpdate();
  check(Math.abs(imported.rotation.y-.3)<1e-6&&Math.abs(spin.rotation.x-1.2)<1e-6,'steering and spin follow independently');
  check(Math.abs((imported.position.y-iy)*model.scale.x-.04)<1e-6,'suspension travel follows');
  let meshes=0,triangles=0,textures=new Set();model.traverse(o=>{if(o.isMesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m.map)textures.add(m.map.image.width+'x'+m.map.image.height)}});
  wheel.position.y=y;wheel.rotation.set(0,0,0);k.appearanceUpdate();
  check(textures.has('2048x2048'),'2K texture missing');
  r.start();r.state=2;r.autoDrive=true;
  for(let i=0;i<90;i++)r.update(c,1/60);
  check(Number.isFinite(k.position.x)&&model.visible,'model remains active during race');
  window.__freeze=false;
  return {meshes,triangles,textures:[...textures],choices:r.karts.length,scale:model.scale.x};
 });
 await new Promise(r=>setTimeout(r,1500));
 await page.screenshot({path:'../kart-game-integration/game-108.png'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,...result,errors},null,2));
} finally {await browser.close();}
