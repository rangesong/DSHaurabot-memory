import { randomUUID } from 'node:crypto';
import { PARAMS,REGIONS,RULE_PARAMS } from './v5-config.js';
import {automaticImplicit} from './v5-implicit-learning.js';

const fail=(message,code='INVALID_INPUT')=>{throw Object.assign(new Error(message),{code});};
const unique=items=>[...new Set(items)];
const normalize=s=>s.toLocaleLowerCase().replaceAll('疲惫','累').replaceAll('疲劳','累');
const keywords=value=>unique(String(value??'').split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean));

export function centralRuleStatus(r,m){
  const rule=m.attributes.central_rule;
  if(!rule)return {effective:false,reason:'尚未纳入中枢'};
  if(automaticImplicit(m)){const proof=r.implicitLearning.proof(m);if(!proof.valid)return {effective:false,reason:proof.reason};}
  else if(typeof rule.review_source!=='string'||!Array.isArray(rule.keywords)||!rule.keywords.length||rule.keywords.some(k=>typeof k!=='string'||k.length<2||k.length>40))return {effective:false,reason:'缺少本机核对或适用条件'};
  const review=typeof rule.review_source==='string'?r.store.getSource(rule.review_source):null,definition=PARAMS[rule.region]?.[rule.param];
  if(!automaticImplicit(m)&&(review?.scope!==m.scope||review?.provenance?.system!=='thinkstar'||review?.provenance?.kind!=='explicit_feedback'||!RULE_PARAMS[rule.region]?.includes(rule.param)||!definition||!Number.isFinite(rule.value)||rule.value<definition[1]||rule.value>definition[2]||!Array.isArray(rule.keywords)||!rule.keywords.length))return {effective:false,reason:'缺少本机核对或规则参数无效'};
  if(rule.status!=='active')return {effective:false,reason:rule.status==='paused'?'已暂停':'已撤回'};
  if(m.validity!=='current'||m.review==='needs_review'||m.revision!==rule.approved_revision)return {effective:false,reason:'内容或依据变化，须重新核对'};
  if(!m.source_refs.length||m.source_refs.some(id=>!r.store.getSource(id)))return {effective:false,reason:'必要来源不可用'};
  if((m.attributes.basis_refs??[]).some(b=>{const p=r.store.getMemory(b.id);return !p||p.scope!==m.scope||p.layer==='forgotten'||p.validity!=='current'||p.review==='needs_review';}))return {effective:false,reason:'上游依据待复核或已失效'};
  return {effective:true,reason:'在本范围和条件内生效'};
}

export function resolveCentralRules(r,scope,text,region=null){
  if(!scope||scope==='all')return [];
  const candidates=r.store.sql("SELECT json FROM memories WHERE scope=? AND layer='implicit'").all(scope).map(row=>r.store.decodeMemory(row.json));
  const query=normalize(text);
  return candidates.filter(m=>centralRuleStatus(r,m).effective&&(!region||m.attributes.central_rule.region===region)&&(automaticImplicit(m)?r.implicitLearning.matches(m,text):m.attributes.central_rule.keywords.some(k=>query.includes(normalize(k)))))
    .sort((a,b)=>Number(automaticImplicit(b))-Number(automaticImplicit(a))||a.attributes.central_rule.activated_at-b.attributes.central_rule.activated_at||a.id.localeCompare(b.id));
}

export function centralRules(r,{scope='all',region=null}={}){
  r.requireScope(scope,true);if(region&&!RULE_PARAMS[region])fail('工作中枢不存在');
  const all=r.store.all(scope),items=all.filter(m=>m.attributes.central_rule&&(!region||m.attributes.central_rule.region===region));
  const summarize=m=>({id:m.id,scope:m.scope,label:m.label,layer:m.layer,revision:m.revision,condition:m.attributes.trigger_condition,rule:m.attributes.central_rule??null,...centralRuleStatus(r,m)});
  return {items:items.map(summarize),candidates:all.filter(m=>['pattern','method'].includes(m.kind)&&m.validity==='current'&&m.layer!=='implicit').sort((a,b)=>b.updated_at-a.updated_at).slice(0,80).map(summarize),
    controls:Object.fromEntries(Object.entries(RULE_PARAMS).map(([id,keys])=>[id,{name:REGIONS.find(region=>region.id===id).name,params:Object.fromEntries(keys.map(key=>[key,PARAMS[id][key]]))}])),
    constraints:'按来源、版本、范围和明确条件启用；规则只调整对应工作参数，不覆盖事实、权限或保护约束。'};
}

export function proposeCentralRule(r,{scope,id,expected_revision,principle,condition,reason}={}){
  r.requireScope(scope);const parent=r.memory(id,scope);
  if(parent.revision!==expected_revision)fail('来源版本已改变','REVISION_CONFLICT');
  if(parent.layer==='forgotten'||!r.body(parent)||parent.source_refs.some(s=>!r.store.getSource(s)))fail('提炼准则需要仍可核对的来源');
  if(typeof principle!=='string'||principle.trim().length<3||principle.length>800||typeof condition!=='string'||condition.trim().length<2||condition.length>160||typeof reason!=='string'||!reason.trim())fail('请填写准则、明确适用条件和核对理由');
  let memory,run;
  r.store.tx(()=>{
    const review=r.feedback({scope,id,text:`准则提炼：${principle}\n适用条件：${condition}\n核对依据：${reason}`,kind:'rule_derivation'});
    memory=r.derive(parent,{id:'principle:'+randomUUID(),kind:'pattern',label:'行为准则 · '+principle.trim().slice(0,30),body:principle.trim(),protection:'P1',review:'ready',source_refs:unique([...parent.source_refs,review.receipt.source_id]),
      attributes:{trigger_condition:condition.trim(),explicit_statement:true,operator_authored:true,supports:[],counterexamples:[],pattern_gain:0,derivation_reason:reason.trim(),basis_refs:[{id:parent.id,revision:parent.revision}]},representation:['conditional_principle']});
    run=r.beginRun(scope,'principle_derivation');
    r.event(run,'W5','U','核对准则依据，重要原证据继续保留',{input:[id],output:[id]});
    r.event(run,'U','L:mature','从来源提炼带条件的行为准则，尚未接入中枢',{input:[id],output:[memory.id],extra:{memory_id:memory.id,from_layer:parent.layer,to_layer:'mature',operator_reviewed:true}});
    r.endRun(run);
  });
  r.rebuildCatalogs(scope);return {memory,run_id:run.id};
}

export function writeCentralRule(r,{scope,id,expected_revision,action='activate',region,param,value,condition,reason}={}){
  r.requireScope(scope);let m=r.memory(id,scope);
  if(m.revision!==expected_revision)fail('准则版本已改变，请重新打开','REVISION_CONFLICT');
  const enabling=['activate','reconfirm'].includes(action);
  if(action==='reconfirm'&&!m.attributes.central_rule)fail('首次模型候选请先完成来源核对');
  if(!['activate','reconfirm','pause','revoke'].includes(action)||typeof reason!=='string'||!reason.trim())fail('请选择规则操作并填写理由');
  if(enabling){
    if(m.kind!=='pattern'||m.validity!=='current'||(m.review==='needs_review'&&action!=='reconfirm')||!m.source_refs.length||m.source_refs.some(s=>!r.store.getSource(s)))fail('先核对有来源、当前有效的图式；普通事实请先提炼条件准则');
    if((m.attributes.basis_refs??[]).some(b=>{const p=r.store.getMemory(b.id);return !p||p.scope!==scope||p.validity!=='current'||p.review==='needs_review';}))fail('上游依据尚未核对或已失效');
    const definition=PARAMS[region]?.[param];
    if(!RULE_PARAMS[region]?.includes(param)||!definition||!Number.isFinite(value)||value<definition[1]||value>definition[2])fail('规则只能调整子面板中允许的工作参数');
    const words=keywords(condition);if(!words.length||words.length>8||words.some(w=>w.length<2||w.length>40))fail('填写 1～8 个明确条件关键词，每个 2～40 字，用逗号分开');
    if(r.store.sql("SELECT count(*) n FROM memories WHERE scope=? AND layer='implicit'").get(scope).n>=32&&m.layer!=='implicit')fail('本范围最多保留 32 条中枢准则，请先暂停不再使用的规则');
  }else if(!m.attributes.central_rule)fail('这条记忆尚未接入工作中枢');
  let run;
  r.store.tx(()=>{
    const previous=m.attributes.central_rule,from=m.layer;
    m.attributes.rule_history=[...(m.attributes.rule_history??[]),{at:r.clock(),action,reason:reason.trim(),previous:previous??null}].slice(-20);
    if(enabling){
      const review=r.feedback({scope,id,text:`中枢准则核对：${reason}`,kind:'rule_review'});
      m.source_refs=unique([...m.source_refs,review.receipt.source_id]);
      m.attributes.central_rule={status:'active',region,param,value,keywords:keywords(condition),condition,activated_at:r.clock(),version:(previous?.version??0)+1,approved_revision:m.revision+1,review_source:review.receipt.source_id};
      m.layer='implicit';m.review='ready';m.protection=m.protection==='P0'?'P0':'P1';m.representation=unique([...m.representation,'implicit_influence']);
    }else{m.attributes.central_rule={...previous,status:action==='pause'?'paused':'revoked',changed_at:r.clock()};m.layer='mature';}
    m.revision++;m.updated_at=r.clock();r.store.putMemory(m);
    run=r.beginRun(scope,'central_rule_'+action);
    r.event(run,'L:mature','L:implicit',enabling?'核对后的条件准则成为内隐影响':'暂停或撤回内隐准则',{input:[id],output:[id],extra:{memory_id:id,from_layer:from,to_layer:m.layer,rule_status:m.attributes.central_rule.status}});
    r.event(run,'L:implicit',m.attributes.central_rule.region,enabling?'安装中枢规则投影，匹配条件才应用':'中枢规则投影已停用',{input:[id],output:[id],extra:{rule_version:m.attributes.central_rule.version,active:enabling}});r.endRun(run);
  });
  r.rebuildCatalogs(scope);return {memory:m,run_id:run.id,status:centralRuleStatus(r,m)};
}
