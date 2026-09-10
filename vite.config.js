import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// This is what makes the app actually usable without signal in a gym:
// the PWA plugin generates a service worker that caches the app shell
// (HTML/JS/CSS) on first load, so every screen after that loads from the
// device itself, not the network. Combined with the localStorage-backed
// persistence in App.jsx, both halves of "offline" — the code loading, and
// the data being there — are covered.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Volley Bandit",
        short_name: "Volley Bandit",
        description: "Volley Bandit — lineups, rotations, and stats for volleyball coaches. Works without signal.",
        theme_color: "#1C2128",
        background_color: "#1C2128",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache everything needed to run the app itself. Data lives in
        // localStorage (handled in App.jsx), not in this cache.
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
    }),
  ],
});
