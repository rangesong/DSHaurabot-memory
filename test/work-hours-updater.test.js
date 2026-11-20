import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {sha256} from '../scripts/lib/work-hours-patches.js';import {updateWorkHours} from '../scripts/lib/work-hours-updater.js';
const tmp=process.env.THINKSTAR_TEST_TMP;
function fixture(name){
 const base=path.join(tmp,name),root=path.join(base,'project'),host=path.join(base,'host'),modules=path.join(base,'modules');
 for(const p of [path.join(root,'release'),host,modules])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(path.join(root,'release/backup-policy.json'),JSON.stringify({repository:'example/project',include_private_data:false,verify_public_download:true,verify_disk_restoration:true}));
 const before=Buffer.from('one\ntwo\nthree\n'),after=Buffer.from('one\nnew\nthree\n');fs.writeFileSync(path.join(host,'source.js'),before);
 const manifest={schema:1,entries:[{area:'host',path:'source.js',before:sha256(before),after:sha256(after),hunks:'@@ -1,3 +1,3 @@\n one\n-two\n+new\n three\n'},{area:'modules',path:'new.js',before:null,after:sha256('new file\n'),content:'new file\n'}]};
 return {root,host,modules,manifest,before,after};
}
function fakeClient({failPublic=false}={}){
 let items=[];return {async release(){return {id:1,html_url:'https://example.test/release'};},async assets(){return items;},async publish(r){return r;},
 async upload(r,name,bytes){const a={id:items.length+1,name,bytes:Buffer.from(bytes)};items.push(a);return a;},
 async download(a,{publicOnly=false}={}){if(publicOnly&&failPublic)throw Error('public download blocked');return a.bytes;}};
}
test('verified public recovery precedes all updates and local rollback is retained',async()=>{
 const f=fixture('success'),preview=await updateWorkHours({...f});assert.equal(preview.changes.length,2);assert.deepEqual(fs.readFileSync(path.join(f.host,'source.js')),f.before);
 const r=await updateWorkHours({...f,apply:true,client:fakeClient()});assert.equal(r.public_download_verified,true);assert.equal(r.code_restoration_verified,true);
 assert.deepEqual(fs.readFileSync(path.join(f.host,'source.js')),f.after);assert.equal(fs.readFileSync(path.join(f.modules,'new.js'),'utf8'),'new file\n');
 assert.deepEqual(fs.readFileSync(path.join(r.backup,'host/source.js')),f.before);assert.equal(r.cleanup,'retained-until-host-validation');
});
test('failed public verification leaves installed files untouched',async()=>{
 const f=fixture('fail');await assert.rejects(updateWorkHours({...f,apply:true,client:fakeClient({failPublic:true})}),/public download blocked/);
 assert.deepEqual(fs.readFileSync(path.join(f.host,'source.js')),f.before);assert.equal(fs.existsSync(path.join(f.modules,'new.js')),false);
});
test('unexpected source changes and paths outside the declared root are refused',async()=>{
 const f=fixture('stale');fs.writeFileSync(path.join(f.host,'source.js'),'changed');await assert.rejects(updateWorkHours({...f}),/baseline/);
 const g=fixture('escape');g.manifest.entries[0].path='../outside';await assert.rejects(updateWorkHours({...g}),/Invalid relative path/);
});
