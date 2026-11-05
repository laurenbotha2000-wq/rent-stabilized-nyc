// Sync watchdog, run every 10 minutes by GitHub Actions (.github/workflows/watchdog.yml).
// If the server hasn't checked in (meta/heartbeat) for over 10 minutes, push an alert to
// the devices of the people listed in config/alerts { uids: [...] }, again every hour
// while it stays down, and once more when it's back. Exits 1 while the sync is down, so
// GitHub also emails the repository owner about the failed run.
//
//   node watchdog.mjs            (needs Google credentials with Firestore access)
//   node watchdog.mjs --dry-run  (say what it would send, send nothing)
import admin from "firebase-admin";
import webpush from "web-push";

const SITE = "https://rent-stabilized-nyc.web.app";
const STALE_MS = 10 * 60_000, REPEAT_MS = 60 * 60_000;
const PUSH_SERVICE = /^https:\/\/(fcm\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const dryRun = process.argv.includes("--dry-run");

admin.initializeApp({ projectId: "rent-stabilized-nyc" });
const db = admin.firestore();

const toMs = (t) => (t?.toMillis ? t.toMillis() : t ? Date.parse(t) : 0);
const [beat, watch, alerts, pushCfg] = await Promise.all(
  ["meta/heartbeat", "meta/watchdog", "config/alerts", "config/webpush"].map((p) => db.doc(p).get()));

const last = toMs(beat.get("checked_at"));
const ago = Math.round((Date.now() - last) / 60_000);
const down = !last || Date.now() - last > STALE_MS;
const state = watch.exists ? watch.data() : {};
console.log(down ? `Sync is DOWN: last check-in ${last ? `${ago} min ago` : "never"}` : `Sync OK: last check-in ${ago} min ago`);

async function notify(title, body) {
  const uids = alerts.get("uids") || [];
  if (!pushCfg.exists || !uids.length) { console.log("No alert recipients or push keys set up; relying on GitHub's failed-run email."); return 0; }
  webpush.setVapidDetails(SITE, pushCfg.get("publicKey"), pushCfg.get("privateKey"));
  const payload = JSON.stringify({ title, body, url: SITE, tag: "sync-watchdog" });
  let sent = 0;
  for (const uid of uids) {
    const devices = await db.collection(`users/${uid}/devices`).limit(20).get();
    for (const d of devices.docs) {
      const { endpoint, p256dh, auth } = d.data();
      if (!PUSH_SERVICE.test(endpoint || "")) continue;
      if (dryRun) { console.log(`[dry run] push to ${uid.slice(0, 6)}…: ${title}`); continue; }
      try { await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, { TTL: 3600, urgency: "high" }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete(); else console.log(`push failed (${e.statusCode || e.message})`); }
    }
  }
  console.log(`Alert sent to ${sent} device${sent === 1 ? "" : "s"}.`);
  return sent;
}

if (down) {
  if (!state.last_alert || Date.now() - toMs(state.last_alert) > REPEAT_MS) {
    await notify("Stoopify sync has stopped", `No check-in from the server for ${last ? `${ago} minutes` : "a while"}. Listings aren't updating.`);
    if (!dryRun) await db.doc("meta/watchdog").set({ down_since: state.down_since || admin.firestore.Timestamp.fromMillis(last || Date.now()), last_alert: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  process.exit(1);
}
if (state.down_since) {
  const mins = Math.round((Date.now() - toMs(state.down_since)) / 60_000);
  await notify("Stoopify sync is back", `The server is checking in again after about ${mins} minutes.`);
  if (!dryRun) await db.doc("meta/watchdog").delete();
}
