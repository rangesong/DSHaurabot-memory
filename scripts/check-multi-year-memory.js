// Equivalent-volume historical corpus; not a claim of three years of continuous uptime.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {V5Runtime} from '../core/v5-runtime.js';
const root=fileURLToPath(new URL('../',import.meta.url)),folder=path.join(root,'runtime-data/upgrade-0.4.0/scale');fs.mkdirSync(folder,{recursive:true});
const file=path.join(folder,'memory.sqlite');if(fs.existsSync(file))throw Error('Scale fixture exists; preserve it and use its saved results instead of overwriting');
const day=86400000,start=Date.parse('2023-11-17T08:00:00+08:00'),days=1095,perDay=405,count=days*perDay,context={persona_id:'synthetic-years',scope:'private:scale'},at=start+days*day;
let r=new V5Runtime({file,clock:()=>at});const scope=r.addScope(context).id,started=performance.now();
const anchors=[['星砾远航','订票前先确认护照，没有实际出票。'],['暮蓝灯塔','旧地址为青杉路，后来搬迁必须保留原始年份。'],['月潮归航','答应画图后先通知本人，未收到回执不能算完成。']];
const originals=[];
for(const [i,[name,condition]]of anchors.entries()){const text=`请记住：${name}；${condition}准确校准值为${47+i}.625毫克，仅低于18度并且方案C时有效。`;originals.push(r.ingest({scope,text,source_id:'important:'+i,command_id:'important:'+i,occurred_at:start+i*300*day,provenance:{speaker_id:'scale-user'},process:true}));}
const sources=[];for(let i=0;i<count;i++){const d=Math.floor(i/perDay),slot=i%perDay;sources.push({id:'daily:'+i,chat_id:context.scope,speaker_id:'scale-user',role:'user',sequence:i+100,text:`第${d}天第${slot}次合成交流。记录读书、日常天气和不同事务的细节，编号${i}。这些普通记录不包含重要约定的校准数字。`,occurred_at:start+d*day+slot*60000,time_precision:'instant',provenance:{system:'synthetic-scale'}});if(i&&i%100000===0)console.log('Prepared '+i+' daily records');}
r.importPartitions([{context,sources,memories:[],relations:[]}]);console.log('Loaded '+count+' records; building derived retrieval index');
let index;do{index=r.store.rebuildSearchIndex(5000);}while(index.pending>0);
const results=[];for(const [i,[name]]of anchors.entries()){const q=name+'约定的校准条件',times=[];for(let j=0;j<3;j++){const begin=performance.now(),result=r.query({scope,query:q,actual_tokens:1536});times.push(performance.now()-begin);assert.ok(result.context.some(c=>c.text.includes(`${47+i}.625`)));}assert.equal(r.store.getSource(originals[i].source_id).text,r.body(r.memory(originals[i].memory_id)));results.push({name,query:q,query_ms:times,source_preserved:true});}
const stats=r.store.stats();r.close();r=new V5Runtime({file,clock:()=>at+4*day});
for(const [i]of anchors.entries()){const source=r.store.getSource(originals[i].source_id);assert.ok(source?.text.includes(`${47+i}.625`));assert.equal(r.memory(originals[i].memory_id).protection,'P0');}
const oldFile=path.join(folder,'previous.sqlite'),reader=new DatabaseSync(file,{readOnly:true});await backup(reader,oldFile);reader.close();
const {V5Runtime:Previous}=await import(pathToFileURL(path.join(root,'runtime-data/upgrade-0.4.0/baseline-engine/core/v5-runtime.js')).href),old=new Previous({file:oldFile,clock:()=>at+4*day}),previous=[];
for(const {query}of results){const begin=performance.now(),answer=old.query({scope,query,actual_tokens:1536});previous.push({query,query_ms:performance.now()-begin,hit:answer.context.length>0});}
old.close();r.close();
const report={passed:true,synthetic:true,equivalent_days:days,daily_messages:perDay,daily_records:count,important_originals:originals.length,restart_byte_preservation:true,stats,queries:results,previous_queries:previous,elapsed_ms:performance.now()-started,peak_rss_mib:process.resourceUsage().maxRSS/1024,limitations:['Historical records are loaded in a batch with daily timestamps; this is not three years of actual running or per-turn ingestion throughput.','Precise important-event recall and source fidelity are measured; broad semantic understanding at this full scale is not measured.','No QQ messages, remote model calls or production database writes.']};
fs.writeFileSync(path.join(root,'runtime-data/upgrade-0.4.0/scale-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
