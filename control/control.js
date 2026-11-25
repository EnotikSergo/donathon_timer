const ipcRenderer = window.controlBridge;

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
const boostyBlogRow = document.getElementById('boostyBlogRow');
const boostyBlogInput = document.getElementById('boostyBlogInput');
const requestTokenBtn = document.getElementById('requestTokenBtn');
const applyTokenBtn = document.getElementById('applyTokenBtn');
const logoutBtn = document.getElementById('logoutBtn');
const tokenStatus = document.getElementById('tokenStatus');

let authTokens = {};
let isGoalActiveLocal = false;

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
    BY: document.getElementById('status-by')
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
        ipcRenderer.send('settings:set', {baseRubPerHour: rub});
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

ipcRenderer.invoke('donation:get-statuses').then((statuses) => {
    for (const [system, status] of Object.entries(statuses || {})) setIndicator(system, status);
});

const STATUS_COLORS = {ok: '#2ecc71', error: '#e74c3c', warning: '#f1c40f', info: ''};

let accounts = null;
let localStatus = null;

function showTokenStatus(text, kind = 'ok') {
    if (!tokenStatus) return;
    tokenStatus.textContent = text;
    tokenStatus.style.color = STATUS_COLORS[kind] || '';
}

function accountStatusText(service) {
    const a = accounts && accounts[service];
    if (!a) return null;

    if (service === 'donationAlerts' && a.loginPending) {
        return {text: 'Ожидание входа в браузере…', kind: 'warning'};
    }
    switch (a.status) {
        case 'checking':
            return {text: 'Проверка токена…', kind: 'info'};
        case 'ok':
            if (a.warning) return {text: a.warning, kind: 'warning'};
            return {text: a.name ? `Подключено: ${a.name}` : 'Подключено', kind: 'ok'};
        case 'invalid':
            return {text: a.message || 'Нужна авторизация', kind: 'error'};
        case 'unverified':
            return {text: a.message || 'Токен не проверен', kind: 'warning'};
        default:
            return {text: '', kind: 'info'};
    }
}

function renderTokenStatus() {
    const service = serviceSelect.value;
    if (localStatus && localStatus.service === service) {
        showTokenStatus(localStatus.text, localStatus.kind);
        return;
    }
    const status = accountStatusText(service);
    if (status) showTokenStatus(status.text, status.kind);
}

function setLocalStatus(text, kind) {
    localStatus = text ? {service: serviceSelect.value, text, kind} : null;
    renderTokenStatus();
}

const SERVICE_NAMES = {donationAlerts: 'DonationAlerts', donateX: 'DonateX', boosty: 'Boosty'};
const TOKEN_PLACEHOLDERS = {
    donationAlerts: 'Вставьте токен сюда',
    donateX: 'Вставьте токен сюда',
    boosty: 'Значение Cookie с boosty.to'
};

function storedBoostyBlog() {
    try {
        return JSON.parse(authTokens.boosty || '{}').blog || '';
    } catch (e) {
        return '';
    }
}

function updateLogoutButton() {
    const service = serviceSelect.value;
    logoutBtn.textContent = `Выйти из ${SERVICE_NAMES[service] || 'сервиса'}`;
    logoutBtn.disabled = !authTokens[service];
}

function fillTokenField() {
    if (!serviceSelect || !tokenInput) return;
    const service = serviceSelect.value;
    tokenInput.value = authTokens[service] || '';
    tokenInput.placeholder = TOKEN_PLACEHOLDERS[service] || '';
    boostyBlogRow.hidden = service !== 'boosty';
    if (service === 'boosty' && authTokens.boosty) boostyBlogInput.value = storedBoostyBlog();
    localStatus = null;
    renderTokenStatus();
    updateLogoutButton();
}

async function loadAuthTokens() {
    try {
        authTokens = await ipcRenderer.invoke('auth-tokens:get');
        fillTokenField();
    } catch (e) {
        console.error('[auth] Не удалось загрузить токены:', e);
        setLocalStatus('Не удалось загрузить токены', 'error');
    }
}

serviceSelect.addEventListener('change', fillTokenField);

requestTokenBtn.addEventListener('click', async () => {
    if (serviceSelect.value === 'donationAlerts') {
        const result = await ipcRenderer.invoke('auth:da-login');
        if (result && result.ok) {
            setLocalStatus('');
        } else {
            setLocalStatus((result && result.error) || 'Не удалось начать вход', 'error');
        }
    } else if (serviceSelect.value === 'boosty') {
        if (!boostyBlogInput.value.trim()) {
            setLocalStatus('Сначала укажите блог Boosty', 'error');
            return;
        }
        requestTokenBtn.disabled = true;
        setLocalStatus('Войдите в Boosty в открывшемся окне. Оно закроется само после входа', 'warning');
        try {
            const result = await ipcRenderer.invoke('auth:boosty-login', boostyBlogInput.value.trim());
            setLocalStatus(result && result.ok ? '' : ((result && result.error) || 'Не удалось войти в Boosty'), result && result.ok ? 'info' : 'error');
        } finally {
            requestTokenBtn.disabled = false;
        }
    } else {
        ipcRenderer.send('auth:dx-open-settings');
        setLocalStatus('Открыта страница сервиса. Токен: Настройки → API и доступ', 'info');
    }
});

applyTokenBtn.addEventListener('click', async () => {
    const service = serviceSelect.value;
    const token = tokenInput.value.trim();

    if (service === 'donationAlerts') {
        setLocalStatus('Токен DonationAlerts применяется автоматически после входа через «Запросить токен»', 'info');
        return;
    }

    if (!token) {
        setLocalStatus('Введите токен', 'error');
        return;
    }

    if (service === 'boosty' && !boostyBlogInput.value.trim()) {
        setLocalStatus('Укажите блог Boosty', 'error');
        return;
    }

    applyTokenBtn.disabled = true;
    setLocalStatus('Проверка токена…', 'info');
    try {
        const result = service === 'boosty'
            ? await ipcRenderer.invoke('auth:boosty-save', {token, blog: boostyBlogInput.value.trim()})
            : await ipcRenderer.invoke('auth:dx-save', token);
        if (result && result.ok) {
            if (service !== 'boosty') authTokens[service] = token;
            setLocalStatus('');
        } else {
            setLocalStatus((result && result.error) || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        console.error('[auth] Ошибка сохранения:', e);
        setLocalStatus('Ошибка сохранения', 'error');
    } finally {
        applyTokenBtn.disabled = false;
    }
});

logoutBtn.addEventListener('click', async () => {
    const service = serviceSelect.value;
    if (!authTokens[service]) return;

    logoutBtn.disabled = true;
    try {
        const result = await ipcRenderer.invoke('auth:logout', service);
        if (result && result.ok) {
            authTokens[service] = '';
            tokenInput.value = '';
            setLocalStatus(service === 'donationAlerts'
                ? 'Токен удалён. Полностью отозвать доступ можно в настройках DonationAlerts'
                : 'Токен удалён из программы', 'info');
        } else {
            setLocalStatus((result && result.error) || 'Не удалось выйти', 'error');
        }
    } catch (e) {
        console.error('[auth] Ошибка выхода:', e);
        setLocalStatus('Не удалось выйти', 'error');
    } finally {
        updateLogoutButton();
    }
});

ipcRenderer.on('auth-tokens:changed', (_e, tokens) => {
    const previous = authTokens;
    authTokens = tokens || {};
    const service = serviceSelect.value;
    if ((previous[service] || '') !== (authTokens[service] || '')) {
        tokenInput.value = authTokens[service] || '';
        if (service === 'boosty' && authTokens.boosty) boostyBlogInput.value = storedBoostyBlog();
    }
    if (service === 'donationAlerts' && authTokens.donationAlerts && previous.donationAlerts !== authTokens.donationAlerts) {
        localStatus = null;
    }
    renderTokenStatus();
    updateLogoutButton();
});

ipcRenderer.invoke('accounts:get').then((a) => {
    accounts = a;
    renderTokenStatus();
});
ipcRenderer.on('accounts:update', (_e, a) => {
    accounts = a;
    renderTokenStatus();
});

loadAuthTokens();
