import manifest from './module.json' with {type:'json'};
import { startThinkstar } from './lib/host-bridge.js';

export default {
  id:manifest.id,name:manifest.name,version:manifest.version,api:manifest.api,
  description:'独立底座、分层巩固、同人格同聊天召回与三维星图',
  panel:'panel.js',
  defaults:{masterEnabled:true,nightReflectionEnabled:false,mode:'active',captureGroups:false,captureOtherPrivate:false,contextTokens:1536,allowHostModel:false,mirrorBuiltin:true},
  settings:[],
  // The custom panel edits these same host settings inside a collapsed section.
  settingDefinitions:[
    {key:'mirrorBuiltin',label:'同步内置记忆公开接口的成功写入',type:'switch',hint:'保持内置接口返回值；有明确聊天和人物的记录同步进独立底座，删除与停记同步清理。未覆盖的高级接口仍通过 builtin 委托原模块。'},
    {key:'mode',label:'运行方式',type:'select',options:[{value:'active',label:'参与记忆与上下文'},{value:'observe',label:'只积累和查看，不注入上下文'}]},
    {key:'captureGroups',label:'记录宿主允许的群聊',type:'switch',hint:'默认只记录主人私聊；群聊始终独立保存。非主人内容需要内置记忆的停记检查可用。'},
    {key:'captureOtherPrivate',label:'记录宿主允许的其他私聊',type:'switch'},
    {key:'contextTokens',label:'每轮记忆上下文上限',type:'number',min:256,max:8192,step:256,hint:'建议3072；普通聊天最多2048，明确回忆或查询最多3072，均受本上限约束。固定资料、标签和日期也占额度。已验证压缩路线参考同会话成功请求用量，不以原始历史大小直接清零；最终出站保护不变。未带入的原话仍在底座。'},
    {key:'allowHostModel',label:'允许使用 DSH 模型',type:'switch',hint:'面板明确操作、启用的按需重排和共用每日配额的后台反馈复核会调用宿主模型；不读取或复制模型密钥。'},
  ],
  async setup(api){return startThinkstar(api);},
};
