const { createHash } = require('node:crypto');

const VALID_GLOBAL_MODES = new Set(['allowed_all','ignored_all']);
const PHONE_SUFFIXES = ['@s.whatsapp.net','@c.us','@hosted'];
const LID_SUFFIXES = ['@lid','@hosted.lid'];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
function recordChecksum(value) { return sha256(JSON.stringify(canonical(value))); }
function sourceKey(type, value) { return `${type}:${sha256(`${type}\0${value}`)}`; }
function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function safeProfileKey(value) { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value); }

function isExcludedIdentity(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.toLowerCase();
    return normalized.endsWith('@g.us') || normalized.endsWith('@newsletter')
        || normalized.endsWith('@broadcast') || normalized.startsWith('status@') || normalized.startsWith('0@');
}

function candidatesFrom(value, suffixes) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const normalized = value.trim();
    const at = normalized.lastIndexOf('@');
    if (at >= 0) {
        const suffix = normalized.slice(at).toLowerCase();
        if (!suffixes.includes(suffix)) return [];
        const exactDigits = normalized.slice(0, at);
        return /^\+?[0-9][0-9 .()-]*$/.test(exactDigits)
            ? [`${exactDigits.replace(/\D/g, '')}${suffix}`] : [];
    }
    const digits = normalized.replace(/\D/g, '');
    if (!digits || !/^[+0-9 .()-]+$/.test(normalized)) return [];
    return suffixes.map(suffix => `${digits}${suffix}`);
}

function contactIdentityHint(legacyKey, record) {
    if (isExcludedIdentity(legacyKey)) return { kind: 'excluded_channel', suffix: null };
    const phone = candidatesFrom(typeof record?.phone === 'string' ? record.phone : null, PHONE_SUFFIXES)[0];
    if (phone) return { kind: 'phone', suffix: phone.slice(0, phone.lastIndexOf('@')).slice(-4) };
    const lid = candidatesFrom(typeof record?.lid === 'string' ? record.lid : null, LID_SUFFIXES)[0];
    if (lid) return { kind: 'lid', suffix: lid.slice(0, lid.lastIndexOf('@')).slice(-4) };
    return { kind: 'unresolved', suffix: null };
}

function identityIndex(conversations) {
    const index = new Map();
    for (const conversation of conversations) {
        if (!conversation || conversation.channel !== 'whatsapp' || !Array.isArray(conversation.identity_keys)) continue;
        for (const identity of conversation.identity_keys) {
            if (!identity || (identity.kind !== 'whatsapp_jid' && identity.kind !== 'whatsapp_lid')
                || typeof identity.exactValue !== 'string') continue;
            const owners = index.get(identity.exactValue) || new Map();
            owners.set(conversation.id, conversation);
            index.set(identity.exactValue, owners);
        }
    }
    return index;
}

function globalProfilePlan(settings, profileKeys, entries, blockers) {
    if (!hasOwn(settings, 'currentProfile') || settings.currentProfile === null || settings.currentProfile === '') {
        const value = 'default';
        const valid = profileKeys?.has(value) === true;
        entries.push({ sourceKey: sourceKey('settings', 'currentProfile'), source: 'settings_default', field: 'currentProfile',
            sourceChecksum: recordChecksum(value), disposition: valid ? 'imported' : 'quarantined',
            ...(valid ? { plannedProfile: value } : { reason: 'profile_missing', plannedProfile: value }) });
        if (!valid) blockers.push({ code: 'default_profile_missing' });
        return { value: valid ? value : null, source: 'application_default', valid };
    }
    const raw = settings.currentProfile;
    const source = 'settings:currentProfile';
    if (!safeProfileKey(raw)) {
        entries.push({ sourceKey: sourceKey('settings', 'currentProfile'), source: 'settings', field: 'currentProfile',
            sourceChecksum: recordChecksum(raw), disposition: 'quarantined', reason: 'invalid_profile_key' });
        blockers.push({ code: 'global_profile_invalid' });
        return { value: null, source, valid: false };
    }
    if (!profileKeys?.has(raw)) {
        entries.push({ sourceKey: sourceKey('settings', 'currentProfile'), source: 'settings', field: 'currentProfile',
            sourceChecksum: recordChecksum(raw), disposition: 'quarantined', reason: 'profile_missing', plannedProfile: raw });
        blockers.push({ code: 'global_profile_missing' });
        return { value: null, source, valid: false };
    }
    entries.push({ sourceKey: sourceKey('settings', 'currentProfile'), source: 'settings', field: 'currentProfile',
        sourceChecksum: recordChecksum(raw), disposition: 'imported', plannedProfile: raw });
    return { value: raw, source, valid: true };
}

function contactPlan(legacyKey, record, globalMode, globalProfile, profileKeys, profileInventoryAvailable, index,
    excludeContactsWithoutConversation = false) {
    if (isExcludedIdentity(legacyKey)) return { disposition: 'excluded', reason: 'out_of_scope_channel' };
    if (!isRecord(record)) return { disposition: 'quarantined', reason: 'invalid_contact_record' };
    const phone = typeof record.phone === 'string' ? record.phone : null;
    const lid = typeof record.lid === 'string' ? record.lid : null;
    if (record.isAdminChannel === true || isExcludedIdentity(legacyKey) || isExcludedIdentity(phone) || isExcludedIdentity(lid)) {
        return { disposition: 'excluded', reason: 'out_of_scope_channel' };
    }
    const candidates = new Set([...candidatesFrom(phone, PHONE_SUFFIXES), ...candidatesFrom(lid, LID_SUFFIXES)]);
    if (!candidates.size) return { disposition: 'quarantined', reason: 'identity_missing_or_invalid' };
    const targets = new Map();
    for (const candidate of candidates) {
        for (const [id, conversation] of index.get(candidate) || []) targets.set(id, conversation);
    }
    if (!targets.size) return excludeContactsWithoutConversation
        ? { disposition: 'excluded', reason: 'no_conversation_target', decision: 'exclude_no_conversation_target' }
        : { disposition: 'quarantined', reason: 'identity_not_found' };
    if (targets.size !== 1) return { disposition: 'quarantined', reason: 'identity_ambiguous',
        candidateTargetIds: [...targets.keys()].sort() };
    const targetId = targets.keys().next().value;
    let accessPolicy = 'neutral';
    let automationMode = 'off';
    let handoffReason = null;
    let takenAt = null;
    let requiresReview = false;
    const reviewReasons = [];
    const state = record.estado;
    if (state === 'permitido') {
        accessPolicy = 'allowed';
        automationMode = 'ai';
    } else if (state === 'ignorado') {
        accessPolicy = 'ignored';
    } else if (state === 'handoff') {
        automationMode = 'human';
        handoffReason = 'legacy_import';
        if (typeof record.handoffAt === 'string' && Number.isFinite(Date.parse(record.handoffAt))) {
            takenAt = new Date(record.handoffAt).toISOString();
        }
    } else if (state === undefined || state === null || state === 'neutro') {
        automationMode = globalMode === 'allowed_all' ? 'ai' : 'off';
    } else {
        automationMode = 'off';
        requiresReview = true;
        reviewReasons.push('invalid_legacy_state');
    }

    let profile = globalProfile;
    if (record.perfil !== undefined && record.perfil !== null && record.perfil !== ''
        && record.perfil !== 'default' && record.perfil !== 'none') {
        if (safeProfileKey(record.perfil)) profile = record.perfil;
        else {
            profile = null;
            requiresReview = true;
            reviewReasons.push('invalid_profile_key');
        }
    }
    if (!profileInventoryAvailable) {
        profile = null;
        requiresReview = true;
        reviewReasons.push('profile_inventory_unavailable');
    } else if (!profile || !profileKeys.has(profile)) {
        requiresReview = true;
        reviewReasons.push('profile_missing');
    }
    if (requiresReview && automationMode !== 'human') automationMode = 'off';

    return { disposition: 'imported', targetId, control: { accessPolicy, automationMode, lifecycle: 'open',
        ownerId: null, takenAt, handoffReason, requiresReview, reviewReasons: [...new Set(reviewReasons)], profileKey: profile } };
}

function automationBlockedByPolicy(conversation, globalMode) {
    if (!conversation || typeof conversation !== 'object') return false;
    const accessPolicy = conversation.access_policy ?? conversation.accessPolicy;
    const automationMode = conversation.automation_mode ?? conversation.automationMode;
    const lifecycle = conversation.lifecycle;
    const requiresReview = conversation.requires_review === 1 || conversation.requiresReview === true;
    if (requiresReview || lifecycle !== 'open' || automationMode === 'human' || accessPolicy === 'ignored') return true;
    if (accessPolicy === 'allowed') return automationMode !== 'ai';
    if (accessPolicy === 'neutral') return globalMode !== 'allowed_all' || automationMode !== 'ai';
    return false;
}

function ambiguousQuarantineDecision(entries, conversations, globalMode, requested) {
    if (!requested) return null;
    const quarantined = entries.filter(entry => entry.disposition === 'quarantined');
    const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
    const allAmbiguous = quarantined.length > 0 && quarantined.every(entry => entry.reason === 'identity_ambiguous'
        && Array.isArray(entry.candidateTargetIds) && entry.candidateTargetIds.length > 0);
    const targetIds = [...new Set(quarantined.flatMap(entry => entry.candidateTargetIds || []))];
    const targetsBlocked = allAmbiguous && targetIds.length > 0
        && targetIds.every(id => automationBlockedByPolicy(byId.get(id), globalMode));
    const applied = globalMode === 'ignored_all' && allAmbiguous && targetsBlocked;
    return {
        decision: applied ? 'keep_blocked' : 'blocked',
        requested: true,
        applied,
        quarantinedCount: quarantined.length,
        candidateConversationCount: targetIds.length,
        globalMode,
        controlsChanged: 0,
        ...(applied ? { reason: 'ambiguous_targets_already_inactive_under_ignored_all' }
            : { reason: globalMode !== 'ignored_all' ? 'global_mode_must_be_ignored_all'
                : !allAmbiguous ? 'only_identity_ambiguous_records_can_be_preserved'
                    : 'candidate_conversation_not_proven_inactive' })
    };
}

function buildControlImportReport(input) {
    if (!isRecord(input?.contacts) || !isRecord(input?.settings)) fail('INVALID_IMPORT_SOURCE');
    if (!Array.isArray(input.conversations)) fail('INVALID_CONVERSATION_SNAPSHOT');
    if (input.excludeContactsWithoutConversation !== undefined && typeof input.excludeContactsWithoutConversation !== 'boolean') {
        fail('INVALID_EXCLUSION_DECISION');
    }
    const profileInventoryAvailable = Array.isArray(input.profileKeys);
    const profileKeys = profileInventoryAvailable ? new Set(input.profileKeys.filter(safeProfileKey)) : null;
    const entries = [];
    const blockers = [];
    const manifest = input.sourceManifest || {};
    if (manifest.contacts?.present === false) blockers.push({ code: 'contacts_source_missing' });
    else if (manifest.contacts?.present !== true || !/^[0-9a-f]{64}$/.test(manifest.contacts?.sha256 || '')) {
        blockers.push({ code: 'contacts_checksum_missing' });
    }
    if (manifest.settings?.present === false) blockers.push({ code: 'settings_source_missing' });
    else if (manifest.settings?.present !== true || !/^[0-9a-f]{64}$/.test(manifest.settings?.sha256 || '')) {
        blockers.push({ code: 'settings_checksum_missing' });
    }
    if (!isRecord(input.archive) || ![6, 7, 8, 9, 10, 11, 12, 13].includes(input.archive.schemaVersion) || typeof input.archive.dataEpoch !== 'string'
        || !/^(0|[1-9][0-9]*)$/.test(input.archive.seq || '')) blockers.push({ code: 'archive_snapshot_invalid' });
    if (!profileInventoryAvailable) blockers.push({ code: 'profile_inventory_unavailable' });

    let globalMode = 'ignored_all';
    let globalModeSource = 'application_default';
    if (hasOwn(input.settings, 'globalMode')) {
        const raw = input.settings.globalMode;
        if (VALID_GLOBAL_MODES.has(raw)) {
            globalMode = raw;
            globalModeSource = 'settings:globalMode';
            entries.push({ sourceKey: sourceKey('settings', 'globalMode'), source: 'settings', field: 'globalMode',
                sourceChecksum: recordChecksum(raw), disposition: 'imported', plannedValue: raw });
        } else {
            entries.push({ sourceKey: sourceKey('settings', 'globalMode'), source: 'settings', field: 'globalMode',
                sourceChecksum: recordChecksum(raw), disposition: 'quarantined', reason: 'invalid_global_mode' });
            blockers.push({ code: 'global_mode_invalid' });
        }
    } else {
        entries.push({ sourceKey: sourceKey('settings', 'globalMode'), source: 'settings_default', field: 'globalMode',
            sourceChecksum: recordChecksum(globalMode), disposition: 'imported', plannedValue: globalMode });
    }
    const globalProfile = globalProfilePlan(input.settings, profileKeys, entries, blockers);
    const index = identityIndex(input.conversations);
    const contactEntries = [];
    const candidateLegacyControlStateCounts = { allowed: 0, ignored: 0, handoff: 0, neutral: 0, unknown: 0 };
    for (const key of Object.keys(input.contacts).sort()) {
        const plan = contactPlan(key, input.contacts[key], globalMode, globalProfile.value,
            profileKeys, profileInventoryAvailable, index, input.excludeContactsWithoutConversation === true);
        contactEntries.push({ sourceKey: sourceKey('contact', key), source: 'contact', sourceChecksum: recordChecksum(input.contacts[key]), disposition: plan.disposition,
            identityHint: contactIdentityHint(key, input.contacts[key]),
            ...(plan.reason ? { reason: plan.reason } : {}), ...(plan.targetId ? { targetId: plan.targetId } : {}),
            ...(plan.decision ? { decision: plan.decision } : {}),
            ...(plan.candidateTargetIds ? { candidateTargetIds: plan.candidateTargetIds } : {}),
            ...(plan.control ? { control: plan.control } : {}) });
        if (plan.reason === 'no_conversation_target') {
            const state = input.contacts[key]?.estado;
            if (state === 'permitido') candidateLegacyControlStateCounts.allowed += 1;
            else if (state === 'ignorado') candidateLegacyControlStateCounts.ignored += 1;
            else if (state === 'handoff') candidateLegacyControlStateCounts.handoff += 1;
            else if (state === undefined || state === null || state === 'neutro') candidateLegacyControlStateCounts.neutral += 1;
            else candidateLegacyControlStateCounts.unknown += 1;
        }
    }

    const byTarget = new Map();
    for (const entry of contactEntries) {
        if (entry.disposition !== 'imported') continue;
        const group = byTarget.get(entry.targetId) || [];
        group.push(entry);
        byTarget.set(entry.targetId, group);
    }
    for (const group of byTarget.values()) {
        if (group.length < 2) continue;
        const intents = new Set(group.map(entry => JSON.stringify(entry.control)));
        if (intents.size > 1) {
            for (const entry of group) {
                entry.disposition = 'quarantined';
                entry.reason = 'conflicting_legacy_rules';
            }
            blockers.push({ code: 'conflicting_legacy_rules', count: group.length });
        } else {
            for (const entry of group) entry.coalescedWithExactIdentity = group.length - 1;
        }
    }
    entries.push(...contactEntries);

    const counts = { sourceRecords: entries.length, imported: 0, quarantined: 0, excluded: 0, requiresReview: 0 };
    for (const entry of entries) {
        counts[entry.disposition] += 1;
        if (entry.control?.requiresReview) counts.requiresReview += 1;
    }
    if (counts.quarantined) blockers.push({ code: 'source_records_quarantined', count: counts.quarantined });
    if (counts.requiresReview) blockers.push({ code: 'records_require_review', count: counts.requiresReview });
    const blockerMap = new Map();
    for (const blocker of blockers) {
        const previous = blockerMap.get(blocker.code);
        if (!previous) blockerMap.set(blocker.code, { ...blocker });
        else if (previous.count !== undefined || blocker.count !== undefined) {
            previous.count = (previous.count || 1) + (blocker.count || 1);
        }
    }
    let uniqueBlockers = [...blockerMap.values()];
    const quarantineDecision = ambiguousQuarantineDecision(entries, input.conversations, globalMode,
        input.preserveAmbiguousQuarantine === true);
    if (quarantineDecision?.applied) {
        uniqueBlockers = uniqueBlockers.filter(blocker => blocker.code !== 'source_records_quarantined');
    }
    const cutoverAllowed = uniqueBlockers.length === 0;
    const sourceManifest = {
        ...manifest,
        contacts: { ...manifest.contacts, sourceRecordCount: Object.keys(input.contacts).length },
        settings: { ...manifest.settings, sourceRecordCount: ['globalMode','currentProfile'].filter(key => hasOwn(input.settings, key)).length,
            plannedRecordCount: 2 },
        profileInventory: { available: profileInventoryAvailable, count: profileKeys?.size ?? 0,
            sha256: profileKeys ? sha256([...profileKeys].sort().join('\n')) : null },
        archive: input.archive || null
    };
    return {
        schemaVersion: 1,
        dryRun: true,
        generatedAt: input.generatedAt || new Date().toISOString(),
        status: !cutoverAllowed ? 'review_required' : quarantineDecision?.applied ? 'ready_with_quarantines' : 'ready',
        cutoverAllowed,
        sourceManifest,
        globalPolicy: { globalMode, globalModeSource, globalProfile: globalProfile.value,
            globalProfileSource: globalProfile.source, globalPausedDuringCutover: true,
            legacyPausePersisted: false },
        ...(quarantineDecision ? { quarantineDecision } : {}),
        settingsOutOfScopeKeyCount: Object.keys(input.settings).filter(key => !['globalMode','currentProfile'].includes(key)).length,
        ...(input.excludeContactsWithoutConversation ? { exclusions: {
            noConversationTarget: {
                decision: 'exclude',
                candidateCount: Object.values(candidateLegacyControlStateCounts).reduce((sum, count) => sum + count, 0),
                excludedCount: Object.values(candidateLegacyControlStateCounts).reduce((sum, count) => sum + count, 0),
                blockedCount: 0,
                definition: 'Contact phone/LID has no exact conversation identity in the archive snapshot.',
                candidateLegacyControlStateCounts
            }
        } } : {}),
        counts,
        blockers: uniqueBlockers,
        ...(quarantineDecision?.applied ? { warnings: [{ code: 'ambiguous_records_kept_blocked',
            count: quarantineDecision.quarantinedCount }] } : {}),
        entries: entries.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
    };
}

module.exports = { buildControlImportReport };
