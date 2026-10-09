import * as THREE from 'three';
import type { Ctx, IKart } from '../types';

const CAPACITY = 512, PUFFS = 10, LIFETIME = 1.5;
type Cloud = { owner: number; position: THREE.Vector3; back: THREE.Vector3; age: number; radius: number; seed: number; cast: number; expires: number; hit: Set<number> };

/** Instanced billboard lifecycle adapted from three.js's MIT smoke example.
 * See docs/research/gas-cloud-source.md. No texture or WebGPU dependency. */
export class GasClouds {
  readonly clouds: Cloud[] = [];
  readonly mesh: THREE.InstancedMesh;
  private serial = 0;
  private clock = 0;
  private emitters: {kart: IKart; last: THREE.Vector3; expires: number; cast: number; hit: Set<number>}[] = [];
  private dummy = new THREE.Object3D();
  private opacity = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * PUFFS), 1);
  constructor() {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute('puffOpacity', this.opacity);
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `
        attribute float puffOpacity;
        varying vec2 vUv; varying float vOpacity; varying float vSeed;
        void main() {
          vUv=uv; vOpacity=puffOpacity;
          vSeed=instanceMatrix[3].x*.71+instanceMatrix[3].z*.37;
          vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
          center.xy+=position.xy*vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
          gl_Position=projectionMatrix*center;
        }`,
      fragmentShader: `
        varying vec2 vUv; varying float vOpacity; varying float vSeed;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
        void main(){
          vec2 p=vUv*2.-1.;
          float n=noise(p*3.5+vSeed)*.65+noise(p*8.+vSeed)*.35;
          float rim=length(p)+(.5-n)*.25;
          float alpha=(1.-smoothstep(.32,1.,rim))*vOpacity;
          if(alpha<.008)discard;
          float light=clamp(.25+.45*vUv.y+.25*n,0.,1.);
          vec3 color=mix(vec3(.42,.28,.025),vec3(1.,.82,.21),light);
          gl_FragColor=vec4(color,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, CAPACITY * PUFFS);
    this.mesh.name = 'yellow-gas-clouds';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.opacity.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }
  release(ctx: Ctx, kart: IKart) {
    // Bound complete casts, so a surviving cast never loses only its oldest tail.
    if(this.emitters.length>=8){const old=this.emitters.shift()!;this.removeCast(old.cast);}
    const emitter={kart,last:kart.position.clone(),expires:this.clock+LIFETIME,cast:this.serial++,hit:new Set<number>()};
    this.emitters.push(emitter);
    this.emit(ctx,emitter,kart.position);
    this.render();
  }
  private removeCast(cast: number){
    for(let i=this.clouds.length-1;i>=0;i--)if(this.clouds[i].cast===cast)this.clouds.splice(i,1);
  }
  private emit(ctx: Ctx, emitter: typeof this.emitters[number], at: THREE.Vector3){
    if(this.clouds.length>=CAPACITY)return;
    const kart=emitter.kart;
    const back=kart.forward.clone().setY(0).normalize().negate();
    if(back.lengthSq()<.1)back.set(0,0,-1);
    const position=at.clone().addScaledVector(back,3);
    position.y=ctx.track.probe(position,kart.t).y+1.1;
    this.clouds.push({owner:kart.id,position,back,age:0,radius:7,seed:this.serial++,cast:emitter.cast,expires:emitter.expires,hit:emitter.hit});
  }
  update(ctx: Ctx, dt: number, karts: readonly IKart[]) {
    if(dt<=0)return;
    this.clock+=dt;
    for(let i=this.emitters.length-1;i>=0;i--){
      const e=this.emitters[i];
      if(this.clock>=e.expires-1e-8){this.removeCast(e.cast);this.emitters.splice(i,1);continue;}
      const distance=e.last.distanceTo(e.kart.position);
      if(distance>=1.5){
        const steps=Math.min(32,Math.ceil(distance/1.5));
        // Respawning is not a path: do not join a teleport across the map.
        if(distance<80)for(let j=1;j<=steps;j++)this.emit(ctx,e,e.last.clone().lerp(e.kart.position,j/steps));
        else this.emit(ctx,e,e.kart.position);
        e.last.copy(e.kart.position);
      }
    }
    for(const c of this.clouds){
      c.age+=dt;
      for(const k of karts){
        if(k.id===c.owner||k.finished||c.hit.has(k.id)||k.starTime>0||k.stunTime>0)continue;
        const dx=k.position.x-c.position.x,dz=k.position.z-c.position.z;
        const along=dx*c.back.x+dz*c.back.z,across=dx*c.back.z-dz*c.back.x;
        if(across*across/(c.radius*c.radius)+along*along/49>1||Math.abs(k.position.y-c.position.y)>2.4)continue;
        k.spinOut(1.15);
        if(k.stunTime>0){k.velocity.x=0;k.velocity.z=0;c.hit.add(k.id);}
      }
    }
    this.render();
  }
  private render() {
    let index=0;
    for(const c of this.clouds){
      const growth=Math.min(1,.8+c.age*4);
      const fade=Math.min(1,.6+c.age/.08);
      for(let j=0;j<PUFFS;j++){
        const angle=j*2.39996+c.seed*1.71;
        const ring=j===0?0:Math.sqrt(j/(PUFFS-1))*.58;
        const size=(1.4+.2*Math.sin(j*7+c.seed))*growth;
        this.dummy.position.copy(c.position);
        const across=Math.cos(angle)*ring*4*growth,along=Math.sin(angle)*ring*2.5*growth;
        this.dummy.position.x+=across*c.back.z+along*c.back.x;
        this.dummy.position.z+=-across*c.back.x+along*c.back.z;
        // Keep visual height independent of the collision volume.
        this.dummy.position.y+=-.65+Math.sin(j*3.7+c.seed)*.07;
        this.dummy.scale.set(size,(.32+.04*Math.sin(j*2.1))*growth,size);
        this.dummy.updateMatrix();this.mesh.setMatrixAt(index,this.dummy.matrix);
        this.opacity.setX(index++,fade*.10);
      }
    }
    this.mesh.count=index;this.mesh.instanceMatrix.needsUpdate=true;this.opacity.needsUpdate=true;
  }
  clear(){this.clouds.length=0;this.emitters.length=0;this.mesh.count=0;this.clock=0;}
  dispose(){this.clear();this.mesh.removeFromParent();this.mesh.geometry.dispose();(this.mesh.material as THREE.Material).dispose();}
}
