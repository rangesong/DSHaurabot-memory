import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {OWNER_REPLY_PATCH,patchOwnerReplies} from '../scripts/lib/owner-reply-patch.js';
import {extractRuntime} from './helpers/extract-host-runtime.js';

const host=process.env.AURABOT_SOURCE;
const available=!!host&&fs.existsSync(path.join(host,'src/chat/hub.js'));
const scratch=process.env.THINKSTAR_TEST_TMP;
const OWNER='10000001',OTHER='10000002',BOT='20000002',GROUP='30000003';
const source=available?fs.readFileSync(process.env.AURABOT_HUB_BASELINE||path.join(host,'src/chat/hub.js'),'utf8'):'';
let createOriginalHub,createPatchedHub,createFakeDsh,normalize,Session,scopeCoreForModule;
if(available){
  assert.ok(scratch,'Run through scripts/run-tests.js');
  const root=path.join(scratch,'owner-reply-host');fs.mkdirSync(root,{recursive:true});
  const rewrite=s=>s.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,(m,quote,spec)=>'from '+quote+new URL(spec,pathToFileURL(path.join(host,'src/chat/hub.js'))).href+quote);
  for(const [label,text]of [['original',source],['patched',patchOwnerReplies(source,{version:OWNER_REPLY_PATCH.version}).source]])fs.writeFileSync(path.join(root,label+'.mjs'),rewrite(text));
  ({createHub:createOriginalHub}=await import(pathToFileURL(path.join(root,'original.mjs')).href));
  ({createHub:createPatchedHub}=await import(pathToFileURL(path.join(root,'patched.mjs')).href));
  ({createFakeDsh}=await import(pathToFileURL(path.join(host,'test/helpers/fake-dsh.js')).href));
  ({normalize}=await import(pathToFileURL(path.join(host,'src/core/config.js')).href));
  ({scopeCoreForModule}=await import(pathToFileURL(path.join(host,'src/core/modules.js')).href));
  if(process.env.DSH_ASAR){
    const runtime=extractRuntime(process.env.DSH_ASAR,path.join(scratch,'owner-reply-sdk'));
    ({Session}=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href));
  }
}
const active={skip:!available};
const user=(id,text,source={kind:'aurabot',speaker:{role:'owner',chat:'private'}})=>({id,role:'user',content:[{type:'text',text}],source});
const answer=(text,step=1,extra={})=>({turn:1,step,message:{id:'synthetic-answer-'+step,role:'assistant',content:[{type:'text',text}]},...extra});

async function settle(t){
  for(let i=0;i<30;i++){await new Promise(setImmediate);t.mock.timers.tick(10000);}
}
function fixture(t,script,{original=false,everyStep=false,rescue=false,kind='private',who=OWNER}={}){
  t.mock.timers.enable({apis:['setTimeout']});
  const dir=fs.mkdtempSync(path.join(scratch,'owner-reply-data-')),previous=process.env.AURABOT_DATA_DIR;
  process.env.AURABOT_DATA_DIR=dir;
  const cfg=normalize({enabled:true,dryRun:false,setupDone:true,ownerQQ:OWNER,botQQ:BOT,persona:{current:'synthetic-persona'},
    workspaceDir:path.join(dir,'workspace'),allow:{private:[OTHER],groups:[GROUP]},merge:{enabled:false},
    chat:{everyStep,rescueFromThinking:rescue,ownerProgressNotices:false,turnTimeoutMinutes:0},
    voice:{enabled:false},stickers:{enabled:false,autoChance:0,collect:false,reactChance:0},
    conversationContext:{enabled:false},group:{interjectChance:0,quietHours:[0,0]}});
  const calls=[],replyCalls=[],logs=[],native=new Map();let fake,hub,entered=false,seq=0;
  const sendEvent=(session,event)=>{
    if(Session&&!Number.isSafeInteger(event.seq)){
      let log=native.get(session.id);if(!log){log=Session.create(session.id,[]);native.set(session.id,log);}
      event=log.append(event.type,event.data,['user/message','assistant/message'].includes(event.type)?{surfaceOp:'append'}:{});
    }else if(!Number.isSafeInteger(event.seq))event={...event,seq:++seq,time:Date.now()};
    hub.onSessionEvent(session,event);return event;
  };
  fake=createFakeDsh({brain:async()=>{
    entered=true;const agent=[...fake.agents.values()][0],session=agent.session;
    const emit=(type,data,extra={})=>sendEvent(session,{type,data,...extra});
    emit('turn/start',{turn:1});emit('user/message',user('initial-owner','合成实质问题'));
    const result=await script({emit,cfg,hub,dir,replay:event=>sendEvent(session,event),session});
    if(result&&typeof result==='object'&&result.reason){emit('turn/end',{turn:1,reason:{kind:result.reason}});throw Error('Synthetic terminal turn already emitted');}
    return result??'合成最后一句';
  }});
  hub=(original?createOriginalHub:createPatchedHub)({dsh:fake.ctx,getConfig:()=>cfg,random:()=>1,
    log:Object.fromEntries(['info','warn','error','debug'].map(k=>[k,(...args)=>logs.push(args.join(' '))])),
    hooks:{reply:(text)=>{replyCalls.push(text);return text;}},
    onebot:{connected:true,call:async(action,params)=>{calls.push({action,params});return{message_id:calls.length,nickname:'合成人',group_name:'合成群'};}}});
  const off=fake.ctx.on('session/event',sendEvent);
  t.after(()=>{hub.dispose();off();fake.dispose();if(previous===undefined)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=previous;});
  const run=async()=>{
    await hub.onMessage({post_type:'message',message_type:kind,sub_type:kind==='group'?'normal':'friend',self_id:Number(BOT),user_id:Number(who),message_id:123,
      ...(kind==='group'?{group_id:Number(GROUP)}:{}),sender:{user_id:Number(who),nickname:'合成人'},
      message:[...(kind==='group'?[{type:'at',data:{qq:BOT}}]:[]),{type:'text',data:{text:'合成实质问题'}}]});
    await settle(t);assert.equal(entered,true);return calls.filter(c=>['send_private_msg','send_group_msg'].includes(c.action)).flatMap(c=>c.params.message.filter(s=>s.type==='text').map(s=>s.data.text));
  };
  return{run,cfg,calls,replyCalls,hub,native,logs};
}

test('owner reply patch rejects unknown versions and hashes',()=>{
  assert.throws(()=>patchOwnerReplies('synthetic',{version:'1.3.1'}),/version/);
  assert.throws(()=>patchOwnerReplies('synthetic',{version:OWNER_REPLY_PATCH.version}),/hash/);
});
test('exact installed source transformation is idempotent and detects tampering',active,()=>{
  const first=patchOwnerReplies(source,{version:OWNER_REPLY_PATCH.version}),second=patchOwnerReplies(first.source,{version:OWNER_REPLY_PATCH.version});
  assert.equal(first.receipt.unchanged,false);assert.equal(second.receipt.unchanged,true);assert.equal(second.source,first.source);
  assert.throws(()=>patchOwnerReplies(first.source+'\n',{version:OWNER_REPLY_PATCH.version}),/hash/);
  const deployed=fs.readFileSync(path.join(host,'src/chat/hub.js'),'utf8');
  assert.equal(patchOwnerReplies(deployed,{version:OWNER_REPLY_PATCH.version}).source,first.source);
});

test('actual module scope preserves the read-only live hub patch getter while wrapping function identity',active,t=>{
  const f=fixture(t,()=>''),scoped=scopeCoreForModule({hub:f.hub},'memory');
  assert.equal(f.hub.ownerReplyPatchVersion,OWNER_REPLY_PATCH.marker);
  assert.equal(scoped.hub.ownerReplyPatchVersion,OWNER_REPLY_PATCH.marker);
  assert.equal(Object.getOwnPropertyDescriptor(f.hub,'ownerReplyPatchVersion').set,undefined);
  assert.equal(Reflect.set(scoped.hub,'ownerReplyPatchVersion','unknown'),false);
  assert.equal(Reflect.set(f.hub,'ownerReplyPatchVersion','unknown'),false);
  assert.equal(Function.prototype.toString.call(scoped.hub.onSessionEvent).includes('beginOwnerReplyBatch('),false);
  assert.equal('subagentFor' in scoped.hub,false);
});
test('unpatched actual hub reproduces the same-turn owner reply overwrite',active,async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成实质答复'));emit('user/message',user('owner-emoji','[合成表情]'));return'合成表情回应';},{original:true});
  const sent=await f.run();assert.ok(!sent.join('\n').includes('合成实质答复'));assert.ok(sent.join('\n').includes('合成表情回应'),JSON.stringify(f.logs));
});
test('actual patched hub retains the prior substantive answer at a consumed owner boundary and submits once only after completion',active,async t=>{
  const f=fixture(t,({emit})=>{
    emit('assistant/message',answer('合成实质答复一|||合成实质答复二'));
    emit('user/message',user('owner-emoji','[合成表情]'));
    assert.equal(f.replyCalls.length,0);return'合成表情回应';
  });
  const sent=await f.run(),text=sent.join('\n');assert.ok(text.includes('合成实质答复一'));assert.ok(text.includes('合成实质答复二'));assert.ok(text.includes('合成表情回应'));
  assert.equal(f.replyCalls.length,1);assert.ok(text.indexOf('合成实质答复一')<text.indexOf('合成表情回应'));
});
test('actual SDK Session emits the flat owner message shape used by the boundary', {skip:!available||!Session},async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成SDK答复'));const event=emit('user/message',user('sdk-flat-user','后一句'));assert.equal(event.data.message,undefined);assert.equal(event.data.source.kind,'aurabot');assert.ok(Array.isArray(event.data.content));return'合成SDK后一句';});
  const sent=await f.run();assert.ok(f.native.size);assert.match(sent.join('\n'),/合成SDK答复/);assert.match(sent.join('\n'),/合成SDK后一句/);
});
test('several owner boundaries preserve order and duplicate events or boundary IDs never duplicate output',active,async t=>{
  const f=fixture(t,({emit,replay})=>{
    const first=emit('assistant/message',answer('合成第一答复',1));emit('user/message',user('second-user','第二问'));
    replay(first);emit('user/message',user('second-user','第二问'));
    emit('assistant/message',answer('合成第二答复',2));emit('user/message',user('third-user','第三问'));return'合成最后答复';
  });
  const text=(await f.run()).join('\n');assert.equal(text.split('合成第一答复').length-1,1);assert.equal(text.split('合成第二答复').length-1,1);assert.ok(text.indexOf('合成第二答复')<text.indexOf('合成最后答复'));assert.equal(f.replyCalls.length,1);
});
test('without a new consumed owner message ordinary multi-step output still sends only the final reply',active,async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成过程文字'));emit('assistant/message',answer('合成另一步文字',2));return'合成最终正文';});
  const text=(await f.run()).join('\n');assert.ok(!text.includes('过程文字'));assert.ok(!text.includes('另一步文字'));assert.match(text,/合成最终正文/);
});
test('tool-bearing assistant text explicit tool calls interrupted attempts and reasoning never become preserved replies',active,async t=>{
  const f=fixture(t,({emit})=>{
    emit('assistant/message',answer('合成工具前计划',1,{message:{id:'tool-plan',role:'assistant',content:[{type:'text',text:'合成工具前计划'},{type:'tool-call',id:'call-one',name:'synthetic-tool',arguments:'{}'}]}}));
    emit('user/message',user('after-tool-plan','新消息一'));
    emit('assistant/message',answer('合成显式工具前文字',2));emit('tool/call',{turn:1,name:'synthetic-tool'});emit('user/message',user('after-explicit-tool','新消息二'));
    emit('assistant/message',answer('合成中断草稿',3,{interrupted:true}));emit('user/message',user('after-interrupted','新消息三'));
    emit('assistant/message',{turn:1,step:4,message:{content:[{type:'reasoning',text:'Final: 合成内部思考'}]}});emit('user/message',user('after-reasoning','新消息四'));return'合成可见收尾';
  });
  const text=(await f.run()).join('\n');for(const hidden of ['工具前计划','工具前文字','中断草稿','内部思考'])assert.ok(!text.includes(hidden));assert.match(text,/合成可见收尾/,JSON.stringify(f.logs));
});
test('a final tool-only or empty step cannot revive current process text or rescue reasoning on the protected path',active,async t=>{
  const f=fixture(t,({emit})=>{
    emit('assistant/message',answer('合成已完成前题'));emit('user/message',user('new-owner','新题'));
    emit('assistant/message',answer('合成不得复活过程',2));emit('tool/call',{turn:1,name:'synthetic-tool'});
    emit('assistant/message',{turn:1,step:3,message:{content:[{type:'reasoning',text:'Final: 合成不得救回思考'}]}});return'';
  },{rescue:true});
  const text=(await f.run()).join('\n');assert.match(text,/合成已完成前题/,JSON.stringify(f.logs));assert.ok(!text.includes('不得复活过程'));assert.ok(!text.includes('不得救回思考'));
});
test('runtime context direct DSH input guest input and backend input cannot seal an owner reply',active,async t=>{
  const f=fixture(t,({emit})=>{
    for(const [i,source]of [{kind:'runtime-context'},{kind:'user'},{kind:'aurabot',speaker:{role:'guest',chat:'private'}},{kind:'aurabot',speaker:{role:'owner',chat:'system'}}].entries()){
      emit('assistant/message',answer('合成未封存候选'+i,i+1));emit('user/message',user('not-owner-'+i,'合成附加输入',source));
    }return'合成最终答复';
  });
  const text=(await f.run()).join('\n');assert.ok(!text.includes('未封存候选'));assert.match(text,/合成最终答复/);
});
for(const reason of ['cancelled','error'])test('a '+reason+' turn never delivers any preserved body',active,async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成失败轮不可补发'));emit('user/message',user('owner-followup','后一句'));return{reason};});
  const text=(await f.run()).join('\n');assert.ok(!text.includes('合成失败轮不可补发'));assert.equal(f.replyCalls.length,0);
});
for(const change of ['persona','session','mode'])test('a changed '+change+' invalidates the protected completed reply before delivery',active,async t=>{
  const f=fixture(t,({emit,cfg,dir})=>{
    emit('assistant/message',answer('合成旧上下文不可发'));emit('user/message',user('owner-followup','后一句'));
    if(change==='persona')cfg.persona.current='another-synthetic-persona';
    else if(change==='mode')cfg.debug=true;
    else{const file=path.join(dir,'sessions.json'),map=JSON.parse(fs.readFileSync(file));map.chats['private:'+OWNER].sessionId='synthetic-replacement';fs.writeFileSync(file,JSON.stringify(map));}
    return'合成旧上下文最后一句';
  });
  assert.deepEqual(await f.run(),[]);assert.equal(f.replyCalls.length,0);
});
for(const [kind,who]of [['private',OTHER],['group',OWNER]])test(kind+' non-owner scope retains the existing final-only behavior',active,async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成其他范围前文'));emit('user/message',user('other-followup','后一句'));return'合成其他范围最终句';},{kind,who});
  const text=(await f.run()).join('\n');assert.ok(!text.includes('其他范围前文'));assert.match(text,/合成其他范围最终句/);
});
test('everyStep true retains its existing interim behavior without protected-batch duplication',active,async t=>{
  const f=fixture(t,({emit})=>{emit('assistant/message',answer('合成逐步第一段',1));emit('user/message',user('owner-followup','后一句'));emit('assistant/message',answer('合成逐步最终段',2));return'合成逐步最终段';},{everyStep:true});
  const text=(await f.run()).join('\n');assert.equal(text.split('合成逐步第一段').length-1,1);assert.equal(text.split('合成逐步最终段').length-1,1);
});
