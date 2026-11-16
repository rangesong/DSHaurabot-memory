import { performance } from 'node:perf_hooks';

/** Uses the host's configured provider; no environment credentials, subprocess or outbound transport. */
export class HostModelClient {
  constructor(api,{active,enabled}){this.api=api;this.active=active;this.enabled=enabled;this.abort=new AbortController();}
  get model(){const model=this.api.config?.().model??{};return 'DSH:'+(model.provider||'default')+'/'+(model.model||'default')+'/'+(model.reasoningEffort||'default');}
  status(){return {provider:'DSH',model:this.model,base_url:'Aurabot api.ask / 由宿主选择模型',configured:this.active()&&this.enabled(),verified:!!this.lastSuccess,last_success:this.lastSuccess??null,key_location:'由 DSH 管理，Thinkstar 不读取密钥',data_policy:'面板明确操作、启用的按需重排及共用每日额度的后台反馈复核；遵守来源范围',usage_known:false,remote_send_to_aurabot:false};}
  stop(){this.abort.abort();}
  async json(system,payload,{maxTokens=4000}={}){
    if(!this.active()||!this.enabled())throw Object.assign(new Error('请先在 Thinkstar 模块设置中允许调用 DSH 模型。'),{code:'MODEL_NOT_CONFIGURED'});
    const start=performance.now();let timer,onAbort;
    const cancelled=new Promise((_,reject)=>{
      onAbort=()=>reject(Object.assign(new Error('模块已停止，本次模型结果不提交。'),{code:'MODEL_CANCELLED'}));
      this.abort.signal.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>reject(Object.assign(new Error('宿主模型调用超时，本次结果不提交。'),{code:'MODEL_TIMEOUT'})),90000);timer.unref?.();
    });
    try{
      const answer=await Promise.race([Promise.resolve().then(()=>{if(!this.active()||this.abort.signal.aborted)throw Object.assign(new Error('模块已停止。'),{code:'MODEL_CANCELLED'});return this.api.ask({system,text:JSON.stringify(payload),maxTokens});}),cancelled]);
      if(!this.active()||!this.enabled())throw Object.assign(new Error('模块状态已变化，本次结果不提交。'),{code:'MODEL_CANCELLED'});
      if(typeof answer!=='string')throw Object.assign(new Error('宿主没有返回文字，本次结果不提交。'),{code:'MODEL_INVALID_JSON'});
      let value;try{value=JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Object.assign(new Error('宿主模型返回的 JSON 无效，本次结果不提交。'),{code:'MODEL_INVALID_JSON'});}
      if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('模型未返回所需对象。'),{code:'MODEL_INVALID_JSON'});
      this.lastSuccess=Date.now();
      return {value,request_inclusion:'submitted_to_host_model_api_provider_request_unknown',model:this.model,request_id:null,duration_ms:performance.now()-start,usage:{prompt_tokens:null,completion_tokens:null,total_tokens:null,known:false}};
    }finally{clearTimeout(timer);this.abort.signal.removeEventListener('abort',onAbort);}
  }
}
