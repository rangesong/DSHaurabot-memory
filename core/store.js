import { MemoryError, clone, contextKey, fields, integer, requireThat, stableStringify, text, timestamp, validateSnapshot } from './model.js';

const COLLECTION = Object.freeze({ source: 'sources', memory: 'memories', relation: 'relations' });
const empty = (context) => ({ context: clone(context), sequence: 0, recorded_at: null, sources: [], memories: [], relations: [] });
const eventId = (context, sequence) => `change:${encodeURIComponent(contextKey(context))}:${sequence}`;

function stage(snapshot, transaction) {
  const next = clone(snapshot);
  const changed = new Set();
  const positions = Object.fromEntries(Object.values(COLLECTION).map((key) => [key, new Map(next[key].map((value, index) => [value.id, index]))]));
  const occupied = new Set(Object.values(COLLECTION).flatMap((key) => next[key].map((value) => value.id)));
  requireThat(Array.isArray(transaction.changes) && transaction.changes.length > 0, 'INVALID_DATA', 'A transaction needs changes');
  for (const change of transaction.changes) {
    fields(change, ['entity_type', 'expected_revision', 'value'], 'change');
    requireThat(Object.hasOwn(COLLECTION, change.entity_type), 'INVALID_DATA', 'Unknown entity_type');
    const value = change.value;
    text(value?.id, 'change.value.id');
    requireThat(!changed.has(value.id), 'DUPLICATE_CHANGE', 'One transaction cannot change an object twice'); changed.add(value.id);
    const collection = COLLECTION[change.entity_type];
    const list = next[collection];
    const index = positions[collection].get(value.id);
    const current = index === undefined ? undefined : list[index];
    if (change.expected_revision === null) {
      requireThat(!occupied.has(value.id), 'ALREADY_EXISTS', 'Object ID already exists', { id: value.id });
      requireThat(value.revision === 1 && value.recorded_at === transaction.recorded_at, 'INVALID_REVISION', 'New objects start at revision 1 and transaction time');
      positions[collection].set(value.id, list.length); occupied.add(value.id); list.push(clone(value));
    } else {
      integer(change.expected_revision, 'expected_revision', 1);
      requireThat(change.entity_type !== 'source', 'IMMUTABLE_SOURCE', 'Sources are append-only; add a correction source');
      requireThat(current, 'NOT_FOUND', 'Object was not found', { id: value.id });
      requireThat(current.revision === change.expected_revision, 'REVISION_CONFLICT', 'Object changed since it was read', { id: value.id, expected: change.expected_revision, actual: current.revision });
      requireThat(value.revision === current.revision + 1 && value.recorded_at === current.recorded_at, 'INVALID_REVISION', 'Revisions must preserve creation time and advance by one');
      if (change.entity_type === 'memory') requireThat(value.kind === current.kind, 'INVALID_DATA', 'An object cannot change its kind');
      list[index] = clone(value);
    }
    requireThat(value.updated_at === transaction.recorded_at, 'INVALID_DATA', 'Updated time must equal transaction time');
  }
  next.sequence = transaction.sequence;
  next.recorded_at = transaction.recorded_at;
  return validateSnapshot(next);
}

function receipt(transaction, replayed = false) {
  return { command_id: transaction.command_id, event_id: transaction.event_id, sequence: transaction.sequence,
    recorded_at: transaction.recorded_at, replayed,
    changes: transaction.changes.map(({ entity_type, value }) => ({ entity_type, id: value.id, revision: value.revision })) };
}

/** Append-only transactions with scope-local sequencing and optional atomic persistence. */
export class MemoryStore {
  #partitions = new Map();
  #commands = new Map();
  #transactions = [];
  #writing = false;
  #clock;
  #persist;

  constructor({ data = { schema_version: 1, transactions: [] }, clock = Date.now, persist = null } = {}) {
    requireThat(typeof clock === 'function' && (persist === null || typeof persist === 'function'), 'INVALID_DATA', 'Invalid store options');
    this.#clock = clock; this.#persist = persist;
    fields(data, ['schema_version', 'transactions'], 'store');
    requireThat(data.schema_version === 1 && Array.isArray(data.transactions), 'INVALID_STORE', 'Unsupported or malformed store');
    // Validate replay, not just JSON syntax. Never silently reset a corrupt store.
    for (const entry of data.transactions) {
      const transaction = clone(entry);
      fields(transaction, ['context', 'command_id', 'request', 'event_id', 'sequence', 'recorded_at', 'changes'], 'transaction');
      const key = contextKey(transaction.context); text(transaction.command_id, 'command_id'); stableStringify(transaction.request);
      integer(transaction.sequence, 'sequence', 1); timestamp(transaction.recorded_at, 'recorded_at');
      const current = this.#partitions.get(key) || empty(transaction.context);
      requireThat(transaction.sequence === current.sequence + 1 && transaction.event_id === eventId(transaction.context, transaction.sequence), 'INVALID_STORE', 'Invalid transaction sequence or identity');
      requireThat(current.recorded_at === null || transaction.recorded_at >= current.recorded_at, 'INVALID_STORE', 'Transaction time moved backwards');
      const commandKey = stableStringify([key, transaction.command_id]);
      requireThat(!this.#commands.has(commandKey), 'INVALID_STORE', 'Duplicate stored command');
      this.#partitions.set(key, stage(current, transaction));
      this.#commands.set(commandKey, transaction); this.#transactions.push(transaction);
    }
  }

  transact({ context, command_id, request }, build) {
    const key = contextKey(context); text(command_id, 'command_id');
    const fingerprint = stableStringify(request);
    const commandKey = stableStringify([key, command_id]);
    const previous = this.#commands.get(commandKey);
    if (previous) {
      requireThat(stableStringify(previous.request) === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Command ID was reused for a different request', { command_id });
      return receipt(previous, true);
    }
    requireThat(!this.#writing, 'TRANSACTION_ACTIVE', 'Nested transactions are not supported');
    requireThat(typeof build === 'function', 'INVALID_DATA', 'A synchronous transaction builder is required');
    this.#writing = true;
    try {
      const current = this.#partitions.get(key) || empty(context);
      const at = this.#clock(); timestamp(at, 'clock');
      requireThat(current.recorded_at === null || at >= current.recorded_at, 'CLOCK_REGRESSION', 'Clock moved backwards; transaction was not applied');
      const changes = build(clone(current), at);
      requireThat(!changes?.then, 'ASYNC_TRANSACTION', 'Transaction builders must be synchronous');
      const transaction = { context: clone(context), command_id, request: clone(request), event_id: eventId(context, current.sequence + 1), sequence: current.sequence + 1, recorded_at: at, changes: clone(changes) };
      const next = stage(current, transaction);
      const data = { schema_version: 1, transactions: [...this.#transactions, transaction] };
      if (this.#persist) {
        const result = this.#persist(clone(data));
        requireThat(!result?.then, 'ASYNC_PERSISTENCE', 'Use synchronous atomic persistence for this store');
      }
      // Publish memory state only after persistence succeeds.
      this.#partitions.set(key, next); this.#transactions.push(transaction); this.#commands.set(commandKey, transaction);
      return receipt(transaction);
    } finally { this.#writing = false; }
  }

  readSnapshot(context, options = {}) {
    const key = contextKey(context);
    fields(options, ['as_of', 'through_sequence'], 'snapshot options');
    if (options.as_of !== undefined) timestamp(options.as_of, 'as_of');
    if (options.through_sequence !== undefined) integer(options.through_sequence, 'through_sequence');
    const current = this.#partitions.get(key) || empty(context);
    if (options.through_sequence !== undefined) requireThat(options.through_sequence <= current.sequence, 'INVALID_CURSOR', 'Requested sequence has not been committed');
    if (options.as_of === undefined && options.through_sequence === undefined) return clone(current);
    let state = empty(context);
    for (const transaction of this.#transactions) {
      if (contextKey(transaction.context) !== key) continue;
      if (transaction.recorded_at > (options.as_of ?? Infinity) || transaction.sequence > (options.through_sequence ?? Infinity)) break;
      state = stage(state, transaction);
    }
    return clone(state);
  }

  getChanges(context, { after_sequence = 0, limit = 100 } = {}) {
    const key = contextKey(context); integer(after_sequence, 'after_sequence'); integer(limit, 'limit');
    const current = this.#partitions.get(key) || empty(context);
    requireThat(after_sequence <= current.sequence, 'INVALID_CURSOR', 'Cursor is ahead of this context');
    const pending = this.#transactions.filter((item) => contextKey(item.context) === key && item.sequence > after_sequence);
    const page = pending.slice(0, limit);
    return { context: clone(context), sequence: current.sequence, changes: clone(page), complete: page.length === pending.length,
      next_after_sequence: page.at(-1)?.sequence ?? after_sequence };
  }

  getHistory(context, id, options = {}) {
    text(id, 'id');
    const snapshot = this.readSnapshot(context, options); const key = contextKey(context);
    return this.#transactions.filter((item) => contextKey(item.context) === key && item.sequence <= snapshot.sequence)
      .flatMap((item) => item.changes.filter((change) => change.value.id === id).map((change) => ({ sequence: item.sequence, recorded_at: item.recorded_at, ...clone(change) })));
  }

  /** Full trusted-process backup; a host must not expose this as a scoped client API. */
  exportData() { return clone({ schema_version: 1, transactions: this.#transactions }); }
}

export function createMemoryStore(options) { return new MemoryStore(options); }
export { MemoryError };
