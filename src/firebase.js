import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";

// Fill these in with your own Firebase project's config (Project Settings
// → General → Your apps → SDK setup and configuration → Config object).
// See README.md for the full walkthrough of creating the project.
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// This is what makes offline actually work: writes and reads go through a
// local cache first, so the app keeps functioning with no signal, and syncs
// automatically once a connection comes back. Only one tab/device instance
// can hold this cache at a time per browser, which is fine for how this
// app is used (one person, one device, one browser tab).
enableIndexedDbPersistence(db).catch((err) => {
  // Fails if multiple tabs are open, or the browser doesn't support it —
  // the app still works, just without the offline cache in that case.
  console.warn("Offline persistence not enabled:", err.code);
});
