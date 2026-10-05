import {readFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';
const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const certDir=process.env.KART_CERT_DIR || resolve(base,'.local/certs');
const port=Number(process.env.KART_PORT||18765),tlsPort=Number(process.env.KART_TLS_PORT||18766);
const ip=readFileSync(resolve(certDir,'ip.txt'),'utf8').trim();
const rootKey=createHash('sha256').update(base).digest('hex');
const fingerprint=new X509Certificate(readFileSync(resolve(certDir,'server.pem'))).fingerprint256;
async function health(){try{return await(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).json();}catch{return null;}}
let h=await health();
if(h&&(h.rootKey!==rootKey||h.ip!==ip||h.certFingerprint!==fingerprint||h.port!==port||h.tlsPort!==tlsPort)){
 console.error('连接地址或游戏版本已变化。请先关闭旧赛车服务，再重新启动。');process.exit(1);
}
if(!h){
 const log=openSync(resolve(base,'运行日志.txt'),'a');
 const child=spawn(process.execPath,[resolve(base,'runtime/server.mjs')],{cwd:base,env:process.env,detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);
 for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));h=await health();if(h)break;}
}
if(!h||h.rootKey!==rootKey){console.error('启动失败，请查看运行日志。');process.exit(1);}
console.log('赛车已启动。点击游戏右上角「手机手柄」连接苹果手机。');
