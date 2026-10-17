-- Human settings are read from Sheets; the plugin never writes these cells.
CREATE TABLE part_sheet_settings (
  spreadsheet_id text NOT NULL,
  part_id uuid NOT NULL REFERENCES parts(id),
  settings jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (spreadsheet_id, part_id)
);
-- Receipt and ledger adjustment commit together, including counts with zero delta.
-- Count IDs are sheet-scoped and immutable, even if the row is moved or deleted.
CREATE TABLE sheet_counts (
  spreadsheet_id text NOT NULL,
  count_id text NOT NULL,
  part_id uuid NOT NULL REFERENCES parts(id),
  physical_count numeric(14,4) NOT NULL CHECK (physical_count >= 0),
  reason text NOT NULL,
  counted_at text NOT NULL,
  counted_by text NOT NULL,
  before_count numeric NOT NULL,
  delta numeric(14,4) NOT NULL,
  ledger_entry_id bigint REFERENCES ledger_entries(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (spreadsheet_id, count_id)
);
