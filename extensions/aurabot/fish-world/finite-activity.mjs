/** The final server footer describes the primary activity. Quoted/body and parallel fields are not evidence. */
export function finiteActivityFromReceipt(text){
 if(typeof text!=='string')return null;
 const lines=text.trimEnd().split(/\r?\n/),proofLine=lines.at(-1),fields=proofLine.split(' · '),clock=/^—— 现在 ((?:[01]?\d|2[0-3]):[0-5]\d)$/.exec(fields[0]);
 if(!clock||!/^在[^\r\n]+$/.test(fields[1]||''))return null;
 const index=fields.findIndex((field,i)=>i>=2&&field.startsWith('在做：'));
 if(index<2)return null;
 const activity=/^在做：([^\r\n]{1,200})（((?:[01]?\d|2[0-3]):[0-5]\d) 结束）$/.exec(fields[index]);
 if(!activity)return null;
 const started=/^好的[，,。]\s*你开始([^\r\n]+)$/.exec(lines[0]||'');
 if(!started?.[1].startsWith(activity[1])||!/^(?:[，,。！!]|了(?:[。！!，,]|$)|$)/.test(started[1].slice(activity[1].length)))return null;
 return {label:activity[1],observedClock:clock[1],endClock:activity[2],proofLine};
}
