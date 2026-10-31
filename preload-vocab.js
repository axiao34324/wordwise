const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vocabApi', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  list: (filter) => ipcRenderer.invoke('vocab:list', filter),
  remove: (w) => ipcRenderer.invoke('vocab:remove', w),
  clear: () => ipcRenderer.invoke('vocab:clear'),
  exportCsv: () => ipcRenderer.invoke('vocab:export')
})
