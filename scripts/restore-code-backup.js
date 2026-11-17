import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {GitHubClient} from './lib/github-client.js';import {restoreBackup} from './lib/code-backups.js';
const root=fileURLToPath(new URL('../',import.meta.url)),policy=JSON.parse(fs.readFileSync(path.join(root,'release/backup-policy.json'))),args=process.argv.slice(2),get=name=>{const n=args.indexOf(name);return n<0?null:args[n+1];},version=get('--version'),tree=get('--snapshot'),destination=get('--output');
if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version??'')||!destination||!path.isAbsolute(destination))throw Error('Use --version <version> [--snapshot <hash prefix>] --output <new absolute directory>');
if(tree&&!/^[a-f0-9]{8,64}$/.test(tree))throw Error('Invalid snapshot prefix');
const client=new GitHubClient(policy.repository),release=await client.release(policy.tag_prefix+version);if(!release||release.draft)throw Error('Published backup release unavailable');
const assets=await client.assets(release),candidates=assets.filter(a=>a.name.startsWith('thinkstar-code-'+version+'-')&&a.name.endsWith('.restore.json')&&(!tree||a.name.includes('-'+tree)));
if(candidates.length!==1){console.log(JSON.stringify({available:candidates.map(a=>a.name)}));throw Error('Select one exact snapshot using --snapshot');}
const manifest=JSON.parse((await client.download(candidates[0],{publicOnly:true})).toString()),zipAsset=assets.find(a=>a.name===candidates[0].name.replace(/\.restore\.json$/,'.zip'));if(!zipAsset)throw Error('Code ZIP missing');
const zip=await client.download(zipAsset,{publicOnly:true}),folder=restoreBackup(zip,manifest,destination);
console.log(JSON.stringify({restored:folder,version:manifest.version,files:manifest.files.length,tree_sha256:manifest.tree_sha256,storage_schema_declared:manifest.storage_schema_declared,live_plugin_or_database_modified:false,note:'只导出代码；未覆盖现用插件。旧版与当前记忆库的兼容性必须单独核对。'},null,2));
