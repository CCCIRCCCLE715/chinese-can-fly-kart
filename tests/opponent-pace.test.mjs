import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/game/OpponentPace.ts',import.meta.url),'utf8'));
const {OpponentPace}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const racer=(id,d)=>({id,isPlayer:id===0,finished:false,raceDistance:d,forwardSpeed:20});
test('slow latch holds until player catches front; fast latch holds until entire pack passes',()=>{
 const p=new OpponentPace(),player=racer(0,0),first=racer(1,80),last=racer(2,30),k=[player,first,last];
 p.update(k,player,1000,.1);assert.equal(p.mode,'slow');assert.equal(p.base,.85);
 player.raceDistance=35;p.update(k,player,1000,.1);assert.equal(p.mode,'slow');
 player.raceDistance=80;p.update(k,player,1000,.1);assert.equal(p.mode,'normal');
 player.raceDistance=125;for(let n=0;n<23;n++)p.update(k,player,1000,.1);assert.equal(p.mode,'fast');
 first.raceDistance=140;p.update(k,player,1000,.1);assert.equal(p.mode,'fast');
 last.raceDistance=130;p.update(k,player,1000,.1);assert.equal(p.mode,'slow');
});
test('transition takes a quarter lap, pauses do not advance, individual variation is bounded',()=>{
 const p=new OpponentPace(),player=racer(0,0),a=racer(1,30),b=racer(2,40),k=[player,a,b];
 p.update(k,player,1000,.1);
 for(let n=0;n<50;n++){a.raceDistance+=5;b.raceDistance+=5;p.update(k,player,1000,.25);if(n<49)assert.ok(p.base>.60);}
 assert.equal(p.base,.60);const before=p.forKart(1);p.update(k,player,1000,0);assert.equal(p.forKart(1),before);
 assert.ok(new Set([1,2,3,4,5,6,7].map(id=>p.forKart(id))).size===7);
 for(let n=0;n<300;n++){p.update(k,player,1000,.1);for(let id=1;id<=7;id++)assert.ok(Math.abs(p.forKart(id)/p.base-1)<=.060001);}
 p.reset();assert.equal(p.mode,'normal');assert.equal(p.base,.85);
});
test('passage-time gaps work across lap boundaries and finished opponents are excluded',()=>{
 const p=new OpponentPace(),player=racer(0,950),a=racer(1,970),k=[player,a];
 for(let n=0;n<30;n++){player.raceDistance+=2;a.raceDistance+=2;p.update(k,player,1000,.1);}
 assert.equal(p.mode,'normal');player.raceDistance-=5;p.update(k,player,1000,.1);assert.equal(p.mode,'slow');
 a.finished=true;p.update(k,player,1000,.1);assert.equal(p.mode,'normal');
});
