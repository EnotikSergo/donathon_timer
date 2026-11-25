const crypto = require('crypto');
const {DA_CLIENT_ID, DA_REDIRECT_PORT} = require('../constants');

const DA_REDIRECT_URI = `http://localhost:${DA_REDIRECT_PORT}/auth/da`;
const DA_SCOPES = ['oauth-user-show', 'oauth-donation-subscribe', 'oauth-donation-index'];
const DA_PROFILE_URL = 'https://www.donationalerts.com/api/v1/user/oauth';
const DX_PROFILE_URL = 'https://donatex.gg/api/v1/user/me';
const DX_SETTINGS_URL = 'https://donatex.gg/streamer/settings';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;

function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function createAuthManager(deps) {
    const {tokens, meta, httpGetJson, openExternal, overlayPort, onChange, onTokensChanged} = deps;

    const accounts = {
        donationAlerts: {status: 'none', name: '', message: '', warning: '', loginPending: false},
        donateX: {status: 'none', name: '', message: '', warning: ''}
    };

    let pendingLogin = null;
    let pendingTimer = null;
    const checkSeq = {donationAlerts: 0, donateX: 0};

    function emit() {
        try {
            onChange(getAccounts());
        } catch (e) {
            console.error('[auth] Не удалось отправить состояние аккаунтов:', e);
        }
    }

    function setAccount(service, patch) {
        Object.assign(accounts[service], patch);
        emit();
    }

    function getAccounts() {
        return JSON.parse(JSON.stringify(accounts));
    }

    function daWarning(m) {
        if (!m) return '';
        if (m.expiresAt && m.expiresAt - Date.now() < EXPIRY_WARNING_MS) {
            return `Токен действует до ${formatDate(m.expiresAt)}. Запросите токен заново заранее.`;
        }
        const scopes = Array.isArray(m.scopes) ? m.scopes : [];
        if (!scopes.includes('oauth-donation-index')) {
            return 'Запросите токен заново, чтобы программа могла досчитывать донаты, пропущенные при обрыве связи.';
        }
        return '';
    }

    async function verify(service) {
        const all = tokens.read();
        const token = all[service];
        const seq = ++checkSeq[service];

        if (!token) {
            setAccount(service, {status: 'none', name: '', message: '', warning: ''});
            return;
        }

        const m = service === 'donationAlerts' ? (meta.read()[service] || null) : null;
        if (m && m.expiresAt && m.expiresAt <= Date.now()) {
            setAccount(service, {status: 'invalid', name: '', message: 'Срок действия токена истёк. Запросите токен заново.', warning: ''});
            return;
        }

        setAccount(service, {status: 'checking', message: '', warning: ''});

        let result;
        try {
            result = service === 'donationAlerts'
                ? await httpGetJson(DA_PROFILE_URL, {'Authorization': `Bearer ${token}`})
                : await httpGetJson(DX_PROFILE_URL, {'X-External-Token': token});
        } catch (e) {
            result = {status: 0, error: e};
        }
        if (seq !== checkSeq[service]) return;

        if (result.status === 200) {
            const body = result.json || {};
            const name = service === 'donationAlerts'
                ? ((body.data && (body.data.name || body.data.code)) || '')
                : (body.username || '');
            setAccount(service, {
                status: 'ok',
                name,
                message: '',
                warning: service === 'donationAlerts' ? daWarning(m) : ''
            });
        } else if (result.status === 401 || result.status === 403) {
            setAccount(service, {
                status: 'invalid',
                name: '',
                message: service === 'donationAlerts'
                    ? 'Доступ отозван или токен недействителен. Запросите токен заново.'
                    : 'Токен недействителен. Вставьте новый токен.',
                warning: ''
            });
        } else {
            setAccount(service, {
                status: 'unverified',
                message: 'Не удалось проверить аккаунт: нет связи с сервисом.',
                warning: service === 'donationAlerts' ? daWarning(m) : ''
            });
        }
    }

    function clearPending() {
        pendingLogin = null;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        if (accounts.donationAlerts.loginPending) setAccount('donationAlerts', {loginPending: false});
    }

    function isAuthPending(service) {
        if (service !== 'donationAlerts' || !pendingLogin) return false;
        if (Date.now() > pendingLogin.until) {
            clearPending();
            return false;
        }
        return true;
    }

    function startDaLogin() {
        if (Number(overlayPort) !== DA_REDIRECT_PORT) {
            return {
                ok: false,
                error: `Вход в DonationAlerts работает только на порту ${DA_REDIRECT_PORT}, а сейчас задан порт ${overlayPort} (OVERLAY_PORT).`
            };
        }

        const state = crypto.randomBytes(16).toString('hex');
        pendingLogin = {state, until: Date.now() + LOGIN_TTL_MS};
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(clearPending, LOGIN_TTL_MS);
        if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
        setAccount('donationAlerts', {loginPending: true});

        const url = 'https://www.donationalerts.com/oauth/authorize?' + new URLSearchParams({
            client_id: DA_CLIENT_ID,
            redirect_uri: DA_REDIRECT_URI,
            response_type: 'token',
            scope: DA_SCOPES.join(' '),
            state
        }).toString();

        try {
            openExternal(url);
        } catch (e) {
            clearPending();
            return {ok: false, error: 'Не удалось открыть браузер.'};
        }
        return {ok: true};
    }

    async function handleDaCallback(payload) {
        if (!isAuthPending('donationAlerts')) return {ok: false, error: 'not_pending'};

        const token = payload && typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
        if (!token || token.length > MAX_TOKEN_LENGTH) return {ok: false, error: 'bad_token'};

        if (payload.state) {
            if (payload.state !== pendingLogin.state) return {ok: false, error: 'state_mismatch'};
        } else {
            console.warn('[auth] DonationAlerts не вернул state, ответ принят по активному входу');
        }

        const expiresIn = Number(payload.expires_in);
        const now = Date.now();
        try {
            tokens.update('donationAlerts', token);
            const allMeta = meta.read();
            allMeta.donationAlerts = {
                obtainedAt: now,
                expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
                scopes: DA_SCOPES.slice()
            };
            meta.write(allMeta);
        } catch (e) {
            console.error('[auth] Не удалось сохранить токен DonationAlerts:', e);
            return {ok: false, error: 'save_failed'};
        }

        clearPending();
        console.log('[auth] Получен токен DonationAlerts');
        onTokensChanged();
        verify('donationAlerts');
        return {ok: true};
    }

    async function saveDxToken(rawToken) {
        const token = String(rawToken || '').trim();
        if (!token) return {ok: false, error: 'Вставьте токен.'};
        if (token.length > MAX_TOKEN_LENGTH) return {ok: false, error: 'Слишком длинный токен.'};

        let result;
        try {
            result = await httpGetJson(DX_PROFILE_URL, {'X-External-Token': token});
        } catch (e) {
            result = {status: 0};
        }

        if (result.status === 401 || result.status === 403) {
            return {ok: false, error: 'DonateX не принял токен. Проверьте, что скопировали его целиком.'};
        }

        try {
            tokens.update('donateX', token);
        } catch (e) {
            console.error('[auth] Не удалось сохранить токен DonateX:', e);
            return {ok: false, error: 'Не удалось сохранить токен.'};
        }

        checkSeq.donateX++;
        if (result.status === 200) {
            setAccount('donateX', {status: 'ok', name: (result.json && result.json.username) || '', message: '', warning: ''});
        } else {
            setAccount('donateX', {status: 'unverified', name: '', message: 'Токен сохранён, но проверить его не удалось: нет связи с DonateX.', warning: ''});
        }
        onTokensChanged();
        return {ok: true};
    }

    function logout(service) {
        if (!accounts[service]) return {ok: false, error: 'Неизвестный сервис.'};
        if (!tokens.read()[service]) return {ok: false, error: 'Токен не сохранён.'};
        try {
            tokens.remove(service);
            const allMeta = meta.read();
            if (allMeta[service]) {
                delete allMeta[service];
                meta.write(allMeta);
            }
        } catch (e) {
            console.error(`[auth] Не удалось удалить токен ${service}:`, e);
            return {ok: false, error: 'Не удалось удалить токен.'};
        }
        if (service === 'donationAlerts') clearPending();
        checkSeq[service]++;
        setAccount(service, {status: 'none', name: '', message: '', warning: ''});
        onTokensChanged();
        return {ok: true};
    }

    function openDxSettings() {
        openExternal(DX_SETTINGS_URL);
    }

    function init() {
        verify('donationAlerts');
        verify('donateX');
    }

    return {getAccounts, init, verify, isAuthPending, startDaLogin, handleDaCallback, saveDxToken, logout, openDxSettings};
}

module.exports = {createAuthManager};
