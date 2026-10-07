const { test } = require('node:test');
const assert = require('node:assert/strict');
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) || null, setItem: (k,v) => m.set(k,v) }; };
test('home-screen recovery identity survives a fresh session while browser tabs stay separate', async () => {
    const { recoveryIdentity } = await import('../identity.mjs');
    const local = memory(); let counter = 0;
    const newId = () => String(++counter).padStart(32, '0');
    const first = recoveryIdentity({ local, session: memory(), standalone: true, newId });
    const relaunched = recoveryIdentity({ local, session: memory(), standalone: true, newId });
    assert.equal(relaunched, first);
    const tab1 = recoveryIdentity({ local, session: memory(), standalone: false, newId });
    const tab2 = recoveryIdentity({ local, session: memory(), standalone: false, newId });
    assert.notEqual(tab1, first); assert.notEqual(tab2, tab1);
});
test('upgrading an open PWA preserves its pending tab binding and works without session storage', async () => {
    const { recoveryIdentity } = await import('../identity.mjs');
    const local = memory(), session = memory(); const old = 'a'.repeat(32);
    session.setItem('silly-relay-tab', old);
    assert.equal(recoveryIdentity({ local, session, standalone: true, newId: () => 'b'.repeat(32) }), old);
    const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
    assert.equal(recoveryIdentity({ local, session: denied, standalone: true }), old);
});
test('failure to persist a new identity is explicit rather than a false promise of recovery', async () => {
    const { recoveryIdentity } = await import('../identity.mjs');
    const silent = { getItem: () => null, setItem() {} };
    assert.throws(() => recoveryIdentity({ local: silent, session: memory(), standalone: true, newId: () => 'c'.repeat(32) }), /저장/);
});
