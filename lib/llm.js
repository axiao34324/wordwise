const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

const SYSTEM_PROMPT =
  '解析用户输入的词句。用中文解释，严格控制在200字以内。' +
  '直接输出释义本身，不要任何前缀、引号、标题或额外解释。'

// 用 Node 原生 http(s) 直连，不经 Chromium 网络栈（避免系统/环境代理干扰）
function explain(opts) {
  return new Promise((resolve) => {
    const { apiKey, model, text, ctrl, onDelta, onDone, onError } = opts
    const prompt = opts.systemPrompt || SYSTEM_PROMPT
    const timeout = (opts.timeoutSec || 30) * 1000

    const finish = (fn, arg) => {
      clearTimeout(timer)
      try { fn(arg) } catch (_) {}
      resolve()
    }

    const timer = setTimeout(() => {
      try { ctrl.abort('timeout') } catch (_) {}
      finish(onError, new Error('请求超时（' + Math.round(timeout / 1000) + '秒）'))
    }, timeout)

    ctrl.signal.addEventListener('abort', () => {
      finish(onError, new Error('请求被取消'))
    })

    let url
    try {
      url = new URL(String(opts.baseUrl || '').replace(/\/+$/, '') + '/chat/completions')
    } catch (e) {
      finish(onError, new Error('Base URL 格式错误'))
      return
    }

    const body = {
      model: model || 'deepseek-chat',
      stream: true,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      max_tokens: opts.maxTokens || 800,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ]
    }
    // MiMo 推理模型默认先输出 reasoning_content，会吃光 max_tokens 导致正文为空，显式关闭
    if (/xiaomimimo/i.test(String(opts.baseUrl))) {
      body.thinking = { type: 'disabled' }
    }
    const payload = JSON.stringify(body)

    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => {
            console.error('[ww:llm] HTTP', res.statusCode, body.slice(0, 300))
            finish(onError, new Error('API ' + res.statusCode + ': ' + body.slice(0, 200)))
          })
          return
        }
        console.log('[ww:llm] connected', res.statusCode, ', streaming')

        let buf = ''
        let full = ''
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8')
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const raw of lines) {
            const line = raw.trim()
            if (!line.startsWith('data:')) continue
            const payloadStr = line.slice(5).trim()
            if (!payloadStr || payloadStr === '[DONE]') continue
            try {
              const j = JSON.parse(payloadStr)
              const d = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''
              if (d) {
                full += d
                onDelta(d)
              }
            } catch (_) { /* 忽略半包 */ }
          }
        })
        res.on('end', () => {
          if (!full.trim()) {
            finish(onError, new Error('模型返回为空，请检查 API 配置'))
            return
          }
          console.log('[ww:llm] done, len=', full.trim().length)
          finish(onDone, full.trim())
        })
      }
    )

    req.on('error', (e) => {
      console.error('[ww:llm] request error:', String(e && e.message || e))
      finish(onError, new Error('网络错误：' + (e && e.message ? e.message : e)))
    })

    req.write(payload)
    req.end()
  })
}

module.exports = { explain }
