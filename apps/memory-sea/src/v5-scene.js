import { atlasForeground } from './v5-playback.js';
import { AtlasCamera,atlasFrameEase,atlasViewport,projectAtlas,pickAtlasHit } from './v5-camera.js';
import { channelGeometry,curve,smoothPath,ATLAS_TERMINALS } from './v5-character.js';
import { HEAD_VOLUME,memoryPoint,regionStructure,primaryRegion,memoryFlowPath } from './v5-spatial.js';
import { regionNebula,membraneMesh,galaxyStars } from './v5-nebula.js';
import { BRAIN_VOLUME } from './v5-brain.js';
import { FORGET_EXIT } from '../../../shared/v5-memory-layout.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const point=a=>({x:a[0],y:a[1],z:a[2]});
const rgb=color=>[1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
export const AUTO_ROTATION_SPEED=.05;

export class V5Scene {
  constructor(canvas,{select,hover,foreground=atlasForeground}={}) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.camera=new AtlasCamera();this.showLabels=true;this.dragMode='pan';this.showWire=false;this.brainOnly=true;this.reset('head');
    this.selectCallback=select;this.hoverCallback=hover;
    this.nodes=new Map();this.hits=[];this.pulses=[];this.meteors=[];this.glow=new Map();this.active=new Map();
    this.glb=null;this.isForeground=foreground;this.view2d=false;this.showChannels=true;this.hovered=null;this.selected=null;
    this.updateCharacterStatus({state:'deferred',message:'先呈现星图，女孩随后预载'});
    this.film=membraneMesh();this.stars=galaxyStars();this.reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.autoRotate=!this.reduceMotion;this.spinResumeAt=0;
    try{const saved=localStorage.getItem('thinkstar.atlas.autoRotate');if(saved==='on'||saved==='off')this.autoRotate=saved==='on';}catch{}
    const dock=document.querySelector('.input-dock');this.dockHeight=dock?.getBoundingClientRect().height??160;
    this.observer=new ResizeObserver(()=>{const r=canvas.getBoundingClientRect();this.w=r.width;this.h=r.height;this.dpr=Math.min(devicePixelRatio||1,2);const width=Math.floor(this.w*this.dpr),height=Math.floor(this.h*this.dpr);if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;this.dockHeight=dock?.getBoundingClientRect().height??160;if(this.view==='head'&&this.camera.autoHead&&Math.abs(this.camera.zoom-(this.fittedHeadZoom??3.4))<.05&&!this.camera.panX&&!this.camera.panY){this.fittedHeadZoom=this.fitHeadZoom();this.camera.zoom=this.fittedHeadZoom;this.camera.targetZoom=this.fittedHeadZoom;}});
    this.observer.observe(canvas);if(dock)this.observer.observe(dock);this.bind();
    this.running=false;this.frameHandle=null;
    this.frame=t=>this.renderFrame(t);
    window.addEventListener('pagehide',e=>{if(!e.persisted)this.dispose();},{once:true});
  }
  renderFrame(t){
    this.frameHandle=null;if(!this.running)return;
    if(!this.isForeground()){this.setRunning(false);return;}
    this.frameHandle=requestAnimationFrame(this.frame);
    this.deltaMs=this.last==null?1000/30:clamp(t-this.last,0,100);this.last=t;this.camera.tick(this.deltaMs);this.rotateAutomatically(this.deltaMs,t);const start=performance.now();this.draw(t);
    if(this.graph){this.canvas.dataset.firstFrameAt??=performance.now().toFixed(1);this.queueCharacter();}
    this.samples??=[];this.samples.push(performance.now()-start);if(this.samples.length>60)this.samples.shift();
    if(this.samples.length===60)this.canvas.dataset.frameMs=(this.samples.reduce((a,b)=>a+b,0)/60).toFixed(1);
  }
  queueCharacter(){
    if(this.glb||this.modelLoading||this.modelHandle!=null||this.disposed)return;
    // A separate animation frame lets the atlas paint before importing and initializing WebGL.
    this.modelHandle=requestAnimationFrame(()=>{this.modelHandle=null;if(this.running&&this.isForeground())this.loadCharacter();});
  }
  updateCharacterStatus(value){
    this.modelStatus=value;this.canvas.dataset.modelState=value.state;
    const label=typeof document==='undefined'?null:document.getElementById('character-status');
    if(label)label.textContent=!this.showWire&&value.state==='ready'?'女孩已预载 · 点击模型按钮显示':!this.showWire&&value.state==='loading'?'正在预载女孩 · 当前仅显示星图':value.message;
  }
  async loadCharacter(){
    if(this.glb||this.modelLoading||this.disposed)return;this.modelLoading=true;
    const status=value=>this.updateCharacterStatus(value);
    try{
      status({state:'loading',message:'星图已呈现，正在载入女孩'});
      const {GLBCharacter}=await import('./v5-glb-character.js');if(this.disposed)return;
      if(!this.running||!this.isForeground()){this.modelLoading=false;status({state:'deferred',message:'显示星图时继续预载女孩'});return;}
      this.glb=new GLBCharacter(this.canvas,{status});
    }catch(error){status({state:'failed',message:'女孩未能载入：'+error.message});}
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.setRunning(false);this.observer?.disconnect();this.glb?.dispose();
  }
  setRunning(active){
    if(active&&this.disposed)return;
    if(active&&!this.running)this.glb?.invalidate();
    this.running=active;
    this.canvas.dataset.animationState=active?'running':'paused';
    if(!active){if(this.frameHandle!==null)cancelAnimationFrame(this.frameHandle);if(this.modelHandle!=null)cancelAnimationFrame(this.modelHandle);this.modelHandle=null;this.frameHandle=null;this.last=null;return;}
    if(this.frameHandle===null)this.frameHandle=requestAnimationFrame(this.frame);
  }
  setGraph(graph){
    const initial=!this.graph;
    this.graph=graph;this.channels=channelGeometry(graph.regions,graph.channels,graph.layers);
    // These world-space curves do not change when the camera moves.
    for(const ch of this.channels)ch.strokePoints=smoothPath(Array.from({length:24},(_,i)=>curve(ch,i/23)));
    this.regionById=new Map(graph.regions.map(region=>[region.id,region]));this.layerById=new Map(graph.layers.map(layer=>[layer.id,layer]));
    this.structure=graph.regions.map(region=>({region,points:regionStructure(region,region.domain==='work'?28:18)}));
    this.nebulae=graph.regions.map(region=>regionNebula(region));
    const previousStorage=new Map((this.storage??[]).map(item=>[item.layer.id,item]));
    this.storage=graph.layers.map(layer=>{const shape={...layer,id:'L:'+layer.id,domain:'store-layer'},amount=clamp(Math.log1p(Math.max(0,Number(layer.count)||0))/Math.log1p(50000),0,1);return {layer,points:regionStructure(shape,34),mist:regionNebula(shape,68),amount:previousStorage.get(layer.id)?.amount??amount,targetAmount:amount};});
    const next=new Map();for(const m of graph.nodes){const target=memoryPoint(m,graph.regions,{recentHours:graph.recent_hours??72}),old=this.nodes.get(m.id);next.set(m.id,{...m,x:old?.x??target.x,y:old?.y??target.y,z:old?.z??target.z,target});}this.nodes=next;
    if(initial&&this.camera.autoHead&&this.view==='head'){this.fittedHeadZoom=this.fitHeadZoom();this.camera.zoom=this.fittedHeadZoom;this.camera.targetZoom=this.fittedHeadZoom;}
  }
  clearHover(){this.hovered=null;if(this.canvas?.style)this.canvas.style.cursor='default';this.hoverCallback?.(null);}
  viewChanged(){this.hits=[];this.clearHover();this.viewChange?.();if(this.graph&&!this.running&&this.isForeground?.())this.draw(performance.now());}
  pauseAutoRotation(){this.spinResumeAt=performance.now()+1800;}
  setAutoRotate(enabled){this.autoRotate=!!enabled;this.spinResumeAt=0;try{localStorage.setItem('thinkstar.atlas.autoRotate',this.autoRotate?'on':'off');}catch{}this.viewChanged();}
  rotateAutomatically(deltaMs,time){
    if(!this.autoRotate||this.view2d||this.pointer||this.hovered||this.selected||this.camera.destination||time<(this.spinResumeAt??0))return;
    // Match Aurabot's slow clockwise turn; background time never accumulates into a jump.
    this.camera.yaw=(this.camera.yaw+AUTO_ROTATION_SPEED*clamp(deltaMs,0,100)/1000)%(Math.PI*2);
  }
  reset(view='full'){this.camera.reset();this.camera.yaw=-.18;this.camera.pitch=.035;this.camera.target=view==='head'?point(HEAD_VOLUME.center):{x:44,y:210,z:0};this.fittedHeadZoom=this.fitHeadZoom();this.camera.zoom=view==='head'?this.fittedHeadZoom:1;this.camera.autoHead=true;this.view=view;this.view2d=false;this.setAtlas(true);}
  fitHeadZoom(){
    if(!this.w||!this.h)return 3.4;
    const shapes=this.graph?[...this.graph.regions,...(this.graph.layers??[]),...ATLAS_TERMINALS]:[{position:HEAD_VOLUME.center,radii:HEAD_VOLUME.radii}];
    const points=shapes.flatMap(shape=>[-1,1].flatMap(x=>[-1,1].flatMap(y=>[-1,1].map(z=>({x:shape.position[0]+x*shape.radii[0],y:shape.position[1]+y*shape.radii[1],z:shape.position[2]+z*shape.radii[2]})))));
    for(let row=0;row<=6;row++)for(let col=0;col<16;col++){const a=col/16*Math.PI*2,b=row/6*Math.PI;points.push({x:BRAIN_VOLUME.center[0]+Math.sin(b)*Math.cos(a)*BRAIN_VOLUME.radii[0]*.975,y:BRAIN_VOLUME.center[1]+Math.cos(b)*BRAIN_VOLUME.radii[1]*.975,z:BRAIN_VOLUME.center[2]+Math.sin(b)*Math.sin(a)*BRAIN_VOLUME.radii[2]*.975});}
    const yaw=this.view2d?0:this.camera.yaw,pitch=this.view2d?0:this.camera.pitch,rotation={c:Math.cos(yaw),s:Math.sin(yaw),cp:Math.cos(pitch),sp:Math.sin(pitch)},dockHeight=this.dockHeight??160;
    const fits=zoom=>{const camera={zoom,target:point(HEAD_VOLUME.center),panX:0,panY:0},view={w:this.w,h:this.h,camera,rotation,...atlasViewport(this.w,this.h,dockHeight,camera,true)};return points.every(vertex=>{const p=projectAtlas(vertex,view);return p.visible&&p.x>38&&p.x<this.w-38&&p.y>view.plotTop+20&&p.y<view.plotTop+view.plotHeight-24;});};
    let low=1.1,high=3.4;for(let i=0;i<11;i++){const middle=(low+high)/2;if(fits(middle))low=middle;else high=middle;}return low;
  }
  setAtlas(visible){this.showAtlas=visible;if(!visible){this.showWire=true;this.brainOnly=false;}this.viewChanged();}
  setModelVisible(visible){this.showWire=visible;this.brainOnly=!visible;if(!visible&&this.glb?.renderer&&!this.glb.brain)this.glb.renderer.domElement.hidden=true;this.glb?.invalidate();if(this.modelStatus)this.updateCharacterStatus(this.modelStatus);this.viewChanged();}
  setBrainOnly(enabled){if(enabled)this.reset('head');this.setModelVisible(!enabled);}
  setLabels(visible){this.showLabels=visible;this.viewChanged();}
  zoom(factor){this.pauseAutoRotation();this.clearHover();this.camera.scale(factor);this.view=this.camera.zoom>1.8?'head':'full';}
  setOrientation(direction){this.pauseAutoRotation();this.view2d=false;this.camera.destination=null;this.camera.yaw={front:0,side:Math.PI/2,back:Math.PI}[direction]??-.18;this.camera.pitch=.035;this.viewChanged();}
  focusRegion(id){
    this.setAtlas(true);
    if(id.startsWith('L:')){const layer=this.graph?.layers.find(layer=>layer.id===id.slice(2));if(layer){this.camera.focus(point(layer.position),5.2);this.view='head';}return;}
    if(id==='STORE'){const store=this.graph?.regions.find(region=>region.id==='U');if(store){this.camera.focus(point(store.position),5.4);this.view='head';}return;}
    if(id==='HEAD'){this.fittedHeadZoom=this.fitHeadZoom();this.camera.focus(point(HEAD_VOLUME.center),this.fittedHeadZoom);this.camera.autoHead=true;this.view='head';return;}
    const terminal=ATLAS_TERMINALS.find(item=>item.id===id);if(terminal){this.camera.focus(point(terminal.position),5.5);this.view='head';return;}
    const region=this.graph?.regions.find(r=>r.id===id);if(region){this.camera.focus(point(region.position),6);this.view='head';}
  }
  focusMemory(id){const p=this.nodes.get(id);if(p){this.setAtlas(true);this.camera.focus(p,10*(this.graph.display?.display_focus_gain??1.3)/1.3);this.view='head';}}
  event(event,{replay=false,index=0}={}){
    const channel=this.channels?.find(c=>[c.from,c.to].includes(event.source_region)&&[c.from,c.to].includes(event.target_region));
    if(channel)this.pulses.push({event,channel,reversed:channel.from!==event.source_region,start:performance.now()+index*95,duration:950,replay});
    let flowDelay=0;
    if(event.from_layer&&event.to_layer&&event.from_layer!==event.to_layer){const route=memoryFlowPath(event.from_layer,event.to_layer);for(let i=1;i<route.length;i++){const ch=this.channels?.find(ch=>[ch.from,ch.to].includes(route[i-1])&&[ch.from,ch.to].includes(route[i]));if(ch){this.pulses.push({event,channel:ch,reversed:ch.from!==route[i-1],start:performance.now()+index*95+flowDelay,duration:650,replay});flowDelay+=420;}}}
    for(const id of event.output_refs??[])this.active.set(id,performance.now()+2600);
    if(event.meteor)this.meteors.push({...point(FORGET_EXIT.position),memory_id:event.memory_id,start:performance.now()+index*95+flowDelay});
  }
  bind(){
    const c=this.canvas,pos=e=>{const r=c.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    c.addEventListener('contextmenu',e=>e.preventDefault());
    c.addEventListener('pointerdown',e=>{
      if(this.pointer||![0,1,2].includes(e.button))return;
      const p=pos(e);this.pauseAutoRotation();this.clearHover();
      const rotate=e.button===2||e.altKey||(this.dragMode==='rotate'&&e.button===0&&!e.shiftKey);
      this.pointer={id:e.pointerId,...p,sx:p.x,sy:p.y,moved:false,rotate};
      c.setPointerCapture(e.pointerId);c.focus({preventScroll:true});
    });
    c.addEventListener('pointermove',e=>{
      const p=pos(e);
      if(this.pointer?.id===e.pointerId){
        const q=this.pointer;q.moved||=Math.hypot(p.x-q.sx,p.y-q.sy)>4;
        if(q.moved){this.clearHover();if(q.rotate&&!e.shiftKey&&!this.view2d)this.camera.rotate(p.x-q.x,p.y-q.y);else this.camera.pan(p.x-q.x,p.y-q.y);}
        q.x=p.x;q.y=p.y;return;
      }
      const hit=pickAtlasHit(this.hits,p);this.hovered=hit?.id;c.style.cursor=hit?'pointer':'default';this.hoverCallback?.(hit,p);
    });
    const release=e=>{if(this.pointer?.id!==e.pointerId)return;this.pointer=null;this.pauseAutoRotation();if(c.hasPointerCapture(e.pointerId))c.releasePointerCapture(e.pointerId);this.clearHover();};
    c.addEventListener('pointerup',e=>{
      if(this.pointer?.id!==e.pointerId)return;
      if(!this.pointer.moved&&e.button===0){const hit=pickAtlasHit(this.hits,pos(e));if(hit){this.selected=hit.id;this.selectCallback?.(hit);}}
      release(e);
    });
    c.addEventListener('pointercancel',release);c.addEventListener('lostpointercapture',release);
    c.addEventListener('pointerleave',()=>this.clearHover());
    c.addEventListener('wheel',e=>{e.preventDefault();const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?this.h:1);this.zoom(Math.exp(-clamp(delta,-180,180)*.0015));},{passive:false});
    c.addEventListener('dblclick',e=>{const hit=pickAtlasHit(this.hits,pos(e));if(hit?.type==='memory')this.focusMemory(hit.id);else if(hit?.type==='region')this.focusRegion(hit.id);else if(hit?.type==='layer')this.focusRegion('L:'+hit.id);});
    c.addEventListener('keydown',e=>{
      if(e.key==='Escape')this.reset();if(['+','='].includes(e.key))this.zoom(1.15);if(e.key==='-')this.zoom(1/1.15);
      const d={ArrowLeft:[-30,0],ArrowRight:[30,0],ArrowUp:[0,-30],ArrowDown:[0,30]}[e.key];
      if(d){e.preventDefault();this.pauseAutoRotation();this.clearHover();if(e.altKey&&!this.view2d)this.camera.rotate(...d);else this.camera.pan(...d);}
    });
  }
  prepareProjection(){
    Object.assign(this,atlasViewport(this.w,this.h,this.dockHeight??160,this.camera,true));
    const yaw=this.view2d?0:this.camera.yaw,pitch=this.view2d?0:this.camera.pitch;
    this.rotation={c:Math.cos(yaw),s:Math.sin(yaw),cp:Math.cos(pitch),sp:Math.sin(pitch)};
  }
  project(p,out){
    return projectAtlas(p,this,out);
  }
  path(points,color,alpha,width=.8){
    const ctx=this.ctx;ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();let first=true;
    for(const q of smoothPath(points)){const p=this.project(q);if(!p.visible){first=true;continue;}if(first){ctx.moveTo(p.x,p.y);first=false;}else ctx.lineTo(p.x,p.y);}ctx.stroke();
  }
  halo(x,y,r,color,alpha=.4){
    const ctx=this.ctx;let sprite=this.glow.get(color);
    if(!sprite){sprite=document.createElement('canvas');sprite.width=sprite.height=80;const s=sprite.getContext('2d'),g=s.createRadialGradient(40,40,0,40,40,40);g.addColorStop(0,color+'a0');g.addColorStop(.22,color+'28');g.addColorStop(1,color+'00');s.fillStyle=g;s.fillRect(0,0,80,80);this.glow.set(color,sprite);}
    ctx.globalAlpha=alpha;ctx.drawImage(sprite,x-r,y-r,r*2,r*2);
  }
  drawGalaxy(time){
    const ctx=this.ctx;ctx.save();ctx.globalCompositeOperation='screen';
    for(const star of this.stars){const x=star.x*this.w,y=star.y*this.plotHeight,alpha=star.alpha*(this.reduceMotion?1:.90+.10*Math.sin(time*.0007+star.phase));
      if(star.bright)this.halo(x,y,6,star.color,.27);ctx.globalAlpha=alpha;ctx.fillStyle=star.color;ctx.beginPath();ctx.arc(x,y,star.size,0,Math.PI*2);ctx.fill();
    }ctx.restore();
  }
  fog(x,y,r,color,alpha){
    const ctx=this.ctx,key='mist:'+color;let sprite=this.glow.get(key);
    if(!sprite){sprite=document.createElement('canvas');sprite.width=sprite.height=96;const s=sprite.getContext('2d'),g=s.createRadialGradient(48,48,0,48,48,48);g.addColorStop(0,color+'88');g.addColorStop(.34,color+'68');g.addColorStop(.72,color+'24');g.addColorStop(1,color+'00');s.fillStyle=g;s.fillRect(0,0,96,96);this.glow.set(key,sprite);}
    ctx.globalAlpha=alpha;ctx.drawImage(sprite,x-r,y-r,r*2,r*2);
  }
  drawMistEnvelope(mist,intensity){
    const envelope=mist.envelope;if(!envelope)return;
    const ctx=this.ctx,work=mist.region.domain==='work',{s,c,cp,sp}=this.rotation;
    const vertices=mist.projectedEnvelope??=envelope.vertices.map(()=>({}));
    for(let i=0;i<vertices.length;i++)this.project(envelope.vertices[i],vertices[i]);
    ctx.fillStyle=mist.region.color;
    for(let index=0;index<envelope.faces.length;index++){const face=envelope.faces[index];if(face.some(i=>!vertices[i].visible))continue;
      const n=envelope.faceNormals[index],facing=Math.abs((n.y*sp+(-n.x*s+n.z*c)*cp)/n.length);
      ctx.globalAlpha=((work?.045:.031)+Math.pow(1-facing,2)*(work?.055:.030))*intensity;
      ctx.beginPath();ctx.moveTo(vertices[face[0]].x,vertices[face[0]].y);for(let i=1;i<face.length;i++)ctx.lineTo(vertices[face[i]].x,vertices[face[i]].y);ctx.closePath();ctx.fill();
    }
    for(const fold of envelope.folds)this.path(fold,mist.region.color,.14*intensity,.85);
  }
  drawMist(mist,time,{size=1,intensity=1}={}){
    const ctx=this.ctx,selected=this.selected===mist.region.id||this.selected===mist.region.id.replace('L:',''),center=mist.region.position;
    const work=mist.region.domain==='work',directory=mist.region.domain==='memory',defined=work||directory;
    if(this.domainFocus)intensity*=mist.region.domain===this.domainFocus?1.22:.58;
    ctx.save();ctx.globalCompositeOperation='screen';
    this.drawMistEnvelope(mist,intensity*(selected?1.3:1));
    for(const particle of mist.particles){
      const p=this.project({x:center[0]+(particle.x-center[0])*size,y:center[1]+(particle.y-center[1])*size,z:center[2]+(particle.z-center[2])*size});if(!p.inViewport)continue;
      const breath=this.reduceMotion?1:1+.035*Math.sin(time*.00045+particle.phase),radius=clamp(particle.size*p.scale*(defined?1.95:1.3),1.5,defined?25:15);
      if(defined)this.fog(p.x,p.y,radius,mist.region.color,(selected?.13:work?.105:.085)*breath*intensity);
      else this.halo(p.x,p.y,radius,mist.region.color,(selected?.15:.105)*breath*intensity);
    }
    ctx.restore();
  }
  drawRegionMist(time){
    // Bound the WHOLE fog layer's opacity: dense particles cannot accumulate into white
    // patches that erase star contrast. Stars, ports and activity are painted afterwards.
    this.fogLayer??=document.createElement('canvas');const layer=this.fogLayer;
    if(layer.width!==this.canvas.width||layer.height!==this.canvas.height){layer.width=this.canvas.width;layer.height=this.canvas.height;}
    const main=this.ctx,ctx=layer.getContext('2d');ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.clearRect(0,0,this.w,this.h);
    this.ctx=ctx;try{for(const mist of this.nebulae)this.drawMist(mist,time);}finally{this.ctx=main;}
    main.save();main.globalCompositeOperation='screen';main.globalAlpha=.60;main.drawImage(layer,0,0,this.w,this.h);main.restore();
  }
  drawMembrane(item,time){
    const {layer}=item,ctx=this.ctx,selected=this.selected===layer.id||this.selected==='L:'+layer.id;
    item.amount+=(item.targetAmount-item.amount)*atlasFrameEase(.045,this.deltaMs);
    const breath=this.reduceMotion?0:.012*Math.sin(time*.00065+item.mist.phase),size=(1.02+.08*item.amount)*(1+breath),r=layer.radii,b=layer.position;
    const vertices=item.projectedFilm??=this.film.vertices.map(()=>({})),world=item.filmPoint??={};
    for(let i=0;i<vertices.length;i++){const v=this.film.vertices[i];world.x=b[0]+v[0]*r[0]*size;world.y=b[1]+v[1]*r[1]*size;world.z=b[2]+v[2]*r[2]*size;this.project(world,vertices[i]);}
    const faces=item.filmFaces??=this.film.faces.map((face,index)=>{const nx=face.normal[0]/r[0],ny=face.normal[1]/r[1],nz=face.normal[2]/r[2];return {face,index,nx,ny,nz,length:Math.hypot(nx,ny,nz)||1,depth:0};});
    for(const record of faces)record.depth=record.face.indices.reduce((sum,i)=>sum+vertices[i].depth,0)/4;
    faces.sort((a,b)=>a.depth-b.depth||a.index-b.index);
    item.filmTint??=`rgb(${rgb(layer.color).map(value=>Math.round(value*.52+255*.48)).join(',')})`;
    ctx.save();ctx.globalCompositeOperation='screen';ctx.fillStyle=item.filmTint;
    const {s,c,sp,cp}=this.rotation;
    for(const {face,nx,ny,nz,length} of faces){if(face.indices.some(i=>!vertices[i].visible))continue;
      const facing=(ny*sp+(-nx*s+nz*c)*cp)/length,edge=Math.pow(1-Math.min(1,Math.abs(facing)),2.2);
      ctx.globalAlpha=(.006+.035*edge)*(.65+.35*item.amount)*(selected?1.35:1);
      ctx.beginPath();ctx.moveTo(vertices[face.indices[0]].x,vertices[face.indices[0]].y);for(let i=1;i<face.indices.length;i++)ctx.lineTo(vertices[face.indices[i]].x,vertices[face.indices[i]].y);ctx.closePath();ctx.fill();
    }
    ctx.restore();
  }
  drawStorage(time){
    const ctx=this.ctx;
    for(const item of this.storage){const {layer,points,mist}=item,p=this.project(point(layer.position));if(!p.inViewport)continue;
      this.drawMist(mist,time,{size:.96+.04*item.amount,intensity:.85+.15*item.amount});
      this.drawMembrane(item,time);
      for(const v of points){const q=this.project(v);if(!q.inViewport)continue;ctx.globalAlpha=.4;ctx.fillStyle=layer.color;ctx.beginPath();ctx.arc(q.x,q.y,.9,0,Math.PI*2);ctx.fill();}
      this.hits.push({id:layer.id,type:'layer',label:layer.name+'：'+layer.description+' 薄膜大小随记忆量变化。',x:p.x,y:p.y,depth:p.depth,radius:9});
    }
    const exit=this.project(point(FORGET_EXIT.position));if(this.showLabels&&exit.inViewport){ctx.globalAlpha=.65;ctx.fillStyle=FORGET_EXIT.color;ctx.font='9px "Microsoft YaHei",sans-serif';ctx.fillText('遗忘终点 ↓',exit.x+5,exit.y+13);}
  }
  drawBrain(){
    const ctx=this.ctx;
    for(const {region,points} of this.structure){
      const selected=this.selected===region.id;
      for(const v of points){const p=this.project(v);if(!p.inViewport)continue;ctx.globalAlpha=selected?1:region.domain==='work'?.92:.78;ctx.fillStyle='#e8f8ff';ctx.beginPath();ctx.arc(p.x,p.y,selected?1.35:1.05,0,Math.PI*2);ctx.fill();}

    }
  }
  drawChannels(){
    if(!this.showChannels)return;const ctx=this.ctx;
    for(const ch of this.channels){
      const selected=[ch.from,ch.to].includes(this.selected)||[ch.from,ch.to].includes('L:'+this.selected),branch=ch.from.startsWith('L:')&&ch.to.startsWith('L:'),storage=ch.from==='U'&&ch.to.startsWith('L:');
      if(storage&&!selected&&this.selected!=='U')continue;
      const decay=[ch.from,ch.to].includes('L:faint')||[ch.from,ch.to].includes('L:forgotten'),color=branch?(decay?'#95b5cd':'#c6c0f4'):selected?'#c5edff':'#7198bc';
      this.path(ch.strokePoints,color,selected?.72:branch?.48:.20,selected?1.5:branch?1.15:.65);
      if(this.showLabels&&ch.from==='L:warm'&&['L:deep','L:faint'].includes(ch.to)){const label=ch.to==='L:deep'?'重要保存':'普通衰退',p=this.project(curve(ch,.54));if(p.inViewport){ctx.font='8px "Microsoft YaHei",sans-serif';ctx.globalAlpha=.9;ctx.fillStyle='#0b1728';ctx.fillRect(p.x-20,p.y-9,42,14);ctx.fillStyle=color;ctx.fillText(label,p.x-16,p.y+1);}}
      if(branch){const a=this.project(curve(ch,.53)),b=this.project(curve(ch,.57));if(a.inViewport&&b.inViewport){const angle=Math.atan2(b.y-a.y,b.x-a.x);ctx.globalAlpha=.7;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(b.x-5*Math.cos(angle-.6),b.y-5*Math.sin(angle-.6));ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-5*Math.cos(angle+.6),b.y-5*Math.sin(angle+.6));ctx.stroke();}}
      for(const port of ch.ports){const p=this.project(port.position);if(!p.inViewport)continue;this.path([port.anchor,port.position],color,selected?.8:.36,selected?1.1:.65);ctx.globalAlpha=selected?.95:.7;ctx.strokeStyle=color;ctx.lineWidth=.8;ctx.beginPath();ctx.arc(p.x,p.y,selected?2.4:1.5,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#e5f5ff';ctx.beginPath();ctx.arc(p.x,p.y,selected?1.15:.7,0,Math.PI*2);ctx.fill();}
    }
  }
  drawMemories(time){
    const ctx=this.ctx,nodes=[...this.nodes.values()],ease=atlasFrameEase(.05,this.deltaMs),headDepth=this.project(point(HEAD_VOLUME.center)).depth,regions=this.regionById??=new Map(this.graph.regions.map(region=>[region.id,region])),layers=this.layerById??=new Map((this.graph.layers??[]).map(layer=>[layer.id,layer]));for(const n of nodes)for(const axis of ['x','y','z'])n[axis]+=(n.target[axis]-n[axis])*ease;
    ctx.setLineDash([3,4]);for(const edge of this.graph.edges??[]){const a=this.nodes.get(edge.from_id),b=this.nodes.get(edge.to_id);if(!a||!b)continue;const selected=[a.id,b.id].includes(this.selected);if(selected)this.path([a,b],'#d8b6ee',.7,1);}
    const selected=this.nodes.get(this.selected);if(selected)for(const id of selected.region_ids){const r=this.graph.regions.find(r=>r.id===id);if(r)this.path([selected,point(r.position)],r.color,.55,1);}ctx.setLineDash([]);
    for(const {n,p} of nodes.map(n=>({n,p:this.project(n)})).filter(v=>v.p.inViewport).sort((a,b)=>a.p.depth-b.p.depth)){
      const region=regions.get(primaryRegion(n)),layer=layers.get(n.layer),color=layer?.color??region?.color??'#c7e6ff',active=this.selected===n.id||this.hovered===n.id||(this.active.get(n.id)??0)>time,pointScale=clamp(p.scale*2,.75,1.5),size=(active?3.5:1.6+Math.min(1.1,n.importance??.2))*pointScale,depthAlpha=clamp(.88+(p.depth-headDepth)/1100,.64,1);
      this.halo(p.x,p.y,active?20:size*4.5+3,color,active?.95:.66);ctx.globalAlpha=active?1:depthAlpha;ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=.65;ctx.beginPath();
      if(['claim','pattern'].includes(n.kind)){ctx.moveTo(p.x,p.y-size*1.4);ctx.lineTo(p.x+size,p.y);ctx.lineTo(p.x,p.y+size*1.4);ctx.lineTo(p.x-size,p.y);ctx.closePath();}else if(n.kind==='intent')ctx.rect(p.x-size,p.y-size,size*2,size*2);else ctx.arc(p.x,p.y,size,0,Math.PI*2);ctx.fill();ctx.fillStyle='#f2fbff';ctx.globalAlpha=active?1:Math.max(.92,Math.min(1,depthAlpha+.1));ctx.beginPath();ctx.arc(p.x,p.y,Math.max(.65,size*.4),0,Math.PI*2);ctx.fill();
      if(['P0','P1'].includes(n.protection)){ctx.globalAlpha=active?.9:.4;ctx.beginPath();ctx.arc(p.x,p.y,size+1.4*pointScale,0,Math.PI*2);ctx.stroke();}
      if(n.archive_level){ctx.globalAlpha=.9;ctx.strokeStyle=n.archive_level===2?'#d0c2ff':'#97e5ff';ctx.beginPath();ctx.arc(p.x,p.y,size+3,0,Math.PI*2);ctx.stroke();if(this.showLabels&&p.scale>.3){ctx.font='8px sans-serif';ctx.fillStyle='#daedff';ctx.fillText('L'+n.archive_level,p.x+size+4,p.y-3);}}
      this.hits.push({id:n.id,type:'memory',scope:n.scope,label:n.label,x:p.x,y:p.y,depth:p.depth,radius:Math.max(6,size+2)});
    }
  }
  drawRegions(time){
    const ctx=this.ctx;
    for(const region of this.graph.regions){
      const hub=this.nebulae?.find(mist=>mist.region.id===region.id)?.envelope?.hub??point(region.position),p=this.project(hub),active=this.selected===region.id||this.pulses.some(q=>time>q.start&&time<q.start+q.duration&&[q.event.source_region,q.event.target_region].includes(region.id));
      if(!p.inViewport)continue;
      this.halo(p.x,p.y,active?28:17,region.color,active?.8:.4);ctx.globalAlpha=1;ctx.fillStyle=region.color;ctx.beginPath();ctx.arc(p.x,p.y,active?3.7:2.5,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=.5;ctx.strokeStyle=region.color;ctx.lineWidth=.8;ctx.beginPath();ctx.arc(p.x,p.y,active?8:6,0,Math.PI*2);ctx.stroke();
      this.hits.push({id:region.id,type:'region',label:region.name,x:p.x,y:p.y,depth:p.depth,radius:10});
    }
    if(this.showChannels)for(const terminal of ATLAS_TERMINALS){const p=this.project(point(terminal.position));if(!p.inViewport)continue;this.halo(p.x,p.y,13,terminal.color,.5);ctx.globalAlpha=.95;ctx.strokeStyle=terminal.color;ctx.fillStyle='#0e2539';ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();ctx.stroke();this.hits.push({id:terminal.id,type:'terminal',label:terminal.name,x:p.x,y:p.y,depth:p.depth,radius:7});}
    const exit=this.project(point(FORGET_EXIT.position));if(this.showChannels&&exit.inViewport){ctx.globalAlpha=.85;ctx.fillStyle=FORGET_EXIT.color;ctx.beginPath();ctx.arc(exit.x,exit.y,2.5,0,Math.PI*2);ctx.fill();}
  }
  drawNames(){
    if(!this.showLabels)return;
    const ctx=this.ctx,placed=[],{c,s,cp,sp}=this.rotation;
    const entries=[...this.graph.regions.map(region=>({...region,type:'region',text:region.name,label:region.name})),...this.storage.map(({layer})=>({...layer,type:'layer',text:layer.name+' · '+layer.count,label:layer.name+'：'+layer.description})),...(this.showChannels?ATLAS_TERMINALS.map(terminal=>({...terminal,type:'terminal',text:terminal.name,label:terminal.name})):[])];
    ctx.save();ctx.font='10px "Microsoft YaHei",sans-serif';ctx.textBaseline='middle';
    for(const entry of entries){
      const p=this.project(point(entry.position));if(!p.inViewport)continue;
      const [rx,ry,rz]=entry.radii??[25,25,25],width=ctx.measureText(entry.text).width+16,height=21;
      // Names stay beside their own projected cloud, including after rotation; no leader lines.
      const ex=clamp(Math.hypot(rx*c,rz*s)*p.scale,10,64),ey=clamp(Math.hypot(rx*s*sp,ry*cp,rz*c*sp)*p.scale,10,64);
      const offsets=[[0,ey+15],[0,-ey-15],[ex+width/2+6,0],[-ex-width/2-6,0],[ex*.7,ey+15],[-ex*.7,-ey-15]];
      const boxes=offsets.map(([dx,dy])=>({x:clamp(p.x+dx,width/2+8,this.w-width/2-8),y:clamp(p.y+dy,this.plotTop+height/2+2,this.plotTop+this.plotHeight-height/2-2)}));
      const score=b=>placed.reduce((sum,a)=>sum+Math.max(0,(a.width+width)/2+4-Math.abs(a.x-b.x))*Math.max(0,height+4-Math.abs(a.y-b.y)),0)*10+Math.hypot(b.x-p.x,b.y-p.y);
      const b=boxes.reduce((best,b)=>score(b)<score(best)?b:best);placed.push({...b,width});
      ctx.globalAlpha=.92;ctx.fillStyle='#091525';ctx.fillRect(b.x-width/2,b.y-height/2,width,height);
      ctx.globalAlpha=1;ctx.fillStyle=entry.color;ctx.fillText(entry.text,b.x-width/2+8,b.y);
      this.hits.push({id:entry.id,type:entry.type,label:entry.label,x:b.x,y:b.y,depth:p.depth,bounds:[width,height]});
    }
    ctx.restore();
  }
  drawActivity(time){
    const ctx=this.ctx;this.pulses=this.pulses.filter(q=>time<q.start+q.duration+100);
    for(const q of this.pulses){const t=(time-q.start)/q.duration;if(t<0||t>1)continue;const p=this.project(curve(q.channel,q.reversed?1-t:t));if(!p.inViewport)continue;const bad=['failed','skipped'].includes(q.event.result_status),color=bad?'#f5a4aa':q.event.result_status==='queued'?'#e7d18b':'#c2f6ff';this.halo(p.x,p.y,13,color,.95);ctx.globalAlpha=1;ctx.fillStyle=color;ctx.beginPath();ctx.arc(p.x,p.y,1.8,0,Math.PI*2);ctx.fill();this.path(Array.from({length:8},(_,i)=>curve(q.channel,q.reversed?Math.min(1,1-t+i*.014):Math.max(0,t-i*.014))),color,.7,1.3);}
  }
  drawMeteors(time){
    const ctx=this.ctx;this.meteors=this.meteors.filter(m=>time<m.start+3400);
    for(const m of this.meteors){const t=(time-m.start)/3200;if(t<0)continue;const origin=this.project(m),scale=Math.max(.12,origin.scale),q={x:m.x+60*t/scale,y:m.y-220*t*t/scale,z:m.z+18*t},alpha=Math.max(0,1-t);
      this.path([{x:q.x-14/scale,y:q.y+48*Math.max(.25,t)/scale,z:q.z},q],'#dce9ff',alpha,2);
      const p=this.project(q);if(!p.visible)continue;this.halo(p.x,p.y,23,'#c2ddff',alpha);ctx.globalAlpha=alpha;ctx.fillStyle='#f6fcff';ctx.beginPath();ctx.arc(p.x,p.y,2.4,0,Math.PI*2);ctx.fill();
    }
  }

  draw(time){
    const ctx=this.ctx,w=this.w,h=this.h;if(!w||!h)return;this.prepareProjection();ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.clearRect(0,0,w,h);this.hits=[];
    this.drawGalaxy(time);this.glb?.render(this,this.showWire);if(!this.graph)return;
    if(!this.showAtlas)return;ctx.save();ctx.beginPath();ctx.rect(0,this.plotTop,w,this.plotHeight);ctx.clip();this.drawRegionMist(time);this.drawStorage(time);this.drawChannels();this.drawBrain();this.drawRegions(time);this.drawMemories(time);this.drawActivity(time);this.drawNames();ctx.restore();this.drawMeteors(time);
    ctx.globalAlpha=.65;ctx.fillStyle='#91b1cd';ctx.font='9px "Microsoft YaHei",sans-serif';ctx.fillText((this.dragMode==='pan'?'拖动平移':'拖动旋转')+' · 右键 / Alt 拖动旋转 · 滚轮缩放 · 方向键平移 · Esc 全身',24,this.plotTop+this.plotHeight+11);ctx.globalAlpha=1;
  }
}
