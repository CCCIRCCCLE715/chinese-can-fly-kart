import { RemoteState, type RemotePacket } from './RemoteState';
import { RaceState, type Ctx } from '../types';
export class PhoneController {
  readonly state=new RemoteState();
  private ws:WebSocket|null=null;
  private panel:HTMLDivElement;
  private badge:HTMLDivElement;
  private toggle:HTMLButtonElement;
  private session:any;
  private pulseAt=0;
  private ctx:Ctx|null=null;
  private remotePaused=false;
  private wasActive=false;
  constructor() {
    const style=document.createElement('style');style.textContent=`.rp-toggle{position:fixed;right:20px;top:100px;z-index:10010;background:#172233e8;color:#ffe1a0;border:1px solid #8a7651;border-radius:12px;padding:10px 15px;font:600 14px system-ui;cursor:pointer}.rp-overlay{position:fixed;inset:0;z-index:10020;background:#07101be8;display:none;align-items:center;justify-content:center;padding:22px;font-family:system-ui;color:#f6f7fa}.rp-overlay.open{display:flex}.rp-card{width:min(860px,95vw);max-height:90vh;overflow:auto;border:1px solid #536075;background:#152033;border-radius:20px;padding:24px}.rp-card h2{margin:0 0 10px;font-size:25px}.rp-card p{line-height:1.7;color:#c2cbd9}.rp-pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.rp-pair img{width:180px;height:180px;border-radius:12px}.rp-card a{color:#ffd58c;overflow-wrap:anywhere}.rp-card button{background:#ffd078;border:0;border-radius:10px;padding:10px 18px;font:600 15px system-ui;cursor:pointer}.rp-status{background:#0c1420;padding:12px;border-radius:10px;margin:12px 0;color:#85e3b9}.rp-close{float:right}.rp-card small{color:#b2bfd1}@media(max-width:600px){.rp-pair{grid-template-columns:1fr}.rp-toggle{top:100px;right:12px}}`;document.head.append(style);
    this.toggle=document.createElement('button');this.toggle.className='rp-toggle';this.toggle.textContent='手机手柄';this.toggle.style.display='none';document.body.append(this.toggle);
    this.panel=document.createElement('div');this.panel.className='rp-overlay';this.panel.setAttribute('role','dialog');this.panel.setAttribute('aria-label','手机体感手柄');
    this.panel.innerHTML=`<div class="rp-card"><button class="rp-close">返回游戏</button><h2>手机体感手柄</h2><p>手机与电脑连接同一无线网。首次使用先完成证书设置，再扫描手柄二维码。</p><div class="rp-status" role="status">等待手机连接</div><div class="rp-pair"><section><h3>① 苹果手机 首次设置</h3><img class="rp-setup-qr" alt="首次设置二维码"><p><a class="rp-setup-link" target="_blank">打开首次设置引导</a></p><small>下载本地连接证书 → 安装 → 在「关于本机 → 证书信任设置」中开启信任。由你在手机上完成。</small></section><section><h3>② 打开手柄</h3><img class="rp-controller-qr" alt="手机手柄二维码"><p><a class="rp-controller-link" target="_blank">打开手柄网页</a></p><small>手机横向握持，首次允许体感权限；连接后自动接管驾驶。</small></section></div><p></p></div>`;
    document.body.append(this.panel);this.badge=this.panel.querySelector('.rp-status')!;
    this.toggle.onclick=()=>{
      this.panel.classList.toggle('open');
      if(this.panel.classList.contains('open')&&this.ctx){
        if(this.ctx.race.state===RaceState.Racing||this.ctx.race.state===RaceState.Countdown)this.remotePaused=true;
        this.ctx.race.setPaused(true);
      }
    };
    this.panel.querySelector<HTMLButtonElement>('.rp-close')!.onclick=()=>{
      this.panel.classList.remove('open');
      if(this.wasActive&&this.remotePaused){this.ctx?.race.setPaused(false);this.remotePaused=false;}
    };
    if(location.hostname==='127.0.0.1'||location.hostname==='localhost')this.start().catch(()=>{});
  }
  private async start() {
    const response=await fetch('/session');if(!response.ok)return;this.session=await response.json();this.toggle.style.display='block';
    for(const [cls,src] of [['.rp-setup-qr',this.session.setupQr],['.rp-controller-qr',this.session.qr]])this.panel.querySelector<HTMLImageElement>(cls)!.src=src;
    for(const [cls,url] of [['.rp-setup-link',this.session.setup],['.rp-controller-link',this.session.controller]])this.panel.querySelector<HTMLAnchorElement>(cls)!.href=url;
    this.connect();
  }
  private connect() {
    const s=this.session;this.ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/link?role=host&id=${s.id}&key=${s.hostToken}`);
    this.ws.onmessage=e=>{let p;try{p=JSON.parse(e.data);}catch{return;}if(!p||typeof p!=='object')return;
      if(p.type==='input')this.state.receive(p as RemotePacket,performance.now());
      else if(p.type==='ping')this.ws?.send(JSON.stringify({type:'pong',id:p.id}));
      else if(p.type==='status'&&!p.connected)this.state.disconnect();
      else if(p.type==='stale'){this.state.markStale();}
    };
    this.ws.onclose=()=>{this.state.disconnect();this.toggle.textContent='手机手柄 · 连接中断';};
    this.ws.onerror=()=>{};
  }
  read(ctx:Ctx) {
    this.ctx=ctx;
    const result=this.state.read(performance.now());
    if(result.lost){
      if(ctx.race.state===RaceState.Racing||ctx.race.state===RaceState.Countdown)this.remotePaused=true;
      ctx.race.setPaused(true);
      if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'safety'}));
    }
    if(result.active&&!this.wasActive){
      this.panel.classList.remove('open');
      if(this.remotePaused){ctx.race.setPaused(false);this.remotePaused=false;}
    }
    this.wasActive=result.active;
    if(performance.now()-this.pulseAt>200){this.pulseAt=performance.now();this.badge.textContent=result.active?'已连接 · 体感驾驶中':this.state.connected?'已连接 · 等待体感':'等待手机连接';this.toggle.textContent=result.active?'手机手柄 · 已连接':'手机手柄';}
    // A paused race accepts only explicit menu actions. Auto throttle must never
    // trigger Race's legacy "press throttle to resume" escape hatch.
    return {...result,paused:ctx.race.state===RaceState.Paused};
  }
}
