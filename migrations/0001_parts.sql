-- Parts: the thing every other table points at.
--
-- A part is identified to the outside world by the pair the vendor prints on
-- the invoice, so that pair is the natural key. The surrogate uuid exists
-- because the pair is not stable: a vendor renames a part number, and a
-- foreign key that embedded it would have to be rewritten everywhere,
-- including in ledger history that is supposed to be append-only.

CREATE TABLE parts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor             text NOT NULL,
  vendor_part_number text NOT NULL,
  description        text,
  unit_of_measure    text NOT NULL DEFAULT 'each',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT parts_vendor_not_blank CHECK (btrim(vendor) <> ''),
  -- Vendor keys are normalised to lowercase on the way in so that
  -- "McMaster" and "mcmaster" cannot become two vendors. Enforced here as
  -- well, because a later phase writing SQL directly would not go through
  -- that normalisation.
  CONSTRAINT parts_vendor_is_lowercase CHECK (vendor = lower(vendor)),
  CONSTRAINT parts_number_not_blank CHECK (btrim(vendor_part_number) <> ''),
  CONSTRAINT parts_uom_not_blank CHECK (btrim(unit_of_measure) <> '')
);

-- Case-insensitive, because PART-00A1 and part-00a1 are one part however they
-- were typed, and two rows here would quietly split that part's stock in half.
-- The stored value keeps the vendor's own casing, so what we show an operator
-- matches what the vendor prints.
CREATE UNIQUE INDEX parts_vendor_number_idx
  ON parts (vendor, lower(vendor_part_number));
