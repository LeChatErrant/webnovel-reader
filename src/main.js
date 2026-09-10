// =========================================================================
// Webnovel reader — a private, offline, on-device library. Entry module: it
// pulls the app's modules together, wires the static chrome (top bar, drawer,
// select bar, install/update controls, file input, keyboard + drag-and-drop),
// and boots.
//
// The library (home) is the app's root: a cover shelf of books and series,
// with `.epub` import. Tapping a cover pushes the info page; tapping a series
// tile pushes the series screen. Nothing ever leaves the device — books,
// covers, chapter lists and reading positions all live in IndexedDB.
//
// Module map:
//   lib/*        pure, unit-tested helpers (text, chapters, format math)
//   db           IndexedDB primitives
//   state        in-memory library data + persistence
//   reading      derived reading state (percentages, ordinals, titles)
//   dom          element builder, icons, cover cache, refs, gestures
//   sheets       action sheet + confirm/name/suggest prompts
//   router       routing + the overlay/Back history stack
//   import       .epub parsing, import/grouping, dev-seed
//   library      home screen + multi-select
//   info         info page + editors + volume sheet
//   chapters     chapters screen + shared chapter-preview component
//   reader       reading surface, drawer, resume, chapter-nav injection
//   pwa          install prompt + service-worker update banner
// =========================================================================
import "./style.css";
import { el, collectRefs } from "./dom.js";
import { books, loadState, putProgress } from "./state.js";
import { kvGet, kvDelete } from "./db.js";
import { go, closeOverlay, overlayOpen } from "./router.js";
import { renderLibrary, setLibFilter, exitSelection, isSelecting, confirmGrouping, confirmDeleteSelection } from "./library.js";
import { openDrawer, closeDrawer, goChapter, flushReadingPosition, hasRendition } from "./reader.js";
import { importFiles, pickFiles, createBook } from "./import.js";
import {
  APP_VERSION, refreshInstallNote, handleInstallClick, checkForUpdatesManually,
  applyUpdate, hideUpdateBanner,
} from "./pwa.js";

function wireEvents() {
  el.libImport.addEventListener("click", pickFiles);
  el.libSearch.addEventListener("click", () => {
    const showing = !el.libSearchRow.hidden;
    el.libSearchRow.hidden = showing;
    if (!showing) el.libSearchInput.focus();
    else {
      setLibFilter("");
      el.libSearchInput.value = "";
      renderLibrary();
    }
  });
  el.libSearchInput.addEventListener("input", () => {
    setLibFilter(el.libSearchInput.value.trim());
    renderLibrary();
  });

  el.btnToc.addEventListener("click", openDrawer);
  // Close on a tap outside the drawer. A synthetic `click` on the scrim is
  // unreliable on Android when it overlays the epub iframe (the tap can be
  // swallowed), so dismiss on `pointerdown`, with `click` kept for mouse.
  el.scrim.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    closeDrawer();
  });
  el.scrim.addEventListener("click", closeDrawer);
  el.drawerHome.addEventListener("click", () => {
    closeDrawer();
    go({ route: "library" });
  });
  el.btnPrev.addEventListener("click", () => goChapter(-1));
  el.btnNext.addEventListener("click", () => goChapter(1));

  el.selectCancel.addEventListener("click", exitSelection);
  el.selectGroup.addEventListener("click", confirmGrouping);
  el.selectDelete.addEventListener("click", confirmDeleteSelection);

  el.volumeScrim.addEventListener("click", () => closeOverlay());
  el.actionScrim.addEventListener("click", () => closeOverlay());

  el.installNote.addEventListener("click", handleInstallClick);
  el.installScrim.addEventListener("click", () => closeOverlay());
  el.installSheetClose.addEventListener("click", () => closeOverlay());

  if (el.appVersion) el.appVersion.textContent = APP_VERSION;
  el.checkUpdate?.addEventListener("click", checkForUpdatesManually);
  el.updateReload?.addEventListener("click", applyUpdate);
  el.updateDismiss?.addEventListener("click", hideUpdateBanner);

  el.fileInput.addEventListener("change", (e) => {
    importFiles(e.target.files);
    e.target.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Any open overlay (sheet or editor) unwinds through the same path Back uses.
      if (overlayOpen()) return closeOverlay();
      if (isSelecting()) return exitSelection();
      if (el.drawer.classList.contains("open")) return closeDrawer();
    }
    if (!hasRendition()) return;
    if (e.key === "ArrowRight") goChapter(1);
    else if (e.key === "ArrowLeft") goChapter(-1);
  });

  // Drag & drop an .epub anywhere (desktop convenience).
  const app = document.getElementById("app");
  ["dragenter", "dragover"].forEach((t) =>
    app.addEventListener(t, (e) => {
      e.preventDefault();
      app.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((t) =>
    app.addEventListener(t, (e) => {
      e.preventDefault();
      if (t === "dragleave" && e.relatedTarget) return;
      app.classList.remove("drag");
    })
  );
  app.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
  });

  // Save the reading position the moment the app is backgrounded — phone lock,
  // app-switch, or tab close. Covers the gap left by the throttled scroll save.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushReadingPosition();
  });
  window.addEventListener("pagehide", flushReadingPosition);
}

// One-time migration from the single-book app: fold the previously-open book
// (and its saved position) into the new library.
async function migrateLegacy() {
  if (books.length) return;
  const last = await kvGet("lastBook").catch(() => null);
  if (!last?.buffer) return;
  try {
    const buffer = last.buffer instanceof ArrayBuffer ? last.buffer : await last.buffer.arrayBuffer?.();
    if (!buffer) return;
    const b = await createBook(buffer, last.name || "book.epub");
    const cfi = await kvGet("pos:" + last.name).catch(() => null);
    if (cfi) await putProgress({ bookId: b.id, cfi, chapterIndex: 0, chapterLabel: "", finished: false, updatedAt: Date.now() });
  } catch (err) {
    console.warn("Legacy migration failed:", err);
  }
  await kvDelete("lastBook").catch(() => {});
}

(async function start() {
  collectRefs();
  wireEvents();
  try {
    await loadState();
    await migrateLegacy();
  } catch (err) {
    console.warn("State load failed:", err);
  }
  go({ route: "library" }, false);
  refreshInstallNote();
})();
