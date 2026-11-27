import test from 'node:test';
import assert from 'node:assert/strict';
import {planActivityGuard,parseWorldNowActivity} from '../extensions/aurabot/fish-world/plan-activity.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';

const NOW=Date.parse('2026-11-27T09:45:30+08:00'),W='mcp__fish-world__world_';
// Synthetic values using the verified world_now protocol prefix, not chat text.
const header='11-27 周五 09:45 · 晴 4°C',body='身体：合成饱食 · 合成精力';
const observed=({location='合成影院 · 大厅',activity='',tail=''}={})=>[header,'你在：'+location,...(activity?['在做：'+activity]:[]),body,'',tail||'· posters 看合成海报'].join('\n');
function fixture(text=observed()){
 const life=newLife(NOW-60000),data={fishId:'合成自身#1',at:{state:NOW-20000},state:{where:{kind:'trip',to:{id:'cinema'},arrive:'2026-11-27T09:45:00+08:00'},doing:null},life};
 const round={id:'synthetic-round',sessionId:'synthetic-session',startedAt:NOW-10000,status:'running',kind:'plan',planId:'synthetic-plan',observationId:'synthetic-now',observation:text,receipts:[{id:'synthetic-now',tool:W+'now',text,isError:false}]};
 const row={id:'synthetic-now',tool:W+'now',args:'{}',round:round.id,sessionId:round.sessionId,at:NOW-2000,finishedAt:NOW-1000,status:'confirmed',isError:false,result:text};
 life.round=round;life.journal.push(row);return {data,life,round,row};
}
const guarded=(f,name='do',args={id:'posters'})=>planActivityGuard(f.data,f.round,W+name,args,NOW);

test('a newer current-round server prefix confirms arrival despite a still-fresh structural trip cache',()=>{
 const f=fixture(),before=structuredClone(f);
 assert.deepEqual(parseWorldNowActivity(f.round.observation),{where:{kind:'place',text:'合成影院 · 大厅'},doing:null});
 for(const kind of ['plan','idle'])assert.equal(planActivityGuard(f.data,{...f.round,kind},W+'do',{id:'posters'},NOW),undefined);
 assert.deepEqual(f,before,'the guard never writes the shared structural snapshot or journal');
});

test('CRLF and compact world_now bodies retain the same fixed status prefix contract',()=>{
 const f=fixture(observed({tail:'这几块与上次一样，没再列。'}).replaceAll('\n','\r\n'));
 assert.equal(guarded(f),undefined);
});

test('a newer world_now that still reports travel blocks both further activity and rerouting even after the ETA clock',()=>{
 const f=fixture(observed({location:'去合成影院的路上（步行），09:40 到'}));
 assert.deepEqual(parseWorldNowActivity(f.round.observation).where,{kind:'trip',text:'去合成影院的路上（步行），09:40 到'});
 f.data.state={where:{kind:'place',place:{id:'cinema'}},doing:null};
 assert.match(guarded(f),/真实到达/);assert.match(guarded(f,'go',{place:'home'}),/真实到达/);
});

test('a newly observed long activity retains protection and only real work permits task-*',()=>{
 const f=fixture(observed({location:'合成店',activity:'在合成店打零工（10:00 下班；处理了 0 件活，没顾上 0 件）'}));
 assert.match(guarded(f,'go',{place:'home'}),/真实结束/);
 assert.match(guarded(f,'do',{id:'work'}),/真实结束/);
 assert.equal(guarded(f,'do',{id:'task-4'}),undefined);
 const tea=fixture(observed({activity:'喝合成茶（10:00 结束）'}));assert.match(guarded(tea,'do',{id:'task-4'}),/真实结束/);
});

test('the mandatory body line immediately after location confirms no current activity rather than retaining an old one',()=>{
 const f=fixture();f.data.state={where:{kind:'place'},doing:{name:'合成旧活动'}};
 assert.equal(guarded(f),undefined);
});

test('an equal or newer structural snapshot takes priority over an older successful world_now',()=>{
 for(const at of [NOW-1000,NOW]){const f=fixture();f.data.at.state=at;assert.match(guarded(f),/真实到达/);}
});

test('a server-looking header in quoted dialogue, notifications or the body cannot certify arrival',()=>{
 for(const text of ['> '+observed().replaceAll('\n','\n> '),'某条通知说已经到了\n'+observed(),'合成鱼说：\n'+observed()]){
  const f=fixture(text);assert.match(guarded(f),/真实到达/);
 }
 const trip=fixture(observed({location:'去合成影院的路上（步行），09:50 到',tail:'某条聊天：\n'+observed()}));assert.match(guarded(trip),/真实到达/);
});

test('unknown or incomplete server prefixes preserve the structural protection',()=>{
 for(const text of ['你在：合成影院\n'+body,observed().replace(body,'状态：已到达'),observed({location:'前往合成影院，约09:50抵达'}),observed().replace('11-27 周五 09:45 · 晴 4°C','合成日期'),observed().replace('你在：','你在:')]){
  const f=fixture(text);assert.match(guarded(f),/真实到达/);
 }
});

test('failed, uncertain, foreign or mismatching receipt evidence cannot supersede a structural trip',()=>{
 const changes=[
  f=>{f.row.status='failed';},f=>{f.row.status='uncertain';},f=>{f.row.isError=true;},f=>{f.round.receipts[0].isError=true;},
  f=>{f.row.tool=W+'history';},f=>{f.row.round='other-round';},f=>{f.row.sessionId='other-session';},
  f=>{f.round.receipts[0].text+='\n不同正文';},f=>{f.round.observation+='\n不同正文';},f=>{f.round.receipts=[];},
  f=>{f.row.at=f.round.startedAt-1;},f=>{f.row.finishedAt=NOW+1;},f=>{f.row.finishedAt=f.row.at-1;},
  f=>{f.round.observationId='unrecorded';},f=>{delete f.round.startedAt;},f=>{f.row.finishedAt=NaN;}
 ];
 for(const change of changes){const f=fixture();change(f);assert.match(guarded(f),/真实到达/);}
});

test('a later submitted go/do invalidates a pre-action arrival observation instead of permitting a second route',()=>{
 for(const name of ['go','do'])for(const status of ['executing','confirmed','uncertain']){
  const f=fixture();f.life.journal.push({id:'later-action',tool:W+name,args:'{}',round:f.round.id,sessionId:f.round.sessionId,at:NOW-500,status});
  assert.match(guarded(f,'go',{place:'home'}),/真实到达/,name+' '+status);
 }
});

test('actions from another round/session and rejected calls do not erase the verified current observation',()=>{
 for(const extra of [{round:'other-round'},{sessionId:'other-session'},{status:'failed'}]){
  const f=fixture();f.life.journal.push({id:'unrelated-action',tool:W+'go',round:f.round.id,sessionId:f.round.sessionId,at:NOW-500,status:'confirmed',...extra});
  assert.equal(guarded(f),undefined);
 }
});

test('a later current-round world_now can supersede a completed earlier action',()=>{
 const f=fixture();f.life.journal.unshift({id:'earlier-action',tool:W+'go',round:f.round.id,sessionId:f.round.sessionId,at:NOW-4000,finishedAt:NOW-3000,status:'confirmed'});
 assert.equal(guarded(f),undefined);
});

test('arrival observations do not bypass recorded action deduplication',()=>{
 const f=fixture();f.life.plans=[{id:f.round.planId,nextStep:'同一合成步骤',lastProgressProof:{executedStep:'同一合成步骤',actions:[{tool:W+'do',args:{id:'posters',request_id:'old'}}]}}];
 assert.match(guarded(f,'do',{id:'posters',request_id:'new'}),/成功回执/);
});

test('private owner, recovery, trusted event and nonmovement tool paths retain their original scope',()=>{
 const f=fixture(observed({location:'去合成影院的路上（步行），09:50 到'}));
 for(const kind of ['owner','owner-task','recovery','work','message','arrive'])assert.equal(planActivityGuard(f.data,{...f.round,kind},W+'go',{place:'home'},NOW),undefined);
 assert.equal(planActivityGuard(f.data,{...f.round,readOnly:true},W+'go',{place:'home'},NOW),undefined);
 for(const name of ['now','history','find','profile','say','friends','update'])assert.equal(guarded(f,name,{}),undefined);
});

test('actual LifeEngine.result records the qualifying observation and actual guard still enforces intent and identity',()=>{
 const data={fishId:'合成自身#1',at:{state:NOW-20000},state:{where:{kind:'trip',to:{id:'cinema'}},doing:null},life:newLife(NOW-60000)};
 const bridge={data,change:fn=>fn(data)},engine=new LifeEngine({bridge,host:{},clock:()=>NOW});
 const round=engine.l.round={id:'real-result-fixture',kind:'plan',sessionId:'bg',status:'running',revision:engine.l.revision,priority:3,calls:0,startedAt:NOW-1000,receipts:[],events:[],observation:'',identityConfirmed:false};
 const agent={session:{id:'bg'}},read={name:W+'now',arguments:{},agent,callId:'actual-now'};
 assert.equal(engine.guard(read,true,false),undefined);engine.result(read,{content:[{type:'text',text:observed()}]});
 assert.equal(round.observationId,read.callId);assert.equal(data.state.where.kind,'trip');
 const action={name:W+'do',arguments:{id:'posters'},agent,callId:'actual-posters'};
 assert.match(engine.guard(action,true,false),/world_profile/);
 round.identityConfirmed=true;assert.match(engine.guard(action,true,false),/声明/);
 const intent=engine.intent({tool:W+'do',arguments:'{"id":"posters"}',category:'daily',cost:0,evidence:'· posters 看合成海报'});
 assert.equal(engine.guard({...action,arguments:intent.arguments},true,false),undefined);
 assert.equal(engine.l.journal.at(-1).id,'actual-posters');assert.equal(engine.l.journal.at(-1).status,'executing');
});
