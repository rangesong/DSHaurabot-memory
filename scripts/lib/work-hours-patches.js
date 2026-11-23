import {createHash} from 'node:crypto';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export function applyHunks(bytes,entry){
 if(entry.before===null){if(bytes!==null)throw Error('New file already exists');const out=Buffer.from(entry.content);if(sha256(out)!==entry.after)throw Error('New file hash mismatch');return out;}
 if(!Buffer.isBuffer(bytes)||sha256(bytes)!==entry.before)throw Error('Installed code does not match the verified baseline: '+entry.path);
 if(entry.before===entry.after&&entry.hunks==='')return bytes;
 const source=bytes.toString('utf8').split('\n'),lines=entry.hunks.split('\n'),out=[];let cursor=0,i=0;
 while(i<lines.length){
  if(!lines[i]){i++;continue;}
  const m=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++]);if(!m)throw Error('Invalid patch header');
  const start=Number(m[1])-1;if(start<cursor||start>source.length)throw Error('Patch range invalid');out.push(...source.slice(cursor,start));cursor=start;
  let consumed=0,produced=0;
  while(i<lines.length&&!lines[i].startsWith('@@ ')){
   const line=lines[i++];if(line==='')continue;
   const op=line[0],body=line.slice(1);if(op==='\\')throw Error('Unsupported no-newline patch');
   if(op===' '||op==='-'){if(source[cursor++]!==body)throw Error('Patch context mismatch: '+entry.path);consumed++;}
   if(op===' '||op==='+'){out.push(body);produced++;}else if(op!=='-')throw Error('Invalid patch operation');
  }
  if(consumed!==Number(m[2]??1)||produced!==Number(m[4]??1))throw Error('Patch line count mismatch');
 }
 out.push(...source.slice(cursor));const result=Buffer.from(out.join('\n'));
 if(sha256(result)!==entry.after)throw Error('Patched output hash mismatch: '+entry.path);return result;
}
