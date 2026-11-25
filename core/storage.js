const fs = require('fs');
const path = require('path');

function writeFileAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, data, 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (e) {
        try {
            fs.unlinkSync(tmpPath);
        } catch {
        }
        fs.writeFileSync(filePath, data, 'utf8');
    }
}

function readTextFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return null;
    }
}

function removeFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return false;
    }
}

module.exports = {writeFileAtomic, readTextFile, removeFile};
