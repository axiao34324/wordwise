// WordWise 转发服务
//
// 存在意义：把上游 API Key 留在服务端，客户端永远不接触它。
// 客户端只持有一个 app 令牌，只能调用这里白名单内的模型。
//
// 单端口 HTTP 服务，无第三方依赖（避免部署时装包失败）。
// 必须监听 process.env.PORT 且绑定 0.0.0.0，这是托管沙箱的要求。

const http = require('node:http')
const https = require('node:https')
const auth = require('./auth')

const PORT = process.env.PORT || 3000

// 上游：小米 MiMo，OpenAI 兼容
const UPSTREAM_HOST = 'api.xiaomimimo.com'
const UPSTREAM_PATH = '/v1/chat/completions'

// 上游密钥：只从环境变量读。
// 部署平台上把它配成 MIMO_API_KEY，不要把真实 Key 写进仓库。
const UPSTREAM_KEY = process.env.MIMO_API_KEY || ''

if (!UPSTREAM_KEY) {
  console.error('[wordwise-gateway] 缺少环境变量 MIMO_API_KEY，模型请求会全部失败')
}

// 客户端令牌：与 app 内保持一致即可，作用是挡住随手的爬虫，不是安全边界
const APP_TOKEN = process.env.WORDWISE_APP_TOKEN || 'ww-app-2f8a4c71'

// 只放行这两个模型。刻意不含 pro-ultraspeed：比 flash 贵 30 倍，
// 换来的只是输出更快，而划词瓶颈在首字延迟。
const ALL_MODELS = ['mimo-v2.6-flash', 'mimo-v2.6-pro']
const DEFAULT_MODEL = 'mimo-v2.6-flash'

// 单实例限流：每 IP 每分钟 120 次
const RATE_LIMIT = 120
const hits = new Map()

function rateLimited(ip) {
  const now = Date.now()
  const rec = hits.get(ip) || { start: now, n: 0 }
  if (now - rec.start > 60000) {
    rec.start = now
    rec.n = 0
  }
  rec.n++
  hits.set(ip, rec)
  if (hits.size > 5000) hits.clear()
  return rec.n > RATE_LIMIT
}

// 按身份的每分钟窗口限流（用户维度比 IP 维度更准）
const minuteHits = new Map()
function perMinuteLimited(key, limit) {
  const now = Date.now()
  let rec = minuteHits.get(key)
  if (!rec || now - rec.start > 60000) {
    rec = { start: now, n: 0 }
    minuteHits.set(key, rec)
  }
  rec.n++
  if (minuteHits.size > 20000) minuteHits.clear()
  return rec.n > limit
}

// ---- 成本核算 ----
//
// 单价（元 / 百万 token），小米 MiMo 国内价：flash 1/2，pro 3/6。
// 只用来做预算熔断和运营报表，不参与计费，所以估算误差可以接受。
const PRICE = {
  'mimo-v2.6-flash': { in: 1, out: 2 },
  'mimo-v2.6-pro': { in: 3, out: 6 }
}

function costOf(model, inTok, outTok) {
  const p = PRICE[model] || PRICE[DEFAULT_MODEL]
  return (inTok * p.in + outTok * p.out) / 1e6
}

// 中文约 1.5 字/token、英文约 4 字符/token，统一按 1.8 估，宁高不低
function estimateInputTokens(messages) {
  let chars = 0
  for (const m of messages || []) chars += String((m && m.content) || '').length
  return Math.ceil(chars / 1.8) + 8
}

// 全局日预算：给账单兜底。超过后只掐匿名与免费，订阅用户照常。
const DAILY_BUDGET_YUAN = Number(process.env.WW_DAILY_BUDGET_YUAN || 30)
let budgetDay = ''
let budgetSpent = 0

function dailyBudget() {
  const day = new Date().toISOString().slice(0, 10)
  if (budgetDay !== day) {
    budgetDay = day
    budgetSpent = 0
  }
  return { exceeded: budgetSpent >= DAILY_BUDGET_YUAN, spent: budgetSpent, limit: DAILY_BUDGET_YUAN }
}

function chargeGlobal(yuan) {
  dailyBudget()
  budgetSpent += yuan
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function proxy(payload, req, res, attempt = 0, opts = {}) {
  const body = Buffer.from(payload)
  // 输出字数：用于把预估成本换成实际成本（只统计正文，不算 SSE 协议开销）
  let outChars = 0
  const countChars = (chunk) => {
    const s = chunk.toString('utf8')
    const re = /"content":"((?:[^"\\]|\\.)*)"/g
    let m
    while ((m = re.exec(s))) {
      outChars += m[1].replace(/\\[nrt"]/g, ' ').length
    }
  }
  const settle = () => {
    if (typeof opts.onSettled === 'function') {
      try { opts.onSettled(outChars) } catch (_) {}
      opts.onSettled = null
    }
  }
  const upstream = https.request(
    {
      host: UPSTREAM_HOST,
      path: UPSTREAM_PATH,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTREAM_KEY,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Accept: 'text/event-stream'
      },
      timeout: 60000
    },
    (up) => {
      if (up.statusCode < 200 || up.statusCode >= 300) {
        let e = ''
        up.on('data', (d) => (e += d))
        up.on('end', () => {
          console.error('[proxy] upstream', up.statusCode, e.slice(0, 200))
          // 上游报错时没有正文产出，把预估的输出成本退回去，只留输入成本
          settle()
          sendJson(res, up.statusCode, {
            error: { message: e.slice(0, 300) || 'upstream error', code: 'upstream_' + up.statusCode }
          })
        })
        return
      }

      // 先缓冲到第一段正文出现，再开始向客户端吐数据。
      // 上游偶发返回一条没有任何 content 的空流，若此时已经 writeHead，
      // 客户端只能读到一个 200 + 空正文，重试也无从判断。
      let started = false
      let pending = []

      const begin = () => {
        started = true
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*'
        })
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        for (const c of pending) res.write(c)
        pending = []
      }

      up.on('data', (chunk) => {
        countChars(chunk)
        if (started) {
          res.write(chunk)
          return
        }
        pending.push(chunk)
        if (/"content"\s*:\s*"[^"]/.test(chunk.toString('utf8'))) begin()
      })

      up.on('end', () => {
        settle()
        if (started) {
          if (typeof res.flush === 'function') {
            try {
              res.flush()
            } catch (_) {}
          }
          return res.end()
        }
        if (attempt < 1) {
          console.warn('[proxy] 上游返回空流，重试一次')
          return proxy(payload, req, res, attempt + 1, opts)
        }
        console.error('[proxy] 上游连续返回空流')
        sendJson(res, 502, {
          error: { message: '上游返回为空，请稍后重试', code: 'upstream_empty' }
        })
      })

      up.on('error', () => {
        settle()
        if (started) res.end()
      })
    }
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    settle()
    if (!res.headersSent) sendJson(res, 504, { error: { message: '上游超时', code: 'upstream_timeout' } })
    else res.end()
  })
  upstream.on('error', (e) => {
    console.error('[proxy] error', e.message)
    settle()
    if (!res.headersSent)
      sendJson(res, 502, { error: { message: '上游连接失败：' + e.message, code: 'upstream_unreachable' } })
    else res.end()
  })

  // 只在客户端真正断开时才取消上游。
  // 不能用 req.on('close')：请求体读完后它就会触发（Node 16+ 语义），
  // 会把刚建立的上游连接直接掐断，表现为"200 但内容为空"。
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })

  upstream.write(body)
  upstream.end()
}

function authOk(req) {
  // 兼容两种写法：Authorization: Bearer <token> 或 x-wordwise-key
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (bearer && bearer === APP_TOKEN) return true
  return req.headers['x-wordwise-key'] === APP_TOKEN
}

// 未登录用户的每日额度，按 IP 计（额度值统一在 auth.js 的 ANON 里定义）
const anonUsage = new Map()

function anonToday(ip) {
  const day = new Date().toISOString().slice(0, 10)
  const rec = anonUsage.get(ip)
  if (!rec || rec.day !== day) {
    const fresh = { day, n: 0 }
    anonUsage.set(ip, fresh)
    if (anonUsage.size > 20000) anonUsage.clear()
    return fresh
  }
  return rec
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
    .split(',')[0]
    .trim()
}

// 读取并解析 JSON 请求体，出错时直接回响应并返回 null
async function body(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (_) {
    sendJson(res, 413, { error: { message: '请求体过大', code: 'request_too_large' } })
    return null
  }
  try {
    return JSON.parse(raw || '{}')
  } catch (_) {
    sendJson(res, 400, { error: { message: '请求体不是合法 JSON', code: 'request_invalid' } })
    return null
  }
}

function tokenOf(req) {
  return String(req.headers['x-ww-token'] || '')
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,authorization,x-wordwise-key,x-ww-token',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    })
    return res.end()
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'wordwise-gateway',
      models: ALL_MODELS,
      defaultModel: DEFAULT_MODEL
    })
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: ALL_MODELS.map((id) => ({ id, object: 'model' }))
    })
  }

  // ---- 账号 ----
  if (req.method === 'POST' && req.url === '/auth/register') {
    const b = await body(req, res)
    if (!b) return
    const r = auth.register(b.email, b.password)
    if (r.error) return sendJson(res, 400, { error: { message: r.error, code: 'auth_failed' } })
    return sendJson(res, 200, r)
  }

  if (req.method === 'POST' && req.url === '/auth/login') {
    const b = await body(req, res)
    if (!b) return
    const r = auth.login(b.email, b.password)
    if (r.error) return sendJson(res, 401, { error: { message: r.error, code: 'auth_failed' } })
    return sendJson(res, 200, r)
  }

  if (req.method === 'GET' && req.url === '/auth/me') {
    const user = auth.byToken(tokenOf(req))
    if (!user) return sendJson(res, 401, { error: { message: '未登录或登录已过期', code: 'auth_required' } })
    return sendJson(res, 200, { user: auth.publicView(user) })
  }

  if (req.method === 'POST' && req.url === '/billing/redeem') {
    const user = auth.byToken(tokenOf(req))
    if (!user) return sendJson(res, 401, { error: { message: '请先登录', code: 'auth_required' } })
    const b = await body(req, res)
    if (!b) return
    const r = auth.redeem(user, b.code)
    if (r.error) return sendJson(res, 400, { error: { message: r.error, code: 'redeem_failed' } })
    return sendJson(res, 200, r)
  }

  // 运营总览（只给作者看：不算邮箱，只看总量与 Top 用户）
  if (req.method === 'GET' && req.url === '/admin/stats') {
    if (!authOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_client' } })
    const b = dailyBudget()
    return sendJson(res, 200, {
      ...auth.stats(),
      codes: auth.codeStats(),
      budget: {
        spentToday: Math.round(b.spent * 1e6) / 1e6,
        limit: b.limit,
        exceeded: b.exceeded
      }
    })
  }

  // 签发订阅码：卖出一单后按订单生成，一天一码，一次性
  // curl -X POST .../admin/codes?sharecode=xxx -H "x-wordwise-key: <APP_TOKEN>" \
  //      -d '{"days":30,"count":1}'
  if (req.method === 'POST' && req.url === '/admin/codes') {
    if (!authOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_client' } })
    const b = await body(req, res)
    if (!b) return
    const made = auth.mintCodes(b.days, b.count)
    console.log('[admin] 签发订阅码 ' + made.length + ' 个，' + made[0].days + ' 天')
    return sendJson(res, 200, { codes: made, stats: auth.codeStats() })
  }

  if (req.method === 'GET' && req.url === '/admin/codes') {
    if (!authOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_client' } })
    return sendJson(res, 200, { stats: auth.codeStats() })
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    return sendJson(res, 404, { error: { message: 'not found', code: 'not_found' } })
  }

  if (!authOk(req)) {
    return sendJson(res, 401, { error: { message: '无效的客户端令牌', code: 'auth_invalid_client' } })
  }

  const ip = clientIp(req)
  if (rateLimited(ip)) {
    return sendJson(res, 429, {
      error: { message: '请求过于频繁，请稍后再试', code: 'quota_rate_ip' }
    })
  }

  const parsed = await body(req, res)
  if (!parsed) return

  // ---- 身份 ----
  const user = auth.byToken(tokenOf(req))
  const ent = auth.entitlements(user)
  const isPro = !!user && ent.plan === 'pro'

  // ---- 每人每分钟次数 ----
  // IP 限流挡不住"同一台机器多开"，所以再按身份限一层。
  // 这是防止脚本把上游打到限流的关键，额度够用时人根本碰不到。
  const who = user ? 'u:' + user.id : 'ip:' + ip
  const perMin = user ? ent.perMinute : auth.ANON.perMinute
  if (perMinuteLimited(who, perMin)) {
    return sendJson(res, 429, {
      error: { message: '划得太快了，歇一秒再来', code: 'quota_rate_minute', limit: perMin }
    })
  }

  // ---- 日 / 月额度 ----
  let quota
  if (user) {
    quota = auth.checkQuota(user)
  } else {
    const a = anonToday(ip)
    quota = a.n >= auth.ANON.daily
      ? {
          ok: false,
          code: 'quota_daily',
          message: '试用额度已用完，登录后每天 ' + auth.PLANS.free.daily + ' 次',
          used: a.n,
          limit: auth.ANON.daily
        }
      : { ok: true }
  }
  if (!quota.ok) {
    console.log('[quota] ' + (user ? user.email : 'anon') + ' 触发 ' + quota.code + ' ' + quota.used + '/' + quota.limit)
    return sendJson(res, 429, {
      error: { message: quota.message, code: quota.code, used: quota.used, limit: quota.limit }
    })
  }

  // ---- 全局日预算熔断 ----
  // 这一层不是给用户看的，是给自己的账单兜底的：
  // 万一被刷或被大量免费用户同时使用，超预算就先掐掉匿名与免费，订阅用户照常。
  const budget = dailyBudget()
  if (budget.exceeded && !isPro) {
    return sendJson(res, 429, {
      error: {
        message: '今日服务已满负荷，明天再来（订阅用户不受影响）',
        code: 'quota_global',
        budget: budget.limit
      }
    })
  }

  // ---- 模型权限 ----
  if (!ent.models.includes(parsed.model)) {
    if (user) {
      return sendJson(res, 403, {
        error: { message: '该模型需要订阅', code: 'plan_required', models: ent.models }
      })
    }
    parsed.model = DEFAULT_MODEL
  }

  // MiMo 推理模型默认先输出 reasoning_content，会吃光 max_tokens 导致正文为空
  parsed.thinking = { type: 'disabled' }
  // 划词靠 SSE 渲染，强制流式
  parsed.stream = true
  if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens > 2000) {
    parsed.max_tokens = 2000
  }

  // ---- 计数与成本 ----
  // 计数放在真正转发之前：失败请求也会消耗上游，不该让重试白嫖额度。
  // 成本先按输入 + 一个保守的输出估值记账，流结束后按实际字数补差。
  const inTok = estimateInputTokens(parsed.messages)
  const outGuess = 220
  const cost0 = costOf(parsed.model, inTok, outGuess)
  if (user) auth.bumpUsage(user, { yuan: cost0, tokens: inTok + outGuess })
  else anon.n++
  chargeGlobal(cost0)

  // 把最新额度塞进响应头，客户端不用再多查一次接口
  if (user) {
    const u = auth.usageOf(user)
    res.setHeader('x-ww-used-day', String(u.dayN))
    res.setHeader('x-ww-limit-day', String(ent.dailyLimit))
    res.setHeader('x-ww-used-month', String(u.monthN))
    res.setHeader('x-ww-limit-month', String(ent.monthlyLimit))
  }

  const after = user ? auth.usageOf(user) : { dayN: anon.n, monthN: 0 }
  console.log(
    '[proxy] ' + parsed.model +
      ' | ' + (user ? user.email + '(' + ent.plan + ')' : 'anon') +
      ' | 今日 ' + after.dayN + '/' + ent.dailyLimit +
      (user ? ' 本月 ' + after.monthN + '/' + ent.monthlyLimit : '') +
      ' | ≈¥' + cost0.toFixed(5)
  )

  proxy(JSON.stringify(parsed), req, res, 0, {
    // 流结束后按真实输出字数结算，把估值换成实际值
    onSettled: (outChars) => {
      if (!user) return
      const realOut = Math.ceil(outChars / 1.6)
      const diff = costOf(parsed.model, 0, realOut) - costOf(parsed.model, 0, outGuess)
      if (diff) {
        auth.addCost(user, { yuan: diff, tokens: realOut - outGuess })
        chargeGlobal(diff)
      }
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('[wordwise-gateway] listening on ' + PORT + '，允许模型：' + ALL_MODELS.join(', '))
})
