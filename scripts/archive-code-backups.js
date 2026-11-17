import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {GitHubClient,githubCredential} from './lib/github-client.js';import {archiveCode,cleanupVerifiedCode,snapshotCode} from './lib/code-backups.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const planPath=option('--plan');if(!planPath)throw Error('Use --plan <local inventory.json> [--execute] [--cleanup]');if(args.includes('--cleanup')&&!args.includes('--execute'))throw Error('Cleanup requires --execute and a fresh remote restoration check');
const plan=JSON.parse(fs.readFileSync(path.resolve(planPath),'utf8')),policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json'),'utf8'));
if(plan.schema!==1||!Array.isArray(plan.folders)||!Array.isArray(plan.allowed_parents))throw Error('Invalid local inventory');
const folders=plan.folders.map(item=>{const folder=path.resolve(item.folder),parent=path.dirname(folder);if(!plan.allowed_parents.some(p=>path.resolve(p).toLowerCase()===parent.toLowerCase()))throw Error('Backup outside inventoried parents');if(!/^(_thinkstar-before-|code-before-|\d+\.\d+\.\d+[^/\\]*-before-|rollback-)/.test(path.basename(folder)))throw Error('Not a named old-code backup');return {...item,folder,parent};});
const logFile=path.join(root,'runtime-data/installations/cloud-archive-receipts.json');fs.mkdirSync(path.dirname(logFile),{recursive:true});let ledger=fs.existsSync(logFile)?JSON.parse(fs.readFileSync(logFile)):{};
const save=()=>{const temp=logFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(ledger,null,2));fs.renameSync(temp,logFile);};
if(!args.includes('--execute')){const rows=folders.map(item=>{const s=snapshotCode(item.folder);return {folder:item.folder,version:s.version,tree_sha256:s.tree_sha256,code_bytes:s.total_code_bytes,local_bytes:s.total_local_bytes};});console.log(JSON.stringify({dry_run:true,repository:policy.repository,folders:rows,private_data_included:false},null,2));}
else{
 const client=new GitHubClient(policy.repository,{token:githubCredential(policy.repository)}),repo=await client.info();if(repo.repository.toLowerCase()!==policy.repository.toLowerCase()||!repo.push)throw Error('Repository identity or write access missing');
 for(let i=0;i<folders.length;i++){const item=folders[i];if(!fs.existsSync(item.folder)){if(ledger[item.folder]?.removed)continue;throw Error('Unrecorded missing backup');}
  const snapshot=snapshotCode(item.folder);if(item.tree_sha256&&item.tree_sha256!==snapshot.tree_sha256)throw Error('Backup changed after inventory');
  const receipt=await archiveCode(item.folder,{client,tagPrefix:policy.tag_prefix,verificationRoot:path.join(root,'runtime-data/archive-verification'),progress:state=>console.log(JSON.stringify({index:i+1,total:folders.length,...state}))});
  ledger[item.folder]={...receipt,local_folder:item.folder,removed:false};save();
  if(args.includes('--cleanup')){const cleanup=cleanupVerifiedCode(item.folder,{receipt,allowedParent:item.parent});ledger[item.folder]={...ledger[item.folder],removed:true,removed_at:new Date().toISOString(),local_bytes_released:cleanup.bytes,regeneratable_cache_files_removed:cleanup.regeneratable_cache_files_removed};save();console.log(JSON.stringify({stage:'local_backup_removed',index:i+1,total:folders.length,version:receipt.version,bytes:cleanup.bytes}));}
 }
 const values=Object.values(ledger);console.log(JSON.stringify({complete:true,verified:values.filter(x=>x.public_download_verified).length,removed:values.filter(x=>x.removed).length,bytes_released:values.reduce((n,r)=>n+(r.local_bytes_released??0),0),receipt_file:logFile,private_data_uploaded:false}));
}
