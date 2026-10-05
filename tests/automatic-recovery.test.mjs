import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
function load(file,name,bindings){
 const raw=readFileSync(new URL(file,import.meta.url),'utf8');
 const source=stripTypeScriptTypes(raw,{mode:'transform'}).replace(/^import[\s\S]*?;\n/gm,'').replace(/^export /gm,'');
 const context={...bindings};vm.runInNewContext(source+'\nglobalThis.loaded='+name+';',context);return context.loaded;
}
const Recovery=load('../src/audio/AudioRecovery.ts','AudioRecovery',{});
const clock={now:0};const document={hidden:false};
const Audio=load('../src/audio/Audio.ts','Audio',{
 THREE:{Vector3:class{},Quaternion:class{}},AudioRecovery:Recovery,document,performance:{now:()=>clock.now},EPS:.0001,mtof:()=>0,BASE_TOP_SPEED:1,ItemKind:{},RaceState:{},Surface:{}
});
test('已开启的声音被系统关闭后自动重建，不需要再次点击',()=>{
 const a=new Audio();let repairs=0,pumps=0;
 a.activated=true;a.synth={ctx:{state:'closed',currentTime:0}};
 a.unlock=()=>{repairs++;a.synth={ctx:{state:'running',currentTime:1,resume:()=>Promise.resolve()}}};
 a.music={update:()=>pumps++};clock.now=0;a.pumpAudio();
 assert.equal(repairs,1);assert.equal(pumps,1);
 clock.now=50;a.synth.ctx.currentTime=1.05;a.pumpAudio();assert.equal(repairs,1);assert.equal(pumps,2);
});
test('运行中时钟短暂停顿或恢复器正在恢复时，不重建整套声音',()=>{
 const a=new Audio();let repairs=0,pumps=0;
 a.activated=true;a.synth={ctx:{state:'running',currentTime:0,resume:()=>Promise.resolve(),suspend:()=>Promise.resolve()}};
 a.unlock=()=>repairs++;a.music={update:()=>pumps++};
 clock.now=0;a.pumpAudio();clock.now=2000;a.pumpAudio();
 assert.equal(repairs,0);assert.equal(a.recovery.stalled,false);
 clock.now=6000;a.pumpAudio();assert.equal(repairs,0);assert.equal(pumps,3);
});
test('没有电脑授权或主动静音时，不自动重建声音',()=>{
 const a=new Audio();a.synth={ctx:{state:'closed',currentTime:0}};let repairs=0;a.unlock=()=>repairs++;
 a.pumpAudio();assert.equal(repairs,0);
 a.activated=true;a.muted=true;a.pumpAudio();assert.equal(repairs,0);
});
test('背景音乐的播放安排独立于画面刷新，切到后台不主动暂停声音',()=>{
 const a=new Audio();let pumps=0,suspends=0;
 a.activated=true;a.synth={ctx:{state:'running',currentTime:10,resume:()=>Promise.resolve(),suspend:()=>{suspends++;return Promise.resolve()}}};a.music={update:()=>pumps++};
 document.hidden=true;a.onVisibility();clock.now=200;a.pumpAudio();assert.equal(suspends,0);assert.equal(pumps,1);
 document.hidden=false;
});
test('画面继续刷新而声音时钟暂时停住，不重复挤入声音参数更新',()=>{
 const a=new Audio();let updates=0;
 a.synth={ctx:{state:'running',currentTime:1},setMasterVolume(){},glide(){},reverbReturn:{gain:{}}};
 a.music={setFull(){},setDuck(){},setFinalLap(){},update(){updates++}};
 const ctx={settings:{masterVolume:.8},frame:0};
 for(let i=0;i<200;i++){ctx.frame=i;a.update(ctx,.016);}
 assert.equal(updates,1);
 a.synth.ctx.currentTime=1.01;a.update(ctx,.016);assert.equal(updates,1);
 a.synth.ctx.currentTime=1.04;a.update(ctx,.016);assert.equal(updates,2);
});
const raceStates={Racing:1,Countdown:2,Paused:3,Menu:0};
const Phone=load('../src/remote/PhoneController.ts','PhoneController',{performance:{now:()=>1000},WebSocket:{OPEN:1},RaceState:raceStates});
function phoneHarness(initial=raceStates.Racing){
 let result={active:true,lost:false,age:0};const sent=[],calls=[],classes=new Set();
 const p=Object.create(Phone.prototype);
 Object.assign(p,{wasActive:false,remotePaused:false,pulseAt:0,state:{connected:true,read:()=>result},badge:{},toggle:{},panel:{classList:{remove:c=>classes.delete(c)}},ws:{readyState:1,send:s=>sent.push(JSON.parse(s))}});
 const race={state:initial,setPaused(v){calls.push(v);if(v&&(this.state===1||this.state===2))this.state=3;else if(!v&&this.state===3)this.state=1}};
 return {p,race,calls,sent,classes,read(patch){result={...result,...patch};return p.read({race})}};
}
test('手机中断暂停比赛，新体感输入恢复后自动继续并收起配对页',()=>{
 const h=phoneHarness();h.read();h.read({active:false,lost:true});assert.equal(h.race.state,3);
 h.classes.add('open');h.read({active:true,lost:false});assert.equal(h.race.state,1);assert.equal(h.classes.has('open'),false);assert.deepEqual(h.calls,[true,false]);
});
test('电脑上主动暂停后，手机连接或按键不会自动取消暂停',()=>{
 const h=phoneHarness(raceStates.Paused);h.read();assert.equal(h.race.state,3);assert.deepEqual(h.calls,[]);
 h.read({active:false,lost:true});h.read({active:true,lost:false});assert.equal(h.race.state,3);assert.ok(!h.calls.includes(false));
});
