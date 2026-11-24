const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function loadWithFakes() {
    const spawned = [];
    const winPath = path.win32;
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'child_process') {
            return {
                spawn: (cmd, args) => {
                    spawned.push([cmd, args]);
                    return {on: (event, cb) => (event === 'close' && setImmediate(cb))};
                }
            };
        }
        if (request === 'path') return winPath;
        return originalLoad.call(this, request, ...rest);
    };
    const modulePath = require.resolve('../squirrel_startup');
    delete require.cache[modulePath];
    try {
        return {...require(modulePath), spawned};
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
}

async function run(platform, arg) {
    const {handleSquirrelEvent, spawned} = loadWithFakes();
    const saved = {platform: process.platform, argv: process.argv, execPath: process.execPath};
    Object.defineProperty(process, 'platform', {value: platform});
    Object.defineProperty(process, 'execPath', {value: 'C:\\app\\app-1.0.0\\donathon-countdown.exe'});
    process.argv = [process.execPath, arg].filter(Boolean);
    let quits = 0;
    try {
        const handled = handleSquirrelEvent({quit: () => quits++});
        await new Promise((r) => setImmediate(r));
        return {handled, quits, spawned};
    } finally {
        Object.defineProperty(process, 'platform', {value: saved.platform});
        Object.defineProperty(process, 'execPath', {value: saved.execPath});
        process.argv = saved.argv;
    }
}

test('вне Windows и при обычном запуске ничего не делает', async () => {
    assert.deepEqual((await run('linux', '--squirrel-install')).handled, false);
    assert.deepEqual((await run('win32')).handled, false);
    assert.deepEqual((await run('win32', '--some-flag')).handled, false);
    assert.deepEqual((await run('win32', '--squirrel-firstrun')).handled, false);
});

test('установка и обновление создают ярлык и закрывают программу', async () => {
    for (const arg of ['--squirrel-install', '--squirrel-updated']) {
        const r = await run('win32', arg);
        assert.equal(r.handled, true);
        assert.equal(r.quits, 1);
        assert.match(r.spawned[0][0], /\\app\\Update\.exe$/);
        assert.deepEqual(r.spawned[0][1], ['--createShortcut', 'donathon-countdown.exe']);
    }
});

test('удаление убирает ярлык, obsolete просто закрывает', async () => {
    const r = await run('win32', '--squirrel-uninstall');
    assert.equal(r.handled, true);
    assert.deepEqual(r.spawned[0][1], ['--removeShortcut', 'donathon-countdown.exe']);
    const o = await run('win32', '--squirrel-obsolete');
    assert.equal(o.handled, true);
    assert.equal(o.quits, 1);
    assert.equal(o.spawned.length, 0);
});
