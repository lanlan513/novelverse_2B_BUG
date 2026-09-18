// 用 jsdom 加载生产构建产物，验证应用可完整挂载、播种、筛选与打开笔记
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8799

// 每次烟测从干净的笔记状态开始（保留 projects）
{
  const raw = JSON.parse(await readFile(`${rootDir}/data/store.json`, 'utf8'))
  raw.notes = []
  raw.meta = { notesSeeded: false }
  await writeFile(`${rootDir}/data/store.json`, JSON.stringify(raw, null, 2))
}

const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOut = ''
serverProc.stdout.on('data', d => { serverOut += d })
serverProc.stderr.on('data', d => { serverOut += d })
await new Promise(r => setTimeout(r, 800))
process.on('exit', () => { try { serverProc.kill() } catch {} })

async function waitFor(fn, { timeout = 6000, interval = 80 } = {}) {
  const t0 = Date.now()
  for (;;) {
    try { if (fn()) return } catch {}
    if (Date.now() - t0 > timeout) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, interval))
  }
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: `http://localhost:${PORT}/`,
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  resources: 'usable',
})
const { window } = dom
global.window = window
global.document = window.document
global.navigator = window.navigator
global.Element = window.Element
global.HTMLElement = window.HTMLElement
global.Node = window.Node
global.MouseEvent = window.MouseEvent
global.getComputedStyle = window.getComputedStyle
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
window.scrollTo = () => {}
window.Element.prototype.scrollIntoView = () => {}
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }
}

let errors = []
window.addEventListener('error', e => errors.push(String(e.message)))
const origError = console.error
console.error = (...a) => {
  const parts = a.map(x => { try { return typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : JSON.stringify(x)) } catch { return String(x) } })
  const msg = parts.join(' ')
  if (/Warning|act\(/i.test(msg)) return
  errors.push(msg)
  origError('[app-error]', msg.slice(0, 500))
}

const html = await readFile(`${rootDir}/dist/index.html`, 'utf8')
const assetMatch = html.match(/src="([^"]+index-[^"]+\.js)"/)
assert.ok(assetMatch, '构建产物存在')
const js = await readFile(path.join(rootDir, 'dist', assetMatch[1]), 'utf8')

// jsdom 无内置 fetch；用 Node http 直连同进程启动的 Express
const doRequest = http.request.bind(http)
window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const u = new URL(url, `http://localhost:${PORT}`)
  const body = options.body ? String(options.body) : null
  const req = doRequest({
    hostname: 'localhost', port: PORT, path: u.pathname + u.search,
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  }, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => resolve({
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => JSON.parse(data || '{}'),
    }))
  })
  req.on('error', reject)
  if (body) req.write(body)
  req.end()
})

const script = window.document.createElement('script')
script.textContent = js
window.document.body.appendChild(script)

let pass = 0; let fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`) }
}

const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

await waitFor(() => window.document.querySelector('.reader-app'))

console.log('1) 应用挂载')
{
  check('渲染出 reader-app', () => assert.ok(window.document.querySelector('.reader-app')))
  const masthead = window.document.querySelector('.reader-masthead h1')
  check('默认打开第三回', () => assert.match(masthead?.textContent || '', /林黛玉抛父进京都/))
}

console.log('2) 首次播种 12 条示例笔记')
{
  await waitFor(() => window.document.querySelectorAll('.note-mark').length > 0)
  check('第三回正文出现批注标记', () => assert.ok(window.document.querySelectorAll('.note-mark').length >= 5))
  check('出现序号角标', () => assert.ok(window.document.querySelectorAll('.note-badge').length >= 5))
  const counts = [...window.document.querySelectorAll('.rail-chapter em')].map(e => e.textContent)
  check('目录显示各章笔记数 6 / 2 / 4', () => assert.deepEqual(counts, ['6', '2', '4']))
  check('保存状态为已保存', () => assert.match(window.document.querySelector('.save-status')?.textContent || '', /已保存/))
}

console.log('3) 面板筛选（类型 + 章节范围）')
{
  const typeButtons = () => [...window.document.querySelectorAll('.type-filter button')]
  click(typeButtons().find(b => b.textContent.includes('象征')))
  await sleep(150)
  let items = window.document.querySelectorAll('.panel-item')
  check('本章“象征”只剩 1 条', () => {
    assert.equal(items.length, 1, `实际 ${items.length}`)
    assert.match(items[0].querySelector('.type-chip')?.textContent || '', /象征/)
  })
  click([...window.document.querySelectorAll('.scope-switch button')].find(b => b.textContent.includes('全书')))
  await sleep(150)
  items = window.document.querySelectorAll('.panel-item')
  check('全书“象征”共 3 条', () => assert.equal(items.length, 3, `实际 ${items.length}`))
  click(typeButtons().find(b => b.textContent.includes('全部')))
  click([...window.document.querySelectorAll('.scope-switch button')].find(b => b.textContent.includes('本章')))
  await sleep(120)
  check('清除后恢复本章 6 条', () => assert.ok(window.document.querySelectorAll('.panel-item').length >= 6))
}

console.log('4) 关键词查找')
{
  const input = window.document.querySelector('.search-box input')
  input.value = '摔玉'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(150)
  const items = window.document.querySelectorAll('.panel-item')
  check('“摔玉”筛出含关键词的笔记', () => assert.ok(items.length >= 1))
  input.value = ''
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await sleep(100)
}

console.log('5) 打开笔记浮层')
{
  click(window.document.querySelector('i.note-badge'))
  await sleep(150)
  check('弹出笔记详情', () => assert.ok(window.document.querySelector('.note-popover')))
  check('浮层含引文与正文', () => {
    assert.ok((window.document.querySelector('.popover-quote')?.textContent || '').length > 5)
    assert.ok((window.document.querySelector('.popover-content')?.textContent || '').length > 5)
  })
}

console.log('6) 删除（进回收站）与恢复')
{
  // 关闭浮层，点“删除”
  click(window.document.querySelector('.note-popover .pop-action.danger'))
  await sleep(300)
  check('浮层关闭并出现撤销提示', () => {
    assert.ok(!window.document.querySelector('.note-popover'))
    assert.match(window.document.querySelector('.toast')?.textContent || '', /回收站/)
  })
  // 打开回收站
  const trashBtn = window.document.querySelector('.panel-head .secondary-btn')
  assert.ok(trashBtn, '回收站按钮存在')
  click(trashBtn)
  await sleep(300)
  if (process.env.DEBUG_SMOKE) {
    console.error('reader-app exists:', !!window.document.querySelector('.reader-app'))
    console.error('root child count:', window.document.getElementById('root').childElementCount)
    console.error('root text head:', window.document.getElementById('root').textContent.slice(0, 120))
    console.error('errors so far:', JSON.stringify(errors))
  }
  await waitFor(() => window.document.querySelectorAll('.trash-list li').length > 0, { timeout: 3000 })
  const trashItems = window.document.querySelectorAll('.trash-list li')
  check('回收站中有 1 条', () => assert.equal(trashItems.length, 1))
  // 恢复
  click(window.document.querySelector('.trash-list .secondary-btn'))
  await sleep(300)
  check('恢复后标记数不少于 5', () => assert.ok(window.document.querySelectorAll('.note-mark').length >= 5))
  click(window.document.querySelector('.modal-card .icon-x'))
  await sleep(100)
}

console.log('7) 版本切换（程甲本 → 脂评本）后的重锚')
{
  const zhiBtn = [...window.document.querySelectorAll('.edition-switch button')].find(b => b.textContent.includes('脂评'))
  assert.ok(zhiBtn, '存在脂评本切换按钮')
  click(zhiBtn)
  await sleep(200)
  check('出现版本变化提示横幅', () => assert.ok(window.document.querySelector('.drift-banner')))
  check('批注仍渲染在异文上（>=4 个标记）', () => assert.ok(window.document.querySelectorAll('.note-mark').length >= 4))
  const fuzzy = window.document.querySelectorAll('.note-mark.is-fuzzy').length
  const banner = window.document.querySelector('.drift-banner')?.textContent || ''
  check(`横幅提示模糊/未找到数量（fuzzy 标记 ${fuzzy} 个）`, () => {
    assert.ok(/近似匹配|未找到|全部吻合/.test(banner))
  })
  // 切回程甲本
  click([...window.document.querySelectorAll('.edition-switch button')].find(b => b.textContent.includes('程甲')))
  await sleep(200)
  check('切回后标记恢复', () => assert.ok(window.document.querySelectorAll('.note-mark').length >= 5))
}

console.log('8) 无运行时错误')
const appErrors = errors.slice()
check('window error 为空', () => {
  if (appErrors.length) throw new Error(appErrors.join(' | '))
})

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
