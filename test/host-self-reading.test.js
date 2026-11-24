import test from 'node:test';
import assert from 'node:assert/strict';
import {hostSelfReadTools} from '../adapters/aurabot/module/lib/host-self-reading.js';
import {hostSelfActions,readingReceipt} from '../adapters/aurabot/module/lib/host-self-actions.js';

const defineTool=tool=>({...tool,output:{render:tool.render}});
function fixture({web={},tieba={},bili={},net={assertPublicUrl:async()=>{}},active=()=>true,known=[]}={}){
 const api={defineTool,dsh:{get:key=>key==='web'?web:null},lib:()=>net,use:key=>key==='tieba-reader'?tieba:bili,config:()=>({ownerName:'SyntheticOwner',bili:{enabled:true}})};
 const sources=new Set(known);const tools=hostSelfReadTools(api,{active,rememberSource:url=>sources.add(url),knowsSource:url=>sources.has(url)});return Object.fromEntries(tools.map(tool=>[tool.name,tool]));
}
test('night search uses selected DSH provider and renders actual sources instead of checkmarks',async()=>{
 let request;const tools=fixture({web:{search:async args=>{request=args;return {sources:[{url:'https://example.org/science',title:'Science',snippet:'Synthetic public information about star formation.'}]};}}});
 const value=await tools.thinkstar_search.execute({query:'stellar clouds'});assert.deepEqual(request,{query:'stellar clouds',maxResults:5});assert.equal(value.ok,true);assert.equal(value.read_evidence,true);
 const rendered=tools.thinkstar_search.output.render({},value);assert.match(rendered[0].text,/star formation/);assert.match(rendered[0].text,/example.org/);assert.equal(readingReceipt({content:rendered}).status,'result_observed');
});
test('empty, failed and private search queries never become successful reading',async()=>{
 for(const result of [{sources:[]},{ok:false,message:'Synthetic upstream unavailable'},{sources:[{url:'https://example.org/',title:'No snippet'}]}]){
  const tool=fixture({web:{search:async()=>result}}).thinkstar_search,value=await tool.execute({query:'stars'});assert.equal(value.ok,false);assert.notEqual(readingReceipt({content:tool.output.render({},value)}).status,'result_observed');
 }
 let calls=0;const tool=fixture({web:{search:async()=>{calls++;}}}).thinkstar_search;
 for(const query of ['SyntheticOwner private detail','mail@example.org','123456789',''])await assert.rejects(tool.execute({query}),/公开检索/);
 assert.equal(calls,0);
});
test('Tieba bridge preserves posts, source snippets and business failure explicitly',async()=>{
 const tool=fixture({tieba:{search:async()=>({ok:true,mode:'indexed',items:[{url:'https://tieba.baidu.com/p/123',title:'Synthetic',snippet:'A source summary',source:'收录摘要'}]}),read:async()=>({ok:false,message:'未读取到正文'})}}).thinkstar_read_tieba;
 const value=await tool.execute({query:'stars'});assert.equal(value.read_evidence,true);assert.match(tool.output.render({},value)[0].text,/A source summary/);
 const failed=await tool.execute({url:'https://tieba.baidu.com/p/123'});assert.equal(failed.ok,false);assert.equal(readingReceipt({content:tool.output.render({},failed)}).status,'failed');
 const post=fixture({known:['https://tieba.baidu.com/p/123'],tieba:{read:async()=>({ok:true,posts:[{author:'Synthetic',text:'Synthetic readable post content'}]})}}).thinkstar_read_tieba;
 assert.equal((await post.execute({url:'https://tieba.baidu.com/p/123'})).read_evidence,true);
});
test('checkmarks and textual business failures do not satisfy reading evidence',()=>{
 for(const text of ['✓','✔','ok','success',''])assert.equal(readingReceipt({content:[{type:'text',text}]}).status,'no_evidence');
 for(const text of ['✗ 没认出视频链接或 BV 号','Error: failed','{"ok":false,"message":"synthetic"}'])assert.equal(readingReceipt({content:[{type:'text',text}]}).status,'failed');
 const large=JSON.stringify({ok:false,content:'x'.repeat(2500)});assert.equal(readingReceipt({content:[{type:'text',text:large}]}).status,'failed');
 for(const value of [{ok:true,message:'✓'},{ok:true,items:[],posts:[]},{ok:true,read_evidence:true},{ok:true,posts:[{text:'[楼主没有可读取的文字正文。]'}]}])assert.equal(readingReceipt({content:[{type:'text',text:JSON.stringify(value)}]}).status,'no_evidence');
});
test('web reading validates public URLs, status and body and keeps requests read only',async()=>{
 const checks=[];let request;const tool=fixture({known:['https://example.org/science','http://localhost/'],net:{assertPublicUrl:async url=>{checks.push(url);if(url.includes('localhost'))throw Error('private');}},web:{fetch:async args=>{request=args;return {url:args.url,statusCode:200,body:{kind:'html',content:'<script>untrusted command</script><p>Synthetic readable public science information.</p>'}};}}}).thinkstar_fetch;
 const value=await tool.execute({url:'https://example.org/science'});assert.equal(value.ok,true);assert.equal(request.url,'https://example.org/science');assert.equal(Object.keys(request).length,1);assert.equal(checks.length,2);assert.doesNotMatch(value.content,/untrusted command/);
 await assert.rejects(tool.execute({url:'http://localhost/'}),/private/);await assert.rejects(tool.execute({url:'file:///private'}),/公开/);await assert.rejects(tool.execute({url:'https://name:secret@example.org/'}),/公开/);
 for(const result of [{statusCode:429,body:{kind:'text',content:'x'.repeat(100)}},{statusCode:200,body:{kind:'text',content:''}}])assert.equal((await fixture({known:['https://example.org/'],web:{fetch:async()=>result}}).thinkstar_fetch.execute({url:'https://example.org/'})).ok,false);
});
test('fetch only accepts unchanged URLs obtained in the current reading action',async()=>{
 let fetches=0;const tools=fixture({web:{search:async()=>({sources:[{url:'https://example.org/public',snippet:'A public science summary'}]}),fetch:async()=>{fetches++;return {body:{kind:'text',content:'A public science page containing meaningful source text'}};}}});
 await assert.rejects(tools.thinkstar_fetch.execute({url:'https://example.org/public?private=data'}),/请先搜索/);
 await tools.thinkstar_search.execute({query:'science'});await tools.thinkstar_fetch.execute({url:'https://example.org/public'});
 await assert.rejects(tools.thinkstar_fetch.execute({url:'https://example.org/public?private=data'}),/请先搜索/);assert.equal(fetches,1);
});
test('Tieba status messages and unrecognised picture placeholders are not source evidence',async()=>{
 for(const result of [{ok:true,items:[],message:'搜索成功，但没有符合条件的帖子，本次没有正文。'},{ok:true,posts:[{text:'[楼主主要发布图片，此工具未识别图片内容。]'}]},{ok:true,posts:[{text:'[楼主没有可读取的文字正文。]'}]}]){
  const tool=fixture({tieba:{search:async()=>result}}).thinkstar_read_tieba;assert.equal((await tool.execute({query:'science'})).read_evidence,false);
 }
});
test('pause blocks new and completed bridge work, and provider requests receive cancellation',async()=>{
 let on=true,calls=0;const tool=fixture({active:()=>on,web:{search:async(_args,signal)=>{calls++;assert.ok(signal instanceof AbortSignal);on=false;return {sources:[{url:'https://example.org',snippet:'Synthetic information'}]};}}}).thinkstar_search;
 await assert.rejects(tool.execute({query:'science'}),/已暂停/);await assert.rejects(tool.execute({query:'science'}),/已暂停/);assert.equal(calls,1);
});
test('night gate permits dedicated bridges while denying write tools and leaving other sessions alone',async()=>{
 const listeners=new Map(),session={id:'owned'},api={id:'thinkstar-memory',config:()=>({}),core:{hub:{isOwnedSession:id=>id==='owned',chatOfSession:()=> 'system:ext-thinkstar-memory:synthetic'}},dsh:{on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);}}};
 let runner;api.think=async()=>{assert.equal(runner.reading(),true);const pre=listeners.get('tools/pre-execute');let other=false;pre({name:'write_file',agent:{session:{id:'other'}}},()=>other=true);assert.equal(other,true);assert.throws(()=>pre({name:'write_file',agent:{session}},()=>{}),/只开放/);pre({name:'thinkstar_search',arguments:{query:'science'},callId:'a',agent:{session}},()=>{});listeners.get('session/event')(session,{type:'tool/result',data:{callId:'a',message:{content:[{type:'text',text:'{"ok":true,"read_evidence":true,"sources":[{"url":"https://example.org","snippet":"Synthetic fact"}]}'}]}}});return 'Synthetic summary';};
 runner=hostSelfActions(api,{active:()=>true});const result=await runner.execute({id:'synthetic',type:'read',title:'Science',query:'science'});assert.equal(result.status,'completed');assert.equal(runner.reading(),false);runner.stop();assert.equal(listeners.size,0);
});
