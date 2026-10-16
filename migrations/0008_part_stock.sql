-- The one place the three quantities are defined.
--
-- A view, not a table, because SPEC.md requires on-hand to be derived from the
-- ledger rather than stored. Writing the definition once here means
-- `get_stock`, the sheet sync in phase 4 and the sellable calculation in phase
-- 6 cannot each arrive at a slightly different answer.
--
-- It comes after `reservations` (0004) because `committed` reads from it.

CREATE VIEW part_stock AS
SELECT
  p.id                         AS part_id,
  p.vendor,
  p.vendor_part_number,
  p.description,
  p.unit_of_measure,
  COALESCE(movement.on_hand, 0)   AS on_hand,
  COALESCE(movement.on_order, 0)  AS on_order,
  COALESCE(promised.committed, 0) AS committed,
  -- What is left to promise. Clamped at zero: a negative "available" is not a
  -- quantity anyone can act on, and the real numbers are still in the two
  -- columns it is derived from.
  GREATEST(COALESCE(movement.on_hand, 0) - COALESCE(promised.committed, 0), 0) AS available,
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
LEFT JOIN (
  SELECT part_id, SUM(quantity) AS committed
  FROM reservations
  WHERE status = 'committed'
  GROUP BY part_id
) promised ON promised.part_id = p.id;
