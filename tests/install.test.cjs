'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('installer uses selected user, leaves config intact, and refuses an existing installation', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-relay-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'server.js'), '// fixture');
    fs.writeFileSync(path.join(root, 'config.yaml'), 'enableServerPlugins: true\n');
    fs.mkdirSync(path.join(root, 'data', 'alice', 'chats'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'alice', 'extensions'), { recursive: true });
    const script = path.resolve(__dirname, '../install.sh');
    const result = spawnSync('bash', [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(require(path.join(root, 'plugins', 'Silly-Relay', 'server', 'index.cjs')).info.id, 'silly-relay');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'alice', 'extensions', 'Silly-Relay', 'manifest.json')));
    assert.equal(manifest.version, '0.1.0-test.3');
    assert.equal(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), 'enableServerPlugins: true\n');
    const again = spawnSync('bash', [script, root], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /덮어쓰지 않고/);
});
