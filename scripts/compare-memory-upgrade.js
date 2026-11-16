// Isolated comparison. Production databases and QQ transports are never opened here.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {V5Runtime} from '../core/v5-runtime.js';
import {ContextCoordinator} from '../adapters/aurabot/module/lib/context-coordinator.js';
import {consoleLayout} from '../core/v5-console.js';

const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'runtime-data/upgrade-0.4.0');fs.mkdirSync(out,{recursive:true});
const {V5Runtime:Previous}=await import(pathToFileURL(path.join(out,'baseline-engine/core/v5-runtime.js')).href);
const {createBaseline}=await import(pathToFileURL(path.join(root,'runtime-data/evaluations/capabilities-2026-11-15/native-adapter.mjs')).href);
const hostRoot='D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq';
const {createEmbedder}=await import(pathToFileURL(hostRoot+'/src/features/vector-embed.js').href);
const embedder=createEmbedder(hostRoot+'/models');if(embedder.probe())throw Error('Local BGE is unavailable');
const context={persona_id:'synthetic-comparison',scope:'private:10001'},chat={chatId:context.scope,userId:'10001',kind:'private'};
const native=createBaseline(path.join(out,'native-isolated'),{recallCount:6}).memory,old=new Previous(),current=new V5Runtime();
const so=old.addScope(context).id,sn=current.addScope(context).id;
current.semantic.configure({model:'bge-small-zh-v1.5-int8',embed:text=>embedder.embed(text)});
const sources=[
  '项目：琉璃；'+('这是一段普通的过程背景，没有改变关键条件。'.repeat(20))+'请记住：校准值47.625毫克，仅低于18度并且方案C时有效；还没有实际提交。',
  '项目：飞鲸；最初计划用A。后来明确改成B，尚未执行。',
  '当我疲惫时，以后请简短陪伴，发一只蓝色小螃蟹🦀，不要连续追问。',
  '请记住：度假最想前往冰岛阿克雷里欣赏夜空的光带；先查机票，尚未订票。',
  '请记住：猫的小名叫好基米。',
  ...Array.from({length:80},(_,i)=>`普通合成闲谈编号${i}，今天看见一些云，随手记录天气。`),
];
for(const [i,text]of sources.entries()){
  native.add({text,about:'10001',importance:text.includes('请记住')?.9:.4,source:'chat',chatId:chat.chatId});
  for(const [r,scope]of [[old,so],[current,sn]])r.ingest({scope,text,command_id:'seed:'+i,source_id:'seed:'+i,provenance:{speaker_id:'10001'},process:true});
}
const indexed=await current.semantic.sync({scope:sn,force:true,limit:200});current.store.rebuildSearchIndex(1000);
const cases=[
  {id:'detail',question:'琉璃校准值、温度条件、采用方案和提交状态分别是什么？',expected:[['47.625毫克','47.625 毫克'],['低于18','低于 18','18度以下'],['方案C','方案 C'],['未提交','没有提交','没有实际提交','尚未提交','尚未实际提交']]},
  {id:'correction',question:'飞鲸项目最后选择哪一方案？是否已经执行？',expected:[['B'],['未执行','没有执行','尚未执行']]},
  {id:'fatigue',question:'我今天很疲惫，不想多说。',expected:[['螃蟹','🦀']],no_followup:true},
  {id:'semantic',question:'筋疲力尽时，你通常怎么接住我？',expected:[['螃蟹','🦀']]},
  {id:'unknown',question:'我没提过的设备序列号是多少？',expected:[],unknown:true},
];
const report={version:'0.4.0',at:new Date().toISOString(),synthetic:true,qq_sends:0,model_calls:0,local_embedding:true,embedding_model:current.semantic.model,indexed,settings:[],cases:[],functions:{console_groups:consoleLayout(current).groups.map(g=>({name:g.name,count:g.regions.length})),background_policy:'inherited pause; overnight batch indexing',storage_schema:2}};
const tuning=['筋疲力尽的时候适合哪种互动','我心心念念的北欧小城是哪？','没有提过的密码'];
for(const question of tuning){const scores=await current.semantic.search({scope:sn,query:question,limit:6,minScore:.3});report.settings.push({question,scores:scores.map(s=>({score:s.score,label:current.memory(s.id).label}))});}
// The threshold is tuned on development examples; comparisons retain the parameter record.
current.updateConfig({region:'W2',values:{vector_min_score:.52,recall_items:6},expected_version:current.configVersion});
report.effective_config=current.getConfig();
const perf=[];
for(const [i,row]of cases.entries()){
  const sid='upgrade:'+row.id,nativeText=[native.contextFor(chat,sid),await native.recallHintAsync(chat,row.question,'',sid,['10001'],[])].filter(Boolean).join('\n');
  const oldAt=performance.now(),oldResult=old.query({scope:so,query:row.question,actual_tokens:1536}),oldMs=performance.now()-oldAt;
  const vectorAt=performance.now(),hits=/\d{3,}/.test(row.question)?[]:await current.semantic.search({scope:sn,query:row.question,limit:12,minScore:current.config.W2.vector_min_score}),vectorMs=performance.now()-vectorAt;
  const at=performance.now(),result=current.query({scope:sn,query:row.question,actual_tokens:1536,semantic_ids:hits.map(x=>x.id)}),strategy=current.dialogue.strategy(sn,row.question),coordinator=new ContextCoordinator({isOwner:()=>true},{runtime:current,allowedChat:()=>true,persona:()=>context.persona_id});
  const own=coordinator.combine(structuredClone(result),[],{chatId:chat.chatId,sessionId:sid,query:row.question,available:1536-Math.ceil(strategy.text.length/2)}).text+'\n'+strategy.text,newMs=performance.now()-at;
  coordinator.observe('recallHintAsync',[chat,row.question,'',sid],nativeText);
  const combined=coordinator.combine(structuredClone(result),nativeText?[{type:'text',text:nativeText}]:[],{chatId:chat.chatId,sessionId:sid,query:row.question,available:1536-Math.ceil(strategy.text.length/2)});
  report.cases.push({...row,arms:{native:nativeText,previous:oldResult.context.map(x=>x.text).join('\n'),thinkstar:own.trim(),combined:[combined.text,strategy.text,...combined.content.map(x=>x.text)].filter(Boolean).join('\n')},retrieval:{old_ids:oldResult.context.map(x=>x.id),new_ids:result.context.map(x=>x.id),semantic:hits,old_ms:oldMs,new_ms:newMs,vector_ms:vectorMs}});perf.push({id:row.id,old_ms:oldMs,new_ms:newMs,vector_ms:vectorMs});
}
report.performance=perf;fs.writeFileSync(path.join(out,'comparison-materials.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({cases:report.cases.map(c=>({id:c.id,chars:Object.fromEntries(Object.entries(c.arms).map(([k,v])=>[k,v.length])),semantic:c.retrieval.semantic.slice(0,2).map(x=>({score:x.score,label:current.memory(x.id).label}))})),development_scores:report.settings},null,2));
old.close();current.close();
