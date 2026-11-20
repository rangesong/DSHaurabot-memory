import {digest} from './v5-store.js';
import {FEEDBACK_POLICY,EFFECT_TEXT,feedbackCondition,feedbackConditionMatches,normalizeFeedback} from './v5-feedback.js';

const unique=a=>[...new Set(a)],origin='feedback_maturation',algorithm='feedback-maturation/1';
const effects={brief:{param:'detail_level',direction:-1,text:'类似情境中减少冗长解释；本轮要求详细时仍充分说明。'},less_followup:{param:'followup_pressure',direction:-1,text:EFFECT_TEXT.less_followup},warm_presence:{param:'style_accommodation',direction:1,text:EFFECT_TEXT.warm_presence},receive_comfort:{param:'style_accommodation',direction:1,text:EFFECT_TEXT.receive_comfort},playful:{param:'style_accommodation',direction:1,text:EFFECT_TEXT.playful}};
export const automaticImplicit=m=>m?.attributes.central_rule?.origin===origin;
const day=time=>new Date(time+8*3600000).toISOString().slice(0,10);

/** Local maturation of scoped expression evidence, never of factual truth or permissions. */
export class V5ImplicitLearning {
  constructor(r){this.r=r;}
  memories(scope='all'){return this.r.store.sql("SELECT json FROM memories WHERE kind='pattern' AND validity='current' AND layer!='forgotten'"+(scope==='all'?'':' AND scope=?')).all(...(scope==='all'?[]:[scope])).map(row=>this.r.store.decodeMemory(row.json));}
  sourceAllowed(source,scope,allowSource){return source?.scope===scope&&this.r.groupLifecycle().sourceFull(source)&&allowSource(source);}
  evidence(feedback,scope,allowSource=()=>true){
    if(!feedback||feedback.scope!==scope||feedback.status!=='active'||feedback.policy!==FEEDBACK_POLICY||feedback.interpretation.review_pending)return null;
    const turn=this.r.dialogue.get('dialogue_turns',feedback.turn_id),i=feedback.interpretation;
    if(!turn?.reply||turn.scope!==scope||!this.r.dialogue.validTurn(turn)||i.correction||['factual_correction','factual_confirmation','task_pending','unknown'].includes(i.meaning))return null;
    const condition=i.condition??feedbackCondition(turn.query,turn.reply);
    if(!Number.isSafeInteger(feedback.occurred_at)||feedback.occurred_at<=0||feedback.occurred_at>this.r.clock()||typeof feedback.independent_root!=='string'||!feedback.independent_root)return null;
    const refs=unique([feedback.source_ref,...turn.input_source_ids,...(feedback.corrected_by?[feedback.corrected_by]:[])]);
    if(!refs.length||!refs.every(id=>{const s=this.r.dialogue.activeSource(id);return s?.role==='user'&&this.sourceAllowed(s,scope,allowSource);}))return null;
    if(i.inferred&&!feedback.corrected_by&&feedback.model_review?.meaning!==i.meaning)return null;
    const selected=(i.effects??[]).filter(effect=>effects[effect]);
    if(i.approval&&!i.inferred){const prior=turn.strategy?.controls??{},base=this.r.config.W4;if(prior.detail_level<base.detail_level)selected.push('brief');if(prior.followup_pressure<base.followup_pressure)selected.push('less_followup');if(prior.style_accommodation>base.style_accommodation)selected.push('warm_presence');}
    return {feedback,turn,condition,refs,root:feedback.independent_root,day:day(feedback.occurred_at),effects:unique(selected)};
  }
  assess(m,{allowSource=()=>true}={}){
    const empty=reason=>({eligible:false,reason,independent:0,days:0});
    if(!this.r.config.W3.auto_implicit_enabled)return empty('自动成熟已关闭');
    if(m.kind!=='pattern'||!m.attributes.dialogue_learning||m.review!=='ready'||m.validity!=='current'||m.layer==='forgotten')return empty('图式或依据尚未就绪');
    if(m.attributes.central_rule)return empty('已有中枢规则，不自动覆盖或恢复');
    if(m.attributes.counterexamples?.length)return empty('已有反例，需要先核对');
    if(!m.source_refs.length||!m.source_refs.every(id=>this.sourceAllowed(this.r.dialogue.activeSource(id),m.scope,allowSource)))return empty('部分原始依据已退出或不可读取');
    const candidates=new Map(),seenRoots=new Set(),seenTurns=new Set();
    for(const id of m.attributes.feedback_ids??[]){const e=this.evidence(this.r.dialogue.get('dialogue_feedback',id),m.scope,allowSource);if(!e||e.condition!==m.attributes.trigger_condition||!e.root||seenRoots.has(e.root)||seenTurns.has(e.turn.id))continue;seenRoots.add(e.root);seenTurns.add(e.turn.id);
      for(const effect of e.effects){const rows=candidates.get(effect)??[];rows.push(e);candidates.set(effect,rows);}
    }
    const [effect,rows=[]]=[...candidates].sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0]))[0]??[];
    const days=new Set(rows.map(e=>e.day)).size,result={eligible:false,reason:'独立且已复核的同情境依据不足',independent:rows.length,days,effect};
    if(rows.length<this.r.config.W3.implicit_min_evidence||days<this.r.config.W3.auto_implicit_min_days)return result;
    if(rows.length<seenRoots.size*.75)return {...result,reason:'同情境的表达线索不一致'};
    const competing=this.r.dialogue.feedbackList({scope:m.scope,limit:80}).items.some(f=>f.status==='active'&&f.interpretation.dissatisfied&&!f.interpretation.inferred&&feedbackConditionMatches(f.interpretation.condition??'',m.attributes.trigger_condition));
    if(competing&&effects[effect].direction>0)return {...result,reason:'同情境存在明确不满意，先保留为图式'};
    const param=effects[effect].param,base=this.r.config.W4[param],step=Math.min(this.r.config.W3.learning_step_cap,this.r.config.W3.feedback_learning_rate*this.r.config.W5.learning_rate*rows.length),value=Math.max(0,Math.min(1,base+effects[effect].direction*step));
    if(!step||value===base)return {...result,reason:'自动调整幅度为零'};
    if(this.memories(m.scope).some(x=>x.attributes.central_rule?.status==='active'&&!automaticImplicit(x)&&x.attributes.central_rule.param===param&&x.attributes.central_rule.keywords.some(k=>feedbackConditionMatches(m.attributes.trigger_condition,k))))return {...result,reason:'同情境已有人工中枢规则'};
    return {...result,eligible:true,reason:'独立依据、时间跨度及方向检查通过',param,base,value,step,rows};
  }
  proof(m,{allowSource=()=>true}={}){
    const rule=m.attributes.central_rule,v=rule?.validation;
    if(!automaticImplicit(m)||v?.algorithm!==algorithm||!Array.isArray(v.evidence)||!effects[v.effect]||rule.region!=='W4'||effects[v.effect].param!==rule.param)return {valid:false,reason:'自动准则缺少可核对的成熟依据'};
    if(!this.r.config.W3.auto_implicit_enabled)return {valid:false,reason:'自动成熟已关闭'};
    if(v.config_fingerprint!==digest(this.r.config.W4))return {valid:false,reason:'用户已修改表达参数，自动准则让位'};
    const expected=Math.max(0,Math.min(1,v.baseline+effects[v.effect].direction*v.step));
    if(!Number.isFinite(v.step)||v.step<=0||v.step>this.r.config.W3.learning_step_cap||rule.value!==expected||v.step>this.r.config.W3.feedback_learning_rate*this.r.config.W5.learning_rate*v.evidence.length)return {valid:false,reason:'自动准则超出当前学习幅度'};
    const roots=new Set(),turns=new Set(),days=new Set();
    for(const item of v.evidence){const e=this.evidence(this.r.dialogue.get('dialogue_feedback',item.id),m.scope,allowSource);if(!e||e.feedback.revision!==item.revision||e.turn.id!==item.turn_id||e.root!==item.root||e.condition!==rule.condition||!e.effects.includes(v.effect)||roots.has(e.root)||turns.has(e.turn.id)||!e.refs.every(id=>m.source_refs.includes(id)))return {valid:false,reason:'成熟依据已变化、退出或不可读取'};roots.add(e.root);turns.add(e.turn.id);days.add(e.day);}
    if(roots.size<this.r.config.W3.implicit_min_evidence||days.size<this.r.config.W3.auto_implicit_min_days)return {valid:false,reason:'未达到当前独立依据门槛'};
    for(const item of v.outcomes??[]){const e=this.evidence(this.r.dialogue.get('dialogue_feedback',item.id),m.scope,allowSource);if(!e||e.feedback.revision!==item.revision)return {valid:false,reason:'后续验证依据已更正或退出'};}
    return {valid:true,reason:v.phase==='verified'?'已有后续独立反馈支持':'依据检查通过，正在小幅试用',independent:roots.size,days:days.size,phase:v.phase};
  }
  transition(m,status,reason){
    const rule=m.attributes.central_rule;if(rule.status===status)return;
    const from=m.layer;rule.status=status;rule.changed_at=this.r.clock();rule.stop_reason=reason;m.layer='mature';m.revision++;m.updated_at=this.r.clock();
    m.attributes.rule_history=[...(m.attributes.rule_history??[]),{at:this.r.clock(),action:status,reason,origin}].slice(-32);this.r.store.putMemory(m);
    const run=this.r.beginRun(m.scope,'implicit_'+status);this.r.event(run,'L:implicit','L:mature','自动内隐准则停止生效',{input:[m.id],output:[m.id],extra:{from_layer:from,to_layer:'mature',reason}});this.r.endRun(run);this.r.dialogue.activity({scope:m.scope,category:'learning',title:'内隐准则已'+(status==='revoked'?'撤回':'暂停'),status,detail:{memory_id:m.id,reason},source_refs:m.source_refs});
  }
  reconcile(scope='all',allowSource=()=>true){let stopped=0;for(const m of this.memories(scope).filter(automaticImplicit)){if(m.attributes.central_rule.status!=='active')continue;const proof=this.proof(m,{allowSource});if(!proof.valid||m.review!=='ready'||m.attributes.counterexamples?.length){this.transition(m,'paused',proof.valid?'反馈反例或图式修订需要核对':proof.reason);stopped++;}}return {stopped};}
  mature({allowSource=()=>true}={}){
    if(!this.r.config.W3.auto_implicit_enabled||!this.r.maintenanceWindow().allowed)return {promoted:0,reason:'disabled_or_outside_night'};
    this.reconcile('all',allowSource);let promoted=0;
    for(const m of this.memories().filter(x=>x.attributes.dialogue_learning&&!x.attributes.central_rule)){
      if(promoted>=this.r.config.W5.batch_size)break;
      const a=this.assess(m,{allowSource});if(!a.eligible)continue;
      if(this.r.store.sql("SELECT count(*) n FROM memories WHERE scope=? AND layer='implicit'").get(m.scope).n>=32)continue;
      const at=this.r.clock(),from=m.layer;
      m.attributes.central_rule={origin,status:'active',region:'W4',param:a.param,value:a.value,condition:m.attributes.trigger_condition,keywords:[m.attributes.trigger_condition],activated_at:at,version:1,approved_revision:m.revision+1,
        validation:{algorithm,phase:'trial',effect:a.effect,baseline:a.base,step:a.step,config_fingerprint:digest(this.r.config.W4),independent_days:a.days,evidence:a.rows.map(e=>({id:e.feedback.id,revision:e.feedback.revision,root:e.root,turn_id:e.turn.id})),outcomes:[]}};
      m.attributes.rule_history=[...(m.attributes.rule_history??[]),{at,action:'automatic_trial',reason:a.reason,origin}];m.attributes.pre_maturation_body=m.body;m.source_refs=unique([...m.source_refs,...a.rows.flatMap(e=>e.refs)]);
      m.body=`在${m.attributes.trigger_condition}情境下：${effects[a.effect].text}`;m.label='内隐准则 · '+m.attributes.trigger_condition;m.layer='implicit';m.protection='P1';m.protection_reason='有独立互动依据的可撤回表达准则；保护必要依据，不代表事实核实';m.representation=unique([...m.representation,'implicit_influence']);m.revision++;m.updated_at=at;
      this.r.store.tx(()=>{this.r.store.putMemory(m,m.body);const run=this.r.beginRun(m.scope,'automatic_implicit_maturation');this.r.event(run,'L:mature','L:implicit','独立反馈经验自动成熟为试用内隐准则',{input:[m.id],output:[m.id],extra:{memory_id:m.id,from_layer:from,to_layer:'implicit',independent:a.rows.length,days:a.days}});this.r.event(run,'L:implicit','W4','条件准则接入表达中枢',{input:[m.id],output:[m.id],extra:{param:a.param,value:a.value}});this.r.endRun(run);});promoted++;
    }
    if(promoted){this.r.rebuildCatalogs();this.r.dialogue.activity({category:'learning',title:'经验自动成熟为内隐准则',status:'trial',detail:{promoted}});}return {promoted};
  }
  managedConditions(scope){return new Set(this.memories(scope).filter(m=>m.attributes.dialogue_learning&&m.attributes.central_rule).map(m=>m.attributes.central_rule.condition));}
  retrievable(m,query){return !automaticImplicit(m)||m.layer==='implicit'&&m.review==='ready'&&m.validity==='current'&&m.attributes.central_rule.status==='active'&&m.attributes.central_rule.approved_revision===m.revision&&this.proof(m).valid&&this.matches(m,query);}
  matches(m,query){
    const condition=m.attributes.central_rule.condition;if(feedbackConditionMatches(condition,query))return true;
    const recent=this.r.dialogue.feedbackList({scope:m.scope,limit:12}).items.find(f=>normalizeFeedback(f.text).trim()===normalizeFeedback(query).trim()&&this.r.clock()-f.created_at>=0&&this.r.clock()-f.created_at<60000);
    return recent?.interpretation.condition===condition&&this.r.dialogue.validTurn(this.r.dialogue.get('dialogue_turns',recent.turn_id));
  }
  observe(feedback,turn){
    for(const id of turn?.rule_ids??[]){const m=this.r.store.getMemory(id);if(!automaticImplicit(m)||m.scope!==feedback.scope||m.attributes.central_rule.status!=='active')continue;const rule=m.attributes.central_rule,v=rule.validation;
      if(feedback.created_at<rule.activated_at||v.evidence.some(e=>e.root===feedback.independent_root||e.turn_id===turn.id)||(v.outcomes??[]).some(e=>e.root===feedback.independent_root||e.turn_id===turn.id))continue;
      if(feedback.interpretation.dissatisfied||feedback.interpretation.correction){this.transition(m,'paused','实际应用后出现明确不满意或纠正');continue;}
      const e=this.evidence(feedback,m.scope);if(!e||(!e.effects.includes(v.effect)&&!feedback.interpretation.approval))continue;
      if(v.outcomes.length>=64)continue;
      v.outcomes.push({id:feedback.id,revision:feedback.revision,root:e.root,turn_id:turn.id,at:this.r.clock()});
      // Inferred affection validates only its contextual expression direction, never factual accuracy.
      if(v.outcomes.length>=this.r.config.W5.strategy_trial_feedback)v.phase='verified';
      m.source_refs=unique([...m.source_refs,...e.refs]);m.revision++;rule.approved_revision=m.revision;m.updated_at=this.r.clock();this.r.store.putMemory(m);
      this.r.dialogue.activity({scope:m.scope,category:'learning',title:v.phase==='verified'?'内隐准则获得后续独立反馈支持':'记录了内隐准则的后续反馈',status:v.phase,detail:{memory_id:m.id,outcomes:v.outcomes.length},source_refs:e.refs});
    }
  }
  list({scope='all',limit=20,offset=0}={}){
    this.r.requireScope(scope,true);limit=Math.min(50,Math.max(1,Number(limit)||20));offset=Math.max(0,Number(offset)||0);
    const all=this.memories(scope).filter(m=>m.attributes.dialogue_learning||automaticImplicit(m)).sort((a,b)=>b.updated_at-a.updated_at||a.id.localeCompare(b.id));
    const summarize=m=>{const rule=m.attributes.central_rule,a=automaticImplicit(m)?this.proof(m):this.assess(m),v=rule?.validation;return {id:m.id,scope:m.scope,label:m.label,layer:m.layer,revision:m.revision,condition:m.attributes.trigger_condition,body:m.body,status:rule?.status??'candidate',stage:v?.phase??'candidate',reason:rule?.stop_reason??a.reason,independent:v?.evidence.length??a.independent,days:v?.independent_days??a.days,outcomes:v?.outcomes.length??0,effective:automaticImplicit(m)&&rule.status==='active'&&m.review==='ready'&&a.valid,rule:rule??null,source_count:m.source_refs.length,history:m.attributes.rule_history??[]};};
    return {items:all.slice(offset,offset+limit).map(summarize),has_more:all.length>offset+limit,next_offset:Math.min(all.length,offset+limit),enabled:!!this.r.config.W3.auto_implicit_enabled,model_calls:0};
  }
}
