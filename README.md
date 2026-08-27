# Webnovel Reader

A minimal EPUB reader that renders like Webnovel's dark night-mode:
Merriweather 18px / 1.8 line-height, `#1f2129` page, `#83848f` text,
ragged-left, no indent, spaced paragraphs. Chapters are read one at a time
with an end-of-chapter "Previous / Next chapter" break.

Everything runs locally in the browser — no book ever leaves your device.

## Features

- Open any `.epub` (button, or drag & drop the file anywhere)
- Chapters menu (drawer) — jump to any chapter, current one highlighted
- One chapter per view, with an end-of-chapter Previous/Next block
- Resumes the last book and reading position automatically (IndexedDB)
- Installable, fully offline PWA (service worker via `vite-plugin-pwa`)
- Works on desktop and mobile (responsive)
- `←` / `→` keys page through chapters

## Run (development)

```bash
npm install
npm run dev      # http://localhost:5173  (also printed on your LAN IP)
```

Open the LAN URL (e.g. `http://192.168.1.40:5173`) on your phone while on the
same WiFi to read on mobile. Note: the service worker / offline install only
activates over HTTPS (or `localhost`), so LAN dev is online-only — see below
to install it as a real offline app.

## Build

```bash
npm run build    # static site + service worker in dist/
npm run preview  # serve the built site locally
```

`dist/` is a plain static bundle: HTML, JS, CSS, the Merriweather fonts, and a
Workbox service worker that precaches the whole app shell.

## Put it on your phone (offline app)

The service worker needs HTTPS, so host the built `dist/` on any free static
host, then "Add to Home Screen". After the first load the app runs with **no
network at all** — your books are opened locally from the phone's Files /
iCloud Drive / Downloads and kept in the browser; nothing is ever uploaded.

Pick one (run from the project root after `npm run build`):

```bash
# Cloudflare Pages — root domain, ideal for a PWA
npx wrangler pages deploy dist

# Netlify
npx netlify deploy --prod --dir dist

# Surge
npx surge dist
```

GitHub Pages also works (base is `./`, so a project subpath is fine): push the
repo and serve `dist/` from a Pages workflow or the `gh-pages` branch.

On the phone: open the deployed URL in Safari (iOS) or Chrome (Android) →
Share / menu → **Add to Home Screen**. Launch it once online to cache, then
it opens offline forever.

## Layout

- `src/main.js` — app logic (epub.js rendering, TOC, persistence)
- `src/style.css` — app chrome (top bar, drawer, landing)
- `public/reader-theme.css` — the Webnovel-dark theme injected into each chapter
- `public/fonts/` — Merriweather (OFL) static faces
- `scripts/fetch-seed.mjs` — downloads the dev-seed books into `public/seed/`
- `vite.config.js` — Vite + PWA (service worker, manifest) config

## Dev seeding

For design/QA there is a hidden reset that fills the library with a fixed set
of real, public-domain books (from Project Gutenberg) covering every case the
design needs — with/without cover, started/unstarted, loose volumes, and
shelves. **Long-press the Import tile** (or the empty-state Import button) and
confirm. It is a *reset*: it wipes the current library first, so it never
duplicates. The books live in `public/seed/` (committed, excluded from the PWA
precache); regenerate them with `npm run seed:fetch`.
