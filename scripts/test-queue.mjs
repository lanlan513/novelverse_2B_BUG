// 弱网/离线队列回归：retryQueue 遇到失败时必须保留失败项（及其后的所有操作），
// 绝不允许把失败的改动从队列里切掉却报告“已保存”。
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { store } from '../src/reader/store.js'

let pass = 0; let fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`) }
}

// ---- 极简浏览器环境桩 ----
const mem = new Map()
globalThis.window = globalThis
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
}
if (!globalThis.crypto?.randomUUID) globalThis.crypto = webcrypto
globalThis.navigator = { onLine: true }
globalThis.addEventListener = () => {} // store.init 不会在本测试中调用

function makeNote(id) {
  const anchor = { quote: `引文-${id}`, prefix: '', suffix: '', paraHint: 'p1' }
  return {
    id, ownerId: 'user-demo', chapterId: 'c3', type: 'plot',
    content: `内容-${id}`, anchor, quote: anchor.quote,
    createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', deleted: false,
  }
}

const noteA = makeNote('note-aaaa1111')
const noteB = makeNote('note-bbbb2222')
const noteC = makeNote('note-cccc3333')

// ---- fetch 桩：记录请求顺序，按路径/次数控制成败 ----
const calls = []
let routes = []
function route(method, id, result) { routes.push({ method, id, result }) }
globalThis.fetch = async (url, options = {}) => {
  const id = String(url).split('/').pop()
  const hit = routes.shift()
  calls.push({ method: options.method, id, result: hit?.result })
  const result = hit?.result ?? { status: 200, payload: { note: {} } }
  if (result.status === 'network') throw new TypeError('Failed to fetch')
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.payload ?? {},
  }
}

// 直接构造“弱网下三条更新入队”的状态（create/update 失败路径都会 enqueue）
store.queue = [
  { kind: 'patch', id: noteA.id, patch: { content: '改后的A' } },
  { kind: 'patch', id: noteB.id, patch: { content: '改后的B' } },
  { kind: 'patch', id: noteC.id, patch: { content: '改后的C' } },
]
store.connected = true

console.log('1) 最早的一条在重试时仍然失败')
{
  route('PATCH', noteA.id, { status: 'network' })
  await store.retryQueue()

  check('失败的 A 必须仍在队列中（队首）', () => {
    assert.equal(store.queue[0]?.id, noteA.id, `实际队首 ${store.queue[0]?.id}`)
  })
  check('B、C 也必须保留，不能被跳过丢弃', () => {
    const ids = store.queue.map(op => op.id)
    assert.deepEqual(ids, [noteA.id, noteB.id, noteC.id])
  })
  check('状态仍是保存失败，而不是误报“已保存”', () => {
    assert.notEqual(store.status, 'saved', `实际状态 ${store.status}`)
  })
}

console.log('2) 网络恢复后重试，三条全部补传成功')
{
  route('PATCH', noteA.id, { status: 200 })
  route('PATCH', noteB.id, { status: 200 })
  route('PATCH', noteC.id, { status: 200 })
  await store.retryQueue()

  check('队列清空', () => assert.equal(store.queue.length, 0))
  check('状态为已保存', () => assert.equal(store.status, 'saved'))
  check('补传顺序仍为 A → B → C（最早的改动没有丢）', () => {
    assert.deepEqual(calls.map(c => c.id), [noteA.id, noteA.id, noteB.id, noteC.id])
  })
}

console.log('3) 中间一条失败：成功的前缀移除，失败项及后续保留')
{
  store.queue = [
    { kind: 'patch', id: noteA.id, patch: { content: 'A2' } },
    { kind: 'patch', id: noteB.id, patch: { content: 'B2' } },
    { kind: 'patch', id: noteC.id, patch: { content: 'C2' } },
  ]
  route('PATCH', noteA.id, { status: 200 })
  route('PATCH', noteB.id, { status: 'network' })
  await store.retryQueue()

  check('保留 B、C，A 已补传移除', () => {
    assert.deepEqual(store.queue.map(op => op.id), [noteB.id, noteC.id])
  })
  check('状态不是已保存', () => assert.notEqual(store.status, 'saved'))
}

console.log('4) 404 的 patch 可安全放弃，但不能拖累后面的操作')
{
  store.queue = [
    { kind: 'patch', id: noteA.id, patch: { content: 'A3' } },
    { kind: 'patch', id: noteB.id, patch: { content: 'B3' } },
  ]
  route('PATCH', noteA.id, { status: 404, payload: { message: '笔记不存在' } })
  route('PATCH', noteB.id, { status: 200 })
  await store.retryQueue()

  check('A 放弃、B 成功后队列清空', () => assert.equal(store.queue.length, 0))
  check('状态为已保存', () => assert.equal(store.status, 'saved'))
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
