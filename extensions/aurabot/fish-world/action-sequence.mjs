import {createHash,randomUUID} from 'node:crypto';
import {worldToolName} from './owner-tasks.mjs';
const PREFIX='mcp__fish-world__world_';
const origins=new WeakMap(),running=new WeakMap(),guardRejections=new WeakMap(),NOT_SUBMITTED=Symbol('local-guard-not-submitted');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const textOf=result=>(result?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const isMutation=(tool,args)=>['go','do','say','update'].some(n=>tool===PREFIX+n)||tool===PREFIX+'friends'&&args.action!=='list';
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};

/** Capture only the real native parent invocation's origin, never reconstruct a fake log step. */
export function noteActionSessionEvent(engine,session,event){
 const r=engine?.l?.round,d=event?.data;
 if(!r||event.type!=='tool/call'||d?.name!=='fish_life_action'||session?.id!==r.sessionId)return;
 if(!Number.isSafeInteger(event.seq)||!Number.isSafeInteger(d.turn)||!Number.isSafeInteger(d.step)||!d.callId)return;
 let map=origins.get(engine);if(!map)origins.set(engine,map=new Map());
 // Entries for ended rounds are not needed; durable origins live in the sequence record.
 for(const [id,origin]of map)if(origin.roundId!==r.id)map.delete(id);
 map.set(d.callId,{source:'official-session/event-tool/call',sessionId:session.id,roundId:r.id,callId:d.callId,seq:event.seq,turn:d.turn,step:d.step});
}

/** Called only by the actual installed engine.guard wrapper after it returned a denial. */
export function noteActionGuardRejected(engine,exec,reason){
 const r=engine?.l?.round;
 if(!r||typeof reason!=='string'||!reason||exec?.agent?.session?.id!==r.sessionId)return;
 const call=Object.values(r.actionSequences||{}).flatMap(row=>row.calls||[]).find(call=>call.id===exec.callId&&call.tool===exec.name);
 if(!call||engine.l.journal.some(j=>j.id===exec.callId))return;
 let map=guardRejections.get(engine);if(!map)guardRejections.set(engine,map=new Map());
 for(const [id,row]of map)if(row.roundId!==r.id)map.delete(id);
 map.set(exec.callId,{source:'local-engine.guard-rejection',roundId:r.id,callId:exec.callId,tool:exec.name,sessionId:r.sessionId,reasonSha256:hash(reason),at:engine.clock()});
}

/** Direct native dispatch only. PTC transports retain the explicit guarded manual sequence. */
export function canSequenceAction(agent,tools,toolSet){
 try{
  if(!agent||typeof tools?.execute!=='function'||typeof tools.selectExecutor!=='function'||typeof tools.definitions!=='function')return false;
  const executor=tools.selectExecutor(agent),described=executor.describe(tools.definitions(agent,toolSet));
  const names=new Set((described?.schemas||[]).map(s=>s.name));
  return names.has(PREFIX+'now')&&names.has(PREFIX+'profile')&&names.has(PREFIX+'say');
 }catch{return false;}
}
function current(engine,exec,roundId,{reuse=false}={}){
 const r=engine.l?.round,c=engine.cfg,l=engine.l,now=engine.clock();
 if(!r||r.id!==roundId||r.sessionId!==exec.agent?.session?.id||r.status!=='running'||r.revision!==l.revision)throw Error('动作所属后台回合已停止或安排已改变');
 if(engine.closed||engine.bridge?.fatal||!engine.authorized()||c.stopped||!c.autonomy||c.observeOnly)throw Error('世界自动动作已暂停');
 if(r.readOnly||l.recovery)throw Error('恢复核对只读，禁止自动变更');
 if(exec.signal?.aborted)throw Error('本次动作已取消');
 if(!exec.signal||typeof exec.signal.throwIfAborted!=='function')throw Error('宿主未提供正式取消信号');
 if(!reuse&&(engine.lock||l.externalPending))throw Error('已有世界工具尚未结束');
 if(!reuse&&(r.calls>=c.maxCalls||now-r.startedAt>=c.turnMs))throw Error('达到本轮调用或时间上限');
 const identity=engine.identity();
 if(l.owner&&l.owner!==identity.owner||l.persona&&l.persona!==identity.persona)throw Error('世界动作身份已改变');
 return r;
}
function proof(engine,round,tool,id){
 const receipt=round.receipts.find(x=>x.tool===tool&&(!id||x.id===id)&&!x.isError);
 if(!receipt)return null;
 const journal=engine.l.journal.find(x=>x.id===receipt.id&&x.round===round.id&&x.tool===tool&&x.status==='confirmed');
 return journal?{receipt,journal}:null;
}
export function isExactFishIdentity(text,fishId){
 return typeof text==='string'&&!!fishId&&text.split(/\r?\n/).some(line=>line.replace(/\s/g,'')===String(fishId).replace(/\s/g,''));
}
function identityProof(engine,round){
 if(!round.identityConfirmed)return null;
 for(const receipt of round.receipts.filter(x=>x.tool===PREFIX+'profile'&&!x.isError)){
  const p=proof(engine,round,PREFIX+'profile',receipt.id),args=parse(p?.journal.args||'');
  if(p&&args&&!args.fish&&isExactFishIdentity(receipt.text,engine.bridge.data.fishId))return p;
 }
 return null;
}
function selectEvidence(engine,input,args){
 const receipts=engine.l.round.receipts.filter(r=>!r.isError),evidence=typeof input.evidence==='string'?input.evidence:'';
 if(evidence&&receipts.some(r=>r.text.includes(evidence)))return evidence;
 const target=input.tool===PREFIX+'do'?args.id:input.tool===PREFIX+'say'?args.fish:null;
 if(typeof target!=='string'||!target.trim())throw Error('需要当前真实回执的精确 evidence；此动作不能自动定位依据');
 const escaped=target.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&');
 const exact=new RegExp('(^|[^\\p{L}\\p{N}_#-])'+escaped+'(?![\\p{L}\\p{N}_#-])','u'),lines=new Set();
 for(const r of receipts){
  // Reply evidence must be a live observation or a history query for that exact peer.
  if(input.tool===PREFIX+'say'){
   if(![PREFIX+'now',PREFIX+'history'].includes(r.tool))continue;
   if(r.tool===PREFIX+'history'){
    const j=engine.l.journal.find(j=>j.id===r.id&&j.status==='confirmed'),query=parse(j?.args||'');
    if(query?.fish!==target)continue;
   }
  }
  for(const line of r.text.split(/\r?\n/))if(line.length<=2000&&exact.test(line))lines.add(line);
 }
 if(lines.size!==1)throw Error('未找到唯一、明确对应本动作的真实原行；请提供当前回执中的精确 evidence');
 return [...lines][0];
}
const clone=value=>structuredClone(value);
/**
 * World subcalls use the official registry, guards and result observers. They deliberately
 * omit BatchSettlement.log: nested native results must not create orphan surface messages.
 * Raw arguments/results and origin mappings remain in the module's real durable journal.
 */
export async function executeSequencedAction({engine,tools,exec},input){
 input={...input,tool:worldToolName(input?.tool)};
 const r=engine?.l?.round;
 if(!r)throw Error('没有当前后台回合');
 const roundId=r.id;
 if(r.sessionId!==exec.agent?.session?.id)throw Error('动作不属于当前后台会话');
 if(!canSequenceAction(exec.agent,tools,exec.toolSet))throw Error('当前工具执行器不支持原生顺序动作，请使用显式四步路径');
 const origin=origins.get(engine)?.get(exec.callId);
 if(!origin||origin.roundId!==roundId)throw Error('缺少本次原生动作的正式来源事件，禁止无来源分发');
 const supplied=parse(input?.arguments);
 if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||!isMutation(input.tool,supplied))throw Error('顺序动作只接受完整世界变更参数');
 const {request_id:ignored,...args}=supplied;
 // The same business action is identical even if a model invents a new request_id, quote or budget label.
 const actionKey='action-'+hash([input.tool,args]),key=roundId+':'+actionKey;
 const existing=engine.l.round.actionSequences?.[actionKey];
 if(existing?.outcome)return clone({...existing.outcome,reused:true});
 current(engine,exec,roundId,{reuse:true});
 let active=running.get(engine);if(!active)running.set(engine,active=new Map());
 if(active.has(key))return clone(await active.get(key));
 if(existing)throw Error('同一动作已有未确认的提交记录，禁止重做');
 current(engine,exec,roundId);
 const job=(async()=>{
  engine.change(l=>{l.round.actionSequences??={};l.round.actionSequences[actionKey]={id:actionKey,source:'program-action-sequence',roundId,parent:origin,tool:input.tool,argumentsSha256:hash(args),category:input.category,cost:input.cost,at:engine.clock(),status:'preparing',calls:[]};});
  const row=()=>engine.l.round?.id===roundId?engine.l.round.actionSequences[actionKey]:null;
  const update=fn=>engine.change(l=>{if(l.round?.id!==roundId)throw Error('后台回合已结束');fn(l.round.actionSequences[actionKey],l.round,l);});
  let lastCall=null,mutationSubmitted=false;
  async function dispatch(name,argumentsObject,stage){
   current(engine,exec,roundId);
   const id='fishseq-'+randomUUID();lastCall=id;
   update(record=>{record.phase=stage;record.calls.push({id,tool:name,argumentsSha256:hash(argumentsObject),parentCallId:origin.callId,source:'official-tools.execute',at:engine.clock(),status:'dispatching'});});
   if(stage==='action')mutationSubmitted=true;
   const batch=await tools.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(argumentsObject)}],
    agent:exec.agent,signal:exec.signal,...exec.toolSet===undefined?{}:{toolSet:exec.toolSet},maxParallelToolCalls:1});
   const settled=batch?.results?.find(x=>x.callId===id)?.result;
   const journal=engine.l.journal.find(j=>j.id===id&&j.round===roundId),rejection=guardRejections.get(engine)?.get(id);
   const notSubmitted=settled?.isError===true&&!journal&&rejection?.roundId===roundId&&rejection.callId===id&&rejection.tool===name&&rejection.sessionId===exec.agent.session.id;
   update(record=>{const call=record.calls.find(c=>c.id===id);call.status=notSubmitted?'not-submitted':['confirmed','failed','uncertain'].includes(journal?.status)?journal.status:'uncertain';call.finishedAt=engine.clock();if(notSubmitted)call.guardRejection=clone(rejection);});
   if(notSubmitted){const error=Error('本地世界守卫明确拒绝，动作未提交；保留待办且不重复尝试');error[NOT_SUBMITTED]=true;throw error;}
   if(!settled||!journal||!['confirmed','failed','uncertain'].includes(journal.status))throw Error('缺少正式 tools/result 记账回执，禁止继续');
   if(settled.isError||journal.status!=='confirmed')throw Error(journal.status==='uncertain'?'世界调用结果未确认，禁止重试':textOf(settled)||'世界工具失败');
   const round=engine.l.round;
   if(!round||!proof(engine,round,name,id))throw Error('真实世界成功回执未进入当前回合');
   if(stage!=='action')current(engine,exec,roundId);
   return {id,result:settled};
  }
  try{
   const required=(proof(engine,r,PREFIX+'now')&&r.observation?0:1)+(identityProof(engine,r)?0:1)+1;
   if(r.calls+required>engine.cfg.maxCalls)throw Error('剩余世界调用次数不足以完成前置核对和动作');
   if(!r.observation||!proof(engine,r,PREFIX+'now'))await dispatch(PREFIX+'now',{},'observation');
   if(!engine.l.round.observation)throw Error('world_now 没有取得当前真实观察');
   if(!identityProof(engine,engine.l.round))await dispatch(PREFIX+'profile',{},'identity');
   if(!identityProof(engine,engine.l.round))throw Error('world_profile 未确认当前本鱼身份');
   current(engine,exec,roundId);
   const evidence=selectEvidence(engine,input,args),requestId=['go','do','say'].some(n=>input.tool===PREFIX+n)?'fa:'+hash([roundId,actionKey]).slice(0,32):null;
   const planned={...args,...requestId?{request_id:requestId}:{}};
   const intent=engine.intent({...input,arguments:JSON.stringify(planned),evidence}),approved=clone(intent?.arguments);
   if(!intent?.ok||!approved||typeof approved!=='object'||Array.isArray(approved))throw Error('行动意图尚未核对');
   update(record=>{record.phase='intent-approved';record.requestId=approved.request_id??null;record.approvedArgumentsSha256=hash(approved);});
   current(engine,exec,roundId);
   const action=await dispatch(input.tool,approved,'action');
   const outcome={ok:true,status:'confirmed',tool:input.tool,actionId:actionKey,receiptId:action.id,requestId:approved.request_id??null,
    facts:[action.id],result:action.result,automaticReplay:false};
   update(record=>{record.status='confirmed';record.phase='completed';record.finishedAt=engine.clock();record.outcome=outcome;});
   return clone(outcome);
  }catch(error){
   const record=row(),journal=lastCall&&engine.l.journal.find(j=>j.id===lastCall);
   const uncertain=mutationSubmitted&&!error[NOT_SUBMITTED]&&journal?.status!=='failed'||record?.calls.some(c=>c.status==='dispatching'||c.status==='uncertain');
   const outcome={ok:false,status:uncertain?'uncertain':'blocked',actionId:actionKey,tool:input.tool,receiptId:lastCall,
    message:String(error.message||error).slice(0,1000),notSubmitted:!!error[NOT_SUBMITTED],automaticReplay:false};
   if(record)update((entry,round,l)=>{entry.status=outcome.status;entry.phase='stopped';entry.finishedAt=engine.clock();entry.outcome=outcome;
    if(uncertain){round.status='stopping';round.stopReason='顺序动作结果未确认；停止追加并只读恢复';l.recovery=true;}});
   return clone(outcome);
  }
 })();
 active.set(key,job);
 try{return await job;}finally{active.delete(key);}
}
