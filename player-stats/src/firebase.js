import { initializeApp } from "firebase/app";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";

// The SAME Firebase project as Volley Bandit and Player Eval (see
// ../../src/firebase.js), because the coach's app is what writes the
// documents this one reads. If you point this at a different project it will
// never find a single code.
//
// Note what this app does NOT do: it never touches `teams/{code}/…`. It reads
// exactly one document, `playerAccess/{code}`, and that document carries no
// team code, no roster and no other player's line. See ../README.md.
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

// A card already opened once still reads with no signal.
enableIndexedDbPersistence(db).catch((err) => {
  console.warn("Offline persistence not enabled:", err?.code);
});
