const C = require('../constants');
const {computeRubPerHour} = require('./settings_store');
const {defaultTimers} = require('./donations/service_utils');

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function parseRemaining(text) {
    const parts = String(text || '').trim().split(':');
    if (parts.length !== 3) return null;
    const [h, m, s] = parts.map((p) => parseInt(p, 10));
    if ([h, m, s].some((n) => !Number.isFinite(n) || n < 0)) return null;
    return ((h * 60 + m) * 60 + s) * 1000;
}

function formatStopwatch(totalSeconds) {
    const d = Math.floor(totalSeconds / (3600 * 24));
    const h = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `прошло ${d} д ${h} ч ${m} м ${s} с`;
}

function formatPrice(rublesPerHour) {
    const minutes = C.PRICE_DISPLAY_MINUTES;
    return `${Math.round(rublesPerHour * minutes / 60)}р = ${minutes} минуты`;
}

function createTimerCore(deps) {
    const {
        settings: settingsStore,
        storage,
        onState = () => {},
        onEvent = () => {},
        onGoalChange = () => {},
        timers = defaultTimers,
        now = () => Date.now(),
        random = Math.random,
        log = console
    } = deps;

    const TIER_MS = C.PRICE_TIER_SECONDS * 1000;

    let settings = settingsStore.get();

    let remainingBase = C.INITIAL_TIMER_SECONDS * 1000;
    let isPause = true;
    let ended = false;
    let speed = settings.sleepModeEnabled ? C.SLEEP_MODE_SPEED : 1;
    let since = now();

    let stopwatchBase = 0;
    let stopwatchSince = now();
    let stopwatchTier = 0;

    let showStopwatchState = true;
    let stopwatchShowTimer = null;
    let stopwatchHideTimer = null;

    const goal = {active: false, hours: 0, target: 0, current: 0};

    let rublesPerHour = 0;
    let tickTimer = null;
    let lastSnapshotJson = '';
    let lastSavedTimer = null;
    let lastSavedStopwatch = null;
    let lastSaveAt = 0;

    const running = () => !isPause && !ended;
    const stopwatchCounting = () => running() && !!settings.donationModeEnabled;

    function remainingAt(t) {
        return remainingBase - (running() ? (t - since) * speed : 0);
    }

    function stopwatchMsAt(t) {
        return stopwatchBase + (stopwatchCounting() ? t - stopwatchSince : 0);
    }

    function rebase() {
        const t = now();
        remainingBase = remainingAt(t);
        stopwatchBase = stopwatchMsAt(t);
        since = t;
        stopwatchSince = t;
    }

    const elapsedSeconds = () => Math.floor(stopwatchMsAt(now()) / 1000);
    const secondsPerRub = () => 3600 / rublesPerHour;

    function goalText() {
        if (!goal.active) return 'Сбор: 0 / 0 руб';
        return `Сбор: ${Math.round(goal.current)} / ${Math.round(goal.target)} руб. (${goal.hours}ч)`;
    }

    function goalPercentage() {
        if (!goal.active || !(goal.target > 0)) return 0;
        return Math.min((goal.current / goal.target) * 100, 100);
    }

    function snapshot() {
        const showStopwatch = ended ? !!settings.donationModeEnabled : (showStopwatchState && !!settings.donationModeEnabled);
        return {
            remaining: formatRemaining(ended ? 0 : remainingAt(now())),
            isPause,
            ended,
            sleepModeEnabled: !!settings.sleepModeEnabled,
            showStopwatch,
            stopwatchText: formatStopwatch(elapsedSeconds()),
            showRubPerHour: !!settings.showRubPerHour,
            rublesPerHour,
            priceText: formatPrice(rublesPerHour),
            isGoalActive: goal.active,
            goalText: goalText(),
            goalPercentage: goalPercentage(),
            rubLabel: settings.rubLabel || null
        };
    }

    function publish(force = false) {
        const snap = snapshot();
        const json = JSON.stringify(snap);
        if (!force && json === lastSnapshotJson) return;
        lastSnapshotJson = json;
        try {
            onState(snap);
        } catch (e) {
            log.error('[timer] Не удалось отправить состояние:', e);
        }
    }

    function emit(event) {
        try {
            onEvent(event);
        } catch (e) {
            log.error('[timer] Не удалось отправить событие:', e);
        }
    }

    function recomputePrice() {
        const tier = Math.max(Number(settings.maxTimerTier) || 0, stopwatchTier);
        const next = computeRubPerHour(settings, tier);
        if (next === rublesPerHour) return;
        rublesPerHour = next;
        if (goal.active) goal.target = goal.hours * rublesPerHour;
    }

    function setMaxTimerTier(tier) {
        if ((Number(settings.maxTimerTier) || 0) === tier) return;
        settingsStore.update({maxTimerTier: tier});
    }

    function checkTiers() {
        const remaining = remainingAt(now());
        if (!ended && remaining > 0) {
            const timerTier = Math.floor(remaining / TIER_MS);
            if (timerTier > (Number(settings.maxTimerTier) || 0)) setMaxTimerTier(timerTier);
        }
        const swTier = Math.floor(elapsedSeconds() / C.PRICE_TIER_SECONDS);
        if (swTier > stopwatchTier) {
            stopwatchTier = swTier;
            recomputePrice();
        }
    }

    function clearStopwatchSchedule() {
        if (stopwatchShowTimer) timers.clearTimeout(stopwatchShowTimer);
        if (stopwatchHideTimer) timers.clearTimeout(stopwatchHideTimer);
        stopwatchShowTimer = null;
        stopwatchHideTimer = null;
    }

    function scheduleStopwatchVisibility() {
        clearStopwatchSchedule();
        if (ended) return;
        const delay = C.STOPWATCH_SHOW_MIN_MS + Math.floor(random() * (C.STOPWATCH_SHOW_MAX_MS - C.STOPWATCH_SHOW_MIN_MS));
        stopwatchShowTimer = timers.setTimeout(() => {
            stopwatchShowTimer = null;
            if (ended) return;
            showStopwatchState = true;
            publish();
            stopwatchHideTimer = timers.setTimeout(() => {
                stopwatchHideTimer = null;
                if (ended) return;
                showStopwatchState = false;
                publish();
                scheduleStopwatchVisibility();
            }, C.STOPWATCH_SHOW_DURATION_MS);
        }, delay);
    }

    function closeGoal() {
        if (!goal.active) return;
        goal.active = false;
        try {
            onGoalChange(false);
        } catch (e) {
            log.error('[timer] Не удалось сообщить о сборе:', e);
        }
    }

    function addTime(seconds) {
        if (!Number.isFinite(seconds) || seconds === 0) return false;
        if (ended && !C.CAN_INCREASE_TIME_AFTER_STOP) return false;
        rebase();
        remainingBase += seconds * 1000;
        emit({type: 'addTime', seconds});
        checkTiers();
        tick();
        return true;
    }

    function saveTimerFiles(force = false) {
        if (!storage) return;
        try {
            if (ended) return;
            const remaining = remainingAt(now());
            const text = remaining > 0 ? formatRemaining(remaining) : null;
            if (text && (force || text !== lastSavedTimer)) {
                storage.saveTimer(text);
                lastSavedTimer = text;
            }
            const sw = elapsedSeconds();
            if (force || sw !== lastSavedStopwatch) {
                storage.saveStopwatch(sw);
                lastSavedStopwatch = sw;
            }
        } catch (e) {
            log.error('[timer] Не удалось сохранить таймер:', e);
        }
    }

    function finishCountdown() {
        rebase();
        if (C.CAN_INCREASE_TIME_AFTER_STOP) {
            remainingBase = 0;
            return;
        }
        ended = true;
        remainingBase = 0;
        rebase();
        clearStopwatchSchedule();
        closeGoal();
        setMaxTimerTier(0);
        if (storage) {
            try {
                storage.removeTimer();
                storage.removeStopwatch();
            } catch (e) {
                log.error('[timer] Не удалось удалить сохранения:', e);
            }
        }
        lastSavedTimer = null;
        lastSavedStopwatch = null;
    }

    function tick() {
        const t = now();
        if (!ended && remainingAt(t) <= 0) finishCountdown();
        checkTiers();
        if (running() && t - lastSaveAt >= C.TIMER_SAVE_INTERVAL_MS) {
            lastSaveAt = t;
            saveTimerFiles();
        }
        publish();
    }

    function togglePause() {
        rebase();
        isPause = !isPause;
        if (isPause) {
            clearStopwatchSchedule();
            showStopwatchState = true;
            saveTimerFiles(true);
        } else {
            showStopwatchState = false;
            scheduleStopwatchVisibility();
            lastSaveAt = now();
        }
        tick();
    }

    function reset() {
        rebase();
        remainingBase = C.INITIAL_TIMER_SECONDS * 1000;
        ended = false;
        stopwatchBase = 0;
        stopwatchTier = 0;
        showStopwatchState = false;
        setMaxTimerTier(0);
        recomputePrice();
        if (isPause) clearStopwatchSchedule();
        else scheduleStopwatchVisibility();
        saveTimerFiles(true);
        tick();
    }

    function command(name) {
        switch (name) {
            case 'addSmall':
                return addTime(C.TIME_STEP_SMALL_SECONDS);
            case 'addLarge':
                return addTime(C.TIME_STEP_LARGE_SECONDS);
            case 'subtractSmall':
                return addTime(-C.TIME_STEP_SMALL_SECONDS);
            case 'subtractLarge':
                return addTime(-C.TIME_STEP_LARGE_SECONDS);
            case 'togglePause':
                return togglePause();
            case 'reset':
                return reset();
            default:
                return false;
        }
    }

    function addDonation(rubles) {
        const amount = Number(rubles);
        if (!(amount > 0)) return;

        if (!goal.active) {
            addTime(amount * secondsPerRub());
            return;
        }

        const remainingToFill = goal.target - goal.current;
        if (amount <= remainingToFill) {
            goal.current += amount;
            if (goal.current >= goal.target) succeedGoal();
            else publish();
            return;
        }

        const excess = amount - remainingToFill;
        goal.current = goal.target;
        succeedGoal();
        addTime(excess * secondsPerRub());
    }

    function succeedGoal() {
        emit({type: 'goalSuccess'});
        const hours = goal.hours;
        closeGoal();
        if (!addTime(hours * 3600)) publish();
    }

    function activateGoal(hours) {
        const h = Number(hours);
        if (!(h > 0)) return false;
        goal.active = true;
        goal.hours = h;
        goal.target = h * rublesPerHour;
        goal.current = 0;
        try {
            onGoalChange(true);
        } catch (e) {
            log.error('[timer] Не удалось сообщить о сборе:', e);
        }
        publish();
        return true;
    }

    function deactivateGoal() {
        closeGoal();
        publish();
    }

    function onSettingsChange(next, changed) {
        const timingKeys = ['sleepModeEnabled', 'donationModeEnabled'];
        if (changed.some((k) => timingKeys.includes(k))) rebase();
        settings = next;
        speed = settings.sleepModeEnabled ? C.SLEEP_MODE_SPEED : 1;
        recomputePrice();
        publish();
    }

    function restore() {
        try {
            const savedTimer = storage ? parseRemaining(storage.loadTimer()) : null;
            if (savedTimer !== null) remainingBase = savedTimer;
        } catch (e) {
            log.error('[timer] Ошибка чтения файла таймера:', e);
        }
        try {
            const sw = storage ? parseInt(String(storage.loadStopwatch() || '').trim(), 10) : NaN;
            if (Number.isFinite(sw) && sw > 0) {
                stopwatchBase = sw * 1000;
                stopwatchTier = Math.floor(sw / C.PRICE_TIER_SECONDS);
            }
        } catch (e) {
            log.error('[timer] Ошибка чтения файла секундомера:', e);
        }
        since = now();
        stopwatchSince = since;
        lastSavedTimer = formatRemaining(remainingBase);
        lastSavedStopwatch = Math.floor(stopwatchBase / 1000);
    }

    const unsubscribe = settingsStore.onChange(onSettingsChange);

    restore();
    recomputePrice();

    function start() {
        if (tickTimer) return;
        tick();
        tickTimer = timers.setInterval(tick, C.TIMER_TICK_MS);
    }

    function stop() {
        if (tickTimer) timers.clearInterval(tickTimer);
        tickTimer = null;
        clearStopwatchSchedule();
        saveTimerFiles(true);
        unsubscribe();
    }

    return {
        start,
        stop,
        save: () => saveTimerFiles(true),
        command,
        addTime,
        addDonation,
        activateGoal,
        deactivateGoal,
        getSnapshot: snapshot,
        getRublesPerHour: () => rublesPerHour,
        debug: () => ({
            remainingMs: remainingAt(now()),
            elapsedSeconds: elapsedSeconds(),
            goal: {...goal},
            ended,
            isPause,
            stopwatchTier
        })
    };
}

module.exports = {createTimerCore, formatRemaining, formatStopwatch};
