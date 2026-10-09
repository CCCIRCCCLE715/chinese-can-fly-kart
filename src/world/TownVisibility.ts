import * as THREE from 'three';
export interface TownPlacement {matrix:THREE.Matrix4;color:THREE.Color;bounds:THREE.Sphere}
/** The cap is by source GLB identity, regardless of paint, scale or shop sign. */
export function visibleTownCopies(placements:TownPlacement[],frustum:THREE.Frustum,eye:THREE.Vector3,limit=5):TownPlacement[] {
 return placements.filter(p=>frustum.intersectsSphere(p.bounds)).sort((a,b)=>eye.distanceToSquared(a.bounds.center)-eye.distanceToSquared(b.bounds.center)).slice(0,limit);
}
