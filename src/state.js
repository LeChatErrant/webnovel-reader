// -------------------------------------------------------------------------
// In-memory app state, hydrated from IndexedDB on startup, plus the persistence
// helpers that keep it and the database in step. This is the single source of
// truth for the library data; UI modules read the exported bindings and mutate
// through the functions here.
// -------------------------------------------------------------------------
import { dbGetAll, dbPut, dbDelete, kvGet, kvSet } from "./db.js";
import { isFrontMatter, baseHref, CHAPTER_DONE_PCT } from "./lib/chapters.js";
import { coverUrls } from "./dom.js";

// Exported as `let`/`const` so importers get live bindings — a reassignment of
// `books`/`series`/`ui` here (below) is seen everywhere. Reassignment must stay
// inside this module; external code mutates via the functions and setters here.
export let books = []; // { id, title, author, coverBlob, chapters[], spineCount, fileBlob, seriesId, volumeIndex, addedAt }
export let series = []; // { id, name, author, bookIds[] }
export const progressMap = {}; // bookId -> { bookId, cfi, chapterIndex, chapterLabel, finished, updatedAt }
export let ui = { sort: "recent", dismissedKeys: [], lastReadBookId: null };

// Reassignment escape hatches for the (few) callers outside this module that
// need to replace the collections wholesale, e.g. dev-seed clearing.
export const setBooks = (next) => { books = next; };
export const setSeries = (next) => { series = next; };

export const bookById = (id) => books.find((b) => b.id === id) || null;
export const seriesById = (id) => series.find((s) => s.id === id) || null;
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Math.random().toString(36).slice(2) + Date.now());

export async function loadState() {
  const [bookRows, seriesRows, progRows, savedUi] = await Promise.all([
    dbGetAll("books"),
    dbGetAll("series"),
    dbGetAll("progress"),
    kvGet("ui"),
  ]);
  books = bookRows || [];
  series = seriesRows || [];
  for (const p of progRows || []) progressMap[p.bookId] = p;
  reconcilePendingProgress();
  if (savedUi) ui = { ...ui, ...savedUi };
  await migrateProgressRecords();
}
export const saveUi = () => kvSet("ui", ui);
export async function putProgress(p) {
  progressMap[p.bookId] = p;
  await dbPut("progress", p);
}

// Crash-durability for the reading position. IndexedDB writes are async, so a
// position saved the instant the app is backgrounded (screen lock / app-switch)
// can be dropped if the OS suspends or kills the page before the transaction
// commits — you then resume from an earlier, already-committed scroll save.
// localStorage.setItem is synchronous and commits before the event handler
// returns, so on backgrounding we mirror the freshest record there too;
// reconcilePendingProgress folds any mirror newer than the DB back in at launch.
const PENDING_POS_PREFIX = "pendingpos:";
export function stashPendingProgress(p) {
  try {
    localStorage.setItem(PENDING_POS_PREFIX + p.bookId, JSON.stringify(p));
  } catch (_) {
    // localStorage disabled (private mode) or over quota — the async IndexedDB
    // write stays the primary path, so there is nothing to fall back to here.
  }
}
function reconcilePendingProgress() {
  let keys;
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(PENDING_POS_PREFIX));
  } catch (_) {
    return;
  }
  for (const k of keys) {
    let p = null;
    try {
      p = JSON.parse(localStorage.getItem(k));
    } catch (_) {
      /* corrupt entry — drop it below */
    }
    // Apply only when the stash is genuinely newer than what the DB restored,
    // so a stale mirror can never rewind a position the DB already advanced.
    if (p && p.bookId && (p.updatedAt || 0) > (progressMap[p.bookId]?.updatedAt || 0)) {
      progressMap[p.bookId] = p;
      dbPut("progress", p); // foreground write at launch — reliably commits
    }
    try {
      localStorage.removeItem(k);
    } catch (_) {}
  }
}

// One-time upgrade for progress written before per-chapter tracking: synthesize
// a `chapters` map from the old furthest-opened index + within-chapter %.
// Chapters before the furthest become read; the furthest one becomes in
// progress. The upgraded record is persisted, so this runs once per book.
export async function migrateProgressRecords() {
  for (const b of books) {
    const p = progressMap[b.id];
    if (!p || p.chapters) continue;
    const chs = b.chapters || [];
    const M = p.maxChapterIndex ?? p.chapterIndex ?? -1;
    const map = {};
    for (let i = 0; i < chs.length; i++) {
      if (isFrontMatter(chs[i].label)) continue;
      const key = baseHref(chs[i].href);
      if (!key) continue;
      if (p.finished || i < M) map[key] = { pct: 100, cfi: null, done: true };
      else if (i === M) {
        const pct = p.chapterPercent ?? 0;
        map[key] = { pct, cfi: p.cfi || null, done: pct >= CHAPTER_DONE_PCT };
      }
    }
    await putProgress({
      bookId: b.id,
      cfi: p.cfi || null,
      chapterIndex: p.chapterIndex ?? Math.max(0, M),
      chapterLabel: p.chapterLabel || "",
      chapters: map,
      finished: !!p.finished,
      updatedAt: p.updatedAt || Date.now(),
    });
  }
}

// Delete a book everywhere: the stored epub, its reading position and its cached
// cover URL all go. A series that drops below two volumes is dissolved back into
// standalone books. Pure data operation — the caller re-renders.
export async function deleteBook(id) {
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
