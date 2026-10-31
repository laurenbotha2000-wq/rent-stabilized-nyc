// Exit 0 printing "skip=true" when another runner checked Reasier within
// FRESH_SECONDS (default 240), so a fallback runner can stand down.
//   node fresh.mjs   (needs FIREBASE_SERVICE_ACCOUNT)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const fresh = Number(process.env.FRESH_SECONDS || 240);
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const meta = (await getFirestore().doc("meta/status").get()).data();
const age = meta?.checked_at ? (Date.now() - meta.checked_at.toMillis()) / 1000 : Infinity;
const skip = age < fresh;
console.log(`last check ${Number.isFinite(age) ? `${Math.round(age)}s ago by ${meta.checked_by || "?"}` : "never"}; skip=${skip}`);
console.log(`skip=${skip}`);
