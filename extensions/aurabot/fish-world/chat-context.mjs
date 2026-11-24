import {clean} from './state.mjs';

const freshnessMs=180000;
const maxContextChars=1000;
const header='【鱼的世界·当前背景；不是主人发言】\n';
const historyHint='\n这是简短投影，省略不代表没有或已完成；完整状态用 fish_world_state，原始要求、步骤、计划和历史用 fish_life_history 按引用读取。';
const activityHint='当前世界状态用于校正更早世界叙事，不覆盖主人较新事实；不要凭旧叙事补出当前活动。doing=null仅表示无当前主活动，未展示的并行活动查完整状态；until不证明已完成。';
const text=(value,limit)=>{
  if(typeof value!=='string')return '';
  const valueText=clean(value).toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim();
  return valueText.length>limit?valueText.slice(0,Math.max(0,limit-1)).toWellFormed()+'…':valueText;
};
const time=value=>Number.isFinite(value)&&value>0?value:undefined;
function activity(value,limit){
  if(value===null)return null;
  if(typeof value==='string')return text(value,Math.min(limit,64))||undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const name=text(value.name,Math.min(limit,64));
  if(!name)return text(value.text,Math.min(limit,64))||undefined;
  const result={name};
  // Preserve server clock strings, including HH:mm, without inventing dates or completion.
  for(const key of ['since','until']){const stamp=text(value[key],40);if(stamp)result[key]=stamp;}
  if(Array.isArray(value.with))result.with=value.with.filter(item=>typeof item==='string').slice(0,2).map(item=>text(item,Math.min(limit,24))).filter(Boolean);
  return result;
}

/** A read-only projection for ordinary owner chats; the execution ledger stays intact. */
export function chatWorldContext(data={},life={}, {body=true,location=true,now=Date.now()}={}){
  const state=data.state,observedAt=data.at?.state;
  const fresh=!!state&&Number.isFinite(observedAt)&&observedAt>0&&observedAt<=now&&now-observedAt<=freshnessMs;
  const active=(life.ownerTasks||[]).filter(task=>task?.status==='active'&&(!life.owner||task.owner===life.owner)&&(!life.persona||task.persona===life.persona)&&typeof task.id==='string'&&task.id.length>0&&task.id.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(task.id))
    .sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  const selected=active.slice(0,2);
  const packet=(limit,count)=>{
    const current={fresh, ...(fresh?{observedAt:new Date(observedAt).toISOString()}: {note:'当前世界状态已过时或尚不可用，不要把旧身体、位置或穿着当作此刻事实。'})};
    if(fresh){
      if(typeof state.time==='string')current.time=text(state.time,40);
      if(state.stage)current.stage=text(state.stage,24);
      if(body){
        const condition=text(state.body?.text,Math.min(limit,80));if(condition)current.body=condition;
        const outfit={name:text(state.outfit?.name,Math.min(limit,40)),look:text(state.outfit?.look,Math.min(limit,88))};
        if(outfit.name||outfit.look)current.outfit=outfit;
      }
      if(location){
        const where=text(state.where?.text,Math.min(limit,48));if(where)current.where=where;
        const doing=activity(state.doing,limit);if(doing!==undefined)current.doing=doing;
        const weather=state.weather;if(weather&&(typeof weather.sky==='string'||Number.isFinite(weather.temp)))current.weather={...(typeof weather.sky==='string'?{sky:text(weather.sky,16)}:{}),...(Number.isFinite(weather.temp)?{temp:weather.temp}:{})};
      }
    }
    const tasks=selected.slice(0,count).map(task=>({id:task.id,phase:text(task.phase,24),instruction:text(task.instruction,limit),nextStep:text(task.nextStep,Math.min(limit,72)),...(time(task.nextAt)?{nextAt:time(task.nextAt)}:{}),historyReference:{kind:'tasks',id:task.id}}));
    return header+JSON.stringify({current,...(tasks.length?{ownerTasks:tasks}:{}),...(active.length>tasks.length?{additionalActiveTasks:active.length-tasks.length}:{})})+historyHint+(fresh&&location?' '+activityHint:'');
  };
  let limit=96,count=selected.length,result=packet(limit,count);
  while(result.length>maxContextChars&&limit>24){limit-=8;result=packet(limit,count);}
  while(result.length>maxContextChars&&count>0){count--;result=packet(limit,count);}
  while(result.length>maxContextChars&&limit>8){limit-=4;result=packet(limit,count);}
  return result;
}
