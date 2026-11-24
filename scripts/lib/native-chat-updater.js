import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkedPath} from './context-module-updater.js';
import {sha256} from './work-hours-patches.js';
import {updateWorkHours} from './work-hours-updater.js';

const roots=new Set(['src','client','docs','test','assets']);
const rootFiles=new Set(['package.json','LICENSE','README.md','README_EN.md','CHANGELOG.md','THIRD-PARTY-NOTICES.md','cordis.patch.yml']);
const extensions=new Set(['.js','.mjs','.cjs','.ts','.py','.json','.md','.txt','.yml','.yaml','.html','.css','.svg','.png','.jpg','.jpeg','.gif','.webp']);
const need=(ok,message)=>{if(!ok)throw Error(message);};
function programBytes(file){
 const bytes=fs.readFileSync(file);
 if(/\.(?:js|mjs|cjs|ts|py|json|md|txt|yml|yaml|html|css|svg)$/.test(file))need(!/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|fwr?_[A-Za-z0-9_-]{12,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString()),'Credential-like content in program; keep installed code');
 return bytes;
}
export function nativeChatSnapshot({host,data}){
 need(path.isAbsolute(host)&&path.isAbsolute(data),'Absolute native host and data roots required');
 host=checkedPath(host,host);data=checkedPath(data,data);
 const pkg=JSON.parse(fs.readFileSync(checkedPath(host,path.join(host,'package.json')),'utf8'));
 need(pkg.name==='dsh-aurabot-qq'&&pkg.version==='1.3.0-beta.1','Unreviewed Aurabot host version');
 const entries=new Map();let bytes=0;
 const add=(key,file)=>{const value=programBytes(file);bytes+=value.length;need(bytes<=48*1024*1024&&entries.size<1000,'Native code archive exceeds reviewed bounds');entries.set(key,value);};
 function visit(folder,relative){
  for(const item of fs.readdirSync(folder,{withFileTypes:true})){
   // Pre-existing inactive code backups are kept in place and never published or cleaned here.
   if(item.isFile()&&/\.(?:js|mjs)(?:\.[0-9A-Za-z.-]+)?\.bak$/.test(item.name))continue;
   const rel=relative+'/'+item.name,file=checkedPath(host,path.join(host,rel));
   need(!item.isSymbolicLink(),'Linked native code refused');
   if(item.isDirectory()){need(!['node_modules','.git','runtime-data','modules-data','chatlog','models','personas'].includes(item.name),'Private or dependency directory inside program tree');visit(file,rel);}
   else {need(item.isFile()&&extensions.has(path.extname(item.name)),'Unreviewed native program entry: '+rel);add('host/'+rel,file);}
  }
 }
 for(const item of fs.readdirSync(host,{withFileTypes:true})){
  if(item.isDirectory()&&roots.has(item.name))visit(checkedPath(host,path.join(host,item.name)),item.name);
  else if(item.isFile()&&rootFiles.has(item.name))add('host/'+item.name,checkedPath(host,path.join(host,item.name)));
 }
 const modules=checkedPath(data,path.join(data,'modules')),memory=checkedPath(data,path.join(modules,'memory'));
 for(const item of fs.readdirSync(memory,{withFileTypes:true})){
  if(item.isDirectory()){need(item.name==='.aurabot-cache','Unexpected native memory code directory');continue;}
  need(item.isFile()&&!item.isSymbolicLink()&&/^[a-z][a-z0-9-]*\.(?:js|mjs)$/.test(item.name),'Unreviewed native memory code entry');
  add('modules/memory/'+item.name,checkedPath(data,path.join(memory,item.name)));
 }
 need(entries.has('host/LICENSE')&&entries.has('host/src/chat/hub.js')&&entries.has('modules/memory/index.mjs'),'Incomplete native program snapshot');
 return {host,data,modules,version:pkg.version,entries,bytes};
}
function replacementHunk(before,after){
 const old=before.toString('utf8').split('\n'),next=after.toString('utf8').split('\n');
 return `@@ -1,${old.length} +1,${next.length} @@\n`+old.map(line=>'-'+line).concat(next.map(line=>'+'+line)).join('\n')+'\n';
}
export async function updateNativeChat({root,host,data,transforms,apply=false,client,validateHost}){
 const snapshot=nativeChatSnapshot({host,data}),entries=new Map(snapshot.entries),changes=[];
 need(Array.isArray(transforms)&&transforms.length>0,'Reviewed native transforms required');
 const seen=new Set();
 for(const change of transforms){
  const key=change.area+'/'+change.path;
  need(['host/src/chat/hub.js','modules/memory/index.mjs','modules/memory/context-review.js','host/src/autotelic/runtime.js','host/src/autotelic/reflect.js','host/src/core/backup.js','host/src/core/backup-push.js','host/src/core/backup-zip64.js','host/src/host.js'].includes(key)&&!seen.has(key),'Unreviewed or duplicate native repair target');seen.add(key);
  const before=entries.get(key),next=change.transform(before?.toString('utf8')??null,{version:snapshot.version});
  need(typeof next==='string'&&next.length>0,'Native transform produced no code');
  const syntax=spawnSync(process.execPath,['--check','--input-type=module'],{input:next,encoding:'utf8',windowsHide:true});
  need(syntax.status===0,'Native patched syntax invalid');
  const after=Buffer.from(next);entries.set(key,after);if(!before||sha256(before)!==sha256(after))changes.push({path:key,before:before?sha256(before):null,after:sha256(after)});
 }
 if(!changes.length)return {version:snapshot.version,unchanged:true,changes:[],configuration_modified:false,private_data_included:false};
 // Unchanged source entries are archived for complete code recovery, but never rewritten.
 const manifest={schema:1,entries:[...entries].map(([key,next])=>{
  const slash=key.indexOf('/'),area=key.slice(0,slash),file=key.slice(slash+1),old=snapshot.entries.get(key),before=old?sha256(old):null,after=sha256(next);
  return {area,path:file,before,after,...(!old?{content:next.toString('utf8')}:{hunks:before===after?'':replacementHunk(old,next)})};
 })};
 const fingerprint=entries=>sha256(JSON.stringify([...entries].map(([name,value])=>({name,sha256:sha256(value)})).sort((a,b)=>a.name.localeCompare(b.name,'en'))));
 const initialTree=fingerprint(snapshot.entries),beforeCommit=async()=>{await validateHost?.();need(fingerprint(nativeChatSnapshot({host:snapshot.host,data:snapshot.data}).entries)===initialTree,'Native program file set changed during recovery verification');};
 const receipt=await updateWorkHours({root,host:snapshot.host,modules:snapshot.modules,manifest,apply,client,archiveLabel:'native-chat',beforeCommit});
 const metadataHashes=apply?{backup_manifest_sha256:sha256(fs.readFileSync(checkedPath(root,path.join(receipt.backup,'backup-manifest.json')))),backup_receipt_sha256:sha256(fs.readFileSync(checkedPath(root,path.join(receipt.backup,'receipt.json'))))}:{};
 return {...receipt,...metadataHashes,version:snapshot.version,changes,archivedProgramFiles:snapshot.entries.size,archivedProgramBytes:snapshot.bytes,restart_required:apply};
}
export function cleanupNativeChatBackup({root,receipt,hostValidated=false}){
 need(hostValidated&&receipt.public_download_verified&&receipt.code_restoration_verified,'Verified host and cloud recovery required');
 const parent=checkedPath(root,path.join(root,'runtime-data/installations')),folder=checkedPath(root,receipt.backup);
 need(path.dirname(folder)===parent&&/^native-chat-[a-f0-9-]+$/.test(path.basename(folder)),'Unowned native code backup');
 const manifestBytes=fs.readFileSync(checkedPath(root,path.join(folder,'backup-manifest.json'))),receiptBytes=fs.readFileSync(checkedPath(root,path.join(folder,'receipt.json')));
 need(sha256(manifestBytes)===receipt.backup_manifest_sha256&&sha256(receiptBytes)===receipt.backup_receipt_sha256,'Native recovery metadata changed');
 const manifest=JSON.parse(manifestBytes);
 need(manifest.kind==='aurabot-native-chat-code-backup'&&manifest.tree_sha256===receipt.tree_sha256&&sha256(JSON.stringify(manifest.files))===receipt.tree_sha256,'Native recovery manifest differs');
 const expected=new Map(manifest.files.map(item=>[item.path,item]));let files=0,bytes=0;
 function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=checkedPath(root,path.join(dir,item.name)),rel=path.relative(folder,file).replaceAll('\\','/');
  if(item.isDirectory()){need([...expected.keys()].some(name=>name.startsWith(rel+'/')),'Unowned directory in native code backup');visit(file);}
  else{need(item.isFile()&&!item.isSymbolicLink(),'Unknown native backup entry');const value=fs.readFileSync(file),entry=expected.get(rel);
   need(entry?sha256(value)===entry.sha256:['backup-manifest.json','receipt.json'].includes(rel),'Unowned or changed native backup file');files++;bytes+=value.length;}
 }}
 visit(folder);need(files===manifest.files.length+2,'Native backup file set differs');checkedPath(root,folder);fs.rmSync(folder,{recursive:true,force:false});
 return {state:'cleaned-after-public-restoration-and-host-validation',files,bytes,backup:folder,release_url:receipt.release_url};
}
