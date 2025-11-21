const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html':'text/html; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.svg':'image/svg+xml',
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.gif':'image/gif',
    '.woff2':'font/woff2'
  })[ext] || 'application/octet-stream';
}

function resolveOverlayDir() {
  try {
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, 'overlay');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return path.join(__dirname, 'overlay');
}

function startOverlayServer(opts = {}) {
  const host = opts.host || '0.0.0.0';
  const port = Number(opts.port || 41701);
  const basePath = (opts.basePath || '/overlay').replace(/\/+$/, '');
  const overlayDir = opts.overlayDir || resolveOverlayDir();

  let latestState = { remaining: '00:00:00', subtitle: '', color: '#ffffff' };
  const sseClients = new Set();

  function sendSSE(res, payloadObj) {
    try { res.write(`data: ${JSON.stringify(payloadObj)}\n\n`); }
    catch { try { res.end(); } finally { sseClients.delete(res); } }
  }

  function safeJoin(root, rel) {
    const p = path.normalize(path.join(root, rel));
    if (!p.startsWith(root)) throw new Error('Forbidden path');
    return p;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');

    // SSE
    if (u.pathname === basePath + '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      sendSSE(res, { type: 'bootstrap', state: latestState });
      sseClients.add(res);
      req.on('close', () => { try { res.end(); } finally { sseClients.delete(res); } });
      return;
    }

    // JSON-состояние
    if (u.pathname === basePath + '/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(latestState));
      return;
    }

    // Статические файлы
    if (u.pathname.startsWith(basePath)) {
      let filePath = u.pathname.slice(basePath.length).replace(/^\/+/, '');
      if (!filePath) filePath = 'index.html';
      try {
        const full = safeJoin(overlayDir, filePath);
        fs.readFile(full, (err, buf) => {
          if (err) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': mime(full) });
          res.end(buf);
        });
      } catch {
        res.writeHead(403); res.end('Forbidden');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(port, host, () => {
    console.log(`[overlay] dir=${overlayDir}`);
    console.log(`[overlay] URL: http://${host}:${port}${basePath}/`);
  });

  // Вызывайте это из своего таймера
  function push(partial) {
    latestState = Object.assign({}, latestState, partial || {});
    const payload = { type: 'tick', state: latestState };
    for (const res of Array.from(sseClients)) sendSSE(res, payload);
  }

  return { server, push, getState: () => latestState };
}

module.exports = { startOverlayServer };