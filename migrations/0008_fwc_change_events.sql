-- Change notifications from the Fair Work Modern Awards API (webhooks).
-- The receiver aggregates rather than logging every hit: the API may send one call per changed
-- rate, so a rates change could be thousands of calls. One row per (day, kind), one per award.

CREATE TABLE fwc_change_events (
  day TEXT NOT NULL,                 -- UTC date of the notifications
  kind TEXT NOT NULL,                -- hook type if the payload names one, else 'unknown'
  hits INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  sample TEXT,                       -- most recent raw payload (truncated), for diagnosis
  PRIMARY KEY (day, kind)
);

CREATE TABLE fwc_change_awards (
  award_code TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
