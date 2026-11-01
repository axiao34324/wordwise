// 取当前前台窗口的标题
//
// 用途：加待办时顺手记下"这段文字是从哪个窗口来的"。
// selection-hook 只给程序名（chrome.exe），给不了标题（那篇文章叫什么），
// 而标题恰恰是几天后能把这条待办认出来的关键。
//
// 为什么用 PowerShell 而不是加原生依赖：
//   只需要一个 GetWindowText，为它引入 node-gyp 编译的原生模块不划算。
//   代价是每次约 0.6–1.5 秒，所以只在点「＋待办」时异步跑一次，从不阻塞界面。
//
// 失败一律返回 null —— 拿不到标题不影响待办本身，宁可没有来源，也不要假来源。

const { execFile } = require('child_process')

const PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WWFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
Add-Type -TypeDefinition $sig
$h = [WWFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][WWFg]::GetWindowTextW($h, $sb, 512)
[uint32]$procId = 0
[void][WWFg]::GetWindowThreadProcessId($h, [ref]$procId)
$name = ''
try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
[Console]::Out.Write($sb.ToString() + "\`n" + $name)
`

// -EncodedCommand 走 base64(UTF-16LE)，绕开引号/换行/中文在命令行上的转义问题
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64')

// 我们自己（Electron / 打包后的 WordWise.exe）拿到前台就说明这次没取到目标窗口
const SELF = /^(electron|wordwise)/

function capture() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const lines = String(stdout || '').split(/\r?\n/)
        const title = (lines[0] || '').trim()
        const proc = (lines[1] || '').trim().toLowerCase()
        if (!title || title.length < 2) return resolve(null)
        if (proc && SELF.test(proc)) return resolve(null)
        resolve({ title: title.slice(0, 300), process: proc })
      }
    )
  })
}

module.exports = { capture }
