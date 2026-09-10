// -------------------------------------------------------------------------
// Chapter derivation — front-matter detection, the readable-chapter view,
// chapter counting/numbering and the per-chapter progress helpers that are pure
// over a book object (they never read app-global state). This is the trickiest,
// most regression-prone logic in the app, so it lives here and is unit-tested in
// test/chapters.test.js.
// -------------------------------------------------------------------------

// A chapter is "read" once you reach its end. We can't count on the very last
// pixel scrolling into view (trailing whitespace, the injected end-of-chapter
// card), so anything at or past this fraction counts as complete.
export const CHAPTER_DONE_PCT = 92;
// Opening a chapter must not, by itself, register progress or completion — the
// reader has to actually move this far past where the chapter opened before it
// counts as started. Keeps a stray tap off the "reading"/done state and off the
// resume chip.
export const MIN_SCROLL_PCT = 5;

// Strip the fragment from an href so a spine section and its TOC anchor share a
// key. The per-chapter progress map is keyed by it.
export const baseHref = (href) => (href || "").split("#")[0];

// Web-novel epubs bundle front matter ahead of the real chapters: the same
// metadata/synopsis page we now render as our own info page, plus an in-book
// contents page that duplicates our chapter drawer. We hide these from the
// reader flow, the chapter menu and the chapter counts/numbers.
const FRONT_MATTER_RE =
  /^(informations?|table of contents|contents|toc|cover|title\s*page|copyright|colophon)$/i;
// Public-domain epubs (e.g. Project Gutenberg) tack a licence / boilerplate
// page onto the spine and TOC; it is never a real chapter, so hide it too.
export const isFrontMatter = (label) => {
  const t = (label || "").trim();
  return FRONT_MATTER_RE.test(t) || /project gutenberg/i.test(t) || /\blicen[sc]e$/i.test(t);
};

// Never hide everything: if a whole TOC somehow matched, fall back to the
// original so the reader is never left empty.
export function readableChapters(entries) {
  const kept = (entries || []).filter((e) => !isFrontMatter(e.label));
  return kept.length ? kept : entries || [];
}

export const frontMatterCount = (book) => (book?.chapters || []).filter((e) => isFrontMatter(e.label)).length;

// Count the readable chapters, not spine items: the spine can carry extra
// front matter (e.g. an untracked cover page) the TOC never lists, so the
// readable TOC is the honest basis for counts and numbering.
export function chapterCount(book) {
  return readableChapters(book.chapters || []).length || book.spineCount || 1;
}

// Which chapter (1-based, within its volume) a saved position sits on, counted
// over the readable TOC by label so leading front matter never inflates it.
export function chapterOrdinalFor(book, p) {
  if (!p) return 1;
  const readable = readableChapters(book.chapters || []);
  const i = readable.findIndex((e) => e.label && e.label === p.chapterLabel);
  if (i >= 0) return i + 1;
  return Math.max(1, (p.chapterIndex ?? 0) + 1 - frontMatterCount(book));
}

// Chapter skipping: mark every readable chapter before `href` complete, in place
// on a chapters map. Finishing a chapter implies the ones before it are read.
export function markEarlierDone(book, href, chapters) {
  const readable = readableChapters(book.chapters || []);
  const idx = readable.findIndex((e) => baseHref(e.href) === baseHref(href));
  for (let i = 0; i < idx; i++) {
    const k = baseHref(readable[i].href);
    if (!k || chapters[k]?.done) continue;
    chapters[k] = { pct: 100, cfi: chapters[k]?.cfi || null, done: true };
  }
}

// Flatten a nested epub.js TOC into a depth-tagged list.
export function flatten(items, depth = 0, out = []) {
  for (const item of items || []) {
    out.push({ label: (item.label || "").trim(), href: item.href, depth });
    if (item.subitems?.length) flatten(item.subitems, depth + 1, out);
  }
  return out;
}

// The five rows a chapter preview shows: an unopened book shows chapters 1–5; a
// book in progress shows two before the anchor chapter, the anchor, and two
// after (clamped to the ends). Five or fewer chapters show them all. `anchorAbs`
// is the row to centre on — the current (resume) chapter if there is one, else
// the last-read chapter, so a finished book previews where you left off instead
// of falling back to 1–5.
export function previewWindow(items, anchorAbs) {
  if (items.length <= 5) return items;
  let cur = anchorAbs != null ? items.findIndex((it) => it.absNum === anchorAbs) : -1;
  if (cur < 0) cur = items.findIndex((it) => it.state === "current");
  if (cur < 0) return items.slice(0, 5);
  const start = Math.max(0, Math.min(cur - 2, items.length - 5));
  return items.slice(start, start + 5);
}

// Absolute number of the row the Chapters screen should open scrolled to: the
// current (resume) chapter if there is one, else the last-read chapter (the
// resume ordinal in the current volume, even though it is now marked "read"),
// else null (an unopened book stays at the top).
export function scrollAnchorFor(items, curItem, curBookId, curLocal) {
  if (curItem) return curItem.absNum;
  if (curBookId && curLocal >= 0) {
    const anchor = items.find((it) => it.bookId === curBookId && it.localIndex === curLocal);
    if (anchor) return anchor.absNum;
  }
  return null;
}
