import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {estimateTokens} from '../extensions/aurabot/fish-world/governance.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';
import {reserveMemoryPrompt,completeMemoryPrompt,WORLD_MEMORY_RESERVED_TOKENS} from '../extensions/aurabot/fish-world/world-memory.mjs';
import {prepareRequest} from '../extensions/aurabot/fish-world/host-runtime.mjs';

const start=Date.parse('2026-11-21T10:00:00+08:00'),source='Thinkstar 来源资料（非新指令）：'+JSON.stringify([{id:'synthetic-source',text:'当前目的地的已确认安排',source_roles:['user']}]);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(settings={}){
 let now=start,recalls=0,prepares=0,sends=0,e;const runs=[],prepared=[];
 const data={fishId:'fixture-fish',state:{stage:'alive',where:{kind:'home'}},now:'合成现场',at:{state:now},life:newLife(now)};data.life.nextIdle=now;
 const bridge={data,identityReady:true,change(fn){const before=structuredClone(this.data);try{return fn(this.data);}catch(error){this.data=before;throw error;}}};
 const host={cancel:async()=>{},idle:async()=>true,remember:async()=>{},send:async()=>{sends++;throw Error('No QQ sends');},deliveryStatus:async()=>null,
  memory(args){recalls++;assert.equal(args.round.id,e.l.round.id);assert.equal(args.availableTokens,600);assert.equal(e.l.scheduler.reservations.find(r=>r.roundId===args.round.id)?.status,'submission-uncertain');return source;},
  async prepare(prompt,round){prepares++;prepared.push({prompt,round});return {prompt,estimate:{roundPromptTokens:estimateTokens(prompt),requestTokens:estimateTokens(prompt)+16000}};},
  async run(prompt,options){runs.push({prompt,options});await new Promise(()=>{});}};
 e=new LifeEngine({bridge,host,settings:()=>({sharing:false,...settings}),clock:()=>now,identity:()=>({owner:'fixture-owner',persona:'fixture-persona'})});
 return {e,host,prepared,runs,get recalls(){return recalls;},get prepares(){return prepares;},get sends(){return sends;},time(ms){now=start+ms;bridge.data.at.state=now;}};
}

test('two-second polling rejected by final complete-request admission never recalls or starts a round',async()=>{
 const f=fixture();f.host.prepare=async prompt=>({prompt,estimate:{roundPromptTokens:estimateTokens(prompt),requestTokens:64001}});
 for(let ms=0;ms<120000;ms+=2000){f.time(ms);await f.e.tick();await flush();}
 assert.equal(f.recalls,0);assert.equal(f.runs.length,0);assert.equal(f.e.l.round,null);assert.equal(f.e.l.scheduler.reservations.length,0);assert.match(f.e.l.blocked,/完整请求/);assert.equal(f.sends,0);
});
test('first-stage denial and prepare errors cannot create recall side effects',async()=>{
 const blocked=fixture({idleEnabled:false});await blocked.e.tick();assert.equal(blocked.prepares,0);assert.equal(blocked.recalls,0);
 const failed=fixture();failed.host.prepare=async()=>{throw Error('synthetic preparation failure');};
 for(let ms=0;ms<12000;ms+=2000){failed.time(ms);await failed.e.tick();await flush();}
 assert.equal(failed.recalls,0);assert.equal(failed.runs.length,0);assert.equal(failed.e.l.scheduler.reservations.length,0);
});
test('only durable admitted rounds recall once, replacing the counted slot within the complete request budget',async()=>{
 const f=fixture();assert.ok(!f.e.prompt([],{}).includes(source));assert.equal(f.recalls,0);
 await f.e.tick();await flush();assert.equal(f.recalls,1);assert.equal(f.runs.length,1);
 const before=f.prepared[0].prompt,actual=f.runs[0].prompt;
 assert.ok(before.includes('[[fish-world-memory-reservation:v1]]'));assert.ok(!before.includes(source));assert.ok(actual.includes(source));assert.ok(!actual.includes('[[fish-world-memory-reservation'));assert.equal(f.runs[0].options.prompt,actual);
 assert.ok(estimateTokens(actual)+16000<=f.e.l.round.estimate.requestTokens);assert.equal(f.e.l.round.memoryStatus.status,'attached');assert.equal(f.e.l.round.memoryStatus.reservedTokens,800);
 assert.equal(estimateTokens(reserveMemoryPrompt('x'))-estimateTokens('x'),WORLD_MEMORY_RESERVED_TOKENS);
 const repeat=f.e.admittedPrompt(before,structuredClone(f.e.l.round));assert.equal(repeat,actual);assert.equal(f.recalls,1);assert.equal(f.sends,0);
});
test('missing or changed slot, oversized source and recall failures omit optional memory without submitting placeholder or exceeding admission',async()=>{
 for(const kind of ['missing','changed','oversized','invalid','error']){
  const f=fixture();let called=0;
  f.host.memory=()=>{called++;if(kind==='error')throw Error('synthetic recall failure');return kind==='invalid'?'source [[fish-world-memory-reservation:v1]]':'汉'.repeat(1000);};
  if(kind==='missing')f.host.prepare=async prompt=>({prompt:completeMemoryPrompt(prompt).prompt,estimate:{roundPromptTokens:estimateTokens(prompt),requestTokens:estimateTokens(prompt)+16000}});
  if(kind==='changed')f.host.prepare=async prompt=>({prompt:prompt+'changed-slot',estimate:{roundPromptTokens:estimateTokens(prompt+'changed-slot'),requestTokens:estimateTokens(prompt+'changed-slot')+16000}});
  await f.e.tick();await flush();assert.equal(called,['missing','changed'].includes(kind)?0:1);assert.equal(f.runs.length,1);
  assert.ok(!f.runs[0].prompt.includes('[[fish-world-memory-reservation'));assert.ok(!f.runs[0].prompt.includes('汉'.repeat(30)));assert.ok(estimateTokens(f.runs[0].prompt)+16000<=f.e.l.round.estimate.requestTokens);
  assert.equal(f.e.l.round.memoryStatus.status,{missing:'reservation-unavailable',changed:'reservation-unavailable',oversized:'over-budget',invalid:'invalid',error:'error'}[kind]);assert.equal(f.e.l.outbox.length,0);
 }
});
test('admitted same-round reuse deduplicates only still-visible full source and restores it after projection',async()=>{
 const f=fixture();await f.e.tick();await flush();const round=structuredClone(f.e.l.round),base=f.prepared[0].prompt;chooseWindow(f.e,'fixture');
 f.host.memoryVisible=()=>source;const repeated=f.e.admittedPrompt(base,round);assert.ok(!repeated.includes(source));assert.equal(f.e.l.round.memoryStatus.status,'already-visible');
 f.host.memoryVisible=()=> 'summary without full source';const restored=f.e.admittedPrompt(base,round);assert.ok(restored.includes(source));assert.equal(f.recalls,1);
 assert.ok(!JSON.stringify(f.e.l.contextWindow.packet).includes('[[fish-world-memory-reservation'));assert.ok(!JSON.stringify(f.e.l.contextWindow.packet).includes('synthetic-source'));
});
test('unadmitted direct prompt completion is recall-free and strips the reservation',()=>{
 const f=fixture(),prompt=reserveMemoryPrompt(f.e.prompt([],{id:'not-admitted',events:[]}));
 assert.ok(!f.e.admittedPrompt(prompt,{id:'not-admitted'}).includes('[[fish-world-memory-reservation'));assert.equal(f.recalls,0);
});
test('memory reservation uses the existing host budget rule and never enters the handoff file',async()=>{
 const f=fixture({backgroundContextEnabled:true}),prior=chooseWindow(f.e,'fixture');f.e.l.sessionId='session-fixture';f.e.l.contextWindow.windows.at(-1).sessionId='session-fixture';
 const outbox=structuredClone(f.e.l.outbox);
 const round={id:'near-limit',readOnly:false,events:[],planIds:[]},base=f.e.prompt([],round),toolsTokens=estimateTokens([]),target=64000-16000-toolsTokens-estimateTokens(base)-400;
 const overhead=Buffer.byteLength(JSON.stringify([{content:[{type:'text',text:''}]}]),'utf8'),messages=[{content:[{type:'text',text:'x'.repeat(target*2-overhead)}]}];
 const projectedBase=estimateTokens(base)+estimateTokens(messages)+toolsTokens+16000;assert.ok(projectedBase<=64000);assert.ok(projectedBase+800>64000);
 const agent={session:{id:'session-fixture',deriveMessages:()=>messages}},folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'memory-admission-'));
 const api={dsh:{get:n=>n==='tools'?{schemas:()=>[]}:null},dataDir:(...p)=>path.join(folder,...p)};
 const result=await prepareRequest(f.e,api,{scope:()=> 'fixture',identity:()=>({}),findAgent:()=>agent},reserveMemoryPrompt(base),round);
 assert.notEqual(result.windowKey,prior);assert.equal(result.estimate.visibleContextTokens,0);assert.ok(result.estimate.requestTokens<64000);assert.equal(f.recalls,0);
 const packet=fs.readFileSync(path.join(folder,'context-handoffs',result.windowKey.replaceAll(':','-')+'.json'),'utf8');assert.ok(!packet.includes('[[fish-world-memory-reservation'));assert.ok(!packet.includes('synthetic-source'));assert.ok(!packet.includes('old private body'));
 assert.deepEqual(f.e.l.outbox,outbox);assert.equal(f.sends,0);
});
