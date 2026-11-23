import test from 'node:test';
import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';

const now=Date.parse('2026-11-23T10:00:00+08:00');
const identity={owner:'synthetic-owner',persona:'synthetic-persona'};
const item=(id,state='pending',extra={})=>({id,state,at:now,importance:'urgent',text:'合成消息',owner:identity.owner,persona:identity.persona,...extra});
function fixture(outbox=[],journal=[]){
  const sent=[],queried=[],data={fishId:'synthetic-fish',at:{state:now},state:{stage:'alive'},now:'合成现场',life:{...newLife(now),...identity,outbox,journal,sharingPolicy:{version:1,sharing:true,initializedAt:now,changedAt:now}}};
  const bridge={data,change:fn=>fn(data)};
  const host={send:async o=>{sent.push(o.id);return {message_id:'receipt-'+o.id};},deliveryStatus:async id=>{queried.push(id);return {state:'sent'};},remember:async()=>({ok:true})};
  const engine=new LifeEngine({bridge,host,clock:()=>now,identity:()=>identity});
  return {engine,sent,queried};
}

test('new host timeout and other system faults stay visible locally while normal urgent and important shares are sent',async()=>{
  const f=fixture();f.engine.control('pauseShare');
  for(const key of ['host','timeout','other'])f.engine.fault(key,'合成故障 '+key);
  f.engine.control('share');
  f.engine.l.outbox.push(item('world-urgent'),item('world-important','pending',{importance:'important'}));
  await f.engine.deliver();await f.engine.deliver();await f.engine.deliver();
  assert.deepEqual(f.sent,['world-urgent','world-important']);
  const faults=f.engine.snapshot().outbox.filter(o=>o.id.startsWith('fault-'));
  assert.equal(faults.length,3);assert.ok(faults.every(o=>o.state==='suppressed'&&o.reason.includes('本地')));
  assert.deepEqual(faults.map(o=>o.text),['合成故障 host','合成故障 timeout','合成故障 other']);
  assert.deepEqual(f.engine.l.faults,{host:now,timeout:now,other:now});
});

test('legacy unsent system faults are suppressed without losing history or receipts and cannot block normal shares',async()=>{
  const faults=['pending','deferred','failed'].map(state=>item('fault-'+state,state,{reason:'原始 '+state,receipt:'old-'+state,receipts:['old-'+state],attempts:2,deliveryId:'delivery-'+state}));
  const f=fixture([...faults,item('world-normal')]);
  await f.engine.deliver();await f.engine.deliver();
  assert.deepEqual(f.sent,['world-normal']);
  for(const [index,state]of ['pending','deferred','failed'].entries()){
    const o=f.engine.l.outbox[index];assert.equal(o.state,'suppressed');
    assert.deepEqual(o.suppressedFrom,{state,reason:'原始 '+state});
    assert.equal(o.receipt,'old-'+state);assert.deepEqual(o.receipts,['old-'+state]);
    assert.equal(o.attempts,2);assert.equal(o.deliveryId,'delivery-'+state);
  }
});

test('queued system faults only query their original receipt after normal shares; uncertain and sent faults never replay',async()=>{
  const queued=item('fault-queued','queued',{deliveryId:'original-delivery',receipt:'known-part',receipts:['known-part']});
  const uncertain=item('fault-uncertain','uncertain',{receipt:'uncertain-part',receipts:['uncertain-part']});
  const sending=item('fault-sending','sending',{receipt:'sending-part',receipts:['sending-part']});
  const sent=item('fault-sent','sent',{receipt:'sent-part',receipts:['sent-part']});
  const f=fixture([queued,uncertain,sending,sent,item('world-normal')]);
  await f.engine.deliver();assert.deepEqual(f.sent,['world-normal']);assert.deepEqual(f.queried,[]);
  await f.engine.deliver();await f.engine.deliver();
  assert.deepEqual(f.sent,['world-normal']);assert.deepEqual(f.queried,['original-delivery']);
  assert.equal(queued.state,'sent');assert.equal(queued.receipt,'known-part');assert.deepEqual(queued.receipts,['known-part']);
  assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.receipt,'uncertain-part');
  assert.equal(sending.state,'uncertain');assert.equal(sending.receipt,'sending-part');
  assert.equal(sent.state,'sent');assert.equal(sent.receipt,'sent-part');
});

test('failed queued fault receipts cannot become send retries and quota notices retain their existing filtering',async()=>{
  const queued=item('fault-queued','queued',{deliveryId:'original-delivery'});
  const quota=item('fault-old-quota','pending',{noticeOnly:true,facts:['budget-work']});
  const f=fixture([queued,quota]);f.engine.host.deliveryStatus=async id=>{f.queried.push(id);return {state:'failed'};};
  await f.engine.deliver();await f.engine.deliver();
  assert.deepEqual(f.sent,[]);assert.deepEqual(f.queried,['original-delivery']);
  assert.equal(queued.state,'suppressed');assert.equal(queued.suppressedFrom.state,'failed');
  assert.equal(quota.state,'pending');assert.equal(f.engine.l.alerts.length,0);
  f.engine.fault('budget-work');assert.equal(f.engine.l.alerts.length,1);assert.equal(f.engine.l.outbox.length,2);
});

test('background sharing instructions keep faults and recovery diagnostics local and reserve QQ for normal life results',()=>{
  const f=fixture(),prompt=f.engine.prompt([],{events:[],planIds:[],readOnly:true});
  assert.match(prompt,/QQ 只分享正常生活消息/);
  assert.match(prompt,/系统故障、超时、通道异常和恢复核对只记录在 summary 或本地状态，不写入 share/);
  assert.match(prompt,/没有正常生活结果时 share 留空/);
});

test('completed recovery and read-only round shares stay local through finish end and delivery while a normal important result is sent',async()=>{
  const f=fixture();
  for(const [index,config]of [{kind:'recovery',readOnly:true},{kind:'recovery',readOnly:false},{kind:'inspection',readOnly:true},{kind:'recovery',readOnly:true,importance:'routine'},{kind:'idle',readOnly:false}].entries()){
    const id='completed-round-'+index,receipt='observation-'+index;
    f.engine.l.round={id,status:'running',...config,events:[],planIds:[],startedAt:now,bucket:'idle',observation:'合成成功现场',receipts:[{id:receipt,tool:'mcp__fish-world__world_now',text:'合成成功现场',isError:false}]};
    f.engine.finish({events:[],planChanges:[],importance:config.importance||'important',summary:'合成本地总结 '+index,facts:[receipt],share:'合成分享原文 '+index});
    f.engine.end(true);await f.engine.deliver();
    const o=f.engine.l.outbox.find(row=>row.id===id);
    assert.equal(o.text,'合成分享原文 '+index);assert.deepEqual(o.facts,[receipt]);
    if(index<4){assert.equal(o.state,'suppressed');assert.equal(o.localOnly,true);assert.deepEqual(f.sent,[]);}
    else {assert.equal(o.state,'sent');assert.deepEqual(f.sent,[id]);}
  }
  assert.equal(f.engine.l.journal.filter(j=>j.type==='round'&&j.status==='completed').length,5);
});

test('legacy UUID recovery shares are identified by their round journal without suppressing normal world messages',async()=>{
  const states=['pending','deferred','failed','queued','uncertain','sent'];
  const recoveries=states.map((state,index)=>item('00000000-0000-4000-8000-00000000000'+index,state,{deliveryId:'recovery-delivery-'+state,receipt:'old-'+state,receipts:['old-'+state],reason:'原始 '+state}));
  const journal=recoveries.map(o=>({id:o.id,type:'round',kind:'recovery',status:'completed',summary:'合成旧恢复记录',receipts:['evidence-'+o.state]}));
  const normal=item('normal-important','pending',{importance:'important',text:'今天正常散步的生活消息'});
  journal.push({id:normal.id,type:'round',kind:'idle',status:'completed'});
  const priorJournal=structuredClone(journal);
  const f=fixture([...recoveries,normal],journal);
  await f.engine.deliver();assert.deepEqual(f.sent,[normal.id]);assert.deepEqual(f.queried,[]);
  await f.engine.deliver();await f.engine.deliver();
  assert.deepEqual(f.sent,[normal.id]);assert.deepEqual(f.queried,['recovery-delivery-queued']);
  for(const [index,state]of states.entries()){
    const o=recoveries[index];assert.equal(o.localOnly,true);assert.equal(o.receipt,'old-'+state);assert.deepEqual(o.receipts,['old-'+state]);
    assert.equal(o.state,index<3?'suppressed':state==='queued'?'sent':state);
    if(index<3)assert.deepEqual(o.suppressedFrom,{state,reason:'原始 '+state});
  }
  assert.deepEqual(f.engine.l.journal,priorJournal);
});
