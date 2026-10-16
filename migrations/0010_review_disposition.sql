-- Keep the original intake review link and persist its final order separately.
ALTER TABLE review_queue ADD COLUMN resolved_order_id uuid REFERENCES orders(id);
UPDATE review_queue r SET resolved_order_id = o.id FROM orders o
WHERE r.status IN ('accepted', 'accepted_with_corrections') AND o.source_message_id = r.source_message_id;
-- Alias reviews can point to orders created by a different message.
UPDATE review_queue r SET resolved_order_id = o.id FROM orders o
WHERE r.resolved_order_id IS NULL AND r.status IN ('accepted', 'accepted_with_corrections')
AND o.vendor = r.vendor AND lower(o.vendor_order_number) = lower(r.resolution_extraction->>'orderNumber');
CREATE INDEX email_intake_review_id_idx ON email_intake(review_id);
CREATE INDEX email_intake_order_id_idx ON email_intake(order_id);
