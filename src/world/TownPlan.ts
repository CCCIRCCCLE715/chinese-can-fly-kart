/** Town lots are scenic; the racing centerline and checkpoints remain a single loop. */
export interface TownBlueprint {key:string;width:number;height:number;depth:number;floors?:number}
export interface TownLot {key:string;distance:number;t:number;side:number;tier:number;width:number;height:number;depth:number;setback:number;scale:number;stretch:number;yaw:number;color:number}
export interface TownLane {distance:number;t:number;side:number;width:number;depth:number}
export const TOWN_PARKS=[{t:.168,side:-1,width:38,depth:24},{t:.695,side:1,width:42,depth:26}];
const COLORS=[0xf5bdac,0xe3d29d,0xa4cabb,0x9cbcd1,0xc7b3cb,0xf2e4c9,0xe5a18f];
export function makeTownPlan(length:number,sections:readonly (readonly [number,number])[],assets:TownBlueprint[]) {
 let seed=0x9a728;
 const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const buildings:TownLot[]=[],lanes:TownLane[]=[];
 if(!assets.length) return {buildings,lanes};
 for(const [a,b] of sections){
  let n=0;
  for(let distance=a*length+48;distance<b*length-15;distance+=57+rng()*23){
   for(const side of [-1,1]) if(n%3===0||rng()<.6) lanes.push({distance,t:distance/length,side,width:n%3===0?7+rng()*3:3.5+rng()*2,depth:29+rng()*6});
   n++;
  }
 }
 let seq=0,regularSeq=0;
 const multi=assets.filter(a=>(a.floors??1)>1);
 const bag=assets.map((_,i)=>i).filter(i=>(assets[i].floors??1)<=1);
 for(let i=bag.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
 for(const [a,b] of sections)for(const tier of [0,1])for(const side of [-1,1]) {
  let distance=a*length+5+rng()*8;
  while(distance<b*length-5){
   seq++;
   const blueprint=multi.length&&seq%3===0?multi[Math.floor(rng()*multi.length)]:assets[bag[regularSeq++%bag.length]],scale=.85+rng()*.28,stretch=.92+rng()*.17;
   const width=blueprint.width*scale,depth=blueprint.depth*scale;
   const center=distance+width/2;
   const clearPark=TOWN_PARKS.every(p=>p.side!==side||Math.abs(center-p.t*length)>p.width/2+width/2+4);
   const clearLane=lanes.every(l=>l.side!==side||Math.abs(center-l.distance)>l.width/2+width/2+2);
   if(clearPark&&clearLane&&center+width/2<b*length){
    buildings.push({key:blueprint.key,distance:center,t:center/length,side,tier,width,height:blueprint.height*scale*stretch,depth,setback:tier?27+rng()*5:5.5+rng()*5.5,scale,stretch,yaw:(rng()-.5)*.24,color:COLORS[Math.floor(rng()*COLORS.length)]});
   }
   // Shops cluster in short runs; homes have gardens and wider side clearances.
   distance+=width+(tier?6+rng()*7:2.5+rng()*5);
  }
 }
 buildings.sort((a,b)=>a.distance-b.distance);
 return {buildings,lanes};
}
