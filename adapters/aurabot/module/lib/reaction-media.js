/** Only captions supplied by the host. No downloads, filenames, URLs or invented visual meaning. */
export function reactionMedia(msg){
  const result=[],seen=new Set();
  const add=(value,kind='sticker')=>{if(typeof value!=='string')return;const label=value.normalize('NFKC').trim().slice(0,120);if(!label||/https?:|file:|[\\/].{2,}|^[a-f0-9]{20,}$/i.test(label)||seen.has(label)||/^[\[\s]*(?:动画表情|图片|表情|动图)[\]\s]*$/.test(label))return;seen.add(label);result.push({kind,label,basis:'host_supplied_caption'});};
  for(const entry of [...(Array.isArray(msg?.stickers)?msg.stickers:[]),...(Array.isArray(msg?.images)?msg.images:[])])if(entry&&typeof entry==='object')add(entry.summary??entry.description??entry.label??entry.name);
  for(const segment of [msg?.raw?.message,msg?.raw?.segments].flatMap(x=>Array.isArray(x)?x:[]))if(['mface','face','image'].includes(segment?.type))add(segment.data?.summary??segment.data?.description??segment.data?.label,segment.type==='image'?'image':'sticker');
  return result.slice(0,4);
}
