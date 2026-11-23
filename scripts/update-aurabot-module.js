// Cloud-verified code-only update. Memory, host settings and private assets stay in place.
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {updateAurabotModule} from './lib/module-updater.js';
import {updateContextModule} from './lib/context-module-updater.js';
import {updateCompressionEngine} from './lib/compression-engine-updater.js';
import {patchBillionReconciliation} from './lib/billion-reconciliation-patch.js';
import {patchBillionEgressRecovery} from './lib/billion-egress-recovery-patch.js';
import {patchBillionScopedEgress} from './lib/billion-scoped-egress-patch.js';
import {updateNativeChat} from './lib/native-chat-updater.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(args.includes('--help')){console.log('Use --data-dir <absolute Aurabot directory> [--apply]. Default updates Thinkstar. --extension <fish-world|history-vault> updates that module. --native-host <absolute dsh-aurabot-qq directory> with --repair-owner-replies and/or --repair-native-context installs reviewed exact-version repairs; archive complete allowlisted host/forked-memory code and verify public download and disk restoration before writing. Native context adds an owner-scoped, preview/CAS panel maintenance API; installing it alone does not change memories. No models, chats, private data or host settings are published. Existing --compression-engine and repair flags remain supported. Native repairs require an idle host and official plugin reload after installation; they never restart or message on their own.');process.exit(0);}
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --data-dir <absolute Aurabot directory> [--apply]');
const ext=args.indexOf('--extension');
const engine=args.indexOf('--compression-engine');
const native=args.indexOf('--native-host');
if(native>=0){
 const replies=args.includes('--repair-owner-replies'),context=args.includes('--repair-native-context');
 if(ext>=0||engine>=0||!path.isAbsolute(args[native+1]??'')||!replies&&!context)throw Error('Choose one --native-host target and a reviewed repair flag');
 const transforms=[];
 if(replies){const {patchOwnerReplies}=await import('./lib/owner-reply-patch.js');transforms.push({area:'host',path:'src/chat/hub.js',transform:(source,options)=>patchOwnerReplies(source,options).source});}
 if(context){
  const {patchNativeContextReview}=await import('./lib/native-context-patch.js'),helper=readFileSync(new URL('../adapters/aurabot/native/context-review.js',import.meta.url),'utf8');
  transforms.push({area:'modules',path:'memory/context-review.js',transform:source=>{if(source!==null&&source!==helper)throw Error('Unrecognized existing native context helper');return helper;}},{area:'modules',path:'memory/index.mjs',transform:(source,options)=>patchNativeContextReview(source,options).source});
 }
 const receipt=await updateNativeChat({root,data:path.resolve(args[at+1]),host:path.resolve(args[native+1]),apply:args.includes('--apply'),transforms});
 console.log(JSON.stringify(receipt,null,2));process.exit(0);
}
if(args.includes('--repair-owner-replies')||args.includes('--repair-native-context'))throw Error('Native repair flags require --native-host');
if(engine>=0&&ext>=0)throw Error('Choose one update target');
const egress=args.includes('--repair-egress');if(egress&&engine<0)throw Error('--repair-egress requires --compression-engine');
const scoped=args.includes('--repair-scoped-egress');if(scoped&&engine<0)throw Error('--repair-scoped-egress requires --compression-engine');
if(egress&&scoped)throw Error('Choose one reviewed engine repair');
console.log(JSON.stringify(await (engine>=0?updateCompressionEngine({root,folder:args[engine+1],apply:args.includes('--apply'),transform:source=>(scoped?patchBillionScopedEgress:egress?patchBillionEgressRecovery:patchBillionReconciliation)(source,{version:'0.1.216'}).source}):ext>=0?updateContextModule({root,data:path.resolve(args[at+1]),id:args[ext+1],apply:args.includes('--apply')}):updateAurabotModule({root,data:path.resolve(args[at+1]),apply:args.includes('--apply')})),null,2));
