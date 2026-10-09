import * as THREE from 'three';

/** Partition a world-space, single-material merge so whole streets outside the
 * camera/shadow frustum stop being submitted. Faces and vertex attributes stay intact. */
export function splitStaticGeometry(geometry: THREE.BufferGeometry,cellSize=70): THREE.BufferGeometry[] {
 const position=geometry.getAttribute('position'),index=geometry.index;
 const count=index?.count??position.count;
 const buckets=new Map<string,{vertices: Map<number,number>;indices: number[];original: number[]}>();
 for(let i=0;i<count;i+=3){
  const a=index?index.getX(i):i,b=index?index.getX(i+1):i+1,c=index?index.getX(i+2):i+2;
  const x=(position.getX(a)+position.getX(b)+position.getX(c))/3;
  const z=(position.getZ(a)+position.getZ(b)+position.getZ(c))/3;
  const key=`${Math.floor(x/cellSize)},${Math.floor(z/cellSize)}`;
  let bucket=buckets.get(key);
  if(!bucket){bucket={vertices:new Map(),indices:[],original:[]};buckets.set(key,bucket);}
  for(const old of [a,b,c]){
   let next=bucket.vertices.get(old);
   if(next===undefined){next=bucket.original.length;bucket.vertices.set(old,next);bucket.original.push(old);}
   bucket.indices.push(next);
  }
 }
 const chunks: THREE.BufferGeometry[]=[];
 for(const bucket of buckets.values()){
  const chunk=new THREE.BufferGeometry();
  for(const [name,attribute] of Object.entries(geometry.attributes)){
   const values=new Float32Array(bucket.original.length*attribute.itemSize);
   let at=0;
   for(const old of bucket.original)for(let k=0;k<attribute.itemSize;k++)values[at++]=attribute.getComponent(old,k);
   chunk.setAttribute(name,new THREE.BufferAttribute(values,attribute.itemSize));
  }
  chunk.setIndex(bucket.indices);chunk.computeBoundingBox();chunk.computeBoundingSphere();chunks.push(chunk);
 }
 return chunks;
}
