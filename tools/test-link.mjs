import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn,spawnSync } from 'node:child_process';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const certDir=mkdtempSync(join(tmpdir(),'kart-link-test-'));
async function freePort(){return await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}
let server;
try {
 const port=await freePort();let tlsPort=await freePort();while(tlsPort===port)tlsPort=await freePort();
 const env={...process.env,KART_CERT_DIR:certDir,KART_LAN_IP:'127.0.0.1',KART_PORT:String(port),KART_TLS_PORT:String(tlsPort)};
 const setup=spawnSync(process.execPath,['runtime/setup-cert.mjs'],{cwd,env,encoding:'utf8'});
 if(setup.status!==0)throw new Error(setup.stderr||'无法生成测试证书，请安装 OpenSSL。');
 server=spawn(process.execPath,['runtime/server.mjs'],{cwd,env,stdio:['ignore','pipe','pipe']});
 let errors='';server.stderr.on('data',b=>errors+=b);
 let ready=false;
 for(let i=0;i<50;i++) {
  if(server.exitCode!==null)throw new Error(errors||'测试服务启动失败');
  try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(200)});ready=response.ok;}catch{}
  if(ready)break;
  await new Promise(r=>setTimeout(r,100));
 }
 if(!ready)throw new Error('测试服务启动超时');
 const result=spawnSync(process.execPath,['--test','tests/link.test.mjs'],{cwd,env,stdio:'inherit'});
 process.exitCode=result.status??1;
}catch(error){console.error(error.message);process.exitCode=1;}
finally {
 if(server&&server.exitCode===null){const closed=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await closed;}
 rmSync(certDir,{recursive:true,force:true});
}
