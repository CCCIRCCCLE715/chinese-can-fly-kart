import puppeteer from 'puppeteer';import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,k=r.player,ai=r.ai,others=r.karts.filter(o=>o!==k);
  const check=(ok,m)=>{if(!ok)throw Error(m)};r.start();r.state=2;
  ai.reset();k.raceDistance=200;others.forEach((o,n)=>o.raceDistance=200+n);
  others[0].raceDistance=310;others[1].raceDistance=80;
  r.karts.forEach(o=>o.forwardSpeed=20);ai.beginFrame(r.karts,k,.1);
  check(ai.pace.stateFor(others[0].id).mode==='slow','front does not wait');
  check(ai.pace.stateFor(others[1].id).mode==='fast','tail does not chase');
  others[0].raceDistance=201;others[1].raceDistance=199;ai.beginFrame(r.karts,k,.1);
  check(ai.pace.stateFor(others[0].id).mode==='slow'&&ai.pace.stateFor(others[1].id).mode==='fast','leash ended before pass');
  others[0].raceDistance=199;others[1].raceDistance=201;ai.beginFrame(r.karts,k,.1);
  check(ai.pace.stateFor(others[0].id).mode==='normal'&&ai.pace.stateFor(others[1].id).mode==='normal','passing does not release');
  ai.reset();k.raceDistance=0;others.forEach(o=>{o.raceDistance=120;o.forwardSpeed=20;o.position.set(0,0,-15)});
  const visible=others[0],hidden=others[1];hidden.position.set(0,0,30);
  c.camera.position.set(0,3,10);c.camera.lookAt(0,1,-15);c.camera.updateMatrixWorld();
  for(let n=0;n<10;n++){others.forEach(o=>o.raceDistance+=2);ai.beginFrame(r.karts,k,.1,c.camera);}
  check(ai.visibleOpponents.has(visible.id)&&!ai.visibleOpponents.has(hidden.id),'frustum misclassified');
  check(ai.pace.stateFor(hidden.id).base===.6,'hidden transition too slow');
  check(ai.pace.stateFor(visible.id).base>.8,'visible speed changed abruptly');
  const cameraRates={visible:ai.pace.stateFor(visible.id).base,hidden:ai.pace.stateFor(hidden.id).base};
  ai.reset();k.raceDistance=150;others.forEach(o=>o.raceDistance=150);others[0].raceDistance=200;others[1].raceDistance=110;
  for(let n=0;n<10;n++){ai.beginFrame(r.karts,k,.1,c.camera);}
  // Place all opponents outside view for the pack response check.
  others.forEach(o=>o.position.set(0,0,30));for(let n=0;n<10;n++)ai.beginFrame(r.karts,k,.1,c.camera);
  check(ai.pace.stateFor(others[0].id).cohesion<0&&ai.pace.stateFor(others[1].id).cohesion>0,'pack not closing');
  r.reset();r.state=2;
  const enemy=others[0];enemy.paceScale=1;enemy.step(c,1/120,0,1,0,false);const top=enemy.topSpeed;
  enemy.paceScale=.85;enemy.step(c,1/120,0,1,0,false);check(Math.abs(enemy.topSpeed/top-.85)<.001,'physics speed scale');
  const variation=others.map(o=>ai.pace.forKart(o.id));check(new Set(variation).size===7,'no individual variation');
  check(k.paceScale===1,'player speed changed');
  return {opponents:7,independentFiveSecondLeashes:true,holdsUntilOvertake:true,packCompression:true,cameraRates,individualPaces:variation,playerUnaffected:true};
 });assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors},null,2));
}finally{await browser.close()}
