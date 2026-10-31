// 界面预览 / 截图工具
//
// 用途：不开托盘、不连服务，把某个 html 用假数据渲染出来再 capturePage 存图，
// 用于人工核对排版（尤其是原生截图抓不到 GPU 合成层的情况）。
//
// 用法：
//   npx electron tools/preview.js account.html out.png rock anon
//   npx electron tools/preview.js account.html out.png paper user
//
// 参数：<html 文件名> <输出 png> [主题] [状态]

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

const [, , page = 'account.html', out = 'preview.png', theme = 'rock', state = 'anon', w = '460', h = '660'] = process.argv

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: parseInt(w, 10),
    height: parseInt(h, 10),
    show: false,
    backgroundColor: theme === 'paper' ? '#F6F3EC' : '#1A1C22',
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      // 状态经启动参数传给 preload（改 process.env 不会传到已经 fork 的渲染进程）
      additionalArguments: ['--ww-preview-state=' + state, '--ww-preview-plan=' + (process.env.WW_PREVIEW_PLAN || 'pro')],
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', page), { query: { theme } })
  // 等 boot() 里那次 await 和一次布局
  await new Promise((r) => setTimeout(r, 700))

  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('saved', out, img.getSize().width + 'x' + img.getSize().height)
  app.quit()
})
