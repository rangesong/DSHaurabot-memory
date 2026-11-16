import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

function userKey(){if(process.env.DEEPSEEK_API_KEY)return process.env.DEEPSEEK_API_KEY.trim();if(process.platform!=='win32')return '';const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"[Console]::Write([Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User'))"],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384});return r.status===0?r.stdout.trim():'';}
export class DeepSeekClient{
  constructor({model='deepseek-flash',baseURL='https://api.deepseek.com',fetchImpl=fetch,keyProvider=userKey}={}){this.model=model;this.baseURL=baseURL.replace(/\/$/,'');this.fetch=fetchImpl;this.keyProvider=keyProvider;this.cachedKey=null;this.keyChecked=0;}
  key(refresh=false){if(refresh||Date.now()-this.keyChecked>15000||this.cachedKey===null){this.cachedKey=this.keyProvider();this.keyChecked=Date.now();}return this.cachedKey;}
  status(refresh=false){return {provider:'DeepSeek',base_url:this.baseURL,model:this.model,configured:Boolean(this.key(refresh)),verified:Boolean(this.lastSuccess),last_success:this.lastSuccess??null,key_location:'DEEPSEEK_API_KEY / 当前 Windows 用户环境变量',data_policy:'仅发送当前选定记忆及必要上下文；不发送整个库',remote_send_to_aurabot:false};}
  async json(system,payload,{maxTokens=4000,temperature=.2}={}){const key=this.key();if(!key)throw Object.assign(new Error('本机尚未配置 DEEPSEEK_API_KEY，请双击“配置模型密钥.cmd”后重新检查。'),{code:'MODEL_NOT_CONFIGURED'});const start=performance.now();let response;
    try{response=await this.fetch(this.baseURL+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.model,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}],response_format:{type:'json_object'},reasoning_effort:'none',temperature,max_tokens:maxTokens,stream:false}),signal:AbortSignal.timeout(90000)});}catch(error){throw Object.assign(new Error(error.name==='TimeoutError'?'DeepSeek 请求超时，原文与检查点保留。':'DeepSeek 网络连接失败，原文保留；请检查网络后重试。'),{code:'MODEL_NETWORK_ERROR'});}
    if(!response.ok){const code=response.status;throw Object.assign(new Error(`DeepSeek 返回 HTTP ${code}。${code===401?'请检查本机密钥。':code===402?'请检查账户额度。':code===429?'请求受限，请稍后重试。':'未提交本次模型输出。'}`),{code:'MODEL_HTTP_ERROR',http_status:code});}
    const result=await response.json(),choice=result.choices?.[0];if(!choice?.message||choice.finish_reason==='length')throw Object.assign(new Error('模型返回为空或被截断，本次语义结果未提交。'),{code:'MODEL_INCOMPLETE'});
    let value;try{value=JSON.parse(choice.message.content);}catch{throw Object.assign(new Error('模型 JSON 无效，本次输出未提交。'),{code:'MODEL_INVALID_JSON'});}if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('模型没有返回所需对象。'),{code:'MODEL_INVALID_JSON'});
    this.lastSuccess=Date.now();return {value,model:result.model??this.model,request_id:result.id??null,duration_ms:performance.now()-start,usage:{prompt_tokens:Number(result.usage?.prompt_tokens??0),completion_tokens:Number(result.usage?.completion_tokens??0),total_tokens:Number(result.usage?.total_tokens??0)}};
  }
}
