// Rent Stabilized NYC (hosted): sign-in gate, live listings from Firestore,
// map + list with filters, and per-user saved searches.
import { CONFIG } from "./config.js";
import { createMap } from "./map.js";

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

function currentFilters() {
  const f = {};
  if (state.hoods.length) f.hoods = [...state.hoods];
  if (state.beds !== "") f.beds = state.beds;
  if ($("min").value) f.min = Number($("min").value);
  if ($("max").value) f.max = Number($("max").value);
  if ($("reason").value) f.reason = $("reason").value;
  if ($("delisted").checked) f.delisted = true;
  if ($("unflagged").checked) f.unflagged = true;
  return f;
}

function applyFilters(f) {
  state.hoods = f.hoods ? [...f.hoods] : [];
  state.beds = f.beds ?? "";
  for (const b of $("beds").children) b.classList.toggle("on", b.dataset.v === state.beds);
  $("min").value = f.min ?? "";
  $("max").value = f.max ?? "";
  $("reason").value = f.reason ?? "";
  $("delisted").checked = !!f.delisted;
  $("unflagged").checked = !!f.unflagged;
  renderChips();
  refresh({ fit: true });
}

function matches(l, f) {
  if (!f.delisted && l.status !== "ACTIVE") return false;
  if (!f.unflagged && !l.reasons.length) return false;
  if (f.hoods && !f.hoods.includes(l.neighborhood)) return false;
  if (f.beds !== undefined) {
    const b = Number(f.beds);
    if (l.beds == null || (b === 4 ? l.beds < 4 : l.beds !== b)) return false;
  }
  if (f.min !== undefined && !(l.price >= f.min)) return false;
  if (f.max !== undefined && !(l.price <= f.max)) return false;
  if (f.reason && !l.reasons.includes(f.reason)) return false;
  return true;
}

function refresh({ fit = false } = {}) {
  const f = currentFilters();
  state.filtered = state.listings.filter((l) => matches(l, f));
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
    const meta = [l.status === "DELISTED" ? `Delisted ${day(l.delisted_at)}` : `Listed ${day(l.first_seen)}`];
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
  hist.createTHead().append(el("tr", {}, ...["Date", "Price", "Days listed"].map((t) => el("th", { textContent: t }))));
  const tb = hist.createTBody();
  for (const s of l.data || []) {
    tb.append(el("tr", {},
      el("td", { textContent: new Date(s.scraped_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) }),
      el("td", { textContent: money(s.price) }),
      el("td", { textContent: s.time_on_market ?? "—" })));
  }
  const compare = sameSet(l.reasons, l.reasier_reasons || [])
    ? ""
    : `Reasier flags it as: ${(l.reasier_reasons || []).map((r) => LABELS[r] || r).join(", ") || "not stabilized"}.`;
  $("detail-body").replaceChildren(
    el("div", { className: "detail-head" },
      el("h2", { textContent: `${money(l.price)} · ${l.neighborhood || ""}` }), open),
    el("div", { className: "addr", textContent: [l.address, layout(l)].filter(Boolean).join(" · ") }),
    badges(l.reasons),
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

function setData(listings, meta) {
  state.listings = listings
    .map((l) => ({ ...l, reasons: l.reasons || [] }))
    .sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""));
  const hoods = [...new Set(state.listings.filter((l) => l.status === "ACTIVE").map((l) => l.neighborhood).filter(Boolean))].sort();
  $("hoods").replaceChildren(...hoods.map((h) => el("option", { value: h })));
  state.meta = meta;
  renderStatus();
  refresh();
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
  for (const k of ["hoods", "beds", "min", "max", "reason", "delisted", "unflagged"]) if (f?.[k] !== undefined) o[k] = f[k];
  return o;
};

function renderSaved() {
  $("saved").replaceChildren(el("option", { value: "", textContent: state.searches.length ? "Choose…" : "None yet" }),
    ...state.searches.map((s) => el("option", { value: s.id, textContent: s.name })));
  syncSavedSelect();
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
  $("who").textContent = user.email || user.displayName || "";
  show("app");
  ensureMap();
  listenListings();
  listenSearches();
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
  $("beds").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of $("beds").children) x.classList.toggle("on", x === b);
    state.beds = b.dataset.v;
    refresh();
  });
  let t;
  for (const id of ["min", "max"]) $(id).addEventListener("input", () => { clearTimeout(t); t = setTimeout(refresh, 200); });
  for (const id of ["reason", "delisted", "unflagged"]) $(id).addEventListener("change", refresh);
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
  if ("serviceWorker" in navigator && !DEV) navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (DEV) {
    $("who").textContent = "local preview";
    show("app");
    await ensureMap();
    const data = await (await fetch(CONFIG.devData)).json();
    setData(data.listings, { updated_at: data.generated_at });
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
