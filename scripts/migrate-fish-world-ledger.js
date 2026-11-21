import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {migrateLedger,applyMigration,rollbackMigration,sha256} from '../extensions/aurabot/fish-world/migration.mjs';
import {testRuntimeRoot} from './lib/test-workspace.js';

const repo=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const help='Fish-world private ledger migration (default: dry run).\n'
 +'  node scripts/migrate-fish-world-ledger.js --runtime <absolute fish-world/runtime.json> [--report-dir <absolute ignored report directory>]\n'
 +'  Add --apply --witness <absolute fresh gate witness.json> to apply; add --rollback --witness <...> for an unchanged-target rollback.\n'
 +'  Optional --backup-dir / --receipt-dir must stay inside the fish-world private data directory.\n'
 +'  --synthetic is accepted only for a managed test scratch. No host, QQ, world or model calls are made.\n'
 +'  Dry run reads the source ledger and writes only a private report. It never copies the ledger or changes its data.\n';
if(args.includes('--help')){console.log(help);process.exit(0);}
function need(condition,message){if(!condition)throw Error(message);}
function contained(root,target){const rel=path.relative(root,target);return !rel.startsWith('..')&&!path.isAbsolute(rel);}
function noLinks(target){for(let current=path.resolve(target);;current=path.dirname(current)){try{need(!fs.lstatSync(current).isSymbolicLink(),'路径含链接或目录重定向');}catch(error){if(error.code!=='ENOENT')throw error;}if(path.dirname(current)===current)break;}}
try{
  const flags=new Set(['--apply','--rollback','--dry-run','--synthetic']),values=new Set(['--runtime','--report-dir','--witness','--backup-dir','--receipt-dir']),options={};
  for(let i=0;i<args.length;i++){
    const arg=args[i];need(flags.has(arg)||values.has(arg),'未知参数：'+arg);need(!(arg in options),'重复参数：'+arg);
    if(flags.has(arg))options[arg]=true;
    else{need(args[i+1]&&!args[i+1].startsWith('--'),'参数缺少值：'+arg);options[arg]=args[++i];}
  }
  need(!(options['--apply']&&options['--rollback'])&&!((options['--apply']||options['--rollback'])&&options['--dry-run']),'迁移操作参数冲突');
  const absolute=name=>{const value=options[name];need(value&&path.isAbsolute(value),'需要绝对路径：'+name);return path.resolve(value);};
  const runtimePath=absolute('--runtime'),synthetic=options['--synthetic']===true;
  need(path.basename(runtimePath)==='runtime.json'&&path.basename(path.dirname(runtimePath))==='fish-world','仅接受鱼世界私有 runtime.json');
  noLinks(runtimePath);
  const allowedReports=synthetic?testRuntimeRoot(null):path.join(repo,'runtime-data','test-reports');
  need(allowedReports,'合成验证必须通过 scripts/run-tests.js 托管入口运行');
  if(synthetic)need(contained(allowedReports,runtimePath),'合成账本必须在本次受管 scratch 中');
  const reportDir=options['--report-dir']?absolute('--report-dir'):path.join(allowedReports,'fish-world-migration');
  need(contained(allowedReports,reportDir),'报告仅允许写入 ignored test-reports 或受管合成 scratch');
  noLinks(reportDir);
  const bytes=fs.readFileSync(runtimePath),raw=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  let report;
  if(options['--apply']||options['--rollback']){
    const witness=JSON.parse(fs.readFileSync(absolute('--witness'),'utf8'));
    const extra={};if(options['--backup-dir'])extra.backupDir=absolute('--backup-dir');if(options['--receipt-dir'])extra.receiptDir=absolute('--receipt-dir');
    const receipt=(options['--rollback']?rollbackMigration:applyMigration)({runtimePath,witness,synthetic,...extra});
    report={protocol:receipt.protocol,operationId:receipt.operationId,status:receipt.status,synthetic,sourcePath:runtimePath,receipt};
  }else{
    report=migrateLedger(raw,{sourceSha256:sha256(bytes),synthetic}).report;
    report.sourcePath=runtimePath;report.sourceUnchanged=sha256(fs.readFileSync(runtimePath))===sha256(bytes);
    need(report.sourceUnchanged,'预演期间源账本发生变化，请重试');
  }
  fs.mkdirSync(reportDir,{recursive:true,mode:0o700});noLinks(reportDir);
  const reportFile=path.join(reportDir,report.operationId+'-'+Date.now()+'-'+randomUUID().slice(0,8)+'.json');
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:report.status,synthetic,operationId:report.operationId,reportFile,sourceUnchanged:report.sourceUnchanged??null}));
}catch(error){console.error(error.message);process.exitCode=1;}
