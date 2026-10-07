'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const VERSION = '0.1.0-test.2';
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
function ownerOf(req) {
    const owner = req.user?.profile?.handle;
    if (typeof owner !== 'string' || !owner) throw fail(401, '실리태번 로그인 상태를 확인해 주세요.');
    return owner;
}

// Temporary transport buffers only. No archive, result history or disk storage.
function createRelay(overrides = {}) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
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
            if (job.state !== 'running' && now - job.finishedAt > limits.retentionMs) remove(job);
        }
    }
    function finish(job, state, error = '') {
        if (job.state !== 'running') return;
        job.state = state;
        job.error = error;
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        job.upstream = null;
        if (state === 'failed' || state === 'cancelled') release(job);
        job.events.emit('change');
        // Metadata only. Never log the body, character names, cookies or keys.
        console.log(`[Silly Relay] ${job.id.slice(0, 8)} ${state} (${job.size} bytes)`);
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
        if (Buffer.byteLength(body) > limits.requestBytes) throw fail(413, '시험판 요청 크기 한도를 초과했습니다.');
        try {
            const parsed = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch { throw fail(400, '생성 요청 본문은 JSON 객체여야 합니다.'); }
        prune();
        const digest = createHash('sha256').update(path).update('\0').update(body).digest('hex');
        const existing = jobs.get(keyOf(owner, id));
        if (existing) {
            if (existing.digest && existing.digest !== digest) throw fail(409, '같은 작업 번호에 다른 요청이 들어왔습니다.');
            return existing; // A lost start response must not cause a second AI request.
        }
        // Use the actual accepted server socket, never a URL or port supplied by a client.
        // This prototype supports HTTP ST servers, including HTTPS terminated by a reverse proxy.
        if (req.socket.encrypted) throw fail(409, '시험판은 실리태번 자체 HTTPS 모드를 아직 지원하지 않습니다.');
        if (!req.socket.localAddress || !req.socket.localPort) throw fail(503, '실리태번 서버 주소를 확인할 수 없습니다.');
        const pending = [...jobs.values()].filter(j => j.state === 'running' || j.state === 'completed');
        const active = pending.filter(j => j.state === 'running');
        if (jobs.size >= limits.metadataJobs || pending.length >= limits.jobs || pending.filter(j => j.owner === owner).length >= limits.perUserJobs
            || totalBytes >= limits.totalBytes || active.length >= limits.active
            || active.filter(j => j.owner === owner).length >= limits.perUserActive) {
            throw fail(429, '전송 대기 또는 동시 생성 한도에 도달했습니다. 잠시 기다려 주세요.');
        }
        const job = { owner, id, digest, state: 'running', chunks: [], size: 0,
            createdAt: Date.now(), finishedAt: null, status: 0, contentType: '', error: '',
            events: new EventEmitter(), upstream: null, timer: null };
        jobs.set(keyOf(owner, id), job);
        const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            'accept-encoding': 'identity', connection: 'close' };
        // Authenticate the internal HTTP request through ST's own middleware again.
        for (const name of ['cookie', 'authorization', 'x-csrf-token', 'x-silly-pop', 'accept', 'host']) {
            if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        }
        let address = req.socket.localAddress;
        if (address.startsWith('::ffff:')) address = address.slice(7);
        const upstream = http.request({ hostname: address, port: req.socket.localPort,
            path, method: 'POST', headers, agent: false }, response => {
            job.status = response.statusCode || 502;
            job.contentType = String(response.headers['content-type'] || 'application/octet-stream');
            job.events.emit('change');
            const encoding = response.headers['content-encoding'];
            if (encoding && encoding !== 'identity') {
                finish(job, 'failed', '압축된 서버 응답은 이 시험판에서 지원하지 않습니다.');
                upstream.destroy();
                return;
            }
            // Always drain upstream. A suspended/disconnected browser never owns this socket.
            response.on('data', chunk => {
                if (job.state !== 'running') return;
                if (job.size + chunk.length > limits.responseBytes || totalBytes + chunk.length > limits.totalBytes) {
                    finish(job, 'failed', '시험판 응답 전송 크기 한도를 초과했습니다.');
                    upstream.destroy();
                    return;
                }
                job.chunks.push(Buffer.from(chunk));
                job.size += chunk.length;
                totalBytes += chunk.length;
                job.events.emit('change');
            });
            response.once('end', () => finish(job, 'completed'));
            response.once('aborted', () => finish(job, 'failed', '실리태번과 AI 사이 응답이 중간에 끊겼습니다.'));
            response.once('error', () => finish(job, 'failed', '서버 응답을 읽지 못했습니다.'));
        });
        job.upstream = upstream;
        upstream.once('error', () => finish(job, 'failed', '서버 내부 생성 요청에 실패했습니다.'));
        job.timer = setTimeout(() => {
            finish(job, 'failed', '생성 대기 시간이 20분을 넘었습니다.');
            upstream.destroy();
        }, limits.timeoutMs);
        job.timer.unref?.();
        upstream.end(body);
        return job;
    }
    function install(router) {
        const wrap = handler => (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try { return handler(req, res); }
            catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : '서버 처리 오류입니다.' }); }
        };
        router.get('/status', wrap((req, res) => {
            ownerOf(req);
            res.json({ version: VERSION, protocol: 2, ready: !req.socket.encrypted });
        }));
        router.post('/jobs', wrap((req, res) => res.status(202).json(describe(start(req)))));
        router.get('/jobs/:id', wrap((req, res) => {
            const job = lookup(ownerOf(req), req.params.id);
            if (job.state === 'delivered') throw fail(410, '전달이 끝난 응답은 즉시 삭제됩니다.');
            const cursor = Number(req.query.cursor || 0);
            if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.size) throw fail(400, '잘못된 응답 위치입니다.');
            const send = () => { cleanup(); if (!res.destroyed && !res.writableEnded) res.json(snapshot(job, cursor)); };
            const cleanup = () => {
                clearTimeout(timer);
                job.events.removeListener('change', send);
                res.removeListener('close', cleanup);
            };
            let timer;
            if (job.size > cursor || job.state !== 'running' || req.query.wait !== '1') return send();
            timer = setTimeout(send, limits.pollMs);
            job.events.on('change', send);
            res.once('close', cleanup); // Disconnect only removes this reader, never the job.
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
                    events: new EventEmitter(), upstream: null, timer: null };
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
            res.json({ ok: true });
        }));
    }
    const sweep = setInterval(prune, Math.min(60000, limits.retentionMs));
    sweep.unref?.();
    function close() {
        clearInterval(sweep);
        for (const job of jobs.values()) { cancel(job); remove(job); }
    }
    return { install, close };
}
let relay;
const info = { id: 'silly-relay', name: 'Silly Relay', description: 'Experimental server-owned, resumable AI requests' };
async function init(router) {
    relay = createRelay();
    relay.install(router);
    console.log(`[Silly Relay] ${VERSION} loaded`);
}
async function exit() { relay?.close(); }
module.exports = { info, init, exit, createRelay };
