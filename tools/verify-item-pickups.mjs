import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewport({width:1280,height:800});await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,i=c.items,k=r.player;
  const check=(ok,msg)=>{if(!ok)throw Error(msg)};
  r.start();r.state=2;i.reset();
  check(!i.use(k,false)&&!i.throwBanana(k)&&!i.releaseGas(k),'empty inventory must reject all items');
  check(i.boxMesh.visible&&i.markMesh.visible&&!i.rocketMeshes.some(m=>m.visible),'original question mark boxes');
  const random=Math.random,rolls=[];
  try{for(const n of [.01,.4,.9]){Math.random=()=>n;rolls.push(i.roll(1,8));}}finally{Math.random=random}
  check(new Set(rolls).size===3&&rolls.every(n=>[5,9,10].includes(n)),'only three random rewards');
  for(const kind of [5,10]){
   i.give(k,kind);check(i.held(k).kind===kind&&i.held(k).count===3,'three charges');
   check(!i.use(k,false),'roulette must arm first');i.slot(k).arm=0;
   i.pickup(k);check(i.held(k).kind===kind&&i.held(k).count===3,'occupied inventory retained');
   for(let left=2;left>=0;left--){i.slot(k).arm=0;check(i.use(k,false),'unified use');check(i.held(k).count===left,'charge decrement');}
   check(i.held(k).kind===0&&!i.use(k,false),'exhaustion');
  }
  i.give(k,9);i.slot(k).arm=0;check(i.held(k).count===1&&i.use(k,false)&&k.rocketTime===3,'rocket single use');
  k.rocketTime=0;i.reset();const box=i.boxes[0];box.down=0;box.scale=1;k.position.copy(box.pos);
  i.updateBoxes(1/60,[k],0);check(box.down>0&&[5,9,10].includes(i.held(k).kind),'actual box pickup');
  r.state=5;i.slot(k).arm=0;const before=i.held(k).count;check(!i.use(k,false)&&i.held(k).count===before,'pause cannot spend');
  r.state=2;i.reset();check(i.held(k).kind===0,'reset starts empty');
  check(!document.querySelector('.kr-banana-skill')&&!document.querySelector('.kr-gas-skill'),'single HUD slot');
  i.give(k,10);i.slot(k).arm=0;
  document.querySelector('.kr-item').click();check(i.held(k).count===2&&i.gas.clouds.length===1,'HUD generic use');
  return {rolls,bananaCharges:3,gasCharges:3,rocketCharges:1,originalBoxes:true,unifiedUse:true};
 });
 await new Promise(r=>setTimeout(r,300));await page.screenshot({path:'docs/previews/unified-item-game.png'});
 const pad=await browser.newPage();await pad.setViewport({width:844,height:390,isMobile:true,hasTouch:true});await pad.goto('http://127.0.0.1:18765/controller/',{waitUntil:'networkidle0'});
 assert.deepEqual(await pad.evaluate(()=>[...document.querySelectorAll('[data-tap]')].map(e=>e.dataset.tap)),['item']);
 assert.equal(await pad.$eval('#auto',e=>e.checked),true);
 await pad.screenshot({path:'docs/previews/unified-phone-controller.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,phoneSingleButton:true,errors},null,2));
}finally{await browser.close()}
