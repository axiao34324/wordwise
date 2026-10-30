const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, clipboard, dialog } = require('electron')
const path = require('path')
const SelectionHook = require('selection-hook')

const store = require('./lib/store')
const cache = require('./lib/cache')
const llm = require('./lib/llm')
const convs = require('./lib/conversations')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
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
let hook = null

let debounceTimer = null
let hideTimer = null
let pendingCtrl = null
let popupReady = false

let lastText = null
let lastAt = 0
let currentSel = null

const POPUP_W = 360
const POPUP_H_DEFAULT = 132

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
  popup.loadFile(path.join(__dirname, 'popup.html'))
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

function handleSelection(data) {
  const s = store.get()
  if (!s.enabled) return
  if (!s.apiKey) return
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

  currentSel = { text, pos }
  showPopupAt(pos.x, pos.y)

  const send = (ch, payload) => {
    try { popup.webContents.send(ch, payload) } catch (_) {}
  }

  if (isLong) {
    // 长文本：先给动作选项，不消耗 API；选择窗给更长的停留时间
    console.log('[ww] long text (' + text.length + ' > ' + threshold + '), show chooser')
    send('ww:choose', { text, chars: text.length, threshold, actions: llm.ACTIONS })
    scheduleHide(Math.max(30, s.hideAfterSec || 15))
    return
  }

  runAction('explain', text)
}

// 统一执行入口：短词（explain）与用户选中的长文本动作共用
function runAction(action, text) {
  const s = store.get()
  // 短词释义用主模型（ultraspeed，快）；长文本动作默认用 flash（长文本更省更快）
  const model = action === 'explain' ? s.model : (s.actionModel || s.model)
  const send = (ch, payload) => {
    try { popup.webContents.send(ch, payload) } catch (_) {}
  }
  const key = action + '::' + text
  const hit = cache.get(key)
  if (hit) {
    send('ww:result', { text, action, result: hit.v, cached: true, model })
    return
  }

  abortPending()
  send('ww:loading', { text, action })
  pendingCtrl = new AbortController()
  llm.explain({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
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
    },
    onError: (e) => send('ww:error', { message: String((e && e.message) || e) })
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
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: s.enabled ? '暂停划词释义' : '启用划词释义', click: () => { store.save({ enabled: !s.enabled }); rebuild(); if (!store.get().enabled) hidePopup() } },
        { type: 'separator' },
        { label: '历史对话…', click: () => openChat({}, true) },
        { label: '设置…', click: () => openSettings() },
        { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
      ])
    )
  }
  rebuild()
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
    backgroundColor: '#1A1C22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-chat.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(chatWin, 'chat')
  chatWin.loadFile(path.join(__dirname, 'chat.html'))
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

function openSettings() {
  console.log('[ww] openSettings called')
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 800,
    title: 'WordWise 设置',
    autoHideMenuBar: true,
    backgroundColor: '#1A1C22',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  attachDiagnostics(settingsWin, 'settings')
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

app.whenReady().then(() => {
  const s = store.get()
  cache.load()
  convs.load()
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

  if (!s.apiKey) {
    openSettings()
  }
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

ipcMain.handle('settings:get', () => ({ ...store.get(), apiKey: store.get().apiKey ? '____set____' : '' }))
ipcMain.handle('settings:getRaw', () => store.get())
ipcMain.handle('settings:save', (_e, patch) => {
  const clean = { ...patch }
  if (clean.apiKey === '____set____') delete clean.apiKey
  store.save(clean)
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

  const sys =
    '用户在阅读时划选了下面这段文本，后续问题都围绕它展开：\n"""\n' +
    conv.text +
    '\n"""\n\n请结合这段文本回答用户的问题。回答简洁直接、重点突出；不要复述原文，不要客套，不要使用「根据您提供的文本」这类套话。'
  const messages = [
    { role: 'system', content: sys },
    ...convs.get(convId).messages.map((m) => ({ role: m.role, content: m.content }))
  ]

  const push = (ch, d) => {
    if (chatWin && !chatWin.isDestroyed()) {
      try { chatWin.webContents.send(ch, d) } catch (_) {}
    }
  }

  console.log('[ww:chat] send, turns =', messages.length - 1, '| model =', s.actionModel || s.model)
  llm.explain({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.actionModel || s.model,
    messages,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    timeoutSec: s.timeoutSec,
    ctrl: chatCtrl,
    onDelta: (d) => push('chat:delta', d),
    onDone: (r) => {
      convs.setLastAssistant(convId, r)
      push('chat:done', { content: r })
    },
    onError: (err) => push('chat:error', { message: String((err && err.message) || err) })
  }).finally(() => { chatCtrl = null })
})
