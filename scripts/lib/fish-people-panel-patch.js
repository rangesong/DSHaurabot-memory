import {createHash} from 'node:crypto';

export const FISH_PEOPLE_PANEL_PATCH=Object.freeze({
  version:'1.3.0-beta.1',marker:'thinkstar-fish-people-panel-v1',
  before_sha256:'46b003b62abb36edb454251d4f73a8de660e12e12b3c78bf850b4f4eeda77db1',
  after_sha256:'c6b1577a9cebbff5d0bed2081c85bd63c53ea67b2885f9137fbb4b1985a74875',
});
const sha=value=>createHash('sha256').update(value).digest('hex');

// Installed inside the existing React closure; never calls the QQ person mutation routes.
export const FISH_PEOPLE_PANEL=String.raw`    // thinkstar-fish-people-panel-v1
    function PersonaWall({ toast, contextKey }) {
      const [source, setSource] = useState('qq')
      return h('div', null,
        h('div', { style: { marginBottom: 12 } }, h(Seg, { value: source, onChange: setSource, options: [{ value: 'qq', label: 'QQ 联系人' }, { value: 'fish', label: '鱼世界' }] })),
        source === 'fish' ? h(FishWorldPeople, { key: contextKey, toast }) : h(QQPersonaWall, { toast }))
    }

    function FishWorldPeople() {
      const [list, setList] = useState(null), [error, setError] = useState('')
      const [selected, setSelected] = useState(''), [query, setQuery] = useState('')
      const [nextOffset, setNextOffset] = useState(null), [busy, setBusy] = useState(false)
      const [scopeToken, setScopeToken] = useState('')
      const scopeRef = useRef(''), sequence = useRef(0), flight = useRef(false)
      const clearScope = () => { sequence.current++; scopeRef.current = ''; setScopeToken(''); setList(null); setSelected(''); setNextOffset(null) }
      const load = async (offset = 0) => {
        if (flight.current) return
        flight.current = true
        const request = ++sequence.current
        setBusy(true)
        try {
          const r = await get('/ext/fish-world/people?limit=20&offset=' + offset)
          if (request !== sequence.current) return
          if (!r.ok || r.available !== true || !r.scopeToken) { clearScope(); throw new Error('Unavailable fish scope') }
          if (offset && scopeRef.current && r.scopeToken !== scopeRef.current) { clearScope(); return }
          scopeRef.current = r.scopeToken; setScopeToken(r.scopeToken)
          const incoming = r.list || []
          setList(previous => offset ? [...(previous || []), ...incoming.filter(p => !(previous || []).some(old => old.fish === p.fish))] : incoming)
          setNextOffset(r.nextOffset == null ? null : r.nextOffset)
          if (!offset) setSelected(previous => incoming.some(p => p.fish === previous) ? previous : incoming[0]?.fish || '')
          setError('')
        } catch { setError('鱼的档案暂时不可用，可以稍后刷新。') }
        finally { flight.current = false; setBusy(false) }
      }
      useEffect(() => {
        let active = true
        load()
        const timer = setInterval(() => {
          get('/ext/fish-world/people?limit=1&offset=0').then(r => {
            if (!active) return
            if (!r.ok || r.available !== true || !r.scopeToken) { clearScope(); setError('当前鱼身份暂不可用，先保留本地档案。'); return }
            if (scopeRef.current !== r.scopeToken) { clearScope(); load() }
          }).catch(() => {})
        }, 5000)
        return () => { active = false; sequence.current++; clearInterval(timer) }
      }, [])
      const q = query.trim().toLowerCase()
      const visible = (list || []).filter(p => [p.fish, p.name, p.summary].some(v => String(v || '').toLowerCase().includes(q)))
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('input', { className: 'ab-input', style: { flex: 1 }, value: query, placeholder: '按鱼名或编号查找', 'aria-label': '搜索鱼的档案', onChange: e => setQuery(e.target.value) }),
          h(Btn, { small: true, kind: 'ghost', disabled: busy, onClick: () => load() }, '刷新')),
        error ? h('div', { className: 'ab-note err' }, error) : null,
        list === null ? h(Empty, { text: busy ? '读取中…' : '暂无鱼的档案' }) : !list.length ? h(Card, { title: '鱼世界的朋友' }, h(Empty, { text: '确认过的往来会保存在这里。已有对话会逐步整理，不需要重新聊天。' })) :
        h('div', { className: 'ab-pm-split' + (selected ? ' open' : '') },
          h('div', { className: 'ab-pm-list' },
            h('div', { className: 'ab-pm-rows' }, visible.map(p => h('button', { key: p.fish, type: 'button', className: 'ab-pm-row' + (p.fish === selected ? ' on' : ''), onClick: () => setSelected(p.fish) },
              h('span', { className: 'ab-pm-face', 'aria-hidden': true, style: { background: '#3e9c8f' } }, '鱼'),
              h('span', { className: 'who' },
                h('span', { className: 'name' }, p.name || p.fish, h('span', { className: 'ab-pm-own' }, '鱼世界')),
                h('span', { className: 'line', style: { display: 'block' } }, p.fish + ' · ' + (p.summary || '已保留往来资料')),
                p.lastInteraction ? h('span', { className: 'line', style: { display: 'block' } }, '最近往来：' + memoryDate(p.lastInteraction)) : null)))),
            !visible.length ? h(Empty, { text: '已加载的档案里没有找到，可以继续加载或刷新。' }) : null,
            nextOffset !== null ? h(Btn, { small: true, disabled: busy, onClick: () => load(nextOffset) }, '加载更多') : null),
          selected ? h(FishWorldPersonDetail, { key: scopeToken + ':' + selected, fish: selected, scopeToken, back: () => setSelected('') }) : h(Empty, { text: '选一条鱼看看' })))
    }

    function FishWorldPersonDetail({ fish, scopeToken, back }) {
      const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      useEffect(() => {
        let active = true
        get('/ext/fish-world/person?fish=' + encodeURIComponent(fish) + '&limit=10').then(r => {
          if (!active) return
          if (!r.ok || r.scopeToken !== scopeToken || r.person?.fish !== fish) throw new Error('Unavailable fish profile')
          setData(r); setError('')
        }).catch(() => { if (active) setError('这条鱼的档案暂时不可用，可以返回后重试。') })
        return () => { active = false }
      }, [fish, scopeToken])
      const more = async () => {
        if (busy || data?.nextOffset == null) return
        setBusy(true)
        try {
          const r = await get('/ext/fish-world/person?fish=' + encodeURIComponent(fish) + '&limit=10&offset=' + data.nextOffset)
          if (!r.ok || r.scopeToken !== scopeToken || r.person?.fish !== fish) { setData(null); throw new Error('Unavailable fish profile') }
          setData(previous => ({ ...r, observations: [...(previous.observations || []), ...(r.observations || []).filter(row => !(previous.observations || []).some(old => old.id === row.id))] }))
        } catch { setError('更多往来暂时没有读出来，已显示的记录仍保留。') }
        finally { setBusy(false) }
      }
      return h('div', { className: 'ab-pm-detail' },
        h(Btn, { small: true, kind: 'ghost', onClick: back }, '返回列表'),
        error ? h('div', { className: 'ab-note err' }, error) : null,
        !data ? h(Empty, { text: error ? '可返回后重试' : '读取中…' }) : h('div', null,
          h(Card, { title: (data.person.name || fish) + ' ' + fish, desc: '鱼世界 · 大肥鱼认识的鱼' },
            h('p', { className: 'quote' }, data.impression?.disabled ? '原有印象已停用，等待新的可靠往来再整理。' : data.impression?.text || '往来资料已保留，整体印象等待有依据的整理。'),
            data.impression?.at ? h('div', { className: 'ab-muted' }, '印象更新于 ' + memoryDate(data.impression.at)) : null,
            data.person.lastInteraction ? h('div', { className: 'ab-muted' }, '最近往来：' + memoryDate(data.person.lastInteraction)) : null),
          h(Card, { title: '往来与已知情况', desc: '原话、资料和发生时间分别保留；较早的往来不会当作今天的新进展。' },
            (data.observations || []).map(row => h('div', { key: row.id, className: 'ab-note', style: { marginBottom: 8 } },
              h('div', { className: 'ab-muted' }, (row.role === 'self' ? '我说的' : row.role === 'peer' ? '对方说的' : '资料') + ' · ' + (row.occurredAt ? memoryDate(row.occurredAt) : row.timeLabel || (row.observedAt ? '读取于 ' + memoryDate(row.observedAt) : '原时间未确认'))),
              h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, String(row.body || row.text || '')))),
            !(data.observations || []).length ? h(Empty, { text: '暂时没有可核实的往来原文' }) : null,
            data.nextOffset != null ? h(Btn, { small: true, disabled: busy, onClick: more }, '更多往来') : null)))
    }

`;

export function patchFishPeoplePanel(source,{version}={}){
  if(version!==FISH_PEOPLE_PANEL_PATCH.version)throw Error('Unreviewed fish people panel host version');
  const before=sha(source);
  if(before===FISH_PEOPLE_PANEL_PATCH.after_sha256)return {source,receipt:{unchanged:true,before,after:before}};
  if(before!==FISH_PEOPLE_PANEL_PATCH.before_sha256)throw Error('Unreviewed fish people panel source hash');
  const anchor='    function PersonaWall({ toast }) {';
  if(source.split(anchor).length!==2)throw Error('Fish people panel anchor is not unique');
  let next=source.replace(anchor,FISH_PEOPLE_PANEL+'    function QQPersonaWall({ toast }) {');
  const oldProps='    function PersonaMemory({ toast }) {',newProps='    function PersonaMemory({ toast, st }) {';
  const oldWall="page === 'wall' ? h(PersonaWall, { toast })",newWall="page === 'wall' ? h(PersonaWall, { toast, contextKey: JSON.stringify([st?.config?.ownerQQ, st?.config?.persona?.current]) })";
  if(next.split(oldProps).length!==2||next.split(oldWall).length!==2)throw Error('Fish people context anchors are not unique');
  next=next.replace(oldProps,newProps).replace(oldWall,newWall);
  if(FISH_PEOPLE_PANEL_PATCH.after_sha256&&sha(next)!==FISH_PEOPLE_PANEL_PATCH.after_sha256)throw Error('Fish people panel result hash mismatch');
  return {source:next,receipt:{unchanged:false,before,after:sha(next)}};
}
