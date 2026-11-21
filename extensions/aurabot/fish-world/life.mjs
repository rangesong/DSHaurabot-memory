import {isExactFishIdentity} from './action-sequence.mjs';
import {completedWindowRound,bindWindow,buildTaskPrompt} from './world-window.mjs';
import {advancePlans,preparePlanChanges,applyPlanChanges,finishPlanCheck,planEvidenceFingerprint} from './plans.mjs';
import {candidates,admission,reserveRound,effectiveNow,quotaAlert,closeOldAlerts,isQuotaDelivery,observeSatisfiedEvents,estimateTokens} from './governance.mjs';
import {beginCostRound,endCostRound,costSummary,settleMissingUsage} from './costs.mjs';
import {randomUUID} from 'node:crypto';
import {budget,defaults,synthetic,terminal,clean,timestamp,planOpen} from './state.mjs';
import {workHoursAllowed} from './work-hours.mjs';

export const WORLD='mcp__fish-world__';
export const worldNames=['now','history','find','profile','go','do','say','friends','update','guide'].map(n=>WORLD+'world_'+n);
export const mutating=(name,args={})=>['go','do','say','update'].some(n=>name===WORLD+'world_'+n)||name===WORLD+'world_friends'&&args.action!=='list';
const localNames=new Set(['fish_life_intent','fish_life_finish','fish_life_history','fish_life_action']);
const textOf=r=>(r?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=(name,args)=>JSON.stringify([name,canonical(args)]);
export class LifeEngine {
  constructor({bridge,host,settings=()=>({}),authorized=()=>true,identity=()=>({}),clock=Date.now}){
    Object.assign(this,{bridge,host,settings,authorized,identity,clock});this.closed=false;this.lock=null;this.agent=null;this.deliveryBusy=false;this.alertVisits=new Map();
    this.change(l=>{
      for(const p of l.plans){p.nextAt=timestamp(p.nextAt);p.trigger=/到|抵达/.test(p.trigger)?'arrive':/结束|完成/.test(p.trigger)?'done':p.trigger;}
      if(l.journal.some(x=>x.status==='executing'))l.recovery=true;
      if(l.round){const reservation=l.scheduler?.reservations?.find(r=>r.roundId===l.round.id);if(reservation)reservation.status='uncertain';l.round.status='uncertain';l.round.stopReason='重启后先确认旧会话停止，再只读核对现场';l.recovery=true;}
      for(const q of l.queue)if(q.status==='running')q.status='uncertain';
      if(l.queue.some(q=>q.status==='uncertain'))l.recovery=true;
      for(const o of l.outbox)if(o.state==='sending')o.state='uncertain';
    });
  }
  get l(){return this.bridge.data.life;}
  get cfg(){return {...defaults,...this.settings(),...this.l.controls};}
  change(fn){return this.bridge.change(d=>fn(d.life,d));}
  blocked(reason){if(this.l.blocked!==reason)this.change(l=>{l.blocked=reason;});}
  snapshot(){const l=structuredClone(this.l);for(const [key,visit]of this.alertVisits){const a=l.alerts?.find(a=>a.key===key);if(a){a.repeatCount+=visit.count;a.lastSeenAt=visit.lastSeenAt;}}return {...l,usage:budget(l,effectiveNow(l,this.clock())),costSummary:costSummary(l,this.clock()),settings:this.cfg,locked:!!this.lock};}
  control(action,text=''){
    const changes={pauseIdle:{idleEnabled:false},pauseAuto:{autonomy:false},pauseShare:{sharing:false},observe:{observeOnly:true},stop:{stopped:true},resume:{stopped:false,autonomy:true,idleEnabled:true,observeOnly:false},share:{sharing:true}};
    if(!changes[action]&&!['plan','probe'].includes(action))throw Error('未知控制');
    this.change((l,d)=>{Object.assign(l.controls,changes[action]||{});l.revision++;
      if(action==='probe'){if(l.round)throw Error('后台正在忙碌');l.recovery=true;l.verification=true;l.verificationInstruction=clean(text).slice(0,500);l.backoffUntil=0;}
      if(action==='plan'){
        l.ownerInstructionRevision=(l.ownerInstructionRevision||0)+1;(l.ownerInstructions??=[]).push({text:clean(text).slice(0,2000),at:this.clock(),revision:l.ownerInstructionRevision});l.ownerInstructions=l.ownerInstructions.slice(-20);
        for(const p of l.plans)if(planOpen(p.status)){const before=structuredClone(p);p.status='cancelled';p.revision=(p.revision||0)+1;p.updatedAt=this.clock();p.changeReason='主人改变安排';(l.planHistory??=[]).push({at:this.clock(),op:'owner-superseded',id:p.id,before});}
        for(const q of l.queue)if(!terminal(q.status)&&q.bucket==='idle')q.status='cancelled';
        synthetic(d,'owner',clean(text).slice(0,2000),this.clock());
      }
      if(l.round&&['stop','pauseAuto','observe','plan','pauseIdle'].includes(action)){l.round.status='stopping';l.round.stopReason='主人更新了控制或安排';}
    });
    if(this.l.round?.status==='stopping')void this.host.cancel(this.l.round.sessionId).catch(()=>{});
  }
  fault(key,message){
    if(key.startsWith('budget-'))return this.noteQuotaAlert(key.slice(7));
    const now=this.clock();this.change(l=>{
      if(now-(l.faults[key]||0)<1800000)return;
      l.faults[key]=now;l.outbox.push({id:'fault-'+randomUUID(),at:now,importance:'urgent',text:message,state:'pending',facts:[key],owner:l.owner,persona:l.persona});
    });
  }
  async tick(){
    if(this.ticking)return;this.ticking=true;
    try{return await this.tickOnce();}finally{this.ticking=false;}
  }
  async tickOnce(){
    if(this.closed||this.bridge.fatal||this.maintenanceBusy)return;
    const id=this.identity(),l=this.l,c=this.cfg,now=effectiveNow(l,this.clock());
    if(l.owner&&l.owner!==id.owner||l.persona&&l.persona!==id.persona){
      this.blocked('主人或人格已改变，请重新核对身份后恢复');
      if(l.round){this.change(x=>{x.round.status='stopping';});await this.host.cancel(l.round.sessionId);}return;
    }
    if(!l.owner&&id.owner)this.change(x=>{x.owner=id.owner;x.persona=id.persona;});
    const pendingMemory=l.journal.find(x=>x.memory==='pending'&&(!x.memoryRetryAt||x.memoryRetryAt<=now));
    if(pendingMemory){this.change(()=>{pendingMemory.memoryRetryAt=now+300000;});void this.remember(pendingMemory.id);}
    if(l.externalPending&&!this.lock){
      if(await this.host.idle(l.externalPending.sessionId))this.change(x=>{x.externalPending=null;x.recovery=true;});
      else return this.blocked('重启前的 QQ 世界操作尚未结束');
    }
    if(l.round){
      if(l.round.status==='finished'){
        if(await this.host.idle(l.round.sessionId))this.end(true);
        return;
      }
      if(now-l.round.startedAt>=c.turnMs&&l.round.status==='running'){
        this.change(x=>{x.round.status='stopping';x.round.stopReason='执行超时，结果不确定';x.recovery=true;});
        await this.host.cancel(l.round.sessionId);this.fault('timeout','我刚才那一步等太久了，结果还没确认。我先停住，核对清楚再继续。');
      }
      if(['stopping','uncertain'].includes(l.round.status)){
        await this.host.cancel(l.round.sessionId);
        if(await this.host.idle(l.round.sessionId))this.end(false,'已确认旧会话停止；下轮仅核对现场');
      }
      return;
    }
    if(!this.authorized()||c.stopped)return this.blocked('自动流程已停止');
    if(!this.bridge.identityReady||now-(this.bridge.data.at.state||0)>180000)return this.blocked('等待有效世界身份和现状');
    if(!this.deliveryBusy)void this.deliver().catch(()=>{});
    if(!c.autonomy||c.observeOnly)return this.blocked(c.observeOnly?'只观察模式':'自动行动已暂停');
    if(now<l.backoffUntil)return;
    if(this.lock)return this.blocked('QQ 世界工具正在执行');
    if(this.deliveryBusy)return this.blocked('等待当前投递流程收尾');
    if(l.recovery&&l.sessionId){
      if(!await this.host.idle(l.sessionId))return this.blocked('恢复核对等待旧 Agent 与维护任务停止');
      if(!this.lock&&!l.externalPending)this.change(x=>{for(const j of x.journal)if(j.status==='executing'&&j.sessionId===x.sessionId){j.originalExecutionStatus='executing';j.status='uncertain';j.stopConfirmedAt=now;}});
    }
    this.change((life,data)=>{advancePlans(life,data,now);observeSatisfiedEvents(life);closeOldAlerts(life,now);settleMissingUsage(life,now);});
    const choices=candidates(this.l,this.bridge.data,c,now);let chosen,decision,firstBlocked;
    for(const task of choices){
      const check=admission(this.l,task,c,{now,costSummary:costSummary(this.l,now)});
      if(check.allowed){chosen=task;decision=check;break;}
      firstBlocked??=check;if(check.budgetExhausted)this.noteQuotaAlert(check.bucket);if(/工作时间/.test(check.reason))break;
    }
    if(!chosen){
      const denied=firstBlocked||{reason:'',nextAllowedAt:0};this.blocked(denied.reason);
      this.change(l=>{l.admission={reason:denied.reason,nextAllowedAt:denied.nextAllowedAt||0};});return;
    }
    const rawGroup=chosen.group?.length?chosen.group:[chosen];
    const group=(chosen.kind==='recovery'?[chosen,...(chosen.group||[])]:rawGroup).slice(0,8);
    const planIds=[...new Set([chosen.planId,...group.flatMap(q=>q.relatedPlanIds||[])].filter(Boolean))].filter(id=>this.l.plans.some(p=>p.id===id)).slice(0,12);
    const round={id:randomUUID(),sessionId:'',kind:chosen.kind,bucket:chosen.bucket,priority:chosen.priority,
      events:group.map(e=>e.id),sourceEventIds:[...new Set([...group.filter(e=>this.l.queue.some(q=>q.id===e.id)).map(e=>e.id),...(chosen.sourceEventIds||[])])],
      planId:chosen.planId||planIds[0]||null,planIds,planRevision:chosen.planRevision||null,reason:clean(chosen.plan?.goal||chosen.text).slice(0,1000),
      startedAt:decision.now,status:'running',revision:this.l.revision,calls:0,receipts:[],observation:'',intent:null,report:null,readOnly:chosen.kind==='recovery'};
    const prompt=this.prompt(group,round);
    let prepared;
    try{prepared=this.host.prepare?await this.host.prepare(prompt,round):{prompt,estimate:{roundPromptTokens:estimateTokens(prompt),requestTokens:estimateTokens(prompt)+16000,scope:'module-plus-unknown-wrapper-reserve'}};}
    catch(error){this.blocked('启动预检受阻：'+clean(error.message));return;}
    if(this.closed||this.lock||this.l.round||this.l.externalPending||this.l.revision!==round.revision)return;
    const check=admission(this.l,chosen,c,{now:this.clock(),estimate:prepared.estimate,costSummary:costSummary(this.l,this.clock())});
    if(!check.allowed){this.blocked(check.reason);this.change(l=>{l.admission={reason:check.reason,nextAllowedAt:check.nextAllowedAt||0,estimate:prepared.estimate};});return;}
    this.change(l=>{
      const reservation=reserveRound(l,chosen,c,{now:this.clock(),roundId:round.id,estimate:prepared.estimate,costSummary:costSummary(l,this.clock())});
      round.startedAt=reservation.allowed.now;round.windowId=prepared.windowKey||l.contextWindow?.key||null;round.estimate=prepared.estimate;
      l.round=round;l.admission={reason:'',nextAllowedAt:round.startedAt+c.normalMinGapMs,estimate:prepared.estimate};
      for(const e of l.queue)if(round.events.includes(e.id)){if(chosen.kind!=='recovery')e.lastRoundId=round.id;e.status='running';}
      l.blocked='';beginCostRound(l,round);
      const row=l.scheduler.reservations.find(r=>r.roundId===round.id);row.status='submission-uncertain';
    });
    const roundId=round.id;
    void Promise.resolve().then(()=>this.host.run(prepared.prompt||prompt,prepared)).then(async()=>{
      if(this.l.round?.id!==roundId)return;
      if(await this.host.idle(this.l.round.sessionId))this.end(true);else this.change(l=>{if(l.round?.id===roundId)l.round.status='finished';});
    }).catch(()=>{
      if(this.l.round?.id!==roundId)return;
      this.change(l=>{l.round.status='stopping';l.round.stopReason='宿主回合失败，等待旧 Agent 停止';l.backoffUntil=this.clock()+300000;l.recovery=true;});
      void this.host.cancel(this.l.round.sessionId).catch(()=>{});this.fault('host','世界通道刚才未确认完成，已停下核对。');
    });
  }
  noteQuotaAlert(bucket){
    const now=effectiveNow(this.l,this.clock()),day=new Date(now+28800000).toISOString().slice(0,10);
    const old=this.l.alerts?.find(a=>a.kind==='quota'&&a.day===day&&a.bucket===bucket&&a.status==='active');
    if(!old){this.change(l=>{quotaAlert(l,{fishId:this.bridge.data.fishId,bucket,now});});return;}
    const visit=this.alertVisits.get(old.key)||{count:0,lastSeenAt:old.lastSeenAt};visit.count++;visit.lastSeenAt=now;this.alertVisits.set(old.key,visit);
    if(now-old.lastSeenAt>=60000){this.change(l=>{quotaAlert(l,{fishId:this.bridge.data.fishId,bucket,now,repeat:visit.count});});this.alertVisits.delete(old.key);}
  }

  prompt(events,round=this.l.round){return buildTaskPrompt(this,events,round,this.host.memory?.()||'');}

  bind(sessionId,names){
    if(!worldNames.every(n=>names.includes(n)))throw Error('后台实际可见世界工具不完整');
    this.change(l=>{l.sessionId=sessionId;bindWindow(l,sessionId);l.toolNames=names.filter(n=>n.startsWith(WORLD));if(l.round)l.round.sessionId=sessionId;});
  }
  intent(input){
    const r=this.l.round;if(!r||r.status!=='running'||!r.observation)throw Error('先取得本轮 world_now 真实回执');
    if(!r.identityConfirmed)throw Error('先调用 world_profile({}) 核对本鱼身份，再登记意图；也可使用 fish_life_action 自动完成前置步骤');
    let args;try{args=JSON.parse(input.arguments);}catch{throw Error('arguments 需要完整 JSON 对象');}
    if(!mutating(input.tool,args))throw Error('不是世界变更工具');
    const cost=Number(input.cost),category=input.category,c=this.cfg;
    if(!Number.isFinite(cost)||cost<0||cost>c.singleSpend||budget(this.l,this.clock()).spend+cost>c.dailySpend)throw Error('消费预算不足');
    if((category==='stocks'&&!c.stocks)||(category==='gift'&&!c.gifts))throw Error('该自主范围尚未启用');
    if(!['daily','work','social','stocks','gift'].includes(category))throw Error('需要明确行动类别');
    if(category==='work'&&(this.l.ownerInstructions||[]).some(x=>/今天(?:别|不要)打工/.test(x.text)&&new Date(x.at+28800000).toISOString().slice(0,10)===new Date(this.clock()+28800000).toISOString().slice(0,10)))throw Error('主人今天要求不打工');
    if(!input.evidence||!r.receipts.some(x=>!x.isError&&x.text.includes(input.evidence)))throw Error('依据必须逐字来自本轮真实工具回执');
    if(cost>0&&!new RegExp('(?:'+cost+'\\s*贝|'+cost+'\\s*[/／])').test(input.evidence))throw Error('消费依据中需要现场价格');
    const action=JSON.stringify(args);
    if(!c.stocks&&/股票|证券|买入|卖出|stock|trade/i.test(action))throw Error('自主证券交易未开启');
    if(!c.gifts&&/赠送|送礼|赠礼|gift/i.test(action))throw Error('自主赠礼未开启');
    if(!c.gifts&&(args.give||args.treat||args.price))throw Error('贵重赠礼、请客或定价交易需要单独开启');
    if(input.tool===WORLD+'world_update'&&Object.keys(args).some(k=>k!=='outfit'))throw Error('自主更新仅允许换已有衣服，不能改世界身份和外貌');
    if(input.tool===WORLD+'world_do'&&args.id){
      if(!input.evidence.includes(args.id))throw Error('行动依据必须包含现场完整 id');
      const price=/(\d+(?:\.\d+)?)\s*贝/.exec(input.evidence);
      if(price&&!/报酬|工资|奖励|赚|收入|扣/.test(input.evidence)&&cost<Number(price[1])*(args.count||1))throw Error('声明消费低于现场单价和数量');
    }
    if(input.tool===WORLD+'world_go'&&args.by&&args.by!=='walk'&&args.by!=='bike'&&cost<=0)throw Error('付费交通需要先取得票价并预留消费');
    if(['go','do','say'].some(n=>input.tool===WORLD+'world_'+n))args.request_id??=r.id+':'+r.calls;
    this.change(l=>{l.round.intent={key:fingerprint(input.tool,args),cost,category,evidence:clean(input.evidence)};});
    return {ok:true,arguments:args,message:'意图已核对；请使用以下完整参数（含防重复 request_id）调用 '+input.tool+'：'+JSON.stringify(args)};
  }
  guard(exec,isBackground,isOwner){
    const name=exec.name,world=name.startsWith(WORLD),r=this.l.round,now=this.clock();
    if(isBackground&&!world&&!localNames.has(name)&&name!=='run_code')return '世界后台仅允许世界、计划和汇报能力';
    if(!world)return;
    if(!isBackground&&!isOwner)return;
    if(this.closed||this.maintenanceBusy||this.bridge.fatal||!this.authorized())return '世界模块已停止或状态不可写';
    if(isBackground){
      if(!r||r.sessionId!==exec.agent?.session?.id||r.status!=='running'||r.revision!==this.l.revision||this.cfg.stopped||!this.cfg.autonomy||this.cfg.observeOnly)return '本轮已停止、会话不匹配或主人改变安排';
      if(r.calls>=this.cfg.maxCalls||now-r.startedAt>=this.cfg.turnMs)return '达到本轮调用/时间上限';
      if(mutating(name,exec.arguments)){
        if(r.readOnly||!r.observation)return '必须先真实观察；恢复回合禁止变更';
        if(!r.identityConfirmed)return '变更前需要本轮 world_profile({}) 确认 MCP 和观看接口属于同一只鱼';
        if(this.l.queue.some(q=>q.priority<r.priority&&q.status==='pending'&&q.t>r.startedAt))return '出现更高优先级待办，停止本轮追加行动';
        if(r.intent?.key!==fingerprint(name,exec.arguments))return '请先用 fish_life_intent 声明本次完整行动和预算';
      }
    }else if(mutating(name,exec.arguments)&&r){
      this.change(l=>{l.revision++;l.round.status='stopping';l.round.stopReason='主人 QQ 世界行动优先';l.recovery=true;});
      void this.host.cancel(r.sessionId).catch(()=>{});return '后台正在收尾；请等待停止后再次执行世界行动';
    }
    if(this.lock||this.l.externalPending)return '另一个世界工具仍在执行，请等待回执';
    this.change(l=>{if(isBackground){l.round.calls++;budget(l,now).calls++;if(mutating(name,exec.arguments)){budget(l,now).spend+=l.round.intent.cost;l.round.intent=null;}}
      l.journal.push({id:exec.callId,at:now,sessionId:exec.agent?.session?.id,round:isBackground?r.id:null,tool:name,args:clean(JSON.stringify(exec.arguments)),status:'executing'});l.lastToolAt=now;
      if(!isBackground)l.externalPending={callId:exec.callId,sessionId:exec.agent?.session?.id};});
    this.lock={callId:exec.callId,sessionId:exec.agent?.session?.id};
  }
  result(exec,result){
    if(!this.lock&&this.l.externalPending?.callId===exec.callId)this.lock=this.l.externalPending;
    if(!exec.name.startsWith(WORLD)||!this.lock||this.lock.callId!==exec.callId)return;
    const text=clean(textOf(result)),isError=!!result.isError||result.value?.ok===false||/\[E_[A-Z_]+\]/.test(text);
    const uncertain=isError&&/timeout|timed out|超时|abort|ECONNRESET|断线|not connected/i.test(text);
    this.change(l=>{
      const entry=l.journal.find(x=>x.id===exec.callId);if(entry)Object.assign(entry,{status:uncertain?'uncertain':isError?'failed':'confirmed',isError,result:text,finishedAt:this.clock()});
      const r=l.round;if(r&&exec.agent?.session?.id===r.sessionId){r.receipts.push({id:exec.callId,tool:exec.name,text,isError});if(exec.name===WORLD+'world_now'&&!isError){r.observation=text;r.observationId=exec.callId;r.intent=null;}
        if(exec.name===WORLD+'world_profile'&&!exec.arguments?.fish&&!isError)r.identityConfirmed=!!r.observation&&isExactFishIdentity(text,this.bridge.data.fishId);}
      if(r&&uncertain){r.status='stopping';r.stopReason='世界调用结果不确定，先停止并核对';l.recovery=true;}
      if(l.externalPending?.callId===exec.callId)l.externalPending=null;
    });this.lock=null;
    if(uncertain)void this.host.cancel(this.l.round?.sessionId).catch(()=>{});
  }
  workRecovery(q,r){
    if(!r.readOnly)return null;
    const calls=this.l.journal.filter(j=>j.round===q.lastRoundId);
    const action=calls.findLast(j=>j.tool===WORLD+'world_do'&&['confirmed','uncertain'].includes(j.status));
    if(!action)return null;
    if(action.status==='confirmed')return {eventId:q.id,callId:action.id,source:'success-receipt'};
    const task=JSON.parse(action.args||'{}').id;if(!/^task-\d+$/.test(task||''))return null;
    const before=calls.findLast(j=>j.tool===WORLD+'world_now'&&j.status==='confirmed'&&j.at<=action.at);
    const choice=before?.result.split('\n').map(line=>/^·\s+(task-\d+)\s+(.+)$/.exec(line)).find(m=>m?.[1]===task)?.[2];
    if(!choice)return null;
    const done=this.l.queue.find(e=>e.kind==='done'&&e.t>=action.at&&e.t<=action.at+600000&&[choice+'：',choice+':'].some(prefix=>e.text.startsWith(prefix)));
    const now=r.receipts.findLast(j=>j.tool===WORLD+'world_now'&&!j.isError);
    const progress=text=>/(^[^\n]*下班；)处理了\s*(\d+)\s*件活，没顾上\s*(\d+)\s*件/m.exec(text||'');
    const old=progress(before?.result),current=progress(now?.text);
    if(!done||!old||!current||old[1]!==current[1]||Number(current[2])!==Number(old[2])+1||old[3]!==current[3])return null;
    return {eventId:q.id,callId:action.id,source:'done-and-readonly-progress',doneId:done.id,doneAt:done.t,observationId:now.id,at:this.clock()};
  }
  finish(input){
    const r=this.l.round;if(!r||r.status!=='running'||!r.observation)throw Error('缺少本轮真实观察');
    if(this.lock)throw Error('仍有世界调用未返回');
    const required=this.l.queue.filter(q=>r.events.includes(q.id)).map(q=>q.id);
    if(required.some(id=>!(input.events||[]).some(e=>e.id===id&&['completed','expired','blocked'].includes(e.status))))throw Error('请为本轮全部待办填写真实状态，缺少：'+required.filter(id=>!input.events?.some(e=>e.id===id)).join(','));
    const completedWork=this.l.queue.filter(q=>q.kind==='work'&&(input.events||[]).some(e=>e.id===q.id&&e.status==='completed'));
    const reconciliations=completedWork.map(q=>this.workRecovery(q,r)).filter(Boolean);
    if(completedWork.some(q=>!reconciliations.some(x=>x.eventId===q.id))&&!r.receipts.some(x=>x.tool===WORLD+'world_do'&&!x.isError))throw Error('工作标记完成需要 world_do 成功回执；过期或受阻请如实标记');
    if(input.importance!=='routine'&&!input.facts?.length)throw Error('重要分享需要真实回执编号');
    const facts=(input.facts||[]).map(id=>r.receipts.findLast(x=>(x.id===id||x.tool===id)&&!x.isError)?.id);
    if(facts.some(id=>!id))throw Error('分享依据不属于本轮成功回执；facts 只填下列精确 id 或完整 tool，不附说明：'+JSON.stringify(r.receipts.filter(x=>!x.isError).map(({id,tool})=>({id,tool}))));
    const operations=preparePlanChanges(this.l,input,{round:r,now:this.clock(),fishId:this.bridge.data.fishId});
    this.change(l=>{l.round.report={...input,reconciliations,facts,summary:clean(input.summary).slice(0,2000),share:clean(input.share).slice(0,1000),planChanges:operations};});
    return {ok:true,preparedPlans:operations.map(op=>({op:op.op,id:op.id,revision:op.plan?.revision??op.expectedRevision,candidateIds:op.candidateIds,status:op.op==='propose-refinement'?'blocked-local':undefined})),message:'回合报告已准备，结束本轮后原子提交；沿用以上程序计划 ID。QQ 投递独立核对。'};
  }
  end(completed,error=''){
    if(!this.l.round)return;
    const r=this.l.round,valid=completed&&['running','finished'].includes(r.status)&&r.report&&r.observation&&!this.lock,now=this.clock();
    this.change(l=>{
      const report=r.report;
      for(const e of l.queue)if(r.events.includes(e.id)){
        const disposition=report?.events?.find(x=>x.id===e.id)?.status;
        e.status=valid&&['completed','expired','blocked'].includes(disposition)?disposition:'uncertain';
        if(e.status==='blocked')e.notBefore=now+300000;
        e.result=valid?report.summary:error||r.stopReason||'缺少完整回合报告';
        if(valid){const proof=report.reconciliations?.find(x=>x.eventId===e.id);if(proof)e.reconciliation=proof;}
        if(r.bucket==='social')l.cooldowns[e.sender]=now+this.cfg.socialMs;
      }
      if(valid){
        applyPlanChanges(l,report.planChanges,{now,roundId:r.id});
        for(const id of r.planIds||[r.planId])finishPlanCheck(l,this.bridge.data,{...r,planId:id},{now,hasMutation:r.receipts.some(x=>!x.isError&&mutating(x.tool)),unchangedLimit:this.cfg.unchangedPlanRoundLimit});
        for(const p of l.plans.filter(p=>(r.planIds||[]).includes(p.id)||p.sourceEvidenceIds?.some(id=>r.receipts.some(x=>x.id===id)))){
          const success=r.receipts.filter(x=>!x.isError&&mutating(x.tool));
          if(success.length&&(p.trigger==='arrive'||p.trigger==='done'))(p.satisfiedStages??=[]).push({kind:p.trigger,at:now,expectedAt:p.nextAt||0,roundId:r.id,receiptIds:success.map(x=>x.id)});
        }
        l.nextIdle=Math.max(now+this.cfg.idleMs,timestamp(report.nextAt)||now+this.cfg.idleMs);
        if(r.readOnly){l.recovery=false;l.verification=false;}
        if(report.share&&['urgent','important'].includes(report.importance))l.outbox.push({id:r.id,at:now,importance:report.importance,text:report.share,facts:report.facts,state:'pending',owner:l.owner,persona:l.persona});
      }else {l.recovery=true;l.backoffUntil=now+300000;}
      if(valid)completedWindowRound(l,r);
      l.journal.push({id:r.id,at:now,type:'round',kind:r.kind,status:valid?'completed':'uncertain',summary:report?.summary||error,receipts:r.receipts.map(x=>x.id),actionSequences:structuredClone(r.actionSequences||{}),memory:valid&&report.importance!=='routine'?'pending':'none'});
      endCostRound(l,{...r,finishedAt:now},valid);
      const reservation=l.scheduler?.reservations.find(x=>x.roundId===r.id);if(reservation)reservation.status=valid?'completed':'uncertain';
      l.round=null;
    });
    if(valid&&r.report.importance!=='routine')void this.remember(r.id);
  }
  async remember(id){
    const row=this.l.journal.find(x=>x.id===id);if(!row||row.memory!=='pending')return;
    try{const receipt=await this.host.remember({text:'【鱼的世界自身经历；非主人原话】'+row.summary+'；事实回执：'+row.receipts.join(',')+'；QQ 是否送达另见投递记录。',saidAt:row.at,importance:.7,tags:['fish-world'],meta:{id}});
      this.change(l=>{l.journal.find(x=>x.id===id).memory=receipt?'recorded':'pending';});
    }catch{this.blocked('重要记忆等待 Thinkstar 正式入口恢复');}
  }
  async deliver(){
    if(this.closed||this.deliveryBusy)return;this.deliveryBusy=true;
    try{
      const now=this.clock(),c=this.cfg;
      if(!this.authorized()||c.stopped)return;
      const o=this.l.outbox.filter(x=>!isQuotaDelivery(x)&&(x.state==='queued'||['pending','deferred','failed'].includes(x.state)&&(!x.retryAt||x.retryAt<=now))).sort((a,b)=>(a.importance==='urgent'?0:1)-(b.importance==='urgent'?0:1)||a.at-b.at)[0];if(!o)return;
      if(o.owner!==this.identity().owner||o.persona!==this.identity().persona)return;
      if(o.state==='queued'){
        const r=await this.host.deliveryStatus(o.deliveryId);if(r)this.change(()=>{o.state=this.deliveryState(r);});return;
      }
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hour12:false}).format(now));
      const quiet=c.quietStart>c.quietEnd?hour>=c.quietStart||hour<c.quietEnd:hour>=c.quietStart&&hour<c.quietEnd;
      if(!c.sharing||o.importance!=='urgent'&&(quiet||budget(this.l,now).share>=c.shareLimit)){
        if(o.state!=='deferred')this.change(()=>{o.state='deferred';o.reason=!c.sharing?'分享已暂停':quiet?'免打扰':'今日分享额度已用完';});return;
      }
      this.change(l=>{o.state='sending';o.attempts=(o.attempts||0)+1;if(o.importance!=='urgent')budget(l,now).share++;});
      try{
        const r=await this.host.send(o);
        this.change(()=>{o.state=this.deliveryState(r);o.receipt=r?.message_id||r?.message_ids?.at(-1)||null;o.receipts=r?.message_ids||[];o.deliveryId=r?.deliveryId||null;o.reason=r?.reason||'';o.retryAt=now+1800000;if(o.state==='failed'&&o.attempts>=3)o.state='suppressed';});
      }catch{this.change(()=>{o.state='uncertain';o.reason='宿主发送抛错，不能确认送达；不自动重发';});}
    }finally{this.deliveryBusy=false;}
  }
  deliveryState(r){return r?.message_id!==undefined||r?.state==='sent'?'sent':r?.queued||['pending','sending','queued'].includes(r?.state)?'queued':['defer','dropped','suppressed'].includes(r?.state)?'deferred':r===null?'suppressed':r?.state==='failed'?'failed':'uncertain';}
  async dispose(){this.closed=true;if(this.l.round){this.change(l=>{l.round.status='stopping';l.round.stopReason='模块卸载或重载';l.recovery=true;});await this.host.cancel(this.l.round.sessionId);}}
}
