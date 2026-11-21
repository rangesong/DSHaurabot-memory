export function historyPage(l,args={}){
 const offset=Math.max(0,Number(args.offset)||0),part=Math.max(0,Number(args.part)||0),limit=10;
 let rows;
 if(args.kind==='plans')rows=l.plans;
 else if(args.kind==='proposals')rows=l.planProposals||[];
 else if(args.kind==='events')rows=l.queue;
 else if(args.kind==='journal')rows=l.journal;
 else rows=l.contextWindow?.windows||[];
 if(args.id)rows=rows.filter(r=>r.id===args.id);
 const selected=rows.slice(offset,offset+limit),raw=JSON.stringify(selected),text=raw.slice(part*1500,(part+1)*1500);
 return {kind:args.kind||'windows',offset,part,text,nextPart:(part+1)*1500<raw.length?part+1:null,
  nextOffset:offset+limit<rows.length?offset+limit:null,reference:{kind:args.kind||'windows',id:args.id||null,offset},historyOnly:true};
}
export function boundedRaw(value,args){
 const raw=JSON.stringify(value),part=Math.max(0,Number(args.part)||0);
 return {sessionId:args.sessionId,seq:args.seq,part,text:raw.slice(part*1500,(part+1)*1500),nextPart:(part+1)*1500<raw.length?part+1:null,historyOnly:true};
}
