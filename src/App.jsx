import { useState, useEffect, useRef, useMemo } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTableImport from "jspdf-autotable";

// ─── API client ──────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api";
let _token = localStorage.getItem("oms_token") || "";

async function api(method, path, body, isFormData = false) {
  const opts = { method, headers: {} };
  if (_token) opts.headers.Authorization = `Bearer ${_token}`;
  if (body && !isFormData) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body;
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `Error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Theme ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#100e0c", bg2: "#16130f", surface: "#1c1813", surface2: "#241f18",
  border: "#2c2620", border2: "#3a3329",
  text: "#f5efe6", text2: "#b4aa9c", text3: "#7e7568",
  accent: "#f97316", accent2: "#fb923c",
  order: "#60a5fa", production: "#f97316", packing: "#f5b13a", ready: "#34d399",
  danger: "#ef4444", hold: "#eab308", green: "#34d399",
};
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Roboto Mono', Consolas, Menlo, monospace";

const STAGES = {
  order: { label: "Order", color: C.order },
  production: { label: "Production", color: C.production },
  packing: { label: "Packing", color: C.packing },
  ready_for_delivery: { label: "Ready for Delivery", color: C.ready },
};
const BOARD_STAGES = ["order", "production", "packing", "ready_for_delivery"];
const MAX_UPLOAD_MB = 5;
const FORWARD_STAGE = { order: "production", production: "packing", packing: "ready_for_delivery", ready_for_delivery: "delivered" };
const ADVANCE_LABEL = { order: "Send to production", production: "Mark production complete", packing: "Mark packed", ready_for_delivery: "Mark delivered" };
// Which roles can be the PIC at each stage (shown in the PIC picker).
const STAGE_PIC_ROLES = { order: ["operations_controller"], production: ["production_lead", "production_staff"], packing: ["packing_staff"], ready_for_delivery: ["delivery_team"] };
function canAdvanceStage(role, stage) {
  if (stage === "ready_for_delivery") return false; // completion happens in the Delivery workspace
  if (role === "super_admin" || role === "operations_controller") return true;
  if (role === "production_lead" && (stage === "production" || stage === "packing")) return true;
  if (stage === "production" && role === "production_staff") return true;
  if (stage === "packing" && role === "packing_staff") return true;
  return false;
}
// Whether a role may record STK progress on an order sitting in a given stage —
// mirrors the backend gate so staff don't see buttons that would only error.
// Managers anytime; staff only on the stage they own.
function canMarkStage(role, stage) {
  if (role === "super_admin" || role === "operations_controller") return true;
  if (role === "production_lead") return stage === "production" || stage === "packing";
  if (role === "production_staff") return stage === "production";
  if (role === "packing_staff") return stage === "packing";
  return false;
}
// Which board columns a role may see. Roles below production lead see only their own.
function visibleStages(role) {
  if (role === "production_staff") return ["production"];
  if (role === "packing_staff") return ["packing"];
  if (role === "delivery_team") return ["ready_for_delivery"];
  return BOARD_STAGES; // super_admin, operations_controller, production_lead
}
const STAGE_LABELS = {
  ...STAGES, on_hold: { label: "On Hold", color: C.hold },
  delivered: { label: "Delivered", color: C.text3 }, cancelled: { label: "Cancelled", color: "#6b7280" },
};
const ROLE_LABELS = {
  super_admin: "Boss", admin: "Admin", operations_controller: "Ops",
  production_lead: "Production Head", production_staff: "Production Staff",
  packing_staff: "Packing Staff", delivery_team: "Delivery Coordinator",
};
// Every role except the system-only Admin — for nav pages Admin shouldn't see.
const NON_ADMIN_ROLES = ["super_admin", "operations_controller", "production_lead", "production_staff", "packing_staff", "delivery_team"];
// The Order Board kanban is for the production-floor roles. The Delivery
// Coordinator works the Delivery workspace; on the board they would only see a
// single, non-actionable "Ready for Delivery" column that duplicates it, so they
// are excluded from the board and land in Delivery. (Floor Display stays for
// them — listed just below Delivery in the nav.)
const BOARD_ROLES = NON_ADMIN_ROLES.filter((r) => r !== "delivery_team");

// Reward scorecard / leaderboard — built 2026-06-10, parked for future. Flip to
// true to re-enable: the Reports "Scoreboard" tab, the Floor Display Board/Scoreboard
// toggle, and the System Settings weight editor all come back. The components
// (ScoreboardReport, FloorScoreboard), the weight settings code and the backend
// /reports/scorecard + system_settings weights stay in place, just unreachable.
const REWARD_SYSTEM_ENABLED = false;

// Customer importance tiers — mirrors the backend `importance` column (low → high).
// Production-floor roles see this in place of the customer name. To rename a tier,
// change the label here (and the CHECK values in schema.sql if you add/remove one).
const IMPORTANCE = {
  standard: { label: "Standard", color: C.text2 },
  priority: { label: "Priority", color: C.accent },
  vip: { label: "VIP", color: C.danger },
};
const IMPORTANCE_OPTS = [
  { value: "standard", label: "Standard" },
  { value: "priority", label: "Priority" },
  { value: "vip", label: "VIP" },
];
const impCfg = (level) => IMPORTANCE[level] || IMPORTANCE.standard;

// Delivery sub-status pill for Ready-for-Delivery cards (board + floor): once a
// delivery is scheduled the order reads "Pending", otherwise "Ready for Delivery".
// Colours mirror the Delivery tab (green ready, amber pending, blue in-transit).
function deliveryTag(o) {
  if (!o || o.stage !== "ready_for_delivery") return null;
  if (o.delivery_status === "pending") return { label: "Pending", color: C.packing };
  if (o.delivery_status === "in_transit") return { label: "In transit", color: C.order };
  return { label: "Ready for Delivery", color: C.ready };
}

const NAV = [
  { id: "board", label: "Order Board", icon: "board", roles: [...BOARD_ROLES, "admin"] },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", roles: ["super_admin", "operations_controller", "admin"] },
  { id: "delivery", label: "Delivery", icon: "truck", roles: ["super_admin", "operations_controller", "delivery_team", "admin"] },
  { id: "floor", label: "Floor Display", icon: "display" }, // every role; rendered as a distinct launch button, not a workspace tab
  { id: "reports", label: "Reports", icon: "chart", roles: ["super_admin", "operations_controller", "production_lead"] },
  { id: "messages", label: "Messages", icon: "message", roles: ["super_admin", "operations_controller"] },
  { id: "remarks", label: "Production Remarks", icon: "message", roles: ["super_admin", "production_lead"] },
  { id: "audit", label: "Audit Trail", icon: "audit", roles: ["super_admin", "admin"] },
  { id: "users", label: "User Management", icon: "users", roles: ["super_admin", "admin"] },
  { id: "settings", label: "System Settings", icon: "settings", roles: ["super_admin", "admin"] },
];
const PAGE_META = {
  board: ["Order Board", ""],
  dashboard: ["Dashboard", "Operations overview"],
  delivery: ["Delivery", "Schedule and dispatch"],
  reports: ["Reports", "Department performance"],
  messages: ["Messages", "WhatsApp customer updates & morning brief"],
  remarks: ["Production Remarks", "Weekly notes from the production lead"],
  audit: ["Audit Trail", "Every action, logged"],
  users: ["User Management", "Accounts, roles and access"],
  settings: ["System Settings", "Configuration"],
};

// ─── Date helpers ──────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const d = new Date(typeof s === "string" && s.length <= 10 ? s + "T00:00:00" : s);
  return isNaN(d) ? null : d;
}
function daysUntil(s) {
  const d = parseDate(s); if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  return Math.round((dd - t) / 86400000);
}
function fmtDay(s) {
  const d = parseDate(s); if (!d) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function countdown(s) {
  const n = daysUntil(s);
  if (n === null) return { text: "", tone: C.text3, n: null };
  if (n < 0) return { text: `${Math.abs(n)}d late`, tone: C.danger, n };
  if (n === 0) return { text: "today", tone: C.danger, n };
  if (n <= 2) return { text: `${n}d`, tone: C.danger, n };
  if (n <= 6) return { text: `${n}d`, tone: C.packing, n };
  return { text: `${n}d`, tone: C.ready, n };
}
// Items are tracked by status only (not_started → in_progress → done).
const ITEM_STATUS = {
  not_started: { k: "not_started", label: "Not started", short: "To do", color: C.text3 },
  in_progress: { k: "in_progress", label: "In progress", short: "Making", color: C.packing },
  done:        { k: "done", label: "Done", short: "Done", color: C.ready },
};
const ITEM_STATUS_ORDER = ["not_started", "in_progress", "done"];
function itemStatusKey(it) { return it.status || (it.made ? "done" : "not_started"); }
function itemStat(it) { return ITEM_STATUS[itemStatusKey(it)] || ITEM_STATUS.not_started; }
function StatusPicker({ value, onChange, disabled, big }) {
  return (
    <div style={{ display: big ? "flex" : "inline-flex", gap: big ? 8 : 4, flexWrap: "wrap", width: big ? "100%" : undefined }}>
      {ITEM_STATUS_ORDER.map((s) => {
        const cfg = ITEM_STATUS[s], active = value === s;
        return (
          <button key={s} type="button" disabled={disabled} onClick={() => !disabled && onChange(s)}
            title={active ? `Selected: ${cfg.label}` : `Set ${cfg.label}`}
            style={{ flex: big ? 1 : undefined, cursor: disabled ? "default" : "pointer",
              border: `1.5px solid ${active ? cfg.color : C.border2}`,
              background: active ? cfg.color : C.surface2,
              color: active ? C.bg : C.text3,
              boxShadow: active ? `0 0 0 2px ${cfg.color}44` : "none",
              borderRadius: big ? 9 : 7, padding: big ? "13px 8px" : "7px 12px",
              fontSize: big ? 14.5 : 12.5, fontWeight: active ? 800 : 600, whiteSpace: "nowrap",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, transition: "all .12s" }}>
            {active && <span aria-hidden style={{ fontWeight: 900 }}>✓</span>}
            {cfg.short}
          </button>
        );
      })}
    </div>
  );
}
function initials(name = "") {
  return name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((cell) => {
    const s = String(cell == null ? "" : cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function printPickingSlip(order) {
  const rows = (order.items || []).map((it) =>
    `<tr><td class="m">${escHtml(it.sku)}</td><td>${escHtml(it.name)}</td><td class="q">${Math.round(it.quantity)}</td><td>${escHtml(it.unit || "pcs")}</td><td class="chk">&#9744;</td></tr>`
  ).join("");
  const flame = '<svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="#231304" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c.5 3-1.8 4.7-3 6.2C7.7 10.4 7 11.9 7 13.6A5 5 0 0 0 17 14c0-2-1-3.7-2.5-5 .3 1.4-.3 2.4-1 2.9.6-2.4-.8-4.6-1.5-5.4-.2 1.5-1 2.2-1.7 2.8.5-2.3.7-4.7 1.7-6.8z"/></svg>';
  const html = (`<!doctype html><html><head><meta charset="utf-8"><title>Picking Slip ${escHtml(order.invoice_number)}</title>
<style>
  *{box-sizing:border-box} body{font:15.5px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:30px}
  .lh{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .mark{width:46px;height:46px;border-radius:13px;background:linear-gradient(145deg,#fb923c,#f97316);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.2);flex-shrink:0}
  .brand{font-size:23px;font-weight:800;letter-spacing:.5px} .doc{font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888}
  .inv{margin-left:auto;text-align:right;font-family:ui-monospace,Consolas,monospace;font-size:18px;font-weight:700}
  .rule{border:none;border-top:2px solid #f97316;margin:10px 0 18px}
  .meta{display:flex;gap:36px;flex-wrap:wrap;margin-bottom:16px} .meta div{font-size:15px} .meta b{display:block;color:#888;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:1px}
  .notes{margin:0 0 18px;padding:11px 14px;background:#f6f6f4;border:1px solid #e5e5e0;border-radius:8px;font-size:14.5px} .notes b{display:block;color:#888;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
  table{width:100%;border-collapse:collapse;margin-top:8px} th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left;font-size:15px}
  th{font-size:11.5px;text-transform:uppercase;color:#888;letter-spacing:.5px} .m{font-family:ui-monospace,Consolas,monospace;color:#555} .q{font-weight:800;text-align:right;font-size:16.5px} .chk{width:38px;text-align:center;font-size:23px}
  .sign{display:flex;gap:34px;margin-top:46px} .sign>div{flex:1} .sl{border-bottom:1.5px solid #999;height:34px;margin-bottom:7px} .lbl{font-size:12px;color:#666;font-weight:600}
  @media print{body{margin:12mm}}
</style></head><body>
  <div class="lh"><div class="mark">${flame}</div><div><div class="brand">WAWASAN CANDLE</div><div class="doc">Order Picking Slip</div></div><div class="inv">${escHtml(order.invoice_number)}</div></div>
  <hr class="rule"/>
  <div class="meta">
    <div><b>Customer</b>${escHtml(order.customer_name || impCfg(order.importance).label)}</div>
    <div><b>Delivery date</b>${escHtml(fmtDay(order.required_delivery_date))}</div>
    <div><b>Stage</b>${escHtml((STAGE_LABELS[order.stage] || {}).label || order.stage)}</div>
    <div><b>Priority</b>${order.priority === "urgent" ? "URGENT" : "Normal"}</div>
  </div>
  ${order.notes ? `<div class="notes"><b>Notes / PO</b>${escHtml(order.notes)}</div>` : ""}
  <table><thead><tr><th>STK</th><th>Product</th><th style="text-align:right">Qty</th><th>Unit</th><th>Picked</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5">No items.</td></tr>'}</tbody></table>
  <div class="sign"><div><div class="sl"></div><div class="lbl">Picked by</div></div><div><div class="sl"></div><div class="lbl">Checked by</div></div><div><div class="sl"></div><div class="lbl">Date</div></div></div>
  <p style="margin-top:22px;color:#888;font-size:12px">Printed ${escHtml(new Date().toLocaleString())}</p>
</body></html>`);
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try {
      const w = iframe.contentWindow;
      w.onafterprint = () => { try { iframe.remove(); } catch (e) {} };
      w.focus(); w.print();
      setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 60000);
    } catch (e) { alert("Could not open the print dialog: " + e.message); try { iframe.remove(); } catch (_) {} }
  }, 350);
}
function printRouteList(deliveries) {
  const rows = (deliveries || []).map((d, i) =>
    `<tr><td class="n">${i + 1}</td><td class="m">${escHtml(d.invoice_number)}</td><td>${escHtml(d.customer_name || "")}</td><td>${escHtml(d.address || "—")}</td><td>${escHtml(d.delivery_man_name || "—")}</td><td class="chk">&#9744;</td></tr>`
  ).join("");
  const html = (`<!doctype html><html><head><meta charset="utf-8"><title>Delivery Route List</title>
<style>
  *{box-sizing:border-box} body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:28px}
  h1{font-size:21px;margin:0 0 2px} .sub{color:#666;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{padding:8px 9px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;color:#888} .m{font-family:ui-monospace,Consolas,monospace;color:#555} .n{color:#888;width:26px} .chk{width:30px;text-align:center;font-size:17px}
  @media print{body{margin:12mm}}
</style></head><body>
  <h1>Delivery Route List</h1><div class="sub">Wawasan Candle — ${escHtml(new Date().toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric" }))} · ${(deliveries || []).length} stops</div>
  <table><thead><tr><th>#</th><th>Invoice</th><th>Customer</th><th>Address</th><th>Driver</th><th>Done</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No deliveries scheduled.</td></tr>'}</tbody></table>
  <p style="margin-top:22px;color:#888;font-size:12px">Printed ${escHtml(new Date().toLocaleString())}</p>
</body></html>`);
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try {
      const w = iframe.contentWindow;
      w.onafterprint = () => { try { iframe.remove(); } catch (e) {} };
      w.focus(); w.print();
      setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 60000);
    } catch (e) { alert("Could not open the print dialog: " + e.message); try { iframe.remove(); } catch (_) {} }
  }, 350);
}

// Open a print dialog for an arbitrary HTML document (hidden iframe, self-cleaning).
function printHtmlDoc(html) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try {
      const w = iframe.contentWindow;
      w.onafterprint = () => { try { iframe.remove(); } catch (e) {} };
      w.focus(); w.print();
      setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 60000);
    } catch (e) { alert("Could not open the print dialog: " + e.message); try { iframe.remove(); } catch (_) {} }
  }, 350);
}

// Delivery Order — the driver's signable paper, laid out like the SQL Account
// invoice (no prices). entries = [{ order, delivery }]; many print as one document
// with a page break between, so the whole day's run prints in one dialog.
function printDeliveryOrders(entries) {
  const co = `<div class="co"><div class="cn">远景蜡烛工贸有限公司</div><div class="en">WAWASAN LTS TRADING SDN BHD <span class="reg">(1119335-A)</span></div><div class="ad">LOT 3869-6, JALAN KAMPUNG ORANG ASLI, KAMPUNG BUNGA RAYA, KUANG,</div><div class="ad">48050 RAWANG, SELANGOR DARUL EHSAN.</div><div class="ad">Tel: 012-228 7870, 012-228 7874</div></div>`;
  const pages = (entries || []).map(({ order, delivery }, idx) => {
    const items = (order.items || []).map((it, i) =>
      `<tr><td>${i + 1}</td><td class="m">${escHtml(it.sku || "")}</td><td>${escHtml(it.name || "")}</td><td class="r">${Math.round(it.quantity)}</td><td>${escHtml(it.unit || "pcs")}</td></tr>`).join("");
    const totalQty = (order.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const driver = (delivery && delivery.delivery_man_name) || "—";
    return `<div class="page"${idx > 0 ? ' style="page-break-before:always"' : ""}>
      ${co}
      <div class="title">Delivery Order</div>
      <div class="addr">
        <div><div class="lbl">Bill To</div><div class="nm">${escHtml(order.customer_name || "—")}</div><div class="ln">Tel: ${escHtml(order.customer_contact || "—")}</div></div>
        <div><div class="lbl">Delivery Address</div><div class="ln">${escHtml(order.delivery_address || "—")}</div><div class="ln">Tel: ${escHtml(order.customer_contact || "—")}</div></div>
      </div>
      <table class="info"><tr>
        <td><div class="h">Doc No.</div>${escHtml(order.invoice_number)}</td>
        <td><div class="h">Date</div>${escHtml(fmtDay(order.required_delivery_date))}</td>
        <td><div class="h">Driver</div>${escHtml(driver)}</td>
        <td><div class="h">Page</div>1 of 1</td>
      </tr></table>
      <table class="items"><thead><tr><th style="width:30px">No</th><th style="width:74px">STK</th><th>Description</th><th class="r" style="width:54px">Qty</th><th style="width:50px">UOM</th></tr></thead>
      <tbody>${items || '<tr><td colspan="5">No items.</td></tr>'}</tbody></table>
      <div class="tot">Total: ${Math.round(totalQty)} units · ${(order.items || []).length} items</div>
      <div class="recv-note">Goods received in good condition.</div>
      <div class="sign"><div><div class="sl">Authorised Signature<br>WAWASAN LTS TRADING SDN BHD</div></div><div><div class="sl">Customer chop &amp; sign<br>Name / Date: ____________________</div></div></div>
    </div>`;
  }).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Delivery Order</title><style>
    *{box-sizing:border-box} body{font:13px/1.5 Arial,Helvetica,sans-serif;color:#000;margin:0}
    .page{padding:24mm 16mm}
    .co{text-align:center;line-height:1.4} .co .cn{font-size:15px;font-weight:700} .co .en{font-size:16px;font-weight:700} .co .reg{font-weight:400;font-size:12px} .co .ad{font-size:12px}
    .title{font-size:24px;font-weight:700;margin:14px 0 2px}
    .lbl{font-size:10px;color:#555}
    .addr{display:flex;gap:30px;border-top:1px solid #000;padding-top:7px;margin-top:8px} .addr>div{flex:1} .addr .nm{font-weight:700;font-size:13.5px;margin:2px 0 1px} .addr .ln{font-size:12.5px}
    .info{width:100%;border-collapse:collapse;margin:14px 0 4px;font-size:12px} .info td{border:1px solid #000;padding:4px 8px} .info .h{font-size:9.5px;color:#555;padding:0 0 1px;border:none}
    table.items{width:100%;border-collapse:collapse;margin-top:10px} table.items th{font-size:10.5px;color:#333;text-align:left;border-bottom:1.5px solid #000;padding:6px 8px} table.items td{padding:7px 8px;border-bottom:1px solid #ccc;font-size:12.5px;vertical-align:top} table.items .r{text-align:right} .m{font-family:ui-monospace,Consolas,monospace;color:#555}
    .tot{font-size:12px;margin-top:8px;text-align:right;font-weight:700}
    .recv-note{font-size:12px;margin-top:16px}
    .sign{display:flex;gap:50px;margin-top:46px} .sign>div{flex:1} .sl{border-top:1px solid #000;padding-top:5px;font-size:12px}
  </style></head><body>${pages || '<p style="padding:20px">Nothing to print.</p>'}</body></html>`;
  printHtmlDoc(html);
}

// ─── Icons ───────────────────────────────────────────────────────────────────
const ICONS = {
  board: '<rect x="3.5" y="4" width="4.2" height="16" rx="1.2"/><rect x="9.9" y="4" width="4.2" height="10" rx="1.2"/><rect x="16.3" y="4" width="4.2" height="13" rx="1.2"/>',
  display: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/>',
  dashboard: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.3"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.3"/>',
  truck: '<path d="M3 5.5h11v10H3z"/><path d="M14 8.5h4l3 3v4h-7z"/><circle cx="7" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/>',
  chart: '<path d="M3.5 20.5h17"/><rect x="5.5" y="11" width="3" height="7.5" rx="1"/><rect x="11" y="5.5" width="3" height="13" rx="1"/><rect x="16.5" y="13.5" width="3" height="5" rx="1"/>',
  message: '<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L3.5 20.5l1.9-5.3A8 8 0 1 1 20.5 11.5z"/>',
  audit: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v3.5h3.5"/><path d="M12 7.5V12l3 1.8"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.2a5.5 5.5 0 0 1 3 5.8"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.5 16.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  arrowRight: '<path d="M5 12h13.5M13 6l6 6-6 6"/>',
  dots: '<circle cx="12" cy="5.2" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.8" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 1.9"/>',
  flame: '<path d="M12 2.5c.5 3-1.8 4.7-3 6.2C7.7 10.4 7 11.9 7 13.6A5 5 0 0 0 17 14c0-2-1-3.7-2.5-5 .3 1.4-.3 2.4-1 2.9.6-2.4-.8-4.6-1.5-5.4-.2 1.5-1 2.2-1.7 2.8.5-2.3.7-4.7 1.7-6.8z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  logout: '<path d="M9.5 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.5"/><path d="M16 16.5 20.5 12 16 7.5M20.5 12H9.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M20 6.5 9.5 17 4.5 12"/>',
  alert: '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5M12 17h.01"/>',
  chevron: '<path d="M6 9.5 12 15l6-5.5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
};
function Icon({ name, size = 18, color = "currentColor", strokeWidth = 1.9, style }) {
  const filled = name === "dots";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? color : "none"} stroke={filled ? "none" : color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }} dangerouslySetInnerHTML={{ __html: ICONS[name] || "" }} />
  );
}

// ─── Primitives ──────────────────────────────────────────────────────────────
function Logo({ size = 38 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28, display: "grid", placeItems: "center",
      background: `linear-gradient(145deg, ${C.accent2}, ${C.accent})`,
      boxShadow: `0 0 18px ${C.accent}55, 0 4px 10px rgba(0,0,0,.45)`, flexShrink: 0,
    }}>
      <Icon name="flame" size={size * 0.56} color="#231304" strokeWidth={1.6} />
    </div>
  );
}
function Avatar({ name = "?", color = C.accent, size = 30 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: color + "26", color,
      display: "grid", placeItems: "center", fontSize: size * 0.4, fontWeight: 700, flexShrink: 0,
    }}>{initials(name)}</div>
  );
}
function Pill({ children, color = C.text2, bg, border, style }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, background: bg ?? color + "1f", color,
      border: `1px solid ${border ?? color + "44"}`, borderRadius: 6, padding: "2px 7px",
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, whiteSpace: "nowrap", textTransform: "uppercase", ...style,
    }}>{children}</span>
  );
}
function Btn({ children, onClick, variant = "primary", size = "md", disabled, style, type = "button" }) {
  const sizes = { sm: { padding: "7px 12px", fontSize: 13 }, md: { padding: "9px 16px", fontSize: 14 }, lg: { padding: "12px 22px", fontSize: 15 } };
  const variants = {
    primary: { background: C.accent, color: "#231304", fontWeight: 700 },
    soft: { background: C.surface2, color: C.text, border: `1px solid ${C.border2}` },
    ghost: { background: "transparent", color: C.text2, border: `1px solid ${C.border}` },
    danger: { background: "#3a1a1a", color: "#fca5a5", border: "1px solid #5b2626" },
    success: { background: "#13301f", color: C.ready, border: "1px solid #1f5036" },
  };
  return (
    <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{ border: "none", borderRadius: 9, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, display: "inline-flex", alignItems: "center", gap: 7, transition: "filter .15s", ...sizes[size], ...variants[variant], ...style }}>
      {children}
    </button>
  );
}
function IconBtn({ icon, onClick, title, color = C.text2, bg = C.surface2, border = C.border2, size = 40 }) {
  return (
    <button title={title} onClick={onClick} style={{ width: size, height: size, display: "grid", placeItems: "center", borderRadius: 8, border: `1px solid ${border}`, background: bg, color, cursor: "pointer" }}>
      <Icon name={icon} size={16} color={color} />
    </button>
  );
}
function Modal({ open, onClose, title, children, width = 560 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "6vh 16px", overflowY: "auto" }}>
      <div style={{ background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 16, padding: "22px 24px", width, maxWidth: "96vw", boxShadow: "0 30px 80px rgba(0,0,0,.55)", animation: "wws-fade .15s ease" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.text3, display: "grid", placeItems: "center" }}><Icon name="x" size={20} color={C.text3} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, value, onChange, type = "text", options, placeholder, required, min, name, autoComplete }) {
  const st = { width: "100%", padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text, outline: "none" };
  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      {label && <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.text2, marginBottom: 5 }}>{label}{required && <span style={{ color: C.danger }}> *</span>}</span>}
      {options
        ? <select value={value} onChange={(e) => onChange(e.target.value)} style={st}>{options.map((o) => <option key={o.value ?? o} value={o.value ?? o} style={{ background: C.bg2 }}>{o.label ?? o}</option>)}</select>
        : <input type={type} name={name} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} min={min} style={st} />}
    </label>
  );
}
function Card({ children, style }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "18px 20px", ...style }}>{children}</div>;
}
function Loading({ label = "Loading…" }) {
  return <div style={{ padding: 48, textAlign: "center", color: C.text3, fontSize: 14 }}>{label}</div>;
}
function Empty({ label }) {
  return <div style={{ padding: "28px 12px", textAlign: "center", color: C.text3, fontSize: 13 }}>{label}</div>;
}
// Stacked card for narrow screens — turns one wide table row into a labelled card
// with full-width action buttons, so phones/tablets don't scroll sideways.
function StackCard({ head, rows, actions }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
      {head && <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>{head}</div>}
      {rows.filter(Boolean).map(([l, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13.5, borderTop: `1px solid ${C.border}` }}>
          <span style={{ color: C.text3, flexShrink: 0 }}>{l}</span>
          <span style={{ color: C.text2, textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>{v}</span>
        </div>
      ))}
      {actions && <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}

// ─── Kanban card (board) ───────────────────────────────────────────────────────
function KanbanCard({ order, user, onOpen, onAdvance, onReorderUp, onReorderDown, reorderable, rank, onSetTier, unread }) {
  const stage = STAGES[order.stage] || { color: C.text3 };
  const [picker, setPicker] = useState(false); // tier-change picker open on the pill
  const rBtn = (dis) => ({ cursor: dis ? "default" : "pointer", opacity: dis ? 0.3 : 1, lineHeight: 1, fontSize: 10, padding: "2px 6px", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 5, color: C.text2 });
  const cd = countdown(order.required_delivery_date);
  const late = (daysUntil(order.required_delivery_date) ?? 0) < 0;
  const urgent = order.priority === "urgent";
  const onHold = !!order.on_hold;
  const waiting = !!order.waiting_stock;
  const imp = impCfg(order.importance);
  const showName = !!order.customer_name;
  const dtag = deliveryTag(order);
  const invColor = late ? C.danger : urgent ? C.accent2 : C.text;
  // All STKs made → the whole card greens (like urgent reds it) so a ready-to-advance
  // order reads at a glance. Green wins over urgent: it only shows in production/packing
  // and flags the actionable "move it now" state; the Urgent pill still shows.
  const allDone = (order.stage === "production" || order.stage === "packing") && (order.item_count || 0) > 0 && (order.made_count || 0) >= order.item_count;
  // Urgent AND finished → keep both signals: green inner border + a dark gap + a red
  // outer ring (double border), instead of green silently hiding the urgency.
  const urgentDone = urgent && allDone;
  const cardBg = allDone ? C.ready + "1A" : urgent ? C.danger + "1A" : C.surface;
  const cardBgHover = allDone ? C.ready + "26" : urgent ? C.danger + "26" : C.surface2;
  const next = BOARD_STAGES[BOARD_STAGES.indexOf(order.stage) + 1] || "delivered";
  return (
    <div onClick={() => onOpen(order)}
      style={{ position: "relative", background: cardBg, border: `1px solid ${urgentDone ? C.ready : unread ? C.accent : allDone ? C.ready + "88" : urgent ? C.danger + "88" : late ? C.danger + "55" : C.border}`, borderLeft: `3px solid ${stage.color}`, borderRadius: 11, padding: "12px 13px", cursor: "pointer", transition: "background .12s", boxShadow: urgentDone ? `0 0 0 2px ${C.bg}, 0 0 0 4px ${C.danger}` : unread ? `0 0 0 2px ${C.accent}` : "none", animation: (unread && !urgentDone) ? "wws-ring 1.5s ease infinite" : "none" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = cardBgHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = cardBg)}>
      {unread && <span style={{ position: "absolute", top: -8, right: -8, display: "inline-flex", alignItems: "center", gap: 3, background: C.accent, color: "#1a1410", fontSize: 9.5, fontWeight: 800, borderRadius: 20, padding: "2px 7px", boxShadow: "0 2px 8px rgba(0,0,0,.4)" }}>● NEW</span>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {rank != null && <span title="Priority order in this group" style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 7, background: C.accent, color: C.bg, fontWeight: 800, fontSize: 12, display: "grid", placeItems: "center" }}>{rank}</span>}
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: invColor, letterSpacing: 0.3 }}>{order.invoice_number}</span>
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {urgent && <Pill color={C.danger}>Urgent</Pill>}
          {showName && (onSetTier
            ? (picker
                ? <span style={{ display: "inline-flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    {IMPORTANCE_OPTS.map((o) => <button key={o.value} onClick={() => { setPicker(false); if (o.value !== order.importance) onSetTier(o.value); }} style={{ cursor: "pointer", fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 7, border: `1px solid ${IMPORTANCE[o.value].color}66`, background: order.importance === o.value ? IMPORTANCE[o.value].color + "33" : C.surface2, color: IMPORTANCE[o.value].color }}>{o.label}</button>)}
                  </span>
                : <button onClick={(e) => { e.stopPropagation(); setPicker(true); }} title="Change priority tier" style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer" }}><Pill color={imp.color}>{imp.label} ▾</Pill></button>)
            : <Pill color={imp.color}>{imp.label}</Pill>)}
          {dtag && <Pill color={dtag.color}>{dtag.label}</Pill>}
          {waiting && <Pill color={C.danger}>⚠ Waiting stock</Pill>}
          {onHold && <Pill color={C.hold}>On hold</Pill>}
          {order.edited && <Pill color={C.accent2}>✎ Edited</Pill>}
          {order.skip_production && <Pill color={C.accent} bg="transparent">No production</Pill>}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "7px 0 4px", fontSize: 12.5 }}>
        <Icon name="clock" size={13} color={cd.tone} />
        <span style={{ color: C.text2 }}>{fmtDay(order.required_delivery_date)}</span>
        {cd.text && <span style={{ color: cd.tone, fontWeight: 600 }}>· {cd.text}</span>}
      </div>
      <div style={{ fontSize: 13, color: showName ? C.text : imp.color, fontWeight: showName ? 500 : 700, marginBottom: 3 }}>{showName ? order.customer_name : imp.label}</div>
      <div style={{ fontSize: 12, color: C.text3, marginBottom: 5 }}>
        {order.item_count} {order.item_count === 1 ? "line" : "lines"}
        {order.expiry_date && <span> · Exp {fmtDay(order.expiry_date)}</span>}
      </div>
      {(order.stage === "production" || order.stage === "packing") && order.item_count > 0 && (() => {
        const done = order.made_count || 0, total = order.item_count || 0;
        const full = total > 0 && done >= total;
        const p = total > 0 ? Math.round((done / total) * 100) : 0;
        return (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: full ? C.ready : C.accent, marginBottom: 4 }}>
              {full ? "All STKs done ✓" : `${done}/${total} STKs done`}
            </div>
            <div style={{ height: 4, background: C.surface2, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${p}%`, background: full ? C.ready : C.accent }} />
            </div>
          </div>
        );
      })()}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: `1px solid ${C.border}`, paddingTop: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {order.pic_name
            ? <><Avatar name={order.pic_name} color={order.pic_color} size={23} /><span style={{ fontSize: 12.5, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{order.pic_name}</span></>
            : <span style={{ fontSize: 12, color: C.text3 }}>Unassigned</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {reorderable && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginRight: 1 }} title={(onReorderUp || onReorderDown) ? "Move priority up / down" : "Add another order here to reorder"}>
              <button onClick={() => onReorderUp && onReorderUp()} disabled={!onReorderUp} style={rBtn(!onReorderUp)} aria-label="Move up">▲</button>
              <button onClick={() => onReorderDown && onReorderDown()} disabled={!onReorderDown} style={rBtn(!onReorderDown)} aria-label="Move down">▼</button>
            </div>
          )}
          {canAdvanceStage(user.role, order.stage) && !order.on_hold && <IconBtn icon="arrowRight" onClick={() => onAdvance(order, next)} title={(user.role === "super_admin" || user.role === "operations_controller") ? `Advance to ${(STAGE_LABELS[next] || {}).label || next}` : (ADVANCE_LABEL[order.stage] || "Advance")} color={C.ready} bg="#13301f" border="#1f5036" />}
          <IconBtn icon="dots" onClick={() => onOpen(order)} title="Details & actions" />
        </div>
      </div>
    </div>
  );
}

// ─── Order Board ───────────────────────────────────────────────────────────────
function AdvanceConfirmModal({ order, to, user, onConfirm, onClose }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("GET", `/orders/${order.id}`).then(setDetail).catch(() => setDetail({ items: [] })); }, [order.id]);
  const canMark = user && canMarkStage(user.role, order.stage);
  async function setStatus(it, status) {
    if (status === itemStatusKey(it)) return;
    try { await api("PATCH", `/orders/${order.id}/items/${it.id}`, { status }); const d = await api("GET", `/orders/${order.id}`).catch(() => null); if (d) setDetail(d); }
    catch (e) { alert(e.message); }
  }
  const items = (detail && detail.items) || [];
  const allMade = items.length > 0 && items.every((it) => it.made);
  const title = ADVANCE_LABEL[order.stage] || `Advance to ${(STAGE_LABELS[to] || {}).label || to}`;
  async function go() { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }
  return (
    <Modal open onClose={onClose} title={title} width={520}>
      <div style={{ fontSize: 14, marginBottom: 4 }}>
        <span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{order.invoice_number}</span> <span style={{ color: C.text2 }}>· {order.customer_name || impCfg(order.importance).label}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.text3, marginBottom: 14 }}>Check the items below are done, then confirm the move to <b style={{ color: C.text2 }}>{(STAGE_LABELS[to] || {}).label || to}</b>.</div>
      {!detail ? <Loading /> : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
          {items.length === 0 && <Empty label="No line items on this order." />}
          {items.map((it) => {
            const stt = itemStat(it);
            const dot = stt.color;
            return (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.text3 }}>{it.sku}</div>
                <div style={{ fontSize: 13.5, color: C.text }}>{it.name}</div>
              </div>
              {canMark
                ? <StatusPicker value={stt.k} onChange={(s) => setStatus(it, s)} />
                : <div style={{ fontWeight: 700, color: stt.color, marginRight: 6, fontSize: 12.5 }}>{stt.label}</div>}
            </div>
            );
          })}
        </div>
      )}
      {(order.stage === "production" || order.stage === "packing") && items.length > 0 && !allMade && (
        <div style={{ fontSize: 12.5, color: C.packing, marginBottom: 12 }}>⚠ Not all STKs are marked done yet — confirm only if your stage is actually complete.</div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={go} disabled={busy}><Icon name="check" size={15} /> {busy ? "Moving…" : "Confirm & advance"}</Btn>
      </div>
    </Modal>
  );
}
function OrderBoard({ user, search, weekOnly, statusFilter, onOpenOrder, refreshKey, onCount, unreadIds }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [confirmAdv, setConfirmAdv] = useState(null);
  const [dragId, setDragId] = useState(null); // card being dragged
  const [dragOverZone, setDragOverZone] = useState(null); // tier drop-zone hovered (key "stage:tier")
  const canReorder = ["super_admin", "operations_controller", "admin", "production_lead"].includes(user.role);
  const [viewStage, setViewStageRaw] = useState(() => {
    const saved = (typeof localStorage !== "undefined" && localStorage.getItem("oms_board_stage")) || "all";
    return saved === "all" || visibleStages(user.role).includes(saved) ? saved : "all";
  });
  const setViewStage = (s) => { setViewStageRaw(s); try { localStorage.setItem("oms_board_stage", s); } catch (e) {} };
  const stages = visibleStages(user.role);
  async function load() {
    setLoading(true); setErr("");
    try {
      const d = await api("GET", `/orders/kanban${weekOnly ? "?week=current" : ""}`);
      setBoard(d);
      onCount && onCount(stages.reduce((a, s) => a + (d[s] ? d[s].length : 0), 0));
    } catch (e) { setErr(e.message); setBoard({ order: [], production: [], packing: [], ready_for_delivery: [], on_hold: [] }); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [weekOnly, refreshKey]);

  function advance(order, to) { setConfirmAdv({ order, to }); }
  async function doAdvance() {
    const { order, to } = confirmAdv;
    try { await api("POST", `/orders/${order.id}/move`, { to_stage: to }); setConfirmAdv(null); load(); }
    catch (e) { alert(e.message); }
  }
  // Each column is grouped into priority tiers (VIP > Priority > Standard); within a tier the
  // cards are a manual order (rank). Backend sorts by tier, then this order. Three clear moves:
  // ▲▼ rank within a tier · tap the pill to change tier · drag a card into a group (tier + rank).
  const TIER_ORDER = ["vip", "priority", "standard"];
  // Persist a column's new full order (+ optionally a moved card's new tier). Optimistic.
  async function persist(stage, orderedIds, setImp) {
    const byId = Object.fromEntries((board[stage] || []).map((o) => [o.id, o]));
    const next = orderedIds.map((id) => (setImp && id === setImp.id) ? { ...byId[id], importance: setImp.importance } : byId[id]);
    setBoard({ ...board, [stage]: next }); // optimistic
    setDragId(null);
    try { await api("POST", "/orders/reorder", { stage, ordered_ids: orderedIds, set_importance: setImp || undefined }); }
    catch (e) { alert(e.message); load(); }
  }
  // ▲▼ — move a card up/down WITHIN its own tier only (rank). Never changes the tier.
  function reorderMove(stage, id, dir) {
    const arr = [...((board && board[stage]) || [])];
    const i = arr.findIndex((o) => o.id === id); if (i < 0) return;
    const me = arr[i];
    let j = -1;
    if (dir < 0) { for (let k = i - 1; k >= 0; k--) if (arr[k].importance === me.importance) { j = k; break; } }
    else { for (let k = i + 1; k < arr.length; k++) if (arr[k].importance === me.importance) { j = k; break; } }
    if (j < 0) return;
    arr.splice(i, 1); arr.splice(j, 0, me);
    persist(stage, arr.map((o) => o.id), null);
  }
  // Tap-the-pill tier change: move the card to the bottom of the target tier group.
  function setTier(stage, id, tier) {
    const arr = [...((board && board[stage]) || [])];
    const i = arr.findIndex((o) => o.id === id); if (i < 0 || arr[i].importance === tier) return;
    const me = arr[i]; arr.splice(i, 1);
    let last = -1; arr.forEach((o, k) => { if (o.importance === tier) last = k; });
    arr.splice(last + 1, 0, me);
    persist(stage, arr.map((o) => o.id), { id, importance: tier });
  }
  // Drag onto a card → join that card's tier, just above it (sets tier + rank in one move).
  function dropOnCard(stage, targetId) {
    if (!dragId || dragId === targetId || !board) { setDragId(null); return; }
    const arr = [...(board[stage] || [])];
    const from = arr.findIndex((o) => o.id === dragId);
    const target = arr.find((o) => o.id === targetId);
    if (from < 0 || !target) { setDragId(null); return; }
    const tier = target.importance, changed = arr[from].importance !== tier;
    const me = arr[from]; arr.splice(from, 1);
    arr.splice(arr.findIndex((o) => o.id === targetId), 0, me);
    persist(stage, arr.map((o) => o.id), changed ? { id: dragId, importance: tier } : null);
  }
  // Drag onto a group (incl. an empty one) → join that tier at the bottom.
  function dropOnZone(stage, tier) {
    if (!dragId || !board) { setDragId(null); return; }
    const arr = [...(board[stage] || [])];
    const from = arr.findIndex((o) => o.id === dragId); if (from < 0) { setDragId(null); return; }
    const changed = arr[from].importance !== tier;
    const me = arr[from]; arr.splice(from, 1);
    let last = -1; arr.forEach((o, k) => { if (o.importance === tier) last = k; });
    arr.splice(last + 1, 0, me);
    persist(stage, arr.map((o) => o.id), changed ? { id: dragId, importance: tier } : null);
  }
  const filt = (arr) => {
    const q = search.trim().toLowerCase();
    let out = arr;
    if (q) out = out.filter((o) => o.invoice_number.toLowerCase().includes(q) || (o.customer_name || "").toLowerCase().includes(q));
    if (statusFilter === "urgent") out = out.filter((o) => o.priority === "urgent");
    else if (statusFilter === "late") out = out.filter((o) => (daysUntil(o.required_delivery_date) ?? 0) < 0);
    else if (statusFilter === "on_hold") out = out.filter((o) => o.on_hold);
    else if (statusFilter === "waiting_stock") out = out.filter((o) => o.waiting_stock);
    return out;
  };

  const showStagePicker = stages.length > 1;
  const shownStages = (viewStage !== "all" && stages.includes(viewStage)) ? [viewStage] : stages;

  if (loading && !board) return <Loading label="Loading board…" />;

  return (
    <div>
      {err && <div style={{ marginBottom: 14, color: "#fca5a5", fontSize: 13 }}>⚠ {err}</div>}
      {showStagePicker && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {["all", ...stages].map((s) => {
            const active = viewStage === s;
            const color = s === "all" ? C.accent : (STAGES[s] || {}).color || C.accent;
            const label = s === "all" ? "All stages" : (STAGES[s] || {}).label || s;
            const count = s === "all" ? null : filt((board && board[s]) || []).length;
            return (
              <button key={s} onClick={() => setViewStage(s)} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9, border: `1px solid ${active ? color + "66" : C.border2}`, background: active ? color + "22" : C.surface, color: active ? color : C.text2, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {s !== "all" && <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />}
                {label}{count != null && <span style={{ background: active ? color + "33" : C.surface2, color: active ? color : C.text3, borderRadius: 6, padding: "0 7px", fontSize: 12, fontWeight: 700 }}>{count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: shownStages.length === 1 ? `repeat(1, minmax(min(100%, 280px), 560px))` : `repeat(auto-fit, minmax(min(100%, 250px), 1fr))`, gap: 16, alignItems: "start" }}>
        {shownStages.map((s) => {
          const cfg = STAGES[s];
          const orders = filt((board && board[s]) || []);
          return (
            <div key={s} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderTop: `3px solid ${cfg.color}`, borderRadius: 13, padding: 12, minHeight: 200 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, padding: "2px 2px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: cfg.color }} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{cfg.label}</span>
                </div>
                <span style={{ background: C.surface2, color: C.text2, borderRadius: 7, padding: "1px 9px", fontSize: 13, fontWeight: 700 }}>{orders.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {!canReorder ? (
                  <>
                    {orders.map((o) => <KanbanCard key={o.id} order={o} user={user} onOpen={onOpenOrder} onAdvance={advance} unread={unreadIds && unreadIds.has(o.id)} />)}
                    {orders.length === 0 && <Empty label="No orders" />}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: C.text3, marginBottom: 1 }}>Drag a card into a group to set priority · ▲▼ to rank within</div>
                    {TIER_ORDER.map((tier) => {
                      const group = orders.filter((o) => (o.importance || "standard") === tier);
                      const zoneKey = s + ":" + tier;
                      const over = dragOverZone === zoneKey && dragId;
                      const tcfg = IMPORTANCE[tier] || { label: tier, color: C.text3 };
                      return (
                        <div key={tier}
                          onDragOver={(e) => { e.preventDefault(); if (dragOverZone !== zoneKey) setDragOverZone(zoneKey); }}
                          onDragLeave={() => setDragOverZone((z) => (z === zoneKey ? null : z))}
                          onDrop={(e) => { e.preventDefault(); setDragOverZone(null); dropOnZone(s, tier); }}
                          style={{ borderRadius: 10, padding: "1px 2px", boxShadow: over ? `inset 0 0 0 1.5px ${C.accent}` : "none" }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, color: tcfg.color, display: "flex", alignItems: "center", gap: 8, margin: "6px 4px 8px" }}>
                            {tcfg.label}<span style={{ flex: 1, height: 1, background: C.border }} />
                          </div>
                          {group.length === 0
                            ? <div style={{ fontSize: 11, color: C.text3, padding: "8px 10px", border: `1px dashed ${C.border2}`, borderRadius: 9, textAlign: "center", marginBottom: 4 }}>Drop here → {tcfg.label}</div>
                            : group.map((o, i) => (
                                <div key={o.id} draggable
                                  onDragStart={(e) => { setDragId(o.id); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", o.id); } catch (_) {} }}
                                  onDragEnd={() => { setDragId(null); setDragOverZone(null); }}
                                  onDragOver={(e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (_) {} }}
                                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverZone(null); dropOnCard(s, o.id); }}
                                  style={{ cursor: "grab", opacity: dragId === o.id ? 0.4 : 1, marginBottom: 9 }}>
                                  <KanbanCard order={o} user={user} onOpen={onOpenOrder} onAdvance={advance} reorderable rank={i + 1} unread={unreadIds && unreadIds.has(o.id)}
                                    onReorderUp={i > 0 ? () => reorderMove(s, o.id, -1) : null}
                                    onReorderDown={i < group.length - 1 ? () => reorderMove(s, o.id, 1) : null}
                                    onSetTier={(t) => setTier(s, o.id, t)} />
                                </div>
                              ))}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {confirmAdv && <AdvanceConfirmModal order={confirmAdv.order} to={confirmAdv.to} user={user} onConfirm={doAdvance} onClose={() => setConfirmAdv(null)} />}
    </div>
  );
}

// ─── Floor Display (70" wall view) ──────────────────────────────────────────────
function StatCard({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "9px 20px", minWidth: 132 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.text3, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 800, color, lineHeight: 1.05, marginTop: 2 }}>{value}</div>
    </div>
  );
}
// Full-screen reward leaderboard for the production wall — rotates Departments
// then People every 12s. Reads the same /reports/scorecard as the Reports tab;
// weights come from System Settings. Monthly, big and glanceable for a TV.
function FloorScoreboard() {
  const [unit, setUnit] = useState("dept");
  const [d, setD] = useState(null);
  async function load(u) { try { setD(await api("GET", `/reports/scorecard?unit=${u}&period=monthly`)); } catch { /* keep last */ } }
  useEffect(() => { load(unit); const t = setInterval(() => load(unit), 60000); return () => clearInterval(t); }, [unit]);
  useEffect(() => { const t = setInterval(() => setUnit((u) => (u === "dept" ? "people" : "dept")), 12000); return () => clearInterval(t); }, []);
  const lb = (d && d.leaderboard) || [];
  const top = lb.slice(0, 3), rest = lb.slice(3, 8);
  const medals = ["🥇", "🥈", "🥉"];
  const order = top[1] ? [top[1], top[0], top[2]].filter(Boolean) : top; // 2-1-3 podium
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      <div style={{ textAlign: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: C.text }}>🏆 This Month's Champions</div>
        <div style={{ fontSize: 16, color: C.text3, marginTop: 2 }}>{unit === "dept" ? "Departments" : "People"} · reward standings</div>
      </div>
      {lb.length === 0 ? (
        <div style={{ margin: "auto", color: C.text3, fontSize: 20 }}>No activity to score yet this month.</div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
            {order.map((u) => {
              const rank = lb.indexOf(u), first = rank === 0;
              return (
                <div key={u.key} style={{ width: 280, background: first ? C.accent + "14" : C.bg2, border: `1px solid ${first ? C.accent : C.border}`, borderRadius: 18, padding: "22px 18px", textAlign: "center", transform: first ? "translateY(-12px)" : "none", boxShadow: first ? `0 0 40px -10px ${C.accent}` : "none" }}>
                  <div style={{ fontSize: 44 }}>{medals[rank]}</div>
                  <div style={{ fontSize: 13, color: C.text3, textTransform: "uppercase", letterSpacing: 0.5 }}>{u.dept || "Department"}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: C.text, marginTop: 2 }}>{u.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 46, fontWeight: 800, color: first ? C.accent : C.text, marginTop: 6 }}>{u.score}</div>
                  {first && <div style={{ fontSize: 14, color: C.accent, marginTop: 6 }}>🏆 Top reward</div>}
                </div>
              );
            })}
          </div>
          {rest.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 720, width: "100%", margin: "0 auto", overflowY: "auto" }}>
              {rest.map((u, i) => (
                <div key={u.key} style={{ display: "grid", gridTemplateColumns: "48px 1fr auto", gap: 14, alignItems: "center", background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 18px" }}>
                  <span style={{ fontFamily: MONO, fontSize: 22, color: C.text2 }}>#{i + 4}</span>
                  <span style={{ fontSize: 19, fontWeight: 600, color: C.text }}>{u.name}{u.dept ? ` · ${u.dept}` : ""}</span>
                  <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 800, color: C.text }}>{u.score}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ textAlign: "center", fontSize: 13, color: C.text3 }}>Updates monthly · switches Departments / People every few seconds</div>
        </div>
      )}
    </div>
  );
}

function FloorDisplay({ onExit }) {
  const [board, setBoard] = useState(null);
  const [view, setView] = useState("board"); // board | scoreboard
  const [stats, setStats] = useState({ active: 0, completed_today: 0 });
  const [filter, setFilter] = useState("all");
  const [weekOnly, setWeekOnly] = useState(false);
  const [now, setNow] = useState(new Date());
  const [spotIdx, setSpotIdx] = useState(0);
  const [detail, setDetail] = useState(null);
  const cache = useRef({});

  async function load() {
    try {
      const [b, s] = await Promise.all([api("GET", `/orders/kanban${weekOnly ? "?week=current" : ""}`), api("GET", "/orders/stats")]);
      setBoard(b); setStats(s); cache.current = {};
    } catch (e) { /* keep last */ }
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [weekOnly]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  // Press Esc to leave the full-screen floor view (the on-screen Exit is easy to miss on a wall TV).
  useEffect(() => { const onKey = (e) => { if (e.key === "Escape") onExit(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onExit]);
  // Show the Exit button on activity, then fade it out after 5s idle so the wall stays clean.
  const [chrome, setChrome] = useState(true);
  useEffect(() => {
    let t;
    const ping = () => { setChrome(true); clearTimeout(t); t = setTimeout(() => setChrome(false), 5000); };
    ping();
    const evs = ["mousemove", "mousedown", "touchstart", "keydown", "wheel"];
    evs.forEach((e) => window.addEventListener(e, ping, { passive: true }));
    return () => { clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, ping)); };
  }, []);

  const pool = useMemo(() => {
    if (!board) return [];
    const stages = filter === "all" ? BOARD_STAGES : [filter];
    return stages.flatMap((s) => board[s] || []);
  }, [board, filter]);
  useEffect(() => { setSpotIdx(0); }, [filter]);
  useEffect(() => {
    if (pool.length === 0) return;
    const t = setInterval(() => setSpotIdx((i) => (i + 1) % pool.length), 10000);
    return () => clearInterval(t);
  }, [pool.length]);

  const spot = pool.length ? pool[spotIdx % pool.length] : null;
  useEffect(() => {
    let cancel = false;
    async function go() {
      if (!spot) { setDetail(null); return; }
      if (cache.current[spot.id]) { setDetail(cache.current[spot.id]); return; }
      try { const d = await api("GET", `/orders/${spot.id}`); if (!cancel) { cache.current[spot.id] = d; setDetail(d); } }
      catch (e) { if (!cancel) setDetail(null); }
    }
    go(); return () => { cancel = true; };
  }, [spot && spot.id]);

  const clock = now.toLocaleTimeString("en-GB", { hour12: false });
  const cols = filter === "all" ? BOARD_STAGES : [filter];
  const spotStage = spot ? (STAGE_LABELS[spot.stage] || { label: spot.stage, color: C.accent }) : null;
  const spotCd = spot ? countdown(spot.required_delivery_date) : null;
  const spotDtag = spot ? deliveryTag(spot) : null;
  // Whole spotlight greens when every STK is done (mirrors the red urgent spotlight);
  // if it's also urgent, double border (green inner + red outer ring).
  const spotAllDone = spot && (spot.stage === "production" || spot.stage === "packing") && (spot.item_count || 0) > 0 && (spot.made_count || 0) >= spot.item_count;
  const spotUrgentDone = spotAllDone && spot.priority === "urgent";

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 2000, display: "flex", flexDirection: "column", padding: 22 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
        <Btn variant="primary" onClick={onExit} title="Exit full-screen (or press Esc)"
          style={{ padding: "13px 24px", fontSize: 16, fontWeight: 800, opacity: chrome ? 1 : 0, pointerEvents: chrome ? "auto" : "none", transition: "opacity .45s" }}>
          <Icon name="x" size={19} color="#231304" /> Exit (Esc)
        </Btn>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Logo size={46} />
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 0.5 }}>
            <span style={{ color: C.text }}>WAWASAN </span><span style={{ color: C.accent }}>{view === "scoreboard" ? "SCOREBOARD" : "PRODUCTION FLOOR"}</span>
          </div>
        </div>
        {REWARD_SYSTEM_ENABLED && (
          <div style={{ display: "flex", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
            {[["board", "Board"], ["scoreboard", "Scoreboard"]].map(([k, lbl]) => {
              const on = view === k;
              return <button key={k} onClick={() => setView(k)} style={{ background: on ? C.surface2 : "transparent", border: "none", borderRadius: 7, padding: "9px 16px", cursor: "pointer", fontSize: 14, fontWeight: on ? 800 : 600, color: on ? C.accent : C.text2 }}>{lbl}</button>;
            })}
          </div>
        )}
        <StatCard label="Completed today" value={stats.completed_today} color={C.green} />
        <StatCard label="Active orders" value={stats.active} color={C.accent} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginLeft: 6 }}>
          {["all", ...BOARD_STAGES].map((s) => {
            const active = filter === s;
            const color = s === "all" ? C.accent : STAGES[s].color;
            const label = s === "all" ? "All stages" : STAGES[s].label;
            return (
              <button key={s} onClick={() => setFilter(s)} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${active ? color + "66" : C.border}`, background: active ? color + "22" : "transparent", color: active ? color : C.text2, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>{label}</button>
            );
          })}
        </div>
        <button onClick={() => setWeekOnly((w) => !w)} style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${weekOnly ? C.accent + "66" : C.border}`, background: weekOnly ? C.accent + "22" : "transparent", color: weekOnly ? C.accent : C.text2, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="calendar" size={15} color={weekOnly ? C.accent : C.text3} /> This week
        </button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontFamily: MONO, fontSize: 64, fontWeight: 700, color: C.text, letterSpacing: 2 }}>{clock}</span>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
        {REWARD_SYSTEM_ENABLED && view === "scoreboard" && <FloorScoreboard />}
        {view === "board" && (<>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: `repeat(${cols.length}, 1fr)`, gap: 14, minHeight: 0 }}>
          {cols.map((s) => {
            const cfg = STAGES[s];
            const orders = (board && board[s]) || [];
            return (
              <div key={s} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderTop: `4px solid ${cfg.color}`, borderRadius: 14, padding: "16px 14px", display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, color: C.text3, textTransform: "uppercase" }}>{cfg.label}</div>
                <div style={{ fontSize: 58, fontWeight: 800, color: cfg.color, lineHeight: 1, margin: "2px 0 14px" }}>{orders.length}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 9, overflowY: "auto" }}>
                  {orders.map((o) => {
                    const cd = countdown(o.required_delivery_date);
                    const late = (cd.n ?? 0) < 0, urgent = o.priority === "urgent";
                    const dtag = deliveryTag(o);
                    const allDone = (o.stage === "production" || o.stage === "packing") && (o.item_count || 0) > 0 && (o.made_count || 0) >= o.item_count;
                    const urgentDone = urgent && allDone;
                    return (
                      <div key={o.id} style={{ background: allDone ? C.green + "1A" : urgent ? C.danger + "1A" : C.surface, border: `1px solid ${urgentDone ? C.green : allDone ? C.green + "88" : urgent ? C.danger + "88" : late ? C.danger + "55" : C.border}`, borderLeft: `3px solid ${cfg.color}`, borderRadius: 9, padding: "9px 11px", boxShadow: urgentDone ? `0 0 0 2px ${C.bg2}, 0 0 0 4px ${C.danger}` : "none" }}>
                        <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: late ? C.danger : urgent ? C.accent2 : C.text }}>{o.invoice_number}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                          {urgent && <Pill color={C.danger} style={{ fontSize: 9.5, padding: "1px 6px" }}>Urgent</Pill>}
                          <Pill color={impCfg(o.importance).color} style={{ fontSize: 9.5, padding: "1px 6px" }}>{impCfg(o.importance).label}</Pill>
                          {dtag && <Pill color={dtag.color} style={{ fontSize: 9.5, padding: "1px 6px" }}>{dtag.label}</Pill>}
                          {o.waiting_stock && <Pill color={C.danger} style={{ fontSize: 9.5, padding: "1px 6px" }}>⚠ Stock</Pill>}
                          {o.on_hold && <Pill color={C.hold} style={{ fontSize: 9.5, padding: "1px 6px" }}>Hold</Pill>}
                        </div>
                        <div style={{ fontSize: 12.5, color: cd.tone, marginTop: 3 }}>
                          <span style={{ color: C.text2 }}>{fmtDay(o.required_delivery_date)}</span> · {cd.text}
                        </div>
                        <div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{o.item_count} {o.item_count === 1 ? "product" : "products"}</div>
                        {(o.stage === "production" || o.stage === "packing") && o.item_count > 0 && (() => {
                          const done = o.made_count || 0, total = o.item_count || 0, full = total > 0 && done >= total;
                          const p = total > 0 ? Math.round((done / total) * 100) : 0;
                          return (
                            <div style={{ marginTop: 5 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: full ? C.green : C.accent2, marginBottom: 3 }}>{full ? "All done ✓" : `${done}/${total} STKs · ${p}%`}</div>
                              <div style={{ height: 4, background: C.surface2, borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${p}%`, background: full ? C.green : C.accent }} /></div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                  {orders.length === 0 && <Empty label="—" />}
                </div>
              </div>
            );
          })}
        </div>

        {/* Spotlight */}
        <div style={{ width: 420, background: spotAllDone ? C.green + "14" : spot && spot.priority === "urgent" ? C.danger + "14" : C.bg2, border: `1px solid ${spotUrgentDone ? C.green : spotAllDone ? C.green + "88" : spot && spot.priority === "urgent" ? C.danger + "88" : C.border}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", minHeight: 0, boxShadow: spotUrgentDone ? `0 0 0 2px ${C.bg}, 0 0 0 4px ${C.danger}` : "none" }}>
          {!spot ? <div style={{ margin: "auto", color: C.text3 }}>No active orders</div> : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Pill color={spotStage.color} style={{ fontSize: 12, padding: "4px 10px" }}>● {spotStage.label}</Pill>
                  {spot.priority === "urgent" && <Pill color={C.danger} style={{ fontSize: 12, padding: "4px 10px" }}>Urgent</Pill>}
                  {spotDtag && <Pill color={spotDtag.color} style={{ fontSize: 12, padding: "4px 10px" }}>{spotDtag.label}</Pill>}
                </div>
                <span style={{ fontSize: 14, color: C.text3 }}>{(spotIdx % pool.length) + 1} / {pool.length}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 52, fontWeight: 800, color: C.accent2, margin: "10px 0 6px", lineHeight: 1 }}>{spot.invoice_number}</div>
              <div style={{ marginBottom: 10 }}>
                <Pill color={impCfg(spot.importance).color} style={{ fontSize: 14, padding: "4px 12px" }}>{impCfg(spot.importance).label}</Pill>
              </div>
              {detail && detail.id === spot.id && (detail.items || []).length > 0 && (() => {
                const its = detail.items || [];
                const total = its.length;
                const done = its.filter((it) => itemStatusKey(it) === "done").length;
                const making = its.filter((it) => itemStatusKey(it) === "in_progress").length;
                const todo = total - done - making;
                const units = its.reduce((s, it) => s + Math.round(Number(it.quantity) || 0), 0);
                const p = total > 0 ? Math.round((done / total) * 100) : 0;
                const chip = (label, n, color) => (
                  <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, background: color + "1f", border: `1px solid ${color}55`, color, borderRadius: 9, padding: "6px 11px", fontSize: 20, fontWeight: 800 }}>{n}<span style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span></span>
                );
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, marginBottom: 8 }}>
                      <span style={{ color: C.text2 }}>{total} products · {units} units</span>
                      <span style={{ color: p >= 100 ? C.green : C.accent2, fontWeight: 800 }}>{p}% done</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                      {chip("To do", todo, C.accent)}
                      {chip("Making", making, C.packing)}
                      {chip("Done", done, C.green)}
                    </div>
                    <div style={{ height: 7, background: C.surface2, borderRadius: 5, overflow: "hidden" }}><div style={{ height: "100%", width: `${p}%`, background: p >= 100 ? C.green : C.accent, transition: "width .3s" }} /></div>
                  </div>
                );
              })()}
              <div style={{ flex: 1, overflowY: "auto" }}>
                {detail && detail.id === spot.id
                  ? (detail.items || []).map((it) => {
                    const st = itemStat(it);
                    const dot = st.k === "done" ? C.green : st.k === "in_progress" ? C.packing : C.accent;
                    const isDone = st.k === "done";
                    return (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 12px", borderBottom: `1px solid ${C.border}`, background: isDone ? C.green + "1f" : "transparent", borderLeft: `4px solid ${isDone ? C.green : "transparent"}` }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot, boxShadow: `0 0 8px ${dot}`, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: MONO, fontSize: 23, fontWeight: 800, color: isDone ? C.green : C.text, letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.sku}</div>
                        <div style={{ fontSize: 13.5, fontWeight: 500, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                      </div>
                      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 18 }}>
                        <div style={{ textAlign: "right", minWidth: 64 }}>
                          <span style={{ fontSize: 24, fontWeight: 800, color: C.text, lineHeight: 1 }}>{Math.round(it.quantity)}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.text3 }}> {it.unit || "pcs"}</span>
                        </div>
                        <span style={{ fontSize: 16, fontWeight: 800, color: dot, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 84, textAlign: "right" }}>{isDone ? "✓ " + st.label : st.label}</span>
                      </div>
                    </div>
                    );
                  })
                  : <div style={{ color: C.text3, padding: "12px 0" }}>Loading line items…</div>}
              </div>
              <div style={{ marginTop: 12 }}>
                <Pill color={spotCd.tone} style={{ fontSize: 13, padding: "5px 11px" }}><Icon name="clock" size={13} color={spotCd.tone} /> {fmtDay(spot.required_delivery_date)} · {spotCd.text} left</Pill>
                <div style={{ height: 5, background: C.surface2, borderRadius: 4, overflow: "hidden", marginTop: 12 }}>
                  <div style={{ height: "100%", width: `${((spotIdx % pool.length) + 1) / pool.length * 100}%`, background: C.accent, transition: "width .4s" }} />
                </div>
                <div style={{ fontSize: 12, color: C.text3, marginTop: 7 }}>auto-advances every 10s</div>
              </div>
            </>
          )}
        </div>
        </>)}
      </div>
    </div>
  );
}

// ─── Order detail modal ──────────────────────────────────────────────────────
function OrderDetail({ orderId, user, onUpdated, onClose, changes }) {
  const [order, setOrder] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [tab, setTab] = useState(["production_staff", "packing_staff"].includes(user.role) ? "items" : "details");
  const [moveStage, setMoveStage] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAdv, setConfirmAdv] = useState(false);
  const [users, setUsers] = useState([]);
  const [newItem, setNewItem] = useState({ sku: "", name: "", quantity: 1, unit: "pcs" });
  const [notes, setNotes] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const canMove = ["super_admin", "operations_controller"].includes(user.role);
  // Back-office Admin (deputy) may route an order — set PIC + priority/importance —
  // but not move stages, hold/flag, or cancel (those stay canMove = Boss/Ops).
  const canRoute = ["super_admin", "operations_controller", "admin"].includes(user.role);
  const roleCanMark = ["super_admin", "operations_controller", "production_lead", "production_staff", "packing_staff"].includes(user.role);
  const isLead = user.role === "production_lead";
  const isFloor = ["production_staff", "packing_staff"].includes(user.role); // pure floor worker — keep their view minimal
  const isDispatch = user.role === "delivery_team"; // delivery coordinator — keep their view delivery-focused
  const canAmend = ["super_admin", "admin"].includes(user.role); // may correct a placed line (qty / STK / unit)
  const [editItem, setEditItem] = useState(null); // { id, sku, name, quantity, unit } while editing a line
  const [catalog, setCatalog] = useState([]); // STK catalogue for amend autofill (Boss/Admin)
  async function load() { try { const o = await api("GET", `/orders/${orderId}`); setOrder(o); setNotes(o.notes || ""); } catch (e) { setOrder({ _error: e.message }); } }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);
  useEffect(() => { api("GET", `/delivery?order_id=${orderId}`).then((d) => setDelivery((d && d[0]) || null)).catch(() => setDelivery(null)); }, [orderId]);
  useEffect(() => { if (canRoute) api("GET", "/users").then(setUsers).catch(() => setUsers([])); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (canAmend) api("GET", "/orders/skus").then((d) => setCatalog(d || [])).catch(() => setCatalog([])); /* eslint-disable-next-line */ }, []);

  async function doMove(to, why) {
    if (!to) return;
    setBusy(true);
    try { await api("POST", `/orders/${orderId}/move`, { to_stage: to, reason: why || undefined }); setMoveStage(""); setReason(""); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function cancelOrder() {
    if (!window.confirm(`Cancel order ${order.invoice_number}? It moves to Cancelled and leaves the board.`)) return;
    setBusy(true);
    try { await api("POST", `/orders/${orderId}/move`, { to_stage: "cancelled", reason: reason || "Cancelled" }); onUpdated && onUpdated(); onClose && onClose(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function setItemStatus(it, status) {
    if (status === itemStatusKey(it)) return;
    const prev = order;
    // Update just this line in place so the page doesn't reload or jump under the user.
    setOrder((o) => (o && o.items) ? { ...o, items: o.items.map((x) => x.id === it.id ? { ...x, status, made: status === "done" } : x) } : o);
    try { await api("PATCH", `/orders/${orderId}/items/${it.id}`, { status }); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); setOrder(prev); }
  }
  async function setFlag(body) {
    try { await api("PATCH", `/orders/${orderId}/flags`, body); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function assignPic(picId) {
    try { await api("POST", `/orders/${orderId}/assign-pic`, { pic_id: picId || null }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function setImportance(v) {
    try { await api("PATCH", `/orders/${orderId}`, { importance: v }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function setPriority(v) {
    try { await api("PATCH", `/orders/${orderId}`, { priority: v }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function updateItem(itemId, patch) {
    try { await api("PATCH", `/orders/${orderId}/items/${itemId}`, patch); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); load(); }
  }
  async function removeItem(itemId) {
    try { await api("DELETE", `/orders/${orderId}/items/${itemId}`); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function addItem() {
    if (!newItem.name.trim()) return;
    try { await api("POST", `/orders/${orderId}/items`, newItem); setNewItem({ sku: "", name: "", quantity: 1, unit: "pcs" }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  function startAmend(it) { setEditItem({ id: it.id, sku: it.sku || "", name: it.name || "", quantity: Math.round(it.quantity) || 0, unit: it.unit || "pcs" }); }
  async function saveAmend() {
    const e = editItem; if (!e) return;
    const patch = { sku: (e.sku || "").trim(), name: (e.name || "").trim(), quantity: Math.max(0, Math.round(Number(e.quantity) || 0)), unit: (e.unit || "pcs").trim() };
    if (!patch.sku || !patch.name) { alert("STK and product name are both required."); return; }
    const prev = order;
    // Optimistic in-place update so the row doesn't jump; revert on error.
    setOrder((o) => (o && o.items) ? { ...o, items: o.items.map((x) => x.id === e.id ? { ...x, ...patch } : x) } : o);
    setEditItem(null);
    try { await api("PATCH", `/orders/${orderId}/items/${e.id}`, patch); onUpdated && onUpdated(); }
    catch (err) { alert(err.message); setOrder(prev); }
  }
  const cellInput = (w) => ({ padding: "6px 8px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 13, color: C.text, width: w || "100%", boxSizing: "border-box" });
  async function saveNotes() {
    setNotesBusy(true); setNotesSaved(false);
    try { await api("PATCH", `/orders/${orderId}`, { notes }); setNotesSaved(true); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); } finally { setNotesBusy(false); }
  }
  async function uploadAttachment(file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) { alert(`File too large — max ${MAX_UPLOAD_MB} MB. Please compress it first.`); return; }
    setUploading(true);
    try { const fd = new FormData(); fd.append("file", file); await api("POST", `/orders/${orderId}/attachments`, fd, true); await load(); }
    catch (e) { alert(e.message); } finally { setUploading(false); }
  }
  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment? This also frees the storage it uses.")) return;
    try { await api("DELETE", `/orders/${orderId}/attachments/${attId}`); await load(); }
    catch (e) { alert(e.message); }
  }

  const narrow = useViewport() < 640;
  if (!order) return <Loading />;
  if (order._error) return <div style={{ color: "#fca5a5" }}>⚠ {order._error}</div>;
  const cfg = STAGE_LABELS[order.stage] || { label: order.stage, color: C.text3 };
  const canMark = roleCanMark && canMarkStage(user.role, order.stage);
  const tabs = isFloor ? ["items", "details"] : isDispatch ? ["details", "items"] : ["details", "items", "timeline", "attachments"];
  const picRoles = STAGE_PIC_ROLES[order.stage];
  const picUsers = picRoles ? users.filter((u) => picRoles.includes(u.role)) : users;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: C.text }}>{order.invoice_number}</span>
        <Pill color={cfg.color}>{cfg.label}</Pill>
        {order.priority === "urgent" && <Pill color={C.danger}>Urgent</Pill>}
        {order.importance && order.importance !== "standard" && <Pill color={impCfg(order.importance).color}>{impCfg(order.importance).label}</Pill>}
        {order.waiting_stock && <Pill color={C.danger}>⚠ Waiting stock</Pill>}
        {order.on_hold && <Pill color={C.hold}>On hold</Pill>}
        {(order.activity || []).some((a) => a.action === "item_edited") && <Pill color={C.accent2}>✎ Edited</Pill>}
        {order.skip_production && <Pill color={C.accent} bg="transparent">No production</Pill>}
      </div>
      {changes && changes.length > 0 && (
        <div style={{ background: C.accent + "14", border: `1px solid ${C.accent}55`, borderRadius: 11, padding: "11px 13px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: C.accent, letterSpacing: 0.3 }}>● WHAT CHANGED SINCE YOU LAST LOOKED</span>
            {tabs.includes("timeline") && <button onClick={() => setTab("timeline")} style={{ background: "none", border: "none", cursor: "pointer", color: C.accent, fontSize: 12, fontWeight: 600 }}>Full timeline →</button>}
          </div>
          {changes.map((c) => (
            <div key={c.id} style={{ fontSize: 13, color: C.text, marginTop: 5 }}>
              <span style={{ fontWeight: 600 }}>{c.title}</span>
              {c.message ? <span style={{ color: C.text2 }}> — {c.message}</span> : null}
              <span style={{ color: C.text3, fontSize: 11.5 }}> · {relTime(c.created_at)}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: C.text3 }}>{order.created_by_name ? `Created by ${order.created_by_name}` : ""} {order.order_date ? `· ${fmtDay(order.order_date)}` : ""}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" size="sm" onClick={() => printPickingSlip(order)}>Print picking slip</Btn>
          <Btn variant="ghost" size="sm" onClick={() => printDeliveryOrders([{ order, delivery }])}>Print delivery order</Btn>
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", padding: "8px 13px", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? C.accent : C.text2, borderBottom: `2px solid ${tab === t ? C.accent : "transparent"}`, textTransform: "capitalize" }}>{t}</button>
        ))}
      </div>

      {tab === "details" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 14 }}>
            {order.customer_name != null && <LV label="Customer" v={order.customer_name} />}
            {order.customer_name != null && <LV label="Contact" v={order.customer_contact || "—"} />}
            {order.customer_name != null && <LV label="Address" v={order.delivery_address || "—"} />}
            <LV label="Priority" v={
              canRoute
                ? <select value={order.priority || "normal"} onChange={(e) => setPriority(e.target.value)} style={{ padding: "5px 9px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5, fontWeight: 700, color: order.priority === "urgent" ? C.danger : C.text2 }}><option value="normal" style={{ background: C.bg2, color: C.text }}>Normal</option><option value="urgent" style={{ background: C.bg2, color: C.text }}>Urgent</option></select>
                : <Pill color={order.priority === "urgent" ? C.danger : C.text2}>{order.priority === "urgent" ? "Urgent" : "Normal"}</Pill>
            } />
            <LV label="Importance" v={
              canRoute
                ? <select value={order.importance || "standard"} onChange={(e) => setImportance(e.target.value)} style={{ padding: "5px 9px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5, fontWeight: 700, color: impCfg(order.importance).color }}>{IMPORTANCE_OPTS.map((o) => <option key={o.value} value={o.value} style={{ background: C.bg2, color: C.text }}>{o.label}</option>)}</select>
                : <Pill color={impCfg(order.importance).color}>{impCfg(order.importance).label}</Pill>
            } />
            <LV label="Order date" v={order.order_date ? fmtDay(order.order_date) : "—"} />
            <LV label="Delivery" v={<span style={{ color: countdown(order.required_delivery_date).tone }}>{fmtDay(order.required_delivery_date)} · {countdown(order.required_delivery_date).text}</span>} />
            <LV label="Expiry" v={order.expiry_date ? fmtDay(order.expiry_date) : "—"} />
            <LV label="Person in charge" v={order.pic_name ? <span style={{ display: "inline-flex", gap: 7, alignItems: "center" }}><Avatar name={order.pic_name} color={order.pic_color} size={22} />{order.pic_name}</span> : "Unassigned"} />
            <LV label="Source" v={order.source === "sql_account" ? "Auto-imported" : "Manual entry"} />
            {delivery && <LV label="Driver" v={delivery.delivery_man_name || "Not assigned yet"} />}
            {delivery && delivery.scheduled_date && <LV label="Scheduled" v={fmtDay(delivery.scheduled_date)} />}
            {order.customer_name != null && delivery && delivery.address && <LV label="Delivery address" v={delivery.address} />}
          </div>
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, color: C.text3, fontWeight: 600, marginBottom: 6, letterSpacing: 0.4 }}>INTERNAL NOTES</div>
            {canMove ? (
              <>
                <textarea value={notes} onChange={(e) => { setNotes(e.target.value); setNotesSaved(false); }} rows={3} placeholder="Internal notes (not shown to the customer)…" style={{ width: "100%", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 14, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }} />
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
                  <Btn size="sm" onClick={saveNotes} disabled={notesBusy}>{notesBusy ? "Saving…" : "Save notes"}</Btn>
                  {notesSaved && <span style={{ color: C.ready, fontSize: 12.5 }}>Saved ✓</span>}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: order.notes ? C.text2 : C.text3, whiteSpace: "pre-wrap" }}>{order.notes || "No internal notes."}</div>
            )}
          </div>
        </div>
      )}
      {tab === "timeline" && (() => {
        const log = order.activity || [];
        const trans = order.transitions || [];
        const LIMIT = 3;
        const shown = logOpen ? log : log.slice(0, LIMIT);
        const fmtGap = (ms) => { const h = ms / 3600000; return h >= 48 ? `${Math.round(h / 24)}d` : h >= 1 ? `${Math.round(h)}h` : `${Math.max(1, Math.round(h * 60))}m`; };
        return (
        <div>
          {trans.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: C.text3, fontWeight: 600, marginBottom: 8, letterSpacing: 0.4 }}>STAGE TIMELINE</div>
              {trans.map((t, i) => {
                const next = trans[i + 1];
                const dur = next ? (new Date(next.created_at) - new Date(t.created_at)) : (order.stage !== "delivered" && order.stage !== "cancelled" ? (Date.now() - new Date(t.created_at)) : null);
                const lbl = (STAGE_LABELS[t.to_stage] || {}).label || t.to_stage;
                const col = (STAGE_LABELS[t.to_stage] || {}).color || C.accent;
                return (
                  <div key={t.id} style={{ display: "flex", gap: 11, marginBottom: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, marginTop: 6, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13 }}><span style={{ fontWeight: 700, color: C.text }}>{lbl}</span>{dur != null && <span style={{ color: C.text3 }}> · {fmtGap(dur)}{!next ? " (current)" : ""}</span>}</div>
                      <div style={{ fontSize: 11.5, color: C.text3 }}>{new Date(t.created_at).toLocaleString()}{t.by_name ? ` · ${t.by_name}` : ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 11, color: C.text3, fontWeight: 600, marginBottom: 8, letterSpacing: 0.4 }}>ACTIVITY</div>
          {log.length === 0 && <Empty label="No activity yet." />}
          {shown.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 11, marginBottom: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, marginTop: 6, flexShrink: 0 }} />
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{a.user_name}</span>
                <span style={{ fontSize: 13, color: C.text2 }}> — {a.details || a.action}</span>
                <div style={{ fontSize: 11.5, color: C.text3 }}>{new Date(a.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
          {log.length > LIMIT && (
            <Btn variant="ghost" size="sm" onClick={() => setLogOpen((v) => !v)}>{logOpen ? "Show less ▲" : `Show all ${log.length} ▼`}</Btn>
          )}
        </div>
        );
      })()}
      {tab === "items" && (() => {
        const items = order.items || [];
        const total = items.length;
        const doneLines = items.filter((it) => itemStatusKey(it) === "done").length;
        const pct = total > 0 ? Math.round((doneLines / total) * 100) : 0;
        const head = canAmend ? ["STK", "Product", "Qty", "Unit", "Status", ""] : ["STK", "Product", "Qty", "Unit", "Status"];
        const bySku = Object.fromEntries(catalog.map((c) => [c.sku, c]));
        const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
        return (
        <div>
          {roleCanMark && !canMark && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 9, padding: "9px 12px", fontSize: 12.5, color: C.text2, marginBottom: 14 }}>
              <span aria-hidden>🔒</span>
              <span>This order is in <b style={{ color: cfg.color }}>{cfg.label}</b> — STK status is locked to that stage. Ops or the boss can change it here.</span>
            </div>
          )}
          {items.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.text2, marginBottom: 6 }}>
                <span>{doneLines}/{total} STKs done</span>
                <span style={{ color: pct >= 100 ? C.ready : C.accent, fontWeight: 700 }}>{pct}%</span>
              </div>
              <div style={{ height: 6, background: C.surface2, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? C.ready : C.accent, transition: "width .2s" }} />
              </div>
            </div>
          )}
          {narrow ? (
            <div>
              {items.length === 0 && <Empty label="No items." />}
              {items.map((it) => {
                const st = itemStat(it);
                if (canAmend && editItem && editItem.id === it.id) {
                  return (
                    <div key={it.id} style={{ border: `1px solid ${C.accent}55`, borderRadius: 10, padding: 12, marginBottom: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                      <SkuCombo value={editItem.sku} catalog={catalog} placeholder="STK" style={cellInput()}
                        onType={(v) => setEditItem({ ...editItem, sku: v })}
                        onPick={(c) => setEditItem({ ...editItem, sku: c.sku, name: c.name, unit: c.unit || editItem.unit })} />
                      <input value={editItem.name} onChange={(e) => { const v = e.target.value; const hit = byName[v]; setEditItem({ ...editItem, name: v, ...(hit ? { sku: hit.sku, unit: hit.unit || editItem.unit } : {}) }); }} placeholder="Product" style={cellInput()} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <input type="number" min="0" value={editItem.quantity} onChange={(e) => setEditItem({ ...editItem, quantity: e.target.value })} placeholder="Qty" style={cellInput()} />
                        <input value={editItem.unit} onChange={(e) => setEditItem({ ...editItem, unit: e.target.value })} placeholder="Unit" style={cellInput()} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}><Btn size="sm" onClick={saveAmend}>Save</Btn><Btn size="sm" variant="ghost" onClick={() => setEditItem(null)}>Cancel</Btn></div>
                    </div>
                  );
                }
                return (
                  <div key={it.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: canMark ? 10 : 0 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: C.text, fontWeight: 600, fontSize: 14.5 }}>{it.name}</div>
                        <div style={{ fontFamily: MONO, color: C.text3, fontSize: 12 }}>{it.sku} · {Math.round(it.quantity)} {it.unit}</div>
                      </div>
                      {!canMark && <span style={{ flexShrink: 0, alignSelf: "flex-start", display: "inline-block", padding: "3px 9px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, color: st.color, background: st.color + "1f", border: `1px solid ${st.color}44` }}>{st.label}</span>}
                    </div>
                    {canMark && <StatusPicker value={st.k} onChange={(s) => setItemStatus(it, s)} big />}
                    {canAmend && <div style={{ marginTop: canMark ? 10 : 8 }}><Btn size="sm" variant="ghost" onClick={() => startAmend(it)}>Edit line</Btn></div>}
                  </div>
                );
              })}
            </div>
          ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: "left", padding: "8px 10px", color: C.text3, borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={head.length}><Empty label="No items." /></td></tr>}
              {items.map((it) => {
                const st = itemStat(it);
                const prog = <StatusPicker value={st.k} onChange={(s) => setItemStatus(it, s)} />;
                const pill = <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, color: st.color, background: st.color + "1f", border: `1px solid ${st.color}44` }}>{st.label}</span>;
                if (canAmend && editItem && editItem.id === it.id) {
                  return (
                  <tr key={it.id} style={{ borderBottom: `1px solid ${C.border}`, background: C.surface2 }}>
                    <td style={{ padding: "6px 10px" }}><SkuCombo value={editItem.sku} catalog={catalog} style={cellInput(95)} onType={(v) => setEditItem({ ...editItem, sku: v })} onPick={(c) => setEditItem({ ...editItem, sku: c.sku, name: c.name, unit: c.unit || editItem.unit })} /></td>
                    <td style={{ padding: "6px 10px" }}><input value={editItem.name} onChange={(e) => { const v = e.target.value; const hit = byName[v]; setEditItem({ ...editItem, name: v, ...(hit ? { sku: hit.sku, unit: hit.unit || editItem.unit } : {}) }); }} style={cellInput()} /></td>
                    <td style={{ padding: "6px 10px" }}><input type="number" min="0" value={editItem.quantity} onChange={(e) => setEditItem({ ...editItem, quantity: e.target.value })} style={cellInput(70)} /></td>
                    <td style={{ padding: "6px 10px" }}><input value={editItem.unit} onChange={(e) => setEditItem({ ...editItem, unit: e.target.value })} style={cellInput(70)} /></td>
                    <td style={{ padding: "6px 10px" }}>{pill}</td>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}><Btn size="sm" onClick={saveAmend}>Save</Btn> <Btn size="sm" variant="ghost" onClick={() => setEditItem(null)}>Cancel</Btn></td>
                  </tr>
                  );
                }
                return (
                <tr key={it.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "8px 10px", fontFamily: MONO, color: C.text2 }}>{it.sku}</td>
                  <td style={{ padding: "8px 10px", color: C.text }}>{it.name}</td>
                  <td style={{ padding: "8px 10px", fontWeight: 700, color: C.text }}>{Math.round(it.quantity)}</td>
                  <td style={{ padding: "8px 10px", color: C.text3 }}>{it.unit}</td>
                  <td style={{ padding: "8px 10px" }}>{canMark ? prog : pill}</td>
                  {canAmend && <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}><Btn size="sm" variant="ghost" onClick={() => startAmend(it)}>Edit</Btn></td>}
                </tr>
              );})}
            </tbody>
          </table>
          )}
          {items.length > 0 && canAmend && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: C.text3 }}>Correct a line's STK, quantity or unit here. This changes OMS only — it won't update the SQL Account invoice, so keep them matching. Adding or removing whole lines still happens in SQL Account.</div>
          )}
          {items.length > 0 && !canAmend && canMove && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: C.text3 }}>Line items are locked to match the invoice — only an item's status can change. To correct a STK or quantity, fix it in SQL Account.</div>
          )}
        </div>
        );
      })()}
      {tab === "attachments" && (
        <div>
          <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input type="file" id="att-file-input" onChange={(e) => { uploadAttachment(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} />
            <Btn size="sm" variant="soft" onClick={() => document.getElementById("att-file-input").click()} disabled={uploading}><Icon name="plus" size={14} /> {uploading ? "Uploading…" : "Upload attachment"}</Btn>
            <span style={{ fontSize: 12, color: C.text3 }}>PDF or image · max {MAX_UPLOAD_MB} MB</span>
          </div>
          {(order.attachments || []).length === 0 && <Empty label="No attachments yet." />}
          {(order.attachments || []).map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
              <Icon name="message" size={15} color={C.text3} />
              {a.url
                ? <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: C.accent2, textDecoration: "none" }}>{a.original_name}</a>
                : <span style={{ fontSize: 13, color: C.text }}>{a.original_name}</span>}
              {a.kind === "pod" && <Pill color={C.ready} style={{ fontSize: 10 }}>Proof of delivery</Pill>}
              {a.size != null && <span style={{ fontSize: 11, color: C.text3 }}>{a.size >= 1048576 ? (a.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(a.size / 1024)) + " KB"}</span>}
              <span style={{ fontSize: 11.5, color: C.text3, marginLeft: "auto" }}>{a.uploaded_by_name}</span>
              {canMove && <button onClick={() => removeAttachment(a.id)} title="Remove" style={{ background: "#3a1a1a", border: "none", borderRadius: 6, color: "#fca5a5", cursor: "pointer", width: 24, height: 24, flexShrink: 0 }}>×</button>}
            </div>
          ))}
        </div>
      )}

      {!canMove && canAdvanceStage(user.role, order.stage) && !order.on_hold && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <Btn size="lg" style={{ width: "100%", justifyContent: "center" }} onClick={() => setConfirmAdv(true)} disabled={busy}>{ADVANCE_LABEL[order.stage] || "Mark complete"} →</Btn>
          <p style={{ fontSize: 12, color: C.text3, marginTop: 8, textAlign: "center" }}>Marks your stage done and moves the order to the next stage.</p>
        </div>
      )}
      {confirmAdv && (
        <AdvanceConfirmModal order={order} to={FORWARD_STAGE[order.stage]} user={user}
          onConfirm={async () => { await doMove(FORWARD_STAGE[order.stage]); setConfirmAdv(false); }}
          onClose={() => setConfirmAdv(false)} />
      )}

      {isLead && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, marginBottom: 8 }}>Lead actions</div>
          <input placeholder="Reason / note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text, marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="soft" size="sm" onClick={() => setFlag({ on_hold: !order.on_hold, reason: reason || undefined })} disabled={busy}>{order.on_hold ? "Release hold" : "Put on hold"}</Btn>
            <Btn variant="soft" size="sm" onClick={() => setFlag({ waiting_stock: !order.waiting_stock })} disabled={busy}>{order.waiting_stock ? "Clear waiting stock" : "Flag waiting stock"}</Btn>
            {order.stage === "packing" && <Btn variant="danger" size="sm" onClick={() => doMove("production", reason || "Sent back for rework")} disabled={busy}>Send back to production</Btn>}
          </div>
        </div>
      )}

      {canRoute && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, marginBottom: 8 }}>{canMove ? "Stage actions" : "Routing"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: canMove ? 12 : 0, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: C.text2, minWidth: 28 }}>In charge</span>
            <select value={order.pic_id || ""} onChange={(e) => assignPic(e.target.value)} style={{ flex: 1, minWidth: 180, padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text }}>
              <option value="" style={{ background: C.bg2 }}>Unassigned</option>
              {order.pic_id && !picUsers.some((u) => u.id === order.pic_id) && <option value={order.pic_id} style={{ background: C.bg2 }}>{order.pic_name || "Current PIC"}</option>}
              {picUsers.map((u) => <option key={u.id} value={u.id} style={{ background: C.bg2 }}>{u.name} — {ROLE_LABELS[u.role] || u.role}</option>)}
            </select>
            <span style={{ fontSize: 11.5, color: C.text3 }}>Saved automatically</span>
          </div>
          {canMove && (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <select value={moveStage} onChange={(e) => setMoveStage(e.target.value)} style={{ flex: 1, minWidth: 170, padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text }}>
                  <option value="" style={{ background: C.bg2 }}>Move to…</option>
                  {Object.keys(STAGE_LABELS).filter((k) => k !== order.stage && k !== "on_hold" && k !== "cancelled" && k !== "delivered").map((k) => <option key={k} value={k} style={{ background: C.bg2 }}>{STAGE_LABELS[k].label}</option>)}
                </select>
                <Btn onClick={() => doMove(moveStage, reason)} disabled={!moveStage || busy}>{moveStage ? `Move to ${STAGE_LABELS[moveStage].label}` : "Move"}</Btn>
              </div>
              <input placeholder="Reason / note (optional) — applies to the move, hold or cancel you choose" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text, marginBottom: 12 }} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn variant="soft" size="sm" onClick={() => setFlag({ on_hold: !order.on_hold, reason: reason || undefined })} disabled={busy}>{order.on_hold ? "Release hold" : "Put on hold"}</Btn>
                <Btn variant="soft" size="sm" onClick={() => setFlag({ waiting_stock: !order.waiting_stock })} disabled={busy}>{order.waiting_stock ? "Clear waiting stock" : "Flag waiting stock"}</Btn>
                <Btn variant="danger" size="sm" onClick={cancelOrder} disabled={busy}>Cancel order</Btn>
              </div>
            </>
          )}
          {!canMove && <p style={{ fontSize: 11.5, color: C.text3, marginTop: 10 }}>As Admin you route this order — set who's in charge, and adjust Priority / Importance above. Stage moves, holds and cancels stay with Ops.</p>}
        </div>
      )}
    </div>
  );
}
function LV({ label, v }) {
  return <div><div style={{ fontSize: 11, color: C.text3, fontWeight: 600, marginBottom: 2 }}>{label}</div><div style={{ fontSize: 14, color: C.text }}>{v}</div></div>;
}

// ─── Create order ──────────────────────────────────────────────────────────────
// Searchable STK picker — replaces the native <datalist> so it scales past 100+
// items: filters the catalogue by code OR name as you type, capped at 10 hits,
// shows code + product name. onPick fills the row; onType keeps free entry.
function SkuCombo({ value, catalog, onPick, onType, placeholder = "STK", style }) {
  const [open, setOpen] = useState(false);
  const ql = (value || "").trim().toLowerCase();
  const matches = (!ql ? (catalog || []) : (catalog || []).filter((c) => (c.sku || "").toLowerCase().includes(ql) || (c.name || "").toLowerCase().includes(ql))).slice(0, 10);
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input value={value} placeholder={placeholder} style={{ ...style, width: "100%" }}
        onChange={(e) => { onType(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)} />
      {open && matches.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 3px)", left: 0, minWidth: 240, zIndex: 40, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 9, maxHeight: 244, overflowY: "auto", boxShadow: "0 14px 36px rgba(0,0,0,.55)" }}>
          {matches.map((c) => (
            <div key={c.sku} onMouseDown={(e) => { e.preventDefault(); onPick(c); setOpen(false); }}
              style={{ padding: "8px 11px", cursor: "pointer", borderBottom: `1px solid ${C.border}` }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.surface2)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.accent2 }}>{c.sku}</div>
              <div style={{ fontSize: 11.5, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>{c.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function CreateOrderForm({ onCreated, onClose }) {
  const [f, setF] = useState({ invoice_number: "", customer_name: "", customer_contact: "", delivery_address: "", required_delivery_date: "", expiry_date: "", priority: "normal", importance: "standard", skip_production: false, notes: "" });
  const [items, setItems] = useState([{ sku: "", name: "", quantity: 1, unit: "pcs" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [holidays, setHolidays] = useState([]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const narrow = useViewport() < 640;
  useEffect(() => { api("GET", "/settings/holidays").then((d) => setHolidays(d || [])).catch(() => setHolidays([])); }, []);
  const [catalog, setCatalog] = useState([]);
  useEffect(() => { api("GET", "/orders/skus").then((d) => setCatalog(d || [])).catch(() => setCatalog([])); }, []);
  const bySku = {}, byName = {};
  for (const c of catalog) { if (c.sku) bySku[c.sku] = c; if (c.name && !byName[c.name]) byName[c.name] = c; }
  const holidayHit = f.required_delivery_date ? holidays.find((h) => h.date === f.required_delivery_date) : null;

  async function submit() {
    if (!f.invoice_number || !f.customer_name || !f.required_delivery_date) { setErr("Invoice, customer and delivery date are required."); return; }
    if (/^SI\d/i.test(f.invoice_number.trim())) { setErr("Invoice numbers starting with “SI” are reserved for SQL Account — use a manual code like INV-26-0001."); return; }
    setBusy(true); setErr("");
    try { await api("POST", "/orders", { ...f, items: items.filter((i) => i.name) }); onCreated && onCreated(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const inp = { padding: "8px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13, color: C.text };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 10 }}>
        <Field label="Invoice Number" value={f.invoice_number} onChange={(v) => set("invoice_number", v)} required placeholder="INV-26-0001" />
        <Field label="Priority" value={f.priority} onChange={(v) => set("priority", v)} options={[{ value: "normal", label: "Normal" }, { value: "urgent", label: "Urgent" }]} />
        <Field label="Importance" value={f.importance} onChange={(v) => set("importance", v)} options={IMPORTANCE_OPTS} />
        <Field label="Customer Name" value={f.customer_name} onChange={(v) => set("customer_name", v)} required />
        <Field label="Contact" value={f.customer_contact} onChange={(v) => set("customer_contact", v)} placeholder="01X-XXXXXXX" />
        <Field label="Delivery address" value={f.delivery_address} onChange={(v) => set("delivery_address", v)} placeholder="Where it ships to (optional — dispatch sees this)" />
        <Field label="Required Delivery Date" type="date" value={f.required_delivery_date} onChange={(v) => set("required_delivery_date", v)} required />
        <Field label="Expiry Date" type="date" value={f.expiry_date} onChange={(v) => set("expiry_date", v)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text2, marginTop: 26 }}>
          <input type="checkbox" checked={f.skip_production} onChange={(e) => set("skip_production", e.target.checked)} /> Skip production (→ packing)
        </label>
      </div>
      <p style={{ fontSize: 11.5, color: C.text3, margin: "2px 0 8px" }}>Manual invoice no. — use a code like <b>INV-26-0001</b>. Codes starting with “SI” are reserved for SQL Account.</p>
      {holidayHit && <p style={{ color: C.packing, fontSize: 12.5, margin: "0 0 8px" }}>⚠ {fmtDay(f.required_delivery_date)} is a holiday: {holidayHit.name}. Delivery may not happen that day.</p>}
      <Field label="Notes" value={f.notes} onChange={(v) => set("notes", v)} placeholder="Optional…" />
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, margin: "6px 0 8px" }}>Order Items <span style={{ fontWeight: 400, color: C.text3 }}>· type a STK or product to autofill</span></div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "110px 1fr 70px 64px 32px", gap: 6, marginBottom: 6 }}>
          <SkuCombo value={it.sku} catalog={catalog} placeholder="STK" style={inp}
            onType={(v) => setItems((a) => a.map((x, j) => j === i ? { ...x, sku: v } : x))}
            onPick={(c) => setItems((a) => a.map((x, j) => j === i ? { ...x, sku: c.sku, name: c.name, unit: c.unit || x.unit } : x))} />
          <input placeholder="Product" value={it.name} onChange={(e) => { const v = e.target.value; const hit = byName[v]; setItems((a) => a.map((x, j) => j === i ? { ...x, name: v, ...(hit ? { sku: hit.sku, unit: hit.unit || x.unit } : {}) } : x)); }} style={inp} />
          <input type="number" min="1" value={it.quantity} onChange={(e) => setItems((a) => a.map((x, j) => j === i ? { ...x, quantity: +e.target.value } : x))} style={inp} />
          <input placeholder="unit" value={it.unit} onChange={(e) => setItems((a) => a.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} style={inp} />
          <button onClick={() => setItems((a) => a.filter((_, j) => j !== i))} style={{ background: "#3a1a1a", border: "none", borderRadius: 8, color: "#fca5a5", cursor: "pointer" }}>×</button>
        </div>
      ))}
      <Btn variant="soft" size="sm" onClick={() => setItems((a) => [...a, { sku: "", name: "", quantity: 1, unit: "pcs" }])}>+ Add item</Btn>
      {err && <p style={{ color: "#fca5a5", fontSize: 13, margin: "12px 0 0" }}>{err}</p>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create order"}</Btn>
      </div>
    </div>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ onOpenOrder }) {
  const [d, setD] = useState(null);
  useEffect(() => { api("GET", "/reports/dashboard").then(setD).catch(() => setD({ _error: true })); }, []);
  const narrow = useViewport() < 640;
  if (!d) return <Loading />;
  if (d._error) return <Empty label="Could not load dashboard." />;
  const counts = Object.fromEntries((d.stage_counts || []).map((s) => [s.stage, s.count]));
  const max = Math.max(...BOARD_STAGES.map((s) => counts[s] || 0), 1);
  const metrics = [
    { label: "This Week", value: d.this_week_orders, color: C.order },
    { label: "This Month", value: d.this_month_orders, color: C.accent },
    { label: "Active Staff", value: d.active_staff, color: C.ready },
    { label: "Overdue", value: (d.overdue_orders || []).length, color: C.danger },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 14 }}>
        {metrics.map((m) => <Card key={m.label}><div style={{ fontSize: 30, fontWeight: 800, color: m.color }}>{m.value ?? 0}</div><div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{m.label}</div></Card>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 18 }}>
        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Orders by stage</h3>
          {BOARD_STAGES.map((s) => {
            const cfg = STAGES[s]; const c = counts[s] || 0;
            return (
              <div key={s} style={{ marginBottom: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}><span style={{ color: cfg.color, fontWeight: 600 }}>{cfg.label}</span><span style={{ color: C.text, fontWeight: 700 }}>{c}</span></div>
                <div style={{ height: 7, background: C.surface2, borderRadius: 4 }}><div style={{ height: 7, width: `${(c / max) * 100}%`, background: cfg.color, borderRadius: 4, transition: "width .5s" }} /></div>
              </div>
            );
          })}
        </Card>
        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Upcoming deliveries (7 days)</h3>
          {(d.upcoming_deliveries || []).length === 0 && <Empty label="None scheduled." />}
          {(d.upcoming_deliveries || []).map((o) => (
            <div key={o.id} onClick={() => onOpenOrder && onOpenOrder(o.id)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13, cursor: onOpenOrder ? "pointer" : "default" }}>
              <span><span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{o.invoice_number}</span> <span style={{ color: C.text3 }}>{o.customer_name}</span></span>
              <span style={{ color: countdown(o.required_delivery_date).tone }}>{fmtDay(o.required_delivery_date)} · {countdown(o.required_delivery_date).text}</span>
            </div>
          ))}
        </Card>
      </div>
      {(d.overdue_orders || []).length > 0 && (
        <Card style={{ borderColor: C.danger + "55", background: "#1f1310" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.danger, marginBottom: 10 }}>⚠ Overdue orders</h3>
          {d.overdue_orders.map((o) => (
            <div key={o.id} onClick={() => onOpenOrder && onOpenOrder(o.id)} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0", cursor: onOpenOrder ? "pointer" : "default" }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{o.invoice_number}</span>
              <span style={{ color: C.text3 }}>{o.customer_name}</span>
              <span style={{ color: C.danger }}>{fmtDay(o.required_delivery_date)}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Per-order breakdown report ──────────────────────────────────────────────
function OrdersReport({ period, from, to }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  useEffect(() => { setData(null); api("GET", `/reports/orders?${reportQuery(period, from, to)}`).then((d) => setData(d.orders || [])).catch(() => setData([])); }, [period, from, to]);
  const fmtDur = (h) => h == null ? "—" : h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
  function exportCsv() {
    const rows = [["Invoice", "Customer", "Stage", "STKs done", "STKs total", "% done", "Days in stage", "Cycle (h)", "Due", "Status", "PIC"]];
    for (const o of data) rows.push([o.invoice_number, o.customer_name || "", (STAGE_LABELS[o.stage] || {}).label || o.stage, o.done_count, o.item_count, o.pct, o.days_in_stage, o.cycle_hours, o.required_delivery_date, o.delivered ? (o.on_time ? "Delivered on-time" : "Delivered late") : (o.late ? "Late" : "In progress"), o.pic_name || ""]);
    const cust = Object.values(data.reduce((m, o) => { const k = o.customer_name || "—"; const r = m[k] || (m[k] = { name: k, orders: 0, delivered: 0, on_time: 0, late: 0 }); r.orders++; if (o.delivered) { r.delivered++; if (o.on_time) r.on_time++; } if (o.late) r.late++; return m; }, {})).sort((a, b) => b.orders - a.orders);
    rows.push([], ["By customer", "Orders", "Delivered", "On-time", "Late"], ...cust.map((c) => [c.name, c.orders, c.delivered, c.on_time, c.late]));
    downloadCsv(`orders-report-${period}.csv`, rows);
  }
  if (!data) return <Loading label="Loading orders…" />;
  if (data.length === 0) return <Empty label="No orders for this period." />;
  // Client-side rollup — one row per customer, no extra API call.
  const byCustomer = Object.values(data.reduce((m, o) => {
    const k = o.customer_name || "—";
    const r = m[k] || (m[k] = { name: k, orders: 0, delivered: 0, on_time: 0, late: 0, cyc: 0, cycN: 0 });
    r.orders++;
    if (o.delivered) { r.delivered++; if (o.on_time) r.on_time++; }
    if (o.late) r.late++;
    if (o.cycle_hours != null) { r.cyc += Number(o.cycle_hours); r.cycN++; }
    return m;
  }, {})).sort((a, b) => b.orders - a.orders);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.text3 }}>{data.length} orders · click a row for stage timeline & STK breakdown</span>
        <Btn variant="soft" size="sm" onClick={exportCsv}>Export orders CSV</Btn>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Stage", "Progress", "Days in stage", "Cycle", "Due", "Status"].map((h) => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {data.flatMap((o) => {
              const cfg = STAGE_LABELS[o.stage] || { label: o.stage, color: C.text3 };
              const isOpen = open[o.id];
              const statusPill = o.delivered
                ? <Pill color={o.on_time ? C.ready : C.danger}>{o.on_time ? "On-time" : "Late"}</Pill>
                : o.late ? <Pill color={C.danger}>Late</Pill> : <Pill color={C.text2}>In progress</Pill>;
              const rows = [
                <tr key={o.id} onClick={() => setOpen((p) => ({ ...p, [o.id]: !p[o.id] }))} style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
                  <td style={{ padding: "9px 14px", fontFamily: MONO, color: C.text }}>{o.invoice_number}</td>
                  <td style={{ padding: "9px 14px", color: C.text2 }}>{o.customer_name || "—"}</td>
                  <td style={{ padding: "9px 14px" }}><Pill color={cfg.color}>{cfg.label}</Pill></td>
                  <td style={{ padding: "9px 14px", minWidth: 130 }}>
                    <div style={{ fontSize: 12, color: C.text2, marginBottom: 3 }}>{o.done_count}/{o.item_count} STKs · {o.pct}%</div>
                    <div style={{ height: 4, background: C.surface2, borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${o.pct}%`, background: o.pct >= 100 ? C.ready : C.accent }} /></div>
                  </td>
                  <td style={{ padding: "9px 14px", color: C.text2 }}>{o.days_in_stage}d</td>
                  <td style={{ padding: "9px 14px", color: C.text2 }}>{fmtDur(o.cycle_hours)}</td>
                  <td style={{ padding: "9px 14px", color: countdown(o.required_delivery_date).tone }}>{fmtDay(o.required_delivery_date)}</td>
                  <td style={{ padding: "9px 14px" }}>{statusPill}</td>
                </tr>,
              ];
              if (isOpen) rows.push(
                <tr key={o.id + "-d"} style={{ background: C.bg2, borderBottom: `1px solid ${C.border}` }}>
                  <td colSpan={8} style={{ padding: "12px 18px" }}>
                    <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, marginBottom: 6, letterSpacing: 0.4 }}>STAGE TIME</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {BOARD_STAGES.map((s) => <Pill key={s} color={STAGES[s].color}>{STAGES[s].label}: {fmtDur(o.stage_hours[s])}</Pill>)}
                          {o.stage_hours.delivered != null && <Pill color={C.text3}>Delivered: {fmtDur(o.stage_hours.delivered)}</Pill>}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, marginBottom: 6, letterSpacing: 0.4 }}>STK STATUS</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <Pill color={C.ready}>Done: {o.done_count}</Pill>
                          <Pill color={C.packing}>Making: {o.in_progress_count}</Pill>
                          <Pill color={C.text3}>To do: {o.not_started_count}</Pill>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, marginBottom: 6, letterSpacing: 0.4 }}>PIC</div>
                        <div style={{ fontSize: 13, color: C.text2 }}>{o.pic_name || "Unassigned"}</div>
                      </div>
                    </div>
                  </td>
                </tr>
              );
              return rows;
            })}
          </tbody>
        </table>
      </Card>
      <div style={{ fontSize: 13, color: C.text3, margin: "20px 0 10px" }}>By customer · {byCustomer.length}</div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.bg2 }}>{["Customer", "Orders", "Delivered", "On-time", "Late", "Avg cycle"].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {byCustomer.map((c) => (
              <tr key={c.name} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "9px 14px", color: C.text }}>{c.name}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text, fontWeight: 700 }}>{c.orders}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text2 }}>{c.delivered}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.ready }}>{c.on_time}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: c.late > 0 ? C.danger : C.text3 }}>{c.late}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text2 }}>{c.cycN ? fmtDur(Math.round((c.cyc / c.cycN) * 10) / 10) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// Per-person productivity: who finished stages / made items this period.
// Deep drill-down for ONE person, opened from the Staff table. Volume / speed /
// reliability — the two headline volume numbers are benchmarked against the team
// average so a count actually reads as good/bad — plus a recent-activity feed and
// a per-staff CSV for the analyst/accounting crowd. Backed by /reports/staff/:id.
function StaffDetail({ staffId, period, from, to, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api("GET", `/reports/staff/${staffId}?${reportQuery(period, from, to)}`).then(setD).catch(() => setD(false));
  }, [staffId, period, from, to]);

  const secT = { fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".5px", color: C.text3, margin: "16px 2px 8px" };
  const fmtWhen = (s) => s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  function benchNode(value, avg) {
    if (!avg || avg <= 0) return null;
    const pct = Math.round(((value - avg) / avg) * 100);
    const up = pct >= 0;
    return <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 4, color: up ? C.green : C.danger }}>{up ? "▲ +" : "▼ "}{pct}% vs team avg {avg}</div>;
  }
  function exportCsv() {
    if (!d || !d.staff) return;
    const rows = [
      ["Staff", d.staff.name], ["Role", ROLE_LABELS[d.staff.role] || d.staff.role], ["Period", d.period], [],
      ["VOLUME"],
      ["Stages completed", d.volume.completions], ["Team avg stages", d.benchmark.avg_completions],
      ["Items made", d.volume.items_made], ["Items packed", d.volume.items_packed], ["Items total", d.volume.items_total], ["Team avg items", d.benchmark.avg_items],
      ["Produced", d.volume.breakdown.produced], ["Packed", d.volume.breakdown.packed], ["Delivered", d.volume.breakdown.delivered], ["Routed", d.volume.breakdown.routed], [],
      ["SPEED"], ["Active days", d.speed.active_days], ["Items per active day", d.speed.items_per_active_day], [],
      ["RELIABILITY"], ["On-time rate %", d.reliability.on_time_rate ?? "—"], ["On-time / total", `${d.reliability.on_time_count}/${d.reliability.on_time_total}`],
      ["Reworks (sent back)", d.reliability.reworks], ["Amendments made", d.reliability.amendments], [],
      ["WORKLOAD (live)"], ["Active as PIC", d.workload.active], ["Overdue", d.workload.overdue], ["On hold", d.workload.on_hold],
    ];
    downloadCsv(`staff-${String(d.staff.name).replace(/\s+/g, "-").toLowerCase()}-${d.period}.csv`, rows);
  }

  return (
    <Modal open onClose={onClose} title={d && d.staff ? d.staff.name : "Staff detail"} width={660}>
      {d == null && <Loading label="Loading staff detail…" />}
      {d === false && <Empty label="Could not load this person." />}
      {d && d.staff && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <Avatar name={d.staff.name} color={d.staff.avatar_color} size={42} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{d.staff.name}</div>
              <div style={{ fontSize: 12.5, color: C.text2 }}>{ROLE_LABELS[d.staff.role] || d.staff.role}</div>
            </div>
            <Btn variant="soft" size="sm" onClick={exportCsv}>Export CSV</Btn>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <Pill color={C.order}>{d.workload.active} active as PIC</Pill>
            {d.workload.overdue > 0 && <Pill color={C.danger}>{d.workload.overdue} overdue</Pill>}
            {d.workload.on_hold > 0 && <Pill color={C.hold}>{d.workload.on_hold} on hold</Pill>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <div><MetricCard label="Stages completed" value={d.volume.completions} tone={C.accent} />{benchNode(d.volume.completions, d.benchmark.avg_completions)}</div>
            <div><MetricCard label="Items made + packed" value={d.volume.items_total} tone={C.production} />{benchNode(d.volume.items_total, d.benchmark.avg_items)}</div>
            <MetricCard label="On-time delivery" value={d.reliability.on_time_rate == null ? "—" : `${d.reliability.on_time_rate}%`} tone={C.ready} />
          </div>

          <div style={secT}>Breakdown — stages moved</div>
          <Card style={{ padding: 14 }}>
            {[["Produced → packing", d.volume.breakdown.produced], ["Packed → ready", d.volume.breakdown.packed], ["Delivered", d.volume.breakdown.delivered], ["Routed → production", d.volume.breakdown.routed]].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13, color: C.text2 }}><span>{l}</span><span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{v}</span></div>
            ))}
            <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 6, paddingTop: 8, fontSize: 12.5, color: C.text3 }}>{d.speed.active_days} active days · {d.speed.items_per_active_day} items/day</div>
          </Card>

          <div style={secT}>Quality flags</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Pill color={d.reliability.reworks > 0 ? C.hold : C.text3}>{d.reliability.reworks} reworks</Pill>
            <Pill color={d.reliability.amendments > 0 ? C.hold : C.text3}>{d.reliability.amendments} amendments</Pill>
            <Pill color={C.text2}>{d.reliability.on_time_count}/{d.reliability.on_time_total} on time</Pill>
          </div>

          {d.trend && d.trend.length > 0 && (<><div style={secT}>Daily output — 14 days</div><TrendChart data={d.trend} color={C.accent} label="Completed" /></>)}

          <div style={secT}>Recent activity</div>
          <Card style={{ padding: 6 }}>
            {(!d.activity || d.activity.length === 0)
              ? <Empty label="No recent activity." />
              : d.activity.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "7px 10px", borderBottom: i < d.activity.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 12.5 }}>
                  <span style={{ color: C.text }}>{a.details || a.action}</span>
                  {a.invoice_number && <span style={{ fontFamily: MONO, color: C.accent2 }}>{a.invoice_number}</span>}
                  <span style={{ marginLeft: "auto", color: C.text3, whiteSpace: "nowrap" }}>{fmtWhen(a.created_at)}</span>
                </div>
              ))}
          </Card>
        </div>
      )}
    </Modal>
  );
}

function StaffReport({ period, from, to, staffId }) {
  const [raw, setRaw] = useState(null);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { setRaw(null); api("GET", `/reports/staff?${reportQuery(period, from, to)}`).then((d) => setRaw(d.staff || [])).catch(() => setRaw([])); }, [period, from, to]);
  const data = raw == null ? null : (staffId ? raw.filter((s) => s.id === staffId) : raw);
  function exportCsv() {
    const rows = [["Name", "Role", "Stages completed", "Items done", "Reworks"]];
    for (const s of data) rows.push([s.name, ROLE_LABELS[s.role] || s.role, s.completions, s.items_done, s.reworks]);
    downloadCsv(`staff-report-${period}.csv`, rows);
  }
  if (!data) return <Loading label="Loading staff…" />;
  if (data.length === 0) return <Empty label="No staff activity for this period." />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.text3 }}>{data.length} people · tap a name for full detail</span>
        <Btn variant="soft" size="sm" onClick={exportCsv}>Export staff CSV</Btn>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.bg2 }}>{["Name", "Role", "Stages completed", "Items done", "Reworks"].map((h, i) => <th key={h} style={{ textAlign: i > 1 ? "right" : "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}<th style={{ borderBottom: `1px solid ${C.border}` }} /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} onClick={() => setOpenId(s.id)} title="View full detail" style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.surface2)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <td style={{ padding: "9px 14px", color: C.text }}><span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Avatar name={s.name} color={s.avatar_color} size={24} />{s.name}</span></td>
                <td style={{ padding: "9px 14px", color: C.text2 }}>{ROLE_LABELS[s.role] || s.role}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text, fontWeight: 700 }}>{s.completions}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text2 }}>{s.items_done}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: s.reworks > 0 ? C.danger : C.text3 }}>{s.reworks}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.accent2, fontFamily: MONO }}>›</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {openId && <StaffDetail staffId={openId} period={period} from={from} to={to} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// Per person-in-charge: live open workload + how much they completed this period.
function PicReport({ period, from, to, staffId }) {
  const [raw, setRaw] = useState(null);
  useEffect(() => { setRaw(null); api("GET", `/reports/pic?${reportQuery(period, from, to)}`).then((d) => setRaw(d.pics || [])).catch(() => setRaw([])); }, [period, from, to]);
  const data = raw == null ? null : (staffId ? raw.filter((p) => p.id === staffId) : raw);
  function exportCsv() {
    const rows = [["Person in charge", "Role", "Open now", "Overdue", "On hold", "Completed (period)"]];
    for (const p of data) rows.push([p.name, ROLE_LABELS[p.role] || p.role, p.active, p.overdue, p.on_hold, p.completed]);
    downloadCsv(`pic-report-${period}.csv`, rows);
  }
  if (!data) return <Loading label="Loading people…" />;
  if (data.length === 0) return <Empty label="No one is in charge of orders yet." />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.text3 }}>Open / Overdue / On-hold are live now · Completed counts this period</span>
        <Btn variant="soft" size="sm" onClick={exportCsv}>Export PIC CSV</Btn>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.bg2 }}>{["Person in charge", "Role", "Open now", "Overdue", "On hold", "Completed"].map((h, i) => <th key={h} style={{ textAlign: i > 1 ? "right" : "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "9px 14px", color: C.text }}><span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Avatar name={p.name} color={p.avatar_color} size={24} />{p.name}</span></td>
                <td style={{ padding: "9px 14px", color: C.text2 }}>{ROLE_LABELS[p.role] || p.role}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.text, fontWeight: 700 }}>{p.active}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: p.overdue > 0 ? C.danger : C.text3 }}>{p.overdue}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: p.on_hold > 0 ? C.hold : C.text3 }}>{p.on_hold}</td>
                <td style={{ padding: "9px 14px", textAlign: "right", color: C.ready, fontWeight: 700 }}>{p.completed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// Small KPI card: colored by what the metric means (green = good, red = bad, amber = needs attention).
function metricTone(label) {
  const l = label.toLowerCase();
  if (l.includes("on-time")) return C.ready;
  if (l.includes("rework") || l.includes("failed")) return C.danger;
  if (l.includes("pending")) return C.hold;
  return C.accent;
}
function MetricCard({ label, value, tone }) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ height: 3, background: tone }} />
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: tone }}>{value ?? "—"}</div>
        <div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{label}</div>
      </div>
    </Card>
  );
}

// Build the report query string: explicit date range wins over the period quick-pick.
const reportQuery = (period, from, to) => (from && to) ? `from=${from}&to=${to}` : `period=${period}`;
// Daily trend rendered with Recharts — bar for volume, line variant for delivery.
function TrendChart({ data, kind = "bar", color = C.accent, label = "Count" }) {
  const rows = (data || []).map((t) => ({ date: String(t.date).slice(5), count: t.count }));
  if (!rows.length) return null;
  return (
    <Card>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Daily trend</h3>
      <ResponsiveContainer width="100%" height={220}>
        {kind === "line" ? (
          <LineChart data={rows} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="date" tick={{ fill: C.text3, fontSize: 11 }} stroke={C.border2} />
            <YAxis allowDecimals={false} tick={{ fill: C.text3, fontSize: 11 }} stroke={C.border2} />
            <Tooltip contentStyle={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} labelStyle={{ color: C.text2 }} />
            <Line type="monotone" dataKey="count" name={label} stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} />
          </LineChart>
        ) : (
          <BarChart data={rows} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: C.text3, fontSize: 11 }} stroke={C.border2} />
            <YAxis allowDecimals={false} tick={{ fill: C.text3, fontSize: 11 }} stroke={C.border2} />
            <Tooltip cursor={{ fill: C.surface2 }} contentStyle={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} labelStyle={{ color: C.text2 }} />
            <Bar dataKey="count" name={label} fill={color} radius={[5, 5, 0, 0]} maxBarSize={42} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </Card>
  );
}

// Efficiency lens: end-to-end cycle time, on-time rate, the bottleneck stage and
// aging WIP. Backed by /reports/efficiency. Boss/Ops only.
function EfficiencyReport({ period, from, to }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api("GET", `/reports/efficiency?${reportQuery(period, from, to)}`).then(setD).catch(() => setD(false)); }, [period, from, to]);
  if (d == null) return <Loading label="Loading efficiency…" />;
  if (d === false) return <Empty label="Could not load efficiency." />;
  const secT = { fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".5px", color: C.text3, margin: "18px 2px 9px" };
  const STG = { order: "Order → Prod", production: "Production", packing: "Packing", ready_for_delivery: "Ready → Out" };
  const STG_COLOR = { order: C.order, production: C.production, packing: C.packing, ready_for_delivery: C.ready };
  const hrs = (h) => h == null ? "—" : (Number(h) >= 48 ? Math.round(Number(h) / 24) + "d" : Number(h).toFixed(1) + "h");
  const order = ["order", "production", "packing", "ready_for_delivery"];
  const dwell = (d.stage_dwell || []).slice().sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  const maxH = Math.max(1, ...dwell.map((s) => Number(s.avg_hours) || 0));
  const aging = d.aging || [];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14 }}>
        <MetricCard label={`Avg cycle · order→delivered${d.cycle_n ? ` (${d.cycle_n})` : ""}`} value={hrs(d.avg_cycle_hours)} tone={C.accent} />
        <MetricCard label="On-time delivery" value={d.on_time_rate == null ? "—" : `${d.on_time_rate}%`} tone={C.ready} />
        <MetricCard label="Bottleneck stage" value={d.bottleneck ? (STG[d.bottleneck.stage] || d.bottleneck.stage) : "—"} tone={C.danger} />
      </div>

      {dwell.length > 0 && (<>
        <div style={secT}>Average time in each stage</div>
        <Card>
          {dwell.map((s) => {
            const w = Math.round((Number(s.avg_hours) / maxH) * 100);
            const isBn = d.bottleneck && d.bottleneck.stage === s.stage;
            return (
              <div key={s.stage} style={{ display: "grid", gridTemplateColumns: "110px 1fr 56px", gap: 10, alignItems: "center", padding: "5px 0" }}>
                <span style={{ fontSize: 12.5, color: C.text2 }}>{STG[s.stage] || s.stage}</span>
                <div style={{ height: 8, borderRadius: 5, background: C.surface2, overflow: "hidden" }}><div style={{ width: `${w}%`, height: "100%", borderRadius: 5, background: isBn ? C.danger : (STG_COLOR[s.stage] || C.accent) }} /></div>
                <span style={{ textAlign: "right", fontFamily: MONO, fontWeight: 700, fontSize: 12.5, color: isBn ? C.danger : C.text }}>{hrs(s.avg_hours)}</span>
              </div>
            );
          })}
          <div style={{ fontSize: 11.5, color: C.text3, marginTop: 8 }}>Longest bar = where orders pile up.</div>
        </Card>
      </>)}

      <div style={secT}>Aging — oldest open orders</div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        {aging.length === 0 ? <Empty label="Nothing aging — all open orders are fresh." /> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Stage", "Days open", "Days late"].map((h, i) => <th key={h} style={{ textAlign: i > 1 ? "right" : "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {aging.map((o) => (
                <tr key={o.invoice_number} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "9px 14px", fontFamily: MONO, color: C.accent2 }}>{o.invoice_number}</td>
                  <td style={{ padding: "9px 14px", color: C.text2, textTransform: "capitalize" }}>{STG[o.stage] || String(o.stage).replace(/_/g, " ")}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right", color: C.text, fontWeight: 700 }}>{o.days_open}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right" }}>{o.days_late > 0 ? <Pill color={C.danger}>+{o.days_late}</Pill> : <span style={{ color: C.text3 }}>on time</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// Mistakes lens: amendments, late / failed deliveries, cancellations, holds and
// waiting-stock — the errors nothing aggregated before. Backed by /reports/mistakes.
function MistakesReport({ period, from, to }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api("GET", `/reports/mistakes?${reportQuery(period, from, to)}`).then(setD).catch(() => setD(false)); }, [period, from, to]);
  if (d == null) return <Loading label="Loading mistakes…" />;
  if (d === false) return <Empty label="Could not load mistakes." />;
  const secT = { fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".5px", color: C.text3, margin: "18px 2px 9px" };
  const fmtWhen = (s) => s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const cards = [
    ["Amendments", d.amendments.count, C.danger], ["Late deliveries", d.late.count, C.danger], ["Failed deliveries", d.failed_count, C.danger],
    ["Cancelled", d.cancelled_count, C.hold], ["On hold now", d.on_hold_count, C.hold], ["Waiting stock", d.waiting_stock_count, C.hold],
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
        {cards.map(([l, v, tone]) => <MetricCard key={l} label={l} value={v} tone={tone} />)}
      </div>

      <div style={secT}>Amendments — orders corrected after placement</div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        {d.amendments.list.length === 0 ? <Empty label="No amendments this period." /> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "By", "Change", "When"].map((h) => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.amendments.list.map((a, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "9px 14px", fontFamily: MONO, color: C.accent2 }}>{a.invoice_number || "—"}</td>
                  <td style={{ padding: "9px 14px", color: C.text2 }}>{a.user_name || "—"}</td>
                  <td style={{ padding: "9px 14px", color: C.text }}>{a.details || "edited"}</td>
                  <td style={{ padding: "9px 14px", color: C.text3, whiteSpace: "nowrap" }}>{fmtWhen(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {d.late.list.length > 0 && (<>
        <div style={secT}>Late deliveries</div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Days late", "Driver"].map((h, i) => <th key={h} style={{ textAlign: i === 1 ? "right" : "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.late.list.map((o, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "9px 14px", fontFamily: MONO, color: C.accent2 }}>{o.invoice_number}</td>
                  <td style={{ padding: "9px 14px", textAlign: "right" }}><Pill color={C.danger}>+{o.days_late}</Pill></td>
                  <td style={{ padding: "9px 14px", color: C.text2 }}>{o.driver || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </>)}

      {d.trend && d.trend.length > 0 && (<><div style={secT}>Amendments — last 8 weeks</div><TrendChart data={d.trend} color={C.danger} label="Amendments" /></>)}
    </div>
  );
}

// Reward scorecard / leaderboard — composite 0–100 per department or per person,
// the engine for the reward system and the floor leaderboard. Pillars + weights
// are computed server-side (/reports/scorecard); weights are edited in System
// Settings. Output & Speed are scaled to the best performer that period. ▲▼ = move
// vs last period. Only weekly / monthly (daily falls back to monthly).
function ScoreboardReport({ period }) {
  const [unit, setUnit] = useState("dept");
  const [d, setD] = useState(null);
  const scope = period === "weekly" ? "weekly" : "monthly";
  useEffect(() => { setD(null); api("GET", `/reports/scorecard?unit=${unit}&period=${scope}`).then(setD).catch(() => setD(false)); }, [unit, scope]);
  if (d === false) return <Empty label="Could not load scorecard." />;
  if (!d) return <Loading label="Loading scorecard…" />;
  const lb = d.leaderboard || [];
  const w = d.weights || {};
  const wsum = (w.ontime + w.output + w.quality + w.speed) || 1;
  const PILLARS = [["ontime", "On-time"], ["output", "Output"], ["quality", "Quality"], ["speed", "Speed"]];
  const medals = ["🥇", "🥈", "🥉"];
  const pcol = (v) => v >= 85 ? C.ready : v >= 70 ? C.hold : C.danger;
  const per = scope === "weekly" ? "week" : "month";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 3, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 9, padding: 3 }}>
          {[["dept", "Departments"], ["people", "People"]].map(([k, lbl]) => {
            const on = unit === k;
            return <button key={k} onClick={() => setUnit(k)} style={{ background: on ? C.surface2 : "transparent", border: "none", borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: on ? 700 : 500, color: on ? C.text : C.text2 }}>{lbl}</button>;
          })}
        </div>
        <span style={{ fontSize: 12, color: C.text3 }}>
          Weights · On-time {Math.round(w.ontime / wsum * 100)}% · Output {Math.round(w.output / wsum * 100)}% · Quality {Math.round(w.quality / wsum * 100)}% · Speed {Math.round(w.speed / wsum * 100)}% · <span style={{ color: C.text2 }}>set in System Settings</span>
        </span>
      </div>
      {lb.length === 0 ? <Empty label="No activity to score this period yet." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lb.map((u, i) => {
            const first = i === 0;
            const delta = u.delta;
            const dEl = delta == null ? <span style={{ color: C.text3, fontSize: 12 }}>new</span>
              : delta > 0 ? <span style={{ color: C.ready, fontWeight: 700, fontSize: 12 }}>▲{delta}</span>
              : delta < 0 ? <span style={{ color: C.danger, fontWeight: 700, fontSize: 12 }}>▼{-delta}</span>
              : <span style={{ color: C.text3, fontSize: 12 }}>—</span>;
            return (
              <Card key={u.key} style={{ padding: "14px 16px", border: `1px solid ${first ? C.accent : C.border}`, display: "grid", gridTemplateColumns: "42px 1fr 92px", gap: 14, alignItems: "center" }}>
                <div style={{ textAlign: "center", fontSize: i < 3 ? 24 : 18, fontWeight: 800, fontFamily: i < 3 ? "inherit" : MONO, color: C.text2 }}>{i < 3 ? medals[i] : "#" + (i + 1)}</div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15.5, fontWeight: 700, color: C.text }}>{u.name}</span>
                    {u.dept && <Pill color={u.color || C.accent} style={{ fontSize: 10 }}>{u.dept}</Pill>}
                    {dEl}
                    {first && <Pill color={C.accent} style={{ fontSize: 10 }}>🏆 Champion</Pill>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 9 }}>
                    {PILLARS.map(([k, lbl]) => {
                      const v = (u.pillars && u.pillars[k]) || 0;
                      return (
                        <div key={k} style={{ fontSize: 10, color: C.text3 }}>
                          {lbl}<span style={{ float: "right", fontFamily: MONO, color: C.text2 }}>{v}</span>
                          <div style={{ height: 6, borderRadius: 4, background: C.surface2, overflow: "hidden", marginTop: 3, clear: "both" }}><div style={{ width: v + "%", height: "100%", background: pcol(v) }} /></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 800, lineHeight: 1, color: first ? C.accent : C.text }}>{u.score}</div>
                  <div style={{ fontSize: 10.5, color: C.text3 }}>/ 100</div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 14, fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
        Score blends four pillars — On-time, Output, Quality, Speed — each 0–100 (Output &amp; Speed scaled to the best {unit === "people" ? "person" : "department"} this {per}). ▲▼ shows movement vs last {per}. Built from existing data — no money. Change the weights in System Settings.
      </div>
    </div>
  );
}

// Month-over-month trend — the "are we getting better or worse" view. Four metrics
// (completed, on-time %, rework %, avg cycle days) plotted across the last 6 months.
// Backed by /reports/trend. Boss/Ops only. Monthly by nature — ignores the period bar.
function MoMReport() {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api("GET", "/reports/trend?months=6").then(setD).catch(() => setD(false)); }, []);
  if (d === false) return <Empty label="Could not load trend." />;
  if (!d) return <Loading label="Loading trend…" />;
  const rows = d.trend || [];
  const mLabel = (m) => { const dt = new Date(m + "-01T00:00:00"); return isNaN(dt) ? m : dt.toLocaleDateString("en-GB", { month: "short" }); };
  const data = rows.map((r) => ({ ...r, label: mLabel(r.month) }));
  // good: which direction is an improvement, for colouring the month-over-month delta.
  const METRICS = [
    { key: "completed", label: "Orders completed", color: C.accent, good: "up", fmt: (v) => (v == null ? "—" : v) },
    { key: "on_time_rate", label: "On-time %", color: C.ready, good: "up", fmt: (v) => (v == null ? "—" : v + "%") },
    { key: "rework_rate", label: "Rework %", color: C.danger, good: "down", fmt: (v) => (v == null ? "—" : v + "%") },
    { key: "avg_cycle_days", label: "Avg days / order", color: C.order, good: "down", fmt: (v) => (v == null ? "—" : v + "d") },
  ];
  if (rows.length === 0) return <Empty label="No history to trend yet." />;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
        {METRICS.map((mt) => {
          const last = rows[rows.length - 1], prev = rows[rows.length - 2];
          const lv = last ? last[mt.key] : null, pv = prev ? prev[mt.key] : null;
          let dEl = <span style={{ color: C.text3, fontSize: 12 }}>—</span>;
          if (lv != null && pv != null) {
            const diff = +(lv - pv).toFixed(1);
            if (diff === 0) dEl = <span style={{ color: C.text3, fontSize: 12 }}>no change</span>;
            else {
              const improving = mt.good === "up" ? diff > 0 : diff < 0;
              dEl = <span style={{ color: improving ? C.ready : C.danger, fontWeight: 700, fontSize: 12 }}>{diff > 0 ? "▲" : "▼"}{Math.abs(diff)}{mt.key === "completed" ? "" : mt.key === "avg_cycle_days" ? "d" : "%"} vs last month</span>;
            }
          }
          return (
            <Card key={mt.key}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ fontSize: 12.5, color: C.text2, fontWeight: 600 }}>{mt.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: mt.color }}>{mt.fmt(lv)}</span>
              </div>
              <div style={{ marginBottom: 8 }}>{dEl}</div>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={data} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: C.text3, fontSize: 11 }} axisLine={{ stroke: C.border }} tickLine={false} />
                  <YAxis tick={{ fill: C.text3, fontSize: 11 }} axisLine={false} tickLine={false} width={34} />
                  <Tooltip contentStyle={{ background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.text2 }} itemStyle={{ color: mt.color }} formatter={(v) => [mt.fmt(v), mt.label]} />
                  <Line type="monotone" dataKey={mt.key} stroke={mt.color} strokeWidth={2.5} dot={{ r: 3, fill: mt.color }} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          );
        })}
      </div>
      <div style={{ marginTop: 14, fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
        Last 6 months, one point per month. Green ▲▼ = improving, red = slipping. For on-time and rework, a month with no completed orders shows a gap. Built from existing data — no money.
      </div>
    </div>
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────
function Reports({ user }) {
  const tabsForRole = user.role === "production_lead"
    ? ["production", "packing", "staff", "pic", ...(REWARD_SYSTEM_ENABLED ? ["scorecard"] : [])]
    : ["production", "packing", "delivery", "efficiency", "mistakes", ...(REWARD_SYSTEM_ENABLED ? ["scorecard"] : []), "trend", "orders", "staff", "pic"];
  const CUSTOM = ["orders", "staff", "pic", "efficiency", "mistakes", "scorecard", "trend"]; // tabs with their own component (no metric cards/trend)
  const TAB_LABEL = { staff: "Staff", pic: "Person in charge", efficiency: "Efficiency", mistakes: "Mistakes", scorecard: "Scoreboard", trend: "Trend" };
  const PERIOD_LABEL = { daily: "Today", weekly: "This week", monthly: "This month" };
  const TAB_DESC = {
    production: "Throughput, on-time rate and reworks in production",
    packing: "Packing throughput and turnaround time",
    delivery: "Deliveries completed, on-time rate and drivers",
    efficiency: "Cycle time, bottleneck stage and aging orders",
    mistakes: "Amendments, late / failed deliveries, holds",
    orders: "Per-order progress, cycle time and customer rollup",
    staff: "What each person finished this period",
    pic: "Live workload per person in charge",
    scorecard: "Reward score per department or person",
    trend: "Month-over-month: better or worse?",
  };
  const [tab, setTab] = useState(tabsForRole[0]);
  const [period, setPeriod] = useState("weekly");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [staffId, setStaffId] = useState("");
  const [staffOpts, setStaffOpts] = useState([]);
  const [d, setD] = useState({});
  const [busy, setBusy] = useState("");
  const usingRange = !!(from && to);
  const q = reportQuery(period, from, to);
  const rangeLabel = usingRange ? `${from} → ${to}` : (PERIOD_LABEL[period] || period);
  const dateInp = { padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13, colorScheme: "dark" };

  useEffect(() => { if (CUSTOM.includes(tab)) return; setD({}); api("GET", `/reports/${tab}?${q}`).then(setD).catch(() => setD({})); }, [tab, q]);
  // Staff list for the "individual staff" filter — sourced from the staff report so leads can read it too.
  useEffect(() => {
    if (!(tabsForRole.includes("staff") || tabsForRole.includes("pic"))) return;
    api("GET", `/reports/staff?${q}`).then((dd) => setStaffOpts(dd.staff || [])).catch(() => {});
  }, [q]);

  const metricDefs = {
    production: (d) => [["Orders Completed", d.completed], ["STKs Made", d.units_made], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["Avg Production", d.avg_production_hours ? d.avg_production_hours + "h" : "—"], ["Reworks", d.rework_count], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"], ["In Production Now", d.in_stage]],
    packing: (d) => [["Orders Packed", d.packed], ["Avg Pack Time", d.avg_pack_minutes ? d.avg_pack_minutes + "min" : "—"], ["Reworks", d.rework_count], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"], ["In Packing Now", d.in_stage]],
    delivery: (d) => [["Total Deliveries", d.total_deliveries], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["On-Time Count", d.on_time_count], ["Avg Turnaround", d.avg_turnaround_hours != null ? (Number(d.avg_turnaround_hours) >= 48 ? Math.round(Number(d.avg_turnaround_hours) / 24) + "d" : d.avg_turnaround_hours + "h") : "—"], ["Pending Now", d.pending_count], ["Failed", d.failed_count]],
  };
  const metrics = CUSTOM.includes(tab) ? {} : { [tab]: metricDefs[tab](d) };
  const trend = d.daily_trend || [];

  const META = { production: "Production", packing: "Packing", delivery: "Delivery" };
  const kpiRows = (key, dd) => (metricDefs[key] ? metricDefs[key](dd).map(([k, v]) => [k, v == null ? "" : String(v)]) : []);
  const fileTag = usingRange ? `${from}_${to}` : period;
  async function fetchReportData() {
    const keys = tabsForRole.filter((k) => metricDefs[k]);
    const parts = await Promise.all(keys.map((k) => api("GET", `/reports/${k}?${q}`).then((dd) => [k, dd]).catch(() => [k, {}])));
    const data = Object.fromEntries(parts);
    if (tabsForRole.includes("staff")) data._staff = await api("GET", `/reports/staff?${q}`).then((dd) => dd.staff || []).catch(() => []);
    if (tabsForRole.includes("pic")) data._pics = await api("GET", `/reports/pic?${q}`).then((dd) => dd.pics || []).catch(() => []);
    return data;
  }
  async function exportCsv() {
    setBusy("csv");
    try {
      const data = await fetchReportData();
      const rows = [["Wawasan Candle — Reports"], ["Range", rangeLabel], []];
      for (const key of tabsForRole.filter((k) => metricDefs[k])) {
        const dd = data[key] || {};
        rows.push([META[key]], ["Metric", "Value"], ...kpiRows(key, dd));
        if ((dd.by_delivery_man || []).length) rows.push([], ["Driver", "Deliveries", "On time"], ...dd.by_delivery_man.map((x) => [x.name, x.total, x.on_time]));
        if ((dd.daily_trend || []).length) rows.push([], ["Date", "Count"], ...dd.daily_trend.map((t) => [t.date, t.count]));
        rows.push([]);
      }
      if (data._staff) rows.push(["Staff productivity"], ["Name", "Role", "Stages completed", "Items done", "Reworks"], ...data._staff.map((s) => [s.name, ROLE_LABELS[s.role] || s.role, s.completions, s.items_done, s.reworks]), []);
      if (data._pics) rows.push(["Person in charge"], ["Name", "Role", "Open now", "Overdue", "On hold", "Completed"], ...data._pics.map((p) => [p.name, ROLE_LABELS[p.role] || p.role, p.active, p.overdue, p.on_hold, p.completed]), []);
      downloadCsv(`reports-${fileTag}.csv`, rows);
    } finally { setBusy(""); }
  }
  async function exportExcel() {
    setBusy("xlsx");
    try {
      const data = await fetchReportData();
      const wb = XLSX.utils.book_new();
      for (const key of tabsForRole.filter((k) => metricDefs[k])) {
        const dd = data[key] || {};
        const rows = [[`${META[key]} — ${rangeLabel}`], [], ["Metric", "Value"], ...kpiRows(key, dd)];
        if ((dd.by_delivery_man || []).length) rows.push([], ["Driver", "Deliveries", "On time"], ...dd.by_delivery_man.map((x) => [x.name, x.total, x.on_time]));
        if ((dd.daily_trend || []).length) rows.push([], ["Date", "Count"], ...dd.daily_trend.map((t) => [t.date, t.count]));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), META[key]);
      }
      if (data._staff) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Role", "Stages completed", "Items done", "Reworks"], ...data._staff.map((s) => [s.name, ROLE_LABELS[s.role] || s.role, s.completions, s.items_done, s.reworks])]), "Staff");
      if (data._pics) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Role", "Open now", "Overdue", "On hold", "Completed"], ...data._pics.map((p) => [p.name, ROLE_LABELS[p.role] || p.role, p.active, p.overdue, p.on_hold, p.completed])]), "PIC");
      XLSX.writeFile(wb, `reports-${fileTag}.xlsx`);
    } finally { setBusy(""); }
  }
  async function exportPdf() {
    setBusy("pdf");
    try {
      const data = await fetchReportData();
      // jspdf-autotable's default export can arrive as the fn or as { default: fn } depending on the bundler.
      const autoTable = typeof autoTableImport === "function" ? autoTableImport : (autoTableImport && autoTableImport.default);
      // jsPDF's built-in fonts are WinAnsi — swap dashes/arrows so they don't render as boxes.
      const ascii = (v) => String(v == null ? "" : v).replace(/[—–−]/g, "-").replace(/→/g, "->");
      // Mirror the web theme (C tokens) as RGB so the PDF looks like the Reports page.
      const G = {
        accent: [249, 115, 22], green: [52, 211, 153], red: [239, 68, 68], amber: [234, 179, 8],
        bg: [22, 19, 15], surface: [28, 24, 19], surface2: [36, 31, 24], border: [44, 38, 32],
        text: [237, 231, 223], text2: [176, 167, 156], text3: [130, 122, 112],
      };
      const tone = (label) => { const l = String(label).toLowerCase(); return l.includes("on-time") ? G.green : (l.includes("rework") || l.includes("failed")) ? G.red : l.includes("pending") ? G.amber : G.accent; };
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const PW = 210, PH = 297, M = 14, CW = PW - M * 2;
      let y = M;
      const paintBg = () => { doc.setFillColor(...G.bg); doc.rect(0, 0, PW, PH, "F"); };
      const newPage = () => { doc.addPage(); paintBg(); y = M; };
      const need = (h) => { if (y + h > PH - M) newPage(); };
      paintBg();
      doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(...G.text);
      doc.text("Wawasan Candle - Reports", M, y + 5);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...G.text3);
      doc.text(`Department performance  -  ${ascii(rangeLabel)}`, M, y + 11);
      y += 20;

      const heading = (t) => {
        need(12);
        doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(...G.text);
        doc.text(ascii(t), M, y + 3);
        doc.setDrawColor(...G.border); doc.setLineWidth(0.3); doc.line(M, y + 5.5, M + CW, y + 5.5);
        y += 11;
      };
      const kpiCards = (pairs) => {
        const per = 4, gap = 4, cw = (CW - gap * (per - 1)) / per, ch = 22;
        for (let i = 0; i < pairs.length; i++) {
          const col = i % per;
          if (col === 0) need(ch + 4);
          const x = M + col * (cw + gap);
          const [label, value] = pairs[i]; const tc = tone(label);
          doc.setFillColor(...G.surface); doc.roundedRect(x, y, cw, ch, 1.5, 1.5, "F");
          doc.setFillColor(...tc); doc.rect(x, y, cw, 1.6, "F");
          doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(...tc);
          doc.text(ascii(value == null || value === "" ? "-" : value), x + 4, y + 12);
          doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...G.text3);
          doc.text(ascii(label), x + 4, y + 18, { maxWidth: cw - 8 });
          if (col === per - 1 || i === pairs.length - 1) y += ch + 5;
        }
      };
      const trendChart = (trend, kind, col) => {
        if (!trend || !trend.length) return;
        const h = 50; need(h + 6);
        doc.setFillColor(...G.surface); doc.roundedRect(M, y, CW, h, 1.5, 1.5, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...G.text2);
        doc.text("Daily trend", M + 4, y + 6);
        const plotX = M + 6, plotW = CW - 12, plotTop = y + 10, plotH = h - 20, baseY = plotTop + plotH;
        const maxV = Math.max(...trend.map((t) => t.count), 1), n = trend.length;
        doc.setDrawColor(...G.border); doc.setLineWidth(0.2); doc.line(plotX, baseY, plotX + plotW, baseY);
        doc.setFontSize(6); doc.setTextColor(...G.text3);
        const step = Math.max(1, Math.ceil(n / 8));
        if (kind === "line") {
          doc.setDrawColor(...col); doc.setLineWidth(0.7); let prev = null;
          for (let i = 0; i < n; i++) {
            const cx = plotX + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)), cy = baseY - (trend[i].count / maxV) * plotH;
            if (prev) doc.line(prev.x, prev.y, cx, cy); prev = { x: cx, y: cy };
          }
          doc.setFillColor(...col);
          for (let i = 0; i < n; i++) {
            const cx = plotX + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)), cy = baseY - (trend[i].count / maxV) * plotH;
            doc.circle(cx, cy, 0.8, "F");
            if (i % step === 0) doc.text(ascii(String(trend[i].date).slice(5)), cx, baseY + 4, { align: "center" });
          }
        } else {
          const slot = plotW / n, bw = Math.min(slot * 0.62, 9); doc.setFillColor(...col);
          for (let i = 0; i < n; i++) {
            const bh = (trend[i].count / maxV) * plotH, bx = plotX + slot * i + (slot - bw) / 2;
            doc.rect(bx, baseY - bh, bw, Math.max(bh, 0.4), "F");
            if (i % step === 0) doc.text(ascii(String(trend[i].date).slice(5)), bx + bw / 2, baseY + 4, { align: "center" });
          }
        }
        y += h + 6;
      };
      const darkTable = (head, body) => {
        if (!body.length || typeof autoTable !== "function") return;
        need(16);
        autoTable(doc, {
          startY: y, head: [head], body: body.map((r) => r.map(ascii)), theme: "grid", margin: { left: M, right: M },
          styles: { fillColor: G.surface, textColor: G.text2, lineColor: G.border, lineWidth: 0.1, fontSize: 8 },
          headStyles: { fillColor: G.surface2, textColor: G.text, fontStyle: "bold" },
          alternateRowStyles: { fillColor: G.bg },
        });
        y = (doc.lastAutoTable && doc.lastAutoTable.finalY != null ? doc.lastAutoTable.finalY : y + 8 + body.length * 7) + 6;
      };

      for (const key of tabsForRole.filter((k) => metricDefs[k])) {
        const dd = data[key] || {};
        heading(META[key]);
        kpiCards(metricDefs[key](dd));
        trendChart(dd.daily_trend, key === "delivery" ? "line" : "bar", key === "delivery" ? G.green : G.accent);
        if ((dd.by_delivery_man || []).length) darkTable(["Driver", "Deliveries", "On time"], dd.by_delivery_man.map((x) => [x.name, x.total, x.on_time]));
      }
      if (data._staff && data._staff.length) { heading("Staff productivity"); darkTable(["Name", "Role", "Done", "Items", "Reworks"], data._staff.map((s) => [s.name, ROLE_LABELS[s.role] || s.role, s.completions, s.items_done, s.reworks])); }
      if (data._pics && data._pics.length) { heading("Person in charge"); darkTable(["Name", "Role", "Open", "Overdue", "On hold", "Completed"], data._pics.map((p) => [p.name, ROLE_LABELS[p.role] || p.role, p.active, p.overdue, p.on_hold, p.completed])); }
      doc.save(`reports-${fileTag}.pdf`);
    } catch (e) {
      alert(`PDF export failed: ${e && e.message ? e.message : e}`);
    } finally { setBusy(""); }
  }
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, flexWrap: "wrap" }}>
          {tabsForRole.map((t) => <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? C.surface2 : "transparent", border: "none", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? C.text : C.text2, textTransform: "capitalize" }}>{TAB_LABEL[t] || t}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="soft" size="sm" onClick={exportPdf} disabled={!!busy}>{busy === "pdf" ? "Exporting…" : "PDF"}</Btn>
          <Btn variant="soft" size="sm" onClick={exportExcel} disabled={!!busy}>{busy === "xlsx" ? "Exporting…" : "Excel"}</Btn>
          <Btn variant="soft" size="sm" onClick={exportCsv} disabled={!!busy}>{busy === "csv" ? "Exporting…" : "CSV"}</Btn>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 3, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 9, padding: 3 }}>
          {["daily", "weekly", "monthly"].map((p) => {
            const on = !usingRange && period === p;
            return <button key={p} onClick={() => { setPeriod(p); setFrom(""); setTo(""); }} style={{ background: on ? C.surface2 : "transparent", border: "none", borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: on ? 700 : 500, color: on ? C.text : C.text2 }}>{PERIOD_LABEL[p]}</button>;
          })}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From" style={dateInp} />
          <span style={{ color: C.text3, fontSize: 13 }}>→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To" style={dateInp} />
          {usingRange && <button onClick={() => { setFrom(""); setTo(""); }} style={{ background: "transparent", border: "none", color: C.text3, cursor: "pointer", fontSize: 12.5 }}>clear</button>}
        </div>
        {(tabsForRole.includes("staff") || tabsForRole.includes("pic")) && (
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} title="Filter the Staff / Person-in-charge tables to one person" style={{ padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13 }}>
            <option value="" style={{ background: C.bg2 }}>All staff</option>
            {staffOpts.map((s) => <option key={s.id} value={s.id} style={{ background: C.bg2 }}>{s.name}</option>)}
          </select>
        )}
        <span style={{ fontSize: 12.5, color: C.text3, marginLeft: "auto" }}>{TAB_DESC[tab]} · {rangeLabel}</span>
      </div>
      {tab === "orders" && <OrdersReport period={period} from={from} to={to} />}
      {tab === "staff" && <StaffReport period={period} from={from} to={to} staffId={staffId} />}
      {tab === "pic" && <PicReport period={period} from={from} to={to} staffId={staffId} />}
      {tab === "efficiency" && <EfficiencyReport period={period} from={from} to={to} />}
      {tab === "mistakes" && <MistakesReport period={period} from={from} to={to} />}
      {tab === "scorecard" && <ScoreboardReport period={period} />}
      {tab === "trend" && <MoMReport />}
      {!CUSTOM.includes(tab) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14, marginBottom: 18 }}>
          {(metrics[tab] || []).map(([label, value]) => <MetricCard key={label} label={label} value={value} tone={metricTone(label)} />)}
        </div>
      )}
      {!CUSTOM.includes(tab) && trend.length > 0 && (
        <TrendChart data={trend} kind={tab === "delivery" ? "line" : "bar"} color={tab === "delivery" ? C.ready : C.accent} label={tab === "packing" ? "Packed" : tab === "delivery" ? "Delivered" : "Completed"} />
      )}
      {tab === "delivery" && (d.by_delivery_man || []).length > 0 && (
        <Card style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>By driver</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Driver", "Deliveries", "On-time"].map((h) => <th key={h} style={{ textAlign: "left", padding: "7px 8px", color: C.text3, borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.by_delivery_man.map((x) => (
                <tr key={x.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "7px 8px", color: C.text }}>{x.name}</td>
                  <td style={{ padding: "7px 8px", color: C.text2 }}>{x.total}</td>
                  <td style={{ padding: "7px 8px", color: C.ready }}>{x.on_time}{x.total ? ` (${Math.round((x.on_time / x.total) * 100)}%)` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ─── Messages (WhatsApp queue) ──────────────────────────────────────────────────
const MSG_KIND = { received: "Order received", ready: "Packed / ready", out_for_delivery: "Out for delivery", delivered: "Delivered", delayed: "Delay notice", morning_brief: "Morning brief", test: "Test" };
const MSG_STATUS = {
  queued: { label: "Queued", color: C.packing }, sending: { label: "Sending", color: C.order },
  sent: { label: "Sent", color: C.ready }, failed: { label: "Failed", color: C.danger }, cancelled: { label: "Cancelled", color: C.text3 },
};
function Messages({ user }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [redirectTo, setRedirectTo] = useState("");
  const narrow = useViewport() < 760;
  async function load() { try { setD(await api("GET", "/whatsapp/queue")); } catch (e) { setD({ _error: e.message }); } }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  async function act(label, path) {
    setBusy(label);
    try { await api("POST", path); await load(); } catch (e) { alert(e.message); } finally { setBusy(""); }
  }
  async function redirectAll() {
    if (!redirectTo.trim()) return;
    setBusy("redirect");
    try { await api("POST", "/whatsapp/redirect", { to: redirectTo.trim() }); await load(); } catch (e) { alert(e.message); } finally { setBusy(""); }
  }
  async function saveRecipient(id, to, old) {
    if (!to.trim() || to.trim() === old) return;
    try { await api("POST", "/whatsapp/redirect", { id, to: to.trim() }); await load(); } catch (e) { alert(e.message); }
  }
  if (!d) return <Loading label="Loading messages…" />;
  if (d._error) return <div style={{ color: "#fca5a5" }}>⚠ {d._error}</div>;
  const counts = Object.fromEntries((d.counts || []).map((c) => [c.status, c.c]));
  const queued = counts.queued || 0;
  const live = d.provider === "wwebjs";
  const fmtWhen = (s) => s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <div>
      <div style={{ background: "#2a1d0b", border: `1px solid ${C.accent}55`, borderRadius: 11, padding: "12px 14px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, color: C.accent, fontSize: 13, letterSpacing: 0.5 }}>🚧 DEMO / PREVIEW ONLY</span>
          <span style={{ color: C.text3, fontSize: 12.5 }}>Point the queued messages at your own number to watch them arrive on your phone. Don't send to real customers during a demo.</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.text2 }}>Send all queued to:</span>
          <input value={redirectTo} onChange={(e) => setRedirectTo(e.target.value)} placeholder="60123456789" style={{ padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13, fontFamily: MONO, width: 160 }} />
          <Btn variant="soft" size="sm" disabled={!!busy || queued === 0 || !redirectTo.trim()} onClick={redirectAll}>{busy === "redirect" ? "Applying…" : `Apply to ${queued} queued`}</Btn>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 9, background: (live ? C.ready : C.packing) + "1c", border: `1px solid ${(live ? C.ready : C.packing)}55`, color: live ? C.ready : C.packing, fontSize: 12.5, fontWeight: 700 }}>
          {live ? "● Live — sending to WhatsApp" : "● Test mode — messages logged, not sent"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="soft" size="sm" disabled={!!busy} onClick={() => act("enqueue", "/whatsapp/enqueue")}>{busy === "enqueue" ? "Queuing…" : "Queue customer messages"}</Btn>
          <Btn variant="soft" size="sm" disabled={!!busy} onClick={() => act("brief", "/whatsapp/morning-brief")}>{busy === "brief" ? "…" : "Morning brief"}</Btn>
          {queued > 0 && <Btn variant="danger" size="sm" disabled={!!busy} onClick={async () => { if (window.confirm(`Delete ${queued} queued message${queued === 1 ? "" : "s"}? They're removed from the list and not sent.`)) await act("cancel", "/whatsapp/cancel"); }}>{busy === "cancel" ? "Deleting…" : "Delete queued"}</Btn>}
          <Btn size="sm" disabled={!!busy || queued === 0} onClick={() => setConfirmSend(true)}>{busy === "drip" ? "Sending…" : `Send ${queued} queued →`}</Btn>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        {["queued", "sending", "sent", "failed"].map((k) => (
          <div key={k} style={{ flex: "1 1 120px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, padding: "12px 14px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: MSG_STATUS[k].color }}>{counts[k] || 0}</div>
            <div style={{ fontSize: 12, color: C.text3 }}>{MSG_STATUS[k].label}</div>
          </div>
        ))}
      </div>
      {(d.messages || []).length === 0 ? <Empty label="No messages yet. Tap “Queue customer messages”." /> :
        narrow ? (
          d.messages.map((m) => (
            <StackCard key={m.id}
              head={<>
                <span style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>{MSG_KIND[m.kind] || m.kind}</span>
                <Pill color={(MSG_STATUS[m.status] || {}).color || C.text3}>{(MSG_STATUS[m.status] || {}).label || m.status}</Pill>
              </>}
              rows={[
                ["To", m.status === "queued"
                  ? <input key={m.recipient} defaultValue={m.recipient} onBlur={(e) => saveRecipient(m.id, e.target.value, m.recipient)} style={{ padding: "5px 8px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, color: C.text, fontSize: 12.5, fontFamily: MONO, width: 150 }} />
                  : <span style={{ fontFamily: MONO }}>{m.recipient || "—"}</span>],
                ["When", fmtWhen(m.sent_at || m.created_at)],
                ["Message", <span style={{ color: C.text2 }}>{m.preview}</span>],
              ]} />
          ))
        ) : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Type", "Status", "To", "Message", "When"].map((h) => <th key={h} style={{ textAlign: "left", padding: "10px 14px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.messages.map((m) => (
                <tr key={m.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "9px 14px", color: C.text, whiteSpace: "nowrap" }}>{MSG_KIND[m.kind] || m.kind}</td>
                  <td style={{ padding: "9px 14px" }}><Pill color={(MSG_STATUS[m.status] || {}).color || C.text3}>{(MSG_STATUS[m.status] || {}).label || m.status}</Pill></td>
                  <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}>{m.status === "queued"
                    ? <input key={m.recipient} defaultValue={m.recipient} onBlur={(e) => saveRecipient(m.id, e.target.value, m.recipient)} title="Edit recipient (queued only)" style={{ padding: "5px 8px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, color: C.text, fontSize: 12.5, fontFamily: MONO, width: 130 }} />
                    : <span style={{ fontFamily: MONO, color: C.text2 }}>{m.recipient || "—"}</span>}</td>
                  <td style={{ padding: "9px 14px", color: C.text2, maxWidth: 440 }}>{m.preview}</td>
                  <td style={{ padding: "9px 14px", color: C.text3, whiteSpace: "nowrap" }}>{fmtWhen(m.sent_at || m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      <p style={{ fontSize: 12, color: C.text3, marginTop: 12 }}>Customer updates queue automatically as orders move. {live ? "Sending live via WhatsApp." : "Test mode: recorded here, not sent. Connect the WhatsApp worker to send for real."}</p>
      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} title="Send queued messages?" width={460}>
        {live ? (
          <div>
            <p style={{ color: C.text, fontSize: 14, lineHeight: 1.6 }}>This sends <b>{Math.min(queued, 5)}</b> of {queued} real WhatsApp message{queued === 1 ? "" : "s"} to customers now (capped at 5 per click). <b style={{ color: C.danger }}>Sent messages cannot be recalled.</b></p>
            <p style={{ color: C.text3, fontSize: 12.5 }}>Normally you don't need this — the worker sends queued messages slowly on its own.</p>
          </div>
        ) : (
          <p style={{ color: C.text2, fontSize: 14, lineHeight: 1.6 }}>This “sends” <b>{queued}</b> message{queued === 1 ? "" : "s"}. You're in <b>test mode</b>, so nothing goes to WhatsApp — they're only recorded here.</p>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
          <Btn variant="ghost" onClick={() => setConfirmSend(false)}>Cancel</Btn>
          <Btn variant={live ? "danger" : "primary"} disabled={!!busy} onClick={async () => { setConfirmSend(false); await act("drip", live ? "/whatsapp/drip?max=5" : "/whatsapp/drip?force=1&max=50"); }}>{live ? `Send ${Math.min(queued, 5)} now` : "Send (test)"}</Btn>
        </div>
      </Modal>
    </div>
  );
}

// ─── Delivery ──────────────────────────────────────────────────────────────────
function Delivery({ user, onOpenOrder }) {
  const [list, setList] = useState(null);
  const [ready, setReady] = useState([]);
  const [deliverers, setDeliverers] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [show, setShow] = useState(false);
  const [allCompleted, setAllCompleted] = useState(false);
  const [confirmDeliver, setConfirmDeliver] = useState(null);
  const [form, setForm] = useState({ order_id: "", deliverer_id: "", scheduled_date: "", address: "", notes: "" });
  const [newDeliverer, setNewDeliverer] = useState({ name: "", phone: "" });
  const [otherCourier, setOtherCourier] = useState("");
  const [editDelivery, setEditDelivery] = useState(null);
  const [editForm, setEditForm] = useState({ deliverer_id: "", scheduled_date: "", address: "", notes: "" });
  const [editOther, setEditOther] = useState("");
  const [showCouriers, setShowCouriers] = useState(true);
  const [q, setQ] = useState("");
  const canAssign = ["super_admin", "operations_controller", "delivery_team", "admin"].includes(user.role);
  const canDeliver = ["super_admin", "operations_controller", "delivery_team", "admin"].includes(user.role);
  const stacked = useViewport() < 1100; // phones + tablets (incl. iPad portrait) → cards, not a wide table

  async function load() {
    const d = await api("GET", "/delivery").catch(() => []);
    setList(d || []);
    const comp = await api("GET", "/orders?stage=delivered&limit=100").catch(() => ({ orders: [] }));
    setCompleted(comp.orders || []);
    setDeliverers(await api("GET", "/delivery/deliverers").catch(() => []));
    if (canAssign) {
      const o = await api("GET", "/orders?stage=ready_for_delivery&limit=100").catch(() => ({ orders: [] }));
      const taken = new Set((d || []).filter((x) => x.status !== "delivered" && x.status !== "failed").map((x) => x.order_id));
      setReady((o.orders || []).filter((x) => !taken.has(x.id)));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function assign() {
    if (!form.order_id) { alert("Pick an order to schedule."); return; }
    try {
      let payload = form;
      if (form.deliverer_id === "__other__") {
        if (!otherCourier.trim()) { alert("Type the new driver's name, or pick one from the list."); return; }
        const dl = await api("POST", "/delivery/deliverers", { name: otherCourier.trim() });
        payload = { ...form, deliverer_id: dl.id };
      }
      await api("POST", "/delivery", payload);
      setShow(false); setForm({ order_id: "", deliverer_id: "", scheduled_date: "", address: "", notes: "" }); setOtherCourier("");
      load();
    } catch (e) { alert(e.message); }
  }
  async function markDelivered(id) { try { await api("POST", `/delivery/${id}/deliver`, {}); setConfirmDeliver(null); load(); } catch (e) { alert(e.message); } }
  // One-tap deliver straight from Ready (no Schedule step), and its undo.
  async function markDeliveredDirect(orderId) { try { await api("POST", "/delivery/quick-deliver", { order_id: orderId }); load(); } catch (e) { alert(e.message); } }
  async function reopenDelivery(deliveryId) {
    if (!deliveryId) { alert("No delivery record to undo."); return; }
    if (!confirm("Reopen this order? It goes back to Ready for Delivery so you can re-deliver it.")) return;
    try { await api("POST", `/delivery/${deliveryId}/reopen`, {}); load(); } catch (e) { alert(e.message); }
  }
  async function addAddress(o) {
    const a = prompt(`Delivery address for ${o.invoice_number}:`, o.delivery_address || "");
    if (a == null) return;
    try { await api("PATCH", `/orders/${o.id}`, { delivery_address: a.trim() }); load(); } catch (e) { alert(e.message); }
  }
  // Proof of delivery: a photo of the signed doc / parcel, uploaded as a kind='pod'
  // attachment on the order (camera opens directly on a phone). Reconciled by admin.
  async function uploadProof(orderId, file) {
    if (!file) return;
    try { const fd = new FormData(); fd.append("file", file); fd.append("kind", "pod"); await api("POST", `/orders/${orderId}/attachments`, fd, true); load(); }
    catch (e) { alert(e.message); }
  }
  // Print the Delivery Order (driver's signable paper). Fetches the full order for
  // its line items; the batch version prints every scheduled note in one dialog.
  async function printOneDO(orderId) {
    const o = await api("GET", `/orders/${orderId}`).catch(() => null);
    const dv = (list || []).find((x) => x.order_id === orderId && x.status !== "delivered");
    if (o) printDeliveryOrders([{ order: o, delivery: dv }]);
  }
  async function printAllDOs() {
    const active = (list || []).filter((x) => x.status !== "delivered");
    const entries = [];
    for (const dv of active) { const o = await api("GET", `/orders/${dv.order_id}`).catch(() => null); if (o) entries.push({ order: o, delivery: dv }); }
    if (entries.length) printDeliveryOrders(entries); else alert("Nothing scheduled to print.");
  }
  function scheduleFor(orderId) { const o = ready.find((x) => x.id === orderId); setForm((f) => ({ ...f, order_id: orderId, address: (o && o.delivery_address) || "" })); setShow(true); }
  async function addDeliverer() {
    if (!newDeliverer.name.trim()) return;
    try { await api("POST", "/delivery/deliverers", newDeliverer); setNewDeliverer({ name: "", phone: "" }); load(); } catch (e) { alert(e.message); }
  }
  async function toggleDeliverer(dl) { try { await api("PATCH", `/delivery/deliverers/${dl.id}`, { is_active: !dl.is_active }); load(); } catch (e) { alert(e.message); } }
  function openEdit(dv) {
    setEditForm({ deliverer_id: dv.deliverer_id || "", scheduled_date: dv.scheduled_date || "", address: dv.address || "", notes: dv.notes || "" });
    setEditOther(""); setEditDelivery(dv);
  }
  async function saveEdit() {
    try {
      let payload = editForm;
      if (editForm.deliverer_id === "__other__") {
        if (!editOther.trim()) { alert("Type the new driver's name, or pick one from the list."); return; }
        const dl = await api("POST", "/delivery/deliverers", { name: editOther.trim() });
        payload = { ...editForm, deliverer_id: dl.id };
      }
      await api("PATCH", `/delivery/${editDelivery.id}`, payload);
      setEditDelivery(null); setEditOther(""); load();
    } catch (e) { alert(e.message); }
  }
  async function cancelDelivery() {
    if (!confirm("Cancel this delivery? The order goes back to Ready for Delivery so it can be re-scheduled.")) return;
    try { await api("PATCH", `/delivery/${editDelivery.id}`, { status: "failed" }); setEditDelivery(null); load(); }
    catch (e) { alert(e.message); }
  }

  if (!list) return <Loading />;
  // Ready-for-Delivery keeps the board's green; Pending is amber to stay visually
  // distinct from it. in_transit blue, delivered grey, failed red.
  const tone = { pending: C.packing, in_transit: C.order, delivered: C.text3, failed: C.danger };
  const statusLabel = { pending: "Pending", in_transit: "In transit", delivered: "Delivered", failed: "Failed" };
  const proofBtn = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 8, border: `1px solid ${C.border2}`, background: C.surface2, color: C.text2, cursor: "pointer", whiteSpace: "nowrap" };
  const active = list.filter((x) => x.status !== "delivered");
  const delByOrder = {};
  for (const dv of list) delByOrder[dv.order_id] = dv;
  // Filter every table by invoice # or customer name (mirrors the Order Board search).
  const qq = q.trim().toLowerCase();
  const match = (o) => !qq || (o.invoice_number || "").toLowerCase().includes(qq) || (o.customer_name || "").toLowerCase().includes(qq);
  const fReady = ready.filter(match);
  const fActive = active.filter(match);
  const fCompleted = completed.filter(match);
  const shownCompleted = allCompleted ? fCompleted : fCompleted.slice(0, 3);
  const matchCount = fReady.length + fActive.length + fCompleted.length;
  const noMatch = qq ? `No match for "${q.trim()}"` : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 300, maxWidth: "100%" }}>
          <span style={{ position: "absolute", left: 11, top: 9 }}><Icon name="search" size={15} color={C.text3} /></span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by invoice or customer…" style={{ width: "100%", padding: "8px 12px 8px 34px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5, outline: "none" }} />
        </div>
        {qq && <span style={{ fontSize: 12.5, color: C.text3 }}>{matchCount} {matchCount === 1 ? "match" : "matches"}</span>}
        {qq && <Btn variant="ghost" size="sm" onClick={() => setQ("")}>Clear</Btn>}
      </div>
      {canAssign && (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 12 }}>Ready for Delivery · {fReady.length}</h3>
          {stacked ? (
            fReady.length === 0 ? <Empty label={noMatch || "No orders waiting to be scheduled."} />
            : fReady.map((o) => (
              <StackCard key={o.id}
                head={<>
                  <button onClick={() => onOpenOrder && onOpenOrder(o.id)} style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.accent, cursor: "pointer" }}>{o.invoice_number}</button>
                  <Pill color={C.ready}>Ready</Pill>
                </>}
                rows={[
                  ["Customer", o.customer_name || "—"],
                  ["Where", o.delivery_address ? o.delivery_address : <button onClick={() => addAddress(o)} style={{ background: "none", border: 0, padding: 0, color: C.hold, cursor: "pointer", textDecoration: "underline", font: "inherit" }}>＋ Add address</button>],
                  ["Phone", o.customer_contact || "—"],
                  ["Due", <span style={{ color: countdown(o.required_delivery_date).tone }}>{fmtDay(o.required_delivery_date)}</span>],
                ]}
                actions={<>
                  {canDeliver && <Btn size="lg" variant="success" style={{ flex: 2, justifyContent: "center" }} onClick={() => markDeliveredDirect(o.id)}>✓ Delivered</Btn>}
                  <Btn size="lg" variant="soft" style={{ flex: 1, justifyContent: "center" }} onClick={() => scheduleFor(o.id)}>Schedule</Btn>
                  <Btn size="lg" variant="soft" style={{ flex: 1, justifyContent: "center" }} onClick={() => printOneDO(o.id)}>🖨 DO</Btn>
                </>}
              />
            ))
          ) : (
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Due", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
              <tbody>
                {fReady.length === 0 && <tr><td colSpan={5}><Empty label={noMatch || "No orders waiting to be scheduled."} /></td></tr>}
                {fReady.map((o) => (
                  <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(o.id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{o.invoice_number}</button></td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>
                      <div>{o.customer_name}</div>
                      <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>
                        {o.delivery_address ? `📍 ${o.delivery_address}` : <button onClick={() => addAddress(o)} style={{ background: "none", border: 0, padding: 0, color: C.hold, cursor: "pointer", textDecoration: "underline", font: "inherit" }}>📍 Add address</button>}
                        {o.customer_contact ? ` · 📞 ${o.customer_contact}` : ""}
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", color: countdown(o.required_delivery_date).tone }}>{fmtDay(o.required_delivery_date)}</td>
                    <td style={{ padding: "11px 16px" }}><Pill color={C.ready}>Ready for Delivery</Pill></td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {canDeliver && <Btn size="sm" variant="success" onClick={() => markDeliveredDirect(o.id)}>✓ Delivered</Btn>}
                        <Btn size="sm" variant="soft" onClick={() => scheduleFor(o.id)}>Schedule</Btn>
                        <Btn size="sm" variant="soft" onClick={() => printOneDO(o.id)}>🖨 DO</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          )}
        </div>
      )}

      {fActive.length > 0 && (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Scheduled · {fActive.length}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="soft" size="sm" onClick={() => printRouteList(fActive)}>Print route list</Btn>
            <Btn variant="soft" size="sm" onClick={printAllDOs}>🖨 Print delivery orders</Btn>
          </div>
        </div>
        {stacked ? (
          fActive.length === 0 ? <Empty label={noMatch || "Nothing pending. Schedule a Ready-for-Delivery order above."} />
          : fActive.map((dv) => (
            <StackCard key={dv.id}
              head={<>
                <button onClick={() => onOpenOrder && onOpenOrder(dv.order_id)} style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.accent, cursor: "pointer" }}>{dv.invoice_number}</button>
                <Pill color={tone[dv.status] || C.text3}>{statusLabel[dv.status] || dv.status}</Pill>
              </>}
              rows={[
                ["Customer", dv.customer_name || "—"],
                ["Driver", dv.delivery_man_name || "—"],
                ["Due", <span style={{ color: countdown(dv.required_delivery_date).tone }}>{fmtDay(dv.required_delivery_date)}</span>],
              ]}
              actions={<>
                {canAssign && <Btn variant="soft" style={{ flex: 1, justifyContent: "center" }} onClick={() => openEdit(dv)}>Edit</Btn>}
                {canDeliver && <Btn variant="success" style={{ flex: 2, justifyContent: "center" }} onClick={() => setConfirmDeliver(dv)}>Mark delivered</Btn>}
                <Btn variant="soft" style={{ flex: 1, justifyContent: "center" }} onClick={() => printOneDO(dv.order_id)}>🖨 DO</Btn>
              </>}
            />
          ))
        ) : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Driver", "Scheduled", "Due", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {fActive.length === 0 && <tr><td colSpan={7}><Empty label={noMatch || "Nothing pending. Schedule a Ready-for-Delivery order above."} /></td></tr>}
              {fActive.map((dv) => (
                <tr key={dv.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(dv.order_id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{dv.invoice_number}</button></td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.customer_name}</td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.delivery_man_name || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.scheduled_date ? fmtDay(dv.scheduled_date) : "—"}</td>
                  <td style={{ padding: "11px 16px", color: countdown(dv.required_delivery_date).tone }}>{fmtDay(dv.required_delivery_date)}</td>
                  <td style={{ padding: "11px 16px" }}><Pill color={tone[dv.status] || C.text3}>{statusLabel[dv.status] || dv.status}</Pill></td>
                  <td style={{ padding: "11px 16px" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {canAssign && <Btn size="sm" variant="soft" onClick={() => openEdit(dv)}>Edit</Btn>}
                      {canDeliver && <Btn size="sm" variant="success" onClick={() => setConfirmDeliver(dv)}>Mark delivered</Btn>}
                      <Btn size="sm" variant="soft" onClick={() => printOneDO(dv.order_id)}>🖨 DO</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      </div>
      )}

      <div>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 12 }}>Completed orders · {fCompleted.length}</h3>
        {stacked ? (
          fCompleted.length === 0 ? <Empty label={noMatch || "No completed orders yet."} />
          : shownCompleted.map((o) => {
            const dv = delByOrder[o.id];
            return (
              <StackCard key={o.id}
                head={<>
                  <button onClick={() => onOpenOrder && onOpenOrder(o.id)} style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.accent, cursor: "pointer" }}>{o.invoice_number}</button>
                  <Pill color={C.ready}>Delivered</Pill>
                </>}
                rows={[
                  ["Customer", o.customer_name || "—"],
                  ["Delivered", dv && dv.delivered_at ? fmtDateTime(dv.delivered_at) : "Delivered"],
                  ["Proof", dv && dv.has_pod ? <span style={{ color: C.ready }}>✓ Attached</span> : <span style={{ color: C.hold }}>⚠ None yet</span>],
                ]}
                actions={<div style={{ display: "flex", gap: 8, width: "100%" }}>
                  {canDeliver && <label style={{ ...proofBtn, flex: 1, justifyContent: "center" }}>📎 Proof<input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadProof(o.id, f); }} /></label>}
                  {canDeliver && dv && <Btn variant="soft" style={{ flex: 1, justifyContent: "center" }} onClick={() => reopenDelivery(dv.id)}>↩ Undo</Btn>}
                </div>}
              />
            );
          })
        ) : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Driver", "Delivered", "Due", ""].map((h, i) => <th key={i} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {fCompleted.length === 0 && <tr><td colSpan={5}><Empty label={noMatch || "No completed orders yet."} /></td></tr>}
              {shownCompleted.map((o) => {
                const dv = delByOrder[o.id];
                return (
                  <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(o.id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{o.invoice_number}</button></td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>{o.customer_name}</td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>{dv && dv.delivery_man_name ? dv.delivery_man_name : "—"}</td>
                    <td style={{ padding: "11px 16px", color: C.ready }}>
                      <div>{dv && dv.delivered_at ? fmtDateTime(dv.delivered_at) : "Delivered"}</div>
                      <div style={{ marginTop: 3 }}>{dv && dv.has_pod ? <Pill color={C.ready} style={{ fontSize: 10 }}>✓ Proof</Pill> : <Pill color={C.hold} style={{ fontSize: 10 }}>⚠ No proof</Pill>}</div>
                    </td>
                    <td style={{ padding: "11px 16px", color: C.text3 }}>{fmtDay(o.required_delivery_date)}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        {canDeliver && <label style={proofBtn}>📎 Proof<input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadProof(o.id, f); }} /></label>}
                        {canDeliver && dv && <Btn size="sm" variant="soft" onClick={() => reopenDelivery(dv.id)}>↩ Undo</Btn>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        )}
        {fCompleted.length > 3 && <div style={{ marginTop: 10 }}><Btn variant="ghost" size="sm" onClick={() => setAllCompleted((v) => !v)}>{allCompleted ? "Show less ▲" : `Show all ${fCompleted.length} ▼`}</Btn></div>}
      </div>

      {canAssign && (
        <div>
          <button onClick={() => setShowCouriers((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Drivers · {deliverers.length}</h3>
            <span style={{ color: C.text3, fontSize: 13 }}>{showCouriers ? "▲" : "▼"}</span>
          </button>
          {!showCouriers && <div style={{ fontSize: 12.5, color: C.text3, marginTop: 4 }}>Your in-house delivery team. Add a driver here, or just type one when scheduling — it's saved automatically.</div>}
          {showCouriers && (
            <>
              <Card style={{ padding: 0, overflowX: "auto", marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                  <thead><tr style={{ background: C.bg2 }}>{["Name", "Phone", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {deliverers.length === 0 && <tr><td colSpan={4}><Empty label="No drivers yet. Add your in-house drivers below." /></td></tr>}
                    {deliverers.map((dl) => (
                      <tr key={dl.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: "11px 16px", color: C.text }}>{dl.name}</td>
                        <td style={{ padding: "11px 16px", color: C.text2 }}>{dl.phone || "—"}</td>
                        <td style={{ padding: "11px 16px" }}><Pill color={dl.is_active ? C.ready : C.danger}>{dl.is_active ? "Active" : "Disabled"}</Pill></td>
                        <td style={{ padding: "11px 16px" }}><Btn size="sm" variant="ghost" onClick={() => toggleDeliverer(dl)}>{dl.is_active ? "Disable" : "Enable"}</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input placeholder="Driver name (e.g. Ahmad, Faiz)" value={newDeliverer.name} onChange={(e) => setNewDeliverer((p) => ({ ...p, name: e.target.value }))} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5 }} />
                <input placeholder="Phone (optional)" value={newDeliverer.phone} onChange={(e) => setNewDeliverer((p) => ({ ...p, phone: e.target.value }))} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5 }} />
                <Btn size="sm" onClick={addDeliverer} disabled={!newDeliverer.name.trim()}><Icon name="plus" size={14} /> Add driver</Btn>
              </div>
            </>
          )}
        </div>
      )}

      <Modal open={show} onClose={() => setShow(false)} title="Schedule delivery">
        <Field label="Order (ready for delivery)" value={form.order_id} onChange={(v) => setForm((f) => ({ ...f, order_id: v }))}
          options={[{ value: "", label: "Select order…" }, ...ready.map((o) => ({ value: o.id, label: `${o.invoice_number} — ${o.customer_name}` }))]} />
        <Field label="Driver" value={form.deliverer_id} onChange={(v) => setForm((f) => ({ ...f, deliverer_id: v }))}
          options={[{ value: "", label: deliverers.filter((d) => d.is_active).length ? "Unassigned" : "No drivers yet — add one below" }, ...deliverers.filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name })), { value: "__other__", label: "+ Add a new driver" }]} />
        {form.deliverer_id === "__other__" && (
          <Field label="New driver name" value={otherCourier} onChange={setOtherCourier} placeholder="e.g. Ahmad" required />
        )}
        <Field label="Scheduled date" type="date" value={form.scheduled_date} onChange={(v) => setForm((f) => ({ ...f, scheduled_date: v }))} />
        <Field label="Delivery address" value={form.address} onChange={(v) => setForm((f) => ({ ...f, address: v }))} placeholder="Street, city, postcode…" />
        <Field label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} placeholder="Optional…" />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="ghost" onClick={() => setShow(false)}>Cancel</Btn>
          <Btn onClick={assign}>Schedule</Btn>
        </div>
      </Modal>

      <Modal open={!!confirmDeliver} onClose={() => setConfirmDeliver(null)} title="Confirm delivery" width={440}>
        {confirmDeliver && (
          <>
            <div style={{ fontSize: 14, marginBottom: 8 }}><span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{confirmDeliver.invoice_number}</span> <span style={{ color: C.text2 }}>· {confirmDeliver.customer_name}</span></div>
            <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.8, marginBottom: 12 }}>
              {confirmDeliver.address && <div><span style={{ color: C.text3 }}>Address: </span>{confirmDeliver.address}</div>}
              <div><span style={{ color: C.text3 }}>Driver: </span>{confirmDeliver.delivery_man_name || "Unassigned"}</div>
              <div><span style={{ color: C.text3 }}>Scheduled: </span>{confirmDeliver.scheduled_date ? fmtDay(confirmDeliver.scheduled_date) : "—"}</div>
            </div>
            <div style={{ fontSize: 12.5, color: C.text3, marginBottom: 16 }}>This marks the order delivered. You can undo it from Completed if you mark it by mistake.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="ghost" onClick={() => setConfirmDeliver(null)}>Cancel</Btn>
              <Btn variant="success" onClick={() => markDelivered(confirmDeliver.id)}><Icon name="check" size={15} /> Confirm delivered</Btn>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!editDelivery} onClose={() => setEditDelivery(null)} title="Update delivery">
        {editDelivery && (
          <>
            <div style={{ fontSize: 14, marginBottom: 12 }}><span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{editDelivery.invoice_number}</span> <span style={{ color: C.text2 }}>· {editDelivery.customer_name}</span></div>
            <Field label="Driver" value={editForm.deliverer_id} onChange={(v) => setEditForm((f) => ({ ...f, deliverer_id: v }))}
              options={[{ value: "", label: "Unassigned" }, ...deliverers.filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name })), { value: "__other__", label: "+ Add a new driver" }]} />
            {editForm.deliverer_id === "__other__" && (
              <Field label="New driver name" value={editOther} onChange={setEditOther} placeholder="e.g. Ahmad" required />
            )}
            <Field label="Scheduled date" type="date" value={editForm.scheduled_date} onChange={(v) => setEditForm((f) => ({ ...f, scheduled_date: v }))} />
            <Field label="Delivery address" value={editForm.address} onChange={(v) => setEditForm((f) => ({ ...f, address: v }))} placeholder="Street, city, postcode…" />
            <Field label="Notes" value={editForm.notes} onChange={(v) => setEditForm((f) => ({ ...f, notes: v }))} placeholder="Optional…" />
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", marginTop: 8, flexWrap: "wrap" }}>
              <Btn variant="danger" onClick={cancelDelivery}>Cancel this delivery</Btn>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="ghost" onClick={() => setEditDelivery(null)}>Close</Btn>
                <Btn onClick={saveEdit}>Save changes</Btn>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// ─── Production remarks ──────────────────────────────────────────────────────
function isoWeekLabel(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return "";
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `W${week} ${t.getUTCFullYear()}`;
}
function fmtDateTime(s) {
  const d = s ? new Date(s) : null;
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
// Short "how long ago" for the what-changed banner — keeps it plain for non-technical staff.
function relTime(s) {
  const d = s ? new Date(s) : null;
  if (!d || isNaN(d)) return "";
  const m = Math.floor((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function Remarks({ user }) {
  const [list, setList] = useState(null);
  const [cur, setCur] = useState(undefined); // current-week remark, or null
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [allArchive, setAllArchive] = useState(false);
  const canPost = ["super_admin", "production_lead"].includes(user.role);

  async function load() {
    const all = await api("GET", "/remarks").catch(() => []);
    setList(all || []);
    const c = await api("GET", "/remarks/current").catch(() => null);
    setCur(c || null);
    setContent(c ? c.content : "");
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function save() {
    if (!content.trim()) return;
    setBusy(true); setSaved(false);
    try {
      if (cur) await api("PATCH", `/remarks/${cur.id}`, { content });
      else await api("POST", "/remarks", { content });
      setSaved(true);
      await load();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  if (list === null || cur === undefined) return <Loading />;
  const archive = list.filter((r) => !cur || r.id !== cur.id);
  const shownArchive = allArchive ? archive : archive.slice(0, 3);
  const weekLabel = isoWeekLabel(cur ? cur.week_start : new Date().toISOString().slice(0, 10));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 920 }}>
      <Card style={{ padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="message" size={20} color={C.accent} />
            <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>This week — {weekLabel}</span>
          </div>
          <span style={{ fontSize: 13, color: C.text3 }}>Visible to Admin &amp; Production Head</span>
        </div>
        {canPost ? (
          <>
            <textarea value={content} onChange={(e) => { setContent(e.target.value); setSaved(false); }} rows={4}
              placeholder="Production notes for this week…"
              style={{ width: "100%", padding: "12px 14px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 10, color: C.text, fontSize: 14, resize: "vertical", lineHeight: 1.5 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
              <Btn onClick={save} disabled={busy || !content.trim()}><Icon name="check" size={15} /> {busy ? "Saving…" : "Save remark"}</Btn>
              {saved && <span style={{ color: C.ready, fontSize: 13 }}>Saved ✓</span>}
              {cur && <span style={{ color: C.text3, fontSize: 12.5 }}>Last updated {fmtDateTime(cur.updated_at || cur.created_at)} · {cur.author_name}</span>}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 14, color: C.text2, whiteSpace: "pre-wrap" }}>{cur ? cur.content : <span style={{ color: C.text3 }}>No remark yet this week.</span>}</div>
        )}
      </Card>

      <Card style={{ padding: "20px 22px" }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 16 }}>Archive</h3>
        {archive.length === 0 && <Empty label="No archived remarks yet." />}
        {shownArchive.map((r) => (
          <div key={r.id} style={{ paddingBottom: 16, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
              <Pill color={C.accent} style={{ fontSize: 12, padding: "3px 11px" }}>{isoWeekLabel(r.week_start)}</Pill>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.text3 }}>{fmtDateTime(r.created_at)} · {r.author_name}</span>
            </div>
            <div style={{ fontSize: 14, color: C.text2, whiteSpace: "pre-wrap" }}>{r.content}</div>
          </div>
        ))}
        {archive.length > 3 && <Btn variant="ghost" size="sm" onClick={() => setAllArchive((v) => !v)}>{allArchive ? "Show less ▲" : `Show all ${archive.length} ▼`}</Btn>}
      </Card>
    </div>
  );
}

// ─── Audit ─────────────────────────────────────────────────────────────────────
function Audit() {
  const [d, setD] = useState(null);
  const [allLogs, setAllLogs] = useState(false);
  const [period, setPeriod] = useState("all"); // all | weekly | monthly | custom
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [userF, setUserF] = useState("");
  const [actionF, setActionF] = useState("");

  const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  useEffect(() => {
    let f = "", t = "";
    if (period === "weekly") { const x = new Date(); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); f = ymd(x); }
    else if (period === "monthly") { const x = new Date(); f = ymd(new Date(x.getFullYear(), x.getMonth(), 1)); }
    else if (period === "custom") { f = from; t = to; }
    const p = new URLSearchParams({ limit: "200" });
    if (f) p.set("from", f);
    if (t) p.set("to", `${t} 23:59:59`);
    setD(null); setAllLogs(false);
    api("GET", `/reports/audit?${p.toString()}`).then(setD).catch(() => setD({ logs: [] }));
  }, [period, from, to]);

  const allLogsData = d && d.logs ? d.logs : [];
  const userOpts = [...new Set(allLogsData.map((l) => l.user_name).filter(Boolean))].sort();
  const actionOpts = [...new Set(allLogsData.map((l) => l.action).filter(Boolean))].sort();
  const logs = allLogsData.filter((l) => (!userF || l.user_name === userF) && (!actionF || l.action === actionF));
  const shownLogs = allLogs ? logs : logs.slice(0, 3);
  const total = (userF || actionF) ? logs.length : (d && d.total != null ? d.total : logs.length);
  async function exportCsv() {
    // Pull the full matching range (not just the 200 shown) so the export is a complete record.
    let f = "", t = "";
    if (period === "weekly") { const x = new Date(); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); f = ymd(x); }
    else if (period === "monthly") { const x = new Date(); f = ymd(new Date(x.getFullYear(), x.getMonth(), 1)); }
    else if (period === "custom") { f = from; t = to; }
    const p = new URLSearchParams({ limit: "100000" });
    if (f) p.set("from", f);
    if (t) p.set("to", `${t} 23:59:59`);
    let full = logs;
    try { const r = await api("GET", `/reports/audit?${p.toString()}`); if (r && r.logs) full = r.logs; } catch (e) { /* fall back to the loaded rows */ }
    full = full.filter((l) => (!userF || l.user_name === userF) && (!actionF || l.action === actionF));
    const rows = [["When", "User", "Action", "Details", "Invoice"]];
    for (const l of full) rows.push([new Date(l.created_at).toLocaleString(), l.user_name, l.action, l.details, l.invoice_number || ""]);
    downloadCsv(`audit-${period}.csv`, rows);
  }
  const tabBtn = (id, label) => (
    <button key={id} onClick={() => setPeriod(id)} style={{ background: period === id ? C.surface2 : "transparent", border: "none", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 13, fontWeight: period === id ? 700 : 500, color: period === id ? C.text : C.text2 }}>{label}</button>
  );
  const dateInp = { padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13, colorScheme: "dark" };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
          {tabBtn("all", "All")}{tabBtn("weekly", "This week")}{tabBtn("monthly", "This month")}{tabBtn("custom", "Custom")}
        </div>
        <select value={userF} onChange={(e) => setUserF(e.target.value)} title="Filter by user" style={{ padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13 }}>
          <option value="" style={{ background: C.bg2 }}>All users</option>
          {userOpts.map((u) => <option key={u} value={u} style={{ background: C.bg2 }}>{u}</option>)}
        </select>
        <select value={actionF} onChange={(e) => setActionF(e.target.value)} title="Filter by action" style={{ padding: "7px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.text, fontSize: 13 }}>
          <option value="" style={{ background: C.bg2 }}>All actions</option>
          {actionOpts.map((a) => <option key={a} value={a} style={{ background: C.bg2 }}>{a}</option>)}
        </select>
        {period === "custom" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInp} />
            <span style={{ color: C.text3, fontSize: 13 }}>→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInp} />
          </div>
        )}
        {d && <span style={{ fontSize: 12.5, color: C.text3, marginLeft: "auto" }}>{total} {total === 1 ? "entry" : "entries"}</span>}
        {d && logs.length > 0 && <Btn variant="soft" size="sm" onClick={exportCsv} style={{ marginLeft: 4 }}>Export CSV</Btn>}
      </div>
      {!d ? <Loading /> : (
        <>
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: C.bg2 }}>{["When", "User", "Action", "Details", "Invoice"].map((h) => <th key={h} style={{ textAlign: "left", padding: "11px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
              <tbody>
                {logs.length === 0 && <tr><td colSpan={5}><Empty label="No audit entries for this range." /></td></tr>}
                {shownLogs.map((l) => (
                  <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "9px 16px", color: C.text3, whiteSpace: "nowrap" }}>{new Date(l.created_at).toLocaleString()}</td>
                    <td style={{ padding: "9px 16px", color: C.text }}>{l.user_name}</td>
                    <td style={{ padding: "9px 16px" }}><Pill color={C.text2}>{l.action}</Pill></td>
                    <td style={{ padding: "9px 16px", color: C.text2 }}>{l.details}</td>
                    <td style={{ padding: "9px 16px", fontFamily: MONO, color: C.text2 }}>{l.invoice_number || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {logs.length > 3 && <div style={{ marginTop: 12 }}><Btn variant="ghost" size="sm" onClick={() => setAllLogs((v) => !v)}>{allLogs ? "Show less ▲" : `Show all ${logs.length}${total > logs.length ? ` of ${total}` : ""} ▼`}</Btn></div>}
        </>
      )}
    </div>
  );
}

// ─── Users ───────────────────────────────────────────────────────────────────
function Users({ user }) {
  const [list, setList] = useState(null);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: "", email: "", role: "production_staff", password: "" });
  const [resetFor, setResetFor] = useState(null);
  const [newPw, setNewPw] = useState("");
  const [q, setQ] = useState("");
  const [roleF, setRoleF] = useState("");
  const [showDisabled, setShowDisabled] = useState(false); // disabled staff collapsed by default
  const isAdmin = user.role === "super_admin";
  function load() { api("GET", "/users").then(setList).catch(() => setList([])); }
  useEffect(() => { load(); }, []);
  async function create() { try { await api("POST", "/users", f); setShow(false); setF({ name: "", email: "", role: "production_staff", password: "" }); load(); } catch (e) { alert(e.message); } }
  async function toggle(u) { try { await api("PATCH", `/users/${u.id}`, { is_active: !u.is_active }); load(); } catch (e) { alert(e.message); } }
  async function resetPw() {
    if (newPw.length < 8) { alert("New password must be at least 8 characters."); return; }
    try { await api("PATCH", `/users/${resetFor.id}`, { password: newPw }); setResetFor(null); setNewPw(""); alert("Password reset."); } catch (e) { alert(e.message); }
  }
  async function delUser(u) {
    if (!confirm(`Permanently delete ${u.name}? This cannot be undone.`)) return;
    try { await api("DELETE", `/users/${u.id}`); load(); } catch (e) { alert(e.message); }
  }
  // Ops can manage everyone except Super Admins; only a Super Admin manages Super Admins.
  const canManage = (u) => isAdmin || u.role !== "super_admin";
  const roleOptions = Object.entries(ROLE_LABELS).filter(([v]) => isAdmin || v !== "super_admin").map(([value, label]) => ({ value, label }));
  if (!list) return <Loading />;
  const ql = q.trim().toLowerCase();
  const filtered = list.filter((u) =>
    (!ql || u.name.toLowerCase().includes(ql) || (u.email || "").toLowerCase().includes(ql)) &&
    (!roleF || u.role === roleF)
  );
  // Neat order: by role seniority, then name. Active up top; disabled collapsed below.
  const roleRank = { super_admin: 0, admin: 1, operations_controller: 2, production_lead: 3, production_staff: 4, packing_staff: 5, delivery_team: 6 };
  const byRank = (a, b) => ((roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9)) || a.name.localeCompare(b.name);
  const activeUsers = filtered.filter((u) => u.is_active).sort(byRank);
  const disabledUsers = filtered.filter((u) => !u.is_active).sort(byRank);
  const showActive = true;
  const showInactive = showDisabled;
  const visibleCount = (showActive ? activeUsers.length : 0) + (showInactive ? disabledUsers.length : 0);
  const ctrl = { padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13 };
  const renderRow = (u) => (
    <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}`, opacity: u.is_active ? 1 : 0.6 }}>
      <td style={{ padding: "11px 16px" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar name={u.name} color={u.avatar_color} size={30} /><span style={{ color: C.text, fontWeight: 500 }}>{u.name}</span></div></td>
      <td style={{ padding: "11px 16px", color: C.text2 }}>{u.email}</td>
      <td style={{ padding: "11px 16px" }}><Pill color={C.text2}>{ROLE_LABELS[u.role] || u.role}</Pill></td>
      <td style={{ padding: "11px 16px" }}><Pill color={u.is_active ? C.ready : C.danger}>{u.is_active ? "Active" : "Disabled"}</Pill></td>
      <td style={{ padding: "11px 16px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {canManage(u) && <Btn size="sm" variant="ghost" onClick={() => { setResetFor(u); setNewPw(""); }}>Reset PW</Btn>}
          {u.id !== user.id && canManage(u) && <Btn size="sm" variant="ghost" onClick={() => toggle(u)}>{u.is_active ? "Disable" : "Enable"}</Btn>}
          {u.id !== user.id && canManage(u) && !u.is_active && <Btn size="sm" variant="danger" onClick={() => delUser(u)}>Delete</Btn>}
        </div>
      </td>
    </tr>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 320 }}>
          <span style={{ position: "absolute", left: 11, top: 9 }}><Icon name="search" size={15} color={C.text3} /></span>
          <input type="search" name="user-search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" style={{ ...ctrl, width: "100%", padding: "8px 12px 8px 34px", fontSize: 13.5, outline: "none", boxSizing: "border-box" }} />
        </div>
        <select value={roleF} onChange={(e) => setRoleF(e.target.value)} style={ctrl}>
          <option value="" style={{ background: C.bg2 }}>All roles</option>
          {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v} style={{ background: C.bg2 }}>{l}</option>)}
        </select>
        <span style={{ fontSize: 12.5, color: C.text3 }}>{filtered.length} of {list.length}</span>
        <Btn onClick={() => setShow(true)} style={{ marginLeft: "auto" }}><Icon name="plus" size={15} /> Add user</Btn>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead><tr style={{ background: C.bg2 }}>{["User", "Email", "Role", "Status", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {visibleCount === 0 && <tr><td colSpan={5}><Empty label="No users match these filters." /></td></tr>}
            {showActive && activeUsers.map(renderRow)}
            {showInactive && disabledUsers.length > 0 && (
              <tr><td colSpan={5} style={{ padding: "8px 16px", background: C.bg2, color: C.text3, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5 }}>FORMER / DISABLED STAFF ({disabledUsers.length})</td></tr>
            )}
            {showInactive && disabledUsers.map(renderRow)}
          </tbody>
        </table>
      </Card>
      {disabledUsers.length > 0 && (
        <button onClick={() => setShowDisabled((s) => !s)} style={{ marginTop: 10, background: "none", border: `1px solid ${C.border2}`, color: C.text2, borderRadius: 8, padding: "7px 13px", cursor: "pointer", fontSize: 12.5 }}>
          {showDisabled ? `Hide disabled staff` : `Show ${disabledUsers.length} disabled / former staff`}
        </button>
      )}
      <Modal open={show} onClose={() => setShow(false)} title="Create user">
        <Field label="Full name" value={f.name} onChange={(v) => setF((p) => ({ ...p, name: v }))} required />
        <Field label="Email" type="email" value={f.email} onChange={(v) => setF((p) => ({ ...p, email: v }))} required />
        <Field label="Role" value={f.role} onChange={(v) => setF((p) => ({ ...p, role: v }))} options={roleOptions} />
        <Field label="Temporary password" type="password" name="new-password" autoComplete="new-password" value={f.password} onChange={(v) => setF((p) => ({ ...p, password: v }))} required />
        <p style={{ fontSize: 12, color: C.text3, margin: "-4px 0 10px" }}>The new staff member can change this after their first login.</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}><Btn variant="ghost" onClick={() => setShow(false)}>Cancel</Btn><Btn onClick={create}>Create</Btn></div>
      </Modal>
      <Modal open={!!resetFor} onClose={() => setResetFor(null)} title={resetFor ? `Reset password — ${resetFor.name}` : "Reset password"} width={420}>
        <Field label="New password (min 8 chars)" type="password" name="new-password" autoComplete="new-password" value={newPw} onChange={setNewPw} required />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}><Btn variant="ghost" onClick={() => setResetFor(null)}>Cancel</Btn><Btn onClick={resetPw}>Set password</Btn></div>
      </Modal>
    </div>
  );
}

// ─── Settings ──────────────────────────────────────────────────────────────────
function Settings() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [holidays, setHolidays] = useState([]);
  const [newHol, setNewHol] = useState({ date: "", name: "" });
  const [weights, setWeights] = useState(null);
  const [wBusy, setWBusy] = useState(false);
  const [wSaved, setWSaved] = useState(false);

  useEffect(() => { api("GET", "/settings").then(setS).catch(() => setS({})); }, []);
  // Reward-scoreboard weights live in system_settings as a JSON string.
  useEffect(() => {
    if (!s) return;
    let w = { ontime: 30, output: 30, quality: 25, speed: 15 };
    try { if (s.scorecard_weights) w = { ...w, ...JSON.parse(s.scorecard_weights) }; } catch { /* keep defaults */ }
    setWeights(w);
  }, [s]);
  async function saveWeights() {
    setWBusy(true);
    try { await api("PUT", "/settings", { settings: { scorecard_weights: JSON.stringify(weights) } }); setWSaved(true); }
    catch (e) { alert(e.message); } finally { setWBusy(false); }
  }
  function loadHolidays() { api("GET", "/settings/holidays").then((d) => setHolidays(d || [])).catch(() => setHolidays([])); }
  useEffect(() => { loadHolidays(); }, []);
  function setField(k, v) { setS((p) => ({ ...p, [k]: v })); setSaved(false); }
  async function save() {
    setBusy(true);
    try { await api("PUT", "/settings", { settings: { session_timeout_hours: s.session_timeout_hours } }); setSaved(true); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function addHoliday() {
    if (!newHol.date || !newHol.name.trim()) return;
    try { await api("POST", "/settings/holidays", { date: newHol.date, name: newHol.name.trim() }); setNewHol({ date: "", name: "" }); loadHolidays(); }
    catch (e) { alert(e.message); }
  }
  async function removeHoliday(id) {
    if (!confirm("Remove this holiday?")) return;
    try { await api("DELETE", `/settings/holidays/${id}`); loadHolidays(); } catch (e) { alert(e.message); }
  }

  if (!s) return <Loading />;
  const inp = { padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5, colorScheme: "dark" };
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>Session</h3>
        <p style={{ fontSize: 12.5, color: C.text3, marginBottom: 14 }}>How long a sign-in stays valid before users must log in again. Applies to new logins.</p>
        <div style={{ maxWidth: 220 }}>
          <Field label="Session timeout (hours)" type="number" min="1" value={s.session_timeout_hours ?? ""} onChange={(v) => setField("session_timeout_hours", v)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <Btn onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</Btn>
          {saved && <span style={{ color: C.ready, fontSize: 13 }}>Saved ✓</span>}
        </div>
      </Card>

      {REWARD_SYSTEM_ENABLED && (
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>Reward scoreboard weights</h3>
        <p style={{ fontSize: 12.5, color: C.text3, marginBottom: 14 }}>How the monthly reward score is blended for the Scoreboard report and the Floor Display. Drag to set what matters most — the shares re-balance to 100% automatically.</p>
        {weights && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14 }}>
              {[["ontime", "On-time"], ["output", "Output"], ["quality", "Quality"], ["speed", "Speed"]].map(([k, lbl]) => {
                const sum = (weights.ontime + weights.output + weights.quality + weights.speed) || 1;
                return (
                  <div key={k}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.text2, marginBottom: 6 }}>
                      <span>{lbl}</span><span style={{ fontFamily: MONO, color: C.text }}>{Math.round(weights[k] / sum * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="60" value={weights[k]} onChange={(e) => { const v = +e.target.value; setWeights((p) => ({ ...p, [k]: v })); setWSaved(false); }} style={{ width: "100%", accentColor: C.accent }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
              <Btn onClick={saveWeights} disabled={wBusy}>{wBusy ? "Saving…" : "Save weights"}</Btn>
              {wSaved && <span style={{ color: C.ready, fontSize: 13 }}>Saved ✓</span>}
            </div>
          </>
        )}
      </Card>
      )}

      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>Holiday calendar</h3>
        <p style={{ fontSize: 12.5, color: C.text3, marginBottom: 14 }}>Public holidays and factory off-days. When an order's delivery date lands on one, whoever creates the order is warned.</p>
        {holidays.length === 0 && <Empty label="No holidays added yet." />}
        {holidays.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {holidays.map((h) => {
              const d = parseDate(h.date);
              const past = d && d < today0;
              return (
                <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.border}`, opacity: past ? 0.5 : 1 }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: C.text2, minWidth: 104 }}>{h.date}</span>
                  <span style={{ flex: 1, fontSize: 13.5, color: C.text }}>{h.name}</span>
                  {past && <span style={{ fontSize: 11, color: C.text3 }}>past</span>}
                  <button onClick={() => removeHoliday(h.id)} title="Remove" style={{ background: "#3a1a1a", border: "none", borderRadius: 7, color: "#fca5a5", cursor: "pointer", width: 28, height: 28, flexShrink: 0 }}>×</button>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" value={newHol.date} onChange={(e) => setNewHol((p) => ({ ...p, date: e.target.value }))} style={inp} />
          <input placeholder="Holiday name (e.g. Hari Raya)" value={newHol.name} onChange={(e) => setNewHol((p) => ({ ...p, name: e.target.value }))} style={{ ...inp, flex: 1, minWidth: 160 }} />
          <Btn size="sm" onClick={addHoliday} disabled={!newHol.date || !newHol.name.trim()}><Icon name="plus" size={14} /> Add</Btn>
        </div>
      </Card>
    </div>
  );
}

// ─── Notifications ─────────────────────────────────────────────────────────────
function NotificationsPanel({ onClose, onChanged }) {
  const [items, setItems] = useState([]);
  useEffect(() => { api("GET", "/notifications").then((d) => setItems(d.notifications || [])).catch(() => setItems([])); }, []);
  async function markAll() { await api("PATCH", "/notifications/read-all").catch(() => {}); setItems((a) => a.map((i) => ({ ...i, is_read: true }))); onChanged && onChanged(); }
  return (
    <div style={{ position: "fixed", top: 64, right: 20, width: "min(360px, 92vw)", background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 13, boxShadow: "0 18px 50px rgba(0,0,0,.5)", zIndex: 600, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>Notifications</span>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={markAll} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12.5, color: C.accent }}>Mark all read</button>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.text3 }}><Icon name="x" size={16} color={C.text3} /></button>
        </div>
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {items.length === 0 && <Empty label="All caught up." />}
        {items.map((n) => (
          <div key={n.id} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: n.is_read ? "transparent" : C.accent + "12" }}>
            <div style={{ fontSize: 13, fontWeight: n.is_read ? 500 : 700, color: C.text }}>{n.title}</div>
            {n.message && <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{n.message}</div>}
            <div style={{ fontSize: 11, color: C.text3, marginTop: 3 }}>{new Date(n.created_at).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Self-service change-password removed — Boss/Ops/Admin set passwords in User Management.

// ─── Login ─────────────────────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const d = await api("POST", "/auth/login", { email, password });
      _token = d.token; localStorage.setItem("oms_token", d.token); onLogin(d.user);
    } catch (e2) { setErr(e2.message === "Failed to fetch" ? "Cannot reach the server." : e2.message); setBusy(false); }
  }
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: `radial-gradient(900px 500px at 50% -10%, ${C.accent}18, transparent), ${C.bg}`, zoom: 0.9 }}>
      <form onSubmit={submit} style={{ width: 380, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 18, padding: "36px 34px", boxShadow: "0 24px 60px rgba(0,0,0,.5)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 26 }}>
          <Logo size={52} />
          <div style={{ fontSize: 21, fontWeight: 800, color: C.text, marginTop: 14 }}>Wawasan Candle</div>
          <div style={{ fontSize: 13, color: C.text3, marginTop: 2 }}>Order Management System</div>
        </div>
        <Field label="Email" type="email" name="email" autoComplete="username" value={email} onChange={setEmail} required placeholder="you@wawasancandle.com" />
        <Field label="Password" type="password" name="current-password" autoComplete="current-password" value={password} onChange={setPassword} required />
        <p style={{ fontSize: 12, color: C.text3, margin: "-2px 0 14px" }}>Forgot your password? Ask your manager (Boss or Ops) to reset it for you.</p>
        {err && <p style={{ color: "#fca5a5", fontSize: 13, margin: "-4px 0 12px" }}>{err}</p>}
        <Btn type="submit" onClick={() => {}} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Signing in…" : "Sign in"}</Btn>
      </form>
    </div>
  );
}

// ─── Responsive ────────────────────────────────────────────────────────────────
function useViewport() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

// ─── App shell ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState("board");
  const [search, setSearch] = useState("");
  const [weekOnly, setWeekOnly] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const [unread, setUnread] = useState(0);
  const [unreadIds, setUnreadIds] = useState(() => new Set());
  const [openChanges, setOpenChanges] = useState([]); // unread notifs for the order being opened — shown as "what changed" banner
  const [toasts, setToasts] = useState([]);
  const prevUnreadRef = useRef(-1);
  const [boardKey, setBoardKey] = useState(0);
  const [boardCount, setBoardCount] = useState(null);
  const vw = useViewport();
  const isMobile = vw < 820;
  const [navOpen, setNavOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    const t = localStorage.getItem("oms_token");
    if (!t) { setBooting(false); return; }
    _token = t;
    api("GET", "/auth/me").then((d) => setUser(d.user)).catch(() => { _token = ""; localStorage.removeItem("oms_token"); }).finally(() => setBooting(false));
  }, []);
  function pushToast(n) {
    const id = (n && n.id) || `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, title: n.title, orderId: n.order_id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }
  // Opening an order clears its board glow — mark that order's notifications read.
  async function openOrder(id) {
    setSelectedOrder(id);
    setOpenChanges([]);
    if (unreadIds.has(id)) {
      setUnreadIds((s) => { const n = new Set(s); n.delete(id); return n; });
      setUnread((u) => Math.max(0, u - 1));
      // Grab what changed BEFORE marking read, so the detail can show it instead of it just vanishing from the bell.
      try {
        const d = await api("GET", "/notifications?unread_only=1");
        const mine = (d.notifications || []).filter((n) => n.order_id === id);
        setOpenChanges(mine);
        await Promise.all(mine.map((n) => api("PATCH", `/notifications/${n.id}/read`)));
      } catch (e) { /* best effort */ }
    }
  }
  useEffect(() => {
    if (!user) return;
    const poll = () => api("GET", "/notifications?unread_only=1").then((d) => {
      const list = d.notifications || [], count = d.unread_count || 0;
      setUnread(count);
      setUnreadIds(new Set(list.filter((n) => n.order_id).map((n) => n.order_id)));
      // Pop a toast only on a real increase (not the first load), so something new can't be missed.
      if (prevUnreadRef.current >= 0 && count > prevUnreadRef.current && list[0]) pushToast(list[0]);
      prevUnreadRef.current = count;
    }).catch(() => {});
    poll(); const t = setInterval(poll, 10000); return () => clearInterval(t);
  }, [user]);

  // Keep the active page valid for the current role; otherwise fall back to the board.
  useEffect(() => {
    if (!user) return;
    const allowed = NAV.filter((n) => !n.roles || n.roles.includes(user.role)).map((n) => n.id);
    if (page !== "floor" && !allowed.includes(page)) setPage(allowed[0] || "board");
  }, [user, page]);

  function logout() { api("POST", "/auth/logout").catch(() => {}); _token = ""; localStorage.removeItem("oms_token"); setPage("board"); setUser(null); }
  function bumpBoard() { setBoardKey((k) => k + 1); }

  if (booting) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: C.text3 }}>Loading…</div>;
  if (!user) return <LoginPage onLogin={setUser} />;

  if (page === "floor") return <FloorDisplay onExit={() => setPage("board")} />;

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  // Effective page for rendering: if the active page isn't allowed for this role
  // (e.g. delivery_team's default "board"), fall back to their first nav item so a
  // disallowed page never paints for a frame before the guard effect corrects state.
  const view = page === "floor" || nav.some((n) => n.id === page) ? page : (nav[0] ? nav[0].id : "board");
  const canCreate = ["super_admin", "operations_controller"].includes(user.role);
  const [title, subtitle] = PAGE_META[view] || ["", ""];

  return (
    // zoom 0.9 = render the workspace as if the browser were at 90% (owner found
    // 100% too big). Floor Display is a separate early return, so the wall stays full-size.
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, zoom: 0.9 }}>
      {/* Mobile sidebar backdrop */}
      {isMobile && navOpen && <div onClick={() => setNavOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 1250 }} />}
      {/* Sidebar */}
      <aside style={{ width: 248, background: C.bg2, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", ...(isMobile ? { position: "fixed", top: 0, left: 0, height: "100dvh", zIndex: 1300, transform: navOpen ? "translateX(0)" : "translateX(-110%)", transition: "transform .22s ease", boxShadow: navOpen ? "0 0 50px rgba(0,0,0,.6)" : "none" } : { position: "sticky", top: 0, height: "100vh" }) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "20px 20px 18px" }}>
          <Logo size={38} />
          <div><div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: 0.4 }}>WAWASAN</div><div style={{ fontSize: 10.5, fontWeight: 600, color: C.text3, letterSpacing: 1.5 }}>CANDLE</div></div>
        </div>
        {nav.some((n) => n.id === "floor") && (
          <button onClick={() => { setPage("floor"); setNavOpen(false); }} title="Open the full-screen production wall display"
            style={{ display: "flex", alignItems: "center", gap: 11, margin: "0 12px 10px", padding: "11px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, cursor: "pointer", fontSize: 13.5, fontWeight: 600, textAlign: "left" }}>
            <Icon name="display" size={18} color={C.accent} />
            <span style={{ flex: 1 }}>Floor Display</span>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: C.text3, border: `1px solid ${C.border2}`, borderRadius: 5, padding: "1px 5px" }}>WALL</span>
          </button>
        )}
        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.text3, letterSpacing: 1.5, padding: "6px 22px" }}>WORKSPACE</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 12px", overflowY: "auto", flex: 1 }}>
          {nav.filter((n) => n.id !== "floor").map((n) => {
            const active = view === n.id;
            return (
              <button key={n.id} onClick={() => { setPage(n.id); setNavOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderRadius: 9, border: "none", cursor: "pointer", background: active ? C.accent + "1c" : "transparent", color: active ? C.accent : C.text2, fontSize: 13.5, fontWeight: active ? 700 : 500, textAlign: "left", borderLeft: active ? `2px solid ${C.accent}` : "2px solid transparent" }}>
                <Icon name={n.icon} size={18} color={active ? C.accent : C.text3} />
                <span style={{ flex: 1 }}>{n.label}</span>
                {n.id === "board" && boardCount != null && <span style={{ background: active ? C.accent + "33" : C.surface2, color: active ? C.accent : C.text3, borderRadius: 6, padding: "0 7px", fontSize: 12, fontWeight: 700 }}>{boardCount}</span>}
                {n.id === "messages" && <span style={{ background: "#3a2a0a", color: C.accent, borderRadius: 6, padding: "1px 6px", fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5 }}>DEMO</span>}
              </button>
            );
          })}
        </nav>
        <button onClick={logout} style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 16px 18px", padding: "10px 12px", background: "transparent", border: "none", color: C.text3, cursor: "pointer", fontSize: 13.5 }}><Icon name="logout" size={17} color={C.text3} /> Log out</button>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 16, rowGap: 10, flexWrap: "wrap", padding: isMobile ? "12px 16px" : "16px 26px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg + "ee", backdropFilter: "blur(6px)", zIndex: 100 }}>
          {isMobile && <button onClick={() => setNavOpen(true)} title="Menu" style={{ width: 40, height: 40, display: "grid", placeItems: "center", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, cursor: "pointer", color: C.text2, flexShrink: 0 }}><Icon name="menu" size={20} color={C.text2} /></button>}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 19, fontWeight: 800, color: C.text }}>{title}</h1>
            {subtitle && <div style={{ fontSize: 12.5, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div>}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {view === "board" && (
              <div style={{ position: "relative", width: 260, maxWidth: "30vw" }}>
                <span style={{ position: "absolute", left: 11, top: 9 }}><Icon name="search" size={15} color={C.text3} /></span>
                <input type="search" name="board-search" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice, customer…" style={{ width: "100%", padding: "8px 12px 8px 34px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5, outline: "none" }} />
              </div>
            )}
            {canCreate && <Btn onClick={() => setShowCreate(true)}><Icon name="plus" size={15} /> New Order</Btn>}
            <button onClick={() => { setShowNotifs((s) => !s); }} title="Notifications"
              style={{ position: "relative", height: 38, minWidth: 38, padding: unread > 0 ? "0 12px" : 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, background: unread > 0 ? C.danger + "22" : C.surface, border: `1px solid ${unread > 0 ? C.danger : C.border2}`, borderRadius: 9, cursor: "pointer", color: unread > 0 ? C.danger : C.text2, fontWeight: 700, fontSize: 13, animation: unread > 0 ? "wws-ring 1.4s ease 2" : "none" }}>
              <Icon name="bell" size={17} color={unread > 0 ? C.danger : C.text2} />
              {unread > 0 && <span>{unread} new</span>}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 9, paddingLeft: 12, borderLeft: `1px solid ${C.border}` }}>
              <Avatar name={user.name} color={user.avatar_color} size={32} />
              <div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{user.name}</div><div style={{ fontSize: 11, color: C.text3 }}>{ROLE_LABELS[user.role]}</div></div>
            </div>
          </div>
        </header>

        {toasts.length > 0 && (
          <div style={{ position: "fixed", top: 70, right: 18, zIndex: 1400, display: "flex", flexDirection: "column", gap: 9, width: 320, maxWidth: "calc(100vw - 36px)" }}>
            {toasts.map((t) => (
              <div key={t.id} onClick={() => { if (t.orderId) openOrder(t.orderId); setToasts((a) => a.filter((x) => x.id !== t.id)); }}
                style={{ background: C.bg2, border: `1px solid ${C.order}`, borderRadius: 11, padding: "11px 13px", display: "flex", gap: 10, alignItems: "flex-start", boxShadow: "0 14px 40px rgba(0,0,0,.5)", cursor: "pointer", animation: "wws-toastin .25s ease" }}>
                <Icon name="bell" size={17} color={C.order} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{t.title}</div>
                  <div style={{ fontSize: 11.5, color: C.text3, marginTop: 2 }}>just now · tap to open</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setToasts((a) => a.filter((x) => x.id !== t.id)); }} style={{ background: "none", border: "none", color: C.text3, cursor: "pointer", fontSize: 15, lineHeight: 1 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {view === "board" && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: isMobile ? "12px 14px 0" : "12px 26px 0" }}>
            <button onClick={() => setWeekOnly((w) => !w)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: weekOnly ? C.accent + "1c" : C.surface, border: `1px solid ${weekOnly ? C.accent + "55" : C.border2}`, borderRadius: 9, color: weekOnly ? C.accent : C.text2, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <Icon name="calendar" size={15} color={weekOnly ? C.accent : C.text3} /> This week only
            </button>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="Filter by status" style={{ padding: "8px 12px", background: statusFilter ? C.accent + "1c" : C.surface, border: `1px solid ${statusFilter ? C.accent + "55" : C.border2}`, borderRadius: 9, color: statusFilter ? C.accent : C.text2, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <option value="" style={{ background: C.bg2, color: C.text }}>All statuses</option>
              <option value="urgent" style={{ background: C.bg2, color: C.text }}>Urgent only</option>
              <option value="late" style={{ background: C.bg2, color: C.text }}>Late only</option>
              <option value="on_hold" style={{ background: C.bg2, color: C.text }}>On hold</option>
              <option value="waiting_stock" style={{ background: C.bg2, color: C.text }}>Waiting stock</option>
            </select>
          </div>
        )}

        <main style={{ flex: 1, padding: isMobile ? "16px 14px 32px" : "20px 26px 40px", overflowX: "auto" }}>
          {view === "board" && <OrderBoard user={user} search={search} weekOnly={weekOnly} statusFilter={statusFilter} refreshKey={boardKey} onOpenOrder={(o) => openOrder(o.id)} onCount={setBoardCount} unreadIds={unreadIds} />}
          {view === "dashboard" && <Dashboard onOpenOrder={(id) => openOrder(id)} />}
          {view === "delivery" && <Delivery user={user} onOpenOrder={(id) => openOrder(id)} />}
          {view === "reports" && <Reports user={user} />}
          {view === "messages" && <Messages user={user} />}
          {view === "remarks" && <Remarks user={user} />}
          {view === "audit" && <Audit />}
          {view === "users" && <Users user={user} />}
          {view === "settings" && <Settings />}
        </main>
      </div>

      {showNotifs && <NotificationsPanel onClose={() => setShowNotifs(false)} onChanged={() => setUnread(0)} />}

      <Modal open={!!selectedOrder} onClose={() => { setSelectedOrder(null); setOpenChanges([]); }} title="Order detail" width={640}>
        {selectedOrder && <OrderDetail orderId={selectedOrder} user={user} changes={openChanges} onUpdated={bumpBoard} onClose={() => { setSelectedOrder(null); setOpenChanges([]); }} />}
      </Modal>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create new order" width={620}>
        <CreateOrderForm onCreated={() => { setShowCreate(false); bumpBoard(); }} onClose={() => setShowCreate(false)} />
      </Modal>
    </div>
  );
}
