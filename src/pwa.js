// =========================================================================
// PWA plumbing — the Add-to-Home-Screen prompt and the service-worker update
// banner. Registering the worker and the install/update listeners are import-
// time side effects; the library footer wires the buttons to the exports here.
// =========================================================================
import { registerSW } from "virtual:pwa-register";
import { el } from "./dom.js";
import { armOverlay } from "./router.js";

// =========================================================================
// Install (Add to Home Screen). The only entry point is the persistent
// footnote pinned to the bottom of the library — no intrusive nudge bar.
// =========================================================================
let deferredInstallPrompt = null;
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

// Show the footnote whenever the app isn't already installed.
export function refreshInstallNote() {
  el.installNote.hidden = isStandalone();
}
export async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === "accepted") el.installNote.hidden = true;
    return;
  }
  el.installSheet.hidden = false;
  armOverlay(() => { el.installSheet.hidden = true; });
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  el.installNote.hidden = true;
  el.installSheet.hidden = true;
});

// =========================================================================
// App updates. The service worker (vite-plugin-pwa, "prompt" mode) checks the
// server for a newer build on load, on every focus, and hourly. When one
// finishes installing it *waits* instead of taking over mid-read; we surface
// that as a bottom banner. "Reload" tells the waiting worker to activate
// (skipWaiting) and refreshes once it controls the page.
//
// What the browser gives us, and where it stops:
//   • "installing"  — the registration's `updatefound` fires (reg.installing).
//   • "out of date" — a worker is waiting (surfaced as onNeedRefresh below).
//   • the version    — baked in at build time (__APP_VERSION__); there is no
//                      browser API for it, and no way to learn the server's
//                      latest without the update fetch we already do.
// Installed iOS PWAs never check in the background, so we poll on focus.
// =========================================================================
export const APP_VERSION = __APP_VERSION__;
let swRegistration = null;

function showUpdateBanner({ installing = false } = {}) {
  if (!el.updateBanner) return;
  el.updateBanner.hidden = false;
  el.updateBanner.classList.toggle("is-installing", installing);
  el.updateText.textContent = installing ? "Downloading a new version…" : "A new version is ready.";
  el.updateReload.hidden = installing;
}
export function hideUpdateBanner() {
  if (el.updateBanner) el.updateBanner.hidden = true;
}

// registerSW handles the waiting/reload plumbing; calling updateSW(true)
// activates the waiting worker and reloads the page.
const updateSW = registerSW({
  immediate: true,
  // A new worker has installed and is waiting — the app is now out of date.
  onNeedRefresh() {
    showUpdateBanner({ installing: false });
  },
  onRegisteredSW(swUrl, reg) {
    if (!reg) return;
    swRegistration = reg;
    // The "currently installing" phase, which registerSW itself doesn't expose.
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      // Announce updates, not the very first install (no controller yet).
      if (!navigator.serviceWorker.controller) return;
      showUpdateBanner({ installing: true });
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed") showUpdateBanner({ installing: false });
      });
    });
    // Poll for a fresh build: immediately whenever the app is refocused, and
    // every minute while it's actually on screen. `reg.update()` is a cheap
    // conditional GET of sw.js (usually a 304), and the `document.hidden`
    // guard means a backgrounded tab makes no requests at all — so a reader
    // left open notices a deploy within ~a minute without wasting battery.
    const UPDATE_POLL_MS = 60 * 1000;
    const check = () => { if (!document.hidden) reg.update().catch(() => {}); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    setInterval(check, UPDATE_POLL_MS);
  },
});
export const applyUpdate = () => updateSW(true);

// Set the update-check status line (its own line under the version row).
// kind: "ok" (green ✓), "err" (danger), or "" (neutral).
function setUpdateStatus(text, kind = "") {
  const s = el.updateStatus;
  if (!s) return;
  s.textContent = text;
  s.classList.toggle("is-ok", kind === "ok");
  s.classList.toggle("is-err", kind === "err");
}

// Manual "Check for updates" from the library footer: force a server check and
// report the outcome. If nothing is installing/waiting afterwards, we're current.
export async function checkForUpdatesManually() {
  if (!swRegistration) { setUpdateStatus("Updates aren't available here", "err"); return; }
  setUpdateStatus("Checking…");
  try {
    await swRegistration.update();
    if (!swRegistration.installing && !swRegistration.waiting) {
      const msg = "✓ You're up to date";
      setUpdateStatus(msg, "ok");
      setTimeout(() => { if (el.updateStatus?.textContent === msg) setUpdateStatus(""); }, 4000);
    } else {
      // An update is on its way — the banner takes over from here.
      setUpdateStatus("");
    }
  } catch {
    setUpdateStatus("Couldn't check — try again", "err");
  }
}
