import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';import {createHash} from 'node:crypto';
export function installedKernel(file){
 const source=fs.readFileSync(file,'utf8'),start=source.indexOf('function indexToRef('),end=source.indexOf('function createScanner(');
 if(start<0||end<start||end>400000)throw Error('Unrecognized kernel boundary');
 const context=vm.createContext({createHash,path,TextEncoder,TextDecoder,Buffer,readFileSync(){throw Error('No file reads permitted inside isolated kernel');},readdirSync(){throw Error('No directory reads permitted inside isolated kernel');},__esm:fn=>function init(){if(fn){const f=Object.values(fn)[0];fn=null;f();}},__export:(target,defs)=>{for(const[k,v]of Object.entries(defs))Object.defineProperty(target,k,{get:v,enumerable:true});}});
 const pure=source.slice(start,end).replace(/import(?:\{[^}]+\}|\*as \w+)\s*from["'][^"']+["'];/g,'').replaceAll('createRequire(import.meta.url)','(()=>{throw Error("No module loading inside isolated kernel")})');
 try{return vm.runInContext(pure+'\ninit_dist();({createCore,defaultConfig,createInitialState,prune});',context,{timeout:10000});}catch(e){throw Error('Isolated kernel: '+e.message);}
}
