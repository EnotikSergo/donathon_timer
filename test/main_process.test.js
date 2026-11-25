const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const {ROOT} = require('./helpers/fake_env');

const APP_ENTRIES = ['main.js', 'constants.js', 'squirrel_startup.js', 'core', 'preload', 'view', 'control', 'auth'];

beforeEach((t) => {
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
});

function createApp({legacy = {}, saves = {}, encryption = false} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
    const appDir = path.join(dir, 'app');
    const userData = path.join(dir, 'userData');
    for (const entry of APP_ENTRIES) fs.cpSync(path.join(ROOT, entry), path.join(appDir, entry), {recursive: true});
    for (const [name, content] of Object.entries(legacy)) {
        fs.mkdirSync(path.join(appDir, 'saves'), {recursive: true});
        fs.writeFileSync(path.join(appDir, 'saves', name), content);
    }
    for (const [name, content] of Object.entries(saves)) {
        fs.mkdirSync(path.join(userData, 'saves'), {recursive: true});
        fs.writeFileSync(path.join(userData, 'saves', name), content);
    }
    return {dir, appDir, userData, encryption, keyVersion: 1, savesDir: path.join(userData, 'saves'), localStorage: null, lock: true};
}

const launched = [];

function launch(appCtx) {
    const handlers = {};
    const listeners = {};
    const windows = [];
    const appEvents = {};
    let readyResolve;
    const ready = new Promise((r) => {
        readyResolve = r;
    });
    let quitCalls = 0;

    class BrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.destroyed = false;
            this.sent = [];
            this.events = {};
            this.loadListeners = [];
            this.webContents = {
                send: (channel, data) => this.sent.push([channel, data === undefined ? undefined : JSON.parse(JSON.stringify(data))]),
                once: (event, fn) => {
                    if (event === 'did-finish-load') this.loadListeners.push(fn);
                },
                executeJavaScript: async () => appCtx.localStorage
            };
            windows.push(this);
        }

        loadFile(file) {
            this.file = file;
        }

        on(event, fn) {
            this.events[event] = fn;
        }

        isDestroyed() {
            return this.destroyed;
        }

        isVisible() {
            return false;
        }

        isMinimized() {
            return false;
        }

        focus() {}

        finishLoad() {
            for (const fn of this.loadListeners.splice(0)) fn();
        }

        close() {
            this.destroyed = true;
            if (this.events.closed) this.events.closed();
        }
    }

    const electron = {
        app: {
            getPath: () => appCtx.userData,
            isReady: () => true,
            whenReady: () => ready,
            requestSingleInstanceLock: () => appCtx.lock,
            on: (event, fn) => {
                (appEvents[event] = appEvents[event] || []).push(fn);
            },
            quit: () => quitCalls++
        },
        BrowserWindow,
        ipcMain: {
            handle: (channel, fn) => {
                if (handlers[channel]) throw new Error(`Attempted to register a second handler for '${channel}'`);
                handlers[channel] = fn;
            },
            on: (channel, fn) => {
                (listeners[channel] = listeners[channel] || []).push(fn);
            }
        },
        shell: {openExternal: async () => {}},
        safeStorage: {
            isAsyncEncryptionAvailable: async () => appCtx.encryption,
            encryptStringAsync: async (s) => Buffer.from(`ENC${appCtx.keyVersion}:` + Buffer.from(s).toString('hex')),
            decryptStringAsync: async (b) => {
                const [prefix, hex] = b.toString().split(':');
                return {result: Buffer.from(hex, 'hex').toString(), shouldReEncrypt: prefix !== `ENC${appCtx.keyVersion}`};
            }
        },
        net: {
            request: () => ({
                handlers: {},
                setHeader() {},
                on(event, fn) {
                    this.handlers[event] = fn;
                },
                abort() {},
                end() {
                    setImmediate(() => this.handlers.error && this.handlers.error(new Error('offline')));
                }
            })
        }
    };

    const overlay = {pushed: [], events: [], started: []};
    const originalLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (request === 'electron') return electron;
        if (request === './core/overlay_server') {
            return {
                startOverlayServer: (opts) => {
                    overlay.started.push(opts);
                    return {
                        push: (s) => overlay.pushed.push(s),
                        pushEvent: (e) => overlay.events.push(e),
                        close: async () => {}
                    };
                }
            };
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
    const savedFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
        fetchCalls.push(url);
        return {ok: false, status: 401, json: async () => null, headers: {get: () => null}};
    };
    try {
        require(path.join(appCtx.appDir, 'main.js'));
    } finally {
        Module._load = originalLoad;
    }

    const trusted = {senderFrame: {url: 'file:///app/view/index.html'}};
    const api = {
        windows,
        handlers,
        overlay,
        fetchCalls,
        quitCalls: () => quitCalls,
        async ready() {
            readyResolve();
            await new Promise((r) => setTimeout(r, 20));
        },
        async loadWindows() {
            for (const w of windows) w.finishLoad();
            await new Promise((r) => setTimeout(r, 20));
        },
        invoke: (channel, ...args) => handlers[channel](trusted, ...args),
        send(channel, ...args) {
            for (const fn of listeners[channel] || []) fn(trusted, ...args);
        },
        sendFrom(url, channel, ...args) {
            for (const fn of listeners[channel] || []) fn({senderFrame: {url}}, ...args);
        },
        emitApp(event) {
            for (const fn of appEvents[event] || []) fn();
        },
        timerWindow: () => windows.find((w) => w.opts.title !== 'Timer Control' && !w.destroyed),
        file: (name) => {
            const p = path.join(appCtx.savesDir, name);
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        },
        unload() {
            if (api.unloaded) return;
            api.unloaded = true;
            api.emitApp('before-quit');
            globalThis.fetch = savedFetch;
            for (const key of Object.keys(require.cache)) {
                if (key.startsWith(appCtx.appDir)) delete require.cache[key];
            }
        }
    };
    launched.push(api);
    return api;
}

async function withApp(options, fn) {
    const appCtx = createApp(options);
    try {
        await fn(appCtx);
    } finally {
        for (const api of launched.splice(0)) api.unload();
        fs.rmSync(appCtx.dir, {recursive: true, force: true});
    }
}

test('перенос старых сохранений: копируются один раз, старые файлы не трогаются', () => withApp({legacy: {
    'settings.json': '{"baseRubPerHour":1200}',
    'auth_tokens.json': '{"donationAlerts":"da","trula":"old"}',
    'timer_value.txt': '03:00:00',
    'stopwatch_save.txt': '100'
}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.file('timer_value.txt'), '03:00:00');
    assert.equal((await main.invoke('timer:get-state')).remaining, '03:00:00');
    assert.deepEqual(await main.invoke('auth-tokens:get'), {donationAlerts: 'da'});
    assert.equal((await main.invoke('settings:get')).baseRubPerHour, 1200);
    assert.deepEqual(JSON.parse(main.file('migration.json')).copied, ['settings.json', 'auth_tokens.json', 'timer_value.txt', 'stopwatch_save.txt']);
    assert.equal(fs.readFileSync(path.join(appCtx.appDir, 'saves', 'timer_value.txt'), 'utf8'), '03:00:00');
    main.unload();

    fs.unlinkSync(path.join(appCtx.savesDir, 'timer_value.txt'));
    const again = launch(appCtx);
    await again.ready();
    assert.equal((await again.invoke('timer:get-state')).remaining, '05:00:00');
    again.unload();
}));

test('окна создаются в безопасном режиме с preload, интерфейс — из view/', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.windows.length, 2);
    for (const w of main.windows) {
        const prefs = w.opts.webPreferences;
        assert.equal(prefs.contextIsolation, true);
        assert.equal(prefs.nodeIntegration, false);
        assert.equal(prefs.sandbox, true);
        assert.ok(fs.existsSync(prefs.preload));
    }
    assert.match(main.windows[0].file, /view[\\/]index\.html$/);
    assert.match(main.windows[1].file, /control[\\/]control\.html$/);
    assert.match(main.overlay.started[0].overlayDir, /[\\/]view$/);
    assert.equal(main.overlay.started[0].host, '0.0.0.0');
    assert.equal(main.overlay.started.length, 1);
    assert.match(main.overlay.started[0].authPagePath, /auth[\\/]auth_success\.html$/);
    main.unload();
}));

test('второй экземпляр программы сразу закрывается', () => withApp({}, async (appCtx) => {
    appCtx.lock = false;
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.quitCalls(), 1);
    assert.equal(main.windows.length, 0);
    main.unload();
}));

test('команды таймера из окна и состояние в окно и оверлей', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.send('timer:command', 'addSmall');
    main.send('timer:command', 'неизвестная');
    const state = await main.invoke('timer:get-state');
    assert.equal(state.remaining, '05:01:00');
    assert.equal(main.timerWindow().sent.filter(([c]) => c === 'timer:state').at(-1)[1].remaining, '05:01:00');
    assert.equal(main.overlay.pushed.at(-1).remaining, '05:01:00');
    assert.deepEqual(main.timerWindow().sent.filter(([c]) => c === 'timer:event').at(-1)[1], {type: 'addTime', seconds: 60});
    assert.deepEqual(main.overlay.events.at(-1), {type: 'addTime', seconds: 60});
    main.unload();
}));

test('сообщения не со страниц программы игнорируются', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.sendFrom('https://evil.example/', 'timer:command', 'addLarge');
    assert.equal((await main.invoke('timer:get-state')).remaining, '05:00:00');
    assert.throws(() => main.handlers['settings:get']({senderFrame: {url: 'https://evil.example/'}}), /Недоверенный источник/);
    main.unload();
}));

test('сбор из панели управления', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.send('goal:activate', {hours: 1});
    const control = main.windows.find((w) => w.opts.title === 'Timer Control');
    assert.deepEqual(control.sent.filter(([c]) => c === 'goal:status').map(([, v]) => v), [true]);
    assert.equal((await main.invoke('timer:get-state')).isGoalActive, true);
    main.send('goal:deactivate');
    assert.deepEqual(control.sent.filter(([c]) => c === 'goal:status').map(([, v]) => v), [true, false]);
    main.unload();
}));

test('настройки: значения по умолчанию', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    const s = await main.invoke('settings:get');
    assert.equal(s.donationModeEnabled, true);
    assert.equal(s.sleepModeEnabled, false);
    assert.equal(s.showRubPerHour, true);
    assert.equal(s.dynamicPriceIncreaseEnabled, false);
    assert.equal(s.baseRubPerHour, 1000);
    assert.equal(s.dynamicPriceStep, 500);
    assert.equal('lanAccessEnabled' in s, false);
    assert.equal((await main.invoke('timer:get-state')).rublesPerHour, 1000);
    main.unload();
}));

test('настройки: при запуске цена считается с учётом тира', () => withApp({saves: {
    'migration.json': '{}',
    'settings.json': JSON.stringify({dynamicPriceIncreaseEnabled: true, maxTimerTier: 2, baseRubPerHour: 1000, dynamicPriceStep: 500})
}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal((await main.invoke('timer:get-state')).rublesPerHour, 2000);
    main.unload();
}));

test('настройки: из панели меняются только разрешённые, сохраняются и рассылаются', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.send('settings:set', {donationModeEnabled: false, sleepModeEnabled: true, showRubPerHour: false, baseRubPerHour: 1200, maxTimerTier: 9, hacked: 1});
    main.unload();
    const saved = JSON.parse(main.file('settings.json'));
    assert.equal(saved.donationModeEnabled, false);
    assert.equal(saved.sleepModeEnabled, true);
    assert.equal(saved.showRubPerHour, false);
    assert.equal(saved.baseRubPerHour, 1200);
    assert.equal(saved.maxTimerTier, 0);
    assert.equal('hacked' in saved, false);
    const control = main.windows.find((w) => w.opts.title === 'Timer Control');
    assert.equal(control.sent.filter(([c]) => c === 'settings:update').at(-1)[1].baseRubPerHour, 1200);
}));

test('положение надписи с ценой сохраняется и уходит в оверлей', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.send('timer:set-price-label', {left: '12px', top: '-30px', fontSize: 2.5});
    assert.deepEqual(main.overlay.pushed.at(-1).rubLabel, {left: '12px', top: '-30px', fontSize: 2.5});
    main.send('timer:set-price-label', {left: 'javascript:alert(1)', fontSize: 999});
    assert.equal(main.overlay.pushed.at(-1).rubLabel, null);
    main.unload();
}));

test('перенос из localStorage прежней версии: состояние DonateX и надпись с ценой', () => withApp({}, async (appCtx) => {
    appCtx.localStorage = {
        dxLastProcessed: '1700000000000',
        dxProcessedIds: '["a","b"]',
        rubLeft: '40px',
        rubTop: '90px',
        rubFontSize: '3.1'
    };
    const main = launch(appCtx);
    await main.ready();
    await main.loadWindows();
    assert.deepEqual(JSON.parse(main.file('donatex_state.json')), {lastProcessedTimestamp: 1700000000000, processedIds: ['a', 'b']});
    assert.deepEqual((await main.invoke('settings:get')).rubLabel, {left: '40px', top: '90px', fontSize: 3.1});
    assert.equal(JSON.parse(main.file('migration.json')).localStorageMigrated, true);
    main.unload();

    appCtx.localStorage = {rubLeft: '1px', rubTop: '1px'};
    const again = launch(appCtx);
    await again.ready();
    await again.loadWindows();
    assert.deepEqual((await again.invoke('settings:get')).rubLabel, {left: '40px', top: '90px', fontSize: 3.1});
    again.unload();
}));

test('токены: незашифрованный файл шифруется при запуске, лишние сервисы удаляются', () => withApp({encryption: true, saves: {
    'migration.json': '{}',
    'auth_tokens.json': '{"donationAlerts":"da","donateX":"dx","trula":"old"}'
}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal(JSON.parse(main.file('auth_tokens.json')).encrypted, true);
    assert.doesNotMatch(main.file('auth_tokens.json'), /"da"|"dx"/);
    assert.deepEqual(await main.invoke('auth-tokens:get'), {donationAlerts: 'da', donateX: 'dx'});
    assert.equal((await main.invoke('auth:logout', 'donateX')).ok, true);
    assert.deepEqual(await main.invoke('auth-tokens:get'), {donationAlerts: 'da'});
    assert.equal(JSON.parse(main.file('auth_tokens.json')).encrypted, true);
    main.unload();
}));

test('токены: при смене ключа шифрования перешифровываются при запуске', () => withApp({encryption: true, saves: {
    'migration.json': '{}',
    'auth_tokens.json': '{"donationAlerts":"da"}'
}}, async (appCtx) => {
    const first = launch(appCtx);
    await first.ready();
    first.unload();
    assert.match(Buffer.from(JSON.parse(first.file('auth_tokens.json')).data, 'base64').toString(), /^ENC1:/);

    appCtx.keyVersion = 2;
    const main = launch(appCtx);
    await main.ready();
    assert.match(Buffer.from(JSON.parse(main.file('auth_tokens.json')).data, 'base64').toString(), /^ENC2:/);
    assert.deepEqual(await main.invoke('auth-tokens:get'), {donationAlerts: 'da'});
    main.unload();
}));

test('токены: без шифрования хранятся как раньше', () => withApp({saves: {'migration.json': '{}', 'auth_tokens.json': '{"donateX":"dx"}'}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.deepEqual(JSON.parse(main.file('auth_tokens.json')), {donateX: 'dx'});
    main.unload();
}));

test('токены: если зашифрованный файл не прочитать, он не перезаписывается', () => withApp({encryption: true, saves: {
    'migration.json': '{}',
    'auth_tokens.json': '{"donationAlerts":"da","donateX":"dx"}'
}}, async (appCtx) => {
    const first = launch(appCtx);
    await first.ready();
    first.unload();
    const encrypted = first.file('auth_tokens.json');

    appCtx.encryption = false;
    const main = launch(appCtx);
    await main.ready();
    assert.deepEqual(await main.invoke('auth-tokens:get'), {});
    assert.equal((await main.invoke('auth:logout', 'donationAlerts')).ok, false);
    assert.equal(main.file('auth_tokens.json'), encrypted);
    main.unload();
}));

test('сервисы донатов запускаются после загрузки окна и останавливаются при выходе', () => withApp({saves: {
    'migration.json': '{"localStorageMigrated":true}',
    'auth_tokens.json': '{"donationAlerts":"da"}'
}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.fetchCalls.length, 0);
    await main.loadWindows();
    assert.ok(main.fetchCalls.some((u) => u.includes('donationalerts.com/api/v1/user/oauth')));
    const statuses = await main.invoke('donation:get-statuses');
    assert.equal(statuses.DA, 'error');
    assert.equal(statuses.DX, 'disconnected');
    main.unload();
}));

test('Boosty: модуль запускается, отказ токена виден в индикаторе и статусе аккаунта', () => withApp({saves: {
    'migration.json': '{"localStorageMigrated":true}',
    'auth_tokens.json': JSON.stringify({boosty: JSON.stringify({accessToken: 'a', refreshToken: 'r', expiresAt: 0, deviceId: 'd', blog: 'niki'})})
}}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    assert.equal((await main.invoke('accounts:get')).boosty.status, 'checking');
    assert.equal(typeof main.handlers['auth:boosty-save'], 'function');
    assert.match((await main.invoke('auth:boosty-login', '')).error, /укажите блог/i);
    await main.loadWindows();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(main.fetchCalls.some((u) => u.startsWith('https://api.boosty.to/v1/blog/niki/subscription_level/')));
    assert.equal((await main.invoke('donation:get-statuses')).BY, 'error');
    assert.equal((await main.invoke('accounts:get')).boosty.status, 'invalid');
    assert.match((await main.invoke('boosty:inspect')).error, /не принял токен/);
    main.unload();
}));

test('обработчики IPC регистрируются один раз, повторное открытие окон не ломается', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.timerWindow().close();
    assert.doesNotThrow(() => main.emitApp('activate'));
    assert.equal(main.windows.filter((w) => !w.destroyed).length, 2);
    main.unload();
}));

test('при выходе сохраняются таймер и настройки', () => withApp({}, async (appCtx) => {
    const main = launch(appCtx);
    await main.ready();
    main.send('timer:command', 'addSmall');
    main.send('settings:set', {baseRubPerHour: 1500});
    main.unload();
    assert.equal(main.file('timer_value.txt'), '05:01:00');
    assert.equal(JSON.parse(main.file('settings.json')).baseRubPerHour, 1500);
}));
