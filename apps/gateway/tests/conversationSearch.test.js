process.env.SDK_BOT_TEST = '1';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { assertValid } = require('@sdk-bot/contracts');
const { createArchive } = require('../services/conversations');
const { startInternalBus } = require('../services/internalBus');
const { signContext, actorId } = require('../lib/panelContext');
const { withTempDbPaths } = require('./helpers/tmpPaths');

const temporary = withTempDbPaths();
after(() => temporary.restore());

function input(accountId, providerMessageId, textOrContent, occurredAt, remoteId = '15550001111@s.whatsapp.net') {
    return { identity: { accountId, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: remoteId },
        providerMessageId, source: 'live', direction: 'inbound', authorKind: 'customer', occurredAt,
        content: typeof textOrContent === 'string' ? { type: 'text', text: textOrContent } : textOrContent };
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-search-'));
    const dbPath = path.join(directory, 'archive.db');
    const archive = createArchive({ path: dbPath });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'whatsapp', providerKey: `search-${randomUUID()}` });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
    return { archive, account, dbPath, directory };
}

test('FTS indexes text, captions, and transcripts, scopes by conversation, and follows message mutations', async t => {
    const { archive, account } = await fixture(t);
    const at = '2026-10-22T10:00:00.000Z';
    const [plain, caption, audio, edited, , oversized] = await archive.ingestBatch([
        input(account.id, 'search-plain', 'El niño pidió CAFÉ en la plaza', at),
        input(account.id, 'search-caption', { type: 'image', availability: 'not_stored', transcript: null,
            transcriptionStatus: 'not_requested', caption: 'pórtico azul junto al jardín' }, '2026-10-22T10:01:00.000Z'),
        input(account.id, 'search-audio', { type: 'audio', availability: 'not_stored', transcript: null,
            transcriptionStatus: 'pending' }, '2026-10-22T10:02:00.000Z'),
        input(account.id, 'search-edit', 'ancla antigua', '2026-10-22T10:03:00.000Z'),
        input(account.id, 'search-delete', 'secreto eliminado', '2026-10-22T10:04:00.000Z'),
        input(account.id, 'search-oversized', { type: 'oversized', originalBytes: 70000, reason: 'text_limit' }, '2026-10-22T10:05:00.000Z')
    ]);
    const conversationId = plain.message.conversationId;
    assert.equal(caption.message.conversationId, conversationId);
    await archive.updateTranscription({ messageId: audio.message.id, expectedStatus: 'pending', status: 'completed',
        transcript: 'número de pedido 452' });

    const diacriticSearch = await archive.searchMessages({ conversationId, query: 'nino cafe', limit: 10 });
    assert.deepEqual(diacriticSearch.items.map(item => item.message.id), [plain.message.id]);
    assert.equal(typeof diacriticSearch.items[0].snippet, 'string');
    assert.equal(diacriticSearch.items[0].snippet.includes('<mark>'), false);
    assert.equal((await archive.searchMessages({ conversationId, query: 'portico jardin' })).items[0].message.id,
        caption.message.id);
    assert.equal((await archive.searchMessages({ conversationId, query: 'pedido 452' })).items[0].message.id,
        audio.message.id);

    const editedResult = await archive.editProviderMessage({
        identity: { accountId: account.id, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '15550001111@s.whatsapp.net' },
        providerMessageId: 'search-edit', content: { type: 'text', text: 'ancla renovada' }, editedAt: '2026-10-22T11:00:00.000Z'
    });
    assert.equal(editedResult.status, 'updated');
    assert.equal((await archive.searchMessages({ conversationId, query: 'antigua' })).items.length, 0);
    assert.equal((await archive.searchMessages({ conversationId, query: 'renovada' })).items[0].message.id,
        edited.message.id);

    const deletion = await archive.deleteProviderMessage({
        identity: { accountId: account.id, channel: 'whatsapp', kind: 'whatsapp_jid', exactValue: '15550001111@s.whatsapp.net' },
        providerMessageId: 'search-delete', deletedAt: '2026-10-22T11:01:00.000Z'
    });
    assert.equal(deletion.status, 'deleted');
    assert.equal((await archive.searchMessages({ conversationId, query: 'secreto eliminado' })).items.length, 0);
    assert.equal((await archive.searchMessages({ conversationId, query: '70000' })).items.length, 0);

    const [otherConversation] = await archive.ingestBatch([input(account.id, 'search-other', 'CAFÉ reservado', at,
        '15550002222@s.whatsapp.net')]);
    assert.notEqual(otherConversation.message.conversationId, conversationId);
    const scoped = await archive.searchMessages({ conversationId, query: 'reservado' });
    assert.deepEqual(scoped.items, []);

    const syntaxSafe = await archive.searchMessages({ conversationId, query: 'plaza OR reservado' });
    assert.deepEqual(syntaxSafe.items, []);
    assert.equal(oversized.message.content.type, 'oversized');
});

test('search pages are deterministic and expire when the archive sequence changes', async t => {
    const { archive, account } = await fixture(t);
    const conversationId = (await archive.ingestBatch([input(account.id, 'page-a', 'paginacion clave uno', '2026-10-22T10:00:00.000Z')]))[0].message.conversationId;
    await archive.ingestBatch([
        input(account.id, 'page-b', 'paginacion clave dos', '2026-10-22T10:01:00.000Z'),
        input(account.id, 'page-c', 'paginacion clave tres', '2026-10-22T10:02:00.000Z')
    ]);
    const first = await archive.searchMessages({ conversationId, query: 'paginacion clave', limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextPosition);
    const second = await archive.searchMessages({ conversationId, query: 'paginacion clave', limit: 2,
        after: first.nextPosition, expectedSnapshot: first.snapshot });
    const all = [...first.items, ...second.items].map(item => item.message.id);
    assert.equal(new Set(all).size, 3);
    assert.equal(second.hasMore, false);

    await archive.ingestBatch([input(account.id, 'page-d', 'paginacion clave cuatro', '2026-10-22T10:03:00.000Z')]);
    await assert.rejects(archive.searchMessages({ conversationId, query: 'paginacion clave', limit: 2,
        after: first.nextPosition, expectedSnapshot: first.snapshot }), { code: 'CURSOR_EXPIRED' });
    await assert.rejects(archive.searchMessages({ conversationId, query: 'paginacion clave',
        expectedSnapshot: { ...first.snapshot, dataEpoch: randomUUID() } }), { code: 'DATA_EPOCH_MISMATCH' });
});

test('v12 migration backfills the FTS index before serving searches', async t => {
    const { archive, account, dbPath } = await fixture(t);
    const [stored] = await archive.ingestBatch([input(account.id, 'migration-index', 'backfill palabra existente', '2026-10-22T10:00:00.000Z')]);
    const conversationId = stored.message.conversationId;
    await archive.close();
    const database = new DatabaseSync(dbPath);
    database.exec('DROP TRIGGER messages_search_insert; DROP TRIGGER messages_search_update; DROP TRIGGER messages_search_delete; DROP TABLE message_search; DROP TABLE assistant_tool_invocations; PRAGMA user_version=12;');
    database.close();

    const migrated = createArchive({ path: dbPath });
    t.after(() => migrated.close());
    assert.equal((await migrated.ready).schemaVersion, 14);
    const result = await migrated.searchMessages({ conversationId, query: 'backfill existente' });
    assert.deepEqual(result.items.map(item => item.message.id), [stored.message.id]);
});

test('authenticated search binds cursors to actor, conversation, query, and archive snapshot', async t => {
    const { archive, account } = await fixture(t);
    const first = (await archive.ingestBatch([input(account.id, 'api-a', 'operador busca café uno', '2026-10-22T10:00:00.000Z')]))[0];
    await archive.ingestBatch([input(account.id, 'api-b', 'operador busca café dos', '2026-10-22T10:01:00.000Z')]);
    const otherConversation = (await archive.ingestBatch([input(account.id, 'api-other', 'operador busca café privado',
        '2026-10-22T10:02:00.000Z', '15550002222@s.whatsapp.net')]))[0].message.conversationId;
    const previousSecret = process.env.SDK_PANEL_GATEWAY_SECRET;
    const secret = 'conversation-search-api-test-secret-with-32-bytes';
    process.env.SDK_PANEL_GATEWAY_SECRET = secret;
    const bus = startInternalBus({ port: 0, archive, getChannelStatus: () => ({ status: 'open' }) });
    await once(bus, 'listening');
    const base = `http://127.0.0.1:${bus.address().port}`;
    const actor = { id: actorId('operator:search-owner'), displayName: 'Operador', capabilities: ['conversations:read'] };
    const otherActor = { id: actorId('operator:search-other'), displayName: 'Otra persona', capabilities: ['conversations:read'] };
    const deniedActor = { id: actorId('operator:search-denied'), displayName: 'Sin permisos', capabilities: [] };
    async function request(pathname, signedActor = actor) {
        const headers = signContext({ secret, actor: signedActor, requestId: randomUUID(), method: 'GET',
            target: pathname, body: Buffer.alloc(0) });
        return fetch(base + pathname, { headers });
    }
    t.after(async () => {
        bus.closeAllConnections(); await new Promise(resolve => bus.close(resolve));
        if (previousSecret === undefined) delete process.env.SDK_PANEL_GATEWAY_SECRET;
        else process.env.SDK_PANEL_GATEWAY_SECRET = previousSecret;
    });

    const path = `/v1/conversations/${first.message.conversationId}/search?query=cafe&limit=1`;
    const response = await request(path);
    assert.equal(response.status, 200, await response.clone().text());
    const page = assertValid('MessageSearchResponse', await response.json());
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    assert.equal((await request(path, deniedActor)).status, 403);
    assert.equal((await request(`/v1/conversations/${randomUUID()}/search?query=cafe`)).status, 404);
    assert.equal((await request(`/v1/conversations/${first.message.conversationId}/search?query=cafe%20OR%20otro`)).status, 200);
    assert.equal((await request(`/v1/conversations/${first.message.conversationId}/search?query=%2A%2A%2A`)).status, 422);
    assert.equal((await request(`/v1/conversations/${first.message.conversationId}/search?query=cafe&cursor=${page.nextCursor}`,
        otherActor)).status, 422);
    assert.equal((await request(`/v1/conversations/${otherConversation}/search?query=cafe&limit=1&cursor=${page.nextCursor}`)).status, 422);
    assert.equal((await request(`/v1/conversations/${first.message.conversationId}/search?query=otro&limit=1&cursor=${page.nextCursor}`)).status, 422);

    await archive.ingestBatch([input(account.id, 'api-c', 'operador busca café tres', '2026-10-22T10:02:00.000Z')]);
    const expired = await request(`/v1/conversations/${first.message.conversationId}/search?query=cafe&limit=1&cursor=${page.nextCursor}`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, 'CURSOR_EXPIRED');
});
