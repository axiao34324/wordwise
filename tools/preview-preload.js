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
  plan: 'free',
  planLabel: '免费版',
  used: 0,
  dailyLimit: 0,
  remaining: 0,
  models: [],
  expireAt: null,
  daysLeft: null
}

const USER = {
  loggedIn: true,
  email: 'a.xiao@example.com',
  plan: plan === 'free' ? 'free' : 'pro',
  planLabel: plan === 'free' ? '免费版' : '订阅版',
  used: 137,
  dailyLimit: plan === 'free' ? 80 : 2000,
  remaining: plan === 'free' ? 0 : 1863,
  models: plan === 'free' ? ['mimo-v2.6-flash'] : ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
  expireAt: plan === 'free' ? null : Date.now() + 86400000 * 71,
  daysLeft: plan === 'free' ? null : 71
}

const current = () => (state === 'user' ? USER : ANON)

contextBridge.exposeInMainWorld('accountApi', {
  onTheme: () => {},
  state: async () => current(),
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
