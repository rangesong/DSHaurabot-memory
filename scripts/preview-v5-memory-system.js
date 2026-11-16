// Disposable, in-memory visual verification. Never reads Aurabot or calls a model.
import { createInterface } from 'node:readline';
import { V5Runtime } from '../core/v5-runtime.js';
import { DAY } from '../core/v5-config.js';
import { createMemorySeaServer } from './serve-memory-sea.js';

const present=Date.now();let clock=present-400*DAY;
const runtime=new V5Runtime({clock:()=>clock}),scope=runtime.addScope({persona_id:'synthetic-memory-system',scope:'local:synthetic-memory-branches'},'合成验收 · 记忆分叉').id;
const ingest=text=>runtime.ingest({scope,text,process:true});
const expendable=ingest('你好');
clock+=5*DAY;runtime.applyRetention({plan_id:runtime.retentionPlan({scope}).id});
clock+=60*DAY;runtime.applyRetention({plan_id:runtime.retentionPlan({scope}).id});
clock=present-100*DAY;for(let i=0;i<12;i++)ingest('这是合成背景记录。中间包含可被整理的普通细节。'.repeat(12));
clock=present-8*DAY;
for(let i=0;i<12;i++)ingest('合成温存记录，用于查看无损保存的完整来处。');
for(let i=0;i<10;i++)ingest('请记住：合成验收的重要原话和版本必须完整保留。');
for(const [region,param,value]of [['W1','write_detail',1],['W2','candidate_limit',20],['W3','expression_gain',.2],['W4','detail_level',.2],['W5','learning_rate',.8]]){
  const source=ingest(`当合成校验时，以后采用${region}的合成条件准则。`),m=runtime.store.all(scope).find(m=>m.kind==='pattern'&&m.source_refs.includes(source.source_id));
  runtime.writeCentralRule({scope,id:m.id,expected_revision:m.revision,region,param,value,condition:'合成校验',reason:'这是隔离验收数据，验证参数流转'});
}
ingest('当我疲惫时，以后请简洁回应，不要一直追问。');
clock=present;
const plan=runtime.retentionPlan({scope});plan.items=plan.items.filter(item=>!runtime.memory(item.id).source_refs.includes(expendable.source_id));runtime.store.setMeta('plan:'+plan.id,plan);runtime.applyRetention({plan_id:plan.id});
for(let i=0;i<12;i++)ingest('合成近期原话：这里的内容完整保留在底座中。');
ingest('提醒我：2099-01-01 09:00 检查合成验收报告。');
runtime.live.status='合成验收 · 不接入 Aurabot';
const server=createMemorySeaServer({runtime}),input=createInterface({input:process.stdin});
server.listen(4320,'127.0.0.1',()=>console.log('合成验收：http://127.0.0.1:4320\n输入 forget 使旧寒暄真实遗忘并播放流星；status 查看数量。Ctrl+C 退出，数据随之销毁。'));
input.on('line',line=>{if(line.trim()==='forget'){const result=runtime.applyRetention({plan_id:runtime.retentionPlan({scope}).id});console.log(JSON.stringify({forgotten:result.forgotten.length,run_id:result.run_id}));}if(line.trim()==='status')console.log(JSON.stringify(runtime.overview().layers.map(layer=>({name:layer.name,count:layer.count}))));});
process.on('SIGINT',()=>{input.close();server.close(()=>{runtime.close();process.exit(0);});});
