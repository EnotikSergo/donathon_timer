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
        api: {da, dx}
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
            const r = url.includes('donationalerts') ? ctx.api.da : ctx.api.dx;
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
