import { useEffect, useMemo, useState, type JSX } from 'react'
import type { EngineId, NativeSessionInfo } from '../api'
import type { SessionState } from '../types'
import { useT } from '../i18n'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '<1m'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(ts).toLocaleDateString()
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'))
  return i >= 0 ? norm.slice(i + 1) : norm
}

function formatSize(n: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface Group {
  key: string
  project: string
  cwd: string
  items: NativeSessionInfo[]
}

interface HistoryOrder {
  groups: string[]
  items: Record<string, string[]>
}

interface MenuState {
  x: number
  y: number
  kind: 'active' | 'history'
  sessionKey: string // active: internal id; history: claudeSessionId
  title: string
}

interface Props {
  /** Engines shown in the tab bar (CLI found + enabled in settings) */
  engines: EngineId[]
  engine: EngineId
  onEngineChange: (e: EngineId) => void
  activeSessions: SessionState[]
  activeId: string
  customTitles: Record<string, string>
  /** Bump to rescan the history list (e.g. after a delete) */
  historyVersion: number
  onSelectActive: (id: string) => void
  onResume: (ns: NativeSessionInfo) => void
  onRename: (claudeSessionId: string, title: string) => void
  onDelete: (claudeSessionId: string) => void
  onRemoveActive: (id: string) => void
  onReorderActive: (from: number, to: number) => void
  /** Change the working directory of an active session (after a project moved) */
  onChangeDir: (id: string) => void
  onToggle: () => void
}

export default function Sidebar({
  engines,
  engine,
  onEngineChange,
  activeSessions,
  activeId,
  customTitles,
  historyVersion,
  onSelectActive,
  onResume,
  onRename,
  onDelete,
  onRemoveActive,
  onReorderActive,
  onChangeDir,
  onToggle
}: Props): JSX.Element {
  const t = useT()
  const [nativeList, setNativeList] = useState<NativeSessionInfo[]>([])
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<null | { key: string; initial: string }>(null)
  const [renameText, setRenameText] = useState('')
  // Manual ordering: groups = order of group keys; items = order of session ids within a group
  const [order, setOrder] = useState<HistoryOrder>({ groups: [], items: {} })
  const [dragActive, setDragActive] = useState<number | null>(null)
  const [overActive, setOverActive] = useState<number | null>(null)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [overGroup, setOverGroup] = useState<string | null>(null)
  const [dragItem, setDragItem] = useState<{ key: string; id: string } | null>(null)
  const [overItem, setOverItem] = useState<string | null>(null)
  // History groups start collapsed: track expanded group keys (new groups stay collapsed automatically)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = (): void => {
    void window.api.listNativeSessions(engine).then((list) => {
      setNativeList(list)
      setLoaded(true)
    })
  }

  useEffect(() => {
    refresh()
    void window.api.getHistoryOrder().then((o) =>
      setOrder({ groups: Array.isArray(o.groups) ? o.groups : [], items: o.items ?? {} })
    )
    const timer = setInterval(refresh, 30_000) // periodically refresh size/timestamps
    return () => clearInterval(timer)
  }, [engine])

  useEffect(() => {
    if (historyVersion > 0) refresh()
  }, [historyVersion])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const sizeBySid = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of nativeList) m.set(s.sessionId, s.sizeBytes)
    return m
  }, [nativeList])

  const groups = useMemo<Group[]>(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? nativeList.filter(
          (s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)
        )
      : nativeList
    // Group keys are engine-scoped so the two histories never share manual ordering
    const groupKey = (cwd: string): string => (engine === 'opencode' ? `opencode:${cwd}` : cwd)
    const map = new Map<string, NativeSessionInfo[]>()
    for (const s of filtered) {
      const key = groupKey(s.cwd || s.projectEncoded)
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(s)
    }
    const newest = (arr: NativeSessionInfo[] | undefined): number =>
      arr && arr.length ? Math.max(...arr.map((i) => i.lastTs)) : 0
    // Group order: manual ordering first; unsorted groups follow by newest activity
    const savedG = order.groups.filter((k) => map.has(k))
    const extraG = [...map.keys()]
      .filter((k) => !savedG.includes(k))
      .sort((a, b) => newest(map.get(b)) - newest(map.get(a)))
    return [...savedG, ...extraG].map((key) => {
      const items = map.get(key)!
      const saved = (order.items[key] ?? []).filter((id) => items.some((i) => i.sessionId === id))
      const extra = items
        .filter((i) => !saved.includes(i.sessionId))
        .sort((a, b) => b.lastTs - a.lastTs)
      const orderedIds = [...saved, ...extra.map((i) => i.sessionId)]
      const ordered = orderedIds.map((id) => items.find((i) => i.sessionId === id)!)
      const head = ordered[0]?.cwd ?? ''
      return {
        key,
        project: engine === 'opencode' ? basename(head || key.replace(/^opencode:/, '')) : basename(key),
        cwd: head,
        items: ordered
      }
    })
  }, [nativeList, search, order, engine])

  const persistOrder = (next: HistoryOrder, keys: string[]): void => {
    setOrder(next)
    void window.api.saveHistoryOrder({ groups: keys, items: next.items })
  }

  const moveGroup = (fromKey: string, toKey: string): void => {
    if (fromKey === toKey) return
    const keys = groups.map((g) => g.key)
    const from = keys.indexOf(fromKey)
    const to = keys.indexOf(toKey)
    if (from < 0 || to < 0) return
    keys.splice(to, 0, keys.splice(from, 1)[0])
    persistOrder({ ...order, groups: keys }, keys)
  }

  const moveItem = (groupKey: string, fromId: string, toId: string): void => {
    const g = groups.find((x) => x.key === groupKey)
    if (!g || fromId === toId) return
    const ids = g.items.map((i) => i.sessionId)
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(toId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    const nextItems = { ...order.items, [groupKey]: ids }
    persistOrder({ groups: order.groups, items: nextItems }, groups.map((x) => x.key))
  }

  const openMenu = (e: React.MouseEvent, kind: 'active' | 'history', s: SessionState | NativeSessionInfo): void => {
    e.preventDefault()
    e.stopPropagation()
    const key = kind === 'active' ? (s as SessionState).id : (s as NativeSessionInfo).sessionId
    const title =
      kind === 'active'
        ? (s as SessionState).title || basename((s as SessionState).cwd)
        : customTitles[(s as NativeSessionInfo).sessionId] || (s as NativeSessionInfo).title
    setMenu({ x: e.clientX, y: e.clientY, kind, sessionKey: key, title })
  }

  const submitRename = (): void => {
    if (renaming) {
      onRename(renaming.key, renameText.trim())
      // Apply the new title to the history list immediately
      setNativeList((prev) =>
        prev.map((s) => (s.sessionId === renaming.key ? { ...s, title: renameText.trim() || s.title, custom: true } : s))
      )
    }
    setRenaming(null)
  }

  const clearActiveDrag = (): void => {
    setDragActive(null)
    setOverActive(null)
  }

  const clearHistoryDrag = (): void => {
    setDragGroup(null)
    setOverGroup(null)
    setDragItem(null)
    setOverItem(null)
  }

  const searching = search.trim().length > 0

  const toggleGroup = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(g.key))
  const toggleAll = (): void => {
    setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.key)))
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{t('sidebar.title')}</span>
        <button className="icon-btn" onClick={refresh} title={t('sidebar.refresh')}>
          ⟳
        </button>
        <button className="icon-btn" onClick={onToggle} title={t('sidebar.collapse')}>
          «
        </button>
      </div>
      {engines.length > 1 && (
        <div className="engine-tabs">
          {engines.map((e) => (
            <button
              key={e}
              className={`engine-tab ${e === engine ? 'on' : ''}`}
              onClick={() => onEngineChange(e)}
            >
              {e === 'opencode' ? t('engine.opencode') : t('engine.claude')}
            </button>
          ))}
        </div>
      )}
      <input
        className="sidebar-search"
        placeholder={t('sidebar.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        spellCheck={false}
      />
      <div className="sidebar-body">
        {activeSessions.length > 0 && (
          <div className="active-section">
            <div className="active-section-head">
              <span className="live-pulse" />
              {t('sidebar.active')}
              <span className="active-count">{activeSessions.length}</span>
            </div>
            {activeSessions.map((s, i) => {
              const size = s.claudeSessionId ? sizeBySid.get(s.claudeSessionId) : undefined
              const badge = s.status === 'exited' ? t('badge.exited') : s.busy ? t('badge.busy') : t('badge.idle')
              const badgeCls = s.status === 'exited' ? 'exited' : s.busy ? 'busy' : 'idle'
              return (
                <div
                  key={s.id}
                  className={`session-item act ${s.id === activeId ? 'current' : ''} ${
                    dragActive === i ? 'dragging' : ''
                  } ${overActive === i && dragActive !== null && dragActive !== i ? 'drag-target' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectActive(s.id)}
                  onContextMenu={(e) => openMenu(e, 'active', s)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    setDragActive(i)
                  }}
                  onDragEnd={clearActiveDrag}
                  onDragOver={(e) => {
                    if (dragActive === null) return
                    e.preventDefault()
                    setOverActive(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragActive !== null && dragActive !== i) onReorderActive(dragActive, i)
                    clearActiveDrag()
                  }}
                  title={`${s.title || s.cwd}\n${s.cwd}${
                    size ? `\n${t('item.sizeTip', { size: formatSize(size) })}` : ''
                  }\n${t('item.dragTip')}`}
                >
                  <span className={`dot ${s.status === 'exited' ? 'exited' : s.busy ? 'running' : 'idle'}`} />
                  <span className="item-title">{s.title || `${basename(s.cwd)} · ${s.id.slice(0, 6)}`}</span>
                  <span className={`item-badge ${badgeCls}`}>{badge}</span>
                </div>
              )
            })}
          </div>
        )}

        <div className="history-head">
          <span>
            🕘 {t('sidebar.history')} · {groups.length}
          </span>
          {groups.length > 0 && (
            <button
              className="history-expand"
              onClick={toggleAll}
              title={allExpanded ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
            >
              {allExpanded ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
            </button>
          )}
        </div>
        {groups.map((g) => {
          const open = searching || expanded.has(g.key)
          return (
          <div
            key={g.key}
            className={`group ${overGroup === g.key && dragGroup !== null && dragGroup !== g.key ? 'drag-target' : ''}`}
            onDragOver={(e) => {
              if (!dragGroup || dragGroup === g.key) return
              e.preventDefault()
              setOverGroup(g.key)
            }}
            onDrop={(e) => {
              if (!dragGroup) return
              e.preventDefault()
              moveGroup(dragGroup, g.key)
              clearHistoryDrag()
            }}
          >
            <div
              className="group-label"
              onClick={() => toggleGroup(g.key)}
              title={
                searching
                  ? t('sidebar.groupTipSearching')
                  : `${t('sidebar.groupTip', { cwd: g.cwd })}\n${open ? t('sidebar.groupCollapse') : t('sidebar.groupExpand')}`
              }
              draggable={!search}
              onDragStart={(e) => {
                if (search) return
                e.dataTransfer.effectAllowed = 'move'
                setDragGroup(g.key)
              }}
              onDragEnd={clearHistoryDrag}
            >
              <span className="group-grip">⠿</span>
              <span className={`group-chevron ${open ? 'open' : ''}`}>▸</span>
              📁 {g.project} · {g.items.length}
            </div>
            {open &&
              g.items.map((ns) => {
              const live = activeSessions.find((s) => s.claudeSessionId === ns.sessionId)
              return (
                <div
                  key={ns.sessionId}
                  className={`session-item ${live && live.id === activeId ? 'current' : ''} ${
                    overItem === ns.sessionId && dragItem !== null && dragItem.id !== ns.sessionId
                      ? 'drag-target'
                      : ''
                  }`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onResume(ns)}
                  onContextMenu={(e) => openMenu(e, 'history', ns)}
                  draggable={!search}
                  onDragStart={(e) => {
                    if (search) return
                    e.stopPropagation()
                    e.dataTransfer.effectAllowed = 'move'
                    setDragItem({ key: g.key, id: ns.sessionId })
                  }}
                  onDragEnd={clearHistoryDrag}
                  onDragOver={(e) => {
                    if (!dragItem || dragItem.key !== g.key) return
                    e.preventDefault()
                    e.stopPropagation()
                    setOverItem(ns.sessionId)
                  }}
                  onDrop={(e) => {
                    if (!dragItem || dragItem.key !== g.key) return
                    e.preventDefault()
                    e.stopPropagation()
                    moveItem(g.key, dragItem.id, ns.sessionId)
                    clearHistoryDrag()
                  }}
                  title={`${customTitles[ns.sessionId] || ns.title}\n${ns.cwd}\n${ns.sessionId}${
                    ns.sizeBytes ? `\n${t('item.sizeTip', { size: formatSize(ns.sizeBytes) })}` : ''
                  }`}
                >
                  <span className={`dot ${live ? (live.busy ? 'running' : 'idle') : 'off'}`} />
                  <span className="item-title">
                    {customTitles[ns.sessionId] || ns.title}
                    {ns.custom ? ' ✏' : ''}
                  </span>
                  <span className="item-time">{relativeTime(ns.lastTs)}</span>
                </div>
              )
            })}
          </div>
          )
        })}
        {loaded && nativeList.length === 0 && (
          <div className="sidebar-empty">{t('sidebar.empty')}</div>
        )}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setRenaming({ key: menu.sessionKey, initial: menu.title })
              setRenameText(menu.title)
              setMenu(null)
            }}
          >
            {t('ctx.rename')}
          </button>
          {menu.kind === 'active' && (
            <button
              onClick={() => {
                const key = menu.sessionKey
                setMenu(null)
                onChangeDir(key)
              }}
              title={t('ctx.changeDirTip')}
            >
              {t('ctx.changeDir')}
            </button>
          )}
          {menu.kind === 'active' && (
            <button
              className="ctx-danger"
              onClick={() => {
                onRemoveActive(menu.sessionKey)
                setMenu(null)
              }}
            >
              {t('ctx.remove')}
            </button>
          )}
          {menu.kind === 'history' && (
            <button
              className="ctx-danger"
              onClick={() => {
                const key = menu.sessionKey
                setMenu(null)
                onDelete(key)
              }}
            >
              {t('ctx.delete')}
            </button>
          )}
        </div>
      )}

      {renaming && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setRenaming(null)}>
          <div className="modal rename-modal">
            <h3>{t('rename.title')}</h3>
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitRename()}
              placeholder={t('rename.placeholder')}
              spellCheck={false}
            />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </button>
              <button className="primary" onClick={submitRename}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
