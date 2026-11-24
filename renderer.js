const {app, BrowserWindow, ipcMain, shell, safeStorage} = require('electron');
const {startOverlayServer} = require('./overlay_server');
const fs1 = require('fs');
const path1 = require('path');
const {writeFileAtomic, readTextFile} = require('./js/lib/storage');

const AUTH_SERVICES = ['donationAlerts', 'donateX'];

const savesDir = path1.join(app.getPath('userData'), 'saves');
const legacySavesDir = path1.join(__dirname, 'saves');
const storagePaths = {
    settings: path1.join(savesDir, 'settings.json'),
    tokens: path1.join(savesDir, 'auth_tokens.json'),
    timer: path1.join(savesDir, 'timer_value.txt'),
    stopwatch: path1.join(savesDir, 'stopwatch_save.txt'),
    migration: path1.join(savesDir, 'migration.json')
};
const settingsFilePath = storagePaths.settings;
const tokensFilePath = storagePaths.tokens;

function migrateLegacySaves() {
    if (fs1.existsSync(storagePaths.migration)) return;

    const files = ['settings.json', 'auth_tokens.json', 'timer_value.txt', 'stopwatch_save.txt'];
    const copied = [];
    for (const name of files) {
        const target = path1.join(savesDir, name);
        try {
            if (fs1.existsSync(target)) continue;
            const data = readTextFile(path1.join(legacySavesDir, name));
            if (data === null) continue;
            writeFileAtomic(target, data);
            copied.push(name);
        } catch (e) {
            console.error(`[storage] Не удалось перенести ${name}:`, e);
        }
    }

    try {
        writeFileAtomic(storagePaths.migration, JSON.stringify({
            from: legacySavesDir,
            copied,
            at: new Date().toISOString()
        }, null, 2));
        if (copied.length) console.log(`[storage] Сохранения перенесены в ${savesDir}: ${copied.join(', ')}`);
    } catch (e) {
        console.error('[storage] Не удалось записать отметку о переносе:', e);
    }
}

function pickKnownTokens(obj) {
    const result = {};
    for (const service of AUTH_SERVICES) {
        if (obj && typeof obj[service] === 'string' && obj[service]) result[service] = obj[service];
    }
    return result;
}

function canEncrypt() {
    try {
        return app.isReady() && safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

function readTokensFile() {
    const raw = readTextFile(tokensFilePath);
    if (raw === null) return {tokens: {}, encrypted: false};

    const parsed = JSON.parse(raw);
    if (parsed && parsed.encrypted === true) {
        if (!canEncrypt()) throw new Error('Шифрование недоступно, токены прочитать нельзя');
        const json = safeStorage.decryptString(Buffer.from(parsed.data, 'base64'));
        return {tokens: pickKnownTokens(JSON.parse(json)), encrypted: true};
    }
    return {tokens: pickKnownTokens(parsed), encrypted: false};
}

function readAuthTokens() {
    try {
        return readTokensFile().tokens;
    } catch (e) {
        console.error('[auth] Не удалось прочитать токены:', e);
        return {};
    }
}

function writeAuthTokens(all) {
    const tokens = pickKnownTokens(all);
    const payload = canEncrypt()
        ? {
            version: 1,
            encrypted: true,
            data: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
        }
        : tokens;
    writeFileAtomic(tokensFilePath, JSON.stringify(payload, null, 2));
}

function updateAuthToken(service, token) {
    const {tokens} = readTokensFile();
    tokens[service] = token;
    writeAuthTokens(tokens);
}

function upgradeTokensStorage() {
    try {
        const {tokens, encrypted} = readTokensFile();
        if (!encrypted && canEncrypt() && fs1.existsSync(tokensFilePath)) {
            writeAuthTokens(tokens);
            console.log('[auth] Токены зашифрованы');
        }
    } catch (e) {
        console.error('[auth] Не удалось обновить хранилище токенов:', e);
    }
}

migrateLegacySaves();

const OVERLAY_PORT = Number(process.env.OVERLAY_PORT || 41701);

let overlay = null;
let overlayHost = null;
let timerWin = null;
let controlWin = null;

const DEFAULT_SETTINGS = {
    donationModeEnabled: true,
    sleepModeEnabled: false,
    secondsAddedPerCurrency: 3.6,
    showRubPerHour: true,
    dynamicPriceIncreaseEnabled: false,
    maxTimerTier: 0,
    baseRubPerHour: 1000,
    dynamicPriceStep: 500,
    lanAccessEnabled: false
};

let settings = Object.assign({}, DEFAULT_SETTINGS);

try {
    const raw = readTextFile(settingsFilePath);
    if (raw !== null) settings = Object.assign(settings, JSON.parse(raw));
} catch (e) {
    console.error("Не удалось прочесть файл настроек:", e);
}

(function recalcSecondsPerCurrency() {
    const base = Number(settings.baseRubPerHour) > 0 ? Number(settings.baseRubPerHour) : 1000;
    const step = Number(settings.dynamicPriceStep) > 0 ? Number(settings.dynamicPriceStep) : 1000;
    const tier = Number(settings.maxTimerTier) > 0 ? Number(settings.maxTimerTier) : 0;
    const effective = settings.dynamicPriceIncreaseEnabled ? (base + tier * step) : base;
    settings.secondsAddedPerCurrency = 3600 / effective;
})();

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
                dynamicPriceStep: settings.dynamicPriceStep,
                lanAccessEnabled: !!settings.lanAccessEnabled
            };
            writeFileAtomic(settingsFilePath, JSON.stringify(dataToSave, null, 2));
        } catch (e) {
            console.error("Не удалось сохранить настройки:", e);
        }

        if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('settings:update', settings);
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('settings:update', settings);

        if (partial && typeof partial.lanAccessEnabled !== 'undefined') applyOverlayHost();
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
    ipcMain.on('auth-tokens:get-sync', (e) => {
        e.returnValue = readAuthTokens();
    });
    ipcMain.on('storage:paths-sync', (e) => {
        e.returnValue = {timer: storagePaths.timer, stopwatch: storagePaths.stopwatch};
    });

    ipcMain.handle('auth-tokens:save', (_e, payload) => {
        if (!payload || !AUTH_SERVICES.includes(payload.service)) return false;

        try {
            updateAuthToken(payload.service, (payload.token || '').trim());

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
        } else if (service === 'donateX') {
            shell.openExternal('https://donatex.gg/streamer/settings');
        }
    });
}

function handleAuthFromOverlay(service, token) {
    console.log(`[Auth] Получен токен для сервиса: ${service}`);

    try {
        updateAuthToken(service, token);
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

let overlayRestart = Promise.resolve();

function applyOverlayHost() {
    const host = settings.lanAccessEnabled ? '0.0.0.0' : '127.0.0.1';
    if (overlay && overlayHost === host) return overlayRestart;

    overlayRestart = overlayRestart.then(async () => {
        if (overlay && overlayHost === host) return;
        if (overlay) {
            const old = overlay;
            overlay = null;
            await old.close();
        }
        overlayHost = host;
        overlay = startOverlayServer({
            port: OVERLAY_PORT,
            host,
            basePath: '/overlay',
            onAuth: handleAuthFromOverlay
        });
    }).catch((e) => console.error('[overlay] Не удалось перезапустить сервер:', e));
    return overlayRestart;
}

app.whenReady().then(() => {
    upgradeTokensStorage();
    applyOverlayHost();
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
    try {
        overlay && overlay.pushEvent(event);
    } catch {
    }
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
