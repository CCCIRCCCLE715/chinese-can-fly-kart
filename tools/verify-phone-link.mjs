import puppeteer from 'puppeteer';
import {WebSocket} from 'ws';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-webgl','--use-angle=metal','--ignore-gpu-blocklist']});
let phone,timer;
try {
 const page=await browser.newPage();await page.setViewport({width:1280,height:800});
 await page.goto('http://localhost:18765/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__gameReady,{timeout:180000});
 const session=await page.evaluate(()=>{window.__freeze=true;const c=window.__ctx;c.race.start();c.race.state=2;document.querySelector('.rp-toggle').click();return c.input.phoneController.session;});
 const url=new URL(session.controller),[id,key]=url.hash.slice(1).split('.');
 phone=new WebSocket(`wss://${url.host}/link?role=phone&id=${id}&key=${key}`,{ca:readFileSync('.local/certs/ca.pem'),origin:url.origin});
 await new Promise((resolve,reject)=>{phone.once('open',resolve);phone.once('error',reject);});
 let seq=0;const send=enabled=>phone.send(JSON.stringify({type:'input',seq:seq++,steer:.6,enabled,accel:true,brake:false,drift:false,auto:true,item:0,pause:0,confirm:0}));
 send(false);timer=setInterval(()=>send(true),30);
 await page.waitForFunction(()=>{const c=window.__ctx;return c.input.state.steer>.5&&c.input.state.accel===1&&c.race.state===2&&document.querySelector('.rp-status').textContent.includes('体感驾驶中');},{timeout:15000});
 const result=await page.evaluate(()=>({steer:window.__ctx.input.state.steer,accel:window.__ctx.input.state.accel,status:document.querySelector('.rp-status').textContent,panelClosed:!document.querySelector('.rp-overlay').classList.contains('open')}));
 assert.equal(result.panelClosed,true);
 clearInterval(timer);phone.close();
 await page.evaluate(()=>window.__ctx.input.phoneController.ws.close());
 await page.waitForFunction(old=>window.__ctx.input.phoneController.session.id!==old,{timeout:10000},session.id);
 console.log(JSON.stringify({...result,reconnectFreshQr:true}));
} finally {clearInterval(timer);phone?.terminate();await browser.close();}
