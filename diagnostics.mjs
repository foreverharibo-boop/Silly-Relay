const ID = /^[a-f0-9]{32}$/;
const STAGES = new Set(['browser_ready', 'starting', 'accepted', 'reconnecting', 'completed', 'cancelled',
    'cancel-pending', 'error', 'recovery-unavailable', 'prepared', 'review_started', 'review_finalized',
    'recovery_started', 'recovery_blocked', 'record_considered', 'record_skipped', 'review_pending',
    'candidate_read', 'candidate_selected', 'candidate_rejected', 'recovery_failed', 'warning',
    'apply_started', 'apply_finished', 'display_applied', 'saved_display_applied', 'hooks_started', 'hooks_finished',
    'save_started', 'save_returned', 'disk_read', 'disk_read_failed', 'durable_verified', 'release_started', 'released',
    'manual_confirmed', 'manual_cancelled', 'page_hidden', 'page_visible', 'read_resumed', 'review_resuming', 'save_retry', 'review_waiting', 'review_wait_interrupted', 'recovery_paused', 'recovery_retry_requested']);
const REASONS = new Set(['unknown', 'busy', 'generating', 'stopped', 'hidden', 'live', 'other_chat',
    'journal_changed', 'context_changed', 'not_saved', 'display_mismatch', 'review_pending', 'already_prompted',
    'automatic_paused', 'candidate_failed', 'no_completed_reply', 'candidate_rejected', 'timeout', 'aborted', 'network', 'hook_error']);
function sanitize(stage, data = {}) {
    if (!STAGES.has(stage)) return null;
    const row = { stage };
    for (const key of ['id', 'jobId', 'selectedId']) if (ID.test(data[key])) row[key] = data[key];
    for (const key of ['httpStatus', 'bytes', 'count', 'revision', 'candidates', 'chars']) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0) row[key] = data[key];
    }
    for (const key of ['manual', 'allowUnreviewed', 'reviewPending', 'applied', 'reloadRecovery']) if (typeof data[key] === 'boolean') row[key] = data[key];
    if (['ttotto', 'hundredlog'].includes(data.reviewer)) row.reviewer = data.reviewer;
    if (REASONS.has(data.reason) || /^guard_\d{1,3}$/.test(data.reason)) row.reason = data.reason;
    return row;
}
export function createDiagnostics({ storage, limit = 600, now = Date.now } = {}) {
    let key, rows = [], dropped = 0, storageFailures = 0;
    const sessionId = globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random().toString(36).slice(2)}`;
    function persist() {
        try { storage?.setItem(key, JSON.stringify({ rows, dropped })); } catch { storageFailures++; }
    }
    function bind(owner) {
        if (typeof owner !== 'string' || !owner) return;
        const next = `silly-relay-diagnostics-v1:${owner}`;
        if (key === next) return;
        key = next; rows = []; dropped = 0;
        try {
            const stored = JSON.parse(storage?.getItem(key) || '{}');
            for (const item of Array.isArray(stored.rows) ? stored.rows.slice(-limit) : []) {
                const safe = sanitize(item.stage, item);
                if (safe && Number.isSafeInteger(item.at)) rows.push({ ...safe, at: item.at,
                    sessionId: /^[a-zA-Z0-9-]{1,80}$/.test(item.sessionId) ? item.sessionId : 'unknown' });
            }
            if (Number.isSafeInteger(stored.dropped) && stored.dropped >= 0) dropped = stored.dropped;
        } catch { storageFailures++; }
        record('browser_ready');
    }
    function record(stage, data) {
        if (!key) return;
        const safe = sanitize(stage, data); if (!safe) return;
        rows.push({ ...safe, at: now(), sessionId });
        if (rows.length > limit) { dropped += rows.length - limit; rows.splice(0, rows.length - limit); }
        persist();
    }
    return { bind, record, report: () => ({ version: 1, limit, dropped, storageFailures, events: rows.map(row => ({ ...row })) }) };
}

export async function collectDiagnostics({ api, headers, diagnostics, reasons = {} }) {
    let server, status;
    try {
        status = await api('/status', { headers: headers() });
        diagnostics.bind(status.owner);
        server = status.diagnosticJournal ? await api('/diagnostics', { headers: headers() })
            : { unavailable: true, reason: 'server_update_required', events: [] };
    } catch (error) {
        server = { unavailable: true, reason: 'server_unreachable', events: [],
            ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
    }
    const browser = diagnostics.report();
    return { extension: 'Silly Relay', version: '1.0.22', exportedAt: new Date().toISOString(),
        serverVersion: typeof status?.version === 'string' && /^[0-9.\w-]{1,40}$/.test(status.version) ? status.version : null,
        note: 'Server read means a response was sent, not that the browser displayed or saved it. Browser events describe only this browser. Times use each device clock. No reply bodies, prompts, keys or character/chat names are included. Prior events may be absent due to rotation, limits or storage failures. Push notification delivery is not observed by Relay.',
        reasons, server, browser,
        timeline: [...server.events.map(row => ({ ...row, source: 'server' })), ...browser.events.map(row => ({ ...row, source: 'browser' }))].sort((a, b) => a.at - b.at) };
}
