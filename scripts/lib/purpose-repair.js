import fs from 'node:fs';
import {patchPurposeEngine} from './purpose-engine-patch.js';
import {patchPurposeModule,patchPurposeRegistration} from './purpose-module-patch.js';
import {patchPurposeSession} from './purpose-session-patch.js';
export function purposeRepairTransforms(){
  const helper=(name)=>{const expected=fs.readFileSync(new URL('../../adapters/aurabot/native/'+name,import.meta.url),'utf8');return source=>{if(source!==null&&source!==expected)throw Error('Unreviewed installed purpose helper');return expected;};};
  return [
    {area:'host',path:'src/purpose/evidence.js',transform:helper('purpose-evidence.js')},
    {area:'host',path:'src/purpose/outreach-guard.js',transform:helper('purpose-outreach-guard.js')},
    {area:'host',path:'src/purpose/engine.js',transform:(source,options)=>patchPurposeEngine(source,options).source},
    {area:'host',path:'src/purpose/module.js',transform:(source,options)=>patchPurposeModule(source,options).source},
    {area:'host',path:'src/modules/purpose/index.js',transform:(source,options)=>patchPurposeRegistration(source,options).source},
    {area:'host',path:'src/chat/hub.js',transform:(source,options)=>patchPurposeSession(source,options).source},
  ];
}
