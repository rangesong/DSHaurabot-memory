import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync,writeFileSync,readFileSync,unlinkSync,openSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.THINKSTAR_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('THINKSTAR_PORT 必须是 1–65535 之间的端口。');
const url = `http://127.0.0.1:${port}/`;

async function isReady() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok && /<title>Thinkstar[^<]*<\/title>/.test(await response.text());
  } catch { return false; }
}

function openPage() {
  if(process.env.THINKSTAR_OPEN_BROWSER==='0')return;
  console.log(`正在打开星图：${url}`);
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`请在浏览器打开：${url}`));
  browser.unref();
}

if (await isReady()) {
  console.log('星图服务已运行。');
  openPage();
} else {
  const directory=fileURLToPath(new URL('../runtime-data/service/',import.meta.url));mkdirSync(directory,{recursive:true});
  const token=randomUUID(),script=fileURLToPath(new URL('./serve-memory-sea.js',import.meta.url)),record=join(directory,`${port}.json`);
  const background=process.env.THINKSTAR_BACKGROUND==='1';
  const serverLog=join(directory,`server-${port}-${token}.log`),logFd=background?openSync(serverLog,'a'):null;
  let server;
  try{server=spawn(process.execPath,[script,`--thinkstar-service=${token}`],{stdio:background?['ignore',logFd,logFd]:'inherit',windowsHide:true,detached:background});}
  finally{if(logFd!==null)closeSync(logFd);}
  if(server.pid)writeFileSync(record,JSON.stringify({pid:server.pid,token,script,executable:process.execPath,port,...(background?{log:serverLog}:{})}));
  const clearRecord=()=>{try{if(JSON.parse(readFileSync(record,'utf8')).token===token)unlinkSync(record);}catch{}};
  let ended = false;
  server.on('error', error => { ended = true; console.error(`启动失败：${error.message}`); process.exitCode = 1; });
  server.on('exit', code => { ended = true;clearRecord();process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!ended) server.kill(signal); });
  let opened = false;
  for (let attempt = 0; attempt < 40 && !ended; attempt++) {
    if (await isReady()) { openPage(); opened = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!opened && !ended) console.log(`页面启动较慢，请稍后打开：${url}`);
  if(background&&!ended)server.unref();
}
