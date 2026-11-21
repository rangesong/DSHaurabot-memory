import {dayKey,timestamp,planOpen,planTerminal} from './state.mjs';
const norm=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const unique=values=>[...new Set(values)];
const textOf=p=>[p.goal,p.nextStep,p.topic].filter(Boolean).join('；');
const principal=text=>String(text||'').split(/[，,；;。]|不替|别替|不帮|不给|不得|不要/)[0];
const sourcePeers=(p,l)=>unique((p.sourceEventIds||[]).flatMap(id=>l.queue.filter(q=>q.id===id).map(q=>norm(q.sender)))).sort();
function label(value){
 let s=value;
 for(let i=0;i<4;i++){const next=s.replace(/^(?:明天|今天|白天|傍晚|顺道|当面|一起|去找|找到|找|问|和|或|向|给|跟|让|去)/,'');if(next===s||next.length<2)break;s=next;}
 return s;
}
export function entityCatalog(l,extra=[]){
 const aliases=new Map(),texts=[...l.plans.map(textOf),...l.queue.map(q=>q.sender||''),...extra];
 for(const text of texts)for(const match of String(text).matchAll(/([\p{L}_]+)#(\d+)/gu)){
  const name=norm(label(match[1])),id='#'+match[2];if(name.length<2)continue;
  const ids=aliases.get(name)||new Set();ids.add(id);aliases.set(name,ids);
 }
 return new Map([...aliases].filter(([,ids])=>ids.size===1).map(([name,ids])=>[name,[...ids][0]]));
}
const resources=[
 ['beading-supplies',/线(?:和|与|及)?珠(?:子)?|线和珠|串珠.{0,6}线|(?:手环|钥匙扣).{0,12}(?:进货|重穿|珠)/],
 ['health',/身体|健康|生病|病情|伤势|肚子|感冒/],
 ['opening-hours',/营业|开门|开摊时间|营业时间/],
 ['food',/白米饭|红薯|做饭|吃饭|晚饭|午饭|早饭/],
 ['work',/打工|上班|工作|班次/]
];
function stageOf(p){
 const stage=norm(p.stage||p.trigger||'continue');
 if(stage==='arrive'||/(?:抵达|到达).{0,3}(?:后|再|$)|after[-_](?:arrival|arrive|travel)/.test(stage))return 'after-arrival';
 if(stage==='done'||/(?:做完|完成|结束).{0,3}(?:后|再|$)|after[-_](?:done|completion|finish)/.test(stage))return 'after-completion';
 if(/^(?:待办|pending|continue)$/.test(stage)||/^(?:明天|今天|白天|晚上|上午|下午)(?:白天|晚上|上午|下午)?(?:[(]?[0-9]{1,2}[-/][0-9]{1,2}[)]?)?$/.test(stage))return 'unspecified';
 if(/^遇到/.test(stage)&&!/(?:完成|做完|吃完|之后|然后)/.test(stage))return 'peer-encounter';
 return stage;
}
function windowOf(p,now){
 const anchor=timestamp(p.businessAt)||timestamp(p.nextAt)||now,begin=timestamp(p.windowStart)||Date.parse(dayKey(anchor)+'T00:00:00+08:00');
 return {start:begin,end:timestamp(p.windowEnd)||begin+86400000,businessAt:timestamp(p.businessAt)};
}
export function semanticPlan(p,l,context={}){
 const catalog=context.catalog||entityCatalog(l,[textOf(p)]),primary=principal(p.goal),secondary=principal(p.nextStep);
 const targetText=norm(primary+'；'+secondary),targets=unique([...catalog].filter(([name])=>targetText.includes(name)).map(([,id])=>id)).sort();
 for(const match of targetText.matchAll(/#\d+/g))if(!targets.includes(match[0]))targets.push(match[0]);targets.sort();
 const rawSubject=norm(p.subject||context.fishId||'self'),self=norm(context.fishId||p.fishId||'self');
 const subject=rawSubject===self||rawSubject==='self'?'self':rawSubject;
 const text=norm(textOf(p)),action=/问|询问|打听|咨询|核实|了解/.test(text)?'inquire':/买|购买|进货/.test(text)?'buy':/领取|取回|拿回/.test(text)?'collect':/做饭|焖|煮/.test(text)?'cook':/吃|食用/.test(text)?'eat':null;
 const topic=resources.find(([,pattern])=>pattern.test(text))?.[0]||null;
 return {actor:{fishId:context.fishId||p.fishId||'',owner:context.owner||p.owner||l.owner||'',persona:context.persona||p.persona||l.persona||''},
  ownerInstructionRevision:p.ownerInstructionRevision??context.ownerInstructionRevision??l.ownerInstructionRevision??0,
  targets,subject,action,topic,stage:stageOf(p),window:windowOf(p,context.now||Date.now()),sourcePeers:sourcePeers(p,l)};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function semanticReason(a,b,{allowUnscoped=false}={}){
 if(!same(a.actor,b.actor)||a.ownerInstructionRevision!==b.ownerInstructionRevision||a.subject!==b.subject||!same(a.window,b.window))return null;
 if(!a.action||a.action!==b.action||!a.targets.length||!same(a.targets,b.targets))return null;

 if(a.stage!==b.stage&&!((a.stage==='peer-encounter'&&b.stage==='unspecified'||b.stage==='peer-encounter'&&a.stage==='unspecified')&&a.action==='inquire'&&a.targets.length>=2))return null;
 if(a.topic&&b.topic)return a.topic===b.topic?'same-action-targets-resource-stage-window':null;
 // Missing subjects are never inferred from sender identity; an explicit reference or owner-reviewed pair is required.
 if(allowUnscoped&&a.action==='inquire'&&a.targets.length>=2&&(a.topic||b.topic))return 'explicit-reference-elliptical-refinement';
 return null;
}
export function equivalentPlans(a,b,l,context={}){
 for(const p of [a,b])for(const key of ['fishId','owner','persona'])if(p[key]&&context[key]&&p[key]!==context[key])return null;
 const catalog=entityCatalog(l,[textOf(a),textOf(b)]),ctx={...context,catalog};
 const left=semanticPlan(a,l,ctx),right=semanticPlan(b,l,ctx),reviewed=context.reviewedPair?.length===2&&[a.id,b.id].every(id=>context.reviewedPair.includes(id));
 const reason=semanticReason(left,right,{allowUnscoped:reviewed||!!context.refinesPlanId&&[a.id,b.id].includes(context.refinesPlanId)});
 return reason?{reason,identity:left}:null;
}
export function findEquivalentPlan(l,p,context={}){
 const matches=l.plans.filter(old=>old.status!=='needs_review'&&(planOpen(old.status)||planTerminal(old.status)))
  .map(old=>({old,proof:equivalentPlans(old,p,l,context)})).filter(row=>row.proof);
 if(!matches.length){const candidates=l.plans.filter(p=>p.status!=='needs_review'&&planOpen(p.status)).filter(old=>equivalentPlans(old,p,l,{...context,refinesPlanId:old.id}));if(candidates.length)return {ambiguous:true,candidateIds:candidates.map(p=>p.id),reason:'省略主题，需要明确 refinesPlanId 或事项主题'};}
 if(matches.length>1)return {ambiguous:true,candidateIds:matches.map(row=>row.old.id),reason:'同义计划有多个候选，需要明确 refinesPlanId'};
 return matches[0]||null;
}
export function constraintsOf(p){
 const values=[...(Array.isArray(p.constraints)?p.constraints:[])];
 for(const line of [p.goal,p.nextStep,p.reason].filter(Boolean)){
  for(const match of String(line).matchAll(/(?:不替|别替|不要|不得|不帮|不给|只问|如果|若)[^，,；;。]{1,100}/g))values.push(match[0].trim());
 }
 return unique(values.map(String).filter(Boolean).map(value=>/不|别/.test(value)&&/垫钱/.test(value)?'只询问信息，不替他人垫钱':value));
}
export function refinementPatch(old,incoming,{sourceEventIds=[],evidenceIds=[],proof}={}){
 const constraints=unique([...constraintsOf(old),...constraintsOf(incoming)]);
 const additions=unique([incoming.nextStep,...constraints].filter(value=>value&&!String(old.nextStep||'').includes(value)));
 const nextStep=[old.nextStep,...additions].filter(Boolean).join('；');
 const nextAt=Math.max(timestamp(old.nextAt),timestamp(incoming.nextAt));
 const limits=[timestamp(old.expiresAt),timestamp(incoming.expiresAt)].filter(Boolean),expiresAt=limits.length?Math.min(...limits):0;
 if(expiresAt&&nextAt>expiresAt)throw Error('新增期限早于计划检查时间，请沿用原 ID 明确更新可执行时间');
 const submitted=Object.fromEntries(['goal','reason','nextStep','stage','trigger','waitCondition','expiresAt','constraints'].filter(k=>incoming[k]!==undefined).map(k=>[k,structuredClone(incoming[k])]));
 const refinements=old.refinements||[],recorded=refinements.some(value=>JSON.stringify(value)===JSON.stringify(submitted));
 return {nextStep,nextAt,expiresAt,waitCondition:old.waitCondition?.kind==='time'?{...old.waitCondition,at:nextAt}:old.waitCondition,
  constraints,semanticAliases:unique([...(old.semanticAliases||[]),incoming.goal].filter(value=>value&&value!==old.goal)),
  refinements:recorded?refinements:[...refinements,submitted],
  sourceEventIds:unique([...(old.sourceEventIds||[]),...sourceEventIds]),semanticIdentity:proof?.identity||old.semanticIdentity,
  ...(evidenceIds.length&&incoming.progress?{progress:incoming.progress}:{})};
}
