const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createClock} = require('./helpers/fake_env');
const {createBoostyLogin, browserUserAgent} = require('../core/boosty_login');

const AUTH = encodeURIComponent(JSON.stringify({accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 3600e3}));

function setup() {
    const clock = createClock();
    const ctx = {cookies: [], cleared: 0, windows: [], partitions: []};

    class FakeContents {
        constructor() {
            this.handlers = {};
            this.ua = null;
        }

        setUserAgent(ua) {
            this.ua = ua;
        }

        setWindowOpenHandler(fn) {
            this.openHandler = fn;
        }

        on(event, fn) {
            this.handlers[event] = fn;
        }
    }

    class FakeWindow {
        constructor(opts) {
            this.opts = opts;
            this.webContents = new FakeContents();
            this.destroyed = false;
            this.events = {};
            this.focused = 0;
            ctx.windows.push(this);
        }

        loadURL(url) {
            this.url = url;
            return Promise.resolve();
        }

        on(event, fn) {
            this.events[event] = fn;
        }

        isDestroyed() {
            return this.destroyed;
        }

        focus() {
            this.focused++;
        }

        close() {
            if (this.destroyed) return;
            this.destroyed = true;
            if (this.events.closed) this.events.closed();
        }
    }

    const session = {
        fromPartition: (name) => {
            ctx.partitions.push(name);
            return {
                cookies: {get: async ({url}) => (url === 'https://boosty.to' ? ctx.cookies : [])},
                clearStorageData: async () => {
                    ctx.cleared++;
                }
            };
        }
    };

    const login = createBoostyLogin({
        BrowserWindow: FakeWindow,
        session,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 donathon-countdown/2.0.0 Electron/45.3.0 Safari/537.36',
        timers: clock.globals
    });
    return {clock, ctx, login};
}

test('user agent без упоминания Electron и программы', () => {
    assert.equal(browserUserAgent('A/1 Chrome/130 donathon-countdown/2.0.0 Electron/45.3.0 Safari/537'), 'A/1 Chrome/130 Safari/537');
});

test('окно входа: отдельная сессия, безопасные настройки, boosty.to', async () => {
    const {clock, ctx, login} = setup();
    login.open();
    await clock.flush();
    const win = ctx.windows[0];
    assert.equal(win.url, 'https://boosty.to/');
    assert.deepEqual(win.opts.webPreferences, {partition: 'boosty-login', contextIsolation: true, nodeIntegration: false, sandbox: true});
    assert.equal(ctx.partitions[0], 'boosty-login');
    assert.doesNotMatch(win.webContents.ua, /Electron|donathon/);
    assert.equal(login.isLoginContents(win.webContents), true);
    assert.equal(ctx.cleared, 1);
});

test('после входа токен забирается из cookie, окно закрывается, сессия очищается', async () => {
    const {clock, ctx, login} = setup();
    const result = login.open();
    await clock.advance(3000);
    assert.equal(ctx.windows[0].destroyed, false);
    ctx.cookies = [{name: 'auth', value: AUTH}, {name: '_clientId', value: 'dev-1'}, {name: 'other', value: 'x'}];
    await clock.advance(1000);
    assert.equal(await result, `auth=${AUTH}; _clientId=dev-1`);
    assert.equal(ctx.windows[0].destroyed, true);
    assert.equal(ctx.cleared, 2);
    assert.equal(login.isOpen(), false);
});

test('cookie без refresh-токена или без _clientId не принимаются', async () => {
    const {clock, ctx, login} = setup();
    const result = login.open();
    ctx.cookies = [{name: 'auth', value: encodeURIComponent(JSON.stringify({accessToken: 'a'}))}, {name: '_clientId', value: 'd'}];
    await clock.advance(2000);
    ctx.cookies = [{name: 'auth', value: AUTH}];
    await clock.advance(2000);
    assert.equal(ctx.windows[0].destroyed, false);
    ctx.windows[0].close();
    assert.equal(await result, null);
});

test('закрытое пользователем окно — результат null', async () => {
    const {clock, ctx, login} = setup();
    const result = login.open();
    await clock.flush();
    ctx.windows[0].close();
    assert.equal(await result, null);
    assert.equal(login.isOpen(), false);
});

test('повторное нажатие не открывает второе окно', async () => {
    const {clock, ctx, login} = setup();
    const a = login.open();
    await clock.flush();
    const b = login.open();
    assert.equal(a, b);
    assert.equal(ctx.windows.length, 1);
    assert.equal(ctx.windows[0].focused, 1);
    ctx.windows[0].close();
    await a;
});

test('всплывающие окна входа: только https, в той же сессии, закрываются вместе с окном', async () => {
    const {clock, ctx, login} = setup();
    const result = login.open();
    await clock.flush();
    const win = ctx.windows[0];
    assert.deepEqual(win.webContents.openHandler({url: 'http://evil.example/'}), {action: 'deny'});
    const allowed = win.webContents.openHandler({url: 'https://oauth.vk.com/authorize'});
    assert.equal(allowed.action, 'allow');
    assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.partition, 'boosty-login');
    assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);

    const child = {webContents: {setUserAgent() {}}, destroyed: false, isDestroyed() {
        return this.destroyed;
    }, close() {
        this.destroyed = true;
    }, on() {}};
    win.webContents.handlers['did-create-window'](child);
    assert.equal(login.isLoginContents(child.webContents), true);
    ctx.cookies = [{name: 'auth', value: AUTH}, {name: '_clientId', value: 'dev-1'}];
    await clock.advance(1000);
    await result;
    assert.equal(child.destroyed, true);
});

test('через 10 минут без входа окно закрывается', async () => {
    const {clock, ctx, login} = setup();
    const result = login.open();
    await clock.advance(10 * 60 * 1000);
    assert.equal(await result, null);
    assert.equal(ctx.windows[0].destroyed, true);
});
