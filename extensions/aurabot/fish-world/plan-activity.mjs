const W='mcp__fish-world__world_';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>key!=='request_id').sort().map(key=>[key,canonical(value[key])])):value;

// world_now's server-owned prefix is date/weather, location, optional activity,
// then body. Never search notification, conversation or quoted body text.
export function parseWorldNowActivity(text){
  if(typeof text!=='string')return;
  const lines=text.split(/\r?\n/,4);
  if(!/^\d{2}-\d{2} 周[一二三四五六日天] (?:[01]\d|2[0-3]):[0-5]\d · [^\r\n]+$/.test(lines[0]||''))return;
  const location=/^你在：([^\r\n]+)$/.exec(lines[1]||'')?.[1];if(!location)return;
  const activity=/^在做：([^\r\n]+)$/.exec(lines[2]||'')?.[1];
  if(!/^身体：[^\r\n]+$/.test(lines[activity?3:2]||''))return;
  const trip=/^去.+的路上（[^（）\r\n]+），(?:[01]?\d|2[0-3]):[0-5]\d 到$/.test(location);
  if(!trip&&/路上|途中|在途|前往|行程/.test(location))return;
  return {where:{kind:trip?'trip':'place',text:location},doing:activity?{name:activity}:null};
}
function observedState(data,round,now){
  if(!round.id||!round.sessionId||!round.observationId||!Number.isFinite(round.startedAt))return;
  const journal=data.life?.journal||[],row=journal.findLast(row=>row.id===round.observationId),receipt=round.receipts?.findLast(row=>row.id===round.observationId);
  if(!row||row.tool!==W+'now'||row.round!==round.id||row.sessionId!==round.sessionId||row.status!=='confirmed'||row.isError||!receipt||receipt.tool!==row.tool||receipt.isError||receipt.text!==row.result||round.observation!==row.result)return;
  if(!Number.isFinite(row.at)||row.at<round.startedAt||!Number.isFinite(row.finishedAt)||row.finishedAt<row.at||row.finishedAt>now||now-row.finishedAt>180000||row.finishedAt<=(Number(data.at?.state)||0))return;
  // An observation made before another submitted go/do cannot certify the
  // resulting location/activity, even while the structural cache is lagging.
  if(journal.some(later=>later.round===round.id&&later.sessionId===round.sessionId&&[W+'go',W+'do'].includes(later.tool)&&later.at>=row.finishedAt&&['executing','confirmed','uncertain'].includes(later.status)))return;
  const state=parseWorldNowActivity(row.result);return state?{state,at:row.finishedAt}:undefined;
}

// Only ordinary background plans are constrained here. Owner turns and real
// event handling retain their existing priority, action and delivery paths.
export function planActivityGuard(data,round,tool,args={},now=Date.now()){
  if(!round||!['plan','idle'].includes(round.kind)||round.readOnly)return;
  if(![W+'go',W+'do'].includes(tool))return;
  const plan=data.life?.plans?.find(plan=>plan.id===round.planId),proof=plan?.lastProgressProof;
  if(proof?.executedStep&&plan.nextStep===proof.executedStep&&proof.actions?.some(action=>action.tool===tool&&JSON.stringify(canonical(action.args))===JSON.stringify(canonical(args))))return '当前计划的这一步已有成功回执；先核对完成结果并明确后续步骤，不能以新的请求编号重复已确认动作。';
  const observation=observedState(data,round,now),sampled=observation?.at||Number(data.at?.state)||0;
  if(!sampled||sampled>now||now-sampled>180000)return;
  const state=observation?.state||data.state||{};
  if(state.where?.kind==='trip')return '当前行程尚未真实到达；普通计划等待到达后再续行，不重复出发或改道。主人新安排仍优先。';
  if(!state.doing)return;
  const working=/work|打工|上班|零工|帮工/.test(JSON.stringify(state.doing));
  if(working&&tool===W+'do'&&/^task-\d+$/.test(args.id||''))return;
  return '当前活动尚未真实结束；普通计划等待完成通知后再续行，不以另一份日程打断。班内待办和主人新安排仍按原规则处理。';
}
