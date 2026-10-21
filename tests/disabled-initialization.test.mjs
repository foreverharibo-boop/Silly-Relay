import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Run the actual entry point and its actual modules; only browser surfaces are
// simulated. Transport-only tests miss initialization and event subscribers.
for (const stored of [null, 'false']) test(`disabled entry point preserves Vertex requests (stored=${stored})`, async () => {
    const bindings = {};
    const source = (await fs.readFile(new URL('../index.js', import.meta.url), 'utf8'));
    for (const [, names, specifier] of source.matchAll(/import \{([^}]+)\} from '([^']+)';/g)) {
        const module = await import(new URL(specifier, new URL('../index.js', import.meta.url)));
        for (const name of names.split(',').map(s => s.trim())) bindings[name] = module[name];
    }
    const events = new Map(), surfaceEvents = [], timers = [], calls = [], warnings = [];
    const storage = () => {
        const values = new Map();
        return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    };
    const localStorage = storage();
    if (stored !== null) localStorage.setItem('silly-relay-enabled-v1', stored);
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {}, append() {}, checked: false });
        return nodes.get(selector);
    };
    const panel = { querySelector: node };
    const settings = Object.freeze({ vertexai_model: 'gemini-4-argon', vertexai_region: 'global' });
    const chat = Object.freeze([]);
    const names = ['GENERATION_STARTED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY',
        'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'APP_READY'];
    const context = { chat, chatId: 'fixture', characterId: 0, characters: [{ avatar: 'fixture.png' }],
        chatCompletionSettings: settings, getRequestHeaders: () => ({}),
        eventTypes: Object.fromEntries(names.map(name => [name, name])),
        eventSource: { on: (name, fn) => events.set(name, fn), makeFirst: (name, fn) => events.set(name, fn) } };
    const nativeFetch = async (input, init) => { calls.push({ input, init }); return Response.json({ ok: true }); };
    const sandbox = { ...bindings, fetch: nativeFetch, localStorage, sessionStorage: storage(),
        SillyTavern: { getContext: () => context }, navigator: {}, location: { href: 'http://localhost:8001/' },
        crypto: webcrypto, Request, Response, Headers, URL, AbortController, DOMException,
        console, toastr: { warning: message => warnings.push(message) },
        document: { readyState: 'complete', visibilityState: 'visible', hidden: false,
            createElement: () => panel, querySelector: node, addEventListener: (_name, fn) => surfaceEvents.push(fn) },
        addEventListener: (_name, fn) => surfaceEvents.push(fn),
        setInterval: fn => { timers.push(fn); return timers.length; }, setTimeout, clearTimeout };
    vm.runInNewContext(source.replace(/^import .*;\n/gm, ''), sandbox, { filename: 'relay-entry-point.js' });
    assert.equal(node('input').checked, false);
    for (const fn of [...surfaceEvents, ...timers]) await fn();
    await events.get('APP_READY')();
    assert.equal(calls.length, 0, 'disabled clean startup must not contact the plugin');
    for (let i = 0; i < 3; i++) {
        const messages = Object.freeze([Object.freeze({ role: 'user', content: 'fixture' })]);
        const payload = Object.freeze({ model: settings.vertexai_model, chat_completion_source: 'vertexai',
            vertexai_region: 'global', messages, type: 'normal', stream: false });
        await events.get('GENERATION_STARTED')('normal', {}, false);
        await events.get('GENERATE_AFTER_DATA')({ prompt: messages }, false);
        await events.get('CHAT_COMPLETION_SETTINGS_READY')(payload);
        const init = Object.freeze({ method: 'POST', body: JSON.stringify(payload) });
        await sandbox.fetch('/api/backends/chat-completions/generate', init);
        assert.equal(calls.at(-1).init, init, 'disabled hook must forward the original options');
        assert.equal(JSON.parse(calls.at(-1).init.body).model, 'gemini-4-argon');
        await events.get('STREAM_TOKEN_RECEIVED')();
        await events.get('MESSAGE_RECEIVED')(0);
        await events.get('GENERATION_ENDED')();
    }
    assert.equal(calls.length, 3);
    assert.equal(settings.vertexai_model, 'gemini-4-argon');
    assert.deepEqual(warnings, []);
});
