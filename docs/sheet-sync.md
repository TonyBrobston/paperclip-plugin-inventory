# Sheet sync

Run `sync_sheet({dryRun:true})` to validate and preview, then `sync_sheet({})` to apply. There is no scheduled sync. PostgreSQL remains authoritative.

## Configuration

Copy `spreadsheetId` from private deployment settings into the plugin config. Select a Paperclip secret reference in `googleServiceAccount` containing a Google service-account JSON key. Enable the Sheets API for its project and share this one spreadsheet with that account as an editor. The account signs an RS256 assertion for Google's fixed token endpoint; no key file or credential is stored by the plugin. Tokens are scoped to Sheets, live only for the call, and are never logged. Database configuration is unchanged. Keep actual spreadsheet IDs, service-account identities, and business settings out of public repositories.

The public adapter uses the [Sheets batchUpdate API](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate) and [service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account). It creates missing tabs but refuses nonempty tabs with unexpected headers. Tab names are `Inventory`, `Adjustments`, `Needs Review`. No BOM tab is created.

## Column ownership

| Tab | Plugin writes and protects | Human inputs, read only by plugin |
| --- | --- | --- |
| Inventory | A:K — Part ID, Part, Description, Unit, On hand, Committed, On order, Sellable impact, Last cost, Avg cost, Last ordered | L:P — Reorder point, Target qty, Location, Notes, Active |
| Adjustments | G:H — Processed at, Result | A:F — Count ID, Part ID, Physical count, Reason, Counted at, Counted by |
| Needs Review | A:G — Review ID, Vendor, Message ID, Reason, Parser extraction, Agent extraction, Created at | None |

All headers are protected. Human column headers are initialized only when creating an empty tab. System writes address individual A:K row ranges; no whole-row overwrite, sort, or deletion touches human settings. Existing rows are matched by immutable Part ID, new parts append, and blank human values clear their cached settings in `part_sheet_settings`. Rows without a Part ID and with only human settings or extra-column values are preserved and skipped; new parts append after them. System values in A:K without a Part ID still require repair. Active accepts literal booleans; quantities accept nonnegative numbers up to four decimals. Formulas are refused in inputs. Output uses typed literal cells, so a description beginning with `=` is text.

Protections restrict editors to the service account (`warningOnly:false`); Google's spreadsheet owner can still override them. Sync repairs only its own named protections, preserving operator protections and unrelated tabs. Avoid editing, sorting, moving or deleting managed rows/columns during a sync: Google Sheets provides no read/write compare-and-swap against concurrent interactive edits. Restore headers or Part IDs before retrying after structural edits.

Last cost is the latest non-null ledger unit cost. Avg cost is the quantity-weighted purchase cost; Last ordered is the latest purchase-entry timestamp. These use ledger purchase units, with no pack-to-piece conversion. Physical counts must use the same units as the recorded part; `Unit` displays the existing part metadata. Sellable impact reads **Pending BOM integration** until active BOM/product calculations arrive in later phases; it is never an invented product availability number.

## Physical counts and recovery

Enter a unique, permanent Count ID, Inventory Part ID, nonnegative count, reason, ISO timestamp with timezone, and counter name in Adjustments A:F. Keep counts in chronological row order. Counts represent on-hand **at processing time**; do not enter historical counts after later receipts/shipments without reconciling those movements first.

Each Count ID is scoped to the spreadsheet. A transaction locks its part, computes `physical count − current on hand`, appends the adjustment through the ledger, and saves `sheet_counts` in the same commit. Zero-delta counts still get a receipt. Status cells are advisory: forging or clearing Processed at cannot skip or duplicate processing. Reordering a completed row preserves its Count ID. Editing a completed input is refused; enter a new Count ID for a correction. Duplicate Count IDs in one tab are refused before mutation. Clearing all A:F inputs skips that row even if protected G:H status remains; its database receipt is retained, and restoring the original inputs replays without recounting. Partially completed inputs still require correction.

A database advisory lock serializes sync calls for the same schema/spreadsheet. Database changes commit before the final Sheet batch. If publishing fails, rerun: durable receipts restore status without recounting or discarding intervening receipts. A failed database transaction writes no settings, counts or ledger entries. Do not discard database count receipts when repairing the Sheet.

Dry run reads and validates, takes locks, and returns planned new/replayed count totals without Sheet, ledger, settings or receipt writes. It does not simulate the downstream stock display after physical counts. Initial database migration may still occur on a first tool call.

Needs Review includes every open review item and both extractions; resolved entries are cleared on the next sync. Extractions exceeding a Sheet cell limit show a marked excerpt; `list_review_queue` returns the full extraction. Raw email bodies stay in PostgreSQL. The spreadsheet contains operational order metadata and must remain private.

## Verification

`tests/sheet-sync.spec.ts` drives real PostgreSQL with a synthetic Sheets adapter: ownership, protected ranges, new-tab initialization, stable rows, cleared settings, physical counts, zero deltas, publish-failure recovery, concurrency, immutable IDs, transaction rollback, dry run and review visibility. Live Google permissions and protection enforcement need a configured service account and test spreadsheet; mock transport success is not live validation.
