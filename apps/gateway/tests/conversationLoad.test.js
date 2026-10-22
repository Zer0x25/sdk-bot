'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertValid } = require('@sdk-bot/contracts');
const { uuidV5, canonicalJson, xorshift32, effectiveResourceLimits, parseCpuMax, parseCpuSet, parseMemoryMax,
    generateDataset, importDataset } = require('../scripts/conversation-load');
const { createArchive } = require('../services/conversations');

test('UUIDv5 generator matches the RFC 4122 reference vector', () => {
    assert.equal(uuidV5('www.widgets.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
        '21f7f8de-8051-5b89-8680-0195ef798b6a');
});

test('synthetic JSONL is contract-valid, canonical, and byte-for-byte reproducible', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-load-generator-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { contacts: 2, messagesPerConversation: 3, duplicateDeliveries: 2, retainedReplayEvents: 2 };
    const first = await generateDataset(path.join(root, 'first'), options);
    const second = await generateDataset(path.join(root, 'second'), options);
    assert.deepEqual(
        Object.fromEntries(Object.entries(first.files).map(([type, file]) => [type, file.sha256])),
        Object.fromEntries(Object.entries(second.files).map(([type, file]) => [type, file.sha256])),
    );
    assert.equal(first.files.Account.count, 5);
    assert.equal(first.files.Contact.count, 2);
    assert.equal(first.files.Conversation.count, 2);
    assert.equal(first.files.Message.count, 6);
    assert.equal(first.files.Event.count, 2);
    const messageLines = (await fs.readFile(first.files.Message.path, 'utf8')).trimEnd().split('\n');
    const messages = messageLines.map(line => JSON.parse(line));
    messages.forEach(message => assertValid('Message', message));
    assert.deepEqual(messages.slice(0, 3).map(message => message.authorKind), ['customer', 'ai', 'operator']);
    assert.equal(messages[0].occurredAt, messages[1].occurredAt);
    assert.ok(messages.every(message => message.content.text.length >= 100 && message.content.text.length <= 600));
    const manifestText = await fs.readFile(first.manifestPath, 'utf8');
    assert.equal(manifestText, `${canonicalJson(JSON.parse(manifestText))}\n`);
});

test('xorshift32 produces the same bounded stream from the same seed', () => {
    const left = xorshift32(20261019);
    const right = xorshift32(20261019);
    const a = Array.from({ length: 10 }, left);
    const b = Array.from({ length: 10 }, right);
    assert.deepEqual(a, b);
    assert.ok(a.every(value => value >= 0 && value < 1));
});

test('F2E.2 profile detection uses effective cgroup v2 quota and memory caps', () => {
    const files = new Map([
        ['/proc/self/cgroup', '0::/user.slice/benchmark.scope\n'],
        ['/fake/cgroup/user.slice/benchmark.scope/cpu.max', '200000 100000'],
        ['/fake/cgroup/user.slice/benchmark.scope/memory.max', '4294967296'],
        ['/fake/cgroup/user.slice/benchmark.scope/cpuset.cpus.effective', '0-3'],
        ['/fake/cgroup/user.slice/cpu.max', '300000 100000'],
        ['/fake/cgroup/user.slice/memory.max', '8589934592'],
        ['/fake/cgroup/user.slice/cpuset.cpus.effective', '0-3'],
        ['/fake/cgroup/cpu.max', 'max 100000'],
        ['/fake/cgroup/memory.max', 'max'],
        ['/fake/cgroup/cpuset.cpus.effective', '0-3'],
    ]);
    const limits = effectiveResourceLimits({ cgroupRoot: '/fake/cgroup', hostLogicalCpus: 4,
        hostMemoryBytes: 16 * 1024 ** 3,
        readText: filePath => {
            if (!files.has(filePath)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
            return files.get(filePath);
        } });
    assert.equal(limits.source, 'cgroup-v2');
    assert.equal(limits.effectiveLogicalCpus, 2);
    assert.equal(limits.effectiveMemoryBytes, 4 * 1024 ** 3);
    assert.equal(parseCpuMax('150000 100000'), 1.5);
    assert.equal(parseCpuMax('max 100000'), Infinity);
    assert.equal(parseCpuMax('invalid'), null);
    assert.equal(parseCpuSet('0-1,4'), 3);
    assert.equal(parseCpuSet('0-2,2'), 3);
    assert.equal(parseCpuSet('2-1'), null);
    assert.equal(parseMemoryMax('max'), Infinity);
    assert.equal(parseMemoryMax('4294967296'), 4 * 1024 ** 3);
    assert.equal(parseMemoryMax('0'), null);
    const hostOnly = effectiveResourceLimits({ cgroupText: '2:cpu:/legacy', cgroupRoot: '/fake/cgroup',
        hostLogicalCpus: 4, hostMemoryBytes: 16 * 1024 ** 3, readText: () => { throw new Error('not used'); } });
    assert.equal(hostOnly.source, 'host');
    assert.equal(hostOnly.effectiveLogicalCpus, 4);
    assert.equal(hostOnly.effectiveMemoryBytes, 16 * 1024 ** 3);
});

test('reduced fixture imports through the archive and alias redelivery creates no extra messages/events', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-load-import-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataset = await generateDataset(path.join(root, 'dataset'), {
        contacts: 2, messagesPerConversation: 3, duplicateDeliveries: 4, retainedReplayEvents: 2,
    });
    const archive = createArchive({ path: path.join(root, 'archive.db') });
    t.after(() => archive.close());
    await archive.ready;
    const imported = await importDataset(archive, dataset);
    assert.equal(imported.imported, 6);
    assert.equal(imported.duplicateCount, 4);
    const diagnostics = await archive.diagnostics();
    assert.equal(diagnostics.messages, 6);
    assert.equal(diagnostics.events, 6);
    assert.equal(diagnostics.aliases, 2);
    assert.equal(diagnostics.quarantine, 0);
    assert.equal((await archive.snapshot()).seq, '6');
});
