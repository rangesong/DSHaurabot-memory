// Disposable visual QA. Does not open, import or contact Aurabot or a model.
import { createInterface } from 'node:readline';
import { V5Runtime } from '../core/v5-runtime.js';
import { DAY } from '../core/v5-config.js';
import { createMemorySeaServer } from './serve-memory-sea.js';

let clock = Date.now() - 400 * DAY;
const runtime = new V5Runtime({ clock: () => clock });
const context = { persona_id: 'synthetic-visual-qa', scope: 'local:disposable-visual-qa' };
const receipt = runtime.ingest({ context, text: '你好', process: true });
clock = Date.now();
runtime.ingest({ scope: receipt.scope, text: '请记住：这是独立合成验收环境，不含 Aurabot 数据。', process: true });
const server = createMemorySeaServer({ runtime });
server.listen(4320, '127.0.0.1', () => {
  console.log('Disposable synthetic V5 visual fixture: http://127.0.0.1:4320');
  console.log('Type forget to apply real retention to the old synthetic greeting; Ctrl+C exits.');
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.trim() !== 'forget') return;
  const plan = runtime.retentionPlan({ scope: receipt.scope });
  const result = runtime.applyRetention({ plan_id: plan.id });
  console.log(JSON.stringify({ forgotten: result.forgotten.length, run_id: result.run_id }));
});
process.on('SIGINT', () => { input.close(); server.close(() => { runtime.close(); process.exit(0); }); });
