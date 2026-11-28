import {createHash,randomUUID} from 'node:crypto';
import {worldToolName} from './owner-tasks.mjs';
import {sameSession} from './session-identity.mjs';
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
function latestObservation(engine){
 const round=engine.l.round,receipt=round.receipts.findLast(r=>r.tool===PREFIX+'now'&&!r.isError);
 return receipt&&proof(engine,round,PREFIX+'now',receipt.id)?receipt:null;
}
/** A declared home protocol, not permission to invent arbitrary action IDs. */
export function proveCurrentSpoiledDiscard(engine,args){
 const l=engine?.l,r=l?.round,now=engine?.clock?.(),suffix=/^throw-([A-Za-z][A-Za-z0-9_-]{0,79})$/u.exec(args?.id||'')?.[1];
 if(!r||r.status!=='running'||r.revision!==l.revision||!Number.isFinite(r.startedAt)||!suffix||Object.keys(args).some(key=>!['id','count','request_id'].includes(key))||args.count!==undefined&&(!Number.isSafeInteger(args.count)||args.count<1||args.count>10))return null;
 const who=engine.identity?.();if(l.owner&&l.owner!==who?.owner||l.persona&&l.persona!==who?.persona)return null;
 const receipt=latestObservation(engine),p=receipt&&proof(engine,r,PREFIX+'now',receipt.id),j=p?.journal;
 if(!j||j.isError||!sameSession(j.sessionId,r.sessionId)||j.result!==receipt.text||r.observation!==receipt.text||r.observationId&&r.observationId!==receipt.id||!Number.isFinite(now)||!Number.isFinite(j.at)||!Number.isFinite(j.finishedAt)||j.at<r.startedAt||j.finishedAt<j.at||j.finishedAt>now||now-j.finishedAt>180000)return null;
 const after=l.journal.slice(l.journal.indexOf(j)+1);
 if(after.some(row=>row.tool?.startsWith(PREFIX)&&(['executing','uncertain'].includes(row.status)||row.status==='confirmed'&&isMutation(row.tool,parse(row.args)||{}))))return null;
 const lines=receipt.text.split(/\r?\n/),home=lines.map((line,index)=>/^你在[：:]家(?: · |$)/u.test(line)?index:-1).filter(index=>index>=0);
 if(home.length!==1||home[0]>3)return null;
 const templates=lines.filter(line=>/^你的家(?:（[^（）\r\n]{1,200}）)?\s*· 不要的东西 world_do 填 throw- 加 id 扔掉，count 是扔几件(?: · 摆着的换房间填 put- 加它的 home- 编号，name 填房间)?[。]?$/u.test(line));
 const inventories=lines.filter(line=>/^你的食材（做饭用）：/u.test(line));
 if(templates.length!==1||inventories.length!==1)return null;
 const body=inventories[0].slice('你的食材（做饭用）：'.length),items=[];let stack=[],start=0;
 const closes={'（':'）','(':')','《':'》','「':'」'};
 for(let i=0;i<body.length;i++){
  const c=body[i];if(closes[c])stack.push(closes[c]);else if(Object.values(closes).includes(c)){if(stack.pop()!==c)return null;}
  else if(c==='、'&&!stack.length){items.push(body.slice(start,i).trim());start=i+1;}
 }
 if(stack.length)return null;items.push(body.slice(start).trim());
 const matching=items.map(item=>/^(.+?)\s+([A-Za-z][A-Za-z0-9_-]{0,79})\s+([1-9]\d*)\s+([^\s（）()]{1,8})((?:[（(].*)?)$/u.exec(item)).filter(match=>match?.[2]===suffix);
 if(matching.length!==1)return null;
 const match=matching[0],quantity=Number(match[3]);if(!Number.isSafeInteger(quantity)||args.count!==undefined&&args.count>quantity)return null;
 let tail=match[5],spoiled=false;
 while(tail){
  const first=tail[0],end=closes[first];if(!end)return null;let depth=0,stop=-1;
  for(let i=0;i<tail.length;i++){if(tail[i]===first)depth++;else if(tail[i]===end&&!--depth){stop=i;break;}}
  if(stop<0)return null;if(tail.slice(1,stop)==='坏了')spoiled=true;tail=tail.slice(stop+1).trim();
 }
 return spoiled?{evidence:inventories[0],observationId:receipt.id,templateLine:templates[0]}:null;
}
function homeRoomOptions(text){
 const lines=text.split(/\r?\n/),where=lines.findIndex(line=>/^你在[：:]家(?: · |$)/u.test(line));
 // Location and room options must be protocol headings, never a quotation or a past profile.
 if(where<0||where>3)return [];
 const start=lines.findIndex((line,i)=>i>where&&/^别的房间（world_do .+world_go .+）：$/u.test(line));
 if(start<0)return [];
 const choices=[];
 for(let i=start+1;i<lines.length;i++){
  const line=lines[i];if(!line.trim())continue;
  if(!/^· /u.test(line))break;
  const match=/^· ([^：\r\n]{1,80})：(.+)$/u.exec(line);if(!match)continue;
  const prefixes=[...match[2].matchAll(/(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*-)(?![A-Za-z0-9_-])/gu)].map(m=>m[1]);
  choices.push({room:match[1],line,prefixes});
 }
 return choices;
}
function roomSuggestion(text,target){
 if(typeof target!=='string')return null;
 const choices=homeRoomOptions(text).filter(choice=>choice.prefixes.some(prefix=>target===prefix.slice(0,-1)||target.startsWith(prefix)));
 if(choices.length!==1)return null;
 const {room,line}=choices[0];
 return {nextAction:{tool:'fish_life_action',arguments:{tool:PREFIX+'go',arguments:JSON.stringify({place:room}),category:'daily',cost:0,evidence:line}},then:{tool:PREFIX+'now',arguments:{}}};
}
function evidenceFailure(engine,args,code){
 const latest=latestObservation(engine),suggestion=latest&&roomSuggestion(latest.text,args.id);
 const prefix=typeof args.id==='string'&&/^([A-Za-z][A-Za-z0-9_]*-)/u.exec(args.id)?.[1];
 const optionToken=prefix&&new RegExp('(^|[^A-Za-z0-9_-])'+prefix+'[A-Za-z0-9][A-Za-z0-9_-]*(?![A-Za-z0-9_-])','u');
 const optionLines=latest&&optionToken?[...new Set(latest.text.split(/\r?\n/).filter(line=>line.length<=2000&&!/^\s*>/u.test(line)&&!/^—— /u.test(line)&&optionToken.test(line)))].slice(0,6):[];
 const error=Error(suggestion?'当前现场只列出了动作前缀，尚无完整选项；可按 nextAction 去该房间，再按 then 读取真实选项，随后使用真实完整编号。':'当前最新 world_now 没有唯一的完整可执行选项原行；先取得新的现场选项，再按真实完整编号登记动作。');
 Object.assign(error,{code:suggestion?'need-options':code,retryableAfterObservation:true,evidenceSnapshot:latest?hash(latest.text):null,optionLines,...suggestion});
 return error;
}
function selectEvidence(engine,input,args){
 const receipts=engine.l.round.receipts.filter(r=>!r.isError),evidence=typeof input.evidence==='string'?input.evidence:'';
 if(input.tool!==PREFIX+'do'&&evidence&&receipts.some(r=>r.text.includes(evidence)))return evidence;
 if(input.tool===PREFIX+'go'&&!evidence){
  const latest=latestObservation(engine),rooms=latest?homeRoomOptions(latest.text).filter(room=>room.room===args.place):[];
  if(rooms.length===1)return rooms[0].line;
 }
 const target=input.tool===PREFIX+'do'?args.id:input.tool===PREFIX+'say'?args.fish:null;
 if(typeof target!=='string'||!target.trim()){
  if(input.tool===PREFIX+'do')throw evidenceFailure(engine,args,'need-exact-evidence');
  throw Object.assign(Error('需要当前真实回执的精确 evidence；此动作不能自动定位依据'),{code:'need-exact-evidence',retryableAfterObservation:true,evidenceSnapshot:latestObservation(engine)?hash(latestObservation(engine).text):null});
 }
 if(input.tool===PREFIX+'do'&&target.endsWith('-'))throw evidenceFailure(engine,args,'need-options');
 const escaped=target.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&');
 const exact=new RegExp('(^|[^\\p{L}\\p{N}_#-])'+escaped+'(?![\\p{L}\\p{N}_#-])','u'),lines=new Set();
 const latest=input.tool===PREFIX+'do'?latestObservation(engine):null;
 for(const r of input.tool===PREFIX+'do'?(latest?[latest]:[]):receipts){
  // Reply evidence must be a live observation or a history query for that exact peer.
  if(input.tool===PREFIX+'say'){
   if(![PREFIX+'now',PREFIX+'history'].includes(r.tool))continue;
   if(r.tool===PREFIX+'history'){
    const j=engine.l.journal.find(j=>j.id===r.id&&j.status==='confirmed'),query=parse(j?.args||'');
    if(query?.fish!==target)continue;
   }
  }
  for(const line of r.text.split(/\r?\n/))if(line.length<=2000&&!/^\s*>/u.test(line)&&!/^—— /u.test(line)&&exact.test(line))lines.add(line);
 }
 if(input.tool===PREFIX+'do'){
  if(lines.has(evidence))return evidence;
  if(!lines.size){const discard=proveCurrentSpoiledDiscard(engine,args);if(discard)return discard.evidence;}
  if(lines.size!==1)throw evidenceFailure(engine,args,lines.size?'need-exact-evidence':'need-options');
 }else if(lines.size!==1)throw Object.assign(Error('未找到唯一、明确对应本动作的真实原行；请提供当前回执中的精确 evidence'),{code:'need-exact-evidence',retryableAfterObservation:true,evidenceSnapshot:latestObservation(engine)?hash(latestObservation(engine).text):null});
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
 let active=running.get(engine);if(!active)running.set(engine,active=new Map());
 if(active.has(key))return clone(await active.get(key));
 const existing=engine.l.round.actionSequences?.[actionKey],latest=latestObservation(engine);
 let correctedEvidence=false;
 if(existing?.outcome?.retryableAfterObservation===true&&typeof input.evidence==='string'&&input.evidence&&hash(input.evidence)!==existing.outcome.evidenceInputSha256){
  try{correctedEvidence=selectEvidence(engine,input,args)===input.evidence;}catch{}
 }
 const revalidate=existing?.outcome?.retryableAfterObservation===true&&existing.outcome.notSubmitted===true&&
  existing.outcome.status==='blocked'&&['need-options','need-exact-evidence'].includes(existing.outcome.code)&&
  !existing.calls.some(call=>call.tool===input.tool)&&(correctedEvidence||latest&&hash(latest.text)!==existing.outcome.evidenceSnapshot);
 if(existing?.outcome&&!revalidate)return clone({...existing.outcome,reused:true});
 current(engine,exec,roundId,{reuse:true});
 if(existing&&!revalidate)throw Error('同一动作已有未确认的提交记录，禁止重做');
 current(engine,exec,roundId);
 const job=(async()=>{
  engine.change(l=>{l.round.actionSequences??={};if(revalidate){const row=l.round.actionSequences[actionKey];row.preflightHistory??=[];row.preflightHistory.push({at:row.finishedAt,parent:row.parent,outcome:row.outcome});row.parent=origin;row.status='preparing';delete row.outcome;}else l.round.actionSequences[actionKey]={id:actionKey,source:'program-action-sequence',roundId,parent:origin,tool:input.tool,argumentsSha256:hash(args),category:input.category,cost:input.cost,at:engine.clock(),status:'preparing',calls:[]};});
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
   // Only do needs current executable options before another identity lookup.
   let evidence;if(input.tool===PREFIX+'do')evidence=selectEvidence(engine,input,args);
   if(!identityProof(engine,engine.l.round))await dispatch(PREFIX+'profile',{},'identity');
   if(!identityProof(engine,engine.l.round))throw Error('world_profile 未确认当前本鱼身份');
   current(engine,exec,roundId);
   evidence??=selectEvidence(engine,input,args);
   const requestId=['go','do','say'].some(n=>input.tool===PREFIX+n)?'fa:'+hash([roundId,actionKey]).slice(0,32):null;
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
    message:String(error.message||error).slice(0,1000),notSubmitted:!mutationSubmitted||!!error[NOT_SUBMITTED],automaticReplay:false,
    ...error.retryableAfterObservation?{code:error.code,retryableAfterObservation:true,evidenceSnapshot:error.evidenceSnapshot,evidenceInputSha256:hash(input.evidence||''),optionLines:error.optionLines,...error.nextAction?{nextAction:error.nextAction,then:error.then}:{}}:{}};
   if(record)update((entry,round,l)=>{entry.status=outcome.status;entry.phase='stopped';entry.finishedAt=engine.clock();entry.outcome=outcome;
    if(uncertain){round.status='stopping';round.stopReason='顺序动作结果未确认；停止追加并只读恢复';l.recovery=true;}});
   return clone(outcome);
  }
 })();
 active.set(key,job);
 try{return await job;}finally{active.delete(key);}
}
