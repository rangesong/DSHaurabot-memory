import {seededRandom} from './layout.js';

// Anatomical illustration, fitted to the character's established intracranial volume.
// +Z is anterior; +Y is superior. No memory positions or regional boundaries are changed.
// This visual envelope follows the supplied head mesh; HEAD_VOLUME still owns star placement.
export const BRAIN_VOLUME=Object.freeze({center:Object.freeze([0,610,45]),radii:Object.freeze([365,280,350])});
export const BRAIN_MIST_COLORS=Object.freeze({shadow:'#9e5963',light:'#ffd2d5',cloud:'#edb4bd'});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),bell=(v,width)=>Math.exp(-((v/width)**2));
const fit=(x,y,z)=>{const length=Math.hypot(x,y,z),scale=length>.975?.975/length:1;return [x,y,z].map((v,i)=>BRAIN_VOLUME.center[i]+v*scale*BRAIN_VOLUME.radii[i]);};
const data=(name)=>({name,positions:[],creases:[],indices:[]});
function vertex(part,position,crease=0){part.positions.push(...position);part.creases.push(clamp(crease,0,1));return part.creases.length-1;}
function quad(part,a,b,c,d,reverse=false){part.indices.push(...(reverse?[a,b,c,b,d,c]:[a,c,b,b,c,d]));}

function cortex(side,theta,phi){
  const sx=Math.sin(theta)*Math.sin(phi),sy=Math.cos(theta),sz=Math.sin(theta)*Math.cos(phi);
  // Warped, branching furrows create raised gyri rather than a smooth ellipsoid.
  const x=sx*14+.7*Math.sin(sz*7),y=sy*14+.6*Math.sin(sx*7),z=sz*14+.7*Math.sin(sy*6);
  const maze=Math.sin(x)*Math.cos(y)+Math.sin(y)*Math.cos(z)+Math.sin(z)*Math.cos(x);
  const secondary=Math.sin(x*.73+y*.64)+Math.sin(z*1.2-y*.58);
  const minor=.058*bell(maze,.38)+.015*bell(secondary,.23),cap=Math.min(1,Math.sin(theta)*5);
  const centralLine=1.5+.20*Math.cos(theta*2)+.08*Math.sin(theta*5),central=bell(phi-centralLine,.041)*bell(theta-1.0,.95);
  const neighbors=.34*(bell(phi-centralLine-.24,.045)+bell(phi-centralLine+.24,.045))*bell(theta-1.05,1);
  const sylvian=bell(theta-(1.94+.10*Math.cos(phi*1.6)+.045*Math.sin(phi*4)),.045)*Math.sin(phi)**2;
  const depth=(minor+.052*(central+neighbors)+.064*sylvian)*cap;
  const frontal=.025*bell(phi-.6,.7)*bell(theta-1,1),temporal=.055*bell(theta-2.13,.35)*Math.sin(phi)**2;
  const radius=1-depth+(frontal+.008*Math.cos(x*.6+z*.5))*cap;
  return {position:fit(side*(.020+sx*(.94+temporal)*radius),.065+sy*.865*radius-temporal*.35,.015+sz*.91*radius*(1-.12*Math.max(0,sy))),crease:depth/.085};
}

/** Shared, deterministic world-space geometry. Fine folds are prepared once, never per frame. */
export function brainGeometryData({rows=88,columns=128}={}){
  const parts=[];
  for(const side of [-1,1]){
    const part=data(side<0?'left-cerebrum':'right-cerebrum'),stride=columns+1;
    for(let row=0;row<=rows;row++)for(let col=0;col<=columns;col++){const p=cortex(side,row/rows*Math.PI,col/columns*Math.PI);vertex(part,p.position,p.crease);}
    for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){const a=row*stride+col;quad(part,a,a+1,a+stride,a+stride+1,side<0);}
    // Leave the medial opening clear: a translucent flat cap would look like a curtain.
    parts.push(part);
  }
  for(const side of [-1,1]){
    const part=data(side<0?'left-cerebellum':'right-cerebellum'),rings=72,sides=64,stride=sides+1;
    for(let row=0;row<=rings;row++)for(let col=0;col<=sides;col++){
      const t=row/rings*Math.PI,p=col/sides*Math.PI*2,furrow=((1+Math.sin(t*46+.7*Math.sin(p*3)))/2)**5,r=1-.065*furrow;
      vertex(part,fit(side*.17+Math.sin(t)*Math.cos(p)*.32*r,-.635+Math.cos(t)*.22*r,-.50+Math.sin(t)*Math.sin(p)*.30*r),furrow*.8);
    }
    for(let row=0;row<rings;row++)for(let col=0;col<sides;col++){const a=row*stride+col;quad(part,a,a+1,a+stride,a+stride+1,true);}
    parts.push(part);
  }
  const stem=data('brainstem'),rings=36,sides=32,stride=sides+1;
  for(let row=0;row<=rings;row++)for(let col=0;col<=sides;col++){
    const t=row/rings,a=col/sides*Math.PI*2,r=.065+.055*bell(t-.27,.19),y=-.44-t*.48,z=-.035+t*.095;
    vertex(stem,fit(Math.cos(a)*r,y,z+Math.sin(a)*r*.8),.12+.12*Math.cos(a*4));
  }
  for(let row=0;row<rings;row++)for(let col=0;col<sides;col++){const a=row*stride+col;quad(stem,a,a+1,a+stride,a+stride+1,true);}parts.push(stem);
  const bridge=data('callosal-arch'),sections=64,tubeSides=10;
  for(let row=0;row<=sections;row++)for(let col=0;col<=tubeSides;col++){
    const t=-.16+(row/sections)*Math.PI*1.18,a=col/tubeSides*Math.PI*2;
    vertex(bridge,fit(Math.sin(a)*.028,.04+Math.sin(t)*(.25+Math.cos(a)*.026),.02+Math.cos(t)*(.43+Math.cos(a)*.027)),.1);
  }
  for(let row=0;row<sections;row++)for(let col=0;col<tubeSides;col++){const a=row*(tubeSides+1)+col;quad(bridge,a,a+1,a+tubeSides+1,a+tubeSides+2,true);}parts.push(bridge);
  const rng=seededRandom('intracranial-brain-mist'),cloud=[];
  for(let i=0;i<840;i++){
    const p=cortex(i%2?-1:1,Math.acos(rng()*2-1),rng()*Math.PI).position,r=.25+Math.cbrt(rng())*.68;
    cloud.push(...p.map((v,axis)=>BRAIN_VOLUME.center[axis]+(v-BRAIN_VOLUME.center[axis])*r));
  }
  return {parts,cloud};
}

const vertexShader=`
  attribute float crease;
  varying vec3 vNormal; varying vec3 vEye; varying vec3 vLocal; varying float vCrease;
  void main(){vec4 p=modelViewMatrix*vec4(position,1.);vNormal=normalize(normalMatrix*normal);vEye=-p.xyz;vLocal=position*12.;vCrease=crease;gl_Position=projectionMatrix*p;}
`;
const fragmentShader=`
  uniform float opacity;
  uniform vec3 shadowColor; uniform vec3 lightColor;
  varying vec3 vNormal; varying vec3 vEye; varying vec3 vLocal; varying float vCrease;
  float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
  float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
  void main(){
    vec3 n=normalize(vNormal),eye=normalize(vEye);
    float rim=pow(1.-abs(dot(n,eye)),2.1),light=.30+.70*max(0.,dot(n,normalize(vec3(-.45,.65,.7))));
    float smoke=.56+.28*noise(vLocal*5.)+.16*noise(vLocal*11.);
    float furrow=clamp(vCrease*1.6,0.,1.);
    vec3 color=mix(shadowColor,lightColor,light)*(1.-.80*furrow);
    float alpha=opacity*(.10+.40*rim+.28*light+.30*(1.-furrow))*smoke;
    if(!gl_FrontFacing)alpha*=.55;
    gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
  }
`;

/** Reuses the character renderer, including while the character asset is still loading. */
export function createBrainMist(THREE,units){
  const group=new THREE.Group(),geometries=[],materials=[],shape=brainGeometryData(),opacity={value:.43};group.name='intracranial-brain-mist';
  const material=new THREE.ShaderMaterial({uniforms:{opacity,shadowColor:{value:new THREE.Color(BRAIN_MIST_COLORS.shadow)},lightColor:{value:new THREE.Color(BRAIN_MIST_COLORS.light)}},vertexShader,fragmentShader,transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});material.forceSinglePass=true;materials.push(material);
  for(const part of shape.parts){
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.positions.map(v=>v/units),3));geometry.setAttribute('crease',new THREE.Float32BufferAttribute(part.creases,1));geometry.setIndex(part.indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();geometries.push(geometry);
    const mesh=new THREE.Mesh(geometry,material);mesh.name=part.name;mesh.renderOrder=-5;group.add(mesh);
  }
  const cloud=new THREE.BufferGeometry();cloud.setAttribute('position',new THREE.Float32BufferAttribute(shape.cloud.map(v=>v/units),3));geometries.push(cloud);
  const scale={value:1},cloudMaterial=new THREE.ShaderMaterial({uniforms:{opacity,scale,cloudColor:{value:new THREE.Color(BRAIN_MIST_COLORS.cloud)}},transparent:true,depthWrite:false,toneMapped:false,
    vertexShader:'uniform float scale; void main(){vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(32.*scale/max(.005,-p.z),2.,48.);gl_Position=projectionMatrix*p;}',
    fragmentShader:'uniform float opacity; uniform vec3 cloudColor; void main(){float r=length(gl_PointCoord-.5)*2.;if(r>=1.)discard;gl_FragColor=vec4(cloudColor,opacity*.09*pow(1.-r,2.));\n#include <colorspace_fragment>\n}'});materials.push(cloudMaterial);
  const points=new THREE.Points(cloud,cloudMaterial);points.name='interior-mist';points.renderOrder=-4;group.add(points);
  return {group,update(view,{enabled=true,characterVisible=false,pixelRatio=1}={}){group.visible=enabled;opacity.value=characterVisible?.10:.43;scale.value=view.unit*view.distance/units*pixelRatio;},dispose(){for(const g of geometries)g.dispose();for(const m of materials)m.dispose();group.removeFromParent();}};
}
