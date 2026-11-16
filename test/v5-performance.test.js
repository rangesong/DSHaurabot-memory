import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../apps/memory-sea/vendor/three/three.module.js';
import { V5Runtime } from '../core/v5-runtime.js';
import { GLBCharacter } from '../apps/memory-sea/src/v5-glb-character.js';
import { AtlasCamera, atlasViewport } from '../apps/memory-sea/src/v5-camera.js';

function fixture(t) { const runtime=new V5Runtime({clock:()=>1794567000000});t.after(()=>runtime.close());return runtime; }

test('scope lookup stays exact without enumerating other personas or chats',t=>{
  const r=fixture(t),context={persona_id:'synthetic',scope:'private:one'},a=r.addScope(context);
  r.addScope({persona_id:'other',scope:'private:one'});
  r.store.scopes=()=>{throw new Error('full scope scan');};
  assert.deepEqual(r.addScope(context),a);assert.deepEqual(r.requireScope(a.id),a);
  assert.throws(()=>r.requireScope('missing'),{code:'NOT_FOUND'});
});

test('heartbeat and handoff report pending work without collecting whole-database statistics',t=>{
  const r=fixture(t);
  r.ingest({text:'合成原话，暂未交接。'});
  assert.equal(r.store.queuePending(),r.store.stats().pending);
  r.store.stats=()=>{throw new Error('full statistics');};
  assert.equal(r.processJobs().pending,0);
  assert.equal(r.processJobs().processed,0);
});

test('overview preserves scoped counts and time range while graph reads only visible payloads',t=>{
  const r=fixture(t),a=r.addScope({persona_id:'synthetic',scope:'private:one'}),b=r.addScope({persona_id:'synthetic',scope:'private:two'});
  for(let i=0;i<10;i++)r.ingest({scope:a.id,text:`合成来源${i}`,occurred_at:1000+i});
  r.ingest({scope:b.id,text:'另一个聊天的合成原话',occurred_at:null});
  const first=r.store.all(a.id)[0],warm=r.memory(first.id);warm.layer='warm';r.store.putMemory(warm,null,{history:false});
  const chunk={...structuredClone(warm),id:'internal:chunk',kind:'archive_chunk'};r.store.putMemory(chunk,null,{history:false});
  r.store.all=()=>{throw new Error('full memory payload scan');};
  const overview=r.overview();
  assert.equal(overview.scopes.find(s=>s.id===a.id).count,10);
  assert.equal(overview.scopes.find(s=>s.id===b.id).count,1);
  assert.equal(overview.layers.find(l=>l.id==='warm').count,1);
  assert.deepEqual(overview.time_range,{start:1000,end:1009});
  let reads=0;const getMemory=r.store.getMemory.bind(r.store);r.store.getMemory=id=>{reads++;return getMemory(id);};
  const graph=r.graph({scope:a.id,limit:3,focus_id:first.id});
  assert.equal(graph.counts.matching,10);assert.equal(graph.counts.visible,3);
  assert.ok(graph.nodes.some(n=>n.id===first.id));assert.ok(graph.nodes.every(n=>n.scope===a.id&&n.kind!=='archive_chunk'));
  assert.equal(reads,3);
  assert.equal(r.graph({scope:a.id,layer:'warm',limit:3}).nodes.length,1);
  assert.equal(r.graph({scope:a.id,q:'不存在的字词',limit:3}).nodes.length,0);
});

test('static model reuses the GPU frame but camera, viewport and material changes redraw',()=>{
  let renders=0,resizes=0,materials=0;
  const character=Object.create(GLBCharacter.prototype);
  Object.assign(character,{ready:true,atlas:true,renderer:{domElement:{style:{}},setSize(){resizes++;},render(){renders++;}},glass:{setAtlas(){materials++;}},scene:{},camera:new THREE.PerspectiveCamera(),originalBackground:new THREE.Color('#091321')});
  const camera=new AtlasCamera();camera.target={x:0,y:600,z:0};camera.zoom=3.4;
  const view={w:900,h:700,camera,rotation:{s:0,c:1,sp:0,cp:1},...atlasViewport(900,700,160,camera,true)};
  character.render(view);for(let i=0;i<120;i++)character.render(view);
  assert.equal(renders,1);assert.equal(resizes,1);
  camera.panX=10;character.render(view);assert.equal(renders,2);
  camera.target.z=2;character.render(view);assert.equal(renders,3);
  view.rotation.s=.1;character.render(view);assert.equal(renders,4);
  view.plotTop+=1;character.render(view);assert.equal(renders,5);
  view.distance-=1;character.render(view);assert.equal(renders,6);
  view.w=901;character.render(view);assert.equal(renders,7);assert.equal(resizes,2);
  view.showAtlas=false;character.render(view);assert.equal(renders,8);assert.equal(materials,1);
  character.render(view,false);assert.equal(character.renderer.domElement.hidden,true);assert.equal(renders,8);
  character.render(view,true);assert.equal(character.renderer.domElement.hidden,false);assert.equal(renders,8);
  camera.zoom=4;character.render(view);assert.equal(renders,9);
});

test('an old protected detail survives more than 2000 newer matching candidates',t=>{
  let now=Date.parse('2021-01-01T00:00:00Z');const r=new V5Runtime({clock:()=>now});t.after(()=>r.close());
  const context={persona_id:'synthetic-long-term',scope:'private:long-term'};
  const saved=r.ingest({context,text:'务必记住：合成预算约定的准确金额是314159万元。',process:true});
  now=Date.parse('2026-11-14T00:00:00Z');
  r.importPartitions([{context,sources:Array.from({length:2200},(_,i)=>({id:`recent-noise:${i}`,chat_id:context.scope,speaker_id:'synthetic',role:'user',sequence:i+100,text:`合成预算约定的普通讨论第${i}条。`,occurred_at:now+i,time_precision:'instant',provenance:{system:'synthetic'}})),memories:[],relations:[]}]);
  for(const query of ['合成预算约定','预算314159']){
    const result=r.query({scope:saved.scope,query,use:false});
    assert.ok(result.context.some(item=>item.text.includes('314159')),query);
  }
  assert.match(r.body(r.memory(saved.memory_id)),/314159/);
});
