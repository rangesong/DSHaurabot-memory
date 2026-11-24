import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {nativeChatSnapshot,updateNativeChat,cleanupNativeChatBackup} from '../scripts/lib/native-chat-updater.js';

function fixture(name){
 const root=path.join(process.env.THINKSTAR_TEST_TMP,name),host=path.join(root,'host'),data=path.join(root,'data');
 for(const dir of ['release','host/src/chat','host/assets','host/models','data/modules/memory'])fs.mkdirSync(path.join(root,dir),{recursive:true});
 fs.writeFileSync(path.join(root,'release/backup-policy.json'),JSON.stringify({repository:'example/project',include_private_data:false,verify_public_download:true,verify_disk_restoration:true}));
 fs.writeFileSync(path.join(host,'package.json'),JSON.stringify({name:'dsh-aurabot-qq',version:'1.3.0-beta.1'}));fs.writeFileSync(path.join(host,'LICENSE'),'Synthetic test license');
 fs.writeFileSync(path.join(host,'src/chat/hub.js'),'export const value = 1;\n');fs.writeFileSync(path.join(host,'src/chat/hub.js.123.bak'),'keep this inactive backup');
 fs.writeFileSync(path.join(host,'assets/icon.png'),Buffer.from([137,80,78,71,0,255,128,1]));fs.writeFileSync(path.join(host,'models/private.safetensors'),'never archive model');
 fs.writeFileSync(path.join(data,'modules/memory/index.mjs'),'export default {};\n');
 const transforms=[{area:'host',path:'src/chat/hub.js',transform:source=>source.replace('value = 1','value = 2')}];
 return {root,host,data,transforms};
}
function client({failPublic=false,onPublic}={}){
 const assets=[];return {async release(){return{id:1,html_url:'https://example.test/recovery'};},async assets(){return assets;},async publish(release){return release;},
 async upload(release,name,bytes){const asset={id:assets.length+1,name,bytes:Buffer.from(bytes)};assets.push(asset);return asset;},async download(asset,{publicOnly=false}={}){if(publicOnly&&failPublic)throw Error('synthetic public failure');if(publicOnly)onPublic?.();return asset.bytes;}};
}
test('native snapshot contains complete active code and binary assets without publishing models or inactive backups',()=>{
 const f=fixture('native-snapshot'),s=nativeChatSnapshot(f);assert.equal(s.entries.size,5);assert.deepEqual(s.entries.get('host/assets/icon.png'),Buffer.from([137,80,78,71,0,255,128,1]));
 assert.ok([...s.entries.keys()].every(name=>!name.includes('/models/')&&!name.endsWith('.bak')));
});
test('native update verifies complete public disk restoration, changes only its target and cleans only its owned backup after host proof',async()=>{
 const f=fixture('native-apply'),icon=fs.readFileSync(path.join(f.host,'assets/icon.png')),before=fs.statSync(path.join(f.host,'assets/icon.png')).mtimeMs;
 const r=await updateNativeChat({...f,apply:true,client:client()});assert.equal(r.changes.length,1);assert.equal(r.archivedProgramFiles,5);assert.equal(r.public_download_verified,true);assert.equal(r.code_restoration_verified,true);
 assert.match(fs.readFileSync(path.join(f.host,'src/chat/hub.js'),'utf8'),/value = 2/);assert.deepEqual(fs.readFileSync(path.join(f.host,'assets/icon.png')),icon);assert.equal(fs.statSync(path.join(f.host,'assets/icon.png')).mtimeMs,before);
 assert.equal(fs.readFileSync(path.join(f.host,'src/chat/hub.js.123.bak'),'utf8'),'keep this inactive backup');
 assert.throws(()=>cleanupNativeChatBackup({root:f.root,receipt:r}),/host and cloud/);
 const cleanup=cleanupNativeChatBackup({root:f.root,receipt:r,hostValidated:true});assert.equal(cleanup.files,7);assert.equal(fs.existsSync(r.backup),false);assert.ok(fs.existsSync(path.join(f.host,'models/private.safetensors')));
});
test('failed native public verification leaves installed code intact and unknown repair destinations are refused',async()=>{
 const f=fixture('native-refuse');await assert.rejects(updateNativeChat({...f,apply:true,client:client({failPublic:true})}),/public failure/);assert.match(fs.readFileSync(path.join(f.host,'src/chat/hub.js'),'utf8'),/value = 1/);
 await assert.rejects(updateNativeChat({...f,transforms:[{area:'host',path:'../config.json',transform:()=> '{}'}]}),/Unreviewed/);
});
test('native backup cleanup refuses extra files and snapshot refuses unreviewed host versions',async()=>{
 const f=fixture('native-cleanup-refuse'),r=await updateNativeChat({...f,apply:true,client:client()});fs.writeFileSync(path.join(r.backup,'unknown.txt'),'keep');
 assert.throws(()=>cleanupNativeChatBackup({root:f.root,receipt:r,hostValidated:true}),/Unowned/);assert.ok(fs.existsSync(r.backup));
 fs.writeFileSync(path.join(f.host,'package.json'),JSON.stringify({name:'dsh-aurabot-qq',version:'9.9.9'}));assert.throws(()=>nativeChatSnapshot(f),/Unreviewed/);
});
test('native update refuses a newly added active source file after public verification',async()=>{
 const f=fixture('native-new-file');let added=false;
 await assert.rejects(updateNativeChat({...f,apply:true,client:client({onPublic:()=>{if(!added){added=true;fs.writeFileSync(path.join(f.host,'src/late.js'),'export const late = true;\n');}}})}),/file set changed/);
 assert.match(fs.readFileSync(path.join(f.host,'src/chat/hub.js'),'utf8'),/value = 1/);assert.ok(fs.existsSync(path.join(f.host,'src/late.js')));
});
test('native cleanup refuses recovery metadata tampering even when original tree text is retained',async()=>{
 for(const name of ['backup-manifest.json','receipt.json']){
  const f=fixture('native-metadata-'+name),r=await updateNativeChat({...f,apply:true,client:client()}),file=path.join(r.backup,name),meta=JSON.parse(fs.readFileSync(file,'utf8'));
  meta.unowned='keep this data';fs.writeFileSync(file,JSON.stringify(meta));assert.throws(()=>cleanupNativeChatBackup({root:f.root,receipt:r,hostValidated:true}),/metadata changed/);assert.ok(fs.existsSync(file));
 }
});

test('reviewed background code destinations share verified restoration and install the helper before its importers',async()=>{
 const f=fixture('native-background');
 const targets=['src/autotelic/runtime.js','src/autotelic/reflect.js','src/core/backup.js','src/core/backup-push.js','src/host.js'];
 for(const name of targets){const file=path.join(f.host,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'export const before = true;\n');}
 const transforms=targets.map(name=>({area:'host',path:name,transform:()=>"import './"+(name==='src/host.js'?'core/':'')+(name.startsWith('src/autotelic')?'../core/':'')+"backup-zip64.js';\nexport const after = true;\n"}));
 transforms.push({area:'host',path:'src/core/backup-zip64.js',transform:()=> 'export const helper = true;\n'});
 const result=await updateNativeChat({...f,transforms,apply:true,client:client()});
 assert.equal(result.changes.length,6);assert.equal(result.public_download_verified,true);assert.equal(result.code_restoration_verified,true);
 for(const name of targets)assert.match(fs.readFileSync(path.join(f.host,name),'utf8'),/after = true/);
 assert.ok(fs.existsSync(path.join(f.host,'src/core/backup-zip64.js')));
});

test('host becomes busy during recovery verification so native update leaves installed code intact',async()=>{
 const f=fixture('native-runtime-busy');
 await assert.rejects(updateNativeChat({...f,apply:true,client:client(),validateHost:async()=>{throw Error('synthetic host busy');}}),/host busy/);
 assert.match(fs.readFileSync(path.join(f.host,'src/chat/hub.js'),'utf8'),/value = 1/);
});
