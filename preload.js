const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ww', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  onChoose: (cb) => ipcRenderer.on('ww:choose', (_e, d) => cb(d)),
  onLoading: (cb) => ipcRenderer.on('ww:loading', (_e, d) => cb(d)),
  onResult: (cb) => ipcRenderer.on('ww:result', (_e, d) => cb(d)),
  onDelta: (cb) => ipcRenderer.on('ww:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('ww:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('ww:error', (_e, d) => cb(d)),
  choose: (action) => ipcRenderer.send('ww:action', action),
  openChat: (text) => ipcRenderer.send('ww:openChat', text),
  openAccount: () => ipcRenderer.send('ww:openAccount'),
  addVocab: (word, def) => ipcRenderer.send('ww:addVocab', { word, def }),
  onVocabResult: (cb) => ipcRenderer.on('ww:vocabResult', (_e, d) => cb(d)),
  resize: (h) => ipcRenderer.send('ww:resize', h),
  close: () => ipcRenderer.send('ww:close'),
  copy: (t) => ipcRenderer.send('ww:copy', t)
})
