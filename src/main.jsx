import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { registerSW } from "virtual:pwa-register";

// Without this, the installed PWA only ever checks for a new version when
// its own service worker happens to notice — which for an icon that mostly
// just gets tapped open and closed (not left open in a browser tab) can be
// unreliable. This checks explicitly every 30 minutes while the app is
// open, and reloads immediately the moment it finds a newer version, so a
// fresh deploy actually reaches the device instead of waiting on chance.
const updateSW = registerSW({
  onRegisteredSW(swUrl, registration) {
    if (registration) {
      setInterval(() => registration.update(), 30 * 60 * 1000);
    }
  },
  onNeedRefresh() {
    updateSW(true);
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
