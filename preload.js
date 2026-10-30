const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ww', {
  onChoose: (cb) => ipcRenderer.on('ww:choose', (_e, d) => cb(d)),
  onLoading: (cb) => ipcRenderer.on('ww:loading', (_e, d) => cb(d)),
  onResult: (cb) => ipcRenderer.on('ww:result', (_e, d) => cb(d)),
  onDelta: (cb) => ipcRenderer.on('ww:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('ww:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('ww:error', (_e, d) => cb(d)),
  choose: (action) => ipcRenderer.send('ww:action', action),
  openChat: (text) => ipcRenderer.send('ww:openChat', text),
  resize: (h) => ipcRenderer.send('ww:resize', h),
  close: () => ipcRenderer.send('ww:close'),
  copy: (t) => ipcRenderer.send('ww:copy', t)
})
