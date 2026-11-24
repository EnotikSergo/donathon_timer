const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createBrowserEnv} = require('./helpers/fake_env');

const THREE_DAYS = 3 * 24 * 3600;

const BASE_SETTINGS = {
    donationModeEnabled: true,
    sleepModeEnabled: false,
    secondsAddedPerCurrency: 3.6,
    showRubPerHour: true,
    dynamicPriceIncreaseEnabled: false,
    maxTimerTier: 0,
    baseRubPerHour: 1000,
    dynamicPriceStep: 500
};

function startTimer({timerFile, stopwatchFile, settings} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-test-'));
    const paths = {timer: path.join(dir, 'timer_value.txt'), stopwatch: path.join(dir, 'stopwatch_save.txt')};
    if (timerFile !== undefined) fs.writeFileSync(paths.timer, timerFile);
    if (stopwatchFile !== undefined) fs.writeFileSync(paths.stopwatch, stopwatchFile);

    const fullSettings = {...BASE_SETTINGS, ...settings};
    const env = createBrowserEnv({
        syncReplies: {
            'auth-tokens:get-sync': {},
            'storage:paths-sync': paths,
            'settings:get': fullSettings
        }
    });
    env.load('js/lib/generalFunc.js');
    env.load('js/lib/timeFunc.js');
    env.load('config.js');
    env.load('js/script.js');
    env.load('js/control_bridge.js');

    const t = {
        env,
        paths,
        async applySettings(s) {
            env.ipc.emit('settings:update', {...fullSettings, ...s});
            await env.clock.flush();
        },
        tick() {
            env.frame();
            return t.text();
        },
        text: () => env.document.getElementById('timeText').innerText,
        remainingMs: () => env.run('endingTime - (Date.now() - (pauseTime + sleepSlowOffsetMs))'),
        async advance(ms) {
            await env.clock.advance(ms);
            return t.tick();
        },
        async unpause() {
            env.key('Space');
            await env.clock.flush();
        },
        settingsSent: () => env.ipc.sentOn('settings:set'),
        cleanup: () => fs.rmSync(dir, {recursive: true, force: true})
    };
    return t;
}

async function started(opts) {
    const t = startTimer(opts);
    await t.env.clock.flush();
    await t.applySettings({});
    t.tick();
    return t;
}

test('формат секундомера', async () => {
    const t = await started();
    assert.equal(t.env.run('formatStopwatch(0)'), 'прошло 0 д 0 ч 0 м 0 с');
    assert.equal(t.env.run('formatStopwatch(90061)'), 'прошло 1 д 1 ч 1 м 1 с');
    assert.equal(t.env.run('formatStopwatch(3 * 24 * 3600 + 59)'), 'прошло 3 д 0 ч 0 м 59 с');
    t.cleanup();
});

test('формат оставшегося времени', async () => {
    const t = await started();
    const fmt = (ms) => t.env.run(`timeFunc.getHours(${ms}) + ':' + timeFunc.getMinutes(${ms}) + ':' + timeFunc.getSeconds(${ms})`);
    assert.equal(fmt(0), '00:00:00');
    assert.equal(fmt(5 * 3600 * 1000), '05:00:00');
    assert.equal(fmt((12 * 3600 + 34 * 60 + 56) * 1000 + 999), '12:34:56');
    assert.equal(fmt(100 * 3600 * 1000), '100:00:00');
    t.cleanup();
});

test('старт: 5 часов на паузе, без сохранения', async () => {
    const t = await started();
    assert.equal(t.text(), '05:00:00');
    assert.equal(await t.advance(10000), '05:00:00');
    assert.equal(t.env.run('isPause'), true);
    t.cleanup();
});

test('старт: время из файла сохранения', async () => {
    const t = await started({timerFile: '03:15:20'});
    assert.equal(t.text(), '03:15:20');
    t.cleanup();
});

test('пауза и отсчёт по пробелу', async () => {
    const t = await started();
    await t.unpause();
    assert.equal(await t.advance(10000), '04:59:50');
    t.env.key('Space');
    await t.env.clock.flush();
    assert.equal(await t.advance(60000), '04:59:50');
    t.cleanup();
});

test('хоткеи: ±минута, ±час, сброс', async () => {
    const t = await started();
    t.env.key('ArrowUp');
    assert.equal(t.tick(), '05:01:00');
    t.env.key('ArrowUp', {shiftKey: true});
    assert.equal(t.tick(), '06:01:00');
    t.env.key('ArrowDown');
    assert.equal(t.tick(), '06:00:00');
    t.env.key('ArrowDown', {shiftKey: true});
    assert.equal(t.tick(), '05:00:00');
    t.env.key('ArrowUp', {shiftKey: true});
    t.env.key('KeyR');
    assert.equal(t.tick(), '05:00:00');
    t.cleanup();
});

test('сброс по R ставит базовую цену из настроек', async () => {
    const t = await started({settings: {baseRubPerHour: 1200, secondsAddedPerCurrency: 3}});
    t.env.key('KeyR');
    const last = t.settingsSent().at(-1);
    assert.equal(last.maxTimerTier, 0);
    assert.equal(last.secondsAddedPerCurrency, 3);
    t.cleanup();
});

test('донат без сбора: 100 ₽ при 1000 ₽/ч = 6 минут', async () => {
    const t = await started();
    const before = t.remainingMs();
    t.env.run('handleDonationWithGoalSystem(100)');
    assert.equal(t.remainingMs() - before, 360000);
    assert.deepEqual(t.env.ipc.sentOn('overlay:event').at(-1), {type: 'addTime', seconds: 360});
    t.cleanup();
});

test('донат учитывает текущую цену', async () => {
    const t = await started();
    await t.applySettings({secondsAddedPerCurrency: 3600 / 2000});
    const before = t.remainingMs();
    t.env.run('handleDonationWithGoalSystem(100)');
    assert.equal(t.remainingMs() - before, 180000);
    assert.equal(t.env.document.getElementById('rubPerHourText').innerText, '100р = 3 минуты');
    t.cleanup();
});

test('сбор: частичное заполнение не добавляет время', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 1});
    const before = t.remainingMs();
    t.env.run('handleDonationWithGoalSystem(300)');
    assert.equal(t.remainingMs(), before);
    assert.equal(t.env.document.getElementById('goalText').innerText, 'Сбор: 300 / 1000 руб. (1ч)');
    assert.equal(t.env.document.getElementById('goalBarFill').style.width, '30%');
    t.cleanup();
});

test('сбор: точное заполнение добавляет часы цели и закрывает сбор', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 2});
    const before = t.remainingMs();
    t.env.run('handleDonationWithGoalSystem(1500)');
    t.env.run('handleDonationWithGoalSystem(500)');
    assert.equal(t.remainingMs() - before, 2 * 3600 * 1000);
    assert.equal(t.env.run('isGoalActive'), false);
    assert.equal(t.env.ipc.sentOn('goal:ended').length, 1);
    t.cleanup();
});

test('сбор: излишек сверх цели уходит во время по текущей цене', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 1});
    t.env.run('handleDonationWithGoalSystem(300)');
    const before = t.remainingMs();
    t.env.run('handleDonationWithGoalSystem(800)');
    assert.equal(t.remainingMs() - before, 3600 * 1000 + 100 * 3600);
    assert.equal(t.env.run('isGoalActive'), false);
    t.cleanup();
});

test('сбор: смена цены во время сбора пересчитывает цель', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 1});
    await t.applySettings({secondsAddedPerCurrency: 3600 / 1500});
    assert.equal(t.env.run('goalTargetAmount'), 1500);
    t.cleanup();
});

test('сбор: отмена закрывает сбор без добавления времени', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 1});
    t.env.run('handleDonationWithGoalSystem(300)');
    const before = t.remainingMs();
    t.env.ipc.emit('goal:deactivate');
    assert.equal(t.env.run('isGoalActive'), false);
    t.env.run('handleDonationWithGoalSystem(100)');
    assert.equal(t.remainingMs() - before, 360000);
    t.cleanup();
});

test('тиры: при выключенном автоповышении цена не меняется', async () => {
    const t = await started();
    t.env.key('ArrowUp', {shiftKey: true});
    t.env.run(`addTime(${THREE_DAYS * 2})`);
    t.tick();
    assert.equal(t.settingsSent().filter((s) => 'secondsAddedPerCurrency' in s && s.secondsAddedPerCurrency !== 3.6).length, 0);
    t.cleanup();
});

test('тиры: остаток таймера больше 6 дней → цена база + 2 шага', async () => {
    const t = await started({settings: {dynamicPriceIncreaseEnabled: true}});
    t.env.run(`addTime(${THREE_DAYS * 2})`);
    t.tick();
    const last = t.settingsSent().at(-1);
    assert.equal(last.maxTimerTier, 2);
    assert.equal(last.secondsAddedPerCurrency, 3600 / 2000);
    t.cleanup();
});

test('тиры: секундомер дольше 3 дней поднимает цену на шаг', async () => {
    const t = await started({stopwatchFile: String(THREE_DAYS + 10), settings: {dynamicPriceIncreaseEnabled: true}});
    const last = t.settingsSent().at(-1);
    assert.equal(last.secondsAddedPerCurrency, 3600 / 1500);
    t.cleanup();
});

test('тиры: секундомер считает только во время отсчёта с донат-режимом', async () => {
    const t = await started({stopwatchFile: '100'});
    await t.env.clock.advance(5000);
    assert.equal(t.env.run('elapsedSeconds'), 100);
    await t.unpause();
    await t.env.clock.advance(5000);
    assert.equal(t.env.run('elapsedSeconds'), 105);
    assert.equal(fs.readFileSync(t.paths.stopwatch, 'utf8'), '105');
    await t.applySettings({donationModeEnabled: false});
    await t.env.clock.advance(5000);
    assert.equal(t.env.run('elapsedSeconds'), 105);
    t.cleanup();
});

test('режим сна: таймер идёт в 2 раза медленнее', async () => {
    const t = await started();
    await t.unpause();
    await t.applySettings({sleepModeEnabled: true});
    t.tick();
    for (let i = 0; i < 20; i++) await t.advance(1000);
    assert.equal(t.text(), '04:59:50');
    await t.applySettings({sleepModeEnabled: false});
    t.tick();
    for (let i = 0; i < 10; i++) await t.advance(1000);
    assert.equal(t.text(), '04:59:40');
    t.cleanup();
});

test('сохранение оставшегося времени в файл', async () => {
    const t = await started();
    await t.unpause();
    await t.advance(3000);
    assert.equal(fs.readFileSync(t.paths.timer, 'utf8'), '04:59:57');
    t.cleanup();
});

test('конец отсчёта: 00:00:00, тир сброшен, время больше не добавляется', async () => {
    const t = await started({timerFile: '00:00:05'});
    await t.unpause();
    t.env.ipc.emit('goal:activate', {hours: 1});
    await t.advance(6000);
    assert.equal(t.text(), '00:00:00');
    assert.equal(t.env.run('countdownEnded'), true);
    assert.equal(t.env.run('isGoalActive'), false);
    assert.deepEqual(t.settingsSent().at(-1), {maxTimerTier: 0});
    assert.equal(fs.existsSync(t.paths.timer), false);
    t.env.run('handleDonationWithGoalSystem(1000)');
    t.env.key('ArrowUp');
    assert.equal(t.tick(), '00:00:00');
    t.cleanup();
});

test('состояние для оверлея', async () => {
    const t = await started();
    t.env.ipc.emit('goal:activate', {hours: 1});
    t.env.run('handleDonationWithGoalSystem(250)');
    t.tick();
    const state = t.env.ipc.sentOn('overlay:state').at(-1);
    assert.equal(state.remaining, '05:00:00');
    assert.equal(state.rublesPerHour, 1000);
    assert.equal(state.isGoalActive, true);
    assert.equal(state.goalText, 'Сбор: 250 / 1000 руб. (1ч)');
    assert.equal(state.goalPercentage, 25);
    assert.equal(state.isPause, true);
    assert.equal(state.sleepModeEnabled, false);
    t.cleanup();
});
