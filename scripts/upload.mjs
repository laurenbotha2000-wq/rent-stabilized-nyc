// Publish `reasier-server export` output to Firestore for the hosted site.
//
//   node upload.mjs path/to/data.json            (needs FIREBASE_SERVICE_ACCOUNT)
//   node upload.mjs path/to/data.json --dry-run  (no credentials; prints the plan)
//
// Writes listings/c0..cN (JSON strings, under Firestore's 1 MiB document limit)
// and meta/status, all in one atomic batch, and only when the content changed.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const KEEP_DELISTED_DAYS = 30;
const CHUNK_BYTES = 700_000;
// internal bookkeeping that changes every run; leaving it out means the
// published version only changes when listings really change
const DROP = ["last_seen", "geocoded_at", "description"];

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error("usage: node upload.mjs data.json [--dry-run]");
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
if (flag === "--dry-run") {
  jsons.forEach((j, i) => console.log(`  c${i}: ${(j.length / 1024).toFixed(0)} KB`));
  process.exit(0);
}

const { initializeApp, cert } = await import("firebase-admin/app");
const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const metaRef = db.doc("meta/status");
const prev = (await metaRef.get()).data();
if (prev?.version === version) {
  console.log("unchanged; nothing written");
  process.exit(0);
}

const batch = db.batch();
jsons.forEach((json, i) => batch.set(db.doc(`listings/c${i}`), { version, json }));
for (let i = jsons.length; i < (prev?.chunks ?? 0); i++) batch.delete(db.doc(`listings/c${i}`));
batch.set(metaRef, {
  version,
  chunks: jsons.length,
  count: listings.length,
  active,
  updated_at: data.generated_at,
  last_sync: data.last_sync ?? null,
  written_at: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log(`published version ${version}`);
