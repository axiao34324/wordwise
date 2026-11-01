const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('todoApi', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  // 窗口开着时在别处又收了新条目：主进程会发这个，页面收到就重绘
  onChanged: (cb) => ipcRenderer.on('todo:changed', () => cb()),

  list: (opts) => ipcRenderer.invoke('todo:list', opts || {}),
  update: (id, patch) => ipcRenderer.invoke('todo:update', { id, patch }),
  remove: (id) => ipcRenderer.invoke('todo:remove', id),
  purgeArchived: () => ipcRenderer.invoke('todo:purge'),
  addList: (name) => ipcRenderer.invoke('todo:addList', name),
  removeList: (id) => ipcRenderer.invoke('todo:removeList', id),
  exportMd: () => ipcRenderer.invoke('todo:export'),

  openChat: (text) => ipcRenderer.send('ww:openChat', text),

  recap: (id) => ipcRenderer.send('todo:recap', id),
  onRecapDelta: (cb) => ipcRenderer.on('todo:recapDelta', (_e, d) => cb(d)),
  onRecapDone: (cb) => ipcRenderer.on('todo:recapDone', (_e, d) => cb(d)),
  onRecapError: (cb) => ipcRenderer.on('todo:recapError', (_e, d) => cb(d))
})
