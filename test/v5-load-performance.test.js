import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { V5Runtime,termsOf } from '../core/v5-runtime.js';
import { LAYERS } from '../core/v5-config.js';

function previousSelection(r,{scope='all',layer=null,limit=240,until=null,q='',focus_id=null}){
  // Freeze the pre-optimization selection contract independently of the new SQL selector.
  let rows=r.store.sql("SELECT id,layer,occurred occurred_at,updated updated_at,json_extract(json,'$.created_at') created_at FROM memories "+(scope==='all'?'NOT INDEXED':'INDEXED BY memory_scope')+" WHERE layer!='forgotten' AND kind!='archive_chunk' AND validity='current'"+(scope==='all'?'':' AND scope=?')).all(...(scope==='all'?[]:[scope]));
  if(layer)rows=rows.filter(m=>m.layer===layer);
  if(until!==null)rows=rows.filter(m=>m.occurred_at===null||m.occurred_at<=until);
  if(q){const ids=new Set(r.store.search(scope,termsOf(q),5000).map(m=>m.id));rows=rows.filter(m=>ids.has(m.id));}
  rows.sort((a,b)=>Number(b.id===focus_id)-Number(a.id===focus_id)||b.created_at-a.created_at||b.updated_at-a.updated_at);
  const chosen=[],seen=new Set();
  if(!layer)for(const l of LAYERS)for(const m of rows.filter(m=>m.layer===l.id).slice(0,Math.ceil(limit/LAYERS.length))){if(chosen.length>=limit)break;chosen.push(m);seen.add(m.id);}
  for(const m of rows){if(chosen.length>=limit)break;if(!seen.has(m.id)){chosen.push(m);seen.add(m.id);}}
  return {ids:chosen.map(m=>m.id),matching:rows.length,layers:LAYERS.map(l=>rows.filter(m=>m.layer===l.id).length)};
}

test('indexed atlas preserves layer quotas, exact scope, dates, search, focus and stable ordering',t=>{
  const r=new V5Runtime({clock:()=>1800000});t.after(()=>r.close());const scopes=[],ids=[];
  for(let i=0;i<96;i++){
    const receipt=r.ingest({context:{persona_id:'synthetic',scope:'private:'+i%2},text:'合成线索'+i,occurred_at:i%6?10000+i:null});
    if(!scopes.includes(receipt.scope))scopes.push(receipt.scope);ids.push(receipt.memory_id);
    const m=r.memory(receipt.memory_id);m.layer=LAYERS[i%LAYERS.length].id;m.created_at=100000+Math.floor(i/3)*10;m.updated_at=100000+Math.floor(i/5)*10;
    if(i%17===0)m.kind='archive_chunk';if(i%19===0)m.validity='superseded';if(i%23===0)m.layer='forgotten';r.store.putMemory(m,'合成线索'+i,{history:false});
  }
  for(const scope of ['all',...scopes])for(const limit of [0,1,3,17])for(const layer of [null,'warm','deep'])for(const until of [null,10045])for(const q of ['','线索31','不存在线索ZZ'])for(const focus_id of [null,ids[31]]){
    const options={scope,limit,layer,until,q,focus_id},expected=previousSelection(r,options),actual=r.graph(options);
    assert.deepEqual(actual.nodes.map(m=>m.id),expected.ids,JSON.stringify(options));assert.equal(actual.counts.matching,expected.matching);assert.deepEqual(actual.layers.map(l=>l.count),expected.layers);
  }
  r.store.stats=()=>{throw Error('full statistics scan during graph');};assert.equal(r.graph({limit:3}).nodes.length,3);
});

test('retained DSH atlas survives collapse/reopen and sends explicit pause/resume ownership messages',async()=>{
  const source=readFileSync(new URL('../adapters/aurabot/module/panel.js',import.meta.url),'utf8'),slots=[],pending=[];let cursor=0;
  const React={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef(initial){const i=cursor++;return slots[i]??=( {current:initial} );},
    useEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((value,n)=>!Object.is(value,old.deps[n]))){slots[i]={deps};pending.push(effect);}},
  };
  const ui={Card:'card',Btn:'button'},h=(type,props,...children)=>({type,props:props??{},children}),status={atlas_url:'/aurabot/api/ext/thinkstar-memory/atlas/',stats:{}},messages=[];
  const component=vm.runInNewContext('(function(React,h,ui,call){'+source+'})',{window:{location:{origin:'dsh-app://app'}},setInterval:()=>1,clearInterval(){}})(React,h,ui,()=>Promise.resolve(status));
  const render=()=>{cursor=0;const tree=component({toast:assert.fail});for(const effect of pending.splice(0))effect();return tree;};
  const find=(node,predicate)=>{if(!node||typeof node!=='object')return;return predicate(node)?node:[...(node.children??[]),node.props?.right].map(child=>find(child,predicate)).find(Boolean);};
  let tree=render();
  let iframe=find(tree,n=>n.type==='iframe');assert.ok(iframe);const ref=iframe.props.ref,src=iframe.props.src;
  ref.current={contentWindow:{postMessage:(message,origin)=>messages.push({message,origin})}};iframe.props.onLoad();
  find(tree,n=>n.type==='button'&&n.children[0]==='收起星图').props.onClick();tree=render();iframe=find(tree,n=>n.type==='iframe');assert.ok(iframe);assert.equal(iframe.props.ref,ref);assert.equal(iframe.props.hidden,true);assert.equal(iframe.props.style.display,'none');
  find(tree,n=>n.type==='button'&&n.children[0]==='打开星图').props.onClick();tree=render();iframe=find(tree,n=>n.type==='iframe');assert.equal(iframe.props.src,src);assert.equal(iframe.props.ref,ref);assert.equal(iframe.props.hidden,false);
  assert.deepEqual(messages.map(m=>m.message.visible),[true,false,true]);assert.ok(messages.every(m=>m.origin==='dsh-app://app'));
});
