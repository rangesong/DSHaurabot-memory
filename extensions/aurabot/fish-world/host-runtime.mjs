import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {estimateTokens} from './governance.mjs';
import {readAppliedMigrationReceipt} from './migration.mjs';
import {bindCostTurn,observeCost} from './costs.mjs';
const key=v=>String(v||'').replace(/^session-/,'');
const sha=v=>createHash('sha256').update(v).digest('hex');
export function stableAgentIdle(a){const box=a?.inbox;return a?.status==='idle'&&typeof box?.hasPending==='boolean'&&!box.hasPending&&Array.isArray(box.nextTurn)&&box.nextTurn.length===0&&Array.isArray(box.nextStep)&&box.nextStep.length===0;}
export function ownSession(l,id){if(!id)return false;return key(l.sessionId)===key(id)||(l.contextWindow?.windows||[]).some(w=>key(w.sessionId)===key(id));}
export function installUsage(api,getEngine){
 let price;try{price=api.lib?.('core/usage.js')?.costOf;}catch{}
 const sources=new Map(),offs=[];
 offs.push(api.dsh.on('session/event',(session,event)=>{
  const engine=getEngine();if(!engine||!ownSession(engine.l,session.id))return;
  if(!['turn/start','assistant/message','assistant/attempt'].includes(event.type))return;
  engine.change(l=>{bindCostTurn(l,session.id,event);observeCost(l,session.id,event,{costOf:price,...sources.get(key(session.id)),now:Date.now()});});
 }));
 offs.push(api.dsh.on('llm/stream',(options,next)=>{
  const engine=getEngine();if(!engine||!ownSession(engine.l,options.sessionId))return next();
  return (async function*(){
   const tokens=estimateTokens({messages:options.messages,tools:options.tools,system:options.system});
   sources.set(key(options.sessionId),{model:options.model?.id||options.model,provider:options.provider?.id||options.provider});
   engine.change(l=>{(l.costs.preflights??=[]).push({at:Date.now(),sessionId:options.sessionId,roundId:l.round?.id,requestTokens:tokens,scope:'host-final-request-messages-tools-system-estimate',allowed:tokens<=engine.cfg.requestAdmissionEstimatedTokenLimit});});
   if(tokens>engine.cfg.requestAdmissionEstimatedTokenLimit)throw Error('鱼世界完整请求估算超过启动目标；保留本轮未知状态并停止追加请求');
   yield*next();
  })();
 }));
 let reconciledEngine=null;
 api.every?.(10000,()=>{const engine=getEngine();if(!engine||engine===reconciledEngine)return;reconciledEngine=engine;
  void (async()=>{
   const query=api.dsh.get('sessionQuery');if(!query?.readSession)return;
   const ids=[...new Set([engine.l.sessionId,...(engine.l.contextWindow?.windows||[]).map(w=>w.sessionId)].filter(Boolean))],batches=[];
   for(const sessionId of ids){const result=await query.readSession(sessionId);if(!result||!Array.isArray(result.events))throw Error('旧世界窗口缺少原始事件');
    batches.push({sessionId,events:result.events.filter(e=>e.seq>=(result.inheritedEventCount||0))});
   }
   if(engine.closed)return;engine.change(l=>{
    for(const batch of batches)for(const event of batch.events){
     if(!['assistant/message','assistant/attempt'].includes(event.type))continue;
     observeCost(l,batch.sessionId,event,{costOf:price,now:Date.now()});
    }
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
    l.costs.historyReconciledDays=[...new Set([...(l.costs.historyReconciledDays||[]),day])];
    l.costs.historyReconciliation={at:Date.now(),ownedWindows:ids.length,source:'official-sessionQuery-readSession',missing:0};
   });
  })().catch(()=>{reconciledEngine=null;});
 },'世界自有窗口用量只读补账');
 return ()=>{for(const off of offs.reverse())off?.();};
}
export async function prepareRequest(engine,api,{scope,findAgent,identity,restoreWorldScope},prompt,round){
 const old=findAgent(engine.l.sessionId);
 if(old){
  if(typeof restoreWorldScope!=='function')throw Error('世界启动预检缺少已归属会话的工具作用域恢复');
  const restored=restoreWorldScope(old);
  if(!Array.isArray(restored)||typeof restored.then==='function')throw Error('世界工具作用域必须同步恢复并返回真实工具名');
 }
 const messages=old?.session?.deriveMessages?.()||[];
 const visible=messages.flatMap(m=>m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'),visibleTokens=estimateTokens(messages);
 let measured;try{measured=api.dsh.get('tokenMeter')?.measure?.(old?.session);}catch{}
 const schemas=old?api.dsh.get('tools')?.schemas?.(old)||[]:[],toolsTokens=estimateTokens(schemas),wrapperReserve=16000;
 const projectedRequest=estimateTokens(prompt)+visibleTokens+toolsTokens+wrapperReserve;
 const recoveryStopped=round.readOnly&&await engine.host.idle(engine.l.sessionId);
 const {chooseWindow,windowPrompt}=await import('./world-window.mjs');
 const windowKey=chooseWindow(engine,scope(),{enabled:engine.cfg.backgroundContextEnabled===true,rounds:engine.cfg.backgroundContextRounds,
   force:visibleTokens>=engine.cfg.visibleContextEstimatedTokenLimit||projectedRequest>engine.cfg.requestAdmissionEstimatedTokenLimit||!!round.readOnly,recoveryStopped});
 const current=engine.l.contextWindow?.windows.findLast(w=>w.key===windowKey);
 const same=!!current?.sessionId&&key(current.sessionId)===key(old?.session?.id);
 const rendered=windowPrompt(engine,prompt,{identity:identity(),visible:same?visible:'',round,file:api.dataDir('context-handoffs',windowKey.replaceAll(':','-')+'.json')});
 const roundTokens=estimateTokens(rendered),history=same?visibleTokens:0;
 return {prompt:rendered,windowKey,estimate:{roundPromptTokens:roundTokens,visibleContextTokens:history,toolsTokens,wrapperReserve,
   requestTokens:roundTokens+history+toolsTokens+wrapperReserve,scope:'module-visible-all-blocks-tool-schema-plus-unknown-persona-wrapper-reserve',
   hostMeterAvailable:!!measured,hostMeter:measured?{estimated:measured.estimated,total:measured.total}:null,
   held:history>=engine.cfg.visibleContextEstimatedTokenLimit?'历史已达到换窗门槛，等待安全边界':''}};
}
// Activated only by the host's replacement-module setup; never pauses global configuration.
export function migrationGate(api,bridge,{version,listAgents}){
 const generation=randomUUID(),runtimePath=api.dataDir('runtime.json'),witnessPath=api.dataDir('writer-quiescence.json');
 let lastHash='',stableSince=0,busy=false;
 return {async probe(){
  if(busy)return {ready:false,reason:'正在检查旧写入者'};busy=true;
  try{
   if(fs.existsSync(runtimePath+'.migration.lock'))return {ready:false,reason:'迁移持有独占锁'};
   const raw=fs.readFileSync(runtimePath),data=JSON.parse(raw),hash=sha(raw),now=Date.now();
   if(data.version===3&&data.life?.version===2){
    let applied;try{applied=readAppliedMigrationReceipt({runtimePath});}catch{}
    if(applied?.status==='applied'){bridge.data=data;bridge.migrationRequired=false;return {ready:true};}
    // Interrupted commit stays read-only and receives a fresh witness for receipt recovery.
   }
   if(hash!==lastHash){lastHash=hash;stableSince=now;}
   const l=data.life,owned=listAgents().filter(a=>ownSession(l,a.session?.id));
   for(const a of owned){a.cancel?.({kind:'user'},{keepInbox:false});if(typeof a.whenIdle!=='function')return {ready:false,reason:'旧Agent缺少正式停止确认接口'};await a.whenIdle();}
   const agentsIdle=owned.every(stableAgentIdle);
   const toolsIdle=!l.externalPending&&!l.journal.some(j=>j.status==='executing');
   const outboundIdle=!l.outbox.some(o=>['sending','queued'].includes(o.state));
   const roundIdle=!l.round;
   if(!(agentsIdle&&toolsIdle&&outboundIdle&&roundIdle))return {ready:false,reason:'旧回合、工具或投递仍未确认停止；保留原账本'};
   if(now-stableSince<15000)return {ready:false,reason:'等待旧版采集超时结束与账本稳定'};
   if(sha(fs.readFileSync(runtimePath))!==hash)return {ready:false,reason:'旧账本仍有写入'};
   const witness={protocol:'fish-world-migration-witness/v1',runtimePath,runtimeSha256:hash,capturedAt:now,expiresAt:now+30000,
    oldWriterStopped:true,agentsIdle,toolsIdle,outboundIdle,readOnlyGate:{active:true,version,generation},
    writerProof:{kind:'module-lifecycle-quiescence',oldModuleDetached:true,stableSince,stableThrough:now,runtimeSha256:hash,
     evidence:'host replacement setup follows old module disposer; old runtime has no round/external/executing/outbound; owned agents stable idle; new gate does not collect/write runtime'}};
   fs.writeFileSync(witnessPath+'.tmp',JSON.stringify(witness,null,2));fs.renameSync(witnessPath+'.tmp',witnessPath);
   return {ready:false,witness:witnessPath,reason:'旧写入者已静止，等待显式迁移'};
  }finally{busy=false;}
 }};
}
