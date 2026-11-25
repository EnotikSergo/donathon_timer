const {parseBoostyCredentials} = require('./donations/boosty_auth');

const LOGIN_URL = 'https://boosty.to/';
const COOKIE_URL = 'https://boosty.to';
const PARTITION = 'boosty-login';
const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function browserUserAgent(userAgent) {
    return String(userAgent || '').replace(/\s(Electron|donathon-countdown)\/\S+/g, '');
}

function createBoostyLogin({BrowserWindow, session, getParent = () => null, userAgent = '', timers = globalThis}) {
    const loginContents = new WeakSet();
    let active = null;

    const secureWebPreferences = () => ({
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
    });

    function isLoginContents(contents) {
        return loginContents.has(contents);
    }

    async function readCredentials(ses) {
        const cookies = await ses.cookies.get({url: COOKIE_URL});
        const auth = cookies.find((c) => c.name === 'auth');
        const clientId = cookies.find((c) => c.name === '_clientId');
        if (!auth || !clientId) return null;
        const header = `auth=${auth.value}; _clientId=${clientId.value}`;
        const creds = parseBoostyCredentials(header);
        return creds && creds.deviceId ? header : null;
    }

    function open() {
        if (active) {
            if (active.win && !active.win.isDestroyed()) active.win.focus();
            return active.promise;
        }

        const ses = session.fromPartition(PARTITION);
        const ua = browserUserAgent(userAgent);
        const state = {win: null, children: new Set(), done: false};

        state.promise = new Promise((resolve) => {
            let pollTimer = null;
            let timeoutTimer = null;

            const finish = async (result) => {
                if (state.done) return;
                state.done = true;
                timers.clearInterval(pollTimer);
                timers.clearTimeout(timeoutTimer);
                for (const w of [state.win, ...state.children]) {
                    if (w && !w.isDestroyed()) w.close();
                }
                try {
                    await ses.clearStorageData();
                } catch {
                }
                active = null;
                resolve(result);
            };

            const start = async () => {
                try {
                    await ses.clearStorageData();
                } catch {
                }

                const win = new BrowserWindow({
                    width: 1100,
                    height: 780,
                    title: 'Вход в Boosty',
                    parent: getParent() || undefined,
                    autoHideMenuBar: true,
                    webPreferences: secureWebPreferences()
                });
                state.win = win;
                loginContents.add(win.webContents);
                if (ua) win.webContents.setUserAgent(ua);

                win.webContents.setWindowOpenHandler(({url}) => (String(url).startsWith('https://')
                    ? {action: 'allow', overrideBrowserWindowOptions: {autoHideMenuBar: true, webPreferences: secureWebPreferences()}}
                    : {action: 'deny'}));
                win.webContents.on('did-create-window', (child) => {
                    state.children.add(child);
                    loginContents.add(child.webContents);
                    if (ua) child.webContents.setUserAgent(ua);
                    child.on('closed', () => state.children.delete(child));
                });
                win.on('closed', () => finish(null));

                pollTimer = timers.setInterval(async () => {
                    if (state.done) return;
                    try {
                        const header = await readCredentials(ses);
                        if (header) finish(header);
                    } catch {
                    }
                }, POLL_INTERVAL_MS);
                timeoutTimer = timers.setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);

                win.loadURL(LOGIN_URL).catch(() => {});
            };

            start();
        });

        active = state;
        return state.promise;
    }

    return {open, isLoginContents, isOpen: () => active !== null};
}

module.exports = {createBoostyLogin, browserUserAgent, BOOSTY_LOGIN_PARTITION: PARTITION};
