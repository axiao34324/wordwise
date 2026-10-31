// 账号与订阅存储
//
// 零依赖：密码用 node:crypto 的 scrypt，会话用 HMAC 签名的自签 token，
// 数据存 JSON 文件。用户量在千级以内完全够用，且不需要额外服务。
//
// 注意：沙箱重新发布后文件可能被重置，所以提供 /admin/export 导出，
// 并在 data 目录里留一份，便于随时备份。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DATA_DIR = process.env.WW_DATA_DIR || path.join(process.cwd(), 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

const SECRET = process.env.WW_SECRET || 'ww-hmac-7c1e9b34a2d84f60'
const TOKEN_TTL = 30 * 24 * 3600 * 1000

// ---- 存储 ----

let cache = null

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

function readUsers() {
  if (cache) return cache
  ensureDir()
  try {
    cache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (!cache.users) cache.users = {}
  } catch (_) {
    cache = { users: {} }
  }
  return cache
}

function writeUsers() {
  ensureDir()
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(cache, null, 2))
  } catch (e) {
    console.error('[auth] 写入失败', e.message)
  }
}

// ---- 密码 ----

function hash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex')
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex')
}

// ---- 会话 token ----

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return body + '.' + sig
}

function verifyToken(token) {
  const t = String(token || '')
  const i = t.lastIndexOf('.')
  if (i <= 0) return null
  const body = t.slice(0, i)
  const sig = t.slice(i + 1)
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig.length !== expect.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch (_) {
    return null
  }
}

// ---- 每天用量 ----

function today() {
  return new Date().toISOString().slice(0, 10)
}

// 返回该用户今天的已用次数（顺带把跨天的计数归零）
function usedToday(user) {
  if (!user.usage || user.usage.day !== today()) {
    user.usage = { day: today(), n: 0 }
  }
  return user.usage.n
}

function bumpUsage(user) {
  usedToday(user)
  user.usage.n++
  writeUsers()
}

// ---- 权益 ----

const PLANS = {
  free: { dailyLimit: 80, models: ['mimo-v2.6-flash'] },
  pro: { dailyLimit: 2000, models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'] }
}

function planOf(user) {
  if (!user) return 'free'
  if (user.plan === 'pro' && (!user.expireAt || user.expireAt > Date.now())) return 'pro'
  return 'free'
}

function entitlements(user) {
  const plan = planOf(user)
  return { plan, ...PLANS[plan] }
}

// ---- 对外操作 ----

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function publicView(user) {
  const e = entitlements(user)
  return {
    id: user.id,
    email: user.email,
    plan: e.plan,
    expireAt: user.expireAt || null,
    dailyLimit: e.dailyLimit,
    models: e.models,
    used: usedToday(user)
  }
}

function register(email, password) {
  const mail = normalizeEmail(email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: '邮箱格式不对' }
  if (String(password || '').length < 6) return { error: '密码至少 6 位' }
  const db = readUsers()
  if (db.users[mail]) return { error: '这个邮箱已经注册过了' }

  const salt = makeSalt()
  const user = {
    id: crypto.randomUUID(),
    email: mail,
    salt,
    hash: hash(password, salt),
    plan: 'free',
    expireAt: null,
    createdAt: Date.now(),
    usage: { day: today(), n: 0 }
  }
  db.users[mail] = user
  writeUsers()
  return { token: signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }), user: publicView(user) }
}

function login(email, password) {
  const db = readUsers()
  const user = db.users[normalizeEmail(email)]
  if (!user) return { error: '邮箱或密码不对' }
  const got = hash(password, user.salt)
  if (got.length !== user.hash.length) return { error: '邮箱或密码不对' }
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(user.hash))) {
    return { error: '邮箱或密码不对' }
  }
  return { token: signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }), user: publicView(user) }
}

function byId(uid) {
  const db = readUsers()
  return Object.values(db.users).find((u) => u.id === uid) || null
}

function byToken(token) {
  const payload = verifyToken(token)
  if (!payload) return null
  return byId(payload.uid)
}

// 兑换订阅码
//
// 订阅码存在 codes.json 里，一次性。写死在代码里的码任何人都能猜到并反复使用，
// 所以只在首次启动时把三个试用码种进去，用掉一次就作废。
// 真实售卖时用 POST /admin/codes 按订单生成，一天一码。

const CODES_FILE = path.join(DATA_DIR, 'codes.json')

// 首次启动时种子：各一份，演示与自助试用够用
const SEED_CODES = {
  'WW-30D-TRIAL': 30,
  'WW-90D-TRIAL': 90,
  'WW-365D-TRIAL': 365
}

let codeCache = null

function readCodes() {
  if (codeCache) return codeCache
  ensureDir()
  try {
    codeCache = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'))
    if (!codeCache.codes) codeCache.codes = {}
  } catch (_) {
    codeCache = { codes: {} }
    for (const [code, days] of Object.entries(SEED_CODES)) {
      codeCache.codes[code] = { days, used: false, createdAt: Date.now(), seed: true }
    }
    writeCodes()
  }
  return codeCache
}

function writeCodes() {
  ensureDir()
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(codeCache, null, 2))
  } catch (e) {
    console.error('[auth] 订阅码写入失败', e.message)
  }
}

// 生成订阅码：WW-<天数>D-XXXX-XXXX，去掉容易看错的 0/O/1/I
function mintCodes(days, count) {
  const d = Math.max(1, Math.min(3650, parseInt(days, 10) || 30))
  const n = Math.max(1, Math.min(200, parseInt(count, 10) || 1))
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const db = readCodes()
  const made = []
  for (let i = 0; i < n; i++) {
    let code
    do {
      const part = () =>
        Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
      code = 'WW-' + d + 'D-' + part() + '-' + part()
    } while (db.codes[code])
    db.codes[code] = { days: d, used: false, createdAt: Date.now() }
    made.push({ code, days: d })
  }
  writeCodes()
  return made
}

function codeStats() {
  const db = readCodes()
  const all = Object.values(db.codes)
  return {
    total: all.length,
    unused: all.filter((c) => !c.used).length,
    used: all.filter((c) => c.used).length
  }
}

function redeem(user, code) {
  const key = String(code || '').trim().toUpperCase()
  const db = readCodes()
  const rec = db.codes[key]
  if (!rec) return { error: '订阅码无效' }
  if (rec.used) return { error: '这个订阅码已经被用过了' }

  rec.used = true
  rec.usedBy = user.email
  rec.usedAt = Date.now()
  writeCodes()

  // 续期而不是重置：多次兑换可以叠加
  const base = user.expireAt && user.expireAt > Date.now() ? user.expireAt : Date.now()
  user.expireAt = base + rec.days * 24 * 3600 * 1000
  user.plan = 'pro'
  writeUsers()
  return { user: publicView(user), days: rec.days }
}

function count() {
  return Object.keys(readUsers().users).length
}

module.exports = {
  register,
  login,
  byToken,
  byId,
  redeem,
  bumpUsage,
  usedToday,
  entitlements,
  planOf,
  publicView,
  count,
  mintCodes,
  codeStats,
  PLANS
}
