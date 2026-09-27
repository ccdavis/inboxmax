-- The text added below each new message, reply and forward from a mailbox.
ALTER TABLE accounts ADD COLUMN signature TEXT NOT NULL DEFAULT '';
