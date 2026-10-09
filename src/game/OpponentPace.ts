export type PaceMode = 'normal' | 'slow' | 'fast';
type Racer = {id:number;isPlayer:boolean;finished:boolean;raceDistance:number;forwardSpeed:number;stats?:{topSpeedMul:number}};
type PaceState = {mode:PaceMode;base:number;from:number;travelled:number;cohesion:number;leadGuard:boolean;retaking:boolean;guardPace:number;assist:number};
const TARGET = {normal:.85,slow:.60,fast:1.14};
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
const smooth=(x:number)=>x*x*(3-2*x);

/** Per-opponent five-second leashes, plus a separate opponent-pack envelope. */
export class OpponentPace {
  private time=0;
  private states=new Map<number,PaceState>();
  private histories=new Map<number,{time:number;distance:number}[]>();
  private previous=new Map<number,number>();
  private leaders=new Set<number>();
  reset(){this.time=0;this.states.clear();this.histories.clear();this.previous.clear();this.leaders.clear();}
  stateFor(id:number): Readonly<PaceState> {return this.state(id);}
  private state(id:number){
    let s=this.states.get(id);
    if(!s){s={mode:'normal',base:.85,from:.85,travelled:0,cohesion:0,leadGuard:false,retaking:false,guardPace:0,assist:0};this.states.set(id,s);}
    return s;
  }
  private change(s:PaceState,mode:PaceMode){s.mode=mode;s.from=s.base;s.travelled=0;}
  private gap(ahead:Racer,behind:Racer){
    const history=this.histories.get(ahead.id)??[];
    const d=behind.raceDistance;
    for(let i=history.length-1;i>0;i--){
      const a=history[i-1],b=history[i];
      if(a.distance<=d&&b.distance>=d&&b.distance>a.distance)
        return this.time-(a.time+(b.time-a.time)*(d-a.distance)/(b.distance-a.distance));
    }
    return Math.max(0,ahead.raceDistance-d)/Math.max(8,Math.abs(ahead.forwardSpeed));
  }
  update(karts:readonly Racer[],player:Racer,length:number,dt:number,visible?:ReadonlySet<number>,fullSpeed=30){
    if(dt<=0)return;
    this.time+=dt;
    const opponents=karts.filter(k=>!k.isPlayer&&!k.finished);
    for(const id of this.leaders)if(!opponents.some(k=>k.id===id))this.leaders.delete(id);
    if(player.finished)this.leaders.clear();
    else if(this.leaders.size<Math.min(3,opponents.length)){
      // Keep identities stable after an overtake, and replace finished leaders.
      const candidates=opponents.filter(k=>!this.leaders.has(k.id)).sort((a,b)=>{
        const da=a.raceDistance-player.raceDistance,db=b.raceDistance-player.raceDistance;
        if((da>=0)!==(db>=0))return da>=0?-1:1;
        return Math.abs(da)-Math.abs(db)||a.id-b.id;
      });
      for(const k of candidates){this.leaders.add(k.id);if(this.leaders.size>=Math.min(3,opponents.length))break;}
    }
    // Record passage times before measuring gaps; distance includes completed laps.
    for(const k of karts){
      let history=this.histories.get(k.id);if(!history){history=[];this.histories.set(k.id,history);}
      const last=history.at(-1);
      if(last&&k.raceDistance<last.distance-2)history.length=0;
      if(!history.length||this.time-history.at(-1)!.time>=.1)history.push({time:this.time,distance:k.raceDistance});
      while(history.length>1200)history.shift();
    }
    const first=opponents.length?opponents.reduce((a,b)=>a.raceDistance>b.raceDistance?a:b):null;
    const last=opponents.length?opponents.reduce((a,b)=>a.raceDistance<b.raceDistance?a:b):null;
    // Start gathering at three seconds, before the five-second boundary is reached.
    const spread=first&&last?this.gap(first,last):0;
    const compression=smooth(clamp((spread-3)/2,0,1));
    const span=first&&last?first.raceDistance-last.raceDistance:0;
    const packBase=opponents.length?opponents.reduce((sum,k)=>sum+this.state(k.id).base,0)/opponents.length:.85;
    for(const k of karts){
      const previous=this.previous.get(k.id);this.previous.set(k.id,k.raceDistance);
      if(k.isPlayer)continue;
      const s=this.state(k.id);
      const hidden=visible!==undefined&&!visible.has(k.id);
      s.leadGuard=this.leaders.has(k.id)&&!player.finished&&!k.finished;
      const lead=k.raceDistance-player.raceDistance;
      if(!s.leadGuard)s.retaking=false;
      else if(lead<6)s.retaking=true;
      else if(lead>=24)s.retaking=false;
      const nominal=Math.max(8,fullSpeed*(k.stats?.topSpeedMul??1));
      const guarded=s.leadGuard&&(s.retaking||lead<18);
      const desiredGuard=guarded?clamp((Math.max(0,player.forwardSpeed)+5+clamp(-lead*.6,0,14))/nominal,.85,2.1):0;
      // Leading cars retake quickly even on screen; ease off once they have room.
      const guardAlpha=1-Math.exp(-dt/(desiredGuard > s.guardPace ? .16 : .7));
      s.guardPace+=(desiredGuard-s.guardPace)*guardAlpha;
      if(s.guardPace<.001)s.guardPace=0;
      const assistGoal=s.retaking?clamp(2+(player.forwardSpeed-k.forwardSpeed)*.35+Math.max(0,-lead)*.03,2,8):0;
      s.assist+=(assistGoal-s.assist)*(1-Math.exp(-dt/.2));
      if(s.assist<.001)s.assist=0;
      if(player.finished||k.finished){
        if(s.mode!=='normal')this.change(s,'normal');
      }else if(s.mode==='fast'){
        if(k.raceDistance>player.raceDistance)this.change(s,'normal');
      }else if(s.mode==='slow'){
        if(player.raceDistance>k.raceDistance)this.change(s,'normal');
      }else if(k.raceDistance>player.raceDistance&&this.gap(k,player)>5+1e-6){
        this.change(s,'slow');
      }else if(player.raceDistance>k.raceDistance&&this.gap(player,k)>5+1e-6){
        this.change(s,'fast');
      }
      const raw=previous===undefined?0:k.raceDistance-previous;
      const distance=raw>=0&&raw<=Math.max(5,dt*120)?raw:0;
      const quarter=Math.max(1,length*.25);
      // Hidden opponents complete changes within ~0.8 s, without teleporting.
      s.travelled+=hidden?Math.max(distance,quarter*dt/.8):distance;
      const u=Math.min(1,s.travelled/quarter);
      s.base=s.from+(TARGET[s.mode]-s.from)*smooth(u);
      const order=span>1&&first?clamp((first.raceDistance-k.raceDistance)/span,0,1):.5;
      const correction=k.finished?0:compression*(packBase+(order*2-1)*.30-s.base);
      const alpha=1-Math.exp(- (hidden?dt/.16:distance/quarter*5));
      s.cohesion+=(correction-s.cohesion)*alpha;
    }
  }
  assistFor(id:number){return this.state(id).assist;}
  forKart(id:number){
    const s=this.state(id);
    const amplitude=.03+((id*7)%11)/10*.03;
    const period=22+(id*13)%17;
    const variation=1+amplitude*Math.sin(this.time*Math.PI*2/period+id*2.39996);
    const regular=clamp((s.base+s.cohesion)*variation,.40,1.45);
    return Math.max(regular,s.guardPace*variation);
  }
}
