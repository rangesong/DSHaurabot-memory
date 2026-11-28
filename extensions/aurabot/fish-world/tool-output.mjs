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
