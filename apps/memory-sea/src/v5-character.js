import { LAYERS,FORGET_EXIT } from '../../../shared/v5-memory-layout.js';
import { nebulaEnvelope } from './v5-nebula.js';
/** Neural channel geometry; the character itself comes only from the supplied GLB. */
const P=(x,y,z=0)=>({x,y,z});
const mix=(a,b,t)=>a+(b-a)*t;
const norm=v=>{const n=Math.hypot(v.x,v.y,v.z)||1;return P(v.x/n,v.y/n,v.z/n);};
const cross=(a,b)=>P(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);
export function smoothPath(points){
  if(points.length<4||points.length>24)return points;
  const result=[];
  for(let i=0;i<points.length-1;i++){
    const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
    for(let j=0;j<7;j++){const t=j/7,t2=t*t,t3=t2*t,p={};for(const axis of ['x','y','z'])p[axis]=.5*(2*b[axis]+(-a[axis]+c[axis])*t+(2*a[axis]-5*b[axis]+4*c[axis]-d[axis])*t2+(-a[axis]+3*b[axis]-3*c[axis]+d[axis])*t3);result.push(p);}
  }
  result.push(points.at(-1));return result;
}
export const ATLAS_TERMINALS=[
  {id:'IN',name:'感知入口',domain:'terminal',position:[-225,690,70],radii:[8,8,8],color:'#9de7f1'},
  {id:'OUT',name:'表达出口',domain:'terminal',position:[225,510,75],radii:[8,8,8],color:'#b7efdb'},
];
export function channelGeometry(regions,channels,layers=LAYERS){
  const shapes=new Map([...regions,...layers.map(layer=>({...layer,id:'L:'+layer.id,domain:'store-layer'})),FORGET_EXIT,...ATLAS_TERMINALS].map(r=>[r.id,r]));
  const positions=new Map([...shapes].map(([id,r])=>[id,P(...r.position)]));
  const degree=new Map();for(const c of channels)for(const key of[c.from,c.to]){if(!degree.has(key))degree.set(key,[]);degree.get(key).push(c.id);}
  const used=new Map();
  const port=(id,other,channel)=>{
    const shape=shapes.get(id),a=positions.get(id),b=positions.get(other);
    if(!a||!b)throw new Error('星图通道缺少可见端点：'+id+' → '+other);
    const toward=norm(P(b.x-a.x,b.y-a.y,b.z-a.z)),tangent=norm(cross(toward,Math.abs(toward.y)>.9?P(1,0,0):P(0,1,0))),bitangent=cross(toward,tangent),index=degree.get(id).indexOf(channel),angle=index*2.399963229728653;
    const direction=norm(P(...['x','y','z'].map(axis=>toward[axis]+.23*(tangent[axis]*Math.sin(angle)+bitangent[axis]*Math.cos(angle))))),envelope=nebulaEnvelope(shape),occupied=used.get(id)??new Set();used.set(id,occupied);
    let best=-Infinity,chosen=0;for(let i=0;i<envelope.vertices.length;i++){if(occupied.has(i))continue;const p=envelope.vertices[i];if([...occupied].some(index=>{const q=envelope.vertices[index];return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<2.3;}))continue;const score=(p.x-a.x)*direction.x+(p.y-a.y)*direction.y+(p.z-a.z)*direction.z;if(score>best){best=score;chosen=i;}}
    occupied.add(chosen);const position=envelope.vertices[chosen],core=envelope.anchors[chosen];
    return {region:id,peer:other,position,anchor:P(...['x','y','z'].map(axis=>mix(core[axis],position[axis],.50)))};
  };
  return channels.map(c=>{const from=port(c.from,c.to,c.id),to=port(c.to,c.from,c.id),a=from.position,b=to.position;return {...c,a,b,control:P((a.x+b.x)/2+(c.from==='U'||c.to==='U'?25:0),(a.y+b.y)/2,(a.z+b.z)/2+28),ports:[from,to]};});
}
export function curve(path,t){const u=1-t;return P(u*u*path.a.x+2*u*t*path.control.x+t*t*path.b.x,u*u*path.a.y+2*u*t*path.control.y+t*t*path.b.y,u*u*path.a.z+2*u*t*path.control.z+t*t*path.b.z);}
