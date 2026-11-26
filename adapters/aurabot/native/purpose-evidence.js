/** Purpose-only provenance helpers. No I/O, model calls, or changes to host memory. */
const KINDS = new Set(['source', 'historical', 'self-intent', 'assistant-claim', 'legacy-unverified', 'model-thought']);
const trim = (value, size = 240) => String(value ?? '').slice(0, size);
const stamp = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function reference(raw) {
  if (!plain(raw)) return null;
  const id = trim(raw.id, 120), source = trim(raw.source, 32);
  if (!id || !source || ['memo', 'goal', 'purpose', 'pending', 'persona'].includes(source)) return null;
  return { id, source, text: trim(raw.text), spokenAt: stamp(raw.spokenAt ?? raw.at),
    recordedAt: stamp(raw.recordedAt), recalledAt: stamp(raw.recalledAt), eventAt: stamp(raw.eventAt),
    validFrom: stamp(raw.validFrom), validUntil: stamp(raw.validUntil), invalidAt: stamp(raw.invalidAt),
    about: trim(raw.about, 80), speaker: trim(raw.speaker, 80), chatId: trim(raw.chatId, 120),
    role: ['owner', 'member', 'self', 'memory', 'media'].includes(raw.role) ? raw.role : '',
  };
}

export function normalizeProvenance(raw, fallback = 'legacy-unverified') {
  const p = plain(raw) ? raw : {};
  const refs = (Array.isArray(p.refs) ? p.refs : []).map(reference).filter(Boolean)
    .filter((r, i, all) => all.findIndex(other => other.id === r.id && other.source === r.source) === i).slice(-8);
  let kind = KINDS.has(p.kind) ? p.kind : fallback;
  if (['source', 'historical'].includes(kind) && !refs.length) kind = 'legacy-unverified';
  return { kind, basisKind: KINDS.has(p.basisKind) ? p.basisKind : kind,
    spokenAt: stamp(p.spokenAt), recordedAt: stamp(p.recordedAt), recalledAt: stamp(p.recalledAt),
    eventAt: stamp(p.eventAt), validFrom: stamp(p.validFrom), validUntil: stamp(p.validUntil), invalidAt: stamp(p.invalidAt),
    about: trim(p.about, 80), speaker: trim(p.speaker, 80), chatId: trim(p.chatId, 120), refs };
}

export function sourceReferences(item, { now = Date.now(), includeHistorical = false } = {}) {
  const p = normalizeProvenance(item?.provenance);
  return p.refs.filter(r => r.role !== 'self' && (includeHistorical || (
    p.kind !== 'historical' && p.basisKind !== 'historical' && !p.invalidAt && (!p.validFrom || p.validFrom <= now)
    && (!p.validUntil || p.validUntil > now) && !r.invalidAt && (!r.validFrom || r.validFrom <= now)
    && (!r.validUntil || r.validUntil > now))));
}

export function selfWish(text) {
  const t = String(text || '');
  return /想(?:和主人|跟主人|陪主人|聊|玩|学|创作|分享|一起)|想问主人最近在玩什么|聊聊我自己/.test(t)
    && !/主人.{0,16}(?:做了|去了|说过|刚|昨天|今天|手术|生病|面试|考试|买了|结果|完成|恢复)|我(?:刚|已经|昨天|今天).{0,12}(?:做|去|看|买|完成|收到)/.test(t);
}

export function materialProvenance(material, now = Date.now()) {
  if (plain(material?.provenance)) return normalizeProvenance(material.provenance);
  const m = material || {};
  const times = { spokenAt: stamp(m.spokenAt ?? m.at), recordedAt: stamp(m.recordedAt),
    recalledAt: stamp(m.recalledAt), eventAt: stamp(m.eventAt), validFrom: stamp(m.validFrom),
    validUntil: stamp(m.validUntil), invalidAt: stamp(m.invalidAt), about: m.about, speaker: m.speaker,
    chatId: m.chatId || m.meta?.key || '' };
  const expired = times.invalidAt || times.validUntil && times.validUntil <= now || times.validFrom > now;
  const rawRoles = m.source_roles ?? m.sourceRoles ?? m.speakerRole ?? m.sourceRole ?? m.authorRole ?? [];
  const roles = (Array.isArray(rawRoles) ? rawRoles : [rawRoles]).map(value => String(value).toLowerCase());
  const originalSource = String(m.originalSource || '').toLowerCase();
  const isSelf = m.kind === 'self' || originalSource === 'diary' || roles.some(role => ['assistant', 'bot', 'ai'].includes(role));
  const modelMemory = m.source === 'memory' && originalSource && !['said', 'manual', 'event'].includes(originalSource);
  const isThought = modelMemory || m.source === 'thought' || m.kind === 'thought' && m.source !== 'bili';
  const known = ['qq', 'memory', 'bili', 'rss', 'web'].includes(m.source);
  const kind = isSelf ? 'assistant-claim' : isThought ? 'model-thought' : !known ? 'legacy-unverified'
    : expired || m.kind === 'memory' ? 'historical' : 'source';
  const ref = ['source', 'historical', 'assistant-claim'].includes(kind) ? reference({ ...times, id: m.id, source: m.source, text: m.text,
    role: isSelf ? 'self' : m.kind === 'owner' ? 'owner' : m.kind === 'member' ? 'member' : m.source === 'memory' ? 'memory' : 'media' })
    : null;
  return normalizeProvenance({ ...times, kind, refs: ref ? [ref] : [] });
}

export function groundCollectedMaterials(result, options = {}) {
  const now = options.now ?? Date.now();
  const memories = new Map((options.memoryRecords || []).map(m => [`mem:${m.id ?? ''}`, m]));
  return { ...result, items: result.items.map(item => {
    const raw = memories.get(item.id);
    const mapped = raw ? { ...item, spokenAt: stamp(raw.spokenAt), recordedAt: stamp(raw.recordedAt ?? raw.createdAt),
      recalledAt: stamp(raw.recalledAt ?? raw.lastSeenAt), eventAt: stamp(raw.eventAt), validFrom: raw.validFrom,
      validUntil: raw.validUntil, invalidAt: raw.invalidAt, about: raw.about, speaker: raw.speaker, chatId: raw.chatId,
      originalSource: raw.originalSource || raw.source,
      source_roles: raw.source_roles ?? raw.sourceRoles, speakerRole: raw.speakerRole, sourceRole: raw.sourceRole, authorRole: raw.authorRole } : item;
    const provenance = materialProvenance(mapped, now);
    // Selection can use lastHit, but never present a retrieval as the event occurring now.
    return { ...mapped, at: raw ? provenance.spokenAt || provenance.recordedAt : item.at, provenance };
  }) };
}

export function restoreEvidenceMetadata(normalized, original) {
  const raw = original || {};
  const provenance = normalizeProvenance(raw.provenance,
    raw.source === 'persona' ? 'self-intent' : 'legacy-unverified');
  return { ...normalized, provenance, groundedText: trim(raw.groundedText, 120), draftText: trim(raw.draftText, 120),
    evidence: Array.isArray(normalized?.evidence) ? normalized.evidence.map((e, i) => ({ ...e,
      provenance: normalizeProvenance(raw.evidence?.find(other => other?.id === e.id)?.provenance ?? raw.evidence?.[i]?.provenance) })) : normalized?.evidence };
}

export function restorePurposeState(state, raw, now = Date.now()) {
  if (Number(raw?.version) > 2) throw Error('Unsupported future purpose state version');
  const find = (items, item) => (items || []).find(other => other?.id === item.id) || item;
  state.version = 2;
  state.pending = state.pending.map(item => restoreEvidenceMetadata(item, find(raw?.pending, item)));
  state.history = state.history.map((item, i) => ({ ...item,
    provenance: normalizeProvenance(raw?.history?.find(other => other?.at === item.at && other?.sourceId === item.sourceId)?.provenance ?? raw?.history?.[i]?.provenance) }));
  return state;
}

function evidenceProvenance(goal) {
  if (plain(goal?.provenance) && goal.provenance.kind !== 'legacy-unverified') return normalizeProvenance(goal.provenance);
  // Host candidates expose a display string here; only goal records have evidence arrays.
  const evidence = (Array.isArray(goal?.evidence) ? goal.evidence : []).map(e => normalizeProvenance(e.provenance));
  const refs = evidence.flatMap(p => p.refs);
  if (refs.length) return normalizeProvenance({ ...evidence[0], refs });
  return normalizeProvenance(goal?.provenance, goal?.source === 'persona' ? 'self-intent' : 'legacy-unverified');
}

export function groundGoals(result, options = {}) {
  const prior = new Map((options.goals || []).map(g => [g.id, g]));
  const materials = new Map((options.materials || []).map(m => [m.id, m]));
  result.goals = result.goals.map(goal => {
    const evidence = goal.evidence.map(e => ({ ...e, provenance: materials.has(e.id)
      ? materialProvenance(materials.get(e.id), options.now) : normalizeProvenance(e.provenance) }));
    let next = { ...goal, evidence };
    next.provenance = evidenceProvenance(next);
    const before = prior.get(goal.id);
    const identity = e => `${e.id}|${e.text}|${e.at}`;
    if (before && goal.source !== 'persona' && !evidence.some(e => !(before.evidence || []).some(old => identity(old) === identity(e)))) {
      next.lastSeenAt = before.lastSeenAt;
      next.expiresAt = before.expiresAt;
    }
    return next;
  });
  return result;
}

export function groundSeeds(seeds, materials = [], now = Date.now()) {
  const map = new Map(materials.map(m => [m.id, m]));
  return seeds.map(seed => ({ ...seed, provenance: map.has(seed.sourceId)
    ? materialProvenance(map.get(seed.sourceId), now) : normalizeProvenance(seed.provenance) }));
}

export function usablePending(item, now = Date.now()) {
  return Boolean(item?.text) && (!stamp(item.expiresAt) || stamp(item.expiresAt) > now);
}

const COMPANION = '想和主人聊一会儿，听听主人现在想聊什么';
export function pendingForSelection(item, now = Date.now()) {
  if (!usablePending(item, now)) return null;
  const provenance = normalizeProvenance(item.provenance);
  if (sourceReferences(item, { now }).length && item.groundedText) return { ...item, text: item.groundedText, provenance };
  const historicalRefs = sourceReferences(item, { now, includeHistorical: true }).filter(ref => !ref.invalidAt && (!ref.validFrom || ref.validFrom <= now));
  if (historicalRefs.length && !provenance.invalidAt && (!provenance.validFrom || provenance.validFrom <= now)) {
    return { ...item, text: '想和主人回忆一下过去聊过的事', need: 'connect', action: 'share', kind: 'share', evidence: '',
      provenance: normalizeProvenance({ ...provenance, kind: 'historical', basisKind: 'historical', refs: historicalRefs }) };
  }
  if (selfWish(item.text)) return { ...item, provenance: normalizeProvenance({ ...provenance, kind: 'self-intent' }) };
  // Keep the original entry for review; an unsupported personal event becomes a harmless wish to talk.
  return { ...item, text: COMPANION, need: 'connect', action: 'ask', kind: 'ask', evidence: '',
    provenance: normalizeProvenance({ kind: 'self-intent' }) };
}

export function candidateProvenance(item) {
  return evidenceProvenance(item);
}

export function groundSelection(result, options = {}) {
  const items = [...(options.seeds || []), ...(options.pending || []), ...(options.goals || [])];
  const byId = new Map(items.map(item => [item.id, item]));
  const convert = c => c ? { ...c, provenance: candidateProvenance(byId.get(c.id) || byId.get(c.goalId) || c) } : c;
  const candidates = result.candidates.map(convert);
  return { ...result, candidates, purpose: result.purpose ? candidates.find(c => c.id === result.purpose.id) || convert(result.purpose) : null };
}

export function outcomeProvenance(state, options = {}) {
  const planned = options.planned || {};
  const provenance = candidateProvenance(planned);
  const draft = options.memo?.followUp || options.memo?.purpose || '';
  for (const pending of state.pending || []) {
    if (!draft) continue;
    if (pending.createdAt !== options.now && pending.text !== draft) continue;
    pending.provenance = normalizeProvenance({ ...provenance, kind: 'model-thought', basisKind: provenance.basisKind || provenance.kind });
    pending.draftText = trim(pending.text, 120);
    pending.groundedText = sourceReferences(planned, { now: options.now, includeHistorical: true }).length ? trim(planned.text, 120) : '';
  }
  const latest = state.history?.at(-1);
  if (latest) latest.provenance = normalizeProvenance({ ...provenance, kind: 'model-thought' });
  return state;
}

function dateText(value) {
  if (!stamp(value)) return '未知';
  const d = new Date(Number(value));
  const pad = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function materialTimeNote(material) {
  const p = materialProvenance(material);
  if (material?.kind !== 'memory' && p.kind !== 'assistant-claim') return '';
  return `（原话时间:${dateText(p.spokenAt)}；事件发生时间:${dateText(p.eventAt)}；`
    + (p.validUntil ? `有效截至:${dateText(p.validUntil)}；` : '')
    + (p.validFrom ? `生效时间:${dateText(p.validFrom)}；` : '')
    + `${p.kind === 'assistant-claim' ? '你的历史发言，不能证明事情发生或完成' : '历史记忆；最近想起不等于最近发生'}）`;
}

export function groundingPrompt({ selected, materials = [] } = {}) {
  const p = candidateProvenance(selected);
  const refs = p.refs.map(r => `- ${r.id} [${r.source}/${r.role || '来源'}] 原话时间 ${dateText(r.spokenAt)}；事件时间 ${dateText(r.eventAt)}：${r.text}`).join('\n');
  return '\n【事实与时间边界】\n'
    + '只有本轮列出的原始来源能支持事实；目标假设、待续、人格、你的历史发言和模型备忘都不能证明外部事件发生或完成。\n'
    + '原话/记录/召回时间不是事件发生时间；不知道发生时间就不说刚刚、今天或正在发生。历史与过期内容只能明确作为过去的回忆，不据此催问当前状态。\n'
    + '可以自然表达此刻想聊、想玩、好奇等自我意愿；不用为陪伴编造经历、身体行动、主人计划或他人近况。\n'
    + `本次候选来源性质：${p.kind}。\n`
    + (refs ? `可回查的来源（只支持原话明确写出的内容）：\n${refs}\n` : '本次没有可核实的外部事件来源，只表达自己的想法或普通陪伴，不引入具体已发生事件。\n');
}

export function preparePurposePrompt(options = {}) {
  const now = options.now ?? Date.now();
  const safePending = (options.pending || []).map(p => pendingForSelection(p, now)).filter(Boolean);
  return { ...options, pending: safePending };
}

export function limitPurposePrompt(body, boundary, limit) {
  const max = Math.max(4000, Number(limit) || 16000);
  if (body.length + boundary.length <= max) return body + boundary;
  const budget = Math.max(0, max - boundary.length - 30);
  return body.slice(0, Math.floor(budget * 0.55)) + '\n[较低优先级背景已省略]\n'
    + body.slice(-Math.floor(budget * 0.45)) + boundary;
}
