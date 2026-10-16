-- Cursors: the last Gmail message processed, the last BOM commit synced, the
-- last BigCommerce reconciliation.
--
-- One row per named cursor rather than one column per cursor, so phases 4 to 6
-- add a cursor without a migration.

CREATE TABLE sync_state (
  key        text PRIMARY KEY,
  cursor     text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sync_state_key_not_blank CHECK (btrim(key) <> ''),
  CONSTRAINT sync_state_details_is_object CHECK (jsonb_typeof(details) = 'object')
);
