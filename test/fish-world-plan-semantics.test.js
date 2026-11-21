import test from 'node:test';import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {preparePlanChanges,applyPlanChanges} from '../extensions/aurabot/fish-world/plans.mjs';
import {equivalentPlans} from '../extensions/aurabot/fish-world/plan-semantics.mjs';
const now=Date.parse('2026-11-21T20:00:00+08:00'),tomorrow=Date.parse('2026-11-22T10:00:00+08:00');
function fixture(){const l=newLife(now);Object.assign(l,{owner:'fixture-owner',persona:'fixture',ownerInstructionRevision:16});l.queue=[{id:'e1',sender:'信使#73'},{id:'e2',sender:'信使#73'}];const round={id:'r',sourceEventIds:['e1'],events:['e1'],receipts:[]},context={now,fishId:'self#1',owner:l.owner,persona:l.persona,ownerInstructionRevision:16};return {l,round,context};}
const primary={goal:'找晨露#101和沐宝#202问手环钥匙扣的线珠子进货',reason:'信使说她们知道进货渠道',nextStep:'明天白天在市集找到人，问线珠进货渠道和价格',nextAt:tomorrow,trigger:'arrive',stage:'遇到晨露或沐宝，或者明天白天市集开摊',status:'pending'};
const changed={goal:'明天去问晨露沐宝的事，问到就好，不替信使垫钱',reason:'信使消息说只问不垫钱',nextStep:'明天白天找到晨露问清沐宝的情况，只问不垫钱',topic:'morning露沐宝的事',stage:'待办',trigger:'明天白天（11-22）',nextAt:tomorrow+5*3600000,status:'pending'};
function apply(f,p,refinesPlanId){const operations=preparePlanChanges(f.l,{planChanges:[{op:'create',plan:p,refinesPlanId}]},{round:f.round,now,fishId:f.context.fishId});applyPlanChanges(f.l,operations,{now,roundId:f.round.id});return operations;}
test('the discovered beading inquiry paraphrase refines the original ID and retains no-advance-money condition',()=>{
 const f=fixture();apply(f,primary);const id=f.l.plans[0].id,key=f.l.plans[0].logicalKey;f.round.sourceEventIds=['e2'];apply(f,changed,id);
 assert.equal(f.l.plans.length,1);const p=f.l.plans[0];assert.equal(p.id,id);assert.equal(p.logicalKey,key);assert.ok(p.revision>1);
 assert.match(p.nextStep,/进货渠道和价格/);assert.match(p.nextStep,/不.*垫钱/);assert.ok(p.constraints.some(c=>/不.*垫钱/.test(c)));assert.ok(p.semanticAliases.includes(changed.goal));assert.deepEqual(p.sourceEventIds,['e1','e2']);
 assert.equal(f.l.planHistory.at(-1).submittedPlan.goal,changed.goal);
 const version=p.revision;for(let i=0;i<100;i++)apply(f,changed,id);assert.equal(f.l.plans.length,1);assert.equal(f.l.plans[0].revision,version);
});
test('same targets do not collapse different resources, action, dates or explicit phases',()=>{
 for(const patch of [{goal:'问晨露#101和沐宝#202的营业时间',nextStep:'问营业时间',topic:'营业时间'},
 {nextAt:tomorrow+86400000},{stage:'after-dinner'},{goal:'问晨露#101和另一位#99线珠进货',nextStep:'向另一位#99询问',topic:'线珠进货'}]){
  const f=fixture();apply(f,primary);apply(f,{...primary,...patch});assert.equal(f.l.plans.length,2,JSON.stringify(patch));
 }
});
test('ambiguous elliptical inquiry does not pick one of several same-peer candidates',()=>{
 const f=fixture();apply(f,primary);apply(f,{...primary,goal:'问晨露#101和沐宝#202身体怎么样',nextStep:'询问身体健康',topic:'健康'});
 f.round.sourceEventIds=['e2'];apply(f,changed);assert.equal(f.l.planProposals.length,1);assert.equal(f.l.planProposals[0].candidateIds.length,2);assert.equal(f.l.plans.length,2);
});
test('an unrelated conversation cannot inherit a vague old inquiry',()=>{
 const f=fixture();f.l.queue.push({id:'other',sender:'其他鱼#98'});apply(f,primary);f.round.sourceEventIds=['other'];apply(f,changed);assert.equal(f.l.plans.length,1);assert.equal(f.l.planProposals.length,1);
});
test('a semantic duplicate can merge only with verified same identity and target revisions',()=>{
 const f=fixture();apply(f,primary);const first=f.l.plans[0];const duplicate={...structuredClone(first),id:'previous-bug-copy',goal:changed.goal,nextStep:changed.nextStep,topic:primary.topic||primary.goal,stage:first.stage,logicalKey:'previous-random-key',sourceEventIds:['e2']};f.l.plans.push(duplicate);
 const ops=preparePlanChanges(f.l,{planChanges:[{op:'merge',id:duplicate.id,expectedRevision:duplicate.revision,targetId:first.id,targetExpectedRevision:first.revision}]},{round:f.round,now,fishId:f.context.fishId});applyPlanChanges(f.l,ops,{now});assert.equal(f.l.plans.find(p=>p.id===duplicate.id).status,'merged');assert.ok(equivalentPlans(first,duplicate,f.l,{...f.context,reviewedPair:[first.id,duplicate.id]}));
});

test('clear paraphrases with the same resource update without an old ID',()=>{const f=fixture();apply(f,primary);const id=f.l.plans[0].id;apply(f,{...primary,goal:'明天向晨露#101和沐宝#202打听线珠子货源',nextStep:'向晨露和沐宝问线和珠子进货，不替他人垫钱'});assert.equal(f.l.plans.length,1);assert.equal(f.l.plans[0].id,id);});
test('arrival and completion phases are not synonyms',()=>{const f=fixture();apply(f,{...primary,stage:'等抵达再问'});apply(f,{...primary,stage:'等做完再问'});assert.equal(f.l.plans.length,2);});
test('all added budget quantity timing text survives refinement and deadlines only tighten',()=>{const f=fixture();apply(f,primary);const deadline=tomorrow+2*3600000;apply(f,{...primary,nextStep:'预算不超过8贝，只买两卷，明天12点前答复',expiresAt:deadline});const p=f.l.plans[0];assert.match(p.nextStep,/不超过8贝/);assert.match(p.nextStep,/只买两卷/);assert.match(p.nextStep,/12点前/);assert.equal(p.expiresAt,deadline);assert.equal(p.refinements.at(-1).nextStep,'预算不超过8贝，只买两卷，明天12点前答复');apply(f,{...primary,expiresAt:deadline+3600000});assert.equal(f.l.plans[0].expiresAt,deadline);assert.throws(()=>apply(f,{...primary,expiresAt:tomorrow-1000}),/期限早于/);});
test('matching sender on different days cannot authorize a vague new business item',()=>{const f=fixture();f.l.queue[0].t=now-86400000;f.l.queue[1].t=now;apply(f,primary);f.round.sourceEventIds=['e2'];apply(f,changed);assert.equal(f.l.planProposals.length,1);assert.equal(f.l.plans.length,1);});

test('a local ambiguous proposal never becomes a paid scheduled plan',()=>{const f=fixture();apply(f,primary);for(let i=0;i<100;i++)apply(f,changed);assert.equal(f.l.plans.length,1);assert.equal(f.l.planProposals.length,1);assert.equal(f.l.planProposals[0].modelWake,false);assert.equal(f.l.planProposals[0].repeatCount,100);assert.equal(f.l.planProposals[0].submissions.length,1);});
