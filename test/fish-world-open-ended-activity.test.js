import test from 'node:test';
import assert from 'node:assert/strict';
import {planActivityGuard} from '../extensions/aurabot/fish-world/plan-activity.mjs';
const W='mcp__fish-world__world_',now=Date.parse('2026-11-28T16:40:00+08:00');
const fixture=doing=>({at:{state:now},state:{where:{kind:'place'},doing}});
test('a server-declared activity with no ending does not permanently prevent choosing the next ordinary plan',()=>{
 for(const name of ['看海','坐着休息','合成自由活动']){const data=fixture({name,until:null}),before=structuredClone(data);for(const kind of ['plan','idle'])for(const [tool,args] of [['go',{place:'synthetic-food'}],['do',{id:'synthetic-action'}]])assert.equal(planActivityGuard(data,{kind},W+tool,args,now),undefined);assert.deepEqual(data,before);}
});
test('actual journeys, shifts and explicitly timed or unknown activities retain their existing treatment',()=>{
 for(const doing of [{name:'打零工',until:null},{name:'读书',until:'2026-11-28T16:50:00+08:00'},{name:'合成未明活动'},{name:'读书',until:null,endAt:now+60000},{name:'读书（16:50 结束）',until:null},{text:'读书（16:50 结束）',until:null}])assert.ok(planActivityGuard(fixture(doing),{kind:'plan'},W+'go',{place:'other'},now));
 const data=fixture({name:'看海',until:null});data.state.where={kind:'trip'};assert.ok(planActivityGuard(data,{kind:'plan'},W+'go',{place:'other'},now));
});
