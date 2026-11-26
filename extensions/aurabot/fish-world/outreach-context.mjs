import {clean} from './state.mjs';
import {normalizeDialogueFish} from './dialogue-history.mjs';
import {mutating} from './life.mjs';

const freshnessMs=180000,recentMs=86400000,maxChars=2000;
const notifiedKinds=new Set(['talk','message','note','friend_request','arrive','done','work','doorbell','health']);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const text=(value,limit)=>{
  if(typeof value!=='string')return '';
  const result=clean(value.slice(0,2048)).toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').replace(/\s+/gu,' ').trim();
  return result.length>limit?result.slice(0,Math.max(0,limit-1)).toWellFormed()+'…':result;
};
function argsOf(row){try{const args=typeof row.args==='string'?JSON.parse(row.args):row.args;return args&&typeof args==='object'&&!Array.isArray(args)?args:{};}catch{return {};}}
function mutation(row){
  const args=argsOf(row);
  return mutating(row.tool,args)&&(row.tool!=='mcp__fish-world__world_friends'||typeof args.action==='string'&&args.action!=='list');
}
function activity(value){
  if(value===null)return null;
  if(typeof value==='string')return text(value,64)||undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const name=text(value.name,64);if(!name)return text(value.text,64)||undefined;
  const result={name};
  for(const key of ['since','until']){const valueText=text(value[key],40);if(valueText)result[key]=valueText;}
  if(Array.isArray(value.with))result.with=value.with.filter(item=>typeof item==='string').slice(0,2).map(item=>text(item,24)).filter(Boolean);
  return result;
}
const unavailable=(now,reason)=>({schema:1,available:false,reason,scope:null,sampledAt:now,sharingEnabled:false,correctionOnly:true,recentIsComplete:false,current:{fresh:false,observedAt:null,reason:'unavailable'},recent:[]});

/** Bounded local evidence for correcting outreach, never a new-event feed or action permission. */
export function outreachWorldSnapshot(data={},life={},options={}){
  const {owner,persona,recipient,enabled=false,identityReady=false,sharingEnabled=false,body=true,location=true}=options;
  const now=stamp(options.now??Date.now());
  if(!now)return unavailable(null,'invalid-time');
  if(!enabled||!identityReady)return unavailable(now,'unavailable');
  if(!identifier(owner)||!identifier(persona)||recipient!==owner||life.owner!==owner||life.persona!==persona||data.life!==life)return unavailable(now,'scope-mismatch');
  let fish;
  try{fish=normalizeDialogueFish(data.fishId);if(fish!==normalizeDialogueFish(data.state?.fish))return unavailable(now,'scope-mismatch');}catch{return unavailable(now,'scope-mismatch');}
  const scope={owner,persona,fish},observedAt=stamp(data.at?.state);
  const current={fresh:false,observedAt,reason:!observedAt?'missing':observedAt>now?'future':now-observedAt>freshnessMs?'stale':''};
  const recent=[];
  const add=item=>{
    if(!identifier(item.id)||!item.text||!stamp(item.occurredAt)||item.occurredAt>now||now-item.occurredAt>recentMs||!stamp(item.observedAt)||item.observedAt<item.occurredAt||item.observedAt>now)return;
    if(recent.some(row=>row.source===item.source&&row.id===item.id))return;
    recent.push(item);recent.sort((a,b)=>b.occurredAt-a.occurredAt||b.observedAt-a.observedAt);if(recent.length>8)recent.pop();
  };
  const rowOwned=row=>(row.owner===undefined||row.owner===owner)&&(row.persona===undefined||row.persona===persona);
  for(const row of Array.isArray(life.journal)?life.journal:[]){
    if(!row||!rowOwned(row)||typeof row.tool!=='string'||!mutation(row))continue;
    if(['executing','uncertain','confirmed'].includes(row.status)&&!(row.status==='confirmed'&&row.isError)&&(!stamp(row.at)||Math.max(row.at,stamp(row.finishedAt)||row.at)>observedAt)){
      if(!current.reason)current.reason='changed-after-observation';
    }
    if(row.status!=='confirmed'||row.isError||!stamp(row.finishedAt)||row.finishedAt<row.at)continue;
    add({id:row.id,source:'world-receipt',kind:row.tool.slice('mcp__fish-world__world_'.length),occurredAt:row.at,observedAt:row.finishedAt,text:text(row.result,160)});
  }
  for(const event of Array.isArray(life.queue)?life.queue:[]){
    if(!event||!rowOwned(event)||!notifiedKinds.has(event.kind)||event.provenance?.trusted!==true||event.provenance.source!=='world-notify')continue;
    add({id:event.id,source:'world-notify',kind:text(event.kind,24),occurredAt:event.t,observedAt:event.receivedAt,...(typeof event.sender==='string'?{sender:text(event.sender,40)}:{}),text:text(event.text,160)});
  }
  if(!current.reason){
    current.fresh=true;delete current.reason;
    const state=data.state;
    if(typeof state.time==='string')current.time=text(state.time,40);
    if(location){const where=text(state.where?.text,80);if(where)current.where=where;const doing=activity(state.doing);if(doing!==undefined)current.doing=doing;}
    if(body){const condition=text(state.body?.text,80);if(condition)current.body=condition;const name=text(state.outfit?.name,40),look=text(state.outfit?.look,80);if(name||look)current.outfit={name,look};}
  }
  const packet={schema:1,available:true,scope,sampledAt:now,sharingEnabled:sharingEnabled===true,correctionOnly:true,recentIsComplete:false,current,recent};
  // Unstructured receipt/notification text can contain either location or body details.
  // Do not let this new background consumer bypass an existing automatic-injection switch.
  if(!body||!location)recent.length=0;
  // Bound the actual serialized packet, including escaping and identity fields. Never trim identity or evidence times.
  while(JSON.stringify(packet).length>maxChars&&recent.length)recent.pop();
  if(JSON.stringify(packet).length>maxChars)packet.current={fresh:false,observedAt,reason:'size-limit'};
  return packet;
}
