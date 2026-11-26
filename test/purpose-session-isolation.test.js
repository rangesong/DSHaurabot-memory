import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PURPOSE_SESSION_PATCH,patchPurposeSession} from '../scripts/lib/purpose-session-patch.js';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const host=process.env.AURABOT_SOURCE||'D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq';
const sourceFile=process.env.AURABOT_HUB_BASELINE||path.join(host,'src/chat/hub.js');
const baselineBytes=fs.existsSync(sourceFile)?fs.readFileSync(sourceFile):Buffer.alloc(0);
const available=createHash('sha256').update(baselineBytes).digest('hex')===PURPOSE_SESSION_PATCH.before_sha256;
const active={skip:available?false:'Exact pre-repair source required via AURABOT_HUB_BASELINE'};
const scratch=testRuntimeRoot(null);
let copied,source,patched,createHub,createFakeDsh,normalize;
const neighbors=['system-turn-recovery.test.js','system-session-backoff.test.js','chat-time-poke.test.js','autotelic-preset.test.js','proactive-trace.test.js'];
if(available){
  assert.ok(scratch,'Run through node scripts/run-tests.js');
  copied=fs.mkdtempSync(path.join(scratch,'purpose-session-host-'));
  // Copy public program sources only; installed configuration, data and models never enter this fixture.
  fs.cpSync(path.join(host,'src'),path.join(copied,'src'),{recursive:true,filter:file=>!/(?:\.bak|\.old)(?:\.|$)/i.test(path.basename(file))});
  fs.mkdirSync(path.join(copied,'test/helpers'),{recursive:true});
  for(const name of ['helpers/fake-dsh.js',...neighbors])fs.copyFileSync(path.join(host,'test',name),path.join(copied,'test',name));
  fs.writeFileSync(path.join(copied,'package.json'),'{"type":"module"}\n');
  source=fs.readFileSync(sourceFile,'utf8');
  patched=patchPurposeSession(source,{version:PURPOSE_SESSION_PATCH.version}).source;
  fs.writeFileSync(path.join(copied,'src/chat/hub.js'),patched);
  ({createHub}=await import(pathToFileURL(path.join(copied,'src/chat/hub.js')).href));
  ({createFakeDsh}=await import(pathToFileURL(path.join(copied,'test/helpers/fake-dsh.js')).href));
  ({normalize}=await import(pathToFileURL(path.join(copied,'src/core/config.js')).href));
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<25;i++)await new Promise(setImmediate);};
function fixture(t,{brain=async()=> 'synthetic reply',noTools=true}={}){
  const dir=fs.mkdtempSync(path.join(scratch,'purpose-session-data-')),previous=process.env.AURABOT_DATA_DIR;
  process.env.AURABOT_DATA_DIR=dir;
  const cfg=normalize({enabled:true,dryRun:true,setupDone:true,ownerQQ:'10000001',botQQ:'20000002',
    persona:{current:'synthetic-persona'},workspaceDir:path.join(dir,'workspace'),voice:{enabled:false},
    stickers:{enabled:false},chat:{turnTimeoutMinutes:0},conversationContext:{enabled:false}});
  const observed=[],fake=createFakeDsh({brain:async input=>{observed.push(input);return brain(input);}}),created=[];
  fake.ctx.systemPrompt.variable('aurabot_persona',()=> 'synthetic stable persona');
  const controller=fake.ctx.services.sessionController,originalCreate=controller.create.bind(controller);
  controller.create=async args=>{
    const result=await originalCreate(args),agent=fake.agents.get(result.sessionId),followup=agent.followup.bind(agent);
    agent.inputs=[];let idle=Promise.resolve();
    agent.whenIdle=()=>idle;
    agent.cancel=()=>{};
    agent.followup=message=>{agent.inputs.push(message);idle=followup(message);return idle;};
    created.push(agent);return result;
  };
  const logs=[],hubOptions={dsh:fake.ctx,getConfig:()=>cfg,onebot:{call:async()=>({message_id:1})},
    contextProviders:[()=> 'synthetic runtime context'],buildTools:()=>[{name:'synthetic-tool'}],
    hooks:{model:()=>({provider:'fake',model:'m-owner',reasoningEffort:''})},
    log:Object.fromEntries(['info','warn','error','debug'].map(name=>[name,(...args)=>logs.push(args.join(' '))]))};
  let hub=createHub(hubOptions);
  const off=fake.ctx.on('session/event',(...args)=>hub.onSessionEvent(...args));
  t.after(()=>{hub.dispose();off();fake.dispose();if(previous===undefined)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=previous;});
  return{fake,cfg,created,observed,dir,logs,get hub(){return hub;},
    run:(text='synthetic current input',options={})=>hub.runSystemTurn('purpose','synthetic purpose',text,{timeoutMs:5000,noTools,...options}),
    mapping:()=>JSON.parse(fs.readFileSync(path.join(dir,'sessions.json'),'utf8')),
    restart:()=>{hub.dispose();hub=createHub(hubOptions);},
  };
}

test('purpose session patch rejects unknown versions and source hashes',()=>{
  assert.throws(()=>patchPurposeSession('synthetic',{version:'other'}),/version/);
  assert.throws(()=>patchPurposeSession('synthetic',{version:PURPOSE_SESSION_PATCH.version}),/hash/);
});

test('installed hub transformation is exact, idempotent, syntax-valid and tamper rejecting',active,()=>{
  const first=patchPurposeSession(source,{version:PURPOSE_SESSION_PATCH.version});
  const second=patchPurposeSession(first.source,{version:PURPOSE_SESSION_PATCH.version});
  assert.equal(first.changed,source!==first.source);assert.equal(second.changed,false);assert.equal(second.source,first.source);
  assert.throws(()=>patchPurposeSession(first.source+'\n',{version:PURPOSE_SESSION_PATCH.version}),/hash/);
  const check=spawnSync(process.execPath,['--check','--input-type=module'],{input:first.source,encoding:'utf8',windowsHide:true});
  assert.equal(check.status,0,check.stderr);
});

test('fresh history changes only the session while retaining persona, routing, context and logical key',active,async t=>{
  const f=fixture(t,{noTools:false});
  await f.run('synthetic old draft',{freshHistory:true});const old=f.created[0];
  await f.run('synthetic present material',{freshHistory:true});const current=f.created[1];
  assert.notEqual(current.session.id,old.session.id);assert.equal(current.inputs.length,1);
  assert.ok(!JSON.stringify(current.inputs).includes('old draft'));assert.equal(old.inputs.length,1);
  assert.equal(old.tools.size,0);assert.equal(old.contexts.size,0);assert.ok(current.tools.has('synthetic-tool'));
  assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[old.session.id]);
  assert.deepEqual(Object.keys(f.mapping().chats),['system:purpose']);
  assert.equal(f.mapping().chats['system:purpose'].sessionId,current.session.id);
  assert.ok(f.observed.every(row=>row.persona==='synthetic stable persona'&&row.ctxText==='synthetic runtime context'));
  assert.ok(current.events.some(event=>event.type==='model/selection'&&event.data.model==='m-owner'));
  assert.equal(f.hub.systemSessionCooldown('purpose'),null);
  assert.equal(f.hub.purposeSessionPatchVersion,1);
  assert.equal(Object.getOwnPropertyDescriptor(f.hub,'purposeSessionPatchVersion').set,undefined);
});

test('default and non-boolean fresh flags retain existing background session reuse',active,async t=>{
  const f=fixture(t);await f.run('synthetic one');await f.run('synthetic two',{freshHistory:false});await f.run('synthetic three',{freshHistory:'true'});
  assert.equal(f.created.length,1);assert.equal(f.created[0].inputs.length,3);assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[]);
});

test('friend logical keys and owner history are isolated without a new key per turn',active,async t=>{
  const f=fixture(t);await f.run('synthetic owner',{freshHistory:true});await f.run('synthetic friend A',{key:'10000003',freshHistory:true});await f.run('synthetic friend B',{key:'10000004',freshHistory:true});
  const [owner,a,b]=f.created;await f.run('synthetic friend A new',{key:'10000003',freshHistory:true});
  assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[a.session.id]);
  const entries=f.mapping().chats;assert.equal(entries['system:purpose'].sessionId,owner.session.id);assert.equal(entries['system:purpose:10000004'].sessionId,b.session.id);
  assert.notEqual(entries['system:purpose:10000003'].sessionId,a.session.id);assert.equal(Object.keys(entries).length,3);
});

test('fresh history also rotates a persisted session after the hub restarts',active,async t=>{
  const f=fixture(t);await f.run('synthetic before restart');const old=f.created[0];f.restart();
  await f.run('synthetic after restart',{freshHistory:true});assert.equal(f.created.length,2);
  assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[old.session.id]);assert.ok(!JSON.stringify(f.created[1].inputs).includes('before restart'));
});

test('rotation waits for idle and archive under the same logical-key start lock',active,async t=>{
  const f=fixture(t);await f.run();const old=f.created[0],idle=deferred(),archive=deferred();let archiveCalls=0;
  old.whenIdle=()=>idle.promise;
  f.fake.ctx.workspaceRegistry.archiveSession=async()=>{archiveCalls++;await archive.promise;};
  const next=f.run('synthetic new',{freshHistory:true});await settle();
  assert.equal(f.created.length,1);assert.equal(archiveCalls,0);await assert.rejects(f.run('synthetic concurrent',{freshHistory:true}),/上一轮还没结束/);
  idle.resolve();await settle();assert.equal(archiveCalls,1);assert.equal(f.created.length,1);assert.equal(old.contexts.size,1);
  archive.resolve();assert.equal(await next,'synthetic reply');assert.equal(f.created.length,2);assert.equal(old.contexts.size,0);
});

test('archive refusal fails closed, retains the mapping and observes cooldown before retry',active,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t);await f.run();const old=f.created[0];let refused=true;
  f.fake.ctx.workspaceRegistry.archiveSession=async id=>{if(refused)return{ok:false,message:'synthetic archive refusal'};f.fake.ctx.workspaceRegistry.archivedSessionIds.push(id);};
  await assert.rejects(f.run('synthetic refused',{freshHistory:true}),/synthetic archive refusal/);
  assert.equal(f.created.length,1);assert.equal(f.mapping().chats['system:purpose'].sessionId,old.session.id);assert.equal(old.contexts.size,1);
  await assert.rejects(f.run('synthetic cooldown',{freshHistory:true}),/冷却中/);assert.equal(f.created.length,1);
  t.mock.timers.tick(2*60_000);refused=false;await f.run('synthetic retry',{freshHistory:true});assert.equal(f.created.length,2);
});

test('missing idle capability and bounded idle timeout cannot reuse old history or start another turn',active,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const f=fixture(t);await f.run();const old=f.created[0];delete old.whenIdle;
  await assert.rejects(f.run('synthetic unsupported',{freshHistory:true}),/等待旧后台会话停止的能力/);assert.equal(f.created.length,1);
  t.mock.timers.tick(2*60_000);old.whenIdle=()=>new Promise(()=>{});
  const next=f.run('synthetic stuck',{freshHistory:true}).catch(error=>error);await settle();t.mock.timers.tick(15_000);
  assert.match((await next).message,/等待旧后台会话停止超时/);assert.equal(f.created.length,1);assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[]);
});

test('late old-session events cannot resolve or alter the new purpose turn',active,async t=>{
  const gate=deferred(),f=fixture(t,{brain:async({text})=>text.includes('wait-for-new')?gate.promise:'synthetic first'});
  await f.run();const old=f.created[0];let finished=false;
  const next=f.run('synthetic wait-for-new',{freshHistory:true}).then(value=>{finished=true;return value;});await settle();
  f.fake.emit('session/event',old.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'synthetic stale result'}]}}});
  f.fake.emit('session/event',old.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});await settle();assert.equal(finished,false);
  gate.resolve('synthetic current result');assert.equal(await next,'synthetic current result');assert.equal(f.created.length,2);
});

test('a timed-out fresh turn recovers before rotating, without bypassing the grace period or late old output',active,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const gate=deferred();let attempts=0;
  const f=fixture(t,{brain:async()=>++attempts===1?gate.promise:'synthetic recovered result'});
  const first=f.run('synthetic timeout',{freshHistory:true,timeoutMs:10}).catch(error=>error);await settle();
  const old=f.created[0];old.cancel=()=>gate.resolve('synthetic late cancelled body');
  t.mock.timers.tick(10);assert.match((await first).message,/等太久/);
  await assert.rejects(f.run('synthetic cooldown',{freshHistory:true}),/冷却中/);assert.equal(f.created.length,1);
  t.mock.timers.tick(2*60_000);await assert.rejects(f.run('synthetic grace',{freshHistory:true}),/上一轮还没结束/);
  t.mock.timers.tick(3*60_000);assert.equal(await f.run('synthetic recovery',{freshHistory:true}),'synthetic recovered result');
  assert.equal(f.created.length,2);assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[old.session.id]);
  assert.equal(old.contexts.size,0);assert.ok(!JSON.stringify(f.created[1].inputs).includes('cancelled body'));
});

test('a mapping changed during archive cannot be overwritten or reused by the fresh turn',active,async t=>{
  const f=fixture(t);await f.run();const old=f.created[0],archive=deferred();
  f.fake.ctx.workspaceRegistry.archiveSession=()=>archive.promise;
  const next=f.run('synthetic race',{freshHistory:true}).catch(error=>error);await settle();
  const map=f.mapping();map.chats['system:purpose'].sessionId='synthetic-other-session';map.chats['system:purpose'].sessions.live='synthetic-other-session';
  fs.writeFileSync(path.join(f.dir,'sessions.json'),JSON.stringify(map));archive.resolve();
  assert.match((await next).message,/后台会话映射已改变/);assert.equal(f.created.length,1);assert.equal(old.contexts.size,1);
  assert.equal(f.mapping().chats['system:purpose'].sessionId,'synthetic-other-session');
});

test('fresh rotation preserves the other debug/live slot and never resumes the archived history',active,async t=>{
  const f=fixture(t);await f.run('synthetic live');const live=f.created[0];
  f.cfg.debug=true;await f.run('synthetic debug');const debug=f.created[1];
  f.cfg.debug=false;await f.run('synthetic new live',{freshHistory:true});const current=f.created[2];
  assert.notEqual(current.session.id,live.session.id);assert.deepEqual(f.fake.ctx.workspaceRegistry.archivedSessionIds,[live.session.id]);
  assert.equal(f.mapping().chats['system:purpose'].sessions.debug,debug.session.id);
  f.cfg.debug=true;await f.run('synthetic same debug');assert.equal(f.created.length,3);assert.equal(debug.inputs.length,2);
});

test('existing real-hub recovery, cooldown, preset, time and send-bridge regressions pass in managed scratch',active,()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'purpose-session-neighbors-'));
  const env={...process.env,AURABOT_DATA_DIR:path.join(temp,'data'),AURABOT_WORKSPACE:path.join(temp,'workspace'),TMP:temp,TEMP:temp,TMPDIR:temp};
  // Node marks test worker children; propagating it would silently skip this independent runner.
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',...neighbors.map(name=>path.join(copied,'test',name))],{
    cwd:copied,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,
    env,
  });
  const report=path.join(path.dirname(scratch),'..','..','test-reports',path.basename(path.dirname(scratch)),'purpose-session-neighbor-tests.log');
  fs.writeFileSync(report,(result.stdout||'')+(result.stderr||''));
  assert.equal(result.status,0,result.error?.message||result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/tests\s+[1-9]\d*/);assert.doesNotMatch(result.stderr,/skipping running files/);
});
