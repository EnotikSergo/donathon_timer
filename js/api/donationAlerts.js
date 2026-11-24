(function () {
    'use strict';

    const SYSTEM = 'DA';
    const API_BASE = 'https://www.donationalerts.com/api/v1';
    const WS_URL = 'wss://centrifugo.donationalerts.com/connection/websocket';

    const API_TIMEOUT = 8000;
    const HANDSHAKE_TIMEOUT = 12000;
    const HEALTH_INTERVAL = 5000;
    const RECONNECT_MIN = 1000;
    const RECONNECT_MAX = 5000;

    let session = null;
    let reconnectTimer = null;
    let healthTimer = null;
    let channelName = '';
    let offlineLogged = false;
    const processedIds = new Set();

    function sendStatus(status) {
        try {
            ipcRenderer.send('donation:status', { system: SYSTEM, status });
        } catch (_) {}
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
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    function stopHealth() {
        if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
        }
    }

    function destroySession(s) {
        if (!s) return;
        s.dead = true;
        clearTimeout(s.watchdog);
        if (s.ws) {
            s.ws.onopen = null;
            s.ws.onmessage = null;
            s.ws.onerror = null;
            s.ws.onclose = null;
            try { s.ws.close(); } catch (_) {}
            s.ws = null;
        }
    }

    function dropSession() {
        stopHealth();
        if (session) {
            destroySession(session);
            session = null;
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = RECONNECT_MIN +
            Math.floor(Math.random() * (RECONNECT_MAX - RECONNECT_MIN));
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

    function armWatchdog(s, label) {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => fail(s, 'таймаут этапа: ' + label), HANDSHAKE_TIMEOUT);
    }

    function markConnected(s) {
        if (session !== s || s.dead || s.subscribed) return;
        s.subscribed = true;
        clearTimeout(s.watchdog);
        console.log('[DA] Успешное подключение к DonationAlerts');
        sendStatus('connected');
        startHealth(s);
    }

    function startHealth(s) {
        stopHealth();
        healthTimer = setInterval(async () => {
            if (session !== s || s.dead) return;

            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                return fail(s, 'сеть недоступна');
            }

            try {
                await apiRequest('/user/oauth');
            } catch (e) {
                if (String(e.message).includes('429')) return;
                return fail(s, 'health check: ' + e.message);
            }
        }, HEALTH_INTERVAL);
    }

    async function connect() {
        if (session) return;

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
            subscribed: false
        };
        session = s;
        sendStatus('disconnected');

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
            const profile = await apiRequest('/user/oauth');
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
                send({ id: s.connectId, params: { token: socketToken } });
            };

            ws.onerror = () => {
            };

            ws.onclose = (e) => {
                fail(s, `WebSocket closed: ${e.code} ${e.reason || ''}`);
            };

            ws.onmessage = async (event) => {
                if (session !== s || s.dead) return;

                let msg;
                try { msg = JSON.parse(event.data); } catch (_) { return; }
                if (!msg || typeof msg !== 'object') return;

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
                            params: { channel: ch.channel || channelName, token: ch.token }
                        });
                    } catch (e) {
                        fail(s, 'подписка: ' + e.message);
                    }
                    return;
                }

                if (s.subscribeId !== null) {
                    const byId = msg.id === s.subscribeId;
                    const byType = msg.result && msg.result.type === 1 &&
                                   msg.result.channel === channelName;

                    if (byId || byType) {
                        s.subscribeId = null;
                        if (msg.error) {
                            return fail(s, 'ошибка подписки: ' + JSON.stringify(msg.error));
                        }
                        markConnected(s);
                        return;
                    }
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
                    markConnected(s);
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

        const converted = Number(d.amount_in_user_currency);
        const original = Number(d.amount);
        const amount = (Number.isFinite(converted) && converted > 0)
            ? converted
            : (Number.isFinite(original) ? original : 0);

        processedIds.add(id);
        if (processedIds.size > 500) {
            processedIds.delete(processedIds.values().next().value);
        }

        if (!(amount > 0)) {
            return;
        }

        if (typeof window.donationModeEnabled !== 'undefined' && !window.donationModeEnabled) {
            return;
        }

        console.log(`[DA] ${original} ${d.currency || 'RUB'} → ${amount.toFixed(2)} RUB, от ${d.username || 'Anon'}`);

        if (typeof handleDonationWithGoalSystem === 'function') {
            handleDonationWithGoalSystem(amount);
        } else {
            console.error('[DA] handleDonationWithGoalSystem не найдена');
        }
    }

    window.addEventListener('offline', () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        sendStatus('error');
        dropSession();
        scheduleReconnect();
    });

    window.addEventListener('online', () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        dropSession();
        connect();
    });

    window.addEventListener('beforeunload', () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        dropSession();
    });

    connect();
})();