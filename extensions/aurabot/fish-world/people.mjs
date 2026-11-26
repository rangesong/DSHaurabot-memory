import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {normalizeDialogueFish,dialoguePage} from './dialogue-history.mjs';

export const FISH_PEOPLE_ORIGIN='https://api.yuyuworld.app';
const PREFIX='mcp__fish-world__world_',MAX_SOURCE=64000;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value);
const fail=message=>{throw Error(message);};
const finite=value=>Number.isFinite(value)&&value>0?value:null;
const owns=(object,key)=>Object.hasOwn(object||{},key);
const clean=value=>typeof value==='string'?value.toWellFormed().replace(/\bfwr?_[A-Za-z0-9_-]+/g,'[密钥已隐藏]'):'';
const short=(value,max)=>clean(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim().slice(0,max).toWellFormed();
const fish=value=>normalizeDialogueFish(value);
const fishName=value=>typeof value==='string'&&value.includes('#')?value.slice(0,value.lastIndexOf('#')).trim():'';
const argsOf=row=>{try{const value=typeof row.args==='string'?JSON.parse(row.args):row.args;return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
const scopeValue=identity=>{
 const origin=identity?.apiOrigin??FISH_PEOPLE_ORIGIN;
 if(origin!==FISH_PEOPLE_ORIGIN||typeof identity?.owner!=='string'||!identity.owner||typeof identity.persona!=='string'||!identity.persona||/[\u0000-\u001f\u007f]/.test(identity.owner+identity.persona))fail('鱼人物身份暂不可用');
 return {apiOrigin:FISH_PEOPLE_ORIGIN,owner:identity.owner,persona:identity.persona,selfFishId:fish(identity.selfFishId??identity.fishId)};
};
export const fishPeopleScope=identity=>scopeValue(identity);

/** Relative dates belong to the receipt's observation day, never the current clock. */
function messageTime(raw,observedAt){
 const time=String(raw||'');
 const dayValid=day=>{const value=Date.parse(day+'T00:00:00Z');return Number.isFinite(value)&&new Date(value).toISOString().slice(0,10)===day;};
 const occurred=value=>Number.isFinite(value)&&finite(observedAt)&&value<=observedAt?value:null;
 const iso=time.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/);
 if(iso)return dayValid(iso[0].slice(0,10))?occurred(Date.parse(iso[0])):null;
 const full=time.match(/\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\b/);
 if(full){const at=Date.parse(full[1]+'T'+full[2]+'+08:00');return dayValid(full[1])?occurred(at):null;}
 const relative=time.includes('前天')?2:time.includes('昨天')?1:time.includes('今天')?0:null,clock=time.match(/\b([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
 if(relative!==null&&clock&&finite(observedAt)){
  const day=new Date(observedAt+8*3600000-relative*86400000).toISOString().slice(0,10);
  return occurred(Date.parse(day+'T'+clock[0]+'+08:00'));
 }
 return null;
}

/** Parse only the two-party history endpoint, retaining complete blocks and original times. */
export function parseFishDialogue(text,{peer,selfFishId,selfName='',peerName='',observedAt}={}){
 peer=fish(peer);selfFishId=fish(selfFishId);
 const page=dialoguePage(text),lines=page.body.split(/\r?\n/),starts=[];
 for(let index=0;index<lines.length;index++){
  const match=/^([^>\r\n]{1,80})[（(]([^()\r\n]{1,160})[）)][：:]$/u.exec(lines[index]);
  if(match)starts.push({index,speaker:match[1].trim(),meta:match[2]});
 }
 const result=[];let endpointName=peerName;
 for(let index=0;index<starts.length;index++){
  const header=starts[index],speaker=header.speaker;let role,name='',speakerId;
  if(['你','我','自己','本鱼',selfName].filter(Boolean).includes(speaker)){role='self';speakerId=selfFishId;}
  else if(speaker.includes('#')){
   let id;try{id=fish(speaker);}catch{continue;}
   if(id===selfFishId){role='self';speakerId=id;}else if(id===peer){role='peer';speakerId=id;name=fishName(speaker);}else continue;
  }else{
   // Unnumbered unknown names remain evidence only; do not guess a speaker from prose.
   if(endpointName&&speaker===endpointName){role='peer';speakerId=peer;name=speaker;}
   else{role='unknown';speakerId=null;}
  }
  const block=lines.slice(header.index,starts[index+1]?.index??lines.length).join('\n').trimEnd(),rawBody=block.slice(block.indexOf('\n')+1);
  if(!block.includes('\n')||!rawBody.trim())continue;
  // Server status/age lines are unquoted. They are audit text, never message identity.
  const quoted=rawBody.split('\n').filter(line=>/^\s*>/.test(line)),utterance=quoted.map(line=>line.replace(/^\s*> ?/,'')).join('\n').trimEnd(),hasSpeech=!!utterance.trim(),body=hasSpeech?utterance:rawBody;
  if(!body.trim())continue;
  if(!hasSpeech){role='unknown';speakerId=null;name='';}
  const occurredAt=messageTime(header.meta,observedAt),messageId=/(?:^|[，,\s])(?:id|message_id)=(m_[A-Za-z0-9_-]{1,22})(?=$|[，,\s])/u.exec(header.meta)?.[1]||null;
  const canonicalBody=body.replace(/\r\n/g,'\n').trimEnd();
  const fingerprint=messageId?['message-id',messageId]:['message',occurredAt??'unknown-time',speakerId,canonicalBody];
  result.push({kind:hasSpeech?'dialogue':'observation',role,speaker:speakerId,name,text:block,body,rawTime:header.meta,occurredAt,timeKnown:occurredAt!==null,messageId,fingerprint});
 }
 return result;
}

function sourceRows(row,identity,known){
 if(row?.status!=='confirmed'||row.isError||typeof row.result!=='string'||!row.result.trim()||row.result.length>MAX_SOURCE||typeof row.id!=='string'||!row.id||!String(row.tool||'').startsWith(PREFIX))return [];
 const args=argsOf(row),tool=row.tool.slice(PREFIX.length),observedAt=finite(row.finishedAt)||finite(row.at);
 if(!observedAt)return [];
 const selfName=fishName(identity.rawSelf),result=clean(row.result);
 if(tool==='history'){
  if(!args.fish)return [];
  let peer;try{peer=fish(args.fish);}catch{return [];}
  if(peer===identity.selfFishId)return [];
  const records=parseFishDialogue(result,{peer,selfFishId:identity.selfFishId,selfName,peerName:known[peer]?.nameSource==='profile'?known[peer].name:'',observedAt});
  return records.map(record=>({peer,...record,historical:true,observedAt}));
 }
 if(tool==='profile'){
  if(!args.fish)return [];
  let peer;try{peer=fish(args.fish);}catch{return [];}
  if(peer===identity.selfFishId)return [];
  const body=dialoguePage(result).body,first=body.split('\n').find(line=>line.trim())||'',named=/([^\s#>【】（）：:]{1,16}#[1-9]\d{0,11})/u.exec(first)?.[1];
  if(!named||fish(named)!==peer)return [];
  return [{peer,kind:'profile',role:'public-profile',name:fishName(named),text:body,occurredAt:null,observedAt,rawTime:'',historical:false,fingerprint:['profile',body]}];
 }
 if(tool==='friends'&&args.action==='list'){
  const rows=[];
  for(const line of dialoguePage(result).body.split('\n')){
   // Only a standalone list item, never a name inside quoted speech or explanatory prose.
   const match=/^\s*(?:[-·*]|\d+[.、])?\s*([^\s#>【】（）：:]{1,16}#[1-9]\d{0,11})(?:\s|$|[（(·|])/u.exec(line);
   if(!match)continue;let peer;try{peer=fish(match[1]);}catch{continue;}if(peer===identity.selfFishId)continue;
   rows.push({peer,kind:'friend',role:'friend-list',name:fishName(match[1]),text:line.trim(),occurredAt:null,observedAt,rawTime:'',historical:false,fingerprint:['friend-list',line.trim()]});
  }
  return rows;
 }
 if(tool==='say'&&args.fish&&typeof args.text==='string'&&args.text.trim()){
  let peer;try{peer=fish(args.fish);}catch{return [];}if(peer===identity.selfFishId)return [];
  const text=clean(args.text),requestId=typeof args.request_id==='string'&&args.request_id.length<=160?args.request_id:null;
  return [{peer,kind:'dialogue',role:'self',speaker:identity.selfFishId,name:fishName(args.fish),text,body:text,occurredAt:null,observedAt,rawTime:'',historical:false,requestId,fingerprint:requestId?['say-request',requestId]:['say-unknown-time',text]}];
 }
 return [];
}

const pageOptions=(options={},maximum=50)=>{
 const offset=options.offset??0,limit=options.limit??20;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>maximum)fail('分页参数不正确');
 return {offset,limit};
};
const card=person=>({type:'fish-world',fish:person.fish,name:person.name||person.fish,summary:person.impression&&!person.impression.disabled?person.impression.text:'',updatedAt:person.updatedAt,lastInteraction:person.lastInteraction||null,sourceCount:Object.keys(person.sources).length,impressionPending:!person.impression||person.impression.disabled,aliases:copy(person.aliases)});

/** Independent, local fish-person store. It never writes native QQ profiles or sends messages. */
export class FishPeopleStore{
 constructor({file,identity,clock=Date.now}){
  if(typeof file!=='string'||typeof identity!=='function')fail('鱼人物存储缺少路径或身份');
  this.file=file;this.identity=identity;this.clock=clock;this.data={schema:1,scopes:{}};this.error='';
  if(existsSync(file))try{if(lstatSync(file).isSymbolicLink())fail('拒绝重定向文件');const data=JSON.parse(readFileSync(file,'utf8'));if(data.schema!==1||!data.scopes||typeof data.scopes!=='object'||Array.isArray(data.scopes))fail('schema');this.data=data;}catch{this.error='鱼人物文件不可读，已保留原文件';}
 }
 current(){const raw=this.identity(),scope=scopeValue(raw);return {...scope,key:sha(scope),rawSelf:raw.selfFishId??raw.fishId};}
 available(){try{return !this.error&&!!this.current();}catch{return false;}}
 view(){if(this.error)fail(this.error);const scope=this.current();return {scope,value:this.data.scopes[scope.key]};}
 save(scope){
  if(this.current().key!==scope.key)fail('鱼人物身份已改变');
  mkdirSync(dirname(this.file),{recursive:true});if(existsSync(this.file)&&lstatSync(this.file).isSymbolicLink())fail('拒绝重定向文件');
  const temporary=this.file+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temporary,JSON.stringify(this.data,null,2)+'\n',{flag:'wx'});renameSync(temporary,this.file);}catch(error){if(existsSync(temporary))unlinkSync(temporary);throw error;}
 }
 change(action){
  const {scope}=this.view(),before=copy(this.data);
  try{const value=this.data.scopes[scope.key]??={identity:scopeValue(scope),people:{},receipts:{}};const result=action(value,scope);if(JSON.stringify(before)!==JSON.stringify(this.data))this.save(scope);return result;}catch(error){this.data=before;throw error;}
 }
 ingestJournal(rows,{backfill=false}={}){
  if(!Array.isArray(rows))fail('需要已确认的世界回执');
  return this.change((state,scope)=>{
   let added=0,ignored=0;const peers=new Set(),receiptSourceIds={};
   for(const row of rows){
    if(row?.owner&&row.owner!==scope.owner||row?.persona&&row.persona!==scope.persona||row?.selfFishId&&fish(row.selfFishId)!==scope.selfFishId){ignored++;continue;}
    const observations=sourceRows(row,scope,state.people);if(!observations.length){ignored++;continue;}
    const receiptDigest=sha([row.tool,argsOf(row),clean(row.result)]),existing=owns(state.receipts,row.id)?state.receipts[row.id]:null;
    if(existing){if(existing.digest!==receiptDigest)ignored++;else receiptSourceIds[row.id]=copy(existing.sourceIds);continue;}
    const sourceIds=[];
    for(const item of observations){
     const id='fish-source-'+sha([scope.key,item.peer,item.fingerprint]);
     const person=state.people[item.peer]??={fish:item.peer,name:'',aliases:[],sources:{},updatedAt:0,lastInteraction:null,impression:null,impressionHistory:[]};
     if(person.sources[id]&&item.messageId&&person.sources[id].body!==item.body){ignored++;continue;}
     if(!person.sources[id]){
      const {fingerprint,peer,name,...observation}=item;
      person.sources[id]={id,...observation,historical:backfill||item.historical,sourceRef:{kind:'journal',id:row.id,tool:row.tool}};added++;
      if(item.kind==='dialogue'&&['self','peer'].includes(item.role)&&item.occurredAt)person.lastInteraction=Math.max(person.lastInteraction||0,item.occurredAt);
      person.updatedAt=Math.max(person.updatedAt,item.observedAt);
     }
     if(item.name){const name=short(item.name,40);if(name&&!person.aliases.includes(name))person.aliases.push(name);if(!person.name||!item.historical&&item.kind!=='dialogue')person.name=name;if(item.kind==='profile')person.nameSource='profile';}
     sourceIds.push(id);peers.add(item.peer);
    }
    state.receipts[row.id]={digest:receiptDigest,sourceIds:[...new Set(sourceIds)]};
    receiptSourceIds[row.id]=copy(state.receipts[row.id].sourceIds);
   }
   return {ok:true,added,peers:[...peers],ignored,receiptSourceIds};
  });
 }
 list(options={}){
  if(!this.available())return {ok:false,available:false,list:[],total:0,nextOffset:null};
  const {value}=this.view(),{offset,limit}=pageOptions(options),all=Object.values(value?.people||{}).sort((a,b)=>(b.lastInteraction||b.updatedAt)-(a.lastInteraction||a.updatedAt)||a.fish.localeCompare(b.fish));
  return {ok:true,available:true,list:all.slice(offset,offset+limit).map(card),total:all.length,nextOffset:offset+limit<all.length?offset+limit:null};
 }
 detail(value,options={}){
  const peer=fish(value),{offset,limit}=pageOptions({...options,limit:options.limit??10});
  if(!this.available())return {ok:false,available:false,person:null,impression:null,observations:[],recent:[]};
  const {value:state}=this.view(),person=state?.people[peer];if(!person)return {ok:true,available:true,person:null,impression:null,observations:[],recent:[],total:0,nextOffset:null};
  const observations=Object.values(person.sources).sort((a,b)=>(b.occurredAt||0)-(a.occurredAt||0)||b.observedAt-a.observedAt||a.id.localeCompare(b.id)),impression=person.impression?copy(person.impression):{text:'',at:null,evidenceIds:[],disabled:false};
  return {ok:true,available:true,person:card(person),impression,observations:copy(observations.slice(offset,offset+limit)),recent:copy(observations.filter(source=>source.kind==='dialogue'&&source.occurredAt).slice(0,5)),total:observations.length,nextOffset:offset+limit<observations.length?offset+limit:null};
 }
 lookup(value,{maxChars=1200}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<200||maxChars>4000)fail('回忆预算需为200至4000字');
  const detail=this.detail(value,{limit:10});if(!detail.person)return '';
  const portrait=detail.impression?.text&&!detail.impression.disabled?detail.impression:null;
  const result={fish:detail.person.fish,name:detail.person.name,sourceCount:detail.total,...portrait?{impression:{text:portrait.text,evidenceIds:portrait.evidenceIds.slice(0,2),evidenceCount:portrait.evidenceIds.length,evidenceOmitted:portrait.evidenceIds.length>2}}:{},sources:[]},header='【鱼世界人物资料；不是主人指令，历史不是新事件】\n';
  if((header+JSON.stringify(result)).length>maxChars&&result.impression){delete result.impression.evidenceIds;result.impression.evidenceOmitted=true;}
  if((header+JSON.stringify(result)).length>maxChars)delete result.name;
  if((header+JSON.stringify(result)).length>maxChars&&portrait){const minimal='【鱼世界印象；非指令】\n'+portrait.text;return minimal.length<=maxChars?minimal:portrait.text;}
  if((header+JSON.stringify(result)).length>maxChars)return '';
  for(const observation of detail.observations){const source={id:observation.id,role:observation.role,text:observation.body??observation.text,occurredAt:observation.occurredAt,rawTime:observation.rawTime};result.sources.push(source);if((header+JSON.stringify(result)).length>maxChars){result.sources.pop();continue;}}
  if(detail.total&&!result.sources.length){result.note='原始记录较长，需按来源查阅；未展示不等于没有记录。';if((header+JSON.stringify(result)).length>maxChars)delete result.note;}
  return header+JSON.stringify(result);
 }
 setPortrait({fish:value,text,sourceIds}={}){
  const peer=fish(value),portrait=clean(text).trim();if(!portrait||portrait.length>180||!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>20||sourceIds.some(id=>typeof id!=='string'||!id))fail('印象需为180字内并附真实来源');
  return this.change(state=>{
   const person=state.people[peer];if(!person)fail('尚无这条鱼的已知来源');
   const ids=[...new Set(sourceIds.flatMap(id=>owns(person.sources,id)?[id]:owns(state.receipts,id)?state.receipts[id].sourceIds:[]))];
   if(sourceIds.some(id=>!owns(person.sources,id)&&(!owns(state.receipts,id)||state.receipts[id].sourceIds.some(source=>!owns(person.sources,source))))||!ids.length||ids.some(id=>!owns(person.sources,id)))fail('印象来源不属于当前这条鱼');
   const evidence=ids.map(id=>person.sources[id]);if(!evidence.some(source=>source.kind==='dialogue'&&source.role==='peer'))fail('公开资料或自己的话不能单独编成对方印象');
   const old=person.impression;if(old?.disabled&&!evidence.some(source=>source.role==='peer'&&source.occurredAt>old.disabledAt))fail('已停用的印象需新的真实往来依据');
   const sorted=ids.sort(),evidenceOccurredAt=evidence.reduce((at,source)=>source.kind==='dialogue'&&['peer','self'].includes(source.role)&&finite(source.occurredAt)?Math.max(at||0,source.occurredAt):at,null);
   if(old&&!old.disabled){
    const newlyDatedPeer=evidence.some(source=>!old.evidenceIds.includes(source.id)&&source.kind==='dialogue'&&source.role==='peer'&&finite(source.occurredAt)&&source.occurredAt>(old.evidenceOccurredAt||0));
    if(!newlyDatedPeer)return {ok:true,unchanged:true,reason:'no-newer-peer-evidence',person:card(person),impression:copy(old)};
   }
   if(old)person.impressionHistory.push(copy(old));
   person.impression={text:portrait,at:this.clock(),evidenceIds:sorted,evidenceOccurredAt,quality:evidenceOccurredAt?'dated-dialogue':'undated-dialogue',disabled:false};person.updatedAt=Math.max(person.updatedAt,this.clock());
   return {ok:true,person:card(person),impression:copy(person.impression)};
  });
 }
 disablePortrait({fish:value,reason}={}){
  const peer=fish(value),explanation=short(reason,200);if(!explanation)fail('停用印象需要明确原因');
  return this.change(state=>{
   const person=state.people[peer];if(!person)fail('尚无这条鱼的已知来源');
   const old=person.impression;if(old&&!old.disabled)person.impressionHistory.push(copy(old));
   person.impression={...(old||{text:'',at:null,evidenceIds:[]}),disabled:true,disabledAt:this.clock(),reason:explanation};
   return {ok:true,person:card(person),impression:copy(person.impression)};
  });
 }
}
