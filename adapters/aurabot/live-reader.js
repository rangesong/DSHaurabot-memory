import { existsSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { readAurabot, sha256 } from './reader.js';
import { mapAurabot } from './mapper.js';

/** Poll allowlisted source files; SQLite is read only after copying into Thinkstar. */
export class AurabotLiveReader {
  constructor(runtime,{root='D:\\DSH\\plugins-data\\aurabot',scratch,interval=3000}={}){this.runtime=runtime;this.root=resolve(root);this.scratch=resolve(scratch);this.interval=interval;this.signature=null;this.busy=false;}
  fingerprint(){const names=['diary.json','mood.json','recall-log.json','memory.sqlite','memory.sqlite-wal','modules-data/history-vault/vault.sqlite','modules-data/history-vault/vault.sqlite-wal'];const chat=join(this.root,'chatlog');if(existsSync(chat))names.push(...readdirSync(chat).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map(n=>'chatlog/'+n));return sha256(JSON.stringify(names.map(n=>{try{const s=statSync(join(this.root,n));return[n,s.size,s.mtimeMs];}catch{return[n,null];}})));}
  async poll({force=false}={}){const live=this.runtime.live;if(this.busy)return {status:'queued',reason:'read_already_running'};this.busy=true;let captureDirectory;
    try{live.last_poll=Date.now();if(!existsSync(this.root)){live.status='source_unavailable';return {status:live.status};}const signature=this.fingerprint();if(!force&&signature===this.signature){live.status='watching';return {status:'unchanged'};}
      live.status='reading';mkdirSync(this.scratch,{recursive:true});captureDirectory=mkdtempSync(join(this.scratch,'poll-'));
      const capture=await readAurabot({root:this.root,snapshotDirectory:captureDirectory});
      if(capture.manifest.some(f=>f.name==='memory.sqlite'&&f.status==='unavailable')){live.status='partial_read';live.errors=capture.issues;return {status:'partial_read',issues:capture.issues,reason:'profile_exclusion_gate_unavailable'};}
      const mapped=mapAurabot(capture);
      const result=this.runtime.importPartitions(mapped.partitions,{fingerprint:capture.fingerprint,live:true,observations:mapped.observations});
      this.signature=signature;live.errors=capture.issues;live.status=capture.issues.length?'partial_read':'watching';if(result.added||result.updated)live.last_change=Date.now();live.new_messages+=result.added;return {...result,status:live.status,issues:capture.issues};
    }catch(error){live.status='read_failed';live.errors=[{code:error.code??'READ_FAILED',message:error.message}];return {status:live.status,error:error.message};}
    finally{this.busy=false;if(captureDirectory){const parent=realpathSync(this.scratch),actual=realpathSync(captureDirectory);if(dirname(actual)===parent&&basename(actual).startsWith('poll-'))rmSync(actual,{recursive:true,force:true});}}
  }
  start(){this.runtime.live.enabled=true;this.poll();this.timer=setInterval(()=>this.poll(),this.interval);this.timer.unref();}
  stop(){clearInterval(this.timer);this.runtime.live.enabled=false;}
}
