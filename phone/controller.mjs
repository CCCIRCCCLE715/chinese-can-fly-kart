import {rollDegrees,steerFromTilt,angleDifference,screenAngle} from './protocol.mjs';
import {createButtonState} from './controls.mjs';
const $=id=>document.getElementById(id);
const pair=location.hash.slice(1).split('.');
const counts={item:0,pause:0,confirm:0};
const buttons=createButtonState(),tapContacts=new Map();
let ws,seq=0,enabled=false,raw=null,zero=null,sensorAt=0,steer=0,filtered=0,wake=null,retry,hostGone=false,hostConnected=false;
let motionReady=false,requesting=false,settingsOpen=false,foreground=!document.hidden;
let candidate=null,stableAt=0,lastUpdate=performance.now(),hintTimer;
const landscape=()=>matchMedia('(orientation: landscape)').matches;
const orientation=()=>screenAngle({legacy:window.orientation,angle:screen.orientation?.angle,type:screen.orientation?.type,landscape:landscape()});
let tiltAngle=orientation(),wasLandscape=landscape();
const pings=new Map();let pingId=0;
function saveSettings(){try{localStorage.setItem('kart-tilt-settings',JSON.stringify({range:Number($('range').value),invert:$('invert').checked}));}catch{}}
try{const s=JSON.parse(localStorage.getItem('kart-tilt-settings'));if(s){if(Number.isFinite(s.range)&&s.range>=10&&s.range<=40)$('range').value=s.range;if(typeof s.invert==='boolean')$('invert').checked=s.invert;}}catch{}
$('range-value').textContent=$('range').value+'°';
function hint(text='',persistent=false){clearTimeout(hintTimer);$('hint').textContent=text;$('hint').hidden=!text;if(text&&!persistent)hintTimer=setTimeout(()=>hint(),1800);}
function render(){if(ws?.readyState===WebSocket.OPEN&&!hostGone)connection(hostConnected?(enabled?'已连接 · 体感驾驶中':'已连接 · 等待体感'):'等待电脑页面连接',hostConnected);document.body.classList.toggle('driving',enabled);document.body.classList.toggle('motion-wait',!motionReady);$('motion').hidden=motionReady;$('motion').disabled=requesting;}
function releaseControls(){buttons.clear();tapContacts.clear();steer=0;filtered=0;document.querySelectorAll('.held').forEach(e=>e.classList.remove('held'));}
function send(){if(ws?.readyState!==WebSocket.OPEN||ws.bufferedAmount>4096)return;ws.send(JSON.stringify({type:'input',seq:seq++,steer,enabled,accel:buttons.held('accel'),brake:buttons.held('brake'),drift:buttons.held('drift'),auto:$('auto').checked,...counts}));}
function stop(){enabled=false;releaseControls();render();send();}
function ready(){return hostConnected&&foreground&&!document.hidden&&!settingsOpen&&landscape()&&motionReady&&raw!==null&&zero!==null&&performance.now()-sensorAt<=600;}
function activate(){if(enabled||!ready()||ws?.readyState!==WebSocket.OPEN)return;enabled=true;render();send();if(!wake||wake.released)navigator.wakeLock?.request('screen').then(lock=>wake=lock).catch(()=>{});}
function connection(text,connected=false){$('connection').textContent=text;document.body.classList.toggle('connected',connected);}
function connect(){
 if(pair.length!==2||!/^\w{12}$/.test(pair[0])||!/^\w{48}$/.test(pair[1])){connection('请扫码连接');return;}
 ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/link?role=phone&id='+pair[0]+'&key='+pair[1]);
 ws.onopen=()=>{seq=0;hostConnected=false;connection('等待电脑页面连接');stop();};
 ws.onmessage=e=>{
  let p;try{p=JSON.parse(e.data);}catch{return;}if(!p||typeof p!=='object')return;
  if(p.type==='pong'&&pings.has(p.id)){const ms=performance.now()-pings.get(p.id);pings.delete(p.id);$('latency').textContent='连接耗时：'+Math.round(ms)+' 毫秒';}
  if(p.type==='safety'){stop();activate();}
  if(p.type==='status'&&!p.hostGone){hostConnected=p.hostConnected===true;render();activate();}
  if(p.type==='status'&&p.hostGone){hostGone=true;stop();connection('请重新扫码');clearTimeout(retry);}
 };
 ws.onclose=()=>{hostConnected=false;stop();if(hostGone)return;connection('连接中');retry=setTimeout(connect,1500);};
 ws.onerror=()=>connection('连接中');
}
function syncOrientation(){
 const next=orientation(),wide=landscape();
 if(next!==tiltAngle||wide!==wasLandscape){tiltAngle=next;raw=null;zero=null;sensorAt=0;candidate=null;stop();}
 wasLandscape=wide;
}
window.addEventListener('orientationchange',syncOrientation);screen.orientation?.addEventListener('change',syncOrientation);window.addEventListener('resize',syncOrientation);
window.addEventListener('deviceorientation',e=>{
 if(!Number.isFinite(e.beta)||!Number.isFinite(e.gamma))return;
 syncOrientation();const value=rollDegrees(e.beta,e.gamma,tiltAngle);
 if(value===null){raw=null;stop();return;}
 raw=value;sensorAt=performance.now();motionReady=true;render();
 if(zero===null&&landscape()&&foreground&&!document.hidden){
  if(candidate===null||Math.abs(angleDifference(raw,candidate))>3){candidate=raw;stableAt=sensorAt;}
  if(sensorAt-stableAt>=160){zero=raw;candidate=null;hint();}
 }
 activate();
});
async function enableMotion(){
 if(requesting||motionReady)return;
 if(!landscape())return;
 if(!isSecureContext){hint('请完成证书信任后重新扫码',true);return;}
 requesting=true;render();
 try{
  if(typeof DeviceOrientationEvent==='undefined')throw new Error('请用苹果浏览器打开');
  if(typeof DeviceOrientationEvent.requestPermission==='function'&&await DeviceOrientationEvent.requestPermission()!=='granted')throw new Error('请允许访问运动与方向');
  foreground=!document.hidden;zero=null;candidate=null;
  hint('拿稳手机，正在校准');
  setTimeout(()=>{if(!motionReady)hint('稍微抬起手机，等待体感',true);},2000);
 }catch(e){hint(/[\u4e00-\u9fff]/.test(e.message)?e.message:'请检查体感权限',true);}
 finally{requesting=false;render();}
}
$('motion').onclick=enableMotion;
$('calibrate').onclick=()=>{
 if(!motionReady){void enableMotion();return;}
 if(raw===null||performance.now()-sensorAt>600){hint('请拿稳手机');return;}
 zero=raw;candidate=null;filtered=0;steer=0;hint('已校准');activate();send();
};
$('range').oninput=()=>{$('range-value').textContent=$('range').value+'°';saveSettings();};
$('invert').onchange=()=>{saveSettings();send();};
$('auto').onchange=()=>{saveSettings();send();};
for(const el of document.querySelectorAll('[data-hold]')){
 const key=el.dataset.hold;
 el.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();
  if(!enabled){void enableMotion();return;}
  el.setPointerCapture(e.pointerId);buttons.press(key,e.pointerId);el.classList.add('held');send();
 });
 const release=e=>{buttons.release(e.pointerId);if(!buttons.held(key))el.classList.remove('held');send();};
 for(const name of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(name,release);
}
for(const el of document.querySelectorAll('[data-tap]')){
 const key=el.dataset.tap;
 el.addEventListener('pointerdown',e=>{
  if((e.pointerType==='mouse'&&e.button!==0)||tapContacts.has(el))return;e.preventDefault();
  if(!enabled){void enableMotion();return;}
  tapContacts.set(el,e.pointerId);el.setPointerCapture(e.pointerId);el.classList.add('held');counts[key]++;send();
 });
 for(const name of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(name,e=>{if(tapContacts.get(el)===e.pointerId){tapContacts.delete(el);el.classList.remove('held');}});
 el.addEventListener('click',e=>{if(e.detail===0&&enabled){counts[key]++;send();}});
}
$('settings-open').onclick=()=>{settingsOpen=true;stop();$('settings-dialog').showModal();};
$('settings-close').onclick=()=>$('settings-dialog').close();
$('settings-dialog').addEventListener('close',()=>{settingsOpen=false;activate();});
function update(){
 const now=performance.now(),dt=Math.min(.1,(now-lastUpdate)/1000);lastUpdate=now;let deg=0;
 if(!ready()){if(enabled)stop();steer=0;filtered=0;}
 else{deg=angleDifference(raw,zero);filtered+=(.35*steerFromTilt(deg,Number($('range').value),$('invert').checked)-filtered)*(1-Math.exp(-dt/.025));steer=filtered;activate();}
 $('angle').textContent=Math.round(deg)+'°';$('needle').style.left=(50+steer*46)+'%';send();
}
setInterval(update,1000/60);
setInterval(()=>{if(ws?.readyState!==WebSocket.OPEN)return;const id=++pingId;pings.set(id,performance.now());for(const [key,value]of pings)if(performance.now()-value>5000)pings.delete(key);ws.send(JSON.stringify({type:'ping',id}));},1000);
document.addEventListener('visibilitychange',()=>{foreground=!document.hidden;if(!foreground){stop();wake?.release();}else activate();});
window.addEventListener('pagehide',()=>{foreground=false;stop();});
window.addEventListener('blur',()=>{foreground=false;stop();});
window.addEventListener('focus',()=>{foreground=!document.hidden;activate();});
window.addEventListener('pageshow',()=>{foreground=!document.hidden;activate();});
render();connect();
