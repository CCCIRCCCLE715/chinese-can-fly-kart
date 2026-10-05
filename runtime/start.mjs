import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const base=fileURLToPath(new URL('..',import.meta.url));
process.chdir(base);
process.env.KART_CERT_DIR ||= resolve(base,'.local/certs');
function run(command,args) {
 const result=spawnSync(command,args,{cwd:base,env:process.env,stdio:'inherit',shell:process.platform==='win32'&&command==='npm'});
 if(result.error) {console.error('启动失败：',result.error.message);process.exit(1);}
 if(result.status!==0) process.exit(result.status||1);
}
if(!existsSync(resolve(base,'node_modules/ws/package.json')) || !existsSync(resolve(base,'node_modules/qrcode/package.json'))) {
 console.log('首次启动，正在安装运行所需的文件……');
 run('npm',['ci']);
}
if(!existsSync(resolve(base,'dist/index.html'))) {
 console.log('正在准备游戏……');
 run('npm',['run','build']);
}
run(process.execPath,[resolve(base,'runtime/setup-cert.mjs')]);
if(process.argv.includes('--background')) await import('./launch.mjs');
else await import('./server.mjs');
