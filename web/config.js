// Public settings for the hosted site. These values are identifiers, not
// secrets: data is protected by Firestore security rules, and the Maps key
// is locked to your site's domain in Google Cloud.
export const CONFIG = {
  // Firebase console → Project settings → Your apps → Web app → SDK config.
  // Set authDomain to your Hosting domain (PROJECT.web.app) so sign-in works in Safari.
  firebase: {
    apiKey: "AIzaSyD391f8NEpK6p-n8p0ee24Hse4LCr6p1Io",
    // Switch to "rent-stabilized-nyc.web.app" once Google accepts that redirect
    // URI (better for Safari and the iPhone home-screen app).
    authDomain: "rent-stabilized-nyc.firebaseapp.com",
    projectId: "rent-stabilized-nyc",
    appId: "1:172339214539:web:faa3d427bd7b118e04434e",
  },
  // Sign-in buttons besides Google and email/password ("apple" once it's set up)
  providers: [],
  // Google Maps JavaScript API key (leave empty to use free OpenFreeMap tiles)
  googleMapsKey: "",
  googleMapId: "",
};
