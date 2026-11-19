import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createTestWorkspace,cleanupTestWorkspace,recoverTestWorkspaces,runManagedTest} from '../scripts/lib/test-workspace.js';

function fixture(t){
  const parent=fs.realpathSync(tmpdir()),root=fs.mkdtempSync(path.join(parent,'thinkstar-cleanup-test-'));
  t.after(()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('thinkstar-cleanup-test-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  return root;
}
for(const exitCode of [0,1])test(`managed test exit ${exitCode} retains reports, removes SQLite/cache, preserves memories and models`,async t=>{
  const root=fixture(t),protectedFiles=['runtime-data/v5/memory.sqlite','runtime-data/backups/necessary.sqlite','apps/memory-sea/assets/private.glb'];
  for(const file of protectedFiles){const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'private sentinel: '+file);}
  const script=`import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';const scratch=process.env.THINKSTAR_TEST_TMP;const db=new DatabaseSync(path.join(scratch,'synthetic.sqlite'));db.exec("CREATE TABLE synthetic(value TEXT)");db.prepare("INSERT INTO synthetic VALUES (?)").run("synthetic only");db.close();fs.mkdirSync(path.join(scratch,'cache'));fs.writeFileSync(path.join(scratch,'cache/generated.tmp'),'disposable');console.log('synthetic report evidence');process.exit(${exitCode});`;
  const result=await runManagedTest({root,args:['--input-type=module','-e',script]});
  assert.equal(result.code,exitCode);assert.equal(result.summary.cleanup.state,'cleaned');
  assert.equal(fs.readdirSync(path.join(root,'runtime-data/test-tmp')).length,0);
  assert.match(fs.readFileSync(path.join(result.report,'test.log'),'utf8'),/^synthetic report evidence\r?$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.report,'summary.json'))).status,exitCode?'failed':'passed');
  for(const file of protectedFiles)assert.equal(fs.readFileSync(path.join(root,file),'utf8'),'private sentinel: '+file);
});
test('unmarked directories, altered ownership and unexpected files are never deleted',t=>{
  const root=fixture(t),unmarked=path.join(root,'runtime-data/real-memory');fs.mkdirSync(unmarked,{recursive:true});fs.writeFileSync(path.join(unmarked,'memory.sqlite'),'retain');
  assert.throws(()=>cleanupTestWorkspace(root,unmarked),/Unowned/);
  const run=createTestWorkspace(root),marker={...run.marker,synthetic:false};fs.writeFileSync(run.markerPath,JSON.stringify(marker));
  assert.throws(()=>cleanupTestWorkspace(root,run.folder),/ownership/);assert.ok(fs.existsSync(run.folder));
  fs.writeFileSync(run.markerPath,JSON.stringify(run.marker));fs.writeFileSync(path.join(run.folder,'private.sqlite'),'retain');
  assert.throws(()=>cleanupTestWorkspace(root,run.folder),/Unexpected/);assert.ok(fs.existsSync(path.join(unmarked,'memory.sqlite')));
});
test('directory junctions and report redirects retain the run and leave targets intact',t=>{
  const root=fixture(t),privateDir=path.join(root,'private');fs.mkdirSync(privateDir);fs.writeFileSync(path.join(privateDir,'memory.sqlite'),'retain');
  const run=createTestWorkspace(root),link=path.join(run.scratch,'redirect');
  fs.symlinkSync(privateDir,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>cleanupTestWorkspace(root,run.folder),/link/);assert.equal(fs.readFileSync(path.join(privateDir,'memory.sqlite'),'utf8'),'retain');
  fs.unlinkSync(link);fs.rmdirSync(run.report);fs.symlinkSync(privateDir,run.report,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>cleanupTestWorkspace(root,run.folder),/link/);assert.ok(fs.existsSync(run.folder));fs.unlinkSync(run.report);
});
test('recovery removes only old stopped marked runs, retaining reports and active/unknown data',t=>{
  const root=fixture(t),stopped=createTestWorkspace(root),active=createTestWorkspace(root);
  const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0);
  const old={...stopped.marker,pid:child.pid,created_at:Date.now()-7200000};fs.writeFileSync(stopped.markerPath,JSON.stringify(old));
  fs.writeFileSync(path.join(stopped.scratch,'memory.sqlite'),'synthetic');fs.writeFileSync(path.join(stopped.report,'test.log'),'retained evidence');
  const unknown=path.join(root,'runtime-data/test-tmp/unmarked');fs.mkdirSync(unknown);fs.writeFileSync(path.join(unknown,'memory.sqlite'),'retain');
  const results=recoverTestWorkspaces(root);
  assert.equal(results.find(r=>r.id===stopped.marker.id).state,'cleaned');assert.ok(!fs.existsSync(stopped.folder));
  assert.equal(results.find(r=>r.id===active.marker.id).state,'retained_active_or_recent');assert.ok(fs.existsSync(active.folder));
  assert.equal(fs.readFileSync(path.join(stopped.report,'test.log'),'utf8'),'retained evidence');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stopped.report,'summary.json'))).status,'interrupted');assert.ok(fs.existsSync(path.join(unknown,'memory.sqlite')));
});
test('child startup errors still produce a failed report and clean the owned scratch',async t=>{
  const root=fixture(t),result=await runManagedTest({root,args:['does-not-exist.js']});
  assert.notEqual(result.code,0);assert.equal(result.summary.cleanup.state,'cleaned');assert.ok(fs.existsSync(path.join(result.report,'summary.json')));
});
test('an escaped cleanup target is rejected before filesystem deletion',t=>{
  const root=fixture(t);assert.throws(()=>cleanupTestWorkspace(root,path.dirname(root)),/Unowned/);
});
test('a locked scratch keeps its ownership marker and can be safely retried',t=>{
  const root=fixture(t),run=createTestWorkspace(root),file=path.join(run.scratch,'synthetic.sqlite');fs.writeFileSync(file,'synthetic');
  const mock=t.mock.method(fs,'rmSync',()=>{throw Object.assign(Error('locked test file'),{code:'EBUSY'});});
  try{assert.throws(()=>cleanupTestWorkspace(root,run.folder),/locked/);assert.ok(fs.existsSync(run.markerPath));assert.ok(fs.existsSync(file));}finally{mock.mock.restore();}
  assert.equal(cleanupTestWorkspace(root,run.folder).state,'cleaned');assert.ok(!fs.existsSync(run.folder));
});
