import {fileURLToPath} from 'node:url';
import {buildContextModule} from './lib/context-module-updater.js';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const id of process.argv.slice(2).length?process.argv.slice(2):['fish-world','history-vault'])console.log(JSON.stringify(buildContextModule(root,id)));
