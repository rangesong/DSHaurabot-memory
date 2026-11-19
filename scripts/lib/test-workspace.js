import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const markerName='.thinkstar-test-run.json';
const runPattern=/^run-[a-f0-9]{16}$/;
function requireSafe(condition,message){if(!condition)throw Error(message);}
function noLinks(root,target){
  const relative=path.relative(root,target);
  requireSafe(!relative.startsWith('..')&&!path.isAbsolute(relative),'Path outside test project');
  for(let current=target;;current=path.dirname(current)){
    try{requireSafe(!fs.lstatSync(current).isSymbolicLink(),'Test path contains a link');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(current===root)break;
  }
}
function paths(root){
  root=fs.realpathSync(root);
  const temp=path.join(root,'runtime-data/test-tmp'),reports=path.join(root,'runtime-data/test-reports');
  noLinks(root,temp);noLinks(root,reports);return {root,temp,reports};
}
function ownedRun(root,folder){
  const p=paths(root);folder=path.resolve(folder);
  requireSafe(path.dirname(folder)===p.temp&&runPattern.test(path.basename(folder)),'Unowned test directory');
  noLinks(p.root,folder);
  const markerPath=path.join(folder,markerName);noLinks(p.root,markerPath);
  const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
  requireSafe(marker.schema===1&&marker.owner==='thinkstar-synthetic-tests'&&marker.synthetic===true&&marker.project===p.root&&marker.id===path.basename(folder),'Invalid test ownership marker');
  requireSafe(marker.host===os.hostname()&&Number.isSafeInteger(marker.pid)&&marker.pid>0,'Unknown test owner');
  const scratch=path.join(folder,'scratch'),report=path.join(p.reports,marker.id);
  noLinks(p.root,scratch);noLinks(p.root,report);
  return {...p,folder,scratch,report,marker,markerPath};
}
export function createTestWorkspace(root,{label='test'}={}){
  const p=paths(root);fs.mkdirSync(p.temp,{recursive:true});fs.mkdirSync(p.reports,{recursive:true});
  // Keep paths short for SQLite on Windows, including nested cleanup regression fixtures.
  const id='run-'+randomUUID().replaceAll('-','').slice(0,16),folder=path.join(p.temp,id);
  fs.mkdirSync(folder);fs.mkdirSync(path.join(folder,'scratch'));
  const marker={schema:1,owner:'thinkstar-synthetic-tests',synthetic:true,project:p.root,id,label,host:os.hostname(),pid:process.pid,child_pid:null,created_at:Date.now(),state:'running'};
  fs.writeFileSync(path.join(folder,markerName),JSON.stringify(marker,null,2),{flag:'wx'});
  fs.mkdirSync(path.join(p.reports,id));return ownedRun(p.root,folder);
}
function inventory(folder){
  let files=0,bytes=0;
  function visit(current){const stat=fs.lstatSync(current);requireSafe(!stat.isSymbolicLink(),'Test scratch contains a link; retained for review');if(stat.isDirectory())for(const name of fs.readdirSync(current))visit(path.join(current,name));else{requireSafe(stat.isFile(),'Unknown test artifact type');files++;bytes+=stat.size;}}
  visit(folder);return {files,bytes};
}
export function cleanupTestWorkspace(root,folder){
  const run=ownedRun(root,folder);
  requireSafe((run.marker.pid===process.pid||!alive(run.marker.pid))&&!alive(run.marker.child_pid),'Test owner is still running');
  requireSafe(fs.readdirSync(run.folder).every(name=>[markerName,'scratch'].includes(name)),'Unexpected file beside scratch; retained for review');
  const contents=inventory(run.folder);
  // Keep the ownership marker until scratch is gone, so locked files can be retried safely.
  // Only this marked run's scratch is removed. Never scan *.sqlite or runtime-data broadly.
  noLinks(run.root,run.scratch);
  if(fs.existsSync(run.scratch))fs.rmSync(run.scratch,{recursive:true,force:false,maxRetries:3,retryDelay:100});
  fs.unlinkSync(run.markerPath);fs.rmdirSync(run.folder);
  return {state:'cleaned',...contents};
}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
export function recoverTestWorkspaces(root,{minAgeMs=3600000,now=Date.now()}={}){
  const p=paths(root),results=[];if(!fs.existsSync(p.temp))return results;
  for(const name of fs.readdirSync(p.temp)){
    if(!runPattern.test(name))continue;
    const folder=path.join(p.temp,name);
    try{
      const run=ownedRun(p.root,folder),m=run.marker;
      requireSafe(Number.isFinite(m.created_at)&&m.created_at<=now,'Invalid test timestamp');
      if(alive(m.pid)||alive(m.child_pid)||now-m.created_at<minAgeMs){results.push({id:name,state:'retained_active_or_recent'});continue;}
      // Record interrupted runs before removing their disposable data. Existing reports survive.
      fs.mkdirSync(run.report,{recursive:true});
      const summary=path.join(run.report,'summary.json');noLinks(run.root,summary);
      if(!fs.existsSync(summary))fs.writeFileSync(summary,JSON.stringify({id:name,label:m.label,status:'interrupted',synthetic:true},null,2),{flag:'wx'});
      const recoveryFile=path.join(run.report,'recovery.json');noLinks(run.root,recoveryFile);
      const cleanup=cleanupTestWorkspace(p.root,folder);
      fs.writeFileSync(recoveryFile,JSON.stringify({at:new Date(now).toISOString(),cleanup},null,2));
      results.push({id:name,...cleanup});
    }catch(error){results.push({id:name,state:'retained_for_review',reason:error.message});}
  }
  return results;
}
export function testRuntimeRoot(fallback){
  if(!process.env.THINKSTAR_TEST_TMP)return fallback;
  const scratch=path.resolve(process.env.THINKSTAR_TEST_TMP),run=ownedRun(projectRoot,path.dirname(scratch));
  requireSafe(scratch===run.scratch,'Invalid test scratch path');return scratch;
}
export function writeTestResult(value){
  const scratch=testRuntimeRoot(null);requireSafe(scratch,'Run this check through the managed test entry point');
  const run=ownedRun(projectRoot,path.dirname(scratch)),file=path.join(run.report,'result.json');noLinks(run.root,file);
  fs.writeFileSync(file,JSON.stringify(value,null,2));
}
export async function runManagedTest({root=projectRoot,label='test',args,env={}}){
  requireSafe(Array.isArray(args)&&args.every(arg=>typeof arg==='string'),'Test arguments required');
  const recovery=recoverTestWorkspaces(root),run=createTestWorkspace(root,{label}),log=path.join(run.report,'test.log');
  const fd=fs.openSync(log,'wx'),started=Date.now();let child,signal=null,outcome;
  function interrupt(name){
    signal=name;
    if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});
    else{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);timer.unref();}
  }
  const onInt=()=>interrupt('SIGINT'),onTerm=()=>interrupt('SIGTERM');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  try{
    outcome=await new Promise(resolve=>{
      child=spawn(process.execPath,args,{cwd:run.root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env,THINKSTAR_TEST_TMP:run.scratch,TEMP:run.scratch,TMP:run.scratch,TMPDIR:run.scratch,XDG_CACHE_HOME:path.join(run.scratch,'cache')}});
      if(child.pid){run.marker.child_pid=child.pid;fs.writeFileSync(run.markerPath,JSON.stringify(run.marker,null,2));}
      child.stdout.on('data',chunk=>{fs.writeSync(fd,chunk);process.stdout.write(chunk);});
      child.stderr.on('data',chunk=>{fs.writeSync(fd,chunk);process.stderr.write(chunk);});
      let spawnError=null;
      child.on('error',error=>{spawnError=error.message;});
      child.on('close',(code,childSignal)=>resolve({code:code??1,signal:childSignal,error:spawnError}));
    });
  }catch(error){outcome={code:1,error:error.message};}
  finally{fs.closeSync(fd);process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);}
  const code=signal?130:outcome.code,summary={schema:1,id:run.marker.id,label,started_at:new Date(started).toISOString(),synthetic:true,status:signal?'interrupted':code===0?'passed':'failed',exit_code:code,signal:signal??outcome.signal??null,error:outcome.error??null,duration_ms:Date.now()-started,recovery,cleanup:{state:'pending'}};
  const summaryFile=path.join(run.report,'summary.json');noLinks(run.root,summaryFile);fs.writeFileSync(summaryFile,JSON.stringify(summary,null,2));
  run.marker.state='finished';run.marker.child_pid=null;fs.writeFileSync(run.markerPath,JSON.stringify(run.marker,null,2));
  try{summary.cleanup=cleanupTestWorkspace(run.root,run.folder);}catch(error){summary.cleanup={state:'retained_for_review',reason:error.message};}
  fs.writeFileSync(summaryFile,JSON.stringify(summary,null,2));
  console.log(`Test report: ${run.report}\nTemporary artifacts: ${summary.cleanup.state}`);
  return {code:code||(summary.cleanup.state==='cleaned'?0:1),report:run.report,summary};
}
export async function managedScript(url,action){
  if(process.env.THINKSTAR_TEST_TMP){testRuntimeRoot(null);await action();return;}
  const script=fileURLToPath(url),result=await runManagedTest({label:path.basename(script,'.js'),args:[script,...process.argv.slice(2)]});
  process.exitCode=result.code;
}
