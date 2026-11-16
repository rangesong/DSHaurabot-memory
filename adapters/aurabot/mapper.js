import { MemoryStore } from '../../core/store.js';
import { contextKey, requireThat, stableStringify } from '../../core/model.js';
import { prepareMemory, prepareRelation, prepareSource } from '../../core/memory-service.js';
import { sha256 } from './reader.js';

export const MAPPING_VERSION = 2;
const LEGACY_PERSONA = 'aurabot:persona-unattributed';
const hash = (value) => sha256(stableStringify(value)).slice(0, 32);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const stamp = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const scopeOf = (value, fallback = 'aurabot:legacy-unattributed') => nonempty(value) ? value : fallback;
const title = (value, fallback) => nonempty(value) ? value.replace(/\s+/g, ' ').trim().slice(0, 48) : fallback;
const dateLabel = (at) => at === null ? '时间未注明' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

/** Deterministic provenance mapping, not semantic extraction or evidence verification. */
export function mapAurabot(capture) {
  requireThat(capture?.dataset_kind === 'aurabot' && Array.isArray(capture.chatlogs), 'INVALID_CAPTURE', 'Expected an Aurabot reader capture');
  const partitions = new Map(); const observations = []; const issues = [];
  const counts = { chat_messages: 0, vault_messages: 0, empty_text_records: 0, forgotten_records_skipped: 0, invalid_records_skipped: 0, possible_truncation: 0,
    diary_entries: 0, simulated_diaries: 0, mood_entries: 0, recall_entries: 0, legacy_memories: 0, legacy_gists: 0, legacy_profiles: 0, legacy_patterns: 0, vault_summaries: 0 };
  const nativeMemories = new Map(); const segments = new Map(); const people = new Map();
  const excludedPeople = new Set(Object.entries(plain(capture.memory?.kv?.profiles) ? capture.memory.kv.profiles : {}).filter(([, value]) => value?.noMemory === true).map(([id]) => String(id)));
  const part = (scope) => {
    const context = { persona_id: LEGACY_PERSONA, scope };
    const key = contextKey(context);
    if (!partitions.has(key)) partitions.set(key, { context, sources: new Map(), memories: new Map(), relations: new Map(), streamCounts: new Map() });
    return partitions.get(key);
  };
  const note = (code, kind, locator) => { issues.push({ code, kind, locator }); counts.invalid_records_skipped++; };
  const addSource = (p, { kind, file, locator, key = locator, value, text, role, at, speaker = 'unattributed', chatId = p.context.scope, delivery = 'not_applicable', extra = {} }) => {
    const id = `src:aurabot:${kind}:${hash([file, key, value])}`;
    if (p.sources.has(id)) return id;
    const stream_id = `aurabot:${kind}:${file}`;
    const orderKey = stableStringify([chatId, stream_id]);
    const sequence = (p.streamCounts.get(orderKey) ?? 0) + 1; p.streamCounts.set(orderKey, sequence);
    p.sources.set(id, { id, chat_id: chatId, stream_id, speaker_id: String(speaker || 'unattributed'), role, sequence, text,
      occurred_at: at, time_precision: at === null ? 'unknown' : 'instant', delivery_status: delivery,
      provenance: { system: 'aurabot', kind, relative_path: file, locator, source_hash: hash(value), persona_attribution: 'unavailable_in_legacy_source', ...extra } });
    return id;
  };
  const addMemory = (p, key, memory) => {
    const id = `mem:aurabot:${hash([p.context.scope, key])}`;
    p.memories.set(id, { id, evidence_status: 'inferred', review_status: 'needs_review', ...memory });
    return id;
  };
  const relate = (p, key, from_id, to_id, source_refs, relation_type = 'related_to', strength = 0.5) => {
    if (!from_id || !to_id || from_id === to_id) return;
    const id = `rel:aurabot:${hash([p.context.scope, key])}`;
    p.relations.set(id, { id, from_id, to_id, relation_type, source_refs: [...new Set(source_refs)], strength });
  };

  function addChat(value, { file, locator, kind, nativeKey }) {
    if (plain(value) && (value.forgottenAt || excludedPeople.has(String(value.uid ?? '')))) { counts.forgotten_records_skipped++; return; }
    if (!plain(value) || !nonempty(value.chatId) || typeof value.text !== 'string') { note('INVALID_MESSAGE', kind, locator); return; }
    if (value.chatId.startsWith('system:')) { issues.push({ code: 'BACKGROUND_CONVERSATION_EXCLUDED', kind, locator }); return; }
    const p = part(value.chatId); const at = stamp(value.t);
    const role = value.who === 'bot' || value.dir === 'out' ? 'assistant' : value.uid && value.who !== '系统' ? 'user' : 'unknown';
    const possiblyTruncated = kind === 'chatlog' && value.text.length >= 500;
    const emptyText = !value.text.trim();
    if (emptyText) counts.empty_text_records++;
    if (possiblyTruncated) counts.possible_truncation++;
    const sourceId = addSource(p, { kind, file, locator, key: nativeKey ?? locator, value, text: emptyText ? '（原流水没有文本正文）' : value.text, role, at,
      speaker: value.uid || (role === 'assistant' ? 'aurabot:bot-unattributed-persona' : 'unattributed'),
      delivery: role === 'assistant' ? 'unknown' : 'not_applicable',
      extra: { speaker_label: typeof value.who === 'string' ? value.who : '', possible_truncation: possiblyTruncated,
        content_state: emptyText ? 'no_text_in_source' : 'recorded_text', text_is_placeholder: emptyText, original_text: emptyText ? value.text : null,
        native_message_id: value.originId ?? null, via: value.via ?? null,
        // Same content/time is only a possible duplicate across stores, not new independent evidence.
        possible_duplicate_group: hash([value.chatId, at, role, String(value.uid ?? ''), value.text]) } });
    counts[kind === 'chatlog' ? 'chat_messages' : 'vault_messages']++;
    const window = at === null ? `unknown:${file}` : Math.floor(at / (15 * 60_000));
    const segmentKey = stableStringify([p.context.scope, kind, window]);
    if (!segments.has(segmentKey)) segments.set(segmentKey, { p, key: segmentKey, sources: [], at, participants: new Set(), roleSet: new Set(), kind });
    const segment = segments.get(segmentKey); segment.sources.push(sourceId); segment.roleSet.add(role);
    if (at !== null && (segment.at === null || at < segment.at)) segment.at = at;
    if (value.uid && role === 'user') {
      const personKey = stableStringify([p.context.scope, String(value.uid)]);
      if (!people.has(personKey)) people.set(personKey, { p, key: personKey, uid: String(value.uid), first: sourceId, last: sourceId, aliases: new Set(), at });
      const person = people.get(personKey); person.last = sourceId;
      if (nonempty(value.who)) person.aliases.add(value.who);
      segment.participants.add(personKey);
    }
  }

  for (const log of capture.chatlogs) for (const row of list(log.records)) addChat(row.value, { file: log.name, locator: `line:${row.line}`, kind: 'chatlog' });
  for (const row of list(capture.vault?.lines)) addChat(row, { file: 'modules-data/history-vault/vault.sqlite', locator: `vault_lines:${row.id}`, nativeKey: row.id, kind: 'vault-line' });
  const personIds = new Map();
  for (const [key, person] of people) {
    const aliases = [...person.aliases];
    const id = addMemory(person.p, ['participant', person.uid], { kind: 'person', label: title(aliases.at(-1), '未注明名称的发言者'),
      body: '该对话空间中的发言者。名称来自当时记录，仅作为身份入口。', source_refs: [...new Set([person.first, person.last])],
      region_ids: ['M3', 'M4'], primary_region: 'M3', occurred_at: person.at,
      evidence_status: 'reported', review_status: 'ready', attributes: { native_uid: person.uid, aliases, identity_basis: 'platform_sender_id_within_scope' } });
    personIds.set(key, id);
  }
  for (const segment of segments.values()) {
    const source_refs = [...new Set(segment.sources)];
    const id = addMemory(segment.p, ['conversation-window', segment.key], { kind: 'conversation',
      label: `${dateLabel(segment.at)}的${segment.kind === 'chatlog' ? '对话' : '历史档案'}（${source_refs.length} 条）`,
      body: `这段记录包含 ${source_refs.length} 条消息，可以按顺序展开原话。尚未自动提取话题和经历。`,
      source_refs, occurred_at: segment.at, region_ids: ['M1', 'M4'], primary_region: 'M4',
      evidence_status: segment.roleSet.has('user') ? 'reported' : 'inferred', review_status: 'ready',
      attributes: { grouping: '15-minute-source-window', original_store: segment.kind, message_count: source_refs.length, semantic_episode: false, historical_persona: 'unattributed' } });
    for (const personKey of segment.participants) {
      const person = people.get(personKey);
      relate(segment.p, ['participant', segment.key, personKey], personIds.get(personKey), id, [person.first], 'participates_in');
    }
  }

  const memoryFile = 'memory.sqlite';
  for (const [collection, entries] of [['item', capture.memory?.items], ['gist', capture.memory?.gists]]) {
    for (const entry of list(entries)) {
      const m = entry.value;
      if (!plain(m) || !nonempty(m.text)) { note('INVALID_LEGACY_MEMORY', collection, entry.native_id); continue; }
      if (m.forgottenAt || (m.about && excludedPeople.has(String(m.about)))) { counts.forgotten_records_skipped++; continue; }
      const p = part(scopeOf(m.chatId, 'aurabot:legacy-memory-unattributed'));
      const at = stamp(m.saidAt) ?? stamp(m.at);
      const sourceId = addSource(p, { kind: `legacy-${collection}`, file: memoryFile, locator: `${collection === 'item' ? 'items' : 'gists'}:${entry.native_id}`,
        key: entry.native_id, value: m, text: m.text, role: 'assistant', at, speaker: 'aurabot:memory-summary' });
      const experience = m.source === 'event' || m.source === 'diary' || m.kind === 'seen';
      const region_ids = [...new Set(['M1', experience ? 'M2' : m.about ? 'M3' : 'M2', ...(m.chatId ? ['M4'] : [])])];
      const id = addMemory(p, ['legacy', collection, entry.native_id], {
        kind: experience ? 'experience' : 'claim', label: title(m.text, collection === 'gist' ? '旧摘要' : '旧记忆'), body: m.text,
        source_refs: [sourceId], occurred_at: at, region_ids, primary_region: experience ? 'M2' : m.about ? 'M3' : 'M2',
        protection: m.tier === 0 ? 'P0' : Number(m.importance) >= 0.8 ? 'P1' : 'P2',
        validity: m.invalidAt ? (m.supersededBy ? 'superseded' : 'withdrawn') : m.validUntil && m.validUntil <= capture.captured_at ? 'historical' : 'current',
        attributes: { native_id: String(entry.native_id), native_source: m.source ?? null, native_kind: m.kind ?? null, native_status: m.status ?? null,
          native_tier: m.tier ?? null, about: m.about ?? null, about_name: m.aboutName ?? null, tags: m.tags ?? [],
          native_importance: m.importance ?? null, archived_at: m.archivedAt ?? null, native_history: m.history ?? [],
          original_evidence_aligned: false, native_hits: m.hits ?? 0, native_hit_days: m.hitDays ?? 0, native_last_hit: m.lastHit ?? null,
          valid_from: m.validFrom ?? null, valid_until: m.validUntil ?? null } });
      nativeMemories.set(stableStringify([p.context.scope, String(entry.native_id)]), { p, id, sourceId, native: m });
      counts[collection === 'item' ? 'legacy_memories' : 'legacy_gists']++;
    }
  }
  for (const current of nativeMemories.values()) for (const otherId of list(current.native.related)) {
    const other = nativeMemories.get(stableStringify([current.p.context.scope, String(otherId)]));
    if (other) relate(current.p, ['native-related', ...[current.id, other.id].sort()], current.id, other.id, [current.sourceId]);
  }

  const kv = capture.memory?.kv ?? {};
  for (const [uid, profile] of Object.entries(plain(kv.profiles) ? kv.profiles : {})) {
    if (!plain(profile) || profile.noMemory) continue;
    const content = [profile.text, profile.style, profile.persona, profile.handle].filter(nonempty).join('\n');
    if (!content) continue;
    const p = part('aurabot:legacy-profile-catalog');
    const sourceId = addSource(p, { kind: 'legacy-profile', file: memoryFile, locator: `kv.profiles:${uid}`, key: uid, value: profile, text: content, role: 'assistant', at: stamp(profile.at) });
    addMemory(p, ['legacy-profile', uid], { kind: 'person', label: title(profile.alias || profile.name, '旧人物档案'), body: content, source_refs: [sourceId],
      occurred_at: stamp(profile.at), attributes: { native_uid: uid, original_scope: 'not_attributed_per_statement', profile_kind: 'generated_profile' } });
    counts.legacy_profiles++;
  }
  for (const [category, collection] of [['insights', kv.insights], ['styles', kv.styles]]) {
    for (const [key, entries] of Object.entries(plain(collection) ? collection : {})) {
      if (key.startsWith('qq:') && excludedPeople.has(key.slice(3))) { counts.forgotten_records_skipped += list(entries).length; continue; }
      const p = part(key.startsWith('group:') ? key : key.startsWith('qq:') ? `private:${key.slice(3)}` : 'aurabot:role-patterns');
      list(entries).forEach((entry, index) => {
        const content = typeof entry === 'string' ? entry : entry?.text;
        if (!nonempty(content)) return;
        const at = stamp(entry?.at);
        const sourceId = addSource(p, { kind: `legacy-${category}`, file: memoryFile, locator: `kv.${category}:${key}:${index}`, key: [key, content], value: entry, text: content, role: 'assistant', at });
        addMemory(p, [category, key, content], { kind: 'pattern', label: title(content, '相处经验'), body: content, source_refs: [sourceId], occurred_at: at,
          region_ids: ['M3', 'M4'], primary_region: 'M3', attributes: { native_category: category, generated_pattern: true, conditions_verified: false } });
        counts.legacy_patterns++;
      });
    }
  }
  for (const [scope, chat] of Object.entries(plain(kv.chats) ? kv.chats : {})) {
    if (!plain(chat)) continue;
    const content = [chat.vibe, Array.isArray(chat.topics) ? chat.topics.join('、') : chat.topics, chat.impression].filter(nonempty).join('\n');
    if (!content) continue;
    const p = part(scopeOf(scope)); const at = stamp(chat.updatedAt);
    const sourceId = addSource(p, { kind: 'legacy-chat-impression', file: memoryFile, locator: `kv.chats:${scope}`, key: scope, value: chat, text: content, role: 'assistant', at });
    addMemory(p, ['chat-impression', scope], { kind: 'pattern', label: '这个对话空间的旧印象', body: content, source_refs: [sourceId], occurred_at: at,
      region_ids: ['M4'], primary_region: 'M4', attributes: { generated_impression: true } });
  }
  for (const [uid, summary] of Object.entries(plain(kv.shortTerm) ? kv.shortTerm : {})) {
    if (excludedPeople.has(uid)) { counts.forgotten_records_skipped++; continue; }
    if (!plain(summary) || !nonempty(summary.text)) continue;
    const p = part(/^\d+$/.test(uid) ? `private:${uid}` : 'aurabot:legacy-shortterm-unattributed');
    const at = stamp(summary.through) ?? stamp(summary.at);
    const sourceId = addSource(p, { kind: 'legacy-shortterm', file: memoryFile, locator: `kv.shortTerm:${uid}`, key: uid, value: summary, text: summary.text, role: 'assistant', at });
    addMemory(p, ['shortterm', uid], { kind: 'conversation', label: '先前形成的近期印象', body: summary.text, source_refs: [sourceId], occurred_at: at,
      attributes: { generated_summary: true, current_applicability: 'unknown', through: summary.through ?? null } });
  }

  for (const [index, entry] of list(capture.diary?.history).entries()) {
    if (!plain(entry) || !nonempty(entry.text)) { note('INVALID_DIARY', 'diary', index); continue; }
    const p = part('aurabot:diary'); const at = stamp(entry.at);
    const delivery = entry.dryRun === true ? 'simulated' : entry.ok === false ? 'failed' : 'unknown';
    const sourceId = addSource(p, { kind: 'diary', file: 'diary.json', locator: `history:${index}`, key: [entry.at, entry.tid ?? null, entry.text], value: entry, text: entry.text, role: 'assistant', at, delivery });
    addMemory(p, ['diary', entry.at, entry.tid ?? null, entry.text], { kind: 'experience', label: `${dateLabel(at)}的日记${delivery === 'simulated' ? '（试运行）' : ''}`, body: entry.text,
      source_refs: [sourceId], occurred_at: at, region_ids: ['M1', 'M2'], primary_region: 'M2',
      attributes: { record_kind: 'generated_diary', delivery_status: delivery, native_ok: entry.ok ?? null, published_confirmed: false, visibility: entry.visibility ?? null } });
    counts.diary_entries++; if (delivery === 'simulated') counts.simulated_diaries++;
  }
  if (plain(capture.diary?.plan)) observations.push({ id: `observation:diary-plan:${hash(capture.diary.plan)}`, kind: 'diary_schedule_state', scope: 'aurabot:diary',
    raw: capture.diary.plan, execution_status: 'not_inferred_from_schedule' });
  for (const [index, entry] of list(capture.mood?.history).entries()) {
    if (!plain(entry)) continue;
    const p = part('aurabot:role-state'); const at = stamp(entry.at);
    const content = `角色表达状态记录：${entry.from ?? '未知'} → ${entry.to ?? '未知'}。${nonempty(entry.reason) ? `记录理由：${entry.reason}` : ''}`;
    const sourceId = addSource(p, { kind: 'mood', file: 'mood.json', locator: `history:${index}`, key: entry, value: entry, text: content, role: 'document', at });
    addMemory(p, ['mood', entry], { kind: 'experience', label: `${dateLabel(at)}的角色状态变化`, body: content,
      source_refs: [sourceId], occurred_at: at, region_ids: ['M1', 'M2'], primary_region: 'M2', review_status: 'ready', evidence_status: 'reported',
      attributes: { subject: 'bot_expression_state', from: entry.from ?? null, to: entry.to ?? null, proves_user_emotion: false } });
    counts.mood_entries++;
  }
  if (plain(capture.mood)) observations.push({ id: `observation:mood-current:${hash([capture.mood.at ?? null, capture.mood.value ?? null])}`, kind: 'current_role_state', scope: 'aurabot:role-state',
    occurred_at: stamp(capture.mood.at), value: capture.mood.value ?? null, reason: capture.mood.reason ?? '', reason_at: stamp(capture.mood.reasonAt), proves_user_emotion: false });

  for (const [collection, rows] of [['day', capture.vault?.days], ['month', capture.vault?.months]]) for (const row of list(rows)) {
    if (!nonempty(row.abstract) || row.digest === '-empty-') continue;
    const p = part(scopeOf(row.chatId)); const key = row.day ?? row.month; const at = stamp(row.updatedAt);
    const sourceId = addSource(p, { kind: `vault-${collection}`, file: 'modules-data/history-vault/vault.sqlite', locator: `vault_${collection === 'day' ? 'days' : 'months'}:${row.chatId}:${key}`,
      key: [row.chatId, key], value: row, text: row.abstract, role: 'assistant', at });
    addMemory(p, ['vault-summary', collection, key], { kind: 'conversation', label: `${key}的${collection === 'day' ? '日摘要' : '月印象'}`, body: row.abstract,
      source_refs: [sourceId], occurred_at: null, attributes: { period: key, summary_generated_at: at, original_evidence_aligned: false, source_store_limit: '400 lines per conversation/day' } });
    counts.vault_summaries++;
  }

  for (const [index, recall] of list(capture.recalls).entries()) {
    if (!plain(recall)) continue;
    const scope = /^(private|group):[^\s（(]+/.exec(String(recall.where ?? ''))?.[0] ?? 'aurabot:recall-unattributed';
    const shownKnown = Array.isArray(recall.shown); const shown = new Set(list(recall.shown).map(String));
    observations.push({ id: `run:aurabot:${hash(recall)}`, kind: 'legacy_recall', scope, occurred_at: stamp(recall.at), source_locator: `recall-log.json:${index}`,
      trigger: typeof recall.query === 'string' ? recall.query : '', where: String(recall.where ?? ''), request_inclusion: 'unknown', actual_use: 'unknown',
      candidates: list(recall.hits).map((hit) => {
        const match = nativeMemories.get(stableStringify([scope, String(hit.id)]));
        return { native_id: String(hit.id ?? ''), canonical_id: match?.id ?? null,
          text: match && typeof hit.text === 'string' ? hit.text : null,
          unavailable_reason: match ? null : 'no_current_memory_in_this_scope',
          raw_score: typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : null,
          reasons: match ? list(hit.why) : [], assembly: shownKnown ? (shown.has(String(hit.id)) ? 'legacy_shown' : 'not_shown') : 'unknown' };
      }) });
    counts.recall_entries++;
  }
  const output = [...partitions.values()].map((p) => ({ context: p.context, sources: [...p.sources.values()], memories: [...p.memories.values()], relations: [...p.relations.values()] }))
    .sort((a, b) => contextKey(a.context).localeCompare(contextKey(b.context)));
  return { mapping_version: MAPPING_VERSION, partitions: output, observations, report: { ...counts, contexts: output.length,
    source_records: output.reduce((n, p) => n + p.sources.length, 0), memory_objects: output.reduce((n, p) => n + p.memories.length, 0),
    relations: output.reduce((n, p) => n + p.relations.length, 0), issues,
    limitations: ['Legacy persona attribution is unavailable; no current persona was assigned retroactively.',
      'Conversation windows are time-based organization, not automatically understood semantic episodes.',
      'Legacy summaries and profiles are inferred, pending evidence alignment.',
      'Chatlog and vault may contain duplicate source observations; duplicates do not count as independent support.',
      'Legacy history is a current snapshot, not a reconstruction of original object versions.',
      'Source families are captured independently, not as one cross-database transaction.'] } };
}

export function createImportStore(mapped, { recordedAt }) {
  const store = new MemoryStore({ clock: () => recordedAt });
  for (const partition of mapped.partitions) {
    if (!partition.sources.length && !partition.memories.length) continue;
    const context = partition.context;
    const fingerprint = sha256(stableStringify(partition));
    store.transact({ context, command_id: `aurabot-snapshot:${fingerprint}`, request: { operation: 'aurabot_snapshot_import', mapping_version: mapped.mapping_version, partition_fingerprint: fingerprint } }, (_snapshot, at) => [
      ...partition.sources.map((record) => ({ entity_type: 'source', expected_revision: null, value: prepareSource(context, record, at) })),
      ...partition.memories.map((memory) => ({ entity_type: 'memory', expected_revision: null, value: prepareMemory(context, memory, at) })),
      ...partition.relations.map((relation) => ({ entity_type: 'relation', expected_revision: null, value: prepareRelation(context, relation, at) })),
    ]);
  }
  return store;
}
