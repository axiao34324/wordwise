const { app } = require('electron')
const fs = require('fs')
const path = require('path')

// 首次添加时才创建文件；结构：{ name, createdAt, words: [{w, def, addedAt}] }
let data = null

function file() {
  return path.join(app.getPath('userData'), 'vocab.json')
}

function load() {
  if (data) return data
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    data = {
      name: raw.name || '我的词库',
      createdAt: raw.createdAt || Date.now(),
      words: Array.isArray(raw.words) ? raw.words : []
    }
  } catch {
    data = null // 未创建
  }
  return data
}

function exists() {
  return !!load()
}

function ensure() {
  if (!data) {
    data = { name: '我的词库', createdAt: Date.now(), words: [] }
    persist()
  }
  return data
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(data, null, 1))
  } catch (e) {
    console.error('vocab persist failed:', e)
  }
}

function key(w) {
  return String(w || '').trim().toLowerCase()
}

function has(w) {
  const d = load()
  if (!d) return false
  const k = key(w)
  return d.words.some((x) => key(x.w) === k)
}

// 返回 { added: bool, count }
function add(word, def) {
  const w = String(word || '').trim()
  if (!w) return { added: false, count: count() }
  const d = ensure()
  const k = key(w)
  const idx = d.words.findIndex((x) => key(x.w) === k)
  if (idx >= 0) {
    // 已存在：若原释义为空则补上
    if (!d.words[idx].def && def) {
      d.words[idx].def = String(def)
      persist()
    }
    return { added: false, count: d.words.length }
  }
  d.words.unshift({ w, def: String(def || ''), addedAt: Date.now() })
  persist()
  return { added: true, count: d.words.length }
}

function remove(w) {
  const d = load()
  if (!d) return 0
  const k = key(w)
  d.words = d.words.filter((x) => key(x.w) !== k)
  persist()
  return d.words.length
}

function clear() {
  if (data) {
    data.words = []
    persist()
  }
}

function count() {
  const d = load()
  return d ? d.words.length : 0
}

function list(filter) {
  const d = load()
  if (!d) return { name: '我的词库', createdAt: null, words: [] }
  const q = String(filter || '').trim().toLowerCase()
  const words = q
    ? d.words.filter((x) => key(x.w).includes(q) || String(x.def).toLowerCase().includes(q))
    : d.words
  return { name: d.name, createdAt: d.createdAt, words }
}

function toCSV() {
  const d = load()
  const rows = [['word', 'definition', 'added_at']]
  if (d) {
    for (const x of d.words) {
      rows.push([x.w, String(x.def || '').replace(/\s+/g, ' '), new Date(x.addedAt).toISOString()])
    }
  }
  return rows
    .map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(','))
    .join('\r\n')
}

module.exports = { load, exists, add, has, remove, clear, count, list, toCSV }
