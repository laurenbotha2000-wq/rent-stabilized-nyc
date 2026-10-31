// Public settings for the hosted site. These values are identifiers, not
// secrets: data is protected by Firestore security rules, and the Maps key
// is locked to your site's domain in Google Cloud.
export const CONFIG = {
  // Firebase console → Project settings → Your apps → Web app → SDK config.
  // Set authDomain to your Hosting domain (PROJECT.web.app) so sign-in works in Safari.
  firebase: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT.web.app",
    projectId: "YOUR_PROJECT",
    appId: "YOUR_APP_ID",
  },
  // Sign-in buttons besides Google and email/password ("apple" once it's set up)
  providers: [],
  // Google Maps JavaScript API key (leave empty to use free OpenFreeMap tiles)
  googleMapsKey: "",
  googleMapId: "",
};
