(function () {
    try {
        const {ipcRenderer} = require('electron');

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
            if (typeof s.dynamicPriceIncreaseEnabled !== 'undefined') window.dynamicPriceIncreaseEnabled = !!s.dynamicPriceIncreaseEnabled;

            window.dispatchEvent(new CustomEvent('sleepModeMaybeChanged', {detail: {sleepModeEnabled: window.sleepModeEnabled}}));
        }

        ipcRenderer.invoke('settings:get').then(apply);
        ipcRenderer.on('settings:update', (_e, s) => apply(s));
        ipcRenderer.on('auth-tokens:updated', (_e, tokens) => {
            const t = tokens || {};
            const services = window.donationServices || {};

            if ((t.donationAlerts || '') !== donationAlertsToken) {
                donationAlertsToken = t.donationAlerts || '';
                console.log('[Bridge] Токен DonationAlerts обновлён, переподключение');
                if (services.DA) services.DA.restart();
            }
            if ((t.donateX || '') !== donateXToken) {
                donateXToken = t.donateX || '';
                console.log('[Bridge] Токен DonateX обновлён, переподключение');
                if (services.DX) services.DX.restart();
            }
        });

    } catch (e) {
    }
})();