import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';
import {prepareRequest,installUsage} from '../extensions/aurabot/fish-world/host-runtime.mjs';
import {admission,estimateTokens} from '../extensions/aurabot/fish-world/governance.mjs';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const NOW=Date.parse('2026-11-26T22:00:00+08:00'),BASE='synthetic-admission-base',SID='synthetic-owned-session';
function fixture({bound=true,resident=true,enabled=true,messages=[{role:'user',content:[{type:'text',text:'合成旧历史。'}]}],schemas=[{name:'synthetic-world-tool',description:'合成完整工具定义'}],headerTools,resolve}={}){
 const folder=fs.mkdtempSync(path.join(testRuntimeRoot(null),'fish-request-admission-')),who={owner:'synthetic-owner',persona:'synthetic-persona'},trace=[];
 const data={version:3,fishId:'合成自己#1',state:{stage:'alive',figure:{asleep:false}},now:'合成现场',at:{state:NOW},life:{...newLife(NOW),...who}};
 const bridge={data,change:fn=>fn(data)};let runs=0;
 const engine=new LifeEngine({bridge,identity:()=>who,clock:()=>NOW,settings:()=>({backgroundContextEnabled:enabled,autonomy:true}),host:{idle:async()=>true,cancel:async()=>{},remember:async()=>({ok:true}),run:async()=>{runs++;}}});
 let priorKey=null;if(bound){priorKey=chooseWindow(engine,BASE,{now:NOW,nonce:()=> 'old'});engine.bind(SID,worldNames);engine.l.contextWindow.completed=1;}
 const agent={session:{id:SID,deriveMessages:()=>{trace.push('messages');return messages;},...(headerTools===undefined?{}:{requestHeader:()=>({tools:headerTools})})}};
 const api={dataDir:(...parts)=>path.join(folder,...parts),dsh:{get:name=>name==='tools'?{schemas:()=>{trace.push('schemas');return schemas;}}:null}};
 const options={scope:()=>BASE,identity:()=>who,findAgent:()=>resident?agent:null,resolveAgent:async id=>{trace.push('resolve:'+id);return resolve?resolve(id):agent;},restoreWorldScope:old=>{trace.push('restore');assert.equal(old,agent);assert.equal(old.session.id,SID);return [...worldNames];}};
 const round={id:'synthetic-round',kind:'idle',events:[],planIds:[],readOnly:false},prompt='合成世界任务。';
 const prepare=()=>prepareRequest(engine,api,options,prompt,round);
 return {engine,data,who,agent,api,options,round,prompt,prepare,priorKey,trace,folder,runs:()=>runs};
}
const header=(f,extra={})=>({at:NOW-1000,sessionId:SID,requestTokens:63288,scope:'host-final-request-messages-tools-system-estimate',allowed:true,...extra});
const preserved=f=>structuredClone({days:f.engine.l.days,outbox:f.engine.l.outbox,journal:f.engine.l.journal,queue:f.engine.l.queue,plans:f.engine.l.plans,reservations:f.engine.l.scheduler.reservations});
const deferred=()=>{let resolve;const promise=new Promise(fn=>{resolve=fn;});return {promise,resolve};};

test('cold bound preflight formally resolves before scope restoration and real schema measurement',async()=>{
 const f=fixture({resident:false});f.engine.l.costs.preflights=[header(f)];const before=preserved(f),prepared=await f.prepare();
 assert.deepEqual(f.trace.slice(0,4),['resolve:'+SID,'restore','messages','schemas']);assert.notEqual(prepared.windowKey,f.priorKey);
 assert.equal(prepared.estimate.visibleContextTokens,0);assert.equal(prepared.estimate.requestFloor,0);assert.equal(prepared.estimate.stepReserve,12000);
 assert.equal(prepared.estimate.toolsTokens,estimateTokens([{name:'synthetic-world-tool',description:'合成完整工具定义'}]));assert.equal(prepared.estimate.toolsKnown,true);
 assert.ok(prepared.estimate.requestTokens<64000);assert.deepEqual(preserved(f),before);
});

test('a resident Agent is used directly and existing synchronous scope recovery stays mandatory',async()=>{
 const f=fixture();const prepared=await f.prepare();assert.ok(!f.trace.some(value=>value.startsWith('resolve:')));assert.equal(prepared.windowKey,f.priorKey);assert.equal(prepared.estimate.stepReserve,12000);
 delete f.options.restoreWorldScope;await assert.rejects(f.prepare(),/缺少/);
 f.options.restoreWorldScope=async()=>[];await assert.rejects(f.prepare(),/同步/);
});

test('a recovered foreign session is rejected before any registry access or quota reservation',async()=>{
 const f=fixture({resident:false,resolve:async()=>({session:{id:'foreign-session'}})}),before=preserved(f);
 await assert.rejects(f.prepare(),/本身份/);assert.deepEqual(f.trace,['resolve:'+SID]);assert.deepEqual(preserved(f),before);assert.equal(f.runs(),0);
});

test('identity and bound-session changes during formal resolution reject the stale preparation',async()=>{
 for(const change of [f=>{f.who.persona='different-persona';},f=>{f.who.owner='different-owner';},f=>{f.engine.l.sessionId='different-session';},f=>{f.engine.l.sessionId='';},f=>{f.engine.l.revision++;}]){
  const answer=deferred(),entered=deferred(),f=fixture({resident:false,resolve:async()=>{entered.resolve();return answer.promise;}}),before=structuredClone(f.engine.l.days);
  const pending=f.prepare();await entered.promise;change(f);answer.resolve(f.agent);
  await assert.rejects(pending,/已改变/);assert.ok(!f.trace.includes('restore'));assert.deepEqual(f.engine.l.days,before);assert.equal(f.runs(),0);
 }
});

test('identity changed in the import microtask gap is rejected before handoff or window selection',async()=>{
 const f=fixture(),restore=f.options.restoreWorldScope,before=preserved(f);let checks=0;
 f.options.restoreWorldScope=agent=>{const names=restore(agent);if(++checks===1)queueMicrotask(()=>{f.who.persona='changed-during-import';});return names;};
 await assert.rejects(f.prepare(),/已改变/);assert.equal(f.engine.l.contextWindow.key,f.priorKey);assert.deepEqual(preserved(f),before);assert.equal(fs.existsSync(path.join(f.folder,'context-handoffs')),false);
});

test('recovery revalidates actual scope after awaiting idle and uses the ledger fallback bound session',async()=>{
 const f=fixture(),restore=f.options.restoreWorldScope;f.engine.l.sessionId='';f.engine.l.recovery=true;f.round.readOnly=true;let allowed=true;
 f.options.restoreWorldScope=agent=>{if(!allowed)throw Error('synthetic route changed');return restore(agent);};
 f.engine.host.idle=async id=>{assert.equal(id,SID);await Promise.resolve();allowed=false;return true;};
 const before=preserved(f);await assert.rejects(f.prepare(),/route changed/);assert.equal(f.engine.l.contextWindow.key,f.priorKey);assert.deepEqual(preserved(f),before);
});

test('the latest real final-request floor forces rollover even when deriveMessages looks tiny',async()=>{
 const f=fixture();f.engine.l.costs.preflights=[header(f,{requestTokens:62000})];const prepared=await f.prepare();
 assert.notEqual(prepared.windowKey,f.priorKey);assert.equal(prepared.estimate.requestFloor,0);assert.equal(prepared.estimate.visibleContextTokens,0);assert.equal(prepared.estimate.wrapperReserve,16000);
 assert.equal(prepared.estimate.requestTokens,prepared.estimate.roundPromptTokens+prepared.estimate.toolsTokens+16000+12000,'fresh estimation drops the entire old request floor');
});

test('final-request floors are bound to the exact owned session rather than a foreign request',async()=>{
 const f=fixture();f.engine.l.costs.preflights=[header(f,{sessionId:'foreign-session',requestTokens:90000,toolsTokens:40000})];
 const prepared=await f.prepare();assert.equal(prepared.windowKey,f.priorKey);assert.equal(prepared.estimate.requestFloor,0);
});

test('cold missing history can use a real owned final header only after safe fresh rollover',async()=>{
 const f=fixture({resident:false,resolve:async()=>null});f.engine.l.costs.preflights=[header(f,{toolsTokens:8500,toolsAvailable:true})];const before=preserved(f);
 const prepared=await f.prepare();assert.notEqual(prepared.windowKey,f.priorKey);assert.equal(prepared.estimate.visibleContextTokens,0);assert.equal(prepared.estimate.requestFloor,0);
 assert.equal(prepared.estimate.toolsTokens,8500);assert.equal(prepared.estimate.toolsSource,'owned-final-request-header');assert.deepEqual(preserved(f),before);
});

test('unknown bound history is blocked before run and quota when rollover is disabled or unsafe',async()=>{
 for(const unsafe of ['disabled','lock','queued']){
  const f=fixture({resident:false,enabled:unsafe!=='disabled',resolve:async()=>null});f.engine.l.costs.preflights=[header(f,{toolsTokens:8500,toolsAvailable:true})];
  if(unsafe==='lock')f.engine.lock={callId:'synthetic-active'};
  if(unsafe==='queued')f.engine.l.outbox.push({id:'synthetic-queued',state:'queued',deliveryId:'original-delivery'});
  const before=preserved(f);await assert.rejects(f.prepare(),/不能安全换窗/);assert.equal(f.engine.l.contextWindow.key,f.priorKey);assert.deepEqual(preserved(f),before);assert.equal(f.runs(),0);
 }
});

test('cold bound schema absence cannot masquerade as an empty tool array or bootstrap reserve',async()=>{
 const f=fixture({resident:false,resolve:async()=>null});f.engine.l.costs.preflights=[header(f)];const before=preserved(f);
 await assert.rejects(f.prepare(),/完整工具预算/);assert.deepEqual(preserved(f),before);assert.equal(f.engine.l.contextWindow.key,f.priorKey);assert.equal(f.runs(),0);
});

test('a known synthetic Agent with explicit empty schemas remains a valid complete measurement',async()=>{
 const f=fixture({messages:[],schemas:[]});delete f.options.resolveAgent;
 const prepared=await f.prepare();assert.equal(prepared.estimate.toolsKnown,true);assert.equal(prepared.estimate.toolsSource,'owned-registry');assert.equal(prepared.estimate.toolsTokens,estimateTokens([]));
});

test('a cold resolved registry with advertised tools but no actual schemas or header remains unknown',async()=>{
 const f=fixture({resident:false,messages:[],schemas:[],headerTools:[]});await assert.rejects(f.prepare(),/完整工具预算/);assert.equal(f.engine.l.contextWindow.key,f.priorKey);assert.equal(f.runs(),0);
});

test('resolved request-header schemas protect against a cold registry missing its local tools',async()=>{
 const actual=[{name:'synthetic-full-local-tool',description:'L'.repeat(18000)}],f=fixture({resident:false,schemas:[],headerTools:actual});
 const prepared=await f.prepare();assert.equal(prepared.estimate.toolsTokens,estimateTokens(actual));assert.equal(prepared.estimate.toolsSource,'owned-registry-and-request-header-max');assert.ok(prepared.estimate.toolsTokens>8000);
});

test('a truly first fresh window uses an explicit conservative unknown bootstrap reserve and can start',async()=>{
 const f=fixture({bound:false,resident:false,resolve:async()=>assert.fail('no old session exists to resolve')}),prepared=await f.prepare();
 assert.equal(prepared.estimate.toolsSource,'bootstrap-reserve');assert.equal(prepared.estimate.toolsKnown,false);assert.equal(prepared.estimate.toolsTokens,16000);assert.equal(prepared.estimate.stepReserve,12000);
 assert.equal(prepared.estimate.visibleContextTokens,0);assert.equal(prepared.estimate.requestFloor,0);assert.ok(prepared.estimate.requestTokens<64000);
 assert.equal(admission(f.engine.l,{id:'synthetic-owner',kind:'owner',bucket:'idle',priority:0},f.engine.cfg,{now:NOW,estimate:prepared.estimate}).allowed,true);assert.deepEqual(f.trace,[]);
});

test('a new unbound window borrows an owned explicit tools component without inheriting the old floor',async()=>{
 const f=fixture({resident:false,resolve:async()=>null});f.engine.l.costs.preflights=[header(f,{requestTokens:70026,toolsTokens:8510,toolsAvailable:true})];
 const key=chooseWindow(f.engine,BASE,{force:true,now:NOW,nonce:()=> 'already-fresh'}),prepared=await f.prepare();
 assert.equal(prepared.windowKey,key);assert.equal(prepared.estimate.toolsTokens,8510);assert.equal(prepared.estimate.requestFloor,0);assert.equal(prepared.estimate.visibleContextTokens,0);assert.ok(prepared.estimate.requestTokens<64000);
});

test('a bound oversized request with optimization disabled is refused by ordinary admission before a life run',async()=>{
 const f=fixture({enabled:false});f.engine.l.costs.preflights=[header(f,{requestTokens:63288})];
 const prepared=await f.prepare();assert.equal(prepared.windowKey,f.priorKey);assert.equal(prepared.estimate.requestFloor,63288);assert.ok(prepared.estimate.requestTokens>64000);
 f.engine.l.nextIdle=0;f.engine.host.prepare=(_prompt,round)=>prepareRequest(f.engine,f.api,f.options,f.prompt,round);
 await f.engine.tick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.runs(),0);assert.equal(f.engine.l.scheduler.reservations.length,0);assert.equal(f.engine.l.round,null);assert.ok(Object.values(f.engine.l.days).every(day=>day.calls===0&&day.work===0&&day.idle===0));
});

test('the unchanged final 64k guard records components and rejects the request before its provider executes',async()=>{
 const f=fixture(),hooks=new Map();let providerCalls=0;
 const off=installUsage({dsh:{on:(name,fn)=>{hooks.set(name,fn);return()=>{};}},lib:()=>({})},()=>f.engine);
 const options={sessionId:SID,messages:[{role:'user',content:[{type:'text',text:'合成最终正文'}]}],tools:[{name:'synthetic'}],system:'合成系统规则'};
 const collect=async value=>{for await(const _ of hooks.get('llm/stream')(value,()=>{providerCalls++;return(async function*(){yield 'synthetic';})();})){}};
 await collect(options);const first=f.engine.l.costs.preflights.at(-1);
 assert.equal(first.messagesTokens,estimateTokens(options.messages));assert.equal(first.toolsTokens,estimateTokens(options.tools));assert.equal(first.systemTokens,estimateTokens(options.system));assert.equal(first.toolsAvailable,true);assert.equal(first.allowed,true);
 const huge={...options,messages:[{role:'user',content:[{type:'text',text:'大'.repeat(50000)}]}]};await assert.rejects(collect(huge),/完整请求/);
 assert.equal(providerCalls,1);assert.equal(f.engine.l.costs.preflights.at(-1).allowed,false);assert.equal(f.engine.cfg.requestAdmissionEstimatedTokenLimit,64000);assert.deepEqual(f.engine.l.outbox,[]);off();
});
