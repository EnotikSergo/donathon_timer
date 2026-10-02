(function () {
    const SYSTEM = 'DX';
    const POLL_INTERVAL = 5000;
    const API_URL = 'https://donatex.gg/api/v1/donations';

    let pollTimeout = null;
    let isConnected = false;

    let lastProcessedTimestamp = localStorage.getItem('dx_last_processed_ts');

    if (!lastProcessedTimestamp) lastProcessedTimestamp = Date.now().toString();

    function sendStatus(status) {
        if (typeof ipcRenderer !== 'undefined') {
            ipcRenderer.send('donation:status', {
                system: SYSTEM,
                status
            });
        }
    }

    sendStatus('disconnected');

    async function fetchDonations() {
        if (!donateXToken) {
            if (isConnected) {
                isConnected = false;
                sendStatus('disconnected');
            }
            schedulePoll();
            return;
        }

        try {
            const url = `${API_URL}?skip=0&take=30&sortOrder=NewestFirst&token=${encodeURIComponent(donateXToken)}`;
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    console.error('[DX] Неверный токен DonateX или нет доступа');
                    if (isConnected) {
                        isConnected = false;
                        sendStatus('error');
                    }
                } else if (response.status === 429) {
                    console.warn('[DX] Превышен лимит запросов DonateX (429).');
                } else {
                    console.warn(`[DX] Ошибка HTTP: ${response.status}`);
                    if (isConnected) {
                        isConnected = false;
                        sendStatus('error');
                    }
                }
                schedulePoll();
                return;
            }

            const donations = await response.json();

            if (!isConnected) {
                isConnected = true;
                sendStatus('connected');
            }

            if (Array.isArray(donations)) {
                for (let i = donations.length - 1; i >= 0; i--) {
                    processDonation(donations[i]);
                }
            }
        } catch (err) {
            console.error('[DX] Ошибка сети при поллинге:', err);
            if (isConnected) {
                isConnected = false;
                sendStatus('error');
            }
        }

        schedulePoll();
    }

    function processDonation(donation) {
        if (!donation || !donation.id || !donation.timestamp) return;

        const donationTs = new Date(donation.timestamp).getTime();

        if (lastProcessedTimestamp !== null && donationTs <= Number(lastProcessedTimestamp)) {
            return;
        }

        const amount = Number(donation.amountInRub || donation.amount);
        if (amount <= 0) return;

        if (typeof handleDonationWithGoalSystem === 'function') {
            console.log(`[DX] Получен донат: ${amount} руб. от ${donation.username}`);
            handleDonationWithGoalSystem(amount);
        }

        lastProcessedTimestamp = donationTs;
        localStorage.setItem('dx_last_processed_ts', lastProcessedTimestamp.toString());
    }

    function schedulePoll() {
        if (pollTimeout) clearTimeout(pollTimeout);
        pollTimeout = setTimeout(fetchDonations, POLL_INTERVAL);
    }

    fetchDonations();
})();