import {AsyncLocalStorage} from 'node:async_hooks';
/** Mirror successful public module writes; keep the original return values and restore only our wrappers. */
export function memoryCompatibility(api,{enabled,record,invalidate,erase,discard=erase,read=()=>{},onDetach=()=>{},onError=()=>{}}){
  let target=null;const originals=new Map(),wrappers=new Map();
  const commands=new AsyncLocalStorage();
  const reads=new Set(['contextFor','recallHint','recallHintAsync']);
  const methods=['add','addEvent','noteVia','restore','update','revise','invalidate','remove','deletePerson','setNoMemory','handleCommand',...reads];
  function detach(){if(target)for(const [name,wrapper] of wrappers)if(target[name]===wrapper)try{target[name]=originals.get(name);}catch(error){onError(error);}target=null;originals.clear();wrappers.clear();onDetach();}
  function observe(name,args,result){
    if(!enabled()||result===false||result==null||result?.ok===false||result?.debug)return;
    if(reads.has(name)){read(name,args,result);return;}
    if(name==='add'||name==='addEvent'||name==='noteVia')record(name,args[0]??{},result);
    else if(name==='handleCommand'&&result?.ok&&!result.forgotten){const chat=args[0],text=String(args[1]).replace(/^(?:请|麻烦|你)?\s*(?:记住|你要记得|要记得)[：:,，\s]*/,'');if(text!==String(args[1]))record('explicit_command',{text,chatId:chat?.chatId,about:String(chat?.userId??''),source:'said'},result);}
    else if(['update','revise','invalidate','restore'].includes(name))invalidate(String(args[0]),name,args,result);
    else if(name==='remove')(commands.getStore()?.permanent?erase:discard)({upstream_id:String(args[0])});
    else if(name==='deletePerson'||name==='setNoMemory'&&args[1]===true&&args[2]?.deleteExisting)erase({uid:String(args[0])});
    else if(name==='handleCommand'&&result?.ok&&/^(?:请|麻烦|你)?\s*(?:忘掉|忘记|遗忘|废弃|别记|不要记)/.test(String(args[1]))){const chat=args[0],term=String(args[1]).replace(/^(?:请|麻烦|你)?\s*(?:忘掉|忘记|遗忘|废弃|别记|不要记)[：:,，\s]*/,'').replace(/[。！!]+$/,'').trim();if(chat?.kind==='private'&&chat.chatId===`private:${chat.userId}`&&term.length>=3)(commands.getStore()?.permanent?erase:discard)({chatId:chat.chatId,uid:String(chat.userId),keyword:term});}
  }
  function refresh(){
    const next=enabled()?api.use('memory'):null;if(next===target)return;detach();if(!next)return;target=next;
    for(const name of methods){if(typeof next[name]!=='function')continue;const original=next[name];originals.set(name,original);
      const wrapper=function(...args){const invoke=()=>{const result=original.apply(this,args);const done=value=>{try{observe(name,args,value);}catch(error){onError(error);}return value;};return result&&typeof result.then==='function'?result.then(done):done(result);};return name==='handleCommand'?commands.run({permanent:/(?:别记|不要记|彻底删除|永久删除)/.test(String(args[1]))},invoke):['deletePerson','setNoMemory'].includes(name)?commands.run({permanent:true},invoke):invoke();};
      try{next[name]=wrapper;if(next[name]===wrapper)wrappers.set(name,wrapper);}catch(error){onError(error);}
    }
  }
  const proxy=new Proxy({}, {get(_target,key){refresh();const memory=api.use('memory');const value=memory?.[key];return typeof value==='function'?value.bind(memory):value;}});
  return {refresh,detach,proxy,status:()=>({connected:!!target,mirrored_methods:[...wrappers.keys()].filter(name=>!reads.has(name)),observed_read_methods:[...wrappers.keys()].filter(name=>reads.has(name)),mode:'coordinated_coexistence_not_full_replacement'})};
}
