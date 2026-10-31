// 配额逻辑单元测试（不联网、不启服务，直接把 auth.js 当纯模块跑）
// 用法：node test-quota.js

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-quota-'))
process.env.WW_DATA_DIR = dir

const auth = require('./auth')

let fails = 0
const ok = (t) => console.log('  ✓ ' + t)
const bad = (t) => {
  fails++
  console.log('  ✗ ' + t)
}
const eq = (got, want, t) => (got === want ? ok(t + ' = ' + got) : bad(t + ' 期望 ' + want + '，实际 ' + got))

console.log('\n[1] 免费版基础额度')
const r = auth.register('q1@test.com', 'test1234')
const u = auth.byToken(r.token)
const ent = auth.entitlements(u)
eq(ent.dailyLimit, 100, '日额度')
eq(ent.monthlyLimit, 1500, '月额度')
eq(ent.perMinute, 15, '每分钟')
eq(ent.models.join(','), 'mimo-v2.6-flash', '可用模型')

console.log('\n[2] 日额度边界：第 99 次可用，第 100 次撞墙')
for (let i = 0; i < 99; i++) auth.bumpUsage(u)
eq(auth.usedToday(u), 99, '已用')
eq(auth.checkQuota(u).ok, true, '99 次时仍可用')
auth.bumpUsage(u)
const q = auth.checkQuota(u)
eq(q.ok, false, '第 100 次后')
eq(q.code, 'quota_daily', '错误码')

console.log('\n[3] 跨天自动归零，月额度不清零')
u.usage.day = '2000-01-01'
eq(auth.usedToday(u), 0, '跨天后日用量')
eq(auth.usedThisMonth(u), 100, '跨天后月用量（不应清零）')

console.log('\n[4] 月额度单独生效')
u.usage.monthN = 1500
u.usage.dayN = 0
const q2 = auth.checkQuota(u)
eq(q2.ok, false, '月额度用满')
eq(q2.code, 'quota_monthly', '错误码')

console.log('\n[5] 跨月归零')
u.usage.month = '2000-01'
eq(auth.usedThisMonth(u), 0, '跨月后月用量')
eq(auth.checkQuota(u).ok, true, '跨月后恢复可用')

console.log('\n[6] 订阅版额度')
u.plan = 'pro'
u.expireAt = Date.now() + 86400000
const entPro = auth.entitlements(u)
eq(entPro.dailyLimit, 2000, '日额度')
eq(entPro.monthlyLimit, 30000, '月额度')
eq(entPro.perMinute, 60, '每分钟')
eq(entPro.models.length, 2, '模型数')

console.log('\n[7] 订阅过期自动降回免费版')
u.expireAt = Date.now() - 1000
eq(auth.entitlements(u).dailyLimit, 100, '过期后日额度')

console.log('\n[8] 成本记账（估值与结算）')
u.expireAt = Date.now() + 86400000
const before = auth.usageOf(u).costMonth
auth.bumpUsage(u, { yuan: 0.0005, tokens: 300 })
auth.addCost(u, { yuan: -0.0002, tokens: -100 })
const after = auth.usageOf(u).costMonth
const delta = Math.round((after - before) * 100000) / 100000
eq(delta, 0.0003, '成本净增')

console.log('\n[9] 用量不会为负')
auth.addCost(u, { yuan: -99, tokens: 0 })
eq(auth.usageOf(u).costMonth >= 0, true, '成本非负')

console.log('\n[10] 运营总览')
const s = auth.stats()
eq(s.users >= 1, true, '用户数 ≥ 1')
eq(s.pro >= 1, true, '订阅数 ≥ 1')
eq(typeof s.requestsMonth, 'number', '本月请求数类型')
eq(Array.isArray(s.top), true, 'Top 列表')

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
process.exit(fails === 0 ? 0 : 1)
