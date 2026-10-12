const {app, BrowserWindow, ipcMain, shell} = require('electron');
const {startOverlayServer} = require('./overlay_server');
const fs1 = require('fs');
const path1 = require('path');

const settingsFilePath = path1.join(__dirname, 'saves/settings.json');
const tokensFilePath = path1.join(__dirname, 'saves/auth_tokens.json');

function readAuthTokens() {
    try {
        if (fs1.existsSync(tokensFilePath)) {
            return JSON.parse(fs1.readFileSync(tokensFilePath, 'utf8'));
        }
    } catch (e) {
        console.error('[auth] Не удалось прочитать токены:', e);
    }
    return {};
}

let overlay;
let timerWin = null;
let controlWin = null;

let settings = {
    donationModeEnabled: true,
    sleepModeEnabled: false,
    secondsAddedPerCurrency: 3.6,
    showRubPerHour: true,
    dynamicPriceIncreaseEnabled: true,
    maxTimerTier: 0,
    baseRubPerHour: 1000,
    dynamicPriceStep: 1000
};

if (fs1.existsSync(settingsFilePath)) {
    try {
        const savedSettings = JSON.parse(fs1.readFileSync(settingsFilePath, 'utf8'));
        settings = Object.assign(settings, savedSettings);

        if (typeof savedSettings.maxTimerTier !== 'undefined') {
            settings.maxTimerTier = savedSettings.maxTimerTier;
        }
    } catch (e) {
        console.error("Не удалось прочесть файл настроек:", e);
    }

}

function createWindows() {
    timerWin = new BrowserWindow({
        width: 800,
        height: 450,
        title: 'NikiWright Timer',
        autoHideMenuBar: true,
        webPreferences: {
            backgroundThrottling: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    timerWin.loadFile('index.html');

    controlWin = new BrowserWindow({
        width: 520,
        height: 520,
        title: 'Timer Control',
        autoHideMenuBar: true,
        resizable: false,
        show: false,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
            backgroundThrottling: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    controlWin.loadFile('control.html');

    ipcMain.handle('settings:get', () => settings);
    ipcMain.on('settings:set', (_evt, partial) => {
        settings = Object.assign(settings, partial || {});
        try {
            const dataToSave = {
                dynamicPriceIncreaseEnabled: settings.dynamicPriceIncreaseEnabled,
                maxTimerTier: settings.maxTimerTier,
                baseRubPerHour: settings.baseRubPerHour,
                dynamicPriceStep: settings.dynamicPriceStep
            };
            fs1.writeFileSync(settingsFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        } catch (e) {
            console.error("Не удалось сохранить настройки:", e);
        }

        if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('settings:update', settings);
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('settings:update', settings);
    });

    ipcMain.on('control:toggle', () => {
        if (!controlWin || controlWin.isDestroyed()) return;
        if (controlWin.isVisible()) controlWin.hide(); else controlWin.show();
    });

    timerWin.on('closed', () => {
        try {
            if (controlWin && !controlWin.isDestroyed()) controlWin.close();
        } catch (e) {}
        timerWin = null;
        controlWin = null;
    });

    timerWin.webContents.once('did-finish-load', () => {
        timerWin.webContents.send('settings:update', settings);
    });
    controlWin.webContents.once('did-finish-load', () => {
        controlWin.webContents.send('settings:update', settings);
    });

    ipcMain.handle('auth-tokens:get', () => readAuthTokens());

    ipcMain.handle('auth-tokens:save', (_e, payload) => {
        if (!payload || !payload.service) return false;

        const all = readAuthTokens();
        all[payload.service] = (payload.token || '').trim();

        try {
            fs1.writeFileSync(tokensFilePath, JSON.stringify(all, null, 2), 'utf8');

            if (timerWin && !timerWin.isDestroyed()) {
                timerWin.webContents.send('auth-tokens:updated');
            }

            return true;
        } catch (e) {
            console.error('[auth] Не удалось сохранить токен:', e);
            return false;
        }
    });

    ipcMain.on('auth-tokens:request', (_e, service) => {
        if (service === 'donationAlerts') {
            const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=21868&redirect_uri=http://localhost:41701/auth/da&response_type=token&scope=oauth-user-show%20oauth-donation-subscribe`;
            shell.openExternal(authUrl);
        } else {
            let url = "";
            if (service === 'donateX') url = 'https://donatex.gg/streamer/settings';
            else if (service === 'trula') url = 'https://trula.io/lk/widgets/control-panel';
            if (url) shell.openExternal(url);
        }
    });
}

app.whenReady().then(() => {
    overlay = startOverlayServer({
        port: process.env.OVERLAY_PORT || 41701,
        host: '0.0.0.0',
        basePath: '/overlay',
        onAuth: (service, token) => {
            console.log(`[Auth] Получен токен для сервиса: ${service}`);

            const all = readAuthTokens();
            all[service] = token;
            try {
                fs1.writeFileSync(tokensFilePath, JSON.stringify(all, null, 2), 'utf8');
            } catch (e) {
                console.error('[Auth] Ошибка сохранения токена:', e);
            }

            if (controlWin && !controlWin.isDestroyed()) {
                controlWin.webContents.send('auth-token-received', { service, token });
            }

            if (timerWin && !timerWin.isDestroyed()) {
                timerWin.webContents.send('auth-tokens:updated');
            }
        }
    });
    createWindows();
});

ipcMain.on('donation:status', (_e, data) => {
    if (controlWin && !controlWin.isDestroyed()) {
        controlWin.webContents.send('donation:status', data);
    }
});

ipcMain.on('overlay:state', (_, state) => {
    try {
        overlay && overlay.push(state);
    } catch {
    }
});
ipcMain.on('overlay:event', (_, event) => {
    overlay.pushEvent(event);
});

ipcMain.on('goal:activate', (event, data) => {
    if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('goal:activate', data);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', true);
});

ipcMain.on('goal:deactivate', () => {
    if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('goal:deactivate');
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', false);
});

ipcMain.on('goal:ended', () => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', false);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
