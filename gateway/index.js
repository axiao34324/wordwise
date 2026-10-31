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

// 上游密钥：优先读环境变量，未配置时回退到内置值
const UPSTREAM_KEY = process.env.MIMO_API_KEY || ''

if (!UPSTREAM_KEY) {
  console.error('[wordwise-gateway] 缺少环境变量 MIMO_API_KEY，模型请求会全部失败')
}

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

function proxy(payload, req, res, attempt = 0) {
  const body = Buffer.from(payload)
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
        if (started) {
          res.write(chunk)
          return
        }
        pending.push(chunk)
        if (/"content"\s*:\s*"[^"]/.test(chunk.toString('utf8'))) begin()
      })

      up.on('end', () => {
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
          return proxy(payload, req, res, attempt + 1)
        }
        console.error('[proxy] 上游连续返回空流')
        sendJson(res, 502, {
          error: { message: '上游返回为空，请稍后重试', code: 'upstream_empty' }
        })
      })

      up.on('error', () => {
        if (started) res.end()
      })
    }
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    if (!res.headersSent) sendJson(res, 504, { error: { message: '上游超时', code: 'upstream_timeout' } })
    else res.end()
  })
  upstream.on('error', (e) => {
    console.error('[proxy] error', e.message)
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

// 未登录用户的每日额度，按 IP 计
const ANON_DAILY = 20
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

  // 用户数统计（只给作者自己看，不放邮箱）
  if (req.method === 'GET' && req.url === '/admin/stats') {
    if (!authOk(req)) return sendJson(res, 401, { error: { message: '需要管理令牌', code: 'auth_invalid_client' } })
    return sendJson(res, 200, { users: auth.count(), codes: auth.codeStats() })
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
    return sendJson(res, 429, { error: { message: '请求过于频繁，请稍后再试', code: 'quota_rate_limited' } })
  }

  const parsed = await body(req, res)
  if (!parsed) return

  // ---- 身份与额度 ----
  const user = auth.byToken(tokenOf(req))
  const ent = auth.entitlements(user)
  const anon = user ? null : anonToday(ip)
  const used = user ? auth.usedToday(user) : anon.n
  const limit = user ? ent.dailyLimit : ANON_DAILY

  if (used >= limit) {
    return sendJson(res, 429, {
      error: {
        message: user ? '今日额度已用完，明天再试' : '试用额度已用完，登录后额度更高',
        code: 'quota_exhausted',
        used,
        limit
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

  // 计数放在真正转发之前，避免失败请求被反复重试而白嫖额度
  if (user) auth.bumpUsage(user)
  else anon.n++

  // MiMo 推理模型默认先输出 reasoning_content，会吃光 max_tokens 导致正文为空
  parsed.thinking = { type: 'disabled' }
  // 划词靠 SSE 渲染，强制流式
  parsed.stream = true
  if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens > 2000) {
    parsed.max_tokens = 2000
  }

  console.log(
    '[proxy] model =',
    parsed.model,
    '| user =',
    user ? user.email : 'anon',
    '| ' + used + '/' + limit
  )
  proxy(JSON.stringify(parsed), req, res)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('[wordwise-gateway] listening on ' + PORT + '，允许模型：' + ALL_MODELS.join(', '))
})
