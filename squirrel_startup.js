const path = require('path');
const {spawn} = require('child_process');

function handleSquirrelEvent(app) {
    if (process.platform !== 'win32') return false;

    const command = process.argv[1];
    if (!command || !command.startsWith('--squirrel-')) return false;

    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    const exeName = path.basename(process.execPath);

    const runUpdate = (args) => {
        try {
            spawn(updateExe, args, {detached: true}).on('close', () => app.quit());
        } catch (e) {
            app.quit();
        }
    };

    switch (command) {
        case '--squirrel-install':
        case '--squirrel-updated':
            runUpdate(['--createShortcut', exeName]);
            return true;
        case '--squirrel-uninstall':
            runUpdate(['--removeShortcut', exeName]);
            return true;
        case '--squirrel-obsolete':
            app.quit();
            return true;
        default:
            return false;
    }
}

module.exports = {handleSquirrelEvent};
