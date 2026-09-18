// 重锚引擎：笔记保存“引文 + 上下文”而非偏移量，
// 原文换版后按 精确匹配 → 多义消歧 → 模糊匹配 → 悬挂 的顺序重新定位。

const CONTEXT_CHARS = 18

export function normalize(text) {
  // 统一空白、常见繁简/异体标点差异，用于容错匹配
  return String(text || '')
    .replace(/[ \t\r\n 　]+/g, '')
    .replace(/[“”"「」]/g, '"')
    .replace(/[‘’']/g, "'")
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
}

// 构造章节纯文本（段落之间用 \n 分隔，保留换行信息用于还原）
export function buildFlatText(paragraphs) {
  let text = ''
  const ranges = []
  for (const para of paragraphs) {
    const start = text.length
    text += para.text
    const end = text.length
    ranges.push({ paraId: para.id, start, end, poem: Boolean(para.poem) })
    text += '\n'
  }
  return { text, ranges }
}

export function locateParagraph(ranges, offset) {
  // 二分查找偏移所在段落
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (offset < r.start) hi = mid - 1
    else if (offset >= r.end + 1) lo = mid + 1 // +1: 段落间换行
    else return mid
  }
  return -1
}

function levenshtein(a, b, cap = 6) {
  if (a === b) return 0
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > cap) return cap + 1
  let prev = Array.from({ length: lb + 1 }, (_, i) => i)
  for (let i = 1; i <= la; i++) {
    const cur = [i]
    let rowBest = i
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowBest) rowBest = cur[j]
    }
    if (rowBest > cap) return cap + 1
    prev = cur
  }
  return prev[lb]
}

// 在 normalized 全文中找出目标的所有出现位置（支持跨段落：先按去换行文本处理）
function findAll(haystack, needle) {
  const hits = []
  if (!needle) return hits
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    hits.push(idx)
    from = idx + Math.max(1, needle.length - 4)
  }
  return hits
}

// 归一化文本 -> 原文本偏移的映射（归一化只删字符，所以逐字符对应）
function mapNormOffset(flat, normOffset) {
  // flat.normMap[i] = 归一化文本第 i 个字符对应原文偏移
  return flat.normMap[normOffset] ?? flat.text.length
}

function buildNorm(flat) {
  const map = []
  let norm = ''
  for (let i = 0; i < flat.text.length; i++) {
    const ch = flat.text[i]
    const n = normalize(ch)
    // normalize 单个字符：标点类可能被替换为多字符，简单处理——只接受单字符
    if (n.length === 1) {
      norm += n
      map.push(i)
    } else if (n.length > 1) {
      for (const c of n) {
        norm += c
        map.push(i)
      }
    }
    // 删除的字符（空白）不进 map
  }
  return { norm, map }
}

// 评分上下文：候选位置前后各取 CONTEXT_CHARS，与保存的前后缀比较
function scoreContext(flat, norm, map, candNormStart, candNormEnd, prefix, suffix) {
  let score = 0
  if (prefix) {
    const ps = Math.max(0, candNormStart - prefix.length)
    const around = norm.slice(ps, candNormStart)
    const d = levenshtein(around, prefix, 8)
    score += Math.max(0, prefix.length - d)
  }
  if (suffix) {
    const pe = Math.min(norm.length, candNormEnd + suffix.length)
    const around = norm.slice(candNormEnd, pe)
    const d = levenshtein(around, suffix, 8)
    score += Math.max(0, suffix.length - d)
  }
  return score
}

// 将归一化偏移区间转换为原文 {start,end}
function normRangeToFlat(map, ns, ne) {
  return { start: map[ns] ?? -1, end: (map[ne - 1] ?? -1) + 1 }
}

/**
 * 为重锚一条笔记。
 * anchor: { quote, prefix, suffix, paraHint }
 * 返回 { status: 'exact'|'disambiguated'|'fuzzy'|'orphan', start, end, paraId, matchedQuote }
 */
export function resolveAnchor(paragraphs, anchor, { relaxed = false } = {}) {
  const flat = buildFlatText(paragraphs)
  const { norm, map } = buildNorm(flat)
  const target = normalize(anchor.quote)
  if (!target) return { status: 'orphan', start: -1, end: -1, paraId: anchor.paraHint || null }

  const occurrences = findAll(norm, target)

  if (occurrences.length === 1) {
    const ns = occurrences[0]
    const ne = ns + target.length
    const { start, end } = normRangeToFlat(map, ns, ne)
    const idx = locateParagraph(flat.ranges, start)
    return { status: 'exact', start, end, paraId: idx >= 0 ? flat.ranges[idx].paraId : anchor.paraHint || null, matchedQuote: flat.text.slice(start, end) }
  }

  if (occurrences.length > 1) {
    const prefix = normalize(anchor.prefix)
    const suffix = normalize(anchor.suffix)
    let best = occurrences[0]
    let bestScore = -1
    for (const ns of occurrences) {
      const ne = ns + target.length
      const score = scoreContext(flat, norm, map, ns, ne, prefix, suffix)
      if (score > bestScore) {
        bestScore = score
        best = ns
      }
    }
    const ne = best + target.length
    const { start, end } = normRangeToFlat(map, best, ne)
    const idx = locateParagraph(flat.ranges, start)
    return { status: 'disambiguated', start, end, paraId: idx >= 0 ? flat.ranges[idx].paraId : anchor.paraHint || null, matchedQuote: flat.text.slice(start, end) }
  }

  // 模糊匹配：在全文每个起点做带状（band=cap）编辑距离对齐，
  // 候选长度允许 expected±slack；整体 O(n·cap·slack)。
  const expected = target.length
  const slack = relaxed ? 8 : 3
  const cap = Math.max(relaxed ? 8 : 4, Math.ceil(expected * (relaxed ? 0.3 : 0.14)))
  const simFloor = relaxed ? 0.58 : 0.8
  let best = null
  // dp[i][j]：target 前 j 字 与 以 i 为起点的文本前 i? 字——为避免每次重算，
  // 逐起点直接计算长度 ~expected+slack 的窗口与 target 的距离（长度取窗口前缀使 j 单调对齐）。
  for (let i = 0; i + expected - cap <= norm.length; i++) {
    for (let len = expected - slack; len <= expected + slack; len++) {
      if (len < 4) continue
      const candEnd = i + len
      if (candEnd > norm.length) break
      // 带状距离：仅在 |i_offset - j| <= cap 范围内计算
      const rows = len + 1
      let prev = new Array(expected + 1).fill(Infinity)
      prev[0] = 0
      for (let j = 1; j <= Math.min(expected, cap); j++) prev[j] = j
      let feasible = true
      for (let r = 1; r <= len; r++) {
        const cur = new Array(expected + 1).fill(Infinity)
        if (r <= cap) cur[0] = r
        let rowHas = r <= cap
        for (let j = Math.max(1, r - cap); j <= Math.min(expected, r + cap); j++) {
          const cost = target[j - 1] === norm[i + r - 1] ? 0 : 1
          const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
          cur[j] = v
          if (v <= cap) rowHas = true
        }
        if (!rowHas) { feasible = false; break }
        prev = cur
      }
      if (!feasible) continue
      const d = prev[expected]
      if (d > cap) continue
      const similarity = 1 - d / Math.max(len, expected)
      if (similarity < simFloor) continue
      const candidate = { ns: i, ne: candEnd, d, similarity }
      if (!best || candidate.similarity > best.similarity) best = candidate
    }
    if (best && best.d === 0) break
  }
  if (best) {
    const { start, end } = normRangeToFlat(map, best.ns, best.ne)
    const idx = locateParagraph(flat.ranges, start)
    return { status: 'fuzzy', start, end, paraId: idx >= 0 ? flat.ranges[idx].paraId : anchor.paraHint || null, matchedQuote: flat.text.slice(start, end) }
  }

  return { status: 'orphan', start: -1, end: -1, paraId: anchor.paraHint || null }
}

/** 从当前选区（原文偏移区间）构造可持久化的锚点 */
export function makeAnchor(paragraphs, start, end, quote) {
  const flat = buildFlatText(paragraphs)
  const idx = locateParagraph(flat.ranges, start)
  const paraId = idx >= 0 ? flat.ranges[idx].paraId : null
  const prefix = flat.text.slice(Math.max(0, start - CONTEXT_CHARS), start)
  const suffix = flat.text.slice(end, Math.min(flat.text.length, end + CONTEXT_CHARS))
  return { quote: quote || flat.text.slice(start, end), prefix, suffix, paraHint: paraId }
}

/** 从浏览器 Selection 计算原文偏移；不支持或越界时返回 null */
export function selectionToOffsets(rootEl, flat) {
  if (typeof window.getSelection !== 'function' || !document.createRange) return null
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!rootEl.contains(range.startContainer) || !rootEl.contains(range.endContainer)) return null

  const startByPara = new Map()
  for (const r of flat.ranges) startByPara.set(r.paraId, r.start)

  const paraOf = node => {
    let el = node
    if (node.nodeType === Node.TEXT_NODE) el = node.parentElement
    return el && el.closest ? el.closest('[data-para-id]') : null
  }
  const offsetInFlat = (node, offset) => {
    const paraEl = paraOf(node)
    if (!paraEl || !rootEl.contains(paraEl)) return null
    const paraId = paraEl.getAttribute('data-para-id')
    if (!startByPara.has(paraId)) return null
    const probe = document.createRange()
    probe.selectNodeContents(paraEl)
    try {
      probe.setEnd(node, offset)
    } catch {
      return null
    }
    // 段落内全是行内内容，toString 与原文逐字符一致，不涉及块级换行问题
    return startByPara.get(paraId) + probe.toString().length
  }

  let start = offsetInFlat(range.startContainer, range.startOffset)
  let end = offsetInFlat(range.endContainer, range.endOffset)
  if (start === null || end === null) return null
  if (start > end) [start, end] = [end, start]
  if (!offsetsWithinFlat(flat, start, end)) return null
  return { start, end }
}

export function offsetsWithinFlat(flat, start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= flat.text.length && end > start
}
