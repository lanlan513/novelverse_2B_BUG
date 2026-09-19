// 笔记数据层：本地乐观更新 + 服务器持久化 + 离线队列 + 回收站
import { buildFlatText, resolveAnchor } from './anchor.js'
import { BOOKS, SEED_NOTES, getParagraphs } from './texts.js'

const API = '/api'
const USER_ID = 'user-demo'
const LS_QUEUE = 'close-reader:op-queue:v1'
const LS_NOTES = 'close-reader:notes-cache:v1'
const LS_PREFS = 'close-reader:prefs:v1'
const CONTEXT_CHARS = 18

export const NOTE_TYPES = [
  { id: 'character', label: '人物', color: '#c0504d' },
  { id: 'narrative', label: '叙事', color: '#7a5fa3' },
  { id: 'language', label: '语言', color: '#2f7d6e' },
  { id: 'symbol', label: '象征', color: '#c08a2e' },
  { id: 'plot', label: '情节', color: '#3f6ea8' },
]
export const TYPE_MAP = Object.fromEntries(NOTE_TYPES.map(t => [t.id, t]))

export function newId() {
  if (window.crypto?.randomUUID) return `note-${crypto.randomUUID()}`
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'x-user-id': USER_ID, ...(options.headers || {}) },
    })
  } catch {
    const error = new Error('网络不可用，改动已暂存在本机')
    error.error = 'NETWORK'
    throw error
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.message || `请求失败（${response.status}）`)
    Object.assign(error, payload, { status: response.status })
    throw error
  }
  return payload
}

function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback } catch { return fallback }
}

function anchorAt(paragraphs, start, end, quote) {
  const f = buildFlatText(paragraphs)
  return {
    quote: quote || f.text.slice(start, end),
    prefix: f.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: f.text.slice(end, Math.min(f.text.length, end + CONTEXT_CHARS)),
    paraHint: f.ranges.find(r => start >= r.start && start < r.end + 1)?.paraId || null,
  }
}

/**
 * 为每条笔记计算其在当前版本中的位置。
 * 返回 Map<noteId, {status,start,end,paraId,matchedQuote}>
 */
export function computePlacements(notes, paragraphs, { relaxed = false } = {}) {
  const placements = new Map()
  for (const note of notes) {
    if (note.deleted) continue
    placements.set(note.id, resolveAnchor(paragraphs, note.anchor, { relaxed }))
  }
  return placements
}

class NotesStore {
  constructor() {
    this.notes = loadJSON(LS_NOTES, null) || []
    this.queue = loadJSON(LS_QUEUE, [])
    this.status = 'idle' // idle | saving | saved | offline | failed
    this.connected = typeof navigator !== 'undefined' ? navigator.onLine !== false : true
    this.lastError = ''
    this.seeding = false
    this.listeners = new Set()
    this._snapshot = null
    this._retrying = false
  }

  subscribe = fn => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  getSnapshot = () => this._snapshot || (this._snapshot = this._build())

  _build() {
    return { notes: this.notes, status: this.status, connected: this.connected, lastError: this.lastError, seeding: this.seeding, queueDepth: this.queue.length }
  }

  emit() {
    this._snapshot = this._build()
    for (const fn of this.listeners) fn(this._snapshot)
  }

  persistCache() {
    try { localStorage.setItem(LS_NOTES, JSON.stringify(this.notes)) } catch { /* 配额满时只保留内存状态 */ }
  }

  persistQueue() {
    try { localStorage.setItem(LS_QUEUE, JSON.stringify(this.queue)) } catch { /* ignore */ }
  }

  async init() {
    window.addEventListener('online', () => { this.connected = true; this.retryQueue() })
    window.addEventListener('offline', () => { this.connected = false; this.status = 'offline'; this.emit() })
    try {
      const [{ meta }, { notes }] = await Promise.all([request('/meta'), request('/notes')])
      if (notes.length === 0 && !meta.notesSeeded) {
        await this.seed()
      } else {
        this.notes = notes
        this.persistCache()
        this.status = this.queue.length ? 'saving' : 'saved'
        this.emit()
      }
    } catch (error) {
      this.lastError = error.message
      this.status = this.connected ? 'failed' : 'offline'
      this.emit()
    }
    if (this.queue.length) this.retryQueue()
  }

  async seed() {
    this.seeding = true
    this.emit()
    const payload = []
    for (const book of BOOKS) {
      for (const chapter of book.chapters) {
        const paragraphs = getParagraphs(chapter, 'chengjia')
        for (const seedNote of SEED_NOTES.filter(s => s.chapterId === chapter.id)) {
          const placement = resolveAnchor(paragraphs, { quote: seedNote.quote })
          if (placement.status === 'orphan') continue
          payload.push({
            id: newId(),
            chapterId: seedNote.chapterId,
            type: seedNote.type,
            content: seedNote.content,
            anchor: anchorAt(paragraphs, placement.start, placement.end, seedNote.quote),
          })
        }
      }
    }
    const timestamp = new Date().toISOString()
    try {
      const { notes } = await request('/notes/bulk', { method: 'POST', body: JSON.stringify({ notes: payload }) })
      this.notes = notes
      this.persistCache()
      this.status = 'saved'
    } catch (error) {
      // 服务器不可用：种子笔记先在本地生效，并逐条入队，联网后补传
      this.notes = payload.map(n => ({ ...n, ownerId: USER_ID, quote: n.anchor.quote, createdAt: timestamp, updatedAt: timestamp, deleted: false }))
      this.queue = this.notes.map(note => ({ kind: 'create', note }))
      this.persistCache()
      this.persistQueue()
      this.status = this.connected ? 'failed' : 'offline'
      this.lastError = error.message
      this.scheduleRetry()
    } finally {
      this.seeding = false
      this.emit()
    }
  }

  markSaving() { this.status = 'saving'; this.emit() }

  async create({ chapterId, type, content, anchor }) {
    const timestamp = new Date().toISOString()
    const note = { id: newId(), ownerId: USER_ID, chapterId, type, content, anchor, quote: anchor.quote, createdAt: timestamp, updatedAt: timestamp, deleted: false }
    this.notes = [note, ...this.notes]
    this.persistCache()
    this.markSaving()
    try {
      const { note: saved } = await request('/notes', { method: 'POST', body: JSON.stringify(note) })
      this.notes = this.notes.map(n => (n.id === note.id ? saved : n))
      this.status = 'saved'
      this.persistCache(); this.emit()
    } catch (error) {
      this.enqueue({ kind: 'create', note })
      this.handleFailure(error)
    }
    return note
  }

  async update(id, patch) {
    if (!this.notes.some(n => n.id === id)) return
    this.notes = this.notes.map(n => (n.id === id ? { ...n, ...patch, updatedAt: new Date().toISOString() } : n))
    this.persistCache()
    this.markSaving()
    try {
      const { note } = await request(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      this.notes = this.notes.map(n => (n.id === id ? note : n))
      this.status = 'saved'
      this.persistCache(); this.emit()
    } catch (error) {
      this.enqueue({ kind: 'patch', id, patch })
      this.handleFailure(error)
    }
  }

  softDelete(id) { return this.update(id, { deleted: true }) }
  restore(id) { return this.update(id, { deleted: false }) }

  async hardDelete(id) {
    const target = this.notes.find(n => n.id === id)
    this.notes = this.notes.filter(n => n.id !== id)
    this.persistCache(); this.emit()
    try {
      await request(`/notes/${id}?permanent=1`, { method: 'DELETE' })
    } catch (error) {
      if (target) {
        this.notes = [target, ...this.notes]
        this.persistCache(); this.emit()
      }
      this.handleFailure(error)
      throw error
    }
  }

  enqueue(op) {
    if (op.kind === 'patch') {
      const createIdx = this.queue.findIndex(q => q.kind === 'create' && q.note.id === op.id)
      if (createIdx >= 0) {
        this.queue[createIdx].note = { ...this.queue[createIdx].note, ...op.patch }
        this.persistQueue()
        return
      }
      const patchIdx = this.queue.findIndex(q => q.kind === 'patch' && q.id === op.id)
      if (patchIdx >= 0) {
        this.queue[patchIdx].patch = { ...this.queue[patchIdx].patch, ...op.patch }
        this.persistQueue()
        return
      }
    }
    this.queue.push(op)
    this.persistQueue()
  }

  handleFailure(error) {
    this.lastError = error.message
    this.status = this.connected ? 'failed' : 'offline'
    this.emit()
    this.scheduleRetry()
  }

  scheduleRetry() {
    clearTimeout(this._retryTimer)
    if (!this.connected || this.queue.length === 0) return
    this._retryTimer = setTimeout(() => this.retryQueue(), 6000)
  }

  async retryQueue() {
    if (this._retrying || this.queue.length === 0) return
    this._retrying = true
    this.status = 'saving'
    this.emit()
    // 固定本轮要处理的操作：flush 期间新入队的改动不能被最后的整体替换抹掉
    const batch = this.queue
    let firstFailure = -1
    for (let i = 0; i < batch.length; i++) {
      const op = batch[i]
      try {
        if (op.kind === 'create') {
          await request('/notes', { method: 'POST', body: JSON.stringify(op.note) })
        } else {
          await request(`/notes/${op.id}`, { method: 'PATCH', body: JSON.stringify(op.patch) })
        }
      } catch (error) {
        if (error.status === 404 && op.kind === 'patch') continue // 服务器端已不存在，放弃
        firstFailure = i
        break
      }
    }
    // 保留“失败项及其后”的操作继续重试（失败项本身绝不能丢），
    // 同时保留 flush 期间新入队、尚未发送的操作
    const pending = firstFailure === -1 ? [] : batch.slice(firstFailure)
    const unsent = this.queue.slice(batch.length)
    this.queue = pending.concat(unsent)
    this.persistQueue()
    this._retrying = false
    this.status = this.queue.length ? (this.connected ? 'failed' : 'offline') : 'saved'
    this.lastError = this.queue.length ? '部分改动尚未保存，将自动重试' : ''
    this.emit()
    if (this.queue.length) this.scheduleRetry()
  }
}

export const prefs = {
  read() { return loadJSON(LS_PREFS, { edition: 'chengjia' }) },
  write(value) { try { localStorage.setItem(LS_PREFS, JSON.stringify(value)) } catch { /* ignore */ } },
}

export const store = new NotesStore()
