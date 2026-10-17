# Clerk workflow and remaining vendors

Install `skills/inventory-clerk/SKILL.md` for the operating agent. The npm package includes it; the plugin continues to use Gmail only through the agent's connector.

Amazon and Formlabs recognise the vendor and parse explicitly labelled item blocks (`ASIN` or `SKU`, quantity, unit price, line total), order number and one merchandise subtotal. Fixtures are entirely synthetic and define the supported plain-text layout; they are not captured production emails. No live Gmail sample was used in this phase. Missing identifiers, title-only items, unfamiliar layouts and shipment subsets require review. Do not rewrite source messages into fixture format to make them pass.

Amazon requires an order confirmation and refuses shipment/split-order notices even if the subset reconciles. A changed email under an existing vendor/order number still uses the core conflict review path. A shipment is never a second purchase; use receipt delivery references for physical split deliveries.

Regression coverage includes model/parser quantity disagreement, missing identifiers, split-order refusal with no parts/orders/ledger writes, duplicate intake and shipment, and email → verification → receipt → Sheet write → versioned BOM → reservation → shipment → sellable. Integration tests use real disposable Postgres and synthetic adapters for Sheet/config/catalog. They do not claim live Gmail, Google or BigCommerce verification.

After Reed's review, Quinn must run the plugin and phase acceptance checks. Mike verifies the reviewed SHA, QA agreement and actual PR merge, then sends the authorized end-to-end test notification to Tony through the configured Home Assistant webhook. Do not close this phase with an open PR.
