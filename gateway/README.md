# WordWise 转发服务（后端）

客户端不持有任何上游模型 API Key。所有模型请求都发到这个小服务，由它带上
上游密钥转发，同时负责账号、额度与套餐权限。

零第三方依赖，只用 Node 内置模块 —— 部署时不需要装包，避免沙箱里 `npm install` 失败。

## 为什么需要它

| 方案 | 问题 |
| --- | --- |
| Key 放在客户端 | 装包一拆就泄露，拿到的人可以刷爆你的额度 |
| 直连各家厂商 | 每接一家就要发一次新版客户端，还要各家做 CORS 适配 |
| 自建转发 | Key 只在服务端；换模型、改额度、封号都在后端完成，客户端不用动 |

## 三种身份

产品上只有三种人，后端的所有分支都从这一条推出来：

| 身份 | 能不能用官方通道 | 说明 |
| --- | --- | --- |
| 匿名（未登录） | **不能** | 只能走「自带 Key」，请求直连用户自己买的服务，不占我们成本 |
| 登录 · 免费版 | 能，基础额度 | 注册即得，用来让人把产品用起来 |
| 登录 · 标准版 / 专业版 | 能，更高额度 | 卖的就是这两档 |

匿名不给官方额度是刻意的决定：官方通道的每一次请求都在花我们的钱，
没有身份就没有成本上限；而愿意用的人注册一个邮箱验证码只花十秒。
想零门槛试用的，走自带 Key 那条路，成本在他自己那边。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回允许的模型列表 |
| GET | `/v1/models` | OpenAI 兼容的模型列表 |
| GET | `/v1/plans` | 三档套餐 + 可用模型 + 第三方登录/邮件服务是否就绪 |
| POST | `/auth/email/code` | 发送 6 位邮箱验证码（免密码登录的第一步） |
| POST | `/auth/email/verify` | 校验验证码，返回 `{ token, user, created }` |
| POST | `/auth/register` / `/auth/login` | 老的密码通道，留给存量账号 |
| GET | `/auth/me` | 查身份与额度（`x-ww-token` 头） |
| POST | `/billing/redeem` | 兑换订阅码，返回升级后的 `user` |
| GET | `/auth/oauth/status` | 微信 / QQ 是否已配置 |
| GET | `/auth/oauth/:p/start` | 跳转到第三方授权页（`wechat` / `qq`） |
| GET | `/auth/oauth/:p/callback` | 回调落地页，把 token 写进 `window.__WW_AUTH__` |
| GET | `/admin/stats` | 用户数、分档人数、今日/本月请求、成本、预算 |
| GET | `/admin/export` | 导出全部账号，发布前备份用 |
| POST | `/admin/codes` | 签发订阅码 `{days, count, plan}` |
| GET | `/admin/codes` | 订阅码用量统计 |
| POST | `/v1/chat/completions` | OpenAI 兼容的流式补全，客户端真正用的那个 |

鉴权分三层：

- **客户端令牌**（`x-wordwise-key`）：挡随手爬虫，不是安全边界，因为它随安装包分发。
- **用户令牌**（`x-ww-token`）：服务端签发的 HMAC 串，30 天过期，用来算个人额度。
- **管理令牌**（`x-ww-admin` 或 `x-wordwise-key`）：只给 `/admin/*`，**必须**与客户端令牌不同。
  客户端令牌人人可扒，若管理接口也用它，等于把「签发订阅码」的权限发给每个用户。

> 托管沙箱的反向代理会吞掉 `Authorization` 头，所以管理令牌也接受从
> `x-wordwise-key` 传入；长度不等的一律不认，客户端令牌不会误撞上。

## 套餐

三档，套餐表只写在 `auth.js` 的 `PLANS` 里，客户端通过 `/v1/plans` 读，改价改额度不用发新版。

| 档位 | 每天 | 每月 | 每分钟 | 模型 | 价格 |
| --- | --- | --- | --- | --- | --- |
| 免费版 | 100 | 1500 | 15 | flash | ¥0 |
| 标准版 | 1200 | 15000 | 30 | flash + pro | ¥29/月，¥299/年 |
| 专业版 | 3000 | 40000 | 60 | flash + pro | ¥79/月，¥799/年 |

订阅过期自动降回免费版（`planOf` 里判 `expireAt`），不需要定时任务打扫。

## 流量管理

四层限制，各管一件事，缺一层都会出问题：

| 层 | 管什么 | 免费版 | 标准版 | 专业版 |
| --- | --- | --- | --- | --- |
| 每分钟 | 防脚本高频打上游 | 15 | 30 | 60 |
| 每日 | 体验层「一天能用多少」 | **100** | 1200 | 3000 |
| 每月 | 成本兜底，防止日额度攒成天量 | **1500** | 15000 | 40000 |
| 可用模型 | 差异化卖点 | flash | flash + pro | flash + pro |

**免费版为什么是 100/天 + 1500/月**：普通人一天认真读十几篇材料也用不到 100 次，
所以日常不会被额度打断；而 1500/月 把「每天都用满」的成本封在约 ¥0.8/月/人
（flash 单价 1/2 元每百万 token，实测单次约 ¥0.0005）。

日额度与月额度哪个先到头就以哪个为准，错误码分别是 `quota_daily` / `quota_monthly`，
客户端据此把「登录 / 升级」按钮顶到用户面前。每分钟超限是 `quota_rate_minute`。

还有一层**全局日预算**（`WW_DAILY_BUDGET_YUAN`，默认 30 元）：当天累计估算成本超线后，
未付费用户被挡在门外（`quota_global`），付费用户照常。这层不是给用户看的，
是给自己的账单兜底的 —— 万一被刷或被大量免费用户同时使用，先止损。

额度随流式响应一起回传，客户端不必再单查一次：

```
x-ww-used-day: 1        x-ww-limit-day: 100
x-ww-used-month: 1      x-ww-limit-month: 1500
x-ww-plan: free
```

成本按小米 MiMo 国内价估算（flash 1/2、pro 3/6 元每百万 token）：请求前按输入
字数 + 一个保守输出估值记账，流结束后按实际输出字数补差。只用于预算熔断和运营报表，
不参与计费。

模型白名单在 `ALL_MODELS` 里。免费用户请求 pro 会拿到 `403 plan_required`，
客户端据此提示升级。

## 登录方式

**邮箱验证码（默认可用）**：输邮箱 → 收 6 位码 → 验证通过即登录，没账号就顺手建一个。
验证码 10 分钟有效、最多试 5 次；同邮箱 60 秒一次、每天 10 次。

配了 `RESEND_API_KEY` 才会真发信；没配时是**开发模式**：验证码写日志并随响应返回
`devCode`，方便本地把流程走完。线上必须配，否则谁都能登进别人的邮箱。

**微信 / QQ（需开放平台审核）**：在微信开放平台 / QQ 互联申请网站应用，把
回调域名指向 `/auth/oauth/:provider/callback`，配好环境变量后按钮自动可点；
没配时 `/v1/plans` 返回 `oauth: {wechat:false, qq:false}`，客户端把按钮置灰并说明原因。

回调页只做一件事：把 token 写进 `window.__WW_AUTH__`，Electron 授权窗口加载完后
用 `executeJavaScript` 取走再自己关窗 —— 这样客户端不用起本地 HTTP 服务接回调。

## 订阅码

订阅码**一次性**，存在 `data/codes.json`，带档位前缀：`WW-STD-30D-XXXX-XXXX` /
`WW-PRO-30D-XXXX-XXXX`。首次启动种两张试用码（`WW-STD-30D-TRIAL` /
`WW-PRO-30D-TRIAL`），各只能用一次 —— 写死在代码里的码谁都能猜到并反复使用，所以不能用那套。

真实售卖时按订单签发：

```bash
curl -X POST "https://<你的域名>/admin/codes?sharecode=xxx" \
  -H "Content-Type: application/json" \
  -H "x-ww-admin: <ADMIN_TOKEN>" \
  -d '{"days":30,"count":1,"plan":"standard"}'
# → {"codes":[{"code":"WW-STD-30D-Z7FM-2GEX","days":30,"plan":"standard"}],"stats":{...}}
```

重复兑换会**叠加**有效期，不是重置；**降级码不覆盖更高档** —— 专业版用户兑一张标准版码，
只会延长到期时间，不会被打回标准版。

## 部署

单端口 HTTP 服务，监听 `PORT` 并绑 `0.0.0.0`：

```bash
MIMO_API_KEY=sk-xxx WW_ADMIN_TOKEN=xxx PORT=3000 node index.js
```

环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MIMO_API_KEY` | 是 | 上游小米 MiMo 的 Key |
| `WW_ADMIN_TOKEN` | 是 | 管理令牌，**必须**改掉默认值 |
| `WW_SECRET` | 建议 | token 签名密钥，换掉后所有已发 token 失效 |
| `WORDWISE_APP_TOKEN` | 否 | 客户端令牌，默认 `ww-app-2f8a4c71` |
| `WW_ORIGIN` | 否 | 对外地址，第三方登录回调要用 |
| `WW_SHARE_CODE` | 否 | 分享码，重新部署变了就改这里 |
| `RESEND_API_KEY` / `WW_MAIL_FROM` | 建议 | 邮箱验证码发信；不配就是开发模式 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 否 | 微信登录 |
| `QQ_APP_ID` / `QQ_APP_KEY` | 否 | QQ 登录 |
| `WW_DATA_DIR` | 否 | 账号数据目录，默认 `./data` |
| `WW_DAILY_BUDGET_YUAN` | 否 | 全局日预算（元），默认 30 |

发布新版本前先备份账号（沙箱重建可能清掉 `data/`）：

```bash
curl -s "https://<你的域名>/admin/export?sharecode=xxx" -H "x-ww-admin: <ADMIN_TOKEN>" > users-backup.json
```

## 测试

```bash
node test-quota.js
```

13 组断言，覆盖日/月边界、跨天不清月、跨月清零、订阅过期降级、成本可为负时钳零、
三档额度、订阅码一次性、降级码不降档、运营总览汇总。不联网、不启服务。

## 已知限制

- **账号存在 JSON 文件里**（`data/users.json`）。单实例、低并发够用，但多实例部署会
  出现写覆盖。用户量上来要换成真正的数据库。
- **限流与预算是进程内计数**，重启即清零，多实例不共享。单实例够用，横向扩容前要先搬走。
- **成本是估算**（按字数折算 token），用于熔断和报表，不等于账单金额。
- **没有真实支付通道**。订阅码靠 `/admin/codes` 人工签发，接微信/支付宝商户号或
  Lemon Squeezy 之后再补下单与回调 —— 那时候这个接口由支付回调调用，不再手动。
- **管理令牌能签发任意订阅码**，目前没有二次校验；接入支付后应改为由支付回调
  签名触发，人手不再持有这个能力。
