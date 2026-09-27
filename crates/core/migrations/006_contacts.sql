-- The address book: one row per address a user writes to or reads from.
-- Addresses are stored lower-case; a person with two addresses has two rows.
CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    -- Messages sent to this address; ranks suggestions.
    times_sent INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT (unixepoch()),
    -- The user set the name, so names seen in mail no longer replace it.
    name_locked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, email)
);
