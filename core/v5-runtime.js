import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { V5Store, digest, scopeId } from './v5-store.js';
import { DEFAULT_CONFIG, PARAMS, REGIONS, LAYERS, CHANNELS, HARD_RULES, HANDOFF, DAY, LIMITS, GROUP_POLICY_KEYS } from './v5-config.js';
import { bm25Scores,relevantQueryTerms } from './v5-retrieval.js';
import { backtraceOriginals } from './v5-evidence.js';
import { contextReport } from './v5-insights.js';
import { factIndex,writeFact,restoreFact } from './v5-facts.js';
import { V5Archive } from './v5-archive.js';
import { V5Trash } from './v5-trash.js';
import { maintenanceWindow } from './v5-maintenance.js';
import { makeGist } from './v5-retention.js';
import { GroupLifecycle, GROUP_POLICY_COVERAGE, GROUP_HOLD_LABELS, automaticGroupExperience } from './v5-group-lifecycle.js';
import { PARAM_HELP } from './v5-param-help.js';
import { centralRules,proposeCentralRule,writeCentralRule,resolveCentralRules,centralRuleStatus } from './v5-rules.js';
import { V5Dialogue } from './v5-dialogue.js';
import { V5Semantic } from './v5-semantic.js';
import {V5StrategyLearning} from './v5-strategy-learning.js';
import {V5ImplicitLearning} from './v5-implicit-learning.js';
import {V5SelfReflection} from './v5-self-reflection.js';

const clone=structuredClone, now=()=>Date.now(), short=(s,n=48)=>Array.from(s??'').slice(0,n).join('');
const fail=(message,code='INVALID_INPUT')=>{throw Object.assign(new Error(message),{code});};
const unique=(a)=>[...new Set(a)];
export function termsOf(value){const words=value.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_:-]{2,}|[\p{Script=Han}]{2,}/gu)??[];return unique(words.flatMap(w=>/\p{Script=Han}/u.test(w)?[w,...Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2))]:[w])).slice(0,20);}
export function assessContent(text,role='user') {
  const explicit=role==='user'&&/记住|务必保留|不要忘|不许公开|别告诉|保密|我的边界|必须记/.test(text);
  const critical=/承诺|答应|约定|截止|待办|提醒|改用|改成|改为|换成|取消|别用|不能|不要|关键|重要|约束|目标|预算.{0,8}\d|\d.{0,8}(?:毫克|万元|版本|端口)/.test(text);
  const low=text.trim().length<18&&/^(?:[哈呵嘿啊嗯哦呀唉好喔！!。，,.\s]+|你好[呀啊！!\s]*|早安[呀啊！!\s]*|晚安[呀啊！!\s]*|收到[！!\s]*|ok[!！\s]*)$/i.test(text.trim());
  return {protection:explicit?'P0':critical?'P1':low?'P3':'P2',importance:explicit?1:critical?.85:low?.08:.4,reason:explicit?'原话包含明确记住／边界信号':critical?'原话包含约束、纠正、意图或高误丢代价线索':low?'无新增约束的简短寒暄或重复回执':'普通近期来源；可后续追认为重要',goal_link:critical?.8:.2,uniqueness:low?.1:.5,loss_cost:critical?.9:.3};
}
const regionFor=(m)=>m.kind==='person'?['M3','M4']:m.kind==='pattern'?['M3','M2']:m.kind==='intent'?['M2','M4','M1']:m.kind==='raw'?['M1','M4',...(m.attributes.speaker_id&&!m.attributes.speaker_id.includes('unattributed')?['M3']:[])]:['M1','M2',...(m.attributes.subject?['M3']:[]),'M4'];

/** Independent local V5 execution engine. No source-system mutation or remote generation. */
export class V5Runtime {
  constructor({file=':memory:',clock=now,onEvent=()=>{}}={}) {
    this.store=new V5Store(file);this.clock=clock;this.onEvent=onEvent;this.processing=false;
    const saved=this.store.meta('effective_config',DEFAULT_CONFIG);this.config=Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key,defaults])=>[key,{...defaults,...saved[key]}]));this.configVersion=this.store.meta('config_version',1);
    this.archive=new V5Archive(this);this.trash=new V5Trash(this);this.dialogue=new V5Dialogue(this);this.semantic=new V5Semantic(this);this.selfReflection=new V5SelfReflection(this);this.strategyLearning=new V5StrategyLearning(this);this.implicitLearning=new V5ImplicitLearning(this);
    const pendingErasure=this.store.meta('trash-erasure-pending',[]);if(pendingErasure.length){this.trash.purgeSources(pendingErasure);this.store.setMeta('trash-erasure-pending',[]);}
    this.live={enabled:false,status:'stopped',last_poll:null,last_change:null,source_access:'read_only',errors:[],new_messages:0};
    this.store.db.exec("UPDATE jobs SET status='retry' WHERE status='running'");
    if(!this.store.meta('lookup_header_v1')){this.store.tx(()=>{for(const m of this.store.all())this.store.putMemory(m,this.body(m)??'',{history:false});this.store.setMeta('lookup_header_v1',true);});}
    if(!this.store.meta('catalog_native_scope_v2')){this.rebuildCatalogs();this.store.setMeta('catalog_native_scope_v2',true);}
  }
  centralRules(options){return centralRules(this,options);}
  proposeCentralRule(options){return proposeCentralRule(this,options);}
  writeCentralRule(options){return writeCentralRule(this,options);}
  resolveRules(scope,text,region=null){return resolveCentralRules(this,scope,text,region);}
  controls(region,scope,text,run=null){const controls={...this.config[region]};for(const m of this.resolveRules(scope,text,region)){const rule=m.attributes.central_rule;controls[rule.param]=rule.value;if(run)this.event(run,'L:implicit',region,'匹配条件准则已用于本轮工作参数',{input:[m.id],output:[m.id],extra:{rule_version:rule.version,param:rule.param,value:rule.value,scope_isolated:true}});}return controls;}
  addScope(context,label=null){const id=scopeId(context);let found=this.store.getScope(id);if(!found){found={id,persona_id:context.persona_id,native_scope:context.scope,label:label??(context.scope.startsWith('private:')?'私聊 '+short(context.scope.slice(8),8):context.scope.startsWith('group:')?'群聊 '+short(context.scope.slice(6),8):context.scope==='local:workbench'?'本地验证台':context.scope.replace('aurabot:',''))};this.store.scope(found);}return found;}
  requireScope(id,all=false){if(all&&id==='all')return;const scope=this.store.getScope(id);if(!scope)fail('数据范围不存在','NOT_FOUND');return scope;}
  memory(id,scope){const m=this.store.getMemory(id);if(!m||(scope&&m.scope!==scope))fail('该范围没有这条记忆','NOT_FOUND');return m;}
  beginRun(scope,type,metadata={}){const run={id:randomUUID(),scope,type,created_at:this.clock(),status:'running',metadata};this.store.run(run);return run;}
  event(run,from,to,operation,{status='success',input=[],output=[],duration=0,count=output.length,reason=null,extra={}}={}){
    if(from!==to&&!CHANNELS.some(c=>[c.from,c.to].includes(from)&&[c.from,c.to].includes(to)))fail(`未注册通道 ${from} → ${to}`,'INVALID_CHANNEL');
    const e={id:randomUUID(),run_id:run.id,step_id:randomUUID(),parent_step_id:run.last_step??null,timestamp:this.clock(),source_region:from,target_region:to,operation,input_refs:input,output_refs:output,scope:run.scope,result_status:status,duration_ms:Math.max(0,duration),token_cost:0,selected_count:count,omitted_reason:reason,...extra};
    run.last_step=e.step_id;e.sequence=this.store.event(e);queueMicrotask(()=>this.onEvent(e));return e;
  }
  endRun(run,status='success'){run.status=status;run.finished_at=this.clock();this.store.run(run);return run;}
  body(memory){if(memory.layer==='forgotten')return null;if(memory.kind==='raw'&&!['gist_only','gist_with_evidence'].includes(memory.storage))return this.store.getSource(memory.source_refs[0])?.text??null;return memory.body??'';}
  sourcePage(memory,offset=0,limit=20){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('来源分页范围不正确');const available=memory.source_refs.map(id=>this.store.getSource(id)).filter(Boolean);return {sources:available.slice(offset,offset+limit),total:available.length,stored_total:memory.source_refs.length,next_offset:Math.min(offset+limit,available.length),has_more:offset+limit<available.length};}
  groupLifecycle(at){return new GroupLifecycle(this,at);}
  baseMemory(source,assessment){const at=this.clock();const m={id:`raw:${source.id}`,scope:source.scope,kind:'raw',label:short(source.text.replace(/\s+/g,' '),44)||'无文本来源',body:null,source_refs:[source.id],source_roots:[source.support_root],region_ids:[],layer:'recent',protection:assessment.protection,protection_reason:assessment.reason,importance:assessment.importance,strength:1,representation:['original_evidence'],storage:'full_hot',evidence:{origin:source.role==='assistant'?'role_expression':source.provenance?.kind?.startsWith('legacy')?'legacy_summary':source.role==='user'?'direct_statement':'document_record',alignment:'source_aligned',truth:'not_independently_verified'},validity:'current',review:'ready',occurred_at:source.occurred_at,time_precision:source.time_precision??'unknown',created_at:at,updated_at:at,revision:1,handoff:HANDOFF[0],used_count:0,last_used_at:null,attributes:{chat_id:source.chat_id,speaker_id:source.speaker_id,speaker_label:source.provenance?.speaker_label??source.speaker_id,topic:source.topic??null,assessment,original_source:source.provenance?.system??'thinkstar',delivery_status:source.delivery_status??'unknown'}};m.region_ids=regionFor(m);return m;}
  ingest({scope=null,context=null,text,command_id=randomUUID(),source_id=null,role='user',occurred_at=undefined,provenance={},process=false,topic=null}={}){
    if(typeof text!=='string'||!text.trim()||text.length>LIMITS.text)fail('请输入 1～1,000,000 字的原始内容');
    if(!['user','assistant','document','unknown'].includes(role))fail('未接入真实工具回执，不能伪造 tool 来源');
    const s=scope?this.requireScope(scope):this.addScope(context??{persona_id:'thinkstar:local',scope:'local:workbench'});
    const commandKey=`${s.id}:${command_id}`,requestHash=digest({scope:s.id,text,source_id,role,occurred_at:occurred_at===undefined?'receive_time':occurred_at,topic});const previous=this.store.sql('SELECT hash,json FROM commands WHERE id=?').get(commandKey);
    if(previous){if(previous.hash!==requestHash)fail('相同命令 ID 的内容已经改变','IDEMPOTENCY_CONFLICT');return {...JSON.parse(previous.json),replayed:true};}
    const run=this.beginRun(s.id,'ingest');const id=`${s.id}:input:${source_id??randomUUID()}`;const existing=this.store.getMemory(`raw:${id}`);if(existing)return {memory_id:existing.id,scope:s.id,run_id:null,replayed:true};
    const assessment=assessContent(text,role),state=this.store.state(s.id);
    const encoding=this.config.W1;assessment.importance=['P0','P1'].includes(assessment.protection)?assessment.importance:(encoding.goal_link*assessment.goal_link+encoding.loss_cost*assessment.loss_cost+encoding.uniqueness*assessment.uniqueness)/Math.max(.001,encoding.goal_link+encoding.loss_cost+encoding.uniqueness);if(!['P0','P1'].includes(assessment.protection)&&/我.{0,8}(开心|难过|担心|疲惫)/.test(text))assessment.importance=Math.min(.74,assessment.importance+encoding.emotion_bonus_cap);
    const occurrence=occurred_at===undefined?this.clock():occurred_at;if(occurrence!==null&&(!Number.isSafeInteger(occurrence)||occurrence<0))fail('发生时间无效');
    const source={id,scope:s.id,chat_id:s.native_scope,persona_id:s.persona_id,speaker_id:provenance.speaker_id??(role==='user'?'local:operator':'unattributed'),role,sequence:state.last_applied_sequence+1,text,occurred_at:occurrence,time_precision:occurrence===null?'unknown':'instant',recorded_at:this.clock(),provenance:{system:'thinkstar',kind:'local_panel',...provenance},support_root:provenance.support_root??id,delivery_status:role==='assistant'?'prepared':'not_applicable',topic};
    const memory=this.baseMemory(source,assessment),receipt={memory_id:memory.id,source_id:id,run_id:run.id,scope:s.id};
    if(this.store.storageBytes()>this.config.W5.capacity_mb*1024*1024)this.dialogue.activity({id:'capacity-warning',category:'status',title:'底座已超过容量预算，完整原话继续接收',status:'warning',detail:{budget_mb:this.config.W5.capacity_mb,policy:'night_maintenance_no_silent_original_loss'}});
    const t=performance.now();this.store.tx(()=>{
      this.store.source(source);this.archive.invalidatePeriod(s.id,source.occurred_at);this.store.putMemory(memory,text);this.store.job({id:`consolidate:${memory.id}`,scope:s.id,memory_id:memory.id,status:'pending',attempts:0,created_at:this.clock(),run_id:run.id});
      state.last_applied_sequence=source.sequence;state.source_refs=unique([...state.source_refs,id]).slice(-this.config.M4.span_messages);state.revision++;state.updated_at=this.clock();this.store.saveState(state);
      this.store.sql('INSERT INTO commands VALUES(?,?,?)').run(commandKey,requestHash,JSON.stringify(receipt));
    });
    this.event(run,'IN','W1','接受并核对输入',{input:[id],output:[memory.id]});
    this.event(run,'W1','U','原文与 outbox 已原子提交',{input:[id],output:[memory.id],duration:performance.now()-t});
    this.event(run,'U','L:recent','完整原话进入近事记忆',{output:[memory.id],extra:{memory_id:memory.id,to_layer:'recent',precision:'full'}});
    this.event(run,'U','W2','近期原话立即可读',{output:[memory.id]});
    this.event(run,'W1','W3','当前输入初评',{output:[memory.id],extra:{appraisal:this.appraise(text,[],false,s.id,run)}});
    this.event(run,'W2','W5','后台巩固已排队',{status:'queued',output:[memory.id]});
    if(process)this.processJobs();this.rebuildCatalogs(s.id);return receipt;
  }
  processJobs({scope=null}={}){if(scope)this.requireScope(scope);if(this.processing)return {skipped:true};this.processing=true;let done=0;const completed=[],affected=new Set();try{for(const job of this.store.jobs(this.config.W5.batch_size,scope)){
    const run=this.store.sql('SELECT json FROM runs WHERE id=?').get(job.consolidation_run_id??job.run_id);let trace=run?JSON.parse(run.json):this.beginRun(job.scope,'consolidate');if(trace.scope!==job.scope){trace=this.beginRun(job.scope,'consolidate',{source_run_id:job.run_id});job.consolidation_run_id=trace.id;}
    try{job.status='running';job.attempts++;this.store.updateJob(job);const t=performance.now();this.store.tx(()=>this.consolidate(job,trace));completed.push({job,trace,t});affected.add(job.scope);}
    catch(error){job.status=job.attempts<4?'retry':'failed';job.error=error.message;this.store.updateJob(job);this.event(trace,'W5','U','后台处理失败，原文保留',{status:'failed',input:[job.memory_id],reason:error.message});this.endRun(trace,'failed');}
  }for(const scope of affected)this.rebuildCatalogs(scope);for(const{job,trace,t}of completed){const m=this.memory(job.memory_id);m.handoff=HANDOFF[5];this.store.putMemory(m,null,{history:false});job.status='done';this.store.updateJob(job);this.event(trace,'W5','U','六阶段交接与定位入口校验完成',{output:[job.memory_id],duration:performance.now()-t});this.endRun(trace);done++;}}catch(error){for(const{job,trace}of completed){job.status=job.attempts<4?'retry':'failed';job.error=error.message;this.store.updateJob(job);this.event(trace,'W5','U','目录交接失败，原话仍可读',{status:'failed',reason:error.message});this.endRun(trace,'failed');}}finally{this.processing=false;}return {processed:done,pending:this.store.queuePending()};}
  consolidate(job,run){let m=this.memory(job.memory_id,job.scope);if(m.layer==='forgotten')return;const source=this.store.getSource(m.source_refs[0]);if(!source)fail('规范原文缺失','MISSING_SOURCE');
    const text=source.text,state=this.store.state(m.scope);
    m.handoff=HANDOFF[1];m.updated_at=this.clock();this.store.putMemory(m,null,{history:false});this.event(run,'U','W5','校验重要信号与必要原证据',{input:[m.id],output:[m.id]});
    const choice=[...text.matchAll(/(?:改用|改成|改为|换成|先用|选择(?:为|是)?|选用|使用)([^，。！？；;\n]{1,100})/g)].filter(match=>!/(?:不用|没用|从未|没有|并未|未曾|不要|不能|不再|不应)/.test(text.slice(0,match.index).split(/[，。！？；;\n]/).at(-1))).at(-1)??/(?:^|[，。])\s*先\s*([A-Za-z][A-Za-z0-9_-]{0,40})/.exec(text);
    if(/换个话题|先不聊|暂时不谈/.test(text)&&state.active_topic){state.suspended_topics=unique([...state.suspended_topics,state.active_topic]);state.active_topic=null;}
    if(/接着|继续|回到刚才/.test(text)&&!state.active_topic)state.active_topic=state.suspended_topics.pop()??null;
    const continuing=state.active_topic&&(text.includes(state.active_topic)||/继续|接着|刚才|改成|改为|改用|取消(?:这个|该|计划)|先用/.test(text));
    const topic=source.topic??/\[话题[:：]([^\]]+)\]/.exec(text)?.[1]??/(?:项目|目标)[:：]\s*([^，。；;\n]{1,60})/.exec(text)?.[1]??(continuing?state.active_topic:null);if(topic)state.active_topic=topic;
    const attributes={experience:{goal:/目标[:：]\s*([^。\n]+)/.exec(text)?.[1]??null,background:null,process_source_refs:[source.id],turning_points:/改用|改为|取消|不是/.test(text)?[source.id]:[],outcome:null,missing:['未明确说明的背景和结果不作补全']},topic,chat_id:source.chat_id};
    const bundleId=topic?`experience:${m.scope}:${digest(topic).slice(0,20)}`:`experience:${m.id}`,priorBundle=this.store.getMemory(bundleId);
    const spans=unique([...(priorBundle?.source_refs??[]),source.id]);attributes.experience.process_source_refs=spans;
    attributes.experience.goal=attributes.experience.goal??priorBundle?.attributes.experience?.goal??null;
    attributes.experience.turning_points=unique([...(priorBundle?.attributes.experience?.turning_points??[]),...attributes.experience.turning_points]);
    if(this.controls('W1',m.scope,text,run).write_detail>.6)attributes.experience.explicit_constraints=text.match(/(?:不要|不能|必须|预算|截止)[^。\n]{0,100}/g)??[];
    const rich=m.protection!=='P3'||this.store.queuePending()<=this.config.W1.pending_limit;
    const bundle=rich?this.derive(m,{id:bundleId,kind:'experience',label:topic?`${short(topic,25)} · 来源经历包`:'来源经历 · '+short(text,25),body:`经历包含 ${spans.length} 个有序来源跨度；未明确说明的起因和结果保持未知。`,source_refs:spans,source_roots:unique(spans.map(id=>this.store.getSource(id)?.support_root).filter(Boolean)),attributes:{...attributes,grouping_basis:'explicit_topic_or_local_state',semantic_validation:'not_connected'},representation:['episodic']}):m;
    if(!rich)this.event(run,'W5','U','低价值丰富化让路，完整原话与定位保留',{status:'skipped',input:[m.id],reason:'pending_buffer_limit'});
    const latestChoiceTime=Math.max(-1,...state.choices.filter(c=>c.topic===topic).map(c=>this.store.getSource(c.source_ref)?.occurred_at??-1));if(choice&&source.role==='user'&&source.occurred_at!==null&&source.occurred_at>=latestChoiceTime&&!/[？?]|哪个|怎么|如何|是否|能否|要不要/.test(text)){
      const key=`choice:${m.scope}:${digest(topic??source.chat_id).slice(0,12)}`,old=this.store.getMemory(key);
      const value=choice[1].trim(),claim=this.derive(m,{id:key,kind:'claim',label:'当前选择 · '+short(value,30),body:value,protection:'P1',attributes:{field:'current_choice',topic,previous_revision:old?.revision??null,correction:/改用|改成|改为|换成|不是|别用/.test(text)},representation:['exact_claim']});
      state.choices=state.choices.filter(c=>c.topic!==topic);state.choices.push({topic,value,memory_id:claim.id,revision:claim.revision,source_ref:source.id});
      if(old&&old.body!==value){state.negations.push({previous:old.body,superseded_by:claim.id,revision:claim.revision});this.invalidateDependents(old.id,old.revision);}
    }
    if(source.role==='user'&&/提醒|待办|承诺|答应|约定|明天.{0,15}(?:要|会|做)|计划[:：]|下周.{0,12}(?:要|会)/.test(text)){
      const due=/\b(20\d{2}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\b/.exec(text);const dueAt=due?Date.parse(due[1]+'T'+(due[2]??'00:00')+':00+08:00'):null;
      const intent=this.derive(m,{id:`intent:${m.id}`,kind:'intent',label:short(text,45),body:text,protection:'P1',attributes:{status:'proposed',due_at:Number.isFinite(dueAt)?dueAt:null,condition:due?null:short(text,120),outcome_source_refs:[],external_action_authorized:false},representation:['future_intent']});state.open_loop_ids=unique([...state.open_loop_ids,intent.id]);
    }
    if(source.role==='user'&&/取消/.test(text)){const active=state.open_loop_ids.map(id=>this.store.getMemory(id)).filter(Boolean);state.negations.push({kind:'cancellation_report',source_ref:source.id,text:short(text,150)});if(active.length===1&&/取消(?:刚才|这个|该|这项|计划|承诺|任务)/.test(text)){const target=active[0];target.attributes.status='cancelled';target.attributes.outcome_source_refs=unique([...(target.attributes.outcome_source_refs??[]),source.id]);target.source_refs=unique([...target.source_refs,source.id]);target.revision++;target.updated_at=this.clock();this.store.putMemory(target);state.open_loop_ids=state.open_loop_ids.filter(id=>id!==target.id);}}
    if(source.role==='user'&&/(?:以后|当.{1,30}时|在.{1,30}时|我(?:更|不)?喜欢|不要再|不想.{0,10}追问)/.test(text)){
      const withdrawn=/撤回.{0,30}偏好|不再.{0,30}(?:喜欢|需要)|之前.{0,30}偏好.{0,10}取消/.test(text);
      if(withdrawn){for(const p of this.store.all(m.scope).filter(p=>p.kind==='pattern'&&p.validity==='current')){p.validity='withdrawn';p.review='needs_review';p.revision++;p.updated_at=this.clock();this.store.putMemory(p,'');this.invalidateDependents(p.id,p.revision-1);}}
      else this.derive(m,{id:`pattern:${m.id}`,kind:'pattern',label:'条件偏好 · '+short(text,30),body:text,protection:m.protection==='P0'?'P0':'P1',attributes:{trigger_condition:/当(.+?)时|在(.+?)时/.exec(text)?.slice(1).find(Boolean)??'仅在原话所述条件成立时',supports:[source.id],counterexamples:[],basis_refs:[{id:m.id,revision:m.revision}],pattern_gain:this.config.W5.learning_rate,explicit_statement:true},representation:['conditional_preference']});
    }
    if(source.role==='user'&&/不是这样|不适用|反例|上次那样不行/.test(text)){
      const recentPattern=this.store.all(m.scope).filter(p=>p.kind==='pattern'&&p.validity==='current').sort((a,b)=>b.updated_at-a.updated_at)[0];
      if(recentPattern){recentPattern.attributes.counterexamples=unique([...(recentPattern.attributes.counterexamples??[]),source.id]);recentPattern.source_refs=unique([...recentPattern.source_refs,source.id]);recentPattern.review='needs_review';recentPattern.revision++;recentPattern.updated_at=this.clock();this.store.putMemory(recentPattern);}
    }
    // Stage self-reports survive restarts; they are neither a diagnosis nor a permanent personality label.
    if(source.role==='user'&&/(?:最近|这一阶段|这段时间|近期).{0,12}(?:忙|累|疲惫|不想多聊|压力|开心|担心)/.test(text)){
      const old=state.stage_affect,oldTime=old?this.store.getSource(old.source_ref)?.occurred_at??-1:-1;
      if(source.occurred_at!==null&&source.occurred_at>=oldTime){const phase=this.derive(m,{id:`phase-affect:${m.scope}`,kind:'claim',label:'阶段自述 · '+short(text,30),body:text,attributes:{phase_state:true,valid_until:null,scope:m.scope},representation:['explicit_stage_self_report']});state.stage_affect={memory_id:phase.id,source_ref:source.id,text,valid_until:null,status:'active'};}
    }
    if(source.role==='user'&&state.stage_affect&&/最近不忙了|这一阶段结束|这段时间的状态结束|已经恢复|撤回阶段状态/.test(text)){state.stage_affect={...state.stage_affect,status:'closed',closed_by:source.id};const phase=this.store.getMemory(state.stage_affect.memory_id);if(phase){phase.validity='historical';phase.revision++;phase.updated_at=this.clock();phase.source_refs=unique([...phase.source_refs,source.id]);this.store.putMemory(phase);}}
    const declared=/^(知识|方法)[:：]\s*([\s\S]+)/.exec(text.trim());if(source.role==='user'&&declared)this.derive(m,{id:`declared:${m.id}`,kind:declared[1]==='方法'?'method':'knowledge',label:short(declared[2],40),body:declared[2],attributes:{verification:declared[1]==='方法'?'untested':null,environment:null,success_criteria:null,outcome_source_refs:[],declared_by_source:true},representation:[declared[1]==='方法'?'procedure':'exact_claim']});
    state.revision++;state.updated_at=this.clock();state.last_applied_sequence=Math.max(state.last_applied_sequence,source.sequence);this.store.saveState(state);
    m.handoff=HANDOFF[2];this.store.putMemory(m,null,{history:false});this.event(run,'W5','U','经历、准确声明和状态已对齐来源',{input:[m.id],output:[bundle.id],extra:{extraction:'deterministic_explicit_rules',semantic_model:'not_connected'}});
    m.handoff=HANDOFF[3];this.store.putMemory(m,null,{history:false});
    for(const region of m.region_ids)this.event(run,'W5',region,'更新目录、摘要和规范 ID 引用',{input:[m.id],output:[m.id]});
    m.handoff=HANDOFF[4];this.store.putMemory(m,null,{history:false});
    if(m.source_refs.some(id=>!this.store.getSource(id)))fail('交接前来源校验失败','HANDOFF_FAILED');
    m.handoff=HANDOFF[4];this.store.putMemory(m,null,{history:false});
  }
  derive(parent,input){const old=this.store.getMemory(input.id);const m={...clone(parent),...input,region_ids:[],revision:(old?.revision??0)+1,created_at:old?.created_at??this.clock(),updated_at:this.clock(),handoff:HANDOFF[5],strength:old?.strength??1,used_count:old?.used_count??0,attributes:{chat_id:parent.attributes.chat_id,speaker_id:parent.attributes.speaker_id,speaker_label:parent.attributes.speaker_label,topic:parent.attributes.topic??null,...input.attributes,basis_refs:input.attributes?.basis_refs??[{id:parent.id,revision:parent.revision}]}};m.layer=m.kind==='pattern'?'mature':m.kind==='intent'?'intent':['P0','P1'].includes(m.protection)?'deep':'warm';m.storage='full_warm';m.region_ids=regionFor(m);this.store.putMemory(m,m.body);this.store.relation({id:`basis:${m.id}:${parent.id}`,scope:m.scope,from_id:m.id,to_id:parent.id,type:'derived_from',strength:1,source_refs:parent.source_refs});return m;}
  invalidateDependents(id,revision){const seen=new Set([id]);let changed=true;while(changed){changed=false;for(const m of this.store.all()){if(seen.has(m.id)||!(m.attributes.basis_refs??[]).some(b=>seen.has(b.id)))continue;m.review='needs_review';m.revision++;m.updated_at=this.clock();this.store.putMemory(m);seen.add(m.id);changed=true;}}}
  rebuildCatalogs(scope='all'){
    const groups=new Map(),scopes=this.store.scopes(),memories=this.store.all(scope),byId=new Map(memories.map(m=>[m.id,m]));const add=(m,region,key,label)=>{const id=`${region}:${m.scope}:${key}`;if(!groups.has(id))groups.set(id,{id,scope:m.scope,region,key,label,summary:'',refs:[],source_revisions:{},coverage:{unknown_time:0},updated_at:this.clock()});const c=groups.get(id);c.refs.push(m.id);c.source_revisions[m.id]=m.revision;if(m.occurred_at===null)c.coverage.unknown_time++;};
    for(const m of memories){
      if(m.kind==='archive_chunk'||m.validity!=='current')continue;
      const name=scopes.find(s=>s.id===m.scope)?.label??'未命名范围';
      if(m.region_ids.includes('M1')){const day=m.occurred_at===null?'unknown':new Date(m.occurred_at+8*3600000).toISOString().slice(0,10);add(m,'M1',day,day==='unknown'?'时间未注明':day);}
      if(m.region_ids.includes('M2'))add(m,'M2',m.kind==='intent'?'open-loops':digest(m.attributes.topic??m.attributes.record_kind??m.kind).slice(0,16),m.kind==='intent'?'未完承诺与计划':m.attributes.topic??(m.kind==='experience'?'来源经历':m.kind==='claim'?'准确声明':'经验与理解'));
      if(m.region_ids.includes('M3')){const identity=m.attributes.native_uid??m.attributes.speaker_id??m.attributes.subject??(m.kind==='pattern'?'conditional-patterns':m.id);add(m,'M3',String(identity),m.attributes.speaker_label??(m.kind==='person'?m.label:m.kind==='pattern'?'情境偏好与反例':'范围内人物线索'));}
      if(m.region_ids.includes('M4'))add(m,'M4',m.attributes.chat_id??scopes.find(s=>s.id===m.scope)?.native_scope??name,name);
    }
    this.store.tx(()=>{if(scope==='all')this.store.sql('DELETE FROM catalogs').run();else this.store.sql('DELETE FROM catalogs WHERE scope=?').run(scope);for(const c of groups.values()){c.refs=unique(c.refs);const kindCount={};for(const id of c.refs){const kind=byId.get(id)?.kind;kindCount[kind]=(kindCount[kind]??0)+1;}c.summary=`${c.label}的组织目录，引用 ${c.refs.length} 个底座对象。${c.region==='M4'?'按对话空间归属；时间只决定消息顺序。':''}${c.coverage.unknown_time?` ${c.coverage.unknown_time} 个对象未注明发生时间。`:''}`;c.coverage.kinds=kindCount;c.content_location='U';c.semantic_refs=c.refs.slice().sort((a,b)=>Number(['P0','P1'].includes(byId.get(b)?.protection))-Number(['P0','P1'].includes(byId.get(a)?.protection))||(byId.get(b)?.updated_at??0)-(byId.get(a)?.updated_at??0));const themes=c.semantic_refs.map(id=>byId.get(id)).filter(m=>m&&m.kind!=='raw').slice(0,6).map(m=>m.label);if(themes.length)c.summary+=' 涵盖：'+themes.join('；').slice(0,420)+'。';if(c.region==='M4')c.topics=unique(c.refs.map(id=>byId.get(id)?.attributes.topic).filter(Boolean)).map(topic=>({topic,refs:c.refs.filter(id=>byId.get(id)?.attributes.topic===topic)}));this.store.catalog(c);}});return groups.size;
  }
  importPartitions(partitions,{fingerprint=null,live=false,observations=[]}={}){
    partitions=partitions.map(p=>({...p,memories:p.memories.map(m=>({...m,region_ids:m.region_ids??(m.kind==='person'?['M3']:['M1','M2','M4'])}))}));
    const run=this.beginRun('all',live?'live_import':'bootstrap');let added=0,updated=0;const affected=new Set();const t=performance.now();
    this.store.tx(()=>{for(const p of partitions){const scope=this.addScope(p.context);let sequence=this.store.state(scope.id).last_applied_sequence;
      for(const source of p.sources){const id=`${scope.id}:${source.id}`;if(this.store.getMemory(`raw:${id}`))continue;const s={...clone(source),id,scope:scope.id,persona_id:p.context.persona_id,support_root:source.provenance?.possible_duplicate_group??id,recorded_at:this.clock(),sequence:++sequence};this.store.source(s);this.archive.invalidatePeriod(scope.id,s.occurred_at);const m=this.baseMemory(s,assessContent(s.text,s.role));m.attributes.imported=true;m.handoff=live?HANDOFF[0]:HANDOFF[5];this.place(m,this.clock());this.store.putMemory(m,s.text);if(live)this.store.job({id:`consolidate:${m.id}`,scope:scope.id,memory_id:m.id,status:'pending',attempts:0,created_at:this.clock(),run_id:run.id});added++;affected.add(scope.id);}
      for(const input of p.memories){const old={protection:'P2',validity:'current',occurred_at:null,attributes:{},...input};if(old.kind==='conversation')continue;const id=`${scope.id}:${old.id}`,existing=this.store.getMemory(id);if(existing?.layer==='forgotten')continue;const h=digest(old);if(existing?.attributes.import_hash===h)continue;const m={id,scope:scope.id,kind:old.kind,body:old.body,label:old.label,source_refs:old.source_refs.map(s=>`${scope.id}:${s}`),source_roots:unique(old.source_refs.map(s=>this.store.getSource(`${scope.id}:${s}`)?.support_root).filter(Boolean)),region_ids:old.region_ids.filter(r=>r!=='M5'),layer:old.kind==='pattern'?'mature':['P0','P1'].includes(old.protection)?'deep':'warm',protection:old.protection,protection_reason:'保留 Aurabot 导入时的保护标记，不代表事实已核实',importance:old.protection==='P0'?1:old.protection==='P1'?.85:.4,strength:existing?.strength??1,representation:[old.kind==='person'?'identity_record':old.kind==='pattern'?'conditional_impression':'gist'],storage:'full_warm',evidence:{origin:'legacy_inference',alignment:'legacy_source_preserved',truth:'not_independently_verified'},validity:old.validity,review:old.review_status==='needs_review'?'needs_review':'ready',occurred_at:old.occurred_at,time_precision:old.time_precision??(old.occurred_at===null?'unknown':'instant'),created_at:existing?.created_at??this.clock(),updated_at:this.clock(),revision:(existing?.revision??0)+1,handoff:HANDOFF[5],used_count:existing?.used_count??0,last_used_at:existing?.last_used_at??null,attributes:{...old.attributes,import_hash:h,chat_id:p.context.scope,original_source:'aurabot'}};if(!m.region_ids.length)m.region_ids=['M2'];this.store.putMemory(m,m.body);updated++;affected.add(scope.id);}
      for(const rel of p.relations??[]){const from=`${scope.id}:${rel.from_id}`,to=`${scope.id}:${rel.to_id}`;if(this.store.getMemory(from)&&this.store.getMemory(to))this.store.relation({id:`${scope.id}:${rel.id}`,scope:scope.id,from_id:from,to_id:to,type:rel.relation_type,strength:rel.strength,source_refs:rel.source_refs.map(s=>`${scope.id}:${s}`)});}
      const state=this.store.state(scope.id);state.last_applied_sequence=Math.max(sequence,state.last_applied_sequence);if(affected.has(scope.id)){state.revision++;this.store.saveState(state);}
    }
    for(const o of observations){const scope=this.store.scopes().find(s=>s.native_scope===o.scope);if(scope&&o.kind==='legacy_recall')this.store.recall({id:o.id,scope:scope.id,created_at:o.occurred_at??this.clock(),kind:'upstream',query:o.trigger,actual_use:'unknown',model_actual_use:'unknown',candidates:o.candidates.map(c=>({...c,id:c.canonical_id?`${scope.id}:${c.canonical_id}`:null})),source_locator:o.source_locator});}
    if(fingerprint)this.store.setMeta('import_fingerprint',fingerprint);});
    for(const scope of affected)this.rebuildCatalogs(scope);
    if(added||updated){this.event(run,'IN','W1',live?'只读采集 Aurabot 新增与更新':'载入既有只读导入副本',{count:added+updated,extra:{new_sources:added,updated_objects:updated}});this.event(run,'W1','U','规范来源和待处理任务已提交',{duration:performance.now()-t,count:added});this.event(run,'U','W2','近期完整内容可立即查询',{count:added});if(live)this.event(run,'W2','W5','真实新增记忆进入处理队列',{status:'queued',count:added});}
    this.endRun(run);return {added,updated,affected:[...affected],run_id:run.id};
  }
  bootstrap(output){if(this.store.meta('bootstrapped'))return {reused:true};const pointerPath=join(output,'current.json');if(!existsSync(pointerPath))return {missing:true};const pointer=JSON.parse(readFileSync(pointerPath,'utf8'));if(!/^imports\/[a-f0-9]{24}-[a-f0-9]{8}$/.test(pointer.import_directory))fail('导入路径无效');const dir=resolve(output,pointer.import_directory),index=JSON.parse(readFileSync(join(dir,'index.json'),'utf8'));const parts=index.contexts.map(e=>{const f=resolve(dir,e.details),r=relative(dir,f);if(r.startsWith('..')||isAbsolute(r))fail('导入路径越界');return JSON.parse(readFileSync(f,'utf8'));});const observations=JSON.parse(readFileSync(join(dir,'observations.json'),'utf8')).observations;const result=this.importPartitions(parts,{fingerprint:pointer.import_fingerprint,observations});this.store.setMeta('bootstrapped',{at:this.clock(),fingerprint:pointer.import_fingerprint});return result;}
  place(m,at){const lifecycle=this.groupLifecycle(at),policy=lifecycle.resolve(m);if(policy.applies&&m.kind==='raw'&&!policy.reason){m.layer=policy.phase==='recent'?'recent':'warm';m.accessibility=Math.pow(2,-policy.age/DAY/this.config.W5.ordinary_half_life_days)*Math.min(2,m.strength);return m;}const age=m.occurred_at===null?null:Math.max(0,(at-m.occurred_at)/DAY);if(m.kind==='pattern')m.layer=centralRuleStatus(this,m).effective?'implicit':'mature';else if(m.kind==='intent')m.layer='intent';else if(m.kind==='raw'&&Math.max(0,(at-m.created_at)/DAY)<this.config.W5.recent_hours/24){m.layer='recent';m.storage='full_hot';}else if(['P0','P1'].includes(m.protection))m.layer='deep';else if(['gist_only','gist_with_evidence','clue_only'].includes(m.storage))m.layer='faint';else m.layer='warm';m.accessibility=age===null?null:Math.pow(2,-age/this.config.W5.ordinary_half_life_days)*Math.min(2,m.strength);return m;}
  overview(){
    const stats=this.store.stats();
    const groups=this.store.sql("SELECT scope,layer,count(*) n,min(occurred) first,max(occurred) last FROM memories INDEXED BY memory_atlas_layers WHERE layer!='forgotten' AND kind!='archive_chunk' AND validity='current' GROUP BY scope,layer").all();
    const counts=new Map(),scopeCounts=new Map();let start=Infinity,end=-Infinity;
    for(const row of groups){const n=Number(row.n);counts.set(row.layer,(counts.get(row.layer)??0)+n);const item=scopeCounts.get(row.scope)??{count:0,layers:new Map()};item.count+=n;item.layers.set(row.layer,n);scopeCounts.set(row.scope,item);if(row.first!==null)start=Math.min(start,row.first);if(row.last!==null)end=Math.max(end,row.last);}
    const catalogCounts=new Map(this.store.sql('SELECT region,count(*) n FROM catalogs GROUP BY region').all().map(row=>[row.region,Number(row.n)]));
    return {version:'V5',revision:stats.events,stats,scopes:this.store.scopes().map(scope=>({...scope,count:scopeCounts.get(scope.id)?.count??0,layer_counts:Object.fromEntries(LAYERS.map(layer=>[layer.id,scopeCounts.get(scope.id)?.layers.get(layer.id)??0]))})),regions:REGIONS.map(region=>({...region,count:region.domain==='memory'?(catalogCounts.get(region.id)??0):0})),archive:this.archive.stats(),layers:LAYERS.map(layer=>({...layer,count:counts.get(layer.id)??0})),channels:CHANNELS,config_version:this.configVersion,hard_rules:HARD_RULES,live:this.live,capabilities:{semantic_model:false,embedding:!!this.semantic.embed,multimodal_interpretation:false,local_explicit_rules:true,remote_send:false,actual_model_context_window:'not_connected',read_only_aurabot:true},time_range:{start,end}};
  }
  directory({scope='all',region='M4',offset=0,limit=40}={}){this.requireScope(scope,true);if(!/^M[1-4]$/.test(region))fail('V5 只有四个记忆组织区');const all=this.store.catalogs(scope,region);return {region,total:all.length,entries:all.slice(offset,offset+limit).map(c=>({...c,ref_count:c.refs.length,refs:c.refs.slice(0,8),source_revisions:undefined,semantic_refs:undefined,topics:c.topics?.slice(-this.config.M4.active_topics)})),next_offset:Math.min(offset+limit,all.length),content_location:'U',grouping:region==='M4'?'platform_scope_chat_topics':'region_specific'};}
  graph({scope='all',layer=null,limit=this.config.display.visible_node_limit,until=null,q='',focus_id=null}={}){
    this.requireScope(scope,true);limit=Math.max(0,Math.min(500,Number(limit)||0));
    const selected=this.store.atlasSelection({scope,layer,limit,until,matchIds:q?this.store.search(scope,termsOf(q),5000).map(m=>m.id):null,focusId:focus_id,layerOrder:LAYERS.map(l=>l.id)});
    return {archive:this.archive.stats(scope),regions:REGIONS,layers:LAYERS.map(l=>({...l,count:selected.counts.get(l.id)??0})),channels:CHANNELS,
      nodes:selected.ids.map(id=>this.store.getMemory(id)).map(m=>({id:m.id,scope:m.scope,kind:m.kind,label:m.label,layer:m.layer,protection:m.protection,importance:m.importance,strength:m.strength,representation:m.representation,storage:m.storage,validity:m.validity,review:m.review,occurred_at:m.occurred_at,created_at:m.created_at,region_ids:m.region_ids,source_count:m.source_refs.length,archive_level:m.attributes.archive_level??null,archive_period:m.attributes.archive_period??null,central_rule_region:centralRuleStatus(this,m).effective?m.attributes.central_rule.region:null})),
      edges:this.store.atlasRelations(selected.ids,scope,this.config.display.edge_limit),counts:{visible:selected.ids.length,matching:selected.matching,omitted:selected.matching-selected.ids.length},revision:this.store.eventCount()};
  }
  detail({id,scope,offset=0,limit=20}={}){this.requireScope(scope);const m=this.memory(id,scope);const body=this.body(m),versions=this.store.versions(id);const relations=this.store.relations(scope).filter(r=>r.from_id===id||r.to_id===id);return {memory:{...m,body},source_page:this.sourcePage(m,offset,limit),counterexamples:(m.attributes.counterexamples??[]).map(id=>this.store.getSource(id)).filter(Boolean),counterexample_slots:this.config.M3.counterexample_slots,versions,relations,scope:this.requireScope(scope),state:this.store.state(scope),six_dimensions:{representation:m.representation,retrieval:'仅浏览：未发生检索／采用',evidence:m.evidence,validity:m.validity,storage:m.storage,priority:m.protection},group_lifecycle:this.groupLifecycle().resolve(m),source_exists:body!==null,missing:m.attributes.experience?.missing??[],handoff_states:HANDOFF,precision_note:m.storage==='gist_with_evidence'?'当前对象为有损要旨，相关原文仍由底座其它对象保留，可展开核对。':m.storage==='gist_only'?'只剩有损要旨，不能逐字引用':m.evidence.origin==='legacy_inference'?'上游摘要的原始记录仍在；不代表已对齐最初聊天证据':'原始记录存在，只证明该记录被保存，不单独证明其陈述真实'};}
  query({scope='all',query,region=null,catalog_id=null,host_message_ids=[],actual_tokens=null,template='precise',use=false,semantic_ids=[],semantic_regions=[],rerank_ids=[],memory_filter=null,on_demand=false}={}){
    this.requireScope(scope,true);if(typeof query!=='string'||query.length>2000)fail('查询内容不正确');if(!Array.isArray(host_message_ids))fail('宿主已有消息清单必须是数组');
    if(region&&!/^M[1-4]$/.test(region))fail('组织入口不存在');if(!Array.isArray(semantic_ids)||semantic_ids.length>500)fail('语义候选数量不正确');
    const run=this.beginRun(scope,'retrieval',{query,template}),controls=this.controls('W2',scope,query,run),t=performance.now(),terms=relevantQueryTerms(query),queryId=run.id;
    this.event(run,'IN','W1','读取检索问题与范围');this.event(run,'W1','W2','近期状态和本题线索进入调度');
    const safety=this.groupLifecycle(),lifecycle=on_demand?null:safety,groupQuery=scope==='all'?safety.hasTrash||!on_demand&&this.config.W5.group_policy_enabled===1:safety.constrains(scope),eligible=m=>m&&m.layer!=='forgotten'&&(on_demand||this.implicitLearning.retrievable(m,query))&&(!lifecycle||lifecycle.resolve(m).eligible)&&(!memory_filter||memory_filter(m));
    const fullEvidence=m=>eligible(m)&&(!lifecycle?.resolve(m).applies||!['trace','expired'].includes(lifecycle.resolve(m).phase));
    const needsView=m=>on_demand?safety.retiredRefs(m).length>0:safety.needsProjection(m);
    const projections=new Map(),view=m=>{if(!needsView(m))return null;if(!projections.has(m.id))projections.set(m.id,safety.project(m,{onDemand:on_demand}));return projections.get(m.id);};
    const searchable=m=>{const projected=view(m);if(needsView(m)&&!projected)return null;return projected?.projected?{...m,label:short(projected.text,44),search_text:projected.text.normalize('NFKC').toLocaleLowerCase()}:m;};
    let catalogs=catalog_id?this.store.catalogs(scope,region):this.store.catalogHeaders(scope,region),routes=region?[region]:/刚才|继续|群|私聊|空间|哪里说/.test(query)?['M4','M2']:/谁|人物|喜欢|偏好|称呼/.test(query)?['M3','M2']:/昨天|去年|上周|什么时候|之前|之后|\d{4}/.test(query)?['M1','M2']:['M2','M4','M3'];routes=routes.slice(0,controls.route_limit);
    if(catalog_id){catalogs=catalogs.filter(c=>c.id===catalog_id);if(!catalogs.length)fail('目录不在当前范围','NOT_FOUND');routes=unique(catalogs.map(c=>c.region));}else if(semantic_regions.length)routes=unique([...routes,...semantic_regions.filter(id=>/^M[1-4]$/.test(id))]).slice(-controls.route_limit);
    const allowed=catalog_id?new Set(catalogs.flatMap(c=>c.refs)):null,regionIds=new Set(catalogs.filter(c=>routes.includes(c.region)).flatMap(c=>c.refs));
    for(const route of routes){this.event(run,'W2',route,'命中组织目录',{count:catalogs.filter(c=>c.region===route).length});this.event(run,route,'U','按规范 ID 在底座查找正文与来源',{count:catalogs.filter(c=>c.region===route).reduce((n,c)=>n+c.refs.length,0)});}
    const direct=this.store.getMemory(query);let pool=direct&&(scope==='all'||direct.scope===scope)?[{...direct,search_text:(this.body(direct)??'').toLocaleLowerCase()}]:this.store.search(scope,terms,2000,{phrase:query}).filter(m=>(!allowed||allowed.has(m.id))&&(!region||m.region_ids.includes(region)));
    if(!direct&&terms.length){const protectedHits=this.store.search(scope,terms,Math.min(500,controls.candidate_limit*4),{phrase:query,protectedOnly:true});const seen=new Set(pool.map(m=>m.id));for(const m of protectedHits)if(!seen.has(m.id)&&(!allowed||allowed.has(m.id))&&(!region||m.region_ids.includes(region))){pool.push(m);seen.add(m.id);}}
    if(allowed&&!terms.length)pool=[...allowed].slice(-2000).map(id=>this.store.getMemory(id)).filter(m=>m&&m.layer!=='forgotten').map(m=>({...m,search_text:(this.body(m)??'').toLocaleLowerCase()}));
    const semantic=[];for(const id of unique(semantic_ids)){const m=this.store.getMemory(id);if(!m||groupQuery&&!eligible(m)||m.layer==='forgotten'||(scope!=='all'&&m.scope!==scope)||(!m.region_ids.includes(region)&&region))continue;if(!pool.some(p=>p.id===id))pool.push({...m,search_text:(this.body(m)??'').toLocaleLowerCase()});semantic.push({m});}
    const continuity=/继续|刚才|接着|那个|上一个/.test(query)&&scope!=='all',currentState=scope!=='all'?this.store.state(scope):null;
    if(continuity){const ids=unique([...(currentState.choices??[]).map(c=>c.memory_id),...(currentState.open_loop_ids??[]),...(currentState.source_refs??[]).slice(-this.config.M4.span_messages).map(id=>`raw:${id}`)]);for(const id of ids){const m=this.store.getMemory(id);if(m&&(!groupQuery||eligible(m))&&m.validity==='current'&&(!lifecycle?.resolve(m).applies||lifecycle.resolve(m).phase==='recent'||lifecycle.resolve(m).phase==='held')&&!pool.some(p=>p.id===id))pool.push({...m,search_text:(this.body(m)??'').toLocaleLowerCase(),continuity_hit:true});}}
    if(groupQuery)pool=pool.filter(eligible).map(searchable).filter(Boolean);
    if(!pool.length&&terms.length&&controls.followup_searches>0){const inventory=groupQuery?this.store.search(scope,terms,Math.min(500,controls.candidate_limit*10),{phrase:query}):this.store.all(scope),ordinary=Math.floor(controls.candidate_limit*10*this.config.W5.low_value_recovery),check=[...inventory.filter(m=>['P0','P1'].includes(m.protection)),...inventory.filter(m=>!['P0','P1'].includes(m.protection)).slice(0,ordinary)];pool=check.filter(m=>!groupQuery||eligible(m)).map(m=>searchable({...m,search_text:(this.body(m)??'').toLocaleLowerCase()})) .filter(m=>m&&terms.some(t=>m.search_text.includes(t))&&(!allowed||allowed.has(m.id)));this.event(run,'W2','U','有限补查：核对规范来源库存',{count:pool.length,extra:{checked:check.length,ordinary_budget:ordinary}});}
    pool=pool.filter(m=>m.kind!=='archive_chunk'&&m.validity==='current'&&eligible(m));
    const associations=[];
    if(scope!=='all'&&!continuity&&controls.association_breadth>0&&controls.recall_depth>0&&controls.association_weight>0){
      let frontier=pool.filter(m=>controls.lexical>0&&terms.some(term=>m.search_text.includes(term))||controls.semantic>0&&semantic_ids.includes(m.id)||controls.entity>0&&terms.some(term=>m.label.toLocaleLowerCase().includes(term))).slice(0,3).map(m=>({id:m.id,activation:1}));const visited=new Set(pool.map(m=>m.id));
      for(let hop=0;hop<Math.min(controls.recall_depth,3)&&frontier.length;hop++){
        const next=[];
        for(const seed of frontier){const rows=this.store.sql('SELECT json FROM relations WHERE scope=? AND (from_id=? OR to_id=?) LIMIT ?').all(scope,seed.id,seed.id,controls.association_breadth);
          for(const row of rows){const relation=JSON.parse(row.json),id=relation.from_id===seed.id?relation.to_id:relation.from_id;if(visited.has(id))continue;visited.add(id);
            const m=this.store.getMemory(id),activation=seed.activation*(relation.strength??.5)*controls.hop_decay;
            if(!m||m.scope!==scope||m.layer==='forgotten'||m.validity!=='current'||m.review==='needs_review'||activation<.03||allowed&&!allowed.has(id)||region&&!m.region_ids.includes(region)||!eligible(m))continue;
            if(m.kind==='experience'&&m.source_refs.length>4&&(!m.attributes.topic||!query.includes(m.attributes.topic)))continue;
            const candidate=searchable({...m,search_text:(this.body(m)??'').toLocaleLowerCase()});if(!candidate)continue;pool.push(candidate);associations.push({m,activation,via:seed.id,hop:hop+1});next.push({id,activation});
          }
        }frontier=next;if(associations.length>=controls.association_breadth)break;
      }
      if(associations.length)this.event(run,'W2','U','按已保存关系补充有界联想',{output:associations.map(a=>a.m.id),extra:{association_count:associations.length}});
    }
    const exact=query.trim().toLocaleLowerCase();const weighted=(features,weights)=>{let n=0,d=0;for(const[k,v]of Object.entries(features)){const w=Number(weights[k]??0);n+=v*w;d+=w;}return d?n/d:0;};
    const bm25=bm25Scores(query,pool.map(m=>({id:m.id,text:m.search_text})),{k1:controls.bm25_k1,b:controls.bm25_b,queryTerms:terms});
    const lexical=[...pool].map(m=>({m,score:(bm25.get(m.id)?.score??0)+(exact&&m.search_text.includes(exact)?3:0)+(m.continuity_hit?m.attributes.field==='current_choice'?100:10:0)})).filter(x=>x.score>0||direct||(!terms.length&&allowed)).sort((a,b)=>b.score-a.score||Number(['P0','P1'].includes(b.m.protection))-Number(['P0','P1'].includes(a.m.protection)));
    const entity=[...pool].map(m=>({m,score:terms.reduce((n,term)=>n+((`${m.label} ${m.attributes.speaker_label??''} ${(m.attributes.aliases??[]).join(' ')}`).toLocaleLowerCase().includes(term)?term.length:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||Number(['P0','P1'].includes(b.m.protection))-Number(['P0','P1'].includes(a.m.protection)));
    const channels=[[lexical,controls.lexical],[entity,controls.entity],[semantic,controls.semantic],[associations,controls.association_weight]],weightSum=channels.reduce((n,[items,weight])=>n+(items.length?weight:0),0)||1;const scores=new Map();for(const[channel,weight]of channels){if(!weight||!channel.length)continue;channel.forEach(({m},i)=>{scores.set(m.id,(scores.get(m.id)??0)+(weight/weightSum)/(60+i+1));});}
    let ranked=pool.filter(m=>scores.has(m.id)).map(m=>{
      const phase=lifecycle?.resolve(m),rel=scores.get(m.id),age=phase?.age!==undefined?phase.age/DAY:m.occurred_at===null?0:Math.max(0,(this.clock()-m.occurred_at)/DAY),identity=entity.find(x=>x.m.id===m.id)?.score??0;
      const relevance=Math.min(1,rel*100),feature={temporal_fit:/昨天|时间|之前|之后|去年/.test(query)?1/(1+age):.3,phase_fit:m.attributes.topic&&query.includes(m.attributes.topic)?1:.2,relevance,event_fit:m.kind==='experience'?relevance:.3,goal_fit:m.attributes.experience?.goal?relevance:.2,identity_fit:identity?1:.1,condition_fit:m.kind==='pattern'?relevance:.2,scope_fit:scope!=='all'?1:.5,continuity:m.kind==='raw'?1/(1+age):.3,reference_fit:/继续|刚才|那个/.test(query)&&m.kind==='raw'?.8:.2,topic_fit:m.attributes.topic&&query.includes(m.attributes.topic)?1:relevance};
      const local=routes.filter(r=>m.region_ids.includes(r)).map(r=>weighted(feature,this.config[r]));const regionScore=local.length?Math.max(...local):0;
      return {memory:m,score:rel*(.65+.35*regionScore)*(phase?.age!==undefined?Math.pow(2,-age/this.config.W5.ordinary_half_life_days):1)+(m.attributes.fact_key?.confirmed_by==='local_operator'?.05:0),bm25:bm25.get(m.id),matched_regions:routes.filter(r=>m.region_ids.includes(r)),reasons:[direct?'精确规范 ID':'原话／实体线索命中',regionIds.has(m.id)?'目录引用 → U 正文':'精确底座入口'],retrieval_state:m.storage==='gist_only'?'partial_recall':m.storage==='clue_only'?'recognition_cue':'directly_retrievable'};
    }).filter(x=>x.memory.validity==='current'&&x.memory.review!=='invalid').sort((a,b)=>b.score-a.score);
    if(continuity){const currentIds=new Set((currentState.choices??[]).map(c=>c.memory_id)),currentSources=new Set((currentState.choices??[]).map(c=>c.source_ref));for(const item of ranked)if(currentIds.has(item.memory.id))item.score+=1;ranked=ranked.filter(item=>item.memory.kind!=='raw'||!/(?:先用|改用|改成|改为|换成|选择|选用|使用)/.test(item.memory.search_text)||item.memory.source_refs.some(id=>currentSources.has(id)));ranked.sort((a,b)=>b.score-a.score);}
    for(const item of ranked){const association=associations.find(a=>a.m.id===item.memory.id);if(association)item.reasons.push(`关系联想：${association.hop}跳，经由 ${association.via}`);item.score*=1+Math.min(.12,Math.max(0,(item.memory.strength??1)-1)*.03);}
    if(rerank_ids.length){const order=new Map(rerank_ids.map((id,i)=>[id,i]));for(const item of ranked)if(order.has(item.memory.id))item.score+=(rerank_ids.length-order.get(item.memory.id))*.002;ranked.sort((a,b)=>b.score-a.score);}
    const backtrace=backtraceOriginals(this,ranked.filter(item=>fullEvidence(item.memory)&&!view(item.memory)?.projected),{controls,memory_filter:fullEvidence,query});
    for(const item of backtrace.originals){ranked=ranked.filter(existing=>existing.memory.id!==item.memory.id);ranked.unshift(item);}
    if(backtrace.links.length)this.event(run,'W2','U','派生线索回查完整原话',{output:backtrace.originals.map(item=>item.memory.id),extra:{evidence_backtrace:backtrace.links}});
    const protectedSlots=Math.min(8,Math.max(1,Math.floor(controls.candidate_limit/5))),protectedCandidates=ranked.filter(item=>['P0','P1'].includes(item.memory.protection)).sort((a,b)=>Number(b.memory.protection==='P0')-Number(a.memory.protection==='P0')||b.score-a.score).slice(0,protectedSlots),reserved=new Set([...protectedCandidates,...backtrace.originals].map(item=>item.memory.id));
    for(const item of protectedCandidates)item.reasons.push('相关重要来源保留候选席位；仍需核对原文');
    const originalIds=new Set(backtrace.originals.map(item=>item.memory.id));
    const candidateOrder=[...backtrace.originals,...protectedCandidates.filter(item=>!originalIds.has(item.memory.id)),...ranked.filter(item=>!reserved.has(item.memory.id))];
    const selected=[],roots=new Set();for(const item of candidateOrder){const key=item.memory.source_roots.slice().sort().join('|');if(roots.has(key)&&key)continue;roots.add(key);selected.push(item);if(selected.length>=controls.candidate_limit)break;}
    // MMR penalizes redundant vocabulary, not corrections or necessary evidence.
    const diverse=[];while(selected.length){let best=0,bestScore=-Infinity;selected.forEach((item,i)=>{const tt=new Set(termsOf(item.memory.label));const similarity=Math.max(0,...diverse.map(d=>{const dt=new Set(termsOf(d.memory.label));return [...tt].filter(t=>dt.has(t)).length/Math.max(1,new Set([...tt,...dt]).size);}));const score=controls.diversity_lambda*item.score-(1-controls.diversity_lambda)*similarity*.01;if(score>bestScore){best=i;bestScore=score;}});diverse.push(selected.splice(best,1)[0]);}
    ranked=diverse;const spanOmitted=[];if(region==='M1'){const keep=new Set(ranked.slice(0,this.config.M1.context_span).map(x=>x.memory.id));ranked=ranked.filter(x=>{const retain=keep.has(x.memory.id)||['P0','P1'].includes(x.memory.protection);if(!retain)spanOmitted.push({id:x.memory.id,reason:'optional_timeline_span_budget'});return retain;});}const host=new Set(host_message_ids),budget=Math.max(0,Math.min(controls.context_tokens,Number.isFinite(actual_tokens)?actual_tokens:controls.context_tokens));let spent=0;const context=[],omitted=[...spanOmitted];
    const targets={recent:controls.recent_tokens,state:controls.state_tokens,long:controls.long_tokens,optional:controls.optional_tokens},totalTargets=Object.values(targets).reduce((a,b)=>a+b,0)||1,usedBy={recent:0,state:0,long:0,optional:0},deferred=[];
    const maxContextItems=/所有|全部|汇总|总结|清单|一共/.test(query)?Math.max(controls.recall_items,24):controls.recall_items;const assemble=(item,borrow=false)=>{const m=item.memory;if(context.length>=maxContextItems&&!item.evidence_backtrace&&m.protection!=='P0'){omitted.push({id:m.id,reason:'optional_relevance_limit'});return;}if(!eligible(m))return;const projected=view(m);if(needsView(m)&&!projected)return;const needed=(projected?.refs??m.source_refs).filter(id=>!host.has(id));if(!needed.length){omitted.push({id:m.id,reason:'already_in_host_context'});return;}let text=projected?.projected?projected.text:this.body(m);if(!projected?.projected&&m.kind==='experience'){const spans=m.source_refs.map(id=>this.store.getSource(id)).filter(Boolean);text=spans.length?spans.map(src=>`${src.provenance?.speaker_label??src.role}：${src.text}`).join('\n'):text;}if(m.kind==='raw'&&m.attributes.superseded_fact_fields?.length)text='历史原话，字段 '+m.attributes.superseded_fact_fields.join('、')+' 已有后续修订，不作为现行值：\n'+text;const conflicts=(m.attributes.counterexamples??[]).map(id=>this.store.getSource(id)).filter(src=>src&&!safety.retiredSource(src.id)&&(!lifecycle||lifecycle.sourceFull(src)));if(conflicts.length)text=(text??'')+'\n必要反例／冲突，不能据此继续无条件套用：\n'+conflicts.map(src=>src.text).join('\n');if(text===null){item.retrieval_state='temporarily_inaccessible';omitted.push({id:m.id,reason:'source_unavailable'});return;}const cost=Math.ceil(text.length/2),group=m.kind==='intent'||m.attributes.field==='current_choice'||m.attributes.fact_key?'state':m.kind==='raw'&&(projected?.state.phase==='recent'||(!projected||projected.state.phase==='held')&&m.layer==='recent')?'recent':m.kind==='pattern'?'optional':'long';if(!borrow&&usedBy[group]+cost>budget*targets[group]/totalTargets){deferred.push(item);return;}if(spent+cost>budget){omitted.push({id:m.id,reason:'actual_context_budget_insufficient',required_tokens_estimate:cost,protected:['P0','P1'].includes(m.protection)});return;}spent+=cost;usedBy[group]+=cost;context.push({id:m.id,scope:m.scope,kind:m.kind,occurred_at:m.occurred_at,speaker_ids:unique(needed.map(id=>this.store.getSource(id)?.provenance?.speaker_id??this.store.getSource(id)?.speaker_id).filter(Boolean)),text,source_refs:needed,evidence_backtrace:item.evidence_backtrace??null,precision:projected?.precision??m.storage,...(projected?{lifecycle_phase:projected.state.phase}:{}),token_estimate:cost,allocation_group:group,evidence_origin:m.evidence.origin,review:m.review,source_roles:unique(needed.map(id=>this.store.getSource(id)?.role).filter(Boolean))});};
    for(const item of ranked)assemble(item);for(const item of deferred)assemble(item,true);
    context.sort((a,b)=>ranked.findIndex(r=>r.memory.id===a.id)-ranked.findIndex(r=>r.memory.id===b.id));
    const recall={id:queryId,scope,...(lifecycle?.enabled(scope)?{group_policy_version:lifecycle.version}:{}),created_at:this.clock(),kind:'local',query,run_id:run.id,candidates:ranked.slice(0,controls.candidate_limit).map(x=>({id:x.memory.id,label:x.memory.label,scope:x.memory.scope,score:x.score,bm25:x.bm25,matched_regions:x.matched_regions,reasons:x.reasons,retrieval_state:x.retrieval_state,evidence_backtrace:x.evidence_backtrace??null,assembly:context.some(c=>c.id===x.memory.id)?'assembled':'candidate_only',actual_use:false})),context,omitted,evidence_backtrace:backtrace.links,budget:{available:budget,used_estimate:spent,actual_model_window_known:Number.isFinite(actual_tokens),soft_allocation:{recent:controls.recent_tokens,state:controls.state_tokens,long:controls.long_tokens,optional:controls.optional_tokens}},actual_use:'not_yet_used',model_actual_use:'not_connected',incomplete:omitted.some(o=>o.reason!=='already_in_host_context')};
    this.store.recall(recall);this.event(run,'U','W2','来源根去重、上下文装配完成',{output:context.map(c=>c.id),duration:performance.now()-t,extra:{candidate_count:ranked.length,context_count:context.length,omitted,semantic_channel:semantic.length?'model_catalog_routing':'not_requested_no_vector_index'}});
    this.event(run,'W2','W3','结合已读内容进行复评',{extra:{appraisal:this.appraise(query,ranked.map(r=>r.memory),true,scope,run)}});
    const output=this.prepareOutput(query,context,scope,run);this.event(run,'W3','W4','准备仅在本机面板显示的表达',{output:context.map(c=>c.id),extra:{output_status:'prepared_local_panel',mode:output.mode}});
    recall.output=output;if(use){this.markUse(recall,run);this.event(run,'W4','OUT','结果已在本机面板生成',{output:context.map(c=>c.id),extra:{external_delivery:false}});}this.store.recall(recall);this.endRun(run);
    return {...recall,candidates:recall.candidates.map(c=>({...c,layer:this.store.getMemory(c.id)?.layer})),trace:this.store.events({run_id:run.id,limit:200})};
  }
  appraise(text,memories,after,scope=null,run=null){
    const controls=this.controls('W3',scope,text,run),selfReport=/我.{0,8}(累|疲惫|难过|开心|高兴|担心|不想)/.exec(text),state=scope&&scope!=='all'?this.store.state(scope):null;
    const normalize=value=>value.replaceAll('疲惫','累').replaceAll('疲劳','累').replaceAll('工作','工作');
    const applicable=m=>{const trigger=m.attributes.trigger_condition;if(!trigger)return false;if(m.attributes.explicit_statement&&trigger==='仅在原话所述条件成立时')return true;const words=termsOf(normalize(trigger));return words.some(w=>normalize(text).includes(w))||(/累/.test(normalize(trigger))&&/累/.test(normalize(text)));};
    const lifecycle=this.groupLifecycle(),context=state?.active_topic??'default',condition=memories.filter(m=>lifecycle.resolve(m).eligible&&lifecycle.resolve(m).phase!=='trace'&&m.kind==='pattern'&&m.validity==='current'&&m.review!=='needs_review'&&applicable(m)&&((m.attributes.mention_count_by_context?.[context]??0)<controls.rumination_limit||/原话|再次|再查|偏好/.test(text))).slice(0,controls.emotion_context_limit);
    return {phase:after?'read_after':'initial',user_state:selfReport?{kind:'explicit_self_report',text:selfReport[0]}:{kind:'unknown'},stage_state:state?.stage_affect?.status==='active'&&(!lifecycle.enabled(scope)||lifecycle.sourceFull(this.store.getSource(state.stage_affect.source_ref)))?state.stage_affect:null,strategy:/不想讲|不想聊|别问/.test(text)?'respect_pause':/终于|成功了|弄好了/.test(text)?'share_acknowledgment':condition.length?'conditional_preference':'task_focused',expression_gain:controls.expression_gain,applicable_pattern_ids:condition.map(m=>m.id),pattern_suggestions:condition.map(m=>({id:m.id,text:this.body(m),condition:m.attributes.trigger_condition,gain:m.attributes.explicit_statement?1:m.attributes.pattern_gain??0,protection:m.protection})),observed_feedback:'unknown',truth_effect:0};
  }
  mention(ids,scope,status){const state=this.store.state(scope),context=state.active_topic??'default';for(const id of unique(ids)){const m=this.store.getMemory(id);if(!m||m.scope!==scope||m.layer==='forgotten')continue;m.attributes.last_mentioned_at=this.clock();m.attributes.mention_count_by_context={...m.attributes.mention_count_by_context,[context]:(m.attributes.mention_count_by_context?.[context]??0)+1};m.attributes.last_mention_status=status;this.store.putMemory(m,null,{history:false});}}

  prepareOutput(query,context,scope,run=null){const c=this.controls('W4',scope,query,run);let mode=c.memory_explicitness<.3?'implicit':c.memory_explicitness<.7?'light':'explicit';if(/原话|准确|查|什么|多少|记得/.test(query))mode='explicit';let text;
    if(/不想讲|不想聊|别问/.test(query))text='好，这个话题先停在这里。';
    else if(!context.length)text='当前范围内没有找到足够依据。已保存的原文和本次预算状态可在详情中核对。';
    else {const take=c.detail_level>.7?6:c.detail_level>.3?3:1;text=context.slice(0,take).map(item=>{const m=this.store.getMemory(item.id),label=this.store.scopes().find(s=>s.id===m.scope)?.label??'当前范围';const body=['gist_only','gist_with_evidence'].includes(item.precision)?`保留的大意：${item.text}`:`${item.text}`;return `${scope==='all'?`〔${label}〕\n`:''}${mode==='explicit'?'来源内容：':mode==='light'?'相关记录里提到：':''}${body}`;}).join('\n\n');if(c.followup_pressure>.7&&/那个|这件/.test(query)&&context.length>1)text+='\n你指的是其中哪一段？';}
    if(c.style_accommodation>.65)text=text.replaceAll('来源内容：','相关原话：').replaceAll('相关记录里提到：','之前聊到：');
    if(/终于|成功了|弄好了/.test(query)&&this.config.W3.expression_gain>.2)text=(this.config.W3.expression_gain>.7?'听起来是个好消息！\n':'这次有了进展。\n')+text;
    if(c.topic_initiative>.75&&context.length>1&&!/不想|别问|不聊/.test(query))text+='\n如果需要，可以沿这些来源继续核对相关经历。';
    return {text,mode,engine:'deterministic_source_grounded',model_connected:false,status:'local_panel_only',cited_ids:context.slice(0,c.detail_level>.7?6:c.detail_level>.3?3:1).map(c=>c.id),external_sent:false};
  }
  markUse(recall,run){for(const c of recall.candidates){if(!recall.output.cited_ids.includes(c.id))continue;const m=this.store.getMemory(c.id);if(!m||m.layer==='forgotten')continue;m.used_count++;m.last_used_at=this.clock();m.strength=Math.min(3,m.strength+.03);m.updated_at=this.clock();this.store.putMemory(m,null,{history:false});c.actual_use=true;}for(const localScope of unique(recall.context.map(c=>c.scope)))this.mention(recall.output.cited_ids,localScope,'verified_local_quote');recall.actual_use='used_in_local_panel';recall.model_actual_use='not_connected';}
  associate({scope,id}={}){this.requireScope(scope);const origin=this.memory(id,scope),run=this.beginRun(scope,'association'),controls=this.controls('W2',scope,this.body(origin)??'',run),visited=new Set([id]),result=[],lifecycle=this.groupLifecycle();let frontier=origin.storage==='trash_only'||!lifecycle.resolve(origin).eligible?[]:[{id,activation:1}];const relations=this.store.relations(scope);for(let hop=0;hop<Math.min(controls.recall_depth,origin.kind==="experience"?this.config.M2.expand_depth:4);hop++){const next=[];for(const a of frontier){const neighbors=relations.filter(r=>r.from_id===a.id||r.to_id===a.id).slice(0,controls.association_breadth);for(const r of neighbors){const other=r.from_id===a.id?r.to_id:r.from_id;if(visited.has(other))continue;const m=this.store.getMemory(other);if(!m||m.scope!==scope||m.layer==='forgotten'||m.validity!=='current'||!lifecycle.resolve(m).eligible||!lifecycle.project(m))continue;visited.add(other);const activation=a.activation*(r.strength??.5)*controls.hop_decay;result.push({id:other,label:m.label,scope,activation,relation:r.type,hop:hop+1,confidence_change:0});next.push({id:other,activation});}}frontier=next;if(!frontier.length)break;}
    this.event(run,'W2','M2','沿已保存的同范围关系进行有界联想',{input:[origin.id],output:result.map(r=>r.id)});this.event(run,'M2','U','展开关联对象，不改变真实性或支持数',{output:result.map(r=>r.id)});this.endRun(run);return {origin:id,items:result,run_id:run.id};}
  deepen({scope,id,reason}={}){this.requireScope(scope);if(typeof reason!=='string'||!reason.trim())fail('请说明这次明确加深的理由');const m=this.memory(id,scope);if(m.layer==='forgotten')fail('正文已遗忘，不能凭加深恢复原文');const run=this.beginRun(scope,'deepen');m.strength=Math.min(5,m.strength+.25);m.last_strengthened_at=this.clock();m.attributes.deepening=[...(m.attributes.deepening??[]),{at:this.clock(),reason,source:'explicit_local_operator'}];m.updated_at=this.clock();this.store.putMemory(m,null,{history:false});this.event(run,'W2','W5','明确加深可达性，不增加独立证据',{input:[id],output:[id]});this.event(run,'W5','U','保存加深记录',{output:[id]});this.endRun(run);return {memory:m,run_id:run.id,support_roots_unchanged:true};}
  revise({scope,id,expected_revision,text,reason}={}){this.requireScope(scope);const m=this.memory(id,scope);if(m.revision!==expected_revision)fail('对象已变化，请重新打开详情','REVISION_CONFLICT');if(m.layer==='forgotten')fail('已遗忘对象无法恢复旧正文');if(typeof text!=='string'||!text.trim())fail('更正内容不能为空');const receipt=this.ingest({scope,text:`明确更正：${text}`,provenance:{kind:'explicit_correction'},process:false});const correction=this.memory(receipt.memory_id,scope);const oldRevision=m.revision;m.body=text;m.kind=m.kind==='raw'?'claim':m.kind;m.source_refs=correction.source_refs;m.source_roots=correction.source_roots;m.evidence={...correction.evidence,alignment:'explicit_correction',truth:'operator_report'};m.revision++;m.updated_at=this.clock();m.protection='P1';m.protection_reason=reason||'用户明确更正';m.attributes.correction_source=correction.id;m.attributes.previous_revision=oldRevision;this.store.tx(()=>{this.store.putMemory(m,text);this.invalidateDependents(id,oldRevision);});this.rebuildCatalogs(scope);return {memory:m,receipt};}
  feedback({scope,query_id=null,id=null,text,kind='feedback'}={}){this.requireScope(scope);if(typeof text!=='string'||!text.trim())fail('没有真实反馈时保持 unknown');if(id)this.memory(id,scope);const receipt=this.ingest({scope,text,provenance:{kind:'explicit_feedback'},process:false});const fb={id:randomUUID(),scope,query_id,memory_id:id,text,kind,source_ref:receipt.source_id,created_at:this.clock(),inference:false};this.store.sql('INSERT INTO feedback VALUES(?,?,?)').run(fb.id,scope,JSON.stringify(fb));this.learnFromFeedback(fb);if(id&&kind==='counterexample'){const m=this.memory(id,scope);m.attributes.counterexamples=unique([...(m.attributes.counterexamples??[]),receipt.source_id]);m.source_refs=unique([...m.source_refs,receipt.source_id]);m.source_roots=unique([...m.source_roots,this.store.getSource(receipt.source_id).support_root]);m.review='needs_review';m.revision++;m.updated_at=this.clock();this.store.putMemory(m);this.invalidateDependents(id,m.revision-1);}return {feedback:fb,receipt};}
  outcome({scope,id,text,status='completed'}={}){const m=this.memory(id,scope);if(m.kind!=='intent'||!['completed','cancelled','waiting','blocked'].includes(status))fail('事项状态不正确');if(typeof text!=='string'||!text.trim())fail('完成或取消必须提供真实报告，不能从时间流逝推断');const receipt=this.feedback({scope,id,text,kind:'outcome_report'});m.attributes.status=status;m.attributes.outcome_source_refs=unique([...(m.attributes.outcome_source_refs??[]),receipt.receipt.source_id]);m.source_refs=unique([...m.source_refs,receipt.receipt.source_id]);m.revision++;m.updated_at=this.clock();this.store.putMemory(m);const state=this.store.state(scope);if(['completed','cancelled'].includes(status))state.open_loop_ids=state.open_loop_ids.filter(x=>x!==id);state.revision++;this.store.saveState(state);return m;}
  getConfig(){return {effective_config:this.config,version:this.configVersion,params:PARAMS,param_help:PARAM_HELP,group_policy_keys:GROUP_POLICY_KEYS,hard_rules:HARD_RULES,history:this.store.meta('config_history',[]).map(x=>({version:x.version,at:x.at}))};}
  methodResult({scope,id,text,environment,status}={}){this.requireScope(scope);const m=this.memory(id,scope);if(m.kind!=='method'||!['succeeded','failed','unknown'].includes(status))fail('方法结果状态不正确');if(typeof environment!=='string'||!environment.trim())fail('请说明这次方法应用的环境与适用条件');const result=this.feedback({scope,id,text,kind:'method_result_report'}),source=result.receipt.source_id;m.attributes.trials=[...(m.attributes.trials??[]),{environment,status,source_ref:source,at:this.clock(),verification:'operator_report_not_tool_receipt'}];m.attributes.verification=status==='unknown'?'outcome_unknown':'reported_'+status;m.attributes.environment=environment;m.attributes.outcome_source_refs=unique([...(m.attributes.outcome_source_refs??[]),source]);m.source_refs=unique([...m.source_refs,source]);m.revision++;m.updated_at=this.clock();this.store.putMemory(m);this.rebuildCatalogs(scope);return m;}
  updateConfig({region,values,expected_version}={}){if(expected_version!==this.configVersion)fail('参数已被其他窗口更新，请重新打开','REVISION_CONFLICT');if(!PARAMS[region]&&region!=='display')fail('参数所属区域不正确');const next=clone(this.config);for(const[k,v]of Object.entries(values??{})){const def=PARAMS[region]?.[k]??({visible_node_limit:['',20,500,1],edge_limit:['',0,1000,1],label_density:['',0,2,.1],display_focus_gain:['',1,3,.1],view_2d:['',0,1,1]})[k];if(!def||typeof v!=='number'||!Number.isFinite(v)||v<def[1]||v>def[2])fail(`参数 ${k} 超出允许范围`);if(region==='W3'&&['auto_implicit_enabled','auto_implicit_min_days','implicit_min_evidence'].includes(k)&&!Number.isInteger(v))fail('自动成熟开关与依据门槛必须为整数');if(region==='W5'&&GROUP_POLICY_KEYS.includes(k)&&!Number.isInteger(v))fail('群聊开关与期限必须为整数');next[region][k]=v;}const days=GROUP_POLICY_KEYS.slice(1).map(key=>next.W5[key]);if(days.some((day,i)=>i>0&&day<days[i-1]))fail('群聊期限必须按完整近期、进入残迹、低价值退出、普通残迹退出的顺序递增或相等');if(next.W5.forget_after_days<next.W5.lossy_after_days)fail('彻底遗忘期限不能早于普通有损整理期限');this.store.tx(()=>{const history=this.store.meta('config_history',[]);history.push({version:this.configVersion,at:this.clock(),config:this.config});this.store.setMeta('config_history',history.slice(-20));this.store.setMeta('effective_config',next);this.store.setMeta('config_version',this.configVersion+1);});this.config=next;this.configVersion++;return this.getConfig();}
  rollbackConfig({version,expected_version}={}){if(expected_version!==this.configVersion)fail('参数版本已变化','REVISION_CONFLICT');const previous=this.store.meta('config_history',[]).find(h=>h.version===version);if(!previous)fail('找不到回退版本','NOT_FOUND');const old={version:this.configVersion,at:this.clock(),config:this.config};const next=Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key,defaults])=>[key,{...defaults,...previous.config[key]}]));this.store.tx(()=>{const history=this.store.meta('config_history',[]);history.push(old);this.store.setMeta('config_history',history.slice(-20));this.store.setMeta('effective_config',next);this.store.setMeta('config_version',this.configVersion+1);});this.config=next;this.configVersion++;return this.getConfig();}
  protectedSources(scope='all',{currentOnly=false}={}){
    const args=scope==='all'?[]:[scope];
    const sql="SELECT v.id,v.revision,v.json FROM versions v JOIN memories m ON m.id=v.id WHERE m.protection IN ('P0','P1') AND m.layer!='forgotten'"+(scope==='all'?'':' AND m.scope=?');
    if(!currentOnly)return new Set(this.store.sql(sql).all(...args).flatMap(row=>this.store.decodeVersion(row).source_refs));
    const heads=this.store.sql("SELECT json FROM memories WHERE protection IN ('P0','P1') AND layer!='forgotten' AND validity='current'"+(scope==='all'?'':' AND scope=?')).all(...args).map(row=>this.store.decodeMemory(row.json)).filter(memory=>!automaticGroupExperience(memory));
    const ids=new Set(heads.map(m=>m.id)),versions=this.store.sql(sql).all(...args).filter(row=>ids.has(row.id)).map(row=>this.store.decodeVersion(row));
    return new Set([...heads,...versions].flatMap(memory=>[...memory.source_refs,...(memory.attributes.counterexamples??[])]));
  }

  learnFromFeedback(fb){if(!fb.memory_id||['rule_derivation','rule_review'].includes(fb.kind))return;const m=this.store.getMemory(fb.memory_id);if(!m||m.kind!=='pattern'||fb.kind==='counterexample')return;if(!/这样就好|有帮助|很好|对的|喜欢这个方式/.test(fb.text))return;const ruleRun=this.resolveRules(fb.scope,fb.text,'W5').length?this.beginRun(fb.scope,'conditional_learning'):null,old=m.attributes.pattern_gain??0;m.attributes.pattern_gain=old+(1-old)*this.config.W3.feedback_learning_rate*this.controls('W5',fb.scope,fb.text,ruleRun).learning_rate;m.attributes.supports=unique([...(m.attributes.supports??[]),fb.source_ref]);m.source_refs=unique([...m.source_refs,fb.source_ref]);m.revision++;m.updated_at=this.clock();this.store.putMemory(m);if(ruleRun)this.endRun(ruleRun);}
  protectionBundle(id,scope){const m=this.memory(id,scope),all=this.store.all(scope);const protectedMemories=all.filter(x=>['P0','P1'].includes(x.protection));const necessary=this.protectedSources(scope);const blocked=m.source_refs.some(id=>necessary.has(id));return {id,protected:blocked||['P0','P1'].includes(m.protection),required_source_refs:unique(m.source_refs),roots:m.source_roots,protection_reason:m.protection_reason,dependent_protected:protectedMemories.filter(x=>x.id!==m.id&&x.source_refs.some(s=>m.source_refs.includes(s))).map(x=>x.id)};}
  retentionPlan({scope='all',at=this.clock(),source_before=null,group_only=false}={}){this.requireScope(scope,true);if(source_before!==null&&(!Number.isSafeInteger(source_before)||source_before<=0||source_before>this.clock()))fail('原消息截止时间无效');if(!Number.isSafeInteger(at)||at<0)fail('治理时刻无效');const all=this.store.all(scope),protectedSources=this.protectedSources(scope),items=[],blocked=[],lifecycle=this.groupLifecycle(at);let groupItems=0;for(const m of all){if(m.kind==='archive_digest'||m.kind==='archive_chunk')continue;
      if(group_only&&!lifecycle.enabled(m.scope))continue;
      if(source_before!==null){const namespace=this.store.getScope(m.scope),dates=m.source_refs.map(id=>lifecycle.sourceDate(id,namespace));if(!dates.length||dates.some(date=>!date||date.at>=source_before))continue;}
      const group=lifecycle.resolve(m);
      if(group.applies){
        if(group.reason&&group.reason!=='inactive_record')blocked.push({id:m.id,reason:group.reason});
        // Protected evidence continues through the existing lossless protection path.
        if(group.reason!=='protected_memory'||m.kind==='raw'&&m.protection!=='P0'&&m.protection!=='P1'){
          const item=groupItems<this.config.W5.batch_size&&lifecycle.action(m,group);
          if(item){items.push(item);groupItems++;}
          continue;
        }
      }
      if(m.attributes.model_processing){blocked.push({id:m.id,reason:'model_handoff_pending'});continue;}if(m.handoff!==HANDOFF[5]){blocked.push({id:m.id,reason:'handoff_pending'});continue;}const age=m.occurred_at===null?null:Math.max(0,(at-m.occurred_at)/DAY),bundle={protected:['P0','P1'].includes(m.protection)||m.source_refs.some(s=>protectedSources.has(s))};if(m.kind==='intent'&&!['completed','cancelled'].includes(m.attributes.status)){blocked.push({id:m.id,reason:'unresolved_intent'});continue;}
      if(m.kind==='raw'&&Math.max(0,(at-m.created_at)/DAY)<this.config.W5.recent_hours/24){if(m.layer!=='recent')items.push({id:m.id,scope:m.scope,action:'move',target:'recent',revision:m.revision,reason:'近期完整原话'});continue;}
      if(bundle.protected){const layer=m.kind==='pattern'?(centralRuleStatus(this,m).effective?'implicit':'mature'):m.kind==='intent'?'intent':'deep';if(m.kind==='raw'&&m.storage==='full_hot')items.push({id:m.id,scope:m.scope,action:'pack',target:layer,revision:m.revision,reason:'重要原证据无损深藏'});else if(m.layer!==layer)items.push({id:m.id,scope:m.scope,action:'move',target:layer,revision:m.revision,reason:'重要精确保护'});continue;}
      if(m.kind==='pattern')continue;
      const save=(this.config.U.future_need*(m.attributes.assessment?.goal_link??.2)+this.config.U.loss_cost*(m.attributes.assessment?.loss_cost??.3)+this.config.U.uniqueness*(m.attributes.assessment?.uniqueness??.5)+this.config.U.rebuild_cost*.2)/Math.max(.001,Object.values(this.config.U).reduce((a,b)=>a+b,0));
      const accessAge=Math.max(0,(at-(m.last_strengthened_at??m.last_used_at??m.occurred_at??m.created_at))/DAY),access=Math.pow(2,-accessAge/this.config.W5.ordinary_half_life_days)*m.strength;
      const ordinaryTrace=m.protection==='P2'&&m.layer==='faint'&&m.importance<.45&&age!==null&&age>=this.config.W5.forget_after_days*2&&save<.4;
      if((m.protection==='P3'||ordinaryTrace)&&age!==null&&age>=this.config.W5.forget_after_days&&access+this.config.W5.low_value_recovery*.2<.25&&save<.5){items.push({id:m.id,scope:m.scope,action:'forget',target:'forgotten',revision:m.revision,reason:ordinaryTrace?'普通残迹已超过双倍遗忘周期、长期低可达且无保护依赖':'低价值、超期、可达性低且无保护依赖'});continue;}
      if(age!==null&&age>=this.config.W5.lossy_after_days&&['P2','P3'].includes(m.protection)&&!['gist_only','gist_with_evidence'].includes(m.storage)&&save<.6&&access<.75){
        // Complete cold originals need no repeated pack when neither text nor layer would change.
        // Re-evaluate the current source and ratio; a stale full-digest marker is insufficient.
        const settled=m.kind==='raw'&&m.storage==='lossless_cold'&&(m.layer==='faint'||m.protection==='P2'&&m.layer==='warm');
        const text=settled?this.body(m):null;
        if(!settled||text===null||makeGist(text,this.config.W5.summary_ratio).lossy)items.push({id:m.id,scope:m.scope,action:'summarize',target:'faint',revision:m.revision,reason:'普通内容允许有损要旨化，关键条件另保'});
        continue;
      }
      if(m.kind==='raw'&&m.storage==='full_hot'&&age!==null&&age>=this.config.W5.recent_hours/24)items.push({id:m.id,scope:m.scope,action:'pack',target:'warm',revision:m.revision,reason:'近期窗口结束，原文无损冷存'});
    }
    // Any body reused by a protected or non-forgetting object cannot be physically forgotten.
    const forgetting=new Set(items.filter(i=>i.action==='forget').map(i=>i.id));for(const item of items.filter(i=>i.action==='forget')){const m=this.store.getMemory(item.id);const dependents=all.filter(d=>d.id!==m.id&&d.source_refs.some(s=>m.source_refs.includes(s))&&!forgetting.has(d.id));if(dependents.length&&!this.config.W5.keep_raw_archive){item.action='blocked';blocked.push({id:item.id,reason:'shared_source_still_needed',dependents:dependents.map(d=>d.id)});}}
    const plan={id:randomUUID(),scope,at,source_before,group_only,created_at:this.clock(),config_version:this.configVersion,items:items.filter(i=>i.action!=='blocked'),blocked,protection_first:true,source_system_untouched:true};this.store.setMeta(`plan:${plan.id}`,plan);return plan;}
  applyRetention({plan_id}={}) {
    const plan=this.store.meta('plan:'+plan_id);
    if(!plan)fail('治理预览不存在','NOT_FOUND');
    if(plan.applied)return {...plan,replayed:true};
    if(plan.config_version!==this.configVersion)fail('参数已变化，请重新预览','REVISION_CONFLICT');
    const onlyGroupArchive=plan.items.every(item=>item.action==='group_archive');
    const protectedRefs=onlyGroupArchive?new Set():this.protectedSources(plan.scope),all=onlyGroupArchive?plan.items.map(item=>this.memory(item.id,item.scope)):this.store.all(plan.scope),lifecycle=this.groupLifecycle();
    const byId=new Map(all.map(m=>[m.id,m])), consumers=new Map(), deleting=new Set(plan.items.filter(i=>i.action==='forget').map(i=>i.id));
    for(const m of all)for(const sid of m.source_refs){if(!consumers.has(sid))consumers.set(sid,[]);consumers.get(sid).push(m.id);}
    for(const item of plan.items){
      const m=this.memory(item.id,item.scope);
      if(['group_archive','group_trash'].includes(item.action)){
        const current=lifecycle.action(m);
        if(!current||current.action!==item.action||current.group_phase!==item.group_phase||current.source_time!==item.source_time||current.target!==item.target)fail('群聊来源或阶段已变化，请重新预览','REVISION_CONFLICT');
      }
      if(m.revision!==item.revision)fail('记忆版本已变化，请重新预览','REVISION_CONFLICT');
      if(m.attributes.model_processing)fail('模型交接进行中，原文继续保护','PROTECTED_MEMORY');
      if(!plan.explicit_discard&&!['move','pack','group_archive','group_trash'].includes(item.action)&&(m.protection==='P0'||m.protection==='P1'||m.source_refs.some(id=>protectedRefs.has(id))))fail('保护依赖禁止有损处理','PROTECTED_MEMORY');
      if(item.action==='forget'&&!plan.explicit_discard&&!this.config.W5.keep_raw_archive&&m.source_refs.some(sid=>(consumers.get(sid)??[]).some(id=>!deleting.has(id))))fail('仍有保留对象依赖该原文，请重新预览完整依赖组','REVISION_CONFLICT');
    }
    const run=this.beginRun(plan.scope,'retention'),forgot=[],sourceCleanup=new Set(),groupSourceCleanup=new Set(),recycleEntries=new Map(),preserveRaw=!!this.config.W5.keep_raw_archive||!!plan.explicit_discard;
    for(const item of plan.items){const memory=this.memory(item.id,item.scope);if(['forget','group_trash'].includes(item.action))recycleEntries.set(item.id,{...this.trash.stash(memory,{reason:item.reason,kind:item.action==='group_trash'?'group_expiry':'forgotten'}),native_policy_keys:memory.attributes.native_policy_keys??[]});else if(item.action==='summarize'&&!preserveRaw&&(makeGist(this.body(memory)??'',this.config.W5.summary_ratio).lossy||memory.kind!=='raw'))recycleEntries.set(item.id,this.trash.stash(memory,{reason:'有损整理前的完整版本',kind:'precision_backup'}));}
    this.store.tx(()=>{
      for(const item of plan.items){
        const m=this.memory(item.id,item.scope),from=m.layer;
        if(item.action==='group_archive'){
          lifecycle.archive(m);
          this.event(run,'W5','U','群聊原文无损冷存与本地残迹整理',{input:[m.id],output:[m.id],extra:{phase:lifecycle.resolve(m).phase,policy_version:lifecycle.version}});
          continue;
        }
        if(item.action==='summarize'){
          const text=this.body(m)??'',gist=makeGist(text,this.config.W5.summary_ratio);
          m.attributes.lossy_digest={precision:gist.precision,mandatory_segments:gist.mandatory_segments,target_characters:gist.target_characters,actual_characters:gist.actual_characters};
          if(gist.lossy||m.kind!=='raw'){
            m.body=gist.body;if(recycleEntries.has(m.id))m.attributes.precision_backup_id=recycleEntries.get(m.id).id;m.storage='gist_only';m.representation=['gist'];m.evidence.alignment='extractive_lossy_digest';m.label=short(m.body,44);
            this.store.sql('DELETE FROM versions WHERE id=?').run(m.id);
            for(const sid of m.source_refs)sourceCleanup.add(sid);
          }else{
            item.action='pack';item.target=m.protection==='P3'?'faint':'warm';item.reason=m.protection==='P3'?'短来源已是最小线索，无损保留为残迹':'关键条件需要完整保留，改为无损冷存';
          }
        }
        if(item.action==='pack'){
          for(const sid of m.source_refs)this.store.packSource(sid);
          m.storage=m.kind==='raw'?'lossless_cold':'full_warm';m.attributes.source_storage='lossless_cold';
        }
        if(['forget','group_trash'].includes(item.action)){
          forgot.push({id:m.id,from_layer:from});
          const groupTrash=item.action==='group_trash';
          m.label=groupTrash?'群聊已移入废弃记忆库':preserveRaw?'已退出活跃记忆，原文已冷存':'已在本地遗忘';m.body=null;m.storage=groupTrash?'trash_only':preserveRaw?'archive_only':'eliminated';m.representation=[];m.attributes={forgotten_at:this.clock(),local_only:true,raw_archive_retained:!groupTrash&&!!preserveRaw,trash_id:recycleEntries.get(m.id).id,...(groupTrash?{group_retirement:{at:this.clock(),source_time:item.source_time,policy_version:this.configVersion,former_layer:from}}:{})};
          if(groupTrash){for(const key of recycleEntries.get(m.id).native_policy_keys??[])this.store.setMeta('native-group-retired:'+key,{at:this.clock(),memory_id:m.id});this.store.setMeta('group-trash-present',true);for(const sid of m.source_refs)groupSourceCleanup.add(sid);}
          this.store.sql('DELETE FROM versions WHERE id=?').run(m.id);
          this.store.sql('DELETE FROM lookup WHERE id=?').run(m.id);
          this.store.sql('DELETE FROM meta WHERE key LIKE ?').run('semantic:'+digest(m.id)+':%');
          for(const sid of m.source_refs)sourceCleanup.add(sid);
        }
        m.layer=item.target;m.revision++;m.updated_at=this.clock();byId.set(m.id,m);
        this.store.putMemory(m,['forget','group_trash'].includes(item.action)?'':item.action==='summarize'?m.body:null);
        this.event(run,'W5','U',item.action==='group_trash'?'群聊到期移入可恢复废弃记忆库':item.action==='forget'?(preserveRaw?'活跃星点沉档，L0原文仍可分层读取':'记忆已移入可恢复垃圾桶'):item.action==='summarize'?'普通记忆有损要旨化':item.action==='pack'?'原文无损压缩归档':'记忆分层迁移',{input:[m.id],output:['forget','group_trash'].includes(item.action)?[]:[m.id],extra:{memory_id:m.id,from_layer:from,to_layer:m.layer,meteor:item.action==='forget'&&!preserveRaw,archive_retired:item.action==='forget'&&!!preserveRaw,trash_retired:item.action==='group_trash',transition_reason:item.reason}});
      }
      for(const sid of sourceCleanup){
        if(groupSourceCleanup.has(sid)){const source=this.store.getSource(sid);if(source)this.archive.invalidatePeriod(source.scope,source.occurred_at);}
        const needed=(consumers.get(sid)??[]).some(id=>{const m=byId.get(id);return m&&m.layer!=='forgotten'&&!(groupSourceCleanup.has(sid)&&automaticGroupExperience(m))&&!['gist_only','gist_with_evidence'].includes(m.storage);});
        if(!needed){if(preserveRaw&&!groupSourceCleanup.has(sid))this.store.packSource(sid);else{if(!groupSourceCleanup.has(sid))this.archive.invalidateSources([sid]);this.store.deleteSource(sid);}}
      }
      if(plan.items.some(item=>item.action!=='group_archive'))for(const m of byId.values())if(m.storage==='gist_only'||m.storage==='gist_with_evidence'){const available=m.source_refs.some(sid=>this.store.getSource(sid));const next=available?'gist_with_evidence':'gist_only';if(m.storage!==next){m.storage=next;this.store.putMemory(m,null,{history:false});}}
      if(groupSourceCleanup.size)this.semantic.erase(unique([...groupSourceCleanup].flatMap(sid=>consumers.get(sid)??[])));
      const forgottenIds=new Set(forgot.map(x=>x.id));
      for(const scope of new Set(forgot.map(item=>byId.get(item.id).scope))){const state=this.store.state(scope),sourceIds=new Set(forgot.filter(item=>byId.get(item.id).kind==='raw').flatMap(item=>byId.get(item.id).source_refs));state.choices=state.choices.filter(item=>!forgottenIds.has(item.memory_id));state.open_loop_ids=state.open_loop_ids.filter(id=>!forgottenIds.has(id));state.source_refs=state.source_refs.filter(id=>!sourceIds.has(id));state.negations=state.negations.filter(item=>!sourceIds.has(item.source_ref));if(state.stage_affect&&forgottenIds.has(state.stage_affect.memory_id))state.stage_affect=null;state.revision++;this.store.saveState(state);}
      if(forgottenIds.size){
        for(const row of this.store.sql('SELECT json FROM recalls').all()){
          const recall=JSON.parse(row.json);let changed=false;
          for(const candidate of recall.candidates??[])if(forgottenIds.has(candidate.id)){candidate.label='已在本地遗忘';candidate.text=null;changed=true;}
          if(recall.context?.some(c=>forgottenIds.has(c.id))){recall.context=recall.context.filter(c=>!forgottenIds.has(c.id));changed=true;}
          if(recall.output?.cited_ids?.some(id=>forgottenIds.has(id))||forgottenIds.has(recall.input_memory_id)){recall.output.text='相关来源已在本地遗忘，历史表达不再展开。';recall.output.cited_ids=recall.output.cited_ids.filter(id=>!forgottenIds.has(id));recall.query='（关联输入已在本地淘汰）';changed=true;}
          if(changed)this.store.recall(recall);
        }
        for(const row of this.store.sql("SELECT key,json FROM meta WHERE key LIKE 'model-chat:%'").all()){
          const cache=JSON.parse(row.json),answer=cache.result;
          if(forgottenIds.has(answer?.input_receipt?.memory_id)||(answer?.context??[]).some(c=>forgottenIds.has(c.id)))this.store.sql('DELETE FROM meta WHERE key=?').run(row.key);
        }
      }
      plan.applied=true;plan.applied_at=this.clock();plan.run_id=run.id;this.store.setMeta('plan:'+plan.id,plan);
    });
    if(groupSourceCleanup.size)this.groupTrashPresent=true;
    if(plan.items.some(item=>item.action!=='group_archive'))this.rebuildCatalogs(plan.scope);this.endRun(run);return {...plan,forgotten:forgot};
  }

  groupLifecycleStatus(scope='all'){
    this.requireScope(scope,true);
    const lifecycle=this.groupLifecycle(),status={enabled:this.config.W5.group_policy_enabled===1,version:this.configVersion,
      coverage:{...GROUP_POLICY_COVERAGE,...this.externalGroupCoverage?.()},retired:Number(this.store.sql("SELECT count(*) AS n FROM memories WHERE layer='forgotten' AND json_extract(json,'$.attributes.group_retirement.at') IS NOT NULL"+(scope==='all'?'':' AND scope=?')).get(...(scope==='all'?[]:[scope])).n),count_unit:'memory_objects',blocked_labels:GROUP_HOLD_LABELS,active:0,expired:0,pending:0,processed:0,protected:0,unknown:0,blocked:{}};
    if(!status.enabled)return status;
    const groups=(scope==='all'?this.store.scopes().map(entry=>entry.id):[scope]).filter(id=>lifecycle.enabled(id));
    for(const id of groups)for(const memory of this.store.all(id)){
      const state=lifecycle.resolve(memory);
      if(state.reason==='inactive_record')continue;
      if(state.eligible)status.active++;else if(state.phase==='expired')status.expired++;
      if(state.reason){
        status.blocked[state.reason]=(status.blocked[state.reason]??0)+1;
        if(['protected_memory','protected_source','unresolved_intent'].includes(state.reason))status.protected++;
        else if(state.reason.endsWith('pending'))status.pending++;
        else status.unknown++;
      }else if(lifecycle.action(memory,state))status.pending++;
      else if(['trace','expired','related'].includes(state.phase))status.processed++;
    }
    return status;
  }
  governance(){const stats=this.store.stats(),all=this.store.all(),health=[];for(const m of all.filter(m=>['P0','P1'].includes(m.protection))){const missing=m.source_refs.filter(s=>!this.store.getSource(s));if(missing.length)health.push({id:m.id,error:'protected_source_missing',missing});}const page=stats.bytes;return {stats,capacity_mb:this.config.W5.capacity_mb,capacity_used_ratio:page/(this.config.W5.capacity_mb*1024*1024),protected:all.filter(m=>['P0','P1'].includes(m.protection)).length,health,priority:'前台可读 > 重要交接 > 低价值丰富化',jobs:this.store.sql("SELECT json FROM jobs WHERE status!='done' ORDER BY created LIMIT 20").all().map(r=>JSON.parse(r.json)),hard_rules:HARD_RULES,lossy_precision_explicit:true,maintenance:this.maintenanceWindow()};}
  checkIntents(){let count=0;for(const {json} of this.store.sql("SELECT json FROM memories WHERE kind='intent' AND layer!='forgotten'").all()){const m=this.store.decodeMemory(json);if(['completed','cancelled'].includes(m.attributes.status))continue;const due=m.attributes.due_at;if(due===null||due===undefined||due>this.clock()||m.attributes.trigger_status==='due')continue;const run=this.beginRun(m.scope,'intent_trigger');m.attributes.trigger_status='due';m.attributes.trigger_observed_at=this.clock();m.revision++;m.updated_at=this.clock();this.store.putMemory(m);this.event(run,'W5','W2','未完意图到达已知日期／时间条件',{output:[m.id],extra:{execution_status:'not_executed'}});this.event(run,'W2','W4','准备面板到期提示，承诺仍未完成',{output:[m.id]});this.event(run,'W4','OUT','意图触发仅在本机面板显示',{output:[m.id],extra:{external_sent:false,completed:false}});this.endRun(run);count++;}return {triggered:count};}
  maintenanceWindow(){return maintenanceWindow(this.clock(),this.config.W5);}
  maintenance(){this.checkIntents();const window=this.maintenanceWindow();if(!window.allowed)return {applied:false,items:[],deferred:true,window};const plan=this.retentionPlan(),selected=new Map(plan.items.slice(0,this.config.W5.batch_size).map(i=>[i.id,i]));let grew=true;while(grew){grew=false;const sources=new Set([...selected.values()].filter(i=>i.action==='forget').flatMap(i=>this.memory(i.id).source_refs));for(const item of plan.items)if(item.action==='forget'&&!selected.has(item.id)&&this.memory(item.id).source_refs.some(id=>sources.has(id))){selected.set(item.id,item);grew=true;}}plan.items=[...selected.values()];this.store.setMeta(`plan:${plan.id}`,plan);const result=plan.items.length?this.applyRetention({plan_id:plan.id}):{applied:false,items:[]};if(this.store.file!==':memory:'&&this.clock()-this.store.meta('storage_maintenance_at',0)>=86400000){const removed=this.store.tx(()=>this.store.codec.prune());result.storage={removed_reference_sets:removed,...this.store.compactStorage()};this.store.setMeta('storage_maintenance_at',this.clock());}return result;}
  trace(id){const row=this.store.sql('SELECT json FROM runs WHERE id=?').get(id);if(!row)fail('运行不存在','NOT_FOUND');const run=JSON.parse(row.json),seen=new Set(),events=[];const collect=(value,depth)=>{if(depth>4||seen.has(value.id))return;seen.add(value.id);events.push(...this.store.events({run_id:value.id,limit:1000}));for(const key of['input_run_id','retrieval_run_id','semantic_input_run_id','semantic_routing_run_id','draft_run_id']){const childId=value.metadata?.[key];if(!childId)continue;const child=this.store.sql('SELECT json FROM runs WHERE id=?').get(childId);if(child){const parsed=JSON.parse(child.json);if(parsed.scope===run.scope||run.scope==='all')collect(parsed,depth+1);}}};collect(run,0);events.sort((a,b)=>a.sequence-b.sequence);return {run,events,included_run_ids:[...seen],event_count:events.length,complete:events.length<1000};}
  rememberSource({scope,source_id,quote,subject=null}={}){
    this.requireScope(scope);const source=this.store.getSource(source_id);
    if(!source||this.groupLifecycle().retiredSource(source_id)||source.scope!==scope||source.role!=='user'||typeof quote!=='string'||quote.length<3||!source.text.includes(quote))fail('记事必须精确引用当前范围内仍存在的用户原话');
    const id='remembered:'+digest([scope,source_id,quote]),existing=this.store.getMemory(id);if(existing)return {memory:existing,cached:true};
    const parent=this.memory('raw:'+source_id,scope),run=this.beginRun(scope,'explicit_remember');
    const memory=this.derive(parent,{id,kind:'claim',label:short(quote,44),body:quote,source_refs:[source_id],source_roots:[source.support_root],protection:parent.protection==='P0'?'P0':'P1',protection_reason:'明确记事，保留精确原话与来源',attributes:{subject:subject??source.speaker_id,quote,explicit_remember:true,basis_refs:[{id:parent.id,revision:parent.revision}]},evidence:{origin:'direct_statement',alignment:'exact_quote_aligned',truth:'source_report'},representation:['exact_claim']});
    this.event(run,'W2','W5','明确记事并保留必要原话',{input:[parent.id],output:[memory.id]});this.event(run,'W5','U','记事对象已可靠提交',{output:[memory.id]});this.endRun(run);this.rebuildCatalogs(scope);return {memory,run_id:run.id};
  }
  personMemory({scope,uid=null,limit=12}={}){
    this.requireScope(scope);const lifecycle=this.groupLifecycle();return this.store.all(scope).filter(m=>m.kind!=='archive_chunk'&&m.validity==='current'&&m.review==='ready'&&m.region_ids.includes('M3')&&(!uid||[m.attributes.speaker_id,m.attributes.subject,m.attributes.native_uid].includes(uid))).slice(-Math.max(1,Math.min(40,limit))).flatMap(m=>{const view=lifecycle.retiredRefs(m).length?lifecycle.project(m,{onDemand:true}):null;if(lifecycle.retiredRefs(m).length&&!view)return [];return [{id:m.id,label:view?.projected?short(view.text,44):m.label,text:view?.text??this.body(m),kind:m.kind,precision:view?.precision??m.storage,source_refs:view?.refs??m.source_refs}];});
  }
  eraseSources(sourceIds,{reason='明确隐私删除'}={}){
    const ids=new Set(sourceIds);for(const id of this.selfReflection.dependentSources(ids))ids.add(id);const affected=new Set(),memories=new Set(),erasedStars=[];if(!ids.size)return {erased:0};
    this.store.tx(()=>{for(const id of ids)this.store.setMeta('erased-source:'+digest(id),true);this.store.setMeta('trash-erasure-pending',unique([...this.store.meta('trash-erasure-pending',[]),...ids]));});
    this.trash.purgeSources([...ids]);this.store.setMeta('trash-erasure-pending',[]);
    this.store.tx(()=>{
      erasedStars.push(...this.archive.invalidateSources([...ids]));
      for(const row of this.store.sql('SELECT json FROM memories').all()){
        const m=this.store.decodeMemory(row.json);if(!m.source_refs.some(id=>ids.has(id)))continue;affected.add(m.scope);memories.add(m.id);if(m.layer!=='forgotten')erasedStars.push({id:m.id,scope:m.scope,layer:m.layer});m.body=null;m.label='已明确删除';m.layer='forgotten';m.storage='eliminated';m.validity='withdrawn';m.representation=[];m.attributes={explicit_erasure:true,reason,erased_at:this.clock()};m.revision++;this.store.putMemory(m,'',{history:false});this.store.sql('DELETE FROM versions WHERE id=?').run(m.id);this.store.sql('DELETE FROM jobs WHERE memory_id=?').run(m.id);
      }
      for(const scope of affected){
        const state=this.store.state(scope);state.source_refs=state.source_refs.filter(id=>!ids.has(id));state.choices=state.choices.filter(item=>!ids.has(item.source_ref)&&!memories.has(item.memory_id));state.open_loop_ids=state.open_loop_ids.filter(id=>!memories.has(id));state.negations=state.negations.filter(item=>!ids.has(item.source_ref));
        if(state.stage_affect&&memories.has(state.stage_affect.memory_id))state.stage_affect=null;
        state.active_topic=null;state.suspended_topics=[];state.revision++;this.store.saveState(state);
        this.store.sql('DELETE FROM feedback WHERE scope=?').run(scope);
      }
      for(const id of memories)this.store.sql('DELETE FROM relations WHERE from_id=? OR to_id=?').run(id,id);
      for(const id of ids)this.store.deleteSource(id);
      for(const row of this.store.sql("SELECT key,json FROM meta WHERE key LIKE 'semantic:%' OR key LIKE 'model-chat:%' OR key LIKE 'plan:%' OR key LIKE 'fact-current:%'").all())if([...ids].some(id=>row.json.includes(id))||[...memories].some(id=>row.json.includes(id)))this.store.sql('DELETE FROM meta WHERE key=?').run(row.key);
      for(const row of this.store.sql('SELECT json FROM recalls').all()){const recall=JSON.parse(row.json);if(affected.has(recall.scope)){recall.context=[];recall.query='（明确删除后不再保留关联检索文字）';recall.candidates=[];if(recall.output)recall.output.text='相关来源已明确删除';this.store.recall(recall);}}
    });
    for(const scope of affected){this.rebuildCatalogs(scope);const run=this.beginRun(scope,'privacy_erasure');this.event(run,'W5','U','明确删除来源及依赖摘要，原文归档也不保留',{count:ids.size,extra:{reason}});for(const star of erasedStars.filter(star=>star.scope===scope))this.event(run,'W5','U','明确删除对应星点',{extra:{memory_id:star.id,from_layer:star.layer,to_layer:'forgotten',meteor:true}});this.endRun(run);}
    this.strategyLearning.eraseScopes(affected);this.dialogue.eraseScopes(affected);this.selfReflection.eraseScopes(affected);this.semantic.erase(memories);if(this.store.fts)for(const id of memories){this.store.sql('DELETE FROM lookup_fts WHERE id=?').run(id);this.store.sql('DELETE FROM lookup_fts_done WHERE id=?').run(id);}
    this.store.tx(()=>this.store.codec.prune());return {erased:ids.size,affected:[...affected]};
  }
  discardMemory({scope,id,expected_revision,reason}={}){
    const memory=this.memory(id,scope);if(memory.revision!==expected_revision||memory.layer==='forgotten'||memory.validity==='withdrawn'||!reason?.trim())fail('记忆已变化、已退役或缺少理由','REVISION_CONFLICT');
    const refs=new Set(memory.source_refs),targets=memory.kind==='raw'?this.store.all(scope).filter(m=>!m.kind.startsWith('archive_')&&m.source_refs.some(s=>refs.has(s))):[memory];
    if(targets.some(m=>m.attributes.model_processing))fail('模型交接进行中，请稍后移入垃圾桶','PROTECTED_MEMORY');
    const plan={id:randomUUID(),scope,at:this.clock(),created_at:this.clock(),config_version:this.configVersion,explicit_discard:true,items:targets.map(m=>({id:m.id,scope,action:'forget',target:'forgotten',revision:m.revision,reason})),blocked:[]};
    this.store.setMeta('plan:'+plan.id,plan);return this.applyRetention({plan_id:plan.id});
  }
  trashList(options){return this.trash.list(options);}
  restoreTrash(options){return this.trash.restore(options);}
  contextReport(options){return contextReport(this,options);}
  factIndex(options){return factIndex(this,options);}
  writeFact(options){return writeFact(this,options);}
  restoreFact(options){return restoreFact(this,options);}
  close(){this.store.close();}
}










