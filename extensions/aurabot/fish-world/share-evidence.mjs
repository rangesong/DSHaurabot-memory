import {createHash} from 'node:crypto';

const W='mcp__fish-world__world_';
const ttl=30*60000;
const unsubmitted=new Set(['pending','deferred','failed']);
const submitted=new Set(['sent','queued','sending','uncertain']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const strings=value=>Array.isArray(value)&&value.every(id=>typeof id==='string'&&id.length>0);
const time=value=>Number.isFinite(value)&&value>0;
const historyTool=name=>[W+'history','fish_life_history','fish_dialogue_history'].includes(name);
const normal=o=>!o.noticeOnly&&!o.localOnly&&!String(o.id||'').startsWith('fault-')&&!o.facts?.some(id=>String(id).startsWith('budget-'));
const trusted=q=>q?.provenance?.trusted===true&&q.provenance.source==='world-notify'&&!['owner','idle','plan','recovery','inspection'].includes(q.kind)&&typeof q.id==='string'&&q.id.length>0&&time(q.t);
const scope=(life,fishId)=>[life.owner,life.persona,fishId].every(value=>typeof value==='string'&&value.length>0)?[life.owner,life.persona,fishId]:null;
const keyFor=(identity,ref)=>hash([1,...identity,canonical(ref)]);
const notification=q=>({kind:'notify',eventId:q.id,t:q.t});
function mutation(entry){
  let args;try{args=JSON.parse(entry.args);}catch{return null;}
  if(!args||typeof args!=='object'||Array.isArray(args))return null;
  if(!['go','do','say','update'].some(name=>entry.tool===W+name)&&!(entry.tool===W+'friends'&&typeof args.action==='string'&&args.action!=='list'))return null;
  return {kind:'mutation',callId:entry.id,tool:entry.tool,at:entry.at,argsHash:hash(canonical(args))};
}
function indexValid(index){return index==null||index.version===1&&index.claims&&typeof index.claims==='object'&&!Array.isArray(index.claims)&&Object.values(index.claims).every(value=>value&&typeof value==='object'&&typeof value.outboxId==='string');}
function initialize(life,now){
  if(!indexValid(life.sharingEvidence))return null;
  return life.sharingEvidence??={version:1,initializedAt:now,claims:{}};
}
function claim(index,keys,refs,outboxId,at){
  keys.forEach((key,i)=>{if(!Object.hasOwn(index.claims,key))index.claims[key]={outboxId,at,sourceRefs:[refs[i]]};});
}
function metadata(identity,o){
  if(o.evidenceVersion!==1||!strings(o.keys)||!Array.isArray(o.sourceRefs)||o.keys.length!==o.sourceRefs.length)return null;
  const refs=o.sourceRefs;
  if(!refs.length||!refs.every(ref=>ref&&(
    ref.kind==='notify'&&typeof ref.eventId==='string'&&time(ref.t)||
    ref.kind==='mutation'&&typeof ref.callId==='string'&&typeof ref.tool==='string'&&time(ref.at)&&/^[a-f0-9]{64}$/.test(ref.argsHash)
  )))return null;
  return refs.every((ref,i)=>keyFor(identity,ref)===o.keys[i])?{keys:o.keys,sourceRefs:refs}:null;
}

/** Only provenance is checked here. Arbitrary prose is not semantically classified. */
export function previewShareEvidence(life,{fishId,round,report,now}){
  const result={allowed:false,reason:'',keys:[],sourceRefs:[],shareFacts:[],shareEventIds:[],candidates:{eventIds:[],mutationFactIds:[]}};
  const deny=reason=>({...result,reason});
  const identity=scope(life,fishId);
  if(!identity||!indexValid(life.sharingEvidence))return deny('分享身份或证据索引无法确认，仅保留本地');
  if(!round||!report||!time(now)||typeof round.id!=='string')return deny('缺少本轮分享证据，仅保留本地');
  if(round.readOnly||round.kind==='recovery')return deny('恢复核对仅保留本地，不主动分享');
  const receipts=round.receipts||[],events=report.events||[];
  const candidates=(life.queue||[]).filter(q=>trusted(q)&&(round.events||[]).includes(q.id)&&q.lastRoundId===round.id&&events.some(e=>e.id===q.id&&e.status==='completed')&&q.t<=now&&now-q.t<ttl);
  result.candidates.eventIds=candidates.map(q=>q.id);
  const requested=report.shareFacts===undefined?report.facts||[]:report.shareFacts;
  if(!strings(requested))return deny('分享只接受精确的本轮成功回执编号，仅保留本地');
  result.shareFacts=[...new Set(requested)];
  const selected=result.shareFacts.map(id=>receipts.find(receipt=>receipt.id===id&&!receipt.isError));
  if(selected.some(receipt=>!receipt))return deny('分享依据不是本轮成功回执，仅保留本地');
  if(selected.some(receipt=>historyTool(receipt.tool)))return deny('历史查询用于本地查证，不作为新生活事件主动分享');
  const refs=[];
  for(const receipt of selected){
    const entry=(life.journal||[]).find(j=>j.id===receipt.id&&j.tool===receipt.tool&&j.round===round.id&&j.sessionId===round.sessionId&&j.status==='confirmed'&&!j.isError);
    const ref=entry&&mutation(entry);
    if(ref&&time(round.startedAt)&&time(entry.at)&&entry.at>=round.startedAt&&time(entry.finishedAt)&&entry.finishedAt>=entry.at&&entry.finishedAt<=now){refs.push(ref);result.candidates.mutationFactIds.push(receipt.id);}
  }
  let eventIds=report.shareEventIds;
  const checkedHistory=(report.facts||[]).some(id=>receipts.some(receipt=>receipt.id===id&&historyTool(receipt.tool)));
  if(eventIds===undefined)eventIds=!refs.length&&!checkedHistory&&candidates.length===1?[candidates[0].id]:[];
  if(!strings(eventIds))return deny('分享通知编号不正确，仅保留本地');
  result.shareEventIds=[...new Set(eventIds)];
  if(result.shareEventIds.some(id=>!candidates.some(q=>q.id===id)))return deny('分享通知不属于本轮新鲜可信事件，仅保留本地');
  if(result.shareEventIds.length&&!selected.some(receipt=>receipt.tool===W+'now'))return deny('通知分享缺少所选本轮现场回执，仅保留本地');
  refs.push(...result.shareEventIds.map(id=>notification(candidates.find(q=>q.id===id))));
  if(!refs.length)return deny('本轮只有查证或旧事实，没有可主动分享的新事件');
  result.sourceRefs=refs;result.keys=refs.map(ref=>keyFor(identity,ref));
  if(result.keys.some(key=>Object.hasOwn(life.sharingEvidence?.claims||{},key)&&life.sharingEvidence.claims[key].outboxId!==round.id))return deny('该生活事件已生成分享，保留原投递记录，不重复分享');
  return {...result,allowed:true};
}

/** Call inside the same bridge.change that creates this round's outbox record. */
export function claimShareEvidence(life,options){
  const preview=previewShareEvidence(life,options);
  if(preview.allowed)claim(initialize(life,options.now),preview.keys,preview.sourceRefs,options.round.id,options.now);
  return preview;
}

/** Seed exact old lineage without changing submitted records or guessing from prose. */
export function reconcileShareEvidence(life,{fishId,now}){
  const identity=scope(life,fishId),index=identity&&initialize(life,now);
  if(!index)return;
  const rows=(life.outbox||[]).filter(o=>normal(o)&&o.owner===life.owner&&o.persona===life.persona);
  // A submitted record takes precedence over an older, still-unsubmitted draft.
  const ordered=[...rows.filter(o=>submitted.has(o.state)),...rows.filter(o=>!submitted.has(o.state))];
  for(const o of ordered){
    const selected=o.shareFacts??o.facts??[];
    const historical=Array.isArray(selected)&&selected.some(id=>(life.journal||[]).some(j=>j.id===id&&historyTool(j.tool)));
    if(!submitted.has(o.state)&&historical){
      if(unsubmitted.has(o.state)){
        o.suppressedFrom={state:o.state,reason:o.reason||''};o.suppressedAt=now;o.state='suppressed';o.localOnly=true;
        o.reason='历史查询用于本地查证，不作为新生活事件主动分享';
      }
      continue; // An ineligible unsent draft cannot acquire a fresh event claim.
    }
    const existing=metadata(identity,o),refs=existing?.sourceRefs||[];
    if(!existing){
      for(const q of life.queue||[])if(trusted(q)&&q.lastRoundId===o.id&&q.status==='completed'&&q.t<=o.at)refs.push(notification(q));
      for(const id of Array.isArray(selected)?selected:[]){
        const entry=(life.journal||[]).find(j=>j.id===id&&j.round===o.id&&j.status==='confirmed'&&!j.isError);
        const ref=entry&&mutation(entry);if(ref&&time(entry.at)&&entry.at<=o.at)refs.push(ref);
      }
    }
    const keys=existing?.keys||refs.map(ref=>keyFor(identity,ref));
    claim(index,keys,refs,o.id,o.at);
    if(!unsubmitted.has(o.state))continue;
    const duplicate=keys.some(key=>index.claims[key].outboxId!==o.id);
    // Unknown legacy drafts retain their existing freshness/delivery policy.
    if(duplicate||o.evidenceVersion===1&&!existing){
      o.suppressedFrom={state:o.state,reason:o.reason||''};o.suppressedAt=now;o.state='suppressed';o.localOnly=true;
      o.reason=duplicate?'该生活事件已有原分享记录，不重复投递':'分享证据记录无法确认，仅保留本地';
    }
  }
}
