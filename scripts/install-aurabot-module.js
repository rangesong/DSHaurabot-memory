// First install or identical re-run only. Never overwrites an existing different module or database.
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync,renameSync,rmSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(at<0||!args[at+1]||!isAbsolute(args[at+1]))throw new Error('Provide --data-dir with the absolute Aurabot data directory. Add --apply to install.');
const data=realpathSync(resolve(args[at+1])),modules=join(data,'modules'),target=join(modules,'thinkstar-memory'),assetDir=join(data,'modules-data/thinkstar-memory/assets');
if(!existsSync(join(data,'config.json'))||!existsSync(modules))throw new Error('Target is not an existing Aurabot data directory.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const release=JSON.parse(readFileSync(join(root,'dist/aurabot/release.json'),'utf8')),source=join(root,'dist/aurabot/thinkstar-memory');
const resource=JSON.parse(readFileSync(join(root,'release/resources.json'),'utf8'));
if(release.id!=='thinkstar-memory'||release.model_sha256!==resource.sha256)throw new Error('Build/resource manifest mismatch.');
function inside(base,path){if(resolve(path)===resolve(base)||!resolve(path).toLowerCase().startsWith((resolve(base)+sep).toLowerCase()))throw new Error('Path left intended directory: '+path);return path;}
function regular(path){if(lstatSync(path).isSymbolicLink())throw new Error('Symlink refused: '+path);if(!realpathSync(path).toLowerCase().startsWith((data+sep).toLowerCase()))throw new Error('Target escaped Aurabot data directory.');}
function verify(base){for(const entry of release.files){const path=inside(base,resolve(base,entry.path));if(!existsSync(path)||lstatSync(path).isSymbolicLink()||sha(readFileSync(path))!==entry.sha256)throw new Error('Module file differs: '+entry.path);}}
verify(source);regular(modules);
const already=existsSync(target);if(already){regular(target);verify(target);}
const modelSource=join(root,'apps/memory-sea/assets',resource.file);
if(sha(readFileSync(modelSource))!==resource.sha256)throw new Error('Model source hash mismatch.');
for(const path of [join(data,'modules-data'),join(data,'modules-data/thinkstar-memory'),assetDir])if(existsSync(path))regular(path);
const asset=join(assetDir,resource.file);
if(existsSync(asset)){regular(asset);if(sha(readFileSync(asset))!==resource.sha256)throw new Error('Existing model differs; it was not overwritten.');}
if(!args.includes('--apply')){
  console.log(JSON.stringify({checked:true,version:release.version,module:target,asset,existing_identical_module:already,configuration_modified:false}));
}else{
  const stage=inside(modules,join(modules,'_thinkstar-install-'+randomUUID()));
  try{
    mkdirSync(assetDir,{recursive:true});regular(assetDir);
    if(!existsSync(asset)){
      const temporary=inside(assetDir,join(assetDir,'.model-'+randomUUID()+'.tmp'));
      try{copyFileSync(modelSource,temporary);if(sha(readFileSync(temporary))!==resource.sha256)throw new Error('Copied model hash mismatch.');if(existsSync(asset))throw new Error('Asset appeared during installation; retry.');renameSync(temporary,asset);}finally{if(existsSync(temporary)){regular(temporary);rmSync(temporary);}}
    }
    if(!already){
      mkdirSync(stage);regular(stage);
      for(const entry of [...release.files,{path:'thinkstar-build.json'}]){
        const path=inside(stage,resolve(stage,entry.path));mkdirSync(dirname(path),{recursive:true});copyFileSync(inside(source,resolve(source,entry.path)),path);
      }
      verify(stage);inside(modules,target);if(existsSync(target))throw new Error('Module appeared during installation; retry.');renameSync(stage,target);
    }
    const receipt={version:release.version,module:target,data:join(data,'modules-data/thinkstar-memory'),model_sha256:resource.sha256,installed_at:new Date().toISOString(),configuration_modified:false,existing_data_migrated:false,code_files:release.files.length};
    const receipts=join(root,'runtime-data/installations');mkdirSync(receipts,{recursive:true});writeFileSync(join(receipts,'aurabot-thinkstar.json'),JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt,null,2));
  }finally{
    if(existsSync(stage)){inside(modules,stage);regular(stage);if(!stage.split(sep).at(-1).startsWith('_thinkstar-install-'))throw new Error('Unexpected stage path.');rmSync(stage,{recursive:true,force:true});}
  }
}
