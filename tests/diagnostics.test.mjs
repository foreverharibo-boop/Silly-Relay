import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, collectDiagnostics } from '../diagnostics.mjs';
const ID = 'a'.repeat(32);
const memory = () => { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }; };
test('browser trace persists reloads, bounds history, strips private data and separates accounts', () => {
    const storage = memory(), diag = createDiagnostics({ storage, limit: 4 }); diag.bind('alice');
    for (let i = 0; i < 6; i++) diag.record('candidate_selected', { id: ID, chars: i, text: 'PRIVATE_BODY', message: 'PRIVATE_ERROR', reason: 'PRIVATE_REASON' });
    const reloaded = createDiagnostics({ storage, limit: 4 }); reloaded.bind('alice');
    assert.equal(reloaded.report().events.length, 4); assert.ok(reloaded.report().dropped > 0);
    assert.ok(reloaded.report().events.some(e => e.id === ID));
    assert.doesNotMatch(JSON.stringify(reloaded.report()), /PRIVATE|alice/);
    reloaded.bind('bob'); assert.equal(reloaded.report().events.length, 1);
    assert.ok(!reloaded.report().events.some(e => e.id === ID));
});
test('browser storage failure remains visible without breaking recording', () => {
    const d = createDiagnostics({ storage: { getItem() { throw Error('PRIVATE'); }, setItem() { throw Error('PRIVATE'); } } });
    assert.doesNotThrow(() => { d.bind('alice'); d.record('starting', { id: ID }); });
    assert.ok(d.report().storageFailures >= 2); assert.equal(d.report().events.at(-1).id, ID);
});
test('one export joins server and browser request IDs without exporting account identity', async () => {
    const d = createDiagnostics({ storage: memory(), now: () => 200 }); d.bind('alice'); d.record('display_applied', { id: ID });
    const r = await collectDiagnostics({ diagnostics: d, headers: () => ({}), api: async p => p === '/status'
        ? { owner: 'alice', version: '1.0.3', diagnosticJournal: true }
        : { events: [{ at: 100, id: ID, stage: 'completed' }] } });
    assert.equal(r.timeline[0].source, 'server');
    assert.ok(r.timeline.some(e => e.id === ID && e.source === 'browser'));
    assert.doesNotMatch(JSON.stringify(r), /alice/);
});
test('old or offline server still exports browser records with a clear missing-server flag', async () => {
    const d = createDiagnostics({ storage: memory() }); d.bind('alice'); d.record('starting', { id: ID });
    for (const online of [true, false]) {
        const r = await collectDiagnostics({ diagnostics: d, headers: () => ({}), api: async () => {
            if (!online) throw Error('PRIVATE_SERVER_ERROR'); return { owner: 'alice', version: '1.0.2' };
        } });
        assert.equal(r.server.unavailable, true); assert.ok(r.browser.events.some(e => e.id === ID));
        assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SERVER_ERROR/);
    }
});
