// 回归验证：弱网批量补传时，队首（最早一条）改动不能丢
// 场景：3 条排队改动 → 第一次补传第 1 条请求失败、后 2 条不发送（break）
//       → 第二次补传全部成功 → 服务器最终必须收到全部 3 条改动
import assert from 'node:assert/strict'

// --- 浏览器桩 ---
const mem = new Map()
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.navigator = { onLine: true }

const { store } = await import('../src/reader/store.js')

// --- 模拟服务器：记录收到的 PATCH；第 1 次请求失败，之后成功 ---
const received = new Map() // id -> 最后一次 patch 内容
let callNo = 0
globalThis.fetch = async (url, options = {}) => {
  callNo++
  const path = String(url).replace('/api', '')
  if (callNo === 1) {
    return { ok: false, status: 502, json: async () => ({ message: '弱网网关错误' }) }
  }
  const m = path.match(/^\/notes\/([^?]+)/)
  if (m && options.method === 'PATCH') {
    const body = JSON.parse(options.body)
    received.set(m[1], body)
  }
  return { ok: true, status: 200, json: async () => ({ note: { id: m?.[1] } }) }
}

// 绕过定时器：直接按弱网时序制造队列并调用 retryQueue
store.queue = [
  { kind: 'patch', id: 'note-earliest', patch: { content: '最早的一条改动' } },
  { kind: 'patch', id: 'note-middle', patch: { content: '中间的改动' } },
  { kind: 'patch', id: 'note-latest', patch: { content: '最晚的改动' } },
]
store.persistQueue()
store.connected = true

// 第一轮：队首请求失败即中断
await store.retryQueue()
assert.equal(received.size, 0, '第一轮没有任何成功请求')
assert.equal(store.queue.length, 3, '失败项必须保留，队列仍是 3 条（旧代码会丢成 2 条）')
assert.ok(store.queue.some(op => op.id === 'note-earliest'), '最早的一条仍在队列里等待重试')
assert.equal(store.status, 'failed', '仍有未同步项，状态应为 failed，不能假装已保存')
console.log('✓ 首次补传失败后，3 条改动全部保留（含最早一条）')

// 第二轮：网络恢复，全部成功
await store.retryQueue()
assert.equal(received.size, 3, '服务器收到全部 3 条改动')
for (const id of ['note-earliest', 'note-middle', 'note-latest']) {
  assert.ok(received.has(id), `服务器收到 ${id}`)
}
assert.equal(store.queue.length, 0, '队列清空')
assert.equal(store.status, 'saved', '状态回到“所有改动已保存”')
console.log('✓ 网络恢复后最早一条也成功保存，3 条改动无一丢失')

console.log('\n弱网队列回归验证通过 ✓')

// 附加场景：flush 进行中（await 期间）用户又改了一条并新入队，不能被整体替换抹掉
{
  received.clear(); callNo = 0
  store.queue = [
    { kind: 'patch', id: 'note-a', patch: { content: 'A' } },
    { kind: 'patch', id: 'note-b', patch: { content: 'B' } },
  ]
  store.connected = true
  const pending = store.retryQueue()
  // 两条请求都在飞行中时，又有新改动入队
  store.enqueue({ kind: 'patch', id: 'note-c', patch: { content: 'C（补传期间新增）' } })
  await pending
  assert.ok(received.has('note-c') || store.queue.some(op => op.id === 'note-c'),
    '补传期间新入队的改动要么已发出，要么留在队列，不能凭空消失')
  if (store.queue.length) await store.retryQueue()
  assert.ok(received.has('note-c'), '最终服务器收到补传期间新增的改动')
  console.log('✓ 补传期间新入队的改动不会丢失')
}
