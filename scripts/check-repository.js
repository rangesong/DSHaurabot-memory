import { readFileSync,readdirSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join,resolve,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PARAMS } from '../core/v5-config.js';
import { PARAM_HELP } from '../core/v5-param-help.js';

const root=fileURLToPath(new URL('../',import.meta.url)),errors=[],files=[];
function walk(path){for(const item of readdirSync(join(root,path),{withFileTypes:true})){const name=path+'/'+item.name;if(item.isSymbolicLink()){errors.push('Source symlink: '+name);continue;}if(item.isDirectory())walk(name);else if(/\.(?:m?js)$/.test(name))files.push(name);}}
for(const folder of ['core','shared','adapters','server','scripts','test','fixtures','apps/memory-sea/src'])walk(folder);
for(const file of files){
  const source=readFileSync(join(root,file),'utf8');
  const panel=file==='adapters/aurabot/module/panel.js';
  const code=panel?'function panel(React,h,ui,call){\n'+source+'\n}':source;
  const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:code,encoding:'utf8',windowsHide:true});
  if(result.status!==0)errors.push(file+': '+result.stderr);
  for(const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s*from\s*)?['"](\.{1,2}\/[^'"\n]+)['"]/g))if(!existsSync(resolve(dirname(join(root,file)),match[1])))errors.push('Missing import in '+file+': '+match[1]);
}
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8')),module=JSON.parse(readFileSync(join(root,'adapters/aurabot/module/module.json'),'utf8'));
if(pkg.version!==module.version)errors.push('Project and module versions differ');
let parameters=0;for(const [region,definitions] of Object.entries(PARAMS))for(const key of Object.keys(definitions)){parameters++;for(const field of ['meaning','effect','higher','lower'])if(!PARAM_HELP[region]?.[key]?.[field])errors.push('Missing parameter help: '+region+'.'+key+'.'+field);}
const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
if(tracked.status===0){
  for(const path of tracked.stdout.split('\0').filter(Boolean)){
    if(/(^|\/)(?:runtime-data|dist|node_modules|\.work|github-repository)(?:\/|$)|(?:\.sqlite(?:-(?:wal|shm))?|\.glb|\.env(?:\..*)?)$/i.test(path)||path.startsWith('docs/assets/'))errors.push('Private or generated file tracked: '+path);
    if(/\.(?:js|mjs|json|md|yml|yaml|txt)$/.test(path)&&/\b(?:sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(readFileSync(join(root,path),'utf8')))errors.push('Potential credential literal in tracked file: '+path);
    if(path.endsWith('.json'))try{JSON.parse(readFileSync(join(root,path),'utf8'));}catch{errors.push('Invalid JSON: '+path);}
  }
}
if(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME!=='v'+module.version)errors.push('Release tag must equal v'+module.version);
if(errors.length){for(const error of errors)console.error(error);process.exitCode=1;}else console.log(`Static checks passed: ${files.length} JavaScript sources, ${parameters} parameter explanations, module ${module.version}. No memory runtime was started.`);
