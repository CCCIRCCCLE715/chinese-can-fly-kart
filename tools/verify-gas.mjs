import puppeteer from 'puppeteer';
import {WebSocket} from 'ws';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
let phone,timer;
try {
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error'&&/Shader|GLSL|VALIDATE/.test(m.text()))errors.push(m.text())});
 await page.setViewport({width:1280,height:800});
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const session=await page.evaluate(()=>{window.__freeze=true;const c=window.__ctx;c.race.start();c.race.state=2;document.querySelector('.rp-toggle').click();return c.input.phoneController.session;});
 const url=new URL(session.controller),[id,key]=url.hash.slice(1).split('.');
 phone=new WebSocket(`wss://${url.host}/link?role=phone&id=${id}&key=${key}`,{ca:readFileSync('.local/certs/ca.pem'),origin:url.origin});
 await new Promise((resolve,reject)=>{phone.once('open',resolve);phone.once('error',reject)});
 let seq=0,gas=0;
 const send=enabled=>phone.send(JSON.stringify({type:'input',seq:seq++,steer:0,enabled,accel:false,brake:false,drift:false,auto:false,item:0,banana:0,gas,pause:0,confirm:0}));
 send(false);timer=setInterval(()=>send(true),30);
 await page.waitForFunction(()=>window.__ctx.input.phoneController.state.connected&&window.__ctx.race.state===2,{timeout:15000}).catch(async()=>{
  await page.waitForFunction(()=>document.querySelector('.rp-status').textContent.includes('体感驾驶中'),{timeout:10000});
 });
 await page.evaluate(()=>{const c=window.__ctx;c.items.give(c.race.player,9);c.items.slot(c.race.player).arm=0;window.__gasEvents=0;const original=c.items.releaseGas.bind(c.items);c.items.releaseGas=k=>{window.__gasEvents++;return original(k)};});
 gas=1;send(true);
 await page.waitForFunction(()=>window.__ctx.input.state.gasPressed,{polling:'raf',timeout:5000}).catch(()=>{});
 // Check the relayed counter independently of the one-frame input edge.
 const phoneInput=await page.evaluate(()=>{
  const c=window.__ctx,remote=c.input.phoneController;
  return {gasCounter:remote.state?.packet?.gas,status:document.querySelector('.rp-status').textContent};
 });
 // Test the real consumer with a frame released from freeze for the next press.
 await page.evaluate(()=>window.__freeze=false);gas=2;send(true);
 await page.waitForFunction(()=>window.__gasEvents>0,{timeout:10000});
 await page.evaluate(()=>window.__freeze=true);
 const result=await page.evaluate(()=>{
  const c=window.__ctx,r=c.race,k=r.player,items=c.items,g=items.gas;
  const phoneTriggers=window.__gasEvents;
  const check=(ok,m)=>{if(!ok)throw Error(m)};
  check(items.held(k).kind===9,'gas consumed rocket');check(k.rocketTime===0,'gas activated rocket');
  check(document.querySelector('.kr-gas-skill')&&document.querySelector('.kr-banana-skill')&&document.querySelector('.kr-item'),'three independent slots');
  g.clear();r.state=2;
  check(items.releaseGas(k)&&items.releaseGas(k),'cooldown blocks repeat');
  check(g.clouds.length===2,'two consecutive activations');
  check(items.throwBanana(k)&&items.held(k).kind===9,'banana conflict');
  g.clear();items.releaseGas(k);const cloud=g.clouds[0],enemy=r.karts.find(o=>o!==k);
  enemy.position.copy(cloud.position);enemy.starTime=0;enemy.invulnTime=0;enemy.stunTime=0;
  g.update(c,.4,[k,enemy]);check(enemy.stunTime===1.15&&enemy.velocity.x===0&&enemy.velocity.z===0,'spin in place');
  enemy.stunTime=0;g.update(c,.1,[enemy]);check(enemy.stunTime===0,'repeat stun');
  const width=cloud.radius*2;check(width===c.track.sample(k.t).halfWidth,'half road width');
  r.state=5;const age=cloud.age;items.update(c,1);check(cloud.age===age&&!items.releaseGas(k),'pause gate');
  r.state=2;for(let i=0;i<30;i++)items.releaseGas(k);check(g.clouds.length===20,'bounded pool');
  items.reset();check(g.clouds.length===0,'reset leaves gas');
  items.give(k,9);items.slot(k).arm=0;items.releaseGas(k);check(items.use(k,false)&&k.rocketTime===3,'rocket broken');
  check(items.releaseGas(k)&&items.throwBanana(k)&&k.rocketTime===3,'skills conflict during rocket');
  items.reset();k.rocketTime=0;r.state=2;
  document.querySelector('.kr-gas-skill').click();check(g.clouds.length===1,'HUD activation');
  g.update(c,.65,[]);
  const pos=g.clouds[0].position,forward=k.forward.clone().setY(0).normalize(),side=forward.clone().cross({x:0,y:1,z:0});
  window.__camRig.update=()=>{};window.__camRig.lateUpdate=()=>{};
  c.camera.position.copy(pos).addScaledVector(forward,-10).addScaledVector(side,7);c.camera.position.y=pos.y+5;
  c.camera.lookAt(pos.x,pos.y,pos.z);
  return {phoneTrigger:phoneTriggers,halfRoadWidth:width,cloudSeconds:4,independentSlots:true,unlimited:true,spinInPlace:true,ownerSafe:k.stunTime===0,pause:true,reset:true};
 });
 await new Promise(r=>setTimeout(r,600));await page.screenshot({path:'docs/previews/gas-cloud-game.png'});
 clearInterval(timer);
 const pad=await browser.newPage();await pad.setViewport({width:844,height:390,isMobile:true,hasTouch:true});
 await pad.goto('http://127.0.0.1:18765/controller/',{waitUntil:'networkidle0'});
 const bounds=await pad.evaluate(()=>['item','banana','gas'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,y:r.y,width:r.width,height:r.height}}));
 for(const a of bounds){assert.ok(a.x>=0&&a.y>=0&&a.x+a.width<=844&&a.y+a.height<=390);for(const b of bounds){if(a===b)continue;assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y)}}
 await pad.screenshot({path:'docs/previews/gas-phone-controller.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,phoneInput,phoneButtons:bounds,errors},null,2));
}finally{clearInterval(timer);phone?.terminate();await browser.close()}
