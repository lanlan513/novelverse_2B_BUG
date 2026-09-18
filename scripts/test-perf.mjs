// 性能：几百条笔记下的重锚、片段计算、渲染节点规模
import { resolveAnchor, buildFlatText } from '../src/reader/anchor.js'
import { buildSegments } from '../src/reader/segments.js'
import { findChapter, getParagraphs } from '../src/reader/texts.js'

const { chapter } = findChapter('ch27') // 最长的一回（含葬花吟）
const paragraphs = getParagraphs(chapter, 'chengjia')
const flat = buildFlatText(paragraphs)

function makeNotes(n) {
  const notes = []
  const placements = []
  // 在全文中均匀取 n 段引文，每段 8~24 字，制造重叠
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i / n) * (flat.text.length - 60)) + (i % 5)
    const len = 8 + (i % 17)
    const end = start + len
    if (end > flat.text.length) continue
    const quote = flat.text.slice(start, end).replace(/\n/g, '')
    if (!quote.trim()) continue
    const id = `note-perf-${i}`
    const prefix = flat.text.slice(Math.max(0, start - 18), start)
    const suffix = flat.text.slice(end, end + 18)
    notes.push({ id, chapterId: 'ch27', type: ['character', 'narrative', 'language', 'symbol', 'plot'][i % 5], anchor: { quote, prefix, suffix, paraHint: null } })
  }
  return notes
}

const N = 500
const notes = makeNotes(N)

const t0 = process.hrtime.bigint()
const map = new Map()
for (const note of notes) map.set(note.id, resolveAnchor(paragraphs, note.anchor))
const t1 = process.hrtime.bigint()
const { byPara } = buildSegments(flat, map)
const t2 = process.hrtime.bigint()

const anchored = [...map.values()].filter(p => p.status !== 'orphan').length
const segCount = [...byPara.values()].reduce((a, l) => a + l.length, 0)
const overlapCount = [...byPara.values()].flat().filter(s => s.noteIds.length > 1).length
const resolveMs = Number(t1 - t0) / 1e6
const segmentMs = Number(t2 - t1) / 1e6

console.log(`笔记数: ${notes.length}，成功定位: ${anchored}`)
console.log(`重锚耗时: ${resolveMs.toFixed(1)}ms（平均 ${(resolveMs / notes.length).toFixed(3)}ms/条）`)
console.log(`片段切分耗时: ${segmentMs.toFixed(1)}ms`)
console.log(`渲染片段数: ${segCount}，其中重叠片段: ${overlapCount}`)

let pass = true
const check = (cond, name) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) pass = false }
check(anchored >= N * 0.95, `95%+ 笔记成功定位（${anchored}/${notes.length}）`)
check(resolveMs < 300, `500 条重锚 <300ms（实际 ${resolveMs.toFixed(0)}ms）`)
check(segmentMs < 100, `片段切分 <100ms（实际 ${segmentMs.toFixed(0)}ms）`)
check(segCount < 4000, `DOM 片段规模可控 <4000（实际 ${segCount}）`)

// 单次 React 增量更新（模拟新增一条笔记）只重算的耗时
const t3 = process.hrtime.bigint()
const one = resolveAnchor(paragraphs, notes[10].anchor)
const map2 = new Map(map)
map2.set('new-note', one)
buildSegments(flat, map2)
const t4 = process.hrtime.bigint()
const updateMs = Number(t4 - t3) / 1e6
check(updateMs < 100, `单次更新重算 <100ms（实际 ${updateMs.toFixed(1)}ms）`)

process.exit(pass ? 0 : 1)
