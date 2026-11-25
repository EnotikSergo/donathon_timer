const {createBackoff, createIdSet, createStatusReporter, requestJson, defaultTimers} = require('./service_utils');

const API_BASE = 'https://www.donationalerts.com/api/v1';
const WS_URL = 'wss://centrifugo.donationalerts.com/connection/websocket';

const HANDSHAKE_TIMEOUT = 12000;
const PING_INTERVAL = 25000;
const PING_TIMEOUT = 10000;
const MAX_MISSED_PINGS = 2;
const MAX_PROCESSED_IDS = 1000;
const BASE_CURRENCY = 'RUB';

function createDonationAlerts(deps) {
    const {
        getToken,
        onDonation,
        onStatus,
        onAuthInvalid = () => {},
        isDonationModeEnabled = () => true,
        fetch: fetchImpl = globalThis.fetch,
        WebSocket: WebSocketImpl = globalThis.WebSocket,
        timers = defaultTimers,
        random = Math.random,
        log = console
    } = deps;

    const status = createStatusReporter(onStatus);
    const backoff = createBackoff({timers, random});
    const processedIds = createIdSet(MAX_PROCESSED_IDS);

    let session = null;
    let channelName = '';
    let authFailed = false;
    let lastSeenId = null;
    let backfillUnavailableLogged = false;
    let stopped = true;

    async function api(endpoint, method = 'GET', body) {
        const token = getToken();
        if (!token) throw new Error('OAuth-токен не задан');
        const res = await requestJson(fetchImpl, timers, API_BASE + endpoint, {
            method,
            body,
            headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        });
        if (!res.ok) {
            const err = new Error('HTTP ' + res.status);
            err.status = res.status;
            throw err;
        }
        return res.json;
    }

    const isAuthError = (e) => e && (e.status === 401 || e.status === 403);

    function destroySession(s) {
        if (!s) return;
        s.dead = true;
        timers.clearTimeout(s.watchdog);
        timers.clearInterval(s.pingTimer);
        timers.clearTimeout(s.pingTimeout);
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

    function scheduleReconnect() {
        if (authFailed || stopped) return;
        const delay = backoff.schedule(connect);
        if (delay !== null) log.warn(`[DA] Переподключение через ${delay} мс`);
    }

    const alive = (s) => session === s && !s.dead;

    function fail(s, reason) {
        if (!alive(s)) return;
        log.warn('[DA] Сессия прервана:', reason);
        status.set('error');
        dropSession();
        scheduleReconnect();
    }

    function failAuth(s, reason) {
        if (!alive(s)) return;
        log.error('[DA] Токен не принят, переподключение остановлено:', reason);
        authFailed = true;
        backoff.cancel();
        status.set('error');
        dropSession();
        onAuthInvalid();
    }

    function armWatchdog(s, label) {
        timers.clearTimeout(s.watchdog);
        s.watchdog = timers.setTimeout(() => fail(s, 'таймаут этапа: ' + label), HANDSHAKE_TIMEOUT);
    }

    function startPing(s) {
        timers.clearInterval(s.pingTimer);
        s.missedPings = 0;
        s.pingTimer = timers.setInterval(() => {
            if (!alive(s) || s.pingId !== null) return;
            s.pingId = ++s.nextId;
            if (!s.send({id: s.pingId, method: 7})) return;
            s.pingTimeout = timers.setTimeout(() => {
                if (!alive(s)) return;
                s.pingId = null;
                s.missedPings++;
                log.warn(`[DA] Нет ответа на ping (${s.missedPings}/${MAX_MISSED_PINGS})`);
                if (s.missedPings >= MAX_MISSED_PINGS) fail(s, 'сервер не отвечает на ping');
            }, PING_TIMEOUT);
        }, PING_INTERVAL);
    }

    function markConnected(s) {
        if (!alive(s) || s.subscribed) return;
        s.subscribed = true;
        timers.clearTimeout(s.watchdog);
        backoff.reset();
        log.log('[DA] Успешное подключение к DonationAlerts');
        status.set('connected');
        startPing(s);
        backfill(s);
    }

    async function backfill(s) {
        let list;
        try {
            const res = await api('/alerts/donations');
            list = Array.isArray(res && res.data) ? res.data : [];
        } catch (e) {
            if (isAuthError(e)) {
                if (!backfillUnavailableLogged) {
                    log.warn('[DA] Нет доступа к списку донатов: пропущенные донаты не досчитываются. Запросите токен заново.');
                    backfillUnavailableLogged = true;
                }
            } else {
                log.warn('[DA] Не удалось получить список донатов:', e.message);
            }
            return;
        }
        if (!alive(s)) return;

        const ids = list.map((d) => Number(d.id)).filter(Number.isFinite);
        if (lastSeenId === null) {
            lastSeenId = ids.length ? Math.max(...ids) : 0;
            return;
        }

        const missed = list
            .filter((d) => Number(d.id) > lastSeenId && !processedIds.has(d.id))
            .sort((a, b) => Number(a.id) - Number(b.id));
        if (missed.length) log.log(`[DA] Досчитываются пропущенные донаты: ${missed.length}`);
        for (const d of missed) handleDonation(d);
    }

    function rememberId(id) {
        processedIds.add(id);
        const n = Number(id);
        if (Number.isFinite(n) && (lastSeenId === null || n > lastSeenId)) lastSeenId = n;
    }

    function donationAmount(d) {
        const converted = Number(d.amount_in_user_currency);
        if (Number.isFinite(converted) && converted > 0) return converted;

        const original = Number(d.amount);
        const currency = String(d.currency || BASE_CURRENCY).toUpperCase();
        if (currency === BASE_CURRENCY && Number.isFinite(original)) return original;

        log.warn(`[DA] Донат ${d.id}: ${d.amount} ${currency} без суммы в основной валюте, не засчитан`);
        return 0;
    }

    function handleDonation(d) {
        if (processedIds.has(d.id)) return;
        rememberId(d.id);

        const amount = donationAmount(d);
        if (!(amount > 0) || !isDonationModeEnabled()) return;

        log.log(`[DA] ${d.amount} ${d.currency || BASE_CURRENCY} → ${amount.toFixed(2)} ${BASE_CURRENCY}, от ${d.username || 'Anon'}`);
        onDonation(amount, {service: 'donationAlerts', id: String(d.id), username: d.username || ''});
    }

    async function connect() {
        if (session || authFailed || stopped) return;

        if (!getToken()) {
            log.warn('[DA] OAuth-токен не задан');
            status.set('disconnected');
            return;
        }

        const s = {
            ws: null, dead: false, watchdog: null, nextId: 0,
            connectId: null, subscribeId: null, subscribed: false,
            pingTimer: null, pingTimeout: null, pingId: null, missedPings: 0,
            send: () => false
        };
        session = s;
        if (status.current !== 'error') status.set('disconnected');

        try {
            let profile;
            try {
                profile = await api('/user/oauth');
            } catch (e) {
                if (isAuthError(e)) return failAuth(s, e.message);
                throw e;
            }
            if (!alive(s)) return;

            const userId = profile && profile.data && profile.data.id;
            const socketToken = profile && profile.data && profile.data.socket_connection_token;
            if (!userId || !socketToken) throw new Error('Нет id / socket_connection_token');

            channelName = `$alerts:donation_${userId}`;

            const ws = new WebSocketImpl(WS_URL);
            s.ws = ws;
            s.send = (payload) => {
                if (!alive(s) || ws.readyState !== 1) return false;
                try {
                    ws.send(JSON.stringify(payload));
                    return true;
                } catch (e) {
                    fail(s, 'send: ' + e.message);
                    return false;
                }
            };
            armWatchdog(s, 'ожидание ответа на connect');

            ws.onopen = () => {
                if (!alive(s)) return;
                s.connectId = ++s.nextId;
                s.send({id: s.connectId, params: {token: socketToken}});
            };

            ws.onclose = (e) => fail(s, `WebSocket closed: ${e && e.code} ${(e && e.reason) || ''}`);

            ws.onmessage = (event) => handleMessage(s, event);
        } catch (e) {
            fail(s, e.message);
        }
    }

    async function handleMessage(s, event) {
        if (!alive(s)) return;

        let msg;
        try {
            msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (s.pingId !== null && msg.id === s.pingId) {
            s.pingId = null;
            s.missedPings = 0;
            timers.clearTimeout(s.pingTimeout);
            return;
        }

        if (s.connectId !== null && msg.id === s.connectId) {
            s.connectId = null;
            const clientId = msg.result && msg.result.client;
            if (!clientId) return fail(s, 'в ответе connect нет client');

            armWatchdog(s, 'подписка на канал');
            try {
                const sub = await api('/centrifuge/subscribe', 'POST', {channels: [channelName], client: clientId});
                if (!alive(s)) return;
                const ch = sub && sub.channels && sub.channels[0];
                if (!ch || !ch.token) throw new Error('Нет токена канала');
                s.subscribeId = ++s.nextId;
                s.send({id: s.subscribeId, method: 1, params: {channel: ch.channel || channelName, token: ch.token}});
            } catch (e) {
                if (isAuthError(e)) return failAuth(s, 'подписка: ' + e.message);
                fail(s, 'подписка: ' + e.message);
            }
            return;
        }

        if (s.subscribeId !== null && msg.id === s.subscribeId) {
            s.subscribeId = null;
            if (msg.error) return fail(s, 'ошибка подписки: ' + JSON.stringify(msg.error));
            markConnected(s);
            return;
        }

        if (msg.error) {
            log.warn('[DA] Ошибка сервера:', msg.error);
            return;
        }

        const channel = (msg.result && msg.result.channel) || (msg.push && msg.push.channel);
        if (channel && channel !== channelName) return;

        const payload = msg.result ? msg.result.data : (msg.push && msg.push.data);
        let donation = null;
        if (payload && payload.data && typeof payload.data === 'object') donation = payload.data;
        else if (payload && payload.id && payload.amount !== undefined) donation = payload;

        if (donation && donation.id) {
            markConnected(s);
            handleDonation(donation);
        }
    }

    function start() {
        stopped = false;
        connect();
    }

    function restart() {
        backoff.cancel();
        backoff.reset();
        authFailed = false;
        backfillUnavailableLogged = false;
        dropSession();
        stopped = false;
        connect();
    }

    function stop() {
        stopped = true;
        backoff.cancel();
        dropSession();
    }

    return {start, restart, stop, getStatus: () => status.current};
}

module.exports = {createDonationAlerts};
