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
import {sha256} from './lib/work-hours-patches.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(args.includes('--help')){console.log('Use --data-dir <absolute Aurabot directory> [--apply]. Default updates Thinkstar. --extension <fish-world|history-vault> updates that module. --native-host <absolute dsh-aurabot-qq directory> with --repair-owner-replies, --repair-native-context, --repair-background and/or --repair-profiles or --fish-people-panel installs reviewed exact-version repairs; archive complete allowlisted host/forked-memory code and verify public download and disk restoration before writing. Background repairs cover self-drive reports/budget and bounded ZIP64/streaming backups. Profile repairs preserve existing portraits during compression and retry incomplete portraits within a bounded budget. Background/profile/panel --apply requires --host-origin <loopback HTTP origin> and verifies idle owned agents. Native context adds an owner-scoped, preview/CAS panel maintenance API; installing it alone does not change memories. Fish people adds a read-only source switch within the existing person wall; it requires the updated fish-world extension. No models, chats, private data or host settings are published. Existing --compression-engine and repair flags remain supported. Native repairs require an idle host and official plugin reload after installation; they never restart or message on their own.');process.exit(0);}
if(at<0||!path.isAbsolute(args[at+1]??''))throw Error('Use --data-dir <absolute Aurabot directory> [--apply]');
const ext=args.indexOf('--extension');
const engine=args.indexOf('--compression-engine');
const native=args.indexOf('--native-host');
if(native>=0){
 const replies=args.includes('--repair-owner-replies'),context=args.includes('--repair-native-context'),background=args.includes('--repair-background'),profiles=args.includes('--repair-profiles'),fishPeople=args.includes('--fish-people-panel');
 if(ext>=0||engine>=0||!path.isAbsolute(args[native+1]??'')||!replies&&!context&&!background&&!profiles&&!fishPeople)throw Error('Choose one --native-host target and a reviewed repair flag');
 const transforms=[];
 if(replies){const {patchOwnerReplies}=await import('./lib/owner-reply-patch.js');transforms.push({area:'host',path:'src/chat/hub.js',transform:(source,options)=>patchOwnerReplies(source,options).source});}
 if(context){
  const {patchNativeContextReview}=await import('./lib/native-context-patch.js'),helper=readFileSync(new URL('../adapters/aurabot/native/context-review.js',import.meta.url),'utf8');
  transforms.push({area:'modules',path:'memory/context-review.js',transform:source=>{if(source!==null&&source!==helper)throw Error('Unrecognized existing native context helper');return helper;}},{area:'modules',path:'memory/index.mjs',transform:(source,options)=>patchNativeContextReview(source,options).source});
 }
 if(profiles){
  const {patchProfileLifecycle,patchProfilePanel}=await import('./lib/profile-lifecycle-patch.js');
  transforms.push({area:'modules',path:'memory/memory.js',transform:(source,options)=>patchProfileLifecycle(source,options).source},{area:'host',path:'client/client.js',transform:(source,options)=>patchProfilePanel(source,options).source});
 }
 if(fishPeople){
  const {patchFishPeoplePanel}=await import('./lib/fish-people-panel-patch.js');
  const previous=transforms.find(change=>change.area==='host'&&change.path==='client/client.js');
  if(previous){const beforePanel=previous.transform;previous.transform=(source,options)=>patchFishPeoplePanel(beforePanel(source,options),options).source;}
  else transforms.push({area:'host',path:'client/client.js',transform:(source,options)=>patchFishPeoplePanel(source,options).source});
 }
 if(background){
  const {patchAutotelicCorrectness,patchAutotelicReportLabels}=await import('./lib/autotelic-correctness-patch.js'),{patchBackupCapacity,BACKUP_CAPACITY_BASELINES,BACKUP_CAPACITY_PREVIOUS_HELPER_SHA256}=await import('./lib/backup-capacity-patch.js');
  const helper=readFileSync(new URL('../adapters/aurabot/native/backup-zip64.js',import.meta.url),'utf8');
  transforms.push({area:'host',path:'src/autotelic/runtime.js',transform:(source,options)=>patchAutotelicCorrectness(source,options).source});
  transforms.push({area:'host',path:'src/autotelic/reflect.js',transform:(source,options)=>patchAutotelicReportLabels(source,options).source});
  transforms.push({area:'host',path:'src/core/backup-zip64.js',transform:source=>{if(source!==null&&source!==helper&&![BACKUP_CAPACITY_PREVIOUS_HELPER_SHA256,'ef88d2a77a982f320f3c978c71a13b7a669227d7ce7c49aa23144b09b77cbfe1'].includes(sha256(source)))throw Error('Unrecognized existing ZIP64 backup helper');return helper;}});
  for(const file of Object.keys(BACKUP_CAPACITY_BASELINES))transforms.push({area:'host',path:file,transform:(source,options)=>patchBackupCapacity(source,{...options,file}).source});
 }
 let validateHost;
 if((background||profiles||fishPeople)&&args.includes('--apply')){
  const originAt=args.indexOf('--host-origin');if(originAt<0)throw Error('Background/profile/panel apply requires --host-origin <loopback HTTP origin> to verify idle owned agents');
  const origin=new URL(args[originAt+1]);
  if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Use an exact loopback HTTP origin');
  validateHost=async()=>{const response=await fetch(new URL('/aurabot/api/maintenance/host-status',origin),{signal:AbortSignal.timeout(5000)}),state=response.ok?await response.json():null;if(!state?.ok||!state.ownershipKnown||!state.quiescent||state.pending||state.aurabot?.enabled!==true||state.aurabot?.readOnlyReason)throw Error('Native host is busy or cannot verify safe reload ownership; no code replaced');};
  await validateHost();
 }
 const receipt=await updateNativeChat({root,data:path.resolve(args[at+1]),host:path.resolve(args[native+1]),apply:args.includes('--apply'),transforms,validateHost});
 console.log(JSON.stringify(receipt,null,2));process.exit(0);
}
if(args.includes('--repair-owner-replies')||args.includes('--repair-native-context')||args.includes('--repair-background')||args.includes('--repair-profiles')||args.includes('--fish-people-panel'))throw Error('Native repair flags require --native-host');
if(engine>=0&&ext>=0)throw Error('Choose one update target');
const egress=args.includes('--repair-egress');if(egress&&engine<0)throw Error('--repair-egress requires --compression-engine');
const scoped=args.includes('--repair-scoped-egress');if(scoped&&engine<0)throw Error('--repair-scoped-egress requires --compression-engine');
if(egress&&scoped)throw Error('Choose one reviewed engine repair');
console.log(JSON.stringify(await (engine>=0?updateCompressionEngine({root,folder:args[engine+1],apply:args.includes('--apply'),transform:source=>(scoped?patchBillionScopedEgress:egress?patchBillionEgressRecovery:patchBillionReconciliation)(source,{version:'0.1.216'}).source}):ext>=0?updateContextModule({root,data:path.resolve(args[at+1]),id:args[ext+1],apply:args.includes('--apply')}):updateAurabotModule({root,data:path.resolve(args[at+1]),apply:args.includes('--apply')})),null,2));
