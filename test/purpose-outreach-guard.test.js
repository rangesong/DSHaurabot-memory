import test from 'node:test';
import assert from 'node:assert/strict';
import {purposeWorldContext,purposeWorldRevision,purposeOriginalQuotes,purposeEvidence,reviewPurposeDraft} from '../adapters/aurabot/native/purpose-outreach-guard.js';
const now=Date.parse('2026-11-26T12:00:00+08:00'),cfg={ownerQQ:'1001',persona:{current:'fish'}};
const snapshot=()=>({available:true,scope:{owner:'1001',persona:'fish',fish:'#1234'},sampledAt:now,sharingEnabled:true,current:{fresh:true,observedAt:now-1000,where:'在路上',doing:{name:'步行回家',since:'12:00',until:'12:36',with:['小鱼']},outfit:{name:'卫衣',look:'燕麦色'}},recent:[]});
test('outreach projection preserves bounded activity/null/outfit and only shares the owner scope',()=>{
  const s=snapshot(),use=()=>({outreachSnapshot:()=>s});
  const a=purposeWorldContext(use,cfg,'',now);assert.equal(a.current.doing.name,'步行回家');assert.equal(a.current.outfit.name,'卫衣');
  a.current.doing.name='changed';assert.equal(s.current.doing.name,'步行回家');
  s.current.doing=null;assert.equal(purposeWorldContext(use,cfg,'',now).current.doing,null);
  assert.equal(purposeWorldContext(()=>{throw Error('must not call');},cfg,'2002',now),null);
  assert.equal(purposeWorldContext(use,{...cfg,ownerQQ:'wrong'},'',now),null);
});
test('outreach freshness and revisions distinguish new facts from a timestamp refresh',()=>{
  const s=snapshot(),use=()=>({outreachSnapshot:()=>s}),a=purposeWorldContext(use,cfg,'',now);
  s.current.observedAt=now;const b=purposeWorldContext(use,cfg,'',now);assert.equal(purposeWorldRevision(a),purposeWorldRevision(b));
  s.current.doing.until='13:00';assert.notEqual(purposeWorldRevision(a),purposeWorldRevision(purposeWorldContext(use,cfg,'',now)));
  s.sampledAt=now-180001;assert.equal(purposeWorldContext(use,cfg,'',now),null);
});
test('outreach reviewer does not admit assistant statements or model wishes as factual sources',async()=>{
  const materials=[{id:'user1',kind:'owner',source:'qq',text:'我周一去了图书馆',at:now-86400000},{id:'bot1',kind:'self',source:'qq',text:'我已经登月',at:now},{id:'wish',kind:'thought',source:'memo',text:'我刚坐火箭',provenance:{kind:'model-thought'}}];
  assert.deepEqual(purposeEvidence(materials,now).map(m=>m.id),['user1']);
  let requests=0;
  const verdict=await reviewPurposeDraft({now,text:'想和你聊聊',materials,ask:async o=>{requests++;const packet=JSON.parse(o.text);assert.equal(packet.sources.length,1);assert.equal(o.retryEmpty,false);assert.equal(o.images,undefined);return '{"pass":true,"reason":"无事实预设的陪聊"}';}});
  assert.equal(verdict.pass,true);assert.equal(requests,1);
});
test('review failure, malformed result, missing service and explicit rejection all fail closed',async()=>{
  for(const ask of [undefined,async()=>'{bad}',async()=>'{"pass":"true"}',async()=>{throw Error('offline');},async()=>'{"pass":false}'])assert.equal((await reviewPurposeDraft({ask,text:'我正在床上',now})).pass,false);
  const slow=await reviewPurposeDraft({ask:()=>new Promise(()=>{}),text:'我正在床上',now,timeoutMs:10});assert.equal(slow.pass,false);assert.equal(slow.reason,'review-timeout');
});
test('old automatic memories can be checked against bounded actual owner quotes without importing old assistant stories',()=>{
  let reads=0;const old=now-45*86400000,rows=[{chatId:'private:1001',who:'owner',t:old,text:'上周去过图书馆'},{chatId:'private:1001',who:'bot',t:old+100,text:'我昨天登月了'},{chatId:'private:2002',who:'friend',t:old,text:'别人的事'},{chatId:'private:1001',who:'owner',t:old+200,text:'已遗忘',forgottenAt:now}];
  const result=purposeOriginalQuotes({chatLogOf:()=>{reads++;return rows;}},[{kind:'memory',provenance:{spokenAt:old,chatId:'private:1001',kind:'model-thought'}}],cfg);
  assert.equal(reads,1);assert.deepEqual(result.map(x=>x.text),['上周去过图书馆']);assert.equal(purposeEvidence(result,now)[0].spokenAt,old);
  assert.deepEqual(purposeOriginalQuotes({chatLogOf:()=>{throw Error('foreign scope');}},[{kind:'memory',provenance:{spokenAt:old,chatId:'private:1001'}}],cfg,'2002'),[]);
});
