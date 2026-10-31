// Publish `reasier-server export` output to Firestore for the hosted site,
// and record what changed as events.
//
//   node upload.mjs path/to/data.json             (needs FIREBASE_SERVICE_ACCOUNT)
//   node upload.mjs path/to/data.json --dry-run   (prints the plan; with credentials
//                                                   it also diffs against Firestore)
//
// Writes, in one atomic batch: listings/c0..cN (JSON strings, under Firestore's
// 1 MiB document limit), meta/status, and one events/{id} per change:
//   new | price_change | delisted | relisted
// Nothing is written when the content is unchanged. Events older than
// EVENT_RETENTION_DAYS are pruned.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const KEEP_DELISTED_DAYS = 30;
const EVENT_RETENTION_DAYS = 30;
const CHUNK_BYTES = 700_000;
const BATCH_LIMIT = 450; // Firestore allows 500 writes per batch
// internal bookkeeping that changes every run; leaving it out means the
// published version only changes when listings really change
const DROP = ["last_seen", "geocoded_at", "description"];

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error("usage: node upload.mjs data.json [--dry-run]");
const dryRun = flag === "--dry-run";
const data = JSON.parse(readFileSync(file, "utf8"));

const cutoff = Date.now() - KEEP_DELISTED_DAYS * 86400_000;
const listings = data.listings
  .filter((l) => l.status === "ACTIVE" || (l.delisted_at && Date.parse(l.delisted_at) >= cutoff))
  .map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !DROP.includes(k))));

const chunks = [];
let cur = [], size = 2;
for (const l of listings) {
  const s = JSON.stringify(l);
  if (size + s.length + 1 > CHUNK_BYTES && cur.length) { chunks.push(cur); cur = []; size = 2; }
  cur.push(s); size += s.length + 1;
}
if (cur.length) chunks.push(cur);
const jsons = chunks.map((c) => `[${c.join(",")}]`);
const version = createHash("sha256").update(jsons.join("\n")).digest("hex").slice(0, 16);

const active = listings.filter((l) => l.status === "ACTIVE").length;
console.log(`${listings.length} listings (${active} active) in ${jsons.length} chunk(s), version ${version}`);
if (data.last_error) console.log(`sync error reported by export: ${data.last_error}`);

/** Changes between the previously published listings and these. */
function diff(prev, next, prevPublishedAt) {
  const before = new Map(prev.map((l) => [l.url, l]));
  // a listing we've seen before but that aged out of the published set
  // (delisted long ago) is coming back, not new
  const seenBefore = (l) => prevPublishedAt && l.first_seen && l.first_seen < prevPublishedAt;
  const events = [];
  const summary = (l) => ({
    url: l.url, address: l.address ?? null, neighborhood: l.neighborhood ?? null,
    beds: l.beds ?? null, price: l.price ?? null, reasons: l.reasons ?? [],
  });
  for (const l of next) {
    const p = before.get(l.url);
    if (!p) {
      if (l.status === "ACTIVE") events.push({ type: seenBefore(l) ? "relisted" : "new", ...summary(l) });
      continue;
    }
    if (p.status === "ACTIVE" && l.status !== "ACTIVE") events.push({ type: "delisted", ...summary(l) });
    else if (p.status !== "ACTIVE" && l.status === "ACTIVE") events.push({ type: "relisted", ...summary(l) });
    else if (l.status === "ACTIVE" && p.price !== l.price) events.push({ type: "price_change", ...summary(l), old_price: p.price ?? null });
  }
  return events;
}

if (dryRun && !process.env.FIREBASE_SERVICE_ACCOUNT) {
  jsons.forEach((j, i) => console.log(`  c${i}: ${(j.length / 1024).toFixed(0)} KB`));
  process.exit(0);
}

const { initializeApp, cert } = await import("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = await import("firebase-admin/firestore");
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const metaRef = db.doc("meta/status");
const prev = (await metaRef.get()).data();
// RUNNER names who checked (e.g. "mac", "github"); runners skip when another checked recently
const runner = process.env.SYNC_RUNNER || "manual";
if (prev?.version === version) {
  await metaRef.update({ checked_at: FieldValue.serverTimestamp(), checked_by: runner, last_sync: data.last_sync ?? null });
  console.log("unchanged; recorded the check only");
  process.exit(0);
}

let previous = null; // null = no trustworthy previous snapshot
if (prev?.chunks) {
  const docs = await db.getAll(...Array.from({ length: prev.chunks }, (_, i) => db.doc(`listings/c${i}`)));
  if (docs.every((d) => d.exists && d.get("version") === prev.version)) {
    previous = docs.flatMap((d) => JSON.parse(d.get("json")));
  } else {
    console.log("previous snapshot incomplete; skipping events this run rather than reporting everything as new");
  }
}
// first publish or unreadable previous: everything would look "new"; don't flood the feed
const events = previous?.length ? diff(previous, listings, prev.updated_at) : [];
const counts = events.reduce((c, e) => ({ ...c, [e.type]: (c[e.type] || 0) + 1 }), {});
console.log(`events: ${events.length ? JSON.stringify(counts) : "none"}`);
if (dryRun) {
  for (const e of events.slice(0, 10)) {
    console.log(`  ${e.type} ${e.address} ${e.old_price != null ? `$${e.old_price}→` : ""}$${e.price}`);
  }
  process.exit(0);
}

const now = Timestamp.now();
// one transaction keeps listings, status and events consistent, and only
// commits if nobody else published since we read meta/status (two runners
// can't both record the same change)
const recorded = events.slice(0, BATCH_LIMIT - jsons.length - (prev?.chunks ?? 0) - 1);
try {
  await db.runTransaction(async (t) => {
    const current = (await t.get(metaRef)).data();
    if ((current?.version ?? null) !== (prev?.version ?? null)) throw new Error("CONFLICT");
    jsons.forEach((json, i) => t.set(db.doc(`listings/c${i}`), { version, json }));
    for (let i = jsons.length; i < (prev?.chunks ?? 0); i++) t.delete(db.doc(`listings/c${i}`));
    for (const e of recorded) t.set(db.collection("events").doc(), { ...e, version, at: now });
    t.set(metaRef, {
      version,
      chunks: jsons.length,
      count: listings.length,
      active,
      updated_at: data.generated_at,
      last_sync: data.last_sync ?? null,
      last_events: counts,
      written_at: FieldValue.serverTimestamp(),
      checked_at: FieldValue.serverTimestamp(),
      checked_by: runner,
    });
  });
} catch (e) {
  if (e.message !== "CONFLICT") throw e;
  console.log("another runner published first; skipping (its data is current)");
  process.exit(0);
}
console.log(`published version ${version}${recorded.length < events.length ? ` (${events.length - recorded.length} events not recorded: over the per-run cap)` : ""}`);

// retention: drop old events (best effort; next run continues if this is cut short)
const old = await db.collection("events")
  .where("at", "<", Timestamp.fromMillis(Date.now() - EVENT_RETENTION_DAYS * 86400_000)).limit(400).get();
if (!old.empty) {
  const del = db.batch();
  old.docs.forEach((d) => del.delete(d.ref));
  await del.commit();
  console.log(`pruned ${old.size} old events`);
}
