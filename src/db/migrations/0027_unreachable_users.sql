-- When the user blocked the bot in their private chat (a `my_chat_member` update to `kicked`, or
-- a 403 on a scheduled send), as a UTC instant. NULL: reachable. Set and cleared by the user's
-- own actions only; it never touches `blocked_at`, which is the admin's block (ADR-0024).
-- Scheduled pushes and reminders skip an unreachable user (ADR-0043).
ALTER TABLE users ADD COLUMN unreachable_at TEXT;
