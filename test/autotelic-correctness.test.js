import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AUTOTELIC_CORRECTNESS_PATCH,patchAutotelicCorrectness,AUTOTELIC_REPORT_LABELS_PATCH,patchAutotelicReportLabels} from '../scripts/lib/autotelic-correctness-patch.js';

const host=process.env.AURABOT_SOURCE;
const file=host&&path.join(host,AUTOTELIC_CORRECTNESS_PATCH.file);
const available=!!file&&fs.existsSync(file),active={skip:!available};
const scratch=process.env.THINKSTAR_TEST_TMP;
const source=available?fs.readFileSync(process.env.AURABOT_AUTOTELIC_BASELINE||file,'utf8'):'';
const reflectFile=host&&path.join(host,AUTOTELIC_REPORT_LABELS_PATCH.file);
const reflectSource=available?fs.readFileSync(process.env.AURABOT_AUTOTELIC_REFLECT_BASELINE||reflectFile,'utf8'):'';
let originalRuntime,patchedRuntime,originalReport,patchedReport;
if(available){
  assert.ok(scratch,'Run through scripts/run-tests.js');
  const dir=fs.mkdtempSync(path.join(scratch,'autotelic-runtime-'));
  const rewrite=(text,base,reflect)=>text.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,(match,quote,spec)=>'from '+quote+(reflect&&spec==='./reflect.js'?pathToFileURL(reflect).href:new URL(spec,pathToFileURL(base)).href)+quote);
  for(const [name,text] of [['original',reflectSource],['patched',patchAutotelicReportLabels(reflectSource,{version:AUTOTELIC_REPORT_LABELS_PATCH.version}).source]]){
    const output=path.join(dir,name+'-reflect.mjs');fs.writeFileSync(output,rewrite(text,reflectFile));
    const imported=await import(pathToFileURL(output).href);
    if(name==='original')originalReport=imported;else patchedReport=imported;
  }
  for(const [name,text] of [['original',source],['patched',patchAutotelicCorrectness(source,{version:AUTOTELIC_CORRECTNESS_PATCH.version}).source]]){
    const rewritten=rewrite(text,file,path.join(dir,name+'-reflect.mjs'));
    const output=path.join(dir,name+'.mjs');fs.writeFileSync(output,rewritten);
    const imported=await import(pathToFileURL(output).href);
    if(name==='original')originalRuntime=imported.createRuntime;else patchedRuntime=imported.createRuntime;
  }
}

const at=new Date(2026,10,24,12,0,0,0).getTime();
const oldAt=new Date(2026,10,23,23,59,59,999).getTime();
const todayAt=new Date(2026,10,24,0,0,0,0).getTime();
const task=(id,updatedAt,status='done')=>({id,title:'synthetic-'+id,reason:'synthetic',status,steps:[],createdAt:updatedAt,updatedAt});
function fixture({original=false,tasks=[],auditStat=async()=>({today:17}),settings={},act=null}={}){
  const dir=fs.mkdtempSync(path.join(scratch,'autotelic-data-')),ledgerFile=path.join(dir,'ledger.json');
  fs.writeFileSync(ledgerFile,JSON.stringify({tasks,actions:[],ticks:[],screenVetoes:[]}));
  let clock=at;
  const opts={enabled:true,allowAct:false,maxTasksActive:8,maxSteps:8,budgetActionsPerHour:1,minCuriosity:0,
    maxCandidates:3,evalModel:'',dailyReviewHour:-1,minBatchForReview:3,dreamFrom:'',dreamTo:'',workHours:'',...settings};
  const pages=new Map(),calls=[],notes=[],memories=[];
  const journal={exists:(kind,day)=>pages.has(kind+'/'+day),write:(kind,day,text)=>pages.set(kind+'/'+day,text)};
  const hub={chatLogDays:()=>['synthetic-day'],chatLogOf:()=>[{chatId:'private:10000001',who:'owner',uid:'10000001',t:at,text:'请比较三种合成材料的制备方法并核实可靠的资料来源'}]};
  const runtime=(original?originalRuntime:patchedRuntime)({settings:()=>opts,cfg:{ownerQQ:'10000001'},hub,
    ledgerFile,now:()=>clock,journal,act,auditStat,auditNote:entry=>notes.push(entry),
    memoryOf:()=>({list:()=>[],addEvent:entry=>{memories.push(entry);return{id:'synthetic-memory'};}}),
    screenTurn:async()=>{calls.push('screen');return '[{"i":1,"worth":true,"why":"synthetic"}]';},
    evalTurn:async(prompt,options)=>{calls.push(options?.key||'eval');return '[{"i":1,"curiosity":0.9}]';}});
  return {runtime,pages,calls,notes,memories,settings:opts,setTime:value=>{clock=value;}};
}
const page=(f,kind='daily')=>[...f.pages].find(([key])=>key.startsWith(kind+'/'))?.[1]||'';

test('autotelic repair rejects unknown versions, non-text and unreviewed hashes',()=>{
  assert.throws(()=>patchAutotelicCorrectness('synthetic',{version:'1.3.1'}),/version/);
  assert.throws(()=>patchAutotelicCorrectness(null,{version:AUTOTELIC_CORRECTNESS_PATCH.version}),/UTF-8/);
  assert.throws(()=>patchAutotelicCorrectness('synthetic',{version:AUTOTELIC_CORRECTNESS_PATCH.version}),/hash/);
  assert.throws(()=>patchAutotelicReportLabels('synthetic',{version:'1.3.1'}),/version/);
  assert.throws(()=>patchAutotelicReportLabels(null,{version:AUTOTELIC_REPORT_LABELS_PATCH.version}),/UTF-8/);
  assert.throws(()=>patchAutotelicReportLabels('synthetic',{version:AUTOTELIC_REPORT_LABELS_PATCH.version}),/hash/);
});

test('report label transformation is exact, idempotent and refuses altered original or patched code',active,()=>{
  const first=patchAutotelicReportLabels(reflectSource,{version:AUTOTELIC_REPORT_LABELS_PATCH.version});
  assert.equal(first.receipt.unchanged,false);assert.equal(first.receipt.input_sha256,AUTOTELIC_REPORT_LABELS_PATCH.before_sha256);
  const second=patchAutotelicReportLabels(first.source,{version:AUTOTELIC_REPORT_LABELS_PATCH.version});
  assert.equal(second.receipt.unchanged,true);assert.equal(second.source,first.source);
  for(const changed of [reflectSource+'\n',first.source+'\n'])assert.throws(()=>patchAutotelicReportLabels(changed,{version:AUTOTELIC_REPORT_LABELS_PATCH.version}),/hash/);
});

test('daily report labels audit records accurately without changing report contents, schedule or dream behavior',active,()=>{
  const input={date:'2026-11-24',tasks:[task('label-proof',at)],actionsToday:309,hushText:'synthetic hush'};
  const before=originalReport.buildDailyPage(input),after=patchedReport.buildDailyPage(input);
  assert.equal(after,before.replace('全天动作 309 次（机械计数；夜里消耗也在这行里，单列记数，不需要解释）','全天审计记录 309 条（含调用、结果和运行记录，不等于成功动作数）'));
  assert.match(after,/全天审计记录 309 条/);assert.doesNotMatch(after,/全天动作 309 次/);
  const dream={tasks:input.tasks,auditToday:309,modelText:''};
  assert.deepEqual(patchedReport.distillDream(dream),originalReport.distillDream(dream));
  assert.deepEqual(patchedReport.reviewDue({settings:{dailyReviewHour:12},at}),originalReport.reviewDue({settings:{dailyReviewHour:12},at}));
});

test('exact host transformation is idempotent and rejects changed original or patched bytes',active,()=>{
  const first=patchAutotelicCorrectness(source,{version:AUTOTELIC_CORRECTNESS_PATCH.version});
  assert.equal(first.receipt.unchanged,false);
  assert.equal(first.receipt.input_sha256,AUTOTELIC_CORRECTNESS_PATCH.before_sha256);
  const second=patchAutotelicCorrectness(first.source,{version:AUTOTELIC_CORRECTNESS_PATCH.version});
  assert.equal(second.receipt.unchanged,true);assert.equal(second.source,first.source);
  for(const changed of [source+'\n',first.source+'\n'])assert.throws(()=>patchAutotelicCorrectness(changed,{version:AUTOTELIC_CORRECTNESS_PATCH.version}),/hash/);
});

test('unpatched runtime reproduces async audit zero and old tasks in today daily page',active,async()=>{
  const f=fixture({original:true,tasks:[task('old',oldAt),task('current',todayAt)],settings:{dailyReviewHour:12}});
  await f.runtime.review();
  assert.match(page(f),/全天动作 0 次/);assert.match(page(f),/synthetic-old/);
});

for(const asyncStat of [false,true])test(`daily page and dreams read ${asyncStat?'asynchronous':'synchronous'} audit counts`,active,async()=>{
  const f=fixture({auditStat:asyncStat?async()=>({today:17}):()=>({today:17}),
    settings:{dailyReviewHour:12,dreamFrom:'11:00',dreamTo:'13:00'}});
  await f.runtime.review();
  assert.match(page(f),/全天审计记录 17 条（含调用、结果和运行记录，不等于成功动作数）/);assert.doesNotMatch(page(f),/全天动作 17 次/);assert.match(page(f,'dreams'),/今天账上记了 17 条/);
  assert.ok(f.memories.some(entry=>/今天账上记了 17 条/.test(entry.text)));
});

test('missing, throwing or rejecting audit readers retain the existing zero fallback',active,async()=>{
  for(const auditStat of [null,()=>{throw Error('synthetic-sync');},async()=>{throw Error('synthetic-async');}]){
    const f=fixture({auditStat,settings:{dailyReviewHour:12}});
    await f.runtime.review();assert.match(page(f),/全天审计记录 0 条/);
  }
});

test('daily page uses current-day task updates without removing history or active work',active,async()=>{
  const tasks=[task('yesterday',oldAt),task('midnight',todayAt),task('today',at),task('unfinished',at,'active')];
  const f=fixture({tasks,settings:{dailyReviewHour:12}});
  await f.runtime.review();
  assert.doesNotMatch(page(f),/synthetic-yesterday|synthetic-unfinished/);
  assert.match(page(f),/synthetic-midnight/);assert.match(page(f),/synthetic-today/);
  assert.equal(f.runtime.book().list().length,4,'report filtering does not delete ledger history');
  assert.equal(f.runtime.book().list().find(item=>item.id==='unfinished').status,'active');
  assert.equal(f.notes.find(item=>item.kind==='autotelic/daily').args.tasks,3);
  assert.deepEqual(await f.runtime.review(),{},'existing once-per-day journal guard remains effective');
});

test('unpatched exhausted budget still calls the candidate model and screen before rejecting',active,async()=>{
  const f=fixture({original:true,settings:{evalModel:'synthetic/model'}});
  f.runtime.book().recordAction();assert.ok(f.runtime.preview().candidates.length);
  const result=await f.runtime.tick();
  assert.equal(result.outcome,'skipped-budget');assert.deepEqual(f.calls,['eval','screen']);
});

test('exhausted budget skips candidate models for automatic and manual ticks then resumes after rolling hour',active,async()=>{
  const f=fixture({settings:{evalModel:'synthetic/model'}});
  f.runtime.book().recordAction();assert.ok(f.runtime.preview().candidates.length);
  for(const manual of [false,true]){
    assert.equal((await f.runtime.tick({manual})).outcome,'skipped-budget');
    assert.equal(f.runtime.book().meta().lastTick.outcome,'skipped-budget');
    assert.deepEqual(f.calls,[]);assert.equal(f.runtime.book().list().length,0);
  }
  f.setTime(at+3600_001);
  const result=await f.runtime.tick();assert.equal(result.outcome,'proposed');
  assert.deepEqual(f.calls,['eval','screen']);assert.equal(f.runtime.book().list().length,1);
});

test('budget gate keeps scheduled daily review and already-active task progression',active,async()=>{
  const f=fixture({settings:{allowAct:true,dailyReviewHour:12},act:{runStep:async()=>({ok:true,observation:'synthetic completed',hadTools:false})}});
  const added=f.runtime.book().addTask({title:'synthetic-existing',reason:'synthetic',todos:[{desc:'synthetic step',level:'L0'}]});
  assert.equal(added.ok,true);f.runtime.book().recordAction();
  const result=await f.runtime.tick();
  assert.equal(result.outcome,'skipped-budget');assert.equal(result.acted.outcome,'step-done');
  assert.equal(f.runtime.book().list()[0].status,'done');assert.ok(page(f));assert.deepEqual(f.calls,[]);
});

test('disabled and outside-work-hours guards remain effective without model or journal calls',active,async()=>{
  const f=fixture({settings:{enabled:false,dailyReviewHour:12}});
  assert.equal((await f.runtime.tick()).outcome,'disabled');assert.deepEqual(f.calls,[]);assert.equal(f.pages.size,0);
  f.settings.enabled=true;f.settings.workHours='01:00-02:00';
  // Work-hours use Beijing time, independent of the host timezone.
  f.setTime(Date.UTC(2026,10,24,4,0));
  assert.equal((await f.runtime.tick()).outcome,'outside-work-hours');assert.deepEqual(f.calls,[]);assert.equal(f.pages.size,0);
});
