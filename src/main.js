import ePub from "epubjs";
import "./style.css";

// =========================================================================
// Webnovel reader — a private, offline, on-device library.
//
// The library (home) is the app's root: a cover shelf of books and series,
// with `.epub` import. Tapping a cover pushes the reader; tapping a series
// tile pushes the series screen. Nothing ever leaves the device — books,
// covers, chapter lists and reading positions all live in IndexedDB.
// =========================================================================

// -------------------------------------------------------------------------
// Storage — one IndexedDB database, four object stores:
//   books    (keyPath id)      the imported .epub: bytes + parsed metadata
//   series   (keyPath id)      a named ordered group of book ids
//   progress (keyPath bookId)  per-book reading position + finished flag
//   kv       (plain key/value) misc app state (ui prefs, legacy migration)
// -------------------------------------------------------------------------
const DB_NAME = "webnovel-reader";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("series")) db.createObjectStore("series", { keyPath: "id" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath: "bookId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        const out = fn(os);
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
      })
  );
}
const dbGetAll = (store) => tx(store, "readonly", (os) => os.getAll());
const dbPut = (store, value) => tx(store, "readwrite", (os) => os.put(value));
const dbDelete = (store, key) => tx(store, "readwrite", (os) => os.delete(key));
const kvGet = (key) => tx("kv", "readonly", (os) => os.get(key));
const kvSet = (key, value) => tx("kv", "readwrite", (os) => os.put(value, key));
const kvDelete = (key) => tx("kv", "readwrite", (os) => os.delete(key));

// -------------------------------------------------------------------------
// In-memory state, hydrated from IndexedDB on startup.
// -------------------------------------------------------------------------
let books = []; // { id, title, author, coverBlob, chapters[], spineCount, fileBlob, seriesId, volumeIndex, addedAt }
let series = []; // { id, name, author, bookIds[] }
const progressMap = {}; // bookId -> { bookId, cfi, chapterIndex, chapterLabel, finished, updatedAt }
let ui = { sort: "recent", dismissedKeys: [], lastReadBookId: null };

const bookById = (id) => books.find((b) => b.id === id) || null;
const seriesById = (id) => series.find((s) => s.id === id) || null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Math.random().toString(36).slice(2) + Date.now());

async function loadState() {
  const [bookRows, seriesRows, progRows, savedUi] = await Promise.all([
    dbGetAll("books"),
    dbGetAll("series"),
    dbGetAll("progress"),
    kvGet("ui"),
  ]);
  books = bookRows || [];
  series = seriesRows || [];
  for (const p of progRows || []) progressMap[p.bookId] = p;
  if (savedUi) ui = { ...ui, ...savedUi };
}
const saveUi = () => kvSet("ui", ui);
async function putProgress(p) {
  progressMap[p.bookId] = p;
  await dbPut("progress", p);
}

// -------------------------------------------------------------------------
// Tiny DOM builder. Titles/authors come from untrusted epub metadata, so
// everything is set as text nodes — never innerHTML — unless marked `html`.
// -------------------------------------------------------------------------
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "dataset") Object.assign(e.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const svg = (html) => {
  const span = document.createElement("span");
  span.innerHTML = html;
  span.setAttribute("aria-hidden", "true");
  return span;
};
const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  handle: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>',
};

// -------------------------------------------------------------------------
// Cover object URLs — created lazily from stored blobs and cached per book,
// revoked only when a book is removed.
// -------------------------------------------------------------------------
const coverUrls = new Map();
function coverUrlFor(book) {
  if (!book?.coverBlob) return null;
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
  return coverUrls.get(book.id);
}
function coverNode(book, cls = "cover") {
  const url = book && coverUrlFor(book);
  if (url) return h("div", { class: cls }, h("img", { class: "cover__img", src: url, alt: "", loading: "lazy" }));
  return h("div", { class: cls + " cover--ph" });
}
function progressBar(pct, variant) {
  return h("div", { class: "pbar pbar--" + variant }, h("div", { class: "pbar__fill", style: `width:${pct}%` }));
}

// -------------------------------------------------------------------------
// Derived reading state.
// -------------------------------------------------------------------------
function chapterCount(book) {
  return book.spineCount || book.chapters?.length || 1;
}
// The furthest chapter ever reached in this book. Progress is measured from
// here (not the current resume point), so jumping *back* into an earlier
// chapter never lowers the reported percentage. Records written before this
// existed fall back to the current chapter.
function furthestIndex(book) {
  const p = progressMap[book.id];
  if (!p) return -1;
  return Math.max(p.maxChapterIndex ?? -1, p.chapterIndex ?? 0);
}
function bookPercent(book) {
  const p = progressMap[book.id];
  if (p?.finished) return 100;
  if (!p) return 0;
  return Math.min(100, Math.round(((furthestIndex(book) + 1) / chapterCount(book)) * 100));
}
function bookIsStarted(book) {
  return !!progressMap[book.id];
}
function bookMetaText(book) {
  const pct = bookPercent(book);
  if (pct >= 100) return "Finished";
  if (!bookIsStarted(book)) return "Not started";
  return pct + " %";
}
function seriesVolumes(s) {
  return (s.bookIds || []).map(bookById).filter(Boolean);
}
function seriesPercent(s) {
  let num = 0,
    den = 0;
  for (const b of seriesVolumes(s)) {
    const c = chapterCount(b);
    num += (bookPercent(b) / 100) * c;
    den += c;
  }
  return den ? Math.round((num / den) * 100) : 0;
}
// The volume the reader is "on": the most recently read unfinished volume,
// else the first unfinished, else the first.
function currentVolume(s) {
  const vols = seriesVolumes(s);
  let best = null,
    bestT = -1;
  for (const b of vols) {
    const p = progressMap[b.id];
    if (p && !p.finished && p.updatedAt > bestT) {
      bestT = p.updatedAt;
      best = b;
    }
  }
  if (best) return best;
  return vols.find((b) => bookPercent(b) < 100) || vols[0] || null;
}
function volumeNumber(s, book) {
  if (book.volumeIndex) return book.volumeIndex;
  return seriesVolumes(s).indexOf(book) + 1;
}
function nextVolume(book) {
  if (!book.seriesId) return null;
  const s = seriesById(book.seriesId);
  if (!s) return null;
  const vols = seriesVolumes(s);
  const i = vols.indexOf(book);
  return i >= 0 ? vols[i + 1] || null : null;
}
// Absolute chapter offset of a volume within its series (sum of earlier
// volumes' chapter counts), so "Ch. 351" in vol. 2 stays "Ch. 351".
function volumeChapterOffset(book) {
  if (!book.seriesId) return 0;
  const s = seriesById(book.seriesId);
  if (!s) return 0;
  let offset = 0;
  for (const b of seriesVolumes(s)) {
    if (b.id === book.id) break;
    offset += chapterCount(b);
  }
  return offset;
}
function continueTarget() {
  let best = null,
    bestT = -1;
  for (const b of books) {
    const p = progressMap[b.id];
    if (p && !p.finished && p.updatedAt > bestT) {
      bestT = p.updatedAt;
      best = b;
    }
  }
  return best || (ui.lastReadBookId ? bookById(ui.lastReadBookId) : null);
}
// "Vol. 2 · Chapter 214 · The Sanctuary"
function continueSubtitle(book) {
  const p = progressMap[book.id];
  const abs = (p ? p.chapterIndex : 0) + 1 + volumeChapterOffset(book);
  const parts = [];
  if (book.seriesId && book.volumeIndex) parts.push("Vol. " + book.volumeIndex);
  parts.push("Chapter " + abs);
  if (p?.chapterLabel) parts.push(p.chapterLabel);
  return parts.join(" · ");
}

// -------------------------------------------------------------------------
// Epub parsing on import — title, author, cover blob, chapter list.
// -------------------------------------------------------------------------
function flatten(items, depth = 0, out = []) {
  for (const item of items || []) {
    out.push({ label: (item.label || "").trim(), href: item.href, depth });
    if (item.subitems?.length) flatten(item.subitems, depth + 1, out);
  }
  return out;
}
// Pull a volume number out of a title or filename ("vol 2", "v2", "part 2").
function parseVolumeIndex(text) {
  if (!text) return null;
  const m = text.match(/\b(?:vol(?:ume)?\.?|v|part|book)\s*(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\b\s*$/);
  return m ? parseInt(m[1], 10) : null;
}
// Title with any volume marker stripped, for series naming + duplicate keys.
function stripVolume(title) {
  return (title || "")
    .replace(/\b(?:vol(?:ume)?\.?|v|part|book)\s*\d{1,3}\b/gi, "")
    .replace(/[\s\-–—:·|]+$/g, "")
    .trim();
}
const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const seriesKey = (book) => normalize(stripVolume(book.title)) + "|" + normalize(book.author);

// dc:subject isn't exposed by epub.js's parsed metadata, so read it straight
// from the package document. Best-effort: any failure just yields no subjects.
async function parseSubjects(b) {
  try {
    const opfPath = b.container?.packagePath || b.packaging?.metadata?.packagePath;
    if (!opfPath || !b.archive) return [];
    const xml = await b.archive.getText(opfPath);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return [...doc.getElementsByTagNameNS("*", "subject")]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function parseEpub(buffer, filename) {
  const b = ePub(buffer);
  await b.ready;
  const meta = await b.loaded.metadata.catch(() => ({}));
  const nav = await b.loaded.navigation.catch(() => ({ toc: [] }));
  const chapters = flatten(nav.toc);
  const spineCount = b.spine?.spineItems?.length || chapters.length || 1;
  const subjects = await parseSubjects(b);
  let coverBlob = null;
  try {
    const url = await b.coverUrl();
    if (url) coverBlob = await (await fetch(url)).blob();
  } catch {
    /* no cover */
  }
  const title = (meta.title || filename.replace(/\.epub$/i, "")).trim();
  const author = (meta.creator || "").trim();
  const clean = (v) => (v || "").trim();
  try {
    b.destroy();
  } catch {
    /* ignore */
  }
  return {
    title,
    author,
    coverBlob,
    chapters,
    spineCount,
    // Extra descriptive metadata for the info page. Web-novel epubs are often
    // sloppy, so any of these may be empty — the info page omits blank fields.
    description: clean(meta.description),
    language: clean(meta.language),
    publisher: clean(meta.publisher),
    published: clean(meta.pubdate),
    subjects,
    volumeIndex: parseVolumeIndex(title) || parseVolumeIndex(filename),
  };
}

async function createBook(buffer, filename, { seriesId = null } = {}) {
  const parsed = await parseEpub(buffer, filename);
  const book = {
    id: uid(),
    ...parsed,
    fileName: filename,
    fileBlob: new Blob([buffer], { type: "application/epub+zip" }),
    seriesId,
    addedAt: Date.now(),
  };
  books.push(book);
  await dbPut("books", book);
  return book;
}

// -------------------------------------------------------------------------
// Import flow — pick .epub files, parse and store them, then look for
// obvious duplicates/series to suggest grouping (never grouping silently).
// -------------------------------------------------------------------------
let pendingImportSeriesId = null;

async function importFiles(fileList) {
  const intoSeriesId = pendingImportSeriesId;
  pendingImportSeriesId = null;
  const files = [...fileList].filter((f) => /\.epub$/i.test(f.name));
  if (!files.length) return;

  const added = [];
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const book = await createBook(buffer, file.name, { seriesId: intoSeriesId });
      added.push(book);
    } catch (err) {
      console.warn("Could not import", file.name, err);
      alert(`Couldn't read "${file.name}". It may not be a valid .epub file.`);
    }
  }
  if (!added.length) return;

  if (intoSeriesId) {
    const s = seriesById(intoSeriesId);
    if (s) {
      for (const b of added) {
        b.volumeIndex = b.volumeIndex || s.bookIds.length + 1;
        s.bookIds.push(b.id);
        await dbPut("books", b);
      }
      await dbPut("series", s);
    }
  }

  renderCurrentRoute();
  if (!intoSeriesId) await suggestGrouping(added);
}

// After import, cluster books by (title-without-volume + author). Any cluster
// of 2+ standalone books that includes a new import, and hasn't been dismissed,
// gets one suggestion card.
async function suggestGrouping(added) {
  const seen = new Set();
  for (const nb of added) {
    const key = seriesKey(nb);
    if (seen.has(key) || ui.dismissedKeys.includes(key)) continue;
    seen.add(key);
    const cluster = books.filter((b) => seriesKey(b) === key);
    const seriesIds = new Set(cluster.map((b) => b.seriesId).filter(Boolean));
    if (seriesIds.size > 1) continue; // already split across series — leave it
    const grouped = cluster.every((b) => b.seriesId);
    if (grouped) continue; // already one series
    if (cluster.length < 2) continue;
    const name = stripVolume(nb.title) || nb.title;
    // eslint-disable-next-line no-await-in-loop
    const grouping = await showSuggestSheet(name, cluster.length);
    if (grouping) {
      await groupIntoSeries(cluster.map((b) => b.id), name);
    } else {
      ui.dismissedKeys.push(key);
      await saveUi();
    }
    renderCurrentRoute();
  }
}

// Create a series from a set of books, or fold them into an existing one if
// any of them already belongs to a series. Volume order: explicit index, then
// import order.
async function groupIntoSeries(bookIds, name) {
  const chosen = bookIds.map(bookById).filter(Boolean);
  if (chosen.length < 2) return;
  let s = chosen.map((b) => (b.seriesId ? seriesById(b.seriesId) : null)).find(Boolean);
  if (!s) {
    s = { id: uid(), name, author: chosen[0].author || "", bookIds: [] };
    series.push(s);
  }
  const existing = new Set(s.bookIds);
  const incoming = chosen.filter((b) => !existing.has(b.id));
  incoming.sort((a, b) => (a.volumeIndex ?? 99) - (b.volumeIndex ?? 99) || a.addedAt - b.addedAt);
  for (const b of incoming) s.bookIds.push(b.id);
  // Assign volume numbers by final order where missing.
  s.bookIds.forEach((id, i) => {
    const b = bookById(id);
    if (b) {
      b.seriesId = s.id;
      if (!b.volumeIndex) b.volumeIndex = i + 1;
    }
  });
  await dbPut("series", s);
  await Promise.all(seriesVolumes(s).map((b) => dbPut("books", b)));
}

// =========================================================================
// LIBRARY (home) — root screen
// =========================================================================
const el = {}; // DOM refs, filled after DOMContentLoaded

let libFilter = "";

// One entry per shelf tile: a standalone book or a whole series.
function shelfItems() {
  const items = [
    ...series.map((s) => ({ type: "series", series: s, title: s.name, activity: seriesActivity(s) })),
    ...books.filter((b) => !b.seriesId).map((b) => ({ type: "book", book: b, title: displayTitle(b), activity: bookActivity(b) })),
  ];
  if (ui.sort === "title") items.sort((a, b) => a.title.localeCompare(b.title));
  else items.sort((a, b) => b.activity - a.activity);
  if (libFilter) {
    const q = libFilter.toLowerCase();
    return items.filter((it) => it.title.toLowerCase().includes(q));
  }
  return items;
}
const bookActivity = (b) => progressMap[b.id]?.updatedAt || b.addedAt || 0;
const seriesActivity = (s) => Math.max(0, ...seriesVolumes(s).map(bookActivity));

function renderLibrary() {
  const body = el.libBody;
  body.innerHTML = "";

  if (!books.length) {
    body.append(emptyState());
    return;
  }

  // Continue section.
  const cont = continueTarget();
  if (cont && !libFilter) body.append(continueSection(cont));

  // All books.
  const items = shelfItems();
  const section = h("section", { class: "lib-section lib-section--grid" });
  const head = h(
    "div",
    { class: "lib-section__head" },
    h("span", { class: "lib-label" }, `All books · ${items.length}`),
    h(
      "button",
      { class: "sort-btn", onclick: toggleSort },
      ui.sort === "title" ? "Title" : "Recent",
      svg('<svg viewBox="0 0 24 24" width="13" height="13" style="margin-left:2px"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')
    )
  );
  section.append(head);

  const grid = h("div", { class: "grid" });
  for (const it of items) grid.append(it.type === "series" ? seriesTile(it.series) : bookTile(it.book));
  grid.append(importTile());
  section.append(grid);
  body.append(section);
}

function continueSection(book) {
  const card = h(
    "button",
    { class: "continue-card", onclick: () => openBook(book.id) },
    coverNode(book, "continue-card__cover"),
    h(
      "div",
      { class: "continue-card__text" },
      h("div", { class: "continue-card__title" }, displayTitle(book)),
      h("div", { class: "continue-card__sub" }, continueSubtitle(book)),
      progressBar(bookPercent(book), "card")
    )
  );
  return h(
    "section",
    { class: "lib-section lib-section--continue" },
    h("div", { class: "lib-label" }, "Continue"),
    card
  );
}

function bookTile(book) {
  const selecting = !!selection;
  const selected = selecting && selection.has(book.id);
  const cover = coverNode(book, "tile__cover");
  cover.append(progressBar(bookPercent(book), "cover"));
  if (selected) cover.append(h("span", { class: "tile__check" }, "✓"));
  const tile = h(
    "div",
    { class: "tile" + (selecting ? " tile--selectable" : "") + (selected ? " tile--selected" : ""), dataset: { bookId: book.id } },
    cover,
    h("div", { class: "tile__title" }, displayTitle(book)),
    h("div", { class: "tile__meta" }, bookMetaText(book))
  );
  attachTileGestures(tile, book);
  return tile;
}

function seriesTile(s) {
  const cur = currentVolume(s);
  const cover = coverNode(cur, "tile__cover");
  cover.append(h("span", { class: "vol-badge" }, String(s.bookIds.length)));
  cover.append(progressBar(seriesPercent(s), "cover"));
  const stack = h("div", { class: "series-stack" }, h("i", { class: "series-stack__l3" }), h("i", { class: "series-stack__l2" }), cover);
  const curNum = cur ? volumeNumber(s, cur) : 1;
  const tile = h(
    "div",
    { class: "tile tile--series", onclick: () => !selection && openInfo("series", s.id) },
    stack,
    h("div", { class: "tile__title" }, s.name),
    h("div", { class: "tile__meta" }, `${s.bookIds.length} volumes · Vol. ${curNum}`)
  );
  return tile;
}

function importTile() {
  return h(
    "button",
    { class: "tile tile--import", onclick: pickFiles },
    h(
      "div",
      { class: "import-box" },
      h("span", { class: "import-box__plus" }, "+"),
      h("span", { class: "import-box__label" }, "Import")
    ),
    h("div", { class: "tile__meta" }, ".epub from your files")
  );
}

function emptyState() {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty__book" }),
    h("div", { class: "empty__title" }, "No books yet"),
    h(
      "p",
      { class: "empty__lead" },
      "Add an .epub from your files and it stays on this device — covers, chapters and your place in it."
    ),
    h("button", { class: "empty__cta", onclick: pickFiles }, "+ Import an .epub"),
    h("button", { class: "empty__sample", onclick: loadSample }, "or try a sample")
  );
}

function toggleSort() {
  ui.sort = ui.sort === "title" ? "recent" : "title";
  saveUi();
  renderLibrary();
}

// =========================================================================
// INFO page (design 6a) — one screen for both a standalone book and a series.
// Reached by tapping any cover on the shelf. It *replaces* the old plain
// series screen: a series gets the full page (with a Volumes block), a
// standalone book gets the same page without it.
// =========================================================================

// A few small formatters for the metadata table / volume sheet.
function formatBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}
function formatPublished(v) {
  if (!v) return "";
  const m = String(v).match(/\d{4}/);
  return m ? m[0] : String(v);
}
function formatAdded(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  } catch {
    return "";
  }
}
const LANG_NAMES = {
  en: "English", fr: "French", ja: "Japanese", zh: "Chinese", es: "Spanish",
  de: "German", ko: "Korean", ru: "Russian", it: "Italian", pt: "Portuguese",
};
function formatLang(code) {
  if (!code) return "";
  const k = String(code).toLowerCase().split(/[-_]/)[0];
  return LANG_NAMES[k] || code;
}
// Strip HTML from a description without loading any resources (DOMParser does
// not run scripts or fetch), keeping paragraph breaks as newlines.
function stripHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.querySelectorAll("p, br, div, li").forEach((n) => n.after(doc.createTextNode("\n")));
    return (doc.body.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return String(html);
  }
}

// The text fields the info page shows and Edit details can type over.
const META_FIELDS = ["author", "description", "language", "published", "publisher"];

// A typed override, if the user entered one (empty means "no override").
function overrideOf(obj, field) {
  const v = obj?.overrides?.[field];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}
// The title to show for a book everywhere (shelf, reader, drawer, volume rows):
// an Edit-details override wins over the .epub's own title.
function displayTitle(book) {
  return (book && (overrideOf(book, "title") || book.title)) || "";
}
// Metadata for a collection resolves in priority order (spec 2d): a typed
// override wins, then the marked source volume, then the first volume with a
// value. Never merged field-by-field. Totals are summed across the collection.
function resolveField(container, vols, field, source) {
  const typed = overrideOf(container, field);
  if (typed) return typed;
  if (source && source[field]) return source[field];
  for (const b of vols) if (b[field]) return b[field];
  return "";
}
function resolveSubjects(container, vols, source) {
  if (container?.overrides?.subjects?.length) return container.overrides.subjects;
  if (source?.subjects?.length) return source.subjects;
  for (const b of vols) if (b.subjects?.length) return b.subjects;
  return [];
}
function metadataSource(s, vols) {
  return (s.metadataSourceBookId && bookById(s.metadataSourceBookId)) || vols[0] || null;
}

function infoModel(kind, id) {
  if (kind === "series") {
    const s = seriesById(id);
    if (!s) return null;
    const vols = seriesVolumes(s);
    const source = metadataSource(s, vols);
    return {
      kind, id, series: s, volumes: vols, currentVolume: currentVolume(s),
      coverBook: source || currentVolume(s),
      title: s.name,
      author: resolveField(s, vols, "author", source),
      description: resolveField(s, vols, "description", source),
      subjects: resolveSubjects(s, vols, source),
      language: resolveField(s, vols, "language", source),
      publisher: resolveField(s, vols, "publisher", source),
      published: resolveField(s, vols, "published", source),
      volumeCount: vols.length,
      chapterCount: vols.reduce((n, b) => n + chapterCount(b), 0),
      fileCount: vols.length,
      byteSize: vols.reduce((n, b) => n + (b.fileBlob?.size || 0), 0),
      continueTarget: currentVolume(s),
    };
  }
  const b = bookById(id);
  if (!b) return null;
  return {
    kind, id, book: b, volumes: [], currentVolume: null,
    coverBook: b,
    title: overrideOf(b, "title") || b.title,
    author: overrideOf(b, "author") || b.author || "",
    description: overrideOf(b, "description") || b.description || "",
    subjects: b.overrides?.subjects?.length ? b.overrides.subjects : b.subjects || [],
    language: overrideOf(b, "language") || b.language || "",
    publisher: overrideOf(b, "publisher") || b.publisher || "",
    published: overrideOf(b, "published") || b.published || "",
    volumeCount: null,
    chapterCount: chapterCount(b),
    fileCount: 1,
    byteSize: b.fileBlob?.size || 0,
    continueTarget: b,
  };
}

// The primary-action label: it always names the volume/chapter, so the volume
// list is optional. Start reading · Continue ch. N · Continue vol. N · ch. M · Read again.
function continueInfo(m) {
  const t = m.continueTarget;
  if (!t) return { label: "Start reading", target: null };
  const p = progressMap[t.id];
  if (bookPercent(t) >= 100) return { label: "Read again", target: t };
  if (!p) return { label: "Start reading", target: t };
  if (m.kind === "series") {
    const abs = (p.chapterIndex ?? 0) + 1 + volumeChapterOffset(t);
    return { label: `Continue vol. ${volumeNumber(m.series, t)} · ch. ${abs}`, target: t };
  }
  return { label: `Continue ch. ${(p.chapterIndex ?? 0) + 1}`, target: t };
}

function renderInfo(kind, id) {
  const m = infoModel(kind, id);
  const root = el.infoScreen;
  root.innerHTML = "";
  if (!m) {
    go({ route: "library" });
    return;
  }

  // Backdrop — the cover blurred behind the hero. No cover → flat page.
  const bgUrl = coverUrlFor(m.coverBook);
  if (bgUrl) {
    root.append(
      h(
        "div",
        { class: "info-backdrop" },
        h("div", { class: "info-backdrop__img", style: `background-image:url("${bgUrl}")` }),
        h("div", { class: "info-backdrop__veil" })
      )
    );
  }

  // Bar — back · ⋯ (no title; the title lives in the page).
  root.append(
    h(
      "div",
      { class: "info-bar" },
      h("button", { class: "sbar__icon", "aria-label": "Back", onclick: () => go({ route: "library" }) }, svg(ICON.back)),
      h("div", { class: "info-bar__spacer" }),
      h("button", { class: "sbar__icon", "aria-label": "More", onclick: () => openInfoMenu(m) }, svg(ICON.more))
    )
  );

  const content = h("div", { class: "info-content" });

  // Hero.
  content.append(
    h(
      "div",
      { class: "info-hero" },
      coverNode(m.coverBook, "info-hero__cover"),
      h("div", { class: "info-hero__title" }, m.title),
      m.author && h("div", { class: "info-hero__author" }, m.author)
    )
  );

  // Primary action.
  const ci = continueInfo(m);
  content.append(
    h(
      "div",
      { class: "info-actions" },
      h(
        "button",
        { class: "pill-btn info-actions__continue", disabled: !ci.target, onclick: () => ci.target && openBook(ci.target.id) },
        ci.label
      )
    )
  );

  // Subject chips.
  if (m.subjects.length) {
    const chips = h("div", { class: "info-chips" });
    for (const sub of m.subjects.slice(0, 6)) chips.append(h("span", { class: "info-chip" }, sub));
    content.append(chips);
  }

  // Description — clamped to 4 lines with an inline "more".
  if (m.description) {
    const body = h("p", { class: "info-desc__text" }, stripHtml(m.description));
    const more = h("button", { class: "info-desc__more", onclick: () => { body.classList.add("expanded"); more.remove(); } }, "more");
    content.append(h("div", { class: "info-desc" }, body, more));
    // Drop "more" if the text isn't actually clipped.
    requestAnimationFrame(() => {
      if (body.scrollHeight <= body.clientHeight + 2) more.remove();
    });
  }

  // Metadata table — missing fields are omitted, never blanked.
  const rows = [];
  if (m.volumeCount != null) rows.push(["Volumes", String(m.volumeCount)]);
  rows.push(["Chapters", m.chapterCount.toLocaleString()]);
  const lang = formatLang(m.language);
  if (lang) rows.push(["Language", lang]);
  const pub = formatPublished(m.published);
  if (pub) rows.push(["Published", pub]);
  if (m.publisher) rows.push(["Publisher", m.publisher]);
  const size = formatBytes(m.byteSize);
  rows.push(["On this device", `${m.fileCount} file${m.fileCount === 1 ? "" : "s"}${size ? " · " + size : ""}`]);
  const table = h("div", { class: "info-table" });
  for (const [label, value] of rows) {
    table.append(
      h("div", { class: "info-trow" }, h("span", { class: "info-trow__k" }, label), h("span", { class: "info-trow__v" }, value))
    );
  }
  content.append(table);

  // Volumes block (series only).
  if (m.kind === "series") {
    content.append(h("div", { class: "lib-label info-vollabel" }, "Volumes"));
    let offset = 0;
    for (const b of m.volumes) {
      const count = chapterCount(b);
      const start = offset + 1;
      const end = offset + count;
      offset = end;
      content.append(volumeRow(m.series, b, start, end, m.currentVolume));
    }
    content.append(
      h(
        "button",
        { class: "add-volume", onclick: () => addVolumeToSeries(m.series.id) },
        h("span", { class: "add-volume__plus" }, "+"),
        "Add a volume to this series"
      )
    );
  }

  root.append(content);
  root.scrollTop = 0;
}

function volumeRow(s, book, start, end, cur) {
  const isCurrent = cur && book.id === cur.id;
  const pct = bookPercent(book);
  const p = progressMap[book.id];
  let statusText;
  if (pct >= 100) statusText = "finished";
  else if (p) statusText = "reading ch. " + (p.chapterIndex + 1 + start - 1);
  else statusText = "not started";
  const title = "Vol. " + volumeNumber(s, book) + (stripVolume(displayTitle(book)) ? " · " + stripVolume(displayTitle(book)) : "");
  const row = h(
    "div",
    { class: "vrow" + (isCurrent ? " vrow--current" : "") },
    coverNode(book, "vrow__thumb"),
    h(
      "div",
      { class: "vrow__text" },
      h("div", { class: "vrow__title" }, title),
      h("div", { class: "vrow__sub" }, `Ch. ${start}–${end} · ${statusText}`)
    ),
    h("div", { class: "vrow__pct" }, pct >= 100 ? "100 %" : bookIsStarted(book) ? pct + " %" : "")
  );
  // Tap raises the volume sheet (it does not start reading); long-press is a
  // shortcut to delete the volume.
  attachLongPress(row, {
    onLongPress: () => confirmDeleteVolume(book),
    onTap: () => showVolumeSheet(s, book, start, end),
  });
  return row;
}

function addVolumeToSeries(seriesId) {
  pendingImportSeriesId = seriesId;
  pickFiles();
}

function renameSeries(s) {
  showNameSheet("Rename series", s.name, "Save").then((name) => {
    if (name) {
      s.name = name;
      dbPut("series", s);
      renderInfo("series", s.id);
    }
  });
}

async function confirmDeleteSeries(s) {
  const vols = seriesVolumes(s);
  const ok = await showConfirmSheet(
    "Delete this series?",
    `“${s.name}” and its ${vols.length} volume${vols.length === 1 ? "" : "s"} will be removed from this device — the files and your place in them. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  for (const b of vols) await deleteBook(b.id); // eslint-disable-line no-await-in-loop
  go({ route: "library" });
}

async function confirmDeleteBook(b) {
  const ok = await showConfirmSheet(
    "Delete this book?",
    `“${displayTitle(b)}” will be removed from this device — the file and your place in it. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  await deleteBook(b.id);
  go({ route: "library" });
}

// The ⋯ overflow menu on the info page.
function openInfoMenu(m) {
  if (m.kind === "series") {
    showActionSheet([
      { label: "Edit details", onClick: () => showEditDetails(m) },
      { label: "Series details", onClick: () => showSeriesDetails(m.series) },
      { label: "Delete series", danger: true, onClick: () => confirmDeleteSeries(m.series) },
    ]);
  } else {
    showActionSheet([
      { label: "Edit details", onClick: () => showEditDetails(m) },
      { label: "Delete book", danger: true, onClick: () => confirmDeleteBook(m.book) },
    ]);
  }
}

// =========================================================================
// Full-screen editors — Edit details (type over any field) and Series details
// (name, metadata source, volume order). Both live in the #editor overlay,
// dismissed by ✕ or Escape; only Save commits.
// =========================================================================
function closeEditor() {
  el.editor.hidden = true;
  el.editor.innerHTML = "";
}
function openEditorShell(title) {
  el.editor.innerHTML = "";
  const saveBtn = h("button", { class: "editor-save" }, "Save");
  el.editor.append(
    h(
      "div",
      { class: "editor-bar" },
      h("button", { class: "sbar__icon", "aria-label": "Cancel", onclick: closeEditor }, svg(ICON.close)),
      h("div", { class: "editor-bar__title" }, title),
      saveBtn
    )
  );
  const body = h("div", { class: "editor-body" });
  el.editor.append(body);
  el.editor.hidden = false;
  return { body, saveBtn };
}

// Edit details — type over any field; what's typed always wins. An emptied
// field drops the override and reverts to the file's value.
function showEditDetails(m) {
  const cur = {
    title: m.title,
    author: m.author,
    description: m.description,
    subjects: m.subjects.join(", "),
    language: m.language,
    published: m.published,
    publisher: m.publisher,
  };
  const { body, saveBtn } = openEditorShell("Edit details");
  body.append(h("p", { class: "editor-lead" }, "Type over anything the .epub got wrong. What you enter here always wins; clear a field to fall back to the file."));

  const inputs = {};
  const addField = (key, label, area) => {
    const input = area
      ? h("textarea", { class: "editor-input editor-input--area", rows: "5" })
      : h("input", { class: "editor-input", type: "text" });
    input.value = cur[key] || "";
    inputs[key] = input;
    body.append(h("label", { class: "editor-field" }, h("span", { class: "editor-field__label" }, label), input));
  };
  addField("title", "Title");
  addField("author", "Author");
  addField("description", "Description", true);
  addField("subjects", "Subjects (comma-separated)");
  addField("language", "Language");
  addField("published", "Published");
  addField("publisher", "Publisher");

  saveBtn.onclick = async () => {
    const val = (k) => inputs[k].value.trim();
    const subs = val("subjects").split(",").map((x) => x.trim()).filter(Boolean);
    if (m.kind === "series") {
      const s = m.series;
      if (val("title")) s.name = val("title"); // a series title is its name
      s.overrides = s.overrides || {};
      for (const k of META_FIELDS) {
        if (val(k)) s.overrides[k] = val(k);
        else delete s.overrides[k];
      }
      if (subs.length) s.overrides.subjects = subs;
      else delete s.overrides.subjects;
      await dbPut("series", s);
    } else {
      const b = m.book;
      b.overrides = b.overrides || {};
      for (const k of ["title", ...META_FIELDS]) {
        if (val(k)) b.overrides[k] = val(k);
        else delete b.overrides[k];
      }
      if (subs.length) b.overrides.subjects = subs;
      else delete b.overrides.subjects;
      await dbPut("books", b);
    }
    closeEditor();
    renderInfo(m.kind, m.id);
  };
}

// A one-line summary of what a volume file actually contains, so choosing the
// metadata source is informed rather than a guess.
function volumeContentsLabel(b) {
  const parts = [b.coverBlob ? "Has cover" : "No cover", b.description ? "description" : "no description"];
  const n = (b.subjects || []).length;
  if (n) parts.push(`${n} subject${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Series details — name, which volume supplies cover/description, and volume
// order (drag to reorder; reordering sets a manual-order flag).
function showSeriesDetails(s) {
  const { body, saveBtn } = openEditorShell("Series details");
  let order = [...s.bookIds];
  let sourceId = (s.metadataSourceBookId && bookById(s.metadataSourceBookId) ? s.metadataSourceBookId : s.bookIds[0]) || null;
  let reordered = false;

  // Series name.
  const nameInput = h("input", { class: "editor-input", type: "text" });
  nameInput.value = s.name || "";
  body.append(h("label", { class: "editor-field" }, h("span", { class: "editor-field__label" }, "Series name"), nameInput));

  // Metadata source radio list.
  body.append(h("div", { class: "editor-section-label" }, "Cover and description from"));
  body.append(h("p", { class: "editor-lead" }, "The volumes disagree, so pick which file the page should use. Fields are never mixed across volumes."));
  const radioList = h("div", { class: "radio-list" });
  const renderRadios = () => {
    radioList.innerHTML = "";
    for (const b of order.map(bookById).filter(Boolean)) {
      const selected = b.id === sourceId;
      const row = h(
        "button",
        {
          class: "radio-row" + (selected ? " radio-row--on" : ""),
          onclick: () => { sourceId = b.id; renderRadios(); },
        },
        h("span", { class: "radio-dot" + (selected ? " radio-dot--on" : "") }, selected ? "✓" : ""),
        h(
          "span",
          { class: "radio-row__text" },
          h("span", { class: "radio-row__title" }, "Vol. " + volumeNumber(s, b) + (stripVolume(b.title) ? " · " + stripVolume(b.title) : "")),
          h("span", { class: "radio-row__sub" }, volumeContentsLabel(b))
        )
      );
      radioList.append(row);
    }
  };
  renderRadios();
  body.append(radioList);

  // Volume order — drag handles; chapter ranges recompute from the order.
  body.append(h("div", { class: "editor-section-label" }, "Volume order"));
  const orderList = h("div", { class: "order-list" });
  const updateRanges = () => {
    let off = 0;
    [...orderList.children].forEach((row, i) => {
      const b = bookById(order[i]);
      if (!b) return;
      const c = chapterCount(b);
      row.querySelector(".order-row__range").textContent = `Ch. ${off + 1}–${off + c}`;
      off += c;
    });
  };
  const renderOrder = () => {
    orderList.innerHTML = "";
    for (const id of order) {
      const b = bookById(id);
      if (!b) continue;
      const handle = h("span", { class: "order-row__handle", "aria-hidden": "true" }, svg(ICON.handle));
      const row = h(
        "div",
        { class: "order-row", dataset: { id } },
        handle,
        h("span", { class: "order-row__title" }, stripVolume(b.title) || b.title),
        h("span", { class: "order-row__range" }, "")
      );
      attachOrderDrag(handle, row, orderList, () => {
        order = [...orderList.children].map((r) => r.dataset.id);
        reordered = true;
        updateRanges();
      });
      orderList.append(row);
    }
    updateRanges();
  };
  renderOrder();
  body.append(orderList);

  saveBtn.onclick = async () => {
    if (nameInput.value.trim()) s.name = nameInput.value.trim();
    s.metadataSourceBookId = sourceId;
    const vols = order.map(bookById).filter(Boolean);
    s.bookIds = vols.map((b) => b.id);
    if (reordered) {
      s.manualOrder = true;
      vols.forEach((b, i) => { b.volumeIndex = i + 1; });
      await Promise.all(vols.map((b) => dbPut("books", b)));
    }
    await dbPut("series", s);
    closeEditor();
    renderInfo("series", s.id);
  };
}

// Pointer-based drag reorder for one handle. Uses pointer capture so the drag
// survives the finger leaving the handle, and reorders DOM live; the caller
// syncs its model on each move.
function attachOrderDrag(handle, row, list, onReorder) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    row.classList.add("dragging");
    const move = (ev) => {
      const others = [...list.querySelectorAll(".order-row:not(.dragging)")];
      const after = others.find((r) => ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (after) list.insertBefore(row, after);
      else list.append(row);
      onReorder();
    };
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    // Pointer capture keeps the drag alive when the finger leaves the handle.
    // It can throw for a stale/synthetic pointer id — never let that abort the
    // drag we just wired up.
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
}

// =========================================================================
// Volume sheet (design 7a) — tapping a volume row raises this; it does not
// start reading. Continue / Chapters push the reader; Remove drops the volume.
// =========================================================================
function hideVolumeSheet() {
  el.volumeSheet.hidden = true;
  el.volumeCard.innerHTML = "";
}
function showVolumeSheet(s, book, start, end) {
  const total = seriesVolumes(s).length;
  const volNum = volumeNumber(s, book);
  const p = progressMap[book.id];
  const pct = bookPercent(book);
  const absCh = (p ? p.chapterIndex + 1 : 1) + volumeChapterOffset(book);
  const volTitle = "Vol. " + volNum + (stripVolume(displayTitle(book)) ? " · " + stripVolume(displayTitle(book)) : "");
  let statusLine;
  if (pct >= 100) statusLine = "Finished · 100 %";
  else if (p) statusLine = `Reading ch. ${absCh} · ${pct} %`;
  else statusLine = "Not started";
  const continueLabel = pct >= 100 ? "Read again" : p ? `Continue ch. ${absCh}` : "Start reading";

  const facts = [
    ["This volume", `${chapterCount(book)} chapters${formatBytes(book.fileBlob?.size) ? " · " + formatBytes(book.fileBlob.size) : ""}`],
    book.fileName && ["File", book.fileName],
    formatAdded(book.addedAt) && ["Added", formatAdded(book.addedAt)],
  ].filter(Boolean);

  const card = el.volumeCard;
  card.innerHTML = "";
  card.append(
    h("div", { class: "vsheet__handle" }),
    h(
      "div",
      { class: "vsheet__header" },
      coverNode(book, "vsheet__thumb"),
      h(
        "div",
        { class: "vsheet__hcol" },
        h("div", { class: "lib-label" }, `Volume ${volNum} of ${total}`),
        h("div", { class: "vsheet__title" }, volTitle),
        h("div", { class: "vsheet__sub" }, `${s.name} · ch. ${start}–${end}`),
        progressBar(pct, "card"),
        h("div", { class: "vsheet__status" }, statusLine)
      )
    ),
    h(
      "div",
      { class: "vsheet__actions" },
      h("button", { class: "pill-btn vsheet__continue", onclick: () => { hideVolumeSheet(); openBook(book.id); } }, continueLabel),
      h("button", { class: "outline-pill", onclick: () => { hideVolumeSheet(); openBook(book.id, { withDrawer: true }); } }, "Chapters")
    ),
    h(
      "div",
      { class: "vsheet__facts" },
      ...facts.map(([k, v]) => h("div", { class: "vsheet__fact" }, h("span", { class: "vsheet__fact-k" }, k), h("span", { class: "vsheet__fact-v" }, v)))
    ),
    h(
      "div",
      { class: "vsheet__textactions" },
      h("button", { class: "text-btn text-btn--danger", onclick: () => { hideVolumeSheet(); confirmDeleteVolume(book); } }, "Remove from series")
    )
  );
  el.volumeSheet.hidden = false;
}

// =========================================================================
// Action sheet — a small list of actions raised from a ⋯ menu.
// =========================================================================
function hideActionSheet() {
  el.actionSheet.hidden = true;
  el.actionCard.innerHTML = "";
}
function showActionSheet(actions) {
  const card = el.actionCard;
  card.innerHTML = "";
  for (const a of actions) {
    card.append(
      h(
        "button",
        {
          class: "action-item" + (a.danger ? " action-item--danger" : ""),
          onclick: () => { hideActionSheet(); a.onClick(); },
        },
        a.label
      )
    );
  }
  card.append(h("button", { class: "action-item action-item--cancel", onclick: hideActionSheet }, "Cancel"));
  el.actionSheet.hidden = false;
}

// =========================================================================
// Selection mode — long-press a cover to group covers into a series.
// =========================================================================
let selection = null; // Set of book ids, or null when not selecting

// A long-press primitive that survives a touchscreen. The naïve version
// cancelled on *any* pointermove, so finger jitter killed the press before it
// fired — on a phone it never triggered at all. Here the timer is only
// cancelled once movement passes a small threshold (a real scroll), so a still
// finger reliably reaches the hold.
function attachLongPress(node, { onLongPress, onTap, canStart = () => true, delay = 450, moveTolerance = 10 }) {
  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener("pointerdown", (e) => {
    if (!canStart()) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      onLongPress();
    }, delay);
  });
  node.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > moveTolerance || Math.abs(e.clientY - startY) > moveTolerance) clear();
  });
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("pointerleave", clear);
  node.addEventListener("click", (e) => {
    if (longPressed) {
      e.preventDefault();
      e.stopPropagation();
      longPressed = false;
      return;
    }
    onTap();
  });
}

function attachTileGestures(tile, book) {
  attachLongPress(tile, {
    canStart: () => !selection, // don't arm a new press while already selecting
    onLongPress: () => enterSelection(book.id),
    onTap: () => (selection ? toggleSelect(book.id) : openInfo("book", book.id)),
  });
}

function enterSelection(id) {
  selection = new Set([id]);
  document.getElementById("app").classList.add("selecting");
  updateSelectBar();
  renderLibrary();
}
function toggleSelect(id) {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  if (selection.size === 0) return exitSelection();
  updateSelectBar();
  renderLibrary();
}
function exitSelection() {
  selection = null;
  document.getElementById("app").classList.remove("selecting");
  el.selectBar.hidden = true;
  renderLibrary();
}
function updateSelectBar() {
  el.selectBar.hidden = false;
  el.selectCount.textContent = `${selection.size} selected`;
  el.selectGroup.disabled = selection.size < 2;
}
async function confirmGrouping() {
  const ids = [...selection];
  if (ids.length < 2) return;
  const titles = ids.map((id) => bookById(id)?.title || "");
  const prefill = longestCommonName(titles) || stripVolume(titles[0]);
  const name = await showNameSheet("Name this series", prefill, "Create series");
  if (name) {
    await groupIntoSeries(ids, name);
    exitSelection();
  }
}
function longestCommonName(titles) {
  if (!titles.length) return "";
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i].toLowerCase() === t[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-–—:·|]+$/g, "").trim();
}

// =========================================================================
// Deleting books — from the library (long-press → select → Delete) or from a
// series (long-press a volume row). Removal is total: the stored epub, its
// reading position and its cached cover URL all go. A series that drops below
// two volumes is dissolved back into standalone books.
// =========================================================================
async function deleteBook(id) {
  const b = bookById(id);
  if (!b) return;

  if (b.seriesId) {
    const s = seriesById(b.seriesId);
    if (s) {
      s.bookIds = s.bookIds.filter((x) => x !== id);
      if (s.bookIds.length < 2) {
        for (const rid of s.bookIds) {
          const rb = bookById(rid);
          if (rb) {
            rb.seriesId = null;
            await dbPut("books", rb);
          }
        }
        series = series.filter((x) => x.id !== s.id);
        await dbDelete("series", s.id);
      } else {
        await dbPut("series", s);
      }
    }
  }

  books = books.filter((x) => x.id !== id);
  delete progressMap[id];
  if (coverUrls.has(id)) {
    URL.revokeObjectURL(coverUrls.get(id));
    coverUrls.delete(id);
  }
  if (ui.lastReadBookId === id) {
    ui.lastReadBookId = null;
    await saveUi();
  }
  await dbDelete("books", id);
  await dbDelete("progress", id);
}

async function confirmDeleteSelection() {
  const ids = [...selection];
  if (!ids.length) return;
  const many = ids.length > 1;
  const ok = await showConfirmSheet(
    many ? `Delete ${ids.length} books?` : "Delete this book?",
    (many ? "They will be" : "It will be") + " removed from this device — the file and your place in it. This can't be undone.",
    "Delete"
  );
  if (!ok) return;
  for (const id of ids) await deleteBook(id); // eslint-disable-line no-await-in-loop
  exitSelection(); // re-renders the library
}

async function confirmDeleteVolume(book) {
  const ok = await showConfirmSheet(
    "Delete this volume?",
    `“${displayTitle(book)}” will be removed from this device — the file and your place in it. This can't be undone.`,
    "Delete"
  );
  if (!ok) return;
  const seriesId = book.seriesId;
  await deleteBook(book.id);
  if (seriesId && seriesById(seriesId)) renderInfo("series", seriesId);
  else go({ route: "library" });
}

// =========================================================================
// Sheets — suggestion (duplicate), name prompt.
// =========================================================================
function showSuggestSheet(name, count) {
  return new Promise((resolve) => {
    el.suggestBody.textContent =
      count > 2
        ? `${count} books share the same title and author. Group them as “${name}”?`
        : `Same title and author in the .epub metadata. Group them as “${name}”?`;
    el.suggestSheet.hidden = false;
    const done = (val) => {
      el.suggestSheet.hidden = true;
      el.suggestGroup.onclick = el.suggestKeep.onclick = el.suggestScrim.onclick = null;
      resolve(val);
    };
    el.suggestGroup.onclick = () => done(true);
    el.suggestKeep.onclick = () => done(false);
    el.suggestScrim.onclick = () => done(false);
  });
}
function showConfirmSheet(title, body, confirmLabel) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmBody.textContent = body;
    el.confirmOk.textContent = confirmLabel || "Delete";
    el.confirmSheet.hidden = false;
    const done = (val) => {
      el.confirmSheet.hidden = true;
      el.confirmOk.onclick = el.confirmCancel.onclick = el.confirmScrim.onclick = null;
      resolve(val);
    };
    el.confirmOk.onclick = () => done(true);
    el.confirmCancel.onclick = () => done(false);
    el.confirmScrim.onclick = () => done(false);
  });
}
function showNameSheet(title, prefill, confirmLabel) {
  return new Promise((resolve) => {
    el.nameTitle.textContent = title;
    el.nameConfirm.textContent = confirmLabel || "Save";
    el.nameInput.value = prefill || "";
    el.nameSheet.hidden = false;
    setTimeout(() => el.nameInput.focus(), 30);
    const done = (val) => {
      el.nameSheet.hidden = true;
      el.nameConfirm.onclick = el.nameCancel.onclick = el.nameScrim.onclick = el.nameInput.onkeydown = null;
      resolve(val);
    };
    el.nameConfirm.onclick = () => done(el.nameInput.value.trim() || prefill);
    el.nameCancel.onclick = () => done(null);
    el.nameScrim.onclick = () => done(null);
    el.nameInput.onkeydown = (e) => {
      if (e.key === "Enter") done(el.nameInput.value.trim() || prefill);
      if (e.key === "Escape") done(null);
    };
  });
}

// =========================================================================
// READER — chrome variant 1c. Reading surface unchanged; drawer gains the
// home row + current-book block; the top bar loses its folder button.
// =========================================================================
let book = null; // live epub.js Book
let rendition = null;
let currentBook = null; // the library book being read
let flatToc = [];
let currentHref = null;

async function openBook(id, { withDrawer = false } = {}) {
  const lib = bookById(id);
  if (!lib) return;
  currentBook = lib;
  go({ route: "reader", id }, true);
  await renderReader(lib);
  if (withDrawer) openDrawer();
}

async function renderReader(lib) {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  el.viewer.innerHTML = "";
  currentHref = null;
  updateChapterTitle(null);
  el.topTitle.textContent = displayTitle(lib);
  document.title = displayTitle(lib);

  // Populate the drawer (current book + chapters) immediately from stored
  // metadata, so the menu is usable the moment it opens — independent of how
  // long epub.js takes to lay out the first chapter.
  flatToc = (lib.chapters || []).slice();
  renderToc();
  updateDrawerBook();

  const buffer = await lib.fileBlob.arrayBuffer();
  book = ePub(buffer);
  rendition = book.renderTo("viewer", {
    flow: "scrolled-doc",
    manager: "default",
    width: "100%",
    height: "100%",
    spread: "none",
    allowScriptedContent: false,
  });
  rendition.themes.register("webnovel", "./reader-theme.css");
  rendition.themes.select("webnovel");
  rendition.hooks.content.register(injectChapterNav);

  el.btnPrev.disabled = false;
  el.btnNext.disabled = false;

  const saved = progressMap[lib.id]?.cfi;
  rendition.display(saved || undefined);

  // Refine the chapter list once the live navigation resolves (accurate hrefs).
  book.loaded.navigation.then((nav) => {
    flatToc = flatten(nav.toc);
    renderToc();
    updateChapterTitle(currentHref);
  });

  rendition.on("relocated", (location) => {
    currentHref = location?.start?.href || null;
    const idx = typeof location?.start?.index === "number" ? location.start.index : 0;
    highlightToc(currentHref);
    updateChapterTitle(currentHref);
    const total = book?.spine?.spineItems?.length || chapterCount(lib);
    const prev = progressMap[lib.id];
    // Furthest-reached: the recorded high-water mark only ever rises, and once
    // a book is finished it stays finished even if you reopen an early chapter.
    const maxChapterIndex = Math.max(prev?.maxChapterIndex ?? -1, idx);
    const finished = prev?.finished || (total > 0 && maxChapterIndex >= total - 1);
    putProgress({
      bookId: lib.id,
      cfi: location?.start?.cfi || null,
      chapterIndex: idx,
      maxChapterIndex,
      chapterLabel: chapterLabelFor(currentHref) || prev?.chapterLabel || "",
      finished,
      updatedAt: Date.now(),
    });
    ui.lastReadBookId = lib.id;
    saveUi();
    updateDrawerBook();
  });

  updateDrawerBook();
}

// Current-book block + volume switcher in the drawer.
function updateDrawerBook() {
  const lib = currentBook;
  if (!lib) {
    el.drawerBook.hidden = true;
    return;
  }
  el.drawerBook.hidden = false;
  const url = coverUrlFor(lib);
  if (url) {
    el.drawerCover.src = url;
    el.drawerCover.hidden = false;
  } else {
    el.drawerCover.hidden = true;
  }
  el.drawerBookTitle.textContent = displayTitle(lib);

  // Tapping the book block returns to its info page — the series page for a
  // volume, or the standalone book's own info page.
  el.drawerBook.classList.add("drawer-book--link");
  el.drawerBook.onclick = () => {
    closeDrawer();
    if (lib.seriesId && seriesById(lib.seriesId)) openInfo("series", lib.seriesId);
    else openInfo("book", lib.id);
  };

  const p = progressMap[lib.id];
  const n = (p ? p.chapterIndex + 1 : 1) + volumeChapterOffset(lib);
  const total = chapterCount(lib) + volumeChapterOffset(lib);
  el.drawerBookSub.textContent = `${n} of ${total.toLocaleString()} · ${bookPercent(lib)} %`;

  // Volume switcher for a book inside a series.
  el.drawerVolumes.innerHTML = "";
  if (lib.seriesId) {
    const s = seriesById(lib.seriesId);
    const vols = seriesVolumes(s);
    if (vols.length > 1) {
      el.drawerVolumes.hidden = false;
      for (const b of vols) {
        el.drawerVolumes.append(
          h(
            "button",
            {
              class: "vol-chip" + (b.id === lib.id ? " vol-chip--current" : ""),
              onclick: () => {
                closeDrawer();
                if (b.id !== lib.id) openBook(b.id);
              },
            },
            "Vol. " + volumeNumber(s, b)
          )
        );
      }
      return;
    }
  }
  el.drawerVolumes.hidden = true;
}

function renderToc() {
  el.tocList.innerHTML = "";
  for (const entry of flatToc) {
    const btn = h("button", { dataset: { href: entry.href }, class: entry.depth ? "depth-" + Math.min(entry.depth, 2) : "" }, entry.label || "Untitled");
    btn.addEventListener("click", () => {
      rendition.display(entry.href);
      closeDrawer();
    });
    el.tocList.append(h("li", null, btn));
  }
  highlightToc(currentHref);
}
const baseHref = (href) => (href || "").split("#")[0];
function highlightToc(href) {
  const current = baseHref(href);
  let match = null;
  el.tocList.querySelectorAll("button").forEach((btn) => {
    const is = baseHref(btn.dataset.href) === current;
    btn.classList.toggle("current", is);
    if (is) match = btn;
  });
  if (match) match.scrollIntoView({ block: "nearest" });
}
function chapterLabelFor(href) {
  const current = baseHref(href);
  for (const e of flatToc) if (baseHref(e.href) === current) return e.label || "";
  return null;
}
function updateChapterTitle(href) {
  const label = href ? chapterLabelFor(href) : "";
  if (label === null) return;
  el.chapterTitle.textContent = label;
  el.titleBlock.classList.toggle("has-chapter", label !== "");
}

// End-of-chapter navigation, injected into each chapter document. At the end
// of a volume that has a next volume in the library, this becomes the
// "ask me at the boundary" card rather than a silent jump.
function injectChapterNav(contents) {
  const doc = contents.document;
  if (!doc?.body || doc.querySelector(".chapter-end")) return;
  const total = book?.spine?.spineItems?.length || 0;
  const idx = typeof contents.sectionIndex === "number" ? contents.sectionIndex : -1;
  const atStart = idx === 0;
  const atEnd = total > 0 && idx >= total - 1;

  const wrap = doc.createElement("div");
  wrap.className = "chapter-end";
  const next = currentBook ? nextVolume(currentBook) : null;
  const inSeries = currentBook?.seriesId && seriesById(currentBook.seriesId);
  const volLabel = inSeries ? "End of Vol. " + volumeNumber(seriesById(currentBook.seriesId), currentBook) : "End of book";

  const label = doc.createElement("div");
  label.className = "chapter-end__label";
  label.textContent = atEnd ? volLabel : "End of chapter";
  wrap.appendChild(label);

  if (atEnd && inSeries) {
    // Volume boundary card.
    const card = doc.createElement("div");
    card.className = "vol-boundary";
    if (next) {
      const p = doc.createElement("div");
      p.className = "vol-boundary__lead";
      p.textContent = "Next up: Vol. " + volumeNumber(seriesById(currentBook.seriesId), next) + (stripVolume(next.title) ? " · " + stripVolume(next.title) : "");
      const cont = doc.createElement("button");
      cont.className = "cn-btn vol-boundary__go";
      cont.textContent = "Continue to Vol. " + volumeNumber(seriesById(currentBook.seriesId), next) + " →";
      cont.addEventListener("click", () => openBook(next.id));
      const back = doc.createElement("button");
      back.className = "cn-btn vol-boundary__back";
      back.textContent = "Back to series";
      back.addEventListener("click", () => openSeries(currentBook.seriesId));
      card.appendChild(p);
      card.appendChild(cont);
      card.appendChild(back);
    } else {
      const p = doc.createElement("div");
      p.className = "vol-boundary__lead";
      p.textContent = "The next volume isn't in your library yet.";
      const add = doc.createElement("button");
      add.className = "cn-btn vol-boundary__go";
      add.textContent = "Add a volume to this series";
      add.addEventListener("click", () => addVolumeToSeries(currentBook.seriesId));
      card.appendChild(p);
      card.appendChild(add);
    }
    wrap.appendChild(card);
  } else {
    const nav = doc.createElement("div");
    nav.className = "chapter-end__nav";
    const prev = doc.createElement("button");
    prev.className = "cn-btn cn-prev";
    prev.textContent = "← Previous";
    prev.disabled = atStart;
    prev.addEventListener("click", () => rendition && rendition.prev());
    const nx = doc.createElement("button");
    nx.className = "cn-btn cn-next";
    nx.textContent = "Next chapter →";
    nx.disabled = atEnd;
    nx.addEventListener("click", () => rendition && rendition.next());
    nav.appendChild(prev);
    nav.appendChild(nx);
    wrap.appendChild(nav);
  }
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

// =========================================================================
// Routing — library is the root; series and reader are pushed on top.
// =========================================================================
function setRouteChrome(route) {
  document.getElementById("app").dataset.route = route;
  if (route !== "reader") {
    closeDrawer();
    if (rendition) {
      rendition.destroy();
      rendition = null;
      book = null;
    }
  }
  if (route !== "library" && selection) exitSelection();
}

function renderCurrentRoute() {
  const route = document.getElementById("app").dataset.route;
  if (route === "info" && currentInfo) renderInfo(currentInfo.kind, currentInfo.id);
  else renderLibrary();
}

let currentInfo = null; // { kind: "book" | "series", id } when on the info route

// Apply a route state (without pushing history).
async function applyState(state) {
  const s = state || { route: "library" };
  if (s.route === "reader" && s.id) {
    currentInfo = null;
    setRouteChrome("reader");
    const lib = bookById(s.id);
    if (lib) {
      currentBook = lib;
      await renderReader(lib);
    } else {
      go({ route: "library" });
    }
  } else if (s.route === "info" && s.id) {
    currentInfo = { kind: s.kind || "series", id: s.id };
    setRouteChrome("info");
    renderInfo(currentInfo.kind, currentInfo.id);
  } else {
    currentInfo = null;
    setRouteChrome("library");
    renderLibrary();
  }
}
// Navigate + push history.
function go(state, push = true) {
  const cur = document.getElementById("app").dataset.route;
  if (state.route === "reader" && state.id) {
    currentInfo = null;
    setRouteChrome("reader");
  } else if (state.route === "info" && state.id) {
    currentInfo = { kind: state.kind || "series", id: state.id };
    setRouteChrome("info");
    renderInfo(currentInfo.kind, currentInfo.id);
  } else {
    currentInfo = null;
    setRouteChrome("library");
    renderLibrary();
  }
  if (push && cur !== undefined) history.pushState(state, "");
  else history.replaceState(state, "");
}
function openInfo(kind, id) {
  go({ route: "info", kind, id });
}
// Kept for callers that jump straight back to a series (e.g. the volume
// boundary card).
function openSeries(id) {
  openInfo("series", id);
}
window.addEventListener("popstate", (e) => applyState(e.state));

// =========================================================================
// Install (Add to Home Screen) — unchanged behavior from the single-book app.
// =========================================================================
let deferredInstallPrompt = null;
const INSTALL_DISMISSED = "installDismissed";
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

function showInstallBar() {
  if (localStorage.getItem(INSTALL_DISMISSED) === "1") return;
  el.installBar.hidden = false;
  requestAnimationFrame(() => el.installBar.classList.add("show"));
}
function hideInstallBar() {
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
async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === "accepted") hideInstallBar();
    return;
  }
  el.installSheet.hidden = false;
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone()) showInstallBar();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallBar();
  el.installSheet.hidden = true;
});

// -------------------------------------------------------------------------
// File picking + sample
// -------------------------------------------------------------------------
function pickFiles() {
  el.fileInput.click();
}
async function loadSample() {
  try {
    const res = await fetch("./sample.epub");
    const buffer = await res.arrayBuffer();
    await createBook(buffer, "sample.epub");
    renderLibrary();
  } catch (err) {
    console.warn("Could not load sample", err);
  }
}

// =========================================================================
// Wire up + startup
// =========================================================================
function collectRefs() {
  const ids = {
    libBody: "lib-body",
    libImport: "lib-import",
    libSearch: "lib-search",
    libSearchRow: "lib-search-row",
    libSearchInput: "lib-search-input",
    infoScreen: "info-screen",
    topTitle: "book-title",
    chapterTitle: "chapter-title",
    titleBlock: "title-block",
    btnToc: "btn-toc",
    btnPrev: "btn-prev",
    btnNext: "btn-next",
    drawer: "drawer",
    drawerHome: "drawer-home",
    drawerBook: "drawer-book",
    drawerCover: "drawer-cover",
    drawerBookTitle: "drawer-book-title",
    drawerBookSub: "drawer-book-sub",
    drawerVolumes: "drawer-volumes",
    scrim: "scrim",
    tocList: "toc-list",
    viewer: "viewer",
    selectBar: "select-bar",
    selectCancel: "select-cancel",
    selectCount: "select-count",
    selectGroup: "select-group",
    selectDelete: "select-delete",
    suggestSheet: "suggest-sheet",
    suggestScrim: "suggest-scrim",
    suggestBody: "suggest-body",
    suggestGroup: "suggest-group",
    suggestKeep: "suggest-keep",
    nameSheet: "name-sheet",
    nameScrim: "name-scrim",
    nameTitle: "name-title",
    nameInput: "name-input",
    nameConfirm: "name-confirm",
    nameCancel: "name-cancel",
    confirmSheet: "confirm-sheet",
    confirmScrim: "confirm-scrim",
    confirmTitle: "confirm-title",
    confirmBody: "confirm-body",
    confirmOk: "confirm-ok",
    confirmCancel: "confirm-cancel",
    volumeSheet: "volume-sheet",
    volumeScrim: "volume-scrim",
    volumeCard: "volume-card",
    actionSheet: "action-sheet",
    actionScrim: "action-scrim",
    actionCard: "action-card",
    editor: "editor",
    installBar: "install-bar",
    installBarAction: "install-bar-action",
    installBarDismiss: "install-bar-dismiss",
    installSheet: "install-sheet",
    installScrim: "install-scrim",
    installSheetClose: "install-sheet-close",
    fileInput: "file-input",
  };
  for (const [k, id] of Object.entries(ids)) el[k] = document.getElementById(id);
}

function wireEvents() {
  el.libImport.addEventListener("click", pickFiles);
  el.libSearch.addEventListener("click", () => {
    const showing = !el.libSearchRow.hidden;
    el.libSearchRow.hidden = showing;
    if (!showing) el.libSearchInput.focus();
    else {
      libFilter = "";
      el.libSearchInput.value = "";
      renderLibrary();
    }
  });
  el.libSearchInput.addEventListener("input", () => {
    libFilter = el.libSearchInput.value.trim();
    renderLibrary();
  });

  el.btnToc.addEventListener("click", openDrawer);
  el.scrim.addEventListener("click", closeDrawer);
  el.drawerHome.addEventListener("click", () => {
    closeDrawer();
    go({ route: "library" });
  });
  el.btnPrev.addEventListener("click", () => rendition && rendition.prev());
  el.btnNext.addEventListener("click", () => rendition && rendition.next());

  el.selectCancel.addEventListener("click", exitSelection);
  el.selectGroup.addEventListener("click", confirmGrouping);
  el.selectDelete.addEventListener("click", confirmDeleteSelection);

  el.volumeScrim.addEventListener("click", hideVolumeSheet);
  el.actionScrim.addEventListener("click", hideActionSheet);

  el.installBarAction.addEventListener("click", handleInstallClick);
  el.installBarDismiss.addEventListener("click", dismissInstallBar);
  el.installScrim.addEventListener("click", () => (el.installSheet.hidden = true));
  el.installSheetClose.addEventListener("click", () => (el.installSheet.hidden = true));

  el.fileInput.addEventListener("change", (e) => {
    importFiles(e.target.files);
    e.target.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!el.editor.hidden) return closeEditor();
      if (!el.actionSheet.hidden) return hideActionSheet();
      if (!el.volumeSheet.hidden) return hideVolumeSheet();
      if (!el.confirmSheet.hidden) return el.confirmCancel.click();
      if (!el.installSheet.hidden) return (el.installSheet.hidden = true);
      if (selection) return exitSelection();
      if (el.drawer.classList.contains("open")) return closeDrawer();
    }
    if (!rendition) return;
    if (e.key === "ArrowRight") rendition.next();
    else if (e.key === "ArrowLeft") rendition.prev();
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
  if (!isStandalone() && isIOS()) showInstallBar();
})();
