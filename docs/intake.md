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

Three McMaster and three SendCutSend order emails were inspected under
authorized Gmail access. The fixtures in `tests/fixtures` reproduce the
structure, labels and unit wording of those messages with every name, address,
order number, part number and price replaced by invented values. What was found:

| Layout | Order number | Line items | Reconcilable subtotal |
|---|---|---|---|
| McMaster **confirmation** | own cell, linked into order history | `1 pack of 50` at `4.00 pack` | `Merchandise` |
| McMaster **receipt** | `Purchase Order` field | `1 Pack` at `4.00 Per Pack` | `Merchandise` |
| SendCutSend **order** | `ORDER <number>` | **none in the body** | none |

Three consequences are worth stating plainly, because each contradicts what the
first draft of these parsers assumed:

- **Neither McMaster layout prints anything resembling `Order Number:`,** and a
  receipt never spells "McMaster-Carr" in its body — only the `mcmaster.com`
  domain, which is why vendor matching keys on the domain as well as the name.
- **`Merchandise` is the subtotal that reconciles, not `Total`.** Total includes
  shipping and tax, which are not line items and must never reach the ledger as
  stock value.
- **SendCutSend order emails contain no line items at all.** The itemised
  invoice is a PDF attachment, so that parser reads the order number and then
  refuses, which routes the email to review naming the attachment as the
  reason. Recording stock from one needs the invoice read and reviewed through
  `accept_with_corrections`.

**Quantity is the vendor's purchase unit, not a piece count.** A pack of 50
screws is quantity 1 at the pack price, because that is what the vendor charges
for and what reconciles exactly against the printed figures. Dividing a pack
price by its pack size invents precision the email does not contain — a $12.70
pack of 3 has no exact per-piece price — and would turn a sound order into a
false reconciliation failure. The pack size is preserved in the line
description. **A phase that consumes parts per piece must expand packs
deliberately rather than assume the ledger counts pieces.**

Unrecognised layouts still fail closed to review. Only invented names,
addresses, order numbers, part numbers and prices appear in this repository; no
original email text does. Original source text is persisted only in the
configured inventory database.

Vendor modules implement `matches` and `parse`; register a new module in
`src/parsers/index.ts` and add synthetic fixtures. Storage and verification code
do not change. Deployment enabled-vendor configuration remains authoritative.
