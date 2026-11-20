import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {V5Runtime} from '../core/v5-runtime.js';import {testRuntimeRoot,writeTestResult} from '../scripts/lib/test-workspace.js';
import {startThinkstar} from '../adapters/aurabot/module/lib/host-bridge.js';
import {implicitHostScenario} from './helpers/implicit-host-scenario.js';
const DAY=86400000;
test('actual host request, completed receipt, unrelated topic and pause follow the matured rule through the adapter',async()=>{
 const result=await implicitHostScenario({V5Runtime,startThinkstar,scratch:testRuntimeRoot(null)});writeTestResult(result);
});
function fixture(t,{file=':memory:',group=false}={}){
 let now=Date.parse('2026-11-15T02:00:00+08:00'),n=0;const r=new V5Runtime({file,clock:()=>now}),scope=r.addScope({persona_id:'maturation',scope:group?'group:300':'private:100'}).id;
 t.after(()=>r.close());
 const add=(text,role='user')=>r.ingest({scope,text,role,occurred_at:now,source_id:'synthetic:'+ ++n,command_id:'synthetic:'+n,provenance:{speaker_id:role==='user'?'100':'bot'},process:true});
 let latest;
 const turn=(query='今天有点累',reply='我在这里，慢慢来。',controls=null)=>{const input=add(query),q=r.query({scope,query});q.host_context_ids=q.context.map(x=>x.id);q.dialogue_strategy=r.dialogue.strategy(scope,query);if(controls)Object.assign(q.dialogue_strategy.controls,controls);r.dialogue.prepared(q,{sessionId:'s',chatId:group?'group:300':'private:100',input_source_ids:[input.source_id]});now+=1000;const out=add(reply,'assistant');r.dialogue.observeReply({scope,text:reply,source_id:out.source_id,turn_id:q.id,session_id:'s',message_id:'reply:'+q.id,stage:'observed_host_activity'});now+=1000;latest=q;return q;};
 const react=text=>r.dialogue.onUser({source_id:add(text).source_id,reply_to:group?'reply:'+latest.id:null});
 const review=async(row,meaning='affection')=>r.dialogue.reflect({model:'synthetic-context-review',status:()=>({configured:true}),json:async()=>({value:{items:[{id:row.id,is_feedback:true,meaning,reason:'合成上下文复核'}]}})},{force:true});
 const train=async({reviewed=true,days=true,meaning='affection',text='摸摸头',controls=null}={})=>{const rows=[];for(let i=0;i<3;i++){turn(undefined,undefined,controls);const row=react(text);rows.push(row);if(reviewed)await review(row,meaning);now+=days?DAY:60000;}return rows;};
 const learned=()=>r.store.all(scope).find(m=>m.attributes.dialogue_learning);
 return {r,scope,add,turn,react,review,train,learned,advance:ms=>now+=ms,now:()=>now,setNow:at=>now=at};
}

test('reviewed independent feedback matures the same canonical pattern at night and influences matching reply controls',async t=>{
 const f=fixture(t);await f.train();const sources=f.r.store.stats().sources,result=f.r.dialogue.consolidate(),m=f.learned();
 assert.equal(result.maturation.promoted,1);assert.equal(m.layer,'implicit');assert.equal(m.attributes.central_rule.validation.phase,'trial');assert.equal(m.evidence.truth,'conditional_hypothesis');assert.equal(f.r.store.stats().sources,sources,'maturation must not invent manual feedback');
 const same=f.r.dialogue.strategy(f.scope,'我有些疲惫'),other=f.r.dialogue.strategy(f.scope,'介绍一下编译器');
 assert.ok(same.controls.style_accommodation>f.r.config.W4.style_accommodation);assert.ok(same.rule_ids.includes(m.id));assert.match(same.text,/条件表达准则/);assert.equal(other.controls.style_accommodation,f.r.config.W4.style_accommodation);assert.ok(!other.rule_ids.includes(m.id));
 assert.equal(f.r.dialogue.consolidate().maturation.promoted,0);assert.equal(f.r.store.all(f.scope).filter(x=>x.id===m.id).length,1);assert.ok(f.r.graph({scope:f.scope}).nodes.some(x=>x.id===m.id&&x.central_rule_region==='W4'));
 const another=f.r.addScope({persona_id:'other',scope:'private:100'}).id;assert.equal(f.r.dialogue.strategy(another,'我有些疲惫').rule_ids.length,0);
 writeTestResult({scenario:'implicit-maturation',same_context_rule_ids:same.rule_ids.length,before_style:f.r.config.W4.style_accommodation,after_style:same.controls.style_accommodation,unrelated_style:other.controls.style_accommodation,model_calls_for_maturation:0,qq_sends:0});
});

test('unreviewed ambiguity, same-day bursts, disabled settings and daytime never bypass maturity gates',async t=>{
 const a=fixture(t);await a.train({reviewed:false});a.r.dialogue.consolidate();assert.equal(a.learned().layer,'mature');assert.equal(a.r.implicitLearning.assess(a.learned()).independent,0);
 const b=fixture(t);await b.train({days:false});b.r.dialogue.consolidate();assert.equal(b.learned().layer,'mature');assert.equal(b.r.implicitLearning.assess(b.learned()).days,1);
 const c=fixture(t);await c.train();c.setNow(Date.parse('2026-11-18T12:00:00+08:00'));c.r.dialogue.consolidate();assert.equal(c.learned().layer,'mature');c.r.config.W3.auto_implicit_enabled=0;assert.equal(c.r.implicitLearning.mature().promoted,0);
});

test('pause and revoke immediately stop the rule and its duplicate feedback path; night learning cannot revive it',async t=>{
 const f=fixture(t);await f.train();f.r.dialogue.consolidate();let m=f.learned();
 f.r.writeCentralRule({scope:f.scope,id:m.id,expected_revision:m.revision,action:'pause',reason:'合成暂停'});
 let s=f.r.dialogue.strategy(f.scope,'今天有点累');assert.equal(s.controls.style_accommodation,f.r.config.W4.style_accommodation);assert.ok(!s.rule_ids.includes(m.id));
 assert.ok(!f.r.query({scope:f.scope,query:'今天有点累'}).context.some(x=>x.id===m.id),'paused rule must not re-enter through the ordinary evidence pack');
 await f.train();f.r.dialogue.consolidate();m=f.learned();assert.equal(m.attributes.central_rule.status,'paused');assert.equal(m.layer,'mature');
 f.r.writeCentralRule({scope:f.scope,id:m.id,expected_revision:m.revision,action:'revoke',reason:'合成撤回'});f.r.dialogue.consolidate();assert.equal(f.learned().attributes.central_rule.status,'revoked');
});

test('post-activation independent feedback validates expression only, with discovery and duplicate turns excluded',async t=>{
 const f=fixture(t);const discoveries=await f.train();f.r.dialogue.consolidate();const m=f.learned();
 const old=f.r.dialogue.get('dialogue_feedback',discoveries[0].id);f.r.implicitLearning.observe(old,f.r.dialogue.get('dialogue_turns',old.turn_id));assert.equal(f.learned().attributes.central_rule.validation.outcomes.length,0);
 for(let i=0;i<3;i++){const turn=f.turn(),row=f.react('这样就好，很有帮助');f.r.implicitLearning.observe(row,f.r.dialogue.get('dialogue_turns',turn.id));f.advance(60000);}
 const current=f.learned();assert.equal(current.attributes.central_rule.validation.outcomes.length,3);assert.equal(current.attributes.central_rule.validation.phase,'verified');assert.equal(current.evidence.truth,'conditional_hypothesis');
 assert.equal(f.r.centralRules({scope:f.scope}).items.find(x=>x.id===m.id).effective,true);
});

test('a real counterexample or reinterpreted discovery stops automatic influence without erasing original speech',async t=>{
 const a=fixture(t);await a.train();a.r.dialogue.consolidate();const before=a.r.store.stats().sources;a.turn();a.react('不满意，你没听懂');assert.equal(a.learned().attributes.central_rule.status,'paused');assert.equal(a.r.resolveRules(a.scope,'疲惫').length,0);assert.ok(a.r.store.stats().sources>before);
 const b=fixture(t),ids=await b.train();b.r.dialogue.consolidate();b.r.dialogue.correct({scope:b.scope,id:ids[0].id,meaning:'play',reason:'这是玩笑'});assert.equal(b.learned().layer,'mature');assert.equal(b.r.resolveRules(b.scope,'疲惫').length,0);assert.equal(b.r.store.getSource(ids[0].source_ref).text,'摸摸头');
});

test('source permission, source erasure, current parameters and zero learning amplitude disable the influence',async t=>{
 const a=fixture(t);await a.train();a.r.dialogue.consolidate();assert.equal(a.r.dialogue.strategy(a.scope,'疲惫',{source_filter:()=>false}).rule_ids.length,0);assert.equal(a.learned().attributes.central_rule.status,'paused');
 const b=fixture(t),rows=await b.train();b.r.dialogue.consolidate();b.r.eraseSources([rows[0].source_ref]);assert.equal(b.r.resolveRules(b.scope,'疲惫').length,0);
 const c=fixture(t);await c.train();c.r.dialogue.consolidate();c.r.updateConfig({region:'W4',values:{style_accommodation:.2},expected_version:c.r.configVersion});assert.equal(c.r.dialogue.strategy(c.scope,'疲惫').controls.style_accommodation,.2);
 const d=fixture(t);await d.train();d.r.config.W3.learning_step_cap=0;d.r.dialogue.consolidate();assert.equal(d.learned().layer,'mature');
});

test('explicit current requests override automatic brevity and preference promotion also supports clear corrections',async t=>{
 const f=fixture(t);await f.train({reviewed:false,text:'这样就好，很有帮助',controls:{detail_level:.2}});f.r.dialogue.consolidate();assert.equal(f.learned().layer,'implicit');assert.ok(f.r.dialogue.strategy(f.scope,'我疲惫了，但请详细分析').controls.detail_level>=.8);
 const negative=fixture(t);await negative.train({reviewed:false,text:'太啰嗦，说太多了',controls:{detail_level:.5}});negative.r.dialogue.consolidate();assert.equal(negative.learned().layer,'implicit');assert.ok(negative.r.dialogue.strategy(negative.scope,'疲惫了').controls.detail_level<.5);
});

test('expired ordinary group evidence and factual confirmations never become automatic expression rules',async t=>{
 const f=fixture(t,{group:true});f.r.updateConfig({region:'W5',values:{group_policy_enabled:1},expected_version:f.r.configVersion});await f.train();f.advance(5*DAY);f.r.dialogue.consolidate();assert.equal(f.r.store.all(f.scope).filter(m=>m.layer==='implicit').length,0);
 const g=fixture(t);for(let i=0;i<4;i++){g.turn('合成事实核对','你说的是蓝色草图，是这张吧');g.react('对');g.advance(DAY);}g.r.dialogue.consolidate();assert.equal(g.r.store.all(g.scope).filter(m=>m.layer==='implicit').length,0);
});

test('maturation and pause persist after restart without a new model call or duplicate canonical object',async t=>{
 const folder=fs.mkdtempSync(path.join(testRuntimeRoot(null),'implicit-persist-')),file=path.join(folder,'synthetic.sqlite');
 const f=fixture(t,{file});await f.train();f.r.dialogue.consolidate();const id=f.learned().id,now=f.now();f.r.close=(()=>{const close=f.r.close.bind(f.r);let closed=false;return()=>{if(!closed){closed=true;close();}};})();f.r.close();
 const r=new V5Runtime({file,clock:()=>now});try{assert.equal(r.memory(id).layer,'implicit');assert.ok(r.dialogue.strategy(f.scope,'疲惫').rule_ids.includes(id));const m=r.memory(id);r.writeCentralRule({scope:f.scope,id,expected_revision:m.revision,action:'pause',reason:'重启后暂停'});}finally{r.close();}
 const again=new V5Runtime({file,clock:()=>now});try{assert.equal(again.memory(id).attributes.central_rule.status,'paused');assert.equal(again.implicitLearning.mature().promoted,0);}finally{again.close();}
});
