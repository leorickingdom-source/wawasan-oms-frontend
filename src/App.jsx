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
const STAGE_LABELS = {
  ...STAGES, on_hold: { label: "On Hold", color: C.hold },
  delivered: { label: "Delivered", color: C.text3 }, cancelled: { label: "Cancelled", color: "#6b7280" },
};
const ROLE_LABELS = {
  super_admin: "Super Admin", operations_controller: "Ops Controller",
  production_lead: "Production Lead", production_staff: "Production Staff",
  packing_staff: "Packing Staff", delivery_team: "Delivery Team",
};

const NAV = [
  { id: "board", label: "Order Board", icon: "board", roles: null },
  { id: "floor", label: "Floor Display", icon: "display", roles: null },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", roles: ["super_admin", "operations_controller"] },
  { id: "delivery", label: "Delivery", icon: "truck", roles: ["super_admin", "operations_controller", "delivery_team"] },
  { id: "reports", label: "Reports", icon: "chart", roles: ["super_admin", "operations_controller"] },
  { id: "remarks", label: "Production Remarks", icon: "message", roles: ["super_admin", "production_lead"] },
  { id: "audit", label: "Audit Trail", icon: "audit", roles: ["super_admin"] },
  { id: "users", label: "User Management", icon: "users", roles: ["super_admin"] },
  { id: "settings", label: "System Settings", icon: "settings", roles: ["super_admin"] },
];
const PAGE_META = {
  board: ["Order Board", "Live Kanban — Order → Production → Packing → Ready for Delivery"],
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
function initials(name = "") {
  return name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "?";
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
function IconBtn({ icon, onClick, title, color = C.text2, bg = C.surface2, border = C.border2, size = 34 }) {
  return (
    <button title={title} onClick={onClick} style={{ width: size, height: size, display: "grid", placeItems: "center", borderRadius: 8, border: `1px solid ${border}`, background: bg, color, cursor: "pointer" }}>
      <Icon name={icon} size={16} color={color} />
    </button>
  );
}
function Modal({ open, onClose, title, children, width = 560 }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 16, padding: "22px 24px", width, maxWidth: "96vw", boxShadow: "0 30px 80px rgba(0,0,0,.55)", animation: "wws-fade .15s ease" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.text3, display: "grid", placeItems: "center" }}><Icon name="x" size={20} color={C.text3} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, value, onChange, type = "text", options, placeholder, required, min }) {
  const st = { width: "100%", padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text, outline: "none" };
  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      {label && <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.text2, marginBottom: 5 }}>{label}{required && <span style={{ color: C.danger }}> *</span>}</span>}
      {options
        ? <select value={value} onChange={(e) => onChange(e.target.value)} style={st}>{options.map((o) => <option key={o.value ?? o} value={o.value ?? o} style={{ background: C.bg2 }}>{o.label ?? o}</option>)}</select>
        : <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} min={min} style={st} />}
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
function KanbanCard({ order, canMove, onOpen, onAdvance }) {
  const stage = STAGES[order.stage] || { color: C.text3 };
  const cd = countdown(order.required_delivery_date);
  const late = (daysUntil(order.required_delivery_date) ?? 0) < 0;
  const urgent = order.priority === "urgent";
  const onHold = !!order.on_hold;
  const waiting = !!order.waiting_stock;
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
          {waiting && <Pill color={C.danger}>⚠ Waiting stock</Pill>}
          {onHold && <Pill color={C.hold}>On hold</Pill>}
          {urgent && <Pill color={C.danger}>Urgent</Pill>}
          {order.skip_production && <Pill color={C.accent} bg="transparent">skip-prod</Pill>}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "7px 0 4px", fontSize: 12.5 }}>
        <Icon name="clock" size={13} color={cd.tone} />
        <span style={{ color: C.text2 }}>{fmtDay(order.required_delivery_date)}</span>
        {cd.text && <span style={{ color: cd.tone, fontWeight: 600 }}>· {cd.text}</span>}
      </div>
      <div style={{ fontSize: 13, color: C.text, fontWeight: 500, marginBottom: 3 }}>{order.customer_name}</div>
      <div style={{ fontSize: 12, color: C.text3, marginBottom: 5 }}>
        {order.total_units != null ? `${order.total_units} units · ` : ""}{order.item_count} {order.item_count === 1 ? "line" : "lines"}
      </div>
      {(order.stage === "production" || order.stage === "packing") && order.item_count > 0 && (
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: (order.made_count || 0) >= order.item_count ? C.ready : C.accent }}>
          {(order.made_count || 0) >= order.item_count ? "All SKUs made ✓" : `${order.made_count || 0}/${order.item_count} SKUs made — in progress`}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: `1px solid ${C.border}`, paddingTop: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {order.pic_name
            ? <><Avatar name={order.pic_name} color={order.pic_color} size={23} /><span style={{ fontSize: 12.5, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{order.pic_name}</span></>
            : <span style={{ fontSize: 12, color: C.text3 }}>Unassigned</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {canMove && !order.on_hold && <IconBtn icon="arrowRight" onClick={() => onAdvance(order, next)} title={`Advance to ${(STAGE_LABELS[next] || {}).label || next}`} color={C.ready} bg="#13301f" border="#1f5036" />}
          <IconBtn icon="dots" onClick={() => onOpen(order)} title="Details & actions" />
        </div>
      </div>
    </div>
  );
}

// ─── Order Board ───────────────────────────────────────────────────────────────
function OrderBoard({ user, search, weekOnly, onOpenOrder, refreshKey, onCount }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const canMove = ["super_admin", "operations_controller"].includes(user.role);

  async function load() {
    setLoading(true); setErr("");
    try {
      const d = await api("GET", `/orders/kanban${weekOnly ? "?week=current" : ""}`);
      setBoard(d);
      onCount && onCount(BOARD_STAGES.reduce((a, s) => a + (d[s] ? d[s].length : 0), 0));
    } catch (e) { setErr(e.message); setBoard({ order: [], production: [], packing: [], ready_for_delivery: [], on_hold: [] }); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [weekOnly, refreshKey]);

  async function advance(order, to) {
    try { await api("POST", `/orders/${order.id}/move`, { to_stage: to }); load(); }
    catch (e) { alert(e.message); }
  }
  const filt = (arr) => {
    const q = search.trim().toLowerCase();
    if (!q) return arr;
    return arr.filter((o) => o.invoice_number.toLowerCase().includes(q) || (o.customer_name || "").toLowerCase().includes(q));
  };

  if (loading && !board) return <Loading label="Loading board…" />;

  return (
    <div>
      {err && <div style={{ marginBottom: 14, color: "#fca5a5", fontSize: 13 }}>⚠ {err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(230px, 1fr))", gap: 16, alignItems: "start" }}>
        {BOARD_STAGES.map((s) => {
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
                {orders.map((o) => <KanbanCard key={o.id} order={o} canMove={canMove} onOpen={onOpenOrder} onAdvance={advance} />)}
                {orders.length === 0 && <Empty label="No orders" />}
              </div>
            </div>
          );
        })}
      </div>
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
  const [now, setNow] = useState(new Date());
  const [spotIdx, setSpotIdx] = useState(0);
  const [detail, setDetail] = useState(null);
  const cache = useRef({});

  async function load() {
    try {
      const [b, s] = await Promise.all([api("GET", "/orders/kanban"), api("GET", "/orders/stats")]);
      setBoard(b); setStats(s);
    } catch (e) { /* keep last */ }
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
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
                    return (
                      <div key={o.id} style={{ background: C.surface, border: `1px solid ${urgent || late ? C.danger + "55" : C.border}`, borderLeft: `3px solid ${cfg.color}`, borderRadius: 9, padding: "9px 11px" }}>
                        <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: late ? C.danger : urgent ? C.accent2 : C.text }}>{o.invoice_number}</div>
                        {(o.waiting_stock || o.on_hold) && (
                          <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
                            {o.waiting_stock && <Pill color={C.danger} style={{ fontSize: 9.5, padding: "1px 6px" }}>⚠ Stock</Pill>}
                            {o.on_hold && <Pill color={C.hold} style={{ fontSize: 9.5, padding: "1px 6px" }}>Hold</Pill>}
                          </div>
                        )}
                        <div style={{ fontSize: 12.5, color: cd.tone, marginTop: 3 }}>
                          <span style={{ color: C.text2 }}>{fmtDay(o.required_delivery_date)}</span> · {cd.text}{urgent ? " · URGENT" : ""}
                        </div>
                        <div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{o.total_units != null ? `${o.total_units} units` : `${o.item_count} lines`}</div>
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
                <Pill color={spotStage.color} style={{ fontSize: 12, padding: "4px 10px" }}>● {spotStage.label}</Pill>
                <span style={{ fontSize: 14, color: C.text3 }}>{(spotIdx % pool.length) + 1} / {pool.length}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 52, fontWeight: 800, color: C.accent2, margin: "10px 0 6px", lineHeight: 1 }}>{spot.invoice_number}</div>
              <div style={{ fontSize: 15, color: C.text2, marginBottom: 8 }}>{spot.customer_name}</div>
              <div style={{ flex: 1, overflowY: "auto" }}>
                {detail && detail.id === spot.id
                  ? (detail.items || []).map((it) => (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 0", borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: it.made ? C.green : C.accent, boxShadow: `0 0 8px ${it.made ? C.green : C.accent}`, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.text3, letterSpacing: 0.5 }}>{it.sku}</div>
                        <div style={{ fontSize: 19, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <span style={{ fontSize: 42, fontWeight: 800, color: it.made ? C.green : C.accent2, lineHeight: 1 }}>{Math.round(it.quantity)}</span>
                        <span style={{ fontSize: 14, color: C.text3, marginLeft: 5 }}>{it.unit || "pcs"}{it.made ? " ✓" : ""}</span>
                      </div>
                    </div>
                  ))
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
  const [tab, setTab] = useState("details");
  const [moveStage, setMoveStage] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const canMove = ["super_admin", "operations_controller"].includes(user.role);
  const canMark = ["super_admin", "operations_controller", "production_lead", "production_staff", "packing_staff"].includes(user.role);

  async function load() { try { setOrder(await api("GET", `/orders/${orderId}`)); } catch (e) { setOrder({ _error: e.message }); } }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  async function doMove(to, why) {
    if (!to) return;
    setBusy(true);
    try { await api("POST", `/orders/${orderId}/move`, { to_stage: to, reason: why || undefined }); setMoveStage(""); setReason(""); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function toggleMade(it) {
    try { await api("PATCH", `/orders/${orderId}/items/${it.id}`, { made: !it.made }); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }
  async function setFlag(body) {
    try { await api("PATCH", `/orders/${orderId}/flags`, body); await load(); onUpdated && onUpdated(); }
    catch (e) { alert(e.message); }
  }

  if (!order) return <Loading />;
  if (order._error) return <div style={{ color: "#fca5a5" }}>⚠ {order._error}</div>;
  const cfg = STAGE_LABELS[order.stage] || { label: order.stage, color: C.text3 };
  const tabs = ["details", "timeline", "items", "attachments"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: C.text }}>{order.invoice_number}</span>
        <Pill color={cfg.color}>{cfg.label}</Pill>
        {order.waiting_stock && <Pill color={C.danger}>⚠ Waiting stock</Pill>}
        {order.on_hold && <Pill color={C.hold}>On hold</Pill>}
        {order.priority === "urgent" && <Pill color={C.danger}>Urgent</Pill>}
        {order.skip_production && <Pill color={C.accent} bg="transparent">skip-prod</Pill>}
      </div>
      <div style={{ fontSize: 13, color: C.text3, marginBottom: 16 }}>{order.created_by_name ? `Created by ${order.created_by_name}` : ""} {order.order_date ? `· ${fmtDay(order.order_date)}` : ""}</div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", padding: "8px 13px", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? C.accent : C.text2, borderBottom: `2px solid ${tab === t ? C.accent : "transparent"}`, textTransform: "capitalize" }}>{t}</button>
        ))}
      </div>

      {tab === "details" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <LV label="Customer" v={order.customer_name} />
          <LV label="Contact" v={order.customer_contact || "—"} />
          <LV label="Delivery" v={<span style={{ color: countdown(order.required_delivery_date).tone }}>{fmtDay(order.required_delivery_date)} · {countdown(order.required_delivery_date).text}</span>} />
          <LV label="Expiry" v={order.expiry_date ? fmtDay(order.expiry_date) : "—"} />
          <LV label="PIC" v={order.pic_name ? <span style={{ display: "inline-flex", gap: 7, alignItems: "center" }}><Avatar name={order.pic_name} color={order.pic_color} size={22} />{order.pic_name}</span> : "Unassigned"} />
          <LV label="Source" v={order.source === "sql_account" ? "SQL Account" : "Manual"} />
          {order.notes && <div style={{ gridColumn: "span 2" }}><LV label="Notes" v={order.notes} /></div>}
        </div>
      )}
      {tab === "timeline" && (
        <div>
          {(order.activity || []).length === 0 && <Empty label="No activity yet." />}
          {(order.activity || []).map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 11, marginBottom: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, marginTop: 6, flexShrink: 0 }} />
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{a.user_name}</span>
                <span style={{ fontSize: 13, color: C.text2 }}> — {a.details || a.action}</span>
                <div style={{ fontSize: 11.5, color: C.text3 }}>{new Date(a.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === "items" && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>{["SKU", "Product", "Qty", "Unit", "Made"].map((h) => <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: C.text3, borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {(order.items || []).map((it) => (
              <tr key={it.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "8px 10px", fontFamily: MONO, color: C.text2 }}>{it.sku}</td>
                <td style={{ padding: "8px 10px", color: C.text }}>{it.name}</td>
                <td style={{ padding: "8px 10px", fontWeight: 700, color: C.text }}>{Math.round(it.quantity)}</td>
                <td style={{ padding: "8px 10px", color: C.text3 }}>{it.unit}</td>
                <td style={{ padding: "8px 10px" }}>
                  {canMark
                    ? <button onClick={() => toggleMade(it)} style={{ cursor: "pointer", border: `1px solid ${it.made ? C.green + "66" : C.border2}`, background: it.made ? C.green + "1f" : C.surface2, color: it.made ? C.green : C.text3, borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>{it.made ? "✓ Made" : "Mark"}</button>
                    : (it.made ? <span style={{ color: C.green }}>✓</span> : <span style={{ color: C.text3 }}>—</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "attachments" && (
        <div>
          {(order.attachments || []).length === 0 && <Empty label="No attachments." />}
          {(order.attachments || []).map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
              <Icon name="message" size={15} color={C.text3} />
              <span style={{ fontSize: 13, color: C.text }}>{a.original_name}</span>
              <span style={{ fontSize: 11.5, color: C.text3 }}>{a.uploaded_by_name}</span>
            </div>
          ))}
        </div>
      )}

      {canMove && (
        <div style={{ marginTop: 22, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, marginBottom: 8 }}>Stage actions</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <select value={moveStage} onChange={(e) => setMoveStage(e.target.value)} style={{ flex: 1, minWidth: 170, padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text }}>
              <option value="" style={{ background: C.bg2 }}>Move to…</option>
              {Object.keys(STAGE_LABELS).filter((k) => k !== order.stage && k !== "on_hold" && k !== "cancelled").map((k) => <option key={k} value={k} style={{ background: C.bg2 }}>{STAGE_LABELS[k].label}</option>)}
            </select>
            <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 2, minWidth: 160, padding: "9px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, fontSize: 14, color: C.text }} />
            <Btn onClick={() => doMove(moveStage, reason)} disabled={!moveStage || busy}>Confirm</Btn>
          </div>
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
  const [f, setF] = useState({ invoice_number: "", customer_name: "", customer_contact: "", required_delivery_date: "", priority: "normal", skip_production: false, notes: "" });
  const [items, setItems] = useState([{ sku: "", name: "", quantity: 1, unit: "pcs" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    if (!f.invoice_number || !f.customer_name || !f.required_delivery_date) { setErr("Invoice, customer and delivery date are required."); return; }
    setBusy(true); setErr("");
    try { await api("POST", "/orders", { ...f, items: items.filter((i) => i.name) }); onCreated && onCreated(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const inp = { padding: "8px 10px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13, color: C.text };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Invoice Number" value={f.invoice_number} onChange={(v) => set("invoice_number", v)} required placeholder="INV-26-0001" />
        <Field label="Priority" value={f.priority} onChange={(v) => set("priority", v)} options={[{ value: "normal", label: "Normal" }, { value: "urgent", label: "Urgent" }]} />
        <Field label="Customer Name" value={f.customer_name} onChange={(v) => set("customer_name", v)} required />
        <Field label="Contact" value={f.customer_contact} onChange={(v) => set("customer_contact", v)} placeholder="01X-XXXXXXX" />
        <Field label="Required Delivery Date" type="date" value={f.required_delivery_date} onChange={(v) => set("required_delivery_date", v)} required />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text2, marginTop: 26 }}>
          <input type="checkbox" checked={f.skip_production} onChange={(e) => set("skip_production", e.target.checked)} /> Skip production (→ packing)
        </label>
      </div>
      <Field label="Notes" value={f.notes} onChange={(v) => set("notes", v)} placeholder="Optional…" />
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text2, margin: "6px 0 8px" }}>Order Items</div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr 70px 64px 32px", gap: 6, marginBottom: 6 }}>
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
function Dashboard() {
  const [d, setD] = useState(null);
  useEffect(() => { api("GET", "/reports/dashboard").then(setD).catch(() => setD({ _error: true })); }, []);
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
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
            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
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
            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
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

// ─── Reports ─────────────────────────────────────────────────────────────────
function Reports() {
  const [tab, setTab] = useState("production");
  const [period, setPeriod] = useState("weekly");
  const [d, setD] = useState({});
  useEffect(() => { api("GET", `/reports/${tab}?period=${period}`).then(setD).catch(() => setD({})); }, [tab, period]);
  const metrics = {
    production: [["Orders Completed", d.completed], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["Avg Production", d.avg_production_hours ? d.avg_production_hours + "h" : "—"], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"]],
    packing: [["Orders Packed", d.packed], ["Avg Pack Time", d.avg_pack_minutes ? d.avg_pack_minutes + "min" : "—"], ["Rework Rate", d.rework_rate != null ? d.rework_rate + "%" : "—"]],
    delivery: [["Total Deliveries", d.total_deliveries], ["On-Time Rate", d.on_time_rate != null ? d.on_time_rate + "%" : "—"], ["On-Time Count", d.on_time_count]],
  };
  const trend = d.daily_trend || [];
  const maxT = Math.max(...trend.map((t) => t.count), 1);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
          {["production", "packing", "delivery"].map((t) => <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? C.surface2 : "transparent", border: "none", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 700 : 500, color: tab === t ? C.text : C.text2, textTransform: "capitalize" }}>{t}</button>)}
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ padding: "8px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13 }}>
          <option value="daily" style={{ background: C.bg2 }}>Today</option>
          <option value="weekly" style={{ background: C.bg2 }}>This Week</option>
          <option value="monthly" style={{ background: C.bg2 }}>This Month</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14, marginBottom: 20 }}>
        {(metrics[tab] || []).map(([label, value]) => <Card key={label}><div style={{ fontSize: 28, fontWeight: 800, color: C.accent }}>{value ?? "—"}</div><div style={{ fontSize: 12.5, color: C.text3, marginTop: 2 }}>{label}</div></Card>)}
      </div>
      {trend.length > 0 && (
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
    </div>
  );
}

// ─── Delivery ──────────────────────────────────────────────────────────────────
function Delivery({ user }) {
  const [list, setList] = useState(null);
  const [ready, setReady] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ order_id: "", delivery_man_id: "", scheduled_date: "", notes: "" });
  const canAssign = ["super_admin", "operations_controller"].includes(user.role);
  const canDeliver = ["super_admin", "operations_controller", "delivery_team"].includes(user.role);

  async function load() {
    const d = await api("GET", "/delivery").catch(() => []);
    setList(d || []);
    if (canAssign) {
      const o = await api("GET", "/orders?stage=ready_for_delivery&limit=100").catch(() => ({ orders: [] }));
      const u = await api("GET", "/users").catch(() => []);
      const taken = new Set((d || []).filter((x) => x.status !== "delivered" && x.status !== "failed").map((x) => x.order_id));
      setReady((o.orders || []).filter((x) => !taken.has(x.id)));
      setDrivers((u || []).filter((x) => x.is_active && x.role === "delivery_team"));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function assign() {
    if (!form.order_id) { alert("Pick an order to schedule."); return; }
    try {
      await api("POST", "/delivery", form);
      setShow(false); setForm({ order_id: "", delivery_man_id: "", scheduled_date: "", notes: "" });
      load();
    } catch (e) { alert(e.message); }
  }
  async function markDelivered(id) { try { await api("POST", `/delivery/${id}/deliver`, {}); load(); } catch (e) { alert(e.message); } }

  if (!list) return <Loading />;
  const tone = { pending: C.packing, in_transit: C.order, delivered: C.ready, failed: C.danger };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: C.text3 }}>{canAssign ? `${ready.length} order${ready.length === 1 ? "" : "s"} awaiting scheduling` : "Your delivery schedule"}</div>
        {canAssign && <Btn onClick={() => setShow(true)} disabled={ready.length === 0}><Icon name="plus" size={15} /> Schedule delivery</Btn>}
      </div>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead><tr style={{ background: C.bg2 }}>{["Invoice", "Customer", "Driver", "Scheduled", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6}><Empty label="No deliveries scheduled yet." /></td></tr>}
            {list.map((dv) => (
              <tr key={dv.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "11px 16px", fontFamily: MONO, color: C.text }}>{dv.invoice_number}</td>
                <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.customer_name}</td>
                <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.delivery_man_name || "—"}</td>
                <td style={{ padding: "11px 16px", color: C.text2 }}>{dv.scheduled_date ? fmtDay(dv.scheduled_date) : "—"}</td>
                <td style={{ padding: "11px 16px" }}><Pill color={tone[dv.status] || C.text3}>{dv.status}</Pill></td>
                <td style={{ padding: "11px 16px" }}>{canDeliver && dv.status !== "delivered" && <Btn size="sm" variant="success" onClick={() => markDelivered(dv.id)}>Mark delivered</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Modal open={show} onClose={() => setShow(false)} title="Schedule delivery">
        <Field label="Order (ready for delivery)" value={form.order_id} onChange={(v) => setForm((f) => ({ ...f, order_id: v }))}
          options={[{ value: "", label: "Select order…" }, ...ready.map((o) => ({ value: o.id, label: `${o.invoice_number} — ${o.customer_name}` }))]} />
        <Field label="Driver" value={form.delivery_man_id} onChange={(v) => setForm((f) => ({ ...f, delivery_man_id: v }))}
          options={[{ value: "", label: drivers.length ? "Unassigned" : "No delivery-team users yet" }, ...drivers.map((d) => ({ value: d.id, label: d.name }))]} />
        <Field label="Scheduled date" type="date" value={form.scheduled_date} onChange={(v) => setForm((f) => ({ ...f, scheduled_date: v }))} />
        <Field label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} placeholder="Optional…" />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="ghost" onClick={() => setShow(false)}>Cancel</Btn>
          <Btn onClick={assign}>Schedule</Btn>
        </div>
      </Modal>
    </div>
  );
}

// ─── Production remarks ──────────────────────────────────────────────────────
function Remarks({ user }) {
  const [list, setList] = useState(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  function load() { api("GET", "/remarks").then(setList).catch(() => setList([])); }
  useEffect(() => { load(); }, []);
  async function post() { if (!content.trim()) return; setBusy(true); try { await api("POST", "/remarks", { content }); setContent(""); load(); } catch (e) { alert(e.message); } finally { setBusy(false); } }
  const canPost = ["super_admin", "production_lead"].includes(user.role);
  if (!list) return <Loading />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
      {canPost && (
        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>This week's remark</h3>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} placeholder="Production notes for this week…" style={{ width: "100%", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 14, resize: "vertical" }} />
          <div style={{ marginTop: 10, textAlign: "right" }}><Btn onClick={post} disabled={busy}>{busy ? "Posting…" : "Post remark"}</Btn></div>
        </Card>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {list.length === 0 && <Empty label="No remarks yet." />}
        {list.map((r) => (
          <Card key={r.id}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, color: C.text, fontSize: 13.5 }}>{r.author_name}</span>
              <span style={{ color: C.text3, fontSize: 12.5 }}>w/c {fmtDay(r.week_start)}</span>
            </div>
            <div style={{ fontSize: 14, color: C.text2, whiteSpace: "pre-wrap" }}>{r.content}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Audit ─────────────────────────────────────────────────────────────────────
function Audit() {
  const [d, setD] = useState(null);
  useEffect(() => { api("GET", "/reports/audit?limit=100").then(setD).catch(() => setD({ logs: [] })); }, []);
  if (!d) return <Loading />;
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ background: C.bg2 }}>{["When", "User", "Action", "Details", "Invoice"].map((h) => <th key={h} style={{ textAlign: "left", padding: "11px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
        <tbody>
          {(d.logs || []).length === 0 && <tr><td colSpan={5}><Empty label="No audit entries." /></td></tr>}
          {(d.logs || []).map((l) => (
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
  );
}

// ─── Users ───────────────────────────────────────────────────────────────────
function Users({ user }) {
  const [list, setList] = useState(null);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: "", email: "", role: "production_staff", password: "" });
  function load() { api("GET", "/users").then(setList).catch(() => setList([])); }
  useEffect(() => { load(); }, []);
  async function create() { try { await api("POST", "/users", f); setShow(false); setF({ name: "", email: "", role: "production_staff", password: "" }); load(); } catch (e) { alert(e.message); } }
  async function toggle(u) { try { await api("PATCH", `/users/${u.id}`, { is_active: !u.is_active }); load(); } catch (e) { alert(e.message); } }
  if (!list) return <Loading />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}><Btn onClick={() => setShow(true)}><Icon name="plus" size={15} /> Add user</Btn></div>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead><tr style={{ background: C.bg2 }}>{["User", "Email", "Role", "Status", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "12px 16px", color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "11px 16px" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar name={u.name} color={u.avatar_color} size={30} /><span style={{ color: C.text, fontWeight: 500 }}>{u.name}</span></div></td>
                <td style={{ padding: "11px 16px", color: C.text2 }}>{u.email}</td>
                <td style={{ padding: "11px 16px" }}><Pill color={C.text2}>{ROLE_LABELS[u.role] || u.role}</Pill></td>
                <td style={{ padding: "11px 16px" }}><Pill color={u.is_active ? C.ready : C.danger}>{u.is_active ? "Active" : "Disabled"}</Pill></td>
                <td style={{ padding: "11px 16px" }}>{u.id !== user.id && <Btn size="sm" variant="ghost" onClick={() => toggle(u)}>{u.is_active ? "Disable" : "Enable"}</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Modal open={show} onClose={() => setShow(false)} title="Create user">
        <Field label="Full name" value={f.name} onChange={(v) => setF((p) => ({ ...p, name: v }))} required />
        <Field label="Email" type="email" value={f.email} onChange={(v) => setF((p) => ({ ...p, email: v }))} required />
        <Field label="Role" value={f.role} onChange={(v) => setF((p) => ({ ...p, role: v }))} options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))} />
        <Field label="Password" type="password" value={f.password} onChange={(v) => setF((p) => ({ ...p, password: v }))} required />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}><Btn variant="ghost" onClick={() => setShow(false)}>Cancel</Btn><Btn onClick={create}>Create</Btn></div>
      </Modal>
    </div>
  );
}

// ─── Settings ──────────────────────────────────────────────────────────────────
function Settings() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>Workflow stages</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{BOARD_STAGES.map((s) => <Pill key={s} color={STAGES[s].color} style={{ fontSize: 12, padding: "5px 11px" }}>{STAGES[s].label}</Pill>)}</div>
      </Card>
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>Roles</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{Object.values(ROLE_LABELS).map((r) => <Pill key={r} color={C.text2} style={{ fontSize: 12, padding: "5px 11px" }}>{r}</Pill>)}</div>
      </Card>
      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>Session</h3>
        <div style={{ fontSize: 13.5, color: C.text2 }}>Login session timeout: 8 hours · Auth: JWT</div>
      </Card>
      <div style={{ fontSize: 12.5, color: C.text3 }}>Editable stage names, holiday calendar, priorities and SMTP configuration are planned for the next phase.</div>
    </div>
  );
}

// ─── Notifications ─────────────────────────────────────────────────────────────
function NotificationsPanel({ onClose, onChanged }) {
  const [items, setItems] = useState([]);
  useEffect(() => { api("GET", "/notifications").then((d) => setItems(d.notifications || [])).catch(() => setItems([])); }, []);
  async function markAll() { await api("PATCH", "/notifications/read-all").catch(() => {}); setItems((a) => a.map((i) => ({ ...i, is_read: true }))); onChanged && onChanged(); }
  return (
    <div style={{ position: "fixed", top: 64, right: 20, width: 360, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 13, boxShadow: "0 18px 50px rgba(0,0,0,.5)", zIndex: 600, overflow: "hidden" }}>
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
        <Field label="Email" type="email" value={email} onChange={setEmail} required placeholder="you@wawasancandle.com" />
        <Field label="Password" type="password" value={password} onChange={setPassword} required />
        {err && <p style={{ color: "#fca5a5", fontSize: 13, margin: "-4px 0 12px" }}>{err}</p>}
        <Btn type="submit" onClick={() => {}} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Signing in…" : "Sign in"}</Btn>
      </form>
    </div>
  );
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

  function logout() { api("POST", "/auth/logout").catch(() => {}); _token = ""; localStorage.removeItem("oms_token"); setUser(null); }
  function bumpBoard() { setBoardKey((k) => k + 1); }

  if (booting) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: C.text3 }}>Loading…</div>;
  if (!user) return <LoginPage onLogin={setUser} />;

  if (page === "floor") return <FloorDisplay onExit={() => setPage("board")} />;

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  const canCreate = ["super_admin", "operations_controller"].includes(user.role);
  const [title, subtitle] = PAGE_META[page] || ["", ""];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg }}>
      {/* Sidebar */}
      <aside style={{ width: 248, background: C.bg2, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "20px 20px 18px" }}>
          <Logo size={38} />
          <div><div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: 0.4 }}>WAWASAN</div><div style={{ fontSize: 10.5, fontWeight: 600, color: C.text3, letterSpacing: 1.5 }}>CANDLE OMS</div></div>
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.text3, letterSpacing: 1.5, padding: "6px 22px" }}>WORKSPACE</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 12px", overflowY: "auto", flex: 1 }}>
          {nav.map((n) => {
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => setPage(n.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderRadius: 9, border: "none", cursor: "pointer", background: active ? C.accent + "1c" : "transparent", color: active ? C.accent : C.text2, fontSize: 13.5, fontWeight: active ? 700 : 500, textAlign: "left", borderLeft: active ? `2px solid ${C.accent}` : "2px solid transparent" }}>
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
        <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 26px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg + "ee", backdropFilter: "blur(6px)", zIndex: 100 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 19, fontWeight: 800, color: C.text }}>{title}</h1>
            <div style={{ fontSize: 12.5, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {page === "board" && (
              <div style={{ position: "relative", width: 260, maxWidth: "30vw" }}>
                <span style={{ position: "absolute", left: 11, top: 9 }}><Icon name="search" size={15} color={C.text3} /></span>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice, customer…" style={{ width: "100%", padding: "8px 12px 8px 34px", background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 9, color: C.text, fontSize: 13.5, outline: "none" }} />
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
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 26px 0" }}>
            <button onClick={() => setWeekOnly((w) => !w)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: weekOnly ? C.accent + "1c" : C.surface, border: `1px solid ${weekOnly ? C.accent + "55" : C.border2}`, borderRadius: 9, color: weekOnly ? C.accent : C.text2, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <Icon name="calendar" size={15} color={weekOnly ? C.accent : C.text3} /> This week only
            </button>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.text3 }}>Click <Icon name="arrowRight" size={13} color={C.text3} style={{ verticalAlign: "middle" }} /> to advance · ⋮ for details</span>
          </div>
        )}

        <main style={{ flex: 1, padding: "20px 26px 40px", overflowX: "auto" }}>
          {page === "board" && <OrderBoard user={user} search={search} weekOnly={weekOnly} refreshKey={boardKey} onOpenOrder={(o) => setSelectedOrder(o.id)} onCount={setBoardCount} />}
          {page === "dashboard" && <Dashboard />}
          {page === "delivery" && <Delivery user={user} />}
          {page === "reports" && <Reports />}
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
