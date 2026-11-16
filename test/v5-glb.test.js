import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from '../apps/memory-sea/vendor/three/three.module.js';
import { GLBCharacter,CHARACTER_RESOURCE_VERSION,syncModelCamera,fitModelToAtlas,SCENE_UNITS,createAtlasGlass,characterOpacity,glassSurfaceAlpha } from '../apps/memory-sea/src/v5-glb-character.js';
import { AtlasCamera,atlasViewport,projectAtlas,MAX_ZOOM } from '../apps/memory-sea/src/v5-camera.js';
import { HEAD_VOLUME,headContains } from '../apps/memory-sea/src/v5-spatial.js';
import { V5Scene } from '../apps/memory-sea/src/v5-scene.js';
import { REGIONS } from '../core/v5-config.js';
import { createMemorySeaServer } from '../scripts/serve-memory-sea.js';
import { V5Runtime } from '../core/v5-runtime.js';

const hasLocalCharacter=existsSync(new URL('../apps/memory-sea/assets/blue-maid-starry.glb',import.meta.url));
test('model cache identity follows the separately versioned unchanged resource',()=>{
  const resource=JSON.parse(readFileSync(new URL('../release/resources.json',import.meta.url)));
  assert.equal(CHARACTER_RESOURCE_VERSION,resource.version);
});

test('atlas keeps drawing memories while the supplied model loads or fails, without a replacement character',()=>{
  for(const state of ['loading','failed','ready']){
    const calls=[],scene=Object.create(V5Scene.prototype);
    const ctx=Object.fromEntries(['setTransform','clearRect','save','beginPath','rect','clip','restore','fillText'].map(name=>[name,()=>calls.push(name)]));
    Object.assign(scene,{ctx,w:900,h:700,dpr:1,graph:{},showAtlas:true,showWire:true,plotTop:40,plotHeight:500,glb:{ready:state==='ready',render(view,visible){assert.equal(view,scene);assert.equal(visible,true);calls.push('glb');}}});
    for(const name of ['prepareProjection','drawGalaxy','drawRegionMist','drawStorage','drawChannels','drawBrain','drawRegions','drawMemories','drawActivity','drawNames','drawMeteors'])scene[name]=()=>calls.push(name);
    scene.drawCharacter=()=>assert.fail('obsolete character must never be drawn');
    scene.draw(100);
    assert.ok(calls.indexOf('clearRect')<calls.indexOf('glb'),state);
    assert.ok(calls.includes('drawMemories')&&calls.includes('drawNames'),state);
    assert.equal(calls.filter(name=>name==='glb').length,1,state);
  }
});

test('a failed supplied model hides its character layer and reports the failure without a substitute',()=>{
  const statuses=[],character=Object.create(GLBCharacter.prototype);
  Object.assign(character,{ready:true,renderer:{domElement:{hidden:false}},status:value=>statuses.push(value)});
  character.fail(new Error('模型文件读取失败'));
  assert.equal(character.ready,false);assert.equal(character.renderer.domElement.hidden,true);
  assert.equal(statuses[0].state,'failed');assert.match(statuses[0].message,/模型文件读取失败/);
});
test('imported GLB keeps its verified binary, embedded star maps and physical glass material',{skip:!hasLocalCharacter&&'Optional local character resource is not part of the source checkout'},()=>{
  const bytes=readFileSync(new URL('../apps/memory-sea/assets/blue-maid-starry.glb',import.meta.url)),manifest=JSON.parse(readFileSync(new URL('../apps/memory-sea/assets/blue-maid-starry.json',import.meta.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
  const length=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+length).toString());
  assert.equal(gltf.accessors[0].count,310118);assert.equal(gltf.accessors[3].count/3,500000);
  const material=gltf.materials[0];assert.equal(material.extensions.KHR_materials_transmission.transmissionFactor,.85);assert.equal(material.extensions.KHR_materials_emissive_strength.emissiveStrength,1.6);assert.equal(material.extensions.KHR_materials_ior.ior,1.45);assert.equal(material.emissiveTexture.index,1);
  assert.equal(gltf.images.length,3);assert.ok(gltf.images.every(image=>!image.uri&&image.mimeType==='image/png'));assert.ok(gltf.buffers.every(buffer=>!buffer.uri));
  const binary=bytes.subarray(28+length);for(const image of gltf.images){const offset=gltf.bufferViews[image.bufferView].byteOffset??0;assert.equal(binary.readUInt32BE(offset+16),4096);assert.equal(binary.readUInt32BE(offset+20),4096);}
});

test('WebGL and interactive stars stay pixel-aligned outside and inside the head, with matching clipping',()=>{
  for(const [w,h,dock] of [[714,660,160],[1180,960,185],[390,650,180]])for(const [yaw,pitch,zoom,panX,panY] of [[0,0,1,0,0],[Math.PI/2,.1,3.4,40,-10],[Math.PI,-.2,6,-20,15],[-.44,.25,16,0,0],[.8,-.5,32,12,-8]]){
    const camera=new THREE.PerspectiveCamera(),state=new AtlasCamera();Object.assign(state,{yaw,pitch,zoom,panX,panY,target:{x:0,y:600,z:0}});
    const view={w,h,camera:state,...atlasViewport(w,h,dock,state,true),rotation:{c:Math.cos(yaw),s:Math.sin(yaw),cp:Math.cos(pitch),sp:Math.sin(pitch)}};syncModelCamera(camera,view);
    for(const point of [{x:0,y:600,z:0},{x:180,y:580,z:110},{x:-179,y:647,z:-65},{x:80,y:-500,z:100}]){
      const overlay=projectAtlas(point,view),p=new THREE.Vector3(point.x,point.y,point.z).divideScalar(SCENE_UNITS).project(camera),actual=[(p.x+1)*w/2,(1-p.y)*h/2];
      assert.equal(overlay.visible,p.z>=-1&&p.z<=1);
      if(overlay.visible){assert.ok(Math.abs(actual[0]-overlay.x)<1e-7);assert.ok(Math.abs(actual[1]-overlay.y)<1e-7);}
      else assert.equal(overlay.inViewport,false,'clipped stars must not become click targets');
    }
  }
});

test('whole-character glass preserves star maps and can restore the exact authored material',()=>{
  const map=new THREE.Texture(),emissiveMap=new THREE.Texture(),normalMap=new THREE.Texture(),source=new THREE.MeshPhysicalMaterial({map,emissiveMap,normalMap,transmission:.85,thickness:.6,emissiveIntensity:1.6,side:THREE.DoubleSide});
  const geometry=new THREE.BoxGeometry(),a=new THREE.Mesh(geometry,source),b=new THREE.Mesh(geometry,[source,source]),model=new THREE.Group();model.add(a,b);
  const glass=createAtlasGlass(model),copy=a.material;
  assert.notEqual(copy,source);assert.equal(b.material[0],copy);assert.equal(copy.map,map);assert.equal(copy.emissiveMap,emissiveMap);assert.equal(copy.normalMap,normalMap);
  assert.equal(source.opacity,1);assert.equal(source.transmission,.85);assert.equal(source.emissiveIntensity,1.6);assert.equal(source.side,THREE.DoubleSide);
  assert.equal(copy.transparent,true);assert.equal(copy.depthWrite,false);assert.ok(copy.transmission>.7);assert.ok(copy.emissiveIntensity>0&&copy.emissiveIntensity<source.emissiveIntensity);assert.ok(copy.clearcoat>.5);
  const face=glassSurfaceAlpha(1),rim=glassSurfaceAlpha(0);assert.ok(rim>face*3);assert.ok(glassSurfaceAlpha(1,{stars:1})>face*2);assert.ok(glassSurfaceAlpha(1,{highlight:1})>face*1.5);
  assert.ok(glassSurfaceAlpha(1,{headBlend:0})>face*2,'the dress and tail retain more body than the head interior');
  for(let zoom=.35;zoom<=32;zoom+=.25){const alpha=characterOpacity(zoom);assert.ok(alpha>=.5&&alpha<=.9);assert.ok(rim*alpha>.28,'even the nearest view keeps a recognizable contour');assert.ok(face*alpha<.2,'the face stays thin enough to read the interior');for(const surfaces of [1,5,100])assert.ok((1-(1-rim)**surfaces)*alpha<=.9,'overlapping surfaces cannot turn the composited model opaque');}
  const shader={fragmentShader:THREE.ShaderLib.physical.fragmentShader};copy.onBeforeCompile(shader);assert.ok(shader.fragmentShader.includes('atlasRimTint'));assert.ok(shader.fragmentShader.includes('totalEmissiveRadiance'));assert.ok(!shader.fragmentShader.includes('#include <opaque_fragment>'));assert.ok(source.onBeforeCompile!==copy.onBeforeCompile);
  assert.ok(characterOpacity(16)<characterOpacity(3.4));assert.equal(characterOpacity(32,false),1);
  glass.setAtlas(false);assert.equal(a.material,source);assert.deepEqual(b.material,[source,source]);glass.setAtlas(true);assert.equal(a.material,copy);
  for(const material of glass.materials)material.dispose();geometry.dispose();for(const texture of [map,emissiveMap,normalMap])texture.dispose();
});

test('dolly enters the head at every orientation without changing the lens; focus finishes at an unchanged target',()=>{
  const state=new AtlasCamera();state.autoHead=true;state.target={x:44,y:210,z:0};state.scale(3.4);assert.deepEqual(state.target,{x:0,y:600,z:0});
  const lens=[];
  for(const zoom of [1,3.4,6,16,32])for(const yaw of [0,Math.PI/2,Math.PI]){
    state.zoom=zoom;const view={w:800,h:800,camera:state,...atlasViewport(800,800,160,state,true),rotation:{s:Math.sin(yaw),c:Math.cos(yaw),sp:Math.sin(.3),cp:Math.cos(.3)}},camera=new THREE.PerspectiveCamera();syncModelCamera(camera,view);lens.push(camera.fov);
    if(zoom>=16){const position=camera.position.clone().multiplyScalar(SCENE_UNITS);assert.ok(headContains(position),`camera must actually be inside the head at zoom ${zoom}`);}
    assert.ok(Math.abs(camera.position.distanceTo(new THREE.Vector3(...HEAD_VOLUME.center).divideScalar(SCENE_UNITS))*SCENE_UNITS-view.distance)<1e-8);
  }
  assert.ok(Math.max(...lens)-Math.min(...lens)<1e-9);
  state.zoom=1;state.focus(state.target,10);for(let i=0;i<120;i++)state.tick();assert.equal(state.destination,null);assert.equal(state.zoom,10,'same focus coordinates must still animate the zoom to completion');
  state.scale(1e6);assert.equal(state.zoom,MAX_ZOOM);state.autoHead=true;state.scale(1e-6);assert.deepEqual(state.target,{x:44,y:210,z:0});
});

test('real canvas input selects an interior memory through a region halo and zooms with wheel/buttons',()=>{
  const listeners={},selected=[],camera=new AtlasCamera(),canvas={style:{},getBoundingClientRect:()=>({left:0,top:0}),addEventListener:(name,fn)=>listeners[name]=fn,setPointerCapture(){},hasPointerCapture(){return true;},releasePointerCapture(){},focus(){}};
  const scene=Object.assign(Object.create(V5Scene.prototype),{canvas,camera,h:700,selectCallback:hit=>selected.push(hit),hits:[{id:'memory',type:'memory',x:100,y:100,depth:0,radius:6},{id:'W1',type:'region',x:102,y:100,radius:10},{id:'M1',type:'region',x:100,y:120,bounds:[82,21]}]});scene.bind();
  const event={clientX:100,clientY:100,pointerId:1,button:0};listeners.pointerdown(event);listeners.pointerup(event);assert.equal(selected[0].id,'memory');
  listeners.pointerdown({...event,clientY:120});listeners.pointerup({...event,clientY:120});assert.equal(selected[1].id,'M1','explicit labels remain clickable');
  listeners.pointerdown({...event,clientY:140});listeners.pointerup({...event,clientY:140});assert.equal(selected.length,2,'outside label rectangle must not steal empty-space input');
  for(let i=0;i<24;i++)listeners.wheel({deltaY:-5,deltaMode:1,preventDefault(){}});assert.ok(2200/camera.zoom<HEAD_VOLUME.radii[2]);
  const zoom=camera.zoom;scene.zoom(1/1.2);assert.ok(camera.zoom<zoom);camera.focus({x:0,y:600,z:0},6);scene.zoom(1.2);assert.equal(camera.destination,null,'manual zoom is not undone by an active focus animation');
});

test('canvas entry and dragging use a stable arrow instead of host-corrupted grab cursors',()=>{
  const listeners={},camera=new AtlasCamera(),canvas={style:{},getBoundingClientRect:()=>({left:0,top:0}),addEventListener:(type,fn)=>listeners[type]=fn,setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){},focus(){}};
  const scene=Object.assign(Object.create(V5Scene.prototype),{canvas,camera,dragMode:'pan',hits:[{id:'memory',type:'memory',x:100,y:100,radius:6}]});scene.bind();
  const event={pointerId:1,button:0,clientX:40,clientY:40};listeners.pointermove(event);assert.equal(canvas.style.cursor,'default');
  listeners.pointermove({...event,clientX:100,clientY:100});assert.equal(canvas.style.cursor,'pointer');
  listeners.pointerleave();assert.equal(canvas.style.cursor,'default');assert.equal(scene.hovered,null);
  const zoom=camera.zoom;listeners.pointerdown(event);listeners.pointermove({...event,clientX:60,clientY:55});assert.equal(canvas.style.cursor,'default');assert.equal(camera.panX,20);assert.equal(camera.panY,15);
  listeners.pointerup({...event,clientX:60,clientY:55});assert.equal(canvas.style.cursor,'default');assert.equal(scene.pointer,null);
  scene.dragMode='rotate';const yaw=camera.yaw;listeners.pointerdown(event);listeners.pointermove({...event,clientX:70,clientY:60});assert.ok(camera.yaw>yaw);assert.equal(canvas.style.cursor,'default');listeners.pointercancel(event);
  assert.equal(camera.zoom,zoom);assert.equal(canvas.style.cursor,'default');
  const css=readFileSync(new URL('../apps/memory-sea/styles.css',import.meta.url),'utf8');assert.match(css,/#sea-canvas\{[^}]*cursor:default/);assert.doesNotMatch(css,/#sea-canvas\{[^}]*cursor:grab/);
});

test('head framing exposes every region; entering the head excludes clipped or offscreen memory clicks',()=>{
  for(const [w,h,dock] of [[714,660,160],[1180,960,185],[390,650,180]]){
    const camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.zoom=3.4;
    const view={w,h,camera,...atlasViewport(w,h,dock,camera,true),rotation:{c:1,s:0,cp:1,sp:0}};
    for(const r of REGIONS)assert.ok(projectAtlas(Object.fromEntries(['x','y','z'].map((axis,i)=>[axis,r.position[i]])),view).inViewport,r.id+' must be available from the head overview');
  }
  const camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.zoom=32;
  const points=[{id:'visible',x:0,y:600,z:0},{id:'behind',x:0,y:600,z:80},{id:'near',x:0,y:600,z:64},{id:'offscreen',x:10000,y:600,z:0}];
  const scene=Object.assign(Object.create(V5Scene.prototype),{w:714,h:660,camera,...atlasViewport(714,660,160,camera,true),rotation:{c:1,s:0,cp:1,sp:0},ctx:{setLineDash(){},beginPath(){},arc(){},fill(){}},nodes:new Map(points.map(p=>[p.id,{...p,target:{...p},kind:'raw',label:p.id,region_ids:['M4']} ])),graph:{regions:REGIONS,edges:[]},active:new Map(),hits:[],selected:null});
  scene.halo=()=>{};scene.drawMemories(0);assert.deepEqual(scene.hits.map(hit=>hit.id),['visible']);
});

test('model fitting respects authored orientation and preserves material scale/properties',()=>{
  const geometry=new THREE.BoxGeometry(.854,.642,1.0675);geometry.translate(0,0,-1.0675/2);const material=new THREE.MeshPhysicalMaterial({transmission:.85,ior:1.45,thickness:.6,attenuationDistance:3,roughness:.1,emissiveIntensity:1.6}),mesh=new THREE.Mesh(geometry,material);mesh.rotation.x=Math.PI/2;const scene=new THREE.Group();scene.add(mesh);const {root,scale}=fitModelToAtlas(scene),box=new THREE.Box3().setFromObject(root);
  assert.ok(Math.abs(box.min.y*SCENE_UNITS+589)<1e-6);assert.ok(Math.abs(box.max.y*SCENE_UNITS-1009)<1e-6);assert.ok(Math.abs(scale-1)<.01);assert.equal(mesh.rotation.x,Math.PI/2);assert.equal(mesh.material,material);assert.equal(material.transmission,.85);assert.equal(material.thickness,.6);geometry.dispose();material.dispose();
});

test('only named model/library assets are served; runtime data stays private',async t=>{
  const runtime=new V5Runtime();t.after(()=>runtime.close());const server=createMemorySeaServer({runtime});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;
  for(const path of [...(hasLocalCharacter?['/assets/blue-maid-starry.glb']:[]),'/src/v5-glb-character.js','/src/v5-brain.js','/src/v5-camera.js','/vendor/three/GLTFLoader.js','/vendor/three/SkeletonUtils.js']){const response=await fetch(base+path,{method:'HEAD'});assert.equal(response.status,200,path);assert.ok(response.headers.get('content-security-policy').includes("img-src 'self' data: blob:"));}
  if(!hasLocalCharacter)assert.equal((await fetch(base+'/assets/blue-maid-starry.glb',{method:'HEAD'})).status,404);
  if(hasLocalCharacter){
    const response=await fetch(base+'/assets/blue-maid-starry.glb?resource='+CHARACTER_RESOURCE_VERSION,{method:'HEAD'});
    assert.equal(response.headers.get('cache-control'),'private, max-age=86400');assert.ok(response.headers.get('etag'));
    const cached=await fetch(base+'/assets/blue-maid-starry.glb?resource='+CHARACTER_RESOURCE_VERSION,{headers:{'if-none-match':response.headers.get('etag')}});
    assert.equal(cached.status,304);assert.equal((await cached.arrayBuffer()).byteLength,0);
  }
  const data=await fetch(base+'/api/v5/overview');assert.equal(data.status,200);assert.equal(data.headers.get('cache-control'),'no-store');
  for(const path of ['/assets/other.glb','/runtime-data/v5/memory.sqlite','/vendor/three/provenance.json'])assert.equal((await fetch(base+path)).status,404);
});
