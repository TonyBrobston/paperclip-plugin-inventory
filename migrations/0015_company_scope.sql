-- A database schema belongs to one host company even if configuration is copied.
CREATE TABLE company_scope (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  company_id text NOT NULL CHECK (btrim(company_id) <> '')
);

-- Available is the signed on-hand less committed quantity.
CREATE OR REPLACE VIEW part_stock AS
SELECT
  p.id                         AS part_id,
  p.vendor,
  p.vendor_part_number,
  p.description,
  p.unit_of_measure,
  COALESCE(movement.on_hand, 0)   AS on_hand,
  (COALESCE(movement.on_order, 0)-COALESCE(closed.quantity,0)) AS on_order,
  COALESCE(promised.committed, 0) AS committed,
  (COALESCE(movement.on_hand, 0) - COALESCE(promised.committed, 0)) AS available,
  movement.last_entry_at
FROM parts p
LEFT JOIN (
  SELECT
    part_id,
    SUM(on_hand_delta)  AS on_hand,
    SUM(on_order_delta) AS on_order,
    MAX(created_at)     AS last_entry_at
  FROM ledger_entries
  GROUP BY part_id
) movement ON movement.part_id = p.id
LEFT JOIN (SELECT part_id,sum(quantity) AS quantity FROM order_short_closes GROUP BY part_id) closed ON closed.part_id=p.id
LEFT JOIN (
  SELECT part_id, SUM(quantity) AS committed
  FROM reservations
  WHERE status = 'committed'
  GROUP BY part_id
) promised ON promised.part_id = p.id;
