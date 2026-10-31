// 发信：只做一件事 —— 把 6 位验证码送到用户邮箱
//
// 目前支持 Resend（一个 HTTP 调用，不需要 SMTP 那套握手）。
// 没配 RESEND_API_KEY 时退化为「开发模式」：验证码只写进服务端日志，
// 并随响应返回一个 devCode 字段，方便在没有邮箱服务时把流程跑通。
// 生产环境必须配上 key，否则等于没有验证。

const RESEND_KEY = process.env.RESEND_API_KEY || ''
const MAIL_FROM = process.env.WW_MAIL_FROM || 'WordWise <no-reply@wordwise.app>'

function enabled() {
  return !!RESEND_KEY
}

async function send(email, code) {
  if (!enabled()) {
    console.log('[mail] 未配置 RESEND_API_KEY，验证码只输出到日志：' + email + ' -> ' + code)
    return { ok: true, dev: true }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: 'WordWise 验证码 ' + code,
        html:
          '<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;font-size:14px;color:#222">' +
          '<p>你的 WordWise 验证码是：</p>' +
          '<p style="font-size:28px;letter-spacing:6px;font-weight:600;margin:16px 0">' + code + '</p>' +
          '<p style="color:#888">10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。</p>' +
          '</div>'
      })
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('[mail] 发送失败', res.status, text.slice(0, 200))
      return { ok: false, error: '邮件发送失败，请稍后重试' }
    }
    return { ok: true }
  } catch (e) {
    console.error('[mail] 发送异常', e.message)
    return { ok: false, error: '邮件服务连不上，请稍后重试' }
  }
}

module.exports = { send, enabled }
