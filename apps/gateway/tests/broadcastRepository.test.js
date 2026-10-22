const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJsonBroadcastRepository } = require('../services/repositories/jsonBroadcastRepository');

test('JSON broadcast repository loads missing and saved snapshots from its configured path', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-broadcast-repo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'broadcasts.json');
    const repository = createJsonBroadcastRepository(file);
    const snapshot = {
        enabled: true,
        dailySends: { '56912345678': { date: '2026-10-22', count: 1 } },
        broadcasts: [{ id: 'broadcast-1', status: 'pending', cursor: 2 }]
    };

    assert.equal(repository.exists(), false);
    repository.save(snapshot);
    assert.equal(repository.exists(), true);
    assert.deepEqual(repository.load(), snapshot);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('JSON broadcast repository preserves the last snapshot when serialization fails', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-broadcast-repo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'broadcasts.json');
    const repository = createJsonBroadcastRepository(file);
    const snapshot = { enabled: true, broadcasts: [] };
    repository.save(snapshot);

    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => repository.save(cyclic), TypeError);
    assert.deepEqual(repository.load(), snapshot);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});
