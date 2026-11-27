import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import module from '../extensions/aurabot/fish-world/index.mjs';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';
async function fixture(){
 const now=Date.now(),identity={owner:'synthetic-owner',persona:'synthetic'},folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'round-tools-'));
 const data={version:3,keyId:'',fishId:'synthetic#1',cursor:'',recent:[],skipped:0,state:{stage:'alive',fish:'synthetic#1'},now:'合成现场',at:{state:now},errors:{},life:{...newLife(now),...identity}};
 const pre=new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{},identity:()=>identity}),base=createHash('sha256').update(JSON.stringify([data.fishId,identity])).digest('hex').slice(0,24),route=chooseWindow(pre,base);
 pre.l.round={id:'synthetic-round',sessionId:'synthetic-session',status:'running',revision:pre.l.revision,events:[],startedAt:now,receipts:[],calls:0,observation:'合成现场'};
 fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify(data));
 const builders=[],disposers=[],agent={session:{id:'synthetic-session'},ctx:{tools:{restrict:()=>()=>{}}},status:'idle',inbox:{hasPending:false,nextTurn:[],nextStep:[]},cancel(){},whenIdle:async()=>{}};
 const api={config:()=>({enabled:true,ownerQQ:identity.owner,persona:{current:identity.persona}}),settings:()=>({}),dataDir:(...parts)=>path.join(folder,...parts),log:{warn(){},info(){}},
  dsh:{get:name=>name==='tools'?{guard:()=>()=>{},schemas:()=>worldNames.map(name=>({name}))}:name==='agents'?{get:()=>agent,list:()=>[agent]}:null,on:()=>()=>{}},
  core:{hub:{chatOfSession:()=> 'system:ext-fish-world:'+route,turnSendersAllOwner:()=>true}},use:()=>null,on(){},context(){},tool:fn=>builders.push(fn),rule(){},command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:v=>v};
 let engine;const change=LifeEngine.prototype.change;LifeEngine.prototype.change=function(...args){engine=this;return change.apply(this,args);};
 try{await module.setup(api);}finally{LifeEngine.prototype.change=change;}
 engine.change(l=>{l.round.status='running';l.recovery=false;});
 return {engine,agent,identity,tools:()=>builders[0]({chat:{kind:'system',chatId:'system:ext-fish-world:'+route},level:'full',sessionId:agent.session.id}),privateTools:()=>builders[0]({chat:{kind:'private',userId:identity.owner},level:'full',sessionId:agent.session.id}),close:async()=>{for(const dispose of disposers)await dispose();}};
}
test('an event/plan round without a bound owner task offers finish continuation instead of unrelated task definition',async()=>{
 const f=await fixture();try{const tools=f.tools();assert.equal(tools.some(t=>t.name==='fish_life_task'),false);const finish=tools.find(t=>t.name==='fish_life_finish');assert.match(finish.description,/planChanges/);assert.match(finish.description,/其他|别的/);assert.equal(f.privateTools().some(t=>t.name==='fish_life_task'),true);}finally{await f.close();}
});
test('only the current definable owner contract exposes task definition, including arrived observe journeys',async()=>{
 const f=await fixture();try{
  const set=patch=>f.engine.change(l=>{l.round.ownerTaskId='current';l.ownerTasks=[{id:'current',revision:1,status:'active',phase:'needs_definition',kind:'activity',owner:f.identity.owner,persona:f.identity.persona,history:[],...patch}];});
  set({});assert.equal(f.tools().some(t=>t.name==='fish_life_task'),true);
  for(const flag of ['readOnly','planningOnly','availabilityOnly']){f.engine.change(l=>{l.round[flag]=true;});assert.equal(f.tools().some(t=>t.name==='fish_life_task'),true,'local task definition remains available under '+flag);f.engine.change(l=>{l.round[flag]=false;});}
  set({kind:'journey',journey:{completionType:'observe',stage:'arrival-purpose',arrivedAt:Date.now()}});assert.equal(f.tools().find(t=>t.name==='fish_life_task').properties.action.enum.includes('complete_observation'),true);
  for(const patch of [{kind:'planning'},{phase:'travelling'},{phase:'working'},{phase:'waiting_event'},{phase:'uncertain'},{status:'completed'},{owner:'another-owner'},{kind:'journey',journey:{stage:'outbound'}}]){set(patch);assert.equal(f.tools().some(t=>t.name==='fish_life_task'),false,JSON.stringify(patch));}
 }finally{await f.close();}
});
test('finish schema lists exactly current queued required IDs and core still requires explicit truthful dispositions',async()=>{
 const f=await fixture();try{
  f.engine.change(l=>{l.round.events=['owner-one','owner-two','synthetic-no-queue'];l.queue=[{id:'owner-one',kind:'owner'},{id:'owner-two',kind:'owner'},{id:'other-round',kind:'owner'}];});
  const finish=f.tools().find(t=>t.name==='fish_life_finish'),events=finish.properties.events;
  assert.equal(events.minItems,2);assert.deepEqual(events.items.properties.id.enum,['owner-one','owner-two']);assert.match(events.description,/逐|每/);
  const input={summary:'合成核对',importance:'routine',facts:[],share:'',events:[]};await assert.rejects(()=>finish.execute(input,{agent:f.agent}),/缺少/);
  const actual=[{id:'owner-one',status:'blocked'},{id:'owner-two',status:'expired'}],ok=await finish.execute({...input,events:actual},{agent:f.agent});assert.equal(ok.ok,true);assert.deepEqual(f.engine.l.round.report.events,actual);
  assert.match(finish.properties.facts.items.description,/精确/);assert.match(finish.properties.facts.items.description,/说明|叙述/);
 }finally{await f.close();}
});
test('a round without queued obligations still permits an explicit empty events array',async()=>{
 const f=await fixture();try{const finish=f.tools().find(t=>t.name==='fish_life_finish');assert.equal(finish.properties.events.minItems,0);const result=await finish.execute({summary:'合成无待办',importance:'routine',facts:[],share:'',events:[]},{agent:f.agent});assert.equal(result.ok,true);}finally{await f.close();}
});
