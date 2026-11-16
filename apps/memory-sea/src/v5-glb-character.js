import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { RoomEnvironment } from '../vendor/three/RoomEnvironment.js';
import { CAMERA_DISTANCE,NEAR,FAR } from './v5-camera.js';
import { createBrainMist } from './v5-brain.js';

// Keep the supplied asset near its authored metre scale: optical attenuation is in world units.
export const SCENE_UNITS=1500;
export const CHARACTER_RESOURCE_VERSION='1.0.0';
const ASSET=new URL('../assets/blue-maid-starry.glb?resource='+CHARACTER_RESOURCE_VERSION,import.meta.url).href;
const FINISH=Object.freeze({surface:.22,body:.48,rim:.48,stars:.24,highlight:.18,max:.9,power:2.8});

export function glassSurfaceAlpha(facing,{stars=0,highlight=0,headBlend=1}={}){
  const edge=Math.pow(1-THREE.MathUtils.clamp(Math.abs(facing),0,1),FINISH.power);
  const surface=THREE.MathUtils.lerp(FINISH.body,FINISH.surface,THREE.MathUtils.clamp(headBlend,0,1));
  return Math.min(FINISH.max,surface+FINISH.rim*edge+FINISH.stars*THREE.MathUtils.clamp(stars,0,1)+FINISH.highlight*THREE.MathUtils.clamp(highlight,0,1));
}

function contourGlassShader(shader){
  const marker='#include <opaque_fragment>';
  if(!shader.fragmentShader.includes(marker))throw new Error('琉璃轮廓材质与当前渲染库不兼容');
  // Use the smooth geometric normal for the silhouette; keep the authored normal map for PBR glints.
  // Alpha is independent of refraction so transmission cannot erase the rim or emissive star flecks.
  shader.fragmentShader=shader.fragmentShader.replace(marker,`
    float atlasFacing = abs(dot(normalize(nonPerturbedNormal), normalize(vViewPosition)));
    float atlasRim = pow(1.0 - clamp(atlasFacing, 0.0, 1.0), ${FINISH.power.toFixed(2)});
    float atlasHeadBlend = smoothstep(0.18, 0.30, vWorldPosition.y);
    float atlasSurface = mix(${FINISH.body.toFixed(2)}, ${FINISH.surface.toFixed(2)}, atlasHeadBlend);
    float atlasStars = smoothstep(0.08, 0.55, max(max(totalEmissiveRadiance.r, totalEmissiveRadiance.g), totalEmissiveRadiance.b));
    vec3 atlasSpecular = totalSpecular;
    #ifdef USE_CLEARCOAT
      atlasSpecular += clearcoatSpecularDirect + clearcoatSpecularIndirect;
    #endif
    float atlasHighlight = smoothstep(0.12, 0.8, max(max(atlasSpecular.r, atlasSpecular.g), atlasSpecular.b));
    vec3 atlasRimTint = mix(vec3(0.30, 0.71, 1.0), vec3(0.66, 0.56, 1.0), smoothstep(-0.7, 0.7, nonPerturbedNormal.x));
    outgoingLight += atlasRimTint * atlasRim * 0.70;
    outgoingLight += diffuseColor.rgb * mix(0.22, 0.10, atlasHeadBlend) * (1.0 - atlasRim * 0.5);
    float atlasAlpha = min(${FINISH.max.toFixed(2)}, atlasSurface + ${FINISH.rim.toFixed(2)} * atlasRim + ${FINISH.stars.toFixed(2)} * atlasStars + ${FINISH.highlight.toFixed(2)} * atlasHighlight);
    gl_FragColor = vec4(outgoingLight, diffuseColor.a * atlasAlpha);
  `);
}

/** Match the existing atlas's perspective, rotation, focus and pan exactly. */
export function syncModelCamera(camera,view){
  const {w,h,unit,rotation:{s,c,sp,cp},plotTop,plotHeight,distance=CAMERA_DISTANCE,near=NEAR,far=FAR}=view,target=view.camera.target;
  camera.aspect=w/h;camera.near=near/SCENE_UNITS;camera.far=far/SCENE_UNITS;
  camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(h/(2*unit*distance)));
  const aim=new THREE.Vector3(target.x,target.y,target.z).divideScalar(SCENE_UNITS);
  camera.position.copy(aim).addScaledVector(new THREE.Vector3(-s*cp,sp,c*cp),distance/SCENE_UNITS);
  camera.up.set(s*sp,cp,-c*sp);camera.lookAt(aim);
  const shiftY=plotTop+plotHeight*.51+view.camera.panY-h/2;
  camera.setViewOffset(w,h,-view.camera.panX,-shiftY,w,h);camera.updateMatrixWorld();
}

export function fitModelToAtlas(model){
  model.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  if(!Number.isFinite(size.y)||size.y<=0)throw new Error('GLB 没有可用的模型范围');
  const factor=1598/size.y/SCENE_UNITS,root=new THREE.Group();
  root.scale.setScalar(factor);root.position.set(-center.x*factor,-589/SCENE_UNITS-box.min.y*factor,-center.z*factor);root.add(model);root.updateMatrixWorld(true);
  return {root,sourceBounds:box,scale:factor};
}

/** Runtime glass copies share the authored maps; the GLB and original materials stay intact. */
export function createAtlasGlass(model){
  const copies=new Map(),meshes=[];
  model.traverse(mesh=>{if(!mesh.isMesh)return;const original=mesh.material;
    const convert=material=>{if(!copies.has(material)){
      const glass=material.clone();glass.transparent=true;glass.opacity=1;glass.depthWrite=false;
      glass.side=THREE.FrontSide;glass.forceSinglePass=true;glass.envMapIntensity=.9;
      if(glass.isMeshPhysicalMaterial){glass.transmission=.78;glass.thickness=.08;glass.attenuationDistance=6;glass.clearcoat=.8;glass.clearcoatRoughness=.12;glass.roughness=.12;}
      glass.emissiveIntensity=Math.min(material.emissiveIntensity??1,1.3);
      glass.onBeforeCompile=contourGlassShader;glass.customProgramCacheKey=()=> 'thinkstar-contour-glass-v1';copies.set(material,glass);
    }return copies.get(material);};
    const glass=Array.isArray(original)?original.map(convert):convert(original);meshes.push({mesh,original,glass});mesh.material=glass;
  });
  return {materials:new Set([...copies.keys(),...copies.values()]),setAtlas(atlas){for(const item of meshes)item.mesh.material=atlas?item.glass:item.original;}};
}

export function characterOpacity(zoom,atlas=true){
  if(!atlas)return 1;
  // A cap on the complete composited layer also covers overlapping hair, dress and tail surfaces.
  return .90-(.90-.50)*Math.max(0,Math.min(1,(zoom-2)/10));
}

export class GLBCharacter {
  constructor(overlay,{status=()=>{}}={}){
    this.status=status;this.ready=false;this.disposed=false;
    try{
      this.renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'high-performance'});
      this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.25));
      this.renderer.outputColorSpace=THREE.SRGBColorSpace;
      this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.95;
      this.renderer.transmissionResolutionScale=.5;
      const canvas=this.renderer.domElement;canvas.className='character-canvas';canvas.hidden=true;canvas.style.pointerEvents='none';canvas.setAttribute('aria-hidden','true');overlay.before(canvas);
      this.renderer.setClearColor(0x091321,0);this.scene=new THREE.Scene();this.originalBackground=new THREE.Color('#091321');this.scene.background=null;
      this.camera=new THREE.PerspectiveCamera(40,1,.005,20);
      this.brain=createBrainMist(THREE,SCENE_UNITS);this.scene.add(this.brain.group);
      const pmrem=new THREE.PMREMGenerator(this.renderer),room=new RoomEnvironment();
      this.environment=pmrem.fromScene(room,.04);this.scene.environment=this.environment.texture;this.scene.environmentIntensity=.65;
      room.dispose();pmrem.dispose();
      this.scene.add(new THREE.HemisphereLight(0xcceaff,0x152b50,1.25));
      const key=new THREE.DirectionalLight(0xd8ebff,2.2);key.position.set(-2,3,4);this.scene.add(key);
      const rim=new THREE.DirectionalLight(0x739ff5,1.7);rim.position.set(2,1,-3);this.scene.add(rim);
      canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.contextLost=true;this.ready=false;canvas.hidden=true;status({state:'failed',message:'图形上下文中断，请刷新重新载入 GLB'});});
      this.loading=this.load();
      window.addEventListener('pagehide',e=>{if(!e.persisted)this.dispose();},{once:true});
    }catch(error){this.fail(error);}
  }
  async load(){
    try{
      this.status({state:'loading',message:'正在载入提供的 GLB · 39.3 MB'});
      const response=await fetch(ASSET,{cache:'force-cache'});if(!response.ok)throw new Error('模型文件读取失败');
      const data=await response.arrayBuffer();if(this.disposed)return;
      const manager=new THREE.LoadingManager();
      manager.setURLModifier(url=>{if(!url.startsWith('blob:')&&!url.startsWith('data:'))throw new Error('模型含有未授权的外部资源');return url;});
      const gltf=await new GLTFLoader(manager).parseAsync(data,'');if(this.disposed)return;
      const fitted=fitModelToAtlas(gltf.scene);this.model=fitted.root;this.scene.add(this.model);
      let vertices=0,triangles=0;const materials=new Set();
      this.model.traverse(object=>{if(object.isMesh){vertices+=object.geometry.attributes.position.count;triangles+=(object.geometry.index?.count??object.geometry.attributes.position.count)/3;for(const m of Array.isArray(object.material)?object.material:[object.material]){materials.add(m);if(m.map)m.map.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());}}});
      this.glass=createAtlasGlass(this.model);this.atlas=true;
      await this.renderer.compileAsync(this.scene,this.camera);if(this.disposed)return;
      this.ready=true;this.invalidate();this.renderer.domElement.dataset.asset=ASSET;this.renderer.domElement.dataset.materials=String(materials.size);
      this.renderer.domElement.dataset.vertices=String(vertices);this.renderer.domElement.dataset.triangles=String(triangles);
      this.status({state:'ready',message:'琉璃轮廓与星点高光 · 滚轮可进入脑内',vertices,triangles});
    }catch(error){this.fail(error);}
  }
  fail(error){if(this.disposed)return;this.ready=false;this.invalidate();if(this.renderer&&!this.brain)this.renderer.domElement.hidden=true;this.status({state:'failed',message:'GLB 未能显示：'+(error?.message??'图形初始化失败')});}
  invalidate(){this.lastView=null;}
  render(view,visible=true){
    if(!this.renderer||this.disposed||this.contextLost||(!this.ready&&!this.brain))return;
    const atlas=view.showAtlas!==false;
    const characterVisible=visible&&this.ready,brainVisible=atlas&&!!this.brain;
    this.renderer.domElement.hidden=!(characterVisible||brainVisible);if(this.renderer.domElement.hidden)return;
    if(this.model)this.model.visible=characterVisible;
    // The supplied character is static. Reuse its WebGL buffer while the animated atlas
    // above it continues to render; all projection/material inputs invalidate this snapshot.
    const {camera,rotation}=view;
    const snapshot=[view.w,view.h,view.unit,view.plotTop,view.plotHeight,view.distance,view.near,view.far,
      rotation.s,rotation.c,rotation.sp,rotation.cp,camera.target.x,camera.target.y,camera.target.z,
      camera.panX,camera.panY,camera.zoom,atlas,characterVisible,this.ready];
    if(this.lastView&&snapshot.every((value,index)=>Object.is(value,this.lastView[index])))return;
    if(atlas!==this.atlas){this.atlas=atlas;this.glass?.setAtlas(atlas);}
    this.brain?.update(view,{enabled:atlas,characterVisible,pixelRatio:this.renderer.getPixelRatio()});
    // Let the local Milky Way backdrop show through the atlas, including around the glass silhouette.
    this.scene.background=atlas?null:this.originalBackground;
    this.renderer.domElement.style.opacity=String(characterVisible?characterOpacity(view.camera.zoom,atlas):.9);
    if(view.w!==this.width||view.h!==this.height){this.width=view.w;this.height=view.h;this.renderer.setSize(view.w,view.h,false);}
    syncModelCamera(this.camera,view);this.renderer.render(this.scene,this.camera);this.lastView=snapshot;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.ready=false;const textures=new Set(),materials=new Set();
    this.model?.traverse(object=>{object.geometry?.dispose();if(object.material)for(const m of Array.isArray(object.material)?object.material:[object.material])materials.add(m);});
    for(const m of this.glass?.materials??[])materials.add(m);
    for(const m of materials){for(const value of Object.values(m))if(value?.isTexture)textures.add(value);m.dispose();}
    for(const t of textures){t.source?.data?.close?.();t.dispose();}
    this.brain?.dispose();this.environment?.dispose();this.renderer?.dispose();this.renderer?.domElement.remove();
  }
}
