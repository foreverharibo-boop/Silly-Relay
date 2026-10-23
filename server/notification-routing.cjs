'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const TARGETS = new Set(['legacy', 'none', 'apk', 'ios', 'and']);
// Account preference only. No tokens, subscriptions or conversation content.
function createRouting(directory) {
    const key = owner => createHash('sha256').update(owner).digest('hex');
    function get(owner) {
        if (!directory) return 'legacy';
        try {
            const value = JSON.parse(fs.readFileSync(path.join(directory, key(owner) + '.json'), 'utf8'));
            return TARGETS.has(value.target) ? value.target : 'legacy';
        } catch (e) { if (e.code === 'ENOENT') return 'legacy'; throw e; }
    }
    function set(owner, target) {
        if (!TARGETS.has(target)) throw Object.assign(new Error('알림 종류를 선택해 주세요.'), { status: 400 });
        if (!directory) throw Object.assign(new Error('알림 설정 저장소가 준비되지 않았습니다.'), { status: 503 });
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, key(owner) + '.json');
        const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
        try { fs.writeFileSync(temp, JSON.stringify({ target }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
        finally { try { fs.unlinkSync(temp); } catch {} }
        return target;
    }
    return { apiVersion: 1, get, set };
}
function filterMarkers(payload, target) {
    if (target === 'legacy') return payload;
    const copy = { ...payload };
    for (const [kind, field] of [['apk', 'silly_pop'], ['ios', 'silly_pop_ios'], ['and', 'silly_pop_and']]) {
        if (kind !== target) { delete copy[field]; if (copy.params?.[field]) { copy.params = { ...copy.params }; delete copy.params[field]; } }
    }
    return copy;
}
module.exports = { createRouting, filterMarkers, TARGETS };
