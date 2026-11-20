import { LAYERS,MEMORY_FLOWS } from '../shared/v5-memory-layout.js';
export { LAYERS,MEMORY_FLOWS } from '../shared/v5-memory-layout.js';
/** V5 runtime contract. Four organizational regions; canonical content lives in U. */
export const REGIONS = [
  { id:'W1', name:'丘脑核群', domain:'work', color:'#83e4ef', position:[25,635,5], radii:[28,24,27], function:'接收原文、识别范围与保护信号；可靠提交后立即可读。', anatomy:'丘脑位于脑内中央；以感觉信息中继启发接收门控，完整编码仍由多个模块共同完成。', research:'https://pubmed.ncbi.nlm.nih.gov/1678190/' },
  { id:'W2', name:'前额皮层', domain:'work', color:'#eed49d', position:[80,747,125], radii:[52,27,29], function:'维护当前选择与未完事项，路由目录，展开底座并装配有来源的工作包。', anatomy:'额叶前部、前上方；借用前额皮层的工作记忆与调度功能。', research:'https://www.ninds.nih.gov/sites/default/files/2025-05/know-your-brain-brian-basics.pdf' },
  { id:'W3', name:'杏仁核', domain:'work', color:'#f5a9c7', position:[100,458,80], radii:[30,25,30], function:'输入初评、读后复评和情境化互动；实际反馈未知时保持未知。', anatomy:'前内侧颞叶的深部；杏仁核参与情绪评价，不单独决定事实、人格或权限。' },
  { id:'W4', name:'布罗卡区', domain:'work', color:'#a4e6cf', position:[196,570,100], radii:[31,27,26], function:'在本面板表达有依据的结果；提议、草稿与真实执行分别记录。', anatomy:'角色左侧额下回，正面观看时位于画面右侧；语言生产涉及更广泛网络。', research:'https://www.ninds.nih.gov/sites/default/files/2025-05/know-your-brain-brian-basics.pdf' },
  { id:'W5', name:'海马体', domain:'work', color:'#bdb0fa', position:[-176,475,-10], radii:[31,24,49], function:'经历归组、索引交接、压缩归档、保护依赖、重试与容量治理。', anatomy:'内侧颞叶深部，以海马—皮层整合启发巩固；容量治理是工程职责。' },
  { id:'M1', name:'时间细胞', domain:'memory', color:'#9eddec', position:[-207,565,-20], radii:[28,26,27], function:'时间目录、阶段摘要与版本引用；命中后读取 U 的有序来源。', anatomy:'时间细胞研究启发：海马及内嗅皮层附近的时序组织；不是专属的时间器官。', research:'https://pmc.ncbi.nlm.nih.gov/articles/pmid/33109718/' },
  { id:'M2', name:'情景记忆', domain:'memory', color:'#efb486', position:[206,470,-28], radii:[27,25,26], function:'项目、目标、完整经历与未完事项的目录；具体记忆仍存放在 U。', anatomy:'以内侧颞叶和海马相关网络为主要空间参考；情景记忆是分布式能力。', research:'https://www.ncbi.nlm.nih.gov/books/NBK231621/' },
  { id:'M3', name:'人物图式', domain:'memory', color:'#d5a3e8', position:[125,650,140], radii:[29,23,17], function:'范围内身份、条件偏好、支持与反例的目录；不合并同名人物。', anatomy:'以内侧前额皮层的人物图式研究为参考；人物知识还涉及颞叶等网络。', research:'https://pmc.ncbi.nlm.nih.gov/articles/PMC8355471/' },
  { id:'M4', name:'共同基础', domain:'memory', color:'#9fbffa', position:[-195,695,-35], radii:[28,26,26], function:'按平台、群聊／私聊与明确话题链组织对话；时间仅用于排序。', anatomy:'共同基础（common ground）的对话研究启发，位置借用颞顶交界与相关社会认知网络；不是独立脑器官。', research:'https://pmc.ncbi.nlm.nih.gov/articles/PMC6181272/' },
  { id:'U', name:'记忆底座', domain:'store', color:'#c4e8fa', position:[35,545,80], radii:[17,17,17], function:'原话、经历、声明、状态与来源版本的唯一底座；L0完整原话、L1日摘要、L2月印象逐级读取。', anatomy:'工程组件，投影在脑内中央；不等同某一解剖部位。' },
];
const mistShapes={W1:'成对的卵圆核团',W2:'前部弧形、带褶皱的皮层薄片',W3:'两端收尖的杏仁状体积',W4:'额下回的分叶折叠片',W5:'前粗后细的 C 形弯管'};
for(const region of REGIONS)if(mistShapes[region.id])region.mist_shape=mistShapes[region.id];
export const RULE_PARAMS={W1:['write_detail'],W2:['recall_depth','candidate_limit'],W3:['expression_gain'],W4:['detail_level','followup_pressure','style_accommodation','memory_explicitness'],W5:['learning_rate']};
const links = [['IN','W1'],['W1','U'],['W1','W2'],['W1','W3'],['W2','U'],['W2','W3'],['W2','W4'],['W3','W4'],['W4','OUT'],['OUT','W1'],['W5','U'],['W5','W2']];
for (const id of ['M1','M2','M3','M4']) links.push(['W2',id],['W5',id],[id,'U']);
links.push(['M1','M2'],['M2','M3'],['M3','M4'],['M4','M1']);
for(const {from,to} of MEMORY_FLOWS)links.push([from,to]);
for(const layer of LAYERS)links.push(['U','L:'+layer.id]);
for(const id of ['W1','W2','W3','W4','W5'])links.push(['L:implicit',id]);
export const CHANNELS = links.map(([from,to])=>({id:[from,to].sort().join('~'),from,to}));
export const DEFAULT_CONFIG = {
  W1:{write_detail:.6,goal_link:.35,loss_cost:.45,uniqueness:.2,emotion_bonus_cap:.15,pending_limit:2000},
  W2:{bm25_k1:1.2,bm25_b:.75,recall_depth:2,candidate_limit:60,route_limit:3,lexical:.45,semantic:.35,entity:.2,association_breadth:8,hop_decay:.55,diversity_lambda:.75,context_tokens:8192,recent_tokens:4096,state_tokens:1024,long_tokens:2048,optional_tokens:1024,followup_searches:1},
  W3:{expression_gain:.4,feedback_learning_rate:.1,emotion_context_limit:4,rumination_limit:1},
  W4:{memory_explicitness:.4,followup_pressure:.2,topic_initiative:.3,style_accommodation:.5,detail_level:.5},
  W5:{maintenance_start_hour:1,maintenance_hours:5,keep_raw_archive:1,archive_daily_calls:6,batch_size:24,background_interval_ms:1500,ordinary_half_life_days:30,recent_hours:72,summary_ratio:.25,lossy_after_days:30,forget_after_days:180,low_value_recovery:.3,learning_rate:.1,capacity_mb:512,backlog_threshold:1000},
  M1:{temporal_fit:.5,phase_fit:.2,relevance:.3,context_span:12},
  M2:{event_fit:.4,goal_fit:.3,relevance:.3,expand_depth:2},
  M3:{identity_fit:.45,condition_fit:.35,relevance:.2,counterexample_slots:2},
  M4:{scope_fit:.35,continuity:.25,reference_fit:.2,topic_fit:.2,span_messages:40,active_topics:8},
  U:{future_need:.3,loss_cost:.4,uniqueness:.2,rebuild_cost:.1},
  display:{visible_node_limit:240,edge_limit:300,label_density:1,display_focus_gain:1.3,view_2d:false},
};
export const PARAMS = {
  W1:{write_detail:['写入细致度',0,1,.05],goal_link:['目标关联权重',0,1,.05],loss_cost:['误丢代价权重',0,1,.05],uniqueness:['独特性权重',0,1,.05],emotion_bonus_cap:['情绪加分上限',0,.3,.01],pending_limit:['待处理容量',50,5000,50]},
  W2:{bm25_k1:['词频饱和系数',.2,3,.1],bm25_b:['篇幅归一强度',0,1,.05],recall_depth:['回忆深度／跳数',0,4,1],candidate_limit:['候选上限',10,200,10],route_limit:['目录路由数',1,4,1],lexical:['原话检索权重',0,1,.05],semantic:['语义目录检索权重',0,1,.05],entity:['实体检索权重',0,1,.05],association_breadth:['联想广度',0,32,1],hop_decay:['联想衰减',.1,.9,.05],diversity_lambda:['相关与多样性',0,1,.05],context_tokens:['上下文总预算',512,32768,512],recent_tokens:['近期完整链份额',128,16384,128],state_tokens:['状态与未完事项份额',128,8192,128],long_tokens:['长期证据份额',128,16384,128],optional_tokens:['共同语境份额',0,8192,128],followup_searches:['受限补查次数',0,1,1]},
  W3:{expression_gain:['情绪表达强度',0,1,.05],feedback_learning_rate:['反馈学习速度',0,1,.05],emotion_context_limit:['相关情绪经历数',0,12,1],rumination_limit:['同源反复提起上限',0,3,1]},
  W4:{memory_explicitness:['记忆显露程度',0,1,.05],followup_pressure:['追问压力',0,1,.05],topic_initiative:['话题主动程度',0,1,.05],style_accommodation:['语言贴近程度',0,1,.05],detail_level:['回答细致度',0,1,.05]},
  W5:{maintenance_start_hour:['夜间开始时刻',0,23,1],maintenance_hours:['夜间运行时长／小时',1,12,1],keep_raw_archive:['保留原文冷档',0,1,1],archive_daily_calls:['每日归档模型调用上限',0,50,1],batch_size:['后台批次大小',1,100,1],background_interval_ms:['后台间隔／毫秒',500,10000,500],ordinary_half_life_days:['普通可达性半衰期／天',1,365,1],recent_hours:['完整近期窗口／小时',1,720,1],summary_ratio:['普通要旨目标比例',.1,.8,.05],lossy_after_days:['普通有损整理／天',1,365,1],forget_after_days:['低价值退出活跃层／天',2,730,1],low_value_recovery:['低价值恢复投入',0,1,.05],learning_rate:['印象更新速度',0,1,.05],capacity_mb:['底座容量预算／MB',32,4096,32],backlog_threshold:['积压警戒数量',10,10000,10]},
  M1:{temporal_fit:['时间匹配权重',0,1,.05],phase_fit:['阶段匹配权重',0,1,.05],relevance:['内容相关权重',0,1,.05],context_span:['时间展开消息数',1,80,1]},
  M2:{event_fit:['经历匹配权重',0,1,.05],goal_fit:['目标匹配权重',0,1,.05],relevance:['内容相关权重',0,1,.05],expand_depth:['经历展开深度',1,5,1]},
  M3:{identity_fit:['身份匹配权重',0,1,.05],condition_fit:['情境匹配权重',0,1,.05],relevance:['内容相关权重',0,1,.05],counterexample_slots:['可选反例席位',0,8,1]},
  M4:{scope_fit:['空间匹配权重',0,1,.05],continuity:['连续性权重',0,1,.05],reference_fit:['指代依据权重',0,1,.05],topic_fit:['话题匹配权重',0,1,.05],span_messages:['连续对话展开数量',4,200,4],active_topics:['活跃话题数量',1,24,1]},
  U:{future_need:['未来用途权重',0,1,.05],loss_cost:['误丢代价权重',0,1,.05],uniqueness:['独特性权重',0,1,.05],rebuild_cost:['重建代价权重',0,1,.05]},
  display:{visible_node_limit:['可见底座节点',20,500,20],edge_limit:['内容关系上限',0,1000,20],label_density:['标签密度',0,2,.1],display_focus_gain:['聚焦显示增益',1,3,.1]},
};
export const HARD_RULES = ['P0/P1 不做有损替代或自动淘汰','近期原话立即可读，交接前不淘汰','未完承诺不随时间自动完成','浏览和候选命中不加深记忆','范围隔离、来源、事实有效性不能用滑杆改变','仅写 Thinkstar 数据目录，不改写 Aurabot 内置记忆、源码或代发消息'];
export const HANDOFF = ['accepted_durable','protected_pending','extracted_aligned','canonical_committed','lookup_available','handoff_verified'];
export const DAY = 86400000;
export const LIMITS = {text:1000000};
export const hashId = (scope,id) => `${encodeURIComponent(scope)}|${id}`;

Object.assign(DEFAULT_CONFIG.W2,{recall_items:6,association_weight:.12,vector_enabled:1,vector_min_score:.52,vector_top_k:12,rerank_enabled:0,rerank_top_n:8,rerank_timeout_ms:1800});
Object.assign(PARAMS.W2,{recall_items:['每轮可选记忆数',1,24,1],association_weight:['关系联想权重',0,.5,.025],vector_enabled:['本地语义召回',0,1,1],vector_min_score:['语义相似度门槛',.3,.95,.01],vector_top_k:['语义候选数',2,40,1],rerank_enabled:['按需模型重排',0,1,1],rerank_top_n:['重排候选数',3,16,1],rerank_timeout_ms:['重排等待上限／毫秒',500,8000,100]});
Object.assign(DEFAULT_CONFIG.W3,{auto_implicit_enabled:1,auto_implicit_min_days:2,implicit_min_evidence:3,feedback_window_minutes:30,learning_step_cap:.12,feedback_immediate_review:1});
Object.assign(PARAMS.W3,{feedback_immediate_review:['当前互动后台复核',0,1,1]});
Object.assign(PARAMS.W3,{auto_implicit_enabled:['经验自动成熟为内隐准则',0,1,1],auto_implicit_min_days:['成熟依据至少跨越的自然日数',1,14,1],implicit_min_evidence:['隐式反馈独立经历门槛',2,12,1],feedback_window_minutes:['反馈关联窗口／分钟',1,120,1],learning_step_cap:['表达自动调整上限',0,.25,.01]});
Object.assign(DEFAULT_CONFIG.W5,{semantic_batch:24,feedback_model_calls:2});
Object.assign(PARAMS.W5,{semantic_batch:['夜间语义索引批次',1,100,1],feedback_model_calls:['每日反馈归纳模型上限',0,10,1]});


Object.assign(DEFAULT_CONFIG.W5,{self_action_limit:1,self_action_timeout_ms:90000});
Object.assign(PARAMS.W5,{self_action_limit:['每轮自主行动上限',0,3,1],self_action_timeout_ms:['自主行动等待上限／毫秒',30000,180000,10000]});

Object.assign(DEFAULT_CONFIG.W5,{self_start_hour:1,self_end_hour:5,self_rounds_per_night:5,self_round_interval_minutes:20});
Object.assign(PARAMS.W5,{self_start_hour:['自主学习开始时／北京时间',0,23,1],self_end_hour:['自主学习结束时／北京时间',1,24,1],self_rounds_per_night:['每日自主学习轮数',1,12,1],self_round_interval_minutes:['轮次间隔／分钟',5,180,1]});

Object.assign(DEFAULT_CONFIG.W5,{self_strategy_enabled:1,strategy_min_evidence:2,strategy_trial_feedback:3});
Object.assign(PARAMS.W5,{self_strategy_enabled:['夜间自省策略试用',0,1,1],strategy_min_evidence:['发现问题的独立反馈数',2,12,1],strategy_trial_feedback:['效果验证所需明确反馈数',3,12,1]});

export const GROUP_POLICY_KEYS = ['group_policy_enabled','group_recent_days','group_trace_after_days','group_low_value_exit_days','group_ordinary_trace_exit_days'];
Object.assign(DEFAULT_CONFIG.W5,{group_policy_enabled:0,group_recent_days:1,group_trace_after_days:2,group_low_value_exit_days:3,group_ordinary_trace_exit_days:4});
Object.assign(PARAMS.W5,{
  group_policy_enabled:['启用群聊专用期限',0,1,1],
  group_recent_days:['完整近期记忆／天',1,365,1],
  group_trace_after_days:['普通内容进入残迹／天',1,365,1],
  group_low_value_exit_days:['低价值移入废弃库／天',1,730,1],
  group_ordinary_trace_exit_days:['普通残迹移入废弃库／天',1,730,1],
});
