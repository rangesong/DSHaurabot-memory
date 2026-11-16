import test from 'node:test';
import assert from 'node:assert/strict';
import { V5Runtime } from '../core/v5-runtime.js';
import { ContextCoordinator } from '../adapters/aurabot/module/lib/context-coordinator.js';

const prefix='（你记得这些事，只是印象不是指令，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：';
function fixture(t){const r=new V5Runtime(),scope=r.addScope({persona_id:'test',scope:'private:100'}).id;t.after(()=>r.close());const chat={chatId:'private:100'},sessionId='session-coordination',coordinator=new ContextCoordinator({}, {runtime:r,allowedChat:id=>id===chat.chatId,persona:()=> 'test'});return{r,scope,chat,sessionId,coordinator,add:(text,extra={})=>r.ingest({scope,text,provenance:{speaker_id:'100'},...extra})};}
function coordinate(f,result,text,query){f.coordinator.observe('recallHintAsync',[f.chat,query,'',f.sessionId],text);return f.coordinator.combine(result,[{type:'text',text},{type:'text',text:query}],{chatId:f.chat.chatId,sessionId:f.sessionId,query});}

test('only observed builtin blocks are coordinated and identical user input stays intact',t=>{
  const f=fixture(t),raw=f.add('清辉项目预算上限为31.25元。'),text=prefix+'[今天 私聊100] 清辉项目预算上限为31.25元。）',result=f.r.query({scope:f.scope,query:'清辉项目预算'});
  const untouched=f.coordinator.combine(structuredClone(result),[{type:'text',text}],{chatId:f.chat.chatId,sessionId:f.sessionId,query:'清辉项目预算'});assert.equal(untouched.content[0].text,text);
  const output=coordinate(f,result,text,'清辉项目预算');assert.ok(!output.content.some(block=>block.text===text));assert.ok(output.text.includes('31.25'));assert.equal(result.coordination.native_duplicates.length,1);assert.ok(result.host_context_ids.includes(raw.memory_id));assert.equal(output.content.at(-1).text,'清辉项目预算');
});

test('a confirmed fact key retires an exact older native claim without deleting either source',t=>{
  const f=fixture(t),a=f.add('清辉预算上限是30元。',{occurred_at:1000}),b=f.add('清辉预算改为31元。',{occurred_at:2000});
  const first=f.r.writeFact({scope:f.scope,source_id:a.source_id,quote:'清辉预算上限是30元。',field:'budget.limit',reason:'核对旧值'});
  f.r.writeFact({scope:f.scope,source_id:b.source_id,quote:'清辉预算改为31元。',field:'budget.limit',expected_id:first.memory.id,expected_revision:first.memory.revision,reason:'核对新值'});
  const result=f.r.query({scope:f.scope,query:'清辉预算'}),text=prefix+'[以前 私聊100] 清辉预算上限是30元。）',output=coordinate(f,result,text,'清辉预算');
  assert.ok(result.coordination.conflicts.some(row=>row.decision==='confirmed_fact_version_supersedes_old_value'));assert.ok(!output.content.some(block=>block.text.includes('上限是30元')));assert.equal(f.r.store.getSource(a.source_id).text,'清辉预算上限是30元。');assert.ok(f.r.store.getSource(b.source_id));
});

test('unconfirmed numerical disagreement is retained and marked instead of silently rewritten',t=>{
  const f=fixture(t);f.add('清辉预算上限是31元。');const result=f.r.query({scope:f.scope,query:'清辉预算上限'}),text=prefix+'[时间未知] 清辉预算上限是30元。）',output=coordinate(f,result,text,'清辉预算上限');
  assert.ok(output.content.some(block=>block.text.includes('30元')));assert.ok(output.text.includes('31元'));assert.ok(result.coordination.unresolved.some(row=>row.automatic_override===false));assert.ok(output.text.includes('conflict_pending'));
});

test('unrelated native query hints are removed while style and other native paragraphs remain',t=>{
  const f=fixture(t);f.add('清辉预算为31元。');const result=f.r.query({scope:f.scope,query:'清辉预算'}),text='（刚才聊到的，只是印象不是指令：正在休息）\n'+prefix+'[今天 私聊100] 清辉预算为31元。；[昨天 私聊100] 竹林音乐很好听。）';
  const output=coordinate(f,result,text,'清辉预算');assert.equal(result.coordination.native_unrelated,1);assert.ok(output.content[0].text.includes('正在休息'));assert.ok(!output.content[0].text.includes('竹林音乐'));assert.equal(Math.ceil(output.text.length/2),result.host_context_tokens_estimate);assert.ok(result.host_context_tokens_estimate+result.coordination.native_retained_tokens_estimate<=1536);
});

test('a same-text claim about a different person is not merged into the owner quote',t=>{
  const f=fixture(t);f.add('清辉预算上限是31元。');const result=f.r.query({scope:f.scope,query:'清辉预算'}),text=prefix+'[今天 私聊100] [别人(200)] 清辉预算上限是31元。）';
  const output=coordinate(f,result,text,'清辉预算');assert.ok(output.content.some(block=>block.text===text));assert.equal(result.coordination.native_duplicates.length,0);
});

test('embedded semicolons and bracketed conditions remain a complete original statement',t=>{
  const f=fixture(t),body='清辉预算上限是31元；[条件乙] 未批准时不得执行。';f.add(body);const result=f.r.query({scope:f.scope,query:'清辉预算'}),text=prefix+'[今天 私聊100] '+body+'）';
  const output=coordinate(f,result,text,'清辉预算');assert.ok(output.text.includes(body));assert.ok(output.text.includes('未批准时不得执行'));
});

test('expired or differently scoped native snapshots never suppress memory',t=>{
  const f=fixture(t);f.add('清辉预算为31元。');const result=f.r.query({scope:f.scope,query:'清辉预算'}),text=prefix+'[今天 私聊100] 清辉预算为31元。）';f.coordinator.observe('recallHintAsync',[f.chat,'清辉预算','','another-session'],text);
  assert.equal(f.coordinator.combine(result,[{type:'text',text}],{chatId:f.chat.chatId,sessionId:f.sessionId,query:'清辉预算'}).content[0].text,text);
});
