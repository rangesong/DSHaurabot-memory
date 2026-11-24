import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorldToolScope} from '../extensions/aurabot/fish-world/world-tool-scope.mjs';
import {prepareRequest} from '../extensions/aurabot/fish-world/host-runtime.mjs';
import {worldNames,LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';
import {estimateTokens} from '../extensions/aurabot/fish-world/governance.mjs';

const base='synthetic-scope',prefix='system:ext-fish-world:',now=Date.parse('2026-11-24T15:00:00+08:00');
function fixture(){
 const identity={owner:'synthetic-owner',persona:'synthetic-persona'},offs=[],masks=[],trace=[],routes=new Map([['session-old',prefix+'window-old'],['session-new',prefix+'window-current']]);
 const life={...identity,sessionId:'session-old',contextWindow:{base,key:'window-current',windows:[{key:'window-old',sessionId:'session-old'},{key:'window-current',sessionId:null}]}};
 const engine={l:life,closed:false},locals=[{name:'fish_life_finish'},{name:'fish_dialogue_history'}],globals=[...worldNames.map(name=>({name})),{name:'unrelated_tool',description:'x'.repeat(80000)}];
 const target={restrict(filter){trace.push('restrict');const mask={allow:new Set(filter.allow),active:true};masks.push(mask);return ()=>{trace.push('release');mask.active=false;};}};
 const agent={session:{id:'session-old',deriveMessages:()=>[]},ctx:{tools:target}},tools={schemas(){trace.push('schemas');return [...globals.filter(s=>masks.every(m=>!m.active||m.allow.has(s.name))),...locals];}};
 const options={getEngine:()=>engine,identity:()=>identity,scope:()=>base,chatOfSession:id=>routes.get(id),tools,names:worldNames,onRelease:off=>offs.push(off)},ensure=createWorldToolScope(options);
 return {identity,life,engine,agent,target,tools,offs,masks,trace,routes,ensure,options,locals,globals};
}

test('owned old Agent is restricted before schema reads and local life/dialogue tools remain visible',()=>{
 const f=fixture(),before=structuredClone(f.life),names=f.ensure(f.agent,{existing:true});
 assert.deepEqual(f.trace,['restrict','schemas']);assert.ok(worldNames.every(name=>names.includes(name)));
 assert.ok(names.includes('fish_life_finish')&&names.includes('fish_dialogue_history'));assert.ok(!names.includes('unrelated_tool'));
 assert.deepEqual(f.life,before);assert.equal(f.offs.length,1);
});
test('preflight and builder reuse one exact ctx.tools restriction and its module-owned disposer',()=>{
 const f=fixture();f.ensure(f.agent,{existing:true});f.ensure(f.agent,{existing:true});
 f.agent.session.id='session-new';f.ensure(f.agent,{chat:{kind:'system',chatId:prefix+'window-current'}});
 assert.equal(f.masks.length,1);assert.equal(f.offs.length,1);assert.equal(f.life.contextWindow.windows.at(-1).sessionId,null);
 f.offs[0]();f.offs[0]();assert.equal(f.trace.filter(x=>x==='release').length,1);assert.ok(f.tools.schemas(f.agent).some(s=>s.name==='unrelated_tool'));
 f.ensure(f.agent,{chat:{kind:'system',chatId:prefix+'window-current'}});assert.equal(f.masks.length,2);
});
test('foreign owner/persona/base/ledger/route cannot touch the Agent registry, even without restrict',()=>{
 for(const mutate of [f=>{f.identity.owner='foreign';},f=>{f.identity.persona='foreign';},f=>{f.life.contextWindow.base='foreign';},f=>{f.agent.session.id='session-foreign';},f=>{f.routes.set('session-old','private:synthetic-owner');},f=>{f.routes.set('session-old',prefix+'unlisted-window');}]){
  const f=fixture();mutate(f);f.agent.ctx={};assert.throws(()=>f.ensure(f.agent,{existing:true}));assert.deepEqual(f.trace,[]);assert.deepEqual(f.offs,[]);
 }
 const cached=fixture();cached.ensure(cached.agent,{existing:true});cached.identity.persona='changed';const trace=[...cached.trace];assert.throws(()=>cached.ensure(cached.agent,{existing:true}));assert.deepEqual(cached.trace,trace);
});
test('new unbound window accepts only the current key with the actual host mapping',()=>{
 const f=fixture();f.agent.session.id='session-new';
 assert.throws(()=>f.ensure(f.agent,{existing:true}));assert.deepEqual(f.trace,[]);
 assert.throws(()=>f.ensure(f.agent,{chat:{kind:'system',chatId:prefix+'window-old'}}));assert.deepEqual(f.trace,[]);
 f.routes.delete('session-new');assert.throws(()=>f.ensure(f.agent,{chat:{kind:'system',chatId:prefix+'window-current'}}));assert.deepEqual(f.trace,[]);
 f.routes.set('session-new',prefix+'window-current');assert.ok(f.ensure(f.agent,{chat:{kind:'system',chatId:prefix+'window-current'}}).includes(worldNames[0]));
 assert.equal(f.life.contextWindow.windows.at(-1).sessionId,null,'scope recovery must not bind or edit a window');
});
test('legacy ownership requires matching current ledger id and the scope-derived actual route',()=>{
 const f=fixture();delete f.life.contextWindow;f.routes.set('session-old',prefix+base);
 assert.ok(f.ensure(f.agent,{existing:true}).length);const other=fixture();delete other.life.contextWindow;other.life.sessionId='session-other';
 assert.throws(()=>other.ensure(other.agent,{existing:true}));assert.deepEqual(other.trace,[]);
});
test('owned unsupported registry and missing world tools fail closed; lifecycle registration failure releases the mask',()=>{
 const f=fixture();delete f.agent.ctx.tools;assert.throws(()=>f.ensure(f.agent,{existing:true}),/接口/);assert.deepEqual(f.trace,[]);
 const missing=fixture();missing.globals.splice(0,1);assert.throws(()=>missing.ensure(missing.agent,{existing:true}),/不完整/);assert.equal(missing.offs.length,1);
 const failed=fixture(),ensure=createWorldToolScope({...failed.options,onRelease:()=>{throw Error('synthetic lifecycle failure');}});
 assert.throws(()=>ensure(failed.agent,{existing:true}),/synthetic lifecycle failure/);assert.deepEqual(failed.trace,['restrict','release']);
});
test('prepare requires synchronous scope recovery for old Agents and measures actual schemas only afterwards',async()=>{
 const f=fixture(),engine={l:f.life,cfg:{backgroundContextEnabled:false,backgroundContextRounds:16,visibleContextEstimatedTokenLimit:48000,requestAdmissionEstimatedTokenLimit:64000},change:fn=>fn(f.life),bridge:{data:{at:{state:now},state:{}}},clock:()=>now};
 const api={dsh:{get:name=>name==='tools'?f.tools:null},dataDir:(...parts)=>path.join(process.env.THINKSTAR_TEST_TMP,'scope-prepare',...parts)};
 const options={scope:()=>base,findAgent:()=>f.agent,identity:()=>f.identity},round={events:[],planIds:[]};
 await assert.rejects(()=>prepareRequest(engine,api,options,'synthetic',round),/缺少/);assert.deepEqual(f.trace,[]);
 await assert.rejects(()=>prepareRequest(engine,api,{...options,restoreWorldScope:async()=>[]},'synthetic',round),/同步/);assert.deepEqual(f.trace,[]);
 const faked=fixture();faked.agent.session.id='session-foreign';
 await assert.rejects(()=>prepareRequest(engine,api,{...options,findAgent:()=>faked.agent,restoreWorldScope:agent=>faked.ensure(agent,{existing:true})},'synthetic',round),/本身份/);assert.deepEqual(faked.trace,[]);
});

function extractSdk(asar,scratch){
 assert.ok(scratch,'Run through scripts/run-tests.js');const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw),target=path.join(scratch,'world-scope-sdk'),queue=['@deepseek-ai/dsh-tools','@deepseek-ai/dsh-scope','@deepseek-ai/cordis'],seen=new Set();
 const find=p=>{let n=tree;for(const part of p.split('/'))n=n?.files?.[part];return n;};fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 try{while(queue.length){const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed SDK package '+pkg);
  function copy(node,relative=''){for(const[name,entry]of Object.entries(node.files||{})){const rel=relative?relative+'/'+name:name;if(entry.files){copy(entry,rel);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+rel);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}const file=path.join(target,'node_modules',pkg,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const spec=match[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;queue.push(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]);}}}copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}
let sdkPromise;
async function installed(t){
 if(!process.env.DSH_ASAR){t.skip('Set DSH_ASAR for installed SDK scope proof');return null;}
 sdkPromise??=(async()=>{const root=extractSdk(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),load=p=>import(pathToFileURL(path.join(root,'node_modules',p,'lib/index.js')).href);return Object.assign({},...await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-scope')]));})();return sdkPromise;
}
async function realFixture(t,sdk){
 const ctx=new sdk.Context();ctx.reflect.provide('systemPrompt',{tools:()=>()=>{}});const registry=new sdk.ToolsService(ctx);
 const def=(name,description='synthetic')=>({name,description,parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({})});
 for(const name of worldNames)ctx.tools.register(def(name));ctx.tools.register(def('unrelated_large_tool','x'.repeat(88000)));ctx.tools.register(def('other_global'));
 const f=fixture(),agent={session:{id:'session-old',deriveMessages:()=>[]}},scoped=sdk.createScope(ctx,agent);agent.ctx=scoped.ctx;
 agent.ctx.tools.register(def('fish_life_finish'));agent.ctx.tools.register(def('fish_dialogue_history'));
 const unrelated={session:{id:'unrelated-session'}},otherScope=sdk.createScope(ctx,unrelated);unrelated.ctx=otherScope.ctx;
 t.after(async()=>{await scoped.dispose();await otherScope.dispose();await ctx.dispose?.();});
 const offs=[],ensure=createWorldToolScope({...f.options,getEngine:()=>f.engine,tools:registry,onRelease:off=>offs.push(off)});
 return {...f,agent,registry,ctx,scoped,otherScope,unrelated,ensure,offs};
}
test('actual SDK scopes intersect global restrictions, preserve own local tools and leave foreign agents untouched',async t=>{
 const sdk=await installed(t);if(!sdk)return;const f=await realFixture(t,sdk);
 const foreignBefore=f.registry.schemas(f.unrelated),before=estimateTokens(f.registry.schemas(f.agent));assert.ok(before>40000);
 const original=f.agent.ctx.tools.restrict({deny:['other_global']});t.after(original);
 const names=f.ensure(f.agent,{existing:true});assert.ok(worldNames.every(n=>names.includes(n)));assert.ok(names.includes('fish_life_finish')&&names.includes('fish_dialogue_history'));assert.ok(!names.includes('unrelated_large_tool'));
 f.ensure(f.agent,{existing:true});assert.equal(f.offs.length,1,'real ctx.tools receiver identity must deduplicate repeated preparations');
 assert.deepEqual(f.registry.schemas(f.unrelated),foreignBefore);assert.ok(estimateTokens(f.registry.schemas(f.agent))<8000);
 f.offs[0]();assert.equal(f.registry.schemas(f.agent).some(s=>s.name==='other_global'),false,'another restriction must remain after our mask is released');
 assert.equal(f.registry.schemas(f.agent).some(s=>s.name==='unrelated_large_tool'),true);
 f.ensure(f.agent,{existing:true});assert.equal(f.offs.length,2);assert.ok(!f.registry.schemas(f.agent).some(s=>s.name==='unrelated_large_tool'));
});
test('actual SDK recovery precedes preflight measurement and permits a bounded fresh window under the original 64k cap',async t=>{
 const sdk=await installed(t);if(!sdk)return;const f=await realFixture(t,sdk),data={fishId:'synthetic-fish',at:{state:now},state:{},now:'synthetic',life:newLife(now)},engine=new LifeEngine({bridge:{data,change:fn=>fn(data)},clock:()=>now,identity:()=>f.identity,settings:()=>({backgroundContextEnabled:true}),host:{idle:async()=>true}});
 Object.assign(engine.l,f.identity);const oldKey=chooseWindow(engine,base,{nonce:()=> 'old'});engine.bind('session-old',worldNames);f.routes.set('session-old',prefix+oldKey);
 const history=[{role:'user',content:[{type:'text',text:'h'.repeat(94000)}]}];f.agent.session.deriveMessages=()=>history;
 const oldModuleOff=f.agent.ctx.tools.restrict({allow:worldNames});assert.ok(estimateTokens(f.registry.schemas(f.agent))<8000);oldModuleOff();
 const offs=[],ensure=createWorldToolScope({...f.options,getEngine:()=>engine,tools:f.registry,onRelease:off=>offs.push(off)}),fullTokens=estimateTokens(f.registry.schemas(f.agent));assert.ok(fullTokens>40000,'unloading the old module mask reproduces the all-tool preflight trap');
 const kept=structuredClone({days:engine.l.days,outbox:engine.l.outbox,journal:engine.l.journal}),round={id:'synthetic-round',events:[],planIds:[],kind:'idle'},folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'scope-rotation-')),api={dsh:{get:name=>name==='tools'?f.registry:null},dataDir:(...parts)=>path.join(folder,...parts)};
 const prepared=await prepareRequest(engine,api,{scope:()=>base,findAgent:()=>f.agent,identity:()=>f.identity,restoreWorldScope:agent=>ensure(agent,{existing:true})},engine.prompt([],round),round);
 assert.notEqual(prepared.windowKey,oldKey);assert.equal(prepared.estimate.visibleContextTokens,0);assert.equal(prepared.estimate.toolsTokens,estimateTokens(f.registry.schemas(f.agent)));assert.ok(prepared.estimate.requestTokens<64000);assert.equal(engine.cfg.requestAdmissionEstimatedTokenLimit,64000);
 assert.deepEqual({days:engine.l.days,outbox:engine.l.outbox,journal:engine.l.journal},kept);assert.equal(engine.l.contextWindow.windows.at(-1).sessionId,null);assert.equal(offs.length,1);
 t.diagnostic(JSON.stringify({beforeToolsTokens:fullTokens,afterToolsTokens:prepared.estimate.toolsTokens,requestTokens:prepared.estimate.requestTokens,requestLimit:64000,modelCalls:0,qqSends:0}));
});
