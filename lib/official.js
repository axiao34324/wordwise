// 官方通道配置
//
// 客户端不含任何上游 API Key。所有模型请求都发往自建的转发服务
// （源码见工作区根目录 ww-gateway/），由它持有上游密钥并转发。
//
// 因此这个文件可以安全地随安装包分发：
//   BASE_URL 是公开的接口地址，APP_TOKEN 只是一个应用标识，
//   拿着它最多能调这里白名单内的两个模型，拿不到上游 Key。

// 末尾的 sharecode 是发布平台要求的访问凭证，重新部署后可能变化。
// 若出现「链接不完整」，先检查这个值是否与最新发布记录一致。
const SERVICE_URL = 'https://wordwise-58299.app.workbuddy.host'
const SHARE_CODE = 'LKBPBCLVR5'

const BASE_URL = SERVICE_URL + '/v1?sharecode=' + SHARE_CODE
const APP_TOKEN = 'ww-app-2f8a4c71'

// 拼账号/计费类接口地址（/auth/me、/billing/redeem…）
function apiUrl(pathname) {
  return SERVICE_URL + pathname + '?sharecode=' + SHARE_CODE
}

const MODEL = 'mimo-v2.6-flash'
const ACTION_MODEL = 'mimo-v2.6-flash'

// 可选模型。刻意不列 pro-ultraspeed：它比 flash 贵 30 倍，
// 换来的只是输出更快，而划词的瓶颈在首字延迟，不在输出速度。
const MODEL_OPTIONS = [
  { id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash · 快且省' },
  { id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro · 更细' }
]

// 把常见错误码翻成人话
function humanize(status, body) {
  const raw = String(body || '')
  if (/链接不完整|sharecode/i.test(raw)) return '接口地址已失效，请更新到最新版本'
  let code = ''
  let serverMsg = ''
  try {
    const j = JSON.parse(raw)
    code = (j.error && (j.error.code || j.error.type)) || j.code || ''
    serverMsg = (j.error && j.error.message) || ''
  } catch (_) {
    code = ''
  }
  // 自建转发服务返回的中文提示本来就是给用户看的（额度用完、需要订阅…），
  // 直接用，不要再被下面的正则概括成「请求太频繁」。
  // upstream_* 是上游原文的转述，可能是英文，交给下面的规则处理。
  if (serverMsg && /[\u4e00-\u9fff]/.test(serverMsg) && !/^upstream_/.test(code)) return serverMsg

  const s = status + ' ' + code + ' ' + raw

  if (/insufficient|quota|balance|余额|欠费/i.test(s)) return '服务额度已用完，请稍后再试'
  if (/rate_limit|too many|rpm|tpm/i.test(s) || status === 429) return '请求太频繁，稍等几秒再试'
  if (/invalid.*key|unauthorized|401|auth_invalid/i.test(s)) return '接口凭证失效，请更新到最新版本'
  if (/model_not_found|model.*not.*exist|no available channels/i.test(s))
    return '该模型名不可用，请在设置里换一个'
  if (/404/i.test(s)) return '接口地址不对，请检查 Base URL'
  if (/content_filter|safety/i.test(s)) return '内容被安全策略拦截了'
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(s)) return '网络不通或服务未启动'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return '调用失败（' + status + '），请检查设置里的接口配置'
}

module.exports = {
  SERVICE_URL,
  SHARE_CODE,
  BASE_URL,
  APP_TOKEN,
  apiUrl,
  MODEL,
  ACTION_MODEL,
  MODEL_OPTIONS,
  humanize
}
