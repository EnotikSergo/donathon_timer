const vm = require('vm');
const fs = require('fs');
const path = require('path');
const {createRequire} = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const START_TIME = 1_700_000_000_000;

function createClock(start = START_TIME) {
    let now = start;
    let seq = 0;
    const timers = new Map();

    const setTimeout_ = (fn, ms = 0, ...args) => {
        const id = ++seq;
        timers.set(id, {fn: () => fn(...args), at: now + Math.max(0, Number(ms) || 0), interval: null});
        return id;
    };
    const setInterval_ = (fn, ms = 0, ...args) => {
        const id = ++seq;
        const interval = Math.max(1, Number(ms) || 0);
        timers.set(id, {fn: () => fn(...args), at: now + interval, interval});
        return id;
    };
    const clear = (id) => {
        timers.delete(id);
    };

    class FakeDate extends Date {
        constructor(...args) {
            if (args.length) super(...args);
            else super(now);
        }

        static now() {
            return now;
        }
    }

    async function flush() {
        for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    }

    async function advance(ms) {
        const target = now + ms;
        for (;;) {
            await flush();
            let next = null;
            for (const [id, t] of timers) {
                if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
            }
            if (!next) break;
            const [id, t] = next;
            now = t.at;
            if (t.interval) t.at = now + t.interval;
            else timers.delete(id);
            t.fn();
        }
        now = target;
        await flush();
    }

    return {
        now: () => now,
        advance,
        flush,
        globals: {
            Date: FakeDate,
            setTimeout: setTimeout_,
            clearTimeout: clear,
            setInterval: setInterval_,
            clearInterval: clear
        }
    };
}

function createIpc(syncReplies = {}) {
    const handlers = {};
    const sent = [];
    return {
        sent,
        ipcRenderer: {
            on: (channel, fn) => {
                (handlers[channel] = handlers[channel] || []).push(fn);
            },
            send: (channel, data) => {
                sent.push([channel, data === undefined ? undefined : JSON.parse(JSON.stringify(data))]);
            },
            sendSync: (channel) => {
                const reply = syncReplies[channel];
                return typeof reply === 'function' ? reply() : reply;
            },
            invoke: (channel) => {
                const reply = syncReplies[channel];
                return Promise.resolve(typeof reply === 'function' ? reply() : reply);
            }
        },
        emit: (channel, data) => {
            for (const fn of handlers[channel] || []) fn({}, data);
        },
        sentOn: (channel) => sent.filter(([c]) => c === channel).map(([, d]) => d)
    };
}

function createElement(id = '') {
    const listeners = {};
    return {
        id,
        style: {},
        innerText: '',
        textContent: '',
        className: '',
        children: [],
        removed: false,
        classList: {add() {}, remove() {}},
        addEventListener: (type, fn) => {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        dispatch: (type, event = {}) => {
            for (const fn of listeners[type] || []) fn(event);
        },
        appendChild(child) {
            this.children.push(child);
        },
        remove() {
            this.removed = true;
        },
        getBoundingClientRect: () => ({left: 0, top: 0, width: 0, height: 0})
    };
}

function createDocument() {
    const elements = {};
    const listeners = {};
    const body = createElement('body');
    return {
        elements,
        body,
        getElementById: (id) => (elements[id] = elements[id] || createElement(id)),
        createElement: () => createElement(),
        addEventListener: (type, fn) => {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        dispatch: (type, event = {}) => {
            for (const fn of listeners[type] || []) fn(event);
        }
    };
}

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        FakeWebSocket.instances.push(this);
    }

    send(data) {
        this.sent.push(data);
    }

    close() {
        this.closed = true;
        this.readyState = 3;
    }

    serverOpen() {
        this.readyState = 1;
        if (this.onopen) this.onopen();
    }

    serverMessage(data) {
        if (this.onmessage) this.onmessage({data});
    }

    serverClose(code = 1006, reason = '') {
        this.readyState = 3;
        if (this.onclose) this.onclose({code, reason});
    }
}

FakeWebSocket.OPEN = 1;
FakeWebSocket.instances = [];

function createFetch(log) {
    let handler = async () => ({status: 500});
    const fetch = async (url, opts = {}) => {
        log.push({url, method: opts.method || 'GET', headers: JSON.parse(JSON.stringify(opts.headers || {})), body: opts.body});
        const r = await handler(url, opts);
        if (r instanceof Error) throw r;
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => {
                if (r.json === undefined) throw new Error('no json');
                return r.json;
            },
            headers: {get: (k) => (r.headers || {})[k] || null}
        };
    };
    return {fetch, setHandler: (h) => {
        handler = h;
    }};
}

function createStorage(initial = {}) {
    const data = {...initial};
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => {
            data[k] = String(v);
        },
        removeItem: (k) => {
            delete data[k];
        }
    };
}

function createBrowserEnv(options = {}) {
    const clock = createClock(options.start);
    const ipc = createIpc(options.syncReplies || {});
    const document = createDocument();
    const fetchLog = [];
    const net = createFetch(fetchLog);
    const windowListeners = {};
    const sockets = [];
    const animationFrames = [];

    class WS extends FakeWebSocket {
        constructor(url) {
            super(url);
            sockets.push(this);
        }
    }

    const realRequire = createRequire(path.join(ROOT, 'index.html'));
    const fakeRequire = (name) => (name === 'electron' ? {ipcRenderer: ipc.ipcRenderer} : realRequire(name));

    const ctx = {
        console: options.console || {log() {}, warn() {}, error() {}},
        ...clock.globals,
        AbortController,
        URL,
        URLSearchParams,
        Buffer,
        navigator: {onLine: true},
        localStorage: createStorage(options.localStorage),
        ipcRenderer: ipc.ipcRenderer,
        WebSocket: WS,
        fetch: net.fetch,
        document,
        Audio: class {
            play() {
                return Promise.resolve();
            }
        },
        Event: class {
            constructor(type) {
                this.type = type;
            }
        },
        CustomEvent: class {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        },
        requestAnimationFrame: (fn) => {
            animationFrames.push(fn);
            return animationFrames.length;
        },
        addEventListener: (type, fn) => {
            (windowListeners[type] = windowListeners[type] || []).push(fn);
        },
        dispatchEvent: (event) => {
            for (const fn of windowListeners[event.type] || []) fn(event);
            return true;
        },
        require: fakeRequire,
        __dirname: ROOT,
        process
    };
    ctx.window = ctx;
    vm.createContext(ctx);

    return {
        ctx,
        clock,
        ipc,
        document,
        sockets,
        fetchLog,
        onFetch: net.setHandler,
        load(relPath) {
            const file = path.join(ROOT, relPath);
            vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, {filename: file});
        },
        run: (code) => vm.runInContext(code, ctx),
        frame() {
            const fn = animationFrames.shift();
            if (fn) fn();
        },
        key(code, extra = {}) {
            document.dispatch('keydown', {code, shiftKey: false, ...extra});
        },
        statuses: (system) => ipc.sentOn('donation:status').filter((d) => d.system === system).map((d) => d.status)
    };
}

module.exports = {ROOT, START_TIME, createClock, createBrowserEnv, FakeWebSocket};
