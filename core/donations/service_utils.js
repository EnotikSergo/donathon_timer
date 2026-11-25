const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const RECONNECT_JITTER = 500;

function createBackoff({timers, random = Math.random, base = RECONNECT_BASE, max = RECONNECT_MAX, jitter = RECONNECT_JITTER}) {
    let attempt = 0;
    let timer = null;

    return {
        schedule(fn, minDelay = 0) {
            if (timer) return null;
            const delay = Math.max(minDelay, Math.min(max, base * Math.pow(2, attempt)) + Math.floor(random() * jitter));
            attempt++;
            timer = timers.setTimeout(() => {
                timer = null;
                fn();
            }, delay);
            return delay;
        },
        cancel() {
            if (timer) {
                timers.clearTimeout(timer);
                timer = null;
            }
        },
        reset() {
            attempt = 0;
        },
        get pending() {
            return timer !== null;
        }
    };
}

function createIdSet(limit, initial = []) {
    const ids = new Set(initial.map(String));
    return {
        has: (id) => ids.has(String(id)),
        add(id) {
            ids.add(String(id));
            while (ids.size > limit) ids.delete(ids.values().next().value);
        },
        toArray: () => Array.from(ids)
    };
}

function createStatusReporter(onStatus) {
    let current = null;
    return {
        set(status) {
            if (status === current) return;
            current = status;
            try {
                onStatus(status);
            } catch (e) {
                console.error('Не удалось передать статус подключения:', e);
            }
        },
        get current() {
            return current;
        },
        reset() {
            current = null;
        }
    };
}

async function requestJson(fetchImpl, timers, url, {method = 'GET', headers = {}, body, timeoutMs = 8000} = {}) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method,
            signal: controller.signal,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let json = null;
        try {
            json = await res.json();
        } catch {
        }
        const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('Retry-After') : NaN);
        return {status: res.status, ok: res.ok, json, retryAfter};
    } finally {
        timers.clearTimeout(timer);
    }
}

const defaultTimers = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (t) => clearInterval(t)
};

module.exports = {createBackoff, createIdSet, createStatusReporter, requestJson, defaultTimers};
