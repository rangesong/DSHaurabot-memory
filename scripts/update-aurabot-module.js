// Cloud-verified code-only update. Memory, host settings and private assets stay in place.
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {updateAurabotModule} from './lib/module-updater.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --data-dir <absolute Aurabot directory> [--apply]');
console.log(JSON.stringify(await updateAurabotModule({root,data:path.resolve(args[at+1]),apply:args.includes('--apply')}),null,2));
