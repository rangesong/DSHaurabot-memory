import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {FishPeopleStore,FISH_PEOPLE_ORIGIN,fishPeopleScope,parseFishDialogue} from '../extensions/aurabot/fish-world/people.mjs';

const now=Date.parse('2026-11-26T12:00:00+08:00'),HISTORY='mcp__fish-world__world_history';
const block=(speaker,text,when='2026-11-25 10:00',extra='')=>speaker+'（消息，'+when+extra+'）：\n> '+text;
const page=(text,footer='m_1')=>text+'\n\n'+(footer?'—— 更早的：before='+footer+'\n':'')+'—— 现在 12:00 · 合成地点';
const row=(id,result,extra={})=>({id,tool:HISTORY,args:JSON.stringify({fish:'#42'}),status:'confirmed',isError:false,at:now-100,finishedAt:now,result,...extra});
function fixture(){
 assert.ok(process.env.THINKSTAR_TEST_TMP,'Use scripts/run-tests.js');
 const dir=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'fish-people-')),file=path.join(dir,'people.json');
 let time=now;const identity={owner:'synthetic-owner',persona:'synthetic-persona',selfFishId:'自己鱼#1',apiOrigin:FISH_PEOPLE_ORIGIN};
 const create=()=>new FishPeopleStore({file,identity:()=>identity,clock:()=>time});
 return {file,identity,store:create(),create,time:value=>{time=value;}};
}

test('fish identity is typed, canonical and isolated by owner persona self and fixed origin across reload',()=>{
 const f=fixture();f.store.ingestJournal([row('a',page(block('对方鱼#42','合成原话')))]);
 assert.equal(f.store.list().list[0].fish,'#42');assert.equal(f.store.list().list[0].type,'fish-world');assert.equal(f.create().detail('另一个显示名#42').observations.length,1);
 for(const key of ['owner','persona','selfFishId']){const before=f.identity[key];f.identity[key]=key==='selfFishId'?'自己鱼#2':'another';assert.equal(f.store.list().total,0);f.identity[key]=before;}
 f.identity.apiOrigin='https://example.invalid';assert.equal(f.store.available(),false);f.identity.apiOrigin=FISH_PEOPLE_ORIGIN;
 assert.equal(f.store.list().total,1);for(const value of ['42','某条鱼','#0'])assert.throws(()=>f.store.detail(value));
 assert.equal(fishPeopleScope(f.identity).selfFishId,'#1');
});

test('peer history keeps both speakers complete original text and time while quoted third fish and footer stay data',()=>{
 const f=fixture(),quote='对方说了一句话\n> 第三鱼#99（消息，今天 11:00）：\n> 这是原话里的引用';
 const original=page(block('对方鱼#42',quote)+'\n\n'+block('你','我按原话回答','2026-11-25 10:01'));
 const result=f.store.ingestJournal([row('a',original)],{backfill:true});assert.equal(result.added,2);
 const detail=f.store.detail('#42');assert.deepEqual(detail.observations.map(x=>x.role).sort(),['peer','self']);
 assert.equal(detail.person.lastInteraction,Date.parse('2026-11-25T10:01:00+08:00'));assert.equal(detail.person.summary,'');
 assert.equal(detail.observations.find(x=>x.role==='peer').text,block('对方鱼#42',quote));
 assert.ok(detail.observations.every(x=>x.historical));assert.ok(detail.observations.every(x=>!x.text.includes('before=')));
 assert.equal(f.store.detail('#99').person,null);assert.equal(detail.impression.text,'');
});

test('relative dates anchor to original receipt and duplicate rereads retain canonical sources and first observation time',()=>{
 const f=fixture(),first=row('old',page(block('对方鱼#42','原来那句话','昨天 10:00')));
 const a=f.store.ingestJournal([first],{backfill:true}),id=a.receiptSourceIds.old[0],stored=f.store.detail('#42').observations[0];
 assert.equal(stored.occurredAt,Date.parse('2026-11-25T10:00:00+08:00'));
 f.time(now+86400000*30);
 const second=row('new',page(block('对方鱼#42','原来那句话','前天 10:00'),'m_other'),{at:now+86400000-100,finishedAt:now+86400000});
 const b=f.store.ingestJournal([second]);assert.equal(b.added,0);assert.deepEqual(b.receiptSourceIds.new,[id]);
 const repeated=f.store.ingestJournal([first,second]);assert.equal(repeated.added,0);assert.deepEqual(repeated.receiptSourceIds.new,[id]);
 assert.deepEqual(f.store.detail('#42').observations[0],stored);assert.equal(f.create().detail('#42').person.sourceCount,1);
 f.store.setPortrait({fish:'#42',text:'只保留这次明确说过的内容，不扩展为性格结论。',sourceIds:['new']});assert.deepEqual(f.store.detail('#42').impression.evidenceIds,[id]);
});

test('server read-status and age tails do not become dialogue body or create a new source',()=>{
 const f=fixture(),speech=block('对方鱼#42','原话里保留\n> 第三鱼#99（消息，今天 10:10）：\n> 引用并非新的发言者');
 const a=f.store.ingestJournal([row('a',page(speech+'\n（服务器状态：未读）\n—— 十分钟前'))]);
 const b=f.store.ingestJournal([row('b',page(speech+'\n（服务器状态：已读）\n—— 一小时前'))]);
 assert.equal(a.added,1);assert.equal(b.added,0);assert.deepEqual(a.receiptSourceIds.a,b.receiptSourceIds.b);
 const source=f.store.detail('#42').observations[0];assert.match(source.text,/服务器状态/);assert.doesNotMatch(source.body,/服务器状态|十分钟前/);assert.match(source.body,/第三鱼#99/);assert.equal(f.store.detail('#99').person,null);
});

test('a real peer header with only action metadata or unquoted text stays auditable but cannot support a portrait',()=>{
 const f=fixture(),header='对方鱼#42（消息，2026-11-25 10:00）：';
 for(const [index,body]of ['—— 说要请她合成活动（收下了）','没有引用前缀的句子','> \n—— 收下了请的合成活动'].entries()){
  const original=header+'\n'+body,receipt='action-only-'+index;
  f.store.ingestJournal([row(receipt,page(original))]);
  const observation=f.store.detail('#42').observations.find(source=>source.text===original);
  assert.ok(observation);assert.equal(observation.kind,'observation');assert.equal(observation.role,'unknown');assert.equal(observation.speaker,null);assert.equal(observation.body,body);
  assert.throws(()=>f.store.setPortrait({fish:'#42',text:'不能把附注当对方发言',sourceIds:[receipt]}),/不能单独/);
 }
 assert.equal(f.store.detail('#42').person.lastInteraction,null);assert.equal(f.store.detail('#42').impression.text,'');
});

test('unknown date and unnumbered unknown speaker are explicit evidence only rather than invented current facts',()=>{
 const f=fixture();f.store.ingestJournal([row('a',page(block('未核对名字','未知日期原文','11月22日 10:00')+'\n\n'+block('第三鱼#99','不得归到对方身上')))]);
 const detail=f.store.detail('#42');assert.equal(detail.observations.length,1);assert.equal(detail.observations[0].role,'unknown');assert.equal(detail.observations[0].occurredAt,null);assert.equal(detail.person.lastInteraction,null);
 assert.throws(()=>f.store.setPortrait({fish:'#42',text:'不应形成',sourceIds:['a']}),/不能单独/);
 assert.equal(parseFishDialogue(page(block('对方名','确认名称匹配')), {peer:'#42',selfFishId:'#1',peerName:'对方名',observedAt:now})[0].role,'peer');
 const guessed=row('guess',page(block('猜测名字','不能靠调用参数猜测说话人')),{args:'{"fish":"猜测名字#42"}'});f.store.ingestJournal([guessed]);assert.equal(f.store.detail('#42').observations.find(x=>x.body==='不能靠调用参数猜测说话人').role,'unknown');
});

test('invalid calendar dates and future times retain raw time without advancing an interaction or inventing a day',()=>{
 const f=fixture();
 for(const [index,when]of ['2026-02-30T10:00:00+08:00','2026-02-30 10:00','今天 23:00','10:00'].entries()){
  f.store.ingestJournal([row('time-'+index,page(block('对方鱼#42','时间不明'+index,when)))]);
 }
 const detail=f.store.detail('#42');assert.equal(detail.person.lastInteraction,null);assert.ok(detail.observations.every(x=>x.occurredAt===null));assert.ok(detail.observations.some(x=>x.rawTime.includes('2026-02-30')));
});

test('message IDs and outbound request IDs are durable source keys rather than new native call IDs',()=>{
 const f=fixture(),p=page(block('对方鱼#42','这是一条消息','2026-11-25 10:00','，id=m_original'));
 f.store.ingestJournal([row('a',p),row('b',p)]);assert.equal(f.store.detail('#42').person.sourceCount,1);
 f.store.ingestJournal([row('bad',page(block('对方鱼#42','同ID不能悄悄换正文','2026-11-25 10:00','，id=m_original')))]);
 assert.equal(f.store.detail('#42').person.sourceCount,1);assert.match(f.store.detail('#42').observations[0].text,/这是一条消息/);
 const say=row('say1','好的。\n—— 现在 12:00',{tool:'mcp__fish-world__world_say',args:JSON.stringify({fish:'#42',text:'我实际发出的消息',request_id:'business-request'})});
 const a=f.store.ingestJournal([say]),b=f.store.ingestJournal([{...say,id:'say2',at:now+10000,finishedAt:now+11000}]);
 assert.equal(a.added,1);assert.equal(b.added,0);assert.deepEqual(a.receiptSourceIds.say1,b.receiptSourceIds.say2);
 const out=f.store.detail('#42').observations.find(x=>x.requestId);assert.equal(out.role,'self');assert.equal(out.text,'我实际发出的消息');assert.equal(out.occurredAt,null);
});

test('failed uncertain self-only timeline and mismatched owner receipts cannot enter fish people',()=>{
 const f=fixture(),text=page(block('对方鱼#42','不能进入'));
 for(const extra of [{status:'failed'},{status:'uncertain'},{isError:true},{owner:'other'},{persona:'other'},{selfFishId:'#9'},{args:'{}'},{args:'{"fish":"只有名字"}'},{args:'{"fish":"#1"}'},{tool:'fish_life_history'},{tool:HISTORY,result:''}]){
  assert.equal(f.store.ingestJournal([row('x'+JSON.stringify(extra),text,extra)]).added,0);
 }
 assert.equal(f.store.list().total,0);
});

test('public peer profile and explicit friend list supply labelled facts without creating a personality',()=>{
 const f=fixture();f.store.ingestJournal([
  row('profile','对方鱼#42\n> 外貌：合成外貌\n> 穿着：合成衣服',{tool:'mcp__fish-world__world_profile'}),
  row('friends','好友（2/50）：\n· 对方鱼#42 在线\n· 另一鱼#43 离线\n> 第三鱼#99 是引用',{tool:'mcp__fish-world__world_friends',args:'{"action":"list"}'}),
  row('wrong-profile','第三鱼#99\n> 外貌：不匹配',{tool:'mcp__fish-world__world_profile'})
 ]);
 const detail=f.store.detail('#42');assert.equal(f.store.list().total,2);assert.equal(detail.person.name,'对方鱼');assert.equal(detail.person.summary,'');assert.equal(detail.person.lastInteraction,null);
 assert.deepEqual(detail.observations.map(x=>x.kind).sort(),['friend','profile']);
 assert.throws(()=>f.store.setPortrait({fish:'#42',text:'凭外貌猜性格',sourceIds:['profile']}),/不能单独/);
 assert.equal(f.store.detail('#99').person,null);
});

test('portraits require same-peer real dialogue evidence, replace only on success and do not count rereads as new support',()=>{
 const f=fixture();f.store.ingestJournal([row('a',page(block('对方鱼#42','亲自说过的依据'))),row('b',page(block('另一鱼#43','另一条依据')),{args:'{"fish":"#43"}'})]);
 const input={fish:'#42',text:'只就已经确认的往来形成暂定印象，资料少时明确资料有限。',sourceIds:['a']};
 f.store.setPortrait(input);const before=f.store.detail('#42').impression;
 assert.throws(()=>f.store.setPortrait({...input,sourceIds:['b']}),/不属于/);assert.throws(()=>f.store.setPortrait({...input,sourceIds:['invented']}));assert.throws(()=>f.store.setPortrait({...input,text:'长'.repeat(181)}));
 assert.deepEqual(f.store.detail('#42').impression,before);f.time(now+5000);assert.equal(f.store.setPortrait(input).unchanged,true);assert.deepEqual(f.store.detail('#42').impression,before);
 assert.equal(f.store.setPortrait({...input,text:'相同旧页即使换措辞也不刷新印象。'}).unchanged,true);assert.deepEqual(f.store.detail('#42').impression,before);
 f.store.ingestJournal([row('later',page(block('对方鱼#42','真实的新往来','2026-11-26 11:00')))]);
 f.store.setPortrait({...input,text:'这是依据真实新往来成功更新的暂定认识。',sourceIds:['later']});const latest=f.store.detail('#42').impression;assert.notEqual(latest.text,before.text);assert.ok(latest.evidenceOccurredAt>before.evidenceOccurredAt);
 f.store.ingestJournal([row('older',page(block('对方鱼#42','刚读到但其实更旧','2026-11-20 10:00')))]);
 assert.equal(f.store.setPortrait({...input,text:'旧历史不能覆盖较新印象。',sourceIds:['older']}).unchanged,true);assert.deepEqual(f.store.detail('#42').impression,latest);
});

test('explicit correction disables portrait and old history cannot revive it',()=>{
 const f=fixture();f.store.ingestJournal([row('a',page(block('对方鱼#42','过去依据')))]);f.store.setPortrait({fish:'#42',text:'旧暂定认识',sourceIds:['a']});
 f.store.disablePortrait({fish:'#42',reason:'主人明确纠正这条印象'});assert.equal(f.store.detail('#42').impression.disabled,true);assert.equal(f.store.list().list[0].summary,'');assert.doesNotMatch(f.store.lookup('#42'),/旧暂定认识/);
 assert.throws(()=>f.store.setPortrait({fish:'#42',text:'不能由旧史自动复活',sourceIds:['a']}),/停用/);
 const next=now+600000;f.time(next);f.store.ingestJournal([row('new',page(block('对方鱼#42','新的实际交流','2026-11-26 12:05')),{at:next-100,finishedAt:next})]);
 f.store.setPortrait({fish:'#42',text:'基于新往来重新形成的认识',sourceIds:['new']});assert.equal(f.store.detail('#42').impression.disabled,false);
});

test('listing detail and lookup stay bounded without cutting stored original blocks or leaking another peer',()=>{
 const f=fixture();const rows=Array.from({length:24},(_,i)=>row('a'+i,page(block('对方鱼#42','原文'+i+'"\\'.repeat(150),'2026-11-25 10:'+String(i).padStart(2,'0')))));
 f.store.ingestJournal(rows);f.store.ingestJournal([row('other',page(block('另一鱼#43','别的鱼不可混入')),{args:'{"fish":"#43"}'})]);
 const first=f.store.detail('#42',{limit:3});assert.equal(first.observations.length,3);assert.equal(first.nextOffset,3);assert.equal(first.total,24);
 const lookup=f.store.lookup('#42',{maxChars:600});assert.ok(lookup.length<=600);assert.doesNotMatch(lookup,/别的鱼不可混入/);assert.match(lookup,/sourceCount/);assert.match(lookup,/未展示不等于没有记录/);assert.equal(f.store.detail('#42',{limit:30}).observations.length,24);
 assert.throws(()=>f.store.list({limit:51}));assert.throws(()=>f.store.lookup('#42',{maxChars:5000}));assert.equal(f.store.lookup('#99'),'');
});

test('bounded lookup keeps a full 180-character portrait when twenty evidence IDs exceed its metadata budget',()=>{
 const f=fixture(),rows=Array.from({length:20},(_,i)=>row('portrait-'+i,page(block('对方鱼#42','真实依据'+i,'2026-11-25 10:'+String(i).padStart(2,'0')))));
 const ingested=f.store.ingestJournal(rows),ids=Object.values(ingested.receiptSourceIds).flat(),text='印'.repeat(180);
 f.store.setPortrait({fish:'#42',text,sourceIds:ids});const lookup=f.store.lookup('#42',{maxChars:1200});assert.ok(lookup.length<=1200);assert.ok(lookup.includes(text));
 const projection=JSON.parse(lookup.slice(lookup.indexOf('\n')+1));assert.equal(projection.impression.evidenceCount,20);assert.equal(projection.impression.evidenceIds.length,2);assert.equal(projection.impression.evidenceOmitted,true);
 assert.equal(f.store.detail('#42').impression.evidenceIds.length,20);const minimal=f.store.lookup('#42',{maxChars:200});assert.ok(minimal.length<=200);assert.ok(minimal.includes(text));
});

test('corrupt store is preserved and an identity change before persistence rolls back the entire write',()=>{
 const f=fixture();fs.writeFileSync(f.file,'{broken');const before=fs.readFileSync(f.file,'utf8'),bad=f.create();assert.equal(bad.list().available,false);assert.throws(()=>bad.ingestJournal([]));assert.equal(fs.readFileSync(f.file,'utf8'),before);
 const g=fixture();let calls=0;const store=new FishPeopleStore({file:g.file,identity:()=>({...g.identity,selfFishId:++calls>1?'#2':'#1'}),clock:()=>now});
 assert.throws(()=>store.ingestJournal([row('a',page(block('对方鱼#42','不能跨身份提交')))]),/身份已改变/);assert.equal(fs.existsSync(g.file),false);
});
