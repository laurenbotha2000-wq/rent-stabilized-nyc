// Stoopify (hosted): live listings from Firestore for anyone,
// map + list with filters; an account adds saved searches, preferences and alerts.
import { CONFIG } from "./config.js";
import { GROUPINGS, buildingKey, createMap } from "./map.js";
import { FEATURES, geocode, hasPrefs, match, niceAddress, placeName, suggest } from "./prefs.js";
import { commute, describe, directionsUrl, loadStations, nearest, allLines } from "./commute.js";
import { asList, commuteFor, grade, gradeRank, isPrewar, matches, normalize } from "./filters.js";

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
  user: null, searches: [], map: null, fb: null, unsub: [], alertSettings: null,
  prefs: null, sortTouched: false, events: [], dataUnsub: [], bounds: null, places: [],
};


// localStorage can throw (storage blocked, some embedded browsers); treat it as optional
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* not persisted */ } },
};

// ---- viewed listings (this device only) -------------------------------------

const VIEWED_MAX = 3000;
const viewed = new Set((() => { try { return JSON.parse(store.get("viewed") || "[]"); } catch { return []; } })());
function markViewed(url) {
  if (viewed.has(url)) return;
  viewed.add(url);
  const all = [...viewed];
  store.set("viewed", JSON.stringify(all.slice(-VIEWED_MAX)));
}

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
function badges(reasons, l) {
  const box = el("div", { className: "badges" });
  const g = l && grade(l);
  if (g) {
    const b = el("span", { className: `badge grade grade-${g.letter}`, textContent: `Grade ${g.letter}` });
    b.title = `Building grade ${g.letter}: ${gradeWhy(g)}`;
    box.append(b);
  }
  if (l?.income_restricted) {
    const b = el("span", { className: "badge income", textContent: "Income restricted" });
    b.title = "The listing says renters must meet income limits (e.g. an affordable-housing lottery unit).";
    box.append(b);
  }
  if (l?.light) {
    const b = el("span", { className: `badge light light-${l.light.level}`, textContent: LIGHT[l.light.level] });
    b.title = `Daylight estimate: ${l.light.why}. ${LIGHT_HOW}`;
    box.append(b);
  }
  if (l?.superfund) {
    const b = el("span", { className: "badge superfund", textContent: "Near Superfund site" });
    b.title = superfundText(l.superfund);
    box.append(b);
  }
  if (!reasons.length) box.append(el("span", { className: "badge plain", textContent: "Not flagged" }));
  for (const r of reasons) box.append(el("span", { className: `badge ${r}`, textContent: LABELS[r] || r }));
  return box;
}
const LIGHT = { bright: "☀ Likely bright", some: "◐ Some light", dim: "☁ Likely dim" };
const LIGHT_HOW = "Estimated from the apartment's floor and the heights of the buildings around it (NYC building footprints), "
  + "counting open sky to the south most. We don't know which way the windows face, so treat it as a rough guide.";
const superfundText = (s) => `${s.m < 100 ? "Under 100" : `About ${Math.round(s.m / 50) * 50}`} m from the ${s.name} `
  + "Superfund site, a federal toxic-waste cleanup (U.S. EPA).";
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

function currentFilters() {
  const f = {};
  if (state.hoods.length) f.hoods = [...state.hoods];
  const beds = pressed("beds"); if (beds.length) f.beds = beds;
  if ($("min").value) f.min = Number($("min").value);
  if ($("max").value) f.max = Number($("max").value);
  const reasons = pressed("reasons"); if (reasons.length) f.reason = reasons;
  const features = pressed("feat-filter"); if (features.length) f.features = features;
  if (state.commuteTo) f.commute = { ...state.commuteTo };
  if (state.commuteTo2) f.commute2 = { ...state.commuteTo2 };
  if ($("walk").value) f.walk = Number($("walk").value);
  const lines = pressed("lines"); if (lines.length) f.lines = lines;
  if ($("delisted").checked) f.delisted = true;
  if ($("unflagged").checked) f.unflagged = true;
  if ($("no-hazard").checked) f.noHazard = true;
  if ($("prewar").checked) f.prewar = true;
  if ($("days").value) f.days = Number($("days").value);
  if ($("grade").value) f.grade = $("grade").value;
  if ($("income").value) f.income = $("income").value;
  if ($("light").value) f.light = $("light").value;
  if ($("superfund").value) f.superfund = $("superfund").value;
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
  setCommute2(f.commute2 || null, { quiet: true });
  $("min").value = f.min ?? "";
  $("max").value = f.max ?? "";
  $("delisted").checked = !!f.delisted;
  $("unflagged").checked = !!f.unflagged;
  $("no-hazard").checked = !!f.noHazard;
  $("prewar").checked = !!f.prewar;
  $("days").value = f.days ? String(f.days) : "";
  $("grade").value = f.grade || "";
  $("income").value = f.income || "";
  $("light").value = f.light || "";
  $("superfund").value = f.superfund || "";
  renderChips();
  refresh({ fit: true });
}

const SORTS = {
  match: (a, b) => (b._m?.score ?? 0) - (a._m?.score ?? 0) || (b.first_seen || "").localeCompare(a.first_seen || ""),
  newest: (a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""),
  "price-asc": (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  "price-desc": (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
  commute: (a, b) => longestCommute(a) - longestCommute(b), // with two places, the longer trip counts
  violations: (a, b) => {
    const x = gradeRank(a), y = gradeRank(b);
    return (x[0] - y[0]) || (x[1] - y[1]) || (a.price ?? Infinity) - (b.price ?? Infinity);
  },
};

function refresh({ fit = false } = {}) {
  const f = currentFilters();
  const personal = hasPrefs(state.prefs);
  $("matches-only-wrap").hidden = !personal;
  // how many filters are set inside the collapsed "More filters" panel
  const more = ["reason", "features", "walk", "lines", "delisted", "unflagged", "noHazard", "prewar", "grade", "income", "light", "superfund"].filter((k) => f[k] !== undefined).length;
  $("more-count").hidden = !more;
  $("more-count").textContent = String(more);
  const set = Object.keys(f).length;
  $("clear-filters").hidden = !set;
  $("filter-count").textContent = String(set);
  state.filtered = state.listings.filter((l) => {
    if (!matches(l, f)) return false;
    l._c = f.commute ? commuteFor(l, f.commute) : null;
    l._c2 = f.commute2 ? commuteFor(l, f.commute2) : null;
    l._m = personal ? match(l, state.prefs) : null;
    if ($("hide-viewed").checked && viewed.has(l.url)) return false;
    return !(personal && $("matches-only").checked && !l._m.ok);
  });
  const anyCommute = Boolean(f.commute || f.commute2);
  $("sort-commute").hidden = !anyCommute;
  let sort = $("sort").value;
  if (sort === "match" && !personal) sort = anyCommute ? "commute" : "newest";
  if (sort === "commute" && !anyCommute) sort = personal ? "match" : "newest";
  state.filtered.sort(SORTS[sort]);
  state.shown = PAGE;
  state.map?.setListings(state.filtered);
  if (fit) state.map?.fit(state.filtered);
  renderList();
  syncSavedSelect();
}

// ---- rendering ------------------------------------------------------------

const inBounds = (l, b) => l.lat != null && l.lat >= b.south && l.lat <= b.north
  && (b.west <= b.east ? l.lng >= b.west && l.lng <= b.east : l.lng >= b.west || l.lng <= b.east);

/** The list follows the map: only what's in the current map area, when that's on. */
function listed() {
  const b = $("in-view").checked && state.bounds;
  return b ? state.filtered.filter((l) => inBounds(l, b)) : state.filtered;
}

function renderList() {
  const list = $("list");
  const shown = listed();
  const n = shown.length, total = state.filtered.length;
  const mapped = state.filtered.filter((l) => l.lat != null).length;
  $("viewed-count").textContent = viewed.size ? `(${viewed.size.toLocaleString()})` : "";
  $("summary").textContent = shown !== state.filtered && total
    ? `${n.toLocaleString()} in this map area · ${total.toLocaleString()} total`
    : total ? `${total.toLocaleString()} apartments${mapped < total ? ` · ${total - mapped} not on the map` : ""}` : "";
  if (!n) {
    list.replaceChildren(el("div", { className: "empty", textContent: !state.listings.length ? "No data yet."
      : total ? "Nothing in this map area. Zoom out or move the map." : "No apartments match these filters." }));
    $("more").hidden = true;
    return;
  }
  list.replaceChildren(...shown.slice(0, state.shown).map((l) => card(l, () => openDetail(l.url, true))));
  $("more").hidden = state.shown >= n;
}

/** One apartment as a card; `onOpen` runs on click or Enter. */
function card(l, onOpen) {
  const tpl = $("card-tpl").content.firstElementChild;
  const c = tpl.cloneNode(true);
  c.querySelector(".price").textContent = money(l.price);
  c.querySelector(".layout").textContent = layout(l);
  c.querySelector(".hood").textContent = l.neighborhood || "";
  c.querySelector(".addr").textContent = l.address || "";
  c.querySelector(".badges").replaceWith(badges(l.reasons, l));
  if (l._m) {
    const m = c.querySelector(".match");
    m.hidden = false;
    const s = m.querySelector(".match-score");
    s.textContent = `${l._m.score}% match`;
    s.classList.toggle("low", l._m.score < 60);
    m.querySelector(".match-why").textContent = l._m.why.join(" · ");
  }
  const meta = [l.status === "DELISTED" ? `Delisted ${day(l.delisted_at)}` : `Listed ${day(l.first_seen)}`];
  const st = stationFor(l);
  if (st) meta.push(`${st.walk} min walk to ${st.name} (${st.routes.join(" ")})`);
  if (isPrewar(l)) meta.push(`Prewar (${l.hpd.year_built})`);
  if (l.hpd) meta.push(violationText(l.hpd.violations));
  const trips = [[l._c, state.commuteTo], [l._c2, state.commuteTo2]].filter(([t, to]) => t && to)
    .map(([t, to]) => `${describe(t).split(":")[0]} to ${placeName(to)}`);
  if (trips.length) c.querySelector(".hood").before(el("div", { className: "commute", textContent: trips.join(" · ") }));
  if (l.status === "DELISTED") c.classList.add("gone");
  if (viewed.has(l.url)) { c.classList.add("viewed"); c.querySelector(".seen").hidden = false; }
  c.querySelector(".meta").textContent = meta.join(" · ");
  c.addEventListener("click", onOpen);
  c.addEventListener("keydown", (e) => { if (e.key === "Enter") onOpen(); });
  return c;
}

/** "0.4 serious violations per apartment (12 across 30 apartments)". */
function gradeWhy(g) {
  const per = g.perUnit < 0.05 && g.serious ? "under 0.05" : String(Number(g.perUnit.toFixed(2)));
  return `${per} open serious violations per apartment (${g.serious} across ${g.units} apartment${g.units === 1 ? "" : "s"}${g.C ? `, ${g.C} immediately hazardous` : ""})`;
}

/** "No open violations", "8 open violations (2 hazardous)". */
function violationText(v) {
  if (!v.total) return "No open violations";
  const bad = v.C ? ` (${v.C} immediately hazardous)` : "";
  return `${v.total} open violation${v.total > 1 ? "s" : ""}${bad}`;
}

const GRADE_SCALE = "Grades count open class B and C HPD violations per apartment: A under 0.25, B under 0.75, C under 1.5, D under 3, F at the city's Worst Landlord Watchlist level (3+, or 2+ in buildings with 35+ apartments). Many immediately hazardous (C) violations lower the grade.";

/** Daylight estimate and nearby Superfund site, when known. */
function surroundingsSection(l) {
  if (!l.light && !l.superfund) return [];
  return [
    el("h3", { textContent: "Light and surroundings", style: "font-size:14px;margin:14px 0 6px" }),
    el("dl", { className: "facts" },
      ...(l.light ? [el("dt", { textContent: "Daylight (estimate)" }),
        el("dd", {}, el("strong", { textContent: LIGHT[l.light.level] }), ` · ${l.light.why}.`,
          el("details", { className: "how" }, el("summary", { textContent: "How this is estimated" }),
            el("p", { className: "muted", textContent: LIGHT_HOW })))] : []),
      ...(l.superfund ? [el("dt", { textContent: "Superfund site" }), el("dd", { textContent: superfundText(l.superfund) })] : [])),
  ];
}

/** Building record from NYC HPD and PLUTO: a one-line summary, with the full record folded underneath. */
function hpdSection(l) {
  const h = l.hpd;
  if (!h) return [];
  const v = h.violations, g = grade(l);
  const link = el("button", { type: "button", className: "link", textContent: "Full building history (Who Owns What)" });
  const bbl = l.geo_bbl || l.bbl;
  link.addEventListener("click", () => openExternal(`https://whoownswhat.justfix.org/en/bbl/${bbl}`));
  const summary = el("summary", { className: "bldg-summary" },
    ...(g ? [el("strong", { className: `grade-letter grade-${g.letter}`, textContent: g.letter })] : []),
    el("span", {}, [
      g ? `Grade ${g.letter}` : "Building",
      v.total ? `${v.total} open violation${v.total > 1 ? "s" : ""}${v.C ? ` (${v.C} hazardous)` : ""}` : "no open violations",
      h.year_built ? `built ${h.year_built}` : null,
    ].filter(Boolean).join(" · ")));
  summary.title = "Show the building's full record";
  return [
    el("h3", { textContent: "Building", style: "font-size:14px;margin:14px 0 6px" }),
    el("details", { className: "bldg" }, summary,
      el("dl", { className: "facts" },
        ...(g ? [el("dt", { textContent: "Why this grade" }), el("dd", { textContent: `${gradeWhy(g)}.` })] : []),
        el("dt", { textContent: "Open violations" }),
        el("dd", { textContent: v.total
          ? `${v.C} immediately hazardous (C) · ${v.B} hazardous (B) · ${v.A} non-hazardous (A)`
          : "None open" }),
        el("dt", { textContent: "Complaints, past year" }), el("dd", { textContent: String(h.complaints_12mo) }),
        el("dt", { textContent: "Year built" }),
        el("dd", { textContent: h.year_built ? `${h.year_built}${isPrewar(l) ? " (prewar)" : ""}` : "—" }),
        el("dt", { textContent: "Registered owner" }), el("dd", { textContent: h.owner || (h.registered ? "—" : "Not registered with HPD") }),
        el("dt", { textContent: "Managing agent" }), el("dd", { textContent: h.agent || "—" })),
      el("details", { className: "how" }, el("summary", { textContent: "How grades work" }),
        el("p", { className: "muted", textContent: GRADE_SCALE })),
      el("p", { className: "compare" }, `NYC HPD and PLUTO, as of ${new Date(h.as_of).toLocaleDateString("en-US", { dateStyle: "medium" })}. `, link)),
  ];
}

/** Other units in the same building (within the current filters). */
const sameBuilding = (l) => (l.lat == null ? [] : state.filtered.filter((x) => x.lat != null && buildingKey(x) === buildingKey(l)));

function openDetail(url, focusMap = false, fromBuilding = null) {
  const l = state.listings.find((x) => x.url === url);
  if (!l) return;
  if (focusMap) state.map?.focus(l);
  markViewed(l.url);
  const units = sameBuilding(l);
  const back = [];
  if (fromBuilding || units.length > 1) {
    const b = el("button", { type: "button", className: "link back-link",
      textContent: fromBuilding ? `← All ${fromBuilding.length} apartments in this building` : `See all ${units.length} apartments in this building` });
    b.addEventListener("click", () => openBuilding(fromBuilding || units.map((x) => x.url)));
    back.push(el("div", {}, b));
  }
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
    ...back,
    el("div", { className: "detail-head" },
      el("h2", { textContent: `${money(l.price)} · ${l.neighborhood || ""}` }), open),
    el("div", { className: "addr", textContent: [l.address, layout(l)].filter(Boolean).join(" · ") }),
    badges(l.reasons, l),
    ...(m ? [el("p", { className: "compare", textContent: `${m.score}% match: ${m.why.join(" · ")}` })] : []),
    ...transit,
    ...hpdSection(l),
    ...surroundingsSection(l),
    el("p", { className: "feature-list", textContent: feats.length ? `Mentioned in the listing: ${feats.join(", ")}` : "No amenities mentioned in the listing text." }),
    el("p", { className: "compare", textContent: compare }),
    el("h3", { textContent: "Price history", style: "font-size:14px;margin:14px 0 6px" }),
    hist,
    el("p", { className: "compare", textContent: "Always confirm rent-stabilization status with the landlord or NYS HCR." }),
  );
  openSheet("detail");
  refreshViewed();
}

/** Several apartments in one building: list them, cheapest first. */
function openBuilding(urls) {
  const units = urls.map((u) => state.listings.find((l) => l.url === u)).filter(Boolean)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  if (!units.length) return;
  const streets = [...new Set(units.map((l) => l.address?.split(",")[0]).filter(Boolean))];
  const addr = !streets.length ? "this building" : streets.length === 1 ? streets[0]
    : `${streets[0]} and ${streets.length - 1} other address${streets.length > 2 ? "es" : ""}`;
  const unseen = units.filter((l) => !viewed.has(l.url)).length;
  $("detail-body").replaceChildren(
    el("h2", { className: "building-head", textContent: `${units.length} apartments at ${addr}` }),
    el("p", { className: "muted", textContent: [units[0].neighborhood, `${money(units[0].price)}–${money(units.at(-1).price)}`,
      unseen < units.length ? `${unseen} not viewed yet` : ""].filter(Boolean).join(" · ") }),
    el("div", { className: "building-list" }, ...units.map((l) => card(l, () => openDetail(l.url, false, urls)))),
  );
  openSheet("detail");
}

function openSheet(id) {
  const d = $(id);
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

// after opening an apartment, "Hide viewed" and the Viewed tags catch up once it's closed
function refreshViewed() { state.viewedDirty = true; }

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
  state.hoodCounts = new Map(hoods.map((h) => [h, 0]));
  for (const l of state.listings) if (l.status === "ACTIVE" && state.hoodCounts.has(l.neighborhood)) state.hoodCounts.set(l.neighborhood, state.hoodCounts.get(l.neighborhood) + 1);
  state.meta = meta;
  renderStatus();
  refresh();
  if (state.pendingAnnounce?.length) announce(); // changes whose listings just arrived
}

setInterval(() => { if (state.meta) renderStatus(); }, 30_000); // keep "… min ago" current

function renderStatus() {
  const m = state.meta || {};
  const active = state.listings.filter((l) => l.status === "ACTIVE").length;
  // "checked" = the sync last looked for new listings (every minute); "changed" = listings last changed
  const checked = state.checkedAt && (!m.updated_at || state.checkedAt > m.updated_at) ? state.checkedAt : null;
  $("status").textContent = checked
    ? `${active.toLocaleString()} active listings · checked ${ago(checked)} · last change ${ago(m.updated_at)}`
    : `${active.toLocaleString()} active listings · updated ${ago(m.updated_at)}`;
  $("status").title = "Stoopify checks for new and changed listings about every minute.";
}

// ---- saved searches -------------------------------------------------------

function syncSavedSelect() {
  const sel = $("saved");
  const cur = JSON.stringify(currentFilters());
  const match = state.searches.find((s) => JSON.stringify(normalize(s.filters)) === cur);
  sel.value = match ? match.id : "";
  $("delete-search").hidden = !match;
}
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
  if (f.commute2) parts.push(`${f.commute ? "and " : ""}≤ ${f.commute2.minutes} min to ${placeName(f.commute2)}`);
  if (f.lines?.length) parts.push(`near ${f.lines.join("/")}`);
  if (f.walk) parts.push(`≤ ${f.walk} min walk to subway`);
  if (f.features?.length) parts.push(f.features.map((x) => FEATURES[x]?.toLowerCase() || x).join(", "));
  if (f.reason?.length) parts.push(f.reason.map((r) => LABELS[r]?.toLowerCase() || r).join(" or "));
  if (f.delisted) parts.push("incl. delisted");
  if (f.unflagged) parts.push("incl. unflagged");
  if (f.noHazard) parts.push("no hazardous violations");
  if (f.prewar) parts.push("prewar");
  if (f.grade) parts.push(f.grade === "A" ? "grade A buildings" : `grade ${f.grade} or better`);
  if (f.income === "exclude") parts.push("no income limits");
  if (f.income === "only") parts.push("income-restricted only");
  if (f.light) parts.push(f.light === "bright" ? "likely bright" : "some light or better");
  if (f.superfund) parts.push("away from Superfund sites");
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
  renderAlerts();
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
    const bell = el("button", { type: "button", className: "btn ghost small bell", textContent: s.alert ? "🔔 Alerts on" : "🔕 Alerts off" });
    bell.setAttribute("aria-pressed", String(Boolean(s.alert)));
    bell.addEventListener("click", () => setSearchAlert(s.id, !s.alert).catch((e) => message("pf-msg", e.message, true)));
    const rename = el("button", { type: "button", className: "btn ghost small", textContent: "Rename" });
    const del = el("button", { type: "button", className: "btn ghost small", textContent: "Delete" });
    const item = el("li", { className: "saved-item" },
      el("div", { className: "name-row" }, el("span", { className: "name", textContent: s.name }),
        el("span", { className: "count-now", textContent: `${n.toLocaleString()} now` })),
      el("div", { className: "summary", textContent: filterSummary(f) }),
      el("div", { className: "actions" }, run, bell, rename, del));
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
    const searches = await fs.getDocs(fs.query(fs.collection(db, "users", uid, "searches"), fs.limit(100)));
    await Promise.all(searches.docs.map((d) => fs.deleteDoc(d.ref)));
    await fs.deleteDoc(fs.doc(db, "users", uid, "prefs", "main"));
    await forgetThisDevice();
    const devices = await fs.getDocs(fs.query(fs.collection(db, "users", uid, "devices"), fs.limit(20)));
    await Promise.all(devices.docs.map((d) => fs.deleteDoc(d.ref)));
    await fs.deleteDoc(fs.doc(db, "users", uid, "alerts", "settings"));
    const places = await fs.getDocs(fs.query(fs.collection(db, "users", uid, "places"), fs.limit(MAX_PLACES)));
    await Promise.all(places.docs.map((d) => fs.deleteDoc(d.ref)));
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
  $("open-profile").addEventListener("click", () => {
    if (!needAccount()) return; message("pf-msg", ""); renderProfile(); $("profile-dialog").showModal(); });
  $("pf-edit-prefs").addEventListener("click", () => { $("profile-dialog").close(); $("open-prefs").click(); });
  $("pf-save-current").addEventListener("click", () => { $("profile-dialog").close(); $("save-search").click(); });
  $("pf-delete").addEventListener("click", deleteAccount);
  $("pf-push").addEventListener("click", togglePush);
  $("pf-email-alerts").addEventListener("change", (e) => setEmailAlerts(e.target.checked));
}

// ---- alerts -----------------------------------------------------------------
// Push: this browser's Web Push subscription is stored in users/{uid}/devices
// for scripts/notify.mjs. Email: users/{uid}/alerts/settings, only to the
// account's own verified address (the security rules check that).

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const homeScreenApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function deviceId(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const deviceName = () => {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
};
async function currentSubscription() {
  if (DEV || !pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderAlerts() {
  const btn = $("pf-push"), status = $("pf-push-status");
  btn.hidden = false;
  btn.disabled = false;
  if (DEV) { status.textContent = "Not available in the local preview."; btn.disabled = true; }
  else if (!pushSupported()) {
    status.textContent = isIos && !homeScreenApp()
      ? "On iPhone, first add this site to your Home Screen (Share → Add to Home Screen), open it from there, then turn this on."
      : "This browser doesn't support notifications.";
    btn.hidden = true;
  } else if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then come back.";
    btn.hidden = true;
  } else {
    const sub = await currentSubscription();
    status.textContent = sub ? "On. New matches show up here as notifications." : "Off.";
    btn.textContent = sub ? "Turn off" : "Turn on";
    btn.dataset.on = sub ? "1" : "";
  }
  const row = $("pf-email-row");
  row.hidden = DEV || !CONFIG.emailAlerts || !state.user?.email;
  if (!row.hidden) {
    $("pf-email-to").textContent = state.user.emailVerified ? `To ${state.user.email}` : "Verify your email address to turn this on.";
    $("pf-email-alerts").disabled = !state.user.emailVerified;
    $("pf-email-alerts").checked = Boolean(state.alertSettings?.emailOn);
  }
}

async function togglePush() {
  const btn = $("pf-push");
  btn.disabled = true;
  message("pf-msg", "");
  try {
    if (btn.dataset.on) await forgetThisDevice();
    else {
      if (await Notification.requestPermission() !== "granted") throw new Error("Notifications weren't allowed, so alerts can't show on this device.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CONFIG.vapidPublicKey) });
      const { endpoint, keys } = sub.toJSON();
      const { fs, db } = state.fb;
      await fs.setDoc(fs.doc(db, "users", state.user.uid, "devices", await deviceId(endpoint)),
        { endpoint, p256dh: keys.p256dh, auth: keys.auth, ua: deviceName(), created_at: fs.serverTimestamp() });
      if (!state.searches.some((s) => s.alert)) message("pf-msg", "Notifications are on. Turn on 🔔 for a saved search to start getting alerts.");
    }
  } catch (e) { message("pf-msg", `Couldn't change notifications: ${e.message}`, true); }
  await renderAlerts();
}

/** Stop alerts on this browser: unsubscribe and remove it from the account. */
async function forgetThisDevice() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  if (state.fb && state.user) {
    const { fs, db } = state.fb;
    await fs.deleteDoc(fs.doc(db, "users", state.user.uid, "devices", await deviceId(sub.endpoint))).catch(() => {});
  }
  await sub.unsubscribe().catch(() => {});
}

async function setEmailAlerts(on) {
  const { fs, db } = state.fb;
  try {
    await fs.setDoc(fs.doc(db, "users", state.user.uid, "alerts", "settings"),
      { emailOn: on, email: state.user.email, updated_at: fs.serverTimestamp() });
  } catch (e) { message("pf-msg", `Couldn't change email alerts: ${e.code || e.message}`, true); }
}

function listenAlertSettings() {
  if (!CONFIG.emailAlerts) return;
  const { fs, db } = state.fb;
  state.unsub.push(fs.onSnapshot(fs.doc(db, "users", state.user.uid, "alerts", "settings"), (snap) => {
    state.alertSettings = snap.data() || null;
    if ($("profile-dialog").open) renderAlerts();
  }));
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
  const saved = findPlace(state.commuteTo);
  message("c-msg", state.commuteTo ? `Estimated by subway to ${saved ? saved.alias : placeName(state.commuteTo)}` : "");
  showSavePlace();
  if (!quiet) refresh();
}

/** Minutes of the longer trip when two places are set (sorting); unknown last. */
function longestCommute(l) {
  const ts = [l._c, l._c2].filter(Boolean).map((t) => t.minutes);
  return ts.length ? Math.max(...ts) : Infinity;
}

/** The optional second commute place: both trips must fit (e.g. two partners' jobs). */
function setCommute2(to, { quiet = false } = {}) {
  state.commuteTo2 = to ? { label: to.label, lat: to.lat, lng: to.lng, minutes: to.minutes } : null;
  const show = Boolean(state.commuteTo2) || state.c2Open;
  $("c2-row").hidden = !show;
  $("c2-add").hidden = show;
  if (state.commuteTo2) {
    $("c2-place").value = state.commuteTo2.label;
    $("c2-minutes").value = String(state.commuteTo2.minutes);
    if (!state.sortTouched && !hasPrefs(state.prefs)) $("sort").value = "commute";
  } else if (!show) $("c2-place").value = "";
  const saved = findPlace(state.commuteTo2);
  message("c2-msg", state.commuteTo2 ? `And to ${saved ? saved.alias : placeName(state.commuteTo2)}: only places where both trips fit` : "");
  if (!quiet) refresh();
}

function wireSecondCommute() {
  const set = (g) => setCommute2({ label: g.label.slice(0, 120), lat: g.lat, lng: g.lng, minutes: Number($("c2-minutes").value) });
  attachSuggest($("c2-place"), set);
  const find = async () => {
    const q = $("c2-place").value.trim();
    if (!q) return;
    message("c2-msg", "Looking it up…");
    try {
      const g = await geocode(q);
      if (!g) { message("c2-msg", "Couldn't find that address in NYC.", true); return; }
      set(g);
    } catch (e) { message("c2-msg", `Lookup failed: ${e.message}`, true); }
  };
  $("c2-add").addEventListener("click", () => { state.c2Open = true; setCommute2(null, { quiet: true }); $("c2-place").focus(); });
  $("c2-set").addEventListener("click", find);
  $("c2-place").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });
  $("c2-minutes").addEventListener("change", () => {
    if (state.commuteTo2) setCommute2({ ...state.commuteTo2, minutes: Number($("c2-minutes").value) });
  });
  $("c2-remove").addEventListener("click", () => { state.c2Open = false; setCommute2(null); });
}

// ---- saved places (nicknamed addresses) -------------------------------------
// In the account when signed in (users/{uid}/places), on this device otherwise;
// a guest's places move into the account at sign-in.

const MAX_PLACES = 20;
const localPlaces = () => { try { return JSON.parse(store.get("places") || "[]"); } catch { return []; } };
const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
const findPlace = (g) => g && state.places.find((p) => samePlace(p, g));

function setPlaces(list) {
  state.places = list.map((p) => ({ ...p, label: niceAddress(p.label) })).sort((a, b) => a.alias.localeCompare(b.alias));
  for (const id of ["c-place", "c2-place", "p-near", "np-address"]) $(id).dispatchEvent(new Event("places-changed"));
  showSavePlace();
  $("places-count").hidden = !state.places.length;
  $("places-count").textContent = String(state.places.length);
  if ($("places-dialog").open) renderPlacesList();
}

async function savePlace(alias, g) {
  const p = { alias: alias.slice(0, 40), label: g.label.slice(0, 120), lat: g.lat, lng: g.lng };
  if (state.places.length >= MAX_PLACES) throw new Error(`You can save up to ${MAX_PLACES} places.`);
  if (signedIn() && !DEV) {
    const { fs, db } = state.fb;
    await fs.addDoc(fs.collection(db, "users", state.user.uid, "places"), { ...p, created_at: fs.serverTimestamp() });
  } else {
    const list = [...localPlaces(), { id: String(Date.now()), ...p }];
    store.set("places", JSON.stringify(list));
    setPlaces(list);
  }
}

async function forgetPlace(id) {
  if (signedIn() && !DEV) {
    const { fs, db } = state.fb;
    await fs.deleteDoc(fs.doc(db, "users", state.user.uid, "places", id));
  } else {
    const list = localPlaces().filter((p) => p.id !== id);
    store.set("places", JSON.stringify(list));
    setPlaces(list);
  }
}

function listenPlaces() {
  const { fs, db } = state.fb;
  const col = fs.collection(db, "users", state.user.uid, "places");
  // bring along places saved before signing in
  const guest = localPlaces();
  if (guest.length) {
    Promise.all(guest.slice(0, MAX_PLACES).map(({ id, ...p }) => fs.addDoc(col, { ...p, created_at: fs.serverTimestamp() })))
      .then(() => store.remove("places")).catch(() => {});
  }
  state.unsub.push(fs.onSnapshot(fs.query(col, fs.limit(MAX_PLACES)),
    (snap) => setPlaces(snap.docs.map((d) => ({ id: d.id, ...d.data() })))));
}

/** "Save place" shows under the commute box when its address isn't saved yet. */
function showSavePlace() {
  const g = state.commuteTo;
  $("c-save-place").hidden = !g || !!findPlace(g);
}

/**
 * Neighborhood box: a list of neighborhoods with how many apartments each has,
 * narrowed as you type (names that start with the text first). Picked ones are left out.
 */
function attachHoodPicker(input, picked, onPick) {
  const list = el("ul", { className: "suggest hood-suggest", role: "listbox", hidden: true });
  list.id = `${input.id}-list`;
  input.setAttribute("aria-controls", list.id);
  (input.closest("dialog") || document.body).append(list);
  let items = [], active = -1;
  const place = () => {
    const r = input.getBoundingClientRect();
    Object.assign(list.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, width: `${Math.max(r.width, 260)}px` });
  };
  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  const pick = (h) => { onPick(h); input.value = ""; render(); };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const have = picked();
    const all = [...(state.hoodCounts || new Map()).keys()].filter((h) => !have.includes(h));
    const starts = all.filter((h) => h.toLowerCase().startsWith(q));
    const contains = all.filter((h) => !h.toLowerCase().startsWith(q) && h.toLowerCase().includes(q));
    items = [...starts, ...contains];
    list.replaceChildren(...items.map((h, i) => {
      const n = state.hoodCounts.get(h);
      const li = el("li", { role: "option" }, el("span", { textContent: h }), el("span", { className: "hood-n", textContent: `${n} apt${n === 1 ? "" : "s"}` }));
      li.id = `${list.id}-${i}`;
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => pick(h));
      return li;
    }), ...(items.length ? [] : [el("li", { className: "note", textContent: q ? "No neighborhood by that name has listings" : "All neighborhoods picked" })]));
    active = q && items.length ? 0 : -1;
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    place();
  };
  const move = (d) => {
    if (list.hidden || !items.length) return;
    active = (active + d + items.length) % items.length;
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("focus", render);
  input.addEventListener("click", () => { if (list.hidden) render(); });
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) render(); else move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Escape" && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) pick(items[active]); }
  });
  addEventListener("resize", () => { if (!list.hidden) place(); });
  addEventListener("scroll", () => { if (!list.hidden) place(); }, true);
}

/**
 * Suggestions under an address box: saved places that match first, then NYC
 * addresses as you type. onPick({ label, lat, lng, alias? }).
 */
function attachSuggest(input, onPick) {
  const list = el("ul", { className: "suggest", role: "listbox", hidden: true });
  list.id = `${input.id}-suggest`;
  input.setAttribute("aria-controls", list.id);
  // inside a pop-up the list must live in it too, or it's drawn behind the pop-up
  (input.closest("dialog") || document.body).append(list);
  let items = [], active = -1, timer, ctrl, seq = 0;

  const place = () => {
    const r = input.getBoundingClientRect();
    Object.assign(list.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, width: `${Math.max(r.width, 300)}px` });
  };
  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
  const pick = (g) => { close(); onPick(g); };
  const render = (addresses = [], note = "") => {
    const q = input.value.trim().toLowerCase();
    const saved = state.places.filter((p) => !q || p.alias.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
    items = [...saved.map((p) => ({ ...p, saved: true })), ...addresses.filter((a) => !saved.some((p) => samePlace(p, a)))];
    list.replaceChildren(...items.map((g, i) => {
      const li = el("li", { role: "option" });
      li.id = `${list.id}-${i}`;
      if (g.saved) {
        const forget = el("button", { type: "button", className: "forget", textContent: "×", title: `Forget ${g.alias}` });
        forget.setAttribute("aria-label", `Forget ${g.alias}`);
        forget.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        forget.addEventListener("click", (e) => { e.stopPropagation(); forgetPlace(g.id).catch((err) => toast(err.message)); });
        li.append(el("span", {}, el("span", { className: "alias", textContent: g.alias }), el("span", { className: "addr-line", textContent: g.label })), forget);
      } else li.append(el("span", { textContent: g.label }));
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
      li.addEventListener("click", () => pick(g));
      return li;
    }), ...(note ? [el("li", { className: "note", textContent: note })] : []));
    active = -1;
    const open = items.length > 0 || !!note;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (open) place();
  };
  const lookup = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { render(); return; }
    render([], "Searching NYC addresses…");
    timer = setTimeout(async () => {
      ctrl?.abort(); ctrl = new AbortController();
      const mine = ++seq;
      try {
        const found = await suggest(q, ctrl.signal);
        if (mine === seq && document.activeElement === input) render(found, found.length ? "" : "No NYC address found");
      } catch (e) { if (e.name !== "AbortError" && mine === seq) render([], "Address lookup isn't available right now"); }
    }, 200);
  };
  const move = (d) => {
    if (list.hidden || !items.length) return;
    active = (active + d + items.length) % items.length;
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", lookup);
  input.addEventListener("focus", () => render());
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("places-changed", () => { if (document.activeElement === input) render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Escape" && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
  });
  addEventListener("resize", () => { if (!list.hidden) place(); });
  addEventListener("scroll", () => { if (!list.hidden) place(); }, true);
}

function wirePlaces() {
  let pending = null;
  $("c-save-place").addEventListener("click", () => {
    pending = state.commuteTo;
    if (!pending) return;
    $("place-address").textContent = pending.label;
    $("place-alias").value = "";
    message("place-msg", "");
    $("place-dialog").showModal();
  });
  $("place-cancel").addEventListener("click", () => $("place-dialog").close());
  $("place-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alias = $("place-alias").value.trim();
    if (!alias || !pending) return;
    try {
      await savePlace(alias, pending);
      $("place-dialog").close();
      toast(`Saved "${alias}". Pick it from the address box any time.`);
    } catch (err) { message("place-msg", `Couldn't save: ${err.code || err.message}`, true); }
  });
  wirePlacesDialog();
  setPlaces(localPlaces());
}

/** "My places": see, use, remove and add nicknamed addresses. */
function wirePlacesDialog() {
  let picked = null;
  attachSuggest($("np-address"), (g) => {
    picked = { label: g.label.slice(0, 120), lat: g.lat, lng: g.lng };
    $("np-address").value = picked.label;
    if (g.alias) message("np-msg", `That's already saved as "${g.alias}".`);
    else $("np-alias").focus();
  });
  $("np-address").addEventListener("input", () => { picked = null; message("np-msg", ""); });
  $("open-places").addEventListener("click", () => {
    renderPlacesList();
    picked = null;
    $("add-place-form").reset();
    message("np-msg", "");
    $("places-dialog").showModal();
    if (!state.places.length) $("np-address").focus();
  });
  $("places-close").addEventListener("click", () => $("places-dialog").close());
  $("add-place-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alias = $("np-alias").value.trim(), text = $("np-address").value.trim();
    if (!alias || !text) return;
    if (state.places.some((p) => p.alias.toLowerCase() === alias.toLowerCase())) {
      message("np-msg", `You already have a place called "${alias}".`, true); return;
    }
    try {
      let g = picked;
      if (!g) {
        message("np-msg", "Looking it up…");
        g = await geocode(text);
        if (!g) { message("np-msg", "Couldn't find that address in NYC.", true); return; }
      }
      if (findPlace(g)) { message("np-msg", `That address is already saved as "${findPlace(g).alias}".`, true); return; }
      await savePlace(alias, g);
      picked = null;
      $("add-place-form").reset();
      message("np-msg", `Saved "${alias}".`);
      $("np-address").focus();
    } catch (err) { message("np-msg", `Couldn't save: ${err.code || err.message}`, true); }
  });
}

function renderPlacesList() {
  $("places-empty").hidden = state.places.length > 0;
  $("places-list").replaceChildren(...state.places.map((p) => {
    const use = el("button", { type: "button", className: "btn ghost small", textContent: "Use" });
    use.setAttribute("aria-label", `Filter by commute to ${p.alias}`);
    use.addEventListener("click", () => {
      setCommute({ label: p.label, lat: p.lat, lng: p.lng, minutes: Number($("c-minutes").value) });
      $("places-dialog").close();
    });
    const remove = el("button", { type: "button", className: "btn ghost small", textContent: "Remove" });
    remove.setAttribute("aria-label", `Remove ${p.alias}`);
    remove.addEventListener("click", () => forgetPlace(p.id).catch((err) => toast(err.message)));
    const on = state.commuteTo && samePlace(p, state.commuteTo);
    return el("li", { className: on ? "on" : "" },
      el("span", { className: "place-text" }, el("span", { className: "alias", textContent: p.alias }), el("span", { className: "addr-line", textContent: p.label })),
      el("span", { className: "place-actions" }, use, remove));
  }));
}

function wireCommuteFilter() {
  attachSuggest($("c-place"), (g) => {
    setCommute({ label: g.label.slice(0, 120), lat: g.lat, lng: g.lng, minutes: Number($("c-minutes").value) });
  });
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
const seenKey = () => `events-seen-${state.user?.uid || "guest"}`;

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
  state.dataUnsub.push(fs.onSnapshot(q, (snap) => {
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
  attachHoodPicker($("p-hood-input"), () => draft.hoods, (h) => { if (!draft.hoods.includes(h)) { draft.hoods.push(h); renderHoods(); } });

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
  attachSuggest($("p-near"), (g) => {
    draft.near = { label: g.label.slice(0, 120), lat: g.lat, lng: g.lng, minutes: Number($("p-minutes").value) };
    $("p-near").value = g.alias || g.label;
    renderNear();
  });
  $("p-near-find").addEventListener("click", findNear);
  $("p-near").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findNear(); } });
  $("p-minutes").addEventListener("change", () => { if (draft.near) draft.near.minutes = Number($("p-minutes").value); });
  $("p-near-clear").addEventListener("click", () => { draft.near = null; $("p-near").value = ""; renderNear(); });

  $("open-prefs").addEventListener("click", () => {
    if (!needAccount()) return;
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
  // App Check proves requests come from this site (not a script with a copied
  // login); once enforced in the Firebase console, other callers are refused.
  if (CONFIG.appCheckSiteKey) {
    const ac = await import(`${SDK}/firebase-app-check.js`);
    ac.initializeAppCheck(app, {
      provider: new ac.ReCaptchaEnterpriseProvider(CONFIG.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
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

  // stop this browser's alerts first, so a shared computer doesn't keep getting them
  for (const b of document.querySelectorAll(".sign-out")) b.addEventListener("click", async () => { await forgetThisDevice(); auth.signOut(a); });
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

/** Signed in with a usable account (email accounts must verify first). */
const signedIn = () => !!state.user && (state.user.emailVerified
  || !state.user.providerData.some((p) => p.providerId === "password"));

/** Saving and alerts need an account: send guests to sign in. */
function needAccount() {
  if (DEV || signedIn()) return true;
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  message("auth-msg", "");
  show(state.user ? "verify" : "login");
  return false;
}

function onUser(user) {
  stopListeners();
  state.user = user;
  state.searches = []; state.alertSettings = null;
  if (!signedIn()) {
    // browsing works without an account; only the account features are off
    $("profile-dialog").close();
    $("sign-in").hidden = false;
    $("open-profile").hidden = true;
    setPrefs(null);
    setPlaces(localPlaces());
    renderSaved();
    renderFeed();
    if (user) { $("verify-email").textContent = user.email; show("verify"); } // just created an email account
    else show("app");
    return;
  }
  $("sign-in").hidden = true;
  $("open-profile").hidden = false;
  $("avatar-initial").textContent = (user.displayName || user.email || "?").trim()[0].toUpperCase();
  show("app");
  listenSearches();
  listenPrefs();
  listenAlertSettings();
  listenPlaces();
  renderFeed();
}

/** listings are split across a few documents; meta/status says which version is current */
function listenListings() {
  const { fs, db } = state.fb;
  let version = null;
  state.dataUnsub.push(fs.onSnapshot(fs.doc(db, "meta", "status"), async (snap) => {
    const meta = snap.data();
    if (!meta) { setData([], {}); return; }
    if (meta.version === version) { state.meta = meta; renderStatus(); return; }
    version = meta.version;
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => fs.getDoc(fs.doc(db, "listings", `c${i}`))));
    const listings = chunks.flatMap((c) => (c.exists() && c.data().version === meta.version ? JSON.parse(c.data().json) : []));
    setData(listings, meta);
  }, (err) => { $("status").textContent = `Couldn't load listings: ${err.code || err.message}`; }));
  // when the sync last checked, even if nothing changed (optional: older rules may not allow it)
  state.dataUnsub.push(fs.onSnapshot(fs.doc(db, "meta", "heartbeat"), (snap) => {
    const t = snap.data()?.checked_at;
    state.checkedAt = t?.toDate ? t.toDate().toISOString() : null;
    if (state.meta) renderStatus(); // the listings themselves may still be loading
  }, () => {}));
}

function listenSearches() {
  const { fs, db } = state.fb;
  const q = fs.query(fs.collection(db, "users", state.user.uid, "searches"), fs.orderBy("created_at", "desc"), fs.limit(100));
  state.unsub.push(fs.onSnapshot(q, (snap) => {
    state.searches = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSaved();
  }));
}

async function saveSearch(name, alert) {
  if (DEV) {
    state.searches.unshift({ id: String(Date.now()), name, alert, filters: currentFilters() });
    renderSaved();
    return;
  }
  const { fs, db } = state.fb;
  await fs.addDoc(fs.collection(db, "users", state.user.uid, "searches"),
    { name, alert, filters: currentFilters(), created_at: fs.serverTimestamp() });
}

async function setSearchAlert(id, alert) {
  if (DEV) { const s = state.searches.find((x) => x.id === id); if (s) s.alert = alert; renderSaved(); return; }
  const { fs, db } = state.fb;
  await fs.updateDoc(fs.doc(db, "users", state.user.uid, "searches", id), { alert });
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

/** Map dots: "separate" (every apartment, the default) or "building". */
function grouping() {
  const v = store.get("grouping");
  return GROUPINGS.includes(v) ? v : "separate";
}
function showGrouping() {
  const v = grouping();
  for (const b of $("grouping").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.v === v);
    b.setAttribute("aria-pressed", String(b.dataset.v === v));
  }
}

let mapPromise;
function ensureMap() {
  mapPromise ??= createMap($("map"), {
    googleKey: CONFIG.googleMapsKey,
    googleMapId: CONFIG.googleMapId,
    onSelect: (url) => openDetail(url),
    onSelectBuilding: (urls) => openBuilding(urls),
    onMove: (b) => { state.bounds = b; state.shown = PAGE; renderList(); },
    grouping: grouping(),
  }).then((m) => {
    state.map = m;
    m.setListings(state.filtered);
    if ($("show-hoods").checked) m.setNeighborhoods(true).catch((e) => toast(e.message));
    return m;
  })
    .catch((e) => { $("map").textContent = `Map unavailable: ${e.message}`; });
  return mapPromise;
}

// ---- wire up ----------------------------------------------------------------

function wireUi() {
  wirePrefs();
  wireProfile();
  wireFeed();
  wirePlaces();
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  attachHoodPicker($("hood-input"), () => state.hoods, (h) => {
    if (!state.hoods.includes(h)) { state.hoods.push(h); renderChips(); refresh({ fit: true }); }
  });
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
  for (const id of ["delisted", "unflagged", "no-hazard", "prewar", "walk", "grade", "income", "light", "superfund"]) $(id).addEventListener("change", refresh);
  wireCommuteFilter();
  wireSecondCommute();
  $("more").addEventListener("click", () => { state.shown += PAGE; renderList(); });

  $("saved").addEventListener("change", () => {
    const s = state.searches.find((x) => x.id === $("saved").value);
    if (s) applyFilters(normalize(s.filters));
  });
  $("save-search").addEventListener("click", () => {
    if (!needAccount()) return;
    $("save-name").value = "";
    message("save-msg", "");
    $("save-dialog").showModal();
  });
  $("save-cancel").addEventListener("click", () => $("save-dialog").close());
  $("save-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("save-name").value.trim().slice(0, 80);
    if (!name) return;
    try {
      const alert = $("save-alert").checked;
      await saveSearch(name, alert);
      $("save-dialog").close();
      if (alert && !DEV && pushSupported() && !(await currentSubscription())) toast("Saved. Turn on notifications under My profile → Alerts to get alerts on this device.");
    }
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

  $("days").addEventListener("change", refresh);
  $("clear-filters").addEventListener("click", () => {
    $("hood-input").value = "";
    $("saved").value = "";
    applyFilters({});
    toast("Filters cleared");
  });
  // how dots are grouped on the map, remembered on this device
  showGrouping();
  $("grouping").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    store.set("grouping", b.dataset.v);
    showGrouping();
    state.map?.setGrouping(b.dataset.v);
  });
  $("show-hoods").checked = store.get("hoods") === "on";
  $("show-hoods").addEventListener("change", () => {
    store.set("hoods", $("show-hoods").checked ? "on" : "off");
    state.map?.setNeighborhoods($("show-hoods").checked).catch((e) => toast(e.message));
  });
  $("hide-viewed").addEventListener("change", refresh);
  $("in-view").addEventListener("change", () => { state.shown = PAGE; renderList(); });
  $("detail").addEventListener("close", () => {
    if (!state.viewedDirty) return;
    state.viewedDirty = false;
    if ($("hide-viewed").checked) refresh(); else renderList();
  });
  $("sign-in").addEventListener("click", () => { message("auth-msg", ""); show("login"); });
  for (const b of document.querySelectorAll(".back-to-map")) b.addEventListener("click", () => show("app"));
  wireTheme();
  closeOnOutsideClick();
}

// Every pop-up closes when you click outside it.
function closeOnOutsideClick() {
  for (const d of document.querySelectorAll("dialog")) {
    let downOutside = false;
    const outside = (e) => {
      const r = d.getBoundingClientRect();
      return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    d.addEventListener("pointerdown", (e) => { downOutside = outside(e); });
    d.addEventListener("click", (e) => { if (downOutside && outside(e)) d.close(); downOutside = false; });
  }
}

// ---- theme ------------------------------------------------------------------

function wireTheme() {
  const root = document.documentElement;
  const render = () => {
    const mode = root.dataset.theme || "auto";
    for (const b of $("theme-mode").querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === mode);
    document.querySelector(`input[name=palette][value=${root.dataset.palette || "default"}]`).checked = true;
    const icon = mode === "dark" ? "☾" : mode === "light" ? "☀" : "◐";
    $("open-theme").replaceChildren(el("span", { className: "theme-icon", textContent: icon }), el("span", { className: "theme-word", textContent: "Theme" }));
  };
  const apply = () => { render(); state.map?.setTheme(); };
  $("open-theme").addEventListener("click", () => { render(); $("theme-dialog").showModal(); });
  $("theme-mode").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    if (v === "auto") { delete root.dataset.theme; store.remove("theme"); } else { root.dataset.theme = v; store.set("theme", v); }
    apply();
  });
  for (const r of document.querySelectorAll("input[name=palette]")) r.addEventListener("change", () => {
    if (r.value === "default") { delete root.dataset.palette; store.remove("palette"); } else { root.dataset.palette = r.value; store.set("palette", r.value); }
    apply();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!root.dataset.theme) state.map?.setTheme(); });
  render();
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
  // listings are public: show the map straight away, signed in or not
  show("app");
  ensureMap();
  listenListings();
  listenEvents();
  wireAuth(state.fb);
}

main();
