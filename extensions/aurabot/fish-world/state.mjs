import {createHash,randomUUID} from 'node:crypto';

export const clean=v=>String(v??'').replace(/\bfwr?_[A-Za-z0-9_-]+/g,'[密钥已隐藏]');
export const dayKey=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
export const eventId=(fish,x)=>createHash('sha256').update(JSON.stringify([fish,x.kind,x.t,x.text])).digest('hex');
export const defaults={normalMinGapMs:180000,urgentMinGapMs:30000,urgentMaxRoundsPer10Min:4,planRecheckMinMs:600000,unchangedPlanRoundLimit:1,roundPromptEstimatedTokenLimit:12000,visibleContextEstimatedTokenLimit:48000,requestAdmissionEstimatedTokenLimit:64000,costGuardEnabled:false,costSoftLimitCny:2,costStopLimitCny:3,backgroundContextEnabled:false,backgroundContextRounds:16,chatBodyInjectionEnabled:true,chatLocationInjectionEnabled:true,autonomy:true,idleEnabled:true,idleWorkHours:'',activityWorkHours:'',sharing:true,observeOnly:false,workLimit:96,idleLimit:24,socialLimit:24,shareLimit:6,singleSpend:40,dailySpend:100,stocks:false,gifts:false,turnMs:90000,maxCalls:6,idleMs:1800000,sleepMs:3600000,workMs:600000,socialMs:600000,quietStart:23,quietEnd:8};
export const newLife=(now=Date.now())=>({version:2,ownerInstructionRevision:0,planHistory:[],planProposals:[],alerts:[],scheduler:{lastStartedAt:0,starts:[],urgentClaims:{},reservations:[],budgetDay:""},costs:{records:[],seen:{},rounds:[]},createdAt:now,owner:'',persona:'',revision:0,controls:{},queue:[],plans:[],journal:[],outbox:[],round:null,days:{},cooldowns:{},nextIdle:now+defaults.idleMs,lastToolAt:0,backoffUntil:0,faults:{},blocked:'',sessionId:'',toolNames:[],recovery:false});
export const terminal=s=>['completed','expired','cancelled','observed'].includes(s);
export function timestamp(value){const n=Number(value);return Number.isFinite(n)&&n>0?(n<100000000000?n*1000:n):Date.parse(value||'')||0;}
export function budget(life,now){const day=dayKey(now);return life.days[day]??=( {work:0,idle:0,social:0,share:0,spend:0,calls:0} );}
export function classify(kind,text=''){return kind==='owner'?{priority:0,bucket:'idle'}:['work','doorbell','health','inspection','recovery'].includes(kind)||kind==='done'&&/(?:^下班|工作结算|班次结算)/.test(text)?{priority:1,bucket:'work'}:['talk','message','note','friend_request'].includes(kind)?{priority:2,bucket:'social'}:['arrive','done','plan'].includes(kind)?{priority:3,bucket:'idle'}:kind==='idle'?{priority:4,bucket:'idle'}:{priority:9,bucket:'none'};}
export function enqueue(data,x,now){
  const l=data.life,id=eventId(data.fishId||data.state?.fish||'',x);
  if(l.queue.some(e=>e.id===id))return;
  const c=classify(x.kind,x.text),sender=String(x.sender||/([^\s，。：]+#\d+)/.exec(x.text)?.[1]||x.kind);
  const matched=l.plans.filter(p=>{
    if(!['pending','active','waiting_event'].includes(p.status)&&!p.satisfiedStages?.length)return false;
    const wait=p.waitCondition||{},waiting=wait.kind==='event'&&wait.subject===sender&&(wait.eventKinds||[wait.eventKind]).includes(x.kind);
    const relatedConversation=c.bucket==='social'&&(p.sourceEventIds||[]).some(id=>l.queue.some(q=>q.id===id&&q.sender===sender));
    return waiting||relatedConversation||p.trigger===x.kind&&p.nextAt>0&&Math.abs(p.nextAt-x.t)<=120000;
  });
  const related=c.bucket==='social'?matched:matched.length===1?matched:[];
  const matching=related.length>0;
  l.queue.push({...x,id,...c,sender,eventVersion:1,provenance:{trusted:true,source:kindSource(x.kind)},relatedPlanIds:related.map(p=>p.id),receivedAt:now,status:c.priority===9||(['arrive','done'].includes(x.kind)&&!matching&&!/下班|结算|生病/.test(x.text))?'observed':'pending',notBefore:c.bucket==='social'?Math.max(now,l.cooldowns[sender]||0):now});
  // Keep pending work intact. Completed history is bounded independently.
  const referenced=new Set(l.plans.flatMap(p=>p.sourceEventIds||[]));
  const closed=l.queue.filter(e=>terminal(e.status)),old=[...closed.filter(e=>referenced.has(e.id)),...closed.filter(e=>!referenced.has(e.id)).slice(-400)];
  l.queue=[...old,...l.queue.filter(e=>!terminal(e.status))];
}
export function synthetic(data,kind,text,now){enqueue(data,{kind,t:now,text,time:'',nonce:randomUUID()},now);}

export const PLAN_STATUSES=["pending","active","waiting_event","blocked","needs_review","completed","expired","abandoned","cancelled","superseded","merged"];
export const planTerminal=status=>["completed","expired","abandoned","cancelled","superseded","merged"].includes(status);
export const planOpen=status=>PLAN_STATUSES.includes(status)&&!planTerminal(status);

function kindSource(kind){return kind==='owner'?'owner-control':'world-notify';}
