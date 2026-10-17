import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Same offline-first shell as the other two apps. A player opens this on a
// phone in a gym as often as not, and a published card is a single small
// document, so Firestore's own IndexedDB cache (enabled in firebase.js) means
// a card she has already opened still reads with no signal.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "My Volleyball Stats",
        short_name: "My Stats",
        description: "Look up your own volleyball stats with the code your coach gave you.",
        theme_color: "#12161c",
        background_color: "#12161c",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
    }),
  ],
});
