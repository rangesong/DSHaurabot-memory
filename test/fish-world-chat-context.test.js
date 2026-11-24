import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chatWorldContext} from '../extensions/aurabot/fish-world/chat-context.mjs';
import fishModule from '../extensions/aurabot/fish-world/index.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';

const now=Date.parse('2026-11-23T12:00:00+08:00');
const state={time:'2026-11-23T12:00:00+08:00',stage:'live',where:{text:'合成公园',door:'不应自动注入的门牌'},weather:{sky:'晴',temp:13},body:{text:'饱了，精神很好',privateDetail:'不应自动注入的身体细节'},outfit:{name:'合成棉服',look:'棉服里面是白卫衣、黑裤'},doing:{text:'合成散步'},crew:[{text:'不应自动注入的其他鱼'}]};
const data={state,at:{state:now},now:'不应使用未分字段的完整状态',recent:[{text:'昨天的旧世界事件'}]};
const task=(id,extra={})=>({id,status:'active',phase:'waiting_evidence',instruction:'合成原要求，买完东西再回家',nextStep:'核对实际购物回执',createdAt:now,nextAt:now+600000,steps:[{text:'完整步骤不要常驻'}],source:{text:'完整源记录不要常驻'},...extra});
const parse=value=>JSON.parse(value.slice(value.indexOf('\n')+1,value.lastIndexOf('\n')));

test('ordinary chat projection keeps fresh state clothing and current task references without replaying plans or history',()=>{
  const life={ownerTasks:[task('task-current'),task('task-completed',{status:'completed'})],plans:[{status:'active',text:'旧完整计划不要常驻'}],journal:[{summary:'旧回合报告不要常驻'}],outbox:[{text:'旧分享不要常驻'}]};
  const before=structuredClone({data,life}),result=chatWorldContext(data,life,{now}),packet=parse(result);
  assert.equal(packet.current.fresh,true);assert.equal(packet.current.where,'合成公园');assert.equal(packet.current.body,'饱了，精神很好');assert.equal(packet.current.outfit.look,'棉服里面是白卫衣、黑裤');
  assert.deepEqual(packet.ownerTasks.map(t=>t.id),['task-current']);assert.deepEqual(packet.ownerTasks[0].historyReference,{kind:'tasks',id:'task-current'});
  assert.ok(!/旧完整计划|旧回合报告|旧分享|昨天的旧世界事件|完整步骤|完整源记录|门牌|其他鱼|身体细节/.test(result));assert.ok(result.includes('fish_life_history'));
  assert.deepEqual({data,life},before);
});

test('stale missing and future world observations do not become present location body or clothing facts',()=>{
  for(const at of [now-180001,undefined,now+1]){
    const packet=parse(chatWorldContext({...data,at:{state:at}},{ownerTasks:[task('still-pending')]},{now}));
    assert.equal(packet.current.fresh,false);assert.match(packet.current.note,/过时或尚不可用/);assert.equal(packet.current.where,undefined);assert.equal(packet.current.body,undefined);assert.equal(packet.current.outfit,undefined);assert.equal(packet.ownerTasks[0].id,'still-pending');
  }
  assert.equal(parse(chatWorldContext({...data,at:{state:now-180000}},{},{now})).current.fresh,true);
});

test('the real named activity schema retains original clock strings and companions beside its observation time',()=>{
  const doing={name:'吃白米饭',since:'11:55',until:'12:10',with:['合成同伴甲','合成同伴乙']};
  const input={...data,state:{...state,doing}},before=structuredClone(input),result=chatWorldContext(input,{}, {now}),packet=parse(result);
  assert.deepEqual(packet.current.doing,doing);assert.equal(packet.current.observedAt,new Date(now).toISOString());
  assert.match(result,/主人较新事实/);assert.match(result,/until不证明已完成/);assert.deepEqual(input,before);
  const full={...doing,since:'2026-11-23T11:55:00+08:00',until:'2026-11-23T12:10:00+08:00'};
  assert.deepEqual(parse(chatWorldContext({...data,state:{...state,doing:full}},{},{now})).current.doing,full);
  assert.equal(parse(chatWorldContext({...data,state:{...state,doing:'一起吃饭🐟'}},{},{now})).current.doing,'一起吃饭🐟');
});

test('a fresh explicit null means no main activity without claiming parallel activities or all tasks have ended',()=>{
  const result=chatWorldContext({...data,state:{...state,doing:null,side:[{name:'并行合成煮饭',until:'12:20'}]}},{ownerTasks:[task('still-active')]},{now}),packet=parse(result);
  assert.equal(Object.hasOwn(packet.current,'doing'),true);assert.equal(packet.current.doing,null);
  assert.match(result,/仅表示无当前主活动/);assert.match(result,/未展示的并行活动查完整状态/);
  assert.equal(packet.ownerTasks[0].id,'still-active');assert.ok(!result.includes('并行合成煮饭'));
});

test('legacy text and string activities remain visible while missing or malformed values never become idle',()=>{
  for(const doing of ['合成散步',{text:'合成散步'}])assert.equal(parse(chatWorldContext({...data,state:{...state,doing}},{},{now})).current.doing,'合成散步');
  for(const doing of [undefined,false,[],{},0,{name:''}])assert.equal(Object.hasOwn(parse(chatWorldContext({...data,state:{...state,doing}},{},{now})).current,'doing'),false);
  const overdue={name:'吃白米饭',since:'11:00',until:'11:10',with:[]};
  assert.deepEqual(parse(chatWorldContext({...data,state:{...state,doing:overdue}},{},{now})).current.doing,overdue,'the projector cannot infer completion from an elapsed clock string');
});

test('named and explicitly absent activities follow the original location switch and freshness gate',()=>{
  for(const doing of [{name:'吃白米饭',since:'11:55',until:'12:10',with:[]},null]){
    const input={...data,state:{...state,doing}};
    assert.equal(Object.hasOwn(parse(chatWorldContext(input,{}, {location:false,now})).current,'doing'),false);
    assert.equal(Object.hasOwn(parse(chatWorldContext({...input,at:{state:now-180001}},{},{now})).current,'doing'),false);
    assert.equal(Object.hasOwn(parse(chatWorldContext({...input,at:{state:now+1}},{},{now})).current,'doing'),false);
    assert.deepEqual(parse(chatWorldContext(input,{}, {body:false,now})).current.doing,doing);
  }
});

test('existing body and location switches independently hide their state fields without exposing a full now line',()=>{
  const noBody=parse(chatWorldContext(data,{}, {body:false,now}));assert.equal(noBody.current.body,undefined);assert.equal(noBody.current.outfit,undefined);assert.equal(noBody.current.where,'合成公园');
  const noLocation=parse(chatWorldContext(data,{}, {location:false,now}));assert.equal(noLocation.current.where,undefined);assert.equal(noLocation.current.doing,undefined);assert.equal(noLocation.current.weather,undefined);assert.equal(noLocation.current.outfit.name,'合成棉服');
  const hidden=chatWorldContext(data,{}, {body:false,location:false,now});assert.ok(!/合成公园|合成棉服|白卫衣|不应使用未分字段/.test(hidden));
});

test('two newest active tasks and large fields stay within a bounded ordinary-chat packet without changing full records',()=>{
  const life={ownerTasks:[task('older',{createdAt:now-20}),task('newer',{createdAt:now,instruction:'原始约束'.repeat(1000),nextStep:'下一步'.repeat(1000)}),task('middle',{createdAt:now-10}),task('done',{status:'completed',createdAt:now+100})],plans:Array.from({length:50},()=>({text:'历史计划'.repeat(1000)}))};
  const before=structuredClone(life),result=chatWorldContext({...data,state:{...state,body:{text:'身体'.repeat(1000)},outfit:{name:'外套'.repeat(1000),look:'完整穿着'.repeat(1000)}}},life,{now}),packet=parse(result);
  assert.ok(result.length<=1000);assert.deepEqual(packet.ownerTasks.map(t=>t.id),['newer','middle']);assert.equal(packet.additionalActiveTasks,1);assert.ok(packet.ownerTasks[0].instruction.endsWith('…'));assert.deepEqual(life,before);
});

test('task projection honours the current life owner and persona instead of exposing foreign active tasks',()=>{
  const life={owner:'synthetic-owner',persona:'synthetic-persona',ownerTasks:[task('owned',{owner:'synthetic-owner',persona:'synthetic-persona'}),task('foreign-owner',{owner:'someone-else',persona:'synthetic-persona'}),task('foreign-persona',{owner:'synthetic-owner',persona:'someone-else'}),task('unattributed')]};
  const packet=parse(chatWorldContext(data,life,{now}));assert.deepEqual(packet.ownerTasks.map(t=>t.id),['owned']);
});

test('JSON escaping and control characters cannot make the ordinary packet exceed its serialized character bound',()=>{
  const hostile='\u0001"\\'.repeat(2000),oddState={time:hostile,stage:hostile,body:{text:hostile},where:{text:hostile},doing:{text:hostile},weather:{sky:hostile,temp:13},outfit:{name:hostile,look:hostile}};
  const result=chatWorldContext({...data,state:oddState},{ownerTasks:[task('a'.repeat(120),{instruction:hostile,nextStep:hostile}),task('b'.repeat(120),{instruction:hostile,nextStep:hostile})]},{now});
  assert.ok(result.length<=1000);assert.doesNotThrow(()=>parse(result));assert.ok(!result.includes('\\u0001'));
  const full={...oddState,doing:{name:hostile,since:hostile,until:hostile,with:[hostile,hostile,hostile],privateDetail:'不要完整注入'}};
  const named=chatWorldContext({...data,state:full},{ownerTasks:[task('a'.repeat(120),{instruction:hostile,nextStep:hostile}),task('b'.repeat(120),{instruction:hostile,nextStep:hostile})]},{now});
  assert.ok(named.length<=1000);assert.doesNotThrow(()=>parse(named));assert.equal(parse(named).current.doing.with.length,2);assert.ok(!named.includes('不要完整注入'));
});

test('all named activity and state fields can be entirely JSON escapes without exceeding the serialized cap',()=>{
  for(const character of ['"','\\','\ud800','\udfff','🐟'])for(const includeTasks of [false,true]){
    const hostile=character.repeat(2000),full={time:hostile,stage:hostile,body:{text:hostile},outfit:{name:hostile,look:hostile},where:{text:hostile},weather:{sky:hostile,temp:13},doing:{name:hostile,since:hostile,until:hostile,with:[hostile,hostile]}};
    const life={ownerTasks:includeTasks?[task('a'.repeat(120),{instruction:hostile,nextStep:hostile}),task('b'.repeat(120),{instruction:hostile,nextStep:hostile})]:[]};
    const result=chatWorldContext({...data,state:full},life,{now}),packet=parse(result);
    assert.ok(result.length<=1000,JSON.stringify({character,includeTasks,length:result.length}));
    assert.equal(packet.current.fresh,true);assert.equal(packet.current.observedAt,new Date(now).toISOString());
    assert.ok(packet.current.doing.name);assert.equal(packet.current.doing.with.length,2);assert.match(result,/仅表示无当前主活动/);
    for(const field of [packet.current.time,packet.current.stage,packet.current.body,packet.current.outfit.name,packet.current.outfit.look,packet.current.where,packet.current.weather.sky,...Object.values(packet.current.doing).flat()])assert.equal(field.isWellFormed(),true);
  }
});

test('ordinary owner has a scoped read-only ledger tool with bounded pagination while foreign chats and raw sessions stay excluded',async t=>{
  const directory=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'chat-context-ledger-')),at=Date.now();
  const life={...newLife(at),owner:'100',persona:'synthetic-persona',ownerTasks:[task('local-task',{owner:'100',persona:'synthetic-persona'})],plans:Array.from({length:23},(_,index)=>({id:'plan-'+index,status:'pending',detail:('合成长回执'+index).repeat(80)})),journal:[{id:'journal-current',text:'合成原始回执'}]};
  fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({version:3,fishId:'synthetic-fish',recent:[],at:{state:at},errors:{},state,life}));
  const config={enabled:true,ownerQQ:'100',persona:{current:'synthetic-persona'}},builders=[],contexts=[];let dispose,allOwner=true;
  const api={config:()=>config,settings:()=>({autonomy:false,sharing:false}),dataDir:(...parts)=>path.join(directory,...parts),dsh:{get:name=>name==='tools'?{guard:()=>()=>{}}:null,on:()=>()=>{}},lib:()=>({}),on:()=>{},onDispose:fn=>{dispose=fn;},context:fn=>contexts.push(fn),tool:fn=>builders.push(fn),rule:()=>{},command:()=>{},route:()=>{},every:()=>{},later:()=>{},use:()=>null,defineTool:value=>value,log:{info:()=>{},warn:()=>{}},core:{hub:{turnSendersAllOwner:()=>allOwner},http:{}},think:()=>assert.fail('No model calls'),send:()=>assert.fail('No QQ calls')};
  const service=await fishModule.setup(api);t.after(async()=>{await dispose?.();});
  const ownerChat={kind:'private',chatId:'private:100',userId:'100'},build=builders[0],history=build({chat:ownerChat,level:'full',sessionId:'owner-session'}).find(tool=>tool.name==='fish_life_history');
  assert.ok(history);assert.equal(contexts[0]({chat:{kind:'private',chatId:'private:200',userId:'200'}}),'');
  const injected=contexts[0]({chat:ownerChat});assert.ok(injected.length<=1000);assert.ok(!injected.includes('合成长回执'));assert.ok(injected.includes('local-task'));
  for(const chat of [{kind:'private',chatId:'private:200',userId:'200'},{kind:'group',chatId:'group:300',userId:'100'}])assert.ok(!build({chat,level:'full',sessionId:'other'}).some(tool=>tool.name==='fish_life_history'));
  assert.ok(!build({chat:ownerChat,level:'read',sessionId:'owner-session'}).some(tool=>tool.name==='fish_life_history'));
  const before=JSON.stringify(service.status().life.plans),first=JSON.parse((await history.execute({kind:'plans'})).message);assert.equal(first.nextOffset,10);assert.ok(first.text.length<=1500);assert.equal(first.nextPart,1);
  let part=0,recovered='';do{const page=JSON.parse((await history.execute({kind:'plans',part})).message);recovered+=page.text;part=page.nextPart;}while(part!==null);
  assert.equal(JSON.parse(recovered).length,10);assert.equal(JSON.parse((await history.execute({kind:'plans',offset:20})).message).nextOffset,null);
  const taskPage=JSON.parse((await history.execute({kind:'tasks',id:'local-task'})).message);assert.equal(JSON.parse(taskPage.text)[0].id,'local-task');
  await assert.rejects(history.execute({kind:'windows',sessionId:'foreign-raw-session',seq:1}),/只允许/);
  await assert.rejects(history.execute({kind:'plans',offset:-1}),/只允许/);assert.equal(JSON.stringify(service.status().life.plans),before);
  allOwner=false;await assert.rejects(history.execute({kind:'plans'}),/当前主人/);allOwner=true;
  config.persona.current='other-persona';await assert.rejects(history.execute({kind:'tasks'}),/身份/);assert.ok(!contexts[0]({chat:ownerChat}).includes('local-task'));
  assert.equal(service.status().life.plans.length,23);
});
