import {createHash} from 'node:crypto';

export const AUTOTELIC_CORRECTNESS_PATCH=Object.freeze({
  marker:'thinkstar-autotelic-correctness-v1',
  version:'1.3.0-beta.1',
  file:'src/autotelic/runtime.js',
  before_sha256:'9940974090be7e905683ab3421160313b824d215f3d09ba105c6dd54b5a696db',
  after_sha256:'fff2c601a9e466cb4de741aed61fc573d97d1bdd787d1119dbabb813cdce96aa',
});
export const AUTOTELIC_REPORT_LABELS_PATCH=Object.freeze({
  marker:'thinkstar-autotelic-report-labels-v1',
  version:'1.3.0-beta.1',
  file:'src/autotelic/reflect.js',
  before_sha256:'7765c5f911c4ff91bbd3efe218b9ddaea8268c368bf1ccea512fc87ef2a19ea1',
  after_sha256:'9825ac492e6c8dfd90d7820aec93330f965109e893f4199490c7c36a20142a7a',
});
const sha=value=>createHash('sha256').update(value).digest('hex');
function replaceOnce(source,before,after){
  if(source.split(before).length!==2)throw Error('Autotelic correctness patch anchor is not unique');
  return source.replace(before,after);
}

/** Pure, exact-baseline host transformation. Deployment owns backup and replacement. */
export function patchAutotelicCorrectness(source,{version}={}){
  if(version!==AUTOTELIC_CORRECTNESS_PATCH.version)throw Error('Unsupported Aurabot autotelic version');
  if(typeof source!=='string')throw Error('Autotelic source must be UTF-8 text');
  const before=sha(source);
  if(before===AUTOTELIC_CORRECTNESS_PATCH.after_sha256)return {source,receipt:{...AUTOTELIC_CORRECTNESS_PATCH,input_sha256:before,unchanged:true}};
  if(before!==AUTOTELIC_CORRECTNESS_PATCH.before_sha256)throw Error('Unrecognized Aurabot autotelic source hash');
  let next=source;
  next=replaceOnce(next,
    "      else if (!candidates.length) outcome = lastOutcome // 场景 3：低于阈值，素材留池\n      else {",
    "      else if (!candidates.length) outcome = lastOutcome // 场景 3：低于阈值，素材留池\n      // thinkstar-autotelic-correctness-v1: do not review candidates that cannot start; keep step/review below.\n      else if (bk.actionsInLastHour(now()) >= s.budgetActionsPerHour) outcome = 'skipped-budget'\n      else {");
  next=replaceOnce(next,
    '    const day = dayKeyOf(now())\n    const tasks = bk.list()',
    '    const day = dayKeyOf(now())\n    const tasks = bk.list().filter((t) => dayKeyOf(t.updatedAt || now()) === day)');
  next=replaceOnce(next,'actionsToday: auditTodayCount(),','actionsToday: await auditTodayCount(),');
  next=replaceOnce(next,'auditToday: auditTodayCount(),','auditToday: await auditTodayCount(),');
  next=replaceOnce(next,
    '  function auditTodayCount() {\n    try { return Number(auditStat?.().today) || 0 } catch { return 0 }',
    '  async function auditTodayCount() {\n    try { return Number((await auditStat?.())?.today) || 0 } catch { return 0 }');
  const after=sha(next);
  if(after!==AUTOTELIC_CORRECTNESS_PATCH.after_sha256)throw Error('Patched autotelic source hash mismatch: '+after);
  return {source:next,receipt:{...AUTOTELIC_CORRECTNESS_PATCH,input_sha256:before,unchanged:false}};
}

/** Keep the audit.today contract; label its record count separately from successful actions. */
export function patchAutotelicReportLabels(source,{version}={}){
  if(version!==AUTOTELIC_REPORT_LABELS_PATCH.version)throw Error('Unsupported Aurabot autotelic report version');
  if(typeof source!=='string')throw Error('Autotelic report source must be UTF-8 text');
  const before=sha(source);
  if(before===AUTOTELIC_REPORT_LABELS_PATCH.after_sha256)return {source,receipt:{...AUTOTELIC_REPORT_LABELS_PATCH,input_sha256:before,unchanged:true}};
  if(before!==AUTOTELIC_REPORT_LABELS_PATCH.before_sha256)throw Error('Unrecognized Aurabot autotelic report source hash');
  const next=replaceOnce(source,
    '`全天动作 ${actionsToday} 次（机械计数；夜里消耗也在这行里，单列记数，不需要解释）`',
    '`全天审计记录 ${actionsToday} 条（含调用、结果和运行记录，不等于成功动作数）`');
  const after=sha(next);
  if(after!==AUTOTELIC_REPORT_LABELS_PATCH.after_sha256)throw Error('Patched autotelic report source hash mismatch: '+after);
  return {source:next,receipt:{...AUTOTELIC_REPORT_LABELS_PATCH,input_sha256:before,unchanged:false}};
}
