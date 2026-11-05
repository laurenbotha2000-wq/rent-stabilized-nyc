// End-to-end walkthrough of the site with Playwright. Screenshots go to e2e/shots/.
//
//   PREVIEW_URL=http://127.0.0.1:8790 LIVE_URL=https://rent-stabilized-nyc.web.app node walkthrough.mjs
//
// PREVIEW_URL is the local preview (config with devData: real data, no sign-in).
// LIVE_URL is checked signed out: the map loads without an account, and saving asks to sign in.
// ONLY=preview skips the live site (e.g. before a deploy); ONLY=live checks just the live site
// (e.g. right after a deploy). `bash e2e/preview.sh` serves the preview from web/ + e2e/fixtures/.
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { chromium } from "playwright";

const PREVIEW = process.env.PREVIEW_URL || "http://127.0.0.1:8790";
const LIVE = process.env.LIVE_URL || "https://rent-stabilized-nyc.web.app";
const ONLY = process.env.ONLY || "";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

// use an already-installed Playwright Chromium if the bundled build isn't downloaded
function browserPath() {
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  const dir = existsSync(cache) && readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().pop();
  return dir ? `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` : undefined;
}

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`); };
const count = async (page) => Number(((await page.textContent("#summary")) || "0").replace(/[^\d].*$/s, "").replace(/,/g, "")) || 0;

// Layout: boxes that should line up, measured in the page (px, rounded)
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
async function alignment(page) {
  return page.evaluate(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
    const visible = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
    const fields = [...document.querySelectorAll("#filters .filter-row > .field, #filters .filter-row > fieldset")].filter(visible);
    const lineOf = (sel) => {
      const fs = [...document.querySelectorAll(`${sel} > .field, ${sel} > fieldset`)].filter(visible);
      const top = Math.min(...fs.map((f) => box(f).t));
      return fs.filter((f) => Math.abs(box(f).t - top) < 30);
    };
    const row = lineOf("#filter-main"), row2 = lineOf("#filter-extra");
    const ctl = (f) => [...f.querySelectorAll("input:not([type=checkbox]), select, .seg, button:not(.link)")].find(visible);
    const lab = (f) => f.querySelector(":scope > span, :scope > legend");
    const overlaps = [];
    for (let i = 0; i < fields.length; i++) for (let j = i + 1; j < fields.length; j++) {
      const a = box(fields[i]), b = box(fields[j]);
      if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push(`${lab(fields[i])?.textContent} / ${lab(fields[j])?.textContent}`);
    }
    // controls inside a field must not spill out of it (e.g. a button pushed past its neighbor)
    const spills = fields.filter((f) => [...f.querySelectorAll("input, select, button")].filter(visible)
      .some((c) => box(c).r > box(f).r + 1)).map((f) => lab(f)?.textContent);
    const header = [...document.querySelectorAll(".top .account > *")].filter(visible).map(box);
    return {
      labelTops: row.map((f) => lab(f) ? Math.round(box(lab(f)).t) : null).filter((x) => x != null),
      controlTops: row.map((f) => ctl(f) && Math.round(box(ctl(f)).t)).filter(Boolean),
      controlHeights: row.map((f) => ctl(f) && Math.round(box(ctl(f)).h)).filter(Boolean),
      row2LabelTops: row2.map((f) => lab(f) ? Math.round(box(lab(f)).t) : null).filter((x) => x != null),
      row2ControlTops: row2.map((f) => ctl(f) && Math.round(box(ctl(f)).t)).filter(Boolean),
      rightEdges: ["#toggle-more", "#save-search"].map((q) => document.querySelector(q)).filter(visible).map((e) => Math.round(box(e).r)),
      overlaps, spills,
      headerTops: header.map((b) => Math.round(b.t)), headerHeights: header.map((b) => Math.round(b.h)),
    };
  });
}
const allSame = (xs, tol = 1) => xs.length > 0 && xs.every((x) => near(x, xs[0], tol));

const browser = await chromium.launch({ executablePath: browserPath() });

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: "light" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  page.on("pageerror", (e) => page.errors.push(String(e)));
  return page;
}

// ---- desktop, local preview ---------------------------------------------------
if (ONLY !== "live") {
  const page = await newPage({ width: 1280, height: 860 });
  await page.goto(PREVIEW);
  await page.waitForFunction(() => /apartments|map area/.test(document.querySelector("#summary")?.textContent || ""), null, { timeout: 20000 });
  await page.waitForTimeout(2500); // map tiles
  const a = await alignment(page);
  check("filter labels on one line", allSame(a.labelTops), a.labelTops.join(","));
  check("filter controls on one line", allSame(a.controlTops), a.controlTops.join(","));
  check("filter controls same height", allSame(a.controlHeights), a.controlHeights.join(","));
  check("filters don't overlap", !a.overlaps.length && !a.spills.length, [...a.overlaps, ...a.spills].join("; "));
  check("second filter row lines up", allSame(a.row2LabelTops) && allSame(a.row2ControlTops), `${a.row2LabelTops} / ${a.row2ControlTops}`);
  check("More filters and Save line up on the right", a.rightEdges.length === 2 && allSame(a.rightEdges, 2), a.rightEdges.join(","));
  check("header buttons line up", allSame(a.headerTops) && allSame(a.headerHeights), `${a.headerTops} / ${a.headerHeights}`);
  check("compass (north) control", await page.locator(".maplibregl-ctrl-compass").count() === 1);
  await page.uncheck("#in-view"); // count the whole city below
  const all = await count(page);
  check("listings load", all > 100, `${all} apartments`);
  check("map renders", await page.locator("#map canvas").count() > 0);
  await page.screenshot({ path: `${SHOTS}01-home.png` });

  // multi-select filters
  await page.click('#beds button[data-v="1"]');
  await page.click('#beds button[data-v="2"]');
  const beds12 = await count(page);
  check("bedrooms multi-select (1 + 2)", beds12 > 0 && beds12 < all, `${beds12}`);
  await page.click('#beds button[data-v="1"]');
  const beds2 = await count(page);
  check("toggling a bedroom off narrows results", beds2 < beds12, `${beds2}`);
  await page.click('#beds button[data-v=""]');
  check("Any clears bedrooms", (await count(page)) === all);

  check("more filters collapsed by default", await page.isHidden("#more-filters"));
  await page.click("#toggle-more");
  check("more filters opens", await page.isVisible("#feat-filter"));
  await page.click('#reasons button[data-v="UNEVEN_PRICE"]');
  await page.click('#reasons button[data-v="RENT_STABILIZED_TEXT_IN_LISTING"]');
  const anyOf = await count(page);
  check("reasons are any-of", anyOf > 0 && anyOf <= all, `${anyOf}`);
  await page.click('#feat-filter button[data-v="dishwasher"]');
  const dw = await count(page);
  await page.click('#feat-filter button[data-v="elevator"]');
  const dwEl = await count(page);
  check("amenities are all-of", dwEl <= dw && dw < anyOf, `dishwasher ${dw}, +elevator ${dwEl}`);
  await page.screenshot({ path: `${SHOTS}02-filters.png` });
  for (const sel of ['#reasons button[data-v="UNEVEN_PRICE"]', '#reasons button[data-v="RENT_STABILIZED_TEXT_IN_LISTING"]',
    '#feat-filter button[data-v="dishwasher"]', '#feat-filter button[data-v="elevator"]']) await page.click(sel);
  check("filters reset", (await count(page)) === all);

  // saved search with multi-select values
  await page.click('#beds button[data-v="1"]');
  await page.click("#save-search");
  await page.fill("#save-name", "1BR test");
  check("save dialog offers alerts (on by default)", await page.isChecked("#save-alert"));
  await page.press("#save-name", "Enter");
  await page.waitForTimeout(300);
  check("saved search stored and selected", (await page.$eval("#saved", (s) => s.selectedOptions[0]?.textContent)) === "1BR test");
  await page.click('#beds button[data-v=""]');

  // subway filters (no preferences set yet)
  await page.waitForFunction(() => document.querySelectorAll("#lines button").length > 10, null, { timeout: 10000 });
  check("subway line toggles load", true, `${await page.locator("#lines button").count()} lines`);
  await page.selectOption("#walk", "5");
  const walk5 = await count(page);
  check("walk ≤ 5 min narrows results", walk5 > 0 && walk5 < all, `${walk5}`);
  await page.selectOption("#walk", "");
  await page.click('#lines button[data-v="L"]');
  const lineL = await count(page);
  await page.click('#lines button[data-v="G"]');
  const lineLG = await count(page);
  check("lines are any-of (L, then L or G)", lineL > 0 && lineL < all && lineLG >= lineL, `L ${lineL}, L/G ${lineLG}`);
  await page.click('#lines button[data-v="L"]');
  await page.click('#lines button[data-v="G"]');
  await page.check("#no-hazard");
  const noHazard = await count(page);
  check("no-hazardous-violations filter", noHazard > 0 && noHazard < all, `${noHazard}`);
  await page.uncheck("#no-hazard");
  await page.check("#prewar");
  const prewar = await count(page);
  check("prewar filter", prewar > 0 && prewar < all, `${prewar}`);
  await page.uncheck("#prewar");
  check("subway filters reset", (await count(page)) === all);
  await page.screenshot({ path: `${SHOTS}06c-more-filters.png` });
  await page.click("#toggle-more");
  check("more filters closes", await page.isHidden("#more-filters"));

  await page.fill("#c-place", "1 Centre Street, Manhattan");
  await page.selectOption("#c-minutes", "30");
  await page.click("#c-set");
  await page.waitForFunction(() => !document.querySelector("#c-clear").hidden, null, { timeout: 15000 })
    .catch(async () => check("commute address lookup", false, await page.textContent("#c-msg")));
  const within30 = await count(page);
  check("commute ≤ 30 min filters", within30 > 0 && within30 < all, `${within30} of ${all}`);
  check("cards show commute", /~\d+ min.* to 1 Center Street/.test((await page.textContent(".card .commute")) || ""),
    await page.textContent(".card .commute").catch(() => ""));
  const mins = await page.$$eval(".card .commute", (els) => els.map((e) => Number(e.textContent.match(/~(\d+)/)?.[1])));
  check("sorted by shortest commute", mins.length > 1 && mins.every((m, i) => i === 0 || m >= mins[i - 1]) && mins.every((m) => m <= 30),
    mins.slice(0, 6).join(", "));
  await page.selectOption("#c-minutes", "45");
  const within45 = await count(page);
  check("raising the limit adds apartments", within45 > within30);
  // a second place: both trips must fit
  await page.click("#c2-add");
  check("second place box opens", await page.isVisible("#c2-place"));
  await page.fill("#c2-place", "Grand Central Terminal, Manhattan");
  await page.selectOption("#c2-minutes", "30");
  await page.click("#c2-set");
  await page.waitForFunction(() => /And to/.test(document.querySelector("#c2-msg").textContent), null, { timeout: 15000 })
    .catch(async () => check("second address lookup", false, await page.textContent("#c2-msg")));
  const both = await count(page);
  const twoTrips = (await page.textContent(".card .commute").catch(() => "")) || "";
  check("two places: only apartments where both trips fit", both > 0 && both <= within45, `${both} of ${within45}`);
  check("cards show both trips", /to 1 Center Street.*·.*min.* to /.test(twoTrips), twoTrips);
  await page.click("#c2-remove");
  check("removing the second place restores the list", (await count(page)) === within45 && (await page.isVisible("#c2-add")));
  await page.screenshot({ path: `${SHOTS}02b-commute-filter.png` });
  await page.click("#save-search");
  await page.fill("#save-name", "Commute test");
  await page.press("#save-name", "Enter");
  await page.click("#c-clear");
  check("clearing commute restores all", (await count(page)) === all);
  await page.selectOption("#saved", { label: "Commute test" });
  check("saved search restores commute filter", !(await page.isHidden("#c-clear")) && (await count(page)) < all);
  await page.click("#c-clear");

  // preferences with a commute
  await page.click("#open-prefs");
  await page.fill("#p-max", "3500");
  await page.check('#p-beds input[value="1"]');
  await page.check('#p-beds input[value="2"]');
  await page.fill("#p-near", "1 Centre Street, Manhattan");
  await page.click("#p-near-find");
  await page.waitForFunction(() => /Using:/.test(document.querySelector("#p-near-msg")?.textContent || ""), null, { timeout: 15000 })
    .then(() => check("address lookup (NYC GeoSearch)", true))
    .catch(async () => check("address lookup (NYC GeoSearch)", false, await page.textContent("#p-near-msg")));
  await page.selectOption("#p-minutes", "45");
  await page.check("#nice-dishwasher");
  await page.screenshot({ path: `${SHOTS}03-preferences.png` });
  await page.click('#prefs-form button[value="save"]');
  await page.waitForTimeout(500);
  const badges = await page.locator(".card .match:not([hidden])").count();
  check("match badges shown", badges > 0, `${badges} cards`);
  check("sorted by best match", (await page.$eval("#sort", (s) => s.value)) === "match");
  const firstWhy = await page.textContent(".card .match-why").catch(() => "");
  check("match reasons include commute", /min to/.test(firstWhy || ""), firstWhy);
  await page.screenshot({ path: `${SHOTS}04-matches.png` });

  // detail view
  await page.click(".card");
  await page.waitForSelector("#detail[open]");
  const detail = await page.textContent("#detail-body");
  check("detail shows nearest subway", /Nearest subway:/.test(detail));
  check("detail shows commute estimate", /Commute to .*min/.test(detail));
  check("detail shows building summary line", await page.locator("#detail-body details.bldg > summary").count() === 1
    && !(await page.locator("#detail-body details.bldg").evaluate((d) => d.open)), await page.textContent("#detail-body details.bldg > summary"));
  await page.click("#detail-body details.bldg > summary");
  check("building details expand", await page.isVisible("#detail-body details.bldg dl.facts")
    && /Open violations[\s\S]*Registered owner/.test(await page.textContent("#detail-body details.bldg")));
  check("detail shows daylight estimate", /Daylight \(estimate\)[\s\S]*(bright|light|dim)/i.test(detail));
  check("detail has directions link", await page.locator("#detail-body button.link", { hasText: "Exact directions" }).count() === 1);
  await page.screenshot({ path: `${SHOTS}05-detail.png` });
  await page.keyboard.press("Escape");

  // profile: saved searches can be run and renamed
  await page.click("#open-profile");
  await page.waitForSelector("#profile-dialog[open]");
  const saved = await page.locator("#pf-searches .saved-item").count();
  check("profile lists saved searches", saved >= 2, `${saved} searches`);
  check("profile shows preferences", /up to \$3,500/.test(await page.textContent("#pf-prefs")), await page.textContent("#pf-prefs"));
  const summary = await page.locator("#pf-searches .saved-item .summary").first().textContent();
  check("saved search summary", summary.length > 3, summary);
  await page.locator("#pf-searches .saved-item").first().getByRole("button", { name: "Rename" }).click();
  await page.fill('#pf-searches input[aria-label="New name"]', "Renamed search");
  await page.press('#pf-searches input[aria-label="New name"]', "Enter");
  await page.waitForTimeout(200);
  check("rename a saved search", (await page.textContent("#pf-searches")).includes("Renamed search"));
  const bell = page.locator("#pf-searches .saved-item").first().locator("button.bell");
  check("saved search shows alerts on", (await bell.getAttribute("aria-pressed")) === "true", await bell.textContent());
  await bell.click();
  await page.waitForTimeout(200);
  check("turn a search's alerts off", (await page.locator("#pf-searches .saved-item").first().locator("button.bell").getAttribute("aria-pressed")) === "false");
  check("alerts section explains preview", /local preview/.test(await page.textContent("#pf-push-status")));
  await page.screenshot({ path: `${SHOTS}06b-profile.png` });
  await page.locator("#pf-searches .saved-item").first().getByRole("button", { name: "Run" }).click();
  check("run a saved search from profile", !(await page.locator("#profile-dialog[open]").count()) && (await count(page)) > 0);

  // what's new
  await page.click("#open-feed");
  await page.waitForSelector("#feed-dialog[open]");
  check("what's new opens", true, (await page.textContent("#feed")).trim().slice(0, 60));
  await page.screenshot({ path: `${SHOTS}06-whats-new.png` });
  await page.keyboard.press("Escape");

  // list follows the map, buildings, viewed, listed-within, outside click, theme
  await page.check("#in-view");
  await page.evaluate(() => document.querySelector("#map").scrollIntoView());
  for (let i = 0; i < 3; i++) await page.click(".maplibregl-ctrl-zoom-in");
  await page.waitForFunction(() => /map area/.test(document.querySelector("#summary").textContent), null, { timeout: 8000 });
  const area = await count(page);
  check("list follows the map when zoomed", area > 0 && area < all, await page.textContent("#summary"));
  await page.uncheck("#in-view");
  await page.locator("#list .card").first().click();
  await page.waitForSelector("#detail[open]");
  const box = await page.locator("#detail").boundingBox();
  await page.mouse.click(box.x - 20, box.y + 40);
  check("clicking outside closes the apartment", !(await page.locator("#detail[open]").count()));
  check("opened apartment is marked viewed", await page.locator("#list .card.viewed").count() >= 1);
  const before = await count(page);
  await page.check("#hide-viewed");
  const after = await count(page);
  check("hide viewed", after < before && after > 0, `${after} of ${before}`);
  await page.uncheck("#hide-viewed");
  await page.selectOption("#days", "30");
  const recent = await count(page);
  check("listed within 30 days", recent <= all, `${recent}`);
  await page.selectOption("#days", "");
  await page.click("#open-theme");
  const t = await page.evaluate(() => {
    const box = (e) => e.getBoundingClientRect();
    const opts = [...document.querySelectorAll(".palette-opt")];
    const seg = [...document.querySelectorAll("#theme-mode button")].map(box);
    const list = box(document.querySelector(".palette-list")), segBox = box(document.querySelector("#theme-mode"));
    return {
      radios: opts.map((o) => Math.round(box(o.querySelector("input")).left)),
      names: opts.map((o) => Math.round(box(o.querySelector(".palette-name")).left)),
      swatchRights: opts.map((o) => Math.round(box(o.querySelector(".swatches")).right)),
      rowWidths: opts.map((o) => Math.round(box(o).width)),
      radioMiddles: opts.map((o) => Math.round(box(o.querySelector("input")).top + box(o.querySelector("input")).height / 2 - box(o).top - box(o).height / 2)),
      segWidths: seg.map((b) => Math.round(b.width)),
      segSpansList: Math.abs(segBox.width - list.width) <= 1,
    };
  });
  check("theme: palette rows line up", allSame(t.radios) && allSame(t.names) && allSame(t.swatchRights) && allSame(t.rowWidths),
    `radios ${t.radios} names ${t.names} swatches ${t.swatchRights}`);
  check("theme: radios centered in their rows", t.radioMiddles.every((m) => Math.abs(m) <= 1), t.radioMiddles.join(","));
  check("theme: appearance buttons equal and full width", allSame(t.segWidths) && t.segSpansList, `${t.segWidths}`);
  await page.click('#theme-mode button[data-v="dark"]');
  await page.check('input[name=palette][value=cb]');
  await page.waitForTimeout(1500);
  const theme = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue("--likely").trim()]);
  check("dark theme + colorblind palette", theme[0] === "dark" && theme[1].toUpperCase() === "#D81B60", theme.join(" "));
  await page.screenshot({ path: `${SHOTS}06c-dark-cb.png` });
  await page.click('#theme-mode button[data-v="auto"]');
  await page.check('input[name=palette][value=default]');
  await page.keyboard.press("Escape");

  // address suggestions as you type, then save the pick as a nicknamed place
  await page.fill("#c-place", "");
  await page.click("#c-place");
  await page.type("#c-place", "1 centre st", { delay: 30 });
  await page.waitForSelector("#c-place-suggest li[role=option]", { timeout: 15000 });
  const sug = await page.locator("#c-place-suggest li[role=option]").allTextContents();
  check("address suggestions while typing", sug.length > 0, sug.slice(0, 2).join(" | "));
  check("addresses aren't in all capitals", sug.length > 0 && sug.every((t) => !/[A-Z]{4,}/.test(t)), sug[0]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("#c-clear").hidden, null, { timeout: 5000 });
  check("picking a suggestion sets the commute", true, await page.inputValue("#c-place"));
  const msgShown = await page.evaluate(() => {
    const m = document.querySelector("#c-msg"), r = m.getBoundingClientRect(), f = document.querySelector("#filters").getBoundingClientRect();
    const at = document.elementFromPoint(r.left + Math.min(r.width - 2, 40), r.top + r.height / 2);
    return { text: m.textContent, inside: r.bottom <= f.bottom + 0.5 && r.right <= f.right + 0.5, onTop: m.contains(at), fits: m.scrollWidth <= m.clientWidth + 1 };
  });
  check("commute message isn't cut off", msgShown.inside && msgShown.onTop && msgShown.fits, JSON.stringify(msgShown));
  await page.click("#c-save-place");
  await page.fill("#place-alias", "Work");
  await page.click('#place-form button[value="save"]');
  await page.waitForTimeout(300);
  check("save place hides once saved", await page.locator("#c-save-place").isHidden());
  await page.click("#c-clear");
  await page.click("#c-place");
  await page.waitForSelector("#c-place-suggest:not([hidden]) .alias", { timeout: 3000 });
  check("saved place offered first", (await page.locator("#c-place-suggest li").first().textContent()).startsWith("Work"));
  await page.locator("#c-place-suggest li").first().click();
  check("picking a saved place sets the commute", /Work/.test(await page.textContent("#c-msg")), await page.textContent("#c-msg"));
  await page.click("#c-clear");
  const logo = await page.locator(".top svg.logo").boundingBox();
  check("brownstone logo shows", !!logo && logo.width > 10 && logo.height > 10);
  check("logo is an outline drawing", await page.$eval(".top svg.logo", (e) => getComputedStyle(e).fill === "none" && getComputedStyle(e).stroke !== "none"));
  check("site is named Stoopify", (await page.locator(".top h1").innerText()) === "Stoopify" && (await page.title()).startsWith("Stoopify"));
  const icons = await page.evaluate(async () => {
    const meta = (q) => document.querySelector(q)?.getAttribute("content") || document.querySelector(q)?.getAttribute("href");
    const ok = async (u) => { const r = await fetch(new URL(u, location.href).pathname); return r.ok && /image/.test(r.headers.get("content-type") || ""); };
    return { tab: await ok(meta('link[rel="icon"][type="image/svg+xml"]')), apple: await ok(meta('link[rel="apple-touch-icon"]')),
             share: await ok(meta('meta[property="og:image"]')), card: meta('meta[name="twitter:card"]') };
  });
  check("browser tab icon, home-screen icon and share image load", icons.tab && icons.apple && icons.share && icons.card === "summary_large_image");

  // every pop-up closes when you click outside it
  const outside = async (open, id) => {
    await open();
    await page.waitForSelector(`#${id}[open]`);
    const b = await page.locator(`#${id}`).boundingBox();
    await page.mouse.click(Math.max(2, b.x - 15), Math.max(2, b.y + 10));
    await page.waitForTimeout(150);
    return !(await page.locator(`#${id}[open]`).count());
  };
  const closes = {
    theme: await outside(() => page.click("#open-theme"), "theme-dialog"),
    recent: await outside(() => page.click("#open-feed"), "feed-dialog"),
    prefs: await outside(() => page.click("#open-prefs"), "prefs-dialog"),
    profile: await outside(() => page.click("#open-profile"), "profile-dialog"),
    save: await outside(() => page.click("#save-search"), "save-dialog"),
    apartment: await outside(() => page.locator("#list .card").first().click(), "detail"),
  };
  check("click outside closes every pop-up", Object.values(closes).every(Boolean), JSON.stringify(closes));
  check("feed is called Recent listings", (await page.textContent("#open-feed")).includes("Recent listings"));
  // map switch: every apartment (default) or by building; no clustering option
  const modes = await page.$$eval("#grouping button", (bs) => bs.map((b) => [b.textContent, b.getAttribute("aria-pressed")]));
  check("map shows Every apartment by default, By building as the other choice",
    modes.length === 2 && modes.some(([t, p]) => t === "Every apartment" && p === "true") && modes.some(([t]) => t === "By building"), JSON.stringify(modes));
  await page.click('#grouping [data-v="building"]');
  await page.waitForTimeout(500);
  check("By building switch remembered", await page.evaluate(() => localStorage.getItem("grouping")) === "building");
  await page.click('#grouping [data-v="separate"]');

  // My places: add two, use one, remove one
  await page.click("#open-places");
  check("My places opens", await page.isVisible("#places-dialog"));
  for (const [addr, alias, street] of [["350 5th Ave", "Office", "5 Avenue"], ["620 Atlantic Ave", "Gym", "Atlantic"]]) {
    await page.fill("#np-address", addr);
    const hit = `#np-address-suggest li:not(.note):has-text("${street}")`;
    await page.waitForSelector(hit, { timeout: 8000 });
    await page.click(`${hit} >> nth=0`);
    await page.fill("#np-alias", alias);
    await page.click("#np-add");
    await page.waitForFunction((a) => [...document.querySelectorAll("#places-list .alias")].some((e) => e.textContent === a), alias);
  }
  check("can save several places", (await page.locator("#places-list li").count()) >= 3 && Number(await page.textContent("#places-count")) >= 3,
    await page.textContent("#places-count"));
  await page.click('#places-list li:has-text("Office") >> text=Use');
  check("Use sets the commute filter", !(await page.isVisible("#places-dialog")) && /Office/.test(await page.textContent("#c-msg")));
  await page.click("#c-clear");
  await page.click("#open-places");
  await page.click('#places-list li:has-text("Gym") >> text=Remove');
  await page.waitForTimeout(300);
  check("Remove deletes a place", !(await page.locator('#places-list li:has-text("Gym")').count()));
  await page.click("#places-close");

  // violations ranking + income limits
  await page.selectOption("#sort", "violations");
  const ranked = await page.evaluate(() => [...document.querySelectorAll("#list .card .meta")].slice(0, 5).map((e) => e.textContent));
  const gradesInOrder = await page.evaluate(() => [...document.querySelectorAll("#list .card")].map((c) => c.querySelector(".badge.grade")?.textContent?.slice(-1)).filter(Boolean));
  check("Best building grade sort goes A to F", gradesInOrder.length > 5 && gradesInOrder.every((g, i) => i === 0 || g >= gradesInOrder[i - 1]) && gradesInOrder[0] === "A",
    gradesInOrder.slice(0, 3).join("") + "…" + gradesInOrder.slice(-3).join(""));
  await page.selectOption("#sort", "newest");
  await page.click("#toggle-more");
  await page.selectOption("#income", "only");
  const onlyIncome = await page.evaluate(() => ({ cards: document.querySelectorAll("#list .card").length, tags: document.querySelectorAll("#list .card .badge.income").length }));
  check("Only income-restricted shows tagged listings", onlyIncome.cards > 0 && onlyIncome.cards === onlyIncome.tags, JSON.stringify(onlyIncome));
  await page.selectOption("#income", "");
  check("cards show a daylight tag", await page.locator("#list .card .badge.light").count() > 0);
  await page.selectOption("#light", "bright");
  const lit = await page.evaluate(() => [...document.querySelectorAll("#list .card")].map((c) => c.querySelector(".badge.light")?.textContent || ""));
  check("Likely bright filter keeps only bright apartments", lit.length > 0 && lit.every((t) => /bright/.test(t)), [...new Set(lit)].join(","));
  await page.selectOption("#light", "");
  const sfAll = await page.evaluate(() => fetch("/dev-data.json").then((r) => r.json()).then((d) => d.listings.filter((l) => l.superfund && l.status === "ACTIVE").length));
  await page.selectOption("#superfund", "exclude");
  check("Superfund filter hides nearby apartments", sfAll > 0 && await page.locator("#list .card .badge.superfund").count() === 0, `${sfAll} near a site`);
  await page.selectOption("#superfund", "");
  await page.selectOption("#grade", "B");
  const graded = await page.evaluate(() => [...document.querySelectorAll("#list .card")].map((c) => c.querySelector(".badge.grade")?.textContent));
  check("Building grade filter keeps only A and B", graded.length > 0 && graded.every((g) => g === "Grade A" || g === "Grade B"), [...new Set(graded)].join(","));
  await page.selectOption("#grade", "");
  await page.click("#toggle-more");
  // neighborhood picker: a styled list with counts, type to narrow, Enter to add
  await page.click("#hood-input");
  const hoodRows = await page.locator("#hood-input-list li[role=option]").count();
  const firstHood = await page.locator("#hood-input-list li[role=option]").first().textContent();
  check("neighborhood list opens with counts", hoodRows > 10 && /\d+ apts?$/.test(firstHood), `${hoodRows} · ${firstHood}`);
  await page.type("#hood-input", "bush");
  await page.keyboard.press("Enter");
  check("typing + Enter adds the neighborhood", (await page.locator("#hood-chips .chip").allTextContents()).includes("Bushwick"));
  await page.keyboard.press("Escape");
  // Clear all
  await page.click('#beds button[data-v="1"]');
  check("Clear all shows how many filters are set", await page.isVisible("#clear-filters") && (await page.textContent("#filter-count")) === "2");
  await page.click("#clear-filters");
  check("Clear all resets every filter", (await page.isHidden("#clear-filters")) && !(await page.locator("#hood-chips .chip").count())
    && (await page.getAttribute('#beds button[data-v=""]', "aria-pressed")) === "true");
  check("theme button says Theme", /Theme/.test(await page.textContent("#open-theme")));

  check("no console errors (desktop)", page.errors.length === 0, page.errors.slice(0, 3).join(" | "));
  await page.context().close();
}

// ---- phone, local preview ------------------------------------------------------
if (ONLY !== "live") {
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(PREVIEW);
  await page.waitForFunction(() => /apartments|map area/.test(document.querySelector("#summary")?.textContent || ""), null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("phone: no sideways scrolling", overflow <= 0, `${overflow}px`);
  check("phone: filters hidden until tapped", !(await page.isVisible("#filters")));
  const pa = await alignment(page);
  check("phone: header buttons in one even row", allSame(pa.headerTops) && allSame(pa.headerHeights), `${pa.headerTops} / ${pa.headerHeights}`);
  await page.screenshot({ path: `${SHOTS}07-phone-map.png` });
  await page.click("#toggle-filters");
  check("phone: Filters tab opens filters", await page.isVisible("#filters"));
  await page.screenshot({ path: `${SHOTS}08-phone-filters.png` });
  await page.click("#toggle-filters");
  await page.click('.view-tabs button[data-view="list"]');
  await page.screenshot({ path: `${SHOTS}09-phone-list.png` });
  check("no console errors (phone)", page.errors.length === 0, page.errors.slice(0, 3).join(" | "));
  await page.context().close();
}

// ---- live site (signed out) ----------------------------------------------------
if (ONLY !== "preview") {
  const page = await newPage({ width: 1280, height: 860 });
  const res = await page.goto(LIVE);
  await page.waitForFunction(() => /apartments|map area/.test(document.querySelector("#summary")?.textContent || ""), null, { timeout: 30000 });
  check("live: map and listings load without signing in", res.ok() && (await count(page)) > 100, await page.textContent("#summary"));
  await page.click("#save-search");
  check("live: saving asks you to sign in", await page.isVisible("#login") && await page.isVisible("#google"));
  await page.click("#login .back-to-map");
  check("live: back to the map", await page.isVisible("#app"));
  const headers = res.headers();
  check("live: security headers", Boolean(headers["content-security-policy"] && headers["x-frame-options"]));
  await page.screenshot({ path: `${SHOTS}10-live-signin.png` });
  check("no console errors (live)", page.errors.length === 0, page.errors.slice(0, 3).join(" | "));
  await page.context().close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
