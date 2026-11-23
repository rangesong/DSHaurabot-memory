import { relevantQueryTerms } from '../../../../core/v5-retrieval.js';

const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
const generic=/鱼的世界|鱼世界|世界生活|分享偏好|执行请求|当前任务|生活|朋友|主人|约定|偏好|背景|资料|记忆|通用|本轮|收到|继续|安排|世界|分享|[、，。；：\s和与的]/gu;
const weak=new Set(['今天','明天','今晚','现在','当前','任务','一下','以后','不要','不准','不许','不用','记得','帮我','给我','希望','事情','相关']);
const worldMarker=/鱼的世界|鱼世界|fish-world|\bworld_[a-z_]+\b/u;
const arrangement=/今天|明天|今晚|现在|等会|以后|周末|别|不要|不准|不许|不用|记得|帮我|给我|先|去|回家|回来|我在|开启|关闭|停止|启动|启用|只要|只需/u;
const activities=[['打工','上班'],['休息','睡觉','睡一觉'],['回家','回来'],['钓鱼'],['挖矿'],['种菜'],['逛街','购物','买东西'],['图书馆'],['散步'],['吃饭']];

/** Automatic world background has a narrower purpose than an explicit memory query. */
export function worldLifePurpose(query,{getSource,getMemory}){
  const q=normalize(query),specific=q.replace(generic,'');
  const terms=relevantQueryTerms(specific).filter(term=>!weak.has(term)&&term.length>1);
  const groups=activities.filter(words=>words.some(word=>q.includes(word)));
  const sharing=/分享/u.test(q)&&/qq|私聊|开|关|停|启|不要|不准|只要|只需/u.test(q);
  const active=terms.length>0||groups.length>0||sharing;
  const sources=new Map(),memories=new Map(),visiting=new Set();
  let inspected=0;
  const denied={clean:false,relevant:false};
  function applicable(source){
    const text=normalize(source.text),kind=source.provenance?.kind;
    const hits=terms.filter(term=>text.includes(term));
    const activity=groups.some(words=>words.some(word=>text.includes(word)));
    const share=sharing&&/分享/u.test(text)&&/qq|私聊|开|关|停|启|不要|不准|只要|只需|消息/u.test(text);
    const world=worldMarker.test(text);
    const strong=share||activity||world&&hits.length>0||hits.length>=2&&hits.length/Math.max(1,terms.length)>=.5||specific.length>=3&&text.includes(specific);
    if(!strong)return false;
    // A generated label cannot turn an unrelated source into a world arrangement.
    if(world)return source.role==='user'||['host_journal','builtin_self_event','builtin_memory_api'].includes(kind);
    return source.role==='user'&&arrangement.test(text);
  }
  function combine(rows){return {clean:rows.every(row=>row.clean),relevant:rows.some(row=>row.relevant)};}
  function reference(id){
    if(sources.has(id))return sources.get(id);
    if(memories.has(id))return memories.get(id);
    if(inspected>=4096||visiting.size>=64)return denied;
    const source=getSource(id);if(source)return sourceState(source);
    const memory=getMemory(id);return memory?memoryState(memory):denied;
  }
  function sourceState(source){
    if(!active||!source)return denied;
    if(sources.has(source.id))return sources.get(source.id);
    const key='source:'+source.id;
    if(visiting.has(key)||visiting.size>=64||++inspected>4096)return denied;
    visiting.add(key);
    let state=denied;
    if(source.provenance?.kind!=='self_learning_result'){
      const dependencies=(source.provenance?.source_refs??[]).map(reference);
      state={clean:dependencies.every(row=>row.clean),relevant:applicable(source)};
    }
    visiting.delete(key);sources.set(source.id,state);return state;
  }
  function memoryState(memory){
    if(!active||!memory)return denied;
    if(memories.has(memory.id))return memories.get(memory.id);
    const key='memory:'+memory.id;
    if(visiting.has(key)||visiting.size>=64||++inspected>4096)return denied;
    visiting.add(key);
    const refs=[...(memory.source_refs??[]),...(memory.attributes?.counterexamples??[])];
    const evidence=refs.length?combine(refs.map(reference)):denied;
    const bases=(memory.attributes?.basis_refs??[]).map(ref=>reference(typeof ref==='string'?ref:ref.id));
    const state={clean:evidence.clean&&bases.every(row=>row.clean),relevant:evidence.relevant};
    visiting.delete(key);memories.set(memory.id,state);return state;
  }
  return {active,source:source=>{const state=sourceState(source);return state.clean&&state.relevant;},memory:memory=>{const state=memoryState(memory);return state.clean&&state.relevant;}};
}
