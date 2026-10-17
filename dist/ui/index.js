// src/ui/index.tsx
import { useState } from "react";
import { usePluginData, usePluginAction, useHostNavigation, useHostLocation } from "@paperclipai/plugin-sdk/ui";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var pages = ["inventory", "counts", "receiving", "review", "settings"];
var label = (s) => ({ inventory: "Inventory", counts: "Physical Counts", receiving: "Receiving", review: "Needs Review", settings: "Settings" })[s] ?? s;
function Table({ rows, columns }) {
  return /* @__PURE__ */ jsxs("div", { style: { overflowX: "auto" }, children: [
    /* @__PURE__ */ jsxs("table", { style: { width: "100%", borderCollapse: "collapse", textAlign: "left" }, children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsx("tr", { children: columns.map(([key, title]) => /* @__PURE__ */ jsx("th", { style: { padding: 8, borderBottom: "1px solid #888" }, children: title }, key)) }) }),
      /* @__PURE__ */ jsx("tbody", { children: rows.map((r, i) => /* @__PURE__ */ jsx("tr", { children: columns.map(([key]) => /* @__PURE__ */ jsx("td", { style: { padding: 8, borderBottom: "1px solid #8884" }, children: String(r[key] ?? "\u2014") }, key)) }, r.id ?? r.partId ?? i)) })
    ] }),
    !rows.length && /* @__PURE__ */ jsx("p", { children: "No records." })
  ] });
}
function Field({ name, children }) {
  return /* @__PURE__ */ jsxs("label", { style: { display: "inline-flex", flexDirection: "column", gap: 4, margin: "6px 12px 6px 0" }, children: [
    name,
    children
  ] });
}
function History({ partId }) {
  const { data, loading, error } = usePluginData("inventory_page", { page: "history", partId });
  return /* @__PURE__ */ jsxs("section", { children: [
    /* @__PURE__ */ jsx("h3", { children: "Part history" }),
    loading && /* @__PURE__ */ jsx("p", { children: "Loading\u2026" }),
    error && /* @__PURE__ */ jsx("p", { role: "alert", children: error.message }),
    /* @__PURE__ */ jsx(Table, { rows: data?.entries ?? [], columns: [["created_at", "Time"], ["entry_type", "Type"], ["quantity_delta", "Quantity"], ["reference", "Reference"], ["created_by", "Recorded by"], ["note", "Reason"]] })
  ] });
}
function InventoryPage() {
  const location = useHostLocation();
  const initial = new URLSearchParams(location.search);
  const [page, setPage] = useState(() => pages.includes(initial.get("page")) ? initial.get("page") : "inventory");
  const [search, setSearch] = useState(""), [vendor, setVendor] = useState(""), [active, setActive] = useState("true"), [lowStock, setLowStock] = useState(initial.get("lowStock") === "true");
  const [orderId, setOrderId] = useState("");
  const query = usePluginData("inventory_page", { page, search, ...vendor ? { vendor } : {}, active, lowStock, ...orderId ? { orderId } : {} });
  const action = usePluginAction("inventory_action");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reason, setReason] = useState(""), [draft, setDraft] = useState({}), [preview, setPreview] = useState(null);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState(null), [history, setHistory] = useState("");
  const [shipment, setShipment] = useState(""), [corrections, setCorrections] = useState("");
  async function run(operation, input = {}, done) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await action({ operation, ...input });
      done?.(r);
      query.refresh();
      setNotice(r.status ? `Count ${r.status}.` : r.duplicate ? "Already recorded." : "Saved.");
    } catch (e) {
      setError(e.message ?? "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  function reset(next) {
    setPage(next);
    setPreview(null);
    setSelected(null);
    setHistory("");
    setDraft({});
    setReason("");
    setError("");
    setNotice("");
    setSubmissionKey(crypto.randomUUID());
  }
  const data = query.data;
  const parts = data?.parts ?? [];
  const change = (id, value) => {
    setDraft((d) => ({ ...d, [id]: value }));
    setPreview(null);
  };
  const lines = () => Object.entries(draft).filter(([, v]) => v !== "").map(([partId, value]) => ({ partId, [page === "receiving" ? "quantity" : "counted"]: Number(value) }));
  return /* @__PURE__ */ jsxs("main", { style: { padding: 24, fontFamily: "system-ui", maxWidth: 1400 }, children: [
    /* @__PURE__ */ jsx("h1", { children: "Inventory" }),
    /* @__PURE__ */ jsx("nav", { "aria-label": "Inventory pages", style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: pages.map((p) => /* @__PURE__ */ jsx("button", { disabled: busy, "aria-pressed": page === p, onClick: () => reset(p), children: label(p) }, p)) }),
    /* @__PURE__ */ jsx("h2", { children: label(page) }),
    query.loading && /* @__PURE__ */ jsx("p", { role: "status", children: "Loading\u2026" }),
    (error || query.error) && /* @__PURE__ */ jsx("p", { role: "alert", children: error || query.error?.message }),
    notice && /* @__PURE__ */ jsx("p", { role: "status", children: notice }),
    page === "inventory" && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(Field, { name: "Search parts", children: /* @__PURE__ */ jsx("input", { value: search, onChange: (e) => setSearch(e.target.value) }) }),
      /* @__PURE__ */ jsx(Field, { name: "Vendor", children: /* @__PURE__ */ jsx("input", { value: vendor, onChange: (e) => setVendor(e.target.value) }) }),
      /* @__PURE__ */ jsx(Field, { name: "Status", children: /* @__PURE__ */ jsxs("select", { value: active, onChange: (e) => setActive(e.target.value), children: [
        /* @__PURE__ */ jsx("option", { value: "all", children: "All" }),
        /* @__PURE__ */ jsx("option", { value: "true", children: "Active" }),
        /* @__PURE__ */ jsx("option", { value: "false", children: "Inactive" })
      ] }) }),
      /* @__PURE__ */ jsx(Field, { name: "Low stock only", children: /* @__PURE__ */ jsx("input", { type: "checkbox", checked: lowStock, onChange: (e) => setLowStock(e.target.checked) }) }),
      /* @__PURE__ */ jsx(Table, { rows: parts, columns: [["vendor", "Vendor"], ["vendor_part_number", "Part"], ["description", "Description"], ["on_hand", "On hand"], ["committed", "Committed"], ["on_order", "On order"], ["available", "Available"], ["lastCost", "Last cost"], ["averageCost", "Average cost"], ["lastOrdered", "Last ordered"], ["location", "Location"]] }),
      /* @__PURE__ */ jsx(Field, { name: "Edit part or view history", children: /* @__PURE__ */ jsxs("select", { value: selected?.partId ?? "", onChange: (e) => {
        const p = parts.find((p2) => p2.partId === e.target.value) ?? null;
        setSelected(p);
        setHistory(p?.partId ?? "");
      }, children: [
        /* @__PURE__ */ jsx("option", { value: "", children: "Choose part" }),
        parts.map((p) => /* @__PURE__ */ jsxs("option", { value: p.partId, children: [
          p.vendor,
          ":",
          p.vendor_part_number
        ] }, p.partId))
      ] }) }),
      selected && /* @__PURE__ */ jsxs("form", { onSubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run("edit_part", { partId: selected.partId, revision: selected.revision, reorderPoint: Number(f.get("reorder")), targetQuantity: Number(f.get("target")), location: f.get("location"), notes: f.get("notes"), active: f.get("active") === "on", reason: f.get("reason") }, () => setSelected(null));
      }, children: [
        /* @__PURE__ */ jsx(Field, { name: "Reorder point", children: /* @__PURE__ */ jsx("input", { name: "reorder", type: "number", min: "0", step: "0.0001", defaultValue: selected.reorderPoint, required: true }) }),
        /* @__PURE__ */ jsx(Field, { name: "Target quantity", children: /* @__PURE__ */ jsx("input", { name: "target", type: "number", min: "0", step: "0.0001", defaultValue: selected.targetQuantity, required: true }) }),
        /* @__PURE__ */ jsx(Field, { name: "Location", children: /* @__PURE__ */ jsx("input", { name: "location", defaultValue: selected.location }) }),
        /* @__PURE__ */ jsx(Field, { name: "Notes", children: /* @__PURE__ */ jsx("textarea", { name: "notes", defaultValue: selected.notes }) }),
        /* @__PURE__ */ jsx(Field, { name: "Active", children: /* @__PURE__ */ jsx("input", { name: "active", type: "checkbox", defaultChecked: selected.active }) }),
        /* @__PURE__ */ jsx(Field, { name: "Change reason", children: /* @__PURE__ */ jsx("input", { name: "reason", required: true }) }),
        /* @__PURE__ */ jsx("button", { disabled: busy, children: "Save part" })
      ] }, selected.partId + selected.revision),
      history && /* @__PURE__ */ jsx(History, { partId: history })
    ] }),
    page === "counts" && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(CountEntry, { draft, change }),
      /* @__PURE__ */ jsx(Field, { name: "Count reason", children: /* @__PURE__ */ jsx("input", { value: reason, onChange: (e) => {
        setReason(e.target.value);
        setPreview(null);
      }, required: true }) }),
      /* @__PURE__ */ jsx("button", { disabled: busy || !reason || !lines().length, onClick: () => void run("preview_count", { lines: lines() }, (r) => setPreview(r)), children: "Preview batch" }),
      preview && /* @__PURE__ */ jsxs("section", { children: [
        /* @__PURE__ */ jsx(Table, { rows: preview.lines, columns: [["partId", "Part"], ["expected", "Expected"], ["counted", "Counted"], ["discrepancy", "Difference"], ["ledgerRevision", "Ledger revision"]] }),
        /* @__PURE__ */ jsxs("p", { children: [
          preview.requiresApproval ? "Human approval required." : "Within configured automatic approval thresholds.",
          " All lines apply atomically."
        ] }),
        /* @__PURE__ */ jsx("button", { disabled: busy, onClick: () => void run("submit_count", { lines: preview.lines, reason, submissionKey }, () => {
          setPreview(null);
          setDraft({});
          setSubmissionKey(crypto.randomUUID());
        }), children: "Submit count" })
      ] }),
      /* @__PURE__ */ jsx(CountDecisions, { counts: data?.counts ?? [], busy, decide: (operation, input) => void run(operation, input) })
    ] }),
    page === "receiving" && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(Field, { name: "Order", children: /* @__PURE__ */ jsxs("select", { value: orderId, onChange: (e) => {
        setOrderId(e.target.value);
        setDraft({});
        setPreview(null);
      }, children: [
        /* @__PURE__ */ jsx("option", { value: "", children: "Choose order" }),
        (data?.orders ?? []).map((o) => /* @__PURE__ */ jsxs("option", { value: o.id, children: [
          o.vendor,
          " \u2014 ",
          o.vendor_order_number
        ] }, o.id))
      ] }) }),
      orderId && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(Table, { rows: data?.lines ?? [], columns: [["vendorPartNumber", "Part"], ["ordered", "Ordered"], ["received", "Previously received"], ["closed", "Short closed"], ["outstanding", "Outstanding"]] }),
        (data?.lines ?? []).map((l) => /* @__PURE__ */ jsx(Field, { name: `Receive ${l.vendorPartNumber}`, children: /* @__PURE__ */ jsx("input", { type: "number", min: "0.0001", step: "0.0001", value: draft[l.partId] ?? "", onChange: (e) => change(l.partId, e.target.value) }) }, l.partId)),
        /* @__PURE__ */ jsx(Field, { name: "Shipment reference", children: /* @__PURE__ */ jsx("input", { value: shipment, onChange: (e) => {
          setShipment(e.target.value);
          setPreview(null);
        } }) }),
        /* @__PURE__ */ jsx(Field, { name: "Receipt / overage reason", children: /* @__PURE__ */ jsx("input", { value: reason, onChange: (e) => {
          setReason(e.target.value);
          setPreview(null);
        } }) }),
        /* @__PURE__ */ jsx("button", { disabled: busy || !shipment || !lines().length, onClick: () => void run("preview_receipt", { orderId, shipmentReference: shipment, reason, lines: lines() }, setPreview), children: "Preview receipt" }),
        preview && /* @__PURE__ */ jsxs("section", { children: [
          /* @__PURE__ */ jsx(Table, { rows: preview.lines, columns: [["vendorPartNumber", "Part"], ["quantity", "Receiving"], ["outstanding", "Outstanding"], ["overage", "Overage"]] }),
          /* @__PURE__ */ jsx("button", { disabled: busy, onClick: () => void run("confirm_receipt", { previewId: preview.previewId }, () => {
            setPreview(null);
            setDraft({});
          }), children: "Confirm receipt" })
        ] }),
        /* @__PURE__ */ jsx("h3", { children: "Short close outstanding lines" }),
        /* @__PURE__ */ jsx("p", { children: "Record undelivered quantities separately from receipts. A reason is required." }),
        (data?.lines ?? []).filter((l) => l.outstanding > 0).map((l) => /* @__PURE__ */ jsxs("button", { disabled: busy || !reason, onClick: () => void run("short_close", { orderId, partId: l.partId, outstanding: l.outstanding, ledgerRevision: l.ledgerRevision, submissionKey: crypto.randomUUID(), reason }), children: [
          "Short close ",
          l.vendorPartNumber,
          ": ",
          l.outstanding
        ] }, l.partId))
      ] }),
      /* @__PURE__ */ jsx("h3", { children: "Receipt history" }),
      /* @__PURE__ */ jsx(Table, { rows: data?.history ?? [], columns: [["shipment_reference", "Shipment"], ["applied_at", "Confirmed"], ["reason", "Reason"]] }),
      /* @__PURE__ */ jsx("h3", { children: "Short close history" }),
      /* @__PURE__ */ jsx(Table, { rows: data?.shortCloses ?? [], columns: [["created_at", "Time"], ["part_id", "Part"], ["quantity", "Quantity"], ["reason", "Reason"]] })
    ] }),
    page === "review" && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(CountDecisions, { counts: data?.counts ?? [], busy, decide: (op, input) => void run(op, input) }),
      (data?.items ?? []).map((item) => /* @__PURE__ */ jsxs("section", { style: { borderTop: "1px solid #888", padding: 12 }, children: [
        /* @__PURE__ */ jsxs("h3", { children: [
          item.vendor,
          " \u2014 ",
          item.status
        ] }),
        /* @__PURE__ */ jsx("p", { children: typeof item.reason === "string" ? item.reason : JSON.stringify(item.reasons ?? item.reason) }),
        /* @__PURE__ */ jsxs("details", { children: [
          /* @__PURE__ */ jsx("summary", { children: "Extraction and provenance" }),
          /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap" }, children: JSON.stringify({ agent: item.agent_extraction, parser: item.parser_extraction, provenance: item.intake_provenance, resolvedBy: item.resolved_by, resolvedAt: item.resolved_at, note: item.resolution_note }, null, 2) })
        ] }),
        item.status === "open" && /* @__PURE__ */ jsxs("form", { onSubmit: (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          let correction;
          try {
            correction = corrections ? JSON.parse(corrections) : void 0;
          } catch {
            setError("Corrections must be valid JSON.");
            return;
          }
          void run("resolve_review", { reviewItemId: item.id, resolution: f.get("resolution"), note: f.get("note"), ...correction ? { corrections: correction } : {} });
        }, children: [
          /* @__PURE__ */ jsx(Field, { name: "Resolution", children: /* @__PURE__ */ jsxs("select", { name: "resolution", children: [
            /* @__PURE__ */ jsx("option", { value: "accept", children: "Approve verified extraction" }),
            /* @__PURE__ */ jsx("option", { value: "accept_with_corrections", children: "Resolve with corrections" }),
            /* @__PURE__ */ jsx("option", { value: "reject", children: "Reject" })
          ] }) }),
          /* @__PURE__ */ jsx(Field, { name: "Decision reason", children: /* @__PURE__ */ jsx("input", { name: "note", required: true }) }),
          /* @__PURE__ */ jsx(Field, { name: "Corrected extraction (JSON, if needed)", children: /* @__PURE__ */ jsx("textarea", { value: corrections, onChange: (e) => setCorrections(e.target.value) }) }),
          /* @__PURE__ */ jsx("button", { disabled: busy, children: "Save decision" })
        ] })
      ] }, item.id))
    ] }),
    page === "settings" && data && /* @__PURE__ */ jsxs("form", { onSubmit: (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void run("save_settings", { settings: { enabledVendors: f.getAll("vendor"), approvalMode: f.get("approvalMode"), absoluteThreshold: Number(f.get("absoluteThreshold")), percentThreshold: Number(f.get("percentThreshold")), approverUserIds: String(f.get("approvers") ?? "").split(/[\n,]/).map((v) => v.trim()).filter(Boolean), allowSelfApproval: f.get("self") === "on" }, revision: data.revision, reason });
    }, children: [
      /* @__PURE__ */ jsxs("fieldset", { children: [
        /* @__PURE__ */ jsx("legend", { children: "Enabled vendors" }),
        ["mcmaster", "sendcutsend", "amazon", "formlabs"].map((v) => /* @__PURE__ */ jsx(Field, { name: v, children: /* @__PURE__ */ jsx("input", { name: "vendor", type: "checkbox", value: v, defaultChecked: data.settings.enabledVendors?.includes(v) }) }, v))
      ] }),
      /* @__PURE__ */ jsx(Field, { name: "Adjustment approval", children: /* @__PURE__ */ jsxs("select", { name: "approvalMode", defaultValue: data.settings.approvalMode, children: [
        /* @__PURE__ */ jsx("option", { value: "all", children: "Review every discrepancy" }),
        /* @__PURE__ */ jsx("option", { value: "threshold", children: "Apply within thresholds automatically" })
      ] }) }),
      /* @__PURE__ */ jsx(Field, { name: "Absolute quantity threshold", children: /* @__PURE__ */ jsx("input", { type: "number", name: "absoluteThreshold", min: "0", step: "0.0001", defaultValue: data.settings.absoluteThreshold, required: true }) }),
      /* @__PURE__ */ jsx(Field, { name: "Percentage threshold", children: /* @__PURE__ */ jsx("input", { type: "number", name: "percentThreshold", min: "0", step: "0.0001", defaultValue: data.settings.percentThreshold, required: true }) }),
      /* @__PURE__ */ jsx("p", { children: "Threshold mode requires approval when either threshold is exceeded. Discrepancies against zero expected stock require approval." }),
      /* @__PURE__ */ jsx(Field, { name: "Approver user IDs (one per line; leave empty for any authorized human)", children: /* @__PURE__ */ jsx("textarea", { name: "approvers", rows: 4, defaultValue: data.settings.approverUserIds?.join("\n") ?? "" }) }),
      /* @__PURE__ */ jsx(Field, { name: "Allow submitters to approve their own counts", children: /* @__PURE__ */ jsx("input", { name: "self", type: "checkbox", defaultChecked: data.settings.allowSelfApproval }) }),
      /* @__PURE__ */ jsx(Field, { name: "Change reason", children: /* @__PURE__ */ jsx("input", { value: reason, onChange: (e) => setReason(e.target.value), required: true }) }),
      /* @__PURE__ */ jsx("button", { disabled: busy, children: "Save settings" }),
      /* @__PURE__ */ jsx("h3", { children: "Settings history" }),
      /* @__PURE__ */ jsx(Table, { rows: data.history ?? [], columns: [["created_at", "Time"], ["reason", "Reason"], ["operation", "Operation"]] })
    ] }, data.revision)
  ] });
}
function CountEntry({ draft, change }) {
  const { data, error } = usePluginData("inventory_page", { page: "inventory", active: "true" });
  return /* @__PURE__ */ jsxs("section", { children: [
    /* @__PURE__ */ jsx("p", { children: "Enter observed quantities, then preview the entire batch." }),
    error && /* @__PURE__ */ jsx("p", { role: "alert", children: error.message }),
    (data?.parts ?? []).map((p) => /* @__PURE__ */ jsx(Field, { name: `${p.vendor}:${p.vendor_part_number} \u2014 ${p.description}`, children: /* @__PURE__ */ jsx("input", { "aria-label": `Count ${p.vendor}:${p.vendor_part_number}`, type: "number", min: "0", step: "0.0001", value: draft[p.partId] ?? "", onChange: (e) => change(p.partId, e.target.value) }) }, p.partId))
  ] });
}
function CountDecisions({ counts, busy, decide }) {
  return /* @__PURE__ */ jsxs("section", { children: [
    /* @__PURE__ */ jsx("h3", { children: "Count submissions" }),
    counts.map((c) => /* @__PURE__ */ jsxs("section", { style: { borderTop: "1px solid #888", padding: 12 }, children: [
      /* @__PURE__ */ jsxs("p", { children: [
        c.status,
        " \xB7 ",
        c.submitted_at,
        " \xB7 ",
        c.submitted_by?.id,
        " \xB7 ",
        c.reason
      ] }),
      /* @__PURE__ */ jsx(Table, { rows: c.lines, columns: [["vendorPartNumber", "Part"], ["expected", "Expected"], ["counted", "Counted"], ["ledger_revision", "Revision"], ["ledger_entry_id", "Adjustment"]] }),
      c.status === "pending" ? /* @__PURE__ */ jsxs("form", { onSubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const submitter = e.nativeEvent.submitter;
        decide(submitter.value, { countId: c.id, reason: f.get("reason") });
      }, children: [
        /* @__PURE__ */ jsx(Field, { name: "Decision reason", children: /* @__PURE__ */ jsx("input", { name: "reason", required: true }) }),
        /* @__PURE__ */ jsx("button", { value: "approve_count", disabled: busy, children: "Approve batch" }),
        /* @__PURE__ */ jsx("button", { value: "reject_count", disabled: busy, children: "Reject batch" })
      ] }) : /* @__PURE__ */ jsxs("p", { children: [
        c.decided_by?.id,
        " \xB7 ",
        c.decided_at,
        " \xB7 ",
        c.decision_reason
      ] })
    ] }, c.id))
  ] });
}
function InventorySidebar() {
  const nav = useHostNavigation();
  return /* @__PURE__ */ jsx("a", { ...nav.linkProps("/inventory"), children: "Inventory" });
}
function InventoryDashboard() {
  const { data, loading, error } = usePluginData("inventory_page", { page: "dashboard" });
  const nav = useHostNavigation();
  return /* @__PURE__ */ jsxs("section", { children: [
    /* @__PURE__ */ jsx("h3", { children: "Inventory" }),
    loading && /* @__PURE__ */ jsx("p", { children: "Loading\u2026" }),
    error && /* @__PURE__ */ jsx("p", { role: "alert", children: error.message }),
    data && /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsxs("p", { children: [
      /* @__PURE__ */ jsxs("a", { ...nav.linkProps("/inventory?lowStock=true"), children: [
        data.lowStock,
        " low-stock parts"
      ] }),
      " \xB7 ",
      /* @__PURE__ */ jsxs("a", { ...nav.linkProps("/inventory?page=counts"), children: [
        data.pendingCounts,
        " pending counts"
      ] }),
      " \xB7 ",
      /* @__PURE__ */ jsxs("a", { ...nav.linkProps("/inventory?page=review"), children: [
        data.pendingReviews,
        " reviews"
      ] }),
      " \xB7 ",
      /* @__PURE__ */ jsxs("a", { ...nav.linkProps("/inventory"), children: [
        data.negativeStock,
        " negative-stock alerts"
      ] })
    ] }) })
  ] });
}
export {
  InventoryDashboard,
  InventoryPage,
  InventorySidebar
};
//# sourceMappingURL=index.js.map
