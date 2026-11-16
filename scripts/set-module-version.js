import { readFileSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),version=process.argv[2];
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version??''))throw new Error('Usage: node scripts/set-module-version.js 0.2.1');
for(const name of ['package.json','adapters/aurabot/module/module.json']){
  const file=join(root,name),value=JSON.parse(readFileSync(file,'utf8'));value.version=version;writeFileSync(file,JSON.stringify(value,null,2)+'\n');
}
console.log('Updated source version to '+version+'. Review the change before committing or tagging.');
