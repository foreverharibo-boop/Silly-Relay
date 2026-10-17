const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJournal, errorDetails } = require('../server/diagnostics.cjs');
const ID = 'a'.repeat(32);
async function temp(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-diag-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
test('server journal survives restart, isolates accounts and omits supplied private fields', async t => {
    const directory = await temp(t), journal = createJournal({ directory });
    journal.record('alice', 'accepted', ID, { body: 'PRIVATE_BODY', cookie: 'PRIVATE_KEY', model: 'PRIVATE_MODEL' });
    journal.record('bob', 'completed', 'b'.repeat(32), { status: 200, bytes: 456 });
    journal.record('alice', 'completed', ID, { status: 200, bytes: 123 });
    await journal.flush();
    const restarted = createJournal({ directory });
    const alice = await restarted.report('alice'), bob = await restarted.report('bob');
    assert.deepEqual(alice.events.map(x => x.stage), ['accepted', 'completed']);
    assert.equal(bob.events.length, 1); assert.equal(bob.events[0].id, 'b'.repeat(32));
    assert.notEqual(alice.bootId, alice.events[0].bootId);
    const disk = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(disk, /PRIVATE_|alice|bob/);
    assert.doesNotMatch(JSON.stringify(alice), /owner|PRIVATE_|bbbb/);
    assert.equal((await fs.stat(path.join(directory, 'events.jsonl'))).mode & 0o777, 0o600);
});
test('rotation bounds disk storage and keeps most recent records', async t => {
    const directory = await temp(t), journal = createJournal({ directory, maxBytes: 600 });
    for (let i = 0; i < 30; i++) journal.record('alice', 'read', ID, { cursor: i });
    const report = await journal.report('alice');
    const names = await fs.readdir(directory); assert.equal(names.length, 2);
    for (const name of names) assert.ok((await fs.stat(path.join(directory, name))).size <= 600);
    assert.equal(report.events.at(-1).cursor, 29); assert.ok(report.events.length < 30);
});
test('bounded queue and unavailable filesystem are explicit and never throw to generation', async t => {
    const directory = await temp(t);
    const blocker = path.join(directory, 'file'); await fs.writeFile(blocker, '');
    const journal = createJournal({ directory: blocker, queueLimit: 2 });
    for (let i = 0; i < 10; i++) assert.doesNotThrow(() => journal.record('alice', 'accepted', ID));
    const report = await journal.report('alice');
    assert.equal(report.dropped, 8); assert.equal(report.writeFailures, 2);
    assert.equal(report.events.length, 0);
});

test('connection details persist and export without error messages, addresses or injected fields', async t => {
    const directory = await temp(t), journal = createJournal({ directory });
    const error = Object.assign(new Error('SECRET URL key cookie prompt'), { code: 'ECONNREFUSED', syscall: 'connect',
        address: 'SECRET_ADDRESS', rawPacket: Buffer.from('SECRET_BODY'), cause: { code: 'EACCES', message: 'SECRET_CAUSE' } });
    journal.record('alice', 'failed', ID, { ...error, ...errorDetails(error), phase: 'connecting',
        reason: 'connection_error', targetKind: 'loopback_ipv4', globalAgentKind: 'private_filter',
        requestFinished: false, elapsedMs: 25, status: 0, bytes: 0 });
    journal.record('alice', 'failed', ID, { ...errorDetails({ code: 'SECRET_KEY', syscall: 'SECRET_PATH', cause: { code: 'SECRET_CAUSE' } }),
        phase: 'SECRET_PHASE', reason: 'SECRET_REASON', targetKind: 'SECRET_ADDRESS' });
    await journal.flush();
    const restarted = await createJournal({ directory }).report('alice');
    assert.equal(restarted.version, 2);
    assert.equal(restarted.events[0].errorCode, 'ECONNREFUSED');
    assert.equal(restarted.events[0].causeCode, 'EACCES');
    assert.equal(restarted.events[0].phase, 'connecting');
    assert.equal(restarted.events[0].requestFinished, false);
    assert.equal(restarted.events[0].elapsedMs, 25);
    assert.equal(restarted.events[1].errorCode, 'UNKNOWN');
    assert.equal(restarted.events[1].causeCode, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(restarted), /SECRET/);
    assert.doesNotMatch(await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8'), /SECRET/);
});
