# Putting the site online (free)

The pieces:

- **Firebase Hosting:** serves the website. Free (Spark plan), no card needed.
- **Firebase Auth:** sign-in with Google, email + password, and later Apple. Free.
- **Firestore:** stores the listings, readable only by signed-in users, and each person's saved searches, readable only by them. Free.
- **GitHub Actions:** syncs every 5 minutes and redeploys when you push. Free for public repos.
- **Google Maps:** optional. Without a key the map uses free OpenFreeMap tiles.

Plan for about 30–45 minutes. Do the steps in order.

## 1. Firebase project

1. Go to <https://console.firebase.google.com>, choose **Create a project** and give it a name (e.g. `rent-stabilized-nyc`). Google Analytics isn't needed. You stay on the free **Spark** plan.
2. **Build → Firestore Database → Create database.** Choose **production mode** and the `nam5 (us-central)` location.
3. **Build → Authentication → Get started.** Under **Sign-in method**, enable:
   - **Google**
   - **Email/Password** (leave "Email link" off)
4. Under **Authentication → Settings**:
   - Turn on **User account management → Email enumeration protection** (it's usually on already).
   - Under **Password policy**, require a minimum length of 8.
5. **Project settings (gear) → General → Your apps → Web (`</>`).** Register an app (no Hosting setup needed here) and copy the `firebaseConfig` values into [`web/config.js`](web/config.js):
   - `apiKey`, `projectId`, `appId` exactly as shown.
   - `authDomain`: use **`<project-id>.web.app`** (not `firebaseapp.com`) so sign-in works in Safari and iPhone home-screen apps.

   These values aren't secrets. Your data is protected by the rules in [`firestore.rules`](firestore.rules), which allow only signed-in users to read listings and only you to read your own saved searches.

## 2. Service account for GitHub

The sync and deploy jobs need a key to write to Firestore and Hosting.

1. Go to <https://console.cloud.google.com/iam-admin/serviceaccounts> and select your Firebase project.
2. Choose **Create service account**, name it `github-sync`, and grant these roles:
   - **Cloud Datastore User** (writes listings)
   - **Firebase Hosting Admin** (deploys the site)
   - **Firebase Rules Admin** (deploys security rules)
   - **Service Account User**
3. Open the account, then **Keys → Add key → JSON**. A file downloads. Treat it like a password: never commit it, and delete the file after step 3.

## 3. GitHub repo

1. Create a **public** repo at <https://github.com/new>, e.g. `rent-stabilized-nyc`. It needs to be public for the free 5-minute sync; the data still requires sign-in.
2. In the repo, go to **Settings → Secrets and variables → Actions**:
   - **Secrets → New secret** `FIREBASE_SERVICE_ACCOUNT`: paste the whole JSON key file. Then delete the downloaded file.
   - **Variables → New variable** `FIREBASE_PROJECT_ID`: your project ID.
3. Push this folder:
   ```bash
   cd ~/Downloads/reasier-client
   git remote add origin https://github.com/<you>/rent-stabilized-nyc.git
   git push -u origin main
   ```
4. Pushing runs the **deploy** workflow, which deploys the site and rules. Then open **Actions → sync → Run workflow** once to load the first data. After that it runs every 5 minutes by itself.

Your site is live at **`https://<project-id>.web.app`**. To use your own domain, go to **Hosting → Add custom domain**.

## 4. Google Maps (optional)

The site works without this, using free OpenFreeMap tiles.

1. Google Maps requires a billing account even within its free monthly usage. At <https://console.cloud.google.com/google/maps-apis>, enable the **Maps JavaScript API** for the same project.
2. **Credentials → Create credentials → API key**, then restrict it:
   - **Application restrictions → Websites:** `https://<project-id>.web.app/*` and `https://<project-id>.firebaseapp.com/*`
   - **API restrictions:** Maps JavaScript API only
3. **Map management → Create Map ID** (JavaScript, vector). Put the key and the Map ID in `web/config.js` (`googleMapsKey`, `googleMapId`), then push.
4. Set a **budget alert** under Billing so a traffic spike can't surprise you.

## 5. Sign in with Apple (when you're ready for the App Store)

This needs a paid Apple Developer account ($99/yr).

1. Follow Firebase's guide (**Authentication → Sign-in method → Apple**). You create a Services ID and key in Apple's developer portal and paste them into Firebase.
2. Add `"apple"` to `providers` in `web/config.js` and push.

## 6. On phones

Open the site in Safari (iPhone) or Chrome (Android), then choose **Share → Add to Home Screen** (or **Install app**). It opens full-screen with its own icon. A native App Store / Play Store app can wrap the same site later.

## How data is protected

- **Listings:** stored only in Firestore and readable only by signed-in users. Email/password accounts must verify their email first. Nothing is downloadable without signing in.
- **Saved searches:** live at `users/<uid>/searches`. The rules let only that user read, write or delete them, and they check each search's shape and size.
- **Writes:** only the sync job (with the service account) can change listings. Nothing in the browser can.
- **What's stored about people:** only what Firebase Auth needs (email or Google/Apple identity) plus their saved searches. No tracking scripts.
- **Descriptions:** listing descriptions aren't published to the site (they're StreetEasy's copyrighted text). The site shows facts and links to the original listing.

## Changing the sync interval

Edit the `cron` line in [`.github/workflows/sync.yml`](.github/workflows/sync.yml). `*/5 * * * *` is every 5 minutes, GitHub's minimum; GitHub may start runs a few minutes late when busy.

## Always-on sync server (every 60 seconds)

A free Google Cloud e2-micro server runs the sync every minute, around the
clock. GitHub keeps running as the backup and stands down while the server is
checking. The server has no Firebase key on disk: it signs in as its own
service account, which may only read and write the database.

1. **Project:** in the [Google Cloud console](https://console.cloud.google.com/projectcreate)
   create a new project (for example `rent-sync`) and link a billing account.
   Keep it separate from `rent-stabilized-nyc` so the site stays on the free
   Firebase plan. Then set a $1 budget alert under **Billing → Budgets & alerts**.
2. **Service account:** in the new project, **IAM & Admin → Service accounts →
   Create**, name it `rent-sync`, grant it no roles, and click Done.
3. **Database access:** switch to the `rent-stabilized-nyc` project, open
   **IAM → Grant access**, paste the account's email
   (`rent-sync@<new-project-id>.iam.gserviceaccount.com`) and give it the
   **Cloud Datastore User** role.
4. **Server:** back in the new project, **Compute Engine → VM instances →
   Create instance**:
   - Region **us-east1**, machine type **e2-micro**
   - Boot disk: **Ubuntu 24.04 LTS (x86/64)**, disk type **Standard persistent
     disk**, 30 GB or less (other disk types aren't free)
   - Security/Identity: service account **rent-sync**, access scopes **Allow
     full access to all Cloud APIs** (the role above still limits it to the database)
   - Networking: leave **Allow HTTP/HTTPS traffic** unchecked
   - Check the monthly estimate on the right before clicking **Create**
5. **Install:** click **SSH** next to the server and paste:

   ```bash
   git clone -q --depth 1 https://github.com/laurenbotha2000-wq/rent-stabilized-nyc /tmp/rsn && sudo bash /tmp/rsn/scripts/install-server-poller.sh
   ```

   The first install builds the sync program (about 15–20 minutes), then syncs
   every 60 seconds. Run the same command again to update after code changes.

Watch it with `journalctl -u rent-stabilized-sync -f`. Turn it off with
`sudo bash /opt/rent-stabilized-sync/scripts/install-server-poller.sh --remove`.

On another Linux server (Hetzner, a Raspberry Pi, an old
PC; Ubuntu or Debian), put a Firebase key at `/etc/rent-stabilized-sync/key.json` before running
the installer; it stays root-only and systemd hands it to the sync.

## Faster polling from your Mac (every 2 minutes)

GitHub checks every 5 minutes and stands down whenever your Mac has checked
in the last 4 minutes. To turn the Mac poller on (or update it after
changing the sync code):

```bash
~/Downloads/reasier-client/scripts/install-mac-poller.sh
```

macOS doesn't let background jobs read the Downloads folder, so the installer
copies what the sync needs to `~/Library/Application Support/RentStabilizedSync`
and runs it from there. It only runs while the Mac is awake; GitHub covers the
rest. Log: `~/Library/Logs/rent-stabilized-sync.log` (errors in `.err`). To turn
it off: `scripts/install-mac-poller.sh --remove`.

## Saved-search alerts (push notifications and email)

When a sync publishes new or relisted apartments or price drops,
`scripts/notify.mjs` checks every saved search with alerts on (🔔) and tells
its owner: one push notification per saved search on each device they turned
notifications on for, and one email per person when email alerts are set up.
It uses the same matching code as the site (`web/filters.js`).

- **Push** works now. People turn it on under **My profile → Alerts**. On an
  iPhone the site must be added to the Home Screen first (Share → Add to Home
  Screen, iOS 16.4 or later); Android and computers work in the browser.
  The push keys were created by `scripts/notify-setup.mjs`; the private key is
  in the admin-only `config/webpush` document, which no browser can read.
- **Email** needs a Gmail account to send from (ideally a new one just for
  alerts, so your personal address isn't shown):
  1. In the Google Cloud console for `rent-stabilized-nyc`, enable the
     **Gmail API**, then **APIs & Services → Credentials → Create credentials
     → OAuth client ID → Desktop app**, and download the JSON.
  2. Run, and sign in with the sending account when the link opens:
     ```bash
     GOOGLE_APPLICATION_CREDENTIALS=firebase-service-account.json node scripts/email-setup.mjs ~/Downloads/client_secret.json "Rent Stabilized NYC <your-alerts-address@gmail.com>"
     ```
  3. Set `emailAlerts: true` in `web/config.js` and deploy. Email alerts only
     ever go to each account's own verified address. Gmail allows about 500
     emails a day from a regular account.

## App Check (blocks requests that don't come from your site)

1. Google Cloud console → **Security → reCAPTCHA** → **Create key**: type
   *Website*, domains `rent-stabilized-nyc.web.app` and
   `rent-stabilized-nyc.firebaseapp.com`. Copy the key ID.
2. Firebase console → **App Check** → your web app → **reCAPTCHA Enterprise**
   → paste the key ID → Save.
3. Put the key ID in `web/config.js` as `appCheckSiteKey`, then deploy
   (`firebase deploy --only hosting`).
4. Watch **App Check → Firestore** metrics for a day. When nearly all
   requests show as verified, click **Enforce**. From then on, Firestore
   refuses anything that isn't your real site, even with a valid login.
