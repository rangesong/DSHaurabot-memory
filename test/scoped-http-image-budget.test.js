import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {prepareWorkbuddyProjector,scopedImageAuditRuntime,createCasImageFixture,nonImagePayload,verifyCasOriginals,HTTP_IMAGE_AUDIT_MIB as MIB} from '../scripts/lib/http-image-budget-audit.js';
import {testRuntimeRoot,writeTestResult} from '../scripts/lib/test-workspace.js';

const kernelFile=process.env.BILI_KERNEL_FILE,workbuddyFile=process.env.WORKBUDDY_PROJECTOR_FILE;
const sha=value=>createHash('sha256').update(value).digest('hex');
test('exact scoped image shedding proves immutable CAS pointers, recent eight entries and prepared inner body under the existing native cap',async t=>{
 if(!kernelFile||!workbuddyFile){t.skip('Installed kernel and Workbuddy pure projector paths required');return;}
 const source=fs.readFileSync(kernelFile,'utf8'),projector=prepareWorkbuddyProjector(fs.readFileSync(workbuddyFile,'utf8'));
 const fixture=createCasImageFixture(testRuntimeRoot()),before=JSON.parse(fixture.body),sourceHash=sha(fixture.body);
 const endpoint='http://127.0.0.1:34567/v1/chat/completions',ctx={sessionId:'synthetic-owner',upstreamUrl:endpoint,phase:'pre-send',session:fixture.session};
 const audit=scopedImageAuditRuntime(source,{rules:[{conversationId:'synthetic-owner',upstream:endpoint,bytes:7*MIB}]}),result=await audit.run(fixture.body,ctx),after=JSON.parse(result.body);
 const beforeInner=projector.prepare(fixture.body),afterInner=projector.prepare(result.body);
 assert.ok(Buffer.byteLength(beforeInner)>8*MIB,'old payload demonstrably hits the unchanged native cap');
 assert.ok(result.stats.originalBytes>8*MIB);assert.ok(result.stats.finalBytes<=7*MIB);
 assert.ok(Buffer.byteLength(afterInner)<8*MIB);assert.ok(result.stats.archived>0);assert.equal(result.stats.downscaled,0);assert.equal(result.downscaleCalls,0);
 assert.deepEqual(after.messages.slice(-8),before.messages.slice(-8));assert.deepEqual(nonImagePayload(result.body),nonImagePayload(fixture.body));
 assert.deepEqual(nonImagePayload(afterInner),nonImagePayload(beforeInner),'the actual Workbuddy projector retains the same text and tool transformation');
 assert.equal(sha(fixture.body),sourceHash);assert.ok(verifyCasOriginals(fixture.originals));
 const notes=after.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='text'&&part.text.startsWith('[image:'));
 assert.equal(notes.length,result.stats.archived);
 for(const note of notes){const ref=note.text.match(/m\d+/u)?.[0];assert.ok(ref&&fixture.originals.some(item=>item.ref===ref),'every archived image has its exact original SHA-verified live source alias');}
 writeTestResult({schema:1,kind:'scoped-http-image-cas-workbuddy-pipeline',synthetic:true,actualOwnerWireCapture:false,realModelCalls:0,qqSends:0,configChanges:0,sourceSha256:sourceHash,kernelPatch:audit.receipt,workbuddyPureProjectorSha256:projector.sourceSha256,originalBytes:result.stats.originalBytes,finalBytes:result.stats.finalBytes,innerBeforeBytes:Buffer.byteLength(beforeInner),innerAfterBytes:Buffer.byteLength(afterInner),innerOverheadBytes:Buffer.byteLength(afterInner)-result.stats.finalBytes,archived:result.stats.archived,downscaled:result.stats.downscaled,casOriginals:fixture.originals.map(({sha256,bytes,ref})=>({sha256,bytes,ref})),originalSourcesRetained:true,textAndToolArgumentsRetained:true,protectedEightWireEntriesRetained:true,existingInnerEightMiBLimitUnchanged:true,limitation:'Synthetic valid PNG/CAS fixture and exact installed pure functions; this is not the actual private 9.3 MiB outbound body capture or host/model acceptance.'});
});
