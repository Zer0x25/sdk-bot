process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const audio = { type: 'audio', availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' };
async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-enrich-'));
    const file = path.join(dir, 'archive.db');
    const archive = createArchive({ path: file });
    t.after(async () => { await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: 'fixture' });
    const identity = { accountId: account.id, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '200@s.whatsapp.net' };
    const base = { identity, providerMessageId: 'voice', direction: 'inbound', authorKind: 'customer', source: 'live', occurredAt: '2026-10-19T00:00:00Z', content: audio };
    const [created] = await archive.ingestBatch([base]);
    const messageId = created.message.id, conversationId = created.message.conversationId;
    return { archive, file, base, created, messageId, conversationId };
}

test('enrichment is atomic, CAS guarded, minimal and durable; redelivery via alias keeps original fingerprint', async t => {
    const f = await fixture(t); const { archive, messageId, conversationId } = f;
    const projection = await archive.conversation(conversationId);
    const pending = await archive.updateTranscription({ messageId, expectedStatus: 'not_requested', status: 'pending' });
    assert.equal(pending.event.type, 'message.updated');
    assert.equal(pending.event.cursor.seq, '2');
    const result = await archive.updateTranscription({ messageId, expectedStatus: 'pending', status: 'completed', transcript: 'Texto privado 😀' });
    assert.equal(result.message.id, messageId);
    assert.equal(result.event.data.aggregateVersion, '4');
    assert.equal(result.event.cursor.seq, '3');
    assert.ok(!JSON.stringify(await archive.events()).includes('Texto privado'));
    const after = await archive.conversation(conversationId);
    for (const field of ['inbound_seq','last_activity_at','capturing_since','history_observed']) assert.equal(after[field], projection[field]);
    assert.equal(result.message.ingestedAt, f.created.message.ingestedAt);
    for (const status of ['completed','failed']) assert.equal((await archive.updateTranscription({ messageId, expectedStatus: 'pending', status, transcript: status === 'completed' ? 'otro' : null })).status, 'unchanged');
    const lid = { ...f.base.identity, kind: 'whatsapp_lid', exactValue: '777@lid' };
    await archive.bindAlias({ canonical: f.base.identity, alias: lid, evidence: { kind: 'adapter', reference: 'fixture' } });
    assert.equal((await archive.ingestBatch([{ ...f.base, identity: lid, source: 'history' }]))[0].messageId, messageId);
    assert.equal((await archive.snapshot()).seq, '3');
    await archive.close();
    const reopened = createArchive({ path: f.file }); t.after(() => reopened.close());
    const [stored] = await reopened.messages({ conversationId });
    assert.equal(stored.content.transcript, 'Texto privado 😀');
    assert.equal((await reopened.snapshot()).seq, '3');
    await reopened.close();
});

test('invalid enrichment rolls back payload, projection and event, then failure retains audio marker', async t => {
    const { archive, messageId, conversationId } = await fixture(t);
    await archive.updateTranscription({ messageId, expectedStatus: 'not_requested', status: 'pending' });
    const before = await archive.snapshot();
    for (const transcript of [null, '', '  ', '\ud800', '😀'.repeat(16385)]) await assert.rejects(archive.updateTranscription({ messageId, expectedStatus: 'pending', status: 'completed', transcript }));
    await assert.rejects(archive.updateTranscription({ messageId, expectedStatus: 'not_requested', status: 'completed', transcript: 'bad transition' }));
    assert.deepEqual(await archive.snapshot(), before);
    assert.equal((await archive.messages({ conversationId }))[0].content.transcriptionStatus, 'pending');
    const failed = await archive.updateTranscription({ messageId, expectedStatus: 'pending', status: 'failed' });
    assert.deepEqual(failed.message.content, { ...audio, transcriptionStatus: 'failed' });
    await assert.rejects(archive.updateTranscription({ messageId, expectedStatus: 'pending', status: 'failed', transcript: 'not a failure' }));
});

test('restart resolves orphan pending to failed once, without resuming STT or altering base dedup', async t => {
    const f = await fixture(t);
    await f.archive.updateTranscription({ messageId: f.messageId, expectedStatus: 'not_requested', status: 'pending' });
    await f.archive.close();
    const recovered = createArchive({ path: f.file }); t.after(() => recovered.close());
    assert.equal((await recovered.snapshot()).seq, '3');
    assert.equal((await recovered.messages({ conversationId: f.conversationId }))[0].content.transcriptionStatus, 'failed');
    assert.equal((await recovered.ingestBatch([f.base]))[0].status, 'duplicate');
    await recovered.close();
    const twice = createArchive({ path: f.file }); t.after(() => twice.close());
    assert.equal((await twice.snapshot()).seq, '3'); await twice.close();
});

test('purge during transcription cannot recreate body, extend retention or emit completion', async t => {
    const f = await fixture(t);
    await f.archive.updateTranscription({ messageId: f.messageId, expectedStatus: 'not_requested', status: 'pending' });
    await f.archive.purge({ now: new Date(Date.parse(f.created.message.ingestedAt) + 90 * 86400000 + 1).toISOString() });
    const before = await f.archive.snapshot();
    assert.equal((await f.archive.updateTranscription({ messageId: f.messageId, expectedStatus: 'pending', status: 'completed', transcript: 'late' })).status, 'missing');
    assert.equal((await f.archive.updateTranscription({ messageId: randomUUID(), expectedStatus: 'not_requested', status: 'pending' })).status, 'missing');
    assert.equal((await f.archive.ingestBatch([f.base]))[0].status, 'duplicate');
    assert.equal((await f.archive.diagnostics()).messages, 0);
    assert.deepEqual(await f.archive.snapshot(), before);
});

test('caption retains media kind and literal text; oversized marker hashes original caption for dedup', async t => {
    const f = await fixture(t);
    for (const type of ['image','video','document']) {
        const base = { ...f.base, providerMessageId: type, content: { ...audio, type, caption: '<b>literal 😀</b>' } };
        const [created] = await f.archive.ingestBatch([base]);
        assert.deepEqual(created.message.content, base.content);
        assert.equal((await f.archive.ingestBatch([{ ...base, source: 'history' }]))[0].status, 'duplicate');
    }
    // Old capture erased the attachment kind. Do not guess it on redelivery:
    // retain the old observation and quarantine the incompatible new shape.
    const legacy = { ...f.base, providerMessageId: 'legacy-caption', content: { type: 'text', text: 'old caption' } };
    const [old] = await f.archive.ingestBatch([legacy]);
    assert.equal((await f.archive.ingestBatch([{ ...legacy, content: { ...audio, type: 'image', caption: 'old caption' } }]))[0].status, 'quarantined');
    assert.deepEqual((await f.archive.messages({ conversationId: old.message.conversationId })).find(m => m.id === old.message.id).content, legacy.content);
    const base = { ...f.base, providerMessageId: 'large', content: { ...audio, type: 'image', caption: 'a'.repeat(65537) } };
    const [large] = await f.archive.ingestBatch([base]);
    assert.deepEqual(large.message.content, { type: 'oversized', originalBytes: 65537, reason: 'text_limit' });
    assert.equal((await f.archive.ingestBatch([base]))[0].status, 'duplicate');
    assert.equal((await f.archive.ingestBatch([{ ...base, content: { ...base.content, caption: 'b'.repeat(65537) } }]))[0].status, 'quarantined');
});
