import {relevantQueryTerms} from './v5-retrieval.js';

export const FEEDBACK_POLICY=2;
export const FEEDBACK_LABELS={comfort:'安慰',affection:'亲近',approval:'表达认可',play:'玩闹',dissatisfaction:'不满意',factual_correction:'事实纠正',factual_confirmation:'内容确认',task_pending:'事项催问',unknown:'待理解'};
export const normalizeFeedback=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/疲惫|疲劳|筋疲力尽|精疲力竭|疲倦/g,'累');
export const cleanReply=s=>String(s??'').normalize('NFKC').trim().replace(/\s+/g,' ');
export function feedbackCondition(query,reply=''){
  const q=normalizeFeedback(query),context=q+' '+normalizeFeedback(reply);
  if(/累|没力气|想休息/.test(q))return '疲惫';
  if(/吃|饭|饿|蛋糕|零食/.test(context))return '饮食近况';
  if(/发.*(?:我|图|照片)|照片|拍给|画.*(?:图|张)|发图|还没发/.test(context))return '发送内容';
  if(/抱歉|对不起|我错了|我做错|脑子抽|没看仔细/.test(reply))return '道歉之后';
  if(/逗你|开玩笑|嘿嘿|哈哈|傻鱼|鲨鱼/.test(q))return '玩笑互动';
  return relevantQueryTerms(q).filter(t=>t.length>1).slice(0,3).join('、');
}
export function feedbackConditionMatches(condition,query,reply=''){
  if(!condition)return false;
  return feedbackCondition(query,reply)===condition||relevantQueryTerms(normalizeFeedback(condition)).some(t=>normalizeFeedback(query).includes(t));
}
export function reactionEffects(meaning,turn={}){
  if(meaning==='factual_correction')return [feedbackCondition(turn.query,turn.reply)==='饮食近况'?'check_recent_completion':'acknowledge_correction'];
  if(meaning==='task_pending')return ['verify_delivery'];
  if(meaning==='comfort')return ['receive_comfort'];
  if(meaning==='play')return ['playful'];
  if(meaning==='affection')return ['warm_presence'];
  return [];
}
export const EFFECT_TEXT={
  check_recent_completion:'类似提醒前先核对最近原话，确认对方是否已经做过，避免重复催促。如果本轮没有当前完成状态，先用一句话确认，再决定是否提醒；不要直接假设还没做。不能据旧事断言本次也已完成。',
  acknowledge_correction:'对方曾在类似话题纠正过回答；先核对对应原话，直接承认并修正，避免用玩笑绕开纠正。',
  verify_delivery:'对方曾追问未收到的内容；区分打算、生成、发送和确认收到，缺少回执时明确待核实。',
  receive_comfort:'对方在类似情境中的表达可能是安慰；自然接住并简短感谢，不把安慰当作答对了。',
  playful:'类似互动已有玩闹依据，可以温和接梗；有明确纠正时先认真回应纠正。',
  warm_presence:'类似互动多次出现亲近线索，可以温和接住和陪伴，避免机械解读或索要满意确认。',
  less_followup:'对方曾明确要求减少追问，类似情境下少连续发问。',
  brief:'对方曾明确要求简短，类似情境下减少冗长解释。',
};

/** Local, inexpensive interpretation. Unknown media stays unknown; a new question is not feedback. */
export function classifyReaction(text,{turn={},media=[],lexicon={}}={}){
  const literal=normalizeFeedback(text).trim(),labels=media.map(m=>m.label).filter(Boolean),t=[literal,...labels].join(' ');
  const dimensions={affection:'unknown',style:'unknown',factual:'unknown',task:'unknown'};
  let meaning='unknown',category='not_feedback',confidence=0,basis='local_context_rules',inferred=true,review_pending=false;
  const negatedApproval=/(?:没|不|不是|不太|并非).{0,3}(?:有帮助|满意|对的|很好)|(?:不是|不代表|不表示|并非).{0,6}(?:认可|答对|正确|满意)/.test(t);
  const correction=/记错|说错|不对|错了|不是这个意思|理解错|我说的是|我的意思是|不是让你|不需要你/.test(t)||(/刚刚不是.{0,20}吗|我(?:刚刚|已经|刚才).{0,8}(?:吃过|吃了|做过|做了|取完)/.test(t)&&/快去|吃饭|还没|别又|你没/.test(turn.reply??''));
  const pending=/怎么还没|为什么还没|还没(?:发|给|收到|完成)|什么时候(?:发|给我|完成)|不是说.{0,15}(?:发|给|完成)|说好的.{0,12}呢/.test(t);
  const complaint=/不满意|没解决|没听懂|太啰嗦|说太多|太长了|问太多|别追问|不要追问|记忆(?:真|太|很)?差|没看(?:前面|仔细)|没有帮助/.test(t);
  const positive=!negatedApproval&&/有帮助|这样就好|做得好|回答得好|就是这个意思|很满意|喜欢这个方式|对的/.test(t);
  const affection=/摸摸头|摸头|抱抱|贴贴|蹭蹭|亲亲|\[(?:表情[:： ]*)?可爱\]/.test(t);
  const confirmation=/^(?:对|对呀|是的|是|嗯对|没错|没错的)[啊呀呢!！。\s]*$/.test(literal)&&/(?:是.{0,16}[吧吗?？]|对吗|对不对|没记错|是不是)/.test(turn.reply??'');
  const titledEmoji=/\[[^\]]{1,20}\]/.test(literal)||labels.length>0;
  const genericOnly=/^\[(?:动画表情|图片|表情|动图)\]$/.test(literal)&&!labels.some(s=>!/^[\[\s]*(?:动画表情|图片|表情|动图)[\]\s]*$/.test(s));
  if(positive){meaning='approval';category='style';confidence=.9;inferred=false;dimensions.style='explicit_positive';}
  if(affection){meaning='affection';category='emotion';confidence=.35;dimensions.affection='possible_positive';review_pending=true;
    if(/对不起|抱歉|沮丧|我做错|我错了|脑子抽|没看仔细/.test(turn.reply??'')){meaning='comfort';confidence=.55;}
    else if(/玩|嘿嘿|逗你/.test(turn.query??'')){meaning='play';confidence=.4;}
  }
  if(confirmation){meaning='factual_confirmation';category='confirmation';confidence=.9;inferred=false;dimensions.factual='user_confirmation';review_pending=false;}
  if(pending){meaning='task_pending';category='task';confidence=.9;inferred=false;dimensions.task='user_reported_pending';review_pending=false;}
  if(complaint){meaning='dissatisfaction';category='quality';confidence=.9;inferred=false;dimensions.style=/啰嗦|说太多|太长|追问|问太多/.test(t)?'explicit_negative':'unknown';review_pending=false;}
  if(correction){meaning='factual_correction';category='correction';confidence=.95;inferred=false;dimensions.factual='explicit_correction';review_pending=false;}
  if(/(?:已经完成了|这次成功了|问题解决了)/.test(t)&&!/(?:没|未|不).{0,4}(?:完成|成功|解决)/.test(t))dimensions.task='user_reported_success';
  if(category==='not_feedback'&&(/你傻了|傻了吧唧|傻鱼|大鲨鱼|大傻鱼/.test(t)||titledEmoji)){
    category='ambiguous_reaction';confidence=.15;review_pending=!genericOnly;
  }
  if(genericOnly){meaning='unknown';category='media_pending';confidence=0;basis='media_description_missing';review_pending=false;}
  const match=Object.entries(lexicon).filter(([phrase])=>t.includes(normalizeFeedback(phrase))).sort((a,b)=>b[0].length-a[0].length)[0];
  if(match&&!correction&&!pending){meaning=match[1].meaning;category='emotion';confidence=.8;basis='user_corrected_expression';inferred=false;review_pending=false;}
  const effects=reactionEffects(meaning,turn);
  if(dimensions.style==='explicit_negative'){if(/追问|问太多/.test(t))effects.push('less_followup');if(/啰嗦|说太多|太长/.test(t))effects.push('brief');}
  return {meaning,category,confidence,basis,dimensions,correction,approval:meaning==='approval'&&!inferred&&!correction&&!negatedApproval,dissatisfied:complaint,
    inferred,review_pending,is_feedback:category!=='not_feedback',effects:[...new Set(effects)],condition:feedbackCondition(turn.query,turn.reply),media:media.slice(0,4),policy:FEEDBACK_POLICY};
}
