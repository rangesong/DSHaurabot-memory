import { clone, fields, integer, PATCH_FIELDS, requireThat, stringList, TERMINAL_LOOP_STATES, text, validateContext } from './model.js';

const SOURCE_INPUT = ['id', 'chat_id', 'stream_id', 'speaker_id', 'role', 'sequence', 'text', 'occurred_at', 'time_precision', 'provenance', 'delivery_status'];
const MEMORY_INPUT = ['id', 'kind', 'label', 'body', 'source_refs', 'region_ids', 'primary_region', 'occurred_at', 'time_precision', 'validity', 'protection', 'evidence_status', 'review_status', 'basis_refs', 'attributes'];
const RELATION_INPUT = ['id', 'from_id', 'to_id', 'relation_type', 'source_refs', 'strength'];
const DEFAULT_REGIONS = Object.freeze({ experience: ['M1', 'M2', 'M4'], conversation: ['M1', 'M4'], message: ['M1', 'M4'], claim: ['M2'], knowledge: ['M5'], method: ['M5'], person: ['M3'], entity: ['M2'], open_loop: ['M2', 'M4'], pattern: ['M3'] });
const DEFAULT_PRIMARY = Object.freeze({ experience: 'M2', conversation: 'M4', message: 'M4', claim: 'M2', knowledge: 'M5', method: 'M5', person: 'M3', entity: 'M2', open_loop: 'M2', pattern: 'M3' });
const common = (context, at) => ({ ...clone(context), revision: 1, recorded_at: at, updated_at: at });
const time = (input) => ({ occurred_at: input.occurred_at ?? null, time_precision: input.time_precision ?? (input.occurred_at == null ? 'unknown' : 'instant') });
const create = (entity_type, value) => ({ entity_type, expected_revision: null, value });

export function prepareSource(context, record, at) {
  validateContext(context); fields(record, SOURCE_INPUT, 'source input');
  return { ...clone(record), ...common(context, at), ...time(record) };
}

export function prepareMemory(context, memory, at) {
  validateContext(context); fields(memory, MEMORY_INPUT, 'memory input');
  return {
    ...clone(memory), ...common(context, at), ...time(memory),
    region_ids: clone(memory.region_ids ?? DEFAULT_REGIONS[memory.kind] ?? []), primary_region: memory.primary_region ?? DEFAULT_PRIMARY[memory.kind],
    validity: memory.validity ?? 'current', protection: memory.protection ?? 'P2', evidence_status: memory.evidence_status ?? 'reported',
    review_status: memory.review_status ?? 'ready', basis_refs: clone(memory.basis_refs ?? []), attributes: clone(memory.attributes ?? {}),
  };
}

export function prepareRelation(context, relation, at) {
  validateContext(context); fields(relation, RELATION_INPUT, 'relation input');
  return { ...clone(relation), ...common(context, at), strength: relation.strength ?? 0.5 };
}

/** Domain operations accept explicit structured input; they do not pretend to extract prose. */
export class MemoryService {
  constructor(store) {
    requireThat(store && typeof store.transact === 'function', 'INVALID_DATA', 'A MemoryStore is required');
    this.store = store;
  }

  ingestSource(context, { command_id, record }) {
    validateContext(context); fields(record, SOURCE_INPUT, 'source input');
    return this.store.transact({ context, command_id, request: { operation: 'ingest_source', record } }, (_snapshot, at) => [
      create('source', prepareSource(context, record, at)),
    ]);
  }

  createMemory(context, { command_id, memory }) {
    validateContext(context); fields(memory, MEMORY_INPUT, 'memory input');
    return this.store.transact({ context, command_id, request: { operation: 'create_memory', memory } }, (_snapshot, at) => {
      const value = prepareMemory(context, memory, at);
      return [create('memory', value)];
    });
  }

  createRelation(context, { command_id, relation }) {
    validateContext(context); fields(relation, RELATION_INPUT, 'relation input');
    return this.store.transact({ context, command_id, request: { operation: 'create_relation', relation } }, (_snapshot, at) => [
      create('relation', prepareRelation(context, relation, at)),
    ]);
  }

  reviseMemory(context, { command_id, id, expected_revision, patch, evidence_source_refs }) {
    validateContext(context); text(id, 'id'); integer(expected_revision, 'expected_revision', 1);
    fields(patch, PATCH_FIELDS, 'patch');
    requireThat(Object.keys(patch).length > 0, 'EMPTY_PATCH', 'A revision requires an explicit change');
    stringList(evidence_source_refs, 'evidence_source_refs', { nonempty: true });
    const request = { operation: 'revise_memory', id, expected_revision, patch, evidence_source_refs };
    return this.store.transact({ context, command_id, request }, (snapshot, at) => {
      const current = snapshot.memories.find((item) => item.id === id);
      requireThat(current, 'NOT_FOUND', 'Memory was not found', { id });
      requireThat(current.revision === expected_revision, 'REVISION_CONFLICT', 'Memory changed since it was read', { id, expected: expected_revision, actual: current.revision });
      // Each version has its own current evidence; original evidence remains in history.
      const value = { ...clone(current), ...clone(patch), source_refs: clone(evidence_source_refs), revision: current.revision + 1, updated_at: at };
      const changes = [{ entity_type: 'memory', expected_revision, value }];
      const affected = new Set([id]);
      // Flag transitive derivations atomically. Similarity relations do not propagate edits.
      let advanced = true;
      while (advanced) {
        advanced = false;
        for (const dependent of snapshot.memories) {
          if (affected.has(dependent.id) || !dependent.basis_refs.some((basis) => affected.has(basis.id))) continue;
          affected.add(dependent.id); advanced = true;
          if (dependent.review_status === 'needs_review') continue;
          changes.push({ entity_type: 'memory', expected_revision: dependent.revision,
            value: { ...clone(dependent), revision: dependent.revision + 1, updated_at: at, review_status: 'needs_review' } });
        }
      }
      return changes;
    });
  }

  getMemory(context, id, options = {}) {
    text(id, 'id');
    return this.store.readSnapshot(context, options).memories.find((item) => item.id === id) ?? null;
  }

  getDetails(context, id, options = {}) {
    const snapshot = this.store.readSnapshot(context, options);
    const memory = snapshot.memories.find((item) => item.id === id);
    if (!memory) return null;
    const relations = snapshot.relations.filter((item) => item.from_id === id || item.to_id === id);
    const relatedIds = new Set(relations.flatMap((item) => [item.from_id, item.to_id]).filter((other) => other !== id));
    return { memory, sources: snapshot.sources.filter((source) => memory.source_refs.includes(source.id)), relations,
      related: snapshot.memories.filter((item) => relatedIds.has(item.id)),
      history: this.store.getHistory(context, id, { through_sequence: snapshot.sequence }), sequence: snapshot.sequence };
  }

  listRegion(context, region_id, options = {}) {
    requireThat(['M1', 'M2', 'M3', 'M4', 'M5'].includes(region_id), 'INVALID_DATA', 'Unknown memory region');
    return this.store.readSnapshot(context, options).memories.filter((item) => item.region_ids.includes(region_id));
  }

  listOpenLoops(context, options = {}) {
    return this.store.readSnapshot(context, options).memories.filter((item) => item.kind === 'open_loop' && item.validity === 'current' && !TERMINAL_LOOP_STATES.includes(item.attributes.status));
  }

  listTimeline(context, options = {}) {
    return this.store.readSnapshot(context, options).sources.sort((a, b) => a.chat_id.localeCompare(b.chat_id)
      || (a.stream_id ?? a.chat_id).localeCompare(b.stream_id ?? b.chat_id) || a.sequence - b.sequence);
  }
}
