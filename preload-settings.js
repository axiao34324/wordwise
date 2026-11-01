const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsApi', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  get: () => ipcRenderer.invoke('settings:getRaw'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  openChat: () => ipcRenderer.send('ww:openChatHistory'),
  openVocab: () => ipcRenderer.send('ww:openVocab'),
  openTodo: () => ipcRenderer.send('ww:openTodo'),
  openAccount: () => ipcRenderer.send('ww:openAccount'),
  accountState: () => ipcRenderer.invoke('account:state'),
  vocabCount: () => ipcRenderer.invoke('vocab:count'),
  todoStats: () => ipcRenderer.invoke('todo:stats')
})
