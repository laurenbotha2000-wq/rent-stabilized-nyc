// End-to-end walkthrough of the site with Playwright. Screenshots go to e2e/shots/.
//
//   PREVIEW_URL=http://127.0.0.1:8790 LIVE_URL=https://rent-stabilized-nyc.web.app node walkthrough.mjs
//
// PREVIEW_URL is the local preview (config with devData: real data, no sign-in).
// LIVE_URL is only checked up to the sign-in screen.
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { chromium } from "playwright";

const PREVIEW = process.env.PREVIEW_URL || "http://127.0.0.1:8790";
const LIVE = process.env.LIVE_URL || "https://rent-stabilized-nyc.web.app";
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
{
  const page = await newPage({ width: 1280, height: 860 });
  await page.goto(PREVIEW);
  await page.waitForFunction(() => /apartments/.test(document.querySelector("#summary")?.textContent || ""), null, { timeout: 20000 });
  await page.waitForTimeout(2500); // map tiles
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
  check("subway filters reset", (await count(page)) === all);

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
  check("raising the limit adds apartments", (await count(page)) > within30);
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
  check("detail has directions link", await page.locator("#detail-body button.link", { hasText: "Exact directions" }).count() === 1);
  await page.screenshot({ path: `${SHOTS}05-detail.png` });
  await page.keyboard.press("Escape");

  // what's new
  await page.click("#open-feed");
  await page.waitForSelector("#feed-dialog[open]");
  check("what's new opens", true, (await page.textContent("#feed")).trim().slice(0, 60));
  await page.screenshot({ path: `${SHOTS}06-whats-new.png` });
  await page.keyboard.press("Escape");

  check("no console errors (desktop)", page.errors.length === 0, page.errors.slice(0, 3).join(" | "));
  await page.context().close();
}

// ---- phone, local preview ------------------------------------------------------
{
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(PREVIEW);
  await page.waitForFunction(() => /apartments/.test(document.querySelector("#summary")?.textContent || ""), null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("phone: no sideways scrolling", overflow <= 0, `${overflow}px`);
  check("phone: filters hidden until tapped", !(await page.isVisible("#filters")));
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
{
  const page = await newPage({ width: 1280, height: 860 });
  const res = await page.goto(LIVE);
  await page.waitForSelector("#login:not([hidden])", { timeout: 20000 });
  check("live: sign-in screen", res.ok());
  check("live: Google button", await page.isVisible("#google"));
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
