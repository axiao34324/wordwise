const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, clipboard, dialog } = require('electron')
const path = require('path')
const SelectionHook = require('selection-hook')

const store = require('./lib/store')
const cache = require('./lib/cache')
const llm = require('./lib/llm')

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
let hook = null

let debounceTimer = null
let hideTimer = null
let pendingCtrl = null
let popupReady = false

let lastText = null
let lastAt = 0

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

function scheduleHide() {
  clearTimeout(hideTimer)
  const s = store.get()
  hideTimer = setTimeout(hidePopup, Math.max(3, s.hideAfterSec || 15) * 1000)
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
  const hit = cache.get(text)
  // 冷却只拦 API 重复调用；有缓存则照弹不误
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

  const send = (ch, payload) => {
    try { popup.webContents.send(ch, payload) } catch (_) {}
  }

  showPopupAt(pos.x, pos.y)
  if (hit) {
    send('ww:result', { text, result: hit.v, cached: true, model: s.model })
    return
  }

  send('ww:loading', { text })
  pendingCtrl = new AbortController()
  llm.explain({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.model,
    systemPrompt: s.systemPrompt,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    text,
    timeoutSec: s.timeoutSec,
    ctrl: pendingCtrl,
    onDelta: (d) => send('ww:delta', d),
    onDone: (r) => {
      cache.set(text, r)
      send('ww:done', { model: s.model })
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
    if (e.x < px || e.x > px + pw || e.y < py || e.y > py + ph) {
      hidePopup()
    }
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
        { label: '设置…', click: () => openSettings() },
        { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
      ])
    )
  }
  rebuild()
  tray.on('double-click', () => openSettings())
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
  const h = Math.max(72, Math.min(360, Math.round(height)))
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
