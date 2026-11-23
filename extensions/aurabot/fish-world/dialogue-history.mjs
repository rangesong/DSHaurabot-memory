import {randomUUID} from 'node:crypto';

const HISTORY='mcp__fish-world__world_history';
const MAX_PAGES=3,MAX_CHARS=12000;
const cursorPattern=/^m_[A-Za-z0-9_-]{1,22}$/u;
const textOf=result=>(result?.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const normalized=text=>String(text).normalize('NFKC').toLocaleLowerCase();
const fail=(code,message)=>Object.assign(new Error(message),{code});

export function normalizeDialogueFish(value){
 if(typeof value!=='string'||value.length>18||! /^(?:[^#\s\x00-\x1f\x7f]+)?#[1-9][0-9]{0,11}$/u.test(value))throw fail('invalid-fish','请使用明确的鱼编号，例如 #1234。');
 return '#'+value.slice(value.lastIndexOf('#')+1);
}
export function canReadDialogue(agent,tools,toolSet){
 try{return typeof tools?.execute==='function'&&typeof tools.selectExecutor==='function'&&typeof tools.definitions==='function'
  &&new Set((tools.selectExecutor(agent).describe(tools.definitions(agent,toolSet))?.schemas||[]).map(schema=>schema.name)).has(HISTORY);}
 catch{return false;}
}
function checkedInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['fish','query','date','before','maxPages'].includes(key)))throw fail('invalid-input','只接受对话对象和本地查找条件。');
 const fish=normalizeDialogueFish(input.fish),maxPages=input.maxPages??MAX_PAGES;
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>MAX_PAGES)throw fail('invalid-pages','最多读取三页对话。');
 if(input.before!==undefined&&(typeof input.before!=='string'||!cursorPattern.test(input.before)))throw fail('invalid-cursor','旧页游标格式不正确。');
 if(input.query!==undefined&&(typeof input.query!=='string'||!input.query.trim()||input.query.length>120))throw fail('invalid-query','查找关键词过长或为空。');
 if(input.date!==undefined){
  if(typeof input.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)||!Number.isFinite(Date.parse(input.date+'T00:00:00Z'))||new Date(input.date+'T00:00:00Z').toISOString().slice(0,10)!==input.date)throw fail('invalid-date','日期需为有效的年-月-日。');
 }
 return {fish,maxPages,before:input.before,query:input.query?.trim(),date:input.date};
}

/** Read only terminal server pagination, never a cursor embedded in a quoted conversation. */
export function dialoguePage(text){
 const lines=String(text).split(/\r?\n/);while(lines.length&&!lines.at(-1).trim())lines.pop();
 if(/^——\s*现在\s+[^\r\n]{1,2000}$/u.test(lines.at(-1)||''))lines.pop();
 while(lines.length&&!lines.at(-1).trim())lines.pop();
 const footer=/^—— 更早的：before=(m_[A-Za-z0-9_-]{1,22})$/u.exec(lines.at(-1)||'');
 if(footer)lines.pop();
 while(lines.length&&!lines.at(-1).trim())lines.pop();
 const body=lines.join('\n'),starts=[];
 lines.forEach((line,index)=>{if(/^[^>\r\n]+[（(][^\r\n]+[）)][：:]$/u.test(line))starts.push(index);});
 const blocks=starts.map((start,index)=>lines.slice(start,starts[index+1]??lines.length).join('\n').trimEnd());
 return {body,blocks,before:footer?.[1]};
}
function headerDate(block,now){
 const header=block.split('\n',1)[0].match(/[（(]([^\r\n]*)[）)][：:]$/u)?.[1]?.split(/[，,]/u)[1]||'',full=header.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1];
 if(full&&Number.isFinite(Date.parse(full+'T00:00:00Z')))return full;
 const relative=header.includes('前天')?2:header.includes('昨天')?1:header.includes('今天')?0:null;
 return relative===null?null:new Date(now+8*3600000-relative*86400000).toISOString().slice(0,10);
}
function pageMatches(page,query,date,now){
 const records=page.blocks.length?page.blocks:page.body?[page.body]:[],matches=[],possible=[];
 for(const text of records){
  if(query&&!normalized(text).includes(normalized(query)))continue;
  const at=date?headerDate(text,now):null;
  if(date&&at===null)possible.push(text);else if(!date||at===date)matches.push(text);
 }
 return {matches,possible};
}

/** Native, read-only peer lookup. The caller supplies its current owner/session boundary. */
export async function executeDialogueHistory({engine,tools,exec,background=false,assertCurrent},input){
 const options=checkedInput(input);
 if(typeof assertCurrent!=='function'||!engine||!exec?.agent?.session?.id||!exec.signal||typeof exec.signal.throwIfAborted!=='function')throw fail('unsupported-context','当前会话缺少只读查询边界。');
 if(!canReadDialogue(exec.agent,tools,exec.toolSet))throw fail('unsupported-executor','当前工具通道不支持只读对话查询。');
 const identity={...engine.identity()},sessionId=exec.agent.session.id,roundId=background?engine.l.round?.id:null;
 const pages=[],matches=[],possible=[],bodies=[],seen=new Set(options.before?[options.before]:[]);
 let before=options.before,stopReason='no-cursor',status='read',failure=null,total=0;
 function check({next=false}={}){
  const current=engine.identity();
  if(current.owner!==identity.owner||current.persona!==identity.persona||engine.l.owner!==identity.owner||engine.l.persona!==identity.persona)throw fail('context-changed','查询身份已经改变。');
  let allowed;try{allowed=assertCurrent();}catch{throw fail('context-changed','查询会话已经改变。');}
  if(allowed===false||allowed&&typeof allowed.then==='function')throw fail('context-changed','查询会话已经改变。');
  if(exec.signal.aborted)throw fail('cancelled','查询已取消。');
  if(engine.closed||engine.bridge?.fatal||!engine.authorized())throw fail('stopped','世界查询暂不可用。');
  if(background){
   const round=engine.l.round;
   if(!round||round.id!==roundId||round.sessionId!==sessionId||round.revision!==engine.l.revision)throw fail('context-changed','查询所属回合已经改变。');
   if(round.status!=='running')throw fail('inactive','查询所属回合已停止。');
   if(engine.cfg.stopped||!engine.cfg.autonomy||engine.cfg.observeOnly)throw fail('stopped','自动查询已暂停。');
   if(next&&round.calls>=engine.cfg.maxCalls)throw fail('call-budget','本轮剩余查询次数不足。');
   if(next&&engine.clock()-round.startedAt>=engine.cfg.turnMs)throw fail('time-budget','本轮查询时间已用完。');
  }
  if(next&&(engine.lock||engine.l.externalPending))throw fail('busy','另一个世界工具仍在执行。');
 }
 try{
  for(let index=0;index<options.maxPages;index++){
   check({next:true});
   const id='fishhistory-'+randomUUID(),args={fish:options.fish,...before?{before}:{}};
   const batch=await tools.execute({calls:[{type:'tool-call',id,name:HISTORY,arguments:JSON.stringify(args)}],agent:exec.agent,signal:exec.signal,...exec.toolSet===undefined?{}:{toolSet:exec.toolSet},maxParallelToolCalls:1});
   check();
   const result=batch?.results?.find(item=>item.callId===id)?.result;
   const journal=engine.l.journal.find(row=>row.id===id&&row.tool===HISTORY&&row.sessionId===sessionId&&(background?row.round===roundId:!row.round));
   const receipt=background?engine.l.round.receipts.find(row=>row.id===id&&row.tool===HISTORY):true;
   if(!result||!journal||!receipt||!['confirmed','failed','uncertain'].includes(journal.status))throw fail('receipt-missing','没有取得已确认的历史查询回执。');
   if(result.isError||journal.status!=='confirmed'||background&&receipt.isError)throw fail('query-failed','这次历史查询未成功。');
   const text=textOf(result);
   if(!text||text!==journal.result)throw fail('receipt-mismatch','历史原文与回执不一致。');
   if(total+text.length>MAX_CHARS){stopReason='text-budget';break;}
   const page=dialoguePage(text),selected=pageMatches(page,options.query,options.date,engine.clock());
   total+=text.length;pages.push({receiptId:id,text});bodies.push(page.body);
   matches.push(...selected.matches.map(text=>({receiptId:id,text})));possible.push(...selected.possible.map(text=>({receiptId:id,text})));
   before=page.before;
   if((options.query||options.date)&&selected.matches.length){status='found';stopReason='matched';break;}
   if(!before){stopReason='no-cursor';break;}
   if(seen.has(before)){stopReason='repeated-cursor';break;}
   seen.add(before);stopReason=index+1===options.maxPages?'page-limit':'continuing';
  }
 }catch(error){
  failure={code:typeof error.code==='string'?error.code:'query-failed',message:typeof error.code==='string'?error.message:'这次历史查询未完成。'};
  stopReason=failure.code;status='incomplete';
  if(failure.code==='context-changed'){pages.length=matches.length=possible.length=bodies.length=0;before=undefined;}
 }
 if(status!=='found')status=options.query||options.date?(possible.length?'possible':'not-found-in-pages'):pages.length?'read':'incomplete';
 if(failure&&!pages.length)status='incomplete';
 const selected=options.query||options.date?[...matches,...possible].map(record=>record.text):bodies;
 return {ok:!failure,fish:options.fish,status,pages,matches,dialogueText:[...new Set((selected.length?selected:bodies).filter(Boolean))].join('\n\n'),...(before?{nextBefore:before}:{}),stopReason,...failure?{error:failure}:{}};
}
