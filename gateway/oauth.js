// 微信 / QQ 第三方登录
//
// 两家都要在开放平台建「网站应用」并审核通过，拿到 AppID/AppSecret 才能用，
// 而且回调域名必须已备案、与申请时填的一致 —— 沙箱域名通常过不了审核。
// 所以这里做成「有配置就启用，没配置就老实说没配」，不假装能登。
//
// 环境变量：
//   WECHAT_APP_ID / WECHAT_APP_SECRET
//   QQ_APP_ID     / QQ_APP_KEY
//
// 回调地址统一为 <服务地址>/auth/oauth/<provider>/callback?sharecode=...

const IDS = {
  wechat: process.env.WECHAT_APP_ID || '',
  qq: process.env.QQ_APP_ID || ''
}
const SECRETS = {
  wechat: process.env.WECHAT_APP_SECRET || '',
  qq: process.env.QQ_APP_KEY || ''
}

function status() {
  return {
    wechat: !!(IDS.wechat && SECRETS.wechat),
    qq: !!(IDS.qq && SECRETS.qq)
  }
}

function enabled(provider) {
  return !!status()[provider]
}

function startUrl(provider, redirectUri) {
  if (!enabled(provider)) return null
  const r = encodeURIComponent(redirectUri)
  if (provider === 'wechat') {
    return (
      'https://open.weixin.qq.com/connect/qrconnect' +
      '?appid=' + IDS.wechat +
      '&redirect_uri=' + r +
      '&response_type=code&scope=snsapi_login&state=ww#wechat_redirect'
    )
  }
  return (
    'https://graph.qq.com/oauth2.0/authorize' +
    '?response_type=code&client_id=' + IDS.qq +
    '&redirect_uri=' + r +
    '&state=ww'
  )
}

// 用 code 换 openid 与昵称
async function exchange(provider, code, redirectUri) {
  if (!enabled(provider)) return { error: '该登录方式尚未配置' }
  try {
    if (provider === 'wechat') return await wechat(code)
    if (provider === 'qq') return await qq(code, redirectUri)
    return { error: '不支持的登录方式' }
  } catch (e) {
    console.error('[oauth] ' + provider + ' 失败', e.message)
    return { error: '第三方登录失败，请重试' }
  }
}

async function wechat(code) {
  const tk = await fetchJson(
    'https://api.weixin.qq.com/sns/oauth2/access_token' +
      '?appid=' + IDS.wechat +
      '&secret=' + SECRETS.wechat +
      '&code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code'
  )
  if (!tk || !tk.access_token) return { error: '微信授权失败：' + ((tk && tk.errmsg) || '未知原因') }
  const info = await fetchJson(
    'https://api.weixin.qq.com/sns/userinfo?access_token=' + tk.access_token + '&openid=' + tk.openid
  )
  return {
    openId: tk.openid,
    nickname: (info && info.nickname) || '',
    avatar: (info && info.headimgurl) || ''
  }
}

async function qq(code, redirectUri) {
  const tk = await fetchJson(
    'https://graph.qq.com/oauth2.0/token?grant_type=authorization_code' +
      '&client_id=' + IDS.qq +
      '&client_secret=' + SECRETS.qq +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&fmt=json'
  )
  if (!tk || !tk.access_token) return { error: 'QQ 授权失败' }
  const me = await fetchJson('https://graph.qq.com/oauth2.0/me?fmt=json&access_token=' + tk.access_token)
  if (!me || !me.openid) return { error: 'QQ 授权失败：拿不到 openid' }
  const info = await fetchJson(
    'https://graph.qq.com/user/get_user_info?access_token=' + tk.access_token +
      '&oauth_consumer_key=' + IDS.qq + '&openid=' + me.openid
  )
  return {
    openId: me.openid,
    nickname: (info && info.nickname) || '',
    avatar: (info && info.figureurl_qq_2) || ''
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (_) {
    // QQ 的 /me 返回 callback( {...} ); 这种包装
    const m = text.match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : null
  }
}

module.exports = { status, enabled, startUrl, exchange }
