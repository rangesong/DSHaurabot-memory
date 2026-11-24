import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {previewShareEvidence,claimShareEvidence,reconcileShareEvidence} from '../extensions/aurabot/fish-world/share-evidence.mjs';

const now=Date.parse('2026-11-24T12:00:00+08:00'),ttl=30*60000;
const fishId='synthetic-fish',identity={owner:'synthetic-owner',persona:'synthetic-persona'};
const tool=name=>'mcp__fish-world__world_'+name;

function fixture({notify=true}={}){
  const life={...newLife(now),...identity,sharingPolicy:{version:1,sharing:true,settingsSharing:true,initializedAt:now,changedAt:now}};
  const round={id:'round-a',sessionId:'session-a',status:'running',kind:'idle',readOnly:false,events:[],planIds:[],startedAt:now-60000,bucket:'idle',observation:'合成当前现场',receipts:[]};
  const report={events:[],planChanges:[],importance:'important',summary:'合成本地总结',facts:[],share:'合成新生活消息'};
  const f={life,round,report,fishId,now};
  call(f,'now','now',{});
  if(notify)notification(f);
  return f;
}
function call(f,id,name,args={},extra={}){
  const receipt={id,tool:tool(name),text:'合成成功回执 '+id,isError:false};
  const record={id,tool:receipt.tool,round:f.round.id,sessionId:f.round.sessionId,status:'confirmed',args:JSON.stringify(args),at:f.round.startedAt+1000,finishedAt:f.now-1000,result:receipt.text,isError:false,...extra};
  f.round.receipts.push(receipt);f.life.journal.push(record);f.report.facts.push(id);
  return {receipt,record};
}
function notification(f,id='event-a',extra={}){
  const q={id,kind:'done',t:f.now-120000,text:'合成生活事项完成',receivedAt:f.now-90000,status:'running',lastRoundId:f.round.id,provenance:{trusted:true,source:'world-notify'},...extra};
  f.life.queue.push(q);f.round.events.push(id);f.report.events.push({id,status:'completed'});return q;
}
const options=f=>({fishId:f.fishId,round:f.round,report:f.report,now:f.now});
const preview=f=>previewShareEvidence(f.life,options(f));
function commit(f,state='pending'){
  const proof=claimShareEvidence(f.life,options(f));
  if(proof.allowed)f.life.outbox.push({id:f.round.id,at:f.now,state,importance:'important',text:f.report.share,facts:[...f.report.facts],...identity,evidenceVersion:1,keys:proof.keys,sourceRefs:proof.sourceRefs,shareFacts:proof.shareFacts,shareEventIds:proof.shareEventIds});
  return proof;
}
function nextRound(f){
  f.round={...f.round,id:'round-b',sessionId:'session-b',receipts:f.round.receipts.map(x=>({...x}))};
  f.report=structuredClone(f.report);
  for(const q of f.life.queue)q.lastRoundId=f.round.id;
  return f;
}

test('fresh trusted done can be shared from its current observation without inventing a mutation',()=>{
  const f=fixture(),before=structuredClone(f);
  const proof=preview(f);
  assert.equal(proof.allowed,true);assert.equal(proof.keys.length,1);assert.match(proof.keys[0],/^[a-f0-9]{64}$/);
  assert.deepEqual(proof.shareFacts,['now']);assert.deepEqual(proof.shareEventIds,['event-a']);
  assert.deepEqual(f,before,'preview must not claim, rewrite the queue, or modify the report');
});

test('notification time may precede the round, but its original age has a strict thirty-minute boundary',()=>{
  for(const [age,allowed]of [[ttl-1,true],[ttl,false],[ttl+1,false]]){
    const f=fixture();f.life.queue[0].t=now-age;f.life.queue[0].receivedAt=now;
    assert.equal(preview(f).allowed,allowed,'original age '+age);
  }
});

test('new receive time and current round metadata cannot refresh invalid original event timestamps',()=>{
  for(const t of [now+1,0,undefined,null,NaN,Infinity,String(now)]){
    const f=fixture();Object.assign(f.life.queue[0],{t,receivedAt:now,lastRoundId:f.round.id});
    assert.equal(preview(f).allowed,false,'invalid original timestamp '+String(t));
  }
});

test('untrusted notifications and owner-generated controls are not new world events',()=>{
  for(const provenance of [{trusted:false,source:'world-notify'},{trusted:true,source:'owner-control'},undefined]){
    const f=fixture();f.life.queue[0].provenance=provenance;assert.equal(preview(f).allowed,false);
  }
  for(const kind of ['owner','idle','plan','recovery','inspection']){
    const f=fixture();f.life.queue[0].kind=kind;assert.equal(preview(f).allowed,false,kind);
  }
});

test('a plan source reference cannot substitute for an event actually processed by this round',()=>{
  const f=fixture();f.round.sourceEventIds=['event-a'];f.round.events=[];
  f.life.plans.push({id:'synthetic-plan',sourceEventIds:['event-a']});
  assert.equal(preview(f).allowed,false);
});

test('current processing requires the queue record, round identity, and a completed disposition together',()=>{
  for(const mutate of [f=>{f.life.queue=[];},f=>{f.life.queue[0].lastRoundId='other-round';},f=>{f.report.events=[];},f=>{f.report.events[0].status='blocked';},f=>{f.report.events[0].status='expired';}]){
    const f=fixture();mutate(f);assert.equal(preview(f).allowed,false);
  }
});

test('multiple fresh notifications require explicit selection instead of guessing a business event',()=>{
  const f=fixture();notification(f,'event-b',{kind:'arrive'});
  assert.equal(preview(f).allowed,false);
  f.report.shareEventIds=['event-b'];const proof=preview(f);
  assert.equal(proof.allowed,true);assert.deepEqual(proof.shareEventIds,['event-b']);assert.equal(proof.keys.length,1);
});

test('explicit empty or foreign event selection is never replaced by the implicit single candidate',()=>{
  for(const ids of [[],['missing'],['event-a','missing']]){
    const f=fixture();f.report.shareEventIds=ids;assert.equal(preview(f).allowed,false);
  }
});

test('a selected stale notification cannot be laundered by an unrelated fresh notification',()=>{
  const f=fixture();notification(f,'old-event',{t:now-ttl});f.report.shareEventIds=['event-a','old-event'];
  assert.equal(preview(f).allowed,false);
});

test('now plus old history alone remains a local planning record',()=>{
  const f=fixture({notify:false});call(f,'old-history','history',{query:'合成旧事项'});
  assert.equal(preview(f).allowed,false);assert.equal(commit(f).allowed,false);assert.equal(f.life.outbox.length,0);
});

test('selected history cannot be washed by a fresh notification or even an explicit event selection',()=>{
  const f=fixture();call(f,'old-history','history',{query:'合成旧事项'});f.report.shareEventIds=['event-a'];
  assert.equal(preview(f).allowed,false);
});

test('local ledger and dialogue lookup receipts are history evidence too, regardless of a fresh notification',()=>{
  for(const name of ['fish_life_history','fish_dialogue_history']){
    const f=fixture();f.round.receipts.push({id:'history',tool:name,text:'合成旧记录',isError:false});f.report.facts.push('history');
    f.report.shareEventIds=['event-a'];assert.equal(preview(f).allowed,false,name);
  }
});

test('selected history cannot be washed by an unrelated newly confirmed action',()=>{
  const f=fixture({notify:false});call(f,'old-history','history',{query:'合成旧事项'});call(f,'new-action','say',{fish:'#7',text:'合成招呼'});
  assert.equal(preview(f).allowed,false);
});

test('local facts may retain history while explicit share facts select only a genuinely new action',()=>{
  const f=fixture({notify:false});call(f,'old-history','history',{query:'合成旧事项'});call(f,'new-action','say',{fish:'#7',text:'合成招呼'});
  f.report.shareFacts=['new-action'];const proof=preview(f);
  assert.equal(proof.allowed,true);assert.deepEqual(proof.shareFacts,['new-action']);
  assert.deepEqual(f.report.facts,['now','old-history','new-action']);
});

test('local history can coexist with an explicitly selected new notification and current observation',()=>{
  const f=fixture();call(f,'old-history','history',{query:'合成旧事项'});f.report.shareFacts=['now'];f.report.shareEventIds=['event-a'];
  assert.equal(preview(f).allowed,true);
});

test('having local history prevents implicit notification inference when no share event was selected',()=>{
  const f=fixture();call(f,'old-history','history',{});f.report.shareFacts=['now'];
  assert.equal(preview(f).allowed,false);
});

for(const [name,args]of [['go',{place:'合成地点'}],['do',{task:'task-7'}],['say',{fish:'#7',text:'合成招呼'}],['update',{profile:'合成简介'}],['friends',{action:'request',fish:'#7'}]]){
  test('confirmed current '+name+' action is eligible without a notification',()=>{
    const f=fixture({notify:false});call(f,'new-action',name,args);f.report.shareFacts=['new-action'];
    const proof=preview(f);assert.equal(proof.allowed,true);assert.equal(proof.keys.length,1);
  });
}

test('friends list and incomplete friends arguments are read-only and cannot create share eligibility',()=>{
  for(const args of [{action:'list'},{}]){
    const f=fixture({notify:false});call(f,'friends','friends',args);f.report.shareFacts=['friends'];assert.equal(preview(f).allowed,false);
  }
});

test('receipt text is insufficient without a matching confirmed actual journal call',()=>{
  for(const mutate of [
    ({life})=>{life.journal.pop();},
    (_f,c)=>{c.record.status='uncertain';},
    (_f,c)=>{c.record.isError=true;},
    (_f,c)=>{c.receipt.isError=true;},
    (_f,c)=>{c.record.round='other-round';},
    (_f,c)=>{c.record.sessionId='other-session';},
    (_f,c)=>{c.record.tool=tool('now');},
    (_f,c)=>{c.record.args='invalid-json';},
    (_f,c)=>{c.record.args='[]';},
    (_f,c)=>{c.record.at=now-120000;},
    (_f,c)=>{c.record.finishedAt=now+1;},
    (_f,c)=>{c.record.finishedAt=c.record.at-1;}
  ]){
    const f=fixture({notify:false}),c=call(f,'action','do',{task:'task-7'});f.report.shareFacts=['action'];mutate(f,c);
    assert.equal(preview(f).allowed,false);
  }
});

test('selected facts must be exact successful receipt IDs rather than invented or broad tool labels',()=>{
  for(const ids of [['missing'],[tool('do')],['action','missing']]){
    const f=fixture({notify:false});call(f,'action','do',{task:'task-7'});f.report.shareFacts=ids;assert.equal(preview(f).allowed,false);
  }
});

test('profile and find results cannot manufacture a new event, while actual new notifications remain valid',()=>{
  const f=fixture({notify:false});call(f,'profile','profile',{fish:'#7'});call(f,'find','find',{query:'合成邻居'});
  assert.equal(preview(f).allowed,false);
  notification(f);f.report.shareFacts=['now'];f.report.shareEventIds=['event-a'];assert.equal(preview(f).allowed,true);
});

test('read-only and recovery rounds stay local even if their receipts contain a real new event or action',()=>{
  for(const config of [{readOnly:true},{kind:'recovery'},{readOnly:true,kind:'inspection'}]){
    const f=fixture();Object.assign(f.round,config);call(f,'new-action','say',{fish:'#7',text:'合成招呼'});f.report.shareFacts=['new-action'];
    assert.equal(preview(f).allowed,false);assert.equal(commit(f).allowed,false);assert.equal(f.life.outbox.length,0);
  }
});

test('claim is persisted with the original business identity, so a new round or session cannot repeat it',()=>{
  const f=fixture(),first=commit(f);assert.equal(first.allowed,true);
  const claims=structuredClone(f.life.sharingEvidence),outbox=structuredClone(f.life.outbox);
  nextRound(f);assert.equal(preview(f).allowed,false);assert.equal(commit(f).allowed,false);
  assert.deepEqual(f.life.sharingEvidence,claims);assert.deepEqual(f.life.outbox,outbox);
});

test('JSON reload and every submitted or pending outbox state retain the claim without refunding it',()=>{
  for(const state of ['pending','deferred','failed','queued','sending','uncertain','sent','suppressed']){
    const f=fixture();assert.equal(commit(f,state).allowed,true);
    f.life=JSON.parse(JSON.stringify(f.life));const before=structuredClone(f.life.outbox);
    nextRound(f);reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});
    assert.equal(preview(f).allowed,false,state);assert.deepEqual(f.life.outbox,before,state);
  }
});

test('an already claimed notification cannot suppress a new selected action through implicit inference',()=>{
  const f=fixture();assert.equal(commit(f).allowed,true);nextRound(f);
  call(f,'new-action','do',{task:'task-8'});f.report.shareFacts=['new-action'];
  const proof=preview(f);assert.equal(proof.allowed,true);assert.deepEqual(proof.shareEventIds,[]);
  f.report.shareFacts=['now','new-action'];f.report.shareEventIds=['event-a'];assert.equal(preview(f).allowed,false,'explicit selection still cannot reuse the old notification');
});

test('genuinely different event identity is shareable even when text and amount are identical',()=>{
  const f=fixture();assert.equal(commit(f).allowed,true);const key=f.life.outbox[0].keys[0];
  nextRound(f);f.round.events=[];f.report.events=[];notification(f,'event-b',{t:now-1000});
  const proof=commit(f);assert.equal(proof.allowed,true);assert.notEqual(proof.keys[0],key);assert.equal(f.life.outbox.length,2);
  assert.equal(f.life.outbox[0].text,f.life.outbox[1].text);
});

test('claims are scoped to the fish and current owner persona, rather than globally hashing shared wording',()=>{
  const f=fixture(),original=preview(f).keys;
  for(const update of [g=>{g.fishId='other-fish';},g=>{g.life.owner='other-owner';},g=>{g.life.persona='other-persona';}]){
    const g=structuredClone(f);update(g);const proof=preview(g);assert.equal(proof.allowed,true);assert.notDeepEqual(proof.keys,original);
  }
});

test('legacy submitted original shares seed trusted event claims without rewriting delivery evidence',()=>{
  for(const state of ['sent','queued','uncertain']){
    const f=fixture(),q=f.life.queue[0];q.status='completed';
    f.life.outbox.push({id:q.lastRoundId,at:now-1000,state,text:'合成原生活消息',...identity,receipt:'original-receipt',receipts:['original-receipt'],deliveryId:'original-delivery',attempts:1});
    const before=structuredClone(f.life.outbox);reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});
    assert.deepEqual(f.life.outbox,before);nextRound(f);assert.equal(preview(f).allowed,false,state);
  }
});

test('legacy unrelated and untrusted queue records do not retroactively consume new event identities',()=>{
  for(const mutate of [f=>{f.life.queue[0].lastRoundId='other-round';},f=>{f.life.queue[0].provenance.trusted=false;}]){
    const f=fixture();f.life.queue[0].status='completed';
    f.life.outbox.push({id:f.round.id,at:now-1000,state:'sent',text:'合成旧消息',...identity});mutate(f);
    reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});
    Object.assign(f.life.queue[0],{lastRoundId:f.round.id,provenance:{trusted:true,source:'world-notify'}});
    assert.equal(preview(f).allowed,true);
  }
});

test('legacy history-only drafts are suppressed locally while their original text and delivery metadata remain inspectable',()=>{
  const f=fixture({notify:false});const {record}=call(f,'old-history','history',{query:'合成旧事项'});
  f.life.journal.push({id:f.round.id,type:'round',kind:'plan',status:'completed',receipts:[record.id]});
  for(const state of ['pending','deferred','failed'])f.life.outbox.push({id:f.round.id+'-'+state,at:now-1000,state,text:'合成历史分享 '+state,...identity,facts:[record.id],receipt:'partial-'+state,receipts:['partial-'+state],attempts:2,reason:'原原因',roundId:f.round.id});
  // Historical outbox IDs are normally the exact round ID; give each independent draft that original linkage.
  for(const row of f.life.outbox)f.life.journal.push({id:row.id,type:'round',kind:'plan',status:'completed',receipts:[record.id]});
  const before=structuredClone(f.life.outbox);reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});
  for(const [index,row]of f.life.outbox.entries()){
    assert.equal(row.state,'suppressed');assert.equal(row.text,before[index].text);assert.deepEqual(row.facts,before[index].facts);
    assert.equal(row.receipt,before[index].receipt);assert.deepEqual(row.receipts,before[index].receipts);assert.equal(row.attempts,2);
    assert.deepEqual(row.suppressedFrom,{state:before[index].state,reason:'原原因'});
  }
});

test('a rejected legacy history draft cannot claim an unrelated fresh notification before a genuine new share',()=>{
  const f=fixture(),{record}=call(f,'old-history','history',{});
  f.life.queue[0].status='completed';
  f.life.outbox.push({id:f.round.id,at:now-1000,state:'pending',text:'合成旧历史草稿',facts:[record.id],...identity});
  reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});
  assert.equal(f.life.outbox[0].state,'suppressed');assert.equal(Object.keys(f.life.sharingEvidence.claims).length,0);
  nextRound(f);f.report.shareFacts=['now'];f.report.shareEventIds=['event-a'];assert.equal(preview(f).allowed,true);
});

test('constructor sharing-policy suppression cannot let an unsent history draft acquire a notification claim',()=>{
  for(const settings of [{sharing:false},{sharing:true}]){
    const f=fixture(),{record}=call(f,'old-history','history',{});f.life.queue[0].status='completed';
    const row={id:f.round.id,at:now-1000,state:'pending',text:'合成旧历史草稿',facts:[record.id],...identity};
    f.life.outbox.push(row);
    if(settings.sharing)Object.assign(row,{state:'suppressed',suppressedFrom:{state:'pending',reason:'原分享关闭'},reason:'原本地保护'});
    const original=settings.sharing?structuredClone(row):null;
    const data={fishId,at:{state:now},state:{stage:'alive'},life:f.life};
    new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{},settings:()=>settings,identity:()=>identity,clock:()=>now});
    assert.equal(row.state,'suppressed');assert.equal(Object.keys(f.life.sharingEvidence.claims).length,0);
    if(original)assert.deepEqual(row,original,'already-suppressed history retains its original suppression evidence');
    else assert.deepEqual(row.suppressedFrom,{state:'pending',reason:''});
  }
});

test('legacy history-only submitted rows and drafts with unknown provenance are never reset or broadly paused',()=>{
  const f=fixture({notify:false});const {record}=call(f,'old-history','history',{});
  for(const state of ['sent','queued','uncertain'])f.life.outbox.push({id:'submitted-'+state,at:now,state,text:'合成旧记录',facts:[record.id],...identity,receipt:'original-'+state});
  f.life.outbox.push({id:'unknown-draft',at:now,state:'pending',text:'合成来源未知但未证实旧历史',facts:['missing'],...identity});
  const before=structuredClone(f.life.outbox);reconcileShareEvidence(f.life,{fishId:f.fishId,now:f.now});assert.deepEqual(f.life.outbox,before);
});

test('LifeEngine commits a fresh event share and its claim together, and reload cannot resend that business event',async()=>{
  const f=fixture(),sent=[],data={fishId,at:{state:now},state:{stage:'alive'},now:'合成当前现场',life:f.life};
  const changes=[],bridge={data,change(fn){const result=fn(data);changes.push(structuredClone(data.life));return result;}};
  const host={remember:async()=>({ok:true}),send:async row=>{sent.push(row.id);return {message_id:'synthetic-receipt'};},deliveryStatus:async()=>({state:'sent'})};
  let engine=new LifeEngine({bridge,host,settings:()=>({sharing:true,quietStart:0,quietEnd:0}),identity:()=>identity,clock:()=>now});
  engine.l.round=f.round;engine.finish(f.report);changes.length=0;engine.end(true);
  assert.equal(changes[0].outbox.length,1);assert.equal(Object.keys(changes[0].sharingEvidence.claims).length,1,'the same bridge mutation must contain the claim and the new outbox row');
  await engine.deliver();assert.deepEqual(sent,['round-a']);
  data.life=JSON.parse(JSON.stringify(data.life));engine=new LifeEngine({bridge,host,settings:()=>({sharing:true,quietStart:0,quietEnd:0}),identity:()=>identity,clock:()=>now});
  const g={...f,life:engine.l};nextRound(g);g.life.queue[0].status='running';engine.l.round=g.round;
  engine.finish(g.report);engine.end(true);await engine.deliver();
  assert.deepEqual(sent,['round-a']);assert.equal(engine.l.outbox.find(row=>row.id==='round-b').state,'suppressed');
});

test('quiet and exhausted-quota delivery ticks defer once without repeated full-ledger changes',async()=>{
  for(const mode of ['quiet','quota']){
    const f=fixture({notify:false}),sent=[],data={fishId,at:{state:now},state:{stage:'alive'},life:f.life};
    let changes=0;
    const bridge={data,change(fn){changes++;return fn(data);}};
    const settings={sharing:true,quietStart:mode==='quiet'?0:0,quietEnd:mode==='quiet'?23:0,shareLimit:mode==='quota'?0:6};
    const engine=new LifeEngine({bridge,host:{send:async row=>{sent.push(row.id);return {message_id:'synthetic-receipt'};}},settings:()=>settings,identity:()=>identity,clock:()=>now});
    const row={id:'deferred-'+mode,at:now,state:'pending',importance:'important',text:'合成待分享生活消息',...identity};
    engine.l.outbox.push(row);changes=0;
    await engine.deliver();assert.equal(row.state,'deferred');assert.equal(changes,1,'only the initial deferred transition writes the ledger');
    const snapshot=structuredClone(engine.l);changes=0;
    for(let tick=0;tick<3;tick++)await engine.deliver();
    assert.equal(changes,0,mode+' cannot trigger full-ledger evidence reconciliation on every tick');
    assert.deepEqual(engine.l,snapshot);assert.deepEqual(sent,[]);
    assert.ok(Object.values(engine.l.days).every(day=>day.share===0));
  }
});

test('last-moment history drafts are blocked before sending or charging quota while queued receipts keep their original path',async()=>{
  const f=fixture({notify:false}),sent=[],queried=[],data={fishId,at:{state:now},state:{stage:'alive'},life:f.life};
  let changes=0;
  const bridge={data,change(fn){changes++;return fn(data);}};
  const host={send:async row=>{sent.push(row.id);return {message_id:'synthetic-receipt'};},deliveryStatus:async id=>{queried.push(id);return {state:'sent'};}};
  const engine=new LifeEngine({bridge,host,settings:()=>({sharing:true,quietStart:0,quietEnd:0}),identity:()=>identity,clock:()=>now});
  const {record}=call(f,'late-history','history',{});
  const row={id:'late-history-round',at:now-1000,state:'pending',importance:'important',text:'合成迟插入历史草稿',facts:[record.id],...identity,receipt:'original-part',receipts:['original-part'],attempts:1};
  engine.l.outbox.push(row);changes=0;
  await engine.deliver();
  assert.equal(row.state,'suppressed');assert.equal(row.localOnly,true);assert.deepEqual(row.suppressedFrom,{state:'pending',reason:''});
  assert.deepEqual(sent,[]);assert.ok(Object.values(engine.l.days).every(day=>day.share===0));
  assert.equal(row.attempts,1);assert.equal(row.receipt,'original-part');assert.deepEqual(row.receipts,['original-part']);
  assert.equal(Object.keys(engine.l.sharingEvidence.claims).length,0);assert.equal(changes,1,'one final evidence reconciliation, without entering sending or incrementing quota');
  const queued={id:'already-queued',at:now-2000,state:'queued',importance:'urgent',text:'合成已提交消息',...identity,deliveryId:'original-delivery',receipt:'original-receipt'};
  const waiting={...row,id:'history-waiting-behind-queued',state:'pending',localOnly:false};
  delete waiting.suppressedFrom;delete waiting.suppressedAt;
  engine.l.outbox.push(queued,waiting);changes=0;
  await engine.deliver();
  assert.deepEqual(queried,['original-delivery']);assert.equal(queued.state,'sent');assert.equal(queued.receipt,'original-receipt');
  assert.equal(waiting.state,'pending','queued receipt polling does not run the full share-evidence scan');
  assert.equal(changes,1);assert.deepEqual(sent,[]);assert.ok(Object.values(engine.l.days).every(day=>day.share===0));
});
