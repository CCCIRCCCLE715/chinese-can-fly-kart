import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/audio/AudioRecovery.ts',import.meta.url),'utf8'),{mode:'transform'});
const {AudioRecovery}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const flush=()=>new Promise(r=>setImmediate(r));
function context(state='suspended') { return {state,currentTime:0,resumes:0,suspends:0,resume(){this.resumes++;this.state='running';return Promise.resolve();},suspend(){this.suspends++;this.state='suspended';return Promise.resolve();}}; }
test('没有电脑点击时不创建声音，隐藏页面不会尝试恢复',()=>{
 let ac=null,hidden=false;const r=new AudioRecovery(()=>ac,()=>hidden);
 r.resume();r.tick(0);assert.equal(ac,null);
 ac=context();hidden=true;r.resume();r.tick(1);assert.equal(ac.resumes,0);
 hidden=false;r.visibilityChanged();assert.equal(ac.resumes,1);
});
test('上一次恢复还没返回，新的电脑点击仍能立即触发恢复',()=>{
 const ac=context();ac.resume=function(){this.resumes++;return new Promise(()=>{});};
 const r=new AudioRecovery(()=>ac,()=>false);r.resume();r.resume();assert.equal(ac.resumes,2);
});
test('恢复失败不会永久禁用声音，重试有间隔',async()=>{
 const ac=context();ac.resume=function(){this.resumes++;return Promise.reject(new Error('被浏览器阻止'));};
 const r=new AudioRecovery(()=>ac,()=>false);r.tick(0);await flush();r.tick(20);assert.equal(ac.resumes,1);
 r.tick(1001);await flush();assert.equal(ac.resumes,2);
 ac.resume=function(){this.resumes++;this.state='running';return Promise.resolve();};r.resume();assert.equal(ac.state,'running');
});
test('播放时钟冻结会重启已有声音，时钟继续后清除故障状态',async()=>{
 const ac=context('running');const r=new AudioRecovery(()=>ac,()=>false);
 r.tick(0);r.tick(5101);assert.equal(r.stalled,true);await flush();assert.equal(ac.suspends,1);assert.equal(ac.resumes,1);
 ac.currentTime=.2;r.tick(5200);assert.equal(r.stalled,false);
});
test('恢复过程中离开网页或更换声音，不会恢复旧声音',async()=>{
 let hidden=false;const old=context('running');let release;old.suspend=function(){this.suspends++;return new Promise(r=>release=r);};
 let ac=old;const r=new AudioRecovery(()=>ac,()=>hidden);r.tick(0);r.tick(5101);hidden=true;release();await flush();assert.equal(old.resumes,0);
 hidden=false;ac=context('running');r.reset();r.tick(2000);assert.equal(r.stalled,false);assert.equal(ac.resumes,0);
});
test('恢复器不对已停止的声音调用恢复，由已授权的音频系统重建',()=>{
 const ac=context('closed');const r=new AudioRecovery(()=>ac,()=>false);r.tick(0);r.resume();r.visibilityChanged();assert.equal(ac.resumes,0);
});
test('切换标签页不会主动关闭背景音乐，回到页面会恢复浏览器中断',()=>{
 const ac=context('running');let hidden=true;const r=new AudioRecovery(()=>ac,()=>hidden);
 r.visibilityChanged();assert.equal(ac.suspends,0);assert.equal(ac.resumes,0);assert.equal(ac.state,'running');
 ac.state='suspended';hidden=false;r.visibilityChanged();assert.equal(ac.resumes,1);assert.equal(ac.state,'running');
});
