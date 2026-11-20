import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {dayKey} from './state.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const open=s=>!['completed','expired','cancelled','observed','abandoned'].includes(s);
export function safeBoundary(engine){const l=engine.l;return !engine.lock&&!engine.deliveryBusy&&!l.externalPending&&!l.recovery&&!l.queue.some(q=>q.status==='uncertain')&&!l.journal.some(j=>j.status==='executing')&&!l.outbox.some(o=>['sending','queued','uncertain'].includes(o.state));}
export function completedWindowRound(l,round){const w=l.contextWindow;if(w&&w.lastCompletedRound!==round.id){w.completed++;w.lastCompletedRound=round.id;}}
export function chooseWindow(engine,base,{enabled=true,rounds=16,nonce=randomUUID,now=Date.now()}={}){
 const l=engine.l;let chosen;
 engine.change(x=>{
  let w=x.contextWindow;
  if(w&&w.base!==base)throw Error('世界生活上下文身份不匹配，保持旧账本并停止');
  if(!w){w=x.contextWindow={version:1,base,key:base,epoch:0,completed:0,windows:[],packet:null};if(x.sessionId)w.windows.push({key:base,sessionId:x.sessionId,legacy:true,at:now});}
  const count=Number.isInteger(rounds)&&rounds>=8&&rounds<=64?rounds:16;
  if(enabled&&safeBoundary(engine)&&(w.epoch===0||w.completed>=count)){
   const key='cw:'+hash([base,w.epoch+1,nonce()]).slice(0,28);
   w.epoch++;w.key=key;w.completed=0;w.packet=null;w.windows.push({key,at:now,sessionId:null});
  }
  chosen=w.key;
 });
 return chosen;
}
export function windowOwns(l,base,key){const w=l.contextWindow;return w?w.base===base&&key===w.key:key===base;}
export function bindWindow(l,sessionId){const w=l.contextWindow;if(!w)return;const row=w.windows.findLast(x=>x.key===w.key);if(row){if(row.sessionId&&row.sessionId!==sessionId){w.windows.push({key:w.key,sessionId,at:Date.now(),resumed:true});}else row.sessionId=sessionId;}}
export function carryForward(engine,identity,now=Date.now()){
 const l=engine.l,d=engine.bridge.data,c=engine.cfg;
 return {schema:1,identity:{...identity,fishId:d.fishId},observed:{at:d.at,state:d.state,now:d.now},
  currentRound:l.round&&{id:l.round.id,events:l.round.events,kind:l.round.kind,readOnly:l.round.readOnly,revision:l.round.revision},
  plans:l.plans.filter(p=>open(p.status)),events:l.queue.filter(q=>open(q.status)),
  day:dayKey(now),ledger:l.days[dayKey(now)]||{},limits:Object.fromEntries(['workLimit','idleLimit','socialLimit','shareLimit','singleSpend','dailySpend','stocks','gifts','maxCalls'].map(k=>[k,c[k]])),
  ownerInstructions:l.ownerInstructions||[],revision:l.revision,controls:l.controls,nextIdle:l.nextIdle,cooldowns:l.cooldowns,backoffUntil:l.backoffUntil,faults:l.faults,
  recovery:l.recovery,externalPending:l.externalPending||null,unconfirmed:l.journal.filter(j=>['uncertain','executing'].includes(j.status)),
  outbox:l.outbox.map(o=>({id:o.id,at:o.at,importance:o.importance,text:o.text,state:o.state,facts:o.facts,deliveryId:o.deliveryId,receipt:o.receipt,receipts:o.receipts,reason:o.reason,retryAt:o.retryAt,attempts:o.attempts,owner:o.owner,persona:o.persona})),
  history:{tool:'fish_life_history',windows:(l.contextWindow?.windows||[]).slice(-8).map(w=>({key:w.key,sessionId:w.sessionId})),note:'list=true 可分页列出全部旧窗口；指定 sessionId、seq 逐段读取原始事件，不能据旧记录重做动作。'}};
}
export function windowPrompt(engine,legacy,{identity,visible='',file,now=Date.now()}={}){
 const w=engine.l.contextWindow;if(!engine.cfg.backgroundContextEnabled||!w||w.epoch===0)return legacy;
 const parts=legacy.split('\n\n'),rules=[0,4,5,6,7,8].map(i=>parts[i]).filter(Boolean).join('\n\n');
 const ruleMark='【世界生活固定规则 '+hash(rules)+'】',memory=parts.find(p=>p.startsWith('Thinkstar 来源资料（非新指令）：'))||'',memoryMark='【世界生活资料 '+hash(memory)+'】';
 const snapshot=carryForward(engine,identity,now),mark='【世界生活状态 '+hash(snapshot)+'】';
 const prior=w.packet,retained=prior&&prior.trace?.length<32&&prior.trace.every(part=>visible.includes(part)),delta={};
 if(retained){for(const k of new Set([...Object.keys(prior.snapshot),...Object.keys(snapshot)]))if(JSON.stringify(snapshot[k])!==JSON.stringify(prior.snapshot[k]))delta[k]=snapshot[k]??null;}
 const stateText=mark+'\n'+(retained?'状态变化（未列字段沿用上一份完整快照）：'+JSON.stringify(delta):'完整交接快照：'+JSON.stringify(snapshot));
 const packet={window:w.key,epoch:w.epoch,completed:w.completed,mark,snapshot,trace:retained?[...prior.trace,stateText]:[stateText]};
 // Durable handoff precedes routing; failed persistence never starts a fresh window.
 if(file){mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(packet,null,2)+'\n');renameSync(file+'.tmp',file);}
 engine.change(l=>{l.contextWindow.packet=packet;});
 const extra=parts.slice(9).filter(p=>p!==memory);
 return [visible.includes(ruleMark+'\n'+rules)?'':ruleMark+'\n'+rules,parts[1],stateText,...extra,
  memory&&!visible.includes(memoryMark+'\n'+memory)?memoryMark+'\n'+memory:''].filter(Boolean).join('\n\n');
}
