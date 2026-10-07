'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { createRelay } = require('../server/index.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => randomBytes(16).toString('hex');
const PATH = '/api/backends/chat-completions/generate';
const AUTH = { cookie: 'user=alice', 'x-csrf-token': 'test-csrf', 'content-type': 'application/json' };

async function fixture(t, limits = {}) {
    const routes = [];
    const router = {};
    for (const method of ['get', 'post']) router[method] = (path, handler) => routes.push({ method: method.toUpperCase(), path, handler });
    const relay = createRelay({ pollMs: 40, ...limits });
    relay.install(router);
    const calls = [];
    const server = http.createServer(async (req, res) => {
        res.status = status => { res.statusCode = status; return res; };
        res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
        const user = req.headers.cookie?.match(/user=(alice|bob)/)?.[1];
        if (!user) return res.status(401).json({ error: 'login required' });
        req.user = { profile: { handle: user } };
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== 'test-csrf') return res.status(403).json({ error: 'csrf' });
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
        catch { return res.status(400).json({ error: 'json' }); }
        const url = new URL(req.url, 'http://localhost');
        req.query = Object.fromEntries(url.searchParams);
        if (url.pathname === PATH) {
            const call = { user, body: req.body, finished: false, cancelled: false };
            calls.push(call);
            const finish = () => {
                if (res.destroyed) return;
                call.finished = true;
                if (req.body.error) return res.status(429).json({ error: { message: 'rate limited' } });
                if (req.body.stream) res.end('data: [DONE]\n\n');
                else res.json({ choices: [{ message: { content: '서버가 끝까지 받은 답장 🤍' } }] });
            };
            const timer = setTimeout(finish, req.body.duration || 180);
            if (req.body.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                const utf8 = Buffer.from('data: {"choices":[{"delta":{"content":"안녕 🤍"}}]}\n\n');
                // Split a multibyte Unicode sequence across server writes.
                res.write(utf8.subarray(0, 45));
                setTimeout(() => { if (!res.destroyed) res.write(utf8.subarray(45)); }, 30);
            }
            req.socket.once('close', () => { if (!call.finished) { call.cancelled = true; clearTimeout(timer); } });
            return;
        }
        const path = url.pathname.replace('/api/plugins/silly-relay', '');
        for (const route of routes) {
            const names = [];
            const pattern = route.path.replace(/:([a-z]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
            const match = path.match(new RegExp(`^${pattern}$`));
            if (route.method !== req.method || !match) continue;
            req.params = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
            return route.handler(req, res);
        }
        res.status(404).json({ error: 'not found' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const request = (path, init = {}) => fetch(base + '/api/plugins/silly-relay' + path, { ...init, headers: { ...AUTH, ...init.headers } });
    const start = async (jobId, body = {}, path = PATH) => request('/jobs', { method: 'POST', body: JSON.stringify({ id: jobId, path, body: JSON.stringify(body) }) });
    const get = async jobId => (await request(`/jobs/${jobId}`)).json();
    return { base, request, start, get, calls };
}

test('control: ordinary HTTP generation is cancelled when its browser connection closes', async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const response = await fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true,"duration":300}', signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();
    await delay(50);
    assert.equal(f.calls[0].cancelled, true);
});

test('JSON and SSE finish while browser readers are absent; cursor replay preserves Unicode exactly', async t => {
    const f = await fixture(t, { pageBytes: 7 });
    for (const stream of [false, true]) {
        const jobId = id();
        assert.equal((await f.start(jobId, { stream })).status, 202);
        // Do not read or poll anything while the server finishes.
        await delay(240);
        const chunks = [];
        let cursor = 0;
        let part;
        do {
            part = await (await f.request(`/jobs/${jobId}?cursor=${cursor}`)).json();
            assert.equal(part.cursor, cursor);
            chunks.push(Buffer.from(part.data, 'base64'));
            cursor = part.next;
        } while (cursor < part.bytes);
        assert.equal(part.state, 'completed');
        const text = Buffer.concat(chunks).toString();
        assert.ok(text.includes(stream ? '안녕 🤍' : '서버가 끝까지 받은 답장 🤍'));
        assert.equal(f.calls.at(-1).cancelled, false);
    }
});

test('lost start acknowledgement can be retried without a duplicate AI call', async t => {
    const f = await fixture(t);
    const jobId = id();
    const payload = { duration: 180, messages: [{ role: 'user', content: 'unchanged' }] };
    const first = await f.start(jobId, payload);
    await first.body.cancel();
    const again = await f.start(jobId, payload);
    assert.equal(again.status, 202);
    await delay(240);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].body, payload);
    assert.equal((await f.start(jobId, { different: true })).status, 409);
});

test('aborting a result long-poll never aborts the server-owned generation', async t => {
    const f = await fixture(t, { pollMs: 1000 });
    const jobId = id();
    await f.start(jobId, { duration: 240 });
    await delay(30);
    const controller = new AbortController();
    const pending = f.request(`/jobs/${jobId}?cursor=0&wait=1`, { signal: controller.signal });
    await delay(30);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await delay(260);
    assert.equal((await f.get(jobId)).state, 'completed');
    assert.equal(f.calls[0].cancelled, false);
});

test('explicit cancellation stops generation, including cancel-before-start races', async t => {
    const f = await fixture(t);
    const jobId = id();
    await f.start(jobId, { duration: 500 });
    await delay(30);
    await f.request(`/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
    await delay(40);
    assert.equal((await f.get(jobId)).state, 'cancelled');
    assert.equal(f.calls[0].cancelled, true);
    const late = id();
    await f.request(`/jobs/${late}/cancel`, { method: 'POST', body: '{}' });
    assert.equal((await (await f.start(late)).json()).state, 'cancelled');
    await delay(20);
    assert.equal(f.calls.length, 1);
});

test('user separation, inherited CSRF, route allowlist, cursors and bounded storage', async t => {
    const f = await fixture(t, { responseBytes: 20 });
    const jobId = id();
    await f.start(jobId, { stream: true });
    await delay(100);
    assert.equal((await f.get(jobId)).state, 'failed');
    assert.equal((await f.request(`/jobs/${jobId}`, { headers: { cookie: 'user=bob' } })).status, 404);
    assert.equal((await f.request('/jobs', { headers: { cookie: 'user=bob' } })).status, 404);
    assert.equal((await f.request(`/jobs/${jobId}?cursor=-1`)).status, 400);
    assert.equal((await f.start(id(), {}, 'http://169.254.169.254/')).status, 400);
    assert.equal((await f.start(id(), {}, '/api/secrets/write')).status, 400);
    assert.equal((await f.request('/jobs', { method: 'POST', headers: { 'x-csrf-token': '' }, body: '{}' })).status, 403);
    assert.equal((await f.request('/status', { headers: { cookie: '' } })).status, 401);
    assert.equal(f.calls.length, 1);
});

test('completed results expire; missing jobs are never regenerated', async t => {
    const f = await fixture(t, { retentionMs: 30 });
    const jobId = id();
    await f.start(jobId, { duration: 30 });
    await delay(100);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 404);
    assert.equal(f.calls.length, 1);
});

test('browser fetch resumes after network failures and a lost start response, without duplicated chunks', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    let loseStart = true;
    let failedReads = 0;
    const events = [];
    const transport = createTransport({ origin: f.base, enabled: () => true, retryDelay: 10,
        fetchImpl: async (url, init) => {
            if (String(url).includes('?cursor=') && failedReads++ < 3) throw new TypeError('offline');
            const response = await fetch(url, init);
            if (String(url).endsWith('/jobs') && init.method === 'POST' && loseStart) {
                loseStart = false;
                await response.body.cancel();
                throw new TypeError('lost acknowledgement');
            }
            return response;
        }, onEvent: type => events.push(type) });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true}' });
    const text = await response.text();
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(text, 'data: {"choices":[{"delta":{"content":"안녕 🤍"}}]}\n\ndata: [DONE]\n\n');
    assert.equal(f.calls.length, 1);
    assert.ok(events.includes('reconnecting'));
    assert.ok(events.includes('completed'));
});

test('browser stop signal cancels job; backend error status is preserved', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch });
    const controller = new AbortController();
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true,"duration":500}', signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read(), { name: 'AbortError' });
    await delay(60);
    assert.equal(f.calls[0].cancelled, true);
    const error = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"error":true}' });
    assert.equal(error.status, 429);
    assert.deepEqual(await error.json(), { error: { message: 'rate limited' } });
});

test('browser Request input and cloned streaming response stay readable', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch });
    const req = new Request(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true}' });
    const response = await transport.fetch(req);
    const clone = response.clone();
    const [one, two] = await Promise.all([response.text(), clone.text()]);
    assert.equal(one, two);
    assert.ok(one.includes('안녕 🤍'));
    assert.equal(req.bodyUsed, false);
});

test('a timed-out poll reconnects without being mistaken for the user stop button', async t => {
    const f = await fixture(t, { pollMs: 20 });
    const { createTransport } = await import('../transport.mjs');
    let stalled = false;
    const transport = createTransport({ origin: f.base, enabled: () => true, requestTimeout: 80, retryDelay: 5,
        fetchImpl: async (url, init) => {
            if (String(url).includes('?cursor=') && !stalled) {
                stalled = true;
                return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }));
            }
            return fetch(url, init);
        } });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal((await response.json()).choices[0].message.content, '서버가 끝까지 받은 답장 🤍');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].cancelled, false);
});

test('disabled transport passes the original request through without a relay job', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    const transport = createTransport({ origin: f.base, enabled: () => false, fetchImpl: fetch });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).choices);
    assert.equal((await f.request('/jobs')).status, 404);
});

test('delivery acknowledgement immediately removes the body but preserves duplicate-start protection', async t => {
    const f = await fixture(t, { perUserJobs: 1 });
    const jobId = id();
    await f.start(jobId, { duration: 30 });
    await delay(80);
    const result = await f.get(jobId);
    assert.ok(result.bytes > 0);
    assert.equal((await f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: result.bytes - 1 }) })).status, 409);
    const ack = () => f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: result.bytes }) });
    assert.equal((await ack()).status, 200);
    assert.equal((await ack()).status, 200);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal((await (await f.start(jobId, { duration: 30 })).json()).state, 'delivered');
    assert.equal((await f.start(id(), { duration: 30 })).status, 202, 'Delivered metadata must not consume a pending-response slot');
    await delay(80);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.request('/jobs')).status, 404, 'No archive listing endpoint');
    assert.equal((await f.request(`/jobs/${jobId}/delete`, { method: 'POST', body: '{}' })).status, 404);
});

test('browser automatically acknowledges a complete response without an archive or manual action', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true}' });
    const jobId = response.headers.get('x-silly-relay-job');
    assert.ok((await response.text()).includes('안녕 🤍'));
    await delay(50);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
});
