(function () {
    'use strict';

    const SYSTEM = 'DA';
    const SERVICE = 'donationAlerts';
    const API_BASE = 'https://www.donationalerts.com/api/v1';
    const WS_URL = 'wss://centrifugo.donationalerts.com/connection/websocket';

    const API_TIMEOUT = 8000;
    const HANDSHAKE_TIMEOUT = 12000;
    const PING_INTERVAL = 25000;
    const PING_TIMEOUT = 10000;
    const MAX_MISSED_PINGS = 2;
    const RECONNECT_BASE = 1000;
    const RECONNECT_MAX = 30000;
    const RECONNECT_JITTER = 500;
    const MAX_PROCESSED_IDS = 1000;
    const BASE_CURRENCY = 'RUB';

    let session = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let channelName = '';
    let offlineLogged = false;
    let authFailed = false;
    let currentStatus = null;
    let lastSeenId = null;
    let backfillUnavailableLogged = false;
    const processedIds = new Set();

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

    async function apiRequest(endpoint, method = 'GET', body = null) {
        if (!donationAlertsToken) throw new Error('OAuth-токен не задан');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

        try {
            const res = await fetch(API_BASE + endpoint, {
                method,
                signal: controller.signal,
                headers: {
                    'Authorization': 'Bearer ' + donationAlertsToken,
                    'Content-Type': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined
            });
            if (!res.ok) {
                const err = new Error('HTTP ' + res.status);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    function isAuthError(e) {
        return e && (e.status === 401 || e.status === 403);
    }

    function destroySession(s) {
        if (!s) return;
        s.dead = true;
        clearTimeout(s.watchdog);
        clearInterval(s.pingTimer);
        clearTimeout(s.pingTimeout);
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

    function clearReconnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer || authFailed) return;
        const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, reconnectAttempt)) +
            Math.floor(Math.random() * RECONNECT_JITTER);
        reconnectAttempt++;
        console.warn(`[DA] Переподключение через ${delay} мс`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function fail(s, reason) {
        if (session !== s || s.dead) return;
        console.warn('[DA] Сессия прервана:', reason);
        sendStatus('error');
        dropSession();
        scheduleReconnect();
    }

    function failAuth(s, reason) {
        if (session !== s || s.dead) return;
        console.error('[DA] Токен не принят, переподключение остановлено:', reason);
        authFailed = true;
        clearReconnect();
        sendStatus('error');
        dropSession();
        reportAuthInvalid();
    }

    function armWatchdog(s, label) {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => fail(s, 'таймаут этапа: ' + label), HANDSHAKE_TIMEOUT);
    }

    function startPing(s, send) {
        clearInterval(s.pingTimer);
        s.missedPings = 0;
        s.pingTimer = setInterval(() => {
            if (session !== s || s.dead) return;
            if (s.pingId !== null) return;

            s.pingId = ++s.nextId;
            if (!send({id: s.pingId, method: 7})) return;

            s.pingTimeout = setTimeout(() => {
                if (session !== s || s.dead) return;
                s.pingId = null;
                s.missedPings++;
                console.warn(`[DA] Нет ответа на ping (${s.missedPings}/${MAX_MISSED_PINGS})`);
                if (s.missedPings >= MAX_MISSED_PINGS) fail(s, 'сервер не отвечает на ping');
            }, PING_TIMEOUT);
        }, PING_INTERVAL);
    }

    function markConnected(s, send) {
        if (session !== s || s.dead || s.subscribed) return;
        s.subscribed = true;
        clearTimeout(s.watchdog);
        reconnectAttempt = 0;
        console.log('[DA] Успешное подключение к DonationAlerts');
        sendStatus('connected');
        startPing(s, send);
        backfill(s);
    }

    async function backfill(s) {
        let list;
        try {
            const res = await apiRequest('/alerts/donations');
            list = Array.isArray(res && res.data) ? res.data : [];
        } catch (e) {
            if (isAuthError(e)) {
                if (!backfillUnavailableLogged) {
                    console.warn('[DA] Нет доступа к списку донатов: пропущенные донаты не досчитываются. Запросите токен заново.');
                    backfillUnavailableLogged = true;
                }
            } else {
                console.warn('[DA] Не удалось получить список донатов:', e.message);
            }
            return;
        }
        if (session !== s || s.dead) return;

        const ids = list.map(d => Number(d.id)).filter(Number.isFinite);
        if (lastSeenId === null) {
            lastSeenId = ids.length ? Math.max(...ids) : 0;
            return;
        }

        const missed = list
            .filter(d => Number(d.id) > lastSeenId && !processedIds.has(String(d.id)))
            .sort((a, b) => Number(a.id) - Number(b.id));

        if (missed.length) console.log(`[DA] Досчитываются пропущенные донаты: ${missed.length}`);
        for (const d of missed) handleDonation(d);
    }

    function rememberId(id) {
        processedIds.add(id);
        if (processedIds.size > MAX_PROCESSED_IDS) {
            processedIds.delete(processedIds.values().next().value);
        }
        const n = Number(id);
        if (Number.isFinite(n) && (lastSeenId === null || n > lastSeenId)) lastSeenId = n;
    }

    function donationAmount(d) {
        const converted = Number(d.amount_in_user_currency);
        if (Number.isFinite(converted) && converted > 0) return converted;

        const original = Number(d.amount);
        const currency = String(d.currency || BASE_CURRENCY).toUpperCase();
        if (currency === BASE_CURRENCY && Number.isFinite(original)) return original;

        console.warn(`[DA] Донат ${d.id}: ${d.amount} ${currency} без суммы в основной валюте, не засчитан`);
        return 0;
    }

    async function connect() {
        if (session || authFailed) return;

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            if (!offlineLogged) {
                console.warn('[DA] Сети нет, ждём восстановления');
                offlineLogged = true;
            }
            sendStatus('error');
            scheduleReconnect();
            return;
        }
        offlineLogged = false;

        if (!donationAlertsToken) {
            console.warn('[DA] OAuth-токен не задан');
            sendStatus('disconnected');
            return;
        }

        const s = {
            ws: null,
            dead: false,
            watchdog: null,
            nextId: 0,
            connectId: null,
            subscribeId: null,
            subscribed: false,
            pingTimer: null,
            pingTimeout: null,
            pingId: null,
            missedPings: 0
        };
        session = s;
        if (currentStatus !== 'error') sendStatus('disconnected');

        const send = (payload) => {
            if (session !== s || s.dead || !s.ws || s.ws.readyState !== WebSocket.OPEN) return false;
            try {
                s.ws.send(JSON.stringify(payload));
                return true;
            } catch (e) {
                fail(s, 'send: ' + e.message);
                return false;
            }
        };

        try {
            let profile;
            try {
                profile = await apiRequest('/user/oauth');
            } catch (e) {
                if (isAuthError(e)) return failAuth(s, e.message);
                throw e;
            }
            if (session !== s || s.dead) return;

            const userId = profile.data && profile.data.id;
            const socketToken = profile.data && profile.data.socket_connection_token;
            if (!userId || !socketToken) throw new Error('Нет id / socket_connection_token');

            channelName = `$alerts:donation_${userId}`;

            const ws = new WebSocket(WS_URL);
            s.ws = ws;
            armWatchdog(s, 'ожидание ответа на connect');

            ws.onopen = () => {
                if (session !== s || s.dead) return;
                s.connectId = ++s.nextId;
                send({id: s.connectId, params: {token: socketToken}});
            };

            ws.onclose = (e) => {
                fail(s, `WebSocket closed: ${e.code} ${e.reason || ''}`);
            };

            ws.onmessage = async (event) => {
                if (session !== s || s.dead) return;

                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch (_) {
                    return;
                }
                if (!msg || typeof msg !== 'object') return;

                if (s.pingId !== null && msg.id === s.pingId) {
                    s.pingId = null;
                    s.missedPings = 0;
                    clearTimeout(s.pingTimeout);
                    return;
                }

                if (s.connectId !== null && msg.id === s.connectId) {
                    s.connectId = null;
                    const clientId = msg.result && msg.result.client;
                    if (!clientId) return fail(s, 'в ответе connect нет client');

                    armWatchdog(s, 'подписка на канал');

                    try {
                        const sub = await apiRequest('/centrifuge/subscribe', 'POST', {
                            channels: [channelName],
                            client: clientId
                        });
                        if (session !== s || s.dead) return;

                        const ch = sub.channels && sub.channels[0];
                        if (!ch || !ch.token) throw new Error('Нет токена канала');

                        s.subscribeId = ++s.nextId;
                        send({
                            id: s.subscribeId,
                            method: 1,
                            params: {channel: ch.channel || channelName, token: ch.token}
                        });
                    } catch (e) {
                        if (isAuthError(e)) return failAuth(s, 'подписка: ' + e.message);
                        fail(s, 'подписка: ' + e.message);
                    }
                    return;
                }

                if (s.subscribeId !== null && msg.id === s.subscribeId) {
                    s.subscribeId = null;
                    if (msg.error) {
                        return fail(s, 'ошибка подписки: ' + JSON.stringify(msg.error));
                    }
                    markConnected(s, send);
                    return;
                }

                if (msg.error) {
                    console.warn('[DA] Ошибка сервера:', msg.error);
                    return;
                }

                const channel = (msg.result && msg.result.channel) || (msg.push && msg.push.channel);
                if (channel && channel !== channelName) return;

                const payload = msg.result ? msg.result.data : (msg.push && msg.push.data);
                let donation = null;

                if (payload && payload.data && typeof payload.data === 'object') {
                    donation = payload.data;
                } else if (payload && payload.id && payload.amount !== undefined) {
                    donation = payload;
                }

                if (donation && donation.id) {
                    markConnected(s, send);
                    handleDonation(donation);
                }
            };

        } catch (e) {
            fail(s, e.message);
        }
    }

    function handleDonation(d) {
        const id = String(d.id);
        if (processedIds.has(id)) return;
        rememberId(id);

        const amount = donationAmount(d);
        if (!(amount > 0)) return;

        if (typeof window.donationModeEnabled !== 'undefined' && !window.donationModeEnabled) {
            return;
        }

        console.log(`[DA] ${d.amount} ${d.currency || BASE_CURRENCY} → ${amount.toFixed(2)} ${BASE_CURRENCY}, от ${d.username || 'Anon'}`);

        if (typeof handleDonationWithGoalSystem === 'function') {
            handleDonationWithGoalSystem(amount);
        } else {
            console.error('[DA] handleDonationWithGoalSystem не найдена');
        }
    }

    window.addEventListener('offline', () => {
        clearReconnect();
        sendStatus('error');
        dropSession();
        scheduleReconnect();
    });

    window.addEventListener('online', () => {
        clearReconnect();
        reconnectAttempt = 0;
        dropSession();
        connect();
    });

    window.addEventListener('beforeunload', () => {
        clearReconnect();
        dropSession();
    });

    window.donationServices = window.donationServices || {};
    window.donationServices.DA = {
        restart() {
            clearReconnect();
            reconnectAttempt = 0;
            authFailed = false;
            backfillUnavailableLogged = false;
            dropSession();
            connect();
        }
    };

    connect();
})();
