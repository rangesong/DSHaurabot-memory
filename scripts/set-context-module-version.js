import fs from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';
const [id,version]=process.argv.slice(2);if(!['fish-world','history-vault'].includes(id)||!/^\d+\.\d+\.\d+$/.test(version||''))throw Error('Usage: node scripts/set-context-module-version.js <module-id> <semver>');
const dir=fileURLToPath(new URL('../extensions/aurabot/'+id+'/',import.meta.url)),file=path.join(dir,'module.json'),module=JSON.parse(fs.readFileSync(file));module.version=version;fs.writeFileSync(file,JSON.stringify(module,null,2)+'\n');
let entry=fs.readFileSync(path.join(dir,'index.mjs'),'utf8');entry=entry.replace(/version:\s*(['"])\d+\.\d+\.\d+\1/g,'version:'+JSON.stringify(version));fs.writeFileSync(path.join(dir,'index.mjs'),entry);console.log(id+' '+version);
