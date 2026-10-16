-- The ledger. Everything the business believes about stock is a sum over this
-- table, so the rules it cannot break live here rather than in TypeScript.
--
-- SPEC.md: "Append-only ledger. On-hand quantity is always derived from the
-- ledger, never stored as an editable number." and "'On order,' 'on hand' and
-- 'committed' are tracked separately."
--
-- On order and on hand are therefore two separate sums over the same row, not
-- one number interpreted differently. Committed is not here at all: it is a
-- promise about stock we still hold, not a movement of it, so it lives in
-- `reservations` (0004).

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  part_id        uuid NOT NULL REFERENCES parts (id),
  entry_type     text NOT NULL,

  -- The physical quantity this event moved, signed in the direction it moved.
  -- Receiving 5 is +5; selling 5 is -5.
  quantity_delta numeric(14, 4) NOT NULL,

  -- Where that quantity lands. Two columns rather than one, because a receipt
  -- does two things at once: it adds to what we hold and it discharges what we
  -- were waiting for. Collapsing them into a single signed number loses the
  -- distinction the spec asks us to keep.
  on_order_delta numeric(14, 4) NOT NULL DEFAULT 0,
  on_hand_delta  numeric(14, 4) NOT NULL DEFAULT 0,

  unit_cost      numeric(14, 4),

  -- What this entry is about: a vendor order number, a BigCommerce order id,
  -- an Adjustments-tab row. Purchases and the receipts that discharge them
  -- share a reference; that shared value is how a receipt knows how much of
  -- the order is still outstanding.
  reference      text NOT NULL,

  -- Set when repeating the same real-world event must not produce a second
  -- entry. Null when each call is genuinely a new event — an unreferenced
  -- physical count, for instance, which may legitimately happen twice.
  idempotency_key text,

  note           text,

  -- SPEC.md: "Every entry stores provenance (Gmail message ID + raw text, or
  -- BigCommerce order ID). This is stored in the database only, never in a
  -- repo." Free-form because the shape differs per source, but never absent:
  -- an entry nobody can trace back is an entry nobody can check.
  provenance     jsonb NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT ledger_entry_type_known
    CHECK (entry_type IN ('purchase', 'receipt', 'sale', 'adjustment')),
  CONSTRAINT ledger_reference_not_blank CHECK (btrim(reference) <> ''),
  CONSTRAINT ledger_created_by_not_blank CHECK (btrim(created_by) <> ''),
  CONSTRAINT ledger_unit_cost_not_negative
    CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT ledger_provenance_is_a_fact
    CHECK (jsonb_typeof(provenance) = 'object' AND provenance <> '{}'::jsonb),

  -- The entry type and the two buckets have to tell the same story. Without
  -- this a caller could write a "receipt" that moves nothing, or a "sale" that
  -- adds stock, and every sum downstream would be wrong with no row looking
  -- obviously wrong.
  CONSTRAINT ledger_buckets_match_entry_type CHECK (
    CASE entry_type
      -- Ordered, not yet here.
      WHEN 'purchase' THEN
        quantity_delta > 0
        AND on_order_delta = quantity_delta
        AND on_hand_delta = 0
      -- Arrived. Discharges at most as much as it delivered: a receipt for
      -- stock that was never ordered discharges nothing rather than driving
      -- on-order negative.
      WHEN 'receipt' THEN
        quantity_delta > 0
        AND on_hand_delta = quantity_delta
        AND on_order_delta <= 0
        AND on_order_delta >= -quantity_delta
      -- Shipped to a customer.
      WHEN 'sale' THEN
        quantity_delta < 0
        AND on_hand_delta = quantity_delta
        AND on_order_delta = 0
      -- A human saying the count is different from what we thought. The only
      -- entry with no document behind it, and the only one allowed to leave
      -- on-hand negative.
      WHEN 'adjustment' THEN
        quantity_delta <> 0
        AND on_hand_delta = quantity_delta
        AND on_order_delta = 0
    END
  )
);

-- The idempotency guarantee itself. Partial, so the null case stays free.
CREATE UNIQUE INDEX ledger_entries_idempotency_key_idx
  ON ledger_entries (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Every read of stock groups by part; every receipt looks up outstanding
-- on-order for one part and reference.
CREATE INDEX ledger_entries_part_idx ON ledger_entries (part_id, id);
CREATE INDEX ledger_entries_reference_idx ON ledger_entries (part_id, reference);

-- Append-only, enforced rather than promised.
--
-- "Append-only" as a convention lasts until the first person with psql open
-- fixes a typo, and the whole point of the ledger is that its history can be
-- trusted without asking anyone whether they did that. A mistake is corrected
-- by recording an adjustment, which leaves both the mistake and the correction
-- visible.
CREATE FUNCTION ledger_entries_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; % is not allowed. Record an adjustment instead, so the original entry and the correction are both visible.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();

-- TRUNCATE fires no row triggers at all, so without this one it is the one
-- statement that empties the ledger silently.
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_are_append_only();
