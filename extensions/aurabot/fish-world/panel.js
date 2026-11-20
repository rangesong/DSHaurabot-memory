const {useState,useEffect}=React;
return function Panel({toast}) {
  const [s,setS]=useState(null);
  async function refresh(){try{setS(await call('/status'));}catch(e){toast(e.message);}}
  async function control(action){try{setS(await call('/control',{action}));}catch(e){toast(e.message);}}
  useEffect(()=>{refresh();const timer=setInterval(refresh,10000);return ()=>clearInterval(timer);},[]);
  const at=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未同步';
  return h(ui.Card,{title:'鱼的世界'},
    h('p',null,'事件每 30 秒采集，现场每分钟缓存；统一后台处理工作、社交、计划和闲时生活。'),
    h(ui.Btn,{onClick:refresh},'刷新显示'),
    s?h('div',null,
      h('p',null,s.state?.fish||'等待连接'),
      h('p',null,s.now||'尚未取得现状'),
      s.fatal?h('p',{style:{color:'#d44'}},s.fatal):null,
      s.life?h('div',null,
        h('p',null,'后台：'+(s.life.round?JSON.stringify({kind:s.life.round.kind,status:s.life.round.status}):'等待')+'　'+s.life.blocked),
        h('p',null,'当前控制：'+JSON.stringify(s.life.settings)),
        ...[['pauseIdle','暂停闲时'],['pauseAuto','暂停自动'],['pauseShare','暂停分享'],['share','恢复分享'],['observe','只观察'],['stop','全部停止'],['resume','恢复']].map(([a,label])=>h(ui.Btn,{key:a,onClick:()=>control(a)},label)),
        h('p',null,'今日用量：'+JSON.stringify(s.life.usage)),
        h('p',null,'下次闲时检查：'+at(s.life.nextIdle)),
        h('p',null,'世界工具：'+s.life.toolNames.length+' 个；会话：'+(s.life.sessionId||'待建立')),
        h('p',null,'待办'),
        ...s.life.queue.filter(q=>['pending','running','uncertain','blocked'].includes(q.status)).slice(-12).map(q=>h('p',{key:q.id},q.kind+'｜'+q.status+'｜'+q.text)),
        h('p',null,'生活计划'),
        ...s.life.plans.slice(-8).map(p=>h('p',{key:p.id},p.goal+'｜'+p.status+'｜'+p.nextStep+'｜'+(p.nextAt?at(p.nextAt):p.trigger))),
        h('p',null,'最近真实操作'),
        ...s.life.journal.slice(-5).reverse().map((j,i)=>h('p',{key:i},at(j.at)+' '+(j.tool||j.kind)+'｜'+j.status+'｜'+(j.result||j.summary||'').slice(0,600))),
        h('p',null,'QQ 分享投递'),
        ...s.life.outbox.slice(-6).reverse().map(o=>h('p',{key:o.id},o.state+'｜'+o.text+'｜'+(o.receipt||o.reason||'')))
      ):null,
      h('p',null,'现状采集时间：'+at(s.at.now)),
      h('p',null,'事件同步时间：'+at(s.at.notify)),
      ...Object.entries(s.errors).map(([key,value])=>h('p',{key,style:{color:'#d48a2c'}},key+'：'+value)),
      h('p',null,'QQ 私聊命令：/鱼世界；也可以直接问她现在在哪里。'),
      h('p',null,'最近事件'),
      ...s.recent.slice(-10).reverse().map((x,i)=>h('p',{key:i},at(x.t)+' '+x.text))
    ):h('p',null,'正在读取…')
  );
};
