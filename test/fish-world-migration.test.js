import {FishBridge} from '../extensions/aurabot/fish-world/bridge.mjs';
import {migrationGate,stableAgentIdle,ownSession} from '../extensions/aurabot/fish-world/host-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import {MIGRATION_VERSION,WITNESS_PROTOCOL,migrationRequired,migrateLedger,inspectLegacyLedger,validateMigrationWitness,applyMigration,rollbackMigration,sha256,readAppliedMigrationReceipt} from '../extensions/aurabot/fish-world/migration.mjs';

const now=Date.parse('2026-11-21T12:00:00+08:00'),clock=()=>now;
const plan=(id,patch={})=>({id,goal:'晚饭',reason:'生活安排',nextStep:'下米',status:'pending',nextAt:now-60000,progress:'等待',revision:7,...patch});
const explicit=(id,patch={})=>plan(id,{topic:'晚饭',subject:'fixture-fish',stage:'before-dinner',windowStart:now-43200000,windowEnd:now+43200000,ownerInstructionRevision:9,...patch});
function legacy(patch={}){
  return {version:2,keyId:'synthetic-key-hash',fishId:'fixture-fish',cursor:'fixture-cursor',state:{where:{kind:'home'},doing:{name:'上班'}},
    life:{version:1,owner:'fixture-owner',persona:'fixture-persona',revision:9,controls:{idleLimit:150,sharing:false},
      days:{'2026-11-21':{work:96,idle:150,social:3,share:2,spend:43,calls:108}},
      plans:[plan('a')],queue:[{id:'ordinary-event',kind:'done',status:'pending',bucket:'work',text:'生活事件'}],
      journal:[{id:'uncertain-action',status:'uncertain',tool:'mcp__fish-world__world_do',args:'{"id":"eat"}',receipt:{request_id:'fixture-request'}}],
      outbox:[],cooldowns:{peer:now+60000},contextWindow:{key:'fixture-window',windows:[{sessionId:'fixture-session'}]},
      round:null,recovery:false,...patch}};
}
function fixture(value=legacy()){
  const scratch=testRuntimeRoot(null);assert.ok(scratch,'Use node scripts/run-tests.js fish-world-migration.test.js');
  const parent=fs.mkdtempSync(path.join(scratch,'migration-')),root=path.join(parent,'fish-world');fs.mkdirSync(root);
  const runtimePath=path.join(root,'runtime.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(runtimePath,bytes);
  return {parent,root,runtimePath,bytes,raw:value,hash:sha256(bytes)};
}
function witness(f,patch={}){
  return {protocol:WITNESS_PROTOCOL,runtimePath:f.runtimePath,runtimeSha256:sha256(fs.readFileSync(f.runtimePath)),capturedAt:now,expiresAt:now+20000,
    oldWriterStopped:true,agentsIdle:true,toolsIdle:true,outboundIdle:true,
    readOnlyGate:{active:true,version:'1.3.0',generation:2},
    writerProof:{kind:'module-lifecycle-quiescence',oldModuleDetached:true,stableSince:now-16000,stableThrough:now,runtimeSha256:sha256(fs.readFileSync(f.runtimePath))},...patch};
}
const apply=f=>applyMigration({runtimePath:f.runtimePath,witness:witness(f),clock,synthetic:true});

test('500 ambiguous historical plans preserve originals and become one local review batch without quota reset',()=>{
  const raw=legacy({plans:Array.from({length:500},(_,i)=>plan('legacy-'+i))}),before=JSON.stringify(raw);
  const {ledger,report}=migrateLedger(raw,{now,synthetic:true});
  assert.equal(JSON.stringify(raw),before);assert.equal(ledger.version,3);assert.equal(ledger.life.version,2);
  assert.equal(ledger.life.plans.length,500);assert.equal(report.ambiguities.length,500);assert.equal(report.proposedGroups.length,0);
  assert.ok(ledger.life.plans.every(p=>p.status==='needs_review'&&p.budgetBucket==='idle'));
  for(let i=0;i<500;i++)assert.deepEqual(ledger.life.plans[i].migrationOriginal,raw.life.plans[i]);
  for(const key of ['days','controls','queue','journal','cooldowns','contextWindow'])assert.deepEqual(ledger.life[key],raw.life[key]);
  assert.equal(ledger.life.costs.historicalDay,'2026-11-21');assert.equal(report.synthetic,true);
});
test('only identical explicit identity and state are merged; all original IDs and records remain recoverable',()=>{
  const raw=legacy({plans:[explicit('a'),explicit('b'),explicit('c')]}),{ledger,report}=migrateLedger(raw,{now});
  assert.equal(ledger.life.plans.length,3);assert.equal(ledger.life.plans[0].status,'pending');
  assert.deepEqual(ledger.life.plans.slice(1).map(p=>p.status),['merged','merged']);
  assert.deepEqual(ledger.life.plans[0].mergedFrom,['b','c']);assert.equal(report.proposedGroups.length,1);
  assert.deepEqual(report.planMapping.map(m=>m.canonicalId),['a','a','a']);
  assert.deepEqual(ledger.life.plans.map(p=>p.migrationOriginal),raw.life.plans);
});
test('different objects, stages and business windows do not merge; conflict and missing evidence never become completed',()=>{
  const raw=legacy({plans:[explicit('a'),explicit('b',{subject:'other-fish'}),explicit('c',{stage:'after-dinner'}),explicit('d',{windowStart:now+43200000,windowEnd:now+129600000}),explicit('e',{status:'completed'}),plan('f',{status:'expired'}),plan('g',{status:'active'})]});
  const {ledger,report}=migrateLedger(raw,{now});assert.equal(report.proposedGroups.length,0);
  assert.equal(ledger.life.plans.find(p=>p.id==='a').status,'needs_review');
  assert.equal(ledger.life.plans.find(p=>p.id==='e').status,'completed');assert.equal(ledger.life.plans.find(p=>p.id==='f').status,'expired');
  assert.equal(ledger.life.plans.find(p=>p.id==='g').status,'needs_review');
});
test('duplicate or missing old IDs receive a complete index mapping without dropping records or trusting a model work bucket',()=>{
  const raw=legacy({plans:[plan('same',{budgetBucket:'work'}),plan('same'),plan(null)]}),{ledger,report}=migrateLedger(raw,{now});
  assert.equal(new Set(ledger.life.plans.map(p=>p.id)).size,3);assert.equal(report.planMapping.length,3);
  assert.ok(ledger.life.plans.every(p=>p.budgetBucket==='idle'));assert.equal(ledger.life.plans[0].migrationOriginal.budgetBucket,'work');
});
test('quota notices are removed from delivery eligibility while every original state and QQ receipt is preserved',()=>{
  const outbox=['pending','queued','sent','uncertain'].map((state,i)=>({id:'notice-'+i,at:now,facts:['budget-idle'],state,owner:'fixture-owner',persona:'fixture-persona',receipt:{message_id:'fixture-'+i},text:'今日额度已用完'}));
  outbox.push({id:'share',state:'pending',facts:['real-evidence'],text:'普通分享'});
  const {ledger,report}=migrateLedger(legacy({outbox}),{now});
  assert.equal(ledger.life.alerts.length,1);assert.equal(ledger.life.alerts[0].repeatCount,4);assert.equal(ledger.life.alerts[0].deliveryEvidence.length,4);
  for(let i=0;i<4;i++){assert.equal(ledger.life.outbox[i].state,outbox[i].state);assert.deepEqual(ledger.life.outbox[i].receipt,outbox[i].receipt);assert.equal(ledger.life.outbox[i].noticeOnly,true);}
  assert.deepEqual(ledger.life.outbox[4],outbox[4]);assert.equal(report.alertMapping.length,4);
});
test('migration keeps an unfinished round and unknown actions and marks recovery without refunding reservations',()=>{
  const round={id:'old-round',status:'uncertain',sessionId:'fixture-session',receipts:[{id:'real-result',text:'fixture',request_id:'fixture-request'}]};
  const raw=legacy({round,scheduler:{lastStartedAt:now-1000,reservations:[{roundId:'old-round',status:'uncertain'}]}}),{ledger}=migrateLedger(raw,{now});
  assert.deepEqual(ledger.life.round,round);assert.deepEqual(ledger.life.journal,raw.life.journal);
  assert.deepEqual(ledger.life.scheduler.reservations,raw.life.scheduler.reservations);assert.equal(ledger.life.recovery,true);
  assert.deepEqual(ledger.life.days,raw.life.days);assert.equal(ledger.migration.requiresRecovery,true);
});
test('witness needs a fresh explicit writer-stop proof, all idle domains, stable hash and the new version read-only gate',()=>{
  const f=fixture(),w=witness(f);assert.equal(validateMigrationWitness(w,{runtimePath:f.runtimePath,runtimeSha256:f.hash,now}),true);
  for(const patch of [{oldWriterStopped:false},{agentsIdle:false},{toolsIdle:false},{outboundIdle:false},{expiresAt:now},{capturedAt:now-31000},{runtimeSha256:'0'.repeat(64)},{readOnlyGate:{active:false,version:'1.3.0',generation:2}},{writerProof:{...w.writerProof,stableSince:now-14999}}])
    assert.throws(()=>validateMigrationWitness({...w,...patch},{runtimePath:f.runtimePath,runtimeSha256:f.hash,now}));
  assert.equal(fs.readFileSync(f.runtimePath).equals(f.bytes),true);
});
test('atomic application saves exact private backup, hashes, mapping and idempotent receipt; second apply makes no changes',()=>{
  const f=fixture(),receipt=apply(f),bytes=fs.readFileSync(f.runtimePath),raw=JSON.parse(bytes);
  assert.equal(receipt.status,'applied');assert.equal(receipt.synthetic,true);assert.equal(receipt.targetSha256,sha256(bytes));
  assert.equal(fs.readFileSync(receipt.backupPath).equals(f.bytes),true);assert.equal(sha256(fs.readFileSync(receipt.mappingPath)),receipt.mappingSha256);
  assert.equal(raw.migration.version,MIGRATION_VERSION);assert.deepEqual(raw.life.days,f.raw.life.days);assert.equal(migrationRequired(raw),false);
  const again=apply(f);assert.equal(again.repeated,true);assert.equal(fs.readFileSync(f.runtimePath).equals(bytes),true);
  assert.equal(fs.existsSync(f.runtimePath+'.migration.lock'),false);assert.equal(inspectLegacyLedger(raw,{now}).status,'already_migrated');
});
test('stale source or preexisting lease is refused without replacing the ledger or stealing the lease',()=>{
  const f=fixture(),w=witness(f),changed={...f.raw,extra:'new source event'};fs.writeFileSync(f.runtimePath,JSON.stringify(changed));
  assert.throws(()=>applyMigration({runtimePath:f.runtimePath,witness:w,clock}),/哈希/);assert.deepEqual(JSON.parse(fs.readFileSync(f.runtimePath)),changed);
  const other=fixture(),lock=other.runtimePath+'.migration.lock';fs.writeFileSync(lock,'{"id":"other-owner"}');
  assert.throws(()=>apply(other),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'{"id":"other-owner"}');assert.equal(fs.readFileSync(other.runtimePath).equals(other.bytes),true);
});
test('a source change after lease acquisition is detected before replacement',()=>{
  const f=fixture(),w=witness(f);let calls=0;const changed={...f.raw,newEvent:'fixture-new-event'};
  const movingClock=()=>{if(++calls===4)fs.writeFileSync(f.runtimePath,JSON.stringify(changed));return now;};
  assert.throws(()=>applyMigration({runtimePath:f.runtimePath,witness:w,clock:movingClock}),/改变/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtimePath)),changed);assert.equal(fs.existsSync(f.runtimePath+'.migration.lock'),false);
});
test('interruption after runtime replacement preserves a prepared receipt and a fresh witness can finish it idempotently',()=>{
  const f=fixture(),w=witness(f);let interrupted=false;
  const failOnce=()=>{if(!interrupted&&JSON.parse(fs.readFileSync(f.runtimePath)).version===3){interrupted=true;throw Error('synthetic interruption');}return now;};
  assert.throws(()=>applyMigration({runtimePath:f.runtimePath,witness:w,clock:failOnce,synthetic:true}),/synthetic interruption/);
  const migrated=fs.readFileSync(f.runtimePath);assert.equal(JSON.parse(migrated).version,3);assert.equal(fs.existsSync(f.runtimePath+'.migration.lock'),false);
  const receipt=apply(f);assert.equal(receipt.status,'applied');assert.equal(receipt.recovered,true);assert.equal(fs.readFileSync(f.runtimePath).equals(migrated),true);
});
test('rollback restores exact original bytes only before new data; new events are retained and rollback is rejected',()=>{
  const f=fixture();apply(f);const receipt=rollbackMigration({runtimePath:f.runtimePath,witness:witness(f),clock});
  assert.equal(receipt.status,'rolled_back');assert.equal(fs.readFileSync(f.runtimePath).equals(f.bytes),true);
  const other=fixture();apply(other);const current=JSON.parse(fs.readFileSync(other.runtimePath));current.life.journal.push({id:'new-event',status:'confirmed'});current.life.days['2026-11-21'].idle++;
  fs.writeFileSync(other.runtimePath,JSON.stringify(current));const bytes=fs.readFileSync(other.runtimePath);
  assert.throws(()=>rollbackMigration({runtimePath:other.runtimePath,witness:witness(other),clock}),/已有新事件/);
  assert.equal(fs.readFileSync(other.runtimePath).equals(bytes),true);
});
test('CLI synthetic dry run writes only its report and leaves source bytes and private artifact directories unchanged',()=>{
  const f=fixture(),script=fileURLToPath(new URL('../scripts/migrate-fish-world-ledger.js',import.meta.url)),reportDir=path.join(f.parent,'reports');
  const result=spawnSync(process.execPath,[script,'--runtime',f.runtimePath,'--report-dir',reportDir,'--synthetic'],{encoding:'utf8',env:process.env,windowsHide:true});
  assert.equal(result.status,0,result.stderr);const response=JSON.parse(result.stdout),report=JSON.parse(fs.readFileSync(response.reportFile));
  assert.equal(report.synthetic,true);assert.equal(report.sourceUnchanged,true);assert.equal(report.originalCounts.plans,1);
  assert.equal(fs.readFileSync(f.runtimePath).equals(f.bytes),true);assert.deepEqual(fs.readdirSync(f.root),['runtime.json']);
});
test('private backup redirection and symlink/junction runtime paths are rejected',t=>{
  const f=fixture(),outside=path.join(f.parent,'outside');
  assert.throws(()=>applyMigration({runtimePath:f.runtimePath,witness:witness(f),backupDir:outside,clock}),/私有子目录/);
  const aliasParent=path.join(f.parent,'alias');fs.mkdirSync(aliasParent);const alias=path.join(aliasParent,'fish-world');
  try{fs.symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Host cannot create a test link; redirection refusal was still verified.');return;}throw error;}
  try{const aliasFile=path.join(alias,'runtime.json');assert.throws(()=>applyMigration({runtimePath:aliasFile,witness:{...witness(f),runtimePath:aliasFile},clock}),/链接|重定向/);}
  finally{assert.ok(path.relative(testRuntimeRoot(null),alias)&&!path.relative(testRuntimeRoot(null),alias).startsWith('..'));assert.ok(fs.lstatSync(alias).isSymbolicLink());fs.unlinkSync(alias);}
});

test('startup requires the completed apply receipt and intact private recovery artifacts',()=>{
 const f=fixture({...legacy(),recent:[],at:{},errors:{}}),receipt=apply(f),receiptPath=path.join(f.root,'migration-receipts',receipt.operationId+'.json');
 assert.equal(readAppliedMigrationReceipt({runtimePath:f.runtimePath}).status,'applied');
 fs.writeFileSync(receiptPath,JSON.stringify({...receipt,status:'prepared'}));
 assert.throws(()=>readAppliedMigrationReceipt({runtimePath:f.runtimePath}),/完整/);
 const b=new FishBridge({file:f.runtimePath,credential:()=>''});assert.equal(b.migrationRequired,true);
 fs.writeFileSync(receiptPath,JSON.stringify(receipt));assert.equal(new FishBridge({file:f.runtimePath,credential:()=>''}).migrationRequired,false);
 fs.appendFileSync(receipt.mappingPath,' ');assert.throws(()=>readAppliedMigrationReceipt({runtimePath:f.runtimePath}),/映射哈希/);
});
test('an interrupted schema-3 commit stays gated after restart and obtains a fresh recovery witness',async()=>{
 const f=fixture({...legacy(),recent:[],at:{},errors:{}}),receipt=apply(f),receiptPath=path.join(f.root,'migration-receipts',receipt.operationId+'.json');
 fs.writeFileSync(receiptPath,JSON.stringify({...receipt,status:'prepared'}));
 const b=new FishBridge({file:f.runtimePath,credential:()=>''}),originalNow=Date.now;let fake=now;Date.now=()=>fake;
 try{
  const gate=migrationGate({dataDir:(...p)=>path.join(f.root,...p)},b,{version:'1.3.0',listAgents:()=>[]});
  assert.equal((await gate.probe()).ready,false);assert.equal(b.migrationRequired,true);fake+=16000;
  const status=await gate.probe();assert.ok(status.witness);const w=JSON.parse(fs.readFileSync(status.witness));
  const recovered=applyMigration({runtimePath:f.runtimePath,witness:w,clock:()=>fake,synthetic:true});assert.equal(recovered.recovered,true);
  assert.equal((await gate.probe()).ready,true);assert.equal(b.migrationRequired,false);
 }finally{Date.now=originalNow;}
});

test('formal Inbox getters are booleans and arrays, and external QQ sessions stay outside background interception',()=>{
 const a={status:'idle',inbox:{hasPending:false,nextTurn:[],nextStep:[]}};assert.equal(stableAgentIdle(a),true);
 a.inbox.hasPending=true;assert.equal(stableAgentIdle(a),false);a.inbox.hasPending=false;a.inbox.nextTurn.push('pending');assert.equal(stableAgentIdle(a),false);
 assert.equal(stableAgentIdle({status:'idle'}),false);assert.equal(ownSession({sessionId:'world',externalPending:{sessionId:'owner-qq'}},'owner-qq'),false);
 assert.equal(ownSession({sessionId:''},undefined),false);
});
