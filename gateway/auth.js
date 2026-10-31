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

const SECRET = process.env.WW_SECRET || 'PUT-YOUR-SECRET-HERE'
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

// ---- 用量与额度 ----
//
// 三个计数器各管一件事，缺一个都会出问题：
//   日额度   —— 防止一天之内刷爆（体验层面的"每天能用多少"）
//   月额度   —— 防止靠日额度攒出天量（成本层面的兜底）
//   每分钟   —— 防止脚本化高频调用把上游打到限流（稳定性）
//
// 都按月/日自然边界重置，重置逻辑放在 usageOf 里，谁读谁重置。

function today() {
  return new Date().toISOString().slice(0, 10)
}

function thisMonth() {
  return new Date().toISOString().slice(0, 7)
}

// 拿到（并在跨天/跨月时重置）用量记录
function usageOf(user) {
  const day = today()
  const month = thisMonth()
  const u = user.usage || {}
  // 兼容旧数据：老版本只有 { day, n }
  if (u.dayN == null && typeof u.n === 'number') u.dayN = u.n

  if (u.day !== day) {
    u.day = day
    u.dayN = 0
    u.costDay = 0
  }
  if (u.month !== month) {
    u.month = month
    u.monthN = 0
    u.costMonth = 0
  }
  if (u.dayN == null) u.dayN = 0
  if (u.monthN == null) u.monthN = 0
  if (u.costDay == null) u.costDay = 0
  if (u.costMonth == null) u.costMonth = 0
  user.usage = u
  return u
}

function usedToday(user) {
  return usageOf(user).dayN
}

function usedThisMonth(user) {
  return usageOf(user).monthN
}

// 记一次调用。tokens 只用于成本核算（估算值，不追求精确）
function bumpUsage(user, cost) {
  const u = usageOf(user)
  u.dayN++
  u.monthN++
  if (cost) {
    u.costDay += cost.yuan || 0
    u.costMonth += cost.yuan || 0
    u.tokensDay = (u.tokensDay || 0) + (cost.tokens || 0)
  }
  writeUsers()
}

// 只调整成本，不动计数：用于流结束后把预估成本换成实际成本
function addCost(user, cost) {
  if (!user || !cost) return
  const u = usageOf(user)
  u.costDay += cost.yuan || 0
  u.costMonth += cost.yuan || 0
  u.tokensDay = (u.tokensDay || 0) + (cost.tokens || 0)
  if (u.costDay < 0) u.costDay = 0
  if (u.costMonth < 0) u.costMonth = 0
  writeUsers()
}

// ---- 权益 ----

// 官方通道只有三档：免费版 + 两档订阅。
// 未登录用户不走官方通道（只能用自带的 Key），所以这里没有 "匿名" 这一档。
//
// 额度设计依据（改这里就能改额度与定价，客户端通过 /v1/plans 读取同名表）：
//   free     100/天、1500/月   —— 普通人一天读十几篇也用不到，日常不会被打断
//   standard 1200/天、15000/月 —— 标准订阅，含 pro 模型
//   pro      3000/天、40000/月 —— 重度使用，每分钟额度也更高
// 月额度是成本闸门：按 pro 单次约 ¥0.0011 估，standard 用满约 ¥16、pro 约 ¥44，
// 都在定价的 50%~60% 以内，留出毛利空间。
const PLANS = {
  free: {
    name: '免费版',
    daily: 100,
    monthly: 1500,
    perMinute: 15,
    models: ['mimo-v2.6-flash'],
    priceMonth: 0,
    priceYear: 0,
    tagline: '日常阅读够用'
  },
  standard: {
    name: '标准版',
    daily: 1200,
    monthly: 15000,
    perMinute: 30,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
    priceMonth: 29,
    priceYear: 299,
    tagline: '解锁 Pro 模型，长文与追问问得更细'
  },
  pro: {
    name: '专业版',
    daily: 3000,
    monthly: 40000,
    perMinute: 60,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
    priceMonth: 79,
    priceYear: 799,
    tagline: '给每天长时间阅读与写作的人'
  }
}

// 订阅过期的降级顺序：专业 → 标准 → 免费
function planOf(user) {
  if (!user) return 'free'
  const p = user.plan
  const alive = !user.expireAt || user.expireAt > Date.now()
  if (alive && (p === 'pro' || p === 'standard')) return p
  return 'free'
}

function entitlements(user) {
  const plan = planOf(user)
  const p = PLANS[plan]
  return {
    plan,
    planName: p.name,
    dailyLimit: p.daily,
    monthlyLimit: p.monthly,
    perMinute: p.perMinute,
    models: p.models
  }
}

// 额度检查：按顺序返回第一个撞上的限制
// 返回 { ok:true } 或 { ok:false, code, message }
function checkQuota(user) {
  const e = entitlements(user)
  const u = usageOf(user)
  if (u.dayN >= e.dailyLimit) {
    const isPro = e.plan === 'pro'
    return {
      ok: false,
      code: 'quota_daily',
      message: isPro ? '今日额度已用完，明日 0 点重置' : '今日免费额度已用完，升级订阅可继续使用',
      used: u.dayN,
      limit: e.dailyLimit
    }
  }
  if (e.monthlyLimit > 0 && u.monthN >= e.monthlyLimit) {
    return {
      ok: false,
      code: 'quota_monthly',
      message: e.plan === 'pro' ? '本月额度已用完' : '本月免费额度已用完，升级订阅可继续使用',
      used: u.monthN,
      limit: e.monthlyLimit
    }
  }
  return { ok: true }
}

// ---- 对外操作 ----

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function publicView(user) {
  const e = entitlements(user)
  const u = usageOf(user)
  return {
    id: user.id,
    email: user.email || '',
    nickname: user.nickname || '',
    provider: user.provider || 'email',
    plan: e.plan,
    planName: e.planName,
    expireAt: user.expireAt || null,
    // 旧字段保留，客户端老版本仍能显示"今日 x/y"
    used: u.dayN,
    dailyLimit: e.dailyLimit,
    usedMonth: u.monthN,
    monthlyLimit: e.monthlyLimit,
    perMinute: e.perMinute,
    models: e.models,
    costMonth: round6(u.costMonth)
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
    usage: { day: today(), dayN: 0, month: thisMonth(), monthN: 0, costDay: 0, costMonth: 0 }
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

// 首次启动时种两张：一张标准版、一张专业版，各只能用一次。
// 这两张是给你自己验收和送给朋友试用的，不要长期留在线上。
const SEED_CODES = {
  'WW-STD-30D-TRIAL': { days: 30, plan: 'standard' },
  'WW-PRO-30D-TRIAL': { days: 30, plan: 'pro' }
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
    for (const [code, rec] of Object.entries(SEED_CODES)) {
      codeCache.codes[code] = { ...rec, used: false, createdAt: Date.now(), seed: true }
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

// 生成订阅码：WW-<档位>-<天数>D-XXXX-XXXX，去掉容易看错的 0/O/1/I
function mintCodes(days, count, plan = 'standard') {
  const d = Math.max(1, Math.min(3650, parseInt(days, 10) || 30))
  const n = Math.max(1, Math.min(200, parseInt(count, 10) || 1))
  const p = PLANS[plan] ? plan : 'standard'
  const tag = p === 'pro' ? 'PRO' : 'STD'
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const db = readCodes()
  const made = []
  for (let i = 0; i < n; i++) {
    let code
    do {
      const part = () =>
        Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
      code = 'WW-' + tag + '-' + d + 'D-' + part() + '-' + part()
    } while (db.codes[code])
    db.codes[code] = { days: d, plan: p, used: false, createdAt: Date.now() }
    made.push({ code, days: d, plan: p, planName: PLANS[p].name })
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

const RANK = { free: 0, standard: 1, pro: 2 }

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
  // 降级码不覆盖已有的更高档：拿着专业版的人兑一张标准版码，只会延长到期时间
  const target = rec.plan || 'pro'
  const cur = planOf(user)
  if (RANK[target] >= RANK[cur]) user.plan = target
  writeUsers()
  return { user: publicView(user), days: rec.days, plan: user.plan }
}

// ---- 邮箱验证码登录 ----
//
// 不做密码：输入邮箱 → 收 6 位码 → 验证通过即登录，没账号就顺手建一个。
// 密码那套留着给老账号（/auth/login），新用户不必再记密码。
//
// 限制：同邮箱 60 秒一次、每天 10 次；验证码 10 分钟有效、最多试 5 次。

const MAIL_FILE = path.join(DATA_DIR, 'mail-codes.json')
const CODE_TTL_MS = 10 * 60 * 1000
const CODE_MAX_TRIES = 5

let mailCache = null

function readMail() {
  if (mailCache) return mailCache
  ensureDir()
  try {
    mailCache = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'))
    if (!mailCache.codes) mailCache.codes = {}
  } catch (_) {
    mailCache = { codes: {} }
  }
  return mailCache
}

function writeMail() {
  ensureDir()
  try {
    fs.writeFileSync(MAIL_FILE, JSON.stringify(mailCache, null, 2))
  } catch (e) {
    console.error('[auth] 验证码写入失败', e.message)
  }
}

function isValidEmail(mail) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)
}

function issueEmailCode(email) {
  const mail = normalizeEmail(email)
  if (!isValidEmail(mail)) return { error: '邮箱格式不对' }

  const db = readMail()
  const now = Date.now()
  const rec = db.codes[mail]

  if (rec && now - rec.sentAt < 60 * 1000) {
    return { error: '刚发过一次，' + Math.ceil((60 - (now - rec.sentAt) / 1000)) + ' 秒后再试' }
  }
  if (rec && rec.day === today() && rec.count >= 10) {
    return { error: '今天发送次数已用完，明天再试' }
  }

  const code = String(crypto.randomInt(100000, 1000000))
  db.codes[mail] = {
    code,
    exp: now + CODE_TTL_MS,
    sentAt: now,
    tries: 0,
    day: today(),
    count: rec && rec.day === today() ? rec.count + 1 : 1
  }
  writeMail()
  return { ok: true, code, ttlMin: CODE_TTL_MS / 60000 }
}

// 校验通过则登录 / 自动注册
function verifyEmailCode(email, code) {
  const mail = normalizeEmail(email)
  const db = readMail()
  const rec = db.codes[mail]
  if (!rec) return { error: '请先获取验证码' }
  if (Date.now() > rec.exp) return { error: '验证码已过期，请重新获取' }
  if (rec.tries >= CODE_MAX_TRIES) return { error: '错误次数太多，请重新获取验证码' }
  if (String(code || '').trim() !== rec.code) {
    rec.tries++
    writeMail()
    return { error: '验证码不对' }
  }

  delete db.codes[mail]
  writeMail()

  const users = readUsers()
  let user = users.users[mail]
  let created = false
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email: mail,
      verified: true,
      plan: 'free',
      expireAt: null,
      createdAt: Date.now(),
      usage: { day: today(), dayN: 0, month: thisMonth(), monthN: 0, costDay: 0, costMonth: 0 }
    }
    users.users[mail] = user
    writeUsers()
    created = true
  }
  return {
    token: signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }),
    user: publicView(user),
    created
  }
}

// ---- 第三方登录（微信 / QQ） ----
//
// 以 "provider:openid" 作为主键存在 users 里。这类账号没有邮箱，
// 也就拿不到验证码找回路径，所以 uid 必须稳定在 openid 上。
function loginOauth(provider, openId, profile = {}) {
  if (!provider || !openId) return { error: '第三方登录信息不完整' }
  const db = readUsers()
  const key = provider + ':' + openId
  let user = db.users[key]
  let created = false

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email: '',
      nickname: profile.nickname || provider + ' 用户',
      avatar: profile.avatar || '',
      provider,
      openId,
      verified: true,
      plan: 'free',
      expireAt: null,
      createdAt: Date.now(),
      usage: { day: today(), dayN: 0, month: thisMonth(), monthN: 0, costDay: 0, costMonth: 0 }
    }
    db.users[key] = user
    writeUsers()
    created = true
  } else if (profile.nickname && profile.nickname !== user.nickname) {
    user.nickname = profile.nickname
    writeUsers()
  }

  return {
    token: signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }),
    user: publicView(user),
    created
  }
}

// 金额小到 0.0005 这个量级，保留 6 位小数才看得见
function round6(n) {
  return Math.round((n || 0) * 1e6) / 1e6
}

function count() {
  return Object.keys(readUsers().users).length
}

// 运营视角的汇总：作者看一眼就知道今天的流量与花销
function stats() {
  const list = Object.values(readUsers().users)
  let requestsToday = 0
  let requestsMonth = 0
  let costMonth = 0
  const byPlan = { free: 0, standard: 0, pro: 0 }
  const top = []
  for (const u of list) {
    const x = usageOf(u)
    requestsToday += x.dayN
    requestsMonth += x.monthN
    costMonth += x.costMonth
    byPlan[planOf(u)]++
    if (x.monthN > 0) top.push({ email: u.email, monthN: x.monthN, costMonth: x.costMonth })
  }
  top.sort((a, b) => b.monthN - a.monthN)
  const round = round6
  return {
    users: list.length,
    byPlan,
    paid: byPlan.standard + byPlan.pro,
    requestsToday,
    requestsMonth,
    costMonth: round(costMonth),
    top: top.slice(0, 5).map((t) => ({ ...t, costMonth: round(t.costMonth) }))
  }
}

// 全量导出：发布前先 GET 一次存到本地，万一沙箱重建把 data 目录清掉，还有一份底稿
function exportAll() {
  const db = readUsers()
  return {
    exportedAt: Date.now(),
    users: Object.values(db.users),
    codes: codeStats()
  }
}

module.exports = {
  register,
  login,
  issueEmailCode,
  verifyEmailCode,
  loginOauth,
  byToken,
  byId,
  redeem,
  bumpUsage,
  addCost,
  usedToday,
  usedThisMonth,
  usageOf,
  entitlements,
  planOf,
  checkQuota,
  publicView,
  count,
  stats,
  mintCodes,
  codeStats,
  exportAll,
  PLANS
}
