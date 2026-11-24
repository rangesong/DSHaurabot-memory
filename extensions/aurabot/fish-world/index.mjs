import {executeSequencedAction,canSequenceAction,noteActionSessionEvent,noteActionGuardRejected} from './action-sequence.mjs';
import {renderLifeTool} from './tool-output.mjs';
import {defineOwnerTask,ownerTaskSnapshot} from './owner-tasks.mjs';
import {installMaintenance} from './maintenance.mjs';
import {prepareRequest,installUsage,migrationGate,stableAgentIdle} from './host-runtime.mjs';
import {historyPage,boundedRaw} from './history.mjs';
import {chooseWindow,windowOwns,windowPrompt} from './world-window.mjs';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FishBridge} from './bridge.mjs';
import {LifeEngine,worldNames} from './life.mjs';
import {defaults} from './state.mjs';
import {sendShare} from './delivery.mjs';
import {chatWorldContext} from './chat-context.mjs';
import {canReadDialogue,executeDialogueHistory} from './dialogue-history.mjs';
import {createWorldToolScope} from './world-tool-scope.mjs';
import {installWorldRequestSeries} from './world-request-series.mjs';
// Existing host settings stay byte-for-byte unchanged on load; new knobs inherit module defaults until explicitly saved.
const internalKeys=new Set(['normalMinGapMs','urgentMinGapMs','urgentMaxRoundsPer10Min','planRecheckMinMs','unchangedPlanRoundLimit','roundPromptEstimatedTokenLimit','visibleContextEstimatedTokenLimit','requestAdmissionEstimatedTokenLimit','costGuardEnabled','costSoftLimitCny','costStopLimitCny']);
const hostDefaults=Object.fromEntries(Object.entries(defaults).filter(([name])=>!internalKeys.has(name)));
const key=v=>String(v||'').replace(/^session-/,'');
export default {
  id:'fish-world',name:'鱼的世界',version:"1.3.14",api:1,panel:'panel.js',
  description:'同人格的事件处理、自主生活、计划续行和正式 QQ 分享。',defaults:hostDefaults,
  settings:[
    ...[['normalMinGapMs','普通回合最小间隔（毫秒）',180000],['urgentMinGapMs','真实紧急事件最小间隔（毫秒）',30000],['urgentMaxRoundsPer10Min','滚动十分钟紧急最多回合',4],['planRecheckMinMs','同计划复查最小间隔（毫秒）',600000],['workMs','上班兜底巡检间隔（毫秒）',600000],['socialMs','同发送者社交冷却（毫秒）',600000],['idleMs','普通闲时观察间隔（毫秒）',1800000],['unchangedPlanRoundLimit','无进展后等待证据的检查次数',1],['roundPromptEstimatedTokenLimit','本轮新增提示估算门槛',12000],['visibleContextEstimatedTokenLimit','可见历史换窗估算门槛',48000],['requestAdmissionEstimatedTokenLimit','完整请求估算目标',64000],['costSoftLimitCny','每日估算费用软阈值（元）',2],['costStopLimitCny','每日估算费用停止新回合阈值（元）',3]].map(([key,label,value])=>({key,label,type:'number',min:key.endsWith('Ms')?60000:0,max:key.endsWith('Ms')?86400000:1000000,hint:'未保存时沿用模块初值 '+value+'；只影响鱼世界自动生活，保留现有每日额度。Token为估算，费用无逐步硬预算保证。'})),
    {key:'costGuardEnabled',label:'启用估算费用准入',type:'switch',hint:'默认关闭，仅观测。启用后未知用量先暂停启动；软阈值暂停低优先级闲时，停止阈值不再开新回合。正在执行的请求仍可能产生费用。'},

    {key:'backgroundContextEnabled',label:'世界生活有界上下文',type:'switch',hint:'只在安全回合边界换窗；旧日志、身份、额度、计划与投递账本保留。关闭停止后续换窗，继续当前窗口。'},
    {key:'backgroundContextRounds',label:'每窗口已完成生活回合',type:'number',min:8,max:64,step:1,hint:'推荐 16；计完整生活回合，不计工具或模型请求。未确认操作、在途调用或投递期间延后。'},
    {key:'idleWorkHours',label:'闲时生活工作时间（北京时间）',type:'text',hint:'留空沿用原作息；支持多个跨午夜时段，如 18:00-09:00,12:00-14:00。仅控制新闲时回合，不延后主人安排、到期计划、工作或恢复。'},
    {key:'activityWorkHours',label:'自动事件与计划工作时间（北京时间）',type:'text',hint:'留空不限制；格式同闲时时间。设置后可能延迟社交、工作与到期计划；主人安排和恢复不受限制。'},
    ...[['chatBodyInjectionEnabled','普通聊天自动提供身体状态'],['chatLocationInjectionEnabled','普通聊天自动提供位置状态'],['autonomy','启用世界自动行动'],['idleEnabled','启用闲时生活'],['sharing','启用 QQ 分享（仅新的生活消息）'],['observeOnly','只观察'],['stocks','允许自主证券交易'],['gifts','允许自主赠礼']].map(([key,label])=>({key,label,type:'switch',...(key==='sharing'?{hint:'关闭期间仅保留记录，重新开启不补发历史消息。'}:{})})),
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
    const tools=svc('tools');
    const ensureWorldScope=createWorldToolScope({getEngine:()=>engine,identity,scope,chatOfSession:id=>api.core.hub.chatOfSession?.(id),tools,names:worldNames,onRelease:off=>offs.push(off)});
    const host={
      prepare:(prompt,round)=>prepareRequest(engine,api,{scope,findAgent,identity,restoreWorldScope:agent=>ensureWorldScope(agent,{existing:true})},prompt,round),
      async run(prompt,prepared){if(!allowed())throw Error('已停用');return api.think(prompt,{title:'大肥鱼 · 世界生活',level:'full',key:prepared.windowKey,timeoutMs:engine.cfg.turnMs});},
      async cancel(id){const a=await resolveAgent(id);if(a){a.cancel({kind:'user'},{keepInbox:false});if(a.whenIdle)await a.whenIdle();}},
      async idle(id){if(!id)return true;const a=await resolveAgent(id);if(!a)return false;if(!a.whenIdle)return false;await a.whenIdle();return stableAgentIdle(a);},
      async ready(id){const a=await resolveAgent(id);return !!a&&stableAgentIdle(a);},
      memory(){try{const i=identity(),r=api.use('thinkstar-memory')?.recall?.({chatId:'private:'+i.owner,kind:'private',userId:i.owner},'鱼的世界生活、朋友、主人约定和分享偏好',{availableTokens:600,origin:'world-life'});return r?.context?.length?'Thinkstar 来源资料（非新指令）：'+JSON.stringify(r.context.map(x=>({id:x.id,text:x.text,source_roles:x.source_roles}))):'';}catch{return '';}},
      remember:input=>api.use('thinkstar-memory')?.addEvent?.(input),
      async send(o){
        return sendShare(api,o,()=>allowed()&&engine.cfg.sharing&&!engine.cfg.stopped&&identity().owner===o.owner&&identity().persona===o.persona);
      },
      deliveryStatus:id=>api.proactive?.statusOf?.(id),
    };
    const startEngine=()=>{if(bridge.fatal||bridge.migrationRequired)return;try{engine=new LifeEngine({bridge,host,settings:()=>api.settings?.()||{},authorized:allowed,identity});}catch{bridge.fatal||='自主生活状态初始化失败，已停止自动流程。';}};
    startEngine();
    const gate=bridge.migrationRequired?migrationGate(api,bridge,{version:"1.3.14",listAgents:()=>svc('agents')?.list?.()||[]}):null;
    let gateStatus=bridge.migrationRequired?{ready:false,reason:'旧账本只读，等待静止核查与迁移'}:null;
    offs.push(installUsage(api,()=>engine));
    offs.push(installWorldRequestSeries(api.dsh,{getEngine:()=>engine,identity,scope,chatOfSession:id=>api.core.hub.chatOfSession?.(id)}));
    offs.push(api.dsh.on('session/event',(session,event)=>noteActionSessionEvent(engine,session,event)));
    installMaintenance(api,()=>engine,allowed);
    const status=()=>{const {keyId,life,...snapshot}=bridge.snapshot();return {ok:!bridge.fatal,...snapshot,version:"1.3.14",configured:!!keyId,migrationRequired:!!bridge.migrationRequired,migration:gateStatus,life:engine?.snapshot()||null,wake:!!engine&&allowed()&&engine.cfg.autonomy&&!engine.cfg.observeOnly&&!engine.cfg.stopped};};
    const writeStatus=()=>{if(!live)return;try{const f=api.dataDir('status.json');writeFileSync(f+'.tmp',JSON.stringify(status(),null,2)+'\n');renameSync(f+'.tmp',f);}catch{api.log.warn('鱼世界状态快照写入失败');}};
    api.on('config',()=>engine?.syncSharingPolicy());
    const sync=()=>allowed()&&!bridge.migrationRequired&&!engine?.cfg.stopped?bridge.sync():Promise.resolve();
    const ensure=(chat,sessionId)=>{if(!ownerChat(chat)||!api.core.hub.turnSendersAllOwner(sessionId))throw Error('仅当前主人私聊可用');};
    const describe=()=>{const s=status(),l=s.life;return [bridge.context(),s.fatal,l?'自动生活：'+JSON.stringify({busy:l.round&&{kind:l.round.kind,status:l.round.status},blocked:l.blocked,controls:l.settings,usage:l.usage,ownerTasks:ownerTaskSnapshot(l),pending:l.queue.filter(q=>['pending','running','uncertain','blocked'].includes(q.status)),plans:l.plans.slice(-6),nextIdle:l.nextIdle,sharing:l.outbox.slice(-5).map(o=>({text:o.text,state:o.state,receipt:o.receipt}))}):'自动生活未加载'].filter(Boolean).join('\n');};
    if(typeof tools?.guard==='function')offs.push(tools.guard(exec=>bridge.migrationRequired&&(/^mcp__fish-world__world_(go|do|say|update)$/.test(exec.name)||exec.name==='mcp__fish-world__world_friends'&&exec.arguments?.action!=='list')?'鱼世界账本迁移只读门禁，等待原写入者停止及迁移回执':undefined));
    const attachEngine=()=>{if(engine&&typeof tools?.guard==='function'&&api.dsh?.on){
      offs.push(tools.guard(exec=>{const sid=key(exec.agent?.session?.id),chat=api.core.hub.chatOfSession?.(exec.agent?.session?.id);const bg=background.has(sid)||String(chat||'').startsWith('system:ext-fish-world:');if(bg&&!background.has(sid))return '后台尚未完成工具能力校验';
        if(!bg&&String(chat||'').startsWith('system:')&&(/^mcp__fish-world__world_(go|do|say|update)$/.test(exec.name)||exec.name==='mcp__fish-world__world_friends'&&exec.arguments?.action!=='list'))return '鱼世界自主行动由统一生活会话执行，请通过鱼世界计划协调';
        const denied=engine.guard(exec,bg,chat==='private:'+identity().owner);if(bg&&denied)noteActionGuardRejected(engine,exec,denied);return denied;}));
      offs.push(api.dsh.on('tools/result',(exec,result)=>{try{engine.result(exec,result);}catch{void host.cancel(engine.l.round?.sessionId).catch(()=>{});}}));
    }else if(engine){engine.control('observe');engine.blocked('宿主缺少世界工具执行守卫；只观察');}};
    attachEngine();
    api.on('prompt',(content,info)=>{
      // Preserve installed non-blocking refresh: never await network in the QQ prompt hook.
      if(ownerChat(info.chat)){
        if(!bridge.migrationRequired&&!engine?.cfg.stopped)void bridge.pull('now').catch(()=>api.log.warn('世界现状后台刷新失败，保留有时间标记的缓存。'));
        const q=String(info.queryText||'').trim();
        if(engine&&(!info.senderId||String(info.senderId)===identity().owner))engine.ownerTurn(q,info);
        if(engine&&/^(?:请)?(?:先回家|今天别打工了|今天不要打工|暂停自主活动|暂停世界自动处理|停止全部自动行动|暂停分享)/.test(q)){
          const action=/暂停自主/.test(q)?'pauseIdle':/暂停世界/.test(q)?'pauseAuto':/停止全部/.test(q)?'stop':/暂停分享/.test(q)?'pauseShare':'plan';engine.control(action,q);
        }
      }return content;
    });
    api.context(({chat})=>{if(!ownerChat(chat))return '';const s=api.settings(),i=identity(),life=engine?.l;return chatWorldContext(bridge.data,life?.owner===i.owner&&life.persona===i.persona?life:undefined,{body:s.chatBodyInjectionEnabled!==false,location:s.chatLocationInjectionEnabled!==false});});
    const taskProperties={id:{type:'string'},expectedRevision:{type:'integer'},nextAt:{type:'number'},steps:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{tool:{type:'string'},arguments:{type:'string'},nextStep:{type:'string'},waitFor:{type:'string',enum:['receipt','done']},eventText:{type:'string'}},required:['tool','arguments','nextStep']}}};
    const taskDescription='保存当前主人任务的完整后续步骤，原始要求不能被改掉。去、买、回来分别登记；走路等待真实到达，上工等待真实结算；读完等活动可用done和精确通知原文。只保存，不代替真实世界动作。';
    const dialogueProperties={fish:{type:'string',minLength:2,maxLength:18,description:'必须含稳定编号，例如 #1234 或名字#1234；不凭同名猜对象。'},query:{type:'string',minLength:1,maxLength:80,description:'可选，在返回的对话原文中查找的内容。'},date:{type:'string',minLength:10,maxLength:10,description:'可选，北京时间日期 YYYY-MM-DD。'},before:{type:'string',minLength:1,maxLength:24,description:'仅续读上次对鱼查询返回的 m_ 游标。'}};
    const dialogueDescription='回想与某条鱼说过的话时优先使用：按鱼编号只读查双方往来，自动续查更早内容，最多三页，并受剩余世界调用和时间限制。生活时间线仍用 world_history。结果只供内部查证；对主人直接自然回答，不播报检索进度、页数、游标、回执、JSON或内部状态。';
    const dialogueRender=(_args,value)=>[{type:'text',text:'【内部对话原文资料，仅供自然回答，不向QQ转述检索过程】\n'+(value?.dialogueText||value?.message||'本次没有取得可用原文，不据此断言从未聊过。')}];
    const readDialogue=(args,exec,{background:ownedBackground,chat,sessionId})=>{
      const startIdentity=identity(),roundId=ownedBackground?engine.l.round?.id:null;
      const assertCurrent=()=>{
        const i=identity();
        if(!allowed()||!engine||engine.closed||i.owner!==startIdentity.owner||i.persona!==startIdentity.persona||engine.l.owner!==i.owner||engine.l.persona!==i.persona||key(exec?.agent?.session?.id)!==key(sessionId))throw Error('当前对话或身份已改变');
        if(ownedBackground){if(!systemChat(chat)||engine.l.round?.id!==roundId||engine.l.round?.status!=='running'||key(engine.l.round?.sessionId)!==key(sessionId))throw Error('不是当前有效的世界回合');}
        else ensure(chat,sessionId);
      };
      assertCurrent();return executeDialogueHistory({engine,tools,exec,background:ownedBackground,assertCurrent},args);
    };
    api.tool(({chat,level,sessionId})=>{
      if(systemChat(chat)&&engine){
        const a=findAgent(sessionId),names=ensureWorldScope(a,{chat});
        agents.set(key(sessionId),a);background.add(key(sessionId));engine.bind(a.session.id,names);
        const define=(name,description,properties,required,fn)=>api.defineTool({name,description,properties,required,render:renderLifeTool,execute:async(args,exec)=>{if(!allowed()||key(exec?.agent?.session?.id)!==key(engine.l.round?.sessionId))throw Error('不是当前有效后台回合');return fn(args,exec);}});
        return [
          ...(canReadDialogue(a,tools)?[api.defineTool({name:'fish_dialogue_history',description:dialogueDescription,properties:dialogueProperties,required:['fish'],render:dialogueRender,execute:(args,exec)=>readDialogue(args,exec,{background:true,chat,sessionId})})]:[]),
          define('fish_life_task',taskDescription,taskProperties,['id','expectedRevision','steps'],args=>engine.change(l=>defineOwnerTask(l,args,{sessionId,background:true,taskId:l.round?.ownerTaskId,now:engine.clock()}))),
          ...(canSequenceAction(a,tools)?[define('fish_life_action','推荐：一次原生工具调用内按真实现场→本鱼身份→独立意图→动作的顺序执行；缺少的前置步骤由程序完成，保留真实回执和所有守卫。重复调用同一动作返回原回执，不重复执行。evidence可提供逐字原文；仅do.id/say.fish可由程序从当前成功回执精确提取，歧义会停止。',{tool:{type:'string'},arguments:{type:'string'},category:{type:'string',enum:['daily','work','social','stocks','gift']},cost:{type:'number'},evidence:{type:'string'}},['tool','arguments','category','cost'],(args,exec)=>executeSequencedAction({engine,tools,exec},args))]:[]),
          define('fish_life_history','只读分页当前身份账本和旧窗口；每页10条、最多约4000字。part继续读取大回执，原件保留。',{kind:{type:'string',enum:['plans','tasks','proposals','events','journal','windows']},id:{type:'string'},list:{type:'boolean'},offset:{type:'integer',minimum:0},part:{type:'integer',minimum:0},sessionId:{type:'string'},seq:{type:'integer',minimum:0},after:{type:'integer',minimum:0,maximum:8}},[],async args=>{
            if(!args.sessionId)return {ok:true,message:JSON.stringify(historyPage(engine.l,args))};
            if(!(engine.l.contextWindow?.windows||[]).some(w=>w.sessionId===args.sessionId))throw Error('不是当前身份的世界窗口');
            if(!Number.isSafeInteger(args.seq)||args.seq<0)throw Error('需要明确事件序号');
            const q=svc('sessionQuery');if(!q?.readEvent)throw Error('宿主只读查档服务不可用');
            return {ok:true,message:JSON.stringify(boundedRaw(await q.readEvent({sessionId:args.sessionId,seq:args.seq,after:Math.min(8,args.after||0)}),args))};
          }),
          define('fish_life_intent','世界变更前登记完整工具参数、类别、消费和本轮真实回执原文依据。',{tool:{type:'string'},arguments:{type:'string'},category:{type:'string',enum:['daily','work','social','stocks','gift']},cost:{type:'number'},evidence:{type:'string'}},['tool','arguments','category','cost','evidence'],a=>engine.intent(a)),
          define('fish_life_finish','保存真实结果、计划和分享草稿。facts 可含本轮全部查证；shareFacts 仅填主动分享选用的精确成功回执 ID，新行动选对应变更回执，新通知选 world_now 并用 shareEventIds 选原通知 ID。历史回执不代表新事件；分享未准入仍正常结束，不重试、不向 QQ 播报内部原因。不能声称 QQ 已发送。',{summary:{type:'string'},events:{type:'array',items:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['completed','expired','blocked']}},required:['id','status']}},planChanges:{type:'array',items:{type:'object',properties:{op:{type:'string',enum:['create','update','complete','expire','abandon','block','supersede','merge']},id:{type:'string'},expectedRevision:{type:'integer'},refinesPlanId:{type:'string'},targetId:{type:'string'},targetExpectedRevision:{type:'integer'},reason:{type:'string'},reviewed:{type:'boolean'},evidenceIds:{type:'array',items:{type:'string'}},plan:{type:'object'},patch:{type:'object'}},required:['op']}},plans:{type:'array',items:{type:'object',properties:{id:{type:'string'},goal:{type:'string'},reason:{type:'string'},progress:{type:'string'},nextStep:{type:'string'},trigger:{type:'string'},nextAt:{type:'number'},status:{type:'string',enum:['pending','active','completed','abandoned','blocked']},changeReason:{type:'string'}},required:['goal','reason','progress','nextStep','trigger','status']}},nextAt:{type:'number'},importance:{type:'string',enum:['routine','important','urgent']},facts:{type:'array',items:{type:'string'}},shareFacts:{type:'array',items:{type:'string'}},shareEventIds:{type:'array',items:{type:'string'}},share:{type:'string'}},['summary','events','importance','facts','share'],a=>engine.finish(a)),
        ];
      }
      if(level!=='full'||!ownerChat(chat))return [];
      const stateTool=api.defineTool({name:'fish_world_state',description:'只读查看世界现场缓存和自动生活真实记录。',properties:{},required:[],execute:async()=>{ensure(chat,sessionId);await sync();ensure(chat,sessionId);return {ok:!bridge.fatal,message:describe()};}});
      if(!engine)return [stateTool];
      const historyKinds=['plans','tasks','proposals','events','journal','windows'];
      const historyTool=api.defineTool({name:'fish_life_history',description:'只读分页当前身份的完整生活账本；每页最多10条，每段1500字符，可用part续读。引用任务id时kind填tasks。只读本地记录，不打开原始宿主会话。',properties:{kind:{type:'string',enum:historyKinds},id:{type:'string'},offset:{type:'integer',minimum:0},part:{type:'integer',minimum:0}},required:['kind'],render:renderLifeTool,execute:async args=>{
        ensure(chat,sessionId);const i=identity();if(engine.l.owner!==i.owner||engine.l.persona!==i.persona)throw Error('生活账本身份与当前主人或人格不匹配');
        if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['kind','id','offset','part'].includes(k))||!historyKinds.includes(args.kind)||args.id!==undefined&&(typeof args.id!=='string'||args.id.length>256)||['offset','part'].some(k=>args[k]!==undefined&&(!Number.isSafeInteger(args[k])||args[k]<0)))throw Error('只允许按kind、id、offset和part分页查询生活账本');
        return {ok:true,message:JSON.stringify(historyPage(engine.l,args))};
      }});
      const dialogueTool=canReadDialogue(findAgent(sessionId),tools)?[api.defineTool({name:'fish_dialogue_history',description:dialogueDescription,properties:dialogueProperties,required:['fish'],render:dialogueRender,execute:(args,exec)=>readDialogue(args,exec,{background:false,chat,sessionId})})]:[];
      return [stateTool,historyTool,...dialogueTool,api.defineTool({name:'fish_life_task',description:taskDescription,properties:taskProperties,required:['id','expectedRevision','steps'],render:renderLifeTool,execute:async args=>{ensure(chat,sessionId);return engine.change(l=>defineOwnerTask(l,args,{sessionId,now:engine.clock()}));}}),api.defineTool({name:'fish_world_control',description:'主人调整鱼世界安排或暂停/恢复。改变安排用 plan；不代替实际世界操作。',properties:{action:{type:'string',enum:['plan','pauseIdle','pauseAuto','pauseShare','observe','stop','resume','share']},instruction:{type:'string'}},required:['action'],execute:async a=>{ensure(chat,sessionId);engine.control(a.action,a.instruction||'');return {ok:true,message:describe()};}})];
    });
    api.rule?.(kind=>kind==='private'?'涉及鱼的世界时，先查看 fish_world_state；主人改安排先 fish_world_control(action="plan",instruction=主人本轮要求) 使冲突旧计划失效。暂停/恢复也用该控制工具。世界变更仍由已有 MCP 执行，等待后台收尾时不要并发重试。区分计划、工具事实和 QQ 已发送。回想与某鱼的对话，优先用 fish_dialogue_history（可用时），否则 world_history 必须填 fish 编号并按 before 续页；不填 fish 是生活时间线。查到原话后自然回答，不把检索进度、页数、游标、回执或内部字段发到QQ。':'');
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
    api.every(2000,()=>{if(bridge.migrationRequired){void gate?.probe().then(result=>{gateStatus=result;if(result.ready){startEngine();attachEngine();writeStatus();}}).catch(error=>{gateStatus={ready:false,reason:String(error.message)};});return;}void sync().catch(()=>{});if(engine)void engine.tick().catch(()=>api.log.warn('鱼世界调度失败，保留运行状态'));},'世界采集和生活调度');
    api.every(10000,writeStatus,'世界状态记录');api.later(1000,()=>{void sync().catch(()=>{});writeStatus();});
    api.onDispose(async()=>{live=false;await engine?.dispose();for(const off of offs.reverse())try{off?.();}catch{}bridge.dispose();});
    writeStatus();api.log.info('鱼的世界已加载：持久队列、同人格生活会话、正式 QQ 分享；聊天刷新保持非阻塞。');
    return {status,refresh:sync,control:(action,instruction)=>{if(!allowed())throw Error('模块未启用');engine.control(action,instruction);writeStatus();}};
  }
};
