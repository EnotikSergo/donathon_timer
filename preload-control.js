const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('controlAPI', {
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  toggleVisibility: () => ipcRenderer.send('toggle-control-visibility')
});
