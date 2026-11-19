// Synthetic historical-volume check; reports survive, generated databases do not.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {V5Runtime} from '../core/v5-runtime.js';
import {managedScript,testRuntimeRoot,writeTestResult} from './lib/test-workspace.js';

await managedScript(import.meta.url,async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),folder=path.join(testRuntimeRoot(null),'years');
  fs.mkdirSync(folder);
  const days=Number(process.env.THINKSTAR_SCALE_DAYS??1095),perDay=Number(process.env.THINKSTAR_DAILY_RECORDS??405);
  assert.ok(Number.isSafeInteger(days)&&days>=1&&days<=1095);
  assert.ok(Number.isSafeInteger(perDay)&&perDay>=1&&perDay<=405);
  const count=days*perDay,day=86400000,start=Date.parse('2023-11-17T08:00:00+08:00'),at=start+days*day;
  const context={persona_id:'synthetic-years',scope:'private:scale'},file=path.join(folder,'memory.sqlite');
  const anchors=[['星砾远航','订票前先确认护照，没有实际出票。'],['暮蓝灯塔','旧地址为青杉路，后来搬迁必须保留原始年份。'],['月潮归航','答应画图后先通知本人，未收到回执不能算完成。']];
  let runtime,old,reader;
  try{
    const started=performance.now();runtime=new V5Runtime({file,clock:()=>at});const scope=runtime.addScope(context).id,originals=[];
    for(const [i,[name,condition]]of anchors.entries())originals.push(runtime.ingest({scope,text:`请记住：${name}；${condition}准确校准值为${47+i}.625毫克，仅低于18度并且方案C时有效。`,source_id:'important:'+i,command_id:'important:'+i,occurred_at:start+i*Math.floor(days/3)*day,provenance:{speaker_id:'scale-user'},process:true}));
    const sources=[];
    for(let i=0;i<count;i++){
      const d=Math.floor(i/perDay),slot=i%perDay;
      sources.push({id:'daily:'+i,chat_id:context.scope,speaker_id:'scale-user',role:'user',sequence:i+100,text:`第${d}天第${slot}次合成交流。记录读书、日常天气和不同事务的细节，编号${i}。这些普通记录不包含重要约定的校准数字。`,occurred_at:start+d*day+slot*60000,time_precision:'instant',provenance:{system:'synthetic-scale'}});
      if(i&&i%100000===0)console.log('Prepared '+i+' daily records');
    }
    runtime.importPartitions([{context,sources,memories:[],relations:[]}]);
    let index;do{index=runtime.store.rebuildSearchIndex(5000);}while(index.pending>0);
    const queries=[];
    for(const [i,[name]]of anchors.entries()){
      const query=name+'约定的校准条件',times=[];
      for(let j=0;j<3;j++){const begin=performance.now(),result=runtime.query({scope,query,actual_tokens:1536});times.push(performance.now()-begin);assert.ok(result.context.some(c=>c.text.includes(`${47+i}.625`)));}
      assert.equal(runtime.store.getSource(originals[i].source_id).text,runtime.body(runtime.memory(originals[i].memory_id)));
      queries.push({name,query,query_ms:times,source_preserved:true});
    }
    const stats=runtime.store.stats();runtime.close();runtime=new V5Runtime({file,clock:()=>at+4*day});
    for(const [i]of anchors.entries()){assert.ok(runtime.store.getSource(originals[i].source_id)?.text.includes(`${47+i}.625`));assert.equal(runtime.memory(originals[i].memory_id).protection,'P0');}
    const baselineRoot=process.env.THINKSTAR_BASELINE_ROOT,baseline=baselineRoot?path.resolve(baselineRoot,'core/v5-runtime.js'):null,previous=[];
    if(baseline){
      assert.ok(fs.existsSync(baseline),'Requested baseline code is missing');
      const oldFile=path.join(folder,'previous.sqlite');reader=new DatabaseSync(file,{readOnly:true});await backup(reader,oldFile);reader.close();reader=null;
      const {V5Runtime:Previous}=await import(pathToFileURL(baseline).href);old=new Previous({file:oldFile,clock:()=>at+4*day});
      for(const {query}of queries){const begin=performance.now(),answer=old.query({scope,query,actual_tokens:1536});previous.push({query,query_ms:performance.now()-begin,hit:answer.context.length>0});}
    }
    const report={passed:true,synthetic:true,equivalent_days:days,daily_messages:perDay,daily_records:count,important_originals:originals.length,restart_byte_preservation:true,stats,queries,previous_queries:previous,baseline_comparison:baseline?'performed':'not_requested',elapsed_ms:performance.now()-started,peak_rss_mib:process.resourceUsage().maxRSS/1024,limitations:['Batch synthetic history is not years of continuous operation.','Precise original recall is checked; broad semantic understanding is not measured.','No QQ messages, remote model calls or production database access.']};
    writeTestResult(report);console.log(JSON.stringify(report,null,2));
  }finally{reader?.close();old?.close();runtime?.close();}
});
