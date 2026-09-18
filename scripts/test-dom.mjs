// 用 jsdom 验证“浏览器选区 -> 原文偏移”与片段渲染逻辑
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { buildFlatText, selectionToOffsets, makeAnchor } from '../src/reader/anchor.js'
import { buildSegments } from '../src/reader/segments.js'
import { resolveAnchor } from '../src/reader/anchor.js'
import { findChapter, getParagraphs } from '../src/reader/texts.js'

const dom = new JSDOM('<!doctype html><html><body><div id="reader"></div></body></html>', { pretendToBeVisual: true })
global.window = dom.window
global.document = dom.window.document
global.Node = dom.window.Node
const { document, window } = global

const { chapter } = findChapter('ch3')
const paragraphs = getParagraphs(chapter, 'chengjia')
const flat = buildFlatText(paragraphs)

// 按与 ReadingPane 相同的结构渲染段落（纯文本节点 + data-para-id）
const root = document.getElementById('reader')
for (const para of paragraphs) {
  const el = document.createElement('p')
  el.setAttribute('data-para-id', para.id)
  el.textContent = para.text
  root.appendChild(el)
}

// 构造一个假 Selection（jsdom 未实现 Selection），包装真实 Range
function fakeSelection(range) {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: range.startContainer,
    getRangeAt: () => range,
  }
}

function rangeWithin(paraEl, start, end) {
  const node = paraEl.firstChild
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

let pass = 0; let fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`) }
}

console.log('A) 段内选区偏移')
{
  const para = root.querySelector('[data-para-id="c3-01"]')
  const sentence = '步步留心，时时在意'
  const localIdx = paragraphs[0].text.indexOf(sentence)
  const range = rangeWithin(para, localIdx, localIdx + sentence.length)
  window.getSelection = () => fakeSelection(range)
  const off = selectionToOffsets(root, flat)
  check('返回有效区间', () => assert.ok(off))
  check('切片等于所选文字', () => assert.equal(flat.text.slice(off.start, off.end), sentence))
}

console.log('B) 跨段落选区偏移')
{
  const p1 = root.querySelector('[data-para-id="c3-01"]')
  const p2 = root.querySelector('[data-para-id="c3-02"]')
  const tail = paragraphs[0].text.slice(-10)
  const head = paragraphs[1].text.slice(0, 12)
  const node1 = p1.firstChild
  const node2 = p2.firstChild
  const range = document.createRange()
  range.setStart(node1, paragraphs[0].text.length - 10)
  range.setEnd(node2, 12)
  window.getSelection = () => fakeSelection(range)
  const off = selectionToOffsets(root, flat)
  check('跨段选区可解析', () => assert.ok(off))
  check('内容等于尾句+换行+首句', () => {
    // 选区跨两个块元素，结尾段的 toString 不含换行
    const slice = flat.text.slice(off.start, off.end)
    assert.ok(slice.startsWith(tail), `应以尾句开头：${slice.slice(0, 20)}`)
    assert.ok(slice.endsWith(head), `应包含第二段首句`)
  })
}

console.log('C) 选区在 reader 之外返回 null')
{
  const outside = document.createElement('div')
  document.body.appendChild(outside)
  outside.textContent = '外部文本'
  const range = document.createRange()
  range.selectNodeContents(outside)
  window.getSelection = () => fakeSelection(range)
  check('越界选区 -> null', () => assert.equal(selectionToOffsets(root, flat), null))
}

console.log('D) 不支持 getSelection 时返回 null')
{
  const saved = window.getSelection
  window.getSelection = undefined
  check('无 Selection API -> null', () => assert.equal(selectionToOffsets(root, flat), null))
  window.getSelection = saved
}

console.log('E) 重叠笔记的片段切分')
{
  // 两条相交批注
  const base = paragraphs[2].text
  const r3 = flat.ranges.find(r => r.paraId === 'c3-03')
  const a = { start: r3.start + 4, end: r3.start + 30 }
  const b = { start: r3.start + 18, end: r3.start + 44 }
  const placements = new Map([
    ['note-a', { status: 'exact', start: a.start, end: a.end, paraId: 'c3-03' }],
    ['note-b', { status: 'exact', start: b.start, end: b.end, paraId: 'c3-03' }],
  ])
  const { byPara } = buildSegments(flat, placements)
  const segs = byPara.get('c3-03')
  check('切出至少 3 个片段（a-only / overlap / b-only）', () => assert.ok(segs.length >= 3))
  const overlapSeg = segs.find(s => s.noteIds.length === 2)
  check('存在双覆盖片段', () => assert.ok(overlapSeg))
  const beginSegs = segs.filter(s => s.beginIds.length > 0)
  check('两个起点各记录一次角标', () => {
    const ids = beginSegs.flatMap(s => s.beginIds).sort()
    assert.deepEqual(ids, ['note-a', 'note-b'])
  })
  check('片段拼接无重叠空洞', () => {
    const sorted = [...segs].sort((x, y) => x.start - y.start)
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end)
  })
}

console.log('F) 跨段落批注的片段')
{
  const r1 = flat.ranges.find(r => r.paraId === 'c3-01')
  const r2 = flat.ranges.find(r => r.paraId === 'c3-02')
  const placements = new Map([
    ['cross', { status: 'exact', start: r1.end - 12, end: r2.start + 20, paraId: 'c3-01' }],
  ])
  const { byPara } = buildSegments(flat, placements)
  check('两段都有片段', () => assert.ok(byPara.get('c3-01').length && byPara.get('c3-02').length))
  check('只有起点段带角标', () => {
    assert.equal(byPara.get('c3-01').some(s => s.beginIds.includes('cross')), true)
    assert.equal(byPara.get('c3-02').some(s => s.beginIds.includes('cross')), false)
  })
}

console.log('G) makeAnchor 往返一致')
{
  const r = flat.ranges.find(x => x.paraId === 'c3-05')
  const anchor = makeAnchor(paragraphs, r.start + 3, r.start + 25)
  const resolved = resolveAnchor(paragraphs, anchor)
  check('重新解析回原区间', () => {
    assert.equal(resolved.start, r.start + 3)
    assert.equal(resolved.end, r.start + 25)
  })
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
