const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserEnv, START_TIME} = require('./helpers/fake_env');

const RS = '\x1e';
const iso = (ms) => new Date(ms).toISOString();

function createDxEnv({token = 'dxtok', lastProcessed = START_TIME - 60000, processedIds, list = [], neg = null, me = null, listResponse = null} = {}) {
    const localStorage = {dx_last_processed_ts: String(lastProcessed)};
    if (processedIds) localStorage.dx_processed_ids = JSON.stringify(processedIds);
    const env = createBrowserEnv({localStorage});
    const state = {neg, list: listResponse || {status: 200, json: list}, me};
    const donations = [];
    env.ctx.donateXToken = token;
    env.ctx.donationModeEnabled = true;
    env.ctx.handleDonationWithGoalSystem = (amount) => donations.push(amount);
    env.onFetch(async (url) => {
        if (url.includes('/public-donations-hub/negotiate')) {
            return state.neg || {status: 200, json: {connectionToken: 'ctok', availableTransports: [{transport: 'WebSockets'}]}};
        }
        if (url.includes('/v1/donations')) return state.list;
        if (url.includes('/v1/user/me')) return state.me || {status: 200, json: {username: 'x'}};
        return {status: 404};
    });
    env.load('js/api/donateX.js');

    const dx = {
        env,
        state,
        donations,
        ws: () => env.sockets.at(-1),
        statuses: () => env.statuses('DX'),
        calls: (part) => env.fetchLog.filter((r) => r.url.includes(part)).length,
        async handshake() {
            await env.clock.flush();
            const ws = dx.ws();
            ws.serverOpen();
            await env.clock.flush();
            assert.equal(ws.sent.at(-1), JSON.stringify({protocol: 'json', version: 1}) + RS);
            ws.serverMessage('{}' + RS);
            await env.clock.flush();
        },
        invoke(target, donation) {
            dx.ws().serverMessage(JSON.stringify({type: 1, target, arguments: [donation]}) + RS);
        }
    };
    return dx;
}

async function connectedDx(opts) {
    const dx = createDxEnv(opts);
    await dx.handshake();
    return dx;
}

test('подключение: negotiate → WebSocket с токеном → handshake', async () => {
    const dx = await connectedDx();
    const negotiate = dx.env.fetchLog.find((r) => r.url.includes('negotiate'));
    assert.equal(negotiate.method, 'POST');
    assert.match(negotiate.url, /access_token=dxtok/);
    assert.match(dx.ws().url, /^wss:\/\/donatex\.gg\/api\/public-donations-hub\?id=ctok&access_token=dxtok$/);
    assert.deepEqual(dx.statuses(), ['disconnected', 'connected']);
});

test('список донатов запрашивается с токеном в заголовке, не в адресе', async () => {
    const dx = await connectedDx();
    const req = dx.env.fetchLog.find((r) => r.url.includes('/v1/donations'));
    assert.deepEqual(req.headers, {'X-External-Token': 'dxtok'});
    assert.doesNotMatch(req.url, /token=/);
});

test('при подключении досчитываются только донаты новее последнего обработанного, по порядку; тестовые засчитываются', async () => {
    const dx = await connectedDx({list: [
        {id: 'n2', timestamp: iso(START_TIME - 10000), amountInRub: 200, isTest: true},
        {id: 'n1', timestamp: iso(START_TIME - 30000), amountInRub: 100},
        {id: 'old', timestamp: iso(START_TIME - 120000), amountInRub: 999}
    ]});
    assert.deepEqual(dx.donations, [100, 200]);
});

test('Created и Rerun одного доната засчитываются один раз', async () => {
    const dx = await connectedDx();
    const d = {id: 'r1', timestamp: iso(START_TIME), amountInRub: 50};
    dx.invoke('DonationCreated', d);
    dx.invoke('DonationRerun', d);
    await dx.env.clock.flush();
    assert.deepEqual(dx.donations, [50]);
});

test('Rerun нового доната (после модерации) засчитывается; имена событий без учёта регистра', async () => {
    const dx = await connectedDx();
    dx.invoke('donationrerun', {id: 'mod1', timestamp: iso(START_TIME - 300000), amountInRub: 70});
    dx.invoke('GoalUpdated', {id: 'g'});
    await dx.env.clock.flush();
    assert.deepEqual(dx.donations, [70]);
});

test('сообщение, разбитое на части, собирается', async () => {
    const dx = await connectedDx();
    const raw = JSON.stringify({type: 1, target: 'DonationCreated', arguments: [{id: 's1', timestamp: iso(START_TIME), amountInRub: 30}]}) + RS;
    dx.ws().serverMessage(raw.slice(0, 15));
    dx.ws().serverMessage(raw.slice(15));
    await dx.env.clock.flush();
    assert.deepEqual(dx.donations, [30]);
});

test('обработанные id сохраняются и учитываются после перезапуска', async () => {
    const dx = await connectedDx();
    dx.invoke('DonationCreated', {id: 'p1', timestamp: iso(START_TIME), amountInRub: 10});
    await dx.env.clock.flush();
    const saved = JSON.parse(dx.env.ctx.localStorage.getItem('dx_processed_ids'));
    assert.deepEqual(saved, ['p1']);

    const dx2 = await connectedDx({processedIds: saved});
    dx2.invoke('DonationRerun', {id: 'p1', timestamp: iso(START_TIME), amountInRub: 10});
    await dx2.env.clock.flush();
    assert.deepEqual(dx2.donations, []);
});

test('донат при выключенном донат-режиме не засчитывается ни сейчас, ни позже', async () => {
    const dx = await connectedDx();
    dx.env.ctx.donationModeEnabled = false;
    dx.invoke('DonationCreated', {id: 'off', timestamp: iso(START_TIME), amountInRub: 10});
    dx.env.ctx.donationModeEnabled = true;
    dx.invoke('DonationRerun', {id: 'off', timestamp: iso(START_TIME), amountInRub: 10});
    await dx.env.clock.flush();
    assert.deepEqual(dx.donations, []);
});

test('ping каждые 15 с; если сервер молчит дольше 35 с — переподключение', async () => {
    const dx = await connectedDx();
    const ws = dx.ws();
    for (let i = 0; i < 4; i++) {
        await dx.env.clock.advance(15000);
        ws.serverMessage(JSON.stringify({type: 6}) + RS);
    }
    assert.equal(ws.sent.filter((m) => m === JSON.stringify({type: 6}) + RS).length, 4);
    assert.equal(dx.statuses().at(-1), 'connected');
    await dx.env.clock.advance(45000);
    assert.equal(ws.closed, true);
    assert.equal(dx.statuses().at(-1), 'error');
});

test('после переподключения досчитывается донат, пришедший во время обрыва; индикатор не мигает', async () => {
    const dx = await connectedDx();
    dx.ws().serverClose(1006);
    dx.state.list = {status: 200, json: [{id: 'gap', timestamp: iso(START_TIME + 5000), amountInRub: 300}]};
    await dx.env.clock.advance(1600);
    await dx.handshake();
    assert.deepEqual(dx.donations, [300]);
    assert.deepEqual(dx.statuses(), ['disconnected', 'connected', 'error', 'connected']);
});

test('сообщение Close от сервера → переподключение', async () => {
    const dx = await connectedDx();
    dx.ws().serverMessage(JSON.stringify({type: 7, error: 'bye'}) + RS);
    await dx.env.clock.flush();
    assert.equal(dx.statuses().at(-1), 'error');
    await dx.env.clock.advance(1600);
    await dx.handshake();
    assert.equal(dx.statuses().at(-1), 'connected');
});

test('429 при подключении → следующая попытка не раньше Retry-After', async () => {
    const dx = createDxEnv({neg: {status: 429, headers: {'Retry-After': '20'}}});
    await dx.env.clock.advance(100);
    const n = dx.calls('negotiate');
    await dx.env.clock.advance(19000);
    assert.equal(dx.calls('negotiate'), n);
    await dx.env.clock.advance(1600);
    assert.equal(dx.calls('negotiate'), n + 1);
});

test('хаб не принял токен, но токен рабочий → опрос раз в 15 с', async () => {
    const dx = createDxEnv({neg: {status: 401}, list: [{id: 'p1', timestamp: iso(START_TIME + 1000), amountInRub: 40}]});
    await dx.env.clock.advance(100);
    assert.equal(dx.statuses().at(-1), 'connected');
    assert.deepEqual(dx.donations, [40]);
    const n = dx.calls('/v1/donations');
    await dx.env.clock.advance(60000);
    assert.equal(dx.calls('/v1/donations'), n + 4);
    assert.equal(dx.calls('negotiate'), 1);
});

test('токен отозван во время опроса → опрос остановлен, main получает auth:invalid', async () => {
    const dx = createDxEnv({neg: {status: 401}});
    await dx.env.clock.advance(100);
    dx.state.list = {status: 401};
    await dx.env.clock.advance(15000);
    const n = dx.env.fetchLog.length;
    await dx.env.clock.advance(120000);
    assert.equal(dx.env.fetchLog.length, n);
    assert.equal(dx.statuses().at(-1), 'error');
    assert.deepEqual(dx.env.ipc.sentOn('auth:invalid'), ['donateX']);
});

test('неверный токен при запуске → без бесконечных попыток', async () => {
    const dx = createDxEnv({neg: {status: 401}, me: {status: 401}});
    await dx.env.clock.advance(100);
    const n = dx.env.fetchLog.length;
    await dx.env.clock.advance(120000);
    assert.equal(dx.env.fetchLog.length, n);
    assert.equal(dx.statuses().at(-1), 'error');
    assert.deepEqual(dx.env.ipc.sentOn('auth:invalid'), ['donateX']);
});

test('restart: новый токен подключает заново, пустой — отключает', async () => {
    const dx = createDxEnv({neg: {status: 401}, me: {status: 401}});
    await dx.env.clock.advance(100);
    dx.state.neg = null;
    dx.env.ctx.donateXToken = 'new';
    dx.env.ctx.donationServices.DX.restart();
    await dx.handshake();
    assert.equal(dx.statuses().at(-1), 'connected');
    assert.match(dx.ws().url, /access_token=new/);

    dx.env.ctx.donateXToken = '';
    dx.env.ctx.donationServices.DX.restart();
    await dx.env.clock.flush();
    assert.equal(dx.statuses().at(-1), 'disconnected');
});
