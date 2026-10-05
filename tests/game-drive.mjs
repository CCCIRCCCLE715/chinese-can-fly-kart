import {WebSocket}from'ws';import{readFileSync}from'node:fs';
const [id,key]=process.env.KART_TEST_PAIR.split('.');
const ws=new WebSocket(`wss://127.0.0.1:18766/link?role=phone&id=${id}&key=${key}`,{ca:readFileSync(process.env.KART_CERT_DIR+'/ca.pem')});
let seq=0,confirm=0,pause=0,driving=false;const start=performance.now();const delays=[];const pings=new Map();let ping=0;
function send(){if(ws.readyState===1)ws.send(JSON.stringify({type:'input',seq:seq++,steer:0,enabled:driving,accel:false,brake:false,drift:false,auto:true,item:0,pause,confirm}));}
ws.on('open',()=>{send();setTimeout(()=>{driving=true;confirm++;send();},1000);setTimeout(()=>{confirm++;send();},2500);});
ws.on('message',b=>{const p=JSON.parse(b);if(p.type==='pong'&&pings.has(p.id)){delays.push(performance.now()-pings.get(p.id));pings.delete(p.id);}if(p.type==='safety'){console.log('safety at',Math.round(performance.now()-start));driving=false;}});
ws.on('error',e=>{console.error(e.message);process.exit(1);});
const frames=setInterval(send,1000/60);
const timer=setInterval(()=>{if(ws.readyState===1){const id=++ping;pings.set(id,performance.now());ws.send(JSON.stringify({type:'ping',id}));}},1000);
setTimeout(()=>{pause++;send();console.log('已模拟加速，当前发送暂停');},20000);
setTimeout(()=>{pause++;send();console.log('已发送明确继续');},35000);
setTimeout(()=>{clearInterval(frames);clearInterval(timer);ws.close();console.log(JSON.stringify({browserRoundTripMs:delays.map(x=>+x.toFixed(1)),test:'断开手机后应暂停'}));},50000);
