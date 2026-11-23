import test from 'node:test';
import assert from 'node:assert/strict';
import {worldRecallQuery,worldMemoryVisible} from '../extensions/aurabot/fish-world/world-memory.mjs';

const identity={owner:'10000001',persona:'synthetic-persona'};
function fixture(extra={}){
  const round={id:'current-round',kind:'owner-task',ownerTaskId:'current-task',planIds:['current-plan'],events:['current-event'],...extra};
  const life={...identity,round,ownerTasks:[{...identity,id:'current-task',status:'active',instruction:'今天别打工了，买完合成点心回家',nextStep:'去合成商店'}, {...identity,id:'other-task',status:'active',instruction:'无关旧任务'}],plans:[{id:'current-plan',status:'waiting_event',goal:'买合成点心',nextStep:'核对购物回执'},{id:'old-plan',status:'completed',goal:'无关历史学习'}],queue:[{id:'current-event',kind:'owner',text:'买完后回家'},{id:'other-event',kind:'message',text:'其他鱼的旧消息'}]};
  return {life,round};
}
test('world recall uses only the admitted round task plans and current events without generic fallback',()=>{
  const {life,round}=fixture(),before=structuredClone(life),query=worldRecallQuery(life,round,identity);
  assert.match(query,/今天别打工了/);assert.match(query,/合成点心/);assert.match(query,/买完后回家/);
  assert.doesNotMatch(query,/无关旧任务|无关历史学习|其他鱼的旧消息|朋友、主人约定/);assert.deepEqual(life,before);
  const idle={id:'idle',kind:'idle',events:['idle-event']};
  assert.equal(worldRecallQuery({...life,round:idle,queue:[{id:'idle-event',kind:'idle',text:'闲时自主生活观察'}]},idle,identity),'');
});
test('unadmitted recovery stale or foreign identity rounds do not start recall',()=>{
  const {life,round}=fixture();
  for(const state of [undefined,{...life,round:null},{...life,round:{id:'another'}},{...life,owner:'20000002'},{...life,persona:'other'}])assert.equal(worldRecallQuery(state,round,identity),'');
  for(const changed of [{...round,readOnly:true},{...round,kind:'recovery'}])assert.equal(worldRecallQuery({...life,round:changed},changed,identity),'');
});
test('visible-source deduplication reads only the current owned bound session and changes no window record',()=>{
  const {life,round}=fixture();life.sessionId='old-session';life.contextWindow={key:'current',windows:[{key:'old',sessionId:'old-session'},{key:'current',sessionId:'current-session'}]};
  const before=structuredClone(life),agent={session:{id:'current-session',deriveMessages:()=>[{content:[{type:'text',text:'visible current source'},{type:'image',url:'ignored'}]}]}};
  assert.equal(worldMemoryVisible(life,round,agent,identity),'visible current source');assert.deepEqual(life,before);
  assert.equal(worldMemoryVisible(life,round,{session:{...agent.session,id:'old-session'}},identity),'');
  assert.equal(worldMemoryVisible({...life,owner:'other'},round,agent,identity),'');
  const unbound=structuredClone(life);unbound.contextWindow.windows[1].sessionId=null;assert.equal(worldMemoryVisible(unbound,round,agent,identity),'');
});
test('query stays bounded and omits completed or foreign tasks and unrelated source metadata',()=>{
  const {life,round}=fixture();life.ownerTasks[0].instruction='长任务'.repeat(1000)+'\u0000';
  assert.ok(worldRecallQuery(life,round,identity).length<=600);assert.ok(!worldRecallQuery(life,round,identity).includes('\u0000'));
  for(const changed of [{...life.ownerTasks[0],status:'completed'},{...life.ownerTasks[0],owner:'20000002'},{...life.ownerTasks[0],persona:'other'}]){
    const state={...life,ownerTasks:[changed],plans:[],queue:[]};assert.equal(worldRecallQuery(state,{...round,kind:'idle'},identity),'');
  }
});
