import type { Contract } from '@sdk-bot/contracts';
export interface ArchiveInput {
    identity: Contract<'IdentityKey'>;
    providerMessageId: string | null;
    source: 'live' | 'history' | 'import';
    direction: 'inbound' | 'outbound';
    authorKind: Contract<'Message'>['authorKind'];
    occurredAt: string;
    content: Contract<'MessageContent'>;
}
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
export interface Archive {
    ready: Promise<Contract<'EventCursor'> & { schemaVersion: number; journalMode: string; synchronous: number; threadId: number }>;
    snapshot(): Promise<Contract<'EventCursor'>>;
    registerAccount(input: { id?: string; channel: 'whatsapp' | 'telegram'; providerKey: string }): Promise<{ id: string; channel: string; provider_key: string }>;
    telegramCursor(accountId: string): Promise<string | null>;
    captureTelegramBatch(input: { accountId: string; updates: Array<{ updateId: string; message: ArchiveInput | null }> }): Promise<{
        lastUpdateId: string | null;
        results: Array<{ updateId: string; status: 'stale' | 'excluded' | IngestResult['status']; result?: IngestResult }>;
    }>;
    resolve(identity: Contract<'IdentityKey'>): Promise<ArchiveIdentity>;
    bindAlias(input: { canonical: Contract<'IdentityKey'>; alias: Contract<'IdentityKey'>; evidence: { kind: 'adapter' | 'admin'; reference: string } }): Promise<{ status: 'linked' | 'existing'; identity: ArchiveIdentity } | { status: 'quarantined'; quarantineId: string }>;
    ingestBatch(input: ArchiveInput[]): Promise<IngestResult[]>;
    updateTranscription(input: { messageId: string; expectedStatus: 'not_requested' | 'pending'; status: 'pending' | 'completed' | 'failed'; transcript?: string | null }): Promise<
        { status: 'updated'; message: Contract<'Message'>; event: Contract<'Event'> } |
        { status: 'missing' | 'unchanged' }>;
    conversation(id: string): Promise<ArchiveConversation | null>;
    messages(input: { conversationId: string; limit?: number; before?: { occurredAt: string; id: string } }): Promise<Contract<'Message'>[]>;
    events(input?: { after?: string; limit?: number }): Promise<Contract<'Event'>[]>;
    diagnostics(): Promise<Contract<'EventCursor'> & { messages: number; events: number; quarantine: number; aliases: number; provenance: number; integrity: string; foreignKeys: number }>;
    purge(input?: { now?: string; limit?: number }): Promise<{ bodies: number; events: number; fingerprints: number; remaining: boolean }>;
    backup(destination: string): Promise<Contract<'EventCursor'>>;
    close(): Promise<void>;
    queue(): { elements: number; bytes: number };
}
/** restore=true only for an offline restored copy: purge before exposure, rotate epoch, discard prior event timeline. No control/outbox recovery exists yet. */
export function createArchive(options?: { path?: string; timeoutMs?: number; restore?: boolean }): Archive;
