import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewport({width:1280,height:800});await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,k=r.player,i=c.items;
  const check=(ok,m)=>{if(!ok)throw Error(m)};r.start();r.state=2;
  let wallChecks=0;
  for(const t of [.03,.12,.25,.43,.61,.78,.94])for(const height of [.1,3,25])for(const side of [-1,1]){
   const s=c.track.sample(t),nx=-s.tangent.z,nz=s.tangent.x,len=Math.hypot(nx,nz);
   k.t=t;k.position.copy(s.pos);k.position.x+=nx/len*side*(s.halfWidth+2);k.position.z+=nz/len*side*(s.halfWidth+2);k.position.y+=height;
   k.velocity.set(nx/len*side*35,1,nz/len*side*35);k.yaw=Math.atan2(nx*side,nz*side);
   const y=k.position.y;k.collideWalls(c);
   const p=c.track.probe(k.position,t),frame=c.track.sample(p.t),n={x:-frame.tangent.z,z:frame.tangent.x};
   const lat=((k.position.x-frame.pos.x)*n.x+(k.position.z-frame.pos.z)*n.z)/Math.hypot(n.x,n.z);
   check(Math.abs(lat)<frame.halfWidth-1,'wall projection');check(k.position.y===y,'wall changes altitude');
   check(Math.cos(k.yaw-Math.atan2(frame.tangent.x,frame.tangent.z))>.99,'heading not aligned');wallChecks++;
  }
  r.reset();r.state=2;
  // Run actual rocket physics while repeatedly steering at a road edge.
  i.give(k,9);i.slot(k).arm=0;check(i.use(k,false),'rocket use');
  for(let n=0;n<180;n++){k.step(c,1/60,1,1,0,false);const p=c.track.probe(k.position,k.t);check(p.edgeRatio<1.02,'flight escapes road');}
  r.reset();r.state=2;
  const t=.12,s=c.track.sample(t);k.t=t;k.position.copy(s.pos);k.forward.copy(s.tangent);i.give(k,10);i.slot(k).arm=0;
  check(i.use(k,false)&&i.held(k).count===2,'one charge per burst');
  const first=i.gas.clouds[0];
  for(let n=1;n<=25;n++){const f=c.track.sampleByDistance(t*c.track.length+n*1.8);k.position.copy(f.pos);k.forward.copy(f.tangent);k.t=f.t;i.gas.update(c,.05,[]);}
  check(i.gas.clouds.includes(first),'early gas disappeared');check(i.gas.clouds.length>20,'no trail');
  const length=first.position.distanceTo(i.gas.clouds.at(-1).position),sections=i.gas.clouds.length;check(length>35,'trail too short');
  const enemy=r.karts.find(o=>o!==k);enemy.position.copy(first.position);enemy.stunTime=enemy.starTime=enemy.invulnTime=0;
  i.gas.update(c,.01,[enemy]);check(enemy.stunTime===1.15,'old tail cannot hit');
  i.gas.update(c,.24,[]);check(i.gas.clouds.length===0,'not gone at 1.5 seconds');
  i.slot(k).arm=0;i.use(k,false);const start=k.position.clone();
  for(let n=1;n<=24;n++){k.position.copy(start).addScaledVector(k.forward,n*1.7);i.gas.update(c,.05,[]);}
  const middle=i.gas.clouds[Math.floor(i.gas.clouds.length/2)].position;
  window.__camRig.update=()=>{};window.__camRig.lateUpdate=()=>{};
  c.camera.position.copy(middle).add({x:24,y:24,z:-24});c.camera.lookAt(middle);
  k.object.position.copy(k.position);
  return {wallChecks,rocketStaysInside:true,burstSeconds:1.5,trailMeters:length,sections,oneCharge:true,oldTailHits:true,expiresTogether:true};
 });
 await new Promise(r=>setTimeout(r,300));await page.screenshot({path:'docs/previews/gas-trail-boundary.png'});
 await page.evaluate(()=>{const c=window.__ctx,cloud=c.items.gas.clouds.at(-1),p=cloud.position; c.camera.position.copy(p);c.camera.position.y=p.y+1.4;c.camera.lookAt(p.x-cloud.back.x*20,p.y+.3,p.z-cloud.back.z*20);});
 await new Promise(r=>setTimeout(r,250));await page.screenshot({path:'docs/previews/gas-driver-visibility.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors},null,2));
}finally{await browser.close()}
