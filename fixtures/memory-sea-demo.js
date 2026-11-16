/** All people, conversation, outcomes and verification states below are synthetic. */
export const DEMO_CONTEXT = Object.freeze({ persona_id: 'demo-persona', scope: 'demo:memory-sea' });
const day1 = Date.parse('2026-11-10T09:00:00+08:00');
const day2 = Date.parse('2026-11-11T09:00:00+08:00');
const day3 = Date.parse('2026-11-12T09:00:00+08:00');
export const BEFORE_CORRECTION = day1 + 60_000;
export const CORRECTION_TIME = day2 + 1000;

function source(id, role, sequence, text, at, chat_id = 'demo:memory-sea') {
  return { id, role, sequence, text, occurred_at: at, time_precision: 'instant', chat_id,
    speaker_id: role === 'user' ? 'fictional-user' : role === 'tool' ? 'synthetic-benchmark' : 'synthetic-document' };
}

export const DEMO_STEPS = [
  { id: 'initial-source', at: day1, action: 'ingestSource', input: { record: source('src:initial', 'user', 1, '【合成原话】记忆海首版先显示 300 个内容节点。', day1) } },
  { id: 'experience', at: day1 + 1000, action: 'createMemory', input: { memory: {
    id: 'mem:experience', kind: 'experience', label: '一起制作记忆意识海', body: '合成经历：讨论显示规模，后续验证性能。尚无整个项目完成的结果。',
    source_refs: ['src:initial'], region_ids: ['M1', 'M2', 'M3', 'M4'], primary_region: 'M2', protection: 'P1',
  } } },
  { id: 'initial-decision', at: day1 + 2000, action: 'createMemory', input: { memory: {
    id: 'mem:node-budget', kind: 'claim', label: '首版先显示 300 个节点', body: '合成选择：首版目标为 300 个内容节点。',
    source_refs: ['src:initial'], region_ids: ['M1', 'M2', 'M4'], primary_region: 'M2', attributes: { node_budget: 300 }, protection: 'P0',
  } } },
  { id: 'derived-note', at: day1 + 3000, action: 'createMemory', input: { memory: {
    id: 'mem:budget-note', kind: 'knowledge', label: '关于首版规模的阶段性理解', body: '合成推断：当前先围绕 300 个节点组织示例。不是长期固定上限。',
    source_refs: ['src:initial'], basis_refs: [{ id: 'mem:node-budget', revision: 1 }], evidence_status: 'inferred',
  } } },
  { id: 'entity', at: day1 + 4000, action: 'createMemory', input: { memory: {
    id: 'mem:canvas', kind: 'entity', label: '记忆海的 Canvas 画布', body: '合成物件入口，关联项目、规模选择与优化方法。', source_refs: ['src:initial'],
  } } },
  { id: 'decision-in-experience', at: day1 + 5000, action: 'createRelation', input: { relation: {
    id: 'rel:decision-experience', from_id: 'mem:node-budget', to_id: 'mem:experience', relation_type: 'part_of', source_refs: ['src:initial'],
  } } },
  { id: 'canvas-in-experience', at: day1 + 6000, action: 'createRelation', input: { relation: {
    id: 'rel:canvas-experience', from_id: 'mem:experience', to_id: 'mem:canvas', relation_type: 'mentions', source_refs: ['src:initial'], strength: 0,
  } } },
  { id: 'correction-source', at: day2, action: 'ingestSource', input: { record: source('src:correction', 'user', 2, '【合成原话】改一下：首版先显示 200 个，300 个留到后续测试，测试还没做。', day2) } },
  { id: 'correct-decision', at: CORRECTION_TIME, action: 'reviseMemory', input: {
    id: 'mem:node-budget', expected_revision: 1, patch: { label: '首版先显示 200 个节点', body: '合成选择已纠正：当前先显示 200 个，300 个留待后续测试。', attributes: { node_budget: 200 } }, evidence_source_refs: ['src:correction'],
  } },
  { id: 'open-loop', at: day2 + 2000, action: 'createMemory', input: { memory: {
    id: 'mem:pending-test', kind: 'open_loop', label: '还没做：验证 300 个节点的性能', body: '合成事项：待首版稳定后测试更大规模；截止日期未知，结果未知。',
    source_refs: ['src:correction'], attributes: { status: 'waiting', next_step: '运行 300 节点样例并记录结果', due_at: null }, protection: 'P1',
  } } },
  { id: 'loop-in-experience', at: day2 + 3000, action: 'createRelation', input: { relation: {
    id: 'rel:pending-experience', from_id: 'mem:pending-test', to_id: 'mem:experience', relation_type: 'part_of', source_refs: ['src:correction'],
  } } },
  { id: 'document-source', at: day2 + 4000, action: 'ingestSource', input: { record: source('src:document', 'document', 1, '【合成参考资料】背景不变时，可以缓存静态背景；该建议本身不是本机性能测试结果。', day2 + 4000, 'demo:reference') } },
  { id: 'method', at: day2 + 5000, action: 'createMemory', input: { memory: {
    id: 'mem:cache-method', kind: 'method', label: '背景不变时缓存静态背景', body: '合成方法：绘制静态背景到离屏画布，变化时更新；先验证画面一致性与耗时。',
    source_refs: ['src:document'], attributes: { verification: 'untested', environment: '示例：静态背景', steps: ['缓存静态背景', '内容变化时重画', '对照画面与帧耗时'] },
  } } },
  { id: 'synthetic-result', at: day3, action: 'ingestSource', input: { record: source('src:result', 'tool', 1, '【完全合成的工具结果，并未运行实际性能测试】200 节点静态背景示例符合预设判据；300 节点未测试。', day3, 'demo:benchmark') } },
  { id: 'method-verification', at: day3 + 1000, action: 'reviseMemory', input: {
    id: 'mem:cache-method', expected_revision: 1,
    patch: { attributes: { verification: 'verified', environment: '合成环境：200 节点、背景静态', success_criteria: '合成判据：画面保持一致且帧耗时下降', outcome_source_refs: ['src:result'], untested_conditions: ['300 节点'] } },
    evidence_source_refs: ['src:document', 'src:result'],
  } },
  { id: 'method-use', at: day3 + 2000, action: 'createRelation', input: { relation: {
    id: 'rel:experience-method', from_id: 'mem:experience', to_id: 'mem:cache-method', relation_type: 'uses_method', source_refs: ['src:result'],
  } } },
];

export function applyDemo(service, { context = DEMO_CONTEXT, beforeStep = () => {}, through = Infinity } = {}) {
  const receipts = [];
  for (const step of DEMO_STEPS) {
    if (step.at > through) break;
    beforeStep(step);
    receipts.push(service[step.action](context, { command_id: `demo:${step.id}`, ...structuredClone(step.input) }));
  }
  return receipts;
}
