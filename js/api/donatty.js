(function () {
    const DONATTY_AUTH_URL = 'https://api.donatty.com/auth/tokens/';
    const DONATTY_SSE_BASE_URL = 'https://api.donatty.com/widgets/';

    const RECONNECTION_DELAY_MIN = 1000;
    const RECONNECTION_DELAY_MAX = 5000;

    let lastDonationId = null;
    let donattyEventSource = null;
    let donattyReconnectTimeout = null;
    const SYSTEM = 'DY';
    var donattyZoneOffset = -180;

    function sendStatus(status) {
        ipcRenderer.send('donation:status', {
            system: SYSTEM,
            status
        });
    }

    sendStatus('disconnected');

    function getDonattyConfig() {
        const ref = (donattyWidgetRef || '').trim();
        const widgetToken = (donattyWidgetToken || '').trim();
        const zoneOffset =
            typeof donattyZoneOffset === 'number'
                ? donattyZoneOffset
                : -180;

        return { ref, widgetToken, zoneOffset };
    }

    function startDonatty() {
        const { ref, widgetToken, zoneOffset } = getDonattyConfig();

        if (!ref || !widgetToken) {
            sendStatus('disconnected');
            return;
        }
        console.log('[DY] Подключение к Donatty...');

        if (donattyEventSource) {
            try {
                donattyEventSource.close();
            } catch (_) {}
            donattyEventSource = null;
        }
        if (donattyReconnectTimeout) {
            clearTimeout(donattyReconnectTimeout);
            donattyReconnectTimeout = null;
        }

        fetch(DONATTY_AUTH_URL + encodeURIComponent(widgetToken))
            .then((res) => {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then((data) => {
                const accessToken =
                    data &&
                    data.response &&
                    typeof data.response.accessToken === 'string'
                        ? data.response.accessToken
                        : null;

                if (!accessToken) {
                    throw new Error('Donatty: accessToken not found in response');
                }

                openDonattySse(ref, accessToken, zoneOffset);
            })
            .catch((err) => {
                console.error('Donatty auth error:', err);
                sendStatus('error');
                scheduleDonattyReconnect();
            });
    }

    function openDonattySse(ref, accessToken, zoneOffset) {
        if (typeof EventSource === 'undefined') {
            console.warn('Donatty: EventSource не поддерживается в этом окружении');
            return;
        }

        const url =
            DONATTY_SSE_BASE_URL +
            encodeURIComponent(ref) +
            '/sse?jwt=' +
            encodeURIComponent(accessToken) +
            '&zoneOffset=' +
            encodeURIComponent(zoneOffset);

        try {
            const es = new EventSource(url);
            donattyEventSource = es;

            sendStatus('connected');
            console.log('[DY] Успешное подключение к Donnaty');

            const handleEvent = (event) => {
                if (!event || !event.data) return;

                let raw;
                try {
                    raw = JSON.parse(event.data);
                } catch (e) {
                    return;
                }

                const donation = normalizeDonattyDonation(raw);
                if (!donation) return;

                if (donation.id && donation.id === lastDonationId) return;
                lastDonationId = donation.id || null;

                if (
                    donation.amount > 0 &&
                    (typeof window.donationModeEnabled === 'undefined' ||
                        window.donationModeEnabled)
                ) {
                    addTime(endingTime, donation.amount * secondsAddedPerCurrency);
                }
            };

            es.onmessage = handleEvent;

            es.addEventListener('donation', handleEvent);

            es.onerror = (err) => {
                console.error('Donatty SSE error:', err);
                sendStatus('error');
                try {
                    es.close();
                } catch (_) {}
                donattyEventSource = null;
                scheduleDonattyReconnect();
            };
        } catch (err) {
            console.error('Donatty SSE open error:', err);
            sendStatus('error');
            scheduleDonattyReconnect();
        }
    }

    function scheduleDonattyReconnect() {
        if (donattyReconnectTimeout) return;

        const delay =
            RECONNECTION_DELAY_MIN +
            Math.random() * (RECONNECTION_DELAY_MAX - RECONNECTION_DELAY_MIN);

        donattyReconnectTimeout = setTimeout(() => {
            donattyReconnectTimeout = null;
            startDonatty();
        }, delay);
    }

    function normalizeDonattyDonation(raw) {
        if (!raw || typeof raw !== 'object') return null;

        let obj = raw;

        if (obj.data && typeof obj.data === 'object') obj = obj.data;
        if (obj.payload && typeof obj.payload === 'object') obj = obj.payload;
        if (obj.donation && typeof obj.donation === 'object') obj = obj.donation;

        const id =
            obj.id ||
            obj.donationId ||
            obj.donation_id ||
            obj.tx_id ||
            obj.uuid ||
            null;

        // Возможные варианты полей суммы
        const amountKeys = [
            'amount_main',
            'amount',
            'sum',
            'value',
            'amountRub',
            'amountUsd'
        ];

        let amount = null;
        for (const key of amountKeys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                const num = Number(obj[key]);
                if (Number.isFinite(num)) {
                    amount = num;
                    break;
                }
            }
        }

        if (!Number.isFinite(amount) || amount <= 0) return null;

        if (obj.isTest === true || obj.test === true || obj.is_test === true) {
            return null;
        }

        return { id, amount };
    }

    if (
        typeof window !== 'undefined' &&
        typeof donattyWidgetRef !== 'undefined' &&
        typeof donattyWidgetToken !== 'undefined' &&
        donattyWidgetRef &&
        donattyWidgetToken
    ) {
        if (typeof fetch !== 'undefined') {
            startDonatty();
        } else {
            console.warn('Donatty: fetch не поддерживается в этом окружении');
        }
    }
})();