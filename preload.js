const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kisd', {
  scrape:         (credentials) => ipcRenderer.invoke('scrape', credentials),
  onMfaRequired:  (cb)          => ipcRenderer.on('mfa-required', cb),
  submitMfaCode:  (code)        => ipcRenderer.send('mfa-submit', code),
});
