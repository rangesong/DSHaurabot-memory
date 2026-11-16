import test from 'node:test';
import assert from 'node:assert/strict';
import { V5Runtime } from '../core/v5-runtime.js';
import { V5ModelService } from '../core/v5-model-service.js';
import { REGIONS,LAYERS,CHANNELS,DAY } from '../core/v5-config.js';
import { createMemorySeaServer } from '../scripts/serve-memory-sea.js';
import { memoryPoint,memoryFlowPath,headContains } from '../apps/memory-sea/src/v5-spatial.js';
import { workNebula,galaxyStars } from '../apps/memory-sea/src/v5-nebula.js';
import { V5Scene } from '../apps/memory-sea/src/v5-scene.js';
import { channelGeometry } from '../apps/memory-sea/src/v5-character.js';

function setup(t){let time=1794500000000;const r=new V5Runtime({clock:()=>time});t.after(()=>r.close());return {r,advance:days=>time+=days*DAY};}
function pattern(r){const source=r.ingest({text:'当我疲惫时，以后请简洁回应，不要一直追问。',process:true});return {source,m:r.store.all(source.scope).find(m=>m.kind==='pattern'&&m.source_refs.includes(source.source_id))};}
function activate(r,m,extra={}){return r.writeCentralRule({scope:m.scope,id:m.id,expected_revision:m.revision,region:'W4',param:'detail_level',value:0,condition:'疲惫, 累了',reason:'逐字核对了这条条件偏好',...extra});}

test('seven named U volumes form the important/ordinary branches without adding M directories',()=>{
  assert.equal(LAYERS.length,7);assert.equal(REGIONS.filter(r=>r.domain==='memory').length,4);
  for(const layer of LAYERS){assert.ok(layer.name.length>=3&&layer.name.length<=5&&!/星区|星团/.test(layer.name));assert.ok(headContains(Object.fromEntries(['x','y','z'].map((key,i)=>[key,layer.position[i]]))));}
  assert.deepEqual(memoryFlowPath('warm','implicit'),['L:warm','L:deep','L:mature','L:implicit']);assert.deepEqual(memoryFlowPath('warm','forgotten'),['L:warm','L:faint','L:forgotten']);
  for(const route of [memoryFlowPath('recent','implicit'),memoryFlowPath('recent','forgotten')])for(let i=1;i<route.length;i++)assert.ok(CHANNELS.some(c=>[c.from,c.to].includes(route[i-1])&&[c.from,c.to].includes(route[i])));
});

test('memory stars occupy their actual storage volumes; one implicit canonical ID projects into its work envelope',()=>{
  const means=[];for(const layer of LAYERS){const points=Array.from({length:100},(_,i)=>memoryPoint({id:layer.id+i,kind:'raw',layer:layer.id,created_at:0,region_ids:['M4']},REGIONS,{now:0}));assert.ok(points.every(p=>headContains(p)));means.push(points.reduce((sum,p)=>sum+p.y,0)/points.length);for(const axis of ['x','y','z'])assert.ok(Math.max(...points.map(p=>p[axis]))-Math.min(...points.map(p=>p[axis]))>15);}
  assert.ok(means[0]>means[1]&&means[1]>means[2]&&means[2]>means[3]&&means[3]>means[4]);
  const m={id:'rule',layer:'implicit',central_rule_region:'W4'},p=memoryPoint(m,REGIONS),w=REGIONS.find(r=>r.id==='W4');assert.ok(headContains(p));assert.ok(Math.hypot(p.x-w.position[0],p.y-w.position[1],p.z-w.position[2])<75);assert.deepEqual(m,{id:'rule',layer:'implicit',central_rule_region:'W4'});
});

test('each work mist is a distinct three-dimensional anatomical envelope inside the head',()=>{
  const shapes=REGIONS.filter(r=>r.domain==='work').map(r=>workNebula(r));assert.equal(new Set(shapes.map(shape=>JSON.stringify(shape.particles))).size,5);
  for(const shape of shapes){assert.ok(shape.particles.every(p=>headContains(p)));for(const axis of ['x','y','z'])assert.ok(Math.max(...shape.particles.map(p=>p[axis]))-Math.min(...shape.particles.map(p=>p[axis]))>15);assert.equal(shape.outlines.length,3);}
  const stars=galaxyStars();assert.equal(stars.length,600);assert.ok(stars.some(star=>star.bright&&star.alpha>.7));assert.ok(stars.every(star=>star.alpha>0&&star.alpha<=1&&star.y>=0&&star.y<=1));
});

test('important source -> conditional principle -> implicit rule uses the same canonical record and preserves evidence',t=>{
  const {r}=setup(t),a=r.ingest({text:'请记住：项目调试时先检查来源和版本。',process:true}),body=r.body(r.memory(a.memory_id));
  const proposal=r.proposeCentralRule({scope:a.scope,id:a.memory_id,expected_revision:r.memory(a.memory_id).revision,principle:'调试时先核对来源和版本',condition:'项目调试',reason:'本人确定这条做法适用于调试'});
  assert.equal(proposal.memory.layer,'mature');const count=r.store.all(a.scope).filter(m=>m.id===proposal.memory.id).length;
  const result=activate(r,proposal.memory,{condition:'项目调试',region:'W2',param:'candidate_limit',value:20});assert.equal(result.status.effective,true);assert.equal(result.memory.layer,'implicit');assert.equal(r.store.all(a.scope).filter(m=>m.id===proposal.memory.id).length,count);assert.equal(r.body(r.memory(a.memory_id)),body);
  const node=r.graph({scope:a.scope}).nodes.find(m=>m.id===proposal.memory.id);assert.equal(node.central_rule_region,'W2');assert.ok(r.trace(result.run_id).events.some(e=>e.source_region==='L:implicit'&&e.target_region==='W2'));
});

test('central rules affect real work controls only on matching conditions in their own scope and survive governance',t=>{
  const {r,advance}=setup(t),{source,m}=pattern(r);activate(r,m);assert.equal(r.controls('W4',source.scope,'我现在很疲惫').detail_level,0);assert.equal(r.controls('W4',source.scope,'今天精神很好').detail_level,r.config.W4.detail_level);
  const other=r.addScope({persona_id:'p',scope:'private:other'});assert.equal(r.controls('W4',other.id,'我现在很疲惫').detail_level,r.config.W4.detail_level);assert.equal(r.controls('W4','all','我现在很疲惫').detail_level,r.config.W4.detail_level);assert.equal(r.config.W4.detail_level,.5);
  const query=r.query({scope:source.scope,query:'我现在很疲惫'});assert.ok(query.trace.some(e=>e.source_region==='L:implicit'&&e.target_region==='W4'&&e.param==='detail_level'));
  advance(500);const plan=r.retentionPlan({scope:source.scope});assert.ok(!plan.items.some(item=>item.id===m.id));assert.ok(plan.items.every(item=>!m.source_refs.includes(item.id)||!['summarize','forget'].includes(item.action)));assert.equal(r.memory(m.id).layer,'implicit');
});

test('pause, reactivation, counterexamples and source corrections immediately disable obsolete implicit influence',t=>{
  const {r}=setup(t),{source,m}=pattern(r);let current=activate(r,m).memory;
  r.writeCentralRule({scope:m.scope,id:m.id,expected_revision:current.revision,action:'pause',reason:'暂时不用'});assert.equal(r.resolveRules(m.scope,'疲惫').length,0);assert.equal(r.memory(m.id).layer,'mature');
  current=activate(r,r.memory(m.id)).memory;r.feedback({scope:m.scope,id:m.id,text:'反例：这次疲惫时希望详细说明。',kind:'counterexample'});assert.equal(r.resolveRules(m.scope,'疲惫').length,0);assert.equal(r.centralRules({scope:m.scope}).items[0].effective,false);
  assert.throws(()=>activate(r,r.memory(m.id)));assert.throws(()=>activate(r,current),{code:'REVISION_CONFLICT'});
  const reviewed=activate(r,r.memory(m.id),{action:'reconfirm',condition:'疲惫且希望简短',reason:'核对反例后，把条件收窄到明确希望简短'});assert.equal(reviewed.status.effective,true);assert.ok(reviewed.memory.attributes.counterexamples.length>0);assert.equal(r.resolveRules(m.scope,'疲惫').length,0);
  const b=pattern(r);activate(r,b.m);r.revise({scope:b.source.scope,id:b.source.memory_id,expected_revision:r.memory(b.source.memory_id).revision,text:'这条旧偏好已更正。'});assert.ok(!r.resolveRules(b.source.scope,'疲惫').some(item=>item.id===b.m.id));assert.ok(r.body(r.memory(source.memory_id)).includes('疲惫'));
});

test('W1, W3 and W5 rule controls are consumed by encoding, appraisal and feedback learning',t=>{
  const {r}=setup(t),a=pattern(r);activate(r,a.m,{region:'W1',param:'write_detail',value:1,condition:'调试'});
  const receipt=r.ingest({scope:a.source.scope,text:'调试时不能使用旧版本。',process:true});const episode=r.store.all(receipt.scope).find(m=>m.kind==='experience'&&m.source_refs.includes(receipt.source_id));assert.ok(episode.attributes.experience.explicit_constraints.length);assert.ok(r.trace(receipt.run_id).events.some(e=>e.source_region==='L:implicit'&&e.target_region==='W1'));
  const b=pattern(r);activate(r,b.m,{region:'W3',param:'expression_gain',value:0});const query=r.query({scope:b.source.scope,query:'现在疲惫'});assert.equal(query.trace.find(e=>e.operation==='结合已读内容进行复评').appraisal.expression_gain,0);
  const c=pattern(r);activate(r,c.m,{region:'W5',param:'learning_rate',value:1,condition:'帮助'});const target=pattern(r).m;r.feedback({scope:target.scope,id:target.id,text:'这次很有帮助',kind:'feedback'});assert.ok(Math.abs(r.memory(target.id).attributes.pattern_gain-.19)<1e-8);assert.ok(r.store.events({limit:2000}).some(e=>e.source_region==='L:implicit'&&e.target_region==='W5'));
});

test('unreviewed/forged rules cannot change protection or source access, and invalid writes are atomic',t=>{
  const {r}=setup(t),{m}=pattern(r),before=r.memory(m.id),count=r.store.stats().sources;
  for(const extra of [{param:'forget_after_days',region:'W5',value:2},{param:'remote_send',value:1},{value:999},{condition:''},{reason:''}])assert.throws(()=>activate(r,m,extra));
  assert.equal(r.memory(m.id).revision,before.revision);assert.equal(r.store.stats().sources,count);
  const forged=r.memory(m.id);forged.attributes.central_rule={status:'active',region:'W4',param:'detail_level',value:0,keywords:['疲惫'],approved_revision:forged.revision};forged.layer='implicit';r.store.putMemory(forged);assert.equal(r.resolveRules(m.scope,'疲惫').length,0);assert.equal(r.centralRules({scope:m.scope}).items[0].effective,false);
});

test('DeepSeek receives scoped effective controls and refuses a result when a central rule changes during generation',async t=>{
  const {r}=setup(t),{source,m}=pattern(r);activate(r,m);let change=false;
  const client={model:'synthetic',status:()=>({configured:true}),async json(_,payload){assert.equal(payload.expression_controls.detail_level,0);assert.ok(payload.approved_central_rules.some(item=>item.id===m.id));if(change)r.writeCentralRule({scope:m.scope,id:m.id,expected_revision:r.memory(m.id).revision,action:'pause',reason:'生成期间暂停'});return {value:{reply:'好，简短接住这次话题。',used_memory_ids:[]},model:'synthetic',usage:{total_tokens:10},duration_ms:1};}};
  const service=new V5ModelService(r,{client});await service.chat({scope:source.scope,query:'现在很疲惫'});change=true;await assert.rejects(()=>service.chat({scope:source.scope,query:'仍然很疲惫'}),{code:'REVISION_CONFLICT'});
});

test('ordinary decline emits an actual forgetting event while important evidence remains readable',t=>{
  const {r,advance}=setup(t),low=r.ingest({text:'你好',process:true}),ordinary=r.ingest({scope:low.scope,text:'普通场景的开头。中间是普通的背景细节，晚间照常结束。'.repeat(30),process:true}),important=r.ingest({scope:low.scope,text:'请记住：不能删除这条重要边界。',process:true});advance(5);let plan=r.retentionPlan({scope:low.scope});r.applyRetention({plan_id:plan.id});assert.equal(r.memory(low.memory_id).layer,'warm');
  r.config.W5.keep_raw_archive=0;advance(60);plan=r.retentionPlan({scope:low.scope});r.applyRetention({plan_id:plan.id});assert.equal(r.memory(low.memory_id).layer,'faint');assert.equal(r.memory(ordinary.memory_id).layer,'faint');advance(400);plan=r.retentionPlan({scope:low.scope});const result=r.applyRetention({plan_id:plan.id});assert.equal(r.body(r.memory(low.memory_id)),null);assert.equal(r.body(r.memory(ordinary.memory_id)),null);assert.ok(r.trace(result.run_id).events.some(e=>e.meteor&&e.from_layer==='faint'&&e.to_layer==='forgotten'));assert.ok(r.body(r.memory(important.memory_id)).includes('重要边界'));
});

test('a real forgetting event traverses the faint exit and becomes a bright falling meteor',()=>{
  const dots=[],scene=Object.assign(Object.create(V5Scene.prototype),{channels:channelGeometry(REGIONS,CHANNELS),pulses:[],active:new Map(),meteors:[],nodes:new Map(),path(){},halo(){},project:p=>({x:p.x,y:-p.y,scale:1,visible:true,inViewport:true}),ctx:{beginPath(){},arc(x,y){dots.push({x,y});},fill(){}}});
  scene.event({memory_id:'forgotten-real-id',source_region:'W5',target_region:'U',from_layer:'faint',to_layer:'forgotten',meteor:true,output_refs:[],result_status:'success'});
  assert.ok(scene.pulses.some(p=>[p.channel.from,p.channel.to].includes('L:forgotten')));assert.equal(scene.meteors.length,1);const start=scene.meteors[0].start;assert.equal(scene.meteors[0].memory_id,'forgotten-real-id');
  scene.drawMeteors(start+300);scene.drawMeteors(start+1400);assert.ok(dots[1].y>dots[0].y);assert.equal(scene.ctx.fillStyle,'#f6fcff');scene.drawMeteors(start+3500);assert.equal(scene.meteors.length,0);
});

test('rule HTTP endpoints enforce scope/revision and serve only the shared display contract',async t=>{
  const {r}=setup(t),{m}=pattern(r),server=createMemorySeaServer({runtime:r});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/shared/v5-memory-layout.js')).status,200);assert.equal((await fetch(base+'/shared/other.js')).status,404);
  const post=body=>fetch(base+'/api/v5/central-rule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await post({scope:m.scope,id:m.id,expected_revision:m.revision,region:'W4',param:'detail_level',value:0,condition:'疲惫',reason:'HTTP核对来源'});assert.equal(response.status,200);assert.equal((await response.json()).memory.layer,'implicit');assert.equal((await post({scope:'another',id:m.id})).status,404);
  const list=await (await fetch(base+'/api/v5/central-rules?scope='+m.scope+'&region=W4')).json();assert.equal(list.items.length,1);assert.equal(list.items[0].effective,true);
});
