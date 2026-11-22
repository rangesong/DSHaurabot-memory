import {createHash} from 'node:crypto';
const WORLD='mcp__fish-world__world_';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const open=t=>t?.status==='active';
const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
const clone=v=>structuredClone(v);
const timestamp=v=>typeof v==='number'?v:Date.parse(v||'')||0;
const matches=(actual,expected)=>Object.entries(expected||{}).every(([k,v])=>JSON.stringify(actual?.[k])===JSON.stringify(v));
export function worldToolName(name){
 const value=String(name||'');return /^(?:mcp__fish-world__)?world_(now|history|find|profile|go|do|say|friends|update|guide)$/.test(value)?value.startsWith('mcp__')?value:'mcp__fish-world__'+value:value;
}
function directive(text){
 const value=String(text||'').trim();
 if(!value||value.length>2000||/[？?]|(?:吗|怎么样|去过|是不是|为什么|如何)/.test(value)||/^(?:他说|她说|你说|引用|例如|比如|假如|如果)/.test(value)||/^(?:(?:你|请|那|今天|先|现在|暂时)[，,\s]*)*(?:不要|别(?!忘)|不用|不必|停止|取消|禁止|先不|暂时不)/.test(value))return null;
 if(!/^(?:(?:请|麻烦|记得|别忘|你|那|帮我|给我|替我|帮忙|带|送|先|等|现在|今天|明天|今晚|待会|吃完|到了|出门|回|去|到|买|找|拿|做|打工|上班))/.test(value)||!/(?:去|回|出门|打工|上班|买|找|带|送|拿|做|看书|读书|吃饭|煮饭)/.test(value))return null;
 const kind=/打(?:个|一份|份|一会儿|一会)?工|上班|短工|兼职|接.{0,3}班/.test(value)?'work':/看书|读书|借书/.test(value)?'read':/买|购买/.test(value)?'buy':/煮饭|做饭|焖饭/.test(value)?'cook':/吃饭|吃完饭/.test(value)?'eat':'activity';
 const finalAction=kind==='work'?{tool:WORLD+'do',arguments:{id:'work'}}:kind==='read'?{tool:WORLD+'do',arguments:{id:'read'}}:kind==='cook'?{tool:WORLD+'do',arguments:{id:'cook'}}:null;
 return {kind,optional:/没事|有空|可以|顺便/.test(value),finalAction:/再|然后|之后|回来|回家|顺便|并且|办完|煮.*吃|做饭.*吃/.test(value)?null:finalAction,scheduled:/明天|后天|下周|今晚|晚上|\d\s*(?:点|:|：)/.test(value)};
}
// Only the host's current owner-prompt hook calls this. Historical chat text is never scanned on load.
export function rememberOwnerTurn(l,identity,{text,sessionId,turnKey,confirmedWorld=false},now){
 if(!sessionId)return null;
 l.ownerTaskContexts??={};const spec=directive(text),previous=l.ownerTaskContexts[sessionId];
 const key=hash([sessionId,turnKey??null,String(text||'')]);
 if(previous?.key===key&&previous.taskId&&open(l.ownerTasks?.find(t=>t.id===previous.taskId)))return null;
 l.ownerTaskContexts[sessionId]={key,taskId:null,at:now};
 if(!/[？?]|吗/.test(text)&&/^(?:(?:你|请|今天|先|现在|那)[\s，,]*)*(?:别|不要|不用|不必|取消|停止).*(?:打(?:个)?工|上班|短工)/.test(text)){
  let cancelled=null;for(const task of l.ownerTasks||[])if(open(task)&&task.kind==='work'&&task.owner===identity.owner&&task.persona===identity.persona){task.status='cancelled';task.phase='cancelled';record(task,{kind:'owner-cancelled',instruction:String(text),sourceKey:key},now);cancelled=task;}return cancelled;
 }
 if(!spec)return null;
 // Unscoped requests such as making a report must not start fish-world model rounds.
 // Their current-turn purpose is activated only if that owner actually invokes a world mutation.
 if(!confirmedWorld&&['activity','buy'].includes(spec.kind)&&!/(?:鱼的?世界|小镇|食堂|图书馆|书店|商店|超市|市集|夜市|摊|修车铺|咖啡店)/.test(text)){
  l.ownerTaskContexts[sessionId].deferred={text:String(text),turnKey};return null;
 }
 l.ownerTasks??=[];
 const existing=l.ownerTasks.findLast(t=>open(t)&&t.instruction===text&&t.owner===identity.owner&&t.persona===identity.persona);
 if(existing){l.ownerTaskContexts[sessionId].taskId=existing.id;existing.currentSessionId=sessionId;
  if(existing.phase==='waiting_evidence'){existing.phase='pending';existing.nextAt=Math.max(existing.notBefore||0,now+180000);record(existing,{kind:'owner-renewed',sourceKey:key},now);return existing;}return null;}
 const id='owner-task-'+hash([identity,sessionId,key,now,l.ownerTasks.length]).slice(0,24);
 const task={id,revision:1,status:'active',phase:spec.scheduled?'needs_definition':'pending',scheduleRequired:spec.scheduled,kind:spec.kind,optional:spec.optional,priority:spec.optional?3:0,instruction:String(text),nextStep:String(text),
  owner:identity.owner,persona:identity.persona,currentSessionId:sessionId,source:{kind:'current-owner-prompt',sessionId,key,at:now},createdAt:now,updatedAt:now,
  nextAt:spec.scheduled?0:now+180000,finalAction:spec.finalAction,steps:spec.finalAction?[{...clone(spec.finalAction),nextStep:String(text),waitFor:spec.kind==='work'?'settlement':'receipt'}]:[],stepIndex:0,completedSteps:[],receipts:[],history:[],checks:0};
 task.finalAction=task.steps.length?clone(task.steps[0]):null;l.ownerTasks.push(task);l.ownerTaskContexts[sessionId].taskId=id;return task;
}
export function taskForExecution(l,exec){
 const r=l.round,background=r?.sessionId===exec.agent?.session?.id;
 const id=background?r.ownerTaskId:l.ownerTaskContexts?.[exec.agent?.session?.id]?.taskId;
 return (l.ownerTasks||[]).find(t=>t.id===id&&['active','completed'].includes(t.status));
}
function record(task,event,now){task.history.push({at:now,...event});task.updatedAt=now;task.revision++;}
export function defineOwnerTask(l,input,{sessionId,background=false,taskId,now}){
 const task=(l.ownerTasks||[]).find(t=>t.id===input.id&&open(t));
 if(!task||(background?task.id!==taskId:l.ownerTaskContexts?.[sessionId]?.taskId!==task.id))throw Error('不是当前主人任务');
 if(input.expectedRevision!==task.revision)throw Error('主人任务版本已变化，请使用当前快照');
 if(task.scheduleRequired&&input.nextAt===undefined)throw Error('原始要求包含未来时间，必须明确保存 nextAt，不能默认为现在');
 if(['travelling','working','waiting_event','uncertain'].includes(task.phase))throw Error('仍有已提交步骤，先等待真实回执，不得替换或重复');
 const submitted=input.steps||[{tool:input.tool,arguments:input.arguments,nextStep:input.nextStep}];
 if(!Array.isArray(submitted)||!submitted.length||submitted.length>8)throw Error('任务需要1到8个明确步骤');
 const steps=submitted.map(s=>{
  const tool=worldToolName(s.tool),supplied=parse(s.arguments);
  if(![WORLD+'go',WORLD+'do',WORLD+'say',WORLD+'friends',WORLD+'update'].includes(tool)||!supplied||typeof supplied!=='object'||Array.isArray(supplied)||!Object.keys(supplied).length||!String(s.nextStep||'').trim())throw Error('每一步需要实际工具、完整 JSON 参数及下一步说明');
  const {request_id:ignored,...args}=supplied;
  if(tool===WORLD+'friends'&&args.action==='list')throw Error('只读查询不能作为任务完成动作');
  const waitFor=tool===WORLD+'go'?'arrival':tool===WORLD+'do'&&args.id==='work'?'settlement':s.waitFor==='done'?'done':'receipt';
  if(waitFor==='done'&&!String(s.eventText||'').trim())throw Error('等待活动完成须提供精确通知原文 eventText');
  return {tool,arguments:args,nextStep:String(s.nextStep).slice(0,1000),waitFor,...waitFor==='done'?{eventText:String(s.eventText)}:{}};
 });
 if(task.kind==='work'&&!task.completedSteps.some(s=>s.action.tool===WORLD+'do'&&s.action.arguments.id==='work')&&!steps.some(s=>s.tool===WORLD+'do'&&s.arguments.id==='work'))throw Error('打工任务必须包含 world_do(id=work)，吃饭或到达不能替代');
 if(input.nextAt!==undefined&&(!Number.isFinite(input.nextAt)||input.nextAt<now))throw Error('nextAt 需要未来的13位毫秒时间');
 if(steps.some(s=>task.completedSteps.some(done=>done.action.tool===s.tool&&matches(s.arguments,done.action.arguments))))throw Error('已完成步骤不能重新登记；只细化尚未完成的后续步骤');
 task.steps=[...task.steps.slice(0,task.stepIndex),...steps];task.finalAction=clone(steps[0]);task.nextStep=steps[0].nextStep;task.nextAt=input.nextAt??Math.max(task.nextAt,now);task.notBefore=input.nextAt??0;
 if(['needs_definition','blocked','waiting_evidence'].includes(task.phase))task.phase='pending';
 record(task,{kind:'defined',finalAction:clone(task.finalAction),nextStep:task.nextStep},now);return {ok:true,task:clone(task)};
}
function finishStep(task,evidence,now){
 task.completedSteps.push({index:task.stepIndex,action:clone(task.steps[task.stepIndex]),at:now,...evidence});task.stepIndex++;
 const next=task.steps[task.stepIndex];task.finalAction=next?clone(next):null;task.nextStep=next?.nextStep||task.nextStep;
 if(next){task.phase='pending';task.nextAt=now;}else{task.status='completed';task.phase='completed';task.completedAt=now;task.nextAt=0;}
}
export function ownerTaskGuard(l,data,exec,background,now){
 const task=taskForExecution(l,exec);if(!task)return;
 const mutation=[WORLD+'go',WORLD+'do',WORLD+'say',WORLD+'update'].includes(exec.name)||exec.name===WORLD+'friends'&&exec.arguments?.action!=='list';
 if(!mutation)return;
 if(task.optional&&(data.state?.doing||(l.ownerTasks||[]).some(t=>t.id!==task.id&&open(t)&&['travelling','working','waiting_event'].includes(t.phase))))return '有空时再做的安排不能打断正在进行的任务；原始要求已保留';
 if(task.status==='completed')return '此主人任务已经有完整成功依据，不得重复执行；等待主人新的要求';
 if(task.phase==='uncertain')return '此主人任务存在未确认变更，只能只读核对，不得重做';
 if(['working','waiting_event'].includes(task.phase)&&exec.name===task.finalAction?.tool&&matches(exec.arguments,task.finalAction.arguments))return '此步骤已提交，等待真实完成通知，不重复执行';
 if(task.completedSteps.some(s=>s.action?.tool===exec.name&&matches(exec.arguments,s.action.arguments))&&!(task.finalAction?.tool===exec.name&&matches(exec.arguments,task.finalAction.arguments)))return '此任务的这个步骤已有成功回执，继续下一步，不要重复';
 if(task.phase==='needs_definition'||task.notBefore&&now<task.notBefore)return '主人任务的未来时间尚未登记或未到；用 fish_life_task 保存准确 nextAt，不能提前行动';
 if(!task.finalAction)return '主人安排尚未登记完整后续步骤；先用 fish_life_task 保存任务 '+task.id+' 的下一步和完成动作';
 if(task.phase==='travelling'&&exec.name===task.finalAction?.tool&&matches(exec.arguments,task.finalAction.arguments))return '仍在路上；主人任务已持久保存，等待真实到达后继续，不要提前执行或反复重试';
 if(background&&task.kind==='work'&&task.phase==='ready'&&task.finalAction?.arguments?.id==='work'&&exec.name===WORLD+'do'&&exec.arguments.id!=='work'&&!/^task-/.test(exec.arguments.id||'')&&!/(?:先吃|吃完.{0,5}再)/.test(task.instruction))return '当前主人任务是到达后上工；临时生活动作不能替代，确需中断请如实报告受阻原因';
}
export function noteOwnerTaskResult(l,data,entry,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===entry.ownerTaskId&&open(t));if(!task)return;
 const args=parse(entry.args)||{};
 if(entry.status==='uncertain'){
  task.phase='uncertain';l.recovery=true;record(task,{kind:'uncertain',callId:entry.id,tool:entry.tool,noReplay:true},now);return;
 }
 if(entry.status!=='confirmed')return;
 const final=task.finalAction,receipt={id:entry.id,tool:entry.tool,at:entry.finishedAt||now};
 if(entry.tool===WORLD+'go'){
  const arrival=/(\d{1,2}:\d{2})\s*到([^。；\n]+?)(?:[。；\n]|$)/.exec(entry.result||'');
  task.travelCompletesStep=final?.tool===entry.tool&&matches(args,final.arguments);task.destination={id:args.place,label:arrival?.[2]?.trim()||null};task.travelCallId=entry.id;task.travelAt=now;task.phase='travelling';task.nextAt=0;
  task.receipts.push(receipt);record(task,{kind:'travel',destination:clone(task.destination),callId:entry.id,purpose:task.instruction,nextStep:task.nextStep},now);return;
 }
 if(final&&entry.tool===final.tool&&matches(args,final.arguments)){
  task.receipts.push(receipt);task.finalActionCallId=entry.id;
  if(final.waitFor==='settlement'){task.phase='working';task.nextAt=0;}
  else if(final.waitFor==='done'){task.phase='waiting_event';task.nextAt=0;}
  else finishStep(task,{callId:entry.id},now);
  record(task,{kind:final.waitFor==='settlement'?'started-work':'action-confirmed',callId:entry.id},now);
 }
}
function arrived(task,event){return event.kind==='arrive'&&task.destination?.label&&event.text==='到了'+task.destination.label&&event.t>=task.travelAt;}
export function linkOwnerTaskEvent(l,event,now){
 const ids=[];
 for(const task of l.ownerTasks||[]){
  if(!open(task)||!event.provenance?.trusted||event.t<task.createdAt)continue;
  if(task.phase==='travelling'&&arrived(task,event)){
   task.phase='ready';task.nextAt=now;task.arrivalEventId=event.id;if(task.travelCompletesStep)finishStep(task,{eventId:event.id,callId:task.travelCallId},now);record(task,{kind:'arrived',eventId:event.id,purposeStillPending:open(task)},now);if(open(task))ids.push(task.id);
  }else if(task.phase==='working'&&event.kind==='done'&&event.t>=task.updatedAt&&/^(?:下班|工作结算|班次结算)/.test(event.text)){
   task.settlementEventId=event.id;finishStep(task,{eventId:event.id,callId:task.finalActionCallId},now);record(task,{kind:'settled',eventId:event.id,workCallId:task.finalActionCallId},now);if(open(task))ids.push(task.id);
  }else if(task.phase==='waiting_event'&&event.kind==='done'&&event.t>=task.updatedAt&&event.text===task.finalAction?.eventText){
   finishStep(task,{eventId:event.id,callId:task.finalActionCallId},now);record(task,{kind:'activity-finished',eventId:event.id},now);if(open(task))ids.push(task.id);
  }
 }
 if(ids.length){event.ownerTaskIds=ids;event.status='pending';event.notBefore=now;}
}
export function advanceOwnerTasks(l,data,now){
 const at=data.at?.state||0;if(at<now-180000)return;
 for(const task of l.ownerTasks||[]){
  const where=data.state?.where,reached=!!task.destination?.id&&(where?.place?.id===task.destination.id||where?.kind==='home'&&task.destination.id==='home');
  if(!open(task)||task.phase!=='travelling'||at<task.travelAt||where?.kind==='trip'||!reached)continue;
  task.phase='ready';task.nextAt=now;task.arrivalState={at,placeId:task.destination.id};if(task.travelCompletesStep)finishStep(task,{stateAt:at,callId:task.travelCallId},now);record(task,{kind:'arrived-state',stateAt:at,purposeStillPending:open(task)},now);
 }
}
export function ownerTaskCandidates(l,now,data={}){return (l.ownerTasks||[]).filter(t=>open(t)&&['pending','ready'].includes(t.phase)&&t.nextAt>0&&t.nextAt<=now&&(!t.optional||!data.state?.doing&&data.state?.where?.kind!=='trip'&&!(l.ownerTasks||[]).some(other=>other.id!==t.id&&open(other)&&['travelling','working','waiting_event'].includes(other.phase))))
 .sort((a,b)=>b.createdAt-a.createdAt).map(t=>({id:t.id,kind:'owner-task',ownerTaskId:t.id,optional:t.optional,priority:t.priority??0,bucket:t.kind==='work'?'work':'idle',text:t.instruction,group:l.queue.filter(q=>q.ownerTaskIds?.includes(t.id)&&['pending','blocked'].includes(q.status))}));}
export function ownerTaskSnapshot(l,round){
 const tasks=(l.ownerTasks||[]).filter(t=>open(t)&&(!round?.ownerTaskId||t.id===round.ownerTaskId)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,3);
 return tasks.map(t=>Object.fromEntries(['id','revision','status','phase','kind','instruction','nextStep','nextAt','finalAction','steps','stepIndex','completedSteps','destination','arrivalEventId','arrivalState','finalActionCallId','source'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])));
}
export function endOwnerTaskRound(l,round,valid,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&open(t));if(!task)return;
 task.checks++;task.lastCheckedAt=now;
 if(valid&&['pending','ready'].includes(task.phase)){
  if(task.completedSteps.some(s=>s.at>=round.startedAt)){task.nextAt=Math.max(task.nextAt,now+180000);return;}
  task.phase='waiting_evidence';task.nextAt=0;record(task,{kind:'no-task-progress',roundId:round.id,summary:round.report?.summary,noReplay:true},now);
 }
}
