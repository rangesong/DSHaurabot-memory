import test from 'node:test';
import assert from 'node:assert/strict';
import {worldLifePurpose} from '../adapters/aurabot/module/lib/world-life-purpose.js';

const source=(id,text,extra={})=>({id,role:'user',text,provenance:{kind:'host_message'},...extra});
const memory=(id,refs,extra={})=>({id,source_refs:refs,attributes:{},...extra});
function fixture(query,sourceRows,memoryRows=[]){
  const sources=new Map(sourceRows.map(row=>[row.id,row])),memories=new Map(memoryRows.map(row=>[row.id,row]));let reads=0;
  const policy=worldLifePurpose(query,{getSource:id=>{reads++;return sources.get(id);},getMemory:id=>{reads++;return memories.get(id);}});
  return {policy,reads:()=>reads};
}

test('world purpose requires concrete task evidence while allowing short owner arrangements and named world context',()=>{
  for(const [query,text]of [['今天别打工了','今天别打工了，先休息。'],['关闭QQ分享','以后QQ分享只要正常消息。'],['去图书馆找合成星桥','我在图书馆等你。'],['去找小青朋友','鱼的世界：小青邀请她喝茶。']]){
    const row=source('owner',text),{policy}=fixture(query,[row]);assert.equal(policy.source(row),true,query);assert.equal(policy.memory(memory('raw',['owner'])),true);
  }
  const row=source('novel','合成小说：今天出现了一个朋友，主角谈论分享桥段。');
  const {policy}=fixture('去合成星桥广场找朋友分享见闻',[row]);assert.equal(policy.source(row),false,'one broad word and a temporal cue do not establish task relevance');
  const generic=fixture('鱼的世界生活、朋友、主人约定和分享偏好',[row]);assert.equal(generic.policy.active,false);assert.equal(generic.policy.memory(memory('raw',['novel'])),false);assert.equal(generic.reads(),0);
  const software=source('software','今天帮我处理程序工作日志。');assert.equal(fixture('今天别打工了',[software]).policy.source(software),false,'generic software work does not mean a world job');
});

test('world purpose rejects direct, nested source and basis ancestry without reading or rewriting learning bodies',()=>{
  const owner=source('owner','今天别打工了，先休息。');
  const learning=source('learning','今天别打工了，鱼的世界合成小说笔记。',{role:'document',provenance:{kind:'self_learning_result',source_refs:['owner']}});
  const indirect=source('indirect','鱼的世界今天别打工了。',{role:'document',provenance:{kind:'builtin_memory_api',source_refs:['learning']}});
  const base=memory('base',['learning']),child=memory('child',['owner'],{attributes:{basis_refs:[{id:'base',revision:1}]}}),grandchild=memory('grandchild',['owner'],{attributes:{basis_refs:[{id:'child',revision:1}]}});
  const {policy,reads}=fixture('今天别打工了',[owner,learning,indirect],[base,child,grandchild]);
  assert.equal(policy.source(learning),false);assert.equal(policy.source(indirect),false);assert.equal(policy.memory(grandchild),false);assert.equal(policy.memory(memory('good',['owner'])),true);
  const count=reads();for(let i=0;i<100;i++)assert.equal(policy.memory(grandchild),false);assert.equal(reads(),count,'positive and negative ancestry are cached for the recall');
});

test('missing, cyclic and excessive ancestry conservatively fails within a bounded read set',()=>{
  const owner=source('owner','今天别打工了。'),a=memory('a',['owner'],{attributes:{basis_refs:[{id:'b'}]}}),b=memory('b',['owner'],{attributes:{basis_refs:[{id:'a'}]}});
  const cyclic=fixture('今天别打工了',[owner],[a,b]);assert.equal(cyclic.policy.memory(a),false);
  assert.equal(cyclic.policy.memory(memory('missing',['owner'],{attributes:{basis_refs:[{id:'absent'}]}})),false);
  const chain=Array.from({length:100},(_,i)=>memory('chain-'+i,['owner'],{attributes:{basis_refs:i<99?[{id:'chain-'+(i+1)}]:[]}}));
  const deep=fixture('今天别打工了',[owner],chain);assert.equal(deep.policy.memory(chain[0]),false);assert.ok(deep.reads()<200);
});
