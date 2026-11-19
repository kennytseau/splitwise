-- Evenly — D1 schema.
-- Run once against your D1 database before the first deploy.

CREATE TABLE IF NOT EXISTS ledgers (
  id       TEXT PRIMARY KEY,
  key_hash TEXT    NOT NULL,          -- SHA-256 of the share key; the key itself is never stored
  seq      INTEGER NOT NULL DEFAULT 0,-- bumped once per push; clients page against it
  created  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  ledger  TEXT    NOT NULL,
  kind    TEXT    NOT NULL,           -- groups | expenses | settlements
  id      TEXT    NOT NULL,
  body    TEXT    NOT NULL,           -- the record as JSON
  updated INTEGER NOT NULL,           -- client clock, used for last-writer-wins
  deleted INTEGER NOT NULL DEFAULT 0, -- tombstone, so deletions propagate
  seq     INTEGER NOT NULL,
  PRIMARY KEY (ledger, kind, id)
);

CREATE INDEX IF NOT EXISTS records_ledger_seq ON records (ledger, seq);
