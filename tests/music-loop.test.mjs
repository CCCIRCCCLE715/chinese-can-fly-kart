import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness({delayed=false,failed=false}={}){
 const sources=[],gains=[];let fetches=0,resolve;
 const pending=new Promise(r=>resolve=r);
 const source=stripTypeScriptTypes(readFileSync(new URL('../src/audio/Music.ts',import.meta.url),'utf8'),{mode:'transform'}).replace(/^import.*?;\n/gm,'').replace('export class Music','class Music');
 const clock={now:0};
 const ctx={state:'running',currentTime:0,decodeAudioData:async()=>({duration:14}),
  createBufferSource(){const n={starts:[],stops:0,disconnects:0,connect(){},start(t){this.starts.push(t)},stop(){this.stops++},disconnect(){this.disconnects++}};sources.push(n);return n},
  createGain(){const gain={value:0,cancelAndHoldAtTime(){},setTargetAtTime(v,t,tau){this.value=v;this.target=[v,t,tau]}};const n={gain,connect(){},disconnect(){}};gains.push(n);return n}
 };
 const environment={performance:{now:()=>clock.now},console:{warn(){}},fetch:async()=>{fetches++;if(delayed)await pending;return {ok:!failed,status:failed?404:200,arrayBuffer:async()=>new ArrayBuffer(44)}}};
 vm.runInNewContext(source+'\nglobalThis.Music=Music;',environment);
 const s={ctx,music:{},get now(){return ctx.currentTime}};
 return {music:new environment.Music(s),clock,ctx,sources,gains,release:()=>resolve(),get fetches(){return fetches}};
}
test('画面停顿几十秒，音乐仍由三个完整循环播放，不补排音符也不挤占音效',async()=>{
 const h=harness();h.music.start();await flush();assert.equal(h.sources.length,3);
 for(const n of h.sources){assert.equal(n.loop,true);assert.deepEqual(n.starts,[.03]);}
 assert.equal(h.gains[0].gain.value,1);
 h.ctx.currentTime=65;h.clock.now=65000;h.music.update();
 assert.equal(h.sources.length,3);assert.equal(h.fetches,3);
 for(const n of h.sources){assert.equal(n.stops,0);assert.deepEqual(n.starts,[.03]);}
});
test('菜单、比赛、最后一圈、暂停往返时始终有一条音乐，交叉淡入淡出',async()=>{
 const h=harness();h.music.start();await flush();
 h.music.setFull(true);assert.deepEqual(h.gains.map(n=>n.gain.value),[0,1,0]);
 h.music.setFinalLap(true);assert.deepEqual(h.gains.map(n=>n.gain.value),[0,0,1]);
 h.music.setFull(false);assert.deepEqual(h.gains.map(n=>n.gain.value),[1,0,0]);
 h.music.setFull(true);assert.deepEqual(h.gains.map(n=>n.gain.value),[0,0,1]);
 assert.equal(h.sources.length,3);assert.ok(h.gains.every(n=>n.gain.target[2]===.12));
});
test('加载期间进入比赛，加载完成后直接播放当前比赛曲目',async()=>{
 const h=harness({delayed:true});h.music.start();h.music.setFull(true);h.music.setFinalLap(true);h.release();await flush();
 assert.deepEqual(h.gains.map(n=>n.gain.value),[0,0,1]);
});
test('关闭声音图后，尚未完成的加载不会留下旧声音',async()=>{
 const h=harness({delayed:true});h.music.start();h.music.stop();h.release();await flush();assert.equal(h.sources.length,0);
});
test('释放全部播放源，重建时复用已下载的曲子',async()=>{
 const h=harness();h.music.start();await flush();h.music.stop();assert.ok(h.sources.every(n=>n.stops===1&&n.disconnects===1));
 h.music.start();await flush();assert.equal(h.sources.length,6);assert.equal(h.fetches,3);
});
test('音轨暂时读取失败可重试，同时限制重试次数',async()=>{
 const h=harness({failed:true});h.music.start();await flush();assert.equal(h.sources.length,0);assert.equal(h.fetches,3);
 h.clock.now=100;h.music.update();assert.equal(h.fetches,3);
 h.clock.now=5100;h.music.update();await flush();assert.equal(h.fetches,6);
});
