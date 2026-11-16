import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../apps/memory-sea/vendor/three/three.module.js';
import {BRAIN_VOLUME,brainGeometryData,createBrainMist} from '../apps/memory-sea/src/v5-brain.js';
import {GLBCharacter,SCENE_UNITS} from '../apps/memory-sea/src/v5-glb-character.js';
import {V5Scene,AUTO_ROTATION_SPEED} from '../apps/memory-sea/src/v5-scene.js';
import {AtlasCamera,atlasViewport,projectAtlas} from '../apps/memory-sea/src/v5-camera.js';
import {HEAD_VOLUME,LAYERS} from '../shared/v5-memory-layout.js';
import {REGIONS,CHANNELS} from '../core/v5-config.js';

test('folded paired hemispheres, cerebellum, stem and bridge fit inside the character head in all dimensions',()=>{
  const shape=brainGeometryData(),names=shape.parts.map(p=>p.name);
  assert.deepEqual(names,['left-cerebrum','right-cerebrum','left-cerebellum','right-cerebellum','brainstem','callosal-arch']);
  for(const part of [...shape.parts,{name:'cloud',positions:shape.cloud}]){
    assert.ok(part.positions.length>0);const range=[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]];
    for(let i=0;i<part.positions.length;i+=3){let distance=0;for(let axis=0;axis<3;axis++){const v=part.positions[i+axis];assert.ok(Number.isFinite(v));range[axis][0]=Math.min(range[axis][0],v);range[axis][1]=Math.max(range[axis][1],v);distance+=((v-BRAIN_VOLUME.center[axis])/BRAIN_VOLUME.radii[axis])**2;}assert.ok(distance<=.975**2+1e-12);}
    assert.ok(range.every(([low,high])=>high-low>10),part.name+' is a volume');
    if(part.name==='left-cerebrum')assert.ok(range[0][1]<0);if(part.name==='right-cerebrum')assert.ok(range[0][0]>0);
    if(part.creases){assert.equal(part.creases.length,part.positions.length/3);assert.ok(part.indices.every(i=>i>=0&&i<part.creases.length));}
  }
  for(const part of shape.parts.slice(0,4))assert.ok(Math.max(...part.creases)>.6&&Math.min(...part.creases)<.2,'gyri and grooves remain distinct');
});

test('brain mist has no picking layer, uses less opacity with the character and releases GPU resources',()=>{
  const brain=createBrainMist(THREE,SCENE_UNITS),view={unit:.6,distance:1000};let disposed=0;
  brain.group.traverse(object=>object.geometry?.addEventListener('dispose',()=>disposed++));
  brain.update(view);const surface=brain.group.children[0].material,standalone=surface.uniforms.opacity.value;
  for(const key of ['shadowColor','lightColor']){const color=surface.uniforms[key].value;assert.ok(color.r>color.g&&color.r>color.b,'mist uses a warm red palette');}
  brain.update(view,{characterVisible:true});assert.ok(surface.uniforms.opacity.value<standalone*.35);assert.equal(surface.depthWrite,false);assert.equal(surface.transparent,true);
  brain.update(view,{enabled:false});assert.equal(brain.group.visible,false);brain.dispose();assert.equal(disposed,7);
});

test('brain has comparable front-to-back depth and width without moving the memory layout',()=>{
  const points=brainGeometryData().parts.slice(0,2).flatMap(p=>p.positions),bounds=[0,1,2].map(axis=>{let low=Infinity,high=-Infinity;for(let i=axis;i<points.length;i+=3){low=Math.min(low,points[i]);high=Math.max(high,points[i]);}return high-low;});
  assert.ok(bounds[2]/bounds[0]>.90,'a side view must not collapse into a thin brain');
  assert.ok(bounds[2]>HEAD_VOLUME.radii[2]*2*1.4);
  assert.deepEqual(HEAD_VOLUME,{center:[0,600,0],radii:[285,260,205]},'memory coordinates keep their original contract');
});

test('head overview frames the expanded brain in front and side views at narrow and wide sizes',()=>{
  const shape=brainGeometryData();
  for(const [w,h]of [[390,520],[1000,720]])for(const yaw of [0,Math.PI/2,Math.PI]){
    const camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.yaw=yaw;camera.pitch=.035;
    const scene=Object.assign(Object.create(V5Scene.prototype),{camera,w,h,dockHeight:0,graph:{regions:REGIONS,layers:LAYERS}});camera.zoom=scene.fitHeadZoom();scene.prepareProjection();
    for(const part of shape.parts)for(let i=0;i<part.positions.length;i+=33){const p=projectAtlas({x:part.positions[i],y:part.positions[i+1],z:part.positions[i+2]},scene);assert.ok(p.inViewport,part.name+' remains visible');}
  }
});

test('brain renders before the GLB finishes, shares the camera and preserves the static GPU frame cache',()=>{
  let renders=0,updates=0;const character=Object.assign(Object.create(GLBCharacter.prototype),{ready:false,brain:{update(){updates++;}},model:{visible:true},scene:{},atlas:true,camera:new THREE.PerspectiveCamera(),renderer:{domElement:{style:{}},getPixelRatio:()=>1,setSize(){},render(){renders++;}}});
  const camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.zoom=2;const view={w:900,h:700,camera,rotation:{s:0,c:1,sp:0,cp:1},...atlasViewport(900,700,0,camera,true)};
  character.render(view,false);assert.equal(character.renderer.domElement.hidden,false);assert.equal(character.model.visible,false);assert.equal(renders,1);
  for(let i=0;i<60;i++)character.render(view,false);assert.equal(renders,1);assert.equal(updates,1);
  character.ready=true;character.render(view,true);assert.equal(character.model.visible,true);assert.equal(renders,2);
  character.render(view,false);assert.equal(character.model.visible,false);assert.equal(character.renderer.domElement.hidden,false);assert.equal(renders,3);
  view.showAtlas=false;character.render(view,false);assert.equal(character.renderer.domElement.hidden,true);assert.equal(renders,3);
  character.contextLost=true;view.showAtlas=true;character.render(view,true);assert.equal(renders,3,'a lost context must not resume drawing because brain geometry remains allocated');
});

test('clockwise rotation keeps the same angular speed across refresh rates and yields to inspection',()=>{
  for(const hz of [30,60,120]){
    const scene=Object.assign(Object.create(V5Scene.prototype),{camera:{yaw:0},autoRotate:true});
    for(let i=0;i<hz;i++)scene.rotateAutomatically(1000/hz,2000+i*1000/hz);assert.ok(Math.abs(scene.camera.yaw-AUTO_ROTATION_SPEED)<1e-12);
    for(const [key,value]of [['pointer',{}],['hovered','memory'],['selected','M1'],['view2d',true],['spinResumeAt',4000]]){scene[key]=value;const before=scene.camera.yaw;scene.rotateAutomatically(16,3000);assert.equal(scene.camera.yaw,before,key);delete scene[key];}
    scene.camera.destination={};const before=scene.camera.yaw;scene.rotateAutomatically(16,5000);assert.equal(scene.camera.yaw,before);scene.camera.destination=null;
    scene.setAutoRotate(false);scene.rotateAutomatically(16,5000);assert.equal(scene.camera.yaw,before);scene.setAutoRotate(true);scene.rotateAutomatically(16,5000);assert.ok(scene.camera.yaw>before);
  }
});

test('hiding names removes region, storage, branch and archive text while memory hit targets remain',()=>{
  const text=[],ctx=new Proxy({measureText:value=>({width:String(value).length*6}),fillText:value=>text.push(value)},{get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>(target[key]=value,true)}),camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.zoom=2;
  const scene=Object.assign(Object.create(V5Scene.prototype),{camera,ctx,w:1000,h:700,dockHeight:0,nodes:new Map(),active:new Map(),hits:[],showLabels:true,showChannels:true});
  scene.setGraph({regions:REGIONS,layers:LAYERS.map(l=>({...l,count:10})),channels:CHANNELS,nodes:[{id:'test-source',kind:'archive_digest',layer:'warm',region_ids:['M1'],archive_level:1,protection:'P2',label:'合成来源'}],edges:[]});scene.prepareProjection();
  scene.drawMist=()=>{};scene.drawMembrane=()=>{};scene.halo=()=>{};
  const draw=()=>{text.length=0;scene.drawStorage(5000);scene.drawChannels();scene.drawMemories(5000);scene.drawNames();};
  draw();assert.ok(text.includes('重要保存'));assert.ok(text.includes('L1'));assert.ok(text.some(t=>t.includes('巩固记忆')));
  scene.setLabels(false);draw();assert.deepEqual(text,[]);assert.ok(scene.hits.some(hit=>hit.type==='memory'&&hit.id==='test-source'));
  scene.setLabels(true);draw();assert.ok(text.length>0);
});

test('a foreground label click repaints a paused frame without restarting background animation',()=>{
  for(const foreground of [false,true]){let draws=0;const scene=Object.assign(Object.create(V5Scene.prototype),{graph:{},running:false,isForeground:()=>foreground,draw(){draws++;}});scene.setLabels(false);assert.equal(draws,foreground?1:0);assert.equal(scene.running,false);}
});
