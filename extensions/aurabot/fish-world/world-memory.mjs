import {clean,planOpen} from './state.mjs';
import {estimateTokens} from './governance.mjs';

const bounded=value=>typeof value==='string'?clean(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim():'';

// Recall supports the admitted task; a broad topic list is not a task.
export function worldRecallQuery(life,round,{owner,persona}={}){
  if(!life||!round?.id||life.round?.id!==round.id||life.owner!==owner||life.persona!==persona||round.readOnly||round.kind==='recovery')return '';
  const parts=[];
  const add=value=>{const text=bounded(value);if(text&&!parts.includes(text))parts.push(text.slice(0,320));};
  if(round.ownerTaskId){
    const task=(life.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&t.status==='active'&&t.owner===owner&&t.persona===persona);
    if(task){add(task.instruction);add(task.nextStep);}
  }
  const plans=new Set(round.planIds||[]);
  for(const plan of life.plans||[])if(plans.has(plan.id)&&planOpen(plan.status)){add(plan.goal);add(plan.nextStep);}
  const events=new Set([...(round.events||[]),...(round.sourceEventIds||[])]);
  for(const event of life.queue||[])if(events.has(event.id)&&event.kind!=='idle'&&event.kind!=='recovery')add(event.text);
  if(!parts.length&&['owner','owner-task'].includes(round.kind))add(round.reason);
  return parts.join('；').slice(0,600);
}

export function worldMemoryVisible(life,round,agent,{owner,persona}={}){
  if(!life||!round?.id||life.round?.id!==round.id||life.owner!==owner||life.persona!==persona)return '';
  const key=id=>String(id||'').replace(/^session-/,'');
  const current=life.contextWindow?.windows?.findLast(row=>row.key===life.contextWindow.key);
  const expected=life.contextWindow?current?.sessionId:life.sessionId;
  if(!expected||key(expected)!==key(agent?.session?.id))return '';
  return (agent.session.deriveMessages?.()||[]).flatMap(message=>message.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
}

// This slot is input to unchanged request preparation. Only a reserved round
// can replace it with optional memory; window policy is owned elsewhere.
export const WORLD_MEMORY_RESERVED_TOKENS=800;
export const WORLD_MEMORY_AVAILABLE_TOKENS=600;
const memorySlotMark='[[fish-world-memory-reservation:v1]]';
const memorySlot=memorySlotMark+'.'.repeat(WORLD_MEMORY_RESERVED_TOKENS*2-2-memorySlotMark.length);
export const reserveMemoryPrompt=prompt=>prompt+'\n\n'+memorySlot;
export const hasMemoryReservation=prompt=>typeof prompt==='string'&&prompt.split('\n\n').filter(p=>p===memorySlot).length===1&&prompt.split(memorySlotMark).length===2;
export function completeMemoryPrompt(prompt,memory='',visible=''){
 const reserved=hasMemoryReservation(prompt),valid=typeof memory==='string'&&!memory.includes(memorySlotMark),bytes=valid?Buffer.byteLength(memory,'utf8'):0;
 let status=!reserved?'reservation-unavailable':!valid?'invalid':!memory?'empty':bytes>Buffer.byteLength(memorySlot,'utf8')?'over-budget':visible.includes(memory)?'already-visible':'attached';
 const text=status==='attached'?memory:'';
 // Fail closed if a custom prepare dropped, duplicated or changed the slot.
 const rendered=prompt.split('\n\n').map(p=>p===memorySlot?text:p.includes(memorySlotMark)?'':p).filter(Boolean).join('\n\n');
 if(estimateTokens(rendered)>estimateTokens(prompt))throw Error('世界记忆来源替换超过已预留预算');
 return {prompt:rendered,status,reservedTokens:WORLD_MEMORY_RESERVED_TOKENS,usedTokens:estimateTokens(text)};
}
