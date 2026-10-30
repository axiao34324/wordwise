const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatApi', {
  onLoad: (cb) => ipcRenderer.on('chat:load', (_e, id) => cb(id)),
  onShowHistory: (cb) => ipcRenderer.on('chat:showHistory', () => cb()),
  onDelta: (cb) => ipcRenderer.on('chat:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
  get: (id) => ipcRenderer.invoke('chat:get', id),
  list: () => ipcRenderer.invoke('chat:list'),
  newConv: (text) => ipcRenderer.invoke('chat:new', text),
  remove: (id) => ipcRenderer.invoke('chat:delete', id),
  send: (convId, content) => ipcRenderer.send('chat:send', { convId, content })
})
