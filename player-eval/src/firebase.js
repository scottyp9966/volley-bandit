import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";

// Deliberately the SAME Firebase project as the main Volley Bandit app (see
// ../../src/firebase.js). Sharing a project is what lets Player Eval join a
// coach's existing team code and read that team's roster live, instead of
// re-entering players by hand or importing a screenshot. If you swap this to
// your own Firebase project, keep it pointed at the same project the
// companion Volley Bandit app uses, or the two will never see each other's
// data. See the root README's "Setting up Firebase" section for the full
// walkthrough.
const firebaseConfig = {
  apiKey: "AIzaSyCZhB-6S5ZZAtcXzQFRgorWvP26jSm3x4E",
  authDomain: "volley-bandit.firebaseapp.com",
  projectId: "volley-bandit",
  storageBucket: "volley-bandit.firebasestorage.app",
  messagingSenderId: "104775662651",
  appId: "1:104775662651:web:41e2b70262fc4a14c4b01e",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

enableIndexedDbPersistence(db).catch((err) => {
  console.warn("Offline persistence not enabled:", err.code);
});
