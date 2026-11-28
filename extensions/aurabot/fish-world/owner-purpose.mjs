import {createHash} from 'node:crypto';
import {registerJourney} from './owner-tasks.mjs';
import {sameSession,sessionKey,ownerTaskContext,setOwnerTaskContext} from './session-identity.mjs';
const GO='mcp__fish-world__world_go',hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day=value=>new Date(value+8*3600000).toISOString().slice(0,10);
const prefix='(?:(?:你|请|麻烦|记得|别忘|那|帮我|给我|替我|先|今天|现在|上午|下午|早上|中午|临时|待会儿?)[，,\\s]*)*';
const trip=new RegExp('^'+prefix+'(?:改去|去|到|回)([^\\r\\n]{1,600})$','u');
const negativeTrip=new RegExp('^'+prefix+'(?:算了[，,\\s]*)?(?:不去|别去|不要去)([^\\r\\n]{0,120})$','u');
const cancelTrip=new RegExp('^'+prefix+'(?:取消|停止)([^\\r\\n]{1,120})$','u');
const stripTail=value=>value.trim().replace(/[。！!，,\s]+$/u,'').replace(/(?:了|吧|呀|啊)$/u,'').trim();
function cancellation(text){
 const negative=negativeTrip.exec(text);if(negative)return {place:stripTail(negative[1])||null};
 const cancel=cancelTrip.exec(text);if(!cancel)return null;
 const body=stripTail(cancel[1]);if(/^(?:(?:刚才|原来|这次)(?:的)?)?(?:出行|行程)$/u.test(body))return {place:null};
 if(!/^(?:去|到|回)/u.test(body)&&!/(?:行程|出行)$/u.test(body))return null;
 const target=body.replace(/^(?:去|到|回)/u,'').replace(/(?:的)?(?:行程|出行)$/u,'');return target?{place:stripTail(target)}:null;
}
const samePlace=(a,b)=>a===b||['吧','呀','啊'].some(tail=>a===b+tail||b===a+tail);
function excursion(text){
 if(typeof text!=='string'||text.length>1000||/[？?\n\r]|(?:吗|怎么样|是不是|为什么|如何|明天|后天|下周|今晚|晚上|\d\s*(?:点|:|：))/.test(text))return null;
 const match=trip.exec(text);if(!match)return null;
 const body=match[1],split=/(?:看看|逛逛|走走|买|购|吃|找|问|拿|送|做|上班|打工|读|借|看书|[，,。；;！!])/.exec(body),place=(split?body.slice(0,split.index):body).trim(),tail=split?body.slice(split.index):'';
 if(!place||place.length>120||/[>“”「」『』"\[\]{}]/.test(place))return null;
 const observe=!tail||/^(?:看看|逛逛|走走)(?:吧|呀|啊)?[。！!]?$/u.test(tail);
 return {place,tail,completionType:observe?'observe':'action'};
}
/** Only a newly appended, native owner/private event may supply a durable purpose. */
export function nativeOwnerPurposeSource(session,event,{identity,chatId,now}){
 const message=event?.data,source=message?.source,sid=session?.id;
 if(!sessionKey(sid)||!identity?.owner||!identity?.persona||chatId!=='private:'+identity.owner||event?.type!=='user/message'||!Number.isFinite(event.time)||event.time>now||now-event.time>180000||message?.role!=='user'||typeof message.id!=='string'||!message.id||message.id.length>200||source?.kind!=='aurabot'||source.speaker?.role!=='owner'||source.speaker?.chat!=='private')return null;
 const blocks=(message.content||[]).filter(c=>c?.type==='text'&&typeof c.text==='string'&&c.text.startsWith('【私聊】['));if(blocks.length!==1)return null;
 const escaped=identity.owner.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),header=new RegExp('^【私聊】\\[(?:[01]\\d|2[0-3]):[0-5]\\d\\] [^\\r\\n]+?\\('+escaped+'\\)：').exec(blocks[0].text);if(!header)return null;
 const text=blocks[0].text.slice(header[0].length).trim();if(!text||text.length>1000)return null;
 return {owner:identity.owner,persona:identity.persona,sessionId:sid,messageId:message.id,seq:event.seq,at:event.time,text};
}
/** This stores candidates only: no round, world action, cancellation or sharing is dispatched. */
export function captureNativeOwnerPurpose(l,source){
 if(!source||source.owner!==l.owner||source.persona!==l.persona)return {changed:false};
 const list=l.ownerPurposeAnchors||[],pending=list.filter(a=>a.status==='pending'&&a.owner===source.owner&&a.persona===source.persona&&sameSession(a.sessionId,source.sessionId));
 if(list.some(a=>a.messageId===source.messageId))return {changed:false};
 const stopped=!/[？?]|吗/.test(source.text)&&cancellation(source.text);
 if(stopped){
  const cancelled=pending.filter(anchor=>!stopped.place||samePlace(anchor.place,stopped.place));if(!cancelled.length)return {changed:false};for(const anchor of cancelled){anchor.status='cancelled';anchor.cancelledBy=source.messageId;anchor.cancelledAt=source.at;}return {changed:true,cancelled:cancelled.length};
 }
 const spec=excursion(source.text);if(!spec)return {changed:false};
 for(const anchor of pending){anchor.status='superseded';anchor.supersededBy=source.messageId;}
 const anchor={...source,...spec,status:'pending',origin:'native-owner-event'};l.ownerPurposeAnchors=[...list,anchor].slice(-8);return {changed:true,anchor};
}
function destination(entry){
 const first=typeof entry.result==='string'?entry.result.split(/\r?\n/,1)[0]:'';
 const immediate=/^好的[，,。]\s*你(?:走进了|走到了|来到了|回到了)([^。！\n]{1,120})[。！]?$/u.exec(first);if(immediate)return immediate[1].trim();
 if(!/^好的[，,。]\s*(?:(?:[01]?\d|2[0-3]):[0-5]\d\s*)?出发[：:]/u.test(first))return null;
 const arrival=/((?:[01]?\d|2[0-3]):[0-5]\d)\s*到([^。；\n]{1,120})(?:[。；\n]|$)/u.exec(first);return arrival?.[2]?.trim()||null;
}
function matchesPlace(anchor,place,label){
 const candidates=[place,label,label.split('·',1)[0].trim()];return candidates.some(value=>value&&(anchor.place===value||['吧','呀','啊','吧。','呀。','啊。'].some(tail=>anchor.place===value+tail)));
}
/** Attach only this freshly confirmed owner action. Metadata failure never denies the original go. */
export function attachConfirmedOwnerPurpose(l,entry,identity,now){
 try{
  if(entry?.tool!==GO||entry.round||entry.status!=='confirmed'||entry.isError||entry.ownerOrigin?.kind!=='owner'||!entry.ownerOrigin.sourceMessageId||!['events','derived'].includes(entry.ownerOrigin.evidence)||!Number.isFinite(entry.at)||!Number.isFinite(entry.finishedAt)||entry.finishedAt<entry.at||entry.finishedAt>now||now-entry.finishedAt>180000||l.owner!==identity?.owner||l.persona!==identity?.persona)return {changed:false};
  const args=JSON.parse(entry.args),label=destination(entry);if(!label||!args||typeof args.place!=='string'||!args.place||args.place.length>160)return {changed:false};
  const anchor=(l.ownerPurposeAnchors||[]).findLast(a=>a.status==='pending'&&a.origin==='native-owner-event'&&a.owner===identity.owner&&a.persona===identity.persona&&sameSession(a.sessionId,entry.sessionId)&&a.at<=entry.at&&day(a.at)===day(entry.at));
  if(!anchor||!matchesPlace(anchor,args.place,label)||(l.journal||[]).findLast(row=>row.tool===GO)?.id!==entry.id)return {changed:false};
  const mutating=row=>[GO,'mcp__fish-world__world_do','mcp__fish-world__world_say','mcp__fish-world__world_update'].includes(row.tool)||row.tool==='mcp__fish-world__world_friends'&&JSON.parse(row.args||'{}').action!=='list';
  const empty=task=>task.status==='active'&&['needs_definition','pending'].includes(task.phase)&&['activity','buy'].includes(task.kind)&&task.owner===identity.owner&&task.persona===identity.persona&&task.instruction===anchor.text&&sameSession(task.currentSessionId||task.source?.sessionId,entry.sessionId)&&Math.abs(task.createdAt-anchor.at)<=180000&&!task.finalAction&&!task.steps?.length&&!task.receipts?.length&&!task.completedSteps?.length&&!(l.journal||[]).some(row=>row.id!==entry.id&&row.ownerTaskId===task.id&&mutating(row));
  const candidates=(l.ownerTasks||[]).filter(empty),owned=entry.ownerTaskId?(l.ownerTasks||[]).find(task=>task.id===entry.ownerTaskId):candidates.length===1?candidates[0]:null;
  if(entry.ownerTaskId&&(!owned||!empty(owned)))return {changed:false};
  const draft=structuredClone(l),copy=draft.journal.find(row=>row.id===entry.id),saved=draft.ownerPurposeAnchors.find(a=>a.messageId===anchor.messageId);if(!copy||!saved)return {changed:false};
  const arrivalStep=anchor.tail?'到达'+label+'后继续原要求：'+anchor.tail:'确认已经到达'+label;
  let task;
  if(owned){
   task=draft.ownerTasks.find(t=>t.id===owned.id);const step={tool:GO,arguments:{place:args.place},nextStep:'前往 '+args.place+'；到达后：'+arrivalStep,waitFor:'arrival'};
   Object.assign(task,{kind:'journey',phase:'pending',focus:{state:'active',activatedAt:now},scheduleRequired:false,nextAt:now,finalAction:structuredClone(step),steps:[step],stepIndex:0,nextStep:step.nextStep,journey:{goal:anchor.text,destination:args.place,arrivalStep,completionType:anchor.completionType,registeredSessionId:entry.sessionId,registeredTurnKey:'native:'+anchor.messageId,stage:'outbound',suggestedSteps:[]}});
   for(const other of draft.ownerTasks)if(other!==task&&other.status==='active'&&other.kind!=='planning'&&other.owner===identity.owner&&other.persona===identity.persona&&sameSession(other.currentSessionId||other.source?.sessionId,entry.sessionId)&&other.focus?.state!=='paused'){other.focus={state:'paused',pausedAt:now,pausedBy:task.id};other.history.push({at:now,kind:'purpose-paused',pausedBy:task.id,noWorldMutation:true,localOnly:true});other.revision++;}
  }else{
   const result=registerJourney(draft,{goal:anchor.text,destination:args.place,arrivalStep,completionType:anchor.completionType},{sessionId:entry.sessionId,identity,now,sourceKind:'native-owner-purpose'});task=draft.ownerTasks.find(t=>t.id===result.task.id);
  }
  task.originalPurpose=anchor.text;task.purposeSource='owner-native-event';task.createdAt=Math.min(task.createdAt,anchor.at);task.source={...task.source,nativeOwnerEvent:{messageId:anchor.messageId,seq:anchor.seq,at:anchor.at,sessionId:anchor.sessionId}};
  const {request_id:ignored,...business}=args;task.steps[0].arguments=structuredClone(business);task.finalAction=structuredClone(task.steps[0]);
  task.journey.priorActions=[{id:entry.id,tool:entry.tool,arguments:structuredClone(args),at:entry.at,finishedAt:entry.finishedAt,historyRef:{kind:'journal',id:entry.id},localOnly:true,historyOnly:true}];
  if(anchor.completionType==='observe')task.ownerCompletionType='observe';
  task.journey.nativePurposeLink={messageId:anchor.messageId,callId:entry.id,linkedAt:now,noWorldMutation:true};task.history.push({at:now,kind:'native-purpose-linked',sourceMessageId:anchor.messageId,callId:entry.id,noWorldMutation:true,localOnly:true});task.revision++;task.updatedAt=now;
  copy.ownerTaskId=task.id;saved.status='bound';saved.taskId=task.id;saved.boundCallId=entry.id;saved.boundAt=now;
  const context=ownerTaskContext(draft,entry.sessionId);if(context)setOwnerTaskContext(draft,entry.sessionId,{...context,taskId:task.id});
  Object.assign(l,draft);return {changed:true,taskId:task.id};
 }catch{return {changed:false};}
}
