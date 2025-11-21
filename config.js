// Login Data
var donationAlertsToken = ""
var donattyRef = "";
var donattyWidgetToken = "";
var donattyZoneOffset = -180;

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


// Runtime settings
try {
  const ls = window.localStorage;
  if (ls.getItem('secondsAddedPerCurrency') !== null) {
    const v = parseFloat(ls.getItem('secondsAddedPerCurrency'));
    if (!Number.isNaN(v)) secondsAddedPerCurrency = v;
  }

  if (ls.getItem('donationModeEnabled') !== null) {
    window.donationModeEnabled = (ls.getItem('donationModeEnabled') === 'true');
  } else {
    window.donationModeEnabled = false;
  }
  if (ls.getItem('sleepModeEnabled') !== null) {
    window.sleepModeEnabled = (ls.getItem('sleepModeEnabled') === 'true');
  } else {
    window.sleepModeEnabled = false;
  }
} catch (e) {
  window.donationModeEnabled = (typeof window.donationModeEnabled === 'boolean') ? window.donationModeEnabled : false;
  window.sleepModeEnabled = (typeof window.sleepModeEnabled === 'boolean') ? window.sleepModeEnabled : false;
}
