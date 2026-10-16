# Email intake and verification (Phase 3 draft)

`submit_order_email` compares agent extraction with a vendor parser, reconciles
quantity × unit price against the printed subtotal, and records purchases in
`on_order`. It never increases on-hand; physical arrivals use `record_receipt`
with the same vendor order number as `reference`.

The order, lines, newly discovered parts, purchases and message disposition
commit in one transaction. Message retries return their original disposition,
including rejections. Separate messages for the same vendor/order reuse the
order only when its contents agree. Conflicting contents enter review. Case
variants of vendor order/part identifiers do not create additional purchases.

`list_review_queue` returns open items with both extractions, raw source and
verification provenance. `resolve_review_item` requires a decision note.
`accept` chooses the original agent extraction and requires agreement with any saved verifier extraction; `accept_with_corrections`
requires a complete replacement extraction. Both must reconcile. An explicit
`accept_with_corrections` decision can override a supported vendor parser disagreement; original
extractions remain unchanged and the decision records its author, run, note,
selected extraction and review id in purchase provenance. Rejection writes no
ledger entries. A resolved review cannot be changed to another final decision. There is no reopen tool; retries of a rejected message remain rejected. The earlier 0005 migration comment predates durable message dispositions introduced in 0009; applied migrations remain unchanged to preserve their checksums.

For vendors without a parser, submission and acceptance require:

```json
{
  "agentModel": "primary-model-id",
  "independentExtraction": {
    "model": "different-model-id",
    "extractionId": "independent-run-id",
    "extraction": {
      "orderNumber": "SYNTH-ORDER",
      "subtotal": 10,
      "lines": [
        {"vendorPartNumber": "SYNTH-PART", "quantity": 2, "unitPrice": 5}
      ]
    }
  }
}
```

These are caller attestations, retained for audit, not cryptographic proof of
model identity or independent reasoning. The agent must actually run the second
model independently against the raw email, without exposing the first result.
Missing evidence, same-model evidence or disagreement enters review. Resolution
cannot waive the independent extraction requirement for unsupported vendors.

Quantities and prices permit four decimals, matching Postgres storage. Extended
prices round half up to four places per line. Printed line totals, when present,
must agree. Tax and shipping are excluded from subtotal reconciliation.

## Parser status and fixture provenance

**Vendor format validation is pending authorized Gmail access.** The McMaster
and SendCutSend modules currently handle only conservative synthetic text tables.
These fixtures were invented for tests; they are not claimed to reproduce actual
vendor emails. Unrecognised layouts fail closed to review. Do not treat these
parsers as production ready until 2–3 authorized samples per vendor have been
inspected and format-preserving, fully synthetic fixtures added.

Only invented names, addresses, order numbers, part numbers and prices appear
in this repository. No original emails or deployment settings belong here.
Original source text is persisted only in the configured inventory database.

Vendor modules implement `matches` and `parse`; register a new module in
`src/parsers/index.ts` and add synthetic fixtures. Storage and verification code
do not change. Deployment enabled-vendor configuration remains authoritative.
