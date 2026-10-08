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
const variants = message => Array.isArray(message?.swipes) ? message.swipes : [message?.mes];
const isSwipe = record => Number.isInteger(record.swipeCount) && record.swipeCount > 0;
function swipeAnchor(message, count) {
    // Selection, current text and generation timestamps change during a swipe;
    // previous candidate texts and the message identity must remain unchanged.
    return fingerprint([{ ...message, mes: '', send_date: '', swipe_id: 0,
        swipes: variants(message).slice(0, count) }]);
}
function completedPosition(record, chat) {
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (message.extra?.[MARK]?.id === record.id && message.extra[MARK].complete
            || message.swipe_info?.some(info => info?.extra?.[MARK]?.id === record.id && info.extra[MARK].complete)) {
            return { done: true, index };
        }
    }
    return null;
}
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
    isVisible = () => true, allowPreviousSession = false }) {
    let owner = null, ticket = null, generating = false, busy = false;
    const live = new Set();
    const warned = new Set();
    const receipts = new Map();
    let stopped = false;
    const storageKey = () => `${KEY}:${owner}`;
    function allRecords() {
        if (!owner) return [];
        try {
            const value = JSON.parse(storage.getItem(storageKey()) || '[]');
            return Array.isArray(value) ? value.filter(r => r && VALID_ID.test(r.id)
                && r.identity && Number.isInteger(r.count) && r.count >= 0 && Date.now() - r.created < MAX_AGE) : [];
        } catch { return []; }
    }
    function list() { return allRecords().filter(r => r.tab === tabId); }
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
        const done = completedPosition(record, chat);
        if (done) return done;
        const existing = chat.findIndex(m => m.extra?.[MARK]?.id === record.id);
        if (fingerprint(chat.slice(0, record.count)) !== record.anchor) return null;
        if (isSwipe(record)) {
            const message = chat[record.count];
            if (chat.length !== record.count + 1 || !message || message.is_user || message.is_system
                || swipeAnchor(message, record.swipeCount) !== record.swipeAnchor) return null;
            const swipes = variants(message);
            if (swipes.length === record.swipeCount) {
                const selected = message.swipe_id ?? 0;
                if (selected < record.swipeCount && message.mes !== swipes[selected]) return null;
                return { done: false, index: record.count };
            }
            if (swipes.length === record.swipeCount + 1
                && (existing === record.count || message.swipe_info?.[record.swipeCount]?.extra?.[MARK]?.id === record.id)) {
                return { done: false, index: record.count };
            }
            return null;
        }
        if (chat.length === record.count) return { done: false, index: record.count };
        if (chat.length === record.count + 1 && existing === record.count && !chat[existing].is_user) {
            return { done: false, index: existing };
        }
        return null;
    }
    function showSaved(record, saved) {
        const ctx = getContext();
        if (stopped || !isVisible() || !sameChat(chatIdentity(ctx), record.identity)) return false;
        const target = position(record, ctx.chat);
        if (target?.done) return true;
        if (generating) return false;
        // A previous page may have saved just after this page loaded the chat.
        // Display that exact durable message, without saving stale history back
        // over the file or firing generation/translation hooks a second time.
        if (!target || saved.length !== record.count + 1
            || fingerprint(saved.slice(0, record.count)) !== record.anchor
            || completedPosition(record, saved)?.index !== record.count
            || isSwipe(record) && swipeAnchor(saved[record.count], record.swipeCount) !== record.swipeAnchor) {
            warn(record, '답장은 채팅 파일에 저장돼 있지만 현재 화면의 내용이 달라 자동으로 바꾸지 않았어요. 원래 채팅을 다시 열어 주세요.');
            return false;
        }
        const message = JSON.parse(JSON.stringify(saved[record.count]));
        const replacing = target.index < ctx.chat.length;
        ctx.chat[target.index] = message;
        ctx.addOneMessage(message, replacing ? { type: 'swipe' } : {});
        notify('채팅 파일에 저장된 답장을 화면에 불러왔어요.', true);
        return true;
    }
    async function receipt(record) {
        if (stopped || !isVisible() || !sameChat(chatIdentity(getContext()), record.identity)) return false;
        // An actual read-back, not saveChat()'s return value: ST can swallow save errors.
        const saved = await diskChat(record);
        if (!completedPosition(record, saved)) return false;
        if (!showSaved(record, saved)) return false;
        try {
            if (!Number.isSafeInteger(record.bytes)) {
                const info = await api(`/jobs/${record.id}?cursor=0`, { headers: getHeaders() });
                if (info.state !== 'completed') return false;
                record = { ...record, bytes: info.bytes };
            }
            await api(`/jobs/${record.id}/ack`, { method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ cursor: record.bytes }) });
        } catch (error) {
            if (![404, 410].includes(error.httpStatus)) throw error;
        }
        change(record.id, null);
        live.delete(record.id);
        return true;
    }
    async function acknowledge(record) {
        if (receipts.has(record.id)) return receipts.get(record.id);
        const pending = receipt(record);
        receipts.set(record.id, pending);
        try { return await pending; }
        finally { receipts.delete(record.id); }
    }
    function generationStarted(type, options = {}, dryRun = false) {
        generating = !dryRun;
        ticket = !dryRun && !options.quietToLoud && [undefined, 'normal', 'regenerate', 'swipe'].includes(type)
            ? { type: type || 'normal', identity: chatIdentity(getContext()), armed: false } : null;
    }
    function dataReady(_data, dryRun) { if (ticket && !dryRun) ticket.armed = true; }
    function requestFingerprint(data) {
        // Notification extensions may append their metadata after this event.
        const { silly_pop_ios, silly_pop, ...payload } = data;
        return fingerprint([{ mes: JSON.stringify(payload) }]);
    }
    function settingsReady(data) {
        if (ticket?.armed && data && [undefined, 'normal', 'regenerate', 'swipe'].includes(data.type)) {
            ticket.requestFingerprint = requestFingerprint(data);
        }
    }
    async function prepare({ id, path, body }) {
        const data = JSON.parse(body);
        // Never turn quiet/translation/review/tool requests into character messages.
        if (!ticket?.armed || ![undefined, 'normal', 'regenerate', 'swipe'].includes(data.type)
            || path !== '/api/backends/chat-completions/generate' || (data.n || 1) > 1 || data.tools?.length) return false;
        if ((data.type === 'swipe') !== (ticket.type === 'swipe') && data.type !== undefined) return false;
        // An untyped helper request (e.g. validation) must not steal the main
        // generation's journal. Legacy untyped main requests are bound by ST's
        // final request event, without adding fields to the outgoing payload.
        if (data.type === undefined && ticket.requestFingerprint !== requestFingerprint(data)) return false;
        const currentTicket = ticket;
        ticket = null;
        await identify();
        const ctx = getContext();
        const identity = chatIdentity(ctx);
        if (!sameChat(identity, currentTicket.identity)) return false;
        const swipe = currentTicket.type === 'swipe';
        const previous = ctx.chat[ctx.chat.length - 1];
        if (swipe && (!previous || previous.is_user || previous.is_system || !Array.isArray(previous.swipes)
            || !previous.swipes.length || previous.swipe_id !== previous.swipes.length
            || previous.swipes.some(text => typeof text !== 'string'))) return false;
        const count = ctx.chat.length - (swipe ? 1 : 0);
        const record = { id, tab: tabId, identity, count, anchor: fingerprint(ctx.chat.slice(0, count)),
            name: ctx.name2, created: Date.now(), stream: !!data.stream, mainApi: 'openai',
            source: data.chat_completion_source || ctx.chatCompletionSettings?.chat_completion_source,
            includeReasoning: typeof data.include_reasoning === 'boolean' ? data.include_reasoning
                : ctx.chatCompletionSettings?.show_thoughts === true,
            model: typeof data.model === 'string' ? data.model : '', bytes: null };
        if (swipe) {
            record.swipeCount = previous.swipes.length;
            record.swipeAnchor = swipeAnchor(previous, record.swipeCount);
        }
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
            if (isSwipe(record) && (message.swipe_id !== record.swipeCount
                || swipeAnchor(message, record.swipeCount) !== record.swipeAnchor)) continue;
            message.extra ||= {};
            const alreadyComplete = message.extra[MARK]?.id === record.id && message.extra[MARK].complete;
            message.extra[MARK] = { id: record.id, complete: !!complete || !!alreadyComplete };
            const info = message.swipe_info?.[message.swipe_id ?? 0];
            if (info) { info.extra ||= {}; info.extra[MARK] = { ...message.extra[MARK] }; }
        }
    }
    async function settle() {
        for (const record of list()) {
            try {
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
            if (state.cursor !== cursor || state.next < cursor) throw new Error('복구 응답 위치가 일치하지 않습니다.');
            const bytes = Uint8Array.from(atob(state.data), c => c.charCodeAt(0));
            if (bytes.length !== state.next - cursor || state.next > 8 * 1024 * 1024) throw new Error('복구 응답 크기가 올바르지 않습니다.');
            chunks.push(bytes); cursor = state.next;
            if (state.state === 'completed' && cursor === state.bytes) break;
        }
        if (state.status < 200 || state.status >= 300) {
            // An HTTP error has no chat message to save. Release it only after
            // the full error response has been read, just like the live path.
            await api(`/jobs/${record.id}/ack`, { method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ cursor }) });
            change(record.id, null); live.delete(record.id);
            throw new Error(`AI 요청이 실패했습니다 (HTTP ${state.status}).`);
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
            if (isSwipe(record)) {
                const previous = ctx.chat[target.index];
                const previousInfo = previous.swipe_info || [{ send_date: previous.send_date,
                    gen_started: previous.gen_started, gen_finished: previous.gen_finished,
                    extra: JSON.parse(JSON.stringify(previous.extra || {})) }];
                // Keep every original candidate and its metadata byte-for-byte.
                // Replace only this request's partial slot, or append one new slot.
                const info = message.swipe_info[0];
                const extra = message.extra;
                Object.assign(message, { ...previous, ...message,
                    swipes: [...variants(previous).slice(0, record.swipeCount), message.mes],
                    swipe_id: record.swipeCount,
                    swipe_info: [...previousInfo.slice(0, record.swipeCount), info], extra });
            }
            const replacing = target.index < ctx.chat.length;
            ctx.chat[target.index] = message;
            ctx.addOneMessage(message, replacing ? { type: 'swipe' } : {});
            // Save a durable deduplication marker before other extensions can pause or throw.
            await ctx.saveChat();
            const durable = await diskChat(record);
            if (!position(record, durable)?.done) throw new Error('복구한 답장의 저장을 확인하지 못했습니다. 응답을 유지하고 다시 시도합니다.');
            if (sameChat(chatIdentity(getContext()), record.identity)) {
                try {
                    const type = isSwipe(record) ? 'swipe' : 'normal';
                    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, target.index, type);
                    if (sameChat(chatIdentity(getContext()), record.identity)) {
                        await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, target.index, type);
                        await getContext().saveChat();
                    }
                } catch { warn(record, '답장은 복구했지만 후처리 확장에서 오류가 났습니다.'); }
            }
        } else {
            // A previous save failed but the in-memory restored message is still present.
            await ctx.saveChat();
        }
        if (await acknowledge(record)) notify('다시 접속하기 전에 받던 답장을 원래 채팅에 복구했어요.', true);
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
                        // Another page/receipt may have ACKed while this read was
                        // in flight. A saved reply is not a missing reply.
                        if (await acknowledge(record)) continue;
                        if (position(record, await diskChat(record))?.done) continue;
                        change(record.id, null);
                        warn(record, error.httpStatus === 410
                            ? `요청 ${record.id.slice(0, 8)}: 서버는 전달 완료로 표시하지만 채팅 저장을 확인하지 못했어요.`
                            : `요청 ${record.id.slice(0, 8)}: 서버에서 이 요청을 찾지 못했어요 (HTTP 404). 원인은 아직 확인되지 않았어요.`);
                    } else if (!(error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name))) {
                        warn(record, error.message);
                    }
                }
            }
        } catch (error) { warn(null, error.message); }
        finally { busy = false; }
    }
    // Explicit migration for pre-test.6 PWA sessions only. Never automatically
    // take a request from an unrelated browser tab. All normal chat/disk guards
    // remain in force; this only repairs the old session binding, not chat data.
    async function recoverPreviousSession() {
        if (!allowPreviousSession || !tabId) return;
        if (busy || generating || stopped || !isVisible()) {
            notify('답장 생성이나 복구가 끝난 뒤 원래 채팅에서 다시 눌러 주세요.');
            return;
        }
        await identify();
        if (list().some(r => sameChat(r.identity, chatIdentity(getContext())))) {
            // Prefer this installation's current reply over stale legacy IDs.
            await recover();
            return;
        }
        let adopted = false;
        let record;
        busy = true;
        try {
            await identify();
            const identity = chatIdentity(getContext());
            if (!identity) throw new Error('답장을 기다리던 1:1 채팅을 먼저 열어 주세요.');
            const candidates = allRecords().filter(r => r.tab !== tabId && sameChat(r.identity, identity));
            if (!candidates.length) {
                notify('이전 실행의 대기 기록이 없어요. 기록이 삭제됐거나 이 요청이 복구 대상으로 접수되지 않았을 수 있어요.');
                return;
            }
            if (candidates.length !== 1) throw new Error('이 채팅의 이전 대기 요청이 여러 개라 자동으로 고르지 않았어요.');
            record = candidates[0];
            const saved = await diskChat(record);
            if (!position(record, saved) || !position(record, getContext().chat)) {
                throw new Error('원래 채팅과 현재 내용이 달라 복구를 멈췄어요. 기존 메시지는 변경하지 않았어요.');
            }
            if (await acknowledge(record)) return;
            const info = await api(`/jobs/${record.id}?cursor=0`, { headers: getHeaders() });
            if (info.state === 'running') throw new Error('서버에서 아직 답장을 받고 있어요. 완료된 뒤 다시 눌러 주세요.');
            if (info.state !== 'completed' || info.status < 200 || info.status >= 300) {
                throw new Error('서버에 복구할 완료 답장이 없어요.');
            }
            // The user can change chats or start a generation during these reads.
            if (generating || stopped || !isVisible() || !sameChat(chatIdentity(getContext()), identity)
                || !position(record, getContext().chat)) return;
            change(record.id, { ...record, tab: tabId, bytes: info.bytes });
            adopted = true;
        } catch (error) {
            if ([404, 410].includes(error.httpStatus)) {
                if (await acknowledge(record)) return;
                if (position(record, await diskChat(record))?.done) return;
                change(record.id, null);
                notify(`이전 요청 ${record.id.slice(0, 8)}의 응답을 찾지 못했어요 (HTTP ${error.httpStatus}). 이 안내는 현재 새로 보낸 답장의 상태와 별개예요.`);
            }
            else notify(error.message);
        } finally { busy = false; }
        if (adopted) await recover();
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
    return { prepare, event, tag, generationStarted, dataReady, settingsReady, generationEnded, generationStopped, recover, recoverPreviousSession, settle, stop, list };
}
