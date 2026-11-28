import test from 'node:test';
import assert from 'node:assert/strict';
import {finiteActivityFromReceipt} from '../extensions/aurabot/fish-world/finite-activity.mjs';
import {rememberOwnerTurn,defineOwnerTask,noteOwnerTaskResult,ownerTaskGuard,ownerTaskCandidates} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {newLife,enqueue,defaults} from '../extensions/aurabot/fish-world/state.mjs';
import {candidates} from '../extensions/aurabot/fish-world/governance.mjs';

const W='mcp__fish-world__world_',at=Date.parse('2026-11-27T12:00:00+08:00'),owner='synthetic-owner',persona='synthetic-persona',sid='11111111-2222-4333-8444-555555555555',bg='session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const cook='好的，你在灶上做合成菜 2 份，用了合成材料，12:20 做好。做着的时候能做别的事。\n—— 现在 12:00 · 在家 · 在做：看书（12:10 结束） · 同时：做合成菜（12:20 做好）';
const novel='《合成书》合成作者 · 第 2 段（共 12 段）「合成章节」，12:30 读完\n合成正文。\n—— 现在 12:00 · 在图书馆 · 在做：读《合成书》（12:30 结束）';
function fixture(text,id='fixture-action'){
 const l={...newLife(at),owner,persona},t=rememberOwnerTurn(l,{owner,persona},{text:'请去小镇办点事',sessionId:sid,turnKey:1,confirmedWorld:true},at);defineOwnerTask(l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:JSON.stringify({id}),nextStep:'完成合成活动'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'回家'}]},{sessionId:sid,now:at});const row={id:'actual-start',ownerTaskId:t.id,tool:W+'do',args:JSON.stringify({id}),status:'confirmed',isError:false,at,finishedAt:at,sessionId:sid,result:text};l.journal.push(row);noteOwnerTaskResult(l,{life:l},row,at);return {l,t};
}
const done=(f,text,time=at+1800000)=>enqueue({life:f.l,fishId:'synthetic#1'},{kind:'done',t:time,text},time);

test('parameterized stove-cooking binds its parallel start and exact dish-and-count completion',()=>{
 const parsed=finiteActivityFromReceipt(cook);assert.equal(parsed.label,'做合成菜');assert.equal(parsed.blocking,false);const f=fixture(cook);assert.equal(f.t.phase,'waiting_event');done(f,'做好了：别的菜 2 份，做得好吃。');assert.equal(f.t.stepIndex,0);done(f,'做好了：合成菜 1 份，做得好吃。');assert.equal(f.t.stepIndex,0);done(f,'做好了：合成菜 2 份，做得好吃。');assert.equal(f.t.stepIndex,1);
});

test('a novel header binds its exact title and supports the fixed wake preamble before a normal start',()=>{
 assert.equal(finiteActivityFromReceipt(novel).label,'读《合成书》');assert.equal(finiteActivityFromReceipt(novel).blocking,true);const f=fixture(novel);done(f,'读《合成书》：合上书，读完了');assert.equal(f.t.stepIndex,1);
 const woke='你醒了，起来了。\n好的，你开始洗脸刷牙，12:02 结束。\n—— 现在 12:00 · 在家 · 在做：洗脸刷牙（12:02 结束）';assert.equal(finiteActivityFromReceipt(woke).label,'洗脸刷牙');
});

test('parallel eating binds its exact label and clock inside a combined footer and accepts the exact ended form',()=>{
 const text='好的，你一边看书一边吃合成饭，12:15 吃完。\n—— 现在 12:00 · 在家 · 在做：看书（12:30 结束）、吃合成饭（12:15 吃完）',parsed=finiteActivityFromReceipt(text);assert.equal(parsed.label,'吃合成饭');assert.equal(parsed.blocking,false);const f=fixture(text);done(f,'吃合成饭结束了');assert.equal(f.t.stepIndex,1);
});

test('parallel tea and laundry keep their unfinished steps without blocking other activity permissions',()=>{
 for(const [label,note]of [['泡杯合成茶','这件事不占手，做着的时候还能做别的；出门就停了。'],['洗合成衣服','这件事不占手，做着的时候还能做别的；出门也照样做完。']]){
  const text='好的，你开始'+label+'，12:20 结束。'+note+'\n—— 现在 12:00 · 在家 · 在做：做合成菜（12:10 做好）、'+label+'（12:20 结束）',f=fixture(text);assert.equal(f.t.activity.blocking,false);f.l.queue.push({id:'other-message',kind:'message',priority:2,bucket:'social',t:at,notBefore:at,status:'pending',sender:'synthetic-peer',provenance:{trusted:true,source:'world-notify'}});assert.ok(candidates(f.l,{state:{},life:f.l},{...defaults,idleEnabled:false},at).some(c=>c.id==='other-message'));
  f.l.round={id:'same-task',sessionId:bg,status:'running',ownerTaskId:f.t.id};const before=structuredClone(f.t);assert.equal(ownerTaskGuard(f.l,{}, {name:W+'go',arguments:{place:'home'},agent:{session:{id:bg}}},true,at),undefined);assert.deepEqual(f.t,before);assert.equal(f.t.phase,'waiting_event');assert.equal(f.t.stepIndex,0);
  const optional=rememberOwnerTurn(f.l,{owner,persona},{text:'你没事可以去图书馆读书',sessionId:sid,turnKey:2,confirmedWorld:true},at);assert.ok(ownerTaskCandidates(f.l,at+180000,{state:{}}).some(task=>task.ownerTaskId===optional.id));f.l.round.ownerTaskId=optional.id;assert.equal(ownerTaskGuard(f.l,{state:{}},{name:W+'do',arguments:{id:'read'},agent:{session:{id:bg}}},true,at+180000),undefined);
 }
});

test('failed, interrupted or incomplete narratives cannot masquerade as successful completion',()=>{
 const f=fixture(novel);for(const text of ['读《合成书》：没读完就走了','读《合成书》：活动中断了','读《合成书》：还没读完','读《合成书》结束了但没读完就走了']){done(f,text);assert.equal(f.t.stepIndex,0,text);}const c=fixture(cook);done(c,'做好了：合成菜 2 份，烧糊了');assert.equal(c.t.stepIndex,0);
});

test('activity separators inside a title are preserved and duplicate candidates remain held without guessed completion',()=>{
 const text='《合成、书》合成·作者 · 第 3 段（共 8 段）「合成段」，12:30 读完\n—— 现在 12:00 · 在图书馆 · 在做：读《合成、书》（12:30 结束）';assert.equal(finiteActivityFromReceipt(text).label,'读《合成、书》');
 const ambiguous='好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在家 · 在做：读合成书（12:30 结束） · 同时：读合成书（12:30 结束）',parsed=finiteActivityFromReceipt(ambiguous);assert.equal(parsed.ambiguous,true);assert.equal(parsed.label,null);const f=fixture(ambiguous);assert.equal(f.t.phase,'waiting_event');done(f,'读合成书：结束了');assert.equal(f.t.stepIndex,0);
});

test('an immediate purchase cannot bind a parallel busy footer and a quoted wake header is never searched',()=>{
 assert.equal(finiteActivityFromReceipt('你买了一本合成书。\n—— 现在 12:00 · 在家 · 在做：看书（12:10 结束） · 同时：洗合成衣服（12:30 结束）'),null);assert.equal(finiteActivityFromReceipt('引用：你醒了，起来了。\n好的，你开始洗合成衣服，12:30 结束。\n—— 现在 12:00 · 在家 · 在做：洗合成衣服（12:30 结束）'),null);
});

test('the same exact meal time treats primary eating-finished and ended markers equivalently, including midnight',()=>{
 for(const [observed,end]of [['12:00','12:15'],['23:50','00:05']]){const text='好的，你开始吃合成饭，'+end+' 吃完。\n—— 现在 '+observed+' · 在家 · 在做：吃合成饭（'+end+' 结束）',activity=finiteActivityFromReceipt(text);assert.equal(activity.label,'吃合成饭');assert.equal(activity.endClock,end);assert.equal(activity.blocking,true);assert.equal(finiteActivityFromReceipt(text.replace(end+' 结束','00:06 结束')),null);}
 const f=fixture('好的，你开始吃合成饭，12:15 吃完。\n—— 现在 12:00 · 在家 · 在做：吃合成饭（12:15 结束）');done(f,'吃合成饭结束了');assert.equal(f.t.stepIndex,1);
});

test('a verified old cook action derives dish completion from its exact start label, without guessing for another action',()=>{
 const text='好的，你开始做合成饭，用了合成材料 1 份，12:20 做好。锅里做着的时候能做别的事。\n—— 现在 12:00 · 在家 · 同时：做合成饭（12:20 做好）';assert.equal(finiteActivityFromReceipt(text,{actionId:'cook'}).completion.kind,'cooking');assert.equal(finiteActivityFromReceipt(text,{actionId:'look'}).completion.kind,'label');const f=fixture(text,'cook');done(f,'做好了：合成饭。做好了。');assert.equal(f.t.stepIndex,1);
});

test('a main meal with an explicitly appended serving completes its original exact base meal only',()=>{
 const text='好的，你开始吃一顿合成锅，12:30 吃完。\n—— 现在 12:00 · 在合成店 · 在做：吃一顿合成锅（12:30 结束）',f=fixture(text);done(f,'吃一顿别的锅，又加一份合成配菜：吃完了');assert.equal(f.t.stepIndex,0);done(f,'吃一顿合成锅底，又加一份合成配菜：吃完了');assert.equal(f.t.stepIndex,0);done(f,'吃一顿合成锅，又加一份合成配菜：没吃完就走了');assert.equal(f.t.stepIndex,0);done(f,'吃一顿合成锅，又加一份合成配菜：吃完了，放下筷子');assert.equal(f.t.stepIndex,1);
});
