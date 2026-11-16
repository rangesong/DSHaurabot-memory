import { Camera,clamp } from './camera.js';
import { HEAD_VOLUME } from './v5-spatial.js';

export const CAMERA_DISTANCE=2200,NEAR=8,FAR=30000,MAX_ZOOM=32;
const head=()=>Object.fromEntries(['x','y','z'].map((axis,i)=>[axis,HEAD_VOLUME.center[i]]));
const full={x:44,y:210,z:0};
const smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
// Preserve the original 30 Hz easing duration at any display refresh rate.
export const atlasFrameEase=(amount,deltaMs=1000/30)=>1-Math.pow(1-amount,clamp(deltaMs,0,100)/(1000/30));

/** Dolly towards the focus with a fixed lens, rather than magnifying from outside. */
export class AtlasCamera extends Camera {
  scale(factor){
    if(!Number.isFinite(factor)||factor<=0)return;
    this.destination=null;this.zoom=clamp(this.zoom*factor,.35,MAX_ZOOM);
    this.targetZoom=this.zoom;
    if(this.autoHead){const t=smooth((this.zoom-1)/1.6),aim=head();for(const axis of ['x','y','z'])this.target[axis]=full[axis]+(aim[axis]-full[axis])*t;}
  }
  focus(point,zoom=3.4){super.focus(point);this.autoHead=false;this.targetZoom=clamp(zoom,.35,MAX_ZOOM);}
  tick(deltaMs=1000/30){
    if(!this.destination)return;
    const ease=atlasFrameEase(.12,deltaMs);
    for(const axis of ['x','y','z'])this.target[axis]+=(this.destination[axis]-this.target[axis])*ease;
    this.zoom+=(this.targetZoom-this.zoom)*ease;
    if(Math.hypot(...['x','y','z'].map(axis=>this.destination[axis]-this.target[axis]))<.1&&Math.abs(this.targetZoom-this.zoom)<.001){this.target={...this.destination};this.zoom=this.targetZoom;this.destination=null;}
  }
}

export function atlasViewport(w,h,dockHeight,camera,modelReady){
  const bottom=h-dockHeight-34;
  const plotTop=18,plotHeight=Math.max(150,bottom-plotTop);
  const base=Math.min(Math.max(100,w-94)/1010,Math.max(180,bottom-48)/1640)*(modelReady ? .86 : 1);
  return {plotTop,plotHeight,unit:base*camera.zoom,distance:CAMERA_DISTANCE/camera.zoom,near:NEAR,far:FAR};
}

/** The same near plane, lens and dolly distance are used by WebGL and picking. */
export function projectAtlas(p,view,out={}){
  const {c,s,cp,sp}=view.rotation,dx=p.x-view.camera.target.x,dy=p.y-view.camera.target.y,dz=p.z-view.camera.target.z;
  const x=dx*c+dz*s,z=-dx*s+dz*c,y=dy*cp-z*sp,depth=dy*sp+z*cp;
  const cameraDepth=view.distance-depth,visible=cameraDepth>=view.near&&cameraDepth<=view.far;
  const scale=view.unit*view.distance/Math.max(view.near,cameraDepth);
  const px=view.w/2+x*scale+view.camera.panX,py=view.plotTop+view.plotHeight*.51-y*scale+view.camera.panY;
  out.x=px;out.y=py;out.depth=depth;out.scale=scale;out.visible=visible;out.inViewport=visible&&px>=0&&px<=view.w&&py>=view.plotTop&&py<=view.plotTop+view.plotHeight;return out;
}

export function pickAtlasHit(hits,p){
  // A visible star wins over a surrounding region's larger click halo. Labels have exact rectangles.
  const candidates=hits.filter(hit=>hit.bounds?Math.abs(hit.x-p.x)<=hit.bounds[0]/2&&Math.abs(hit.y-p.y)<=hit.bounds[1]/2:Math.hypot(hit.x-p.x,hit.y-p.y)<=hit.radius);
  return candidates.sort((a,b)=>(a.type==='memory'?0:a.bounds?1:2)-(b.type==='memory'?0:b.bounds?1:2)||Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y)||(b.depth??0)-(a.depth??0))[0];
}
