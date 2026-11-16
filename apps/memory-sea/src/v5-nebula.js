import { seededRandom } from './layout.js';
import { HEAD_VOLUME } from '../../../shared/v5-memory-layout.js';

const envelopeCache=new WeakMap();
const world=(region,x,y,z)=>{const p={x:region.position[0]+x,y:region.position[1]+y,z:region.position[2]+z},distance=Math.sqrt(HEAD_VOLUME.center.reduce((sum,c,i)=>sum+((p[['x','y','z'][i]]-c)/HEAD_VOLUME.radii[i])**2,0));if(distance>.96)for(const [i,axis]of ['x','y','z'].entries())p[axis]=HEAD_VOLUME.center[i]+(p[axis]-HEAD_VOLUME.center[i])*.96/distance;return p;};

/** Closed fog volumes also define the visible surface on which neural ports terminate. */
export function nebulaEnvelope(region){
  if(envelopeCache.has(region))return envelopeCache.get(region);
  const vertices=[],faces=[],folds=[],anchors=[];
  function grid(sample,rows=12,columns=24,open=false){
    const offset=vertices.length,n=rows+1;
    for(let row=0;row<n;row++)for(let col=0;col<columns;col++)vertices.push(sample(col/columns,row/rows));
    const average=points=>Object.fromEntries(['x','y','z'].map(axis=>[axis,points.reduce((sum,p)=>sum+p[axis],0)/points.length]));
    const center=average(vertices.slice(offset));
    for(let row=0;row<n;row++){const anchor=open?average(vertices.slice(offset+row*columns,offset+(row+1)*columns)):center;for(let col=0;col<columns;col++)anchors.push(anchor);}
    for(let row=0;row<rows;row++)for(let col=0;col<columns;col++)faces.push([offset+row*columns+col,offset+row*columns+(col+1)%columns,offset+(row+1)*columns+(col+1)%columns,offset+(row+1)*columns+col]);
    if(open)for(const row of [0,rows]){const center=average(vertices.slice(offset+row*columns,offset+(row+1)*columns)),cap=vertices.push(center)-1;anchors.push(center);for(let col=0;col<columns;col++)faces.push([cap,offset+row*columns+col,offset+row*columns+(col+1)%columns]);}
  }
  const [rx,ry,rz]=region.radii;
  if(region.id==='W1'){
    for(const side of [0,1])grid((u,v)=>workNebulaPoint(region,(u+side)*.5,v,.98),10,24);
    for(const side of [0,1])for(const v of [.30,.63])folds.push(Array.from({length:33},(_,i)=>workNebulaPoint(region,(i/32*.4995+side*.5),v,.77)));
  }else if(region.id==='W2'){
    const ribbon=(v,u)=>{const a=(u-.5)*Math.PI,t=v*Math.PI*2,fold=1+.045*Math.sin(u*42+(Math.cos(t)+1)*10.5);return world(region,Math.sin(a)*rx*fold,Math.cos(t)*ry*.96,((Math.cos(a)*.8-.1)+Math.sin(t)*.25)*rz);};
    grid(ribbon,24,14,true);
    for(const v of [.08,.24,.40,.56,.72])folds.push(Array.from({length:41},(_,i)=>ribbon(v,.04+i/40*.92)));
  }else if(region.id==='W5'){
    grid((v,u)=>workNebulaPoint(region,u,v,.98),32,14,true);
    for(const v of [.12,.42,.72])folds.push(Array.from({length:45},(_,i)=>workNebulaPoint(region,.03+i/44*.94,v,.60)));
  }else if(region.domain==='work'){
    grid((u,v)=>workNebulaPoint(region,u,v,.98),12,28);
    for(const v of [.27,.5,.73])folds.push(Array.from({length:41},(_,i)=>workNebulaPoint(region,i/40,v,.75)));
  }else{
    grid((u,v)=>{const a=u*Math.PI*2,b=Math.acos(2*v-1),s=Math.sin(b),fold=region.domain==='memory'?1+.035*Math.sin(a*5+b*3):1;return world(region,Math.cos(a)*s*rx*.95*fold,Math.cos(b)*ry*.95,Math.sin(a)*s*rz*.95*fold);},10,24);
  }
  const hub=region.id==='W2'?workNebulaPoint(region,.5,.5,.15):region.id==='W5'?workNebulaPoint(region,.36,.5,.10):world(region,0,0,0);
  const faceNormals=faces.map(face=>{const [a,b,d]=face.map(i=>vertices[i]),ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,vx=d.x-a.x,vy=d.y-a.y,vz=d.z-a.z,x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;return {x,y,z,length:Math.hypot(x,y,z)||1};});
  const result={vertices,faces,faceNormals,folds,anchors,hub};envelopeCache.set(region,result);return result;
}

// Anatomical silhouettes are artistic approximations, sampled as volumes rather than flat discs.
// +X is the character's left side; each W module keeps a separate, closed mist envelope.
export function workNebulaPoint(region,u,v,depth=1){
  const [rx,ry,rz]=region.radii,a=u*Math.PI*2,b=Math.acos(2*v-1),s=Math.sin(b),c=Math.cos(b);
  let x,y,z;
  if(region.id==='W5'){
    const t=(u*1.55-.77)*Math.PI,width=(.25+.65*(1-u))*depth;
    const cv=Math.cos(v*Math.PI*2),sv=Math.sin(v*Math.PI*2),ct=Math.cos(t),st=Math.sin(t);
    // Tilt the C-shaped body so both its curved silhouette and tube depth remain visible.
    x=rx*(ct*.68+cv*ct*.34*width);
    y=ry*(st*.78+(cv*st*.8-sv*.6)*.32*width);
    z=rz*(st*.36+(cv*st*.6+sv*.8)*.22*width);
  }else if(region.id==='W1'){
    const side=u<.5?-1:1,angle=(u*2%1)*Math.PI*2;
    x=side*rx*.33+Math.cos(angle)*s*rx*.61*depth;y=c*ry*.91*depth;z=Math.sin(angle)*s*rz*.86*depth;
  }else if(region.id==='W2'){
    const angle=(u-.5)*Math.PI,fold=1+.045*Math.sin(u*42+v*21);
    x=Math.sin(angle)*rx*fold;y=c*ry*depth;z=(Math.cos(angle)*.8-.1)*rz+Math.sin(b)*rz*.25*depth;
  }else if(region.id==='W3'){
    const taper=Math.pow(s,1.35);x=c*rx*1.12*depth;y=Math.cos(a)*taper*ry*.79*depth;z=Math.sin(a)*taper*rz*.72*depth;
  }else{
    const lobe=.78+.16*Math.cos(a*3),fold=1+.065*Math.sin(a*8+b*4);
    x=c*rx*.55*depth;y=Math.cos(a)*s*ry*lobe*fold*depth;z=Math.sin(a)*s*rz*lobe*depth;
  }
  const p={x:region.position[0]+x,y:region.position[1]+y,z:region.position[2]+z},distance=Math.sqrt(HEAD_VOLUME.center.reduce((sum,c,i)=>sum+((p[['x','y','z'][i]]-c)/HEAD_VOLUME.radii[i])**2,0));
  if(distance>.96)for(const[i,axis]of ['x','y','z'].entries())p[axis]=HEAD_VOLUME.center[i]+(p[axis]-HEAD_VOLUME.center[i])*.96/distance;
  return p;
}

export function workNebula(region,count=220){
  const rng=seededRandom('anatomy-mist:'+region.id);
  return {region,envelope:nebulaEnvelope(region),particles:Array.from({length:count},()=>({...workNebulaPoint(region,rng(),rng(),Math.cbrt(rng())*.90),size:Math.min(4+rng()*4,Math.min(...region.radii)*.24),phase:rng()*Math.PI*2})),
    outlines:Array.from({length:3},(_,j)=>Array.from({length:65},(_,i)=>workNebulaPoint(region,i/64,(j+1)/4,.96)))};
}

/** Soft, bounded mist for a directory, the U hub, or one U storage chamber. */
export function regionNebula(region,count=null){
  if(region.domain==='work')return workNebula(region,count??220);
  count??=region.domain==='memory'?150:72;
  const rng=seededRandom('volume-mist:'+region.id),phase=rng()*Math.PI*2;
  return {region,phase,envelope:region.domain==='memory'?nebulaEnvelope(region):null,particles:Array.from({length:count},()=>{
    const z=rng()*2-1,a=rng()*Math.PI*2,r=Math.cbrt(rng())*.80,s=Math.sqrt(1-z*z);
    return {x:region.position[0]+Math.cos(a)*s*r*region.radii[0],y:region.position[1]+z*r*region.radii[1],z:region.position[2]+Math.sin(a)*s*r*region.radii[2],size:Math.min(3+rng()*4,Math.min(...region.radii)*.17),phase:rng()*Math.PI*2};
  }),outlines:[]};
}

/** Unit surface shared by all breathing films. Filled faces only, with no boundary strokes. */
export function membraneMesh(rings=10,sides=24){
  const vertices=[],faces=[];
  for(let row=0;row<=rings;row++)for(let col=0;col<sides;col++){
    const a=col/sides*Math.PI*2,b=row/rings*Math.PI;
    vertices.push([Math.sin(b)*Math.cos(a),Math.cos(b),Math.sin(b)*Math.sin(a)]);
  }
  for(let row=0;row<rings;row++)for(let col=0;col<sides;col++){
    const next=(col+1)%sides,indices=[row*sides+col,row*sides+next,(row+1)*sides+next,(row+1)*sides+col];
    faces.push({indices,normal:[0,1,2].map(axis=>indices.reduce((sum,i)=>sum+vertices[i][axis],0)/4)});
  }
  return {vertices,faces};
}

export function galaxyStars(count=600){
  const rng=seededRandom('milky-way'),normal=()=>Math.sqrt(-2*Math.log(Math.max(.00001,rng())))*Math.cos(rng()*Math.PI*2);
  return Array.from({length:count},(_,i)=>{const x=rng(),band=i<count*.68,y=band?.18+x*.5+Math.sin(x*6)*.05+normal()*.055:rng(),bright=rng()>.955;
    return {x,y:Math.max(0,Math.min(1,y)),size:bright?1.1+rng()*.8:.3+rng()*.6,alpha:bright?.65+rng()*.25:.13+rng()*.38,color:rng()>.85?'#ffe6b5':'#cce3ff',phase:rng()*Math.PI*2,bright};});
}
