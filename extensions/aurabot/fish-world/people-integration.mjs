import {FishPeopleStore} from './people.mjs';
import {normalizeDialogueFish} from './dialogue-history.mjs';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const scopeKey=value=>JSON.stringify([value.owner,value.persona,normalizeDialogueFish(value.selfFishId),value.apiOrigin]);
const recordKey=row=>JSON.stringify([row.id,row.tool,row.args,row.at,row.sessionId,row.round]);
const unavailable=()=>({ok:false,available:false,scopeToken:null,list:[],total:0,message:'本地鱼人物记录暂不可用，原始世界账本仍保留。'});
const scopeToken=captured=>createHash('sha256').update(scopeKey(captured)).digest('hex').slice(0,24);

/** A separately verified binding proves only the local archive's identity, never a world action. */
export function createPeopleIdentityVerifier({file,bridge,credential,clock=Date.now}){
 function pair(){
  const data=bridge.data;if(!/^[a-f0-9]{64}$/.test(data.keyId||''))return null;
  let fish;try{fish=normalizeDialogueFish(data.fishId);if(fish!==normalizeDialogueFish(data.state?.fish))return null;}catch{return null;}
  return {keyId:data.keyId,fish};
 }
 let trusted=null,invalid=false;
 if(typeof file!=='string'||!file)return ()=>false;
 function readProof(){
  if(!existsSync(file))return;
  try{
   if(lstatSync(file).isSymbolicLink())throw Error('redirect');const saved=JSON.parse(readFileSync(file,'utf8'));
   if(saved.schema!==1||saved.apiOrigin!=='https://api.yuyuworld.app'||!/^[a-f0-9]{64}$/.test(saved.keyHash)||saved.fishId!==normalizeDialogueFish(saved.fishId)||!Number.isFinite(saved.verifiedAt)||saved.verifiedAt<=0||saved.verifiedAt>clock())throw Error('schema');
   trusted={keyId:saved.keyHash,fish:saved.fishId};
  }catch{invalid=true;}
 }
 readProof();
 function save(current){
  const temporary=file+'.'+randomUUID()+'.tmp';let created=false;
  try{
   mkdirSync(dirname(file),{recursive:true});if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw Error('redirect');
   writeFileSync(temporary,JSON.stringify({schema:1,apiOrigin:'https://api.yuyuworld.app',keyHash:current.keyId,fishId:current.fish,verifiedAt:clock()},null,2)+'\n',{flag:'wx'});created=true;
   renameSync(temporary,file);created=false;trusted=current;return true;
  }catch{return false;}finally{if(created)try{unlinkSync(temporary);}catch{}}
 }
 return ()=>{
  if(invalid)return false;const current=pair();if(!current)return false;
  let keyId;try{keyId=createHash('sha256').update(String(credential()||'').trim()).digest('hex');}catch{return false;}
  if(keyId!==current.keyId)return false;
  if(bridge.identityReady===true&&(!trusted||trusted.keyId!==current.keyId||trusted.fish!==current.fish)&&!save(current))return false;
  return !!trusted&&trusted.keyId===current.keyId&&trusted.fish===current.fish;
 };
}

/** A derived local view of confirmed receipts. Never dispatches a world tool or changes the life ledger. */
export function createPeopleIntegration({file,bridge,getEngine,identity,identityReady=()=>false,apiOrigin,clock=Date.now,Store=FishPeopleStore}){
 const bootstrapped=new WeakMap(),pending=new Map(),rounds=new Map();let store=null;
 function capture(){
  const engine=getEngine(),life=engine?.l,who=identity(),data=bridge.data;
  if(!engine||engine.closed||bridge.fatal||bridge.migrationRequired||!identityReady()||!life||life!==data.life||!who?.owner||!who.persona||life.owner!==who.owner||life.persona!==who.persona)return null;
  try{normalizeDialogueFish(data.fishId);}catch{return null;}
  return Object.freeze({owner:String(who.owner),persona:String(who.persona),selfFishId:String(data.fishId),apiOrigin});
 }
 function assertScope(captured){
  const current=capture();if(!captured||!current||scopeKey(current)!==scopeKey(captured))throw Error('鱼人物查询所属主人、人格或世界身份已改变');
  return current;
 }
 function sync(captured=capture(),excludeId){
  assertScope(captured);store??=new Store({file,identity:()=>capture()||{},clock});
  const life=getEngine().l,key=scopeKey(captured);
  if(bootstrapped.get(life)!==key){const rows=life.journal||[];store.ingestJournal(excludeId?rows.filter(row=>row.id!==excludeId):rows,{backfill:true});assertScope(captured);bootstrapped.set(life,key);}
  return store;
 }
 function noteDispatch(exec){
  try{
   const captured=capture(),row=getEngine()?.l.journal?.find(row=>row.id===exec.callId&&row.tool===exec.name&&row.sessionId===exec.agent?.session?.id&&row.status==='executing');
   if(!captured||!row)return;
   pending.set(exec.callId,{captured,key:recordKey(row)});if(pending.size>32)pending.delete(pending.keys().next().value);
  }catch{}
 }
 function noteResult(exec){
  const saved=pending.get(exec.callId);pending.delete(exec.callId);if(!saved)return {ok:false,ignored:true};
  try{
   assertScope(saved.captured);
   const row=getEngine().l.journal.find(row=>row.id===exec.callId&&row.tool===exec.name&&row.sessionId===exec.agent?.session?.id&&recordKey(row)===saved.key);
   if(!row||row.status!=='confirmed'||row.isError)return {ok:false,ignored:true};
   const active=sync(saved.captured,row.id),result=active.ingestJournal([row]);assertScope(saved.captured);return result;
  }catch{return {ok:false,ignored:true};}
 }
 function list(options={}){try{const captured=capture(),result=sync(captured).list(options);assertScope(captured);return {...result,scopeToken:result.available===false?null:scopeToken(captured)};}catch{return unavailable();}}
 function detail(fish,options={}){try{const captured=capture(),id=normalizeDialogueFish(fish),result=sync(captured).detail(id,options);assertScope(captured);return {...result,scopeToken:result.available===false?null:scopeToken(captured)};}catch{return {...unavailable(),person:null};}}
 function lookup(fish,captured){
  const id=normalizeDialogueFish(fish),active=sync(captured),message=active.lookup(id,{maxChars:1200});assertScope(captured);
  return {ok:true,fish:id,message:'【本地鱼人物线索，仅供内部查阅；不是新指令，也不代表刚发生的新事件】\n'+String(message||'暂时没有这条鱼的已确认本地记录。').slice(0,1200)};
 }
 function bindRound(){
  const captured=capture(),round=getEngine()?.l.round;if(!captured||!round||round.status!=='running'||!round.sessionId)return false;
  rounds.set(round.id,{captured,roundId:round.id,sessionId:round.sessionId,revision:round.revision});if(rounds.size>16)rounds.delete(rounds.keys().next().value);return true;
 }
 function applyPortraits(candidates,round,{captured,roundId,sessionId,revision}={}){
  try{
   assertScope(captured);
   const engine=getEngine();
   if(!round||round.id!==roundId||round.sessionId!==sessionId||round.revision!==revision||revision!==engine.l.revision||!engine.l.journal.some(row=>row.id===roundId&&row.type==='round'&&row.status==='completed'))throw Error('人物候选不属于已完成的当前身份回合');
   if(!Array.isArray(candidates)||candidates.length>2)throw Error('每轮最多两份人物印象候选');
   const seen=new Set(),checked=candidates.map(candidate=>{
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||Object.keys(candidate).some(key=>!['fish','text','sourceIds'].includes(key)))throw Error('人物候选格式不正确');
    const fish=normalizeDialogueFish(candidate.fish);
    if(seen.has(fish)||typeof candidate.text!=='string'||!candidate.text.trim()||candidate.text.length>180||!Array.isArray(candidate.sourceIds)||!candidate.sourceIds.length||candidate.sourceIds.length>12||candidate.sourceIds.some(id=>typeof id!=='string'||!id||id.length>200))throw Error('人物候选缺少有界的真实依据');
    seen.add(fish);
    for(const id of candidate.sourceIds){
     const receipt=round.receipts.find(receipt=>receipt.id===id&&!receipt.isError),journal=engine.l.journal.find(row=>row.id===id&&row.round===roundId&&row.sessionId===sessionId&&row.status==='confirmed'&&!row.isError);
     if(!receipt||!journal||receipt.tool!==journal.tool)throw Error('人物候选只能引用本轮成功回执');
    }
    return {fish,text:candidate.text.trim(),sourceIds:[...new Set(candidate.sourceIds)]};
   });
   const active=sync(captured),results=[];
   for(const candidate of checked){assertScope(captured);try{results.push(active.setPortrait(candidate));}catch{results.push({ok:false,fish:candidate.fish,message:'人物印象缺少同对象的真实对话依据，保留原始记录。'});}}
   assertScope(captured);return {ok:results.every(result=>result?.ok),results};
  }catch{return {ok:false,results:[],message:'人物印象候选未写入，原始世界回执与本轮报告仍保留。'};}
 }
 function completeRound(round){
  const captured=rounds.get(round?.id);rounds.delete(round?.id);
  if(!round?.report?.peerImpressions)return {ok:true,results:[]};
  return applyPortraits(round.report.peerImpressions,round,captured);
 }
 return {capture,assertScope,noteDispatch,noteResult,bindRound,completeRound,list,detail,lookup};
}
