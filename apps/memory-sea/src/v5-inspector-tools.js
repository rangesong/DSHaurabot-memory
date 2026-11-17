/** Operator views use the same scope-bound APIs as the native module. */
export function createInspectorTools({api,panel,title,el,btn,state:s,number,date,openMemory,refresh,trace,toast,onOpen=()=>{}}){
  let request=0;
  function scopePicker(render){
    const p=panel();title(p,'U / 独立范围','先选择一个聊天范围','归档和事实编辑按人格与聊天隔离。');
    for(const scope of s.overview.scopes)p.append(btn(scope.label,'memory-row',()=>{s.scope=scope.id;document.getElementById('scope').value=s.scope;return refresh().then(render);}));
  }
  async function archive(options={}){
    onOpen('archive');
    if(s.scope==='all')return scopePicker(()=>archive(options));
    const token=++request,scope=s.scope,p=panel();s.panel='archive';s.selected=null;
    const {level=2,day=null,month=null,offset=0,keyword=''}=options;
    title(p,'U / L2 → L1 → L0','三层原文归档','月印象与日摘要是导航；精确细节始终回到 L0。归档不会消耗或移走原文。');
    const [index,result]=await Promise.all([api('archive-index',null,{scope}),api('archive-read',null,{scope,level,day,month,offset,keyword,limit:30})]);
    if(token!==request||s.panel!=='archive'||scope!==s.scope)return;
    const grid=el('div','stats-grid');for(const [value,label]of [[index.l0,'L0 原始来源'],[index.l1,'L1 日摘要'],[index.l2,'L2 月印象'],[`${index.model_calls_today}/${index.model_daily_limit}`,'今日模型调用预留']]){const cell=el('div');cell.append(el('b','',typeof value==='number'?number(value):value),el('span','',label));grid.append(cell);}p.append(grid);
    const nav=el('div','panel-actions');for(const [value,label]of [[2,'月印象'],[1,'日摘要'],[0,'完整原话']])nav.append(btn(label,level===value?'active':'',()=>archive({level:value,month,day:value===0?day:null})));p.append(nav);
    if(level===0){const input=el('input','panel-input');input.value=keyword;input.placeholder='只在原文内找关键词';input.setAttribute('aria-label','归档原文关键词');p.append(input,btn('查找原话','quiet full',()=>archive({...options,level:0,keyword:input.value,offset:0})));}
    p.append(btn('导出所选期间（含私人原话）','text-button',async()=>{const value=await api('archive-export',null,{scope,day,month}),blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download='thinkstar-'+(day??month??scope)+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
    if(day||month){p.append(el('p','panel-meta',day??month));p.append(btn('返回全部月份','text-button',()=>archive()));}
    async function build(period,unitLevel,useModel=false,retry=false){
      toast(useModel?'正在整理选定期间；完整原话保持可读。':'正在本地整理，不调用模型。');
      const value=await api('archive-build',{scope,level:unitLevel,period,use_model:useModel,retry_uncertain:retry});
      if(value.run_id)await trace(value.run_id);
      if(scope!==s.scope||s.panel!=='archive')return;
      if(value.status==='uncertain'){p.append(el('div','notice',value.message),btn('重试未确认调用（可能再次计费）','quiet full',()=>build(period,unitLevel,true,true)));return;}
      toast(value.status==='budget_exhausted'?'已保存完成分块；今日模型配额已用完，原话仍可读。':value.cached?'输入未变化，复用归档结果，本次未调用模型。':value.status==='queued'?'同一归档正在处理中。':'归档导航已保存，原始来源未删除。');
      await refresh();await archive(options);
    }
    for(const item of result.items){
      const card=el('article','source-card');
      if(level===0){
        card.append(el('p','source-head',`${item.speaker??item.role} · ${date(item.time)} · ${item.role}`),el('div','source-text',item.text),el('p','source-foot',item.source_id));
        if(item.precision!=='full_as_received')card.append(el('p','source-warning','上游可能已截断，当前内容是收到的原始版本。'));
        if(item.role==='assistant')card.append(el('p','source-warning',`助手观察：${item.delivery_status??'投递状态未知'}；不能作为用户事实或成功发送证明。`));
        const actions=el('div','panel-actions');actions.append(btn('打开来源对象','',()=>openMemory('raw:'+item.source_id,scope)));
        if(item.role==='user')actions.append(btn('记事／事实键','',()=>factEditor({...item,id:item.source_id,scope})));card.append(actions);
      }else{
        const period=item.day??item.month;card.append(el('p','source-head',`${period} · ${item.count??item.days} ${level===1?'条原始来源':'天'}`),el('div','source-text',item.summary||'摘要待整理；原话已独立保存，可以直接读取。'));
        const actions=el('div','panel-actions');actions.append(btn(level===2?'展开日目录':'读取完整原话','',()=>archive(level===2?{level:1,month:period}:{level:0,day:period})));
        if(level===2)actions.append(btn('直接查本月原话','',()=>archive({level:0,month:period})));
        actions.append(btn(item.status==='pending'?'本地整理':'检查并复用','',()=>build(period,level)));
        const modelButton=btn('用模型整理所选期间','',()=>build(period,level,true));modelButton.disabled=!s.overview.model?.configured;actions.append(modelButton);
        if(item.memory_id)actions.append(btn('定位归档星点','',()=>openMemory(item.memory_id,scope)));card.append(actions);
      }
      p.append(card);
    }
    if(!result.items.length)p.append(el('div','notice',index.l0?'这个筛选下没有条目。即使没有摘要，也可切换“完整原话”。':'这个范围尚无原始来源。'));
    if(offset)p.append(btn('上一页','text-button',()=>archive({...options,offset:Math.max(0,offset-30)})));
    if(result.has_more)p.append(btn('下一页','quiet full',()=>archive({...options,offset:result.next_offset})));
    p.append(el('p','hint','后台只对已结束的日／月做本地导航整理。模型整理需要明确点击；相同输入、模型和版本复用结果。时间未知的来源单独列为 unknown，不伪造日期。'));
  }
  async function context(){
    onOpen('context');
    const token=++request,p=panel(),scope=s.scope;s.panel='context';title(p,'W2 / 上下文装配账本','上下文洞察','记忆包、DSH 请求边界回执与整次模型用量分开记录。空间依然是计量估算；进入请求不等于实际采用。');
    const value=await api('context-report',null,{scope});if(token!==request||s.panel!=='context'||scope!==s.scope)return;
    for(const row of value.reports){
      const card=el('article','source-card');card.append(el('p','source-head',`${date(row.at)} · ${row.query||'无查询文字'}`));
      const total=Object.values(row.composition).reduce((a,b)=>a+b,0),bar=el('div','context-stack');
      for(const [key,label,color]of [['recent','近期原话','#89d8ff'],['state','状态与事实','#f6cb82'],['long','长期证据','#a59cff'],['optional','条件印象','#d998c1']]){const segment=el('i');segment.style.width=(row.composition[key]/Math.max(1,total)*100)+'%';segment.style.background=color;segment.title=`${label}：约 ${row.composition[key]} tokens`;bar.append(segment);card.append(el('span','badge',`${label} ${row.composition[key]}`));}card.append(bar);
      card.append(el('p','hint',`准备约 ${total} / ${row.budget?.available??'未知'} tokens；宿主序列化 ${row.host_serialized_estimate??'未知'}；新增 ${row.added.length} 项／退出 ${row.removed.length} 项。`),el('p','hint',`${row.presentation?.summary??'缺少历史请求回执'}；${row.presentation?.usage_label??'缺少引用证据'}；模型计量：${row.model_usage?.total_tokens??'未知'}。`));
      const sizing=row.budget?.host_sizing;
      if(row.coordination)card.append(el('p','hint',`共同供给：合并重复 ${row.coordination.own_duplicates.length+row.coordination.native_duplicates.length}；原生无关资料减少 ${row.coordination.native_unrelated}；来源/事实版本优先 ${row.coordination.conflicts.length}；未确认冲突 ${row.coordination.unresolved.length}。`));
      if(sizing)card.append(el('p','hint',sizing.mode==='host_meter_estimate'?`自动额度：模型窗口 ${sizing.context_window}；已占约 ${sizing.occupied_estimate}；本轮输入约 ${sizing.incoming_estimate}；回答预留 ${sizing.output_reserve}；追加与误差预留 ${sizing.safety_reserve}。`:'本次缺少完整会话计量或模型刚切换，使用模块上限；未将估算当作精确余量。'));
      for(const receipt of row.host_receipts??[]){
        const state=receipt.completion==='completed'?'请求完成':receipt.completion==='pending'?'请求进行中':`请求未完成（${receipt.completion}）`;
        card.append(el('p','hint',`已在 DSH 模型请求边界核对 ${receipt.included_ids.length} 条记忆 · ${state} · ${receipt.provider}/${receipt.model}。`));
        if(receipt.window)card.append(el('p','hint',`完整会话输入约 ${receipt.window.input_estimate} tokens；回答预留 ${receipt.window.output_reserve??'未知'}；剩余约 ${receipt.window.remaining_estimate??'未知'}。`));
        if(receipt.usage)card.append(el('p','hint',`整次模型实测：输入 ${receipt.usage.prompt_tokens??'未知'} / 输出 ${receipt.usage.completion_tokens??'未知'} tokens，包含其它上下文，不是 Thinkstar 单独消耗。`));
      }
      for(const [reason,count]of Object.entries(row.omitted))card.append(el('p','source-foot',`未装入 ${count} 项：${reason}`));
      for(const candidate of row.candidates.slice(0,8))card.append(btn(`${candidate.label} · ${candidate.assembly} · BM25 ${candidate.bm25?.score?.toFixed(2)??'—'}`,'memory-row',()=>openMemory(candidate.id,candidate.scope??row.scope)));
      p.append(card);
    }
    if(!value.reports.length)p.append(el('p','hint','还没有这个范围的检索装配记录。查询记忆后再查看。'));
  }
  async function factEditor(source){
    onOpen('facts');
    const token=++request,scope=source.scope??s.selected?.scope,p=panel();s.panel='facts';
    title(p,'M1 / 有来源、可撤回','明确记事与事实更新','事实键只表示“同一对象的同一方面”，例如 budget.limit。留空只记事；模型不能自动用键覆盖现行事实。');
    const data=await api('fact-index',null,{scope});if(token!==request||s.panel!=='facts')return;
    const quote=el('textarea','panel-input'),field=el('input','panel-input'),reason=el('textarea','panel-input'),current=el('div','notice');
    quote.rows=5;quote.value=source.text;quote.setAttribute('aria-label','逐字引用的用户原话');field.placeholder='事实键，可选：budget.limit';field.setAttribute('aria-label','事实键');reason.placeholder='人工确认的理由';reason.setAttribute('aria-label','事实更新理由');
    const subject=source.provenance?.speaker_id??source.speaker_id??'local:operator',selected=()=>data.items.find(item=>item.subject===subject&&item.field===field.value.trim());
    field.addEventListener('input',()=>{current.textContent=selected()?`现行值：${selected().text} · v${selected().revision}。保存后保留为历史，可撤回。`:'这个主体尚无此事实键。不会合并其他人或聊天的记录。';});current.textContent='填写事实键后会显示同主体的现行值。';
    p.append(el('p','panel-meta',`主体由来源固定：${subject}`),quote,field,reason,current);
    p.append(btn('只记事，保留精确原话','quiet full',async()=>{const value=await api('remember-source',{scope,source_id:source.id??source.source_id,quote:quote.value});await refresh();openMemory(value.memory.id,scope);}));
    p.append(btn('按事实键保存为现行版本','quiet full',async()=>{const old=selected(),value=await api('fact-write',{scope,source_id:source.id??source.source_id,quote:quote.value,field:field.value.trim(),reason:reason.value,expected_id:old?.id??null,expected_revision:old?.revision??null});await refresh();openMemory(value.memory.id,scope);}));
  }
  return {archive,context,factEditor};
}
