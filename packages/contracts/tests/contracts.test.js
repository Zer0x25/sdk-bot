'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { validate, assertValid } = require('..');
const schema = require('../schema.json');
const api = require('../openapi.json');
const legacyExpectations = require('../../../docs/fixtures/v1-acceptance.json');
const id = (last) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const now = '2026-10-19T12:00:00Z';
const cursor = { dataEpoch: id(1), seq: '9007199254740993' };
const key = { accountId: id(1), channel: 'telegram', kind: 'telegram_chat_id', exactValue: '-9007199254740993' };
const identity = { id: id(2), contactId: id(3), canonicalIdentityId: id(2), key, verification: 'adapter', resolution: 'resolved' };
const actor = { id: id(4), displayName: 'Operador sintético', capabilities: ['conversations:read','control:write'] };
const conversation = {
  id: id(5), accountId: id(1), contactId: id(3), displayName: 'Contacto de prueba', canonicalIdentityId: id(2),
  control: { accessPolicy: 'neutral', automationMode: 'human', lifecycle: 'open',
    ownerId: null, controlVersion: '3', contextVersion: '1', status: 'confirmed', takenAt: null, handoffReason: 'legacy_import',
    profileKey: null, requiresReview: false, reviewReasons: [] },
  aggregateVersion: '9007199254740993', lastActivityAt: now,
  historyCoverage: { kind: 'partial_import', capturingSince: now }, unreadCount: 2, requiresReview: false,
};
const message = {
  id: id(6), conversationId: id(5), providerMessageId: '10', clientMessageId: null,
  inboundSeq: '9007199254740993', direction: 'inbound', authorKind: 'customer', actorId: null,
  content: { type: 'text', text: 'Hola 👋' }, occurredAt: now, ingestedAt: now,
  deliveryStatus: 'received', replyToId: null, source: 'live', deduplicationQuality: 'provider_id',
};
const operation = { id: id(7), conversationId: id(5), actorId: id(4), type: 'takeover', status: 'taking_control', controlVersion: '3', uncertainMessageIds: [id(8)], createdAt: now, completedAt: null };
const policy = { globalMode: 'ignored_all', globalPaused: true, policyVersion: '2' };
function accept(name, value) {
  const result = validate(name, value);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.value, value);
}
function reject(name, value) {
  const result = validate(name, value);
  assert.equal(result.valid, false, `${name} unexpectedly accepted ${JSON.stringify(value)}`);
  assert.ok(result.errors.length);
}

test('OpenAPI 3.1 references resolve locally and every component uses the canonical schema', async () => {
  const parsed = await SwaggerParser.validate(resolve(__dirname, '../openapi.json'));
  assert.equal(parsed.openapi, '3.1.0');
  assert.deepEqual(Object.keys(api.components.schemas).sort(), Object.keys(schema.$defs).sort());
  for (const name of Object.keys(schema.$defs)) {
    assert.equal(api.components.schemas[name].$ref, `./schema.json#/$defs/${name}`);
  }
  for (const [path, item] of Object.entries(api.paths)) {
    for (const method of ['get', 'post', 'patch']) {
      const op = item[method];
      if (!op) continue;
      for (const param of op.parameters || []) {
        if (param.in !== 'query') continue;
        const query = path === '/conversations' ? 'ConversationsQuery' : path === '/summary' ? 'SummaryQuery'
          : path === '/conversations/{conversationId}/search' ? 'MessageSearchQuery' : 'MessagesQuery';
        assert.equal(param.schema.$ref, `./schema.json#/$defs/${query}/properties/${param.name}`);
      }
    }
  }
});

test('Telegram exact IDs preserve sign, arbitrary precision and reject coercion', () => {
  for (const value of ['-1001234567890','1001234567890','9007199254740993','-9007199254740993','1']) {
    accept('TelegramChatId', value);
    accept('IdentityKey', { ...key, exactValue: value });
    assert.equal(assertValid('TelegramChatId', value), value);
  }
  for (const value of [0, 1, -123, '0', '-0', '01', '-01', '+1', '1.0', ' 1', '1 ', '1e3', '', null, '١']) reject('TelegramChatId', value);
  reject('IdentityKey', { ...key, channel: 'whatsapp' });
  reject('IdentityKey', { ...key, exactValue: 123 });
});

test('WhatsApp keys keep explicit kinds and normalized exact values', () => {
  for (const [kind, exactValue] of [['whatsapp_jid','56900000001@s.whatsapp.net'], ['whatsapp_lid','123456@lid'], ['phone','+56900000001']]) {
    accept('IdentityKey', { accountId: id(1), channel: 'whatsapp', kind, exactValue });
  }
  for (const exactValue of ['56900000001','123@lid','123:4@s.whatsapp.net','123@g.us','abc@s.whatsapp.net']) reject('IdentityKey', { accountId: id(1), channel: 'whatsapp', kind: 'whatsapp_jid', exactValue });
  reject('IdentityKey', { ...key, kind: 'phone' });
});

test('F0 identity examples fit wire forms without claiming alias resolution', () => {
  for (const scenario of legacyExpectations.identityCases) {
    for (const side of [scenario.left, scenario.right]) {
      const telegram = side.kind === 'telegram_chat';
      accept('IdentityKey', {
        accountId: side.accountId,
        channel: telegram ? 'telegram' : 'whatsapp',
        kind: telegram ? 'telegram_chat_id' : side.kind,
        exactValue: side.value,
      });
    }
  }
});

test('internal UUIDs, sequence strings and versions remain distinct wire forms', () => {
  accept('Id', id(1));
  for (const value of ['00000000-0000-0000-0000-000000000000', '00000000-0000-4000-0000-000000000001', '123', 123, 'not-a-uuid']) reject('Id', value);
  for (const value of ['0','1','9007199254740993']) accept('Sequence', value);
  reject('Version', '0');
  accept('Version', '9007199254740993');
  for (const value of [1, '01','-1','1.0','1e3']) { reject('Version', value); reject('Sequence', value); }
  accept('EventId', `${id(1)}:9007199254740993`);
  reject('EventId', `${id(1)}:01`);
  accept('Timestamp', now);
  reject('Timestamp', '2026-02-30T12:00:00Z');
  reject('Timestamp', '2026-10-19T12:00:00+00:00');
});

test('outgoing Unicode limits count code points, enforce UTF8, reject blank and malformed scalars', () => {
  assert.equal(schema.$defs.OutgoingText.maxLength, legacyExpectations.defaults.outgoingCodePoints);
  assert.equal(schema.$defs.OutgoingText['x-maxUtf8Bytes'], legacyExpectations.defaults.outgoingUtf8KiB * 1024);
  for (const value of ['a', '😀'.repeat(4096), 'a'.repeat(4096), '/humano literal', '**literal**']) accept('OutgoingText', value);
  for (const value of ['', ' \n\t\u00a0', 'a'.repeat(4097), '😀'.repeat(4097), '\ud800', '\udc00']) reject('OutgoingText', value);
  assert.equal(Buffer.byteLength('😀'.repeat(4096)), 16384);
  accept('StoredText', '😀'.repeat(16384));
  reject('StoredText', '😀'.repeat(16385)); // <=65536 code points, >65536 UTF8 bytes
  accept('MessageContent', { type: 'oversized', originalBytes: 65537, reason: 'text_limit' });
});

test('TXT-01 through TXT-06 execute against the actual outgoing text validator', () => {
  for (const scenario of legacyExpectations.textCases) {
    const value = scenario.repeat.value.repeat(scenario.repeat.count);
    assert.equal(validate('OutgoingText', value).valid, scenario.expectedAccepted, scenario.id);
  }
});

test('shared runtime validation does not require the Node Buffer global', () => {
  const saved = global.Buffer;
  try {
    global.Buffer = undefined;
    accept('OutgoingText', '😀'.repeat(4096));
    reject('StoredText', '😀'.repeat(16385));
  } finally {
    global.Buffer = saved;
  }
});

test('pages enforce bounded limits and opaque cursors without mutating defaults', () => {
  const query = Object.freeze({});
  accept('MessagesQuery', query);
  assert.deepEqual(query, {});
  for (const limit of [1,50,100]) accept('MessagesQuery', { limit });
  for (const limit of [0,101,1.2,'50',null]) reject('MessagesQuery', { limit });
  for (const value of ['', 'a=b', 'a/b', 'a'.repeat(2049)]) reject('PageCursor', value);
  accept('ConversationsQuery', { accountId: id(1), channel: 'telegram', unreadOnly: true, search: 'María', cursor: 'opaque_cursor-1' });
  reject('ConversationsQuery', { unreadOnly: 'true' });
  reject('MessagesQuery', { offset: 1 });
  reject('MessagesResponse', { items: Array(101).fill(message), nextCursor: null, snapshot: cursor });
});

test('summary contracts require explicit UTC bounds and expose only bounded aggregate metrics', () => {
  accept('SummaryQuery', { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' });
  reject('SummaryQuery', { from: '2026-10-01T00:00:00Z' });
  reject('SummaryQuery', { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', channel: 'whatsapp' });
  const metrics = { inboundMessages: 4, activeConversations: 2, acceptedAiReplies: 1, acceptedHumanReplies: 1 };
  accept('SummaryResponse', {
    period: { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', interval: '[from,to)' },
    coverageStartAt: now, metrics,
    byChannel: [{ channel: 'whatsapp', ...metrics }], snapshot: cursor
  });
  reject('SummaryResponse', { period: { from: now, to: now, interval: '[from,to)' }, coverageStartAt: null,
    metrics, byChannel: [{ channel: 'whatsapp', ...metrics, phone: '+56900000000' }], snapshot: cursor });
});

test('operator assistance binds each summary point and unsent draft to thread message IDs', () => {
  const sourceId = id(55);
  const reference = { messageId: sourceId, occurredAt: now, authorKind: 'customer' };
  accept('ConversationAssistanceRequest', { expectedContextVersion: '3', expectedSnapshot: cursor });
  reject('ConversationAssistanceRequest', { expectedContextVersion: '3', expectedSnapshot: cursor, message: 'forged context' });
  const response = {
    conversationId: id(1), contextVersion: '3', throughMessageId: sourceId, snapshot: cursor,
    summaryPoints: [{ text: 'Pregunta por disponibilidad.', references: [reference] }],
    draft: 'Sí, tenemos disponibilidad. ¿Para qué fecha la necesitas?', draftReferences: [reference]
  };
  accept('ConversationAssistanceResponse', response);
  reject('ConversationAssistanceResponse', { ...response,
    summaryPoints: [{ ...response.summaryPoints[0], references: [] }] });
  reject('ConversationAssistanceResponse', { ...response, draftReferences: [{ ...reference, messageId: 'not-a-message-id' }] });
});

test('automation profile inventory exposes names only and conversation profile updates support global inheritance', () => {
  accept('AutomationProfile', { key: 'default', name: 'Predeterminado' });
  reject('AutomationProfile', { key: 'default', name: 'Predeterminado', description: 'prompt privado' });
  accept('AutomationProfilesResponse', { items: [{ key: 'default', name: 'Predeterminado' }] });
  reject('AutomationProfilesResponse', { items: [{ key: 'default', name: 'Predeterminado', content: 'privado' }] });
  accept('UpdateConversationRequest', { expectedVersion: '3', profileKey: 'default' });
  accept('UpdateConversationRequest', { expectedVersion: '3', profileKey: null });
  reject('UpdateConversationRequest', { expectedVersion: '3', profileKey: 'invalid key' });
});

test('entities and snapshots roundtrip JSON with explicit nullable fields', () => {
  const cases = [
    ['Actor', actor], ['Identity', identity], ['Contact', { id: id(3), displayName: null, identities: [identity] }],
    ['Account', { id: id(1), channel: 'telegram', displayName: 'Cuenta de prueba', status: 'connected', capabilities: { historySync: false, attachments: false, reply: true, edit: false, deliveryReceipt: false, readReceipt: false } }],
    ['Conversation', conversation], ['Message', message], ['Operation', operation],
    ['SessionResponse', { actor, policy, snapshot: cursor }],
    ['ConversationsResponse', { items: [conversation], nextCursor: null, snapshot: cursor }],
    ['ConversationResponse', { conversation, channelCapabilities: { historySync: false, attachments: false, reply: true, edit: false, deliveryReceipt: false, readReceipt: false }, snapshot: cursor }],
    ['MessagesResponse', { items: [message], nextCursor: null, snapshot: cursor }],
  ];
  for (const [name, value] of cases) accept(name, JSON.parse(JSON.stringify(value)));
  const noProviderId = { ...message, providerMessageId: null, deduplicationQuality: 'unknown' };
  accept('Message', noProviderId);
  const absent = { ...message };
  delete absent.providerMessageId;
  reject('Message', absent);
  reject('Conversation', { ...conversation, aggregateVersion: 1 });
  reject('Message', { ...message, raw: { secret: 'DO_NOT_ECHO' } });
  reject('Identity', { ...identity, key: { ...key, token: 'DO_NOT_ECHO' } });
});

test('control request forms preserve optional defaults and exclude actor spoofing', () => {
  const input = Object.freeze({ expectedVersion: '3' });
  accept('TakeoverRequest', input);
  accept('ReleaseRequest', input);
  assert.deepEqual(input, { expectedVersion: '3' });
  accept('TakeoverRequest', { ...input, overrideOwner: true });
  const pendingResume = { ...input, resumePolicy: 'process_pending', pendingInboundIds: [id(6)], selectionVersion: 'a'.repeat(64) };
  accept('ReleaseRequest', pendingResume);
  reject('ReleaseRequest', { ...input, resumePolicy: 'process_pending' });
  reject('ReleaseRequest', { ...input, resumePolicy: 'process_pending', pendingInboundIds: [id(6)] });
  reject('ReleaseRequest', { ...pendingResume, pendingInboundIds: [] });
  reject('ReleaseRequest', { ...pendingResume, pendingInboundIds: [id(6),id(6)] });
  reject('ReleaseRequest', { ...input, resumePolicy: 'future_only', pendingInboundIds: [id(6)] });
  const send = { ...input, clientMessageId: id(6), text: 'Respuesta', handledThroughInboundSeq: '9007199254740993' };
  accept('SendMessageRequest', send);
  reject('SendMessageRequest', { ...send, actorId: id(4) });
  reject('SendMessageRequest', { ...send, overrideOwner: true });
  reject('TakeoverRequest', { expectedVersion: 3 });
  accept('TakeoverPendingResponse', { operation });
  accept('TakeoverConfirmedResponse', { conversation });
  accept('UpdateConversationRequest', { ...input, lifecycle: 'resolved' });
  accept('UpdateConversationRequest', { ...input, accessPolicy: 'allowed' });
  accept('ReadRequest', { throughInboundSeq: '0' });
  reject('UpdateConversationRequest', input);
  accept('IdempotencyKey', 'synthetic-intent-01');
  reject('IdempotencyKey', 'too_short');
});

test('dedup wire key requires canonical identity and excludes raw chat ID', () => {
  const value = { accountId: id(1), canonicalIdentityId: id(2), providerMessageId: '10' };
  accept('DeduplicationKey', value);
  reject('DeduplicationKey', { ...value, rawChatId: '123@lid' });
  reject('DeduplicationKey', { ...value, providerMessageId: null });
  const oldKey = { accountId: id(1), rawChatId: '123@lid', providerMessageId: '10' };
  reject('DeduplicationKey', oldKey);
});

test('SSE envelopes are versioned minimal invalidations with epoch and text sequence', () => {
  const base = { schemaVersion: 1, cursor, occurredAt: now };
  for (const [type, data] of [
    ['conversation.updated',{ conversationId: id(5), aggregateVersion: '5' }],
    ['message.created',{ conversationId: id(5), messageId: id(6), aggregateVersion: '5' }],
    ['message.updated',{ conversationId: id(5), messageId: id(6), aggregateVersion: '6' }],
    ['operation.updated',{ conversationId: id(5), operationId: id(7), aggregateVersion: '7' }],
    ['control.changed',{ conversationId: id(5), aggregateVersion: '8', controlVersion: '4' }],
    ['channel.updated',{ accountId: id(1), status: 'disconnected' }],
    ['policy.updated',{ policyVersion: '3' }], ['resync.required',{ reason: 'epoch_changed' }],
  ]) {
    accept('Event', { ...base, type, data });
    reject('Event', { ...base, type, data: { ...data, text: 'DO_NOT_DUPLICATE_BODY' } });
  }
  reject('Event', { ...base, schemaVersion: 2, type: 'resync.required', data: { reason: 'epoch_changed' } });
  reject('EventCursor', { dataEpoch: id(1), seq: 9007199254740993 });
});

test('bounded errors omit raw values; validation is pure and unknown schemas fail closed', () => {
  const error = { error: { code: 'IDEMPOTENCY_RESULT_EXPIRED', message: 'Resultado purgado', requestId: id(1) } };
  accept('ErrorResponse', error);
  reject('ErrorResponse', { error: { ...error.error, stack: '/private/path' } });
  reject('ErrorResponse', { error: { ...error.error, details: { token: 'secret' } } });
  const input = Object.freeze({ expectedVersion: 'DO_NOT_ECHO_INPUT', actorId: 'DO_NOT_ECHO_INPUT' });
  const result = validate('TakeoverRequest', input);
  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO_INPUT'), false);
  assert.throws(() => assertValid('TakeoverRequest', input), { name: 'TypeError', message: 'Invalid contract: TakeoverRequest' });
  assert.throws(() => validate('__proto__', {}), /Unknown contract/);
  accept('TakeoverRequest', { expectedVersion: '3' });
  assert.ok(result.errors.length, 'next call must not invalidate prior errors');
});

test('media captions preserve attachment type and accept existing markers without caption', () => {
  for (const type of ['audio','image','video','document','unsupported']) {
    const content = { type, availability: 'not_stored', transcript: null, transcriptionStatus: 'not_requested' };
    accept('MessageContent', content);
    accept('MessageContent', { ...content, caption: 'Descripción 😀' });
    accept('MessageContent', { ...content, caption: '😀'.repeat(16384) });
    reject('MessageContent', { ...content, caption: '😀'.repeat(16385) });
    reject('MessageContent', { ...content, caption: '\ud800' });
    reject('MessageContent', { ...content, caption: null });
  }
  const stored = { type: 'audio', availability: 'available', transcript: null,
    transcriptionStatus: 'failed', attachmentId: id(8) };
  accept('MessageContent', stored);
  reject('MessageContent', { ...stored, attachmentId: undefined });
  reject('MessageContent', { ...stored, availability: 'not_stored' });
  reject('MessageContent', { ...stored, type: 'unsupported' });
  assert.equal(api.paths['/attachments/{attachmentId}'].get.responses['200'].content['application/octet-stream'].schema.format, 'binary');
});
