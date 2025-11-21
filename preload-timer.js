const { contextBridge, ipcRenderer } = require('electron');
ipcRenderer.on('applySettings', (_e, settings) => {
  try {
    window.dispatchEvent(new CustomEvent('applySettings', { detail: settings }));
  } catch (err) {
    console.error('applySettings dispatch failed', err);
  }
});
