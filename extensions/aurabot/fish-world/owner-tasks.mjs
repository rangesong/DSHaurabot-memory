import {createHash} from 'node:crypto';
import {inspectPlanTrigger} from './plan-triggers.mjs';
const WORLD='mcp__fish-world__world_';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const open=t=>t?.status==='active';
const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
const clone=v=>structuredClone(v);
const timestamp=v=>typeof v==='number'?v:Date.parse(v||'')||0;
const matches=(actual,expected)=>Object.entries(expected||{}).every(([k,v])=>JSON.stringify(actual?.[k])===JSON.stringify(v));
const day=value=>new Date(value+8*3600000).toISOString().slice(0,10);
const shiftDay=(value,count)=>new Date(Date.parse(value+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);
const planningAt=value=>Date.parse(value+'T23:45:00+08:00');
const sameScope=(l,task)=>(!l.owner||task.owner===l.owner)&&(!l.persona||task.persona===l.persona);
const workItems=text=>/(?:班上|班内|正在上班|已经上班|(?:打工|工作|上班)的?(?:地方|岗位|店里)).{0,24}(?:处理|有.{0,6}(?:工作|活|事))|(?:工作|活).{0,8}让你处理/.test(text);
const dailyPlanning=text=>/(?:每天|每晚|每日)/.test(text)&&/23\s*[:：]\s*45|(?:二十三|23)点(?:四十五|45)/.test(text)&&/计划|规划|想好|安排/.test(text)&&/明天|次日|第二天/.test(text);
const isMutation=(tool,args={})=>['go','do','say','update'].some(name=>tool===WORLD+name)||tool===WORLD+'friends'&&args.action!=='list';
const uncertainTask=(l,task)=>task.phase==='uncertain'||(l.journal||[]).some(row=>row.ownerTaskId===task.id&&(['executing','uncertain'].includes(row.status)||row.status==='failed'&&isMutation(row.tool,parse(row.args)||{})&&!/\[E_RULE\]/.test(row.result||'')));
const taskOptions=text=>new Set([...String(text||'').matchAll(/^[ \t]*·[ \t]+(task-\d+)[ \t]+\S[^\r\n]*/gm)].map(match=>match[1]));
const fresh=(at,now)=>Number.isFinite(at)&&at>0&&at<=now&&at>=now-180000;
function currentWorkItems(l,data,now){
 const cachedAt=Number(data.at?.now)||0,cached=fresh(cachedAt,now)&&!data.errors?.now;
 if(cached&&taskOptions(data.now).size)return true;
 // A notification may wake a local definition only when it carries real current choices.
 // A later successful now snapshot without choices supersedes an older notification.
 return (l.queue||[]).some(event=>event.kind==='work'&&event.status==='pending'&&event.provenance?.trusted===true&&event.provenance.source==='world-notify'&&fresh(event.t,now)&&fresh(event.receivedAt,now)&&(event.notBefore||0)<=now&&(!cached||event.t>cachedAt)&&taskOptions(event.text).size>0);
}
function workItemDefinitionError(message,code,wait=false){return Object.assign(Error(message),{code,retryable:false,...wait?{wait:true}:{}});}
function planningState(task,now){
 if(task.planning)return task.planning;
 const first=day(task.createdAt||now),today=day(now),latest=now>=planningAt(today)?today:shiftDay(today,-1),instance=latest<first?first:latest;
 task.planning={time:'23:45',timezone:'Asia/Shanghai',day:instance,businessDay:shiftDay(instance,1),completed:{}};
 task.nextAt=Math.max(planningAt(instance),now);return task.planning;
}
function nextPlanningDay(task,completedDay,now){
 const state=planningState(task,now);let next=shiftDay(completedDay,1);
 while(planningAt(next)<=now)next=shiftDay(next,1);
 state.day=next;state.businessDay=shiftDay(next,1);task.phase='pending';task.nextAt=planningAt(next);task.notBefore=0;
}
function planningPlans(l,task,instance,entries,now){
 const target=shiftDay(instance,1),ids=new Set(entries.filter(row=>['create','update'].includes(row.op)&&row.at>=task.createdAt&&row.at<=now).map(row=>row.id));
 return (l.plans||[]).filter(plan=>{
  if(!ids.has(plan.id)||!['pending','active','waiting_event'].includes(plan.status)||plan.owner&&plan.owner!==task.owner||plan.persona&&plan.persona!==task.persona)return false;
  const trigger=inspectPlanTrigger(plan,l,{now});if(!trigger.valid)return false;
  const explicit=[timestamp(plan.businessAt),timestamp(plan.windowStart)].filter(at=>at>0).map(day),dates=new Set(explicit);
  if(dates.size>1)return false;
  const business=explicit[0]||(trigger.kind==='time'&&trigger.nextAt>0?day(trigger.nextAt):null);
  return business===target&&(!(trigger.kind==='time'&&trigger.nextAt>0)||day(trigger.nextAt)===target);
 });
}
function completePlanning(task,plans,instance,now,roundId=null){
 const state=planningState(task,now);state.completed??={};if(state.completed[instance])return false;
 state.completed[instance]={at:now,businessDay:shiftDay(instance,1),planIds:plans.map(plan=>plan.id),roundId,localOnly:true,communicationStatus:'not-claimed'};
 record(task,{kind:'planning-completed',day:instance,businessDay:shiftDay(instance,1),planIds:plans.map(plan=>plan.id),roundId,localOnly:true,communicationStatus:'not-claimed'},now);
 nextPlanningDay(task,instance,now);return true;
}
function fullRule(entry){return entry.status==='failed'&&/\[E_RULE\]/.test(entry.result||'')&&/(?:人手够了|满员|名额已满|岗位已满)/.test(entry.result||'')&&!/timeout|超时|abort|断线|ECONN|未确认|不确定/i.test(entry.result||'');}
function availabilityTime(entry,now,checks=0){
 const minimum=now+180000,delay=Math.min(1800000,180000*2**Math.min(checks,4)),clock=/最早\s*([01]?\d|2[0-3]):([0-5]\d)/.exec(entry.result||'');
 let at=0;if(clock){const anchor=entry.finishedAt||entry.at||now;at=Date.parse(day(anchor)+'T'+clock[1].padStart(2,'0')+':'+clock[2]+':00+08:00');if(at<anchor)at+=86400000;}
 return Math.max(minimum,now+delay,at);
}
function waitAvailability(task,entry,now){
 const checks=task.availability?.checks||0;task.availability={failureCallId:entry.id,failedAt:entry.finishedAt||entry.at||now,checks,checkOnly:true,reason:'staff-full'};
 task.phase='blocked';task.nextAt=availabilityTime(entry,now,checks);record(task,{kind:'known-rule-rejection',callId:entry.id,reason:'staff-full',nextAt:task.nextAt,noReplay:true},now);
}
export function worldToolName(name){
 const value=String(name||'');return /^(?:mcp__fish-world__)?world_(now|history|find|profile|go|do|say|friends|update|guide)$/.test(value)?value.startsWith('mcp__')?value:'mcp__fish-world__'+value:value;
}
function directive(text){
 const value=String(text||'').trim();
 if(!value||value.length>2000||/[？?]|(?:吗|怎么样|去过|是不是|为什么|如何)/.test(value)||/^(?:他说|她说|你说|引用|例如|比如|假如|如果)/.test(value)||/^(?:(?:你|请|那|今天|先|现在|暂时)[，,\s]*)*(?:不要|别(?!忘)|不用|不必|停止|取消|禁止|先不|暂时不)/.test(value))return null;
 const addressed=/^(?:你|请|麻烦|记得|别忘|那|帮我|给我|替我|帮忙|每天|每晚|每日|打工的地方|工作的地方|班上|班内)/.test(value)&&!/^(?:你(?:知道|觉得|认为|说)|(?:每天|每晚|每日)(?:我|他|她|大家))/.test(value)&&!/(?:让我|让他|让她|由我|我来|他来|她来)处理/.test(value);
 if(addressed&&dailyPlanning(value))return {kind:'planning',optional:false,finalAction:null,scheduled:false};
 if(addressed&&workItems(value))return {kind:'work-items',optional:/没事|有空|可以|顺便/.test(value),finalAction:null,scheduled:/明天|后天|今晚|晚上|\d\s*(?:点|:|：)/.test(value)};
 if(dailyPlanning(value)||workItems(value))return null;
 if(!/^(?:(?:请|麻烦|记得|别忘|你|那|帮我|给我|替我|帮忙|带|送|先|等|现在|今天|明天|今晚|待会|吃完|到了|出门|回|去|到|买|找|拿|做|打工|上班))/.test(value)||!/(?:去|回|出门|打工|上班|买|找|带|送|拿|做|看书|读书|吃饭|煮饭)/.test(value))return null;
 const kind=workItems(value)?'work-items':/打(?:个|一份|份|一会儿|一会)?工|上班|短工|兼职|接.{0,3}班/.test(value)?'work':/看书|读书|借书/.test(value)?'read':/买|购买/.test(value)?'buy':/煮饭|做饭|焖饭/.test(value)?'cook':/吃饭|吃完饭/.test(value)?'eat':'activity';
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
  let cancelled=null;for(const task of l.ownerTasks||[])if(open(task)&&['work','work-items'].includes(task.kind)&&task.owner===identity.owner&&task.persona===identity.persona){task.status='cancelled';task.phase='cancelled';record(task,{kind:'owner-cancelled',instruction:String(text),sourceKey:key},now);cancelled=task;}return cancelled;
 }
 if(!spec)return null;
 // Unscoped requests such as making a report must not start fish-world model rounds.
 // Their current-turn purpose is activated only if that owner actually invokes a world mutation.
 if(!confirmedWorld&&['activity','buy','planning','work-items'].includes(spec.kind)&&!/(?:鱼的?世界|小镇|食堂|图书馆|书店|商店|超市|市集|夜市|摊|修车铺|咖啡店)/.test(text)){
  l.ownerTaskContexts[sessionId].deferred={text:String(text),turnKey};return null;
 }
 l.ownerTasks??=[];
 const existing=l.ownerTasks.findLast(t=>open(t)&&t.instruction===text&&t.owner===identity.owner&&t.persona===identity.persona);
 if(existing){l.ownerTaskContexts[sessionId].taskId=existing.id;existing.currentSessionId=sessionId;
  if(existing.phase==='waiting_evidence'||existing.phase==='blocked'&&existing.contractIssue?.code==='definition-attempt-limit'){existing.phase=!existing.finalAction&&existing.kind!=='planning'||existing.scheduleRequired&&!existing.notBefore?'needs_definition':'pending';existing.nextAt=Math.max(existing.notBefore||0,now+180000);existing.definitionAttempts=0;existing.definitionNextAt=existing.nextAt;delete existing.contractIssue;record(existing,{kind:'owner-renewed',sourceKey:key},now);return existing;}return null;}
 const id='owner-task-'+hash([identity,sessionId,key,now,l.ownerTasks.length]).slice(0,24);
 const task={id,revision:1,status:'active',phase:spec.scheduled||spec.kind==='work-items'?'needs_definition':'pending',scheduleRequired:spec.scheduled,kind:spec.kind,optional:spec.optional,priority:spec.optional?3:0,instruction:String(text),nextStep:String(text),
  owner:identity.owner,persona:identity.persona,currentSessionId:sessionId,source:{kind:'current-owner-prompt',sessionId,key,at:now},createdAt:now,updatedAt:now,
  nextAt:spec.scheduled?0:now+180000,finalAction:spec.finalAction,steps:spec.finalAction?[{...clone(spec.finalAction),nextStep:String(text),waitFor:spec.kind==='work'?'settlement':'receipt'}]:[],stepIndex:0,completedSteps:[],receipts:[],history:[],checks:0};
 task.finalAction=task.steps.length?clone(task.steps[0]):null;if(task.kind==='planning')planningState(task,now);l.ownerTasks.push(task);l.ownerTaskContexts[sessionId].taskId=id;return task;
}
export function taskForExecution(l,exec){
 if(!exec.agent?.session?.id)return;
 const r=l.round,background=r?.sessionId===exec.agent?.session?.id;
 const id=background?r.ownerTaskId:l.ownerTaskContexts?.[exec.agent?.session?.id]?.taskId;
 const explicit=(l.ownerTasks||[]).find(t=>t.id===id&&sameScope(l,t)&&['active','completed'].includes(t.status));if(explicit||id)return explicit;
 // A task-* action identifies one real work item. Generic work/go/food must never reconcile by similarity.
 if(!background||exec.name!==WORLD+'do'||!/^task-\d+$/.test(exec.arguments?.id||''))return;
 const exact=(l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&t.kind==='work-items'&&t.finalAction?.tool===exec.name&&t.finalAction.arguments?.id===exec.arguments.id&&matches(exec.arguments,t.finalAction.arguments));
 return exact.length===1?exact[0]:undefined;
}
function record(task,event,now){task.history.push({at:now,...event});task.updatedAt=now;task.revision++;}
export function defineOwnerTask(l,input,{sessionId,background=false,taskId,now}){
 const task=(l.ownerTasks||[]).find(t=>t.id===input.id&&open(t)&&sameScope(l,t));
 if(!task||(background?task.id!==taskId:l.ownerTaskContexts?.[sessionId]?.taskId!==task.id))throw Error('不是当前主人任务');
 if(input.expectedRevision!==task.revision)throw Error('主人任务版本已变化，请使用当前快照');
 if(task.kind==='planning')throw Error('每日规划只提交本地次日计划，不登记世界动作作为完成凭据');
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
 if(task.kind==='work-items'){
  const current=(l.journal||[]).findLast(row=>row.tool===WORLD+'now'&&row.status==='confirmed'&&!row.isError&&row.sessionId===sessionId&&fresh(row.finishedAt||row.at,now)&&(!background||row.round===l.round?.id)),offered=taskOptions(current?.result);
  if(!offered.size)throw workItemDefinitionError('当前没有可核对的真实 task-* 班内选项；保留原请求等待，不要改成 work 重新上班或改参数重试，请正常结束本轮','OWNER_WORK_ITEMS_WAIT',true);
  if(!steps.some(step=>step.tool===WORLD+'do'&&/^task-\d+$/.test(step.arguments.id||''))||steps.some(step=>step.tool===WORLD+'do'&&(!/^task-\d+$/.test(step.arguments.id||'')||!offered.has(step.arguments.id))))throw workItemDefinitionError('班内工作必须从当前 world_now 的真实 task-* 选项定义，不能替换为重新接班；本轮不要改参数猜测，请正常结束','OWNER_WORK_ITEMS_INVALID_ACTION');
 }
 if(input.nextAt!==undefined&&(!Number.isFinite(input.nextAt)||input.nextAt<now))throw Error('nextAt 需要未来的13位毫秒时间');
 if(steps.some(s=>task.completedSteps.some(done=>done.action.tool===s.tool&&matches(s.arguments,done.action.arguments))))throw Error('已完成步骤不能重新登记；只细化尚未完成的后续步骤');
 task.steps=[...task.steps.slice(0,task.stepIndex),...steps];task.finalAction=clone(steps[0]);task.nextStep=steps[0].nextStep;task.nextAt=input.nextAt??Math.max(task.nextAt,now);task.notBefore=input.nextAt??0;
 task.definitionAttempts=0;task.definitionNextAt=0;delete task.contractIssue;
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
 if(task.kind==='planning'||background&&(l.round?.definitionOnly||l.round?.planningOnly))return '本轮只登记任务定义或本地次日规划，不执行世界变更';
 if(task.optional&&(data.state?.doing||(l.ownerTasks||[]).some(t=>t.id!==task.id&&open(t)&&['travelling','working','waiting_event'].includes(t.phase))))return '有空时再做的安排不能打断正在进行的任务；原始要求已保留';
 if(task.status==='completed')return '此主人任务已经有完整成功依据，不得重复执行；等待主人新的要求';
 if(task.phase==='uncertain')return '此主人任务存在未确认变更，只能只读核对，不得重做';
 if(task.availability?.checkOnly)return '已知满员只安排只读复查；先核对新的 world_now，不自动重放接班';
 if(['working','waiting_event'].includes(task.phase)&&exec.name===task.finalAction?.tool&&matches(exec.arguments,task.finalAction.arguments))return '此步骤已提交，等待真实完成通知，不重复执行';
 if(task.completedSteps.some(s=>s.action?.tool===exec.name&&matches(exec.arguments,s.action.arguments))&&!(task.finalAction?.tool===exec.name&&matches(exec.arguments,task.finalAction.arguments)))return '此任务的这个步骤已有成功回执，继续下一步，不要重复';
 if(task.phase==='needs_definition'||task.notBefore&&now<task.notBefore)return '主人任务的未来时间尚未登记或未到；用 fish_life_task 保存准确 nextAt，不能提前行动';
 if(!task.finalAction)return '主人安排尚未登记完整后续步骤；先用 fish_life_task 保存任务 '+task.id+' 的下一步和完成动作';
 if(task.phase==='travelling'&&exec.name===task.finalAction?.tool&&matches(exec.arguments,task.finalAction.arguments))return '仍在路上；主人任务已持久保存，等待真实到达后继续，不要提前执行或反复重试';
 if(background&&task.kind==='work'&&task.phase==='ready'&&task.finalAction?.arguments?.id==='work'&&exec.name===WORLD+'do'&&exec.arguments.id!=='work'&&!/^task-/.test(exec.arguments.id||'')&&!/(?:先吃|吃完.{0,5}再)/.test(task.instruction))return '当前主人任务是到达后上工；临时生活动作不能替代，确需中断请如实报告受阻原因';
}
export function noteOwnerTaskResult(l,data,entry,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===entry.ownerTaskId&&open(t)&&sameScope(l,t));if(!task)return;
 const args=parse(entry.args)||{};
 if(entry.status==='uncertain'){
  task.phase='uncertain';l.recovery=true;record(task,{kind:'uncertain',callId:entry.id,tool:entry.tool,noReplay:true},now);return;
 }
 if(entry.status==='failed'){
  if(fullRule(entry)&&task.kind==='work'&&entry.tool===task.finalAction?.tool&&matches(args,task.finalAction.arguments)){waitAvailability(task,entry,now);return;}
  if(isMutation(entry.tool,args)&&!/\[E_RULE\]/.test(entry.result||'')){task.phase='uncertain';task.nextAt=0;l.recovery=true;record(task,{kind:'unknown-failure',callId:entry.id,noReplay:true},now);}
  return;
 }
 if(entry.status!=='confirmed')return;
 if(task.availability?.checkOnly&&entry.tool===WORLD+'now'){
  const work=(entry.result||'').split('\n').find(line=>/^·\s+work\b/.test(line)),capacity=work&&/(\d+)\s*\/\s*(\d+)/.exec(work),closed=/(?:人手够了|满员|名额已满|岗位已满)/.test(work||'')||capacity&&Number(capacity[1])>=Number(capacity[2]);
  task.availability.checks++;task.availability.lastCheckedAt=now;task.availability.checkCallId=entry.id;
  if(work&&!closed){task.availability.checkOnly=false;task.phase='pending';task.nextAt=now+180000;task.notBefore=task.nextAt;record(task,{kind:'availability-open',callId:entry.id,nextAt:task.nextAt},now);}
  else{task.phase='blocked';task.nextAt=availabilityTime(entry,now,task.availability.checks);record(task,{kind:'availability-check',callId:entry.id,nextAt:task.nextAt,noReplay:true},now);}
  return;
 }
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
  if(!open(task)||!sameScope(l,task)||!event.provenance?.trusted||event.t<task.createdAt)continue;
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
  if(!open(task)||!sameScope(l,task)||task.phase!=='travelling'||at<task.travelAt||where?.kind==='trip'||!reached)continue;
  task.phase='ready';task.nextAt=now;task.arrivalState={at,placeId:task.destination.id};if(task.travelCompletesStep)finishStep(task,{stateAt:at,callId:task.travelCallId},now);record(task,{kind:'arrived-state',stateAt:at,purposeStillPending:open(task)},now);
 }
}
export function ownerTaskCandidates(l,now,data={}){return (l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&!uncertainTask(l,t)&&(t.phase==='needs_definition'&&(t.kind!=='work-items'||currentWorkItems(l,data,now))&&(t.definitionAttempts||0)<3&&(t.definitionNextAt||0)<=now&&(!t.lastCheckedAt||now-t.lastCheckedAt>=600000)||(['pending','ready'].includes(t.phase)||t.phase==='blocked'&&t.availability?.checkOnly)&&t.nextAt>0&&t.nextAt<=now)&&(!t.optional||!data.state?.doing&&data.state?.where?.kind!=='trip'&&!(l.ownerTasks||[]).some(other=>other.id!==t.id&&open(other)&&['travelling','working','waiting_event'].includes(other.phase))))
 .sort((a,b)=>b.createdAt-a.createdAt).map(t=>({id:t.id,kind:'owner-task',ownerTaskId:t.id,optional:t.optional,priority:t.priority??0,bucket:['work','work-items'].includes(t.kind)?'work':'idle',definitionOnly:t.phase==='needs_definition',planningOnly:t.kind==='planning',readOnly:!!t.availability?.checkOnly,text:t.instruction,group:(l.queue||[]).filter(q=>q.ownerTaskIds?.includes(t.id)&&['pending','blocked'].includes(q.status))}));}
export function ownerTaskSnapshot(l,round){
 const tasks=(l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&(!round?.ownerTaskId||t.id===round.ownerTaskId)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,3);
 return tasks.map(t=>Object.fromEntries(['id','revision','status','phase','kind','instruction','nextStep','nextAt','notBefore','finalAction','steps','stepIndex','completedSteps','destination','arrivalEventId','arrivalState','finalActionCallId','source','availability','planning','definitionAttempts','definitionNextAt','contractIssue'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])));
}
export function ownerTaskPlanningComplete(l,round,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&open(t)&&sameScope(l,t)&&t.kind==='planning');if(!task)return {completed:false};
 const state=planningState(task,now),instance=state.day;if(state.completed?.[instance]||Object.values(state.completed||{}).some(item=>item.roundId&&item.roundId===round.id))return {completed:false,alreadyCompleted:true};
 const committed=(l.planHistory||[]).filter(row=>row.roundId===round.id&&row.at>=round.startedAt&&row.at<=now),plans=planningPlans(l,task,instance,committed,now);
 if(!plans.length)return {completed:false,day:instance,issue:'missing-next-day-executable-plans'};
 const completed=completePlanning(task,plans,instance,now,round.id);return {completed,day:instance,planIds:plans.map(plan=>plan.id),nextAt:task.nextAt};
}
/** Idempotent local reconciliation of existing task records, never a scan of historical chat. */
export function reconcileOwnerTasks(l,data,now){
 let changed=0;
 for(const task of l.ownerTasks||[]){
  if(!open(task)||!sameScope(l,task)||uncertainTask(l,task))continue;
  task.history??=[];task.receipts??=[];task.completedSteps??=[];task.steps??=[];
  if(dailyPlanning(task.instruction)&&!['travelling','working','waiting_event'].includes(task.phase)&&!task.completedSteps.length&&!task.receipts.length){
   if(task.kind!=='planning'){
    task.previousContract??={kind:task.kind,phase:task.phase,nextAt:task.nextAt,finalAction:clone(task.finalAction),steps:clone(task.steps)};
    task.kind='planning';task.phase='pending';task.scheduleRequired=false;task.finalAction=null;task.steps=[];planningState(task,now);record(task,{kind:'local-planning-contract',noWorldMutation:true},now);changed++;
   }
   const state=planningState(task,now),existing=(l.planHistory||[]).filter(row=>day(row.at)===state.day),plans=planningPlans(l,task,state.day,existing,now);
   if(plans.length&&completePlanning(task,plans,state.day,now)){changed++;}
   continue;
  }
  if(workItems(task.instruction)&&task.kind!=='work-items'&&!['travelling','working','waiting_event'].includes(task.phase)&&!task.completedSteps.length&&!task.receipts.length){
   task.previousContract??={kind:task.kind,phase:task.phase,nextAt:task.nextAt,finalAction:clone(task.finalAction),steps:clone(task.steps)};
   task.kind='work-items';task.phase='needs_definition';task.finalAction=null;task.steps=[];task.stepIndex=0;task.nextAt=now;delete task.availability;
   record(task,{kind:'work-item-contract-correction',noReplay:true},now);changed++;continue;
  }
  if(task.kind==='work'&&task.phase==='waiting_evidence'&&!task.availability){
   const last=(l.journal||[]).filter(row=>row.ownerTaskId===task.id&&row.tool===task.finalAction?.tool).at(-1);
   if(last&&fullRule(last)){waitAvailability(task,last,now);changed++;}
  }
 }
 return {changed};
}
export function endOwnerTaskRound(l,round,valid,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&open(t)&&sameScope(l,t));if(!task)return;
 if(round.id&&task.lastEndedRoundId===round.id)return;task.lastEndedRoundId=round.id;
 task.checks++;task.lastCheckedAt=now;
 if(task.kind==='planning'){
  planningState(task,now);
  const result=valid?ownerTaskPlanningComplete(l,round,now):{completed:false};
  if(!result.completed&&!result.alreadyCompleted){task.phase='pending';task.nextAt=Math.max(task.nextAt||0,now+600000);task.planning.lastIssue=result.issue||'round-not-completed';}
  return;
 }
 if(round.definitionOnly){
  if(task.phase==='needs_definition'){
   task.definitionAttempts=(task.definitionAttempts||0)+1;task.definitionNextAt=now+Math.min(3600000,600000*2**Math.min(2,task.definitionAttempts-1));task.nextAt=task.definitionNextAt;
   if(task.definitionAttempts>=3){task.phase='blocked';task.nextAt=0;task.contractIssue={code:'definition-attempt-limit',at:now,requiresOwnerClarification:true};}
   record(task,{kind:'definition-incomplete',roundId:round.id,attempts:task.definitionAttempts,nextAt:task.nextAt,noWorldMutation:true},now);
  }
  return;
 }
 if(task.availability?.checkOnly||task.availability?.lastCheckedAt>=round.startedAt)return;
 if(valid&&['pending','ready'].includes(task.phase)){
  if(task.completedSteps.some(s=>s.at>=round.startedAt)){task.nextAt=Math.max(task.nextAt,now+180000);return;}
  task.phase='waiting_evidence';task.nextAt=0;record(task,{kind:'no-task-progress',roundId:round.id,summary:round.report?.summary,noReplay:true},now);
 }
}
