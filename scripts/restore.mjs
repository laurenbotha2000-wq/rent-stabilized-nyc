// Download the published listings from Firestore into a data.json-shaped file,
// so `reasier-server import` can rebuild a lost working database.
//
//   node restore.mjs out/published.json   (needs FIREBASE_SERVICE_ACCOUNT)
// Exits 0 with an empty listing array when nothing has been published yet.
import { writeFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const out = process.argv[2];
if (!out) throw new Error("usage: node restore.mjs OUT.json");
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const meta = (await db.doc("meta/status").get()).data();
let listings = [];
if (meta?.chunks) {
  const docs = await db.getAll(...Array.from({ length: meta.chunks }, (_, i) => db.doc(`listings/c${i}`)));
  listings = docs.flatMap((d) => (d.exists && d.get("version") === meta.version ? JSON.parse(d.get("json")) : []));
}
writeFileSync(out, JSON.stringify({ generated_at: meta?.updated_at ?? new Date().toISOString(), listings }));
console.log(`restored ${listings.length} listings from Firestore (version ${meta?.version ?? "none"})`);
