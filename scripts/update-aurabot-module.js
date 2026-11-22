// Cloud-verified code-only update. Memory, host settings and private assets stay in place.
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {updateAurabotModule} from './lib/module-updater.js';
import {updateContextModule} from './lib/context-module-updater.js';
import {updateCompressionEngine} from './lib/compression-engine-updater.js';
import {patchBillionReconciliation} from './lib/billion-reconciliation-patch.js';
import {patchBillionEgressRecovery} from './lib/billion-egress-recovery-patch.js';
import {patchBillionScopedEgress} from './lib/billion-scoped-egress-patch.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --data-dir <absolute Aurabot directory> [--apply]');
const ext=args.indexOf('--extension');
const engine=args.indexOf('--compression-engine');
if(engine>=0&&ext>=0)throw Error('Choose one update target');
const egress=args.includes('--repair-egress');if(egress&&engine<0)throw Error('--repair-egress requires --compression-engine');
const scoped=args.includes('--repair-scoped-egress');if(scoped&&engine<0)throw Error('--repair-scoped-egress requires --compression-engine');
if(egress&&scoped)throw Error('Choose one reviewed engine repair');
console.log(JSON.stringify(await (engine>=0?updateCompressionEngine({root,folder:args[engine+1],apply:args.includes('--apply'),transform:source=>(scoped?patchBillionScopedEgress:egress?patchBillionEgressRecovery:patchBillionReconciliation)(source,{version:'0.1.216'}).source}):ext>=0?updateContextModule({root,data:path.resolve(args[at+1]),id:args[ext+1],apply:args.includes('--apply')}):updateAurabotModule({root,data:path.resolve(args[at+1]),apply:args.includes('--apply')})),null,2));
