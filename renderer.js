const { app, BrowserWindow, ipcMain } = require('electron');
const { startOverlayServer } = require('./overlay_server');

let overlay;
let timerWin = null;
let controlWin = null;
let settings = {
  donationModeEnabled: true,
  sleepModeEnabled: false,
  secondsAddedPerCurrency: 3.6
};

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
    height: 280,
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
    if (timerWin && !timerWin.isDestroyed()) timerWin.webContents.send('settings:update', settings);
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('settings:update', settings);
  });

  ipcMain.on('control:toggle', () => {
    if (!controlWin || controlWin.isDestroyed()) return;
    if (controlWin.isVisible()) controlWin.hide(); else controlWin.show();
  });

  timerWin.on('closed', () => {
    try { if (controlWin && !controlWin.isDestroyed()) controlWin.close(); } catch (e) {}
    timerWin = null; controlWin = null;
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

ipcMain.on('overlay:state', (_, state) => { try { overlay && overlay.push(state); } catch {} });
ipcMain.on('overlay:event', (_, event) => { overlay.pushEvent(event); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
