const key=value=>typeof value==='string'?value.replace(/^session-/,''):'';
const prefix='system:ext-fish-world:';
const requireScope=(ok,message)=>{if(!ok)throw Error(message);};

/** Restore the same world-only global mask used by the normal tool builder. */
export function createWorldToolScope({getEngine,identity,scope,chatOfSession,tools,names,onRelease}){
 requireScope([getEngine,identity,scope,chatOfSession,onRelease].every(fn=>typeof fn==='function')&&Array.isArray(names)&&names.length>0&&new Set(names).size===names.length&&names.every(name=>typeof name==='string'&&name.startsWith('mcp__fish-world__world_')),'后台工具作用域配置不完整');
 const required=[...names],owned=new WeakMap(),receivers=new WeakMap();
 return (agent,{existing=false,chat}={})=>{
  const engine=getEngine(),life=engine?.l,current=identity(),base=scope(),id=agent?.session?.id,window=life?.contextWindow;
  requireScope(engine&&!engine.closed&&typeof id==='string'&&key(id)&&typeof current?.owner==='string'&&current.owner&&typeof current.persona==='string'&&current.persona&&life.owner===current.owner&&life.persona===current.persona&&typeof base==='string'&&base&&(!window||window.base===base),'后台工具作用域身份与生活账本不匹配');
  const actual=chatOfSession(id);
  if(existing){
   const routes=window?Array.isArray(window.windows)?window.windows.filter(row=>key(row.sessionId)===key(id)&&typeof row.key==='string'&&row.key).map(row=>prefix+row.key):[]:key(life.sessionId)===key(id)?[prefix+base]:[];
   requireScope(routes.includes(actual),'启动预检只能恢复本身份账本与宿主映射一致的世界会话');
  }else requireScope(chat?.kind==='system'&&chat.chatId===prefix+(window?.key||base)&&actual===chat.chatId,'不是当前身份的世界工具会话');
  // All ownership checks precede registry access: a foreign Agent is never masked.
  const context=agent.ctx;
  requireScope(context&&(typeof context==='object'||typeof context==='function'),'后台工具作用域接口不可用');
  // Cordis yields a new service proxy on each property read. Pin this context's
  // scoped receiver for this module lifetime, then deduplicate its exact mask.
  const target=receivers.get(context)||context.tools;
  requireScope(target&&typeof target.restrict==='function'&&typeof tools?.schemas==='function','后台工具作用域接口不可用');
  receivers.set(context,target);
  if(!owned.has(target)){
   const release=target.restrict({allow:[...required]});
   requireScope(typeof release==='function','后台工具作用域缺少生命周期释放接口');
   let active=true;
   const off=()=>{if(!active)return;active=false;owned.delete(target);if(receivers.get(context)===target)receivers.delete(context);return release();};
   owned.set(target,off);
   try{onRelease(off);}catch(error){off();throw error;}
  }
  const schemas=tools.schemas(agent);
  requireScope(Array.isArray(schemas),'后台工具清单不可用');
  const visible=schemas.map(schema=>Array.isArray(schema)?schema[0]:schema?.name);
  // SDK restrictions intersect over globals. Scope-local life/dialogue tools remain visible.
  requireScope(required.every(name=>visible.includes(name)),'后台实际可见世界工具不完整');
  return visible;
 };
}
