import {recallPresentation} from './v5-recall-presentation.js';
export function contextReport(runtime,{scope='all',limit=20}={}){
  runtime.requireScope(scope,true);
  const rows=runtime.store.recalls(scope,Math.max(1,Math.min(100,Number(limit)||20))).filter(row=>row.kind!=='upstream');
  const reports=rows.map((row,index)=>{
    const composition={recent:0,state:0,long:0,optional:0},omitted={};
    for(const item of row.context??[])composition[item.allocation_group??'long']+=(item.token_estimate??Math.ceil((item.text?.length??0)/2));
    for(const item of row.omitted??[])omitted[item.reason]=(omitted[item.reason]??0)+1;
    const ids=new Set((row.context??[]).map(item=>item.id)),previous=rows.slice(index+1).find(previous=>previous.scope===row.scope),before=new Set((previous?.context??[]).map(item=>item.id));
    return {id:row.id,scope:row.scope,at:row.created_at,query:row.query,composition,omitted,
      presentation:recallPresentation(row).presentation,budget:row.budget,inclusion:row.request_inclusion??'prepared_local_only',actual_use:row.actual_use,model_usage:row.model_usage??null,
      host_serialized_estimate:row.host_context_tokens_estimate??null,host_included_ids:row.host_context_ids??null,
      host_receipts:row.host_receipts??[],
      coordination:row.coordination??null,evidence_backtrace:row.evidence_backtrace??[],
      added:[...ids].filter(id=>!before.has(id)),removed:[...before].filter(id=>!ids.has(id)),
      candidates:(row.candidates??[]).map(item=>({id:item.id,scope:item.scope,label:item.label,score:item.score,bm25:item.bm25,assembly:item.assembly,actual_use:item.actual_use,reasons:item.reasons})),
    };
  });
  return {scope,reports,measurement:'character_based_estimate_unless_provider_usage_is_reported',host_window:'host_meter_estimate_when_available_not_exact_tokenization',archive:runtime.archive.stats()};
}
