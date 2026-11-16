import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryError, contextKey, requireThat } from '../../core/model.js';
import { projectGraph } from '../../core/graph-projector.js';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const scopeKey = (context) => createHash('sha256').update(contextKey(context)).digest('hex').slice(0, 24);
const knownTime = (value) => Number.isSafeInteger(value) && value >= 0;
const compound = (scope, id) => `${scope}:${id}`;
const KIND_LABELS = { experience: '经历', conversation: '对话片段', message: '消息', claim: '旧记忆', knowledge: '知识', method: '方法', person: '人物', entity: '物件', open_loop: '未完事项', pattern: '印象与习惯' };

function safeFile(root, name) {
  const file = resolve(root, name); const path = relative(root, file);
  requireThat(!path.startsWith('..') && !isAbsolute(path), 'INVALID_ARTIFACT', 'Artifact left its import directory');
  const actual = realpathSync(file); const resolved = relative(realpathSync(root), actual);
  requireThat(!resolved.startsWith('..') && !isAbsolute(resolved), 'INVALID_ARTIFACT', 'Artifact symlink left its import directory');
  return actual;
}

function scopeLabel(scope, counters) {
  if (scope.startsWith('group:')) return `群聊 ${String(++counters.group).padStart(2, '0')}`;
  if (scope.startsWith('private:')) return `私聊 ${String(++counters.private).padStart(2, '0')}`;
  return ({ 'aurabot:diary': '日记', 'aurabot:legacy-memory-unattributed': '旧记忆与日常', 'aurabot:legacy-profile-catalog': '人物档案',
    'aurabot:role-patterns': '相处与表达', 'aurabot:role-state': '角色状态' })[scope] ?? `其他记录 ${++counters.other}`;
}

/** Local-owner viewer: aggregate projections, never merge canonical facts across contexts. */
export class AurabotViewProvider {
  #output; #state;
  constructor(output) { this.#output = resolve(output); }

  #load() {
    const pointer = json(join(this.#output, 'current.json'));
    requireThat(pointer.dataset_kind === 'aurabot' && /^imports\/[a-f0-9]{24}-[a-f0-9]{8}$/.test(pointer.import_directory), 'INVALID_IMPORT', 'No valid current Aurabot import');
    if (this.#state?.revision === pointer.import_fingerprint) return this.#state;
    const directory = safeFile(this.#output, pointer.import_directory);
    const index = json(safeFile(directory, 'index.json')); const report = json(safeFile(directory, 'report.json'));
    requireThat(index.import_fingerprint === pointer.import_fingerprint && report.import_fingerprint === pointer.import_fingerprint, 'IMPORT_CHANGED', 'Import index does not match its pointer');
    const scopes = new Map(); const counters = { group: 0, private: 0, other: 0 };
    for (const entry of index.contexts) {
      const key = scopeKey(entry.context);
      requireThat(basename(entry.details) === `${key}.json`, 'INVALID_IMPORT', 'Unexpected context details');
      scopes.set(key, { key, label: scopeLabel(entry.context.scope, counters), entry, loaded: null });
    }
    this.#state = { revision: pointer.import_fingerprint, directory, index, report, scopes, observations: null };
    return this.#state;
  }

  #partition(state, key) {
    const scope = state.scopes.get(key); requireThat(scope, 'NOT_FOUND', 'Unknown data scope');
    if (!scope.loaded) {
      const snapshot = json(safeFile(state.directory, scope.entry.details));
      requireThat(contextKey(snapshot.context) === contextKey(scope.entry.context), 'INVALID_IMPORT', 'Details context does not match index');
      const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
      const memories = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
      const graph = projectGraph(snapshot, { limit: snapshot.memories.length, include_projections: false, include_noncurrent: true });
      const search = new Map(snapshot.memories.map((memory) => [memory.id, [memory.label, memory.body,
        ...memory.source_refs.map((id) => sources.get(id)?.text ?? '')].join('\n').toLocaleLowerCase()]));
      scope.loaded = { snapshot, sources, memories, graph, search };
    }
    return scope.loaded;
  }

  #selected(state, key) {
    requireThat(key === 'all' || state.scopes.has(key), 'NOT_FOUND', 'Unknown data scope');
    return key === 'all' ? [...state.scopes.values()] : [state.scopes.get(key)];
  }

  overview() {
    const state = this.#load(); const scopes = [...state.scopes.values()];
    const times = scopes.flatMap((scope) => this.#partition(state, scope.key).snapshot.memories.map((memory) => memory.occurred_at).filter(knownTime));
    return { revision: state.revision, dataset_kind: 'aurabot', imported_at: state.index.imported_at,
      stats: { ...state.report.mapping, issues: state.report.mapping.issues.length },
      scopes: scopes.map((scope) => ({ key: scope.key, label: scope.label, count: scope.entry.counts.available_objects })),
      time_range: { start: times.length ? Math.min(...times) : null, end: times.length ? Math.max(...times) : null },
      source_coverage_complete: state.index.source_coverage_complete ?? false,
      history_mode: 'current_snapshot_by_occurrence', read_only: true };
  }

  graph({ scope = 'all', region = null, q = '', until = null, limit = 280, focus_context = null, focus_id = null } = {}) {
    const state = this.#load(); const scopes = this.#selected(state, scope);
    requireThat(!region || /^M[1-5]$/.test(region), 'INVALID_QUERY', 'Unknown memory region');
    requireThat(typeof q === 'string' && q.length <= 200, 'INVALID_QUERY', 'Search text is too long');
    requireThat(Number.isSafeInteger(limit) && limit >= 0 && limit <= 500, 'INVALID_QUERY', 'Node limit must be 0–500');
    requireThat(until === null || knownTime(until), 'INVALID_QUERY', 'Invalid occurrence time');
    const query = q.trim().toLocaleLowerCase(); const candidates = []; const catalog = [];
    for (const item of scopes) {
      const partition = this.#partition(state, item.key);
      for (const node of partition.graph.nodes.filter((node) => node.node_type === 'memory')) {
        const memory = partition.memories.get(node.canonical_id);
        const entry = { scope: item, partition, node, memory };
        catalog.push(entry);
        if (region && !memory.region_ids.includes(region)) continue;
        if (until !== null && knownTime(memory.occurred_at) && memory.occurred_at > until) continue;
        if (query && !partition.search.get(memory.id).includes(query)) continue;
        candidates.push(entry);
      }
    }
    candidates.sort((a, b) => {
      const focused = (entry) => Number(entry.scope.key === focus_context && entry.memory.id === focus_id);
      return focused(b) - focused(a) || (b.memory.occurred_at ?? -1) - (a.memory.occurred_at ?? -1) || a.memory.id.localeCompare(b.memory.id);
    });
    const selected = candidates.slice(0, limit); const nodes = []; const edges = []; const regions = scopes.length ? this.#partition(state, scopes[0].key).graph.regions : [];
    const anchorGraph = scopes.length ? this.#partition(state, scopes[0].key).graph : null;
    if (anchorGraph) {
      nodes.push(...anchorGraph.nodes.filter((node) => node.node_type === 'region' || node.node_type === 'store'));
      edges.push(...anchorGraph.edges.filter((edge) => edge.relation_type === 'store_entry'));
    }
    const selectedIds = new Set();
    for (const entry of selected) {
      const { node, scope: item, memory } = entry;
      const id = compound(item.key, node.id); selectedIds.add(id);
      const display_region = region ?? node.primary_region;
      nodes.push({ ...node, id, context_key: item.key, context_label: item.label, display_region, kind_label: KIND_LABELS[node.kind] ?? '记忆',
        source_count: memory.source_refs.length, source_subject: memory.attributes.subject ?? null });
      edges.push({ id: `entry:${id}`, from: id, to: `region:${display_region}`, relation_type: 'member_of', layer: 'organization' });
    }
    for (const item of scopes) for (const edge of this.#partition(state, item.key).graph.edges.filter((edge) => edge.layer === 'content')) {
      const from = compound(item.key, edge.from); const to = compound(item.key, edge.to);
      if (selectedIds.has(from) && selectedIds.has(to)) edges.push({ ...edge, id: compound(item.key, edge.id), from, to });
    }
    return { revision: state.revision, dataset_kind: 'aurabot', nodes, edges,
      regions: regions.map((item) => ({ ...item, count: catalog.filter((entry) => entry.memory.region_ids.includes(item.id)).length })),
      counts: { available: catalog.length, matching: candidates.length, visible: selected.length, omitted: candidates.length - selected.length,
        unknown_time: candidates.filter((entry) => entry.memory.occurred_at === null).length, contexts: scopes.length },
      complete: selected.length === candidates.length, time_mode: 'current_snapshot_by_occurrence', read_only: true };
  }

  #memory(state, scope, id, revision) {
    if (revision) requireThat(revision === state.revision, 'IMPORT_CHANGED', 'The local import changed; reload this view');
    const partition = this.#partition(state, scope); const memory = partition.memories.get(id);
    requireThat(memory, 'NOT_FOUND', 'Memory was not found in this context');
    return { partition, memory };
  }

  sources({ scope, id, offset = 0, limit = 20, revision = null, until = null }) {
    const state = this.#load(); const { partition, memory } = this.#memory(state, scope, id, revision);
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_QUERY', 'Invalid source page');
    requireThat(until === null || knownTime(until), 'INVALID_QUERY', 'Invalid occurrence time');
    const all = memory.source_refs.map((ref) => partition.sources.get(ref)).filter(Boolean);
    const eligible = all.filter((source) => until === null || !knownTime(source.occurred_at) || source.occurred_at <= until);
    return { revision: state.revision, context_key: scope, canonical_id: id, total: eligible.length, stored_total: all.length,
      sources: eligible.slice(offset, offset + limit), next_offset: Math.min(offset + limit, eligible.length), has_more: offset + limit < eligible.length };
  }

  detail({ scope, id, revision = null, until = null }) {
    const state = this.#load(); const { partition, memory } = this.#memory(state, scope, id, revision);
    const relations = partition.snapshot.relations.filter((edge) => edge.from_id === id || edge.to_id === id).map((edge) => {
      const other = partition.memories.get(edge.from_id === id ? edge.to_id : edge.from_id);
      return { relation_type: edge.relation_type, id: other.id, label: other.label, kind: other.kind };
    });
    return { revision: state.revision, context_key: scope, context_label: state.scopes.get(scope).label, memory,
      relations, source_page: this.sources({ scope, id, revision: state.revision, until }),
      history_note: '这是当前导入版本。时间筛选不重建原始历史版本。' };
  }

  recalls({ scope = 'all', limit = 8 } = {}) {
    const state = this.#load(); const selected = this.#selected(state, scope);
    requireThat(Number.isSafeInteger(limit) && limit >= 0 && limit <= 30, 'INVALID_QUERY', 'Invalid recall limit');
    if (!state.observations) state.observations = json(safeFile(state.directory, state.index.observations)).observations;
    const scopeByNative = new Map(selected.map((item) => [item.entry.context.scope, item]));
    return { revision: state.revision, observations: state.observations.filter((item) => item.kind === 'legacy_recall' && (scope === 'all' || scopeByNative.has(item.scope)))
      .sort((a, b) => (b.occurred_at ?? -1) - (a.occurred_at ?? -1)).slice(0, limit).map((item) => ({ ...item,
        context_key: scopeByNative.get(item.scope)?.key ?? null, context_label: scopeByNative.get(item.scope)?.label ?? '范围未注明' })) };
  }
}
