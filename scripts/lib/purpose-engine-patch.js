import { createHash } from 'node:crypto';

export const PURPOSE_ENGINE_PATCH = Object.freeze({
  marker: 'thinkstar-purpose-evidence-v2', version: '1.3.0-beta.1', file: 'src/purpose/engine.js',
  before_sha256: '6c1ebdd587f1001f4818929f9693b94fe6ba84eb757a777cf3e26502462b6759',
  after_sha256: 'cc8847d99a4b1c907b9e514f5647b002f264b9b52cecf39a19c178564e550f28', helper: 'src/purpose/evidence.js',
});
const sha = value => createHash('sha256').update(value).digest('hex');
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Purpose engine patch anchor is not unique: ' + before.slice(0, 80));
  return source.replace(before, after);
}

function transform(source) {
  let next = source;
  next = once(next, 'export const PURPOSE_STATE_VERSION = 1;', 'export const PURPOSE_STATE_VERSION = 2;');
  next = once(next, '主人刚提到「', '主人之前提到「');
  // Metadata on evidence must survive both new-goal creation and normalization.
  next = once(next, "    at: Number(event.material?.at) || now,\n  }];", "    at: Number(event.material?.at) || now,\n    provenance: materialProvenance(event.material, now),\n  }];");
  const wrappers = ['collectMaterials', 'normalizePurposeState', 'normalizeGoals', 'formGoalHypotheses', 'minePurposeSeeds', 'selectPurpose', 'applyPurposeOutcome', 'buildPurposePrompt', 'formatMaterialLine', 'goalToCandidate'];
  for (const name of wrappers) next = once(next, `export function ${name}(`, `function original${name[0].toUpperCase() + name.slice(1)}(`);
  next = `// ${PURPOSE_ENGINE_PATCH.marker}\nimport { groundCollectedMaterials, restoreEvidenceMetadata, restorePurposeState, groundGoals, groundSeeds, pendingForSelection, groundSelection, outcomeProvenance, preparePurposePrompt, groundingPrompt, limitPurposePrompt, materialTimeNote, materialProvenance, candidateProvenance } from './evidence.js';\n` + next;
  return next + `\n// Purpose-only wrappers retain host APIs and keep provenance out of other modules.\nexport function collectMaterials(options = {}) { return groundCollectedMaterials(originalCollectMaterials(options), options); }
export function normalizePurposeState(raw, now = Date.now()) { return restorePurposeState(originalNormalizePurposeState(raw, now), raw, now); }
export function normalizeGoals(goals, now = Date.now()) {
  return originalNormalizeGoals(goals, now).map(goal => restoreEvidenceMetadata(goal, (goals || []).find(raw => raw?.id === goal.id) || goal));
}
export function formGoalHypotheses(options = {}) { return groundGoals(originalFormGoalHypotheses(options), options); }
export function minePurposeSeeds(options = {}) { return groundSeeds(originalMinePurposeSeeds(options), options.materials, options.now); }
export function selectPurpose(options = {}) {
  const now = options.now ?? Date.now();
  const safe = { ...options,
    goals: (options.goals || []).filter(g => g && (!Number(g.expiresAt) || Number(g.expiresAt) > now)),
    pending: (options.pending || []).map(p => pendingForSelection(p, now)).filter(Boolean) };
  return groundSelection(originalSelectPurpose(safe), safe);
}
export function applyPurposeOutcome(state, options = {}) {
  const now = options.now ?? Date.now();
  const rejected = options.outcome === 'grounding-rejected';
  const actual = rejected ? { ...options, now, memo: null, text: '' } : { ...options, now };
  const result = outcomeProvenance(originalApplyPurposeOutcome(state, actual), actual);
  if (rejected) {
    result.lastText = '';
    if (result.history.length) result.history[result.history.length - 1].text = '';
    result.nextFireAt = planNextFire({ now, config: options.config || DEFAULT_PURPOSE_CONFIG, lastRunAt: now, countToday: result.countToday, replyHours: result.replyHours, replyWeekday: result.replyWeekday, random: options.random || Math.random });
  }
  return result;
}
export function buildPurposePrompt(options = {}) {
  const safe = preparePurposePrompt(options);
  return limitPurposePrompt(originalBuildPurposePrompt(safe), groundingPrompt(safe), safe.config?.promptMaxChars);
}
export function formatMaterialLine(material, now = Date.now()) {
  const line = originalFormatMaterialLine(material, now);
  return (material?.kind === 'memory' ? line.replace(/^- \\[记忆·[^\\]]*\\]/, '- [历史记忆]') : line) + materialTimeNote(material);
}
export function goalToCandidate(goal) {
  const candidate = originalGoalToCandidate(goal);
  return candidate ? { ...candidate, provenance: candidateProvenance(goal) } : candidate;
}
`;
}

/** Exact-baseline transformation only. The updater owns backup, helper installation and replacement. */
export function patchPurposeEngine(source, { version } = {}) {
  if (version !== PURPOSE_ENGINE_PATCH.version) throw Error('Unsupported Aurabot purpose version');
  if (typeof source !== 'string') throw Error('Purpose source must be UTF-8 text');
  const input = sha(source);
  if (input === PURPOSE_ENGINE_PATCH.after_sha256) return { source, changed: false };
  if (input !== PURPOSE_ENGINE_PATCH.before_sha256) throw Error('Unrecognized Aurabot purpose engine source hash');
  const next = transform(source);
  if (sha(next) !== PURPOSE_ENGINE_PATCH.after_sha256) throw Error('Patched purpose engine hash mismatch');
  return { source: next, changed: true };
}
