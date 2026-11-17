import { readFileSync,existsSync,statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {recallPresentation} from '../core/v5-recall-presentation.js';
import {consoleLayout,regionContents,diagnostics} from '../core/v5-console.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const defaultApp=resolve(root,'apps/memory-sea');
export const ATLAS_STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ...['main', 'provider', 'camera', 'layout', 'renderer','v5-main','v5-playback','v5-inspector-tools','v5-evaluation','v5-scene','v5-character','v5-spatial','v5-nebula','v5-camera','v5-brain','v5-glb-character'].map((name) => [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
...['three.module.js','three.core.js','GLTFLoader.js','BufferGeometryUtils.js','SkeletonUtils.js','RoomEnvironment.js'].map(name=>[`/vendor/three/${name}`,[`vendor/three/${name}`,'text/javascript; charset=utf-8']]),
  ['/shared/v5-memory-layout.js',[resolve(root,'shared/v5-memory-layout.js'),'text/javascript; charset=utf-8']],
  ['/assets/blue-maid-starry.glb',['assets/blue-maid-starry.glb','model/gltf-binary']],
  ['/assets/milky-way-background.jpg',['assets/milky-way-background.jpg','image/jpeg']],
]);

export const ATLAS_API_ROUTES=['trash-detail','trash-list','trash-restore','memory-discard','evaluation-run','evaluation-report','archive-export','context-report','fact-index','fact-write','fact-restore','archive-index','archive-read','archive-build','remember-source','person-memory','overview','model-status','graph','central-rules','directory','detail','events','trace','config','recalls','governance','model-check','semantic-extract','model-chat','model-review','model-display-ack','ingest','query','associate','principle','central-rule','deepen','revise','feedback','method-outcome','outcome','rollback-config','retention-plan','retention-apply','consolidate','live-poll'];

ATLAS_API_ROUTES.push('console-layout','console-region','console-impressions','console-activity','console-diagnostics','dialogue-feedback','dialogue-review','semantic-status','semantic-index','self-reflections','strategy-trials','strategy-revoke');

/** Standalone loopback checks remain enabled unless a host mounts EVERY route behind its panel gate. */
export function createMemorySeaHandler({app=defaultApp,provider=null,runtime=null,liveReader=null,modelService=null,evaluationService=null,basePath='',hosted=false,integration=null,assetOverrides={},assertActive=()=>{},assertMutationAllowed=()=>{},signal=null,transformHtml=value=>value}={}) {
  return async (req, res) => {
    const cancel=()=>req.destroy();signal?.addEventListener('abort',cancel,{once:true});
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors ${hosted ? "'self'" : "'none'"}` };
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      assertActive();
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosted && !allowedHosts.includes(req.headers.host)) return send(403, { error: 'LOCAL_ONLY', message: '只接受本机地址' });
      const base = `http://${req.headers.host}`;
      if (req.headers.origin && (hosted ? new URL(req.headers.origin).host!==req.headers.host : req.headers.origin!==base)) return send(403, { error: 'ORIGIN_DENIED', message: '不接受跨站读取' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'ORIGIN_DENIED', message: '不接受跨站读取' });
      const url = new URL(req.url, base);
      if(basePath){if(!url.pathname.startsWith(basePath+'/'))return send(404,{error:'NOT_FOUND',message:'无效挂载路径'});url.pathname=url.pathname.slice(basePath.length)||'/';}
      const p = url.searchParams;
      const number = (name, fallback) => p.has(name) ? Number(p.get(name)) : fallback;
      if(url.pathname.startsWith('/api/v5/')&&runtime){
        const route=url.pathname.slice(8),params=Object.fromEntries(p);for(const key of ['after','limit','offset','until'])if(p.has(key))params[key]=number(key,null);
        if(['GET','HEAD'].includes(req.method)){
          if(route==='console-layout')return send(200,consoleLayout(runtime));
          if(route==='console-region')return send(200,regionContents(runtime,params));
          if(route==='console-impressions')return send(200,runtime.dialogue.impressions(params));
          if(route==='console-activity')return send(200,runtime.dialogue.list({...params,category:'interaction'}));
          if(route==='console-diagnostics')return send(200,diagnostics(runtime,params));
          if(route==='dialogue-feedback')return send(200,runtime.dialogue.feedbackList(params));
          if(route==='strategy-trials')return send(200,runtime.strategyLearning.list(params));
          if(route==='self-reflections')return send(200,runtime.selfReflection.list(params));
          if(route==='semantic-status')return send(200,runtime.semantic.status());
          if(route==='overview'){const overview=runtime.overview(),model=modelService?.status()??null;return send(200,{...overview,capabilities:{...overview.capabilities,semantic_model:!!model?.configured,actual_model_context_window:integration?.context_window??'local_pool_estimate_no_external_host_adapter'},model,integration});}
          if(route==='model-status')return send(200,modelService?.status(p.get('refresh')==='1')??{configured:false});
          if(route==='context-report')return send(200,runtime.contextReport(params));
          if(route==='evaluation-report')return send(200,evaluationService?.report()??{available:false});
          if(route==='trash-detail')return send(200,runtime.trash.detail(params));
          if(route==='trash-list')return send(200,runtime.trashList(params));
          if(route==='fact-index')return send(200,runtime.factIndex(params));
          if(route==='archive-export')return send(200,runtime.archive.export(params));
          if(route==='archive-index')return send(200,runtime.archive.index(params));
          if(route==='archive-read')return send(200,runtime.archive.read(params));
          if(route==='person-memory')return send(200,runtime.personMemory(params));
          if(route==='graph')return send(200,runtime.graph(params));
          if(route==='central-rules')return send(200,runtime.centralRules(params));
          if(route==='directory')return send(200,runtime.directory(params));
          if(route==='detail')return send(200,runtime.detail(params));
          if(route==='events'){
            const scope=params.scope??'all';runtime.requireScope(scope,true);
            let events;
            if(p.get('tail')==='1'){
              const limit=Math.max(1,Math.min(200,Math.trunc(Number(params.limit)||80))),where=scope==='all'?'':' WHERE scope=?';
              events=runtime.store.sql('SELECT sequence,json FROM events'+where+' ORDER BY sequence DESC LIMIT ?').all(...(scope==='all'?[]:[scope]),limit).reverse().map(row=>({...JSON.parse(row.json),sequence:row.sequence}));
            }else events=runtime.store.events(params);
            return send(200,{events,cursor:runtime.store.eventCount()});
          }
          if(route==='trace')return send(200,runtime.trace(p.get('id')));
          if(route==='config')return send(200,runtime.getConfig());
          if(route==='recalls'){runtime.requireScope(params.scope??'all',true);return send(200,{items:runtime.store.recalls(params.scope??'all',20).map(recallPresentation)});}
          if(route==='governance')return send(200,runtime.governance());
        }else if(req.method==='POST'){
          if(!String(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON_REQUIRED',message:'仅接受本机 JSON 操作'});
          const chunks=[];let size=0;for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>4*1024*1024){send(413,{error:'TOO_LARGE',message:'单次输入超过 4MB'});return;}chunks.push(bytes);}const raw=Buffer.concat(chunks).toString('utf8');
          assertActive();
          let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'INVALID_JSON',message:'JSON 格式不正确'});}
          assertMutationAllowed();
          if(route==='strategy-revoke')return send(200,runtime.strategyLearning.revoke(body));
          if(route==='semantic-index')return send(200,await runtime.semantic.sync({...body,force:true}));
          if(route==='dialogue-review'){
            const source=runtime.ingest({scope:body.scope,text:'反馈含义核对：'+String(body.reason??''),provenance:{kind:'explicit_feedback',speaker_id:'local:operator'}});
            return send(200,runtime.dialogue.correct({...body,source_id:source.source_id}));
          }
          if(route==='evaluation-run'&&evaluationService)return send(200,await evaluationService.run(body));
          if(route==='model-check'&&modelService){modelService.status(true);const result=await modelService.client.json('Return JSON only: {"status":"ready"}. This is a connection test; no private memory is provided.',{test:'Thinkstar connection check'},{maxTokens:32});return send(200,{...modelService.status(),usage:result.usage});}
          if(route==='semantic-extract'&&modelService)return send(200,await modelService.extract(body));
          if(route==='model-chat'&&modelService)return send(200,await modelService.chat(body));
          if(route==='model-review'&&modelService)return send(200,modelService.accept(body));
          if(route==='model-display-ack'&&modelService)return send(200,modelService.acknowledge(body));
          if(route==='trash-restore')return send(200,runtime.restoreTrash(body));
          if(route==='memory-discard')return send(200,runtime.discardMemory(body));
          if(route==='fact-write')return send(200,runtime.writeFact(body));
          if(route==='fact-restore')return send(200,runtime.restoreFact(body));
          if(route==='archive-build')return send(200,await runtime.archive.build({...body,use_model:body.use_model===true,client:modelService?.client}));
          if(route==='remember-source')return send(200,runtime.rememberSource(body));
          if(route==='ingest'){const receipt=runtime.ingest({...body,process:false});send(200,receipt);if(!hosted)setImmediate(()=>runtime.processJobs({scope:receipt.scope}));return;}
          if(route==='query')return send(200,runtime.query(body));
          if(route==='associate')return send(200,runtime.associate(body));
          if(route==='principle')return send(200,runtime.proposeCentralRule(body));
          if(route==='central-rule')return send(200,runtime.writeCentralRule(body));
          if(route==='deepen')return send(200,runtime.deepen(body));
          if(route==='revise')return send(200,runtime.revise(body));
          if(route==='feedback')return send(200,runtime.feedback(body));
          if(route==='method-outcome')return send(200,runtime.methodResult(body));
          if(route==='outcome')return send(200,runtime.outcome(body));
          if(route==='config'){const result=runtime.updateConfig(body);runtime.dialogue.activity({category:'config',title:'修改了'+String(body.region)+'参数',detail:{region:body.region,values:body.values,version:result.version}});return send(200,result);}
          if(route==='rollback-config'){const result=runtime.rollbackConfig(body);runtime.dialogue.activity({category:'config',title:'回退了参数配置',detail:{restored_version:body.version,version:result.version}});return send(200,result);}
          if(route==='retention-plan')return send(200,runtime.retentionPlan(body));
          if(route==='retention-apply')return send(200,runtime.applyRetention(body));
          if(route==='consolidate')return send(200,runtime.processJobs({scope:body.scope==='all'?null:body.scope??null}));
          if(route==='live-poll')return send(200,liveReader?await liveReader.poll():{status:'not_connected'});
        }else return send(405,{error:'METHOD_NOT_ALLOWED',message:'操作方式不支持'});
        return send(404,{error:'NOT_FOUND',message:'接口不存在'});
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, { error: 'READ_ONLY', message: 'Aurabot 与旧接口保持只读' });
      if (provider && url.pathname === '/api/overview') return send(200, provider.overview());
      if (provider && url.pathname === '/api/graph') return send(200, provider.graph({ scope: p.get('scope') ?? 'all', region: p.get('region'), q: p.get('q') ?? '',
        until: number('until', null), limit: number('limit', 280), focus_context: p.get('focus_context'), focus_id: p.get('focus_id') }));
      if (provider && url.pathname === '/api/detail') return send(200, provider.detail({ scope: p.get('scope'), id: p.get('id'), revision: p.get('revision'), until: number('until', null) }));
      if (provider && url.pathname === '/api/sources') return send(200, provider.sources({ scope: p.get('scope'), id: p.get('id'), revision: p.get('revision'),
        offset: number('offset', 0), limit: number('limit', 20), until: number('until', null) }));
      if (provider && url.pathname === '/api/recalls') return send(200, provider.recalls({ scope: p.get('scope') ?? 'all', limit: number('limit', 8) }));
      const file = ATLAS_STATIC.get(url.pathname);
      if (!file) return send(404, { error: 'NOT_FOUND', message: '没有这个页面或数据接口' });
      const assetFile=assetOverrides[url.pathname]??resolve(app,file[0]);
      if(!existsSync(assetFile))return send(404,{error:'ASSET_NOT_INSTALLED',message:'此资源尚未安装，请按资源包说明安装。'});
      if(url.pathname==='/assets/blue-maid-starry.glb'){
        const info=statSync(assetFile);headers['Cache-Control']='private, max-age=86400';headers.ETag=`W/"${info.size}-${info.mtimeMs}"`;
        if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();return;}
        if(req.method==='HEAD')return send(200,'',file[1]);
      }
      let content=readFileSync(assetFile);
      if(file[1].startsWith('text/html')){
        content=content.toString('utf8');
        if(basePath)content=content.replace(/(src|href)="\/(?!\/)/g,`$1="${basePath}/`);
        content=transformHtml(content);
      }else if(file[1].startsWith('text/javascript'))content=content.toString('utf8').replaceAll('../../../shared/','../shared/');
      return send(200,content,file[1]);
    } catch (error) {
      const status = error.code === 'NOT_FOUND' ? 404 : ['IMPORT_CHANGED','REVISION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(error.code) ? 409 : error.code?.startsWith('MODEL') ? 502 : error.code?.startsWith('INVALID')||['PROTECTED_MEMORY','CAPACITY_EXCEEDED'].includes(error.code) ? 400 : 503;
      return send(status, { error: error.code ?? 'DATA_UNAVAILABLE', message: status === 503 ? (req.url.includes('/api/v5/')?'V5 本机操作未完成，现有内容保留。':'本机数据暂不可用，请先运行 Aurabot 只读导入。') : error.message,run_id:error.run_id??null,input_receipt:error.input_receipt??null });
    }finally{signal?.removeEventListener('abort',cancel);}
  };
}
