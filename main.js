const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, clipboard, dialog, nativeTheme } = require('electron')
const path = require('path')
const SelectionHook = require('selection-hook')

const store = require('./lib/store')
const cache = require('./lib/cache')
const llm = require('./lib/llm')
const official = require('./lib/official')
const account = require('./lib/account')
const convs = require('./lib/conversations')
const vocab = require('./lib/vocab')
const todos = require('./lib/todos')
const foreground = require('./lib/foreground')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // 允许用 `WordWise.exe --account` 从快捷方式直接打开账号页
    if ((argv || []).includes('--account')) return openAccount()
    if ((argv || []).includes('--todo')) return openTodo()
    openSettings()
  })
}

app.isQuitting = false
// 沙箱环境下 GPU 子进程会访问违例崩溃（0xC0000005），导致全屏无合成输出；
// in-process-gpu 让合成在主进程内完成，彻底解决黑/白屏
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

let tray = null
let popup = null
let settingsWin = null
let chatWin = null
let chatCtrl = null
let vocabWin = null
let todoWin = null
let accountWin = null
let todoCtrl = null
let hook = null
let rebuildTray = null

let debounceTimer = null
let hideTimer = null
let pendingCtrl = null
let popupReady = false

let lastText = null
let lastAt = 0
let currentSel = null

const POPUP_W = 360
const POPUP_H_DEFAULT = 112

// 窗口加载时带上当前主题，避免首帧闪烁
function themeQuery() {
  return { query: { theme: store.get().theme || 'rock' } }
}

// 各主题的窗口底色：用于原生标题栏明暗与窗口背景（避免浅色主题下边框仍是深色）
const THEME_BG = { rock: '#1A1C22', paper: '#F6F3EC', graphite: '#0B0B0C', celadon: '#0F1A17' }

function themeBg(theme) {
  return THEME_BG[theme] || THEME_BG.rock
}

function applyNativeTheme(theme) {
  const t = THEME_BG[theme] ? theme : 'rock'
  // Windows 原生标题栏随之变亮/变暗
  nativeTheme.themeSource = t === 'paper' ? 'light' : 'dark'
  const bg = themeBg(t)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try { w.setBackgroundColor(bg) } catch (_) {}
  }
}

function broadcastTheme(theme) {
  applyNativeTheme(theme)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try { w.webContents.send('ww:theme', theme) } catch (_) {}
  }
}

function getIcon() {
  const p = path.join(__dirname, 'assets', 'icon.png')
  try {
    return nativeImage.createFromPath(p)
  } catch {
    return nativeImage.createEmpty()
  }
}

function attachDiagnostics(win, tag) {
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log('[ww:' + tag + '] console(' + level + '):', String(message).slice(0, 200), source + ':' + line)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[ww:' + tag + '] did-fail-load', code, desc, url)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[ww:' + tag + '] render-process-gone', JSON.stringify(details))
  })
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error('[ww:' + tag + '] preload-error', p, String(err))
  })
  win.webContents.on('did-finish-load', async () => {
    try {
      const text = await win.webContents.executeJavaScript(
        'document.body ? document.body.innerText.slice(0,150) : "<no body>"'
      )
      console.log('[ww:' + tag + '] did-finish-load, body text:', JSON.stringify(text))
    } catch (e) {
      console.error('[ww:' + tag + '] execJS failed:', String(e))
    }
  })
}

function createPopupWindow() {
  popup = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H_DEFAULT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  popup.setAlwaysOnTop(true, 'screen-saver')
  attachDiagnostics(popup, 'popup')
  popup.loadFile(path.join(__dirname, 'popup.html'), themeQuery())
  popup.on('ready-to-show', () => { popupReady = true })
  popup.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      popup.hide()
    }
  })
}

function showPopupAt(x, y) {
  if (!popup) return
  if (!popupReady) return
  const size = popup.getSize()
  const w = POPUP_W
  const h = size[1] || POPUP_H_DEFAULT
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
  const wa = display.workArea
  let px = x + 14
  let py = y + 18
  if (px + w > wa.x + wa.width) px = wa.x + wa.width - w - 8
  if (px < wa.x) px = wa.x + 8
  if (py + h > wa.y + wa.height) py = y - h - 18
  if (py < wa.y) py = wa.y + 8
  popup.setPosition(Math.round(px), Math.round(py))
  popup.show()
  popup.setAlwaysOnTop(true, 'screen-saver')
  scheduleHide()
}

function hidePopup() {
  clearTimeout(hideTimer)
  if (popup && popup.isVisible()) popup.hide()
}

function scheduleHide(overrideSec) {
  clearTimeout(hideTimer)
  const s = store.get()
  const sec = overrideSec || s.hideAfterSec || 15
  hideTimer = setTimeout(hidePopup, Math.max(3, sec) * 1000)
}

function abortPending() {
  if (pendingCtrl) {
    try { pendingCtrl.abort('new-selection') } catch (_) {}
    pendingCtrl = null
  }
}

function isDisabledApp(programName, list) {
  if (!programName || !Array.isArray(list) || list.length === 0) return false
  const pn = String(programName).toLowerCase()
  return list.some((raw) => {
    const item = String(raw || '').trim().toLowerCase()
    if (!item) return false
    return pn.includes(item)
  })
}

// 判断是否值得收进英语词库：纯英文（可含空格/连字符/撇号），1-3 个词，≤40 字符
function isEnglishWord(text) {
  const t = String(text || '').trim()
  if (t.length < 2 || t.length > 40) return false
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t)) return false // 含中日韩字符或全角符号
  if (!/^[A-Za-z][A-Za-z'’\-\s]*$/.test(t)) return false // 只允许字母/撇号/连字符/空格
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length < 1 || parts.length > 3) return false
  return parts.every((p) => /^[A-Za-z][A-Za-z'’\-]*$/.test(p))
}

function handleSelection(data) {
  const s = store.get()
  if (!s.enabled) return
  // 官方通道不需要用户填 key；只有自带 Key 模式才必须配好
  if (s.provider === 'byok' && !s.apiKey) return
  const text = String((data && data.text) || '').trim()
  if (!text || text.length < 2 || text.length > (s.maxLen || 300)) return
  if (isDisabledApp(data.programName, s.disabledApps)) return

  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => trigger(text, data), Math.max(80, s.autoPopupMs || 220))
}

function validPos(p) {
  return !!p && typeof p.x === 'number' && typeof p.y === 'number' && p.x > 0 && p.y > 0
}

function pickPosition(data) {
  if (data) {
    if (validPos(data.endBottom)) return data.endBottom
    if (validPos(data.mousePosEnd)) return data.mousePosEnd
    if (validPos(data.endTop)) return data.endTop
    if (validPos(data.mousePosStart)) return data.mousePosStart
  }
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width / 2, y: wa.y + wa.height / 3 }
}

function trigger(text, data) {
  const s = store.get()
  const now = Date.now()
  const threshold = Math.max(2, s.longTextThreshold || 15)
  const isLong = text.length > threshold
  const hit = cache.get('explain::' + text)
  // 冷却只拦 API 重复调用；短词有缓存则照弹不误
  const cooldownMs = Math.max(5, s.cooldownSec || 60) * 1000
  if (text === lastText && now - lastAt < cooldownMs && !hit) return
  lastText = text
  lastAt = now

  abortPending()

  // selection-hook 返回物理像素坐标，Electron 窗口定位用 DIP，按目标屏缩放因子换算
  const raw = pickPosition(data)
  const scale = screen.getDisplayNearestPoint({ x: Math.round(raw.x), y: Math.round(raw.y) }).scaleFactor || 1
  const pos = { x: Math.round(raw.x / scale), y: Math.round(raw.y / scale) }
  console.log('[ww] popup at', JSON.stringify(pos), '(raw', JSON.stringify(raw), 'scale', scale + ')')

  currentSel = { text, pos, app: String((data && data.programName) || '') }
  showPopupAt(pos.x, pos.y)

  const send = (ch, payload) => {
    try { popup.webContents.send(ch, payload) } catch (_) {}
  }

  if (isLong) {
    // 长文本：先给动作选项，不消耗 API；选择窗给更长的停留时间
    console.log('[ww] long text (' + text.length + ' > ' + threshold + '), show chooser')
    send('ww:choose', { text, chars: text.length, threshold, actions: llm.ACTIONS, isWord: isEnglishWord(text) })
    scheduleHide(Math.max(30, s.hideAfterSec || 15))
    return
  }

  runAction('explain', text)
}

// 统一执行入口：短词（explain）与用户选中的长文本动作共用
// 决定本次请求用哪套接口配置与模型
//   official（默认）—— 官方通道，接口地址与密钥内置在 lib/official.js
//   byok             —— 用户自己的 OpenAI 兼容服务
function llmTarget(s, action) {
  if (s.provider === 'byok') {
    return {
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: action === 'explain' ? s.model : s.actionModel || s.model
    }
  }
  return {
    baseUrl: official.BASE_URL,
    apiKey: official.APP_TOKEN,
    // 转发服务挂在分享网关后面，Authorization 会被网关消费，改用自定义头
    authHeader: 'x-wordwise-key',
    // 登录用户的身份令牌：带上它走个人额度，不带就是匿名额度
    token: account.token(),
    model:
      action === 'explain'
        ? s.officialModel || official.MODEL
        : s.officialActionModel || official.ACTION_MODEL
  }
}

function runAction(action, text) {
  const s = store.get()
  const target = llmTarget(s, action)
  const model = target.model
  const send = (ch, payload) => {
    try { popup.webContents.send(ch, payload) } catch (_) {}
  }
  const key = action + '::' + text
  const isWord = isEnglishWord(text)
  const hit = cache.get(key)
  if (hit) {
    send('ww:result', { text, action, result: hit.v, cached: true, model, isWord })
    return
  }

  abortPending()

  // 官方通道只对登录用户开放。先在这里拦掉，省一次注定 401 的往返。
  if (s.provider !== 'byok' && !account.token()) {
    send('ww:error', {
      message: '官方通道需要登录；不登录的话，可以在设置里选「自带 Key」用自己的服务',
      code: 'auth_required'
    })
    return
  }

  send('ww:loading', { text, action, isWord })
  pendingCtrl = new AbortController()
  llm.explain({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    authHeader: target.authHeader,
    token: target.token,
    model,
    action,
    systemPrompt: s.systemPrompt,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    text,
    timeoutSec: s.timeoutSec,
    ctrl: pendingCtrl,
    onDelta: (d) => send('ww:delta', d),
    onDone: (r) => {
      cache.set(key, r)
      send('ww:done', { model })
      // 服务端已计数，本地也 +1，让托盘与账号页的用量立刻对上
      account.bumpLocal()
      if (rebuildTray) rebuildTray()
    },
    onError: (e) =>
      send('ww:error', {
        message: String((e && e.message) || e),
        // 额度用完 / 需要订阅 时，弹窗可以就地给一个「去登录」的口子
        code: (e && e.code) || ''
      })
  })
}

function initHook() {
  hook = new SelectionHook()

  hook.on('text-selection', (data) => {
    if (data && data.text) {
      console.log('[ww] selection:', String(data.text).slice(0, 30), '| prog:', data.programName, '| method:', data.method)
      console.log('[ww] pos:', JSON.stringify({ eb: data.endBottom, et: data.endTop, ms: data.mousePosStart, me: data.mousePosEnd, pl: data.posLevel }))
      handleSelection(data)
    }
  })

  hook.on('error', (e) => {
    console.error('[ww] hook error:', e)
  })

  hook.on('mouse-down', (e) => {
    if (!popup || !popup.isVisible()) return
    if (!e || typeof e.x !== 'number') return
    const [px, py] = popup.getPosition()
    const [pw, ph] = popup.getSize()
    // 钩子坐标是物理像素，窗口位置/尺寸是 DIP，必须先换算再比对，
    // 否则点击弹窗内的按钮会被误判为"点在外面"而被提前隐藏（点击丢失）
    const scale = screen.getDisplayNearestPoint({ x: px, y: py }).scaleFactor || 1
    const x = e.x / scale
    const y = e.y / scale
    const inside = x >= px && x <= px + pw && y >= py && y <= py + ph
    if (!inside) hidePopup()
  })

  hook.start({ enableClipboard: true })
  console.log('[ww] hook started, enabled =', store.get().enabled, ', apiKey set =', !!store.get().apiKey)
}

function createTray() {
  const icon = getIcon()
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('WordWise 划词释义')

  const rebuild = () => {
    const s = store.get()
    const a = account.state()
    let openN = 0
    try { openN = todos.countOpen() } catch (_) { openN = 0 }
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: s.enabled ? '暂停划词释义' : '启用划词释义', click: () => { store.save({ enabled: !s.enabled }); rebuild(); if (!store.get().enabled) hidePopup() } },
        { type: 'separator' },
        {
          label: a.loggedIn
            ? '账号与订阅（' + (a.planLabel || '免费版') + ' · 今日 ' + (a.used || 0) + '/' + (a.dailyLimit || 0) + '）'
            : '账号与订阅（未登录）',
          click: () => openAccount()
        },
        { label: '历史对话…', click: () => openChat({}, true) },
        { label: '英语词库…', click: () => openVocab() },
        { label: openN ? '待办（' + openN + ' 条未完成）…' : '待办…', click: () => openTodo() },
        { label: '设置…', click: () => openSettings() },
        { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
      ])
    )
  }
  rebuild()
  // 额度会随使用变化，主进程在每次请求结束后刷新一次托盘文案
  rebuildTray = rebuild
  tray.on('double-click', () => openSettings())
}

// ---- 对话窗口：划词内容作为上下文，多轮追问，历史可回顾 ----
function openChat(seed, showHistory) {
  let conv = null
  if (seed && seed.convId) conv = convs.get(seed.convId)
  if (!conv && seed && seed.text) conv = convs.findByText(seed.text) || convs.create(seed.text)
  if (!conv) {
    const list = convs.summaries()
    conv = list.length ? convs.get(list[0].id) : convs.create('')
  }

  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show()
    chatWin.focus()
    try { chatWin.webContents.send('chat:load', conv.id) } catch (_) {}
    if (showHistory) {
      try { chatWin.webContents.send('chat:showHistory') } catch (_) {}
    }
    return
  }

  chatWin = new BrowserWindow({
    width: 440,
    height: 600,
    minWidth: 360,
    minHeight: 400,
    title: 'WordWise 对话',
    backgroundColor: themeBg(store.get().theme),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-chat.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(chatWin, 'chat')
  chatWin.loadFile(path.join(__dirname, 'chat.html'), themeQuery())
  const targetId = conv.id
  chatWin.webContents.once('did-finish-load', () => {
    try { chatWin.webContents.send('chat:load', targetId) } catch (_) {}
    if (showHistory) {
      try { chatWin.webContents.send('chat:showHistory') } catch (_) {}
    }
  })
  chatWin.on('closed', () => {
    chatWin = null
    if (chatCtrl) { try { chatCtrl.abort('window-closed') } catch (_) {} chatCtrl = null }
  })
}

function openVocab() {
  if (vocabWin && !vocabWin.isDestroyed()) {
    vocabWin.show()
    vocabWin.focus()
    return
  }
  vocabWin = new BrowserWindow({
    width: 480,
    height: 620,
    minWidth: 380,
    minHeight: 380,
    title: 'WordWise 英语词库',
    backgroundColor: themeBg(store.get().theme),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-vocab.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(vocabWin, 'vocab')
  vocabWin.loadFile(path.join(__dirname, 'vocab.html'), themeQuery())
  vocabWin.on('closed', () => { vocabWin = null })
}

function openTodo() {
  if (todoWin && !todoWin.isDestroyed()) {
    todoWin.show()
    todoWin.focus()
    // 窗口开着的时候可能在别处又收了几条，回来重绘一次
    try { todoWin.webContents.send('todo:changed') } catch (_) {}
    return
  }
  todoWin = new BrowserWindow({
    width: 540,
    height: 720,
    minWidth: 420,
    minHeight: 420,
    title: 'WordWise 待办',
    backgroundColor: themeBg(store.get().theme),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-todo.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(todoWin, 'todo')
  todoWin.loadFile(path.join(__dirname, 'todo.html'), themeQuery())
  todoWin.on('closed', () => {
    todoWin = null
    if (todoCtrl) { try { todoCtrl.abort('window-closed') } catch (_) {} todoCtrl = null }
  })
}

function openAccount() {
  if (accountWin && !accountWin.isDestroyed()) {
    accountWin.show()
    accountWin.focus()
    // 从别的入口再次打开时，让页面重跑一次 boot()，拿到最新额度
    try { accountWin.webContents.send('ww:theme', store.get().theme) } catch (_) {}
    try { accountWin.webContents.reload() } catch (_) {}
    return
  }
  accountWin = new BrowserWindow({
    width: 460,
    height: 660,
    minWidth: 380,
    minHeight: 480,
    title: 'WordWise 账号',
    autoHideMenuBar: true,
    backgroundColor: themeBg(store.get().theme),
    webPreferences: {
      preload: path.join(__dirname, 'preload-account.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(accountWin, 'account')
  accountWin.loadFile(path.join(__dirname, 'account.html'), themeQuery())
  accountWin.on('closed', () => {
    accountWin = null
    if (rebuildTray) rebuildTray()
  })
}

function openSettings() {
  console.log('[ww] openSettings called')
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 800,
    title: 'WordWise 设置',
    autoHideMenuBar: true,
    backgroundColor: themeBg(store.get().theme),
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(settingsWin, 'settings')
  settingsWin.loadFile(path.join(__dirname, 'settings.html'), themeQuery())
  settingsWin.on('closed', () => { settingsWin = null })
}

app.whenReady().then(() => {
  const s = store.get()
  cache.load()
  convs.load()
  // 启动即按已保存主题设置原生标题栏明暗，避免浅色主题下首帧仍是深色标题栏
  applyNativeTheme(s.theme)
  app.setLoginItemSettings({ openAtLogin: !!s.autoStart })
  store.onAutoStart((next) => {
    app.setLoginItemSettings({ openAtLogin: !!next.autoStart })
  })

  createPopupWindow()
  createTray()
  try {
    initHook()
  } catch (e) {
    dialog.showErrorBox('WordWise', '全局划词初始化失败：' + e.message)
  }

  // 已登录的话后台静默拉一次额度，把托盘文案更新成真实值；
  // 官方通道开箱即用，不再像自带 Key 时代那样首次启动就弹设置页。
  if (account.token()) {
    account.refresh().then((r) => {
      if (r.ok && rebuildTray) rebuildTray()
    })
  }

  // `--account` 直接开账号页：方便做桌面快捷方式，也方便排查登录问题
  if (process.argv.includes('--account')) openAccount()
  // 同理，`--todo` 直接开待办（也是自测入口：能确认窗口、preload、IPC 全通）
  if (process.argv.includes('--todo')) openTodo()
})

app.on('before-quit', () => {
  app.isQuitting = true
  abortPending()
  if (hook) {
    try { hook.stop(); hook.cleanup() } catch (_) {}
  }
})

app.on('window-all-closed', (e) => {
  // 不退出，驻留托盘
})

ipcMain.on('ww:resize', (_e, height) => {
  if (!popup || typeof height !== 'number') return
  const h = Math.max(72, Math.min(460, Math.round(height)))
  const [w] = popup.getSize()
  popup.setSize(w, h)
  const [px, py] = popup.getPosition()
  const display = screen.getDisplayNearestPoint({ x: px, y: py })
  const wa = display.workArea
  if (py + h > wa.y + wa.height) {
    popup.setPosition(px, Math.max(wa.y, wa.y + wa.height - h - 8))
  }
  scheduleHide()
})

ipcMain.on('ww:close', () => hidePopup())

ipcMain.on('ww:action', (_e, action) => {
  if (!currentSel) return
  const a = typeof action === 'string' && action ? action : 'explain'
  console.log('[ww] action:', a, '| len:', currentSel.text.length)
  runAction(a, currentSel.text)
})

ipcMain.on('ww:copy', (_e, text) => {
  if (typeof text === 'string' && text) clipboard.writeText(text)
})

// ---- 英语词库 ----
ipcMain.on('ww:addVocab', (_e, payload) => {
  const word = String((payload && payload.word) || '').trim()
  const def = String((payload && payload.def) || '').trim()
  if (!word) return
  const r = vocab.add(word, def)
  console.log('[ww:vocab] add', word, '| added =', r.added, '| total =', r.count)
  try { popup.webContents.send('ww:vocabResult', { word, ...r }) } catch (_) {}
})

ipcMain.on('ww:openVocab', () => openVocab())

// ---- 待办 ----
//
// 与词库最大的不同：加待办不需要先把内容看懂，也不消耗额度。
// 所以这里只做两件事 —— 把选中文字抄下来、把来源记下来，然后立刻回话。
ipcMain.on('ww:openTodo', () => openTodo())

function notifyTodoChanged() {
  if (todoWin && !todoWin.isDestroyed()) {
    try { todoWin.webContents.send('todo:changed') } catch (_) {}
  }
  if (rebuildTray) rebuildTray()
}

ipcMain.on('ww:addTodo', (_e, payload) => {
  if (!currentSel) return
  const def = String((payload && payload.def) || '')
  const r = todos.add({
    text: currentSel.text,
    def,
    source: { app: currentSel.app || '' }
  })
  try { popup.webContents.send('ww:todoResult', r) } catch (_) {}
  notifyTodoChanged()
  if (!r.item) return

  // 窗口标题异步补。这一步要起一次 PowerShell（约 1 秒），
  // 绝不能挡在按钮反馈前面，所以先回话、后补字段。
  const id = r.item.id
  foreground
    .capture()
    .then((f) => {
      if (!f || !f.title) return
      todos.update(id, { source: { title: f.title } })
      notifyTodoChanged()
    })
    .catch(() => {})
})

ipcMain.handle('todo:list', (_e, opts) => todos.list(opts || {}))
ipcMain.handle('todo:stats', () => todos.stats())
ipcMain.handle('todo:update', (_e, p) => {
  const it = todos.update((p && p.id) || '', (p && p.patch) || {})
  if (rebuildTray) rebuildTray()
  return it
})
ipcMain.handle('todo:remove', (_e, id) => {
  todos.remove(id)
  notifyTodoChanged()
  return true
})
ipcMain.handle('todo:purge', () => {
  const removed = todos.purgeArchived()
  notifyTodoChanged()
  return { removed }
})
ipcMain.handle('todo:addList', (_e, name) => todos.addList(name))
ipcMain.handle('todo:removeList', (_e, id) => {
  todos.removeList(id)
  notifyTodoChanged()
  return true
})
ipcMain.handle('todo:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出待办',
    defaultPath: 'wordwise-todo.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try {
    require('fs').writeFileSync(filePath, todos.toMarkdown(), 'utf8')
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

// 「回顾一下」：用户几天后打开待办时，只剩一个碎片，想不起为什么存它。
// 这里才真正调用模型 —— 加待办永远不花额度，回顾才花，由用户自己决定值不值。
const RECAP_PROMPT =
  '用户在阅读时摘下一段文字存进了待办，现在回来想知道它值不值得深入。' +
  '用中文写三句话，每句一行、以「· 」开头：' +
  '第一句说这段在讲什么（不要复述原话，直接给判断）；' +
  '第二句说它大概属于哪个领域或脉络，可以跟什么放在一起看；' +
  '第三句给一个具体可执行的深挖方向（查什么、读谁、看哪一面）。' +
  '不要客套，不要标题，不要评价这段话写得好不好。'

ipcMain.on('todo:recap', (_e, id) => {
  const it = todos.find(String(id || ''))
  const push = (ch, d) => {
    if (todoWin && !todoWin.isDestroyed()) {
      try { todoWin.webContents.send(ch, d) } catch (_) {}
    }
  }
  if (!it) return

  const s = store.get()
  if (s.provider !== 'byok' && !account.token()) {
    push('todo:recapError', {
      id,
      message: '官方通道需要登录；不登录的话，可以在设置里选「自带 Key」用自己的服务',
      code: 'auth_required'
    })
    return
  }

  const target = llmTarget(s, 'recap')
  if (todoCtrl) { try { todoCtrl.abort('new-recap') } catch (_) {} }
  todoCtrl = new AbortController()

  let user = '【原文】\n"""\n' + it.text + '\n"""'
  if (it.note) user += '\n\n【我当时的备注】\n' + it.note
  if (it.source && it.source.title) user += '\n\n【来自】\n' + it.source.title

  console.log('[ww:todo] recap', it.id, '| len =', it.text.length, '| model =', target.model)
  llm.explain({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    authHeader: target.authHeader,
    token: target.token,
    model: target.model,
    messages: [
      { role: 'system', content: RECAP_PROMPT },
      { role: 'user', content: user }
    ],
    temperature: 0.5,
    maxTokens: 420,
    timeoutSec: s.timeoutSec,
    ctrl: todoCtrl,
    onDelta: (d) => push('todo:recapDelta', { id, chunk: d }),
    onDone: (r) => {
      push('todo:recapDone', { id, text: r })
      account.bumpLocal()
      if (rebuildTray) rebuildTray()
    },
    onError: (err) =>
      push('todo:recapError', {
        id,
        message: String((err && err.message) || err),
        code: (err && err.code) || ''
      })
  }).finally(() => { todoCtrl = null })
})

// ---- 账号与订阅 ----
ipcMain.on('ww:openAccount', () => openAccount())
ipcMain.handle('account:state', () => account.state())
ipcMain.handle('account:register', async (_e, payload) => {
  const r = await account.register(
    String((payload && payload.email) || '').trim(),
    String((payload && payload.password) || '')
  )
  if (r.ok) {
    // 等服务端累计一个真实的 user 对象再回界面，避免额度显示成 0/0
    const m = await account.refresh()
    if (m.ok) r.user = m.user
    if (rebuildTray) rebuildTray()
  }
  return r
})
ipcMain.handle('account:login', async (_e, payload) => {
  const r = await account.login(
    String((payload && payload.email) || '').trim(),
    String((payload && payload.password) || '')
  )
  if (r.ok) {
    const m = await account.refresh()
    if (m.ok) r.user = m.user
    if (rebuildTray) rebuildTray()
  }
  return r
})
ipcMain.handle('account:refresh', async () => {
  const r = await account.refresh()
  if (rebuildTray) rebuildTray()
  return r
})
ipcMain.handle('account:redeem', async (_e, code) => {
  const r = await account.redeem(String(code || '').trim())
  if (r.ok && rebuildTray) rebuildTray()
  return r
})
ipcMain.handle('account:logout', () => {
  account.logout()
  if (rebuildTray) rebuildTray()
  return true
})

ipcMain.handle('account:plans', () => account.plans())
ipcMain.handle('account:sendCode', (_e, email) => account.sendCode(String(email || '').trim()))
ipcMain.handle('account:verifyCode', async (_e, payload) => {
  const r = await account.verifyCode(String((payload && payload.email) || '').trim(), String((payload && payload.code) || '').trim())
  if (r.ok) {
    const m = await account.refresh()
    if (m.ok) r.user = m.user
    if (rebuildTray) rebuildTray()
  }
  return r
})
ipcMain.handle('account:loginPassword', async (_e, payload) => {
  const r = await account.login(
    String((payload && payload.email) || '').trim(),
    String((payload && payload.password) || '')
  )
  if (r.ok) {
    const m = await account.refresh()
    if (m.ok) r.user = m.user
    if (rebuildTray) rebuildTray()
  }
  return r
})

// 微信 / QQ：开一个授权窗口，回调页把 token 放在 window.__WW_AUTH__ 里
ipcMain.handle('account:oauthStart', async (_e, provider) => {
  const p = provider === 'qq' ? 'qq' : 'wechat'
  const url = account.oauthStartUrl(p)
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    title: 'WordWise 登录',
    autoHideMenuBar: true,
    backgroundColor: themeBg(store.get().theme),
    parent: accountWin && !accountWin.isDestroyed() ? accountWin : undefined,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false }
  })

  const finish = (result) => {
    if (!win.isDestroyed()) win.close()
    // 把结果推回账号页
    if (accountWin && !accountWin.isDestroyed()) {
      try { accountWin.webContents.send('account:oauthResult', result) } catch (_) {}
    }
  }

  win.webContents.on('did-finish-load', async () => {
    let r = null
    try {
      r = await win.webContents.executeJavaScript('window.__WW_AUTH__ || null')
    } catch (_) {
      r = null
    }
    if (!r) return // 还在第三方页面上，继续等
    if (r.ok && r.token) {
      const got = await account.adoptToken(r.token)
      if (got.ok) {
        if (rebuildTray) rebuildTray()
        finish({ ok: true })
      } else {
        finish({ ok: false, error: got.error || '登录态校验失败' })
      }
    } else {
      finish({ ok: false, error: r.error || '登录失败' })
    }
  })

  win.loadURL(url).catch((err) => {
    finish({ ok: false, error: '打不开授权页：' + String((err && err.message) || err) })
  })
  return { ok: true }
})

ipcMain.handle('vocab:list', (_e, filter) => vocab.list(filter))
ipcMain.handle('vocab:count', () => vocab.count())
ipcMain.handle('vocab:remove', (_e, w) => {
  vocab.remove(w)
  return vocab.list('')
})
ipcMain.handle('vocab:clear', () => {
  vocab.clear()
  return vocab.list('')
})
ipcMain.handle('vocab:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出词库',
    defaultPath: 'wordwise-vocab.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try {
    require('fs').writeFileSync(filePath, '\ufeff' + vocab.toCSV(), 'utf8')
    return { ok: true, path: filePath, count: vocab.count() }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('settings:get', () => ({ ...store.get(), apiKey: store.get().apiKey ? '____set____' : '' }))
ipcMain.handle('settings:getRaw', () => store.get())
ipcMain.handle('settings:save', (_e, patch) => {
  const clean = { ...patch }
  if (clean.apiKey === '____set____') delete clean.apiKey
  const before = store.get().theme
  store.save(clean)
  const theme = store.get().theme
  if (theme && theme !== before) broadcastTheme(theme)
  return store.get()
})

// ---- 对话窗口 ----
ipcMain.on('ww:openChat', (_e, text) => {
  console.log('[ww] openChat, text len =', String(text || '').length)
  openChat({ text: String(text || '') })
})

ipcMain.on('ww:openChatHistory', () => {
  console.log('[ww] openChatHistory')
  openChat({}, true)
})

ipcMain.handle('chat:get', (_e, id) => convs.get(id))
ipcMain.handle('chat:list', () => convs.summaries())
ipcMain.handle('chat:new', (_e, text) => convs.create(text))
ipcMain.handle('chat:delete', (_e, id) => {
  convs.remove(id)
  return convs.summaries()
})

ipcMain.on('chat:send', (_e, payload) => {
  const convId = payload && payload.convId
  const content = String((payload && payload.content) || '').trim()
  const conv = convs.get(convId)
  if (!conv || !content) return
  const s = store.get()

  convs.addMessage(convId, 'user', content)
  if (chatCtrl) { try { chatCtrl.abort('new-turn') } catch (_) {} }
  chatCtrl = new AbortController()

  // 划词文本必须作为独立的 user 消息注入，并跟一轮 assistant 确认。
  // 只放进 system 当"描述"时，模型会把它当元指令，反而回答"我看不到你划的内容"
  const sys =
    '你是阅读助手。用户在应用里划选了一段文本并交给了你，文本在下一条消息中，已完整提供。' +
    '回答简洁直接、重点突出；不要复述原文，不要客套，不要使用「根据您提供的文本」这类套话。'
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: '【我划选的文本】\n"""\n' + conv.text + '\n"""' },
    { role: 'assistant', content: '已收到，请问。' },
    ...convs.get(convId).messages.map((m) => ({ role: m.role, content: m.content }))
  ]

  const push = (ch, d) => {
    if (chatWin && !chatWin.isDestroyed()) {
      try { chatWin.webContents.send(ch, d) } catch (_) {}
    }
  }

  // 同 runAction：官方通道未登录直接给指引，不发请求
  if (s.provider !== 'byok' && !account.token()) {
    push('chat:error', {
      message: '官方通道需要登录；不登录的话，可以在设置里选「自带 Key」用自己的服务',
      code: 'auth_required'
    })
    return
  }

  const target = llmTarget(s, 'chat')
  console.log('[ww:chat] send, turns =', messages.length - 1, '| model =', target.model)
  llm.explain({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    authHeader: target.authHeader,
    token: target.token,
    model: target.model,
    messages,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    timeoutSec: s.timeoutSec,
    ctrl: chatCtrl,
    onDelta: (d) => push('chat:delta', d),
    onDone: (r) => {
      convs.setLastAssistant(convId, r)
      push('chat:done', { content: r })
      account.bumpLocal()
      if (rebuildTray) rebuildTray()
    },
    onError: (err) =>
      push('chat:error', {
        message: String((err && err.message) || err),
        code: (err && err.code) || ''
      })
  }).finally(() => { chatCtrl = null })
})
