// Keep Aurabot's normal parser, pacing, reply hooks and outbound policy in charge.
export async function sendShare(api,item,isCurrent){
  if(!isCurrent())return null;
  if(api.proactive?.available){
    const result=await api.proactive.submit({itemId:item.id,to:'private:'+item.owner,text:item.text,cause:{kind:'background'}});
    if(result?.state!=='unsupported')return result;
  }
  if(!isCurrent())return null;
  const options={isCurrent,sensitive:true,interim:true,userText:'【世界生活分享，非主人发言】'};
  // Installed v1.3's scoped extension wrapper reads deliver options at args[3].
  // Supply both positions; native/fixed wrappers use args[2]. No core patch needed.
  const result=await api.core.hub.deliver('private:'+item.owner,item.text,options,options);
  if(!result)return null;
  if(result.queued||result.message_id!==undefined)return result;
  const ids=result.message_ids||[];
  if(!result.failed&&!result.blocked&&ids.length)return {message_id:ids.at(-1),message_ids:ids};
  // Some bubbles may already have arrived. Never replay the whole share.
  return {state:'uncertain',message_ids:ids,reason:'分条投递未全部确认，不自动重发已投递内容'};
}
