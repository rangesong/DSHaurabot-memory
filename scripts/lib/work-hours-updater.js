import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {applyHunks,sha256} from './work-hours-patches.js';
import {zipFiles,readZipEntries} from './zip.js';
import {GitHubClient,githubCredential} from './github-client.js';
import {createTestWorkspace,cleanupTestWorkspace} from './test-workspace.js';

function safeRoot(value){
 const root=path.resolve(value);if(fs.realpathSync(root).toLowerCase()!==root.toLowerCase())throw Error('Redirected root refused');
 for(let p=root;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Linked root refused');if(path.dirname(p)===p)break;}return root;
}
function checked(root,rel){
 root=safeRoot(root);if(path.isAbsolute(rel)||rel.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))throw Error('Invalid relative path');
 const file=path.resolve(root,rel);if(!file.startsWith(root+path.sep))throw Error('Outside update root');
 for(let p=root;;){if(fs.existsSync(p)){const s=fs.lstatSync(p);if(s.isSymbolicLink()||fs.realpathSync(p).toLowerCase()!==p.toLowerCase())throw Error('Redirected path refused');}if(p===file)break;const next=path.relative(p,file).split(path.sep)[0];p=path.join(p,next);}
 return file;
}
export function planWorkHours({manifest,host,modules}){
 if(manifest.schema!==1||!Array.isArray(manifest.entries))throw Error('Invalid patch manifest');
 const roots={host:safeRoot(host),modules:safeRoot(modules)},seen=new Set(),plans=[];
 for(const entry of manifest.entries){
  if(!roots[entry.area]||seen.has(entry.area+'/'+entry.path))throw Error('Unsupported or duplicate patch target');seen.add(entry.area+'/'+entry.path);
  const target=checked(roots[entry.area],entry.path),old=fs.existsSync(target)?fs.readFileSync(target):null,next=applyHunks(old,entry);
  if(old&&/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN .*PRIVATE KEY-----/.test(old.toString('utf8')))throw Error('Potential credential in program; backup refused');
  plans.push({entry,target,old,next});
 }
 return plans;
}
export async function updateWorkHours({root,host,modules,manifest,apply=false,client}={}){
 const plans=planWorkHours({manifest,host,modules});
 const summary={changes:plans.map(p=>({area:p.entry.area,path:p.entry.path,before:p.entry.before,after:p.entry.after})),configuration_modified:false,private_data_included:false};
 if(!apply)return summary;
 const policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json')));
 if(policy.include_private_data!==false||policy.verify_public_download!==true||policy.verify_disk_restoration!==true)throw Error('Verified public code backup required');
 client??=new GitHubClient(policy.repository,{token:githubCredential(policy.repository)});
 const files=new Map(plans.filter(p=>p.old).map(p=>[p.entry.area+'/'+p.entry.path,p.old]));
 const items=[...files].map(([name,b])=>({path:name,sha256:sha256(b),bytes:b.length})).sort((a,b)=>a.path.localeCompare(b.path));
 const tree=sha256(JSON.stringify(items)),zip=zipFiles(files),metadata=Buffer.from(JSON.stringify({schema:1,kind:'aurabot-work-hours-code-backup',files:items,tree_sha256:tree,zip_sha256:sha256(zip),private_data_included:false},null,2));
 let release=await client.release('aurabot-work-hours-code-backups',{create:true}),assets=await client.assets(release),base='work-hours-before-'+tree.slice(0,20);
 async function asset(name,bytes,type){const a=assets.find(x=>x.name===name);if(a){if(sha256(await client.download(a))!==sha256(bytes))throw Error('Existing backup differs');return a;}const b=await client.upload(release,name,bytes,type);assets.push(b);return b;}
 const z=await asset(base+'.zip',zip,'application/zip'),m=await asset(base+'.restore.json',metadata,'application/json');release=await client.publish(release);assets=await client.assets(release);
 const downloaded=await client.download(assets.find(a=>a.id===z.id),{publicOnly:true}),meta=await client.download(assets.find(a=>a.id===m.id),{publicOnly:true});
 if(sha256(downloaded)!==sha256(zip)||sha256(meta)!==sha256(metadata))throw Error('Public backup download mismatch');
 const restored=readZipEntries(downloaded);if(restored.size!==items.length)throw Error('Restore entries mismatch');
 const run=createTestWorkspace(root,{label:'work-hours-code-restore'});let cleanup;
 try{for(const item of items){const b=restored.get(item.path);if(!b||sha256(b)!==item.sha256)throw Error('Restore checksum mismatch');const f=checked(run.scratch,item.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});if(sha256(fs.readFileSync(f))!==item.sha256)throw Error('Restored file mismatch');}}
 finally{cleanup=cleanupTestWorkspace(root,run.folder);fs.writeFileSync(path.join(run.report,'summary.json'),JSON.stringify({kind:'work-hours-code-restore',cleanup},null,2));}
 // Recheck all source bytes after the network round trip; no change means no overwrite.
 planWorkHours({manifest,host,modules});
 const backup=path.join(root,'runtime-data/installations','work-hours-'+randomUUID());fs.mkdirSync(backup,{recursive:true});
 for(const p of plans.filter(p=>p.old)){const f=checked(backup,p.entry.area+'/'+p.entry.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,p.old,{flag:'wx'});}
 fs.writeFileSync(path.join(backup,'backup-manifest.json'),metadata,{flag:'wx'});
 const changed=[];
 try{
  // Install new dependencies before any code that imports them.
  for(const p of [...plans].sort((a,b)=>Number(a.old!==null)-Number(b.old!==null))){
   const current=fs.existsSync(p.target)?fs.readFileSync(p.target):null;if((current?sha256(current):null)!==p.entry.before)throw Error('Installed file changed during update');
   const tmp=p.target+'.work-hours-'+randomUUID();fs.writeFileSync(tmp,p.next,{flag:'wx'});fs.renameSync(tmp,p.target);changed.push(p);
   if(sha256(fs.readFileSync(p.target))!==p.entry.after)throw Error('Installed file verification failed');
  }
 }catch(error){
  for(const p of changed.reverse()){if(p.old)fs.writeFileSync(p.target,p.old);else if(fs.existsSync(p.target)&&sha256(fs.readFileSync(p.target))===p.entry.after)fs.unlinkSync(p.target);}
  throw error;
 }
 const receipt={...summary,at:new Date().toISOString(),backup,release_url:release.html_url,zip_asset:z.name,tree_sha256:tree,public_download_verified:true,code_restoration_verified:true,verification_report:run.report,cleanup:'retained-until-host-validation'};
 fs.writeFileSync(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});return receipt;
}
