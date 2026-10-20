// @ts-check
const { randomUUID } = require('node:crypto');

const LEGACY_ADMIN_ACTOR = '00000000-0000-4000-8000-000000000001';
const PHONE_SUFFIXES = ['@s.whatsapp.net'];
const LID_SUFFIXES = ['@lid'];

class ControlServiceError extends Error {
    /** @param {string} code @param {number} [status] */
    constructor(code, status = 409) {
        super(code);
        this.name = 'ControlServiceError';
        this.code = code;
        this.status = status;
    }
}

function fail(code, status) { throw new ControlServiceError(code, status); }

/** @param {any} archive @param {{drainConversation?: ((conversationId:string) => any) | null, onPolicyChanged?: (policy:any) => any,
 * validateProfile?: (profileKey:string) => boolean | Promise<boolean>}} [options] @returns {any} */
function createControlService(archive, { drainConversation = null, onPolicyChanged = () => {}, validateProfile = async () => false } = {}) {
    if (!archive || typeof archive.controlState !== 'function' || typeof archive.writeControlState !== 'function') {
        throw new TypeError('CONTROL_ARCHIVE_REQUIRED');
    }

    async function assertAuthority() {
        const authority = await archive.controlAuthority();
        if (authority.mode !== 'sqlite') fail('CONTROL_AUTHORITY_NOT_ACTIVE', 503);
        if (!authority.serviceReady) fail('CONTROL_SERVICE_NOT_READY', 503);
        return authority;
    }

    async function resolveLegacyTarget({ targetId, channel, accountId = null }) {
        if (!['whatsapp','telegram'].includes(channel)) fail('CONTROL_CHANNEL_REQUIRED', 422);
        const value = String(targetId ?? '').trim();
        if (!value) fail('INVALID_CONTROL_TARGET', 422);
        /** @type {Array<{accountId:string,channel:'whatsapp'|'telegram',kind:string,exactValue:string}>} */
        const candidates = [];
        const accounts = (await archive.accounts()).filter(account => account.channel === channel
            && (!accountId || account.id === accountId));
        for (const account of accounts) {
            if (channel === 'telegram') {
                const exact = value.startsWith('telegram:') ? value.slice('telegram:'.length) : value;
                if (!/^-?[1-9][0-9]*$/.test(exact)) fail('INVALID_CONTROL_TARGET', 422);
                candidates.push({ accountId: account.id, channel, kind: 'telegram_chat_id', exactValue: exact });
                continue;
            }
            if (value.includes('@')) {
                const suffix = value.slice(value.lastIndexOf('@')).toLowerCase();
                if (PHONE_SUFFIXES.includes(suffix)) candidates.push({ accountId: account.id, channel, kind: 'whatsapp_jid', exactValue: value });
                else if (LID_SUFFIXES.includes(suffix)) candidates.push({ accountId: account.id, channel, kind: 'whatsapp_lid', exactValue: value });
                continue;
            }
            if (!/^\+?[0-9][0-9 .()-]*$/.test(value)) fail('INVALID_CONTROL_TARGET', 422);
            const digits = value.replace(/\D/g, '');
            if (!digits) fail('INVALID_CONTROL_TARGET', 422);
            for (const suffix of PHONE_SUFFIXES) candidates.push({ accountId: account.id, channel,
                kind: 'whatsapp_jid', exactValue: `${digits}${suffix}` });
            for (const suffix of LID_SUFFIXES) candidates.push({ accountId: account.id, channel,
                kind: 'whatsapp_lid', exactValue: `${digits}${suffix}` });
        }
        if (!candidates.length) fail('CONTROL_TARGET_NOT_FOUND', 404);
        const targets = await archive.controlTargets({ channel, accountId, candidates });
        if (!targets.length) fail('CONTROL_TARGET_NOT_FOUND', 404);
        if (targets.length !== 1) fail('IDENTITY_AMBIGUOUS', 409);
        return targets[0];
    }

    async function writeState({ conversationId, actorId, expectedVersion, mutate }) {
        await assertAuthority();
        const current = await archive.controlState(conversationId);
        if (!current) fail('CONVERSATION_NOT_FOUND', 404);
        if (expectedVersion !== current.controlVersion) fail('CONTROL_VERSION_CONFLICT', 409);
        const next = mutate(current);
        const result = await archive.writeControlState({ conversationId, actorId, expectedVersion, state: next });
        if (result.status === 'missing') fail('CONVERSATION_NOT_FOUND', 404);
        if (result.status === 'conflict') fail('CONTROL_VERSION_CONFLICT', 409);
        if (result.status === 'human_send_in_flight') fail('CONTROL_HUMAN_SEND_IN_FLIGHT', 409);
        if (result.status === 'updated' && current.automationMode === 'ai' && drainConversation) {
            await drainConversation(conversationId);
        }
        return result;
    }

    async function assertProfile(profileKey) {
        if (profileKey === null) return;
        if (typeof profileKey !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(profileKey)) fail('INVALID_GLOBAL_PROFILE', 422);
        let available = false;
        try { available = await validateProfile(profileKey); } catch { /* unavailable profile inventory fails closed */ }
        if (!available) fail('PROFILE_NOT_FOUND', 422);
    }

    function profileReviewCleared(current) {
        const reviewReasons = current.reviewReasons.filter(reason => !['invalid_profile_key','profile_inventory_unavailable','profile_missing'].includes(reason));
        return { reviewReasons, requiresReview: reviewReasons.length > 0 };
    }

    function generationEligible(control, policy) {
        if (!control || control.requiresReview || policy.requiresReview || control.lifecycle !== 'open'
            || control.automationMode === 'human' || control.accessPolicy === 'ignored') return false;
        if (control.accessPolicy === 'allowed') return control.automationMode === 'ai';
        return control.accessPolicy === 'neutral' && policy.globalMode === 'allowed_all';
    }

    async function continueTakeover(operation, control) {
        if (operation.status !== 'taking_control') return { status: 'confirmed', operation, control };
        if (!drainConversation) return { status: 'pending', operation, control };
        let drained;
        try { drained = drainConversation(operation.conversationId); }
        catch { return { status: 'pending', operation, control }; }
        if (drained && typeof drained.then === 'function') {
            Promise.resolve(drained).then(result => {
                if (result?.drained === false) return;
                return archive.completeControlTakeover({ operationId: operation.id,
                    uncertainMessageIds: result?.uncertainMessageIds || [] });
            }).catch(() => {});
            return { status: 'pending', operation, control };
        }
        if (drained?.drained === false) return { status: 'pending', operation, control };
        const completed = await archive.completeControlTakeover({ operationId: operation.id,
            uncertainMessageIds: drained?.uncertainMessageIds || [] });
        if (completed.status === 'missing') fail('CONTROL_OPERATION_MISSING', 404);
        return { status: 'confirmed', operation: completed.operation, control: completed.control };
    }

    return {
        legacyAdminActor: LEGACY_ADMIN_ACTOR,
        async authority() { return archive.controlAuthority(); },
        async isActive() { return (await archive.controlAuthority()).mode === 'sqlite'; },
        async setServiceReady(ready) { return archive.setControlServiceReady({ ready }); },
        resolveLegacyTarget: input => resolveLegacyTarget(input),
        async clearContextForLegacyTarget({ targetId, channel, accountId = null, actorId = LEGACY_ADMIN_ACTOR }) {
            await assertAuthority();
            const target = await resolveLegacyTarget({ targetId, channel, accountId });
            const result = await archive.clearAIContext({ conversationId: target.conversationId, actorId,
                expectedContextVersion: target.control.contextVersion });
            if (result.status === 'missing') fail('CONVERSATION_NOT_FOUND', 404);
            if (result.status === 'conflict') fail('CONTEXT_VERSION_CONFLICT', 409);
            if (result.status === 'updated' && drainConversation) await drainConversation(target.conversationId);
            return { ...result, target };
        },
        async readForIdentity(identity) {
            const authority = await archive.controlAuthority();
            if (authority.mode !== 'sqlite') return { authority: authority.mode, target: null };
            if (!authority.serviceReady) fail('CONTROL_SERVICE_NOT_READY', 503);
            const target = await archive.controlByIdentity(identity);
            const policy = await archive.controlPolicy();
            const controlSnapshot = target ? { conversationId: target.conversationId,
                controlVersion: target.control.controlVersion, contextVersion: target.control.contextVersion,
                policyVersion: policy.policyVersion } : null;
            return { authority: 'sqlite', target, controlSnapshot };
        },
        async isSnapshotCurrent(expected) {
            if (!expected || typeof expected.conversationId !== 'string') return false;
            try { await assertAuthority(); } catch { return false; }
            const control = await archive.controlState(expected.conversationId);
            const policy = await archive.controlPolicy();
            return control?.controlVersion === expected.controlVersion
                && control?.contextVersion === expected.contextVersion
                && policy.policyVersion === expected.policyVersion
                && generationEligible(control, policy);
        },
        async updateConversation({ conversationId, actorId, expectedVersion, lifecycle, accessPolicy, profileKey }) {
            if (profileKey !== undefined) await assertProfile(profileKey);
            return writeState({ conversationId, actorId, expectedVersion, mutate: current => ({
                ...current,
                ...(lifecycle === undefined ? {} : { lifecycle }),
                ...(accessPolicy === undefined ? {} : { accessPolicy,
                    automationMode: accessPolicy === 'ignored' ? 'off' : current.automationMode === 'off' ? 'ai' : current.automationMode,
                    ownerId: accessPolicy === 'ignored' ? null : current.ownerId,
                    takenAt: accessPolicy === 'ignored' ? null : current.takenAt,
                    handoffReason: accessPolicy === 'ignored' ? null : current.handoffReason }),
                ...(profileKey === undefined ? {} : { profileKey, ...profileReviewCleared(current) })
            }) });
        },
        async takeover({ conversationId, actorId, expectedVersion, overrideOwner = false, idempotencyKey = randomUUID() }) {
            await assertAuthority();
            const result = await archive.beginControlTakeover({ conversationId, actorId, expectedVersion, overrideOwner, idempotencyKey });
            if (result.status === 'missing') fail('CONVERSATION_NOT_FOUND', 404);
            if (result.status === 'conflict') fail('CONTROL_VERSION_CONFLICT', 409);
            if (result.status === 'owner_conflict') fail('CONTROL_OWNER_CONFLICT', 409);
            if (result.status === 'send_in_flight') fail('CONTROL_HUMAN_SEND_IN_FLIGHT', 409);
            return continueTakeover(result.operation, result.control);
        },
        async release({ conversationId, actorId, expectedVersion, overrideOwner = false }) {
            return writeState({ conversationId, actorId, expectedVersion, mutate: current => {
                if (current.ownerId && current.ownerId !== actorId && !overrideOwner) fail('CONTROL_OWNER_CONFLICT', 409);
                return { ...current, automationMode: 'ai', ownerId: null, status: 'confirmed',
                    takenAt: null, handoffReason: null };
            } });
        },
        async operation(operationId) {
            await assertAuthority();
            return archive.controlOperation(operationId);
        },
        async recoverPendingOperations() {
            const pending = await archive.pendingControlOperations();
            for (const operation of pending) {
                const control = await archive.controlState(operation.conversationId);
                await continueTakeover(operation, control);
            }
            return { recovered: pending.length };
        },
        async setAccessForLegacyTarget({ targetId, channel, accountId = null, policy, actorId = LEGACY_ADMIN_ACTOR }) {
            const target = await resolveLegacyTarget({ targetId, channel, accountId });
            const state = target.control;
            const accessPolicy = policy;
            const automationMode = accessPolicy === 'ignored' ? 'off' : 'ai';
            const result = await writeState({ conversationId: target.conversationId, actorId,
                expectedVersion: state.controlVersion, mutate: current => ({ ...current, accessPolicy, automationMode,
                    ownerId: null, status: 'confirmed', takenAt: null, handoffReason: null }) });
            return { ...result, target };
        },
        async setLegacyControl({ targetId, channel, accountId = null, action, actorId = LEGACY_ADMIN_ACTOR, reason = 'operator' }) {
            const target = await resolveLegacyTarget({ targetId, channel, accountId });
            if (action === 'takeover') {
                const result = await this.takeover({ conversationId: target.conversationId, actorId,
                    expectedVersion: target.control.controlVersion, overrideOwner: true });
                return { ...result, target };
            }
            if (action === 'customer_handoff') {
                const result = await writeState({ conversationId: target.conversationId, actorId,
                    expectedVersion: target.control.controlVersion, mutate: current => ({ ...current,
                        automationMode: 'human', ownerId: null, status: 'confirmed',
                        takenAt: current.takenAt || new Date().toISOString(), handoffReason: reason }) });
                return { ...result, target };
            }
            if (action === 'release') {
                const result = await this.release({ conversationId: target.conversationId, actorId,
                    expectedVersion: target.control.controlVersion, overrideOwner: true });
                return { ...result, target };
            }
            fail('INVALID_CONTROL_ACTION', 422);
        },
        async setProfileForLegacyTarget({ targetId, channel, accountId = null, profileKey, actorId = LEGACY_ADMIN_ACTOR }) {
            await assertProfile(profileKey);
            const target = await resolveLegacyTarget({ targetId, channel, accountId });
            const result = await writeState({ conversationId: target.conversationId, actorId,
                expectedVersion: target.control.controlVersion, mutate: current => ({ ...current, profileKey, ...profileReviewCleared(current) }) });
            return { ...result, target };
        },
        async setGlobalPolicy({ globalMode, globalProfileKey, actorId = LEGACY_ADMIN_ACTOR }) {
            await assertAuthority();
            if (globalProfileKey !== undefined) await assertProfile(globalProfileKey);
            const current = await archive.controlPolicy();
            const result = await archive.writeControlPolicy({ actorId, expectedVersion: current.policyVersion,
                globalMode: globalMode ?? current.globalMode,
                globalProfileKey: globalProfileKey === undefined ? current.globalProfileKey : globalProfileKey });
            if (result.status === 'conflict') fail('POLICY_VERSION_CONFLICT', 409);
            if (result.status === 'updated') await onPolicyChanged(result.policy);
            return result;
        },
        async refreshPolicy() {
            await assertAuthority();
            const policy = await archive.controlPolicy();
            await onPolicyChanged(policy);
            return policy;
        },
        async projectStateForLegacyTarget(targetId, stateType, context = {}) {
            if (!['allowed','ignored','neutral','handoff'].includes(stateType)) fail('INVALID_CONTROL_STATE', 422);
            if (stateType === 'handoff') return this.setLegacyControl({ ...context, targetId,
                action: ['customer_request','external_self'].includes(context.reason) ? 'customer_handoff' : 'takeover',
                reason: context.reason || 'operator' });
            const policy = stateType === 'allowed' ? 'allowed' : stateType === 'ignored' ? 'ignored' : 'neutral';
            return this.setAccessForLegacyTarget({ ...context, targetId, policy });
        }
    };
}

module.exports = { createControlService, ControlServiceError, LEGACY_ADMIN_ACTOR };
