'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const EVENTS = new Set(['accepted', 'duplicate_start', 'upstream_headers', 'completed', 'failed', 'cancelled', 'read', 'reader_disconnected', 'acknowledged', 'expired', 'api_error']);
const ID = /^[a-f0-9]{32}$/;
const ownerKey = owner => createHash('sha256').update(owner).digest('hex');

// A single rotated journal bounds total disk use across accounts. Ownership is
// assigned by authenticated server code, never by a client-supplied parameter.
function createJournal({ directory, maxBytes = 1024 * 1024, queueLimit = 1024 } = {}) {
    const file = path.join(directory, 'events.jsonl'), previous = file + '.1';
    const bootId = randomBytes(16).toString('hex');
    let chain = Promise.resolve(), queued = 0, dropped = 0, writeFailures = 0;
    let initialized = false, size = 0;
    function record(owner, stage, id, data = {}) {
        if (typeof owner !== 'string' || !owner || !EVENTS.has(stage)) return;
        if (queued >= queueLimit) { dropped++; return; }
        const row = { at: Date.now(), bootId, owner: ownerKey(owner), stage };
        if (ID.test(id)) row.id = id;
        for (const key of ['status', 'bytes', 'cursor', 'next']) {
            if (Number.isSafeInteger(data[key]) && data[key] >= 0) row[key] = data[key];
        }
        const line = JSON.stringify(row) + '\n';
        queued++;
        chain = chain.then(async () => {
            if (!initialized) {
                await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                try { size = (await fs.stat(file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
                initialized = true;
            }
            if (size + Buffer.byteLength(line) > maxBytes) {
                await fs.rm(previous, { force: true });
                try { await fs.rename(file, previous); } catch (e) { if (e.code !== 'ENOENT') throw e; }
                size = 0;
            }
            await fs.appendFile(file, line, { mode: 0o600 });
            size += Buffer.byteLength(line);
        }).catch(() => { writeFailures++; initialized = false; })
            .finally(() => { queued--; });
    }
    async function report(owner) {
        await chain;
        const events = []; let readFailures = 0;
        for (const name of [previous, file]) {
            try {
                for (const line of (await fs.readFile(name, 'utf8')).split('\n')) {
                    try {
                        const row = JSON.parse(line);
                        if (row.owner !== ownerKey(owner) || !EVENTS.has(row.stage)) continue;
                        // Rebuild, rather than exporting arbitrary file fields.
                        const safe = { at: row.at, stage: row.stage };
                        if (ID.test(row.bootId)) safe.bootId = row.bootId;
                        if (ID.test(row.id)) safe.id = row.id;
                        for (const key of ['status', 'bytes', 'cursor', 'next']) if (Number.isSafeInteger(row[key]) && row[key] >= 0) safe[key] = row[key];
                        events.push(safe);
                    } catch { /* A partial line is not a reason to break recovery. */ }
                }
            } catch (e) { if (e.code !== 'ENOENT') readFailures++; }
        }
        return { version: 1, bootId, maxBytesPerFile: maxBytes, files: 2, dropped, writeFailures, readFailures,
            omitted: Math.max(0, events.length - 2000), events: events.slice(-2000) };
    }
    return { record, report, flush: () => chain };
}
module.exports = { createJournal };
