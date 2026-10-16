-- Everything that failed verification, parked where a human can see it.
--
-- SPEC.md: "Any mismatch goes to review_queue, never to the ledger." This
-- table exists in phase 2 so that the "never to the ledger" half has somewhere
-- to put the things it refuses; phase 3 fills it.

CREATE TABLE review_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor            text,
  source_message_id text,

  -- Why it did not go straight through, in words an operator can act on.
  reason            text NOT NULL,

  -- Both halves of the double extraction, kept side by side. Whoever resolves
  -- the item needs to see what disagreed, not a summary of the disagreement.
  parser_extraction jsonb,
  agent_extraction  jsonb,
  raw_email         text,

  status            text NOT NULL DEFAULT 'open',
  resolution_note   text,
  resolved_at       timestamptz,
  resolved_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT review_queue_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT review_queue_status_known
    CHECK (status IN ('open', 'accepted', 'accepted_with_corrections', 'rejected')),
  -- A resolved item without a resolution time is an item nobody can audit,
  -- and an open item with one is a row that lies about its own state.
  CONSTRAINT review_queue_resolution_is_consistent
    CHECK ((status = 'open') = (resolved_at IS NULL))
);

-- One open item per email. Re-submitting a message that is already waiting for
-- review should find the existing item, not pile up a second copy of the same
-- question. Resolved items are left alone, so a message can come back after a
-- rejection.
CREATE UNIQUE INDEX review_queue_open_message_idx
  ON review_queue (source_message_id)
  WHERE status = 'open' AND source_message_id IS NOT NULL;

CREATE INDEX review_queue_open_idx ON review_queue (created_at) WHERE status = 'open';
