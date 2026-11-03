// One-time setup for push alerts: create the site's Web Push key pair and
// store it in the admin-only config/webpush document. Prints the public key
// for web/config.js (vapidPublicKey). Running it again keeps the existing
// keys, since replacing them would cut off every device that signed up.
//
//   node notify-setup.mjs          (credentials: see firebase.mjs)
import webpush from "web-push";
import { firestore } from "./firebase.mjs";

const ref = firestore().doc("config/webpush");
const have = await ref.get();
if (have.exists) {
  console.log(`push keys already set up; public key:\n${have.get("publicKey")}`);
} else {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  await ref.create({ publicKey, privateKey, created_at: new Date() });
  console.log(`created push keys; put this in web/config.js as vapidPublicKey:\n${publicKey}`);
}
