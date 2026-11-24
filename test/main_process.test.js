const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const {ROOT} = require('./helpers/fake_env');

const MAIN_FILES = ['renderer.js', 'auth_manager.js', 'squirrel_startup.js', 'js/lib/storage.js'];

beforeEach((t) => {
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
});

function createApp({legacy = {}, saves = {}, encryption = false} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'));
    const appDir = path.join(dir, 'app');
    const userData = path.join(dir, 'userData');
    for (const f of MAIN_FILES) {
        fs.mkdirSync(path.dirname(path.join(appDir, f)), {recursive: true});
        fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
    }
    for (const [name, content] of Object.entries(legacy)) {
        fs.mkdirSync(path.join(appDir, 'saves'), {recursive: true});
        fs.writeFileSync(path.join(appDir, 'saves', name), content);
    }
    for (const [name, content] of Object.entries(saves)) {
        fs.mkdirSync(path.join(userData, 'saves'), {recursive: true});
        fs.writeFileSync(path.join(userData, 'saves', name), content);
    }
    return {dir, appDir, userData, encryption, savesDir: path.join(userData, 'saves')};
}

function launch(appCtx) {
    const handlers = {};
    const listeners = {};
    const windows = [];
    const appEvents = {};
    let readyResolve;
    const ready = new Promise((r) => {
        readyResolve = r;
    });

    class BrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.destroyed = false;
            this.sent = [];
            this.events = {};
            this.webContents = {
                send: (channel, data) => this.sent.push([channel, data === undefined ? undefined : JSON.parse(JSON.stringify(data))]),
                once: () => {}
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
            on: (event, fn) => {
                appEvents[event] = fn;
            },
            quit: () => {}
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
            isEncryptionAvailable: () => appCtx.encryption,
            encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
            decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString()
        },
        net: {
            request: () => {
                const req = {
                    handlers: {},
                    setHeader() {},
                    on(event, fn) {
                        this.handlers[event] = fn;
                    },
                    abort() {},
                    end() {
                        setImmediate(() => this.handlers.error && this.handlers.error(new Error('offline')));
                    }
                };
                return req;
            }
        }
    };

    const overlay = {pushed: [], events: []};
    const originalLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (request === 'electron') return electron;
        if (request === './overlay_server') {
            return {
                startOverlayServer: () => ({
                    push: (s) => overlay.pushed.push(s),
                    pushEvent: (e) => overlay.events.push(e),
                    close: async () => {}
                })
            };
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
    const mainPath = path.join(appCtx.appDir, 'renderer.js');
    try {
        require(mainPath);
    } finally {
        Module._load = originalLoad;
    }

    const api = {
        windows,
        handlers,
        overlay,
        async ready() {
            readyResolve();
            await new Promise((r) => setTimeout(r, 20));
        },
        invoke: (channel, ...args) => handlers[channel]({}, ...args),
        sendSync(channel, ...args) {
            const event = {};
            for (const fn of listeners[channel] || []) fn(event, ...args);
            return event.returnValue;
        },
        send(channel, ...args) {
            for (const fn of listeners[channel] || []) fn({}, ...args);
        },
        emitApp: (event) => appEvents[event] && appEvents[event](),
        file: (name) => {
            const p = path.join(appCtx.savesDir, name);
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        },
        unload: () => {
            for (const f of MAIN_FILES) delete require.cache[path.join(appCtx.appDir, f)];
        }
    };
    return api;
}

test('перенос старых сохранений: копируются один раз, старые файлы не трогаются', async () => {
    const appCtx = createApp({legacy: {
        'settings.json': '{"baseRubPerHour":1200}',
        'auth_tokens.json': '{"donationAlerts":"da","trula":"old"}',
        'timer_value.txt': '03:00:00',
        'stopwatch_save.txt': '100'
    }});
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.file('timer_value.txt'), '03:00:00');
    assert.equal(main.file('stopwatch_save.txt'), '100');
    assert.deepEqual(main.sendSync('auth-tokens:get-sync'), {donationAlerts: 'da'});
    assert.equal((await main.invoke('settings:get')).baseRubPerHour, 1200);
    assert.deepEqual(JSON.parse(main.file('migration.json')).copied, ['settings.json', 'auth_tokens.json', 'timer_value.txt', 'stopwatch_save.txt']);
    assert.equal(fs.readFileSync(path.join(appCtx.appDir, 'saves', 'timer_value.txt'), 'utf8'), '03:00:00');
    main.unload();

    fs.unlinkSync(path.join(appCtx.savesDir, 'timer_value.txt'));
    const again = launch(appCtx);
    await again.ready();
    assert.equal(again.file('timer_value.txt'), null);
    again.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('пути сохранений таймера — в папке данных программы', async () => {
    const appCtx = createApp();
    const main = launch(appCtx);
    await main.ready();
    assert.deepEqual(main.sendSync('storage:paths-sync'), {
        timer: path.join(appCtx.savesDir, 'timer_value.txt'),
        stopwatch: path.join(appCtx.savesDir, 'stopwatch_save.txt')
    });
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('настройки: значения по умолчанию', async () => {
    const appCtx = createApp();
    const main = launch(appCtx);
    await main.ready();
    const s = await main.invoke('settings:get');
    assert.equal(s.donationModeEnabled, true);
    assert.equal(s.sleepModeEnabled, false);
    assert.equal(s.showRubPerHour, true);
    assert.equal(s.dynamicPriceIncreaseEnabled, false);
    assert.equal(s.baseRubPerHour, 1000);
    assert.equal(s.dynamicPriceStep, 500);
    assert.equal(s.lanAccessEnabled, false);
    assert.equal(s.secondsAddedPerCurrency, 3.6);
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('настройки: при запуске цена считается с учётом тира', async () => {
    const appCtx = createApp({saves: {
        'migration.json': '{}',
        'settings.json': JSON.stringify({dynamicPriceIncreaseEnabled: true, maxTimerTier: 2, baseRubPerHour: 1000, dynamicPriceStep: 500})
    }});
    const main = launch(appCtx);
    await main.ready();
    assert.equal((await main.invoke('settings:get')).secondsAddedPerCurrency, 3600 / 2000);
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('настройки: сохраняются все галочки и рассылаются окнам', async () => {
    const appCtx = createApp();
    const main = launch(appCtx);
    await main.ready();
    main.send('settings:set', {donationModeEnabled: false, sleepModeEnabled: true, showRubPerHour: false, baseRubPerHour: 1200});
    const saved = JSON.parse(main.file('settings.json'));
    assert.deepEqual(saved, {
        donationModeEnabled: false,
        sleepModeEnabled: true,
        showRubPerHour: false,
        dynamicPriceIncreaseEnabled: false,
        maxTimerTier: 0,
        baseRubPerHour: 1200,
        dynamicPriceStep: 500,
        lanAccessEnabled: false
    });
    for (const win of main.windows) {
        assert.equal(win.sent.filter(([c]) => c === 'settings:update').at(-1)[1].baseRubPerHour, 1200);
    }
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('токены: незашифрованный файл шифруется при запуске, лишние сервисы удаляются', async () => {
    const appCtx = createApp({encryption: true, saves: {
        'migration.json': '{}',
        'auth_tokens.json': '{"donationAlerts":"da","donateX":"dx","trula":"old"}'
    }});
    const main = launch(appCtx);
    await main.ready();
    const stored = JSON.parse(main.file('auth_tokens.json'));
    assert.equal(stored.encrypted, true);
    assert.doesNotMatch(main.file('auth_tokens.json'), /"da"|"dx"/);
    assert.deepEqual(await main.invoke('auth-tokens:get'), {donationAlerts: 'da', donateX: 'dx'});
    assert.equal((await main.invoke('auth:logout', 'donateX')).ok, true);
    assert.deepEqual(main.sendSync('auth-tokens:get-sync'), {donationAlerts: 'da'});
    assert.equal(JSON.parse(main.file('auth_tokens.json')).encrypted, true);
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('токены: без шифрования хранятся как раньше', async () => {
    const appCtx = createApp({saves: {'migration.json': '{}', 'auth_tokens.json': '{"donateX":"dx"}'}});
    const main = launch(appCtx);
    await main.ready();
    assert.deepEqual(JSON.parse(main.file('auth_tokens.json')), {donateX: 'dx'});
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('токены: если зашифрованный файл не прочитать, он не перезаписывается', async () => {
    const appCtx = createApp({encryption: true, saves: {'migration.json': '{}', 'auth_tokens.json': '{"donationAlerts":"da","donateX":"dx"}'}});
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
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('обработчики IPC регистрируются один раз, повторное открытие окон не ломается', async () => {
    const appCtx = createApp();
    const main = launch(appCtx);
    await main.ready();
    assert.equal(main.windows.length, 2);
    main.windows[0].close();
    assert.doesNotThrow(() => main.emitApp('activate'));
    assert.equal(main.windows.length, 4);
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});

test('состояние и события таймера пересылаются в оверлей', async () => {
    const appCtx = createApp();
    const main = launch(appCtx);
    await main.ready();
    main.send('overlay:state', {remaining: '01:00:00'});
    main.send('overlay:event', {type: 'addTime', seconds: 60});
    assert.deepEqual(main.overlay.pushed.at(-1), {remaining: '01:00:00'});
    assert.deepEqual(main.overlay.events.at(-1), {type: 'addTime', seconds: 60});
    main.unload();
    fs.rmSync(appCtx.dir, {recursive: true, force: true});
});
