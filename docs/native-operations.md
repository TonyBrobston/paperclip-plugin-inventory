# Native Inventory operations

Inventory uses Paperclip authentication and a company-bound PostgreSQL schema. No Google authentication is required. Deployment credentials belong in Paperclip secret bindings; BOMs and actual business configuration belong in the private config repository.

## Deploy

From the reviewed checkout, run `npm ci && npm run typecheck && npm test && npm run build && npm run smoke`. Set `INVENTORY_TEST_DATABASE_URL` to an isolated PostgreSQL database so integration tests run. Install the resulting package through the host plugin installation flow; retain the existing plugin ID `tbro.inventory` and database secret/schema configuration. The package includes built worker, manifest, UI and additive migrations.

Migrations run transactionally when the first scoped Inventory request opens storage. A schema binds to its first host-authorized company; copying its configuration into another company fails closed. Back up existing data before the first request after upgrading. Keep the plugin disabled while restoring or changing schema ownership.

## Authority and policy

- The host supplies company scope and immutable action actor identity. UI parameters cannot supply authority; actions reject missing company, missing human IDs or inconsistent actor companies. Host routes own viewer and cross-company authorization. Read bridges remain read-only because their context lacks user identity.
- Settings changes and approval decisions require a human. Configured approver IDs restrict settings and count decisions. Count approval checks both the submission's policy snapshot and current policy, forbids self approval unless configured, and rejects a changed policy revision.
- All adjustment paths use the count service, including `record_adjustment`. Database and domain guards refuse adjustment ledger entries without an authorized count line. Automatic application uses the recorded submission identity and an explicit automatic-decision reason.
- Approval mode `all` requires approval for every nonzero discrepancy. Mode `threshold` applies automatically only when both absolute and percentage thresholds are met; a discrepancy against zero expected stock always requires approval. Zero-discrepancy submissions record a result without creating a ledger adjustment.
- Operational settings in PostgreSQL are authoritative. Host instance configuration carries only connection/integration settings; legacy Sheets settings and Google credentials are ignored. An authorized human may run `inventory_action` with operation `import_legacy_settings`, the current settings `revision`, a `reason`, validated `settings`, and `parts` entries containing existing `partId`, `reorderPoint`, `targetQuantity`, `location`, `notes`, and `active`. Import accepts an offline export, requires no Google connection, applies atomically once per schema, and audits each changed part. It does not import stock, counts or credentials.

## Counts and receiving

Preview a count batch, review expected/count/discrepancy, and submit with a reason. Preserve its submission key across retries. Original quantities, ledger revisions, submitter and policy are immutable; each adjustment links uniquely to a count line. Approval locks all affected parts and applies the entire batch in one transaction. Any changed stock revision rejects the whole batch; reject it and preview a new count.

A stale BigCommerce refund keeps reconciliation paused. Reject its old count, then use **Refresh refund for approval** with a reason. An authorized human creates a fresh stock/policy snapshot linked to the immutable rejection through the operational audit; refresh never credits stock automatically. A separate approver is required when self approval is disabled. Approve the new proposal, then retry reconciliation; retries follow the audited successor and credit once. Rejection alone never schedules a new refund proposal.

Receiving selects an order and shipment reference, previews prior receipts/outstanding quantities and requires a reason for any overage. Confirmation rechecks revisions and outstanding quantities under locks. Receipt quantity records actual stock; receiving 21 against 20 ordered adds 21 on hand and clears 20 on order. Short close separately records undelivered quantities and a reason. Applied receipt and short-close history remain available.

Physical Counts and Needs Review return all pending counts/open reviews before up to 200 recent completed records, so new history cannot hide actionable decisions. Needs Review exposes intake evidence and count submissions. Rejection records a decision without stock movement; intake acceptance still enforces extraction verification. Corrections must satisfy the existing extraction schema. Unsupported vendor verification may require the agent tool's independent-extraction fields.

## Backup, restore and rollback

Use PostgreSQL tools from the deployment environment; never commit backup data or connection strings. Resolve the database credential privately into `INVENTORY_DATABASE_URL` for these commands.

```bash
pg_dump --format=custom --schema=inventory --file=inventory-before-upgrade.dump "$INVENTORY_DATABASE_URL"
pg_restore --list inventory-before-upgrade.dump
```

For a custom schema, replace `inventory`. Verify an isolated restore before production migration. Restore into a fresh database with `pg_restore --no-owner --dbname="$INVENTORY_RESTORE_DATABASE_URL" inventory-before-upgrade.dump`; bind a separate test plugin instance to that restore and the same company, then verify ledger totals and duplicate submission/receipt behavior before using it.

Rollback requires disabling the upgraded worker, retaining a backup of post-upgrade activity, and restoring the pre-upgrade backup into a fresh database before reinstalling the matching prior package/configuration. Do not run the prior Sheets worker against the upgraded adjustment guard: its direct adjustment path is incompatible. Do not drop count/provenance tables or rewrite applied migration checksums. Reconcile post-backup activity explicitly before returning to service.

## Release evidence still required

Local tests and a built bundle do not establish host acceptance. Reed must review the final SHA before Quinn tests the running native host page, sidebar/widget, human action identity, viewer/cross-company denial, stale/duplicate counts, partial/overage receipts and review decisions. Mike merges only after author, Reed and Quinn agree.
