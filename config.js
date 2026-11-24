var donationAlertsToken = "";
var donateXToken = "";

try {
    const t = require('electron').ipcRenderer.sendSync('auth-tokens:get-sync') || {};
    donationAlertsToken = t.donationAlerts || "";
    donateXToken = t.donateX || "";
} catch (e) {
    console.error('[config] Не удалось получить токены:', e);
}

// Initial Counter Config
var initialHours = 5
var initialMinutes = 0
var initialSeconds = 0

// If this option true - time can be added after reaching "00:00:00", if it false - timer will stop forever after reaching "00:00:00" once
var canIncreaseTimeAfterStop = false;

var isGreenBackground = true;

// Counter controls (in seconds)
var timeIncrease = 60 * 60 // 60 min
var timeDecrease = 60 * 60 // 60 min

var timeMinuteIncDec = 60 // 60 sec

var rublesPerHour = 1000;

// Donation alerts
// This value will be multiplied by donation amount
// Donation is converted automatically to the MAIN donation alerts account currency
var secondsAddedPerCurrency = 60 * 60 / rublesPerHour;

window.donationModeEnabled = false;
window.sleepModeEnabled = false;
