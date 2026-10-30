const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const MAX_CONVERSATIONS = 60

let list = []

function file() {
  return path.join(app.getPath('userData'), 'conversations.json')
}

function load() {
  try {
    list = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (!Array.isArray(list)) list = []
  } catch {
    list = []
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(list, null, 1))
  } catch (e) {
    console.error('conversations persist failed:', e)
  }
}

function trim() {
  if (list.length > MAX_CONVERSATIONS) {
    list = list.slice(0, MAX_CONVERSATIONS)
  }
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function create(text) {
  const now = Date.now()
  const conv = {
    id: newId(),
    text: String(text || '').slice(0, 8000),
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  list.unshift(conv)
  trim()
  persist()
  return conv
}

function get(id) {
  return list.find((c) => c.id === id) || null
}

// 同一段划词文本复用已有会话（避免每次划同一段都新建）
function findByText(text) {
  const t = String(text || '')
  return list.find((c) => c.text === t) || null
}

function addMessage(id, role, content) {
  const c = get(id)
  if (!c) return null
  c.messages.push({ role, content: String(content || ''), at: Date.now() })
  c.updatedAt = Date.now()
  // 最近使用的排前面
  list = [c, ...list.filter((x) => x.id !== id)]
  persist()
  return c
}

function setLastAssistant(id, content) {
  const c = get(id)
  if (!c || !c.messages.length) return null
  const last = c.messages[c.messages.length - 1]
  if (last.role === 'assistant') last.content = String(content || '')
  else c.messages.push({ role: 'assistant', content: String(content || ''), at: Date.now() })
  c.updatedAt = Date.now()
  persist()
  return c
}

function remove(id) {
  list = list.filter((c) => c.id !== id)
  persist()
}

function summaries() {
  return list.map((c) => ({
    id: c.id,
    text: c.text.slice(0, 60),
    turns: c.messages.length,
    updatedAt: c.updatedAt
  }))
}

module.exports = { load, create, get, findByText, addMessage, setLastAssistant, remove, summaries }
