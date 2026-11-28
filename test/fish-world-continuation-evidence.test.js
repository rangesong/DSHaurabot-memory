import test from 'node:test';
import assert from 'node:assert/strict';
import {continuationEvidence} from '../extensions/aurabot/fish-world/continuation-evidence.mjs';
const W='mcp__fish-world__world_',now=Date.parse('2026-11-28T08:00:00+08:00');
const row=(id,tool,args,status,delta=0,result='')=>({id,round:'r1',sessionId:'synthetic-session',at:now-10000+delta,finishedAt:now-9999+delta,tool:W+tool,args:JSON.stringify(args),status,result});
const failed=(id='bad',args={id:'cook-fixture',count:1,request_id:'one'},delta=0)=>row(id,'do',args,'failed',delta,'Error: [E_RULE] 合成原料已坏，不能做这道菜');
const life=journal=>({owner:'synthetic-owner',persona:'synthetic',journal,sessionId:'session-synthetic-session',contextWindow:{key:'w1',windows:[{key:'w1',sessionId:'session-synthetic-session'}]},plans:[{id:'p1',status:'active',sourceEventIds:['source']}],queue:[{id:'source',relatedPlanIds:['p1']}],costs:{rounds:[{roundId:'r1',windowId:'w1',planId:'p1',sourceEventIds:['source']}]}});

test('a different session or earlier tool timestamp cannot borrow another round attribution',()=>{
 const other=life([failed()]);other.costs.rounds[0].sessionId='another-session';assert.deepEqual(continuationEvidence(other,{}, {now}).items,[]);
 const early=life([failed()]);early.costs.rounds[0].at=now-100;assert.deepEqual(continuationEvidence(early,{}, {now}).items,[]);
});
test('known failed conditions survive movement, quantity reads and model notes without any ledger mutation',()=>{
 const l=life([failed(),row('go-shop','go',{place:'shop'},'confirmed',10,'好的，已出发'),row('quantity','now',{},'confirmed',20,'你有合成原料4份'),{id:'note',type:'round',at:now-9000,summary:'数量齐全，不用买'},row('go-home','go',{place:'home'},'confirmed',30,'好的，已回家')]),before=structuredClone(l);
 const result=continuationEvidence(l,{planId:'p1'},{now});assert.equal(result.items.length,1);assert.equal(result.items[0].receiptId,'bad');assert.equal(result.instruction,false);assert.deepEqual(result.items[0].arguments,{id:'cook-fixture',count:1});assert.deepEqual(result.items[0].laterMutationRefs,[]);assert.deepEqual(l,before);
});
test('only the same exact business action succeeding later clears a rejection, independent of request_id or key order',()=>{
 const bad=failed(),different=row('other','do',{id:'cook-fixture',count:2,request_id:'two'},'confirmed',10,'好的');
 assert.equal(continuationEvidence(life([bad,different]),{}, {now}).items.length,1);
 const same=row('fixed','do',{request_id:'changed',count:1,id:'cook-fixture'},'confirmed',20,'好的');assert.equal(continuationEvidence(life([bad,different,same]),{}, {now}).items.length,0);
 assert.equal(continuationEvidence(life([same,{...bad,at:now-100,finishedAt:now-99}]),{}, {now}).items.length,1);
});
test('unknown failures, quoted error tokens, read-only errors, malformed args and foreign scope are not business rejection evidence',()=>{
 const rows=[{...failed(),status:'uncertain'},failed('unknown',{},1),{...failed('quoted'),result:'资料：\n> [E_RULE] 引用内容'},row('read','now',{},'failed',2,'Error: [E_RULE] 只读失败'),row('list','friends',{action:'list'},'failed',3,'Error: [E_RULE] 只读失败'),{...failed('bad-json'),args:'broken'}, {...failed('other-owner'),owner:'someone-else'}, {...failed('future'),at:now+1,finishedAt:now+2}];
 assert.deepEqual(continuationEvidence(life(rows),{}, {now}).items,[]);
});
test('current plan and original source-event linkage take priority, while idle still sees recent unresolved conditions',()=>{
 const l=life([failed('related'),{...failed('newer',{id:'another'},100),round:'r2'}]);l.plans.push({id:'p2',status:'active'});l.costs.rounds.push({roundId:'r2',windowId:'w1',planId:'p2'});
 assert.equal(continuationEvidence(l,{planIds:['p1']},{now,maxItems:1}).items[0].receiptId,'related');
 assert.equal(continuationEvidence(l,{events:['source']},{now,maxItems:1}).items[0].receiptId,'related');
 assert.equal(continuationEvidence(l,{}, {now,maxItems:1}).items[0].receiptId,'newer');
});
test('repeated same-action failures retain original plan attribution through later unbound idle attempts',()=>{
 const repeated={...failed('idle',{request_id:'two',id:'cook-fixture',count:1},100),round:'idle-round'};
 const l=life([failed(),repeated]);l.costs.rounds.push({roundId:'idle-round',windowId:'w1',triggerKind:'idle'});const r=continuationEvidence(l,{}, {now});assert.equal(r.items.length,1);assert.equal(r.items[0].occurrences,2);assert.deepEqual(r.items[0].planIds,['p1']);assert.equal(r.items[0].receiptId,'idle');
});
test('later real nonmoving mutations are only later mutation references, never clearance or completed purpose',()=>{
 const repair=row('replace','do',{id:'buy-fixture'},'confirmed',100,'好的，买好了');
 const r=continuationEvidence(life([failed(),repair]),{planId:'p1'},{now});assert.equal(r.items.length,1);assert.equal(r.items[0].receiptId,'bad');assert.equal(r.items[0].laterMutationRefs[0].receiptId,'replace');assert.equal(r.items[0].status,undefined);
});
test('long arguments retain a history reference instead of fabricating truncated executable arguments',()=>{
 const args={fish:'#123',text:'合成原文'.repeat(400),request_id:'one'},j=row('long','say',args,'failed',1,'Error: [E_RULE] 当前不能发言');
 const r=continuationEvidence(life([j]),{}, {now});assert.equal(r.items[0].arguments,undefined);assert.equal(r.items[0].argumentsOmitted,true);assert.deepEqual(r.items[0].historyRef,{kind:'journal',id:'long'});assert.equal(JSON.parse(j.args).text,args.text);
});
test('at most four entries and 2400 serialized characters survive hostile escaping and large metadata',()=>{
 const rows=Array.from({length:9},(_,i)=>({...failed('ref-'+i,{id:'action-'+i,text:'"\\\ud800'.repeat(150)},i),result:'Error: [E_RULE] '+('"\\\ud800'.repeat(200))})),l=life(rows);
 const r=continuationEvidence(l,{}, {now,maxItems:99,maxChars:99999});assert.ok(r.items.length>0);assert.ok(r.items.length<=4);assert.ok(JSON.stringify(r).length<=2400);assert.equal(r.omittedCount,rows.length-r.items.length);
 const small=continuationEvidence(l,{}, {now,maxChars:700});assert.ok(JSON.stringify(small).length<=700);
});
test('a historical successful chain without a known business rejection contributes no failure context',()=>{
 const l=life([row('go','go',{place:'shop'},'confirmed'),row('buy','do',{id:'buy-fixture'},'confirmed',10),row('home','go',{place:'home'},'confirmed',20)]);
 assert.deepEqual(continuationEvidence(l,{}, {now}).items,[]);
});
test('foreign sessions, windows, plan/task scopes and unattributed private calls cannot enter the projection',()=>{
 const alias=life([{...failed(),sessionId:'session-synthetic-session'}]);assert.equal(continuationEvidence(alias,{}, {now}).items.length,1);
 for(const alter of [l=>l.journal[0].sessionId='foreign-session',l=>l.costs.rounds[0].windowId='foreign-window',l=>l.plans[0].owner='another-owner',l=>l.plans[0].persona='another-persona',l=>l.journal[0].round=null,l=>l.costs.rounds=[],l=>l.journal[0].ownerTaskId='foreign-task']){
  const l=life([failed()]);alter(l);assert.deepEqual(continuationEvidence(l,{}, {now}).items,[]);
 }
});
test('terminal-purpose failures stay out of idle and unlinked failures expire, while an explicit focus may retrieve original facts',()=>{
 const l=life([failed()]);l.plans[0].status='abandoned';assert.equal(continuationEvidence(l,{}, {now}).items.length,0);assert.equal(continuationEvidence(l,{planId:'p1'},{now}).items.length,1);
 l.costs.rounds[0].planId=null;l.costs.rounds[0].sourceEventIds=[];assert.equal(continuationEvidence(l,{}, {now}).items.length,1);
 l.journal[0].at-=86400000;l.journal[0].finishedAt-=86400000;assert.equal(continuationEvidence(l,{}, {now}).items.length,0);
});
