// =========================================================================
// CHAPTERS screen (design 8a) — a pushed, searchable list of every chapter in
// a book or a whole series. Three entry points (info page, volume sheet, reader
// drawer) all land here; it opens scrolled to the chapter you are on. Search,
// sort and volume filter are screen-local; the sort direction persists per book.
//
// The model builder (chaptersModel) and the five-row preview component
// (chapterPreview) are also used by the info page and volume sheet, so they are
// exported from here.
// =========================================================================
import { el, h, svg, ICON } from "./dom.js";
import { progressMap, ui, bookById, seriesById, saveUi } from "./state.js";
import { readableChapters, chapterOrdinalFor, scrollAnchorFor, previewWindow } from "./lib/chapters.js";
import {
  chapterProgress, bookPercent, seriesVolumes, currentVolume, volumeChapterOffset,
  volumeNumber, displayTitle,
} from "./reading.js";
import { openBook } from "./reader.js";
import { go } from "./router.js";

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
// series, tagging each row by its per-chapter state: `read` (completed),
// `current` (the resume chapter — where "Continue" drops you), `reading` (a
// chapter opened partway but not finished, and not the resume point) or
// `unread`. Completion comes from the per-chapter map, so jumping back never
// un-reads a chapter and opening one never completes it.
function chapterRowState({ vol, e, i, curLocal, isCurVol, finished }) {
  const st = chapterProgress(vol, e.href);
  const pct = st?.pct || 0;
  let state;
  if (finished || st?.done) state = "read";
  else if (isCurVol && i === curLocal) state = "current";
  else if (pct > 0) state = "reading";
  else state = "unread";
  return { state, pct };
}
export function chaptersModel(kind, id) {
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
      const isCurVol = !!(cur && vol.id === cur.id);
      chs.forEach((e, i) => {
        const { state, pct } = chapterRowState({ vol, e, i, curLocal, isCurVol, finished });
        items.push({ absNum: offset + i + 1, label: e.label, href: e.href, bookId: vol.id, localIndex: i, state, pct });
      });
    }
    const curItem = items.find((it) => it.state === "current");
    return {
      kind, id, series: s, vols, book: null, title: s.name, items,
      currentAbs: curItem ? curItem.absNum : null,
      currentPercent: curItem ? curItem.pct : undefined,
      // Where the Chapters screen pre-scrolls: the current (resume) chapter when
      // one exists, otherwise the last-read chapter — so a finished book still
      // lands on where you left off, not back at chapter 1.
      scrollAnchorAbs: scrollAnchorFor(items, curItem, cur?.id, curLocal),
    };
  }
  const b = bookById(id);
  if (!b) return null;
  const chs = readableChapters(b.chapters || []);
  const p = progressMap[b.id];
  const finished = bookPercent(b) >= 100;
  const curLocal = p ? chapterOrdinalFor(b, p) - 1 : -1;
  const items = chs.map((e, i) => {
    const { state, pct } = chapterRowState({ vol: b, e, i, curLocal, isCurVol: true, finished });
    return { absNum: i + 1, label: e.label, href: e.href, bookId: b.id, localIndex: i, state, pct };
  });
  const curItem = items.find((it) => it.state === "current");
  return {
    kind, id, series: null, vols: null, book: b, title: displayTitle(b), items,
    currentAbs: curItem ? curItem.absNum : null,
    currentPercent: curItem ? curItem.pct : undefined,
    scrollAnchorAbs: scrollAnchorFor(items, curItem, b.id, curLocal),
  };
}

// Push the Chapters screen. `volId` presets the volume filter (from a volume
// sheet or a series' current volume); null shows the whole story.
export function openChapters(kind, id, { volId = null } = {}) {
  go({ route: "chapters", kind, id, volId });
}

// -------------------------------------------------------------------------
// Chapter preview (designs 11b / 11a) — the five-row list that ends every info
// page and every volume sheet. It reuses chaptersModel's read/current/unread
// tagging and absolute numbering; its "See all N chapters" row is the primary
// route into the full Chapters screen (2e), so the common case (resume, or step
// one chapter) never has to open it.
// -------------------------------------------------------------------------

function cprevRow(it) {
  // The resume chapter reopens the book where you left off; every other row
  // opens that chapter (an in-progress one offers its own resume once inside).
  const open = () => (it.state === "current" ? openBook(it.bookId) : openBook(it.bookId, { startHref: it.href }));
  if (it.state === "current" || it.state === "reading") {
    return h(
      "button",
      { class: "cprev__row cprev__row--" + it.state, onclick: open },
      h("span", { class: "cprev__num" }, String(it.absNum)),
      h(
        "span",
        { class: "cprev__titlewrap" },
        h("div", { class: "cprev__title" }, it.label || "Untitled"),
        h("div", { class: "cprev__sub" }, it.pct ? `Reading · ${it.pct} % through` : "Reading")
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
export function chapterPreview(items, { scoped = false, onSeeAll, anchorAbs = null } = {}) {
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
  for (const it of previewWindow(items, anchorAbs)) rows.append(cprevRow(it));
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
export function previewItemsFor(m) {
  if (m.kind === "series") {
    const vol = m.currentVolume;
    if (!vol) return { items: [], volId: null, anchorAbs: null };
    const model = chaptersModel("series", m.id);
    return {
      items: model ? model.items.filter((it) => it.bookId === vol.id) : [],
      volId: vol.id,
      anchorAbs: model ? model.scrollAnchorAbs : null,
    };
  }
  const model = chaptersModel("book", m.id);
  return { items: model ? model.items : [], volId: null, anchorAbs: model ? model.scrollAnchorAbs : null };
}

// "Shadow Slave · vol. 2" — the book, then the active volume filter.
function chContextLine(m) {
  if (m.kind === "series" && chVolFilter) {
    const v = m.vols.find((x) => x.id === chVolFilter);
    return m.title + (v ? " · vol. " + volumeNumber(m.series, v) : "");
  }
  return m.title;
}

export function renderChapters(kind, id, volId) {
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
  const ds = {};
  if (it.state === "current") ds.current = "1";
  if (it.absNum === m.scrollAnchorAbs) ds.anchor = "1"; // pre-scroll target
  if (it.state === "current" || it.state === "reading") {
    return h(
      "button",
      { class: cls, dataset: ds, onclick: () => chOpen(it) },
      h("span", { class: "ch-row__num" }, String(it.absNum)),
      h(
        "span",
        { class: "ch-row__title-wrap" },
        h("div", { class: "ch-row__title" }, it.label || "Untitled"),
        h("div", { class: "ch-row__sub" }, it.pct ? `Reading · ${it.pct} % through` : "Reading")
      )
    );
  }
  return h(
    "button",
    { class: cls, dataset: ds, onclick: () => chOpen(it) },
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
  const cur = chEls?.list.querySelector("[data-anchor]") || chEls?.list.querySelector("[data-current]");
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

export function teardownChapters() {
  if (chBackObserver) {
    chBackObserver.disconnect();
    chBackObserver = null;
  }
  chEls = null;
  chQuery = "";
  chVolFilter = null;
}
