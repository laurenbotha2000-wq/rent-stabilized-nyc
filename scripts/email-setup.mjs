// One-time setup for email alerts: sign in to the Gmail account the alerts
// are sent from, allowing only "send email" (gmail.send), and store the
// authorization in the admin-only config/email document.
//
//   node email-setup.mjs path/to/client_secret.json "Stoopify <alerts@example.com>"
//
// client_secret.json: Google Cloud console → APIs & Services → Credentials →
// Create credentials → OAuth client ID → Desktop app → Download JSON
// (with the Gmail API enabled in that project). See SETUP.md.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { firestore } from "./firebase.mjs";

const [file, from] = process.argv.slice(2);
if (!file || !from) throw new Error('usage: node email-setup.mjs client_secret.json "Name <address@gmail.com>"');
const { client_id, client_secret } = JSON.parse(readFileSync(file, "utf8")).installed
  ?? (() => { throw new Error("expected a Desktop app OAuth client"); })();

const state = randomBytes(16).toString("hex");
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirect = `http://127.0.0.1:${server.address().port}`;
const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
auth.search = new URLSearchParams({
  client_id, redirect_uri: redirect, response_type: "code", state,
  scope: "https://www.googleapis.com/auth/gmail.send", access_type: "offline", prompt: "consent",
});
console.log(`Open this link, sign in with the account alerts should come from, and allow sending email:\n\n${auth}\n`);

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.has("code") && !q.has("error")) { res.end(); return; }
    res.end(q.get("code") ? "Done. You can close this tab." : `Not authorized: ${q.get("error")}`);
    server.close();
    if (q.get("state") !== state) reject(new Error("sign-in response didn't match this request"));
    else if (q.get("code")) resolve(q.get("code"));
    else reject(new Error(q.get("error")));
  });
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  body: new URLSearchParams({ client_id, client_secret, code, redirect_uri: redirect, grant_type: "authorization_code" }),
});
const token = await res.json();
if (!token.refresh_token) throw new Error(`no refresh token returned: ${JSON.stringify(token.error || token)}`);
await firestore().doc("config/email").set({ from, client_id, client_secret, refresh_token: token.refresh_token, updated_at: new Date() });
console.log("Email alerts are set up. Turn them on for the site with emailAlerts: true in web/config.js.");
