const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const {createAuthManager} = require('../core/auth_manager');

beforeEach((t) => {
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
});

function setup({port = 41701, da = {status: 200, json: {data: {name: 'StreamerDA'}}}, dx = {status: 200, json: {username: 'StreamerDX'}}} = {}) {
    const ctx = {
        store: {},
        meta: {},
        opened: [],
        calls: [],
        tokensChanged: 0,
        api: {da, dx, boosty: {status: 200, json: {data: []}}}
    };
    ctx.manager = createAuthManager({
        tokens: {
            read: () => ({...ctx.store}),
            update: (service, token) => {
                ctx.store[service] = token;
            },
            remove: (service) => {
                delete ctx.store[service];
            }
        },
        meta: {
            read: () => JSON.parse(JSON.stringify(ctx.meta)),
            write: (m) => {
                ctx.meta = m;
            }
        },
        httpGetJson: async (url, headers) => {
            ctx.calls.push([url, headers]);
            const r = url.includes('donationalerts') ? ctx.api.da : url.includes('api.boosty.to') ? ctx.api.boosty : ctx.api.dx;
            if (r === 'offline') throw new Error('offline');
            return r;
        },
        openExternal: (url) => ctx.opened.push(url),
        overlayPort: port,
        onChange: () => {},
        onTokensChanged: () => ctx.tokensChanged++
    });
    return ctx;
}

async function login(ctx, expiresIn = '631151999') {
    ctx.manager.startDaLogin();
    const state = new URL(ctx.opened.at(-1)).searchParams.get('state');
    return ctx.manager.handleDaCallback({access_token: 'tok', state, expires_in: expiresIn});
}

test('без токенов оба аккаунта не подключены', async () => {
    const ctx = setup();
    ctx.manager.init();
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.manager.getAccounts().donationAlerts.status, 'none');
    assert.equal(ctx.manager.getAccounts().donateX.status, 'none');
});

test('вход DA: адрес авторизации со scope, redirect_uri и одноразовым state', () => {
    const ctx = setup();
    assert.deepEqual(ctx.manager.startDaLogin(), {ok: true});
    const url = new URL(ctx.opened[0]);
    assert.equal(url.origin + url.pathname, 'https://www.donationalerts.com/oauth/authorize');
    assert.equal(url.searchParams.get('response_type'), 'token');
    assert.equal(url.searchParams.get('scope'), 'oauth-user-show oauth-donation-subscribe oauth-donation-index');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:41701/auth/da');
    assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
    assert.equal(ctx.manager.isAuthPending('donationAlerts'), true);
    assert.equal(ctx.manager.getAccounts().donationAlerts.loginPending, true);

    ctx.manager.startDaLogin();
    assert.notEqual(new URL(ctx.opened[1]).searchParams.get('state'), url.searchParams.get('state'));
});

test('ответ DA принимается только во время входа, с верным state и один раз', async () => {
    const ctx = setup();
    assert.equal((await ctx.manager.handleDaCallback({access_token: 'x'})).error, 'not_pending');
    ctx.manager.startDaLogin();
    const state = new URL(ctx.opened[0]).searchParams.get('state');
    assert.equal((await ctx.manager.handleDaCallback({access_token: 'x', state: 'wrong'})).error, 'state_mismatch');
    assert.equal((await ctx.manager.handleDaCallback({access_token: '', state})).error, 'bad_token');
    assert.equal(ctx.store.donationAlerts, undefined);
    assert.deepEqual(await ctx.manager.handleDaCallback({access_token: 'tok', state, expires_in: '3600'}), {ok: true});
    assert.equal(ctx.store.donationAlerts, 'tok');
    assert.equal(ctx.tokensChanged, 1);
    assert.equal((await ctx.manager.handleDaCallback({access_token: 'again', state})).error, 'not_pending');
    assert.equal(ctx.store.donationAlerts, 'tok');
});

test('ответ DA без state принимается, пока вход активен', async () => {
    const ctx = setup();
    ctx.manager.startDaLogin();
    assert.deepEqual(await ctx.manager.handleDaCallback({access_token: 'tok'}), {ok: true});
});

test('после входа DA сохраняются срок и scope, показывается ник', async () => {
    const ctx = setup();
    await login(ctx);
    await new Promise((r) => setImmediate(r));
    const da = ctx.manager.getAccounts().donationAlerts;
    assert.equal(da.status, 'ok');
    assert.equal(da.name, 'StreamerDA');
    assert.equal(da.loginPending, false);
    assert.deepEqual(ctx.meta.donationAlerts.scopes, ['oauth-user-show', 'oauth-donation-subscribe', 'oauth-donation-index']);
    assert.ok(ctx.meta.donationAlerts.expiresAt > Date.now());
    assert.deepEqual(ctx.calls.at(-1)[1], {Authorization: 'Bearer tok'});
});

test('проверка DA: старый scope, скорый конец срока, истёкший токен, 401, нет сети', async () => {
    const ctx = setup();
    ctx.store.donationAlerts = 'tok';
    const status = () => ctx.manager.getAccounts().donationAlerts;

    ctx.meta.donationAlerts = {scopes: ['oauth-user-show', 'oauth-donation-subscribe']};
    await ctx.manager.verify('donationAlerts');
    assert.match(status().warning, /досчитывать/);

    ctx.meta.donationAlerts = {scopes: ['oauth-donation-index'], expiresAt: Date.now() + 24 * 3600 * 1000};
    await ctx.manager.verify('donationAlerts');
    assert.match(status().warning, /действует до/);

    ctx.meta.donationAlerts = {expiresAt: Date.now() - 1};
    await ctx.manager.verify('donationAlerts');
    assert.equal(status().status, 'invalid');

    ctx.meta.donationAlerts = {scopes: ['oauth-donation-index']};
    ctx.api.da = {status: 401};
    await ctx.manager.verify('donationAlerts');
    assert.equal(status().status, 'invalid');

    ctx.api.da = 'offline';
    await ctx.manager.verify('donationAlerts');
    assert.equal(status().status, 'unverified');
});

test('вход DA невозможен при порте, отличном от 41701', () => {
    const ctx = setup({port: 5000});
    const result = ctx.manager.startDaLogin();
    assert.equal(result.ok, false);
    assert.match(result.error, /41701/);
    assert.equal(ctx.opened.length, 0);
});

test('токен DonateX: неверный не сохраняется, верный сохраняется с ником, без сети — «не проверено»', async () => {
    const ctx = setup({dx: {status: 401}});
    assert.equal((await ctx.manager.saveDxToken('  bad  ')).ok, false);
    assert.equal(ctx.store.donateX, undefined);
    assert.equal((await ctx.manager.saveDxToken('   ')).ok, false);

    ctx.api.dx = {status: 200, json: {username: 'StreamerDX'}};
    assert.equal((await ctx.manager.saveDxToken('  good  ')).ok, true);
    assert.equal(ctx.store.donateX, 'good');
    assert.deepEqual(ctx.calls.at(-1), ['https://donatex.gg/api/v1/user/me', {'X-External-Token': 'good'}]);
    assert.equal(ctx.manager.getAccounts().donateX.name, 'StreamerDX');
    assert.equal(ctx.tokensChanged, 1);

    ctx.api.dx = 'offline';
    assert.equal((await ctx.manager.saveDxToken('offline-token')).ok, true);
    assert.equal(ctx.manager.getAccounts().donateX.status, 'unverified');
});

test('выход удаляет токен и данные аккаунта; повторный и неизвестный — отклоняются', async () => {
    const ctx = setup();
    await login(ctx);
    await ctx.manager.saveDxToken('dx');
    const changed = ctx.tokensChanged;

    assert.equal((await ctx.manager.logout('donateX')).ok, true);
    assert.equal(ctx.store.donateX, undefined);
    assert.equal(ctx.manager.getAccounts().donateX.status, 'none');
    assert.equal((await ctx.manager.logout('donateX')).ok, false);

    assert.equal((await ctx.manager.logout('donationAlerts')).ok, true);
    assert.equal(ctx.store.donationAlerts, undefined);
    assert.equal(ctx.meta.donationAlerts, undefined);

    assert.equal((await ctx.manager.logout('trula')).ok, false);
    assert.equal(ctx.tokensChanged, changed + 2);
});

const BOOSTY_COOKIE = `auth=${encodeURIComponent(JSON.stringify({accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 3600 * 1000}))}; _clientId=dev`;

test('Boosty: без блога, без токена, без _clientId — не сохраняется', async () => {
    const ctx = setup();
    assert.match((await ctx.manager.saveBoostyToken(BOOSTY_COOKIE, '')).error, /блог/i);
    assert.match((await ctx.manager.saveBoostyToken('мусор', 'niki')).error, /Cookie/);
    const noDevice = `auth=${encodeURIComponent(JSON.stringify({accessToken: 'a', refreshToken: 'r'}))}`;
    assert.match((await ctx.manager.saveBoostyToken(noDevice, 'niki')).error, /_clientId/);
    assert.equal(ctx.store.boosty, undefined);
    assert.equal(ctx.calls.length, 0);
});

test('Boosty: проверка по статистике блога — 401, 403, 404 отклоняются', async () => {
    const ctx = setup();
    for (const [status, re] of [[401, /не принял/], [403, /Нет доступа/], [404, /не найден/]]) {
        ctx.api.boosty = {status};
        assert.match((await ctx.manager.saveBoostyToken(BOOSTY_COOKIE, 'https://boosty.to/niki')).error, re);
    }
    assert.equal(ctx.store.boosty, undefined);
    assert.match(ctx.calls.at(-1)[0], /^https:\/\/api\.boosty\.to\/v1\/blog\/stat\/niki\/events\?/);
    assert.deepEqual(ctx.calls.at(-1)[1], {Authorization: 'Bearer acc'});
});

test('Boosty: верный токен сохраняется вместе с блогом, статус берётся из опроса', async () => {
    const ctx = setup();
    assert.deepEqual(await ctx.manager.saveBoostyToken(BOOSTY_COOKIE, 'boosty.to/niki'), {ok: true});
    const stored = JSON.parse(ctx.store.boosty);
    assert.equal(stored.blog, 'niki');
    assert.equal(stored.deviceId, 'dev');
    assert.equal(ctx.tokensChanged, 1);
    assert.equal(ctx.manager.getAccounts().boosty.status, 'checking');
    assert.equal(ctx.manager.getAccounts().boosty.name, 'niki');

    ctx.manager.reportServiceStatus('boosty', 'connected');
    assert.equal(ctx.manager.getAccounts().boosty.status, 'ok');
    ctx.manager.reportServiceStatus('boosty', 'error');
    assert.equal(ctx.manager.getAccounts().boosty.status, 'unverified');
    ctx.manager.reportServiceStatus('boosty', 'auth');
    assert.equal(ctx.manager.getAccounts().boosty.status, 'invalid');
    ctx.manager.reportServiceStatus('boosty', 'error');
    assert.equal(ctx.manager.getAccounts().boosty.status, 'invalid');

    assert.equal((await ctx.manager.logout('boosty')).ok, true);
    assert.equal(ctx.store.boosty, undefined);
    assert.equal(ctx.manager.getAccounts().boosty.status, 'none');
});

test('Boosty: просроченный токен сохраняется без проверки (обновит модуль опроса)', async () => {
    const ctx = setup();
    const expired = `auth=${encodeURIComponent(JSON.stringify({accessToken: 'a', refreshToken: 'r', expiresAt: 1000}))}; _clientId=d`;
    assert.deepEqual(await ctx.manager.saveBoostyToken(expired, 'niki'), {ok: true});
    assert.equal(ctx.calls.length, 0);
});
