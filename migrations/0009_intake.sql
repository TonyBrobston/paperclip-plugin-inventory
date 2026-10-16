-- Every message has one durable disposition, including rejected review items.
-- Alias messages for an existing vendor order are recorded here too.
CREATE TABLE email_intake (
  message_id text PRIMARY KEY,
  vendor text NOT NULL,
  raw_email text NOT NULL,
  agent_extraction jsonb NOT NULL,
  verifier_extraction jsonb,
  provenance jsonb NOT NULL,
  order_id uuid REFERENCES orders(id),
  review_id uuid REFERENCES review_queue(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((order_id IS NULL) <> (review_id IS NULL))
);
ALTER TABLE review_queue ADD COLUMN resolution_extraction jsonb;
ALTER TABLE review_queue ADD COLUMN resolution_provenance jsonb;
