// Exit 0 printing "skip=true" when another runner checked Reasier within
// FRESH_SECONDS (default 240), so a fallback runner can stand down.
//   node fresh.mjs   (credentials: see firebase.mjs)
import { firestore } from "./firebase.mjs";

const fresh = Number(process.env.FRESH_SECONDS || 240);
// runners record each check in meta/heartbeat (older runs: meta/status)
const db = firestore();
const [beat, status] = await Promise.all([db.doc("meta/heartbeat").get(), db.doc("meta/status").get()]);
const meta = beat.exists ? beat.data() : status.data();
const age = meta?.checked_at ? (Date.now() - meta.checked_at.toMillis()) / 1000 : Infinity;
const skip = age < fresh;
console.log(`last check ${Number.isFinite(age) ? `${Math.round(age)}s ago by ${meta.checked_by || "?"}` : "never"}; skip=${skip}`);
console.log(`skip=${skip}`);
