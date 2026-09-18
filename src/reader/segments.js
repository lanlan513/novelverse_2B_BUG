// 把笔记的全局偏移区间切成“按段落、可重叠”的渲染片段
import { locateParagraph } from './anchor.js'

export function buildSegments(flat, placements) {
  const byPara = new Map(flat.ranges.map(r => [r.paraId, []]))
  const intervals = []
  for (const [noteId, pl] of placements) {
    if (!pl || pl.status === 'orphan' || pl.start < 0 || pl.end <= pl.start) continue
    intervals.push({
      s: Math.max(0, pl.start),
      e: Math.min(flat.text.length, pl.end),
      noteId,
      status: pl.status,
    })
  }
  if (!intervals.length) return { byPara, intervals }

  // 记录每个起点开始了哪些笔记（重叠时用于编号角标）
  const startsAt = new Map()
  for (const i of intervals) {
    const list = startsAt.get(i.s) || []
    list.push(i.noteId)
    startsAt.set(i.s, list)
  }

  // 所有区间端点排序后切分；同一小片可能被多条笔记覆盖（重叠）
  const points = [...new Set(intervals.flatMap(i => [i.s, i.e]))].sort((a, b) => a - b)
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]
    const b = points[k + 1]
    if (a === b) continue
    const covering = intervals.filter(i => i.s <= a && i.e >= b)
    if (!covering.length) continue
    const noteIds = covering.map(i => i.noteId)
    const beginIds = (startsAt.get(a) || []).filter(id => noteIds.includes(id))
    const fuzzy = covering.some(i => i.status === 'fuzzy')
    const disambiguated = covering.some(i => i.status === 'disambiguated')

    let cursor = a
    let pi = locateParagraph(flat.ranges, cursor)
    while (cursor < b && pi >= 0) {
      const range = flat.ranges[pi]
      const e2 = Math.min(b, range.end)
      if (e2 > cursor) {
        const list = byPara.get(range.paraId) || []
        list.push({
          start: cursor - range.start,
          end: e2 - range.start,
          noteIds,
          beginIds: cursor === a ? beginIds : [],
          fuzzy,
          disambiguated,
          cross: cursor > a || e2 < b,
        })
        byPara.set(range.paraId, list)
      }
      cursor = e2
      if (cursor < b) {
        cursor += 1 // 跳过段末 \n
        pi = locateParagraph(flat.ranges, cursor)
      }
    }
  }
  return { byPara, intervals }
}

// 句子切分（仅在浏览器不支持文本选区时启用的兜底交互）
const SENTENCE_RE = /[^。！？；\n]+[。！？；…]*\n?/g

export function splitSentences(text) {
  const out = []
  let m
  SENTENCE_RE.lastIndex = 0
  while ((m = SENTENCE_RE.exec(text)) !== null) {
    const piece = m[0]
    if (!piece.trim()) {
      out.push({ text: piece, selectable: false, start: m.index, end: m.index + piece.length })
      continue
    }
    out.push({ text: piece, selectable: true, start: m.index, end: m.index + piece.length })
  }
  return out
}
