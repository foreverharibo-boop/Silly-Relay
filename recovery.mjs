import { recoveryReason } from './recovery-reasons.mjs?v=1.0.23';
// Reload recovery: pending request IDs and chat fingerprints only; no response archive.
export const MARK = 'silly_relay';
const VALID_ID = /^[a-f0-9]{32}$/;
const KEY = 'silly-relay-recovery-v1';
const MAX_AGE = 2 * 60 * 60 * 1000;
const needsReview = record => record.resumeReview === 1 ? !!record.reviewOwner
    : !!(record.jobs || record.reviewing) && !record.finalized;

// Only used to recognize an already saved, unmarked reply. Never write this
// projection back to chat: tags and their contents belong to the user/extensions.
export function replyBody(text) {
    if (typeof text !== 'string') return '';
    const tokens = /<!--[^]*?-->|<\/?[\p{L}_][\p{L}\p{N}_.:-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gu;
    const stack = [], ranges = [];
    for (const match of text.matchAll(tokens)) {
        const token = match[0], start = match.index, end = start + token.length;
        if (token.startsWith('<!--') || /\/\s*>$/.test(token)) { ranges.push([start, end]); continue; }
        const name = token.match(/^<\/?([^\s/>]+)/)[1].toLowerCase();
        if (token.startsWith('</')) {
            const index = stack.findLastIndex(open => open.name === name);
            if (index >= 0) { ranges.push([stack[index].start, end]); stack.length = index; }
        } else stack.push({ name, start });
    }
    // Unclosed tags are deliberately retained; they cannot hide the remaining
    // answer or make unrelated replies match. Nested/overlapping pairs merge.
    ranges.sort((a, b) => a[0] - b[0]);
    let body = '', cursor = 0;
    for (const [start, end] of ranges) {
        if (start > cursor) body += text.slice(cursor, start);
        cursor = Math.max(cursor, end);
    }
    return (body + text.slice(cursor)).trim();
}
const sameReplyBody = (left, right) => !!replyBody(left) && replyBody(left) === replyBody(right);

// Save conflict checks include all JSON message fields, unlike the body-only
// identity used by old journals. Key order alone is not a change.
function sameSavedValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object'
        || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
        && keys.every(key => Object.hasOwn(b, key) && sameSavedValue(a[key], b[key]));
}
function preservesSavedChanges(base, latest, local) {
    if (sameSavedValue(base, latest)) return true;
    if (!latest || !local || typeof latest !== 'object' || typeof local !== 'object'
        || Array.isArray(latest) !== Array.isArray(local)) return sameSavedValue(latest, local);
    if (Array.isArray(latest) && latest.length !== local.length) return false;
    const before = base && typeof base === 'object' ? base : {};
    return [...new Set([...Object.keys(before), ...Object.keys(latest)])].every(key => {
        if (!Object.hasOwn(latest, key)) return !Object.hasOwn(local, key);
        if (!Object.hasOwn(before, key) && !Object.hasOwn(local, key)) return false;
        return preservesSavedChanges(before[key], latest[key], local[key]);
    });
}

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
    const matches = mark => mark?.id === record.id && mark.complete
        && ((mark.revision || 0) === (record.revision || 0));
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (matches(message.extra?.[MARK]) || message.swipe_info?.some(info => matches(info?.extra?.[MARK]))) {
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
    let text = '', reasoning = '', recognizedReply = false, rawReplyPresent = false;
    const streamState = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    function validate(data) {
        if (data.error || data.type === 'error') throw Object.assign(
            new Error('AI 오류 응답은 채팅에 복구하지 않습니다.'), { candidateRejected: true });
        const choices = data.choices || [];
        const fields = [
            ...choices.flatMap(c => [c.message?.content, c.delta?.content, c.text]),
            data.output, data.content, data.text, data.token, data.results?.[0]?.text, data.delta?.text,
        ];
        for (const value of fields) {
            const known = typeof value === 'string' || value === null
                || Array.isArray(value) && value.every(p => p && ['text', 'thinking'].includes(p.type));
            if (!known) continue;
            recognizedReply = true;
            rawReplyPresent ||= !!textContent(value).trim();
        }
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
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(
        new Error('복구할 텍스트 답장을 찾지 못했습니다.'),
        { candidateRejected: recognizedReply && !rawReplyPresent && typeof text === 'string' && !text.trim() });
    return { text, reasoning, signature: streamState.signature || null };
}

export function createRecovery({ getContext, api, fetchImpl, getHeaders, storage, tabId,
    formatReply = async text => text, parser = async () => ({}), notify = () => {}, diagnostic = () => {},
    isVisible = () => true, allowPreviousSession = false, captureReplyReceipt = () => null,
    confirmUnreviewed = async () => false, trace: observer = () => {}, onIdentity = () => {},
    resumeReview = async () => null, retrySave = null }) {
    function trace(stage, record, detail = {}) {
        try { observer(stage, { id: record?.id, jobId: record?.jobId || record?.id,
            selectedId: record?.selectedId, count: record?.count, revision: record?.revision,
            reviewer: record?.reviewOwner,
            reviewPending: !!record && needsReview(record), ...detail }); } catch { /* Diagnostics cannot affect recovery. */ }
    }
    let owner = null, ticket = null, generating = false, busy = false;
    const generationParents = [];
    const live = new Set();
    const warned = new Set();
    const pendingReviews = new Map();
    const receipts = new Map();
    const quickReceipts = new Map();
    const processing = new Set();
    const sequences = new WeakSet();
    // Actual capabilities in this page, not persisted "reviewing" flags. A
    // reload may resume a checkpoint, but must never wait on a dead page's task.
    const reviewRuns = new Map();
    function trackReview(sequence, record) {
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        const abort = () => cancelSequence(sequence);
        reviewRuns.set(record.id, { sequence, revision: record.revision, done, finish, abort });
        sequence.signal?.addEventListener('abort', abort, { once: true });
    }
    function finishReview(sequence) {
        const run = reviewRuns.get(sequence.id);
        if (run?.sequence !== sequence) return;
        reviewRuns.delete(sequence.id);
        sequence.signal?.removeEventListener('abort', run.abort);
        run.finish();
    }
    async function waitForReview(id, valid) {
        let observed;
        while (reviewRuns.has(id)) {
            const run = reviewRuns.get(id);
            const record = list().find(item => item.id === id);
            if (!record || !valid() || run.sequence.signal?.aborted) {
                cancelSequence(run.sequence);
                trace('review_wait_interrupted', record, { reason: 'context_changed' });
                return false;
            }
            if (run !== observed) { trace('review_waiting', record); observed = run; }
            // Completion wakes immediately; the timer only checks page/chat
            // changes and the existing retention deadline, never calls the AI.
            let timer;
            try { await Promise.race([run.done, new Promise(resolve => { timer = setTimeout(resolve, 250); })]); }
            finally { clearTimeout(timer); }
        }
        return valid();
    }
    // Volatile capabilities, not journal data. After a page reload the old
    // 429die timers are gone too; never attach an old recovery to a new request.
    const replyReceipts = new Map();
    const sources = record => record.jobs || [record];
    const sourceId = record => record.jobId || record.id;
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
    const unchanged = record => JSON.stringify(allRecords().find(r => r.id === record.id)) === JSON.stringify(record);
    function change(id, value) {
        let all;
        try { all = JSON.parse(storage.getItem(storageKey()) || '[]'); } catch { all = []; }
        if (!Array.isArray(all)) all = [];
        all = all.filter(r => r.id !== id && Date.now() - r.created < MAX_AGE);
        if (value) all.push(value);
        // Do not silently evict an unresolved reply.
        if (all.length > 64) throw new Error('복구 대기 요청이 너무 많습니다. 기존 요청을 먼저 확인해 주세요.');
        storage.setItem(storageKey(), JSON.stringify(all));
        if (!value) {
            replyReceipts.delete(id); pendingReviews.delete(id);
            clearTimeout(quickReceipts.get(id)?.timer); quickReceipts.delete(id);
        }
    }
    function reportVisibleReply(record) {
        if (record.reviewing && !record.finalized || record.jobs && !record.finalized) return;
        const receipt = replyReceipts.get(record.id);
        replyReceipts.delete(record.id);
        try { receipt?.received?.(); } catch { /* Retry integration cannot interrupt recovery/save. */ }
    }
    function warn(record, message) {
        trace('warning', record, { reason: recoveryReason({ message }) });
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
        try { onIdentity(owner); } catch { /* Optional diagnostics. */ }
    }
    async function diskChat(record) {
        trace('disk_read', record);
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
        } catch (error) { trace('disk_read_failed', record, { reason: recoveryReason(error) }); throw error; }
        finally { clearTimeout(timer); }
    }
    function position(record, chat) {
        const done = completedPosition(record, chat);
        if (done) return done;
        const existing = chat.findIndex(m => m.extra?.[MARK]?.id === record.id);
        if (fingerprint(chat.slice(0, record.count)) !== record.anchor) return null;
        const hasReviewTarget = record.reviewBase && chat[record.count]
            && (!isSwipe(record) || variants(chat[record.count]).length > record.swipeCount);
        if (hasReviewTarget
            && fingerprint([chat[record.count]]) !== record.reviewBase) return null;
        if (hasReviewTarget && chat.length === record.count + 1
            && !chat[record.count].is_user && !chat[record.count].is_system) {
            // Some native paths saved the received draft before our receive
            // hook could tag it. Require the exact known draft, not text alone.
            return { done: false, index: record.count };
        }
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
    function exactSavedReply(record, chat, text) {
        // Some post-processing paths save the answer without our completion
        // marker. Text alone is not a receipt: require the original history,
        // exact slot, character and (for swipes) all previous candidates too.
        if (chat.length !== record.count + 1
            || fingerprint(chat.slice(0, record.count)) !== record.anchor) return false;
        const message = chat[record.count];
        if (!message || message.is_user || message.is_system || message.name !== record.name
            || !sameReplyBody(message.mes, text)) return false;
        const selected = message.swipe_id ?? 0;
        if (message.extra?.[MARK]?.id && message.extra[MARK].id !== record.id) return false;
        const candidateMark = message.swipe_info?.[selected]?.extra?.[MARK];
        if (candidateMark?.id && candidateMark.id !== record.id) return false;
        if (isSwipe(record)) {
            return selected === record.swipeCount && variants(message).length === record.swipeCount + 1
                && sameReplyBody(variants(message)[selected], text)
                && swipeAnchor(message, record.swipeCount) === record.swipeAnchor;
        }
        return selected === 0 && variants(message).length === 1 && sameReplyBody(variants(message)[0], text);
    }
    function showSaved(record, saved) {
        const ctx = getContext();
        if (stopped || !isVisible() || !sameChat(chatIdentity(ctx), record.identity)) return false;
        const target = position(record, ctx.chat);
        if (target?.done) {
            if (!sameCompletedReply(record, ctx.chat, saved)) {
                // A completion mark on a different slot/character/revision is
                // not our receipt. Do not blame ordinary edits or overwrite it.
                return false;
            }
            reportVisibleReply(record); return true;
        }
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
        reportVisibleReply(record);
        trace('saved_display_applied', record);
        notify('채팅 파일에 저장된 답장을 화면에 불러왔어요.', true);
        return true;
    }
    function completedReply(record, chat) {
        const found = completedPosition(record, chat);
        if (!found || found.index !== record.count) return null;
        const message = chat[found.index];
        if (message.is_user || message.is_system || message.name !== record.name) return null;
        const matches = mark => mark?.id === record.id && mark.complete
            && ((mark.revision || 0) === (record.revision || 0));
        const selected = message.swipe_id ?? 0;
        const slot = message.swipe_info?.findIndex(info => matches(info?.extra?.[MARK])) ?? -1;
        const swipe = slot >= 0 ? slot : matches(message.extra?.[MARK]) ? selected : -1;
        if (swipe < 0 || isSwipe(record) && swipe !== record.swipeCount) return null;
        const text = swipe === selected ? message.mes : message.swipes?.[swipe];
        if (typeof text !== 'string') return null;
        // This is a delivery receipt, not a perpetual comparison of the reply.
        // Once this exact request/revision is complete in memory and on disk,
        // edits, tag changes, translation metadata and swipe text sync belong
        // to ST/the user. Retire the journal without rewriting either version.
        return JSON.stringify([found.index, swipe, message.name, record.id, record.revision || 0]);
    }
    function sameCompletedReply(record, left, right) {
        const a = completedReply(record, left), b = completedReply(record, right);
        return a !== null && b !== null && sameSavedValue(JSON.parse(a), JSON.parse(b));
    }
    async function release(record) {
        trace('release_started', record);
        // The logical reply owns every draft buffer. Release them only after
        // the selected reply has a durable chat receipt, never after a draft.
        for (const job of sources(record)) {
            try {
                const jobId = sourceId(job);
                const info = await api(`/jobs/${jobId}?cursor=0`, { headers: getHeaders() });
                if (info.state === 'running') return false;
                if (info.state !== 'completed') continue;
                await api(`/jobs/${jobId}/ack`, { method: 'POST', headers: getHeaders(),
                    body: JSON.stringify({ cursor: info.bytes }) });
            } catch (error) {
                if (![404, 410].includes(error.httpStatus)) throw error;
            }
        }
        trace('released', record);
        return true;
    }
    async function receipt(record) {
        if (record.autoRecoveryPaused || needsReview(record) || record.postprocessPending || processing.has(record.id)) return false;
        if (stopped || !isVisible() || !sameChat(chatIdentity(getContext()), record.identity)) return false;
        // An actual read-back, not saveChat()'s return value: ST can swallow save errors.
        const saved = await diskChat(record);
        // A receive hook can promote a completed draft while this read is in
        // flight. An old draft receipt must not release its newer revision.
        const current = allRecords().find(r => r.id === record.id);
        if (!current || current.revision !== record.revision || current.jobId !== record.jobId
            || needsReview(current) || processing.has(record.id)) return false;
        if (!completedPosition(record, saved)) { trace('record_skipped', record, { reason: 'not_saved' }); return false; }
        if (!showSaved(record, saved)) { trace('record_skipped', record, { reason: 'display_mismatch' }); return false; }
        trace('durable_verified', record);
        if (record.jobs && !record.finalized && live.has(record.id)) return false;
        if (!await release(record)) return false;
        change(record.id, null);
        live.delete(record.id);
        return true;
    }
    async function acknowledge(record) {
        if (receipts.has(record.id)) return receipts.get(record.id);
        const pending = receipt(record);
        receipts.set(record.id, pending);
        try { return await pending; }
        finally { receipts.delete(record.id); scheduleReceipt(record.id); }
    }
    function scheduleReceipt(id) {
        const record = list().find(r => r.id === id);
        if (stopped || !record || record.autoRecoveryPaused || needsReview(record) || processing.has(id)
            || !isVisible() || !sameChat(chatIdentity(getContext()), record.identity)) return;
        const state = quickReceipts.get(id) || { attempts: 0, timer: null };
        if (state.timer || state.attempts >= 6) return;
        state.timer = setTimeout(async () => {
            state.timer = null;
            const current = list().find(r => r.id === id);
            if (stopped || !current || !isVisible()
                || !sameChat(chatIdentity(getContext()), current.identity)) return;
            state.attempts++;
            try { await acknowledge(current); } catch { /* Periodic recovery remains a fallback. */ }
        }, 500);
        quickReceipts.set(id, state);
    }
    function queueReceipts() {
        for (const record of list()) scheduleReceipt(record.id);
    }
    function generationStarted(type, options = {}, dryRun = false) {
        // ST prompt previews return without GENERATION_ENDED. They must not
        // suspend a real generation or leave its parent state stranded later.
        if (dryRun) return;
        generationParents.push({ ticket, generating });
        generating = !dryRun;
        ticket = !dryRun && !options.quietToLoud && [undefined, 'normal', 'regenerate', 'swipe'].includes(type)
            ? { type: type || 'normal', identity: chatIdentity(getContext()), armed: false } : null;
    }
    function dataReady(_data, dryRun) { if (ticket && !dryRun) ticket.armed = true; }
    function requestFingerprint(data) {
        // Notification extensions may append their metadata after this event.
        const { silly_pop_ios, silly_pop, silly_pop_and, __ttotto_main_request, ...payload } = data;
        return fingerprint([{ mes: JSON.stringify(payload) }]);
    }
    function settingsReady(data) {
        if (ticket?.armed && data && [undefined, 'normal', 'regenerate', 'swipe'].includes(data.type)) {
            ticket.request = data;
        }
    }
    const reviewStep = (owner, checkpoint) => /^[a-z][a-z0-9-]{0,39}$/.test(owner || '')
        && checkpoint && typeof checkpoint === 'object' ? { owner, checkpoint: structuredClone(checkpoint) } : null;
    function expectReview(owner, checkpoint) {
        if (!ticket || !sameChat(ticket.identity, chatIdentity(getContext()))) return false;
        ticket.review = reviewStep(owner, checkpoint);
        return !!ticket.review;
    }
    function beginSequence(options = {}) {
        if (!ticket?.armed || !sameChat(ticket.identity, chatIdentity(getContext()))) return null;
        const sequence = { ticket, id: null, closed: false };
        const current = reviewStep(options.owner, options.checkpoint);
        if (current) sequence.recovery = { version: 1, current,
            ...(ticket.review ? { after: ticket.review } : {}) };
        ticket = null;
        sequences.add(sequence);
        return sequence;
    }
    function resumeSequence(record, context) {
        if (reviewRuns.has(record.id) || generating || !unchanged(record) || !sameChat(record.identity, chatIdentity(getContext()))
            || stopped || !isVisible()) return null;
        const sequence = { id: record.id, closed: false, resuming: true,
            ticket: { armed: true, type: isSwipe(record) ? 'swipe' : 'normal', identity: record.identity },
            recovery: structuredClone(context) };
        delete sequence.recovery.body;
        sequences.add(sequence);
        trackReview(sequence, record);
        return sequence;
    }
    function beginReview(index, message, signal, options = {}) {
        const ctx = getContext(), identity = chatIdentity(ctx);
        if (!identity || signal?.aborted || ctx.chat[index] !== message || ctx.chat.length !== index + 1
            || message.is_user || message.is_system) return null;
        const candidates = list().filter(record => {
            // Native non-streaming swipes inherit the PREVIOUS candidate's
            // message.extra until receive hooks finish. Inspect the new slot.
            const markedId = isSwipe(record) ? message.swipe_info?.[record.swipeCount]?.extra?.[MARK]?.id
                : message.extra?.[MARK]?.id;
            return record.count === index && sameChat(record.identity, identity)
                && (!record.reviewing || options.resuming && record.resumeReview === 1 && record.reviewOwner === options.owner)
                && (!markedId || markedId === record.id)
                && fingerprint(ctx.chat.slice(0, index)) === record.anchor
                && (!isSwipe(record) || message.swipe_id === record.swipeCount
                    && swipeAnchor(message, record.swipeCount) === record.swipeAnchor);
        });
        if (candidates.length !== 1) return null;
        const original = candidates[0];
        if (reviewRuns.has(original.id)) return null;
        const jobs = original.jobs || [{ id: original.id, stream: original.stream, mainApi: original.mainApi,
            source: original.source, includeReasoning: original.includeReasoning, model: original.model, bytes: original.bytes }];
        const selectedId = original.selectedId || sourceId(original);
        const record = { ...original, jobs, selectedId, jobId: selectedId, finalized: false, reviewing: true,
            revision: (original.revision || 0) + 1,
            reviewBase: options.resuming && original.reviewBase || fingerprint([message]) };
        const current = reviewStep(options.owner, options.checkpoint);
        if (current) Object.assign(record, { resumeReview: 1, reviewOwner: current.owner, afterReviewOwner: null,
            reviewAttempt: current.checkpoint.attempt || 0 });
        change(record.id, record);
        live.add(record.id);
        const sequence = { id: record.id, closed: false, signal,
            ticket: { armed: true, type: isSwipe(record) ? 'swipe' : 'normal', identity },
            message, baseText: message.mes, baseId: selectedId, acceptedId: selectedId, acceptedText: message.mes };
        sequence.resuming = !!options.resuming;
        if (current) sequence.recovery = { version: 1, current };
        sequences.add(sequence);
        trackReview(sequence, record);
        trace('review_started', record);
        message.extra ||= {};
        message.extra[MARK] = { id: record.id, complete: false, revision: record.revision };
        const info = message.swipe_info?.[message.swipe_id ?? 0];
        if (info) { info.extra ||= {}; info.extra[MARK] = { ...message.extra[MARK] }; }
        return sequence;
    }
    function acceptReview(sequence, text, previousId) {
        if (!sequences.has(sequence) || sequence.closed || typeof text !== 'string' || !text.trim()) return;
        if (sequence.latestId && sequence.latestId !== previousId) {
            sequence.acceptedId = sequence.latestId; sequence.acceptedText = text;
        }
    }
    function completeReview(sequence, message) {
        if (!sequences.has(sequence) || sequence.closed) return;
        const record = list().find(r => r.id === sequence.id);
        if (!record || getContext()?.chat?.[record.count] !== message || sequence.message !== message
            || !sameChat(chatIdentity(getContext()), record.identity) || sequence.signal?.aborted) {
            cancelSequence(sequence); return;
        }
        const selected = message.mes === sequence.acceptedText ? sequence.acceptedId
            : message.mes === sequence.baseText ? sequence.baseId : null;
        if (!selected) { cancelSequence(sequence); return; }
        if (!completeSequence(sequence, selected)) return;
        live.add(record.id);
        tag(record.count, true);
        if (sequence.resuming) live.delete(record.id);
        queueReceipts();
    }
    function completeSequence(sequence, selectedId) {
        if (!sequences.has(sequence) || sequence.closed) return;
        const record = list().find(r => r.id === sequence.id);
        const run = reviewRuns.get(sequence.id);
        if (!record || run && (run.sequence !== sequence || run.revision !== record.revision)) {
            sequence.closed = true; finishReview(sequence); return false;
        }
        sequence.closed = true;
        const selected = record.jobs.find(job => job.id === selectedId);
        if (selected) change(record.id, { ...record, ...selected, id: record.id,
            jobId: selected.id, jobs: record.jobs, selectedId, finalized: true, reviewing: false, reviewIncomplete: false,
            ...(record.resumeReview === 1 ? { reviewOwner: record.afterReviewOwner || null, afterReviewOwner: null,
                reviewAttempt: 0 } : {}) });
        // No selected response means an interrupted review. Keep candidates
        // for explicit recovery, without treating body completion as approval.
        else live.delete(record.id);
        finishReview(sequence);
        trace('review_finalized', list().find(item => item.id === record.id) || record, { selectedId, applied: !!selected });
        if (sequence.resuming) live.delete(record.id);
        return !!selected;
    }
    function cancelSequence(sequence) {
        if (!sequences.has(sequence) || sequence.closed) return;
        sequence.closed = true;
        finishReview(sequence);
        if (sequence.id) { if (!sequence.resuming) change(sequence.id, null); live.delete(sequence.id); }
    }
    async function prepare(request) {
        const { id, path, body, sequence } = request;
        const data = JSON.parse(body);
        if (sequence && (!sequences.has(sequence) || sequence.closed)) return false;
        const pending = sequence?.ticket || ticket;
        const root = sequence?.id && list().find(r => r.id === sequence.id);
        // Never turn quiet/translation/review/tool requests into character messages.
        if ((!root && !pending?.armed) || (!sequence && ![undefined, 'normal', 'regenerate', 'swipe'].includes(data.type))
            || path !== '/api/backends/chat-completions/generate' || (data.n || 1) > 1 || data.tools?.length) return false;
        if (!sequence && (data.type === 'swipe') !== (pending.type === 'swipe') && data.type !== undefined) return false;
        // An untyped helper request (e.g. validation) must not steal the main
        // generation's journal. Legacy untyped main requests are bound by ST's
        // final request event, without adding fields to the outgoing payload.
        if (!sequence && data.type === undefined && (!pending.request || requestFingerprint(pending.request) !== requestFingerprint(data))) return false;
        const currentTicket = pending;
        if (!sequence) ticket = null;
        let replyReceipt = null;
        // Bind only a new root reply, before identify() or any other await can
        // yield to another generation. Revisions keep their root's receipt.
        if (!root) {
            try { replyReceipt = captureReplyReceipt(currentTicket.identity); }
            catch { /* 429die is optional. */ }
        }
        await identify();
        const ctx = getContext();
        const identity = chatIdentity(ctx);
        if (!sameChat(identity, currentTicket.identity)) return false;
        if (root && (fingerprint(ctx.chat.slice(0, root.count)) !== root.anchor
            || !sameChat(identity, root.identity))) return false;
        const swipe = currentTicket.type === 'swipe';
        const previous = ctx.chat[ctx.chat.length - 1];
        if (!root && swipe && (!previous || previous.is_user || previous.is_system || !Array.isArray(previous.swipes)
            || !previous.swipes.length || previous.swipe_id !== previous.swipes.length
            || previous.swipes.some(text => typeof text !== 'string'))) return false;
        const count = ctx.chat.length - (swipe ? 1 : 0);
        let record = { id, tab: tabId, identity, count, anchor: fingerprint(ctx.chat.slice(0, count)),
            name: ctx.name2, created: Date.now(), stream: !!data.stream, mainApi: 'openai',
            source: data.chat_completion_source || ctx.chatCompletionSettings?.chat_completion_source,
            includeReasoning: typeof data.include_reasoning === 'boolean' ? data.include_reasoning
                : ctx.chatCompletionSettings?.show_thoughts === true,
            model: typeof data.model === 'string' ? data.model : '', bytes: null };
        const resume = sequence?.recovery || (!root && pending.review ? { version: 1, current: pending.review } : null);
        if (resume) {
            if (new TextEncoder().encode(JSON.stringify(resume)).length > 512 * 1024) {
                throw new Error('검수 재개 정보가 커서 이번 답장은 새로고침 복구 없이 진행합니다.');
            }
            request.recovery = structuredClone(resume);
            Object.assign(record, { resumeReview: 1, reviewOwner: resume.current.owner,
                afterReviewOwner: resume.after?.owner || null, reviewAttempt: resume.current.checkpoint.attempt || 0 });
        }
        if (!root && swipe) {
            record.swipeCount = previous.swipes.length;
            record.swipeAnchor = swipeAnchor(previous, record.swipeCount);
        }
        if (sequence) {
            const job = { id, stream: record.stream, mainApi: record.mainApi, source: record.source,
                includeReasoning: record.includeReasoning, model: record.model, bytes: null };
            record = { ...(root || record), ...job, id: root?.id || id, jobId: id,
                jobs: [...(root?.jobs || []), job], selectedId: null, finalized: false };
            if (resume) Object.assign(record, { resumeReview: 1, reviewOwner: resume.current.owner,
                afterReviewOwner: resume.after?.owner || null, reviewAttempt: resume.current.checkpoint.attempt || 0 });
        }
        // ST already saves a normal user message before generating. Do not call
        // saveChat or read the entire chat on this critical path: a delayed save,
        // older file header or other extension must not block answer generation.
        // The strict disk/chat checks still run before recovery writes and ACKs.
        try {
            change(record.id, record);
            if (!list().some(r => r.id === record.id)) throw new Error('브라우저에 복구 정보를 기록하지 못했습니다.');
        } catch (error) {
            try { if (!root) change(record.id, null); } catch { /* Storage may be unavailable. */ }
            throw error;
        }
        live.add(record.id);
        if (!root && typeof replyReceipt?.received === 'function') replyReceipts.set(record.id, replyReceipt);
        if (sequence) { sequence.id = record.id; sequence.latestId = id; }
        trace('prepared', record);
        return true;
    }
    function event(type, data) {
        const record = list().find(r => r.id === data.id || r.jobs?.some(job => job.id === data.id));
        if (!record) return;
        if (record.jobs) {
            if (type === 'completed' && (data.status < 200 || data.status >= 300)
                && record.finalized && record.selectedId === data.id) {
                // The first generation itself failed: ST receives the native
                // error and there is no character reply awaiting a chat save.
                change(record.id, null); live.delete(record.id); return;
            }
            const jobs = record.jobs.map(job => job.id === data.id
                ? { ...job, ...(type === 'completed' ? { bytes: data.bytes, status: data.status, failed: false } : {}),
                    ...(['cancelled', 'cancel-pending'].includes(type) || type === 'error' && data.httpStatus
                        ? { failed: true } : {}),
                    ...(type === 'error' && Number.isInteger(data.httpStatus)
                        ? { failureHttpStatus: data.httpStatus } : {}) } : job);
            change(record.id, { ...record, jobs });
            // A failed revision must not erase its previous good draft.
            // The explicit session completes/cancels the logical reply.
            return;
        }
        if (type === 'recovery-unavailable') {
            live.delete(record.id);
            try { change(record.id, null); } catch { /* Storage may be unavailable. */ }
        } else if (type === 'completed') {
            if (data.status < 200 || data.status >= 300) { change(record.id, null); live.delete(record.id); return; }
            change(record.id, { ...record, bytes: data.bytes });
            // Don't let the stream read EOF delete data before ST saves the chat.
            scheduleReceipt(record.id);
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
            const canComplete = complete && !needsReview(record);
            const alreadyComplete = message.extra[MARK]?.id === record.id && message.extra[MARK].complete;
            message.extra[MARK] = { id: record.id, complete: !!canComplete || !!alreadyComplete,
                ...(record.revision ? { revision: record.revision } : {}) };
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
        trace('candidate_read', record);
        const chunks = [];
        let cursor = 0, state;
        for (;;) {
            if (stopped || !isVisible() || !sameChat(chatIdentity(getContext()), record.identity) || generating) return null;
            state = await api(`/jobs/${sourceId(record)}?cursor=${cursor}&wait=1`, { headers: getHeaders() });
            if (['failed', 'cancelled'].includes(state.state)) {
                if (!record.jobs) change(record.id, null);
                throw Object.assign(new Error(state.error || '생성이 중지되었습니다.'), { candidateFailed: true });
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
            await api(`/jobs/${sourceId(record)}/ack`, { method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ cursor }) });
            if (!record.jobs) { change(record.id, null); live.delete(record.id); }
            throw Object.assign(new Error(`AI 요청이 실패했습니다 (HTTP ${state.status}).`), { candidateFailed: true });
        }
        const joined = new Uint8Array(cursor);
        let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
        record = { ...record, bytes: cursor, translation: state.translation || null };
        if (!record.jobs) change(record.id, record);
        return { record, raw: new TextDecoder().decode(joined), finishedAt: state.finishedAt };
    }
    async function readLatest(record) {
        const decoding = { ...await parser(),
            showThoughts: getContext()?.chatCompletionSettings?.show_thoughts === true };
        const candidates = record.jobs
            ? (record.selectedId && !(record.resumeReview === 1 && needsReview(record))
                ? record.jobs.filter(job => job.id === record.selectedId) : [...record.jobs].reverse())
            : [record];
        const failures = [];
        let missingError, undecoded = false;
        const failedDetail = (job, detail) => {
            trace('candidate_rejected', record, { jobId: sourceId(job), httpStatus: job.status || job.failureHttpStatus });
            const previousStatus = job.status >= 400 ? job.status : job.failureHttpStatus;
            failures.push(`${sourceId(job).slice(0, 8)}: ${detail}${previousStatus >= 400 && previousStatus <= 599
                ? ` · 기록된 오류 HTTP ${previousStatus}` : ''}`);
        };
        for (const job of candidates) {
            // A browser-side read/acceptance error does not prove that the
            // server failed to finish. Check each retained job before discarding
            // it, including journals written by older extension versions.
            const candidate = record.jobs ? { ...record, ...job, id: record.id, jobId: job.id } : record;
            let data;
            try { data = await readReply(candidate); }
            catch (error) {
                if (record.jobs && [404, 410].includes(error.httpStatus)) {
                    missingError ||= error;
                    failedDetail(job, `응답을 찾지 못함 (HTTP ${error.httpStatus})`);
                    continue;
                }
                // Network uncertainty is never evidence to fall back to a draft.
                if (!error.candidateFailed) throw error;
                failedDetail(job, '완료된 정상 답장 없음');
                continue;
            }
            if (!data) return null;
            let reply;
            try { reply = decodeReply(data.raw, data.record, decoding); }
            catch (error) {
                if (error.candidateRejected) {
                    // A fully read, recognized empty/provider-error response
                    // has no character text to save. Unknown formats and parser
                    // failures below must keep their bytes for a later attempt.
                    try {
                        await api(`/jobs/${sourceId(data.record)}/ack`, { method: 'POST', headers: getHeaders(),
                            body: JSON.stringify({ cursor: data.record.bytes }) });
                    } catch (ackError) {
                        if (![404, 410].includes(ackError.httpStatus)) throw ackError;
                    }
                    failedDetail(job, '빈 본문 또는 AI 오류 응답');
                    continue;
                }
                undecoded = true;
                failedDetail(job, '응답은 있으나 답장 본문을 읽지 못함');
                continue;
            }
            // Reading a candidate is not a final-selection decision. The caller
            // must preserve the guard's choice or get explicit user acceptance.
            trace('candidate_selected', data.record, { chars: reply.text.length, bytes: data.record.bytes });
            return { ...data, reply };
        }
        const details = failures.slice(0, 4).join('; ');
        const message = undecoded
            ? `서버 응답은 있지만 답장 본문을 읽지 못해 복구하지 못했어요. 남은 응답은 삭제하지 않았어요. (${details})`
            : `확인한 ${candidates.length}개 요청에서 복구할 완료 답장을 찾지 못했어요.${details ? ` (${details})` : ''}`;
        if (missingError && !undecoded) {
            // Let the normal saved-reply checks run before retiring the journal.
            missingError.recoveryDetail = message;
            throw missingError;
        }
        // Decoding failure is NOT a durable chat receipt. Never ACK/delete an
        // unreadable response merely because every candidate failed to decode.
        throw Object.assign(new Error(message), { noCompletedReply: candidates.length > 0 && !undecoded });
    }
    async function saveCurrent(record, baseline, stillCurrent) {
        trace('save_started', record);
        const latest = await diskChat(record);
        if (!stillCurrent()) return false;
        const ctx = getContext();
        // A receive hook may already have saved our final body. Otherwise only
        // write over the disk state we actually observed, never a different reply.
        if (!preservesSavedChanges(baseline, latest, ctx.chat)) {
            // Delivery is already durable. Later edits/metadata are not a
            // recovery conflict: leave both versions alone and retire quietly.
            if (sameCompletedReply(record, ctx.chat, latest)) {
                change(record.id, { ...record, postprocessPending: false });
                return false;
            }
            throw new Error('복구 도중 서버의 채팅 내용이 바뀌어 저장을 멈췄어요. 다른 기기의 답장을 덮어쓰지 않았어요. 원래 채팅을 다시 열어 확인해 주세요.');
        }
        // This is a browser-side recheck, not an atomic server-wide save lock.
        await ctx.saveChat();
        trace('save_returned', record);
        if (!stillCurrent()) return false;
        let saved = await diskChat(record);
        if (!stillCurrent()) return false;
        const matchesSnapshot = value => sameSavedValue(JSON.parse(JSON.stringify(ctx.chat)), value);
        if (!matchesSnapshot(saved) && retrySave) {
            // Conditional native saves can time out or swallow an error. Retry
            // once with the explicit original filename, never force an overwrite.
            if (!preservesSavedChanges(baseline, saved, ctx.chat)) throw new Error('복구 도중 서버의 채팅 내용이 바뀌어 저장을 멈췄어요. 다른 기기의 답장을 덮어쓰지 않았어요. 원래 채팅을 다시 열어 확인해 주세요.');
            trace('save_retry', record);
            await retrySave(record.identity, structuredClone(ctx.chat), stillCurrent);
            saved = await diskChat(record);
            if (!stillCurrent()) return false;
        }
        if (!matchesSnapshot(saved)) throw new Error('복구한 답장의 저장 내용이 화면과 일치하는지 확인하지 못했어요. 응답을 유지하고 다시 확인합니다.');
        return stillCurrent();
    }
    async function apply(record, reply, finishedAt, postprocess) {
        trace('apply_started', record);
        let ctx = getContext();
        if (generating || needsReview(record) && !postprocess || record.jobs && !unchanged(record)
            || !sameChat(chatIdentity(ctx), record.identity)) return false;
        const saved = await diskChat(record);
        // A new generation/chat switch can happen while the disk read is pending.
        if (generating || stopped || !isVisible() || record.jobs && !unchanged(record)
            || !sameChat(chatIdentity(getContext()), record.identity)) return false;
        if (position(record, saved)?.done && !record.postprocessPending && !postprocess) { await acknowledge(record); return true; }
        const text = await formatReply(reply.text);
        if (!text.trim()) throw new Error('답장 정리 후 복구할 본문이 없습니다.');
        const latestSaved = await diskChat(record);
        ctx = getContext();
        if (generating || stopped || !isVisible() || record.jobs && !unchanged(record)
            || !sameChat(chatIdentity(ctx), record.identity)) return false;
        if (!sameSavedValue(latestSaved, saved)) {
            if (position(record, latestSaved)?.done && !record.postprocessPending && !postprocess) { await acknowledge(record); return false; }
            throw new Error('복구 준비 중 서버의 채팅 내용이 바뀌어 자동 복구를 멈췄어요. 원래 채팅을 다시 열어 확인해 주세요.');
        }
        if (!record.postprocessPending && !postprocess && exactSavedReply(record, saved, text) && exactSavedReply(record, ctx.chat, text)) {
            // Already durable AND visible. Release only this response, with no
            // chat write, replayed hooks or misleading recovery success toast.
            reportVisibleReply(record);
            if (!await release(record)) return false;
            change(record.id, null);
            live.delete(record.id);
            return true;
        }
        if (!position(record, saved)) throw new Error('서버의 채팅 내용이 바뀌어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.');
        const target = position(record, ctx.chat);
        if (!target) throw new Error('채팅에 새 메시지나 수정이 있어 자동 복구를 멈췄습니다. 기존 답장은 덮어쓰지 않습니다.');
        if (!sameSavedValue(saved.slice(0, record.count), ctx.chat.slice(0, record.count))) {
            throw new Error('서버와 현재 페이지의 이전 메시지 기록이 달라 저장을 멈췄어요. 원래 채팅을 다시 열어 확인해 주세요.');
        }
        const chat = ctx.chat;
        let currentMessage = chat[target.index];
        let currentSwipe = currentMessage?.swipe_id ?? 0;
        const expectedLength = target.index === chat.length ? chat.length + 1 : chat.length;
        const stillCurrent = () => !generating && !stopped && isVisible()
            && sameChat(chatIdentity(getContext()), record.identity) && getContext().chat === chat
            && chat.length === expectedLength && chat[target.index] === currentMessage
            && (currentMessage?.swipe_id ?? 0) === currentSwipe;
        const displayState = () => JSON.stringify([currentMessage?.mes, currentMessage?.extra?.display_text,
            currentMessage?.extra?.reasoning, currentMessage?.extra?.reasoning_signature]);
        const redraw = () => {
            if (!stillCurrent()) return;
            const context = getContext();
            if (typeof context.updateMessageBlock === 'function') context.updateMessageBlock(target.index, currentMessage);
            else context.addOneMessage(currentMessage, { type: 'swipe' });
        };
        let hookBaseline;
        const previousMessage = chat[target.index];
        let provisional = false;
        processing.add(record.id);
        try {
            if (!target.done || postprocess) {
                record = { ...record, postprocessPending: true,
                    ...(postprocess && !record.reviewBase && saved[record.count]
                        ? { reviewBase: fingerprint([saved[record.count]]) } : {}) };
                change(record.id, record);
                const message = { name: record.name, is_user: false, is_system: false,
                    send_date: new Date(finishedAt || Date.now()).toISOString(), mes: text,
                    gen_started: new Date(record.created).toISOString(), gen_finished: new Date(finishedAt || Date.now()).toISOString(),
                    extra: { api: 'openai', model: record.model,
                        ...(record.translation ? { silly_relay_translation: record.translation } : {}),
                        reasoning: ctx.chatCompletionSettings?.show_thoughts === true ? reply.reasoning || '' : '',
                        reasoning_signature: reply.signature, [MARK]: { id: record.id, complete: !postprocess, recovered: true,
                            ...(record.reviewIncomplete ? { reviewIncomplete: true } : {}),
                            ...(record.revision ? { revision: record.revision } : {}) } },
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
                currentMessage = message;
                currentSwipe = message.swipe_id ?? 0;
                // A resumed semantic review sees the real slot, but its draft
                // is not rendered or saved as a final answer before it finishes.
                if (postprocess) {
                    provisional = true;
                    await postprocess(target.index, message);
                    if (!await waitForReview(record.id, stillCurrent)) return false;
                    if (!stillCurrent()) return false;
                    record = list().find(item => item.id === record.id);
                    if (!record || needsReview(record)) throw new Error('답장 검수를 마치지 못해 복구를 보류했어요. 서버의 답장은 유지합니다.');
                }
                provisional = false;
                ctx.addOneMessage(currentMessage, replacing ? { type: 'swipe' } : {});
                trace('display_applied', record, { chars: message.mes.length });
                // The complete reply is now visible. Cancel only its bound main
                // retry before slow saves. Do not replay translation/review hooks;
                // normal MESSAGE_RECEIVED remains after the durable-save check.
                reportVisibleReply(record);
                // Save a durable deduplication marker before other extensions can pause or throw.
                if (!await saveCurrent(record, saved, stillCurrent)) return false;
                const durable = await diskChat(record);
                if (!stillCurrent()) return false;
                if (!sameCompletedReply(record, chat, durable)) throw new Error('복구한 답장의 저장 내용이 화면과 일치하는지 확인하지 못했어요. 응답을 유지하고 다시 확인합니다.');
                trace('durable_verified', record);
                hookBaseline = durable;
            } else {
                // Save retries must still run the receive hooks that never ran
                // after an earlier swallowed save failure.
                reportVisibleReply(record);
                if (!await saveCurrent(record, saved, stillCurrent)) return false;
                hookBaseline = await diskChat(record);
            }
            if (record.postprocessPending && stillCurrent()) {
                if (currentMessage.extra?.[MARK]?.postprocessed !== true) {
                    let displayed = displayState();
                    const syncDisplay = () => {
                        if (!stillCurrent()) return;
                        // Native saveReply syncs the selected swipe after receive
                        // hooks. Do the same without touching other candidates.
                        if (Array.isArray(currentMessage.swipes)) currentMessage.swipes[currentSwipe] = currentMessage.mes;
                        if (currentMessage.swipe_info?.[currentSwipe]) {
                            currentMessage.swipe_info[currentSwipe].extra = structuredClone(currentMessage.extra ?? {});
                        }
                        if (displayState() !== displayed) { redraw(); displayed = displayState(); }
                    };
                    try {
                        const type = isSwipe(record) ? 'swipe' : 'normal';
                        trace('hooks_started', record);
                        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, target.index, type);
                        syncDisplay();
                        if (stillCurrent()) {
                            await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, target.index, type);
                        }
                    } catch { trace('recovery_failed', record, { reason: 'hook_error' }); warn(record, '답장은 복구했지만 후처리 확장에서 오류가 났습니다.'); }
                    finally { syncDisplay(); trace('hooks_finished', record, { chars: currentMessage?.mes?.length }); }
                    if (!stillCurrent()) return false;
                    record = list().find(item => item.id === record.id) || record;
                    if (needsReview(record)) return false;
                    currentMessage.extra[MARK].postprocessed = true;
                    if (currentMessage.swipe_info?.[currentSwipe]?.extra?.[MARK]) {
                        currentMessage.swipe_info[currentSwipe].extra[MARK].postprocessed = true;
                    }
                }
                if (!stillCurrent() || !await saveCurrent(record, hookBaseline, stillCurrent)) return false;
                const finalSaved = await diskChat(record);
                if (!stillCurrent() || finalSaved[record.count]?.extra?.[MARK]?.postprocessed !== true) return false;
                record = { ...record, postprocessPending: false };
                change(record.id, record);
                live.delete(record.id);
            }
        } catch (error) {
            const run = reviewRuns.get(record.id);
            if (run?.sequence.resuming) cancelSequence(run.sequence);
            if (provisional && stillCurrent()) {
                if (previousMessage) chat[target.index] = previousMessage;
                else chat.pop();
                if (previousMessage) getContext().updateMessageBlock?.(target.index, previousMessage);
            }
            // Distinguish our own journal checkpoints from a different page's
            // edits when reporting a save failure to the recovery caller.
            try { error.recoveryRecord = record; } catch { /* Non-extensible error. */ }
            throw error;
        } finally {
            if (provisional && getContext().chat === chat && chat.length === expectedLength
                && chat[target.index] === currentMessage && (currentMessage?.swipe_id ?? 0) === currentSwipe) {
                if (previousMessage) chat[target.index] = previousMessage;
                else chat.pop();
            }
            processing.delete(record.id); scheduleReceipt(record.id);
        }
        if (await acknowledge(record)) notify(record.reviewIncomplete
            ? '검수 미완료 답장을 직접 복구했어요. 검수를 통과한 답장이라는 뜻은 아니에요.'
            : '다시 접속하기 전에 받던 답장을 원래 채팅에 복구했어요.', true);
        return true;
    }
    async function recover({ manual = false, allowUnreviewed = false } = {}) {
        if (busy || generating || stopped || !isVisible()) {
            trace('recovery_blocked', null, { manual, reason: busy ? 'busy' : generating ? 'generating' : stopped ? 'stopped' : 'hidden' });
            if (manual) notify('답장 생성이나 복구가 끝난 뒤 원래 채팅에서 다시 눌러 주세요.');
            return;
        }
        busy = true;
        try {
            await identify();
            trace('recovery_started', null, { manual, allowUnreviewed });
            if (manual) for (const record of list()) {
                if (!record.autoRecoveryPaused || live.has(record.id)
                    || !sameChat(chatIdentity(getContext()), record.identity)) continue;
                const { autoRecoveryPaused, ...retry } = record;
                change(record.id, retry);
                trace('recovery_retry_requested', retry);
            }
            await settle();
            let foundPending = false;
            for (const record of list()) {
                trace('record_considered', record);
                if (live.has(record.id) || !sameChat(chatIdentity(getContext()), record.identity)) {
                    trace('record_skipped', record, { reason: live.has(record.id) ? 'live' : 'other_chat' }); continue;
                }
                if (record.autoRecoveryPaused) {
                    trace('record_skipped', record, { reason: 'automatic_paused' });
                    diagnostic(`이전 요청 ${record.id.slice(0, 8)}의 자동 복구를 보류했어요. 「답장 복구·검수 재시도」에서 재시도할 수 있어요. 서버의 임시 보관 기한이 적용돼요.`);
                    continue;
                }
                foundPending ||= needsReview(record);
                if (needsReview(record) && record.resumeReview !== 1 && !allowUnreviewed && pendingReviews.get(record.id) === JSON.stringify(record)) { trace('record_skipped', record, { reason: 'already_prompted' }); continue; }
                let expected = record;
                try {
                    let data = await readLatest(record);
                    if (!data) continue;
                    if (record.jobs && !unchanged(record)) continue;
                    // Only explicit, versioned reviewer snapshots may resume.
                    // Legacy/unknown candidates retain the manual acceptance path.
                    for (let step = 0; step < 2 && !(manual && allowUnreviewed)
                        && needsReview(data.record) && data.record.resumeReview === 1; step++) {
                        // Byte/translation metadata comes from the server read;
                        // bind that exact candidate before issuing a capability.
                        change(record.id, data.record);
                        let context;
                        try { context = await api(`/jobs/${sourceId(data.record)}/recovery`, { headers: getHeaders() }); }
                        catch { throw new Error('검수 복구 정보를 읽지 못했어요. 릴레이 서버 플러그인 업데이트와 연결 상태를 확인해 주세요. 서버의 답장은 유지합니다.'); }
                        if (generating || stopped || !isVisible() || !unchanged(data.record)
                            || !sameChat(chatIdentity(getContext()), data.record.identity)) { data = null; break; }
                        let checkpoint = [context.current, context.after].find(item => item?.owner === data.record.reviewOwner);
                        if (!checkpoint) break;
                        checkpoint = { ...checkpoint, checkpoint: { ...checkpoint.checkpoint,
                            attempt: Math.max(checkpoint.checkpoint.attempt || 0, data.record.reviewAttempt || 0) } };
                        trace('review_resuming', data.record);
                        const result = await resumeReview({ ...data, context, checkpoint });
                        if (!result) break;
                        if (result.postprocess) { data.postprocess = result.postprocess; break; }
                        if (!await waitForReview(record.id, () => !generating && !stopped && isVisible()
                            && sameChat(chatIdentity(getContext()), record.identity))) { data = null; break; }
                        const current = list().find(item => item.id === record.id);
                        if (!current || generating || stopped || !isVisible()
                            || !sameChat(chatIdentity(getContext()), current.identity)) { data = null; break; }
                        data = await readLatest(current);
                        if (current.jobs && !unchanged(current)) { data = null; break; }
                        if (!data) break;
                    }
                    if (!data) continue;
                    expected = data.record;
                    if (needsReview(data.record) && !data.postprocess) {
                        trace('review_pending', record);
                        const message = '검수 미완료 답장이 남아 있어 자동 복구를 보류했어요. 설정의 「검수 미완료 답장 직접 복구」에서 확인할 수 있어요. 서버의 임시 보관 기간 안에 확인해 주세요.';
                        pendingReviews.set(record.id, JSON.stringify(record));
                        if (!manual || !allowUnreviewed) { diagnostic(message); warn(record, message); continue; }
                        if (!await confirmUnreviewed()) { trace('manual_cancelled', record); continue; }
                        trace('manual_confirmed', record);
                        // A delayed dialog must not accept another chat, a new
                        // generation, or a record finalized by another page.
                        if (generating || stopped || !isVisible() || !unchanged(record)
                            || !sameChat(chatIdentity(getContext()), record.identity)) continue;
                        data.record = { ...data.record, selectedId: sourceId(data.record),
                            finalized: true, reviewing: false, reviewIncomplete: true, reviewOwner: null, afterReviewOwner: null };
                    }
                    if (record.jobs) { change(record.id, data.record); expected = data.record; }
                    const applied = await apply(data.record, data.reply, data.finishedAt, data.postprocess);
                    trace('apply_finished', data.record, { applied });
                } catch (error) {
                    expected = error.recoveryRecord || expected;
                    trace('recovery_failed', record, { reason: recoveryReason(error), httpStatus: error.httpStatus });
                    const activeReview = reviewRuns.get(record.id);
                    if (activeReview?.sequence.resuming) cancelSequence(activeReview.sequence);
                    if (record.jobs && !unchanged(expected)) continue;
                    if (['guard_14', 'guard_15', 'guard_16'].includes(recoveryReason(error))) {
                        if (!unchanged(expected)) continue;
                        change(record.id, { ...expected, autoRecoveryPaused: { reason: recoveryReason(error) } });
                        clearTimeout(quickReceipts.get(record.id)?.timer); quickReceipts.delete(record.id);
                        trace('recovery_paused', expected, { reason: recoveryReason(error) });
                        const message = `이전 요청 ${record.id.slice(0, 8)}은 현재 채팅과 맞지 않아 자동 복구를 보류했어요. 기존 메시지는 변경하지 않았어요. 「답장 복구·검수 재시도」에서 재시도할 수 있어요.`;
                        diagnostic(message); warn(record, message);
                        continue;
                    }
                    if ([404, 410].includes(error.httpStatus)) {
                        // Another page/receipt may have ACKed while this read was
                        // in flight. A saved reply is not a missing reply.
                        if (await acknowledge(record)) continue;
                        if (position(record, await diskChat(record))?.done) continue;
                        change(record.id, null);
                        const message = error.recoveryDetail || (error.httpStatus === 410
                            ? `이전 복구 요청 ${record.id.slice(0, 8)}: 서버는 전달 완료로 표시하지만 채팅 저장을 확인하지 못했어요 (HTTP 410). 현재 새 답장의 생성 결과와는 별개예요.`
                            : `이전 복구 요청 ${record.id.slice(0, 8)}: 서버에 응답이 남아 있지 않아 복구할 수 없어요 (HTTP 404). 현재 새 답장의 생성 결과와는 별개이며, 사라진 원인은 확인되지 않았어요.`);
                        // Startup/chat-open checks are not new generation errors.
                        // Keep the diagnosis visible in settings; a user-requested
                        // recovery still receives direct feedback.
                        diagnostic(message);
                        if (manual) warn(record, message);
                    } else if (!(error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name))) {
                        if (error.noCompletedReply) { change(record.id, null); live.delete(record.id); }
                        diagnostic(error.message);
                        warn(record, error.message);
                    }
                }
            }
            if (manual && allowUnreviewed && !foundPending) notify('현재 채팅에 직접 복구할 검수 미완료 답장이 없어요.');
        } catch (error) { trace('recovery_failed', null, { reason: recoveryReason(error), httpStatus: error.httpStatus }); warn(null, error.message); }
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
            await recover({ manual: true });
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
            const info = await api(`/jobs/${sourceId(record)}?cursor=0`, { headers: getHeaders() });
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
        if (adopted) await recover({ manual: true });
    }
    function generationEnded() {
        const parent = generationParents.pop();
        generating = parent?.generating || false; ticket = parent?.ticket || null;
        // The guard has returned its selected response. Allow recovery to
        // validate it if ST could not render/save it (e.g. a provider error).
        for (const record of list()) if (record.jobs && record.finalized) live.delete(record.id);
        queueReceipts();
    }
    function generationStopped() {
        generationParents.length = 0;
        generationEnded();
        for (const record of list()) {
            if (!live.has(record.id)) continue;
            change(record.id, null); live.delete(record.id);
        }
    }
    function stop() {
        stopped = true;
        for (const run of [...reviewRuns.values()]) {
            run.sequence.closed = true; finishReview(run.sequence);
        }
        for (const state of quickReceipts.values()) clearTimeout(state.timer);
        quickReceipts.clear();
    }
    return { expectReview, resumeSequence, beginSequence, beginReview, acceptReview, completeReview, completeSequence, cancelSequence, prepare, event, tag, generationStarted, dataReady, settingsReady, generationEnded, generationStopped, recover, recoverPreviousSession, settle, stop, list };
}
