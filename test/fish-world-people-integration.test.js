import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import fishModule from '../extensions/aurabot/fish-world/index.mjs';
import {createPeopleIntegration,createPeopleIdentityVerifier} from '../extensions/aurabot/fish-world/people-integration.mjs';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {API} from '../extensions/aurabot/fish-world/bridge.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const NOW=Date.parse('2026-11-26T12:00:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic-persona'},KEY='fwr_syntheticFixtureKey123456',sha=value=>createHash('sha256').update(value).digest('hex');
const historyText='合成同伴（私聊，2026-11-25 10:00）：\n> 我喜欢蓝色湖泊。第三鱼#999只是话题。\n合成自己（私聊，2026-11-25 10:01）：\n> 下次一起散步吧。\n—— 现在 2026-11-26 12:00';
const record=(id='history-a',extra={})=>({id,tool:'mcp__fish-world__world_history',args:JSON.stringify({fish:'合成同伴#321'}),status:'confirmed',isError:false,result:historyText,at:NOW-1000,finishedAt:NOW,sessionId:'synthetic-session',round:null,...extra});
const peerProfile=()=>record('profile-a',{tool:'mcp__fish-world__world_profile',args:'{"fish":"#321"}',result:'合成同伴#321\n> 合成公开自述。',at:NOW-2000,finishedAt:NOW-1500});
const folder=()=>fs.mkdtempSync(path.join(testRuntimeRoot(null),'fish-people-integration-'));

function localFixture(rows=[peerProfile(),record()]){
 const directory=folder(),who={...identity};let credential=KEY;
 const data={version:3,keyId:sha(KEY),fishId:'合成自己#1',state:{fish:'合成自己#1',stage:'alive'},life:{...newLife(NOW),...who,journal:structuredClone(rows)}};
 const bridge={data,identityReady:true,credential:()=>credential,change:fn=>fn(data)};
 const engine=new LifeEngine({bridge,host:{remember:async()=>({ok:true}),cancel:async()=>{},send:()=>assert.fail('no QQ')},identity:()=>who,clock:()=>NOW,settings:()=>({sharing:false})});
 const people=createPeopleIntegration({file:path.join(directory,'people.json'),bridge,getEngine:()=>engine,identity:()=>who,identityReady:()=>bridge.identityReady&&sha(credential)===data.keyId,apiOrigin:API,clock:()=>NOW});
 engine.host.recordPeople=round=>people.completeRound(round);
 return {directory,data,bridge,engine,people,who,key:value=>credential=value};
}

test('confirmed local journal bootstrap builds numbered peers and preserves every life ledger field',()=>{
 const f=localFixture(),before=structuredClone(f.engine.l);
 const list=f.people.list();assert.equal(list.ok,true);assert.equal(list.total,1);assert.equal(list.list[0].fish,'#321');
 const detail=f.people.detail('#321');assert.equal(detail.observations.length,3);assert.deepEqual(new Set(detail.observations.filter(o=>o.kind==='dialogue').map(o=>o.role)),new Set(['peer','self']));
 assert.ok(detail.observations.every(o=>o.historical));assert.ok(!detail.observations.some(o=>o.text.includes('—— 现在')));
 assert.equal(f.people.detail('#999').person,null,'third fish mentioned in body is not an interlocutor');
 assert.deepEqual(f.engine.l,before);assert.equal(fs.existsSync(path.join(f.directory,'people.json')),true);
});

test('a failed or unnumbered receipt cannot create a peer through names in its body',()=>{
 const f=localFixture([record('failed',{status:'failed',isError:true}),record('timeline',{args:'{}'}),record('uncertain',{status:'uncertain'})]);
 assert.equal(f.people.list().total,0);assert.deepEqual(f.engine.l.outbox,[]);
});

test('an unnumbered unknown speaker stays raw evidence until a verified public profile supplies its name',()=>{
 const f=localFixture([record()]),detail=f.people.detail('#321');assert.ok(detail.observations.some(o=>o.role==='unknown'));
 round(f);f.engine.end(true);assert.equal(f.people.detail('#321').impression.text,'');
});

test('actual result hooks ingest only their captured confirmed receipt, and rereading history adds no new business or support',()=>{
 const f=localFixture([]),exec={callId:'first',name:'mcp__fish-world__world_history',agent:{session:{id:'synthetic-session'}}};
 const one=record(exec.callId,{status:'executing',result:undefined,finishedAt:undefined});f.engine.l.journal.push(one);f.people.noteDispatch(exec);
 Object.assign(one,{status:'confirmed',result:historyText,finishedAt:NOW});assert.equal(f.people.noteResult(exec).ok,true);
 const initial=f.people.detail('#321'),firstTimes=initial.observations.map(o=>o.occurredAt).sort();
 const second=record('second',{status:'executing',result:undefined,finishedAt:undefined,at:NOW+60000});exec.callId='second';f.engine.l.journal.push(second);f.people.noteDispatch(exec);
 Object.assign(second,{status:'confirmed',result:historyText,finishedAt:NOW+61000});f.people.noteResult(exec);
 const later=f.people.detail('#321');assert.equal(later.total,initial.total);assert.deepEqual(later.observations.map(o=>o.occurredAt).sort(),firstTimes);
 assert.deepEqual(f.engine.l.outbox,[]);assert.deepEqual(f.engine.l.days,{});
});

test('credential rotation invalidates captured scopes even before the next world poll updates cached fish ID',()=>{
 const f=localFixture(),captured=f.people.capture();assert.equal(f.people.list().total,1);
 f.key('fwr_syntheticDifferentKey123');assert.throws(()=>f.people.lookup('#321',captured),/身份/);assert.equal(f.people.list().available,false);
 f.key(KEY);f.bridge.identityReady=false;assert.equal(f.people.list().available,false);
});

test('only a live authenticated binding persists across paused reload; legacy keyId with old state proves nothing',()=>{
 const directory=folder(),file=path.join(directory,'people-identity.json');let credential=KEY;
 const bridge={identityReady:true,data:{keyId:sha(KEY),fishId:'合成自己#1',state:{fish:'合成自己#1'},at:{state:Date.now()-1000},errors:{}}};
 const verify=()=>createPeopleIdentityVerifier({file,bridge,credential:()=>credential});
 assert.equal(verify()(),true);const proof=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(proof.schema,1);assert.equal(proof.keyHash,sha(KEY));assert.equal(proof.fishId,'#1');assert.ok(!fs.readFileSync(file,'utf8').includes(KEY));
 bridge.identityReady=false;assert.equal(verify()(),true);assert.equal(bridge.identityReady,false);
 credential='fwr_syntheticChangedKey123';bridge.data.keyId=sha(credential);assert.equal(verify()(),false,'new global keyId plus cached old fish cannot reuse the verified binding');
 const emptyFile=path.join(directory,'never-verified.json');assert.equal(createPeopleIdentityVerifier({file:emptyFile,bridge,credential:()=>credential})(),false);
 assert.equal(fs.existsSync(emptyFile),false,'unverified state never creates a binding');
});

test('unknown, malformed and cross-origin binding files stay unavailable and are not rewritten',()=>{
 for(const extra of [{schema:2},{keyHash:'wrong'},{fishId:'not-numbered'},{apiOrigin:'https://unrelated.example'}]){
  const file=path.join(folder(),'people-identity.json'),data={schema:1,apiOrigin:API,keyHash:sha(KEY),fishId:'#1',verifiedAt:Date.now()-1000,...extra};fs.writeFileSync(file,JSON.stringify(data));
  const before=fs.readFileSync(file,'utf8'),bridge={identityReady:false,data:{keyId:sha(KEY),fishId:'合成自己#1',state:{fish:'合成自己#1'}}};
  assert.equal(createPeopleIdentityVerifier({file,bridge,credential:()=>KEY})(),false);assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});

test('old owner, persona and self-fish captures cannot be used to read a new scope',()=>{
 for(const mutate of [f=>{f.who.owner='different-owner';},f=>{f.who.persona='different-persona';},f=>{f.data.fishId='合成另一自己#2';}]){
  const f=localFixture(),captured=f.people.capture();f.people.list();mutate(f);assert.throws(()=>f.people.lookup('#321',captured),/身份/);
 }
});

test('list and detail share a bounded scope token, and a valid identity switch changes it without exposing old records',()=>{
 const f=localFixture(),first=f.people.list(),detail=f.people.detail('#321');assert.match(first.scopeToken,/^[a-f0-9]{24}$/);assert.equal(detail.scopeToken,first.scopeToken);
 f.who.persona='synthetic-new-persona';assert.equal(f.people.list().scopeToken,null);assert.equal(f.people.detail('#321').scopeToken,null);
 f.data.life={...newLife(NOW),owner:f.who.owner,persona:f.who.persona};
 const next=f.people.list(),nextDetail=f.people.detail('#321');assert.match(next.scopeToken,/^[a-f0-9]{24}$/);assert.notEqual(next.scopeToken,first.scopeToken);
 assert.equal(nextDetail.scopeToken,next.scopeToken);assert.equal(next.total,0);assert.equal(nextDetail.person,null);
 f.key('fwr_syntheticRotatedKey12345');assert.equal(f.people.list().scopeToken,null);assert.equal(f.people.detail('#321').scopeToken,null);
});

function round(f,{id='round-a',peerImpressions=[{fish:'#321',text:'合成同伴自述喜欢蓝色湖泊。',sourceIds:['history-a']}]}={}){
 const r={id,sessionId:'synthetic-session',status:'running',revision:f.engine.l.revision,kind:'idle',bucket:'idle',priority:3,startedAt:NOW-2000,events:[],planIds:[],calls:0,observation:'合成当前现场',receipts:[{id:'history-a',tool:'mcp__fish-world__world_history',text:historyText,isError:false}]};
 f.engine.l.round=r;Object.assign(f.engine.l.journal.find(j=>j.id==='history-a'),{round:id,sessionId:r.sessionId});
 f.people.bindRound();f.engine.finish({summary:'合成回合完成',events:[],importance:'routine',facts:['history-a'],share:'',peerImpressions});return r;
}

test('finish only stages the candidate; valid end commits it after the completed round journal exists',()=>{
 const f=localFixture(),before=structuredClone(f.engine.l.days);round(f);
 assert.equal(f.people.detail('#321').impression.text,'');f.engine.end(true);
 assert.equal(f.people.detail('#321').impression.text,'合成同伴自述喜欢蓝色湖泊。');assert.equal(f.engine.l.round,null);
 assert.deepEqual(f.engine.l.outbox,[]);assert.deepEqual(f.engine.l.days,before);
});

test('failed completion and switched identity keep raw evidence but never commit a staged portrait',()=>{
 for(const stop of [f=>f.engine.end(false,'合成取消'),f=>{f.data.fishId='合成新自己#2';f.engine.end(true);},f=>{f.who.persona='different-persona';f.engine.end(true);}]){
  const f=localFixture();round(f);f.people.list();stop(f);
  const text=fs.readFileSync(path.join(f.directory,'people.json'),'utf8');assert.ok(!text.includes('"text": "合成同伴自述喜欢蓝色湖泊。"'));
 }
});

test('a foreign-round source or a different peer cannot license a portrait, while finish remains valid',()=>{
 for(const candidate of [{fish:'#321',text:'合成不合格候选',sourceIds:['old-call']},{fish:'#999',text:'合成另一个对象',sourceIds:['history-a']}]){
  const f=localFixture([record(),record('old-call',{round:'other-round'})]);round(f,{peerImpressions:[candidate]});f.engine.end(true);
  assert.equal(f.engine.l.journal.at(-1).status,'completed');assert.equal(f.people.detail('#321').impression.text,'');assert.equal(f.people.detail('#999').person,null);
 }
});

async function moduleFixture(t,{ready=true,queryParams=false,cached=true,stopped=false}={}){
 const directory=folder(),builders=[],hooks=new Map(),routes=new Map(),guards=[],disposers=[],masks=[];
 let engine,allOwner=true,routeOverride=null;
 const config={enabled:true,dryRun:false,debug:false,safeMode:false,ownerQQ:identity.owner,persona:{current:identity.persona},modules:{'fish-world':{enabled:true}}};
 const data={version:3,keyId:sha(KEY),fishId:'合成自己#1',state:{fish:'合成自己#1',stage:'alive'},recent:[],at:{state:cached?Date.now()-1000:0},errors:{},life:{...newLife(NOW),...identity,controls:stopped?{stopped:true}:{},journal:[peerProfile(),record()]}};
 fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify(data));fs.writeFileSync(path.join(directory,'credential.json'),JSON.stringify({key:KEY}));
 if(cached)fs.writeFileSync(path.join(directory,'people-identity.json'),JSON.stringify({schema:1,apiOrigin:API,keyHash:sha(KEY),fishId:'#1',verifiedAt:Date.now()-1000}));
 const ownerAgent={session:{id:'owner-session'},ctx:{tools:{restrict:scope=>{masks.push(scope);return()=>{};}}}},bgAgent={session:{id:'bg-session'},ctx:{tools:{restrict:scope=>{masks.push(scope);return()=>{};}}},cancel(){},whenIdle:async()=>{}};
 let bgChat='';const worldTools={guard:fn=>{guards.push(fn);return()=>{};},schemas:()=>worldNames.map(name=>({name}))};
 const hub={chatOfSession:id=>routeOverride??(id===ownerAgent.session.id?'private:'+config.ownerQQ:id===bgAgent.session.id?bgChat:''),turnSendersAllOwner:()=>allOwner};
 const api={config:()=>config,settings:()=>({autonomy:false,sharing:false}),dataDir:(...parts)=>path.join(directory,...parts),
  dsh:{get:name=>name==='tools'?worldTools:name==='agents'?{list:()=>[ownerAgent,bgAgent]}:null,on:(name,fn)=>{const list=hooks.get(name)||[];list.push(fn);hooks.set(name,list);return()=>{};}},
  lib:()=>({}),use:()=>null,on(){},context(){},tool:fn=>builders.push(fn),rule(){},command(){},route:(name,fn)=>routes.set(name,fn),every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:definition=>definition,
  core:{hub,http:{query:req=>queryParams?new URL(req.url,'http://synthetic').searchParams:Object.fromEntries(new URL(req.url,'http://synthetic').searchParams),body:()=>assert.fail('read-only people route must not read a mutation body')}},
  log:{info(){},warn(){}},send:()=>assert.fail('no QQ'),think:()=>assert.fail('no model'),proactive:{submit:()=>assert.fail('no proactive send')}};
 const original=LifeEngine.prototype.snapshot;LifeEngine.prototype.snapshot=function(...args){engine=this;return original.apply(this,args);};
 try{await fishModule.setup(api);}finally{LifeEngine.prototype.snapshot=original;}
 t.after(async()=>{for(const dispose of disposers.reverse())await dispose();});
 engine.bridge.identityReady=ready;
 const ownerChat={kind:'private',userId:identity.owner,chatId:'private:'+identity.owner};
 const owner=()=>builders.flatMap(fn=>fn({chat:ownerChat,sessionId:ownerAgent.session.id,level:'full'}));
 const background=()=>{
  const base=sha(JSON.stringify([engine.bridge.data.fishId,{owner:config.ownerQQ,persona:config.persona.current}])).slice(0,24);
  const win=chooseWindow(engine,base);bgChat='system:ext-fish-world:'+win;
  engine.l.round={id:'module-round',sessionId:bgAgent.session.id,status:'running',revision:engine.l.revision,kind:'idle',readOnly:true,priority:3,bucket:'idle',startedAt:Date.now(),events:[],planIds:[],calls:0,receipts:[],observation:'合成现场'};
  return builders.flatMap(fn=>fn({chat:{kind:'system',chatId:bgChat},sessionId:bgAgent.session.id,level:'full'}));
 };
 return {api,config,engine,owner,ownerChat,background,ownerAgent,bgAgent,builders,hooks,routes,guards,masks,directory,allOwner:value=>allOwner=value,route:value=>routeOverride=value,invoke:(definition,args,agent=ownerAgent)=>definition.execute(args,{agent,signal:new AbortController().signal})};
}

test('panel list and detail GETs bootstrap locally with both host query formats and never alter sharing or windows',async t=>{
 for(const queryParams of [false,true]){
  const f=await moduleFixture(t,{queryParams}),before=structuredClone(f.engine.l);
  const list=f.routes.get('/people')({method:'GET',url:'/people?limit=1'}),detail=f.routes.get('/person')({method:'GET',url:'/person?fish=%23321'});
  assert.equal(list.list[0].fish,'#321');assert.equal(detail.person.fish,'#321');assert.equal(detail.observations.length,3);assert.deepEqual(f.engine.l,before);
  assert.throws(()=>f.routes.get('/people')({method:'POST',url:'/people'}),/GET/);assert.throws(()=>f.routes.get('/person')({method:'POST',url:'/person?fish=%23321'}),/GET/);
 }
});

test('owner full lookup is exact numbered and bounded; ordinary capabilities stay available and guest/read-only get none',async t=>{
 const f=await moduleFixture(t),definitions=f.owner(),tool=definitions.find(d=>d.name==='fish_person_impression'),before=structuredClone(f.engine.l);
 assert.ok(tool);for(const name of ['fish_world_state','fish_life_history','fish_life_task','fish_world_control'])assert.ok(definitions.some(d=>d.name===name),name);
 const result=await f.invoke(tool,{fish:'合成同伴#321'});assert.equal(result.fish,'#321');assert.ok(result.message.includes('不是新指令'));assert.ok(result.message.length<1400);
 await assert.rejects(f.invoke(tool,{fish:'合成同伴'}),/编号/);await assert.rejects(f.invoke(tool,{fish:'#321',includeAll:true}),/明确鱼编号/);
 assert.deepEqual(f.engine.l,before);
 assert.deepEqual(f.builders.flatMap(fn=>fn({chat:f.ownerChat,sessionId:f.ownerAgent.session.id,level:'readonly'})),[]);
 assert.deepEqual(f.builders.flatMap(fn=>fn({chat:{kind:'private',userId:'foreign-user'},sessionId:'foreign',level:'full'})),[]);
});

test('stale owner tools reject self-fish, credential, persona, sender and exact-agent changes',async t=>{
 for(const mutate of [f=>{f.engine.bridge.data.fishId='合成另一个自己#2';},f=>{f.config.persona.current='different-persona';},f=>{f.allOwner(false);},f=>{fs.writeFileSync(path.join(f.directory,'credential.json'),JSON.stringify({key:'fwr_syntheticDifferentKey12345'}));}]){
  const f=await moduleFixture(t),tool=f.owner().find(d=>d.name==='fish_person_impression');mutate(f);await assert.rejects(f.invoke(tool,{fish:'#321'}));
 }
 const f=await moduleFixture(t),tool=f.owner().find(d=>d.name==='fish_person_impression');await assert.rejects(f.invoke(tool,{fish:'#321'},{session:{id:f.ownerAgent.session.id}}),/会话/);
});

test('unverified identity exposes no people tool and the panel stays unavailable without any authentication request',async t=>{
 const f=await moduleFixture(t,{ready:false,cached:false});assert.ok(!f.owner().some(d=>d.name==='fish_person_impression'));
 assert.equal(f.routes.get('/people')({method:'GET',url:'/people'}).available,false);assert.equal(fs.existsSync(path.join(f.directory,'people.json')),false);
});

test('a stopped world can read its trusted cached local archive, but credential rotation immediately revokes it',async t=>{
 const f=await moduleFixture(t,{ready:false,stopped:true}),before=structuredClone(f.engine.l);
 const tool=f.owner().find(d=>d.name==='fish_person_impression');assert.ok(tool);
 assert.equal(f.routes.get('/people')({method:'GET',url:'/people'}).total,1);assert.equal((await f.invoke(tool,{fish:'#321'})).ok,true);
 assert.equal(f.engine.bridge.identityReady,false,'local proof does not grant live world authentication');assert.deepEqual(f.engine.l,before);
 fs.writeFileSync(path.join(f.directory,'credential.json'),JSON.stringify({key:'fwr_syntheticRotatedKey12345'}));
 assert.equal(f.routes.get('/people')({method:'GET',url:'/people'}).available,false);await assert.rejects(f.invoke(tool,{fish:'#321'}));
});

test('verified owned background has a read-only people tool that consumes no world calls, quotas or shares',async t=>{
 const f=await moduleFixture(t),definitions=f.background(),tool=definitions.find(d=>d.name==='fish_person_impression');assert.ok(tool);
 const before=structuredClone(f.engine.l),value=await f.invoke(tool,{fish:'#321'},f.bgAgent);assert.equal(value.ok,true);assert.deepEqual(f.engine.l,before);
 assert.equal(f.guards.map(guard=>guard({name:'fish_person_impression',agent:f.bgAgent,arguments:{fish:'#321'}})).find(Boolean),undefined);
 f.route('system:foreign-world');await assert.rejects(f.invoke(tool,{fish:'#321'},f.bgAgent),/世界回合/);
});

test('the module result hook indexes the actual confirmed owner receipt without executing any world or send operation',async t=>{
 const f=await moduleFixture(t),exec={callId:'new-owner-history',name:'mcp__fish-world__world_history',arguments:{fish:'合成同伴#321'},agent:f.ownerAgent};
 for(const guard of f.guards)assert.equal(guard(exec),undefined);
 for(const hook of f.hooks.get('tools/result')||[])hook(exec,{content:[{type:'text',text:historyText}]});
 assert.equal(f.engine.l.journal.find(j=>j.id===exec.callId).status,'confirmed');assert.equal(f.routes.get('/people')({method:'GET',url:'/people'}).total,1);
 assert.deepEqual(f.engine.l.outbox,[]);assert.deepEqual(f.engine.l.days,{});
});
