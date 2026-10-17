import type {
  PluginContext,
  ToolRunContext,
  ToolResult,
} from "@paperclipai/plugin-sdk";
import type { PoolClient } from "pg";
import type { DatabaseHandle } from "./db.js";
import { InputError } from "./errors.js";
import { selectLines, type OptionSelection } from "./bom.js";
import { readActiveBom } from "./sales.js";
import { submitAdjustmentBatch } from "./native-service.js";
import { appendEntry } from "./ledger.js";
import { parsePartRef } from "./parts.js";
import { openStore } from "./storage.js";
import { bigcommerceClient } from "./bigcommerce.js";

export interface OrderLineSnapshot {
  orderId: string;
  lineId: string;
  catalogKey: string;
  options: OptionSelection[];
  ordered: number;
  shipped: number;
  refunded: number;
  cancelled: boolean;
  observedAt: string;
}
interface ExpandedPart {
  part: string;
  quantity: number;
}
const round = (n: number) => Math.round(n * 10000) / 10000;
const canonicalOptions = (options: OptionSelection[]) =>
  [...options].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );

export async function applyOrderLine(
  db: DatabaseHandle,
  input: OrderLineSnapshot,
  run: ToolRunContext,
  dryRun = false,
) {
  for (const n of [input.ordered, input.shipped, input.refunded]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000)
      throw new InputError("Invalid order quantities.");
  }
  if (
    !input.ordered ||
    input.shipped > input.ordered ||
    input.refunded > input.ordered ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new InputError("Invalid order snapshot.");
  }
  return db.transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('inventory-bigcommerce-lines'))",
    );
    const found = await client.query(
      "SELECT * FROM bigcommerce_lines WHERE order_id=$1 AND line_id=$2 FOR UPDATE",
      [input.orderId, input.lineId],
    );
    const prior = found.rows[0];
    const snapshot = {
      ...input,
      options: canonicalOptions(input.options),
      observedAt: new Date(input.observedAt).toISOString(),
    };
    if (
      prior &&
      Date.parse(input.observedAt) < new Date(prior.observed_at).getTime()
    )
      return { stale: true };
    const identity = {
      catalogKey: input.catalogKey,
      ordered: input.ordered,
      options: canonicalOptions(input.options),
    };
    let expansion: ExpandedPart[];
    let bomId: string;
    if (prior) {
      if (
        prior.identity.catalogKey !== identity.catalogKey ||
        prior.identity.ordered !== identity.ordered ||
        JSON.stringify(
          prior.identity.options.map((o: OptionSelection) => [
            o.option,
            o.value,
          ]),
        ) !== JSON.stringify(identity.options.map((o) => [o.option, o.value]))
      ) {
        throw new InputError(
          "An existing order line changed product, quantity or options; resolve it explicitly before reconciliation.",
        );
      }
      if (Date.parse(input.observedAt) === new Date(prior.observed_at).getTime()) {
        // BigCommerce timestamps have second precision. Compare cumulative
        // progress rather than treating every different same-second read as a
        // conflict. Never merge incomparable observations into invented state.
        const before = [
          Number(prior.shipped),
          Number(prior.refunded),
          Number(prior.snapshot.cancelled),
        ];
        const after = [input.shipped, input.refunded, Number(input.cancelled)];
        if (after.every((value, i) => value === before[i]))
          return { duplicate: true };
        if (after.every((value, i) => value <= before[i]!))
          return { stale: true };
        if (!after.every((value, i) => value >= before[i]!))
          throw new InputError(
            "Conflicting order snapshots at the same modification time; resolve incomparable progress explicitly.",
          );
      }
      if (
        input.shipped < prior.shipped ||
        input.refunded < prior.refunded ||
        (prior.closed && !input.cancelled && input.refunded !== input.ordered)
      ) {
        throw new InputError(
          "Order counters or terminal state regressed; nothing changed.",
        );
      }
      expansion = prior.expansion;
      bomId = prior.bom_id;
    } else {
      const active = await readActiveBom(client, input.catalogKey);
      if (!active)
        throw new InputError(
          `No active BOM for ${input.catalogKey}; order reconciliation stopped.`,
        );
      const chosen = selectLines(active.bom, input.options);
      if (
        chosen.missing.length ||
        chosen.conflicting.length ||
        chosen.unmatched.length ||
        !chosen.lines.length
      )
        throw new InputError(
          "Order options do not resolve exactly against the active BOM.",
        );
      const parts = new Map<string, number>();
      for (const line of chosen.lines)
        parts.set(line.part!, round((parts.get(line.part!) ?? 0) + line.qty!));
      expansion = [...parts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([part, quantity]) => ({ part, quantity }));
      bomId = active.bomId;
    }
    const closed = input.cancelled || input.refunded === input.ordered;
    // Refunded units reverse shipped units first; any remainder releases commitments.
    const reversed = input.cancelled
      ? input.shipped
      : Math.min(input.shipped, input.refunded);
    const committed = closed
      ? 0
      : Math.max(
          0,
          input.ordered -
            input.shipped -
            Math.max(0, input.refunded - input.shipped),
        );
    if (dryRun)
      return {
        preview: true,
        committed,
        shipped: input.shipped,
        reversed,
        bomId,
      };
    // Match the count service lock order before taking shared stock locks.
    await client.query('SELECT singleton FROM operational_settings WHERE singleton=true FOR UPDATE');
    // All paths lock shared parts in one order, matching appendEntry's locks.
    const resolved = await client.query(
      `SELECT id,vendor,vendor_part_number FROM parts ORDER BY id FOR UPDATE`,
    );
    const ids = new Map(
      resolved.rows.map((p) => [
        `${p.vendor}:${p.vendor_part_number}`.toLowerCase(),
        p.id,
      ]),
    );
    const credit = reversed - Number(prior?.reversed ?? 0);
    if (credit > 0) {
      const deltas=expansion.map(part=>{
        const partId=ids.get(part.part.toLowerCase());
        if(!partId)throw new InputError("Pinned BOM part no longer exists.");
        return {partId,quantity:round(credit*part.quantity)};
      });
      const adjustment=await submitAdjustmentBatch(db,client,{type:'agent',id:run.agentId,companyId:run.companyId},deltas,
        JSON.stringify(['bc-refund',input.orderId,input.lineId,reversed]),
        `BigCommerce refund ${input.orderId}/${input.lineId}: ${reversed} returned units; BOM ${bomId}`);
      if(adjustment.status!=='applied')return {pendingApproval:true,...adjustment};
    }
    for (const part of expansion) {
      const id = ids.get(part.part.toLowerCase());
      if (!id) throw new InputError("Pinned BOM part no longer exists.");
      const provenance = {
        source: "reconcile_bigcommerce",
        ...run,
        orderId: input.orderId,
        lineId: input.lineId,
        bomId,
        observedAt: input.observedAt,
      };
      const consumed = input.shipped - Number(prior?.shipped ?? 0);
      if (consumed > 0)
        await appendEntry(
          db,
          {
            part: parsePartRef(part.part),
            entryType: "sale",
            quantity: round(consumed * part.quantity),
            reference: JSON.stringify([
              input.orderId,
              input.lineId,
              "shipped",
              input.shipped,
            ]),
            idempotencyScope: ["bc-shipment"],
            provenance,
            createdBy: run.agentId,
          },
          client,
        );
      await client.query(
        `INSERT INTO reservations(part_id,quantity,bigcommerce_order_id,bigcommerce_line_id,status,bom_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(bigcommerce_order_id,bigcommerce_line_id,part_id)
        DO UPDATE SET quantity=EXCLUDED.quantity,status=EXCLUDED.status,updated_at=now()`,
        [
          id,
          round((committed || input.ordered) * part.quantity),
          input.orderId,
          input.lineId,
          committed
            ? "committed"
            : input.shipped > reversed
              ? "consumed"
              : "released",
          bomId,
        ],
      );
    }
    await client.query(
      `INSERT INTO bigcommerce_lines(order_id,line_id,catalog_key,bom_id,identity,expansion,ordered,shipped,refunded,reversed,closed,observed_at,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(order_id,line_id) DO UPDATE SET shipped=EXCLUDED.shipped,refunded=EXCLUDED.refunded,reversed=EXCLUDED.reversed,closed=EXCLUDED.closed,observed_at=EXCLUDED.observed_at,snapshot=EXCLUDED.snapshot`,
      [
        input.orderId,
        input.lineId,
        input.catalogKey,
        bomId,
        JSON.stringify(identity),
        JSON.stringify(expansion),
        input.ordered,
        input.shipped,
        input.refunded,
        reversed,
        closed,
        input.observedAt,
        JSON.stringify(snapshot),
      ],
    );
    return { committed, shipped: input.shipped, reversed, bomId };
  });
}

export async function sellableInTransaction(
  client: PoolClient,
  key?: string,
  options?: OptionSelection[],
) {
  const keys = key
    ? [key]
    : (
        await client.query(
          "SELECT DISTINCT catalog_key FROM boms ORDER BY catalog_key",
        )
      ).rows.map((r) => r.catalog_key as string);
  const products: {
    catalogKey: string;
    quantity: number;
    options: OptionSelection[];
  }[] = [];
  for (const catalogKey of keys) {
    const active = await readActiveBom(client, catalogKey);
    if (!active) throw new InputError(`No active BOM for ${catalogKey}.`);
    // Without a selection, publish the conservative minimum across every
    // combination. A shared part's base and selected option quantities add.
    let selections: OptionSelection[][] = [[]];
    for (const name of new Set(
      active.bom.optionScopes.map((s) => s.optionName),
    )) {
      const values = active.bom.optionScopes.filter(
        (s) => s.optionName === name,
      );
      if (selections.length * values.length > 1000)
        throw new InputError(
          "Too many BOM option combinations; query explicit options.",
        );
      selections = selections.flatMap((s) =>
        values.map((v) => [...s, { option: name, value: v.optionValue }]),
      );
    }
    if (options) selections = [options];
    let minimum = Number.MAX_SAFE_INTEGER;
    for (const selection of selections) {
      const chosen = selectLines(active.bom, selection);
      if (
        chosen.missing.length ||
        chosen.unmatched.length ||
        chosen.conflicting.length
      )
        throw new InputError("Sellable options do not match the BOM.");
      const totals = new Map<string, number>();
      for (const line of chosen.lines)
        totals.set(
          line.part!,
          round((totals.get(line.part!) ?? 0) + line.qty!),
        );
      for (const [ref, qty] of totals) {
        const part = parsePartRef(ref);
        if (part.kind !== "vendor") throw new InputError("Invalid BOM part.");
        const stock = await client.query(
          "SELECT available FROM part_stock WHERE vendor=$1 AND lower(vendor_part_number)=lower($2)",
          [part.vendor, part.vendorPartNumber],
        );
        minimum = Math.min(
          minimum,
          Math.max(
            0,
            Math.floor(
              Math.round(Number(stock.rows[0]?.available ?? 0) * 10000) /
                Math.round(qty * 10000),
            ),
          ),
        );
      }
    }
    products.push({
      catalogKey,
      quantity: minimum === Number.MAX_SAFE_INTEGER ? 0 : minimum,
      options: options ?? [],
    });
  }
  return products;
}
export async function getSellable(
  ctx: PluginContext,
  params: unknown,
  run: ToolRunContext,
): Promise<ToolResult> {
  const p = (params ?? {}) as {
    productSku?: string;
    options?: OptionSelection[];
  };
  const db = await openStore(ctx, run.companyId);
  const { parseSelections } = await import("./sales.js");
  const products = await db.transaction((c) =>
    sellableInTransaction(
      c,
      p.productSku,
      p.options === undefined ? undefined : parseSelections(p.options),
    ),
  );
  return {
    content: `Computed sellable quantities for ${products.length} products.`,
    data: { products },
  };
}

export async function pushStock(ctx: PluginContext, run: ToolRunContext) {
  const db = await openStore(ctx, run.companyId);
  const api = await bigcommerceClient(ctx, run.companyId);
  return flushStock(db, (key, quantity) => api.push(key, quantity));
}
export async function flushStock(
  db: DatabaseHandle,
  push: (key: string, quantity: number) => Promise<void>,
) {
  return db.transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('inventory-bigcommerce-push'))",
    );
    const pending = (
      await client.query("SELECT id FROM bigcommerce_stock_dirty")
    ).rows;
    if (!pending.length) return { pushed: 0 };
    const products = await sellableInTransaction(client);
    for (const product of products)
      await push(product.catalogKey, product.quantity);
    // Delete only the invalidations observed before calculating stock.
    await client.query(
      "DELETE FROM bigcommerce_stock_dirty WHERE id = ANY($1::bigint[])",
      [pending.map((r) => r.id)],
    );
    return { pushed: products.length };
  });
}

export async function reconcileBigcommerce(
  ctx: PluginContext,
  params: unknown,
  run: ToolRunContext,
): Promise<ToolResult> {
  const p = (params ?? {}) as { since?: string; dryRun?: boolean };
  if (p.dryRun !== undefined && typeof p.dryRun !== "boolean")
    throw new InputError("dryRun must be boolean.");
  const db = await openStore(ctx, run.companyId);
  const api = await bigcommerceClient(ctx, run.companyId);
  const saved = await db.query<{ cursor: string }>(
    "SELECT cursor FROM sync_state WHERE key='bigcommerce'",
  );
  const since = p.since ?? saved[0]?.cursor;
  if (!since || !Number.isFinite(Date.parse(since)))
    throw new InputError(
      "First reconciliation requires an explicit ISO since timestamp; choose the inventory opening boundary.",
    );
  const started = new Date(Date.now() - 60000).toISOString();
  const { snapshots, orderIds } = await api.orders(since);
  const known = await db.query<{ order_id: string; line_id: string }>(
    "SELECT order_id,line_id FROM bigcommerce_lines WHERE order_id=ANY($1::text[])",
    [orderIds],
  );
  const observed = new Set(
    snapshots.map((s) => JSON.stringify([s.orderId, s.lineId])),
  );
  if (known.some((s) => !observed.has(JSON.stringify([s.order_id, s.line_id]))))
    throw new InputError(
      "A previously reconciled physical order line disappeared; resolve it explicitly. Cursor unchanged.",
    );
  const results = [];
  for (const snapshot of snapshots)
    results.push(await applyOrderLine(db, snapshot, run, p.dryRun === true));
  if (p.dryRun)
    return {
      content: `Previewed ${results.length} order lines; nothing changed.`,
      data: { results, dryRun: true },
    };
  const stock = await pushStock(ctx, run);
  const pendingApproval=results.some(result => 'pendingApproval' in result && result.pendingApproval);
  if (!pendingApproval) await db.transaction(async (c) => {
    await c.query(
      `INSERT INTO sync_state(key,cursor) VALUES('bigcommerce',$1)
    ON CONFLICT(key) DO UPDATE SET cursor=GREATEST(sync_state.cursor,EXCLUDED.cursor),updated_at=now()`,
      [started],
    );
  });
  return {
    content: `Reconciled ${results.length} order lines.`,
    data: { results, ...stock, pendingApproval, cursor: pendingApproval ? since ?? null : started },
  };
}
