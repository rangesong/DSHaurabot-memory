import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {zipFiles,readZipEntries} from './zip.js';
import {GitHubClient,githubCredential} from './github-client.js';
import {checkedPath} from './context-module-updater.js';
import {createTestWorkspace,cleanupTestWorkspace} from './test-workspace.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const top=new Set(['dist','docs','hermes-plugin','paper','website','LICENSE','package.json','README.md','README.zh-CN.md','README.ja.md','dsh.bundle.patch.yml']);
const extensions=new Set(['.js','.json','.md','.yml','.yaml','.py','.png','']);
const requireSafe=(ok,message)=>{if(!ok)throw Error(message);};
export function engineSnapshot(folder){
 folder=checkedPath(folder,folder);const entries=new Map();let bytes=0;
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(dir===folder&&e.name==='node_modules')continue;
  const file=checkedPath(folder,path.join(dir,e.name)),relative=path.relative(folder,file).replaceAll('\\','/');
  requireSafe(top.has(relative.split('/')[0]),'Unexpected engine program entry: '+relative);
  if(e.isDirectory()){walk(file);continue;}
  requireSafe(e.isFile()&&extensions.has(path.extname(file)),'Non-program engine entry refused');
  const value=fs.readFileSync(file);bytes+=value.length;requireSafe(bytes<60*1024*1024&&entries.size<256,'Engine backup exceeds audited budget');
  if(path.extname(file)!=='.png')requireSafe(!/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value.toString()),'Credential-like material refused');
  entries.set(relative,value);
 }}
 walk(folder);const pkg=JSON.parse(entries.get('package.json')??'null');requireSafe(pkg?.name==='billion-context'&&pkg.version==='0.1.216','Unreviewed compression-engine version');
 requireSafe(entries.has('dist/index.js')&&entries.has('LICENSE'),'Incomplete engine program');
 const files=[...entries].map(([name,value])=>({path:name,bytes:value.length,sha256:sha(value)})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
 return {entries,version:pkg.version,files,bytes,tree:sha(JSON.stringify(files))};
}
async function verifiedArchive(root,folder,snapshot,client){
 const tag='context-code-billion-context-v'+snapshot.version,base='billion-context-'+snapshot.version+'-'+snapshot.tree.slice(0,16),zip=zipFiles(snapshot.entries);
 const manifest={schema:1,kind:'compression-engine-code',version:snapshot.version,tree_sha256:snapshot.tree,files:snapshot.files,zip_sha256:sha(zip),private_data_included:false,
  restore:'Extract all entries into a NEW empty directory. Install production dependencies declared in package.json using npm install --ignore-scripts --omit=dev. Keep existing private compression stores separate. Review engine version/database compatibility before using it.'};
 let release=await client.release(tag,{create:true});const assets=await client.assets(release);
 async function ensure(name,value,type){let asset=assets.find(a=>a.name===name);if(asset)requireSafe(sha(await client.download(asset))===sha(value),'Immutable recovery asset differs');else{asset=await client.upload(release,name,value,type);assets.push(asset);}return asset;}
 const a=await ensure(base+'.zip',zip,'application/zip'),m=await ensure(base+'.restore.json',Buffer.from(JSON.stringify(manifest,null,2)),'application/json');
 release=await client.publish(release);const published=await client.assets(release);
 const downloaded=await client.download(published.find(x=>x.id===a.id),{publicOnly:true});
 const metadata=JSON.parse((await client.download(published.find(x=>x.id===m.id),{publicOnly:true})).toString());
 requireSafe(sha(downloaded)===manifest.zip_sha256&&JSON.stringify(metadata)===JSON.stringify(manifest),'Public engine recovery verification failed');
 const restored=readZipEntries(downloaded);requireSafe(restored.size===snapshot.entries.size&&snapshot.files.every(f=>sha(restored.get(f.path)??'')===f.sha256),'Recovery file hash differs');
 const run=createTestWorkspace(root,{label:'compression-engine-code-restoration'});let cleanup;
 try{const dest=path.join(run.scratch,'engine');fs.mkdirSync(dest);for(const[n,b]of restored){const file=checkedPath(dest,path.join(dest,n));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});}requireSafe(engineSnapshot(dest).tree===snapshot.tree,'Disk recovery verification failed');}
 finally{cleanup=cleanupTestWorkspace(root,run.folder);fs.writeFileSync(path.join(run.report,'summary.json'),JSON.stringify({kind:'engine-code-restoration',tree:snapshot.tree,cleanup},null,2));}
 return {release_url:release.html_url,zip_asset:a.name,manifest_asset:m.name,tree_sha256:snapshot.tree,public_download_verified:true,code_restoration_verified:true,private_data_included:false,verificationReport:run.report};
}
export async function updateCompressionEngine({root,folder,apply=false,transform,client,archive=verifiedArchive}={}){
 requireSafe(path.isAbsolute(root??'')&&path.isAbsolute(folder??''),'Absolute engine and project paths required');
 root=checkedPath(root,root);folder=checkedPath(folder,folder);requireSafe(typeof transform==='function','Reviewed exact-version transformation required');
 const old=engineSnapshot(folder),file=checkedPath(folder,path.join(folder,'dist/index.js')),before=old.entries.get('dist/index.js'),next=transform(before.toString('utf8'));
 requireSafe(typeof next==='string'&&next.length>0,'Invalid patched engine program');
 const syntax=spawnSync(process.execPath,['--check','--input-type=module'],{input:next,encoding:'utf8',windowsHide:true});requireSafe(syntax.status===0,'Patched compression engine syntax invalid');
 const summary={engine:'billion-context',version:old.version,target:file,before_sha256:sha(before),after_sha256:sha(next),configuration_modified:false,private_data_modified:false,restart_required:sha(before)!==sha(next)};
 if(!apply||!summary.restart_required)return {...summary,unchanged:!summary.restart_required};
 const policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json')));
 requireSafe(policy.include_private_data===false&&policy.verify_public_download===true&&policy.verify_disk_restoration===true,'Cloud recovery policy required');
 client??=new GitHubClient(policy.repository,{token:githubCredential(policy.repository)});
 const backup=await archive(root,folder,old,client);requireSafe(backup.public_download_verified&&backup.code_restoration_verified&&backup.tree_sha256===old.tree,'Verified engine backup required');
 requireSafe(engineSnapshot(folder).tree===old.tree,'Engine code changed during verification');
 const receiptDir=checkedPath(root,path.join(root,'runtime-data/installations'));fs.mkdirSync(receiptDir,{recursive:true});
 const recoveryFile=checkedPath(root,path.join(receiptDir,'billion-context-'+old.tree.slice(0,16)+'.index.js'));
 if(fs.existsSync(recoveryFile))requireSafe(sha(fs.readFileSync(recoveryFile))===sha(before),'Local engine recovery copy differs');else fs.writeFileSync(recoveryFile,before,{flag:'wx'});
 const receiptFile=checkedPath(root,path.join(receiptDir,'billion-context-update.json'));
 const receipt={...summary,at:new Date().toISOString(),backup,localRecovery:recoveryFile,status:'prepared-not-installed'};
 const record=()=>{checkedPath(root,receiptFile);fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));};record();
 const temporary=checkedPath(folder,file+'.thinkstar-'+randomUUID()+'.tmp');fs.writeFileSync(temporary,next,{flag:'wx'});
 try{checkedPath(folder,file);requireSafe(sha(fs.readFileSync(file))===sha(before),'Engine entry changed before commit');fs.renameSync(temporary,file);requireSafe(sha(fs.readFileSync(file))===sha(next),'Installed engine hash mismatch');}
 catch(error){receipt.status=sha(fs.readFileSync(file))===summary.after_sha256?'installed-runtime-validation-required':'install-failed-review-local-recovery';receipt.error=error.message;record();throw error;}
 finally{if(fs.existsSync(temporary)){checkedPath(folder,temporary);fs.unlinkSync(temporary);}}
 receipt.status='installed-awaiting-runtime-validation';record();return receipt;
}
