/** Arc-length fractions shared by the road surface and the scenery. */
export const TOWN_SECTIONS: readonly (readonly [number, number])[] = [[0.035, 0.505], [0.612, 0.845], [0.957, 0.998]];
export function isTown(t: number): boolean {
 const u=t>=0&&t<1?t:((t%1)+1)%1;
 return TOWN_SECTIONS.some(([a,b])=>u>=a&&u<=b);
}
export function townWeight(t: number): number {
 const u=t>=0&&t<1?t:((t%1)+1)%1;
 for(const [a,b] of TOWN_SECTIONS){
  if(u<a||u>b)continue;
  const x=Math.max(0,Math.min(1,Math.min(u-a,b-u)/.012));
  return x*x*(3-2*x);
 }
 return 0;
}

/** Dense shopping streets get paving; residential edges remain gravel. */
export const PAVED_DISTRICTS: readonly (readonly [number,number])[] = [[.09,.155],[.208,.36],[.395,.485],[.642,.735],[.765,.824],[.965,.99]];
export function pavingWeight(t:number):number {
 const u=((t%1)+1)%1;
 let result=0;
 for(const [a,b] of PAVED_DISTRICTS){
  // Twenty-four metre feathering on a 1.6 km circuit, including both ends.
  const edge=Math.min(u-a,b-u);
  const x=Math.max(0,Math.min(1,(edge+.015)/.03));
  result=Math.max(result,x*x*(3-2*x));
 }
 return result*townWeight(u);
}
