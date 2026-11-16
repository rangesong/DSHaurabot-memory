import { MemoryProvider } from './provider.js';
import { MemorySea, COLORS } from './renderer.js';

const $ = (id) => document.getElementById(id);
const make = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, className, action) => { const node = make('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; };
const count = (value) => Number(value ?? 0).toLocaleString('zh-CN');
const date = (value, precision = 'instant') => value === null || value === undefined ? '时间未注明' : new Intl.DateTimeFormat('zh-CN', precision === 'day' ? { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' } : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(value);
const short = (value, length = 60) => Array.from(value).slice(0, length).join('') + (Array.from(value).length > length ? '…' : '');
const KIND = { experience: '经历', conversation: '对话片段', message: '消息', claim: '旧记忆', knowledge: '知识', method: '方法', person: '人物', entity: '物件', open_loop: '未完事项', pattern: '印象与表达' };
const ROLE = { user: '用户', assistant: '助手', tool: '工具', document: '日常记录', unknown: '角色未注明' };
const RELATION = { participates_in: '参与', mentions: '提及', part_of: '属于', supports: '支持', counterexample: '反例', derived_from: '来自', uses_method: '使用方法', produced_by: '产出', related_to: '关联', corrects: '纠正' };
const state = { scope: 'all', region: null, q: '', until: null, graph: null, overview: null, selected: null, detail: null, mode: 'relation', listLimit: 20 };
const provider = new MemoryProvider(); let graphRequest = 0, detailRequest = 0, recallRequest = 0, reloadRequest = 0, graphAbort, searchTimer, timelineTimer, toastTimer, playTimer;
const sea = new MemorySea($('sea-canvas'), {
  onSelect: (node) => {
    if (!node) return;
    if (node.node_type === 'memory') openMemory(node.context_key, node.canonical_id);
    else if (node.node_type === 'region' && node.region_id.startsWith('M')) setRegion(node.region_id);
    else showRole(node);
  },
  onHover: (node, point) => {
    const tip = $('hover-tip'); tip.hidden = !node;
    if (!node) return;
    tip.textContent = node.node_type === 'memory' ? `${short(node.label, 45)} · ${node.context_label}` : node.label;
    tip.style.left = `${Math.max(8, Math.min(point.x + 15, $('sea-canvas').clientWidth - 235))}px`;
    tip.style.top = `${Math.max(10, Math.min(point.y + 16, $('sea-canvas').clientHeight - 80))}px`;
  },
});

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
function errorMessage(error) { return error.code === 'IMPORT_CHANGED' ? '导入快照已变化，请点击“重新读取快照”。' : error.code === 'NOT_FOUND' ? '这条记录在当前范围内不可用。' : '本机数据暂不可用。请在 thinkstarwork 中运行 npm run import:aurabot 后重试。'; }
function showTab(tab) {
  for (const name of ['detail', 'recalls']) { const active = name === tab; $(`tab-${name}`).classList.toggle('active', active); $(`tab-${name}`).setAttribute('aria-selected', active); $(`${name}-panel`).hidden = !active; }
  if (tab === 'recalls') loadRecalls();
}
function inspector() { $('inspector').classList.add('is-open'); $('sidebar').classList.remove('is-open'); }
function clearSelection() { detailRequest++; state.selected = null; state.detail = null; sea.select(null); }
function setRegion(id) { state.region = state.region === id ? null : id; clearSelection(); sea.reset(); loadGraph(); $('sidebar').classList.remove('is-open'); }

function renderRegions() {
  const graph = state.graph; if (!graph) return;
  $('region-list').replaceChildren(); $('working-list').replaceChildren();
  for (const region of graph.regions) {
    if (region.id.startsWith('M')) {
      const node = button('', `region-button${state.region === region.id ? ' active' : ''}`, () => setRegion(region.id)); node.style.setProperty('--tint', COLORS[region.id]); node.setAttribute('aria-pressed', state.region === region.id);
      const label = make('span', 'region-label', region.label.replace('星区', '')); label.append(make('small', '', region.id === 'M5' ? '概念 · 可复用的方法' : region.description));
      node.append(make('i', 'region-marker'), label, make('span', 'region-count', count(region.count))); $('region-list').append(node);
    } else {
      const node = button('', 'working-button', () => showRole({ ...region, node_type: 'region', region_id: region.id })); node.append(make('span'), make('span', '', region.label)); $('working-list').append(node);
    }
  }
}

function renderWelcome() {
  const content = $('detail-content'); content.replaceChildren();
  const intro = make('div', 'panel-intro'); intro.append(make('div', 'intro-orbit', '✦'), make('p', 'eyebrow', '从一颗星开始'), make('h2', '', '让记忆有迹可循。'), make('p', 'muted', '点击星图中的亮点，或从下面选择一条记录，查看内容、关联和原始来源。')); content.append(intro);
  const note = make('div', 'notice-box', '星云微尘仅作背景。亮点是实际对象，工作星区表示职责。画面中的位置与亮度不表示事实可信度或记忆强度。'); content.append(note);
  const nodes = state.graph?.nodes.filter((node) => node.node_type === 'memory') ?? [];
  content.append(make('div', 'mini-heading', `当前画面 · ${count(nodes.length)} 个对象`));
  const list = make('div', 'node-list');
  for (const node of nodes.slice(0, state.listLimit)) list.append(nodeRow(node));
  content.append(list);
  if (!nodes.length) content.append(make('p', 'empty-note', '当前筛选没有匹配对象。可切换星区或清除筛选。'));
  if (nodes.length > state.listLimit) content.append(button(`再展开 ${Math.min(20, nodes.length - state.listLimit)} 个节点`, 'quiet-button load-more', () => { state.listLimit += 20; renderWelcome(); }));
  content.append(make('p', 'detail-note', '每个对象只计一次；其他星区入口仍指向同一个对象。当前为只读浏览。'));
}
function nodeRow(node) {
  const row = button('', 'node-row', () => openMemory(node.context_key, node.canonical_id));
  const dot = make('span', 'dot'); dot.style.backgroundColor = COLORS[node.display_region ?? node.primary_region];
  const label = make('span'); label.append(make('span', 'node-name', node.label), make('small', '', `${node.kind_label} · ${node.context_label} · ${date(node.occurred_at, node.time_precision)}`)); row.append(dot, label); return row;
}
function showRole(node) {
  clearSelection(); showTab('detail'); inspector();
  const region = state.graph?.regions.find((r) => r.id === node.region_id); const name = region?.label ?? node.label;
  const content = $('detail-content'); content.replaceChildren(button('← 返回节点列表', 'text-button', renderWelcome), make('div', 'mini-heading', node.node_type === 'store' ? '统一底座' : '工作星区 · 职责示意'), make('h2', 'detail-title', name), make('p', 'detail-note', region?.description ?? '原话、规范对象、版本和来源关系保存在统一底座，各星区提供访问入口。'));
  content.append(make('div', 'notice-box', '这里展示系统的分工。目前没有接入实时认知运行事件，画面不表示 Aurabot 此刻正在处理某条消息。'));
}

async function loadGraph() {
  if (!state.overview) return;
  const request = ++graphRequest; graphAbort?.abort(); graphAbort = new AbortController(); $('scene-status').textContent = '整理当前画面…';
  try {
    const graph = await provider.graph({ scope: state.scope, region: state.region, q: state.q, until: state.until, limit: 280, focus_context: state.selected?.scope, focus_id: state.selected?.id }, { signal: graphAbort.signal });
    if (request !== graphRequest) return;
    if (graph.revision !== state.overview.revision) throw { code: 'IMPORT_CHANGED' };
    state.graph = graph; sea.setGraph(graph); sea.setMode(state.mode); renderRegions();
    const nodes = graph.nodes.filter((node) => node.node_type === 'memory');
    const selected = nodes.find((node) => node.context_key === state.selected?.scope && node.canonical_id === state.selected?.id);
    if (state.selected && !selected) clearSelection();
    if (selected) sea.select(selected.id); else renderWelcome();
    const c = graph.counts;
    $('scene-status').textContent = `显示 ${count(c.visible)} / ${count(c.matching)} 个对象${c.omitted ? ' · 其余可搜索定位' : ''}${state.until !== null && c.unknown_time ? ` · ${count(c.unknown_time)} 个时间未知` : ''}`;
    $('empty-state').hidden = c.matching !== 0; $('error-state').hidden = true;
    $('empty-text').textContent = state.region === 'M5' && !state.q ? '这次导入还没有知识或方法对象。后续由有依据的语义提取补充。' : '试试其他范围、时间或关键词。';
  } catch (error) {
    if (error.name === 'AbortError' || request !== graphRequest) return;
    $('error-text').textContent = errorMessage(error); $('error-state').hidden = false; $('empty-state').hidden = true; $('scene-status').textContent = '数据读取未完成';
  }
}

async function openMemory(scope, id, focus = false) {
  stopPlay(); const request = ++detailRequest; state.selected = { scope, id }; state.detail = null; showTab('detail'); inspector();
  const node = state.graph?.nodes.find((n) => n.context_key === scope && n.canonical_id === id); sea.select(node?.id);
  $('detail-content').replaceChildren(make('p', 'empty-note', '正在追溯来源…'));
  try {
    if (focus && !node) {
      state.scope = scope; state.region = null; state.q = ''; state.until = null; $('scope-select').value = scope; $('search').value = ''; $('timeline').value = '1000'; updateTime();
      $('scope-note').textContent = '仅显示当前范围的记录';
      await loadGraph(); if (request !== detailRequest) return;
    }
    const detail = await provider.detail({ scope, id, revision: state.overview.revision, until: state.until });
    if (request !== detailRequest) return;
    state.detail = detail; renderDetail(detail);
    const current = state.graph?.nodes.find((n) => n.context_key === scope && n.canonical_id === id);
    if (current) { sea.select(current.id); if (focus) sea.focus(current.id); }
  } catch (error) { if (request === detailRequest) $('detail-content').replaceChildren(make('p', 'empty-note', errorMessage(error))); }
}

function renderDetail(detail) {
  const memory = detail.memory, content = $('detail-content'); content.replaceChildren();
  const back = make('div', 'detail-close-row'); back.append(button('← 节点列表', '', () => { clearSelection(); renderWelcome(); }), make('span', 'tiny muted', detail.context_label)); content.append(back);
  content.append(make('span', 'kind-badge', KIND[memory.kind] ?? '记忆'), make('h2', 'detail-title', memory.label));
  content.append(make('div', 'detail-meta', `${date(memory.occurred_at, memory.time_precision)} · 北京时间 · 版本 ${memory.revision}`));
  const badges = make('div', 'status-badges');
  if (memory.review_status === 'needs_review') badges.append(make('span', 'warn', '待复核'));
  if (memory.evidence_status === 'inferred') badges.append(make('span', 'warn', '上游推断'));
  if (memory.evidence_status === 'hypothetical') badges.append(make('span', 'warn', '假设或示例'));
  if (memory.attributes.delivery_status === 'simulated') badges.append(make('span', 'warn', '试运行 · 未发布'));
  if (memory.validity !== 'current') badges.append(make('span', 'warn', { historical: '历史适用', superseded: '已被更新', withdrawn: '已撤回' }[memory.validity]));
  if (badges.childNodes.length) content.append(badges);
  content.append(button('◎ 在星图中聚焦', 'focus-button', () => {
    const node = state.graph?.nodes.find((n) => n.context_key === detail.context_key && n.canonical_id === memory.id);
    if (node) sea.focus(node.id); $('inspector').classList.remove('is-open');
  }));
  content.append(make('div', 'detail-body', memory.body));
  const chips = make('div', 'region-chips');
  for (const id of memory.region_ids) chips.append(button(state.graph?.regions.find((r) => r.id === id)?.label ?? id, '', () => setRegion(id)));
  content.append(chips);
  const notes = [];
  if (memory.kind === 'conversation') notes.push('对话按时间窗口组织，尚未自动理解为语义事件。');
  if (memory.evidence_status === 'inferred') notes.push('这是 Aurabot 保留的摘要或推断；本页面未将其重新确认为事实。');
  if (memory.attributes.record_kind === 'generated_diary') notes.push('日记是角色生成内容，不作为现实经历或发布成功的证明。');
  if (memory.attributes.record_kind?.includes('mood')) notes.push('角色状态记录，不代表对用户真实心理状态的判断。');
  notes.push(detail.history_note); if (state.until !== null) notes.push('下方只展开筛选时刻及以前的来源，正文仍使用当前快照版本。');
  content.append(make('p', 'detail-note', notes.join(' ')));
  if (detail.relations.length) {
    content.append(make('div', 'mini-heading', `相关对象 · ${count(detail.relations.length)}`));
    const list = make('div', 'node-list');
    for (const relation of detail.relations) { const row = button('', 'node-row', () => openMemory(detail.context_key, relation.id, true)); row.append(make('span', 'node-name', `${RELATION[relation.relation_type] ?? '关联'} · ${relation.label}`)); list.append(row); } content.append(list);
  }
  const page = detail.source_page;
  content.append(make('div', 'mini-heading', `原始来源 · ${count(page.total)} 条${page.total !== page.stored_total ? ` / 保存 ${count(page.stored_total)} 条` : ''}`));
  const sources = make('div'); sources.id = 'source-list'; content.append(sources); appendSources(page.sources, sources);
  const more = button('', 'quiet-button load-more', () => loadMore(detail, more)); more.id = 'load-more-sources'; content.append(more); updateMore(more, page);
  if (!page.total) sources.append(make('p', 'empty-note', '当前时间范围内没有可展开的来源。'));
  $('detail-panel').scrollTop = 0;
}
function appendSources(sources, target) {
  for (const source of sources) {
    const p = source.provenance ?? {}, card = make('article', 'source-card'), head = make('div', 'source-head');
    head.append(make('span', '', p.speaker_label || ROLE[source.role] || '来源'), make('time', '', date(source.occurred_at, source.time_precision))); card.append(head, make('div', 'source-text', source.text));
    card.append(make('div', 'source-foot', `${p.relative_path ?? '上游记录'} · ${p.locator ?? `序号 ${source.sequence}`}`));
    if (p.possible_truncation) card.append(make('p', 'source-warning', '上游可能已截断原文，当前展示保留的内容。'));
    if (p.text_is_placeholder) card.append(make('p', 'source-warning', '原记录没有可读文本；以上为来源占位说明。'));
    if (source.delivery_status === 'simulated') card.append(make('p', 'source-warning', '试运行内容，未确认为实际发送或发布。'));
    target.append(card);
  }
}
function updateMore(button, page) { button.hidden = !page.has_more; button.disabled = false; button.textContent = `继续展开原话 · 已显示 ${count(page.next_offset)} / ${count(page.total)}`; }
async function loadMore(detail, more) {
  more.disabled = true;
  try {
    const page = await provider.sources({ scope: detail.context_key, id: detail.memory.id, revision: detail.revision, until: state.until, offset: detail.source_page.next_offset });
    if (state.detail !== detail) return;
    detail.source_page = page; appendSources(page.sources, $('source-list')); updateMore(more, page);
  } catch (error) { if (state.detail === detail) { more.disabled = false; toast(errorMessage(error)); } }
}

async function loadRecalls() {
  if (!state.overview) return; const request = ++recallRequest;
  $('recall-list').replaceChildren(make('p', 'empty-note', '读取上游回忆记录…'));
  try {
    const value = await provider.recalls({ scope: state.scope, limit: 8 }); if (request !== recallRequest) return;
    if (value.revision !== state.overview.revision) throw { code: 'IMPORT_CHANGED' };
    const list = $('recall-list'); list.replaceChildren();
    if (!value.observations.length) list.append(make('p', 'empty-note', '当前范围没有保留的召回记录。'));
    for (const recall of value.observations) {
      const card = make('article', 'recall-card'), meta = make('div', 'recall-meta'); meta.append(make('span', '', recall.context_label), make('time', '', date(recall.occurred_at)));
      card.append(meta, make('p', 'recall-query', recall.trigger || '触发词未保留'));
      card.append(make('p', 'detail-note', '请求中是否采用：未知 · 模型实际使用：未知'));
      for (const candidate of recall.candidates) {
        const row = make('div', 'recall-candidate');
        const label = candidate.canonical_id && candidate.text ? short(candidate.text, 90) : '对应对象在这个范围内不可用';
        if (candidate.canonical_id && recall.context_key) row.append(button(label, '', () => openMemory(recall.context_key, candidate.canonical_id, true))); else row.append(make('p', 'small muted', label));
        const assembly = { legacy_shown: '上游标记已装入', not_shown: '上游标记未装入', unknown: '是否装入未知' }[candidate.assembly];
        row.append(make('small', '', `${assembly}${candidate.raw_score !== null ? ` · 上游分数 ${candidate.raw_score}` : ''}`)); card.append(row);
      }
      if (!recall.candidates.length) card.append(make('p', 'small muted', '候选记录未保留。')); list.append(card);
    }
  } catch (error) { if (request === recallRequest) $('recall-list').replaceChildren(make('p', 'empty-note', errorMessage(error))); }
}

function renderInfo() {
  const overview = state.overview; if (!overview) return; const stats = overview.stats; const content = $('data-info'); content.replaceChildren();
  const grid = make('div', 'dialog-data');
  for (const [number, label] of [[stats.source_records, '保存的来源'], [stats.memory_objects, '记忆对象'], [stats.contexts, '独立数据范围'], [stats.relations, '范围内关联']]) { const cell = make('div'); cell.append(make('b', '', count(number)), make('span', '', label)); grid.append(cell); }
  content.append(grid, make('p', 'dialog-note', `导入时间：${date(overview.imported_at)}（北京时间）。来源为本机 Aurabot 的聊天、旧记忆和日常记录；${count(stats.empty_text_records)} 条无可读文本，${count(stats.possible_truncation)} 条可能已在上游截断。`));
  content.append(make('p', 'dialog-note', '当前是已保留内容的快照，不代表完整历史。时间轴按对象发生时间筛选，不重建当年的对象版本；时间未知的对象继续保留。各群聊和私聊独立，跨星区入口不重复计数。'));
  content.append(make('p', 'dialog-note', '本轮仅做真实数据的只读查看。自动语义提取、知识与方法生成、正式反馈写入和实时运行观察尚未接入。'));
}

function updateTime() {
  const range = state.overview?.time_range; if (!range || range.start === null) return;
  const value = Number($('timeline').value); state.until = value === 1000 ? null : Math.round(range.start + (range.end - range.start) * value / 1000);
  $('time-current').textContent = state.until === null ? '全部时间' : `截至 ${date(state.until, 'day')}`;
  $('timeline').setAttribute('aria-valuetext', $('time-current').textContent);
}
function stopPlay() { clearInterval(playTimer); playTimer = null; $('timeline-play').textContent = '▷'; $('timeline-play').setAttribute('aria-label', '播放时间分布'); }
function resetFilters() { stopPlay(); clearTimeout(searchTimer); clearTimeout(timelineTimer); state.region = null; state.q = ''; state.until = null; $('search').value = ''; $('timeline').value = '1000'; updateTime(); clearSelection(); sea.reset(); loadGraph(); }

async function reload() {
  const request = ++reloadRequest; graphAbort?.abort(); graphRequest++; clearSelection(); stopPlay();
  try {
    const overview = await provider.overview(); if (request !== reloadRequest) return; state.overview = overview;
    $('total-sources').textContent = count(overview.stats.source_records); $('total-memories').textContent = count(overview.stats.memory_objects); $('total-scopes').textContent = count(overview.scopes.length);
    const select = $('scope-select'); select.replaceChildren(make('option', '', '本机总览')); select.options[0].value = 'all';
    for (const scope of overview.scopes) { const option = make('option', '', `${scope.label} · ${count(scope.count)}`); option.value = scope.key; select.append(option); }
    if (state.scope !== 'all' && !overview.scopes.some((s) => s.key === state.scope)) state.scope = 'all'; select.value = state.scope;
    $('import-time').textContent = `导入于 ${date(overview.imported_at)}`;
    $('time-start').textContent = date(overview.time_range.start, 'day'); $('time-end').textContent = date(overview.time_range.end, 'day'); $('timeline').disabled = overview.time_range.start === null; $('timeline-play').disabled = $('timeline').disabled;
    updateTime(); renderInfo(); await loadGraph(); if (request === reloadRequest) loadRecalls();
  } catch (error) { if (request === reloadRequest) { $('error-text').textContent = errorMessage(error); $('error-state').hidden = false; $('scene-status').textContent = '本机数据尚未就绪'; } }
}

$('scope-select').addEventListener('change', () => { state.scope = $('scope-select').value; clearSelection(); sea.reset(); state.listLimit = 20; $('scope-note').textContent = state.scope === 'all' ? '各会话保留独立归属' : '仅显示当前范围的记录'; loadGraph(); loadRecalls(); });
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('search').value; state.listLimit = 20; clearSelection(); loadGraph(); }, 260); });
$('all-regions').addEventListener('click', () => { state.region = null; clearSelection(); sea.reset(); loadGraph(); });
for (const mode of ['relation', 'galaxy']) $(`layout-${mode}`).addEventListener('click', () => { state.mode = mode; sea.setMode(mode); for (const name of ['relation', 'galaxy']) { $(`layout-${name}`).classList.toggle('active', name === mode); $(`layout-${name}`).setAttribute('aria-pressed', name === mode); } });
$('reset-view').addEventListener('click', () => sea.reset()); $('zoom-in').addEventListener('click', () => sea.zoom(1.2)); $('zoom-out').addEventListener('click', () => sea.zoom(1 / 1.2));
function motionButton() { const node = $('toggle-motion'); node.classList.toggle('active', sea.motion); node.textContent = sea.motion ? 'Ⅱ' : '▷'; node.setAttribute('aria-pressed', sea.motion); node.setAttribute('aria-label', sea.motion ? '暂停星云动态' : '播放星云动态'); }
$('toggle-motion').addEventListener('click', () => { sea.setMotion(!sea.motion); motionButton(); }); motionButton();
$('toggle-lines').addEventListener('click', () => { sea.setLines(!sea.lines); $('toggle-lines').classList.toggle('active', sea.lines); $('toggle-lines').setAttribute('aria-pressed', sea.lines); });
$('timeline').addEventListener('input', () => { stopPlay(); updateTime(); clearTimeout(timelineTimer); clearSelection(); timelineTimer = setTimeout(loadGraph, 150); });
$('timeline-reset').addEventListener('click', () => { stopPlay(); clearTimeout(timelineTimer); $('timeline').value = '1000'; updateTime(); clearSelection(); loadGraph(); });
$('timeline-play').addEventListener('click', () => {
  if (playTimer) { stopPlay(); return; }
  clearTimeout(timelineTimer); if (Number($('timeline').value) >= 1000) $('timeline').value = '0'; updateTime(); clearSelection(); loadGraph();
  $('timeline-play').textContent = 'Ⅱ'; $('timeline-play').setAttribute('aria-label', '暂停时间分布');
  playTimer = setInterval(() => { $('timeline').value = String(Math.min(1000, Number($('timeline').value) + 35)); updateTime(); loadGraph(); if (Number($('timeline').value) >= 1000) stopPlay(); }, 650);
});
for (const id of ['clear-filters']) $(id).addEventListener('click', resetFilters);
for (const id of ['retry-load', 'reload-data']) $(id).addEventListener('click', reload);
for (const name of ['detail', 'recalls']) $(`tab-${name}`).addEventListener('click', () => showTab(name));
$('info-button').addEventListener('click', () => { renderInfo(); $('data-dialog').showModal(); }); $('close-info').addEventListener('click', () => $('data-dialog').close());
$('sidebar-button').addEventListener('click', () => { $('sidebar').classList.toggle('is-open'); $('inspector').classList.remove('is-open'); });
$('inspector-button').addEventListener('click', () => { showTab('detail'); inspector(); });
$('close-inspector').addEventListener('click', () => $('inspector').classList.remove('is-open'));
document.addEventListener('keydown', (event) => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('sidebar').classList.add('is-open'); $('search').focus(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });
reload();
