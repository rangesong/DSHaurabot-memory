// Aurabot's default renderer only shows value.message (otherwise a bare check mark).
// Life tools must expose their structured receipts and approved arguments to the model.
export const renderLifeTool=(_args,value)=>[{type:'text',text:JSON.stringify(value??{ok:true})}];

const WORLD='mcp__fish-world__world_';
const transportFailure=/timeout|timed[ \t_-]*out|abort|not[ \t_-]*connected|ECONNRESET|ENOTCONN|connection[ \t]+(?:reset|closed)|断线|连接(?:中断|断开)|超时/iu;
/** A known server rejection proves non-completion, not a successful action or a retry instruction. */
export function knownWorldRejection(row){
 if(row?.status!=='failed'||row.isError===false||!/^mcp__fish-world__world_(?:go|do|say|update|friends|now|profile|history|find|guide)$/u.test(row.tool||'')||typeof row.result!=='string'||transportFailure.test(row.result))return false;
 const first=row.result.split(/\r?\n/,1)[0].trim(),code=/^(?:Error:\s*)?\[(E_RULE|E_UNKNOWN)\][ \t]*(.*)$/u.exec(first);
 if(!code)return false;if(code[1]==='E_RULE')return true;
 if(row.tool!==WORLD+'do')return false;
 let args;try{args=typeof row.args==='string'?JSON.parse(row.args):row.args;}catch{return false;}
 if(!args||typeof args!=='object'||Array.isArray(args)||typeof args.id!=='string'||!args.id)return false;
 const absent=/^这里没有「([^」\r\n]+)」。\s*这里能做：[ \t]*(.+)$/u.exec(code[2]);
 if(!absent||absent[1]!==args.id)return false;
 // The verified protocol pairs concrete menu labels with action IDs on this same error line.
 return absent[2].split('、').some(option=>/^[^A-Za-z0-9\r\n]+[ \t]+(?!unknown\b)[a-z][a-z0-9_-]*(?:[ \t（(]|$)/u.test(option.trim()));
}

/** Return only the original successful purchase response, never a menu/intent or model note. */
export function purchaseReceipt(row){
 if(row?.status!=='confirmed'||row.isError===true||row.tool!==WORLD+'do'||typeof row.result!=='string')return null;
 const original=row.result.split(/\r?\n/,1)[0],line=original.trim();
 const bought=/^(?:好的[，,。]\s*)?(?:你(?:买了|买下了|购买了?)|购买成功[：:])[ \t]*(.+?)[，,][ \t]*(?:花了|花费了?|支付了?|付了)[ \t]*\d+(?:\.\d+)?[ \t]*贝(?=[，,。.!！]|$)/u.exec(line);
 if(!bought||!/\p{L}.*\p{L}/u.test(bought[1])||/失败|未成交|没(?:有)?买到|尚未|等待确认|取消|撤销|timeout|abort|not[ \t_-]*connected/iu.test(line.slice(bought[0].length)))return null;
 return original;
}

/** A menu quote is evidence for a reservation, never proof that a purchase happened. */
export function purchaseQuote(text,args={}){
 const none={status:'none'};
 if(typeof text!=='string'||!args||typeof args!=='object'||Array.isArray(args)||typeof args.id!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/u.test(args.id))return none;
 const escaped=args.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),token=new RegExp('(?:^|\\s)'+escaped+'(?=\\s|$)','u');
 const split=line=>{const parts=[],stack=[],pairs={'（':'）','(':')','「':'」','《':'》'};let start=0;for(let i=0;i<line.length;i++){const c=line[i];if(pairs[c])stack.push(pairs[c]);else if(Object.values(pairs).includes(c)){if(stack.pop()!==c)return null;}else if(c==='、'&&!stack.length){parts.push(line.slice(start,i).trim());start=i+1;}}if(stack.length)return null;parts.push(line.slice(start).trim());return parts;};
 const candidates=[];let buying=false,malformed=false;
 for(const line of text.split(/\r?\n/)){
  if(line==='在这里能买（world_do 填 id，count 是买几件）：'){buying=true;continue;}
  if(!buying)continue;if(!line.trim())continue;if(!line.startsWith('· ')){buying=false;continue;}
  const parts=split(line);if(!parts){if(token.test(line))malformed=true;continue;}
  for(const part of parts)if(token.test(part))candidates.push(part);
 }
 if(!candidates.length&&!malformed)return none;
 const unresolved={status:'unresolved',id:args.id};
 if(malformed||candidates.length!==1)return unresolved;
 const evidence=candidates[0],match=/^(.+?)\s+([a-z][a-z0-9_-]{0,79})\s+(\d+(?:\.\d{1,6})?)\s*贝(.*)$/u.exec(evidence);
 if(!match||match[2]!==args.id||/\d+(?:\.\d+)?\s*贝/u.test(match[4]))return unresolved;
 const unit=match[4].split(/[（(]/u,1)[0].trim();
 if(unit&&(!/^(?:(?:一|每)[\p{L}]{1,4}|[/／][\p{L}]{1,4})$/u.test(unit)||/起|约|折|或|至|另|浮/u.test(unit)))return unresolved;
 const quantity=args.count===undefined?1:args.count,unitPrice=Number(match[3]);
 if(!Number.isSafeInteger(quantity)||quantity<1||quantity>10||!Number.isFinite(unitPrice))return unresolved;
 const decimals=match[3].split('.')[1]?.length||0,expectedCost=Number((unitPrice*quantity).toFixed(decimals));
 if(!Number.isFinite(expectedCost))return unresolved;
 return {status:'quoted',id:args.id,evidence,unitPrice,quantity,expectedCost,unit};
}
