import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),folder=join(root,'dist/aurabot'),release=JSON.parse(readFileSync(join(folder,'release.json'),'utf8'));
const tag='v'+release.version,files=[release.core_zip.name,'release.json','SHA256SUMS.txt'];
if(!process.argv.includes('--execute')){console.log(JSON.stringify({mode:'dry-run',tag,draft:true,files,model_resource_upload:false},null,2));process.exit(0);}
const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??'')||!token||process.env.GITHUB_REF_TYPE!=='tag'||process.env.GITHUB_REF_NAME!==tag)throw new Error('A matching GitHub tag workflow and repository-scoped token are required');
const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'};
async function request(path,options={}){const response=await fetch('https://api.github.com/repos/'+repository+path,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('GitHub Release request failed: HTTP '+response.status);return response.json();}
const existing=await request('/releases?per_page=100');let draft=existing.find(item=>item.tag_name===tag);
if(draft&&!draft.draft)throw new Error('This version is already published; create a new version instead of replacing it');
if(!draft)draft=await request('/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:tag,name:'Thinkstar '+release.version,draft:true,prerelease:true,body:'Aurabot 原生用户模块。代码包、发布清单与 SHA-256 已附。\n\n角色模型是单独资源，不由此工作流上传。模块真实宿主验收和自动化检查分别记录；发布前请核对本版本的宿主验收状态。'})});
const assets=await request(`/releases/${draft.id}/assets?per_page=100`);
for(const name of files){
  const bytes=readFileSync(join(folder,name)),digest='sha256:'+createHash('sha256').update(bytes).digest('hex'),previous=assets.find(item=>item.name===name);
  if(previous){if(previous.digest===digest)continue;throw new Error('Draft contains a different or unverifiable asset; review it before retrying: '+name);}
  const url=new URL(draft.upload_url.split('{')[0]);if(url.protocol!=='https:'||url.hostname!=='uploads.github.com')throw new Error('Unexpected upload host');url.searchParams.set('name',name);
  const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':name.endsWith('.zip')?'application/zip':name.endsWith('.json')?'application/json':'text/plain'},body:bytes,signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('Release asset upload failed: HTTP '+response.status);
}
console.log('Prepared unpublished Release draft: '+draft.html_url);
