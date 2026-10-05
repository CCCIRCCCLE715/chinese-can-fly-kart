/** Remove a splice discontinuity while retaining the exact bar duration. */
export function smoothLoop(samples, sampleRate) {
 const count=Math.min(Math.round(sampleRate*.015),Math.floor(samples.length/2));
 if(count<2)return samples;
 const first=samples[0],last=samples[samples.length-1],join=(first+last)/2;
 for(let i=0;i<count;i++){
  const weight=(1+Math.cos(Math.PI*i/(count-1)))/2;
  samples[i]+=(join-first)*weight;
  samples[samples.length-1-i]+=(join-last)*weight;
 }
 return samples;
}
