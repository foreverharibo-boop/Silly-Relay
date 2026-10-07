// Browser transport: no AI SDK or prompt changes.
export const API = '/api/plugins/silly-relay';
export const PATHS = new Set([
    '/api/backends/chat-completions/generate', '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate', '/api/novelai/generate', '/api/azure/generate',
]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const abortError = () => new DOMException('생성이 중지되었습니다.', 'AbortError');
function newId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function decode(data) {
    const binary = atob(data);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function createTransport({ fetchImpl, origin, enabled, onEvent = () => {},
    saveCancellation = () => {}, prepareRecovery = async () => false,
    requestTimeout = 30000, retryDelay = 1000, startRetryMs = 60000 }) {
    function emit(type, detail = {}) { try { onEvent(type, detail); } catch { /* UI never owns the request. */ } }
    async function api(path, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeout);
        try {
            const response = await fetchImpl(new URL(API + path, origin).href,
                { ...init, cache: 'no-store', signal: controller.signal });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw Object.assign(new Error(data.error || `연결 유지 서버 오류 (HTTP ${response.status})`), { httpStatus: response.status });
            }
            return await response.json();
        } catch (error) {
            if (controller.signal.aborted) throw new DOMException('서버 응답 대기 시간 초과', 'TimeoutError');
            throw error;
        } finally { clearTimeout(timer); }
    }
    async function wrappedFetch(input, init) {
        const request = input instanceof Request ? input : null;
        let url;
        try { url = new URL(request ? request.url : String(input), origin); }
        catch { return fetchImpl(input, init); }
        const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (!enabled() || method !== 'POST' || url.origin !== new URL(origin).origin || !PATHS.has(url.pathname) || url.search) {
            return fetchImpl(input, init);
        }
        let body = init?.body;
        if (body === undefined && request && !request.bodyUsed) body = await request.clone().text();
        if (typeof body !== 'string') {
            throw new Error('연결 유지 시험판은 JSON 생성 요청만 지원합니다. 시험 기능을 끈 뒤 다시 시도해 주세요.');
        }
        try { const parsed = JSON.parse(body); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); }
        catch { throw new Error('연결 유지 시험판에서 생성 요청 본문을 읽지 못했습니다.'); }
        const signal = init?.signal ?? request?.signal;
        if (signal?.aborted) throw abortError();
        const headers = new Headers(init?.headers ?? request?.headers);
        headers.set('content-type', 'application/json');
        const credentials = init?.credentials ?? request?.credentials ?? 'same-origin';
        const id = newId();
        // Persist the binding BEFORE submitting a billable request. Recoverable replies
        // are acknowledged by the chat layer only after the saved message is verified.
        const retainForRecovery = await prepareRecovery({ id, path: url.pathname, body });
        if (signal?.aborted) { emit('cancelled', { id }); throw abortError(); }
        let stopped = false;
        let detached = false;
        let streamController;
        const cleanup = () => { detached = true; signal?.removeEventListener('abort', stop); };
        async function sendCancel() {
            try {
                await api(`/jobs/${id}/cancel`, { method: 'POST', headers, credentials, body: '{}' });
                saveCancellation(id, false);
                emit('cancelled', { id });
            } catch { saveCancellation(id, true); emit('cancel-pending', { id }); }
        }
        const stop = () => {
            if (detached || stopped) return;
            stopped = true;
            saveCancellation(id, true);
            void sendCancel();
            try { streamController?.error(abortError()); } catch { /* Already closed. */ }
        };
        signal?.addEventListener('abort', stop, { once: true });
        emit('starting', { id });
        const startedAt = Date.now();
        const envelope = JSON.stringify({ id, path: url.pathname, body });
        let startInfo;
        try {
            while (!startInfo) {
                if (stopped) throw abortError();
                if (Date.now() - startedAt >= startRetryMs) throw new Error('생성 접수 확인 시간이 지났습니다. 서버 연결을 확인해 주세요.');
                try { startInfo = await api('/jobs', { method: 'POST', headers, credentials, body: envelope }); }
                catch (error) {
                    if (stopped) throw abortError();
                    // Never fall back to an ordinary AI request after uncertain delivery.
                    if (error.httpStatus || Date.now() - startedAt >= startRetryMs) throw error;
                    emit('reconnecting', { id });
                    await wait(retryDelay);
                }
            }
            if (stopped) { void sendCancel(); throw abortError(); }
            if (startInfo.state === 'cancelled') throw abortError();
            if (startInfo.state === 'delivered') throw new Error('이미 전달이 끝난 요청입니다.');
            emit('accepted', { id, reloadRecovery: !!retainForRecovery });
            let cursor = 0;
            async function acknowledge() {
                if (retainForRecovery) return;
                // This is a receipt, never another AI request. Lost receipts are harmless;
                // the unacknowledged temporary buffer also has a fixed expiry.
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        await api(`/jobs/${id}/ack`, { method: 'POST', headers, credentials, body: JSON.stringify({ cursor }) });
                        return;
                    } catch (error) {
                        if (error.httpStatus) return;
                        await wait(retryDelay);
                    }
                }
            }
            async function read() {
                for (;;) {
                    if (stopped) throw abortError();
                    try {
                        const data = await api(`/jobs/${id}?cursor=${cursor}&wait=1`, { headers, credentials });
                        if (stopped) throw abortError();
                        if (data.state === 'cancelled') throw abortError();
                        if (data.state === 'failed') throw new Error(data.error || '서버 생성 작업에 실패했습니다.');
                        return data;
                    } catch (error) {
                        if (stopped || error.name === 'AbortError') throw abortError();
                        if (error.httpStatus || !(error instanceof TypeError || error.name === 'TimeoutError')) throw error;
                        emit('reconnecting', { id });
                        await wait(retryDelay);
                    }
                }
            }
            let first;
            // Preserve the real HTTP status/content type, including AI errors.
            while (!first?.status) first = await read();
            const status = first.status;
            const responseHeaders = { 'content-type': first.contentType, 'x-silly-relay-job': id };
            if ([204, 205, 304].includes(status)) { cleanup(); void acknowledge(); return new Response(null, { status, headers: responseHeaders }); }
            const stream = new ReadableStream({
                start(controller) { streamController = controller; },
                async pull(controller) {
                    try {
                        for (;;) {
                            const data = first || await read();
                            first = null;
                            if (stopped) throw abortError();
                            if (data.cursor !== cursor || data.next < cursor) throw new Error('응답 재개 위치가 일치하지 않습니다.');
                            const bytes = decode(data.data);
                            if (data.next - cursor !== bytes.length) throw new Error('응답 크기가 일치하지 않습니다.');
                            if (bytes.length) controller.enqueue(bytes);
                            cursor = data.next;
                            if (data.state !== 'running' && cursor === data.bytes) {
                                controller.close(); cleanup(); emit('completed', { id, bytes: cursor, status });
                                void acknowledge();
                                return;
                            }
                            if (bytes.length) return;
                            // Empty long-poll/headers-only packets must keep waiting. Returning
                            // without enqueueing leaves an outstanding stream read unresolved.
                        }
                    } catch (error) { cleanup(); try { controller.error(error); } catch { /* Aborted concurrently. */ } }
                },
                cancel() { stop(); cleanup(); },
            });
            return new Response(stream, { status, headers: responseHeaders });
        } catch (error) {
            if (!error.httpStatus && !stopped) void sendCancel();
            cleanup(); emit('error', { id, message: error.message }); throw error;
        }
    }
    Object.defineProperty(wrappedFetch, '__sillyRelay', { value: true });
    return { fetch: wrappedFetch, api };
}
