-- Phase 5 reshapes the provisional BOM tables from 0006, for two reasons the
-- live catalog made plain.
--
-- 1. **The key did not exist.** 0006 made `product_sku` the natural key, and
--    every product in the store has an empty product-level SKU: SKUs exist
--    only on variants, and only where a product has options. A BOM keyed on an
--    empty string matches nothing, and the failure is silent in the expensive
--    direction — a sale finds no BOM, consumes nothing, and the ledger looks
--    healthy. So a BOM hangs on a *catalog key*, which is either a variant SKU
--    or `product-<id>`, and the sync resolves it against BigCommerce before
--    accepting it.
--
-- 2. **An option name cannot say which value.** "Which macerator switch type
--    do you have?" has three values and a different part behind each, so a
--    line is conditioned on the name *and* the value. 0006 had one column.
--
-- Nothing has ever been inserted into either table: `sync_boms` is the only
-- writer and it lands in this phase. That is why the tightening below needs no
-- backfill.

ALTER TABLE boms RENAME COLUMN product_sku TO catalog_key;
ALTER TABLE boms RENAME CONSTRAINT boms_sku_not_blank TO boms_catalog_key_not_blank;
ALTER TABLE boms RENAME CONSTRAINT boms_sku_version_key TO boms_catalog_key_version_key;

ALTER TABLE boms
  -- Which kind of catalog key this is, so the sync knows what to resolve it
  -- against and a later phase is not left guessing from its shape.
  ADD COLUMN catalog_key_kind text NOT NULL DEFAULT 'variant_sku',

  -- A hash of the BOM's *content*, not of its file bytes. Reformatting a file
  -- or editing a comment must not create a version, because a version is what
  -- a past sale points at.
  ADD COLUMN content_hash text NOT NULL DEFAULT '',

  -- Where the content came from: the config-repo path, and the revision of the
  -- public documentation the included list was converted from. `source_commit`
  -- (0006) is the config-repo commit.
  ADD COLUMN source_path text,
  ADD COLUMN source_revision text,

  -- Every option value this version has an answer for, including the ones that
  -- consume nothing — `None (no switch)` is a real answer. Stored on the
  -- version rather than derived from the lines, so that at sale time "this
  -- value adds no parts" and "this value is not in the file" stay different
  -- answers: the second one is an option renamed in the storefront, and
  -- expanding the base lines alone would under-consume every unit of it.
  ADD COLUMN option_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,

  ADD CONSTRAINT boms_catalog_key_kind_known
    CHECK (catalog_key_kind IN ('product_id', 'variant_sku')),

  -- A `product_id` key is a shape, not free text, so a typo cannot pass as a
  -- product nobody has noticed is missing.
  ADD CONSTRAINT boms_product_key_shape
    CHECK (catalog_key_kind <> 'product_id' OR catalog_key ~ '^product-[0-9]+$'),

  ADD CONSTRAINT boms_content_hash_not_blank CHECK (btrim(content_hash) <> ''),
  ADD CONSTRAINT boms_option_scopes_is_array CHECK (jsonb_typeof(option_scopes) = 'array');

ALTER TABLE boms ALTER COLUMN catalog_key_kind DROP DEFAULT;
ALTER TABLE boms ALTER COLUMN content_hash DROP DEFAULT;

ALTER TABLE bom_lines RENAME COLUMN bigcommerce_option TO option_name;
ALTER TABLE bom_lines RENAME CONSTRAINT bom_lines_option_not_blank TO bom_lines_option_name_not_blank;

ALTER TABLE bom_lines
  ADD COLUMN option_value text,

  -- The documented line this was converted from, e.g. `revel-microwave:08`.
  -- A quantity somebody disputes two years from now is then traceable to the
  -- bullet in the install document it came from.
  ADD COLUMN source_line_id text,

  -- The pair, or neither. A line scoped to an option name with no value is the
  -- shape that cannot be expanded at sale time: the customer picked one value,
  -- and "any value of this option" is not an answer about which part to
  -- consume.
  ADD CONSTRAINT bom_lines_option_pair CHECK (
    (option_name IS NULL AND option_value IS NULL)
    OR (option_name IS NOT NULL AND btrim(COALESCE(option_value, '')) <> '')
  );

-- `customer_description` is the only field allowed to reach the public
-- documentation repository, and a null one publishes a blank bullet to a
-- customer. Required here as well as in the validator, so the generator cannot
-- be handed a row it has to refuse.
ALTER TABLE bom_lines ALTER COLUMN customer_description SET NOT NULL;
ALTER TABLE bom_lines
  ADD CONSTRAINT bom_lines_customer_description_not_blank
    CHECK (btrim(customer_description) <> '');

-- Uniqueness widens to the option pair: two mutually exclusive values of one
-- option legitimately consume the same fastener in different quantities.
DROP INDEX bom_lines_unique_within_option_idx;
CREATE UNIQUE INDEX bom_lines_unique_within_option_idx
  ON bom_lines (bom_id, COALESCE(option_name, ''), COALESCE(option_value, ''), part_id);

-- Versions are immutable, for the same reason the ledger is.
--
-- "Historical versions stable" is the phase's acceptance criterion, and a
-- convention lasts until the first person with psql open fixes a quantity. A
-- sale that expanded against version 2 keeps pointing at version 2 forever; a
-- corrected BOM is version 3, which leaves both readable.
CREATE FUNCTION boms_are_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'BOM versions are immutable; % is not allowed on %. Change the YAML file in the config repository and sync: that records a new version, and the sales already expanded against this one keep pointing at it.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER boms_no_update BEFORE UPDATE ON boms
  FOR EACH ROW EXECUTE FUNCTION boms_are_immutable();
CREATE TRIGGER boms_no_delete BEFORE DELETE ON boms
  FOR EACH ROW EXECUTE FUNCTION boms_are_immutable();
CREATE TRIGGER boms_no_truncate BEFORE TRUNCATE ON boms
  FOR EACH STATEMENT EXECUTE FUNCTION boms_are_immutable();

CREATE TRIGGER bom_lines_no_update BEFORE UPDATE ON bom_lines
  FOR EACH ROW EXECUTE FUNCTION boms_are_immutable();
CREATE TRIGGER bom_lines_no_delete BEFORE DELETE ON bom_lines
  FOR EACH ROW EXECUTE FUNCTION boms_are_immutable();
CREATE TRIGGER bom_lines_no_truncate BEFORE TRUNCATE ON bom_lines
  FOR EACH STATEMENT EXECUTE FUNCTION boms_are_immutable();

-- The option pair is read on every sale expansion, for one BOM at a time.
CREATE INDEX bom_lines_option_idx ON bom_lines (bom_id, option_name, option_value);
