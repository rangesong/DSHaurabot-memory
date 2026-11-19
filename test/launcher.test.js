import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

test('hidden launcher can reopen while the detached service keeps its own log',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),runtime=testRuntimeRoot(join(root,'runtime-data'));mkdirSync(runtime,{recursive:true});
  const folder=mkdtempSync(join(runtime,'launcher regression-'));mkdirSync(join(folder,'scripts'));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  for(const file of ['launch-memory-sea.js','launch-hidden.cmd','run-node-task.cmd'])copyFileSync(join(root,'scripts',file),join(folder,'scripts',file));
  writeFileSync(join(folder,'scripts/serve-memory-sea.js'),`import {createServer} from 'node:http';
const token=process.argv.find(value=>value.startsWith('--thinkstar-service=')).split('=')[1];
const server=createServer((req,res)=>{if(req.method==='POST'&&req.url==='/stop'&&req.headers['x-test-token']===token){res.end('stopped');server.close(()=>process.exit(0));}else{res.end('<title>Thinkstar synthetic launcher</title>');}});
server.listen(Number(process.env.THINKSTAR_PORT),'127.0.0.1',()=>console.log('synthetic service started'));
`);
  const invoke=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${join(folder,'scripts/launch-hidden.cmd')}""`],{cwd:folder,env:{...process.env,THINKSTAR_PORT:String(port),THINKSTAR_LAUNCH_LOG:''},windowsHide:true,windowsVerbatimArguments:true,stdio:'ignore'});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Hidden launcher exited '+code)));
  });
  const record=join(folder,`runtime-data/service/${port}.json`);
  try{
    await invoke();const first=JSON.parse(readFileSync(record,'utf8'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
    const startup=readFileSync(join(folder,'runtime-data/service/latest-startup.txt'),'utf8').trim();
    writeFileSync(join(folder,startup),'startup log is no longer owned by the server');
    await invoke();const second=JSON.parse(readFileSync(record,'utf8'));
    assert.equal(second.pid,first.pid);assert.equal(second.token,first.token);
    assert.notEqual(readFileSync(join(folder,'runtime-data/service/latest-startup.txt'),'utf8').trim(),startup);
    assert.ok(basename(first.log).startsWith(`server-${port}-`));
    assert.equal(readdirSync(join(folder,'runtime-data/service')).filter(name=>/^startup-.*\.log$/.test(name)).length,2);
  }finally{
    try{const saved=JSON.parse(readFileSync(record,'utf8'));await fetch(`http://127.0.0.1:${port}/stop`,{method:'POST',headers:{'x-test-token':saved.token},signal:AbortSignal.timeout(3000)});for(let i=0;i<20;i++){try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(100)});await new Promise(resolve=>setTimeout(resolve,50));}catch{break;}}}catch{}
    assert.equal(dirname(resolve(folder)),resolve(runtime));assert.ok(basename(folder).startsWith('launcher regression-'));rmSync(folder,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  }
});
