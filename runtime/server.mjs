import http from 'node:http';
import https from 'node:https';
import { readFile, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash, X509Certificate } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { validateInput, INPUT_TIMEOUT } from './protocol.mjs';
const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const certDir=resolve(process.env.KART_CERT_DIR || resolve(base,'.local/certs'));
const ip=readFileSync(resolve(certDir,'ip.txt'),'utf8').trim();
const port=Number(process.env.KART_PORT||18765), tlsPort=Number(process.env.KART_TLS_PORT||18766);
const rootKey=createHash('sha256').update(base).digest('hex');
const certFingerprint=new X509Certificate(readFileSync(resolve(certDir,'server.pem'))).fingerprint256;
const rooms=new Map();
const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const equal=(a,b)=>typeof a==='string'&&/^[a-f0-9]+$/.test(a)&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function reply(res,status,body,type='application/json') {res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(type==='application/json'?JSON.stringify(body):body);}
function handler(req,res) {
 let url;try {url=new URL(req.url,'http://localhost');} catch{return reply(res,400,{error:'bad request'});}
 if(req.method!=='GET') return reply(res,405,{error:'method'});
 if(url.pathname==='/health') return reply(res,200,{ok:true,ip,port,tlsPort,phoneControllerVersion:2,rootKey,certFingerprint});
 if(url.pathname==='/session') {
  if(!local(req)||req.headers.origin) return reply(res,403,{error:'local only'});
  if(rooms.size>=32) return reply(res,503,{error:'too many sessions'});
  const id=randomBytes(6).toString('hex'),hostToken=randomBytes(24).toString('hex'),token=randomBytes(24).toString('hex');
  const room={id,hostToken,token,host:null,phone:null,last:0,seq:-1,created:Date.now(),lost:false};rooms.set(id,room);
  const controller=`https://${ip}:${tlsPort}/controller/#${id}.${token}`;
  const setup=`http://${ip}:${port}/setup`;
  Promise.all([QRCode.toDataURL(controller),QRCode.toDataURL(setup)]).then(([qr,setupQr])=>reply(res,200,{id,hostToken,controller,setup,qr,setupQr})).catch(()=>reply(res,500,{error:'QR'}));return;
 }
 if(url.pathname==='/setup') return reply(res,200,`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接赛车手柄</title><style>body{font:17px system-ui;max-width:650px;padding:28px;margin:auto;line-height:1.8;background:#101824;color:#eee}a{color:#ffd16e}li{margin:15px 0}</style><h1>苹果手机 首次连接</h1><p>手机和电脑连接同一个 无线网络。以下证书用于这台电脑的本地赛车手柄。</p><ol><li><a href="/kart-controller.mobileconfig">下载本地连接证书</a>，允许下载描述文件。</li><li>打开「设置 → 通用 → VPN 与设备管理」，找到「中国人能飞：卡丁车 · 体感手柄」，安装。</li><li>打开「设置 → 通用 → 关于本机 → 证书信任设置」，开启该证书的完全信任。</li><li>返回电脑，扫描「打开手柄」二维码。将手机横向握持，首次点击「启用体感」并允许访问运动与方向，拿稳手机后自动进入驾驶。</li></ol><p>如果出现证书错误，请回到上述步骤完成安装与信任，不要跳过安全警告。用完可在 VPN 与设备管理中移除此证书。</p></html>`,'text/html; charset=utf-8');
 if(url.pathname==='/kart-controller.mobileconfig') return reply(res,200,readFileSync(resolve(certDir,'kart-controller.mobileconfig')),'application/x-apple-aspen-config');
 if(url.pathname==='/kart-controller.cer') return reply(res,200,readFileSync(resolve(certDir,'kart-controller.cer')),'application/x-x509-ca-cert');
 const folder=url.pathname.startsWith('/controller')?resolve(base,'phone'):resolve(base,'dist');
 let path;try {path=decodeURIComponent(url.pathname);}catch{return reply(res,400,{error:'path'});}
 let relative=path.startsWith('/controller')?path.replace(/^\/controller\/?/,''):path.slice(1);
 if(!relative) relative='index.html';
 const file=resolve(folder,relative);
 if(!file.startsWith(folder+sep)) return reply(res,403,{error:'path'});
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.wav':'audio/wav','.map':'application/json'}[extname(file)]||'application/octet-stream';
 readFile(file,(err,body)=>err?reply(res,404,{error:'not found'}):reply(res,200,body,mime));
}
const plain=http.createServer(handler),secure=https.createServer({key:readFileSync(resolve(certDir,'server.key')),cert:readFileSync(resolve(certDir,'server.pem'))},handler);
const wss=new WebSocketServer({noServer:true,maxPayload:2048});
function upgrade(req,socket,head) {
 let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}const room=rooms.get(url.searchParams.get('id'));const role=url.searchParams.get('role');const key=url.searchParams.get('key');
 const allowedOrigins=role==='host'
  ? [`${req.socket.encrypted?'https':'http'}://127.0.0.1:${req.socket.encrypted?tlsPort:port}`,`${req.socket.encrypted?'https':'http'}://localhost:${req.socket.encrypted?tlsPort:port}`]
  : [`https://${ip}:${tlsPort}`];
 const valid=room&&url.pathname==='/link'&&(role==='host'?local(req)&&equal(key,room.hostToken)&&!room.host:role==='phone'&&equal(key,room.token)&&!room.phone&&req.socket.encrypted)&&(!req.headers.origin||allowedOrigins.includes(req.headers.origin));
 if(!valid){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>{room[role==='host'?'host':'phone']=ws;ws.role=role;ws.room=room;room.seq=-1;room.lost=false;broadcast(room,{type:'status',connected:!!room.phone,hostConnected:!!room.host});wss.emit('connection',ws);});
}
plain.on('upgrade',upgrade);secure.on('upgrade',upgrade);
function send(ws,p){if(ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<65536)ws.send(JSON.stringify(p));}
function broadcast(room,p){send(room.host,p);send(room.phone,p);}
wss.on('connection',ws=>{
 ws.on('message',buffer=>{let p;try{p=JSON.parse(buffer.toString());}catch{return;}if(!p||typeof p!=='object')return;
  const r=ws.room;
  if(ws.role==='phone') {
   if(p.type==='input'){const v=validateInput(p);if(!v||v.seq<=r.seq)return;r.seq=v.seq;r.last=Date.now();r.lost=false;send(r.host,v);}
   else if(p.type==='ping'&&Number.isSafeInteger(p.id))send(r.host,{type:'ping',id:p.id});
  } else if(p.type==='safety')send(r.phone,{type:'safety'});
  else if(p.type==='pong'&&Number.isSafeInteger(p.id))send(r.phone,{type:'pong',id:p.id});
 });
 ws.on('error',()=>{});
 ws.on('close',()=>{const r=ws.room;if(ws.role==='phone'){r.phone=null;r.seq=-1;broadcast(r,{type:'status',connected:false});}else{r.host=null;send(r.phone,{type:'status',connected:false,hostGone:true});r.phone?.close();rooms.delete(r.id);}});
});
const timer=setInterval(()=>{for(const r of rooms.values()){if(r.phone&&r.last&&Date.now()-r.last>INPUT_TIMEOUT&&!r.lost){r.lost=true;send(r.host,{type:'stale'});}if(!r.host&&!r.phone&&Date.now()-r.created>300000)rooms.delete(r.id);}},100);
plain.listen(port,'0.0.0.0',()=>console.log(`游戏：http://127.0.0.1:${port}/`));
secure.listen(tlsPort,'0.0.0.0',()=>console.log(`手机手柄：https://${ip}:${tlsPort}/controller/`));
for(const server of [plain,secure]) server.on('error',e=>{console.error(e.message);process.exit(1);});
process.on('SIGTERM',()=>{clearInterval(timer);wss.clients.forEach(x=>x.close());plain.close();secure.close();});
