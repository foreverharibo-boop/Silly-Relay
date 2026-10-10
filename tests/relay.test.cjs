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

async function fixture(t, limits = {}, network = {}) {
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
            if (network.rejectGeneration) return res.status(403).json({ error: 'internal request denied' });
            const call = { user, body: req.body, headers: req.headers, localAddress: req.socket.localAddress,
                finished: false, cancelled: false };
            calls.push(call);
            const finish = () => {
                if (res.destroyed) return;
                call.finished = true;
                if (req.body.error) return res.status(429).json({ error: { message: 'rate limited' } });
                if (req.body.stream) res.end('data: [DONE]\n\n');
                else res.json({ choices: [{ message: { content: req.body.testReply ?? '서버가 끝까지 받은 답장 🤍', reasoning_content: req.body.testReasoning || '' } }] });
            };
            const timer = setTimeout(finish, req.body.duration || 180);
            if (req.body.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                const utf8 = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: req.body.testReply ?? '안녕 🤍' } }] }) + '\n\n');
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
            if (path === '/jobs' && req.method === 'POST' && network.acceptedAddress) {
                // Model a request accepted on a LAN/Tailscale interface of this
                // real listener without requiring a VPN interface on the test host.
                return route.handler({ ...req, headers: req.headers, socket: {
                    localAddress: network.acceptedAddress, localPort: req.socket.localPort,
                    server: network.hideListener ? undefined : req.socket.server,
                } }, res);
            }
            return route.handler(req, res);
        }
        res.status(404).json({ error: 'not found' });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, network.listenHost || '127.0.0.1', resolve);
    });
    const base = `http://${network.clientHost || '127.0.0.1'}:${server.address().port}`;
    t.after(async () => { relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const request = (path, init = {}) => fetch(base + '/api/plugins/silly-relay' + path, { ...init, headers: { ...AUTH, ...init.headers } });
    const start = async (jobId, body = {}, path = PATH) => request('/jobs', { method: 'POST', body: JSON.stringify({ id: jobId, path, body: JSON.stringify(body) }) });
    const get = async jobId => (await request(`/jobs/${jobId}`)).json();
    return { base, request, start, get, calls };
}

test('five concurrent helpers bypass relay capacity while the main reply is relayed once', async t => {
    const f = await fixture(t, { perUserActive: 1 });
    const { createTransport } = await import('../transport.mjs');
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    const events = [];
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch,
        shouldRelay: filter.take, onEvent: type => events.push(type) });
    filter.generationStarted();
    const helpers = Array.from({ length: 5 }, (_, i) => {
        const data = { messages: [{ role: 'user', content: `helper ${i}` }], duration: 100 };
        filter.settingsReady(data);
        return transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(data) }).then(r => r.json());
    });
    const prompt = [{ role: 'user', content: 'character reply' }];
    filter.dataReady({ prompt });
    const main = { messages: prompt.filter(Boolean), stream: true, duration: 180 };
    filter.settingsReady(main);
    const reply = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(main) });
    assert.match(await reply.text(), /\[DONE\]/);
    await Promise.all(helpers);
    assert.equal(f.calls.length, 6, 'each AI request is sent exactly once');
    assert.equal(events.filter(e => e === 'accepted').length, 1);
    assert.equal(events.filter(e => e === 'completed').length, 1);
    assert.equal(events.includes('error'), false);
});

test('wildcard IPv4 listener routes LAN and mapped Tailscale requests through authenticated loopback once', async t => {
    for (const acceptedAddress of ['192.0.2.10', '::ffff:100.85.10.10']) {
        const f = await fixture(t, {}, { listenHost: '0.0.0.0', acceptedAddress });
        const { createTransport } = await import('../transport.mjs');
        const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, fetchImpl: fetch });
        const body = { duration: 10, messages: [{ role: 'user', content: 'preserve prompt' }] };
        const response = await transport.fetch(f.base + PATH, {
            method: 'POST', headers: { ...AUTH, host: 'untrusted.invalid:9', 'x-forwarded-for': '203.0.113.5' },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        assert.ok((await response.json()).choices);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].localAddress, '127.0.0.1');
        assert.equal(f.calls[0].user, 'alice');
        assert.equal(f.calls[0].headers['x-csrf-token'], AUTH['x-csrf-token']);
        assert.match(f.calls[0].headers['user-agent'], /^Silly-Relay\//);
        assert.equal(f.calls[0].headers['x-forwarded-for'], undefined);
        assert.deepEqual(f.calls[0].body, body);
    }
});

test('target selection respects IPv6 family, interface-only binding and listener port identity', () => {
    const { internalAddress } = require('../server/index.cjs');
    const socket = (localAddress, address, port = 8000) => ({
        localAddress, localPort: 8000, server: { address: () => ({ address, port }) },
    });
    assert.equal(internalAddress(socket('2001:db8::10', '::')), '::1');
    assert.equal(internalAddress(socket('::ffff:100.85.10.10', '::')), '127.0.0.1');
    assert.equal(internalAddress(socket('100.85.10.10', '100.85.10.10')), '100.85.10.10');
    assert.equal(internalAddress(socket('2001:db8::10', '2001:db8::10')), '2001:db8::10');
    assert.equal(internalAddress(socket('100.85.10.10', '0.0.0.0', 9000)), '100.85.10.10');
});

test('missing listener metadata preserves the accepted address and mapped IPv4 normalization', async t => {
    const f = await fixture(t, {}, { acceptedAddress: '::ffff:127.0.0.1', hideListener: true });
    const jobId = id();
    await f.start(jobId, { duration: 10 });
    await delay(60);
    assert.equal((await f.get(jobId)).status, 200);
    assert.equal(f.calls.length, 1);
});

test('loopback still applies server rejection without an alternate generation attempt', async t => {
    const f = await fixture(t, {}, { listenHost: '0.0.0.0', acceptedAddress: '100.85.10.10', rejectGeneration: true });
    const { createTransport } = await import('../transport.mjs');
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, fetchImpl: fetch });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'internal request denied' });
    assert.equal(f.calls.length, 0);
});

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
    // Under a busy event loop the generation timer may run late too. Observe
    // actual expiry instead of assuming it completed 70 ms before this check.
    let status;
    const deadline = Date.now() + 2000;
    do {
        status = (await f.request(`/jobs/${jobId}`)).status;
        if (status === 404) break;
        await delay(10);
    } while (Date.now() < deadline);
    assert.equal(status, 404);
    assert.equal(f.calls.length, 1);
});

test('browser fetch resumes after network failures and a lost start response, without duplicated chunks', async t => {
    const f = await fixture(t);
    const { createTransport } = await import('../transport.mjs');
    let loseStart = true;
    let failedReads = 0;
    const events = [];
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, retryDelay: 10,
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
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, fetchImpl: fetch });
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
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, fetchImpl: fetch });
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
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, requestTimeout: 80, retryDelay: 5,
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
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => false, fetchImpl: fetch });
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
    const transport = createTransport({ shouldRelay: () => true, origin: f.base, enabled: () => true, fetchImpl: fetch });
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"stream":true}' });
    const jobId = response.headers.get('x-silly-relay-job');
    assert.ok((await response.text()).includes('안녕 🤍'));
    await delay(50);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
});

// Each makePage() has a fresh JS heap, but the tab journal and saved ST chat survive.
async function recoveryBrowser(t, f) {
    const { createRecovery, MARK } = await import('../recovery.mjs');
    const { createTransport } = await import('../transport.mjs');
    const copy = data => JSON.parse(JSON.stringify(data));
    const storageMap = new Map();
    const storage = { getItem: key => storageMap.get(key) || null, setItem: (key, value) => storageMap.set(key, value) };
    const disk = { messages: [{ name: 'User', is_user: true, mes: '안녕', send_date: '2026-10-07' }], failSave: false };
    const messages = [], rendered = [], emitted = [], diagnostics = [];
    async function makePage(tabId = 'same-tab', options = {}) {
        const ctx = { chat: copy(disk.messages), characters: [{ avatar: 'Char.png' }], characterId: 0,
            chatId: 'Chat A', name2: 'Character', groupId: null, chatCompletionSettings: { chat_completion_source: 'custom' },
            eventTypes: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
            eventSource: { emit: async (...args) => emitted.push(args) },
            addOneMessage: m => rendered.push(m),
            saveChat: async () => { if (!disk.failSave) disk.messages = copy(ctx.chat); } };
        const request = async (url, init) => {
            if (url === '/api/chats/get') return Response.json([{ chat_metadata: {} }, ...copy(disk.messages)]);
            return fetch(url, init);
        };
        let recovery;
        const transport = createTransport({ shouldRelay: () => true, fetchImpl: request, origin: f.base, enabled: () => true,
            prepareRecovery: data => recovery.prepare(data), onEvent: (type, data) => recovery.event(type, data) });
        recovery = createRecovery({ getContext: () => ctx, api: transport.api, fetchImpl: request,
            getHeaders: () => AUTH, storage, tabId, ...options, notify: text => messages.push(text),
            diagnostic: text => diagnostics.push(text) });
        t.after(() => recovery.stop());
        const arm = () => { recovery.generationStarted('normal'); recovery.dataReady({}, false); };
        return { ctx, recovery, transport, arm };
    }
    return { makePage, disk, messages, rendered, emitted, diagnostics, MARK };
}

test('filtered untyped native reply still restores after reload; helper creates no recovery record', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const { createTransport } = await import('../transport.mjs');
    const filter = createReplyFilter();
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch,
        shouldRelay: filter.take, prepareRecovery: data => page.recovery.prepare(data),
        onEvent: (type, data) => page.recovery.event(type, data) });
    page.arm(); filter.generationStarted();
    const helper = { messages: [{ role: 'user', content: 'helper' }], duration: 5 };
    if (filter.settingsReady(helper)) page.recovery.settingsReady(helper);
    await (await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(helper) })).text();
    assert.equal(page.recovery.list().length, 0);
    const prompt = [{ role: 'user', content: 'native reply' }];
    filter.dataReady({ prompt });
    const main = { messages: prompt.filter(Boolean), duration: 5 };
    if (filter.settingsReady(main)) page.recovery.settingsReady(main);
    main.silly_pop = { generationId: 'notifier-kept' };
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(main) });
    const jobId = response.headers.get('x-silly-relay-job');
    assert.ok(jobId);
    await response.text(); page.recovery.stop();
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages.length, 2);
    assert.equal(b.disk.messages[1].mes, '서버가 끝까지 받은 답장 🤍');
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].body.silly_pop, main.silly_pop);
});

test('reload before completion restores JSON and split-Unicode SSE into the original chat exactly once', async t => {
    for (const stream of [false, true]) {
        const f = await fixture(t, { pageBytes: 7 });
        const b = await recoveryBrowser(t, f);
        const page = await b.makePage();
        page.arm();
        const jobId = id();
        assert.equal(await page.recovery.prepare({ id: jobId, path: PATH, body: JSON.stringify({ type: 'normal', stream }) }), true);
        await f.start(jobId, { stream, duration: 100 });
        page.recovery.stop(); // Page was discarded; none of its promises can resume.
        const otherTab = await b.makePage('other-tab');
        await otherTab.recovery.recover();
        assert.equal(b.disk.messages.length, 1);
        const reloaded = await b.makePage();
        await reloaded.recovery.recover();
        assert.equal(b.disk.messages.length, 2);
        assert.equal(b.disk.messages[1].mes, stream ? '안녕 🤍' : '서버가 끝까지 받은 답장 🤍');
        assert.equal(b.disk.messages[1].extra[b.MARK].id, jobId);
        assert.equal(b.disk.messages[1].extra[b.MARK].complete, true);
        assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
        await reloaded.recovery.recover();
        await (await b.makePage()).recovery.recover();
        assert.equal(b.disk.messages.length, 2);
        assert.equal(f.calls.length, 1);
        assert.equal(b.emitted.filter(e => e[0] === 'received').length, 1);
    }
});

test('transport EOF is not a chat-save receipt: reload after reading bytes still recovers', async t => {
    const f = await fixture(t);
    const b = await recoveryBrowser(t, f);
    const page = await b.makePage();
    page.arm();
    const response = await page.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: JSON.stringify({ type: 'normal', duration: 30 }) });
    const jobId = response.headers.get('x-silly-relay-job');
    await response.text();
    assert.equal((await f.get(jobId)).state, 'completed');
    assert.equal(b.disk.messages.length, 1);
    page.recovery.stop();
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages.length, 2);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal(f.calls.length, 1);
});

test('normal live completion deletes the response only after the marked chat is saved', async t => {
    const f = await fixture(t);
    const b = await recoveryBrowser(t, f);
    const page = await b.makePage(); page.arm();
    const response = await page.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"type":"normal","duration":25}' });
    const jobId = response.headers.get('x-silly-relay-job');
    const data = await response.json();
    page.ctx.chat.push({ name: 'Character', is_user: false, mes: data.choices[0].message.content, extra: {} });
    page.recovery.tag(1, true);
    await page.recovery.settle();
    assert.equal((await f.get(jobId)).state, 'completed');
    await page.ctx.saveChat();
    await page.recovery.settle();
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages.length, 2);
});

test('a durable visible reply without a completion marker is acknowledged without warnings or chat writes', async t => {
    for (const swipe of [false, true]) for (const stream of [false, true]) {
        const f = await fixture(t, { pageBytes: 7 }), b = await recoveryBrowser(t, f);
        if (swipe) seedSwipes(b);
        const old = await b.makePage();
        swipe ? armSwipe(old) : old.arm();
        const jobId = id();
        await old.recovery.prepare({ id: jobId, path: PATH, body: JSON.stringify({ type: swipe ? 'swipe' : 'normal', stream }) });
        await f.start(jobId, { stream, duration: 60 });
        old.recovery.stop();
        const text = stream ? '안녕 🤍' : '서버가 끝까지 받은 답장 🤍';
        if (swipe) {
            const last = b.disk.messages.at(-1);
            last.mes = text; last.swipe_id = last.swipes.length;
            last.swipes.push(text); last.swipe_info.push({ extra: {} }); last.extra = {};
        } else {
            b.disk.messages.push({ name: 'Character', is_user: false, mes: text, extra: {} });
        }
        const before = structuredClone(b.disk.messages);
        const fresh = await b.makePage();
        fresh.ctx.saveChat = async () => { assert.fail('receipt must not rewrite the chat'); };
        await fresh.recovery.recover();
        assert.deepEqual(b.disk.messages, before);
        assert.deepEqual(fresh.ctx.chat, before);
        assert.equal(fresh.recovery.list().length, 0);
        assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
        assert.deepEqual(b.messages, []);
        assert.deepEqual(b.emitted, []);
        assert.deepEqual(b.rendered, []);
    }
});

test('text fallback never acknowledges a different, edited, unsaved or foreign reply', async t => {
    for (const conflict of ['text', 'history', 'unsaved', 'foreign', 'later-message', 'swipe']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f);
        const old = await b.makePage(); old.arm(); const jobId = id();
        await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        await f.start(jobId, { duration: 10 }); old.recovery.stop();
        b.disk.messages.push({ name: 'Character', is_user: false, mes: '서버가 끝까지 받은 답장 🤍', extra: {} });
        if (conflict === 'text') b.disk.messages[1].mes = '다른 답장';
        if (conflict === 'history') b.disk.messages[0].mes = '수정한 기록';
        if (conflict === 'foreign') b.disk.messages[1].extra[b.MARK] = { id: id(), complete: true };
        if (conflict === 'later-message') b.disk.messages.push({ name: 'User', is_user: true, mes: '다음 메시지' });
        if (conflict === 'swipe') {
            b.disk.messages[1].swipes = ['이전 후보', b.disk.messages[1].mes];
            b.disk.messages[1].swipe_id = 1;
        }
        const fresh = await b.makePage();
        if (conflict === 'unsaved') fresh.ctx.chat[1].mes = '아직 저장하지 않은 수정';
        const saved = structuredClone(b.disk.messages), visible = structuredClone(fresh.ctx.chat);
        await fresh.recovery.recover();
        assert.deepEqual(b.disk.messages, saved);
        assert.deepEqual(fresh.ctx.chat, visible);
        assert.equal(fresh.recovery.list().length, 1);
        assert.equal((await f.get(jobId)).state, 'completed');
        assert.equal(b.rendered.length, 0);
        assert.equal(b.emitted.length, 0);
    }
});

test('a failed recovery save retains the reply; retry saves the same message without duplication', async t => {
    const f = await fixture(t);
    const b = await recoveryBrowser(t, f);
    const page = await b.makePage(); page.arm(); const jobId = id();
    await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 20 }); page.recovery.stop();
    const fresh = await b.makePage(); b.disk.failSave = true;
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat.length, 2);
    assert.equal(b.disk.messages.length, 1);
    assert.equal((await f.get(jobId)).state, 'completed');
    b.disk.failSave = false;
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat.length, 2);
    assert.equal(b.disk.messages.length, 2);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
});

test('automatic missing-response checks record a diagnostic without a toast; explicit recovery still reports it', async t => {
    for (const status of [404, 410]) for (const manual of [false, true]) {
        const f = await fixture(t), b = await recoveryBrowser(t, f);
        const old = await b.makePage(); old.arm(); const jobId = id();
        await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        old.recovery.stop();
        if (status === 410) {
            await f.start(jobId, { duration: 10 });
            await delay(40);
            const info = await f.get(jobId);
            assert.equal(info.state, 'completed');
            assert.equal((await f.request(`/jobs/${jobId}/ack`, {
                method: 'POST', body: JSON.stringify({ cursor: info.bytes }),
            })).status, 200);
        }
        const before = structuredClone(b.disk.messages);
        const fresh = await b.makePage('same-tab', { allowPreviousSession: true });
        if (manual) await fresh.recovery.recoverPreviousSession();
        else await fresh.recovery.recover();
        assert.deepEqual(b.disk.messages, before);
        assert.deepEqual(fresh.ctx.chat, before);
        assert.equal(fresh.recovery.list().length, 0);
        assert.equal(b.diagnostics.length, 1);
        assert.match(b.diagnostics[0], new RegExp(`HTTP ${status}`));
        assert.ok(b.diagnostics[0].includes(jobId.slice(0, 8)));
        assert.equal(b.messages.length, manual ? 1 : 0);
        assert.equal(b.emitted.length, 0);
        assert.equal(b.rendered.length, 0);
        await fresh.recovery.recover();
        assert.equal(b.diagnostics.length, 1, 'stale records do not keep polling or reporting');
    }
});

test('wrong chat, edited history and a new unmarked answer are never overwritten', async t => {
    for (const conflict of ['wrong-chat', 'edit', 'new-answer']) {
        const f = await fixture(t); const b = await recoveryBrowser(t, f);
        const page = await b.makePage(); page.arm(); const jobId = id();
        await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        await f.start(jobId, { duration: 20 }); page.recovery.stop();
        if (conflict === 'edit') b.disk.messages[0].mes = '사용자가 고친 내용';
        if (conflict === 'new-answer') b.disk.messages.push({ name: 'Character', is_user: false, mes: '다른 답장' });
        const original = JSON.stringify(b.disk.messages);
        const fresh = await b.makePage();
        if (conflict === 'wrong-chat') fresh.ctx.chatId = 'Chat B';
        await fresh.recovery.recover();
        assert.equal(JSON.stringify(b.disk.messages), original);
        assert.equal(b.rendered.length, 0);
        assert.equal(f.calls.length, 1);
    }
});

test('a saved partial message with this job marker is replaced, not appended', async t => {
    const f = await fixture(t); const b = await recoveryBrowser(t, f);
    const page = await b.makePage(); page.arm(); const jobId = id();
    await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 20 });
    page.ctx.chat.push({ name: 'Character', is_user: false, mes: '서버가 끝까', extra: {} });
    page.recovery.tag(1, false); await page.ctx.saveChat(); page.recovery.stop();
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages.length, 2);
    assert.equal(b.disk.messages[1].mes, '서버가 끝까지 받은 답장 🤍');
});

test('hidden/quiet/tool/group requests never acquire a chat recovery binding; explicit stop removes it', async t => {
    const f = await fixture(t); const b = await recoveryBrowser(t, f); const p = await b.makePage();
    for (const data of [{ type: 'quiet' }, { type: 'swipe' }, { type: 'normal', tools: [{}] }, { type: 'normal', n: 2 }]) {
        p.arm(); assert.equal(await p.recovery.prepare({ id: id(), path: PATH, body: JSON.stringify(data) }), false);
    }
    p.ctx.groupId = 'group'; p.arm();
    assert.equal(await p.recovery.prepare({ id: id(), path: PATH, body: '{"type":"normal"}' }), false);
    p.ctx.groupId = null; p.arm();
    assert.equal(await p.recovery.prepare({ id: id(), path: PATH, body: '{"type":"normal"}' }), true);
    assert.equal(p.recovery.list().length, 1);
    p.recovery.generationStopped();
    assert.equal(p.recovery.list().length, 0);
    assert.equal(f.calls.length, 0);
});

test('recovery decoder keeps SSE metadata out of the reply and rejects errors/tools', async () => {
    const { decodeReply } = await import('../recovery.mjs');
    const record = { stream: true, mainApi: 'openai' };
    const raw = ': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"생각","content":"안"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"녕"}}]}\r\n\r\ndata: {"usage":{"tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
    assert.deepEqual(decodeReply(raw, record, { showThoughts: true }), { text: '안녕', reasoning: '생각', signature: null });
    assert.throws(() => decodeReply('data: {"error":"bad"}\n\n', record), /오류/);
    assert.throws(() => decodeReply('data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n', record), /도구 호출/);
    assert.throws(() => decodeReply('data: {"usage":{"tokens":3}}\n\n', record), /텍스트/);
});

test('recovery reasoning respects both request opt-out and current setting, including old journals', async () => {
    const { decodeReply } = await import('../recovery.mjs');
    const chunk = { choices: [{ delta: { content: '답장', reasoning_content: '생각' } }] };
    const json = JSON.stringify({ choices: [{ message: chunk.choices[0].delta }] });
    for (const includeReasoning of [undefined, false, true]) {
        for (const showThoughts of [undefined, false, true]) {
            const expected = showThoughts === true && includeReasoning !== false;
            const options = { showThoughts };
            for (const stream of [false, true]) {
                const record = { stream, mainApi: 'openai', includeReasoning };
                const raw = stream ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` : json;
                assert.deepEqual(decodeReply(raw, record, options), {
                    text: '답장', reasoning: expected ? '생각' : '', signature: null,
                });
                if (stream) {
                    const parsed = decodeReply(raw, record, { ...options, streamChunk(data, state, settings) {
                        assert.equal(settings.overrideShowThoughts, expected);
                        state.reasoning += '생각'; // Even a parser ignoring the flag cannot re-enable it.
                        state.signature = 'opaque-provider-signature';
                        return data.choices[0].delta.content;
                    } });
                    assert.deepEqual(parsed, { text: '답장', reasoning: expected ? '생각' : '', signature: 'opaque-provider-signature' });
                }
            }
        }
    }
});

test('reload saves reply and swipe with reasoning only when requested and still enabled', async t => {
    for (const requested of [false, true]) {
        for (const current of [false, true]) {
            const f = await fixture(t);
            const b = await recoveryBrowser(t, f);
            const page = await b.makePage();
            page.ctx.chatCompletionSettings.show_thoughts = true;
            page.arm();
            const jobId = id();
            await page.recovery.prepare({ id: jobId, path: PATH,
                body: JSON.stringify({ type: 'normal', include_reasoning: requested }) });
            assert.equal(page.recovery.list()[0].includeReasoning, requested);
            await f.start(jobId, { duration: 10, testReasoning: '非表示の思考' });
            page.recovery.stop();
            const reloaded = await b.makePage();
            reloaded.ctx.chatCompletionSettings.show_thoughts = current;
            await reloaded.recovery.recover();
            const message = b.disk.messages[1];
            assert.equal(message.mes, '서버가 끝까지 받은 답장 🤍');
            assert.equal(message.extra.reasoning, requested && current ? '非表示の思考' : '');
            assert.equal(message.swipe_info[0].extra.reasoning, message.extra.reasoning);
            assert.equal(message.extra[b.MARK].recovered, true);
            assert.equal(f.calls.length, 1);
            assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
        }
    }
});

test('failed upstream and expired jobs leave no automatic retry or fabricated chat message', async t => {
    for (const mode of ['error', 'expired']) {
        const f = await fixture(t, mode === 'expired' ? { retentionMs: 25 } : {});
        const b = await recoveryBrowser(t, f); const p = await b.makePage(); p.arm(); const jobId = id();
        await p.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        await f.start(jobId, { duration: 10, error: mode === 'error' }); p.recovery.stop();
        await delay(mode === 'expired' ? 80 : 20);
        const next = await b.makePage(); await next.recovery.recover();
        assert.equal(b.disk.messages.length, 1);
        assert.equal(next.recovery.list().length, 0);
        assert.equal(f.calls.length, 1);
        assert.ok((mode === 'expired' ? b.diagnostics : b.messages).length > 0);
    }
});

test('recovery preflight failure cannot cancel or duplicate the original generation', async t => {
    const { createTransport } = await import('../transport.mjs');
    for (const reason of ['server capability check failed', 'QuotaExceededError', 'chat read-back failed']) {
        const f = await fixture(t); const events = [];
        const transport = createTransport({ shouldRelay: () => true, fetchImpl: fetch, origin: f.base, enabled: () => true,
            prepareRecovery: async () => { throw new Error(reason); },
            onEvent: (type, data) => events.push({ type, data }) });
        const body = JSON.stringify({ type: 'normal', messages: [{ role: 'user', content: '그대로 보내기' }], duration: 10 });
        const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body });
        assert.equal((await response.json()).choices[0].message.content, '서버가 끝까지 받은 답장 🤍');
        assert.equal(f.calls.length, 1);
        assert.deepEqual(f.calls[0].body, JSON.parse(body));
        assert.equal(f.calls[0].cancelled, false);
        assert.equal(events.filter(e => e.type === 'recovery-unavailable').length, 1);
        assert.equal(events.find(e => e.type === 'accepted').data.reloadRecovery, false);
        assert.equal(events.some(e => e.type === 'cancelled'), false);
    }
});

test('recovery preparation never force-saves or reads the chat before starting generation', async t => {
    const f = await fixture(t); const b = await recoveryBrowser(t, f); const p = await b.makePage();
    const controller = new AbortController();
    let forcedSaves = 0;
    p.ctx.saveChat = async () => { forcedSaves++; controller.abort(); throw new Error('save would interfere with generation'); };
    p.arm();
    const response = await p.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: '{"type":"normal","duration":10}', signal: controller.signal });
    assert.ok((await response.json()).choices[0].message.content);
    assert.equal(forcedSaves, 0);
    assert.equal(controller.signal.aborted, false);
    assert.equal(p.recovery.list().length, 1);
    assert.equal(f.calls.length, 1);
});

test('storage denial degrades recovery without preventing the reply', async t => {
    const f = await fixture(t);
    const { createRecovery } = await import('../recovery.mjs');
    const { createTransport } = await import('../transport.mjs');
    const ctx = { chat: [{ name: 'User', is_user: true, mes: 'Hi' }], characters: [{ avatar: 'Char.png' }],
        characterId: 0, chatId: 'Chat', name2: 'Character' };
    const events = []; let recovery;
    const transport = createTransport({ shouldRelay: () => true, fetchImpl: fetch, origin: f.base, enabled: () => true,
        prepareRecovery: data => recovery.prepare(data), onEvent: (type, data) => events.push({ type, data }) });
    recovery = createRecovery({ getContext: () => ctx, api: transport.api,
        fetchImpl: () => { throw new Error('Must not read chat on generation path'); }, getHeaders: () => AUTH,
        storage: { getItem: () => null, setItem: () => { throw new DOMException('Storage full', 'QuotaExceededError'); } }, tabId: 'tab' });
    t.after(() => recovery.stop()); recovery.generationStarted('normal'); recovery.dataReady({}, false);
    const response = await transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"type":"normal","duration":10}' });
    assert.ok((await response.json()).choices[0].message.content);
    assert.equal(recovery.list().length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(events.find(e => e.type === 'accepted').data.reloadRecovery, false);
});

test('explicit abort during failed optional preparation still prevents the AI request', async t => {
    const f = await fixture(t); const { createTransport } = await import('../transport.mjs');
    const controller = new AbortController();
    const transport = createTransport({ shouldRelay: () => true, fetchImpl: fetch, origin: f.base, enabled: () => true,
        prepareRecovery: async () => { controller.abort(); throw new Error('optional failure'); } });
    await assert.rejects(transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: '{"type":"normal"}', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.calls.length, 0);
});

test('full PWA relaunch with lost session storage restores JSON/SSE once without another AI request', async t => {
    const { recoveryIdentity } = await import('../identity.mjs');
    const memory = () => { const m = new Map(); return { getItem: k => m.get(k) || null, setItem: (k,v) => m.set(k,v) }; };
    for (const stream of [false, true]) {
        const local = memory();
        const oldId = recoveryIdentity({ local, session: memory(), standalone: true, newId: id });
        const f = await fixture(t), b = await recoveryBrowser(t, f);
        const page = await b.makePage(oldId); page.arm(); const jobId = id();
        await page.recovery.prepare({ id: jobId, path: PATH, body: JSON.stringify({ type: 'normal', stream, include_reasoning: false }) });
        await f.start(jobId, { stream, duration: 60 }); page.recovery.stop();
        const restartedId = recoveryIdentity({ local, session: memory(), standalone: true, newId: id });
        const next = await b.makePage(restartedId);
        next.ctx.chatId = undefined; // Login/lock screen has no selected chat yet.
        await next.recovery.recover(); assert.equal(b.disk.messages.length, 1);
        next.ctx.chatId = 'Chat A'; await next.recovery.recover();
        assert.equal(b.disk.messages.length, 2);
        assert.equal(b.disk.messages[1].extra[b.MARK].recovered, true);
        assert.equal(b.disk.messages[1].extra.reasoning, '');
        await (await b.makePage(restartedId)).recovery.recover();
        assert.equal(b.disk.messages.length, 2); assert.equal(f.calls.length, 1);
    }
});

test('explicit legacy PWA recovery migrates one old session but never another browser tab automatically', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage('old-session'); old.arm(); const jobId = id();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); old.recovery.stop(); await delay(25);
    const ordinary = await b.makePage('browser-tab');
    await ordinary.recovery.recoverPreviousSession(); await ordinary.recovery.recover();
    assert.equal(b.disk.messages.length, 1);
    const app = await b.makePage('persistent-app', { allowPreviousSession: true });
    await app.recovery.recover(); assert.equal(b.disk.messages.length, 1);
    await app.recovery.recoverPreviousSession();
    assert.equal(b.disk.messages.length, 2); assert.equal(b.disk.messages[1].extra[b.MARK].id, jobId);
    await app.recovery.recoverPreviousSession(); assert.equal(b.disk.messages.length, 2);
    assert.equal(f.calls.length, 1);
});

test('legacy lookup refuses changed history, wrong chat, multiple candidates and expired server result', async t => {
    for (const mode of ['changed', 'wrong', 'multiple', 'expired']) {
        const f = await fixture(t, mode === 'expired' ? { retentionMs: 15 } : {}), b = await recoveryBrowser(t, f);
        const old = await b.makePage('old-session'); old.arm(); const jobId = id();
        await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        if (mode === 'multiple') { old.arm(); await old.recovery.prepare({ id: id(), path: PATH, body: '{"type":"normal"}' }); }
        await f.start(jobId, { duration: 10 }); old.recovery.stop(); await delay(mode === 'expired' ? 70 : 25);
        if (mode === 'changed') b.disk.messages[0].mes = '수정한 내용';
        const app = await b.makePage('new-app', { allowPreviousSession: true });
        if (mode === 'wrong') app.ctx.chatId = 'Other Chat';
        await app.recovery.recoverPreviousSession();
        assert.equal(b.disk.messages.length, 1, mode);
        assert.equal(f.calls.length, 1, mode);
        assert.ok(b.messages.length > 0, mode);
    }
});

test('saved reply is displayed on a stale relaunched page before its recovery record is removed', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage(); old.arm(); const jobId = id();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); await delay(25);
    const fresh = await b.makePage(); // This page loaded before the old page finished saving.
    old.ctx.chat.push({ name: 'Character', is_user: false, mes: '이미 저장된 답장', extra: {} });
    old.recovery.tag(1, true); await old.ctx.saveChat(); old.recovery.stop();
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat[1]?.mes, '이미 저장된 답장');
    assert.equal(b.rendered.length, 1);
    assert.equal(b.emitted.length, 0, 'displaying a saved reply must not rerun extensions');
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal(f.calls.length, 1);
});

test('a saved reply remains displayable after transport ACK even without a recorded byte count', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage(); old.arm(); const jobId = id();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); await delay(25);
    const fresh = await b.makePage();
    old.ctx.chat.push({ name: 'Character', is_user: false, mes: '저장 완료된 답장', extra: {} });
    old.recovery.tag(1, true); await old.ctx.saveChat(); old.recovery.stop();
    const info = await f.get(jobId);
    await f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: info.bytes }) });
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat[1]?.mes, '저장 완료된 답장');
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal(b.messages.some(m => /만료|재시작/.test(m)), false);
    assert.equal(f.calls.length, 1);
});

test('a durable reply never replaces an edited or independently answered current screen', async t => {
    for (const mode of ['edit', 'new-answer']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f);
        const old = await b.makePage(); old.arm(); const jobId = id();
        await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
        await f.start(jobId, { duration: 10 }); await delay(25);
        const fresh = await b.makePage();
        if (mode === 'edit') fresh.ctx.chat[0].mes = '화면에서 수정한 내용';
        else fresh.ctx.chat.push({ name: 'Character', is_user: false, mes: '다른 답장' });
        const before = JSON.stringify(fresh.ctx.chat);
        old.ctx.chat.push({ name: 'Character', is_user: false, mes: '이미 저장된 답장', extra: {} });
        old.recovery.tag(1, true); await old.ctx.saveChat(); old.recovery.stop();
        const saved = JSON.stringify(b.disk.messages), info = await f.get(jobId);
        await f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: info.bytes }) });
        await fresh.recovery.recover();
        assert.equal(JSON.stringify(fresh.ctx.chat), before);
        assert.equal(JSON.stringify(b.disk.messages), saved);
        assert.equal(fresh.recovery.list().length, 1, 'keep the receipt until the saved chat is actually opened');
        assert.equal(b.rendered.length, 0);
        assert.ok(b.messages.some(m => m.includes('현재 화면의 내용이 달라')));
    }
});

test('legacy lookup displays a saved reply even after its server buffer has been acknowledged', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage('legacy'); old.arm(); const jobId = id();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); await delay(25);
    const app = await b.makePage('persistent', { allowPreviousSession: true });
    old.ctx.chat.push({ name: 'Character', is_user: false, mes: '이전 실행이 저장한 답장', extra: {} });
    old.recovery.tag(1, true); await old.ctx.saveChat(); old.recovery.stop();
    const info = await f.get(jobId);
    await f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: info.bytes }) });
    await app.recovery.recoverPreviousSession();
    assert.equal(app.ctx.chat[1]?.mes, '이전 실행이 저장한 답장');
    assert.equal(b.messages.some(m => /404|410|만료/.test(m)), false);
    assert.equal(f.calls.length, 1);
});

test('manual lookup prefers the current pending reply over an unrelated expired legacy request', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage('legacy'); old.arm();
    await old.recovery.prepare({ id: id(), path: PATH, body: '{"type":"normal"}' }); old.recovery.stop();
    const app = await b.makePage('persistent', { allowPreviousSession: true }); app.arm(); const jobId = id();
    await app.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); app.recovery.stop();
    const fresh = await b.makePage('persistent', { allowPreviousSession: true });
    await fresh.recovery.recoverPreviousSession();
    assert.equal(fresh.ctx.chat[1]?.extra?.[b.MARK]?.id, jobId);
    assert.equal(b.messages.some(m => /404|410|만료/.test(m)), false);
    assert.equal(f.calls.length, 1);
});

test('overlapping settlement and recovery display a durable reply once without replaying message hooks', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    const old = await b.makePage(); old.arm(); const jobId = id();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { duration: 10 }); await delay(25);
    const fresh = await b.makePage();
    old.ctx.chat.push({ name: 'Character', is_user: false, mes: '저장된 답장', extra: {} });
    old.recovery.tag(1, true); await old.ctx.saveChat(); old.recovery.stop();
    await Promise.all([fresh.recovery.settle(), fresh.recovery.recover(), fresh.recovery.settle()]);
    assert.equal(fresh.ctx.chat.length, 2);
    assert.equal(b.rendered.length, 1);
    assert.equal(b.emitted.length, 0);
    assert.equal(fresh.recovery.list().length, 0);
});

function seedSwipes(b) {
    const extra = { translation: '기존 번역', silly_relay: { id: 'a'.repeat(32), complete: true } };
    b.disk.messages.push({ name: 'Character', is_user: false, is_system: false,
        mes: '이전 후보 둘', send_date: '2026-10-07', extra: structuredClone(extra),
        swipe_id: 1, swipes: ['이전 후보 하나', '이전 후보 둘'],
        swipe_info: [{ send_date: '2026-10-06', extra: { reasoning: '예전 생각', translation: '첫 번역' } },
            { send_date: '2026-10-07', extra }] });
}
function armSwipe(page) {
    const last = page.ctx.chat.at(-1);
    last.swipe_id = last.swipes.length;
    page.recovery.generationStarted('swipe'); page.recovery.dataReady({}, false);
}

test('swipe JSON/SSE after full relaunch preserves all original candidates and adds exactly one reply', async t => {
    for (const stream of [false, true]) {
        const f = await fixture(t, { pageBytes: 7 }), b = await recoveryBrowser(t, f); seedSwipes(b);
        const originals = structuredClone(b.disk.messages[1]);
        const page = await b.makePage(); armSwipe(page); const jobId = id();
        assert.equal(await page.recovery.prepare({ id: jobId, path: PATH, body: JSON.stringify({ type: 'swipe', stream }) }), true);
        await f.start(jobId, { stream, duration: 40 }); page.recovery.stop();
        const next = await b.makePage(); await next.recovery.recover();
        const reply = b.disk.messages[1];
        assert.equal(b.disk.messages.length, 2);
        assert.deepEqual(reply.swipes.slice(0, 2), originals.swipes);
        assert.deepEqual(reply.swipe_info.slice(0, 2), originals.swipe_info);
        assert.equal(reply.swipes.length, 3); assert.equal(reply.swipe_id, 2);
        assert.equal(reply.mes, stream ? '안녕 🤍' : '서버가 끝까지 받은 답장 🤍');
        assert.equal(reply.swipe_info[2].extra[b.MARK].id, jobId);
        assert.equal(reply.extra.translation, undefined);
        assert.equal(reply.extra.reasoning, '');
        assert.deepEqual(b.emitted.map(e => e.slice(1)), [[1, 'swipe'], [1, 'swipe']]);
        await (await b.makePage()).recovery.recover();
        assert.equal(b.disk.messages[1].swipes.length, 3);
        assert.equal(f.calls.length, 1);
        assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    }
});

test('partial swipe does not inherit completion of its previous candidate and recovers into its own slot', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f); seedSwipes(b);
    const originals = structuredClone(b.disk.messages[1]);
    const page = await b.makePage(); armSwipe(page); const jobId = id();
    await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"swipe"}' });
    await f.start(jobId, { duration: 20 });
    const last = page.ctx.chat[1]; last.mes = '서버가 끝까'; last.swipes.push(last.mes);
    last.swipe_info.push({ extra: structuredClone(last.extra) });
    page.recovery.tag(1, false);
    assert.equal(last.extra[b.MARK].complete, false);
    await page.ctx.saveChat(); page.recovery.stop();
    const next = await b.makePage(); await next.recovery.recover();
    assert.equal(b.disk.messages[1].swipes.length, 3);
    assert.deepEqual(b.disk.messages[1].swipe_info.slice(0, 2), originals.swipe_info);
    assert.equal(b.disk.messages[1].swipes[2], '서버가 끝까지 받은 답장 🤍');
    assert.equal(f.calls.length, 1);
});

test('swipe recovery refuses edited candidates, unsaved edits, another new candidate and changed history', async t => {
    for (const mode of ['candidate', 'unsaved-edit', 'new-candidate', 'history', 'new-message']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f); seedSwipes(b);
        const page = await b.makePage(); armSwipe(page); const jobId = id();
        await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"swipe"}' });
        await f.start(jobId, { duration: 10 }); page.recovery.stop();
        const last = b.disk.messages[1];
        if (mode === 'candidate') last.swipes[0] = '수정된 첫 후보';
        if (mode === 'new-candidate') { last.swipes.push('다른 요청의 답장'); last.mes = '다른 요청의 답장'; last.swipe_id = 2; }
        if (mode === 'history') b.disk.messages[0].mes = '수정된 기록';
        if (mode === 'new-message') b.disk.messages.push({ name: 'User', is_user: true, mes: '새 메시지' });
        const before = JSON.stringify(b.disk.messages), next = await b.makePage();
        if (mode === 'unsaved-edit') next.ctx.chat[1].mes = '아직 저장 안 된 수정';
        const screen = JSON.stringify(next.ctx.chat);
        await next.recovery.recover();
        assert.equal(JSON.stringify(b.disk.messages), before, mode);
        assert.equal(JSON.stringify(next.ctx.chat), screen, mode);
        assert.equal(b.rendered.length, 0, mode);
        assert.equal(f.calls.length, 1, mode);
    }
});

test('failed swipe save retries without losing candidates or adding a duplicate slot', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f); seedSwipes(b);
    const page = await b.makePage(); armSwipe(page); const jobId = id();
    await page.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"swipe"}' });
    await f.start(jobId, { duration: 10 }); page.recovery.stop();
    const next = await b.makePage(); b.disk.failSave = true; await next.recovery.recover();
    assert.equal(next.ctx.chat[1].swipes.length, 3); assert.equal(b.disk.messages[1].swipes.length, 2);
    b.disk.failSave = false; await next.recovery.recover();
    assert.equal(b.disk.messages[1].swipes.length, 3);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
});

test('live swipe is acknowledged after saving even when another candidate is selected', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f); seedSwipes(b);
    const page = await b.makePage(); armSwipe(page);
    const response = await page.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: '{"type":"swipe","duration":10}' });
    const jobId = response.headers.get('x-silly-relay-job'), data = await response.json();
    const message = page.ctx.chat[1]; message.mes = data.choices[0].message.content;
    message.swipes.push(message.mes); message.swipe_info.push({ extra: {} }); page.recovery.tag(1, true);
    message.swipe_id = 0; message.mes = message.swipes[0]; message.extra = structuredClone(message.swipe_info[0].extra);
    await page.ctx.saveChat(); await page.recovery.settle();
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal(page.ctx.chat[1].swipe_id, 0); assert.equal(b.rendered.length, 0);
});

test('delivered HTTP errors release recovery slots so subsequent replies are admitted', async t => {
    const f = await fixture(t, { perUserJobs: 1 });
    const b = await recoveryBrowser(t, f), page = await b.makePage();
    for (let attempt = 0; attempt < 3; attempt++) {
        page.arm();
        const response = await page.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
            body: '{"type":"normal","error":true,"duration":5}' });
        assert.equal(response.status, 429);
        assert.match(await response.text(), /rate limited/);
        const jobId = response.headers.get('x-silly-relay-job');
        for (let tries = 0; tries < 30 && (await f.request(`/jobs/${jobId}`)).status !== 410; tries++) await delay(5);
        assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
        assert.equal(page.recovery.list().length, 0);
    }
    assert.equal(f.calls.length, 3);
});

test('untyped auxiliary calls cannot consume the main reply recovery ticket', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm();
    assert.equal(await page.recovery.prepare({ id: id(), path: PATH,
        body: JSON.stringify({ model: 'auxiliary', messages: [{ role: 'user', content: '.' }] }) }), false);
    assert.equal(page.recovery.list().length, 0);
    assert.equal(await page.recovery.prepare({ id: id(), path: PATH, body: '{"type":"normal"}' }), true);
});

test('final request event preserves recovery for an untyped main reply and ignores notification metadata', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm();
    const data = { model: 'chat-model', messages: [{ role: 'user', content: 'hello' }] };
    page.recovery.settingsReady(data);
    assert.deepEqual(Object.keys(data), ['model', 'messages']);
    assert.equal(await page.recovery.prepare({ id: id(), path: PATH,
        body: JSON.stringify({ ...data, model: 'auxiliary' }) }), false);
    data.silly_pop_ios = { requestId: id() };
    assert.equal(await page.recovery.prepare({ id: id(), path: PATH, body: JSON.stringify(data) }), true);
});

test('HTTP error recovered after reload is drained and released without writing a chat message', async t => {
    const f = await fixture(t, { perUserJobs: 1, pageBytes: 7 }), b = await recoveryBrowser(t, f);
    const old = await b.makePage(), jobId = id(); old.arm();
    await old.recovery.prepare({ id: jobId, path: PATH, body: '{"type":"normal"}' });
    await f.start(jobId, { error: true, duration: 20 }); old.recovery.stop();
    const fresh = await b.makePage(); await fresh.recovery.recover();
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal(b.disk.messages.length, 1);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.equal((await f.start(id(), { duration: 5 })).status, 202);
});

test('capacity diagnostics distinguish active generations from retained replies', async t => {
    const f = await fixture(t, { perUserActive: 1, perUserJobs: 1 });
    const jobId = id(); await f.start(jobId, { duration: 100 });
    const active = await f.start(id()); assert.equal(active.status, 429);
    assert.match((await active.json()).error, /동시 생성 한도.*1\/1/);
    await delay(150);
    const retained = await f.start(id()); assert.equal(retained.status, 429);
    assert.match((await retained.json()).error, /보관 한도.*1\/1/);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.get(jobId)).state, 'completed');
});



async function replySession(page) {
    const { createReplySessions } = await import('../reply-session.mjs');
    return createReplySessions({ enabled: () => true, recovery: page.recovery, transport: page.transport }).begin();
}
const revisionRequest = (f, session, body) => session.fetch(f.base + PATH, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ type: 'normal', duration: 5, ...body }),
});

test('latest JSON/SSE revision survives a fresh page as one reply; every draft waits for durable save', async t => {
    for (const stream of [false, true]) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const ids = [];
        for (const testReply of ['초안', '첫 수정본', '마지막 수정본 🤍']) {
            const response = await revisionRequest(f, session, { stream, testReply, duration: stream ? 60 : 5 });
            ids.push(response.headers.get('x-silly-relay-job'));
            await response.text();
        }
        assert.equal(page.recovery.list().length, 1);
        assert.equal(page.recovery.list()[0].jobs.length, 3);
        for (const job of ids) assert.equal((await f.request(`/jobs/${job}`)).status, 200);
        page.recovery.stop();
        const fresh = await b.makePage(); b.disk.failSave = true;
        await fresh.recovery.recover();
        assert.equal(fresh.ctx.chat[1].mes, '마지막 수정본 🤍');
        for (const job of ids) assert.equal((await f.request(`/jobs/${job}`)).status, 200);
        b.disk.failSave = false; await fresh.recovery.recover();
        assert.equal(b.disk.messages.length, 2);
        assert.equal(b.disk.messages[1].mes, '마지막 수정본 🤍');
        assert.equal(f.calls.length, 3, 'recovery never generates another answer');
        assert.equal(fresh.recovery.list().length, 0);
        for (const job of ids) assert.equal((await f.request(`/jobs/${job}`)).status, 410);
        await (await b.makePage()).recovery.recover();
        assert.equal(b.disk.messages.length, 2);
    }
});

test('reload waits for submitted revision instead of showing its already completed draft', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    await (await revisionRequest(f, session, { testReply: '초안' })).text();
    const pending = revisionRequest(f, session, { stream: true, testReply: '아직 작성 중인 수정본', duration: 200 });
    const response = await pending;
    page.recovery.stop();
    const fresh = await b.makePage();
    const recovering = fresh.recovery.recover();
    await delay(40);
    assert.equal(b.rendered.length, 0);
    await recovering;
    assert.equal(b.disk.messages[1].mes, '아직 작성 중인 수정본');
    assert.equal(response.status, 200);
    assert.equal(f.calls.length, 2);
});

test('failed or empty rewrite falls back to last readable candidate; selected guard fallback is respected', async t => {
    for (const failure of ['http', 'empty', 'selected']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const good = await revisionRequest(f, session, { testReply: '보존할 답장' }); await good.text();
        const bad = await revisionRequest(f, session, failure === 'http' ? { error: true }
            : { testReply: failure === 'empty' ? '' : '검수에서 선택하지 않은 결과' }); await bad.text();
        if (failure === 'selected') session.complete(good);
        page.recovery.stop();
        await (await b.makePage()).recovery.recover();
        assert.equal(b.disk.messages[1]?.mes, '보존할 답장', failure);
        assert.equal(f.calls.length, 2);
    }
});

test('revision session keeps helpers out, preserves payloads and selects the guard final response', async t => {
    const f = await fixture(t, { perUserActive: 1 }), b = await recoveryBrowser(t, f), page = await b.makePage();
    const { createTransport } = await import('../transport.mjs');
    const { createReplySessions } = await import('../reply-session.mjs');
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch,
        shouldRelay: () => false, prepareRecovery: data => page.recovery.prepare(data),
        onEvent: (type, data) => page.recovery.event(type, data) });
    page.arm(); const sessions = createReplySessions({ enabled: () => true, recovery: page.recovery, transport });
    const session = sessions.begin();
    assert.equal(sessions.begin(), null, 'one session per native reply');
    const helpers = Array.from({ length: 5 }, (_, i) => transport.fetch(f.base + PATH,
        { method: 'POST', headers: AUTH, body: JSON.stringify({ testReply: `judge ${i}`, duration: 80 }) }).then(r => r.text()));
    const draft = await revisionRequest(f, session, { testReply: 'draft' }); await draft.text();
    const rewritten = await revisionRequest(f, session, { type: 'quiet', testReply: 'final', messages: [{ role: 'user', content: 'unchanged' }] });
    await rewritten.text(); session.complete(rewritten); await Promise.all(helpers);
    assert.equal(page.recovery.list().length, 1); assert.equal(page.recovery.list()[0].jobs.length, 2);
    assert.equal(page.recovery.list()[0].jobId, rewritten.headers.get('x-silly-relay-job'));
    page.ctx.chat.push({ name: 'Character', is_user: false, mes: 'final' });
    page.recovery.tag(1, true); await page.ctx.saveChat(); await page.recovery.settle();
    assert.equal(page.recovery.list().length, 0);
    assert.equal(f.calls.length, 7);
    assert.equal(f.calls.at(-1).body.messages[0].content, 'unchanged');
    assert.equal(f.calls.at(-1).body.type, 'quiet');
    await assert.rejects(() => revisionRequest(f, session, { testReply: 'too late' }));
});

test('cancelled revision sequence never restores its draft; unrelated chat edits remain protected', async t => {
    for (const action of ['cancel', 'edit']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        await (await revisionRequest(f, session, { testReply: 'draft' })).text();
        await (await revisionRequest(f, session, { testReply: 'final' })).text();
        if (action === 'cancel') session.cancel();
        else b.disk.messages[0].mes = '사용자 수정';
        page.recovery.stop(); await (await b.makePage()).recovery.recover();
        assert.equal(b.disk.messages.length, 1);
        if (action === 'edit') assert.equal(b.disk.messages[0].mes, '사용자 수정');
    }
});

test('latest rewritten swipe keeps every prior candidate and metadata unchanged', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f); seedSwipes(b);
    const previous = structuredClone(b.disk.messages[1]);
    const page = await b.makePage(); armSwipe(page); const session = await replySession(page);
    await (await revisionRequest(f, session, { type: 'swipe', testReply: 'new draft' })).text();
    await (await revisionRequest(f, session, { type: 'quiet', testReply: 'last revised swipe' })).text();
    page.recovery.stop(); await (await b.makePage()).recovery.recover();
    const message = b.disk.messages[1];
    assert.equal(message.mes, 'last revised swipe');
    assert.equal(message.swipes.length, 3);
    assert.deepEqual(message.swipes.slice(0, 2), previous.swipes);
    assert.deepEqual(message.swipe_info.slice(0, 2), previous.swipe_info);
});

test('reply session preserves intervening fetch wrappers when forwarding a scoped request', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    let calls = 0;
    const wrapper = (input, init) => { calls++; return page.transport.fetch(input, { ...init }); };
    const response = await session.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: JSON.stringify({ type: 'quiet', testReply: 'rewritten', duration: 5 }) }, wrapper);
    await response.text(); session.complete(response);
    assert.equal(calls, 1);
    assert.ok(response.headers.get('x-silly-relay-job'));
    assert.equal(page.recovery.list().length, 1);
    assert.equal(page.recovery.list()[0].finalized, true);
});

test('a sequence with no readable candidate releases its buffers without inventing a reply', async t => {
    for (const error of [true, false]) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const response = await revisionRequest(f, session, { error, testReply: '' });
        session.complete(response);
        await response.text(); page.recovery.generationEnded();
        await page.recovery.recover();
        assert.equal(b.disk.messages.length, 1);
        assert.equal(page.recovery.list().length, 0);
        // Live HTTP-error receipts are sent asynchronously after the body EOF.
        let status;
        const deadline = Date.now() + 2000;
        do {
            status = (await f.request(`/jobs/${response.headers.get('x-silly-relay-job')}`)).status;
            if (status === 410) break;
            await delay(10);
        } while (Date.now() < deadline);
        assert.equal(status, 410);
    }
});

test('nested quiet helper cannot consume the pending native reply recovery session', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm();
    page.recovery.generationStarted('quiet'); page.recovery.dataReady({}, false);
    assert.equal(await replySession(page), null);
    page.recovery.generationEnded();
    const session = await replySession(page);
    assert.ok(session);
    const response = await revisionRequest(f, session, { testReply: 'main survives helper' });
    await response.text(); session.complete(response);
    page.recovery.stop(); await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages[1].mes, 'main survives helper');
});
