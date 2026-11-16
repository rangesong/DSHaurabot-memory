import { seededRandom } from './layout.js';
import { LAYERS,MEMORY_FLOWS,HEAD_VOLUME } from '../../../shared/v5-memory-layout.js';
export { HEAD_VOLUME } from '../../../shared/v5-memory-layout.js';
import { workNebulaPoint } from './v5-nebula.js';

// Character coordinates: +Z is the face; +X is the character's left hemisphere.
export function headContains(p, margin=1) {
  return HEAD_VOLUME.center.reduce((sum,c,i)=>sum+((p[['x','y','z'][i]]-c)/(HEAD_VOLUME.radii[i]*margin))**2,0)<=1.000001;
}
function constrain(p) {
  const c=HEAD_VOLUME.center,r=HEAD_VOLUME.radii;
  const d=Math.sqrt(((p.x-c[0])/r[0])**2+((p.y-c[1])/r[1])**2+((p.z-c[2])/r[2])**2);
  if(d>.94)for(const [i,axis] of ['x','y','z'].entries())p[axis]=c[i]+(p[axis]-c[i])*.94/d;
  return p;
}
function ball(rng){const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.cbrt(rng()),s=Math.sqrt(1-z*z);return [Math.cos(a)*s*r,z*r,Math.sin(a)*s*r];}
export function primaryRegion(memory) {
  const preferred=({raw:'M4',experience:'M2',intent:'M2',person:'M3',pattern:'M3',knowledge:'M2',method:'M2',claim:'M1'})[memory.kind];
  return memory.region_ids?.includes(preferred)?preferred:memory.region_ids?.find(id=>/^M[1-4]$/.test(id))??'U';
}
export function memoryPoint(memory,regions,{now=Date.now(),recentHours=72}={}) {
  const rng=seededRandom(memory.id);
  const work=memory.layer==='implicit'&&regions.find(r=>r.id===memory.central_rule_region&&r.domain==='work');
  if(work)return constrain(workNebulaPoint(work,rng(),rng(),.5+rng()*.35));
  const region=LAYERS.find(layer=>layer.id===memory.layer)??regions.find(r=>r.id==='U'),v=ball(rng),radii=region.radii??[50,40,45];
  // Leave a clear margin inside the mist and film. Settling stays within this chamber.
  const settling=memory.layer==='recent'?Math.min(1,Math.max(0,now-memory.created_at)/(recentHours*3600000))*.40:0,spread=.86-settling;
  return constrain({x:region.position[0]+v[0]*radii[0]*spread,y:region.position[1]+(v[1]*spread-settling)*radii[1],z:region.position[2]+v[2]*radii[2]*spread});
}
// Static non-record structure points. They are neither memories nor fake run events.
export function regionStructure(region,count=24) {
  const rng=seededRandom('anatomy:'+region.id);
  return Array.from({length:count},()=>{if(region.domain==='work')return constrain(workNebulaPoint(region,rng(),rng(),Math.cbrt(rng())*.85));const v=ball(rng);return constrain({x:region.position[0]+v[0]*region.radii[0]*.80,y:region.position[1]+v[1]*region.radii[1]*.80,z:region.position[2]+v[2]*region.radii[2]*.80});});
}

export function memoryFlowPath(from,to){
  const start=from.startsWith('L:')?from:'L:'+from,target=to.startsWith('L:')?to:'L:'+to;
  const queue=[[start]],visited=new Set([start]);
  while(queue.length){const route=queue.shift(),last=route.at(-1);if(last===target)return route;
    for(const edge of MEMORY_FLOWS.filter(edge=>edge.from===last))if(!visited.has(edge.to)){visited.add(edge.to);queue.push([...route,edge.to]);}}
  return [start,target];
}
