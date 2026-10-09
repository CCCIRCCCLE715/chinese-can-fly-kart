/** Distinct seeded growth forms; bloom stays near full spring flowering. */
export const SAKURA_FORMS = [
 {key:'sakura-natural-spreading',seed:0x178f4d88,width:1,depth:1,rise:1.25,trunk:1,bloom:1,height:8.7,lean:0},
 {key:'sakura-natural-upright',seed:0x178f4d92,width:.88,depth:.94,rise:1.85,trunk:.84,bloom:1.04,height:9.8,lean:.04},
 {key:'sakura-natural-arching',seed:0x178f4d31,width:1.10,depth:.94,rise:1.05,trunk:1.18,bloom:.96,height:7.5,lean:-.05},
 {key:'sakura-natural-leaning',seed:0x178f4db7,width:.95,depth:1.10,rise:1.45,trunk:1.08,bloom:1.10,height:8.1,lean:.13},
 {key:'sakura-natural-vase',seed:0x178f4d67,width:.83,depth:.91,rise:2.10,trunk:.78,bloom:1.02,height:10.1,lean:-.02},
 {key:'sakura-natural-broad',seed:0x178f4dca,width:1.13,depth:1.04,rise:1.15,trunk:1.25,bloom:1.08,height:9.3,lean:.02},
 {key:'sakura-natural-compact',seed:0x178f4d42,width:.91,depth:.84,rise:1.10,trunk:.91,bloom:1.12,height:6.8,lean:-.07},
 {key:'sakura-natural-sweeping',seed:0x178f4def,width:1.03,depth:.88,rise:1.65,trunk:.95,bloom:.97,height:7.9,lean:.09},
 {key:'sakura-natural-rounded',seed:0x178f4d14,width:.98,depth:1.08,rise:1.30,trunk:1.12,bloom:1.06,height:8.4,lean:-.04},
] as const;
export interface SakuraPoint {x:number;z:number}
/** Every tree together with its four closest cherries forms a distinct group. */
export function sakuraNeighborhoods(points:readonly SakuraPoint[]):number[][] {
 return points.map((p,i)=>[i,...points.map((q,j)=>({j,d:(q.x-p.x)**2+(q.z-p.z)**2})).filter(q=>q.j!==i).sort((a,b)=>a.d-b.d||a.j-b.j).slice(0,4).map(q=>q.j)]);
}
export function assignSakuraForms(points:readonly SakuraPoint[]):number[] {
 const neighbors=points.map(()=>new Set<number>());
 for(const group of sakuraNeighborhoods(points))for(const a of group)for(const b of group)if(a!==b)neighbors[a].add(b);
 const colors=points.map(()=>-1);let attempts=0;
 // Saturation-first coloring also handles park clusters and opposite roadsides.
 const solve=(left:number):boolean=>{
  if(!left)return true;if(++attempts>200000)return false;
  let vertex=-1,saturation=-1,degree=-1;
  for(let i=0;i<colors.length;i++)if(colors[i]<0){
   const s=new Set([...neighbors[i]].map(j=>colors[j]).filter(c=>c>=0)).size;
   if(s>saturation||s===saturation&&neighbors[i].size>degree){vertex=i;saturation=s;degree=neighbors[i].size;}
  }
  const used=new Set([...neighbors[vertex]].map(j=>colors[j]));
  for(let k=0;k<SAKURA_FORMS.length;k++){
   const c=(k+vertex*5)%SAKURA_FORMS.length;if(used.has(c))continue;
   colors[vertex]=c;if(solve(left-1))return true;colors[vertex]=-1;
  }
  return false;
 };
 if(!solve(points.length))throw new Error('Sakura neighborhood exceeds the available distinct growth forms');
 return colors;
}
