import {REGIONS,LAYERS,PARAMS,DEFAULT_CONFIG} from './v5-config.js';

export function consoleLayout(r){
  return {groups:[...['memory','work'].map(domain=>({id:domain,name:domain==='work'?'工作中枢':'记忆组织',regions:REGIONS.filter(x=>x.domain===domain)})),
    {id:'store',name:'记忆系统',regions:LAYERS.map(layer=>({...layer,id:'L:'+layer.id,function:layer.description,parameter_region:'U'}))}],
    scopes:r.store.scopes(),config:r.getConfig(),defaults:DEFAULT_CONFIG,parameters:PARAMS};
}
export function regionContents(r,{scope='all',region,limit=20,offset=0}={}){
  r.requireScope(scope,true);limit=Math.min(50,Math.max(1,Number(limit)||20));offset=Math.max(0,Number(offset)||0);
  const layer=String(region).startsWith('L:')?String(region).slice(2):null,where=["layer!='forgotten' AND kind!='archive_chunk' AND validity='current'"],args=[];
  if(scope!=='all'){where.push('scope=?');args.push(scope);}if(layer){if(!LAYERS.some(l=>l.id===layer))throw Object.assign(Error('星区不存在'),{code:'INVALID_REGION'});where.push('layer=?');args.push(layer);}
  else if(/^M[1-4]$/.test(region)){where.push('EXISTS(SELECT 1 FROM json_each(memories.json,\'$.region_ids\') WHERE value=?)');args.push(region);}
  else if(region==='W3'||region==='W4')where.push("kind='pattern'");else if(region==='W2')where.push("kind IN ('intent','claim','pattern')");
  const rows=r.store.sql('SELECT json FROM memories WHERE '+where.join(' AND ')+' ORDER BY updated DESC LIMIT ? OFFSET ?').all(...args,limit+1,offset).map(row=>r.store.decodeMemory(row.json));
  return {items:rows.slice(0,limit).map(m=>({id:m.id,scope:m.scope,label:m.label,kind:m.kind,layer:m.layer,review:m.review,updated_at:m.updated_at,source_count:m.source_refs.length})),has_more:rows.length>limit,next_offset:offset+Math.min(limit,rows.length)};
}
export function diagnostics(r,{scope='all',category=null,limit=30,offset=0}={}){
  r.requireScope(scope,true);limit=Math.min(80,Math.max(1,Number(limit)||30));offset=Math.max(0,Number(offset)||0);
  const aArgs=[],eArgs=[],activity=["category!='interaction'"],events=[];
  if(scope!=='all'){activity.push('scope=?');aArgs.push(scope);events.push('scope=?');eArgs.push(scope);}if(category){activity.push('category=?');aArgs.push(category);if(category!=='memory')events.push('0');}
  const rows=r.store.sql(`SELECT * FROM (SELECT id,created,json,'activity' origin FROM module_activity WHERE ${activity.join(' AND ')} UNION ALL SELECT id,created,json,'memory' origin FROM events${events.length?' WHERE '+events.join(' AND '):''}) ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`).all(...aArgs,...eArgs,limit+1,offset);
  return {items:rows.slice(0,limit).map(row=>row.origin==='activity'?JSON.parse(row.json):(()=>{const event=JSON.parse(row.json);return {id:row.id,scope:event.scope,created_at:event.timestamp,category:'memory',title:event.operation,status:event.result_status,detail:{run_id:event.run_id,from:event.source_region,to:event.target_region,reason:event.omitted_reason,duration_ms:event.duration_ms},source_refs:[]};})()),has_more:rows.length>limit,next_offset:offset+Math.min(limit,rows.length),semantic:r.semantic.status(),maintenance:r.maintenanceWindow(),validation:r.store.meta('upgrade-comparison-report',null),feedback_validation:r.store.meta('feedback-repair-report',null)};
}
