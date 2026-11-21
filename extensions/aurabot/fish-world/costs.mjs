import {dayKey,timestamp} from './state.mjs';
const state=l=>l.costs??={records:[],seen:{},rounds:[],hostTurns:{},preflights:[],baselines:{}};
export function beginCostRound(l,round){
  const c=state(l);if(c.rounds.some(r=>r.roundId===round.id))return;
  c.rounds.push({roundId:round.id,windowId:round.windowId||null,triggerKind:round.kind,budgetBucket:round.bucket,
    sourceEventIds:round.sourceEventIds||[],planId:round.planId||null,reason:round.reason,at:round.startedAt,status:'pending'});
}
export function bindCostTurn(l,sessionId,event){
  if(event.type!=='turn/start'||!Number.isSafeInteger(event.data?.turn))return;
  const r=l.round;if(!r||r.sessionId&&r.sessionId!==sessionId)return;
  const c=state(l);c.hostTurns??={};const key=sessionId+':'+event.data.turn;
  c.hostTurns[key]??={roundId:r.id,windowId:r.windowId||l.contextWindow?.key||null,at:timestamp(event.time)||r.startedAt};
  r.hostTurn=event.data.turn;r.sessionId=sessionId;
  const header=c.rounds.find(x=>x.roundId===r.id);if(header){header.sessionId=sessionId;header.hostTurn=event.data.turn;header.windowId=c.hostTurns[key].windowId;header.status='submitted';}
  for(const record of c.records)if(record.sessionId===sessionId&&record.turn===event.data.turn&&!record.roundId)Object.assign(record,c.hostTurns[key]);
}
export function usageOf(event){
  return event.data?.usage??[...(event.data?.stream||[])].reverse().find(r=>r.type==='chunk'&&r.chunk?.type==='usage')?.chunk.usage??null;
}
export function observeCost(l,sessionId,event,{costOf,model='',provider='',now=Date.now()}={}){
  if(!['assistant/message','assistant/attempt'].includes(event.type)||!Number.isSafeInteger(event.seq))return null;
  if(event.type==='assistant/message'&&event.surfaceOp!=='append')return null;
  if(event.type==='assistant/attempt'&&event.surfaceOp&&event.surfaceOp!=='append')return null;
  const c=state(l);c.seen??={};c.hostTurns??={};const key=sessionId+':'+event.seq,usage=usageOf(event);
  const prior=c.records.find(r=>r.key===key);
  if(prior&&prior.status!=='pending'&&!(prior.status==='unknown'&&prior.reason==='usage-missing'))return prior;
  const source=event.data?.message?.source||{},turn=event.data?.turn,map=c.hostTurns[sessionId+':'+turn];
  const record={key,sessionId,eventSeq:event.seq,turn,step:event.data?.step??null,kind:event.type,
    at:timestamp(event.time)||now,roundId:map?.roundId||null,windowId:map?.windowId||null,
    model:source.model||model,provider:source.provider||provider,status:'pending',reason:'usage-pending',
    freshInput:null,cachedInput:null,cacheWrite:null,output:null,estimatedCny:null};
  if(usage){
    const read=(key,fallback=0)=>Number.isFinite(Number(usage[key]))&&Number(usage[key])>=0?Number(usage[key]):fallback;
    record.freshInput=read('inputTokens');record.cachedInput=read('cacheReadTokens');record.cacheWrite=read('cacheWriteTokens');record.output=read('outputTokens');
    let price;try{price=costOf?.({model:record.model,in:record.freshInput,out:record.output,cached:record.cachedInput,at:record.at});}catch{}
    const complete=['inputTokens','outputTokens'].every(k=>usage[k]!==undefined&&Number.isFinite(Number(usage[k]))&&Number(usage[k])>=0);
    if(complete&&price&&!price.unpriced&&Number.isFinite(price.cost)&&price.cost>=0&&!record.cacheWrite){
      record.status='priced';record.reason='host-configured-cny-estimate';record.estimatedCny=price.cost;record.peak=!!price.peak;
    }else{record.status='unknown';record.reason=!complete?'usage-incomplete':record.cacheWrite?'cache-write-pricing-not-covered':'unpriced-or-unavailable';}
  }
  if(prior)Object.assign(prior,record);else{c.records.push(record);c.seen[key]=true;}
  return prior||record;
}
export function settleMissingUsage(l,now){
  for(const r of state(l).records)if(r.status==='pending'&&now-r.at>=30000){r.status='unknown';r.reason='usage-missing';}
}
export function endCostRound(l,round,valid){
  const c=state(l),header=c.rounds.find(r=>r.roundId===round.id);if(!header)return;
  header.status=valid?'completed':'uncertain';header.finishedAt=round.finishedAt||Date.now();
  const records=c.records.filter(r=>r.roundId===round.id);
  header.usageStatus=records.length?records.some(r=>r.status!=='priced')?'incomplete':'reported':'unknown';
}
export function costSummary(l,now=Date.now()){
  const c=state(l),day=dayKey(now),baseline=c.baselines?.[day];
  const rows=c.records.filter(r=>dayKey(r.at)===day),headers=c.rounds.filter(r=>dayKey(r.at)===day);
  const result={day,currency:'CNY',estimatedCny:baseline?.estimatedCny??0,baselineStatus:baseline?.status||'not-imported',
    baselineRequests:baseline?.modelRequests??null,modelRequests:rows.length,pendingRequests:0,unknownRequests:0,unknownRounds:0,
    freshInput:baseline?.freshInput||0,cachedInput:baseline?.cachedInput||0,output:baseline?.output||0,
    inFlightRounds:headers.filter(r=>['pending','submitted'].includes(r.status)).length,pricedRequests:0,
    estimatedPricingOnly:true,stepHardBudget:false};
  for(const r of rows){if(r.status==='priced'){result.pricedRequests++;result.estimatedCny+=r.estimatedCny;}
    else if(r.status==='pending')result.pendingRequests++;else result.unknownRequests++;
    if(r.freshInput!==null)result.freshInput+=r.freshInput;if(r.cachedInput!==null)result.cachedInput+=r.cachedInput;if(r.output!==null)result.output+=r.output;
  }
  result.unknownRounds=headers.filter(h=>!['pending','submitted','not_submitted'].includes(h.status)&&!rows.some(r=>r.roundId===h.roundId)).length;
  result.historicalUnknown=!!c.historicalDay&&c.historicalDay===day&&!baseline&&!c.historyReconciledDays?.includes(day);
  if(result.historicalUnknown)result.unknownRequests++;
  result.complete=!result.pendingRequests&&!result.unknownRequests&&!result.unknownRounds&&!result.inFlightRounds;
  return result;
}
