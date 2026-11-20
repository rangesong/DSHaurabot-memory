import fs from 'node:fs';import {fileURLToPath} from 'node:url';
import {updateWorkHours} from './lib/work-hours-updater.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
if(!args.includes('--host-root')||!args.includes('--modules-root'))throw Error('Use --host-root <absolute host package> --modules-root <absolute modules directory> [--apply]');
const manifest=JSON.parse(fs.readFileSync(new URL('../adapters/aurabot/native/work-hours-patches.json',import.meta.url)));
console.log(JSON.stringify(await updateWorkHours({root,host:arg('--host-root'),modules:arg('--modules-root'),manifest,apply:args.includes('--apply')}),null,2));
