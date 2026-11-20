// Code-only companion update. Business databases and host configuration are never copied.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {GitHubClient,githubCredential} from './lib/github-client.js';
import {zipFiles,readZipEntries} from './lib/zip.js';
import {forkBuiltinMemory,nativePatchManifest,patchNativeSource} from './lib/native-patches.js';
import {createTestWorkspace,cleanupTestWorkspace} from './lib/test-workspace.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const argument=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
const data=argument('--data-dir'),src=argument('--builtin-src'),only=argument('--only');
if(!path.isAbsolute(data??'')||!path.isAbsolute(src??''))throw Error('Use --data-dir <Aurabot> --builtin-src <current Aurabot src> [--apply]');
if(only&&!['memory','history-vault'].includes(only))throw Error('Use --only memory or --only history-vault');
function safe(file){let p=path.resolve(file);for(;;){const s=fs.lstatSync(p);if(s.isSymbolicLink()||fs.realpathSync(p).toLowerCase()!==p.toLowerCase())throw Error('Redirected native path');if(path.dirname(p)===p)break;p=path.dirname(p);}return path.resolve(file);}
const modules=safe(path.join(data,'modules')),snapshot=new Map(),wanted=new Map(),before=new Map();
const allAllowed={memory:['index.mjs','memory.js','memory-rules.js','memory-store.js','memory-vector.js'],'history-vault':['index.mjs','context-dedup.mjs','module.json','panel.js','README.md','LICENSE']};
const allowed=only?{[only]:allAllowed[only]}:allAllowed;
for(const [id,names]of Object.entries(allowed))for(const name of names){const file=safe(path.join(modules,id,name)),bytes=fs.readFileSync(file);if(/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN .*PRIVATE KEY-----/.test(bytes.toString()))throw Error('Credential-like content refused');snapshot.set(id+'/'+name,bytes);before.set(file,hash(bytes));}
const patch=nativePatchManifest();
if(!only||only==='memory')for(const [name,bytes]of forkBuiltinMemory(safe(src))){const entry=patch.files.find(e=>e.module==='memory'&&e.file===name);wanted.set(path.join(modules,'memory',name),entry?patchNativeSource(bytes,entry):bytes);}
if(!only||only==='history-vault')for(const entry of patch.files.filter(e=>e.module==='history-vault'))wanted.set(path.join(modules,entry.module,entry.file),patchNativeSource(fs.readFileSync(path.join(modules,entry.module,entry.file)),entry));
const files=[...snapshot].map(([name,bytes])=>({path:name,sha256:hash(bytes),bytes:bytes.length})).sort((a,b)=>a.path.localeCompare(b.path));
const tree=hash(Buffer.from(JSON.stringify(files))),zip=zipFiles(snapshot),manifest={schema:1,kind:'aurabot-native-code-backup',files,tree_sha256:tree,zip_sha256:hash(zip),private_data_included:false};
const changed=[...wanted].filter(([file,bytes])=>hash(fs.readFileSync(file))!==hash(bytes));
if(!args.includes('--apply')){console.log(JSON.stringify({code_only:true,changed:changed.map(([file])=>file),backup_files:files.length,configuration_modified:false}));process.exit(0);}
const policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json'))),client=new GitHubClient(policy.repository,{token:githubCredential(policy.repository)});
let release=await client.release('native-adapter-code-backups',{create:true}),assets=await client.assets(release);
const base='aurabot-memory-vault-'+tree.slice(0,20),metadata=Buffer.from(JSON.stringify(manifest,null,2));
async function asset(name,bytes,type){const existing=assets.find(a=>a.name===name);if(existing){if(hash(await client.download(existing))!==hash(bytes))throw Error('Existing native archive differs');return existing;}const created=await client.upload(release,name,bytes,type);assets.push(created);return created;}
await asset(base+'.zip',zip,'application/zip');await asset(base+'.restore.json',metadata,'application/json');release=await client.publish(release);assets=await client.assets(release);
const downloaded=await client.download(assets.find(a=>a.name===base+'.zip'),{publicOnly:true}),meta=await client.download(assets.find(a=>a.name===base+'.restore.json'),{publicOnly:true});
if(hash(downloaded)!==manifest.zip_sha256||hash(meta)!==hash(metadata))throw Error('Public native recovery download mismatch');
const entries=readZipEntries(downloaded);if(entries.size!==files.length)throw Error('Native archive file set mismatch');
const verification=createTestWorkspace(root,{label:'native-adapter-code-restoration'}),verify=path.join(verification.scratch,'native');fs.mkdirSync(verify);
try{for(const item of files){const bytes=entries.get(item.path);if(!bytes||hash(bytes)!==item.sha256)throw Error('Native restore file mismatch');const target=path.resolve(verify,item.path);if(!target.startsWith(verify+path.sep))throw Error('Restore path escape');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);if(hash(fs.readFileSync(target))!==item.sha256)throw Error('Native disk restoration failed');}}
finally{const cleanup=cleanupTestWorkspace(root,verification.folder);fs.writeFileSync(path.join(verification.report,'summary.json'),JSON.stringify({kind:'native-adapter-code-restoration',cleanup},null,2));}
for(const [file,digest]of before)if(hash(fs.readFileSync(file))!==digest)throw Error('Native program changed during cloud verification');
const changes=[];
try{for(const [file,bytes]of changed){const temp=path.join(path.dirname(file),'.thinkstar-next-'+randomUUID());fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,file);if(hash(fs.readFileSync(file))!==hash(bytes))throw Error('Native install verification failed');changes.push({path:file,before_sha256:before.get(file),after_sha256:hash(bytes)});}}
catch(error){for(const item of changes)fs.writeFileSync(item.path,snapshot.get(path.relative(modules,item.path).split(path.sep).join('/')));throw error;}
const receipt={at:new Date().toISOString(),code_only:true,configuration_modified:false,private_data_included:false,public_download_verified:true,code_restoration_verified:true,release_url:release.html_url,zip_asset:base+'.zip',tree_sha256:tree,changes,requires_memory_user_selection:!only||only==='memory',verification_report:verification.report};
const ledger=path.join(root,'runtime-data/installations');fs.mkdirSync(ledger,{recursive:true});fs.writeFileSync(path.join(ledger,'native-group-update.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
