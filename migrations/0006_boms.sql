-- Bills of materials, versioned.
--
-- SPEC.md: "Each sale/shipment is consumed against the BOM version active at
-- that time; later BOM changes never rewrite history." That is why there is a
-- version column and no update path: a changed BOM is a new row, and the sale
-- that already happened still points at the old one.
--
-- Phase 5 fills these from the YAML files in the private config repo.

CREATE TABLE boms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku    text NOT NULL,
  version        integer NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),

  -- Which config-repo commit this version was read from. The BOM's own
  -- provenance: "which file said this" is answerable years later.
  source_commit  text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT boms_sku_not_blank CHECK (btrim(product_sku) <> ''),
  CONSTRAINT boms_version_positive CHECK (version >= 1),
  CONSTRAINT boms_sku_version_key UNIQUE (product_sku, version)
);

CREATE INDEX boms_active_idx ON boms (product_sku, effective_from DESC);

CREATE TABLE bom_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id               uuid NOT NULL REFERENCES boms (id) ON DELETE CASCADE,

  -- Null for a line that is always included; set for a line that only applies
  -- when the customer picked that BigCommerce option.
  bigcommerce_option   text,

  part_id              uuid NOT NULL REFERENCES parts (id),
  quantity_per_unit    numeric(14, 4) NOT NULL,

  -- The only field that may ever be written to the public documentation repo.
  -- Never the part ref, the vendor or the vendor part number.
  customer_description text,

  CONSTRAINT bom_lines_quantity_positive CHECK (quantity_per_unit > 0),
  CONSTRAINT bom_lines_option_not_blank
    CHECK (bigcommerce_option IS NULL OR btrim(bigcommerce_option) <> '')
);

-- A part may appear once in the base list and once under each option, because
-- two mutually exclusive options can legitimately consume the same fastener.
-- Scoping uniqueness to the option is what allows that while still catching
-- the same part listed twice in one place. (Phase 1 QA raised the opposite
-- behaviour in the config repo's own validator; this is the database being
-- right about it.)
CREATE UNIQUE INDEX bom_lines_unique_within_option_idx
  ON bom_lines (bom_id, COALESCE(bigcommerce_option, ''), part_id);

CREATE INDEX bom_lines_part_idx ON bom_lines (part_id);
