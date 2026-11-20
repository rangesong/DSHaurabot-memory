import {createHash,randomUUID} from 'node:crypto';

export const clean=v=>String(v??'').replace(/\bfwr?_[A-Za-z0-9_-]+/g,'[密钥已隐藏]');
export const dayKey=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
export const eventId=(fish,x)=>createHash('sha256').update(JSON.stringify([fish,x.kind,x.t,x.text])).digest('hex');
export const defaults={backgroundContextEnabled:false,backgroundContextRounds:16,chatBodyInjectionEnabled:true,chatLocationInjectionEnabled:true,autonomy:true,idleEnabled:true,sharing:true,observeOnly:false,workLimit:96,idleLimit:24,socialLimit:24,shareLimit:6,singleSpend:40,dailySpend:100,stocks:false,gifts:false,turnMs:90000,maxCalls:6,idleMs:1200000,sleepMs:3600000,workMs:300000,socialMs:300000,quietStart:23,quietEnd:8};
export const newLife=(now=Date.now())=>({version:1,createdAt:now,owner:'',persona:'',revision:0,controls:{},queue:[],plans:[],journal:[],outbox:[],round:null,days:{},cooldowns:{},nextIdle:now+1200000,lastToolAt:0,backoffUntil:0,faults:{},blocked:'',sessionId:'',toolNames:[],recovery:false});
export const terminal=s=>['completed','expired','cancelled','observed'].includes(s);
export function timestamp(value){const n=Number(value);return Number.isFinite(n)&&n>0?(n<100000000000?n*1000:n):Date.parse(value||'')||0;}
export function budget(life,now){const day=dayKey(now);return life.days[day]??=( {work:0,idle:0,social:0,share:0,spend:0,calls:0} );}
export function classify(kind,text=''){return kind==='owner'?{priority:0,bucket:'work'}:['work','doorbell','inspection','recovery'].includes(kind)||kind==='done'&&/(?:^下班|工作结算|班次结算)/.test(text)?{priority:1,bucket:'work'}:['talk','message','note','friend_request'].includes(kind)?{priority:2,bucket:'social'}:['arrive','done','plan'].includes(kind)?{priority:3,bucket:'idle'}:kind==='idle'?{priority:4,bucket:'idle'}:{priority:9,bucket:'none'};}
export function enqueue(data,x,now){
  const l=data.life,id=eventId(data.fishId||data.state?.fish||'',x);
  if(l.queue.some(e=>e.id===id))return;
  const c=classify(x.kind,x.text),sender=String(x.sender||/([^\s，。：]+#\d+)/.exec(x.text)?.[1]||x.kind);
  const matching=l.plans.some(p=>['pending','active'].includes(p.status)&&p.trigger===x.kind);
  l.queue.push({...x,id,...c,sender,receivedAt:now,status:c.priority===9||(['arrive','done'].includes(x.kind)&&!matching&&!/下班|结算|生病/.test(x.text))?'observed':'pending',notBefore:c.bucket==='social'?Math.max(now,l.cooldowns[sender]||0):now});
  // Keep pending work intact. Completed history is bounded independently.
  const old=l.queue.filter(e=>terminal(e.status)).slice(-400);
  l.queue=[...old,...l.queue.filter(e=>!terminal(e.status))];
}
export function synthetic(data,kind,text,now){enqueue(data,{kind,t:now,text,time:'',nonce:randomUUID()},now);}
