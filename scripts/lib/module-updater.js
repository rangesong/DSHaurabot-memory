import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {GitHubClient,githubCredential} from './github-client.js';
import {snapshotCode,archiveCode,cleanupVerifiedCode} from './code-backups.js';
function checked(dir){const result=path.resolve(dir);if(fs.lstatSync(result).isSymbolicLink()||fs.realpathSync(result).toLowerCase()!==result.toLowerCase())throw Error('Redirected update directory refused');return result;}
export async function updateAurabotModule({root,data,apply=false,client,archive=archiveCode}={}){
  if(!path.isAbsolute(data??'')||!path.isAbsolute(root??''))throw Error('Project and Aurabot directories must be absolute');root=checked(root);data=checked(data);
  const target=path.join(data,'modules/thinkstar-memory'),source=path.join(root,'dist/aurabot/thinkstar-memory');checked(path.join(data,'modules'));checked(target);checked(source);
  const old=snapshotCode(target),next=snapshotCode(source),policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json')));
  if(policy.storage!=='github_releases'||policy.include_private_data!==false||policy.verify_public_download!==true||policy.verify_disk_restoration!==true||policy.cleanup_only_after_verification!==true)throw Error('Verified cloud-backup policy required');
  const summary={verified:true,from:old.version,to:next.version,target,code_only:true,backup_storage:'github_releases'};
  if(!apply)return summary;if(old.tree_sha256===next.tree_sha256)return {...summary,unchanged:true};
  client??=new GitHubClient(policy.repository,{token:githubCredential(policy.repository)});
  const cloud=await archive(target,{client,tagPrefix:policy.tag_prefix,verificationRoot:path.join(root,'runtime-data/archive-verification')});
  if(!cloud.public_download_verified||!cloud.code_restoration_verified||cloud.tree_sha256!==old.tree_sha256)throw Error('Current code has no matching verified cloud recovery copy');
  const modulesData=path.join(data,'modules-data'),owner=path.join(modulesData,'thinkstar-memory'),tempRoot=path.join(owner,'update-staging');
  for(const dir of [modulesData,owner,tempRoot]){if(!fs.existsSync(dir))fs.mkdirSync(dir);checked(dir);}
  if(path.dirname(tempRoot)!==owner)throw Error('Unexpected staging location');const id=randomUUID(),stage=path.join(tempRoot,'stage-'+id),previous=path.join(tempRoot,'rollback-'+old.version+'-before-'+next.version+'-'+id);
  if(fs.existsSync(stage)||fs.existsSync(previous))throw Error('Update staging already exists');
  fs.cpSync(source,stage,{recursive:true});if(snapshotCode(stage).tree_sha256!==next.tree_sha256)throw Error('New staged code changed');
  fs.renameSync(target,previous);
  try{fs.renameSync(stage,target);if(snapshotCode(target).tree_sha256!==next.tree_sha256)throw Error('Installed code failed verification');}
  catch(error){if(fs.existsSync(target))fs.renameSync(target,stage);fs.renameSync(previous,target);throw error;}
  const receipt={at:new Date().toISOString(),from:old.version,to:next.version,target,previous:cloud.release_url,cloud_backup:cloud,code_only:true,configuration_modified:false,original_assets_modified:false,backup_cleanup_status:'pending',temporary_backup:previous};
  const ledger=path.join(root,'runtime-data/installations');fs.mkdirSync(ledger,{recursive:true});const record=()=>fs.writeFileSync(path.join(ledger,'last-update.json'),JSON.stringify(receipt,null,2));record();
  try{const cleanup=cleanupVerifiedCode(previous,{receipt:cloud,allowedParent:tempRoot});receipt.backup_cleanup_status='removed_after_public_restore_verification';receipt.local_backup_bytes_released=cleanup.bytes;delete receipt.temporary_backup;}
  catch(error){receipt.backup_cleanup_status='retained_for_review';receipt.backup_cleanup_error=error.message;}
  record();if(fs.readdirSync(tempRoot).length===0)fs.rmdirSync(tempRoot);return receipt;
}
