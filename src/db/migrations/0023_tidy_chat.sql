-- The tidy chat switch (ADR-0038): 1 deletes the user's private message once it has recorded an
-- expense. Off for every user, existing and new, until they turn it on in /settings.
-- 0 | 1
ALTER TABLE users ADD COLUMN tidy_chat INTEGER NOT NULL DEFAULT 0;
