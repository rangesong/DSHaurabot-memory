// Verified code-only update; the module's database, assets and host configuration stay outside the swap.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir'),data=path.resolve(args[at+1]??'');
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --data-dir <absolute Aurabot directory> [--apply]');
const target=path.join(data,'modules/thinkstar-memory'),source=path.join(root,'dist/aurabot/thinkstar-memory'),release=JSON.parse(fs.readFileSync(path.join(source,'thinkstar-build.json'))),old=JSON.parse(fs.readFileSync(path.join(target,'thinkstar-build.json')));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function checked(dir){if(fs.lstatSync(dir).isSymbolicLink()||!same(fs.realpathSync(dir),dir))throw Error('Refusing redirected directory: '+dir);}
function verify(dir,manifest){if(manifest.id!=='thinkstar-memory')throw Error('Wrong module identity');for(const row of manifest.files){const file=path.resolve(dir,row.path);if(!file.startsWith(path.resolve(dir)+path.sep)||fs.lstatSync(file).isSymbolicLink()||hash(file)!==row.sha256)throw Error('Code changed independently: '+row.path);}}
checked(data);checked(path.join(data,'modules'));checked(target);verify(target,old);verify(source,release);
if(!args.includes('--apply')){console.log(JSON.stringify({verified:true,from:old.version,to:release.version,target,code_only:true}));}
else{
 const id=randomUUID(),staging=path.join(root,'runtime-data/installations','stage-'+id),previous=path.join(root,'runtime-data/installations',old.version+'-before-'+release.version+'-'+id);fs.mkdirSync(path.dirname(staging),{recursive:true});
 fs.cpSync(source,staging,{recursive:true});checked(staging);verify(staging,release);
 if(!previous.startsWith(path.join(root,'runtime-data/installations')+path.sep)||target!==path.join(data,'modules','thinkstar-memory'))throw Error('Unexpected swap destinations');
 fs.renameSync(target,previous);
 try{fs.renameSync(staging,target);}catch(error){fs.renameSync(previous,target);throw error;}
 verify(target,release);const receipt={at:new Date().toISOString(),from:old.version,to:release.version,target,previous,files_verified:release.files.length,code_only:true,configuration_modified:false,original_assets_modified:false};
 fs.writeFileSync(path.join(root,'runtime-data/installations/last-update.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}
