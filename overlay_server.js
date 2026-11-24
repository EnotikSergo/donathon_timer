const http = require('http');
const fs = require('fs');
const path = require('path');
const {URL} = require('url');

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const AUTH_PAGE_PATH = '/auth/da';
const AUTH_CALLBACK_PATH = '/auth/da/callback';
const MAX_AUTH_BODY = 8 * 1024;

function mime(file) {
    const ext = path.extname(file).toLowerCase();
    return ({
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.woff2': 'font/woff2'
    })[ext] || 'application/octet-stream';
}

function resolveOverlayDir() {
    try {
        if (process.resourcesPath) {
            const p = path.join(process.resourcesPath, 'overlay');
            if (fs.existsSync(p)) return p;
        }
    } catch {
    }
    return path.join(__dirname, 'overlay');
}

function isLocalRequest(req) {
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) return false;
    if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;

    const hostHeader = String(req.headers.host || '');
    const hostname = hostHeader.startsWith('[')
        ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
        : hostHeader.split(':')[0];
    return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function isCrossSiteRequest(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;

    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
        try {
            return new URL(origin).host !== req.headers.host;
        } catch {
            return true;
        }
    }
    return false;
}

function startOverlayServer(opts = {}) {
    const host = opts.host || '127.0.0.1';
    const port = Number(opts.port || 41701);
    const basePath = (opts.basePath || '/overlay').replace(/\/+$/, '');
    const overlayDir = path.resolve(opts.overlayDir || resolveOverlayDir());

    let latestState = {remaining: '00:00:00'};
    const sseClients = new Set();
    const sockets = new Set();

    function sendSSE(res, payloadObj) {
        try {
            res.write(`data: ${JSON.stringify(payloadObj)}\n\n`);
        } catch {
            try {
                res.end();
            } finally {
                sseClients.delete(res);
            }
        }
    }

    function safeJoin(root, rel) {
        const p = path.resolve(root, rel);
        if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Forbidden path');
        return p;
    }

    function notFound(res) {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Not found');
    }

    function sendJson(res, status, obj, extraHeaders = {}) {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extraHeaders
        });
        res.end(JSON.stringify(obj));
    }

    function handleAuthCallback(req, res) {
        if (isCrossSiteRequest(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) {
            sendJson(res, 403, {ok: false, error: 'forbidden'});
            return;
        }

        let size = 0;
        const chunks = [];
        let aborted = false;
        req.on('data', (chunk) => {
            if (aborted) return;
            size += chunk.length;
            if (size > MAX_AUTH_BODY) {
                aborted = true;
                chunks.length = 0;
                sendJson(res, 413, {ok: false, error: 'too_large'}, {'Connection': 'close'});
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (aborted) return;
            let payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                sendJson(res, 400, {ok: false, error: 'bad_json'});
                return;
            }
            try {
                const result = await opts.onAuthCallback('donationAlerts', payload);
                sendJson(res, result && result.ok ? 200 : 400, result || {ok: false});
            } catch (e) {
                sendJson(res, 500, {ok: false, error: 'internal'});
            }
        });
    }

    function handleAuth(req, res, u) {
        const pending = typeof opts.isAuthPending === 'function' && opts.isAuthPending('donationAlerts');
        if (!pending) {
            notFound(res);
            return;
        }

        if (u.pathname === AUTH_CALLBACK_PATH && req.method === 'POST' && typeof opts.onAuthCallback === 'function') {
            handleAuthCallback(req, res);
            return;
        }

        if (u.pathname === AUTH_PAGE_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
            const filePath = path.join(__dirname, 'auth_success.html');
            fs.readFile(filePath, (err, buf) => {
                if (err) {
                    notFound(res);
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer'
                });
                res.end(buf);
            });
            return;
        }

        notFound(res);
    }

    function handleOverlay(req, res, u) {
        if (u.pathname === basePath + '/sse') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            sendSSE(res, {type: 'bootstrap', state: latestState});
            sseClients.add(res);
            req.on('close', () => {
                try {
                    res.end();
                } finally {
                    sseClients.delete(res);
                }
            });
            return;
        }

        if (u.pathname === basePath + '/state') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(latestState));
            return;
        }

        let filePath = u.pathname.slice(basePath.length).replace(/^\/+/, '');
        if (!filePath) filePath = 'index.html';
        let full;
        try {
            full = safeJoin(overlayDir, decodeURIComponent(filePath));
        } catch {
            res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end('Forbidden');
            return;
        }
        fs.readFile(full, (err, buf) => {
            if (err) {
                notFound(res);
                return;
            }
            res.writeHead(200, {'Content-Type': mime(full)});
            res.end(buf);
        });
    }

    const server = http.createServer((req, res) => {
        let u;
        try {
            u = new URL(req.url, 'http://localhost');
        } catch {
            notFound(res);
            return;
        }

        const isOverlayPath = u.pathname === basePath || u.pathname.startsWith(basePath + '/');
        const isReadMethod = req.method === 'GET' || req.method === 'HEAD';

        if (u.pathname === basePath && isReadMethod) {
            res.writeHead(301, {'Location': basePath + '/' + u.search});
            res.end();
            return;
        }

        if (isOverlayPath && isReadMethod) {
            handleOverlay(req, res, u);
            return;
        }

        if (u.pathname.startsWith('/auth/') && isLocalRequest(req)) {
            handleAuth(req, res, u);
            return;
        }

        notFound(res);
    });

    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    server.on('error', (err) => {
        console.error(`[overlay] Ошибка сервера на ${host}:${port}:`, err.message);
    });

    server.listen(port, host, () => {
        console.log(`[overlay] dir=${overlayDir}`);
        console.log(`[overlay] URL: http://${host}:${port}${basePath}/`);
    });

    function push(partial) {
        latestState = Object.assign({}, latestState, partial || {});
        const payload = {type: 'tick', state: latestState};

        for (const res of Array.from(sseClients)) {
            sendSSE(res, payload);
        }
    }

    function pushEvent(event) {
        const payload = {type: 'event', event};

        for (const res of Array.from(sseClients)) {
            sendSSE(res, payload);
        }
    }

    function close() {
        return new Promise((resolve) => {
            for (const res of Array.from(sseClients)) {
                try {
                    res.end();
                } catch {
                }
            }
            sseClients.clear();
            server.close(() => resolve());
            for (const socket of sockets) socket.destroy();
            sockets.clear();
        });
    }

    return {push, pushEvent, close};
}

module.exports = {startOverlayServer};
