import test from 'node:test';import assert from 'node:assert/strict';
import {newLife,defaults,enqueue} from '../extensions/aurabot/fish-world/state.mjs';
import {candidates,admission} from '../extensions/aurabot/fish-world/governance.mjs';
import {finishPlanCheck,advancePlans,planEvidenceFingerprint,preparePlanChanges,applyPlanChanges} from '../extensions/aurabot/fish-world/plans.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {planActivityGuard} from '../extensions/aurabot/fish-world/plan-activity.mjs';
const now=Date.parse('2026-11-26T12:32:00+08:00'),W='mcp__fish-world__world_';
function fixture(){const l=newLife(now);Object.assign(l,{owner:'owner',persona:'fish'});const p={id:'plan',revision:1,status:'pending',goal:'回家',nextStep:'回家',nextAt:now-1,sourceEventIds:[],lastProgressAt:now-10000};l.plans.push(p);return {l,p,data:{fishId:'fixture#1',at:{state:now},state:{where:{kind:'place',place:{id:'shop'}},doing:null,body:{full:20,energy:30}},life:l},round:{id:'r',planId:p.id,planIds:[p.id],kind:'plan',sessionId:'s',startedAt:now,receipts:[]}};}
test('changes in hunger and energy cannot renew an overdue plan or wake an idle waiter',()=>{
 const f=fixture();f.p.waitCondition={kind:'state',when:'idle'};f.p.lastEvidenceFingerprint=planEvidenceFingerprint(f.data,f.p);
 for(let i=1;i<=5;i++){f.data.state.body.full++;f.data.state.body.energy--;finishPlanCheck(f.l,f.data,f.round,{now:now+i});advancePlans(f.l,f.data,now+i);assert.equal(f.p.status,'waiting_event');assert.equal(f.p.lastProgressAt,now-10000);}
 assert.equal(f.p.unchangedChecks,5);assert.equal(f.p.lastProgressProof,undefined);
});
test('confirmed travel waits for real arrival and resumes its own plan without requiring a second departure',()=>{
 const f=fixture(),row={id:'go',tool:W+'go',args:'{"place":"home"}',status:'confirmed',round:'r',sessionId:'s',at:now,finishedAt:now+1,result:'confirmed fixture travel'};
 f.l.journal.push(row);f.round.receipts.push({id:'go',tool:row.tool,text:row.result,isError:false});finishPlanCheck(f.l,f.data,f.round,{now:now+2});
 assert.equal(f.p.status,'waiting_event');assert.deepEqual(f.p.waitCondition,{kind:'state',when:'idle'});assert.equal(f.p.lastProgressProof.reason,'confirmed-related-action');
 f.data.state.where={kind:'trip',to:{id:'home'}};f.data.at.state=now+3000;advancePlans(f.l,f.data,now+3000);assert.equal(f.p.status,'waiting_event');assert.equal(f.p.waitObservedBusy,true);
 f.data.state.where={kind:'home'};f.data.at.state=now+6000;advancePlans(f.l,f.data,now+6000);assert.equal(f.p.status,'pending');assert.equal(f.p.nextAt,now+6000);
});
test('an instant confirmed action resumes once on fresh idle state and cannot replay the same finished step',()=>{
 const f=fixture();Object.assign(f.p,{goal:'买一本书后回家',nextStep:'buy-book'});f.round.planNextStep='buy-book';
 const row={id:'buy',tool:W+'do',args:'{"id":"buy-book","request_id":"first"}',status:'confirmed',round:'r',sessionId:'s',at:now,finishedAt:now+1,result:'fixture book purchased'};f.l.journal.push(row);f.round.receipts.push({id:row.id,tool:row.tool,text:row.result});
 finishPlanCheck(f.l,f.data,f.round,{now:now+2});assert.equal(f.p.status,'waiting_event');f.data.at.state=now+3000;advancePlans(f.l,f.data,now+3000);assert.equal(f.p.status,'pending');
 assert.match(planActivityGuard(f.data,f.round,W+'do',{id:'buy-book',request_id:'second'},now+3000),/已有成功回执/);
 f.p.nextStep='带书回家';assert.equal(planActivityGuard(f.data,f.round,W+'go',{place:'home'},now+3000),undefined);
 finishPlanCheck(f.l,f.data,{...f.round,id:'r2',receipts:[],startedAt:now+4000},{now:now+5000});f.data.at.state=now+6000;advancePlans(f.l,f.data,now+6000);assert.equal(f.p.status,'waiting_event');
});
test('definition batches are bounded, cannot execute actions, and can restore a valid schedule using current evidence',()=>{
 const f=fixture();Object.assign(f.p,{status:'blocked',nextAt:0,scheduleIssue:{version:1,code:'trigger-needs-definition',at:now}});
 const chosen=candidates(f.l,f.data,defaults,now).find(t=>t.kind==='plan-definition');assert.equal(chosen.definitionOnly,true);assert.equal(admission(f.l,chosen,defaults,{now}).allowed,true);
 const e=new LifeEngine({bridge:{data:f.data,change:fn=>fn(f.data)},host:{},clock:()=>now});e.l.round={...f.round,status:'running',kind:'plan-definition',definitionOnly:true,revision:e.l.revision,observation:'fixture',identityConfirmed:true,calls:0};
 assert.match(e.guard({name:W+'go',arguments:{place:'home'},agent:{session:{id:'s'}}},true,false),/不提交世界变更/);assert.equal(e.l.journal.length,0);
 const round={...f.round,receipts:[{id:'now-proof',tool:W+'now',text:'fixture current state'}]};
 const changes=preparePlanChanges(f.l,{planChanges:[{op:'update',id:f.p.id,expectedRevision:f.p.revision,evidenceIds:['now-proof'],patch:{status:'pending',nextAt:now+600000}}]},{round,now});applyPlanChanges(f.l,changes,{now,roundId:'r'});
 assert.equal(f.l.plans[0].status,'pending');assert.equal(f.l.plans[0].scheduleIssue,undefined);
 f.l.plans[0].status='blocked';f.l.plans[0].scheduleIssue={version:1,code:'trigger-needs-definition',at:now};f.l.plans[0].definitionChecks=2;
 assert.equal(candidates(f.l,f.data,defaults,now).some(t=>t.kind==='plan-definition'),false);
});
test('failed definition submissions consume their finite attempts and keep the normal window contract',async()=>{
 const f=fixture();let at=now,calls=0,e;Object.assign(f.p,{status:'blocked',nextAt:0,scheduleIssue:{version:1,code:'trigger-needs-definition',at:now}});
 const host={idle:async()=>true,cancel:async()=>{},prepare:async(prompt,round)=>{assert.equal(round.readOnly,false);assert.equal(round.definitionOnly,true);return {prompt,estimate:{roundPromptTokens:100,requestTokens:1000}};},run:async()=>{calls++;throw Error('synthetic host submission failure');}};
 e=new LifeEngine({bridge:{data:f.data,identityReady:true,change:fn=>fn(f.data)},host,clock:()=>at,identity:()=>({owner:'owner',persona:'fish'})});
 for(let i=1;i<=2;i++){
  f.data.at.state=at;await e.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(e.l.plans[0].definitionChecks,i);await e.tick();assert.equal(e.l.round,null);
  e.l.recovery=false;e.l.backoffUntil=0;at=e.l.plans[0].nextDefinitionAt+1;
 }
 assert.equal(calls,2);assert.equal(candidates(e.l,f.data,e.cfg,at).some(task=>task.kind==='plan-definition'),false);assert.equal(e.l.journal.filter(row=>row.type==='round'&&row.status==='uncertain').length,2);
});
test('a later related event cannot erase confirmed actions from the same unadvanced step',()=>{
 const f=fixture();Object.assign(f.p,{goal:'上班等结算',nextStep:'上班等结算',waitCondition:{kind:'event',eventKind:'done'},trigger:'done'});f.round.planNextStep=f.p.nextStep;
 const row={id:'work',tool:W+'do',args:'{"id":"work"}',status:'confirmed',round:'r',sessionId:'s',at:now,finishedAt:now+1,result:'fixture started shift'};f.l.journal.push(row);f.round.receipts.push({id:row.id,tool:row.tool,text:row.result});finishPlanCheck(f.l,f.data,f.round,{now:now+2});
 const t=now+3600000,event={id:'settled',kind:'done',text:'工作结算',t,provenance:{trusted:true,source:'world-notify'},status:'completed',lastRoundId:'event-round',relatedPlanIds:[f.p.id]};f.l.queue.push(event);f.p.waitCondition={kind:'event',eventKind:'done'};
 finishPlanCheck(f.l,f.data,{id:'event-round',planId:f.p.id,planIds:[f.p.id],startedAt:t,events:[event.id],receipts:[],report:{events:[{id:event.id,status:'completed'}]}},{now:t+1});
 assert.equal(f.p.lastProgressProof.reason,'completed-related-event');assert.equal(f.p.lastProgressProof.actions.length,1);assert.equal(f.p.lastProgressProof.executedStep,'上班等结算');f.data.at.state=t+2;
 assert.match(planActivityGuard(f.data,{kind:'plan',planId:f.p.id},W+'do',{id:'work',request_id:'new'},t+2),/已有成功回执/);
});
test('legacy normalization leaves window, quotas, original tool receipts and deliveries unchanged',()=>{
 const f=fixture();f.p.nextAt=0;Object.assign(f.l,{contextWindow:{epoch:3,completed:7,key:'unchanged'},days:{'2026-11-26':{idle:9,work:4}},sharingPolicy:{version:1,sharing:true,settingsSharing:true},outbox:[{id:'confirmed-share',state:'sent',receipt:'fixture-receipt',at:now,text:'fixture'}]});f.l.journal.push({id:'unknown',status:'uncertain',tool:W+'do'});
 const prior=JSON.stringify({window:f.l.contextWindow,days:f.l.days,outbox:f.l.outbox,journal:f.l.journal});
 new LifeEngine({bridge:{data:f.data,change:fn=>fn(f.data)},host:{},clock:()=>now,settings:()=>({sharing:true})});
 assert.deepEqual(f.l.contextWindow,JSON.parse(prior).window);assert.deepEqual(f.l.days,JSON.parse(prior).days);assert.deepEqual(f.l.journal,JSON.parse(prior).journal);assert.deepEqual(f.l.outbox,JSON.parse(prior).outbox);
 assert.equal(f.l.plans[0].status,'blocked');assert.equal(f.l.journal[0].status,'uncertain');
});
