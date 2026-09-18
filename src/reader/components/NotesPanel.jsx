import React, { useMemo } from 'react'
import { Layers, MapPinOff, Trash2 } from 'lucide-react'
import { NOTE_TYPES, TYPE_MAP } from '../store.js'
import { BOOKS } from '../texts.js'
import { HighlightedText, SearchInput } from './editor.jsx'

const CHAPTER_LABELS = new Map()
for (const book of BOOKS) {
  for (const ch of book.chapters) CHAPTER_LABELS.set(ch.id, `第${ch.number}回`)
}

export default function NotesPanel({
  notes, placements, numberById, activeId, keyword, onKeyword,
  typeFilter, onTypeFilter, scope, onScope, selectedChapterId,
  onOpenNote, onOpenTrash, pendingCount,
}) {
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return notes
      .filter(n => !n.deleted)
      .filter(n => scope === 'chapter' ? n.chapterId === selectedChapterId : true)
      .filter(n => typeFilter === 'all' || n.type === typeFilter)
      .filter(n => {
        if (!kw) return true
        return n.content.toLowerCase().includes(kw) || n.anchor.quote.toLowerCase().includes(kw)
      })
      .sort((a, b) => {
        const pa = placements.get(a.id)
        const pb = placements.get(b.id)
        const ao = !pa || pa.status === 'orphan'
        const bo = !pb || pb.status === 'orphan'
        if (ao !== bo) return ao ? 1 : -1
        if (pa?.start !== pb?.start) return (pa?.start ?? 0) - (pb?.start ?? 0)
        return new Date(a.createdAt) - new Date(b.createdAt)
      })
  }, [notes, placements, keyword, typeFilter, scope, selectedChapterId])

  const counts = useMemo(() => {
    const inScope = notes.filter(n => !n.deleted && (scope === 'all' || n.chapterId === selectedChapterId))
    const map = { all: inScope.length }
    for (const t of NOTE_TYPES) map[t.id] = inScope.filter(n => n.type === t.id).length
    return map
  }, [notes, scope, selectedChapterId])

  const anchored = visible.filter(n => placements.get(n.id)?.status !== 'orphan')
  const orphans = visible.filter(n => placements.get(n.id)?.status === 'orphan')

  return (
    <aside className="notes-panel" aria-label="笔记列表">
      <div className="panel-head">
        <h2><Layers size={16} /> 精读笔记</h2>
        <button className="secondary-btn sm" onClick={onOpenTrash}>
          <Trash2 size={13} />回收站{pendingCount > 0 && <span className="trash-badge">{pendingCount}</span>}
        </button>
      </div>

      <div className="scope-switch" role="tablist" aria-label="查找范围">
        <button role="tab" className={scope === 'chapter' ? 'active' : ''} onClick={() => onScope('chapter')}>本章</button>
        <button role="tab" className={scope === 'all' ? 'active' : ''} onClick={() => onScope('all')}>全书</button>
      </div>

      <SearchInput value={keyword} onChange={onKeyword} />

      <div className="type-filter" role="group" aria-label="按类型筛选">
        <button className={typeFilter === 'all' ? 'active' : ''} onClick={() => onTypeFilter('all')}>
          全部 <em>{counts.all}</em>
        </button>
        {NOTE_TYPES.map(t => (
          <button
            key={t.id}
            className={typeFilter === t.id ? 'active' : ''}
            style={{ '--type-color': t.color }}
            onClick={() => onTypeFilter(typeFilter === t.id ? 'all' : t.id)}
          >
            <span className="type-dot" />{t.label} <em>{counts[t.id]}</em>
          </button>
        ))}
      </div>

      <div className="panel-list" role="list">
        {anchored.length === 0 && orphans.length === 0 && (
          <li className="panel-empty">
            <p>没有符合条件的笔记。</p>
            <span>在原文中选中句子，按 <kbd>N</kbd> 即可添加。</span>
          </li>
        )}
        {anchored.map(note => {
          const pl = placements.get(note.id)
          const type = TYPE_MAP[note.type]
          return (
            <button
              key={note.id}
              role="listitem"
              className={`panel-item ${activeId === note.id ? 'active' : ''}`}
              style={{ '--type-color': type?.color }}
              onClick={() => onOpenNote(note.id)}
            >
              <div className="panel-item-top">
                <span className="type-chip sm">
                  <span className="note-num">{numberById.get(note.id) || '·'}</span>
                  {type?.label}
                </span>
                {scope === 'all' && <span className="chapter-tag">{CHAPTER_LABELS.get(note.chapterId)}</span>}
              </div>
              <blockquote className="panel-quote">
                <HighlightedText text={pl?.matchedQuote || note.anchor.quote} keyword={keyword} />
              </blockquote>
              <p className="panel-excerpt">
                <HighlightedText text={note.content} keyword={keyword} />
              </p>
              <div className="panel-item-flags">
                {pl?.status === 'fuzzy' && <span className="flag fuzzy">模糊定位</span>}
                {pl?.status === 'disambiguated' && <span className="flag disamb">多义消歧</span>}
              </div>
            </button>
          )
        })}
        {orphans.length > 0 && (
          <li className="orphan-group" aria-label="无法定位的笔记">
            <div className="orphan-group-head"><MapPinOff size={13} /> 当前版本无法定位（{orphans.length}）</div>
            {orphans.map(note => {
              const type = TYPE_MAP[note.type]
              return (
                <button
                  key={note.id}
                  role="listitem"
                  className={`panel-item orphan ${activeId === note.id ? 'active' : ''}`}
                  style={{ '--type-color': type?.color }}
                  onClick={() => onOpenNote(note.id)}
                >
                  <div className="panel-item-top">
                    <span className="type-chip sm">{type?.label}</span>
                    {scope === 'all' && <span className="chapter-tag">{CHAPTER_LABELS.get(note.chapterId)}</span>}
                  </div>
                  <blockquote className="panel-quote"><HighlightedText text={note.anchor.quote} keyword={keyword} /></blockquote>
                  <p className="panel-excerpt"><HighlightedText text={note.content} keyword={keyword} /></p>
                </button>
              )
            })}
          </li>
        )}
      </div>
    </aside>
  )
}
