/** Platform-independent data contracts. No IO, model calls, or automatic extraction. */
export class MemoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }
}

export function requireThat(condition, code, message, details) {
  if (!condition) throw new MemoryError(code, message, details);
}

export const clone = (value) => structuredClone(value);

export function assertJson(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'INVALID_DATA', `${path} must be finite`);
    return;
  }
  requireThat(typeof value === 'object', 'INVALID_DATA', `${path} must be JSON data`);
  requireThat(!ancestors.has(value), 'INVALID_DATA', `${path} contains a cycle`);
  requireThat(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'INVALID_DATA', `${path} must be a plain object or array`);
  requireThat(Object.getOwnPropertySymbols(value).length === 0, 'INVALID_DATA', `${path} contains symbols`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], `${path}[${i}]`, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

export function stableStringify(value) {
  assertJson(value);
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return JSON.stringify(canonical(value));
}

export function text(value, field) {
  requireThat(typeof value === 'string' && value.trim().length > 0, 'INVALID_DATA', `${field} must be non-empty text`);
  return value;
}

export function timestamp(value, field, nullable = false) {
  if (nullable && value === null) return;
  requireThat(Number.isSafeInteger(value) && value >= 0, 'INVALID_DATA', `${field} must be Unix milliseconds${nullable ? ' or null' : ''}`);
}

export function integer(value, field, min = 0) {
  requireThat(Number.isSafeInteger(value) && value >= min, 'INVALID_DATA', `${field} must be an integer >= ${min}`);
}

export function oneOf(value, allowed, field) {
  requireThat(allowed.includes(value), 'INVALID_DATA', `${field} is invalid`, { value, allowed });
}

function object(value, field) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_DATA', `${field} must be an object`);
}

export function fields(value, allowed, field) {
  object(value, field);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  requireThat(!unknown.length, 'INVALID_DATA', `${field} contains unsupported fields`, { fields: unknown });
}

export function stringList(value, field, { nonempty = false } = {}) {
  requireThat(Array.isArray(value) && (!nonempty || value.length > 0), 'INVALID_DATA', `${field} must be ${nonempty ? 'a non-empty' : 'an'} array`);
  value.forEach((item) => text(item, field));
  requireThat(new Set(value).size === value.length, 'INVALID_DATA', `${field} contains duplicates`);
}

export function validateContext(context) {
  assertJson(context);
  fields(context, ['persona_id', 'scope'], 'context');
  text(context.persona_id, 'context.persona_id');
  text(context.scope, 'context.scope');
  return context;
}

export const contextKey = (context) => stableStringify(validateContext(context));

const region = (id, label, description, color, domain) => Object.freeze({ id, label, description, color, domain });
export const WORKING_REGIONS = Object.freeze([
  region('W1', '感觉联合区', '看见、听见、接收消息', '#70d6ff', 'working'),
  region('W2', '前额叶', '记住眼前的事，找相关往事', '#ffd670', 'working'),
  region('W3', '边缘系统', '理解此刻的感受，决定怎样回应', '#ff8fab', 'working'),
  region('W4', '语言区', '把话说出来，把授权的事办好', '#b8f2e6', 'working'),
  region('W5', '海马—皮层回路', '整理、串联，检查有没有记错', '#bdb2ff', 'working'),
]);
export const MEMORY_REGIONS = Object.freeze([
  region('M1', '时间星区', '什么时候，先后怎样变化', '#90dbf4', 'memory'),
  region('M2', '事件星区', '发生了什么，后来怎样', '#f7a072', 'memory'),
  region('M3', '人物星区', '和谁有关，怎么相处', '#f49fbc', 'memory'),
  region('M4', '对话空间星区', '在哪里说的，当时聊什么', '#a9def9', 'memory'),
  region('M5', '知识与方法星区', '知道了什么，怎样做更合适', '#c3f584', 'memory'),
]);
export const REGION_IDS = Object.freeze(MEMORY_REGIONS.map((item) => item.id));
export const MEMORY_KINDS = Object.freeze(['experience', 'conversation', 'message', 'claim', 'knowledge', 'method', 'person', 'entity', 'open_loop', 'pattern']);
export const RELATION_TYPES = Object.freeze(['participates_in', 'mentions', 'part_of', 'supports', 'counterexample', 'derived_from', 'uses_method', 'produced_by', 'related_to', 'corrects']);
export const TERMINAL_LOOP_STATES = Object.freeze(['completed', 'cancelled', 'superseded']);

const COMMON = ['id', 'persona_id', 'scope', 'revision', 'recorded_at', 'updated_at'];
export const SOURCE_FIELDS = Object.freeze([...COMMON, 'chat_id', 'stream_id', 'speaker_id', 'role', 'sequence', 'text', 'occurred_at', 'time_precision', 'provenance', 'delivery_status']);
export const MEMORY_FIELDS = Object.freeze([...COMMON, 'kind', 'label', 'body', 'source_refs', 'region_ids', 'primary_region', 'occurred_at', 'time_precision', 'validity', 'protection', 'evidence_status', 'review_status', 'basis_refs', 'attributes']);
export const RELATION_FIELDS = Object.freeze([...COMMON, 'from_id', 'to_id', 'relation_type', 'source_refs', 'strength']);
export const PATCH_FIELDS = Object.freeze(['label', 'body', 'region_ids', 'primary_region', 'occurred_at', 'time_precision', 'validity', 'protection', 'evidence_status', 'review_status', 'basis_refs', 'attributes']);

function validateCommon(value, context) {
  text(value.id, 'id');
  integer(value.revision, 'revision', 1);
  timestamp(value.recorded_at, 'recorded_at');
  timestamp(value.updated_at, 'updated_at');
  requireThat(value.updated_at >= value.recorded_at, 'INVALID_DATA', 'updated_at precedes recorded_at');
  requireThat(value.persona_id === context.persona_id && value.scope === context.scope, 'SCOPE_MISMATCH', 'Object does not belong to this context');
}

function validateTime(value) {
  timestamp(value.occurred_at, 'occurred_at', true);
  oneOf(value.time_precision, ['unknown', 'day', 'instant'], 'time_precision');
  requireThat((value.occurred_at === null) === (value.time_precision === 'unknown'), 'INVALID_DATA', 'Unknown time must use null and unknown precision');
}

export function validateSource(value, context) {
  assertJson(value); fields(value, SOURCE_FIELDS, 'source'); validateCommon(value, context); validateTime(value);
  requireThat(value.revision === 1 && value.updated_at === value.recorded_at, 'IMMUTABLE_SOURCE', 'Original sources cannot be rewritten');
  text(value.chat_id, 'chat_id'); text(value.speaker_id, 'speaker_id'); text(value.text, 'text');
  oneOf(value.role, ['user', 'assistant', 'tool', 'document', 'unknown'], 'role');
  integer(value.sequence, 'sequence', 1);
  if (value.stream_id !== undefined) text(value.stream_id, 'stream_id');
  if (value.provenance !== undefined) object(value.provenance, 'provenance');
  if (value.delivery_status !== undefined) oneOf(value.delivery_status, ['not_applicable', 'unknown', 'prepared', 'queued', 'sent', 'failed', 'simulated'], 'delivery_status');
}

export function validateMemory(value, context) {
  assertJson(value); fields(value, MEMORY_FIELDS, 'memory'); validateCommon(value, context); validateTime(value);
  oneOf(value.kind, MEMORY_KINDS, 'kind'); text(value.label, 'label'); text(value.body, 'body');
  stringList(value.source_refs, 'source_refs', { nonempty: true });
  stringList(value.region_ids, 'region_ids', { nonempty: true });
  value.region_ids.forEach((id) => oneOf(id, REGION_IDS, 'region_ids'));
  requireThat(value.region_ids.includes(value.primary_region), 'INVALID_DATA', 'primary_region must be a member of region_ids');
  oneOf(value.validity, ['current', 'historical', 'superseded', 'withdrawn'], 'validity');
  oneOf(value.protection, ['P0', 'P1', 'P2', 'P3'], 'protection');
  oneOf(value.evidence_status, ['reported', 'inferred', 'hypothetical'], 'evidence_status');
  oneOf(value.review_status, ['ready', 'needs_review'], 'review_status');
  object(value.attributes, 'attributes');
  requireThat(Array.isArray(value.basis_refs), 'INVALID_DATA', 'basis_refs must be an array');
  const ids = new Set();
  for (const basis of value.basis_refs) {
    fields(basis, ['id', 'revision'], 'basis_ref'); text(basis.id, 'basis_ref.id'); integer(basis.revision, 'basis_ref.revision', 1);
    requireThat(basis.id !== value.id && !ids.has(basis.id), 'INVALID_DATA', 'basis_refs cannot contain self or duplicates'); ids.add(basis.id);
  }
  if (['knowledge', 'method'].includes(value.kind)) requireThat(value.region_ids.includes('M5'), 'INVALID_DATA', 'Knowledge and methods must have an M5 entry');
  if (value.kind === 'method') {
    oneOf(value.attributes.verification, ['untested', 'tried', 'verified', 'obsolete', 'withdrawn'], 'method.verification');
    if (value.attributes.verification === 'verified') {
      text(value.attributes.environment, 'method.environment');
      text(value.attributes.success_criteria, 'method.success_criteria');
      stringList(value.attributes.outcome_source_refs, 'method.outcome_source_refs', { nonempty: true });
    }
  }
  if (value.kind === 'open_loop') {
    oneOf(value.attributes.status, ['proposed', 'active', 'waiting', 'blocked', ...TERMINAL_LOOP_STATES], 'open_loop.status');
    if (value.attributes.due_at !== undefined) timestamp(value.attributes.due_at, 'open_loop.due_at', true);
    if (TERMINAL_LOOP_STATES.includes(value.attributes.status)) stringList(value.attributes.outcome_source_refs, 'open_loop.outcome_source_refs', { nonempty: true });
  }
}

export function validateRelation(value, context) {
  assertJson(value); fields(value, RELATION_FIELDS, 'relation'); validateCommon(value, context);
  text(value.from_id, 'from_id'); text(value.to_id, 'to_id');
  requireThat(value.from_id !== value.to_id, 'INVALID_DATA', 'A relation cannot point to itself');
  oneOf(value.relation_type, RELATION_TYPES, 'relation_type');
  stringList(value.source_refs, 'source_refs', { nonempty: true });
  requireThat(typeof value.strength === 'number' && value.strength >= 0 && value.strength <= 1, 'INVALID_DATA', 'strength must be between 0 and 1');
}

/** Referential checks cover the whole partition, including newly staged objects. */
export function validateSnapshot(snapshot) {
  validateContext(snapshot.context);
  integer(snapshot.sequence, 'snapshot.sequence');
  timestamp(snapshot.recorded_at, 'snapshot.recorded_at', true);
  for (const key of ['sources', 'memories', 'relations']) requireThat(Array.isArray(snapshot[key]), 'INVALID_DATA', `snapshot.${key} must be an array`);
  const sources = new Map(); const memories = new Map(); const ids = new Set(); const sourceOrder = new Set();
  const unique = (value) => { requireThat(!ids.has(value.id), 'DUPLICATE_ID', 'IDs must be unique within a context', { id: value.id }); ids.add(value.id); };
  for (const source of snapshot.sources) {
    validateSource(source, snapshot.context); unique(source);
    const key = stableStringify([source.chat_id, source.stream_id ?? source.chat_id, source.sequence]);
    requireThat(!sourceOrder.has(key), 'DUPLICATE_SEQUENCE', 'Source sequence already exists in this conversation');
    sourceOrder.add(key); sources.set(source.id, source);
  }
  const checkSources = (refs) => refs.forEach((id) => requireThat(sources.has(id), 'MISSING_SOURCE', 'Source is absent from this context', { id }));
  for (const memory of snapshot.memories) {
    validateMemory(memory, snapshot.context); unique(memory); checkSources(memory.source_refs); memories.set(memory.id, memory);
    if (memory.evidence_status === 'reported') requireThat(memory.source_refs.some((id) => ['user', 'tool', 'document'].includes(sources.get(id).role)), 'UNSUPPORTED_EVIDENCE', 'Assistant or unattributed output alone cannot become reported facts');
    const outcomes = memory.attributes.outcome_source_refs;
    if (outcomes !== undefined) {
      stringList(outcomes, 'outcome_source_refs'); checkSources(outcomes);
      for (const id of outcomes) requireThat(memory.source_refs.includes(id) && ['user', 'tool'].includes(sources.get(id).role), 'UNSUPPORTED_OUTCOME', 'Outcomes require a referenced user report or tool result');
    }
  }
  for (const memory of memories.values()) for (const basis of memory.basis_refs) {
    const parent = memories.get(basis.id);
    requireThat(parent && basis.revision <= parent.revision, 'MISSING_BASIS', 'Basis object/version is absent', { id: basis.id });
    const stale = parent.revision !== basis.revision || parent.review_status === 'needs_review' || parent.validity !== 'current';
    requireThat(!stale || memory.review_status === 'needs_review', 'STALE_BASIS', 'Outdated dependencies require review', { id: memory.id });
  }
  const visited = new Set(); const visiting = new Set();
  const visit = (id) => {
    requireThat(!visiting.has(id), 'DEPENDENCY_CYCLE', 'Derivation dependencies cannot form a cycle');
    if (visited.has(id)) return;
    visiting.add(id); memories.get(id).basis_refs.forEach((basis) => visit(basis.id)); visiting.delete(id); visited.add(id);
  };
  for (const id of memories.keys()) visit(id);
  for (const relation of snapshot.relations) {
    validateRelation(relation, snapshot.context); unique(relation); checkSources(relation.source_refs);
    requireThat(memories.has(relation.from_id) && memories.has(relation.to_id), 'MISSING_ENDPOINT', 'Relation endpoints must exist in this context');
  }
  return snapshot;
}
