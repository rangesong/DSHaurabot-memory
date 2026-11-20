import test from 'node:test';
import assert from 'node:assert/strict';
import {installedKernel} from '../scripts/lib/isolated-context-kernel.js';

function fixture(k,{short=false}={}){
 const core=k.createCore(),config=k.defaultConfig(1000000);
 config.isToolProtected=n=>n.startsWith('mcp__bili__')&&['compress','acp_rule'].includes(n.slice('mcp__bili__'.length));
 config.isCompressTool=n=>n==='compress'||n==='mcp__bili__compress';
 const memory='FIXTURE exact_value=123.456 source_id=SOURCE_A owner_instruction=keep_original. '.repeat(100);
 const draft='m00002–m00003 synthetic prior fold\n'+memory.slice(0,1200);
 const body='Deterministic fixture engine guidance, not private content. '.repeat(short?1:100);
 const messages=[{id:'head',role:'user',contentType:'text',text:'Pinned original head.'},{id:'memory-original',role:'user',contentType:'text',text:memory},{id:'memory-answer',role:'assistant',contentType:'text',text:'Fact confirmed: 123.456, SOURCE_A.'},{id:'old-user',role:'user',contentType:'text',text:'Old completed turn.'}];
 for(let i=0;i<5;i++){
  messages.push({id:'before-'+i,role:'assistant',contentType:'text',text:'Exact adjacent result '+i+' = 987.654, SOURCE_B.'});
  messages.push({id:'thinking-'+i,role:'assistant',contentType:'reasoning',text:'Original reasoning retained verbatim '+i+'.',wireIndex:20+i*4});
  messages.push({id:'call-'+i,role:'assistant',contentType:'tool-call',toolName:'compress',toolCallId:'native-call-'+i,text:JSON.stringify({content:draft}),wireIndex:20+i*4});
  messages.push({id:'result-'+i,role:'tool',contentType:'tool-result',toolName:'compress',toolCallId:'native-call-'+i,text:'[Compressed m00002–m00003 → 1 block(s), ~9000 tokens saved.]\n\n'+body,wireIndex:21+i*4});
  messages.push({id:'after-'+i,role:'assistant',contentType:'text',text:'Exact adjacent answer '+i+' = 456.789, SOURCE_C.'});
  messages.push({id:'user-'+i,role:'user',contentType:'text',text:'Next completed user turn '+i+'.'});
 }
 messages.push({id:'current-user',role:'user',contentType:'text',text:'Current user evidence must remain.'});
 const first=core.processTurn({messages,state:k.createInitialState(),config,tokenCount:50000,renderTags:'none'});
 return {core,config,messages,first};
}
const file=process.env.BILI_KERNEL_FILE;
test('official wrapped range folds aged BLOCKED exchange without inventing message refs',t=>{
 if(!file){t.skip('Set BILI_KERNEL_FILE for the installed official kernel proof');return;}
 const k=installedKernel(file),{core,config,messages,first}=fixture(k),before=JSON.stringify(first.state),refs=first.state.messageRefs.byRaw;
 assert.equal(refs['call-0'],'BLOCKED');assert.equal(refs['result-0'],'BLOCKED');
 const summary='Completed successful tool process. Original source retained.\n'+messages.filter(m=>['before-0','thinking-0','after-0'].includes(m.id)).map(m=>m.text).join('\n')+'\nThe complete fixture draft remains in source and exact fact 123.456 SOURCE_A remains available.\n'+messages.find(m=>m.id==='result-0').text.split('\n\n')[0];
 const folded=core.applyCompression({messages,state:first.state,config,ranges:[{startRef:refs['before-0'],endRef:refs['after-0'],summary}]});
 assert.equal(folded.result.errors.length,0);assert.equal(folded.result.blocksCreated,1);
 const block=folded.state.blocks.find(b=>b.active);assert.ok(block.effectiveMessageIds.includes('call-0'));assert.ok(block.effectiveMessageIds.includes('result-0'));
 for(const id of ['before-0','thinking-0','after-0'])assert.ok(block.summary.includes(messages.find(m=>m.id===id).text));
 const after=core.processTurn({messages,state:folded.state,config,tokenCount:40000,renderTags:'none'});
 assert.ok(after.messages.every(m=>m.toolCallId!=='native-call-0'));assert.ok(after.messages.some(m=>m.id==='current-user'));
 assert.equal(JSON.stringify(first.state),before);assert.equal(refs['call-0'],'BLOCKED');
});
test('recent exchanges keep engine protection even when a wrapping range is submitted',t=>{
 if(!file){t.skip('Set BILI_KERNEL_FILE');return;}
 const k=installedKernel(file),{core,config,messages,first}=fixture(k),refs=first.state.messageRefs.byRaw;
 const result=core.applyCompression({messages,state:first.state,config,ranges:[{startRef:refs['before-4'],endRef:refs['after-4'],summary:'Attempt to wrap a recent compress exchange; it must remain protected. '.repeat(5)}]});
 assert.ok(result.state.blocks.every(b=>!b.effectiveMessageIds.includes('call-4')&&!b.effectiveMessageIds.includes('result-4')));
});
test('the normal minimum-benefit size rule is retained rather than disabled for receipts',t=>{
 if(!file){t.skip('Set BILI_KERNEL_FILE');return;}
 const k=installedKernel(file),{core,config,messages,first}=fixture(k,{short:true}),refs=first.state.messageRefs.byRaw;
 const result=core.applyCompression({messages,state:first.state,config,ranges:[{startRef:refs['before-0'],endRef:refs['after-0'],summary:'Small completed process with full original evidence still retained. '.repeat(3)}]});
 assert.equal(result.result.blocksCreated,0);assert.ok(result.result.errors.some(e=>e.includes('too small')));assert.equal(config.compress.minCompressRange,5000);
});
