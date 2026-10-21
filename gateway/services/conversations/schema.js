// Control columns are durable staging state; JSON remains the read authority
// until the F5 import report and cutover have been verified.
module.exports = `
CREATE TABLE archive_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, seq TEXT NOT NULL CHECK(seq='0' OR (seq NOT GLOB '*[^0-9]*' AND substr(seq,1,1) BETWEEN '1' AND '9')));
CREATE TABLE accounts (id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK(channel IN ('whatsapp','telegram')),
 provider_key TEXT NOT NULL, UNIQUE(channel,provider_key), UNIQUE(id,channel));
CREATE TABLE contacts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id));
CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
 contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id), canonical_id TEXT NOT NULL UNIQUE REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED,
 aggregate_version TEXT NOT NULL DEFAULT '1' CHECK(aggregate_version NOT GLOB '*[^0-9]*' AND substr(aggregate_version,1,1) BETWEEN '1' AND '9'),
 access_policy TEXT NOT NULL DEFAULT 'neutral' CHECK(access_policy IN ('allowed','ignored','neutral')),
 automation_mode TEXT NOT NULL DEFAULT 'off' CHECK(automation_mode IN ('ai','human','off')),
 lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','resolved')),
 owner_id TEXT,
 control_version TEXT NOT NULL DEFAULT '1' CHECK(control_version NOT GLOB '*[^0-9]*' AND substr(control_version,1,1) BETWEEN '1' AND '9'),
 context_version TEXT NOT NULL DEFAULT '1' CHECK(context_version NOT GLOB '*[^0-9]*' AND substr(context_version,1,1) BETWEEN '1' AND '9'),
 control_status TEXT NOT NULL DEFAULT 'confirmed' CHECK(control_status IN ('confirmed','taking_control')),
 taken_at TEXT,
 handoff_reason TEXT CHECK(handoff_reason IS NULL OR handoff_reason IN ('operator','customer_request','external_self','legacy_import','identity_conflict')),
 inbound_seq TEXT NOT NULL DEFAULT '0' CHECK(inbound_seq='0' OR (inbound_seq NOT GLOB '*[^0-9]*' AND substr(inbound_seq,1,1) BETWEEN '1' AND '9')),
 last_activity_at TEXT, capturing_since TEXT, history_observed INTEGER NOT NULL DEFAULT 0,
 requires_review INTEGER NOT NULL DEFAULT 0 CHECK(requires_review IN (0,1)));
CREATE TABLE identities (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, channel TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('whatsapp_jid','whatsapp_lid','phone','telegram_chat_id')),
 exact_value TEXT NOT NULL COLLATE BINARY, canonical_id TEXT NOT NULL REFERENCES identities(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 FOREIGN KEY(account_id,channel) REFERENCES accounts(id,channel),
 UNIQUE(account_id,kind,exact_value));
CREATE TABLE aliases (identity_id TEXT PRIMARY KEY REFERENCES identities(id),
 canonical_id TEXT NOT NULL REFERENCES identities(id), evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('adapter','admin')),
 evidence_ref TEXT NOT NULL, verified_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, inbound_seq TEXT, source TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX messages_page ON messages(conversation_id,occurred_at,id);
CREATE INDEX messages_unread ON messages(conversation_id,inbound_seq) WHERE inbound_seq IS NOT NULL;
CREATE INDEX messages_retention ON messages(ingested_at,id);
CREATE TABLE fingerprints (account_id TEXT NOT NULL REFERENCES accounts(id),
 canonical_id TEXT NOT NULL REFERENCES identities(id), provider_id TEXT NOT NULL,
 message_id TEXT NOT NULL, digest TEXT NOT NULL, ingested_at TEXT NOT NULL,
 PRIMARY KEY(account_id,canonical_id,provider_id));
CREATE INDEX fingerprints_retention ON fingerprints(ingested_at);
CREATE TABLE telegram_cursors (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 last_update_id TEXT CHECK(last_update_id IS NULL OR last_update_id='0' OR
     (length(last_update_id)<=20 AND last_update_id NOT GLOB '*[^0-9]*' AND substr(last_update_id,1,1) BETWEEN '1' AND '9')),
 updated_at TEXT NOT NULL
);
CREATE TABLE provenance (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 identity_id TEXT NOT NULL REFERENCES identities(id), source TEXT NOT NULL,
 PRIMARY KEY(message_id,identity_id,source));
CREATE TABLE events (seq TEXT PRIMARY KEY CHECK(seq NOT GLOB '*[^0-9]*' AND substr(seq,1,1) BETWEEN '1' AND '9'), conversation_id TEXT REFERENCES conversations(id),
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, created_at TEXT NOT NULL, actor_id TEXT,
 payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX events_order ON events(length(seq),seq);
CREATE INDEX events_retention ON events(created_at);
CREATE TABLE quarantine (id TEXT PRIMARY KEY, reason TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), other_conversation_id TEXT REFERENCES conversations(id),
 created_at TEXT NOT NULL);
CREATE INDEX conversations_page ON conversations(last_activity_at,id);
CREATE TABLE read_cursors (
 actor_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 through_inbound_seq TEXT NOT NULL CHECK(through_inbound_seq='0' OR (through_inbound_seq NOT GLOB '*[^0-9]*' AND substr(through_inbound_seq,1,1) BETWEEN '1' AND '9')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,conversation_id)
);
CREATE TABLE legacy_dispatch (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('waiting','pending','dispatched','skipped')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error TEXT,
 created_at TEXT NOT NULL,
 dispatched_at TEXT
);
CREATE INDEX legacy_dispatch_pending ON legacy_dispatch(status,seq);
PRAGMA user_version=5;
`;
