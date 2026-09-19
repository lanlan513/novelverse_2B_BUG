import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Keyboard, MapPinOff, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import { TYPE_MAP } from '../store.js'

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = e => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

// 跟随某个 DOM 元素的浮层定位（滚动/缩放时实时更新）
// 依赖数组必须包含 anchorEl：否则该 effect 每次渲染后都运行，
// setPos 又会触发再渲染，形成“更新深度超限”的死循环并白屏
export function useAnchoredPosition(anchorEl, deps = []) {
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    if (!anchorEl) { setPos(null); return }
    const update = () => {
      const r = anchorEl.getBoundingClientRect()
      setPos({ top: r.bottom, left: r.left, width: r.width, rect: r })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update) }
  }, [anchorEl, ...deps])
  return pos
}

export function SelectionBubble({ rect, onAdd }) {
  const style = {
    position: 'fixed',
    left: Math.max(8, Math.min(window.innerWidth - 168, rect.left + rect.width / 2 - 80)),
    top: Math.max(8, rect.top - 46),
  }
  return (
    <div className="selection-bubble" style={style}>
      <button className="bubble-btn" onMouseDown={e => e.preventDefault()} onClick={onAdd}>
        <Pencil size={14} /> 写精读笔记 <kbd>N</kbd>
      </button>
    </div>
  )
}

export function NoteChooser({ rect, notes, numberById, onPick, onClose }) {
  const isNarrow = window.innerWidth <= 720
  const style = isNarrow
    ? { position: 'fixed', left: 12, right: 12, bottom: 12 }
    : { position: 'fixed', left: Math.min(rect.left, window.innerWidth - 290), top: rect.bottom + 8, width: 280 }
  return (
    <div className="note-chooser card-shadow" style={style}>
      <div className="chooser-head"><strong>这里有 {notes.length} 条笔记</strong><button className="icon-x" onClick={onClose} aria-label="关闭"><X size={14} /></button></div>
      {notes.map(note => (
        <button key={note.id} className="chooser-item" onClick={() => onPick(note.id)}>
          <span className="note-num" style={{ '--type-color': TYPE_MAP[note.type]?.color }}>{numberById.get(note.id)}</span>
          <span className="chooser-type" style={{ color: TYPE_MAP[note.type]?.color }}>{TYPE_MAP[note.type]?.label}</span>
          <span className="chooser-excerpt">{note.content.slice(0, 26)}</span>
        </button>
      ))}
    </div>
  )
}

export function NotePopover({ note, number, placement, anchorEl, onClose, onEdit, onSoftDelete, onRefind }) {
  const isNarrow = useMediaQuery('(max-width: 720px)')
  const pos = useAnchoredPosition(!isNarrow ? anchorEl : null)
  const type = TYPE_MAP[note.type]
  const orphan = !placement || placement.status === 'orphan'

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  let style
  let cls = 'note-popover card-shadow'
  if (isNarrow || !pos) {
    style = { position: 'fixed', left: 12, right: 12, bottom: 12 }
    cls += ' is-sheet'
  } else {
    const left = Math.max(8, Math.min(window.innerWidth - 328, pos.left))
    const above = pos.rect.bottom > window.innerHeight - 260
    style = { position: 'fixed', left, width: 320, ...(above ? { bottom: window.innerHeight - pos.rect.top + 8 } : { top: pos.rect.bottom + 8 }) }
  }

  return (
    <div className={cls} style={style} role="dialog" aria-label="笔记详情">
      <div className="popover-head">
        <span className="type-chip" style={{ '--type-color': type?.color }}>
          <span className="note-num" style={{ '--type-color': type?.color }}>{number}</span>{type?.label}笔记
        </span>
        <button className="icon-x" onClick={onClose} aria-label="关闭"><X size={15} /></button>
      </div>
      {orphan ? (
        <div className="orphan-box">
          <p className="orphan-warn"><MapPinOff size={15} /> 当前版本里找不到这段引文了</p>
          <blockquote className="popover-quote">{note.anchor.quote}</blockquote>
          {note.anchor.paraHint && <p className="orphan-hint">仍保留在原段落位置，原文换版后可能已改写。</p>}
        </div>
      ) : (
        <blockquote className="popover-quote" style={{ borderLeftColor: type?.color }}>{placement.matchedQuote || note.anchor.quote}</blockquote>
      )}
      <p className="popover-content">{note.content}</p>
      {placement?.status === 'fuzzy' && <p className="placement-flag fuzzy"><AlertTriangle size={13} /> 原文略有出入，按相似句模糊定位</p>}
      {placement?.status === 'disambiguated' && <p className="placement-flag disamb"><ArrowUpRight size={13} /> 该句在本章出现多次，已按上下文定位</p>}
      <div className="popover-foot">
        <button className="pop-action" onClick={() => onEdit(note)}><Pencil size={13} />修改</button>
        {orphan && onRefind && <button className="pop-action" onClick={() => onRefind(note.id)}><RotateCcw size={13} />放宽重新匹配</button>}
        <button className="pop-action danger" onClick={() => onSoftDelete(note.id)}><Trash2 size={13} />删除</button>
      </div>
    </div>
  )
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal-card card-shadow ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-x" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function KeyboardHelp({ onClose }) {
  const rows = [
    ['J / K 或 Alt+↑↓', '在有笔记的句子之间跳转'],
    ['N', '为当前选中的原文新建笔记'],
    ['E', '修改当前打开的笔记'],
    ['⌘/Ctrl + Enter', '保存正在编辑的笔记'],
    ['/', '聚焦笔记关键词搜索'],
    ['1–5', '编辑器中快速选择笔记类型'],
    ['Esc', '关闭弹层 / 清除跳转高亮'],
    ['?', '打开本帮助'],
  ]
  return (
    <Modal title={<><Keyboard size={18} /> 键盘操作速查</>} onClose={onClose}>
      <ul className="kbd-list">
        {rows.map(([k, v]) => <li key={k}><kbd>{k}</kbd><span>{v}</span></li>)}
      </ul>
      <p className="modal-foot-note">窄屏设备上全部操作都有对应的按钮入口，不依赖键盘。</p>
    </Modal>
  )
}
