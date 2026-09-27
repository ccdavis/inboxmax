-- Messages being written, saved as the user types. The content is the
-- compose form's state as JSON; drafts go with their mailbox.
CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX drafts_by_account ON drafts(account_id, updated_at);
