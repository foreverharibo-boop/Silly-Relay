import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, MARK } from '../recovery.mjs';

const ID = 'a'.repeat(32);
const PATH = '/api/backends/chat-completions/generate';
const USER = { name: 'User', is_user: true, mes: 'hello', send_date: '2026-10-13' };
const TEXT = 'The complete reply';
const FINAL = { name: 'Character', is_user: false, is_system: false, mes: TEXT,
    swipes: [TEXT], swipe_id: 0, extra: { [MARK]: { id: ID, complete: true } } };

function fixture(t, options = {}) {
    let disk = [structuredClone(USER)];
    const entries = new Map(), events = [], rendered = [], notes = [];
    const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
    const ctx = { chat: structuredClone(disk), characters: [{ avatar: 'Char.png' }], characterId: 0,
        chatId: 'Chat A', name2: 'Character', chatCompletionSettings: {},
        eventTypes: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: { async emit(...args) { events.push(args); } },
        addOneMessage(message) { rendered.push(message); },
        async saveChat() { disk = structuredClone(ctx.chat); } };
    const raw = Buffer.from(JSON.stringify({ choices: [{ message: { content: TEXT } }] }));
    const settings = { getContext: () => ctx, storage, tabId: 'same-tab', getHeaders: () => ({}),
        fetchImpl: async () => Response.json([{ chat_metadata: {} }, ...disk]),
        api: async path => path === '/status' ? { reloadRecovery: true, owner: 'owner' }
            : path.endsWith('/ack') ? {} : { id: ID, state: 'completed', status: 200, bytes: raw.length,
                cursor: 0, next: raw.length, data: raw.toString('base64'), finishedAt: Date.now() },
        notify: message => notes.push(message), ...options };
    const recovery = createRecovery(settings);
    t.after(() => recovery.stop());
    return { ctx, recovery, events, rendered, notes, settings,
        setDisk(value) { disk = structuredClone(value); },
        async prepare() {
            recovery.generationStarted('normal'); recovery.dataReady({}, false);
            assert.equal(await recovery.prepare({ id: ID, path: PATH, body: '{"type":"normal"}' }), true);
            // The original delivery was interrupted; allow same-page recovery.
            recovery.event('error', { id: ID }); recovery.generationEnded();
        } };
}

test('saved reply reports its receipt once without replaying translation/review events', async t => {
    let captured = 0, received = 0;
    const h = fixture(t, { captureReplyReceipt(identity) {
        assert.deepEqual(identity, { avatar: 'Char.png', file: 'Chat A' }); captured++;
        return { received() { received++; } };
    } });
    await h.prepare(); h.setDisk([USER, FINAL]); await h.recovery.recover();
    assert.equal(h.ctx.chat[1].mes, TEXT); assert.equal(received, 1); assert.equal(captured, 1);
    assert.equal(h.events.length, 0); assert.equal(h.rendered.length, 1);
    await h.recovery.recover(); assert.equal(received, 1);
});

test('new recovery reports full reply before a slow save; normal events still wait for durability', async t => {
    let received = 0, unblockSave, enteredSave;
    const saveStarted = new Promise(resolve => { enteredSave = resolve; });
    const h = fixture(t, { captureReplyReceipt: () => ({ received() { received++; } }) });
    await h.prepare();
    const save = h.ctx.saveChat;
    h.ctx.saveChat = async () => { enteredSave(); await new Promise(resolve => { unblockSave = resolve; }); await save(); };
    const pending = h.recovery.recover(); await saveStarted;
    assert.equal(h.ctx.chat[1].mes, TEXT); assert.equal(received, 1); assert.equal(h.events.length, 0);
    h.ctx.saveChat = save; unblockSave(); await pending;
    assert.equal(h.events.filter(e => e[0] === 'received').length, 1);
    assert.equal(h.events.filter(e => e[0] === 'rendered').length, 1);
    assert.equal(received, 1);
});

test('failed save retains the buffer while cancelling main retry only once', async t => {
    let received = 0;
    const h = fixture(t, { captureReplyReceipt: () => ({ received() { received++; } }) });
    await h.prepare(); const save = h.ctx.saveChat; h.ctx.saveChat = async () => {};
    await h.recovery.recover();
    assert.equal(h.recovery.list().length, 1); assert.equal(received, 1); assert.equal(h.events.length, 0);
    h.ctx.saveChat = save; await h.recovery.recover();
    assert.equal(h.recovery.list().length, 0); assert.equal(received, 1);
});

test('already visible durable reply without marker reports receipt without duplicate render', async t => {
    let received = 0;
    const h = fixture(t, { captureReplyReceipt: () => ({ received() { received++; } }) });
    await h.prepare(); const message = { ...structuredClone(FINAL), extra: {} };
    h.ctx.chat.push(message); h.setDisk(h.ctx.chat);
    await h.recovery.recover();
    assert.equal(received, 1); assert.equal(h.rendered.length, 0); assert.equal(h.events.length, 0);
});

test('fresh page does not bind an old journal entry to a new retry', async t => {
    let captured = 0, received = 0;
    const h = fixture(t, { captureReplyReceipt() { captured++; return { received() { received++; } }; } });
    await h.prepare(); h.recovery.stop(); h.setDisk([USER, FINAL]);
    const fresh = createRecovery(h.settings); t.after(() => fresh.stop());
    await fresh.recover();
    assert.equal(h.ctx.chat[1].mes, TEXT); assert.equal(captured, 1); assert.equal(received, 0);
});

test('absent, old or throwing retry integration cannot break recovery', async t => {
    for (const captureReplyReceipt of [undefined, () => null, () => { throw new Error('capture'); },
        () => ({ received() { throw new Error('receipt'); } })]) {
        const h = fixture(t, { captureReplyReceipt }); await h.prepare(); await h.recovery.recover();
        assert.equal(h.ctx.chat[1].mes, TEXT); assert.equal(h.recovery.list().length, 0);
        assert.equal(h.events.filter(e => e[0] === 'received').length, 1);
    }
});

test('helper requests do not capture a main-reply receipt', async t => {
    let captured = 0;
    const h = fixture(t, { captureReplyReceipt() { captured++; } });
    h.recovery.generationStarted('quiet'); h.recovery.dataReady({}, false);
    assert.equal(await h.recovery.prepare({ id: ID, path: PATH, body: '{"type":"quiet"}' }), false);
    assert.equal(captured, 0);
});

test('changed chat content prevents recovery and receipt notification', async t => {
    let received = 0;
    const h = fixture(t, { captureReplyReceipt: () => ({ received() { received++; } }) });
    await h.prepare(); h.ctx.chat[0].mes = 'edited history';
    await h.recovery.recover(); assert.equal(received, 0); assert.equal(h.ctx.chat.length, 1);
});
