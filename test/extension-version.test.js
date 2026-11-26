import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
function fixture(){
 const root=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'version-'));
 const put=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
 put('scripts/set-module-version.js',fs.readFileSync(new URL('../scripts/set-module-version.js',import.meta.url),'utf8'));
 put('package.json',JSON.stringify({type:'module',version:'0.7.5'}));put('adapters/aurabot/module/module.json',JSON.stringify({version:'0.7.5'}));
 put('extensions/aurabot/fish-world/module.json',JSON.stringify({id:'fish-world',version:'1.3.17'}));
 put('extensions/aurabot/fish-world/index.mjs','export default {version:"1.3.17",setup(){return {version:"1.3.17"}}};');
 return {root,read:name=>fs.readFileSync(path.join(root,name),'utf8'),run:args=>spawnSync(process.execPath,[path.join(root,'scripts/set-module-version.js'),...args],{encoding:'utf8',windowsHide:true})};
}
test('extension versioning synchronizes its declarations without changing the memory module version',()=>{
 const f=fixture(),before=f.read('package.json');const result=f.run(['1.3.19','--extension','fish-world']);assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(f.read('extensions/aurabot/fish-world/module.json')).version,'1.3.19');assert.equal(f.read('extensions/aurabot/fish-world/index.mjs').match(/1\.3\.19/g).length,2);
 assert.equal(f.read('package.json'),before);assert.equal(JSON.parse(f.read('adapters/aurabot/module/module.json')).version,'0.7.5');
});
test('existing memory-module version mode and rejection before unknown extension writes remain intact',()=>{
 const f=fixture(),before=f.read('extensions/aurabot/fish-world/module.json');assert.notEqual(f.run(['1.3.19','--extension','unknown']).status,0);assert.equal(f.read('extensions/aurabot/fish-world/module.json'),before);
 assert.equal(f.run(['0.7.6']).status,0);assert.equal(JSON.parse(f.read('package.json')).version,'0.7.6');assert.equal(JSON.parse(f.read('adapters/aurabot/module/module.json')).version,'0.7.6');assert.equal(f.read('extensions/aurabot/fish-world/module.json'),before);
});
