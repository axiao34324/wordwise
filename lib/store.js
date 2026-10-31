const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  theme: 'rock',
  enabled: true,
  // 使用方式：official = 官方通道（默认，内置配置）；byok = 用户自己的服务
  provider: 'official',
  // 官方通道的模型（provider=official 时生效）。接口地址与密钥见 lib/official.js
  officialModel: 'mimo-v2.6-flash',
  officialActionModel: 'mimo-v2.6-flash',
  // 自带 Key 模式下的服务地址，默认预填七牛云（国内、78 个模型、有免费额度）
  baseUrl: 'https://api.qnaigc.com/v1',
  apiKey: '',
  model: 'mimo-v2.6-pro-ultraspeed',
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

let cached = null

function file() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function load() {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    cached = { ...DEFAULTS, ...raw }
  } catch {
    cached = { ...DEFAULTS }
  }
  // 旧版本可能存了 cloud / proxy 等已废弃的通道名，统一归到 official
  if (cached.provider !== 'byok') cached.provider = 'official'
  return cached
}

function get() {
  return load()
}

function save(patch) {
  const next = { ...load(), ...patch }
  delete next.undefined
  cached = next
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch (e) {
    console.error('settings save failed:', e)
  }
  if (typeof module_autoStartHook === 'function') module_autoStartHook(next)
  return next
}

let module_autoStartHook = null
function onAutoStart(fn) {
  module_autoStartHook = fn
}

module.exports = { get, save, onAutoStart, DEFAULTS }
