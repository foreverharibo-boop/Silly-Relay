import { createDiagnostics, collectDiagnostics } from './diagnostics.mjs?v=1.0.23';
import { RECOVERY_REASONS } from './recovery-reasons.mjs?v=1.0.23';
import { createTransport } from './transport.mjs?v=1.0.23';
import { createRecovery } from './recovery.mjs?v=1.0.23';
import { recoveryIdentity } from './identity.mjs?v=1.0.23';
import { createReplyFilter, createWarningGate } from './reply-filter.mjs?v=1.0.23';
import { createReplySessions } from './reply-session.mjs?v=1.0.23';

const ENABLE_KEY = 'silly-relay-enabled-v1';
const CANCEL_KEY = 'silly-relay-pending-cancel-v1';
let active = false;
let panel;
let transport;
let hook;
let state = '연결 확인을 눌러 주세요.';
let lastEvent = '아직 생성 요청이 없습니다.';
let lastRecoveryEvent = '';
let checking = false;
let notificationTarget = 'legacy';
let notificationRevision = 0;
let recovery;
let diagnostics;
let sessions;
const replies = createReplyFilter();
const allowWarning = createWarningGate();
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
    const recoveryStatus = panel.querySelector('[data-recovery]');
    recoveryStatus.textContent = lastRecoveryEvent;
    recoveryStatus.hidden = !lastRecoveryEvent;
    panel.querySelector('input').checked = active;
}
function notify(message) {
    if (globalThis.toastr) globalThis.toastr.warning(message, 'Silly Relay');
    else console.warn('[Silly Relay]', message);
}
function onEvent(type, data) {
    diagnostics?.record(type, data);
    try { recovery?.event(type, data); } catch { /* Recovery cannot cancel the live request. */ }
    const names = { starting: '서버로 요청 전달 중', accepted: '서버에서 생성 중 · 화면을 나가도 수신 계속',
        reconnecting: '연결 재시도 중 · 서버 작업은 유지됩니다', read_resumed: '기존 답변 수신 연결을 다시 여는 중',
        completed: '응답 전달 완료', cancelled: '서버 생성 중지 완료',
        'cancel-pending': '중지 전달 대기 · 연결 복구 후 다시 보냅니다', error: '요청 오류',
        'recovery-unavailable': '이번 요청은 새로고침 복구 없이 진행합니다' };
    lastEvent = `${names[type] || type}${data.message ? `: ${data.message}` : ''}`;
    if (type === 'accepted') lastEvent += data.reloadRecovery ? ' · 재접속 복구 준비됨' : ' · 이 요청은 새로고침 복구 대상 아님';
    update();
    if (['error', 'cancel-pending', 'recovery-unavailable'].includes(type)
        && allowWarning(data.httpStatus === 429 ? 'relay-capacity' : lastEvent)) notify(lastEvent);
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
        const revision = notificationRevision;
        const result = await transport.api('/status', { headers: headers() });
        diagnostics?.bind(result.owner);
        if (result.notificationRouting && revision === notificationRevision) { notificationTarget = result.notificationTarget; panel.querySelector('[data-pop-target]').value = notificationTarget; }
        if (result.protocol !== 2 || !result.ready) throw new Error('이 서버 설정에서는 Silly Relay를 사용할 수 없습니다.');
        if (!result.reloadRecovery) throw new Error('서버 플러그인도 업데이트한 뒤 서버를 재시작해 주세요.');
        state = `확장 1.0.23 · 서버 ${result.version} 연결됨`;
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
    diagnostics = createDiagnostics({ storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) } });
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
        shouldRelay: replies.take,
        enabled: () => active, onEvent, saveCancellation,
        prepareRecovery: data => tabId ? recovery.prepare(data) : Promise.resolve(false) });
    recovery = createRecovery({ getContext: context, api: transport.api, fetchImpl: originalFetch,
        getHeaders: headers, storage: recoveryStorage, tabId,
        trace: (stage, detail) => diagnostics.record(stage, detail),
        onIdentity: owner => diagnostics.bind(owner),
        captureReplyReceipt: identity => {
            const bridge = globalThis.die429MainReply;
            return bridge?.apiVersion === 1 ? bridge.capture(identity) : null;
        },
        allowPreviousSession: standalone,
        retrySave: async (identity, chatData, valid) => {
            const native = await import('/script.js');
            const started = Date.now();
            while (native.isChatSaving) {
                if (!valid() || Date.now() - started > 3000) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!valid()) return;
            await native.saveChat({ chatName: identity.file, chatData });
        },
        resumeReview: async data => {
            const reviewer = globalThis.sillyRelayReviewers?.[data.checkpoint.owner];
            if (!reviewer?.resume) return null;
            const options = { checkpoint: data.checkpoint.checkpoint };
            if (reviewer.kind === 'message') return {
                postprocess: (index, message) => reviewer.resume({ ...options, index, message }),
            };
            const session = sessions.resume(data.record, data.context);
            if (!session) return null;
            await reviewer.resume({ ...options, session, body: JSON.parse(data.context.body),
                response: new Response(data.raw, { status: 200, headers: {
                    'content-type': data.record.stream ? 'text/event-stream' : 'application/json',
                    'x-silly-relay-job': data.record.jobId || data.record.id,
                } }) });
            return { resumed: true };
        },
        confirmUnreviewed: async () => globalThis.confirm('검수가 끝나지 않은 답장이에요. 가장 최근에 생성이 완료된 후보를 채팅에 복구할까요?\n\n검수를 통과했다는 뜻은 아니며, 아직 실행하지 않은 검수를 이어서 진행하지는 않아요. 취소하면 답장은 서버의 임시 보관 기간 동안 유지돼요.'),
        isVisible: () => active && document.visibilityState !== 'hidden',
        parser: async () => ({ extract: context().extractMessageFromData,
            streamChunk: (await import('/scripts/openai.js')).getStreamingReply }),
        formatReply: async text => (await import('/script.js')).cleanUpMessage({
            getMessage: text, isImpersonate: false, isContinue: false }),
        diagnostic: message => {
            lastRecoveryEvent = `최근 복구 확인 (${new Date().toLocaleTimeString()}): ${message}`;
            update();
            console.info('[Silly Relay] recovery:', message);
        },
        notify: (message, success) => {
            lastEvent = message; update();
            if (success) globalThis.toastr?.success(message, 'Silly Relay');
            else notify(message);
        } });
    hook = transport.fetch;
    sessions = globalThis.sillyRelayReplies = createReplySessions({ enabled: () => active && !!tabId,
        recovery, transport, consume: replies.consume, captureQuiet: replies.captureQuiet,
        onError: error => onEvent('recovery-unavailable', { message: error.message || '수정본 복구 기록 실패' }) });
    globalThis.fetch = hook;
    panel = document.createElement('div');
    panel.id = 'silly-relay-settings';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Silly Relay</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox"><span>연결 유지</span></label>
            <small>이 브라우저에서만 적용합니다. 서버로 전달된 생성 요청을 유지합니다.</small>
            <label class="sr-notification-target">완료 알림 연결 <select class="text_pole" data-pop-target>
                <option value="legacy">선택 전 · 기존 실리팝 설정 유지</option>
                <option value="none">사용 안 함</option><option value="apk">실리팝 APK</option>
                <option value="ios">실리팝 iOS</option><option value="and">실리팝 AND</option>
            </select></label>
            <small>같은 실리태번 계정에서 공통으로 사용합니다. 변경은 다음 요청부터 적용합니다. 알림 받을 기기와 알림 켜기는 해당 실리팝에서 설정해 주세요.</small>
            <p data-pop-status role="status"></p>
            <p data-status></p><small data-last></small>
            <p data-recovery hidden></p>
            <div class="sr-actions"><button class="menu_button" data-diagnostics>서버·복구 진단 내려받기</button></div>
            <small>본문·API 키 없이 처리 기록을 자동 보관합니다. 서버 기록은 서버 재시작 후에도 남으며 오래된 기록부터 교체합니다. 서버 플러그인 1.0.3 이상이 필요합니다.</small>
            <div class="sr-actions"><button class="menu_button" data-check>연결 확인</button></div>
            <div class="sr-actions"><button class="menu_button" data-previous>답장 복구·검수 재시도</button></div>
            <div class="sr-actions"><button class="menu_button" data-unreviewed>검수 미완료 답장 직접 복구</button></div>
            <small>검수에서 최종 선택한 답장은 자동 복구합니다. 검수가 중단된 후보는 위 버튼에서 확인한 뒤 직접 복구할 수 있어요. 서버의 기존 임시 보관 기한이 적용돼요.</small>
            <small>다른 앱으로 이동해도 서버 요청을 유지합니다. 새로고침하거나 홈 화면 웹앱을 다시 실행한 뒤 같은 채팅을 열면 일반 답장을 자동 복구합니다. 1:1 Chat Completion의 일반 답변·재생성·스와이프를 복구합니다. 스와이프는 기존 후보를 유지하며 새 후보 하나를 복구합니다. 계속쓰기·그룹 채팅은 아직 복구 대상이 아닙니다.</small>
        </div></div>`;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (container) container.append(panel);
    else notify('설정 영역을 찾지 못했습니다. 실리태번 페이지를 새로고침해 주세요.');
    panel.querySelector('input').addEventListener('change', event => {
        active = event.target.checked;
        writeStored(ENABLE_KEY, active);
        if (active) void check();
        else { replies.clear(); state = '새 요청부터 연결 유지 기능을 사용하지 않습니다.'; update(); }
    });
    panel.querySelector('[data-check]').addEventListener('click', check);
    panel.querySelector('[data-pop-target]').addEventListener('change', async event => {
        const select = event.currentTarget;
        notificationRevision++;
        select.disabled = true;
        try {
            const result = await transport.api('/notification-settings', { method: 'POST', headers: headers(), body: JSON.stringify({ target: select.value }) });
            notificationTarget = result.target; select.value = result.target;
            panel.querySelector('[data-pop-status]').textContent = '계정 공통 설정을 저장했습니다. 다음 요청부터 적용합니다.';
        } catch (error) { select.value = notificationTarget; panel.querySelector('[data-pop-status]').textContent = '저장 실패: ' + error.message; }
        finally { select.disabled = false; }
    });
    panel.querySelector('[data-diagnostics]').addEventListener('click', async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
            const report = await collectDiagnostics({ api: transport.api, headers, diagnostics, reasons: RECOVERY_REASONS });
            const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'silly-relay-diagnostics.json';
            document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            if (report.server.unavailable) notify('브라우저 기록을 내려받았어요. 서버 기록은 포함되지 않았습니다. 서버 플러그인 업데이트와 연결 상태를 확인해 주세요.');
        } catch { notify('진단 파일을 만들지 못했어요. 브라우저 다운로드 권한을 확인해 주세요.'); }
        finally { button.disabled = false; }
    });
    document.addEventListener('visibilitychange', () => diagnostics.record(document.hidden ? 'page_hidden' : 'page_visible'));
    panel.querySelector('[data-unreviewed]').addEventListener('click', async event => {
        if (!active) { notify('연결 유지를 켠 뒤 원래 채팅에서 눌러 주세요.'); return; }
        const button = event.currentTarget;
        button.disabled = true;
        try { await recovery.recover({ manual: true, allowUnreviewed: true }); }
        catch (error) { notify(error.message); }
        finally { button.disabled = false; }
    });
    panel.querySelector('[data-previous]').addEventListener('click', async event => {
        if (!active) { notify('연결 유지를 켠 뒤 원래 채팅에서 눌러 주세요.'); return; }
        const button = event.currentTarget;
        button.disabled = true;
        try {
            if (standalone) await recovery.recoverPreviousSession();
            else await recovery.recover({ manual: true });
        }
        catch (error) { notify(error.message); }
        finally { button.disabled = false; }
    });
    function resume() {
        transport.resume();
        const revision = notificationRevision;
        if (active) void transport.api('/notification-settings', { headers: headers() }).then(result => { if (revision !== notificationRevision) return; notificationTarget = result.target; panel.querySelector('[data-pop-target]').value = notificationTarget; }).catch(() => {});
        void flushCancellations();
        if (active && tabId) void recovery.recover();
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
    globalThis.addEventListener('online', resume);
    globalThis.addEventListener('pageshow', resume);
    const ctx = context();
    if (ctx?.eventSource && ctx.eventTypes) {
        const on = (name, handler, first = false) => {
            if (!ctx.eventTypes[name]) return;
            const listener = (...args) => {
                try {
                    const result = handler(...args);
                    if (result?.catch) return result.catch(() => notify('복구 상태 처리에 실패했습니다. 답변 생성은 계속 진행합니다.'));
                } catch { notify('복구 상태 처리에 실패했습니다. 답변 생성은 계속 진행합니다.'); }
            };
            if (first && typeof ctx.eventSource.makeFirst === 'function') ctx.eventSource.makeFirst(ctx.eventTypes[name], listener);
            else ctx.eventSource.on(ctx.eventTypes[name], listener);
        };
        on('GENERATION_STARTED', (...args) => { replies.generationStarted(...args); recovery.generationStarted(...args); });
        on('GENERATE_AFTER_DATA', (...args) => { replies.dataReady(...args); recovery.dataReady(...args); });
        on('CHAT_COMPLETION_SETTINGS_READY', data => { if (replies.settingsReady(data)) recovery.settingsReady(data); }, true);
        on('GENERATION_ENDED', (...args) => { replies.generationEnded(); recovery.generationEnded(...args); });
        on('GENERATION_STOPPED', (...args) => { replies.clear(); recovery.generationStopped(...args); });
        on('STREAM_TOKEN_RECEIVED', () => recovery.tag(null, false));
        on('MESSAGE_RECEIVED', id => recovery.tag(id, true));
        on('CHAT_CHANGED', () => { replies.clear(); resume(); });
        on('APP_READY', resume);
    }
    setInterval(() => { if (active && tabId) void recovery.recover(); }, 10000);
    if (!tabId) notify('이 브라우저에서 복구 정보를 저장할 수 없습니다. 새로고침 복구가 비활성화됩니다.');
    update();
    if (active) void check();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
