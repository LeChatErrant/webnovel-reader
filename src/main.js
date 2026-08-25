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

async function parseEpub(buffer, filename) {
  const b = ePub(buffer);
  await b.ready;
  const meta = await b.loaded.metadata.catch(() => ({}));
  const nav = await b.loaded.navigation.catch(() => ({ toc: [] }));
  const chapters = flatten(nav.toc);
  const spineCount = b.spine?.spineItems?.length || chapters.length || 1;
  let coverBlob = null;
  try {
    const url = await b.coverUrl();
    if (url) coverBlob = await (await fetch(url)).blob();
  } catch {
    /* no cover */
  }
  const title = (meta.title || filename.replace(/\.epub$/i, "")).trim();
  const author = (meta.creator || "").trim();
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
    volumeIndex: parseVolumeIndex(title) || parseVolumeIndex(filename),
  };
}

async function createBook(buffer, filename, { seriesId = null } = {}) {
  const parsed = await parseEpub(buffer, filename);
  const book = {
    id: uid(),
    ...parsed,
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
    ...books.filter((b) => !b.seriesId).map((b) => ({ type: "book", book: b, title: b.title, activity: bookActivity(b) })),
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
      h("div", { class: "continue-card__title" }, book.title),
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
    h("div", { class: "tile__title" }, book.title),
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
    { class: "tile tile--series", onclick: () => !selection && openSeries(s.id) },
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
// SERIES screen
// =========================================================================
function renderSeries(id) {
  const s = seriesById(id);
  const root = el.seriesScreen;
  root.innerHTML = "";
  if (!s) {
    go({ route: "library" });
    return;
  }
  const vols = seriesVolumes(s);
  const cur = currentVolume(s);
  const totalChapters = vols.reduce((n, b) => n + chapterCount(b), 0);

  // Bar.
  root.append(
    h(
      "div",
      { class: "sbar" },
      h("button", { class: "sbar__icon", "aria-label": "Back", onclick: () => go({ route: "library" }) }, svg(ICON.back)),
      h("div", { class: "sbar__title" }, "Series"),
      h("button", { class: "sbar__icon", "aria-label": "Rename series", onclick: () => renameSeries(s) }, svg(ICON.more))
    )
  );

  // Header block.
  const metaBits = [s.author, `${vols.length} volumes`, `${totalChapters.toLocaleString()} chapters`].filter(Boolean);
  const curNum = cur ? volumeNumber(s, cur) : 1;
  root.append(
    h(
      "div",
      { class: "sheader" },
      coverNode(cur, "sheader__cover"),
      h(
        "div",
        { class: "sheader__col" },
        h("div", { class: "sheader__title" }, s.name),
        h("div", { class: "sheader__meta" }, metaBits.join(" · ")),
        cur &&
          h("button", { class: "pill-btn sheader__cta", onclick: () => openBook(cur.id) }, `Continue vol. ${curNum}`)
      )
    )
  );

  // Volumes.
  root.append(h("div", { class: "lib-label sheader__vollabel" }, "Volumes"));
  let offset = 0;
  for (const b of vols) {
    const count = chapterCount(b);
    const start = offset + 1;
    const end = offset + count;
    offset = end;
    root.append(volumeRow(s, b, start, end, cur));
  }

  root.append(
    h(
      "button",
      { class: "add-volume", onclick: () => addVolumeToSeries(s.id) },
      h("span", { class: "add-volume__plus" }, "+"),
      "Add a volume to this series"
    )
  );
}

function volumeRow(s, book, start, end, cur) {
  const isCurrent = cur && book.id === cur.id;
  const pct = bookPercent(book);
  const p = progressMap[book.id];
  let statusText;
  if (pct >= 100) statusText = "finished";
  else if (p) statusText = "reading ch. " + (p.chapterIndex + 1 + start - 1);
  else statusText = "not started";
  const title = "Vol. " + volumeNumber(s, book) + (stripVolume(book.title) ? " · " + stripVolume(book.title) : "");
  return h(
    "div",
    { class: "vrow" + (isCurrent ? " vrow--current" : ""), onclick: () => openBook(book.id) },
    coverNode(book, "vrow__thumb"),
    h(
      "div",
      { class: "vrow__text" },
      h("div", { class: "vrow__title" }, title),
      h("div", { class: "vrow__sub" }, `Ch. ${start}–${end} · ${statusText}`)
    ),
    h("div", { class: "vrow__pct" }, pct >= 100 ? "100 %" : bookIsStarted(book) ? pct + " %" : "")
  );
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
      renderSeries(s.id);
    }
  });
}

// =========================================================================
// Selection mode — long-press a cover to group covers into a series.
// =========================================================================
let selection = null; // Set of book ids, or null when not selecting

function attachTileGestures(tile, book) {
  let timer = null;
  let longPressed = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  tile.addEventListener("pointerdown", () => {
    if (selection) return;
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      enterSelection(book.id);
    }, 450);
  });
  tile.addEventListener("pointerup", clear);
  tile.addEventListener("pointermove", clear);
  tile.addEventListener("pointerleave", clear);
  tile.addEventListener("click", (e) => {
    if (longPressed) {
      e.preventDefault();
      longPressed = false;
      return;
    }
    if (selection) toggleSelect(book.id);
    else openBook(book.id);
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

async function openBook(id) {
  const lib = bookById(id);
  if (!lib) return;
  currentBook = lib;
  go({ route: "reader", id }, true);
  await renderReader(lib);
}

async function renderReader(lib) {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  el.viewer.innerHTML = "";
  currentHref = null;
  updateChapterTitle(null);
  el.topTitle.textContent = lib.title;
  document.title = lib.title;

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
  el.drawerBookTitle.textContent = lib.title;
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
  if (route === "series" && currentSeriesId) renderSeries(currentSeriesId);
  else renderLibrary();
}

let currentSeriesId = null;

// Apply a route state (without pushing history).
async function applyState(state) {
  const s = state || { route: "library" };
  if (s.route === "reader" && s.id) {
    currentSeriesId = null;
    setRouteChrome("reader");
    const lib = bookById(s.id);
    if (lib) {
      currentBook = lib;
      await renderReader(lib);
    } else {
      go({ route: "library" });
    }
  } else if (s.route === "series" && s.id) {
    currentSeriesId = s.id;
    setRouteChrome("series");
    renderSeries(s.id);
  } else {
    currentSeriesId = null;
    setRouteChrome("library");
    renderLibrary();
  }
}
// Navigate + push history.
function go(state, push = true) {
  const cur = document.getElementById("app").dataset.route;
  if (state.route === "reader" && state.id) {
    currentSeriesId = null;
    setRouteChrome("reader");
  } else if (state.route === "series" && state.id) {
    currentSeriesId = state.id;
    setRouteChrome("series");
    renderSeries(state.id);
  } else {
    currentSeriesId = null;
    setRouteChrome("library");
    renderLibrary();
  }
  if (push && cur !== undefined) history.pushState(state, "");
  else history.replaceState(state, "");
}
function openSeries(id) {
  go({ route: "series", id });
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
    seriesScreen: "series-screen",
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
