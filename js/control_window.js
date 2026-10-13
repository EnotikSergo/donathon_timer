const {ipcRenderer} = require('electron');

const toggleBtn = document.getElementById('togglePanelBtn');
const sleepToggle = document.getElementById('sleepModeToggle');
const donationToggle = document.getElementById('donationModeToggle');
const showRubPerHourToggle = document.getElementById('showRubPerHourToggle');
const rubPerHourInput = document.getElementById('rubPerHourInput');
const dynamicPriceToggle = document.getElementById('dynamicPriceToggle');
const goalHoursInput = document.getElementById('goalHoursInput');
const goalToggleBtn = document.getElementById('goalToggleBtn');
const dynamicPriceStepInput = document.getElementById('dynamicPriceStepInput');
const serviceSelect = document.getElementById('serviceSelect');
const tokenInput = document.getElementById('tokenInput');
const requestTokenBtn = document.getElementById('requestTokenBtn');
const applyTokenBtn = document.getElementById('applyTokenBtn');
const tokenStatus = document.getElementById('tokenStatus');

let authTokens = {};
let isGoalActiveLocal = false;

goalToggleBtn.addEventListener('change', () => {
});

goalToggleBtn.addEventListener('click', () => {
    if (!isGoalActiveLocal) {
        const hours = parseFloat(goalHoursInput.value);
        if (isNaN(hours) || hours <= 0) return;
        ipcRenderer.send('goal:activate', {hours});
    } else {
        ipcRenderer.send('goal:deactivate');
    }
});

ipcRenderer.on('goal:status', (_e, active) => {
    isGoalActiveLocal = active;
    if (active) {
        goalToggleBtn.innerText = 'Остановить сбор';
        goalToggleBtn.style.setProperty('background', '#dc3545');
        goalHoursInput.disabled = true;
    } else {
        goalToggleBtn.innerText = 'Активировать сбор';
        goalToggleBtn.removeAttribute('style');
        goalHoursInput.disabled = false;
    }
});

const indicators = {
    DA: document.getElementById('status-da'),
    DX: document.getElementById('status-dx'),
    TR: document.getElementById('status-tr')
};

toggleBtn.addEventListener('click', () => {
    ipcRenderer.send('control:toggle');
});

function apply(s) {
    if (!s) return;

    if (typeof s.sleepModeEnabled !== 'undefined')
        sleepToggle.checked = !!s.sleepModeEnabled;

    if (typeof s.donationModeEnabled !== 'undefined')
        donationToggle.checked = !!s.donationModeEnabled;

    if (typeof s.showRubPerHour !== 'undefined')
        showRubPerHourToggle.checked = !!s.showRubPerHour;

    if (typeof s.baseRubPerHour !== 'undefined') {
        rubPerHourInput.value = Math.round(s.baseRubPerHour);
    } else if (typeof s.secondsAddedPerCurrency !== 'undefined' && s.secondsAddedPerCurrency > 0) {
        rubPerHourInput.value = Math.round(3600 / s.secondsAddedPerCurrency);
    }

    if (typeof s.dynamicPriceStep !== 'undefined') {
        dynamicPriceStepInput.value = Math.round(s.dynamicPriceStep);
    }

    if (typeof s.dynamicPriceIncreaseEnabled !== 'undefined')
        dynamicPriceToggle.checked = !!s.dynamicPriceIncreaseEnabled;
}

ipcRenderer.invoke('settings:get').then(apply);
ipcRenderer.on('settings:update', (_e, s) => apply(s));

sleepToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', {sleepModeEnabled: sleepToggle.checked})
);

donationToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', {donationModeEnabled: donationToggle.checked})
);

showRubPerHourToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', {showRubPerHour: showRubPerHourToggle.checked})
);

rubPerHourInput.addEventListener('input', () => {
    const rub = parseFloat(rubPerHourInput.value);
    if (!isNaN(rub) && rub > 0) {
        ipcRenderer.send('settings:set', {
            baseRubPerHour: rub,
            secondsAddedPerCurrency: 3600 / rub
        });
    }
});

dynamicPriceStepInput.addEventListener('input', () => {
    const step = parseFloat(dynamicPriceStepInput.value);
    if (!isNaN(step) && step > 0) {
        ipcRenderer.send('settings:set', { dynamicPriceStep: step });
    }
});

dynamicPriceToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', {dynamicPriceIncreaseEnabled: dynamicPriceToggle.checked})
);

function setIndicator(system, state) {
    const el = indicators[system];
    if (!el) return;

    el.classList.remove('green', 'red', 'black');

    switch (state) {
        case 'connected':
            el.classList.add('green');
            break;
        case 'error':
            el.classList.add('red');
            break;
        default:
            el.classList.add('black');
    }
}

ipcRenderer.on('donation:status', (_e, {system, status}) => {
    setIndicator(system, status);
});

function showTokenStatus(text, ok = true) {
    if (!tokenStatus) return;
    tokenStatus.textContent = text;
    tokenStatus.style.color = ok ? '#2ecc71' : '#e74c3c';
}

function fillTokenField() {
    if (!serviceSelect || !tokenInput) return;
    tokenInput.value = authTokens[serviceSelect.value] || '';
    showTokenStatus('');
}

async function loadAuthTokens() {
    try {
        authTokens = await ipcRenderer.invoke('auth-tokens:get');
        fillTokenField();
    } catch (e) {
        console.error('[auth] Не удалось загрузить токены:', e);
        showTokenStatus('Не удалось загрузить токены', false);
    }
}

if (serviceSelect) {
    serviceSelect.addEventListener('change', fillTokenField);
}

if (requestTokenBtn) {
    requestTokenBtn.addEventListener('click', () => {
        ipcRenderer.send('auth-tokens:request', serviceSelect.value);
        showTokenStatus('Открыта страница сервиса', true);
    });
}

if (applyTokenBtn) {
    applyTokenBtn.addEventListener('click', async () => {
        const service = serviceSelect.value;
        const token = tokenInput.value.trim();

        if (!token) {
            showTokenStatus('Введите токен', false);
            return;
        }

        try {
            const ok = await ipcRenderer.invoke('auth-tokens:save', {service, token});
            if (ok) {
                authTokens[service] = token;
                showTokenStatus('Токен сохранён', true);
            } else {
                showTokenStatus('Ошибка записи файла', false);
            }
        } catch (e) {
            console.error('[auth] Ошибка сохранения:', e);
            showTokenStatus('Ошибка сохранения', false);
        }
    });
}

ipcRenderer.on('auth-token-received', (_e, data) => {
    if (data && data.token) {
        if (serviceSelect.value === data.service) {
            tokenInput.value = data.token;
            showTokenStatus('Токен получен и автоматически вставлен!', true);
        } else {
            showTokenStatus(`Токен для ${data.service} получен. Переключите сервис для вставки.`, true);
        }
    }
});

loadAuthTokens();