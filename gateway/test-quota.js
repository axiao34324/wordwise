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

console.log('\n[6] 专业版额度')
u.plan = 'pro'
u.expireAt = Date.now() + 86400000
const entPro = auth.entitlements(u)
eq(entPro.plan, 'pro', '档位')
eq(entPro.dailyLimit, 3000, '日额度')
eq(entPro.monthlyLimit, 40000, '月额度')
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
eq(s.paid >= 1, true, '订阅数 ≥ 1')
eq(typeof s.byPlan, 'object', '分档统计')
eq(typeof s.requestsMonth, 'number', '本月请求数类型')
eq(Array.isArray(s.top), true, 'Top 列表')

console.log('\n[11] 标准版：兑换码升级并放宽额度')
const r2 = auth.register('q2@test.com', 'test1234')
const u2 = auth.byToken(r2.token)
eq(auth.checkQuota(u2).ok, true, '兑换前额度可用')
const std = auth.redeem(u2, 'WW-STD-30D-TRIAL')
eq(std.error, undefined, '标准码兑换成功')
const e2 = auth.entitlements(u2)
eq(e2.plan, 'standard', '档位')
eq(e2.dailyLimit, 1200, '日额度')
eq(e2.monthlyLimit, 15000, '月额度')
eq(e2.perMinute, 30, '每分钟')
eq(e2.models.includes('mimo-v2.6-pro'), true, '解锁 Pro 模型')

console.log('\n[12] 订阅码一次性 + 降级码不覆盖更高档')
eq(auth.redeem(u2, 'WW-STD-30D-TRIAL').error, '这个订阅码已经被用过了', '二次兑换被拒')
const r3 = auth.register('q3@test.com', 'test1234')
const u3 = auth.byToken(r3.token)
auth.redeem(u3, 'WW-PRO-30D-TRIAL')
eq(auth.entitlements(u3).plan, 'pro', '专业码 → 专业版')
const expBefore = u3.expireAt
const stdCode = auth.mintCodes(30, 1, 'standard')[0].code
eq(stdCode.startsWith('WW-STD-30D-'), true, '签发的标准码带档位前缀')
const down = auth.redeem(u3, stdCode)
eq(down.plan, 'pro', '标准码不会把专业版降档')
eq(u3.expireAt > expBefore, true, '但到期时间照常延长')

console.log('\n[13] 签发专业版码')
const proCode = auth.mintCodes(30, 2, 'pro')
eq(proCode.length, 2, '一次签 2 张')
eq(proCode[0].code.startsWith('WW-PRO-30D-'), true, '专业码带 PRO 前缀')
eq(auth.codeStats().unused >= 2, true, '未使用数 ≥ 2')

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n结果：' + (fails === 0 ? '全部通过' : fails + ' 项失败'))
process.exit(fails === 0 ? 0 : 1)
