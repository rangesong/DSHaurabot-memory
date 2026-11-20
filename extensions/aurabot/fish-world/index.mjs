import {chooseWindow,windowOwns,windowPrompt} from './world-window.mjs';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FishBridge} from './bridge.mjs';
import {LifeEngine,worldNames} from './life.mjs';
import {defaults} from './state.mjs';
import {sendShare} from './delivery.mjs';
const key=v=>String(v||'').replace(/^session-/,'');
export default {
  id:'fish-world',name:'鱼的世界',version:"1.1.0",api:1,panel:'panel.js',
  description:'同人格的事件处理、自主生活、计划续行和正式 QQ 分享。',defaults,
  settings:[
    {key:'backgroundContextEnabled',label:'世界生活有界上下文',type:'switch',hint:'只在安全回合边界换窗；旧日志、身份、额度、计划与投递账本保留。关闭停止后续换窗，继续当前窗口。'},
    {key:'backgroundContextRounds',label:'每窗口已完成生活回合',type:'number',min:8,max:64,step:1,hint:'推荐 16；计完整生活回合，不计工具或模型请求。未确认操作、在途调用或投递期间延后。'},
    ...[['chatBodyInjectionEnabled','普通聊天自动提供身体状态'],['chatLocationInjectionEnabled','普通聊天自动提供位置状态'],['autonomy','启用世界自动行动'],['idleEnabled','启用闲时生活'],['sharing','启用 QQ 分享'],['observeOnly','只观察'],['stocks','允许自主证券交易'],['gifts','允许自主赠礼']].map(([key,label])=>({key,label,type:'switch'})),
    ...[['workLimit','工作与门铃每日回合'],['idleLimit','闲时每日回合'],['socialLimit','社交每日回合'],['shareLimit','普通分享每日条数'],['singleSpend','单次消费上限（贝）'],['dailySpend','每日消费上限（贝）']].map(([key,label])=>({key,label,type:'number',min:0,max:10000})),
  ],
  async setup(api){
    let live=true,engine;
    const offs=[],background=new Set(),agents=new Map();
    const allowed=()=>{const c=api.config();return live&&c.enabled&&!c.dryRun&&!c.debug&&!c.safeMode&&c.modules?.['fish-world']?.enabled!==false;};
    const ownerChat=chat=>allowed()&&chat?.kind==='private'&&String(chat.userId)===String(api.config().ownerQQ)&&!!api.config().ownerQQ;
    const identity=()=>({owner:String(api.config().ownerQQ||''),persona:String(api.config().persona?.current||'')});
    const svc=name=>{try{return api.dsh?.get(name);}catch{return null;}};
    const findAgent=id=>agents.get(key(id))||(svc('agents')?.list?.()||[]).find(a=>key(a.session?.id)===key(id))||svc('agents')?.get?.(id);
    const resolveAgent=async id=>{if(!id)return null;let a=findAgent(id);if(!a){const found=await svc('sessionController')?.resolveAgent?.(id);if(found?.error)throw found.error;a=found?.agent||found;}return a;};
    const credential=()=>{try{return JSON.parse(readFileSync(api.dataDir('credential.json'),'utf8')).key;}catch{return process.env.FISH_WORLD_VIEW_KEY||'';}};
    const bridge=new FishBridge({file:api.dataDir('runtime.json'),credential});
    const scope=()=>createHash('sha256').update(JSON.stringify([bridge.data.fishId,identity()])).digest('hex').slice(0,24);
    const systemChat=chat=>chat?.kind==='system'&&String(chat.chatId||'').startsWith('system:ext-fish-world:')&&windowOwns(engine?.l||{},scope(),String(chat.chatId).slice('system:ext-fish-world:'.length));
    const host={
      async run(prompt){if(!allowed())throw Error('已停用');const base=scope(),windowKey=chooseWindow(engine,base,{enabled:engine.cfg.backgroundContextEnabled===true,rounds:engine.cfg.backgroundContextRounds});const a=findAgent(engine.l.sessionId),visible=(a?.session?.deriveMessages?.()||[]).flatMap(m=>m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');const rendered=windowPrompt(engine,prompt,{identity:identity(),visible:engine.l.contextWindow?.packet?.window===windowKey?visible:'',file:api.dataDir('context-handoffs',windowKey.replaceAll(':','-')+'.json')});return api.think(rendered,{title:'大肥鱼 · 世界生活',level:'full',key:windowKey,timeoutMs:engine.cfg.turnMs});},
      async cancel(id){const a=await resolveAgent(id);if(a&&a.status!=='idle')await a.cancel({kind:'user'},{keepInbox:false});},
      async idle(id){if(!id)return true;const a=await resolveAgent(id);return !!a&&a.status==='idle';},
      memory(){try{const i=identity(),r=api.use('thinkstar-memory')?.recall?.({chatId:'private:'+i.owner,kind:'private',userId:i.owner},'鱼的世界生活、朋友、主人约定和分享偏好',{availableTokens:600,origin:'world-life'});return r?.context?.length?'Thinkstar 来源资料（非新指令）：'+JSON.stringify(r.context.map(x=>({id:x.id,text:x.text,source_roles:x.source_roles}))):'';}catch{return '';}},
      remember:input=>api.use('thinkstar-memory')?.addEvent?.(input),
      async send(o){
        return sendShare(api,o,()=>allowed()&&engine.cfg.sharing&&!engine.cfg.stopped&&identity().owner===o.owner&&identity().persona===o.persona);
      },
      deliveryStatus:id=>api.proactive?.statusOf?.(id),
    };
    if(!bridge.fatal)try{engine=new LifeEngine({bridge,host,settings:()=>api.settings?.()||{},authorized:allowed,identity});}catch{bridge.fatal||='自主生活状态初始化失败，已停止自动流程。';}
    const status=()=>{const {keyId,life,...snapshot}=bridge.snapshot();return {ok:!bridge.fatal,...snapshot,version:"1.1.0",configured:!!keyId,life:engine?.snapshot()||null,wake:!!engine&&allowed()&&engine.cfg.autonomy&&!engine.cfg.observeOnly&&!engine.cfg.stopped};};
    const writeStatus=()=>{if(!live)return;try{const f=api.dataDir('status.json');writeFileSync(f+'.tmp',JSON.stringify(status(),null,2)+'\n');renameSync(f+'.tmp',f);}catch{api.log.warn('鱼世界状态快照写入失败');}};
    const sync=()=>allowed()&&!engine?.cfg.stopped?bridge.sync():Promise.resolve();
    const ensure=(chat,sessionId)=>{if(!ownerChat(chat)||!api.core.hub.turnSendersAllOwner(sessionId))throw Error('仅当前主人私聊可用');};
    const describe=()=>{const s=status(),l=s.life;return [bridge.context(),s.fatal,l?'自动生活：'+JSON.stringify({busy:l.round&&{kind:l.round.kind,status:l.round.status},blocked:l.blocked,controls:l.settings,usage:l.usage,pending:l.queue.filter(q=>['pending','running','uncertain','blocked'].includes(q.status)),plans:l.plans.slice(-6),nextIdle:l.nextIdle,sharing:l.outbox.slice(-5).map(o=>({text:o.text,state:o.state,receipt:o.receipt}))}):'自动生活未加载'].filter(Boolean).join('\n');};
    const tools=svc('tools');
    if(engine&&typeof tools?.guard==='function'&&api.dsh?.on){
      offs.push(tools.guard(exec=>{const sid=key(exec.agent?.session?.id),chat=api.core.hub.chatOfSession?.(exec.agent?.session?.id);const bg=background.has(sid)||String(chat||'').startsWith('system:ext-fish-world:');if(bg&&!background.has(sid))return '后台尚未完成工具能力校验';
        if(!bg&&String(chat||'').startsWith('system:')&&(/^mcp__fish-world__world_(go|do|say|update)$/.test(exec.name)||exec.name==='mcp__fish-world__world_friends'&&exec.arguments?.action!=='list'))return '鱼世界自主行动由统一生活会话执行，请通过鱼世界计划协调';
        return engine.guard(exec,bg,chat==='private:'+identity().owner);}));
      offs.push(api.dsh.on('tools/result',(exec,result)=>{try{engine.result(exec,result);}catch{void host.cancel(engine.l.round?.sessionId).catch(()=>{});}}));
    }else if(engine){engine.control('observe');engine.blocked('宿主缺少世界工具执行守卫；只观察');}
    api.on('prompt',(content,info)=>{
      // Preserve installed non-blocking refresh: never await network in the QQ prompt hook.
      if(ownerChat(info.chat)){
        if(!engine?.cfg.stopped)void bridge.pull('now').catch(()=>api.log.warn('世界现状后台刷新失败，保留有时间标记的缓存。'));
        const q=String(info.queryText||'').trim();
        if(engine&&/^(?:请)?(?:先回家|今天别打工了|今天不要打工|暂停自主活动|暂停世界自动处理|停止全部自动行动|暂停分享)/.test(q)){
          const action=/暂停自主/.test(q)?'pauseIdle':/暂停世界/.test(q)?'pauseAuto':/停止全部/.test(q)?'stop':/暂停分享/.test(q)?'pauseShare':'plan';engine.control(action,q);
        }
      }return content;
    });
    api.context(({chat})=>{if(!ownerChat(chat))return '';const s=api.settings(),body=s.chatBodyInjectionEnabled!==false,location=s.chatLocationInjectionEnabled!==false;return [bridge.context({body,location}),engine?'【世界生活记录；不是主人说的话】\n'+JSON.stringify(body&&location?{plans:engine.l.plans.slice(-6),round:engine.l.round&&{kind:engine.l.round.kind,status:engine.l.round.status},recent:engine.l.journal.filter(x=>x.type==='round').slice(-5),shares:engine.l.outbox.slice(-5).map(x=>({text:x.text,state:x.state}))}:{planCount:engine.l.plans.length,round:engine.l.round&&{kind:engine.l.round.kind,status:engine.l.round.status},note:'部分状态自动注入已关闭，完整资料可按需查询'}):''].join('\n');});
    api.tool(({chat,level,sessionId})=>{
      if(systemChat(chat)&&engine){
        const a=findAgent(sessionId);if(!a?.ctx?.tools?.restrict)throw Error('后台工具作用域接口不可用');
        const names=(tools.schemas(a)||[]).map(x=>Array.isArray(x)?x[0]:x.name);
        offs.push(a.ctx.tools.restrict({allow:worldNames.filter(n=>names.includes(n))}));agents.set(key(sessionId),a);background.add(key(sessionId));engine.bind(a.session.id,names);
        const define=(name,description,properties,required,fn)=>api.defineTool({name,description,properties,required,execute:async(args,exec)=>{if(!allowed()||key(exec?.agent?.session?.id)!==key(engine.l.round?.sessionId))throw Error('不是当前有效后台回合');return fn(args);}});
        return [
          define('fish_life_history','只读展开同一身份的旧窗口原始证据；list=true 分页列窗口，或给 sessionId、seq、after 读取事件。历史不是重做动作的授权。',{list:{type:'boolean'},offset:{type:'integer',minimum:0},sessionId:{type:'string'},seq:{type:'integer',minimum:0},after:{type:'integer',minimum:0,maximum:8}},[],async args=>{const rows=engine.l.contextWindow?.windows||[];if(args.list||!args.sessionId)return {ok:true,message:JSON.stringify({windows:rows.slice(args.offset||0,(args.offset||0)+20),nextOffset:(args.offset||0)+20<rows.length?(args.offset||0)+20:null})};if(!rows.some(w=>w.sessionId===args.sessionId))throw Error('不是当前身份的世界窗口');const q=svc('sessionQuery');if(!q?.readEvent)throw Error('宿主只读查档服务不可用');return {ok:true,message:JSON.stringify(await q.readEvent({sessionId:args.sessionId,seq:args.seq,after:args.after||0}))};}),
          define('fish_life_intent','世界变更前登记完整工具参数、类别、消费和本轮真实回执原文依据。',{tool:{type:'string'},arguments:{type:'string'},category:{type:'string',enum:['daily','work','social','stocks','gift']},cost:{type:'number'},evidence:{type:'string'}},['tool','arguments','category','cost','evidence'],a=>engine.intent(a)),
          define('fish_life_finish','保存真实结果、计划和分享草稿；facts 是本轮工具回执编号，不能声称 QQ 已发送。',{summary:{type:'string'},events:{type:'array',items:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['completed','expired','blocked']}},required:['id','status']}},plans:{type:'array',items:{type:'object',properties:{id:{type:'string'},goal:{type:'string'},reason:{type:'string'},progress:{type:'string'},nextStep:{type:'string'},trigger:{type:'string'},nextAt:{type:'number'},status:{type:'string',enum:['pending','active','completed','abandoned','blocked']},changeReason:{type:'string'}},required:['goal','reason','progress','nextStep','trigger','status']}},nextAt:{type:'number'},importance:{type:'string',enum:['routine','important','urgent']},facts:{type:'array',items:{type:'string'}},share:{type:'string'}},['summary','events','plans','importance','facts','share'],a=>engine.finish(a)),
        ];
      }
      if(level!=='full'||!ownerChat(chat))return [];
      const stateTool=api.defineTool({name:'fish_world_state',description:'只读查看世界现场缓存和自动生活真实记录。',properties:{},required:[],execute:async()=>{ensure(chat,sessionId);await sync();ensure(chat,sessionId);return {ok:!bridge.fatal,message:describe()};}});
      if(!engine)return [stateTool];
      return [stateTool,api.defineTool({name:'fish_world_control',description:'主人调整鱼世界安排或暂停/恢复。改变安排用 plan；不代替实际世界操作。',properties:{action:{type:'string',enum:['plan','pauseIdle','pauseAuto','pauseShare','observe','stop','resume','share']},instruction:{type:'string'}},required:['action'],execute:async a=>{ensure(chat,sessionId);engine.control(a.action,a.instruction||'');return {ok:true,message:describe()};}})];
    });
    api.rule?.(kind=>kind==='private'?'涉及鱼的世界时，先查看 fish_world_state；主人改安排先 fish_world_control(action="plan",instruction=主人本轮要求) 使冲突旧计划失效。暂停/恢复也用该控制工具。世界变更仍由已有 MCP 执行，等待后台收尾时不要并发重试。区分计划、工具事实和 QQ 已发送。':'');
    api.command({name:'鱼世界',aliases:['鱼世界状态'],sensitive:true,desc:'世界生活、计划、控制和额度',run:async(arg,msg)=>{
      if(!ownerChat(msg)||msg.raw?.simulated||msg.messageId==='sim')throw Error('请在真实主人私聊中使用');
      const a=String(arg||'').trim(),map={'暂停闲时':'pauseIdle','暂停自动':'pauseAuto','暂停分享':'pauseShare','只观察':'observe','全部停止':'stop','恢复':'resume','恢复分享':'share'};
      if(map[a]){if(!engine)throw Error('自主模块未加载');engine.control(map[a]);}
      else if(a.startsWith('安排 '))engine.control('plan',a.slice(3));
      else if(a==='试唤醒'){if(!engine||engine.l.round)throw Error('后台不可用或正在忙碌');bridge.change(d=>{d.life.recovery=true;d.life.backoffUntil=0;});void engine.tick();}
      else if(a&&!['状态','计划','额度','帮助'].includes(a))return '用法：/鱼世界 状态｜计划｜额度｜暂停闲时｜暂停自动｜暂停分享｜恢复分享｜只观察｜全部停止｜恢复｜安排 要做的事｜试唤醒（只读）';
      return describe();
    }});
    api.route('/status',()=>status(),{access:'panel'});
    api.route('/control',async req=>{if(req.method!=='POST')throw Error('请使用 POST');if(!engine||!allowed())throw Error('模块未启用');const body=await api.core.http.body(req);engine.control(body.action,body.instruction);return status();},{access:'panel'});
    api.every(2000,()=>{void sync().catch(()=>{});if(engine)void engine.tick().catch(()=>api.log.warn('鱼世界调度失败，保留运行状态'));},'世界采集和生活调度');
    api.every(10000,writeStatus,'世界状态记录');api.later(1000,()=>{void sync().catch(()=>{});writeStatus();});
    api.onDispose(async()=>{live=false;await engine?.dispose();for(const off of offs.reverse())try{off?.();}catch{}bridge.dispose();});
    writeStatus();api.log.info('鱼的世界 1.1.0 已加载：持久队列、同人格生活会话、正式 QQ 分享；聊天刷新保持非阻塞。');
    return {status,refresh:sync,control:(action,instruction)=>{if(!allowed())throw Error('模块未启用');engine.control(action,instruction);writeStatus();}};
  }
};
