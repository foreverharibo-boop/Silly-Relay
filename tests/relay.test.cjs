'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { createRelay } = require('../server/index.cjs');
const { createJournal } = require('../server/diagnostics.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const pathModule = require('node:path');
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
            if (network.dropGeneration) { req.socket.destroy(); return; }
            if (network.abortResponse) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.write('{"partial":');
                setTimeout(() => res.destroy(), 20);
                return;
            }
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

test('internal generation does not reconstruct a configured global agent with empty options', async t => {
    // ST replaces http.globalAgent with PrivateRequestAgent or ProxyAgent.
    // Node's agent:false constructs that class AGAIN, without its options.
    // Model the private filter: configured loopback is allowed, defaults deny it.
    let emptyAgentConstructions = 0;
    class ConfiguredAgent extends http.Agent {
        constructor(options = {}) {
            super(options);
            this.allowSelf = options.allowSelf === true;
            if (!this.allowSelf) emptyAgentConstructions++;
        }
        createConnection(options, callback) {
            if (this.allowSelf) return super.createConnection(options, callback);
            process.nextTick(callback, new Error('Blocked request to private IP address'));
        }
    }
    const f = await fixture(t);
    const originalAgent = http.globalAgent;
    const configured = new ConfiguredAgent({ allowSelf: true });
    http.globalAgent = configured;
    t.after(() => { http.globalAgent = originalAgent; configured.destroy(); });
    const jobId = id();
    await f.start(jobId, { duration: 10 });
    let result;
    for (let i = 0; i < 50; i++) {
        result = await f.get(jobId);
        if (result.state !== 'running') break;
        await delay(10);
    }
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(emptyAgentConstructions, 0);
    assert.equal(http.globalAgent, configured, 'external AI routing stays unchanged');
});

test('exported server diagnostics distinguish connection reset, response abort and timeout', async t => {
    for (const [network, timeoutMs, expectedReason, expectedPhase] of [
        [{ dropGeneration: true }, 1000, 'connection_error', 'connected'],
        [{ abortResponse: true }, 1000, 'response_aborted', 'body'],
        [{}, 30, 'timeout', 'connected'],
    ]) {
        const directory = await fs.mkdtemp(pathModule.join(os.tmpdir(), 'relay-network-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const journal = createJournal({ directory });
        const f = await fixture(t, { journal, timeoutMs }, network);
        const jobId = id();
        await f.start(jobId, { duration: 200 });
        let job;
        for (let i = 0; i < 100; i++) {
            job = await f.get(jobId);
            if (job.state !== 'running') break;
            await delay(10);
        }
        assert.equal(job.state, 'failed');
        const report = await (await f.request('/diagnostics')).json();
        const rows = report.events.filter(row => row.id === jobId);
        const failed = rows.find(row => row.stage === 'failed');
        assert.equal(failed.reason, expectedReason);
        assert.equal(failed.phase, expectedPhase);
        assert.equal(failed.targetKind, 'loopback_ipv4');
        assert.equal(failed.requestFinished, true);
        assert.ok(failed.elapsedMs >= 0);
        assert.equal(rows.filter(row => row.stage === 'failed').length, 1);
        assert.ok(rows.some(row => row.stage === 'upstream_connected'));
        if (network.dropGeneration) assert.equal(failed.errorCode, 'ECONNRESET');
        if (expectedReason === 'timeout') assert.equal(failed.errorCode, 'ETIMEDOUT');
        if (network.abortResponse) assert.equal(failed.status, 200);
    }
});

test('synchronous internal request setup failure is recorded and does not retain an active job', async t => {
    const rows = [];
    const f = await fixture(t, { perUserActive: 1, journal: { record: (owner, stage, id, data) => rows.push({ stage, id, ...data }), flush() {} } });
    const originalRequest = http.request;
    t.after(() => { http.request = originalRequest; });
    http.request = () => { throw Object.assign(new Error('SECRET_HEADER'), { code: 'ERR_INVALID_CHAR' }); };
    const jobId = id();
    await f.start(jobId);
    http.request = originalRequest;
    const job = await f.get(jobId);
    assert.equal(job.state, 'failed');
    assert.equal(rows.find(row => row.stage === 'failed').errorCode, 'ERR_INVALID_CHAR');
    assert.equal(rows.find(row => row.stage === 'failed').reason, 'request_setup_error');
    assert.doesNotMatch(JSON.stringify(rows), /SECRET_HEADER/);
    assert.equal((await f.start(id(), { duration: 10 })).status, 202);
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

test('recovery does not promise an earlier answer when the first request was rejected', async t => {
    const f = await fixture(t, { perUserActive: 0 }), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    await assert.rejects(() => revisionRequest(f, session, { testReply: 'never generated' }), { httpStatus: 429 });
    page.recovery.stop();
    const fresh = await b.makePage(); await fresh.recovery.recover({ manual: true });
    assert.equal(f.calls.length, 0);
    assert.equal(b.disk.messages.length, 1);
    assert.equal(b.rendered.length, 0);
    assert.ok([...b.messages, ...b.diagnostics].some(text => /429/.test(text)), 'preserve the actual rejection status');
    assert.ok(!b.messages.some(text => /이전 답장을 확인/.test(text)), 'do not imply that a previous draft exists');
});

test('recovery checks server truth after a read error instead of discarding a completed reply', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const response = await revisionRequest(f, session, { testReply: 'server still has this answer' });
    await response.text();
    const jobId = response.headers.get('x-silly-relay-job');
    session.complete(response);
    page.recovery.event('error', { id: jobId, httpStatus: 503 });
    page.recovery.stop();
    const fresh = await b.makePage(); await fresh.recovery.recover();
    assert.equal(b.disk.messages[1]?.mes, 'server still has this answer');
    assert.equal(f.calls.length, 1);
    assert.equal(fresh.recovery.list().length, 0);
});

test('a missing latest revision does not hide the preceding retained reply', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const good = await revisionRequest(f, session, { testReply: 'retained original' });
    await good.text();
    const latest = await revisionRequest(f, session, { testReply: 'latest' });
    await latest.text();
    const missingId = latest.headers.get('x-silly-relay-job');
    page.recovery.stop();
    const fresh = await b.makePage('same-tab', { confirmUnreviewed: async () => true, api: (path, init) => {
        if (path.startsWith(`/jobs/${missingId}`)) return Promise.reject(Object.assign(new Error('missing'), { httpStatus: 404 }));
        return page.transport.api(path, init);
    } });
    await fresh.recovery.recover();
    assert.equal(b.disk.messages.length, 1);
    assert.equal(fresh.recovery.list()[0].finalized, false);
    await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(b.disk.messages[1]?.mes, 'retained original');
    assert.equal(f.calls.length, 2);
    assert.equal(fresh.recovery.list().length, 0);
});

test('a decoding failure retains the response and journal until recovery can read it', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const good = await revisionRequest(f, session, { testReply: 'keep undecoded reply' }); await good.text();
    const jobId = good.headers.get('x-silly-relay-job');
    session.complete(good);
    page.recovery.stop();
    const broken = await b.makePage('same-tab', { parser: async () => ({ extract() { throw Error('parser unavailable'); } }) });
    await broken.recovery.recover();
    assert.equal(b.disk.messages.length, 1);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 200, 'an unreadable response is not a saved reply receipt');
    assert.equal(broken.recovery.list().length, 1, 'keep recovery binding for a later attempt');
    broken.recovery.stop();
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages[1]?.mes, 'keep undecoded reply');
    assert.equal(f.calls.length, 1);
});

test('an extractor returning empty text must not erase a nonempty retained response', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const response = await revisionRequest(f, session, { testReply: 'nonempty server answer' }); await response.text();
    const jobId = response.headers.get('x-silly-relay-job'); session.complete(response); page.recovery.stop();
    const fresh = await b.makePage('same-tab', { parser: async () => ({ extract: () => '' }) });
    await fresh.recovery.recover();
    assert.equal(b.disk.messages.length, 1);
    assert.equal(fresh.recovery.list().length, 1);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 200);
    fresh.recovery.stop();
    await (await b.makePage()).recovery.recover();
    assert.equal(b.disk.messages[1]?.mes, 'nonempty server answer');
    assert.equal(f.calls.length, 1);
});
const revisionRequest = (f, session, body) => session.fetch(f.base + PATH, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ type: 'normal', duration: 5, ...body }),
});

async function recoverableReview(page, f, after) {
    const { createReplySessions } = await import('../reply-session.mjs');
    const sessions = createReplySessions({ enabled: () => true, recovery: page.recovery, transport: page.transport });
    page.arm();
    if (after) sessions.expectReview('hundredlog', { facts: ['frozen fact'], mode: 'normal' });
    const session = sessions.begin({ owner: 'ttotto', checkpoint: { attempt: 0, rule: 'frozen ban' } });
    const response = await revisionRequest(f, session, { testReply: 'Retained draft' }); await response.text();
    return { sessions, session, response, jobId: response.headers.get('x-silly-relay-job') };
}

test('review snapshots are account isolated, temporary, bounded and absent from the browser journal', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    const h = await recoverableReview(page, f, true);
    const info = await (await f.request(`/jobs/${h.jobId}/recovery`)).json();
    assert.equal(info.current.owner, 'ttotto'); assert.equal(info.after.owner, 'hundredlog');
    assert.equal(info.current.checkpoint.rule, 'frozen ban');
    assert.equal(JSON.parse(info.body).testReply, 'Retained draft');
    assert.doesNotMatch(JSON.stringify(page.recovery.list()), /frozen ban|frozen fact|Retained draft/);
    assert.equal((await f.request(`/jobs/${h.jobId}/recovery`, { headers: { cookie: 'user=bob' } })).status, 404);
    await f.request(`/jobs/${h.jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: (await f.get(h.jobId)).bytes }) });
    assert.equal((await f.request(`/jobs/${h.jobId}/recovery`)).status, 409);
    const oversized = { version: 1, current: { owner: 'ttotto', checkpoint: { huge: 'x'.repeat(512 * 1024) } } };
    assert.equal((await f.request('/jobs', { method: 'POST', body: JSON.stringify({ id: id(), path: PATH, body: '{}', recovery: oversized }) })).status, 413);
    assert.equal(f.calls.length, 1);
});

for (const rewrite of [false, true]) test(`resumable transport review restores its selected reply without regenerating the original, rewrite=${rewrite}`, async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const h = await recoverableReview(old, f); old.recovery.stop();
    let fresh, resumes = 0;
    fresh = await b.makePage('same-tab', { resumeReview: async data => {
        resumes++; assert.equal(data.checkpoint.checkpoint.rule, 'frozen ban');
        const { createReplySessions } = await import('../reply-session.mjs');
        const session = createReplySessions({ enabled: () => true, recovery: fresh.recovery, transport: fresh.transport }).resume(data.record, data.context);
        const response = rewrite ? await revisionRequest(f, session, { testReply: 'Approved rewrite' })
            : new Response(data.raw, { headers: { 'x-silly-relay-job': data.record.jobId } });
        if (rewrite) await response.text();
        session.complete(response); return { resumed: true };
    } });
    await fresh.recovery.recover();
    assert.equal(resumes, 1); assert.equal(b.disk.messages[1].mes, rewrite ? 'Approved rewrite' : 'Retained draft');
    assert.equal(f.calls.length, rewrite ? 2 : 1);
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal((await f.request(`/jobs/${h.jobId}`)).status, 410);
});

for (const rewrite of [false, true]) test(`transport review then message review resumes in order and displays only the final reply, rewrite=${rewrite}`, async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const h = await recoverableReview(old, f, true); old.recovery.stop();
    const stages = [], displayed = []; let fresh;
    fresh = await b.makePage('same-tab', { resumeReview: async data => {
        stages.push(data.checkpoint.owner);
        if (data.checkpoint.owner === 'ttotto') {
            const sequence = fresh.recovery.resumeSequence(data.record, data.context);
            fresh.recovery.completeSequence(sequence, data.record.jobId); return { resumed: true };
        }
        return { postprocess: async (index, message) => {
            assert.equal(displayed.length, 0, 'pending semantic draft must stay off screen');
            const sequence = fresh.recovery.beginReview(index, message, new AbortController().signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            assert.ok(sequence);
            if (rewrite) {
                const response = await fresh.transport.replyFetch(f.base + PATH, { method: 'POST', headers: AUTH,
                    body: JSON.stringify({ type: 'quiet', duration: 5, testReply: 'Continuity corrected' }) }, sequence);
                const text = (await response.json()).choices[0].message.content;
                fresh.recovery.acceptReview(sequence, text); message.mes = text;
            }
            fresh.recovery.completeReview(sequence, message);
        } };
    } });
    fresh.ctx.addOneMessage = message => displayed.push(message.mes);
    fresh.ctx.updateMessageBlock = () => {};
    fresh.ctx.eventSource.emit = async (type, index) => {
        if (type === 'received') fresh.ctx.chat[index].extra.display_text = '기존 번역 재사용';
    };
    await fresh.recovery.recover();
    assert.deepEqual(stages, ['ttotto', 'hundredlog']);
    assert.deepEqual(displayed, [rewrite ? 'Continuity corrected' : 'Retained draft']);
    assert.equal(b.disk.messages[1].extra.display_text, '기존 번역 재사용');
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal(f.calls.length, rewrite ? 2 : 1);
    assert.equal((await f.request(`/jobs/${h.jobId}`)).status, 410);
});

test('an unavailable reviewer retains candidates and can resume after its extension finishes loading', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const h = await recoverableReview(old, f); old.recovery.stop(); let ready = false, fresh;
    fresh = await b.makePage('same-tab', { resumeReview: async data => {
        if (!ready) return null;
        fresh.recovery.completeSequence(fresh.recovery.resumeSequence(data.record, data.context), data.record.jobId);
        return { resumed: true };
    } });
    await fresh.recovery.recover(); assert.equal(b.disk.messages.length, 1);
    assert.equal((await f.request(`/jobs/${h.jobId}`)).status, 200);
    ready = true; await fresh.recovery.recover();
    assert.equal(b.disk.messages[1].mes, 'Retained draft'); assert.equal(f.calls.length, 1);
});

test('native reply declares a future message review before its request, even without a transport guard', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const { createReplySessions } = await import('../reply-session.mjs');
    old.arm();
    createReplySessions({ enabled: () => true, recovery: old.recovery, transport: old.transport }).expectReview('hundredlog', { facts: ['original fact'] });
    const response = await old.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: JSON.stringify({ type: 'normal', duration: 5, testReply: 'Native retained' }) });
    await response.text(); old.recovery.stop(); let fresh;
    fresh = await b.makePage('same-tab', { resumeReview: async data => {
        assert.equal(data.checkpoint.owner, 'hundredlog');
        return { postprocess: async (index,message) => {
            const review = fresh.recovery.beginReview(index,message,new AbortController().signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            assert.ok(review); fresh.recovery.completeReview(review,message);
        } };
    } });
    await fresh.recovery.recover();
    assert.equal(b.disk.messages[1].mes, 'Native retained');
    assert.equal(fresh.recovery.list().length, 0); assert.equal(f.calls.length, 1);
});

for (const rewrite of [false, true]) for (const savedDraft of [false, true])
test(`an interrupted message review reopens its own pending journal, rewrite=${rewrite}, savedDraft=${savedDraft}`, async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const h = await recoverableReview(old, f, true); h.session.complete(h.response);
    const message = { name: 'Character', is_user: false, mes: 'Retained draft', swipes: ['Retained draft'], swipe_id: 0,
        extra: {}, swipe_info: [{ extra: {} }] };
    old.ctx.chat.push(message);
    const checkpoint = { facts: ['frozen fact'], mode: 'normal' };
    const sequence = old.recovery.beginReview(1,message,new AbortController().signal,{ owner: 'hundredlog',checkpoint });
    assert.ok(sequence);
    if (savedDraft) await old.ctx.saveChat();
    if (rewrite) {
        const response = await old.transport.replyFetch(f.base + PATH, { method: 'POST', headers: AUTH,
            body: JSON.stringify({ type: 'quiet', duration: 5, testReply: 'Already rewritten' }) },sequence);
        await response.text();
    }
    old.recovery.stop(); let fresh;
    fresh = await b.makePage('same-tab', { resumeReview: async data => {
        assert.equal(data.checkpoint.owner,'hundredlog');
        return { postprocess: async (index,candidate) => {
            const resumed = fresh.recovery.beginReview(index,candidate,new AbortController().signal,
                { owner: 'hundredlog',checkpoint:data.checkpoint.checkpoint,resuming:true });
            assert.ok(resumed,'the interrupted review must be adoptable after reload');
            fresh.recovery.completeReview(resumed,candidate);
        } };
    } });
    await fresh.recovery.recover();
    assert.equal(b.disk.messages[1].mes,rewrite?'Already rewritten':'Retained draft');
    assert.equal(fresh.recovery.list().length,0); assert.equal(f.calls.length,rewrite?2:1);
});

test('missing review context does not delete a completed answer and still permits explicit manual recovery', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const h = await recoverableReview(old, f); old.recovery.stop();
    const fresh = await b.makePage('same-tab', { api: (path, init) => path.endsWith('/recovery')
        ? Promise.reject(Object.assign(Error('old server'), { httpStatus: 404 })) : old.transport.api(path, init),
        confirmUnreviewed: async () => true });
    await fresh.recovery.recover(); assert.equal(fresh.recovery.list().length, 1);
    assert.equal((await f.request(`/jobs/${h.jobId}`)).status, 200);
    await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(b.disk.messages[1].mes, 'Retained draft'); assert.equal(f.calls.length, 1);
});

test('an oversized optional snapshot cannot suppress or duplicate the original generation', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t,f), page = await b.makePage();
    const { createReplySessions } = await import('../reply-session.mjs'); page.arm();
    const session = createReplySessions({ enabled: () => true, recovery: page.recovery, transport: page.transport })
        .begin({ owner: 'ttotto', checkpoint: { rules: 'x'.repeat(512 * 1024) } });
    const response = await revisionRequest(f,session,{testReply:'Original still delivered'});
    assert.equal((await response.json()).choices[0].message.content,'Original still delivered');
    assert.equal(f.calls.length,1); assert.equal(page.recovery.list().length,0);
});

test('a second interruption during message review preserves the saved draft anchor and leaves no hidden phantom reply', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t,f), old = await b.makePage();
    const h = await recoverableReview(old,f,true); h.session.complete(h.response);
    const message = { name:'Character',is_user:false,mes:'Retained draft',swipes:['Retained draft'],swipe_id:0,extra:{},swipe_info:[{extra:{}}] };
    old.ctx.chat.push(message);
    const checkpoint={facts:['original fact'],mode:'normal'};
    const review=old.recovery.beginReview(1,message,new AbortController().signal,{owner:'hundredlog',checkpoint});
    await old.ctx.saveChat();
    const correction=await old.transport.replyFetch(f.base+PATH,{method:'POST',headers:AUTH,
        body:JSON.stringify({type:'quiet',duration:5,testReply:'Retained correction'})},review);await correction.text();old.recovery.stop();
    let page,interrupt=true;
    const resumeReview=async data=>({postprocess:async(index,candidate)=>{
        const resumed=page.recovery.beginReview(index,candidate,new AbortController().signal,
            {owner:'hundredlog',checkpoint:data.checkpoint.checkpoint,resuming:true});assert.ok(resumed);
        if(interrupt)throw Error('another page interruption');
        page.recovery.completeReview(resumed,candidate);
    }});
    page=await b.makePage('same-tab',{resumeReview});await page.recovery.recover();
    assert.equal(page.ctx.chat[1].mes,'Retained draft','unrendered provisional candidate is rolled back');
    assert.equal(b.disk.messages[1].mes,'Retained draft');page.recovery.stop();
    interrupt=false;page=await b.makePage('same-tab',{resumeReview});await page.recovery.recover();
    assert.equal(b.disk.messages[1].mes,'Retained correction');assert.equal(page.recovery.list().length,0);
    assert.equal(f.calls.length,2);
});

test('selected JSON/SSE revision survives a fresh page as one reply; every draft waits for durable save', async t => {
    for (const stream of [false, true]) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const ids = []; let selected;
        for (const testReply of ['초안', '첫 수정본', '마지막 수정본 🤍']) {
            const response = await revisionRequest(f, session, { stream, testReply, duration: stream ? 60 : 5 });
            selected = response;
            ids.push(response.headers.get('x-silly-relay-job'));
            await response.text();
        }
        assert.equal(page.recovery.list().length, 1);
        assert.equal(page.recovery.list()[0].jobs.length, 3);
        session.complete(selected);
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

test('reload waits for submitted revision and holds it for explicit acceptance', async t => {
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
    assert.equal(b.disk.messages.length, 1);
    const manual = await b.makePage('same-tab', { confirmUnreviewed: async () => true });
    await manual.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(b.disk.messages[1].mes, '아직 작성 중인 수정본');
    assert.equal(response.status, 200);
    assert.equal(f.calls.length, 2);
});

test('unselected fallback requires acceptance; explicitly selected guard fallback is automatic', async t => {
    for (const failure of ['http', 'empty', 'selected']) {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const good = await revisionRequest(f, session, { testReply: '보존할 답장' }); await good.text();
        const bad = await revisionRequest(f, session, failure === 'http' ? { error: true }
            : { testReply: failure === 'empty' ? '' : '검수에서 선택하지 않은 결과' }); await bad.text();
        if (failure === 'selected') session.complete(good);
        page.recovery.stop();
        const fresh = await b.makePage('same-tab', { confirmUnreviewed: async () => true });
        await fresh.recovery.recover();
        if (failure !== 'selected') {
            assert.equal(b.disk.messages.length, 1, failure);
            await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
        }
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
    const final = await revisionRequest(f, session, { type: 'quiet', testReply: 'last revised swipe' });
    await final.text(); session.complete(final);
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

async function reviewedReply(t, { ttotto = false, mode = 'normal', stream = false, saveDraft = false, unfilledSwipe = false } = {}) {
    const f = await fixture(t), b = await recoveryBrowser(t, f);
    if (mode === 'swipe') seedSwipes(b);
    const page = await b.makePage();
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const { createReplySessions } = await import('../reply-session.mjs');
    const { createTransport } = await import('../transport.mjs');
    const filter = createReplyFilter();
    const transport = createTransport({ origin: f.base, enabled: () => true, fetchImpl: fetch,
        shouldRelay: filter.take, prepareRecovery: data => page.recovery.prepare(data),
        onEvent: (type, data) => page.recovery.event(type, data) });
    const sessions = createReplySessions({ enabled: () => true, recovery: page.recovery, transport,
        consume: filter.consume, captureQuiet: filter.captureQuiet });
    if (mode === 'swipe') armSwipe(page); else page.arm();
    filter.generationStarted(mode);
    const prompt = [{ role: 'user', content: 'native reply' }]; filter.dataReady({ prompt });
    const body = { type: mode, messages: prompt.filter(Boolean), duration: stream ? 60 : 5, stream, testReply: 'native draft' };
    filter.settingsReady(body); page.recovery.settingsReady(body);
    const send = (fetcher, data) => fetcher(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(data) });
    let response, text = 'native draft';
    if (ttotto) {
        const session = sessions.begin();
        await (await send(session.fetch, body)).text();
        text = 'ttotto revised draft';
        response = await send(session.fetch, { ...body, testReply: text }); await response.text(); session.complete(response);
    } else { response = await send(transport.fetch, body); await response.text(); }
    let message;
    if (mode === 'swipe') {
        message = page.ctx.chat.at(-1); message.mes = text;
        // Non-streaming ST invokes received hooks with an unfilled new slot
        // and the previous candidate's top-level extra still on the message.
        if (unfilledSwipe) message.swipes.length++;
        else { message.swipes.push(text); message.swipe_info.push({ extra: {} }); }
    } else {
        message = { name: 'Character', is_user: false, mes: text, send_date: 'native-date',
            extra: {}, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] };
        page.ctx.chat.push(message);
    }
    if (saveDraft) { page.recovery.tag(page.ctx.chat.length - 1, true); await page.ctx.saveChat(); }
    if (stream) { filter.generationEnded(); page.recovery.generationEnded(); }
    const controller = new AbortController();
    const review = sessions.beginReview(page.ctx.chat.length - 1, message, controller.signal);
    assert.ok(review);
    async function quiet(promptText, testReply, extras = {}) {
        filter.generationStarted('quiet', { quiet_prompt: promptText });
        page.recovery.generationStarted('quiet', { quiet_prompt: promptText });
        const prompt = [{ role: 'user', content: promptText }];
        filter.dataReady({ prompt }); page.recovery.dataReady({}, false);
        const body = { type: 'quiet', messages: prompt.filter(Boolean), testReply, duration: 5, ...extras };
        filter.settingsReady(body);
        try {
            const response = await send(transport.fetch, body);
            const raw = await response.text();
            if (!response.ok) throw Error('rewrite failed');
            if (body.stream) return JSON.parse(raw.split('\n\n')[0].slice(6)).choices[0].delta.content;
            return JSON.parse(raw).choices[0].message.content;
        } finally { filter.generationEnded(); page.recovery.generationEnded(); }
    }
    const publish = text => {
        message.mes = text; message.swipes[message.swipe_id] = text;
        review.completeMessage(message);
    };
    return { f, b, page, filter, transport, sessions, review, controller, message, quiet, publish };
}

for (const ttotto of [false, true]) for (const stream of [false, true]) for (const mode of ['normal', 'swipe']) {
    test(`100LOG final rewrite restores once: ttotto=${ttotto}, stream=${stream}, mode=${mode}`, async t => {
        const h = await reviewedReply(t, { ttotto, stream, mode, saveDraft: true });
        const before = structuredClone(h.b.disk.messages);
        const final = await h.review.capture('100LOG correction', () => h.quiet('100LOG correction', '100LOG final answer'));
        assert.equal(final, '100LOG final answer');
        assert.equal(h.page.recovery.list().length, 1);
        assert.equal(h.page.recovery.list()[0].jobs.length, ttotto ? 3 : 2);
        await h.page.recovery.settle();
        for (const job of h.page.recovery.list()[0].jobs) assert.equal((await h.f.request(`/jobs/${job.id}`)).status, 200);
        h.publish(final);
        h.page.recovery.stop();
        const fresh = await h.b.makePage(); await fresh.recovery.recover();
        assert.equal(h.b.disk.messages.length, 2);
        assert.equal(h.b.disk.messages[1].mes, '100LOG final answer');
        if (mode === 'swipe') {
            assert.deepEqual(h.b.disk.messages[1].swipes.slice(0, 2), before[1].swipes.slice(0, 2));
            assert.deepEqual(h.b.disk.messages[1].swipe_info.slice(0, 2), before[1].swipe_info.slice(0, 2));
            assert.equal(h.b.disk.messages[1].swipes.length, 3);
        }
        assert.equal(fresh.recovery.list().length, 0);
        await (await h.b.makePage()).recovery.recover();
        assert.equal(h.b.disk.messages.length, 2); assert.equal(h.f.calls.length, ttotto ? 3 : 2);
    });
}

test('100LOG scope excludes memory/JEV/translation helpers and clears its permission', async t => {
    const h = await reviewedReply(t);
    const result = await h.review.capture('actual correction', async () => {
        await h.quiet('collect memories', 'memory result');
        await h.quiet('judge conflicts', 'judge result');
        const result = await h.quiet('actual correction', 'revised character reply');
        await h.quiet('translate', 'translation result');
        return result;
    });
    assert.equal(h.page.recovery.list()[0].jobs.length, 2);
    await h.quiet('actual correction', 'outside scope');
    assert.equal(h.page.recovery.list()[0].jobs.length, 2);
    h.publish(result); await h.page.ctx.saveChat(); await h.page.recovery.settle();
    assert.equal(h.b.disk.messages[1].mes, 'revised character reply');
    assert.equal(h.page.recovery.list().length, 0); assert.equal(h.f.calls.length, 6);
});

test('100LOG pass or failed rewrite keeps the exact selected Ttotto answer', async t => {
    for (const fail of [false, true]) {
        const h = await reviewedReply(t, { ttotto: true, stream: true });
        if (fail) await assert.rejects(() => h.review.capture('correction', () => h.quiet('correction', '', { error: true })));
        h.publish(h.message.mes);
        h.page.recovery.stop(); await (await h.b.makePage()).recovery.recover();
        assert.equal(h.b.disk.messages[1].mes, 'ttotto revised draft');
    }
});

test('100LOG retry keeps one logical reply and selects the successful rewrite', async t => {
    const h = await reviewedReply(t);
    await assert.rejects(() => h.review.capture('correction', () => h.quiet('correction', '', { error: true })));
    const text = await h.review.capture('correction', () => h.quiet('correction', 'successful retry'));
    h.publish(text); h.page.recovery.stop(); await (await h.b.makePage()).recovery.recover();
    assert.equal(h.b.disk.messages[1].mes, 'successful retry'); assert.equal(h.f.calls.length, 3);
});

test('100LOG stop cancels active rewrite and prevents late recovery; manual edit remains protected', async t => {
    const h = await reviewedReply(t, { saveDraft: true });
    let accepted;
    const ready = new Promise(resolve => { accepted = resolve; });
    const pending = h.review.capture('correction', async () => {
        const task = h.quiet('correction', 'late text', { stream: true, duration: 400 });
        while (h.page.recovery.list()[0]?.jobs.length < 2) await delay(5);
        while (h.f.calls.length < 2) await delay(5);
        accepted(); return task;
    });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready; h.controller.abort(); h.review.cancel(); await rejected;
    h.page.recovery.stop(); await (await h.b.makePage()).recovery.recover();
    assert.equal(h.b.disk.messages[1].mes, 'native draft');
    await delay(30); assert.equal(h.f.calls[1].cancelled, true);
    const edited = await reviewedReply(t, { saveDraft: true });
    await edited.review.capture('correction', () => edited.quiet('correction', 'must not overwrite edit'));
    edited.b.disk.messages[1].mes = 'manual edit'; edited.page.recovery.stop();
    await (await edited.b.makePage('same-tab', { confirmUnreviewed: async () => true })).recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(edited.b.disk.messages[1].mes, 'manual edit');
});

test('100LOG cannot adopt an unrelated message or a message with no pending relay record', async t => {
    const h = await reviewedReply(t);
    assert.equal(h.sessions.beginReview(1, { ...h.message }), null);
    h.review.cancel(); assert.equal(h.sessions.beginReview(1, h.message), null);
});

test('100LOG swipe adoption works before the native receive hook tags or saves the new slot', async t => {
    for (const ttotto of [false, true]) {
        const h = await reviewedReply(t, { mode: 'swipe', ttotto, saveDraft: false, unfilledSwipe: true });
        const final = await h.review.capture('correction', () => h.quiet('correction', 'unsaved revised swipe'));
        h.publish(final);
        h.page.recovery.stop(); await (await h.b.makePage()).recovery.recover();
        assert.equal(h.b.disk.messages[1].mes, 'unsaved revised swipe');
        assert.equal(h.b.disk.messages[1].swipes.length, 3);
        assert.deepEqual(h.b.disk.messages[1].swipes.slice(0,2), ['이전 후보 하나','이전 후보 둘']);
    }
});

test('unfinished review stays off screen and survives declined confirmation until explicit acceptance', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const draft = await revisionRequest(f, session, { testReply: 'unreviewed candidate' }); await draft.text();
    const jobId = draft.headers.get('x-silly-relay-job');
    page.recovery.stop();
    let confirmed = false, prompts = 0, reads = 0;
    const fresh = await b.makePage('same-tab', {
        confirmUnreviewed: async () => { prompts++; return confirmed; },
        api: (path, init) => { if (path.startsWith('/jobs/')) reads++; return page.transport.api(path, init); },
    });
    await fresh.recovery.recover();
    const initialReads = reads;
    await fresh.recovery.recover();
    await fresh.recovery.recover({ manual: true }); // Ordinary recovery check is not consent.
    assert.equal(reads, initialReads, 'do not reread the same held candidate every poll');
    assert.equal(prompts, 0); assert.equal(b.disk.messages.length, 1);
    assert.equal(b.rendered.length, 0); assert.equal(b.emitted.length, 0);
    assert.equal(fresh.recovery.list()[0].finalized, false);
    assert.equal(fresh.recovery.list()[0].selectedId, null);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 200);
    assert.ok(b.messages.some(text => /검수 미완료/.test(text)));
    await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(prompts, 1); assert.equal(b.disk.messages.length, 1);
    assert.equal(fresh.recovery.list()[0].finalized, false);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 200);
    confirmed = true;
    await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(b.disk.messages[1].mes, 'unreviewed candidate');
    assert.equal(b.disk.messages[1].extra[b.MARK].reviewIncomplete, true);
    assert.equal(f.calls.length, 1, 'manual recovery never invokes the model');
    assert.equal(fresh.recovery.list().length, 0);
    assert.equal((await f.request(`/jobs/${jobId}`)).status, 410);
    assert.ok(b.messages.some(text => /검수 미완료 답장을 직접 복구/.test(text)));
});

test('unfinished 100LOG review never replaces an already displayed draft automatically', async t => {
    const h = await reviewedReply(t, { ttotto: true, saveDraft: true });
    await h.review.capture('correction', () => h.quiet('correction', 'unselected correction'));
    h.page.recovery.stop();
    const before = structuredClone(h.b.disk.messages), fresh = await h.b.makePage();
    await fresh.recovery.recover(); await fresh.recovery.settle();
    assert.deepEqual(h.b.disk.messages, before);
    assert.deepEqual(fresh.ctx.chat, before);
    assert.equal(h.b.rendered.length, 0); assert.equal(h.b.emitted.length, 0);
    assert.equal(fresh.recovery.list()[0].finalized, false);
    for (const job of fresh.recovery.list()[0].jobs) assert.equal((await h.f.request(`/jobs/${job.id}`)).status, 200);
});

test('100LOG review without a rewrite still waits for a final decision after reload', async t => {
    const h = await reviewedReply(t, { saveDraft: true });
    h.page.recovery.stop();
    const fresh = await h.b.makePage();
    assert.ok(h.page.recovery.list()[0].selectedId, 'base selection does not prove the new review completed');
    await fresh.recovery.recover();
    assert.equal(fresh.recovery.list().length, 1);
    assert.equal(fresh.recovery.list()[0].finalized, false);
    assert.equal(h.b.rendered.length, 0);
});

for (const action of ['chat-change', 'new-generation', 'final-selection']) {
    test(`confirmation cannot commit after ${action}`, async t => {
        const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
        page.arm(); const session = await replySession(page);
        const draft = await revisionRequest(f, session, { testReply: 'draft' }); await draft.text();
        page.recovery.stop();
        let finish, entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const fresh = await b.makePage('same-tab', { confirmUnreviewed: () => {
            entered(); return new Promise(resolve => { finish = resolve; });
        } });
        const pending = fresh.recovery.recover({ manual: true, allowUnreviewed: true });
        await ready;
        if (action === 'chat-change') fresh.ctx.chatId = 'Other';
        if (action === 'new-generation') fresh.arm();
        if (action === 'final-selection') session.complete(draft);
        finish(true); await pending;
        assert.equal(b.disk.messages.length, 1); assert.equal(b.rendered.length, 0);
        assert.equal(fresh.recovery.list()[0].reviewIncomplete, action === 'final-selection' ? false : undefined);
        assert.equal(fresh.recovery.list()[0].finalized, action === 'final-selection');
    });
}

test('chosen final missing from server never falls back to an unselected draft', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const draft = await revisionRequest(f, session, { testReply: 'must not show' }); await draft.text();
    const final = await revisionRequest(f, session, { testReply: 'selected final' }); await final.text(); session.complete(final);
    page.recovery.stop();
    const finalId = final.headers.get('x-silly-relay-job');
    const fresh = await b.makePage('same-tab', { api: (path, init) => path.startsWith(`/jobs/${finalId}`)
        ? Promise.reject(Object.assign(Error('missing'), { httpStatus: 404 })) : page.transport.api(path, init) });
    await fresh.recovery.recover();
    assert.equal(b.disk.messages.length, 1); assert.equal(b.rendered.length, 0);
});

test('manual candidate acceptance survives a failed save without duplicate confirmation or message', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const draft = await revisionRequest(f, session, { testReply: 'accepted candidate' }); await draft.text();
    page.recovery.stop(); let prompts = 0;
    const fresh = await b.makePage('same-tab', { confirmUnreviewed: async () => { prompts++; return true; } });
    b.disk.failSave = true;
    await fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    assert.equal(fresh.ctx.chat[1].mes, 'accepted candidate'); assert.equal(b.disk.messages.length, 1);
    assert.equal((await f.request(`/jobs/${draft.headers.get('x-silly-relay-job')}`)).status, 200);
    b.disk.failSave = false; await fresh.recovery.recover(); await fresh.recovery.recover();
    assert.equal(b.disk.messages.length, 2); assert.equal(prompts, 1);
    assert.equal(b.disk.messages[1].extra[b.MARK].reviewIncomplete, true);
    assert.equal(f.calls.length, 1);
});

test('a newer final selection during reply formatting supersedes an accepted candidate', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), page = await b.makePage();
    page.arm(); const session = await replySession(page);
    const selected = await revisionRequest(f, session, { testReply: 'guard selected this' }); await selected.text();
    const candidate = await revisionRequest(f, session, { testReply: 'candidate awaiting review' }); await candidate.text();
    page.recovery.stop();
    let enter, finish;
    const ready = new Promise(resolve => { enter = resolve; });
    const fresh = await b.makePage('same-tab', { confirmUnreviewed: async () => true,
        formatReply: text => { enter(); return new Promise(resolve => { finish = () => resolve(text); }); } });
    const pending = fresh.recovery.recover({ manual: true, allowUnreviewed: true });
    await ready; session.complete(selected); finish(); await pending;
    assert.equal(b.disk.messages.length, 1); assert.equal(b.rendered.length, 0);
    const next = await b.makePage(); await next.recovery.recover();
    assert.equal(b.disk.messages[1].mes, 'guard selected this');
    assert.equal(b.disk.messages[1].extra[b.MARK].reviewIncomplete, undefined);
    assert.equal(f.calls.length, 2);
});

test('matching completion receipts retire without inspecting edits or overwriting either version', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage(); old.arm();
    const response = await old.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: JSON.stringify({type:'normal',duration:5,testReply:'Long answer with missing section'}) });
    await response.text(); const jobId=response.headers.get('x-silly-relay-job');
    old.ctx.chat.push({name:'Character',is_user:false,mes:'Short answer',swipes:['Short answer'],swipe_id:0,extra:{}});
    old.recovery.tag(1,true); await old.ctx.saveChat(); old.recovery.stop();
    const fresh=await b.makePage();
    b.disk.messages[1].mes='Long answer with missing section';
    b.disk.messages[1].swipes[0]=b.disk.messages[1].mes;
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat[1].mes,'Short answer');
    assert.equal(b.disk.messages[1].mes,'Long answer with missing section');
    assert.equal(fresh.recovery.list().length,0);
    assert.equal(b.rendered.length,0);
    assert.equal(b.messages.length,0);
    assert.equal((await f.request(`/jobs/${jobId}`)).status,410);
    const reloaded=await b.makePage();
    assert.equal(reloaded.ctx.chat[1].mes,'Long answer with missing section');
});

test('receive-hook body change updates both the rendered reply and its saved swipe', async t => {
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,
        body:JSON.stringify({type:'normal',duration:5,testReply:'Visible first section'})});
    await response.text();old.recovery.stop();
    const fresh=await b.makePage();let screen='',renders=0;
    fresh.ctx.addOneMessage=message=>{screen=message.mes;renders++;};
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){
            fresh.ctx.chat[index].mes='Visible first section plus previously unseen section';
            fresh.ctx.chat[index].swipes[0]=fresh.ctx.chat[index].mes;
        }
    };
    await fresh.recovery.recover();
    assert.equal(screen,'Visible first section plus previously unseen section');
    assert.equal(renders,2);
    assert.equal(b.disk.messages[1].mes,'Visible first section plus previously unseen section');
    assert.equal(fresh.recovery.list().length,0);
    assert.equal((await b.makePage()).ctx.chat[1].mes,b.disk.messages[1].mes);
});

test('another page save during formatting stops stale recovery before rendering or saving', async t => {
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,
        body:JSON.stringify({type:'normal',duration:5,testReply:'Recovery candidate'})});
    await response.text();old.recovery.stop();
    let finish,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const fresh=await b.makePage('same-tab',{formatReply:text=>{entered();return new Promise(resolve=>{finish=()=>resolve(text);});}});
    const pending=fresh.recovery.recover();await started;
    b.disk.messages.push({name:'Character',is_user:false,mes:'Newer answer saved by another page',extra:{},swipe_id:0,swipes:['Newer answer saved by another page']});
    finish();await pending;
    assert.equal(b.disk.messages[1].mes,'Newer answer saved by another page');
    assert.equal(fresh.ctx.chat.length,1);
    assert.equal(b.rendered.length,0);
    assert.equal(fresh.recovery.list().length,1);
});

for (const throwAfterChange of [false, true]) test(`postprocessing redraw respects translated display text, even on failure=${throwAfterChange}`, async t => {
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,body:'{"type":"normal","duration":5}'});
    await response.text();old.recovery.stop();
    const fresh=await b.makePage();let screen='',updates=0;
    fresh.ctx.addOneMessage=message=>{screen=message.extra?.display_text??message.mes;};
    fresh.ctx.updateMessageBlock=(index,message)=>{assert.equal(index,1);screen=message.extra?.display_text??message.mes;updates++;};
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){
            fresh.ctx.chat[index].mes='Final original';
            fresh.ctx.chat[index].extra.display_text='최종 번역';
            if(throwAfterChange)throw Error('postprocessor failed after changing text');
        }
    };
    await fresh.recovery.recover();
    assert.equal(screen,'최종 번역');assert.equal(updates,1);
    assert.equal(b.disk.messages[1].mes,'Final original');
    assert.equal(b.disk.messages[1].swipes[0],'Final original');
    assert.equal(b.disk.messages[1].swipe_info[0].extra.display_text,'최종 번역');
    assert.equal(fresh.recovery.list().length,0);
});

test('periodic settlement cannot release a reply while its receive hook is still running',async t=>{
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,body:'{"type":"normal","duration":5}'});
    await response.text();old.recovery.stop();const jobId=response.headers.get('x-silly-relay-job');
    const fresh=await b.makePage();let entered,finish;
    const ready=new Promise(resolve=>{entered=resolve;});
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){entered();await new Promise(resolve=>{finish=resolve;});fresh.ctx.chat[index].mes='After slow review';}
    };
    const pending=fresh.recovery.recover();await ready;
    await fresh.recovery.settle();
    assert.equal(fresh.recovery.list().length,1);
    assert.equal((await f.request(`/jobs/${jobId}`)).status,200);
    finish();await pending;
    assert.equal(b.disk.messages[1].mes,'After slow review');
    assert.equal(fresh.recovery.list().length,0);
    assert.equal((await f.request(`/jobs/${jobId}`)).status,410);
});

test('a remote save during postprocessing is preserved instead of overwritten by the final local save',async t=>{
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,body:'{"type":"normal","duration":5}'});
    await response.text();old.recovery.stop();const fresh=await b.makePage();
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){
            fresh.ctx.chat[index].mes='Local processed reply';
            b.disk.messages[index].mes='Other device edited reply';
            b.disk.messages[index].swipes[0]='Other device edited reply';
        }
    };
    await fresh.recovery.recover();await fresh.recovery.settle();
    assert.equal(b.disk.messages[1].mes,'Other device edited reply');
    assert.equal(fresh.ctx.chat[1].mes,'Local processed reply');
    assert.equal(fresh.recovery.list().length,0);
    assert.equal(b.messages.length,0);
});

test('a receive hook may save its own final body before relay saves later metadata',async t=>{
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,body:'{"type":"normal","duration":5}'});
    await response.text();old.recovery.stop();const fresh=await b.makePage();
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){
            const message=fresh.ctx.chat[index];message.mes='Self-saved final';message.swipes[0]=message.mes;
            await fresh.ctx.saveChat();message.extra.sceneFacts={location:'Room'};
        }
    };
    await fresh.recovery.recover();
    assert.equal(b.disk.messages[1].mes,'Self-saved final');
    assert.equal(b.disk.messages[1].extra.sceneFacts.location,'Room');
    assert.equal(fresh.recovery.list().length,0);
});

for(const change of ['chat','swipe','message'])test(`late postprocessing cannot redraw or save after ${change} replacement`,async t=>{
    const f=await fixture(t),b=await recoveryBrowser(t,f),old=await b.makePage();old.arm();
    const response=await old.transport.fetch(f.base+PATH,{method:'POST',headers:AUTH,body:'{"type":"normal","duration":5}'});
    await response.text();old.recovery.stop();const fresh=await b.makePage();let saves=0,redraws=0;
    const save=fresh.ctx.saveChat;fresh.ctx.saveChat=async()=>{saves++;await save();};
    fresh.ctx.updateMessageBlock=()=>{redraws++;};
    fresh.ctx.eventSource.emit=async(type,index)=>{
        if(type==='received'){
            fresh.ctx.chat[index].mes='Changed by hook';
            if(change==='chat'){fresh.ctx.chatId='Other';fresh.ctx.chat=[{is_user:true,mes:'Other chat'}];}
            if(change==='swipe'){fresh.ctx.chat[index].swipe_id=1;fresh.ctx.chat[index].swipes.push('Other swipe');fresh.ctx.chat[index].mes='Other swipe';}
            if(change==='message')fresh.ctx.chat[index]={name:'Character',mes:'Replacement message',extra:{}};
        }
    };
    await fresh.recovery.recover();
    assert.equal(saves,1);assert.equal(redraws,0);
    assert.equal(b.disk.messages[1].mes,'서버가 끝까지 받은 답장 🤍');
    assert.equal(fresh.recovery.list().length,1);
});

for (const field of ['display_text', 'sceneFacts', 'swipe_info', 'history', 'deleted']) {
    test(`recovery preserves remote metadata change: ${field}`, async t => {
        const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage(); old.arm();
        const response = await old.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
            body: '{"type":"normal","duration":5}' });
        await response.text(); old.recovery.stop(); const fresh = await b.makePage();
        if (field === 'deleted') {
            fresh.ctx.chat[0].extra = { obsolete: 'remove me' };
            b.disk.messages[0].extra = { obsolete: 'remove me' };
        }
        let expected;
        fresh.ctx.eventSource.emit = async (type, index) => {
            if (type !== 'received') return;
            if (field === 'history') b.disk.messages[0].extra = { facts: 'new history metadata' };
            else if (field === 'deleted') delete b.disk.messages[0].extra.obsolete;
            else if (field === 'swipe_info') b.disk.messages[index].swipe_info[0].extra.facts = 'new swipe metadata';
            else b.disk.messages[index].extra[field] = { value: 'new remote metadata' };
            expected = structuredClone(b.disk.messages);
        };
        await fresh.recovery.recover();
        assert.deepEqual(b.disk.messages, expected, 'never overwrite the remote metadata');
        await fresh.recovery.settle();
        assert.equal(fresh.recovery.list().length, 0);
        assert.equal(b.messages.length, 0);
    });
}
test('remote metadata changed during formatting stops recovery before rendering', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage(); old.arm();
    const response = await old.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: '{"type":"normal","duration":5}' });
    await response.text(); old.recovery.stop();
    const fresh = await b.makePage('same-tab', { formatReply: async text => {
        b.disk.messages[0].extra = { facts: 'new remote facts' }; return text;
    } });
    await fresh.recovery.recover();
    assert.equal(fresh.ctx.chat.length, 1); assert.equal(b.rendered.length, 0);
    assert.equal(b.disk.messages[0].extra.facts, 'new remote facts');
    assert.equal(fresh.recovery.list().length, 1);
});
test('metadata already updated before recovery is not replaced by stale page history', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage(); old.arm();
    const response = await old.transport.fetch(f.base + PATH, { method: 'POST', headers: AUTH,
        body: '{"type":"normal","duration":5}' });
    await response.text(); old.recovery.stop(); const fresh = await b.makePage();
    b.disk.messages[0].extra = { display_text: 'new translation already saved' };
    await fresh.recovery.recover();
    assert.equal(b.disk.messages.length, 1);
    assert.equal(b.disk.messages[0].extra.display_text, 'new translation already saved');
    assert.equal(fresh.ctx.chat.length, 1); assert.equal(b.rendered.length, 0);
    assert.equal(fresh.recovery.list().length, 1);
});

test('authenticated export connects server lifecycle events and cannot request another account history', async t => {
    const directory = await fs.mkdtemp(pathModule.join(os.tmpdir(), 'relay-api-diag-'));
    const journal = createJournal({ directory });
    t.after(async () => { await journal.flush(); await fs.rm(directory, { recursive: true, force: true }); });
    const f = await fixture(t, { journal });
    const jobId = id();
    await f.start(jobId, { duration: 15, testReply: 'PRIVATE_REPLY', secret: 'PRIVATE_KEY' });
    let state;
    for (let tries = 0; tries < 50; tries++) { state = await f.get(jobId); if (state.state === 'completed') break; await delay(5); }
    assert.equal(state.state, 'completed');
    await f.request(`/jobs/${jobId}/ack`, { method: 'POST', body: JSON.stringify({ cursor: state.bytes }) });
    const report = await (await f.request('/diagnostics')).json();
    for (const stage of ['accepted', 'upstream_headers', 'completed', 'read', 'acknowledged']) {
        assert.ok(report.events.some(e => e.id === jobId && e.stage === stage), stage);
    }
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|alice/);
    const other = await (await f.request('/diagnostics?owner=alice', { headers: { cookie: 'user=bob' } })).json();
    assert.equal(other.events.length, 0);
    assert.equal((await f.request('/diagnostics', { headers: { cookie: '' } })).status, 401);
});

test('installed relay leaves ordinary Vertex requests untouched; explicit relay preserves their model', async t => {
    const f = await fixture(t);
    const payload = { model: 'gemini-4-argon', chat_completion_source: 'vertexai',
        vertexai_region: 'global', vertexai_express_project_id: 'fixture-project',
        messages: [{ role: 'user', content: 'fixture' }], duration: 5 };
    const direct = await fetch(f.base + PATH, { method: 'POST', headers: AUTH, body: JSON.stringify(payload) });
    assert.equal(direct.status, 200);
    await direct.text();
    assert.deepEqual(f.calls[0].body, payload);
    assert.equal(f.calls[0].headers['user-agent'].startsWith('Silly-Relay/'), false);
    for (const ticket of [null, id()]) {
        const jobId = id();
        await f.start(jobId, { ...payload, ...(ticket ? { __verba_server_ticket: ticket } : {}) });
        await delay(40);
        assert.equal((await f.get(jobId)).state, 'completed');
        assert.deepEqual(f.calls.at(-1).body, payload);
    }
});

test('optional Verba observer receives one completed reply without owning delivery', async t => {
    const symbol = Symbol.for('verba.relay-observer');
    const before = globalThis[symbol];
    t.after(() => { if (before) globalThis[symbol] = before; else delete globalThis[symbol]; });
    const seen = [];
    globalThis[symbol] = { apiVersion: 1, complete(owner, ticket, reply) { seen.push({owner,ticket,reply}); } };
    const f = await fixture(t);
    const ticket = id(); const jobId = id();
    await f.start(jobId, { duration: 10, testReply: 'Hello from background.', __verba_server_ticket: ticket });
    await delay(70);
    const result = await f.get(jobId);
    assert.equal(result.state, 'completed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].owner, 'alice');assert.equal(seen[0].ticket, ticket);
    assert.match(seen[0].reply.body.toString(), /Hello from background/);
    assert.equal(f.calls.length, 1);
    await f.start(jobId, { duration: 10, testReply: 'Hello from background.', __verba_server_ticket: ticket });
    assert.equal(seen.length, 1, 'duplicate start does not repeat translation');
});

test('account notification choice persists; all markers installed route to one target without changing model or prompt', async t => {
    const { createRouting } = require('../server/notification-routing.cjs');
    const directory = await fs.mkdtemp(pathModule.join(os.tmpdir(), 'relay-routing-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const routing = createRouting(directory);
    const f = await fixture(t, { routing });
    const markers = { silly_pop: { protocol:1, requestId:'apk', clientId:'client' }, silly_pop_ios: { v:1 }, silly_pop_and:{v:1} };
    for (const target of ['ios','and','apk','none','legacy']) {
        const saved = await f.request('/notification-settings', { method:'POST', body:JSON.stringify({target,owner:'bob'}) });
        assert.equal(saved.status,200);
        assert.equal(createRouting(directory).get('alice'),target);
        assert.equal(createRouting(directory).get('bob'),'legacy','body cannot change another account');
        const payload = { ...markers, model:'gemini-4-argon', vertexai_region:'global', messages:[{role:'user',content:'unchanged'}], duration:1 };
        const jobId = id(); await f.start(jobId,payload); await delay(30);
        const call = f.calls.at(-1);
        assert.equal(call.body.model,payload.model); assert.deepEqual(call.body.messages,payload.messages);
        for (const [kind,field] of [['apk','silly_pop'],['ios','silly_pop_ios'],['and','silly_pop_and']])
            assert.equal(!!call.body[field],target==='legacy'||target===kind);
        assert.equal((await f.get(jobId)).notificationTarget,target);
        routing.set('alice',target==='ios'?'and':'ios');
        await f.start(jobId,payload);
        assert.equal((await f.get(jobId)).notificationTarget,target,'acceptance retry keeps its original choice');
    }
    assert.equal(f.calls.length,5,'lost acceptance must not repeat AI requests');
    const bad = await f.request('/notification-settings',{method:'POST',body:JSON.stringify({target:'unknown'})});
    assert.equal(bad.status,400);
});

test('selected iOS route strips APK header and returns owner-bound translation ticket for recovery',async t=>{
    const symbol=Symbol.for('verba.relay-observer'), previous=globalThis[symbol];
    const ticket=id(),binding={id:ticket,variant:'verba',config:'abc123'};
    globalThis[symbol]={apiVersion:1,complete(){},notificationTarget(owner,value){assert.equal(owner,'alice');assert.equal(value,ticket);return 'ios';},binding:()=>binding,translationNotification:()=>true};
    t.after(()=>{if(previous)globalThis[symbol]=previous;else delete globalThis[symbol];});
    const f=await fixture(t,{routing:{get:()=> 'and'}}),job=id();
    await f.request('/jobs',{method:'POST',headers:{'x-silly-pop':'old-apk-marker'},body:JSON.stringify({id:job,path:PATH,body:JSON.stringify({model:'custom',silly_pop:{enabled:true},silly_pop_ios:{v:1},silly_pop_and:{v:1},__verba_server_ticket:ticket,duration:1})})});
    await delay(30);
    assert.equal(f.calls[0].headers['x-silly-pop'],undefined);
    assert.equal(f.calls[0].body.silly_pop,undefined);
    assert.equal(f.calls[0].body.silly_pop_ios.translationPending,true);
    assert.equal(f.calls[0].body.__verba_server_ticket,undefined);
    assert.deepEqual((await f.get(job)).translation,binding);
    const other=await f.request(`/jobs/${job}`,{headers:{cookie:'user=bob'}});assert.equal(other.status,404);
});

test('early-returning 100LOG review waits for its actual completion after ttotto handoff', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    await recoverableReview(old, f, true); old.recovery.stop();
    let page, finish, began;
    const started = new Promise(resolve => { began = resolve; });
    const trace = [], owners = [];
    page = await b.makePage('same-tab', {
        trace: (stage, detail) => trace.push({ stage, ...detail }),
        resumeReview: async data => {
            owners.push(data.checkpoint.owner);
            if (data.checkpoint.owner === 'ttotto') {
                page.recovery.completeSequence(page.recovery.resumeSequence(data.record, data.context), data.record.jobId);
                return { resumed: true };
            }
            return { postprocess: async (index, message) => {
                const sequence = page.recovery.beginReview(index, message, new AbortController().signal,
                    { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
                assert.ok(sequence);
                assert.equal(page.recovery.beginReview(index, message, new AbortController().signal,
                    { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true }), null);
                finish = () => page.recovery.completeReview(sequence, message);
                began(); // The extension returns while its own callback is still working.
            } };
        },
    });
    const pending = page.recovery.recover(); await started; await delay(20);
    await page.recovery.recover();
    assert.equal(b.disk.messages.length, 1); assert.equal(b.rendered.length, 0);
    assert.ok(trace.some(e => e.stage === 'review_waiting'));
    assert.ok(!trace.some(e => e.stage === 'recovery_failed'));
    finish(); await pending;
    assert.deepEqual(owners, ['ttotto', 'hundredlog']);
    assert.equal(b.disk.messages[1].mes, 'Retained draft'); assert.equal(page.recovery.list().length, 0);
    assert.equal(f.calls.length, 1);
    assert.ok(!b.messages.some(m => /검수를 마치지/.test(m)));
});

for (const interruption of ['reload', 'abort']) test(`waiting review ${interruption} retains the reply and rejects a late old completion`, async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    const original = await recoverableReview(old, f, true); old.recovery.stop();
    let page, finish, began;
    const controller = new AbortController();
    const started = new Promise(resolve => { began = resolve; });
    const resumeReview = async data => {
        if (data.checkpoint.owner === 'ttotto') {
            page.recovery.completeSequence(page.recovery.resumeSequence(data.record, data.context), data.record.jobId);
            return { resumed: true };
        }
        return { postprocess: async (index, message) => {
            const review = page.recovery.beginReview(index, message, controller.signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            assert.ok(review); finish = () => page.recovery.completeReview(review, message); began();
        } };
    };
    page = await b.makePage('same-tab', { resumeReview });
    const pending = page.recovery.recover(); await started; await delay(10);
    if (interruption === 'reload') page.recovery.stop(); else controller.abort();
    await pending; finish();
    assert.equal(b.disk.messages.length, 1); assert.equal(page.ctx.chat.length, 1);
    assert.equal(page.recovery.list().length, 1);
    assert.equal((await f.request(`/jobs/${original.jobId}`)).status, 200);
    page.recovery.stop();
    page = await b.makePage('same-tab', { resumeReview: async data => {
        assert.equal(data.checkpoint.owner, 'hundredlog', 'do not repeat completed ttotto');
        return { postprocess: async (index, message) => {
            const review = page.recovery.beginReview(index, message, new AbortController().signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            assert.ok(review); page.recovery.completeReview(review, message);
        } };
    } });
    await page.recovery.recover();
    assert.equal(b.disk.messages[1].mes, 'Retained draft'); assert.equal(page.recovery.list().length, 0);
    assert.equal(f.calls.length, 1);
});

test('transport reviewer returning early waits before handing the reply to 100LOG', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    await recoverableReview(old, f, true); old.recovery.stop();
    let page, finish, began;
    const started = new Promise(resolve => { began = resolve; }); const owners = [];
    page = await b.makePage('same-tab', { resumeReview: async data => {
        owners.push(data.checkpoint.owner);
        if (data.checkpoint.owner === 'ttotto') {
            const sequence = page.recovery.resumeSequence(data.record, data.context);
            finish = () => page.recovery.completeSequence(sequence, data.record.jobId);
            began(); return { resumed: true };
        }
        return { postprocess: async (index, message) => {
            const sequence = page.recovery.beginReview(index, message, new AbortController().signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            page.recovery.completeReview(sequence, message);
        } };
    } });
    const pending = page.recovery.recover(); await started; await delay(20);
    assert.deepEqual(owners, ['ttotto']); assert.equal(b.rendered.length, 0);
    finish(); await pending;
    assert.deepEqual(owners, ['ttotto', 'hundredlog']);
    assert.equal(page.recovery.list().length, 0); assert.equal(f.calls.length, 1);
});

test('hiding during an active review preserves the checkpoint and restores only the remaining review on return', async t => {
    const f = await fixture(t), b = await recoveryBrowser(t, f), old = await b.makePage();
    await recoverableReview(old, f, true); old.recovery.stop();
    let page, visible = true, began, finishOld, first = true;
    const started = new Promise(resolve => { began = resolve; }); const owners = [];
    page = await b.makePage('same-tab', { isVisible: () => visible, resumeReview: async data => {
        owners.push(data.checkpoint.owner);
        if (data.checkpoint.owner === 'ttotto') {
            page.recovery.completeSequence(page.recovery.resumeSequence(data.record, data.context), data.record.jobId);
            return { resumed: true };
        }
        return { postprocess: async (index, message) => {
            const sequence = page.recovery.beginReview(index, message, new AbortController().signal,
                { owner: 'hundredlog', checkpoint: data.checkpoint.checkpoint, resuming: true });
            if (first) { first = false; finishOld = () => page.recovery.completeReview(sequence, message); began(); }
            else page.recovery.completeReview(sequence, message);
        } };
    } });
    const pending = page.recovery.recover(); await started; await delay(20); visible = false; await pending;
    assert.equal(page.ctx.chat.length, 1); assert.equal(b.disk.messages.length, 1);
    visible = true; finishOld();
    assert.ok(page.recovery.list()[0].reviewOwner);
    await page.recovery.recover();
    assert.deepEqual(owners, ['ttotto', 'hundredlog', 'hundredlog']);
    assert.equal(page.recovery.list().length, 0); assert.equal(f.calls.length, 1);
    assert.ok(!b.messages.some(m => /검수를 마치지/.test(m)));
});
