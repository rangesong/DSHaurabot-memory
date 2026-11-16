import { bm25Scores,relevantQueryTerms } from './v5-retrieval.js';

const normalize=text=>String(text??'').normalize('NFKC').toLocaleLowerCase();
export function evidenceAnchors(text){
  const normalized=normalize(text),corrections=[...normalized.matchAll(/(?:改为|改成|改用|更正为|换成|目前是|现在是)\s*([^，。；;（）()\n]{1,48})/g)];
  const focus=corrections.at(-1)?.[1]??normalized;
  const values=[...focus.matchAll(/[零〇一二两三四五六七八九十\d]{1,4}(?:点|时)(?:半|[零〇一二两三四五六七八九十\d]{1,3}分?)?|\d+(?:\.\d+)?(?:元|万元|毫克|kg|gb|mb|%|版本)?|[a-z][a-z0-9_.:-]{2,}/g)].map(match=>match[0]);
  const quotes=[...focus.matchAll(/[“「《"]([^”」》"\n]{2,32})[”」》"]/g)].map(match=>match[1]);
  return [...new Set([...values,...quotes])].filter(value=>value.length>=2).slice(0,6);
}

/** Follow source references first; unaligned legacy reports supply search clues, never fabricated provenance. */
export function backtraceOriginals(r,ranked,{controls,memory_filter=null,query=''}={}){
  const found=new Map(),links=[],eligible=ranked.filter(item=>item.memory.kind!=='raw').slice(0,6);
  const rawAllowed=(raw,parent)=>raw&&raw.scope===parent.scope&&raw.kind==='raw'&&raw.validity==='current'&&raw.layer!=='forgotten'&&!['gist_only','clue_only','eliminated'].includes(raw.storage)&&(!memory_filter||memory_filter(raw));
  const add=(raw,parent,kind,score)=>{
    if(!rawAllowed(raw,parent.memory))return;
    const sources=raw.source_refs.map(id=>r.store.getSource(id));if(!sources.length||sources.some(source=>!source||source.scope!==parent.memory.scope||source.role!=='user'))return;
    const existing=found.get(raw.id),link={via:parent.memory.id,kind,source_refs:raw.source_refs,provenance_verified:kind==='source_reference'};
    if(!existing)found.set(raw.id,{memory:{...raw,search_text:normalize(r.body(raw))},score:parent.score+.1+score,matched_regions:parent.matched_regions,reasons:['派生资料 → 完整用户原话',kind==='source_reference'?'原有来源引用':'有界原话补查；不改写派生来源'],retrieval_state:'original_evidence_backtrace',evidence_backtrace:link});
    links.push({id:raw.id,...link});
    return true;
  };
  for(const parent of eligible){
    if(parent.memory.kind==='experience'&&parent.memory.source_refs.length>4&&parent.memory.attributes.topic&&!query.includes(parent.memory.attributes.topic))continue;
    const queue=[parent.memory],seen=new Set();let direct=0;
    while(queue.length&&seen.size<8){
      const memory=queue.shift();if(seen.has(memory.id))continue;seen.add(memory.id);
      for(const sourceId of memory.source_refs){const source=r.store.getSource(sourceId);if(source?.scope!==parent.memory.scope||source.role!=='user')continue;const raw=r.store.getMemory('raw:'+sourceId);if(add(raw,parent,'source_reference',.01))direct++;}
      for(const basis of memory.attributes?.basis_refs??[]){const ancestor=r.store.getMemory(basis.id);if(ancestor?.scope===memory.scope&&ancestor.validity==='current'&&ancestor.revision===basis.revision)queue.push(ancestor);}
    }
    if(direct||controls.followup_searches<=0)continue;
    const text=r.body(parent.memory)??'',anchors=evidenceAnchors(text);if(!anchors.length)continue;
    const terms=[...new Set([...anchors,...relevantQueryTerms(text)])].slice(0,32);
    const candidates=r.store.search(parent.memory.scope,terms,96,{rawOnly:true,phrase:anchors[0]}).filter(raw=>rawAllowed(raw,parent.memory));
    const scores=bm25Scores(text,candidates.map(raw=>({id:raw.id,text:raw.search_text})),{queryTerms:terms});
    const subject=parent.memory.attributes?.subject??parent.memory.attributes?.about??null;
    const matches=candidates.map(raw=>{
      const source=r.store.getSource(raw.source_refs[0]);if(!source||source.role!=='user'||subject&&String(source.provenance?.speaker_id??source.speaker_id)!==String(subject))return null;
      const body=normalize(source.text),exact=anchors.filter(anchor=>body.includes(anchor));if(!exact.length)return null;
      const distance=parent.memory.occurred_at!==null&&source.occurred_at!==null?Math.abs(parent.memory.occurred_at-source.occurred_at)/86400000:null;
      return {raw,score:(scores.get(raw.id)?.score??0)+exact.length*2+(distance===null?0:1/(1+distance))};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
    for(const item of matches.slice(0,2))add(item.raw,parent,'lexical_backtrace',Math.min(.01,item.score/10000));
  }
  const originals=[...found.values()].sort((a,b)=>b.score-a.score).slice(0,8);
  return {originals,links:links.filter(link=>originals.some(item=>item.memory.id===link.id))};
}
