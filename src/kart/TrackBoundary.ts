import type * as THREE from 'three';
import type { ITrack } from '../types';
type Body = {position: THREE.Vector3; velocity: THREE.Vector3; t: number};

/** Vertical road-edge barrier. XZ projection deliberately ignores flight height. */
export function enforceTrackBoundary(track: ITrack, body: Body, radius: number): number | null {
  const t=track.probe(body.position,body.t).t;
  const s=track.sample(t);
  const length=Math.hypot(s.tangent.x,s.tangent.z);
  if(length<1e-6)return null;
  const tx=s.tangent.x/length,tz=s.tangent.z/length;
  const nx=-tz,nz=tx;
  const lateral=(body.position.x-s.pos.x)*nx+(body.position.z-s.pos.z)*nz;
  const limit=Math.max(.5,s.halfWidth-radius);
  if(Math.abs(lateral)<=limit)return null;
  const side=Math.sign(lateral),penetration=Math.abs(lateral)-limit+.12;
  body.position.x-=nx*side*penetration;body.position.z-=nz*side*penetration;
  const outward=Math.max(0,(body.velocity.x*nx+body.velocity.z*nz)*side);
  const speed=Math.hypot(body.velocity.x,body.velocity.z);
  const along=Math.max(2,speed*.72);
  const inward=Math.min(3,1+outward*.08);
  body.velocity.x=tx*along-nx*side*inward;
  body.velocity.z=tz*along-nz*side*inward;
  return Math.atan2(tx,tz);
}
