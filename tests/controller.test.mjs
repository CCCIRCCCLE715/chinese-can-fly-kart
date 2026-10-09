import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {rollDegrees,steerFromTilt,angleDifference,screenAngle} from '../phone/protocol.mjs';
import {createButtonState,stickPosition} from '../phone/controls.mjs';
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} ≠ ${expected}`);
test('两种横屏握持方向都能回中，向右转均为正',()=>{
 for(const angle of [90,270]){
  const gamma=angle===90?-90:90;
  const sign=angle===90?1:-1;
  near(rollDegrees(0,gamma,angle),0);
  near(rollDegrees(sign*26,gamma,angle),26);
  near(rollDegrees(-sign*26,gamma,angle),-26);
 }
 near(rollDegrees(64,90,0),26);
});
test('跨过欧拉角分支与 90 度，方向不会折返或打满',()=>{
 near(rollDegrees(26,-90,90),rollDegrees(154,90,90));
 near(rollDegrees(85,-35,90),rollDegrees(95,35,90));
 const start=rollDegrees(85,-35,90),end=rollDegrees(95,-35,90);
 assert.ok(angleDifference(end,start)>0);
 assert.ok(Math.abs(steerFromTilt(angleDifference(end,start),26))<.3);
 near(angleDifference(-179,179),2);near(angleDifference(179,-179),-2);
 assert.equal(rollDegrees(0,0,90),null);
});
test('苹果横屏角度优先使用手机方向，兼容旧接口和正反横屏',()=>{
 assert.equal(screenAngle({legacy:-90,angle:0,landscape:true}),270);
 assert.equal(screenAngle({angle:90,landscape:true}),90);
 assert.equal(screenAngle({angle:0,landscape:true,type:'landscape-secondary'}),270);
 assert.equal(screenAngle({angle:0,landscape:false}),0);
});
test('多个触点分别持有油门和漂移，松开其中一个不会释放其它键',()=>{
 const b=createButtonState();b.press('accel',1);b.press('drift',2);b.press('drift',3);
 b.release(2);assert.ok(b.held('accel'));assert.ok(b.held('drift'));
 b.release(3);assert.ok(!b.held('drift'));assert.ok(b.held('accel'));
 b.clear();assert.ok(!b.held('accel'));
});
test('摇杆有中位死区和边界，拖出范围也不超出满舵',()=>{
 assert.equal(stickPosition(1,0,50).steer,0);
 near(stickPosition(70,0,50).steer,1);near(stickPosition(-70,0,50).steer,-1);
 const diagonal=stickPosition(100,100,50);near(Math.hypot(diagonal.x,diagonal.y),50);
 assert.ok(diagonal.steer<1&&diagonal.steer>0);
});
function controllerHarness({permission='granted',hostConnected=true,savedSettings=null}={}){
 const elements=new Map();
 const el=id=>{
  if(elements.has(id))return elements.get(id);
  const classes=new Set(),handlers={};
  const e={id,style:{},dataset:{},checked:id==='auto',value:id==='range'?'26':'',textContent:'',attrs:{},handlers,
   classList:{add:(...c)=>c.forEach(v=>classes.add(v)),remove:(...c)=>c.forEach(v=>classes.delete(v)),contains:c=>classes.has(c),toggle(c,b){if(b===undefined)b=!classes.has(c);b?classes.add(c):classes.delete(c)}},
   addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),
   dispatch(name,extra={}){for(const fn of handlers[name]??[])fn({pointerId:1,pointerType:'touch',button:0,preventDefault(){},...extra})},
   setPointerCapture(){},showModal(){this.open=true},close(){this.open=false;this.dispatch('close')}};
  elements.set(id,e);return e;
 };
 for(const [id,action]of [['accel','accel'],['brake','brake'],['drift','drift']])el(id).dataset.hold=action;
 el('item').dataset.tap='item';
 const all=selector=>[...elements.values()].filter(e=>selector==='[data-hold]'?e.dataset.hold:selector==='[data-tap]'?e.dataset.tap:selector==='.held'?e.classList.contains('held'):false);
 const events={},intervals=[],timeouts=[],packets=[],sockets=[];let now=100,wide=true,permissionCalls=0;
 const window={orientation:90,addEventListener:(name,fn)=>(events[name]??=[]).push(fn)};
 const screen={orientation:{angle:90,type:'landscape-primary',addEventListener(){}}};
 const document={hidden:false,getElementById:el,querySelectorAll:all,body:el('body'),addEventListener:(name,fn)=>(events[name]??=[]).push(fn)};
 class Socket{static OPEN=1;readyState=0;bufferedAmount=0;constructor(){sockets.push(this)}send(p){packets.push(JSON.parse(p))}open(){this.readyState=1;this.onopen();this.message({type:'status',connected:true,hostConnected})}close(){this.readyState=3;this.onclose()}message(p){this.onmessage({data:JSON.stringify(p)})}}
 const context={document,window,screen,matchMedia:()=>({matches:wide}),location:{hash:'#'+'a'.repeat(12)+'.'+'b'.repeat(48),protocol:'https:',host:'localhost'},WebSocket:Socket,performance:{now:()=>now},navigator:{},isSecureContext:true,DeviceOrientationEvent:{requestPermission:async()=>{permissionCalls++;return permission}},setInterval:fn=>intervals.push(fn),setTimeout:(fn,ms)=>{timeouts.push({fn,ms});return timeouts.length},clearTimeout(){},rollDegrees,steerFromTilt,angleDifference,screenAngle,createButtonState,localStorage:{getItem:()=>savedSettings,setItem(){}}};
 const source=readFileSync(new URL('../phone/controller.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');vm.runInNewContext(source,context);
 const h={el,packets,sockets,window,events,document,timeouts,
  tick(ms=17){now+=ms;intervals[0]()},
  orientation(beta=0,gamma=-60){now+=20;events.deviceorientation[0]({beta,gamma})},
  stable(beta=0,gamma=-60){for(let i=0;i<12;i++)this.orientation(beta,gamma);this.tick()},
  rotate(angle,isWide=true){window.orientation=angle;screen.orientation.angle=angle;wide=isWide;events.orientationchange[0]()},
  last:()=>packets.filter(p=>p.type==='input').at(-1),
  permissionCalls:()=>permissionCalls};
 sockets[0].open();return h;
}
test('连接后拿稳手机即自动开启体感驾驶，没有驾驶开关键',()=>{
 const h=controllerHarness();assert.equal(h.last().enabled,false);h.stable();assert.equal(h.last().enabled,true);
 near(h.last().steer,0);assert.equal(h.el('motion').hidden,true);assert.equal(h.permissionCalls(),0);
});
test('首次体感授权必须由点击触发，拒绝时不发送驾驶输入',async()=>{
 const h=controllerHarness({permission:'denied'});h.tick();assert.equal(h.permissionCalls(),0);
 await h.el('motion').onclick();assert.equal(h.permissionCalls(),1);assert.equal(h.last().enabled,false);assert.match(h.el('hint').textContent,/允许/);
});
test('手动油门与道具、漂移可同时使用，松开或取消互不干扰',()=>{
 const h=controllerHarness();h.stable();h.el('auto').checked=false;h.el('auto').onchange();
 h.el('accel').dispatch('pointerdown',{pointerId:11});h.el('item').dispatch('pointerdown',{pointerId:12});h.el('drift').dispatch('pointerdown',{pointerId:13});
 assert.ok(h.last().accel&&h.last().drift&&!h.last().auto);assert.equal(h.last().item,1);
 h.el('item').dispatch('pointerup',{pointerId:12});assert.ok(h.last().accel&&h.last().drift);
 h.el('drift').dispatch('pointercancel',{pointerId:13});assert.ok(!h.last().drift&&h.last().accel);
 h.el('accel').dispatch('lostpointercapture',{pointerId:11});assert.equal(h.last().accel,false);
 h.el('item').dispatch('click',{detail:1});assert.equal(h.last().item,1);
});
test('横屏体感左右方向正确、手动校准回中、换横屏方向自动重新定中位',()=>{
 const h=controllerHarness();h.stable();h.orientation(15,-60);h.tick();assert.ok(h.last().steer>0);
 h.orientation(-15,-60);for(let i=0;i<8;i++)h.tick();assert.ok(h.last().steer<0);
 h.el('calibrate').onclick();h.tick();near(h.last().steer,0);
 h.rotate(-90);assert.equal(h.last().enabled,false);h.stable(0,60);assert.equal(h.last().enabled,true);near(h.last().steer,0);
 h.rotate(0,false);assert.equal(h.last().enabled,false);
});
test('手机离开前台释放所有按键，回来自动恢复且不残留旧油门和道具触点',()=>{
 const h=controllerHarness();h.stable();h.el('accel').dispatch('pointerdown',{pointerId:21});h.el('item').dispatch('pointerdown',{pointerId:22});
 h.document.hidden=true;h.events.visibilitychange[0]();assert.equal(h.last().enabled,false);assert.equal(h.last().accel,false);
 h.stable();assert.equal(h.last().enabled,false);
 h.document.hidden=false;h.events.visibilitychange[0]();h.stable();assert.equal(h.last().enabled,true);assert.equal(h.last().accel,false);
 h.el('item').dispatch('pointerdown',{pointerId:23});assert.equal(h.last().item,2);
 h.el('item').dispatch('pointerup',{pointerId:22});assert.ok(h.el('item').classList.contains('held'));
 h.el('item').dispatch('pointercancel',{pointerId:23});assert.ok(!h.el('item').classList.contains('held'));
});
test('进入设置暂停操控，关闭设置自动恢复，设置中体感更新不会启动',()=>{
 const h=controllerHarness();h.stable();h.el('settings-open').onclick();assert.equal(h.last().enabled,false);
 h.stable();assert.equal(h.last().enabled,false);
 h.el('settings-close').onclick();assert.equal(h.last().enabled,true);
});
test('连接恢复自动驾驶，先发送清空包，不复用未松开的按键',()=>{
 const h=controllerHarness();h.stable();h.el('accel').dispatch('pointerdown',{pointerId:31});
 h.sockets[0].close();assert.equal(h.last().enabled,true); // Last packet was sent before the closed socket.
 h.timeouts.find(t=>t.ms===1500).fn();h.sockets[1].open();
 const inputs=h.packets.filter(p=>p.type==='input');assert.equal(inputs.at(-2).enabled,false);assert.equal(inputs.at(-1).enabled,true);assert.equal(inputs.at(-1).accel,false);
});
test('体感停止更新会停住，重新收到数据后自动恢复；平放时不打满舵',()=>{
 const h=controllerHarness();h.stable();h.tick(700);assert.equal(h.last().enabled,false);
 h.orientation();h.tick();assert.equal(h.last().enabled,true);
 h.orientation(0,0);h.tick();assert.equal(h.last().enabled,false);near(h.last().steer,0);
});

test('只连上中转服务时不显示已连接，电脑上线后才启用操控',()=>{
 const h=controllerHarness({hostConnected:false});h.stable();
 assert.equal(h.last().enabled,false);assert.match(h.el('connection').textContent,/等待电脑/);
 h.sockets[0].message({type:'status',connected:true,hostConnected:true});
 assert.equal(h.last().enabled,true);assert.match(h.el('connection').textContent,/体感驾驶中/);
});

test('phone steering is 35 percent of original strength and auto throttle starts enabled',()=>{
 const h=controllerHarness();h.stable();assert.equal(h.last().auto,true);
 for(let i=0;i<30;i++){h.orientation(26,-90);h.tick();}
 near(h.last().steer,.35);
});


test('unified item button sends one use per press; legacy auto-off is reset on opening',()=>{
 const h=controllerHarness({savedSettings:JSON.stringify({auto:false,range:26,invert:false})});h.stable();
 assert.equal(h.last().auto,true);
 h.el('item').dispatch('pointerdown',{pointerId:51});h.el('item').dispatch('pointerdown',{pointerId:52});
 assert.equal(h.last().item,1);
 h.el('item').dispatch('pointerup',{pointerId:51});h.el('item').dispatch('click',{detail:1});assert.equal(h.last().item,1);
 h.el('item').dispatch('pointerdown',{pointerId:53});assert.equal(h.last().item,2);
 const html=readFileSync(new URL('../phone/index.html',import.meta.url),'utf8');
 assert.deepEqual([...html.matchAll(/data-tap="([^"]+)"/g)].map(m=>m[1]),['item']);
});
