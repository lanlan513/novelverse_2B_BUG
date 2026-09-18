import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  BookOpenText, Check, ChevronRight, Cloud, CloudOff, GitCompareArrows,
  Keyboard, Loader2, Menu, RefreshCw, Save, TriangleAlert, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { BOOKS, EDITIONS, findChapter, getParagraphs } from '../texts.js'
import { buildFlatText, makeAnchor, resolveAnchor, selectionToOffsets } from '../anchor.js'
import { buildSegments } from '../segments.js'
import { prefs, store } from '../store.js'
import ReadingPane from './ReadingPane.jsx'
import NotesPanel from './NotesPanel.jsx'
import { KeyboardHelp, NoteChooser, NotePopover, SelectionBubble } from './overlays.jsx'
import { NoteEditor, TrashView } from './editor.jsx'

const CHAPTERS = BOOKS.flatMap(b => b.chapters.map(c => ({ ...c, bookTitle: b.title })))

function Toast({ toast, onUndo, onDismiss }) {
  if (!toast) return null
  return (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.kind === 'error' ? <CloudOff size={15} /> : toast.kind === 'warn' ? <TriangleAlert size={15} /> : <Check size={15} />}
      <span>{toast.text}</span>
      {toast.undo && <button className="toast-undo" onClick={onUndo}>撤销</button>}
      <button className="icon-x" onClick={onDismiss} aria-label="关闭提示"><X size={13} /></button>
    </div>
  )
}

function SaveStatus({ status, connected, queueDepth, onRetry }) {
  const map = {
    saved: { icon: <Cloud size={14} />, text: '所有改动已保存', cls: 'saved' },
    saving: { icon: <Loader2 size={14} className="spin" />, text: '保存中…', cls: 'saving' },
    failed: { icon: <TriangleAlert size={14} />, text: `保存失败，已暂存本机${queueDepth ? `（${queueDepth} 项待同步）` : ''}`, cls: 'failed' },
    offline: { icon: <CloudOff size={14} />, text: `离线模式，改动存在本机${queueDepth ? `（${queueDepth} 项待同步）` : ''}`, cls: 'offline' },
    idle: { icon: <Save size={14} />, text: '准备中…', cls: 'idle' },
  }
  const cfg = map[status] || map.idle
  return (
    <button className={`save-status ${cfg.cls}`} onClick={onRetry} title="点击立即重试保存">
      {cfg.icon}<span>{cfg.text}</span>
      {(status === 'failed' || status === 'offline') && <RefreshCw size={12} />}
    </button>
  )
}

export default function ReaderApp() {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const initialPrefs = useRef(prefs.read())
  const [chapterId, setChapterId] = useState(CHAPTERS[0].id)
  const [edition, setEdition] = useState(initialPrefs.current.edition || 'chengjia')
  const [fontScale, setFontScale] = useState(initialPrefs.current.fontScale || 1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [panelOpenMobile, setPanelOpenMobile] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [scope, setScope] = useState('chapter')
  const [selection, setSelection] = useState(null) // {start,end,quote,rect}
  const [draft, setDraft] = useState(null) // {start,end,quote} 等待写入的新笔记
  const [editing, setEditing] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [openEl, setOpenEl] = useState(null)
  const [chooser, setChooser] = useState(null) // {ids, rect}
  const [pulseId, setPulseId] = useState(null)
  const [showTrash, setShowTrash] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [toast, setToast] = useState(null)
  const [selectionSupported] = useState(() => typeof window !== 'undefined'
    && typeof window.getSelection === 'function'
    && typeof document.createRange === 'function')

  const readerRef = useRef(null)
  const searchInputRef = useRef(null)
  const toastTimer = useRef(null)

  const { book, chapter } = useMemo(() => findChapter(chapterId), [chapterId])
  const paragraphs = useMemo(() => getParagraphs(chapter, edition), [chapter, edition])
  const flat = useMemo(() => buildFlatText(paragraphs), [paragraphs])

  // 各章在当前版本下的段落（重锚必须按笔记所属章节分别计算）
  const chapterParas = useMemo(() => {
    const m = new Map()
    for (const c of CHAPTERS) m.set(c.id, getParagraphs(c, edition))
    return m
  }, [edition])

  const activeNotes = useMemo(() => snap.notes.filter(n => !n.deleted), [snap.notes])

  // 重锚：每次原文/笔记变化，所有笔记在“自己所属章节的当前版本”重新定位
  const placements = useMemo(() => {
    const map = new Map()
    for (const note of activeNotes) {
      const paras = chapterParas.get(note.chapterId) || paragraphs
      map.set(note.id, resolveAnchor(paras, note.anchor))
    }
    return map
  }, [activeNotes, chapterParas, paragraphs])

  const { byPara: segmentsByPara } = useMemo(() => {
    // 仅本章笔记参与正文标记渲染，避免其它章节偏移串入
    const chapterMap = new Map([...placements].filter(([id]) => {
      const n = snap.notes.find(x => x.id === id)
      return n && n.chapterId === chapterId && !n.deleted
    }))
    return buildSegments(flat, chapterMap)
  }, [flat, placements, snap.notes, chapterId])

  // 编号：每章内部按位置顺序编号（跨章用“章回号.序号”区分）
  const numberById = useMemo(() => {
    const m = new Map()
    const chapterOrder = new Map(CHAPTERS.map((c, i) => [c.id, i]))
    const byChapter = new Map()
    for (const n of activeNotes) {
      const list = byChapter.get(n.chapterId) || []
      list.push(n)
      byChapter.set(n.chapterId, list)
    }
    for (const [cid, list] of byChapter) {
      list
        .map(n => ({ n, pl: placements.get(n.id) }))
        .sort((a, b) => {
          const ao = !a.pl || a.pl.status === 'orphan'
          const bo = !b.pl || b.pl.status === 'orphan'
          if (ao !== bo) return ao ? 1 : -1
          return (a.pl?.start ?? 0) - (b.pl?.start ?? 0)
        })
        .forEach((x, i) => m.set(x.n.id, i + 1))
    }
    return m
  }, [activeNotes, placements])

  const filterActive = Boolean(keyword.trim() || typeFilter !== 'all')
  const matchIdSet = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const set = new Set()
    for (const n of activeNotes) {
      if (n.chapterId !== chapterId && scope !== 'all') continue
      if (typeFilter !== 'all' && n.type !== typeFilter) continue
      if (kw && !n.content.toLowerCase().includes(kw) && !n.anchor.quote.toLowerCase().includes(kw)) continue
      set.add(n.id)
    }
    return set
  }, [activeNotes, keyword, typeFilter, scope, chapterId])

  const dimIds = useMemo(() => {
    if (!filterActive && !pulseId) return new Set()
    const set = new Set()
    for (const n of activeNotes) {
      if (pulseId) { if (n.id !== pulseId) set.add(n.id) }
      else if (!matchIdSet.has(n.id)) set.add(n.id)
    }
    return set
  }, [activeNotes, filterActive, pulseId, matchIdSet])

  useEffect(() => {
    prefs.write({ edition, fontScale })
  }, [edition, fontScale])

  const showToast = useCallback((text, kind = 'success', undo = null) => {
    clearTimeout(toastTimer.current)
    setToast({ text, kind, undo })
    if (!undo) toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  // ---------- 选区处理 ----------
  const captureSelection = useCallback(() => {
    if (!selectionSupported) return
    const offsets = selectionToOffsets(readerRef.current, flat)
    const sel = window.getSelection()
    if (!offsets || !sel || sel.isCollapsed) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) { setSelection(null); return }
    setSelection({ ...offsets, quote: flat.text.slice(offsets.start, offsets.end).replace(/\n/g, ''), rect })
  }, [flat, selectionSupported])

  useEffect(() => {
    const root = readerRef.current
    if (!root) return
    const onUp = () => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      setTimeout(captureSelection, 0)
    }
    const onDown = () => setSelection(null)
    const onSelChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !root.contains(sel.anchorNode)) setSelection(null)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchend', onUp)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchend', onUp)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('selectionchange', onSelChange)
    }
  }, [captureSelection])

  const clearSelection = () => {
    window.getSelection?.()?.removeAllRanges()
    setSelection(null)
  }

  const beginNoteFromSelection = () => {
    if (!selection) return
    setDraft({ start: selection.start, end: selection.end, quote: selection.quote })
    clearSelection()
  }

  const onSelectSentenceFallback = (paraId, startInPara, endInPara, text) => {
    const range = flat.ranges.find(r => r.paraId === paraId)
    if (!range) return
    setDraft({ start: range.start + startInPara, end: range.start + endInPara, quote: text })
  }

  // ---------- 笔记增改删 ----------
  const persistNote = async ({ type, content }) => {
    if (draft) {
      const anchor = makeAnchor(paragraphs, draft.start, draft.end, draft.quote)
      const note = await store.create({ chapterId, type, content, anchor })
      setDraft(null)
      showToast('笔记已添加并保存')
      openNoteAt(note.id, true)
    } else if (editing) {
      await store.update(editing.id, { type, content })
      setEditing(null)
      showToast('修改已保存')
      openNoteAt(editing.id, true)
    }
  }

  const onSoftDelete = useCallback(async id => {
    await store.softDelete(id)
    setOpenId(null); setChooser(null)
    showToast('笔记已移入回收站，可恢复', 'warn', { label: '撤销笔记', run: () => store.restore(id) })
  }, [showToast])

  const restoreNote = async id => {
    await store.restore(id)
    showToast('笔记已恢复')
  }

  const hardDelete = async id => {
    try {
      await store.hardDelete(id)
      showToast('笔记已永久删除')
    } catch { /* store 已提示 */ }
  }

  const emptyTrash = async () => {
    const deleted = snap.notes.filter(n => n.deleted)
    for (const n of deleted) await store.hardDelete(n.id)
    showToast('回收站已清空')
  }

  // 放宽重新匹配（处理版本变化）
  const refindNote = async noteId => {
    const note = snap.notes.find(n => n.id === noteId)
    if (!note) return
    const result = resolveAnchor(paragraphs, note.anchor, { relaxed: true })
    if (result.status === 'orphan') {
      showToast('放宽后仍未找到对应原文，可删除后在新版本上重新批注', 'error')
      return
    }
    const anchor = makeAnchor(paragraphs, result.start, result.end, result.matchedQuote)
    await store.update(noteId, { anchor })
    setOpenId(null)
    showToast('已按相似句重新定位笔记')
    openNoteAt(noteId, true)
  }

  // ---------- 打开 / 跳转 ----------
  const openNoteAt = useCallback((noteId, scroll = false) => {
    setOpenId(noteId)
    setChooser(null)
    setPulseId(noteId)
    setTimeout(() => setPulseId(null), 2400)
    if (scroll) {
      // 角标在每个批注区间起点都会渲染；新建笔记后等两帧确保 DOM 已提交
      const tryFocus = (attempts = 0) => {
        const el = document.querySelector(`i.note-badge[data-note-id="${noteId}"]`)
          || document.querySelector(`.note-mark[data-note-ids="${noteId}"]`)
        if (el) {
          setOpenEl(el)
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } else if (attempts < 4) {
          requestAnimationFrame(() => tryFocus(attempts + 1))
        }
      }
      requestAnimationFrame(() => tryFocus())
    } else {
      setOpenEl(document.querySelector(`i.note-badge[data-note-id="${noteId}"]`))
    }
  }, [])

  const openNoteFromPanel = useCallback((noteId) => {
    const note = snap.notes.find(n => n.id === noteId)
    setPanelOpenMobile(false)
    if (note && note.chapterId !== chapterId) {
      setChapterId(note.chapterId)
      setSelection(null); setOpenId(null)
      // 等章节渲染完成后再定位
      setTimeout(() => openNoteAt(noteId, true), 260)
    } else {
      openNoteAt(noteId, true)
    }
  }, [snap.notes, chapterId, openNoteAt])

  const onMarkClick = useCallback((id, el) => {
    setOpenEl(el || document.querySelector(`i.note-badge[data-note-id="${id}"]`))
    setOpenId(id)
  }, [])

  // 事件委托：点击正文上的批注标记 / 角标 / 悬挂提示
  useEffect(() => {
    const root = readerRef.current
    if (!root) return
    const onClick = event => {
      const badge = event.target.closest?.('i.note-badge')
      if (badge) {
        event.stopPropagation()
        setOpenEl(badge)
        setOpenId(badge.getAttribute('data-note-id'))
        return
      }
      const mark = event.target.closest?.('.note-mark')
      if (mark) {
        const ids = (mark.getAttribute('data-note-ids') || '').split(',').filter(Boolean)
        if (ids.length === 1) {
          setOpenEl(mark)
          setOpenId(ids[0])
        } else if (ids.length > 1) {
          setChooser({ ids, rect: mark.getBoundingClientRect() })
          setOpenId(null)
        }
        return
      }
      const orphanBtn = event.target.closest?.('.orphan-chip')
      if (orphanBtn) {
        setOpenEl(orphanBtn)
        setOpenId(orphanBtn.getAttribute('data-note-id'))
      }
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [])

  // 滚动时收起选择气泡（选区还在，但浮层不遮挡阅读）
  useEffect(() => {
    const onScroll = () => setSelection(s => (s ? { ...s, rect: null } : s))
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [])

  // ---------- 键盘操作 ----------
  const jumpByNote = useCallback((dir, currentId) => {
    const list = activeNotes
      .filter(n => n.chapterId === chapterId)
      .map(n => ({ id: n.id, pl: placements.get(n.id) }))
      .filter(x => x.pl && x.pl.status !== 'orphan')
      .sort((a, b) => a.pl.start - b.pl.start)
    if (!list.length) return
    let idx = list.findIndex(x => x.id === currentId)
    if (idx === -1) {
      idx = dir > 0 ? -1 : list.length
    }
    idx = (idx + dir + list.length) % list.length
    openNoteAt(list[idx].id, true)
  }, [activeNotes, chapterId, placements, openNoteAt])

  useEffect(() => {
    const onKey = e => {
      const tag = document.activeElement?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable
      if (e.target.closest?.('.modal-card')) return // 编辑器内由自己处理快捷键
      if (typing) {
        if (e.key === 'Escape') document.activeElement.blur()
        return
      }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); setShowHelp(true); return }
      if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus(); return }
      if (e.key.toLowerCase() === 'n' && selection) { e.preventDefault(); beginNoteFromSelection(); return }
      if (e.key.toLowerCase() === 'e' && openId) {
        const n = snap.notes.find(x => x.id === openId)
        if (n) { setEditing(n); setOpenId(null) }
        return
      }
      if (e.key === 'j' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); jumpByNote(1, openId || pulseId); return }
      if (e.key === 'k' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); jumpByNote(-1, openId || pulseId); return }
      if (e.key === 'Escape') {
        setChooser(null); setOpenId(null); setOpenEl(null); setPulseId(null); setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, openId, pulseId, snap.notes, jumpByNote])

  // 切章 / 换版后关闭浮层，避免锚点元素失效
  useEffect(() => {
    setOpenId(null); setOpenEl(null); setChooser(null); setSelection(null)
  }, [chapterId, edition])

  const trashNotes = snap.notes.filter(n => n.deleted)
  const openNote = snap.notes.find(n => n.id === openId)
  const openPlacement = openNote ? placements.get(openNote.id) : null
  const editionChanged = edition !== 'chengjia'
  const chapterNotesCount = activeNotes.filter(n => n.chapterId === chapterId).length
  const orphanCount = activeNotes.filter(n => n.chapterId === chapterId && placements.get(n.id)?.status === 'orphan').length
  const fuzzyCount = activeNotes.filter(n => n.chapterId === chapterId && placements.get(n.id)?.status === 'fuzzy').length

  return (
    <div className="reader-app" style={{ '--reader-font': `${fontScale}px` }}>
      <header className="reader-topbar">
        <button className="icon-btn only-mobile" onClick={() => setSidebarOpen(true)} aria-label="打开章节目录"><Menu size={19} /></button>
        <div className="book-crumb">
          <BookOpenText size={16} />
          <span>{book.title}</span>
          <ChevronRight size={13} />
          <strong>第{chapter.number}回</strong>
        </div>
        <div className="topbar-right">
          <div className="font-stepper" role="group" aria-label="正文字号">
            <button className="icon-btn" onClick={() => setFontScale(s => Math.max(15, s - 1))} aria-label="缩小字号"><ZoomOut size={15} /></button>
            <span>{fontScale}</span>
            <button className="icon-btn" onClick={() => setFontScale(s => Math.min(22, s + 1))} aria-label="放大字号"><ZoomIn size={15} /></button>
          </div>
          <SaveStatus status={snap.status} connected={snap.connected} queueDepth={snap.queueDepth} onRetry={() => store.retryQueue()} />
          <button className="icon-btn" onClick={() => setShowHelp(true)} aria-label="键盘操作帮助"><Keyboard size={17} /></button>
          <button className="secondary-btn sm only-mobile" onClick={() => setPanelOpenMobile(true)}>
            笔记 {chapterNotesCount > 0 && <em className="mobile-count">{chapterNotesCount}</em>}
          </button>
        </div>
      </header>

      <div className="reader-layout">
        <nav className={`chapter-rail ${sidebarOpen ? 'is-open' : ''}`}>
          <div className="rail-brand"><span className="brand-mark">精</span><div><strong>逐段精读</strong><small>Close Reading Notes</small></div></div>
          {BOOKS.map(b => (
            <div key={b.id} className="rail-book">
              <div className="rail-book-title">{b.title}<small>{b.author}</small></div>
              {b.chapters.map(c => (
                <button
                  key={c.id}
                  className={`rail-chapter ${c.id === chapterId ? 'active' : ''}`}
                  onClick={() => { setChapterId(c.id); setSidebarOpen(false); setSelection(null); setOpenId(null) }}
                >
                  <span className="rail-num">第{c.number}回</span>
                  <span className="rail-title">{c.title}</span>
                  <em>{activeNotes.filter(n => n.chapterId === c.id).length}</em>
                </button>
              ))}
            </div>
          ))}
        </nav>
        {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

        <main className="reader-column">
          <div className="reader-masthead">
            <span className="eyebrow">{book.title} · 第 {chapter.number} 回</span>
            <h1>{chapter.title}</h1>
            {chapter.editions.zhi && (
              <div className="edition-switch">
                <GitCompareArrows size={14} />
                <span>底本</span>
                {Object.entries(EDITIONS).map(([id, ed]) => chapter.editions[id] && (
                  <button key={id} className={edition === id ? 'active' : ''} onClick={() => setEdition(id)} title={ed.label}>
                    {ed.short}
                  </button>
                ))}
              </div>
            )}
          </div>

          {editionChanged && (
            <div className="drift-banner">
              <GitCompareArrows size={15} />
              <div>
                <strong>正在阅读{EDITIONS[edition].short}异文</strong>
                <span>
                  批注锚点已按引文与上下文自动重定位：
                  {orphanCount > 0 && <em className="t-orphan">{orphanCount} 条未找到</em>}
                  {fuzzyCount > 0 && <em className="t-fuzzy">{fuzzyCount} 条近似匹配</em>}
                  {orphanCount === 0 && fuzzyCount === 0 && <em className="t-ok">全部吻合</em>}
                  ，可随时切回{EDITIONS.chengjia.short}。
                </span>
              </div>
            </div>
          )}

          {!selectionSupported && (
            <div className="unsupported-banner">
              <TriangleAlert size={15} />
              <span>当前浏览器不支持自由文本选区，已为每句话启用“点句批注”模式：点击任意句子即可添加笔记。</span>
            </div>
          )}

          {snap.seeding && (
            <div className="loading-notes"><Loader2 size={15} className="spin" /> 正在准备示例精读笔记…</div>
          )}

          <div className="reader-scroll" ref={readerRef}>
            <ReadingPane
              paragraphs={paragraphs}
              segmentsByPara={segmentsByPara}
              notes={activeNotes.filter(n => n.chapterId === chapterId)}
              placements={placements}
              numberById={numberById}
              dimIds={dimIds}
              keyword={keyword}
              fallbackSelect={!selectionSupported}
              onSelectSentence={onSelectSentenceFallback}
              onMarkClick={onMarkClick}
              pulseId={pulseId}
              filterActive={filterActive}
            />
            <footer className="reader-footer">— 本回完 · 共 {paragraphs.length} 段 · {chapterNotesCount} 条笔记 —</footer>
          </div>
        </main>

        <div className={`panel-wrap ${panelOpenMobile ? 'is-open' : ''}`}>
          <NotesPanel
            notes={snap.notes}
            placements={placements}
            numberById={numberById}
            activeId={openId}
            keyword={keyword}
            onKeyword={setKeyword}
            typeFilter={typeFilter}
            onTypeFilter={setTypeFilter}
            scope={scope}
            onScope={setScope}
            selectedChapterId={chapterId}
            onOpenNote={openNoteFromPanel}
            onOpenTrash={() => setShowTrash(true)}
            pendingCount={trashNotes.length}
          />
        </div>
        {panelOpenMobile && <div className="scrim" onClick={() => setPanelOpenMobile(false)} />}
      </div>

      {selection && selection.rect && (
        <SelectionBubble rect={selection.rect} onAdd={beginNoteFromSelection} />
      )}

      {chooser && (
        <NoteChooser
          rect={chooser.rect}
          notes={chooser.ids.map(id => snap.notes.find(n => n.id === id)).filter(Boolean)}
          numberById={numberById}
          onPick={id => {
            const marks = [...document.querySelectorAll('.note-mark')]
            const wanted = new Set(chooser.ids)
            const mark = marks.find(m => {
              const ids = (m.getAttribute('data-note-ids') || '').split(',')
              return ids.length === wanted.size && ids.every(x => wanted.has(x))
            })
            setOpenEl(mark || null)
            setOpenId(id)
            setChooser(null)
          }}
          onClose={() => setChooser(null)}
        />
      )}

      {openNote && !chooser && (
        <NotePopover
          note={openNote}
          number={numberById.get(openNote.id) || '·'}
          placement={openPlacement}
          anchorEl={openEl}
          onClose={() => { setOpenId(null); setOpenEl(null) }}
          onEdit={n => { setEditing(n); setOpenId(null) }}
          onSoftDelete={onSoftDelete}
          onRefind={refindNote}
        />
      )}

      {(draft || editing) && (
        <NoteEditor
          initial={editing}
          selectionQuote={draft?.quote}
          onSave={persistNote}
          onClose={() => { setDraft(null); setEditing(null) }}
        />
      )}

      {showTrash && (
        <TrashView
          notes={trashNotes}
          onRestore={id => { restoreNote(id) }}
          onHardDelete={hardDelete}
          onEmpty={emptyTrash}
          onClose={() => setShowTrash(false)}
        />
      )}

      {showHelp && <KeyboardHelp onClose={() => setShowHelp(false)} />}

      <Toast
        toast={toast}
        onUndo={() => { toast?.undo?.run?.(); setToast(null) }}
        onDismiss={() => setToast(null)}
      />
    </div>
  )
}
