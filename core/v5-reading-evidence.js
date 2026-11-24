const marker=text=>/^(?:✓|✔|ok|success|完成)[.!。]?$/i.test(String(text??'').trim());
const failureText=text=>/^(?:✗|×|Error\b|没成功|未读取到正文|未读到|未完成)/i.test(String(text??'').trim());
export function usefulReadingText(text){
  const value=String(text??'').trim();
  return value.length>2&&!marker(value)&&!failureText(value)&&!/^\[(?:楼主主要发布图片.*未识别图片内容。?|楼主没有可读取的文字正文。?)\]$/.test(value);
}
/** Classify visible reading output; a success marker is not readable source material. */
export function readingReceipt(message,failed=false){
  const raw=(message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
  let value;try{value=JSON.parse(raw);}catch{}
  const failure=failed||message?.isError||value?.ok===false||failureText(raw)||failureText(value?.message);
  const rows=items=>Array.isArray(items)?items:[];
  const payload=value&&typeof value==='object'?[value.text,value.content,value.body?.content,...rows(value.sources??value.items).map(item=>item?.snippet??item?.description),...rows(value.posts).map(item=>typeof item==='string'?item:item?.text??item?.content)].some(item=>typeof item==='string'&&usefulReadingText(item)):false;
  const empty=!usefulReadingText(raw)||value?.read_evidence===false||value&&typeof value==='object'&&!payload;
  return {status:failure?'failed':empty?'no_evidence':'result_observed',observation:raw.slice(0,1800)};
}
