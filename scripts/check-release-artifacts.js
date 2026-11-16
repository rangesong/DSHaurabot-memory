import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join,dirname,posix } from 'node:path';
import { createHash } from 'node:crypto';
import { readZipEntries } from './lib/zip.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'dist/aurabot'),release=JSON.parse(readFileSync(join(out,'release.json'),'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
function archive(item){const buffer=readFileSync(join(out,item.name));if(buffer.length!==item.bytes||hash(buffer)!==item.sha256)throw new Error('Archive hash mismatch');return readZipEntries(buffer);}
const files=archive(release.core_zip),manifest=JSON.parse(files.get('module.json'));
if(manifest.id!==release.id||manifest.version!==release.version||release.core_zip.bytes>25*1024*1024)throw new Error('Module identity or size mismatch');
for(const name of files.keys())if(/(^|\/)(?:runtime-data|node_modules|\.work|chatlog)(?:\/|$)|\.sqlite|\.glb$|(^|\/)\.env/.test(name))throw new Error('Private data path in code archive: '+name);
for(const item of release.files)if(!files.has(item.path)||hash(files.get(item.path))!==item.sha256)throw new Error('Manifest mismatch: '+item.path);
for(const [name,data] of files)if(/\.(?:js|mjs)$/.test(name))for(const m of data.toString('utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s*from\s*)?['"](\.{1,2}\/[^'"\n]+)['"]/g))if(!files.has(posix.normalize(posix.join(posix.dirname(name),m[1]))))throw new Error('Missing packaged import: '+name+' -> '+m[1]);
if(release.resources_zip){const assets=archive(release.resources_zip);if(hash(assets.get('assets/blue-maid-starry.glb'))!==release.model_sha256)throw new Error('Model resource hash mismatch');}
for(const line of readFileSync(join(out,'SHA256SUMS.txt'),'utf8').trim().split('\n')){const match=/^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);if(!match||hash(readFileSync(join(out,match[2])))!==match[1])throw new Error('Release checksum mismatch');}
console.log(`Artifact checks passed: ${files.size} code-package files; resources ${release.resources_zip?'verified':'not included'}. No module code was executed.`);
