import { createServer } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { AurabotViewProvider } from '../adapters/aurabot/view-provider.js';
import { V5Runtime } from '../core/v5-runtime.js';
import { AurabotLiveReader } from '../adapters/aurabot/live-reader.js';
import { V5ModelService } from '../core/v5-model-service.js';
import { DeepSeekClient } from '../adapters/deepseek-client.js';
import { createMemorySeaHandler } from '../server/memory-sea-handler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export function createMemorySeaServer({output=resolve(root,'runtime-data/aurabot'),provider=new AurabotViewProvider(output),...options}={}) {
  return createServer(createMemorySeaHandler({provider,...options}));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.THINKSTAR_PORT ?? 4318);
  const runtime=new V5Runtime({file:resolve(root,'runtime-data/v5/memory.sqlite')});
  runtime.addScope({persona_id:'thinkstar:local',scope:'local:workbench'},'本地验证台');
  runtime.bootstrap(resolve(root,'runtime-data/aurabot'));
  const liveReader=new AurabotLiveReader(runtime,{scratch:resolve(root,'runtime-data/v5/captures')});
  const modelService=new V5ModelService(runtime,{client:new DeepSeekClient()});
  const server = createMemorySeaServer({runtime,liveReader,modelService});
  let background,maintenance;
  server.on('error', (error) => { console.error(`无法启动记忆系统：${error.message}`); control?.close(()=>{});runtime.close();process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {console.log(`Thinkstar V5 记忆系统 · Aurabot 只读 / Thinkstar 独立底座\nLocal: http://127.0.0.1:${server.address().port}\n按 Ctrl+C 停止。`);liveReader.start();const tick=()=>{runtime.processJobs();const busy=runtime.store.queuePending()>runtime.config.W5.backlog_threshold;background=setTimeout(tick,runtime.config.W5.background_interval_ms*(busy?1.5:1));background.unref();};background=setTimeout(tick,1500);maintenance=setInterval(()=>{try{runtime.maintenance();runtime.archive.maintain().catch(error=>console.error('归档暂缓：'+error.message));}catch(error){console.error('治理暂缓：'+error.message);}},60000);maintenance.unref();});
  let control,stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;clearTimeout(background);clearInterval(maintenance);liveReader.stop();control?.close();server.close(()=>{runtime.close();process.exit(0);});};
  const token=process.argv.find(value=>value.startsWith('--thinkstar-service='))?.split('=')[1];
  if(process.platform==='win32'&&/^[a-f0-9-]{36}$/.test(token??'')){
    control=createControlServer(socket=>{let text='';socket.setTimeout(3000,()=>socket.destroy());socket.on('data',chunk=>{text+=chunk.toString();if(text.length>100){socket.destroy();return;}if(text.includes('\n')){if(text.trim()===token){socket.end('stopping\n',stop);}else socket.destroy();}});socket.on('error',()=>{});});
    control.on('error',error=>console.error('后台控制入口不可用：'+error.code));control.listen('\\\\.\\pipe\\thinkstar-'+token);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal,stop);
}
