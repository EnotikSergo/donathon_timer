const {writeFileAtomic, readTextFile} = require('./storage');
const {DEFAULT_RUB_PER_HOUR} = require('../constants');

const DEFAULT_SETTINGS = Object.freeze({
    donationModeEnabled: true,
    sleepModeEnabled: false,
    showRubPerHour: true,
    dynamicPriceIncreaseEnabled: false,
    maxTimerTier: 0,
    baseRubPerHour: DEFAULT_RUB_PER_HOUR,
    dynamicPriceStep: 500,
    rubLabel: null
});

const PERSISTED_KEYS = Object.keys(DEFAULT_SETTINGS);

function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function computeRubPerHour(settings, tier) {
    const base = positiveNumber(settings.baseRubPerHour, DEFAULT_RUB_PER_HOUR);
    if (!settings.dynamicPriceIncreaseEnabled) return base;
    const step = positiveNumber(settings.dynamicPriceStep, DEFAULT_RUB_PER_HOUR);
    const t = Math.max(0, Math.floor(Number(tier) || 0));
    return base + t * step;
}

function sanitizeRubLabel(value) {
    if (!value || typeof value !== 'object') return null;
    const px = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?px$/.test(v) ? v : null);
    const fontSize = Number(value.fontSize);
    const label = {
        left: px(value.left),
        top: px(value.top),
        fontSize: Number.isFinite(fontSize) && fontSize >= 0.5 && fontSize <= 20 ? fontSize : null
    };
    return label.left || label.top || label.fontSize ? label : null;
}

function sanitize(partial) {
    const out = {};
    for (const key of PERSISTED_KEYS) {
        if (!(key in partial)) continue;
        const value = partial[key];
        switch (key) {
            case 'baseRubPerHour':
            case 'dynamicPriceStep': {
                const n = Number(value);
                if (Number.isFinite(n) && n > 0) out[key] = n;
                break;
            }
            case 'maxTimerTier': {
                const n = Math.floor(Number(value));
                if (Number.isFinite(n) && n >= 0) out[key] = n;
                break;
            }
            case 'rubLabel':
                out[key] = sanitizeRubLabel(value);
                break;
            default:
                out[key] = !!value;
        }
    }
    return out;
}

function createSettingsStore({path: settingsPath, saveDelayMs = 300}) {
    let settings = {...DEFAULT_SETTINGS};
    const listeners = new Set();
    let saveTimer = null;

    try {
        const raw = readTextFile(settingsPath);
        if (raw !== null) settings = {...settings, ...sanitize(JSON.parse(raw) || {})};
    } catch (e) {
        console.error('Не удалось прочесть файл настроек:', e);
    }

    function flush() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        const data = {};
        for (const key of PERSISTED_KEYS) data[key] = settings[key];
        try {
            writeFileAtomic(settingsPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('Не удалось сохранить настройки:', e);
        }
    }

    function get() {
        return {...settings};
    }

    function update(partial) {
        const clean = sanitize(partial || {});
        const changed = Object.keys(clean).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(clean[k]));
        if (!changed.length) return [];
        settings = {...settings, ...clean};
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, saveDelayMs);
        if (typeof saveTimer.unref === 'function') saveTimer.unref();
        for (const fn of listeners) fn(get(), changed);
        return changed;
    }

    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    return {get, update, onChange, flush};
}

module.exports = {createSettingsStore, computeRubPerHour, DEFAULT_SETTINGS};
