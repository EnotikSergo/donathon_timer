const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServiceEnv} = require('./helpers/fake_env');
const {createDonationAlerts} = require('../core/donations/donation_alerts');

const CHANNEL = '$alerts:donation_5';

function createDaEnv({token = 'tok', list = [], oauth = null, listResponse = null} = {}) {
    const env = createServiceEnv();
    const state = {oauth, list: listResponse || {status: 200, json: {data: list}}};
    const donations = [];
    const statuses = [];
    const ctx = {token, donationModeEnabled: true, authInvalid: 0};
    env.onFetch(async (url) => {
        if (url.endsWith('/user/oauth')) return state.oauth || {status: 200, json: {data: {id: 5, socket_connection_token: 'sock'}}};
        if (url.endsWith('/centrifuge/subscribe')) return {status: 200, json: {channels: [{channel: CHANNEL, token: 'chan'}]}};
        if (url.endsWith('/alerts/donations')) return state.list;
        return {status: 404};
    });
    const service = createDonationAlerts({
        ...env.deps,
        getToken: () => ctx.token,
        isDonationModeEnabled: () => ctx.donationModeEnabled,
        onDonation: (amount) => donations.push(amount),
        onStatus: (status) => statuses.push(status),
        onAuthInvalid: () => ctx.authInvalid++
    });
    service.start();

    const da = {
        env,
        ctx,
        service,
        state,
        donations,
        ws: () => env.sockets.at(-1),
        statuses: () => statuses,
        oauthCalls: () => env.fetchLog.filter((r) => r.url.endsWith('/user/oauth')).length,
        async handshake() {
            await env.clock.flush();
            const ws = da.ws();
            ws.serverOpen();
            await env.clock.flush();
            const connect = JSON.parse(ws.sent.at(-1));
            assert.deepEqual(connect.params, {token: 'sock'});
            ws.serverMessage(JSON.stringify({id: connect.id, result: {client: 'c1'}}));
            await env.clock.flush();
            const sub = JSON.parse(ws.sent.at(-1));
            assert.equal(sub.method, 1);
            assert.deepEqual(sub.params, {channel: CHANNEL, token: 'chan'});
            ws.serverMessage(JSON.stringify({id: sub.id, result: {}}));
            await env.clock.flush();
        },
        push(id, fields = {}) {
            da.ws().serverMessage(JSON.stringify({
                result: {
                    channel: CHANNEL,
                    data: {data: {id, amount: '100', currency: 'RUB', amount_in_user_currency: 100, username: 'u', ...fields}}
                }
            }));
        },
        autoPong(ws = da.ws()) {
            const control = {enabled: true, pings: 0};
            const original = ws.send.bind(ws);
            ws.send = (data) => {
                original(data);
                const msg = JSON.parse(data);
                if (msg.method === 7) {
                    control.pings++;
                    if (control.enabled) setImmediate(() => ws.serverMessage(JSON.stringify({id: msg.id})));
                }
            };
            return control;
        }
    };
    return da;
}

async function connectedDa(opts) {
    const da = createDaEnv(opts);
    await da.handshake();
    return da;
}

test('подключение: профиль → WebSocket → подписка, статус «подключено»', async () => {
    const da = await connectedDa();
    assert.deepEqual(da.statuses(), ['disconnected', 'connected']);
    assert.equal(da.env.fetchLog[0].headers.Authorization, 'Bearer tok');
});

test('при первом подключении старые донаты из списка не засчитываются', async () => {
    const da = await connectedDa({list: [{id: 100, amount: '500', currency: 'RUB'}, {id: 99, amount: '50', currency: 'RUB'}]});
    assert.deepEqual(da.donations, []);
});

test('донат засчитывается один раз', async () => {
    const da = await connectedDa();
    da.push(101);
    da.push(101);
    await da.env.clock.flush();
    assert.deepEqual(da.donations, [100]);
});

test('валюта: сумма в основной валюте; рубли без конвертации; чужая валюта без конвертации не засчитывается', async () => {
    const da = await connectedDa();
    da.push(1, {amount: '5', currency: 'USD', amount_in_user_currency: 450});
    da.push(2, {amount: '5', currency: 'USD', amount_in_user_currency: undefined});
    da.push(3, {amount: '200', currency: 'RUB', amount_in_user_currency: undefined});
    await da.env.clock.flush();
    assert.deepEqual(da.donations, [450, 200]);
});

test('донат при выключенном донат-режиме не засчитывается ни сейчас, ни позже', async () => {
    const da = await connectedDa();
    da.ctx.donationModeEnabled = false;
    da.push(7);
    da.ctx.donationModeEnabled = true;
    da.push(7);
    await da.env.clock.flush();
    assert.deepEqual(da.donations, []);
});

test('событие join (type 1) не влияет на состояние', async () => {
    const da = await connectedDa();
    da.ws().serverMessage(JSON.stringify({result: {type: 1, channel: CHANNEL}}));
    await da.env.clock.flush();
    assert.equal(da.statuses().at(-1), 'connected');
    assert.deepEqual(da.donations, []);
});

test('проверка связи — ping по сокету каждые 25 с, без REST-запросов', async () => {
    const da = await connectedDa();
    const pong = da.autoPong();
    const before = da.oauthCalls();
    await da.env.clock.advance(100000);
    assert.equal(pong.pings, 4);
    assert.equal(da.oauthCalls(), before);
    assert.equal(da.statuses().at(-1), 'connected');
});

test('один пропущенный ping не рвёт соединение', async () => {
    const da = await connectedDa();
    const pong = da.autoPong();
    pong.enabled = false;
    await da.env.clock.advance(35000);
    pong.enabled = true;
    await da.env.clock.advance(25000);
    assert.equal(da.ws().closed, false);
    assert.equal(da.statuses().at(-1), 'connected');
});

test('два пропущенных ping подряд → разрыв и переподключение', async () => {
    const da = await connectedDa();
    const ws = da.ws();
    const pong = da.autoPong();
    pong.enabled = false;
    await da.env.clock.advance(60000);
    assert.equal(ws.closed, true);
    assert.equal(da.statuses().at(-1), 'error');
    await da.env.clock.advance(1600);
    assert.equal(da.env.sockets.length, 2);
});

test('после переподключения досчитываются пропущенные донаты по порядку', async () => {
    const da = await connectedDa({list: [{id: 100}]});
    da.push(101);
    await da.env.clock.flush();
    da.state.list = {status: 200, json: {data: [
        {id: 103, amount: '300', currency: 'RUB'},
        {id: 102, amount: '50', currency: 'RUB'},
        {id: 101, amount: '100', currency: 'RUB'}
    ]}};
    da.ws().serverClose(1006);
    await da.env.clock.advance(1600);
    await da.handshake();
    assert.deepEqual(da.donations, [100, 50, 300]);
});

test('без доступа к списку донатов подключение работает как обычно', async () => {
    const da = createDaEnv({listResponse: {status: 403}});
    await da.handshake();
    assert.equal(da.statuses().at(-1), 'connected');
    da.push(1);
    await da.env.clock.flush();
    assert.deepEqual(da.donations, [100]);
});

test('индикатор не мигает при переподключении', async () => {
    const da = await connectedDa();
    da.ws().serverClose(1006);
    await da.env.clock.advance(1600);
    await da.handshake();
    assert.deepEqual(da.statuses(), ['disconnected', 'connected', 'error', 'connected']);
});

test('задержка переподключения растёт до 30 с', async () => {
    const da = await connectedDa();
    da.state.oauth = {status: 500};
    da.ws().serverClose(1006);
    const delays = [];
    let calls = da.oauthCalls();
    let last = da.env.clock.now();
    for (let i = 0; i < 7; i++) {
        while (da.oauthCalls() === calls) await da.env.clock.advance(100);
        delays.push(Math.floor((da.env.clock.now() - last) / 1000));
        calls = da.oauthCalls();
        last = da.env.clock.now();
    }
    assert.deepEqual(delays, [1, 2, 4, 8, 16, 30, 30]);
});

test('401 → переподключения прекращаются, main получает auth:invalid', async () => {
    const da = createDaEnv({oauth: {status: 401}});
    await da.env.clock.advance(100);
    const calls = da.oauthCalls();
    await da.env.clock.advance(120000);
    assert.equal(da.oauthCalls(), calls);
    assert.equal(da.statuses().at(-1), 'error');
    assert.equal(da.ctx.authInvalid, 1);
});

test('restart: новый токен подключает заново, пустой — отключает', async () => {
    const da = createDaEnv({oauth: {status: 401}});
    await da.env.clock.advance(100);
    da.state.oauth = null;
    da.ctx.token = 'tok2';
    da.service.restart();
    await da.handshake();
    assert.equal(da.statuses().at(-1), 'connected');
    assert.equal(da.env.fetchLog.at(-1).headers.Authorization, 'Bearer tok2');

    da.ctx.token = '';
    da.service.restart();
    await da.env.clock.flush();
    assert.equal(da.statuses().at(-1), 'disconnected');
});
