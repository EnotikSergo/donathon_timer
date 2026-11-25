const {createBackoff, createIdSet, createStatusReporter, requestJson, defaultTimers} = require('./service_utils');
const {API_URL, deserializeCredentials, serializeCredentials, needsRefresh, refreshBoostyTokens} = require('./boosty_auth');

const POLL_INTERVAL = 20000;
const LEVELS_TTL = 10 * 60 * 1000;
const EVENTS_OVERLAP_SECONDS = 300;
const MAX_PROCESSED_IDS = 2000;
const SUBSCRIPTION_EVENTS = ['subscribe', 'recurrent'];
const INSPECT_WINDOWS_DAYS = [7, 30, 90];

function authError(message, status) {
    const err = new Error(message);
    err.status = status;
    err.auth = true;
    return err;
}

function createBoosty(deps) {
    const {
        getCredentials,
        saveCredentials = async () => {},
        onDonation,
        onStatus,
        onAuthInvalid = () => {},
        isDonationModeEnabled = () => true,
        state: stateStore,
        fetch: fetchImpl = globalThis.fetch,
        timers = defaultTimers,
        now = () => Date.now(),
        random = Math.random,
        log = console
    } = deps;

    const status = createStatusReporter(onStatus);
    const backoff = createBackoff({timers, random});

    let creds = null;
    let since = 0;
    let lastEventSec = 0;
    let processed = createIdSet(MAX_PROCESSED_IDS);
    let stateLoaded = false;
    let levels = new Map();
    let levelsLoadedAt = 0;
    let pollTimer = null;
    let generation = 0;
    let authFailed = false;
    let stopped = true;
    let refreshing = null;
    const warned = new Set();

    function warnOnce(key, ...args) {
        if (warned.has(key)) return;
        warned.add(key);
        log.warn(...args);
    }

    function loadState() {
        if (stateLoaded) return;
        stateLoaded = true;
        let saved = {};
        try {
            saved = (stateStore && stateStore.load()) || {};
        } catch (e) {
            log.error('[BY] Не удалось прочитать состояние:', e);
        }
        since = Number(saved.since);
        lastEventSec = Number(saved.lastEventSec) || 0;
        processed = createIdSet(MAX_PROCESSED_IDS, Array.isArray(saved.processedIds) ? saved.processedIds : []);
        if (!Number.isFinite(since) || since <= 0) {
            since = now();
            persist();
        }
    }

    function persist() {
        if (!stateStore) return;
        try {
            stateStore.save({since, lastEventSec, processedIds: processed.toArray()});
        } catch (e) {
            log.error('[BY] Не удалось сохранить состояние:', e);
        }
    }

    function refresh() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            let next;
            try {
                next = await refreshBoostyTokens(fetchImpl, creds, now());
            } catch (e) {
                if (e.status === 401 || e.status === 403) throw authError(e.message, e.status);
                throw e;
            }
            creds = next;
            try {
                await saveCredentials(serializeCredentials(creds));
            } catch (e) {
                log.error('[BY] Не удалось сохранить обновлённый токен:', e);
            }
        })().finally(() => {
            refreshing = null;
        });
        return refreshing;
    }

    async function apiGet(path, params) {
        if (needsRefresh(creds, now())) await refresh();
        const query = new URLSearchParams(params || {}).toString();
        const url = `${API_URL}${path}${query ? `?${query}` : ''}`;
        const call = () => requestJson(fetchImpl, timers, url, {headers: {'Authorization': `Bearer ${creds.accessToken}`}});

        let res = await call();
        if (res.status === 401) {
            await refresh();
            res = await call();
        }
        if (res.status === 401) throw authError('HTTP 401', 401);
        if (res.status === 403) throw authError('HTTP 403: нет доступа к блогу ' + creds.blog, 403);
        if (res.status === 429) {
            const err = new Error('HTTP 429');
            err.retryAfter = res.retryAfter;
            throw err;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} (${path})`);
        return res.json;
    }

    const blogPath = (suffix) => `/v1/blog/${encodeURIComponent(creds.blog)}${suffix}`;

    async function loadLevels(force = false) {
        if (!force && levels.size && now() - levelsLoadedAt < LEVELS_TTL) return;
        const json = await apiGet(blogPath('/subscription_level/'), {show_free_level: 'false'});
        const list = Array.isArray(json && json.data) ? json.data : [];
        const next = new Map();
        for (const level of list) {
            if (!level || level.id === undefined) continue;
            const rub = Number(level.currencyPrices && level.currencyPrices.RUB);
            const price = Number.isFinite(rub) && rub > 0 ? rub : Number(level.price);
            next.set(Number(level.id), {name: level.name || '', price: Number.isFinite(price) ? price : 0});
        }
        levels = next;
        levelsLoadedAt = now();
    }

    function credit(amount, meta) {
        if (!(amount > 0) || !isDonationModeEnabled()) return;
        onDonation(amount, {service: 'boosty', ...meta});
    }

    function extractDonations(json) {
        const data = json && json.data;
        if (Array.isArray(data && data.donationsSales)) return data.donationsSales;
        return Array.isArray(data) ? data : null;
    }

    function subscriptionAmount(e) {
        const level = levels.get(Number(e.levelId));
        const eventAmount = Number(e.amount);
        return {
            level,
            amount: level && level.price > 0 ? level.price : (Number.isFinite(eventAmount) ? eventAmount : 0)
        };
    }

    async function pollDonations() {
        const json = await apiGet(blogPath('/sales/donation/'), {limit: '50', sort_by: 'time', order: 'gt'});
        const list = extractDonations(json);
        if (!list) {
            warnOnce('donations-shape', '[BY] Неожиданный ответ списка донатов:', JSON.stringify(json).slice(0, 300));
            return;
        }
        const items = list
            .filter((d) => d && d.id !== undefined)
            .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
        for (const d of items) {
            const key = `d:${d.id}`;
            if (processed.has(key)) continue;
            processed.add(key);
            const createdMs = (Number(d.createdAt) || 0) * 1000;
            if (createdMs < since) continue;
            const amount = Number(d.amount);
            log.log(`[BY] Донат ${amount} RUB от ${(d.user && d.user.name) || 'Anon'}`);
            credit(amount, {kind: 'donation', id: String(d.id)});
        }
    }

    async function pollSubscriptions() {
        const nowSec = Math.floor(now() / 1000);
        const fromSec = Math.max(Math.floor(since / 1000), lastEventSec - EVENTS_OVERLAP_SECONDS);
        const json = await apiGet(`/v1/blog/stat/${encodeURIComponent(creds.blog)}/events`, {
            from: String(fromSec),
            to: String(nowSec),
            event_types: SUBSCRIPTION_EVENTS.join(','),
            limit: '100'
        });
        const list = Array.isArray(json && json.data) ? json.data : null;
        if (!list) {
            warnOnce('events-shape', '[BY] Неожиданный ответ списка событий:', JSON.stringify(json).slice(0, 300));
            return;
        }
        const events = list
            .filter((e) => e && SUBSCRIPTION_EVENTS.includes(e.eventType))
            .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

        if (events.some((e) => e.levelId !== undefined && !levels.has(Number(e.levelId)))) await loadLevels(true);

        for (const e of events) {
            const createdSec = Number(e.createdAt) || 0;
            const userId = e.user && e.user.id !== undefined ? e.user.id : '';
            const key = `e:${e.eventType}:${createdSec}:${userId}:${e.levelId === undefined ? '' : e.levelId}`;
            if (createdSec > lastEventSec) lastEventSec = createdSec;
            if (processed.has(key)) continue;
            processed.add(key);
            if (createdSec * 1000 < since) continue;

            const {level, amount} = subscriptionAmount(e);
            const kind = e.eventType === 'recurrent' ? 'renewal' : 'subscription';
            log.log(`[BY] ${kind === 'renewal' ? 'Продление' : 'Подписка'} «${(level && level.name) || e.levelId || '?'}» — ${amount} RUB`);
            credit(amount, {kind, levelId: e.levelId, levelName: level ? level.name : ''});
        }
    }

    function schedule(gen, delay) {
        if (gen !== generation || stopped) return;
        pollTimer = timers.setTimeout(() => {
            pollTimer = null;
            poll(gen);
        }, delay);
    }

    async function poll(gen) {
        if (gen !== generation || stopped || authFailed) return;
        try {
            await loadLevels();
            await pollDonations();
            await pollSubscriptions();
            persist();
            if (gen !== generation) return;
            if (status.current !== 'connected') log.log('[BY] Успешное подключение к Boosty');
            status.set('connected');
            backoff.reset();
            schedule(gen, POLL_INTERVAL);
        } catch (e) {
            persist();
            if (gen !== generation) return;
            if (e.auth) {
                log.error('[BY] Токен не принят, опрос остановлен:', e.message);
                authFailed = true;
                status.set('error');
                onAuthInvalid();
                return;
            }
            log.warn('[BY] Ошибка опроса:', e.message);
            status.set('error');
            const retryMs = Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter * 1000 : 0;
            backoff.schedule(() => poll(gen), Math.max(retryMs, 0));
        }
    }

    function begin() {
        generation++;
        backoff.cancel();
        backoff.reset();
        if (pollTimer) {
            timers.clearTimeout(pollTimer);
            pollTimer = null;
        }
        authFailed = false;
        levels = new Map();
        levelsLoadedAt = 0;
        creds = deserializeCredentials(getCredentials());
        if (!creds) {
            status.set('disconnected');
            return;
        }
        if (status.current !== 'error') status.set('disconnected');
        poll(generation);
    }

    function start() {
        loadState();
        stopped = false;
        begin();
    }

    function restart() {
        loadState();
        status.reset();
        stopped = false;
        begin();
    }

    function stop() {
        stopped = true;
        generation++;
        backoff.cancel();
        if (pollTimer) {
            timers.clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    const snippet = (json) => {
        try {
            return JSON.stringify(json).slice(0, 300);
        } catch {
            return String(json).slice(0, 300);
        }
    };

    async function inspect() {
        if (!creds) creds = deserializeCredentials(getCredentials());
        if (!creds) return {ok: false, error: 'Сначала подключите Boosty.'};

        const warnings = [];
        try {
            await loadLevels(true);

            const donationsJson = await apiGet(blogPath('/sales/donation/'), {limit: '20', sort_by: 'time', order: 'gt'});
            const donations = extractDonations(donationsJson);
            if (!donations) warnings.push(`Список донатов: неожиданный ответ ${snippet(donationsJson)}`);
            const lastDonation = (donations || [])
                .filter((d) => d && d.id !== undefined)
                .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] || null;

            let lastEvent = null;
            const nowSec = Math.floor(now() / 1000);
            for (const days of INSPECT_WINDOWS_DAYS) {
                const eventsJson = await apiGet(`/v1/blog/stat/${encodeURIComponent(creds.blog)}/events`, {
                    from: String(nowSec - days * 86400),
                    to: String(nowSec),
                    event_types: SUBSCRIPTION_EVENTS.join(','),
                    limit: '100'
                });
                if (!Array.isArray(eventsJson && eventsJson.data)) {
                    warnings.push(`Список событий: неожиданный ответ ${snippet(eventsJson)}`);
                    break;
                }
                const events = eventsJson.data
                    .filter((e) => e && SUBSCRIPTION_EVENTS.includes(e.eventType))
                    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
                if (events.length) {
                    lastEvent = events[0];
                    break;
                }
            }

            if (lastEvent && lastEvent.levelId !== undefined && !levels.has(Number(lastEvent.levelId))) await loadLevels(true);

            let lastSubscription = null;
            if (lastEvent) {
                const {level, amount} = subscriptionAmount(lastEvent);
                lastSubscription = {
                    kind: lastEvent.eventType === 'recurrent' ? 'renewal' : 'subscription',
                    levelName: level ? level.name : '',
                    levelId: lastEvent.levelId,
                    amount,
                    createdAt: Number(lastEvent.createdAt) || 0
                };
            }

            return {
                ok: true,
                blog: creds.blog,
                levels: Array.from(levels.values()).map((l) => ({name: l.name, price: l.price})),
                lastDonation: lastDonation ? {
                    amount: Number(lastDonation.amount) || 0,
                    name: (lastDonation.user && lastDonation.user.name) || '',
                    createdAt: Number(lastDonation.createdAt) || 0
                } : null,
                lastSubscription,
                warnings
            };
        } catch (e) {
            return {
                ok: false,
                error: e.auth
                    ? 'Boosty не принял токен. Нажмите «Запросить токен» и войдите заново.'
                    : `Не удалось получить данные Boosty: ${e.message}`
            };
        }
    }

    return {start, restart, stop, inspect, getStatus: () => status.current};
}

module.exports = {createBoosty};
