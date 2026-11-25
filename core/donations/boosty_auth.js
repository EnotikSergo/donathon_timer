const API_URL = 'https://api.boosty.to';
const REFRESH_MARGIN_MS = 60 * 1000;

function decode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseCookieHeader(text) {
    const cookies = {};
    for (const part of String(text).split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return cookies;
}

function normalizeExpiresAt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? n : n * 1000;
}

function fromObject(obj, deviceId) {
    if (!obj || typeof obj !== 'object') return null;
    const accessToken = obj.accessToken || obj.access_token;
    const refreshToken = obj.refreshToken || obj.refresh_token;
    const device = obj.deviceId || obj.device_id || obj._clientId || deviceId;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return null;
    return {
        accessToken,
        refreshToken,
        expiresAt: normalizeExpiresAt(obj.expiresAt || obj.expires_at),
        deviceId: typeof device === 'string' ? device : ''
    };
}

function tryJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function parseBoostyCredentials(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const direct = fromObject(tryJson(text) || tryJson(decode(text)));
    if (direct) return direct;

    const cookies = parseCookieHeader(text.replace(/^cookie:\s*/i, ''));
    if (cookies.auth) {
        const deviceId = cookies._clientId ? decode(cookies._clientId) : '';
        return fromObject(tryJson(decode(cookies.auth)), deviceId);
    }
    return null;
}

function normalizeBlog(raw) {
    let text = String(raw || '').trim();
    const m = text.match(/boosty\.to\/([^/?#\s]+)/i);
    if (m) text = m[1];
    text = text.replace(/^@/, '').replace(/\/+$/, '');
    return /^[A-Za-z0-9_.-]{1,64}$/.test(text) ? text : '';
}

function serializeCredentials(credentials) {
    return JSON.stringify({
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt || 0,
        deviceId: credentials.deviceId || '',
        blog: credentials.blog || ''
    });
}

function deserializeCredentials(stored) {
    const obj = tryJson(stored || '');
    const creds = fromObject(obj);
    if (!creds) return null;
    creds.blog = normalizeBlog(obj.blog);
    return creds.blog ? creds : null;
}

const needsRefresh = (creds, now) => !!creds.expiresAt && creds.expiresAt - now < REFRESH_MARGIN_MS;

async function refreshBoostyTokens(fetchImpl, creds, now = Date.now()) {
    if (!creds.deviceId) {
        const err = new Error('Нет _clientId — обновить токен нельзя');
        err.status = 401;
        throw err;
    }
    const body = new URLSearchParams({
        device_id: creds.deviceId,
        device_os: 'web',
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken
    }).toString();
    const res = await fetchImpl(`${API_URL}/oauth/token/`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
    }
    if (!res.ok || !json || !json.access_token || !json.refresh_token) {
        const err = new Error(`Не удалось обновить токен Boosty: HTTP ${res.status}`);
        err.status = res.status === 400 ? 401 : res.status;
        throw err;
    }
    const expiresIn = Number(json.expires_in);
    return {
        ...creds,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
        deviceId: json.device_id || creds.deviceId
    };
}

module.exports = {
    API_URL,
    parseBoostyCredentials,
    normalizeBlog,
    serializeCredentials,
    deserializeCredentials,
    needsRefresh,
    refreshBoostyTokens
};
