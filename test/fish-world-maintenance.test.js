import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {newLife,defaults} from '../extensions/aurabot/fish-world/state.mjs';
import {FishBridge} from '../extensions/aurabot/fish-world/bridge.mjs';
import {installMaintenance} from '../extensions/aurabot/fish-world/maintenance.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),copy=value=>structuredClone(value);
const now=Date.parse('2026-11-21T22:00:00+08:00'),timing={workMs:600000,planRecheckMinMs:600000,socialMs:600000,idleMs:1800000};
function fixture(){
 const root=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'maintenance-')),folder=path.join(root,'fish-world');fs.mkdirSync(folder);
 const l=newLife(now);Object.assign(l,{owner:'synthetic-owner',persona:'synthetic',controls:{autonomy:false},days:{'2026-11-21':{work:96,idle:150,social:12,share:0,spend:8,calls:331}},contextWindow:{windows:[{sessionId:'owned'}]}});
 const sources=[],originals=[],decisions=[];
 for(const [i,id]of ['old-a','old-b'].entries()){
  const p={id,goal:'旧午间做饭',reason:'合成约定',nextStep:'11:30做饭',progress:'等待',trigger:'done',status:'pending',nextAt:Date.parse('2026-11-21T11:30:00+08:00')};
  const event={type:'tool/call',seq:i,time:now-1000+i,data:{callId:'call-'+i,name:'fish_life_finish',arguments:JSON.stringify({plans:[p]})}};sources.push(event);
  const original={...p,revision:1,updatedAt:event.time+1};l.plans.push({...copy(original),status:'needs_review',migrationOriginal:copy(original),sourceEventIds:[],sourceEvidenceIds:[],mergedFrom:[],supersedes:[]});
  originals.push({id,expectedRevision:1,currentStatus:'needs_review',migrationOriginal:original,originalSubmittedBusinessAt:p.nextAt,selectedOrigin:{sessionId:'owned',seq:i,time:event.time,callId:event.data.callId,sourcePlan:p}});
 }
 const group={id:'group',canonicalId:'old-a',memberIds:['old-a','old-b'],count:2,disposition:{category:'needs_owner_decision',recommendation:'keep-needs-review'}};
 decisions.push({id:'old-a',groupId:'group',expectedRevision:1,category:'needs_owner_decision',recommendation:'keep-needs-review',evidenceIds:[]},{id:'old-b',groupId:'group',expectedRevision:1,category:'reliable_duplicate',recommendation:'merge',canonicalId:'old-a',evidenceIds:[]});
 const report={protocol:'fish-world-private-history-review/v1',synthetic:true,readOnly:true,applied:false,source:{identity:{fishId:'synthetic-fish',owner:l.owner,persona:l.persona}},summary:{reviewed:2},originals,decisions,canonicalGroups:[group],duplicateGroups:[group],evidence:[],existingValidNewPlans:[],eventRecommendations:[],remainingOwnerReview:[{topics:['旧午间安排','旧回家安排']}]};
 const file=path.join(folder,'runtime.json');fs.writeFileSync(file,JSON.stringify({version:3,fishId:'synthetic-fish',recent:[],at:{},errors:{},life:l},null,2)+'\n');
 const bridge=new FishBridge({file,credential:()=>''});bridge.save();const cfgFile=path.join(root,'config.json');
 let config={global:{unchanged:'sentinel'},ext:{'fish-world':{workMs:300000,planRecheckMinMs:300000,socialMs:300000,idleMs:1200000,idleLimit:100,dailySpend:300,stocks:true,sharing:false,idleWorkHours:'07:00-09:00'}}},failure=false;
 fs.writeFileSync(cfgFile,JSON.stringify(config));
 const settings=()=>({...defaults,...config.ext['fish-world']}),engine={bridge,closed:false,get l(){return bridge.data.life;},get cfg(){return {...settings(),...this.l.controls};},change:fn=>bridge.change(d=>fn(d.life,d))};
 const routes=new Map();let saves=0;const api={dataDir:(...parts)=>path.join(folder,...parts),dsh:{get:()=>({readSession:async id=>{assert.equal(id,'owned');return {events:sources};}})},settings,saveSettings(patch){saves++;config={...config,ext:{...config.ext,'fish-world':{...config.ext['fish-world'],...patch}}};fs.writeFileSync(cfgFile,JSON.stringify(config));if(failure){failure=false;throw Error('synthetic settings interruption');}},core:{http:{body:async req=>req.body}},route:(route,fn,options)=>{assert.equal(options.access,'panel');routes.set(route,fn);}};
 installMaintenance(api,()=>engine,()=>true);
 const input={report,timing,pairs:[],ownerDecision:'keep-grouped'},raw=Buffer.from(JSON.stringify(input)),inputId=sha(raw);fs.mkdirSync(path.join(folder,'maintenance-inputs'));fs.writeFileSync(path.join(folder,'maintenance-inputs',inputId+'.json'),raw);
 return {engine,bridge,folder,file,cfgFile,inputId,call:body=>routes.get('/maintenance')({method:'POST',body}),get saves(){return saves;},get config(){return config;},fail(){failure=true;}};
}
test('maintenance dry run leaves live ledger/settings unchanged; apply retains originals and only four own settings',async()=>{
 const f=fixture(),before=fs.readFileSync(f.file),cfg=fs.readFileSync(f.cfgFile),days=copy(f.engine.l.days);
 const p=await f.call({mode:'prepare',inputId:f.inputId});assert.equal(p.summary.merged,1);assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readFileSync(f.cfgFile),cfg);
 const r=await f.call({mode:'apply',operationId:p.operationId});assert.equal(r.status,'applied');assert.equal(f.engine.l.plans[1].status,'merged');assert.equal(f.engine.l.historyReviewBatch.planIds.length,1);assert.deepEqual(f.engine.l.days,days);
 assert.ok(f.engine.l.planHistory.some(h=>h.id==='old-b'&&h.before.migrationOriginal));assert.equal(f.config.global.unchanged,'sentinel');
 for(const key of ['idleLimit','dailySpend','stocks','sharing','idleWorkHours'])assert.equal(f.config.ext['fish-world'][key],JSON.parse(cfg).ext['fish-world'][key]);
 assert.deepEqual(Object.fromEntries(Object.keys(timing).map(k=>[k,f.config.ext['fish-world'][k]])),timing);
 const receipt=JSON.parse(fs.readFileSync(r.receiptPath));assert.deepEqual(fs.readFileSync(receipt.backupPath),before);assert.equal(receipt.worldMutations,0);
 const done=fs.readFileSync(f.file);assert.equal((await f.call({mode:'apply',operationId:p.operationId})).repeated,true);assert.deepEqual(fs.readFileSync(f.file),done);assert.equal(f.saves,1);
});
test('changed targets fail before settings or live ledger changes',async()=>{
 const f=fixture(),p=await f.call({mode:'prepare',inputId:f.inputId});
 f.bridge.change(d=>{d.life.plans[0].revision++;});const before=fs.readFileSync(f.file);
 await assert.rejects(()=>f.call({mode:'apply',operationId:p.operationId}),/冲突|变化/);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.saves,0);
});
test('settings interruption retains original backup and retries safely despite harmless cache metadata changes',async()=>{
 const f=fixture(),p=await f.call({mode:'prepare',inputId:f.inputId}),before=fs.readFileSync(f.file);f.fail();
 await assert.rejects(()=>f.call({mode:'apply',operationId:p.operationId}),/interruption/);assert.equal(f.engine.l.plans[1].status,'needs_review');assert.equal(f.engine.maintenanceBusy,false);
 f.bridge.change(d=>{d.at.state=now+1;});
 const again=await f.call({mode:'prepare',inputId:f.inputId});assert.equal(again.reused,true);
 const applied=await f.call({mode:'apply',operationId:p.operationId}),receipt=JSON.parse(fs.readFileSync(applied.receiptPath));
 assert.deepEqual(fs.readFileSync(receipt.backupPath),before);assert.ok(receipt.attemptBackupPath!==receipt.backupPath);assert.equal(f.engine.l.plans[1].status,'merged');
});
test('active or unpaused automatic work cannot be bypassed by maintenance',async()=>{
 const f=fixture();f.engine.l.controls.autonomy=true;
 await assert.rejects(()=>f.call({mode:'prepare',inputId:f.inputId}),/暂停/);f.engine.l.controls.autonomy=false;f.engine.l.round={id:'active'};
 await assert.rejects(()=>f.call({mode:'prepare',inputId:f.inputId}),/完全结束/);
});
