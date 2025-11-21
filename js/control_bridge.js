(function(){
  try {
    const { ipcRenderer } = require('electron');
    function apply(s) {
      if (!s) return;
      if (typeof s.donationModeEnabled !== 'undefined') window.donationModeEnabled = !!s.donationModeEnabled;
      if (typeof s.sleepModeEnabled !== 'undefined') window.sleepModeEnabled = !!s.sleepModeEnabled;
      if (typeof s.secondsAddedPerCurrency !== 'undefined') {
        if (typeof secondsAddedPerCurrency !== 'undefined') {
          secondsAddedPerCurrency = Number(s.secondsAddedPerCurrency);
        } else {
          window.secondsAddedPerCurrency = Number(s.secondsAddedPerCurrency);
        }
      }

      window.dispatchEvent(new CustomEvent('sleepModeMaybeChanged', { detail: { sleepModeEnabled: window.sleepModeEnabled } }));
    }
    ipcRenderer.invoke('settings:get').then(apply);
    ipcRenderer.on('settings:update', (_e, s) => apply(s));

  } catch(e) { }
})();