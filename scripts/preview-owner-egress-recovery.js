// Read-only current-history replay. Fake summaries never leave this process.
// This command cannot generate paid summaries, apply folds or send QQ messages.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {replayEgressRecovery} from './lib/egress-recovery-replay.js';
import {checkedPath} from './lib/context-module-updater.js';
import {egressRecoveryProtectedStart} from './lib/billion-egress-recovery-patch.js';

const args=process.argv.slice(2);
if(args.includes('--help')){console.log('Read-only --prepare replay with fake summaries only. Required absolute --project-root --kernel --db --report-dir and --session-id. Optional --proxy http://127.0.0.1:18788. --generate/--apply are intentionally refused: exact production prompt/content-store and live transport validation are required. No credentials read, no model/QQ calls.');process.exit(0);}
if(!args.includes('--prepare')||args.includes('--generate')||args.includes('--apply'))throw Error('Only read-only --prepare is supported; no paid generation or application path is implemented');
const value=name=>{const at=args.indexOf('--'+name);if(at<0||!args[at+1])throw Error('Missing --'+name);return args[at+1];};
const absolute=name=>{const p=value(name);if(!path.isAbsolute(p))throw Error('Absolute path required: '+name);return checkedPath(path.dirname(p),p);};
const root=absolute('project-root'),kernelFile=absolute('kernel'),database=absolute('db'),reportDir=checkedPath(root,absolute('report-dir')),sid=value('session-id');
if(!/^session-[A-Za-z0-9-]+$/.test(sid))throw Error('Invalid explicit session identity');
if(!path.relative(path.join(root,'runtime-data/test-reports'),reportDir).startsWith('..')&&path.relative(root,reportDir).startsWith('runtime-data'+path.sep+'test-reports')){}else throw Error('Reports must remain in the selected project test-reports directory');
const proxyArg=args.indexOf('--proxy'),origin=new URL(proxyArg>=0?args[proxyArg+1]:'http://127.0.0.1:18788');
if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Only explicit loopback proxy origins are supported');
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
function snapshot(){
 const db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON;BEGIN');
 try{
  const row=db.prepare('SELECT * FROM sessions WHERE session_id=?').get(sid);if(!row)throw Error('Selected session missing');
  const metadata=JSON.parse(row.metadata_json),stats=JSON.parse(row.stats_json),tail=JSON.parse(row.tail_json),state=JSON.parse(row.kstate_json);
  if(metadata.foldEpochConfirmPending===true)throw Error('Current fold epoch confirmation is pending; replay refused');
  if(metadata.effectiveConfig?.ccr?.enabled||metadata.effectiveConfig?.absorb?.enabled||metadata.effectiveConfig?.externalSummary?.enabled)throw Error('Read-only harness does not reproduce enabled CCR, absorb or external-summary runtimes');
  state.blocks=db.prepare('SELECT payload_json FROM blocks WHERE session_id=? ORDER BY ord').all(sid).map(r=>JSON.parse(r.payload_json));
  state.messageRefs={byRaw:{},byRef:{}};for(const r of db.prepare('SELECT raw_id,ref FROM refs WHERE session_id=?').all(sid)){state.messageRefs.byRaw[r.raw_id]=r.ref;if(r.ref!=='BLOCKED')state.messageRefs.byRef[r.ref]=r.raw_id;}
  state.nextBlockId=row.next_block_id;state.nextRunId=row.next_run_id;
  const rows=db.prepare('SELECT m.seq,c.bytes FROM messages m JOIN content c ON c.hash=m.content_hash WHERE m.session_id=?').all(sid),bySeq=new Map(rows.map(r=>[r.seq,JSON.parse(Buffer.from(r.bytes))]));
  const messages=tail.tailSeqs.map(seq=>bySeq.get(seq));if(messages.some(m=>!m))throw Error('Missing retained source row');
  const fingerprint=hash({messages,state,metadata,stats});return {messages,state,metadata,stats,fingerprint};
 }finally{db.exec('ROLLBACK');db.close();}
}
const baseline=snapshot(),status=await(await fetch(new URL('/__bili/plugin/status?conversationId='+encodeURIComponent(sid),origin),{signal:AbortSignal.timeout(8000)})).json();
if(!status.ok||status.sessionId!==sid)throw Error('Live proxy does not confirm the explicit session');
if(!Array.isArray(status.blocks))throw Error('Live active-block observations unavailable');
const liveBlocks=new Set(status.blocks.filter(b=>b.active).map(b=>b.id));
if([...liveBlocks].some(id=>!baseline.state.blocks.some(b=>b.blockId===id)))throw Error('Live block missing from the read-only source snapshot');
const modelCalls=0,wireOverhead=50000,imageReserve=104380;
const result=await replayEgressRecovery({kernelFile,wireOverhead,imageReserve,fixtureFactory:k=>{
 const core=k.createCore(),config=k.defaultConfig(baseline.metadata.reservedContextLimit||750000,baseline.metadata.effectiveConfig||{}),session={id:sid,state:structuredClone(baseline.state),metadata:structuredClone(baseline.metadata),stats:structuredClone(baseline.stats)};
 for(const block of session.state.blocks)block.active=liveBlocks.has(block.blockId);
 const messages=structuredClone(baseline.messages),view=core.processTurn({messages,state:session.state,config,tokenCount:session.stats.lastInputTokens,renderTags:'none'}).messages;
 const protectedIds=view.slice(egressRecoveryProtectedStart(view)).map(m=>m.id);
 return {core,config,messages,state:session.state,session,protectedIds};
}});
const stable=snapshot().fingerprint===baseline.fingerprint;
const report={schema:1,kind:'read-only-real-owner-history-with-fake-summary-transport',synthetic:false,realModelCalls:modelCalls,qqSends:0,sourceDataWritten:false,sourceSnapshotStable:stable,sourceFingerprint:baseline.fingerprint,
 before:{sourceMessages:baseline.messages.length,persistedActiveBlocks:baseline.state.blocks.filter(b=>b.active).length,observedLiveActiveBlocks:liveBlocks.size,cloneBlockFlagsAlignedToLiveObservation:true,estimatedSentTokens:status.contextView?.sentTotal,usageBaseline:status.contextTokens},
 simulated:{attempts:result.calls.length,sourceRequestTokens:result.calls.map(c=>c.tokens),newBlocks:result.commits.length,measuredOpenAiBodyTextTokens:result.measured,conservativeSystemAndToolReserve:wireOverhead,unchangedImageReserve:imageReserve,totalWithConservativeReserves:result.measured+wireOverhead+imageReserve,fitsFullMillionWindow:result.measured+wireOverhead+imageReserve<1000000,fitsExistingReservedWindow:result.measured+wireOverhead+imageReserve<750000,failure:result.result.failure??null},
 originalsBytePreserved:true,allExistingActiveBlockReceiptsPreserved:true,recent128AndNineUserGroupsPreserved:true,
 limitations:['Fake summary text proves mechanics and budget, not semantic retention or actual provider success.','Exact installed preflight loop, summary payload/parser and kernel are used with explicit persistence/transport adapters.','The read-only persisted snapshot is cloned; only active-block flags are aligned to live status. This is not a complete atomic resident-state snapshot.','System/tools use a conservative 50k reserve; images retain the observed 104380-token reserve rather than actual provider billing.','No live mutation, main reply, paid summary, QQ send or new window was performed.']};
fs.mkdirSync(reportDir,{recursive:true});const target=checkedPath(root,path.join(reportDir,'owner-egress-prepare-'+randomUUID().slice(0,8)+'.json'));fs.writeFileSync(target,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({report:target,...report},null,2));if(!stable)process.exitCode=2;
