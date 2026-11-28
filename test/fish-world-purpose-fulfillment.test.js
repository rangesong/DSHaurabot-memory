import test from 'node:test';import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {defineOwnerTask} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {verifyCurrentOwnerPurposeSource} from '../extensions/aurabot/fish-world/world-turn-context.mjs';
const W='mcp__fish-world__world_';
const sourceFor=(text,id='fixture-owner-message')=>verifyCurrentOwnerPurposeSource([{type:'user/message',data:{id,role:'user',source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},content:[{type:'text',text:'历史资料中也有相似句子，但不是当前正文'},{type:'text',text:'【私聊】[15:00] Fixture(fixture-owner)：'+text}]}}],{sessionId:'fixture-owner-session',owner:'fixture-owner',sourceMessageId:id,ownerText:text});
function fixture(text='你现在去鱼的世界买一本合成书'){
 const now=Date.parse('2026-11-28T15:00:00+08:00'),identity={owner:'fixture-owner',persona:'fixture'},agent={session:{id:'fixture-owner-session'}},data={version:3,fishId:'fixture#1',at:{state:now},state:{where:{kind:'place',place:{id:'fixture-shop'}}},life:newLife(now)};Object.assign(data.life,identity);
 const bridge={data,identityReady:true,change(fn){return fn(data);}},e=new LifeEngine({bridge,host:{cancel:async()=>{},idle:async()=>true},clock:()=>now,identity:()=>identity,settings:()=>({sharing:false})});
 const task=e.ownerTurn(text,{sessionId:agent.session.id,turnToken:'fixture-turn'});assert.ok(task);
 const define=id=>defineOwnerTask(e.l,{id:task.id,expectedRevision:task.revision,steps:[{tool:'world_do',arguments:JSON.stringify({id}),nextStep:'按当前真实选项继续原目的'}]},{sessionId:agent.session.id,now,data});
 const act=(id,result)=>{const exec={name:W+'do',arguments:{id},agent,callId:'fixture-'+e.l.journal.length};assert.equal(e.guard(exec,false,true),undefined);e.result(exec,{content:[{type:'text',text:result}]});};
 return {e,data,task,define,act};
}
test('finishing a shelf inspection cannot silently satisfy the original required purchase',()=>{
 const f=fixture();f.define('fixture-shelves');f.act('fixture-shelves','合成货架上摆着几本书，标价5贝。');
 assert.equal(f.task.status,'active');assert.equal(f.task.phase,'needs_definition');assert.equal(f.task.contractIssue.code,'required-purchase-unproved');assert.equal(f.task.fulfillment.purchaseSucceeded,false);assert.equal(f.task.completedSteps.length,1);assert.equal(f.task.instruction,'你现在去鱼的世界买一本合成书');
 f.define('fixture-book');f.act('fixture-book','你买了 1 本合成书，花了 5 贝，还剩 20 贝。');assert.equal(f.task.status,'completed');assert.equal(f.task.fulfillment.purchaseSucceeded,true);assert.equal(f.task.fulfillment.purchaseEvidenceIds.length,1);assert.equal(f.task.completedSteps.length,2);
});
test('a successful actual purchase is retained independently of unfinished execution steps',()=>{
 const f=fixture();defineOwnerTask(f.e.l,{id:f.task.id,expectedRevision:f.task.revision,steps:[{tool:'world_do',arguments:'{"id":"fixture-book"}',nextStep:'买书'},{tool:'world_do',arguments:'{"id":"fixture-extra"}',nextStep:'可继续的后续安排'}]},{sessionId:'fixture-owner-session',now:Date.parse('2026-11-28T15:00:00+08:00'),data:f.data});
 f.act('fixture-book','你买了 1 本合成书，花了 5 贝，还剩 20 贝。');assert.equal(f.task.status,'active');assert.equal(f.task.fulfillment.purchaseSucceeded,true);assert.equal(f.task.fulfillment.executionPending,true);assert.equal(f.task.stepIndex,1);
});
test('another purpose purchase, remembered stock and model notes do not prove the current purpose',()=>{
 const f=fixture();f.e.l.journal.push({id:'other-purpose',ownerTaskId:'other',tool:W+'do',args:'{"id":"fixture-book"}',status:'confirmed',isError:false,result:'你买了 1 本合成书，花了 5 贝。'});f.task.progress='书已经买过';f.define('fixture-shelves');f.act('fixture-shelves','东西：合成书 1 本；这是库存，不是购买回执');assert.equal(f.task.status,'active');assert.equal(f.task.fulfillment.purchaseSucceeded,false);
});
test('a conditional browse-and-decide purpose does not force an unwanted purchase',()=>{
 const f=fixture('你去鱼的世界看看书，有合适再买');f.define('fixture-shelves');f.act('fixture-shelves','合成货架上摆着几本书。');assert.equal(f.task.status,'completed');
});
test('restoring the current rejected purpose keeps original owner text and atomically pauses older goals',()=>{
 const f=fixture(),oldId=f.task.id;f.e.ownerTurn('下午去合成湖看看',{sessionId:'fixture-owner-session',turnToken:'current-lake-turn'});const context=f.e.l.ownerTaskContexts['fixture-owner-session'],key=context.key;
 const result=f.e.restorePurpose({sessionId:'fixture-owner-session',expectedTurnKey:key,ownerText:'下午去合成湖看看',sourceMessageId:'fixture-owner-message',journey:{goal:'到合成湖看看并做自选后续',destination:'fixture-lake',arrivalStep:'到湖边查看现场，后续可以自己决定',completionType:'action'}},sourceFor('下午去合成湖看看'));
 const task=f.e.l.ownerTasks.find(t=>t.id===result.task.id),old=f.e.l.ownerTasks.find(t=>t.id===oldId);
 assert.equal(task.originalPurpose,'下午去合成湖看看');assert.equal(task.ownerCompletionType,'observe');assert.equal(old.focus.state,'paused');assert.equal(old.status,'active');assert.equal(task.source.restoredFrom.ownerTurnKey,key);assert.equal(f.e.l.journal.length,0);assert.equal(f.e.l.outbox.length,0);assert.equal(f.e.l.ownerTasks.filter(t=>t.status==='active'&&t.focus?.state!=='paused').length,1);
});
test('a newer owner message, invalid quote or active execution prevents source restoration without side effects',()=>{
 for(const mode of ['stale','quote','busy']){
  const f=fixture(),text=mode==='quote'?'他说去合成湖看看':'下午去合成湖看看';f.e.ownerTurn(text,{sessionId:'fixture-owner-session',turnToken:'current-source'});const key=f.e.l.ownerTaskContexts['fixture-owner-session'].key;if(mode==='busy')f.e.lock={callId:'in-flight'};const before=JSON.stringify(f.e.l);
  assert.throws(()=>f.e.restorePurpose({sessionId:'fixture-owner-session',expectedTurnKey:mode==='stale'?'old-key':key,ownerText:text,sourceMessageId:'fixture-message',journey:{goal:'去合成湖看看',destination:'fixture-lake',arrivalStep:'查看湖边现场',completionType:'observe'}},sourceFor(text,'fixture-message')));assert.equal(JSON.stringify(f.e.l),before,mode);
 }
});

test('current turn keys cannot give historical text, source IDs or scheduled inputs new owner authority',()=>{
 const text='下午去合成湖看看',current={type:'user/message',data:{id:'current',role:'user',source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},content:[{type:'text',text:'旧资料：去合成旧城买书'},{type:'text',text:'【私聊】[15:00] Fixture(fixture-owner)：'+text}]}};
 const args={sessionId:'fixture-owner-session',owner:'fixture-owner',sourceMessageId:'current',ownerText:text};
 assert.equal(verifyCurrentOwnerPurposeSource([current],args).ownerText,text);
 assert.throws(()=>verifyCurrentOwnerPurposeSource([current],{...args,ownerText:'去合成旧城买书'}));assert.throws(()=>verifyCurrentOwnerPurposeSource([current],{...args,sourceMessageId:'historical'}));
 for(const source of [{kind:'schedule'},{kind:'aurabot',speaker:{role:'guest',chat:'private'}},{kind:'unknown'}])assert.throws(()=>verifyCurrentOwnerPurposeSource([current,{type:'user/message',data:{...current.data,id:'later',source}}],args));
 const duplicate=structuredClone(current);duplicate.data.content.push({type:'text',text:'【私聊】[15:00] Fixture(fixture-owner)：'+text});assert.throws(()=>verifyCurrentOwnerPurposeSource([duplicate],args));
});
