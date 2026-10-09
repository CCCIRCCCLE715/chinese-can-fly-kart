export const INPUT_TIMEOUT = 600;
export function validateInput(p) {
  if (!p || p.type !== 'input' || !Number.isSafeInteger(p.seq) || p.seq < 0 || !Number.isFinite(p.steer) || Math.abs(p.steer) > 1) return null;
  if (p.gas !== undefined && (!Number.isSafeInteger(p.gas) || p.gas < 0 || p.gas > 1e9)) return null;
  if (p.banana !== undefined && (!Number.isSafeInteger(p.banana) || p.banana < 0 || p.banana > 1e9)) return null;
  for (const k of ['item','pause','confirm']) if (!Number.isSafeInteger(p[k]) || p[k] < 0 || p[k] > 1e9) return null;
  for (const k of ['enabled','accel','brake','drift','auto']) if (typeof p[k] !== 'boolean') return null;
  return {gas:p.gas ?? 0,banana:p.banana ?? 0,type:'input',seq:p.seq,steer:p.steer,enabled:p.enabled,accel:p.accel,brake:p.brake,drift:p.drift,auto:p.auto,item:p.item,pause:p.pause,confirm:p.confirm};
}
// Project gravity into the CURRENT screen plane. atan2 preserves a full
// turn; asin folds at 90 degrees and can jump when Euler angles change branch.
export function rollDegrees(beta,gamma,angle) {
 const r=Math.PI/180,b=beta*r,g=gamma*r,a=angle*r;
 const x=Math.cos(b)*Math.sin(g),up=Math.sin(b);
 const screenX=x*Math.cos(a)+up*Math.sin(a);
 const screenUp=up*Math.cos(a)-x*Math.sin(a);
 // Almost flat on a table: gravity cannot provide a stable screen-plane roll.
 if(Math.hypot(screenX,screenUp)<.15)return null;
 return Math.atan2(screenX,screenUp)/r;
}
export function angleDifference(angle,zero) {
 return ((angle-zero+540)%360)-180;
}
export function screenAngle({legacy,angle,landscape,type}={}) {
 let value=Number.isFinite(legacy)?legacy:Number.isFinite(angle)?angle:0;
 value=((value%360)+360)%360;
 if(landscape&&value%180===0)value=type==='landscape-secondary'?270:90;
 return value;
}
export function steerFromTilt(deg,range,invert=false) {
  const v=Math.abs(deg)<=2?0:Math.sign(deg)*Math.min(1,(Math.abs(deg)-2)/(range-2));
  return invert?-v:v;
}
