-- Pin each order line to its first accepted BOM expansion. Cumulative counters
-- let retries and stale snapshots converge without replaying movements.
CREATE TABLE bigcommerce_lines (
  order_id text NOT NULL,
  line_id text NOT NULL,
  catalog_key text NOT NULL,
  bom_id uuid NOT NULL REFERENCES boms(id),
  identity jsonb NOT NULL,
  expansion jsonb NOT NULL,
  ordered integer NOT NULL CHECK (ordered > 0),
  shipped integer NOT NULL DEFAULT 0 CHECK (shipped >= 0),
  refunded integer NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  reversed integer NOT NULL DEFAULT 0 CHECK (reversed >= 0),
  closed boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(order_id, line_id),
  CHECK (shipped <= ordered AND refunded <= ordered AND reversed <= shipped)
);
-- Retain a positive original reservation row even when nothing remains open.
ALTER TABLE reservations ADD COLUMN bom_id uuid REFERENCES boms(id);

-- A successful local mutation survives an HTTP outage. Every later mutation
-- or explicit reconciliation retries the latest absolute stock, never a delta.
CREATE TABLE bigcommerce_stock_dirty (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);
INSERT INTO bigcommerce_stock_dirty DEFAULT VALUES;
CREATE FUNCTION mark_bigcommerce_stock_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bigcommerce_stock_dirty DEFAULT VALUES;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ledger_stock_dirty AFTER INSERT ON ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION mark_bigcommerce_stock_dirty();
CREATE TRIGGER reservation_stock_dirty AFTER INSERT OR UPDATE ON reservations
FOR EACH STATEMENT EXECUTE FUNCTION mark_bigcommerce_stock_dirty();
CREATE TRIGGER bom_stock_dirty AFTER INSERT ON bom_lines
FOR EACH STATEMENT EXECUTE FUNCTION mark_bigcommerce_stock_dirty();
