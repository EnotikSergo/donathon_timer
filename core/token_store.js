const fs = require('fs');
const {writeFileAtomic, readTextFile} = require('./storage');

const AUTH_SERVICES = ['donationAlerts', 'donateX'];

function pickKnownTokens(obj) {
    const result = {};
    for (const service of AUTH_SERVICES) {
        if (obj && typeof obj[service] === 'string' && obj[service]) result[service] = obj[service];
    }
    return result;
}

function createTokenStore({tokensPath, metaPath, safeStorage, isReady}) {
    let queue = Promise.resolve();

    function serialized(fn) {
        const run = queue.then(fn, fn);
        queue = run.catch(() => {});
        return run;
    }

    async function canEncrypt() {
        try {
            return isReady() && await safeStorage.isAsyncEncryptionAvailable();
        } catch {
            return false;
        }
    }

    async function readFile() {
        const raw = readTextFile(tokensPath);
        if (raw === null) return {tokens: {}, encrypted: false, shouldReEncrypt: false};

        const parsed = JSON.parse(raw);
        if (parsed && parsed.encrypted === true) {
            if (!await canEncrypt()) throw new Error('Шифрование недоступно, токены прочитать нельзя');
            const {result, shouldReEncrypt} = await safeStorage.decryptStringAsync(Buffer.from(parsed.data, 'base64'));
            return {tokens: pickKnownTokens(JSON.parse(result)), encrypted: true, shouldReEncrypt: !!shouldReEncrypt};
        }
        return {tokens: pickKnownTokens(parsed), encrypted: false, shouldReEncrypt: false};
    }

    async function write(all) {
        const tokens = pickKnownTokens(all);
        const payload = await canEncrypt()
            ? {
                version: 1,
                encrypted: true,
                data: (await safeStorage.encryptStringAsync(JSON.stringify(tokens))).toString('base64')
            }
            : tokens;
        writeFileAtomic(tokensPath, JSON.stringify(payload, null, 2));
    }

    function read() {
        return serialized(async () => {
            try {
                return (await readFile()).tokens;
            } catch (e) {
                console.error('[auth] Не удалось прочитать токены:', e);
                return {};
            }
        });
    }

    function update(service, token) {
        return serialized(async () => {
            const {tokens} = await readFile();
            tokens[service] = token;
            await write(tokens);
        });
    }

    function remove(service) {
        return serialized(async () => {
            const {tokens} = await readFile();
            delete tokens[service];
            await write(tokens);
        });
    }

    function upgradeEncryption() {
        return serialized(async () => {
            try {
                if (!fs.existsSync(tokensPath)) return;
                const {tokens, encrypted, shouldReEncrypt} = await readFile();
                if ((!encrypted || shouldReEncrypt) && await canEncrypt()) {
                    await write(tokens);
                    console.log(encrypted ? '[auth] Токены перешифрованы новым ключом' : '[auth] Токены зашифрованы');
                }
            } catch (e) {
                console.error('[auth] Не удалось обновить хранилище токенов:', e);
            }
        });
    }

    function readMeta() {
        try {
            const raw = readTextFile(metaPath);
            return raw === null ? {} : (JSON.parse(raw) || {});
        } catch (e) {
            console.error('[auth] Не удалось прочитать данные аккаунтов:', e);
            return {};
        }
    }

    function writeMeta(data) {
        writeFileAtomic(metaPath, JSON.stringify(data, null, 2));
    }

    return {read, update, remove, upgradeEncryption, readMeta, writeMeta};
}

module.exports = {createTokenStore, AUTH_SERVICES};
