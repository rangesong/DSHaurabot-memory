import { readFileSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),version=process.argv[2],extAt=process.argv.indexOf('--extension');
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version??''))throw new Error('Usage: node scripts/set-module-version.js 0.2.1');
if(extAt>=0){
  const id=process.argv[extAt+1];if(!['fish-world','history-vault'].includes(id)||!/^\d+\.\d+\.\d+$/.test(version))throw Error('Use --extension fish-world|history-vault with a stable version');
  const folder=join(root,'extensions/aurabot',id),metadata=join(folder,'module.json'),index=join(folder,'index.mjs'),value=JSON.parse(readFileSync(metadata,'utf8')),before=readFileSync(index,'utf8');
  const escaped=value.version.replaceAll('.','\\.'),pattern=new RegExp('version:\\s*(["\'])'+escaped+'\\1','g');let count=0;
  const after=before.replace(pattern,()=>{count++;return 'version:'+JSON.stringify(version);});
  if(value.id!==id||!count)throw Error('Extension version source mismatch; no files written');
  value.version=version;writeFileSync(metadata,JSON.stringify(value,null,2)+'\n');writeFileSync(index,after);console.log('Updated extension '+id+' to '+version);process.exit(0);
}
for(const name of ['package.json','adapters/aurabot/module/module.json']){
  const file=join(root,name),value=JSON.parse(readFileSync(file,'utf8'));value.version=version;writeFileSync(file,JSON.stringify(value,null,2)+'\n');
}
console.log('Updated source version to '+version+'. Review the change before committing or tagging.');
