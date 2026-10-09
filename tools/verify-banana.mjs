import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewport({width:1280,height:800});
 await page.evaluateOnNewDocument(()=>{window.testButtons=Array.from({length:17},()=>({pressed:false,value:0,touched:false}));Object.defineProperty(navigator,'getGamepads',{value:()=>[{index:0,connected:true,mapping:'standard',buttons:window.testButtons,axes:[0,0,0,0]}]});});
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,k=c.race.player,items=c.items,input=c.input;
  function check(ok,message){if(!ok)throw Error(message);}
  check(typeof items.throwBanana==='function','Permanent banana skill missing');
  c.race.start();c.race.state=2;c.race.autoDrive=false;
  for(const p of c.race.prog)p.respawnT=0;
  let uses=0;c.bus.on(e=>{if(e.type==='item-use'&&e.kart===k&&e.kind===5)uses++;});
  const frame=()=>{input.update(c,1/60);c.race.update(c,1/60);};
  const press=(index,on)=>{window.testButtons[index].pressed=on;window.testButtons[index].value=on?1:0;};
  frame();check(items.held(k).kind===0,'Starts with no picked-up item');
  press(3,true);frame();check(uses===1&&!input.state.itemPressed,'Y fires independently with empty inventory');
  frame();check(uses===1,'Holding Y must not auto-fire');
  press(3,false);frame();press(3,true);frame();check(uses===2,'Immediate second press, no cooldown');
  press(3,false);frame();
  items.give(k,1);items.slot(k).arm=0;
  press(3,true);frame();check(uses===3&&items.held(k).kind===1,'Y preserves held ordinary item');
  press(3,false);frame();press(2,true);frame();check(items.held(k).kind===0&&uses===3,'X still uses ordinary item only');
  press(2,false);frame();
  c.race.state=4;check(!items.throwBanana(k),'Cannot fire after finish');c.race.state=5;check(!items.throwBanana(k),'Cannot fire while paused');c.race.state=1;check(!items.throwBanana(k),'Cannot fire during countdown');c.race.state=2;
  const before=uses;for(let i=0;i<200;i++)check(items.throwBanana(k),'Unlimited uses recycle old hazards');
  check(uses-before===200,'Every accepted press emits use');
  const pool=items.proj.pool;
  for(let i=0;i<pool.length-1;i++){pool[i].kind=2;pool[i].state=2;}
  for(let i=0;i<20;i++)check(items.throwBanana(k),'Reserved slot fires even when all ordinary slots are full');
  const projectile=pool.find(p=>p.kind===5&&p.state===2);
  check(projectile,'Banana projectile exists');
  const opponent=c.race.karts.find(x=>x!==k);opponent.starTime=0;opponent.stunTime=0;opponent.invulnTime=0;
  projectile.pos.copy(opponent.position);projectile.ownerLock=2;
  items.proj.testKarts(c,projectile,[opponent]);check(opponent.stunTime>0,'Banana hit makes opponent lose balance');
  const opponentStun=opponent.stunTime;
  // Exercise the actual projectile integrator against a controlled road.
  items.throwBanana(k);
  const moving=pool.find(p=>p.kind===5&&p.state===2);
  const line=items.proj.line;items.proj.line=null;
  const probe={y:0,normal:k.position.clone().set(0,1,0),surface:0,lateral:0,t:0,edgeRatio:0};
  let wall=false;
  const flatCtx={...c,track:{probe:()=>probe,collideWalls:()=>wall?{}:null}};
  moving.pos.set(0,1,0);moving.vel.set(12,5.5,0);
  let landedX=null;
  for(let i=0;i<120;i++){
    check(items.proj.stepLive(flatCtx,moving,1/60,[]),'Keeps moving before collision');
    if(moving.grounded&&landedX===null)landedX=moving.pos.x;
  }
  check(landedX!==null&&moving.pos.x-landedX>8,'Banana continues moving after landing');
  check(Math.abs(moving.vel.x-12)<.001&&Math.abs(moving.pos.y-.14)<.001,'Ground motion preserves speed and hugs road');
  probe.y=.6;items.proj.stepLive(flatCtx,moving,1/60,[]);check(Math.abs(moving.pos.y-.74)<.001,'Follows road elevation');
  moving.life=-1;items.proj.update(flatCtx,1/60,[]);check(moving.state===2,'No expiry before collision');
  probe.edgeRatio=1.01;check(!items.proj.stepLive(flatCtx,moving,1/60,[])&&moving.state===0,'Road edge removes banana');
  probe.edgeRatio=0;items.throwBanana(k);const wallShot=pool.find(p=>p.kind===5&&p.state===2);wall=true;
  check(!items.proj.stepLive(flatCtx,wallShot,1/60,[])&&wallShot.state===0,'Wall contact removes banana without bouncing');
  wall=false;probe.y=0;
  for(const p of pool)p.state=0;
  items.throwBanana(k);const fast=pool.find(p=>p.state===2);
  fast.pos.set(0,.14,0);fast.vel.set(120,0,0);fast.grounded=true;
  opponent.position.set(6,0,0);opponent.stunTime=0;opponent.invulnTime=0;
  items.proj.update(flatCtx,.1,[opponent]);
  check(fast.state===0&&opponent.stunTime>0,'Fast banana cannot skip an opponent between frames');
  items.proj.line=line;

  for(let i=0;i<1000;i++)check(items.roll(1,8,true)!==5,'Permanent banana excluded from player pickup pool');
  dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF'}));input.update(c,1/60);check(input.state.bananaPressed&&!input.state.itemPressed,'F is a separate keyboard binding');dispatchEvent(new KeyboardEvent('keyup',{code:'KeyF'}));input.update(c,1/60);
  c.race.reset();c.race.state=2;check(items.throwBanana(c.race.player),'Available after race restart');
  return {uses,poolCapacity:pool.length,opponentStun,hud:document.querySelector('.kr-banana-skill')?.textContent};
 });
 assert.match(result.hud,/Y.*香蕉皮.*∞/);assert.deepEqual(errors,[]);console.log(JSON.stringify(result));
 await page.screenshot({path:'docs/previews/japanese-town/banana-skill.png'});
} finally {await browser.close();}
