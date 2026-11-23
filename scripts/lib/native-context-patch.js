import {createHash} from 'node:crypto';

export const NATIVE_CONTEXT_PATCH=Object.freeze({
  marker:'thinkstar-native-context-review-v1',version:'1.3.0-beta.1',
  file:'modules/memory/index.mjs',dependency:'modules/memory/context-review.js',
  dependencySource:'adapters/aurabot/native/context-review.js',
  before_sha256:'077c2b1b8f1f41d7bb73824096d09c89535cd67ade49c775d7dc81be3dec5cf0',
  previous_sha256:'ae21a818b0add95a465116a7ba4680229cab612cfb966c511ea1d883c08114be',
  after_sha256:'89bc355c123d0ea035cd3dc79584900baeb5832a93de8882568d9e378ab515f8',
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const maintenance=String.raw`
    // thinkstar-native-context-review-v1: explicit local maintenance, never offered as an LLM tool.
    const nativeReviewReceiptDir = api.dataDir('context-review-receipts')
    const nativeReviewFailure = error => typeof error?.code === 'string' && /^context-review-[a-z-]+$/.test(error.code) ? error.code : 'context-review-failed'
    const writeNativeReviewReceipt = (file, value, prepared = false) => {
      mkdirSync(nativeReviewReceiptDir, { recursive: true })
      const text = JSON.stringify(value, null, 2) + '\n'
      if (prepared) writeFileSync(file, text, { flag: 'wx', mode: 0o600 })
      else { const temp = file + '.' + randomUUID() + '.tmp'; writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
    }
    api.route('/maintenance/context-review', async req => {
      if (req.method !== 'POST') return { ok: false, code: 'context-review-post-required' }
      let receiptPath = '', prepared
      try {
        const body = await http.body(req)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['plan', 'apply', 'expectedHash'].includes(key))
          || (body.apply !== undefined && typeof body.apply !== 'boolean')) throw Object.assign(new Error(), { code: 'context-review-invalid-request' })
        const cfg = api.config(), owner = String(cfg.ownerQQ || ''), persona = String(cfg.persona?.current || '')
        const preview = reviewNativeContext(memory, body.plan, { owner, persona })
        if (body.apply !== true) return { ok: true, ...preview }
        if (body.expectedHash !== preview.snapshotHash) throw Object.assign(new Error(), { code: 'context-review-stale-snapshot' })
        receiptPath = api.dataDir('context-review-receipts', 'review-' + randomUUID() + '.json')
        prepared = { schema: 1, kind: 'native-context-review', status: 'prepared', at: Date.now(), plan: body.plan, expectedHash: body.expectedHash, before: preview.before, after: preview.after, limitations: preview.limitations }
        writeNativeReviewReceipt(receiptPath, prepared, true)
        const result = reviewNativeContext(memory, body.plan, { owner, persona, apply: true, expectedHash: body.expectedHash })
        try { writeNativeReviewReceipt(receiptPath, { ...prepared, status: 'applied', completedAt: Date.now(), result }) }
        catch { return { ok: false, code: 'context-review-receipt-finalization-failed', receiptPath, preparedReceiptRetained: true } }
        return { ok: true, ...result, receiptPath }
      } catch (error) {
        const code = nativeReviewFailure(error)
        if (receiptPath) try { writeNativeReviewReceipt(receiptPath, { ...prepared, status: 'failed', completedAt: Date.now(), code, rollback: error?.rollback || null }) } catch {}
        return { ok: false, code, ...(receiptPath ? { receiptPath, rollback: error?.rollback || null } : {}) }
      }
    }, { access: 'panel' })

    let nativeHostReloadPending = false
    const nativeHostStatus = async () => {
      const manager = api.dsh?.get?.('pluginManager')
      if (!manager || typeof manager.listPlugins !== 'function' || typeof manager.setPluginEnabled !== 'function') return { ok: false, code: 'host-maintenance-manager-unavailable' }
      const plugins = await manager.listPlugins(), rows = Array.isArray(plugins) ? plugins.filter(row => row.moduleName === 'dsh-aurabot-qq') : []
      if (rows.length !== 1) return { ok: false, code: 'host-maintenance-ambiguous-entry' }
      const row = rows[0], all = api.dsh?.get?.('agents')?.list?.(), ownershipKnown = Array.isArray(all) && typeof hub.chatOfSession === 'function'
      const agents = ownershipKnown ? all.filter(agent => agent?.session?.id && hub.chatOfSession(agent.session.id)).map(agent => {
        const inbox = agent.inbox, inboxKnown = typeof inbox?.hasPending === 'boolean' && Array.isArray(inbox?.nextStep) && Array.isArray(inbox?.nextTurn)
        return { status: String(agent.status || ''), inboxKnown, hasPending: inboxKnown ? inbox.hasPending : null,
          nextStep: inboxKnown ? inbox.nextStep.length : null, nextTurn: inboxKnown ? inbox.nextTurn.length : null,
          idle: agent.status === 'idle' && inboxKnown && !inbox.hasPending && inbox.nextStep.length === 0 && inbox.nextTurn.length === 0 }
      }) : []
      const ownerReplyPatchLoaded = hub.ownerReplyPatchVersion === 'thinkstar-owner-reply-boundaries-v1'
      return { ok: true, hmrAvailable: !!api.dsh?.get?.('hmr'), ownerReplyPatchLoaded, ownershipKnown, quiescent: ownershipKnown && agents.every(agent => agent.idle),
        pending: nativeHostReloadPending, aurabot: { entryId: row.entryId, patchId: row.patchId, enabled: row.enabled, readOnlyReason: row.readOnlyReason || null }, agents }
    }
    api.route('/maintenance/host-status', async req => {
      if (req.method !== 'GET') return { ok: false, code: 'host-maintenance-get-required' }
      try { return await nativeHostStatus() } catch { return { ok: false, code: 'host-maintenance-status-failed' } }
    }, { access: 'panel' })
    api.route('/maintenance/host-reload', async req => {
      if (req.method !== 'POST') return { ok: false, code: 'host-maintenance-post-required' }
      let receiptPath = '', prepared
      try {
        const body = await http.body(req)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.id !== 'string') return { ok: false, code: 'host-maintenance-invalid-request' }
        if (nativeHostReloadPending) return { ok: false, code: 'host-maintenance-reload-pending' }
        const state = await nativeHostStatus()
        if (!state.ok || body.id !== state.aurabot.entryId || state.aurabot.enabled !== true || state.aurabot.readOnlyReason) return { ok: false, code: 'host-maintenance-entry-refused' }
        if (!state.quiescent) return { ok: false, code: 'host-maintenance-owned-agents-busy' }
        if (nativeHostReloadPending) return { ok: false, code: 'host-maintenance-reload-pending' }
        const manager = api.dsh.get('pluginManager')
        receiptPath = api.dataDir('context-review-receipts', 'host-reload-' + randomUUID() + '.json')
        prepared = { schema: 1, kind: 'aurabot-official-host-reload', status: 'prepared', at: Date.now(), entryId: body.id, before: state }
        writeNativeReviewReceipt(receiptPath, prepared, true)
        nativeHostReloadPending = true
        // Capture the writer and path before official HMR disposes this module. No module timer or model request.
        const finish = value => { try { writeNativeReviewReceipt(receiptPath, { ...prepared, ...value, completedAt: Date.now() }) } catch {} }
        Promise.resolve().then(async () => {
          const latest = await nativeHostStatus()
          if (!latest.ok || !latest.quiescent || latest.aurabot.entryId !== body.id || latest.aurabot.enabled !== true || latest.aurabot.readOnlyReason) return { status: 'blocked', code: 'host-maintenance-preconditions-changed' }
          const result = await manager.setPluginEnabled(body.id, true)
          return { status: 'settled', result }
        }).then(finish, () => finish({ status: 'failed', code: 'host-maintenance-reload-failed' })).finally(() => { nativeHostReloadPending = false })
        return { ok: true, accepted: true, receiptPath }
      } catch {
        return { ok: false, code: 'host-maintenance-preparation-failed', ...(receiptPath ? { receiptPath } : {}) }
      }
    }, { access: 'panel' })
`;
function replaceOnce(source,before,after){if(source.split(before).length!==2)throw Error('Native context patch anchor is not unique');return source.replace(before,after);}
export function patchNativeContextReview(source,{version}={}){
  if(version!==NATIVE_CONTEXT_PATCH.version)throw Error('Unsupported Aurabot native-context version');
  if(typeof source!=='string')throw Error('Native context source must be UTF-8 text');
  const before=sha(source);if(before===NATIVE_CONTEXT_PATCH.after_sha256)return {source,receipt:{...NATIVE_CONTEXT_PATCH,input_sha256:before,unchanged:true}};
  if(before===NATIVE_CONTEXT_PATCH.previous_sha256){
    const next=replaceOnce(source,"      const eventHandler = typeof hub.onSessionEvent === 'function' ? Function.prototype.toString.call(hub.onSessionEvent) : ''\n      const ownerReplyPatchLoaded = eventHandler.includes('beginOwnerReplyBatch(') && eventHandler.includes('finishOwnerReplies(') && eventHandler.includes('sealOwnerReply(')","      const ownerReplyPatchLoaded = hub.ownerReplyPatchVersion === 'thinkstar-owner-reply-boundaries-v1'");
    const after=sha(next);if(after!==NATIVE_CONTEXT_PATCH.after_sha256)throw Error('Patched native-context source hash mismatch: '+after);
    return {source:next,receipt:{...NATIVE_CONTEXT_PATCH,input_sha256:before,unchanged:false}};
  }
  if(before!==NATIVE_CONTEXT_PATCH.before_sha256)throw Error('Unrecognized native-context source hash');
  let next=replaceOnce(source,"import { createMemoryStore, memoryLine, looksLikeRuleMemory, parseValidityDate } from './memory.js'","import { createMemoryStore, memoryLine, looksLikeRuleMemory, parseValidityDate } from './memory.js'\nimport { reviewNativeContext } from './context-review.js'\nimport { randomUUID } from 'node:crypto'");
  next=replaceOnce(next,"import { readFileSync, writeFileSync } from 'node:fs'","import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'");
  next=replaceOnce(next,"    memory.list('') // 启动时完成旧 JSON 迁移，不必等第一条聊天或打开面板。","    memory.list('') // 启动时完成旧 JSON 迁移，不必等第一条聊天或打开面板。\n"+maintenance);
  const after=sha(next);if(after!==NATIVE_CONTEXT_PATCH.after_sha256)throw Error('Patched native-context source hash mismatch: '+after);
  return {source:next,receipt:{...NATIVE_CONTEXT_PATCH,input_sha256:before,unchanged:false}};
}
