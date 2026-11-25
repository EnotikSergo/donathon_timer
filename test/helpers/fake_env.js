const path = require('path');

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

function createServiceEnv(options = {}) {
    const clock = createClock(options.start);
    const fetchLog = [];
    const net = createFetch(fetchLog);
    const sockets = [];

    class WS extends FakeWebSocket {
        constructor(url) {
            super(url);
            sockets.push(this);
        }
    }

    return {
        clock,
        fetchLog,
        sockets,
        onFetch: net.setHandler,
        deps: {
            fetch: net.fetch,
            WebSocket: WS,
            timers: {
                setTimeout: clock.globals.setTimeout,
                clearTimeout: clock.globals.clearTimeout,
                setInterval: clock.globals.setInterval,
                clearInterval: clock.globals.clearInterval
            },
            now: () => clock.now(),
            random: () => 0,
            log: {log() {}, warn() {}, error() {}}
        }
    };
}

module.exports = {ROOT, START_TIME, createClock, createServiceEnv, FakeWebSocket};
