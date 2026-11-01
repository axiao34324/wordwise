// 待办：从阅读流里摘下来的"认知悬置点"
//
// 和词库的区别：词库是"先看懂，再收"，待办是"先收下，回头再看"。
// 所以待办不要求任何解释就允许落库 —— 划词 → 点一下 → 存好了，零输入。
//
// 存储：userData/todos.json，结构有意保持扁平，方便直接打开文件改。
//
// 数据形状：
//   lists: [{ id, name, createdAt }]        主题（默认只有"收件箱"）
//   items: [{ id, text, title, note, def, listId, source, state, hit, createdAt, ... }]
//
// state 只有三个值：open / done / archived
//   done     = 这件事我做完了（读过 / 查清楚了）
//   archived = 不感兴趣了、过时了，别再提
// 两者都不删除，随时能翻回来。

const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const INBOX = 'inbox'
const MAX_TEXT = 4000
const TITLE_MAX = 48

let data = null

function file() {
  return path.join(app.getPath('userData'), 'todos.json')
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function blank() {
  return { version: 1, lists: [{ id: INBOX, name: '收件箱', createdAt: Date.now() }], items: [] }
}

// 折叠空白：同一段文字从不同来源划出来，换行/空格往往不一致，
// 不折叠的话去重会失效
function norm(t) {
  return String(t || '').replace(/\s+/g, ' ').trim()
}

// 文本指纹：只用来判"是不是同一条"，不需要密码学强度
function fp(t) {
  const s = norm(t).slice(0, 400).toLowerCase()
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c * (i + 31), 0x85ebca6b) >>> 0
  }
  return h1.toString(36) + '-' + h2.toString(36)
}

// 没给标题时从原文里取：第一句/第一行，截到 48 字
function titleOf(text) {
  const t = norm(text)
  if (!t) return '未命名'
  const cut = t.slice(0, TITLE_MAX)
  return t.length > TITLE_MAX ? cut + '…' : cut
}

function normalize(raw) {
  const d = blank()
  if (!raw || typeof raw !== 'object') return d

  const lists = Array.isArray(raw.lists) ? raw.lists : []
  const seen = new Set()
  for (const l of lists) {
    if (!l || !l.id) continue
    const id = String(l.id)
    if (seen.has(id)) continue
    seen.add(id)
    d.lists.push({ id, name: String(l.name || '未命名主题').slice(0, 24), createdAt: l.createdAt || Date.now() })
  }
  // 收件箱必须存在，且排第一 —— 所有没归类的都落这里
  if (!d.lists.some((l) => l.id === INBOX)) {
    d.lists.unshift({ id: INBOX, name: '收件箱', createdAt: Date.now() })
  } else {
    d.lists = [d.lists.find((l) => l.id === INBOX), ...d.lists.filter((l) => l.id !== INBOX)]
  }

  const ids = new Set(d.lists.map((l) => l.id))
  const items = Array.isArray(raw.items) ? raw.items : []
  for (const i of items) {
    if (!i || !i.text) continue
    const text = String(i.text).slice(0, MAX_TEXT)
    d.items.push({
      id: String(i.id || uid()),
      text,
      title: String(i.title || '').trim().slice(0, 120) || titleOf(text),
      note: String(i.note || '').slice(0, 2000),
      def: String(i.def || '').slice(0, 4000),
      listId: ids.has(i.listId) ? i.listId : INBOX,
      source: {
        app: String((i.source && i.source.app) || '').slice(0, 80),
        title: String((i.source && i.source.title) || '').slice(0, 300)
      },
      state: i.state === 'done' || i.state === 'archived' ? i.state : 'open',
      hit: Math.max(1, Number(i.hit) || 1),
      createdAt: i.createdAt || Date.now(),
      updatedAt: i.updatedAt || i.createdAt || Date.now(),
      doneAt: i.doneAt || null
    })
  }
  return d
}

function load() {
  if (data) return data
  try {
    data = normalize(JSON.parse(fs.readFileSync(file(), 'utf8')))
  } catch {
    data = null // 还没有文件，第一次添加时才创建
  }
  return data
}

function ensure() {
  if (!data) {
    data = blank()
    persist()
  }
  return data
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(data, null, 1))
  } catch (e) {
    console.error('[todos] 写入失败', e && e.message)
  }
}

function all() {
  const d = load()
  return d ? d.items : []
}

function find(id) {
  return all().find((x) => x.id === id) || null
}

function listById(id) {
  const d = load()
  if (!d) return null
  return d.lists.find((l) => l.id === id) || null
}

// 添加。同一段文字（指纹相同）重复添加不堆条目，只 +1 命中次数。
// 返回 { added, dup, item, count }
function add(payload) {
  const p = payload || {}
  const text = String(p.text || '').trim().slice(0, MAX_TEXT)
  if (!text) return { added: false, dup: false, error: '内容为空', count: countOpen() }

  const d = ensure()
  const key = fp(text)
  // 已经归档的不参与去重：用户可能就是想重新捡起来
  const hit = d.items.find((x) => x.state !== 'archived' && fp(x.text) === key)
  if (hit) {
    hit.hit += 1
    hit.updatedAt = Date.now()
    if (!hit.def && p.def) hit.def = String(p.def).slice(0, 4000)
    if (!hit.note && p.note) hit.note = String(p.note).slice(0, 2000)
    if (!hit.source.title && p.source && p.source.title) hit.source.title = String(p.source.title).slice(0, 300)
    if (!hit.source.app && p.source && p.source.app) hit.source.app = String(p.source.app).slice(0, 80)
    persist()
    return { added: false, dup: true, item: hit, count: countOpen() }
  }

  const item = {
    id: uid(),
    text,
    title: String(p.title || '').trim().slice(0, 120) || titleOf(text),
    note: String(p.note || '').slice(0, 2000),
    def: String(p.def || '').slice(0, 4000),
    listId: listById(p.listId) ? p.listId : INBOX,
    source: {
      app: String((p.source && p.source.app) || '').slice(0, 80),
      title: String((p.source && p.source.title) || '').slice(0, 300)
    },
    state: 'open',
    hit: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    doneAt: null
  }
  d.items.unshift(item)
  persist()
  return { added: true, dup: false, item, count: countOpen() }
}

function update(id, patch) {
  const it = find(id)
  if (!it) return null
  const p = patch || {}
  if (typeof p.title === 'string') it.title = p.title.trim().slice(0, 120) || titleOf(it.text)
  if (typeof p.note === 'string') it.note = p.note.slice(0, 2000)
  if (typeof p.text === 'string' && p.text.trim()) it.text = p.text.trim().slice(0, MAX_TEXT)
  if (typeof p.listId === 'string' && listById(p.listId)) it.listId = p.listId
  if (p.state === 'open' || p.state === 'done' || p.state === 'archived') {
    it.state = p.state
    it.doneAt = p.state === 'done' ? Date.now() : null
  }
  if (p.source && typeof p.source === 'object') {
    if (typeof p.source.app === 'string') it.source.app = p.source.app.slice(0, 80)
    if (typeof p.source.title === 'string') it.source.title = p.source.title.slice(0, 300)
  }
  it.updatedAt = Date.now()
  persist()
  return it
}

function remove(id) {
  const d = load()
  if (!d) return 0
  const before = d.items.length
  d.items = d.items.filter((x) => x.id !== id)
  persist()
  return before - d.items.length
}

// 清掉已归档的。done 的保留 —— 那是"读过的证据"，用户可能想回顾
function purgeArchived() {
  const d = load()
  if (!d) return 0
  const before = d.items.length
  d.items = d.items.filter((x) => x.state !== 'archived')
  persist()
  return before - d.items.length
}

function clear() {
  if (!data) return
  data.items = []
  persist()
}

function addList(name) {
  const n = String(name || '').trim().slice(0, 24)
  if (!n) return null
  const d = ensure()
  if (d.lists.some((l) => l.name === n)) return d.lists.find((l) => l.name === n)
  const l = { id: 'l' + uid(), name: n, createdAt: Date.now() }
  d.lists.push(l)
  persist()
  return l
}

function renameList(id, name) {
  const l = listById(id)
  if (!l || id === INBOX) return null
  l.name = String(name || '').trim().slice(0, 24) || l.name
  persist()
  return l
}

// 删主题不删条目：里面的条子退回收件箱
function removeList(id) {
  const d = load()
  if (!d || id === INBOX) return null
  d.lists = d.lists.filter((l) => l.id !== id)
  for (const it of d.items) if (it.listId === id) it.listId = INBOX
  persist()
  return { lists: d.lists }
}

function stats() {
  const items = all()
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  return {
    open: items.filter((x) => x.state === 'open').length,
    done: items.filter((x) => x.state === 'done').length,
    archived: items.filter((x) => x.state === 'archived').length,
    total: items.length,
    today: items.filter((x) => x.createdAt >= dayStart.getTime()).length
  }
}

function countOpen() {
  return stats().open
}

// 给列表窗口用：一次返回主题表 + 过滤后的条目，省一次往返
function list(opts) {
  const o = opts || {}
  const filter = o.filter === 'done' || o.filter === 'archived' ? o.filter : o.filter === 'all' ? 'all' : 'open'
  const q = norm(o.q).toLowerCase()
  const d = load()
  const lists = d ? d.lists : blank().lists

  let items = all()
  if (filter !== 'all') items = items.filter((x) => x.state === filter)
  if (o.listId) items = items.filter((x) => x.listId === o.listId)
  if (q) {
    items = items.filter(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        x.text.toLowerCase().includes(q) ||
        x.note.toLowerCase().includes(q) ||
        x.source.title.toLowerCase().includes(q)
    )
  }
  // 未完成按"最近添加"排；已完成/归档按"最近处理"排
  items = items.slice().sort((a, b) =>
    filter === 'open' ? b.createdAt - a.createdAt : (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt)
  )

  return { lists, items, stats: stats(), filter }
}

function toMarkdown() {
  const d = load()
  const lists = d ? d.lists : blank().lists
  const items = all()
  const out = []
  out.push('# WordWise 待办')
  out.push('')
  out.push('导出时间：' + new Date().toLocaleString('zh-CN'))
  out.push('')

  for (const l of lists) {
    const mine = items.filter((x) => x.listId === l.id && x.state !== 'archived')
    if (!mine.length) continue
    out.push('## ' + l.name)
    out.push('')
    for (const it of mine.sort((a, b) => a.createdAt - b.createdAt)) {
      out.push('- [' + (it.state === 'done' ? 'x' : ' ') + '] ' + it.title)
      const body = norm(it.text)
      if (body && body !== it.title) {
        out.push('  > ' + (body.length > 300 ? body.slice(0, 300) + '…' : body))
      }
      if (it.note) out.push('  - 备注：' + norm(it.note))
      const src = [it.source.app, it.source.title].filter(Boolean).join(' · ')
      if (src) out.push('  - 来源：' + src)
      out.push('  - 添加于：' + new Date(it.createdAt).toLocaleDateString('zh-CN'))
    }
    out.push('')
  }

  const archived = items.filter((x) => x.state === 'archived')
  if (archived.length) {
    out.push('## 已归档（' + archived.length + '）')
    out.push('')
    for (const it of archived) out.push('- ' + it.title)
    out.push('')
  }
  return out.join('\n')
}

module.exports = {
  INBOX,
  load,
  add,
  update,
  remove,
  purgeArchived,
  clear,
  find,
  list,
  stats,
  countOpen,
  addList,
  renameList,
  removeList,
  toMarkdown
}
