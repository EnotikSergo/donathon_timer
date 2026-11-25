const {test, after, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const {startOverlayServer} = require('../core/overlay_server');

const ROOT = path.resolve(__dirname, '..');
const VIEW_DIR = path.join(ROOT, 'view');
const AUTH_PAGE = path.join(ROOT, 'auth', 'auth_success.html');

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const {port} = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function request(port, path, {method = 'GET', headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, path, method, headers}, (res) => {
            let data = '';
            res.on('error', reject);
            res.on('data', (d) => data += d);
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const servers = [];

beforeEach((t) => {
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
});

async function start(opts = {}) {
    const port = await freePort();
    const callbacks = [];
    const ctx = {
        port,
        callbacks,
        pending: true,
        server: null
    };
    ctx.server = startOverlayServer({
        port,
        host: '127.0.0.1',
        basePath: '/overlay',
        overlayDir: VIEW_DIR,
        authPagePath: AUTH_PAGE,
        isAuthPending: () => ctx.pending,
        onAuthCallback: async (service, payload) => {
            callbacks.push([service, payload]);
            return {ok: true};
        },
        ...opts
    });
    servers.push(ctx.server);
    await new Promise((r) => setTimeout(r, 50));
    return ctx;
}

after(async () => {
    for (const s of servers) await s.close();
});

const json = (obj) => ({
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(obj)
});

test('оверлей: страница, состояние, шрифт; /overlay → /overlay/', async () => {
    const {port, server} = await start();
    server.push({remaining: '01:02:03'});

    const page = await request(port, '/overlay/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /fonts\/nunito\.css/);
    assert.match(page.body, /view\.js/);
    assert.doesNotMatch(page.body, /fonts\.googleapis/);

    const state = await request(port, '/overlay/state');
    assert.equal(JSON.parse(state.body).remaining, '01:02:03');

    const font = await request(port, '/overlay/fonts/nunito-cyrillic-wght-normal.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');

    const redirect = await request(port, '/overlay');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/overlay/');
});

test('оверлей: выход за папку оверлея запрещён', async () => {
    const {port} = await start();
    assert.equal((await request(port, '/overlay/..%2Fmain.js')).status, 403);
    assert.equal((await request(port, '/overlay/..%2F..%2Fpackage.json')).status, 403);
    assert.equal((await request(port, '/main.js')).status, 404);
});

test('оверлей: только чтение', async () => {
    const {port} = await start();
    assert.equal((await request(port, '/overlay/state', {method: 'POST'})).status, 404);
});

test('SSE: начальное состояние и обновления', async () => {
    const {port, server} = await start();
    server.push({remaining: '00:00:10'});
    const received = await new Promise((resolve, reject) => {
        const chunks = [];
        const req = http.get({host: '127.0.0.1', port, path: '/overlay/sse'}, (res) => {
            res.setEncoding('utf8');
            res.on('data', (d) => {
                chunks.push(d);
                if (chunks.length === 1) server.push({remaining: '00:00:09'});
                if (chunks.join('').split('\n\n').filter(Boolean).length >= 2) {
                    req.destroy();
                    resolve(chunks.join(''));
                }
            });
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    const events = received.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
    assert.equal(events[0].type, 'bootstrap');
    assert.equal(events[0].state.remaining, '00:00:10');
    assert.equal(events[1].type, 'tick');
    assert.equal(events[1].state.remaining, '00:00:09');
});

test('авторизация: страница доступна только во время входа', async () => {
    const ctx = await start();
    ctx.pending = false;
    assert.equal((await request(ctx.port, '/auth/da')).status, 404);
    ctx.pending = true;
    const page = await request(ctx.port, '/auth/da');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
});

test('авторизация: старого /auth/save больше нет', async () => {
    const {port} = await start();
    assert.equal((await request(port, '/auth/save?service=donationAlerts&token=x')).status, 404);
});

test('авторизация: ответ принимается методом POST с JSON', async () => {
    const ctx = await start();
    const res = await request(ctx.port, '/auth/da/callback', json({access_token: 't', state: 's'}));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {ok: true});
    assert.deepEqual(ctx.callbacks, [['donationAlerts', {access_token: 't', state: 's'}]]);
});

test('авторизация: отказ для чужих сайтов, не-JSON, слишком большого тела и битого JSON', async () => {
    const ctx = await start();
    const cross = await request(ctx.port, '/auth/da/callback', {
        ...json({access_token: 't'}),
        headers: {'Content-Type': 'application/json', 'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'}
    });
    assert.equal(cross.status, 403);
    const text = await request(ctx.port, '/auth/da/callback', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: '{}'});
    assert.equal(text.status, 403);
    const big = await request(ctx.port, '/auth/da/callback', json({access_token: 'x'.repeat(10000)}));
    assert.equal(big.status, 413);
    assert.equal(big.headers.connection, 'close');
    const huge = await request(ctx.port, '/auth/da/callback', json({access_token: 'x'.repeat(2 * 1024 * 1024)}));
    assert.equal(huge.status, 413);
    const bad = await request(ctx.port, '/auth/da/callback', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{bad'});
    assert.equal(bad.status, 400);
    assert.equal(ctx.callbacks.length, 0);
});

test('авторизация: через туннель (CloudPub) и с чужим Host недоступна, оверлей — доступен', async () => {
    const ctx = await start();
    for (const headers of [{'X-Forwarded-For': '8.8.8.8'}, {'Forwarded': 'for=8.8.8.8'}, {'Host': 'x.cloudpub.ru'}]) {
        assert.equal((await request(ctx.port, '/auth/da', {headers})).status, 404);
        assert.equal((await request(ctx.port, '/auth/da/callback', {...json({access_token: 't'}), headers: {...headers, 'Content-Type': 'application/json'}})).status, 404);
    }
    assert.equal((await request(ctx.port, '/overlay/state', {headers: {'Host': 'x.cloudpub.ru', 'X-Forwarded-For': '8.8.8.8'}})).status, 200);
    assert.equal(ctx.callbacks.length, 0);
});

test('сервер закрывается и освобождает порт', async () => {
    const ctx = await start();
    await ctx.server.close();
    const again = startOverlayServer({port: ctx.port, host: '127.0.0.1', overlayDir: VIEW_DIR});
    servers.push(again);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await request(ctx.port, '/overlay/state')).status, 200);
});
