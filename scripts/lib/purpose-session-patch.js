import {createHash} from 'node:crypto';

export const PURPOSE_SESSION_PATCH=Object.freeze({
  marker:'thinkstar-purpose-session-isolation-v1',
  version:'1.3.0-beta.1',
  file:'src/chat/hub.js',
  before_sha256:'fa813a9c286f0df371e776138fb28046f4fa5127a3d4979539dafc9f09f20440',
  after_sha256:'ea73bb734dde25f1421cc17396567c2327776d7477257e8a6c281b1b5e73573e',
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const helper=String.raw`  // thinkstar-purpose-session-isolation-v1: opt-in history rotation; never deletes a session or QQ history.
  async function freshSystemHistory(chatId) {
    const mode = getConfig().debug ? 'debug' : 'live'
    const sessionOf = entry => entry && ((entry.sessions && entry.sessions[mode]) || ((entry.mode || 'live') === mode ? entry.sessionId : ''))
    const sessionId = sessionOf(map().chats[chatId])
    if (!sessionId) return
    const key = sessionKey(sessionId)
    const agent = await resolveAgent(sessionId)
    if (typeof agent.whenIdle !== 'function') throw new Error('宿主没有等待旧后台会话停止的能力')
    let timer
    try {
      await Promise.race([
        Promise.resolve().then(() => agent.whenIdle()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待旧后台会话停止超时')), 15_000) }),
      ])
    } finally { clearTimeout(timer) }
    assertActive()
    if (sessionOf(map().chats[chatId]) !== sessionId) throw new Error('后台会话映射已改变，取消本轮')
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (typeof reg?.archiveSession !== 'function') throw new Error('宿主没有归档会话的能力')
    if (!(reg.archivedSessionIds || []).includes(sessionId)) {
      const archived = await reg.archiveSession(sessionId)
      if (archived === false || archived?.ok === false) throw new Error(archived?.message || '归档旧后台会话失败')
    }
    assertActive()
    const m = map(), entry = m.chats[chatId]
    if (sessionOf(entry) !== sessionId) throw new Error('后台会话映射已改变，取消本轮')
    const rec = mounted.get(key)
    if (rec) { unmount(rec); mounted.delete(key) }
    sessionToChat.delete(key)
    sessionTarget.delete(key)
    turnState.delete(key)
    historySeeded.delete(key)
    clearSlowNotices(key)
    slowNoticeSent.delete(key)
    outputSources.delete(chatId)
    const sessions = { ...(entry.sessions || {}) }
    for (const [name, id] of Object.entries(sessions)) if (id === sessionId) delete sessions[name]
    m.chats[chatId] = { ...entry, sessions, ...(entry.sessionId === sessionId ? { sessionId: '' } : {}) }
    saveMap(m)
    systemTurns.delete(chatId)
    log.info?.(chatId + '：旧后台历史已归档，本轮使用新会话')
  }

`;
function replaceOnce(source,before,after){
  if(source.split(before).length!==2)throw Error('Purpose session patch anchor is not unique');
  return source.replace(before,after);
}

/** Pure, hash-bound transformation. No host data is read, changed or removed. */
export function patchPurposeSession(source,{version}={}){
  if(version!==PURPOSE_SESSION_PATCH.version)throw Error('Unreviewed purpose session host version');
  if(typeof source!=='string')throw Error('Purpose session source must be UTF-8 text');
  const before=sha(source);
  if(PURPOSE_SESSION_PATCH.after_sha256&&before===PURPOSE_SESSION_PATCH.after_sha256)return {source,changed:false};
  if(before!==PURPOSE_SESSION_PATCH.before_sha256)throw Error('Unreviewed purpose session source hash');
  let next=replaceOnce(source,'  /** 后台任务（写日记、主动搭话的草稿）：在专用会话里跑一轮，拿到正文但不自动转发。',helper+'  /** 后台任务（写日记、主动搭话的草稿）：在专用会话里跑一轮，拿到正文但不自动转发。');
  next=replaceOnce(next,"async function runSystemTurn(name, title, prompt, { timeoutMs = 180000, noTools = false, key: scope = '', presetId = '', level: levelName = '', model = null } = {})", "async function runSystemTurn(name, title, prompt, { timeoutMs = 180000, noTools = false, key: scope = '', presetId = '', level: levelName = '', model = null, freshHistory = false } = {})");
  next=replaceOnce(next,'      } else if (current) systemTurns.delete(chat.chatId)\n      const { agent, sessionId } = await agentFor(chat)',`      } else if (current) systemTurns.delete(chat.chatId)
      if (freshHistory === true) {
        try { await freshSystemHistory(chat.chatId) } catch (error) {
          if (!disposed) systemFailed(chat.chatId)
          throw error
        }
      }
      const { agent, sessionId } = await agentFor(chat)`);
  next=replaceOnce(next,'    get ownerReplyPatchVersion() { return "thinkstar-owner-reply-boundaries-v1" },','    get ownerReplyPatchVersion() { return "thinkstar-owner-reply-boundaries-v1" },\n    get purposeSessionPatchVersion() { return 1 },');
  if(PURPOSE_SESSION_PATCH.after_sha256&&sha(next)!==PURPOSE_SESSION_PATCH.after_sha256)throw Error('Purpose session patch result hash mismatch');
  return {source:next,changed:true};
}
