import type { Contract } from '@sdk-bot/contracts';
export interface ArchiveInput {
    identity: Contract<'IdentityKey'>;
    providerMessageId: string | null;
    source: 'live' | 'history' | 'import' | 'panel' | 'automation';
    direction: 'inbound' | 'outbound';
    authorKind: Contract<'Message'>['authorKind'];
    actorId?: string | null;
    clientMessageId?: string | null;
    occurredAt: string;
    content: Contract<'MessageContent'>;
    replyToProviderMessageId?: string | null;
    replyPreview?: string;
    legacyDispatch?: {
        waitForTranscription: boolean;
        message: {
            channel: 'whatsapp' | 'telegram'; remoteId: string; rawId: string; text: string;
            transcript: string; isAudio: boolean;
            metadata: { pushName?: string | null; savedName?: string | null; phoneNumber?: string | null;
                lid?: string | null; isBusiness?: boolean; country?: string; isFromMe: false; isAdminChannel: false };
        };
    };
}
export interface PendingLegacyDispatch {
    messageId: string;
    status: 'pending';
    message: NonNullable<ArchiveInput['legacyDispatch']>['message'];
    attempts: number;
    lastError: string | null;
}
export interface PendingResumeMessages extends Contract<'PendingResumeResponse'> {}
export type IngestResult =
    | { status: 'created'; message: Contract<'Message'>; event: Contract<'Event'> }
    | { status: 'duplicate'; messageId: string; conversationId: string }
    | { status: 'quarantined'; quarantineId: string };
export interface ArchiveConversation {
    id: string; account_id: string; contact_id: string; canonical_id: string;
    aggregate_version: string; inbound_seq: string;
    last_activity_at: string | null; capturing_since: string | null;
    history_observed: 0 | 1; requires_review: 0 | 1;
}
export interface ArchiveIdentity {
    id: string; account_id: string; channel: 'whatsapp' | 'telegram';
    kind: Contract<'IdentityKey'>['kind']; exact_value: string;
    canonical_id: string; conversation_id: string;
}
export interface ControlImportReport {
    schemaVersion: 1; dryRun: true; status: string; cutoverAllowed: boolean;
    sourceManifest: Record<string, unknown>; counts: Record<string, number>;
    exclusions?: { noConversationTarget: { decision: 'exclude'; candidateCount: number; excludedCount: number;
        blockedCount: number; definition: string;
        candidateLegacyControlStateCounts: Record<'allowed' | 'ignored' | 'handoff' | 'neutral' | 'unknown', number> } };
    blockers: Array<{ code: string; count?: number }>;
    entries: Array<Record<string, unknown>>; [key: string]: unknown;
}
export type ControlImportReportSummary = Omit<ControlImportReport, 'entries'> & { entryCount: number };
export interface ControlImportStatus {
    migrationId: string; status: string; baseEpoch: string; baseSeq: string; latestRunId: string | null;
    run: { id: string; reportSha256: string; archiveEpoch: string; archiveSeq: string; status: string; report: ControlImportReportSummary } | null;
    startedAt: string; updatedAt: string; cutoverAt: string | null;
}
export interface ControlTarget {
    conversationId: string; accountId: string; channel: 'whatsapp' | 'telegram';
    identities: Array<{ kind: string; exactValue: string }>; control: Contract<'ConversationControl'>;
}
export interface ControlOperation extends Contract<'Operation'> {}
export interface OutboundIntent {
    id: string; idempotencyKey: string; requestFingerprint: string; accountId: string | null;
    conversationId: string | null; channel: 'whatsapp' | 'telegram'; destination: string; actorId: string;
    source: 'human' | 'ai' | 'notice' | 'campaign' | 'command' | 'system'; payload: Record<string, unknown>;
    controlSnapshot: { conversationId: string; controlVersion: string; contextVersion: string; policyVersion: string } | null;
    policy: Record<string, unknown> | null; state: 'intent' | 'sending' | 'accepted' | 'rejected' | 'delivery_unknown';
    providerMessageId: string | null; providerResult: unknown | null; errorCode: string | null;
    reconciliationNote: string | null; reconciledBy: string | null; reconciledAt: string | null;
    createdAt: string; updatedAt: string; sendingAt: string | null; completedAt: string | null;
}
export interface ArchiveAttachment {
    id: string; messageId: string; conversationId: string; fileName: string; contentType: string;
    size: number; sha256: string; capturedAt: string; expiresAt: string;
}
export interface ControlPolicy {
    globalMode: 'allowed_all' | 'ignored_all'; globalProfileKey: string | null; policyVersion: string;
    requiresReview: boolean; reviewReason: string | null;
}
export interface Archive {
    ready: Promise<Contract<'EventCursor'> & { schemaVersion: number; journalMode: string; synchronous: number; threadId: number; readOnly?: boolean }>;
    snapshot(): Promise<Contract<'EventCursor'>>;
    recoveryCheckpoint(): Promise<Contract<'EventCursor'> & { schemaVersion: number;
        controlAuthority: { mode: 'legacy' | 'sqlite'; migrationId: string | null; serviceReady: boolean; changedAt: string | null };
        outboundIntentCount: number; outboundIntentSha256: string; unresolvedOutboundCount: number;
        attachmentCount: number; attachmentSha256: string;
        searchIndexCount: number; searchIndexSha256: string; searchIndexMismatchCount: number;
        integrity: string; foreignKeys: number }>;
    registerAccount(input: { id?: string; channel: 'whatsapp' | 'telegram'; providerKey: string }): Promise<{ id: string; channel: string; provider_key: string }>;
    telegramCursor(accountId: string): Promise<string | null>;
    captureTelegramBatch(input: { accountId: string; updates: Array<{ updateId: string; message: ArchiveInput | null;
        edit?: { identity: Contract<'IdentityKey'>; providerMessageId: string; content: Contract<'MessageContent'>;
            editedAt: string; replyToProviderMessageId?: string | null; replyPreview?: string } | null }> }): Promise<{
        lastUpdateId: string | null;
        results: Array<{ updateId: string; status: string; result?: IngestResult | { status: string;
            message?: Contract<'Message'>; event?: Contract<'Event'>; replacedAttachmentId?: string | null;
            captureAttachment?: boolean } }>;
    }>;
    resolve(identity: Contract<'IdentityKey'>): Promise<ArchiveIdentity>;
    bindAlias(input: { canonical: Contract<'IdentityKey'>; alias: Contract<'IdentityKey'>; evidence: { kind: 'adapter' | 'admin'; reference: string } }): Promise<{ status: 'linked' | 'existing'; identity: ArchiveIdentity } | { status: 'quarantined'; quarantineId: string }>;
    ingestBatch(input: ArchiveInput[]): Promise<IngestResult[]>;
    updateTranscription(input: { messageId: string; expectedStatus: 'not_requested' | 'pending'; status: 'pending' | 'completed' | 'failed'; transcript?: string | null }): Promise<
        { status: 'updated'; message: Contract<'Message'>; event: Contract<'Event'> } |
        { status: 'missing' | 'unchanged' }>;
    editProviderMessage(input: { identity: Contract<'IdentityKey'>; providerMessageId: string;
        content: Contract<'MessageContent'>; editedAt: string; replyToProviderMessageId?: string | null; replyPreview?: string }): Promise<{
        status: 'updated' | 'missing' | 'unchanged' | 'deleted'; message?: Contract<'Message'>;
        event?: Contract<'Event'>; replacedAttachmentId?: string | null; captureAttachment?: boolean }>;
    deleteProviderMessage(input: { identity: Contract<'IdentityKey'>; providerMessageId: string; deletedAt?: string }): Promise<{
        status: 'deleted' | 'missing' | 'unchanged'; message?: Contract<'Message'>;
        event?: Contract<'Event'>; attachmentId?: string | null }>;
    markAttachmentCaptureFailed(input: { messageId: string }): Promise<{ status: 'updated' | 'missing' | 'unchanged';
        message?: Contract<'Message'>; event?: Contract<'Event'> }>;
    pendingLegacyDispatches(input?: { limit?: number }): Promise<PendingLegacyDispatch[]>;
    pendingResumeMessages(input: { conversationId: string }): Promise<PendingResumeMessages | null>;
    shouldProcessArchivedInbound(input: { messageId: string }): Promise<boolean>;
    markLegacyDispatched(input: { messageId: string }): Promise<{ status: 'dispatched' | 'pending' | 'waiting' | 'skipped' | 'missing' }>;
    retryLegacyDispatch(input: { messageId: string; code?: string }): Promise<{ status: 'pending' | 'waiting' | 'dispatched' | 'skipped' | 'missing' }>;
    beginOutboundIntent(input: { idempotencyKey: string; accountId?: string | null; conversationId?: string | null;
        channel: 'whatsapp' | 'telegram'; destination: string; actorId: string;
        source: OutboundIntent['source']; payload: Record<string, unknown>;
        controlSnapshot?: OutboundIntent['controlSnapshot']; policy?: Record<string, unknown> | null }):
        Promise<{ status: 'created' | 'existing'; intent: OutboundIntent }>;
    claimOutboundIntent(input: { idempotencyKey: string }): Promise<
        { status: 'claimed' | 'intent' | 'sending' | 'accepted' | 'rejected' | 'delivery_unknown'; intent: OutboundIntent | null; errorCode?: string }>;
    finishOutboundIntent(input: { idempotencyKey: string; state: 'accepted' | 'rejected' | 'delivery_unknown';
        providerMessageId?: string | null; providerResult?: unknown; errorCode?: string | null }): Promise<OutboundIntent>;
    outboundIntent(idempotencyKey: string): Promise<OutboundIntent | null>;
    outboundIntents(input?: { conversationId?: string; state?: OutboundIntent['state'];
        after?: { createdAt: string; id: string }; limit?: number }): Promise<OutboundIntent[]>;
    reconcileOutboundIntent(input: { idempotencyKey: string; actorId: string; state: 'accepted' | 'rejected';
        note: string; providerMessageId?: string | null }): Promise<{ status: 'reconciled' | 'existing'; intent: OutboundIntent }>;
    controlState(conversationId: string): Promise<Contract<'ConversationControl'> | null>;
    clearAIContext(input: { conversationId: string; actorId: string; expectedContextVersion: Contract<'Version'> }): Promise<
        { status: 'updated'; contextVersion: Contract<'Version'>; throughMessageId: string | null; event: Contract<'Event'> } |
        { status: 'conflict'; control: Contract<'ConversationControl'> } | { status: 'missing' }>;
    writeControlState(input: { conversationId: string; actorId: string; expectedVersion: Contract<'Version'>;
        state: Omit<Contract<'ConversationControl'>, 'controlVersion' | 'contextVersion'> }): Promise<
        { status: 'updated'; control: Contract<'ConversationControl'>; event: Contract<'Event'> } |
        { status: 'conflict' | 'unchanged' | 'human_send_in_flight'; control: Contract<'ConversationControl'> } |
        { status: 'missing' }>;
    releaseControl(input: { conversationId: string; actorId: string; expectedVersion: Contract<'Version'>;
        overrideOwner: boolean; resumePolicy?: 'future_only' | 'process_pending'; pendingInboundIds?: string[]; selectionVersion?: string }): Promise<
        { status: 'updated'; control: Contract<'ConversationControl'>; event: Contract<'Event'>; resumedMessageIds: string[] } |
        { status: 'conflict' | 'owner_conflict' | 'human_send_in_flight' | 'selection_stale' | 'message_not_eligible' | 'resume_unavailable'; control: Contract<'ConversationControl'> } |
        { status: 'missing' }>;
    beginControlTakeover(input: { conversationId: string; actorId: string; expectedVersion: Contract<'Version'>;
        overrideOwner: boolean; idempotencyKey: string }): Promise<
        { status: 'started' | 'existing'; operation: ControlOperation; control: Contract<'ConversationControl'>; events?: Contract<'Event'>[] } |
        { status: 'send_in_flight'; control: Contract<'ConversationControl'> } |
        { status: 'conflict' | 'owner_conflict'; control: Contract<'ConversationControl'> } | { status: 'missing' }>;
    completeControlTakeover(input: { operationId: string; uncertainMessageIds?: string[] }): Promise<
        { status: 'completed' | 'unchanged'; operation: ControlOperation; control: Contract<'ConversationControl'>; events?: Contract<'Event'>[] } |
        { status: 'missing' }>;
    controlOperation(id: string): Promise<ControlOperation | null>;
    pendingControlOperations(): Promise<ControlOperation[]>;
    controlTargets(input: { channel: 'whatsapp' | 'telegram'; accountId?: string | null;
        candidates: Contract<'IdentityKey'>[] }): Promise<ControlTarget[]>;
    controlByIdentity(identity: Contract<'IdentityKey'>): Promise<{
        conversationId: string; accountId: string; channel: 'whatsapp' | 'telegram'; control: Contract<'ConversationControl'>;
    } | null>;
    controlPolicy(): Promise<ControlPolicy>;
    writeControlPolicy(input: { actorId: string; expectedVersion: Contract<'Version'>;
        globalMode: 'allowed_all' | 'ignored_all'; globalProfileKey: string | null }): Promise<
        { status: 'updated' | 'unchanged'; policy: ControlPolicy; event?: Contract<'Event'> } |
        { status: 'conflict'; policy: ControlPolicy }>;
    controlAuthority(): Promise<{ mode: 'legacy' | 'sqlite'; migrationId: string | null; serviceReady: boolean; changedAt: string | null }>;
    controlImportStatus(migrationId?: string): Promise<ControlImportStatus | null>;
    controlImportEntries(input: { runId: string; afterSourceKey?: string; limit?: number }): Promise<ControlImportReport['entries']>;
    beginControlImport(input: { migrationId: string; report: ControlImportReport; decisions?: {
        acceptSourceRemovals?: boolean; acceptIdentityChanges?: boolean;
    } }): Promise<{
        migrationId: string; runId: string; status: string; report: ControlImportReportSummary; resumed: boolean;
    }>;
    stageControlImportBatch(input: { runId: string; offset: number; limit?: number }): Promise<{ staged: number; batchCount: number }>;
    verifyControlImport(input: { runId: string }): Promise<{ status: string; report: ControlImportReportSummary }>;
    setControlServiceReady(input: { ready: boolean }): Promise<{ mode: 'legacy' | 'sqlite'; migrationId: string | null; serviceReady: boolean; changedAt: string | null }>;
    startControlCutover(input: { migrationId: string }): Promise<{ status: string; runId: string }>;
    applyControlCutoverBatch(input: { migrationId: string; limit?: number }): Promise<{
        status: string; applied: number; remaining: number; events: Contract<'Event'>[];
    }>;
    finishControlCutover(input: { migrationId: string }): Promise<{
        status: string; authority: { mode: 'legacy' | 'sqlite'; migrationId: string | null; serviceReady: boolean; changedAt: string | null };
        snapshot: Contract<'EventCursor'>;
    }>;
    rollbackControlCutoverBatch(input: { migrationId: string; limit?: number }): Promise<{
        status: string; rolledBack: number; remaining: number; events: Contract<'Event'>[];
    }>;
    finishControlRollback(input: { migrationId: string }): Promise<{ status: string; migrationId: string; latestRunId: string; authority: {
        mode: 'legacy' | 'sqlite'; migrationId: string | null; serviceReady: boolean; changedAt: string | null;
    } }>;
    conversation(id: string): Promise<ArchiveConversation | null>;
    conversations(input?: { limit?: number; before?: { lastActivityAt: string; id: string } }): Promise<ArchiveConversation[]>;
    conversationRows(input?: { actorId?: string; accountId?: string; channel?: 'whatsapp' | 'telegram'; limit?: number;
        before?: { lastActivityAt: string | null; id: string } }): Promise<Array<ArchiveConversation & {
        channel: 'whatsapp' | 'telegram'; identity_keys: Array<{ kind: string; exactValue: string }>;
        first_ingested_at: string | null; unread_count: number;
    }>>;
    conversationView(input: { conversationId: string; actorId: string }): Promise<(ArchiveConversation & {
        channel: 'whatsapp' | 'telegram'; identity_keys: Array<{ kind: string; exactValue: string }>;
        first_ingested_at: string | null; unread_count: number;
    }) | null>;
    conversationAddress(input: { conversationId: string }): Promise<{
        accountId: string; channel: 'whatsapp' | 'telegram'; kind: string; exactValue: string;
    } | null>;
    accounts(): Promise<Array<{ id: string; channel: 'whatsapp' | 'telegram' }>>;
    summary(input: { from: string; to: string }): Promise<Contract<'SummaryResponse'>>;
    messages(input: { conversationId: string; limit?: number; before?: { occurredAt: string; id: string } }): Promise<Contract<'Message'>[]>;
    messagePage(input: { conversationId: string; limit?: number; before?: { occurredAt: string; id: string } }): Promise<{ items: Contract<'Message'>[]; hasMore: boolean }>;
    searchMessages(input: { conversationId: string; query: string; limit?: number;
        after?: { occurredAt: string; id: string }; expectedSnapshot?: Contract<'EventCursor'> }): Promise<{
        items: Contract<'MessageSearchHit'>[]; hasMore: boolean; snapshot: Contract<'EventCursor'>;
        nextPosition: { occurredAt: string; id: string } | null;
    }>;
    messageByProviderId(input: { conversationId: string; providerMessageId: string }): Promise<Contract<'Message'> | null>;
    attachmentTarget(input: { messageId: string }): Promise<{ messageId: string; conversationId: string;
        contentType: 'audio' | 'image' | 'video' | 'document'; ingestedAt: string; expiresAt: string } | null>;
    attachment(input: { id: string }): Promise<ArchiveAttachment | null>;
    attachmentRegistry(): Promise<Array<{ id: string; size: number; sha256: string; state: 'available' | 'delete_pending' }>>;
    registerAttachment(input: { id: string; messageId: string; fileName: string; contentType: string;
        size: number; sha256: string; capturedAt: string }): Promise<{ status: 'stored'; attachment: ArchiveAttachment;
        message: Contract<'Message'>; event: Contract<'Event'> }>;
    markAttachmentUnavailable(input: { id: string }): Promise<{ status: 'missing' | 'pending_delete';
        message?: Contract<'Message'>; event?: Contract<'Event'> }>;
    expireAttachment(input: { id: string; now?: string }): Promise<{ status: 'missing' | 'available' | 'pending_delete';
        message?: Contract<'Message'>; event?: Contract<'Event'> }>;
    pendingAttachmentDeletions(input?: { limit?: number }): Promise<string[]>;
    finishAttachmentDeletion(input: { id: string }): Promise<{ deleted: boolean }>;
    aiContext(input: { conversationId: string; expectedContextVersion?: Contract<'Version'>;
        throughMessageId?: string | null; excludeMessageIds?: string[]; excludeGenerationId?: string; limit?: number }): Promise<{
        conversationId: string; contextVersion: Contract<'Version'>; throughMessageId: string | null;
        messages: Contract<'Message'>[] } | null>;
    markRead(input: { conversationId: string; actorId: string; throughInboundSeq: string }): Promise<{ throughInboundSeq: string } | null>;
    events(input?: { after?: string; limit?: number }): Promise<Contract<'Event'>[]>;
    eventsPage(input?: { after?: string; through?: string; limit?: number }): Promise<{
        items: Contract<'Event'>[]; snapshot: Contract<'EventCursor'>; oldestSeq: string | null;
    }>;
    onEvent(listener: (event: Contract<'Event'>) => void): () => void;
    diagnostics(): Promise<Contract<'EventCursor'> & { messages: number; events: number; quarantine: number; aliases: number; provenance: number; legacyDispatchPending: number; legacyDispatchWaiting: number; integrity: string; foreignKeys: number }>;
    purge(input?: { now?: string; limit?: number }): Promise<{ bodies: number; events: number; fingerprints: number; remaining: boolean }>;
    backup(destination: string): Promise<Contract<'EventCursor'>>;
    close(): Promise<void>;
    queue(): { elements: number; bytes: number };
}
/** restore=true only for an offline restored copy: purge before exposure, rotate epoch, discard prior event timeline. */
export function createArchive(options?: { path?: string; timeoutMs?: number; restore?: boolean; readOnly?: boolean; controlRecovery?: boolean }): Archive;
