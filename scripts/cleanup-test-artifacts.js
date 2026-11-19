import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recoverTestWorkspaces} from './lib/test-workspace.js';
const root=fileURLToPath(new URL('../',import.meta.url)),runs=recoverTestWorkspaces(root);
if(runs.length){
  const folder=path.join(root,'runtime-data/test-reports');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,`cleanup-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),runs},null,2));
}
console.log(JSON.stringify({scope:'owned synthetic test runs only',runs},null,2));
if(runs.some(run=>run.state==='retained_for_review'))process.exitCode=1;
