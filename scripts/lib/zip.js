import { deflateRawSync,inflateRawSync } from 'node:zlib';

const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};

/** Deterministic, UTF-8, deflated ZIP (no ZIP64 needed for the bounded module bundles). */
export function zipFiles(files){
  const chunks=[],directory=[];let offset=0;
  for(const [path,value] of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    if(!path||path.startsWith('/')||path.split('/').some(part=>part==='..'||!part)||path.includes('\\'))throw new Error('Invalid ZIP path');
    const name=Buffer.from(path),data=Buffer.isBuffer(value)?value:Buffer.from(value),packed=deflateRawSync(data,{level:9}),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    chunks.push(local,name,packed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    directory.push(central,name);offset+=local.length+name.length+packed.length;
  }
  const index=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,index,end]);
}

/** Verify generated archives without executing their contents. */
export function readZipEntries(buffer){
  const entries=new Map(),end=buffer.length-22;
  if(end<0||buffer.readUInt32LE(end)!==0x06054b50)throw new Error('ZIP end record missing');
  const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16),size=buffer.readUInt32LE(end+12);
  if(offset+size!==end)throw new Error('Invalid ZIP directory size');
  let pos=offset,total=0;
  for(let i=0;i<count;i++){
    if(pos+46>end||buffer.readUInt32LE(pos)!==0x02014b50)throw new Error('Invalid ZIP directory');
    const flags=buffer.readUInt16LE(pos+8),method=buffer.readUInt16LE(pos+10),crc=buffer.readUInt32LE(pos+16),packed=buffer.readUInt32LE(pos+20),length=buffer.readUInt32LE(pos+24),names=buffer.readUInt16LE(pos+28),extra=buffer.readUInt16LE(pos+30),comment=buffer.readUInt16LE(pos+32),local=buffer.readUInt32LE(pos+42);
    const name=buffer.subarray(pos+46,pos+46+names).toString('utf8');
    if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>p==='..'||!p)||entries.has(name))throw new Error('Unsafe or duplicate ZIP name');
    if(flags&1||![0,8].includes(method)||local+30>offset||buffer.readUInt32LE(local)!==0x04034b50)throw new Error('Unsupported ZIP entry');
    const localNames=buffer.readUInt16LE(local+26),dataOffset=local+30+localNames+buffer.readUInt16LE(local+28);
    if(dataOffset+packed>offset||buffer.subarray(local+30,local+30+localNames).toString('utf8')!==name)throw new Error('ZIP entry header mismatch');
    total+=length;if(total>64*1024*1024)throw new Error('ZIP uncompressed limit exceeded');
    const bytes=buffer.subarray(dataOffset,dataOffset+packed),value=method===8?inflateRawSync(bytes,{maxOutputLength:64*1024*1024}):bytes;
    if(value.length!==length||crc32(value)!==crc)throw new Error('ZIP checksum mismatch: '+name);
    entries.set(name,value);pos+=46+names+extra+comment;
  }
  if(pos!==end)throw new Error('ZIP directory count mismatch');return entries;
}
