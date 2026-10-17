# SPEC.md

## Goal

A Paperclip plugin that tracks parts inventory for a small manufacturing business. The first user is Brobston Creations, which makes van-life products such as microwave kits and a Winnebago Revel slide-out pantry.

* Purchases are recorded from vendor order emails.
* Sales come from BigCommerce and consume parts via a bill of materials.
* Native Paperclip plugin UI is the human-facing view and settings layer.
* Postgres is the source of truth for history.

## Architecture (keep these separated)

* **Connectors** (Gmail, etc.) are agent tools. The plugin never reads email itself.
* **Agent + skill**: the agent reads email with the Gmail connector, extracts order line items and calls the plugin's tools. Judgment lives in the skill.
* **Plugin**: vendor-agnostic inventory core, a vendor parser registry, BOM handling and validation. Rules live in the plugin.
* **BigCommerce plugin**: a separate plugin. Integration is via plugin events if supported, otherwise via an agent-run reconcile tool. Structured data like shipments needs no agent judgment, so prefer code paths.
* Built with `@paperclipai/plugin-sdk` (JSON-RPC).
* All deployment-specific values (DB connection, enabled vendors, config repo location) come from config/secrets, never from code.

## Storage

* Postgres in a dedicated schema `inventory`. For Brobston, this is the existing Postgres instance on the Synology NAS.
* Append-only ledger. On-hand quantity is always derived from the ledger, never stored as an editable number.

### Core tables (adjust as needed)

* `parts`: internal id, vendor, vendor part number, description, unit of measure; human-owned reorder point, target quantity, storage location, notes and active status in PostgreSQL.
* `physical_counts` / count lines: immutable original counts, expected stock and revision, discrepancy, status, submission key and submitter provenance.
* Adjustment approvals: authenticated approver/time/reason, policy snapshot, unique count-to-ledger linkage.
* Inventory operational settings: enabled vendors, discrepancy thresholds and approval policies with audited updates.
* `orders`: vendor, vendor order number, order date, subtotal, source Gmail message ID, raw email text, status.
* `order_lines`: order, part, quantity, unit price, line total.
* `ledger_entries`: part, type (`purchase` | `receipt` | `sale` | `adjustment`), quantity delta, cost, reference, created\_at, created\_by.
* `reservations`: part, quantity, BigCommerce order ID + line, status (`committed` | `consumed` | `released`).
* `review_queue`: proposed entries that failed verification, with the reason and both extractions.
* `boms`: versioned. Product SKU, version, effective date, lines (part + quantity per unit), options.
* `sync_state`: cursors such as the last processed Gmail message and last BOM commit synced.

### Invariants

* Idempotency: unique on (vendor, order number, line), on Gmail message ID and on (BigCommerce order ID, line). Reprocessing never double-counts.
* Every entry stores provenance (Gmail message ID + raw text, or BigCommerce order ID). This is stored in the database only, never in a repo.
* "On order," "on hand" and "committed" are tracked separately.
* On-hand never goes negative without an explicit adjustment.

## Plugin tools exposed to agents

* `submit_order_email({ messageId, vendor?, rawText, agentExtraction })`: the main purchase intake path.
  * Runs the matching vendor parser and compares its result to the agent's extraction.
  * Reconciles line totals against the email subtotal.
  * Records the order if everything agrees; otherwise sends it to `review_queue`.
* `record_receipt`, `record_adjustment`
* `record_sale({ productSku, options, qty, reference })`: expands through the active BOM version into part consumption.
* `list_review_queue`, `resolve_review_item`
* `get_stock(partId?)`, `get_sellable(productSku?)`
* `sync_boms()`
* `inventory_page({ page, ...filters })`: read native inventory, counts, receiving, review, settings and dashboard data.
* `inventory_action({ operation, ...parameters })`: physical count preview/submission, approval/rejection/reconciliation and settings operations, shared with the native UI.
* `reconcile_bigcommerce()`: fallback if plugin events aren't available.

## Verification (double extraction)

1. The vendor parser and the agent extraction must match on part numbers and quantities.
2. The sum of quantity × unit price must equal the email subtotal (allow for tax and shipping lines).
3. If no parser exists for a vendor, require a second independent extraction from a different model in its place.
4. Any mismatch goes to `review_queue`, never to the ledger.

## Vendor parser registry

* One module per vendor: `mcmaster`, `sendcutsend`, `amazon`, `formlabs`.
* Interface: `matches(email) → bool`, `parse(rawText) → { orderNumber, orderDate, lines[], subtotal }`.
* Adding a vendor should mean adding one module plus fixtures, with no core changes.
* Tested against sanitized or synthetic fixtures that match each vendor's real email format.
* Amazon is expected to be the least reliable: format changes, truncated names, split orders.

## BOM

* Source of truth: one YAML file per product in the private config repo (`bom/`). Changes go through PRs like any other code.
* Schema example:

```yaml
  sku: PRODUCT-SKU                 # must match the BigCommerce SKU
  lines:
    - part: vendor-a:part-001      # links to parts
      qty: 8
      customer_description: "Self tapping countersunk head screws (for shelf)"
  options:
    - bigcommerce_option: option-name
      lines:
        - part: vendor-b:part-002
          qty: 1
          customer_description: "Optional bracket"
```

* The plugin syncs BOM files into versioned `boms` records. Each sale/shipment is consumed against the BOM version active at that time; later BOM changes never rewrite history.
* Validation on sync: every part ref must exist in `parts` and every SKU must exist in BigCommerce. Fail loudly otherwise.
* **Docs generation:** regenerate the "included in the kit" section of each install-instruction doc in the public BrobstonCreations/documentation repo, via PR. Only `customer_description` and quantities may be written to the public repo. Never part refs, vendor names or vendor part numbers.

## BigCommerce bridge

* **Order placed:** reserve parts via the BOM (including selected options) as `committed`.
* **Order shipped:** convert the reservation into ledger `sale` entries.
* **Order cancelled/refunded:** release the reservation, or reverse the sale if it already shipped.
* **Sellable quantity per product:** across the product's BOM parts, the lowest value of floor((on hand − committed) / quantity per product).
* Push sellable quantity to BigCommerce after any ledger change affecting that product. The inventory plugin is the source of truth; BigCommerce only displays the number.

## Native Inventory UI

Inventory management lives inside Paperclip as plugin pages/navigation and a dashboard widget where the installed host supports them. No separate application is authorized.

* Inventory: searchable/filterable parts with on-hand, committed, on-order, available (on-hand minus committed), last cost, average cost and last ordered. Edit reorder point, target quantity, storage location, notes and active status in PostgreSQL.
* Physical Counts: single/batch count entry with ledger-derived expected stock and discrepancy preview before approval. Persist original count, expected quantity, ledger revision, submitter/time and reason. Approval records authenticated approver/time/reason and links the resulting append-only adjustment.
* Reconciliation: immutable submission/idempotency keys and transactional uniqueness prevent duplicate adjustments. Lock/version-check affected stock at approval; stale snapshots must conflict and require a fresh preview/recount, never silently overwrite subsequent activity. Batch behavior must be explicit and atomic or expose per-line outcomes safely. Configurable thresholds and approval policies apply equally to UI, tools and direct adjustment paths.
* Needs Review: vendor discrepancies, failed verification and adjustment approvals; approve, reject, resolve with provenance. Rejected or unresolved items never write stock.
* Settings: enabled vendors and inventory operational/approval settings, persisted in PostgreSQL with migration and validation.
* Dashboard: low-stock counts, pending reviews and actionable alerts linked to relevant pages.
* One domain/service layer backs agent tools and UI data/actions. Neither browser nor agent-supplied actor/company fields are authority. Require host-derived identity, company authorization and role checks; document which permissions the host supplies and which the plugin enforces.
* Before implementation, verify installed SDK and running host versions, UI entrypoint/slot registration, page routes/navigation/widget support, data/action bridge and authentication/authorization against actual source and executable probes. Record limitations in docs/sdk-notes.md. Board-only discovery returning 403 for agents is not evidence of missing UI support. No core fork changes or standalone app without Tony’s separate approval.

## Deployment and recovery

Automate setup and additive, versioned PostgreSQL migrations; keep existing ledger/provenance/history intact. Move human-owned settings into PostgreSQL with explicit precedence and a validated, optional one-time legacy import that requires no new Google authentication. Remove Sheets adapters, tools, config, credentials, dependencies and spreadsheet-specific documentation from the active product. Do not rewrite historical migrations. Document backup/restore, private config and secret bindings, supported version/build, upgrade/rollback and a single deployment command where practical. Test clean installation, upgrade from the merged schema and recovery from backup without double processing.

## Out of scope for now

* Vendor APIs (the McMaster API is product-info only and gated).
* Finished-goods inventory (kits assembled ahead of time). Parts are consumed at shipment.