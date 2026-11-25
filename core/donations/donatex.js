const {createBackoff, createIdSet, createStatusReporter, requestJson, defaultTimers} = require('./service_utils');

const API_BASE = 'https://donatex.gg/api';
const HUB_URL = API_BASE + '/public-donations-hub';
const DONATIONS_URL = API_BASE + '/v1/donations';
const PROFILE_URL = API_BASE + '/v1/user/me';

const API_TIMEOUT = 8000;
const HANDSHAKE_TIMEOUT = 12000;
const PING_INTERVAL = 15000;
const SERVER_TIMEOUT = 35000;
const FALLBACK_POLL_INTERVAL = 15000;
const BACKFILL_TAKE = 50;
const MAX_PROCESSED_IDS = 1000;
const RECORD_SEPARATOR = '\x1e';

const MSG_INVOCATION = 1;
const MSG_PING = 6;
const MSG_CLOSE = 7;

function createDonateX(deps) {
    const {
        getToken,
        onDonation,
        onStatus,
        onAuthInvalid = () => {},
        isDonationModeEnabled = () => true,
        state: stateStore,
        fetch: fetchImpl = globalThis.fetch,
        WebSocket: WebSocketImpl = globalThis.WebSocket,
        timers = defaultTimers,
        now = () => Date.now(),
        random = Math.random,
        log = console
    } = deps;

    const status = createStatusReporter(onStatus);
    const backoff = createBackoff({timers, random});

    let lastProcessedTimestamp = 0;
    let processedIds = createIdSet(MAX_PROCESSED_IDS);
    let stateLoaded = false;

    let session = null;
    let pollTimer = null;
    let pollingMode = false;
    let authFailed = false;
    let stopped = true;

    function loadState() {
        if (stateLoaded) return;
        stateLoaded = true;
        let saved = {};
        try {
            saved = (stateStore && stateStore.load()) || {};
        } catch (e) {
            log.error('[DX] Не удалось прочитать состояние:', e);
        }
        lastProcessedTimestamp = Number(saved.lastProcessedTimestamp);
        processedIds = createIdSet(MAX_PROCESSED_IDS, Array.isArray(saved.processedIds) ? saved.processedIds : []);
        if (!Number.isFinite(lastProcessedTimestamp) || lastProcessedTimestamp <= 0) {
            lastProcessedTimestamp = now();
            persist();
        }
    }

    function persist() {
        if (!stateStore) return;
        try {
            stateStore.save({lastProcessedTimestamp, processedIds: processedIds.toArray()});
        } catch (e) {
            log.error('[DX] Не удалось сохранить состояние:', e);
        }
    }

    const request = (url, token = getToken()) => requestJson(fetchImpl, timers, url, {
        headers: {'X-External-Token': token},
        timeoutMs: API_TIMEOUT
    });

    function stopPolling() {
        pollingMode = false;
        if (pollTimer) {
            timers.clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function scheduleReconnect(minDelay = 0) {
        if (authFailed || stopped) return;
        const delay = backoff.schedule(connect, minDelay);
        if (delay !== null) log.warn(`[DX] Переподключение через ${delay} мс`);
    }

    function destroySession(s) {
        if (!s) return;
        s.dead = true;
        timers.clearTimeout(s.watchdog);
        timers.clearInterval(s.pingTimer);
        if (s.ws) {
            s.ws.onopen = null;
            s.ws.onmessage = null;
            s.ws.onerror = null;
            s.ws.onclose = null;
            try {
                s.ws.close();
            } catch {
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

    const alive = (s) => session === s && !s.dead;

    function fail(s, reason, minDelay = 0) {
        if (!alive(s)) return;
        log.warn('[DX] Соединение прервано:', reason);
        status.set('error');
        dropSession();
        scheduleReconnect(minDelay);
    }

    function stopOnAuthError(reason) {
        log.error('[DX] Токен не принят, переподключение остановлено:', reason);
        authFailed = true;
        backoff.cancel();
        stopPolling();
        dropSession();
        status.set('error');
        onAuthInvalid();
    }

    function processDonation(donation, source) {
        if (!donation || !donation.id) return;
        const id = String(donation.id);
        if (processedIds.has(id)) return;

        const ts = new Date(donation.timestamp).getTime();
        if (source === 'backfill' && (!Number.isFinite(ts) || ts <= lastProcessedTimestamp)) return;

        processedIds.add(id);
        if (Number.isFinite(ts) && ts > lastProcessedTimestamp) lastProcessedTimestamp = ts;
        persist();

        const amount = Number(donation.amountInRub || donation.amount);
        if (!(amount > 0) || !isDonationModeEnabled()) return;

        log.log(`[DX] ${amount} RUB от ${donation.username || 'Anon'}${donation.isTest ? ' (тестовый)' : ''}`);
        onDonation(amount, {service: 'donateX', id, username: donation.username || '', isTest: !!donation.isTest});
    }

    async function backfill() {
        let res;
        try {
            res = await request(`${DONATIONS_URL}?skip=0&take=${BACKFILL_TAKE}&sortOrder=NewestFirst`);
        } catch (e) {
            log.warn('[DX] Не удалось получить список донатов:', e.message);
            return {ok: false};
        }
        if (res.status === 401 || res.status === 403) return {ok: false, auth: true};
        if (res.status === 429) return {ok: false, retryAfter: res.retryAfter};
        if (res.status !== 200 || !Array.isArray(res.json)) {
            log.warn(`[DX] Список донатов: HTTP ${res.status}`);
            return {ok: false};
        }
        for (const d of res.json.slice().reverse()) processDonation(d, 'backfill');
        return {ok: true};
    }

    function startPolling() {
        if (pollingMode) return;
        stopPolling();
        pollingMode = true;
        log.warn('[DX] Хаб не принял токен, донаты будут проверяться раз в 15 с');

        const tick = async () => {
            pollTimer = null;
            if (!pollingMode) return;
            const result = await backfill();
            if (!pollingMode) return;
            if (result.auth) return stopOnAuthError('HTTP 401/403 при опросе');
            status.set(result.ok ? 'connected' : 'error');
            const retryMs = Number.isFinite(result.retryAfter) && result.retryAfter > 0 ? result.retryAfter * 1000 : 0;
            pollTimer = timers.setTimeout(tick, Math.max(FALLBACK_POLL_INTERVAL, retryMs));
        };
        tick();
    }

    async function handleHubRejected(s) {
        let profile;
        try {
            profile = await request(PROFILE_URL);
        } catch (e) {
            return fail(s, 'проверка токена: ' + e.message);
        }
        if (!alive(s)) return;
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
        } catch {
            return;
        }

        if (!s.handshakeDone) {
            if (msg.error) return fail(s, 'handshake: ' + msg.error);
            s.handshakeDone = true;
            timers.clearTimeout(s.watchdog);
            backoff.reset();
            log.log('[DX] Успешное подключение к DonateX');
            status.set('connected');
            s.pingTimer = timers.setInterval(() => {
                if (now() - s.lastMessageAt > SERVER_TIMEOUT) return fail(s, 'сервер не отвечает');
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
        if (msg.type === MSG_CLOSE) return fail(s, 'сервер закрыл соединение' + (msg.error ? ': ' + msg.error : ''));

        if (msg.type === MSG_INVOCATION && typeof msg.target === 'string') {
            const target = msg.target.toLowerCase();
            const arg = Array.isArray(msg.arguments) ? msg.arguments[0] : null;
            if (target === 'donationcreated' || target === 'donationrerun') processDonation(arg, target);
        }
    }

    async function connect() {
        if (session || authFailed || pollingMode || stopped) return;

        const token = getToken();
        if (!token) {
            status.set('disconnected');
            return;
        }

        const s = {
            ws: null, dead: false, watchdog: null, pingTimer: null,
            handshakeDone: false, buffer: '', lastMessageAt: now(),
            send: () => false
        };
        session = s;
        if (status.current !== 'error') status.set('disconnected');
        s.watchdog = timers.setTimeout(() => fail(s, 'таймаут подключения'), HANDSHAKE_TIMEOUT + API_TIMEOUT);

        let neg;
        try {
            neg = await requestJson(fetchImpl, timers, `${HUB_URL}/negotiate?negotiateVersion=1&access_token=${encodeURIComponent(token)}`, {
                method: 'POST',
                timeoutMs: API_TIMEOUT
            });
        } catch (e) {
            return fail(s, 'negotiate: ' + e.message);
        }
        if (!alive(s)) return;

        if (neg.status === 401 || neg.status === 403) return handleHubRejected(s);
        if (neg.status === 429) {
            const retryMs = Number.isFinite(neg.retryAfter) && neg.retryAfter > 0 ? neg.retryAfter * 1000 : 0;
            return fail(s, 'negotiate: HTTP 429', retryMs);
        }
        if (neg.status !== 200 || !neg.json) return fail(s, 'negotiate: HTTP ' + neg.status);

        const transports = Array.isArray(neg.json.availableTransports) ? neg.json.availableTransports : [];
        if (transports.length && !transports.some((t) => t.transport === 'WebSockets')) {
            return fail(s, 'сервер не поддерживает WebSocket');
        }
        const connectionToken = neg.json.connectionToken || neg.json.connectionId;
        if (!connectionToken) return fail(s, 'negotiate: нет connectionToken');

        const wsUrl = HUB_URL.replace(/^http/, 'ws') +
            `?id=${encodeURIComponent(connectionToken)}&access_token=${encodeURIComponent(token)}`;

        let ws;
        try {
            ws = new WebSocketImpl(wsUrl);
        } catch (e) {
            return fail(s, 'WebSocket: ' + e.message);
        }
        s.ws = ws;

        s.send = (payload) => {
            if (!alive(s) || ws.readyState !== 1) return false;
            try {
                ws.send(JSON.stringify(payload) + RECORD_SEPARATOR);
                return true;
            } catch (e) {
                fail(s, 'send: ' + e.message);
                return false;
            }
        };

        ws.onopen = () => {
            if (alive(s)) s.send({protocol: 'json', version: 1});
        };
        ws.onclose = (e) => fail(s, `WebSocket closed: ${e && e.code} ${(e && e.reason) || ''}`);
        ws.onmessage = (event) => {
            if (!alive(s)) return;
            const data = typeof event.data === 'string' ? event.data : String(event.data);
            s.lastMessageAt = now();
            s.buffer += data;
            const parts = s.buffer.split(RECORD_SEPARATOR);
            s.buffer = parts.pop();
            for (const part of parts) {
                if (!alive(s)) return;
                if (part) handleHubMessage(s, part);
            }
        };
    }

    function start() {
        loadState();
        stopped = false;
        connect();
    }

    function restart() {
        loadState();
        backoff.cancel();
        backoff.reset();
        stopPolling();
        authFailed = false;
        dropSession();
        status.reset();
        stopped = false;
        connect();
    }

    function stop() {
        stopped = true;
        backoff.cancel();
        stopPolling();
        dropSession();
    }

    return {start, restart, stop, getStatus: () => status.current};
}

module.exports = {createDonateX};
