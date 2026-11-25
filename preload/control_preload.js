const {contextBridge, ipcRenderer} = require('electron');

const INVOKE_CHANNELS = new Set([
    'settings:get',
    'auth-tokens:get',
    'accounts:get',
    'auth:da-login',
    'auth:dx-save',
    'auth:logout',
    'donation:get-statuses'
]);

const SEND_CHANNELS = new Set([
    'settings:set',
    'control:toggle',
    'goal:activate',
    'goal:deactivate',
    'auth:dx-open-settings'
]);

const RECEIVE_CHANNELS = new Set([
    'settings:update',
    'goal:status',
    'donation:status',
    'auth-tokens:changed',
    'accounts:update'
]);

function ensure(set, channel) {
    if (!set.has(channel)) throw new Error(`Канал ${channel} недоступен`);
}

contextBridge.exposeInMainWorld('controlBridge', {
    invoke: (channel, ...args) => {
        ensure(INVOKE_CHANNELS, channel);
        return ipcRenderer.invoke(channel, ...args);
    },
    send: (channel, ...args) => {
        ensure(SEND_CHANNELS, channel);
        ipcRenderer.send(channel, ...args);
    },
    on: (channel, callback) => {
        ensure(RECEIVE_CHANNELS, channel);
        ipcRenderer.on(channel, (_event, ...args) => callback(null, ...args));
    }
});
