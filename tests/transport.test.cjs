const { test } = require('node:test');
const assert = require('node:assert/strict');
const origin = 'http://localhost:8000';
const PATH = '/api/backends/chat-completions/generate';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
test('abort during acceptance rejects as cancellation without emitting request-error warning', async () => {
    const { createTransport } = await import('../transport.mjs');
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const events = [], calls = [], controller = new AbortController();
    const transport = createTransport({ origin, enabled: () => true,
        onEvent: type => events.push(type),
        fetchImpl: async (url) => {
            calls.push(url);
            if (url.endsWith('/cancel')) return json({ state: 'cancelled' });
            if (url.endsWith('/jobs')) { started(); await gate; return json({ state: 'running' }); }
            throw new Error('Unexpected result polling after stop');
        } });
    const result = transport.fetch(PATH, { method: 'POST', body: '{}', signal: controller.signal });
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await began; controller.abort(); release(); await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(url => url.endsWith('/jobs')).length, 1);
    assert.ok(calls.some(url => url.endsWith('/cancel')));
    assert.ok(events.includes('cancelled'));
    assert.equal(events.includes('error'), false);
});
test('server-confirmed cancellation is not a request error or a new cancel request', async () => {
    const { createTransport } = await import('../transport.mjs');
    for (const stage of ['acceptance', 'result']) {
        const events = [], calls = [];
        const transport = createTransport({ origin, enabled: () => true,
            onEvent: type => events.push(type), fetchImpl: async url => {
                calls.push(url);
                return json({ state: stage === 'result' && url.endsWith('/jobs') ? 'running' : 'cancelled' });
            } });
        await assert.rejects(transport.fetch(PATH, { method: 'POST', body: '{}' }), { name: 'AbortError' });
        assert.equal(events.includes('error'), false);
        assert.ok(events.includes('cancelled'));
        assert.equal(calls.some(url => url.endsWith('/cancel')), false);
    }
});
test('real server failures still emit request errors', async () => {
    const { createTransport } = await import('../transport.mjs');
    const events = [];
    const transport = createTransport({ origin, enabled: () => true,
        onEvent: (type, data) => events.push({ type, data }),
        fetchImpl: async () => json({ error: 'fixture unavailable' }, 503) });
    await assert.rejects(transport.fetch(PATH, { method: 'POST', body: '{}' }), /fixture unavailable/);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    assert.equal(events.some(e => e.type === 'cancelled'), false);
});
