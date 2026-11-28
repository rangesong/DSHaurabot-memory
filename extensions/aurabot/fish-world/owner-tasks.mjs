import {createHash} from 'node:crypto';
import {inspectPlanTrigger} from './plan-triggers.mjs';
import {parseWorldNowActivity} from './plan-activity.mjs';
import {sessionKey,sameSession,ownerTaskContext,setOwnerTaskContext} from './session-identity.mjs';
import {finiteActivityFromReceipt} from './finite-activity.mjs';
import {knownWorldRejection,purchaseReceipt} from './tool-output.mjs';
const WORLD='mcp__fish-world__world_';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const open=t=>t?.status==='active';
export const ownerTaskInFlight=task=>['travelling','working'].includes(task?.phase)||task?.phase==='waiting_event'&&task.activity?.blocking!==false;
const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
const clone=v=>structuredClone(v);
const timestamp=v=>typeof v==='number'?v:Date.parse(v||'')||0;
const matches=(actual,expected)=>Object.entries(expected||{}).every(([k,v])=>JSON.stringify(actual?.[k])===JSON.stringify(v));
const sameAction=(a,b)=>{const keys=value=>Object.keys(value||{}).filter(key=>key!=='request_id').sort();return JSON.stringify(keys(a))===JSON.stringify(keys(b))&&keys(a).every(key=>JSON.stringify(a[key])===JSON.stringify(b[key]));};
const priorAction=(task,tool,args)=>(task.journey?.priorActions||[]).find(row=>row.tool===tool&&sameAction(args,row.arguments));
const day=value=>new Date(value+8*3600000).toISOString().slice(0,10);
const shiftDay=(value,count)=>new Date(Date.parse(value+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);
const planningAt=value=>Date.parse(value+'T23:45:00+08:00');
const sameScope=(l,task)=>(!l.owner||task.owner===l.owner)&&(!l.persona||task.persona===l.persona);
const workItems=text=>/(?:班上|班内|正在上班|已经上班|(?:打工|工作|上班)的?(?:地方|岗位|店里)).{0,24}(?:处理|有.{0,6}(?:工作|活|事))|(?:工作|活).{0,8}让你处理/.test(text);
const dailyPlanning=text=>/(?:每天|每晚|每日)/.test(text)&&/23\s*[:：]\s*45|(?:二十三|23)点(?:四十五|45)/.test(text)&&/计划|规划|想好|安排/.test(text)&&/明天|次日|第二天/.test(text);
const isMutation=(tool,args={})=>['go','do','say','update'].some(name=>tool===WORLD+name)||tool===WORLD+'friends'&&args.action!=='list';
const rowArguments=row=>typeof row.args==='string'?parse(row.args):row.args;
const unknownMutation=row=>isMutation(row.tool,rowArguments(row)||{})&&(['executing','uncertain'].includes(row.status)||row.status==='failed'&&!knownWorldRejection(row));
export const uncertainTask=(l,task)=>task.phase==='uncertain'||(l.journal||[]).some(row=>row.ownerTaskId===task.id&&unknownMutation(row));
/** An unresolved operation keeps its identity even when its original purpose is paused. */
export function unknownWorldMutationGuard(l,exec){
 const args=exec.arguments||{};if(!isMutation(exec.name,args))return;
 const owned=row=>{
  if(row.owner!==undefined&&row.owner!==l.owner||row.persona!==undefined&&row.persona!==l.persona)return false;
  const task=(l.ownerTasks||[]).find(task=>task.id===row.ownerTaskId);
  if(task)return sameScope(l,task);
  return sameSession(row.sessionId,exec.agent?.session?.id)||sameSession(row.sessionId,l.sessionId)||(l.contextWindow?.windows||[]).some(window=>sameSession(row.sessionId,window.sessionId));
 };
 const overlaps=row=>{
  if(row.tool!==exec.name)return false;
  const old=rowArguments(row);if(!old||typeof old!=='object'||Array.isArray(old))return true;
  const equalTarget=key=>typeof old[key]!=='string'||!old[key]||typeof args[key]!=='string'||!args[key]||old[key]===args[key];
  if(exec.name===WORLD+'go')return equalTarget('place');
  const peer=value=>{if(typeof value!=='string')return null;const match=/(?:^|#)(\d{1,16})$/u.exec(value.trim());return match?BigInt(match[1]).toString():null;};
  const oldPeer=peer(old.fish),newPeer=peer(args.fish),samePeer=!oldPeer||!newPeer||oldPeer===newPeer;
  if(exec.name===WORLD+'do')return equalTarget('id');
  if(exec.name===WORLD+'say')return samePeer&&equalTarget('text');
  if(exec.name===WORLD+'friends')return equalTarget('action')&&samePeer;
  if(exec.name===WORLD+'update')return equalTarget('outfit');
  return true;
 };
 if((l.journal||[]).some(row=>owned(row)&&unknownMutation(row)&&overlaps(row)))return '此世界动作存在未确认变更结果；切换目的或修改请求参数不能重放，只读核对原回执后再处理';
}
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
 if(!value||value.length>2000||/[？?]|(?:吗|怎么样|去过|是不是|为什么|如何)/.test(value)||/^(?:[>“「『"]|他说|她说|你说|引用|例如|比如|假如|如果)/.test(value)||/^(?:(?:你|请|那|今天|先|现在|暂时|上午|下午|早上|中午|晚上|待会儿?|临时)[，,\s]*)*(?:不要|别(?!忘)|不用|不必|停止|取消|禁止|先不|暂时不|不去)/.test(value)||/^(?:(?:上午|下午|早上|中午|晚上|待会儿?|今天|临时)[，,\s]*)*(?:研究|浏览|学习|聊聊|讨论|查阅)/.test(value))return null;
 const addressed=/^(?:你|请|麻烦|记得|别忘|那|帮我|给我|替我|帮忙|每天|每晚|每日|打工的地方|工作的地方|班上|班内)/.test(value)&&!/^(?:你(?:知道|觉得|认为|说)|(?:每天|每晚|每日)(?:我|他|她|大家))/.test(value)&&!/(?:让我|让他|让她|由我|我来|他来|她来)处理/.test(value);
 if(addressed&&dailyPlanning(value))return {kind:'planning',optional:false,finalAction:null,scheduled:false};
 if(addressed&&workItems(value))return {kind:'work-items',optional:/没事|有空|可以|顺便/.test(value),finalAction:null,scheduled:/明天|后天|今晚|晚上|\d\s*(?:点|:|：)/.test(value)};
 if(dailyPlanning(value)||workItems(value))return null;
 if(!/^(?:(?:请|麻烦|记得|别忘|你|那|帮我|给我|替我|帮忙|带|送|先|等|现在|今天|明天|今晚|上午|下午|早上|中午|晚上|临时|改去|待会|吃完|到了|出门|回|去|到|买|找|拿|做|打工|上班))/.test(value)||!/(?:去|回|出门|打工|上班|买|找|带|送|拿|做|看书|读书|吃饭|煮饭)/.test(value))return null;
 const kind=workItems(value)?'work-items':/打(?:个|一份|份|一会儿|一会)?工|上班|短工|兼职|接.{0,3}班/.test(value)?'work':/看书|读书|借书/.test(value)?'read':/买|购买/.test(value)?'buy':/煮饭|做饭|焖饭/.test(value)?'cook':/吃饭|吃完饭/.test(value)?'eat':'activity';
 const finalAction=kind==='work'?{tool:WORLD+'do',arguments:{id:'work'}}:kind==='read'?{tool:WORLD+'do',arguments:{id:'read'}}:kind==='cook'?{tool:WORLD+'do',arguments:{id:'cook'}}:null;
 return {kind,optional:/没事|有空|可以|顺便/.test(value),finalAction:/再|然后|之后|回来|回家|顺便|并且|办完|煮.*吃|做饭.*吃/.test(value)?null:finalAction,scheduled:/明天|后天|下周|今晚|晚上|\d\s*(?:点|:|：)/.test(value)};
}
function requiredText(value,label,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error(label+'需要明确且长度合适的文字');return value.trim();}
function normalizeSteps(submitted){
 if(!Array.isArray(submitted)||!submitted.length||submitted.length>8)throw Error('任务需要1到8个明确步骤');
 return submitted.map(s=>{
  const tool=worldToolName(s.tool),supplied=parse(s.arguments);
  if(![WORLD+'go',WORLD+'do',WORLD+'say',WORLD+'friends',WORLD+'update'].includes(tool)||!supplied||typeof supplied!=='object'||Array.isArray(supplied)||!Object.keys(supplied).length||!String(s.nextStep||'').trim())throw Error('每一步需要实际工具、完整 JSON 参数及下一步说明');
  const {request_id:ignored,...args}=supplied;
  if(tool===WORLD+'friends'&&args.action==='list')throw Error('只读查询不能作为任务完成动作');
  const waitFor=tool===WORLD+'go'?'arrival':tool===WORLD+'do'&&args.id==='work'?'settlement':s.waitFor==='done'?'done':'receipt';
  return {tool,arguments:args,nextStep:String(s.nextStep).slice(0,1000),waitFor,...waitFor==='done'&&String(s.eventText||'').trim()?{eventText:String(s.eventText)}:{}};
 });
}
const taskSession=task=>task.journey?.registeredSessionId||task.currentSessionId||task.source?.sessionId;
const exactPlace=(data,destination,now)=>fresh(data?.at?.state,now)&&data.state?.where?.kind!=='trip'&&(data.state?.where?.place?.id===destination||destination==='home'&&data.state?.where?.kind==='home');
const observationIsAction=text=>/(?:购买|采购|采买|买|接班|上班|打工|领工钱|请教|询问|问老板|打听|交付|送货|种菜|做饭|煮饭)/.test(text);
const ownerObservation=text=>typeof text==='string'&&!/(?:买|购|打工|上班|接班|问|交付|送货|采|捡|钓|种|做|煮|吃|看书|读|借|取|拿)/.test(text)&&/^(?:(?:你|请|那|今天|明天|上午|下午|早上|中午|晚上|待会儿?|临时|现在|先)[，,\s]*)*(?:去|到|改去)[^，,。；;\n]{1,120}(?:看看|逛逛|走走)(?:吧|呀|啊)?[。！!]?$/u.test(text);
const paused=task=>task.focus?.state==='paused';
const resumedDefinition=task=>task.phase==='waiting_evidence'&&task.nextAt===0&&task.focus?.state==='active'&&Number.isFinite(task.focus.resumedAt)&&task.focus.resumedAt>(task.focus.definitionCheckedAt||0);
function pauseFocus(task,by,now){
 if(paused(task))return;
 task.focus={state:'paused',pausedAt:now,pausedBy:by};record(task,{kind:'purpose-paused',pausedBy:by,localOnly:true,noWorldMutation:true},now);
}
function bindPurposeContext(l,sessionId,context,task,now){
 setOwnerTaskContext(l,sessionId,{key:context?.key||task.journey.registeredTurnKey,taskId:task.id,at:now,...typeof context?.ownerText==='string'?{ownerText:context.ownerText}:{}});
}
function activateOwnerFocus(l,task,sessionId,now){
 const immediate=task.kind!=='planning'&&!task.scheduleRequired&&!(task.notBefore>now);if(!immediate)return false;
 const changed=paused(task)||task.focus?.state!=='active';task.focus={...task.focus,state:'active',activatedAt:now};
 for(const other of l.ownerTasks||[])if(other!==task&&open(other)&&sameScope(l,other)&&other.kind!=='planning'&&!paused(other)&&sameSession(taskSession(other),sessionId)&&!ownerTaskInFlight(other)&&!other.scheduleRequired&&!(other.notBefore>now))pauseFocus(other,task.id,now);
 if(changed)record(task,{kind:'owner-purpose-focused',localOnly:true,noWorldMutation:true},now);return changed;
}
/** Register an explicit local purpose. This never executes a world tool or infers an owner command. */
export function registerJourney(l,input,{sessionId,identity,now,background=false,sourceKind='explicit-journey',data}={}){
 if(!sessionKey(sessionId)||!identity?.owner||!identity?.persona||!Number.isFinite(now)||now<=0||l.owner&&l.owner!==identity.owner||l.persona&&l.persona!==identity.persona)throw Error('出发目的必须绑定当前主人、人格与会话');
 if(background&&(!sameSession(l.round?.sessionId,sessionId)||l.round.status!=='running'))throw Error('不是当前世界后台会话');
 const goal=requiredText(input?.goal,'原目的'),destination=requiredText(input?.destination,'真实地点编号',120),arrivalStep=requiredText(input?.arrivalStep,'到达后目的'),completionType=input?.completionType??'action';
 if(/[\r\n]/.test(destination)||!['action','observe'].includes(completionType))throw Error('需要精确地点编号和合法完成类型');
 if(completionType==='observe'&&observationIsAction(goal+' '+arrivalStep))throw Error('购买、上工或询问等实际行动不能登记成只观察完成');
 const context=ownerTaskContext(l,sessionId),suggestedSteps=input.steps===undefined?[]:normalizeSteps(input.steps),tasks=l.ownerTasks||[],scheduled=sourceKind==='world-schedule',turnKey=context?.key,current=tasks.find(t=>t.id===context?.taskId&&open(t)&&sameScope(l,t));
 const policy=input.switchPolicy??(input.replaceTaskId?'replace':'pause');
 if(!['pause','replace'].includes(policy)||input.resumeTaskId&&input.replaceTaskId)throw Error('需要明确目的切换方式，恢复与替换不能同时提交');
 if(scheduled&&tasks.some(t=>open(t)&&sameScope(l,t)&&t.kind!=='planning'&&!t.optional&&t.source?.kind!=='world-schedule'))throw Error('当前仍有主人目的；世界定时活动只能等待，不能替代或抢占');
 const journeys=tasks.filter(t=>open(t)&&sameScope(l,t)&&t.kind==='journey'&&sameSession(taskSession(t),sessionId));
 const foreground=tasks.filter(t=>open(t)&&sameScope(l,t)&&t.kind!=='planning'&&!paused(t)&&sameSession(taskSession(t),sessionId));
 if(input.resumeTaskId){
  const resumed=journeys.find(t=>t.id===input.resumeTaskId);
  if(background||scheduled||!resumed||resumed.journey.goal!==goal||resumed.journey.destination!==destination||resumed.journey.arrivalStep!==arrivalStep||resumed.journey.completionType!==completionType)throw Error('只能按原目的、地点和到达后要求恢复当前同会话任务');
  const other=foreground.filter(t=>t!==resumed);for(const task of other)pauseFocus(task,resumed.id,now);
  if(paused(resumed)||!resumed.focus){resumed.focus={state:'active',resumedAt:now};record(resumed,{kind:'purpose-resumed',localOnly:true,noWorldMutation:true},now);}
  if(resumed.phase==='waiting_evidence'&&resumed.nextAt===0&&!uncertainTask(l,resumed))resumed.lastCheckedAt=0;
  bindPurposeContext(l,sessionId,context,resumed,now);return {ok:true,reused:true,resumed:true,task:clone(resumed),pausedIds:other.map(t=>t.id),replacedIds:[]};
 }
 const same=journeys.find(t=>t.journey.goal===goal&&t.journey.destination===destination&&t.journey.arrivalStep===arrivalStep&&t.journey.completionType===completionType);
 if(same&&!input.replaceTaskId){if(paused(same)&&(background||scheduled))throw Error('后台和定时活动不能恢复主人挂起的目的');if(!background&&!scheduled)activateOwnerFocus(l,same,sessionId,now);if(!scheduled&&same.optional&&same.source.kind==='world-schedule'){const previousSource=clone(same.source);same.optional=false;same.priority=0;same.source={...same.source,kind:String(sourceKind).slice(0,80),confirmedByOwnerAt:now};record(same,{kind:'confirmed-by-owner',previousSource},now);}same.journey.registeredTurnKey=turnKey||hash(['journey',same.id]);bindPurposeContext(l,sessionId,context,same,now);return {ok:true,reused:true,task:clone(same),pausedIds:[],replacedIds:[]};}
 const replace=input.replaceTaskId?tasks.find(t=>t.id===input.replaceTaskId&&open(t)&&sameScope(l,t)&&sameSession(taskSession(t),sessionId)):null;
 if(input.replaceTaskId&&(!replace||replace.kind==='planning'))throw Error('只能明确替换当前同会话的未完成临时目的，不能替换每日规划');
 if(scheduled&&replace?.source?.kind!=='world-schedule'&&replace)throw Error('世界定时活动不能替换主人目的');
 const conflicts=[...new Set([...foreground,...current&&current.kind!=='planning'&&!paused(current)?[current]:[]])].filter(t=>t!==replace);
 if((background||scheduled)&&(replace||conflicts.length))throw Error('后台和定时活动不能切换或抢占现有主人目的');
 const id='owner-task-'+hash([identity,sessionKey(sessionId),goal,destination,arrivalStep,completionType,now,tasks.length]).slice(0,24),step={tool:WORLD+'go',arguments:{place:destination},nextStep:'前往 '+destination+'；到达后：'+arrivalStep,waitFor:'arrival'};
 const ownerPurpose=!background&&!scheduled&&directive(context?.ownerText)?context.ownerText:null;
 const task={id,revision:1,status:'active',phase:'pending',scheduleRequired:false,kind:'journey',optional:scheduled,priority:scheduled?3:0,instruction:goal,originalPurpose:ownerPurpose||goal,purposeSource:ownerPurpose?'owner-current':'agent-proposed',focus:{state:'active'},nextStep:step.nextStep,owner:identity.owner,persona:identity.persona,currentSessionId:sessionId,source:{kind:String(sourceKind).slice(0,80),sessionId,at:now},createdAt:now,updatedAt:now,nextAt:now,finalAction:clone(step),steps:[step],stepIndex:0,completedSteps:[],receipts:[],history:[],checks:0,journey:{goal,destination,arrivalStep,completionType,registeredSessionId:sessionId,registeredTurnKey:turnKey||hash(['journey',id]),...background?{registeredRoundId:l.round.id}:{},stage:'outbound',suggestedSteps}};
 if(ownerPurpose&&ownerObservation(ownerPurpose))task.ownerCompletionType='observe';
 if(exactPlace(data,destination,now)){task.steps=[];task.finalAction=null;task.phase='needs_definition';task.nextStep=arrivalStep;task.arrivalState={at:data.at.state,placeId:destination};task.journey.stage='arrival-purpose';task.journey.arrivedAt=data.at.state;task.journey.arrivalEvidence={kind:'state',at:data.at.state,placeId:destination};const label=data.state.where?.place?.name;if(typeof label==='string'&&label.trim())task.journey.destinationName=label.trim();}
 const pausedIds=[],replacedIds=[];
 for(const conflict of [...conflicts,...replace?[replace]:[]]){
  if(conflict===replace&&policy==='replace'&&!uncertainTask(l,conflict)&&!ownerTaskInFlight(conflict)){conflict.status='cancelled';conflict.phase='cancelled';conflict.nextAt=0;record(conflict,{kind:'journey-explicitly-replaced',replacedBy:id},now);replacedIds.push(conflict.id);}
  else {pauseFocus(conflict,id,now);pausedIds.push(conflict.id);}
 }
 l.ownerTasks??=[];l.ownerTasks.push(task);bindPurposeContext(l,sessionId,context,task,now);
 if(background)l.round.ownerTaskId=id;
 purposeFulfillment(task);record(task,{kind:'journey-registered',goal,destination,arrivalStep,completionType,noWorldMutation:true},now);
 return {ok:true,task:clone(task),pausedIds,replacedIds};
}
// Only the host's current owner-prompt hook calls this. Historical chat text is never scanned on load.
export function rememberOwnerTurn(l,identity,{text,sessionId,turnKey,confirmedWorld=false},now){
 if(!sessionKey(sessionId))return null;
 const spec=directive(text),previous=ownerTaskContext(l,sessionId);
 const key=hash([sessionKey(sessionId),turnKey??null,String(text||'')]);
 if(previous?.key===key&&previous.taskId&&open(l.ownerTasks?.find(t=>t.id===previous.taskId)))return null;
 const context=setOwnerTaskContext(l,sessionId,{key,taskId:null,at:now,ownerText:String(text||'').slice(0,2000)});
 if(!/[？?]|吗/.test(text)&&/^(?:(?:你|请|今天|先|现在|那)[\s，,]*)*(?:别|不要|不用|不必|取消|停止).*(?:打(?:个)?工|上班|短工)/.test(text)){
  let cancelled=null;for(const task of l.ownerTasks||[])if(open(task)&&['work','work-items'].includes(task.kind)&&task.owner===identity.owner&&task.persona===identity.persona){task.status='cancelled';task.phase='cancelled';record(task,{kind:'owner-cancelled',instruction:String(text),sourceKey:key},now);cancelled=task;}return cancelled;
 }
 if(!spec)return null;
 // Unscoped requests such as making a report must not start fish-world model rounds.
 // Their current-turn purpose is activated only if that owner actually invokes a world mutation.
 if(!confirmedWorld&&['activity','buy','planning','work-items'].includes(spec.kind)&&!/(?:鱼的?世界|小镇|食堂|图书馆|书店|商店|超市|市集|夜市|摊|修车铺|咖啡店)/.test(text)){
  context.deferred={text:String(text),turnKey};return null;
 }
 l.ownerTasks??=[];
 const existing=l.ownerTasks.findLast(t=>open(t)&&t.instruction===text&&t.owner===identity.owner&&t.persona===identity.persona);
 if(existing){context.taskId=existing.id;existing.currentSessionId=sessionId;
  const focused=!spec.scheduled&&activateOwnerFocus(l,existing,sessionId,now);
  if(paused(existing))return existing;
  if(existing.phase==='waiting_evidence'||existing.phase==='blocked'&&existing.contractIssue?.code==='definition-attempt-limit'){existing.phase=!existing.finalAction&&existing.kind!=='planning'||existing.scheduleRequired&&!existing.notBefore?'needs_definition':'pending';existing.nextAt=Math.max(existing.notBefore||0,now+180000);existing.definitionAttempts=0;existing.definitionNextAt=existing.nextAt;delete existing.contractIssue;record(existing,{kind:'owner-renewed',sourceKey:key},now);return existing;}return focused?existing:null;}
 const id='owner-task-'+hash([identity,sessionKey(sessionId),key,now,l.ownerTasks.length]).slice(0,24);
 const task={id,revision:1,status:'active',phase:spec.scheduled||!spec.finalAction&&spec.kind!=='planning'?'needs_definition':'pending',scheduleRequired:spec.scheduled,kind:spec.kind,optional:spec.optional,priority:spec.optional?3:0,instruction:String(text),nextStep:String(text),
  owner:identity.owner,persona:identity.persona,originalPurpose:String(text),purposeSource:'owner-current',currentSessionId:sessionId,source:{kind:'current-owner-prompt',sessionId,key,at:now},createdAt:now,updatedAt:now,
  nextAt:spec.scheduled?0:now+180000,finalAction:spec.finalAction,steps:spec.finalAction?[{...clone(spec.finalAction),nextStep:String(text),waitFor:spec.kind==='work'?'settlement':'receipt'}]:[],stepIndex:0,completedSteps:[],receipts:[],history:[],checks:0};
 task.finalAction=task.steps.length?clone(task.steps[0]):null;if(task.kind==='planning')planningState(task,now);l.ownerTasks.push(task);if(!spec.scheduled)activateOwnerFocus(l,task,sessionId,now);purposeFulfillment(task);context.taskId=id;return task;
}
export function taskForExecution(l,exec){
 if(!sessionKey(exec.agent?.session?.id))return;
 const r=l.round,background=sameSession(r?.sessionId,exec.agent?.session?.id);
 const id=background?r.ownerTaskId:ownerTaskContext(l,exec.agent?.session?.id)?.taskId;
 const explicit=(l.ownerTasks||[]).find(t=>t.id===id&&sameScope(l,t)&&['active','completed'].includes(t.status));if(explicit||id)return explicit;
 const persistent=(l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&t.kind!=='planning'&&sameSession(taskSession(t),exec.agent.session.id)&&(!background||t.kind==='journey'&&t.journey.registeredRoundId===r.id));
 if(!background&&isMutation(exec.name,exec.arguments||{})){
  const exact=persistent.filter(t=>!paused(t)&&t.finalAction?.tool===exec.name&&matches(exec.arguments,t.finalAction.arguments));
  return exact.length===1?exact[0]:undefined;
 }
 if(persistent.length)return persistent.length===1?persistent[0]:undefined;
 // A task-* action identifies one real work item. Generic work/go/food must never reconcile by similarity.
 if(!background||exec.name!==WORLD+'do'||!/^task-\d+$/.test(exec.arguments?.id||''))return;
 const exact=(l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&t.kind==='work-items'&&t.finalAction?.tool===exec.name&&t.finalAction.arguments?.id===exec.arguments.id&&matches(exec.arguments,t.finalAction.arguments));
 return exact.length===1?exact[0]:undefined;
}
function record(task,event,now){task.history.push({at:now,...event});task.updatedAt=now;task.revision++;}
export function defineOwnerTask(l,input,{sessionId,background=false,taskId,now,data}){
 const task=(l.ownerTasks||[]).find(t=>t.id===input.id&&open(t)&&sameScope(l,t));
 if(!task||(background?task.id!==taskId||!sameSession(l.round?.sessionId,sessionId):ownerTaskContext(l,sessionId)?.taskId!==task.id&&!(task.kind==='journey'&&sameSession(taskSession(task),sessionId))))throw Error('不是当前主人任务');
 if(input.expectedRevision!==task.revision)throw Error('主人任务版本已变化，请使用当前快照');
 if(paused(task))throw Error('该目的已挂起，请先按原要求明确恢复，再定义未完成步骤');
 if(task.kind==='planning')throw Error('每日规划只提交本地次日计划，不登记世界动作作为完成凭据');
 if(uncertainTask(l,task))throw Error('仍有已提交步骤或未确认变更，先只读核对，不得替换或重复');
 if(input.action==='complete_observation'){
  if(task.kind!=='journey'||!(task.journey.completionType==='observe'||task.ownerCompletionType==='observe')||purchaseRequired(task)||task.journey.stage!=='arrival-purpose'||!task.journey.arrivedAt||task.phase!=='needs_definition')throw Error('仅已确认到达的观察目的可以用现场读取完成，实际行动仍须成功动作');
  const summary=requiredText(input.summary,'观察总结'),ids=input.evidenceIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!(l.journal||[]).some(row=>row.id===id&&row.tool===WORLD+'now'&&row.status==='confirmed'&&!row.isError&&sameSession(row.sessionId,sessionId)&&fresh(row.finishedAt||row.at,now)&&row.at>=Math.max(task.createdAt,task.journey.arrivedAt)&&(!background||row.round===l.round?.id))))throw Error('观察完成需要本会话／本轮到达后成功 world_now 的精确 evidenceIds');
  const latest=(l.journal||[]).findLast(row=>row.tool===WORLD+'now'&&row.status==='confirmed'&&!row.isError&&sameSession(row.sessionId,sessionId)&&(!background||row.round===l.round?.id));if(!ids.includes(latest?.id))throw Error('观察完成必须包含当前最新成功 world_now 的回执，不能回用旧到访资料');
  if(ids.some(id=>{const row=l.journal.find(row=>row.id===id),at=row.finishedAt||row.at,state=parseWorldNowActivity(row.result),location=state?.where?.text?.split(' · ',1)[0],label=task.destination?.label||task.journey.destinationName;if(state&&label&&(state.where.kind!=='place'||location!==label))return true;if(fresh(data?.at?.state,now)&&data.at.state>=at)return !exactPlace(data,task.journey.destination,now);return !label||state?.where?.kind!=='place'||location!==label;}))throw Error('当前所在地尚未确认与原目的地点一致；保留目的，不能用别处或旧到访资料结清');
  task.journey.observation={summary,evidenceIds:clone(ids),at:now,localOnly:true,communicationStatus:'not-claimed'};task.status='completed';task.phase='completed';task.completedAt=now;task.nextAt=0;purposeFulfillment(task);record(task,{kind:'observation-completed',summary,evidenceIds:clone(ids),localOnly:true,communicationStatus:'not-claimed'},now);return {ok:true,task:clone(task)};
 }
 if(input.action!==undefined&&input.action!=='define')throw Error('未知任务操作');
 if(task.kind==='journey'&&task.journey.stage==='outbound')throw Error('先完成已登记路程；到达后才根据现场登记后续真实步骤');
 if(task.scheduleRequired&&input.nextAt===undefined)throw Error('原始要求包含未来时间，必须明确保存 nextAt，不能默认为现在');
 if(['travelling','working','waiting_event','uncertain'].includes(task.phase))throw Error('仍有已提交步骤，先等待真实回执，不得替换或重复');
 const submitted=input.steps||[{tool:input.tool,arguments:input.arguments,nextStep:input.nextStep}];
 const steps=normalizeSteps(submitted);
 if(steps.some(step=>priorAction(task,step.tool,step.arguments)))throw Error('该动作在原会话已经有成功回执；先查任务journey.priorActions及完成通知，只登记未完成后续，不能重放旧动作或把旧回执当新分享');
 if(task.kind==='work'&&!task.completedSteps.some(s=>s.action.tool===WORLD+'do'&&s.action.arguments.id==='work')&&!steps.some(s=>s.tool===WORLD+'do'&&s.arguments.id==='work'))throw Error('打工任务必须包含 world_do(id=work)，吃饭或到达不能替代');
 if(task.kind==='work-items'){
  const current=(l.journal||[]).findLast(row=>row.tool===WORLD+'now'&&row.status==='confirmed'&&!row.isError&&sameSession(row.sessionId,sessionId)&&fresh(row.finishedAt||row.at,now)&&(!background||row.round===l.round?.id)),offered=taskOptions(current?.result);
  if(!offered.size)throw workItemDefinitionError('当前没有可核对的真实 task-* 班内选项；保留原请求等待，不要改成 work 重新上班或改参数重试，请正常结束本轮','OWNER_WORK_ITEMS_WAIT',true);
  if(!steps.some(step=>step.tool===WORLD+'do'&&/^task-\d+$/.test(step.arguments.id||''))||steps.some(step=>step.tool===WORLD+'do'&&(!/^task-\d+$/.test(step.arguments.id||'')||!offered.has(step.arguments.id))))throw workItemDefinitionError('班内工作必须从当前 world_now 的真实 task-* 选项定义，不能替换为重新接班；本轮不要改参数猜测，请正常结束','OWNER_WORK_ITEMS_INVALID_ACTION');
 }
 if(input.nextAt!==undefined&&(!Number.isFinite(input.nextAt)||input.nextAt<now))throw Error('nextAt 需要未来的13位毫秒时间');
 if(steps.some(s=>task.completedSteps.some(done=>done.action.tool===s.tool&&matches(s.arguments,done.action.arguments))))throw Error('已完成步骤不能重新登记；只细化尚未完成的后续步骤');
 task.steps=[...task.steps.slice(0,task.stepIndex),...steps];task.finalAction=clone(steps[0]);task.nextStep=steps[0].nextStep;task.nextAt=input.nextAt??Math.max(task.nextAt,now);task.notBefore=input.nextAt??0;
 task.definitionAttempts=0;task.definitionNextAt=0;delete task.contractIssue;
 if(task.kind==='journey'){task.lastCheckedAt=0;task.journey.definedAt=now;task.journey.stageVersion=(task.journey.stageVersion||0)+1;}
 if(['needs_definition','blocked','waiting_evidence'].includes(task.phase))task.phase='pending';
 record(task,{kind:'defined',finalAction:clone(task.finalAction),nextStep:task.nextStep},now);return {ok:true,task:clone(task)};
}
function purchaseRequired(task){
 const original=typeof task.originalPurpose==='string'&&task.originalPurpose.trim()?task.originalPurpose:task.instruction;
 if(task.kind!=='buy'&&!task.originalPurpose||typeof original!=='string'||!/(?:买|购买|采购|采买)/.test(original))return false;
 return !(/[？?]|买不买|要不要买|能不能买|哪里买|怎么买|是否.{0,4}买|(?:别|不要|不用|不必|无需|不想|暂不|先不).{0,6}买|不是.{0,8}(?:让|叫).{0,4}买/.test(original)||/(?:如果|要是|看情况|再决定)|(?:有|遇到|找到|觉得).{0,12}(?:合适|中意|喜欢|需要).{0,8}(?:再|才|就)?买|(?:合适|中意|喜欢|想买).{0,5}再买/.test(original));
}
function purposeFulfillment(task,evidenceIds=[]){
 const old=task.fulfillment?.version===1?task.fulfillment:null,ids=[...new Set([...(old?.purchaseSucceeded?old.purchaseEvidenceIds||[]:[]),...evidenceIds].filter(id=>typeof id==='string'&&id.length>0&&id.length<=200))];
 return task.fulfillment={version:1,purchaseRequired:purchaseRequired(task),purchaseSucceeded:ids.length>0,purchaseEvidenceIds:ids,executionPending:task.status==='active'};
}
function refreshPurchaseEvidence(l,task,now){
 const ids=(l.journal||[]).filter(row=>row.ownerTaskId===task.id&&(row.owner===undefined||row.owner===task.owner)&&(row.persona===undefined||row.persona===task.persona)&&Number.isFinite(row.at)&&row.at>=task.createdAt&&row.at<=now&&purchaseReceipt(row)).map(row=>row.id);
 return purposeFulfillment(task,ids);
}
function completedPrefixProved(l,task,now){
 if(!Array.isArray(task.steps)||!task.steps.length||task.stepIndex!==task.steps.length||!Array.isArray(task.completedSteps)||task.completedSteps.length!==task.steps.length)return false;
 const seen=new Set();return task.completedSteps.every((step,index)=>{
  const action=step.action,expected=task.steps[index],args=action?.arguments;
  if(step.index!==index||!action||action.tool!==expected.tool||!sameAction(args,expected.arguments)||!step.callId||seen.has(step.callId))return false;seen.add(step.callId);
  const row=(l.journal||[]).find(row=>row.id===step.callId&&row.ownerTaskId===task.id&&(row.owner===undefined||row.owner===task.owner)&&(row.persona===undefined||row.persona===task.persona)&&row.tool===action.tool&&row.status==='confirmed'&&!row.isError&&Number.isFinite(row.at)&&row.at>=task.createdAt&&Number.isFinite(row.finishedAt)&&row.finishedAt>=row.at&&row.finishedAt<=task.completedAt&&Number.isFinite(step.at)&&step.at>=row.finishedAt&&step.at<=task.completedAt&&sameAction(parse(row.args)||{},args));
  if(!row)return false;
  if(step.eventId){const event=(l.queue||[]).find(event=>event.id===step.eventId&&event.provenance?.trusted&&event.provenance.source==='world-notify'&&Number.isFinite(event.t)&&event.t>=row.at&&event.t<=now);if(!event||event.kind!==(action.tool===WORLD+'go'?'arrive':'done'))return false;}
  else if(action.tool===WORLD+'go'){
   const immediate=/^好的[，,。]\s*你(?:走进了|走到了|来到了|回到了)[^。！\n]+[。！]?/.test(row.result||'');
   if(!immediate&&!(step.stateAt&&task.arrivalState?.at===step.stateAt&&task.arrivalState.placeId===args.place))return false;
  }else if(['done','settlement'].includes(action.waitFor)||step.activity)return false;
  return true;
 });
}
/** Keep execution receipts separate from the original purpose's required purchase outcome. */
export function reconcilePurposeFulfillment(l,now){
 const reopenedIds=[];let changed=0;if(!l.owner||!l.persona)return {changed,reopenedIds};
 for(const task of l.ownerTasks||[]){
  if(task.owner!==l.owner||task.persona!==l.persona||!Number.isFinite(task.createdAt)||task.createdAt<=0||task.createdAt>now)continue;
  if(open(task)){if(purchaseRequired(task)||task.fulfillment){const before=JSON.stringify(task.fulfillment);refreshPurchaseEvidence(l,task,now);if(JSON.stringify(task.fulfillment)!==before)changed++;}continue;}
  if(task.status!=='completed'||!purchaseRequired(task)||!Number.isFinite(task.completedAt)||task.completedAt<task.createdAt||task.completedAt>now||day(task.completedAt)!==day(now)||uncertainTask(l,task)||!completedPrefixProved(l,task,now))continue;
  const fulfillment=refreshPurchaseEvidence(l,task,now);if(fulfillment.purchaseSucceeded)continue;
  const completedAt=task.completedAt;task.status='active';task.phase='needs_definition';task.nextAt=0;task.finalAction=null;task.definitionAttempts=0;task.definitionNextAt=0;task.lastCheckedAt=0;task.focus={state:'paused',pausedAt:now,reason:'required-purchase-unproved'};delete task.completedAt;
  task.contractIssue={code:'required-purchase-unproved',at:now,requiresActualPurchase:true};purposeFulfillment(task);record(task,{kind:'required-purchase-restored',previousCompletedAt:completedAt,previousStatus:'completed',localOnly:true,noReplay:true},now);reopenedIds.push(task.id);changed++;
 }
 return {changed,reopenedIds};
}
function finishStep(task,evidence,now){
 task.completedSteps.push({index:task.stepIndex,action:clone(task.steps[task.stepIndex]),at:now,...task.activity?{activity:clone(task.activity)}:{},...evidence});task.stepIndex++;delete task.activity;
 if(task.kind==='journey'&&task.journey.stage==='outbound'){task.journey.stage='arrival-purpose';task.journey.arrivedAt=now;task.journey.arrivalEvidence=clone(evidence);task.finalAction=null;task.nextStep=task.journey.arrivalStep;task.phase='needs_definition';task.nextAt=now;task.definitionAttempts=0;task.definitionNextAt=now;return;}
 const next=task.steps[task.stepIndex];task.finalAction=next?clone(next):null;task.nextStep=next?.nextStep||task.nextStep;
 const fulfillment=purposeFulfillment(task);
 if(next){task.phase='pending';task.nextAt=now;}else if(fulfillment.purchaseRequired&&!fulfillment.purchaseSucceeded){task.phase='needs_definition';task.nextAt=0;task.definitionAttempts=0;task.definitionNextAt=0;task.lastCheckedAt=0;task.contractIssue={code:'required-purchase-unproved',at:now,requiresActualPurchase:true};}
 else{task.status='completed';task.phase='completed';task.completedAt=now;task.nextAt=0;}purposeFulfillment(task);
}
export function ownerTaskGuard(l,data,exec,background,now){
 // Task progress is advisory. Only an unresolved operation can deny its own replay.
 return unknownWorldMutationGuard(l,exec);
}
export function noteOwnerTaskResult(l,data,entry,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===entry.ownerTaskId&&open(t)&&sameScope(l,t));if(!task)return;
 const args=parse(entry.args)||{};
 if(entry.status==='uncertain'){
  if(!isMutation(entry.tool,args))return;
  task.phase='uncertain';l.recovery=true;record(task,{kind:'uncertain',callId:entry.id,tool:entry.tool,noReplay:true},now);return;
 }
 if(entry.status==='failed'){
  if(fullRule(entry)&&task.kind==='work'&&entry.tool===task.finalAction?.tool&&matches(args,task.finalAction.arguments)){waitAvailability(task,entry,now);return;}
  if(isMutation(entry.tool,args)&&!knownWorldRejection(entry)){task.phase='uncertain';task.nextAt=0;l.recovery=true;record(task,{kind:'unknown-failure',callId:entry.id,noReplay:true},now);}
  return;
 }
 if(entry.status!=='confirmed')return;
 if(purchaseReceipt(entry))refreshPurchaseEvidence(l,task,now);
 if(task.availability?.checkOnly&&entry.tool===WORLD+'now'){
  const work=(entry.result||'').split('\n').find(line=>/^·\s+work\b/.test(line)),capacity=work&&/(\d+)\s*\/\s*(\d+)/.exec(work),closed=/(?:人手够了|满员|名额已满|岗位已满)/.test(work||'')||capacity&&Number(capacity[1])>=Number(capacity[2]);
  task.availability.checks++;task.availability.lastCheckedAt=now;task.availability.checkCallId=entry.id;
  if(work&&!closed){task.availability.checkOnly=false;task.phase='pending';task.nextAt=now+180000;task.notBefore=task.nextAt;record(task,{kind:'availability-open',callId:entry.id,nextAt:task.nextAt},now);}
  else{task.phase='blocked';task.nextAt=availabilityTime(entry,now,task.availability.checks);record(task,{kind:'availability-check',callId:entry.id,nextAt:task.nextAt,noReplay:true},now);}
  return;
 }
 const final=task.finalAction,receipt={id:entry.id,tool:entry.tool,at:entry.finishedAt||now};
 if(entry.tool===WORLD+'go'){
  if(/^(?:去[^\n]{1,120}有\s*\d+\s*种走法|[^\n]*world_go 时 by 填其中一个)/.test(entry.result||''))return;
  const arrival=/(\d{1,2}:\d{2})\s*到([^。；\n]+?)(?:[。；\n]|$)/.exec(entry.result||'');
  const immediate=/^好的[，,。]\s*你(?:走进了|走到了|来到了|回到了)([^。！\n]+)[。！]?/.exec(entry.result||'');
  if(task.kind==='journey'&&!arrival&&!immediate){task.phase='uncertain';l.recovery=true;record(task,{kind:'travel-evidence-missing',callId:entry.id,noReplay:true},now);return;}
  task.travelCompletesStep=final?.tool===entry.tool&&matches(args,final.arguments);task.destination={id:args.place,label:arrival?.[2]?.trim()||null};task.travelCallId=entry.id;task.travelAt=now;task.phase='travelling';task.nextAt=0;
  if(immediate){task.destination.label=immediate[1].trim();task.receipts.push(receipt);if(task.travelCompletesStep)finishStep(task,{callId:entry.id,kind:'immediate-arrival'},now);else{task.phase='ready';task.nextAt=now;}record(task,{kind:'arrived-immediately',callId:entry.id,purposeStillPending:open(task)},now);return;}
  task.receipts.push(receipt);record(task,{kind:'travel',destination:clone(task.destination),callId:entry.id,purpose:task.instruction,nextStep:task.nextStep},now);return;
 }
 if(final&&entry.tool===final.tool&&matches(args,final.arguments)){
  task.receipts.push(receipt);task.finalActionCallId=entry.id;
  const finite=entry.tool===WORLD+'do'?finiteActivityFromReceipt(entry.result,{actionId:args.id,count:args.count}):null;
  if(final.waitFor==='settlement'){task.phase='working';task.nextAt=0;}
  else if(final.waitFor==='done'||finite){task.phase='waiting_event';task.nextAt=0;task.activity={label:finite?.label||null,startCallId:entry.id,startedAt:entry.at||entry.finishedAt||now,...finite||{},...(final.eventText?{eventText:final.eventText}:{})};}
  else finishStep(task,{callId:entry.id},now);
  record(task,{kind:final.waitFor==='settlement'?'started-work':task.phase==='waiting_event'?'activity-started':'action-confirmed',callId:entry.id},now);
  if(task.phase==='waiting_event')reconcileActivityEvents(l,now);
 }
}
function arrived(task,event){return event.kind==='arrive'&&task.destination?.label&&event.text==='到了'+task.destination.label&&event.t>=task.travelAt;}
function activityDone(task,event,now){
 if(event.kind!=='done'||!event.provenance?.trusted||event.provenance.source!=='world-notify'||!Number.isFinite(event.t)||event.t>now||event.t<(task.activity?.startedAt??task.updatedAt))return false;
 if(task.activity?.ambiguous||typeof event.text!=='string'||/没(?:有)?(?:吃完|读完|做完)|未(?:吃完|读完|做完|完成)|还没|中断|烧糊|停了下来|提前走了|没顾上/.test(event.text))return false;
 const exact=task.activity?.eventText||task.finalAction?.eventText;
 if(exact)return event.text===exact;
 const completion=task.activity?.completion;
 if(completion?.kind==='cooking'){const cooked=/^做好了：(.+?)(?:\s+([1-9]\d*)\s*份)?(?:[，,。！!]|$)/.exec(event.text);return !!cooked&&cooked[1].trim()===completion.dish&&Number(cooked[2]||1)===completion.count;}
 const label=task.activity?.label;
 return !!label&&(event.text.startsWith(label+'：')||event.text===label+'结束了'||label.startsWith('吃一顿')&&event.text.startsWith(label)&&/^，又加一份[^：\r\n]{1,200}：/.test(event.text.slice(label.length)));
}
function reconcileActivityEvents(l,now){
 let changed=0;
 for(const event of l.queue||[]){
  const waiting=(l.ownerTasks||[]).filter(task=>open(task)&&sameScope(l,task)&&task.phase==='waiting_event'&&task.activity&&activityDone(task,event,now));
  if(waiting.length!==1)continue;
  const task=waiting[0],revision=task.revision;linkOwnerTaskEvent(l,event,now);if(task.revision!==revision)changed++;
 }
 return changed;
}
export function linkOwnerTaskEvent(l,event,now){
 const ids=[],completed=[];
 const activityMatches=(l.ownerTasks||[]).filter(task=>open(task)&&sameScope(l,task)&&task.phase==='waiting_event'&&activityDone(task,event,now));
 for(const task of l.ownerTasks||[]){
  if(!open(task)||!sameScope(l,task)||!event.provenance?.trusted||event.t<task.createdAt)continue;
  if(task.phase==='travelling'&&arrived(task,event)){
   task.phase='ready';task.nextAt=now;task.arrivalEventId=event.id;if(task.travelCompletesStep)finishStep(task,{eventId:event.id,callId:task.travelCallId},now);record(task,{kind:'arrived',eventId:event.id,purposeStillPending:open(task)},now);if(open(task))ids.push(task.id);else if(task.kind==='journey'&&task.status==='completed')completed.push({taskId:task.id,goal:task.journey.goal,receiptIds:task.receipts.map(receipt=>receipt.id).slice(-8)});
  }else if(task.phase==='working'&&event.kind==='done'&&event.t>=task.updatedAt&&/^(?:下班|工作结算|班次结算)/.test(event.text)){
   task.settlementEventId=event.id;finishStep(task,{eventId:event.id,callId:task.finalActionCallId},now);record(task,{kind:'settled',eventId:event.id,workCallId:task.finalActionCallId},now);if(open(task))ids.push(task.id);
  }else if(task.phase==='waiting_event'&&activityMatches.includes(task)&&activityMatches.length===1){
   finishStep(task,{eventId:event.id,callId:task.finalActionCallId},now);record(task,{kind:'activity-finished',eventId:event.id},now);if(open(task))ids.push(task.id);else completed.push({taskId:task.id,goal:task.journey?.goal||task.instruction,receiptIds:task.receipts.map(receipt=>receipt.id).slice(-8)});
  }
 }
 if(ids.length){event.ownerTaskIds=ids;event.status='pending';event.notBefore=now;}
 if(completed.length){event.completedOwnerTaskIds=completed.slice(0,3).map(item=>item.taskId);event.completedPurpose=completed[0];event.status='pending';event.notBefore=now;}
}
export function advanceOwnerTasks(l,data,now){
 const at=data.at?.state||0;if(at<now-180000||at>now)return;
 for(const task of l.ownerTasks||[]){
  const where=data.state?.where,reached=!!task.destination?.id&&(where?.place?.id===task.destination.id||where?.kind==='home'&&task.destination.id==='home');
  if(!open(task)||!sameScope(l,task)||task.phase!=='travelling'||at<task.travelAt||where?.kind==='trip'||!reached)continue;
  task.phase='ready';task.nextAt=now;task.arrivalState={at,placeId:task.destination.id};if(task.travelCompletesStep)finishStep(task,{stateAt:at,callId:task.travelCallId},now);record(task,{kind:'arrived-state',stateAt:at,purposeStillPending:open(task)},now);
 }
}
export function ownerTaskCandidates(l,now,data={}){
 const advisory=t=>t.kind!=='planning'&&!t.availability?.checkOnly&&(t.phase==='needs_definition'||t.phase==='waiting_evidence'||t.phase==='blocked'&&((t.definitionAttempts||0)>=3||['definition-attempt-limit','required-purchase-unproved'].includes(t.contractIssue?.code)));
 return (l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&!paused(t)&&!uncertainTask(l,t)&&!(t.notBefore>now)&&((advisory(t)&&!(t.notBefore>now)&&(t.kind!=='work-items'||currentWorkItems(l,data,now))&&(!t.lastCheckedAt||now-t.lastCheckedAt>=600000))||(['pending','ready'].includes(t.phase)||t.phase==='blocked'&&t.availability?.checkOnly)&&t.nextAt>0&&t.nextAt<=now)&&(!t.optional||!data.state?.doing&&data.state?.where?.kind!=='trip'&&!(l.ownerTasks||[]).some(other=>other.id!==t.id&&open(other)&&ownerTaskInFlight(other))))
 .sort((a,b)=>b.createdAt-a.createdAt).map(t=>({id:t.id,kind:'owner-task',ownerTaskId:t.id,optional:t.optional,priority:t.priority??0,bucket:['work','work-items'].includes(t.kind)?'work':'idle',definitionOnly:false,planningOnly:t.kind==='planning',readOnly:!!t.availability?.checkOnly,text:t.instruction,group:(l.queue||[]).filter(q=>q.ownerTaskIds?.includes(t.id)&&['pending','blocked'].includes(q.status))}));
}
export function ownerTaskSnapshot(l,round){
 const tasks=(l.ownerTasks||[]).filter(t=>open(t)&&sameScope(l,t)&&(!round?.ownerTaskId||t.id===round.ownerTaskId||paused(t))).sort((a,b)=>Number(b.id===round?.ownerTaskId)-Number(a.id===round?.ownerTaskId)||Number(paused(a))-Number(paused(b))||b.createdAt-a.createdAt).slice(0,3);
 return tasks.map(t=>Object.fromEntries(['id','revision','status','phase','kind','instruction','originalPurpose','purposeSource','ownerCompletionType','focus','fulfillment','nextStep','nextAt','notBefore','finalAction','steps','stepIndex','completedSteps','destination','arrivalEventId','arrivalState','finalActionCallId','source','availability','planning','journey','activity','definitionAttempts','definitionNextAt','contractIssue'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])));
}
export function ownerTaskPlanningComplete(l,round,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&open(t)&&sameScope(l,t)&&t.kind==='planning');if(!task)return {completed:false};
 const state=planningState(task,now),instance=state.day;if(state.completed?.[instance]||Object.values(state.completed||{}).some(item=>item.roundId&&item.roundId===round.id))return {completed:false,alreadyCompleted:true};
 const committed=(l.planHistory||[]).filter(row=>row.roundId===round.id&&row.at>=round.startedAt&&row.at<=now),plans=planningPlans(l,task,instance,committed,now);
 if(!plans.length)return {completed:false,day:instance,issue:'missing-next-day-executable-plans'};
 const completed=completePlanning(task,plans,instance,now,round.id);return {completed,day:instance,planIds:plans.map(plan=>plan.id),nextAt:task.nextAt};
}
/** Repair only the known global-plan cancellation of a recurring local obligation. */
export function reconcilePlanningObligations(l,now){
 const restoredIds=[];
 for(const task of [...l.ownerTasks||[]].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))){
  if(task.status!=='cancelled'||task.kind!=='planning'||!sameScope(l,task)||!dailyPlanning(task.instruction)||uncertainTask(l,task))continue;
  if((l.ownerTasks||[]).some(other=>open(other)&&sameScope(l,other)&&other.kind==='planning'&&dailyPlanning(other.instruction)))break;
  const last=task.history?.at(-1),reason=String(last?.instruction||'');
  if(last?.kind!=='owner-changed-plan'||!/(?:去|出门|回家|逛|吃饭|白米饭|采购|买)/.test(reason)||/(?:取消|停止|不要|不用|不必|别|每天|每晚|每日|规划|23\s*[:：]\s*45)/.test(reason))continue;
  if((l.ownerInstructions||[]).some(row=>row.at>last.at&&/(?:取消|停止|不要|不用|不必|别).*(?:每天|每晚|每日|规划|23\s*[:：]\s*45)/.test(row.text||'')))continue;
  let instance=day(now);if(planningAt(instance)<=now)instance=shiftDay(instance,1);
  const state=planningState(task,now);state.day=instance;state.businessDay=shiftDay(instance,1);state.restoredAt=now;
  task.status='active';task.phase='pending';task.nextAt=planningAt(instance);task.notBefore=0;task.finalAction=null;task.steps=[];
  record(task,{kind:'recurring-planning-restored',cancelledAt:last.at,reason:'legacy-global-plan-cancel',futureOnly:true,noHistoricalShare:true,localOnly:true,communicationStatus:'not-claimed'},now);restoredIds.push(task.id);
 }
 return {changed:restoredIds.length,restoredIds};
}
/** Repair only a fully proved read-only freeze; never infer an action or its former phase. */
export function reconcileReadonlyOwnerTaskFailures(l,now){
 const recoveredIds=[],journal=l.journal||[];
 const scoped=row=>(row.owner===undefined||row.owner===l.owner)&&(row.persona===undefined||row.persona===l.persona);
 const read=row=>{const args=parse(row.args);return args&&typeof args==='object'&&!Array.isArray(args)&&(['now','profile','history','find','guide'].some(tool=>row.tool===WORLD+tool)||row.tool===WORLD+'friends'&&args.action==='list');};
 const time=row=>row.finishedAt??row.at;
 if(!l.owner||!l.persona)return {changed:0,recoveredIds};
 for(const task of l.ownerTasks||[]){
  if(!open(task)||task.phase!=='uncertain'||task.owner!==l.owner||task.persona!==l.persona||!Number.isFinite(task.createdAt)||task.createdAt<=0||task.createdAt>now)continue;
  const history=task.history||[],causal=history.filter(event=>['uncertain','unknown-failure','travel-evidence-missing'].includes(event.kind));
  if(!causal.length||causal.some(event=>event.kind!=='uncertain'))continue;
  const ownedSession=row=>sameSession(row.sessionId,taskSession(task))||sameSession(row.sessionId,task.currentSessionId)||row.round&&(l.contextWindow?.windows||[]).some(window=>sameSession(window.sessionId,row.sessionId));
  const causes=causal.map(event=>journal.find(row=>row.id===event.callId&&row.ownerTaskId===task.id&&row.tool===event.tool&&scoped(row)&&read(row)&&['uncertain','failed'].includes(row.status)&&row.isError!==false&&sessionKey(row.sessionId)&&ownedSession(row)&&Number.isFinite(row.at)&&row.at>=task.createdAt&&Number.isFinite(time(row))&&time(row)>=row.at&&time(row)<=now&&Number.isFinite(event.at)&&event.at>=time(row)&&event.at<=now));
  if(causes.some(row=>!row))continue;
  if(journal.some(row=>unknownMutation(row)&&(row.ownerTaskId===task.id||!row.ownerTaskId&&causes.some(cause=>sameSession(row.sessionId,cause.sessionId))&&(!Number.isFinite(row.at)||row.at>=task.createdAt))))continue;
  const reads=causes.map(cause=>journal.find(row=>row.id!==cause.id&&row.tool===cause.tool&&sameSession(row.sessionId,cause.sessionId)&&(!row.ownerTaskId||row.ownerTaskId===task.id)&&scoped(row)&&read(row)&&row.status==='confirmed'&&!row.isError&&typeof row.result==='string'&&!!row.result.trim()&&Number.isFinite(row.at)&&row.at>time(cause)&&Number.isFinite(time(row))&&time(row)>=row.at&&time(row)<=now));
  if(reads.some(row=>!row))continue;
  const previousNextAt=task.nextAt;task.phase='waiting_evidence';task.nextAt=0;
  record(task,{kind:'readonly-failure-reconciled',causeCallIds:[...new Set(causes.map(row=>row.id))],readCallIds:[...new Set(reads.map(row=>row.id))],previousPhase:'uncertain',previousNextAt,restoredPhase:'waiting_evidence',phaseEvidence:'original-phase-not-proven',localOnly:true,noReplay:true},now);
  recoveredIds.push(task.id);
 }
 return {changed:recoveredIds.length,recoveredIds};
}
/** Reclassify only exact, proved non-executed rule failures; original results stay immutable. */
export function reconcileKnownOwnerTaskFailures(l,now){
 const recoveredIds=[],journal=l.journal||[];
 if(!l.owner||!l.persona||!Number.isFinite(now)||now<=0)return {changed:0,recoveredIds};
 const scoped=row=>(row.owner===undefined||row.owner===l.owner)&&(row.persona===undefined||row.persona===l.persona);
 for(const task of l.ownerTasks||[]){
  if(!open(task)||task.phase!=='uncertain'||task.owner!==l.owner||task.persona!==l.persona||!Number.isFinite(task.createdAt)||task.createdAt<=0||task.createdAt>now)continue;
  const resolved=new Set((task.history||[]).filter(event=>['readonly-failure-reconciled','known-rejection-reconciled'].includes(event.kind)).flatMap(event=>event.causeCallIds||[]));
  const causal=(task.history||[]).filter(event=>['uncertain','unknown-failure','travel-evidence-missing'].includes(event.kind)&&!resolved.has(event.callId));
  if(!causal.length||causal.some(event=>event.kind!=='unknown-failure'))continue;
  const ownedSession=row=>sameSession(row.sessionId,taskSession(task))||sameSession(row.sessionId,task.currentSessionId)||row.round&&(l.contextWindow?.windows||[]).some(window=>sameSession(window.sessionId,row.sessionId));
  const causes=causal.map(event=>journal.find(row=>row.id===event.callId&&row.ownerTaskId===task.id&&scoped(row)&&ownedSession(row)&&knownWorldRejection(row)&&isMutation(row.tool,rowArguments(row)||{})&&Number.isFinite(row.at)&&row.at>=task.createdAt&&Number.isFinite(row.finishedAt)&&row.finishedAt>=row.at&&row.finishedAt<=now&&Number.isFinite(event.at)&&event.at>=row.finishedAt&&event.at<=now));
  if(causes.some(row=>!row))continue;
  if(journal.some(row=>unknownMutation(row)&&(row.ownerTaskId===task.id||!row.ownerTaskId&&causes.some(cause=>sameSession(row.sessionId,cause.sessionId))&&(!Number.isFinite(row.at)||row.at>=task.createdAt))))continue;
  const previousNextAt=task.nextAt;task.phase='waiting_evidence';task.nextAt=0;
  record(task,{kind:'known-rejection-reconciled',causeCallIds:[...new Set(causes.map(row=>row.id))],classification:'known-not-executed',previousPhase:'uncertain',previousNextAt,restoredPhase:'waiting_evidence',localOnly:true,noReplay:true},now);recoveredIds.push(task.id);
 }
 return {changed:recoveredIds.length,recoveredIds};
}
/** Idempotent local reconciliation of existing task records, never a scan of historical chat. */
export function reconcileOwnerTasks(l,data,now){
 let changed=reconcileKnownOwnerTaskFailures(l,now).changed+reconcileReadonlyOwnerTaskFailures(l,now).changed+reconcilePurposeFulfillment(l,now).changed+reconcilePlanningObligations(l,now).changed;
 for(const task of l.ownerTasks||[]){
  if(!open(task)||!sameScope(l,task)||uncertainTask(l,task))continue;
  task.history??=[];task.receipts??=[];task.completedSteps??=[];task.steps??=[];
  if(task.kind==='journey')continue;
  if(dailyPlanning(task.instruction)&&!['travelling','working','waiting_event'].includes(task.phase)&&!task.completedSteps.length&&!task.receipts.length){
   if(task.kind!=='planning'){
    task.previousContract??={kind:task.kind,phase:task.phase,nextAt:task.nextAt,finalAction:clone(task.finalAction),steps:clone(task.steps)};
    task.kind='planning';task.phase='pending';task.scheduleRequired=false;task.finalAction=null;task.steps=[];planningState(task,now);record(task,{kind:'local-planning-contract',noWorldMutation:true},now);changed++;
   }
   const state=planningState(task,now);if(state.restoredAt&&now<planningAt(state.day))continue;
   const existing=(l.planHistory||[]).filter(row=>day(row.at)===state.day&&(!state.restoredAt||row.at>=state.restoredAt)),plans=planningPlans(l,task,state.day,existing,now);
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
  if(task.kind!=='planning'&&task.phase==='pending'&&!task.finalAction&&!task.steps.length&&!task.receipts.length&&!task.completedSteps.length){task.phase='needs_definition';record(task,{kind:'empty-contract-needs-definition',noWorldMutation:true},now);changed++;}
 }
 return {changed:changed+reconcileActivityEvents(l,now)};
}
export function endOwnerTaskRound(l,round,valid,now){
 const task=(l.ownerTasks||[]).find(t=>t.id===round.ownerTaskId&&open(t)&&sameScope(l,t));if(!task)return;
 if(round.id&&task.lastEndedRoundId===round.id)return;task.lastEndedRoundId=round.id;
 const defined=task.history.findLast(event=>event.kind==='defined');
 task.checks++;task.lastCheckedAt=round.definitionOnly&&task.phase==='pending'&&defined?.at>=round.startedAt&&defined.at<=now?0:now;
 if(task.kind==='planning'){
  planningState(task,now);
  const result=valid?ownerTaskPlanningComplete(l,round,now):{completed:false};
  if(!result.completed&&!result.alreadyCompleted){task.phase='pending';task.nextAt=Math.max(task.nextAt||0,now+600000);task.planning.lastIssue=result.issue||'round-not-completed';}
  return;
 }
 if(round.definitionOnly){
  if(resumedDefinition(task)){task.focus.definitionCheckedAt=now;record(task,{kind:'resumed-definition-held',roundId:round.id,localOnly:true,noWorldMutation:true},now);return;}
  if(task.phase==='needs_definition'){
   task.definitionAttempts=(task.definitionAttempts||0)+1;task.definitionNextAt=now+Math.min(3600000,600000*2**Math.min(2,task.definitionAttempts-1));task.nextAt=task.definitionNextAt;
   if(task.definitionAttempts>=3){task.phase='blocked';task.nextAt=0;task.contractIssue={code:'definition-attempt-limit',at:now,requiresOwnerClarification:true};}
   record(task,{kind:'definition-incomplete',roundId:round.id,attempts:task.definitionAttempts,nextAt:task.nextAt,noWorldMutation:true},now);
  }
  return;
 }
 if(task.availability?.checkOnly||task.availability?.lastCheckedAt>=round.startedAt)return;
 if(valid&&['pending','ready'].includes(task.phase)){
  const defined=task.history.findLast(event=>event.kind==='defined');
  if(!uncertainTask(l,task)&&defined?.at>=round.startedAt&&defined.at<=now&&task.notBefore>now&&task.nextAt>=task.notBefore){task.phase='pending';return;}
  if(task.completedSteps.some(s=>s.at>=round.startedAt)){task.nextAt=Math.max(task.nextAt,now+180000);return;}
  task.phase='waiting_evidence';task.nextAt=0;record(task,{kind:'no-task-progress',roundId:round.id,summary:round.report?.summary,noReplay:true},now);
 }
}
