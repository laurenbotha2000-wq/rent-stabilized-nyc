// Rent Stabilized NYC (hosted): sign-in gate, live listings from Firestore,
// map + list with filters, and per-user saved searches.
import { CONFIG } from "./config.js";
import { createMap } from "./map.js";
import { FEATURES, geocode, hasPrefs, match, placeName } from "./prefs.js";
import { commute, describe, directionsUrl, loadStations, nearby, nearest, stationsReady, allLines } from "./commute.js";

const SDK = "https://www.gstatic.com/firebasejs/11.0.2";
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const LABELS = {
  IN_CITY_PDFS: "Building on city list",
  UNEVEN_PRICE: "Uneven price",
  RENT_STABILIZED_TEXT_IN_LISTING: "Says so in listing",
};
const PAGE = 60;
// Local preview only: read a data file instead of Firestore and skip sign-in.
const DEV = Boolean(CONFIG.devData) && ["localhost", "127.0.0.1"].includes(location.hostname);

const state = {
  listings: [], filtered: [], shown: PAGE, hoods: [], beds: "",
  user: null, searches: [], map: null, fb: null, unsub: [],
  prefs: null, sortTouched: false, events: [],
};

// localStorage can throw (storage blocked, some embedded browsers); treat it as optional
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* not persisted */ } },
};

// ---- screens --------------------------------------------------------------

function show(id) {
  for (const s of ["loading", "login", "verify", "app"]) $(s).hidden = s !== id;
  if (id === "app") state.map?.resize();
}

function message(id, text, isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle("err", isError);
}

// ---- formatting -----------------------------------------------------------

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function layout(l) {
  const p = [];
  if (l.beds === 0) p.push("Studio"); else if (l.beds != null) p.push(`${l.beds} bd`);
  if (l.baths != null) p.push(`${l.baths} ba`);
  if (l.sqft) p.push(typeof l.sqft === "number" ? `${l.sqft} ft²` : String(l.sqft));
  return p.join(" · ");
}
function badges(reasons) {
  const box = el("div", { className: "badges" });
  if (!reasons.length) box.append(el("span", { className: "badge plain", textContent: "Not flagged" }));
  for (const r of reasons) box.append(el("span", { className: `badge ${r}`, textContent: LABELS[r] || r }));
  return box;
}
function openExternal(url) {
  if (/^https:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); // listing data is untrusted
}

// ---- filtering ------------------------------------------------------------

const pressed = (id) => [...$(id).querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.v).filter(Boolean);
function setPressed(id, values) {
  for (const b of $(id).querySelectorAll("button")) {
    const on = b.dataset.v ? values.includes(b.dataset.v) : !values.length; // the "Any" button
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("on", on);
  }
}
const asList = (v) => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]); // older saves held one value

function currentFilters() {
  const f = {};
  if (state.hoods.length) f.hoods = [...state.hoods];
  const beds = pressed("beds"); if (beds.length) f.beds = beds;
  if ($("min").value) f.min = Number($("min").value);
  if ($("max").value) f.max = Number($("max").value);
  const reasons = pressed("reasons"); if (reasons.length) f.reason = reasons;
  const features = pressed("feat-filter"); if (features.length) f.features = features;
  if (state.commuteTo) f.commute = { ...state.commuteTo };
  if ($("walk").value) f.walk = Number($("walk").value);
  const lines = pressed("lines"); if (lines.length) f.lines = lines;
  if ($("delisted").checked) f.delisted = true;
  if ($("unflagged").checked) f.unflagged = true;
  return f;
}

function applyFilters(f) {
  state.hoods = f.hoods ? [...f.hoods] : [];
  setPressed("beds", asList(f.beds));
  setPressed("reasons", asList(f.reason));
  setPressed("feat-filter", asList(f.features));
  setPressed("lines", asList(f.lines));
  $("walk").value = f.walk ? String(f.walk) : "";
  setCommute(f.commute || null, { quiet: true });
  $("min").value = f.min ?? "";
  $("max").value = f.max ?? "";
  $("delisted").checked = !!f.delisted;
  $("unflagged").checked = !!f.unflagged;
  renderChips();
  refresh({ fit: true });
}

function matches(l, f) {
  if (!f.delisted && l.status !== "ACTIVE") return false;
  if (!f.unflagged && !l.reasons.length) return false;
  if (f.hoods && !f.hoods.includes(l.neighborhood)) return false;
  // bedrooms and reasons: any of the picked values; amenities: all of them
  if (f.beds && !(l.beds != null && f.beds.some((b) => (Number(b) === 4 ? l.beds >= 4 : l.beds === Number(b))))) return false;
  if (f.min !== undefined && !(l.price >= f.min)) return false;
  if (f.max !== undefined && !(l.price <= f.max)) return false;
  if (f.reason && !f.reason.some((r) => l.reasons.includes(r))) return false;
  if (f.features && !f.features.every((x) => (l.features || []).includes(x))) return false;
  // subway filters need station data; until it loads they don't exclude anything
  if ((f.walk || f.lines) && stationsReady()) {
    if (l.lat == null) return false;
    const reach = nearby(l, 8, walkMiles(f.walk || 15));
    if (!reach.length) return false;
    if (f.lines && !reach.some((s) => s.routes.some((r) => f.lines.includes(r)))) return false;
  }
  if (f.commute) {
    const c = commuteFor(l, f.commute);
    if (!c || c.minutes > f.commute.minutes) return false;
  }
  return true;
}

/** Miles someone covers walking for `minutes` (same pace as the commute estimates). */
const walkMiles = (minutes) => (minutes / 60) * 3 / 1.25;
const commuteFor = (l, to) => (l.lat == null ? null : commute(l, to));

const SORTS = {
  match: (a, b) => (b._m?.score ?? 0) - (a._m?.score ?? 0) || (b.first_seen || "").localeCompare(a.first_seen || ""),
  newest: (a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""),
  "price-asc": (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  "price-desc": (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
  commute: (a, b) => (a._c?.minutes ?? Infinity) - (b._c?.minutes ?? Infinity),
};

function refresh({ fit = false } = {}) {
  const f = currentFilters();
  const personal = hasPrefs(state.prefs);
  $("matches-only-wrap").hidden = !personal;
  // how many filters are set inside the collapsed "More filters" panel
  const more = ["reason", "features", "walk", "lines", "delisted", "unflagged"].filter((k) => f[k] !== undefined).length;
  $("more-count").hidden = !more;
  $("more-count").textContent = String(more);
  state.filtered = state.listings.filter((l) => {
    if (!matches(l, f)) return false;
    l._c = f.commute ? commuteFor(l, f.commute) : null;
    l._m = personal ? match(l, state.prefs) : null;
    return !(personal && $("matches-only").checked && !l._m.ok);
  });
  $("sort-commute").hidden = !f.commute;
  let sort = $("sort").value;
  if (sort === "match" && !personal) sort = f.commute ? "commute" : "newest";
  if (sort === "commute" && !f.commute) sort = personal ? "match" : "newest";
  state.filtered.sort(SORTS[sort]);
  state.shown = PAGE;
  state.map?.setListings(state.filtered);
  if (fit) state.map?.fit(state.filtered);
  renderList();
  syncSavedSelect();
}

// ---- rendering ------------------------------------------------------------

function renderList() {
  const list = $("list");
  const n = state.filtered.length;
  const mapped = state.filtered.filter((l) => l.lat != null).length;
  $("summary").textContent = n
    ? `${n.toLocaleString()} apartments${mapped < n ? ` · ${n - mapped} not on the map` : ""}`
    : "";
  if (!n) {
    list.replaceChildren(el("div", { className: "empty", textContent: state.listings.length ? "No apartments match these filters." : "No data yet." }));
    $("more").hidden = true;
    return;
  }
  const tpl = $("card-tpl").content.firstElementChild;
  list.replaceChildren(...state.filtered.slice(0, state.shown).map((l) => {
    const card = tpl.cloneNode(true);
    card.querySelector(".price").textContent = money(l.price);
    card.querySelector(".layout").textContent = layout(l);
    card.querySelector(".hood").textContent = l.neighborhood || "";
    card.querySelector(".addr").textContent = l.address || "";
    card.querySelector(".badges").replaceWith(badges(l.reasons));
    if (l._m) {
      const m = card.querySelector(".match");
      m.hidden = false;
      const s = m.querySelector(".match-score");
      s.textContent = `${l._m.score}% match`;
      s.classList.toggle("low", l._m.score < 60);
      m.querySelector(".match-why").textContent = l._m.why.join(" · ");
    }
    const meta = [l.status === "DELISTED" ? `Delisted ${day(l.delisted_at)}` : `Listed ${day(l.first_seen)}`];
    const st = stationFor(l);
    if (st) meta.push(`${st.walk} min walk to ${st.name} (${st.routes.join(" ")})`);
    if (l._c) {
      card.querySelector(".hood").before(el("div", { className: "commute",
        textContent: `${describe(l._c).split(":")[0]} to ${placeName(state.commuteTo)}` }));
    }
    if (l.status === "DELISTED") card.classList.add("gone");
    card.querySelector(".meta").textContent = meta.join(" · ");
    card.addEventListener("click", () => openDetail(l.url, true));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(l.url, true); });
    return card;
  }));
  $("more").hidden = state.shown >= n;
}

function openDetail(url, focusMap = false) {
  const l = state.listings.find((x) => x.url === url);
  if (!l) return;
  if (focusMap) state.map?.focus(l);
  const open = el("button", { className: "btn", textContent: "View listing on StreetEasy" });
  open.addEventListener("click", () => openExternal(l.url));
  const hist = el("table", { className: "hist" });
  hist.createTHead().append(el("tr", {}, ...["Since", "Price", "Change"].map((t) => el("th", { textContent: t }))));
  const tb = hist.createTBody();
  // snapshots are newest first; keep only the points where the price changed
  const points = [...(l.data || [])].reverse().filter((s, i, a) => i === 0 || s.price !== a[i - 1].price).reverse();
  points.forEach((s, i) => {
    const older = points[i + 1];
    const delta = older && s.price != null && older.price != null ? s.price - older.price : null;
    tb.append(el("tr", {},
      el("td", { textContent: new Date(s.scraped_at).toLocaleDateString("en-US", { dateStyle: "medium" }) }),
      el("td", { textContent: money(s.price) }),
      el("td", { textContent: delta == null ? "first seen" : `${delta < 0 ? "−" : "+"}${money(Math.abs(delta))}` })));
  });
  const compare = sameSet(l.reasons, l.reasier_reasons || [])
    ? ""
    : `Reasier flags it as: ${(l.reasier_reasons || []).map((r) => LABELS[r] || r).join(", ") || "not stabilized"}.`;
  const feats = (l.features || []).map((f) => FEATURES[f]).filter(Boolean);
  const m = hasPrefs(state.prefs) ? match(l, state.prefs) : null;
  const st = stationFor(l);
  const transit = [];
  if (st) transit.push(el("p", { className: "feature-list", textContent: `Nearest subway: ${st.name} (${st.routes.join(" ")}), ${st.walk} min walk` }));
  const near = state.prefs?.near;
  if (near && l.lat != null) {
    const c = commute(l, near);
    const dir = el("button", { type: "button", className: "link", textContent: "Exact directions" });
    dir.addEventListener("click", () => openExternal(directionsUrl(l, near)));
    transit.push(el("p", { className: "feature-list" }, `Commute to ${placeName(near)}: ${describe(c)} (estimate) · `, dir));
  }
  $("detail-body").replaceChildren(
    el("div", { className: "detail-head" },
      el("h2", { textContent: `${money(l.price)} · ${l.neighborhood || ""}` }), open),
    el("div", { className: "addr", textContent: [l.address, layout(l)].filter(Boolean).join(" · ") }),
    badges(l.reasons),
    ...(m ? [el("p", { className: "compare", textContent: `${m.score}% match: ${m.why.join(" · ")}` })] : []),
    ...transit,
    el("p", { className: "feature-list", textContent: feats.length ? `Mentioned in the listing: ${feats.join(", ")}` : "No amenities mentioned in the listing text." }),
    el("p", { className: "compare", textContent: compare }),
    el("h3", { textContent: "Price history", style: "font-size:14px;margin:14px 0 6px" }),
    hist,
    el("p", { className: "compare", textContent: "Always confirm rent-stabilization status with the landlord or NYS HCR." }),
  );
  $("detail").showModal();
}

function renderChips() {
  $("hood-chips").replaceChildren(...state.hoods.map((h) => {
    const c = el("button", { type: "button", className: "chip", textContent: h });
    c.setAttribute("aria-label", `Remove ${h}`);
    c.addEventListener("click", () => { state.hoods = state.hoods.filter((x) => x !== h); renderChips(); refresh({ fit: true }); });
    return c;
  }));
}

const stationCache = new Map();
function stationFor(l) {
  if (l.lat == null) return null;
  if (!stationCache.has(l.url)) stationCache.set(l.url, nearest(l));
  return stationCache.get(l.url);
}

function setData(listings, meta) {
  state.listings = listings
    .map((l) => ({ ...l, reasons: l.reasons || [] }))
    .sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""));
  const hoods = [...new Set(state.listings.filter((l) => l.status === "ACTIVE").map((l) => l.neighborhood).filter(Boolean))].sort();
  $("hoods").replaceChildren(...hoods.map((h) => el("option", { value: h })));
  state.meta = meta;
  renderStatus();
  refresh();
  if (state.pendingAnnounce?.length) announce(); // changes whose listings just arrived
}

function renderStatus() {
  const m = state.meta || {};
  const active = state.listings.filter((l) => l.status === "ACTIVE").length;
  $("status").textContent = `${active.toLocaleString()} active listings · updated ${ago(m.updated_at)}`;
}

// ---- saved searches -------------------------------------------------------

function syncSavedSelect() {
  const sel = $("saved");
  const cur = JSON.stringify(currentFilters());
  const match = state.searches.find((s) => JSON.stringify(normalize(s.filters)) === cur);
  sel.value = match ? match.id : "";
  $("delete-search").hidden = !match;
}
const normalize = (f) => {
  const o = {};
  for (const k of ["hoods", "beds", "min", "max", "reason", "features", "commute", "walk", "lines", "delisted", "unflagged"]) if (f?.[k] !== undefined) o[k] = f[k];
  for (const k of ["beds", "reason"]) if (o[k] !== undefined) o[k] = asList(o[k]); // older saves held one value
  return o;
};

function renderSaved() {
  $("saved").replaceChildren(el("option", { value: "", textContent: state.searches.length ? "Choose…" : "None yet" }),
    ...state.searches.map((s) => el("option", { value: s.id, textContent: s.name })));
  syncSavedSelect();
  if ($("profile-dialog").open) renderProfile();
}

// ---- profile ------------------------------------------------------------------

const BED_LABEL = (b) => (Number(b) === 0 ? "studio" : Number(b) === 4 ? "4+ bd" : `${b} bd`);

/** One-line description of a saved search's filters. */
function filterSummary(f) {
  const parts = [];
  if (f.hoods?.length) parts.push(f.hoods.length > 2 ? `${f.hoods.slice(0, 2).join(", ")} +${f.hoods.length - 2}` : f.hoods.join(", "));
  if (f.beds?.length) parts.push(f.beds.map(BED_LABEL).join(" or "));
  if (f.min != null && f.max != null) parts.push(`${money(f.min)}–${money(f.max)}`);
  else if (f.max != null) parts.push(`up to ${money(f.max)}`);
  else if (f.min != null) parts.push(`from ${money(f.min)}`);
  if (f.commute) parts.push(`≤ ${f.commute.minutes} min to ${placeName(f.commute)}`);
  if (f.lines?.length) parts.push(`near ${f.lines.join("/")}`);
  if (f.walk) parts.push(`≤ ${f.walk} min walk to subway`);
  if (f.features?.length) parts.push(f.features.map((x) => FEATURES[x]?.toLowerCase() || x).join(", "));
  if (f.reason?.length) parts.push(f.reason.map((r) => LABELS[r]?.toLowerCase() || r).join(" or "));
  if (f.delisted) parts.push("incl. delisted");
  if (f.unflagged) parts.push("incl. unflagged");
  return parts.join(" · ") || "All rent-stabilized listings";
}

function prefsSummary(p) {
  if (!hasPrefs(p)) return "Not set yet. Add your budget, bedrooms, commute and must-haves to get match scores.";
  const parts = [];
  if (p.maxPrice) parts.push(`up to ${money(p.maxPrice)}`);
  if (p.beds?.length) parts.push(p.beds.map(BED_LABEL).join(" or "));
  if (p.hoods?.length) parts.push(p.hoods.join(", "));
  if (p.near) parts.push(`≤ ${p.near.minutes ?? 30} min to ${placeName(p.near)}`);
  if (p.must?.length) parts.push(`must have ${p.must.map((x) => FEATURES[x]?.toLowerCase()).join(", ")}`);
  if (p.nice?.length) parts.push(`nice: ${p.nice.map((x) => FEATURES[x]?.toLowerCase()).join(", ")}`);
  if (p.confidence === "likely") parts.push("most likely stabilized only");
  return parts.join(" · ");
}

const PROVIDERS = { "google.com": "Google", password: "Email and password", "apple.com": "Apple" };

function renderProfile() {
  const u = state.user;
  $("pf-email").textContent = u ? (u.email || u.displayName || "—") : "Local preview (not signed in)";
  $("pf-method").textContent = u ? (u.providerData.map((p) => PROVIDERS[p.providerId] || p.providerId).join(", ") || "—") : "—";
  $("pf-since").textContent = u?.metadata?.creationTime ? new Date(u.metadata.creationTime).toLocaleDateString("en-US", { dateStyle: "long" }) : "—";
  $("pf-prefs").textContent = prefsSummary(state.prefs);
  $("pf-delete").disabled = DEV;

  const list = $("pf-searches");
  if (!state.searches.length) {
    list.replaceChildren(el("li", { className: "muted", textContent: "No saved searches yet. Set some filters, then \"Save current search\"." }));
    return;
  }
  list.replaceChildren(...state.searches.map((s) => {
    const f = normalize(s.filters);
    const n = state.listings.filter((l) => matches(l, f)).length;
    const run = el("button", { type: "button", className: "btn small", textContent: "Run" });
    const rename = el("button", { type: "button", className: "btn ghost small", textContent: "Rename" });
    const del = el("button", { type: "button", className: "btn ghost small", textContent: "Delete" });
    const item = el("li", { className: "saved-item" },
      el("div", { className: "name-row" }, el("span", { className: "name", textContent: s.name }),
        el("span", { className: "count-now", textContent: `${n.toLocaleString()} now` })),
      el("div", { className: "summary", textContent: filterSummary(f) }),
      el("div", { className: "actions" }, run, rename, del));
    run.addEventListener("click", () => { $("profile-dialog").close(); applyFilters(f); });
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${s.name}"?`)) return;
      try { await deleteSearch(s.id); } catch (e) { message("pf-msg", e.message, true); }
    });
    rename.addEventListener("click", () => {
      const input = el("input", { value: s.name, maxLength: 80 });
      input.setAttribute("aria-label", "New name");
      const save = el("button", { type: "button", className: "btn small", textContent: "Save" });
      const row = el("div", { className: "actions" }, input, save);
      item.querySelector(".actions").replaceWith(row);
      input.focus(); input.select();
      const done = async () => {
        const name = input.value.trim().slice(0, 80);
        if (!name || name === s.name) { renderProfile(); return; }
        try { await renameSearch(s.id, name); } catch (e) { message("pf-msg", e.message, true); }
      };
      save.addEventListener("click", done);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } if (e.key === "Escape") renderProfile(); });
    });
    return item;
  }));
}

async function deleteAccount() {
  if (!confirm("Permanently delete your account, preferences and saved searches? This can't be undone.")) return;
  message("pf-msg", "Deleting…");
  const { fs, db, auth, a } = state.fb;
  const uid = state.user.uid;
  try {
    const searches = await fs.getDocs(fs.collection(db, "users", uid, "searches"));
    await Promise.all(searches.docs.map((d) => fs.deleteDoc(d.ref)));
    await fs.deleteDoc(fs.doc(db, "users", uid, "prefs", "main"));
    stopListeners();
    await auth.deleteUser(a.currentUser);
    $("profile-dialog").close();
  } catch (e) {
    message("pf-msg", e.code === "auth/requires-recent-login"
      ? "For your security, sign out and back in, then delete your account again."
      : `Couldn't delete: ${e.code || e.message}`, true);
  }
}

function wireProfile() {
  $("open-profile").addEventListener("click", () => { message("pf-msg", ""); renderProfile(); $("profile-dialog").showModal(); });
  $("pf-edit-prefs").addEventListener("click", () => { $("profile-dialog").close(); $("open-prefs").click(); });
  $("pf-save-current").addEventListener("click", () => { $("profile-dialog").close(); $("save-search").click(); });
  $("pf-delete").addEventListener("click", deleteAccount);
}

// ---- commute filter -----------------------------------------------------------

function renderLineToggles() {
  const keep = pressed("lines");
  $("lines").replaceChildren(...allLines().map((line) => {
    const b = el("button", { type: "button", className: "tog", textContent: line });
    b.dataset.v = line;
    b.setAttribute("aria-label", `${line} train`);
    return b;
  }));
  setPressed("lines", keep);
}

function setCommute(to, { quiet = false } = {}) {
  state.commuteTo = to ? { label: to.label, lat: to.lat, lng: to.lng, minutes: to.minutes } : null;
  $("c-clear").hidden = !state.commuteTo;
  if (state.commuteTo) {
    $("c-place").value = state.commuteTo.label;
    $("c-minutes").value = String(state.commuteTo.minutes);
    if (!state.sortTouched && !hasPrefs(state.prefs)) $("sort").value = "commute";
  } else if ($("sort").value === "commute") {
    $("sort").value = hasPrefs(state.prefs) ? "match" : "newest";
  }
  message("c-msg", state.commuteTo ? `Estimated by subway to ${placeName(state.commuteTo)}` : "");
  if (!quiet) refresh();
}

function wireCommuteFilter() {
  const find = async () => {
    const q = $("c-place").value.trim();
    if (!q) return;
    message("c-msg", "Looking it up…");
    try {
      const g = await geocode(q);
      if (!g) { message("c-msg", "Couldn't find that address in NYC.", true); return; }
      setCommute({ label: g.label.slice(0, 120), lat: g.lat, lng: g.lng, minutes: Number($("c-minutes").value) });
    } catch (e) { message("c-msg", `Lookup failed: ${e.message}`, true); }
  };
  $("c-set").addEventListener("click", find);
  $("c-place").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });
  $("c-minutes").addEventListener("change", () => {
    if (state.commuteTo) setCommute({ ...state.commuteTo, minutes: Number($("c-minutes").value) });
  });
  $("c-clear").addEventListener("click", () => { $("c-place").value = ""; setCommute(null); });
}

// ---- what's new (events) ----------------------------------------------------

const EVENT_LABELS = { new: "New", price_drop: "Price drop", price_up: "Price up", delisted: "Delisted", relisted: "Back" };
const eventKind = (e) => (e.type === "price_change" ? (e.price < e.old_price ? "price_drop" : "price_up") : e.type);
const seenKey = () => `events-seen-${state.user?.uid || "dev"}`;

function eventText(e) {
  const place = [e.address?.split(",")[0], e.neighborhood].filter(Boolean).join(", ");
  if (e.type === "price_change") return `${place}: ${money(e.old_price)} → ${money(e.price)}`;
  return `${place} · ${money(e.price)}${e.beds != null ? ` · ${e.beds === 0 ? "studio" : `${e.beds} bd`}` : ""}`;
}

function matchesMine(e) {
  if (!hasPrefs(state.prefs)) return false;
  const l = state.listings.find((x) => x.url === e.url);
  return !!l && match(l, state.prefs).ok;
}

function renderFeed() {
  const seen = Number(store.get(seenKey()) || 0);
  const unseen = state.events.filter((e) => e.atMs > seen && e.type !== "delisted").length;
  $("feed-count").hidden = !unseen;
  $("feed-count").textContent = unseen > 99 ? "99+" : String(unseen);
  if (!state.events.length) {
    $("feed").replaceChildren(el("p", { className: "empty", textContent: "No changes yet. New listings and price changes will show up here." }));
    return;
  }
  $("feed").replaceChildren(...state.events.map((e) => {
    const kind = eventKind(e);
    const item = el("button", { type: "button", className: "feed-item" },
      el("span", { className: `kind ${kind}`, textContent: EVENT_LABELS[kind] || e.type }),
      el("span", { className: "what", textContent: eventText(e) }),
      el("span", { className: "when", textContent: ago(new Date(e.atMs).toISOString()) }));
    if (matchesMine(e)) item.append(el("span", { className: "yours", textContent: "Matches your preferences" }));
    item.addEventListener("click", () => { $("feed-dialog").close(); openDetail(e.url, true); });
    return item;
  }));
}

function toast(text) {
  $("toast-text").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $("toast").hidden = true; }, 12000);
}

function listenEvents() {
  const { fs, db } = state.fb;
  const q = fs.query(fs.collection(db, "events"), fs.orderBy("at", "desc"), fs.limit(40));
  let first = true;
  state.unsub.push(fs.onSnapshot(q, (snap) => {
    const fresh = first ? [] : snap.docChanges().filter((c) => c.type === "added").map((c) => c.doc.data());
    state.events = snap.docs.map((d) => ({ ...d.data(), atMs: d.data().at?.toMillis?.() ?? Date.now() }));
    renderFeed();
    if (fresh.length) {
      // events and listings arrive separately; wait for the listings that
      // contain these changes so "matches your preferences" is accurate
      state.pendingAnnounce = [...(state.pendingAnnounce || []), ...fresh];
      clearTimeout(state.announceTimer);
      if (fresh.every((e) => e.type === "delisted" || state.listings.some((l) => l.url === e.url))) announce();
      else state.announceTimer = setTimeout(announce, 15000);
    }
    first = false;
  }, () => { /* events are optional; listings still work */ }));
}

function announce() {
  const fresh = state.pendingAnnounce || [];
  state.pendingAnnounce = [];
  clearTimeout(state.announceTimer);
  if (!fresh.length) return;
  renderFeed();
  const n = (t) => fresh.filter((e) => eventKind(e) === t).length;
  const parts = [[n("new"), "new listing"], [n("price_drop"), "price drop"], [n("relisted"), "back on the market"]]
    .filter(([c]) => c).map(([c, w]) => `${c} ${w}${c > 1 && !w.startsWith("back") ? "s" : ""}`);
  const mine = fresh.filter(matchesMine).length;
  if (parts.length) toast(`${parts.join(", ")}${mine ? ` (${mine} match your preferences)` : ""}`);
}

function wireFeed() {
  $("open-feed").addEventListener("click", () => {
    renderFeed();
    $("feed-dialog").showModal();
    if (state.events[0]) store.set(seenKey(), String(state.events[0].atMs));
    $("feed-count").hidden = true;
  });
  $("toast-view").addEventListener("click", () => { $("toast").hidden = true; $("open-feed").click(); });
  $("toast-close").addEventListener("click", () => { $("toast").hidden = true; });
}

// ---- preferences ------------------------------------------------------------

function setPrefs(p) {
  state.prefs = p && hasPrefs(p) ? p : null;
  if (state.prefs && !state.sortTouched) $("sort").value = "match";
  if (!state.prefs && $("sort").value === "match") $("sort").value = "newest";
  $("open-prefs").textContent = state.prefs ? "My preferences ✓" : "My preferences";
  refresh();
}

function listenPrefs() {
  if (DEV) {
    try { setPrefs(JSON.parse(store.get("prefs") || "null")); } catch { setPrefs(null); }
    return;
  }
  const { fs, db } = state.fb;
  state.unsub.push(fs.onSnapshot(fs.doc(db, "users", state.user.uid, "prefs", "main"),
    (snap) => setPrefs(snap.exists() ? snap.data() : null)));
}

async function savePrefs(p) {
  if (DEV) { store.set("prefs", JSON.stringify(p)); setPrefs(p); return; }
  const { fs, db } = state.fb;
  await fs.setDoc(fs.doc(db, "users", state.user.uid, "prefs", "main"), { ...p, updated_at: fs.serverTimestamp() });
}

async function clearPrefs() {
  if (DEV) { store.remove("prefs"); setPrefs(null); return; }
  const { fs, db } = state.fb;
  await fs.deleteDoc(fs.doc(db, "users", state.user.uid, "prefs", "main"));
}

function wirePrefs() {
  const draft = { hoods: [], near: null };
  const checks = (box, prefix) => box.replaceChildren(...Object.entries(FEATURES).map(([k, label]) =>
    el("label", {}, el("input", { type: "checkbox", value: k, id: `${prefix}-${k}` }), ` ${label}`)));
  checks($("p-must"), "must");
  checks($("p-nice"), "nice");
  const checked = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);
  const setChecked = (box, vals = []) => box.querySelectorAll("input").forEach((i) => { i.checked = vals.includes(i.value); });

  const renderHoods = () => $("p-hood-chips").replaceChildren(...draft.hoods.map((h) => {
    const c = el("button", { type: "button", className: "chip", textContent: h });
    c.addEventListener("click", () => { draft.hoods = draft.hoods.filter((x) => x !== h); renderHoods(); });
    return c;
  }));
  const renderNear = () => {
    $("p-near-clear").hidden = !draft.near;
    message("p-near-msg", draft.near ? `Using: ${draft.near.label}` : "");
  };
  const addHood = () => {
    const input = $("p-hood-input");
    const v = [...$("hoods").options].map((o) => o.value).find((h) => h.toLowerCase() === input.value.trim().toLowerCase());
    if (v && !draft.hoods.includes(v)) { draft.hoods.push(v); renderHoods(); }
    if (v) input.value = "";
  };
  $("p-hood-input").addEventListener("change", addHood);
  $("p-hood-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addHood(); } });

  const findNear = async () => {
    const q = $("p-near").value.trim();
    if (!q) return;
    message("p-near-msg", "Looking it up…");
    try {
      const g = await geocode(q);
      if (!g) { message("p-near-msg", "Couldn't find that address in NYC.", true); return; }
      draft.near = { label: g.label.slice(0, 120), lat: g.lat, lng: g.lng, minutes: Number($("p-minutes").value) };
      renderNear();
    } catch (e) { message("p-near-msg", `Lookup failed: ${e.message}`, true); }
  };
  $("p-near-find").addEventListener("click", findNear);
  $("p-near").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findNear(); } });
  $("p-minutes").addEventListener("change", () => { if (draft.near) draft.near.minutes = Number($("p-minutes").value); });
  $("p-near-clear").addEventListener("click", () => { draft.near = null; $("p-near").value = ""; renderNear(); });

  $("open-prefs").addEventListener("click", () => {
    const p = state.prefs || {};
    $("p-max").value = p.maxPrice ?? "";
    setChecked($("p-beds"), p.beds);
    setChecked($("p-must"), p.must);
    setChecked($("p-nice"), p.nice);
    draft.hoods = [...(p.hoods || [])];
    draft.near = p.near ? { label: p.near.label, lat: p.near.lat, lng: p.near.lng, minutes: p.near.minutes ?? 30 } : null;
    $("p-near").value = p.near?.label ?? "";
    $("p-minutes").value = String(p.near?.minutes ?? 30);
    document.querySelector(`input[name=p-conf][value=${p.confidence === "likely" ? "likely" : "any"}]`).checked = true;
    renderHoods(); renderNear(); message("prefs-msg", "");
    $("prefs-dialog").showModal();
  });
  $("prefs-cancel").addEventListener("click", () => $("prefs-dialog").close());
  $("prefs-clear").addEventListener("click", async () => {
    try { await clearPrefs(); $("prefs-dialog").close(); } catch (e) { message("prefs-msg", e.message, true); }
  });
  $("prefs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    // only keys with values: the security rules reject anything else
    const p = {};
    if ($("p-max").value) p.maxPrice = Number($("p-max").value);
    const beds = checked($("p-beds")); if (beds.length) p.beds = beds;
    if (draft.hoods.length) p.hoods = draft.hoods;
    if (draft.near) p.near = draft.near;
    const must = checked($("p-must")); if (must.length) p.must = must;
    const nice = checked($("p-nice")).filter((f) => !must.includes(f)); if (nice.length) p.nice = nice;
    if (document.querySelector("input[name=p-conf]:checked").value === "likely") p.confidence = "likely";
    try {
      if (hasPrefs(p)) await savePrefs(p); else await clearPrefs();
      $("prefs-dialog").close();
    } catch (err) { message("prefs-msg", `Couldn't save: ${err.code || err.message}`, true); }
  });

  $("sort").addEventListener("change", () => { state.sortTouched = true; refresh(); });
  $("matches-only").addEventListener("change", refresh);
}

// ---- Firebase -------------------------------------------------------------

async function loadFirebase() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(CONFIG.firebase);
  return { auth, fs, a: auth.getAuth(app), db: fs.getFirestore(app) };
}

const AUTH_ERRORS = {
  "auth/invalid-credential": "That email and password don't match.",
  "auth/invalid-email": "That doesn't look like an email address.",
  "auth/email-already-in-use": "There's already an account with that email. Try signing in.",
  "auth/weak-password": "Use at least 8 characters for your password.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/popup-closed-by-user": "Sign-in was cancelled.",
  "auth/network-request-failed": "Network problem. Check your connection.",
};
const authError = (e) => AUTH_ERRORS[e.code] || e.message || "Something went wrong.";

function wireAuth({ auth, a }) {
  const standalone = matchMedia("(display-mode: standalone)").matches;
  const popup = (provider) => (standalone ? auth.signInWithRedirect(a, provider) : auth.signInWithPopup(a, provider))
    .catch((e) => message("auth-msg", authError(e), true));

  $("google").addEventListener("click", () => popup(new auth.GoogleAuthProvider()));
  if ((CONFIG.providers || []).includes("apple")) {
    $("apple").hidden = false;
    $("apple").addEventListener("click", () => {
      const p = new auth.OAuthProvider("apple.com");
      p.addScope("email");
      popup(p);
    });
  }

  let mode = "signin"; // signin | signup | reset
  const setMode = (m) => {
    mode = m;
    $("password-field").hidden = m === "reset";
    $("password").autocomplete = m === "signup" ? "new-password" : "current-password";
    $("email-submit").textContent = { signin: "Sign in", signup: "Create account", reset: "Send reset link" }[m];
    $("to-signup").textContent = m === "signin" ? "Create an account" : "Back to sign in";
    $("to-reset").hidden = m !== "signin";
    message("auth-msg", "");
  };
  $("to-signup").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  $("to-reset").addEventListener("click", () => setMode("reset"));
  $("email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim();
    const pw = $("password").value;
    $("email-submit").disabled = true;
    try {
      if (mode === "reset") {
        await auth.sendPasswordResetEmail(a, email);
        message("auth-msg", "If that email has an account, a reset link is on its way.");
      } else if (mode === "signup") {
        if (pw.length < 8) throw { code: "auth/weak-password" };
        const cred = await auth.createUserWithEmailAndPassword(a, email, pw);
        await auth.sendEmailVerification(cred.user);
      } else {
        await auth.signInWithEmailAndPassword(a, email, pw);
      }
    } catch (err) {
      message("auth-msg", authError(err), true);
    } finally {
      $("email-submit").disabled = false;
    }
  });

  for (const b of document.querySelectorAll(".sign-out")) b.addEventListener("click", () => auth.signOut(a));
  $("resend").addEventListener("click", async () => {
    try { await auth.sendEmailVerification(a.currentUser); message("verify-msg", "Sent. Check your inbox (and spam)."); }
    catch (e) { message("verify-msg", authError(e), true); }
  });
  $("verified").addEventListener("click", async () => {
    await a.currentUser.reload();
    if (a.currentUser.emailVerified) {
      await a.currentUser.getIdToken(true); // refresh the token so Firestore sees the verified flag
      onUser(a.currentUser);
    } else message("verify-msg", "Not verified yet. Open the link in the email first.", true);
  });

  auth.onAuthStateChanged(a, onUser);
}

function stopListeners() {
  for (const u of state.unsub) u();
  state.unsub = [];
}

function onUser(user) {
  stopListeners();
  state.user = user;
  if (!user) {
    state.listings = []; state.searches = [];
    show("login");
    return;
  }
  const password = user.providerData.some((p) => p.providerId === "password");
  if (password && !user.emailVerified) {
    $("verify-email").textContent = user.email;
    show("verify");
    return;
  }
  $("avatar-initial").textContent = (user.displayName || user.email || "?").trim()[0].toUpperCase();
  show("app");
  ensureMap();
  listenListings();
  listenSearches();
  listenPrefs();
  listenEvents();
}

/** listings are split across a few documents; meta/status says which version is current */
function listenListings() {
  const { fs, db } = state.fb;
  let version = null;
  state.unsub.push(fs.onSnapshot(fs.doc(db, "meta", "status"), async (snap) => {
    const meta = snap.data();
    if (!meta) { setData([], {}); return; }
    if (meta.version === version) { state.meta = meta; renderStatus(); return; }
    version = meta.version;
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => fs.getDoc(fs.doc(db, "listings", `c${i}`))));
    const listings = chunks.flatMap((c) => (c.exists() && c.data().version === meta.version ? JSON.parse(c.data().json) : []));
    setData(listings, meta);
  }, (err) => { $("status").textContent = `Couldn't load listings: ${err.code || err.message}`; }));
}

function listenSearches() {
  const { fs, db } = state.fb;
  const q = fs.query(fs.collection(db, "users", state.user.uid, "searches"), fs.orderBy("created_at", "desc"));
  state.unsub.push(fs.onSnapshot(q, (snap) => {
    state.searches = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSaved();
  }));
}

async function saveSearch(name) {
  if (DEV) {
    state.searches.unshift({ id: String(Date.now()), name, filters: currentFilters() });
    renderSaved();
    return;
  }
  const { fs, db } = state.fb;
  await fs.addDoc(fs.collection(db, "users", state.user.uid, "searches"),
    { name, filters: currentFilters(), created_at: fs.serverTimestamp() });
}

async function renameSearch(id, name) {
  if (DEV) { const s = state.searches.find((x) => x.id === id); if (s) s.name = name; renderSaved(); return; }
  const { fs, db } = state.fb;
  await fs.updateDoc(fs.doc(db, "users", state.user.uid, "searches", id), { name });
}

async function deleteSearch(id) {
  if (DEV) { state.searches = state.searches.filter((s) => s.id !== id); renderSaved(); return; }
  const { fs, db } = state.fb;
  await fs.deleteDoc(fs.doc(db, "users", state.user.uid, "searches", id));
}

// ---- map ------------------------------------------------------------------

let mapPromise;
function ensureMap() {
  mapPromise ??= createMap($("map"), {
    googleKey: CONFIG.googleMapsKey,
    googleMapId: CONFIG.googleMapId,
    onSelect: (url) => openDetail(url),
  }).then((m) => { state.map = m; m.setListings(state.filtered); return m; })
    .catch((e) => { $("map").textContent = `Map unavailable: ${e.message}`; });
  return mapPromise;
}

// ---- wire up ----------------------------------------------------------------

function wireUi() {
  wirePrefs();
  wireProfile();
  wireFeed();
  const addHood = () => {
    const input = $("hood-input");
    const all = [...$("hoods").options].map((o) => o.value);
    const v = all.find((h) => h.toLowerCase() === input.value.trim().toLowerCase());
    if (v && !state.hoods.includes(v)) { state.hoods.push(v); renderChips(); refresh({ fit: true }); }
    if (v) input.value = "";
  };
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  $("hood-input").addEventListener("change", addHood);
  $("hood-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addHood(); } });
  $("feat-filter").replaceChildren(...Object.entries(FEATURES).map(([k, label]) => {
    const b = el("button", { type: "button", className: "tog", textContent: label });
    b.dataset.v = k;
    b.setAttribute("aria-pressed", "false");
    return b;
  }));
  // multi-select toggles; in "beds", the Any button clears the others
  for (const id of ["beds", "reasons", "feat-filter", "lines"]) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const vals = pressed(id);
      const v = b.dataset.v;
      setPressed(id, !v ? [] : vals.includes(v) ? vals.filter((x) => x !== v) : [...vals, v]);
      refresh();
    });
  }
  let t;
  for (const id of ["min", "max"]) $(id).addEventListener("input", () => { clearTimeout(t); t = setTimeout(refresh, 200); });
  for (const id of ["delisted", "unflagged", "walk"]) $(id).addEventListener("change", refresh);
  wireCommuteFilter();
  $("more").addEventListener("click", () => { state.shown += PAGE; renderList(); });

  $("saved").addEventListener("change", () => {
    const s = state.searches.find((x) => x.id === $("saved").value);
    if (s) applyFilters(normalize(s.filters));
  });
  $("save-search").addEventListener("click", () => {
    $("save-name").value = "";
    message("save-msg", "");
    $("save-dialog").showModal();
  });
  $("save-cancel").addEventListener("click", () => $("save-dialog").close());
  $("save-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("save-name").value.trim().slice(0, 80);
    if (!name) return;
    try { await saveSearch(name); $("save-dialog").close(); }
    catch (err) { message("save-msg", `Couldn't save: ${err.code || err.message}`, true); }
  });
  $("delete-search").addEventListener("click", () => {
    const id = $("saved").value;
    if (id && confirm("Delete this saved search?")) deleteSearch(id).catch((e) => alert(e.message));
  });

  $("toggle-more").addEventListener("click", () => {
    const open = $("more-filters").hidden;
    $("more-filters").hidden = !open;
    $("toggle-more").setAttribute("aria-expanded", String(open));
    state.map?.resize();
  });
  $("toggle-filters").addEventListener("click", () => {
    const open = $("app").classList.toggle("show-filters");
    $("toggle-filters").setAttribute("aria-expanded", String(open));
    state.map?.resize();
  });
  for (const b of document.querySelectorAll(".view-tabs button[data-view]")) {
    b.addEventListener("click", () => {
      for (const x of document.querySelectorAll(".view-tabs button[data-view]")) x.classList.toggle("on", x === b);
      $("split").dataset.view = b.dataset.view;
      if (b.dataset.view === "map") state.map?.resize();
    });
  }
  setInterval(renderStatus, 60_000);
}

async function main() {
  wireUi();
  // station data is small and static; re-render once it's in
  loadStations().then(() => { stationCache.clear(); renderLineToggles(); refresh(); }).catch(() => {});
  if ("serviceWorker" in navigator && !DEV) navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (DEV) {
    $("avatar-initial").textContent = "L";
    show("app");
    await ensureMap();
    const data = await (await fetch(CONFIG.devData)).json();
    setData(data.listings, { updated_at: data.generated_at });
    listenPrefs();
    return;
  }
  if (!CONFIG.firebase?.apiKey || CONFIG.firebase.apiKey.startsWith("YOUR_")) {
    show("login");
    message("auth-msg", "This site isn't configured yet: add your Firebase settings to config.js.", true);
    return;
  }
  state.fb = await loadFirebase();
  wireAuth(state.fb);
}

main();
