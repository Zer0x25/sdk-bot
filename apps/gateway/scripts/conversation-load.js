'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { assertValid } = require('@sdk-bot/contracts');
const { createArchive } = require('../services/conversations');
const { REPO_ROOT } = require('../lib/repoPaths');

const FIXTURE_PATH = path.join(REPO_ROOT, 'docs/fixtures/v1-acceptance.json');
const SCHEMA_PATH = path.join(REPO_ROOT, 'packages/contracts/schema.json');
const MAX_QUEUE_ITEMS = 1000;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const FULL_VALIDATION_TIMEOUT_MS = 20 * 60_000;

function uuidBytes(value) {
    const hex = value.replaceAll('-', '');
    return Buffer.from(hex, 'hex');
}

function uuidV5(name, namespace) {
    const digest = crypto.createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function xorshift32(seed) {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x1_0000_0000;
    };
}

function makeProfile(overrides = {}) {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const profile = { ...fixture.loadProfile, ...overrides };
    profile.anchorTime = fixture.anchorTime;
    profile.uniqueMessages = profile.contacts * profile.messagesPerConversation;
    if (profile.duplicateDeliveries > profile.uniqueMessages) throw new Error('duplicateDeliveries exceeds uniqueMessages');
    if (profile.accounts.whatsapp + profile.accounts.telegram !== 5) throw new Error('load profile requires five accounts');
    return profile;
}

function parseCpuMax(value) {
    const match = typeof value === 'string' && /^\s*(max|[1-9][0-9]*)\s+([1-9][0-9]*)\s*$/.exec(value);
    if (!match) return null;
    if (match[1] === 'max') return Infinity;
    const quota = Number(match[1]), period = Number(match[2]);
    const cpus = quota / period;
    return Number.isFinite(cpus) && cpus > 0 ? cpus : null;
}

function parseMemoryMax(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (normalized === 'max') return Infinity;
    if (!/^[1-9][0-9]*$/.test(normalized)) return null;
    const bytes = Number(normalized);
    return Number.isSafeInteger(bytes) ? bytes : null;
}

function parseCpuSet(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const cpus = new Set();
    for (const range of value.trim().split(',')) {
        const match = /^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/.exec(range);
        if (!match) return null;
        const start = Number(match[1]), end = match[2] === undefined ? start : Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 4096) return null;
        for (let cpu = start; cpu <= end; cpu += 1) cpus.add(cpu);
    }
    return cpus.size || null;
}

function effectiveResourceLimits({ cgroupText, cgroupRoot = '/sys/fs/cgroup',
    readText = filePath => fs.readFileSync(filePath, 'utf8'),
    hostLogicalCpus = os.cpus().length, hostMemoryBytes = os.totalmem() } = {}) {
    let sourcePath;
    try { cgroupText ??= readText('/proc/self/cgroup'); }
    catch { cgroupText = ''; }
    const line = String(cgroupText).split('\n').find(entry => entry.startsWith('0::'));
    const root = path.resolve(cgroupRoot);
    if (line) {
        const relative = line.slice(3).replace(/^\/+/, '');
        const base = path.resolve(root, relative);
        if (base === root || base.startsWith(`${root}${path.sep}`)) sourcePath = base;
    }

    let cpuQuota = Infinity, cpusetLimit = Infinity, memoryLimit = Infinity, cgroupObserved = false;
    if (sourcePath) {
        for (let directory = sourcePath;; directory = path.dirname(directory)) {
            try {
                const parsed = parseCpuMax(readText(path.join(directory, 'cpu.max')));
                if (parsed !== null) { cpuQuota = Math.min(cpuQuota, parsed); cgroupObserved = true; }
            } catch { /* cgroup controller may not be mounted at this level */ }
            try {
                const parsed = parseMemoryMax(readText(path.join(directory, 'memory.max')));
                if (parsed !== null) { memoryLimit = Math.min(memoryLimit, parsed); cgroupObserved = true; }
            } catch { /* cgroup controller may not be mounted at this level */ }
            let cpuset = null;
            for (const filename of ['cpuset.cpus.effective', 'cpuset.cpus']) {
                try {
                    cpuset = parseCpuSet(readText(path.join(directory, filename)));
                    if (cpuset !== null) break;
                } catch { /* cpuset may be inherited from a parent */ }
            }
            if (cpuset !== null) { cpusetLimit = Math.min(cpusetLimit, cpuset); cgroupObserved = true; }
            if (directory === root) break;
            const parent = path.dirname(directory);
            if (parent === directory || !parent.startsWith(root)) break;
        }
    }
    return {
        hostLogicalCpus,
        hostMemoryBytes,
        effectiveLogicalCpus: Math.min(hostLogicalCpus, cpuQuota, cpusetLimit),
        effectiveMemoryBytes: Math.min(hostMemoryBytes, memoryLimit),
        source: cgroupObserved ? 'cgroup-v2' : 'host'
    };
}

function identityFor(contactIndex, profile, accountIds) {
    const accountIndex = contactIndex % 5;
    const whatsapp = accountIndex < profile.accounts.whatsapp;
    return {
        accountId: accountIds[accountIndex],
        channel: whatsapp ? 'whatsapp' : 'telegram',
        kind: whatsapp ? 'whatsapp_jid' : 'telegram_chat_id',
        exactValue: whatsapp
            ? `${10_000_000_000 + contactIndex}@s.whatsapp.net`
            : String(1_000_000_000 + contactIndex),
    };
}

function aliasFor(identity, contactIndex) {
    return { ...identity, kind: 'whatsapp_lid', exactValue: `${70_000_000_000 + contactIndex}@lid` };
}

function timestampFor(contactIndex, messageIndex, anchorMs) {
    return new Date(anchorMs - (contactIndex % 90) * 86_400_000 - Math.floor(messageIndex / 3) * 1000).toISOString();
}

function createEntityDtos(profile, accountIds, contactIndex) {
    const accountIndex = contactIndex % 5;
    const key = identityFor(contactIndex, profile, accountIds);
    const identityId = uuidV5(`identity:${contactIndex}`, profile.uuidNamespace);
    const contactId = uuidV5(`contact:${contactIndex}`, profile.uuidNamespace);
    const conversationId = uuidV5(`conversation:${contactIndex}`, profile.uuidNamespace);
    const identity = {
        id: identityId, contactId, canonicalIdentityId: identityId,
        key, verification: 'adapter', resolution: 'resolved',
    };
    const contact = { id: contactId, displayName: `Synthetic contact ${contactIndex}`, identities: [identity] };
    const capturingSince = profile.anchorTime;
    const lastActivityAt = timestampFor(contactIndex, 0, Date.parse(profile.anchorTime));
    const conversation = {
        id: conversationId,
        accountId: accountIds[accountIndex],
        contactId,
        canonicalIdentityId: identityId,
        control: {
            accessPolicy: 'neutral', automationMode: 'off', lifecycle: 'open', ownerId: null,
            controlVersion: '1', contextVersion: '1', status: 'confirmed', takenAt: null, handoffReason: null,
            profileKey: null, requiresReview: false, reviewReasons: [],
        },
        aggregateVersion: String(profile.messagesPerConversation + 1),
        lastActivityAt,
        historyCoverage: { kind: 'partial_import', capturingSince },
        unreadCount: 0,
        requiresReview: false,
    };
    return { identity, contact, conversation };
}

function createMessageDto(profile, conversationId, contactIndex, messageIndex, nextRandom) {
    const globalIndex = contactIndex * profile.messagesPerConversation + messageIndex;
    const length = 100 + Math.floor(nextRandom() * 501);
    let text = '';
    for (let k = 0; k < length; k++) text += String.fromCharCode(97 + ((globalIndex + k) % 26));
    const authorKind = ['customer', 'ai', 'operator'][globalIndex % 3];
    return {
        id: uuidV5(`message:${contactIndex}:${messageIndex}`, profile.uuidNamespace),
        conversationId,
        providerMessageId: String(messageIndex + 1),
        clientMessageId: null,
        inboundSeq: null,
        direction: authorKind === 'customer' ? 'inbound' : 'outbound',
        authorKind,
        actorId: null,
        content: { type: 'text', text },
        occurredAt: timestampFor(contactIndex, messageIndex, Date.parse(profile.anchorTime)),
        ingestedAt: profile.anchorTime,
        deliveryStatus: authorKind === 'customer' ? 'received' : 'sent',
        replyToId: null,
        source: 'import',
        deduplicationQuality: 'provider_id',
    };
}

async function writeJsonl(directory, filename, rows) {
    const destination = path.join(directory, filename);
    const file = await fsp.open(destination, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let pending = '', count = 0, bytes = 0;
    try {
        for await (const row of rows) {
            const line = `${canonicalJson(row)}\n`;
            hash.update(line);
            pending += line;
            count++;
            bytes += Buffer.byteLength(line);
            if (pending.length >= 1024 * 1024) {
                await file.write(pending);
                pending = '';
            }
        }
        if (pending) await file.write(pending);
        await file.sync();
    } finally {
        await file.close();
    }
    return { path: destination, count, bytes, sha256: hash.digest('hex') };
}

async function* entityRows(profile, accountIds, type) {
    if (type === 'Account') {
        const count = profile.accounts.whatsapp + profile.accounts.telegram;
        for (let i = 0; i < count; i++) {
            const channel = i < profile.accounts.whatsapp ? 'whatsapp' : 'telegram';
            const dto = {
                id: accountIds[i], channel, displayName: `Synthetic ${channel} account ${i}`,
                status: 'disconnected',
                capabilities: { historySync: channel === 'whatsapp', attachments: true, reply: true,
                    edit: false, deliveryReceipt: false, readReceipt: false },
            };
            assertValid('Account', dto);
            yield dto;
        }
        return;
    }
    for (let c = 0; c < profile.contacts; c++) {
        const entities = createEntityDtos(profile, accountIds, c);
        if (type === 'Contact') {
            assertValid('Contact', entities.contact);
            yield entities.contact;
        } else {
            assertValid('Conversation', entities.conversation);
            yield entities.conversation;
        }
    }
}

async function* messageRows(profile, conversationIds) {
    const nextRandom = xorshift32(profile.seed);
    for (let c = 0; c < profile.contacts; c++) {
        for (let j = 0; j < profile.messagesPerConversation; j++) {
            const dto = createMessageDto(profile, conversationIds[c], c, j, nextRandom);
            assertValid('Message', dto);
            yield dto;
        }
    }
}

async function* eventRows(profile, conversationIds) {
    const start = Math.max(0, profile.uniqueMessages - profile.retainedReplayEvents);
    const anchorTime = profile.anchorTime;
    for (let g = start; g < profile.uniqueMessages; g++) {
        const contactIndex = Math.floor(g / profile.messagesPerConversation);
        const messageIndex = g % profile.messagesPerConversation;
        const dto = {
            schemaVersion: 1,
            cursor: { dataEpoch: uuidV5('benchmark:event-epoch', profile.uuidNamespace), seq: String(g + 1) },
            type: 'message.created',
            occurredAt: anchorTime,
            data: {
                conversationId: conversationIds[contactIndex],
                messageId: uuidV5(`message:${contactIndex}:${messageIndex}`, profile.uuidNamespace),
                aggregateVersion: String(messageIndex + 2),
            },
        };
        assertValid('Event', dto);
        yield dto;
    }
}

async function generateDataset(directory, overrides = {}) {
    const profile = makeProfile(overrides);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const accountIds = Array.from({ length: 5 }, (_, i) => uuidV5(`account:${i}`, profile.uuidNamespace));
    const conversationIds = Array.from({ length: profile.contacts }, (_, i) => uuidV5(`conversation:${i}`, profile.uuidNamespace));
    const files = {};
    for (const type of ['Account', 'Contact', 'Conversation']) {
        const filename = `${type.toLowerCase()}.jsonl`;
        files[type] = await writeJsonl(directory, filename, entityRows(profile, accountIds, type));
    }
    files.Message = await writeJsonl(directory, 'message.jsonl', messageRows(profile, conversationIds));
    files.Event = await writeJsonl(directory, 'event.jsonl', eventRows(profile, conversationIds));
    const schemaHash = crypto.createHash('sha256').update(await fsp.readFile(SCHEMA_PATH)).digest('hex');
    const manifest = {
        fixtureVersion: 1,
        generatorVersion: 'v1-xorshift32',
        seed: profile.seed,
        parameters: profile,
        contractVersion: 'v1',
        schemaSha256: schemaHash,
        records: Object.fromEntries(Object.entries(files).map(([type, file]) => [type, file.count])),
        files: Object.fromEntries(Object.entries(files).map(([type, file]) => [type, { bytes: file.bytes, sha256: file.sha256 }])),
    };
    const manifestPath = path.join(directory, 'manifest.json');
    await fsp.writeFile(manifestPath, `${canonicalJson(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    return { profile, accountIds, conversationIds, files, manifest, manifestPath };
}

async function* readJsonl(filename) {
    const input = fs.createReadStream(filename, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) if (line) yield JSON.parse(line);
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function latencySummary(samples, failures = 0) {
    return {
        count: samples.length,
        failures,
        p50Ms: percentile(samples, 0.50),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
        maxMs: samples.length ? Math.max(...samples) : null,
        samplesMs: samples,
    };
}

function archiveInput(message, identity, source = 'import') {
    return {
        identity,
        providerMessageId: message.providerMessageId,
        source,
        direction: message.direction,
        authorKind: message.authorKind,
        occurredAt: message.occurredAt,
        content: message.content,
    };
}

async function importDataset(archive, dataset, onProgress = () => {}) {
    const profile = dataset.profile;
    const identityByConversation = new Map();
    for await (const account of readJsonl(dataset.files.Account.path)) {
        const result = await archive.registerAccount({ id: account.id, channel: account.channel,
            providerKey: `synthetic:account:${account.id}` });
        if (result.id !== account.id) throw new Error('registered account id differs from fixture');
    }
    const keyByContact = new Map();
    for await (const contact of readJsonl(dataset.files.Contact.path)) {
        if (contact.identities.length !== 1) throw new Error(`unexpected identity count for ${contact.id}`);
        keyByContact.set(contact.id, contact.identities[0].key);
    }
    let contactIndex = 0;
    for await (const conversation of readJsonl(dataset.files.Conversation.path)) {
        const key = keyByContact.get(conversation.contactId);
        if (!key) throw new Error(`conversation references unknown contact ${conversation.contactId}`);
        const resolved = await archive.resolve(key);
        identityByConversation.set(conversation.id, key);
        if (key.channel === 'whatsapp' && contactIndex < 100) {
            const alias = aliasFor(key, contactIndex);
            const linked = await archive.bindAlias({ canonical: key, alias,
                evidence: { kind: 'adapter', reference: `acceptance-v1:contact:${contactIndex}` } });
            if (linked.status !== 'linked' || linked.identity.conversation_id !== resolved.conversation_id) {
                throw new Error(`failed to link fixture alias for contact ${contactIndex}`);
            }
        }
        contactIndex++;
    }
    if (contactIndex !== profile.contacts) throw new Error(`expected ${profile.contacts} conversation DTOs, got ${contactIndex}`);
    const commitLatencies = [];
    let imported = 0, batch = [];
    const started = performance.now();
    for await (const message of readJsonl(dataset.files.Message.path)) {
        const identity = identityByConversation.get(message.conversationId);
        if (!identity) throw new Error(`message references unknown conversation ${message.conversationId}`);
        batch.push(archiveInput(message, identity));
        if (batch.length === 1000 || imported + batch.length === profile.uniqueMessages) {
            const timer = performance.now();
            const results = await archive.ingestBatch(batch);
            commitLatencies.push(performance.now() - timer);
            if (results.some(result => result.status !== 'created')) throw new Error('backfill produced a non-created result');
            imported += batch.length;
            batch = [];
            if (imported % 100_000 === 0 || imported === profile.uniqueMessages) onProgress({ imported, total: profile.uniqueMessages });
        }
    }
    if (imported !== profile.uniqueMessages || batch.length) throw new Error(`incomplete import: ${imported}`);
    const durationSeconds = (performance.now() - started) / 1000;
    const duplicatesStarted = performance.now();
    let duplicateCount = 0, duplicateBatch = [];
    let globalIndex = 0;
    for await (const message of readJsonl(dataset.files.Message.path)) {
        if (globalIndex >= profile.duplicateDeliveries) break;
        const contactIndex = Math.floor(globalIndex / profile.messagesPerConversation);
        const canonical = identityByConversation.get(message.conversationId);
        const identity = canonical.channel === 'whatsapp' && contactIndex < 100
            ? aliasFor(canonical, contactIndex) : canonical;
        duplicateBatch.push(archiveInput(message, identity, 'history'));
        globalIndex++;
        if (duplicateBatch.length === 1000 || globalIndex === profile.duplicateDeliveries) {
            const results = await archive.ingestBatch(duplicateBatch);
            if (results.some(result => result.status !== 'duplicate')) throw new Error('redelivery created or quarantined a row');
            duplicateCount += results.length;
            duplicateBatch = [];
        }
    }
    const redeliverySeconds = (performance.now() - duplicatesStarted) / 1000;
    return {
        imported,
        duplicateCount,
        durationSeconds,
        messagesPerSecond: imported / durationSeconds,
        commitLatencies,
        redeliverySeconds,
        identityByConversation,
    };
}

async function readEventTail(archive, total, size = 1000) {
    const start = Math.max(0, total - 50_000);
    const events = [];
    let after = String(start);
    while (events.length < 50_000) {
        const page = await archive.events({ after, limit: size });
        if (!page.length) break;
        events.push(...page);
        after = page[page.length - 1].cursor.seq;
    }
    return { events: events.length, firstSeq: events[0]?.cursor.seq ?? null, lastSeq: events.at(-1)?.cursor.seq ?? null };
}

async function runSampler({ name, count, durationMs, random, sample, onSample }) {
    const values = [];
    let failures = 0;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
        const planned = start + durationMs * i / count;
        const remaining = planned - performance.now();
        if (remaining > 0) await delay(remaining);
        const before = performance.now();
        try {
            await sample(random);
            values.push(performance.now() - before);
        } catch (error) {
            values.push(performance.now() - before);
            failures++;
            onSample?.({ name, error: error.code || error.name || 'UNKNOWN' });
        }
    }
    return latencySummary(values, failures);
}

async function runIngressPhase({ archive, identityKeys, runIndex, phase, rate, seconds, tracker }) {
    const count = rate * seconds;
    const values = [];
    let failures = 0;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
        const planned = start + i * 1000 / rate;
        const remaining = planned - performance.now();
        if (remaining > 0) await delay(remaining);
        const identity = identityKeys[(runIndex * 37 + i * 17) % identityKeys.length];
        const input = {
            identity,
            providerMessageId: `bench-${runIndex}-${phase}-${i}`,
            source: 'live', direction: 'inbound', authorKind: 'customer',
            occurredAt: new Date(Date.parse('2026-10-19T12:00:00.000Z') + runIndex * 86_400_000 + i).toISOString(),
            content: { type: 'text', text: `Synthetic ingress ${runIndex} ${phase} ${i}` },
        };
        const before = performance.now();
        try {
            const [result] = await archive.ingestBatch([input]);
            if (result.status !== 'created') throw Object.assign(new Error('ingress not created'), { code: result.status });
            values.push(performance.now() - before);
        } catch (error) {
            values.push(performance.now() - before);
            failures++;
            tracker.errors.push({ operation: 'ingest', phase, code: error.code || error.name || 'UNKNOWN' });
        }
    }
    return latencySummary(values, failures);
}

function childTelemetry() {
    const resources = effectiveResourceLimits();
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytesAtStart: os.freemem(),
        effectiveResources: resources,
        sqlite: process.versions.sqlite || null,
        profileTarget: { logicalCpus: 2, memoryBytes: 4 * 1024 ** 3 },
        profileMatch: resources.effectiveLogicalCpus === 2 && resources.effectiveMemoryBytes <= 4 * 1024 ** 3,
    };
}

async function runMeasuredScenario(archive, dataset, runIndex, kind) {
    const profile = dataset.profile;
    const identityKeys = [];
    for (let c = 0; c < profile.contacts; c++) identityKeys.push(identityFor(c, profile, dataset.accountIds));
    const telemetry = { rssPeakBytes: process.memoryUsage().rss, queuePeak: { elements: 0, bytes: 0 }, errors: [] };
    const eventLoop = monitorEventLoopDelay({ resolution: 10 });
    eventLoop.enable();
    const sampleTimer = setInterval(() => {
        telemetry.rssPeakBytes = Math.max(telemetry.rssPeakBytes, process.memoryUsage().rss);
        const queue = archive.queue();
        telemetry.queuePeak.elements = Math.max(telemetry.queuePeak.elements, queue.elements);
        telemetry.queuePeak.bytes = Math.max(telemetry.queuePeak.bytes, queue.bytes);
    }, 100);
    const durationMs = (profile.steadySeconds + profile.burstSeconds) * 1000;
    const traffic = (async () => {
        const steady = await runIngressPhase({ archive, identityKeys, runIndex, phase: 'steady',
            rate: profile.steadyIngressPerSecond, seconds: profile.steadySeconds, tracker: telemetry });
        const burst = await runIngressPhase({ archive, identityKeys, runIndex, phase: 'burst',
            rate: profile.burstIngressPerSecond, seconds: profile.burstSeconds, tracker: telemetry });
        return { steady, burst };
    })();
    const queryRandom = label => xorshift32((profile.seed + runIndex * 100_003 + label) >>> 0);
    const samples = await Promise.all([
        runSampler({ name: 'conversationsPage50', count: profile.querySamplesPerOperationPerRun,
            durationMs, random: queryRandom(1), sample: () => archive.conversations({ limit: 50 }),
            onSample: error => telemetry.errors.push({ operation: error.name, code: error.error }) }),
        runSampler({ name: 'messagesPage50', count: profile.querySamplesPerOperationPerRun,
            durationMs, random: queryRandom(2), sample: random => {
                const conversation = Math.floor(random() * dataset.conversationIds.length);
                return archive.messages({ conversationId: dataset.conversationIds[conversation], limit: 50 });
            }, onSample: error => telemetry.errors.push({ operation: error.name, code: error.error }) }),
    ]).then(async querySamples => ({ querySamples, traffic: await traffic }));
    const drainStarted = performance.now();
    while (archive.queue().elements > 0 && performance.now() - drainStarted < 60_000) await delay(25);
    clearInterval(sampleTimer);
    eventLoop.disable();
    const diagnostics = await archive.diagnostics();
    return {
        index: runIndex + 1,
        kind,
        durationMs,
        conversationsPage50: samples.querySamples[0],
        messagesPage50: samples.querySamples[1],
        ingestSteady: samples.traffic.steady,
        ingestBurst: samples.traffic.burst,
        eventLoopDelay: {
            p50Ms: Number(eventLoop.percentile(50)) / 1e6,
            p95Ms: Number(eventLoop.percentile(95)) / 1e6,
            p99Ms: Number(eventLoop.percentile(99)) / 1e6,
            maxMs: Number(eventLoop.max) / 1e6,
        },
        rssPeakBytes: telemetry.rssPeakBytes,
        queuePeak: telemetry.queuePeak,
        errors: telemetry.errors,
        diagnostics,
    };
}

async function saturationScenario(snapshotPath, directory, dataset) {
    const dbPath = path.join(directory, 'saturation.db');
    await fsp.copyFile(snapshotPath, dbPath);
    const archive = createArchive({ path: dbPath, timeoutMs: FULL_VALIDATION_TIMEOUT_MS });
    try {
        await archive.ready;
        const messagesBefore = (await archive.diagnostics()).messages;
        const reads = Array.from({ length: MAX_QUEUE_ITEMS + 100 }, () => archive.events({ after: '999999999', limit: 1 }));
        const queueAtPeak = archive.queue();
        const itemRejections = reads.length - queueAtPeak.elements;
        const targetAccount = dataset.accountIds[2];
        const cursorAttempt = archive.captureTelegramBatch({
            accountId: targetAccount,
            updates: [{ updateId: '1', message: {
                identity: { accountId: targetAccount, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '9876543210' },
                providerMessageId: 'saturated-1', source: 'live', direction: 'inbound', authorKind: 'customer',
                occurredAt: '2026-10-20T00:00:00.000Z', content: { type: 'text', text: 'saturation fixture' },
            } }],
        });
        let cursorRejected = false;
        try { await cursorAttempt; } catch (error) { cursorRejected = error.code === 'ARCHIVE_SATURATED'; }
        await Promise.allSettled(reads);
        const cursor = await archive.telegramCursor(targetAccount);
        const diagnostics = await archive.diagnostics();

        const largeRequests = Array.from({ length: 800 }, () => archive.resolve({
            accountId: targetAccount, channel: 'telegram', kind: 'telegram_chat_id', exactValue: '1'.repeat(50_000),
        }));
        const byteQueueAtPeak = archive.queue();
        const byteRejections = largeRequests.length - byteQueueAtPeak.elements;
        await Promise.allSettled(largeRequests);
        return {
            itemCapacity: {
                attempted: reads.length,
                admitted: queueAtPeak.elements,
                rejections: itemRejections,
                peakBytes: queueAtPeak.bytes,
                cursorRejected,
                telegramCursorAfterDrain: cursor,
                messagesBefore,
                messagesAfter: diagnostics.messages,
                pendingDispatches: diagnostics.legacyDispatchPending + diagnostics.legacyDispatchWaiting,
                queueWithinBounds: queueAtPeak.elements <= MAX_QUEUE_ITEMS && queueAtPeak.bytes <= MAX_QUEUE_BYTES,
            },
            byteCapacity: {
                attempted: largeRequests.length,
                admitted: byteQueueAtPeak.elements,
                rejections: byteRejections,
                peakBytes: byteQueueAtPeak.bytes,
                queueWithinBounds: byteQueueAtPeak.elements <= MAX_QUEUE_ITEMS && byteQueueAtPeak.bytes <= MAX_QUEUE_BYTES,
            },
        };
    } finally {
        await archive.close();
    }
}

async function runFull({ reportPath, temporaryRoot } = {}) {
    const profile = makeProfile();
    const selectedTempRoot = path.resolve(temporaryRoot || process.env.SDK_CONVERSATION_LOAD_TMPDIR || os.tmpdir());
    const tempStats = await fsp.statfs(selectedTempRoot);
    const tempFreeBytesAtStart = Number(tempStats.bavail) * Number(tempStats.bsize);
    const minimumTempBytes = 6 * 1024 ** 3;
    if (tempFreeBytesAtStart < minimumTempBytes) {
        throw new Error(`F2E.2 necesita al menos 6 GiB temporales libres; ${selectedTempRoot} tiene ${(tempFreeBytesAtStart / 1024 ** 3).toFixed(1)} GiB. Configure SDK_CONVERSATION_LOAD_TMPDIR.`);
    }
    const environment = childTelemetry();
    const workdir = await fsp.mkdtemp(path.join(selectedTempRoot, 'sdkbot-f2e2-'));
    const datasetDirectory = path.join(workdir, 'dataset');
    const databasePath = path.join(workdir, 'archive.db');
    const snapshotPath = path.join(workdir, 'baseline.db');
    const reports = [];
    const reportDestination = path.resolve(reportPath || path.join(REPO_ROOT, 'docs/evidence/F2E2-load-report.json'));
    let archive, stage = 'generate dataset';
    try {
        process.stdout.write(`F2E.2: generando ${profile.uniqueMessages.toLocaleString('es')} mensajes sintéticos…\n`);
        const dataset = await generateDataset(datasetDirectory);
        process.stdout.write(`F2E.2: JSONL generado; importando en lotes de 1.000…\n`);
        archive = createArchive({ path: databasePath, timeoutMs: 60_000 });
        let ready = await archive.ready;
        stage = 'import dataset';
        const imported = await importDataset(archive, dataset, progress => {
            process.stdout.write(`F2E.2: ${progress.imported.toLocaleString('es')}/${progress.total.toLocaleString('es')} mensajes\n`);
        });
        process.stdout.write('F2E.2: importación terminada; cerrando worker para validar el archivo…\n');
        stage = 'reopen archive for full validation';
        await archive.close();
        archive = createArchive({ path: databasePath, timeoutMs: FULL_VALIDATION_TIMEOUT_MS });
        ready = await archive.ready;
        process.stdout.write('F2E.2: comprobando integridad y claves foráneas…\n');
        stage = 'integrity and foreign-key checks';
        const afterImport = await archive.diagnostics();
        const expectedAliases = Array.from({ length: profile.contacts }, (_, c) => c)
            .filter(c => c < 100 && c % 5 < profile.accounts.whatsapp).length;
        if (afterImport.messages !== profile.uniqueMessages || afterImport.events !== profile.retainedReplayEvents
            || afterImport.aliases !== expectedAliases || afterImport.quarantine !== 0
            || imported.duplicateCount !== profile.duplicateDeliveries || afterImport.seq !== String(profile.uniqueMessages)) {
            throw new Error(`post-import invariants failed: ${JSON.stringify({ afterImport, imported: imported.imported, duplicates: imported.duplicateCount })}`);
        }
        process.stdout.write('F2E.2: verificando ventana de eventos…\n');
        stage = 'event tail verification';
        const eventTail = await readEventTail(archive, profile.uniqueMessages);
        if (eventTail.events !== profile.retainedReplayEvents || eventTail.lastSeq !== String(profile.uniqueMessages)) {
            throw new Error(`event tail mismatch: ${JSON.stringify(eventTail)}`);
        }
        process.stdout.write('F2E.2: creando snapshot SQLite…\n');
        stage = 'baseline snapshot';
        await archive.backup(snapshotPath);
        await archive.close();
        archive = null;
        await fsp.rm(databasePath, { force: true });
        await fsp.rm(`${databasePath}-wal`, { force: true });
        await fsp.rm(`${databasePath}-shm`, { force: true });
        for (const file of Object.values(dataset.files)) await fsp.rm(file.path, { force: true });
        process.stdout.write(`F2E.2: snapshot íntegro; ${imported.messagesPerSecond.toFixed(0)} mensajes/s.\n`);

        for (let i = 0; i < profile.warmupRuns + profile.measuredRuns; i++) {
            const kind = i < profile.warmupRuns ? 'warmup' : 'measured';
            const index = kind === 'warmup' ? i : i - profile.warmupRuns;
            const runPath = path.join(workdir, `run-${i + 1}.db`);
            stage = `${kind} ${index + 1} snapshot copy`;
            process.stdout.write(`F2E.2: preparando copia para ${kind} ${index + 1}…\n`);
            await fsp.copyFile(snapshotPath, runPath);
            stage = `${kind} ${index + 1} archive startup`;
            const runArchive = createArchive({ path: runPath, timeoutMs: FULL_VALIDATION_TIMEOUT_MS });
            await runArchive.ready;
            process.stdout.write(`F2E.2: ${kind} ${index + 1} — 150 s de ingesta concurrente y 4.000 consultas…\n`);
            stage = `${kind} ${index + 1}`;
            const result = await runMeasuredScenario(runArchive, dataset, i, kind);
            reports.push(result);
            await runArchive.close();
            await fsp.rm(runPath, { force: true });
            await fsp.rm(`${runPath}-wal`, { force: true });
            await fsp.rm(`${runPath}-shm`, { force: true });
            process.stdout.write(`F2E.2: ${kind} ${index + 1} terminado; RSS pico ${(result.rssPeakBytes / 1024 ** 2).toFixed(1)} MiB.\n`);
        }

        process.stdout.write('F2E.2: probando límites FIFO por elementos/bytes y cursor Telegram…\n');
        stage = 'saturation scenario';
        const saturation = await saturationScenario(snapshotPath, workdir, dataset);
        const finalReport = {
            benchmark: 'sdk-bot-conversations-v1',
            generatedAt: new Date().toISOString(),
            commit: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
            environment,
            temporaryDisk: { freeBytesAtStart: tempFreeBytesAtStart, minimumFreeBytes: minimumTempBytes },
            database: { ...ready, importedMessages: imported.imported, duplicateDeliveries: imported.duplicateCount,
                importMessagesPerSecond: imported.messagesPerSecond, importCommitLatency: latencySummary(imported.commitLatencies),
                eventTail, diagnostics: afterImport },
            dataset: { manifest: dataset.manifest, manifestSha256: crypto.createHash('sha256').update(await fsp.readFile(dataset.manifestPath)).digest('hex') },
            runs: reports,
            saturation,
            unsupported: {
                takeoverCommitMs: 'F5 control API is not implemented in the current roadmap phase.',
                profileDeviation: environment.profileMatch ? null : 'Runner effective limits are not the 2-vCPU / 4-GiB reference profile.',
                authorProjection: 'ArchiveInput currently stores imported outbound authors as unknown; source DTO JSONL preserves the deterministic customer/ai/operator fixture.',
            },
        };
        await fsp.mkdir(path.dirname(reportDestination), { recursive: true });
        await fsp.writeFile(reportDestination, `${canonicalJson(finalReport)}\n`, { mode: 0o600 });
        process.stdout.write(`F2E.2: informe guardado en ${reportDestination}\n`);
        return { reportPath: reportDestination, report: finalReport };
    } catch (error) {
        if (error && typeof error === 'object') error.benchmarkStage = stage;
        throw error;
    } finally {
        if (archive) await archive.close().catch(() => {});
        await fsp.rm(workdir, { recursive: true, force: true });
    }
}

module.exports = { uuidV5, canonicalJson, xorshift32, makeProfile, effectiveResourceLimits, parseCpuMax,
    parseCpuSet, parseMemoryMax, generateDataset, importDataset, runFull };

if (require.main === module) {
    const args = process.argv.slice(2);
    if (!args.includes('--full')) {
        process.stderr.write('Uso: node scripts/conversation-load.js --full [--report /ruta/al/informe.json]\n');
        process.exitCode = 2;
    } else {
        const reportIndex = args.indexOf('--report');
        const reportPath = reportIndex < 0 ? undefined : args[reportIndex + 1];
        const tempIndex = args.indexOf('--tmpdir');
        const temporaryRoot = tempIndex < 0 ? undefined : args[tempIndex + 1];
        runFull({ reportPath, temporaryRoot }).then(({ reportPath: destination, report }) => {
            process.stdout.write(`F2E.2 status: import=${report.database.importMessagesPerSecond.toFixed(0)} msg/s; runs=${report.runs.length}; report=${destination}\n`);
        }).catch(error => {
            const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : error?.name || 'UNKNOWN';
            process.stderr.write(`F2E.2 falló en ${error?.benchmarkStage || 'runner'} (${code}): ${error.message}\n`);
            process.exitCode = 1;
        });
    }
}
