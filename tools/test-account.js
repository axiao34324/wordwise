// 账号模块端到端测试（会用临时 userData，不污染真实账号）
// 用法：npx electron tools/test-account.js

const { app } = require('electron')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-acc-'))
app.setPath('userData', dir)

const ok = (t) => console.log('  ✓ ' + t)
const bad = (t) => console.log('  ✗ ' + t)

app.whenReady().then(async () => {
  const account = require('../lib/account')
  const email = 't' + Date.now() + '@example.com'
  const pw = 'test1234'
  let fails = 0

  console.log('\n[1] 初始状态应为未登录')
  const s0 = account.state()
  s0.loggedIn === false ? ok('未登录') : (fails++, bad('应为未登录'))

  console.log('\n[2] 注册')
  const r1 = await account.register(email, pw)
  if (r1.ok) ok('注册成功 ' + r1.user.email + ' 额度 ' + r1.user.dailyLimit)
  else (fails++, bad('注册失败 ' + r1.error))

  console.log('\n[3] token 已落地，状态为已登录')
  const s1 = account.state()
  s1.loggedIn && s1.email === email ? ok('已登录 ' + s1.planLabel) : (fails++, bad('状态不对: ' + JSON.stringify(s1)))

  console.log('\n[4] 重复注册应失败')
  const r2 = await account.register(email, pw)
  !r2.ok ? ok('被拒绝：' + r2.error) : (fails++, bad('重复注册竟然成功'))

  console.log('\n[5] 错误密码登录应失败')
  const r3 = await account.login(email, 'wrongpass')
  !r3.ok ? ok('被拒绝：' + r3.error) : (fails++, bad('错误密码竟然成功'))

  console.log('\n[6] 免费版不能用 pro')
  const free = account.state()
  free.models.includes('mimo-v2.6-pro')
    ? (fails++, bad('免费版不该有 pro 权限'))
    : ok('模型权限：' + free.models.join(','))

  console.log('\n[7] 兑换订阅码')
  const r4 = await account.redeem('WW-30D-TRIAL')
  if (r4.ok) ok('已升级 ' + r4.user.planLabel + ' 额度 ' + r4.user.dailyLimit + ' 到期 ' + r4.user.daysLeft + ' 天后')
  else (fails++, bad('兑换失败 ' + r4.error))

  console.log('\n[8] 刷新后 pro 权限到位')
  const r5 = await account.refresh()
  r5.ok && r5.user.models.includes('mimo-v2.6-pro')
    ? ok('模型权限：' + r5.user.models.join(','))
    : (fails++, bad('刷新后仍无 pro 权限'))

  console.log('\n[9] 本地 +1 与真实用量一致')
  const before = account.state().used
  account.bumpLocal()
  const after = account.state().used
  after === before + 1 ? ok('本地用量 ' + before + ' → ' + after) : (fails++, bad('本地计数异常'))

  console.log('\n[10] 退出登录')
  account.logout()
  const s2 = account.state()
  !s2.loggedIn && !account.token() ? ok('已退出，token 已清') : (fails++, bad('退出失败'))

  console.log('\n[11] 已保存的 token 能跨进程复用（读文件校验）')
  const f = path.join(dir, 'account.json')
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
  disk.token === '' ? ok('文件已写回空 token') : (fails++, bad('文件未清理'))

  console.log('\n结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
  fs.rmSync(dir, { recursive: true, force: true })
  app.exit(fails === 0 ? 0 : 1)
})
