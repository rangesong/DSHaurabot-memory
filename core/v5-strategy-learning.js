import {digest} from './v5-store.js';
import {feedbackCondition,feedbackConditionMatches} from './v5-feedback.js';

const active=s=>['trial','verified'].includes(s),unique=a=>[...new Set(a)];
const issues=[{param:'detail_level',match:/啰嗦|太长|说太多|简短一点|简洁一点/,label:'类似情境下减少冗长说明'},
  {param:'followup_pressure',match:/追问|问太多|别再问|不要问/,label:'类似情境下减少连续追问'}];
export const STRATEGY_LABELS={trial:'正在试用，等待后续反馈',verified:'已有后续反馈支持，继续观察',rolled_back:'已撤回',rejected:'回放检查未通过',expired:'已到期，等待新的依据'};

/** Scoped expression experiments. Never changes facts, retention, permissions or model weights. */
export class V5StrategyLearning{
  constructor(r){this.r=r;r.store.db.exec(`CREATE TABLE IF NOT EXISTS strategy_trials(id TEXT PRIMARY KEY,scope TEXT NOT NULL,created INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS strategy_trial_scope ON strategy_trials(scope,created DESC);
    CREATE INDEX IF NOT EXISTS strategy_trial_active ON strategy_trials(scope,json_extract(json,'$.status'),created DESC);`);}
  get(id){const row=this.r.store.sql('SELECT json FROM strategy_trials WHERE id=?').get(id);return row?JSON.parse(row.json):null;}
  save(row){this.r.store.sql('INSERT INTO strategy_trials VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(row.id,row.scope,row.created_at,JSON.stringify(row));return row;}
  rows(scope,{activeOnly=false,limit=160,offset=0}={}){const where=[],args=[];if(scope!=='all'){where.push('scope=?');args.push(scope);}if(activeOnly)where.push("json_extract(json,'$.status') IN ('trial','verified')");if(!activeOnly)args.push(limit,offset);return this.r.store.sql('SELECT json FROM strategy_trials'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY created DESC,id DESC'+(activeOnly?'':' LIMIT ? OFFSET ?')).all(...args).map(x=>JSON.parse(x.json));}
  transition(row,status,reason){if(row.status===status)return;row.status=status;row.updated_at=this.r.clock();row.history.push({at:row.updated_at,status,reason});this.save(row);
    this.r.dialogue.activity({id:'strategy:'+row.id,scope:row.scope,category:'learning',title:'自省策略：'+STRATEGY_LABELS[status],status,source_refs:row.source_refs,detail:{trial_id:row.id,reason,param:row.param,value:row.value}});}
  evidenceValid(row,allowSource=()=>true){return row.source_refs.every(id=>{const s=this.r.store.getSource(id);return s?.scope===row.scope&&allowSource(s);})&&Object.entries(row.evidence_revisions).every(([id,revision])=>{const f=this.r.dialogue.get('dialogue_feedback',id);return f?.status==='active'&&f.revision===revision&&this.r.dialogue.validTurn(this.r.dialogue.get('dialogue_turns',f.turn_id));});}
  reconcile(scope,allowSource=()=>true){const rows=this.rows(scope,{activeOnly:true});for(const row of rows){
    if(!this.evidenceValid(row,allowSource)||row.outcomes.some(o=>{const f=this.r.dialogue.get('dialogue_feedback',o.feedback_id);return !f||f.status!=='active'||f.revision!==o.revision;}))this.transition(row,'rolled_back','支持依据已更正、撤回或不可读取');
    else if(row.config_fingerprint!==digest(this.r.config.W4))this.transition(row,'rolled_back','用户已修改表达参数，自动策略让位于当前设置');
    else if(this.r.clock()>=row.expires_at)this.transition(row,'expired','本轮试用有效期已结束');
  }return rows.filter(row=>active(row.status));}
  list({scope='all',limit=20,offset=0}={}){this.r.requireScope(scope,true);this.reconcile(scope);limit=Math.max(1,Math.min(40,Number(limit)||20));offset=Math.max(0,Number(offset)||0);const rows=this.rows(scope,{limit:limit+1,offset});return {items:rows.slice(0,limit).map(row=>({...row,status_label:STRATEGY_LABELS[row.status]})),has_more:rows.length>limit,next_offset:offset+limit};}
  prepareNight({scope,reflection_id,allowSource=()=>true,proposals=[]}={}){
    this.r.requireScope(scope);if(!this.r.config.W5.self_strategy_enabled||!this.r.maintenanceWindow().allowed)return {created:0,ids:[],reason:'disabled_or_outside_night'};
    this.reconcile(scope,allowSource);
    const groups=new Map(),minimum=this.r.config.W5.strategy_min_evidence;
    for(const f of this.r.dialogue.feedbackList({scope,limit:80}).items){
      const turn=this.r.dialogue.get('dialogue_turns',f.turn_id);
      if(f.status!=='active'||!f.interpretation.dissatisfied||f.interpretation.inferred||!this.r.dialogue.validTurn(turn)||this.r.clock()-f.occurred_at>30*86400000)continue;
      const refs=unique([f.source_ref,...turn.input_source_ids]);if(!refs.every(id=>{const s=this.r.store.getSource(id);return s&&allowSource(s);}))continue;
      for(const issue of issues.filter(issue=>issue.match.test(f.text))){const condition=f.interpretation.condition??feedbackCondition(turn.query,turn.reply);if(condition.length<2)continue;
        const key=condition+'|'+issue.param,group=groups.get(key)??{...issue,condition,items:[],roots:new Set(),turns:new Set()};
        if(group.roots.has(f.independent_root)||group.turns.has(turn.id))continue;group.items.push({f,turn,refs});group.roots.add(f.independent_root);group.turns.add(turn.id);groups.set(key,group);
      }
    }
    // Model suggestions can prioritize a grounded issue; they cannot authorize arbitrary parameter changes.
    const ranked=[...groups.values()].sort((a,b)=>Number(proposals.some(p=>p.parameter===b.param&&p.condition===b.condition))-Number(proposals.some(p=>p.parameter===a.param&&p.condition===a.condition))||b.items.length-a.items.length),ids=[];
    for(const group of ranked){if(ids.length>=1||group.items.length<minimum)continue;
      if(this.rows(scope,{activeOnly:true}).some(row=>active(row.status)&&row.param===group.param&&row.condition===group.condition))continue;
      const evidence=group.items.map(x=>[x.f.id,x.f.revision]).sort(),id='strategy:'+digest([scope,group.condition,group.param,evidence]);if(this.get(id))continue;
      const step=Math.min(.12,this.r.config.W3.learning_step_cap),base=this.r.config.W4[group.param],value=Math.max(0,base-step);
      const replay=group.items.map(({turn},i)=>{const before=this.r.dialogue.strategy(scope,turn.query,{skip_learning:true,memory_filter:m=>m.source_refs.every(id=>allowSource(this.r.store.getSource(id))),source_filter:allowSource}).controls[group.param];return {turn_id:turn.id,partition:i===0?'discovery':'held_out',before,after:Math.min(before,value),improvement:Math.max(0,before-value)};});
      const passed=step>0&&replay.some(c=>c.partition==='held_out'&&c.improvement>0),now=this.r.clock();
      const row={id,scope,reflection_id,created_at:now,updated_at:now,expires_at:now+14*86400000,status:passed?'trial':'rejected',problem:group.label,condition:group.condition,param:group.param,baseline:base,value,step,source_refs:unique(group.items.flatMap(x=>x.refs)),evidence_revisions:Object.fromEntries(evidence),discovery_roots:[...group.roots],config_fingerprint:digest(this.r.config.W4),
        replay:{passed,kind:'policy_replay_not_reply_quality',cases:replay,baseline_approval_rate:0},outcomes:[],history:[{at:now,status:'problem_found',reason:group.items.length+'次独立明确表达纠正'},{at:now,status:passed?'trial':'rejected',reason:passed?'条件回放显示目标方向改善；真实回复效果等待后续反馈':'回放未显示额外改善，保持原策略'}]};
      this.save(row);ids.push(id);this.r.dialogue.activity({id:'strategy:'+id,scope,category:'learning',title:'自省发现表达问题并'+(passed?'开始小幅试用':'保持原策略'),status:row.status,source_refs:row.source_refs,detail:{trial_id:id,reflection_id,param:group.param,value,replay:row.replay}});
    }
    return {created:ids.length,ids};
  }
  apply(scope,query,controls,{allowSource=()=>true}={}){
    if(!this.r.config.W5.self_strategy_enabled)return {ids:[],notes:[]};const rows=this.reconcile(scope,allowSource),ids=[],notes=[];
    for(const row of rows.filter(row=>feedbackConditionMatches(row.condition,query))){const before=controls[row.param];controls[row.param]=Math.min(before,row.value);if(before!==controls[row.param]){ids.push(row.id);notes.push('夜间自省策略'+(row.status==='verified'?'（已有后续反馈支持）':'（小幅试用，效果待验证）')+'：'+row.problem+'。');}}
    return {ids,notes};
  }
  observe(feedback,turn){
    if(!this.r.config.W5.self_strategy_enabled)return;
    for(const id of turn?.strategy?.experiment_ids??[]){const row=this.get(id);if(!row||!active(row.status)||row.scope!==feedback.scope||!this.evidenceValid(row))continue;
      if(feedback.created_at<row.created_at||(row.discovery_roots??[]).includes(feedback.independent_root)||row.outcomes.some(o=>o.turn_id===turn.id||o.root===feedback.independent_root))continue;
      const i=feedback.interpretation;if(i.inferred||(!i.approval&&!i.dissatisfied)||i.correction)continue;
      row.outcomes.push({feedback_id:feedback.id,revision:feedback.revision,turn_id:turn.id,root:feedback.independent_root,source_ref:feedback.source_ref,score:i.approval?1:0,at:this.r.clock()});
      row.source_refs=unique([...row.source_refs,feedback.source_ref,...turn.input_source_ids]);this.save(row);
      const negative=row.outcomes.filter(o=>!o.score).length,min=this.r.config.W5.strategy_trial_feedback,rate=row.outcomes.reduce((n,o)=>n+o.score,0)/row.outcomes.length;
      if(negative>=2)this.transition(row,'rolled_back','试用后出现两次独立明确不满意，自动撤回');
      else if(row.outcomes.length>=min&&rate>=.75&&rate>row.replay.baseline_approval_rate)this.transition(row,'verified','后续'+row.outcomes.length+'次独立明确反馈支持；仍继续观察反例');
    }
  }
  revoke({scope,id}={}){this.r.requireScope(scope);const row=this.get(id);if(!row||row.scope!==scope)throw Error('策略不在当前范围');this.transition(row,'rolled_back','用户手动撤回');return row;}
  eraseScopes(scopes){for(const scope of scopes)this.r.store.sql('DELETE FROM strategy_trials WHERE scope=?').run(scope);}
}
