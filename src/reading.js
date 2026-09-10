// -------------------------------------------------------------------------
// Derived reading state — completion percentages, chapter ordinals, series /
// volume math and the display title. These read the in-memory state (progress
// map, books, series) but never mutate it. Completion is measured from the
// per-chapter progress map, so jumping back never un-reads a chapter and merely
// opening one never completes it.
// -------------------------------------------------------------------------
import { books, progressMap, ui, bookById, seriesById } from "./state.js";
import { chapterCount, chapterOrdinalFor, readableChapters, baseHref } from "./lib/chapters.js";

// The per-chapter progress entry for one chapter: { pct, cfi, done } or null.
export function chapterProgress(book, href) {
  const p = progressMap[book?.id];
  const h = baseHref(href);
  return p && p.chapters && h ? p.chapters[h] || null : null;
}

// Number of readable chapters completed in this book.
export function doneCount(book) {
  const p = progressMap[book?.id];
  if (!p || !p.chapters) return 0;
  let n = 0;
  for (const e of readableChapters(book.chapters || [])) if (p.chapters[baseHref(e.href)]?.done) n++;
  return n;
}
export function bookPercent(book) {
  const p = progressMap[book.id];
  if (!p) return 0;
  if (p.finished) return 100;
  const total = chapterCount(book);
  if (!total) return 0;
  return Math.min(100, Math.round((doneCount(book) / total) * 100));
}
export function bookIsStarted(book) {
  return !!progressMap[book.id];
}

export function seriesVolumes(s) {
  return (s.bookIds || []).map(bookById).filter(Boolean);
}
export function seriesPercent(s) {
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
export function currentVolume(s) {
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
export function volumeNumber(s, book) {
  if (book.volumeIndex) return book.volumeIndex;
  return seriesVolumes(s).indexOf(book) + 1;
}
export function nextVolume(book) {
  if (!book.seriesId) return null;
  const s = seriesById(book.seriesId);
  if (!s) return null;
  const vols = seriesVolumes(s);
  const i = vols.indexOf(book);
  return i >= 0 ? vols[i + 1] || null : null;
}
// Absolute chapter offset of a volume within its series (sum of earlier
// volumes' chapter counts), so "Ch. 351" in vol. 2 stays "Ch. 351".
export function volumeChapterOffset(book) {
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
export function continueTarget() {
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
export function continueSubtitle(book) {
  const p = progressMap[book.id];
  const abs = chapterOrdinalFor(book, p) + volumeChapterOffset(book);
  const parts = [];
  if (book.seriesId && book.volumeIndex) parts.push("Vol. " + book.volumeIndex);
  parts.push("Chapter " + abs);
  if (p?.chapterLabel) parts.push(p.chapterLabel);
  return parts.join(" · ");
}

// A typed override, if the user entered one (empty means "no override").
export function overrideOf(obj, field) {
  const v = obj?.overrides?.[field];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}
// The title to show for a book everywhere (shelf, reader, drawer, volume rows):
// an Edit-details override wins over the .epub's own title.
export function displayTitle(book) {
  return (book && (overrideOf(book, "title") || book.title)) || "";
}
