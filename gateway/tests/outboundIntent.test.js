process.env.SDK_BOT_TEST = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ChannelAdapter = require('../core/ChannelAdapter');
const { createArchive } = require('../services/conversations');
const { state } = require('../config');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-outbound-'));
    const dbPath = path.join(dir, 'archive.db');
    let archive = createArchive({ path: dbPath });
    await archive.ready;
    const account = await archive.registerAccount({ channel: 'telegram', providerKey: 'outbound-fixture' });
    t.after(async () => { await archive.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
    return { dbPath, account, get archive() { return archive; }, reopen: async () => {
        await archive.close(); archive = createArchive({ path: dbPath }); await archive.ready; return archive;
    } };
}

class FakeAdapter extends ChannelAdapter {
    constructor(archive, accountId, rawSend) {
        super('telegram'); this.archive = archive; this.accountId = accountId;
        this.rawSend = rawSend; this.calls = 0;
    }
    async sendMessageRaw(jid, text) {
        this.calls += 1;
        return this.rawSend ? this.rawSend(jid, text) : { ok: true, result: { message_id: 42 } };
    }
}

test('SendMessage persists intent first, replays accepted output locally, and rejects key reuse with another payload', async t => {
    const f = await fixture(t); let observedState;
    const adapter = new FakeAdapter(f.archive, f.account.id, async () => {
        observedState = (await f.archive.outboundIntent('notify:stable-1')).state;
        return { ok: true, result: { message_id: 42 } };
    });
    const options = { source: 'notice', idempotencyKey: 'notify:stable-1' };
    const first = await adapter.sendMessage('telegram:99', 'aviso', options);
    assert.equal(observedState, 'sending');
    assert.equal(first._outbox.state, 'accepted');
    assert.equal(first._outbox.replayed, false);

    const replay = await adapter.sendMessage('telegram:99', 'aviso', options);
    assert.equal(replay._outbox.state, 'accepted');
    assert.equal(replay._outbox.replayed, true);
    assert.equal(replay.result.message_id, 42);
    assert.equal(adapter.calls, 1);
    await assert.rejects(adapter.sendMessage('telegram:99', 'otro aviso', options), { code: 'OUTBOUND_IDEMPOTENCY_CONFLICT' });
    assert.equal(adapter.calls, 1);
});

test('concurrent duplicate sends claim one provider call and report the other as in progress', async t => {
    const f = await fixture(t); let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const adapter = new FakeAdapter(f.archive, f.account.id, async () => {
        await waiting;
        return { ok: true, result: { message_id: 55 } };
    });
    const options = { source: 'notice', idempotencyKey: 'notify:concurrent-1' };
    const first = adapter.sendMessage('telegram:88', 'duplicado', options);
    while (adapter.calls === 0) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(adapter.sendMessage('telegram:88', 'duplicado', options), { code: 'OUTBOUND_IN_PROGRESS' });
    release();
    assert.equal((await first)._outbox.state, 'accepted');
    assert.equal(adapter.calls, 1);
});

test('AI intent is rejected before provider I/O when a job became stale after claiming', async t => {
    const f = await fixture(t);
    const [observed] = await f.archive.ingestBatch([{ identity: { accountId: f.account.id, channel: 'telegram',
        kind: 'telegram_chat_id', exactValue: '77' }, providerMessageId: 'stale-control-input', source: 'live',
        direction: 'inbound', authorKind: 'customer', occurredAt: '2026-10-20T12:00:00.000Z',
        content: { type: 'text', text: 'entrada' } }]);
    const adapter = new FakeAdapter(f.archive, f.account.id);
    await assert.rejects(adapter.sendMessage('telegram:77', 'respuesta', {
        source: 'ai', generationId: 'gen-stale', bubbleIndex: 0,
        idempotencyKey: 'gen-stale:bubble:0',
        controlSnapshot: { conversationId: observed.message.conversationId,
            controlVersion: '1', contextVersion: '1', policyVersion: '1' },
        isCurrent: async () => false
    }), { code: 'OUTBOUND_CONTROL_STALE' });
    assert.equal(adapter.calls, 0);
    const intent = await f.archive.outboundIntent('gen-stale:bubble:0');
    assert.equal(intent.state, 'rejected');
    assert.equal(intent.errorCode, 'OUTBOUND_CONTROL_STALE');
    assert.equal(intent.policy.generationId, 'gen-stale');
});

test('global pause leaves the authorized human outbox path available', async t => {
    const f = await fixture(t);
    const adapter = new FakeAdapter(f.archive, f.account.id);
    const previous = state.IS_BOT_PAUSED;
    state.IS_BOT_PAUSED = true;
    try {
        const sent = await adapter.sendMessage('telegram:77', 'respuesta humana', {
            source: 'human', idempotencyKey: 'human-during-global-pause'
        });
        assert.equal(sent._outbox.state, 'accepted');
        assert.equal(adapter.calls, 1);
    } finally {
        state.IS_BOT_PAUSED = previous;
    }
});

test('provider timeout and process restart stay delivery_unknown until explicit reconciliation', async t => {
    const f = await fixture(t);
    const timedOut = new FakeAdapter(f.archive, f.account.id, async () => {
        throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    });
    await assert.rejects(timedOut.sendMessage('telegram:77', 'puede haberse enviado', {
        source: 'notice', idempotencyKey: 'notify:ambiguous-1'
    }), error => error.outboundState === 'delivery_unknown');
    assert.equal((await f.archive.outboundIntent('notify:ambiguous-1')).state, 'delivery_unknown');
    await assert.rejects(timedOut.sendMessage('telegram:77', 'puede haberse enviado', {
        source: 'notice', idempotencyKey: 'notify:ambiguous-1'
    }), { code: 'OUTBOUND_DELIVERY_UNKNOWN' });
    assert.equal(timedOut.calls, 1);

    const req = { idempotencyKey: 'notify:crash-1', accountId: f.account.id, channel: 'telegram', destination: '66',
        actorId: '00000000-0000-4000-8000-000000000002', source: 'notice', payload: { text: 'crash' } };
    await f.archive.beginOutboundIntent(req);
    assert.equal((await f.archive.claimOutboundIntent({ idempotencyKey: req.idempotencyKey })).status, 'claimed');
    await f.reopen();
    assert.equal((await f.archive.outboundIntent(req.idempotencyKey)).state, 'delivery_unknown');
    const reconciled = await f.archive.reconcileOutboundIntent({ idempotencyKey: req.idempotencyKey,
        actorId: randomUUID(), state: 'accepted', providerMessageId: '66', note: 'Verificado con el proveedor.' });
    assert.equal(reconciled.status, 'reconciled');
    assert.equal(reconciled.intent.state, 'accepted');
});

test('definite provider rejection is recorded and is not retried with the same key', async t => {
    const f = await fixture(t);
    const adapter = new FakeAdapter(f.archive, f.account.id, async () => {
        throw Object.assign(new Error('rejected'), { code: 'TG_SEND_REJECTED', outboundOutcome: 'rejected' });
    });
    const options = { source: 'notice', idempotencyKey: 'notify:rejected-1' };
    await assert.rejects(adapter.sendMessage('telegram:55', 'rechazado', options), { code: 'TG_SEND_REJECTED' });
    assert.equal((await f.archive.outboundIntent(options.idempotencyKey)).state, 'rejected');
    await assert.rejects(adapter.sendMessage('telegram:55', 'rechazado', options), { code: 'TG_SEND_REJECTED' });
    assert.equal(adapter.calls, 1);
});

test('v7 archives migrate to v9 without altering control authority', async t => {
    const f = await fixture(t);
    await f.archive.close();
    const db = new DatabaseSync(f.dbPath);
    db.exec(`DROP TABLE outbound_intents; DROP INDEX messages_ai_context; DROP TABLE message_sequence;
        ALTER TABLE messages DROP COLUMN archive_seq; ALTER TABLE conversations DROP COLUMN context_through_seq;
        PRAGMA user_version=7;`);
    db.close();
    const archive = await f.reopen();
    assert.equal((await archive.ready).schemaVersion, 9);
    assert.deepEqual(await archive.controlAuthority(), { mode: 'legacy', migrationId: null, serviceReady: false, changedAt: null });
    assert.deepEqual(await archive.outboundIntents(), []);
});

test('SQLite control gates customer AI sends while preserving the admin self-chat assistant', async t => {
    const f = await fixture(t);
    await f.archive.close();
    const db = new DatabaseSync(f.dbPath);
    db.exec("UPDATE control_authority SET mode='sqlite',service_ready=1 WHERE id=1;");
    db.close();
    const archive = await f.reopen();
    const adapter = new FakeAdapter(archive, f.account.id);
    adapter.adminChatId = '99';

    const reply = await adapter.sendMessage('telegram:99', 'asistente personal', {
        source: 'ai', idempotencyKey: 'ai:self-chat-1'
    });
    assert.equal(reply._outbox.state, 'accepted');
    assert.equal((await archive.outboundIntent('ai:self-chat-1')).policy.scope, 'admin_self_chat');
    await assert.rejects(adapter.sendMessage('telegram:77', 'respuesta cliente', {
        source: 'ai', idempotencyKey: 'ai:missing-snapshot-1'
    }), { code: 'OUTBOUND_CONTROL_REQUIRED' });
    assert.equal(adapter.calls, 1);
});
