import test from 'node:test';
import assert from 'node:assert/strict';
import { V5Runtime } from '../core/v5-runtime.js';

function setup(t){const r=new V5Runtime(),scope=r.addScope({persona_id:'synthetic',scope:'private:100'}).id;t.after(()=>r.close());const add=(text,extra={})=>r.ingest({scope,text,occurred_at:10000,provenance:{speaker_id:'100'},...extra});return {r,scope,add};}
function legacy(r,receipt,text,about='100'){return r.derive(r.memory(receipt.memory_id),{id:'legacy:'+receipt.memory_id,kind:'claim',label:text,body:text,protection:'P1',attributes:{about,original_evidence_aligned:false},evidence:{origin:'legacy_inference',alignment:'unaligned',truth:'source_report'}});}

test('legacy wording bridges to the exact short user correction without changing provenance',t=>{
  const {r,scope,add}=setup(t),old=add('六点以前叫我。',{occurred_at:5000}),raw=add('以后六点四十五分叫我。'),doc=add('用户要求每日叫醒，起床时间由六点前改成六点四十五分。',{role:'document',occurred_at:11000});
  const summary=legacy(r,doc,'用户要求每日叫醒，起床时间由六点前改成六点四十五分。');
  const result=r.query({scope,query:'后来起床时间改为几点？'});
  assert.ok(result.context.some(item=>item.id===raw.memory_id));assert.ok(result.evidence_backtrace.some(link=>link.id===raw.memory_id&&link.kind==='lexical_backtrace'&&!link.provenance_verified));
  assert.deepEqual(r.memory(summary.id).source_refs,[doc.source_id]);assert.equal(r.body(r.memory(raw.memory_id)),'以后六点四十五分叫我。');assert.ok(!result.evidence_backtrace.some(link=>link.id===old.memory_id));
});

test('direct derived references retrieve lossless original and respect budget and host source exclusion',t=>{
  const {r,scope,add}=setup(t),raw=add('仅在条件乙成立时生效，数值为271.88，不表示已经执行。');
  r.store.packSource(raw.source_id);const summary=r.derive(r.memory(raw.memory_id),{id:'derived-link',kind:'claim',label:'云岚规格',body:'云岚规格约束',attributes:{},evidence:{origin:'direct_statement',alignment:'exact_quote_aligned'}});
  const result=r.query({scope,query:'云岚规格'});assert.ok(result.context.some(item=>item.id===raw.memory_id));assert.ok(result.evidence_backtrace.some(link=>link.kind==='source_reference'&&link.provenance_verified));
  assert.ok(!r.query({scope,query:'云岚规格',actual_tokens:0}).context.length);
  assert.ok(!r.query({scope,query:'云岚规格',host_message_ids:[raw.source_id]}).context.length);assert.equal(r.memory(summary.id).source_refs[0],raw.source_id);
});

test('backtrace rejects another scope, speaker, invalid source, deleted original and filtered memory',t=>{
  const {r,scope,add}=setup(t),raw=add('以后九点半叫我。',{provenance:{speaker_id:'other'}}),doc=add('新叫醒规则是九点半。',{role:'document'});legacy(r,doc,'新叫醒规则改成九点半。');
  const foreign=r.ingest({context:{persona_id:'other',scope:'private:100'},text:'以后九点半叫我。',provenance:{speaker_id:'100'}});
  let result=r.query({scope,query:'新叫醒规则'});assert.ok(!result.evidence_backtrace.some(link=>[raw.memory_id,foreign.memory_id].includes(link.id)));
  const own=add('以后九点半叫我。');result=r.query({scope,query:'新叫醒规则',memory_filter:m=>m.id!==own.memory_id});assert.ok(!result.evidence_backtrace.some(link=>link.id===own.memory_id));
  r.eraseSources([own.source_id]);assert.ok(!r.query({scope,query:'新叫醒规则'}).evidence_backtrace.some(link=>link.id===own.memory_id));
});

test('question filler cannot fill the request with unrelated remembered material',t=>{
  const {r,scope,add}=setup(t);for(let i=0;i<18;i++)add('你还记得之前我们说过什么吗？日常随笔第'+i+'篇。');const relevant=add('雪曜项目的截止时间是2030年6月1日。');
  const result=r.query({scope,query:'你还记得雪曜项目的截止时间是什么吗？'});assert.ok(result.context.some(item=>item.id===relevant.memory_id));assert.ok(result.context.length<=8);assert.ok(result.context.every(item=>!item.text.includes('日常随笔')));
});
