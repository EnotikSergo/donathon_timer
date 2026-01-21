const RECONNECTION_DELAY_MIN = 1000;
const RECONNECTION_DELAY_MAX = 5000;

let lastDonationId = null;
let donationalerts = null;
let reconnectTimeout = null;
let isConnecting = false;

const SYSTEM = 'DA';

const config = {
    socket: 'wss://socket.donationalerts.ru',
    socketPort: '443',
    type: 'alert_widget'
};

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

function connectDonationAlerts() {
    if (isConnecting) return;
    isConnecting = true;

    console.log('[DA] Подключение к DonationAlerts...');
    sendStatus('disconnected');

    donationalerts = io(`${config.socket}:${config.socketPort}`, {
        transports: ['websocket'],
        reconnection: false
    });

    donationalerts.on('connect', () => {
        console.log('[DA] Успешное подключение к DonationAlerts');
        isConnecting = false;
        sendStatus('connected');

        donationalerts.emit('add-user', {
            token: donationAlertsToken,
            type: config.type
        });
    });

    donationalerts.on('donation', (donate) => {
        try {
            donate = JSON.parse(donate);

            if (!donate.id || donate.id === lastDonationId) return;
            lastDonationId = donate.id;

            const { amount_main, alert_type } = donate;

            if (
                alert_type == '1' &&
                (typeof window.donationModeEnabled === 'undefined'
                    || window.donationModeEnabled)
            ) {
                addTime(endingTime, amount_main * secondsAddedPerCurrency);
            }

        } catch (e) {
            console.error('[DA] Ошибка обработки доната:', e);
        }
    });

    donationalerts.on('disconnect', (reason) => {
        console.warn('[DA] Соединение потеряно:', reason);
        sendStatus('error');
        scheduleReconnect();
    });

    donationalerts.on('connect_error', (err) => {
        console.warn('[DA] Ошибка соединения:', err.message);
        sendStatus('error');
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimeout) return;

    isConnecting = false;

    const delay = getReconnectDelay();
    console.log(`[DA] Переподключение через ${delay} мс`);

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectDonationAlerts();
    }, delay);
}

if (donationAlertsToken && donationAlertsToken !== "") {
    connectDonationAlerts();
} else {
    console.warn('[DA] Токен DonationAlerts отсутствует');
    sendStatus('disconnected');
}