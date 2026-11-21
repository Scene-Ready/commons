-- @scene-ready/commons/outbox, schema version 1.
-- Copy this file into your app's migrations/ under your own number. One
-- outbox_event table per D1 database you write events from.
CREATE TABLE outbox_event (
  id              TEXT PRIMARY KEY NOT NULL,  -- the event's ULID
  body            TEXT NOT NULL,              -- the validated draft, as JSON (no source)
  created_at      INTEGER NOT NULL,           -- ms
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,           -- ms; the sweep's index
  last_error      TEXT,                       -- thrown message, truncated
  rejected_at     INTEGER,                    -- set once; row leaves the sweep
  errors          TEXT                        -- Hub's errors[] as JSON
);
CREATE INDEX idx_outbox_event_due ON outbox_event (next_attempt_at) WHERE rejected_at IS NULL;
