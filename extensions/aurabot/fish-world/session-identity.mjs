// Aurabot tool factories use the bare ID; native Session.id adds one prefix.
// Keep raw IDs in receipts and sources. Only identity comparisons use this key.
export function sessionKey(value){return typeof value==='string'&&value&&!/\s/.test(value)?value.replace(/^session-/,''):'';}
export function sameSession(a,b){const key=sessionKey(a);return !!key&&key===sessionKey(b);}
export function ownerTaskContext(l,sid){
 const key=sessionKey(sid);if(!key)return;
 let selected,selectedAt=-Infinity,canonical=false;
 for(const [raw,value]of Object.entries(l?.ownerTaskContexts||{})){
  if(sessionKey(raw)!==key||!value||typeof value!=='object'||Array.isArray(value))continue;
  const at=Number.isFinite(value.at)?value.at:0,isCanonical=raw===key;
  if(!selected||at>selectedAt||at===selectedAt&&isCanonical&&!canonical){selected=value;selectedAt=at;canonical=isCanonical;}
 }
 return selected;
}
export function setOwnerTaskContext(l,sid,value){
 const key=sessionKey(sid);if(!key)return;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('主人任务上下文需要有效记录');
 l.ownerTaskContexts??={};const stored=structuredClone(value);l.ownerTaskContexts[key]=stored;return stored;
}
