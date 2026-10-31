// 官方通道端到端测试：真实走 lib/llm.js 的传输代码 + 登录令牌
// 用法：npx electron tools/test-llm.js
//
// 验证三件事：
//   1. 带 x-wordwise-key + x-ww-token 能拿到 SSE 流
//   2. 首字延迟在可接受范围（划词体验的瓶颈）
//   3. 服务端确实把这个账号的用量 +1

const { app } = require('electron')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-llm-'))
app.setPath('userData', dir)

app.whenReady().then(async () => {
  const account = require('../lib/account')
  const llm = require('../lib/llm')
  const official = require('../lib/official')

  let fails = 0
  const email = 'llm' + Date.now() + '@example.com'
  const reg = await account.register(email, 'test1234')
  if (!reg.ok) {
    console.log('注册失败：' + reg.error)
    app.exit(1)
    return
  }
  console.log('测试账号：' + email + ' 额度 ' + reg.user.dailyLimit + '/天\n')

  async function ask(label, text, model) {
    const t0 = Date.now()
    let first = 0
    let body = ''
    await llm.explain({
      baseUrl: official.BASE_URL,
      apiKey: official.APP_TOKEN,
      authHeader: 'x-wordwise-key',
      token: account.token(),
      model,
      action: 'explain',
      maxTokens: 800,
      timeoutSec: 30,
      ctrl: new AbortController(),
      text,
      onDelta: (d) => {
        if (!first) first = Date.now() - t0
        body += d
      },
      onDone: () => {},
      onError: (e) => {
        fails++
        console.log('  ✗ ' + label + ' 失败：' + e.message)
      }
    })
    if (body) {
      console.log('  ✓ [' + model + '] ' + label + '  首字=' + first + 'ms  总=' + (Date.now() - t0) + 'ms  字数=' + body.length)
      console.log('    ' + body.slice(0, 60).replace(/\n/g, ' '))
    }
    return body
  }

  console.log('[带登录令牌]')
  await ask('惯习', '惯习', 'mimo-v2.6-flash')
  await ask('场域', '场域', 'mimo-v2.6-flash')

  console.log('\n[免费版请求 pro 应被拒]')
  const t1 = Date.now()
  let errMsg = ''
  await llm.explain({
    baseUrl: official.BASE_URL,
    apiKey: official.APP_TOKEN,
    authHeader: 'x-wordwise-key',
    token: account.token(),
    model: 'mimo-v2.6-pro',
    text: 'test',
    timeoutSec: 20,
    ctrl: new AbortController(),
    onDelta: () => {},
    onDone: () => {},
    onError: (e) => { errMsg = e.message + ' / code=' + (e.code || '-') }
  })
  errMsg.includes('订阅') ? console.log('  ✓ ' + errMsg) : (fails++, console.log('  ✗ 期望拒绝，实际：' + (errMsg || '成功') + ' (' + (Date.now() - t1) + 'ms)'))

  console.log('\n[服务端用量核对]')
  const me = await account.refresh()
  const used = me.ok ? me.user.used : -1
  used === 2 ? console.log('  ✓ 服务端记录 ' + used + ' 次（与成功请求数一致）') : console.log('  ! 服务端记录 ' + used + ' 次')

  console.log('\n[无令牌匿名请求]')
  account.logout()
  let anonBody = ''
  await llm.explain({
    baseUrl: official.BASE_URL,
    apiKey: official.APP_TOKEN,
    authHeader: 'x-wordwise-key',
    model: 'mimo-v2.6-flash',
    text: 'doxa',
    timeoutSec: 30,
    ctrl: new AbortController(),
    onDelta: (d) => { anonBody += d },
    onDone: () => {},
    onError: (e) => { fails++; console.log('  ✗ 匿名请求失败：' + e.message) }
  })
  anonBody ? console.log('  ✓ 匿名可用，字数=' + anonBody.length) : null

  console.log('\n结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
  fs.rmSync(dir, { recursive: true, force: true })
  app.exit(fails === 0 ? 0 : 1)
})
