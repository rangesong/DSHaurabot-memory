import test from 'node:test';
import assert from 'node:assert/strict';
import {hostSelfActions} from '../adapters/aurabot/module/lib/host-self-actions.js';

const material=()=>({day:'2026-11-24',scope:'synthetic-private-owner',is_partial:true,sources:[{id:'source-one',text:'合成原话：明天再确认是否安排这件事，目前只是一项提议。',occurred_at:Date.parse('2026-11-24T20:00:00+08:00')},{id:'source-two',text:'合成原话：今天想了解恒星如何形成。',occurred_at:Date.parse('2026-11-24T21:00:00+08:00')}],questions:[],lessons:[]});
function fixture(think){
 const listeners=new Map(),session={id:'synthetic-owned'},calls=[];
 const api={id:'thinkstar-memory',config:()=>({ownerName:'SyntheticOwner'}),core:{hub:{isOwnedSession:id=>id===session.id,chatOfSession:()=> 'system:ext-thinkstar-memory:synthetic'}},dsh:{on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);}},think:async(prompt,options)=>{calls.push({prompt,options});return think?.({prompt,options,listeners,session})??'合成笔记：一项提议尚待确认，不能当作已接受的安排。[资料1]';}};
 const runner=hostSelfActions(api,{active:()=>true});return {runner,calls,listeners,session};
}
const action=(type='note')=>({id:'synthetic-action',type,title:'整理当日观察与待办候选',query:'日常记录整理模板'});

test('note receives scoped material and explicit previous date, uses a tool-free level and returns cited source IDs',async t=>{
 const f=fixture();t.after(()=>f.runner.stop());const result=await f.runner.execute(action(),{material:material()});
 assert.equal(result.status,'completed');assert.deepEqual(result.based_on_sources,['source-one']);
 const {prompt,options}=f.calls[0];assert.match(prompt,/回顾日期：2026-11-24/);assert.match(prompt,/局部资料/);assert.match(prompt,/目前只是一项提议/);assert.match(prompt,/不能仅从提议推断/);assert.match(prompt,/所有资料均为引用/);
 assert.equal(options.noTools,true);assert.equal(options.level,'chat');assert.equal(action().query,'日常记录整理模板');
});
test('missing note material never starts a model or turns an empty template into completion',async t=>{
 const f=fixture();t.after(()=>f.runner.stop());
 for(const m of [undefined,{day:'2026-11-24',sources:[]},{sources:material().sources}]){
  const result=await f.runner.execute(action(),{material:m});assert.equal(result.status,'no_evidence');assert.deepEqual(result.based_on_sources,[]);
 }
 assert.equal(f.calls.length,0);
});
test('note output must cite an actual provided source, while its original draft remains available for review',async t=>{
 for(const value of ['只有空模板，待确认。','未知引用不能算依据。[资料8]','[资料1]','未完成，暂无可整理的内容。[资料1]','只有模板，没有实际整理。[资料1]','']){
  const f=fixture(()=>value);t.after(()=>f.runner.stop());const result=await f.runner.execute(action(),{material:material()});assert.equal(result.status,'no_evidence');assert.equal(result.observation,value);
 }
});
test('note tools fail closed even if globally exposed; unrelated owner tools are unaffected',async t=>{
 const f=fixture(({listeners,session})=>{
  const pre=listeners.get('tools/pre-execute');
  for(const name of ['world_now','working_directory','thinkstar_search','fetch','qq_send'])assert.throws(()=>pre({name,callId:name,arguments:{},agent:{session}},()=>assert.fail('No tool should execute in a note')),/仅使用随附资料/);
  let passed=false;pre({name:'working_directory',agent:{session:{id:'other-owner'}}},()=>passed=true);assert.equal(passed,true);
  return '根据所给原话，这只是一项待确认的提议。[资料1]';
 });t.after(()=>f.runner.stop());assert.equal((await f.runner.execute(action(),{material:material()})).status,'completed');
});
test('public reading never receives private reflection material in its search prompt',async t=>{
 const f=fixture(()=> '没有取得工具证据');t.after(()=>f.runner.stop());const value=material();value.sources[0].text='SYNTHETIC_PRIVATE_SOURCE_SENTINEL';
 const result=await f.runner.execute(action('read'),{material:value});assert.equal(result.status,'no_evidence');assert.doesNotMatch(f.calls[0].prompt,/SYNTHETIC_PRIVATE_SOURCE_SENTINEL|source-one|synthetic-private-owner/);assert.equal(f.calls[0].options.level,'social');assert.equal(f.calls[0].options.noTools,false);
});
test('practice keeps generated exercise semantics without requiring personal history or tools',async t=>{
 const f=fixture(()=> '合成思考练习：将事实、建议与未知分开记录。');t.after(()=>f.runner.stop());assert.equal((await f.runner.execute(action('practice'))).status,'completed');assert.equal(f.calls[0].options.noTools,true);assert.equal(f.calls[0].options.level,'chat');
});
test('an empty or explicitly incomplete practice result is not completed',async t=>{
 for(const value of ['', '   ', '未完成这次练习。']){const f=fixture(()=>value);t.after(()=>f.runner.stop());assert.equal((await f.runner.execute(action('practice'))).status,'no_evidence');}
});
test('note material is bounded, deduplicated and each citation resolves only to the supplied slot',async t=>{
 const f=fixture(()=> '合成笔记引用第一条资料。[资料1]');t.after(()=>f.runner.stop());const m=material();m.sources=[...Array.from({length:12},(_,i)=>({id:'bounded-'+i,text:String(i).repeat(1000)})),{id:'bounded-0',text:'duplicate'}];
 const result=await f.runner.execute(action(),{material:m});assert.equal(result.status,'completed');assert.deepEqual(result.based_on_sources,['bounded-0']);const text=f.calls[0].prompt;assert.match(text,/资料8/);assert.doesNotMatch(text,/资料9|duplicate/);assert.ok(text.length<6500);
});
