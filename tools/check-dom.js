// 一次性 DOM 断言工具：加载某个 html，跑一段表达式并把结果打到 stdout。
// 用法：npx electron tools/check-dom.js settings.html "表达式" [状态]
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

const [, , page = 'settings.html', expr = '1', state = 'user'] = process.argv

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      additionalArguments: ['--ww-preview-state=' + state, '--ww-preview-plan=' + (process.env.WW_PREVIEW_PLAN || 'pro')],
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', page), { query: { theme: 'rock' } })
  await new Promise((r) => setTimeout(r, 800))
  const out = await win.webContents.executeJavaScript(expr)
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
  app.quit()
})
