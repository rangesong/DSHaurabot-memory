export function renderEvaluationReport(target,report,{el,date,number}){
  if(!report?.available)return;
  const box=el('section','source-card');
  box.append(el('p','eyebrow','HISTORY / 隔离真实模型验证'),el('h3','',report.status==='running'?'历史验证正在运行':report.status==='passed'?'历史验证完成 · 核对项通过':'历史验证完成 · 有项目需复核'),el('p','hint',`${date(report.started_at)} · 模型调用 ${report.calls} 次 · QQ发送 ${report.qq_sends} · 工具执行 ${report.tools_executed}`),el('p','hint','本次复用 Thinkstar 的召回和注入代码，直接通过 DSH 模型发起隔离请求；没有进入 Aurabot 正常聊天、QQ发送或工具执行链。核对通过不证明模型内部因果采用。'),el('p','hint',`记忆上限：${number(report.initial_cap)} → ${number(report.final_cap)} tokens。${report.cap_change_reason??'没有自动扩大上限。'}`));
  if(report.cohort)box.append(el('p','hint',report.cohort));
  if(report.ordinary_dialogue){const ordinary=report.ordinary_dialogue;box.append(el('div','notice',`普通对话独立记账：累计返回资料 ${ordinary.prepared.n} 次；本版协同启用后 ${ordinary.prepared.recent??0} 次（${date(ordinary.since)}起）；普通对话请求边界回执 ${ordinary.receipts} 条。隔离模型复测不充当普通对话验收，也不证明模型内部实际采用。`));}
  if(report.history?.length){const history=el('details'),summary=el('summary','','修复前后与历次验证记录');history.append(summary,el('p','hint','保留最近8批可追溯记录；同题复测与双模块快照条件不同，不能据此宣称长期效果或全部功能已验证。'));for(const run of report.history)history.append(el('p','source-head',`${date(run.started_at)} · ${run.cohort} · ${run.status}`),...run.attempts.filter(row=>!row.control).map(row=>el('p','hint',`${row.case_id}：原话覆盖 ${row.original_coverage} · 注入 ${row.injected} · 请求 ${row.receipt??'未获得'} · ${row.chain_ok?'通过':'待复核'}`)));box.append(history);}
  for(const attempt of report.attempts){
    const card=el('article','source-card');card.append(el('p','source-head',attempt.control?'无记忆对照':`${attempt.case_id} · 上限 ${attempt.cap}${attempt.superseded?' · 扩大额度前的记录':''}`),el('p','',attempt.question));
    if(attempt.status==='preparing'||attempt.status==='calling')card.append(el('p','hint','正在准备或等待模型回答…'));
    if(attempt.answer)card.append(el('div','output-box',attempt.answer));
    const receipt=attempt.request_receipt;
    if(!attempt.control)card.append(el('p','hint',`召回候选 ${attempt.candidates?.length??0} · 注入 ${attempt.injected_ids?.length??0} · 命中选定原话 ${attempt.source_coverage?.length??0} · 请求回执 ${receipt?.completion==='completed'?'完成':receipt?.completion??'未获得'}`));
    card.append(el('p','hint',`预期要点${attempt.expected_present?'已出现／正确保留未知':'未通过'}（词面核对） · 模型声明引用 ${attempt.cited_ids?.length??0} · 引用范围${attempt.citations_valid?'有效':'待核对'} · 本例${attempt.chain_ok?'核对通过':'待复核'}`));
    if(attempt.assessment)card.append(el('div',attempt.chain_ok?'notice':'notice warning',attempt.assessment));
    if(attempt.evidence_backtrace)card.append(el('p','hint',`原话回查 ${attempt.evidence_backtrace.length} 条路径 · 模型声明引用选定原话 ${attempt.cited_original_supported?'已核对':'未确认'}。`));
    if(attempt.coordination)card.append(el('p','hint',`共同供给：原生资料${attempt.coordination.native_observed?'已核对':'未出现在本次输入'}；重复合并 ${attempt.coordination.own_duplicates.length+attempt.coordination.native_duplicates.length} 项；移除无关原生条目 ${attempt.coordination.native_unrelated} 项；来源／事实版本优先 ${attempt.coordination.conflicts.length} 项；未确认冲突 ${attempt.coordination.unresolved.length} 项。`));
    if(receipt?.usage)card.append(el('p','hint',`整次实测用量：输入 ${number(receipt.usage.prompt_tokens)} / 输出 ${number(receipt.usage.completion_tokens)} tokens。`));
    if(attempt.budget?.host_sizing)card.append(el('p','hint',`额度方式：${attempt.budget.host_sizing.mode==='host_meter_estimate'?'DSH会话计量估算':'模块上限回退'}；已装配约 ${attempt.budget.used_estimate} / ${attempt.budget.available} tokens。`));
    if(attempt.error_code)card.append(el('div','notice warning',`${attempt.error_code} · ${attempt.error_detail??'本例未完成，不自动重复调用模型。'}`));
    if(attempt.injected_evidence?.length){const details=el('details',''),summary=el('summary','','查看本例实际注入的原话与来源');details.append(summary);for(const item of attempt.injected_evidence)details.append(el('p','source-head',item.id),el('p','output-box',item.text),el('p','source-foot','来源：'+item.source_refs.join('、')));card.append(details);}
    box.append(card);
  }
  target.append(box);
}
