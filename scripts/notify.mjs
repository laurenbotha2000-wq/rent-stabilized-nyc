// Saved-search alerts: for the changes this run published (new and relisted
// apartments, price drops), tell each person whose alert-enabled saved
// searches match, by push notification on their devices and, when they've
// turned it on, by email.
//
//   node notify.mjs out/events.json out/data.json [--dry-run]
//
// upload.mjs writes events.json only on the runner that won the publish, so
// each change is announced once. One push per saved search and one email per
// person per run, however many apartments matched.
//
// Keys live in admin-only Firestore documents (no browser can read them):
//   config/webpush  { publicKey, privateKey }              (scripts/notify-setup.mjs)
//   config/email    { from, client_id, client_secret, refresh_token }  (Gmail, optional)
// Credentials: see firebase.mjs.
import { readFileSync, existsSync } from "node:fs";
import webpush from "web-push";
import { firestore } from "./firebase.mjs";
import { setStations } from "../web/commute.js";
import { matches, normalize } from "../web/filters.js";

const SITE = "https://rent-stabilized-nyc.web.app";
// Push subscriptions must point at a browser push service; anything else is ignored.
const PUSH_SERVICE = /^https:\/\/(fcm\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const MAX_LISTED = 10;

const [eventsFile, dataFile, flag] = process.argv.slice(2);
if (!eventsFile || !dataFile) throw new Error("usage: node notify.mjs events.json data.json [--dry-run]");
const dryRun = flag === "--dry-run";

const events = existsSync(eventsFile) ? JSON.parse(readFileSync(eventsFile, "utf8")) : [];
const worth = events.filter((e) => e.type === "new" || e.type === "relisted"
  || (e.type === "price_change" && e.old_price != null && e.price != null && e.price < e.old_price));
if (!worth.length) {
  console.log("alerts: nothing new to announce");
  process.exit(0);
}

const listings = new Map(JSON.parse(readFileSync(dataFile, "utf8")).listings.map((l) => [l.url, l]));
setStations(JSON.parse(readFileSync(new URL("../web/stations.json", import.meta.url), "utf8")).stations);
const db = firestore();

// who wants alerts, and which of the changes match each of their searches
const searches = await db.collectionGroup("searches").where("alert", "==", true).get();
const byUser = new Map(); // uid -> [{ id, name, hits: [event] }]
for (const doc of searches.docs) {
  const uid = doc.ref.parent.parent.id;
  const s = doc.data();
  const f = normalize(s.filters);
  const hits = worth.filter((e) => listings.has(e.url) && matches(listings.get(e.url), f));
  if (!hits.length) continue;
  (byUser.get(uid) || byUser.set(uid, []).get(uid)).push({ id: doc.id, name: s.name, hits });
}
console.log(`alerts: ${worth.length} change(s), ${searches.size} alerting search(es), ${byUser.size} person(s) to notify`);
if (!byUser.size) process.exit(0);

const money = (n) => (n == null ? "price n/a" : `$${n.toLocaleString("en-US")}`);
const beds = (n) => (n == null ? "" : n === 0 ? "Studio" : `${n} BR`);
function line(e) {
  const where = e.address && e.neighborhood && !e.address.includes(e.neighborhood)
    ? `${e.address}, ${e.neighborhood}` : e.address || e.neighborhood || "Apartment";
  const price = e.type === "price_change" ? `${money(e.old_price)} → ${money(e.price)}` : money(e.price);
  const what = e.type === "price_change" ? "Price drop" : e.type === "relisted" ? "Back on the market" : "New";
  return { text: `${what}: ${where} · ${[beds(e.beds), price].filter(Boolean).join(" · ")}`, url: e.url };
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "es"}`;

const [pushCfg, emailCfg] = await Promise.all([db.doc("config/webpush").get(), db.doc("config/email").get()]);
if (pushCfg.exists) webpush.setVapidDetails(SITE, pushCfg.get("publicKey"), pushCfg.get("privateKey"));
let gmail = null; // access token, fetched on first email

let pushed = 0, emailed = 0, failed = 0;
for (const [uid, hitsBySearch] of byUser) {
  const [settings, devices] = await Promise.all([
    db.doc(`users/${uid}/alerts/settings`).get(),
    db.collection(`users/${uid}/devices`).limit(20).get(),
  ]);

  // push: one notification per saved search, on every device they turned it on for
  if (pushCfg.exists) {
    for (const s of hitsBySearch) {
      const first = line(s.hits[0]).text;
      const payload = JSON.stringify({
        title: `${plural(s.hits.length, "match")} for "${s.name}"`,
        body: s.hits.length === 1 ? first : `${first}\n+ ${s.hits.length - 1} more`,
        url: SITE,
        tag: `search-${s.id}`,
      });
      for (const d of devices.docs) {
        const { endpoint, p256dh, auth } = d.data();
        if (!PUSH_SERVICE.test(endpoint || "")) continue;
        if (dryRun) { console.log(`  [dry run] push to ${uid.slice(0, 6)}…: ${payload}`); continue; }
        try {
          await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, { TTL: 6 * 3600, urgency: "normal" });
          pushed++;
        } catch (e) {
          // the browser unsubscribed or the app was removed: forget the device
          if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete();
          else { failed++; console.log(`  push failed (${e.statusCode || e.message})`); }
        }
      }
    }
  }

  // email: one message covering all their matching searches
  const to = settings.exists && settings.get("emailOn") && settings.get("email");
  if (emailCfg.exists && to) {
    const total = hitsBySearch.reduce((n, s) => n + s.hits.length, 0);
    const subject = `${plural(total, "match")} for your saved search${hitsBySearch.length > 1 ? "es" : ""}`;
    const sections = hitsBySearch.map((s) => ({ name: s.name, lines: s.hits.slice(0, MAX_LISTED).map(line), more: Math.max(0, s.hits.length - MAX_LISTED) }));
    if (dryRun) { console.log(`  [dry run] email to ${uid.slice(0, 6)}…: ${subject}`); continue; }
    try {
      gmail ??= await gmailToken(emailCfg.data());
      await sendEmail(gmail, emailCfg.get("from"), to, subject, sections);
      emailed++;
    } catch (e) { failed++; console.log(`  email failed: ${e.message}`); }
  }
}
console.log(`alerts: ${pushed} push notification(s), ${emailed} email(s)${failed ? `, ${failed} failed` : ""}`);

// ---- email via the Gmail API ----------------------------------------------

async function gmailToken(c) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Gmail sign-in failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const header = (s) => `=?UTF-8?B?${Buffer.from(String(s).replace(/[\r\n]+/g, " ")).toString("base64")}?=`;
const b64 = (s) => Buffer.from(s).toString("base64").replace(/.{76}/g, "$&\r\n");

async function sendEmail(token, from, to, subject, sections) {
  const footer = `You're getting this because you turned on alerts for a saved search. Turn them off any time under My profile at ${SITE}`;
  const text = [
    ...sections.flatMap((s) => [`"${s.name}"`, ...s.lines.map((l) => `- ${l.text}\n  ${l.url}`), ...(s.more ? [`- and ${s.more} more on the site`] : []), ""]),
    `See them all: ${SITE}`, "", footer,
  ].join("\n");
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#1d2433">${sections.map((s) =>
    `<h3 style="margin:16px 0 6px">${esc(s.name)}</h3><ul style="padding-left:18px;margin:0">${s.lines.map((l) =>
      `<li><a href="${esc(l.url)}">${esc(l.text)}</a></li>`).join("")}${s.more ? `<li>and ${s.more} more on the site</li>` : ""}</ul>`).join("")}
    <p><a href="${SITE}">See them all on Rent Stabilized NYC</a></p>
    <p style="color:#6b7280;font-size:12px">${esc(footer)}</p></div>`;
  const boundary = `b${Date.now().toString(36)}`;
  const mime = [
    `From: ${String(from).replace(/[\r\n]/g, "")}`, `To: ${String(to).replace(/[\r\n]/g, "")}`,
    `Subject: ${header(subject)}`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(html),
    `--${boundary}--`, "",
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
