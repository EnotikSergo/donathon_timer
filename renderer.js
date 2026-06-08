const {app, BrowserWindow, ipcMain} = require('electron');
const {startOverlayServer} = require('./overlay_server');
const fs1 = require('fs');
const path1 = require('path');

const settingsFilePath = path1.join(__dirname, 'settings.json');

let overlay;
let timerWin = null;
let controlWin = null;
let settings = {
    donationModeEnabled: true,
    sleepModeEnabled: false,
    secondsAddedPerCurrency: 3.6,
    showRubPerHour: true,
    dynamicPriceIncreaseEnabled: true,
    maxTimerTier: 0
};

if (fs1.existsSync(settingsFilePath)) {
    try {
        const savedSettings = JSON.parse(fs1.readFileSync(settingsFilePath, 'utf8'));
        settings = Object.assign(settings, savedSettings);

        if (typeof savedSettings.maxTimerTier !== 'undefined') {
            settings.maxTimerTier = savedSettings.maxTimerTier;
        }
    } catch (e) {
        console.error("Не удалось прочесть файл настроек:", e);
    }
}

function createWindows() {
    timerWin = new BrowserWindow({
        width: 800,
        height: 450,
        title: 'NikiWright Timer',
        autoHideMenuBar: true,
        webPreferences: {
            backgroundThrottling: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    timerWin.loadFile('index.html');

    controlWin = new BrowserWindow({
        width: 260,
        height: 446,
        title: 'Timer Control',
        autoHideMenuBar: true,
        resizable: false,
        show: false,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
            backgroundThrottling: false,
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    controlWin.loadFile('control.html');

    ipcMain.handle('settings:get', () => settings);
    ipcMain.on('settings:set', (_evt, partial) => {
        settings = Object.assign(settings, partial || {});
        try {
            const dataToSave = {
                dynamicPriceIncreaseEnabled: settings.dynamicPriceIncreaseEnabled,
                maxTimerTier: settings.maxTimerTier
            };
            fs1.writeFileSync(settingsFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        } catch (e) {
            console.error("Не удалось сохранить настройки:", e);
        }

        if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('settings:update', settings);
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('settings:update', settings);
    });

    ipcMain.on('control:toggle', () => {
        if (!controlWin || controlWin.isDestroyed()) return;
        if (controlWin.isVisible()) controlWin.hide(); else controlWin.show();
    });

    timerWin.on('closed', () => {
        try {
            if (controlWin && !controlWin.isDestroyed()) controlWin.close();
        } catch (e) {
        }
        timerWin = null;
        controlWin = null;
    });

    timerWin.webContents.once('did-finish-load', () => {
        timerWin.webContents.send('settings:update', settings);
    });
    controlWin.webContents.once('did-finish-load', () => {
        controlWin.webContents.send('settings:update', settings);
    });
}

app.whenReady().then(() => {
    overlay = startOverlayServer({
        port: process.env.OVERLAY_PORT || 41701,
        host: '0.0.0.0',
        basePath: '/overlay'
    });
    createWindows();
});

ipcMain.on('donation:status', (_e, data) => {
    if (controlWin && !controlWin.isDestroyed()) {
        controlWin.webContents.send('donation:status', data);
    }
});

ipcMain.on('overlay:state', (_, state) => {
    try {
        overlay && overlay.push(state);
    } catch {
    }
});
ipcMain.on('overlay:event', (_, event) => {
    overlay.pushEvent(event);
});

ipcMain.on('goal:activate', (event, data) => {
    if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('goal:activate', data);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', true);
});

ipcMain.on('goal:deactivate', () => {
    if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('goal:deactivate');
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', false);
});

ipcMain.on('goal:ended', () => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('goal:status', false);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
