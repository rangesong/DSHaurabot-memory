const W='mcp__fish-world__world_';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(key=>key!=='request_id').sort().map(key=>[key,canonical(value[key])])):value;

// Only ordinary background plans are constrained here. Owner turns and real
// event handling retain their existing priority, action and delivery paths.
export function planActivityGuard(data,round,tool,args={},now=Date.now()){
  if(!round||!['plan','idle'].includes(round.kind)||round.readOnly)return;
  if(![W+'go',W+'do'].includes(tool))return;
  const plan=data.life?.plans?.find(plan=>plan.id===round.planId),proof=plan?.lastProgressProof;
  if(proof?.executedStep&&plan.nextStep===proof.executedStep&&proof.actions?.some(action=>action.tool===tool&&JSON.stringify(canonical(action.args))===JSON.stringify(canonical(args))))return '当前计划的这一步已有成功回执；先核对完成结果并明确后续步骤，不能以新的请求编号重复已确认动作。';
  const sampled=Number(data.at?.state)||0;
  if(!sampled||sampled>now||now-sampled>180000)return;
  const state=data.state||{};
  if(state.where?.kind==='trip')return '当前行程尚未真实到达；普通计划等待到达后再续行，不重复出发或改道。主人新安排仍优先。';
  if(!state.doing)return;
  const working=/work|打工|上班|零工|帮工/.test(JSON.stringify(state.doing));
  if(working&&tool===W+'do'&&/^task-\d+$/.test(args.id||''))return;
  return '当前活动尚未真实结束；普通计划等待完成通知后再续行，不以另一份日程打断。班内待办和主人新安排仍按原规则处理。';
}
