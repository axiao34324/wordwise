const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  enabled: true,
  baseUrl: 'https://api.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.6-pro-ultraspeed',
  systemPrompt: '解析用户输入的词句。用中文解释，严格控制在200字以内。直接输出释义本身，不要任何前缀、引号、标题或额外解释。',
  temperature: 0.3,
  maxTokens: 800,
  maxLen: 300,
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
