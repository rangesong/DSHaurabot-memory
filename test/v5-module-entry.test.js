import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../adapters/aurabot/module/panel.js',import.meta.url),'utf8');
const find=(node,predicate)=>!node||typeof node!=='object'?undefined:predicate(node)?node:[...(node.children??[]),node.props?.right].map(child=>find(child,predicate)).find(Boolean);
function mount(call){
  const instances=new Map(),effects=[],timers=new Map();let current=null,next=0,visited=new Set();
  const React={Fragment:'fragment',
    useState(initial){const slots=current.slots,i=current.cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef(initial){const slots=current.slots,i=current.cursor++;return slots[i]??={current:initial};},
    useEffect(effect,deps){const slots=current.slots,i=current.cursor++,old=slots[i];if(!old||deps.some((value,n)=>!Object.is(value,old.deps[n]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}},
  };
  const h=(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),ui={Card:'card',Btn:'button'};
  const component=vm.runInNewContext('(function(React,h,ui,call){'+source+'})',{window:{location:{origin:'dsh-app://app'}},URLSearchParams,Intl,setInterval:fn=>{timers.set(++next,fn);return next;},clearInterval:id=>timers.delete(id)})(React,h,ui,call);
  function renderNode(node,path='root'){
    if(!node||typeof node!=='object')return node;
    if(typeof node.type==='function'){visited.add(path);let instance=instances.get(path);if(!instance){instance={slots:[],cursor:0};instances.set(path,instance);}const previous=current;current=instance;instance.cursor=0;const value=node.type({...node.props,children:node.children});current=previous;return renderNode(value,path+'/value');}
    return {...node,props:{...node.props,right:renderNode(node.props?.right,path+'/right')},children:node.children.map((child,i)=>renderNode(child,path+'/'+(child?.props?.key??i)))};
  }
  return {render(){visited=new Set();const tree=renderNode(h(component,{toast:assert.fail}));for(const [path,instance]of instances)if(!visited.has(path)){for(const slot of instance.slots)slot?.cleanup?.();instances.delete(path);}for(const effect of effects.splice(0))effect();return tree;},timers,unmount(){for(const instance of instances.values())for(const slot of instance.slots)slot?.cleanup?.();}};
}

test('opening the module immediately shows the atlas above settings without waiting for status',()=>{
  let calls=0;const host=mount(()=>{calls++;return new Promise(()=>{});}),tree=host.render();
  assert.equal(calls,0);assert.equal(host.timers.size,0);
  const atlas=find(tree,n=>n.type==='iframe'),section=find(tree,n=>n.type==='section'),diagnostics=find(tree,n=>n.type==='details');
  assert.ok(atlas);assert.equal(atlas.props.src,'/aurabot/api/ext/thinkstar-memory/atlas/');assert.equal(atlas.props.hidden,false);assert.equal(atlas.props.style.display,'block');
  assert.equal(section.props.style.order,-1);assert.equal(diagnostics.props.open,false);assert.ok(find(tree,n=>n.type==='card'&&n.props.title?.props?.['aria-label']==='星图'));
  assert.ok(!find(tree,n=>n.type==='details'&&n.props.open));
  assert.equal(find(diagnostics,n=>n.children?.includes('正在读取模块状态…')),undefined);host.unmount();
});

test('semantic local SVG icons, coloured titles and master control are present without opening sections',()=>{
 const host=mount(()=>Promise.resolve({items:[]})),tree=host.render(),control=find(tree,n=>n.type==='input'&&n.props['aria-label']==='Thinkstar记忆总开关');assert.equal(control.props.checked,true);const star=find(tree,n=>n.type==='card').props.title;assert.ok(find(star,n=>n.type==='svg'));assert.ok(star.props.style.color);assert.ok(find(tree,n=>n.props?.['aria-label']==='夜间自省与行动'));assert.ok(!find(tree,n=>n.type==='details'&&n.props.open));host.unmount();
});

test('diagnostics load on demand, coalesce pending reads, stop polling when closed and keep atlas intact',async()=>{
  let calls=0;const complete=[];const host=mount(()=>{calls++;return new Promise(resolve=>{complete.push(resolve);});});let tree=host.render();const original=find(tree,n=>n.type==='iframe'),diagnostics=tree=>find(tree,n=>n.type==='details'&&find(n.children[0],x=>x.props?.['aria-label']==='运行状态与说明'));
  diagnostics(tree).props.onToggle({currentTarget:{open:true}});tree=host.render();const openedCalls=calls;assert.ok(calls>=2);assert.equal(host.timers.size,1);
  for(const tick of host.timers.values())tick();assert.equal(calls,openedCalls,'slow status reads cannot overlap');
  assert.equal(find(tree,n=>n.type==='iframe').props.ref,original.props.ref);
  for(const resolve of complete)resolve({items:[],stats:{objects:321,sources:123,pending:0},mode:'active',groups:['memory','work','store'].map(id=>({id,regions:[]})),scopes:[],host_context:{session_meter:true,request_observer:true,requests:7}});await new Promise(setImmediate);tree=host.render();
  diagnostics(tree).props.onToggle({currentTarget:{open:false}});tree=host.render();assert.equal(host.timers.size,0);assert.equal(find(tree,n=>n.type==='iframe').props.hidden,false);host.unmount();
});

test('compact atlas removes the banner and moves state, model controls and photographic credit off the canvas',()=>{
  const html=readFileSync(new URL('../apps/memory-sea/index.html',import.meta.url),'utf8'),stage=html.indexOf('<section class="stage');
  assert.doesNotMatch(html,/<header>|NEURAL ATLAS|一段记忆，从此刻沉入星海/);
  for(const id of ['scene-status','character-status','source-count','object-count','live-status','live-light','model-button','about-button','flow-state']){
    assert.equal(html.split('id="'+id+'"').length,2,id+' remains unique');assert.ok(html.indexOf('id="'+id+'"')<stage,id+' is outside the canvas stage');
  }
  assert.ok(html.indexOf('银河影像：ESO/S. Brunier')<stage);assert.ok(html.includes('https://creativecommons.org/licenses/by/4.0/'));
  for(const id of ['view-overview','view-directory','view-replay','view-governance','brain-only','mobile-menu','mobile-panel','toggle-input-dock'])assert.ok(html.includes('id="'+id+'"'));
});
