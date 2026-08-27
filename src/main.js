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
const dbClear = (store) => tx(store, "readwrite", (os) => os.clear());
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
  sort: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
  if (url) return h("div", { class: cls }, h("img", { class: "cover__img", src: url, alt: "", loading: "lazy", draggable: "false" }));
  return h("div", { class: cls + " cover--ph" });
}
function progressBar(pct, variant) {
  return h("div", { class: "pbar pbar--" + variant }, h("div", { class: "pbar__fill", style: `width:${pct}%` }));
}

// -------------------------------------------------------------------------
// Derived reading state.
// -------------------------------------------------------------------------
// Web-novel epubs bundle front matter ahead of the real chapters: the same
// metadata/synopsis page we now render as our own info page, plus an in-book
// contents page that duplicates our chapter drawer. We hide these from the
// reader flow, the chapter menu and the chapter counts/numbers.
const FRONT_MATTER_RE =
  /^(informations?|table of contents|contents|toc|cover|title\s*page|copyright|colophon)$/i;
// Public-domain epubs (e.g. Project Gutenberg) tack a licence / boilerplate
// page onto the spine and TOC; it is never a real chapter, so hide it too.
const isFrontMatter = (label) => {
  const t = (label || "").trim();
  return FRONT_MATTER_RE.test(t) || /project gutenberg/i.test(t) || /\blicen[sc]e$/i.test(t);
};
// Never hide everything: if a whole TOC somehow matched, fall back to the
// original so the reader is never left empty.
function readableChapters(entries) {
  const kept = (entries || []).filter((e) => !isFrontMatter(e.label));
  return kept.length ? kept : entries || [];
}
const frontMatterCount = (book) => (book?.chapters || []).filter((e) => isFrontMatter(e.label)).length;

// Count the readable chapters, not spine items: the spine can carry extra
// front matter (e.g. an untracked cover page) the TOC never lists, so the
// readable TOC is the honest basis for counts and numbering.
function chapterCount(book) {
  return readableChapters(book.chapters || []).length || book.spineCount || 1;
}
// Which chapter (1-based, within its volume) a saved position sits on, counted
// over the readable TOC by label so leading front matter never inflates it.
function chapterOrdinalFor(book, p) {
  if (!p) return 1;
  const readable = readableChapters(book.chapters || []);
  const i = readable.findIndex((e) => e.label && e.label === p.chapterLabel);
  if (i >= 0) return i + 1;
  return Math.max(1, (p.chapterIndex ?? 0) + 1 - frontMatterCount(book));
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
// The furthest chapter reached, as a 1-based ordinal over the readable TOC (the
// same basis chapterOrdinalFor uses for the resume point). This drives the
// read/unread checkmarks, so jumping *back* into an earlier chapter never
// un-checks the ones beyond it — completion is measured from the high-water
// mark, only the "current" marker follows where you stopped.
//
// furthestIndex is a *spine* index (front matter included); the readable TOC has
// front matter removed. Map between them by counting the readable entries at or
// before that spine position, so only front matter that actually precedes the
// chapter is discounted — subtracting the whole book's front-matter count would
// under-report whenever a licence/boilerplate page trails the real chapters.
function furthestOrdinalFor(book) {
  const fi = furthestIndex(book);
  if (fi < 0) return 0;
  const chs = book.chapters || [];
  let ord = 0;
  for (let i = 0; i <= fi && i < chs.length; i++) if (!isFrontMatter(chs[i].label)) ord++;
  const len = readableChapters(chs).length || Infinity;
  return Math.min(len, Math.max(1, ord));
}
function bookPercent(book) {
  const p = progressMap[book.id];
  if (p?.finished) return 100;
  if (!p) return 0;
  // furthestIndex is a spine index, so measure against the spine total (which
  // includes front matter) to keep numerator and denominator on the same basis.
  const total = book.spineCount || chapterCount(book);
  return Math.min(100, Math.round(((furthestIndex(book) + 1) / total) * 100));
}
function bookIsStarted(book) {
  return !!progressMap[book.id];
}
// Roman numeral for the title-collision cue (11c). Volume indexes are small, so
// the full 1–3999 converter is overkill but harmless.
function toRoman(n) {
  if (!n || n < 1) return "";
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "", r = n;
  for (const [v, sym] of map) while (r >= v) { out += sym; r -= v; }
  return out;
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
  const abs = chapterOrdinalFor(book, p) + volumeChapterOffset(book);
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
// of 2+ standalone books that includes a new import gets one suggestion card.
// The prompt is import-time only (it never nags in the background), so we ask
// whenever look-alikes are imported. "Keep separate" declines just this import
// rather than suppressing the title forever — a permanent, easily-triggered
// dismissal (e.g. an accidental tap outside the sheet) silently killed the
// feature on phones.
async function suggestGrouping(added) {
  const seen = new Set();
  for (const nb of added) {
    const key = seriesKey(nb);
    if (seen.has(key)) continue;
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
    if (grouping) await groupIntoSeries(cluster.map((b) => b.id), name);
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

  // Title-collision cue (11c): when two or more shelf entries share a title,
  // each colliding tile is disambiguated with a numeral and a meta prefix. This
  // is derived from the current shelf, never stored on the book.
  const titleCounts = new Map();
  for (const it of items) {
    const k = normalize(it.title);
    titleCounts.set(k, (titleCounts.get(k) || 0) + 1);
  }
  const collides = (title) => (titleCounts.get(normalize(title)) || 0) > 1;
  // Under Recent sort, hold colliding entries adjacent so duplicates read as a
  // run rather than scattered look-alikes. Title sort already groups them.
  let ordered = items;
  if (ui.sort !== "title") {
    const out = [];
    const done = new Set();
    for (const it of items) {
      const k = normalize(it.title);
      if (done.has(k)) continue;
      done.add(k);
      out.push(it);
      if ((titleCounts.get(k) || 0) > 1) {
        for (const other of items) if (other !== it && normalize(other.title) === k) out.push(other);
      }
    }
    ordered = out;
  }

  const grid = h("div", { class: "grid" });
  for (const it of ordered) grid.append(it.type === "series" ? seriesTile(it.series) : bookTile(it.book, collides(it.title)));
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

function bookTile(book, collides = false) {
  const selecting = !!selection;
  const selected = selecting && selection.has(book.id);
  const cover = coverNode(book, "tile__cover");
  cover.append(progressBar(bookPercent(book), "cover"));
  // Collision cue: an OUTLINED roman-numeral pill, deliberately distinct from
  // the filled series volume-count badge, so the two are never confused.
  const numeral = collides && book.volumeIndex ? toRoman(book.volumeIndex) : null;
  if (numeral) cover.append(h("span", { class: "vol-pill" }, numeral));
  if (selected) cover.append(h("span", { class: "tile__check" }, "✓"));
  // Meta line (11c): how much is in the thing, never where you are. A colliding
  // look-alike also gets a disambiguating prefix — its volume number, or the
  // added date when the number can't be resolved.
  const n = chapterCount(book);
  const chText = `${n.toLocaleString()} chapter${n === 1 ? "" : "s"}`;
  let meta;
  if (collides) {
    const prefix = book.volumeIndex
      ? `Vol. ${book.volumeIndex} · `
      : formatAdded(book.addedAt)
        ? `Added ${formatAdded(book.addedAt)} · `
        : "";
    meta = h("div", { class: "tile__meta" }, prefix ? h("span", { class: "tile__meta-vol" }, prefix) : null, chText);
  } else {
    meta = h("div", { class: "tile__meta" }, chText);
  }
  const tile = h(
    "div",
    { class: "tile" + (selecting ? " tile--selectable" : "") + (selected ? " tile--selected" : ""), dataset: { bookId: book.id } },
    cover,
    h("div", { class: "tile__title" }, displayTitle(book)),
    meta
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
  const n = s.bookIds.length;
  const tile = h(
    "div",
    { class: "tile tile--series", onclick: () => !selection && openInfo("series", s.id) },
    stack,
    h("div", { class: "tile__title" }, s.name),
    // Meta line (11c): "N volumes" — how much is in the series, never position.
    h("div", { class: "tile__meta" }, `${n} volume${n === 1 ? "" : "s"}`)
  );
  return tile;
}

function importTile() {
  const tile = h(
    "button",
    { class: "tile tile--import" },
    h(
      "div",
      { class: "import-box" },
      h("span", { class: "import-box__plus" }, "+"),
      h("span", { class: "import-box__label" }, "Import")
    ),
    h("div", { class: "tile__meta" }, ".epub from your files")
  );
  // Tap imports; a long-press is the hidden dev-seed reset.
  attachSeedGesture(tile, pickFiles);
  return tile;
}

// Tap runs `onTap`; a long-press reseeds the demo library. Shared by the Import
// tile and the empty-state Import button so seeding is reachable even with an
// empty library.
function attachSeedGesture(node, onTap) {
  attachLongPress(node, { canStart: () => !selection, onLongPress: confirmAndSeed, onTap });
}

function emptyState() {
  const cta = h("button", { class: "empty__cta" }, "+ Import an .epub");
  // Tap imports; long-press seeds the demo library (dev-only).
  attachSeedGesture(cta, pickFiles);
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
    cta
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
    const abs = chapterOrdinalFor(t, p) + volumeChapterOffset(t);
    return { label: `Continue vol. ${volumeNumber(m.series, t)} · ch. ${abs}`, target: t };
  }
  return { label: `Continue ch. ${chapterOrdinalFor(t, p)}`, target: t };
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
  // Plain display rows; the route into the Chapters screen is the five-chapter
  // preview at the foot of the page (11b), not this table row.
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

  // Every info page ends in a five-chapter preview (11b). For a series it is the
  // reading volume's chapters (absolutely numbered), and See-all opens that
  // volume; for a standalone it is the book's own chapters.
  const pv = previewItemsFor(m);
  const preview = chapterPreview(pv.items, {
    scoped: m.kind === "series",
    onSeeAll: () => openChapters(m.kind, m.id, { volId: pv.volId }),
  });
  if (preview) content.append(preview);

  root.append(content);
  root.scrollTop = 0;
}

function volumeRow(s, book, start, end, cur) {
  const isCurrent = cur && book.id === cur.id;
  const pct = bookPercent(book);
  const p = progressMap[book.id];
  let statusText;
  if (pct >= 100) statusText = "finished";
  else if (p) statusText = "reading ch. " + (chapterOrdinalFor(book, p) + start - 1);
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
  const absCh = (p ? chapterOrdinalFor(book, p) : 1) + volumeChapterOffset(book);
  const volTitle = "Vol. " + volNum + (stripVolume(displayTitle(book)) ? " · " + stripVolume(displayTitle(book)) : "");
  let statusLine;
  if (pct >= 100) statusLine = "Finished · 100 %";
  else if (p) statusLine = `Reading ch. ${absCh} · ${pct} %`;
  else statusLine = "Not started";
  const continueLabel = pct >= 100 ? "Read again" : p ? `Continue ch. ${absCh}` : "Start reading";

  // File facts (11a): File · Size · Added — three plain rows.
  const facts = [
    book.fileName && ["File", book.fileName],
    formatBytes(book.fileBlob?.size) && ["Size", formatBytes(book.fileBlob.size)],
    formatAdded(book.addedAt) && ["Added", formatAdded(book.addedAt)],
  ].filter(Boolean);

  // Volume overflow menu (⋯) and the Edit-details editor both act on this
  // volume as if it were a standalone book.
  const editVolume = () => { hideVolumeSheet(); showEditDetails(infoModel("book", book.id)); };
  const removeVolume = () => { hideVolumeSheet(); confirmDeleteVolume(book); };

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
      h(
        "button",
        {
          class: "vsheet__more",
          "aria-label": "More",
          onclick: () => showActionSheet([
            { label: "Edit details", onClick: editVolume },
            { label: "Remove from series", danger: true, onClick: removeVolume },
          ]),
        },
        svg(ICON.more)
      )
    ),
    h(
      "div",
      { class: "vsheet__facts" },
      ...facts.map(([k, v]) => h("div", { class: "vsheet__fact" }, h("span", { class: "vsheet__fact-k" }, k), h("span", { class: "vsheet__fact-v" }, v)))
    ),
    h(
      "div",
      { class: "vsheet__textactions" },
      h("button", { class: "text-btn", onclick: editVolume }, "Edit details"),
      h("button", { class: "text-btn text-btn--danger", onclick: removeVolume }, "Remove from series")
    )
  );

  // Chapters preview last (11a) — facts and destructive actions must not sit
  // after a list the reader is scanning. Absolute numbers, this-volume count.
  const model = chaptersModel("series", s.id);
  const items = model ? model.items.filter((it) => it.bookId === book.id) : [];
  const preview = chapterPreview(items, {
    scoped: true,
    onSeeAll: () => { hideVolumeSheet(); openChapters("series", s.id, { volId: book.id }); },
  });
  if (preview) card.append(preview);

  el.volumeSheet.hidden = false;
}

// =========================================================================
// CHAPTERS screen (design 8a) — a pushed, searchable list of every chapter in
// a book or a whole series. Three entry points (info page, volume sheet,
// reader drawer) all land on the same screen; it opens scrolled to the
// chapter you are on. Search, sort and volume filter are screen-local; the
// sort direction persists per book.
// =========================================================================
let chQuery = ""; // current search string (screen-local)
let chVolFilter = null; // volume id to filter to, or null for the whole story
let chBackObserver = null; // watches the current row to toggle the "Back to ch." pill
let chEls = null; // live DOM refs while the screen is mounted

const chSortKey = (kind, id) => kind + ":" + id;
const chSortDir = (kind, id) => (ui.chapterSort && ui.chapterSort[chSortKey(kind, id)]) || "asc";
function setChSortDir(kind, id, dir) {
  ui.chapterSort = ui.chapterSort || {};
  ui.chapterSort[chSortKey(kind, id)] = dir;
  saveUi();
}

// Build the flat, absolutely-numbered chapter list for a book or a whole
// series, tagging each row read / unread / current. Chapters before the
// reading position are read; the one you are on is current; the rest unread.
function chaptersModel(kind, id) {
  if (kind === "series") {
    const s = seriesById(id);
    if (!s) return null;
    const vols = seriesVolumes(s);
    const cur = currentVolume(s);
    const curP = cur ? progressMap[cur.id] : null;
    const curLocal = cur && curP ? chapterOrdinalFor(cur, curP) - 1 : -1;
    const items = [];
    for (const vol of vols) {
      const chs = readableChapters(vol.chapters || []);
      const offset = volumeChapterOffset(vol);
      const finished = bookPercent(vol) >= 100;
      const started = bookIsStarted(vol);
      // Read up to the furthest chapter reached (not the resume point); the
      // "current" marker is the resume point, shown only on the reading volume.
      const furthestLocal = furthestOrdinalFor(vol) - 1;
      chs.forEach((e, i) => {
        let state;
        if (finished) state = "read";
        else if (!started) state = "unread";
        else if (cur && vol.id === cur.id && i === curLocal) state = "current";
        else state = i <= furthestLocal ? "read" : "unread";
        items.push({ absNum: offset + i + 1, label: e.label, href: e.href, bookId: vol.id, localIndex: i, state });
      });
    }
    const curItem = items.find((it) => it.state === "current");
    return {
      kind, id, series: s, vols, book: null, title: s.name, items,
      currentAbs: curItem ? curItem.absNum : null,
      currentPercent: cur ? progressMap[cur.id]?.chapterPercent : undefined,
    };
  }
  const b = bookById(id);
  if (!b) return null;
  const chs = readableChapters(b.chapters || []);
  const p = progressMap[b.id];
  const finished = bookPercent(b) >= 100;
  const started = bookIsStarted(b);
  const curLocal = p ? chapterOrdinalFor(b, p) - 1 : -1;
  // Read up to the furthest chapter reached; "current" marks the resume point.
  const furthestLocal = furthestOrdinalFor(b) - 1;
  const items = chs.map((e, i) => {
    let state;
    if (finished) state = "read";
    else if (!started) state = "unread";
    else if (i === curLocal) state = "current";
    else state = i <= furthestLocal ? "read" : "unread";
    return { absNum: i + 1, label: e.label, href: e.href, bookId: b.id, localIndex: i, state };
  });
  const curItem = items.find((it) => it.state === "current");
  return {
    kind, id, series: null, vols: null, book: b, title: displayTitle(b), items,
    currentAbs: curItem ? curItem.absNum : null,
    currentPercent: progressMap[b.id]?.chapterPercent,
  };
}

// Push the Chapters screen. `volId` presets the volume filter (from a volume
// sheet or a series' current volume); null shows the whole story.
function openChapters(kind, id, { volId = null } = {}) {
  go({ route: "chapters", kind, id, volId });
}

// -------------------------------------------------------------------------
// Chapter preview (designs 11b / 11a) — the five-row list that ends every info
// page and every volume sheet. It reuses chaptersModel's read/current/unread
// tagging and absolute numbering; its "See all N chapters" row is the primary
// route into the full Chapters screen (2e), so the common case (resume, or step
// one chapter) never has to open it.
// -------------------------------------------------------------------------

// The five rows to show: an unopened book shows chapters 1–5; a book in progress
// shows two before the current chapter, the current one, and two after (clamped
// to the ends). Five or fewer chapters show them all.
function previewWindow(items) {
  if (items.length <= 5) return items;
  const cur = items.findIndex((it) => it.state === "current");
  if (cur < 0) return items.slice(0, 5);
  const start = Math.max(0, Math.min(cur - 2, items.length - 5));
  return items.slice(start, start + 5);
}

function cprevRow(it) {
  const open = () => (it.state === "current" ? openBook(it.bookId) : openBook(it.bookId, { startHref: it.href }));
  if (it.state === "current") {
    const pct = progressMap[it.bookId]?.chapterPercent;
    return h(
      "button",
      { class: "cprev__row cprev__row--current", onclick: open },
      h("span", { class: "cprev__num" }, String(it.absNum)),
      h(
        "span",
        { class: "cprev__titlewrap" },
        h("div", { class: "cprev__title" }, it.label || "Untitled"),
        h("div", { class: "cprev__sub" }, pct != null ? `Reading · ${pct} % through` : "Reading")
      )
    );
  }
  return h(
    "button",
    { class: "cprev__row cprev__row--" + it.state, onclick: open },
    h("span", { class: "cprev__num" }, String(it.absNum)),
    h("span", { class: "cprev__title" }, it.label || "Untitled"),
    it.state === "read" ? h("span", { class: "cprev__check" }, svg(ICON.check)) : null
  );
}

// Build a preview section from a chaptersModel-style item list for one book (or
// the reading volume of a series). `scoped` switches the right-hand count to
// "N in this volume"; `onSeeAll` pushes the full Chapters screen.
function chapterPreview(items, { scoped = false, onSeeAll } = {}) {
  if (!items || !items.length) return null;
  const total = items.length;
  const cur = items.find((it) => it.state === "current");
  const headLabel = cur ? `Chapters · reading ch. ${cur.absNum}` : "Chapters";
  const countText = scoped
    ? `${total.toLocaleString()} in this volume`
    : `${total.toLocaleString()} chapter${total === 1 ? "" : "s"}`;
  const sec = h(
    "section",
    { class: "cprev" },
    h(
      "div",
      { class: "cprev__head" },
      h("span", { class: "lib-label" }, headLabel),
      h("span", { class: "cprev__count" }, countText)
    )
  );
  const rows = h("div", { class: "cprev__rows" });
  for (const it of previewWindow(items)) rows.append(cprevRow(it));
  sec.append(rows);
  if (total > 5) {
    sec.append(
      h(
        "button",
        { class: "cprev__seeall", onclick: onSeeAll },
        h("span", null, `See all ${total.toLocaleString()} chapters`),
        h("span", { class: "cprev__chev" }, svg(ICON.chevron))
      )
    );
  }
  return sec;
}

// The chapter items an info context previews: a standalone book's own chapters,
// or the reading volume's chapters (absolutely numbered) for a series.
function previewItemsFor(m) {
  if (m.kind === "series") {
    const vol = m.currentVolume;
    if (!vol) return { items: [], volId: null };
    const model = chaptersModel("series", m.id);
    return { items: model ? model.items.filter((it) => it.bookId === vol.id) : [], volId: vol.id };
  }
  const model = chaptersModel("book", m.id);
  return { items: model ? model.items : [], volId: null };
}

// "Shadow Slave · vol. 2" — the book, then the active volume filter.
function chContextLine(m) {
  if (m.kind === "series" && chVolFilter) {
    const v = m.vols.find((x) => x.id === chVolFilter);
    return m.title + (v ? " · vol. " + volumeNumber(m.series, v) : "");
  }
  return m.title;
}

function renderChapters(kind, id, volId) {
  const m = chaptersModel(kind, id);
  const root = el.chaptersScreen;
  root.innerHTML = "";
  if (!m) {
    go({ route: "library" });
    return;
  }
  if (volId !== undefined) chVolFilter = volId;
  chQuery = "";

  // Bar — back · title + context · sort toggle.
  const context = h("div", { class: "ch-bar__context" }, chContextLine(m));
  const sortBtn = h(
    "button",
    {
      class: "ch-bar__icon",
      "aria-label": "Reverse chapter order",
      onclick: () => {
        setChSortDir(kind, id, chSortDir(kind, id) === "asc" ? "desc" : "asc");
        updateChapterList(m);
      },
    },
    svg(ICON.sort)
  );
  root.append(
    h(
      "div",
      { class: "ch-bar" },
      h("button", { class: "ch-bar__icon", "aria-label": "Back", onclick: () => history.back() }, svg(ICON.back)),
      h("div", { class: "ch-bar__titles" }, h("div", { class: "ch-bar__title" }, "Chapters"), context),
      sortBtn
    )
  );

  // Search — matches title and number; sticky under the bar.
  const searchInput = h("input", { class: "ch-search__input", type: "search", placeholder: "Search title or number", autocomplete: "off" });
  searchInput.addEventListener("input", () => {
    chQuery = searchInput.value.trim();
    updateChapterList(m);
  });
  root.append(h("div", { class: "ch-search" }, h("div", { class: "ch-search__box" }, h("span", { class: "ch-search__icon" }, svg(ICON.search)), searchInput)));

  // Volume chips (series only).
  let chips = null;
  if (m.kind === "series" && m.vols.length > 1) {
    chips = h("div", { class: "ch-chips" });
    root.append(chips);
  }

  const list = h("div", { class: "ch-list" });
  const backWrap = h("div", { class: "ch-backpill-wrap" });
  root.append(list, backWrap);

  chEls = { list, backWrap, chips, context, model: m };
  if (chips) renderChips(m);
  updateChapterList(m, true);
}

// Volume filter chips — active chip first, then the rest in volume order.
// Tapping the active chip clears the filter (shows the whole story).
function renderChips(m) {
  const container = chEls.chips;
  container.innerHTML = "";
  let ordered = m.vols;
  if (chVolFilter) {
    const active = m.vols.find((v) => v.id === chVolFilter);
    if (active) ordered = [active, ...m.vols.filter((v) => v.id !== chVolFilter)];
  }
  for (const v of ordered) {
    const on = v.id === chVolFilter;
    container.append(
      h(
        "button",
        {
          class: "ch-chip" + (on ? " ch-chip--on" : ""),
          onclick: () => {
            chVolFilter = on ? null : v.id;
            renderChips(m);
            chEls.context.textContent = chContextLine(m);
            updateChapterList(m);
          },
        },
        "Vol. " + volumeNumber(m.series, v)
      )
    );
  }
}

function chFilteredItems(m) {
  let items = m.items;
  if (chVolFilter) items = items.filter((it) => it.bookId === chVolFilter);
  if (chQuery) {
    const q = chQuery.toLowerCase();
    items = items.filter((it) => (it.label || "").toLowerCase().includes(q) || String(it.absNum).includes(q));
  }
  return items;
}

function updateChapterList(m, scrollToCurrent = false) {
  const list = chEls.list;
  list.innerHTML = "";
  const items = chFilteredItems(m);

  if (!items.length) {
    list.append(h("div", { class: "ch-empty" }, `No chapters match “${chQuery}”.`));
    setupBackPill(m);
    return;
  }

  const dir = chSortDir(m.kind, m.id);
  const filterCount = (chVolFilter ? m.items.filter((it) => it.bookId === chVolFilter) : m.items).length;

  if (chQuery) {
    // Search results are a flat list — no range headers over a sparse set.
    const ordered = dir === "desc" ? [...items].reverse() : items;
    for (const it of ordered) list.append(chRow(m, it));
  } else {
    // Range headers every 50 chapters (by absolute number), sticky per block.
    const blocks = new Map();
    for (const it of items) {
      const b = Math.floor((it.absNum - 1) / 50);
      if (!blocks.has(b)) blocks.set(b, []);
      blocks.get(b).push(it);
    }
    let keys = [...blocks.keys()].sort((a, b) => a - b);
    if (dir === "desc") keys.reverse();
    for (const bk of keys) {
      const start = bk * 50 + 1;
      const end = bk * 50 + 50;
      list.append(
        h(
          "div",
          { class: "ch-range" },
          h("span", { class: "ch-range__label" }, `Ch. ${start}–${end}`),
          h("span", { class: "ch-range__total" }, `${filterCount.toLocaleString()} chapter${filterCount === 1 ? "" : "s"}`)
        )
      );
      let rows = blocks.get(bk);
      if (dir === "desc") rows = [...rows].reverse();
      for (const it of rows) list.append(chRow(m, it));
    }
  }

  setupBackPill(m);
  if (scrollToCurrent) requestAnimationFrame(() => scrollToCurrentRow());
}

function chRow(m, it) {
  const cls = "ch-row ch-row--" + it.state;
  if (it.state === "current") {
    const pct = m.currentPercent;
    return h(
      "button",
      { class: cls, dataset: { current: "1" }, onclick: () => chOpen(it) },
      h("span", { class: "ch-row__num" }, String(it.absNum)),
      h(
        "span",
        { class: "ch-row__title-wrap" },
        h("div", { class: "ch-row__title" }, it.label || "Untitled"),
        h("div", { class: "ch-row__sub" }, pct != null ? `Reading · ${pct} % through` : "Reading")
      )
    );
  }
  return h(
    "button",
    { class: cls, onclick: () => chOpen(it) },
    h("span", { class: "ch-row__num" }, String(it.absNum)),
    h("span", { class: "ch-row__title" }, it.label || "Untitled"),
    it.state === "read" ? h("span", { class: "ch-row__check" }, svg(ICON.check)) : null
  );
}

// Tapping a row opens the reader at that chapter — the saved offset for the
// current chapter, the top for any other.
function chOpen(it) {
  if (it.state === "current") openBook(it.bookId);
  else openBook(it.bookId, { startHref: it.href });
}

function scrollToCurrentRow() {
  const cur = chEls?.list.querySelector("[data-current]");
  if (cur) cur.scrollIntoView({ block: "center" });
}

// The floating "Back to ch. N" pill: shown only while the current row is
// scrolled out of view; its arrow points the way it will scroll.
function setupBackPill(m) {
  if (chBackObserver) {
    chBackObserver.disconnect();
    chBackObserver = null;
  }
  const wrap = chEls.backWrap;
  wrap.innerHTML = "";
  wrap.classList.remove("show");
  if (m.currentAbs == null) return;
  const cur = chEls.list.querySelector("[data-current]");
  if (!cur) return; // current chapter filtered out — no pill
  const pill = h("button", { class: "ch-backpill", onclick: () => cur.scrollIntoView({ behavior: "smooth", block: "center" }) }, `↓ Back to ch. ${m.currentAbs}`);
  wrap.append(pill);
  chBackObserver = new IntersectionObserver(
    (entries) => {
      const e = entries[0];
      if (e.isIntersecting) {
        wrap.classList.remove("show");
      } else {
        const above = e.boundingClientRect.top < chEls.list.getBoundingClientRect().top;
        pill.textContent = `${above ? "↑" : "↓"} Back to ch. ${m.currentAbs}`;
        wrap.classList.add("show");
      }
    },
    { root: chEls.list, threshold: 0 }
  );
  chBackObserver.observe(cur);
}

function teardownChapters() {
  if (chBackObserver) {
    chBackObserver.disconnect();
    chBackObserver = null;
  }
  chEls = null;
  chQuery = "";
  chVolFilter = null;
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
  // On Android a long-press fires `contextmenu` (the "Download image / open in
  // new tab" popup on covers), which collides with our own hold-to-select.
  // iOS's `-webkit-touch-callout: none` handles the equivalent there; this is
  // the cross-browser counterpart. Suppress it whenever a press could start.
  node.addEventListener("contextmenu", (e) => {
    if (canStart() || longPressed) e.preventDefault();
  });
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

// Persist an epub.js location as the current reading position. Called on every
// `relocated` while scrolling, and once more when the app is backgrounded so
// the freshest position survives. Pure persistence — no DOM/view updates, so it
// is safe to run while the reader is hidden.
function saveReadingLocation(location) {
  const lib = currentBook;
  if (!lib || !location?.start) return;
  const idx = typeof location.start.index === "number" ? location.start.index : 0;
  const total = book?.spine?.spineItems?.length || chapterCount(lib);
  const prev = progressMap[lib.id];
  // Furthest-reached: the recorded high-water mark only ever rises, and once
  // a book is finished it stays finished even if you reopen an early chapter.
  const maxChapterIndex = Math.max(prev?.maxChapterIndex ?? -1, idx);
  const finished = prev?.finished || (total > 0 && maxChapterIndex >= total - 1);
  // Best-effort progress *within* the current chapter, for the Chapters
  // screen's "Reading · N % through" line. Not all layouts expose it.
  const disp = location.start.displayed;
  const chapterPercent =
    disp && disp.total ? Math.min(100, Math.max(0, Math.round((disp.page / disp.total) * 100))) : prev?.chapterPercent;
  putProgress({
    bookId: lib.id,
    cfi: location.start.cfi || null,
    chapterIndex: idx,
    maxChapterIndex,
    chapterLabel: chapterLabelFor(location.start.href || currentHref) || prev?.chapterLabel || "",
    chapterPercent,
    finished,
    updatedAt: Date.now(),
  });
  ui.lastReadBookId = lib.id;
  saveUi();
}

// Flush the reading position when the app is backgrounded (phone lock or
// app-switch). The scroll-driven `relocated` save is throttled, so without this
// a spot reached moments before locking could be lost. `currentLocation()`
// recomputes from the live DOM, giving a fresher position than the last event.
// Pure save — it never moves the view.
function flushReadingPosition() {
  if (!rendition || document.getElementById("app").dataset.route !== "reader") return;
  try {
    let loc = rendition.currentLocation();
    if (loc && typeof loc.then === "function") loc = null; // async manager; skip
    if (!loc?.start) loc = rendition.location; // fall back to last known
    if (loc?.start) saveReadingLocation(loc);
  } catch (err) {
    console.warn("Position flush failed:", err);
  }
}

async function openBook(id, { withDrawer = false, startHref = null } = {}) {
  const lib = bookById(id);
  if (!lib) return;
  currentBook = lib;
  go({ route: "reader", id }, true);
  await renderReader(lib, startHref);
  if (withDrawer) openDrawer();
}

async function renderReader(lib, startHref = null) {
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
  flatToc = readableChapters(lib.chapters || []);
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
  // The full reading theme is an external stylesheet, fetched per view — which
  // leaves a brief white flash on each chapter change while it loads. Inject
  // the critical dark background inline (applied the instant the view is
  // created) so the flash never shows.
  rendition.themes.default({ "html, body": { background: "#1f2129 !important" } });
  rendition.themes.register("webnovel", "./reader-theme.css");
  rendition.themes.select("webnovel");
  rendition.hooks.content.register(injectChapterNav);

  el.btnPrev.disabled = false;
  el.btnNext.disabled = false;

  // A chapter tapped in the Chapters screen wins; otherwise resume the saved
  // position, falling back to the first real chapter (skipping the epub's own
  // front matter that our chrome already covers). When there is no precise CFI
  // but we do know which chapter the reader was on (e.g. a seeded position, or
  // progress that outlived its CFI), resume by chapter label.
  const p = progressMap[lib.id];
  let resume = p?.cfi;
  if (!resume && p?.chapterLabel) resume = flatToc.find((e) => e.label === p.chapterLabel)?.href;
  rendition.display(startHref || resume || flatToc[0]?.href || undefined);

  // Refine the chapter list once the live navigation resolves (accurate hrefs).
  book.loaded.navigation.then((nav) => {
    flatToc = readableChapters(flatten(nav.toc));
    renderToc();
    updateChapterTitle(currentHref);
  });

  rendition.on("relocated", (location) => {
    currentHref = location?.start?.href || null;
    // Re-render the drawer list so read-state and the highlight track the move.
    renderToc();
    updateChapterTitle(currentHref);
    saveReadingLocation(location);
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
  const n = (p ? chapterOrdinalFor(lib, p) : 1) + volumeChapterOffset(lib);
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

// The drawer lists every chapter of the current book (the current volume, for
// a book inside a series). The list scrolls within the drawer and is scrolled
// to the current chapter on open via highlightToc. Chapters up to the furthest
// one ever reached are marked read — dimmed with a check — to match the full
// Chapters screen and its previews; jumping *back* into an earlier chapter never
// un-checks the ones beyond it. The chapter you're on keeps its highlight (via
// highlightToc) instead of a check, and anything past the furthest mark reads as
// unread. For a book inside a series the rows carry absolute numbers, so
// "Ch. 351" in vol. 2 stays "Ch. 351".
function renderToc() {
  el.tocList.innerHTML = "";
  const total = flatToc.length;
  if (!total) return;
  const inSeries = !!(currentBook?.seriesId && seriesById(currentBook.seriesId));
  const offset = inSeries ? volumeChapterOffset(currentBook) : 0;
  const curBase = baseHref(currentHref);
  const curIdx = curBase ? flatToc.findIndex((e) => baseHref(e.href) === curBase) : -1;
  const furthestLocal = currentBook ? furthestOrdinalFor(currentBook) - 1 : -1;
  for (let i = 0; i < total; i++) {
    const entry = flatToc[i];
    const text = entry.label || "Untitled";
    const label = inSeries ? `${offset + i + 1} · ${text}` : text;
    const read = i !== curIdx && i <= furthestLocal;
    const cls = "toc-item" + (entry.depth ? " depth-" + Math.min(entry.depth, 2) : "") + (read ? " toc-item--read" : "");
    const btn = h(
      "button",
      { dataset: { href: entry.href }, class: cls },
      h("span", { class: "toc-item__label" }, label),
      read ? h("span", { class: "toc-item__check" }, svg(ICON.check)) : null
    );
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
  if (!el.drawer.classList.contains("open")) return; // idempotent
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
  if (route !== "chapters") teardownChapters();
}

function renderCurrentRoute() {
  const route = document.getElementById("app").dataset.route;
  if (route === "info" && currentInfo) renderInfo(currentInfo.kind, currentInfo.id);
  else if (route === "chapters") return; // the chapters screen manages its own updates
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
  } else if (s.route === "chapters" && s.id) {
    currentInfo = null;
    setRouteChrome("chapters");
    renderChapters(s.kind || "book", s.id, s.volId);
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
  } else if (state.route === "chapters" && state.id) {
    currentInfo = null;
    setRouteChrome("chapters");
    renderChapters(state.kind || "book", state.id, state.volId);
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
// Install (Add to Home Screen). The only entry point is the persistent
// footnote pinned to the bottom of the library — no intrusive nudge bar.
// =========================================================================
let deferredInstallPrompt = null;
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

// Show the footnote whenever the app isn't already installed.
function refreshInstallNote() {
  el.installNote.hidden = isStandalone();
}
async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === "accepted") el.installNote.hidden = true;
    return;
  }
  el.installSheet.hidden = false;
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

// -------------------------------------------------------------------------
// File picking
// -------------------------------------------------------------------------
function pickFiles() {
  el.fileInput.click();
}

// -------------------------------------------------------------------------
// Dev seeding — a hidden reset that fills the library with a fixed set of
// real, public-domain books covering every design case (with/without cover,
// started/unstarted, loose volumes, and shelves). Triggered by a long-press on
// the Import tile (or the empty-state Import button). It re-seeds the demo set:
// it clears only the books and shelves it previously seeded (tagged with
// `seeded: true`), leaving any real imported books untouched, so calling it
// repeatedly never duplicates the demo set and never destroys real content.
//
// The books live in public/seed/ with a manifest describing how to arrange
// them; see scripts/fetch-seed.mjs. They are excluded from the PWA precache, so
// they never ship to real users — only a deliberate long-press fetches them.
// -------------------------------------------------------------------------
let seeding = false;

async function confirmAndSeed() {
  if (seeding) return;
  const ok = await showConfirmSheet(
    "Seed demo library",
    "Reset the demo books to a fixed set? This only replaces previously seeded books — your real imported books are left untouched.",
    "Seed"
  );
  if (!ok) return;
  seeding = true;
  try {
    await seedDemoLibrary();
  } catch (err) {
    console.warn("Seeding failed", err);
    alert("Seeding failed: " + (err?.message || err));
  } finally {
    seeding = false;
  }
}

// Remove only previously-seeded books, shelves and reading positions — in
// memory and on disk. Real imported content (anything without `seeded: true`)
// is left completely untouched.
async function clearSeededContent() {
  const seededBooks = books.filter((b) => b.seeded);
  const seededSeries = series.filter((s) => s.seeded);

  await Promise.all([
    ...seededBooks.map((b) => dbDelete("books", b.id)),
    ...seededBooks.map((b) => dbDelete("progress", b.id)),
    ...seededSeries.map((s) => dbDelete("series", s.id)),
  ]);

  for (const b of seededBooks) {
    if (coverUrls.has(b.id)) {
      URL.revokeObjectURL(coverUrls.get(b.id));
      coverUrls.delete(b.id);
    }
    delete progressMap[b.id];
    if (ui.lastReadBookId === b.id) ui.lastReadBookId = null;
  }

  const seededBookIds = new Set(seededBooks.map((b) => b.id));
  const seededSeriesIds = new Set(seededSeries.map((s) => s.id));
  books = books.filter((b) => !seededBookIds.has(b.id));
  series = series.filter((s) => !seededSeriesIds.has(s.id));
  await saveUi();
}

async function seedDemoLibrary() {
  const manifest = await (await fetch("./seed/manifest.json")).json();
  const entries = manifest.entries || [];

  await clearSeededContent();

  // 1. Import every epub (order preserved so the shelf reads intentionally).
  const rows = []; // { entry, book }
  for (const entry of entries) {
    const buffer = await (await fetch("./seed/" + entry.file)).arrayBuffer();
    const book = await createBook(buffer, entry.file);
    book.seeded = true;
    if (entry.noCover) book.coverBlob = null;
    await dbPut("books", book);
    rows.push({ entry, book });
  }

  const now = Date.now();
  const HOUR = 3600 * 1000;

  // 2. Group volumes into shelves, in manifest order, by series name.
  const bySeries = new Map();
  for (const { entry, book } of rows) {
    if (!entry.series) continue;
    if (!bySeries.has(entry.series)) bySeries.set(entry.series, []);
    bySeries.get(entry.series).push({ entry, book });
  }
  for (const [name, members] of bySeries) {
    const s = { id: uid(), name, author: members[0].book.author || "", bookIds: [], seeded: true };
    members.forEach(({ entry, book }, i) => {
      book.seriesId = s.id;
      book.volumeIndex = entry.vol || i + 1;
      s.bookIds.push(book.id);
    });
    await Promise.all(members.map(({ book }) => dbPut("books", book)));
    series.push(s);
    await dbPut("series", s);
  }

  // 3. Stagger "added" dates so the shelf isn't one indistinct block, then set
  // reading progress on the books the manifest marks as started.
  for (let i = 0; i < rows.length; i++) {
    rows[i].book.addedAt = now - (i + 1) * 6 * HOUR;
    await dbPut("books", rows[i].book);
  }
  for (const { entry, book } of rows) {
    if (!entry.started) continue;
    // The percentage bar is measured against the spine, so the stored index is
    // spine-based; the resume *label* is picked from the readable chapter list
    // at the same fraction, so it lands on a real chapter (not a title page).
    const total = book.spineCount || chapterCount(book);
    const idx = Math.max(0, Math.min(total - 1, Math.round(entry.started * total) - 1));
    const readable = readableChapters(book.chapters || []);
    const rIdx = Math.max(0, Math.min(readable.length - 1, Math.round(entry.started * readable.length) - 1));
    const label = readable[rIdx]?.label || "";
    // recency 0 = freshest (drives the "Continue" card); default well back.
    const updatedAt = now - (entry.recency != null ? entry.recency : 12) * HOUR;
    await putProgress({
      bookId: book.id,
      cfi: null,
      chapterIndex: idx,
      maxChapterIndex: idx,
      chapterLabel: label,
      finished: false,
      updatedAt,
    });
  }

  renderCurrentRoute();
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
    chaptersScreen: "chapters-screen",
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
    installNote: "install-note",
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
  el.btnPrev.addEventListener("click", () => rendition && rendition.prev());
  el.btnNext.addEventListener("click", () => rendition && rendition.next());

  el.selectCancel.addEventListener("click", exitSelection);
  el.selectGroup.addEventListener("click", confirmGrouping);
  el.selectDelete.addEventListener("click", confirmDeleteSelection);

  el.volumeScrim.addEventListener("click", hideVolumeSheet);
  el.actionScrim.addEventListener("click", hideActionSheet);

  el.installNote.addEventListener("click", handleInstallClick);
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
