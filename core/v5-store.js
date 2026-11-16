import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {V5StorageCodec,CURRENT_VERSION_JSON,backupStorageV1,migrateStorageV2} from './v5-storage-codec.js';
import {retrievalTokens} from './v5-retrieval.js';

export const digest = (value) => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const scopeId = (context) => digest([context.persona_id,context.scope]).slice(0,24);
export const STORAGE_SCHEMA_VERSION=2;
export class V5Store {
  constructor(file) {
    if(file!==':memory:') mkdirSync(dirname(resolve(file)),{recursive:true});
    this.file=file; this.db=new DatabaseSync(file);
    // Refuse a future schema before touching tables, indexes or derived content on rollback.
    let previousVersion=null,backup=null;
    try{
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()){
        const row=this.db.prepare("SELECT json FROM meta WHERE key='thinkstar_storage_schema'").get();
        previousVersion=row?JSON.parse(row.json):null;
        if(previousVersion!==null&&![1,STORAGE_SCHEMA_VERSION].includes(previousVersion))throw Object.assign(new Error('底座结构版本不兼容，请使用对应版本的 Thinkstar 或恢复配套备份。'),{code:'STORAGE_SCHEMA_UNSUPPORTED'});
      }
      if(previousVersion===1)backup=backupStorageV1(this.db,file);
    }catch(error){this.db.close();throw error;}
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,scope TEXT NOT NULL,chat TEXT NOT NULL,sequence INTEGER NOT NULL,occurred INTEGER,root TEXT NOT NULL,json TEXT,packed BLOB);
      CREATE INDEX IF NOT EXISTS source_scope ON sources(scope,chat,occurred,sequence);
      CREATE INDEX IF NOT EXISTS source_retained_scope ON sources(scope) WHERE json IS NOT NULL OR packed IS NOT NULL;
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,layer TEXT NOT NULL,protection TEXT NOT NULL,validity TEXT NOT NULL,occurred INTEGER,updated INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,layer,updated);
      CREATE INDEX IF NOT EXISTS memory_archive_level ON memories(json_extract(json,'$.attributes.archive_level'),scope) WHERE kind='archive_digest' AND validity='current';
      CREATE INDEX IF NOT EXISTS memory_atlas_layers ON memories(layer,json_extract(json,'$.created_at') DESC,updated DESC,scope,occurred,id) WHERE layer!='forgotten' AND kind!='archive_chunk' AND validity='current';
      CREATE INDEX IF NOT EXISTS memory_atlas_recent ON memories(json_extract(json,'$.created_at') DESC,updated DESC,scope,layer,occurred,id) WHERE layer!='forgotten' AND kind!='archive_chunk' AND validity='current';
      CREATE TABLE IF NOT EXISTS lookup(id TEXT PRIMARY KEY,scope TEXT NOT NULL,text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lookup_scope ON lookup(scope);
      CREATE TABLE IF NOT EXISTS versions(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS reference_sets(id TEXT PRIMARY KEY,packed BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS catalogs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,region TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS catalog_scope ON catalogs(scope,region);
      CREATE TABLE IF NOT EXISTS states(scope TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,memory_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status,created);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,created INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,scope TEXT NOT NULL,created INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON events(run_id,sequence);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recalls(id TEXT PRIMARY KEY,scope TEXT NOT NULL,created INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,scope TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,json TEXT NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta(key,json) VALUES('thinkstar_storage_schema',?)").run(JSON.stringify(STORAGE_SCHEMA_VERSION));
    this.statements=new Map(); this.writing=false;this.codec=new V5StorageCodec(this);
    if(previousVersion===1)try{migrateStorageV2(this,backup);}catch(error){this.db.close();throw error;}
    if(this.meta('derived_lookup_nfkc')!==1)this.tx(()=>{for(const row of this.sql('SELECT id,text FROM lookup').all())this.sql('UPDATE lookup SET text=? WHERE id=?').run(row.text.normalize('NFKC'),row.id);this.setMeta('derived_lookup_nfkc',1);});
    try{this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS lookup_fts USING fts5(id UNINDEXED,text,tokenize='unicode61 remove_diacritics 0'); CREATE VIRTUAL TABLE IF NOT EXISTS lookup_fts_vocab USING fts5vocab(lookup_fts,'row'); CREATE TABLE IF NOT EXISTS lookup_fts_done(id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS lookup_fts_insert AFTER INSERT ON lookup BEGIN DELETE FROM lookup_fts_done WHERE id=new.id; INSERT INTO meta(key,json) VALUES('lookup_fts_ready','false') ON CONFLICT(key) DO UPDATE SET json='false'; END;
      CREATE TRIGGER IF NOT EXISTS lookup_fts_update AFTER UPDATE OF text ON lookup BEGIN DELETE FROM lookup_fts_done WHERE id=new.id; INSERT INTO meta(key,json) VALUES('lookup_fts_ready','false') ON CONFLICT(key) DO UPDATE SET json='false'; END;
      CREATE TRIGGER IF NOT EXISTS lookup_fts_delete AFTER DELETE ON lookup BEGIN DELETE FROM lookup_fts_done WHERE id=old.id; DELETE FROM lookup_fts WHERE rowid=old.rowid; END;`);this.fts=true;}catch{this.fts=false;}
  }
  sql(query) { if(!this.statements.has(query))this.statements.set(query,this.db.prepare(query)); return this.statements.get(query); }
  tx(action) { if(this.writing)return action(); this.db.exec('BEGIN IMMEDIATE');this.writing=true;try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}finally{this.writing=false;} }
  meta(key,fallback=null) { const r=this.sql('SELECT json FROM meta WHERE key=?').get(key);return r?JSON.parse(r.json):structuredClone(fallback); }
  setMeta(key,value) { this.sql('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key,JSON.stringify(value)); }
  scope(value) { this.sql('INSERT INTO scopes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,JSON.stringify(value)); }
  scopes() { return this.sql('SELECT json FROM scopes ORDER BY id').all().map(r=>JSON.parse(r.json)); }
  getScope(id) {const row=this.sql('SELECT json FROM scopes WHERE id=?').get(id);return row?JSON.parse(row.json):null;}
  source(value) { this.sql('INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?,?,?,NULL)').run(value.id,value.scope,value.chat_id,value.sequence,value.occurred_at,value.support_root,JSON.stringify(value)); }
  updateSourceMetadata(id,patch){const source=this.getSource(id);if(!source)return;Object.assign(source,patch);this.sql('UPDATE sources SET json=?,packed=NULL WHERE id=?').run(JSON.stringify(source),id);}
  getSource(id) {const r=this.sql('SELECT json,packed FROM sources WHERE id=?').get(id);return r?.json?JSON.parse(r.json):r?.packed?JSON.parse(gunzipSync(r.packed).toString()):null;}
  packSource(id) {const r=this.sql('SELECT json FROM sources WHERE id=?').get(id);if(r?.json)this.sql('UPDATE sources SET json=NULL,packed=? WHERE id=?').run(gzipSync(r.json),id);}
  deleteSource(id) {this.sql('UPDATE sources SET json=NULL,packed=NULL WHERE id=?').run(id);}
  decodeMemory(json){return this.codec.decode(json);}
  getMemory(id) {const r=this.sql('SELECT json FROM memories WHERE id=?').get(id);return r?this.decodeMemory(r.json):null;}
  decodeVersion(row){if(row.json!==CURRENT_VERSION_JSON)return this.decodeMemory(row.json);const memory=this.getMemory(row.id);if(!memory||memory.revision!==row.revision)throw Error('Current version reference is inconsistent');return memory;}
  versions(id,limit=12){return this.sql('SELECT id,revision,json FROM versions WHERE id=? ORDER BY revision DESC LIMIT ?').all(id,limit).map(row=>this.decodeVersion(row));}
  putVersion(memory){this.sql('INSERT OR REPLACE INTO versions VALUES(?,?,?)').run(memory.id,memory.revision,this.codec.encode(memory));}
  putMemory(memory,text=null,{history=true}={}) {
    return this.tx(()=>{
    const json=this.codec.encode(memory),previous=this.sql('SELECT json FROM memories WHERE id=?').get(memory.id);
    if(previous&&previous.json!==json)this.sql('UPDATE versions SET json=? WHERE id=? AND json=?').run(previous.json,memory.id,CURRENT_VERSION_JSON);
    this.sql(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,layer=excluded.layer,protection=excluded.protection,validity=excluded.validity,occurred=excluded.occurred,updated=excluded.updated,json=excluded.json`).run(memory.id,memory.scope,memory.kind,memory.label,memory.layer,memory.protection,memory.validity,memory.occurred_at,memory.updated_at,json);
    if(history)this.sql('INSERT OR REPLACE INTO versions VALUES(?,?,?)').run(memory.id,memory.revision,CURRENT_VERSION_JSON);
    if(text!==null){const ready=this.fts&&this.meta('lookup_fts_ready',false),searchable=`${memory.layer==='forgotten'?'':memory.label} ${memory.attributes.speaker_label??''} ${(memory.attributes.aliases??[]).join(' ')} ${text}`.normalize('NFKC').toLocaleLowerCase();this.sql('INSERT INTO lookup VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').run(memory.id,memory.scope,searchable);if(this.fts){this.indexText(memory.id,searchable);if(ready)this.setMeta('lookup_fts_ready',true);}}
    });
  }
  all(scope='all',{includeForgotten=false}={}) {const where=[...(scope==='all'?[]:['scope=?']),...(includeForgotten?[]:["layer!='forgotten'"])];return this.sql(`SELECT json FROM memories${where.length?' WHERE '+where.join(' AND '):''}`).all(...(scope==='all'?[]:[scope])).map(r=>this.decodeMemory(r.json));}
  indexText(id,text){const key=this.sql('SELECT rowid n FROM lookup WHERE id=?').get(id)?.n;if(key===undefined)return;this.sql('DELETE FROM lookup_fts WHERE rowid=?').run(key);this.sql('INSERT INTO lookup_fts(rowid,id,text) VALUES(?,?,?)').run(key,id,retrievalTokens(text).join(' '));this.sql('INSERT OR IGNORE INTO lookup_fts_done VALUES(?)').run(id);}
  rebuildSearchIndex(limit=500){if(!this.fts)return {available:false};const rows=this.sql('SELECT l.id,l.text FROM lookup l LEFT JOIN lookup_fts_done d ON d.id=l.id WHERE d.id IS NULL LIMIT ?').all(Math.max(1,Math.min(5000,limit)));this.tx(()=>{for(const row of rows)this.indexText(row.id,row.text);});const pending=Number(this.sql('SELECT count(*) n FROM lookup l LEFT JOIN lookup_fts_done d ON d.id=l.id WHERE d.id IS NULL').get().n);this.setMeta('lookup_fts_ready',pending===0);return {available:true,processed:rows.length,pending};}
  atlasSelection({scope='all',layer=null,limit,until=null,matchIds=null,focusId=null,layerOrder=[]}){
    const where=["layer!='forgotten' AND kind!='archive_chunk' AND validity='current'"],args=[];
    if(scope!=='all'){where.push('scope=?');args.push(scope);}
    if(layer){where.push('layer=?');args.push(layer);}
    if(until!==null){where.push('(occurred IS NULL OR occurred<=?)');args.push(until);}
    if(matchIds!==null){where.push('id IN (SELECT value FROM json_each(?))');args.push(JSON.stringify(matchIds));}
    const filter=where.join(' AND '),groups=this.sql('SELECT layer,count(*) n FROM memories WHERE '+filter+' GROUP BY layer').all(...args);
    const counts=new Map(groups.map(row=>[row.layer,Number(row.n)])),matching=groups.reduce((sum,row)=>sum+Number(row.n),0);
    const focus=focusId?this.sql('SELECT id,layer FROM memories WHERE id=? AND '+filter).get(focusId,...args):null;
    const ids=[],seen=new Set();
    const pick=(selectedLayer,amount)=>{
      if(amount<=0)return;
      if(focus&&!seen.has(focus.id)&&(!selectedLayer||focus.layer===selectedLayer)){ids.push(focus.id);seen.add(focus.id);amount--;}
      if(amount<=0)return;
      const clauses=[...where],values=[...args];
      if(selectedLayer){clauses.push('layer=?');values.push(selectedLayer);}
      if(seen.size){clauses.push('id NOT IN (SELECT value FROM json_each(?))');values.push(JSON.stringify([...seen]));}
      values.push(amount);
      const index=selectedLayer||layer?'memory_atlas_layers':'memory_atlas_recent';
      for(const row of this.sql(`SELECT id FROM memories INDEXED BY ${index} WHERE ${clauses.join(' AND ')} ORDER BY json_extract(json,'$.created_at') DESC,updated DESC,${scope==='all'?'':'layer ASC,'}rowid ASC LIMIT ?`).all(...values)){ids.push(row.id);seen.add(row.id);}
    };
    if(!layer)for(const id of layerOrder){if(ids.length>=limit)break;if(counts.has(id))pick(id,Math.min(Math.ceil(limit/layerOrder.length),limit-ids.length));}
    pick(null,limit-ids.length);
    return {ids,counts,matching};
  }
  atlasRelations(ids,scope,limit){
    if(!ids.length||!limit)return [];
    const set=JSON.stringify(ids),where=['from_id IN (SELECT value FROM json_each(?))','to_id IN (SELECT value FROM json_each(?))'],args=[set,set];
    if(scope!=='all'){where.push('scope=?');args.push(scope);}args.push(limit);
    return this.sql('SELECT json FROM relations WHERE '+where.join(' AND ')+' ORDER BY rowid LIMIT ?').all(...args).map(row=>JSON.parse(row.json));
  }
  eventCount(){return Number(this.sql('SELECT count(*) n FROM events').get().n);}
  search(scope,terms,limit=2000,{phrase='',protectedOnly=false,rawOnly=false}={}) {
    const where=["m.layer!='forgotten'"],args=[];
    let indexed=false;
    if(this.fts&&terms.length&&terms.every(term=>/^[\p{Script=Han}]{2}$/u.test(term))&&this.meta('lookup_fts_ready',false)){
      const frequency=terms.map(term=>({term,df:Number(this.sql('SELECT doc FROM lookup_fts_vocab WHERE term=?').get(term)?.doc??0)})).filter(item=>item.df>0).sort((a,b)=>a.df-b.df);
      const rare=frequency.length&&frequency[0].df<frequency.at(-1).df/8?frequency.filter(item=>item.df<=Math.max(4,frequency[0].df*4)).slice(0,4).map(item=>item.term):terms;
      const select=selected=>this.sql("SELECT f.id FROM lookup_fts f JOIN memories m ON m.id=f.id WHERE lookup_fts MATCH ? AND (?='all' OR m.scope=?) AND m.layer!='forgotten' AND (?=0 OR m.protection IN ('P0','P1')) AND (?=0 OR m.kind='raw' AND m.validity='current') ORDER BY bm25(lookup_fts) LIMIT ?").all(selected.map(term=>'"'+term+'"').join(' OR '),scope,scope,protectedOnly?1:0,rawOnly?1:0,Math.max(512,Math.min(8000,limit*3))).map(row=>row.id);
      let ids=select(rare);if(!ids.length&&rare!==terms)ids=select(terms);where.push('m.id IN (SELECT value FROM json_each(?))');args.push(JSON.stringify(ids));indexed=true;
    }
    if(scope!=='all'){where.push('m.scope=?');args.push(scope);}
    if(protectedOnly)where.push("m.protection IN ('P0','P1')");
    if(rawOnly)where.push("m.kind='raw' AND m.validity='current'");
    if(terms.length){where.push('('+terms.map(()=>"instr(l.text,?)>0").join(' OR ')+')');args.push(...terms);}
    const order=[];if(phrase){order.push('(instr(l.text,?)>0) DESC');args.push(phrase.normalize('NFKC').toLocaleLowerCase());}
    if(terms.length){order.push('('+terms.map(()=>'(CASE WHEN instr(l.text,?)>0 THEN ? ELSE 0 END)').join('+')+') DESC');for(const term of terms)args.push(term,term.length);}
    if(protectedOnly)order.push("CASE WHEN m.protection='P0' THEN 0 ELSE 1 END");
    order.push('m.updated DESC');args.push(limit);
    return this.sql(`SELECT m.json,l.text FROM memories m ${indexed?'INDEXED BY sqlite_autoindex_memories_1':''} JOIN lookup l ON m.id=l.id WHERE ${where.join(' AND ')} ORDER BY ${order.join(',')} LIMIT ?`).all(...args).map(r=>({...this.decodeMemory(r.json),search_text:r.text}));
  }
  catalog(value){this.tx(()=>this.sql('INSERT INTO catalogs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,value.scope,value.region,this.codec.encode({...value,ref_count:value.refs.length})));}
  catalogHeaders(scope='all',region=null){const where=[],args=[];if(scope!=='all'){where.push('scope=?');args.push(scope);}if(region){where.push('region=?');args.push(region);}return this.sql('SELECT id,region,json_extract(json,\'$.ref_count\') ref_count FROM catalogs'+(where.length?' WHERE '+where.join(' AND '):'')).all(...args).map(row=>({...row,refs:[]}));}
  catalogs(scope='all',region=null){const w=[],a=[];if(scope!=='all'){w.push('scope=?');a.push(scope);}if(region){w.push('region=?');a.push(region);}return this.sql(`SELECT json FROM catalogs${w.length?' WHERE '+w.join(' AND '):''}`).all(...a).map(r=>this.codec.decode(r.json));}
  state(scope){const r=this.sql('SELECT json FROM states WHERE scope=?').get(scope);return r?JSON.parse(r.json):{scope,revision:0,last_applied_sequence:0,choices:[],negations:[],active_topic:null,suspended_topics:[],open_loop_ids:[],source_refs:[],delivery_status:'unknown'};}
  saveState(value){this.sql('INSERT INTO states VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET json=excluded.json').run(value.scope,JSON.stringify(value));}
  run(value){this.sql('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,value.scope,value.created_at,JSON.stringify(value));}
  event(value){this.sql('INSERT INTO events(id,run_id,scope,created,json) VALUES(?,?,?,?,?)').run(value.id,value.run_id,value.scope,value.timestamp,JSON.stringify(value));return Number(this.sql('SELECT last_insert_rowid() id').get().id);}
  events({after=0,run_id=null,scope='all',limit=200}={}){const w=['sequence>?'],a=[after];if(run_id){w.push('run_id=?');a.push(run_id);}if(scope!=='all'){w.push('scope=?');a.push(scope);}a.push(limit);return this.sql(`SELECT sequence,json FROM events WHERE ${w.join(' AND ')} ORDER BY sequence LIMIT ?`).all(...a).map(r=>({...JSON.parse(r.json),sequence:r.sequence}));}
  job(value){this.sql('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?)').run(value.id,value.scope,value.memory_id,value.status,value.attempts??0,value.created_at,JSON.stringify(value));}
  updateJob(value){this.sql('UPDATE jobs SET status=?,attempts=?,json=? WHERE id=?').run(value.status,value.attempts,JSON.stringify(value),value.id);}
  jobs(limit=24,scope=null){return this.sql("SELECT json FROM (SELECT j.json,j.created,CASE WHEN m.protection IN ('P0','P1') THEN 0 ELSE 1 END priority,ROW_NUMBER() OVER(PARTITION BY j.scope ORDER BY CASE WHEN m.protection IN ('P0','P1') THEN 0 ELSE 1 END,j.created) turn FROM jobs j JOIN memories m ON m.id=j.memory_id WHERE j.status IN ('pending','retry') AND j.attempts<4 AND (? IS NULL OR j.scope=?)) ORDER BY priority,turn,created LIMIT ?").all(scope,scope,limit).map(r=>JSON.parse(r.json));}
  queuePending(){return Number(this.sql("SELECT count(*) n FROM jobs WHERE status IN ('pending','retry')").get().n);}
  relation(value){this.sql('INSERT INTO relations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,value.scope,value.from_id,value.to_id,JSON.stringify(value));}
  relations(scope='all'){return this.sql(`SELECT json FROM relations${scope==='all'?'':' WHERE scope=?'}`).all(...(scope==='all'?[]:[scope])).map(r=>JSON.parse(r.json));}
  recall(value){this.sql('INSERT INTO recalls VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,value.scope,value.created_at,JSON.stringify(value));}
  recalls(scope='all',limit=20){return this.sql(`SELECT json FROM recalls${scope==='all'?'':' WHERE scope=?'} ORDER BY created DESC LIMIT ?`).all(...(scope==='all'?[]:[scope]),limit).map(r=>JSON.parse(r.json));}
  stats(){const count=(table,where='')=>Number(this.sql(`SELECT count(*) n FROM ${table} ${where}`).get().n);return {sources:count('sources','WHERE json IS NOT NULL OR packed IS NOT NULL'),objects:count('memories',"WHERE layer!='forgotten' AND kind!='archive_chunk' AND validity='current'"),forgotten:count('memories',"WHERE layer='forgotten'"),pending:count('jobs',"WHERE status IN ('pending','retry')"),failed:count('jobs',"WHERE status='failed'"),catalogs:count('catalogs'),events:count('events'),bytes:Number(this.sql('PRAGMA page_count').get().page_count)*Number(this.sql('PRAGMA page_size').get().page_size),oldest_pending:this.sql("SELECT min(created) t FROM jobs WHERE status IN ('pending','retry')").get().t};}
  compactStorage({force=false}={}){
    const page=this.sql('PRAGMA page_size').get().page_size,free=this.sql('PRAGMA freelist_count').get().freelist_count,total=this.sql('PRAGMA page_count').get().page_count;
    if(this.writing)throw Error('Storage compaction cannot run inside a transaction');
    if(!force&&(free*page<16*1024*1024||free/total<.15))return {compacted:false};
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.exec('VACUUM');this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after=this.sql('PRAGMA page_count').get().page_count*page,result={compacted:true,before_bytes:total*page,after_bytes:after,at:Date.now()};
    this.setMeta('storage_last_compaction',result);return result;
  }
  close(){if(!this.closed){this.db.close();this.closed=true;}}
}
