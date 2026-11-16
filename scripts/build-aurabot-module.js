import { readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,realpathSync,lstatSync,unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,join,relative,sep,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { zipFiles } from './lib/zip.js';
import {STORAGE_SCHEMA_VERSION} from '../core/v5-store.js';

const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'adapters/aurabot/module');
const manifest=JSON.parse(readFileSync(join(source,'module.json'),'utf8')),files=new Map();
if(manifest.id!=='thinkstar-memory'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))throw new Error('Invalid module identity or version');
const includeResources=!process.argv.includes('--code-only');
const resourceManifest=JSON.parse(readFileSync(join(root,'release/resources.json'),'utf8'));
if(includeResources&&!existsSync(join(root,'apps/memory-sea/assets',resourceManifest.file)))throw new Error('Model resource missing; use --code-only for a source checkout');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
function textBytes(path,bytes){return /\.(?:js|mjs|json|md|css|html|svg)$/.test(path)||path.endsWith('LICENSE')?Buffer.from(bytes.toString('utf8').replace(/\r\n?/g,'\n')):bytes;}
function add(path,destination='engine/'+path){files.set(destination,textBytes(path,readFileSync(join(root,path))));}
function tree(path,accept=()=>true){
  for(const entry of readdirSync(join(root,path),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const name=path+'/'+entry.name;if(entry.isSymbolicLink())throw new Error('Source symlink is not allowed: '+name);
    if(entry.isDirectory())tree(name,accept);else if(accept(name))add(name);
  }
}
for(const name of ['module.json','panel.js','README.md','LICENSE','THIRD-PARTY-NOTICES.md'])files.set(name,textBytes(name,readFileSync(join(source,name))));
files.set('index.mjs',Buffer.from("export { default } from './engine/adapters/aurabot/module/index.mjs';\n"));
files.set('package.json',Buffer.from(JSON.stringify({name:manifest.id,version:manifest.version,private:true,type:'module',engines:{node:'>=22.13.0'}},null,2)));
add('adapters/aurabot/module/module.json');
tree('adapters/aurabot/module',path=>path.endsWith('.mjs')||(path.endsWith('.js')&&!path.endsWith('/panel.js')));
tree('core',path=>/\/v5-[^/]+\.js$/.test(path));
add('shared/v5-memory-layout.js');add('server/memory-sea-handler.js');
for(const name of ['index.html','styles.css','favicon.svg'])add('apps/memory-sea/'+name);
tree('apps/memory-sea/src',path=>path.endsWith('.js'));
tree('apps/memory-sea/vendor/three',path=>path.endsWith('.js')||path.endsWith('/LICENSE')||path.endsWith('/provenance.json'));
for(const name of ['milky-way-background.jpg','milky-way-background.json'])add('apps/memory-sea/assets/'+name);
const entries=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,data])=>({path,bytes:data.length,sha256:hash(data)}));
const build={schema:1,id:manifest.id,version:manifest.version,core_schema:STORAGE_SCHEMA_VERSION,files:entries,contains_private_data:false,resource_file:'assets/blue-maid-starry.glb',resource_location:'modules-data/thinkstar-memory/assets'};
files.set('thinkstar-build.json',Buffer.from(JSON.stringify(build,null,2)));
const bundle=zipFiles(files);
if(bundle.length>25*1024*1024)throw new Error('Module ZIP exceeds the audited Aurabot 25 MB limit');
if([...files.values()].reduce((sum,b)=>sum+b.length,0)>64*1024*1024)throw new Error('Module uncompressed size exceeds the audited 64 MB limit');
const out=join(root,'dist/aurabot');mkdirSync(out,{recursive:true});
if(!realpathSync(out).startsWith(realpathSync(root)+sep))throw new Error('Build output left workspace');
const folder=join(out,manifest.id);mkdirSync(folder,{recursive:true});
if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==resolve(folder))throw new Error('Unsafe generated module directory');
const previousMarker=join(folder,'thinkstar-build.json');
if(existsSync(previousMarker)){
  const previous=JSON.parse(readFileSync(previousMarker,'utf8'));
  if(previous.id!==manifest.id)throw new Error('Generated directory belongs to another package');
  for(const item of previous.files){
    const target=resolve(folder,item.path);if(!target.startsWith(folder+sep))throw new Error('Invalid previous build path');
    if(!existsSync(target))continue;
    if(lstatSync(target).isSymbolicLink()||!realpathSync(target).startsWith(folder+sep))throw new Error('Unsafe previous build file');
    if(hash(readFileSync(target))!==item.sha256)throw new Error('Generated file was edited; preserve it before rebuilding: '+item.path);
    if(!files.has(item.path))unlinkSync(target);
  }
}
for(const [name,data] of files){const target=resolve(folder,name);if(!target.startsWith(folder+sep))throw new Error('Build path escape');mkdirSync(dirname(target),{recursive:true});if(!realpathSync(dirname(target)).startsWith(folder+sep)&&realpathSync(dirname(target))!==folder)throw new Error('Generated directory escaped output');if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('Refusing generated-file symlink');writeFileSync(target,data);}
const coreName=`${manifest.id}-${manifest.version}.zip`;writeFileSync(join(out,coreName),bundle);
let resourceInfo=null;
if(includeResources){
  const assets=new Map();
  for(const name of ['blue-maid-starry.glb','blue-maid-starry.json'])assets.set('assets/'+name,readFileSync(join(root,'apps/memory-sea/assets',name)));
  if(hash(assets.get('assets/blue-maid-starry.glb'))!==resourceManifest.sha256)throw new Error('Model changed: update release/resources.json and its resource version');
  assets.set('README.txt',Buffer.from('Private user-supplied model. Copy assets/ to plugins-data/aurabot/modules-data/thinkstar-memory/assets/. Do not place it inside the watched module source directory. Core and data remain separate.\n'));
  const resource=zipFiles(assets),assetName=`thinkstar-memory-assets-${resourceManifest.version}.zip`;writeFileSync(join(out,assetName),resource);
  resourceInfo={name:assetName,bytes:resource.length,sha256:hash(resource)};
}
const release={...build,core_zip:{name:coreName,bytes:bundle.length,sha256:hash(bundle)},resources_zip:resourceInfo,resource_version:resourceManifest.version,model_sha256:resourceManifest.sha256,generated_module:relative(root,folder).split(sep).join('/')};
const releaseBytes=Buffer.from(JSON.stringify(release,null,2)+'\n');writeFileSync(join(out,'release.json'),releaseBytes);
const checksums=[release.core_zip,...(resourceInfo?[resourceInfo]:[]),{name:'release.json',sha256:hash(releaseBytes)}].map(item=>`${item.sha256}  ${item.name}`).join('\n')+'\n';writeFileSync(join(out,'SHA256SUMS.txt'),checksums);
console.log(JSON.stringify({module:folder,core_zip:join(out,coreName),core_bytes:bundle.length,resources_zip:resourceInfo?join(out,resourceInfo.name):null,resource_bytes:resourceInfo?.bytes??0,private_data_included:false},null,2));
