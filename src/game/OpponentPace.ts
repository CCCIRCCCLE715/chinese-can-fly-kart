export type PaceMode = 'normal' | 'slow' | 'fast';
type Racer = {id:number;isPlayer:boolean;finished:boolean;raceDistance:number;forwardSpeed:number};
const TARGET = {normal:.85,slow:.60,fast:1.14};
const smooth=(x:number)=>x*x*(3-2*x);

/** Stateful pack control. Total distance includes laps; gaps use passage times. */
export class OpponentPace {
  mode: PaceMode='normal';
  base=.85;
  private time=0;
  private travelled=0;
  private from=.85;
  private histories=new Map<number,{time:number;distance:number}[]>();
  private previous=new Map<number,number>();
  reset(){this.mode='normal';this.base=this.from=.85;this.time=this.travelled=0;this.histories.clear();this.previous.clear();}
  private change(mode:PaceMode){this.mode=mode;this.from=this.base;this.travelled=0;}
  private gap(ahead:Racer,behind:Racer){
    const history=this.histories.get(ahead.id)??[];
    const d=behind.raceDistance;
    // Time since the leading kart passed the trailing kart's current location.
    for(let i=history.length-1;i>0;i--){
      const a=history[i-1],b=history[i];
      if(a.distance<=d&&b.distance>=d&&b.distance>a.distance)
        return this.time-(a.time+(b.time-a.time)*(d-a.distance)/(b.distance-a.distance));
    }
    // Initial grid / history shorter than gap: estimate until a crossing exists.
    return Math.max(0,ahead.raceDistance-d)/Math.max(8,Math.abs(ahead.forwardSpeed));
  }
  update(karts:readonly Racer[],player:Racer,length:number,dt:number){
    if(dt<=0)return;
    this.time+=dt;
    const opponents=karts.filter(k=>!k.isPlayer&&!k.finished);
    let distance=0,count=0;
    for(const k of karts){
      const previous=this.previous.get(k.id);
      if(!k.isPlayer&&!k.finished&&previous!==undefined){
        const delta=k.raceDistance-previous;
        // Ignore reset / rescue teleports when measuring a quarter lap.
        if(delta>=0&&delta<=Math.max(5,dt*120)){distance+=delta;count++;}
      }
      this.previous.set(k.id,k.raceDistance);
      let history=this.histories.get(k.id);if(!history){history=[];this.histories.set(k.id,history);}
      if(history.length&&k.raceDistance<history.at(-1)!.distance-2)history.length=0;
      if(!history.length||this.time-history.at(-1)!.time>=.1)history.push({time:this.time,distance:k.raceDistance});
      while(history.length>1200)history.shift();
    }
    if(!player.finished&&opponents.length){
      const first=opponents.reduce((a,b)=>a.raceDistance>b.raceDistance?a:b);
      const last=opponents.reduce((a,b)=>a.raceDistance<b.raceDistance?a:b);
      if(this.mode==='slow'){
        if(player.raceDistance>=first.raceDistance)this.change('normal');
      }else if(this.mode==='fast'){
        if(last.raceDistance>player.raceDistance)this.change('slow');
      }else if(last.raceDistance>player.raceDistance&&this.gap(last,player)>1+1e-6){
        this.change('slow');
      }else if(player.raceDistance>first.raceDistance&&this.gap(player,first)>2+1e-6){
        this.change('fast');
      }
    }else if(this.mode!=='normal')this.change('normal');
    this.travelled+=count?distance/count:0;
    const u=Math.min(1,this.travelled/Math.max(1,length*.25));
    this.base=this.from+(TARGET[this.mode]-this.from)*smooth(u);
  }
  forKart(id:number){
    const amplitude=.03+((id*7)%11)/10*.03;
    const period=22+(id*13)%17;
    return this.base*(1+amplitude*Math.sin(this.time*Math.PI*2/period+id*2.39996));
  }
}
