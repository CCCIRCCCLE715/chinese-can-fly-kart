export type RemotePacket = {type:'input';seq:number;steer:number;enabled:boolean;accel:boolean;brake:boolean;drift:boolean;auto:boolean;item:number;pause:number;confirm:number};
export class RemoteState {
  packet: RemotePacket | null = null;
  lastAt = 0;
  connected = false;
  blocked = false;
  private sequence = -1;
  private counts = {item:0,pause:0,confirm:0};
  private pending = {item:false,pause:false,confirm:false};
  private initialized = false;
  private driving = false;
  private loss = false;
  receive(p: RemotePacket,now:number) {
    if(p.seq<=this.sequence)return;
    this.sequence=p.seq;this.lastAt=now;this.connected=true;
    if(!this.initialized){this.counts={item:p.item,pause:p.pause,confirm:p.confirm};this.initialized=true;}
    else for(const key of ['item','pause','confirm'] as const){if(p[key]>this.counts[key])this.pending[key]=true;this.counts[key]=p[key];}
    if(!p.enabled)this.blocked=false;
    if(this.driving&&!p.enabled){this.loss=true;this.driving=false;}
    this.packet=p;
  }
  disconnect() {
    if(this.driving)this.loss=true;
    this.connected=false;this.blocked=true;this.driving=false;this.packet=null;this.sequence=-1;this.initialized=false;
    this.pending={item:false,pause:false,confirm:false};
  }
  markStale() {
    if(this.driving)this.loss=true;
    this.blocked=true;this.driving=false;
  }
  read(now:number) {
    if(this.connected&&this.packet&&now-this.lastAt>600){if(this.driving)this.loss=true;this.blocked=true;this.driving=false;}
    const p=this.packet;
    const active=!!(this.connected&&p&&p.enabled&&!this.blocked&&now-this.lastAt<=600);
    this.driving=active;
    const events={...this.pending};this.pending={item:false,pause:false,confirm:false};
    const lost=this.loss;this.loss=false;
    return {active,lost,events,packet:active?p:null,age:this.lastAt?now-this.lastAt:Infinity};
  }
}
