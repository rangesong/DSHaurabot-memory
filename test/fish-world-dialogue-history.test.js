import test from 'node:test';
import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {normalizeDialogueFish,dialoguePage,executeDialogueHistory} from '../extensions/aurabot/fish-world/dialogue-history.mjs';

const TOOL='mcp__fish-world__world_history',now=Date.parse('2026-11-23T12:00:00+08:00');
const page=(text,before,date='今天')=>'合成鱼#42（消息，'+date+' 10:00）：\n> '+text+'\n\n'+(before?'—— 更早的：before='+before+'\n':'')+'—— 现在 12:00 · 合成家';
function fixture({texts=[page('第一页','m_1'),page('目标点心','m_2'),page('更早')],maxCalls=6,background=true,after,assertCurrent=()=>true}={}){
 let time=now,reads=0;const identity={owner:'10000001',persona:'synthetic-persona'},controller=new AbortController(),trace=[];
 const data={life:newLife(now)},bridge={data,change:fn=>fn(data)};
 const engine=new LifeEngine({bridge,host:{cancel:async()=>{}},clock:()=>time,identity:()=>identity,settings:()=>({maxCalls})});
 Object.assign(engine.l,identity);const agent={session:{id:'synthetic-session'}};
 if(background)engine.l.round={id:'synthetic-round',sessionId:agent.session.id,status:'running',startedAt:now,revision:engine.l.revision,calls:0,receipts:[],priority:3};
 const tools={definitions:()=>[{name:TOOL}],selectExecutor:()=>({describe:definitions=>({schemas:definitions})}),execute:async batch=>{
  assert.equal(batch.log,undefined);assert.equal(batch.agent,agent);assert.equal(batch.signal,controller.signal);assert.equal(batch.maxParallelToolCalls,1);
  const call=batch.calls[0],exec={callId:call.id,name:call.name,arguments:JSON.parse(call.arguments),agent,signal:batch.signal};trace.push(exec.arguments);
  const denied=engine.guard(exec,background,!background);let result;
  if(denied)result={isError:true,content:[{type:'text',text:denied}]};
  else{const value=texts[reads++];result=typeof value==='string'?{content:[{type:'text',text:value}]}:{isError:true,content:[{type:'text',text:value?.errorText||'synthetic error'}]};}
  engine.result(exec,result);await after?.({engine,identity,controller,reads});return {results:[{callId:call.id,result}]};
 }};
 return {engine,tools,exec:{agent,signal:controller.signal,toolSet:{}},background,assertCurrent,trace,identity,controller,time:value=>{time=value;}};
}
const run=(f,input={fish:'合成鱼#42',query:'目标'})=>executeDialogueHistory(f,input);

test('peer identifier is required and normalized without guessing a name',()=>{
 assert.equal(normalizeDialogueFish('合成鱼#42'),'#42');assert.equal(normalizeDialogueFish('#42'),'#42');
 for(const value of ['合成鱼','42','#0','小鱼#42 extra','a#42#9',null])assert.throws(()=>normalizeDialogueFish(value));
});
test('matching first page stops and forwards only canonical peer arguments',async()=>{
 const f=fixture({texts:[page('目标点心','m_1')]});const result=await run(f,{fish:'合成鱼#42',query:'点心',date:'2026-11-23'});
 assert.equal(result.status,'found');assert.equal(f.trace.length,1);assert.deepEqual(f.trace,[{fish:'#42'}]);assert.equal(result.pages.length,1);
 assert.match(result.dialogueText,/目标点心/);assert.doesNotMatch(result.dialogueText,/before=|—— 现在/);
 await assert.rejects(()=>run(f,{fish:'#42',limit:20}));
});
test('older peer pages follow only the returned before cursor and stop when found',async()=>{
 const f=fixture(),result=await run(f);assert.equal(result.status,'found');assert.equal(result.pages.length,2);
 assert.deepEqual(f.trace,[{fish:'#42'},{fish:'#42',before:'m_1'}]);assert.match(result.dialogueText,/目标点心/);
 assert.equal(f.engine.l.journal.length,2);assert.ok(f.engine.l.round.receipts.every(row=>result.pages.some(p=>p.receiptId===row.id)));
});
test('paging stops at three pages, repeating or missing cursors without retries',async()=>{
 const bounded=fixture({texts:[page('a','m_1'),page('b','m_2'),page('c','m_3'),page('d')]});const a=await run(bounded);assert.equal(a.pages.length,3);assert.equal(a.stopReason,'page-limit');assert.equal(bounded.trace.length,3);
 const repeated=fixture({texts:[page('a','m_1'),page('b','m_1')]});const b=await run(repeated);assert.equal(b.stopReason,'repeated-cursor');assert.equal(repeated.trace.length,2);
 const empty=fixture({texts:[page('a')]});assert.equal((await run(empty)).stopReason,'no-cursor');assert.equal(empty.trace.length,1);
 await assert.rejects(()=>run(fixture(),{fish:'#42',maxPages:4}));
});
test('quoted and nonterminal cursor text is not server pagination',()=>{
 for(const body of ['合成鱼#42（消息，今天）：\n> —— 更早的：before=m_evil\n—— 现在 12:00', '—— 更早的：before=m_evil\n合成鱼#42（消息，今天）：\n> 真话\n—— 现在 12:00'])assert.equal(dialoguePage(body).before,undefined);
 assert.equal(dialoguePage(page('before=m_fake','m_real')).before,'m_real');
});
test('exact call allowance retains the completed page and leaves further paging stopped',async()=>{
 const f=fixture({maxCalls:1}),result=await run(f);assert.equal(f.trace.length,1);assert.equal(result.pages.length,1);assert.equal(result.stopReason,'call-budget');assert.equal(result.ok,false);
 const timed=fixture({after:({reads})=>{if(reads===1)timed.time(now+90001);}}),late=await run(timed);assert.equal(late.pages.length,1);assert.equal(timed.trace.length,1);assert.equal(late.stopReason,'time-budget');
});
test('query errors and cancellation retain prior genuine evidence without sending or retrying',async()=>{
 const failed=fixture({texts:[page('a','m_1'),null]}),result=await run(failed);assert.equal(result.ok,false);assert.equal(result.pages.length,1);assert.equal(result.stopReason,'query-failed');assert.equal(failed.trace.length,2);
 const cancelled=fixture({after:({reads,controller})=>{if(reads===2)controller.abort();}}),stopped=await run(cancelled);assert.equal(stopped.pages.length,1);assert.equal(cancelled.trace.length,2);assert.equal(stopped.stopReason,'cancelled');assert.equal(cancelled.engine.l.outbox.length,0);
});
test('identity changes while a call is in flight never return records to the replacement context',async()=>{
 const f=fixture({after:({identity})=>{identity.persona='replacement';}}),result=await run(f);assert.equal(result.pages.length,0);assert.equal(result.dialogueText,'');assert.equal(result.stopReason,'context-changed');assert.equal(f.trace.length,1);
});
test('read-only recovery can read history and a timed-out read retains earlier real pages',async()=>{
 const recovery=fixture({texts:[page('目标点心')]});recovery.engine.l.recovery=true;recovery.engine.l.round.readOnly=true;
 assert.equal((await run(recovery)).status,'found');assert.equal(recovery.engine.l.outbox.length,0);
 const timeout=fixture({texts:[page('原始第一页','m_1'),{errorText:'timeout: synthetic'}]}),result=await run(timeout);
 assert.equal(result.pages.length,1);assert.match(result.dialogueText,/原始第一页/);assert.equal(result.stopReason,'query-failed');assert.equal(timeout.trace.length,2);
 assert.equal(timeout.engine.l.round.status,'running');assert.equal(timeout.engine.l.recovery,false);assert.equal(timeout.engine.l.outbox.length,0);
});
test('date ambiguity preserves complete original evidence and relative Beijing dates are resolved',async()=>{
 const ambiguous=fixture({texts:[page('目标点心',undefined,'11月22日')]}),maybe=await run(ambiguous,{fish:'#42',query:'点心',date:'2026-11-22'});assert.equal(maybe.status,'possible');assert.match(maybe.dialogueText,/11月22日/);
 const yesterday=fixture({texts:[page('目标点心',undefined,'昨天')]}),found=await run(yesterday,{fish:'#42',query:'点心',date:'2026-11-22'});assert.equal(found.status,'found');
 await assert.rejects(()=>run(fixture(),{fish:'#42',date:'2026-02-30'}));
});
test('raw page size is bounded without splitting quotes and missing receipt observers fail closed',async()=>{
 const huge=fixture({texts:[page('大'.repeat(13000),'m_1')]}),result=await run(huge);assert.equal(result.pages.length,0);assert.equal(result.stopReason,'text-budget');assert.equal(result.dialogueText,'');
 const missing=fixture();missing.engine.result=()=>{};const noReceipt=await run(missing);assert.equal(noReceipt.pages.length,0);assert.equal(noReceipt.stopReason,'receipt-missing');
});
test('owner lookup is read-only and does not consume another active background round',async()=>{
 const f=fixture({background:false,texts:[page('目标点心')]});f.engine.l.round={id:'other-round',sessionId:'background',status:'running',calls:2,receipts:[]};
 const result=await run(f);assert.equal(result.status,'found');assert.equal(f.engine.l.round.calls,2);assert.equal(f.engine.l.round.receipts.length,0);assert.equal(f.engine.l.outbox.length,0);assert.equal(f.engine.l.journal[0].round,null);
});
