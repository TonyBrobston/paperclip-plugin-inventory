# BigCommerce bridge

Orders reserve parts; shipments consume the pinned BOM expansion, and cancellations or item refunds release commitments or reverse shipped consumption. The separate BigCommerce plugin emits no lifecycle events ([SDK findings](sdk-notes.md#d-cross-plugin-events-and-tools)), so reconciliation runs only when an agent is asked. No webhook, timer, heartbeat, or scheduled job is installed.

## Setup

- Configure the database, validated active BOMs, store hash and existing catalog-read token used by BOM sync.
- Store a separate token in Paperclip secrets with **Orders read-only** and **Products modify** scopes; select it as `bigcommerceBridgeToken`. Pasted credentials are rejected.
- Product keys use product inventory tracking; variant SKUs use variant tracking. The bridge refuses an incompatible tracking mode rather than changing store settings.
- Choose the opening-stock boundary explicitly. First call `reconcile_bigcommerce({since: "2026-01-01T00:00:00Z", dryRun: true})` with the correct boundary, then run without `dryRun`. The timestamp above is synthetic. Do not backfill already-accounted shipments or also record those shipments with `record_sale`.

## Behavior

- Physical lines map by variant SKU or `product-<id>`. Selected option labels must resolve exactly against the active BOM. Missing BOMs, custom physical products, missing options and edited line identities stop reconciliation.
- Incomplete checkouts (status 0) are skipped. Cancelled, declined and refunded-payment statuses (5, 7, 8), and observed archived orders close commitments. Shipment/refund counters drive quantities; digital lines are excluded.
- First accepted observation pins the then-active BOM. Changed BOM versions cannot rewrite that order line. Partial shipments and item refunds apply only cumulative deltas; duplicate or older observations cannot repeat consumption. Cancellation reverses all shipped units; partial refunds reverse shipped units first, then release unshipped commitments.
- `get_sellable({productSku, options?})` subtracts all committed parts from on-hand stock. Without explicit options it returns the conservative minimum across valid option combinations. Shared base/option parts are added before division.
- Each successful mutating tool attempts an absolute stock push for all imported BOM keys. A failed push leaves a durable invalidation and returns pending status; local ledger changes remain saved. Direct database changes also leave invalidations, flushed on the next explicit reconciliation. An in-flight mutation remains pending for the next push.
- Reconciliation advances its cursor only after reading orders, applying lines and pushing stock successfully. A one-minute overlap handles second-resolution timestamps. Earlier successfully applied lines remain committed if a later line fails; retry is idempotent. Dry run writes no snapshots, reservations, ledger, cursor or remote stock.

## Recovery and limits

Resolve missing/ambiguous BOMs before retrying with the same cursor. Regressed counters, conflicting snapshots at the same modification time, changed identities and disappeared known lines fail closed for explicit operator correction. API failures never return response bodies or credentials.

This is pull reconciliation: changes are reflected when called. A store archive that the Orders API omits cannot be inferred as a cancellation; inspect and explicitly resolve such orders. It does not infer physical returns from monetary-only refunds. Opening-stock boundaries and existing manual sales need operator reconciliation before production use. Real BOM activation remains a separate private-config decision.

API contracts: [List Orders](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/get-orders), [List Order Products](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/order-products/get-order-products), [Order refunds](https://docs.bigcommerce.com/developer/docs/admin/checkout-and-cart/orders/refunds).
