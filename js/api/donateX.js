(function () {
    'use strict';

    const SYSTEM = 'DX';
    const SERVICE = 'donateX';
    const API_BASE = 'https://donatex.gg/api';
    const HUB_URL = API_BASE + '/public-donations-hub';
    const DONATIONS_URL = API_BASE + '/v1/donations';
    const PROFILE_URL = API_BASE + '/v1/user/me';

    const API_TIMEOUT = 8000;
    const HANDSHAKE_TIMEOUT = 12000;
    const PING_INTERVAL = 15000;
    const SERVER_TIMEOUT = 35000;
    const RECONNECT_BASE = 1000;
    const RECONNECT_MAX = 30000;
    const RECONNECT_JITTER = 500;
    const FALLBACK_POLL_INTERVAL = 15000;
    const BACKFILL_TAKE = 50;
    const MAX_PROCESSED_IDS = 1000;
    const RECORD_SEPARATOR = '\x1e';

    const MSG_INVOCATION = 1;
    const MSG_PING = 6;
    const MSG_CLOSE = 7;

    let session = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let pollTimer = null;
    let pollingMode = false;
    let authFailed = false;
    let currentStatus = null;
    let offlineLogged = false;

    let lastProcessedTimestamp = Number(readStorage('dx_last_processed_ts'));
    if (!Number.isFinite(lastProcessedTimestamp) || lastProcessedTimestamp <= 0) {
        lastProcessedTimestamp = Date.now();
        writeStorage('dx_last_processed_ts', String(lastProcessedTimestamp));
    }

    const processedIds = new Set(parseIds(readStorage('dx_processed_ids')));

    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (_) {
        }
    }

    function parseIds(raw) {
        try {
            const arr = JSON.parse(raw || '[]');
            return Array.isArray(arr) ? arr.map(String) : [];
        } catch (_) {
            return [];
        }
    }

    function sendStatus(status) {
        if (status === currentStatus) return;
        currentStatus = status;
        try {
            ipcRenderer.send('donation:status', {system: SYSTEM, status});
        } catch (_) {
        }
    }

    function reportAuthInvalid() {
        try {
            ipcRenderer.send('auth:invalid', SERVICE);
        } catch (_) {
        }
    }

    async function request(url, {method = 'GET', token = donateXToken} = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
        try {
            const res = await fetch(url, {
                method,
                signal: controller.signal,
                headers: {'X-External-Token': token}
            });
            let json = null;
            try {
                json = await res.json();
            } catch (_) {
            }
            return {status: res.status, json, retryAfter: Number(res.headers.get('Retry-After'))};
        } finally {
            clearTimeout(timer);
        }
    }

    function clearReconnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function stopPolling() {
        pollingMode = false;
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function nextDelay() {
        const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, reconnectAttempt)) +
            Math.floor(Math.random() * RECONNECT_JITTER);
        reconnectAttempt++;
        return delay;
    }

    function scheduleReconnect(minDelay = 0) {
        if (reconnectTimer || authFailed) return;
        const delay = Math.max(minDelay, nextDelay());
        console.warn(`[DX] Переподключение через ${delay} мс`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function destroySession(s) {
        if (!s) return;
        s.dead = true;
        clearTimeout(s.watchdog);
        clearInterval(s.pingTimer);
        if (s.ws) {
            s.ws.onopen = null;
            s.ws.onmessage = null;
            s.ws.onerror = null;
            s.ws.onclose = null;
            try {
                s.ws.close();
            } catch (_) {
            }
            s.ws = null;
        }
    }

    function dropSession() {
        if (session) {
            destroySession(session);
            session = null;
        }
    }

    function fail(s, reason, minDelay = 0) {
        if (session !== s || s.dead) return;
        console.warn('[DX] Соединение прервано:', reason);
        sendStatus('error');
        dropSession();
        scheduleReconnect(minDelay);
    }

    function stopOnAuthError(reason) {
        console.error('[DX] Токен не принят, переподключение остановлено:', reason);
        authFailed = true;
        clearReconnect();
        stopPolling();
        dropSession();
        sendStatus('error');
        reportAuthInvalid();
    }

    function rememberDonation(id, ts) {
        processedIds.add(id);
        while (processedIds.size > MAX_PROCESSED_IDS) {
            processedIds.delete(processedIds.values().next().value);
        }
        writeStorage('dx_processed_ids', JSON.stringify(Array.from(processedIds)));

        if (Number.isFinite(ts) && ts > lastProcessedTimestamp) {
            lastProcessedTimestamp = ts;
            writeStorage('dx_last_processed_ts', String(lastProcessedTimestamp));
        }
    }

    function processDonation(donation, source) {
        if (!donation || !donation.id) return;

        const id = String(donation.id);
        if (processedIds.has(id)) return;

        const ts = new Date(donation.timestamp).getTime();
        if (source === 'backfill' && (!Number.isFinite(ts) || ts <= lastProcessedTimestamp)) return;

        rememberDonation(id, ts);

        const amount = Number(donation.amountInRub || donation.amount);
        if (!(amount > 0)) return;

        if (typeof window.donationModeEnabled !== 'undefined' && !window.donationModeEnabled) return;

        console.log(`[DX] ${amount} RUB от ${donation.username || 'Anon'}${donation.isTest ? ' (тестовый)' : ''}`);

        if (typeof handleDonationWithGoalSystem === 'function') {
            handleDonationWithGoalSystem(amount);
        }
    }

    async function backfill() {
        const url = `${DONATIONS_URL}?skip=0&take=${BACKFILL_TAKE}&sortOrder=NewestFirst`;
        let res;
        try {
            res = await request(url);
        } catch (e) {
            console.warn('[DX] Не удалось получить список донатов:', e.message);
            return {ok: false};
        }

        if (res.status === 401 || res.status === 403) return {ok: false, auth: true};
        if (res.status === 429) return {ok: false, retryAfter: res.retryAfter};
        if (res.status !== 200 || !Array.isArray(res.json)) {
            console.warn(`[DX] Список донатов: HTTP ${res.status}`);
            return {ok: false};
        }

        const list = res.json.slice().reverse();
        for (const d of list) processDonation(d, 'backfill');
        return {ok: true};
    }

    async function startPolling() {
        if (pollingMode) return;
        stopPolling();
        pollingMode = true;
        console.warn('[DX] Хаб не принял токен, донаты будут проверяться раз в 15 с');

        const tick = async () => {
            pollTimer = null;
            if (!pollingMode) return;

            const result = await backfill();
            if (!pollingMode) return;

            if (result.auth) return stopOnAuthError('HTTP 401/403 при опросе');
            sendStatus(result.ok ? 'connected' : 'error');

            const retryMs = Number.isFinite(result.retryAfter) && result.retryAfter > 0 ? result.retryAfter * 1000 : 0;
            pollTimer = setTimeout(tick, Math.max(FALLBACK_POLL_INTERVAL, retryMs));
        };
        tick();
    }

    async function negotiate(token) {
        const res = await fetch(`${HUB_URL}/negotiate?negotiateVersion=1&access_token=${encodeURIComponent(token)}`, {
            method: 'POST'
        });
        let json = null;
        try {
            json = await res.json();
        } catch (_) {
        }
        return {status: res.status, json, retryAfter: Number(res.headers.get('Retry-After'))};
    }

    async function handleHubRejected(s) {
        let profile;
        try {
            profile = await request(PROFILE_URL);
        } catch (e) {
            return fail(s, 'проверка токена: ' + e.message);
        }
        if (session !== s || s.dead) return;

        if (profile.status === 401 || profile.status === 403) {
            dropSession();
            return stopOnAuthError('HTTP ' + profile.status);
        }
        if (profile.status === 200) {
            dropSession();
            return startPolling();
        }
        fail(s, 'проверка токена: HTTP ' + profile.status);
    }

    function handleHubMessage(s, raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (_) {
            return;
        }

        if (!s.handshakeDone) {
            if (msg.error) return fail(s, 'handshake: ' + msg.error);
            s.handshakeDone = true;
            clearTimeout(s.watchdog);
            reconnectAttempt = 0;
            console.log('[DX] Успешное подключение к DonateX');
            sendStatus('connected');
            s.pingTimer = setInterval(() => {
                if (Date.now() - s.lastMessageAt > SERVER_TIMEOUT) return fail(s, 'сервер не отвечает');
                s.send({type: MSG_PING});
            }, PING_INTERVAL);
            backfill().then((result) => {
                if (result.auth && session === s) {
                    dropSession();
                    stopOnAuthError('HTTP 401/403 при загрузке списка донатов');
                }
            });
            return;
        }

        if (msg.type === MSG_PING) return;

        if (msg.type === MSG_CLOSE) {
            return fail(s, 'сервер закрыл соединение' + (msg.error ? ': ' + msg.error : ''));
        }

        if (msg.type === MSG_INVOCATION && typeof msg.target === 'string') {
            const target = msg.target.toLowerCase();
            const arg = Array.isArray(msg.arguments) ? msg.arguments[0] : null;
            if (target === 'donationcreated' || target === 'donationrerun') {
                processDonation(arg, target);
            }
        }
    }

    async function connect() {
        if (session || authFailed || pollingMode) return;

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            if (!offlineLogged) {
                console.warn('[DX] Сети нет, ждём восстановления');
                offlineLogged = true;
            }
            sendStatus('error');
            scheduleReconnect();
            return;
        }
        offlineLogged = false;

        if (!donateXToken) {
            sendStatus('disconnected');
            return;
        }

        const token = donateXToken;
        const s = {
            ws: null,
            dead: false,
            watchdog: null,
            pingTimer: null,
            handshakeDone: false,
            buffer: '',
            lastMessageAt: Date.now(),
            send: () => false
        };
        session = s;
        if (currentStatus !== 'error') sendStatus('disconnected');
        s.watchdog = setTimeout(() => fail(s, 'таймаут подключения'), HANDSHAKE_TIMEOUT + API_TIMEOUT);

        let neg;
        try {
            neg = await negotiate(token);
        } catch (e) {
            return fail(s, 'negotiate: ' + e.message);
        }
        if (session !== s || s.dead) return;

        if (neg.status === 401 || neg.status === 403) return handleHubRejected(s);
        if (neg.status === 429) {
            const retryMs = Number.isFinite(neg.retryAfter) && neg.retryAfter > 0 ? neg.retryAfter * 1000 : 0;
            return fail(s, 'negotiate: HTTP 429', retryMs);
        }
        if (neg.status !== 200 || !neg.json) return fail(s, 'negotiate: HTTP ' + neg.status);

        const transports = Array.isArray(neg.json.availableTransports) ? neg.json.availableTransports : [];
        if (transports.length && !transports.some(t => t.transport === 'WebSockets')) {
            return fail(s, 'сервер не поддерживает WebSocket');
        }
        const connectionToken = neg.json.connectionToken || neg.json.connectionId;
        if (!connectionToken) return fail(s, 'negotiate: нет connectionToken');

        const wsUrl = HUB_URL.replace(/^http/, 'ws') +
            `?id=${encodeURIComponent(connectionToken)}&access_token=${encodeURIComponent(token)}`;

        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            return fail(s, 'WebSocket: ' + e.message);
        }
        s.ws = ws;

        s.send = (payload) => {
            if (session !== s || s.dead || ws.readyState !== WebSocket.OPEN) return false;
            try {
                ws.send(JSON.stringify(payload) + RECORD_SEPARATOR);
                return true;
            } catch (e) {
                fail(s, 'send: ' + e.message);
                return false;
            }
        };

        ws.onopen = () => {
            if (session !== s || s.dead) return;
            s.send({protocol: 'json', version: 1});
        };

        ws.onclose = (e) => {
            fail(s, `WebSocket closed: ${e.code} ${e.reason || ''}`);
        };

        ws.onmessage = (event) => {
            if (session !== s || s.dead || typeof event.data !== 'string') return;
            s.lastMessageAt = Date.now();
            s.buffer += event.data;
            const parts = s.buffer.split(RECORD_SEPARATOR);
            s.buffer = parts.pop();
            for (const part of parts) {
                if (session !== s || s.dead) return;
                if (part) handleHubMessage(s, part);
            }
        };
    }

    window.addEventListener('offline', () => {
        if (pollingMode) return;
        clearReconnect();
        sendStatus('error');
        dropSession();
        scheduleReconnect();
    });

    window.addEventListener('online', () => {
        if (pollingMode) return;
        clearReconnect();
        reconnectAttempt = 0;
        dropSession();
        connect();
    });

    window.addEventListener('beforeunload', () => {
        clearReconnect();
        stopPolling();
        dropSession();
    });

    window.donationServices = window.donationServices || {};
    window.donationServices.DX = {
        restart() {
            clearReconnect();
            stopPolling();
            reconnectAttempt = 0;
            authFailed = false;
            dropSession();
            currentStatus = null;
            connect();
        }
    };

    connect();
})();
