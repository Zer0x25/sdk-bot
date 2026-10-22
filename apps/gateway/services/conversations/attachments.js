const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { attachmentDirectory } = require('./paths');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function normalizeFileName(value) {
    let name = Array.from(path.posix.basename(String(value ?? '').replaceAll('\\', '/')))
        .filter(character => character.codePointAt(0) > 31 && character.codePointAt(0) !== 127).join('').trim();
    name = Array.from(name).slice(0, 180).join('');
    return name && name !== '.' && name !== '..' ? name : 'adjunto';
}
function normalizeContentType(value) {
    return typeof value === 'string' && value.length <= 127
        && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
        ? value.toLowerCase() : 'application/octet-stream';
}
function sourceStream(source) {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) return Readable.from([Buffer.from(source)]);
    if (source && typeof source.pipe === 'function' && typeof source[Symbol.asyncIterator] === 'function') return source;
    fail('INVALID_ATTACHMENT_SOURCE');
}

async function inspectAttachmentFiles({ directory = attachmentDirectory(), registry = [] } = {}) {
    const root = path.resolve(directory);
    const expected = new Map(registry.map(row => [row.id, row]));
    const problems = new Set();
    const digest = createHash('sha256');
    let count = 0;
    let bytes = 0;
    let entries;
    let rootStat;
    try {
        rootStat = await fsp.lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) problems.add('ATTACHMENT_DIRECTORY_INVALID');
        else if ((rootStat.mode & 0o777) !== 0o700) problems.add('ATTACHMENT_PERMISSIONS_INVALID');
        if (problems.size) return { valid: false, problems: [...problems], count, bytes, sha256: digest.digest('hex') };
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') problems.add('ATTACHMENT_DIRECTORY_UNREADABLE');
        if (error.code === 'ENOENT' && registry.some(row => row.state === 'available')) problems.add('ATTACHMENT_BLOB_MISSING');
        return { valid: problems.size === 0, problems: [...problems], count, bytes, sha256: digest.digest('hex') };
    }

    const seen = new Set();
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
            problems.add('ATTACHMENT_LAYOUT_INVALID');
            continue;
        }
        const match = /^([0-9a-f-]{36})\.blob$/.exec(entry.name);
        if (!match || !ID_PATTERN.test(match[1])) {
            problems.add('ATTACHMENT_LAYOUT_INVALID');
            continue;
        }
        const id = match[1];
        const row = expected.get(id);
        if (!row || !['available', 'delete_pending'].includes(row.state) || seen.has(id)) {
            problems.add('ATTACHMENT_LEDGER_MISMATCH');
            continue;
        }
        seen.add(id);
        let handle;
        try {
            const noFollow = fs.constants.O_NOFOLLOW || 0;
            handle = await fsp.open(path.join(root, entry.name), fs.constants.O_RDONLY | noFollow);
            const stat = await handle.stat();
            if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== row.size
                || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
                problems.add('ATTACHMENT_BLOB_INVALID');
                continue;
            }
            const content = await handle.readFile();
            const sha256 = createHash('sha256').update(content).digest('hex');
            if (sha256 !== row.sha256) problems.add('ATTACHMENT_BLOB_INVALID');
            digest.update(`${id}\0${stat.size}\0${sha256}\n`);
            count += 1;
            bytes += stat.size;
        } catch (error) {
            problems.add(error.code === 'ENOENT' ? 'ATTACHMENT_BLOB_MISSING' : 'ATTACHMENT_BLOB_UNREADABLE');
        } finally {
            await handle?.close().catch(() => {});
        }
    }
    for (const row of registry) {
        if (row.state === 'available' && !seen.has(row.id)) problems.add('ATTACHMENT_BLOB_MISSING');
    }
    return { valid: problems.size === 0, problems: [...problems].sort(), count, bytes, sha256: digest.digest('hex') };
}

function createAttachmentStore({ archive, directory = attachmentDirectory(), maxFileBytes = MAX_FILE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
    if (!archive || typeof archive.attachmentTarget !== 'function') fail('ARCHIVE_REQUIRED');
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES
        || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes || maxTotalBytes > MAX_TOTAL_BYTES) {
        fail('INVALID_ATTACHMENT_LIMIT');
    }
    const configuredRoot = path.resolve(directory);
    const sizes = new Map();
    const activeStores = new Set();
    const readers = new Set();
    let root = configuredRoot, usedBytes = 0, reservedBytes = 0, initialized = false, closed = false;
    let initPromise;

    async function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            await fsp.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
            const rootStat = await fsp.lstat(configuredRoot);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_ATTACHMENT_STORE');
            await fsp.chmod(configuredRoot, 0o700);
            root = await fsp.realpath(configuredRoot);
            const registry = await archive.attachmentRegistry();
            const records = new Map(registry.map(row => [row.id, row]));
            const entries = await fsp.readdir(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || entry.isSymbolicLink()) fail('UNSAFE_ATTACHMENT_STORE');
                const file = path.join(root, entry.name);
                if (entry.name.endsWith('.tmp')) {
                    await fsp.unlink(file);
                    continue;
                }
                const match = /^([0-9a-f-]{36})\.blob$/.exec(entry.name);
                if (!match || !ID_PATTERN.test(match[1])) fail('UNSAFE_ATTACHMENT_STORE');
                const row = records.get(match[1]);
                if (!row || row.state !== 'available') {
                    await fsp.unlink(file);
                    if (row?.state === 'delete_pending') await archive.finishAttachmentDeletion({ id: row.id });
                    continue;
                }
                const stat = await fsp.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size) {
                    await archive.markAttachmentUnavailable({ id: row.id });
                    await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
                    await archive.finishAttachmentDeletion({ id: row.id });
                    continue;
                }
                sizes.set(row.id, row.size);
                usedBytes += row.size;
            }
            // Metadata can survive while the file is absent after a partial disk failure.
            for (const row of registry) {
                if (row.state === 'delete_pending') {
                    await fsp.unlink(path.join(root, `${row.id}.blob`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
                    await archive.finishAttachmentDeletion({ id: row.id });
                } else if (!sizes.has(row.id)) {
                    await archive.markAttachmentUnavailable({ id: row.id });
                    await archive.finishAttachmentDeletion({ id: row.id });
                }
            }
            if (usedBytes > maxTotalBytes) fail('ATTACHMENT_QUOTA_EXCEEDED');
            initialized = true;
            return { usedBytes, maxFileBytes, maxTotalBytes };
        })();
        return initPromise;
    }

    async function store({ messageId, source, fileName, contentType, capturedAt = new Date().toISOString() } = {}) {
        const task = storeInternal({ messageId, source, fileName, contentType, capturedAt });
        activeStores.add(task);
        try { return await task; }
        finally { activeStores.delete(task); }
    }

    async function storeInternal(input) {
        if (closed) fail('ATTACHMENT_STORE_CLOSED');
        await init();
        const target = await archive.attachmentTarget({ messageId: input.messageId });
        if (!target) fail('ATTACHMENT_MESSAGE_MISSING');
        const id = randomUUID();
        const temp = path.join(root, `${id}.tmp`), final = path.join(root, `${id}.blob`);
        const hash = createHash('sha256');
        let size = 0, reserved = 0, moved = false, committed = false, preserve = false;
        const accountBytes = new Transform({
            transform: (chunk, _encoding, callback) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buffer.length;
                if (size > maxFileBytes) return callback(Object.assign(new Error('ATTACHMENT_TOO_LARGE'), { code: 'ATTACHMENT_TOO_LARGE' }));
                if (usedBytes + reservedBytes + buffer.length > maxTotalBytes) {
                    return callback(Object.assign(new Error('ATTACHMENT_QUOTA_EXCEEDED'), { code: 'ATTACHMENT_QUOTA_EXCEEDED' }));
                }
                reserved += buffer.length;
                reservedBytes += buffer.length;
                hash.update(buffer);
                callback(null, buffer);
            }
        });
        try {
            await pipeline(sourceStream(input.source), accountBytes,
                fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            if (!size) fail('ATTACHMENT_EMPTY');
            const durableHandle = await fsp.open(temp, 'r+');
            try { await durableHandle.sync(); } finally { await durableHandle.close(); }
            await fsp.rename(temp, final); moved = true;
            const result = await archive.registerAttachment({ id, messageId: input.messageId,
                fileName: normalizeFileName(input.fileName), contentType: normalizeContentType(input.contentType),
                size, sha256: hash.digest('hex'), capturedAt: new Date(input.capturedAt).toISOString() });
            committed = true;
            sizes.set(id, size);
            usedBytes += size;
            return { ...result, attachment: result.attachment };
        } catch (error) {
            if (moved) {
                try {
                    const registered = await archive.attachment({ id });
                    if (registered) {
                        committed = true; preserve = true; sizes.set(id, registered.size); usedBytes += registered.size;
                        return { status: 'stored', attachment: registered, recovered: true };
                    } else {
                        await fsp.unlink(final).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
                    }
                } catch {
                    // The worker may have committed before timing out. Preserve the blob
                    // and quota reservation until restart reconciliation can inspect SQLite.
                    preserve = true; usedBytes += size; sizes.set(id, size);
                }
            }
            throw error;
        } finally {
            if (!moved) await fsp.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
            reservedBytes -= reserved;
            if (!committed && !preserve) reserved = 0;
        }
    }

    async function open(id) {
        if (closed) fail('ATTACHMENT_STORE_CLOSED');
        await init();
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('INVALID_ATTACHMENT_ID');
        const metadata = await archive.attachment({ id });
        if (!metadata) return null;
        if (metadata.expiresAt < new Date().toISOString()) {
            await archive.expireAttachment({ id });
            await sweepExpired();
            return null;
        }
        const file = path.join(root, `${id}.blob`);
        try {
            const stat = await fsp.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.size) throw Object.assign(new Error('ATTACHMENT_UNAVAILABLE'), { code: 'ATTACHMENT_UNAVAILABLE' });
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ATTACHMENT_UNAVAILABLE') throw error;
            await archive.markAttachmentUnavailable({ id });
            await sweepExpired();
            return null;
        }
        const stream = fs.createReadStream(file);
        readers.add(stream);
        const release = () => readers.delete(stream);
        stream.once('close', release); stream.once('end', release);
        stream.once('error', error => {
            release();
            if (error.code === 'ENOENT') void archive.markAttachmentUnavailable({ id }).then(sweepExpired).catch(() => {});
        });
        return { metadata, stream };
    }

    async function sweepExpired({ limit = 100 } = {}) {
        if (!initialized) await init();
        const ids = await archive.pendingAttachmentDeletions({ limit });
        let deleted = 0;
        for (const id of ids) {
            await fsp.unlink(path.join(root, `${id}.blob`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
            const result = await archive.finishAttachmentDeletion({ id });
            if (result.deleted) {
                const size = sizes.get(id) ?? 0;
                sizes.delete(id); usedBytes = Math.max(0, usedBytes - size); deleted += 1;
            }
        }
        return { deleted, remaining: ids.length === limit };
    }

    async function close() {
        closed = true;
        await Promise.allSettled([...activeStores]);
        for (const stream of readers) stream.destroy();
        readers.clear();
    }

    return {
        init,
        store,
        open,
        sweepExpired,
        close,
        stats: () => ({ usedBytes, reservedBytes, count: sizes.size, maxFileBytes, maxTotalBytes, initialized })
    };
}

module.exports = { createAttachmentStore, inspectAttachmentFiles, MAX_FILE_BYTES, MAX_TOTAL_BYTES, normalizeFileName, normalizeContentType };
