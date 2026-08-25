import ePub from "epubjs";
import "./style.css";

// -------------------------------------------------------------------------
// Tiny IndexedDB store: keeps the last-opened book (bytes + name) and the
// last reading position, so reopening the app resumes where you left off --
// on desktop and mobile alike. One object store, a handful of keys.
// -------------------------------------------------------------------------
const DB_NAME = "webnovel-reader";
const STORE = "kv";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -------------------------------------------------------------------------
// DOM handles
// -------------------------------------------------------------------------
const el = {
  titleBlock: document.getElementById("title-block"),
  coverThumb: document.getElementById("cover-thumb"),
  topTitle: document.getElementById("book-title"),
  chapterTitle: document.getElementById("chapter-title"),
  btnToc: document.getElementById("btn-toc"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnOpen: document.getElementById("btn-open"),
  drawer: document.getElementById("drawer"),
  scrim: document.getElementById("scrim"),
  tocList: document.getElementById("toc-list"),
  viewer: document.getElementById("viewer"),
  landing: document.getElementById("landing"),
  landingOpen: document.getElementById("landing-open"),
  landingSample: document.getElementById("landing-sample"),
  landingInstall: document.getElementById("landing-install"),
  installBar: document.getElementById("install-bar"),
  installBarAction: document.getElementById("install-bar-action"),
  installBarDismiss: document.getElementById("install-bar-dismiss"),
  installSheet: document.getElementById("install-sheet"),
  installScrim: document.getElementById("install-scrim"),
  installSheetClose: document.getElementById("install-sheet-close"),
  fileInput: document.getElementById("file-input"),
  app: document.getElementById("app"),
};

// -------------------------------------------------------------------------
// Reader state
// -------------------------------------------------------------------------
let book = null;
let rendition = null;
let bookKey = null; // identifies the current book for position storage
let flatToc = []; // [{ label, href, depth }]
let currentHref = null; // href of the section currently in view
let coverObjectUrl = null; // blob URL for the current cover thumbnail

// -------------------------------------------------------------------------
// Open + render a book from an ArrayBuffer
// -------------------------------------------------------------------------
async function openBook(buffer, name, { persist = true } = {}) {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  el.viewer.innerHTML = "";

  // Reset the top-bar chapter label until the new book relocates.
  currentHref = null;
  flatToc = [];
  updateChapterTitle(null);

  // Reset the cover thumbnail; a new one is loaded below once available.
  if (coverObjectUrl) {
    URL.revokeObjectURL(coverObjectUrl);
    coverObjectUrl = null;
  }
  el.coverThumb.hidden = true;
  el.coverThumb.removeAttribute("src");
  el.titleBlock.classList.remove("has-cover");

  book = ePub(buffer);
  bookKey = "pos:" + name;

  // Default manager + scrolled-doc = one chapter per view, scrolled vertically.
  // Navigation between chapters is explicit (top-bar arrows, TOC, or the
  // end-of-chapter buttons), which gives the Webnovel "Next chapter" feel and
  // a clean break between chapters instead of an endless merged scroll.
  rendition = book.renderTo("viewer", {
    flow: "scrolled-doc",
    manager: "default",
    width: "100%",
    height: "100%",
    spread: "none",
    allowScriptedContent: false,
  });

  // The Webnovel-dark look, injected into every chapter document.
  rendition.themes.register("webnovel", "./reader-theme.css");
  rendition.themes.select("webnovel");

  // Append a "Previous / Next chapter" block to the bottom of each chapter.
  rendition.hooks.content.register(injectChapterNav);

  // Restore last position for this book, else start at the beginning.
  const savedCfi = persist ? await idbGet(bookKey) : null;
  await rendition.display(savedCfi || undefined);

  hideLanding();
  el.btnPrev.disabled = false;
  el.btnNext.disabled = false;

  // Title in the top bar + tab.
  book.loaded.metadata.then((meta) => {
    const title = meta.title || name.replace(/\.epub$/i, "");
    el.topTitle.textContent = title;
    document.title = title;
  });

  // Cover thumbnail in the top bar (many books have one; some don't). coverUrl
  // resolves to a blob URL, or null when the book declares no cover.
  const loadingBook = book;
  book.coverUrl().then((url) => {
    // Guard against a race where the user opened another book meanwhile.
    if (book !== loadingBook || !url) {
      return;
    }
    coverObjectUrl = url;
    el.coverThumb.src = url;
    el.coverThumb.hidden = false;
    el.titleBlock.classList.add("has-cover");
  }).catch(() => {
    /* no cover -- leave the thumbnail hidden */
  });

  // Build the chapters drawer. The TOC may load after the first relocation,
  // so refresh the top-bar chapter label once labels are available.
  book.loaded.navigation.then((nav) => {
    flatToc = flatten(nav.toc);
    renderToc();
    updateChapterTitle(currentHref);
  });

  // Track position: highlight current chapter, show it in the top bar,
  // and persist CFI.
  rendition.on("relocated", (location) => {
    currentHref = location?.start?.href || null;
    highlightToc(currentHref);
    updateChapterTitle(currentHref);
    if (persist && location?.start?.cfi) {
      idbSet(bookKey, location.start.cfi);
    }
  });

  // Keep the last book itself so a reload reopens it automatically.
  if (persist) {
    idbSet("lastBook", { name, buffer });
  }
}

// Flatten the (possibly nested) epub TOC into a depth-tagged list.
function flatten(items, depth = 0, out = []) {
  for (const item of items) {
    out.push({ label: (item.label || "").trim(), href: item.href, depth });
    if (item.subitems && item.subitems.length) {
      flatten(item.subitems, depth + 1, out);
    }
  }
  return out;
}

function renderToc() {
  el.tocList.innerHTML = "";
  for (const entry of flatToc) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = entry.label || "Untitled";
    if (entry.depth > 0) {
      btn.classList.add("depth-" + Math.min(entry.depth, 2));
    }
    btn.dataset.href = entry.href;
    btn.addEventListener("click", () => {
      rendition.display(entry.href);
      closeDrawer();
    });
    li.appendChild(btn);
    el.tocList.appendChild(li);
  }
}

// Compare TOC hrefs ignoring fragments (#anchor) and query noise.
function baseHref(href) {
  return (href || "").split("#")[0];
}

function highlightToc(href) {
  const current = baseHref(href);
  let matchBtn = null;
  el.tocList.querySelectorAll("button").forEach((btn) => {
    const isMatch = baseHref(btn.dataset.href) === current;
    btn.classList.toggle("current", isMatch);
    if (isMatch) {
      matchBtn = btn;
    }
  });
  if (matchBtn) {
    matchBtn.scrollIntoView({ block: "nearest" });
  }
}

// The chapter label shown in the top bar. When a section has no matching TOC
// entry (e.g. a sub-section between chapter markers), keep the last known
// label rather than blanking, so the bar stays stable while scrolling.
function chapterLabelFor(href) {
  const current = baseHref(href);
  for (const entry of flatToc) {
    if (baseHref(entry.href) === current) {
      return entry.label || "";
    }
  }
  return null;
}

function updateChapterTitle(href) {
  const label = href ? chapterLabelFor(href) : "";
  if (label === null) {
    return; // no match -- leave the current label in place
  }
  el.chapterTitle.textContent = label;
  el.titleBlock.classList.toggle("has-chapter", label !== "");
}

// -------------------------------------------------------------------------
// End-of-chapter navigation, injected into each chapter document (so it reads
// as part of the page). Prev is disabled on the first chapter, Next on the last.
// -------------------------------------------------------------------------
function injectChapterNav(contents) {
  const doc = contents.document;
  if (!doc || !doc.body || doc.querySelector(".chapter-end")) {
    return;
  }

  const total = book?.spine?.spineItems?.length || 0;
  const idx = typeof contents.sectionIndex === "number" ? contents.sectionIndex : -1;
  const atStart = idx === 0;
  const atEnd = total > 0 && idx >= total - 1;

  const wrap = doc.createElement("div");
  wrap.className = "chapter-end";

  const label = doc.createElement("div");
  label.className = "chapter-end__label";
  label.textContent = atEnd ? "End of book" : "End of chapter";

  const nav = doc.createElement("div");
  nav.className = "chapter-end__nav";

  const prev = doc.createElement("button");
  prev.className = "cn-btn cn-prev";
  prev.textContent = "← Previous";
  prev.disabled = atStart;
  prev.addEventListener("click", () => rendition && rendition.prev());

  const next = doc.createElement("button");
  next.className = "cn-btn cn-next";
  next.textContent = "Next chapter →";
  next.disabled = atEnd;
  next.addEventListener("click", () => rendition && rendition.next());

  nav.appendChild(prev);
  nav.appendChild(next);
  wrap.appendChild(label);
  wrap.appendChild(nav);
  doc.body.appendChild(wrap);
}

// -------------------------------------------------------------------------
// Drawer
// -------------------------------------------------------------------------
function openDrawer() {
  el.drawer.classList.add("open");
  el.scrim.hidden = false;
  requestAnimationFrame(() => el.scrim.classList.add("show"));
}
function closeDrawer() {
  el.drawer.classList.remove("open");
  el.scrim.classList.remove("show");
  const onEnd = () => {
    el.scrim.hidden = true;
    el.scrim.removeEventListener("transitionend", onEnd);
  };
  el.scrim.addEventListener("transitionend", onEnd);
}

// -------------------------------------------------------------------------
// Landing state
// -------------------------------------------------------------------------
function hideLanding() {
  el.landing.classList.add("hide");
}
function showLanding() {
  el.landing.classList.remove("hide");
}

// -------------------------------------------------------------------------
// File loading
// -------------------------------------------------------------------------
function readFile(file) {
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => openBook(reader.result, file.name);
  reader.readAsArrayBuffer(file);
}

// -------------------------------------------------------------------------
// Install (Add to Home Screen)
//
// Two very different platforms:
//  - Chrome / Edge / Android fire `beforeinstallprompt`; we stash it and let
//    our own button trigger the real one-tap install.
//  - iOS / iPad Safari have no such event -- the only way in is Share -> Add
//    to Home Screen -- so the button opens a short instructions sheet instead.
// Either way the button hides itself once the app is installed.
// -------------------------------------------------------------------------
let deferredInstallPrompt = null;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
// The footer nudge is remembered once dismissed, so we never nag again. The
// landing card's "Install app" button stays available regardless.
const INSTALL_DISMISSED = "installDismissed";

function showInstallUI() {
  el.landingInstall.hidden = false;
  if (localStorage.getItem(INSTALL_DISMISSED) !== "1") {
    el.installBar.hidden = false;
    // Next frame so the slide-up transition runs from the hidden state.
    requestAnimationFrame(() => el.installBar.classList.add("show"));
  }
}
function hideInstallUI() {
  el.landingInstall.hidden = true;
  el.installBar.classList.remove("show");
  el.installBar.hidden = true;
}
function dismissInstallBar() {
  localStorage.setItem(INSTALL_DISMISSED, "1");
  el.installBar.classList.remove("show");
  const onEnd = () => {
    el.installBar.hidden = true;
    el.installBar.removeEventListener("transitionend", onEnd);
  };
  el.installBar.addEventListener("transitionend", onEnd);
}
function openInstallSheet() {
  el.installSheet.hidden = false;
}
function closeInstallSheet() {
  el.installSheet.hidden = true;
}

async function handleInstallClick() {
  // Native prompt available (Chromium): fire it directly.
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === "accepted") {
      hideInstallUI();
    }
    return;
  }
  // No native prompt (iOS, or not yet eligible): show manual instructions.
  openInstallSheet();
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone()) {
    showInstallUI();
  }
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallUI();
  closeInstallSheet();
});

// iOS never fires beforeinstallprompt, so surface the button (which leads to
// instructions) whenever we are in iOS Safari and not already installed.
if (!isStandalone() && isIOS()) {
  showInstallUI();
}

// -------------------------------------------------------------------------
// Wire up events
// -------------------------------------------------------------------------
el.btnToc.addEventListener("click", openDrawer);
el.scrim.addEventListener("click", closeDrawer);

el.installBarAction.addEventListener("click", handleInstallClick);
el.installBarDismiss.addEventListener("click", dismissInstallBar);
el.landingInstall.addEventListener("click", handleInstallClick);
el.installScrim.addEventListener("click", closeInstallSheet);
el.installSheetClose.addEventListener("click", closeInstallSheet);

el.btnPrev.addEventListener("click", () => rendition && rendition.prev());
el.btnNext.addEventListener("click", () => rendition && rendition.next());

const pickFile = () => el.fileInput.click();
el.btnOpen.addEventListener("click", pickFile);
el.landingOpen.addEventListener("click", pickFile);
el.fileInput.addEventListener("change", (e) => readFile(e.target.files[0]));

// Load the bundled sample book (not persisted as "last book").
async function loadSample() {
  const res = await fetch("./sample.epub");
  const buffer = await res.arrayBuffer();
  await openBook(buffer, "sample.epub", { persist: false });
}
el.landingSample.addEventListener("click", (e) => {
  e.preventDefault();
  loadSample();
});

// Keyboard: arrows page through chapters, Esc closes the drawer.
document.addEventListener("keydown", (e) => {
  // Esc closes the install sheet even before a book is open.
  if (e.key === "Escape" && !el.installSheet.hidden) {
    closeInstallSheet();
    return;
  }
  if (!rendition) {
    return;
  }
  if (e.key === "ArrowRight") {
    rendition.next();
  } else if (e.key === "ArrowLeft") {
    rendition.prev();
  } else if (e.key === "Escape") {
    closeDrawer();
  }
});

// Drag & drop an .epub anywhere.
["dragenter", "dragover"].forEach((type) =>
  el.app.addEventListener(type, (e) => {
    e.preventDefault();
    el.landing.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((type) =>
  el.app.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === "dragleave" && e.relatedTarget) {
      return;
    }
    el.landing.classList.remove("drag");
  })
);
el.app.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.epub$/i.test(file.name)) {
    readFile(file);
  }
});

// -------------------------------------------------------------------------
// Resume the last book on startup
// -------------------------------------------------------------------------
(async () => {
  try {
    const last = await idbGet("lastBook");
    if (last?.buffer) {
      await openBook(last.buffer, last.name);
    }
  } catch (err) {
    console.warn("Could not restore last book:", err);
  }
})();
