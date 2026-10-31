// Shared UI: runs inside the Tauri app (talking to its built-in server or a
// deployed one) and in a browser when served by the server itself.
"use strict";

const TAURI = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const REASON_LABELS = {
  IN_CITY_PDFS: "Building on city list",
  UNEVEN_PRICE: "Uneven price",
  RENT_STABILIZED_TEXT_IN_LISTING: "Says so in description",
};
const SHORT = { IN_CITY_PDFS: "Building", UNEVEN_PRICE: "Price", RENT_STABILIZED_TEXT_IN_LISTING: "Description" };

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = { base: null, page: 1, pages: 1, hoods: [], beds: "", allHoods: [], wasSyncing: false };

// ---- connection ---------------------------------------------------------

async function resolveBase() {
  const mode = store.get("mode", "local");
  if (mode === "remote") return store.get("remoteUrl", "").replace(/\/+$/, "") || null;
  if (TAURI) return await TAURI.core.invoke("local_server_url");
  return location.origin; // served by the server
}

function headers() {
  const key = store.get("apiKey", "");
  return key ? { "x-api-key": key } : {};
}

async function api(path, opts = {}) {
  if (!state.base) throw new Error("No server configured");
  const res = await fetch(state.base + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---- formatting ---------------------------------------------------------

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
function layout(l) {
  const parts = [];
  if (l.beds === 0) parts.push("Studio");
  else if (l.beds != null) parts.push(`${l.beds} bd`);
  if (l.baths != null) parts.push(`${l.baths} ba`);
  if (l.sqft) parts.push(typeof l.sqft === "number" ? `${l.sqft} ft²` : String(l.sqft));
  return parts.join(" · ");
}
function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function badge(reason, extraClass = "") {
  const el = document.createElement("span");
  el.className = `badge ${reason} ${extraClass}`;
  el.textContent = REASON_LABELS[reason] || reason;
  return el;
}

function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return; // listing data is untrusted
  if (TAURI?.opener) TAURI.opener.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

// ---- listings -----------------------------------------------------------

function query() {
  const p = new URLSearchParams();
  if (state.hoods.length) p.set("neighborhood", state.hoods.join(","));
  if (state.beds !== "") p.set("beds", state.beds);
  if ($("min").value) p.set("minPrice", $("min").value);
  if ($("max").value) p.set("maxPrice", $("max").value);
  if ($("reason").value) p.set("reason", $("reason").value);
  if ($("unflagged").checked) p.set("all", "1");
  p.set("page", state.page);
  const path = $("delisted").checked ? "/api/listings/history" : "/api/listings";
  return `${path}?${p}`;
}

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  try {
    const { data, pagination } = await api(query());
    if (seq !== loadSeq) return; // a newer request superseded this one
    render(data, pagination);
  } catch (e) {
    if (seq !== loadSeq) return;
    $("grid").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: e.message }));
    $("summary").textContent = "";
    $("pager").hidden = true;
    if (e.status === 401) openSettings("This server needs an API key.");
  }
}

function render(data, pg) {
  state.pages = pg.pages || 1;
  const from = pg.total ? (pg.page - 1) * pg.limit + 1 : 0;
  $("summary").textContent = pg.total
    ? `${pg.total.toLocaleString()} listings · showing ${from}–${from + data.length - 1}`
    : "";
  const grid = $("grid");
  if (!data.length) {
    grid.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "No listings match these filters." }));
  } else {
    const tpl = $("card-tpl").content;
    grid.replaceChildren(...data.map((l) => {
      const card = tpl.firstElementChild.cloneNode(true);
      card.querySelector(".price").textContent = money(l.price);
      card.querySelector(".layout").textContent = layout(l);
      card.querySelector(".hood").textContent = l.neighborhood || "";
      card.querySelector(".addr").textContent = l.address || "";
      const badges = card.querySelector(".badges");
      if (l.reasons.length) badges.append(...l.reasons.map((r) => badge(r)));
      else badges.append(Object.assign(document.createElement("span"), { className: "badge plain", textContent: "Not flagged" }));
      const meta = [];
      if (l.status === "DELISTED") { card.classList.add("gone"); meta.push(`Delisted ${day(l.delisted_at)}`); }
      else meta.push(`First seen ${day(l.first_seen)}`);
      if (!sameSet(l.reasons, l.reasier_reasons)) {
        meta.push(l.reasier_reasons.length ? `Reasier: ${l.reasier_reasons.map((r) => SHORT[r] || r).join(", ")}` : "Reasier: not flagged");
      }
      card.querySelector(".meta").textContent = meta.join(" · ");
      card.addEventListener("click", () => showDetail(l.url));
      card.addEventListener("keydown", (ev) => { if (ev.key === "Enter") showDetail(l.url); });
      return card;
    }));
  }
  $("pager").hidden = state.pages <= 1;
  $("page-label").textContent = `Page ${pg.page} of ${state.pages}`;
  $("prev").disabled = pg.page <= 1;
  $("next").disabled = pg.page >= state.pages;
}

async function showDetail(url) {
  const body = $("detail-body");
  body.textContent = "Loading…";
  $("detail").showModal();
  try {
    const { data } = await api(`/api/listings/history/v2?all=1&url=${encodeURIComponent(url)}`);
    const l = data[0];
    if (!l) { body.textContent = "Listing not found."; return; }
    const head = document.createElement("div");
    head.className = "detail-head";
    const h = document.createElement("h2");
    h.textContent = `${money(l.price)} · ${l.neighborhood || ""}`;
    const open = Object.assign(document.createElement("button"), { className: "btn", textContent: "Open on StreetEasy" });
    open.addEventListener("click", () => openExternal(l.url));
    head.append(h, open);

    const sub = Object.assign(document.createElement("div"), { className: "addr", textContent: `${l.address} · ${layout(l)}` });
    const badges = Object.assign(document.createElement("div"), { className: "badges" });
    badges.append(...(l.reasons.length ? l.reasons.map((r) => badge(r)) : [Object.assign(document.createElement("span"), { className: "badge plain", textContent: "Not flagged" })]));
    const cmp = Object.assign(document.createElement("p"), { className: "compare" });
    cmp.textContent = sameSet(l.reasons, l.reasier_reasons)
      ? "Reasier flags this listing the same way."
      : `Reasier's flags: ${l.reasier_reasons.length ? l.reasier_reasons.map((r) => REASON_LABELS[r] || r).join(", ") : "none"}.` +
        (l.bbl ? ` City tax lot (BBL): ${l.bbl}.` : "");

    const hist = document.createElement("table");
    hist.className = "hist";
    const thead = hist.createTHead().insertRow();
    for (const t of ["Seen", "Price", "Days on market"]) thead.append(Object.assign(document.createElement("th"), { textContent: t }));
    const tb = hist.createTBody();
    for (const s of l.data) {
      const r = tb.insertRow();
      r.insertCell().textContent = new Date(s.scraped_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
      r.insertCell().textContent = money(s.price);
      r.insertCell().textContent = s.time_on_market ?? "—";
    }
    const h3 = (t) => Object.assign(document.createElement("h3"), { textContent: t, style: "font-size:14px;margin:16px 0 6px" });
    const desc = Object.assign(document.createElement("div"), { className: "desc", textContent: l.description || "No description." });
    body.replaceChildren(head, sub, badges, cmp, h3("Description"), desc, h3(`Price history (${l.data.length})`), hist);
  } catch (e) {
    body.textContent = e.message;
  }
}

// ---- status / sync ------------------------------------------------------

let healthTimer;
async function refreshHealth() {
  clearTimeout(healthTimer);
  const el = $("status");
  let next = 60000;
  try {
    const res = await fetch(state.base + "/healthz");
    const h = await res.json();
    const s = h.health;
    if (s.syncing) { el.textContent = `${h.listings} listings · syncing…`; next = 2000; }
    else {
      el.textContent = `${h.listings} listings · synced ${ago(s.last_sync_at)}`;
      if (s.last_error) {
        el.append(" · ", Object.assign(document.createElement("span"), { className: "err", textContent: "last sync failed" }));
        el.title = s.last_error;
      } else el.title = "";
    }
    if (state.wasSyncing && !s.syncing) { load(); loadHoods(); }
    state.wasSyncing = s.syncing;
    $("sync").disabled = s.syncing;
  } catch {
    el.replaceChildren(Object.assign(document.createElement("span"), { className: "err", textContent: "Can't reach the server" }));
    next = 10000;
  }
  healthTimer = setTimeout(refreshHealth, next);
}

async function syncNow() {
  $("sync").disabled = true;
  try { await api("/api/sync", { method: "POST" }); state.wasSyncing = true; }
  catch (e) { $("status").textContent = e.message; }
  setTimeout(refreshHealth, 500);
}

// ---- filters ------------------------------------------------------------

async function loadHoods() {
  try {
    const { data } = await api("/api/listings/neighborhoods");
    state.allHoods = data;
    $("hoods").replaceChildren(...data.map((h) => Object.assign(document.createElement("option"), { value: h })));
  } catch { /* shown by load() */ }
}

function renderChips() {
  $("hood-chips").replaceChildren(...state.hoods.map((h) => {
    const c = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: h });
    c.setAttribute("aria-label", `Remove ${h}`);
    c.addEventListener("click", () => { state.hoods = state.hoods.filter((x) => x !== h); renderChips(); refilter(); });
    return c;
  }));
}

function addHood() {
  const input = $("hood-input");
  const v = state.allHoods.find((h) => h.toLowerCase() === input.value.trim().toLowerCase());
  if (v && !state.hoods.includes(v)) { state.hoods.push(v); renderChips(); refilter(); }
  if (v) input.value = "";
}

let debounce;
function refilter() {
  state.page = 1;
  clearTimeout(debounce);
  debounce = setTimeout(load, 200);
}

// ---- settings -----------------------------------------------------------

function openSettings(msg = "") {
  const mode = store.get("mode", "local");
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  $("remote-url").value = store.get("remoteUrl", "");
  $("remote-key").value = store.get("apiKey", "");
  $("settings-msg").textContent = msg;
  $("settings-msg").className = "hint" + (msg ? " err" : "");
  toggleRemote();
  if (!$("settings").open) $("settings").showModal();
}
function toggleRemote() {
  $("remote-fields").hidden = document.querySelector("input[name=mode]:checked")?.value !== "remote" && !!TAURI;
}

async function testConnection() {
  const msg = $("settings-msg");
  const remote = document.querySelector("input[name=mode]:checked").value === "remote";
  const base = remote ? $("remote-url").value.trim().replace(/\/+$/, "") : await resolveBase();
  msg.className = "hint"; msg.textContent = "Testing…";
  try {
    const key = $("remote-key").value;
    const res = await fetch(`${base}/api/listings/neighborhoods`, { headers: key ? { "x-api-key": key } : {} });
    if (res.status === 401) throw new Error("Wrong or missing API key");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    msg.textContent = `Connected · ${data.length} neighborhoods`;
  } catch (e) {
    msg.className = "hint err"; msg.textContent = `Couldn't connect: ${e.message}`;
  }
}

// ---- wire up ------------------------------------------------------------

async function connect() {
  try { state.base = await resolveBase(); } catch { state.base = null; }
  if (!state.base) {
    $("status").replaceChildren(Object.assign(document.createElement("span"), { className: "err", textContent: "No server available" }));
    openSettings("The built-in server didn't start. Point the app at your deployed server instead.");
    return;
  }
  refreshHealth();
  loadHoods();
  load();
}

$("filters").addEventListener("submit", (e) => e.preventDefault());
$("hood-input").addEventListener("change", addHood);
$("hood-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addHood(); } });
$("beds").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of $("beds").children) x.classList.toggle("on", x === b);
  state.beds = b.dataset.v;
  refilter();
});
for (const id of ["min", "max"]) $(id).addEventListener("input", refilter);
for (const id of ["reason", "delisted", "unflagged"]) $(id).addEventListener("change", refilter);
$("prev").addEventListener("click", () => { state.page--; load(); scrollTo({ top: 0 }); });
$("next").addEventListener("click", () => { state.page++; load(); scrollTo({ top: 0 }); });
$("sync").addEventListener("click", syncNow);
$("open-settings").addEventListener("click", () => openSettings());
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", toggleRemote));
$("test").addEventListener("click", testConnection);
$("settings-form").addEventListener("submit", () => {
  store.set("mode", document.querySelector("input[name=mode]:checked").value);
  store.set("remoteUrl", $("remote-url").value.trim());
  store.set("apiKey", $("remote-key").value);
  connect();
});
if (!TAURI) {
  // In a browser the page's own server is "built-in"; only the key matters.
  document.querySelector("input[name=mode][value=local]").parentElement.lastChild.textContent = " This server";
}

connect();
