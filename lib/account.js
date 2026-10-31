// 账号与订阅（客户端侧）
//
// 只做三件事：
//   1. 把登录后拿到的 token 存在 userData/account.json
//   2. 用 token 调转发服务的 /auth/* 与 /billing/*
//   3. 把服务端返回的权益摊平成界面能直接用的形状
//
// token 是服务端签发的 HMAC 串，本地不存密码、不存盐，丢了 token 最多等于
// 没登录（服务端 30 天过期），不构成密钥泄露。

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')
const official = require('./official')

let cached = null // { token, email, user }

function file() {
  return path.join(app.getPath('userData'), 'account.json')
}

function load() {
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}
  } catch (_) {
    cached = {}
  }
  if (typeof cached.token !== 'string') cached.token = ''
  return cached
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(cached || {}, null, 2))
  } catch (e) {
    console.error('[ww:account] 保存失败', String(e && e.message))
  }
}

function token() {
  return load().token || ''
}

// 套餐表兜底：服务端 /v1/plans 拿不到时（离线、服务重启中）用它渲染，
// 免得界面空着。数值与 ww-gateway/auth.js 的 PLANS 保持一致。
const FALLBACK_PLANS = [
  {
    id: 'free',
    name: '免费版',
    tagline: '日常阅读够用',
    daily: 100,
    monthly: 1500,
    perMinute: 15,
    models: ['mimo-v2.6-flash'],
    priceMonth: 0,
    priceYear: 0
  },
  {
    id: 'standard',
    name: '标准版',
    tagline: '解锁 Pro 模型，长文与追问问得更细',
    daily: 1200,
    monthly: 15000,
    perMinute: 30,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
    priceMonth: 29,
    priceYear: 299
  },
  {
    id: 'pro',
    name: '专业版',
    tagline: '给每天长时间阅读与写作的人',
    daily: 3000,
    monthly: 40000,
    perMinute: 60,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
    priceMonth: 79,
    priceYear: 799
  }
]

let plansCache = null

async function plans() {
  if (plansCache) return plansCache
  const r = await request('GET', '/v1/plans', { withToken: false })
  if (r.ok && r.data && Array.isArray(r.data.plans)) {
    plansCache = r.data
  } else {
    plansCache = {
      plans: FALLBACK_PLANS,
      oauth: { wechat: false, qq: false },
      mail: false,
      offline: true
    }
  }
  return plansCache
}

// 统一的 HTTP 调用。官方通道的地址挂在分享网关后面，query 里的 sharecode
// 是访问凭证，必须带；用 URL 对象拼接，避免 sharecode 被拼进 pathname。
function request(method, pathname, opts = {}) {
  const { body, withToken = true, timeoutSec = 12 } = opts
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(official.apiUrl(pathname))
    } catch (_) {
      return resolve({ ok: false, status: 0, error: '服务地址配置有误', code: 'bad_url' })
    }

    const payload = body ? JSON.stringify(body) : ''
    const headers = {}
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const t = withToken ? token() : ''
    if (t) headers['x-ww-token'] = t

    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }

    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          let j = null
          try { j = JSON.parse(raw) } catch (_) { j = null }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return finish({ ok: true, status: res.statusCode, data: j || {} })
          }
          const msg =
            (j && j.error && j.error.message) ||
            official.humanize(res.statusCode, raw)
          finish({
            ok: false,
            status: res.statusCode,
            error: msg,
            code: (j && j.error && j.error.code) || 'http_' + res.statusCode
          })
        })
      }
    )

    req.setTimeout(timeoutSec * 1000, () => {
      req.destroy()
      finish({ ok: false, status: 0, error: '连接服务超时，请检查网络', code: 'timeout' })
    })
    req.on('error', (e) => {
      finish({
        ok: false,
        status: 0,
        error: '连不上服务：' + String((e && e.message) || e),
        code: 'network'
      })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

// 服务端的 user 对象 → 界面直用
function shape(user) {
  if (!user) return null
  const expireAt = user.expireAt || null
  const daily = user.dailyLimit || 0
  const used = user.used || 0
  const monthly = user.monthlyLimit || 0
  const usedMonth = user.usedMonth || 0
  return {
    email: user.email || '',
    nickname: user.nickname || '',
    provider: user.provider || 'email',
    plan: user.plan || 'free',
    planName: user.planName || (user.plan === 'pro' ? '专业版' : user.plan === 'standard' ? '标准版' : '免费版'),
    planLabel: user.planName || (user.plan === 'pro' ? '专业版' : user.plan === 'standard' ? '标准版' : '免费版'),
    used,
    dailyLimit: daily,
    remaining: Math.max(0, daily - used),
    usedMonth,
    monthlyLimit: monthly,
    remainingMonth: monthly > 0 ? Math.max(0, monthly - usedMonth) : null,
    perMinute: user.perMinute || 0,
    models: Array.isArray(user.models) ? user.models : [],
    expireAt,
    daysLeft: expireAt ? Math.max(0, Math.ceil((expireAt - Date.now()) / 86400000)) : null
  }
}

function adopt(result) {
  // result: { token?, user }
  // 必须先 load()：cached 是懒加载的，进程启动后第一次就调用 register/login
  // 时它还是 null，直接写 cached.token 会抛 TypeError。
  load()
  if (result && result.token) cached.token = result.token
  if (result && result.user) {
    cached.user = result.user
    cached.email = result.user.email || cached.email || ''
    persist()
  }
  return shape(cached.user)
}

function clear() {
  cached = { token: '', email: '', user: null }
  persist()
}

// 本地快速可见的状态（不发请求）
function state() {
  const c = load()
  return {
    loggedIn: !!c.token,
    email: c.email || (c.user && c.user.email) || '',
    ...(shape(c.user) || {
      nickname: '',
      provider: 'email',
      plan: 'free',
      planName: '免费版',
      planLabel: '免费版',
      used: 0,
      dailyLimit: 0,
      remaining: 0,
      usedMonth: 0,
      monthlyLimit: 0,
      remainingMonth: null,
      perMinute: 0,
      models: [],
      expireAt: null,
      daysLeft: null
    })
  }
}

async function register(email, password) {
  const r = await request('POST', '/auth/register', {
    body: { email, password },
    withToken: false
  })
  if (!r.ok) return r
  adopt(r.data)
  return { ok: true, user: shape(load().user) }
}

async function login(email, password) {
  const r = await request('POST', '/auth/login', {
    body: { email, password },
    withToken: false
  })
  if (!r.ok) return r
  adopt(r.data)
  return { ok: true, user: shape(load().user) }
}

// 邮箱验证码：发码 → 校验通过即登录（没账号就自动注册）
async function sendCode(email) {
  return request('POST', '/auth/email/code', { body: { email }, withToken: false })
}

async function verifyCode(email, code) {
  const r = await request('POST', '/auth/email/verify', {
    body: { email, code },
    withToken: false
  })
  if (!r.ok) return r
  adopt(r.data)
  return { ok: true, user: shape(load().user), created: !!r.data.created }
}

// 第三方登录：直接返回要打开的授权地址，窗口由主进程开
function oauthStartUrl(provider) {
  return official.apiUrl('/auth/oauth/' + provider + '/start')
}

// 授权窗口回传 token 后调用
async function adoptToken(t) {
  load()
  cached.token = String(t || '')
  persist()
  const r = await refresh()
  return r.ok ? { ok: true, user: r.user } : r
}

async function refresh() {
  if (!token()) return { ok: false, error: '尚未登录', code: 'auth_required' }
  const r = await request('GET', '/auth/me')
  if (!r.ok) {
    // token 被服务端判定失效（过期/换签名）时清掉本地，避免一直撞 401
    if (r.status === 401) clear()
    return r
  }
  adopt(r.data)
  return { ok: true, user: shape(load().user) }
}

async function redeem(code) {
  if (!token()) return { ok: false, error: '请先登录', code: 'auth_required' }
  const r = await request('POST', '/billing/redeem', { body: { code } })
  if (!r.ok) return r
  adopt(r.data)
  return { ok: true, user: shape(load().user) }
}

function logout() {
  clear()
}

// 请求成功后本地先 +1，省一次往返。真实数字以服务端 /auth/me 为准，
// 账号页每次打开都会重新拉一次。
function bumpLocal() {
  const c = load()
  if (!c.token || !c.user) return
  c.user.used = (c.user.used || 0) + 1
  c.user.usedMonth = (c.user.usedMonth || 0) + 1
  persist()
}

module.exports = {
  token,
  state,
  plans,
  register,
  login,
  sendCode,
  verifyCode,
  oauthStartUrl,
  adoptToken,
  refresh,
  redeem,
  logout,
  bumpLocal
}
