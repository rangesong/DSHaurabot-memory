import {spawnSync} from 'node:child_process';

export function githubCredential(repository){
  if(process.env.GITHUB_TOKEN)return process.env.GITHUB_TOKEN;
  const result=spawnSync('git',['credential','fill'],{input:`protocol=https\nhost=github.com\npath=${repository}.git\n\n`,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
  if(result.status!==0)throw Error('GitHub登录凭据不可用；请先用Git完成登录，旧代码仍保留。');
  const token=result.stdout.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
  if(!token)throw Error('GitHub登录未提供可用凭据；旧代码仍保留。');return token;
}

export class GitHubClient{
  constructor(repository,{token,fetcher=fetch}={}){if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw Error('Invalid repository');this.repository=repository;this.token=token;this.fetcher=fetcher;}
  async request(endpoint,{method='GET',body,allow404=false,bytes=false,contentType}={}){
    if((endpoint!==''&&!endpoint.startsWith('/'))||endpoint.startsWith('//'))throw Error('Invalid GitHub endpoint');
    const response=await this.fetcher('https://api.github.com/repos/'+this.repository+endpoint,{method,headers:{Accept:bytes?'application/octet-stream':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(this.token?{Authorization:'Bearer '+this.token}:{}),...(body!==undefined?{'Content-Type':contentType??'application/json'}:{})},...(body!==undefined?{body:contentType?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    if(allow404&&response.status===404)return null;
    if(!response.ok)throw Error('GitHub操作未完成：HTTP '+response.status+'（'+method+' '+endpoint.split('?')[0]+'）');
    return bytes?Buffer.from(await response.arrayBuffer()):response.status===204?null:response.json();
  }
  async info(){const r=await this.request('');return {repository:r.full_name,private:r.private,push:r.permissions?.push,default_branch:r.default_branch};}
  async release(tag,{create=false}={}){
    let release=await this.request('/releases/tags/'+encodeURIComponent(tag),{allow404:true});
    if(!release&&create){for(let page=1;;page++){const rows=await this.request(`/releases?per_page=100&page=${page}`);release=rows.find(row=>row.tag_name===tag);if(release||rows.length<100)break;}}
    if(!release&&create){const repo=await this.info();release=await this.request('/releases',{method:'POST',body:{tag_name:tag,target_commitish:repo.default_branch,name:'Thinkstar 历史程序备份 · '+tag.replace(/^code-backups-v/,''),draft:true,prerelease:true,make_latest:'false',body:'只包含经过清单核对的旧版程序代码，不包含记忆数据库、聊天、密钥或私人模型。\n\n每个ZIP及同名恢复清单对应一份精确的安装目录快照；同一版本可有不同内容快照。备份标签用于组织附件，标签处源码不代表旧快照源码，请使用附件恢复。\n\n恢复命令只导出程序到新目录，不覆盖正在运行的插件或记忆库。旧版程序可能不兼容现用数据库结构，请勿直接让旧版打开正式记忆库。'}});}
    return release;
  }
  async assets(release){const rows=[];for(let page=1;;page++){const items=await this.request(`/releases/${release.id}/assets?per_page=100&page=${page}`);rows.push(...items);if(items.length<100)return rows;}}
  async upload(release,name,bytes,contentType='application/zip'){
    if(!this.token)throw Error('GitHub写入需要登录');
    const url=new URL(release.upload_url.split('{')[0]);
    if(url.protocol!=='https:'||url.hostname!=='uploads.github.com'||url.pathname!==`/repos/${this.repository}/releases/${release.id}/assets`)throw Error('Unexpected upload endpoint');url.searchParams.set('name',name);
    const response=await this.fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+this.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','Content-Type':contentType},body:bytes,signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('GitHub附件上传未完成：HTTP '+response.status);return response.json();
  }
  async publish(release){return release.draft?this.request('/releases/'+release.id,{method:'PATCH',body:{draft:false,prerelease:true,make_latest:'false'}}):release;}
  async download(asset,{publicOnly=false}={}){
    if(!publicOnly)return this.request('/releases/assets/'+asset.id,{bytes:true});
    const url=new URL(asset.browser_download_url);if(url.protocol!=='https:'||url.hostname!=='github.com'||!url.pathname.startsWith('/'+this.repository+'/releases/download/'))throw Error('Unexpected public asset URL');
    for(let attempt=0;attempt<4;attempt++){const response=await this.fetcher(url,{redirect:'follow',cache:'no-store',signal:AbortSignal.timeout(90000)});if(response.ok)return Buffer.from(await response.arrayBuffer());if(attempt===3)throw Error('公开下载验证失败：HTTP '+response.status);await new Promise(r=>setTimeout(r,1000));}
  }
}
