const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {writeFileAtomic, readTextFile, removeFile} = require('../core/storage');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
}

test('запись создаёт папки и не оставляет временных файлов', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a', 'b', 'data.json');
    writeFileAtomic(file, '{"x":1}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}');
    writeFileAtomic(file, '{"x":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"x":2}');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['data.json']);
    fs.rmSync(dir, {recursive: true, force: true});
});

test('чтение отсутствующего файла возвращает null', () => {
    const dir = tmpDir();
    assert.equal(readTextFile(path.join(dir, 'missing.txt')), null);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'текст');
    assert.equal(readTextFile(path.join(dir, 'x.txt')), 'текст');
    fs.rmSync(dir, {recursive: true, force: true});
});

test('удаление: true для существующего, false для отсутствующего', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.txt');
    fs.writeFileSync(file, '1');
    assert.equal(removeFile(file), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(removeFile(file), false);
    fs.rmSync(dir, {recursive: true, force: true});
});
