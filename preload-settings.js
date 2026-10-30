const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:getRaw'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  openChat: () => ipcRenderer.send('ww:openChatHistory')
})
