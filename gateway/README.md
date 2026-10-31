# WordWise 转发服务（后端）

客户端不持有任何上游模型 API Key。所有模型请求都发到这个小服务，由它带上
上游密钥转发，同时负责账号、额度和套餐权限。

零第三方依赖，只用 Node 内置模块 —— 部署时不需要装包，避免沙箱里 `npm install` 失败。

## 为什么需要它

| 方案 | 问题 |
| --- | --- |
| Key 放在客户端 | 装包一拆就泄露，拿到的人可以刷爆你的额度 |
| 直连各家厂商 | 每接一家就要发一次新版客户端，还要各家做 CORS 适配 |
| 自建转发 | Key 只在服务端；换模型、改额度、封号都在后端完成，客户端不用动 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回允许的模型列表 |
| GET | `/v1/models` | OpenAI 兼容的模型列表 |
| POST | `/auth/register` | 注册，返回 `{ token, user }` |
| POST | `/auth/login` | 登录，返回 `{ token, user }` |
| GET | `/auth/me` | 查身份与今日用量（`x-ww-token` 头） |
| POST | `/billing/redeem` | 兑换订阅码，返回升级后的 `user` |
| GET | `/admin/stats` | 用户总数 + 订阅码统计（需要客户端令牌） |
| POST | `/admin/codes` | 签发订阅码 `{days,count}`（需要客户端令牌） |
| GET | `/admin/codes` | 订阅码用量统计 |
| POST | `/v1/chat/completions` | OpenAI 兼容的流式补全，这是客户端真正用的那个 |

鉴权分两层：

- **客户端令牌**（`x-wordwise-key` 或 `Authorization: Bearer`）：挡随手爬虫，不是安全边界，因为它随安装包分发。
- **用户令牌**（`x-ww-token`）：服务端签发的 HMAC 串，30 天过期，用来算个人额度。

没带用户令牌的请求走匿名额度（按 IP，每天 20 次），这样新用户装完就能用，
不必先注册。

## 套餐

| 套餐 | 每日次数 | 可用模型 |
| --- | --- | --- |
| 匿名 | 20 | flash |
| 免费版 `free` | 80 | flash |
| 订阅版 `pro` | 2000 | flash、pro |

模型白名单在 `ALL_MODELS` 里。免费用户请求 pro 会拿到 `403 plan_required`，
客户端据此弹出「升级订阅」入口。

## 订阅码

订阅码**一次性**，存在 `data/codes.json`。首次启动种三个试用码
（`WW-30D-TRIAL` / `WW-90D-TRIAL` / `WW-365D-TRIAL`），各只能用一次 —— 写死在
代码里的码谁都能猜到并反复使用，所以不能用那套。

真实售卖时按订单签发：

```bash
curl -X POST "https://<你的域名>/admin/codes?sharecode=xxx" \
  -H "Content-Type: application/json" \
  -H "x-wordwise-key: <APP_TOKEN>" \
  -d '{"days":30,"count":1}'
# → {"codes":[{"code":"WW-30D-Z7FM-2GEX","days":30}],"stats":{...}}
```

重复兑换会**叠加**有效期，不是重置。

## 部署

单端口 HTTP 服务，监听 `PORT` 并绑 `0.0.0.0`：

```bash
MIMO_API_KEY=sk-xxx PORT=3000 node index.js
```

必须配置的环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MIMO_API_KEY` | 是 | 上游小米 MiMo 的 Key |
| `WORDWISE_APP_TOKEN` | 否 | 客户端令牌，默认 `ww-app-2f8a4c71` |
| `WW_DATA_DIR` | 否 | 账号数据目录，默认 `./data` |

## 已知限制

- **账号存在 JSON 文件里**（`data/users.json`）。单实例、低并发够用，但多实例部署会
  出现写覆盖。用户量上来要换成真正的数据库。
- **限流是进程内计数**（每 IP 每分钟 120 次）。重启即清零，多实例不共享。
- **没有真实支付通道**。订阅码靠 `/admin/codes` 人工签发，接微信/支付宝商户号或
  Lemon Squeezy 之后再补下单与回调 —— 那时候这个接口由支付回调调用，不再手动。
