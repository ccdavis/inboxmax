-- Bookmarks saved before UIDVALIDITY tracking have none recorded and would be
-- hidden forever. Adopt the mailbox's known validity; accounts that have not
-- been refreshed yet are backfilled by the server on their next refresh.
UPDATE remembered
SET uid_validity = (
    SELECT a.uid_validity FROM accounts a WHERE a.id = remembered.account_id
)
WHERE uid_validity IS NULL;
