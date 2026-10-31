// WordWise 转发服务
//
// 存在意义：把上游 API Key 留在服务端，客户端永远不接触它。
// 客户端只持有一个 app 令牌，只能调用这里白名单内的模型。
//
// 单端口 HTTP 服务，无第三方依赖（避免部署时装包失败）。
// 必须监听 process.env.PORT 且绑定 0.0.0.0，这是托管沙箱的要求。

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const auth = require('./auth')
const mailer = require('./mailer')
const oauth = require('./oauth')

const PORT = process.env.PORT || 3000

// 对外地址与分享码：第三方登录回调、客户端拼接口地址都要用。
// 重新部署后若分享码变了，改这里的默认值（或配环境变量）。
const SERVICE_ORIGIN = process.env.WW_ORIGIN || 'https://wordwise-58299.app.workbuddy.host'
const SHARE_CODE = process.env.WW_SHARE_CODE || 'LKBPBCLVR5'

// 上游：小米 MiMo，OpenAI 兼容
const UPSTREAM_HOST = 'api.xiaomimimo.com'
const UPSTREAM_PATH = '/v1/chat/completions'

// 上游密钥：只从环境变量读，仓库里不放真实 key
const UPSTREAM_KEY = process.env.MIMO_API_KEY || ''

// 客户端令牌：与 app 内保持一致即可，作用是挡住随手的爬虫，不是安全边界
const APP_TOKEN = process.env.WORDWISE_APP_TOKEN || 'ww-app-2f8a4c71'

// 管理令牌：必须与 APP_TOKEN 分开。
// APP_TOKEN 打包在客户端里，任何人都能扒出来；如果管理接口也用它，
// 就等于把「签发订阅码」和「查看运营数据」的权限发给了每一个用户。
const ADMIN_TOKEN = process.env.WW_ADMIN_TOKEN || 'PUT-YOUR-ADMIN-TOKEN-HERE'

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

function sendHtml(res, code, html) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html)
  })
  res.end(html)
}

// 第三方登录的回调落地页：把 token 写进 window.__WW_AUTH__，
// Electron 窗口加载完后用 executeJavaScript 取走，再自己关窗。
function resultPage(ok, message, token) {
  const payload = ok
    ? 'window.__WW_AUTH__=' + JSON.stringify({ ok: true, token }) + ';'
    : 'window.__WW_AUTH__=' + JSON.stringify({ ok: false, error: message }) + ';'
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>WordWise 登录</title>' +
    '<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#1A1C22;' +
    'color:#E6E8EE;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}' +
    '.box{max-width:320px}h2{font-size:16px;font-weight:600}p{color:#8A8F9C;font-size:13px;line-height:1.7}</style>' +
    '</head><body><div class="box"><h2>' +
    (ok ? '登录成功' : '登录失败') +
    '</h2><p>' +
    (ok ? '可以关掉这个窗口，回到 WordWise 继续使用。' : message) +
    '</p></div><script>' + payload + '</script></body></html>'
  )
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

// 管理接口专用：只认 ADMIN_TOKEN，不认客户端令牌。
// 三个 header 名都试：托管沙箱的反向代理会吞掉 Authorization，
// 有时也会过滤不认识的 x- 头，而 x-wordwise-key 是确定透传的。
function adminOk(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  const given = [
    String(req.headers['x-ww-admin'] || '').trim(),
    String(req.headers['x-wordwise-key'] || '').trim(),
    bearer
  ].find((v) => v.length === ADMIN_TOKEN.length)

  if (!given) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_TOKEN))
}

// 未登录用户不走官方通道（官方只服务免费版与两档订阅），
// 所以这里不再维护匿名额度；未带 token 的请求直接 401。

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
      'Access-Control-Allow-Headers': 'content-type,authorization,x-wordwise-key,x-ww-token,x-ww-admin',
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

  // 套餐表：客户端照这个渲染订阅方案，改价改额度只动 auth.js
  if (req.method === 'GET' && req.url === '/v1/plans') {
    const plans = Object.entries(auth.PLANS).map(([id, p]) => ({
      id,
      name: p.name,
      tagline: p.tagline,
      daily: p.daily,
      monthly: p.monthly,
      perMinute: p.perMinute,
      models: p.models,
      priceMonth: p.priceMonth,
      priceYear: p.priceYear
    }))
    return sendJson(res, 200, { plans, models: ALL_MODELS, oauth: oauth.status(), mail: mailer.enabled() })
  }

  // ---- 账号 ----
  if (req.method === 'POST' && req.url === '/auth/register') {
    const b = await body(req, res)
    if (!b) return
    const r = auth.register(b.email, b.password)
    if (r.error) return sendJson(res, 400, { error: { message: r.error, code: 'auth_failed' } })
    return sendJson(res, 200, r)
  }

  // 发送邮箱验证码。没配邮件服务时是开发模式：验证码写日志并随响应返回。
  if (req.method === 'POST' && req.url === '/auth/email/code') {
    const b = await body(req, res)
    if (!b) return
    const r = auth.issueEmailCode(b.email)
    if (r.error) return sendJson(res, 400, { error: { message: r.error, code: 'code_failed' } })
    const sent = await mailer.send(String(b.email || '').trim().toLowerCase(), r.code)
    if (!sent.ok) return sendJson(res, 502, { error: { message: sent.error, code: 'mail_failed' } })
    const payload = { ok: true, ttlMin: r.ttlMin, dev: !!sent.dev }
    // 开发模式把码回传，方便没配邮箱时也能把流程走完；配了 key 就不会有这个字段
    if (sent.dev) payload.devCode = r.code
    return sendJson(res, 200, payload)
  }

  // 校验验证码：通过即登录，没账号就顺手建一个
  if (req.method === 'POST' && req.url === '/auth/email/verify') {
    const b = await body(req, res)
    if (!b) return
    const r = auth.verifyEmailCode(b.email, b.code)
    if (r.error) return sendJson(res, 401, { error: { message: r.error, code: 'code_invalid' } })
    console.log('[auth] 邮箱登录 ' + String(b.email || '').trim() + (r.created ? '（新注册）' : ''))
    return sendJson(res, 200, r)
  }

  // ---- 微信 / QQ ----
  if (req.method === 'GET' && req.url === '/auth/oauth/status') {
    return sendJson(res, 200, { providers: oauth.status() })
  }

  const oauthStart = req.url.match(/^\/auth\/oauth\/(wechat|qq)\/start$/)
  if (req.method === 'GET' && oauthStart) {
    const provider = oauthStart[1]
    const redirect = SERVICE_ORIGIN + '/auth/oauth/' + provider + '/callback?sharecode=' + SHARE_CODE
    const url = oauth.startUrl(provider, redirect)
    if (!url) {
      return sendJson(res, 501, {
        error: { message: '该登录方式还未配置（需要开放平台审核通过）', code: 'oauth_unconfigured' }
      })
    }
    res.writeHead(302, { Location: url })
    return res.end()
  }

  const oauthCb = req.url.match(/^\/auth\/oauth\/(wechat|qq)\/callback/)
  if (req.method === 'GET' && oauthCb) {
    const provider = oauthCb[1]
    const q = new URLSearchParams((req.url.split('?')[1] || ''))
    const code = q.get('code') || ''
    if (!code) return sendHtml(res, 400, resultPage(false, '授权被取消或没有拿到授权码'))
    const redirect = SERVICE_ORIGIN + '/auth/oauth/' + provider + '/callback?sharecode=' + SHARE_CODE
    const info = await oauth.exchange(provider, code, redirect)
    if (info.error) return sendHtml(res, 400, resultPage(false, info.error))
    const r = auth.loginOauth(provider, info.openId, info)
    if (r.error) return sendHtml(res, 400, resultPage(false, r.error))
    console.log('[auth] ' + provider + ' 登录 ' + (info.nickname || info.openId))
    return sendHtml(res, 200, resultPage(true, '', r.token))
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
    if (!adminOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_admin' } })
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

  // 导出账号，用于发布前备份（沙箱重建后 data 目录可能被重置）
  if (req.method === 'GET' && req.url === '/admin/export') {
    if (!adminOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_admin' } })
    return sendJson(res, 200, auth.exportAll())
  }

  // 签发订阅码：卖出一单后按订单生成，一次性
  // curl -X POST .../admin/codes -H "x-ww-admin: <ADMIN_TOKEN>" \
  //      -d '{"days":30,"count":1,"plan":"standard"}'
  if (req.method === 'POST' && req.url === '/admin/codes') {
    if (!adminOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_admin' } })
    const b = await body(req, res)
    if (!b) return
    const made = auth.mintCodes(b.days, b.count, b.plan)
    console.log('[admin] 签发 ' + made[0].planName + ' 订阅码 ' + made.length + ' 个，' + made[0].days + ' 天')
    return sendJson(res, 200, { codes: made, stats: auth.codeStats() })
  }

  if (req.method === 'GET' && req.url === '/admin/codes') {
    if (!adminOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_admin' } })
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
  // 官方通道只对登录用户开放。未登录请走「自带 Key」，那边客户端直连自己的服务，
  // 不经过这里，也就不占用我们的成本。
  const user = auth.byToken(tokenOf(req))
  if (!user) {
    return sendJson(res, 401, {
      error: {
        message: '官方通道需要登录。不想注册的话，可以在设置里选「自带 Key」用自己的服务',
        code: 'auth_required'
      }
    })
  }
  const ent = auth.entitlements(user)
  const isPaid = ent.plan === 'pro' || ent.plan === 'standard'

  // ---- 每人每分钟次数 ----
  // IP 限流挡不住"同一台机器多开"，所以再按身份限一层。
  // 这是防止脚本把上游打到限流的关键，额度够用时人根本碰不到。
  const who = 'u:' + user.id
  if (perMinuteLimited(who, ent.perMinute)) {
    return sendJson(res, 429, {
      error: { message: '划得太快了，歇一秒再来', code: 'quota_rate_minute', limit: ent.perMinute }
    })
  }

  // ---- 日 / 月额度 ----
  const quota = auth.checkQuota(user)
  if (!quota.ok) {
    console.log('[quota] ' + (user.email || user.id) + ' 触发 ' + quota.code + ' ' + quota.used + '/' + quota.limit)
    return sendJson(res, 429, {
      error: { message: quota.message, code: quota.code, used: quota.used, limit: quota.limit }
    })
  }

  // ---- 全局日预算熔断 ----
  // 这一层不是给用户看的，是给自己的账单兜底的：
  // 万一被刷或被大量免费用户同时使用，超预算就先掐掉免费版，付费用户照常。
  const budget = dailyBudget()
  if (budget.exceeded && !isPaid) {
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
    return sendJson(res, 403, {
      error: {
        message: '该模型需要更高档的订阅',
        code: 'plan_required',
        models: ent.models,
        plan: ent.plan
      }
    })
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
  auth.bumpUsage(user, { yuan: cost0, tokens: inTok + outGuess })
  chargeGlobal(cost0)

  // 把最新额度塞进响应头，客户端不用再多查一次接口
  const u = auth.usageOf(user)
  res.setHeader('x-ww-used-day', String(u.dayN))
  res.setHeader('x-ww-limit-day', String(ent.dailyLimit))
  res.setHeader('x-ww-used-month', String(u.monthN))
  res.setHeader('x-ww-limit-month', String(ent.monthlyLimit))
  res.setHeader('x-ww-plan', ent.plan)

  console.log(
    '[proxy] ' + parsed.model +
      ' | ' + (user.email || user.id) + '(' + ent.plan + ')' +
      ' | 今日 ' + u.dayN + '/' + ent.dailyLimit +
      ' 本月 ' + u.monthN + '/' + ent.monthlyLimit +
      ' | ≈¥' + cost0.toFixed(5)
  )

  proxy(JSON.stringify(parsed), req, res, 0, {
    // 流结束后按真实输出字数结算，把估值换成实际值
    onSettled: (outChars) => {
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
