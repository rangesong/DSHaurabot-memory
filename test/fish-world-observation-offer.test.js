import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberOwnerTurn,registerJourney,ownerTaskGuard} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {ownerTaskContext} from '../extensions/aurabot/fish-world/session-identity.mjs';
const now=Date.parse('2026-11-28T16:00:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic'},sessionId='synthetic-offer';
const fixture=()=>({...newLife(now),...identity});
test('current permission to look preserves its original words without inventing a purchase',()=>{
 const l=fixture(),text='可以看看合成海边有没有什么好吃的';
 const task=rememberOwnerTurn(l,identity,{text,sessionId,turnKey:'current',confirmedWorld:true},now);
 assert.equal(task.originalPurpose,text);assert.equal(task.optional,true);assert.equal(task.finalAction,null);assert.equal(task.fulfillment?.purchaseRequired,false);
 const result=registerJourney(l,{goal:'到合成海边看看食物选项',destination:'synthetic-coast',arrivalStep:'看看现场食物选项',completionType:'observe'},{sessionId,identity,now});
 assert.equal(result.task.originalPurpose,text);assert.equal(result.task.purposeSource,'owner-current');assert.equal(result.task.fulfillment?.purchaseRequired,false);
 assert.equal(ownerTaskGuard(l,{}, {name:'mcp__fish-world__world_go',arguments:{place:'another'},agent:{session:{id:sessionId}}},false,now),undefined);
});
test('an unscoped observation offer remains dormant until a real world action',()=>{
 const l=fixture(),text='可以看看这份合成材料';assert.equal(rememberOwnerTurn(l,identity,{text,sessionId,turnKey:'unscoped'},now),null);assert.equal(l.ownerTasks?.length||0,0);assert.equal(ownerTaskContext(l,sessionId).deferred.text,text);
});
test('questions, quotes, negations and compound action proposals do not become observation permission',()=>{
 for(const text of ['可以看看合成海边吗？','不要去看看合成海边','他说可以看看合成海边','引用：可以看看合成海边','可以看看合成海边然后买一条鱼']){const l=fixture();assert.equal(rememberOwnerTurn(l,identity,{text,sessionId,turnKey:text,confirmedWorld:true},now),null,text);assert.equal(l.ownerTasks?.length||0,0,text);}
});
