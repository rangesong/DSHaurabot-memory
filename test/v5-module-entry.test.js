import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {V5Runtime} from '../core/v5-runtime.js';
import {consoleLayout} from '../core/v5-console.js';

const source=readFileSync(new URL('../adapters/aurabot/module/panel.js',import.meta.url),'utf8');
const find=(node,predicate)=>!node||typeof node!=='object'?undefined:predicate(node)?node:[...(node.children??[]),node.props?.right].map(child=>find(child,predicate)).find(Boolean);
function mount(call,{toast=assert.fail}={}){
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
    if(typeof node.type==='function'){visited.add(path);let instance=instances.get(path);if(!instance||instance.type!==node.type){for(const slot of instance?.slots??[])slot?.cleanup?.();instance={type:node.type,slots:[],cursor:0};instances.set(path,instance);}const previous=current;current=instance;instance.cursor=0;const value=node.type({...node.props,children:node.children});current=previous;return renderNode(value,path+'/value');}
    return {...node,props:{...node.props,right:renderNode(node.props?.right,path+'/right')},children:node.children.map((child,i)=>renderNode(child,path+'/'+(child?.props?.key!=null?'key:'+child.props.key:'index:'+i)))};
  }
  return {render(){visited=new Set();const tree=renderNode(h(component,{toast}));for(const [path,instance]of instances)if(!visited.has(path)){for(const slot of instance.slots)slot?.cleanup?.();instances.delete(path);}for(const effect of effects.splice(0))effect();return tree;},timers,unmount(){for(const instance of instances.values())for(const slot of instance.slots)slot?.cleanup?.();}};
}

test('automatic implicit panel stays folded and offers versioned pause/revoke with visible provenance',async t=>{
 const runtime=new V5Runtime(),requests=[],toasts=[],scope=runtime.addScope({persona_id:'panel',scope:'private:100'}).id;
 let item={id:'synthetic-rule',scope,label:'内隐准则 · 疲惫',condition:'疲惫',body:'合成表达准则',revision:4,layer:'implicit',status:'active',stage:'trial',independent:3,days:3,outcomes:0,source_count:6,reason:'独立依据检查通过',rule:{origin:'feedback_maturation',status:'active',validation:{evidence:[],outcomes:[]}},history:[]};
 const host=mount(async(route,body)=>{requests.push({route,body});if(route.endsWith('console-layout'))return consoleLayout(runtime);if(route.includes('dialogue-feedback'))return {items:[]};if(route.includes('implicit-learning'))return {items:[item]};if(route.endsWith('central-rule')){assert.equal(body.expected_revision,item.revision);item={...item,revision:item.revision+1,status:body.action==='pause'?'paused':'revoked',layer:'mature',rule:{...item.rule,status:body.action==='pause'?'paused':'revoked'}};return {memory:{revision:item.revision,layer:item.layer,attributes:{central_rule:item.rule}}};}throw Error('Unexpected route '+route);},{toast:s=>toasts.push(s)});
 t.after(()=>{host.unmount();runtime.close();});let tree=host.render();
 const fold=title=>find(tree,n=>n.type==='details'&&find(n.children?.[0],x=>x.props?.['aria-label']===title));
 const open=async title=>{const node=fold(title);assert.ok(node,title);node.props.onToggle({currentTarget:{open:true}});tree=host.render();await new Promise(setImmediate);tree=host.render();};
 await open('反馈与学习');assert.equal(fold('经验成熟与内隐准则').props.open,false);assert.ok(!requests.some(r=>r.route.includes('implicit-learning')));
 await open('经验成熟与内隐准则');await open(item.label);assert.equal(fold('成熟与验证依据').props.open,false);
 await find(tree,n=>n.type==='button'&&n.children.includes('暂停这条准则')).props.onClick();tree=host.render();assert.equal(requests.at(-1).body.action,'pause');assert.ok(!find(tree,n=>n.type==='button'&&n.children.includes('暂停这条准则')));
 await find(tree,n=>n.type==='button'&&n.children.includes('撤回这条准则')).props.onClick();tree=host.render();assert.equal(requests.at(-1).body.expected_revision,5);assert.ok(toasts.at(-1).includes('不会被后台重新启用'));assert.ok(!find(tree,n=>n.type==='button'&&n.children.includes('撤回这条准则')));
});

test('group lifecycle controls stay folded, save exactly five scoped fields and explain coverage',async t=>{
  const runtime=new V5Runtime(),requests=[],toasts=[];
  const host=mount(async(route,body)=>{
    requests.push({route,body});
    if(route.endsWith('console-layout'))return consoleLayout(runtime);
    if(route.includes('group-lifecycle'))return runtime.groupLifecycleStatus();
    if(route.endsWith('config'))return body?runtime.updateConfig(body):runtime.getConfig();
    throw Error('Unexpected panel route '+route);
  },{toast:value=>toasts.push(value)});
  t.after(()=>{host.unmount();runtime.close();});
  let tree=host.render();
  const fold=(title)=>find(tree,n=>n.type==='details'&&find(n.children?.[0],x=>x.props?.['aria-label']===title));
  const open=async title=>{const node=fold(title);assert.ok(node,title);node.props.onToggle({currentTarget:{open:true}});tree=host.render();await new Promise(setImmediate);tree=host.render();};
  await open('工作中枢');await open('海马体');await open('参数调节');
  assert.equal(fold('群聊专用压缩与遗忘').props.open,false);
  assert.ok(!requests.some(r=>r.route.includes('group-lifecycle')));
  await open('群聊专用压缩与遗忘');
  let section=fold('群聊专用压缩与遗忘');
  assert.ok(find(section,n=>n.children?.some(c=>typeof c==='string'&&c.includes('原生 memory 与 history-vault'))));
  const control=find(section,n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(control.props.checked,false);
  control.props.onChange({target:{checked:true}});tree=host.render();section=fold('群聊专用压缩与遗忘');
  await find(section,n=>n.type==='button'&&n.children?.includes('保存参数')).props.onClick();
  await new Promise(setImmediate);tree=host.render();
  const saved=requests.find(r=>r.body?.values?.group_policy_enabled===1);
  assert.deepEqual(Object.keys(saved.body.values).sort(),['group_low_value_exit_days','group_ordinary_trace_exit_days','group_policy_enabled','group_recent_days','group_trace_after_days']);
  assert.deepEqual(Array.from(Object.values(saved.body.values)).sort(),[1,1,2,3,4]);
  assert.equal(runtime.config.W5.group_policy_enabled,1);
  assert.deepEqual(toasts,['参数已保存']);
  assert.ok(!requests.some(r=>r.body&&r.route.endsWith('retention-apply')));
});

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
