import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import {V5Runtime} from '../core/v5-runtime.js';
import {DAY} from '../core/v5-config.js';

const start=Date.parse('2026-11-01T01:30:00+08:00');
const longText='开篇沿着河岸慢慢散步，水面上浮着淡淡的晨雾。'.repeat(3)+'中途穿过林间的小径，落叶随着轻风缓缓飘动。'.repeat(3)+'最后坐在岸边休息，看着远处的云层渐渐散开。'.repeat(3);
function fixture(t){
  const root=testRuntimeRoot(null);assert.ok(root,'Use scripts/run-tests.js');
  mkdirSync(root,{recursive:true});const file=join(mkdtempSync(join(root,'retention-idempotence-')),'memory.sqlite');
  let time=start,r=new V5Runtime({file,clock:()=>time});
  r.updateConfig({region:'W5',values:{ordinary_half_life_days:3,recent_hours:72,lossy_after_days:5,forget_after_days:7},expected_version:r.configVersion});
  t.after(()=>r.close());
  return {get r(){return r;},advance(days){time=start+days*DAY;},reopen(){r.close();r=new V5Runtime({file,clock:()=>time});}};
}
const input=(h,text)=>h.r.ingest({text,process:true});
function apply(h,scope){const plan=h.r.retentionPlan({scope});h.r.applyRetention({plan_id:plan.id});return plan;}
const actions=(h,item)=>h.r.retentionPlan({scope:item.scope}).items.filter(i=>i.id===item.memory_id);

test('short ordinary originals settle once, survive restart, and do not grow maintenance events or revisions',t=>{
  const h=fixture(t),text='傍晚沿着河边散步，随后回家休息。',item=input(h,text);
  h.advance(6);const first=apply(h,item.scope);
  assert.equal(first.items.find(i=>i.id===item.memory_id)?.action,'summarize');
  const memory=h.r.memory(item.memory_id);assert.equal(memory.storage,'lossless_cold');assert.equal(memory.layer,'warm');
  assert.equal(h.r.body(memory),text);assert.equal(memory.attributes.lossy_digest.precision,'full');
  const revision=memory.revision,events=h.r.store.eventCount();
  h.reopen();assert.deepEqual(actions(h,item),[]);
  assert.equal(h.r.maintenance().applied,false);assert.equal(h.r.maintenance().applied,false);
  assert.equal(h.r.memory(item.memory_id).revision,revision);assert.equal(h.r.store.eventCount(),events);
  assert.equal(h.r.archive.read({scope:item.scope,level:0}).items.find(i=>i.source_id===item.source_id)?.text,text);
});

test('an ordinary short original already cold before the lossy threshold needs no extra summarization',t=>{
  const h=fixture(t),text='晨间在院子里看花。',item=input(h,text);
  h.advance(4);apply(h,item.scope);assert.equal(h.r.memory(item.memory_id).storage,'lossless_cold');
  assert.equal(h.r.memory(item.memory_id).attributes.lossy_digest,undefined);
  h.advance(6);assert.deepEqual(actions(h,item),[]);assert.equal(h.r.store.getSource(item.source_id).text,text);
});

test('cold long originals still produce a lossy gist while the complete L0 remains byte-exact',t=>{
  const h=fixture(t),item=input(h,longText);h.advance(4);apply(h,item.scope);
  h.advance(6);assert.equal(actions(h,item)[0]?.action,'summarize');apply(h,item.scope);
  assert.equal(h.r.memory(item.memory_id).storage,'gist_with_evidence');assert.equal(h.r.store.getSource(item.source_id).text,longText);
  assert.equal(h.r.archive.read({scope:item.scope,level:0}).items.find(i=>i.source_id===item.source_id)?.text,longText);
  assert.deepEqual(actions(h,item),[]);
});

test('a changed summary ratio re-evaluates a formerly complete cold original',t=>{
  const h=fixture(t),text=longText.split('。').filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).join('。')+'。';
  h.r.updateConfig({region:'W5',values:{summary_ratio:.8},expected_version:h.r.configVersion});
  const item=input(h,text);h.advance(6);apply(h,item.scope);assert.equal(h.r.memory(item.memory_id).storage,'lossless_cold');
  assert.deepEqual(actions(h,item),[]);
  h.r.updateConfig({region:'W5',values:{summary_ratio:.1},expected_version:h.r.configVersion});
  assert.equal(actions(h,item)[0]?.action,'summarize');apply(h,item.scope);
  assert.equal(h.r.memory(item.memory_id).storage,'gist_with_evidence');assert.equal(h.r.store.getSource(item.source_id).text,text);
});

test('an updated source is re-evaluated instead of trusting a stale complete-digest marker',t=>{
  const h=fixture(t),item=input(h,'上午在公园散步。');h.advance(6);apply(h,item.scope);
  h.r.store.updateSourceMetadata(item.source_id,{text:longText});
  assert.equal(actions(h,item)[0]?.action,'summarize');apply(h,item.scope);
  assert.equal(h.r.memory(item.memory_id).storage,'gist_with_evidence');assert.equal(h.r.store.getSource(item.source_id).text,longText);
});

test('short low-value originals still enter traces and later retire with recoverable original copies',t=>{
  const h=fixture(t),item=input(h,'你好');h.advance(4);apply(h,item.scope);
  h.advance(6);assert.equal(actions(h,item)[0]?.action,'summarize');apply(h,item.scope);
  assert.equal(h.r.memory(item.memory_id).layer,'faint');assert.deepEqual(actions(h,item),[]);
  h.advance(20);assert.equal(actions(h,item)[0]?.action,'forget');apply(h,item.scope);
  assert.equal(h.r.memory(item.memory_id).layer,'forgotten');assert.equal(h.r.store.getSource(item.source_id).text,'你好');
  assert.ok(h.r.memory(item.memory_id).attributes.trash_id);
});

test('recent originals, explicit important evidence and unfinished commitments retain their protections',t=>{
  const h=fixture(t),recent=input(h,'今天去河边看风景。'),important=input(h,'请记住：完整保留这条重要边界。'),intent=input(h,'承诺：稍后完成整理。');
  h.advance(2);assert.ok(!actions(h,recent).some(i=>['summarize','forget'].includes(i.action)));
  h.advance(100);const plan=h.r.retentionPlan();
  for(const item of [important,intent])assert.ok(!plan.items.some(i=>i.id===item.memory_id&&['summarize','forget'].includes(i.action)));
  assert.ok(plan.blocked.some(i=>i.reason==='unresolved_intent'));h.r.applyRetention({plan_id:plan.id});
  for(const [item,text] of [[important,'请记住：完整保留这条重要边界。'],[intent,'承诺：稍后完成整理。']])assert.equal(h.r.store.getSource(item.source_id).text,text);
  assert.deepEqual(h.r.governance().health,[]);
});
