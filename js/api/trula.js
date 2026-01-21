(function () {
    const RECONNECTION_DELAY_MIN = 1000;
    const RECONNECTION_DELAY_MAX = 5000;

    const SYSTEM = 'TR';

    let socket = null;
    let reconnectTimeout = null;
    let isConnecting = false;
    let lastOrderId = null;

    function sendStatus(status) {
        ipcRenderer.send('donation:status', {
            system: SYSTEM,
            status
        });
    }

    sendStatus('disconnected');

    function getReconnectDelay() {
        return Math.floor(
            Math.random() * (RECONNECTION_DELAY_MAX - RECONNECTION_DELAY_MIN)
            + RECONNECTION_DELAY_MIN
        );
    }

    function connectTrula() {
        if (isConnecting) return;
        isConnecting = true;

        if (!trulaObsToken) {
            console.warn('[TR] Token отсутствует');
            sendStatus('disconnected');
            return;
        }

        console.log('[TR] Подключение к Trula...');
        sendStatus('disconnected');

        try {
            const url = `wss://trula-music.ru/ws/playlist/${encodeURIComponent(
                trulaObsToken
            )}/`;

            socket = new WebSocket(url);

            socket.onopen = () => {
                console.log('[TR] Успешное подключение к Trula');
                isConnecting = false;
                sendStatus('connected');
            };

            socket.onmessage = (event) => {
                if (!event?.data) return;

                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }

                // Фильтр официально рекомендованный Trula
                if (
                    msg.type !== 'newOrder' ||
                    msg.eventType !== 'newOrder' ||
                    msg.sender !== 'BACKEND'
                ) {
                    return;
                }

                const donation = normalizeOrder(msg.body);
                if (!donation) return;

                if (donation.id === lastOrderId) return;
                lastOrderId = donation.id;

                if (
                    donation.amount > 0 &&
                    (typeof window.donationModeEnabled === 'undefined'
                        || window.donationModeEnabled)
                ) {
                    addTime(
                        endingTime,
                        donation.amount * secondsAddedPerCurrency
                    );
                }
            };

            socket.onerror = (err) => {
                console.warn('[TR] WebSocket ошибка', err);
            };

            socket.onclose = (e) => {
                console.warn('[TR] WebSocket закрыт', e.code, e.reason);
                sendStatus('error');
                scheduleReconnect();
            };

        } catch (err) {
            console.error('[TR] Ошибка подключения:', err);
            sendStatus('error');
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimeout) return;

        isConnecting = false;

        const delay = getReconnectDelay();
        console.log(`[TR] Переподключение через ${delay} мс`);

        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connectTrula();
        }, delay);
    }

    function normalizeOrder(body) {
        if (!body || typeof body !== 'object') return null;

        // Интересуют только донаты
        if (body.type !== 'donate') return null;

        const id = body.id;
        const amount = Number(body.amount);

        if (!id || !Number.isFinite(amount) || amount <= 0) return null;

        return {
            id,
            amount
        };
    }

    connectTrula();
})();