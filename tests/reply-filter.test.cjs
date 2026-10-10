const { test } = require('node:test');
const assert = require('node:assert/strict');
const PATH = '/api/backends/chat-completions/generate';
const clone = data => JSON.parse(JSON.stringify(data));
const take = (filter, data, path = PATH) => filter.take({ path, payload: clone(data) });

test('reply events bind only the actual final payload, not preparatory/helper requests', async () => {
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    filter.generationStarted();
    const helper = { messages: [{ role: 'user', content: 'memory selection' }] };
    assert.equal(filter.settingsReady(helper), false);
    assert.equal(take(filter, helper), false);
    const prompt = [{ role: 'user', content: 'real reply' }];
    filter.dataReady({ prompt });
    const reply = { messages: prompt.filter(Boolean), model: 'fixture' };
    assert.equal(filter.settingsReady(reply), true);
    // A helper cannot overwrite or consume the pending main request.
    assert.equal(filter.settingsReady({ ...helper, type: 'normal' }), false);
    assert.equal(take(filter, { ...helper, type: 'normal' }), false);
    assert.equal(take(filter, { ...reply, model: 'other' }), false);
    reply.silly_pop = { generationId: 'local' };
    const outgoing = { ...reply, silly_pop_ios: { requestId: 'ios' } };
    assert.equal(take(filter, outgoing), true);
    assert.equal(take(filter, outgoing), false, 'one final request per generation frame');
});

test('normal, swipe, regenerate and continue work without browser stack inspection', async () => {
    const { createReplyFilter } = await import('../reply-filter.mjs');
    for (const type of [undefined, 'normal', 'swipe', 'regenerate', 'continue']) {
        for (const stream of [false, true]) {
            const filter = createReplyFilter();
            const prompt = [{ role: 'user', content: 'reply' }];
            filter.generationStarted(type);
            filter.dataReady({ prompt });
            const payload = { type, stream, messages: prompt.filter(Boolean) };
            assert.equal(filter.settingsReady(payload), true);
            assert.equal(take(filter, payload), true);
            filter.generationEnded();
        }
    }
});

test('quiet, impersonation, dry runs and unknown requests bypass; nested helper preserves main binding', async () => {
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    const prompt = [{ role: 'user', content: 'reply' }];
    const main = { messages: prompt };
    filter.generationStarted(); filter.dataReady({ prompt }); filter.settingsReady(main);
    for (const [type, options, dryRun] of [['quiet', {}, false], ['impersonate', {}, false], [undefined, {}, true], ['normal', { quietToLoud: true }, false]]) {
        filter.generationStarted(type, options, dryRun);
        filter.dataReady({ prompt });
        assert.equal(filter.settingsReady({ messages: prompt, type }), false);
        assert.equal(take(filter, { messages: prompt, type }), false);
        filter.generationEnded();
    }
    assert.equal(take(filter, main), true);
    filter.clear();
    assert.equal(take(filter, main), false);
});

test('text generation uses its final data event and excludes quiet requests', async () => {
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    const payload = { prompt: 'actual reply prompt', max_length: 100 };
    filter.generationStarted(); filter.dataReady(payload);
    assert.equal(take(filter, { prompt: 'helper' }, '/api/novelai/generate'), false);
    assert.equal(take(filter, payload, '/api/novelai/generate'), true);
    filter.generationEnded();
    filter.generationStarted('quiet'); filter.dataReady(payload);
    assert.equal(take(filter, payload, '/api/novelai/generate'), false);
});

test('bypassed requests keep input, headers, body, abort signal and response unchanged', async () => {
    const { createTransport } = await import('../transport.mjs');
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    const calls = [], events = [];
    let prepared = 0;
    const result = new Response('helper result');
    const transport = createTransport({ origin: 'https://example.test', enabled: () => true,
        shouldRelay: filter.take, prepareRecovery: () => { prepared++; }, onEvent: event => events.push(event),
        fetchImpl: async (...args) => { calls.push(args); return result; } });
    const input = new Request('https://example.test' + PATH, { method: 'POST', body: JSON.stringify({ type: 'quiet' }), headers: { 'x-custom': 'kept' } });
    const options = { signal: new AbortController().signal };
    assert.equal(await transport.fetch(input, options), result);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], input); assert.equal(calls[0][1], options);
    assert.equal(await input.text(), '{"type":"quiet"}');
    assert.equal(prepared, 0); assert.deepEqual(events, []);
});

test('capacity warnings are bounded while other failures and later warnings remain visible', async () => {
    const { createWarningGate } = await import('../reply-filter.mjs');
    let now = 0;
    const gate = createWarningGate(() => now);
    assert.equal(gate('relay-capacity'), true);
    for (let i = 0; i < 10; i++) assert.equal(gate('relay-capacity'), false);
    assert.equal(gate('other failure'), true);
    now = 30000;
    assert.equal(gate('relay-capacity'), true);
});


test('observing native payload before a cooperating extension clones messages preserves the final binding', async () => {
    const { createReplyFilter } = await import('../reply-filter.mjs');
    const filter = createReplyFilter();
    const prompt = [{ role: 'user', content: 'main' }];
    filter.generationStarted(); filter.dataReady({ prompt });
    const payload = { messages: prompt.filter(Boolean) };
    assert.equal(filter.settingsReady(payload), true);
    payload.messages = payload.messages.map(m => ({ ...m }));
    payload.messages.push({ role: 'system', content: 'injected rule' });
    payload.__ttotto_main_request = 'local provenance';
    const sent = clone(payload); delete sent.__ttotto_main_request;
    assert.equal(take(filter, sent), true);
    assert.equal(take(filter, sent), false);
});
