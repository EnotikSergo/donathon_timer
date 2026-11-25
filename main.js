const {app, BrowserWindow, ipcMain, shell, safeStorage, net} = require('electron');
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const {handleSquirrelEvent} = require('./squirrel_startup');
const {writeFileAtomic, readTextFile, removeFile} = require('./core/storage');
const {createTokenStore, AUTH_SERVICES} = require('./core/token_store');
const {createSettingsStore} = require('./core/settings_store');
const {createAuthManager} = require('./core/auth_manager');
const {createTimerCore} = require('./core/timer_core');
const {createDonationAlerts} = require('./core/donations/donation_alerts');
const {createDonateX} = require('./core/donations/donatex');
const {startOverlayServer} = require('./core/overlay_server');

const isSquirrelEvent = handleSquirrelEvent(app);
const hasInstanceLock = isSquirrelEvent ? false : app.requestSingleInstanceLock();
const isPrimary = !isSquirrelEvent && hasInstanceLock;

if (!isSquirrelEvent && !hasInstanceLock) app.quit();

const OVERLAY_PORT = Number(process.env.OVERLAY_PORT || C.OVERLAY_PORT);
const CONTROL_SETTINGS = ['donationModeEnabled', 'sleepModeEnabled', 'showRubPerHour', 'dynamicPriceIncreaseEnabled',
    'baseRubPerHour', 'dynamicPriceStep', 'lanAccessEnabled'];
const TIMER_COMMANDS = new Set(['addSmall', 'addLarge', 'subtractSmall', 'subtractLarge', 'togglePause', 'reset']);

const savesDir = path.join(app.getPath('userData'), 'saves');
const legacySavesDir = path.join(__dirname, 'saves');
const paths = {
    settings: path.join(savesDir, 'settings.json'),
    tokens: path.join(savesDir, 'auth_tokens.json'),
    authMeta: path.join(savesDir, 'auth_meta.json'),
    timer: path.join(savesDir, 'timer_value.txt'),
    stopwatch: path.join(savesDir, 'stopwatch_save.txt'),
    donatexState: path.join(savesDir, 'donatex_state.json'),
    migration: path.join(savesDir, 'migration.json')
};

function readJson(file, fallback) {
    try {
        const raw = readTextFile(file);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
        console.error(`[storage] Не удалось прочитать ${path.basename(file)}:`, e);
        return fallback;
    }
}

function writeJson(file, data) {
    writeFileAtomic(file, JSON.stringify(data, null, 2));
}

function migrateLegacySaves() {
    if (fs.existsSync(paths.migration)) return;

    const copied = [];
    for (const name of ['settings.json', 'auth_tokens.json', 'timer_value.txt', 'stopwatch_save.txt']) {
        const target = path.join(savesDir, name);
        try {
            if (fs.existsSync(target)) continue;
            const data = readTextFile(path.join(legacySavesDir, name));
            if (data === null) continue;
            writeFileAtomic(target, data);
            copied.push(name);
        } catch (e) {
            console.error(`[storage] Не удалось перенести ${name}:`, e);
        }
    }

    try {
        writeJson(paths.migration, {from: legacySavesDir, copied, at: new Date().toISOString()});
        if (copied.length) console.log(`[storage] Сохранения перенесены в ${savesDir}: ${copied.join(', ')}`);
    } catch (e) {
        console.error('[storage] Не удалось записать отметку о переносе:', e);
    }
}

if (isPrimary) migrateLegacySaves();

function httpGetJson(url, headers = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = net.request({url, method: 'GET'});
        for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);
        request.setHeader('Accept', 'application/json');

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            try {
                request.abort();
            } catch {
            }
            finish(reject, new Error('timeout'));
        }, timeoutMs);

        request.on('response', (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                }
                finish(resolve, {status: response.statusCode, json});
            });
            response.on('error', (e) => finish(reject, e));
        });
        request.on('error', (e) => finish(reject, e));
        request.end();
    });
}

let timerWin = null;
let controlWin = null;
let overlay = null;
let overlayHost = null;
let overlayRestart = Promise.resolve();
let servicesStarted = false;

const sendTo = (win, channel, data) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

const settingsStore = createSettingsStore({path: paths.settings});
const tokenStore = createTokenStore({
    tokensPath: paths.tokens,
    metaPath: paths.authMeta,
    safeStorage,
    isReady: () => app.isReady()
});

let tokens = {};
const donationStatuses = {DA: 'disconnected', DX: 'disconnected'};

const timerCore = createTimerCore({
    settings: settingsStore,
    storage: {
        loadTimer: () => readTextFile(paths.timer),
        saveTimer: (text) => writeFileAtomic(paths.timer, text),
        removeTimer: () => removeFile(paths.timer),
        loadStopwatch: () => readTextFile(paths.stopwatch),
        saveStopwatch: (seconds) => writeFileAtomic(paths.stopwatch, String(seconds)),
        removeStopwatch: () => removeFile(paths.stopwatch)
    },
    onState: (state) => {
        sendTo(timerWin, 'timer:state', state);
        if (overlay) overlay.push(state);
    },
    onEvent: (event) => {
        sendTo(timerWin, 'timer:event', event);
        if (overlay) overlay.pushEvent(event);
    },
    onGoalChange: (active) => sendTo(controlWin, 'goal:status', active)
});

function makeStatusHandler(system) {
    return (status) => {
        donationStatuses[system] = status;
        sendTo(controlWin, 'donation:status', {system, status});
    };
}

const donationHandlers = {
    onDonation: (amount) => timerCore.addDonation(amount),
    isDonationModeEnabled: () => !!settingsStore.get().donationModeEnabled
};

const donationAlerts = createDonationAlerts({
    ...donationHandlers,
    getToken: () => tokens.donationAlerts || '',
    onStatus: makeStatusHandler('DA'),
    onAuthInvalid: () => authManager.verify('donationAlerts')
});

const donateX = createDonateX({
    ...donationHandlers,
    getToken: () => tokens.donateX || '',
    onStatus: makeStatusHandler('DX'),
    onAuthInvalid: () => authManager.verify('donateX'),
    state: {
        load: () => readJson(paths.donatexState, null),
        save: (data) => writeJson(paths.donatexState, data)
    }
});

const services = {donationAlerts, donateX};

function refreshTokens() {
    const previous = tokens;
    tokens = tokenStore.read();
    for (const service of AUTH_SERVICES) {
        if (servicesStarted && (previous[service] || '') !== (tokens[service] || '')) services[service].restart();
    }
    sendTo(controlWin, 'auth-tokens:changed', tokens);
}

const authManager = createAuthManager({
    tokens: {
        read: () => tokenStore.read(),
        update: (service, token) => tokenStore.update(service, token),
        remove: (service) => tokenStore.remove(service)
    },
    meta: {
        read: () => tokenStore.readMeta(),
        write: (data) => tokenStore.writeMeta(data)
    },
    httpGetJson,
    openExternal: (url) => shell.openExternal(url),
    overlayPort: OVERLAY_PORT,
    onChange: (accounts) => sendTo(controlWin, 'accounts:update', accounts),
    onTokensChanged: refreshTokens
});

settingsStore.onChange((settings, changed) => {
    sendTo(controlWin, 'settings:update', settings);
    if (changed.includes('lanAccessEnabled')) applyOverlayHost();
});

function applyOverlayHost() {
    const host = settingsStore.get().lanAccessEnabled ? '0.0.0.0' : '127.0.0.1';
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
            basePath: C.OVERLAY_BASE_PATH,
            overlayDir: path.join(__dirname, 'view'),
            authPagePath: path.join(__dirname, 'auth', 'auth_success.html'),
            isAuthPending: (service) => authManager.isAuthPending(service),
            onAuthCallback: (_service, payload) => authManager.handleDaCallback(payload)
        });
        overlay.push(timerCore.getSnapshot());
    }).catch((e) => console.error('[overlay] Не удалось перезапустить сервер:', e));
    return overlayRestart;
}

const LEGACY_STORAGE_SCRIPT = `(() => {
    try {
        const get = (key) => localStorage.getItem(key);
        return {
            dxLastProcessed: get('dx_last_processed_ts'),
            dxProcessedIds: get('dx_processed_ids'),
            rubLeft: get('rubTextLeft'),
            rubTop: get('rubTextTop'),
            rubFontSize: get('rubTextFontSize')
        };
    } catch (e) {
        return null;
    }
})()`;

async function migrateLegacyLocalStorage(webContents) {
    const marker = readJson(paths.migration, {});
    if (marker.localStorageMigrated) return;

    let legacy = null;
    try {
        legacy = await webContents.executeJavaScript(LEGACY_STORAGE_SCRIPT, true);
    } catch (e) {
        console.error('[storage] Не удалось прочитать данные прежней версии окна:', e);
    }

    if (legacy) {
        try {
            if (!fs.existsSync(paths.donatexState) && legacy.dxLastProcessed) {
                let ids = [];
                try {
                    ids = JSON.parse(legacy.dxProcessedIds || '[]');
                } catch {
                }
                writeJson(paths.donatexState, {
                    lastProcessedTimestamp: Number(legacy.dxLastProcessed),
                    processedIds: Array.isArray(ids) ? ids.map(String) : []
                });
            }
            if (!settingsStore.get().rubLabel && (legacy.rubLeft || legacy.rubFontSize)) {
                settingsStore.update({
                    rubLabel: {
                        left: legacy.rubLeft || null,
                        top: legacy.rubTop || null,
                        fontSize: legacy.rubFontSize ? Number(legacy.rubFontSize) : null
                    }
                });
            }
        } catch (e) {
            console.error('[storage] Не удалось перенести данные прежней версии окна:', e);
        }
    }

    try {
        writeJson(paths.migration, {...readJson(paths.migration, {}), localStorageMigrated: true});
    } catch (e) {
        console.error('[storage] Не удалось записать отметку о переносе:', e);
    }
}

function startServices() {
    if (servicesStarted) return;
    servicesStarted = true;
    donationAlerts.start();
    donateX.start();
}

const SECURE_WEB_PREFERENCES = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false
};

function createWindows() {
    timerWin = new BrowserWindow({
        width: 800,
        height: 450,
        title: 'NikiWright Timer',
        autoHideMenuBar: true,
        webPreferences: {...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, 'preload', 'timer_preload.js')}
    });
    timerWin.loadFile(path.join(__dirname, 'view', 'index.html'));

    controlWin = new BrowserWindow({
        width: 520,
        height: 520,
        title: 'Timer Control',
        autoHideMenuBar: true,
        resizable: false,
        show: false,
        frame: false,
        skipTaskbar: true,
        webPreferences: {...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, 'preload', 'control_preload.js')}
    });
    controlWin.loadFile(path.join(__dirname, 'control', 'control.html'));

    const timerContents = timerWin.webContents;
    timerContents.once('did-finish-load', () => {
        migrateLegacyLocalStorage(timerContents).finally(startServices);
    });

    timerWin.on('closed', () => {
        try {
            if (controlWin && !controlWin.isDestroyed()) controlWin.close();
        } catch {
        }
        timerWin = null;
        controlWin = null;
    });
}

function isTrustedSender(event) {
    const url = event && event.senderFrame && event.senderFrame.url;
    return !url || url.startsWith('file://');
}

function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error('Недоверенный источник');
        return fn(...args);
    });
}

function on(channel, fn) {
    ipcMain.on(channel, (event, ...args) => {
        if (isTrustedSender(event)) fn(...args);
    });
}

function registerIpcHandlers() {
    handle('timer:get-state', () => timerCore.getSnapshot());
    on('timer:command', (name) => {
        if (TIMER_COMMANDS.has(name)) timerCore.command(name);
    });
    on('timer:set-price-label', (label) => settingsStore.update({rubLabel: label}));

    on('control:toggle', () => {
        if (!controlWin || controlWin.isDestroyed()) return;
        if (controlWin.isVisible()) controlWin.hide();
        else controlWin.show();
    });

    handle('settings:get', () => settingsStore.get());
    on('settings:set', (partial) => {
        const allowed = {};
        for (const key of CONTROL_SETTINGS) {
            if (partial && key in partial) allowed[key] = partial[key];
        }
        settingsStore.update(allowed);
    });

    on('goal:activate', (data) => timerCore.activateGoal(data && data.hours));
    on('goal:deactivate', () => timerCore.deactivateGoal());

    handle('donation:get-statuses', () => ({...donationStatuses}));

    handle('auth-tokens:get', () => tokenStore.read());
    handle('accounts:get', () => authManager.getAccounts());
    handle('auth:da-login', () => authManager.startDaLogin());
    handle('auth:dx-save', (token) => authManager.saveDxToken(token));
    handle('auth:logout', (service) => authManager.logout(service));
    on('auth:dx-open-settings', () => authManager.openDxSettings());
}

app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({action: 'deny'}));
    contents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) event.preventDefault();
    });
});

app.on('second-instance', () => {
    if (timerWin && !timerWin.isDestroyed()) {
        if (timerWin.isMinimized()) timerWin.restore();
        timerWin.focus();
    }
});

app.whenReady().then(() => {
    if (!isPrimary) return;
    registerIpcHandlers();
    tokenStore.upgradeEncryption();
    tokens = tokenStore.read();
    timerCore.start();
    applyOverlayHost();
    createWindows();
    authManager.init();
});

app.on('activate', () => {
    if (!isPrimary) return;
    if (!timerWin || timerWin.isDestroyed()) createWindows();
});

let shutDown = false;
app.on('before-quit', () => {
    if (!isPrimary || shutDown) return;
    shutDown = true;
    timerCore.stop();
    settingsStore.flush();
    donationAlerts.stop();
    donateX.stop();
    if (overlay) overlay.close();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
