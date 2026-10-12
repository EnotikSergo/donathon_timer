(function () {
    const RECONNECTION_DELAY_MIN = 1000;
    const RECONNECTION_DELAY_MAX = 5000;
    const SYSTEM = 'DA';
    const API_BASE = 'https://www.donationalerts.com/api/v1';
    const WS_URL = 'wss://centrifugo.donationalerts.com/connection/websocket';

    let socket = null;
    let reconnectTimeout = null;
    let isConnecting = false;
    let lastDonationId = null;
    let msgIdCounter = 1;
    let currentChannelName = '';

    function sendStatus(status) {
        if (typeof ipcRenderer !== 'undefined') {
            ipcRenderer.send('donation:status', { system: SYSTEM, status });
        }
    }

    sendStatus('disconnected');

    function getReconnectDelay() {
        return Math.floor(Math.random() * (RECONNECTION_DELAY_MAX - RECONNECTION_DELAY_MIN) + RECONNECTION_DELAY_MIN);
    }

    async function apiRequest(endpoint, method = 'GET', body = null) {
        if (!donationAlertsToken) throw new Error('OAuth токен отсутствует');

        const headers = {
            'Authorization': `Bearer ${donationAlertsToken}`,
            'Content-Type': 'application/json'
        };

        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(`${API_BASE}${endpoint}`, options);

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }

    async function connectDonationAlerts() {
        if (isConnecting) return;
        isConnecting = true;

        if (!donationAlertsToken) {
            console.warn('[DA] OAuth токен отсутствует в config.js');
            sendStatus('disconnected');
            return;
        }

        sendStatus('disconnected');

        try {
            const userData = await apiRequest('/user/oauth');
            const userId = userData.data.id;
            const socketToken = userData.data.socket_connection_token;
            currentChannelName = `$alerts:donation_${userId}`;

            socket = new WebSocket(WS_URL);

            socket.onopen = () => {
                socket.send(JSON.stringify({
                    id: msgIdCounter++,
                    params: { token: socketToken }
                }));
            };

            socket.onmessage = async (event) => {
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch (e) {
                    return;
                }

                if (msg.id === 1 && msg.result && msg.result.client) {
                    const clientId = msg.result.client;
                    try {
                        const subData = await apiRequest('/centrifuge/subscribe', 'POST', {
                            channels: [currentChannelName],
                            client: clientId
                        });

                        const channelToken = subData.channels[0].token;

                        socket.send(JSON.stringify({
                            id: msgIdCounter++,
                            method: 1,
                            params: {
                                channel: currentChannelName,
                                token: channelToken
                            }
                        }));

                        sendStatus('connected');
                        isConnecting = false;

                    } catch (subErr) {
                        console.error('[DA] Ошибка подписки:', subErr);
                        sendStatus('error');
                        socket.close();
                    }
                    return;
                }

                if (msg.id === 2 && msg.result) {
                    console.log('[DA] Успешное подключение к DonationAlerts');
                    return;
                }

                let donationData = null;

                if (msg.result && msg.result.channel === currentChannelName && msg.result.data && msg.result.data.data) {
                    donationData = msg.result.data.data;
                }
                else if (msg.push && msg.push.channel === currentChannelName && msg.push.data) {
                    donationData = msg.push.data;
                }

                if (donationData) {
                    handleDonation(donationData);
                }
            };

            socket.onerror = (err) => {
                console.warn('[DA] WebSocket ошибка', err);
            };

            socket.onclose = (e) => {
                console.warn('[DA] WebSocket закрыт', e.code, e.reason);
                sendStatus('error');
                isConnecting = false;
                scheduleReconnect();
            };

        } catch (err) {
            console.error('[DA] Критическая ошибка инициализации:', err);
            sendStatus('error');
            isConnecting = false;
            scheduleReconnect();
        }
    }

    function handleDonation(data) {
        if (!data || !data.id) {
            return;
        }

        if (data.id === lastDonationId) {
            return;
        }
        lastDonationId = data.id;

        const amount = Number(data.amount || data.amount_in_user_currency || 0);

        if (amount > 0 && (typeof window.donationModeEnabled === 'undefined' || window.donationModeEnabled)) {
            if (typeof handleDonationWithGoalSystem === 'function') {
                handleDonationWithGoalSystem(amount);
            }
        }
    }

    function scheduleReconnect() {
        if (reconnectTimeout) return;
        const delay = getReconnectDelay();
        console.log(`[DA] Переподключение через ${delay} мс`);
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connectDonationAlerts();
        }, delay);
    }

    connectDonationAlerts();
})();