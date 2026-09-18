import React, { memo, useMemo } from 'react'
import { splitSentences } from '../segments.js'
import { TYPE_MAP } from '../store.js'

function escapeRegExp(s) {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(text, keyword, prefix) {
  if (!keyword.trim()) return text
  let re
  try { re = new RegExp(`(${escapeRegExp(keyword)})`, 'gi') } catch { return text }
  return text.split(re).map((part, i) => (i % 2 === 1
    ? <mark key={`${prefix}-kw-${i}`} className="kw-hit">{part}</mark>
    : <React.Fragment key={`${prefix}-kw-${i}`}>{part}</React.Fragment>))
}

const Paragraph = memo(function Paragraph({
  para, segments, typeById, numberById, dimIds, keyword, fallbackSelect,
  onSelectSentence, pulseId, filterActive,
}) {
  const renderLine = (text, keyPrefix, lineOffset = 0) => {
    if (fallbackSelect) {
      return splitSentences(text).map((sent, i) => sent.selectable ? (
        <button
          key={`${keyPrefix}-s${i}`}
          type="button"
          className="sentence-fallback"
          onClick={() => onSelectSentence(para.id, lineOffset + sent.start, lineOffset + sent.end, sent.text)}
        >{highlight(sent.text, keyword, `${keyPrefix}-s${i}`)}</button>
      ) : <React.Fragment key={`${keyPrefix}-s${i}`}>{sent.text}</React.Fragment>)
    }
    // 诗歌按行渲染：把相对整段的片段裁剪到本行
    const lineSegments = lineOffset === 0 ? segments : segments.map(seg => {
      const s = Math.max(seg.start, lineOffset) - lineOffset
      const e = Math.min(seg.end, lineOffset + text.length) - lineOffset
      if (e <= 0 || s >= text.length) return null
      return { ...seg, start: s, end: e, beginIds: seg.start >= lineOffset ? seg.beginIds : [] }
    }).filter(Boolean)
    if (lineSegments.length === 0) return highlight(text, keyPrefix)

    const sorted = [...lineSegments].sort((a, b) => a.start - b.start || b.noteIds.length - a.noteIds.length)
    const parts = []
    let cursor = 0
    sorted.forEach((seg, i) => {
      if (seg.start > cursor) parts.push(<React.Fragment key={`t${i}`}>{highlight(text.slice(cursor, seg.start), `${keyPrefix}-t${i}`)}</React.Fragment>)
      const piece = text.slice(seg.start, seg.end)
      if (!piece) return
      const overlap = seg.noteIds.length > 1
      const colors = [...new Set(seg.noteIds.map(id => TYPE_MAP[typeById.get(id)]?.color).filter(Boolean))]
      const allDim = seg.noteIds.every(id => dimIds.has(id))
      const cls = [
        'note-mark',
        overlap ? 'is-overlap' : '',
        seg.fuzzy ? 'is-fuzzy' : '',
        seg.disambiguated ? 'is-disamb' : '',
        seg.cross ? 'is-cross' : '',
        filterActive && allDim ? 'is-dim' : '',
      ].filter(Boolean).join(' ')
      parts.push(
        <mark
          key={`m${i}`}
          className={cls}
          data-note-ids={seg.noteIds.join(',')}
          style={!overlap
            ? { '--mark-color': colors[0] }
            : { '--mark-a': colors[0], '--mark-b': colors[1] || colors[0] }}
        >
          {seg.beginIds.length > 0 && (
            <span className="note-badges">
              {seg.beginIds.map(id => (
                <i
                  key={id}
                  className={`note-badge${pulseId === id ? ' pulse' : ''}`}
                  data-note-id={id}
                  data-n={numberById.get(id)}
                  style={{ '--mark-color': TYPE_MAP[typeById.get(id)]?.color }}
                />
              ))}
            </span>
          )}
          {highlight(piece, keyword, `${keyPrefix}-m${i}`)}
        </mark>,
      )
      cursor = Math.max(cursor, seg.end)
    })
    if (cursor < text.length) parts.push(<React.Fragment key="tend">{highlight(text.slice(cursor), `${keyPrefix}-tend`)}</React.Fragment>)
    return parts
  }

  const lines = para.text.split('\n')
  let runningOffset = 0
  return (
    <p id={`para-${para.id}`} data-para-id={para.id} className={`reader-paragraph${para.poem ? ' is-poem' : ''}`}>
      {para.poem && para.text.includes('\n')
        ? lines.map((line, i) => {
            const lineOffset = runningOffset
            runningOffset += line.length + 1
            return (
              <React.Fragment key={i}>
                {renderLine(line, `l${i}`, lineOffset)}
                {i < lines.length - 1 && <br />}
              </React.Fragment>
            )
          })
        : renderLine(para.text, 'p')}
    </p>
  )
})

function OrphanStrip({ orphanNotes, numberById, onOpen }) {
  return (
    <div className="orphan-strip">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></svg>
      <span>{orphanNotes.length} 条笔记的引文在当前版本中未找到</span>
      {orphanNotes.slice(0, 3).map(n => (
        <button key={n.id} type="button" className="orphan-chip" data-note-id={n.id} onClick={e => onOpen(n.id, e.currentTarget)}>
          {TYPE_MAP[n.type]?.label}#{numberById.get(n.id)}
        </button>
      ))}
    </div>
  )
}

export default function ReadingPane({
  paragraphs, segmentsByPara, notes, placements, numberById, dimIds,
  keyword, fallbackSelect, onSelectSentence, onMarkClick, pulseId, filterActive,
}) {
  const typeById = useMemo(() => new Map(notes.map(n => [n.id, n.type])), [notes])
  const orphansByPara = useMemo(() => {
    const byPara = new Map()
    for (const n of notes) {
      if (n.deleted) continue
      const pl = placements.get(n.id)
      if (pl?.status === 'orphan' && n.anchor.paraHint) {
        const list = byPara.get(n.anchor.paraHint) || []
        list.push(n)
        byPara.set(n.anchor.paraHint, list)
      }
    }
    return byPara
  }, [notes, placements])

  return (
    <div className="reader-body" aria-label="小说原文">
      {paragraphs.map(para => (
        <React.Fragment key={para.id}>
          {orphansByPara.has(para.id) && (
            <OrphanStrip
              orphanNotes={orphansByPara.get(para.id)}
              numberById={numberById}
              onOpen={onMarkClick}
            />
          )}
          <Paragraph
            para={para}
            segments={segmentsByPara.get(para.id) || []}
            typeById={typeById}
            numberById={numberById}
            dimIds={dimIds}
            keyword={keyword}
            fallbackSelect={fallbackSelect}
            onSelectSentence={onSelectSentence}
            pulseId={pulseId}
            filterActive={filterActive}
          />
        </React.Fragment>
      ))}
    </div>
  )
}
