import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {maybeAutoTextPlan} from '../extensions/aurabot/history-vault/existing-engine.mjs';

const scope={sessionId:'synthetic-session',chatId:'private:10001',persona:'synthetic'};
const now=4*3600000;
const cfg=()=>({contextCompressionOrigin:'http://127.0.0.1:1'});
function fixture(){
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'context-scan-')),api={dataDir:name=>path.join(folder,name)};
 const plan={kind:'verified-existing-engine-plan',scope,backupReceipt:{verified:true},ranges:[]},bytes=JSON.stringify(plan);
 fs.writeFileSync(api.dataDir('context-governance-plan.json'),bytes);
 fs.writeFileSync(api.dataDir('context-engine-auto.json'),JSON.stringify({sessionId:scope.sessionId,completed:0,lastAt:1,lastAttemptAt:1}));
 const events=Array.from({length:16},(_,i)=>({seq:i,type:'turn/end',data:{turn:i,reason:{kind:'completed'}}}));
 return {api,bytes,events};
}
const response=value=>({ok:true,json:async()=>value});
test('optional scan shares one read budget and leaves the verified plan intact on slow successful reads',async()=>{
 const {api,bytes,events}=fixture();let elapsed=0,calls=0,posts=0;
 const fetcher=async(url,options)=>{calls++;elapsed+=100;if(options.method==='POST')posts++;return response(url.includes('/plugin/status')?{ok:true,compressibleRanges:[{startRef:'m00001',endRef:'m00128'}]}:{ok:true,role:'user',text:'unique synthetic evidence'});};
 const result=await maybeAutoTextPlan(api,cfg,{scope,sourceEvents:events,fetcher,now,scanClock:()=>elapsed});
 assert.equal(result.held,'scan-read-deadline');assert.equal(result.budgetMs,2000);assert.equal(calls,20);assert.equal(posts,0);
 assert.equal(fs.readFileSync(api.dataDir('context-governance-plan.json'),'utf8'),bytes);
 const state=JSON.parse(fs.readFileSync(api.dataDir('context-engine-auto.json')));assert.equal(state.lastAttemptAt,now);assert.equal(state.completed,0);
 const held=await maybeAutoTextPlan(api,cfg,{scope,sourceEvents:events,fetcher,now:now+1000});assert.equal(held.held,'waiting-batch-boundary');assert.equal(calls,20);
});
test('read deadline covers response bodies even when a transport ignores abort',async()=>{
 const {api,bytes,events}=fixture();let signal,release,calls=0,posts=0;
 const fetcher=async(_url,options)=>{calls++;if(options.method==='POST')posts++;signal=options.signal;return {ok:true,json:()=>new Promise(resolve=>{release=resolve;})};};
 const started=performance.now(),result=await maybeAutoTextPlan(api,cfg,{scope,sourceEvents:events,fetcher,now,scanBudgetMs:25});
 assert.equal(result.held,'scan-read-deadline');assert.equal(signal.aborted,true);assert.ok(performance.now()-started<1000);
 assert.equal(fs.readFileSync(api.dataDir('context-governance-plan.json'),'utf8'),bytes);
 release({ok:true,compressibleRanges:[{startRef:'m00001',endRef:'m00128'}]});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);assert.equal(posts,0);assert.equal(fs.readFileSync(api.dataDir('context-governance-plan.json'),'utf8'),bytes);
});
test('a fast profitable scan completes compression and its receipt after the read deadline is released',async()=>{
 const {api}=fixture(),events=[];let seq=0;
 const memo='【历史备忘 · private:10001】更早的细节可用 recall_history 工具查询：'+'精确事实原文。'.repeat(10000);
 for(let turn=1;turn<=16;turn++){
  events.push({seq:seq++,type:'turn/start',data:{turn}});
  if(turn<=2)events.push({seq:seq++,type:'user/message',data:{role:'user',source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},content:[{type:'text',text:'【私聊】[12:00] 合成主人(10001)：fixture '+turn},{type:'text',text:memo},{type:'text',text:'【当前本机时间】2026-11-22 星期日 12:00'}]}});
  events.push({seq:seq++,type:'turn/end',data:{turn,reason:{kind:'completed'}}});
 }
 let posted=false,postMs=0,readClock=0;
 const status={ok:true,contextTokens:60000,sessionRevision:'a'.repeat(64),compressibleRanges:[{startRef:'m00001',endRef:'m00002'}]};
 const fetcher=async(url,options)=>{
  if(options?.method==='POST'){
   posted=true;const start=performance.now();await new Promise(resolve=>setTimeout(resolve,150));postMs=performance.now()-start;readClock=100000;
   assert.equal(options.signal.aborted,false);return response({blocksCreated:1,outcome:'applied'});
  }
  if(url.endsWith('/__bili/config'))return response({});
  if(url.includes('/message?'))return response({ok:true,role:'user',text:memo});
  if(url.includes('/plugin/status'))return response(status);
  if(url.endsWith('/detail')){const plan=JSON.parse(fs.readFileSync(api.dataDir('context-governance-plan.json')));return response({blockDetails:posted?plan.ranges.map(range=>({...range,active:true,blockId:'synthetic-block'})):[]});}
  throw Error('Unexpected synthetic URL');
 };
 const result=await maybeAutoTextPlan(api,cfg,{scope,sourceEvents:events,fetcher,now,scanBudgetMs:100,scanClock:()=>readClock});
 assert.equal(result.applied,1);assert.equal(result.blocksCreated,1);assert.ok(postMs>100);
 const plan=JSON.parse(fs.readFileSync(api.dataDir('context-governance-plan.json')));assert.equal(plan.ranges[0].applied.blockId,'synthetic-block');
 const receipt=JSON.parse(fs.readFileSync(api.dataDir('context-engine-receipts.jsonl'),'utf8').trim());assert.equal(receipt.applied,1);
});
