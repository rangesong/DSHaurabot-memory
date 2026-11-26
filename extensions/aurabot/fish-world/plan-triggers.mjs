const eventKinds=new Set(['talk','message','note','friend_request','encounter','work','doorbell','health','done','arrive','feed','like']);
const socialKinds=['talk','message','note','friend_request'];
const terminal=new Set(['completed','expired','cancelled','abandoned','superseded','merged']);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256;
const absolute=value=>Number.isSafeInteger(value)&&value>=1000000000000&&value<=8640000000000000?value:0;
const unique=values=>[...new Set(values)];
const day=value=>new Date(value+28800000).toISOString().slice(0,10);
function eventCondition(value){
 if(!record(value)||value.kind!=='event')return null;
 const kinds=value.eventKinds??(value.eventKind?[value.eventKind]:[]),subjects=value.subjects??(value.subject?[value.subject]:[]);
 if(!Array.isArray(kinds)||kinds.length>12||kinds.some(kind=>!eventKinds.has(kind))||!Array.isArray(subjects)||subjects.length>8||subjects.some(subject=>!text(subject))||value.eventId!==undefined&&!text(value.eventId)||!kinds.length&&!value.eventId||value.after!==undefined&&value.after!==0&&!absolute(value.after)||value.trustedOnly!==undefined&&typeof value.trustedOnly!=='boolean')return null;
 return {kind:'event',...(value.eventId?{eventId:value.eventId}:{}),...(kinds.length===1?{eventKind:kinds[0]}:kinds.length?{eventKinds:unique(kinds)}:{}),...(subjects.length===1?{subject:subjects[0]}:subjects.length?{subjects:unique(subjects)}:{}),...(value.after?{after:value.after}:{}),...(value.trustedOnly!==undefined?{trustedOnly:value.trustedOnly}:{})};
}
function condition(value){
 if(!record(value))return null;
 if(value.kind==='time'&&absolute(value.at))return {kind:'time',at:value.at};
 if(value.kind==='state'&&Object.keys(value).every(key=>['kind','when'].includes(key))&&(value.when===undefined||value.when==='idle'))return {kind:'state',...(value.when?{when:value.when}:{})};
 return eventCondition(value);
}
function socialCondition(plan,life,now){
 const ids=new Set(plan.sourceEventIds||[]),sources=(life.queue||[]).filter(q=>ids.has(q.id)&&socialKinds.includes(q.kind)&&q.provenance?.trusted===true&&q.provenance.source==='world-notify'&&text(q.sender));
 const subjects=unique(sources.map(q=>q.sender));if(!subjects.length||subjects.length>8)return null;
 return eventCondition({kind:'event',eventKinds:[...socialKinds],...(subjects.length===1?{subject:subjects[0]}:{subjects}),trustedOnly:true,after:Math.max(now,...sources.map(q=>absolute(q.t)||0))});
}
/** Explicit business target; relative days use creation time, never check time. */
export function planBusinessAt(plan){
 const goal=String(plan.goal||'');
 let target=absolute(plan.businessAt)||absolute(plan.semanticIdentity?.window?.businessAt);
 if(!target&&absolute(plan.createdAt)&&/(?:明天|次日)/.test(goal))target=Date.parse(day(plan.createdAt)+'T00:00:00+08:00')+86400000;
 if(!target&&absolute(plan.createdAt)){
  const m=/(?:(20\d{2})-)?(\d{1,2})-(\d{1,2})(?!\d)/.exec(goal);
  if(m){const date=`${m[1]||day(plan.createdAt).slice(0,4)}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,parsed=Date.parse(date+'T00:00:00+08:00');if(Number.isFinite(parsed)&&day(parsed)===date)target=parsed;}
 }
 return target||0;
}
// Identity windowEnd is not a deadline. Only explicit elapsed daily overviews
// are held; real unfinished action chains retain their continuation contract.
function staleOverview(plan,life,now){
 const goal=String(plan.goal||'');
 if(!/(?:日程|规划.{0,8}(?:明天|次日)|(?:明天|次日).{0,8}规划|按.{0,16}(?:规划|安排).{0,8}过(?:明天|次日))/.test(goal)||plan.steps?.length||plan.ownerTaskId||plan.travelCallId||plan.finalActionCallId||['travelling','working'].includes(plan.phase))return false;
 const target=planBusinessAt(plan);return !!target&&day(target)<day(now);
}
/** Inspect executable timing without interpreting prose trigger strings. */
export function inspectPlanTrigger(plan,life={},{now=Date.now()}={}){
 const wait=condition(plan.waitCondition),next=absolute(plan.nextAt);
 if(staleOverview(plan,life,now))return {valid:false,kind:null,nextAt:0,issue:{code:'past-daily-overview'}};
 if(plan.status==='waiting_event'&&wait&&wait.kind!=='time')return {valid:true,kind:wait.kind,nextAt:0,waitCondition:wait};
 if(next&&plan.status!=='waiting_event')return {valid:true,kind:'time',nextAt:next,...(wait?{waitCondition:wait}:{})};
 if(wait?.kind==='time'){
  if(wait.at>now||plan.lastTimeWake!==wait.at)return {valid:true,kind:'time',nextAt:wait.at,waitCondition:wait};
  if(next>now)return {valid:true,kind:'time',nextAt:next,waitCondition:{kind:'time',at:next}};
  return {valid:false,kind:null,nextAt:0,issue:{code:'time-already-consumed'}};
 }
 if(wait)return {valid:true,kind:wait.kind,nextAt:0,waitCondition:wait};
 const social=socialCondition(plan,life,now);
 if(social)return {valid:true,kind:'event',nextAt:0,waitCondition:social,social:true};
 return {valid:false,kind:null,nextAt:0,issue:{code:'trigger-needs-definition'}};
}
/** The next no-progress wait must be real; elapsed clocks never become events. */
export function nextPlanWait(plan,life={},now=Date.now()){
 if(staleOverview(plan,life,now))return null;
 if(absolute(plan.nextAt)>now)return {kind:'time',at:plan.nextAt};
 const wait=condition(plan.waitCondition);
 if(wait?.kind==='time')return wait.at>now?wait:null;
 if(wait)return wait;
 return socialCondition(plan,life,now);
}
/** Pure in-memory normalization. Call within the owner's existing transaction. */
export function normalizePlanTriggers(life,{now=Date.now(),bumpRevision=true}={}){
 const result={changed:0,blocked:0,repaired:0,expired:0,issues:[]};
 for(const plan of life.plans||[]){
  if(terminal.has(plan.status)||plan.status==='needs_review'||plan.status==='blocked'&&!plan.scheduleIssue)continue;
  const before=JSON.stringify(plan),expired=absolute(plan.expiresAt)&&plan.expiresAt<=now;
  if(expired){plan.status='expired';result.expired++;}
  else {
   const trigger=inspectPlanTrigger(plan,life,{now});
   if(!trigger.valid){
    plan.status='blocked';const code=trigger.issue.code;
    if(plan.scheduleIssue?.version!==1||plan.scheduleIssue.code!==code)plan.scheduleIssue={version:1,code,at:now};
    result.issues.push({id:plan.id,code});
   }else if(plan.status!=='blocked'){
    delete plan.scheduleIssue;
    if(trigger.nextAt)plan.nextAt=trigger.nextAt;
    if(trigger.kind!=='time'||plan.status==='waiting_event'){
     plan.waitCondition=trigger.waitCondition;
     if(trigger.kind!=='time'){plan.status='waiting_event';plan.nextAt=0;}
    }
   }
  }
  if(JSON.stringify(plan)!==before){
   result.changed++;if(plan.status==='blocked')result.blocked++;else if(!expired)result.repaired++;
   if(bumpRevision)plan.revision=(Number.isSafeInteger(plan.revision)?plan.revision:0)+1;
   plan.updatedAt=now;
  }
 }
 return result;
}
/** Match only trusted original events, bound to the selected plan/object. */
export function matchesPlanEvent(plan,event){
 const wait=eventCondition(plan.waitCondition);if(!wait||event.provenance?.trusted!==true||!absolute(event.t)||event.t<=Math.max(plan.lastCheckedAt||0,wait.after||0))return false;
 const kinds=wait.eventKinds||(wait.eventKind?[wait.eventKind]:[]),subjects=wait.subjects||(wait.subject?[wait.subject]:[]);
 if(wait.eventId?event.id!==wait.eventId:!kinds.includes(event.kind))return false;
 if(subjects.length&&!subjects.includes(event.sender))return false;
 return (plan.sourceEventIds||[]).includes(event.id)||(event.relatedPlanIds||[]).includes(plan.id)||wait.eventId===event.id||wait.trustedOnly===true&&subjects.includes(event.sender);
}
