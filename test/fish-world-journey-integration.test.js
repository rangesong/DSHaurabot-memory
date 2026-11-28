import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import module from '../extensions/aurabot/fish-world/index.mjs';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {candidates} from '../extensions/aurabot/fish-world/governance.mjs';
const W='mcp__fish-world__world_',identity={owner:'synthetic-owner',persona:'synthetic-persona'},purpose={goal:'去合成商店买书并问老板',destination:'synthetic-shop',arrivalStep:'到达后核对现场书目并问老板，再购买需要的书'};
async function setup(t){
 const at=Date.now(),folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'journey-module-')),data={version:3,keyId:'',fishId:'fixture#1',cursor:'',recent:[],errors:{},at:{state:at},state:{fish:'fixture#1',where:{kind:'home'},doing:null},life:{...newLife(at),...identity}};
 fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify(data));const routes=new Map(),hooks={},guards=[],observers={},builders=[],disposers=[],mode={source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},text:'东西买了吗？',allOwner:true};
 const session={id:'synthetic-private',deriveMessages:()=>[{id:'current-user',role:'user',source:mode.source,content:[{type:'text',text:mode.text}]}]},agent={session,status:'idle',inbox:{hasPending:false,nextTurn:[],nextStep:[]},whenIdle:async()=>{}};
 const api={config:()=>({enabled:true,ownerQQ:identity.owner,persona:{current:identity.persona}}),settings:()=>({sharing:true}),dataDir:(...p)=>path.join(folder,...p),dsh:{get:n=>n==='tools'?{guard:fn=>(guards.push(fn),()=>{}),schemas:()=>worldNames.map(name=>({name}))}:n==='agents'?{get:()=>agent,list:()=>[]}:n==='sessionQuery'?{readSession:async()=>({events:[{type:'user/message',data:{id:mode.messageId??'current-user',role:'user',source:mode.source,content:[{type:'text',text:'【私聊】[14:45] Fixture('+identity.owner+')：'+mode.text}]}}]})}:null,on:(name,fn)=>((observers[name]??=[]).push(fn),()=>{})},core:{hub:{chatOfSession:()=>mode.route??'private:'+identity.owner,turnSendersAllOwner:()=>mode.allOwner},http:{body:async req=>req.body??{}}},on:(name,fn)=>hooks[name]=fn,context(){},tool:fn=>builders.push(fn),rule(){},command(){},route:(name,fn,options)=>routes.set(name,{fn,options}),every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:value=>value,log:{warn(){},info(){}},use:()=>null,think:async()=>assert.fail('No model calls')};
 const installed=await module.setup(api);t.after(async()=>{for(const off of disposers.reverse())await off();});
 const chat={kind:'private',chatId:'private:'+identity.owner,userId:identity.owner},tools=builders[0]({chat,level:'full',sessionId:session.id}),exec=(name,args={},id=name)=>({name,arguments:args,callId:id,agent});
 return {installed,mode,session,agent,chat,tools,hooks,guards,observers,routes,exec,tool:name=>tools.find(tool=>tool.name===name),read:()=>JSON.parse(fs.readFileSync(path.join(folder,'runtime.json'),'utf8'))};
}
test('a follow-up question can explicitly preserve its original purpose before private departure',async t=>{
 const f=await setup(t),go=f.exec(W+'go',{place:purpose.destination,by:'walk'},'actual-departure');
 assert.equal(f.read().life.journal.length,0);
 const registered=await f.tool('fish_life_journey').execute(purpose,f.exec('fish_life_journey'));assert.equal(registered.ok,true);
 for(const guard of f.guards)assert.equal(guard(go),undefined);
 for(const observe of f.observers['tools/result'])observe(go,{content:[{type:'text',text:'好的。14:01 出发：步行到合成商店，14:05 到合成商店。'}]});
 const saved=f.read(),task=saved.life.ownerTasks.find(t=>t.id===registered.task.id);assert.equal(task.phase,'travelling');assert.equal(task.journey.goal,purpose.goal);assert.equal(saved.life.journal.at(-1).ownerTaskId,task.id);
 f.hooks.prompt([{type:'text',text:'到了吗？'}],{chat:f.chat,senderId:identity.owner,sessionId:f.session.id,queryText:'到了吗？',turnToken:2});assert.equal(f.read().life.ownerTasks.find(t=>t.id===task.id).journey.arrivalStep,purpose.arrivalStep);
});

test('an owner can depart without task registration while the actual purpose is captured for continuation',async t=>{
 const f=await setup(t),text='下午去合成湖看看';f.mode.text=text;f.hooks.prompt([{type:'text',text}],{chat:f.chat,senderId:identity.owner,sessionId:f.session.id,queryText:text,turnToken:'direct-owner-purpose'});
 const go=f.exec(W+'go',{place:'synthetic-lake',by:'walk'},'direct-world-action');for(const guard of f.guards)assert.equal(guard(go),undefined);
 for(const observe of f.observers['tools/result'])observe(go,{content:[{type:'text',text:'好的。14:01 出发：步行到合成湖（4分钟），14:05 到合成湖。'}]});
 const saved=f.read(),task=saved.life.ownerTasks.find(t=>t.originalPurpose===text);assert.ok(task);assert.equal(task.phase,'travelling');assert.equal(task.instruction,text);assert.equal(saved.life.journal.at(-1).status,'confirmed');assert.equal(saved.life.journal.at(-1).ownerTaskId,task.id);
});

test('the panel purpose route restores only the current owner-private source with a turn-key check and no world dispatch',async t=>{
 const f=await setup(t),text='下午去合成湖看看';f.mode.text=text;f.mode.messageId='synthetic-message';f.hooks.prompt([{type:'text',text}],{chat:f.chat,senderId:identity.owner,sessionId:f.session.id,queryText:text,turnToken:'source-turn'});
 const context=f.read().life.ownerTaskContexts[f.session.id],route=f.routes.get('/purpose');assert.equal(route.options.access,'panel');
 const body={sessionId:f.session.id,expectedTurnKey:context.key,ownerText:text,sourceMessageId:'synthetic-message',journey:{goal:text,destination:'synthetic-lake',arrivalStep:'查看湖边现场',completionType:'observe'}};
 const result=await route.fn({method:'POST',body});assert.equal(result.ok,true);assert.equal(result.task.originalPurpose,text);assert.equal(result.task.ownerCompletionType,'observe');assert.equal(f.read().life.journal.length,0);assert.equal(f.read().life.outbox.length,0);
 await assert.rejects(()=>route.fn({method:'POST',body}),/新消息|目的/);
});

test('a foreign chat cannot use the panel restoration route to borrow owner purpose authority',async t=>{
 const f=await setup(t),before=f.read();f.mode.route='workbench:synthetic';
 await assert.rejects(()=>f.routes.get('/purpose').fn({method:'POST',body:{sessionId:f.session.id,expectedTurnKey:'synthetic',ownerText:'下午去合成湖看看',sourceMessageId:'synthetic-message',journey:purpose}}),/不是当前主人/);
 assert.deepEqual(f.read().life,before.life);
});
test('unrelated scheduled browsing can still read world state but cannot register or execute a journey',async t=>{
 const f=await setup(t);f.mode.source={kind:'schedule'};f.mode.text='reminders_json: '+JSON.stringify([{schedule_id:'web',occurrence_at:new Date().toISOString(),reminder_prompt:'去贴吧看看鱼世界攻略，不要买东西'}]);
 await assert.rejects(()=>f.tool('fish_life_journey').execute(purpose,f.exec('fish_life_journey')),/没有鱼世界行动授权/);
 assert.ok(f.guards.some(guard=>/行动来源/.test(guard(f.exec(W+'go',{place:purpose.destination}))||'')));
 const read=f.exec(W+'now',{},'read-only');for(const guard of f.guards)assert.equal(guard(read),undefined);for(const observe of f.observers['tools/result'])observe(read,{content:[{type:'text',text:'synthetic read-only state'}]});
 assert.equal(f.read().life.journal.at(-1).tool,W+'now');assert.equal(f.read().life.ownerTasks?.length||0,0);
});
test('a genuinely scoped world schedule uses an optional contract without borrowing owner status',async t=>{
 const f=await setup(t);f.mode.allOwner=false;f.mode.source={kind:'schedule'};f.mode.text='reminders_json: '+JSON.stringify([{schedule_id:'world',occurrence_at:new Date().toISOString(),reminder_prompt:'在鱼世界去超市买米，别买贵的'}]);
 const result=await f.tool('fish_life_journey').execute(purpose,f.exec('fish_life_journey'));assert.equal(result.ok,true);assert.equal(result.task.optional,true);assert.equal(result.task.priority,3);assert.equal(result.task.source.kind,'world-schedule');
});
test('same-turn control and a new journey are one purpose while daily planning survives temporary arrangements',()=>{
 let now=Date.parse('2026-11-27T14:00:00+08:00');const data={fishId:'fixture#1',at:{state:now},state:{where:{kind:'home'}},life:{...newLife(now),...identity}},e=new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{cancel:async()=>{}},clock:()=>now,identity:()=>identity});
 const daily=e.ownerTurn('你每天23:45规划明天在鱼的世界的安排',{sessionId:'private',turnToken:1});now++;
 e.ownerTurn('东西买了吗？',{sessionId:'private',turnToken:2});e.control('plan','去合成商店买书');const registered=e.journey(purpose,{sessionId:'private'});
 assert.equal(e.l.queue.filter(q=>q.kind==='owner'&&q.status==='pending').length,0,'same-turn synthetic control cannot replay the purpose');
 e.control('plan','去合成商店买书再问老板',{sessionId:'private'});assert.equal(e.l.ownerTasks.find(t=>t.id===registered.task.id).status,'active');assert.equal(daily.status,'active');
 now++;e.ownerTurn('先别去商店了',{sessionId:'private',turnToken:3});e.control('plan','先别去商店了',{sessionId:'private'});assert.equal(e.l.ownerTasks.find(t=>t.id===registered.task.id).status,'cancelled');assert.equal(daily.status,'active');
 now++;e.control('plan','不要规划回家路线，先在门口看看');assert.equal(daily.status,'active');e.control('plan','取消每天23:45的规划');assert.equal(daily.status,'cancelled');
});
test('an unfinished journey retains priority without suppressing other plans or fresh owner intent',()=>{
 const now=Date.parse('2026-11-27T14:00:00+08:00'),data={at:{state:now},state:{where:{kind:'home'}},life:{...newLife(now),...identity}},e=new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{},clock:()=>now,identity:()=>identity});
 const trip=e.journey(purpose,{sessionId:'owner'}).task;e.l.plans.push({id:'old-home',status:'pending',nextAt:now-1,goal:'旧行程回家'});e.l.queue.push({id:'old-owner',kind:'owner',t:now-10,notBefore:now-10,status:'pending'},{id:'urgent',kind:'work',t:now,notBefore:now,status:'pending',provenance:{trusted:true}});
 const all=candidates(e.l,data,e.cfg,now);assert.ok(all.some(t=>t.ownerTaskId===trip.id));assert.ok(all.some(t=>t.id==='urgent'));assert.equal(all.some(t=>t.id==='old-owner'),false);assert.equal(all.some(t=>t.id==='old-home'),true);assert.ok(all.findIndex(t=>t.ownerTaskId===trip.id)<all.findIndex(t=>t.id==='old-home'));
});
test('completed on-site observation can share a fresh real arrival but ordinary definition stays local',async()=>{
 for(const complete of [true,false]){
  let at=Date.parse('2026-11-27T14:10:00+08:00');const sent=[],data={fishId:'fixture#1',at:{state:at},state:{where:{kind:'place',place:{id:'synthetic-cinema',name:'合成影院'}},doing:null},life:{...newLife(at),...identity}},e=new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{remember:async()=>({ok:true}),send:async row=>{sent.push(row.id);return {message_id:'synthetic-qq-receipt'};}},clock:()=>at,identity:()=>identity,settings:()=>({sharing:true,quietStart:0,quietEnd:0})});
  const task=e.journey({goal:'去合成影院查看门口营业信息',destination:'synthetic-cinema',arrivalStep:'查看门口的营业信息',completionType:'observe'},{sessionId:'owner'}).task;at+=1000;
  const text='11-27 周五 14:10 · 晴 6°C\n你在：合成影院\n身体：精力充沛\n门口告示：今天营业中',r=e.l.round={id:'observation-round',sessionId:'background',ownerTaskId:task.id,kind:'owner-task',status:'running',startedAt:at-500,bucket:'idle',definitionOnly:true,readOnly:false,events:['fresh-arrival'],planIds:[],receipts:[{id:'now-proof',tool:W+'now',text,isError:false}],observation:text};
  e.l.queue.push({id:'fresh-arrival',kind:'arrive',text:'到了合成影院',t:at-500,receivedAt:at,status:'running',lastRoundId:r.id,ownerTaskIds:[task.id],provenance:{trusted:true,source:'world-notify'}});e.l.journal.push({id:'now-proof',tool:W+'now',status:'confirmed',round:r.id,sessionId:r.sessionId,at:at-400,finishedAt:at,args:'{}',result:text});
  if(complete)e.defineTask({id:task.id,expectedRevision:task.revision,action:'complete_observation',summary:'门口告示今天营业中',evidenceIds:['now-proof']},{sessionId:r.sessionId});
  e.finish({summary:'本地现场已核对',events:[{id:'fresh-arrival',status:'completed'}],facts:['now-proof'],shareFacts:['now-proof'],shareEventIds:['fresh-arrival'],importance:'important',share:'我到了影院门口，告示写着今天营业中。'});e.end(true);await e.deliver();assert.equal(sent.length,complete?1:0);assert.equal(e.l.outbox[0].state,complete?'sent':'suppressed');
 }
});
