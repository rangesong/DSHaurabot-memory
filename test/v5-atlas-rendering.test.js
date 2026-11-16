import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlasCamera,atlasViewport,projectAtlas } from '../apps/memory-sea/src/v5-camera.js';
import { V5Scene } from '../apps/memory-sea/src/v5-scene.js';

test('foreground atlas follows every display frame and bounds the first frame after resuming',()=>{
  const saved=new Map(['requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,globalThis[key]]));
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  try{
    for(const hz of [30,60,120]){
      const ticks=[],draws=[],scene=Object.assign(Object.create(V5Scene.prototype),{running:true,isForeground:()=>true,camera:{tick:dt=>ticks.push(dt)},canvas:{dataset:{}},draw:t=>draws.push(t)});
      for(let i=0;i<hz;i++)scene.renderFrame(i*1000/hz);
      assert.equal(draws.length,hz);assert.equal(ticks[0],1000/30);
      scene.setRunning(false);scene.setRunning(true);scene.renderFrame(600000);
      assert.equal(ticks.at(-1),1000/30,'returning from the background does not fast-forward camera easing');
    }
  }finally{for(const [key,value]of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('camera and migrating stars travel the same distance per second at 30, 60 and 120 Hz',()=>{
  const results=[];
  for(const hz of [30,60,120]){
    const camera=new AtlasCamera();camera.target={x:0,y:0,z:0};camera.zoom=1;camera.focus({x:100,y:120,z:140},4);
    const node={id:'moving',x:0,y:0,z:0,target:{x:100,y:120,z:140}};
    const scene=Object.assign(Object.create(V5Scene.prototype),{nodes:new Map([[node.id,node]]),deltaMs:1000/hz,ctx:{setLineDash(){}},graph:{regions:[],edges:[]},project:()=>({depth:0,inViewport:false})});
    for(let i=0;i<hz;i++){camera.tick(1000/hz);scene.drawMemories(i*1000/hz);}
    results.push([camera.target.x,camera.target.y,camera.target.z,camera.zoom,node.x,node.y,node.z]);
  }
  for(const result of results.slice(1))result.forEach((value,i)=>assert.ok(Math.abs(value-results[0][i])<1e-10));
});

test('reused projection output preserves near clipping, depth and picking coordinates',()=>{
  const camera=new AtlasCamera();camera.yaw=.4;camera.pitch=-.2;camera.target={x:10,y:20,z:30};camera.zoom=6;
  const view={w:900,h:700,camera,rotation:{s:Math.sin(.4),c:Math.cos(.4),sp:Math.sin(-.2),cp:Math.cos(-.2)},...atlasViewport(900,700,80,camera,true)},out={};
  for(const p of [{x:20,y:100,z:-40},{x:-120,y:-900,z:3500},{x:0,y:0,z:0}]){
    const expected=projectAtlas(p,view);assert.equal(projectAtlas(p,view,out),out);assert.deepEqual(out,expected);
  }
});

test('drawing does not remeasure DOM layout and resizing preserves an unchanged canvas buffer',()=>{
  const saved=new Map(['window','document','ResizeObserver','devicePixelRatio'].map(key=>[key,globalThis[key]]));let measure=0,callback,resets=0,width=900,height=700;
  const dock={getBoundingClientRect(){measure++;return {height:0};}};
  globalThis.document={getElementById:()=>null,querySelector:()=>dock};globalThis.devicePixelRatio=1;
  globalThis.window={matchMedia:()=>({matches:false}),addEventListener(){}};
  globalThis.ResizeObserver=class{constructor(fn){callback=fn;}observe(){}disconnect(){}};
  const canvas={dataset:{},getBoundingClientRect:()=>({width:900,height:700}),getContext:()=>({}),addEventListener(){},get width(){return width;},set width(value){resets++;width=value;},get height(){return height;},set height(value){resets++;height=value;}};
  try{
    const scene=new V5Scene(canvas);callback();const before=measure;
    for(let i=0;i<120;i++)scene.prepareProjection();assert.equal(measure,before);assert.equal(scene.dockHeight,0);assert.equal(resets,0);
    callback();assert.equal(resets,0);scene.dispose();
  }finally{for(const [key,value]of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
