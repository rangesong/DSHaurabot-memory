import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const nativePatchManifest=()=>JSON.parse(readFileSync(new URL('../../adapters/aurabot/native/patches.json',import.meta.url),'utf8'));
/** Same pure import rewrite used by Aurabot's built-in "fork" command. No host setup. */
export function forkBuiltinMemory(src){
  const loader=readFileSync(path.join(src,'core/modules.js'),'utf8');
  const start=loader.indexOf('export function rewriteImports('),end=loader.indexOf('\n}',start)+2;
  if(start<0||end<start)throw Error('宿主导入改写器不可确认');
  const rewrite=Function('return ('+loader.slice(start,end).replace('export function','function')+')')();
  const own=new Map([['modules/memory/index.js','index.mjs'],...['memory','memory-rules','memory-store','memory-vector'].map(name=>['features/'+name+'.js',name+'.js'])]);
  const output=new Map();
  for(const [key,name]of own){let code=rewrite(readFileSync(path.join(src,...key.split('/')),'utf8'),key,new Set(own.keys()));
    for(const [key2,name2]of own){const rel=path.posix.relative(path.posix.dirname(key),key2),specifier=rel.startsWith('.')?rel:'./'+rel;code=code.split("'"+specifier+"'").join("'./"+name2+"'");}
    output.set(name,Buffer.from('// Current Aurabot builtin copy; source: src/'+key+'\n'+code));
  }
  return output;
}
export function patchNativeSource(bytes,entry){
  if(hash(bytes)===entry.after_sha256)return bytes;
  if(hash(bytes)!==entry.before_sha256)throw Error('原生源码已变化，请重新核对补丁：'+entry.module+'/'+entry.file);
  let text=bytes.toString('utf8').replaceAll('\r\n','\n');
  for(const op of entry.operations){if(text.split(op.find).length!==2)throw Error('原生补丁锚点不唯一');text=text.replace(op.find,op.replace);}
  const result=Buffer.from(text);if(hash(result)!==entry.after_sha256)throw Error('原生补丁结果校验失败');return result;
}
