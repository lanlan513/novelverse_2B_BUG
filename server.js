import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, 'data')
const dataFile = path.join(dataDir, 'store.json')
const PORT = process.env.PORT || 8787
const app = express()
app.use(express.json({ limit: '2mb' }))

const demoUser = { id: 'user-demo', name: '林舟', handle: 'linzhou', initials: 'LZ' }
const seed = {
  users: [demoUser],
  meta: { notesSeeded: false },
  notes: [],
  projects: [
    {
      id: 'proj-salt-wind', title: '盐与风的航线', description: '在潮汐尽头，寻找一座不存在的岛。', visibility: 'private',
      cover: { kind: 'image', value: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80', name: 'salt-wind.jpg' },
      ownerId: demoUser.id, createdAt: '2026-09-08T09:30:00.000Z', updatedAt: '2026-09-16T10:24:00.000Z',
      draft: { id: 'draft-salt-wind', content: '潮水退去以后，港口只剩下一种颜色。\n\n我把地图折成四份，塞进旧风衣的内袋。', version: 7, updatedAt: '2026-09-16T10:24:00.000Z' }, sharedStatus: 'private'
    },
    {
      id: 'proj-lanterns', title: '午夜图书馆', description: '每一本被遗忘的书，都在午夜后亮起一盏灯。', visibility: 'shared',
      cover: { kind: 'image', value: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=800&q=80', name: 'library.jpg' },
      ownerId: demoUser.id, createdAt: '2026-08-22T12:10:00.000Z', updatedAt: '2026-09-12T16:40:00.000Z',
      draft: { id: 'draft-lanterns', content: '图书馆在午夜十二点准时醒来。', version: 3, updatedAt: '2026-09-12T16:40:00.000Z' }, sharedStatus: 'shared'
    }
  ]
}

async function readStore() {
  try {
    const store = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    if (!Array.isArray(store.notes)) store.notes = []
    if (!store.meta) store.meta = { notesSeeded: false }
    return store
  } catch { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(dataFile, JSON.stringify(seed, null, 2)); return structuredClone(seed) }
}
let writeQueue = Promise.resolve()
async function writeStore(store) { writeQueue = writeQueue.then(async () => { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(dataFile, JSON.stringify(store, null, 2)) }); return writeQueue }
function requireUser(req, res) { const id = req.header('x-user-id') || req.query.userId; if (!id) { res.status(401).json({ error: 'UNAUTHENTICATED', message: '请先登录 Novelverse' }); return null } return id }
function now() { return new Date().toISOString() }

app.get('/api/me', (req, res) => res.json({ user: demoUser }))
app.get('/api/projects', async (req, res) => { const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); res.json({ projects: store.projects.filter(p => p.ownerId === userId) }) })
app.post('/api/projects', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const { title, description = '', visibility = 'private', cover = null } = req.body || {}
  const cleanTitle = String(title || '').trim(); if (!cleanTitle) return res.status(400).json({ error: 'TITLE_REQUIRED', message: '请填写项目标题' })
  const store = await readStore(); if (store.projects.some(p => p.ownerId === userId && p.title.toLowerCase() === cleanTitle.toLowerCase())) return res.status(409).json({ error: 'DUPLICATE_PROJECT', message: '已经有同名项目了' })
  const projectId = `proj-${crypto.randomUUID()}`; const draftId = `draft-${crypto.randomUUID()}`; const timestamp = now()
  const project = { id: projectId, title: cleanTitle, description: String(description).trim(), visibility: visibility === 'shared' ? 'shared' : 'private', cover, ownerId: userId, createdAt: timestamp, updatedAt: timestamp, draft: { id: draftId, content: '', version: 0, updatedAt: timestamp }, sharedStatus: visibility === 'shared' ? 'shared' : 'private' }
  store.projects.unshift(project); await writeStore(store); res.status(201).json({ project })
})
app.patch('/api/projects/:id', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); const project = store.projects.find(p => p.id === req.params.id && p.ownerId === userId); if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在' })
  const { title, description, visibility, cover } = req.body || {}; if (title !== undefined) project.title = String(title).trim(); if (description !== undefined) project.description = String(description).trim(); if (visibility !== undefined) project.visibility = visibility === 'shared' ? 'shared' : 'private'; if (cover !== undefined) project.cover = cover; project.updatedAt = now(); project.sharedStatus = project.visibility; await writeStore(store); res.json({ project })
})
app.get('/api/projects/:id/draft', async (req, res) => { const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); const project = store.projects.find(p => p.id === req.params.id && p.ownerId === userId); if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '草稿不存在' }); res.json({ draft: project.draft }) })
app.put('/api/projects/:id/draft', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); const project = store.projects.find(p => p.id === req.params.id && p.ownerId === userId); if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在' })
  const { content = '', baseVersion = 0 } = req.body || {}; if (Number(baseVersion) !== Number(project.draft.version)) return res.status(409).json({ error: 'DRAFT_CONFLICT', message: '这份草稿在另一台设备上有更新', serverDraft: project.draft })
  const draft = { ...project.draft, content: String(content), version: Number(project.draft.version) + 1, updatedAt: now() }; project.draft = draft; project.updatedAt = draft.updatedAt; await writeStore(store); res.json({ draft })
})
app.post('/api/projects/:id/share', async (req, res) => { const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); const project = store.projects.find(p => p.id === req.params.id && p.ownerId === userId); if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在' }); project.visibility = project.visibility === 'shared' ? 'private' : 'shared'; project.sharedStatus = project.visibility; project.updatedAt = now(); await writeStore(store); res.json({ project }) })

// ---------- 逐段精读笔记 ----------
const NOTE_TYPES = new Set(['character', 'narrative', 'language', 'symbol', 'plot'])
function cleanNoteBody(body = {}) {
  const type = NOTE_TYPES.has(body.type) ? body.type : null
  const content = String(body.content || '').trim()
  const chapterId = String(body.chapterId || '').trim()
  const quote = String(body.anchor?.quote ?? body.quote ?? '').slice(0, 600)
  const anchor = body.anchor && typeof body.anchor === 'object'
    ? { quote, prefix: String(body.anchor.prefix || '').slice(0, 120), suffix: String(body.anchor.suffix || '').slice(0, 120), paraHint: String(body.anchor.paraHint || '') || null }
    : { quote, prefix: '', suffix: '', paraHint: null }
  return { type, content, chapterId, anchor }
}
function withUserNotes(store, userId) {
  if (!Array.isArray(store.notes)) store.notes = []
  return store.notes.filter(n => n.ownerId === userId)
}

app.get('/api/meta', async (req, res) => { const userId = requireUser(req, res); if (!userId) return; const store = await readStore(); res.json({ meta: store.meta || { notesSeeded: false } }) })

app.get('/api/notes', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const store = await readStore()
  let notes = withUserNotes(store, userId)
  if (req.query.chapterId) notes = notes.filter(n => n.chapterId === req.query.chapterId)
  res.json({ notes, serverTime: now() })
})

app.post('/api/notes', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const body = cleanNoteBody(req.body)
  if (!body.type) return res.status(400).json({ error: 'TYPE_REQUIRED', message: '请选择笔记类型' })
  if (!body.content) return res.status(400).json({ error: 'CONTENT_REQUIRED', message: '笔记内容不能为空' })
  if (!body.chapterId) return res.status(400).json({ error: 'CHAPTER_REQUIRED', message: '缺少章节信息' })
  if (!body.anchor.quote) return res.status(400).json({ error: 'QUOTE_REQUIRED', message: '请先选中原文句子' })
  const store = await readStore()
  const timestamp = now()
  let note
  const clientId = typeof req.body.id === 'string' ? req.body.id : ''
  if (/^note-[a-zA-Z0-9_-]{8,64}$/.test(clientId)) {
    const existing = store.notes.find(n => n.id === clientId && n.ownerId === userId)
    if (existing) return res.json({ note: existing }) // 幂等：客户端重试
    note = { id: clientId, ownerId: userId, chapterId: body.chapterId, type: body.type, content: body.content, anchor: body.anchor, quote: body.anchor.quote, createdAt: timestamp, updatedAt: timestamp, deleted: false }
  } else {
    note = { id: `note-${crypto.randomUUID()}`, ownerId: userId, chapterId: body.chapterId, type: body.type, content: body.content, anchor: body.anchor, quote: body.anchor.quote, createdAt: timestamp, updatedAt: timestamp, deleted: false }
  }
  store.notes.push(note); await writeStore(store)
  res.status(201).json({ note })
})

// 批量导入（首次播种种子笔记用）
app.post('/api/notes/bulk', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const items = Array.isArray(req.body?.notes) ? req.body.notes : []
  if (items.length === 0 || items.length > 200) return res.status(400).json({ error: 'BAD_BATCH', message: '批量笔记数量不合法' })
  const store = await readStore()
  const created = []
  for (const raw of items) {
    const body = cleanNoteBody(raw)
    if (!body.type || !body.content || !body.chapterId || !body.anchor.quote) continue
    const timestamp = now()
    const note = { id: `note-${crypto.randomUUID()}`, ownerId: userId, chapterId: body.chapterId, type: body.type, content: body.content, anchor: body.anchor, quote: body.anchor.quote, createdAt: raw.createdAt || timestamp, updatedAt: raw.updatedAt || timestamp, deleted: false }
    store.notes.push(note); created.push(note)
  }
  if (!store.meta) store.meta = {}
  store.meta.notesSeeded = true
  await writeStore(store)
  res.status(201).json({ notes: created })
})

app.patch('/api/notes/:id', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const store = await readStore()
  const note = (store.notes || []).find(n => n.id === req.params.id && n.ownerId === userId)
  if (!note) return res.status(404).json({ error: 'NOT_FOUND', message: '笔记不存在或已被删除' })
  const { type, content, deleted, anchor } = req.body || {}
  if (type !== undefined) { if (!NOTE_TYPES.has(type)) return res.status(400).json({ error: 'BAD_TYPE', message: '未知的笔记类型' }); note.type = type }
  if (content !== undefined) { const text = String(content).trim(); if (!text) return res.status(400).json({ error: 'CONTENT_REQUIRED', message: '笔记内容不能为空' }); note.content = text }
  if (deleted !== undefined) note.deleted = Boolean(deleted)
  if (anchor && typeof anchor === 'object' && anchor.quote) {
    note.anchor = { quote: String(anchor.quote).slice(0, 600), prefix: String(anchor.prefix || '').slice(0, 120), suffix: String(anchor.suffix || '').slice(0, 120), paraHint: String(anchor.paraHint || '') || null }
    note.quote = note.anchor.quote
  }
  note.updatedAt = now()
  await writeStore(store)
  res.json({ note })
})

app.delete('/api/notes/:id', async (req, res) => {
  const userId = requireUser(req, res); if (!userId) return
  const store = await readStore()
  const idx = (store.notes || []).findIndex(n => n.id === req.params.id && n.ownerId === userId)
  if (idx === -1) return res.status(404).json({ error: 'NOT_FOUND', message: '笔记不存在' })
  const { permanent } = req.query
  if (permanent === '1') store.notes.splice(idx, 1)
  else { store.notes[idx].deleted = true; store.notes[idx].updatedAt = now() }
  await writeStore(store)
  res.json({ ok: true, permanent: permanent === '1' })
})

app.use(express.static(path.join(__dirname, 'dist')))
app.get(/.*/, (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, 'dist', 'index.html')))
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'SERVER_ERROR', message: '服务器暂时开小差了' }) })
app.listen(PORT, () => console.log(`Novelverse API running at http://localhost:${PORT}`))
