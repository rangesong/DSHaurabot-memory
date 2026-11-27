const contextKinds=new Set(['runtime-context','time-context','system-context','memory-context','system-prompt']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const unknown=(reason,evidence='unavailable')=>({kind:'unknown',worldAuthorized:false,reason,evidence});
function currentEvents(session){
 let read,length;
 if(typeof session.eventAt==='function'&&Number.isSafeInteger(session.seq)&&session.seq>=0){length=session.seq;read=index=>session.eventAt(index);}
 else if(typeof session.snapshotEvents==='function'){
  const events=session.snapshotEvents();if(!Array.isArray(events))return {error:'invalid-session-events'};
  length=events.length;read=index=>events[index];
 }else return null;
 const events=[];
 for(let index=length-1;index>=Math.max(0,length-8192);index--){
  const event=read(index);if(!event||typeof event.type!=='string')return {error:'invalid-session-event'};
  if(event.type==='turn/end')return {error:'turn-not-running'};
  events.push(event);
  if(event.type==='turn/start'){
   if(!Number.isSafeInteger(event.data?.turn)||event.data.turn<1)return {error:'invalid-turn-boundary'};
   return {events:events.reverse(),turn:event.data.turn};
  }
 }
 return {error:'missing-current-turn'};
}
function reminders(message){
 const source=message.source;
 let records;
 if(Array.isArray(source.reminders))records=source.reminders;
 else if(typeof source.reminder_prompt==='string')records=[source];
 else {
  const texts=(message.content||[]).filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text);
  if(texts.reduce((sum,text)=>sum+text.length,0)>24000)return null;
  const lines=texts.flatMap(text=>text.split('\n')).filter(line=>/^reminders_json:\s*/.test(line));
  if(lines.length!==1)return null;
  try{records=JSON.parse(lines[0].replace(/^reminders_json:\s*/,''));}catch{return null;}
 }
 if(!Array.isArray(records)||!records.length||records.length>16)return null;
 const selected=[];
 for(const record of records){
  if(!plain(record)||typeof record.schedule_id!=='string'||!record.schedule_id||record.schedule_id.length>200||typeof record.occurrence_at!=='string'||record.occurrence_at.length>80||!Number.isFinite(Date.parse(record.occurrence_at))||typeof record.reminder_prompt!=='string'||!record.reminder_prompt.trim()||record.reminder_prompt.length>8000)return null;
  selected.push({schedule_id:record.schedule_id,occurrence_at:record.occurrence_at,reminder_prompt:record.reminder_prompt});
 }
 return selected;
}
/** A trusted schedule may authorize only an explicit physical-world action
 * clause. Merely browsing an article about the world does not grant mutation.
 */
export function allowsExplicitWorldSchedule(source){
 if(!plain(source)||source.kind!=='schedule'||!Array.isArray(source.reminders)||!source.reminders.length||source.reminders.length>16)return false;
 const information=/(?:贴吧|攻略|教程|历史资料|新闻|浏览|研究|学习|查询|查阅|搜索|阅读|回顾|复述|引用)/;
 const negative=/(?:不要|不必|不得|禁止|不用|不许|不准|无需|不能|暂不|先不)(?!忘)|别(?!忘)/;
 return source.reminders.every(reminder=>{
  if(!plain(reminder)||typeof reminder.reminder_prompt!=='string'||!reminder.reminder_prompt.trim()||reminder.reminder_prompt.length>8000)return false;
  return reminder.reminder_prompt.split(/[。；;！!？?\r\n]+/).some(clause=>{
   if(information.test(clause)||/^(?:如果|假如|例如|比如)/.test(clause.trim()))return false;
   const scope=/(?:在|去|到)鱼(?:的)?世界/.exec(clause);if(!scope)return false;
   const offset=scope.index+scope[0].length,action=/(?:采购|打工|上班|煮饭|做饭|回家|看排片|实地|逛|买)/.exec(clause.slice(offset,offset+50));
   return !!action&&!negative.test(clause.slice(0,offset+action.index));
  });
 });
}
function classify(message,{allowWorldSchedule},basis){
 const source=message?.source;
 if(!plain(source))return {...unknown('missing-user-source',basis.evidence),...basis};
 if(source.kind==='aurabot'&&source.speaker?.role==='owner'&&source.speaker?.chat==='private')return {kind:'owner',worldAuthorized:true,reason:'current-private-owner-source',...basis};
 if(source.kind!=='schedule')return {...unknown('non-owner-user-source',basis.evidence),...basis};
 const records=reminders(message);let allowed=false;
 if(records&&typeof allowWorldSchedule==='function'){
  try{allowed=allowWorldSchedule({kind:'schedule',messageId:message.id||'',reminders:structuredClone(records)})===true;}catch{}
 }
 return {kind:'schedule',worldAuthorized:allowed,reason:allowed?'explicit-world-schedule':'schedule-without-world-authorization',...basis};
}
/** Read origin from the current turn, never from quoted headers or old owner text.
 * Owned fish background sessions keep their existing guard and bypass this private
 * route helper. No event, inbox, surface, model or configuration is changed here.
 */
export function worldTurnContext(exec,{ownerChatId,chatOfSession,allowWorldSchedule}={}){
 const session=exec?.agent?.session;
 if(!session||typeof session.id!=='string'||!session.id||typeof ownerChatId!=='string'||!/^private:.+/.test(ownerChatId)||typeof chatOfSession!=='function')return unknown('private-route-unavailable');
 if(exec.signal?.aborted)return unknown('execution-aborted');
 try{if(chatOfSession(session.id)!==ownerChatId)return unknown('not-current-owner-private-route');}catch{return unknown('private-route-unavailable');}
 try{
  const current=currentEvents(session);
  if(current){
   if(current.error)return unknown(current.error,'events');
   const exact=current.events.findIndex(event=>event.type==='tool/call'&&event.data?.callId===exec.callId&&(!exec.name||event.data.name===exec.name));
   // Native nested tools.execute deliberately has no batch log. Its caller is
   // still inside this open turn; use that turn's latest committed user source.
   const end=exact>=0?exact:current.events.length;
   for(let index=end-1;index>=0;index--){
    const event=current.events[index];if(event.type!=='user/message')continue;
    const message=event.data;
    if(contextKinds.has(message?.source?.kind))continue;
    return classify(message,{allowWorldSchedule},{evidence:'events',turn:current.turn,sourceSeq:event.seq,sourceMessageId:message?.id||'',callRecorded:exact>=0});
   }
   return unknown('no-user-source-in-current-turn','events');
  }
  // Lightweight hosts/tests may expose only the actual retained messages.
  // Unknown sources are never skipped in favor of an earlier owner message.
  if(typeof session.deriveMessages!=='function')return unknown('source-api-unavailable');
  const messages=session.deriveMessages();if(!Array.isArray(messages))return unknown('invalid-derived-messages','derived');
  for(let index=messages.length-1;index>=Math.max(0,messages.length-8192);index--){
   const message=messages[index];if(message?.role!=='user'||contextKinds.has(message.source?.kind))continue;
   return classify(message,{allowWorldSchedule},{evidence:'derived',turn:null,sourceMessageId:message.id||'',callRecorded:false});
  }
  return unknown('no-retained-user-source','derived');
 }catch{return unknown('source-read-failed');}
}
