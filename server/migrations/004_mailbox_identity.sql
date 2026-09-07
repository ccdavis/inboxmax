ALTER TABLE accounts ADD COLUMN uid_validity INTEGER;
ALTER TABLE remembered ADD COLUMN uid_validity INTEGER;

-- Application writes are normalized too; this index also protects legacy rows
-- and concurrent writers from linking case variants of the same mailbox.
CREATE UNIQUE INDEX accounts_email_nocase ON accounts(email COLLATE NOCASE);
