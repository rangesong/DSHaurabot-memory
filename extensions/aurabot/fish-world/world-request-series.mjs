const key=value=>typeof value==='string'?value.replace(/^session-/,''):'';
const prefix='system:ext-fish-world:';

/** Start a native request series only at the first step of this owned life round. */
export function installWorldRequestSeries(dsh,{getEngine,identity,scope,chatOfSession}){
 if(typeof dsh?.on!=='function'||![getEngine,identity,scope,chatOfSession].every(fn=>typeof fn==='function'))throw Error('世界请求边界接口不可用');
 const current=proposal=>{
  try{
   const agent=proposal?.agent,sessionId=agent?.session?.id;
   if(proposal?.step!==1||!Number.isSafeInteger(proposal.turn)||proposal.turn<1||typeof sessionId!=='string'||!key(sessionId)||!proposal.signal||proposal.signal.aborted||typeof proposal.signal.throwIfAborted!=='function')return null;
   const engine=getEngine(),life=engine?.l,round=life?.round,window=life?.contextWindow,who=identity(),base=scope();
   if(!engine||engine.closed||engine.bridge?.fatal||!engine.authorized()||!who?.owner||!who.persona||life.owner!==who.owner||life.persona!==who.persona||!base||!window||window.base!==base)return null;
   if(!round||typeof round.id!=='string'||!round.id||round.status!=='running'||round.revision!==life.revision||key(round.sessionId)!==key(sessionId)||engine.cfg.stopped||!engine.cfg.autonomy||engine.cfg.observeOnly)return null;
   if(!window.windows?.some(row=>row.key===window.key&&key(row.sessionId)===key(sessionId))||chatOfSession(sessionId)!==prefix+window.key)return null;
   return {engine,roundId:round.id,owner:who.owner,persona:who.persona,windowKey:window.key,sessionId};
  }catch{return null;}
 };
 // AgentLoop's real agentEvents waterfall fuses agent into this payload.
 return dsh.on('agent/pre-step',async(proposal,next)=>{
  const before=current(proposal),decision=await next();
  if(!before||decision?.kind!=='enter')return decision;
  const after=current(proposal);
  if(!after||Object.keys(before).some(name=>before[name]!==after[name]))return decision;
  return {...decision,startsRequestSeries:true};
 });
}
