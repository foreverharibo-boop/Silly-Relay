import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, MARK, replyBody } from '../recovery.mjs';

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
    assert.equal(h.events.filter(event => event[0] === 'received').length, 1, 'retry must run skipped tag/translation hooks');
});

test('a swallowed conditional save retries the original file before running hooks', async t => {
    let retries = 0;
    const h = fixture(t, { retrySave: async (identity, messages, valid) => {
        assert.equal(valid(), true); assert.deepEqual(identity, { avatar: 'Char.png', file: 'Chat A' });
        retries++; h.setDisk(messages);
    } });
    await h.prepare(); h.ctx.saveChat = async () => {};
    await h.recovery.recover();
    assert.equal(retries, 2, 'initial answer and final postprocessing each have one bounded retry');
    assert.equal(h.events.filter(event => event[0] === 'received').length, 1);
    assert.equal(h.recovery.list().length, 0);
});

test('failed retries keep the response and skip hooks until a verified save succeeds', async t => {
    let retries = 0;
    const h = fixture(t, { retrySave: async () => { retries++; } });
    await h.prepare(); const save = h.ctx.saveChat; h.ctx.saveChat = async () => {};
    await h.recovery.recover();
    assert.equal(retries, 1); assert.equal(h.events.length, 0); assert.equal(h.recovery.list().length, 1);
    h.ctx.saveChat = save;
    await h.recovery.recover();
    assert.equal(h.events.filter(event => event[0] === 'received').length, 1);
    assert.equal(h.recovery.list().length, 0);
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

test('recovery traces link selection, display, save read-back and release without bodies', async t => {
    const traces = [];
    const h = fixture(t, { trace: (stage, data) => traces.push({ stage, ...data }) });
    await h.prepare(); await h.recovery.recover({ manual: true });
    for (const stage of ['prepared', 'candidate_read', 'candidate_selected', 'display_applied', 'save_started', 'save_returned', 'durable_verified', 'released']) {
        assert.ok(traces.some(e => e.stage === stage && e.id === ID), stage);
    }
    assert.ok(traces.findIndex(e => e.stage === 'display_applied') < traces.findIndex(e => e.stage === 'durable_verified'));
    assert.doesNotMatch(JSON.stringify(traces), /The complete reply|Chat A|Char.png/);
});

test('failing diagnostic observer cannot interrupt reply recovery', async t => {
    const h = fixture(t, { trace() { throw Error('diagnostic failure'); }, onIdentity() { throw Error('diagnostic failure'); } });
    await h.prepare(); await h.recovery.recover({ manual: true });
    assert.equal(h.ctx.chat[1].mes, TEXT);
});

test('completed receipt ignores user edits, tags, swipe-text lag and extension metadata without writing', async t => {
    const h = fixture(t); await h.prepare();
    h.setDisk([USER, FINAL]);
    h.ctx.chat.push({ ...structuredClone(FINAL), mes: '<state>new</state>User edited this reply',
        extra: { ...FINAL.extra, display_text: 'Translation', sceneFacts: { place: 'Room' } } });
    const before = structuredClone(h.ctx.chat);
    let saves = 0; h.ctx.saveChat = async () => { saves++; };
    await h.recovery.settle(); await h.recovery.recover();
    assert.equal(h.recovery.list().length, 0);
    assert.deepEqual(h.ctx.chat, before);
    assert.equal(saves, 0); assert.equal(h.rendered.length, 0); assert.equal(h.events.length, 0);
    assert.deepEqual(h.notes, []);
});

test('completed receipt still requires the correct slot, character, request and durable completion', async t => {
    for (const wrong of ['slot', 'character', 'request', 'revision', 'partial', 'unsaved']) {
        const h = fixture(t); await h.prepare();
        const saved = [structuredClone(USER), structuredClone(FINAL)];
        if (wrong === 'slot') saved.splice(1, 0, { name: 'User', is_user: true, mes: 'another turn' });
        if (wrong === 'character') saved[1].name = 'Someone else';
        if (wrong === 'request') saved[1].extra[MARK].id = 'b'.repeat(32);
        if (wrong === 'revision') saved[1].extra[MARK].revision = 1;
        if (wrong === 'partial') saved[1].extra[MARK].complete = false;
        if (wrong === 'unsaved') saved.pop();
        h.ctx.chat.push(structuredClone(FINAL)); h.setDisk(saved);
        await h.recovery.settle();
        assert.equal(h.recovery.list().length, 1, wrong);
        assert.equal(h.rendered.length, 0, wrong);
    }
});

test('tag projection excludes paired nested blocks and comments without changing narrative text', () => {
    assert.equal(replyBody('<state a="1 > 0"><x>old</x></state>Story<상태>new</상태>'), 'Story');
    assert.equal(replyBody('Story<state>completely changed</state><!-- note -->'), 'Story');
    assert.equal(replyBody('<outer><outer>nested</outer>tail</outer>Story'), 'Story');
    assert.equal(replyBody('Story<state>unfinished'), 'Story<state>unfinished');
    assert.equal(replyBody('2 < 3 and 5 > 4'), '2 < 3 and 5 > 4');
    assert.equal(replyBody('<state>metadata only</state>'), '');
});

test('unmarked saved reply accepts tag-only differences without replaying hooks or overwriting tags', async t => {
    const h = fixture(t); await h.prepare();
    const saved = { ...structuredClone(FINAL), mes: `${TEXT}<state>disk</state>`,
        swipes: [`${TEXT}<state>disk</state>`], extra: {} };
    h.setDisk([USER, saved]);
    h.ctx.chat.push({ ...structuredClone(saved), mes: `${TEXT}<state>local</state>`,
        swipes: [`${TEXT}<state>local</state>`] });
    let saves = 0; h.ctx.saveChat = async () => { saves++; };
    await h.recovery.recover();
    assert.equal(h.recovery.list().length, 0);
    assert.equal(h.ctx.chat[1].mes, `${TEXT}<state>local</state>`);
    assert.equal(saves, 0); assert.equal(h.events.length, 0); assert.deepEqual(h.notes, []);
});

test('receipt retry observes delayed persistence without the ten-second polling loop', async t => {
    let reads = 0;
    const h = fixture(t); await h.prepare();
    h.ctx.chat.push(structuredClone(FINAL));
    const start = Date.now();
    await h.recovery.settle();
    const saved = setTimeout(() => h.setDisk([USER, FINAL]), 700);
    t.after(() => clearTimeout(saved));
    while (h.recovery.list().length && Date.now() - start < 2500) {
        await new Promise(resolve => setTimeout(resolve, 50)); reads++;
    }
    assert.ok(reads > 0);
    assert.equal(h.recovery.list().length, 0);
    assert.ok(Date.now() - start < 2500);
    assert.deepEqual(h.notes, []);
});

test('stopping recovery cancels scheduled receipt checks', async t => {
    let reads = 0;
    const h = fixture(t, { fetchImpl: async () => { reads++; return Response.json([{ chat_metadata: {} }, USER]); } });
    await h.prepare(); await h.recovery.settle(); h.recovery.stop();
    const before = reads;
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(reads, before);
});

test('a prompt preview cannot leave recovery stuck generating after the actual request ends', async t => {
    const traces=[];
    const h=fixture(t,{trace:(stage,data)=>traces.push({stage,...data})});
    h.recovery.generationStarted('normal');h.recovery.dataReady({},false);
    assert.equal(await h.recovery.prepare({id:ID,path:PATH,body:'{"type":"normal"}'}),true);
    // Native ST dry runs do not emit GENERATION_ENDED. They may run while a
    // real request is awaiting its response, e.g. a prompt-token preview.
    h.recovery.generationStarted('normal',{},true);h.recovery.dataReady({},true);
    // An interrupted browser delivery leaves the completed response on server.
    h.recovery.event('error',{id:ID});h.recovery.generationEnded();
    await h.recovery.recover();
    assert.equal(h.ctx.chat[1]?.mes,TEXT);
    assert.equal(traces.some(row=>row.stage==='recovery_blocked'&&row.reason==='generating'),false);
});

test('a prompt preview must not let recovery run during a real in-flight generation', async t => {
    const traces=[];
    const h=fixture(t,{trace:(stage,data)=>traces.push({stage,...data})});
    await h.prepare();
    h.recovery.generationStarted('normal');
    h.recovery.generationStarted('normal',{},true);h.recovery.dataReady({},true);
    await h.recovery.recover();
    assert.equal(h.ctx.chat.length,1,'the old buffered response must not race the new request');
    assert.ok(traces.some(row=>row.stage==='recovery_blocked'&&row.reason==='generating'));
});

test('recovery saves translation ticket with the exact reply before receive hooks run', async t => {
    const binding={id:'b'.repeat(32),variant:'verba',config:'123abc'};
    const raw=Buffer.from(JSON.stringify({choices:[{message:{content:TEXT}}]}));
    const h=fixture(t,{api:async path=>path==='/status'?{reloadRecovery:true,owner:'owner'}:path.endsWith('/ack')?{}:{id:ID,state:'completed',status:200,bytes:raw.length,cursor:0,next:raw.length,data:raw.toString('base64'),finishedAt:Date.now(),translation:binding}});
    let seen=false;
    h.ctx.eventSource.emit=async name=>{if(name==='received'){assert.deepEqual(h.ctx.chat[1].extra.silly_relay_translation,binding);seen=true;}};
    await h.prepare();await h.recovery.recover();
    assert.equal(seen,true);assert.equal(h.ctx.chat[1].mes,TEXT);
    assert.deepEqual(h.ctx.chat[1].swipe_info[0].extra.silly_relay_translation,binding);
});

test('conflicting old request pauses across reload without reads or repeated warnings; manual retry keeps guards', async t => {
    let reads = 0, diskReads = 0;
    const h = fixture(t); const api = h.settings.api, fetchImpl = h.settings.fetchImpl;
    h.settings.api = (...args) => { if (args[0] !== '/status') reads++; return api(...args); };
    h.settings.fetchImpl = (...args) => { diskReads++; return fetchImpl(...args); };
    await h.prepare(); h.recovery.stop();
    const conflict = [{ ...USER, mes: 'User changed the history' }];
    h.setDisk(conflict); h.ctx.chat = structuredClone(conflict);
    let page = createRecovery(h.settings); t.after(() => page.stop());
    await page.recover();
    assert.equal(page.list()[0].autoRecoveryPaused.reason, 'guard_14');
    const notes = h.notes.length, readsBefore = reads, diskBefore = diskReads;
    await page.recover(); page.stop();
    page = createRecovery(h.settings); t.after(() => page.stop());
    await page.recover(); await page.settle();
    assert.equal(reads, readsBefore); assert.equal(diskReads, diskBefore);
    assert.equal(h.notes.length, notes); assert.deepEqual(h.ctx.chat, conflict);
    await page.recover({ manual: true });
    assert.equal(page.list()[0].autoRecoveryPaused.reason, 'guard_14');
    assert.deepEqual(h.ctx.chat, conflict);
    h.ctx.chat = [structuredClone(USER)]; h.setDisk([USER]);
    await page.recover(); assert.equal(h.ctx.chat.length, 1, 'only an explicit retry releases the pause');
    await page.recover({ manual: true });
    assert.equal(h.ctx.chat[1].mes, TEXT); assert.equal(page.list().length, 0);
});

test('a paused old request does not prevent a newer reply in the same chat being recovered', async t => {
    const h = fixture(t); await h.prepare();
    const another = { name: 'Character', is_user: false, mes: 'Different saved answer' };
    h.ctx.chat.push(another); h.setDisk(h.ctx.chat);
    await h.recovery.recover(); assert.ok(h.recovery.list()[0].autoRecoveryPaused);
    h.ctx.chat.push({ ...USER, mes: 'Next turn' }); h.setDisk(h.ctx.chat);
    const nextId = 'b'.repeat(32);
    h.recovery.generationStarted('normal'); h.recovery.dataReady({}, false);
    await h.recovery.prepare({ id: nextId, path: PATH, body: '{"type":"normal"}' });
    h.recovery.event('error', { id: nextId }); h.recovery.generationEnded();
    await h.recovery.recover();
    assert.equal(h.ctx.chat[3].mes, TEXT);
    assert.equal(h.recovery.list().length, 1); assert.equal(h.recovery.list()[0].id, ID);
    assert.deepEqual(h.ctx.chat[1], another);
});
