import test from 'node:test';
import assert from 'node:assert/strict';
import { V5Runtime } from '../core/v5-runtime.js';
import { bm25Scores,retrievalTokens } from '../core/v5-retrieval.js';
function fixture(t){const r=new V5Runtime({file:':memory:'}),scope=r.addScope({persona_id:'synthetic',scope:'private:100'}).id;t.after(()=>r.close());return {r,scope};}

test('BM25 rewards discriminative terms, saturates repeats and normalizes document length',()=>{
  const corpus=[{id:'accurate',text:'琉璃协议 预算31元'},{id:'long',text:'琉璃协议 '+'日常普通文字。'.repeat(120)},{id:'irrelevant',text:'日常聊天 天气很好'}];
  const scores=bm25Scores('琉璃协议',corpus);assert.ok(scores.get('accurate').score>scores.get('long').score);assert.equal(scores.get('irrelevant').score,0);
  assert.deepEqual(retrievalTokens('ＢＭ２５ Ｃａｆé 琉璃'),['bm25','café','琉璃']);
  const a=bm25Scores('budget',[{id:'x',text:'budget'}]),b=bm25Scores('budget',[{id:'x',text:'budget '.repeat(100)}]);assert.ok(b.get('x').score<a.get('x').score*3);
});
test('fact keys require exact current-scope user evidence, preserve history and support version-checked undo',t=>{
  const {r,scope}=fixture(t),a=r.ingest({scope,text:'琉璃预算上限是30元',occurred_at:1000}),b=r.ingest({scope,text:'琉璃预算改为31元',occurred_at:2000});
  const first=r.writeFact({scope,source_id:a.source_id,quote:'琉璃预算上限是30元',field:'budget.limit',reason:'人工核对'});
  assert.throws(()=>r.writeFact({scope,source_id:b.source_id,quote:'琉璃预算改为31元',field:'budget.limit',reason:'拒绝盲覆盖'}),{code:'REVISION_CONFLICT'});
  const second=r.writeFact({scope,source_id:b.source_id,quote:'琉璃预算改为31元',field:'budget.limit',expected_id:first.memory.id,expected_revision:first.memory.revision,reason:'新原话明确更改'});
  assert.equal(r.memory(first.memory.id).validity,'superseded');assert.equal(r.store.getSource(a.source_id).text,'琉璃预算上限是30元');
  assert.equal(r.factIndex({scope}).items[0].text,'琉璃预算改为31元');
  const recall=r.query({scope,query:'琉璃预算'});assert.ok(recall.context.some(item=>item.text==='琉璃预算改为31元'));assert.ok(recall.context.filter(item=>item.id===a.memory_id).every(item=>item.text.startsWith('历史原话')));
  const restored=r.restoreFact({scope,id:second.memory.id,expected_revision:second.memory.revision,reason:'人工撤回误操作'});assert.equal(restored.memory.body,'琉璃预算上限是30元');
  assert.throws(()=>r.restoreFact({scope,id:second.memory.id,expected_revision:second.memory.revision,reason:'旧版本重放'}));
  r.eraseSources([a.source_id]);assert.equal(r.factIndex({scope}).items.length,0);
});
test('facts never infer a person, accept non-exact paraphrases or replace current values with old or unknown-time observations',t=>{
  const {r,scope}=fixture(t),a=r.ingest({scope,text:'合成新值是31元',occurred_at:2000}),old=r.ingest({scope,text:'合成旧值是30元',occurred_at:1000}),assistant=r.ingest({scope,text:'助手猜测是32元',role:'assistant'});
  const current=r.writeFact({scope,source_id:a.source_id,quote:'合成新值是31元',field:'budget.limit',reason:'已核对'});
  const args={scope,field:'budget.limit',expected_id:current.memory.id,expected_revision:current.memory.revision,reason:'测试非法输入'};
  assert.throws(()=>r.writeFact({...args,source_id:old.source_id,quote:'合成旧值是30元'}));
  assert.throws(()=>r.writeFact({...args,source_id:assistant.source_id,quote:'助手猜测是32元'}));
  assert.throws(()=>r.writeFact({...args,source_id:a.source_id,quote:'不存在的32元'}));
  assert.equal(r.factIndex({scope}).items[0].subject,'local:operator');
});
test('context reports expose composition, omissions and changes without inventing model usage or mixing scopes',t=>{
  const {r,scope}=fixture(t);r.ingest({scope,text:'琉璃协议的合成记录'});r.query({scope,query:'琉璃协议',actual_tokens:0});r.query({scope,query:'琉璃协议'});
  const reports=r.contextReport({scope}).reports;assert.equal(reports.length,2);assert.ok(reports.some(row=>Object.values(row.composition).reduce((a,b)=>a+b,0)>0));
  assert.ok(reports.some(row=>row.omitted.actual_context_budget_insufficient>0));assert.ok(reports.every(row=>row.model_usage===null));
  const other=r.addScope({persona_id:'other',scope:'private:100'}).id;assert.equal(r.contextReport({scope:other}).reports.length,0);
});
