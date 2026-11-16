import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const CURRENT_VERSION_JSON='{"$thinkstar_current_version":1}';
const fields=['source_refs','source_roots','refs','semantic_refs','source_revisions','topics'];
const hash=text=>createHash('sha256').update(text).digest('hex');

/** The public object shape stays unchanged; only the persisted representation is shared. */
export class V5StorageCodec {
  constructor(store){this.store=store;this.cache=new Map();this.cacheBytes=0;}
  encode(value){
    const result={...value};
    for(const field of fields){
      if(!result[field]||typeof result[field]!=='object')continue;
      const text=JSON.stringify(result[field]);if(Buffer.byteLength(text)<512)continue;
      const id=hash(text);
      if(!this.store.sql('SELECT 1 FROM reference_sets WHERE id=?').get(id))this.store.sql('INSERT INTO reference_sets VALUES(?,?)').run(id,gzipSync(text));
      result[field]={$thinkstar_ref:id};
    }
    return JSON.stringify(result);
  }
  decode(json){
    const value=JSON.parse(json);
    for(const field of fields){
      const marker=value[field];if(!marker||typeof marker!=='object'||!marker.$thinkstar_ref)continue;
      const id=marker.$thinkstar_ref;if(!/^[a-f0-9]{64}$/.test(id)||Object.keys(marker).length!==1)throw Error('Invalid shared reference marker');
      let text=this.cache.get(id);
      if(text===undefined){
        const row=this.store.sql('SELECT packed FROM reference_sets WHERE id=?').get(id);
        if(!row)throw Error('Shared memory references are missing');
        text=gunzipSync(row.packed,{maxOutputLength:64*1024*1024}).toString();
        if(hash(text)!==id)throw Error('Shared memory reference checksum mismatch');
        const bytes=Buffer.byteLength(text);
        if(bytes<=4*1024*1024){while(this.cache.size>=32||this.cacheBytes+bytes>4*1024*1024){const key=this.cache.keys().next().value;this.cacheBytes-=Buffer.byteLength(this.cache.get(key));this.cache.delete(key);}this.cache.set(id,text);this.cacheBytes+=bytes;}
      }
      value[field]=JSON.parse(text);
    }
    return value;
  }
  prune(){
    const used=new Set();
    for(const table of ['memories','versions','catalogs'])for(const row of this.store.sql(`SELECT json FROM ${table}`).iterate())for(const match of row.json.matchAll(/"\$thinkstar_ref":"([a-f0-9]{64})"/g))used.add(match[1]);
    let removed=0;
    for(const row of this.store.sql('SELECT id FROM reference_sets').all())if(!used.has(row.id)){this.store.sql('DELETE FROM reference_sets WHERE id=?').run(row.id);removed++;}
    this.cache.clear();this.cacheBytes=0;return removed;
  }
}

export function backupStorageV1(db,file){
  if(file===':memory:')return null;
  const root=resolve(dirname(file)),folder=join(root,'backups');mkdirSync(folder,{recursive:true});
  if(lstatSync(folder).isSymbolicLink()||realpathSync(folder).toLowerCase()!==resolve(folder).toLowerCase())throw Error('Unsafe memory backup directory');
  const target=join(folder,`before-storage-v2-${Date.now()}-${randomUUID()}.sqlite`);
  db.exec("VACUUM main INTO '"+target.replaceAll("'","''")+"'");
  const copy=new DatabaseSync(target,{readOnly:true});
  try{if(copy.prepare('SELECT count(*) n FROM sources').get().n!==db.prepare('SELECT count(*) n FROM sources').get().n)throw Error('Memory migration backup verification failed');}finally{copy.close();}
  return target;
}

export function migrateStorageV2(store,backup){
  const before=store.sql('PRAGMA page_count').get().page_count*store.sql('PRAGMA page_size').get().page_size;
  store.tx(()=>{
    store.sql("UPDATE versions SET json=? WHERE EXISTS(SELECT 1 FROM memories m WHERE m.id=versions.id AND json_extract(m.json,'$.revision')=versions.revision AND m.json=versions.json)").run(CURRENT_VERSION_JSON);
    for(const table of ['memories','versions','catalogs']){
      let cursor=0;
      while(true){
        const rows=store.sql(`SELECT rowid n,json FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 256`).all(cursor);if(!rows.length)break;
        for(const row of rows){cursor=row.n;if(row.json===CURRENT_VERSION_JSON)continue;const compact=store.codec.encode(JSON.parse(row.json));if(compact!==row.json)store.sql(`UPDATE ${table} SET json=? WHERE rowid=?`).run(compact,row.n);}
      }
    }
    store.setMeta('thinkstar_storage_schema',2);
    store.setMeta('storage_v2_migration',{at:Date.now(),backup,before_bytes:before,status:'logical_complete'});
  });
  try{store.compactStorage({force:true});}catch(error){store.setMeta('storage_v2_migration',{at:Date.now(),backup,before_bytes:before,status:'logical_complete_compaction_pending',error:error.code??'COMPACTION_FAILED'});}
}
