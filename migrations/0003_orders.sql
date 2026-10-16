-- Vendor purchase orders, as read out of order emails.
--
-- Phase 3 fills these in. They are created here, with the phase 2 ledger,
-- because the spec's idempotency invariant is a property of the schema and
-- is easier to get right once than to retrofit around existing rows.

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor              text NOT NULL,
  vendor_order_number text NOT NULL,
  order_date          date,
  subtotal            numeric(14, 4),

  -- Provenance, and the database is the only place it is ever written.
  -- SPEC.md is explicit that the raw email never reaches a repository.
  source_message_id   text,
  raw_email           text,

  status              text NOT NULL DEFAULT 'recorded',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orders_vendor_not_blank CHECK (btrim(vendor) <> ''),
  CONSTRAINT orders_vendor_is_lowercase CHECK (vendor = lower(vendor)),
  CONSTRAINT orders_number_not_blank CHECK (btrim(vendor_order_number) <> ''),
  CONSTRAINT orders_subtotal_not_negative CHECK (subtotal IS NULL OR subtotal >= 0),
  CONSTRAINT orders_status_known
    CHECK (status IN ('recorded', 'partially_received', 'received', 'cancelled')),

  -- SPEC.md invariant: unique on (vendor, order number). Reprocessing the
  -- same order email cannot create a second order.
  CONSTRAINT orders_vendor_number_key UNIQUE (vendor, vendor_order_number)
);

-- SPEC.md invariant: unique on Gmail message ID. Partial, because an order
-- entered by hand has no message to be unique about, and several of those
-- would otherwise collide on null.
CREATE UNIQUE INDEX orders_source_message_idx
  ON orders (source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TABLE order_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  part_id     uuid NOT NULL REFERENCES parts (id),
  quantity    numeric(14, 4) NOT NULL,
  unit_price  numeric(14, 4) NOT NULL,
  line_total  numeric(14, 4) NOT NULL,

  CONSTRAINT order_lines_line_number_positive CHECK (line_number >= 1),
  CONSTRAINT order_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_lines_unit_price_not_negative CHECK (unit_price >= 0),
  CONSTRAINT order_lines_total_not_negative CHECK (line_total >= 0),

  -- The third part of the spec's "(vendor, order number, line)" uniqueness.
  -- The first two come from the unique constraint on `orders`, so this pair
  -- completes it without repeating the vendor on every line.
  CONSTRAINT order_lines_order_line_key UNIQUE (order_id, line_number)
);

CREATE INDEX order_lines_part_idx ON order_lines (part_id);
