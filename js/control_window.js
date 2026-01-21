const { ipcRenderer } = require('electron');

const toggleBtn = document.getElementById('togglePanelBtn');
const sleepToggle = document.getElementById('sleepModeToggle');
const donationToggle = document.getElementById('donationModeToggle');
const rubPerHourInput = document.getElementById('rubPerHourInput');

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

    if (typeof s.secondsAddedPerCurrency !== 'undefined' && s.secondsAddedPerCurrency > 0) {
        const rubPerHour = 3600 / s.secondsAddedPerCurrency;
        rubPerHourInput.value = Math.round(rubPerHour);
    }
}

ipcRenderer.invoke('settings:get').then(apply);
ipcRenderer.on('settings:update', (_e, s) => apply(s));

sleepToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', { sleepModeEnabled: sleepToggle.checked })
);

donationToggle.addEventListener('change', () =>
    ipcRenderer.send('settings:set', { donationModeEnabled: donationToggle.checked })
);

rubPerHourInput.addEventListener('input', () => {
    const rub = parseFloat(rubPerHourInput.value);
    if (!isNaN(rub) && rub > 0) {
        ipcRenderer.send('settings:set', {
            secondsAddedPerCurrency: 3600 / rub
        });
    }
});

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

Object.keys(indicators).forEach(sys =>
    setIndicator(sys, 'disconnected')
);

ipcRenderer.on('donation:status', (_e, { system, status }) => {
    setIndicator(system, status);
});