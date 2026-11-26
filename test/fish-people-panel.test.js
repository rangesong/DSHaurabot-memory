import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {FISH_PEOPLE_PANEL,FISH_PEOPLE_PANEL_PATCH,patchFishPeoplePanel} from '../scripts/lib/fish-people-panel-patch.js';
import {PROFILE_PANEL_PATCH,patchProfilePanel} from '../scripts/lib/profile-lifecycle-patch.js';

const sourceFile=process.env.AURABOT_CLIENT_SOURCE||'D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq/client/client.js';
const available=fs.existsSync(sourceFile);
test('native panel patch is exact, idempotent and preserves every existing QQ operation byte', {skip:!available},()=>{
  const source=fs.readFileSync(sourceFile,'utf8'),result=patchFishPeoplePanel(source,{version:FISH_PEOPLE_PANEL_PATCH.version});
  assert.equal(patchFishPeoplePanel(result.source,{version:FISH_PEOPLE_PANEL_PATCH.version}).receipt.unchanged,true);
  assert.equal(patchProfilePanel(result.source,{version:PROFILE_PANEL_PATCH.version}).source,result.source,'rerunning the existing profile repair must preserve the new fish panel');
  assert.throws(()=>patchFishPeoplePanel(source+'\n',{version:FISH_PEOPLE_PANEL_PATCH.version}),/hash/i);
  assert.throws(()=>patchFishPeoplePanel(source,{version:'other'}),/version/i);
  if(result.receipt.before===FISH_PEOPLE_PANEL_PATCH.before_sha256){
    const restored=result.source.replace(FISH_PEOPLE_PANEL+'    function QQPersonaWall({ toast }) {','    function PersonaWall({ toast }) {')
      .replace('    function PersonaMemory({ toast, st }) {','    function PersonaMemory({ toast }) {')
      .replace("page === 'wall' ? h(PersonaWall, { toast, contextKey: JSON.stringify([st?.config?.ownerQQ, st?.config?.persona?.current]) })","page === 'wall' ? h(PersonaWall, { toast })");
    assert.equal(restored,source);
  }
  const check=spawnSync(process.execPath,['--check','--input-type=module'],{input:result.source,encoding:'utf8',windowsHide:true});
  assert.equal(check.status,0,check.stderr);
  assert.ok(!FISH_PEOPLE_PANEL.includes('qlogo.cn'));assert.ok(!FISH_PEOPLE_PANEL.includes('dangerouslySetInnerHTML'));
  assert.ok(!/\/(?:profiles|persona)\//.test(FISH_PEOPLE_PANEL),'fish UI cannot call QQ save/delete/rebuild endpoints');
});

function harness(get){
  let current;const timers=new Map();let timerId=0;
  function useState(initial){const instance=current,index=instance.index++;if(!(index in instance.states))instance.states[index]=initial;
    return [instance.states[index],value=>{instance.states[index]=typeof value==='function'?value(instance.states[index]):value;}];}
  function useEffect(fn,deps){const instance=current,index=instance.index++,old=instance.effects[index];
    if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){old?.cleanup?.();const effect={deps,cleanup:null};instance.effects[index]=effect;instance.pending.push(()=>{effect.cleanup=fn();});}}
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});
  const useRef=initial=>useState({current:initial})[0];
  const scopedGet=async path=>({available:true,scopeToken:'scope-A',...await get(path)});
  const components=Function('useState','useEffect','useRef','h','Seg','Btn','Empty','Card','QQPersonaWall','get','memoryDate','setInterval','clearInterval',FISH_PEOPLE_PANEL+'\nreturn {PersonaWall,FishWorldPeople,FishWorldPersonDetail};')(
    useState,useEffect,useRef,h,'Seg','Btn','Empty','Card','QQPersonaWall',scopedGet,value=>'date:'+value,fn=>{timers.set(++timerId,fn);return timerId;},id=>timers.delete(id));
  function mount(name,props={}){const instance={states:[],effects:[],pending:[],index:0,props};
    return {render(next=instance.props){instance.props={scopeToken:'scope-A',...next};instance.index=0;current=instance;const result=components[name](instance.props);current=null;while(instance.pending.length)instance.pending.shift()();return result;},unmount(){for(const e of instance.effects)e?.cleanup?.();}};}
  return {mount,components,probe(){for(const fn of timers.values())fn();}};
}
const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...(tree.children||[]).flatMap(nodes)];
const text=tree=>!tree?'':typeof tree==='string'?tree:typeof tree==='object'?(tree.children||[]).map(text).join(' '):'';
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('the original QQ wall remains the default and switching selects the separate fish view',()=>{
  const f=harness(()=>assert.fail('source switching must not fetch or mutate a QQ profile'));
  const page=f.mount('PersonaWall');let tree=page.render();
  assert.ok(nodes(tree).some(n=>n.type==='QQPersonaWall'));
  nodes(tree).find(n=>n.type==='Seg').props.onChange('fish');tree=page.render();
  assert.ok(nodes(tree).some(n=>n.type===f.components.FishWorldPeople));
  assert.ok(!nodes(tree).some(n=>n.type==='QQPersonaWall'));
  tree=page.render({contextKey:'new-persona'});assert.equal(nodes(tree).find(n=>n.type===f.components.FishWorldPeople).props.key,'new-persona');
});

test('fish list reads its own endpoint, paginates without duplicates and preserves loaded records on a read failure',async()=>{
  const calls=[];let fail=false;
  const f=harness(async path=>{calls.push(path);if(fail)throw Error('synthetic unavailable');return path.includes('offset=20')?{ok:true,list:[{fish:'#1',name:'旧重复'},{fish:'#2',name:'合成乙'}],nextOffset:null}:{ok:true,list:[{fish:'#1',name:'合成甲',summary:'有来源的合成往来'}],nextOffset:20};});
  const page=f.mount('FishWorldPeople');page.render();await flush();let tree=page.render();
  assert.ok(text(tree).includes('合成甲'));assert.ok(calls.every(p=>p.startsWith('/ext/fish-world/people?')));
  await nodes(tree).find(n=>n.type==='Btn'&&text(n).includes('加载更多')).props.onClick();tree=page.render();
  assert.ok(text(tree).includes('合成乙'));assert.ok(!text(tree).includes('旧重复'));
  fail=true;await nodes(tree).find(n=>n.type==='Btn'&&text(n)==='刷新').props.onClick();tree=page.render();
  assert.ok(text(tree).includes('合成甲'));assert.ok(text(tree).includes('合成乙'));assert.ok(text(tree).includes('暂时不可用'));
});

test('fish detail displays source roles and times as plain text and never turns quoted content into markup',async()=>{
  const calls=[],f=harness(async path=>{calls.push(path);return {ok:true,person:{fish:'#1',name:'合成甲'},impression:{text:'有来源的合成印象',at:30},observations:[{id:'one',role:'peer',text:'<script>quoted source</script>',occurredAt:10},{id:'two',role:'self',text:'合成回答',observedAt:20}],nextOffset:null};});
  const detail=f.mount('FishWorldPersonDetail',{fish:'#1',back(){}});detail.render();await flush();const tree=detail.render();
  assert.ok(text(tree).includes('有来源的合成印象'));assert.ok(text(tree).includes('对方说的 · date:10'));assert.ok(text(tree).includes('我说的 · 读取于 date:20'));
  assert.ok(text(tree).includes('<script>quoted source</script>'));assert.ok(!nodes(tree).some(n=>n.type==='script'||n.props.dangerouslySetInnerHTML));
  assert.ok(calls.every(p=>p.startsWith('/ext/fish-world/person?fish=%231')));
});

test('a late response from the previously selected fish cannot replace the current fish detail',async()=>{
  const old=deferred(),f=harness(path=>path.includes('%231')?old.promise:Promise.resolve({ok:true,person:{fish:'#2',name:'合成乙'},impression:{text:'当前鱼的印象'},observations:[]}));
  const detail=f.mount('FishWorldPersonDetail',{fish:'#1',back(){}});detail.render();
  detail.render({fish:'#2',back(){}});await flush();assert.ok(text(detail.render()).includes('当前鱼的印象'));
  old.resolve({ok:true,person:{fish:'#1',name:'过期合成甲'},impression:{text:'过期印象'},observations:[]});await flush();
  const tree=detail.render();assert.ok(text(tree).includes('当前鱼的印象'));assert.ok(!text(tree).includes('过期印象'));
});

test('disabled fish impressions stay hidden while the original source remains readable',async()=>{
  const f=harness(async()=>({ok:true,person:{fish:'#1',name:'合成甲'},impression:{text:'已撤回旧印象',disabled:true},observations:[{id:'one',role:'peer',text:'带服务器元数据的原件',body:'真实合成原话',occurredAt:10}]}));
  const detail=f.mount('FishWorldPersonDetail',{fish:'#1',back(){}});detail.render();await flush();const tree=detail.render();
  assert.ok(!text(tree).includes('已撤回旧印象'));assert.ok(text(tree).includes('原有印象已停用'));assert.ok(text(tree).includes('真实合成原话'));assert.ok(!text(tree).includes('带服务器元数据的原件'));
});

test('an unavailable or changed world scope clears old list and never appends another identity page',async()=>{
  let scope='scope-A',available=true;
  const f=harness(async path=>({ok:available,available,scopeToken:available?scope:null,list:path.includes('limit=1')?[]:[{fish:'#1',name:scope==='scope-A'?'上一账号的鱼':'新账号的鱼'}],nextOffset:20}));
  const page=f.mount('FishWorldPeople');page.render();await flush();assert.ok(text(page.render()).includes('上一账号的鱼'));
  scope='scope-B';f.probe();await flush();let tree=page.render();assert.ok(!text(tree).includes('上一账号的鱼'));assert.ok(text(tree).includes('新账号的鱼'));
  assert.equal(nodes(tree).find(n=>n.type===f.components.FishWorldPersonDetail).props.scopeToken,'scope-B');
  available=false;f.probe();await flush();tree=page.render();assert.ok(!text(tree).includes('新账号的鱼'));assert.ok(!nodes(tree).some(n=>n.type===f.components.FishWorldPersonDetail));
  page.unmount();
});

test('detail rejects a same-number fish response from another identity scope',async()=>{
  const f=harness(async()=>({ok:true,scopeToken:'scope-B',person:{fish:'#1'},impression:{text:'另一个账号的旧印象'},observations:[]}));
  const detail=f.mount('FishWorldPersonDetail',{fish:'#1',scopeToken:'scope-A',back(){}});detail.render();await flush();const tree=detail.render();
  assert.ok(!text(tree).includes('另一个账号的旧印象'));assert.ok(text(tree).includes('暂时不可用'));
});
