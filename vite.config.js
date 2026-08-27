import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// base "./" keeps asset URLs relative so the built app works from any path
// (local file host, GitHub Pages subpath, etc.). host: true exposes the dev
// server on the LAN so you can open it from your phone on the same WiFi.
export default defineConfig({
  base: "./",
  server: { host: true },
  plugins: [
    VitePWA({
      // Ship a service worker that precaches the whole app shell (JS, CSS,
      // HTML, the Merriweather fonts and icon), so once the app has loaded on
      // the phone it opens and reads with no network at all -- Mac off, WiFi
      // off, on the train. Your own books never touch the network either way:
      // they are read locally and kept in IndexedDB.
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "fonts/*.ttf"],
      workbox: {
        // Precache every built asset plus the fonts.
        globPatterns: ["**/*.{js,css,html,svg,ttf,woff2}"],
        // The dev-seed books (public/seed/*.epub) are a large, dev-only fixture
        // fetched on demand by a hidden long-press — never precache them.
        globIgnores: ["**/seed/**"],
        // Serve index.html for any navigation request while offline (SPA).
        navigateFallback: "index.html",
        // Fonts/epub can exceed the default 2 MiB precache cap.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: "Webnovel Reader",
        short_name: "Reader",
        description: "A private, offline EPUB reader in the Webnovel dark style.",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#1a1e27",
        theme_color: "#1a1e27",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
  ],
});
