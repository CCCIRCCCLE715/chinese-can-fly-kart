import puppeteer from 'puppeteer';import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try{
 const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(String(e)));
 await p.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await p.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,k=r.player,ai=r.ai;
  const check=(ok,m)=>{if(!ok)throw Error(m)};r.start();r.state=2;
  k.raceDistance=0;for(const o of r.karts)o.raceDistance=0;
  ai.reset();ai.beginFrame(r.karts,k,0);
  check(k.paceScale===1,'player changed');
  const initial=r.karts.filter(o=>o!==k).map(o=>o.paceScale);
  check(initial.every(v=>v>=.85*.94&&v<=.85*1.06),'base envelope');
  check(new Set(initial).size===7,'identical opponents');
  for(const o of r.karts)if(o!==k)o.raceDistance=40+o.id;
  ai.beginFrame(r.karts,k,.1);check(ai.pace.mode==='slow','not slowing behind pack');
  const steps=Math.ceil(ai.line.length*.25/2)+1;
  for(let n=0;n<steps;n++){for(const o of r.karts)if(o!==k)o.raceDistance+=2;ai.beginFrame(r.karts,k,.1);}
  check(Math.abs(ai.pace.base-.6)<1e-9,'quarter lap transition');
  k.raceDistance=Math.max(...r.karts.map(o=>o.raceDistance))+1;
  ai.beginFrame(r.karts,k,.1);check(ai.pace.mode==='normal','catch leader restores normal');
  ai.reset();k.raceDistance=100;for(const o of r.karts)if(o!==k)o.raceDistance=0;
  ai.beginFrame(r.karts,k,.1);check(ai.pace.mode==='fast','player ahead should speed pack');
  const enemy=r.karts.find(o=>o!==k);enemy.raceDistance=105;
  ai.beginFrame(r.karts,k,.1);check(ai.pace.mode==='fast','one pass must not end acceleration');
  for(const o of r.karts)if(o!==k)o.raceDistance=110+o.id;
  ai.beginFrame(r.karts,k,.1);check(ai.pace.mode==='slow','whole pack passed');
  enemy.boostTime=enemy.starTime=0;enemy.paceScale=1;enemy.step(c,1/120,0,1,0,false);const normal=enemy.topSpeed;
  enemy.paceScale=.85;enemy.step(c,1/120,0,1,0,false);check(Math.abs(enemy.topSpeed/normal-.85)<.001,'physical ceiling');
  r.reset();ai.beginFrame(r.karts,k,0);check(k.paceScale===1&&ai.pace.mode==='normal','reset');
  return {opponents:7,basePace:.85,initialIndividualPaces:initial,quarterLapTransition:true,slowUntilFront:true,fastUntilEntirePackPasses:true,physicalCeilingRatio:.85,playerUnaffected:true};

 });assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors},null,2));
}finally{await browser.close()}
