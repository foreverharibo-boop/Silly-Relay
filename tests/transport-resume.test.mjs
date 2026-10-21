import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../transport.mjs';

const PATH = '/api/backends/chat-completions/generate';
const json = value => Response.json(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
async function within(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('reply delivery remained stuck after foreground resume')), 250);
    })]); } finally { clearTimeout(timer); }
}
function fixture({ bodyStall = false, stream = false, requestTimeout = 2000 } = {}) {
    const waiting = deferred(), stale = deferred(), calls = [], events = [];
    const prefix = stream ? 'first-' : '';
    let reads = 0, completed = false;
    const packet = (cursor, text, state) => ({ status: 200, contentType: 'text/plain', state,
        cursor, next: cursor + Buffer.byteLength(text), bytes: Buffer.byteLength(prefix + 'reply'),
        data: Buffer.from(text).toString('base64') });
    const transport = createTransport({ origin: 'http://localhost:8000', enabled: () => true,
        shouldRelay: () => true, prepareRecovery: async () => true, requestTimeout, retryDelay: 1,
        onEvent: (stage, detail) => events.push({ stage, ...detail }),
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (url.endsWith('/cancel')) return json({ state: 'cancelled' });
            if (url.endsWith('/jobs')) return json({ state: 'running' });
            assert.match(url, /\/jobs\/[a-f0-9]{32}\?cursor=/);
            const cursor = Number(new URL(url).searchParams.get('cursor'));
            reads++;
            if (stream && reads === 1) return json(packet(0, prefix, 'running'));
            if (reads === (stream ? 2 : 1)) {
                waiting.resolve();
                // Simulate a suspended native request (or response body) that does
                // not settle on abort. Late stale data must never enter the stream.
                if (bodyStall) return { ok: true, json: () => stale.promise };
                return stale.promise.then(json);
            }
            completed = true;
            return json(packet(cursor, 'reply', 'completed'));
        } });
    return { transport, waiting, calls, events, get completed() { return completed; },
        release: () => stale.resolve(packet(prefix.length, 'STALE', 'completed')) };
}

for (const options of [{}, { bodyStall: true }, { stream: true }]) {
    test(`foreground resume continues the original request exactly once ${JSON.stringify(options)}`, async () => {
        const f = fixture(options);
        const result = f.transport.fetch(PATH, { method: 'POST', body: '{}' }).then(r => r.text());
        try {
            await f.waiting.promise;
            f.transport.resume?.(); f.transport.resume?.(); f.transport.resume?.();
            assert.equal(await within(result), options.stream ? 'first-reply' : 'reply');
            f.release(); await tick();
            assert.equal(f.calls.filter(c => c.url.endsWith('/jobs')).length, 1, 'never submit another AI generation');
            assert.equal(f.calls.some(c => /\/(ack|cancel)$/.test(c.url)), false, 'leave durable recovery receipt to chat layer');
            assert.equal(f.events.filter(e => e.stage === 'completed').length, 1);
            const polls = f.calls.filter(c => c.url.includes('?cursor='));
            assert.equal(polls.at(-1).url, polls.at(-2).url, 'retry the same job and cursor');
        } finally { f.release(); await result.catch(() => {}); }
    });
}

test('user stop during a suspended read cancels rather than resuming or generating again', async () => {
    const f = fixture(), controller = new AbortController();
    const result = f.transport.fetch(PATH, { method: 'POST', body: '{}', signal: controller.signal }).then(r => r.text());
    const rejected = assert.rejects(within(result), { name: 'AbortError' });
    try {
        await f.waiting.promise;
        controller.abort(); f.transport.resume?.();
        await rejected; await tick();
        assert.equal(f.completed, false);
        assert.equal(f.calls.filter(c => c.url.endsWith('/cancel')).length, 1);
        assert.equal(f.calls.filter(c => c.url.endsWith('/jobs')).length, 1);
    } finally { f.release(); await result.catch(() => {}); }
});

test('read timeout settles even when native fetch ignores abort', async () => {
    const f = fixture({ requestTimeout: 20 });
    const result = f.transport.fetch(PATH, { method: 'POST', body: '{}' }).then(r => r.text());
    try { assert.equal(await within(result), 'reply'); }
    finally { f.release(); await result.catch(() => {}); }
});
