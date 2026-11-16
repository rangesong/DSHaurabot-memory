import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),source=path.resolve(root,'github-repository'),args=process.argv.slice(2),at=args.indexOf('--to');
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --to <absolute empty destination> [--apply]');
const target=path.resolve(args[at+1]),parent=path.dirname(target),same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
if(target===path.parse(target).root||same(target,parent)||target.startsWith(source+path.sep)||source.startsWith(target+path.sep)||same(target,source))throw Error('Invalid repository destination');
for(const dir of [source,parent])if(fs.lstatSync(dir).isSymbolicLink()||!same(fs.realpathSync(dir),dir))throw Error('Redirected repository path');
if(!fs.existsSync(path.join(source,'.git'))||JSON.parse(fs.readFileSync(path.join(source,'.thinkstar-export.json'))).kind!=='thinkstar-source-export')throw Error('Not the prepared Thinkstar Git repository');
if(fs.existsSync(target)&&(fs.lstatSync(target).isSymbolicLink()||!same(fs.realpathSync(target),target)||fs.readdirSync(target).length))throw Error('Destination must be an empty regular directory');
function inventory(base){const files=new Map();const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Repository symlink refused');if(entry.isDirectory())walk(file);else if(entry.isFile())files.set(path.relative(base,file),createHash('sha256').update(fs.readFileSync(file)).digest('hex'));}};walk(base);return files;}
const before=inventory(source);
if(!args.includes('--apply'))console.log(JSON.stringify({source,target,files:before.size,includes_git_history:true,ready:true}));
else{
  // Both absolute endpoints were validated; only the explicitly empty destination is removed.
  if(fs.existsSync(target))fs.rmdirSync(target);fs.renameSync(source,target);
  const after=inventory(target);if(after.size!==before.size||[...before].some(([file,hash])=>after.get(file)!==hash))throw Error('Repository verification failed; preserve both endpoints for review');
  const receipt={kind:'thinkstar-repository-location',repository:target,previous:source,at:new Date().toISOString(),files_verified:after.size,git_metadata_preserved:true};
  fs.mkdirSync(path.join(root,'runtime-data'),{recursive:true});fs.writeFileSync(path.join(root,'runtime-data/repository-location.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}
