const {ipcRenderer} = require('electron');

const toggleBtn = document.getElementById('togglePanelBtn');
const sleepToggle = document.getElementById('sleepModeToggle');
const donationToggle = document.getElementById('donationModeToggle');
const showRubPerHourToggle = document.getElementById('showRubPerHourToggle');
const rubPerHourInput = document.getElementById('rubPerHourInput');
const dynamicPriceToggle = document.getElementById('dynamicPriceToggle');
const goalHoursInput = document.getElementById('goalHoursInput');
const goalToggleBtn = document.getElementById('goalToggleBtn');
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
        goalToggleBtn.style.background = '#dc3545';
        goalHoursInput.disabled = true;
    } else {
        goalToggleBtn.innerText = 'Активировать сбор';
        goalToggleBtn.style.background = '#28a745';
        goalHoursInput.disabled = false;
    }
});

const indicators = {
    DA: document.getElementById('status-da'),
    DY: document.getElementById('status-dy'),
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

    if (typeof s.secondsAddedPerCurrency !== 'undefined' && s.secondsAddedPerCurrency > 0) {
        const rubPerHour = 3600 / s.secondsAddedPerCurrency;
        rubPerHourInput.value = Math.round(rubPerHour);
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
            secondsAddedPerCurrency: 3600 / rub
        });
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