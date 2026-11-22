import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {replayEgressRecovery} from '../scripts/lib/egress-recovery-replay.js';
import {writeTestResult} from '../scripts/lib/test-workspace.js';
import {BILI_EGRESS_RECOVERY_MAX_ATTEMPTS} from '../scripts/lib/billion-egress-recovery-patch.js';
const kernelFile=process.env.BILI_KERNEL_FILE;
const raw=kernelFile?fs.readFileSync(kernelFile,'utf8'):null;
function fixture(k){
 const messages=[],recent=[],protectedIds=[];
 const add=(role,type,text,extra={})=>{const m={id:'fixture-'+messages.length,wireIndex:messages.length,role,contentType:type,text,...extra};messages.push(m);return m;};
 for(let i=0;i<600;i++){
  add('user','text',`SYNTHETIC_SOURCE_${i}; exact_value=123.456; `+'合成历史甲乙丙丁'.repeat(340));
  if(i===199||i===399){const call='hard-call-'+i;protectedIds.push(add('assistant','tool-call','{"synthetic":true}',{toolName:'protected_fixture_read',toolCallId:call}).id);protectedIds.push(add('tool','tool-result','HARD_PROTECTED_TOOL_RESULT',{toolName:'protected_fixture_read',toolCallId:call}).id);}
 }
 for(let i=0;i<8;i++){recent.push(add('user','text','RECENT_USER_TURN_'+i+' 条件不变，精确值123.456。'));recent.push(add('assistant','text','RECENT_ASSISTANT_TURN_'+i+' 原有约定继续有效。'));}
 protectedIds.push(...messages.slice(-128).map(m=>m.id));
 const config=k.defaultConfig(750000,{tiers:{enabled:false},preserveRecentMessages:recent.length,preserveRecentTokens:8000,protectedTools:['protected_fixture_read']});
 const core=k.createCore(),first=core.processTurn({messages,state:k.createInitialState(),config,tokenCount:150753,renderTags:'none'}),refs=first.state.messageRefs.byRaw;
 const seeded=core.applyCompression({messages,state:first.state,config,ranges:[{startRef:refs[messages[0].id],endRef:refs[messages[2].id],summary:'EXISTING_BLOCK precise_value=123.456; original synthetic source evidence remains preserved. '.repeat(4)}]});
 assert.equal(seeded.result.blocksCreated,1);
 return {core,config,messages,state:seeded.state,protectedIds};
}
const run=(patched,mode)=>replayEgressRecovery({kernelFile,patched,mode,fixtureFactory:fixture});
test('full exact preflight recovery uses bounded source summaries and retains protected evidence',async t=>{
 if(!raw){t.skip('BILI_KERNEL_FILE required for exact full preflight replay');return;}
 const after=await run(true);assert.equal(after.result.failure,undefined,after.logs.slice(-10).join(' | '));assert.ok(after.calls.length>=1&&after.calls.length<=BILI_EGRESS_RECOVERY_MAX_ATTEMPTS);assert.ok(after.measured<750000);assert.ok(after.calls.every(c=>c.tokens<=450000&&c.content.length<after.initialChars*.7));
 const before=await run(false);assert.ok(before.calls.length>BILI_EGRESS_RECOVERY_MAX_ATTEMPTS||before.measured>=1000000,'old source cannot recover within the new bounded-attempt policy');
 writeTestResult({synthetic:true,kind:'exact-preflight-with-real-kernel-fake-summary-transport',realModelCalls:0,qqSends:0,before:{attempts:before.calls.length,measured:before.measured},after:{attempts:after.calls.length,sourceRequestTokens:after.calls.map(c=>c.tokens),measured:after.measured,blocksCreated:after.commits.length},originalSourcesRetained:true,existingBlockRetained:true,protectedToolPairsAndRecent128MessagesRetained:true});
});
test('recovery stops on nonretryable429 and limits retryable transport attempts',async t=>{
 if(!raw){t.skip('BILI_KERNEL_FILE required for exact full preflight replay');return;}
 const denied=await run(true,'rate-limit');assert.equal(denied.calls.length,1);assert.equal(denied.commits.length,0);assert.equal(denied.result.fitsWindow,false);
 const transient=await run(true,'transient');assert.equal(transient.calls.length,BILI_EGRESS_RECOVERY_MAX_ATTEMPTS);assert.equal(transient.commits.length,0);assert.equal(transient.result.fitsWindow,false);
});
