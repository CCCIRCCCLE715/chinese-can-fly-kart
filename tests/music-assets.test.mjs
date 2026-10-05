import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for (const [mode,speed] of [['menu',1],['race',1],['finale',1.075]]) {
 test(`${mode} 的完整循环没有空段、无效数值或明显跳变`,()=>{
  const b=readFileSync(new URL(`../public/audio/${mode}.wav`,import.meta.url));
  assert.equal(b.toString('ascii',0,4),'RIFF');assert.equal(b.toString('ascii',8,12),'WAVE');
  assert.equal(b.readUInt16LE(20),3);assert.equal(b.readUInt16LE(22),2);assert.equal(b.readUInt16LE(34),32);
  const rate=b.readUInt32LE(24),frames=b.readUInt32LE(40)/8;
  assert.ok(Math.abs(frames/rate-60/(132*speed)/4*128)<1/rate);
  let peak=0,min=Infinity,max=0,seam=0,steps=0,windows=0;
  for(let c=0;c<2;c++){
   let energy=0,count=0,last=b.readFloatLE(44+c*4);
   for(let i=0;i<frames;i++){
    const x=b.readFloatLE(44+(i*2+c)*4);assert.ok(Number.isFinite(x));
    peak=Math.max(peak,Math.abs(x));steps=Math.max(steps,Math.abs(x-last));last=x;
    energy+=x*x;count++;
    if(count===4410){const rms=Math.sqrt(energy/count);min=Math.min(min,rms);max=Math.max(max,rms);energy=count=0;windows++;}
   }
   seam=Math.max(seam,Math.abs(last-b.readFloatLE(44+c*4)));
  }
  assert.ok(peak<16);assert.ok(min>.0001);assert.ok(seam<.00001);
  console.log(JSON.stringify({mode,seconds:frames/rate,windows,minRMS:min,maxRMS:max,peak,seam}));
 });
}
