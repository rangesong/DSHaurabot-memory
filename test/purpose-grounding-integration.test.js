import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {patchPurposeEngine} from '../scripts/lib/purpose-engine-patch.js';
import {patchPurposeModule,patchPurposeRegistration} from '../scripts/lib/purpose-module-patch.js';
const host=process.env.AURABOT_SOURCE||'D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq';
const scratch=process.env.THINKSTAR_TEST_TMP;if(!scratch)throw Error('Use managed runner');
const stage=path.join(scratch,'purpose-grounding-integration');fs.mkdirSync(stage);
fs.cpSync(path.join(host,'src'),path.join(stage,'src'),{recursive:true});fs.writeFileSync(path.join(stage,'package.json'),'{"type":"module"}');
for(const [rel,patch] of [['purpose/engine.js',patchPurposeEngine],['purpose/module.js',patchPurposeModule],['modules/purpose/index.js',patchPurposeRegistration]]){
  const file=path.join(stage,'src',rel);fs.writeFileSync(file,patch(fs.readFileSync(file,'utf8'),{version:'1.3.0-beta.1'}).source);
}
fs.copyFileSync(new URL('../adapters/aurabot/native/purpose-evidence.js',import.meta.url),path.join(stage,'src/purpose/evidence.js'));
fs.copyFileSync(new URL('../adapters/aurabot/native/purpose-outreach-guard.js',import.meta.url),path.join(stage,'src/purpose/outreach-guard.js'));
process.env.AURABOT_DATA_DIR=path.join(scratch,'purpose-initial-import');
const {createPurpose}=await import(pathToFileURL(path.join(stage,'src/purpose/module.js')));
let count=0;
function fixture({reply='想和你聊一会儿\n【目的】陪聊\n【状态】完成',ask=async()=>'{"pass":true}',use=()=>null,followUp=null}={}){
  const data=path.join(scratch,'purpose-case-'+count++);process.env.AURABOT_DATA_DIR=data;
  const cfg={enabled:true,ownerQQ:'1001',ownerName:'主人',persona:{current:'fish'},speakUp:{enabled:false,awakeFrom:0,awakeTo:24,maxPerDay:20,allow:['2002']},ext:{purpose:{enabled:true,minMaterials:0}}};
  const sent=[],turns=[],nudges=[];let asked=0;
  const hub={purposeSessionPatchVersion:1,chatLogDays:()=>[],chatLogOf:()=>[],lastOwnerChatAt:0,lastBotToOwner:{at:0,text:''},async runSystemTurn(name,title,prompt,options){turns.push({name,prompt,options});return reply;},async deliver(to,text,opts){if(!opts.isCurrent||opts.isCurrent()){sent.push({to,text});return {sent:text};}return {sent:''};}};
  const memory={list:()=>[{id:'m1',text:'主人喜欢聊天',importance:0.8,at:Date.now()-86400000,saidAt:Date.now()-86400000,lastHit:Date.now()}],dueFollowUp:()=>followUp,markFollowUpAsked:()=>asked++};
  const p=createPurpose({getConfig:()=>cfg,hub,log:{info(){},warn(){}},isMuted:()=>false,memory:()=>memory,mood:()=>({nudge:()=>nudges.push(1)}),personaText:()=>'',ask,use});
  return {p,cfg,hub,sent,turns,data,nudges,asked:()=>asked,state:()=>JSON.parse(fs.readFileSync(path.join(data,'purpose/purpose-state.json'),'utf8'))};
}
test('reviewed purpose preserves fresh generation, normal send, accounting and original memories',async()=>{
  const f=fixture();const r=await f.p.fire();assert.equal(r.outcome,'sent');assert.equal(f.sent.length,1);assert.equal(f.turns[0].options.noTools,true);assert.equal(f.turns[0].options.freshHistory,true);assert.equal(f.state().version,2);assert.equal(f.p.status().grounding.freshHistoryAvailable,true);
});
test('rejected claim never reaches any carrier or pending and schedules normally',async()=>{
  const f=fixture({reply:'我正在床上，刚拔了两颗萝卜\n【目的】报告\n【状态】待续\n【待续】明天继续拔萝卜',ask:async()=>'{"pass":false,"reason":"与在途现场冲突"}'});
  const r=await f.p.fire();assert.equal(r.outcome,'grounding-rejected');assert.equal(f.sent.length,0);assert.equal(f.state().pending.length,0);assert.equal(f.state().history.at(-1).text,'');assert.equal(f.state().countToday,1);assert.equal(f.nudges.length,0);assert.ok(f.state().nextFireAt>Date.now()+15*60000);
});
test('missing review or loaded session patch cannot silently bypass protection',async()=>{
  const f=fixture({ask:null});assert.equal((await f.p.fire()).outcome,'grounding-rejected');assert.equal(f.sent.length,0);
  const g=fixture();delete g.hub.purposeSessionPatchVersion;assert.equal((await g.p.fire()).outcome,'skipped-reload-required');assert.equal(g.turns.length,0);
});
test('scope changed in place while reviewing rejects result and does not overwrite old purpose state',async()=>{
  let resolve,ready;const started=new Promise(r=>ready=r);
  const f=fixture({ask:()=>{ready();return new Promise(r=>resolve=r);}});const turn=f.p.fire();await started;
  const before=fs.readFileSync(path.join(f.data,'purpose/purpose-state.json'),'utf8');f.cfg.persona.current='other';resolve('{"pass":true}');await turn;
  assert.equal(f.sent.length,0);assert.equal(fs.readFileSync(path.join(f.data,'purpose/purpose-state.json'),'utf8'),before);
});
test('unload during review and concurrent manual runs do not send or double count',async()=>{
  let resolve,ready;const started=new Promise(r=>ready=r);
  const f=fixture({ask:()=>{ready();return new Promise(r=>resolve=r);}});const turn=f.p.fire();await started;
  assert.equal((await f.p.fire()).outcome,'skipped-busy');f.p.dispose();resolve('{"pass":true}');await turn;assert.equal(f.sent.length,0);
});
test('world current changes during review so obsolete draft is rejected',async()=>{
  let where='路上';const f=fixture({use:()=>({outreachSnapshot:()=>({available:true,scope:{owner:'1001',persona:'fish',fish:'#1234'},sampledAt:Date.now(),sharingEnabled:true,current:{fresh:true,observedAt:Date.now()-1000,where},recent:[]})}),ask:async()=>{where='学校';return '{"pass":true}';}});
  assert.equal((await f.p.fire()).outcome,'grounding-rejected');assert.equal(f.sent.length,0);
});
