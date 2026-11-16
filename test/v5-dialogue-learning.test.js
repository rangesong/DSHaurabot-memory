import test from 'node:test';
import assert from 'node:assert/strict';
import {V5Runtime} from '../core/v5-runtime.js';
import {memoryChunks} from '../core/v5-semantic.js';
import {consoleLayout,diagnostics} from '../core/v5-console.js';

function fixture(t,{group=false}={}){let at=1794794400000;const r=new V5Runtime({clock:()=>at}),scope=r.addScope({persona_id:'test',scope:group?'group:300':'private:100'}).id;t.after(()=>r.close());
  const add=text=>r.ingest({scope,text,provenance:{speaker_id:'100'},occurred_at:at,process:true});
  const turn=(query,reply='好，我会简短陪着你。')=>{const source=add(query),q=r.query({scope,query});q.host_context_ids=q.context.map(m=>m.id);q.dialogue_strategy=r.dialogue.strategy(scope,query);r.dialogue.prepared(q,{chatId:group?'group:300':'private:100',input_source_ids:[source.source_id]});at+=1000;const answer=r.ingest({scope,text:reply,role:'assistant',provenance:{speaker_id:'bot'}});r.dialogue.observeReply({scope,text:reply,source_id:answer.source_id,at,turn_id:q.id,message_id:'reply-'+q.id,stage:'observed_host_activity'});at+=1000;return q;};
  return {r,scope,add,turn,advance:ms=>{at+=ms;}};
}
test('ordinary feedback joins the exact reply without treating affection or comfort as correctness',t=>{
  const f=fixture(t),q=f.turn('我今天很累，不想聊细节。'),raw=f.add('摸摸头，但你把时间记错了');
  const fb=f.r.dialogue.onUser({source_id:raw.source_id});assert.equal(fb.query_id,q.id);assert.equal(fb.interpretation.dimensions.affection,'possible_positive');assert.equal(fb.interpretation.dimensions.factual,'explicit_correction');assert.equal(fb.interpretation.approval,false);
  const strength=f.r.memory(q.context[0].id).strength;f.r.dialogue.onUser({source_id:raw.source_id});assert.equal(f.r.memory(q.context[0].id).strength,strength);assert.equal(f.r.dialogue.feedbackList({scope:f.scope}).items.length,1);
});
test('negated praise and incomplete task reports cannot become approval or completion',t=>{const f=fixture(t);for(const text of ['没有帮助','不是很满意','有帮助是安慰，不代表认可','问题还没解决']){const result=f.r.dialogue.interpret(text,{scope:f.scope,turn:{}});assert.equal(result.approval,false);assert.equal(result.dimensions.task,'unknown');}});
test('group feedback needs a reply target and another speaker cannot evaluate someone else by proximity',t=>{
  const f=fixture(t,{group:true}),q=f.turn('请简短解释这个流程'),raw=f.add('这样就好，很有帮助');assert.equal(f.r.dialogue.onUser({source_id:raw.source_id}),null);
  assert.ok(f.r.dialogue.onUser({source_id:raw.source_id,reply_to:'reply-'+q.id}));
  const stranger=f.r.ingest({scope:f.scope,text:'很有帮助',provenance:{speaker_id:'200'}});assert.equal(f.r.dialogue.onUser({source_id:stranger.source_id,reply_to:'reply-'+q.id}),null);
});
test('explicit interpretation corrections reverse previous strengthening and teach personal expression meaning',t=>{
  const f=fixture(t),q=f.turn('项目冷月预算说明'),raw=f.add('这样就好，很有帮助');const before=f.r.memory(q.context[0].id).strength;
  const fb=f.r.dialogue.onUser({source_id:raw.source_id});assert.ok(f.r.memory(q.context[0].id).strength>before);
  const correction=f.add('我说的有帮助是安慰，不是认可');f.r.dialogue.onUser({source_id:correction.source_id});
  assert.equal(f.r.dialogue.get('dialogue_feedback',fb.id).interpretation.meaning,'comfort');assert.equal(f.r.memory(q.context[0].id).strength,before);
  assert.equal(f.r.dialogue.interpret('有帮助',{scope:f.scope,turn:{reply:'抱歉'}}).meaning,'comfort');
});
test('conditional expression reaches the host strategy while current explicit request overrides old brevity',t=>{
  const f=fixture(t);f.add('当我疲惫时，以后请简短陪伴，不要连续追问。');
  const strategy=f.r.dialogue.strategy(f.scope,'我今天很疲惫');assert.equal(strategy.controls.followup_pressure,0);assert.ok(strategy.controls.detail_level<=.25);assert.ok(strategy.rule_ids.length);assert.match(strategy.text,/减少追问/);
  assert.ok(f.r.dialogue.strategy(f.scope,'我今天很疲惫，但是请详细分析').controls.detail_level>=.8);
  const ordinary=f.r.dialogue.strategy(f.scope,'帮我检查编译错误');assert.equal(ordinary.controls.followup_pressure,f.r.config.W4.followup_pressure);
});
test('implicit preference needs independent occasions and correcting the interpretation retracts it',t=>{
  const f=fixture(t),ids=[];for(let i=0;i<3;i++){f.turn('今天项目有点累');const raw=f.add('摸摸头');ids.push(f.r.dialogue.onUser({source_id:raw.source_id}).id);f.advance(86400000);}
  assert.ok(f.r.dialogue.strategy(f.scope,'今天项目有点累').controls.style_accommodation>f.r.config.W4.style_accommodation);
  for(const id of ids)f.r.dialogue.correct({scope:f.scope,id,meaning:'comfort',reason:'这是安慰'});
  assert.equal(f.r.dialogue.strategy(f.scope,'今天项目有点累').controls.style_accommodation,f.r.config.W4.style_accommodation);
});
test('night consolidation creates a source-linked tentative impression and corrections stop it immediately',t=>{
  const f=fixture(t),ids=[];for(let i=0;i<3;i++){f.turn('今天项目有点累');const raw=f.add('摸摸头');ids.push(f.r.dialogue.onUser({source_id:raw.source_id}).id);f.advance(86400000);}
  assert.equal(f.r.dialogue.consolidate().processed,1);const pattern=f.r.store.all(f.scope).find(m=>m.attributes.dialogue_learning);assert.ok(pattern);assert.equal(pattern.evidence.truth,'conditional_hypothesis');assert.equal(pattern.attributes.independent_occasions,3);assert.ok(pattern.source_refs.every(id=>f.r.store.getSource(id)?.role==='user'));
  assert.equal(f.r.dialogue.consolidate().processed,0);f.r.dialogue.correct({scope:f.scope,id:ids[0],meaning:'comfort',reason:'是安慰'});assert.equal(f.r.memory(pattern.id).review,'needs_review');
});
test('feedback reflection is night-gated, quota-bound and never uses model guesses as factual approval',async t=>{
  const f=fixture(t);f.turn('今天项目有点累');const raw=f.add('摸摸头'),fb=f.r.dialogue.onUser({source_id:raw.source_id});let calls=0;
  const client={model:'test',status:()=>({configured:true}),json:async()=>{calls++;return {value:{items:[{id:fb.id,meaning:'approval',reason:'可能认可'}]}};}};
  assert.equal((await f.r.dialogue.reflect(client)).processed,0);assert.equal(calls,0);
  assert.equal((await f.r.dialogue.reflect(client,{force:true})).processed,1);assert.equal(calls,1);
  await f.r.dialogue.reflect(client,{force:true});assert.equal(calls,1);assert.equal(f.r.dialogue.get('dialogue_feedback',fb.id).interpretation.approval,false);
});
test('chunked semantic indexing retrieves long-text tail and changed documents invalidate old vectors',async t=>{
  const f=fixture(t),raw=f.add('普通背景。'.repeat(90)+'隐藏细节：鲸尾口令。');let calls=0;
  const embed=async text=>{calls++;return text.includes('鲸尾')?[1,0]:[0,1];};f.r.semantic.configure({embed,model:'fixture'});
  const result=await f.r.semantic.sync({scope:f.scope,limit:100,force:true});assert.ok(result.chunks>1);
  const first=calls;await f.r.semantic.sync({scope:f.scope,limit:100,force:true});assert.equal(calls,first);
  const hits=await f.r.semantic.search({scope:f.scope,query:'鲸尾',minScore:.8});assert.ok(hits.some(h=>h.id===raw.memory_id&&h.offset>0));
  f.r.revise({scope:f.scope,id:raw.memory_id,expected_revision:f.r.memory(raw.memory_id).revision,text:'已明确更正为星河口令'});
  assert.ok(!(await f.r.semantic.search({scope:f.scope,query:'鲸尾',minScore:.8})).some(h=>h.id===raw.memory_id));assert.ok(memoryChunks('字'.repeat(1000)).at(-1).offset>700);
});
test('privacy erasure removes dialogue, learned vocabulary and semantic derivatives',async t=>{
  const f=fixture(t);f.turn('冷月项目');const raw=f.add('摸摸头');f.r.dialogue.onUser({source_id:raw.source_id});f.r.store.setMeta('feedback-lexicon:'+f.scope,{摸摸头:{meaning:'comfort',source_ref:raw.source_id}});
  f.r.semantic.configure({model:'fixture',embed:async()=>[1,0]});await f.r.semantic.sync({scope:f.scope,force:true,limit:100});f.r.eraseSources([raw.source_id]);
  assert.equal(f.r.dialogue.feedbackList({scope:f.scope}).items.length,0);assert.equal(f.r.store.meta('feedback-lexicon:'+f.scope),null);assert.equal(f.r.store.sql('SELECT count(*) n FROM semantic_chunks WHERE memory_id=?').get(raw.memory_id).n,0);
});
test('console preserves the 4+5+7 structure and separates social activities from technical logs',t=>{
  const f=fixture(t),layout=consoleLayout(f.r);assert.deepEqual(layout.groups.map(g=>g.regions.length),[4,5,7]);f.r.dialogue.activity({scope:f.scope,category:'interaction',title:'回应了用户',at:1000});f.r.dialogue.activity({scope:f.scope,category:'tool',title:'检索资料',at:2000});
  assert.deepEqual(f.r.dialogue.list({scope:f.scope,category:'interaction'}).items.map(x=>x.title),['回应了用户']);const logs=diagnostics(f.r,{scope:f.scope});assert.ok(logs.items.some(x=>x.title==='检索资料'));assert.ok(!logs.items.some(x=>x.title==='回应了用户'));
});
test('derived FTS preserves Chinese candidate selection and important originals survive a soft capacity warning',t=>{
  const f=fixture(t);for(let i=0;i<100;i++)f.add(i===0?'请记住：远海项目口令为蓝鲸。':'普通星空记录'+i);
  const before=f.r.store.search(f.scope,['远海','口令']).map(x=>x.id);f.r.store.rebuildSearchIndex(500);assert.deepEqual(f.r.store.search(f.scope,['远海','口令']).map(x=>x.id),before);
  f.r.config.W5.capacity_mb=0;const raw=f.add('请记住：超过容量预算也不能漏掉重要原话。');assert.equal(f.r.store.getSource(raw.source_id).text,'请记住：超过容量预算也不能漏掉重要原话。');
});
test('an unrelated conversation does not inherit an old project and rare anchors avoid common-word flood',t=>{
  const f=fixture(t);f.add('项目：月潮归航；请记住校准条件。');const preference=f.add('当我疲惫时，以后请简短陪伴。');
  const experience=f.r.store.all(f.scope).find(m=>m.kind==='experience'&&m.source_refs.includes(preference.source_id));assert.equal(experience.attributes.topic,null);
  for(let i=0;i<100;i++)f.add('普通记录也会提到校准条件，但没有特定项目约定'+i);
  f.r.store.rebuildSearchIndex(1000);const result=f.r.query({scope:f.scope,query:'月潮归航的校准条件'});assert.ok(result.context.some(c=>c.text.includes('月潮归航')));assert.ok(!result.context.some(c=>c.text.includes('疲惫')));
});
