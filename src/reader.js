// =========================================================================
// READER — the reading surface (epub.js rendition), the chapter drawer, the
// per-chapter resume chip, and the end-of-chapter navigation injected into each
// chapter document. This module owns the live epub.js Book/rendition and the
// reading position bookkeeping; the router drives it via renderReader /
// destroyRendition / setCurrentBook.
// =========================================================================
import ePub from "epubjs";
// The reader theme is inlined into the JS bundle (not fetched per chapter) and
// injected as a <style> element into each chapter document via a content hook.
// Registering it as an external URL made epub.js drop a <link> into every
// chapter iframe, fetched afresh on each chapter change -- a visible flash of
// unstyled (dark-on-dark) text online, and permanently dark text offline
// (that in-iframe request never hit the service-worker precache).
import readerThemeCss from "./reader-theme.css?raw";
import { el, h, svg, ICON, coverUrlFor } from "./dom.js";
import {
  progressMap, ui, bookById, seriesById, saveUi, putProgress, stashPendingProgress,
} from "./state.js";
import {
  baseHref, chapterCount, chapterOrdinalFor, readableChapters, markEarlierDone,
  flatten, CHAPTER_DONE_PCT, MIN_SCROLL_PCT,
} from "./lib/chapters.js";
import { parseChapterLabel, stripVolume } from "./lib/text.js";
import {
  chapterProgress, bookPercent, volumeChapterOffset, volumeNumber, nextVolume,
  seriesVolumes, displayTitle,
} from "./reading.js";
import { go, openInfo, openSeries } from "./router.js";
import { addVolumeToSeries } from "./import.js";

let book = null; // live epub.js Book
let rendition = null;
let currentBook = null; // the library book being read
let flatToc = [];
let currentHref = null;
// Per-chapter resume chip: the chapters the reader has dismissed it for this
// session, plus the live chip element and the chapter it belongs to.
let resumeDismissed = new Set();
let resumeChipEl = null;
let resumeChipHref = null;
// Where the current chapter first appeared, so we can measure how far the reader
// scrolled from there (see MIN_SCROLL_PCT) before crediting any progress.
let chapterEntryBaseline = { href: null, pct: 0 };
// True while a resume is still settling the scroll onto the saved spot. epub.js
// fires `relocated` for the transient positions it passes through on the way
// there (and for our own corrective scrolls); persisting those would overwrite
// the good saved position with a half-restored one — a backward drift that then
// sticks for every later open. So while this is set, `relocated` updates the UI
// but does not persist. Explicit flushes (lock/app-switch) still persist.
let restoreActive = false;

// The library book being read, and the destroy hook the router calls when it
// leaves the reader route.
export const setCurrentBook = (b) => { currentBook = b; };
export const hasRendition = () => !!rendition;
export function destroyRendition() {
  if (rendition) {
    rendition.destroy();
    rendition = null;
    book = null;
  }
}

// The content iframe's document (the epub chapter). Used to wait for its web
// font to load before trusting its layout height. Version-independent: read the
// iframe straight off the scroll container rather than via getContents().
function readerContentDoc() {
  try {
    return rendition?.manager?.container?.querySelector("iframe")?.contentDocument || null;
  } catch (_) {
    return null;
  }
}

// After a resume display() settles, correct the chapter view to the exact saved
// pixel offset. epub.js positions to the CFI's top-of-viewport word, which can
// collapse to a paragraph's start and leave you "a bit before" where you were;
// reapplying the raw scrollTop removes that drift.
//
// The hard part is *when* the layout is final. The book face (Spectral) is
// `font-display: swap`, so a fresh load — which a *long* phone-lock forces, once
// the OS discards the suspended page — first lays the chapter out in the
// fallback serif, then reflows when Spectral swaps in. epub.js also sizes the
// view asynchronously. Any correction applied before all that settles is against
// the wrong height, and the later reflow leaves the resume a variable distance
// *above* the saved spot — the "after a long lock it goes back before where I
// was" bug. `fonts.ready` is not a reliable gate (it can resolve before a lazily
// requested face is even fetched), so instead of guessing a moment we hold the
// target pinned: re-assert the saved offset every frame until the layout stops
// changing, then a moment longer, capped by a hard deadline. Clamping to the
// live scrollHeight each frame means a still-growing chapter climbs to the exact
// saved offset as its final height arrives. We stop the instant the reader
// actually interacts (touch / wheel / key / pointer) so an active reader is
// never yanked — a short lock keeps the page in memory and never runs this.
const RESTORE_MAX_MS = 4000; // hard cap on how long we keep correcting
const RESTORE_STABLE_MS = 400; // layout must hold this long before we let go
function restoreScrollAfter(shown, scrollTop) {
  restoreActive = true;
  Promise.resolve(shown)
    .then(() => {
      const c = rendition?.manager?.container;
      if (!c) {
        restoreActive = false;
        return;
      }

      let interacted = false;
      const markInteracted = () => {
        interacted = true;
      };
      const targets = [c, readerContentDoc()].filter(Boolean);
      const evs = ["wheel", "touchstart", "keydown", "pointerdown"];
      for (const t of targets) for (const e of evs) t.addEventListener(e, markInteracted, { passive: true });

      const start = performance.now();
      let lastHeight = -1;
      let stableSince = 0;
      const finish = () => {
        for (const t of targets) for (const e of evs) t.removeEventListener(e, markInteracted);
        // One last persist of where we actually landed, then reopen the gate so
        // ordinary scroll-driven saves resume from the correct position.
        restoreActive = false;
        try {
          const loc = rendition?.location;
          if (loc?.start) saveReadingLocation(loc);
        } catch (_) {}
      };
      const tick = (now) => {
        if (interacted || !c.isConnected || !rendition) return finish();
        const max = Math.max(0, c.scrollHeight - c.clientHeight);
        const y = Math.min(scrollTop, max);
        if (y > 0) c.scrollTop = y;
        // Consider the layout settled once its scrollable height (which the font
        // swap and epub.js's sizing both change) has held steady for a beat.
        if (max === lastHeight) {
          if (!stableSince) stableSince = now;
        } else {
          lastHeight = max;
          stableSince = 0;
        }
        const settled = stableSince && now - stableSince >= RESTORE_STABLE_MS && y >= scrollTop;
        if (settled || now - start >= RESTORE_MAX_MS) return finish();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })
    .catch(() => {
      restoreActive = false;
    });
}

// Persist an epub.js location as the current reading position. Called on every
// `relocated` while scrolling, and once more when the app is backgrounded so
// the freshest position survives. Pure persistence — no DOM/view updates, so it
// is safe to run while the reader is hidden.
function saveReadingLocation(location) {
  const lib = currentBook;
  if (!lib || !location?.start) return;
  const idx = typeof location.start.index === "number" ? location.start.index : 0;
  const href = baseHref(location.start.href || currentHref);
  const prev = progressMap[lib.id];
  // Exact pixel scroll within the current chapter's view. The CFI alone snaps to
  // the top-of-viewport word (and can collapse to a paragraph's start), which
  // lands the resume "a bit before" where you were; pairing it with the raw
  // scrollTop lets restore correct to the exact spot (same device/font, no
  // images → the offset is stable between save and restore).
  const scrollTop = Math.round(rendition?.manager?.container?.scrollTop || 0);

  // Progress within the chapter you're on (0–100). Not every layout exposes it;
  // when it's missing we keep whatever we already had for this chapter.
  const disp = location.start.displayed;
  const rawPct =
    disp && disp.total ? Math.min(100, Math.max(0, Math.round((disp.page / disp.total) * 100))) : null;

  // Fold this position into the per-chapter map. pct only ever rises; the stored
  // cfi tracks the furthest point (so the per-chapter resume lands where you got
  // to, not where you scrolled back to); done is sticky once the end is reached.
  const chapters = { ...(prev?.chapters || {}) };
  if (href) {
    // Baseline the position each time a fresh chapter appears, then require the
    // reader to have moved MIN_SCROLL_PCT past it before crediting anything — so
    // merely opening a chapter (or a short, one-screen one) never self-completes
    // and never arms the resume chip. A chapter already in progress keeps
    // updating regardless.
    if (chapterEntryBaseline.href !== href) chapterEntryBaseline = { href, pct: rawPct ?? 0 };
    const scrolled = rawPct == null ? 0 : rawPct - chapterEntryBaseline.pct;
    const cur = chapters[href];
    const started = (cur && (cur.pct || 0) > 0) || scrolled >= MIN_SCROLL_PCT;
    if (started) {
      const base = cur || { pct: 0, cfi: null, done: false };
      const pct = rawPct == null ? base.pct || 0 : Math.max(base.pct || 0, rawPct);
      const advanced = rawPct != null && rawPct >= (base.pct || 0);
      const done = base.done || (pct >= CHAPTER_DONE_PCT && scrolled >= MIN_SCROLL_PCT);
      chapters[href] = {
        pct,
        cfi: advanced && location.start.cfi ? location.start.cfi : base.cfi || location.start.cfi || null,
        // Keep scrollTop paired with the cfi it was captured at: refresh both
        // when advancing, keep both when scrolled back.
        scrollTop: advanced ? scrollTop : base.scrollTop ?? scrollTop,
        done,
      };
      // Chapter skipping: finishing a chapter completes every earlier one too.
      if (done && !base.done) markEarlierDone(lib, href, chapters);
    }
  }

  // A book is finished once every readable chapter is done; the flag is sticky.
  const total = chapterCount(lib);
  const readableHrefs = readableChapters(lib.chapters || []).map((e) => baseHref(e.href));
  const nDone = readableHrefs.filter((h) => chapters[h]?.done).length;
  const finished = prev?.finished || (total > 0 && nDone >= total);

  const rec = {
    bookId: lib.id,
    cfi: location.start.cfi || null, // book-level resume: where you are right now
    scrollTop, // exact in-chapter offset, paired with cfi (see above)
    chapterIndex: idx,
    chapterLabel: chapterLabelFor(href) || prev?.chapterLabel || "",
    chapters,
    finished,
    updatedAt: Date.now(),
  };
  putProgress(rec);
  ui.lastReadBookId = lib.id;
  saveUi();
  return rec;
}

// Flush the reading position when the app is backgrounded (phone lock or
// app-switch). The scroll-driven `relocated` save is throttled, so without this
// a spot reached moments before locking could be lost. `currentLocation()`
// recomputes from the live DOM, giving a fresher position than the last event.
// Pure save — it never moves the view.
export function flushReadingPosition() {
  if (!rendition || document.getElementById("app").dataset.route !== "reader") return;
  try {
    let loc = rendition.currentLocation();
    if (loc && typeof loc.then === "function") loc = null; // async manager; skip
    if (!loc?.start) loc = rendition.location; // fall back to last known
    if (loc?.start) {
      // Mirror the freshest record to localStorage synchronously so it survives
      // an OS suspend that could drop the async IndexedDB write (see above).
      const rec = saveReadingLocation(loc);
      if (rec) stashPendingProgress(rec);
    }
  } catch (err) {
    console.warn("Position flush failed:", err);
  }
}

export async function openBook(id, { withDrawer = false, startHref = null } = {}) {
  const lib = bookById(id);
  if (!lib) return;
  currentBook = lib;
  go({ route: "reader", id }, true);
  await renderReader(lib, startHref);
  if (withDrawer) openDrawer();
}

export async function renderReader(lib, startHref = null) {
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  el.viewer.innerHTML = "";
  currentHref = null;
  // Fresh book: forget any resume-chip dismissals and clear a stale chip.
  resumeDismissed = new Set();
  hideResumeChip();
  restoreActive = false; // never carry a settling-restore flag across books
  chapterEntryBaseline = { href: null, pct: 0 };
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
  // Critical dark background as a rules theme so it's applied the instant the
  // view is created; the full reading theme is injected inline per chapter by
  // injectReaderTheme (content hook, before the view is shown) so there is no
  // per-chapter fetch — no flash, and it works fully offline.
  rendition.themes.default({ "html, body": { background: "#1f2129 !important" } });
  rendition.hooks.content.register(injectReaderTheme);
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
  // A chapter tapped in the list/drawer opens at its top and offers the
  // per-chapter resume chip; the book-level "Continue" restores the exact CFI.
  if (startHref) {
    displayChapterTop(startHref);
  } else {
    const shown = rendition.display(resume || flatToc[0]?.href || undefined);
    // Only refine when we actually restored the book-level CFI (not a fallback
    // to a chapter href or chapter 1) and have a saved offset for it.
    if (resume && resume === p?.cfi && p?.scrollTop > 0) restoreScrollAfter(shown, p.scrollTop);
  }

  // Refine the chapter list once the live navigation resolves (accurate hrefs).
  book.loaded.navigation.then((nav) => {
    flatToc = readableChapters(flatten(nav.toc));
    renderToc();
    updateChapterTitle(currentHref);
  });

  rendition.on("relocated", (location) => {
    currentHref = location?.start?.href || null;
    // A move to a different chapter retires a resume chip meant for the old one.
    if (resumeChipHref && baseHref(currentHref) !== resumeChipHref) hideResumeChip();
    // Re-render the drawer list so read-state and the highlight track the move.
    renderToc();
    updateChapterTitle(currentHref);
    // While a resume is still settling, don't persist the transient positions
    // epub.js reports on the way to the saved spot — they would overwrite the
    // good position with a half-restored one. restoreScrollAfter persists the
    // final landing itself once the layout stops moving.
    if (!restoreActive) saveReadingLocation(location);
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
// to the current chapter on open via highlightToc. Completed chapters are dimmed
// with a check; a chapter opened partway shows its % ; the chapter you're on
// keeps its highlight (via highlightToc). Read-state comes from the per-chapter
// map, so jumping back never un-checks a chapter and opening one never completes
// it. For a book inside a series the rows carry absolute numbers, so "Ch. 351"
// in vol. 2 stays "Ch. 351".
function renderToc() {
  el.tocList.innerHTML = "";
  const total = flatToc.length;
  if (!total) return;
  const inSeries = !!(currentBook?.seriesId && seriesById(currentBook.seriesId));
  const offset = inSeries ? volumeChapterOffset(currentBook) : 0;
  for (let i = 0; i < total; i++) {
    const entry = flatToc[i];
    const text = entry.label || "Untitled";
    const label = inSeries ? `${offset + i + 1} · ${text}` : text;
    const st = chapterProgress(currentBook, entry.href);
    const read = !!st?.done;
    const reading = !read && (st?.pct || 0) > 0;
    const cls =
      "toc-item" +
      (entry.depth ? " depth-" + Math.min(entry.depth, 2) : "") +
      (read ? " toc-item--read" : reading ? " toc-item--reading" : "");
    const btn = h(
      "button",
      { dataset: { href: entry.href }, class: cls },
      h("span", { class: "toc-item__label" }, label),
      read
        ? h("span", { class: "toc-item__check" }, svg(ICON.check))
        : reading
        ? h("span", { class: "toc-item__pct" }, `${st.pct} %`)
        : null
    );
    btn.addEventListener("click", () => {
      displayChapterTop(entry.href);
      closeDrawer();
    });
    el.tocList.append(h("li", null, btn));
  }
  highlightToc(currentHref);
}
// How many chapters of already-read context to keep above the current one when
// the drawer settles, so the current chapter always lands near the top with a
// short lead-in — the same framing whether you resumed at your furthest point
// or jumped back into an earlier chapter.
const TOC_LEAD = 2;
function highlightToc(href) {
  const current = baseHref(href);
  let match = null;
  el.tocList.querySelectorAll("button").forEach((btn) => {
    const is = baseHref(btn.dataset.href) === current;
    btn.classList.toggle("current", is);
    if (is) match = btn;
  });
  if (!match) return;
  // Top-align the row TOC_LEAD chapters before the current one. Using the
  // rect delta (rather than offsetTop) keeps this correct even while the drawer
  // is still translated off-screen, and regardless of the offset parent.
  const rows = [...el.tocList.children];
  const li = match.closest("li");
  const anchor = rows[Math.max(0, rows.indexOf(li) - TOC_LEAD)] || li;
  el.tocList.scrollTop += anchor.getBoundingClientRect().top - el.tocList.getBoundingClientRect().top;
}
function chapterLabelFor(href) {
  const current = baseHref(href);
  for (const e of flatToc) if (baseHref(e.href) === current) return e.label || "";
  return null;
}
// The reader's index in the readable TOC, from the live reading position.
function currentTocIndex() {
  const cur = baseHref(currentHref);
  return cur ? flatToc.findIndex((e) => baseHref(e.href) === cur) : -1;
}
// Move one chapter back/forward and open it at its top. In scrolled-doc flow
// rendition.prev() lands at the *end* of the previous section, so stepping by
// TOC href instead keeps "previous" and "next" symmetric — both start you at
// the beginning of the target chapter.
export function goChapter(delta) {
  if (!rendition || !flatToc.length) return;
  const i = currentTocIndex();
  const target = flatToc[(i < 0 ? 0 : i) + delta];
  if (target) displayChapterTop(target.href);
}
// Open a chapter at its top (a deliberate jump from the drawer, the chapter
// list, or the arrows), then — if that chapter was left part-read — offer the
// per-chapter resume chip. The book-level "Continue" resume is separate: it
// restores the exact CFI directly, so it never routes through here.
function displayChapterTop(href) {
  if (!rendition || !href) return;
  const p = rendition.display(baseHref(href));
  Promise.resolve(p).then(() => maybeShowResumeChip(href)).catch(() => {});
}
// Show the per-chapter resume chip if this chapter was left partway (has a saved
// position short of the end) and the reader hasn't dismissed it this session.
function maybeShowResumeChip(href) {
  const key = baseHref(href);
  const st = chapterProgress(currentBook, key);
  if (!st || st.done || !st.cfi || !(st.pct > 0) || st.pct >= CHAPTER_DONE_PCT || resumeDismissed.has(key)) {
    hideResumeChip();
    return;
  }
  hideResumeChip();
  resumeChipHref = key;
  const goBtn = h(
    "button",
    {
      class: "resume-chip__go",
      onclick: () => {
        if (rendition && st.cfi) {
          const shown = rendition.display(st.cfi);
          if (st.scrollTop > 0) restoreScrollAfter(shown, st.scrollTop);
        }
        hideResumeChip();
      },
    },
    h("span", { class: "resume-chip__label" }, "Resume where you left off"),
    h("span", { class: "resume-chip__pct" }, `· ${st.pct} %`)
  );
  const dismiss = h(
    "button",
    {
      class: "resume-chip__x",
      "aria-label": "Dismiss",
      onclick: () => {
        resumeDismissed.add(key);
        hideResumeChip();
      },
    },
    "×"
  );
  resumeChipEl = h("div", { class: "resume-chip" }, goBtn, dismiss);
  document.getElementById("app").appendChild(resumeChipEl);
  requestAnimationFrame(() => resumeChipEl && resumeChipEl.classList.add("resume-chip--in"));
}
function hideResumeChip() {
  if (resumeChipEl) resumeChipEl.remove();
  resumeChipEl = null;
  resumeChipHref = null;
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
// Inject the reading theme as an inline <style> into each chapter document.
// Runs on the content hook, which fires after the chapter is written but before
// the view is displayed/shown, so the text paints already styled (no flash) and
// with no network dependency (works offline).
// The theme CSS references fonts as `url("/fonts/...")`. That string is injected
// into the epub iframe, whose base URL is the book's internal document — so a
// relative or root-absolute path won't resolve to our site (root-absolute also
// drops the GitHub Pages project subpath). Rewrite `/fonts/` to a fully-
// qualified URL derived from this module's own location (`../fonts/` relative to
// /assets/*.js in prod, /fonts/ in dev), which is stable across SPA route
// changes. The SW precaches the woff2, so this works offline too. Computed once.
const READER_FONT_DIR = new URL("../fonts/", import.meta.url).href;
const RESOLVED_READER_THEME_CSS = readerThemeCss.replaceAll(
  'url("/fonts/',
  `url("${READER_FONT_DIR}`
);

function injectReaderTheme(contents) {
  const doc = contents?.document;
  if (!doc || doc.getElementById("webnovel-theme")) return;
  const style = doc.createElement("style");
  style.id = "webnovel-theme";
  style.textContent = RESOLVED_READER_THEME_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function injectChapterNav(contents) {
  const doc = contents.document;
  if (!doc?.body || doc.querySelector(".chapter-end")) return;
  const total = book?.spine?.spineItems?.length || 0;
  const idx = typeof contents.sectionIndex === "number" ? contents.sectionIndex : -1;
  const atEnd = total > 0 && idx >= total - 1;

  // Locate this chapter in the readable TOC so we can name/number the *next*
  // one. Content-hook time: currentHref still points at the outgoing chapter,
  // so resolve from this document's own spine section rather than currentHref.
  const offset = currentBook ? volumeChapterOffset(currentBook) : 0;
  const thisHref = book?.spine?.get?.(idx)?.href || null;
  const tocIdx = thisHref ? flatToc.findIndex((e) => baseHref(e.href) === baseHref(thisHref)) : -1;
  const nextEntry = tocIdx >= 0 ? flatToc[tocIdx + 1] || null : null;
  // Prefer the chapter's own embedded number (matches the top bar) over the
  // positional ordinal, which drifts when the book has front matter.
  const curParsed = tocIdx >= 0 ? parseChapterLabel(flatToc[tocIdx]?.label) : { num: null, title: "" };
  const curNum = curParsed.num ?? (tocIdx >= 0 ? tocIdx + 1 + offset : null);
  const nextParsed = nextEntry ? parseChapterLabel(nextEntry.label) : { num: null, title: "" };
  const nextNum = nextEntry ? (nextParsed.num ?? tocIdx + 2 + offset) : null;
  // The last chapter of this book/volume — no in-book "next".
  const lastChapter = atEnd || !nextEntry;

  const inSeries = currentBook?.seriesId && seriesById(currentBook.seriesId);

  const wrap = doc.createElement("div");
  wrap.className = "chapter-end";

  const label = doc.createElement("div");
  label.className = "chapter-end__label";
  const labelText = doc.createElement("span");
  labelText.className = "chapter-end__label-text";
  labelText.textContent = lastChapter
    ? (inSeries ? "End of Vol. " + volumeNumber(seriesById(currentBook.seriesId), currentBook) : "End of book")
    : "End of chapter" + (curNum ? " " + curNum : "");
  label.appendChild(labelText);
  wrap.appendChild(label);

  if (lastChapter && inSeries) {
    // Volume boundary card — continue into the next volume of the series.
    const next = currentBook ? nextVolume(currentBook) : null;
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
  } else if (!lastChapter) {
    // Clean single next-chapter card: a quiet kicker over the next chapter's
    // number + title, with a chevron. (Previous is intentionally omitted — the
    // top bar already carries chapter-back navigation.)
    const card = doc.createElement("button");
    card.className = "cn-card";
    card.setAttribute("aria-label", "Next chapter" + (nextNum != null ? " " + nextNum : "") + (nextParsed.title ? ", " + nextParsed.title : ""));
    card.addEventListener("click", () => displayChapterTop(nextEntry.href));

    // Left column: kicker over the number + title. The chevron is a sibling of
    // this column so the card can centre it across the full card height.
    const body = doc.createElement("div");
    body.className = "cn-card__body";

    const kicker = doc.createElement("div");
    kicker.className = "cn-card__kicker";
    kicker.textContent = "Next chapter";

    const main = doc.createElement("div");
    main.className = "cn-card__main";
    if (nextNum != null) {
      const num = doc.createElement("span");
      num.className = "cn-card__num";
      num.textContent = String(nextNum);
      main.appendChild(num);
    }
    // Use the parsed title so a "Chapter N:" prefix isn't repeated next to the
    // number; fall back to the raw label only for bare-title books (no embedded
    // number). A numbered-but-titleless chapter shows just its number.
    const titleText = nextParsed.title || (nextParsed.num == null ? (nextEntry.label || "").trim() : "");
    if (titleText) {
      const title = doc.createElement("span");
      title.className = "cn-card__title";
      title.textContent = titleText;
      main.appendChild(title);
    }
    body.appendChild(kicker);
    body.appendChild(main);

    const chev = doc.createElement("span");
    chev.className = "cn-card__chev";
    chev.textContent = "›";

    card.appendChild(body);
    card.appendChild(chev);
    wrap.appendChild(card);
  }
  // else: last chapter of a standalone book — just the "End of book" label.

  doc.body.appendChild(wrap);
}

// -------------------------------------------------------------------------
// Drawer
// -------------------------------------------------------------------------
export function openDrawer() {
  el.drawer.classList.add("open");
  el.scrim.hidden = false;
  requestAnimationFrame(() => el.scrim.classList.add("show"));
}
export function closeDrawer() {
  if (!el.drawer.classList.contains("open")) return; // idempotent
  el.drawer.classList.remove("open");
  el.scrim.classList.remove("show");
  const onEnd = () => {
    el.scrim.hidden = true;
    el.scrim.removeEventListener("transitionend", onEnd);
  };
  el.scrim.addEventListener("transitionend", onEnd);
}
