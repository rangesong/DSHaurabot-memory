import {createHash} from 'node:crypto';

const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const LIMITATIONS=Object.freeze({rollback:'semantic-records',databaseBytesRestored:false,relationOrderRestored:false,revisionRestored:false});

export class NativeContextReviewError extends Error{
  constructor(code,rollback){super(code);this.name='NativeContextReviewError';this.code=code;if(rollback)this.rollback=rollback;}
}
const requireReview=(condition,code='context-review-invalid-plan')=>{if(!condition)throw new NativeContextReviewError(code);};
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function plainJson(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){requireReview(Number.isFinite(value));return;}
  requireReview(value&&typeof value==='object'&&(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value))));
  for(const [key,item]of Object.entries(value)){
    requireReview(!['__proto__','prototype','constructor'].includes(key));plainJson(item);
  }
}
function exactKeys(value,keys){
  requireReview(value&&typeof value==='object'&&!Array.isArray(value));
  requireReview(Object.keys(value).every(key=>keys.includes(key)));
}
function snapshot(memory,owner,persona){
  const detail=memory.personaPerson(owner,{notesLimit:1});
  requireReview(detail?.person&&String(detail.person.qq)===owner,'context-review-owner-unavailable');
  const entries=memory.insights(),styles=memory.styles(),matches=entries.filter(row=>row.key==='qq:'+owner);
  requireReview(matches.length<=1,'context-review-ambiguous-insights');
  const state={owner,persona,relations:clone(detail.relations||[]).sort((a,b)=>String(a.id).localeCompare(String(b.id))),insights:clone(matches[0]?.list||[]),styles:clone(styles['qq:'+owner]||[])};
  plainJson(state);
  requireReview(Array.isArray(state.relations)&&Array.isArray(state.insights)&&Array.isArray(state.styles),'context-review-invalid-state');
  requireReview(state.insights.length<=8&&state.insights.every(row=>row&&typeof row==='object'&&typeof row.id==='string'&&typeof row.text==='string'),'context-review-invalid-state');
  requireReview(state.styles.length<=5&&state.styles.every(text=>typeof text==='string'&&text.length>0&&text===text.trim()&&text.length<=40),'context-review-invalid-state');
  return state;
}
function checkedResult(value){
  requireReview(!value||typeof value.then!=='function','context-review-async-write-refused');
  requireReview(value!==false&&value?.ok!==false,'context-review-write-failed');
}
function validatePlan(plan,owner,persona,before){
  plainJson(plan);exactKeys(plan,['schema','owner','persona','deleteRelations','insights','styles']);
  requireReview(plan.schema===1&&plan.owner===owner&&plan.persona===persona,'context-review-scope-mismatch');
  const deletes=plan.deleteRelations??[],insights=plan.insights??[],styles=plan.styles??[];
  requireReview(Array.isArray(deletes)&&deletes.length<=1&&Array.isArray(insights)&&insights.length<=2&&Array.isArray(styles)&&styles.length<=1);
  const seenInsights=new Set(),seenStyles=new Set(),after=clone(before);
  for(const op of deletes){
    exactKeys(op,['id','from']);requireReview(typeof op.id==='string'&&op.id.length>0&&op.id.length<=128);
    const found=before.relations.filter(row=>row.id===op.id);
    requireReview(found.length===1&&same(found[0],op.from),'context-review-relation-conflict');
    const row=found[0];requireReview(String(row.subjQq||'')===owner||String(row.objQq||'')===owner||(String(row.speaker||'')===owner&&row.chatId==='private:'+owner),'context-review-relation-outside-owner');
    after.relations=after.relations.filter(row=>row.id!==op.id);
  }
  for(const op of insights){
    exactKeys(op,['id','from','to']);requireReview(typeof op.id==='string'&&!seenInsights.has(op.id)&&typeof op.from==='string'&&typeof op.to==='string'&&op.to.length>0&&op.to===op.to.trim()&&op.to.length<=240);seenInsights.add(op.id);
    const found=before.insights.filter(row=>row.id===op.id);
    requireReview(found.length===1&&found[0].text===op.from,'context-review-insight-conflict');
    after.insights=after.insights.map(row=>row.id===op.id?{...row,text:op.to}:row);
  }
  for(const op of styles){
    exactKeys(op,['index','from','to']);requireReview(Number.isSafeInteger(op.index)&&op.index>=0&&op.index<before.styles.length&&!seenStyles.has(op.index)&&typeof op.from==='string'&&typeof op.to==='string'&&op.to.length>0&&op.to===op.to.trim()&&op.to.length<=40);seenStyles.add(op.index);
    requireReview(before.styles[op.index]===op.from,'context-review-style-conflict');after.styles[op.index]=op.to;
  }
  return {after,deletes,insightsChanged:!same(before.insights,after.insights),stylesChanged:!same(before.styles,after.styles)};
}

/** Owner-scoped synchronous CAS using the native store's public record APIs. No filesystem or model calls. */
export function reviewNativeContext(memory,plan,{owner,persona,apply=false,expectedHash=null}={}){
  requireReview(typeof apply==='boolean','context-review-invalid-request');
  requireReview(typeof owner==='string'&&/^\d{1,20}$/.test(owner)&&typeof persona==='string'&&persona.length>0&&persona.length<=128,'context-review-invalid-scope');
  const before=snapshot(memory,owner,persona),snapshotHash=hash(before),checked=validatePlan(plan,owner,persona,before),after=checked.after;
  const result={schema:1,applied:false,owner,persona,snapshotHash,resultHash:hash(after),before,after,limitations:{...LIMITATIONS}};
  if(!apply)return result;
  requireReview(typeof expectedHash==='string'&&expectedHash===snapshotHash,'context-review-stale-snapshot');
  const key='qq:'+owner,undo=[];
  try{
    if(checked.insightsChanged){undo.push({section:'insights',restore:()=>memory.setInsights(key,clone(before.insights))});checkedResult(memory.setInsights(key,clone(after.insights)));}
    if(checked.stylesChanged){undo.push({section:'styles',restore:()=>memory.setStyle(key,clone(before.styles))});checkedResult(memory.setStyle(key,clone(after.styles)));}
    // Relation deletion is last; its public restore API preserves records, not original array order or rev.
    for(const op of checked.deletes){
      const original=clone(op.from);delete original.text;
      undo.push({section:'relation',restore:()=>memory.saveRelation(original)});checkedResult(memory.deleteRelation(op.id));
    }
    requireReview(same(snapshot(memory,owner,persona),after),'context-review-readback-mismatch');
    return {...result,applied:true};
  }catch{
    const failures=[];
    for(const entry of undo.reverse())try{checkedResult(entry.restore());}catch{failures.push({section:entry.section,code:'restore-failed'});}
    let restored=false;try{restored=same(snapshot(memory,owner,persona),before);}catch{}
    throw new NativeContextReviewError('context-review-apply-failed',{semantic_records_restored:restored,failures,limitations:{...LIMITATIONS}});
  }
}
