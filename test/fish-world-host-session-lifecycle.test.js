import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../extensions/aurabot/fish-world/host-runtime.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
const id='11111111-2222-4333-8444-555555555555',alias='session-'+id;
const missing=(sessionId=id,code='session/not-found')=>Object.assign(Error('synthetic remote failure'),{isDSHRemoteError:true,code,details:{sessionId}});
const idleAgent=(sessionId=id)=>({session:{id:sessionId},status:'idle',inbox:{hasPending:false,nextTurn:[],nextStep:[]},whenIdle:async()=>{},cancel:()=>{}});
function fixture(options={}){
 const calls=[],agent=idleAgent();
 const adapter=runtime.createHostAgentLifecycle({findAgent:options.findAgent||(()=>null),listAgents:options.listAgents||(()=>[]),ownsSession:options.ownsSession||(()=>true),resolveAgent:async sid=>{calls.push(sid);if(options.error)throw options.error;return options.result===undefined?{agent}:options.result;}});
 return {adapter,calls,agent};
}
test('cold resolve canonicalizes SDK IDs and still rejects a foreign returned session',async()=>{
 const f=fixture();assert.equal(await f.adapter.resolve(alias),f.agent);assert.deepEqual(f.calls,[id]);
 const prefixed=fixture({result:{agent:idleAgent(alias)}});assert.equal((await prefixed.adapter.resolve(id)).session.id,alias);
 const foreign=fixture({result:{agent:idleAgent('different-session')}});await assert.rejects(()=>foreign.adapter.resolve(alias),/会话|session/i);
 const cached=fixture({findAgent:()=>idleAgent(alias)});assert.equal(await cached.adapter.ready(id),true);assert.deepEqual(cached.calls,[]);
});
test('only exact typed absent owned sessions with a complete registry are stopped, never ready',async()=>{
 const f=fixture({result:{error:missing()}});await f.adapter.cancel(alias);assert.equal(await f.adapter.idle(alias),true);assert.equal(await f.adapter.ready(alias),false);
 assert.deepEqual(f.calls,[id,id,id]);
 for(const options of [
  {error:missing(id,'session/writer-held')},{error:missing(id,'gateway/internal')},{error:Error('session/not-found')},
  {error:Object.assign(Error('not the SDK details shape'),{code:'session/not-found',data:{sessionId:id}})},
  {error:Object.assign(Error('not a typed remote error'),{code:'session/not-found',details:{sessionId:id}})},
  {error:missing('different-session')},{error:missing(),ownsSession:()=>false},{error:missing(),listAgents:()=>null},
  {error:missing(),listAgents:()=>[{}]},{error:missing(),listAgents:()=>[idleAgent(alias)]},
 ]){const g=fixture(options);await assert.rejects(()=>g.adapter.cancel(alias));await assert.rejects(()=>g.adapter.idle(alias));}
});
test('live agents retain cancellation and stable-idle checks; a missing resolver is not proof',async()=>{
 const log=[],agent=idleAgent(alias);agent.cancel=(reason,options)=>log.push({reason,options});agent.whenIdle=async()=>log.push('idle');
 const f=fixture({result:{agent}});await f.adapter.cancel(alias);assert.deepEqual(log,[{reason:{kind:'user'},options:{keepInbox:false}},'idle']);
 agent.inbox.hasPending=true;assert.equal(await f.adapter.idle(alias),false);assert.equal(await f.adapter.ready(alias),false);
 const absent=runtime.createHostAgentLifecycle({findAgent:()=>null,listAgents:()=>[],ownsSession:()=>true});
 await assert.rejects(()=>absent.idle(alias));assert.equal(await absent.idle(''),true);
});
test('stopping a vanished agent ends its empty round as uncertain and preserves every unknown world receipt',async()=>{
 const at=Date.parse('2026-11-27T22:00:00+08:00'),data={fishId:'synthetic#1',life:newLife(at),at:{state:at},state:{}};
 Object.assign(data.life,{owner:'synthetic-owner',persona:'synthetic',sessionId:alias,recovery:true});
 data.life.journal.push({id:'unknown-action',round:'old',sessionId:alias,tool:'mcp__fish-world__world_do',args:'{"id":"synthetic"}',status:'uncertain'});
 data.life.outbox.push({id:'previous-share',state:'uncertain',text:'synthetic',owner:'synthetic-owner',persona:'synthetic'});
 data.life.round={id:'empty-recovery',sessionId:alias,kind:'recovery',status:'uncertain',revision:data.life.revision,startedAt:at,events:[],planIds:[],receipts:[],calls:0,readOnly:true};
 const before=structuredClone(data.life.journal[0]),outbox=structuredClone(data.life.outbox),bridge={data,change:fn=>fn(data)};
 const lifecycle=runtime.createHostAgentLifecycle({findAgent:()=>null,listAgents:()=>[],ownsSession:sid=>runtime.ownSession(data.life,sid),resolveAgent:async sid=>({error:missing(sid)})});
 const engine=new LifeEngine({bridge,host:lifecycle,clock:()=>at+1000,identity:()=>({owner:'synthetic-owner',persona:'synthetic'}),settings:()=>({})});
 await engine.tickOnce();assert.equal(engine.l.round,null);assert.equal(engine.l.recovery,true);assert.deepEqual(engine.l.journal.find(j=>j.id==='unknown-action'),before);assert.deepEqual(engine.l.outbox,outbox);
 assert.equal(engine.l.journal.find(j=>j.id==='empty-recovery').status,'uncertain');
});
