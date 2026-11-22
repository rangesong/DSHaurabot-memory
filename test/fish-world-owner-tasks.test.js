import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife,enqueue} from '../extensions/aurabot/fish-world/state.mjs';
import {candidates,admission} from '../extensions/aurabot/fish-world/governance.mjs';
import {carryForward,chooseWindow,windowPrompt} from '../extensions/aurabot/fish-world/world-window.mjs';
import {defineOwnerTask,advanceOwnerTasks,endOwnerTaskRound,ownerTaskSnapshot,worldToolName} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const W='mcp__fish-world__world_',start=Date.parse('2026-11-22T15:00:00+08:00');
function fixture(){let now=start,calls=0;const identity={owner:'fixture-owner',persona:'fixture'},data={version:3,fishId:'fixture#1',state:{where:{kind:'home'}},at:{state:now},life:newLife(now)};
 Object.assign(data.life,identity);const bridge={data,identityReady:true,change(fn){const before=structuredClone(data);try{return fn(data);}catch(e){Object.assign(data,before);throw e;}}};
 const host={cancel:async()=>{},idle:async()=>true,ready:async()=>true,run:async()=>{calls++;}};
 const e=new LifeEngine({bridge,host,clock:()=>now,settings:()=>({backgroundContextEnabled:true,sharing:false}),identity:()=>identity});
 const owner={session:{id:'owner-session'}},bg={session:{id:'background-session'}};
 const turn=(text,token=now)=>e.ownerTurn(text,{sessionId:owner.session.id,turnToken:token});
 const execute=(name,args,text='合成成功',isError=false,agent=owner)=>{const exec={name:W+name,arguments:args,callId:'call-'+e.l.journal.length,agent};const reason=e.guard(exec,agent===bg,agent===owner);if(reason)return {reason,exec};e.result(exec,{isError,content:[{type:'text',text}]});return {exec};};
 return {e,bridge,data,owner,bg,host,turn,execute,time(t){now=t;},get now(){return now;},get calls(){return calls;}};
}
const travel=f=>f.execute('go',{place:'canteen'},'好的。15:02 出发：步行到合成食堂（8 分钟），15:10 到合成食堂。');
function arrive(f,t=start+600000){f.time(t);enqueue(f.data,{kind:'arrive',text:'到了合成食堂',t},t);}
function background(f,task){f.e.l.round={id:'background-round',sessionId:f.bg.session.id,status:'running',kind:'owner-task',bucket:'work',priority:0,revision:f.e.l.revision,startedAt:f.now,receipts:[],calls:0,events:[],planIds:[],ownerTaskId:task.id,observation:'合成现场',identityConfirmed:true};}

test('a current owner command persists without model registration, while quotes questions and casual chat do not become tasks',()=>{
 const f=fixture();for(const text of ['比如去食堂打工','他说去食堂打工','你说去食堂打工','你去过食堂吗','去食堂怎么样？','今天别打工了','你不要去打工','你好'])assert.equal(f.turn(text),null,text);
 const t=f.turn('你出门打个工去');assert.equal(t.instruction,'你出门打个工去');assert.equal(t.finalAction.arguments.id,'work');assert.equal(t.source.kind,'current-owner-prompt');assert.equal(f.e.l.ownerTasks.length,1);
 assert.equal(f.turn('你出门打个工去'),null);assert.equal(f.e.l.ownerTasks.length,1);f.turn('你好');assert.equal(f.e.l.ownerTaskContexts['owner-session'].taskId,null);assert.equal(f.e.l.ownerTasks[0].status,'active');
});

test('the real failure chain keeps work pending after travel, rejects premature work locally and links the arrival',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');assert.equal(travel(f).reason,undefined);assert.equal(t.phase,'travelling');assert.equal(t.destination.id,'canteen');
 const prior=f.e.l.journal.length,early=f.execute('do',{id:'work'});assert.match(early.reason,/仍在路上/);assert.equal(f.e.l.journal.length,prior);
 arrive(f);const q=f.e.l.queue.at(-1);assert.equal(q.status,'pending');assert.deepEqual(q.ownerTaskIds,[t.id]);assert.equal(t.phase,'ready');assert.equal(t.status,'active');assert.equal(t.nextStep,'你出门打个工去');
 const all=candidates(f.e.l,f.data,f.e.cfg,f.now);assert.equal(all[0].ownerTaskId,t.id);assert.equal(all[0].bucket,'work');assert.deepEqual(all[0].group.map(q=>q.id),[q.id]);
});

test('an unrelated, old or duplicate arrival never advances a task',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');travel(f);
 enqueue(f.data,{kind:'arrive',text:'到了其他地方',t:start+1},start+1);enqueue(f.data,{kind:'arrive',text:'到了合成食堂',t:start-1},start+1);assert.equal(t.phase,'travelling');
 arrive(f);const rev=t.revision;arrive(f);assert.equal(t.revision,rev);assert.equal(t.status,'active');
});

test('fresh exact destination state can recover a missed arrival, never clock-only or stale/transit/other-place state',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');travel(f);f.time(start+600000);
 for(const state of [{where:{kind:'trip',place:{id:'canteen'}}},{where:{kind:'place',place:{id:'elsewhere'}}}]){f.data.state=state;f.data.at.state=f.now;advanceOwnerTasks(f.e.l,f.data,f.now);assert.equal(t.phase,'travelling');}
 f.data.state={where:{kind:'place',place:{id:'canteen'}}};f.data.at.state=start;advanceOwnerTasks(f.e.l,f.data,f.now);assert.equal(t.phase,'travelling');
 f.data.at.state=f.now;advanceOwnerTasks(f.e.l,f.data,f.now);assert.equal(t.phase,'ready');assert.equal(t.arrivalState.placeId,'canteen');assert.equal(t.status,'active');
});

test('work cannot be replaced by food, and a started shift waits for its own real settlement',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');travel(f);arrive(f);background(f,t);
 f.execute('now',{},'合成现场：work 0 贝；buy-lunch 0 贝',false,f.bg);f.execute('profile',{},'fixture#1',false,f.bg);
 let approved=f.e.intent({tool:'world_do',arguments:'{"id":"buy-lunch"}',category:'daily',cost:0,evidence:'buy-lunch 0 贝'}).arguments;
 assert.match(f.execute('do',approved,'合成饭',false,f.bg).reason,/不能替代/);assert.equal(t.phase,'ready');
 approved=f.e.intent({tool:'world_do',arguments:'{"id":"work"}',category:'work',cost:0,evidence:'work 0 贝'}).arguments;
 assert.equal(f.execute('do',approved,'开始合成短工',false,f.bg).reason,undefined);assert.equal(t.phase,'working');assert.equal(t.status,'active');
 enqueue(f.data,{kind:'done',text:'吃饭结束了',t:f.now+1},f.now+1);assert.equal(t.status,'active');
 enqueue(f.data,{kind:'done',text:'工作结算：处理2件，工钱30贝',t:f.now+3600000},f.now+3600000);assert.equal(t.status,'completed');assert.equal(t.completedSteps.length,1);assert.ok(t.settlementEventId);
});

test('buy then return is a generic two-step contract: buying and departure do not complete the return',()=>{
 const f=fixture(),t=f.turn('请去合成商店买本书再回来');assert.equal(t.finalAction,null);assert.match(f.execute('go',{place:'shop'}).reason,/完整后续步骤/);
 defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book"}',nextStep:'买书'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'带书回家'}]},{sessionId:f.owner.session.id,now:f.now});
 f.execute('go',{place:'shop'},'15:10 到合成商店。');f.time(start+600000);enqueue(f.data,{kind:'arrive',text:'到了合成商店',t:f.now},f.now);assert.equal(t.phase,'ready');
 f.execute('do',{id:'buy-book'},'合成购买成功');assert.equal(t.stepIndex,1);assert.equal(t.status,'active');
 f.execute('go',{place:'home'},'15:20 到家。');assert.equal(t.status,'active');assert.equal(t.phase,'travelling');f.time(start+1200000);enqueue(f.data,{kind:'arrive',text:'到了家',t:f.now},f.now);
 assert.equal(t.status,'completed');assert.equal(t.completedSteps.length,2);assert.equal(t.instruction,'请去合成商店买本书再回来');
 assert.match(f.execute('go',{place:'home'}).reason,/已经有完整成功依据/);
});

test('an activity done contract waits for the exact trusted event before its next step',()=>{
 const f=fixture(),t=f.turn('请去图书馆看完书再回来');defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"read"}',nextStep:'读完合成书',waitFor:'done',eventText:'读合成书结束了'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'回家'}]},{sessionId:f.owner.session.id,now:f.now});
 f.execute('do',{id:'read'},'开始读合成书');assert.equal(t.phase,'waiting_event');assert.equal(t.stepIndex,0);
 enqueue(f.data,{kind:'done',text:'读其他书结束了',t:start+1},start+1);assert.equal(t.phase,'waiting_event');
 enqueue(f.data,{kind:'done',text:'读合成书结束了',t:start+2},start+2);assert.equal(t.stepIndex,1);assert.equal(t.phase,'pending');assert.equal(t.status,'active');
});

test('a changed step survives a round boundary while unrelated actions cannot count as task progress',()=>{
 const f=fixture(),t=f.turn('请去商店买书再回来');defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book"}',nextStep:'买书'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'回家'}]},{sessionId:f.owner.session.id,now:f.now});
 f.execute('do',{id:'buy-book'},'合成购买成功');endOwnerTaskRound(f.e.l,{id:'r1',ownerTaskId:t.id,startedAt:start,report:{summary:'买书成功，之后回家'}},true,start+1);assert.equal(t.phase,'pending');assert.ok(t.nextAt>=start+180001);
 endOwnerTaskRound(f.e.l,{id:'r2',ownerTaskId:t.id,startedAt:start+200000,report:{summary:'吃了点东西，回家未动'}},true,start+200001);assert.equal(t.phase,'waiting_evidence');assert.equal(t.status,'active');assert.equal(t.stepIndex,1);assert.equal(t.nextAt,0);
});

test('restart and a forced fresh window retain the original owner purpose and exact next action',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');travel(f);const restored=JSON.parse(JSON.stringify(f.data)),engine=new LifeEngine({bridge:{data:restored,change:fn=>fn(restored)},host:f.host,clock:()=>start+300000,identity:()=>({owner:'fixture-owner',persona:'fixture'})});
 chooseWindow(engine,'fixture');engine.l.contextWindow.windows.at(-1).sessionId='old-session';chooseWindow(engine,'fixture',{force:true});
 const snapshot=carryForward(engine,{},start+300000,{events:[],planIds:[]});assert.equal(snapshot.ownerTasks[0].instruction,'你出门打个工去');assert.equal(snapshot.ownerTasks[0].phase,'travelling');assert.equal(snapshot.ownerTasks[0].finalAction.arguments.id,'work');
 const prompt=windowPrompt(engine,'本轮任务快照：x',{identity:{},round:{events:[],planIds:[]},now:start+300000});assert.ok(prompt.includes(t.id));assert.ok(prompt.includes('你出门打个工去'));assert.ok(prompt.includes('canteen'));
});

test('unknown mutations cannot be repeated or redefined after a new round',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');f.execute('do',{id:'work'},'timeout: unknown synthetic result',true);assert.equal(t.phase,'uncertain');assert.equal(f.e.l.recovery,true);
 assert.match(f.execute('do',{id:'work'}).reason,/未确认变更/);assert.throws(()=>defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"work"}',nextStep:'上工'}]},{sessionId:f.owner.session.id,now:f.now}),/已提交步骤/);
 f.turn('你出门打个工去');assert.equal(f.e.l.ownerTasks.length,1);assert.equal(candidates({...f.e.l,recovery:false},f.data,f.e.cfg,f.now).some(c=>c.ownerTaskId===t.id),false);
});

test('future commands require an explicit schedule and preserve existing quotas and interval settings',()=>{
 const f=fixture(),t=f.turn('你明天去食堂打工');assert.equal(t.phase,'needs_definition');assert.match(travel(f).reason,/未来时间/);
 assert.throws(()=>defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"work"}',nextStep:'明天上工'}]},{sessionId:f.owner.session.id,now:f.now}),/未来时间/);
 defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,nextAt:start+86400000,steps:[{tool:'world_do',arguments:'{"id":"work"}',nextStep:'明天上工'}]},{sessionId:f.owner.session.id,now:f.now});assert.match(travel(f).reason,/未到/);
 const before=structuredClone(f.e.l.days);assert.equal(candidates(f.e.l,f.data,f.e.cfg,start+86399999).some(c=>c.ownerTaskId===t.id),false);assert.deepEqual(f.e.l.days,before);
 const c=candidates(f.e.l,f.data,f.e.cfg,start+86400000).find(c=>c.ownerTaskId===t.id);f.e.l.days['2026-11-23']={work:96};assert.equal(admission(f.e.l,c,f.e.cfg,{now:start+86400000}).budgetExhausted,true);assert.equal(f.e.cfg.workMs,600000);assert.equal(f.e.cfg.idleMs,1800000);
});

test('definitions reject foreign sessions, revisions, read-only final actions and substitution for a work step',()=>{
 const f=fixture(),t=f.turn('你出门打个工去'),base={id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"work"}',nextStep:'上工'}]};
 assert.throws(()=>defineOwnerTask(f.e.l,base,{sessionId:'foreign',now:f.now}),/当前主人任务/);assert.throws(()=>defineOwnerTask(f.e.l,{...base,expectedRevision:999},{sessionId:f.owner.session.id,now:f.now}),/版本/);
 for(const s of [{tool:'world_now',arguments:'{}',nextStep:'看一眼'},{tool:'world_do',arguments:'{"id":"eat"}',nextStep:'吃饭代替工作'}])assert.throws(()=>defineOwnerTask(f.e.l,{...base,steps:[s]},{sessionId:f.owner.session.id,now:f.now}));
 assert.equal(t.finalAction.arguments.id,'work');assert.deepEqual(t.completedSteps,[]);
});

test('while travelling or working, unrelated idle plans cannot interrupt the owner chain',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');travel(f);f.e.l.plans.push({id:'food-plan',revision:1,status:'pending',nextAt:start,goal:'合成吃饭'});f.e.l.nextIdle=start;
 assert.equal(candidates(f.e.l,f.data,f.e.cfg,start+300000).some(c=>c.planId==='food-plan'||c.kind==='idle'),false);assert.equal(ownerTaskSnapshot(f.e.l)[0].id,t.id);
});

test('native action names normalize only the exact fish-world aliases',()=>{
 assert.equal(worldToolName('world_do'),W+'do');assert.equal(worldToolName(W+'say'),W+'say');assert.equal(worldToolName('mcp__foreign__world_do'),'mcp__foreign__world_do');assert.equal(worldToolName('world_do-extra'),'world_do-extra');
});

test('an optional library suggestion does not interrupt an ongoing owner journey',()=>{
 const f=fixture(),work=f.turn('你出门打个工去');travel(f);background(f,work);const revision=f.e.l.revision;
 const optional=f.turn('你没事可以去图书馆看看书');assert.equal(optional.optional,true);assert.equal(f.e.l.round.status,'running');assert.equal(f.e.l.revision,revision);
 assert.equal(candidates(f.e.l,f.data,f.e.cfg,start+300000).some(c=>c.ownerTaskId===optional.id),false);assert.match(f.execute('go',{place:'library'}).reason,/不能打断/);
});

test('explicit renewed owner input can retry a known blocked task, while a repeated prompt token cannot',()=>{
 const f=fixture(),t=f.turn('你出门打个工去');endOwnerTaskRound(f.e.l,{id:'blocked',ownerTaskId:t.id,startedAt:start,report:{}},true,start+1);
 assert.equal(t.phase,'waiting_evidence');f.turn('你出门打个工去',start);assert.equal(t.phase,'waiting_evidence');f.time(start+600000);f.turn('你出门打个工去');assert.equal(t.phase,'pending');assert.equal(f.e.l.ownerTasks.length,1);assert.ok(t.nextAt>f.now);
});

test('a negative work instruction cancels only owner work tasks instead of creating another job',()=>{
 const f=fixture(),work=f.turn('你出门打个工去');f.turn('你没事可以去图书馆看看书');f.turn('你别去打工了');assert.equal(work.status,'cancelled');assert.equal(f.e.l.ownerTasks.length,2);assert.equal(f.e.l.ownerTasks[1].status,'active');assert.equal(work.history.at(-1).kind,'owner-cancelled');
});

test('a general instruction outside the known world domain cannot launch a fish round; an actual world invocation binds its purpose',()=>{
 const f=fixture();assert.equal(f.turn('帮我做一份报告'),null);assert.equal(f.e.l.ownerTasks,undefined);assert.ok(f.e.l.ownerTaskContexts['owner-session'].deferred);
 assert.equal(f.turn('请去办事处取东西再回来'),null);assert.match(f.execute('go',{place:'office'}).reason,/完整后续步骤/);assert.equal(f.e.l.ownerTasks[0].instruction,'请去办事处取东西再回来');assert.equal(f.e.l.ownerTasks[0].status,'active');
});

test('task business actions ignore model request IDs, retain completed prefixes and reject redeclaring an accomplished step',()=>{
 const f=fixture(),t=f.turn('请去商店买书再回来');defineOwnerTask(f.e.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book","request_id":"invented"}',nextStep:'买书'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'回家'}]},{sessionId:f.owner.session.id,now:f.now});
 f.execute('do',{id:'buy-book',request_id:'actual-program-id'},'合成购买成功');assert.equal(t.stepIndex,1);
 const revision=t.revision;assert.throws(()=>defineOwnerTask(f.e.l,{id:t.id,expectedRevision:revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book"}',nextStep:'又买一次'}]},{sessionId:f.owner.session.id,now:f.now}),/已完成步骤/);
 defineOwnerTask(f.e.l,{id:t.id,expectedRevision:revision,steps:[{tool:'world_go',arguments:'{"place":"home","by":"walk"}',nextStep:'走回家'}]},{sessionId:f.owner.session.id,now:f.now});assert.equal(t.stepIndex,1);assert.equal(t.steps[0].arguments.id,'buy-book');assert.equal(t.steps[1].arguments.by,'walk');
});

test('the scheduler waits for the owner conversation to become idle without launching a second agent',async()=>{
 const f=fixture();f.turn('你出门打个工去');f.host.ready=async()=>false;f.time(start+300000);f.data.at.state=f.now;await f.e.tick();assert.equal(f.calls,0);assert.equal(f.e.l.round,null);assert.match(f.e.l.blocked,/主人当前世界回合/);
});

test('the installed module owner prompt hook and actual tool surface persist a purpose before direct MCP travel',async()=>{
 const {default:module}=await import('../extensions/aurabot/fish-world/index.mjs'),f=fixture(),folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'owner-module-'));
 fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify({...f.data,keyId:'',cursor:'',recent:[],errors:{}}));
 const hooks={},guards=[],events={},builders=[],disposers=[],config={enabled:true,ownerQQ:'fixture-owner',persona:{current:'fixture'}};
 const defineTool=process.env.AURABOT_SOURCE?(await import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href)).defineTool:v=>v;
 const api={config:()=>config,settings:()=>({sharing:false}),dataDir:(...p)=>path.join(folder,...p),dsh:{get:n=>n==='tools'?{guard:fn=>(guards.push(fn),()=>{}),schemas:()=>worldNames.map(name=>({name}))}:n==='agents'?{list:()=>[],get:()=>null}:null,on:(name,fn)=>((events[name]??=[]).push(fn),()=>{})},core:{hub:{chatOfSession:()=> 'private:fixture-owner',turnSendersAllOwner:()=>true},http:{body:async()=>({})}},on:(name,fn)=>hooks[name]=fn,context:fn=>hooks.context=fn,tool:fn=>builders.push(fn),rule(){},command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool,log:{warn(){},info(){}},use:()=>null,think:async()=>assert.fail('No manufactured model calls')};
 const installed=await module.setup(api),content=[{type:'text',text:'original current owner input'}],info={chat:{kind:'private',userId:'fixture-owner'},senderId:'fixture-owner',sessionId:f.owner.session.id,queryText:'你出门打个工去',turnToken:1};
 assert.equal(hooks.prompt(content,{...info,chat:{kind:'group',userId:'fixture-owner'}}),content);assert.equal(installed.status().life.ownerTasks,undefined);
 assert.equal(hooks.prompt(content,info),content);const task=installed.status().life.ownerTasks[0];assert.equal(task.instruction,info.queryText);assert.ok(hooks.context(info).includes(task.id));
 const exec={agent:f.owner,callId:'real-private-go',name:W+'go',arguments:{place:'canteen'}};for(const guard of guards)assert.equal(guard(exec),undefined);for(const observe of events['tools/result'])observe(exec,{content:[{type:'text',text:'15:10 到合成食堂。'}]});
 const saved=JSON.parse(fs.readFileSync(path.join(folder,'runtime.json')));assert.equal(saved.life.ownerTasks[0].phase,'travelling');assert.equal(saved.life.journal.at(-1).ownerTaskId,task.id);assert.equal(saved.life.ownerTasks[0].finalAction.arguments.id,'work');
 const privateTools=builders[0]({...info,level:'full'});assert.ok(privateTools.some(t=>t.name==='fish_life_task'));assert.ok(privateTools.some(t=>t.name==='fish_world_state'));
 for(const off of disposers.reverse())await off();
});
