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
    function canEncrypt() {
        try {
            return isReady() && safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    function readFile() {
        const raw = readTextFile(tokensPath);
        if (raw === null) return {tokens: {}, encrypted: false};

        const parsed = JSON.parse(raw);
        if (parsed && parsed.encrypted === true) {
            if (!canEncrypt()) throw new Error('Шифрование недоступно, токены прочитать нельзя');
            const json = safeStorage.decryptString(Buffer.from(parsed.data, 'base64'));
            return {tokens: pickKnownTokens(JSON.parse(json)), encrypted: true};
        }
        return {tokens: pickKnownTokens(parsed), encrypted: false};
    }

    function write(all) {
        const tokens = pickKnownTokens(all);
        const payload = canEncrypt()
            ? {
                version: 1,
                encrypted: true,
                data: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
            }
            : tokens;
        writeFileAtomic(tokensPath, JSON.stringify(payload, null, 2));
    }

    function read() {
        try {
            return readFile().tokens;
        } catch (e) {
            console.error('[auth] Не удалось прочитать токены:', e);
            return {};
        }
    }

    function update(service, token) {
        const {tokens} = readFile();
        tokens[service] = token;
        write(tokens);
    }

    function remove(service) {
        const {tokens} = readFile();
        delete tokens[service];
        write(tokens);
    }

    function upgradeEncryption() {
        try {
            const {tokens, encrypted} = readFile();
            if (!encrypted && canEncrypt() && fs.existsSync(tokensPath)) {
                write(tokens);
                console.log('[auth] Токены зашифрованы');
            }
        } catch (e) {
            console.error('[auth] Не удалось обновить хранилище токенов:', e);
        }
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
