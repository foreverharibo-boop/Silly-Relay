// Reload recovery: pending request IDs and chat fingerprints only; no response archive.
export const MARK = 'silly_relay';
const VALID_ID = /^[a-f0-9]{32}$/;
const KEY = 'silly-relay-recovery-v1';
const MAX_AGE = 2 * 60 * 60 * 1000;

// Change detection, not authentication. Two independent 32-bit lanes work on HTTP
// origins / older Safari too (crypto.subtle is restricted to secure contexts).
export function fingerprint(chat) {
    let a = 2166136261, b = 5381;
    const text = JSON.stringify(chat.map(m => [m.name, !!m.is_user, !!m.is_system, m.mes,
        m.send_date, m.swipe_id ?? 0, m.swipes ?? [m.mes], m.original_avatar ?? '']));
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 16777619);
        b = Math.imul(b, 33) ^ c;
    }
    return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
export function chatIdentity(ctx) {
    if (!ctx || ctx.groupId || !Array.isArray(ctx.chat)) return null;
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    const file = ctx.chatId;
    if (!avatar || !file) return null;
    return { avatar, file };
}
const sameChat = (a, b) => !!a && !!b && a.avatar === b.avatar && a.file === b.file;
const textContent = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(p => p.type === 'text' || !p.type).map(p => p.text || '').join('') : '';

export function decodeReply(raw, record, { extract, streamChunk, showThoughts = false } = {}) {
    // Recovery must not turn reasoning on. Older journals have no request flag;
    // those follow the current setting, while an explicit request opt-out stays off.
    const includeReasoning = showThoughts === true && record.includeReasoning !== false;
    let text = '', reasoning = '';
    const streamState = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    function validate(data) {
        if (data.error || data.type === 'error') throw new Error('AI 오류 응답은 채팅에 복구하지 않습니다.');
        const choices = data.choices || [];
        if (choices.some(c => c.delta?.tool_calls?.length || c.message?.tool_calls?.length || c.delta?.function_call || c.message?.function_call)
            || data.content_block?.type === 'tool_use' || data.content?.some?.(p => p.type === 'tool_use')
            || data.candidates?.some(c => c.content?.parts?.some(p => p.functionCall))) {
            throw new Error('도구 호출이 포함된 응답은 자동 복구하지 않습니다.');
        }
    }
    if (record.stream) {
        // Decode UTF-8 once after all cursor pages have been joined. Network chunk
        // boundaries may split both Korean characters and SSE records.
        const events = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
        for (const event of events) {
            const lines = event.split('\n').filter(line => line.startsWith('data:'));
            if (!lines.length) continue;
            const dataText = lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!dataText.trim() || dataText.trim() === '[DONE]') continue;
            const data = JSON.parse(dataText);
            validate(data);
            if (data.choices?.[0]?.index > 0) continue;
            if (record.mainApi === 'openai' && streamChunk) {
                text += streamChunk(data, streamState, { chatCompletionSource: record.source, overrideShowThoughts: includeReasoning });
            } else {
                const delta = data.choices?.[0]?.delta;
                text += textContent(delta?.content ?? data.choices?.[0]?.text ?? data.token ?? data.delta?.text ?? '');
                if (includeReasoning) reasoning += delta?.reasoning_content ?? delta?.reasoning ?? '';
            }
        }
        if (includeReasoning) reasoning += streamState.reasoning;
    } else {
        const data = JSON.parse(raw);
        validate(data);
        text = extract ? extract(data, record.mainApi) : textContent(data.choices?.[0]?.message?.content
            ?? data.choices?.[0]?.text ?? data.output ?? data.results?.[0]?.text ?? data.content ?? data.text);
        if (includeReasoning) reasoning = data.choices?.[0]?.message?.reasoning_content ?? data.choices?.[0]?.message?.reasoning
            ?? data.content?.filter?.(p => p.type === 'thinking').map(p => p.thinking || '').join('') ?? '';
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('복구할 텍스트 답장을 찾지 못했습니다.');
    return { text, reasoning, signature: streamState.signature || null };
}

export function createRecovery({ getContext, api, fetchImpl, getHeaders, storage, tabId,
    formatReply = async text => text, parser = async () => ({}), notify = () => {},
    isVisible = () => true }) {
    let owner = null, ticket = null, generating = false, busy = false;
    const live = new Set();
    const warned = new Set();
    let stopped = false;
    const storageKey = () => `${KEY}:${owner}`;
    function list() {
        if (!owner) return [];
        try {
            const value = JSON.parse(storage.getItem(storageKey()) || '[]');
            return Array.isArray(value) ? value.filter(r => VALID_ID.test(r.id) && r.tab === tabId
                && r.identity && Number.isInteger(r.count) && r.count >= 0 && Date.now() - r.created < MAX_AGE) : [];
        } catch { return []; }
    }
    function change(id, value) {
        let all;
        try { all = JSON.parse(storage.getItem(storageKey()) || '[]'); } catch { all = []; }
        if (!Array.isArray(all)) all = [];
        all = all.filter(r => r.id !== id && Date.now() - r.created < MAX_AGE);
        if (value) all.push(value);
        // Do not silently evict an unresolved reply.
        if (all.length > 64) throw new Error('복구 대기 요청이 너무 많습니다. 기존 요청을 먼저 확인해 주세요.');
        storage.setItem(storageKey(), JSON.stringify(all));
    }
    function warn(record, message) {
        const key = `${record?.id || ''}:${message}`;
        if (!warned.has(key)) { warned.add(key); notify(message); }
    }
    async function identify() {
        if (owner) return;
        const status = await api('/status', { headers: getHeaders() });
        if (!status.reloadRecovery || typeof status.owner !== 'string') {
            throw new Error('서버 플러그인도 0.1.0-test.3 이상으로 업데이트하고 서버를 재시작해 주세요.');
        }
        owner = status.owner;
    }
    async function diskChat(record) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetchImpl('/api/chats/get', { method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ avatar_url: record.identity.avatar, file_name: record.identity.file }),
                cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('채팅 저장 상태를 확인하지 못했습니다.');
            const data = await response.json();
            if (!Array.isArray(data) || !data[0] || !('chat_metadata' in data[0])) {
                throw new Error('원래 채팅 파일을 확인하지 못했습니다.');
            }
            return data.slice(1);
        } finally { clearTimeout(timer); }
    }
    function position(record, chat) {
        const existing = chat.findIndex(m => m.extra?.[MARK]?.id === record.id);
        if (existing >= 0 && chat[existing].extra[MARK].complete) return { done: true, index: existing };
        if (fingerprint(chat.slice(0, record.count)) !== record.anchor) return null;
        if (chat.length === record.count) return { done: false, index: record.count };
        if (chat.length === record.count + 1 && existing === record.count && !chat[existing].is_user) {
            return { done: false, index: existing };
        }
        return null;
    }
    async function acknowledge(record) {
        if (!Number.isSafeInteger(record.bytes)) return false;
        // An actual read-back, not saveChat()'s return value: ST can swallow save errors.
        const saved = await diskChat(record);
        if (!saved.some(m => m.extra?.[MARK]?.id === record.id && m.extra[MARK].complete)) return false;
        try {
            await api(`/jobs/${record.id}/ack`, { method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ cursor: record.bytes }) });
        } catch (error) {
            if (![404, 410].includes(error.httpStatus)) throw error;
        }
        change(record.id, null);
        live.delete(record.id);
        return true;
    }
    function generationStarted(type, options = {}, dryRun = false) {
        generating = !dryRun;
        ticket = !dryRun && !options.quietToLoud && [undefined, 'normal', 'regenerate'].includes(type)
            ? { type: type || 'normal', identity: chatIdentity(getContext()), armed: false } : null;
    }
    function dataReady(_data, dryRun) { if (ticket && !dryRun) ticket.armed = true; }
    async function prepare({ id, path, body }) {
        const data = JSON.parse(body);
        // Never turn quiet/translation/review/tool requests into character messages.
        if (!ticket?.armed || ![undefined, 'normal', 'regenerate'].includes(data.type)
            || path !== '/api/backends/chat-completions/generate' || (data.n || 1) > 1 || data.tools?.length) return false;
        const currentTicket = ticket;
        ticket = null;
        await identify();
        const ctx = getContext();
        const identity = chatIdentity(ctx);
        if (!sameChat(identity, currentTicket.identity)) return false;
        const record = { id, tab: tabId, identity, count: ctx.chat.length, anchor: fingerprint(ctx.chat),
            name: ctx.name2, created: Date.now(), stream: !!data.stream, mainApi: 'openai',
            source: data.chat_completion_source || ctx.chatCompletionSettings?.chat_completion_source,
            includeReasoning: typeof data.include_reasoning === 'boolean' ? data.include_reasoning
                : ctx.chatCompletionSettings?.show_thoughts === true,
            model: typeof data.model === 'string' ? data.model : '', bytes: null };
        // ST already saves a normal user message before generating. Do not call
        // saveChat or read the entire chat on this critical path: a delayed save,
        // older file header or other extension must not block answer generation.
        // The strict disk/chat checks still run before recovery writes and ACKs.
        try {
            change(id, record);
            if (!list().some(r => r.id === id)) throw new Error('브라우저에 복구 정보를 기록하지 못했습니다.');
        } catch (error) {
            try { change(id, null); } catch { /* Storage may be unavailable. */ }
            throw error;
        }
        live.add(id);
        return true;
    }
    function event(type, data) {
        const record = list().find(r => r.id === data.id);
        if (!record) return;
        if (type === 'recovery-unavailable') {
            live.delete(record.id);
            try { change(record.id, null); } catch { /* Storage may be unavailable. */ }
        } else if (type === 'completed') {
            if (data.status < 200 || data.status >= 300) { change(record.id, null); live.delete(record.id); return; }
            change(record.id, { ...record, bytes: data.bytes });
            // Don't let the stream read EOF delete data before ST saves the chat.
            setTimeout(() => { if (!stopped) void settle(); }, 500);
        } else if (type === 'cancelled' || type === 'cancel-pending') {
            change(record.id, null); live.delete(record.id);
        } else if (type === 'error') live.delete(record.id);
    }
    function tag(messageIndex, complete) {
        const ctx = getContext();
        if (!ctx || !Array.isArray(ctx.chat)) return;
        for (const record of list()) {
            if (!live.has(record.id) || !sameChat(chatIdentity(ctx), record.identity)) continue;
            const index = Number.isInteger(messageIndex) ? messageIndex : ctx.chat.length - 1;
            const message = ctx.chat[index];
            if (index !== record.count || !message || message.is_user) continue;
            if (message.extra?.[MARK]?.id !== record.id && fingerprint(ctx.chat.slice(0, record.count)) !== record.anchor) continue;
            message.extra ||= {};
            message.extra[MARK] = { id: record.id, complete: !!complete || !!message.extra[MARK]?.complete };
            const info = message.swipe_info?.[message.swipe_id ?? 0];
            if (info) { info.extra ||= {}; info.extra[MARK] = { ...message.extra[MARK] }; }
        }
    }
    async function settle() {
        for (let record of list()) {
            try {
                if (!Number.isSafeInteger(record.bytes)) {
                    const ctx = getContext();
                    // Some SSE consumers stop at [DONE] before pulling transport EOF.
                    if (!sameChat(chatIdentity(ctx), record.identity) || !position(record, ctx.chat)?.done) continue;
                    const info = await api(`/jobs/${record.id}?cursor=0`, { headers: getHeaders() });
                    if (info.state !== 'completed') continue;
                    record = { ...record, bytes: info.bytes }; change(record.id, record);
                }
                await acknowledge(record);
            } catch { /* Keep response until a verified save. */ }
        }
    }
    async function readReply(record) {
        const chunks = [];
        let cursor = 0, state;
        for (;;) {
            if (stopped || !isVisible() || !sameChat(chatIdentity(getContext()), record.identity) || generating) return null;
            state = await api(`/jobs/${record.id}?cursor=${cursor}&wait=1`, { headers: getHeaders() });
            if (['failed', 'cancelled'].includes(state.state)) {
                change(record.id, null);
                throw new Error(state.error || '생성이 중지되었습니다.');
            }
            if (state.status && (state.status < 200 || state.status >= 300)) {
                change(record.id, null);
                throw new Error(`AI 요청이 실패했습니다 (HTTP ${state.status}).`);
            }
            if (state.cursor !== cursor || state.next < cursor) throw new Error('복구 응답 위치가 일치하지 않습니다.');
            const bytes = Uint8Array.from(atob(state.data), c => c.charCodeAt(0));
            if (bytes.length !== state.next - cursor || state.next > 8 * 1024 * 1024) throw new Error('복구 응답 크기가 올바르지 않습니다.');
            chunks.push(bytes); cursor = state.next;
            if (state.state === 'completed' && cursor === state.bytes) break;
        }
        const joined = new Uint8Array(cursor);
        let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
        record = { ...record, bytes: cursor };
        change(record.id, record);
        return { record, raw: new TextDecoder().decode(joined), finishedAt: state.finishedAt };
    }
    async function apply(record, reply, finishedAt) {
        let ctx = getContext();
        if (generating || !sameChat(chatIdentity(ctx), record.identity)) return false;
        const saved = await diskChat(record);
        if (position(record, saved)?.done) { await acknowledge(record); return true; }
        if (!position(record, saved)) throw new Error('서버의 채팅 내용이 바뀌어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.');
        const text = await formatReply(reply.text);
        if (!text.trim()) throw new Error('답장 정리 후 복구할 본문이 없습니다.');
        ctx = getContext();
        if (generating || !isVisible() || !sameChat(chatIdentity(ctx), record.identity)) return false;
        const target = position(record, ctx.chat);
        if (!target) throw new Error('채팅에 새 메시지나 수정이 있어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.');
        if (!target.done) {
            const message = { name: record.name, is_user: false, is_system: false,
                send_date: new Date(finishedAt || Date.now()).toISOString(), mes: text,
                gen_started: new Date(record.created).toISOString(), gen_finished: new Date(finishedAt || Date.now()).toISOString(),
                extra: { api: 'openai', model: record.model,
                    reasoning: ctx.chatCompletionSettings?.show_thoughts === true ? reply.reasoning || '' : '',
                    reasoning_signature: reply.signature, [MARK]: { id: record.id, complete: true, recovered: true } },
                swipe_id: 0, swipes: [text] };
            message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started,
                gen_finished: message.gen_finished, extra: JSON.parse(JSON.stringify(message.extra)) }];
            const replacing = target.index < ctx.chat.length;
            ctx.chat[target.index] = message;
            ctx.addOneMessage(message, replacing ? { type: 'swipe' } : {});
            // Save a durable deduplication marker before other extensions can pause or throw.
            await ctx.saveChat();
            const durable = await diskChat(record);
            if (!position(record, durable)?.done) throw new Error('복구한 답장의 저장을 확인하지 못했습니다. 응답을 유지하고 다시 시도합니다.');
            if (sameChat(chatIdentity(getContext()), record.identity)) {
                try {
                    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, target.index, 'normal');
                    if (sameChat(chatIdentity(getContext()), record.identity)) {
                        await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, target.index, 'normal');
                        await getContext().saveChat();
                    }
                } catch { warn(record, '답장은 복구했지만 후처리 확장에서 오류가 났습니다.'); }
            }
        } else {
            // A previous save failed but the in-memory restored message is still present.
            await ctx.saveChat();
        }
        if (await acknowledge(record)) notify('새로고침 전에 받던 답장을 원래 채팅에 복구했어요.', true);
        return true;
    }
    async function recover() {
        if (busy || generating || stopped || !isVisible()) return;
        busy = true;
        try {
            await identify();
            await settle();
            for (const record of list()) {
                if (live.has(record.id) || !sameChat(chatIdentity(getContext()), record.identity)) continue;
                try {
                    const data = await readReply(record);
                    if (!data) continue;
                    const reply = decodeReply(data.raw, data.record, { ...await parser(),
                        showThoughts: getContext()?.chatCompletionSettings?.show_thoughts === true });
                    await apply(data.record, reply, data.finishedAt);
                } catch (error) {
                    if ([404, 410].includes(error.httpStatus)) {
                        change(record.id, null);
                        warn(record, '복구 응답이 만료됐거나 서버가 재시작되어 이 답장을 복구할 수 없습니다.');
                    } else if (!(error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name))) {
                        warn(record, error.message);
                    }
                }
            }
        } catch (error) { warn(null, error.message); }
        finally { busy = false; }
    }
    function generationEnded() {
        generating = false; ticket = null;
        setTimeout(() => { if (!stopped) void settle(); }, 500);
    }
    function generationStopped() {
        generationEnded();
        for (const record of list()) {
            if (!live.has(record.id)) continue;
            change(record.id, null); live.delete(record.id);
        }
    }
    function stop() { stopped = true; }
    return { prepare, event, tag, generationStarted, dataReady, generationEnded, generationStopped, recover, settle, stop, list };
}
