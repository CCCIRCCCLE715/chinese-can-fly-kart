import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewport({width:1280,height:800});
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,k=r.player,items=c.items,enemy=r.karts[1];
  const check=(ok,m)=>{if(!ok)throw Error(m)};
  r.start();r.state=2;
  check(items.roll(1,8)===9&&items.roll(8,8)===9,'all boxes must give rocket');
  items.give(enemy,9);check(items.held(enemy).kind===0&&!items.use(enemy,false)&&!enemy.activateRocket(),'enemy cannot acquire/use');
  const b=items.boxes[0];b.down=0;b.scale=1;enemy.position.copy(b.pos);
  const pos=k.position.clone();k.position.set(10000,0,10000);
  items.updateBoxes(1/60,[enemy],1);check(b.down===0,'enemy must not consume pickup');
  k.position.copy(b.pos);items.updateBoxes(1/60,[k],2);
  check(items.held(k).kind===9&&b.down>0,'player pickup consumes prop');
  items.slot(k).arm=0;
  check(items.throwBanana(k)&&items.held(k).kind===9&&k.rocketTime===0,'banana preserves rocket inventory');
  check(items.use(k,false)&&k.rocketTime===3,'use activates three seconds');
  check(!items.use(k,false),'cannot double activate');
  check(items.throwBanana(k)&&k.rocketTime===3,'banana usable during flight');
  check(items.coreMesh.visible,'pickup halo visible');
  const remaining=b.down;k.position.set(10000,0,10000);
  items.updateBoxes(remaining-.1,[],3);check(b.scale===0&&b.down>0,'pickup stays hidden during cooldown');
  items.updateBoxes(.2,[],4);items.updateBoxes(.4,[],5);check(b.down<=0&&b.scale>0,'pickup respawns');
  items.update(c,0);check(k.object.getObjectByName('active-rocket-thruster').visible,'mounted prop visible');
  const realTrack=k.track,results=[];
  for(const fps of [30,60,120]){
   k.track={probe:()=>({y:0})};k.rocketTime=3;k.position.set(0,.08,0);k.velocity.set(0,0,20);k.yaw=0;k.yawRate=0;k.steerInput=0;
   let maxHeight=0,midSpeed=0;
   for(let i=0;i<fps*3;i++){
    k.steerInput=i>fps*.6?.3:0;k.stepRocket(1/fps,0);maxHeight=Math.max(maxHeight,k.position.y);
    if(i===fps)midSpeed=k.forwardSpeed;
   }
   check(k.rocketTime===0,'flight expires at three seconds');
   check(maxHeight>2&&midSpeed>30,'flight has real lift and acceleration');
   check(k.position.x>10&&k.yaw>.5,'steering changes trajectory');
   check(k.position.y<.65,'controlled descent before gravity landing');
   results.push({fps,maxHeight,midSpeed,endHeight:k.position.y,x:k.position.x,z:k.position.z});
  }
  k.track=realTrack;r.reset();r.state=2;r.autoDrive=false;
  items.give(k,9);items.slot(k).arm=0;items.use(k,false);
  for(let i=0;i<55;i++){k.step(c,1/60,0,1,0,false);items.update(c,1/60);}
  check(k.rocketTime>2&&k.airborne,'real game step flies');
  for(const v of [k.position.x,k.position.y,k.position.z])check(Number.isFinite(v),'finite position');
  const mount=k.object.getObjectByName('active-rocket-thruster');
  check(mount.visible,'active rocket still visible');
  c.camera.position.copy(k.position).add({x:4,y:2.7,z:-5});c.camera.lookAt(k.position.x,k.position.y+.6,k.position.z);
  return {passed:true,results,pickupInstances:items.rocketMeshes[0].count,meshTriangles:items.rocketMeshes[0].geometry.index.count/3};
 });
 await new Promise(r=>setTimeout(r,1000));
 await page.screenshot({path:'../kart-game-integration/rocket-flight.png'});
 const landing=await page.evaluate(()=>{
  const c=window.__ctx,k=c.race.player,items=c.items;
  for(let i=0;i<220;i++){k.step(c,1/60,0,1,0,false);items.update(c,1/60);}
  if(k.rocketTime!==0||k.airborne||k.suspension.contacts<1)throw Error('Rocket failed to land');
  if(k.object.getObjectByName('active-rocket-thruster').visible)throw Error('Thruster remains after expiry');
  c.race.reset();c.race.state=2;items.give(k,9);items.slot(k).arm=0;
  document.querySelector('.kr-item').click();
  if(k.rocketTime!==3)throw Error('Click skill did not activate rocket');
  c.race.state=5;const before=k.rocketTime;items.update(c,1);if(k.rocketTime!==before)throw Error('Pause consumes flight');
  c.race.reset();items.update(c,0);
  if(k.rocketTime!==0||k.object.getObjectByName('active-rocket-thruster').visible)throw Error('Reset retains flight');
  return {landed:true,click:true,pause:true,reset:true};
 });
 console.log(JSON.stringify(landing));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors},null,2));
}finally{await browser.close()}
