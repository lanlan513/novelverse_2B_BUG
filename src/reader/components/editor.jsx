import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Quote, Save, Search, Trash2, X } from 'lucide-react'
import { NOTE_TYPES, TYPE_MAP } from '../store.js'
import { Modal } from './overlays.jsx'

export function NoteEditor({ initial, selectionQuote, onSave, onClose }) {
  const editing = Boolean(initial)
  const [type, setType] = useState(initial?.type || 'character')
  const [content, setContent] = useState(initial?.content || '')
  const [saving, setSaving] = useState(false)
  const textRef = useRef(null)

  useEffect(() => {
    const t = setTimeout(() => textRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-5]$/.test(e.key) && e.target !== textRef.current) {
        setType(NOTE_TYPES[Number(e.key) - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, content])

  const submit = async () => {
    if (!content.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ type, content: content.trim() })
    } finally {
      setSaving(false)
    }
  }

  const quote = initial?.anchor?.quote || selectionQuote || ''

  return (
    <Modal
      title={editing ? '修改精读笔记' : '写一条精读笔记'}
      onClose={onClose}
    >
      <div className="editor-quote">
        <span className="editor-quote-label"><Quote size={13} /> 原文</span>
        <blockquote>{quote}</blockquote>
      </div>
      <fieldset className="type-picker">
        <legend>笔记类型 <span className="key-hint">按 1–5 快速选择</span></legend>
        <div className="type-options">
          {NOTE_TYPES.map((t, i) => (
            <button
              type="button"
              key={t.id}
              className={type === t.id ? 'selected' : ''}
              style={{ '--type-color': t.color }}
              onClick={() => setType(t.id)}
            >
              <span className="type-dot" />{t.label}<kbd>{i + 1}</kbd>
            </button>
          ))}
        </div>
      </fieldset>
      <label className="content-label">你的精读
        <textarea
          ref={textRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder={`这条${TYPE_MAP[type].label}细节为什么重要？可以写人物动机、叙事手法、修辞、意象或情节伏笔……`}
          rows={6}
          maxLength={2000}
        />
      </label>
      <div className="editor-actions">
        <span className="char-count">{content.length}/2000</span>
        <div>
          <button type="button" className="text-btn" onClick={onClose}>取消</button>
          <button type="button" className="primary-btn" disabled={!content.trim() || saving} onClick={submit}>
            {saving ? <><Save size={14} />保存中…</> : <><Check size={15} />{editing ? '保存修改' : '添加笔记'}</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function TrashView({ notes, onRestore, onHardDelete, onEmpty, onClose }) {
  return (
    <Modal title={<><Trash2 size={17} /> 回收站</>} onClose={onClose} wide>
      <div className="trash-toolbar">
        <span>已删除 {notes.length} 条，恢复后会重新定位到原文</span>
        {notes.length > 0 && <button className="text-btn danger" onClick={onEmpty}>全部永久删除</button>}
      </div>
      {notes.length === 0 ? (
        <p className="trash-empty">回收站是空的。删除的笔记会先在这里保留 30 天。</p>
      ) : (
        <ul className="trash-list">
          {notes.map(note => (
            <li key={note.id}>
              <div>
                <span className="type-chip sm" style={{ '--type-color': TYPE_MAP[note.type]?.color }}>
                  <span className="type-dot" />{TYPE_MAP[note.type]?.label}
                </span>
                <blockquote>{note.anchor.quote}</blockquote>
                <p>{note.content}</p>
              </div>
              <div className="trash-ops">
                <button className="secondary-btn" onClick={() => onRestore(note.id)}>恢复</button>
                <button className="icon-btn" aria-label="永久删除" onClick={() => onHardDelete(note.id)}><Trash2 size={16} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

export function HighlightedText({ text, keyword }) {
  const tokens = useMemo(() => {
    if (!keyword.trim()) return null
    const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try { return new RegExp(`(${escaped})`, 'gi') } catch { return null }
  }, [keyword])
  if (!tokens) return text
  const parts = text.split(tokens)
  return parts.map((part, i) => (i % 2 === 1
    ? <mark key={i} className="kw-hit">{part}</mark>
    : <React.Fragment key={i}>{part}</React.Fragment>))
}

export function SearchInput({ value, onChange, ...rest }) {
  return (
    <div className="search-box">
      <Search size={15} />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="搜索引文或笔记内容…"
        aria-label="按关键词查找笔记"
        {...rest}
      />
      {value && <button className="icon-x" onClick={() => onChange('')} aria-label="清除关键词"><X size={13} /></button>}
    </div>
  )
}
