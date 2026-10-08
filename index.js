import { createTransport } from './transport.mjs?v=1.0.2';
import { createRecovery } from './recovery.mjs?v=1.0.2';
import { recoveryIdentity } from './identity.mjs?v=1.0.2';

const VERSION = '1.0.2';
const ENABLE_KEY = 'silly-relay-enabled-v1';
const CANCEL_KEY = 'silly-relay-pending-cancel-v1';
let active = false;
let panel;
let transport;
let hook;
let state = '연결 확인을 눌러 주세요.';
let lastEvent = '아직 생성 요청이 없습니다.';
let checking = false;
let recovery;
const context = () => globalThis.SillyTavern?.getContext?.();
const headers = () => context()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
function readStored(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStored(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing. */ } }
function cancellations() {
    const list = readStored(CANCEL_KEY, []);
    return Array.isArray(list) ? list.filter(id => /^[a-f0-9]{32}$/.test(id)).slice(-64) : [];
}
function saveCancellation(id, pending) {
    const ids = new Set(cancellations());
    pending ? ids.add(id) : ids.delete(id);
    writeStored(CANCEL_KEY, [...ids].slice(-64));
}
function update() {
    if (!panel) return;
    panel.querySelector('[data-status]').textContent = state;
    panel.querySelector('[data-last]').textContent = lastEvent;
    panel.querySelector('input').checked = active;
}
function notify(message) {
    if (globalThis.toastr) globalThis.toastr.warning(message, 'Silly Relay');
    else console.warn('[Silly Relay]', message);
}
function onEvent(type, data) {
    try { recovery?.event(type, data); } catch { /* Recovery cannot cancel the live request. */ }
    const names = { starting: '서버로 요청 전달 중', accepted: '서버에서 생성 중 · 화면을 나가도 수신 계속',
        reconnecting: '연결 재시도 중 · 서버 작업은 유지됩니다',
        completed: '응답 전달 완료', cancelled: '서버 생성 중지 완료',
        'cancel-pending': '중지 전달 대기 · 연결 복구 후 다시 보냅니다', error: '요청 오류',
        'recovery-unavailable': '이번 요청은 새로고침 복구 없이 진행합니다' };
    lastEvent = `${names[type] || type}${data.message ? `: ${data.message}` : ''}`;
    if (type === 'accepted') lastEvent += data.reloadRecovery ? ' · 재접속 복구 준비됨' : ' · 이 요청은 새로고침 복구 대상 아님';
    update();
    if (['error', 'cancel-pending', 'recovery-unavailable'].includes(type)) notify(lastEvent);
}
async function flushCancellations() {
    for (const id of cancellations()) {
        try {
            await transport.api(`/jobs/${id}/cancel`, { method: 'POST', headers: headers(), body: '{}' });
            saveCancellation(id, false);
        } catch { break; }
    }
}
async function check() {
    if (checking) return;
    checking = true;
    try {
        const result = await transport.api('/status', { headers: headers() });
        if (result.protocol !== 2 || !result.ready) throw new Error('이 서버 설정에서는 Silly Relay를 사용할 수 없습니다.');
        if (!result.reloadRecovery) throw new Error('서버 플러그인도 업데이트한 뒤 서버를 재시작해 주세요.');
        state = `서버 ${result.version} 연결됨`;
        if (globalThis.fetch !== hook) state += ' · 다른 확장의 요청 처리와 함께 설치되어 있습니다';
        await flushCancellations();
        if (active) void recovery.recover();
    } catch (error) { state = `서버 연결 확인 실패: ${error.message}`; }
    finally { checking = false; update(); }
}

function initialize() {
    if (globalThis.fetch.__sillyRelay) return;
    active = readStored(ENABLE_KEY, false) === true;
    const originalFetch = globalThis.fetch.bind(globalThis);
    let tabId;
    let recoveryStorage;
    const standalone = navigator.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)').matches === true;
    try {
        recoveryStorage = globalThis.localStorage;
        tabId = recoveryIdentity({ local: recoveryStorage, session: globalThis.sessionStorage, standalone, newId: () => {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        } });
    } catch { tabId = null; recoveryStorage = { getItem: () => null, setItem: () => {} }; }
    transport = createTransport({ fetchImpl: originalFetch, origin: location.href,
        enabled: () => active, onEvent, saveCancellation,
        prepareRecovery: data => tabId ? recovery.prepare(data) : Promise.resolve(false) });
    recovery = createRecovery({ getContext: context, api: transport.api, fetchImpl: originalFetch,
        getHeaders: headers, storage: recoveryStorage, tabId,
        allowPreviousSession: standalone,
        isVisible: () => active && document.visibilityState !== 'hidden',
        parser: async () => ({ extract: context().extractMessageFromData,
            streamChunk: (await import('/scripts/openai.js')).getStreamingReply }),
        formatReply: async text => (await import('/script.js')).cleanUpMessage({
            getMessage: text, isImpersonate: false, isContinue: false }),
        notify: (message, success) => {
            lastEvent = message; update();
            if (success) globalThis.toastr?.success(message, 'Silly Relay');
            else notify(message);
        } });
    hook = transport.fetch;
    globalThis.fetch = hook;
    panel = document.createElement('div');
    panel.id = 'silly-relay-settings';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Silly Relay <small>${VERSION}</small></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox"><span>연결 유지</span></label>
            <small>이 브라우저에서만 적용합니다. 서버로 전달된 생성 요청을 유지합니다.</small>
            <p data-status></p><small data-last></small>
            <div class="sr-actions"><button class="menu_button" data-check>연결 확인</button></div>
            <div class="sr-actions" data-previous-panel hidden><button class="menu_button" data-previous>답장 복구 확인</button></div>
            <small>다른 앱으로 이동해도 서버 요청을 유지합니다. 새로고침하거나 홈 화면 웹앱을 다시 실행한 뒤 같은 채팅을 열면 일반 답장을 자동 복구합니다. 1:1 Chat Completion의 일반 답변·재생성·스와이프를 복구합니다. 스와이프는 기존 후보를 유지하며 새 후보 하나를 복구합니다. 계속쓰기·그룹 채팅은 아직 복구 대상이 아닙니다.</small>
        </div></div>`;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (container) container.append(panel);
    else notify('설정 영역을 찾지 못했습니다. 실리태번 페이지를 새로고침해 주세요.');
    panel.querySelector('input').addEventListener('change', event => {
        active = event.target.checked;
        writeStored(ENABLE_KEY, active);
        if (active) void check();
        else { state = '새 요청부터 연결 유지 기능을 사용하지 않습니다.'; update(); }
    });
    panel.querySelector('[data-check]').addEventListener('click', check);
    panel.querySelector('[data-previous-panel]').hidden = !standalone;
    panel.querySelector('[data-previous]').addEventListener('click', async event => {
        if (!active) { notify('연결 유지을 켠 뒤 원래 채팅에서 눌러 주세요.'); return; }
        const button = event.currentTarget;
        button.disabled = true;
        try { await recovery.recoverPreviousSession(); }
        catch (error) { notify(error.message); }
        finally { button.disabled = false; }
    });
    function resume() { void flushCancellations(); if (active && tabId) void recovery.recover(); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
    globalThis.addEventListener('online', resume);
    globalThis.addEventListener('pageshow', resume);
    const ctx = context();
    if (ctx?.eventSource && ctx.eventTypes) {
        const on = (name, handler) => {
            if (!ctx.eventTypes[name]) return;
            ctx.eventSource.on(ctx.eventTypes[name], (...args) => {
                try {
                    const result = handler(...args);
                    if (result?.catch) return result.catch(() => notify('복구 상태 처리에 실패했습니다. 답변 생성은 계속 진행합니다.'));
                } catch { notify('복구 상태 처리에 실패했습니다. 답변 생성은 계속 진행합니다.'); }
            });
        };
        on('GENERATION_STARTED', recovery.generationStarted);
        on('GENERATE_AFTER_DATA', recovery.dataReady);
        on('GENERATION_ENDED', recovery.generationEnded);
        on('GENERATION_STOPPED', recovery.generationStopped);
        on('STREAM_TOKEN_RECEIVED', () => recovery.tag(null, false));
        on('MESSAGE_RECEIVED', id => recovery.tag(id, true));
        on('CHAT_CHANGED', resume);
        on('APP_READY', resume);
    }
    setInterval(() => { if (active && tabId) void recovery.recover(); }, 10000);
    if (!tabId) notify('이 브라우저에서 복구 정보를 저장할 수 없습니다. 새로고침 복구가 비활성화됩니다.');
    update();
    if (active) void check();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
