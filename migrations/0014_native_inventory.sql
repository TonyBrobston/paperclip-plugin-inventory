ALTER TABLE parts ADD COLUMN reorder_point numeric(14,4) NOT NULL DEFAULT 0 CHECK(reorder_point>=0);
ALTER TABLE parts ADD COLUMN target_quantity numeric(14,4) NOT NULL DEFAULT 0 CHECK(target_quantity>=0);
ALTER TABLE parts ADD COLUMN storage_location text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE parts ADD COLUMN metadata_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE operational_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision bigint NOT NULL DEFAULT 0,
 settings jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), actor jsonb NOT NULL
);
INSERT INTO operational_settings(settings,actor) VALUES ('{"enabledVendors":["mcmaster","sendcutsend","amazon","formlabs"],"approvalMode":"all","absoluteThreshold":0,"percentThreshold":0,"approverUserIds":[],"allowSelfApproval":false}', '{"type":"migration"}');
CREATE TABLE operational_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation text NOT NULL,
 target text NOT NULL, before_value jsonb, after_value jsonb, reason text NOT NULL,
 actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE physical_counts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_key text NOT NULL UNIQUE,
 reason text NOT NULL CHECK(btrim(reason)<>''), submitted_by jsonb NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(), policy_snapshot jsonb NOT NULL,
 settings_revision bigint NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','applying','applied','rejected')),
 decided_by jsonb, decided_at timestamptz, decision_reason text
);
CREATE TABLE physical_count_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), count_id uuid NOT NULL REFERENCES physical_counts(id),
 part_id uuid NOT NULL REFERENCES parts(id), expected numeric(14,4) NOT NULL,
 counted numeric(14,4) NOT NULL, ledger_revision bigint NOT NULL,
 ledger_entry_id bigint UNIQUE REFERENCES ledger_entries(id), UNIQUE(count_id,part_id)
);
ALTER TABLE ledger_entries ADD COLUMN count_line_id uuid UNIQUE REFERENCES physical_count_lines(id);
CREATE FUNCTION native_count_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Count history is immutable'; END IF;
 IF TG_TABLE_NAME='physical_counts' THEN
  IF (to_jsonb(NEW)-ARRAY['status','decided_by','decided_at','decision_reason']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','decided_by','decided_at','decision_reason']) OR OLD.status IN ('applied','rejected') THEN
    RAISE EXCEPTION 'Count submission is immutable';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-'ledger_entry_id') IS DISTINCT FROM (to_jsonb(OLD)-'ledger_entry_id') OR OLD.ledger_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Original count line is immutable';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER count_immutable BEFORE UPDATE OR DELETE ON physical_counts FOR EACH ROW EXECUTE FUNCTION native_count_immutable();
CREATE TRIGGER count_line_immutable BEFORE UPDATE OR DELETE ON physical_count_lines FOR EACH ROW EXECUTE FUNCTION native_count_immutable();
CREATE TRIGGER count_no_truncate BEFORE TRUNCATE ON physical_counts FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_are_append_only();
CREATE TRIGGER count_line_no_truncate BEFORE TRUNCATE ON physical_count_lines FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_are_append_only();
CREATE FUNCTION require_native_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entry_type='adjustment' AND NOT EXISTS (
  SELECT 1 FROM physical_count_lines l JOIN physical_counts c ON c.id=l.count_id
  WHERE l.id=NEW.count_line_id AND l.part_id=NEW.part_id AND l.counted-l.expected=NEW.quantity_delta
  AND l.ledger_entry_id IS NULL AND c.status='applying' AND c.decided_by IS NOT NULL
 ) THEN RAISE EXCEPTION 'Adjustments require an authorized count line'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER native_adjustment_guard BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION require_native_adjustment();
CREATE TABLE receipt_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 shipment_reference text NOT NULL, reason text NOT NULL, actor jsonb NOT NULL,
 lines jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz, applied_by jsonb, UNIQUE(order_id,shipment_reference)
);
CREATE TABLE receipt_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, preview_id uuid NOT NULL REFERENCES receipt_previews(id),
 part_id uuid NOT NULL REFERENCES parts(id), ledger_entry_id bigint NOT NULL UNIQUE REFERENCES ledger_entries(id),
 quantity numeric(14,4) NOT NULL, UNIQUE(preview_id,part_id)
);
CREATE TABLE order_short_closes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_key text NOT NULL UNIQUE,
 order_id uuid NOT NULL REFERENCES orders(id), part_id uuid NOT NULL REFERENCES parts(id),
 quantity numeric(14,4) NOT NULL CHECK(quantity>0), reason text NOT NULL CHECK(btrim(reason)<>''),
 actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_id,part_id)
);
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON operational_audit FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON operational_audit FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_are_append_only();
CREATE TRIGGER receipt_history_no_change BEFORE UPDATE OR DELETE ON receipt_history FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();
CREATE TRIGGER short_close_no_change BEFORE UPDATE OR DELETE ON order_short_closes FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();
