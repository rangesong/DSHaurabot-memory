import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PURPOSE_ENGINE_PATCH, patchPurposeEngine } from '../scripts/lib/purpose-engine-patch.js';
import * as helpers from '../adapters/aurabot/native/purpose-evidence.js';

const now = new Date(2026, 10, 26, 12).getTime(), DAY = 86400000;
const host = process.env.AURABOT_SOURCE || 'D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq';
const baseline = process.env.AURABOT_PURPOSE_ENGINE_BASELINE || path.join(host, PURPOSE_ENGINE_PATCH.file);
const source = fs.existsSync(baseline) ? fs.readFileSync(baseline, 'utf8') : '';
const available = createHash('sha256').update(source).digest('hex') === PURPOSE_ENGINE_PATCH.before_sha256;
const active = { skip: available ? false : 'Exact pre-repair source required via AURABOT_PURPOSE_ENGINE_BASELINE' };
let engine, original;
if (available) {
  assert.ok(process.env.THINKSTAR_TEST_TMP, 'Use scripts/run-tests.js');
  const dir = fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP, 'purpose-engine-'));
  fs.copyFileSync(new URL('../adapters/aurabot/native/purpose-evidence.js', import.meta.url), path.join(dir, 'evidence.js'));
  fs.writeFileSync(path.join(dir, 'engine.mjs'), patchPurposeEngine(source, { version: PURPOSE_ENGINE_PATCH.version }).source);
  fs.writeFileSync(path.join(dir, 'original.mjs'), source);
  engine = await import(pathToFileURL(path.join(dir, 'engine.mjs')));
  original = await import(pathToFileURL(path.join(dir, 'original.mjs')));
}

const memory = (extra = {}) => ({ id: 'm-synthetic', text: '主人五月参加过电池展览会', importance: 80,
  createdAt: now - 180 * DAY, recordedAt: now - 180 * DAY, spokenAt: now - 180 * DAY,
  lastSeenAt: now, recalledAt: now, ...extra });
const message = (text, at = now - 3600000, extra = {}) => ({ id: `qq:private:10000001:${at}:owner`,
  source: 'qq', kind: 'owner', text, at, meta: { key: 'private:10000001' }, ...extra });
const sampleMaterial = message('我明天要参加一次技术面试');

test('purpose engine patch strictly gates version, baseline and patched bytes', active, () => {
  assert.throws(() => patchPurposeEngine(source, { version: 'other' }), /version/);
  assert.throws(() => patchPurposeEngine(null, { version: PURPOSE_ENGINE_PATCH.version }), /UTF-8/);
  assert.throws(() => patchPurposeEngine(source + '\n', { version: PURPOSE_ENGINE_PATCH.version }), /hash/);
  const once = patchPurposeEngine(source, { version: PURPOSE_ENGINE_PATCH.version });
  assert.equal(once.changed, true);
  const twice = patchPurposeEngine(once.source, { version: PURPOSE_ENGINE_PATCH.version });
  assert.equal(twice.changed, false);
  assert.equal(twice.source, once.source);
  assert.equal(createHash('sha256').update(once.source).digest('hex'), PURPOSE_ENGINE_PATCH.after_sha256);
  assert.throws(() => patchPurposeEngine(once.source + '\n', { version: PURPOSE_ENGINE_PATCH.version }), /hash/);
});

test('old recalled memories remain selectable without being labelled as happening now', active, () => {
  const result = engine.collectMaterials({ now, memoryRecords: [memory()] });
  assert.equal(result.items.length, 1);
  const m = result.items[0];
  assert.equal(m.provenance.recalledAt, now);
  assert.equal(m.provenance.spokenAt, now - 180 * DAY);
  assert.equal(m.provenance.eventAt, 0, 'utterance time is not event time');
  const line = engine.formatMaterialLine(m, now);
  assert.match(line, /历史记忆.*原话时间/);
  assert.doesNotMatch(line, /记忆·刚刚|记忆·今天/);
  assert.match(line, /事件发生时间:未知/);
});

test('expired memories can be recalled but carry expiry and historical provenance', active, () => {
  const m = engine.collectMaterials({ now, memoryRecords: [memory({ validUntil: now - DAY })] }).items[0];
  assert.equal(m.provenance.kind, 'historical');
  assert.equal(m.provenance.validUntil, now - DAY);
  assert.match(engine.formatMaterialLine(m, now), /有效截至/);
});

test('unchanged evidence does not renew an event goal; new evidence can renew it', active, () => {
  const materials = engine.collectMaterials({ now, memoryRecords: [memory()] }).items;
  const first = engine.formGoalHypotheses({ now, materials });
  const before = structuredClone(first.goals);
  const second = engine.formGoalHypotheses({ now: now + DAY, materials, goals: before, observations: first.observations });
  const same = second.goals.find(g => g.id === before[0].id);
  assert.equal(same.expiresAt, before[0].expiresAt);
  assert.equal(same.lastSeenAt, before[0].lastSeenAt);
  const updated = { ...materials[0], id: 'mem:m-new', at: now + DAY, text: materials[0].text };
  const third = engine.formGoalHypotheses({ now: now + DAY, materials: [updated], goals: before, observations: first.observations });
  assert.ok(third.goals.some(g => g.expiresAt > before[0].expiresAt));
});

test('purpose state v2 roundtrip retains provenance and existing schedule and learning', active, () => {
  const raw = engine.createPurposeState(now);
  raw.countToday = 3; raw.nextFireAt = now + DAY; raw.replyHours[12] = 7; raw.needFeedback = { care: { positive: 2, negative: 1, neutral: 0 } };
  const p = helpers.materialProvenance(sampleMaterial, now);
  raw.goals = [{ id: 'g-test', domain: 'care', owner: 'owner', object: { name: '面试', type: 'plan' }, intent: '想问面试结果',
    evidence: [{ id: sampleMaterial.id, text: sampleMaterial.text, source: 'qq', at: sampleMaterial.at, provenance: p }], provenance: p, expiresAt: now + DAY }];
  raw.pending = [{ id: 'p-test', text: '模型待续原文', draftText: '模型待续原文', groundedText: '想问面试结果',
    createdAt: now, expiresAt: now + DAY, provenance: { ...p, kind: 'model-thought' } }];
  const restored = engine.normalizePurposeState(JSON.parse(JSON.stringify(raw)), now);
  assert.equal(restored.version, 2);
  assert.equal(restored.countToday, 3); assert.equal(restored.nextFireAt, raw.nextFireAt); assert.deepEqual(restored.replyHours, raw.replyHours);
  assert.equal(restored.goals[0].evidence[0].provenance.refs[0].id, sampleMaterial.id);
  assert.equal(restored.pending[0].provenance.kind, 'model-thought');
  assert.equal(restored.pending[0].draftText, '模型待续原文');
  assert.equal(restored.pending[0].groundedText, '想问面试结果');
  assert.throws(() => engine.normalizePurposeState({ version: 99 }, now), /future purpose state/);
});

test('legacy pending is retained while unsafe event wording is not placed in the prompt', active, () => {
  const old = { version: 1, countToday: 2, pending: [{ id: 'p-legacy', text: '主人手术恢复得怎么样', kind: 'care', need: 'care', createdAt: now - DAY, expiresAt: now + DAY }] };
  const state = engine.normalizePurposeState(old, now);
  assert.equal(state.pending[0].text, old.pending[0].text);
  assert.equal(state.pending[0].provenance.kind, 'legacy-unverified');
  const picked = engine.selectPurpose({ now, pending: state.pending, random: () => 0 });
  assert.ok(picked.purpose); assert.equal(picked.fromPending, true);
  assert.doesNotMatch(picked.purpose.text, /手术/);
  const prompt = engine.buildPurposePrompt({ now, pending: state.pending, selected: picked.purpose, candidates: picked.candidates });
  assert.doesNotMatch(prompt, /手术/); assert.match(prompt, /普通陪伴|想和主人聊/);
});

test('expired pending never becomes a candidate, even before the first outcome cleanup', active, () => {
  const state = engine.normalizePurposeState({ pending: [{ id: 'p-old', text: '旧承诺要问结果', createdAt: now - 30 * DAY, expiresAt: now - DAY }] }, now);
  assert.equal(state.pending.length, 1);
  assert.equal(engine.selectPurpose({ now, pending: state.pending }).purpose, null);
});

test('an expired event goal retained for audit cannot be selected after its last attempt', active, () => {
  const goal = { id: 'g-expired', domain: 'care', owner: 'owner', intent: '想问旧面试结果', object: { name: '面试', type: 'plan' },
    evidence: [], confidence: 0.7, expiresAt: now - DAY, attempts: 1, lastActionAt: now - 3600000 };
  assert.equal(engine.pruneGoals([goal], now).length, 1, 'host keeps recently attempted goals for audit');
  assert.equal(engine.selectPurpose({ now, goals: [goal] }).purpose, null);
});

test('a model memo cannot introduce a new personal event as the next grounded topic', active, () => {
  const state = engine.createPurposeState(now);
  const planned = { id: 's', text: '想问面试结果', kind: 'care', need: 'care', action: 'ask', provenance: helpers.materialProvenance(sampleMaterial, now) };
  engine.applyPurposeOutcome(state, { now, outcome: 'sent', text: '合成发言', planned,
    memo: { purpose: '关心面试', status: '待续', followUp: '主人手术恢复得怎么样', kind: 'care', need: 'care' } });
  assert.equal(state.pending[0].text, '主人手术恢复得怎么样');
  assert.equal(state.pending[0].provenance.kind, 'model-thought');
  const picked = engine.selectPurpose({ now, pending: state.pending, random: () => 0 });
  assert.equal(picked.purpose.text, planned.text);
  assert.doesNotMatch(engine.buildPurposePrompt({ now, pending: state.pending, selected: picked.purpose }), /手术/);
});

test('normal companionship self wishes stay available without external events', active, () => {
  const pending = [{ id: 'p-wish', text: '想和主人一起玩会儿', createdAt: now, expiresAt: now + DAY }];
  const result = engine.selectPurpose({ now, pending, random: () => 0 });
  assert.equal(result.purpose.text, pending[0].text);
  assert.equal(result.purpose.provenance.kind, 'self-intent');
  const persona = engine.analyzePersona('我喜欢游戏，喜欢和主人一起聊天，也有自己的想法');
  assert.ok(engine.formGoalHypotheses({ now, persona }).goals.length);
});

test('assistant claims are not promoted into confirmed outside facts', () => {
  const p = helpers.materialProvenance({ id: 'self:1', source: 'qq', kind: 'self', at: now, text: '我已经替主人买好车票了' }, now);
  assert.equal(p.kind, 'assistant-claim');
  assert.equal(helpers.sourceReferences({ provenance: p }).length, 0);
  assert.match(helpers.groundingPrompt({ selected: { provenance: p } }), /不能证明外部事件发生或完成/);
  const wrapped = helpers.materialProvenance({ id: 'memory:self', source: 'memory', kind: 'memory', at: now,
    text: '我已经替主人买好车票了', source_roles: ['assistant'] }, now);
  assert.equal(wrapped.kind, 'assistant-claim');
  assert.equal(helpers.sourceReferences({ provenance: wrapped }, { includeHistorical: true }).length, 0);
});

test('a future or expired underlying reference cannot keep a pending as a current task', () => {
  for (const extra of [{ validUntil: now - DAY }, { validFrom: now + DAY }, { invalidAt: now - DAY }]) {
    const provenance = helpers.materialProvenance(message('我明天去面试', now - 30 * DAY, extra), now);
    const p = { id: 'p-expired-ref', text: '模型待续', groundedText: '主人今天要面试，问问怎么样了', expiresAt: now + DAY, provenance };
    const selected = helpers.pendingForSelection(p, now);
    assert.doesNotMatch(selected.text, /今天要面试/);
    assert.notEqual(selected.provenance.kind, 'source');
    assert.equal(helpers.sourceReferences(p, { now }).length, 0);
  }
  const historical = helpers.materialProvenance(message('我明天去面试', now - 30 * DAY, { validUntil: now - DAY }), now);
  assert.equal(helpers.pendingForSelection({ text: '待续', groundedText: '今天面试', expiresAt: now + DAY, provenance: historical }, now).provenance.kind, 'historical');
});

test('native diary and unknown model summaries keep their origin instead of becoming memory facts', active, () => {
  const diary = engine.collectMaterials({ now, memoryRecords: [memory({ source: 'diary' })] }).items[0];
  assert.equal(diary.originalSource, 'diary');
  assert.equal(diary.provenance.kind, 'assistant-claim');
  assert.equal(helpers.sourceReferences(diary, { now, includeHistorical: true }).length, 0);
  for (const source of ['auto', 'abstract', 'gist', 'unknown-model-summary']) {
    const m = engine.collectMaterials({ now, memoryRecords: [memory({ source })] }).items[0];
    assert.equal(m.provenance.kind, 'model-thought');
    assert.equal(helpers.sourceReferences(m, { now, includeHistorical: true }).length, 0);
    assert.equal(m.provenance.refs.length, 0);
  }
});

test('scheduling, daily limits and drive functions preserve unchanged host behavior', active, () => {
  const config = engine.normalizePurposeConfig({ enabled: true });
  const state = engine.createPurposeState(now);
  const legacy = original.createPurposeState(now);
  assert.equal(engine.planNextFire({ now, config, random: () => 0.5 }), original.planNextFire({ now, config, random: () => 0.5 }));
  assert.deepEqual(engine.evaluatePurposeTick({ now, config, state, env: {}, random: () => 0.5 }), original.evaluatePurposeTick({ now, config, state: legacy, env: {}, random: () => 0.5 }));
  assert.deepEqual(engine.satisfyDrives(state.drives, { need: 'connect', action: 'ask' }), original.satisfyDrives(legacy.drives, { need: 'connect', action: 'ask' }));
});

test('grounding rejection is terminal and does not reuse an old successful text or create a pending', active, () => {
  const state = engine.createPurposeState(now);
  state.lastText = '以前成功发送过的内容'; state.countToday = 2;
  state.goals = [{ id: 'g-reject', domain: 'care', intent: '合成目标', confidence: 0.6, attempts: 0, lastActionAt: 0 }];
  const config = engine.normalizePurposeConfig({ gapMinMs: 150 * 60000, gapMaxMs: 150 * 60000 });
  engine.applyPurposeOutcome(state, { now, config, outcome: 'grounding-rejected', text: '不得保存的未通过草稿',
    planned: { goalId: 'g-reject', text: '合成目标', need: 'care' },
    memo: { status: '待续', followUp: '不得留下的新待续', purpose: '未通过目的' }, random: () => 0.5 });
  assert.equal(state.lastOutcome, 'grounding-rejected'); assert.equal(state.lastText, '');
  assert.equal(state.history.at(-1).text, ''); assert.equal(state.pending.length, 0);
  assert.equal(state.goals[0].confidence, 0.6); assert.equal(state.goals[0].attempts, 0); assert.equal(state.goals[0].lastActionAt, 0);
  assert.equal(state.nextFireAt, engine.planNextFire({ now, config, lastRunAt: now, countToday: 2, replyHours: state.replyHours, replyWeekday: state.replyWeekday, random: () => 0.5 }));
  assert.equal(state.lastSentAt, 0);
});

test('grounding instructions remain present within the configured prompt limit', active, () => {
  const prompt = engine.buildPurposePrompt({ now, config: { ...engine.DEFAULT_PURPOSE_CONFIG, promptMaxChars: 4000 },
    contextBlocks: ['合成背景'.repeat(3000)], pending: [{ id: 'p', text: '想和主人一起玩会儿', expiresAt: now + DAY }] });
  assert.ok(prompt.length <= 4000); assert.match(prompt, /事实与时间边界/); assert.match(prompt, /原话\/记录\/召回时间不是事件发生时间/);
});
