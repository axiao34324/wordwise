const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('accountApi', {
  onTheme: (cb) => ipcRenderer.on('ww:theme', (_e, t) => cb(t)),
  onOauthResult: (cb) => ipcRenderer.on('account:oauthResult', (_e, d) => cb(d)),
  state: () => ipcRenderer.invoke('account:state'),
  plans: () => ipcRenderer.invoke('account:plans'),
  sendCode: (email) => ipcRenderer.invoke('account:sendCode', email),
  verifyCode: (email, code) => ipcRenderer.invoke('account:verifyCode', { email, code }),
  loginPassword: (email, password) => ipcRenderer.invoke('account:loginPassword', { email, password }),
  oauthStart: (provider) => ipcRenderer.invoke('account:oauthStart', provider),
  refresh: () => ipcRenderer.invoke('account:refresh'),
  redeem: (code) => ipcRenderer.invoke('account:redeem', code),
  logout: () => ipcRenderer.invoke('account:logout')
})
