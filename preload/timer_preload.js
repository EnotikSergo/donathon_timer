const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('timerBridge', {
    getState: () => ipcRenderer.invoke('timer:get-state'),
    onState: (callback) => {
        ipcRenderer.on('timer:state', (_event, state) => callback(state));
    },
    onEvent: (callback) => {
        ipcRenderer.on('timer:event', (_event, data) => callback(data));
    },
    command: (name) => ipcRenderer.send('timer:command', String(name)),
    toggleControl: () => ipcRenderer.send('control:toggle'),
    setPriceLabel: (label) => ipcRenderer.send('timer:set-price-label', label)
});
