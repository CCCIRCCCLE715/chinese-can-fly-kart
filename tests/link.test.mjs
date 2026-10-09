import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import {WebSocket}from'ws';
const port=process.env.KART_PORT||18765,tlsPort=process.env.KART_TLS_PORT||18766;
const ca=readFileSync(process.env.KART_CERT_DIR+'/ca.pem');
const listen=(ws,match,timeout=3000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',handler);reject(new Error('message timeout'));},timeout);const handler=data=>{const p=JSON.parse(data.toString());if(match(p)){clearTimeout(timer);ws.off('message',handler);resolve(p);}};ws.on('message',handler);});
const open=ws=>new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
const reject=ws=>new Promise(r=>{ws.once('error',()=>r());ws.once('open',()=>{ws.close();r(false);});});
test('配对鉴权、HTTPS 证书、按钮转发、双向耗时、断线与过期通知',async()=>{
 const s=await(await fetch(`http://127.0.0.1:${port}/session`)).json();assert.ok(s.qr.startsWith('data:image/png;base64,'));
 const bad=new WebSocket(`ws://127.0.0.1:${port}/link?role=host&id=${s.id}&key=${'a'.repeat(48)}`);assert.notEqual(await reject(bad),false);
 const host=new WebSocket(`ws://127.0.0.1:${port}/link?role=host&id=${s.id}&key=${s.hostToken}`);await open(host);
 const token=new URL(s.controller).hash.slice(1).split('.')[1];
 const phone=new WebSocket(`wss://127.0.0.1:${tlsPort}/link?role=phone&id=${s.id}&key=${token}`,{ca});await open(phone);
 const duplicate=new WebSocket(`wss://127.0.0.1:${tlsPort}/link?role=phone&id=${s.id}&key=${token}`,{ca});assert.notEqual(await reject(duplicate),false);
 const invalid=new WebSocket(`ws://127.0.0.1:${port}/link?role=phone&id=${s.id}&key=${token}`);assert.notEqual(await reject(invalid),false);
 phone.send('null');phone.send('[]');phone.send('{');
 const received=listen(host,p=>p.type==='input');phone.send(JSON.stringify({type:'input',seq:0,steer:.75,enabled:true,accel:false,brake:false,drift:true,auto:true,item:1,banana:2,gas:3,pause:0,confirm:0}));const forwarded=await received;assert.equal(forwarded.steer,.75);assert.equal(forwarded.item,1);assert.equal(forwarded.banana,2);assert.equal(forwarded.gas,3);
 const ping=listen(host,p=>p.type==='ping');const t=performance.now();phone.send(JSON.stringify({type:'ping',id:7}));const p=await ping;const pong=listen(phone,p=>p.type==='pong');host.send(JSON.stringify({type:'pong',id:p.id}));assert.equal((await pong).id,7);console.log('本机模拟连接往返 ms',+(performance.now()-t).toFixed(2));
 const stale=await listen(host,p=>p.type==='stale');assert.equal(stale.type,'stale');
 const safe=listen(phone,p=>p.type==='safety');host.send(JSON.stringify({type:'safety'}));assert.equal((await safe).type,'safety');
 const off=listen(host,p=>p.type==='status'&&!p.connected);phone.close();await off;host.close();
 const hostile=await fetch(`http://127.0.0.1:${port}/session`,{headers:{Origin:'https://example.com'}});assert.equal(hostile.status,403);
 const leak=await fetch(`http://127.0.0.1:${port}/ca.key`);assert.equal(leak.status,404);
});

test('localhost 游戏页面可与手机建立完整连接，并报告电脑端状态',async()=>{
 const s=await(await fetch(`http://127.0.0.1:${port}/session`)).json();
 const host=new WebSocket(`ws://127.0.0.1:${port}/link?role=host&id=${s.id}&key=${s.hostToken}`,{origin:`http://localhost:${port}`});
 let phone;
 try {
  await open(host);
  const token=new URL(s.controller).hash.slice(1).split('.')[1];
  phone=new WebSocket(`wss://127.0.0.1:${tlsPort}/link?role=phone&id=${s.id}&key=${token}`,{ca});
  const status=listen(phone,p=>p.type==='status');await open(phone);
  assert.equal((await status).hostConnected,true);
  const received=listen(host,p=>p.type==='input');
  phone.send(JSON.stringify({type:'input',seq:0,steer:.5,enabled:true,accel:true,brake:false,drift:false,auto:true,item:0,pause:0,confirm:0}));
  assert.equal((await received).enabled,true);
 } finally {phone?.terminate();host.terminate();}
});
