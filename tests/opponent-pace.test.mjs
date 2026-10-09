import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/game/OpponentPace.ts',import.meta.url),'utf8'));
const {OpponentPace}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const racer=(id,d)=>({id,isPlayer:id===0,finished:false,raceDistance:d,forwardSpeed:20});
test('each distant opponent latches separately at five seconds until the player is passed',()=>{
 const p=new OpponentPace(),player=racer(0,200),front=racer(1,310),tail=racer(2,80),near=racer(3,205),k=[player,front,tail,near];
 p.update(k,player,1000,.1);assert.equal(p.stateFor(1).mode,'slow');assert.equal(p.stateFor(2).mode,'fast');assert.equal(p.stateFor(3).mode,'normal');
 // Closing to within five seconds must not end the catch-up before an overtake.
 for(const o of [front,tail])o.raceDistance=190;
 p.update(k,player,1000,.1);assert.equal(p.stateFor(1).mode,'normal');assert.equal(p.stateFor(2).mode,'fast');
 tail.raceDistance=201;p.update(k,player,1000,.1);assert.equal(p.stateFor(2).mode,'normal');
});
test('offscreen speed adjustment completes in one second; visible adjustment takes quarter lap',()=>{
 const p=new OpponentPace(),player=racer(0,0),a=racer(1,120),b=racer(2,120),k=[player,a,b];
 p.update(k,player,1000,.1,new Set([1]));
 for(let n=0;n<10;n++){a.raceDistance+=2;b.raceDistance+=2;p.update(k,player,1000,.1,new Set([1]));}
 assert.ok(p.stateFor(1).base>.8);assert.equal(p.stateFor(2).base,.60);
 const needed=250-p.stateFor(1).travelled;
 for(let n=0;n<Math.ceil(needed/2);n++){a.raceDistance+=2;b.raceDistance+=2;p.update(k,player,1000,.1,new Set([1]));}
 assert.equal(p.stateFor(1).base,.60);
 const before=p.forKart(1);p.update(k,player,1000,0,new Set());assert.equal(p.forKart(1),before);
});
test('pack compression boosts the tail and restrains the front before a five second spread',()=>{
 const p=new OpponentPace(),player=racer(0,150),front=racer(1,200),tail=racer(2,110),k=[player,front,tail];
 for(let n=0;n<10;n++)p.update(k,player,1000,.1,new Set());
 assert.equal(p.stateFor(1).mode,'normal');assert.equal(p.stateFor(2).mode,'normal');
 assert.ok(p.stateFor(1).cohesion<0);assert.ok(p.stateFor(2).cohesion>0);
 assert.ok(p.forKart(2)>p.forKart(1));
});
test('a moving seven-car pack remains inside the five second envelope with independent variation',()=>{
 const p=new OpponentPace(),player=racer(0,100),k=[player,...Array.from({length:7},(_,n)=>racer(n+1,80+n*8))];
 const histories=new Map(k.slice(1).map(o=>[o.id,[]]));
 for(let n=0;n<2400;n++){
  player.raceDistance+=20*.1;
  for(const o of k.slice(1)){o.forwardSpeed=24*p.forKart(o.id);o.raceDistance+=o.forwardSpeed*.1;}
  p.update(k,player,1200,.1,new Set());
  const others=k.slice(1).sort((a,b)=>b.raceDistance-a.raceDistance);
  for(const o of others)histories.get(o.id).push(o.raceDistance);
  // The tail must have passed where the current leader was five seconds ago.
  if(n>=50)assert.ok(histories.get(others[0].id)[n-50]<=others.at(-1).raceDistance,'pack broke apart');
 }
 p.reset();for(let id=1;id<=7;id++)assert.equal(p.stateFor(id).base,.85);
 const values=[1,2,3,4,5,6,7].map(id=>p.forKart(id));assert.equal(new Set(values).size,7);
 for(const v of values)assert.ok(Math.abs(v/.85-1)<=.06);
});
test('exact five seconds does not trigger, total distance crosses lap seams, finished cars are ignored',()=>{
 const p=new OpponentPace(),player=racer(0,950),a=racer(1,1050),k=[player,a];
 p.update(k,player,1000,.1);assert.equal(p.stateFor(1).mode,'normal');
 a.raceDistance=1051; // Clear history to model an initial gap just beyond the threshold.
 p.reset();p.update(k,player,1000,.1);assert.equal(p.stateFor(1).mode,'slow');
 a.finished=true;p.update(k,player,1000,.1);assert.equal(p.stateFor(1).mode,'normal');
});

test('three stable front runners immediately retake after being passed, even while visible',()=>{
 const p=new OpponentPace(),player=racer(0,100),others=Array.from({length:7},(_,n)=>racer(n+1,104+n*8)),k=[player,...others];
 p.update(k,player,1200,.1,new Set(others.map(o=>o.id)));
 const leaders=others.filter(o=>p.stateFor(o.id).leadGuard);assert.equal(leaders.length,3);
 const ids=leaders.map(o=>o.id);player.raceDistance=150;player.forwardSpeed=35;
 for(let n=0;n<8;n++){p.update(k,player,1200,.05,new Set(ids));}
 for(const o of leaders){assert.equal(p.stateFor(o.id).leadGuard,true);assert.equal(p.stateFor(o.id).retaking,true);assert.ok(p.forKart(o.id)>1.3,'visible retake must accelerate rapidly');assert.ok(p.assistFor(o.id)>0);}
 // Do not switch identities to cars that happen to be ahead on the next frame.
 assert.deepEqual(others.filter(o=>p.stateFor(o.id).leadGuard).map(o=>o.id),ids);
 for(const o of leaders)o.raceDistance=player.raceDistance+30;
 p.update(k,player,1200,.1,new Set(ids));for(const o of leaders)assert.equal(p.stateFor(o.id).retaking,false);
 leaders[0].finished=true;p.update(k,player,1200,.1,new Set());
 assert.equal(others.filter(o=>!o.finished&&p.stateFor(o.id).leadGuard).length,3);
 player.finished=true;for(let n=0;n<30;n++)p.update(k,player,1200,.1,new Set());
 for(const o of others){assert.equal(p.stateFor(o.id).leadGuard,false);assert.equal(p.assistFor(o.id),0);}
});

test('front runners recover three places after a fast player overtakes the entire pack',()=>{
 const p=new OpponentPace(),player=racer(0,100),others=Array.from({length:7},(_,n)=>racer(n+1,105+n*5)),k=[player,...others];
 p.update(k,player,1200,.1,new Set());player.raceDistance=145;player.forwardSpeed=32;
 for(let n=0;n<150;n++){
  player.raceDistance+=player.forwardSpeed*.1;
  for(const o of others){o.forwardSpeed=30*p.forKart(o.id);o.raceDistance+=o.forwardSpeed*.1;}
  p.update(k,player,1200,.1,new Set(others.map(o=>o.id)));
 }
 assert.ok(others.filter(o=>o.raceDistance>player.raceDistance).length>=3,'three cars must recover the lead');
});
