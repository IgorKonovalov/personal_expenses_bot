-- Process-wide key/value state (ADR-0013). Keys are named in src/db/appState.ts.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
