const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('accountApi', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  state: () => ipcRenderer.invoke('account:state'),
  register: (email, password) => ipcRenderer.invoke('account:register', { email, password }),
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password }),
  refresh: () => ipcRenderer.invoke('account:refresh'),
  redeem: (code) => ipcRenderer.invoke('account:redeem', code),
  logout: () => ipcRenderer.invoke('account:logout')
})
