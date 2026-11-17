/** Human-readable evidence stages. Never equates request completion with internal adoption. */
export function recallPresentation(row){
  const receipts=row.host_receipts??[],latest=receipts.at(-1),hasMemory=(row.host_context_ids??row.context??[]).length>0,hasStrategy=!!row.dialogue_strategy?.text;
  const included=!!latest||row.request_inclusion==='observed_at_dsh_llm_boundary';
  const prepared=['returned_from_module_prompt_hook','prepared_at_module_hook'].includes(row.request_inclusion);
  let request_label=included?'已核对进入DSH模型请求':prepared?'已准备资料，尚未观察到请求回执':'本地检索记录，未核对进入聊天请求';
  if(row.request_inclusion==='returned_to_host_tool')request_label='资料已返回记忆查询工具，尚未核对后续模型请求';
  if(row.request_inclusion==='confirmed_sent_to_provider')request_label='已提交模型服务';
  if(row.request_inclusion==='submitted_to_host_model_api_provider_request_unknown')request_label='已提交DSH模型接口，等待供应端核实';
  if(!hasMemory&&!hasStrategy)request_label='本轮未装入记忆或表达参考';
  const completion_label=latest?.completion==='completed'?'模型请求已完成':latest?.completion==='pending'?'模型请求进行中':latest?'请求未正常完成':'尚无请求完成回执';
  let usage_label='模型内部是否采用未被证实；请求完成不代表记忆已采用';
  if(!hasMemory&&!hasStrategy)usage_label='本轮没有装入资料，无需判断采用';
  else if(row.actual_use==='model_reported_references')usage_label=row.output?.cited_ids?.length?'模型标注了引用；内部采用仍未独立证实':'本轮模型未标注引用；内部采用仍未独立证实';
  else if(['model_cited','model_marked','model_reported'].includes(row.actual_use)||row.output?.cited_ids?.length)usage_label='模型标注了引用；内部采用仍未独立证实';
  else if(row.actual_use==='confirmed_by_feedback')usage_label='已有明确反馈关联，仍需结合具体依据理解';
  return {...row,presentation:{request_label,completion_label,usage_label,summary:request_label+'；'+completion_label,has_memory:hasMemory,has_strategy:hasStrategy,request_observed:included}};
}
