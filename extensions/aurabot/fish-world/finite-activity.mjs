const CLOCK='((?:[01]?\\d|2[0-3]):[0-5]\\d)';
const minutes=clock=>clock.split(':').reduce((hours,value,index)=>index?hours+Number(value):Number(value)*60,0);
function startOf(header){
 const cooking=new RegExp('^好的，你在灶上做(.+?)(?:\\s+([1-9]\\d*)\\s*份)?，用了[^\\r\\n]*?，\\s*'+CLOCK+' 做好(?:[。！]|$)').exec(header);
 if(cooking)return {kind:'cooking',label:'做'+cooking[1].trim(),dish:cooking[1].trim(),count:Number(cooking[2]||1),endClock:cooking[3],parallel:true};
 const novel=new RegExp('^《([^》\\r\\n]{1,120})》[^\\r\\n]{1,100}? · 第\\s*\\d+\\s*段[^\\r\\n]*?[，,]\\s*'+CLOCK+'\\s*读完(?:[。！]|$)').exec(header);
 if(novel)return {kind:'label',label:'读《'+novel[1]+'》',endClock:novel[2],parallel:false};
 const eating=new RegExp('^好的，你一边[^\\r\\n]+一边([^\\r\\n]+?)[，,]\\s*'+CLOCK+' 吃完(?:[。！]|$)').exec(header);
 if(eating)return {kind:'label',label:eating[1],endClock:eating[2],parallel:true};
 const generic=/^好的[，,。]\s*你开始([^\r\n]+)$/.exec(header);
 return generic?{kind:'generic',text:generic[1],parallel:header.includes('这件事不占手')}:null;
}
/** Bind an explicit start to one exact activity in the final server footer, never body or quoted text. */
export function finiteActivityFromReceipt(text,{actionId,count}={}){
 if(typeof text!=='string')return null;
 const lines=text.trimEnd().split(/\r?\n/),proofLine=lines.at(-1),fields=proofLine.split(' · '),clock=new RegExp('^—— 现在 '+CLOCK+'$').exec(fields[0]);
 if(!clock||!/^在[^\r\n]+$/.test(fields[1]||''))return null;
 const start=startOf(lines[0]==='你醒了，起来了。'?lines[1]||'':lines[0]||'');if(!start)return null;
 const matched=[];
 for(const field of fields.slice(2)){
  const kind=/^(在做|同时)：/.exec(field);if(!kind)continue;
  const body=field.slice(kind[0].length),pattern=new RegExp('(?:^|、)([^\\r\\n]{1,200}?)（'+CLOCK+' (结束|吃完|做好)）(?=、|$)','g');let position=0;
  for(const activity of body.matchAll(pattern)){
   const label=activity[1],endClock=activity[2],marker=activity[3];let matches=false;
   if(start.kind==='generic'){
    const tail=start.text.startsWith(label)?start.text.slice(label.length):null;
    if(tail!==null&&/^(?:[，,。！!]|了(?:[。！!，,]|$)|$)/.test(tail)){const end=new RegExp('^[，,]\\s*'+CLOCK+' (结束|吃完|做好)').exec(tail);matches=!end||minutes(end[1])===minutes(endClock)&&(end[2]===marker||['结束','吃完'].includes(end[2])&&['结束','吃完'].includes(marker));}
   }else matches=label===start.label&&minutes(endClock)===minutes(start.endClock)&&(start.kind!=='cooking'||marker==='做好');
   if(matches){const legacyCook=start.kind==='generic'&&typeof actionId==='string'&&/^cook(?:-|$)/.test(actionId)&&marker==='做好'&&label.startsWith('做')&&label.length>1;matched.push({label,endClock,blocking:!legacyCook&&!start.parallel&&kind[1]==='在做'&&position===0,completion:start.kind==='cooking'?{kind:'cooking',dish:start.dish,count:start.count}:legacyCook?{kind:'cooking',dish:label.slice(1),count:Number.isSafeInteger(count)&&count>0?count:1}:{kind:'label',label}});}
   position++;
  }
 }
 if(matched.length>1)return {label:null,observedClock:clock[1],endClock:null,proofLine,blocking:true,ambiguous:true};
 return matched.length===1?{...matched[0],observedClock:clock[1],proofLine}:null;
}
