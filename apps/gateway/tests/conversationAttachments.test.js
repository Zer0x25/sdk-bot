process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createArchive } = require('../services/conversations');
const { createAttachmentStore } = require('../services/conversations/attachments');
const { actorId, signContext } = require('../lib/panelContext');
const { startInternalBus } = require('../services/internalBus');

const DAY = 86400000;
function identity(accountId, exactValue = '12345@s.whatsapp.net') {
    return { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue };
}
function mediaMessage(accountId, type = 'audio', exactValue = '12345@s.whatsapp.net') {
    return { identity: identity(accountId, exactValue), providerMessageId: randomUUID(), source: 'live', direction: 'inbound',
        authorKind: 'customer', occurredAt: '2026-10-22T00:00:00.000Z',
        content: { type, availability: 'not_stored', transcript: null, transcriptionStatus: type === 'audio' ? 'failed' : 'not_requested' } };
}
async function listen(server, started = false) {
    if (started && !server.listening) {
        await new Promise(resolve => server.once('listening', resolve));
    } else if (!started && !server.listening) {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    }
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function fixture(t, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-attachments-'));
    const archive = createArchive({ path: path.join(dir, 'archive.db') });
    await archive.ready;
    const accountId = randomUUID();
    await archive.registerAccount({ id: accountId, channel: 'whatsapp', providerKey: `attachments-${accountId}` });
    const store = createAttachmentStore({ archive, directory: path.join(dir, 'attachments'), ...options });
    await store.init();
    t.after(async () => { await store.close(); await archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return { dir, archive, store, accountId };
}

test('attachment metadata, private file permissions and authorized streamed download', async t => {
    const { dir, archive, store, accountId } = await fixture(t);
    assert.equal((await archive.ready).schemaVersion, 17);
    const [captured] = await archive.ingestBatch([mediaMessage(accountId)]);
    const bytes = Buffer.from('audio fixture payload');
    const saved = await store.store({ messageId: captured.message.id, source: bytes,
        fileName: '../../prueba áudio.ogg', contentType: 'audio/ogg' });
    assert.equal(saved.status, 'stored');
    assert.equal(saved.attachment.sha256.length, 64);
    const message = (await archive.messages({ conversationId: captured.message.conversationId }))[0];
    assert.equal(message.content.availability, 'available');
    assert.equal(message.content.attachmentId, saved.attachment.id);
    const rootStat = await fs.stat(path.join(dir, 'attachments'));
    const blobStat = await fs.stat(path.join(dir, 'attachments', `${saved.attachment.id}.blob`));
    assert.equal(rootStat.mode & 0o777, 0o700);
    assert.equal(blobStat.mode & 0o777, 0o600);

    const operator = { id: actorId('dev:attachment-reader'), displayName: 'Operador', capabilities: ['conversations:read'] };
    const previousSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    const previousHost = process.env.INTERNAL_BUS_HOST;
    process.env.SDK_PANEL_GATEWAY_SECRET = 'fixture-attachment-api-secret-32-bytes';
    process.env.INTERNAL_BUS_HOST = '127.0.0.1';
    const secret = process.env.SDK_PANEL_GATEWAY_SECRET;
    const server = startInternalBus({ archive, attachmentStore: store, port: 0 });
    t.after(() => {
        if (previousSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = previousSecret;
        if (previousHost === undefined) delete process.env.INTERNAL_BUS_HOST;
        else process.env.INTERNAL_BUS_HOST = previousHost;
    });
    t.after(() => close(server));
    const base = await listen(server, true);
    const downloadPath = `/v1/attachments/${saved.attachment.id}`;
    const download = await fetch(`${base}${downloadPath}`, { headers: signContext({ secret, actor: operator,
        requestId: randomUUID(), method: 'GET', target: downloadPath, body: Buffer.alloc(0) }) });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''prueba%20%C3%A1udio\.ogg/);
    const noRead = { id: actorId('dev:no-read'), displayName: 'Sin acceso', capabilities: [] };
    const forbidden = await fetch(`${base}${downloadPath}`, { headers: signContext({ secret, actor: noRead,
        requestId: randomUUID(), method: 'GET', target: downloadPath, body: Buffer.alloc(0) }) });
    assert.equal(forbidden.status, 403);
});

test('attachment file and aggregate quotas reject excess before metadata commit', async t => {
    const { archive, store, accountId, dir } = await fixture(t, { maxFileBytes: 4, maxTotalBytes: 6 });
    const [first] = await archive.ingestBatch([mediaMessage(accountId, 'image')]);
    const [second] = await archive.ingestBatch([mediaMessage(accountId, 'document', '998@s.whatsapp.net')]);
    const [third] = await archive.ingestBatch([mediaMessage(accountId, 'video', '997@s.whatsapp.net')]);
    await store.store({ messageId: first.message.id, source: Buffer.from('1234'), fileName: 'a.png', contentType: 'image/png' });
    await assert.rejects(store.store({ messageId: second.message.id, source: Buffer.from('123'), fileName: 'b.pdf', contentType: 'application/pdf' }),
        { code: 'ATTACHMENT_QUOTA_EXCEEDED' });
    await assert.rejects(store.store({ messageId: third.message.id, source: Buffer.from('12345'), fileName: 'c.mp4', contentType: 'video/mp4' }),
        { code: 'ATTACHMENT_TOO_LARGE' });
    assert.equal((await archive.attachmentRegistry()).length, 1);
    assert.equal((await fs.readdir(path.join(dir, 'attachments'))).filter(name => name.endsWith('.blob')).length, 1);
    assert.equal((await fs.readdir(path.join(dir, 'attachments'))).filter(name => name.endsWith('.tmp')).length, 0);
});

test('attachment retention is strict at 90 days and unlinks bytes after expiry', async t => {
    const { archive, store, accountId, dir } = await fixture(t);
    const [captured] = await archive.ingestBatch([mediaMessage(accountId)]);
    const saved = await store.store({ messageId: captured.message.id, source: Buffer.from('durable bytes'),
        fileName: 'retained.ogg', contentType: 'audio/ogg' });
    const expiresAt = new Date(Date.parse(captured.message.ingestedAt) + 90 * DAY).toISOString();
    await archive.purge({ now: expiresAt, limit: 500 });
    assert.ok(await archive.attachment({ id: saved.attachment.id }));
    assert.equal((await archive.messages({ conversationId: captured.message.conversationId })).length, 1);
    await archive.purge({ now: new Date(Date.parse(expiresAt) + 1).toISOString(), limit: 500 });
    await store.sweepExpired({ limit: 500 });
    assert.equal(await archive.attachment({ id: saved.attachment.id }), null);
    await assert.rejects(fs.stat(path.join(dir, 'attachments', `${saved.attachment.id}.blob`)), { code: 'ENOENT' });
});

test('missing attachment transitions the archived media marker to failed', async t => {
    const { archive, store, accountId, dir } = await fixture(t);
    const [captured] = await archive.ingestBatch([mediaMessage(accountId)]);
    const saved = await store.store({ messageId: captured.message.id, source: Buffer.from('lost later'),
        fileName: 'lost.ogg', contentType: 'audio/ogg' });
    await fs.unlink(path.join(dir, 'attachments', `${saved.attachment.id}.blob`));
    assert.equal(await store.open(saved.attachment.id), null);
    const [updated] = await archive.messages({ conversationId: captured.message.conversationId });
    assert.equal(updated.content.availability, 'failed');
    assert.equal(updated.content.attachmentId, undefined);
    assert.equal(await archive.attachment({ id: saved.attachment.id }), null);
});

test('expired audio preserves its transcript as a marker after the blob is deleted', async t => {
    const { archive, store, accountId, dir } = await fixture(t);
    const input = mediaMessage(accountId);
    input.content = { type: 'audio', availability: 'not_stored', transcript: 'Transcripción que permanece',
        transcriptionStatus: 'completed' };
    const [captured] = await archive.ingestBatch([input]);
    const saved = await store.store({ messageId: captured.message.id, source: Buffer.from('expires'),
        fileName: 'expired.ogg', contentType: 'audio/ogg' });
    const expiresAt = new Date(Date.parse(captured.message.ingestedAt) + 90 * DAY).toISOString();
    const expired = await archive.expireAttachment({ id: saved.attachment.id,
        now: new Date(Date.parse(expiresAt) + 1).toISOString() });
    assert.equal(expired.status, 'pending_delete');
    await store.sweepExpired();
    const [message] = await archive.messages({ conversationId: captured.message.conversationId });
    assert.equal(message.content.availability, 'expired');
    assert.equal(message.content.attachmentId, undefined);
    assert.equal(message.content.transcript, 'Transcripción que permanece');
    await assert.rejects(fs.stat(path.join(dir, 'attachments', `${saved.attachment.id}.blob`)), { code: 'ENOENT' });
});
