'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const { createJournal, errorDetails } = require('./diagnostics.cjs');
const path = require('node:path');
const VERSION = '1.0.6';
// Optional observer: existing reply transport/recovery owns generation unchanged.
globalThis[Symbol.for('verba.relay-capability')] = 1;
const PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/azure/generate',
]);
const ID = /^[a-f0-9]{32}$/;
const DEFAULT_LIMITS = Object.freeze({
    requestBytes: 8 * 1024 * 1024, responseBytes: 8 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024, jobs: 64, perUserJobs: 24, metadataJobs: 4096, active: 8, perUserActive: 4,
    timeoutMs: 20 * 60 * 1000, retentionMs: 60 * 60 * 1000,
    pollMs: 10000, pageBytes: 128 * 1024,
});
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function internalAddress(socket) {
    const address = socket.localAddress.replace(/^::ffff:/, '');
    const listener = socket.server?.address?.();
    // Only use loopback when this SAME listener is bound to all interfaces.
    // Connecting back to its LAN/Tailscale address can make ST's whitelist
    // reject the server itself even though the original browser was allowed.
    // An interface-only listener (or unavailable listener metadata) must keep
    // its accepted address. Never retry a generation at another destination.
    if (listener && typeof listener === 'object' && listener.port === socket.localPort) {
        if (listener.address === '0.0.0.0') return '127.0.0.1';
        if (listener.address === '::') return address.includes(':') ? '::1' : '127.0.0.1';
    }
    return address;
}
function ownerOf(req) {
    const owner = req.user?.profile?.handle;
    if (typeof owner !== 'string' || !owner) throw fail(401, '실리태번 로그인 상태를 확인해 주세요.');
    return owner;
}

// Reply bodies remain temporary memory buffers. Only sanitized diagnostics persist.
function createRelay(overrides = {}) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    // This transport only reaches the SAME accepted ST listener (see start).
    // agent:false is NOT a native/direct agent: Node constructs the current
    // global agent's class without options. ST's PrivateRequestAgent then loses
    // its configured allowlist, and ProxyAgent can inherit an external proxy.
    // Keep self-requests local without changing ST's global AI routing/filter.
    const internalAgent = new http.Agent({ keepAlive: false });
    const journal = overrides.journal;
    const trace = (owner, stage, id, data) => { try { journal?.record(owner, stage, id, data); } catch { /* Logging never controls delivery. */ } };
    const jobs = new Map();
    let totalBytes = 0;
    const keyOf = (owner, id) => JSON.stringify([owner, id]);
    function release(job) {
        if (!job.released) totalBytes -= job.size;
        job.chunks = [];
        job.released = true;
    }
    function remove(job) {
        release(job);
        jobs.delete(keyOf(job.owner, job.id));
    }
    function prune() {
        const now = Date.now();
        for (const job of jobs.values()) {
            if (job.state !== 'running' && now - job.finishedAt > limits.retentionMs) {
                trace(job.owner, 'expired', job.id, { bytes: job.size }); remove(job);
            }
        }
    }
    function finish(job, state, error = '', details = {}) {
        if (job.state !== 'running') return;
        job.state = state;
        job.error = error;
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        job.upstream = null;
        if (state === 'failed' || state === 'cancelled') release(job);
        job.events.emit('change');
        trace(job.owner, state, job.id, { ...job.diagnostic, ...details,
            elapsedMs: Math.max(0, job.finishedAt - job.createdAt), status: job.status, bytes: job.size });
        if (job.translationTicket) {
            try {
                const observer = globalThis[Symbol.for('verba.relay-observer')];
                if (observer?.apiVersion === 1) {
                    Promise.resolve(observer.complete(job.owner, job.translationTicket, {
                        state, status: job.status, type: job.contentType,
                        body: state === 'completed' ? slice(job, 0, job.size) : Buffer.alloc(0),
                    })).catch(() => {});
                }
            } catch { /* Optional translation never changes reply delivery. */ }
        }
        // Metadata only. Never log the body, character names, cookies or keys.
        console.log(`[Silly Relay] ${job.id.slice(0, 8)} ${state} (HTTP ${job.status || 'pending'}, ${job.size} bytes)`);
    }
    function cancel(job) {
        const upstream = job.upstream;
        finish(job, 'cancelled', '사용자가 생성을 중지했습니다.');
        upstream?.destroy();
    }
    function lookup(owner, id) {
        if (!ID.test(String(id))) throw fail(400, '잘못된 작업 번호입니다.');
        prune();
        const job = jobs.get(keyOf(owner, id));
        if (!job) throw fail(404, '이어받을 요청이 없습니다. 서버 재시작 또는 재연결 대기 시간 만료일 수 있습니다.');
        return job;
    }
    function describe(job) {
        return { id: job.id, state: job.state, createdAt: job.createdAt, finishedAt: job.finishedAt,
            status: job.status, contentType: job.contentType, bytes: job.size, error: job.error };
    }
    function slice(job, from, to) {
        const buffers = [];
        let pos = 0;
        for (const chunk of job.chunks) {
            if (pos >= to) break;
            const end = pos + chunk.length;
            if (end > from) buffers.push(chunk.subarray(Math.max(0, from - pos), Math.min(chunk.length, to - pos)));
            pos = end;
        }
        return Buffer.concat(buffers);
    }
    function snapshot(job, cursor) {
        const next = Math.min(job.size, cursor + limits.pageBytes);
        return { ...describe(job), cursor, next, data: slice(job, cursor, next).toString('base64') };
    }
    function start(req) {
        const owner = ownerOf(req);
        const { id, path, body } = req.body || {};
        if (!ID.test(String(id)) || !PATHS.has(path) || typeof body !== 'string') {
            throw fail(400, '지원하지 않는 생성 요청입니다.');
        }
        if (Buffer.byteLength(body) > limits.requestBytes) throw fail(413, '요청 크기 한도를 초과했습니다.');
        try {
            const parsed = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch { throw fail(400, '생성 요청 본문은 JSON 객체여야 합니다.'); }
        const cleanPayload = JSON.parse(body);
        const translationTicket = ID.test(cleanPayload.__verba_server_ticket || '') ? cleanPayload.__verba_server_ticket : null;
        delete cleanPayload.__verba_server_ticket;
        const upstreamBody = translationTicket ? JSON.stringify(cleanPayload) : body;
        prune();
        const digest = createHash('sha256').update(path).update('\0').update(body).digest('hex');
        const existing = jobs.get(keyOf(owner, id));
        if (existing) {
            if (existing.digest && existing.digest !== digest) throw fail(409, '같은 작업 번호에 다른 요청이 들어왔습니다.');
            trace(owner, 'duplicate_start', id, { bytes: existing.size, status: existing.status });
            return existing; // A lost start response must not cause a second AI request.
        }
        // Use the actual accepted server socket, never a URL or port supplied by a client.
        // This prototype supports HTTP ST servers, including HTTPS terminated by a reverse proxy.
        if (req.socket.encrypted) throw fail(409, 'Silly Relay는 실리태번 자체 HTTPS 모드를 지원하지 않습니다.');
        if (!req.socket.localAddress || !req.socket.localPort) throw fail(503, '실리태번 서버 주소를 확인할 수 없습니다.');
        const pending = [...jobs.values()].filter(j => j.state === 'running' || j.state === 'completed');
        const active = pending.filter(j => j.state === 'running');
        const ownPending = pending.filter(j => j.owner === owner).length;
        const ownActive = active.filter(j => j.owner === owner).length;
        if (ownActive >= limits.perUserActive) {
            throw fail(429, `동시 생성 한도: 이 계정에서 ${ownActive}/${limits.perUserActive}개 요청을 처리 중입니다. 이번 요청은 접수되지 않았습니다.`);
        }
        if (ownPending >= limits.perUserJobs) {
            throw fail(429, `보관 한도: 이 계정에 전달·저장 확인을 기다리는 요청이 ${ownPending}/${limits.perUserJobs}개 있습니다. 이번 요청은 접수되지 않았습니다.`);
        }
        if (active.length >= limits.active) throw fail(429, '서버 전체 동시 생성 한도입니다. 잠시 뒤 다시 시도해 주세요. 이번 요청은 접수되지 않았습니다.');
        if (jobs.size >= limits.metadataJobs || pending.length >= limits.jobs || totalBytes >= limits.totalBytes) {
            throw fail(429, '서버 전체 응답 보관 한도입니다. 이번 요청은 접수되지 않았습니다.');
        }
        const job = { owner, id, digest, state: 'running', chunks: [], size: 0,
            createdAt: Date.now(), finishedAt: null, status: 0, contentType: '', error: '',
            events: new EventEmitter(), upstream: null, timer: null,
            translationTicket };
        jobs.set(keyOf(owner, id), job);
        trace(owner, 'accepted', id);
        const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(upstreamBody),
            'accept-encoding': 'identity', 'user-agent': `Silly-Relay/${VERSION}`, connection: 'close' };
        // Authenticate the internal HTTP request through ST's own middleware again.
        for (const name of ['cookie', 'authorization', 'x-csrf-token', 'x-silly-pop', 'accept', 'host']) {
            if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        }
        job.diagnostic = { phase: 'setup', requestFinished: false };
        let upstream;
        try {
            const address = internalAddress(req.socket);
            const agentName = http.globalAgent?.constructor?.name;
            Object.assign(job.diagnostic, { phase: 'connecting',
                targetKind: address === '::1' ? 'loopback_ipv6' : address.startsWith('127.') ? 'loopback_ipv4'
                    : address.includes(':') ? 'interface_ipv6' : 'interface_ipv4',
                globalAgentKind: agentName === 'PrivateRequestAgent' ? 'private_filter' : agentName === 'ProxyAgent' ? 'proxy'
                    : http.globalAgent?.constructor === http.Agent ? 'native' : 'other' });
            trace(owner, 'upstream_connecting', id, job.diagnostic);
            upstream = http.request({ hostname: address, port: req.socket.localPort,
                path, method: 'POST', headers, agent: internalAgent }, response => {
                job.diagnostic.phase = 'headers';
                job.status = response.statusCode || 502;
                trace(owner, 'upstream_headers', id, { status: job.status });
                job.contentType = String(response.headers['content-type'] || 'application/octet-stream');
                job.events.emit('change');
                const encoding = response.headers['content-encoding'];
                if (encoding && encoding !== 'identity') {
                    finish(job, 'failed', '압축된 서버 응답은 Silly Relay에서 지원하지 않습니다.', { reason: 'compressed_response' });
                    upstream.destroy();
                    return;
                }
                // Always drain upstream. A suspended/disconnected browser never owns this socket.
                response.on('data', chunk => {
                    if (job.state !== 'running') return;
                    job.diagnostic.phase = 'body';
                    if (job.size + chunk.length > limits.responseBytes || totalBytes + chunk.length > limits.totalBytes) {
                        finish(job, 'failed', '응답 전송 크기 한도를 초과했습니다.', { reason: 'response_limit' });
                        upstream.destroy();
                        return;
                    }
                    job.chunks.push(Buffer.from(chunk));
                    job.size += chunk.length;
                    totalBytes += chunk.length;
                    job.events.emit('change');
                });
                response.once('end', () => finish(job, 'completed'));
                response.once('aborted', () => finish(job, 'failed', '실리태번과 AI 사이 응답이 중간에 끊겼습니다.', { reason: 'response_aborted' }));
                response.once('error', error => finish(job, 'failed', '서버 응답을 읽지 못했습니다.', { reason: 'response_error', ...errorDetails(error) }));
            });
            job.upstream = upstream;
            upstream.once('socket', socket => socket.once('connect', () => {
                if (job.state !== 'running') return;
                job.diagnostic.phase = 'connected';
                trace(owner, 'upstream_connected', id, { ...job.diagnostic, elapsedMs: Math.max(0, Date.now() - job.createdAt) });
            }));
            upstream.once('finish', () => { job.diagnostic.requestFinished = true; });
            upstream.once('error', error => finish(job, 'failed', '서버 내부 생성 요청에 실패했습니다.', { reason: 'connection_error', ...errorDetails(error) }));
            job.timer = setTimeout(() => {
                finish(job, 'failed', '생성 대기 시간이 20분을 넘었습니다.', { reason: 'timeout', errorCode: 'ETIMEDOUT' });
                upstream.destroy();
            }, limits.timeoutMs);
            job.timer.unref?.();
            upstream.end(upstreamBody);
        } catch (error) {
            finish(job, 'failed', '서버 내부 생성 요청에 실패했습니다.', { reason: 'request_setup_error', ...errorDetails(error) });
            upstream?.destroy();
        }
        return job;
    }
    function install(router) {
        const wrap = handler => async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try { return await handler(req, res); }
            catch (error) {
                trace(req.user?.profile?.handle, 'api_error', req.params?.id || req.body?.id, { status: error.status || 500 });
                return res.status(error.status || 500).json({ error: error.status ? error.message : '서버 처리 오류입니다.' }); }
        };
        router.get('/status', wrap((req, res) => {
            const owner = ownerOf(req);
            res.json({ version: VERSION, protocol: 2, ready: !req.socket.encrypted, reloadRecovery: true, translationObserver: true, diagnosticJournal: !!journal, owner });
        }));
        router.get('/diagnostics', wrap(async (req, res) => {
            const owner = ownerOf(req);
            res.json(journal ? await journal.report(owner) : { unavailable: true, events: [] });
        }));
        router.post('/jobs', wrap((req, res) => res.status(202).json(describe(start(req)))));
        router.get('/jobs/:id', wrap((req, res) => {
            const job = lookup(ownerOf(req), req.params.id);
            if (job.state === 'delivered') throw fail(410, '전달이 끝난 응답은 즉시 삭제됩니다.');
            const cursor = Number(req.query.cursor || 0);
            if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.size) throw fail(400, '잘못된 응답 위치입니다.');
            const send = () => {
                cleanup();
                if (!res.destroyed && !res.writableEnded) {
                    const data = snapshot(job, cursor);
                    trace(job.owner, 'read', job.id, { cursor, next: data.next, bytes: job.size, status: job.status });
                    res.json(data);
                }
            };
            const disconnected = () => { trace(job.owner, 'reader_disconnected', job.id, { cursor }); cleanup(); };
            const cleanup = () => {
                clearTimeout(timer);
                job.events.removeListener('change', send);
                res.removeListener('close', disconnected);
            };
            let timer;
            if (job.size > cursor || job.state !== 'running' || req.query.wait !== '1') return send();
            timer = setTimeout(send, limits.pollMs);
            job.events.on('change', send);
            res.once('close', disconnected); // Disconnect only removes this reader, never the job.
        }));
        router.post('/jobs/:id/cancel', wrap((req, res) => {
            const owner = ownerOf(req);
            const id = req.params.id;
            if (!ID.test(String(id))) throw fail(400, '잘못된 작업 번호입니다.');
            prune();
            let job = jobs.get(keyOf(owner, id));
            if (!job) {
                // Cancellation may arrive before an in-flight start request. Keep a tombstone
                // so a delayed start/retry cannot launch an unwanted, billable generation.
                if (jobs.size >= limits.metadataJobs) {
                    throw fail(429, '요청 관리 한도에 도달했습니다.');
                }
                job = { owner, id, digest: null, state: 'running', chunks: [], size: 0,
                    createdAt: Date.now(), finishedAt: null, status: 0, contentType: '', error: '',
                    events: new EventEmitter(), upstream: null, timer: null,
                    translationTicket: null };
                jobs.set(keyOf(owner, id), job);
            }
            cancel(job);
            res.json(describe(job));
        }));
        router.post('/jobs/:id/ack', wrap((req, res) => {
            const job = lookup(ownerOf(req), req.params.id);
            if (!['completed', 'delivered'].includes(job.state) || req.body?.cursor !== job.size) {
                throw fail(409, '응답 전달이 아직 완료되지 않았습니다.');
            }
            release(job);
            // Keep just identity/status/digest to reject duplicate, billable starts.
            job.state = 'delivered';
            trace(job.owner, 'acknowledged', job.id, { bytes: job.size });
            res.json({ ok: true });
        }));
    }
    const sweep = setInterval(prune, Math.min(60000, limits.retentionMs));
    sweep.unref?.();
    function close() {
        clearInterval(sweep);
        for (const job of jobs.values()) { cancel(job); remove(job); }
        internalAgent.destroy();
        return journal?.flush();
    }
    return { install, close };
}
let relay;
const info = { id: 'silly-relay', name: 'Silly Relay', description: 'Experimental server-owned, resumable AI requests' };
async function init(router) {
    relay = createRelay({ journal: createJournal({ directory: path.join(__dirname, '..', 'diagnostic-data') }) });
    relay.install(router);
    console.log(`[Silly Relay] ${VERSION} loaded`);
}
async function exit() { await relay?.close(); }
module.exports = { info, init, exit, createRelay, internalAddress };
