import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Same offline-first setup as the main Volley Bandit app: this caches the
// app shell (HTML/JS/CSS) so it loads with no network after the first
// visit, while Firestore's own offline cache (enabled in firebase.js)
// handles the data half.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Player Eval",
        short_name: "Player Eval",
        description: "Player Eval — post-match skill ratings for volleyball coaches. Companion to Volley Bandit.",
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
