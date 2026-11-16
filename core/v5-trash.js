import {mkdirSync,existsSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'TRASH_RECOVERY_BLOCKED'});};
const monthPattern=/^\d{4}-(?:0[1-9]|1[0-2])$/;
const entryPattern=/^(\d{4}-(?:0[1-9]|1[0-2]))--[a-f0-9-]{36}$/;
export const trashMonth=time=>new Date(time+8*3600000).toISOString().slice(0,7);

/** One self-contained, lossless archive per retirement month; objects are shared within that month. */
export class V5Trash {
  constructor(runtime){
    this.r=runtime;this.memory=new Map();this.entries=new Map();
    this.folder=runtime.store.file===':memory:'?null:join(dirname(resolve(runtime.store.file)),'rubbishmemory');
    if(this.folder)this.directory(this.folder);
  }
  directory(folder){mkdirSync(folder,{recursive:true});if(lstatSync(folder).isSymbolicLink()||realpathSync(folder).toLowerCase()!==resolve(folder).toLowerCase())fail('记忆垃圾桶目录不能是重定向路径');}
  withMonth(month,write,fn){
    if(!monthPattern.test(month))fail('垃圾桶月份无效');
    if(this.active?.month===month)return fn(this.active.db);
    const year=join(this.folder,month.slice(0,4)),file=join(year,month+'.sqlite');
    if(!existsSync(file)&&!write)fail('对应月份的遗忘副本不存在');
    this.directory(this.folder);if(write)this.directory(year);else if(lstatSync(year).isSymbolicLink())fail('垃圾桶年份目录不是普通目录');
    if(existsSync(file)&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()))fail('月份副本不是普通文件');
    const db=new DatabaseSync(file,{readOnly:!write});
    try{
      if(write)db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,packed BLOB NOT NULL); CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,scope TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS entry_scope ON entries(scope,at);');
      return fn(db);
    }finally{db.close();}
  }
  object(value){
    const text=JSON.stringify(value),id=hash(text),month=this.active?.month??trashMonth(this.r.clock()),ref=month+':'+id;
    if(this.folder)this.withMonth(month,true,db=>{const existing=db.prepare('SELECT packed FROM objects WHERE id=?').get(id);if(existing){if(hash(gunzipSync(existing.packed))!==id)fail('垃圾桶对象校验失败，原记忆未退役');}else db.prepare('INSERT INTO objects VALUES(?,?)').run(id,gzipSync(text));});
    else if(!this.memory.has(ref))this.memory.set(ref,gzipSync(text));
    return ref;
  }
  loadObject(ref){
    const match=/^(\d{4}-(?:0[1-9]|1[0-2])):([a-f0-9]{64})$/.exec(ref);if(!match)fail('垃圾桶对象编号无效');const [,month,id]=match;
    const packed=this.folder?this.withMonth(month,false,db=>db.prepare('SELECT packed FROM objects WHERE id=?').get(id)?.packed):this.memory.get(ref);
    if(!packed)fail('垃圾桶对象缺失');const bytes=gunzipSync(packed,{maxOutputLength:64*1024*1024});if(hash(bytes)!==id)fail('垃圾桶对象校验失败');return JSON.parse(bytes);
  }
  writeEntry(entry){const body={...entry};delete body.checksum;const next={...body,checksum:hash(JSON.stringify(body))};if(this.folder)this.withMonth(next.id.slice(0,7),true,db=>db.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?,?)').run(next.id,next.scope,next.at,JSON.stringify(next)));else this.entries.set(next.id,next);return next;}
  validate(entry,id){if(!entry)fail('垃圾桶条目不存在');const {checksum,...body}=entry;if(body.schema!==1||body.id!==id||hash(JSON.stringify(body))!==checksum)fail('垃圾桶条目校验失败');return entry;}
  readEntry(id){
    const match=entryPattern.exec(id);if(!match)fail('垃圾桶条目编号无效');
    const json=this.folder?this.withMonth(match[1],false,db=>db.prepare('SELECT json FROM entries WHERE id=?').get(id)?.json):null;
    return this.validate(this.folder?json?JSON.parse(json):null:this.entries.get(id),id);
  }
  months(){if(!this.folder)return [...new Set([...this.entries.keys()].map(id=>id.slice(0,7)))];return readdirSync(this.folder,{withFileTypes:true}).filter(item=>/^\d{4}$/.test(item.name)&&item.isDirectory()&&!item.isSymbolicLink()).flatMap(item=>readdirSync(join(this.folder,item.name)).filter(name=>name.endsWith('.sqlite')&&monthPattern.test(name.slice(0,-7))&&name.startsWith(item.name+'-')).map(name=>name.slice(0,-7))).sort();}
  all(){return this.folder?this.months().flatMap(month=>this.withMonth(month,false,db=>db.prepare('SELECT id,json FROM entries').all().map(row=>this.validate(JSON.parse(row.json),row.id)))):[...this.entries.values()].map(entry=>this.readEntry(entry.id));}
  stash(memory,{reason,kind='forgotten'}={}){
    if(!this.active){const at=this.r.clock(),month=trashMonth(at);const prepare=db=>{if(db)db.exec('BEGIN IMMEDIATE');this.active={month,db,at};try{const result=this.stash(memory,{reason,kind});if(db)db.exec('COMMIT');return result;}catch(error){if(db)db.exec('ROLLBACK');throw error;}finally{this.active=null;}};const entry=this.folder?this.withMonth(month,true,prepare):prepare(null);this.readEntry(entry.id);this.loadObject(entry.memory);for(const ref of Object.values(entry.sources))this.loadObject(ref);return entry;}
    const r=this.r,sources={};
    for(const id of memory.source_refs){const source=r.store.getSource(id);if(source)sources[id]=this.object(source);}
    const prior=memory.attributes.precision_backup_id?this.readEntry(memory.attributes.precision_backup_id):null;
    if(prior){if(prior.scope!==memory.scope||prior.memory_id!==memory.id)fail('压缩前版本范围不一致');for(const [id,value]of Object.entries(prior.sources))if(!sources[id]){if(r.store.meta('erased-source:'+hash(id)))fail('压缩前原话已明确删除');sources[id]=this.object(this.loadObject(value));}}
    if(memory.kind==='raw'&&r.body(memory)!==null&&!Object.keys(sources).length)fail('完整原话未安全存入垃圾桶');
    const lookup=r.store.sql('SELECT text FROM lookup WHERE id=?').get(memory.id)?.text??null;
    const relations=r.store.relations(memory.scope).filter(edge=>edge.from_id===memory.id||edge.to_id===memory.id);
    const entry=this.writeEntry({schema:1,id:this.active.month+'--'+randomUUID(),scope:memory.scope,namespace:this.object(r.requireScope(memory.scope)),memory_id:memory.id,label:memory.label,kind,reason:reason??'退出活跃记忆',at:this.active.at,memory:this.object(memory),sources,versions:[...new Set([...(prior?.versions??[]).map(value=>this.object(this.loadObject(value))),...r.store.versions(memory.id,2147483647).map(value=>this.object(value))])],lookup:this.object(lookup),relations:relations.map(value=>this.object(value))});
    // Re-read before touching the active database; a failed write/check keeps the original active.
    this.loadObject(entry.memory);for(const id of Object.values(sources))this.loadObject(id);this.readEntry(entry.id);return entry;
  }
  list({scope='all',offset=0,limit=30}={}){
    this.r.requireScope(scope,true);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('垃圾桶分页范围无效');
    const entries=this.all().filter(entry=>{if(scope!=='all'&&entry.scope!==scope||entry.restored_at)return false;const m=this.r.store.getMemory(entry.memory_id);return m?.scope===entry.scope&&!m.attributes.explicit_erasure&&(m.attributes.trash_id===entry.id||m.attributes.precision_backup_id===entry.id);}).sort((a,b)=>b.at-a.at);
    return {scope,total:entries.length,folder:this.folder??'内存验证库',items:entries.slice(offset,offset+limit).map(entry=>({id:entry.id,scope:entry.scope,memory_id:entry.memory_id,label:entry.label,kind:entry.kind,reason:entry.reason,at:entry.at,source_count:Object.keys(entry.sources).length,expected_revision:this.r.store.getMemory(entry.memory_id).revision})),next_offset:Math.min(entries.length,offset+limit),auto_recall:false};
  }
  detail({scope,id}={}){this.r.requireScope(scope);const entry=this.readEntry(id);if(entry.scope!==scope||Object.keys(entry.sources).some(id=>this.r.store.meta('erased-source:'+hash(id))))fail('不能跨范围查看或找回已明确删除的垃圾桶内容');return {memory:this.loadObject(entry.memory),sources:Object.values(entry.sources).slice(0,20).map(value=>this.loadObject(value)),source_count:Object.keys(entry.sources).length,version_count:entry.versions.length};}
  restore({scope,id,expected_revision}={}){
    const r=this.r;r.requireScope(scope);const entry=this.readEntry(id);if(entry.scope!==scope)fail('不能跨人格或对话恢复记忆');
    const current=r.store.getMemory(entry.memory_id);
    if(!current||current.scope!==scope||current.revision!==expected_revision||current.attributes.explicit_erasure||![current.attributes.trash_id,current.attributes.precision_backup_id].includes(id)||entry.restored_at)fail('记忆已变化、已恢复或已明确删除，请刷新后重试');
    const namespace=this.loadObject(entry.namespace),currentNamespace=r.requireScope(scope);if(namespace.id!==scope||namespace.persona_id!==currentNamespace.persona_id||namespace.native_scope!==currentNamespace.native_scope)fail('副本的人格或对话身份不匹配');
    const memory=this.loadObject(entry.memory),sources=Object.entries(entry.sources).map(([sourceId,value])=>{const source=this.loadObject(value);if(source.id!==sourceId||source.scope!==scope||r.store.meta('erased-source:'+hash(sourceId)))fail('原话已明确删除或范围不匹配');const existing=r.store.getSource(sourceId);if(existing&&existing.text!==source.text)fail('同编号原话发生变化，不能覆盖');return source;});
    const versions=entry.versions.map(value=>this.loadObject(value)),relations=entry.relations.map(value=>this.loadObject(value)),lookup=this.loadObject(entry.lookup);
    if(memory.id!==current.id||memory.scope!==scope||versions.some(v=>v.id!==memory.id||v.scope!==scope)||relations.some(edge=>edge.scope!==scope))fail('垃圾桶内容范围不一致');
    r.store.tx(()=>{
      for(const source of sources)if(!r.store.getSource(source.id)){const result=r.store.sql('UPDATE sources SET json=?,packed=NULL WHERE id=? AND scope=?').run(JSON.stringify(source),source.id,scope);if(result.changes!==1)fail('原话定位记录不存在，恢复已停止');}
      for(const version of versions)r.store.putVersion(version);
      memory.revision=current.revision+1;memory.updated_at=r.clock();
      delete memory.attributes.trash_id;delete memory.attributes.precision_backup_id;
      if(memory.storage==='gist_only'&&sources.length)memory.storage='gist_with_evidence';
      if(memory.attributes.fact_key){const fact=memory.attributes.fact_key,pointer=r.store.meta('fact-current:'+hash(JSON.stringify([scope,fact.subject,fact.field])));if(pointer?.id!==memory.id){memory.validity='superseded';memory.review='needs_review';}}
      r.store.putMemory(memory,lookup??'');
      for(const edge of relations){const a=r.store.getMemory(edge.from_id),b=r.store.getMemory(edge.to_id);if(a?.scope===scope&&b?.scope===scope&&a.layer!=='forgotten'&&b.layer!=='forgotten')r.store.relation(edge);}
    });
    this.writeEntry({...entry,restored_at:r.clock()});r.rebuildCatalogs(scope);
    const run=r.beginRun(scope,'trash_restore');r.event(run,'W5','U','从记忆垃圾桶恢复原话、层级和来源',{output:[memory.id],extra:{trash_id:id}});r.endRun(run);
    return {restored:true,memory_id:memory.id,scope,run_id:run.id,revision:memory.revision};
  }
  purgeSources(ids){
    const erased=new Set(ids);for(const entry of this.all())if(Object.keys(entry.sources).some(id=>erased.has(id))){if(this.folder)this.withMonth(entry.id.slice(0,7),true,db=>db.prepare('DELETE FROM entries WHERE id=?').run(entry.id));else this.entries.delete(entry.id);}
    const used=new Set();for(const entry of this.all())for(const ref of [entry.namespace,entry.memory,entry.lookup,...Object.values(entry.sources),...entry.versions,...entry.relations])used.add(ref);
    if(this.folder){for(const month of this.months())this.withMonth(month,true,db=>{db.exec('BEGIN IMMEDIATE');try{for(const {id}of db.prepare('SELECT id FROM objects').all())if(!used.has(month+':'+id))db.prepare('DELETE FROM objects WHERE id=?').run(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}});}
    else for(const id of this.memory.keys())if(!used.has(id))this.memory.delete(id);
  }
}
