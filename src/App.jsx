import { useState, useEffect, useRef, useMemo } from "react";

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
  production_lead: "Production Lead", production_staff: "Production Staff",
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
  { id: "board", label: "Order Board", icon: "board", roles: BOARD_ROLES },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", roles: ["super_admin", "operations_controller"] },
  { id: "delivery", label: "Delivery", icon: "truck", roles: ["super_admin", "operations_controller", "delivery_team"] },
  { id: "floor", label: "Floor Display", icon: "display", roles: NON_ADMIN_ROLES },
  { id: "reports", label: "Reports", icon: "chart", roles: ["super_admin", "operations_controller"] },
  { id: "remarks", label: "Production Remarks", icon: "message", roles: ["super_admin", "production_lead"] },
  { id: "audit", label: "Audit Trail", icon: "audit", roles: ["super_admin", "admin"] },
  { id: "users", label: "User Management", icon: "users", roles: ["super_admin", "admin", "operations_controller"] },
  { id: "settings", label: "System Settings", icon: "settings", roles: ["super_admin", "admin"] },
];
const PAGE_META = {
  board: ["Order Board", ""],
  dashboard: ["Dashboard", "Operations overview"],
  delivery: ["Delivery", "Schedule and dispatch"],
  reports: ["Reports", "Department performance"],
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
function StatusPicker({ value, onChange, disabled }) {
  return (
    <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {ITEM_STATUS_ORDER.map((s) => {
        const cfg = ITEM_STATUS[s], active = value === s;
        return (
          <button key={s} type="button" disabled={disabled} onClick={() => !disabled && onChange(s)}
            style={{ cursor: disabled ? "default" : "pointer", border: `1px solid ${active ? cfg.color + "88" : C.border2}`, background: active ? cfg.color + "22" : C.surface2, color: active ? cfg.color : C.text3, borderRadius: 7, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}>
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
  const html = (`<!doctype html><html><head><meta charset="utf-8"><title>Picking Slip ${escHtml(order.invoice_number)}</title>
<style>
  *{box-sizing:border-box} body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:32px}
  h1{font-size:22px;margin:0 0 2px} .sub{color:#666;margin-bottom:18px}
  .meta{display:flex;gap:32px;flex-wrap:wrap;margin-bottom:18px} .meta div{font-size:13px} .meta b{display:block;color:#888;font-weight:600;font-size:11px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:8px} th,td{padding:9px 10px;border-bottom:1px solid #ddd;text-align:left}
  th{font-size:11px;text-transform:uppercase;color:#888} .m{font-family:ui-monospace,Consolas,monospace;color:#555} .q{font-weight:700;text-align:right} .chk{width:30px;text-align:center;font-size:18px}
  @media print{body{margin:12mm}}
</style></head><body>
  <h1>Picking Slip</h1><div class="sub">Wawasan Candle — ${escHtml(order.invoice_number)}</div>
  <div class="meta">
    <div><b>Customer</b>${escHtml(order.customer_name || impCfg(order.importance).label)}</div>
    <div><b>Delivery date</b>${escHtml(fmtDay(order.required_delivery_date))}</div>
    <div><b>Stage</b>${escHtml((STAGE_LABELS[order.stage] || {}).label || order.stage)}</div>
    <div><b>Priority</b>${order.priority === "urgent" ? "URGENT" : "Normal"}</div>
  </div>
  <table><thead><tr><th>SKU</th><th>Product</th><th style="text-align:right">Qty</th><th>Unit</th><th>Picked</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5">No items.</td></tr>'}</tbody></table>
  <p style="margin-top:24px;color:#888;font-size:12px">Printed ${escHtml(new Date().toLocaleString())}</p>
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
    `<tr><td class="n">${i + 1}</td><td class="m">${escHtml(d.invoice_number)}</td><td>${escHtml(d.customer_name || "")}</td><td>${escHtml(d.address || "—")}</td><td>${escHtml(d.delivery_man_name || "—")}</td><td class="m">${escHtml(d.tracking_no || "—")}</td><td class="chk">&#9744;</td></tr>`
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
  <table><thead><tr><th>#</th><th>Invoice</th><th>Customer</th><th>Address</th><th>Courier</th><th>Tracking</th><th>Done</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No deliveries scheduled.</td></tr>'}</tbody></table>
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

// ─── Kanban card (board) ───────────────────────────────────────────────────────
function KanbanCard({ order, user, onOpen, onAdvance }) {
  const stage = STAGES[order.stage] || { color: C.text3 };
  const cd = countdown(order.required_delivery_date);
  const late = (daysUntil(order.required_delivery_date) ?? 0) < 0;
  const urgent = order.priority === "urgent";
  const onHold = !!order.on_hold;
  const waiting = !!order.waiting_stock;
  const imp = impCfg(order.importance);
  const showName = !!order.customer_name;
  const dtag = deliveryTag(order);
  const invColor = late ? C.danger : urgent ? C.accent2 : C.text;
  const next = BOARD_STAGES[BOARD_STAGES.indexOf(order.stage) + 1] || "delivered";
  return (
    <div onClick={() => onOpen(order)}
      style={{ background: C.surface, border: `1px solid ${urgent || late ? C.danger + "55" : C.border}`, borderLeft: `3px solid ${stage.color}`, borderRadius: 11, padding: "12px 13px", cursor: "pointer", transition: "background .12s" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.surface2)}
      onMouseLeave={(e) => (e.currentTarget.style.background = C.surface)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: invColor, letterSpacing: 0.3 }}>{order.invoice_number}</span>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {urgent && <Pill color={C.danger}>Urgent</Pill>}
          {showName && <Pill color={imp.color}>{imp.label}</Pill>}
          {dtag && <Pill color={dtag.color}>{dtag.label}</Pill>}
          {waiting && <Pill color={C.danger}>⚠ Waiting stock</Pill>}
          {onHold && <Pill color={C.hold}>On hold</Pill>}
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
              {full ? "All SKUs done ✓" : `${done}/${total} SKUs done`}
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
        <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
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
  const canMark = user && ["super_admin", "operations_controller", "production_lead", "production_staff", "packing_staff"].includes(user.role);
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
      {order.stage === "production" && items.length > 0 && !allMade && (
        <div style={{ fontSize: 12.5, color: C.packing, marginBottom: 12 }}>⚠ Not all SKUs are marked made yet — confirm only if production is actually complete.</div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={go} disabled={busy}><Icon name="check" size={15} /> {busy ? "Moving…" : "Confirm & advance"}</Btn>
      </div>
    </Modal>
  );
}
function OrderBoard({ user, search, weekOnly, statusFilter, onOpenOrder, refreshKey, onCount }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [confirmAdv, setConfirmAdv] = useState(null);
  const [viewStage, setViewStageRaw] = useState(() => {
    const saved = (typeof localStorage !== "undefined" && localStorage.getItem("oms_board_stage")) || "all";
    return saved === "all" || visibleStages(user.role).includes(saved) ? saved : "all";
  });
  const setViewStage = (s) => { setViewStageRaw(s); try { localStorage.setItem("oms_board_stage", s); } catch (e) {} };
  const canMove = ["super_admin", "operations_controller"].includes(user.role);
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
                {orders.map((o) => <KanbanCard key={o.id} order={o} user={user} onOpen={onOpenOrder} onAdvance={advance} />)}
                {orders.length === 0 && <Empty label="No orders" />}
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
function FloorDisplay({ onExit }) {
  const [board, setBoard] = useState(null);
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

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 2000, display: "flex", flexDirection: "column", padding: 22 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Logo size={46} />
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 0.5 }}>
            <span style={{ color: C.text }}>WAWASAN </span><span style={{ color: C.accent }}>PRODUCTION FLOOR</span>
          </div>
        </div>
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
          <span style={{ fontFamily: MONO, fontSize: 38, fontWeight: 700, color: C.text, letterSpacing: 2 }}>{clock}</span>
          <Btn variant="soft" onClick={onExit}><Icon name="x" size={15} /> Exit</Btn>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
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
                    return (
                      <div key={o.id} style={{ background: C.surface, border: `1px solid ${urgent || late ? C.danger + "55" : C.border}`, borderLeft: `3px solid ${cfg.color}`, borderRadius: 9, padding: "9px 11px" }}>
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
                        <div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{o.item_count} {o.item_count === 1 ? "line" : "lines"}</div>
                        {(o.stage === "production" || o.stage === "packing") && o.item_count > 0 && (() => {
                          const done = o.made_count || 0, total = o.item_count || 0, full = total > 0 && done >= total;
                          const p = total > 0 ? Math.round((done / total) * 100) : 0;
                          return (
                            <div style={{ marginTop: 5 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: full ? C.green : C.accent2, marginBottom: 3 }}>{full ? "All done ✓" : `${done}/${total} SKUs · ${p}%`}</div>
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
        <div style={{ width: 420, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", minHeight: 0 }}>
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
                const p = total > 0 ? Math.round((done / total) * 100) : 0;
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                      <span style={{ color: C.text2 }}>{done}/{total} SKUs done</span>
                      <span style={{ color: p >= 100 ? C.green : C.accent2, fontWeight: 800 }}>{p}%</span>
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
                    return (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 0", borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot, boxShadow: `0 0 8px ${dot}`, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.text3, letterSpacing: 0.5 }}>{it.sku}</div>
                        <div style={{ fontSize: 19, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <span style={{ fontSize: 20, fontWeight: 800, color: dot, lineHeight: 1, textTransform: "uppercase", letterSpacing: 0.5 }}>{st.label}</span>
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
      </div>
    </div>
  );
}

// ─── Order detail modal ──────────────────────────────────────────────────────
function OrderDetail({ orderId, user, onUpdated }) {
  const [order, setOrder] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [tab, setTab] = useState("details");
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
  const canMark = ["super_admin", "operations_controller", "production_lead", "production_staff", "packing_staff"].includes(user.role);
  const isLead = user.role === "production_lead";

  async function load() { try { const o = await api("GET", `/orders/${orderId}`); setOrder(o); setNotes(o.notes || ""); } catch (e) { setOrder({ _error: e.message }); } }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);
  useEffect(() => { api("GET", `/delivery?order_id=${orderId}`).then((d) => setDelivery((d && d[0]) || null)).catch(() => setDelivery(null)); }, [orderId]);
  useEffect(() => { if (canMove) api("GET", "/users").then(setUsers).catch(() => setUsers([])); /* eslint-disable-next-line */ }, []);

  async function doMove(to, why) {
    if (!to) return;
    setBusy(true);
    try { await api("POST", `/orders/${orderId}/move`, { to_stage: to, reason: why || undefined }); setMoveStage(""); setReason(""); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function setItemStatus(it, status) {
    if (status === itemStatusKey(it)) return;
    try { await api("PATCH", `/orders/${orderId}/items/${it.id}`, { status }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
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
  const tabs = ["details", "items", "timeline", "attachments"];
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
        {order.skip_production && <Pill color={C.accent} bg="transparent">No production</Pill>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: C.text3 }}>{order.created_by_name ? `Created by ${order.created_by_name}` : ""} {order.order_date ? `· ${fmtDay(order.order_date)}` : ""}</span>
        <Btn variant="ghost" size="sm" onClick={() => printPickingSlip(order)}>Print picking slip</Btn>
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
            <LV label="Priority" v={
              canMove
                ? <select value={order.priority || "normal"} onChange={(e) => setPriority(e.target.value)} style={{ padding: "5px 9px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5, fontWeight: 700, color: order.priority === "urgent" ? C.danger : C.text2 }}><option value="normal" style={{ background: C.bg2, color: C.text }}>Normal</option><option value="urgent" style={{ background: C.bg2, color: C.text }}>Urgent</option></select>
                : <Pill color={order.priority === "urgent" ? C.danger : C.text2}>{order.priority === "urgent" ? "Urgent" : "Normal"}</Pill>
            } />
            <LV label="Importance" v={
              canMove
                ? <select value={order.importance || "standard"} onChange={(e) => setImportance(e.target.value)} style={{ padding: "5px 9px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5, fontWeight: 700, color: impCfg(order.importance).color }}>{IMPORTANCE_OPTS.map((o) => <option key={o.value} value={o.value} style={{ background: C.bg2, color: C.text }}>{o.label}</option>)}</select>
                : <Pill color={impCfg(order.importance).color}>{impCfg(order.importance).label}</Pill>
            } />
            <LV label="Order date" v={order.order_date ? fmtDay(order.order_date) : "—"} />
            <LV label="Delivery" v={<span style={{ color: countdown(order.required_delivery_date).tone }}>{fmtDay(order.required_delivery_date)} · {countdown(order.required_delivery_date).text}</span>} />
            <LV label="Expiry" v={order.expiry_date ? fmtDay(order.expiry_date) : "—"} />
            <LV label="Person in charge" v={order.pic_name ? <span style={{ display: "inline-flex", gap: 7, alignItems: "center" }}><Avatar name={order.pic_name} color={order.pic_color} size={22} />{order.pic_name}</span> : "Unassigned"} />
            <LV label="Source" v={order.source === "sql_account" ? "Auto-imported" : "Manual entry"} />
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
        const head = ["SKU", "Product", "Qty", "Unit", "Status"];
        return (
        <div>
          {items.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.text2, marginBottom: 6 }}>
                <span>{doneLines}/{total} SKUs done</span>
                <span style={{ color: pct >= 100 ? C.ready : C.accent, fontWeight: 700 }}>{pct}%</span>
              </div>
              <div style={{ height: 6, background: C.surface2, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? C.ready : C.accent, transition: "width .2s" }} />
              </div>
            </div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: "left", padding: "8px 10px", color: C.text3, borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={head.length}><Empty label="No items." /></td></tr>}
              {items.map((it) => {
                const st = itemStat(it);
                const prog = <StatusPicker value={st.k} onChange={(s) => setItemStatus(it, s)} />;
                const pill = <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 20, fontSize: 11.5, fontWeight: 700, color: st.color, background: st.color + "1f", border: `1px solid ${st.color}44` }}>{st.label}</span>;
                return (
                <tr key={it.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "8px 10px", fontFamily: MONO, color: C.text2 }}>{it.sku}</td>
                  <td style={{ padding: "8px 10px", color: C.text }}>{it.name}</td>
                  <td style={{ padding: "8px 10px", fontWeight: 700, color: C.text }}>{Math.round(it.quantity)}</td>
                  <td style={{ padding: "8px 10px", color: C.text3 }}>{it.unit}</td>
                  <td style={{ padding: "8px 10px" }}>{canMark ? prog : pill}</td>
                </tr>
              );})}
            </tbody>
          </table>
          {canMove && items.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: C.text3 }}>Line items are locked to match the invoice — only an item's status can change. To correct a SKU or quantity, fix it in SQL Account.</div>
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
              {a.size != null && <span style={{ fontSize: 11, color: C.text3 }}>{a.size >= 1048576 ? (a.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(a.size / 1024)) + " KB"}</span>}
              <span style={{ fontSize: 11.5, color: C.text3, marginLeft: "auto" }}>{a.uploaded_by_name}</span>
              {canMove && <button onClick={() => removeAttachment(a.id)} title="Remove" style={{ background: "#3a1a1a", border: "none", borderRadius: 6, color: "#fca5a5", cursor: "pointer", width: 24, height: 24, flexShrink: 0 }}>×</button>}
            </div>
          ))}
        </div>
      )}

      {!canMove && canAdvanceStage(user.role, order.stage) && !order.on_hold && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <Btn onClick={() => setConfirmAdv(true)} disabled={busy}>{ADVANCE_LABEL[order.stage] || "Mark complete"} →</Btn>
          <p style={{ fontSize: 12, color: C.text3, marginTop: 8 }}>Marks your stage done and moves the order to the next stage.</p>
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

      {canMove && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, marginBottom: 8 }}>Stage actions</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: C.text2, minWidth: 28 }}>In charge</span>
            <select value={order.pic_id || ""} onChange={(e) => assignPic(e.target.value)} style={{ flex: 1, minWidth: 180, padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text }}>
              <option value="" style={{ background: C.bg2 }}>Unassigned</option>
              {order.pic_id && !picUsers.some((u) => u.id === order.pic_id) && <option value={order.pic_id} style={{ background: C.bg2 }}>{order.pic_name || "Current PIC"}</option>}
              {picUsers.map((u) => <option key={u.id} value={u.id} style={{ background: C.bg2 }}>{u.name} — {ROLE_LABELS[u.role] || u.role}</option>)}
            </select>
            <span style={{ fontSize: 11.5, color: C.text3 }}>Saved automatically</span>
          </div>
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
            <Btn variant="danger" size="sm" onClick={() => { if (confirm("Cancel this order?")) doMove("cancelled", reason || "Cancelled"); }} disabled={busy}>Cancel order</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
function LV({ label, v }) {
  return <div><div style={{ fontSize: 11, color: C.text3, fontWeight: 600, marginBottom: 2 }}>{label}</div><div style={{ fontSize: 14, color: C.text }}>{v}</div></div>;
}

// ─── Create order ──────────────────────────────────────────────────────────────
function CreateOrderForm({ onCreated, onClose }) {
  const [f, setF] = useState({ invoice_number: "", customer_name: "", customer_contact: "", required_delivery_date: "", expiry_date: "", priority: "normal", importance: "standard", skip_production: false, notes: "" });
  const [items, setItems] = useState([{ sku: "", name: "", quantity: 1, unit: "pcs" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [holidays, setHolidays] = useState([]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const narrow = useViewport() < 640;
  useEffect(() => { api("GET", "/settings/holidays").then((d) => setHolidays(d || [])).catch(() => setHolidays([])); }, []);
  const holidayHit = f.required_delivery_date ? holidays.find((h) => h.date === f.required_delivery_date) : null;

  async function submit() {
    if (!f.invoice_number || !f.customer_name || !f.required_delivery_date) { setErr("Invoice, customer and delivery date are required."); return; }
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
        <Field label="Required Delivery Date" type="date" value={f.required_delivery_date} onChange={(v) => set("required_delivery_date", v)} required />
        <Field label="Expiry Date" type="date" value={f.expiry_date} onChange={(v) => set("expiry_date", v)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text2, marginTop: 26 }}>
          <input type="checkbox" checked={f.skip_production} onChange={(e) => set("skip_production", e.target.checked)} /> Skip production (→ packing)
        </label>
      </div>
      {holidayHit && <p style={{ color: C.packing, fontSize: 12.5, margin: "0 0 8px" }}>⚠ {fmtDay(f.required_delivery_date)} is a holiday: {holidayHit.name}. Delivery may not happen that day.</p>}
      <Field label="Notes" value={f.notes} onChange={(v) => set("notes", v)} placeholder="Optional…" />
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, margin: "6px 0 8px" }}>Order Items</div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "110px 1fr 70px 64px 32px", gap: 6, marginBottom: 6 }}>
          <input placeholder="SKU" value={it.sku} onChange={(e) => setItems((a) => a.map((x, j) => j === i ? { ...x, sku: e.target.value } : x))} style={inp} />
          <input placeholder="Product" value={it.name} onChange={(e) => setItems((a) => a.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} style={inp} />
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
function OrdersReport({ period }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  useEffect(() => { setData(null); api("GET", `/reports/orders?period=${period}`).then((d) => setData(d.orders || [])).catch(() => setData([])); }, [period]);
  const fmtDur = (h) => h == null ? "—" : h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
  function exportCsv() {
    const rows = [["Invoice", "Customer", "Stage", "SKUs done", "SKUs total", "% done", "Days in stage", "Cycle (h)", "Due", "Status", "PIC"]];
    for (const o of data) rows.push([o.invoice_number, o.customer_name || "", (STAGE_LABELS[o.stage] || {}).label || o.stage, o.done_count, o.item_count, o.pct, o.days_in_stage, o.cycle_hours, o.required_delivery_date, o.delivered ? (o.on_time ? "Delivered on-time" : "Delivered late") : (o.late ? "Late" : "In progress"), o.pic_name || ""]);
    downloadCsv(`orders-report-${period}.csv`, rows);
  }
  if (!data) return <Loading label="Loading orders…" />;
  if (data.length === 0) return <Empty label="No orders for this period." />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.text3 }}>{data.length} orders · click a row for stage timeline & SKU breakdown</span>
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
                    <div style={{ fontSize: 12, color: C.text2, marginBottom: 3 }}>{o.done_count}/{o.item_count} SKUs · {o.pct}%</div>
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
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, marginBottom: 6, letterSpacing: 0.4 }}>SKU STATUS</div>
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
    </div>
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────
function Reports({ user }) {
  const tabsForRole = user.role === "production_lead" ? ["production", "packing"]
    : user.role === "delivery_team" ? ["delivery"]
    : ["production", "packing", "delivery", "orders"];
  const [tab, setTab] = useState(tabsForRole[0]);
  const [period, setPeriod] = useState("weekly");
  const [d, setD] = useState({});
  useEffect(() => { if (tab === "orders") return; api("GET", `/reports/${tab}?period=${period}`).then(setD).catch(() => setD({})); }, [tab, period]);
  const metricDefs = {
    production: (d) => [["Orders Completed", d.completed], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["Avg Production", d.avg_production_hours ? d.avg_production_hours + "h" : "—"], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"]],
    packing: (d) => [["Orders Packed", d.packed], ["Avg Pack Time", d.avg_pack_minutes ? d.avg_pack_minutes + "min" : "—"], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"]],
    delivery: (d) => [["Total Deliveries", d.total_deliveries], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["On-Time Count", d.on_time_count]],
  };
  const metrics = tab === "orders" ? {} : { [tab]: metricDefs[tab](d) };
  const trend = d.daily_trend || [];
  const maxT = Math.max(...trend.map((t) => t.count), 1);
  async function exportAll() {
    const meta = { production: "Production", packing: "Packing", delivery: "Delivery" };
    const fetched = await Promise.all(tabsForRole.filter((key) => metricDefs[key]).map((key) =>
      api("GET", `/reports/${key}?period=${period}`).then((dd) => [key, dd]).catch(() => [key, {}])
    ));
    const rows = [["Wawasan Candle — Reports"], ["Period", period], []];
    for (const [key, dd] of fetched) {
      rows.push([meta[key]], ["Metric", "Value"], ...metricDefs[key](dd).map(([k, v]) => [k, v == null ? "" : v]));
      if ((dd.by_delivery_man || []).length) rows.push([], ["Courier", "Deliveries", "On time"], ...dd.by_delivery_man.map((x) => [x.name, x.total, x.on_time]));
      if ((dd.daily_trend || []).length) rows.push([], ["Date", "Count"], ...dd.daily_trend.map((t) => [t.date, t.count]));
      rows.push([]);
    }
    downloadCsv(`reports-${period}.csv`, rows);
  }
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
          {tabsForRole.map((t) => <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? C.surface2 : "transparent", border: "none", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? C.text : C.text2, textTransform: "capitalize" }}>{t}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13 }}>
            <option value="daily" style={{ background: C.bg2 }}>Today</option>
            <option value="weekly" style={{ background: C.bg2 }}>This Week</option>
            <option value="monthly" style={{ background: C.bg2 }}>This Month</option>
          </select>
          <Btn variant="soft" onClick={exportAll}>Export all</Btn>
        </div>
      </div>
      {tab === "orders" && <OrdersReport period={period} />}
      {tab !== "orders" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14, marginBottom: 20 }}>
          {(metrics[tab] || []).map(([label, value]) => <Card key={label}><div style={{ fontSize: 28, fontWeight: 800, color: C.accent }}>{value ?? "—"}</div><div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{label}</div></Card>)}
        </div>
      )}
      {tab !== "orders" && trend.length > 0 && (
        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 16 }}>Daily trend</h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 130 }}>
            {trend.map((t, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.text2 }}>{t.count}</span>
                <div style={{ width: "100%", maxWidth: 46, background: C.accent, borderRadius: "5px 5px 0 0", height: `${(t.count / maxT) * 90}px`, minHeight: 4, transition: "height .4s" }} />
                <span style={{ fontSize: 10.5, color: C.text3 }}>{String(t.date).slice(5)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {tab === "delivery" && (d.by_delivery_man || []).length > 0 && (
        <Card style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>By courier</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Courier", "Deliveries", "On-time"].map((h) => <th key={h} style={{ textAlign: "left", padding: "7px 8px", color: C.text3, borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
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

// ─── Delivery ──────────────────────────────────────────────────────────────────
function Delivery({ user, onOpenOrder }) {
  const [list, setList] = useState(null);
  const [ready, setReady] = useState([]);
  const [deliverers, setDeliverers] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [show, setShow] = useState(false);
  const [allCompleted, setAllCompleted] = useState(false);
  const [confirmDeliver, setConfirmDeliver] = useState(null);
  const [form, setForm] = useState({ order_id: "", deliverer_id: "", scheduled_date: "", address: "", notes: "", tracking_no: "" });
  const [newDeliverer, setNewDeliverer] = useState({ name: "", phone: "" });
  const [otherCourier, setOtherCourier] = useState("");
  const [editDelivery, setEditDelivery] = useState(null);
  const [editForm, setEditForm] = useState({ deliverer_id: "", scheduled_date: "", address: "", notes: "", tracking_no: "" });
  const [editOther, setEditOther] = useState("");
  const [showCouriers, setShowCouriers] = useState(false);
  const [q, setQ] = useState("");
  const canAssign = ["super_admin", "operations_controller", "delivery_team"].includes(user.role);
  const canDeliver = ["super_admin", "operations_controller", "delivery_team"].includes(user.role);

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
        if (!otherCourier.trim()) { alert("Type the other courier's name, or pick one from the list."); return; }
        const dl = await api("POST", "/delivery/deliverers", { name: otherCourier.trim() });
        payload = { ...form, deliverer_id: dl.id };
      }
      await api("POST", "/delivery", payload);
      setShow(false); setForm({ order_id: "", deliverer_id: "", scheduled_date: "", address: "", notes: "", tracking_no: "" }); setOtherCourier("");
      load();
    } catch (e) { alert(e.message); }
  }
  async function markDelivered(id) { try { await api("POST", `/delivery/${id}/deliver`, {}); setConfirmDeliver(null); load(); } catch (e) { alert(e.message); } }
  function scheduleFor(orderId) { setForm((f) => ({ ...f, order_id: orderId })); setShow(true); }
  async function addDeliverer() {
    if (!newDeliverer.name.trim()) return;
    try { await api("POST", "/delivery/deliverers", newDeliverer); setNewDeliverer({ name: "", phone: "" }); load(); } catch (e) { alert(e.message); }
  }
  async function toggleDeliverer(dl) { try { await api("PATCH", `/delivery/deliverers/${dl.id}`, { is_active: !dl.is_active }); load(); } catch (e) { alert(e.message); } }
  function openEdit(dv) {
    setEditForm({ deliverer_id: dv.deliverer_id || "", scheduled_date: dv.scheduled_date || "", address: dv.address || "", notes: dv.notes || "", tracking_no: dv.tracking_no || "" });
    setEditOther(""); setEditDelivery(dv);
  }
  async function saveEdit() {
    try {
      let payload = editForm;
      if (editForm.deliverer_id === "__other__") {
        if (!editOther.trim()) { alert("Type the other courier's name, or pick one from the list."); return; }
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
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Due", "Expiry", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
              <tbody>
                {fReady.length === 0 && <tr><td colSpan={6}><Empty label={noMatch || "No orders waiting to be scheduled."} /></td></tr>}
                {fReady.map((o) => (
                  <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(o.id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{o.invoice_number}</button></td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>{o.customer_name}</td>
                    <td style={{ padding: "11px 16px", color: countdown(o.required_delivery_date).tone }}>{fmtDay(o.required_delivery_date)}</td>
                    <td style={{ padding: "11px 16px", color: o.expiry_date ? C.text2 : C.text3 }}>{o.expiry_date ? fmtDay(o.expiry_date) : "—"}</td>
                    <td style={{ padding: "11px 16px" }}><Pill color={C.ready}>Ready for Delivery</Pill></td>
                    <td style={{ padding: "11px 16px" }}><Btn size="sm" onClick={() => scheduleFor(o.id)}>Schedule →</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Pending · {fActive.length}</h3>
          {fActive.length > 0 && <Btn variant="soft" size="sm" onClick={() => printRouteList(fActive)}>Print route list</Btn>}
        </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Address", "Courier", "Tracking", "Scheduled", "Due", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {fActive.length === 0 && <tr><td colSpan={9}><Empty label={noMatch || "Nothing pending. Schedule a Ready-for-Delivery order above."} /></td></tr>}
              {fActive.map((dv) => (
                <tr key={dv.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(dv.order_id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{dv.invoice_number}</button></td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.customer_name}</td>
                  <td style={{ padding: "11px 16px", color: dv.address ? C.text2 : C.text3 }}>{dv.address || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.delivery_man_name || "—"}</td>
                  <td style={{ padding: "11px 16px", fontFamily: MONO, color: dv.tracking_no ? C.text2 : C.text3 }}>{dv.tracking_no || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.scheduled_date ? fmtDay(dv.scheduled_date) : "—"}</td>
                  <td style={{ padding: "11px 16px", color: countdown(dv.required_delivery_date).tone }}>{fmtDay(dv.required_delivery_date)}</td>
                  <td style={{ padding: "11px 16px" }}><Pill color={tone[dv.status] || C.text3}>{statusLabel[dv.status] || dv.status}</Pill></td>
                  <td style={{ padding: "11px 16px" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {canAssign && <Btn size="sm" variant="soft" onClick={() => openEdit(dv)}>Edit</Btn>}
                      {canDeliver && <Btn size="sm" variant="success" onClick={() => setConfirmDeliver(dv)}>Mark delivered</Btn>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 12 }}>Completed orders · {fCompleted.length}</h3>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Courier", "Delivered", "Due"].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {fCompleted.length === 0 && <tr><td colSpan={5}><Empty label={noMatch || "No completed orders yet."} /></td></tr>}
              {shownCompleted.map((o) => {
                const dv = delByOrder[o.id];
                return (
                  <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "11px 16px", fontFamily: MONO }}><button onClick={() => onOpenOrder && onOpenOrder(o.id)} title="Open order details" style={{ background: "none", border: 0, padding: 0, fontFamily: MONO, fontSize: "inherit", color: C.accent, cursor: "pointer", textAlign: "left" }}>{o.invoice_number}</button></td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>{o.customer_name}</td>
                    <td style={{ padding: "11px 16px", color: C.text2 }}>{dv && dv.delivery_man_name ? dv.delivery_man_name : "—"}</td>
                    <td style={{ padding: "11px 16px", color: C.ready }}>{dv && dv.delivered_at ? fmtDateTime(dv.delivered_at) : "Delivered"}</td>
                    <td style={{ padding: "11px 16px", color: C.text3 }}>{fmtDay(o.required_delivery_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        {fCompleted.length > 3 && <div style={{ marginTop: 10 }}><Btn variant="ghost" size="sm" onClick={() => setAllCompleted((v) => !v)}>{allCompleted ? "Show less ▲" : `Show all ${fCompleted.length} ▼`}</Btn></div>}
      </div>

      {canAssign && (
        <div>
          <button onClick={() => setShowCouriers((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Manage couriers · {deliverers.length}</h3>
            <span style={{ color: C.text3, fontSize: 13 }}>{showCouriers ? "▲" : "▼"}</span>
          </button>
          {!showCouriers && <div style={{ fontSize: 12.5, color: C.text3, marginTop: 4 }}>Tip: you can just type a courier when scheduling — it's saved here automatically. Open this only to disable or rename one.</div>}
          {showCouriers && (
            <>
              <Card style={{ padding: 0, overflowX: "auto", marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                  <thead><tr style={{ background: C.bg2 }}>{["Name", "Phone", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {deliverers.length === 0 && <tr><td colSpan={4}><Empty label="No couriers yet. Type one when scheduling, or add below." /></td></tr>}
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
                <input placeholder="Courier name (e.g. J&T, SPX)" value={newDeliverer.name} onChange={(e) => setNewDeliverer((p) => ({ ...p, name: e.target.value }))} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5 }} />
                <input placeholder="Phone (optional)" value={newDeliverer.phone} onChange={(e) => setNewDeliverer((p) => ({ ...p, phone: e.target.value }))} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5 }} />
                <Btn size="sm" onClick={addDeliverer} disabled={!newDeliverer.name.trim()}><Icon name="plus" size={14} /> Add courier</Btn>
              </div>
            </>
          )}
        </div>
      )}

      <Modal open={show} onClose={() => setShow(false)} title="Schedule delivery">
        <Field label="Order (ready for delivery)" value={form.order_id} onChange={(v) => setForm((f) => ({ ...f, order_id: v }))}
          options={[{ value: "", label: "Select order…" }, ...ready.map((o) => ({ value: o.id, label: `${o.invoice_number} — ${o.customer_name}` }))]} />
        <Field label="Courier" value={form.deliverer_id} onChange={(v) => setForm((f) => ({ ...f, deliverer_id: v }))}
          options={[{ value: "", label: deliverers.filter((d) => d.is_active).length ? "Unassigned" : "No couriers yet — add one below" }, ...deliverers.filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name })), { value: "__other__", label: "+ Other courier (not in the list)" }]} />
        {form.deliverer_id === "__other__" && (
          <Field label="Other courier name" value={otherCourier} onChange={setOtherCourier} placeholder="e.g. Lalamove, GDex, own driver…" required />
        )}
        <Field label="Tracking number" value={form.tracking_no} onChange={(v) => setForm((f) => ({ ...f, tracking_no: v }))} placeholder="Courier tracking no (optional)" />
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
              <div><span style={{ color: C.text3 }}>Courier: </span>{confirmDeliver.delivery_man_name || "Unassigned"}</div>
              {confirmDeliver.tracking_no && <div><span style={{ color: C.text3 }}>Tracking: </span>{confirmDeliver.tracking_no}</div>}
              <div><span style={{ color: C.text3 }}>Scheduled: </span>{confirmDeliver.scheduled_date ? fmtDay(confirmDeliver.scheduled_date) : "—"}</div>
            </div>
            <div style={{ fontSize: 12.5, color: C.text3, marginBottom: 16 }}>This marks the order delivered and moves it out of Pending. This can't be undone.</div>
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
            <Field label="Courier" value={editForm.deliverer_id} onChange={(v) => setEditForm((f) => ({ ...f, deliverer_id: v }))}
              options={[{ value: "", label: "Unassigned" }, ...deliverers.filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name })), { value: "__other__", label: "+ Other courier (not in the list)" }]} />
            {editForm.deliverer_id === "__other__" && (
              <Field label="Other courier name" value={editOther} onChange={setEditOther} placeholder="e.g. Lalamove, GDex, own driver…" required />
            )}
            <Field label="Tracking number" value={editForm.tracking_no} onChange={(v) => setEditForm((f) => ({ ...f, tracking_no: v }))} placeholder="Courier tracking no (optional)" />
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
          <span style={{ fontSize: 13, color: C.text3 }}>Visible to Admin &amp; Production Lead</span>
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
  const [statusF, setStatusF] = useState("");
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
    (!roleF || u.role === roleF) &&
    (!statusF || (statusF === "active" ? u.is_active : !u.is_active))
  );
  const ctrl = { padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13 };
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
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} style={ctrl}>
          <option value="" style={{ background: C.bg2 }}>All status</option>
          <option value="active" style={{ background: C.bg2 }}>Active</option>
          <option value="disabled" style={{ background: C.bg2 }}>Disabled</option>
        </select>
        <span style={{ fontSize: 12.5, color: C.text3 }}>{filtered.length} of {list.length}</span>
        <Btn onClick={() => setShow(true)} style={{ marginLeft: "auto" }}><Icon name="plus" size={15} /> Add user</Btn>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead><tr style={{ background: C.bg2 }}>{["User", "Email", "Role", "Status", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={5}><Empty label="No users match these filters." /></td></tr>}
            {filtered.map((u) => (
              <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}` }}>
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
            ))}
          </tbody>
        </table>
      </Card>
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

  useEffect(() => { api("GET", "/settings").then(setS).catch(() => setS({})); }, []);
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
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: `radial-gradient(900px 500px at 50% -10%, ${C.accent}18, transparent), ${C.bg}` }}>
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
  useEffect(() => {
    if (!user) return;
    const poll = () => api("GET", "/notifications?unread_only=1").then((d) => setUnread(d.unread_count || 0)).catch(() => {});
    poll(); const t = setInterval(poll, 30000); return () => clearInterval(t);
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
  const canCreate = ["super_admin", "operations_controller"].includes(user.role);
  const [title, subtitle] = PAGE_META[page] || ["", ""];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg }}>
      {/* Mobile sidebar backdrop */}
      {isMobile && navOpen && <div onClick={() => setNavOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 1250 }} />}
      {/* Sidebar */}
      <aside style={{ width: 248, background: C.bg2, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", ...(isMobile ? { position: "fixed", top: 0, left: 0, height: "100vh", zIndex: 1300, transform: navOpen ? "translateX(0)" : "translateX(-110%)", transition: "transform .22s ease", boxShadow: navOpen ? "0 0 50px rgba(0,0,0,.6)" : "none" } : { position: "sticky", top: 0, height: "100vh" }) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "20px 20px 18px" }}>
          <Logo size={38} />
          <div><div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: 0.4 }}>WAWASAN</div><div style={{ fontSize: 10.5, fontWeight: 600, color: C.text3, letterSpacing: 1.5 }}>CANDLE</div></div>
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.text3, letterSpacing: 1.5, padding: "6px 22px" }}>WORKSPACE</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 12px", overflowY: "auto", flex: 1 }}>
          {nav.map((n) => {
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => { setPage(n.id); setNavOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderRadius: 9, border: "none", cursor: "pointer", background: active ? C.accent + "1c" : "transparent", color: active ? C.accent : C.text2, fontSize: 13.5, fontWeight: active ? 700 : 500, textAlign: "left", borderLeft: active ? `2px solid ${C.accent}` : "2px solid transparent" }}>
                <Icon name={n.icon} size={18} color={active ? C.accent : C.text3} />
                <span style={{ flex: 1 }}>{n.label}</span>
                {n.id === "board" && boardCount != null && <span style={{ background: active ? C.accent + "33" : C.surface2, color: active ? C.accent : C.text3, borderRadius: 6, padding: "0 7px", fontSize: 12, fontWeight: 700 }}>{boardCount}</span>}
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
            {page === "board" && (
              <div style={{ position: "relative", width: 260, maxWidth: "30vw" }}>
                <span style={{ position: "absolute", left: 11, top: 9 }}><Icon name="search" size={15} color={C.text3} /></span>
                <input type="search" name="board-search" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice, customer…" style={{ width: "100%", padding: "8px 12px 8px 34px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5, outline: "none" }} />
              </div>
            )}
            {canCreate && <Btn onClick={() => setShowCreate(true)}><Icon name="plus" size={15} /> New Order</Btn>}
            <button onClick={() => { setShowNotifs((s) => !s); }} style={{ position: "relative", width: 38, height: 38, display: "grid", placeItems: "center", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, cursor: "pointer", color: C.text2 }}>
              <Icon name="bell" size={17} color={C.text2} />
              {unread > 0 && <span style={{ position: "absolute", top: -5, right: -5, minWidth: 17, height: 17, padding: "0 4px", background: C.danger, color: "#fff", borderRadius: 9, fontSize: 10.5, fontWeight: 700, display: "grid", placeItems: "center" }}>{unread}</span>}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 9, paddingLeft: 12, borderLeft: `1px solid ${C.border}` }}>
              <Avatar name={user.name} color={user.avatar_color} size={32} />
              <div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{user.name}</div><div style={{ fontSize: 11, color: C.text3 }}>{ROLE_LABELS[user.role]}</div></div>
            </div>
          </div>
        </header>

        {page === "board" && (
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
          {page === "board" && <OrderBoard user={user} search={search} weekOnly={weekOnly} statusFilter={statusFilter} refreshKey={boardKey} onOpenOrder={(o) => setSelectedOrder(o.id)} onCount={setBoardCount} />}
          {page === "dashboard" && <Dashboard onOpenOrder={(id) => setSelectedOrder(id)} />}
          {page === "delivery" && <Delivery user={user} onOpenOrder={(id) => setSelectedOrder(id)} />}
          {page === "reports" && <Reports user={user} />}
          {page === "remarks" && <Remarks user={user} />}
          {page === "audit" && <Audit />}
          {page === "users" && <Users user={user} />}
          {page === "settings" && <Settings />}
        </main>
      </div>

      {showNotifs && <NotificationsPanel onClose={() => setShowNotifs(false)} onChanged={() => setUnread(0)} />}

      <Modal open={!!selectedOrder} onClose={() => setSelectedOrder(null)} title="Order detail" width={640}>
        {selectedOrder && <OrderDetail orderId={selectedOrder} user={user} onUpdated={bumpBoard} />}
      </Modal>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create new order" width={620}>
        <CreateOrderForm onCreated={() => { setShowCreate(false); bumpBoard(); }} onClose={() => setShowCreate(false)} />
      </Modal>
    </div>
  );
}
