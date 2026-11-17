import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {zipFiles,readZipEntries} from './zip.js';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
const textExtensions=/\.(?:js|mjs|json|md|txt|html|css|svg)$/i,syntaxChecked=new Set();
const permittedJson=new Set(['module.json','package.json','thinkstar-build.json','engine/adapters/aurabot/module/module.json','engine/apps/memory-sea/assets/milky-way-background.json','engine/apps/memory-sea/vendor/three/provenance.json']);
function safePath(name){if(!name||name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f]/.test(name))throw Error('Unsafe code path');return name;}
function publicationAllowed(name){safePath(name);if(/(^|\/)(?:runtime-data|modules-data|rubbishmemory|backups|chatlog|node_modules|\.git|\.env(?:\.[^/]*)?)(\/|$)|\.(?:sqlite(?:-(?:wal|shm))?|db|glb|gltf|log|pem|key|pfx)$/i.test(name))throw Error('Private data path refused: '+name);
  if(name.endsWith('.json')&&!permittedJson.has(name))throw Error('Unapproved JSON refused: '+name);
  const root=['LICENSE','README.md','THIRD-PARTY-NOTICES.md','index.mjs','panel.js','module.json','package.json','thinkstar-build.json'].includes(name);
  const engine=/^engine\/(?:core|shared|server|adapters|apps\/memory-sea)\//.test(name)&&(/\.(?:js|mjs|html|css|svg|json)$/.test(name)||/\/(?:LICENSE|README\.md|THIRD-PARTY-NOTICES\.md)$/.test(name)||name==='engine/apps/memory-sea/assets/milky-way-background.jpg');
  if(!root&&!engine)throw Error('Not an approved program file: '+name);
}
function inspectText(name,bytes){if(!textExtensions.test(name))return;const text=bytes.toString('utf8');
  if(/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))throw Error('Potential credential refused in '+name);
  if(/\.(?:json)$/.test(name))JSON.parse(text);
  if(/\.(?:js|mjs)$/.test(name)){const key=sha256(bytes);if(!syntaxChecked.has(key)){const code=name==='panel.js'?'function panelFactory(React,h,ui,call){\n'+text+'\n}':text;const r=spawnSync(process.execPath,['--check','--input-type=module'],{input:code,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096});if(r.status!==0)throw Error('Program syntax check failed: '+name);syntaxChecked.add(key);}}
}
function checkedFolder(folder){const resolved=path.resolve(folder);if(fs.lstatSync(resolved).isSymbolicLink()||fs.realpathSync(resolved).toLowerCase()!==resolved.toLowerCase())throw Error('Redirected directory refused');return resolved;}
function inspectEntries(entries){
  const build=JSON.parse(entries.get('thinkstar-build.json')??'null'),module=JSON.parse(entries.get('module.json')??'null');
  if(build?.id!=='thinkstar-memory'||module?.id!==build.id||module.version!==build.version||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(build.version)||!Array.isArray(build.files)||build.files.length<1||build.files.length>300)throw Error('Invalid Thinkstar code manifest');
  const expected=new Set(['thinkstar-build.json']);let total=0;
  for(const item of build.files){publicationAllowed(item.path);if(expected.has(item.path))throw Error('Duplicate manifest path');expected.add(item.path);const bytes=entries.get(item.path);if(!bytes||sha256(bytes)!==item.sha256||bytes.length!==item.bytes)throw Error('Program differs from build manifest: '+item.path);}
  if(entries.size!==expected.size||[...entries.keys()].some(name=>!expected.has(name)))throw Error('Unlisted files found; keep this backup local for review');
  const files=[];for(const [name,bytes]of entries){publicationAllowed(name);total+=bytes.length;if(total>64*1024*1024)throw Error('Code snapshot exceeds size limit');inspectText(name,bytes);files.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});}
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  for(const [name,bytes]of entries)if(/\.(?:js|mjs)$/.test(name))for(const m of bytes.toString().matchAll(/(?:^|\n)\s*(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s*from\s*)?['"](\.{1,2}\/[^'"\n]+)['"]/g)){const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),m[1]));if(!entries.has(resolved))throw Error('Restored program import missing: '+name);}
  const schema=/STORAGE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(entries.get('engine/core/v5-store.js')?.toString()??'')?.[1]??null;
  return {version:build.version,tree_sha256:sha256(JSON.stringify(files)),files,total_code_bytes:total,storage_schema_declared:schema===null?null:Number(schema),entries};
}
export function snapshotCode(folder){folder=checkedFolder(folder);const entries=new Map(),cache=[];let bytes=0;
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name),name=path.relative(folder,file).split(path.sep).join('/');if(e.isSymbolicLink())throw Error('Symlink refused in code backup');if(e.isDirectory()){if(/(^|\/)(?:runtime-data|modules-data|rubbishmemory|backups|chatlog|node_modules|\.git)(\/|$)/.test(name))throw Error('Data directory refused in code backup');walk(file);}else if(e.isFile()){
    const generated=/^\.aurabot-cache\/\d+-\d+\/(.+)$/.exec(name);if(name.startsWith('.aurabot-cache/')&&!generated)throw Error('Unrecognized generated cache; backup retained');publicationAllowed(generated?.[1]??name);bytes+=fs.statSync(file).size;if(bytes>64*1024*1024)throw Error('Code snapshot exceeds size limit');const value=fs.readFileSync(file);
    if(generated){inspectText(generated[1],value);cache.push({path:name,bytes:value.length,sha256:sha256(value)});}else entries.set(name,value);
  }else throw Error('Non-file entry refused');}}
  walk(folder);return {...inspectEntries(entries),local_generated_cache:cache,total_local_bytes:bytes};
}
export function packSnapshot(snapshot){const zip=zipFiles(snapshot.entries),manifest={schema:1,kind:'thinkstar-code-backup',version:snapshot.version,tree_sha256:snapshot.tree_sha256,zip_sha256:sha256(zip),files:snapshot.files,total_code_bytes:snapshot.total_code_bytes,storage_schema_declared:snapshot.storage_schema_declared,private_data_included:false};return {zip,manifest,manifestBytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')};}
export function snapshotCodeZip(bytes){return inspectEntries(readZipEntries(bytes));}
export function verifyBackupBytes(zip,manifest){if(manifest.schema!==1||manifest.kind!=='thinkstar-code-backup'||manifest.private_data_included!==false||sha256(zip)!==manifest.zip_sha256)throw Error('Downloaded backup checksum or type mismatch');const entries=readZipEntries(zip),snapshot=inspectEntries(entries);if(snapshot.version!==manifest.version||snapshot.tree_sha256!==manifest.tree_sha256||JSON.stringify(snapshot.files)!==JSON.stringify(manifest.files))throw Error('Downloaded file manifest mismatch');return snapshot;}
export function restoreBackup(zip,manifest,destination){const snapshot=verifyBackupBytes(zip,manifest),folder=path.resolve(destination);if(fs.existsSync(folder))throw Error('Restore destination must not exist');fs.mkdirSync(folder,{recursive:true});checkedFolder(folder);
  for(const [name,bytes]of snapshot.entries){const file=path.resolve(folder,name);if(!file.startsWith(folder+path.sep))throw Error('Restore path escape');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});}if(snapshotCode(folder).tree_sha256!==manifest.tree_sha256)throw Error('On-disk restoration mismatch');return folder;}
export function restorationCheck(zip,manifest,verificationRoot){const root=path.resolve(verificationRoot);fs.mkdirSync(root,{recursive:true});checkedFolder(root);const parent=fs.mkdtempSync(path.join(root,'restore-check-')),folder=path.join(parent,'program');try{restoreBackup(zip,manifest,folder);return {files_restored:manifest.files.length,code_restoration_verified:true};}finally{if(path.dirname(parent)!==root||!path.basename(parent).startsWith('restore-check-'))throw Error('Unsafe temporary cleanup');checkedFolder(parent);fs.rmSync(parent,{recursive:true,force:false});}}
async function ensureAsset(client,release,assets,name,bytes,contentType){const expected=sha256(bytes),existing=assets.find(a=>a.name===name);if(existing){if(existing.digest&&existing.digest!=='sha256:'+expected)throw Error('Immutable cloud asset differs: '+name);if(!existing.digest&&sha256(await client.download(existing))!==expected)throw Error('Cloud asset differs: '+name);return existing;}const asset=await client.upload(release,name,bytes,contentType);assets.push(asset);return asset;}
export async function archiveCode(folder,options={}){return archiveSnapshot(snapshotCode(folder),options);}
export async function archiveSnapshot(snapshot,{client,verificationRoot,tagPrefix='code-backups-v',progress=()=>{}}={}){
  const packed=packSnapshot(snapshot),tag=tagPrefix+snapshot.version,base=`thinkstar-code-${snapshot.version}-${snapshot.tree_sha256.slice(0,16)}`;
  let release=await client.release(tag,{create:true});const assets=await client.assets(release);progress({stage:'uploading',version:snapshot.version,tree_sha256:snapshot.tree_sha256});
  const zipAsset=await ensureAsset(client,release,assets,base+'.zip',packed.zip,'application/zip'),manifestAsset=await ensureAsset(client,release,assets,base+'.restore.json',packed.manifestBytes,'application/json');
  const first=await client.download(zipAsset),firstManifest=JSON.parse((await client.download(manifestAsset)).toString('utf8'));verifyBackupBytes(first,firstManifest);
  release=await client.publish(release);
  // Draft asset URLs may change when the release is published. Re-read the canonical URLs.
  const publicAssets=await client.assets(release),publicZip=publicAssets.find(a=>a.id===zipAsset.id),publicManifest=publicAssets.find(a=>a.id===manifestAsset.id);
  if(!publicZip||!publicManifest)throw Error('Published backup assets missing');
  const downloaded=await client.download(publicZip,{publicOnly:true}),downloadedManifest=JSON.parse((await client.download(publicManifest,{publicOnly:true})).toString('utf8'));
  if(sha256(downloaded)!==packed.manifest.zip_sha256||JSON.stringify(downloadedManifest)!==JSON.stringify(packed.manifest))throw Error('Published archive is not this local snapshot');
  const restored=restorationCheck(downloaded,downloadedManifest,verificationRoot);
  const receipt={schema:1,repository:client.repository,version:snapshot.version,tag,release_url:release.html_url,zip_asset:zipAsset.name,zip_asset_id:zipAsset.id,manifest_asset:manifestAsset.name,manifest_asset_id:manifestAsset.id,tree_sha256:snapshot.tree_sha256,zip_sha256:packed.manifest.zip_sha256,code_bytes:snapshot.total_code_bytes,zip_bytes:packed.zip.length,files:snapshot.files.length,public_download_verified:true,...restored,verified_at:new Date().toISOString(),private_data_included:false};progress({stage:'verified',...receipt});return receipt;
}
export function cleanupVerifiedCode(folder,{receipt,allowedParent}={}){const parent=checkedFolder(allowedParent),target=checkedFolder(folder);
  if(path.dirname(target).toLowerCase()!==parent.toLowerCase()||!/^(_thinkstar-before-|code-before-|\d+\.\d+\.\d+[^/\\]*-before-|rollback-)/.test(path.basename(target))||path.basename(target)==='thinkstar-memory')throw Error('Not an explicitly allowed code-backup directory');
  if(!receipt?.public_download_verified||!receipt.code_restoration_verified||receipt.private_data_included!==false)throw Error('No verified cloud recovery receipt; local backup retained');
  const snapshot=snapshotCode(target);if(snapshot.tree_sha256!==receipt.tree_sha256)throw Error('Local backup changed since cloud verification');
  if(fs.realpathSync(target).toLowerCase()!==target.toLowerCase()||path.dirname(target).toLowerCase()!==parent.toLowerCase())throw Error('Cleanup path changed');
  fs.rmSync(target,{recursive:true,force:false});return {removed:target,bytes:snapshot.total_local_bytes,tree_sha256:snapshot.tree_sha256,regeneratable_cache_files_removed:snapshot.local_generated_cache.length};
}
export function cleanupVerifiedCodeZip(file,{receipt,allowedParent,activeVersion,expected_file_sha256}={}){const parent=checkedFolder(allowedParent),target=path.resolve(file);if(path.dirname(target).toLowerCase()!==parent.toLowerCase()||!/^thinkstar-memory-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.zip$/.test(path.basename(target))||fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target).toLowerCase()!==target.toLowerCase())throw Error('Not an approved old code-package path');
  if(!receipt?.public_download_verified||!receipt.code_restoration_verified||receipt.private_data_included!==false)throw Error('No verified cloud restoration receipt');const bytes=fs.readFileSync(target);if(sha256(bytes)!==expected_file_sha256)throw Error('Local package changed');const snapshot=snapshotCodeZip(bytes);if(!activeVersion||snapshot.version===activeVersion)throw Error('Current-version installer must remain local');if(snapshot.tree_sha256!==receipt.tree_sha256)throw Error('Code package has no matching cloud snapshot');fs.unlinkSync(target);return {removed:target,bytes:bytes.length};
}
