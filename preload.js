const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kisd', {
  scrape:               (credentials) => ipcRenderer.invoke('scrape', credentials),
  onMfaRequired:        (cb)          => ipcRenderer.on('mfa-required', cb),
  submitMfaCode:        (code)        => ipcRenderer.send('mfa-submit', code),
  getSavedCredentials:  ()            => ipcRenderer.invoke('get-saved-credentials'),
  logout:               ()            => ipcRenderer.invoke('logout'),
  clearSession:         ()            => ipcRenderer.invoke('clear-session'),
  openExternal:         (url)         => ipcRenderer.invoke('open-external', url),
});
