import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { registerSW } from "virtual:pwa-register";

// Without this, the installed PWA only ever checks for a new version when
// its own service worker happens to notice — which for an icon that mostly
// just gets tapped open and closed (not left open in a browser tab) can be
// unreliable. This checks explicitly every 30 minutes while the app is
// open, so a fresh deploy actually reaches the device instead of waiting
// on chance.
//
// Fixed: this used to reload the page IMMEDIATELY and without warning the
// moment it found a new version — including mid-match, mid-print, or
// mid-stat-entry, since this checks every 30 minutes regardless of what
// you're doing in the app at that moment. Given how many updates got
// pushed in quick succession during heavy testing/debugging sessions, this
// is a very plausible explanation for the app "acting buggy" — an
// unannounced reload right in the middle of using it would look and feel
// exactly like that. Now it asks first, and only reloads if you say yes;
// declining just means the update applies next time you naturally close
// and reopen the app instead.
const updateSW = registerSW({
  onRegisteredSW(swUrl, registration) {
    if (registration) {
      setInterval(() => registration.update(), 30 * 60 * 1000);
    }
  },
  onNeedRefresh() {
    if (window.confirm("A new version of Volley Bandit is available. Reload now to get it?")) {
      updateSW(true);
    }
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
