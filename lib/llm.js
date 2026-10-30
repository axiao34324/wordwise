const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

const SYSTEM_PROMPT =
  '解析用户输入的词句。用中文解释，严格控制在200字以内。' +
  '直接输出释义本身，不要任何前缀、引号、标题或额外解释。'

// 长文本可选动作。explain 使用用户自定义 systemPrompt，其余用内置提示词
const ACTIONS = [
  { id: 'explain', label: '解释', hint: '讲解含义' },
  { id: 'summary', label: '总结', hint: '提炼要点' },
  { id: 'translate', label: '翻译', hint: '中英互译' },
  { id: 'polish', label: '润色', hint: '改善表达' }
]

const ACTION_PROMPTS = {
  explain: SYSTEM_PROMPT,
  summary:
    '把用户提供的文本总结成核心要点。用中文输出 3-5 条，每条一行、以「· 」开头，每条约 30 字。' +
    '只输出要点本身，不要标题、不要开场白、不要补充说明。',
  translate:
    '把用户提供的文本翻译成中文；若原文主要是中文，则翻译成英文。' +
    '只输出译文本身，长度与原文相当，保持原文段落结构；' +
    '不要输出原文、不要逐句注释、不要补充解释或任何标注。',
  polish:
    '润色用户提供的文本：修正语病与错别字，改善表达与逻辑衔接，保持原意和信息量不变。' +
    '只输出润色后的文本，不要解释改动、不要加标题。'
}

// 用 Node 原生 http(s) 直连，不经 Chromium 网络栈（避免系统/环境代理干扰）
function explain(opts) {
  return new Promise((resolve) => {
    const { apiKey, model, text, ctrl, onDelta, onDone, onError } = opts
    const action = ACTION_PROMPTS[opts.action] ? opts.action : 'explain'
    const prompt =
      (action === 'explain' && opts.systemPrompt) ||
      ACTION_PROMPTS[action] ||
      SYSTEM_PROMPT
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
      // 多轮对话直接传 messages；单轮用 system + text
      messages:
        Array.isArray(opts.messages) && opts.messages.length
          ? opts.messages
          : [
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

module.exports = { explain, ACTIONS }
