// 预览用 preload：给页面喂假数据，不连真实服务
// 由 tools/preview.js 通过 additionalArguments 控制展示哪一屏
const { contextBridge } = require('electron')

function argVal(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : fallback
}

const state = argVal('ww-preview-state', 'anon')
const plan = argVal('ww-preview-plan', 'pro')

const ANON = {
  loggedIn: false,
  email: '',
  nickname: '',
  provider: '',
  plan: 'free',
  planName: '免费版',
  planLabel: '免费版',
  used: 0,
  dailyLimit: 0,
  remaining: 0,
  usedMonth: 0,
  monthlyLimit: 0,
  remainingMonth: 0,
  perMinute: 0,
  models: [],
  expireAt: null,
  daysLeft: null
}

// 三档：free / standard / pro，数字与后端 PLANS 保持一致
const TIER = {
  free: {
    plan: 'free', planName: '免费版', label: '免费版',
    daily: 100, used: 61, monthly: 1500, usedMonth: 1240, perMinute: 15,
    models: ['mimo-v2.6-flash'], days: 0
  },
  standard: {
    plan: 'standard', planName: '标准版', label: '标准版',
    daily: 1200, used: 137, monthly: 15000, usedMonth: 4890, perMinute: 30,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], days: 94
  },
  pro: {
    plan: 'pro', planName: '专业版', label: '专业版',
    daily: 3000, used: 137, monthly: 40000, usedMonth: 4890, perMinute: 60,
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], days: 71
  }
}

const t = TIER[plan] || TIER.pro
const USER = {
  loggedIn: true,
  email: 'a.xiao@example.com',
  nickname: '',
  provider: 'email',
  plan: t.plan,
  planName: t.planName,
  planLabel: t.label,
  used: t.used,
  dailyLimit: t.daily,
  remaining: Math.max(0, t.daily - t.used),
  usedMonth: t.usedMonth,
  monthlyLimit: t.monthly,
  remainingMonth: Math.max(0, t.monthly - t.usedMonth),
  perMinute: t.perMinute,
  models: t.models,
  expireAt: t.days ? Date.now() + 86400000 * t.days : null,
  daysLeft: t.days || null
}

const current = () => (state === 'user' ? USER : ANON)

const PLANS = [
  { id: 'free', name: '免费版', tagline: '日常阅读够用', daily: 100, monthly: 1500, perMinute: 15, models: ['mimo-v2.6-flash'], priceMonth: 0, priceYear: 0 },
  { id: 'standard', name: '标准版', tagline: '解锁 Pro 模型，长文与追问问得更细', daily: 1200, monthly: 15000, perMinute: 30, models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], priceMonth: 29, priceYear: 299 },
  { id: 'pro', name: '专业版', tagline: '给每天长时间阅读与写作的人', daily: 3000, monthly: 40000, perMinute: 60, models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], priceMonth: 79, priceYear: 799 }
]

contextBridge.exposeInMainWorld('accountApi', {
  onTheme: () => {},
  onOauthResult: () => {},
  state: async () => current(),
  plans: async () => ({
    plans: PLANS,
    oauth: { wechat: !!(process.env.PREVIEW_OAUTH), qq: false },
    mail: false
  }),
  sendCode: async () => ({ ok: true, dev: true, devCode: '202966', ttlMin: 10 }),
  verifyCode: async () => ({ ok: true, user: USER, created: true }),
  loginPassword: async () => ({ ok: true, user: USER }),
  oauthStart: async () => ({ ok: true }),
  refresh: async () => ({ ok: true, user: current() }),
  register: async () => ({ ok: true, user: USER }),
  login: async () => ({ ok: true, user: USER }),
  redeem: async () => ({ ok: true, user: USER }),
  logout: async () => true
})

// 设置页也要能预览：喂一份接近真实默认值的配置
const SETTINGS = {
  theme: argVal('ww-preview-theme', 'rock'),
  enabled: true,
  provider: 'official',
  officialModel: 'mimo-v2.6-flash',
  officialActionModel: 'mimo-v2.6-flash',
  baseUrl: 'https://api.qnaigc.com/v1',
  apiKey: '',
  model: 'mimo-v2.6-flash',
  actionModel: 'mimo-v2.6-flash',
  systemPrompt: '解析用户输入的词句。用中文解释，严格控制在200字以内。直接输出释义本身，不要任何前缀、引号、标题或额外解释。',
  temperature: 0.3,
  maxTokens: 800,
  maxLen: 2000,
  longTextThreshold: 15,
  cooldownSec: 60,
  timeoutSec: 30,
  autoPopupMs: 220,
  disabledApps: [],
  autoStart: false,
  hideAfterSec: 15
}

contextBridge.exposeInMainWorld('settingsApi', {
  onTheme: () => {},
  get: async () => ({ ...SETTINGS, theme: argVal('ww-preview-theme', 'rock') }),
  save: async () => SETTINGS,
  openChat: () => {},
  openVocab: () => {},
  openAccount: () => {},
  accountState: async () => current(),
  vocabCount: async () => 42
})

// 弹窗也要能预览：state 传 err 时渲染「额度用完 + 去登录」那一屏
let onErrorCb = null
let onResultCb = null
contextBridge.exposeInMainWorld('ww', {
  onTheme: () => {},
  onChoose: () => {},
  onLoading: () => {},
  onResult: (cb) => { onResultCb = cb },
  onDelta: () => {},
  onDone: () => {},
  onError: (cb) => { onErrorCb = cb },
  onVocabResult: () => {},
  choose: () => {},
  openChat: () => {},
  openAccount: () => {},
  addVocab: () => {},
  resize: () => {},
  close: () => {},
  copy: () => {}
})

// 页面脚本注册完回调后由这里触发一次，模拟主进程推送
if (process.env.WW_PREVIEW_FIRE === 'err' || state === 'err') {
  setTimeout(() => {
    if (onErrorCb) onErrorCb({ message: '试用额度已用完，登录后额度更高', code: 'quota_exhausted' })
  }, 300)
} else if (state === 'ok') {
  setTimeout(() => {
    if (onResultCb) onResultCb({ text: 'habitus', action: 'explain', result: '惯习。布迪厄用语，指被场域结构内化而成的持久倾向系统，使人不假思索地按场域规则行动。', isWord: true, model: 'mimo-v2.6-flash' })
  }, 300)
}
