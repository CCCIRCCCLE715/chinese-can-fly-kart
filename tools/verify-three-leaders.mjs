import puppeteer from 'puppeteer';import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:18765/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const result=await page.evaluate(()=>{
  window.__freeze=true;const c=window.__ctx,r=c.race,k=r.player,ai=r.ai,others=r.karts.filter(o=>o!==k);
  const check=(ok,m)=>{if(!ok)throw Error(m)};r.start();r.state=2;
  ai.reset();k.raceDistance=100;k.forwardSpeed=30;others.forEach((o,n)=>{o.raceDistance=105+n*8;o.forwardSpeed=25;});
  ai.beginFrame(r.karts,k,.05,c.camera);
  const leaders=others.filter(o=>ai.pace.stateFor(o.id).leadGuard);check(leaders.length===3,'not three leaders');
  k.raceDistance=150;k.forwardSpeed=40;
  for(let n=0;n<12;n++)ai.beginFrame(r.karts,k,.05,c.camera);
  for(const o of leaders){check(ai.pace.stateFor(o.id).retaking,'leader not retaking');check(o.paceScale>1.5,'not enough pace');check(ai.assistFor(o)>0,'no extra acceleration');}
  const retakeRates=leaders.map(o=>({id:o.id,pace:o.paceScale,assist:ai.assistFor(o)}));
  // Complete physics / AI / race bookkeeping, starting with the player ahead.
  r.reset();r.state=2;r.autoDrive=true;
  for(const o of r.karts){
   const d=250+(o===k?45:o.id*3),f=c.track.sampleByDistance(d);
   o.position.copy(f.pos);o.position.y+=.1;o.t=f.t;o.yaw=Math.atan2(f.tangent.x,f.tangent.z);o.velocity.copy(f.tangent).multiplyScalar(25);
   o.updateBasis(1);o.raceDistance=d;o.rocketTime=0;o.stunTime=0;o.invulnTime=0;
   r.prog[o.id].cp=c.track.checkpointAt(f.t);r.prog[o.id].lapIndex=0;
  }
  ai.reset();let firstRecovered=null;const snapshots=[];
  for(let n=0;n<800;n++){
   r.update(c,.05);
   const ahead=others.filter(o=>o.raceDistance>k.raceDistance).length;
   if(ahead>=3&&firstRecovered===null)firstRecovered=(n+1)*.05;
   if(n%200===199)snapshots.push({seconds:(n+1)*.05,ahead});
  }
  check(firstRecovered!==null,'actual cars never recovered three positions');
  const finalAhead=others.filter(o=>o.raceDistance>k.raceDistance).length;
  check(snapshots.every(s=>s.ahead>=3),JSON.stringify({snapshots,leaders:others.filter(o=>ai.pace.stateFor(o.id).leadGuard).map(o=>({id:o.id,distance:o.raceDistance,speed:o.forwardSpeed,stun:o.stunTime,...ai.pace.stateFor(o.id)}))}));
  check(finalAhead>=3,JSON.stringify({snapshots,player:{distance:k.raceDistance,speed:k.forwardSpeed},cars:others.map(o=>({id:o.id,distance:o.raceDistance,speed:o.forwardSpeed,stun:o.stunTime,t:o.t,pace:o.paceScale,...ai.pace.stateFor(o.id)}))}));
  check(k.paceScale===1,'player pace changed');
  r.reset();r.state=2;ai.beginFrame(r.karts,k,.01,c.camera);
  check(others.filter(o=>ai.pace.stateFor(o.id).leadGuard).length===3,'reset leaders');
  return {leaderIds:leaders.map(o=>o.id),retakeRates,firstRecoveredSeconds:firstRecovered,snapshots,finalAhead,playerUnaffected:true};
 });assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors},null,2));
}finally{await browser.close()}
