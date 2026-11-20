import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {applyHunks,sha256} from '../scripts/lib/work-hours-patches.js';
const manifest=JSON.parse(fs.readFileSync(new URL('../adapters/aurabot/native/work-hours-patches.json',import.meta.url)));
test('patches require exact input and reproduce expected output',()=>{
 const before=Buffer.from('one\ntwo\nthree\n'),after=Buffer.from('one\nnew\nthree\n');
 const e={path:'synthetic',before:sha256(before),after:sha256(after),hunks:'@@ -1,3 +1,3 @@\n one\n-two\n+new\n three\n'};
 assert.deepEqual(applyHunks(before,e),after);assert.throws(()=>applyHunks(Buffer.from('different'),e));
 assert.throws(()=>applyHunks(before,{...e,after:sha256('other')}));
});
test('each host patch reproduces the tested staged source exactly',{skip:!process.env.WORK_HOURS_HOST_ROOT||!process.env.WORK_HOURS_MODULES_ROOT||!process.env.WORK_HOURS_STAGE_ROOT},()=>{
 for(const entry of manifest.entries){
  const live=path.join(entry.area==='host'?process.env.WORK_HOURS_HOST_ROOT:process.env.WORK_HOURS_MODULES_ROOT,entry.path);
  const staged=path.join(process.env.WORK_HOURS_STAGE_ROOT,entry.area,entry.path);
  const original=entry.before===null?null:fs.readFileSync(live);
  assert.deepEqual(applyHunks(original,entry),fs.readFileSync(staged),entry.path);
  assert.throws(()=>applyHunks(Buffer.from('changed code'),entry));
 }
});
