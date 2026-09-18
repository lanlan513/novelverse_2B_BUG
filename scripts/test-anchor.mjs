import { resolveAnchor, makeAnchor, buildFlatText, locateParagraph, normalize } from '../src/reader/anchor.js'
import { getParagraphs, findChapter } from '../src/reader/texts.js'

let pass = 0; let fail = 0
function assert(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

const { chapter: ch3 } = findChapter('ch3')
const chengjia = getParagraphs(ch3, 'chengjia')
const zhi = getParagraphs(ch3, 'zhi')
const flat = buildFlatText(chengjia)

console.log('1) 精确匹配')
{
  const quote = '步步留心，时时在意，不肯轻易多说一句话'
  const a = makeAnchor(chengjia, flat.text.indexOf(quote), flat.text.indexOf(quote) + quote.length)
  const r = resolveAnchor(chengjia, a)
  assert(r.status === 'exact', `唯一精确命中 -> ${r.status}`)
  assert(flat.text.slice(r.start, r.end) === quote, '区间还原引文一致')
  assert(r.paraId === 'c3-01', `落在 c3-01，实际 ${r.paraId}`)
}

console.log('2) 多义消歧（引文重复出现时按上下文选择）')
{
  // “宝玉笑道：” 在章中多次出现，靠上下文区分
  const phrase = '宝玉笑道：'
  const first = flat.text.indexOf(phrase)
  const second = flat.text.indexOf(phrase, first + 1)
  assert(first > 0 && second > first, `“${phrase}”在章中至少出现两次`)
  const anchorSecond = makeAnchor(chengjia, second, second + phrase.length)
  assert(anchorSecond.prefix && !anchorSecond.prefix.includes(phrase), '第二处的前缀上下文已记录')
  const r = resolveAnchor(chengjia, anchorSecond)
  assert(r.start === second, `上下文消歧到第二处（${r.start} === ${second}, status=${r.status}）`)
  const rFirst = resolveAnchor(chengjia, makeAnchor(chengjia, first, first + phrase.length))
  assert(rFirst.start === first, `第一处也能独立定位（${rFirst.start} === ${first}）`)
}

console.log('3) 版本异文：脂本改写后重锚')
{
  // c3-07 程甲本作“围拥着一个人从后房门进来”，脂本作“围拥着一个丽人……”
  const quote = '一群媳妇丫鬟围拥着一个人从后房门进来'
  const idx = flat.text.indexOf(quote)
  assert(idx > 0, '程甲本原文包含该句')
  const anchor = makeAnchor(chengjia, idx, idx + quote.length)
  const r = resolveAnchor(zhi, anchor)
  // 脂本仅把“人”改作“丽人”（3/19 字差异），属于合理的模糊重锚
  assert(['fuzzy', 'exact'].includes(r.status), `局部改写以模糊命中保留批注 -> ${r.status}`)
  if (r.status === 'fuzzy') {
    assert(r.matchedQuote.includes('丽人'), `定位到改写后的句子：“${r.matchedQuote}”`)
  }
  // 真正整句删除的笔记应悬挂
  const gone = resolveAnchor(zhi, { ...anchor, quote: anchor.quote + '——这段在脂本中被整段删去没有对应' })
  assert(gone.status === 'orphan', `整句删除则悬挂 -> ${gone.status}`)
  // 放宽匹配
  const rr = resolveAnchor(zhi, anchor, { relaxed: true })
  assert(['fuzzy', 'exact'].includes(rr.status), `放宽后找到近似句 -> ${rr.status}`)

  // 小异文（轻易->轻意）应能模糊命中
  const q2 = '不肯轻易多说一句话，多行一步路'
  const i2 = flat.text.indexOf(q2)
  const a2 = makeAnchor(chengjia, i2, i2 + q2.length)
  const r2 = resolveAnchor(zhi, a2)
  assert(['fuzzy', 'exact'].includes(r2.status), `一字异文模糊定位 -> ${r2.status}`)
  assert(r2.matchedQuote && r2.matchedQuote.includes('轻意'), `匹配到脂本异文：“${r2.matchedQuote}”`)
}

console.log('4) 未变句子换版后仍命中（位置允许因前文异文移动）')
{
  const quote = '摘下那玉，就狠命摔去'
  const i = flat.text.indexOf(quote)
  const anchor = makeAnchor(chengjia, i, i + quote.length)
  const r = resolveAnchor(zhi, anchor)
  const zhiText = buildFlatText(zhi).text
  assert(r.status === 'exact', `未改句子精确命中（${r.status}）`)
  assert(zhiText.slice(r.start, r.end) === quote, '命中内容与引文一致')
  // 位置可因前文异文而平移，但靠引文+上下文仍能找到
}

console.log('5) 悬挂笔记保留段落后备')
{
  const r = resolveAnchor(chengjia, { quote: '完全不存在于原文中的一句话XYZ', paraHint: 'c3-05' })
  assert(r.status === 'orphan' && r.paraId === 'c3-05', '悬挂时 paraHint 保留')
}

console.log('6) normalize 容忍空白与标点')
{
  assert(normalize('“你好，世界。”') === normalize('"你好,世界."'), '引号逗号句号归一')
  assert(normalize('落花 流水\n春去') === normalize('落花流水春去'), '空白归一')
}

console.log('7) 长文性能（全文重锚所有种子引文）')
{
  const { SEED_NOTES } = await import('../src/reader/texts.js')
  const t0 = Date.now()
  let ok = 0
  for (const s of SEED_NOTES) {
    const { chapter } = findChapter(s.chapterId)
    const paras = getParagraphs(chapter, 'chengjia')
    const r = resolveAnchor(paras, { quote: s.quote })
    if (r.status !== 'orphan') ok++
  }
  const ms = Date.now() - t0
  assert(ok === SEED_NOTES.length, `${ok}/${SEED_NOTES.length} 条种子笔记全部重锚成功（${ms}ms）`)
  assert(ms < 1500, `耗时合理 <1500ms（实际 ${ms}ms）`)
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
