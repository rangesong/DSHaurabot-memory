import fs from 'node:fs';import path from 'node:path';
export function extractRuntime(file,scratch){
const fd=fs.openSync(file,'r'),h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);
const hs=h.readUInt32LE(4),b=Buffer.alloc(h.readUInt32LE(12));fs.readSync(fd,b,0,b.length,16);const tree=JSON.parse(b.toString());

if(!scratch)throw Error('Use run-tests.mjs: runtime extraction requires a managed test scratch.');
const runtime=path.join(scratch,'installed-runtime'),queue=['@deepseek-ai/dsh-session','@deepseek-ai/dsh-token-meter'],seen=new Set();
fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(runtime+'/package.json','{"type":"module"}');
const find=p=>{let n=tree;for(const k of p.split('/'))n=n?.files?.[k];return n;};
function bytes(n,p){if(n.unpacked)return fs.readFileSync(file+'.unpacked/'+p);const b=Buffer.alloc(n.size);fs.readSync(fd,b,0,b.length,8+hs+Number(n.offset));return b;}
while(queue.length){
 const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);
 const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));if(!prefix)throw Error('Runtime package not found: '+pkg);
 function copy(n,p=''){for(const [k,v]of Object.entries(n.files||{})){const q=p?p+'/'+k:k;if(v.files){copy(v,q);continue;}if(!/\.(js|mjs|cjs|json)$/.test(k))continue;
 const data=bytes(v,prefix+'/'+q),target=path.join(runtime,'node_modules',pkg,q);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);
 if(/\.(js|mjs|cjs)$/.test(k))for(const m of data.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){
  const spec=m[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;
  const name=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0];
  if(!['fs','path','crypto','os','url','util','stream','events','buffer','assert','async_hooks','module'].includes(name))queue.push(name);
 }
 }}copy(find(prefix));
}
fs.closeSync(fd);return runtime;
}
