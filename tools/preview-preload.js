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
  openTodo: () => {},
  openAccount: () => {},
  accountState: async () => current(),
  vocabCount: async () => 42,
  todoStats: async () => todoStats()
})

// ---- 待办预览数据 ----
// 有意挑三种典型来源：网页调研、读书时的冷门概念、一句话待查
const LISTS = [
  { id: 'inbox', name: '收件箱', createdAt: 0 },
  { id: 'l1', name: '布迪厄', createdAt: 0 },
  { id: 'l2', name: '产品与定价', createdAt: 0 }
]

const TODO_ITEMS = [
  {
    id: 't1',
    text: '换句话说，场域不是一个地理空间，而是一个由位置之间的关系构成的系统：占据不同位置的人，为了争夺这个场域里被认为有价值的那种资本而相互竞争。',
    title: '场域不是一个地理空间，而是位置关系的系统',
    note: '',
    def: '场域。布迪厄用语，指一个由位置之间的关系构成的社会空间：行动者依各自掌握的资本占据不同位置，并为争夺这个场域特有的资本而竞争。',
    listId: 'l1',
    source: { app: 'chrome', title: '布尔迪厄《实践与反思》读书笔记 - 知乎' },
    state: 'open',
    hit: 1,
    createdAt: Date.now() - 3600 * 1000
  },
  {
    id: 't2',
    text: '习惯（habitus）是历史内化于身体的结果，它以知觉、评判和行动的各种身心图式的方式存在，使得行动者在无需计算、无需明确规则的情况下，依然能够"恰当地"行动。',
    title: '习惯是历史内化于身体的结果',
    note: '和上一条是一回事，回头一起看再写一段',
    def: '',
    listId: 'l1',
    source: { app: 'chrome', title: '区隔：趣味判断的社会批判 · 第二章' },
    state: 'open',
    hit: 2,
    createdAt: Date.now() - 26 * 3600 * 1000
  },
  {
    id: 't3',
    text: '按次计费 vs 订阅制：把定价锚在最常用的那个动作上，而不是锚在"功能多少"上。用户记不住七个功能，只记得住"一天能用几次"。',
    title: '定价要锚在最高频的那个动作上',
    note: '',
    def: '',
    listId: 'l2',
    source: { app: 'chrome', title: 'SaaS Pricing Lessons — Lenny\'s Newsletter' },
    state: 'open',
    hit: 1,
    createdAt: Date.now() - 3 * 86400 * 1000
  },
  {
    id: 't4',
    text: '符号暴力：被支配者以支配者的范畴来认识自己，从而把这种支配关系认作自然、正当的。',
    title: '符号暴力 = 用支配者的范畴认识自己',
    note: '',
    def: '符号暴力。布迪厄用语，指被支配者用支配者的分类框架理解自身处境，从而使不平等显得自然合理。',
    listId: 'inbox',
    source: { app: 'winword', title: '论文初稿.docx' },
    state: 'done',
    hit: 1,
    createdAt: Date.now() - 5 * 86400 * 1000,
    doneAt: Date.now() - 2 * 86400 * 1000
  },
  {
    id: 't5',
    text: '某个讲"注意力经济"的播客，提到把通知全部关掉之后写作量翻倍。',
    title: '注意力经济那期播客里提到关通知',
    note: '',
    def: '',
    listId: 'inbox',
    source: { app: 'chrome', title: '小宇宙 - 无人知晓 E12' },
    state: 'archived',
    hit: 1,
    createdAt: Date.now() - 20 * 86400 * 1000
  }
]

function todoStats() {
  return {
    open: TODO_ITEMS.filter((x) => x.state === 'open').length,
    done: TODO_ITEMS.filter((x) => x.state === 'done').length,
    archived: TODO_ITEMS.filter((x) => x.state === 'archived').length,
    total: TODO_ITEMS.length,
    today: 1
  }
}

contextBridge.exposeInMainWorld('todoApi', {
  onTheme: () => {},
  onChanged: () => {},
  list: async (opts) => {
    const f = (opts && opts.filter) || 'open'
    const items = TODO_ITEMS.filter((x) => (f === 'all' ? true : x.state === f))
    return { lists: LISTS, items, stats: todoStats(), filter: f }
  },
  update: async () => ({}),
  remove: async () => true,
  purgeArchived: async () => ({ removed: 0 }),
  addList: async () => ({}),
  removeList: async () => true,
  exportMd: async () => ({ ok: true, path: '…' }),
  openChat: () => {},
  recap: (id) => {
    const text =
      '· 这段讲的是场域与资本的关系：位置由关系决定，而争夺的对象是被这个场域认定为有价值的东西\n' +
      '· 属于社会学理论里的实践论脉络，可以跟戈夫曼的"框架"、布迪厄自己的"惯习"放在一起看\n' +
      '· 值得往回查的一步：找《实践与反思》里讲"场域自主性"的那一节，对照一个你熟悉的具体场域（比如学术圈）把位置图画出来'
    setTimeout(() => {
      const box = document.querySelector('.recap[data-id="' + id + '"]')
      if (box) {
        box.className = 'recap show'
        box.textContent = text
      }
    }, 200)
  },
  onRecapDelta: () => {},
  onRecapDone: () => {},
  onRecapError: () => {}
})

// 弹窗也要能预览：state 传 err 时渲染「额度用完 + 去登录」那一屏
let onErrorCb = null
let onResultCb = null
let onTodoResultCb = null
contextBridge.exposeInMainWorld('ww', {
  onTheme: () => {},
  onChoose: () => {},
  onLoading: () => {},
  onResult: (cb) => { onResultCb = cb },
  onDelta: () => {},
  onDone: () => {},
  onError: (cb) => { onErrorCb = cb },
  onVocabResult: () => {},
  onTodoResult: (cb) => { onTodoResultCb = cb },
  choose: () => {},
  openChat: () => {},
  openAccount: () => {},
  openTodo: () => {},
  addVocab: () => {},
  addTodo: () => {
    setTimeout(() => {
      if (onTodoResultCb) onTodoResultCb({ added: true, dup: false, count: 3 })
    }, 120)
  },
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
