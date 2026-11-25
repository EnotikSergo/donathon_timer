const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createClock} = require('./helpers/fake_env');
const {createSettingsStore} = require('../core/settings_store');
const {createTimerCore, formatRemaining, formatStopwatch} = require('../core/timer_core');

const THREE_DAYS = 3 * 24 * 3600;

function startCore({timerFile = null, stopwatchFile = null, settings = {}} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
    const store = createSettingsStore({path: path.join(dir, 'settings.json')});
    store.update(settings);
    const clock = createClock();
    const files = {timer: timerFile, stopwatch: stopwatchFile};
    const states = [];
    const events = [];
    const goalChanges = [];
    const core = createTimerCore({
        settings: store,
        storage: {
            loadTimer: () => files.timer,
            saveTimer: (v) => {
                files.timer = v;
            },
            removeTimer: () => {
                files.timer = null;
            },
            loadStopwatch: () => files.stopwatch,
            saveStopwatch: (v) => {
                files.stopwatch = String(v);
            },
            removeStopwatch: () => {
                files.stopwatch = null;
            }
        },
        onState: (s) => states.push(s),
        onEvent: (e) => events.push(e),
        onGoalChange: (active) => goalChanges.push(active),
        timers: {
            setTimeout: clock.globals.setTimeout,
            clearTimeout: clock.globals.clearTimeout,
            setInterval: clock.globals.setInterval,
            clearInterval: clock.globals.clearInterval
        },
        now: () => clock.now(),
        random: () => 0,
        log: {log() {}, warn() {}, error() {}}
    });
    core.start();
    const t = {
        core, store, clock, files, states, events, goalChanges,
        text: () => core.getSnapshot().remaining,
        remainingMs: () => core.debug().remainingMs,
        advance: async (ms) => {
            await clock.advance(ms);
            return t.text();
        },
        cleanup: () => {
            core.stop();
            fs.rmSync(dir, {recursive: true, force: true});
        }
    };
    return t;
}

test('формат секундомера', () => {
    assert.equal(formatStopwatch(0), 'прошло 0 д 0 ч 0 м 0 с');
    assert.equal(formatStopwatch(90061), 'прошло 1 д 1 ч 1 м 1 с');
    assert.equal(formatStopwatch(THREE_DAYS + 59), 'прошло 3 д 0 ч 0 м 59 с');
});

test('формат оставшегося времени', () => {
    assert.equal(formatRemaining(0), '00:00:00');
    assert.equal(formatRemaining(-5000), '00:00:00');
    assert.equal(formatRemaining(5 * 3600 * 1000), '05:00:00');
    assert.equal(formatRemaining((12 * 3600 + 34 * 60 + 56) * 1000 + 999), '12:34:56');
    assert.equal(formatRemaining(100 * 3600 * 1000), '100:00:00');
});

test('старт: 5 часов на паузе, без сохранения', async () => {
    const t = startCore();
    assert.equal(t.text(), '05:00:00');
    assert.equal(await t.advance(10000), '05:00:00');
    assert.equal(t.core.getSnapshot().isPause, true);
    t.cleanup();
});

test('старт: время из файла сохранения', () => {
    const t = startCore({timerFile: '03:15:20'});
    assert.equal(t.text(), '03:15:20');
    t.cleanup();
});

test('пауза и отсчёт', async () => {
    const t = startCore();
    t.core.command('togglePause');
    assert.equal(await t.advance(10000), '04:59:50');
    t.core.command('togglePause');
    assert.equal(await t.advance(60000), '04:59:50');
    t.cleanup();
});

test('команды: ±минута, ±час, сброс', () => {
    const t = startCore();
    t.core.command('addSmall');
    assert.equal(t.text(), '05:01:00');
    t.core.command('addLarge');
    assert.equal(t.text(), '06:01:00');
    t.core.command('subtractSmall');
    assert.equal(t.text(), '06:00:00');
    t.core.command('subtractLarge');
    assert.equal(t.text(), '05:00:00');
    t.core.command('addLarge');
    t.core.command('reset');
    assert.equal(t.text(), '05:00:00');
    assert.equal(t.core.command('unknown'), false);
    t.cleanup();
});

test('сброс возвращает базовую цену из настроек и обнуляет тир', () => {
    const t = startCore({settings: {baseRubPerHour: 1200, dynamicPriceIncreaseEnabled: true}});
    t.core.addTime(THREE_DAYS * 2);
    assert.equal(t.core.getRublesPerHour(), 1200 + 2 * 500);
    t.core.command('reset');
    assert.equal(t.store.get().maxTimerTier, 0);
    assert.equal(t.core.getRublesPerHour(), 1200);
    t.cleanup();
});

test('донат без сбора: 100 ₽ при 1000 ₽/ч = 6 минут', () => {
    const t = startCore();
    const before = t.remainingMs();
    t.core.addDonation(100);
    assert.equal(t.remainingMs() - before, 360000);
    assert.deepEqual(t.events.at(-1), {type: 'addTime', seconds: 360});
    t.cleanup();
});

test('донат учитывает текущую цену', () => {
    const t = startCore({settings: {baseRubPerHour: 2000}});
    const before = t.remainingMs();
    t.core.addDonation(100);
    assert.equal(t.remainingMs() - before, 180000);
    assert.equal(t.core.getSnapshot().priceText, '100р = 3 минуты');
    t.cleanup();
});

test('сбор: частичное заполнение не добавляет время', () => {
    const t = startCore();
    t.core.activateGoal(1);
    const before = t.remainingMs();
    t.core.addDonation(300);
    assert.equal(t.remainingMs(), before);
    const s = t.core.getSnapshot();
    assert.equal(s.goalText, 'Сбор: 300 / 1000 руб. (1ч)');
    assert.equal(s.goalPercentage, 30);
    assert.equal(s.isGoalActive, true);
    t.cleanup();
});

test('сбор: точное заполнение добавляет часы цели и закрывает сбор', () => {
    const t = startCore();
    t.core.activateGoal(2);
    const before = t.remainingMs();
    t.core.addDonation(1500);
    t.core.addDonation(500);
    assert.equal(t.remainingMs() - before, 2 * 3600 * 1000);
    assert.equal(t.core.getSnapshot().isGoalActive, false);
    assert.deepEqual(t.goalChanges, [true, false]);
    assert.ok(t.events.some((e) => e.type === 'goalSuccess'));
    t.cleanup();
});

test('сбор: излишек сверх цели уходит во время по текущей цене', () => {
    const t = startCore();
    t.core.activateGoal(1);
    t.core.addDonation(300);
    const before = t.remainingMs();
    t.core.addDonation(800);
    assert.equal(t.remainingMs() - before, 3600 * 1000 + 100 * 3600);
    assert.equal(t.core.getSnapshot().isGoalActive, false);
    t.cleanup();
});

test('сбор: смена цены во время сбора пересчитывает цель', () => {
    const t = startCore();
    t.core.activateGoal(1);
    t.store.update({baseRubPerHour: 1500});
    assert.equal(t.core.debug().goal.target, 1500);
    t.cleanup();
});

test('сбор: отмена закрывает сбор без добавления времени', () => {
    const t = startCore();
    t.core.activateGoal(1);
    t.core.addDonation(300);
    const before = t.remainingMs();
    t.core.deactivateGoal();
    assert.equal(t.core.getSnapshot().isGoalActive, false);
    t.core.addDonation(100);
    assert.equal(t.remainingMs() - before, 360000);
    t.cleanup();
});

test('тиры: при выключенном автоповышении цена не меняется', () => {
    const t = startCore();
    t.core.addTime(THREE_DAYS * 2);
    assert.equal(t.core.getRublesPerHour(), 1000);
    t.cleanup();
});

test('тиры: остаток таймера больше 6 дней → цена база + 2 шага', () => {
    const t = startCore({settings: {dynamicPriceIncreaseEnabled: true}});
    t.core.addTime(THREE_DAYS * 2);
    assert.equal(t.store.get().maxTimerTier, 2);
    assert.equal(t.core.getRublesPerHour(), 2000);
    t.core.addTime(-THREE_DAYS * 2);
    assert.equal(t.core.getRublesPerHour(), 2000);
    t.cleanup();
});

test('тиры: секундомер дольше 3 дней поднимает цену на шаг', () => {
    const t = startCore({stopwatchFile: String(THREE_DAYS + 10), settings: {dynamicPriceIncreaseEnabled: true}});
    assert.equal(t.core.getRublesPerHour(), 1500);
    t.cleanup();
});

test('секундомер считает только во время отсчёта с донат-режимом', async () => {
    const t = startCore({stopwatchFile: '100'});
    await t.advance(5000);
    assert.equal(t.core.debug().elapsedSeconds, 100);
    t.core.command('togglePause');
    await t.advance(5000);
    assert.equal(t.core.debug().elapsedSeconds, 105);
    assert.equal(t.files.stopwatch, '105');
    t.store.update({donationModeEnabled: false});
    await t.advance(5000);
    assert.equal(t.core.debug().elapsedSeconds, 105);
    t.cleanup();
});

test('режим сна: таймер идёт в 2 раза медленнее', async () => {
    const t = startCore();
    t.core.command('togglePause');
    t.store.update({sleepModeEnabled: true});
    assert.equal(await t.advance(20000), '04:59:50');
    t.store.update({sleepModeEnabled: false});
    assert.equal(await t.advance(10000), '04:59:40');
    assert.equal(t.core.getSnapshot().sleepModeEnabled, false);
    t.cleanup();
});

test('режим сна, включённый до запуска, сразу замедляет таймер', async () => {
    const t = startCore({settings: {sleepModeEnabled: true}});
    t.core.command('togglePause');
    assert.equal(await t.advance(20000), '04:59:50');
    t.cleanup();
});

test('сохранение: раз в 5 секунд и сразу при паузе', async () => {
    const t = startCore();
    t.core.command('togglePause');
    await t.advance(3000);
    assert.equal(t.files.timer, null);
    await t.advance(2000);
    assert.equal(t.files.timer, '04:59:55');
    await t.advance(1500);
    t.core.command('togglePause');
    assert.equal(t.files.timer, '04:59:53');
    t.cleanup();
});

test('сохранение при выходе', async () => {
    const t = startCore();
    t.core.command('togglePause');
    await t.advance(2000);
    t.core.save();
    assert.equal(t.files.timer, '04:59:58');
    t.cleanup();
});

test('конец отсчёта: 00:00:00, тир сброшен, сохранения удалены, время больше не добавляется', async () => {
    const t = startCore({timerFile: '00:00:05', stopwatchFile: '50', settings: {maxTimerTier: 1}});
    t.core.command('togglePause');
    t.core.activateGoal(1);
    assert.equal(await t.advance(6000), '00:00:00');
    const snap = t.core.getSnapshot();
    assert.equal(snap.ended, true);
    assert.equal(snap.isGoalActive, false);
    assert.deepEqual(t.goalChanges, [true, false]);
    assert.equal(t.store.get().maxTimerTier, 0);
    assert.equal(t.files.timer, null);
    assert.equal(t.files.stopwatch, null);
    const eventsBefore = t.events.length;
    t.core.addDonation(1000);
    assert.equal(t.core.addTime(60), false);
    t.core.command('addSmall');
    assert.equal(t.events.length, eventsBefore);
    assert.equal(await t.advance(1000), '00:00:00');
    t.core.save();
    assert.equal(t.files.timer, null);
    t.core.command('reset');
    assert.equal(t.text(), '05:00:00');
    assert.equal(t.core.getSnapshot().ended, false);
    t.cleanup();
});

test('секундомер: виден на паузе, скрыт при отсчёте, показывается на 15 с раз в 30–60 минут', async () => {
    const t = startCore();
    assert.equal(t.core.getSnapshot().showStopwatch, true);
    t.core.command('togglePause');
    assert.equal(t.core.getSnapshot().showStopwatch, false);
    await t.advance(30 * 60 * 1000);
    assert.equal(t.core.getSnapshot().showStopwatch, true);
    await t.advance(15000);
    assert.equal(t.core.getSnapshot().showStopwatch, false);
    t.store.update({donationModeEnabled: false});
    t.core.command('togglePause');
    assert.equal(t.core.getSnapshot().showStopwatch, false);
    t.cleanup();
});

test('состояние: все поля и отправка только при изменениях', async () => {
    const t = startCore({settings: {rubLabel: {left: '10px', top: '20px', fontSize: 2}}});
    t.core.activateGoal(1);
    t.core.addDonation(250);
    const s = t.core.getSnapshot();
    assert.equal(s.remaining, '05:00:00');
    assert.equal(s.rublesPerHour, 1000);
    assert.equal(s.priceText, '50р = 3 минуты');
    assert.equal(s.showRubPerHour, true);
    assert.equal(s.isGoalActive, true);
    assert.equal(s.goalText, 'Сбор: 250 / 1000 руб. (1ч)');
    assert.equal(s.goalPercentage, 25);
    assert.equal(s.isPause, true);
    assert.equal(s.sleepModeEnabled, false);
    assert.equal(s.stopwatchText, 'прошло 0 д 0 ч 0 м 0 с');
    assert.deepEqual(s.rubLabel, {left: '10px', top: '20px', fontSize: 2});

    const count = t.states.length;
    await t.advance(60000);
    assert.equal(t.states.length, count);
    t.core.command('togglePause');
    await t.advance(1000);
    assert.ok(t.states.length >= count + 2);
    t.cleanup();
});
