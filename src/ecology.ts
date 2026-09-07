import * as THREE from 'three'
import { createVegetation, createWildlife, createNatureSoundscape, randomOf, type PlantSite, type PlantKind } from 'world-core/ecology'
import { heightAt } from './world/terrain'
import { LAKE } from './world/layout'
import { scatterClear } from './world/scatterClearance'
import type { Ambient } from './ambient'

export const alpineSiteClear = scatterClear
export async function createEcology(scene:THREE.Scene,ambient:Ambient,quality:string){
  const rand=randomOf(270907),sites:PlantSite[]=[],count=quality==='low'?100:quality==='medium'?160:225
  for(let i=0;i<count*18&&sites.length<count;i++){
    const x=-28+rand()*63,z=-74+rand()*95,y=heightAt(x,z)
    if(y<LAKE.y+0.4||y>14||!alpineSiteClear(x,z,1.2))continue
    const slope=Math.max(Math.abs(heightAt(x+0.5,z)-y),Math.abs(heightAt(x,z+0.5)-y))
    if(slope>0.31)continue
    const kinds:PlantKind[]=y<LAKE.y+2?['reeds','grass']:['grass','grass','juniper','rowan','fern','spruce']
    const kind=kinds[Math.floor(rand()*kinds.length)]
    if(sites.some(p=>Math.hypot(x-p.x,z-p.z)<(kind==='spruce'?2.3:0.8)))continue
    sites.push({kind,x,y,z,yaw:rand()*Math.PI*2,scale:(kind==='spruce'?0.5:0.65)+rand()*0.35,seed:i})
  }
  const root=new THREE.Group();root.name='alpine-life'
  const groups:ReturnType<typeof createVegetation>[]=[]
  for(const kind of new Set(sites.map(p=>p.kind))){
    await new Promise(resolve=>setTimeout(resolve,0))
    const group=createVegetation(sites.filter(p=>p.kind===kind),{variants:2,cellSize:42});groups.push(group);root.add(group.root)
  }
  const sound=createNatureSoundscape(()=>ambient.bus,{seed:891,alpine:true})
  const fauna=createWildlife({seed:991,kinds:['raven','fox'],surfaceAt:(x,z)=>{
    if(x< -28||x>35||z< -74||z>21)return null
    const h=heightAt(x,z);return h>LAKE.y+0.4?h:null
  },canStand:(x,z)=>alpineSiteClear(x,z,1.1),onCall:(kind,p)=>sound.play(kind,p,0.8)})
  root.add(fauna.root);scene.add(root)
  const direction=new THREE.Vector3()
  let time=0
  return {root,sites,groups,fauna,sound,update(dt:number,camera:THREE.Camera,active:boolean,indoors:boolean,wind:number,reduced:boolean){
    time+=Math.min(0.1,dt);camera.getWorldDirection(direction)
    const weather={active,position:camera.position,direction,shelter:indoors?1:0,storm:wind,reducedMotion:reduced}
    for(const group of groups)group.update(time,wind,reduced)
    sound.update(dt,weather);fauna.update(dt,camera.position,weather)
  },dispose(){for(const g of groups)g.dispose();fauna.dispose();sound.dispose();root.removeFromParent()}}
}
