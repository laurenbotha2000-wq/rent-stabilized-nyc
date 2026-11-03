// Firestore admin client for the sync scripts.
// Credentials: FIREBASE_SERVICE_ACCOUNT (JSON key) when set; otherwise the
// machine's own Google identity (a cloud server's attached service account),
// so the always-on server needs no key file at all.
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const PROJECT_ID = process.env.FIREBASE_PROJECT || "rent-stabilized-nyc";

export function firestore() {
  const key = process.env.FIREBASE_SERVICE_ACCOUNT;
  initializeApp({ credential: key ? cert(JSON.parse(key)) : applicationDefault(), projectId: PROJECT_ID });
  return getFirestore();
}
