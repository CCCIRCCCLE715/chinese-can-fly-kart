import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/remote/RemoteState.ts',import.meta.url),'utf8'));
const { RemoteState }=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
import { validateInput,rollDegrees,steerFromTilt } from '../runtime/protocol.mjs';
const packet=(seq,patch={})=>({type:'input',seq,steer:0,enabled:true,accel:false,brake:false,drift:false,auto:true,item:0,pause:0,confirm:0,...patch});
test('方向在正反横屏和竖屏保持正确，死区与限幅',()=>{
 assert.ok(Math.abs(rollDegrees(64,90,0)-26)<1e-10);assert.ok(Math.abs(rollDegrees(26,-90,90)-26)<1e-10);assert.ok(Math.abs(rollDegrees(-26,90,270)-26)<1e-10);
 assert.equal(steerFromTilt(1.9,26),0);assert.equal(steerFromTilt(26,26),1);assert.equal(steerFromTilt(-40,26),-1);assert.equal(steerFromTilt(26,26,true),-1);
});
test('网络输入拒绝非有限值、越界角度、非法按钮和序号',()=>{
 assert.ok(validateInput(packet(0)));for(const patch of [{steer:NaN},{steer:2},{seq:-1},{seq:1.5},{drift:'true'},{item:-1},{pause:1e10}])assert.equal(validateInput(packet(0,patch)),null);
});
test('跨多个网络更新的短按被保留，仅消费一次',()=>{
 const r=new RemoteState();r.receive(packet(0),10);r.read(10);r.receive(packet(1,{item:1,drift:true}),20);r.receive(packet(2,{item:1,drift:false}),30);
 assert.equal(r.read(30).events.item,true);assert.equal(r.read(31).events.item,false);assert.equal(r.read(31).packet.drift,false);
});
test('旧包不能覆盖新的方向或制造按钮事件',()=>{
 const r=new RemoteState();r.receive(packet(1,{steer:.5}),10);r.receive(packet(0,{steer:-1,item:1}),20);const v=r.read(25);assert.equal(v.packet.steer,.5);assert.equal(v.events.item,false);
});
test('超时会释放输入、触发暂停，不能靠恢复旧油门自动复活',()=>{
 const r=new RemoteState();r.receive(packet(0),10);assert.equal(r.read(10).active,true);const stale=r.read(611);assert.equal(stale.active,false);assert.equal(stale.lost,true);
 r.receive(packet(1),620);assert.equal(r.read(620).active,false);r.receive(packet(2,{enabled:false}),630);r.read(630);r.receive(packet(3),640);assert.equal(r.read(640).active,true);
});
test('服务器超时通知不吞掉暂停事件',()=>{
 const r=new RemoteState();r.receive(packet(0),1);r.read(1);r.markStale();assert.equal(r.read(2).lost,true);assert.equal(r.read(3).lost,false);
});
test('主动停止和断线暂停，并清除长按与旧计数',()=>{
 const r=new RemoteState();r.receive(packet(0,{drift:true}),10);r.read(10);r.receive(packet(1,{enabled:false}),20);assert.equal(r.read(20).lost,true);
 r.receive(packet(2,{enabled:true,drift:true}),30);r.read(30);r.disconnect();const gone=r.read(40);assert.equal(gone.lost,true);assert.equal(gone.packet,null);
 r.receive(packet(0,{enabled:false,item:5}),50);assert.equal(r.read(50).events.item,false);
});
