-- Committed stock: parts we still hold but have already promised to a
-- customer order.
--
-- Deliberately not ledger entries. A reservation moves nothing — the parts are
-- still on the shelf — and it can be released, which an append-only ledger
-- would have to model as a second entry cancelling the first. Keeping promises
-- in their own mutable table lets `committed` be a straight sum of open rows
-- and keeps the ledger about movements only.

CREATE TABLE reservations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id              uuid NOT NULL REFERENCES parts (id),
  quantity             numeric(14, 4) NOT NULL,

  -- Provenance for the promise, and the idempotency key for phase 6.
  bigcommerce_order_id text NOT NULL,
  bigcommerce_line_id  text NOT NULL,

  status               text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservations_quantity_positive CHECK (quantity > 0),
  CONSTRAINT reservations_order_id_not_blank CHECK (btrim(bigcommerce_order_id) <> ''),
  CONSTRAINT reservations_line_id_not_blank CHECK (btrim(bigcommerce_line_id) <> ''),
  CONSTRAINT reservations_status_known
    CHECK (status IN ('committed', 'consumed', 'released')),

  -- SPEC.md invariant: unique on (BigCommerce order ID, line). `part_id` is
  -- part of the key because one sold line expands through the BOM into
  -- several parts, so the pair alone would reject every line after the first.
  CONSTRAINT reservations_order_line_part_key
    UNIQUE (bigcommerce_order_id, bigcommerce_line_id, part_id)
);

-- `committed` reads only the open rows, for every part at once.
CREATE INDEX reservations_committed_idx
  ON reservations (part_id)
  WHERE status = 'committed';
