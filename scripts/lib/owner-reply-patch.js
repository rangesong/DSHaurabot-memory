import {createHash} from 'node:crypto';

export const OWNER_REPLY_PATCH=Object.freeze({
  marker:'thinkstar-owner-reply-boundaries-v1',
  version:'1.3.0-beta.1',
  file:'src/chat/hub.js',
  before_sha256:'c6b6efedec2c929a92f1b51bc4224cee1550188fdd6bdca857a9e9d5c8433325',
  previous_sha256:'0fbb83d24d74ed1aad3be89e3d0c60d850d1b18c4e3f903eabb4a8b01e11af27',
  after_sha256:'fa813a9c286f0df371e776138fb28046f4fa5127a3d4979539dafc9f09f20440',
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const helpers=String.raw`  // thinkstar-owner-reply-boundaries-v1: retain completed answers to consumed owner input, never send during generation.
  function ownerReplyContextCurrent(chatId, key, token, persona) {
    const cfg = getConfig()
    return !disposed && !cfg.chat?.everyStep && chatId === 'private:' + cfg.ownerQQ
      && token && busyTurns.get(chatId) === token && token.signature === turnSignature(chatId)
      && String(cfg.persona?.current || '') === persona && isCurrentSession(chatId, key)
  }
  function ownerReplyRunning(chatId, key, st, batch) {
    return batch && !st.system && st.turnToken === batch.token && st.noticeTurn === batch.turn
      && running.get(chatId) === key && ownerReplyContextCurrent(chatId, key, batch.token, batch.persona)
  }
  function beginOwnerReplyBatch(chatId, key, st, turn) {
    const token = st.turnToken, persona = String(getConfig().persona?.current || '')
    if (!Number.isSafeInteger(turn) || st.system || running.get(chatId) !== key
      || !ownerReplyContextCurrent(chatId, key, token, persona)) { st.ownerReplyBatch = null; return }
    if (st.ownerReplyBatch?.turn === turn && st.ownerReplyBatch.token === token) return
    st.ownerReplyBatch = { turn, token, persona, parts: [], sealed: new Set(), boundaries: new Set(), observed: 0, candidate: null }
  }
  function sealOwnerReply(chatId, key, st, data) {
    const batch = st.ownerReplyBatch, src = data?.source
    if (!ownerReplyRunning(chatId, key, st, batch) || src?.kind !== 'aurabot'
      || src.speaker?.role !== 'owner' || src.speaker?.chat !== 'private'
      || data.role !== 'user' || !Array.isArray(data.content) || !data.content.length
      || typeof data.id !== 'string' || !data.id || batch.boundaries.has(data.id)) return
    batch.boundaries.add(data.id)
    const candidate = batch.candidate
    batch.candidate = null
    if (candidate && candidate.turn === batch.turn && !batch.sealed.has(candidate.key)) {
      batch.parts.push(candidate)
      batch.sealed.add(candidate.key)
    }
  }
  function observeOwnerReply(chatId, key, st, event, text) {
    const batch = st.ownerReplyBatch, d = event.data || {}
    if (!ownerReplyRunning(chatId, key, st, batch) || d.turn !== batch.turn) return
    if (!text || d.interrupted) { batch.candidate = null; return }
    const id = Number.isSafeInteger(event.seq) ? 'event:' + event.seq
      : typeof d.message?.id === 'string' ? 'message:' + d.message.id
      : Number.isSafeInteger(d.step) ? 'step:' + d.step : 'observation:' + ++batch.observed
    batch.candidate = { turn: d.turn, key: id, text }
  }
  function finishOwnerReplies(st, turn, fallback, completed, current) {
    const batch = st.ownerReplyBatch
    if (!batch) return fallback
    st.ownerReplyBatch = null
    if (!completed || !current || batch.turn !== turn) return ''
    const parts = [...batch.parts]
    if (batch.candidate && !batch.sealed.has(batch.candidate.key)) parts.push(batch.candidate)
    return parts.map(part => part.text).filter((text, index, all) => !index || text !== all[index - 1]).join('\n\n')
  }

`;

function replaceOnce(source,before,after){
  if(source.split(before).length!==2)throw Error('Owner reply patch anchor is not unique');
  return source.replace(before,after);
}

/** Exact installed-host transformation; never reads or writes host state. */
export function patchOwnerReplies(source,{version}={}){
  if(version!==OWNER_REPLY_PATCH.version)throw Error('Unsupported Aurabot owner-reply version');
  if(typeof source!=='string')throw Error('Owner reply source must be UTF-8 text');
  const before=sha(source);
  if(before===OWNER_REPLY_PATCH.after_sha256)return {source,receipt:{...OWNER_REPLY_PATCH,input_sha256:before,unchanged:true}};
  if(![OWNER_REPLY_PATCH.before_sha256,OWNER_REPLY_PATCH.previous_sha256].includes(before))throw Error('Unrecognized Aurabot owner-reply source hash');
  let next=source;
  if(before===OWNER_REPLY_PATCH.before_sha256){
  next=replaceOnce(next,'  function onSessionEvent(session, event) {',helpers+'  function onSessionEvent(session, event) {');
  next=replaceOnce(next,'      st.noticeTurn = event.data?.turn','      st.noticeTurn = event.data?.turn\n      beginOwnerReplyBatch(chatId, key, st, st.noticeTurn)');
  next=replaceOnce(next,'      const src = event.data && event.data.source','      sealOwnerReply(chatId, key, st, event.data)\n      const src = event.data && event.data.source');
  next=replaceOnce(next,"    if (event.type === 'tool/call') {","    if (event.type === 'tool/call') {\n      if (st.ownerReplyBatch) st.ownerReplyBatch.candidate = null");
  next=replaceOnce(next,'      if (d.interrupted) return','      if (d.interrupted) {\n        observeOwnerReply(chatId, key, st, event, \'\')\n        return\n      }');
  next=replaceOnce(next,'      const raw = assistantReplyText(d.message)','      const raw = assistantReplyText(d.message)\n      observeOwnerReply(chatId, key, st, event, raw)');
  next=replaceOnce(next,'      const turnToken = st.turnToken\n      clearRunning(chatId, key)','      const turnToken = st.turnToken\n      const ownerReplyBatch = st.ownerReplyBatch\n      const ownerReplyValid = ownerReplyRunning(chatId, key, st, ownerReplyBatch)\n      const ownerReplyIsCurrent = ownerReplyBatch ? () => ownerReplyContextCurrent(chatId, key, ownerReplyBatch.token, ownerReplyBatch.persona) : undefined\n      clearRunning(chatId, key)');
  next=replaceOnce(next,"      let text = st.lastTurn === d.turn ? st.text : ''","      let text = st.lastTurn === d.turn ? st.text : ''\n      text = finishOwnerReplies(st, d.turn, text, completed, ownerReplyValid)");
  next=replaceOnce(next,'      if (!text && completed && getConfig().chat?.rescueFromThinking && st.thinking && st.thinking.turn === d.turn) {','      if (!text && !ownerReplyBatch && completed && getConfig().chat?.rescueFromThinking && st.thinking && st.thinking.turn === d.turn) {');
  next=replaceOnce(next,"const sendLast = () => deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true, onDelivered })","const sendLast = () => deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true, onDelivered, isCurrent: ownerReplyIsCurrent })");
  }
  next=replaceOnce(next,'  return {\n    dispose,\n    // 给模块用的出站清洗','  return {\n    // Read-only runtime identity also survives the module-scoped hub facade.\n    get ownerReplyPatchVersion() { return '+JSON.stringify(OWNER_REPLY_PATCH.marker)+' },\n    dispose,\n    // 给模块用的出站清洗');
  const after=sha(next);
  if(after!==OWNER_REPLY_PATCH.after_sha256)throw Error('Patched owner-reply source hash mismatch: '+after);
  return {source:next,receipt:{...OWNER_REPLY_PATCH,input_sha256:before,unchanged:false}};
}
