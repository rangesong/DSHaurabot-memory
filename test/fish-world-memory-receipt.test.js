import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife,dayKey} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
const start=Date.parse('2026-11-22T10:00:00+08:00');
function fixture(remember){
 let now=start;
 const data={version:3,life:newLife(start)},bridge={data,change:fn=>fn(data)};
 const e=new LifeEngine({bridge,host:{remember},authorized:()=>false,clock:()=>now});
 e.l.journal.push({id:'synthetic-memory',memory:'pending',at:start,summary:'合成重要经历',receipts:['synthetic-proof']});
 return {e,time:value=>{now=value;}};
}
test('memory rejection and debug-only no-write receipts remain pending while native and ingest successes retain compatibility',async()=>{
 for(const receipt of [null,undefined,false,{ok:false,message:'合成拒写'},{ok:true,error:'合成失败'},{isError:true},{ok:true,debug:true}]){
  const f=fixture(async()=>receipt);await f.e.remember('synthetic-memory');assert.equal(f.e.l.journal[0].memory,'pending');
 }
 for(const receipt of [{ok:true,id:'native-insert'},{ok:true,updated:'native-update'},{memory_id:'thinkstar',replayed:false},{memory_id:'thinkstar',replayed:true},true,'legacy-id']){
  const f=fixture(async()=>receipt);await f.e.remember('synthetic-memory');assert.equal(f.e.l.journal[0].memory,'recorded');
 }
});
test('a refused important memory retries at the existing five-minute deadline and stops after success',async()=>{
 let calls=0;const f=fixture(async()=>++calls===1?{ok:false}:{ok:true,id:'synthetic-success'});
 await f.e.tick();assert.equal(calls,1);assert.equal(f.e.l.journal[0].memory,'pending');assert.equal(f.e.l.journal[0].memoryRetryAt,start+300000);
 f.time(start+299999);await f.e.tick();assert.equal(calls,1);
 f.time(start+300000);await f.e.tick();assert.equal(calls,2);assert.equal(f.e.l.journal[0].memory,'recorded');
 f.time(start+600000);await f.e.tick();assert.equal(calls,2);
});
test('a thrown memory failure retains the complete original experience for a later retry',async()=>{
 const f=fixture(async()=>{throw Error('synthetic failure');}),before=structuredClone(f.e.l.journal[0]);
 await f.e.remember('synthetic-memory');assert.deepEqual(f.e.l.journal[0],before);
});
test('Beijing date keys preserve midnight leap-day and year boundaries across numeric and Date inputs',()=>{
 const cases=[['2026-11-21T15:59:59.999Z','2026-11-21'],['2026-11-21T16:00:00Z','2026-11-22'],['2024-02-28T16:00:00Z','2024-02-29'],['2024-02-29T16:00:00Z','2024-03-01'],['2026-12-31T16:00:00Z','2027-01-01']];
 for(const [value,expected]of cases){assert.equal(dayKey(Date.parse(value)),expected);assert.equal(dayKey(new Date(value)),expected);}
});
