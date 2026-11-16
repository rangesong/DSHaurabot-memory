import { digest } from './v5-store.js';

export function memoryChunks(text,size=220,overlap=40){
  const chars=Array.from(String(text??'')),items=[];
  for(let at=0;at<chars.length;at+=size-overlap){items.push({offset:at,text:chars.slice(at,at+size).join('')});if(at+size>=chars.length)break;}
  return items;
}
const norm=v=>{const a=Float32Array.from(v);let n=0;for(const x of a){if(!Number.isFinite(x))throw Error('向量数值无效');n+=x*x;}n=Math.sqrt(n);if(!n)throw Error('空向量');for(let i=0;i<a.length;i++)a[i]/=n;return a;};
const dot=(a,b)=>{if(a.length!==b.length)return -1;let n=0;for(let i=0;i<a.length;i++)n+=a[i]*b[i];return n;};

/** Rebuildable SQLite index. Original text and archive ownership remain in V5Store. */
export class V5Semantic {
  constructor(runtime,{embed=null,model='unavailable'}={}){
    this.r=runtime;this.embed=embed;this.model=model;this.stopped=false;this.busy=false;this.error=null;this.queryCache=new Map();this.rejected=new Map();
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS semantic_chunks(id TEXT PRIMARY KEY,scope TEXT NOT NULL,memory_id TEXT NOT NULL,signature TEXT NOT NULL,model TEXT NOT NULL,offset INTEGER NOT NULL,vector BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS semantic_scope ON semantic_chunks(scope,model,memory_id);
      CREATE TABLE IF NOT EXISTS semantic_documents(memory_id TEXT PRIMARY KEY,scope TEXT NOT NULL,signature TEXT NOT NULL,model TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS semantic_documents_scope ON semantic_documents(scope,model);`);
  }
  configure({embed,model}){this.embed=embed;this.model=model;}
  status(){return {available:typeof this.embed==='function',model:this.model,indexed_chunks:Number(this.r.store.sql('SELECT count(*) n FROM semantic_chunks WHERE model=?').get(this.model).n),indexed_documents:Number(this.r.store.sql('SELECT count(*) n FROM semantic_documents WHERE model=?').get(this.model).n),busy:this.busy,error:this.error,cpu_only:true};}
  async vector(text){const value=await this.embed(text);return norm(value);}
  signature(m){return digest([this.model,'condition-anchor-v1',m.id,this.r.body(m),m.attributes.trigger_condition??null]);}
  async sync({scope='all',scope_ids=null,limit=24,force=false,filter=()=>true}={}){
    if(this.stopped||this.busy||!this.embed)return {processed:0,reason:'not_ready_or_busy'};
    if(!force&&!this.r.maintenanceWindow().allowed)return {processed:0,reason:'outside_night_window'};
    this.busy=true;let processed=0,chunks=0;
    try{
      for(const[id,at]of this.rejected)if(this.r.clock()-at>3600000)this.rejected.delete(id);
      const rows=this.r.store.sql("SELECT m.json FROM memories m LEFT JOIN semantic_documents d ON d.memory_id=m.id WHERE m.layer!='forgotten' AND m.validity='current' AND m.kind IN ('raw','claim','pattern','intent','method','knowledge') AND (m.kind!='raw' OR json_extract(m.json,'$.evidence.origin')!='role_expression') AND (?='all' OR m.scope=?) AND (?=0 OR m.scope IN (SELECT value FROM json_each(?))) AND m.id NOT IN (SELECT value FROM json_each(?)) AND (d.memory_id IS NULL OR d.model!=? OR d.revision!=json_extract(m.json,'$.revision')) ORDER BY CASE WHEN m.protection IN ('P0','P1') THEN 0 ELSE 1 END,m.updated DESC LIMIT ?").all(scope,scope,scope_ids===null?0:1,JSON.stringify(scope_ids??[]),JSON.stringify([...this.rejected.keys()]),this.model,Math.min(300,Math.max(1,limit))).map(row=>this.r.store.decodeMemory(row.json));
      for(const m of rows){
        if(this.stopped)break;
        if(!filter(m)){this.rejected.set(m.id,this.r.clock());while(this.rejected.size>4096)this.rejected.delete(this.rejected.keys().next().value);continue;}
        const signature=this.signature(m),indexed=this.r.store.sql('SELECT signature FROM semantic_documents WHERE memory_id=? AND model=?').get(m.id,this.model);
        if(indexed?.signature===signature){this.r.store.sql('UPDATE semantic_documents SET revision=? WHERE memory_id=?').run(m.revision,m.id);continue;}
        const parts=memoryChunks(this.r.body(m));if(m.kind==='pattern'&&m.attributes.trigger_condition&&m.attributes.trigger_condition!=='仅在原话所述条件成立时')parts.push({offset:-1,text:m.attributes.trigger_condition});const vectors=[];
        for(const part of parts){if(this.stopped)break;vectors.push({...part,vector:await this.vector(part.text)});}
        const current=this.r.store.getMemory(m.id);if(this.stopped||!current||current.layer==='forgotten'||current.validity!=='current'||!filter(current)||this.signature(current)!==signature)continue;
        this.r.store.tx(()=>{this.r.store.sql('DELETE FROM semantic_chunks WHERE memory_id=?').run(m.id);
          for(const part of vectors)this.r.store.sql('INSERT INTO semantic_chunks VALUES(?,?,?,?,?,?,?)').run(digest([m.id,part.offset]),m.scope,m.id,signature,this.model,part.offset,Buffer.from(part.vector.buffer));
          this.r.store.sql('INSERT INTO semantic_documents VALUES(?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET signature=excluded.signature,model=excluded.model,revision=excluded.revision').run(m.id,m.scope,signature,this.model,m.revision);
        });processed++;chunks+=vectors.length;await new Promise(setImmediate);
      }
      this.r.store.sql("DELETE FROM semantic_chunks WHERE memory_id IN (SELECT id FROM memories WHERE layer='forgotten' OR validity!='current')").run();
      this.r.store.sql("DELETE FROM semantic_documents WHERE memory_id IN (SELECT id FROM memories WHERE layer='forgotten' OR validity!='current')").run();
      this.error=null;return {processed,chunks,model:this.model};
    }catch(error){this.error=error.code??error.message;throw error;}finally{this.busy=false;}
  }
  async search({scope,query,limit=12,minScore=.5,filter=()=>true}={}){
    if(this.stopped||!this.embed||scope==='all')return [];
    const instruction=this.model.includes('bge-small-zh')?'为这个句子生成表示以用于检索相关文章：':'';
    const key=digest([this.model,instruction,query]);let vector=this.queryCache.get(key);
    if(!vector){vector=await this.vector(instruction+query);if(this.stopped)return [];this.queryCache.set(key,vector);while(this.queryCache.size>32)this.queryCache.delete(this.queryCache.keys().next().value);}
    const rows=this.r.store.sql('SELECT c.memory_id,c.offset,c.vector,c.signature FROM semantic_chunks c JOIN memories m ON m.id=c.memory_id WHERE c.scope=? AND c.model=? AND m.validity=\'current\' AND m.layer!=\'forgotten\'').iterate(scope,this.model),best=new Map();let scanned=0;
    for(const row of rows){if(this.stopped)return [];const bytes=Buffer.from(row.vector),v=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),score=dot(vector,v);if(++scanned%1000===0)await new Promise(setImmediate);if(score<minScore)continue;const old=best.get(row.memory_id);if(!old||score>old.score)best.set(row.memory_id,{id:row.memory_id,score,offset:row.offset,signature:row.signature});if(best.size>limit*4){const remove=[...best.values()].sort((a,b)=>a.score-b.score)[0];best.delete(remove.id);}}
    return [...best.values()].sort((a,b)=>b.score-a.score).filter(item=>{const m=this.r.store.getMemory(item.id);return m&&filter(m)&&this.signature(m)===item.signature;}).slice(0,limit);
  }
  erase(ids){for(const id of ids){this.r.store.sql('DELETE FROM semantic_chunks WHERE memory_id=?').run(id);this.r.store.sql('DELETE FROM semantic_documents WHERE memory_id=?').run(id);}this.queryCache.clear();}
  async stop(){this.stopped=true;this.queryCache.clear();this.rejected.clear();}
}
