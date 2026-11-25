const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServiceEnv, START_TIME} = require('./helpers/fake_env');
const {createBoosty} = require('../core/donations/boosty');
const {
    parseBoostyCredentials,
    normalizeBlog,
    serializeCredentials,
    deserializeCredentials,
    refreshBoostyTokens
} = require('../core/donations/boosty_auth');

const SEC = Math.floor(START_TIME / 1000);
const AUTH_JSON = {accessToken: 'acc1', refreshToken: 'ref1', expiresAt: START_TIME + 3600 * 1000};
const COOKIE = `_ym_uid=1; auth=${encodeURIComponent(JSON.stringify(AUTH_JSON))}; _clientId=dev-1; theme=dark`;

test('токен: значение заголовка Cookie целиком', () => {
    assert.deepEqual(parseBoostyCredentials(COOKIE), {accessToken: 'acc1', refreshToken: 'ref1', expiresAt: AUTH_JSON.expiresAt, deviceId: 'dev-1'});
    assert.equal(parseBoostyCredentials('Cookie: ' + COOKIE).deviceId, 'dev-1');
});

test('токен: JSON и закодированный JSON, срок в секундах и миллисекундах', () => {
    const json = JSON.stringify({access_token: 'a', refresh_token: 'r', expires_at: SEC + 60, device_id: 'd'});
    assert.deepEqual(parseBoostyCredentials(json), {accessToken: 'a', refreshToken: 'r', expiresAt: (SEC + 60) * 1000, deviceId: 'd'});
    assert.equal(parseBoostyCredentials(encodeURIComponent(JSON.stringify(AUTH_JSON))).accessToken, 'acc1');
});

test('токен: мусор и неполные данные не принимаются', () => {
    assert.equal(parseBoostyCredentials(''), null);
    assert.equal(parseBoostyCredentials('просто текст'), null);
    assert.equal(parseBoostyCredentials('auth=%7B%22accessToken%22%3A%22a%22%7D'), null);
});

test('блог: адрес или имя', () => {
    assert.equal(normalizeBlog('https://boosty.to/niki_wright'), 'niki_wright');
    assert.equal(normalizeBlog('boosty.to/niki/posts/123'), 'niki');
    assert.equal(normalizeBlog(' @niki '), 'niki');
    assert.equal(normalizeBlog('плохое имя'), '');
    assert.equal(normalizeBlog('../etc'), '');
});

test('сохранение токена: туда и обратно, без блога — не принимается', () => {
    const creds = {...parseBoostyCredentials(COOKIE), blog: 'niki'};
    assert.deepEqual(deserializeCredentials(serializeCredentials(creds)), creds);
    assert.equal(deserializeCredentials(serializeCredentials({...creds, blog: ''})), null);
    assert.equal(deserializeCredentials('{bad'), null);
});

test('обновление токена: форма, ответ, ротация', async () => {
    const calls = [];
    const fetch = async (url, opts) => {
        calls.push([url, opts]);
        return {ok: true, status: 200, json: async () => ({access_token: 'acc2', refresh_token: 'ref2', expires_in: 3600})};
    };
    const next = await refreshBoostyTokens(fetch, {accessToken: 'acc1', refreshToken: 'ref1', deviceId: 'dev-1', blog: 'niki'}, START_TIME);
    assert.equal(calls[0][0], 'https://api.boosty.to/oauth/token/');
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0][1].body)), {
        device_id: 'dev-1', device_os: 'web', grant_type: 'refresh_token', refresh_token: 'ref1'
    });
    assert.deepEqual(next, {accessToken: 'acc2', refreshToken: 'ref2', expiresAt: START_TIME + 3600 * 1000, deviceId: 'dev-1', blog: 'niki'});
});

test('обновление токена: отказ сервера — ошибка авторизации', async () => {
    const fetch = async () => ({ok: false, status: 400, json: async () => ({error: 'invalid_grant'})});
    await assert.rejects(() => refreshBoostyTokens(fetch, {accessToken: 'a', refreshToken: 'r', deviceId: 'd'}), (e) => e.status === 401);
    await assert.rejects(() => refreshBoostyTokens(fetch, {accessToken: 'a', refreshToken: 'r', deviceId: ''}), (e) => e.status === 401);
});

function createBoostyEnv({creds = {...AUTH_JSON, deviceId: 'dev-1', blog: 'niki'}, since = START_TIME - 60000, levels, donations = [], events = [], overrides = {}} = {}) {
    const env = createServiceEnv();
    const ctx = {
        stored: creds ? serializeCredentials(creds) : '',
        donationModeEnabled: true,
        authInvalid: 0,
        saved: [],
        refreshCalls: 0,
        api: {
            levels: levels || {status: 200, json: {data: [
                {id: 11, name: 'Базовый', price: 300, currencyPrices: {RUB: 300}},
                {id: 12, name: 'VIP', price: 1500}
            ]}},
            donations: {status: 200, json: {data: {donationsSales: donations}, extra: {offset: '', total: donations.length}}},
            events: {status: 200, json: {data: events, extra: {isLast: true}}},
            refresh: {status: 200, json: {access_token: 'acc2', refresh_token: 'ref2', expires_in: 3600}},
            ...overrides
        }
    };
    const donationsReceived = [];
    const statuses = [];
    const stateStore = {data: {since, lastEventSec: 0, processedIds: []}};
    env.onFetch(async (url, opts) => {
        if (url.endsWith('/oauth/token/')) {
            ctx.refreshCalls++;
            return ctx.api.refresh;
        }
        const r = url.includes('/subscription_level/') ? ctx.api.levels
            : url.includes('/sales/donation/') ? ctx.api.donations
                : url.includes('/events') ? ctx.api.events : {status: 404};
        return typeof r === 'function' ? r(url, opts) : r;
    });
    const service = createBoosty({
        ...env.deps,
        getCredentials: () => ctx.stored,
        saveCredentials: async (s) => {
            ctx.saved.push(s);
            ctx.stored = s;
        },
        isDonationModeEnabled: () => ctx.donationModeEnabled,
        onDonation: (amount, meta) => donationsReceived.push([amount, meta.kind]),
        onStatus: (s) => statuses.push(s),
        onAuthInvalid: () => ctx.authInvalid++,
        state: {
            load: () => JSON.parse(JSON.stringify(stateStore.data)),
            save: (d) => {
                stateStore.data = JSON.parse(JSON.stringify(d));
            }
        }
    });
    return {env, ctx, service, donations: donationsReceived, statuses, stateStore, authHeaders: () => env.fetchLog.filter((r) => !r.url.endsWith('/oauth/token/')).map((r) => r.headers.Authorization)};
}

const donation = (id, amount, offsetSec = 0) => ({id, amount, createdAt: SEC + offsetSec, user: {name: 'u'}});
const event = (eventType, levelId, offsetSec = 0, userId = 1, amount = 999) => ({eventType, levelId, amount, createdAt: SEC + offsetSec, user: {id: userId}});

test('опрос: донаты по сумме, подписки и продления по цене уровня, старые не засчитываются', async () => {
    const b = createBoostyEnv({
        donations: [donation(1, 200, 5), donation(0, 999, -3600)],
        events: [event('subscribe', 11, 10), event('recurrent', 12, 20, 2), event('subscribe', 12, -3600, 3), event('unsubscribe', 11, 30)]
    });
    b.service.start();
    await b.env.clock.flush();
    assert.deepEqual(b.donations, [[200, 'donation'], [300, 'subscription'], [1500, 'renewal']]);
    assert.deepEqual(b.statuses, ['disconnected', 'connected']);
    const eventsCall = b.env.fetchLog.find((r) => r.url.includes('/events'));
    assert.match(eventsCall.url, /\/v1\/blog\/stat\/niki\/events\?/);
    assert.match(eventsCall.url, /event_types=subscribe%2Crecurrent/);
    assert.ok(b.authHeaders().every((h) => h === 'Bearer acc1'));
});

test('опрос раз в 20 с, повторно ничего не засчитывается, новое — засчитывается', async () => {
    const b = createBoostyEnv({donations: [donation(1, 200, 5)], events: [event('subscribe', 11, 10)]});
    b.service.start();
    await b.env.clock.flush();
    b.ctx.api.donations = {status: 200, json: {data: {donationsSales: [donation(2, 50, 40), donation(1, 200, 5)]}}};
    b.ctx.api.events = {status: 200, json: {data: [event('subscribe', 11, 10), event('recurrent', 11, 45, 7)]}};
    await b.env.clock.advance(19000);
    assert.equal(b.donations.length, 2);
    await b.env.clock.advance(1500);
    assert.deepEqual(b.donations, [[200, 'donation'], [300, 'subscription'], [50, 'donation'], [300, 'renewal']]);
});

test('обработанное сохраняется: после перезапуска не засчитывается повторно', async () => {
    const b = createBoostyEnv({donations: [donation(1, 200, 5)], events: [event('subscribe', 11, 10)]});
    b.service.start();
    await b.env.clock.flush();
    b.service.stop();
    const saved = b.stateStore.data;
    assert.ok(saved.processedIds.includes('d:1'));

    const b2 = createBoostyEnv({since: saved.since, donations: [donation(1, 200, 5)], events: [event('subscribe', 11, 10)]});
    b2.stateStore.data = saved;
    b2.service.start();
    await b2.env.clock.flush();
    assert.deepEqual(b2.donations, []);
});

test('первый запуск: точка отсчёта — сейчас, история не засчитывается', async () => {
    const b = createBoostyEnv({since: 0, donations: [donation(1, 200, -10)], events: [event('subscribe', 11, -10)]});
    b.service.start();
    await b.env.clock.flush();
    assert.deepEqual(b.donations, []);
    assert.equal(b.stateStore.data.since, START_TIME);
});

test('неизвестный уровень: список уровней перечитывается, иначе берётся сумма события', async () => {
    const b = createBoostyEnv({events: [event('subscribe', 99, 10, 1, 700)]});
    b.service.start();
    await b.env.clock.flush();
    assert.deepEqual(b.donations, [[700, 'subscription']]);
    assert.equal(b.env.fetchLog.filter((r) => r.url.includes('/subscription_level/')).length, 2);
});

test('донат-режим выключен: ничего не засчитывается и позже тоже', async () => {
    const b = createBoostyEnv({donations: [donation(1, 200, 5)], events: [event('subscribe', 11, 10)]});
    b.ctx.donationModeEnabled = false;
    b.service.start();
    await b.env.clock.flush();
    b.ctx.donationModeEnabled = true;
    await b.env.clock.advance(20000);
    assert.deepEqual(b.donations, []);
});

test('токен скоро истечёт: обновляется заранее, новая пара сохраняется', async () => {
    const b = createBoostyEnv({creds: {...AUTH_JSON, expiresAt: START_TIME + 30000, deviceId: 'dev-1', blog: 'niki'}, donations: [donation(1, 200, 5)]});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.ctx.refreshCalls, 1);
    assert.equal(deserializeCredentials(b.ctx.saved.at(-1)).refreshToken, 'ref2');
    assert.ok(b.authHeaders().every((h) => h === 'Bearer acc2'));
    assert.deepEqual(b.donations, [[200, 'donation']]);
});

test('401: токен обновляется и запрос повторяется', async () => {
    let first = true;
    const b = createBoostyEnv({overrides: {levels: () => {
        if (first) {
            first = false;
            return {status: 401};
        }
        return {status: 200, json: {data: []}};
    }}});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.ctx.refreshCalls, 1);
    assert.equal(b.statuses.at(-1), 'connected');
});

test('токен отозван: опрос останавливается, main получает сигнал', async () => {
    const b = createBoostyEnv({overrides: {levels: {status: 401}, refresh: {status: 400, json: {error: 'invalid_grant'}}}});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.ctx.authInvalid, 1);
    assert.equal(b.statuses.at(-1), 'error');
    const n = b.env.fetchLog.length;
    await b.env.clock.advance(120000);
    assert.equal(b.env.fetchLog.length, n);
});

test('чужой блог (403): опрос останавливается', async () => {
    const b = createBoostyEnv({overrides: {events: {status: 403}}});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.ctx.authInvalid, 1);
});

test('429 и ошибки сети: повтор с растущей задержкой и учётом Retry-After', async () => {
    const b = createBoostyEnv({overrides: {levels: {status: 429, headers: {'Retry-After': '40'}}}});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.statuses.at(-1), 'error');
    const calls = () => b.env.fetchLog.filter((r) => r.url.includes('/subscription_level/')).length;
    assert.equal(calls(), 1);
    await b.env.clock.advance(39000);
    assert.equal(calls(), 1);
    b.ctx.api.levels = {status: 200, json: {data: []}};
    await b.env.clock.advance(2000);
    assert.equal(calls(), 2);
    assert.equal(b.statuses.at(-1), 'connected');
});

test('без токена — «отключено»; restart с новым токеном подключает', async () => {
    const b = createBoostyEnv({creds: null});
    b.service.start();
    await b.env.clock.flush();
    assert.deepEqual(b.statuses, ['disconnected']);
    assert.equal(b.env.fetchLog.length, 0);
    b.ctx.stored = serializeCredentials({...AUTH_JSON, deviceId: 'dev-1', blog: 'niki'});
    b.service.restart();
    await b.env.clock.flush();
    assert.equal(b.statuses.at(-1), 'connected');
});

test('неожиданный формат ответа не роняет опрос', async () => {
    const b = createBoostyEnv({overrides: {donations: {status: 200, json: {weird: true}}, events: {status: 200, json: {data: 'x'}}}});
    b.service.start();
    await b.env.clock.flush();
    assert.equal(b.statuses.at(-1), 'connected');
    assert.deepEqual(b.donations, []);
});
